#!/usr/bin/env python3
"""Actual task matrix client; fixtures and runtime configuration stay outside repo.

Run on Linux against an isolated Hub or on Windows through an existing SSH alias.
The reports distinguish preflight rejection, blocked authentication, and verified
answers. Each cell is submitted once and uncertain tasks retain their reference.
"""
import argparse
import concurrent.futures
import hashlib
import itertools
import json
import os
from pathlib import Path
import queue
import re
import secrets
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
from command_runtime import atomic_write_json, spawn_owned, terminate_owned
from remote_worker_probe import safe_config, clean, port
from remote_platform_probe import ssh, run, archive, redacted

WORKERS = ("codebuddy", "codebuddy-cn", "antigravity", "mimocode", "github-copilot", "minimaxcode", "zcode", "traecode")
MODELS = {"codebuddy": "deepseek-v4.1-flash", "codebuddy-cn": "deepseek-v4.1-flash",
          "mimocode": "xiaomi/mimo-v2.6-flash", "minimaxcode": "MiniMax-M3.1-Flash-Preview"}


def png_blue():
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    pixels = b"".join(b"\0" + b"\0\0\xff" * 64 for _ in range(64))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 64, 64, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")


class Client:
    def __init__(self, env):
        self.proc = spawn_owned([shutil.which("node"), str(ROOT / "mcp/server.mjs")], cwd=ROOT, env=env,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.lock = threading.Lock()
        self.next_id = 0
        self.pending = {}
        self.events = {}
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        try:
            for line in self.proc.stdout:
                message = json.loads(line)
                with self.lock:
                    target = self.pending.get(message.get("id"))
                    params = message.get("params", {})
                    events = self.events.get(params.get("progressToken"))
                    if message.get("method") == "notifications/progress" and events is not None:
                        events.append({"at": time.monotonic(), "characters": len(params.get("message", ""))})
                if target:
                    target.put(message)
        except (OSError, ValueError):
            pass

    def call(self, method, params=None, timeout=8, token=None):
        response = queue.Queue()
        with self.lock:
            self.next_id += 1
            identity = self.next_id
            self.pending[identity] = response
            if token is not None:
                self.events[token] = []
            request = {"jsonrpc": "2.0", "id": identity, "method": method}
            if params is not None:
                request["params"] = params
            self.proc.stdin.write((json.dumps(request) + "\n").encode())
            self.proc.stdin.flush()
        try:
            return response.get(timeout=timeout)
        except queue.Empty:
            return {"error": {"message": "MCP response deadline; task acceptance unknown, no redispatch"}}
        finally:
            with self.lock:
                self.pending.pop(identity, None)

    def task(self, arguments, token):
        value = self.call("tools/call", {"name": "hub_ask", "arguments": arguments,
                                         "_meta": {"progressToken": token}}, timeout=100, token=token)
        if "error" in value:
            return {"status": "unknown", "answer": value["error"]["message"], "ref": ""}
        try:
            return json.loads(value["result"]["content"][0]["text"])
        except (KeyError, IndexError, ValueError):
            return {"status": "unknown", "answer": "Invalid MCP response; no redispatch", "ref": ""}

    def close(self):
        terminate_owned(self.proc)
        self.proc.stdin.close()
        self.proc.stdout.close()
        self.reader.join(timeout=2)


def matrix(state, report_path, kind, env, remote_cwd, workers=WORKERS, case_filter=None):
    state.mkdir(parents=True, exist_ok=True)
    fixture = state / "fixtures"
    fixture.mkdir(exist_ok=True)
    client = Client(env)
    result = {"kind": kind, "client_system": sys.platform, "worker_system": "linux", "real_vendor_requests": True,
              "windows_credentials_copied": False, "old_deployment_modified": False, "cells": []}
    lock = threading.Lock()
    started = time.monotonic()
    try:
        initialized = client.call("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                                                  "clientInfo": {"name": "actual-platform-matrix", "version": "1"}})
        if "error" in initialized:
            raise RuntimeError("MCP initialize failed")
        capabilities = client.call("tools/call", {"name": "hub_capabilities", "arguments": {}})
        result["capability_response"] = redacted(capabilities)

        def worker_cases(worker):
            blocked = None
            for thinking, stream, image, file in itertools.product(("off", "on"), (False, True), (False, True), (False, True)):
                if case_filter is not None and not case_filter(thinking, stream, image, file):
                    continue
                case_id = worker + "-" + thinking + "-" + str(int(stream)) + str(int(image)) + str(int(file))
                cell = {"worker": worker, "thinking": thinking, "stream": stream, "image": image, "file": file,
                        "case_id": case_id, "dispatch_count": 0, "generation_verified": False}
                if blocked:
                    cell.update(outcome="not_executed_auth_blocked", reason=blocked)
                elif time.monotonic() - started > 720:
                    cell.update(outcome="not_executed_budget", reason="Matrix client bounded total time exceeded")
                else:
                    nonce = "FILE_" + secrets.token_hex(5).upper()
                    paths = []
                    if image:
                        path = fixture / (case_id + ".png")
                        path.write_bytes(png_blue())
                        paths.append(str(path.resolve()))
                    if file:
                        path = fixture / (case_id + ".txt")
                        path.write_text("Verification nonce: " + nonce + "\n", encoding="utf-8")
                        paths.append(str(path.resolve()))
                    prompt = ("Read only the supplied attachments if present. Do not execute shell commands, write files, "
                              "or change settings. Reply with a first line containing case=" + case_id + "; image=" +
                              ("the image's dominant color in English" if image else "NO_IMAGE") + "; file=" +
                              ("the exact nonce from the text file" if file else "NO_FILE") +
                              "; product=the result of 123*47. Then explain the arithmetic in 50 to 80 words.")
                    arguments = {"worker": worker, "task": prompt, "timeout_s": 90, "thinking": thinking,
                                 "stream": stream, "files": paths, "cwd": remote_cwd}
                    if worker in MODELS:
                        arguments["model"] = MODELS[worker]
                    before = time.monotonic()
                    reply = client.task(arguments, case_id)
                    after = time.monotonic()
                    answer = reply.get("answer", "")
                    events = client.events.get(case_id, [])
                    verified = (reply.get("status") == "completed" and case_id in answer and "5781" in answer and
                                (("blue" in answer.lower()) if image else "NO_IMAGE" in answer) and
                                ((nonce in answer) if file else "NO_FILE" in answer))
                    outcome = "verified" if verified else "completed_unverified" if reply.get("status") == "completed" else "preflight_rejected" if not reply.get("ref") and reply.get("status") == "failed" else "execution_failed" if reply.get("status") == "failed" else "uncertain"
                    cell.update(dispatch_count=1, generation_verified=verified, outcome=outcome, duration_s=round(after-before, 3),
                                final=json.loads(clean(json.dumps(reply))), progress_notifications=len(events),
                                progress_before_final=sum(event["at"] < after for event in events),
                                first_progress_s=round(events[0]["at"]-before, 3) if events else None,
                                stream_observed=bool(events), stream_off_no_notifications=(not stream and not events),
                                fixture_metadata=[{"name": Path(path).name, "bytes": Path(path).stat().st_size,
                                                   "sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest()} for path in paths])
                    if sys.platform == "linux" and reply.get("ref"):
                        stored_path = Path(env["HUB_RESULTS_DIR"]) / (reply["ref"] + ".json")
                        if stored_path.is_file():
                            stored = json.loads(stored_path.read_text())
                            cell["usage"] = stored.get("usage")
                            cell["runtime_exit_code"] = stored.get("exit_code")
                            reasoning = (stored.get("usage") or {}).get("reasoning_tokens")
                            cell["thinking_observed"] = (reasoning > 0 if thinking == "on" else reasoning == 0) if isinstance(reasoning, (int, float)) else None
                    if re.search(r"authentication required|invalid api key|not logged in|please.*login", answer, re.I) and reply.get("status") == "failed":
                        blocked = {"case_id": case_id, "status": reply.get("status"), "reason": "Existing Linux native authentication rejected"}
                with lock:
                    result["cells"].append(cell)
                    atomic_write_json(report_path, result)

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(worker_cases, worker) for worker in workers]
            for future in concurrent.futures.as_completed(futures):
                future.result()
        result["duration_s"] = round(time.monotonic()-started, 3)
        result["counts"] = {key: sum(cell["outcome"] == key for cell in result["cells"]) for key in sorted({cell["outcome"] for cell in result["cells"]})}
        atomic_write_json(report_path, result)
        return result
    finally:
        client.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True, action="store_true")
    parser.add_argument("--local", action="store_true", help="Linux native client against privately configured Hub URL in environment")
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--remote-cwd", required=True)
    args = parser.parse_args()
    result = matrix(args.state, args.report, "real-linux-native-client" if args.local else "windows-client-over-ssh-to-real-linux-workers",
                    os.environ.copy(), args.remote_cwd)
    print(json.dumps({"report": str(args.report), "counts": result["counts"], "duration_s": result["duration_s"]}))


if __name__ == "__main__":
    main()
