#!/usr/bin/env python3
"""OpenMausBot Muse Relay client.

Data plane contract: schemaVersion 1 over /hooks/muse-relay/v1/<connectionId>
(poll, heartbeat, text events, raw-byte file upload). The connection token is
read from a 0600 config file outside this source tree and must never reach
argv, stdout, stderr, the wake payload or any state file.
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import http.client
import ipaddress
import json
import mimetypes
import os
import re
import signal
import ssl
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit
import urllib.request
import base64
from concurrent.futures import ThreadPoolExecutor

SCHEMA_VERSION = 1

MAX_JSON_BODY = 1 << 20
# One inbound turn's text or system prompt, as the server queues it (MUSE_RELAY_MAX_TURN_TEXT_BYTES).
MAX_TURN_TEXT = 1 << 20
MAX_TEXT = 256 << 10
MAX_POLL_RESPONSE = 16 << 20
MAX_API_RESPONSE = 64 << 10
MAX_TRANSCRIPT_BYTES = 4 << 20
MAX_TRANSCRIPT_ITEMS = 1000
IMAGE_LIMIT = 10 << 20
FILE_LIMIT = 100 << 20
MAX_CONFIG_BYTES = 64 << 10
MAX_STATE_BYTES = 1 << 20
# Some paths to the Muse sandbox cut HTTP response bodies near 3.4 KB, so the poll asks for deliveries by
# reference and fetches each input in raw slices of at most INPUT_SLICE_BYTES (base64 keeps a response ~2.1 KB).
INPUT_SLICE_BYTES = 1536
INPUT_SLICE_ATTEMPTS = 8
# The background heartbeat loop (started by claim, stopped by complete/fail) renews the lease every
# 30 s and gives up on its own after 30 minutes, so a worker that dies cannot hold a turn forever.
HEARTBEAT_INTERVAL_SECONDS = 30
HEARTBEAT_MAX_SECONDS = 30 * 60
# Slices are fetched in parallel: each is its own TLS+CONNECT round trip through Muse's egress proxy, so 6 serial
# slices cost ~6 round trips before the worker can even be woken.
INPUT_SLICE_PARALLEL = 6
# About one request in four dies on Muse's egress proxy (reason=network, ~1.3 s), and the next one usually works.
# Such a failure, a timeout or a 502/503/504 without Retry-After is "transient": the first POLL_QUICK_RETRIES
# consecutive ones are retried at once inside the same poll (or, when this run has no time left, on the very next run
# without backoff); exponential backoff starts only after that. send-text/complete/fail/heartbeat retry the same
# request (same eventId and seq, so the server dedupes it) up to EVENT_QUICK_RETRIES times while that stays cheap.
TRANSIENT_KINDS = frozenset({"network", "timeout", "http_502", "http_503", "http_504", "truncated"})
POLL_QUICK_RETRIES = 3
POLL_QUICK_WINDOW_S = 8.0
EVENT_QUICK_RETRIES = 2
EVENT_QUICK_WINDOW_S = 10.0
QUICK_PAUSE_S = 0.25
TRACE_MAX_BYTES = 256 << 10
MAX_INPUT_BYTES = 16 << 20
# Long replies go out as several text events of at most this many UTF-8 bytes each, so no request body is large.
TEXT_PART_BYTES = 4096
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")

DEFAULT_CONFIG = Path.home() / ".config" / "omb-muse-relay" / "config.json"
DEFAULT_STATE = Path.home() / ".local" / "state" / "omb-muse-relay"

EXIT_OK = 0
EXIT_CONFIG = 1
EXIT_USAGE = 2
EXIT_NO_PENDING = 3
EXIT_STALE = 4
EXIT_PERMANENT = 5
EXIT_CONFLICT = 6
EXIT_RETRY = 7
EXIT_CANCELLED = 8
EXIT_TERMINATED = 143

SCRIPT_DIR = Path(__file__).resolve().parent

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
MIME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+-]*/[A-Za-z0-9][A-Za-z0-9.+-]*$")
SAFE_VALUE_RE = re.compile(r"^[A-Za-z0-9_.:+-]*$")

TERMINAL_KINDS = ("completed", "failed")


class RelayError(Exception):
    kind = "internal"


class ConfigError(RelayError):
    kind = "config"


class UsageError(RelayError):
    kind = "usage"


class StateError(RelayError):
    kind = "state"


class ContractError(RelayError):
    kind = "invalid_response"


class AuthError(RelayError):
    def __init__(self, status: int):
        self.status = status
        self.kind = f"http_{status}"
        super().__init__(self.kind)


class StaleDelivery(RelayError):
    kind = "stale"


class StateConflict(RelayError):
    kind = "conflict"


class PermanentError(RelayError):
    def __init__(self, kind: str):
        self.kind = kind
        super().__init__(kind)


class RetriableError(RelayError):
    def __init__(self, kind: str, retry_ms: int = 0, detail: str | None = None):
        self.kind = kind
        self.retry_ms = retry_ms
        super().__init__(detail if detail is not None else kind)


class Cancelled(RelayError):
    kind = "cancelled"


class Terminated(RelayError):
    kind = "terminated"


def _sigterm(_signum, _frame):
    raise Terminated()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def require_id(value, what: str, exc=ContractError) -> str:
    if not isinstance(value, str) or not ID_RE.match(value):
        raise exc(f"invalid {what}")
    return value


def require_name(value) -> str:
    if not isinstance(value, str) or not (1 <= len(value) <= 200):
        raise UsageError("invalid file name")
    if value in (".", "..") or value != value.strip():
        raise UsageError("invalid file name")
    for ch in value:
        if ord(ch) < 0x20 or ord(ch) == 0x7F or ch in ("/", "\\"):
            raise UsageError("invalid file name")
    return value


def require_mime(value) -> str:
    if not isinstance(value, str) or len(value) > 120 or not MIME_RE.match(value):
        raise UsageError("invalid MIME type")
    return value


def turn_key(turn_id: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", turn_id)[:64]
    digest = hashlib.sha256(turn_id.encode("utf-8")).hexdigest()[:10]
    return f"{cleaned}-{digest}"


def fsync_dir(path: Path) -> None:
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _read_regular_file(path: Path, max_bytes: int, what: str) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise ConfigError(f"{what} must not be a symlink") from None
        raise
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise ConfigError(f"{what} must be a regular file")
        if st.st_size > max_bytes:
            raise ConfigError(f"{what} is too large")
        with os.fdopen(fd, "rb") as handle:
            fd = -1
            data = handle.read(max_bytes + 1)
    finally:
        if fd >= 0:
            os.close(fd)
    if len(data) > max_bytes:
        raise ConfigError(f"{what} is too large")
    return data


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def validate_state_dir(raw) -> Path:
    if not isinstance(raw, str) or not raw:
        raise ConfigError("stateDir must be a non-empty string")
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ConfigError("stateDir must be an absolute path")
    resolved = path.resolve(strict=False)
    if resolved == Path("/"):
        raise ConfigError("stateDir must not be the filesystem root")
    if resolved == SCRIPT_DIR or SCRIPT_DIR in resolved.parents:
        raise ConfigError("stateDir must live outside the source tree")
    return resolved


@dataclass(frozen=True)
class Config:
    scheme: str
    host: str
    port: int
    connection_id: str
    token: str
    base_path: str
    state_dir: Path
    config_path: Path


def load_config() -> Config:
    raw_path = os.environ.get("OMB_RELAY_CONFIG") or str(DEFAULT_CONFIG)
    path = Path(raw_path).expanduser()
    try:
        resolved = path.resolve(strict=True)
    except OSError:
        raise ConfigError("config file is missing") from None
    if resolved == SCRIPT_DIR or SCRIPT_DIR in resolved.parents:
        raise ConfigError("config must live outside the source tree")
    try:
        raw = _read_regular_file(path, MAX_CONFIG_BYTES, "config")
    except FileNotFoundError:
        raise ConfigError("config file is missing") from None
    except PermissionError:
        raise ConfigError("config file is not readable") from None
    st = os.stat(path)
    if st.st_uid != os.geteuid():
        raise ConfigError("config file must be owned by the current user")
    if stat.S_IMODE(st.st_mode) & 0o077:
        raise ConfigError("config file permissions must be 0600")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ConfigError("config is not valid JSON") from None
    if not isinstance(data, dict):
        raise ConfigError("config must be a JSON object")
    if data.get("schemaVersion") != SCHEMA_VERSION:
        raise ConfigError("config schemaVersion must be 1")

    base_url = data.get("baseUrl")
    if not isinstance(base_url, str) or not base_url:
        raise ConfigError("config baseUrl is required")
    parts = urlsplit(base_url)
    if parts.scheme not in ("https", "http"):
        raise ConfigError("config baseUrl must be https (http only for loopback)")
    if parts.username or parts.password:
        raise ConfigError("config baseUrl must not contain credentials")
    if parts.query or parts.fragment or parts.path not in ("", "/"):
        raise ConfigError("config baseUrl must be an origin without a path")
    host = parts.hostname
    if not host:
        raise ConfigError("config baseUrl has no host")
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        raise ConfigError("config baseUrl has an invalid port") from None
    if parts.scheme == "http" and not _is_loopback(host):
        raise ConfigError("http is only allowed for loopback test addresses; use https")

    connection_id = data.get("connectionId")
    if not isinstance(connection_id, str) or not ID_RE.match(connection_id):
        raise ConfigError("config connectionId is invalid")

    token = data.get("token")
    if not isinstance(token, str) or not (16 <= len(token) <= 512):
        raise ConfigError("config token is invalid")
    if any(ord(ch) < 0x21 or ord(ch) > 0x7E for ch in token):
        raise ConfigError("config token is invalid")
    if token.lower().startswith("bearer "):
        raise ConfigError("config token must not include the Bearer prefix")

    base_path = f"/hooks/muse-relay/v1/{quote(connection_id, safe='')}"
    declared = data.get("basePath")
    if declared is not None and declared != base_path:
        raise ConfigError("config basePath does not match connectionId")

    declared_state = data.get("stateDir")
    if declared_state is not None:
        validate_state_dir(declared_state)
    state_raw = os.environ.get("OMB_RELAY_STATE_DIR") or declared_state
    state_dir = validate_state_dir(state_raw) if state_raw else validate_state_dir(str(DEFAULT_STATE))

    return Config(
        scheme=parts.scheme,
        host=host,
        port=port,
        connection_id=connection_id,
        token=token,
        base_path=base_path,
        state_dir=state_dir,
        config_path=resolved,
    )


def resolve_state_dir() -> Path:
    env = os.environ.get("OMB_RELAY_STATE_DIR")
    if env:
        return validate_state_dir(env)
    try:
        return load_config().state_dir
    except ConfigError:
        return validate_state_dir(str(DEFAULT_STATE))


class StateStore:
    SUBDIRS = ("pending", "processing", "ledger", "locks", "cancelled", "done", "stale", "corrupt", "tmp")

    def __init__(self, root: Path):
        self.root = Path(root)
        if self.root.is_symlink():
            raise StateError("state directory must not be a symlink")
        try:
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(self.root, 0o700)
            for sub in self.SUBDIRS:
                path = self.root / sub
                path.mkdir(mode=0o700, exist_ok=True)
                os.chmod(path, 0o700)
        except OSError as exc:
            raise StateError(f"state directory is not usable: {exc.strerror or 'error'}") from None

    def path(self, sub: str, turn_id: str, suffix: str = ".json") -> Path:
        return self.root / sub / f"{turn_key(turn_id)}{suffix}"

    def atomic_write(self, path: Path, data: bytes) -> None:
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-")
        try:
            os.fchmod(fd, 0o600)
            handle = os.fdopen(fd, "wb")
            fd = -1
            with handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, path)
            fsync_dir(path.parent)
        finally:
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
            try:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            except OSError:
                pass

    def write_json(self, path: Path, obj: dict) -> None:
        data = json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8") + b"\n"
        self.atomic_write(path, data)

    def read_json(self, path: Path, max_bytes: int = MAX_STATE_BYTES) -> dict:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(path, flags)
        except FileNotFoundError:
            raise StateError("state file disappeared") from None
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise StateError("state file must not be a symlink") from None
            raise
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                raise StateError("state file must be regular")
            if st.st_size > max_bytes:
                raise StateError("state file is too large")
            with os.fdopen(fd, "rb") as handle:
                fd = -1
                raw = handle.read(max_bytes + 1)
        finally:
            if fd >= 0:
                os.close(fd)
        if len(raw) > max_bytes:
            raise StateError("state file is too large")
        try:
            obj = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise StateError("state file is not valid JSON") from None
        if not isinstance(obj, dict):
            raise StateError("state file must be a JSON object")
        return obj

    def remove(self, path: Path) -> None:
        try:
            os.unlink(path)
            fsync_dir(path.parent)
        except FileNotFoundError:
            pass

    def quarantine(self, path: Path, sub: str = "corrupt") -> Path | None:
        dest = self.root / sub / f"{path.name}.{int(time.time())}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
        try:
            os.replace(path, dest)
        except FileNotFoundError:
            return None
        fsync_dir(path.parent)
        fsync_dir(dest.parent)
        return dest

    def _sort_key(self, path: Path) -> float:
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0

    def list_files(self, sub: str) -> list[Path]:
        directory = self.root / sub
        out = []
        try:
            entries = list(os.scandir(directory))
        except FileNotFoundError:
            return out
        for entry in entries:
            if entry.name.startswith(".") or not entry.name.endswith(".json"):
                continue
            try:
                if not entry.is_file(follow_symlinks=False):
                    continue
            except OSError:
                continue
            out.append(Path(entry.path))
        out.sort(key=self._sort_key)
        return out

    def list_artifacts(self, sub: str) -> list[Path]:
        directory = self.root / sub
        out = []
        try:
            entries = list(os.scandir(directory))
        except FileNotFoundError:
            return out
        for entry in entries:
            if entry.name.startswith("."):
                continue
            try:
                if not entry.is_file(follow_symlinks=False):
                    continue
            except OSError:
                continue
            out.append(Path(entry.path))
        out.sort(key=self._sort_key)
        return out

    def list_pending(self) -> list[Path]:
        return self.list_files("pending")

    def list_processing(self) -> list[Path]:
        return self.list_files("processing")

    @contextmanager
    def named_guard(self, name: str):
        path = self.root / "locks" / name
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
        acquired = False
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
            except BlockingIOError:
                acquired = False
            yield acquired
        finally:
            if acquired:
                try:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                except OSError:
                    pass
            os.close(fd)

    @contextmanager
    def turn_guard(self, turn_id: str, blocking: bool = True):
        path = self.root / "locks" / f"{turn_key(turn_id)}.lock"
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
        acquired = False
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
                acquired = True
            except BlockingIOError:
                acquired = False
            yield acquired
        finally:
            if acquired:
                try:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                except OSError:
                    pass
            os.close(fd)

    def new_ledger(self, turn_id: str) -> dict:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "turnId": turn_id,
            "deliveryId": None,
            "staleDeliveryId": None,
            "nextSeq": 1,
            "terminal": None,
            "terminalEventId": None,
            "events": {},
            "items": {},
            "inflight": None,
            "updatedAt": now_iso(),
        }

    def load_ledger(self, turn_id: str) -> dict:
        path = self.path("ledger", turn_id)
        if not path.exists():
            return self.new_ledger(turn_id)
        obj = self.read_json(path)
        if obj.get("schemaVersion") != SCHEMA_VERSION:
            raise StateError("ledger schemaVersion is invalid")
        if obj.get("turnId") != turn_id:
            raise StateError("ledger belongs to another turn")
        if not isinstance(obj.get("nextSeq"), int) or obj["nextSeq"] < 1:
            raise StateError("ledger nextSeq is invalid")
        if not isinstance(obj.get("events"), dict):
            raise StateError("ledger events are invalid")
        if obj.get("items") is not None and not isinstance(obj.get("items"), dict):
            raise StateError("ledger items are invalid")
        if obj.get("terminal") not in (None, "completed", "failed", "cancelled"):
            raise StateError("ledger terminal state is invalid")
        if obj.get("inflight") is not None and not isinstance(obj.get("inflight"), dict):
            raise StateError("ledger inflight state is invalid")
        obj.setdefault("staleDeliveryId", None)
        obj.setdefault("terminalEventId", None)
        obj.setdefault("items", {})
        return obj

    def save_ledger(self, turn_id: str, ledger: dict) -> None:
        ledger["updatedAt"] = now_iso()
        self.write_json(self.path("ledger", turn_id), ledger)

    def read_processing(self, turn_id: str) -> dict | None:
        path = self.path("processing", turn_id)
        if not path.exists():
            return None
        try:
            return self.read_json(path)
        except StateError:
            return None

    def detach_processing(self, turn_id: str, delivery_id: str, sub: str) -> bool:
        path = self.path("processing", turn_id)
        if not path.exists():
            return False
        try:
            rec = self.read_json(path)
        except StateError:
            self.quarantine(path, "corrupt")
            return False
        if rec.get("deliveryId") != delivery_id:
            return False
        dest = self.root / sub / f"{path.name}.{int(time.time())}-{uuid.uuid4().hex[:6]}"
        try:
            os.replace(path, dest)
        except FileNotFoundError:
            return False
        fsync_dir(path.parent)
        fsync_dir(dest.parent)
        return True

    def is_cancelled(self, turn_id: str) -> bool:
        return self.path("cancelled", turn_id).exists()

    def mark_cancelled(self, turn_id: str) -> None:
        marker = self.path("cancelled", turn_id)
        if not marker.exists():
            self.write_json(marker, {"schemaVersion": SCHEMA_VERSION, "turnId": turn_id, "at": now_iso()})
        self.remove(self.path("pending", turn_id))

    def holds_delivery(self, turn_id: str, delivery_id: str) -> str | None:
        """Where this exact delivery already sits (pending, processing or a finished turn), if anywhere."""
        try:
            if self.load_ledger(turn_id).get("terminal"):
                return "terminal"
        except StateError:
            pass
        for sub in ("processing", "pending"):
            path = self.path(sub, turn_id)
            if not path.exists():
                continue
            try:
                if self.read_json(path).get("deliveryId") == delivery_id:
                    return sub
            except StateError:
                pass
        return None

    def save_delivery(self, delivery: dict) -> str:
        turn_id = delivery["turnId"]
        if self.is_cancelled(turn_id):
            return "cancelled"
        try:
            if self.load_ledger(turn_id).get("terminal"):
                return "terminal"
        except StateError:
            pass
        processing = self.path("processing", turn_id)
        if processing.exists():
            try:
                rec = self.read_json(processing)
                if rec.get("deliveryId") == delivery.get("deliveryId"):
                    return "already_claimed"
            except StateError:
                pass
        self.write_json(self.path("pending", turn_id), delivery)
        return "queued"


class _FileBody:
    def __init__(self, handle, size: int):
        self.handle = handle
        self.size = size
        self.sent = 0

    def read(self, amount: int = -1) -> bytes:
        remaining = self.size - self.sent
        if remaining <= 0:
            return b""
        if amount is None or amount < 0:
            amount = min(65536, remaining)
        else:
            amount = min(amount, remaining)
        chunk = self.handle.read(amount)
        if not chunk:
            raise OSError("file changed while uploading")
        self.sent += len(chunk)
        return chunk


def _https_proxy_for(host: str):
    """Honor https_proxy/HTTPS_PROXY and no_proxy (Muse's sandbox egresses via a proxy).

    Only plain http:// proxies (HTTP CONNECT) are supported. Returns
    (proxy_host, proxy_port, tunnel_headers) or None for a direct connection.
    """
    try:
        if urllib.request.proxy_bypass_environment(host):
            return None
    except Exception:
        pass
    raw = urllib.request.getproxies_environment().get("https")
    if not raw:
        return None
    if "://" not in raw:
        raw = "http://" + raw
    parts = urlsplit(raw)
    if parts.scheme != "http" or not parts.hostname:
        raise ConfigError("unsupported https_proxy scheme (only http:// CONNECT proxies)")
    headers = {}
    if parts.username is not None:
        cred = f"{unquote(parts.username)}:{unquote(parts.password or '')}"
        headers["Proxy-Authorization"] = "Basic " + base64.b64encode(cred.encode("utf-8")).decode("ascii")
    return parts.hostname, parts.port or 1080, headers


def _parse_content_length(value: str | None) -> int | None:
    """Content-Length as an int, or None when the header is missing or malformed."""
    if value is None:
        return None
    try:
        parsed = int(value.strip())
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _response_detail(status: int, content_type: str | None, raw: bytes) -> str:
    """Diagnostic suffix for a ContractError: HTTP status, Content-Type, body size, and (only for a non-JSON body) the first 80 bytes. Never logs token, Authorization, or JSON content."""
    detail = f"status={status} content_type={content_type or '-'} bytes={len(raw)}"
    if raw and raw.lstrip()[:1] != b"{":
        detail += f" head={raw[:80]!r}"
    return detail


def _http_request(
    cfg: Config,
    method: str,
    subpath: str,
    *,
    body=None,
    headers: dict | None = None,
    timeout: float = 30.0,
    max_response: int = MAX_API_RESPONSE,
):
    if cfg.scheme == "https":
        proxy = _https_proxy_for(cfg.host)
        if proxy is not None:
            proxy_host, proxy_port, proxy_headers = proxy
            connection = http.client.HTTPSConnection(
                proxy_host, proxy_port, timeout=timeout, context=ssl.create_default_context()
            )
            connection.set_tunnel(cfg.host, cfg.port, headers=proxy_headers)
        else:
            connection = http.client.HTTPSConnection(
                cfg.host, cfg.port, timeout=timeout, context=ssl.create_default_context()
            )
    else:
        connection = http.client.HTTPConnection(cfg.host, cfg.port, timeout=timeout)
    request_headers = {
        "Authorization": f"Bearer {cfg.token}",
        "Accept": "application/json",
        "User-Agent": "omb-muse-relay/1",
        "Connection": "close",
    }
    if headers:
        request_headers.update(headers)
    path = cfg.base_path + subpath
    try:
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        status = response.status
        raw = response.read(max_response + 1)
        retry_after = response.getheader("Retry-After")
        content_type = response.getheader("Content-Type")
        content_length = _parse_content_length(response.getheader("Content-Length"))
    except http.client.IncompleteRead as exc:
        got = len(getattr(exc, "partial", None) or b"")
        want = getattr(exc, "expected", None)
        detail = f"truncated got={got}" + (f" want={want}" if want is not None else "")
        raise RetriableError("truncated", detail=detail) from None
    except (http.client.HTTPException, OSError) as exc:
        raise RetriableError(_network_kind(exc)) from None
    finally:
        connection.close()

    if status in (401, 403):
        raise AuthError(status)
    if status == 409:
        raise StaleDelivery()
    if status in (408, 429):
        raise RetriableError(f"http_{status}", _retry_after_ms(retry_after))
    if 500 <= status <= 599:
        raise RetriableError(f"http_{status}", _retry_after_ms(retry_after))
    if 300 <= status <= 399:
        raise PermanentError("redirect")
    if status in (400, 404, 413):
        raise PermanentError(f"http_{status}")
    if not (200 <= status <= 299):
        raise PermanentError(f"http_{status}")
    if len(raw) > max_response:
        raise ContractError(f"response is too large: {_response_detail(status, content_type, raw)}")
    if content_length is not None and len(raw) < content_length:
        raise RetriableError("truncated", detail=f"truncated got={len(raw)} want={content_length}")
    if not raw:
        raise ContractError(f"empty response: {_response_detail(status, content_type, raw)}")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        if content_length is None and raw.lstrip()[:1] == b"{":
            raise RetriableError("truncated", detail=f"truncated got={len(raw)}") from None
        raise ContractError(f"response is not valid JSON: {_response_detail(status, content_type, raw)}") from None
    if not isinstance(parsed, dict):
        raise ContractError(f"response is not a JSON object: {_response_detail(status, content_type, raw)}")
    return parsed


def _network_kind(exc: Exception) -> str:
    import socket

    if isinstance(exc, (socket.timeout, TimeoutError)):
        return "timeout"
    return "network"


def _retry_after_ms(value: str | None) -> int:
    if not value:
        return 0
    try:
        seconds = int(value.strip())
    except ValueError:
        return 0
    return max(0, min(300, seconds)) * 1000


def _post_json(cfg: Config, subpath: str, payload: dict, timeout: float = 30.0, max_response: int = MAX_API_RESPONSE) -> dict:
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(raw) > MAX_JSON_BODY:
        raise PermanentError("too_large")
    return _http_request(
        cfg,
        "POST",
        subpath,
        body=raw,
        headers={"Content-Type": "application/json"},
        timeout=timeout,
        max_response=max_response,
    )


def _sleep(seconds: float) -> None:
    time.sleep(seconds)


def _env_int(name: str, default: int, low: int, high: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(low, min(high, value))


def _quick_retryable(exc: Exception) -> bool:
    """A transport hiccup worth repeating at once; a server that asked for a pause (Retry-After) gets its pause."""
    return isinstance(exc, RetriableError) and exc.kind in TRANSIENT_KINDS and not exc.retry_ms


def _run_deadline() -> float | None:
    """Epoch second by which the hook run that called us must be done (OMB_RELAY_RUN_DEADLINE), if any."""
    raw = os.environ.get("OMB_RELAY_RUN_DEADLINE", "").strip()
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if value > 0 else None


def _time_left() -> float | None:
    deadline = _run_deadline()
    return None if deadline is None else deadline - time.time()


def _quick(call, what: str, turn_id: str | None = None):
    """Runs one idempotent request, repeating it at once on a transient failure while that stays cheap."""
    retries = _env_int("OMB_RELAY_EVENT_QUICK_RETRIES", EVENT_QUICK_RETRIES, 0, 5)
    started = time.monotonic()
    tries = 0
    while True:
        try:
            return call()
        except RetriableError as exc:
            left = _time_left()
            if (
                tries >= retries
                or not _quick_retryable(exc)
                or time.monotonic() - started > EVENT_QUICK_WINDOW_S
                or (left is not None and left < 3)
            ):
                raise
            tries += 1
            trace("quick_retry", what=what, turn=turn_id[:8] if turn_id else None, reason=exc.kind, n=tries)
            _sleep(QUICK_PAUSE_S * tries)


def _validate_delivery_ref(delivery: dict) -> dict:
    """A poll delivery sent with inputMode=ref: the envelope plus inputBytes/inputSha256, no input."""
    if not isinstance(delivery, dict):
        raise ContractError("delivery is not an object")
    turn_id = require_id(delivery.get("turnId"), "delivery turnId")
    delivery_id = require_id(delivery.get("deliveryId"), "deliveryId")
    attempt = delivery.get("attempt")
    if not isinstance(attempt, int) or isinstance(attempt, bool) or not (1 <= attempt <= 10000):
        raise ContractError("delivery attempt is invalid")
    for field in ("leaseUntil", "createdAt"):
        value = delivery.get(field)
        if not isinstance(value, str) or len(value) > 64:
            raise ContractError(f"delivery {field} is invalid")
    size = delivery.get("inputBytes")
    if not isinstance(size, int) or isinstance(size, bool) or not (2 <= size <= MAX_INPUT_BYTES):
        raise ContractError("delivery inputBytes is invalid")
    digest = delivery.get("inputSha256")
    if not isinstance(digest, str) or not SHA256_RE.match(digest):
        raise ContractError("delivery inputSha256 is invalid")
    return {
        "turnId": turn_id,
        "deliveryId": delivery_id,
        "attempt": attempt,
        "leaseUntil": delivery["leaseUntil"],
        "createdAt": delivery["createdAt"],
        "inputBytes": size,
        "inputSha256": digest,
    }


def _input_subpath(turn_id: str) -> str:
    return f"/turns/{quote(turn_id, safe='')}/input"


def _safe_trace_value(text: str, limit: int = 200) -> str:
    """Collapse a diagnostic message into the trace log's safe alphabet (letters, digits, _ . : + -); trace() replaces anything else with 'invalid'."""
    out = re.sub(r"[^A-Za-z0-9_.:+-]+", "_", text).strip("_")
    return out[:limit] or "none"


def _fetch_input_slice(cfg: Config, ref: dict, offset: int) -> bytes:
    """One slice, retried on network trouble or a damaged answer; a 409 (StaleDelivery) is not retried."""
    total = ref["inputBytes"]
    want = min(INPUT_SLICE_BYTES, total - offset)
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "deliveryId": ref["deliveryId"],
        "offset": offset,
        "length": want,
    }
    last = RetriableError("input_slice")
    for attempt in range(INPUT_SLICE_ATTEMPTS):
        started = time.monotonic()
        try:
            response = _post_json(cfg, _input_subpath(ref["turnId"]), payload, timeout=20.0)
            if response.get("schemaVersion") != SCHEMA_VERSION:
                raise ContractError(f"input slice schemaVersion is invalid: got {response.get('schemaVersion')!r}")
            if response.get("offset") != offset or response.get("total") != total:
                raise ContractError(
                    f"input slice offset/total mismatch: got offset={response.get('offset')!r} total={response.get('total')!r} want offset={offset} total={total}"
                )
            data = response.get("data")
            if not isinstance(data, str):
                raise ContractError(f"input slice data is invalid: type={type(data).__name__}")
            try:
                chunk = base64.b64decode(data.encode("ascii"), validate=True)
            except (ValueError, UnicodeEncodeError):
                raise ContractError(f"input slice data is not base64: len={len(data)}") from None
            if len(chunk) != want:
                raise ContractError(f"input slice has the wrong length: got {len(chunk)} want {want}")
            return chunk
        except RetriableError as exc:
            last = exc
            kind = exc.kind
            detail = str(exc)
        except ContractError as exc:
            last = RetriableError("input_slice_invalid")
            kind = "input_slice_invalid"
            detail = str(exc)
        trace(
            "input_slice_try",
            **{
                "turn": ref["turnId"][:8],
                "attempt": ref["attempt"],
                "offset": offset,
                "want": want,
                "try": attempt + 1,
                "kind": kind,
                "detail": _safe_trace_value(detail),
                "ms": int((time.monotonic() - started) * 1000),
            },
        )
        if attempt + 1 < INPUT_SLICE_ATTEMPTS:
            _sleep(min(2.0, 0.25 * (2 ** attempt)))
    raise RetriableError(last.kind, last.retry_ms, detail=str(last))


