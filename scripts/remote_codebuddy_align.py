#!/usr/bin/env python3
"""Align an isolated Linux official CodeBuddy CLI with verified Windows version.

Installs only into private test state, never modifies the old package or account
files. Four new tasks precede any optional sixteen-cell follow-up.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
from command_runtime import atomic_write_json, spawn_owned, terminate_owned
from remote_matrix_probe import Client, png_blue
from remote_worker_probe import clean


def command(argv, cwd, timeout=60):
    proc = spawn_owned(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        out, err = proc.communicate(timeout=timeout)
        return proc.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")
    finally:
        terminate_owned(proc); proc.stdout.close(); proc.stderr.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--run", action="store_true", required=True)
    args = parser.parse_args()
    if sys.platform != "linux" or args.state.resolve().is_relative_to(ROOT):
        raise SystemExit("Private Linux test state is required")
    state = args.state / "codebuddy-version-align"
    state.mkdir(mode=0o700)
    report = {"kind": "official-linux-cli-version-alignment", "package": "@tencent-ai/codebuddy-code", "version": "2.162.0",
              "windows_credentials_copied": False, "old_cli_modified": False, "old_account_files_modified_by_probe": False, "cases": []}
    exit_code, out, err = command(["npm", "install", "--prefix", str(state / "cli"), "--cache", str(state / "npm-cache"),
                                   "--ignore-scripts", "--no-audit", "--no-fund", "@tencent-ai/codebuddy-code@2.162.0"], state, timeout=120)
    report["installation"] = {"exit": exit_code, "stdout": clean(out)[-1500:], "stderr": clean(err)[-1000:]}
    entry = state / "cli/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy"
    if exit_code or not entry.is_file():
        report["outcome"] = "blocked_isolated_official_package_installation"
        atomic_write_json(args.report, report); print(json.dumps(report)); return
    code, stdout, stderr = command(["node", str(entry), "--version"], state, 10)
    report["native_version"] = {"exit": code, "stdout": clean(stdout).strip(), "stderr": clean(stderr)[:500]}
    if code or "2.162.0" not in stdout:
        report["outcome"] = "blocked_isolated_native_entry"
        atomic_write_json(args.report, report); print(json.dumps(report)); return
    configuration_path = args.state / "agents.json"
    config = json.loads(configuration_path.read_text())
    original = copy.deepcopy(config)
    profile = config["agents"]["codebuddy-cn"]
    profile["cli"] = ["node", str(entry), "-p", "{task}", "--tools", "Read", "--allowedTools", "Read", "--permission-mode", "acceptEdits",
                      "--strict-mcp-config", "--mcp-config", "{}", "--no-session-persistence"]
    profile["model_arg"] = "--model"
    profile["options_before_prompt"] = False
    routing = [key for key in os.environ if key.startswith(("CODEBUDDY_", "ANTHROPIC_", "OPENAI_")) and any(part in key for part in ("BASE", "URL", "PROVIDER", "API_KEY"))]
    routing += [key for key in profile.get("env", {}) if key.startswith(("CODEBUDDY_", "ANTHROPIC_", "OPENAI_")) and any(part in key for part in ("BASE", "URL", "PROVIDER", "API_KEY"))]
    for key in set(routing):
        profile.setdefault("env", {})[key] = ""
    report["task_routing_override_keys_cleared"] = sorted(set(routing))
    report["existing_native_auth_filename_exists"] = (Path.home() / ".codebuddy-cn/auth.info").is_file()
    profile.setdefault("env", {})["CODEBUDDY_API_KEY_DISABLED"] = "1"
    atomic_write_json(configuration_path, config)
    env = os.environ.copy(); env.update(json.loads((args.state / "env.json").read_text())); env.pop("HUB_MCP_URL", None)
    client = Client(env)
    client.call("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "native-cli-version-align", "version": "1"}})
    try:
        for image, file in ((False, False), (False, True), (True, False), (True, True)):
            identity = "ALIGN_" + secrets.token_hex(4).upper()
            nonce = "ALIGN_FILE_" + secrets.token_hex(5).upper()
            paths = []
            if image:
                path = state / (identity + ".png"); path.write_bytes(png_blue()); paths.append(str(path))
            if file:
                path = state / (identity + ".txt"); path.write_text("Verification nonce: " + nonce + "\n"); paths.append(str(path))
            task = "Read the supplied attachments using the Read tool only. Never use shell or write files. Return " + identity + "; image=" + ("the dominant image color in English" if image else "NO_IMAGE") + "; file=" + ("the exact nonce from the text file" if file else "NO_FILE") + ". Do not guess unread attachments."
            began = time.monotonic()
            final = client.task({"worker": "codebuddy-cn", "task": task, "model": "deepseek-v4.1-flash", "thinking": "off", "stream": True,
                                 "files": paths, "cwd": str(args.state / "workspace"), "timeout_s": 90}, identity)
            answer = final.get("answer", "")
            verified = final.get("status") == "completed" and identity in answer and (("blue" in answer.lower()) if image else "NO_IMAGE" in answer) and ((nonce in answer) if file else "NO_FILE" in answer)
            report["cases"].append({"case_id": identity, "image": image, "file": file, "thinking": "off", "stream": True, "dispatch_count": 1,
                                    "duration_s": round(time.monotonic()-began,3), "generation_verified": verified, "final": json.loads(clean(json.dumps(final))),
                                    "progress_notifications": len(client.events.get(identity, []))})
            atomic_write_json(args.report, report)
        report["four_cases_verified"] = all(case["generation_verified"] for case in report["cases"])
        report["outcome"] = "version_alignment_fixed_four_cases" if report["four_cases_verified"] else "version_alignment_did_not_verify_all_four_cases"
        if not report["four_cases_verified"]:
            atomic_write_json(configuration_path, original)
        report["private_test_configuration_retains_aligned_entry"] = report["four_cases_verified"]
        atomic_write_json(args.report, report)
        print(json.dumps(report))
    finally:
        client.close()


if __name__ == "__main__":
    main()
