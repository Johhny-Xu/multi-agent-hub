#!/usr/bin/env python3
"""Exercise real hub/bridge code with synthetic local workers on Windows.

No vendor inference is performed. No active config/state or desktop UI is used.
Assertions describe desired behavior, so known bugs produce failed checks and
exit 1. Small isolated evidence is retained under the printed temp directory.
Run with a real Python executable, not the Windows Store alias:
  python tests/windows_dispatch_smoke.py
"""
import argparse
import ctypes
import hashlib
import importlib.util
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.dont_write_bytecode = True


class WindowsJob:
    """Own only test subprocesses and their descendants, never existing apps."""

    def __init__(self):
        class Basic(ctypes.Structure):
            _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                        ("flags", ctypes.c_uint32), ("min_ws", ctypes.c_size_t),
                        ("max_ws", ctypes.c_size_t), ("active", ctypes.c_uint32),
                        ("affinity", ctypes.c_size_t), ("priority", ctypes.c_uint32),
                        ("scheduling", ctypes.c_uint32)]

        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in
                        ("reads", "writes", "others", "read_bytes", "write_bytes", "other_bytes")]

        class Extended(ctypes.Structure):
            _fields_ = [("basic", Basic), ("io", IO), ("process_mem", ctypes.c_size_t),
                        ("job_mem", ctypes.c_size_t), ("peak_process", ctypes.c_size_t),
                        ("peak_job", ctypes.c_size_t)]

        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        self.api.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
        self.api.CreateJobObjectW.restype = ctypes.c_void_p
        self.api.SetInformationJobObject.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        self.api.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        self.api.CloseHandle.argtypes = [ctypes.c_void_p]
        self.handle = self.api.CreateJobObjectW(None, None)
        info = Extended()
        info.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.handle or not self.api.SetInformationJobObject(self.handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
            raise ctypes.WinError(ctypes.get_last_error())
        self.processes = []

    def attach(self, proc):
        self.processes.append(proc)
        if not self.api.AssignProcessToJobObject(self.handle, ctypes.c_void_p(int(proc._handle))):
            error = ctypes.get_last_error()
            if proc.poll() is None:
                proc.kill()
                proc.wait()
                raise ctypes.WinError(error)
        return proc

    def close(self):
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None
        for proc in self.processes:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass


def load_module(name, path):
    parent = str(path.resolve().parent)
    if parent not in sys.path:
        sys.path.insert(0, parent)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def resolve_sources(repo, references):
    """Keep diagnostic locations correct as parent changes source independently."""
    markers = {
        "hub/agent_hub.py:422": ('cwd = args.get("cwd")', 0),
        "hub/agent_hub.py:423": ('timeout = float(args.get("timeout_s")', 0),
        "hub/agent_hub.py:455": ('if prof.get("async_default")', 0),
        "hub/agent_hub.py:463": ('json.dump({"cmd": cmd', 0),
        "hub/agent_hub.py:478": ('via = prof.get("workdir_via")', 0),
        "hub/agent_hub.py:482": ('exe = shutil.which(cmd[0])', 0),
        "hub/agent_hub.py:419": ('if not cli:', 0),
        "hub/agent_hub.py:629": ('atomic_write_json(p, d)', 0),
        "hub/async_worker.py:81": ('atomic_write_json(p, d)', 0),
        "hub/async_worker.py:121": ('proc = spawn_owned(cmd_argv', 0),
        "hub/async_worker.py:251": ('box["text"] = subprocess_run([NODE, driver, task]', 0),
        "hub/async_worker.py:275": ('proc = spawn_owned(cmd_list', 0),
        "hub/async_worker.py:277": ('while proc.poll() is None:', 0),
        "hub/async_worker.py:341": ('save(ref, agent=mode, status="running"', 0),
        "hub/async_worker.py:349": ('text, code = run_cmd_mode', 0),
        "hub/async_worker.py:350": ('save(ref, status="completed" if code == 0', 0),
        "hub/async_worker.py:353": ('text = zcode_run(task', 0),
        "plugins/agenthub-workers/mcp/hub.mjs:87": ('if (st === "completed")', 0),
        "plugins/agenthub-workers/mcp/hub.mjs:141": ('callTool("zcode_delegate"', 0),
        "plugins/agenthub-workers/mcp/hub.mjs:144": ('await callTool("hub_dispatch_cli"', 0),
        "plugins/agenthub-workers/mcp/hub.mjs:175": ('if (st === "failed" || st === "timeout")', -1),
        "plugins/agenthub-workers/mcp/hub.mjs:178": ('return { status: st, answer: ""', 0),
        "hub/command_runtime.py:1": ('def spawn_owned', 0),
        "hub/command_runtime.py:2": ('def terminate_owned', 0),
    }
    resolved = []
    for reference in references:
        relative = reference.rsplit(":", 1)[0]
        marker = markers.get(reference)
        if marker:
            lines = (repo / relative).read_text(encoding="utf-8").splitlines()
            hits = [index for index, line in enumerate(lines, 1) if marker[0] in line]
            reference = f"{relative}:{hits[marker[1]]}" if hits else relative
        resolved.append(reference)
    return list(dict.fromkeys(resolved))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--report", type=Path)
    opts = parser.parse_args()
    repo = opts.repo.resolve()
    report_path = opts.report or repo / "docs/windows-probe-bus.json"
    if os.name != "nt":
        print("This probe requires native Windows.")
        return 2
    node = shutil.which("node")
    if not node:
        print("A native Node executable is required.")
        return 2
    base = Path(tempfile.mkdtemp(prefix="agenthub-windows-bus-"))
    inherited, target, authdir, state, results, shims = [base / p for p in
        ("inherited-cwd", "目标 workspace", "synthetic-auth-cwd", "state", "results", "shims")]
    for directory in (inherited, target, authdir, state, results, shims):
        directory.mkdir()
    saved_env, saved_cwd = os.environ.copy(), Path.cwd()
    env_overrides = {
        "HUB_RESULTS_DIR": str(results), "HUB_TOKEN": "", "PYTHONDONTWRITEBYTECODE": "1",
        "ZCODE_READER": str(base / "reader-does-not-exist.js"),
        "ZCODE_DOM_DRIVER": str(repo / "drivers/zcode_dom.js"), "ZCODE_DEBUG_DIR": "",
        "PATH": str(shims) + os.pathsep + os.environ.get("PATH", ""),
    }
    # Bound but never listening: the actual driver must get ECONNREFUSED and
    # cannot accidentally reach any real application/CDP port.
    closed_cdp = socket.socket()
    closed_cdp.bind(("127.0.0.1", 0))
    env_overrides["CDP_PORT"] = str(closed_cdp.getsockname()[1])
    os.environ.update(env_overrides)
    os.chdir(inherited)
    job = WindowsJob()
    original_popen = subprocess.Popen
    worker_logs = []

    def tracked_popen(*args, **kwargs):
        command = args[0] if args else kwargs.get("args", [])
        if isinstance(command, (list, tuple)) and any(str(item).endswith("async_worker.py") for item in command):
            log_path = base / f"worker-{len(worker_logs) + 1}.log"
            worker_logs.append(log_path)
            with log_path.open("wb") as log_file:
                kwargs["stdout"], kwargs["stderr"] = log_file, subprocess.STDOUT
                return job.attach(original_popen(*args, **kwargs))
        return job.attach(original_popen(*args, **kwargs))

    subprocess.Popen = tracked_popen
    server = None
    checks = []
    started = time.monotonic()

    def clean(value):
        if isinstance(value, dict):
            return {key: clean(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [clean(item) for item in value]
        if isinstance(value, str):
            for path, replacement in ((base, "<isolated-temp>"), (repo, "<repo>"),
                                      (Path(saved_env.get("USERPROFILE", "__no_profile__")), "%USERPROFILE%")):
                value = value.replace(str(path).replace("\\", "\\\\"), replacement)
                value = value.replace(str(path), replacement)
        return value

    def check(name, passed, expected, observed, source):
        checks.append({"name": name, "passed": bool(passed), "expected": expected,
                       "observed": clean(observed), "source": resolve_sources(repo, source)})

    try:
        hub = load_module("windows_probe_agent_hub", repo / "hub/agent_hub.py")
        hub.STATE, hub.AGENTS_JSON, hub.RESULTS_DIR = state, base / "agents.json", str(results)
        hub.HUB_TOKEN = ""
        worker_script = base / "synthetic_worker.py"
        worker_script.write_text(
            "import json, os, sys, time\n"
            "kind=sys.argv[1]\n"
            "if kind=='sleep': time.sleep(2)\n"
            "print(json.dumps({'synthetic':True,'kind':kind,'cwd':os.getcwd(),'argv':sys.argv[2:]}),flush=True)\n"
            "if kind=='fail': sys.exit(7)\n", encoding="utf-8")
        cmd_name = "agenthub-smoke-" + base.name.rsplit("-", 1)[-1] + ".cmd"
        (shims / cmd_name).write_text("@echo off\necho SYNTHETIC_CMD_OK\nexit /b 0\n", encoding="ascii")

        def profile(kind, **extra):
            return {"cli": [sys.executable, str(worker_script), kind, "{task}"],
                    "async_default": True, "model_arg": None, "models": {}, **extra}

        agents = {"codebuddy": profile("cwd"),
                  "codebuddy-cn": profile("workdir", cwd=str(authdir), workdir_via="--add-dir"),
                  "mimocode": profile("sleep"), "minimaxcode": profile("fail"),
                  "github-copilot": {"cli": [cmd_name, "{task}"], "async_default": True},
                  "antigravity": {"cli": [str(base / "not-installed.exe"), "{task}"], "async_default": True},
                  "zcode": {"cli": None, "model_arg": None, "async_default": True}}
        hub.AGENTS_JSON.write_text(json.dumps({"agents": agents}), encoding="utf-8")

        class QuietHandler(hub._HTTPHandler):
            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        os.environ["AGENTHUB_URL"] = f"http://127.0.0.1:{server.server_port}/mcp"
        os.environ["HUB_MCP_URL"] = os.environ["AGENTHUB_URL"]
        runner = base / "bridge_runner.mjs"
        runner.write_text(
            "const bridge = await import(process.argv[2]);\n"
            "const operation=process.argv[3]; const args=JSON.parse(process.argv[4]);\n"
            "const result=await bridge[operation](...args);\n"
            "console.log(JSON.stringify(result));\n", encoding="utf-8")

        def node_bridge(operation, args, timeout=18):
            p = subprocess.run([node, str(runner), (repo / "plugins/agenthub-workers/mcp/hub.mjs").as_uri(),
                                operation, json.dumps(args)], capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=timeout)
            if p.returncode != 0:
                raise RuntimeError(f"Node bridge exit {p.returncode}: {p.stderr[:500]}")
            return json.loads(p.stdout)

        refs, metadata, launch_times = {}, {}, {}
        try:
            hub.tool_hub_dispatch_cli({"agent": "antigravity", "task": "SYNTHETIC_MISSING_CLI"})
            missing_rejected = False
        except ValueError as error:
            missing_rejected = "UNAVAILABLE: cli_missing" in str(error)
        check("missing_cli_preflight", missing_rejected and not worker_logs,
              "A missing executable is rejected before acceptance or child creation",
              {"rejected": missing_rejected, "spawned_workers": len(worker_logs)}, ["hub/availability_store.py:1"])
        # A file may exist at preflight yet fail Windows CreateProcess. Keep
        # covering post-acceptance startup errors independently of missing CLI.
        invalid_exe = base / "invalid-executable.exe"
        invalid_exe.write_bytes(b"SYNTHETIC_NOT_AN_EXECUTABLE")
        agents["antigravity"]["cli"][0] = str(invalid_exe)
        hub.AGENTS_JSON.write_text(json.dumps({"agents": agents}), encoding="utf-8")
        for agent in ("codebuddy", "codebuddy-cn", "mimocode", "minimaxcode", "github-copilot", "antigravity"):
            launch_times[agent] = time.monotonic()
            text = hub.tool_hub_dispatch_cli({"agent": agent, "task": "SYNTHETIC_LOCAL_TEST_ONLY",
                                              "cwd": str(target), "timeout_s": 0.1 if agent == "mimocode" else 10})
            found = re.search(re.escape(agent) + r"-[0-9a-f]+", text)
            if not found:
                raise RuntimeError(f"No ref for synthetic {agent}: {text}")
            refs[agent] = found.group()
            task_path = results / (refs[agent] + ".task")
            metadata[agent] = json.loads(task_path.read_text(encoding="utf-8")) if task_path.exists() else {}

        # Avoid making the separate atomic-write contention case below
        # nondeterministically prevent other workers from starting.
        time.sleep(0.5)
        deadline, observed_results = time.monotonic() + 16, {}
        while time.monotonic() < deadline:
            for agent, ref in refs.items():
                if agent in observed_results:
                    continue
                result = hub._read_result(ref)
                if result and result.get("status") in hub.TERMINAL_STATUSES:
                    observed_results[agent] = {**result,
                                               "probe_elapsed_seconds": round(time.monotonic() - launch_times[agent], 3),
                                               "worker_elapsed_seconds": round(
                                                   float(result.get("updated_at") or 0) - float(result.get("started_at") or 0), 3)}
            if len(observed_results) == len(refs):
                break
            time.sleep(0.05)
        for agent in refs:
            observed_results.setdefault(agent, {"status": "probe_deadline_exceeded"})

        def output_json(agent):
            try:
                return json.loads(observed_results[agent].get("text", ""))
            except ValueError:
                return {}

        cwd_out, workdir_out = output_json("codebuddy"), output_json("codebuddy-cn")
        check("async_cwd", cwd_out.get("cwd") == str(target), "Child cwd equals caller cwd",
              {"result": observed_results["codebuddy"], "task_metadata": metadata["codebuddy"]},
              ["hub/agent_hub.py:422", "hub/agent_hub.py:455", "hub/async_worker.py:275"])
        check("async_workdir_via", workdir_out.get("cwd") == str(authdir) and "--add-dir" in workdir_out.get("argv", []) and str(target) in workdir_out.get("argv", []),
              "Profile cwd used and caller target appended through --add-dir",
              {"result": observed_results["codebuddy-cn"], "task_metadata": metadata["codebuddy-cn"]},
              ["hub/agent_hub.py:455", "hub/agent_hub.py:478"])
        timeout_result = observed_results["mimocode"]
        check("async_timeout", timeout_result.get("status") in ("timeout", "error") and timeout_result.get("worker_elapsed_seconds", 99) < 1.5,
              "Requested timeout_s=0.1 bounds a synthetic 2-second child and reports timeout/error",
              {"requested_timeout_s": 0.1, "child_sleep_s": 2, "result": timeout_result, "task_metadata": metadata["mimocode"]},
              ["hub/agent_hub.py:423", "hub/agent_hub.py:463", "hub/async_worker.py:277"])
        nonzero = observed_results["minimaxcode"]
        check("async_nonzero_exit", nonzero.get("status") in ("error", "failed"), "Synthetic child exit 7 reports failure",
              nonzero, ["hub/async_worker.py:349", "hub/async_worker.py:350"])
        bare_cmd = observed_results["github-copilot"]
        check("async_bare_cmd_path", bare_cmd.get("status") == "completed" and "SYNTHETIC_CMD_OK" in bare_cmd.get("text", ""),
              "Existing .cmd command on PATH launches through Windows-compatible resolution",
              {"which_resolves": shutil.which(cmd_name) is not None, "result": bare_cmd},
              ["hub/agent_hub.py:455", "hub/agent_hub.py:482", "hub/async_worker.py:275"])

        # Explicit filename.cmd works with Windows CreateProcess; extensionless
        # npm-style command names require PATHEXT/shutil.which resolution.
        extensionless = Path(cmd_name).stem
        agents["github-copilot"]["cli"][0] = extensionless
        hub.AGENTS_JSON.write_text(json.dumps({"agents": agents}), encoding="utf-8")
        extensionless_receipt = hub.tool_hub_dispatch_cli({"agent": "github-copilot", "task": "SYNTHETIC_LOCAL_TEST_ONLY"})
        extensionless_ref = re.search(r"github-copilot-[0-9a-f]+", extensionless_receipt).group()
        extensionless_result = None
        extensionless_deadline = time.monotonic() + 8
        while time.monotonic() < extensionless_deadline:
            extensionless_result = hub._read_result(extensionless_ref)
            if extensionless_result and extensionless_result.get("status") in hub.TERMINAL_STATUSES:
                break
            time.sleep(0.05)
        check("async_extensionless_cmd_path", bool(extensionless_result) and extensionless_result.get("status") == "completed" and "SYNTHETIC_CMD_OK" in extensionless_result.get("text", ""),
              "Extensionless name of an existing .cmd on PATH resolves through PATHEXT",
              {"which_resolves": shutil.which(extensionless) is not None, "result": extensionless_result},
              ["hub/agent_hub.py:455", "hub/agent_hub.py:482", "hub/async_worker.py:275"])

        bridge_nonzero = node_bridge("ask", ["minimaxcode", "SYNTHETIC_LOCAL_TEST_ONLY", 10])
        check("bridge_ask_nonzero", bridge_nonzero.get("ok") is False and bridge_nonzero.get("status") != "completed",
              "Plugin ask returns ok=false for a synthetic child exit 7", bridge_nonzero,
              ["plugins/agenthub-workers/mcp/hub.mjs:87", "hub/async_worker.py:350"])
        bridge_error = node_bridge("fetchRef", [refs["antigravity"]])
        check("bridge_fetch_error", bool(bridge_error.get("answer")) and bridge_error.get("status") in ("error", "failed"),
              "Fetch preserves terminal startup-error text",
              {"hub_result": observed_results["antigravity"], "bridge": bridge_error},
              ["plugins/agenthub-workers/mcp/hub.mjs:175", "plugins/agenthub-workers/mcp/hub.mjs:178"])
        zcode_dispatch = node_bridge("dispatchOnly", ["zcode", "SYNTHETIC_CLOSED_CDP_TEST_ONLY", 10])
        check("bridge_zcode_null_cli_route", zcode_dispatch.get("ok") is True and bool(zcode_dispatch.get("ref")),
              "ZCode cli:null routes to its desktop delegate and returns a ref", zcode_dispatch,
              ["plugins/agenthub-workers/mcp/hub.mjs:141", "plugins/agenthub-workers/mcp/hub.mjs:144", "hub/agent_hub.py:419"])

        baseline = subprocess.run([node, str(repo / "drivers/zcode_dom.js"), "SYNTHETIC_CLOSED_CDP_TEST_ONLY"],
                                  capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=8)
        zcode_receipt = hub.tool_zcode_delegate({"task": "SYNTHETIC_CLOSED_CDP_TEST_ONLY", "wait": False})
        zcode_ref = re.search(r"zcode-[0-9a-f]+", zcode_receipt).group()
        zcode_result = None
        zcode_deadline = time.monotonic() + 8
        time.sleep(0.5)
        while time.monotonic() < zcode_deadline:
            zcode_result = hub._read_result(zcode_ref)
            if zcode_result and zcode_result.get("status") in hub.TERMINAL_STATUSES:
                break
            time.sleep(0.05)
        check("zcode_driver_error_propagation", baseline.returncode != 0 and bool(zcode_result) and zcode_result.get("status") in ("error", "failed") and bool(zcode_result.get("text")),
              "Actual closed-port driver failure remains an error with diagnostic text",
              {"direct_driver_exit": baseline.returncode, "direct_driver_stderr": baseline.stderr[-1500:],
               "async_result": zcode_result, "forced_cdp_target": "reserved non-listening loopback port", "real_ui_access": False},
              ["hub/async_worker.py:121", "hub/async_worker.py:251", "hub/async_worker.py:353"])

        # Windows open readers deny delete/replace until the read handle closes.
        # Hold each actual result file for 0.2s, with a bounded reader thread, to
        # verify atomic writers retry transient sharing violations.
        worker = load_module("windows_probe_async_worker", repo / "hub/async_worker.py")
        worker.RESULTS = str(results)
        atomic_observed = {}
        for label, writer in (("hub", hub._save_result), ("async_worker", worker.save)):
            atomic_ref = "atomic-" + ("aaa001" if label == "hub" else "aaa002")
            writer(atomic_ref, status="running", text="old")
            holding = threading.Event()

            def hold_reader(path=results / (atomic_ref + ".json")):
                with path.open("r", encoding="utf-8"):
                    holding.set()
                    time.sleep(0.2)

            reader = threading.Thread(target=hold_reader, daemon=True)
            reader.start()
            if not holding.wait(timeout=2):
                raise RuntimeError("Atomic contention reader did not start")
            error = None
            try:
                writer(atomic_ref, status="completed", text="new")
            except OSError as exc:
                error = {"type": type(exc).__name__, "winerror": getattr(exc, "winerror", None), "message": str(exc)}
            reader.join(timeout=2)
            atomic_observed[label] = {"error": error, "reader_closed": not reader.is_alive(),
                                      "result": hub._read_result(atomic_ref)}
        check("atomic_result_replace_sharing", all(item["error"] is None and item["result"].get("text") == "new" for item in atomic_observed.values()),
              "Actual hub/worker atomic writers survive a transient 0.2s Windows read handle",
              atomic_observed, ["hub/agent_hub.py:629", "hub/async_worker.py:81", "hub/async_worker.py:341"])

        runtime = load_module("windows_probe_command_runtime", repo / "hub/command_runtime.py")
        child_pid_file = base / "owned-grandchild.pid"
        parent_code = (
            "import subprocess,sys; from pathlib import Path; "
            "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); "
            f"Path({str(child_pid_file)!r}).write_text(str(child.pid)); print('SYNTHETIC_PARENT_EXITED')")
        parent_proc = runtime.spawn_owned([sys.executable, "-c", parent_code], stdout=subprocess.PIPE,
                                           stderr=subprocess.PIPE, text=True)
        child_handle = None
        try:
            parent_stdout, parent_stderr = parent_proc.communicate(timeout=5)
            child_pid = int(child_pid_file.read_text())
            api = ctypes.WinDLL("kernel32", use_last_error=True)
            api.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
            api.OpenProcess.restype = ctypes.c_void_p
            api.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
            api.WaitForSingleObject.restype = ctypes.c_uint32
            api.CloseHandle.argtypes = [ctypes.c_void_p]
            child_handle = api.OpenProcess(0x100000, False, child_pid)  # SYNCHRONIZE; this fixture's exact child
            if not child_handle:
                raise ctypes.WinError(ctypes.get_last_error())
            alive_before_cleanup = api.WaitForSingleObject(child_handle, 0) == 258
            runtime.terminate_owned(parent_proc)  # root has already exited
            wait_result = api.WaitForSingleObject(child_handle, 2000)
            check("owned_cleanup_after_root_exit", parent_proc.returncode == 0 and alive_before_cleanup and wait_result == 0,
                  "Closing an owned job reclaims its exact grandchild after the root exits",
                  {"parent_exit": parent_proc.returncode, "parent_stdout": parent_stdout,
                   "parent_stderr": parent_stderr, "grandchild_alive_before_cleanup": alive_before_cleanup,
                   "grandchild_terminated_before_outer_probe_cleanup": wait_result == 0},
                  ["hub/command_runtime.py:1", "hub/command_runtime.py:2"])
        finally:
            runtime.terminate_owned(parent_proc)
            if child_handle:
                api.CloseHandle(child_handle)
    except Exception as exc:
        check("probe_execution", False, "Probe completes all meaningful cases", {"exception": str(exc)}, [])
    finally:
        if server:
            server.shutdown()
            server.server_close()
        subprocess.Popen = original_popen
        job.close()
        closed_cdp.close()
        os.chdir(saved_cwd)
        os.environ.clear()
        os.environ.update(saved_env)

    source_files = ("hub/agent_hub.py", "hub/async_worker.py", "hub/command_runtime.py", "plugins/agenthub-workers/mcp/hub.mjs", "drivers/zcode_dom.js")
    report = {"kind": "synthetic_windows_bus_integration_probe", "tested_date": "2026-10-08",
              "timezone": "Asia/Shanghai", "platform": "Windows", "python_version": sys.version.split()[0],
              "duration_seconds": round(time.monotonic() - started, 3), "live_vendor_inference_performed": False,
              "isolated_temp_evidence_directory": "%TEMP%/" + base.name, "active_agent_config_or_state_modified": False,
              "source_sha256": {name: hashlib.sha256((repo / name).read_bytes()).hexdigest() for name in source_files},
              "checks": checks, "passed": sum(c["passed"] for c in checks),
              "failed": sum(not c["passed"] for c in checks),
              "worker_diagnostics": {path.name: clean(path.read_text(encoding="utf-8", errors="replace")[-5000:]) for path in worker_logs},
              "cleanup": "Ephemeral HTTP server and reserved CDP socket closed; only test child processes/descendants reclaimed through a Windows Job Object. Small temporary fixture/result files retained; no directory deletion attempted."}
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(report_path), "passed": report["passed"], "failed": report["failed"], "duration_seconds": report["duration_seconds"],
                      "evidence_directory": str(base)}, ensure_ascii=False))
    return 1 if report["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
