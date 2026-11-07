#!/usr/bin/env python3
"""Linux native ZCode host probe with isolated plugin store and existing auth.

No authentication file is read or copied. Existing provider configuration is
referenced by filename; its contents and raw host output stay outside checkout.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
from command_runtime import atomic_write_json, spawn_owned, terminate_owned
from remote_matrix_probe import png_blue
from remote_worker_probe import clean


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True, help="Private isolated matrix state")
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--run", action="store_true", required=True)
    parser.add_argument("--worker", choices=("codebuddy-cn", "minimaxcode"), default="codebuddy-cn")
    args = parser.parse_args()
    if sys.platform != "linux" or args.state.resolve().is_relative_to(ROOT):
        raise SystemExit("Run on Linux with private state outside checkout")
    home = Path.home()
    entry = home / "zcode-app/opt/ZCode/resources/glm/zcode.cjs"
    report = {"kind": "real-linux-native-zcode-plugin-host", "windows_credentials_copied": False,
              "existing_gui_configuration_modified": False, "native_entry_exists": entry.is_file(),
              "generation_verified": False}
    roots = (home / ".config/ZCode/User/globalStorage", home / ".zcode")
    configurations = [p for root in roots if root.is_dir() for p in root.rglob("zcode-builtin.json") if p.is_file()]
    report["existing_provider_configuration_filename_exists"] = bool(configurations)
    if not entry.is_file() or not configurations:
        report["outcome"] = "blocked_missing_native_entry_or_existing_account_configuration"
        atomic_write_json(args.report, report)
        print(json.dumps(report))
        return
    state = args.state / ("native-zcode-" + secrets.token_hex(4))
    state.mkdir(mode=0o700)
    project, store = state / "project", state / "store"
    project.mkdir(); store.mkdir()
    (project / "zcode.json").write_text(json.dumps({"plugins": {"enabled": True, "dirs": [str(ROOT / "plugins/agenthub-workers")]}}))
    fixture = state / "fixtures"; fixture.mkdir()
    nonce = "LINUX_ZCODE_" + secrets.token_hex(6).upper()
    (fixture / "input.txt").write_text("Verification nonce: " + nonce + "\n")
    (fixture / "input.png").write_bytes(png_blue())
    env = os.environ.copy()
    env.update(json.loads((args.state / "env.json").read_text()))
    env.update(ZCODE_STORAGE_DIR=str(store), ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=str(configurations[0]), PYTHONUTF8="1")
    env.pop("HUB_MCP_URL", None)
    discovery = []
    for tail in (["--version"], ["plugins", "validate", str(ROOT / "plugins/agenthub-workers"), "--json"], ["plugins", "list", "--json"]):
        proc = spawn_owned(["node", str(entry), *tail], env=env, cwd=project, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            out, err = proc.communicate(timeout=20)
            discovery.append({"operation": tail[:2], "exit": proc.returncode, "stdout": clean(out.decode("utf-8", "replace"))[:6000], "stderr": clean(err.decode("utf-8", "replace"))[:400]})
        finally:
            terminate_owned(proc); proc.stdout.close(); proc.stderr.close()
    report["discovery"] = discovery
    case = "LINUX_NATIVE_ZCODE_" + secrets.token_hex(4).upper()
    task_instruction = "Read supplied attachments with the Read tool only." if args.worker == "codebuddy-cn" else "Use the supplied image and text data. Do not invoke tools."
    arguments = {"worker": args.worker, "task": task_instruction + " Do not execute shell commands or write files. Return " + case + "; the dominant image color in English; and the exact text-file nonce. Do not infer unavailable attachments.",
                 "timeout_s": 90, "model": "deepseek-v4.1-flash" if args.worker == "codebuddy-cn" else "MiniMax-M3.1-Flash-Preview", "thinking": "off" if args.worker == "codebuddy-cn" else "on", "stream": True,
                 "files": [str(fixture / "input.txt"), str(fixture / "input.png")], "cwd": str(args.state / "workspace")}
    prompt = ("Use the native Agent tool exactly once with the registered subagent_type " + args.worker + " from the agenthub-workers plugin. Give that child this exact task: "
              "Call the loaded plugin hub_ask exactly once with these JSON arguments, then return the real ok/status/ref/answer: " + json.dumps(arguments) +
              ". Parent must not calculate, read files, call Hub directly, or retry. If running/unknown preserve ref and report uncertainty. This is an authorized isolated read-only validation task.")
    command = ["node", str(entry), "--json", "--mode", "yolo", "--cwd", str(project), "--prompt", prompt,
               "--disallowed-tools", "Bash", "Read", "Write", "Edit", "Glob", "Grep"]
    began = time.monotonic()
    proc = spawn_owned(command, cwd=project, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        try:
            out, err = proc.communicate(timeout=180)
            report.update(exit=proc.returncode, timed_out=False)
        except subprocess.TimeoutExpired:
            terminate_owned(proc)
            out, err = proc.communicate(timeout=5)
            report.update(exit=proc.returncode, timed_out=True)
        raw = out.decode("utf-8", "replace")
        (state / "host-private.stdout.log").write_text(raw)
        (state / "host-private.stderr.log").write_bytes(err)
        report.update(duration_s=round(time.monotonic()-began,3), host_stdout_bytes=len(out), host_stderr_bytes=len(err),
                      explicit_native_agent_evidence=("subagent_type" in raw and args.worker in raw and bool(re.search(r'\"(?:name|tool_name)\"\s*:\s*\"(?:Agent|Task)\"', raw))),
                      host_returned_ref_names=sorted(set(re.findall(re.escape(args.worker) + r"-[a-f0-9]{10}", raw))), results=[])
        report["native_agent_metadata"] = []
        expected_profile = ROOT / "plugins/agenthub-workers/agents" / (args.worker + ".md")
        for path in (store / "cli/agents").glob("*/*/metadata.json"):
            metadata = json.loads(path.read_text())
            snapshot = metadata.get("profileSnapshot", {})
            profile_path = snapshot.get("path")
            known_plugin = isinstance(profile_path, str) and Path(profile_path).resolve() == expected_profile.resolve()
            report["native_agent_metadata"].append({"profile_id": metadata.get("profileId"), "profile_name": snapshot.get("name"),
                                                     "status": metadata.get("status"), "total_tool_use_count": metadata.get("totalToolUseCount"),
                                                     "known_plugin_definition_path": known_plugin,
                                                     "profile_definition_sha256": hashlib.sha256(expected_profile.read_bytes()).hexdigest() if known_plugin else None})
        report["explicit_native_agent_evidence"] = any(item["known_plugin_definition_path"] for item in report["native_agent_metadata"])
        for path in Path(env["HUB_RESULTS_DIR"]).glob(args.worker + "-*.json"):
            value = json.loads(path.read_text())
            text = value.get("text", "")
            if case in text or path.stem in report["host_returned_ref_names"]:
                verified = value.get("status") == "completed" and case in text and nonce in text and "blue" in text.lower()
                report["results"].append({"ref": path.stem, "status": value.get("status"), "answer": clean(text), "exit_code": value.get("exit_code"),
                                           "attachments": value.get("attachments"), "usage": value.get("usage"), "generation_verified": verified})
        report["generation_verified"] = len(report["results"]) == 1 and report["results"][0]["generation_verified"] and report["explicit_native_agent_evidence"]
        report["outcome"] = "verified_native_agent_to_real_worker" if report["generation_verified"] else "native_chain_not_verified"
        report["host_stderr_summary"] = clean(err.decode("utf-8", "replace"))[-900:]
        atomic_write_json(args.report, report)
        print(json.dumps(report))
    finally:
        terminate_owned(proc); proc.stdout.close(); proc.stderr.close()


if __name__ == "__main__":
    main()