def fetch_delivery_input(cfg: Config, ref: dict) -> dict:
    """Reassembles a ref delivery's input, checks its length and SHA-256, and returns the full checked delivery.

    Any failure raises before anything is written, so the poll persists nothing for this round and the server's
    lease expiry redelivers the turn.
    """
    total = ref["inputBytes"]
    offsets = list(range(0, total, INPUT_SLICE_BYTES))
    if len(offsets) == 1:
        raw = _fetch_input_slice(cfg, ref, 0)
    else:
        # The first slice goes alone so the server confirms the claim once; the rest go in parallel.
        first = _fetch_input_slice(cfg, ref, 0)
        with ThreadPoolExecutor(max_workers=min(INPUT_SLICE_PARALLEL, len(offsets) - 1)) as pool:
            rest = list(pool.map(lambda offset: _fetch_input_slice(cfg, ref, offset), offsets[1:]))
        raw = first + b"".join(rest)
    if len(raw) != total or hashlib.sha256(raw).hexdigest() != ref["inputSha256"]:
        raise RetriableError("input_sha_mismatch")
    try:
        source = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise RetriableError("input_invalid") from None
    delivery = {key: ref[key] for key in ("turnId", "deliveryId", "attempt", "leaseUntil", "createdAt")}
    delivery["input"] = source
    return _validate_delivery(delivery)


