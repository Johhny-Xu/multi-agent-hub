#!/usr/bin/env python3
"""In-process fake of the OMB Muse Relay data plane.

It implements just enough of schemaVersion 1 to exercise the client:
bearer auth, long poll (inline or inputMode=ref), sliced /input, lease
heartbeat, ordered text/file events, duplicate detection, cancellations,
scripted 429/5xx, corrupted slices and dropped responses. It is a
test fixture; it never talks to a real OMB.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import socket
import threading
import time
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

SCHEMA_VERSION = 1
INPUT_SLICE_MAX = 4096


def input_bytes(source: dict) -> bytes:
    """The fake's serialization of a turn input; any stable one works, the client only checks size and hash."""
    return json.dumps(source, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _iso(epoch: float) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(epoch, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class Reply:
    status: int = 200
    body: dict | None = None
    headers: dict = field(default_factory=dict)
    drop: bool = False
    raw: bytes | None = None


class FakeOMB:
    def __init__(
        self,
        token: str,
        connection_id: str = "conn-test",
        lease_seconds: int = 120,
        poll_hold_seconds: float = 0.2,
        port: int = 0,
        file_chunk_delay: float = 0.0,
        file_chunk_bytes: int = 4096,
    ):
        self.token = token
        self.connection_id = connection_id
        self.lease_seconds = lease_seconds
        self.poll_hold_seconds = poll_hold_seconds
        # Upload bodies arrive slowly when this is set, so a test can outlive a short lease while a
        # concurrent poll looks for work; each chunk renews the lease exactly as the real server does.
        self.file_chunk_delay = file_chunk_delay
        self.file_chunk_bytes = file_chunk_bytes
        self.upload_renewals = 0
        self.prefix = f"/hooks/muse-relay/v1/{connection_id}"
        self.lock = threading.RLock()
        self.cond = threading.Condition(self.lock)
        self.turns: dict[str, dict] = {}
        self.queue: list[str] = []
        self.pending_cancellations: list[str] = []
        self.requests: list[dict] = []
        self.poll_faults: list[dict] = []
        self.poll_bodies: list[dict | None] = []
        self.event_faults: list[dict] = []
        self.file_faults: list[dict] = []
        self.heartbeat_faults: list[dict] = []
        self.input_faults: list[dict] = []
        self.input_corrupt = 0
        self.input_drops = 0
        self.response_sizes: list[tuple[str, int]] = []
        self.event_drops = 0
        self.file_drops = 0
        self.poll_drops = 0
        self.stopping = False
        self._counter = 0
        self._httpd = ThreadingHTTPServer(("127.0.0.1", port), _make_handler(self))
        self._httpd.daemon_threads = True
        self._httpd.block_on_close = False
        self._httpd.fake = self
        self._thread = threading.Thread(target=self._httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self._httpd.server_address[:2]
        return f"http://{host}:{port}"

    def start(self):
        self._thread.start()
        return self

    def close(self):
        with self.cond:
            self.stopping = True
            self.cond.notify_all()
        self._httpd.shutdown()
        self._httpd.server_close()

    def __enter__(self):
        return self.start()

    def __exit__(self, *_exc):
        self.close()

    def add_turn(
        self,
        turn_id: str | None = None,
        text: str = "hello",
        thread_id: str = "thread-1",
        system: str = "you are a test assistant",
        transcript: list | None = None,
    ) -> str:
        with self.cond:
            if turn_id is None:
                self._counter += 1
                turn_id = f"turn-{self._counter}"
            self.turns[turn_id] = {
                "turnId": turn_id,
                "input": {
                    "threadId": thread_id,
                    "text": text,
                    "system": system,
                    "transcript": transcript or [],
                },
                "createdAt": time.time(),
                "attempt": 0,
                "deliveryId": None,
                "leaseUntil": 0.0,
                "nextSeq": 1,
                "events": {},
                "files": {},
                "cancelled": False,
                "terminal": None,
                "terminalEvent": None,
            }
            self.queue.append(turn_id)
            self.cond.notify_all()
            return turn_id

    def queue_turn(self, turn_id: str) -> None:
        with self.cond:
            if turn_id not in self.queue:
                self.queue.append(turn_id)
            self.cond.notify_all()

    def rotate_delivery(self, turn_id: str) -> str:
        with self.lock:
            turn = self.turns[turn_id]
            turn["attempt"] += 1
            turn["deliveryId"] = "del-" + uuid.uuid4().hex[:16]
            turn["leaseUntil"] = time.time() + self.lease_seconds
            return turn["deliveryId"]

    def cancel_turn(self, turn_id: str) -> None:
        with self.cond:
            self.turns[turn_id]["cancelled"] = True
            if turn_id not in self.pending_cancellations:
                self.pending_cancellations.append(turn_id)
            self.cond.notify_all()

    def script_poll(self, status: int, headers: dict | None = None, count: int = 1) -> None:
        with self.lock:
            self.poll_faults.extend({"status": status, "headers": headers or {}} for _ in range(count))

    def script_poll_body(self, body: dict | None, count: int = 1) -> None:
        with self.lock:
            self.poll_bodies.extend([body] * count)

    def script_events(self, status: int, headers: dict | None = None, count: int = 1, skip: int = 0) -> None:
        """Fails the next `count` event posts; with `skip`, the first `skip` posts go through first."""
        with self.lock:
            faults = [{"status": status, "headers": headers or {}} for _ in range(count)]
            if faults:
                faults[0]["skip"] = skip
            self.event_faults.extend(faults)

    def script_files(self, status: int, headers: dict | None = None, count: int = 1) -> None:
        with self.lock:
            self.file_faults.extend({"status": status, "headers": headers or {}} for _ in range(count))

    def script_heartbeat(self, status: int, headers: dict | None = None, count: int = 1) -> None:
        with self.lock:
            self.heartbeat_faults.extend({"status": status, "headers": headers or {}} for _ in range(count))

    def script_input(self, status: int, headers: dict | None = None, count: int = 1) -> None:
        with self.lock:
            self.input_faults.extend({"status": status, "headers": headers or {}} for _ in range(count))

    def max_response(self, endpoint: str | None = None) -> int:
        with self.lock:
            sizes = [size for name, size in self.response_sizes if endpoint is None or name == endpoint]
            return max(sizes) if sizes else 0

    def requests_snapshot(self) -> list[dict]:
        with self.lock:
            return [dict(item) for item in self.requests]

    def request_count(self, endpoint: str | None = None) -> int:
        with self.lock:
            if endpoint is None:
                return len(self.requests)
            return sum(1 for item in self.requests if item["endpoint"] == endpoint)

    def event_types(self, turn_id: str) -> list[str]:
        with self.lock:
            turn = self.turns[turn_id]
            items = [(item["seq"], item["type"]) for item in turn["events"].values()]
            items += [(item["seq"], "file") for item in turn["files"].values()]
            return [kind for _seq, kind in sorted(items)]

    def file_bytes(self, turn_id: str, event_id: str) -> bytes:
        with self.lock:
            return self.turns[turn_id]["files"][event_id]["bytes"]

    def _record(self, endpoint: str, path: str, query: str, headers, body: bytes, extra: dict) -> None:
        auth = headers.get("Authorization") or ""
        record = {
            "endpoint": endpoint,
            "path": path,
            "query": query,
            "auth_ok": auth == f"Bearer {self.token}",
            "body_len": len(body),
            "body_sha256": hashlib.sha256(body).hexdigest(),
        }
        record.update(extra)
        with self.lock:
            self.requests.append(record)

    def handle_post(self, path: str, query: str, headers, body: bytes, fault: str | None = None) -> Reply:
        parsed = urlsplit(path)
        clean_path = parsed.path
        if not clean_path.startswith(self.prefix + "/"):
            self._record("unknown", clean_path, query, headers, body, {})
            return Reply(404, {"error": "not_found"})
        sub = clean_path[len(self.prefix) :]
        auth = headers.get("Authorization") or ""
        if auth != f"Bearer {self.token}":
            self._record("auth", clean_path, query, headers, body, {})
            return Reply(401, {"error": "unauthorized"})

        if sub == "/poll":
            return self._poll(query, headers, body)
        if sub == "/heartbeat":
            return self._heartbeat(headers, body)
        if sub.startswith("/turns/") and sub.endswith("/events"):
            turn_id = sub[len("/turns/") : -len("/events")]
            return self._events(turn_id, headers, body)
        if sub.startswith("/turns/") and sub.endswith("/input"):
            turn_id = sub[len("/turns/") : -len("/input")]
            return self._input(turn_id, headers, body)
        if sub.startswith("/turns/") and sub.endswith("/files"):
            turn_id = sub[len("/turns/") : -len("/files")]
            return self._files(turn_id, query, headers, body, fault)
        self._record("unknown", clean_path, query, headers, body, {})
        return Reply(404, {"error": "not_found"})

    def _poll(self, query: str, headers, body: bytes) -> Reply:
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._record("poll", self.prefix + "/poll", query, headers, body, {"invalid": True})
            return Reply(400, {"error": "bad_request"})
        wait_ms = payload.get("waitMs", 0)
        limit = payload.get("limit", 1)
        if not isinstance(wait_ms, int) or not (0 <= wait_ms <= 25000):
            return Reply(400, {"error": "bad_request"})
        if not isinstance(limit, int) or not (1 <= limit <= 4):
            return Reply(400, {"error": "bad_request"})
        input_mode = payload.get("inputMode", "inline")
        if input_mode not in ("inline", "ref"):
            return Reply(400, {"error": "bad_request"})
        self._record(
            "poll",
            self.prefix + "/poll",
            query,
            headers,
            body,
            {"wait_ms": wait_ms, "limit": limit, "input_mode": input_mode},
        )
        with self.cond:
            if self.poll_faults:
                fault = self.poll_faults.pop(0)
                return Reply(fault["status"], {"error": "scripted"}, dict(fault["headers"]))
            if self.poll_drops:
                self.poll_drops -= 1
                return Reply(drop=True)
            if self.poll_bodies:
                return Reply(200, self.poll_bodies.pop(0))
            deadline = time.time() + min(wait_ms / 1000.0, self.poll_hold_seconds)
            while not self.queue and not self.pending_cancellations and time.time() < deadline:
                if self.stopping:
                    break
                self.cond.wait(min(0.05, max(0.0, deadline - time.time())))
            deliveries = []
            for _ in range(min(limit, len(self.queue))):
                turn_id = self.queue.pop(0)
                deliveries.append(self._issue(turn_id, input_mode == "ref"))
            cancellations = list(self.pending_cancellations)
            self.pending_cancellations.clear()
        return Reply(
            200,
            {
                "schemaVersion": SCHEMA_VERSION,
                "deliveries": deliveries,
                "cancellations": cancellations,
                "serverTime": _iso(time.time()),
            },
        )

    def _issue(self, turn_id: str, by_ref: bool = False) -> dict:
        turn = self.turns[turn_id]
        turn["attempt"] += 1
        turn["deliveryId"] = "del-" + uuid.uuid4().hex[:16]
        turn["leaseUntil"] = time.time() + self.lease_seconds
        delivery = {
            "turnId": turn_id,
            "deliveryId": turn["deliveryId"],
            "attempt": turn["attempt"],
            "leaseUntil": _iso(turn["leaseUntil"]),
            "createdAt": _iso(turn["createdAt"]),
        }
        if by_ref:
            raw = input_bytes(turn["input"])
            delivery["inputBytes"] = len(raw)
            delivery["inputSha256"] = hashlib.sha256(raw).hexdigest()
        else:
            delivery["input"] = dict(turn["input"])
        return delivery

    def _input(self, turn_id: str, headers, body: bytes) -> Reply:
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._record("input", self.prefix + f"/turns/{turn_id}/input", "", headers, body, {"invalid": True})
            return Reply(400, {"error": "bad_request"})
        offset = payload.get("offset")
        length = payload.get("length")
        self._record(
            "input",
            self.prefix + f"/turns/{turn_id}/input",
            "",
            headers,
            body,
            {"turn_id": turn_id, "delivery_id": payload.get("deliveryId"), "offset": offset, "length": length},
        )
        with self.lock:
            if self.input_faults:
                fault = self.input_faults.pop(0)
                return Reply(fault["status"], {"error": "scripted"}, dict(fault["headers"]))
            if self.input_drops:
                self.input_drops -= 1
                return Reply(drop=True)
            if not isinstance(offset, int) or offset < 0 or not isinstance(length, int) or not (1 <= length <= INPUT_SLICE_MAX):
                return Reply(400, {"error": "bad_request"})
            turn = self.turns.get(turn_id)
            if not turn:
                return Reply(404, {"error": "unknown_turn"})
            if turn["cancelled"] or turn["terminal"]:
                return Reply(409, {"error": "finished"})
            if turn["deliveryId"] != payload.get("deliveryId") or turn["leaseUntil"] <= time.time():
                return Reply(409, {"error": "stale_delivery"})
            raw = input_bytes(turn["input"])
            if offset > len(raw):
                return Reply(400, {"error": "bad_request"})
            chunk = raw[offset : offset + length]
            if self.input_corrupt:
                self.input_corrupt -= 1
                chunk = bytes(b ^ 0x01 for b in chunk)
            return Reply(
                200,
                {
                    "schemaVersion": SCHEMA_VERSION,
                    "offset": offset,
                    "total": len(raw),
                    "data": base64.b64encode(chunk).decode("ascii"),
                },
            )

    def _heartbeat(self, headers, body: bytes) -> Reply:
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._record("heartbeat", self.prefix + "/heartbeat", "", headers, body, {"invalid": True})
            return Reply(400, {"error": "bad_request"})
        self._record(
            "heartbeat",
            self.prefix + "/heartbeat",
            "",
            headers,
            body,
            {"turn_id": payload.get("turnId"), "delivery_id": payload.get("deliveryId")},
        )
        with self.lock:
            if self.heartbeat_faults:
                fault = self.heartbeat_faults.pop(0)
                return Reply(fault["status"], {"error": "scripted"}, dict(fault["headers"]))
            turn_id = payload.get("turnId")
            if not turn_id:
                return Reply(200, {"schemaVersion": SCHEMA_VERSION, "ok": True, "leaseUntil": None, "cancelled": False})
            turn = self.turns.get(turn_id)
            if not turn:
                return Reply(404, {"error": "unknown_turn"})
            # Same order as the real server: a cancelled turn answers cancelled to whoever beats,
            # a finished one answers 409 (which is why a finished retry must never beat first).
            if turn["cancelled"]:
                return Reply(200, {"schemaVersion": SCHEMA_VERSION, "ok": True, "leaseUntil": None, "cancelled": True})
            if turn["terminal"]:
                return Reply(409, {"error": "finished"})
            if turn["deliveryId"] != payload.get("deliveryId"):
                return Reply(409, {"error": "stale_delivery"})
            turn["leaseUntil"] = time.time() + self.lease_seconds
            return Reply(
                200,
                {
                    "schemaVersion": SCHEMA_VERSION,
                    "ok": True,
                    "leaseUntil": _iso(turn["leaseUntil"]),
                    "cancelled": False,
                },
            )

    def _events(self, turn_id: str, headers, body: bytes) -> Reply:
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._record("events", self.prefix + f"/turns/{turn_id}/events", "", headers, body, {"invalid": True})
            return Reply(400, {"error": "bad_request"})
        self._record(
            "events",
            self.prefix + f"/turns/{turn_id}/events",
            "",
            headers,
            body,
            {
                "turn_id": turn_id,
                "delivery_id": payload.get("deliveryId"),
                "event_id": payload.get("eventId"),
                "seq": payload.get("seq"),
                "type": payload.get("type"),
            },
        )
        with self.lock:
            if self.event_faults and self.event_faults[0].get("skip", 0) > 0:
                self.event_faults[0]["skip"] -= 1
            elif self.event_faults:
                fault = self.event_faults.pop(0)
                return Reply(fault["status"], {"error": "scripted"}, dict(fault["headers"]))
            turn = self.turns.get(turn_id)
            if not turn:
                return Reply(404, {"error": "unknown_turn"})
            if turn["cancelled"]:
                return Reply(409, {"error": "cancelled"})
            if turn["deliveryId"] != payload.get("deliveryId"):
                return Reply(409, {"error": "stale_delivery"})
            event_id = payload.get("eventId")
            seq = payload.get("seq")
            kind = payload.get("type")
            if not isinstance(event_id, str) or not isinstance(seq, int):
                return Reply(400, {"error": "bad_request"})
            if kind not in ("delta", "text", "completed", "failed"):
                return Reply(400, {"error": "bad_request"})
            text = payload.get("text")
            if kind in ("delta", "text") and not isinstance(text, str):
                return Reply(400, {"error": "bad_request"})
            content = (kind, payload.get("itemId"), text if isinstance(text, str) else None)
            if event_id in turn["events"]:
                known = turn["events"][event_id]
                if known["content"] == content:
                    result = {
                        "schemaVersion": SCHEMA_VERSION,
                        "accepted": True,
                        "duplicate": True,
                        "eventId": event_id,
                        "seq": known["seq"],
                    }
                    return self._maybe_drop_event(result)
                return Reply(409, {"error": "event_conflict"})
            if turn["terminal"]:
                return Reply(409, {"error": "turn_terminal"})
            if seq != turn["nextSeq"]:
                return Reply(409, {"error": "out_of_order"})
            turn["events"][event_id] = {"seq": seq, "type": kind, "content": content}
            turn["nextSeq"] += 1
            if kind in ("completed", "failed"):
                turn["terminal"] = kind
                turn["terminalEvent"] = event_id
            result = {
                "schemaVersion": SCHEMA_VERSION,
                "accepted": True,
                "duplicate": False,
                "eventId": event_id,
                "seq": seq,
            }
            return self._maybe_drop_event(result)

    def _maybe_drop_event(self, result: dict) -> Reply:
        if self.event_drops:
            self.event_drops -= 1
            return Reply(drop=True)
        return Reply(200, result)

    def _files(self, turn_id: str, query: str, headers, body: bytes, fault: str | None = None) -> Reply:
        params = parse_qs(query)
        delivery_id = (params.get("deliveryId") or [None])[0]
        event_id = (params.get("eventId") or [None])[0]
        seq_raw = (params.get("seq") or [None])[0]
        name = (params.get("name") or [None])[0]
        mime = headers.get("Content-Type") or ""
        self._record(
            "files",
            self.prefix + f"/turns/{turn_id}/files",
            query,
            headers,
            body,
            {
                "turn_id": turn_id,
                "delivery_id": delivery_id,
                "event_id": event_id,
                "seq": seq_raw,
                "name": name,
                "mime": mime,
            },
        )
        with self.lock:
            if fault:
                return Reply(409, {"error": fault})
            if self.file_faults:
                fault = self.file_faults.pop(0)
                return Reply(fault["status"], {"error": "scripted"}, dict(fault["headers"]))
            turn = self.turns.get(turn_id)
            if not turn:
                return Reply(404, {"error": "unknown_turn"})
            if turn["cancelled"]:
                return Reply(409, {"error": "cancelled"})
            if turn["deliveryId"] != delivery_id:
                return Reply(409, {"error": "stale_delivery"})
            if not event_id or not name or not seq_raw:
                return Reply(400, {"error": "bad_request"})
            if headers.get("Content-Length") is None:
                return Reply(400, {"error": "content_length_required"})
            try:
                seq = int(seq_raw)
            except ValueError:
                return Reply(400, {"error": "bad_request"})
            limit = 10 << 20 if mime.startswith("image/") else 100 << 20
            if len(body) > limit:
                return Reply(413, {"error": "too_large"})
            digest = hashlib.sha256(body).hexdigest()
            if event_id in turn["files"]:
                known = turn["files"][event_id]
                if known["sha256"] == digest:
                    return self._maybe_drop_file(
                        {
                            "schemaVersion": SCHEMA_VERSION,
                            "accepted": True,
                            "duplicate": True,
                            "eventId": event_id,
                            "seq": known["seq"],
                            "uploadId": known["uploadId"],
                        }
                    )
                return Reply(409, {"error": "file_conflict"})
            if turn["terminal"]:
                return Reply(409, {"error": "turn_terminal"})
            if seq != turn["nextSeq"]:
                return Reply(409, {"error": "out_of_order"})
            upload_id = f"up-{event_id}"
            turn["files"][event_id] = {
                "seq": seq,
                "sha256": digest,
                "bytes": body,
                "name": name,
                "mime": mime,
                "uploadId": upload_id,
            }
            turn["nextSeq"] += 1
            return self._maybe_drop_file(
                {
                    "schemaVersion": SCHEMA_VERSION,
                    "accepted": True,
                    "duplicate": False,
                    "eventId": event_id,
                    "seq": seq,
                    "uploadId": upload_id,
                }
            )

    def _maybe_drop_file(self, result: dict) -> Reply:
        if self.file_drops:
            self.file_drops -= 1
            return Reply(drop=True)
        return Reply(200, result)

    def is_upload(self, path: str) -> bool:
        return path.startswith(self.prefix + "/turns/") and path.endswith("/files")

    def read_upload_body(self, path: str, stream, length: int) -> tuple[bytes, str | None]:
        """Reads a file upload in chunks, renewing the lease on every chunk like the real server.

        With `file_chunk_delay` set the body arrives slowly, so the upload can outlive a short lease;
        `fault` names the delivery problem noticed mid-upload (the answer is then 409).
        """
        parsed = urlsplit(path)
        sub = parsed.path[len(self.prefix) :]
        turn_id = sub[len("/turns/") : -len("/files")]
        delivery_id = (parse_qs(parsed.query).get("deliveryId") or [None])[0]
        chunks: list[bytes] = []
        fault = None
        left = length
        while left > 0:
            chunk = stream.read(min(self.file_chunk_bytes, left))
            if not chunk:
                break
            left -= len(chunk)
            chunks.append(chunk)
            if self.file_chunk_delay:
                time.sleep(self.file_chunk_delay)
            if fault is None:
                fault = self._renew_upload_lease(turn_id, delivery_id)
        return b"".join(chunks), fault

    def _renew_upload_lease(self, turn_id: str, delivery_id: str) -> str | None:
        with self.lock:
            turn = self.turns.get(turn_id)
            if not turn:
                return "unknown_turn"
            if turn["cancelled"]:
                return "cancelled"
            if turn["terminal"]:
                return "finished"
            if turn["deliveryId"] != delivery_id:
                return "stale_delivery"
            if turn["leaseUntil"] <= time.time():
                return "stale_delivery"
            turn["leaseUntil"] = time.time() + self.lease_seconds
            self.upload_renewals += 1
        return None


def _make_handler(fake: FakeOMB):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            return

        def do_POST(self):
            parsed = urlsplit(self.path)
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            fault = None
            if length > 0 and fake.is_upload(parsed.path):
                body, fault = fake.read_upload_body(self.path, self.rfile, length)
            else:
                body = self.rfile.read(length) if length > 0 else b""
            reply = fake.handle_post(parsed.path, parsed.query, self.headers, body, fault)
            if reply.drop:
                self.close_connection = True
                try:
                    self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                return
            raw = reply.raw
            if raw is None:
                raw = json.dumps(reply.body or {}, separators=(",", ":")).encode("utf-8")
            with fake.lock:
                fake.response_sizes.append((parsed.path.rsplit("/", 1)[-1], len(raw)))
            self.send_response(reply.status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            for key, value in (reply.headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            try:
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True

        def do_GET(self):
            self.send_response(405)
            self.send_header("Content-Length", "0")
            self.end_headers()

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description="local fake of the OMB Muse Relay data plane")
    parser.add_argument("--token", required=True)
    parser.add_argument("--connection-id", default="conn-test")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    fake = FakeOMB(args.token, args.connection_id, port=args.port)
    print(fake.base_url, flush=True)
    fake._thread.start()
    try:
        while fake._thread.is_alive():
            fake._thread.join(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        fake.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
