#!/usr/bin/env python3
"""Explicit, minimal real-worker Linux probe through the current Hub and MCP."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
from command_runtime import atomic_write_json, spawn_owned, terminate_owned
WORKERS = ("codebuddy", "codebuddy-cn", "antigravity", "mimocode", "github-copilot", "minimaxcode")
PROMPT = "Reply exactly AGENTHUB_LINUX_OK. Do not invoke tools, access files, or change settings."


def clean(text):
    text = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", text)
    text = re.sub(r"https?://[^\s<>\"']+", "<redacted-url>", text)
    text = re.sub(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])", "<redacted-ip>", text)
    text = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "<redacted-account>", text)
    text = re.sub(r"(?i)(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password)([\s\"':=]+)[^\s,\"'}]+", r"\1\2<redacted>", text)
    return text


def port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def safe_config(source, state, workers=WORKERS, mimo_model=None):
    original = json.loads(source.read_text())
    agents = copy.deepcopy(original.get("agents", original))
    for name in workers:
        if name not in agents:
            continue
        exe = agents[name]["cli"][0]
        if name.startswith("codebuddy"):
            cli = [exe, "-p", "--tools", "", "--strict-mcp-config", "--mcp-config", "{}", "--no-session-persistence"]
        elif name == "antigravity":
            binary = Path(exe).with_name("agy.bin")
            if not binary.is_file():
                raise RuntimeError("Official agy binary unavailable; proxy/permission wrapper is not used")
            cli = [str(binary), "--sandbox", "--mode", "plan", "--print-timeout", "55s", "--log-file", str(state / "agy.log"), "-p", "{task}"]
        elif name == "mimocode":
            cli = [exe, "run", "--pure", "--format", "json"]
        elif name == "github-copilot":
            cli = [exe, "--silent", "--disable-builtin-mcps", "--log-dir", str(state / "copilot-logs"), "--log-level", "error", "-p", "{task}"]
        else:
            cli = [exe, "text", "chat", "--message", "{task}", "--output", "text", "--timeout", "55", "--non-interactive"]
        agents[name]["cli"] = cli
        agents[name]["async_default"] = True
        if name == "mimocode" and mimo_model:
            agents[name].setdefault("models", {})["default"] = mimo_model
    return {"agents": {name: agents[name] for name in workers if name in agents}}


class MCP:
    def __init__(self, env):
        self.proc = spawn_owned([shutil.which("node"), str(ROOT / "mcp/server.mjs")], env=env, cwd=ROOT,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.id = 0

    def call(self, method, params=None):
        self.id += 1
        request = {"jsonrpc": "2.0", "id": self.id, "method": method}
        if params is not None:
            request["params"] = params
        self.proc.stdin.write((json.dumps(request) + "\n").encode())
        self.proc.stdin.flush()
        if not select.select([self.proc.stdout], [], [], 8)[0]:
            raise TimeoutError("MCP response exceeded 8 seconds; do not redispatch")
        response = json.loads(self.proc.stdout.readline())
        if response.get("id") != self.id:
            raise RuntimeError("Unexpected MCP message")
        return response

    def tool(self, name, arguments):
        response = self.call("tools/call", {"name": name, "arguments": arguments})
        if "error" in response:
            return {"status": "rpc_error", "detail": response["error"]}
        return json.loads(response["result"]["content"][0]["text"])

    def close(self):
        terminate_owned(self.proc)
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            stream.close()


def generated_answer(worker, text):
    if worker == "mimocode":
        parts = []
        for line in text.splitlines():
            try:
                event = json.loads(line)
                if event.get("type") == "text":
                    parts.append(event.get("part", {}).get("text", ""))
            except ValueError:
                pass
        return "".join(parts).strip() if parts else text.strip()
    return text.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True, help="Existing Linux profile configuration")
    parser.add_argument("--state", type=Path, required=True, help="Private test state outside source checkout")
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--run", action="store_true", required=True, help="Explicitly permit minimal real generation")
    parser.add_argument("--worker", action="append", choices=WORKERS, help="Selected workers; default is the six CLI workers")
    parser.add_argument("--mimo-model", help="Explicit Linux MiMo model for this private test configuration only")
    args = parser.parse_args()
    if sys.platform != "linux":
        raise SystemExit("This probe must execute on the actual Linux host")
    state = args.state.expanduser().resolve()
    if state.is_relative_to(ROOT):
        raise SystemExit("Private runtime state must stay outside source checkout")
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    config = state / "agents.json"
    workers = args.worker or WORKERS
    atomic_write_json(config, safe_config(args.config.expanduser(), state, workers, args.mimo_model))
    config.chmod(0o600)
    workspace = state / "empty-workspace"
    workspace.mkdir(exist_ok=True)
    token = secrets.token_urlsafe(24)
    hub_port = port()
    env = dict(os.environ, HUB_AGENTS_FILE=str(config), HUB_STATE_DIR=str(state / "hub-state"),
               HUB_RESULTS_DIR=str(state / "results"), HUB_TOKEN=token, AGENTHUB_URL="http://127.0.0.1:" + str(hub_port) + "/mcp")
    env.pop("HUB_MCP_URL", None)
    hub = spawn_owned([sys.executable, str(ROOT / "hub/agent_hub.py"), "--http", str(hub_port), "--host", "127.0.0.1"],
                      cwd=workspace, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    mcp = None
    report = {"kind": "real-linux-current-hub-mcp-worker-generation", "system": "Linux", "vendor_generation_requested": True,
              "windows_credentials_copied": False, "old_deployment_modified": False,
              "requested_dimensions": {"thinking": None, "streaming": None, "image": False, "file": False},
              "prompt_sha256": hashlib.sha256(PROMPT.encode()).hexdigest(), "workers": []}
    try:
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            if hub.poll() is not None:
                raise RuntimeError("Isolated current Hub exited at startup")
            try:
                with urllib.request.urlopen("http://127.0.0.1:" + str(hub_port) + "/health", timeout=.2) as response:
                    if json.load(response).get("service") == "agent-hub":
                        break
            except OSError:
                time.sleep(.05)
        else:
            raise RuntimeError("Isolated Hub health failed")
        mcp = MCP(env)
        mcp.call("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "linux-real-worker-probe", "version": "1"}})
        mcp.call("tools/list")
        pending = []
        for worker in workers:
            started = time.monotonic()
            result = mcp.tool("hub_dispatch", {"worker": worker, "task": PROMPT, "timeout_s": 60, "cwd": str(workspace)})
            entry = {"worker": worker, "dispatch_count": 1, "dispatch": result, "started": started}
            report["workers"].append(entry)
            if result.get("ref") and result.get("status") == "running":
                pending.append(entry)
            else:
                entry["final"] = result
                entry["finished"] = time.monotonic()
        deadline = time.monotonic() + 75
        while pending and time.monotonic() < deadline:
            for entry in pending[:]:
                result = mcp.tool("hub_fetch", {"ref": entry["dispatch"]["ref"]})
                if result.get("status") != "running":
                    entry["final"] = result
                    entry["finished"] = time.monotonic()
                    pending.remove(entry)
            if pending:
                time.sleep(.5)
        for entry in report["workers"]:
            final = entry.get("final", {"status": "uncertain", "ref": entry["dispatch"].get("ref"), "reason": "Continue original ref; no redispatch"})
            answer = generated_answer(entry["worker"], final.get("answer", ""))
            entry["generation_verified"] = final.get("status") == "completed" and answer == "AGENTHUB_LINUX_OK"
            entry["duration_s"] = round(entry.pop("finished", time.monotonic()) - entry.pop("started"), 3)
            entry["final"] = json.loads(clean(json.dumps(final)))
            entry["dispatch"] = json.loads(clean(json.dumps(entry["dispatch"])))
            result_file = state / "results" / (entry["dispatch"].get("ref", "missing") + ".json")
            if result_file.is_file():
                stored = json.loads(result_file.read_text())
                entry["runtime_exit_code"] = stored.get("exit_code")
        atomic_write_json(args.report, report)
        print(json.dumps(report))
        return 0
    finally:
        if mcp:
            mcp.close()
        terminate_owned(hub)
        hub.stderr.close()


if __name__ == "__main__":
    raise SystemExit(main())