def validate_poll(data: dict, limit: int) -> dict:
    if data.get("schemaVersion") != SCHEMA_VERSION:
        raise ContractError("poll schemaVersion is invalid")
    deliveries = data.get("deliveries")
    cancellations = data.get("cancellations", [])
    server_time = data.get("serverTime")
    if not isinstance(deliveries, list) or len(deliveries) > limit:
        raise ContractError("poll deliveries are invalid")
    if not isinstance(cancellations, list) or len(cancellations) > 100:
        raise ContractError("poll cancellations are invalid")
    if not isinstance(server_time, str) or len(server_time) > 64:
        raise ContractError("poll serverTime is invalid")
    checked = []
    seen = set()
    for delivery in deliveries:
        if isinstance(delivery, dict) and "input" not in delivery and "inputBytes" in delivery:
            clean = _validate_delivery_ref(delivery)
        else:
            clean = _validate_delivery(delivery)
        if clean["turnId"] in seen:
            raise ContractError("poll repeats a turn")
        seen.add(clean["turnId"])
        checked.append(clean)
    turns = []
    for turn_id in cancellations:
        turns.append(require_id(turn_id, "cancellation turnId"))
    return {"deliveries": checked, "cancellations": turns, "serverTime": server_time}


def _validate_delivery(delivery: dict) -> dict:
    if not isinstance(delivery, dict):
        raise ContractError("delivery is not an object")
    turn_id = require_id(delivery.get("turnId"), "delivery turnId")
    delivery_id = require_id(delivery.get("deliveryId"), "deliveryId")
    attempt = delivery.get("attempt")
    if not isinstance(attempt, int) or not (1 <= attempt <= 10000):
        raise ContractError("delivery attempt is invalid")
    for field in ("leaseUntil", "createdAt"):
        value = delivery.get(field)
        if not isinstance(value, str) or len(value) > 64:
            raise ContractError(f"delivery {field} is invalid")
    source = delivery.get("input")
    if not isinstance(source, dict):
        raise ContractError("delivery input is invalid")
    thread_id = require_id(source.get("threadId"), "input threadId")
    text = source.get("text")
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_TURN_TEXT:
        raise ContractError("input text is invalid")
    system = source.get("system", "")
    if not isinstance(system, str) or len(system.encode("utf-8")) > MAX_TURN_TEXT:
        raise ContractError("input system is invalid")
    transcript = source.get("transcript", [])
    if not isinstance(transcript, list) or len(transcript) > MAX_TRANSCRIPT_ITEMS:
        raise ContractError("input transcript is invalid")
    total = 0
    clean_transcript = []
    for entry in transcript:
        if not isinstance(entry, dict):
            raise ContractError("transcript entry is invalid")
        role = entry.get("role")
        if role not in ("user", "assistant"):
            raise ContractError("transcript role is invalid")
        entry_text = entry.get("text")
        if not isinstance(entry_text, str):
            raise ContractError("transcript text is invalid")
        size = len(entry_text.encode("utf-8"))
        total += size
        if total > MAX_TRANSCRIPT_BYTES:
            raise ContractError("transcript is too large")
        clean_transcript.append({"role": role, "text": entry_text})
    return {
        "turnId": turn_id,
        "deliveryId": delivery_id,
        "attempt": attempt,
        "leaseUntil": delivery["leaseUntil"],
        "createdAt": delivery["createdAt"],
        "input": {
            "threadId": thread_id,
            "text": text,
            "system": system,
            "transcript": clean_transcript,
        },
    }


