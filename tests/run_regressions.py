"""Run isolated regression suites and save a reproducible validation report.

No vendor inference/login or live client installation is performed.
Usage: python tests/run_regressions.py [--report path]
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
from command_runtime import atomic_write_json, spawn_owned, terminate_owned


def source_hashes():
    hashes = {}
    for folder in ("hub", "console", "mcp", "drivers", "integrations", "plugins", "tests", "scripts"):
        for path in (ROOT / folder).rglob("*"):
            if not path.is_file() or path.suffix not in {".py", ".js", ".mjs", ".toml", ".yml", ".sh", ".ps1", ".bat", ".md", ".json"}:
                continue
            if path.name in {"agents.json", "auth.json", "credentials.json"}:
                continue
            if any(part in {"state", "results", "node_modules", "__pycache__"} for part in path.parts):
                continue
            hashes[path.relative_to(ROOT).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    for name in ("start.sh", "stop.sh", "start.bat", "stop.bat", ".env.example",
                 "integrations/codex/plugin.json", "integrations/codex/mcp.json",
                 "integrations/codex/.mcp.json", "integrations/codex/.codex-plugin/plugin.json",
                 "integrations/dsh/package.json"):
        path = ROOT / name
        if path.is_file():
            hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=ROOT / "docs" / "refactor-validation.json")
    options = parser.parse_args()
    node = shutil.which("node")
    if not node:
        raise SystemExit("Node.js is required for the MCP and console regressions")
    suite_env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8", AGENTHUB_TEST_PYTHON=sys.executable)
    groups = [(name, [sys.executable, "tests/" + file]) for name, file in (
        ("hub_core", "hub_core_regressions.py"),
        ("runtime", "runtime_regressions.py"),
        ("task_contract", "task_contract_regressions.py"),
        ("worker_output", "worker_output_regressions.py"),
        ("live_probe_validation", "live_workers_probe_regressions.py"),
        ("login_manager", "login_manager_smoke.py"),
        ("codex_adapter", "codex_adapter_smoke.py"),
        ("dsh_installer", "dsh_installer_smoke.py"),
    )]
    groups += [("mcp_bridge", [node, "--test", "tests/mcp_bridge.test.mjs", "tests/task_bridge.test.mjs", "plugins/agenthub-workers/scripts/test-login.mjs"]),
               ("zcode_rpc", [node, "--test", "tests/zcode_rpc.test.mjs"]),
               ("native_plugin_config", [node, "--test", "tests/native_plugins_config.mjs", "tests/native_plugins_contract.mjs"]),
               ("console", [node, "--test", "tests/console_smoke.mjs"]),
               ("dsh_workflows", [node, "--test", "tests/dsh_workflows.test.mjs"])]
    if os.name == "nt":
        groups += [("windows_bus", [sys.executable, "tests/windows_dispatch_smoke.py"]),
                   ("windows_pty", [sys.executable, "tests/windows_login_smoke.py"]),
                   ("windows_launcher", [node, "--test", "tests/windows_launcher.test.mjs"])]
    else:
        groups += [("linux_launcher", [sys.executable, "tests/platform_linux_smoke.py"])]
    tested_sources = source_hashes()
    results = []
    for name, command in groups:
        started = time.monotonic()
        proc = None
        try:
            proc = spawn_owned(command, cwd=str(ROOT), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                               env=suite_env)
            output, _ = proc.communicate(timeout=90)
            code = proc.returncode
        except (OSError, subprocess.TimeoutExpired) as exc:
            output, code = str(exc), 1
        finally:
            terminate_owned(proc)
        entry = {"suite": name, "passed": code == 0, "exit_code": code,
                 "duration_s": round(time.monotonic() - started, 3)}
        count = re.search(r"Ran (\d+) tests?", output) or re.search(r"(?:ℹ\s+tests|# tests)\s+(\d+)", output)
        if count:
            entry["tests"] = int(count.group(1))
        if code:
            entry["failure_output"] = output[-6000:]
        results.append(entry)
        print(name + ": " + ("PASS" if code == 0 else "FAIL"), flush=True)
    final_sources = source_hashes()
    changed = sorted(name for name in set(tested_sources) | set(final_sources)
                     if tested_sources.get(name) != final_sources.get(name))
    report = {"kind": "isolated_refactor_adapter_regressions", "tested_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
              "platform": sys.platform, "python": sys.version.split()[0],
              "vendor_inference_performed": False, "live_client_configs_modified": False,
              "suites": results, "passed_suites": sum(item["passed"] for item in results),
              "failed_suites": sum(not item["passed"] for item in results), "source_sha256": tested_sources,
              "source_changed_during_run": changed}
    atomic_write_json(options.report, report)
    print("Report: " + str(options.report))
    if changed:
        print("Source changed during verification: " + ", ".join(changed))
    return int(report["failed_suites"] > 0 or bool(changed))


if __name__ == "__main__":
    raise SystemExit(main())
