"""Opt-in single real Linux task using the official CLI, never auth wrappers."""
import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import signal
import struct
import sys
import tempfile
import time
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
import agent_hub as hub
from availability_store import local_availability


def png_blue():
    def chunk(kind, data):
        return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!IIBBBBB", 64, 64, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress((b"\0" + b"\0\0\xff" * 64) * 64)) + chunk(b"IEND", b"")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--entry", type=Path, required=True)
    parser.add_argument("--run", action="store_true", required=True)
    args = parser.parse_args()
    if sys.platform != "linux" or not args.entry.is_file() or args.entry.name != "codebuddy":
        raise SystemExit("An actual Linux official package/bin/codebuddy entry is required")
    state = Path(tempfile.mkdtemp(prefix="agenthub-rootcause-hub-"))
    state.chmod(0o700)
    hub.STATE = state / "state"
    hub.RESULTS_DIR = str(state / "results")
    hub.AGENTS_JSON = state / "agents.json"
    profile = {"cli": ["node", str(args.entry), "-p", "{task}", "--tools", "Read", "--allowedTools", "Read", "--permission-mode", "acceptEdits",
                       "--strict-mcp-config", "--mcp-config", "{}", "--no-session-persistence"],
               "async_default": True, "model_arg": "--model", "models": {"default": "deepseek-v4.1-flash"},
               "env": {"CODEBUDDY_CONFIG_DIR": str(Path.home() / ".codebuddy-cn"), "CODEBUDDY_INTERNET_ENVIRONMENT": "internal", "CODEBUDDY_API_KEY_DISABLED": "1", "CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS": "1"}}
    for key in os.environ:
        if key.startswith(("CODEBUDDY_", "ANTHROPIC_", "OPENAI_")) and any(part in key for part in ("BASE", "URL", "PROVIDER", "API_KEY", "AUTH_TOKEN")):
            profile["env"][key] = ""
    hub.AGENTS_JSON.write_text(json.dumps({"agents": {"codebuddy-cn": profile}}))
    identity = "HUB_STANDARD_" + secrets.token_hex(5).upper()
    nonce = "HUB_SECRET_" + secrets.token_hex(5).upper()
    attachments = [{"name": "secret.txt", "mime_type": "text/plain", "data_base64": base64.b64encode(("Hidden nonce: " + nonce).encode()).decode()},
                   {"name": "blue.png", "mime_type": "image/png", "data_base64": base64.b64encode(png_blue()).decode()}]
    assert local_availability("codebuddy-cn", profile, "deepseek-v4.1-flash")["enabled"]
    began = time.monotonic()
    receipt = hub.tool_hub_dispatch_cli({"agent": "codebuddy-cn", "task": "Read the supplied image with Read, and read the file content in this message directly. No shell, no writes. Return exactly " + identity + "; image=<dominant color in English>; file=<hidden nonce>. Do not guess unread input.",
                                         "thinking": "off", "stream": False, "attachments": attachments, "cwd": str(state), "timeout_s": 60})
    import re
    match = re.search(r"codebuddy-cn-[a-f0-9]{10}", receipt)
    if not match:
        raise RuntimeError("No execution ref returned")
    ref = match.group()
    deadline = time.monotonic() + 65
    while time.monotonic() < deadline:
        result = json.loads(hub.tool_hub_result_json({"ref": ref}))
        if result["status"] in ("completed", "error", "timeout"):
            break
        time.sleep(.1)
    else:
        hub._save_result(ref, status="timeout", text="Outer probe deadline; preserve original ref")
        time.sleep(.3)
        result = json.loads(hub.tool_hub_result_json({"ref": ref}))
    for _ in range(50):
        if not (Path(hub.RESULTS_DIR) / (ref + ".task")).exists():
            break
        time.sleep(.1)
    answer = result.get("text", "")
    report = {"kind": "real-linux-hub-codebuddy-standard-stdin-file-read-image", "generation_calls": 1, "wrapper_used": False, "credentials_copied": False,
              "read_permissions": ["--tools", "Read", "--allowedTools", "Read", "--permission-mode", "acceptEdits"], "agent_mode": "standard",
              "file_transport": "official-stdin-stream-json", "image_transport": "Read-in-owned-staging", "thinking": "off", "stream": False,
              "ref": ref, "status": result["status"], "model": result.get("model"), "usage": result.get("usage"), "duration_s": round(time.monotonic() - began, 3),
              "image_verified": "blue" in answer.lower(), "hidden_nonce_verified": nonce in answer, "marker_verified": identity in answer,
              "answer": answer[:1500], "taskfile_cleaned": not (Path(hub.RESULTS_DIR) / (ref + ".task")).exists()}
    report["verified"] = report["status"] == "completed" and all(report[key] for key in ("image_verified", "hidden_nonce_verified", "marker_verified"))
    (state / "report.json").write_text(json.dumps(report))
    print(json.dumps(report))
    return 0 if report["verified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
