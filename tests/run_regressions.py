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
    for folder in ("hub", "console", "mcp", "drivers", "integrations", "plugins", "tests", "scripts", "packaging"):
        for path in (ROOT / folder).rglob("*"):
            if not path.is_file() or path.suffix not in {".py", ".js", ".mjs", ".toml", ".yml", ".sh", ".ps1", ".bat", ".md", ".json", ".txt", ".svg"}:
                continue
            if path.name in {"agents.json", "auth.json", "credentials.json"}:
                continue
            if any(part in {"state", "results", "node_modules", "__pycache__", ".venv", "venv", "site-packages", "dist-packages"} for part in path.parts):
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


def redact_local_paths(text):
    """Strip absolute local paths from captured output before it is committed.

    This report is a committed evidence artifact, and a failing suite happily
    prints the interpreter path, the temp directory and the working directory
    of whoever ran it. Those must not enter the repository: the v0.9.9.6 run
    leaked three such paths for exactly this reason.

    Captured output can arrive double-escaped (a suite that echoes JSON, or the
    repr of an argv list), so backslashes are matched in runs rather than
    literally.
    """
    home = str(Path.home())
    variants = set()
    for repeats in (4, 2, 1):
        variants.add(home.replace("\\", "\\" * repeats))
        variants.add(home.replace("/", "/" * repeats))
        variants.add(home.replace("\\", "/" * repeats))
    for variant in sorted(variants, key=len, reverse=True):
        if variant:
            text = text.replace(variant, "<home>")
    text = re.sub(r"[A-Za-z]:[\\/]{1,4}Users[\\/]{1,4}[^\\/\s\"']+", "<user-path>", text)
    text = re.sub(r"/home/[^/\s\"']+", "/home/<user>", text)
    text = re.sub(r"/Users/[^/\s\"']+", "/Users/<user>", text)
    return text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=ROOT / "docs" / "refactor-validation.json")
    options = parser.parse_args()
    node = shutil.which("node")
    if not node:
        raise SystemExit("Node.js is required for the MCP and console regressions")
    suite_env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8", AGENTHUB_TEST_PYTHON=sys.executable)
    # Suites probe their own loopback servers with plain urllib; keep that traffic
    # off any http_proxy/https_proxy the runner inherited (CI and corporate hosts).
    loopback = "127.0.0.1,localhost,::1"
    for key in ("NO_PROXY", "no_proxy"):
        current = suite_env.get(key, "")
        suite_env[key] = (current + "," + loopback) if current else loopback
    groups = [(name, [sys.executable, "tests/" + file]) for name, file in (
        ("hub_core", "hub_core_regressions.py"),
        ("runtime", "runtime_regressions.py"),
        ("task_contract", "task_contract_regressions.py"),
        ("capability_availability", "capability_availability_regressions.py"),
        ("worker_output", "worker_output_regressions.py"),
        ("live_probe_validation", "live_workers_probe_regressions.py"),
        ("login_manager", "login_manager_smoke.py"),
        ("codex_adapter", "codex_adapter_smoke.py"),
        ("dsh_installer", "dsh_installer_smoke.py"),
        ("packaging", "packaging_smoke.py"),
        ("packaging_audit", "packaging_audit_regressions.py"),
        ("discovery", "discovery_regressions.py"),
        ("packaging_discovery", "packaging_discovery.py"),
        ("codearts_driver", "codearts_driver_regressions.py"),
        ("codearts_native_install", "codearts_native_install.py"),
        ("codearts_hub_contract", "codearts_hub_contract.py"),
        ("codearts_packaging", "codearts_packaging.py"),
        ("antigravity_native", "antigravity_native_install.py"),
        ("antigravity_sdk", "antigravity_sdk.test.py"),
        ("antigravity_sdk_protocol", "antigravity_sdk_protocol.py"),
        ("antigravity_packaging", "antigravity_packaging.py"),
        ("antigravity_hub_contract", "antigravity_hub_contract.py"),
    )]
    groups += [("mcp_bridge", [node, "--test", "tests/mcp_bridge.test.mjs", "tests/task_bridge.test.mjs", "plugins/agenthub-workers/scripts/test-login.mjs", "tests/discovery.test.mjs"]),
               ("zcode_rpc", [node, "--test", "tests/zcode_rpc.test.mjs"]),
               ("codearts_native_plugin", [node, "--test", "tests/codearts_native_plugin.mjs"]),
               ("native_plugin_config", [node, "--test", "tests/native_plugins_config.mjs", "tests/native_plugins_contract.mjs", "tests/client_config.test.mjs"]),
               ("console", [node, "--test", "tests/console_smoke.mjs", "tests/console_capabilities_dom.mjs", "tests/console_capabilities_core.mjs", "tests/console_worker_parity.mjs", "tests/console_client_syntax.mjs"]),
               ("dsh_workflows", [node, "--test", "tests/dsh_workflows.test.mjs", "tests/dsh_connection.test.mjs"])]
    if os.name == "nt":
        groups += [("windows_bus", [sys.executable, "tests/windows_dispatch_smoke.py", "--report", str(options.report.with_name(options.report.stem + "-windows-bus.json"))]),
                   ("windows_pty", [sys.executable, "tests/windows_login_smoke.py"]),
                   ("windows_venv_service", [sys.executable, "tests/windows_venv_service.py"]),
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
            output, _ = proc.communicate(timeout=420 if name in {"packaging", "packaging_audit", "packaging_discovery"} else 90)
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
            entry["failure_output"] = redact_local_paths(output[-6000:])
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