def validate_event_response(data: dict, event_id: str, seq: int) -> dict:
    if data.get("accepted") is not True:
        raise ContractError("event was not accepted")
    if data.get("eventId") != event_id:
        raise ContractError("event response eventId mismatch")
    if data.get("seq") != seq:
        raise ContractError("event response seq mismatch")
    duplicate = data.get("duplicate", False)
    if not isinstance(duplicate, bool):
        raise ContractError("event response duplicate is invalid")
    upload_id = data.get("uploadId")
    if upload_id is not None and (not isinstance(upload_id, str) or len(upload_id) > 128):
        raise ContractError("event response uploadId is invalid")
    return {"duplicate": duplicate, "uploadId": upload_id}


def validate_heartbeat(data: dict) -> dict:
    if data.get("ok") is not True:
        raise ContractError("heartbeat was not ok")
    cancelled = data.get("cancelled")
    if not isinstance(cancelled, bool):
        raise ContractError("heartbeat cancelled is invalid")
    lease = data.get("leaseUntil")
    if lease is not None and (not isinstance(lease, str) or len(lease) > 64):
        raise ContractError("heartbeat leaseUntil is invalid")
    return {"cancelled": cancelled, "leaseUntil": lease}


def load_watch_state(store: StateStore) -> dict:
    path = store.root / "watch.state.json"
    default = {"failures": 0, "nextPollAt": 0.0, "lastReason": "", "lastSuccessAt": 0.0}
    if not path.exists():
        return default
    try:
        obj = store.read_json(path, 64 << 10)
    except StateError:
        store.quarantine(path)
        return default
    if not isinstance(obj.get("failures"), int) or obj["failures"] < 0:
        return default
    next_at = obj.get("nextPollAt")
    if not isinstance(next_at, (int, float)) or next_at < 0:
        next_at = 0.0
    reason = obj.get("lastReason")
    if not isinstance(reason, str) or not re.fullmatch(r"[a-z0-9_]{0,40}", reason):
        reason = ""
    return {
        "failures": obj["failures"],
        "nextPollAt": float(next_at),
        "lastReason": reason,
        "lastSuccessAt": float(obj.get("lastSuccessAt") or 0.0),
    }


def save_watch_state(store: StateStore, state: dict) -> None:
    with store.named_guard("watch-state.lock"):
        store.write_json(store.root / "watch.state.json", state)


def emit(**fields) -> None:
    parts = []
    for key, value in fields.items():
        if value is None:
            text = "-"
        elif isinstance(value, bool):
            text = "true" if value else "false"
        else:
            text = str(value)
        if not SAFE_VALUE_RE.match(text):
            text = "invalid"
        parts.append(f"{key}={text}")
    print(" ".join(parts))


_TRACE_DIR: Path | None = None


def trace(event: str, **fields) -> None:
    """One timestamped line in <stateDir>/trace.log for latency forensics: ids are shortened, never text or tokens."""
    if _TRACE_DIR is None:
        return
    now = time.time()
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"
    parts = [stamp, event]
    for key, value in fields.items():
        text = "-" if value is None else str(value)
        if not SAFE_VALUE_RE.match(text):
            text = "invalid"
        parts.append(f"{key}={text}")
    path = _TRACE_DIR / "trace.log"
    try:
        if path.exists() and path.stat().st_size > TRACE_MAX_BYTES:
            os.replace(path, _TRACE_DIR / "trace.log.1")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, (" ".join(parts) + "\n").encode("ascii", "replace"))
        finally:
            os.close(fd)
    except OSError:
        pass


def cmd_poll(args) -> int:
    try:
        store = StateStore(resolve_state_dir())
    except (ConfigError, StateError) as exc:
        print(f"ERROR config: {exc}", file=sys.stderr)
        return EXIT_CONFIG

    global _TRACE_DIR
    _TRACE_DIR = store.root
    started = time.monotonic()
    state = load_watch_state(store)
    now = time.time()
    if now < state["nextPollAt"]:
        emit(
            status="backoff",
            retry_ms=int((state["nextPollAt"] - now) * 1000),
            notify=0,
            reason=state["lastReason"] or "backoff",
        )
        return EXIT_OK

    # Consecutive failures before this poll's request; quick retries in this run add to it, a good answer resets it.
    prior = state["failures"]
    quick_limit = _env_int("OMB_RELAY_POLL_QUICK_RETRIES", POLL_QUICK_RETRIES, 0, 5)
    try:
        cfg = load_config()
        payload = {"schemaVersion": SCHEMA_VERSION, "waitMs": args.wait_ms, "limit": args.limit, "inputMode": "ref"}
        while True:
            timeout = args.wait_ms / 1000.0 + 20.0
            left = _time_left()
            if left is not None:
                # Never outlive the hook run (Muse kills a hook after 60 s, mid-write if need be).
                timeout = min(timeout, max(3.0, left))
            try:
                response = _post_json(cfg, "/poll", payload, timeout=timeout, max_response=MAX_POLL_RESPONSE)
                break
            except RetriableError as exc:
                left = _time_left()
                if (
                    not _quick_retryable(exc)
                    or prior + 1 > quick_limit
                    or time.monotonic() - started > POLL_QUICK_WINDOW_S
                    or (left is not None and left < 4)
                ):
                    raise
                prior += 1
                trace("poll_retry", reason=exc.kind, ms=int((time.monotonic() - started) * 1000), failures=prior)
                _sleep(QUICK_PAUSE_S)
        prior = 0
        checked = validate_poll(response, args.limit)
        if checked["deliveries"] or checked["cancellations"]:
            trace(
                "poll",
                ms=int((time.monotonic() - started) * 1000),
                deliveries=",".join(f"{d['turnId'][:8]}:a{d['attempt']}" for d in checked["deliveries"]) or None,
                cancellations=len(checked["cancellations"]),
            )
        for turn_id in checked["cancellations"]:
            store.mark_cancelled(turn_id)
        # Fetch every referenced input before saving anything, so a failure leaves no half-saved delivery.
        complete = []
        for delivery in checked["deliveries"]:
            if "input" in delivery:
                complete.append(delivery)
                continue
            if store.is_cancelled(delivery["turnId"]):
                continue
            held = store.holds_delivery(delivery["turnId"], delivery["deliveryId"])
            if held:
                # OMB sent a delivery we already hold again (it resends an untouched claim once per poll): keep the
                # copy we have; save_delivery would dedupe it anyway, so skip the input fetch.
                trace("duplicate", turn=delivery["turnId"][:8], attempt=delivery["attempt"], held=held)
                continue
            fetch_started = time.monotonic()
            try:
                complete.append(fetch_delivery_input(cfg, delivery))
                trace("input", turn=delivery["turnId"][:8], attempt=delivery["attempt"], bytes=delivery["inputBytes"],
                      ms=int((time.monotonic() - fetch_started) * 1000))
            except StaleDelivery:
                # Superseded, lapsed or finished on the server: nothing to keep for this delivery.
                trace("input_stale", turn=delivery["turnId"][:8], attempt=delivery["attempt"])
                continue
            except RelayError as exc:
                trace("input_failed", turn=delivery["turnId"][:8], attempt=delivery["attempt"],
                      reason=_error_reason(exc), ms=int((time.monotonic() - fetch_started) * 1000))
                raise
        queued = 0
        for delivery in complete:
            record = dict(delivery)
            record["schemaVersion"] = SCHEMA_VERSION
            record["receivedAt"] = now_iso()
            lease_s = _lease_seconds(delivery.get("leaseUntil"), checked["serverTime"])
            if lease_s is not None:
                record["leaseSeconds"] = lease_s
            outcome = store.save_delivery(record)
            trace("saved", turn=delivery["turnId"][:8], attempt=delivery["attempt"], outcome=outcome)
            if outcome == "queued":
                queued += 1
        recovered = state["failures"] > 0
        save_watch_state(
            store,
            {"failures": 0, "nextPollAt": 0.0, "lastReason": "", "lastSuccessAt": time.time()},
        )
        if queued:
            emit(status="deliveries", count=queued, notify=1 if recovered else 0)
        else:
            emit(status="empty", notify=1 if recovered else 0)
        return EXIT_OK
    except (RelayError, Exception) as exc:
        if isinstance(exc, Terminated):
            raise
        reason = _error_reason(exc)
        failures = prior + 1
        trace("poll_error", reason=reason, ms=int((time.monotonic() - started) * 1000), failures=failures)
        if _quick_retryable(exc) and failures <= quick_limit:
            # Still within the quick retries (this run ran out of time for them): no pause before the next run.
            delay = 0.0
        elif reason in TRANSIENT_KINDS:
            # Backoff only starts after the quick retries: 1 s, 2 s, 4 s ... 300 s.
            delay = min(300.0, 1.0 * (2 ** min(max(failures - quick_limit - 1, 0), 9)))
        else:
            # 1 s, 2 s, 4 s ... 300 s: one dropped answer must not cost a 5 s pause against a 10 s target.
            delay = min(300.0, 1.0 * (2 ** min(failures - 1, 9)))
        if isinstance(exc, RetriableError) and exc.retry_ms:
            delay = max(delay, exc.retry_ms / 1000.0)
        before = state["failures"]
        notify = before == 0 or failures // 5 > before // 5
        save_watch_state(
            store,
            {
                "failures": failures,
                "nextPollAt": time.time() + delay,
                "lastReason": reason,
                "lastSuccessAt": state["lastSuccessAt"],
            },
        )
        emit(status="error", retry_ms=int(delay * 1000), notify=1 if notify else 0, reason=reason)
        return EXIT_OK


def _error_reason(exc: Exception) -> str:
    if isinstance(exc, RetriableError):
        return exc.kind
    if isinstance(exc, AuthError):
        return exc.kind
    if isinstance(exc, ConfigError):
        return "config"
    if isinstance(exc, StateError):
        return "state"
    if isinstance(exc, ContractError):
        return "invalid_response"
    if isinstance(exc, PermanentError):
        return exc.kind
    if isinstance(exc, StaleDelivery):
        return "http_409"
    return "internal"


def _do_heartbeat(cfg: Config, store: StateStore, turn_id: str | None, delivery_id: str | None) -> dict:
    payload = {"schemaVersion": SCHEMA_VERSION}
    if turn_id:
        payload["turnId"] = turn_id
        payload["deliveryId"] = delivery_id
    response = _quick(lambda: _post_json(cfg, "/heartbeat", payload, timeout=20.0), "heartbeat", turn_id)
    result = validate_heartbeat(response)
    if result["cancelled"] and turn_id:
        store.mark_cancelled(turn_id)
    if turn_id and delivery_id and not result["cancelled"]:
        with store.turn_guard(turn_id, blocking=False) as acquired:
            if acquired:
                processing = store.path("processing", turn_id)
                if processing.exists():
                    try:
                        record = store.read_json(processing)
                    except StateError:
                        record = None
                    if record and record.get("deliveryId") == delivery_id:
                        record["workerHeartbeatAt"] = now_iso()
                        record["heartbeatEpoch"] = time.time()
                        store.write_json(processing, record)
    return result


