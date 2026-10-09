"""Native ConPTY/login integration, without changing existing vendor identities.

The default test uses only a synthetic Node TCP listener. Optional vendor
flows use separate config directories, capture a link, then cancel immediately.
Ephemeral auth links/codes and raw auth output are never written to the report.
"""
import argparse
import json
import os
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hub"))
from windows_pty import WindowsPty, owned_listener_port
from login_manager import LoginManager


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--mmx-entry")
    parser.add_argument("--mimo-entry")
    parser.add_argument("--report", type=Path)
    options = parser.parse_args()
    if os.name != "nt" or not options.node:
        raise SystemExit("Windows and Node.js are required")
    results = []
    base = Path(tempfile.mkdtemp(prefix="agenthub-login-smoke-"))
    script = ("const net=require('net'); const server=net.createServer();"
              "server.listen(0,()=>console.log(JSON.stringify({stdin:process.stdin.isTTY,"
              "stdout:process.stdout.isTTY,port:server.address().port,text:'终端测试'})));"
              "setTimeout(()=>{},30000);")
    process = WindowsPty([options.node, "-e", script], base, os.environ.copy())
    chunks = []
    stream = process.stdout
    def read():
        try:
            while chunk := stream.read(4096):
                chunks.append(chunk)
        except (OSError, ValueError):
            pass
    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    try:
        until = time.monotonic() + 5
        while b'"port":' not in b"".join(chunks) and time.monotonic() < until:
            time.sleep(0.03)
        output = b"".join(chunks).decode("utf-8", "replace")
        port = owned_listener_port(process)
        results.append({"name": "real_terminal_utf8_owned_listener", "passed":
                        '"stdin":true' in output and '"stdout":true' in output and
                        "终端测试" in output and bool(port) and f'"port":{port}' in output})
    finally:
        process.close()
        process.close()
        reader.join(timeout=3)
        results.append({"name": "cancel_closes_reader_and_is_idempotent", "passed": not reader.is_alive()})
    manager = LoginManager()
    try:
        for worker, entry, env in (
            ("minimaxcode", options.mmx_entry, {"MMX_CONFIG_DIR": str(base / "mmx")}),
            ("mimocode", options.mimo_entry, {"XDG_DATA_HOME": str(base / "data"),
               "XDG_CONFIG_HOME": str(base / "config"), "XDG_CACHE_HOME": str(base / "cache"),
               "XDG_STATE_HOME": str(base / "state")}),
        ):
            if not entry:
                continue
            profile = {"cli": [options.node, entry], "env": env}
            reply = manager.handle(worker, "start", profile)
            until = time.monotonic() + 20
            while reply["status"] == "preparing" and time.monotonic() < until:
                time.sleep(0.1)
                reply = manager.handle(worker, "status", profile)
            # An isolated directory must yield a new flow; an existing account
            # shortcut would not verify link capture or cancellation.
            link_received = reply["status"] == "awaiting_user" and bool(reply.get("login_url"))
            owned_process = manager.sessions.get(worker, {}).get("process")
            cancelled = manager.handle(worker, "cancel", profile)
            time.sleep(0.1)
            results.append({"name": worker + "_official_link_and_cancel", "passed": bool(
                link_received and cancelled["status"] == "cancelled" and "login_url" not in cancelled
                and owned_process is not None and owned_process.poll() is not None),
                "link_received": bool(link_received), "observed_status": reply["status"],
                "error": reply.get("error"), "instructions": reply.get("instructions"),
                "final_status": cancelled["status"]})
    finally:
        manager.close()
    report = {"kind": "native_windows_login_integration", "date": "2026-10-08",
              "tests": results, "passed": sum(item["passed"] for item in results),
              "failed": sum(not item["passed"] for item in results), "temporary_config": str(base)}
    if options.report:
        options.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=True))
    return 1 if report["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
