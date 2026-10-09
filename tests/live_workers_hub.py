"""Opt-in Windows live MCP -> isolated HTTP Hub -> native CLI integration."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

from live_workers_windows import ROOT, HOME, NODE, CB, MIMO, MMX, MODELS, fixture
from command_runtime import spawn_owned, terminate_owned


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", default="mimocode,codebuddy-cn")
    parser.add_argument("--cases", default="0000,0111,1011,1100")
    parser.add_argument("--output", default="docs/live-workers-hub-integration.json")
    options = parser.parse_args()
    directory = Path(tempfile.mkdtemp(prefix="agenthub-live-hub-"))
    agents = {"agents": {
        "mimocode": {"cli": [str(NODE), str(MIMO), "run", "--pure", "--format", "json", "--thinking", "{task}"],
            "model_arg": "--model", "models": {"default": MODELS["mimocode"]}, "async_default": True,
            "env": {"MIMOCODE_CONFIG_CONTENT": json.dumps({"permission": {"read": "allow", "edit": "allow", "bash": "deny", "webfetch": "deny", "websearch": "deny"}})}},
        "codebuddy-cn": {"cli": [str(NODE), str(CB), "-p", "{task}", "--tools", "Read,Write", "--allowedTools", "Read", "Write", "--permission-mode", "acceptEdits", "--setting-sources", "user", "--max-turns", "5", "--output-format", "json"],
            "model_arg": "--model", "models": {"default": MODELS["codebuddy-cn"]}, "async_default": True,
            "env": {"CODEBUDDY_CONFIG_DIR": str(HOME / ".codebuddy-cn"), "CODEBUDDY_INTERNET_ENVIRONMENT": "internal", "DISABLE_AUTOUPDATER": "1", "CODEBUDDY_MAX_RETRIES": "0"}},
        "minimaxcode": {"cli": [str(NODE), str(MMX), "--quiet", "text", "chat", "--message", "{task}", "--output", "json", "--max-tokens", "4096", "--timeout", "90", "--non-interactive", "--no-color"],
            "model_arg": "--model", "models": {"default": MODELS["minimaxcode"]}, "async_default": True},
    }}
    agentfile = directory / "agents.json"
    agentfile.write_text(json.dumps(agents), encoding="utf-8")
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    environment = dict(os.environ, HUB_AGENTS_FILE=str(agentfile), HUB_STATE_DIR=str(directory / "state"),
        HUB_RESULTS_DIR=str(directory / "state/results"), AGENTHUB_URL=f"http://127.0.0.1:{port}/mcp")
    environment.pop("HUB_TOKEN", None)
    manifest = {"output": str(ROOT / options.output), "report": {
        "platform": "Windows", "real_calls": True, "layer": "new JavaScript bridge -> isolated HTTP Hub -> authenticated official worker CLI",
        "raw_log_root": str(directory), "port": port, "source_files_separate_from_worker_cwd": True}, "cases": []}
    for worker in options.workers.split(","):
        if worker not in agents["agents"]:
            raise ValueError("Unsupported integration probe worker")
        for bits in options.cases.split(","):
            if len(bits) != 4 or any(bit not in "01" for bit in bits):
                raise ValueError("Cases use four thinking/stream/image/file bits")
            thinking, stream, image, file = [c == "1" for c in bits]
            name = worker + "-" + bits
            source, cwd = directory / "client-input" / name, directory / "worker-output" / name
            cwd.mkdir(parents=True)
            task, expected, nonce = fixture(source, image, file)
            # The worker cwd contains no original source file. Its only input
            # comes from the bridge's base64 transfer and Hub materialization.
            task = task.replace("paths outside the current test directory", "unrelated paths outside the current test directory and the explicitly attached inputs")
            if worker == "minimaxcode" and file:
                task = "\n".join(line for line in task.splitlines() if not line.startswith("Write output.json"))
            manifest["cases"].append({"case": name, "worker": worker, "model": MODELS[worker],
                "thinking": thinking, "stream": stream, "image": image, "file": file,
                "require_write": file and worker != "minimaxcode",
                "task": task, "cwd": str(cwd), "expected": {"total": expected, "nonce": nonce},
                "files": [str(source / name) for name in ("image.png", "input.txt") if (source / name).exists()]})
    manifestfile = directory / "manifest.json"
    manifestfile.write_text(json.dumps(manifest), encoding="utf-8")
    hub, node = None, None
    reportfile = Path(manifest["output"])
    completed = False
    with (directory / "hub.stdout.raw.log").open("w", encoding="utf-8") as out, (directory / "hub.stderr.raw.log").open("w", encoding="utf-8") as err:
        try:
            hub = spawn_owned([sys.executable, str(ROOT / "hub/agent_hub.py"), "--http", str(port)],
                cwd=str(directory), env=environment, stdin=subprocess.DEVNULL, stdout=out, stderr=err)
            for _ in range(40):
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1).close()
                    break
                except Exception:
                    if hub.poll() is not None:
                        raise RuntimeError("Owned test Hub failed to start")
                    time.sleep(0.15)
            node = spawn_owned([str(NODE), str(ROOT / "tests/live_workers_hub.mjs"), str(manifestfile)],
                cwd=str(directory), env=environment, stdin=subprocess.DEVNULL)
            node.wait(timeout=850)
            if node.returncode:
                raise RuntimeError("Integration launcher exited nonzero")
            report = json.loads(reportfile.read_text(encoding="utf-8"))
            attachment_root = directory / "state/attachments"
            report["temporary_attachments_cleaned"] = not attachment_root.exists() or not any(attachment_root.iterdir())
            report["owned_processes_cleaned"] = False
            reportfile.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            completed = True
        finally:
            terminate_owned(node)
            terminate_owned(hub)
    if completed:
        report = json.loads(reportfile.read_text(encoding="utf-8"))
        report["owned_processes_cleaned"] = True
        reportfile.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"report": manifest["output"], "raw_log_root": str(directory)}))


if __name__ == "__main__":
    main()