def _work_dir() -> Path:
    """The worker's scratch directory (reply.txt and the heartbeat pid file live here)."""
    override = os.environ.get("OMB_RELAY_WORK_DIR", "")
    return Path(override) if override else Path.home() / "omb-muse-relay-work"


def _hb_pid_path(turn_id: str) -> Path:
    return _work_dir() / f"hb-{turn_id}.pid"


def _is_our_heartbeat_process(pid: int, turn_id: str) -> bool:
    """True only when /proc/<pid>/cmdline shows our heartbeat-loop for this turn.

    This is the guard that keeps a stop from ever killing an unrelated process that reused the pid:
    the loop is started as `omb_relay.py heartbeat-loop --turn <turnId> --delivery <deliveryId>`, so all
    three markers must be present. A plain `heartbeat` (one-shot, no `-loop`) does not match.
    """
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return False
    text = raw.decode("utf-8", "replace").replace("\x00", " ")
    return "omb_relay.py" in text and "heartbeat-loop" in text and turn_id in text


def _stop_heartbeat(turn_id: str) -> bool:
    """SIGTERM the heartbeat loop for this turn, if the pid file names our own loop process.

    Returns True when a loop was stopped (or its stale pid file removed); False when there was
    nothing to stop, or the pid file points at a process that is not our heartbeat loop (then the
    file is left alone and nothing is killed).
    """
    path = _hb_pid_path(turn_id)
    try:
        raw = path.read_text().strip()
    except OSError:
        return False
    try:
        pid = int(raw)
    except ValueError:
        return False
    if pid <= 0:
        return False
    if not _is_our_heartbeat_process(pid, turn_id):
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except PermissionError:
        return False
    try:
        path.unlink()
    except OSError:
        pass
    trace("heartbeat_stopped", turn=turn_id[:8], pid=pid)
    return True


def _heartbeat_loop_enabled() -> bool:
    return os.environ.get("OMB_RELAY_HEARTBEAT_LOOP", "1") != "0"


def _spawn_heartbeat_loop(turn_id: str, delivery_id: str) -> int | None:
    """Start the background heartbeat loop for a claimed turn and record its pid.

    Returns the pid, or None when the loop is disabled or could not be started. A failure here
    never fails the claim: the loop is best-effort, and recover reclaims a claim that goes silent.
    The loop is detached (its own session, stdio to /dev/null) so it outlives the claim command
    and never holds the worker's pipes open.
    """
    if not _heartbeat_loop_enabled():
        return None
    pid_path = _hb_pid_path(turn_id)
    try:
        existing = int(pid_path.read_text().strip())
    except (OSError, ValueError):
        existing = None
    if existing and existing > 0 and _is_our_heartbeat_process(existing, turn_id):
        return existing
    try:
        pid_path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(pid_path.parent, 0o700)
    except OSError:
        return None
    script = str(Path(__file__).resolve())
    try:
        proc = subprocess.Popen(
            [sys.executable, script, "heartbeat-loop", "--turn", turn_id, "--delivery", delivery_id],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            cwd=str(Path(script).parent),
        )
    except OSError:
        return None
    try:
        fd = os.open(pid_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, str(proc.pid).encode("ascii"))
        finally:
            os.close(fd)
    except OSError:
        # The loop is running but its pid is not recorded; it still exits on its own when the turn
        # goes terminal or the 30-minute cap hits, and the loop also records its own pid at startup.
        return None
    trace("heartbeat_started", turn=turn_id[:8], pid=proc.pid)
    return proc.pid


def cmd_pending_count(args) -> int:
    store = StateStore(resolve_state_dir())
    print(len(store.list_pending()))
    return EXIT_OK


def cmd_claim(args) -> int:
    global _TRACE_DIR
    store = StateStore(resolve_state_dir())
    _TRACE_DIR = store.root
    for pending in store.list_pending():
        try:
            record = store.read_json(pending)
            turn_id = require_id(record.get("turnId"), "pending turnId")
            delivery_id = require_id(record.get("deliveryId"), "pending deliveryId")
        except (StateError, ContractError):
            store.quarantine(pending)
            continue
        if store.is_cancelled(turn_id):
            store.remove(pending)
            continue
        with store.turn_guard(turn_id, blocking=False) as acquired:
            if not acquired:
                continue
            processing = store.path("processing", turn_id)
            if processing.exists():
                try:
                    current = store.read_json(processing)
                except StateError:
                    current = None
                if current and current.get("deliveryId") == delivery_id:
                    store.remove(pending)
                    continue
                newer = isinstance(record.get("attempt"), int) and (
                    not current or not isinstance(current.get("attempt"), int) or record["attempt"] > current["attempt"]
                )
                if not newer:
                    continue
                # The server re-delivered this turn, so the older claim is dead there (its events would get 409):
                # retire it instead of leaving the newer delivery stuck in pending until recover's stale window.
                if current:
                    store.detach_processing(turn_id, str(current.get("deliveryId") or ""), "stale")
                else:
                    store.quarantine(processing, "stale")
                trace("superseded", turn=turn_id[:8], attempt=record.get("attempt"))
                if processing.exists():
                    continue
            try:
                ledger = store.load_ledger(turn_id)
            except StateError:
                store.quarantine(store.path("ledger", turn_id))
                ledger = store.new_ledger(turn_id)
            if ledger.get("terminal"):
                store.remove(pending)
                continue
            try:
                os.replace(pending, processing)
            except FileNotFoundError:
                continue
            fsync_dir(pending.parent)
            fsync_dir(processing.parent)
            try:
                record = store.read_json(processing)
                checked = _validate_delivery(record)
            except (StateError, ContractError):
                store.quarantine(processing)
                continue
            record.update(checked)
            record["claimedAt"] = now_iso()
            record["claimedAtEpoch"] = time.time()
            trace("claimed", turn=turn_id[:8], attempt=checked["attempt"])
            store.write_json(processing, record)
            ledger["deliveryId"] = checked["deliveryId"]
            if ledger.get("staleDeliveryId") == checked["deliveryId"]:
                ledger["staleDeliveryId"] = None
            store.save_ledger(turn_id, ledger)
            # The client owns the lease now: start the background heartbeat loop. A spawn failure
            # must never fail the claim; the loop is best-effort and recover reclaims a silent claim.
            try:
                _spawn_heartbeat_loop(checked["turnId"], checked["deliveryId"])
            except Exception:
                trace("heartbeat_spawn_failed", turn=turn_id[:8])
            output = {
                "schemaVersion": SCHEMA_VERSION,
                "turnId": checked["turnId"],
                "deliveryId": checked["deliveryId"],
                "attempt": checked["attempt"],
                "leaseUntil": checked["leaseUntil"],
                "createdAt": checked["createdAt"],
                "input": checked["input"],
                "nextSeq": ledger["nextSeq"],
                "resume": None,
            }
            inflight = ledger.get("inflight")
            if inflight:
                output["resume"] = {
                    "eventId": inflight.get("eventId"),
                    "seq": inflight.get("seq"),
                    "type": inflight.get("type"),
                }
            print(json.dumps(output, ensure_ascii=False, indent=2))
            return EXIT_OK
    emit(status="no_pending")
    return EXIT_NO_PENDING


PENDING_PICKUP_SECONDS = 75


def _parse_iso(raw) -> float | None:
    if not isinstance(raw, str):
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _lease_seconds(lease_until, server_time) -> int | None:
    """The lease the server granted at claim, measured on its own clock (no skew): 20 s new servers, 120 s old."""
    until = _parse_iso(lease_until)
    now = _parse_iso(server_time)
    if until is None or now is None:
        return None
    seconds = int(round(until - now))
    return seconds if 0 < seconds <= 3600 else None


def _received_epoch(record: dict, path: Path) -> float:
    raw = record.get("receivedAt")
    if isinstance(raw, str):
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    try:
        return path.stat().st_mtime
    except OSError:
        return time.time()


def cmd_keepalive(args, cfg: Config, store: StateStore) -> int:
    """Drop pending deliveries no worker claimed within the server's pickup window (60 s after the last slice).

    It sends nothing: only the worker may tell OMB it holds a turn (k31p review, 2026-11-19), so a worker that never
    starts is not masked. Once the window has passed OMB redelivers the turn, and while a stale copy sits in pending
    the hook would never poll for that redelivery; removing it lets the next round fetch the fresh attempt.
    """
    global _TRACE_DIR
    _TRACE_DIR = store.root
    dropped = waiting = 0
    for pending in store.list_pending():
        try:
            record = store.read_json(pending)
            turn_id = require_id(record.get("turnId"), "pending turnId")
        except (StateError, ContractError):
            continue
        age = time.time() - _received_epoch(record, pending)
        # An older OMB gives a fresh claim its full lease (120 s) and redelivers only after it; wait that long there.
        lease = record.get("leaseSeconds")
        limit = PENDING_PICKUP_SECONDS
        if isinstance(lease, int) and not isinstance(lease, bool) and 0 < lease <= 3600:
            limit = max(limit, lease + 5)
        if age <= limit:
            waiting += 1
            continue
        with store.turn_guard(turn_id, blocking=False) as acquired:
            if not acquired:
                continue
            store.remove(pending)
        dropped += 1
        trace("pending_unclaimed", turn=turn_id[:8], attempt=record.get("attempt"), age_s=int(age))
    emit(waiting=waiting, dropped=dropped)
    return EXIT_OK


def cmd_heartbeat(args, cfg: Config, store: StateStore) -> int:
    global _TRACE_DIR
    _TRACE_DIR = store.root
    if args.delivery and not args.turn:
        raise UsageError("--delivery requires --turn")
    if args.turn and not args.delivery:
        raise UsageError("--turn requires --delivery")
    turn_id = require_id(args.turn, "turnId", UsageError) if args.turn else None
    delivery_id = require_id(args.delivery, "deliveryId", UsageError) if args.delivery else None
    result = _do_heartbeat(cfg, store, turn_id, delivery_id)
    if turn_id:
        trace("heartbeat", turn=turn_id[:8], cancelled=result["cancelled"])
    emit(status="ok", cancelled=result["cancelled"])
    return EXIT_OK


def cmd_heartbeat_loop(args, cfg: Config, store: StateStore) -> int:
    """Background lease keeper for one claimed turn: heartbeat every 30 s until the turn goes
    terminal, the server says stale/cancelled, or the 30-minute cap hits.

    The first beat runs immediately (it is the post-claim heartbeat that earns the full 120 s lease);
    a SIGTERM (from complete/fail/heartbeat-stop) interrupts the sleep and ends the process.
    """
    global _TRACE_DIR
    _TRACE_DIR = store.root
    turn_id = require_id(args.turn, "turnId", UsageError)
    delivery_id = require_id(args.delivery, "deliveryId", UsageError)
    # Best-effort: record our own pid, so complete/fail can stop us even if the spawner could not.
    try:
        pid_path = _hb_pid_path(turn_id)
        pid_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(pid_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, str(os.getpid()).encode("ascii"))
        finally:
            os.close(fd)
    except OSError:
        pass
    started = time.monotonic()
    # Tests shorten the beat through the environment; production keeps the 30 s above.
    interval = _env_int("OMB_RELAY_HEARTBEAT_INTERVAL_S", HEARTBEAT_INTERVAL_SECONDS, 1, 3600)
    trace("heartbeat_loop_started", turn=turn_id[:8], pid=os.getpid())
    try:
        while True:
            if time.monotonic() - started > HEARTBEAT_MAX_SECONDS:
                trace("heartbeat_loop_stopped", turn=turn_id[:8], reason="timeout")
                return EXIT_OK
            try:
                ledger = store.load_ledger(turn_id)
            except StateError:
                ledger = {}
            if ledger.get("terminal"):
                trace("heartbeat_loop_stopped", turn=turn_id[:8], reason="terminal")
                return EXIT_OK
            try:
                result = _do_heartbeat(cfg, store, turn_id, delivery_id)
            except StaleDelivery:
                trace("heartbeat_loop_stopped", turn=turn_id[:8], reason="stale")
                return EXIT_OK
            except Cancelled:
                trace("heartbeat_loop_stopped", turn=turn_id[:8], reason="cancelled")
                return EXIT_OK
            except RetriableError as exc:
                trace("heartbeat_loop_retry", turn=turn_id[:8], kind=exc.kind)
            except (ContractError, PermanentError, AuthError):
                trace("heartbeat_loop_stopped", turn=turn_id[:8], reason="rejected")
                return EXIT_OK
            else:
                if result.get("cancelled"):
                    trace("heartbeat_loop_stopped", turn=turn_id[:8], reason="cancelled")
                    return EXIT_OK
                trace("heartbeat", turn=turn_id[:8], cancelled=False)
            time.sleep(interval)
    finally:
        # Remove our pid file so a later complete/fail does not read a stale pid.
        try:
            pid_path = _hb_pid_path(turn_id)
            if pid_path.exists():
                try:
                    if int(pid_path.read_text().strip()) == os.getpid():
                        pid_path.unlink()
                except (OSError, ValueError):
                    pass
        except OSError:
            pass


def cmd_heartbeat_stop(args) -> int:
    """Manually stop the background heartbeat loop for a turn (same logic complete/fail use)."""
    turn_id = require_id(args.turn, "turnId", UsageError)
    stopped = _stop_heartbeat(turn_id)
    emit(status="ok", stopped=stopped)
    return EXIT_OK


def _read_stdin_guarded() -> bytes:
    """Read stdin for a --text-file - fallback, but never block on an empty pipe: a terminal, a closed stdin, or 2 s without data is a usage error (exit 2)."""
    import select

    try:
        if sys.stdin.isatty():
            raise UsageError("text needs --text-file: stdin is a terminal")
    except (AttributeError, OSError, ValueError):
        pass
    try:
        ready, _, _ = select.select([sys.stdin], [], [], 2.0)
    except (OSError, ValueError, TypeError):
        # Not a real file (e.g. an in-memory stream in tests): read directly, it cannot block.
        ready = [sys.stdin]
    if not ready:
        raise UsageError("text needs --text-file: no stdin data within 2 s")
    raw = sys.stdin.buffer.read(MAX_TEXT + 1)
    if not raw:
        raise UsageError("text needs --text-file: stdin is closed")
    return raw


def _read_text(path: str) -> str:
    if path == "-":
        raw = _read_stdin_guarded()
    else:
        try:
            st = os.lstat(path)
        except OSError:
            raise PermanentError("text_file_missing") from None
        if stat.S_ISLNK(st.st_mode):
            raise PermanentError("text_file_symlink")
        if not stat.S_ISREG(st.st_mode):
            raise PermanentError("text_file_not_regular")
        if st.st_size > MAX_TEXT:
            raise PermanentError("too_large")
        with open(path, "rb") as handle:
            raw = handle.read(MAX_TEXT + 1)
    if len(raw) > MAX_TEXT:
        raise PermanentError("too_large")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        raise PermanentError("text_not_utf8") from None


def _inspect_file(path: str, name: str, mime: str) -> tuple[int, str]:
    try:
        st = os.lstat(path)
    except OSError:
        raise PermanentError("file_missing") from None
    if stat.S_ISLNK(st.st_mode):
        raise PermanentError("file_symlink")
    if not stat.S_ISREG(st.st_mode):
        raise PermanentError("file_not_regular")
    limit = IMAGE_LIMIT if mime.startswith("image/") else FILE_LIMIT
    if st.st_size > limit:
        raise PermanentError("too_large")
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1 << 20)
            if not chunk:
                break
            digest.update(chunk)
    try:
        after = os.stat(path)
    except OSError:
        raise PermanentError("file_missing") from None
    if after.st_size != st.st_size or after.st_mtime_ns != st.st_mtime_ns:
        raise PermanentError("file_changed")
    return st.st_size, digest.hexdigest()


def _event_subpath(turn_id: str) -> str:
    return f"/turns/{quote(turn_id, safe='')}/events"


def _file_subpath(turn_id: str, delivery_id: str, event_id: str, seq: int, name: str) -> str:
    return (
        f"/turns/{quote(turn_id, safe='')}/files"
        f"?deliveryId={quote(delivery_id, safe='')}"
        f"&eventId={quote(event_id, safe='')}"
        f"&seq={seq}"
        f"&name={quote(name, safe='')}"
    )


def _allocate(ledger: dict, kind: str, content_hash: str, event_id: str | None, extra: dict) -> tuple[str, int, str]:
    events = ledger["events"]
    if event_id:
        require_id(event_id, "eventId", UsageError)
        if event_id in events:
            known = events[event_id]
            if known.get("type") == kind and known.get("sha256") == content_hash:
                return event_id, known["seq"], "confirmed"
            raise StateConflict("eventId was already used with different content")
        inflight = ledger.get("inflight")
        if inflight:
            if inflight.get("eventId") != event_id:
                raise StateConflict("another event is in flight")
            if inflight.get("type") != kind or inflight.get("sha256") != content_hash:
                raise StateConflict("in-flight event differs")
            return event_id, inflight["seq"], "new"
    else:
        inflight = ledger.get("inflight")
        if inflight:
            if inflight.get("type") == kind and inflight.get("sha256") == content_hash:
                return inflight["eventId"], inflight["seq"], "new"
            raise StateConflict("another event is in flight")
        event_id = f"evt-{uuid.uuid4().hex}"
    seq = int(ledger["nextSeq"])
    ledger["inflight"] = {
        "eventId": event_id,
        "seq": seq,
        "type": kind,
        "sha256": content_hash,
        "attempts": 0,
        "lastError": "",
        **extra,
    }
    return event_id, seq, "new"


def _mark_stale(store: StateStore, turn_id: str, delivery_id: str) -> None:
    with store.turn_guard(turn_id, blocking=True) as acquired:
        if not acquired:
            return
        try:
            ledger = store.load_ledger(turn_id)
        except StateError:
            return
        ledger["inflight"] = None
        ledger["staleDeliveryId"] = delivery_id
        store.save_ledger(turn_id, ledger)
        store.detach_processing(turn_id, delivery_id, "stale")


def _preflight(store: StateStore, turn_id: str) -> dict:
    """The ledger as it stands before the pre-heartbeat.

    A stored terminal, or the inflight record of a terminal whose response was lost, must reach the
    idempotent event replay without a heartbeat: the server answers a heartbeat for a finished turn
    with 409, so a beat first would turn a successful retry into a false "stale".
    """
    try:
        return store.load_ledger(turn_id)
    except StateError:
        return {}


def _run_event(
    cfg: Config,
    store: StateStore,
    turn_id: str,
    delivery_id: str,
    kind: str,
    content_hash: str,
    extra: dict,
    request,
    event_id: str | None = None,
    final: bool = False,
    validate=None,
    heartbeat_before: bool = False,
) -> dict:
    if final or heartbeat_before:
        pre = _preflight(store, turn_id)
        if not pre.get("terminal"):
            # The lease must outlive an upload or a terminal retry: a loop that died (or was never
            # started because claim's spawn failed) is restarted here, and this is idempotent.
            try:
                _spawn_heartbeat_loop(turn_id, delivery_id)
            except Exception:
                trace("heartbeat_spawn_failed", turn=turn_id[:8])
            if not (final and pre.get("inflight")):
                try:
                    heartbeat = _do_heartbeat(cfg, store, turn_id, delivery_id)
                except StaleDelivery:
                    _stop_heartbeat(turn_id)
                    _mark_stale(store, turn_id, delivery_id)
                    raise
                if heartbeat["cancelled"]:
                    _stop_heartbeat(turn_id)
                    raise Cancelled()
    with store.turn_guard(turn_id, blocking=True) as acquired:
        if not acquired:
            raise StateError("turn is locked by another process")
        ledger = store.load_ledger(turn_id)
        if ledger.get("staleDeliveryId") == delivery_id:
            raise StaleDelivery()
        if ledger.get("deliveryId") and ledger["deliveryId"] != delivery_id:
            raise StaleDelivery()
        processing = store.read_processing(turn_id)
        if processing and processing.get("deliveryId") != delivery_id:
            raise StaleDelivery()
        if store.is_cancelled(turn_id):
            _stop_heartbeat(turn_id)
            raise Cancelled()
        terminal = ledger.get("terminal")
        if terminal:
            if terminal == kind and kind in TERMINAL_KINDS:
                _stop_heartbeat(turn_id)
                known = ledger["events"].get(ledger.get("terminalEventId") or "", {})
                return {
                    "duplicate": True,
                    "eventId": ledger.get("terminalEventId"),
                    "seq": known.get("seq"),
                }
            raise StateConflict("turn is already terminal")
        if kind == "completed" and not any(item.get("type") == "text" for item in ledger["events"].values()):
            raise PermanentError("completed_requires_text")
        if validate is not None:
            validate(ledger)
        event_id, seq, state = _allocate(ledger, kind, content_hash, event_id, extra)
        store.save_ledger(turn_id, ledger)
        if state == "confirmed":
            return {"duplicate": True, "eventId": event_id, "seq": seq}
        try:
            if kind == "file":
                # An upload is not cheap to repeat: the caller retries it on exit 7 as before.
                response = request(event_id, seq)
            else:
                # Same eventId and seq each time: the server answers a repeat as a duplicate, never a second event.
                response = _quick(lambda: request(event_id, seq), kind, turn_id)
            checked = validate_event_response(response, event_id, seq)
        except RetriableError as exc:
            inflight = ledger.get("inflight") or {}
            attempts = int(inflight.get("attempts", 0)) + 1
            inflight["attempts"] = attempts
            inflight["lastError"] = exc.kind
            ledger["inflight"] = inflight
            store.save_ledger(turn_id, ledger)
            delay = exc.retry_ms or min(60000, 1000 * (2 ** min(attempts, 6)))
            raise RetriableError(exc.kind, delay) from None
        except StaleDelivery:
            ledger["inflight"] = None
            ledger["staleDeliveryId"] = delivery_id
            store.save_ledger(turn_id, ledger)
            store.detach_processing(turn_id, delivery_id, "stale")
            _stop_heartbeat(turn_id)
            raise
        except (PermanentError, AuthError, ContractError, StateConflict):
            ledger["inflight"] = None
            store.save_ledger(turn_id, ledger)
            raise

        record = {"seq": seq, "type": kind, "sha256": content_hash}
        for key in ("itemId", "name", "mime", "fileKind"):
            if extra.get(key) is not None:
                record[key] = extra[key]
        if kind == "file":
            record["uploadId"] = checked["uploadId"]
        ledger["events"][event_id] = record
        ledger["nextSeq"] = max(int(ledger["nextSeq"]), seq + 1)
        ledger["inflight"] = None
        if kind == "delta":
            item = ledger["items"].setdefault(extra["itemId"], {"deltas": []})
            item.setdefault("deltas", []).append(extra["text"])
        elif kind == "text":
            ledger["items"].pop(extra.get("itemId"), None)
        if kind in TERMINAL_KINDS:
            ledger["terminal"] = kind
            ledger["terminalEventId"] = event_id
        store.save_ledger(turn_id, ledger)
        if kind in TERMINAL_KINDS:
            store.detach_processing(turn_id, delivery_id, "done")
            # Only now is the turn finished on the server: stopping any earlier would let a retriable
            # failure drop a lease the worker still needs for its retry.
            _stop_heartbeat(turn_id)
        return {"duplicate": checked["duplicate"], "eventId": event_id, "seq": seq}


def cmd_send_text(args, cfg: Config, store: StateStore) -> int:
    turn_id = require_id(args.turn, "turnId", UsageError)
    delivery_id = require_id(args.delivery, "deliveryId", UsageError)
    if args.delta and args.final:
        raise UsageError("--delta and --final are mutually exclusive")
    kind = "delta" if args.delta else "text"
    text = args.text if args.text is not None else _read_text(args.text_file)
    if len(text.encode("utf-8")) > MAX_TEXT:
        raise PermanentError("too_large")
    item_id = require_id(args.item_id or f"{turn_id}-main", "itemId", UsageError)
    if (
        kind == "text"
        and not args.event_id
        and len(text.encode("utf-8")) > TEXT_PART_BYTES
        and not _item_has_deltas(store, turn_id, item_id)
    ):
        return _send_text_parts(args, cfg, store, turn_id, delivery_id, item_id, text)
    content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    extra = {"itemId": item_id, "text": text}

    def validate(ledger):
        if kind != "text":
            return
        deltas = (ledger.get("items", {}).get(item_id) or {}).get("deltas") or []
        if deltas and text != "".join(deltas):
            raise PermanentError("delta_mismatch")

    def request(event_id: str, seq: int) -> dict:
        payload = {
            "schemaVersion": SCHEMA_VERSION,
            "deliveryId": delivery_id,
            "eventId": event_id,
            "seq": seq,
            "type": kind,
            "itemId": item_id,
            "text": text,
        }
        return _post_json(cfg, _event_subpath(turn_id), payload, timeout=30.0)

    result = _run_event(
        cfg,
        store,
        turn_id,
        delivery_id,
        kind,
        content_hash,
        extra,
        request,
        event_id=args.event_id,
        final=args.final,
        validate=validate,
    )
    emit(status="ok", duplicate=result["duplicate"], eventId=result["eventId"], seq=result["seq"])
    return EXIT_OK


def _json_cost(ch: str) -> int:
    """Bytes one character takes inside a JSON string as _post_json writes it (ensure_ascii=False)."""
    if ch in '"\\\n\r\t\b\f':
        return 2
    if ord(ch) < 0x20:
        return 6
    return len(ch.encode("utf-8"))


def split_text(text: str, limit: int = TEXT_PART_BYTES) -> list[str]:
    """Splits text into ordered parts whose JSON-escaped UTF-8 size is at most `limit`, never inside a character.

    A part ends after the last newline in its window when that keeps at least half the window, otherwise after
    the last space on the same terms, otherwise at the limit; it never separates a CR from its LF. Joining the
    parts gives back the text exactly.
    """
    parts: list[str] = []
    start = 0
    size = 0
    last_nl = -1
    last_sp = -1
    i = 0
    n = len(text)
    while i < n:
        cost = _json_cost(text[i])
        if size + cost > limit and i > start:
            half = (i - start) // 2
            cut = i
            if last_nl >= start and last_nl + 1 - start >= half:
                cut = last_nl + 1
            elif last_sp >= start and last_sp + 1 - start >= half:
                cut = last_sp + 1
            if cut - 1 > start and text[cut - 1] == "\r" and cut < n and text[cut] == "\n":
                cut -= 1
            parts.append(text[start:cut])
            start = cut
            size = sum(_json_cost(ch) for ch in text[start:i])
            continue
        size += cost
        if text[i] == "\n":
            last_nl = i
        elif text[i] == " ":
            last_sp = i
        i += 1
    if start < n or not parts:
        parts.append(text[start:])
    return parts


def _item_has_deltas(store: StateStore, turn_id: str, item_id: str) -> bool:
    """An item that already streamed deltas must get its final text in one event equal to them, so it is not split."""
    try:
        ledger = store.load_ledger(turn_id)
    except StateError:
        return False
    return bool((ledger.get("items", {}).get(item_id) or {}).get("deltas"))


def _part_item_id(item_id: str, index: int) -> str:
    if index == 0:
        return item_id
    suffix = f"-p{index + 1}"
    return require_id(item_id[: 128 - len(suffix)] + suffix, "itemId", UsageError)


def _send_text_parts(args, cfg: Config, store: StateStore, turn_id: str, delivery_id: str, item_id: str, text: str) -> int:
    """A long final text goes out as several text events, one item each, in order.

    The server and OMB accept any number of text items per turn; each part becomes its own reply bubble.
    Rerunning the same command resumes after the last part the ledger already confirmed.
    """
    ledger = store.load_ledger(turn_id)
    parts = split_text(text)
    duplicate = True
    last = {"eventId": None, "seq": None}
    for index, part in enumerate(parts):
        part_item = _part_item_id(item_id, index)
        part_hash = hashlib.sha256(part.encode("utf-8")).hexdigest()
        known = next(
            (
                (event_id, record)
                for event_id, record in ledger["events"].items()
                if record.get("type") == "text" and record.get("itemId") == part_item and record.get("sha256") == part_hash
            ),
            None,
        )
        if known is not None:
            last = {"eventId": known[0], "seq": known[1].get("seq")}
            continue

        def request(event_id: str, seq: int, part=part, part_item=part_item) -> dict:
            payload = {
                "schemaVersion": SCHEMA_VERSION,
                "deliveryId": delivery_id,
                "eventId": event_id,
                "seq": seq,
                "type": "text",
                "itemId": part_item,
                "text": part,
            }
            return _post_json(cfg, _event_subpath(turn_id), payload, timeout=30.0)

        result = _run_event(
            cfg,
            store,
            turn_id,
            delivery_id,
            "text",
            part_hash,
            {"itemId": part_item, "text": part},
            request,
            final=args.final and index == 0,
        )
        duplicate = duplicate and result["duplicate"]
        last = result
        ledger = store.load_ledger(turn_id)
    emit(status="ok", duplicate=duplicate, eventId=last["eventId"], seq=last["seq"], parts=len(parts))
    return EXIT_OK


def cmd_send_file(args, cfg: Config, store: StateStore) -> int:
    turn_id = require_id(args.turn, "turnId", UsageError)
    delivery_id = require_id(args.delivery, "deliveryId", UsageError)
    name = require_name(args.name or Path(args.path).name)
    mime = require_mime(args.mime or mimetypes.guess_type(name)[0] or "application/octet-stream")
    size, digest = _inspect_file(args.path, name, mime)
    file_kind = "image" if mime.startswith("image/") else "file"
    extra = {"name": name, "mime": mime, "fileKind": file_kind, "path": args.path, "size": size}

    def request(event_id: str, seq: int) -> dict:
        with open(args.path, "rb") as handle:
            body = _FileBody(handle, size)
            return _http_request(
                cfg,
                "POST",
                _file_subpath(turn_id, delivery_id, event_id, seq, name),
                body=body,
                headers={"Content-Type": mime, "Content-Length": str(size)},
                timeout=120.0,
            )

    result = _run_event(
        cfg,
        store,
        turn_id,
        delivery_id,
        "file",
        digest,
        extra,
        request,
        event_id=args.event_id,
        final=False,
        heartbeat_before=True,
    )
    emit(status="ok", duplicate=result["duplicate"], eventId=result["eventId"], seq=result["seq"])
    return EXIT_OK


def cmd_complete(args, cfg: Config, store: StateStore) -> int:
    turn_id = require_id(args.turn, "turnId", UsageError)
    delivery_id = require_id(args.delivery, "deliveryId", UsageError)
    content_hash = hashlib.sha256(b"completed").hexdigest()

    def request(event_id: str, seq: int) -> dict:
        payload = {
            "schemaVersion": SCHEMA_VERSION,
            "deliveryId": delivery_id,
            "eventId": event_id,
            "seq": seq,
            "type": "completed",
        }
        return _post_json(cfg, _event_subpath(turn_id), payload, timeout=30.0)

    result = _run_event(
        cfg,
        store,
        turn_id,
        delivery_id,
        "completed",
        content_hash,
        {},
        request,
        event_id=args.event_id,
        final=True,
    )
    emit(status="ok", duplicate=result["duplicate"], eventId=result["eventId"], seq=result["seq"])
    return EXIT_OK


def cmd_fail(args, cfg: Config, store: StateStore) -> int:
    turn_id = require_id(args.turn, "turnId", UsageError)
    delivery_id = require_id(args.delivery, "deliveryId", UsageError)
    text = _read_text(args.text_file) if args.text_file else ""
    if len(text.encode("utf-8")) > MAX_TEXT:
        raise PermanentError("too_large")
    content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    extra = {"text": text} if text else {}

    def request(event_id: str, seq: int) -> dict:
        payload = {
            "schemaVersion": SCHEMA_VERSION,
            "deliveryId": delivery_id,
            "eventId": event_id,
            "seq": seq,
            "type": "failed",
        }
        if text:
            payload["text"] = text
        return _post_json(cfg, _event_subpath(turn_id), payload, timeout=30.0)

    result = _run_event(
        cfg,
        store,
        turn_id,
        delivery_id,
        "failed",
        content_hash,
        extra,
        request,
        event_id=args.event_id,
        final=True,
    )
    emit(status="ok", duplicate=result["duplicate"], eventId=result["eventId"], seq=result["seq"])
    return EXIT_OK


def cmd_retry_inflight(args, cfg: Config, store: StateStore) -> int:
    turn_id = require_id(args.turn, "turnId", UsageError)
    delivery_id = require_id(args.delivery, "deliveryId", UsageError)
    with store.turn_guard(turn_id, blocking=True) as acquired:
        if not acquired:
            raise StateError("turn is locked by another process")
        ledger = store.load_ledger(turn_id)
        if ledger.get("deliveryId") and ledger["deliveryId"] != delivery_id:
            raise StaleDelivery()
        if store.is_cancelled(turn_id):
            raise Cancelled()
        inflight = ledger.get("inflight")
        if not inflight:
            emit(status="none")
            return EXIT_OK
        kind = inflight["type"]
        event_id = inflight["eventId"]
        seq = inflight["seq"]
        try:
            if kind == "file":
                name = require_name(inflight.get("name"))
                mime = require_mime(inflight.get("mime"))
                path = inflight.get("path")
                size, digest = _inspect_file(path, name, mime)
                if digest != inflight.get("sha256"):
                    raise StateConflict("in-flight file changed")
                with open(path, "rb") as handle:
                    response = _http_request(
                        cfg,
                        "POST",
                        _file_subpath(turn_id, delivery_id, event_id, seq, name),
                        body=_FileBody(handle, size),
                        headers={"Content-Type": mime, "Content-Length": str(size)},
                        timeout=120.0,
                    )
            else:
                payload = {
                    "schemaVersion": SCHEMA_VERSION,
                    "deliveryId": delivery_id,
                    "eventId": event_id,
                    "seq": seq,
                    "type": kind,
                }
                if inflight.get("itemId"):
                    payload["itemId"] = inflight["itemId"]
                if "text" in inflight:
                    payload["text"] = inflight["text"]
                response = _quick(
                    lambda: _post_json(cfg, _event_subpath(turn_id), payload, timeout=30.0), "retry_" + kind, turn_id
                )
            checked = validate_event_response(response, event_id, seq)
        except RetriableError as exc:
            inflight["attempts"] = int(inflight.get("attempts", 0)) + 1
            inflight["lastError"] = exc.kind
            ledger["inflight"] = inflight
            store.save_ledger(turn_id, ledger)
            delay = exc.retry_ms or min(60000, 1000 * (2 ** min(inflight["attempts"], 6)))
            raise RetriableError(exc.kind, delay) from None
        except StaleDelivery:
            ledger["inflight"] = None
            ledger["staleDeliveryId"] = delivery_id
            store.save_ledger(turn_id, ledger)
            store.detach_processing(turn_id, delivery_id, "stale")
            _stop_heartbeat(turn_id)
            raise
        except (PermanentError, AuthError, ContractError, StateConflict):
            ledger["inflight"] = None
            store.save_ledger(turn_id, ledger)
            raise
        record = {"seq": seq, "type": kind, "sha256": inflight.get("sha256")}
        for key in ("itemId", "name", "mime", "fileKind"):
            if inflight.get(key) is not None:
                record[key] = inflight[key]
        if kind == "file":
            record["uploadId"] = checked["uploadId"]
        ledger["events"][event_id] = record
        ledger["nextSeq"] = max(int(ledger["nextSeq"]), seq + 1)
        ledger["inflight"] = None
        if kind == "delta":
            item = ledger["items"].setdefault(inflight["itemId"], {"deltas": []})
            item.setdefault("deltas", []).append(inflight.get("text", ""))
        elif kind == "text":
            ledger["items"].pop(inflight.get("itemId"), None)
        if kind in TERMINAL_KINDS:
            ledger["terminal"] = kind
            ledger["terminalEventId"] = event_id
        store.save_ledger(turn_id, ledger)
        if kind in TERMINAL_KINDS:
            store.detach_processing(turn_id, delivery_id, "done")
    emit(status="ok", duplicate=checked["duplicate"], eventId=event_id, seq=seq)
    return EXIT_OK


def cmd_finish(args, cfg: Config, store: StateStore) -> int:
    turn_id = require_id(args.turn, "turnId", UsageError)
    delivery_id = require_id(args.delivery, "deliveryId", UsageError)
    with store.turn_guard(turn_id, blocking=True) as acquired:
        if not acquired:
            raise StateError("turn is locked by another process")
        ledger = store.load_ledger(turn_id)
        processing = store.read_processing(turn_id)
        if processing and processing.get("deliveryId") != delivery_id:
            raise StaleDelivery()
        if args.reason == "cancelled":
            ledger["terminal"] = "cancelled"
            ledger["terminalEventId"] = None
            store.save_ledger(turn_id, ledger)
        sub = {"cancelled": "cancelled", "stale": "stale", "abandoned": "stale"}[args.reason]
        store.detach_processing(turn_id, delivery_id, sub)
    emit(status="ok")
    return EXIT_OK


def cmd_recover(args, cfg: Config, store: StateStore) -> int:
    recovered = quarantined = pruned = 0
    now = time.time()

    for pending in store.list_pending():
        try:
            record = store.read_json(pending)
            require_id(record.get("turnId"), "pending turnId")
            require_id(record.get("deliveryId"), "pending deliveryId")
        except (StateError, ContractError):
            if store.quarantine(pending):
                quarantined += 1

    for processing in store.list_processing():
        try:
            record = store.read_json(processing)
            turn_id = require_id(record.get("turnId"), "processing turnId")
            require_id(record.get("deliveryId"), "processing deliveryId")
        except (StateError, ContractError):
            if store.quarantine(processing):
                quarantined += 1
            continue
        with store.turn_guard(turn_id, blocking=False) as acquired:
            if not acquired or not processing.exists():
                continue
            try:
                record = store.read_json(processing)
            except StateError:
                continue
            claimed = _float_or_zero(record.get("claimedAtEpoch"))
            heartbeat = _float_or_zero(record.get("heartbeatEpoch"))
            try:
                mtime = processing.stat().st_mtime
            except OSError:
                continue
            last = max(claimed, heartbeat, mtime)
            if now - last < args.stale_seconds:
                continue
            pending = store.path("pending", turn_id)
            if pending.exists():
                if store.quarantine(processing, "stale"):
                    recovered += 1
            else:
                try:
                    os.link(processing, pending)
                except FileExistsError:
                    if store.quarantine(processing, "stale"):
                        recovered += 1
                    continue
                except OSError:
                    continue
                try:
                    os.unlink(processing)
                except FileNotFoundError:
                    pass
                fsync_dir(processing.parent)
                fsync_dir(pending.parent)
                recovered += 1

    for ledger_path in store.list_files("ledger"):
        try:
            store.read_json(ledger_path)
        except StateError:
            if store.quarantine(ledger_path):
                quarantined += 1

    cutoff = now - 7 * 24 * 3600
    for sub in ("done", "stale", "corrupt", "cancelled"):
        for path in store.list_artifacts(sub):
            try:
                if path.stat().st_mtime < cutoff:
                    store.remove(path)
                    pruned += 1
            except OSError:
                continue
    for ledger_path in store.list_files("ledger"):
        try:
            if ledger_path.stat().st_mtime < cutoff:
                obj = store.read_json(ledger_path)
                if obj.get("terminal"):
                    store.remove(ledger_path)
                    pruned += 1
        except (OSError, StateError):
            continue

    emit(recovered=recovered, quarantined=quarantined, pruned=pruned)
    return EXIT_OK


def _float_or_zero(value) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="omb_relay.py", description="OpenMausBot Muse Relay data-plane client")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("state-dir", help="print the resolved state directory")
    sub.add_parser("pending-count", help="print the number of pending turns")
    sub.add_parser("claim", help="atomically claim one pending turn")

    poll = sub.add_parser("poll", help="run one long poll and persist the result")
    poll.add_argument("--wait-ms", type=int, default=20000)
    poll.add_argument("--limit", type=int, default=1)

    heartbeat = sub.add_parser("heartbeat", help="renew the lease or report online")
    heartbeat.add_argument("--turn")
    heartbeat.add_argument("--delivery")

    loop = sub.add_parser("heartbeat-loop", help="background lease keeper for one claimed turn")
    loop.add_argument("--turn", required=True)
    loop.add_argument("--delivery", required=True)

    stop = sub.add_parser("heartbeat-stop", help="stop the background heartbeat loop for a turn")
    stop.add_argument("--turn", required=True)

    text = sub.add_parser("send-text", help="send a delta or final text event")
    text.add_argument("--turn", required=True)
    text.add_argument("--delivery", required=True)
    text.add_argument("--text")
    text.add_argument("--text-file", default="-")
    text.add_argument("--item-id")
    text.add_argument("--delta", action="store_true")
    text.add_argument("--final", action="store_true")
    text.add_argument("--event-id")

    upload = sub.add_parser("send-file", help="upload one file as raw bytes")
    upload.add_argument("--turn", required=True)
    upload.add_argument("--delivery", required=True)
    upload.add_argument("--path", required=True)
    upload.add_argument("--name")
    upload.add_argument("--mime")
    upload.add_argument("--event-id")

    complete = sub.add_parser("complete", help="send the completed terminal event")
    complete.add_argument("--turn", required=True)
    complete.add_argument("--delivery", required=True)
    complete.add_argument("--event-id")

    failed = sub.add_parser("fail", help="send the failed terminal event")
    failed.add_argument("--turn", required=True)
    failed.add_argument("--delivery", required=True)
    failed.add_argument("--text-file")
    failed.add_argument("--event-id")

    retry = sub.add_parser("retry-inflight", help="retry the unconfirmed event with its original ID")
    retry.add_argument("--turn", required=True)
    retry.add_argument("--delivery", required=True)

    finish = sub.add_parser("finish", help="clean up a processing turn")
    finish.add_argument("--turn", required=True)
    finish.add_argument("--delivery", required=True)
    finish.add_argument("--reason", required=True, choices=("cancelled", "stale", "abandoned"))

    recover = sub.add_parser("recover", help="recycle stale claims and quarantine corrupt state")
    # The server lease is 120 s: a claim silent for longer is already dead there.
    recover.add_argument("--stale-seconds", type=int, default=180)

    sub.add_parser("keepalive", help="drop pending deliveries no worker claimed before OMB redelivers them")

    return parser


def main(argv=None) -> int:
    signal.signal(signal.SIGTERM, _sigterm)
    args = build_parser().parse_args(argv)
    if args.command == "poll":
        if not (0 <= args.wait_ms <= 25000):
            print("ERROR usage: --wait-ms must be 0..25000", file=sys.stderr)
            return EXIT_USAGE
        if not (1 <= args.limit <= 4):
            print("ERROR usage: --limit must be 1..4", file=sys.stderr)
            return EXIT_USAGE
    if args.command == "recover" and not (60 <= args.stale_seconds <= 86400):
        print("ERROR usage: --stale-seconds must be 60..86400", file=sys.stderr)
        return EXIT_USAGE
    try:
        if args.command == "state-dir":
            print(resolve_state_dir())
            return EXIT_OK
        if args.command == "pending-count":
            return cmd_pending_count(args)
        if args.command == "claim":
            return cmd_claim(args)
        if args.command == "poll":
            return cmd_poll(args)
        cfg = load_config()
        store = StateStore(cfg.state_dir)
        global _TRACE_DIR
        _TRACE_DIR = store.root
        if args.command == "heartbeat":
            return cmd_heartbeat(args, cfg, store)
        if args.command == "heartbeat-loop":
            return cmd_heartbeat_loop(args, cfg, store)
        if args.command == "heartbeat-stop":
            return cmd_heartbeat_stop(args)
        if args.command == "send-text":
            return cmd_send_text(args, cfg, store)
        if args.command == "send-file":
            return cmd_send_file(args, cfg, store)
        if args.command == "complete":
            return cmd_complete(args, cfg, store)
        if args.command == "fail":
            return cmd_fail(args, cfg, store)
        if args.command == "retry-inflight":
            return cmd_retry_inflight(args, cfg, store)
        if args.command == "finish":
            return cmd_finish(args, cfg, store)
        if args.command == "recover":
            return cmd_recover(args, cfg, store)
        if args.command == "keepalive":
            return cmd_keepalive(args, cfg, store)
        raise UsageError("unknown command")
    except Terminated:
        return EXIT_TERMINATED
    except ConfigError as exc:
        print(f"ERROR config: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    except UsageError as exc:
        print(f"ERROR usage: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except StateError as exc:
        print(f"ERROR state: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    except StaleDelivery:
        emit(status="stale")
        return EXIT_STALE
    except Cancelled:
        emit(status="cancelled")
        return EXIT_CANCELLED
    except StateConflict as exc:
        print(f"ERROR conflict: {exc}", file=sys.stderr)
        return EXIT_CONFLICT
    except AuthError as exc:
        emit(status="rejected", reason=exc.kind)
        return EXIT_PERMANENT
    except PermanentError as exc:
        emit(status="rejected", reason=exc.kind)
        return EXIT_PERMANENT
    except RetriableError as exc:
        emit(status="retry", reason=exc.kind, retry_ms=exc.retry_ms)
        return EXIT_RETRY
    except ContractError:
        emit(status="rejected", reason="invalid_response")
        return EXIT_PERMANENT
    except KeyboardInterrupt:
        return 130
    except Exception:
        print("ERROR internal: unexpected failure", file=sys.stderr)
        return EXIT_CONFIG


if __name__ == "__main__":
    sys.exit(main())
