"""Owned-process and runtime regressions; no vendor requests or authentication."""
import contextlib
import io
import json
import os
import shutil
import signal
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hub"))
import async_worker as worker
import command_runtime as runtime
import login_manager as login
from windows_pty import _PtyOutput


class RuntimeRegressions(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="agenthub-runtime-regression-"))

    def test_owned_group_marker_is_private_to_the_spawn_environment(self):
        key = 'AGENTHUB_OWNED_POSIX_GROUP'
        for new_session in (True, False):
            with self.subTest(new_session=new_session):
                env = dict(os.environ, AGENTHUB_OWNED_POSIX_GROUP='stale')
                probe = ('import json,os;print(json.dumps(dict(marker=os.getenv(' + repr(key) + '))))')
                proc = runtime.spawn_owned([sys.executable, '-c', probe], env=env,
                                           start_new_session=new_session, stdout=-1, stderr=-1)
                try:
                    out, err = proc.communicate(timeout=5)
                    self.assertEqual(proc.returncode, 0, err)
                    self.assertEqual(json.loads(out)['marker'],
                                     '1' if os.name != 'nt' and new_session else None)
                    self.assertEqual(env[key], 'stale')
                finally:
                    runtime.terminate_owned(proc)

    @unittest.skipUnless(os.name == "nt" and shutil.which("node"), "Windows npm shim fixture")
    def test_command_uses_child_path_and_extensionless_npm_entrypoint(self):
        name = "agenthub-runtime-path-fixture"
        entry = self.base / "node_modules" / "fixture" / "bin" / "cli"
        entry.parent.mkdir(parents=True)
        entry.write_text("console.log('OWNED_PATH_FIXTURE')", encoding="utf-8")
        shim = self.base / (name + ".cmd")
        shim.write_text('@echo off\nnode "%dp0%\\node_modules\\fixture\\bin\\cli" %*\n', encoding="utf-8")
        env = dict(os.environ, PATH=str(self.base) + os.pathsep + os.environ.get("PATH", ""))
        proc = None
        try:
            proc = runtime.spawn_owned([name], env=env, stdout=-1, stderr=-1)
            out, err = proc.communicate(timeout=4)
            self.assertEqual(proc.returncode, 0, err)
            self.assertIn(b"OWNED_PATH_FIXTURE", out)
            prefix = login.command_prefix({"cli": [name], "env": {"PATH": env["PATH"]}}, "mimocode")
            self.assertEqual(Path(prefix[1]), entry)
        finally:
            runtime.terminate_owned(proc)

    def test_login_interpreter_entry_remains_valid_in_empty_auth_workspace(self):
        entry = self.base / "fixture.py"
        entry.write_text("print('SYNTHETIC_LOCAL_TEST_ONLY')", encoding="utf-8")
        prefix = login.command_prefix({"cli": [sys.executable, "fixture.py"], "cwd": str(self.base)}, "minimaxcode")
        self.assertEqual(Path(prefix[1]), entry)

    def test_configured_login_verifies_its_official_status_command(self):
        manager = login.LoginManager()
        proc = SimpleNamespace(stdin=io.BytesIO(), stdout=io.BytesIO(), poll=lambda: 0, wait=lambda timeout=None: 0)
        session = {"worker": "zcode", "status": "preparing", "deadline": time.monotonic() + 5}
        profile = {"login": {"command": [sys.executable], "status_command": [sys.executable, "synthetic-status"]}}
        try:
            with patch.object(login, "spawn_owned", return_value=proc), patch.object(login, "stop_owned"), patch.object(login, "run_status", return_value=SimpleNamespace(returncode=0)) as verify:
                manager._run(session, [sys.executable], {}, profile, "start")
            self.assertEqual(session["status"], "authenticated")
            verify.assert_called_once_with(profile["login"]["status_command"], {}, 8)
        finally:
            manager.close()

    def test_posix_descendants_receive_kill_when_root_already_exited(self):
        proc = SimpleNamespace(_agenthub_pgid=123456, poll=lambda: 0, wait=lambda timeout=None: 0)
        with patch.object(runtime.os, "killpg", create=True) as killpg, patch.object(signal, "SIGKILL", 9, create=True):
            runtime.terminate_owned(proc)
            self.assertIn((123456, signal.SIGKILL), [call.args for call in killpg.call_args_list])
            calls = killpg.call_count
            runtime.terminate_owned(proc)
            self.assertEqual(killpg.call_count, calls, "Repeated cleanup must not signal a recycled group ID")

    def test_poller_does_not_publish_after_stop(self):
        stop = threading.Event()
        def finish_reader(*args, **kwargs):
            stop.set()
            return "late progress"
        with patch.object(worker, "subprocess_run", side_effect=finish_reader), patch.object(worker, "save") as save:
            worker.progress_poller("fixture", [sys.executable], stop)
            save.assert_not_called()

    def test_invalid_utf8_task_is_a_handled_load_error(self):
        path = self.base / "invalid.task"
        path.write_bytes(b"\xff\xfe")
        with self.assertRaises(RuntimeError):
            worker.load_task_meta(path)

    def test_load_error_has_terminal_result_and_removes_private_task_file(self):
        path = self.base / "invalid.task"
        path.write_bytes(b"\xff\xfe")
        with patch.object(worker, "RESULTS", str(self.base / "results")), patch.object(sys, "argv", ["worker", "cmd", "invalid", str(path)]):
            self.assertEqual(worker.main(), 1)
            self.assertEqual(worker.read_result("invalid")["status"], "error")
            self.assertFalse(path.exists())

    def test_late_progress_cannot_reopen_a_terminal_result(self):
        with patch.object(worker, "RESULTS", str(self.base / "results")):
            worker.save("fixture", status="running", task="synthetic")
            worker.save("fixture", status="completed", text="final synthetic answer")
            worker.save("fixture", only_if_running=True, progress="late synthetic progress")
            result = worker.read_result("fixture")
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["text"], "final synthetic answer")
            self.assertNotIn("progress", result)

    def test_invalid_timeouts_never_spawn(self):
        for value in (0, -1, float("nan"), float("inf")):
            with self.subTest(value=value), patch.object(worker, "spawn_owned") as spawn:
                spawn.return_value.poll.return_value = 0
                with self.assertRaises(ValueError):
                    worker.run_cmd_mode([sys.executable], str(self.base / "fixture.task"), "fixture", timeout_s=value)
                spawn.assert_not_called()

    def test_cli_that_keeps_printing_is_not_cut_by_the_idle_budget(self):
        """长任务只要还在输出就不判超时: timeout_s 是「无进展」预算, 不是总时长。

        回归: 旧实现 deadline = 起始 + 600s 一把刀, Qoder 这类跑十几分钟的
        CLI 会在干到一半时被整组回收 (agent=qoder status=timeout)。
        """
        script = self.base / "chatty.py"
        script.write_text(
            "import time\n"
            "for index in range(20):\n"
            "    print(f'step {index}', flush=True)\n"
            "    time.sleep(0.12)\n"
            "print('DONE', flush=True)\n",
            encoding="utf-8")
        with patch.object(worker, "RESULTS", str(self.base / "results")):
            worker.save("fixture", status="running")
            began = time.monotonic()
            text, code = worker.run_cmd_mode(
                [sys.executable, str(script)], str(self.base / "task"), "fixture", timeout_s=1)
            elapsed = time.monotonic() - began
        self.assertEqual(code, 0)
        self.assertIn("DONE", text)
        # 总耗时远超 idle 预算, 但一直在出字, 所以不该被回收。
        self.assertGreater(elapsed, 1.5)

    def test_silent_cli_times_out_on_idle_budget_and_keeps_partial_output(self):
        script = self.base / "silent.py"
        script.write_text(
            "import time\nprint('PARTIAL-ANSWER', flush=True)\ntime.sleep(30)\n", encoding="utf-8")
        with patch.object(worker, "RESULTS", str(self.base / "results")):
            worker.save("fixture", status="running")
            began = time.monotonic()
            with self.assertRaises(worker.CommandTimeout) as caught:
                worker.run_cmd_mode([sys.executable, str(script)], str(self.base / "task"), "fixture", timeout_s=1.5)
            elapsed = time.monotonic() - began
        self.assertLess(elapsed, 12)
        self.assertEqual(caught.exception.kind, "idle")
        self.assertIn("没有任何新输出", str(caught.exception))
        self.assertIn("PARTIAL-ANSWER", caught.exception.partial)

    def test_hard_cap_stops_a_cli_that_never_ends_while_printing(self):
        script = self.base / "forever.py"
        script.write_text(
            "import time\nwhile True:\n    print('tick', flush=True)\n    time.sleep(0.05)\n",
            encoding="utf-8")
        with patch.object(worker, "RESULTS", str(self.base / "results")):
            worker.save("fixture", status="running")
            began = time.monotonic()
            with self.assertRaises(worker.CommandTimeout) as caught:
                worker.run_cmd_mode([sys.executable, str(script)], str(self.base / "task"), "fixture",
                                    timeout_s=30, hard_timeout_s=2)
            elapsed = time.monotonic() - began
        self.assertLess(elapsed, 12)
        self.assertEqual(caught.exception.kind, "hard")

    def test_timeout_persists_partial_text_and_marks_the_kind(self):
        meta = {"task": None, "cmd": [sys.executable, "-c", "pass"], "callback_url": None,
                "timeout_s": .2, "hard_timeout_s": 5}
        with patch.object(worker, "RESULTS", str(self.base / "results")):
            worker.save("fixture", status="running")
            with patch.object(worker, "load_task_meta", return_value=meta), \
                    patch.object(worker, "push_callback"), \
                    patch.object(worker, "cleanup_taskfile"), \
                    patch.object(sys, "argv", ["worker", "cmd", "fixture", "unused"]), \
                    patch.object(worker, "run_cmd_mode", side_effect=worker.CommandTimeout(
                        "CLI 任务已 900s 没有任何新输出, 判定卡死", kind="idle", partial="PARTIAL-ANSWER")):
                self.assertEqual(worker.main(), 1)
            result = json.loads((self.base / "results" / "fixture.json").read_text(encoding="utf-8"))
        self.assertEqual(result["status"], "timeout")
        self.assertEqual(result["timeout_kind"], "idle")
        self.assertEqual(result["partial_text"], "PARTIAL-ANSWER")
        self.assertIn("可据此续跑", result["text"])

    def test_unknown_mode_never_drives_zcode(self):
        meta = {"task": "synthetic", "cmd": None, "callback_url": None}
        with patch.object(sys, "argv", ["worker", "typo", "fixture", "unused"]), patch.object(worker, "load_task_meta", return_value=meta), patch.object(worker, "save"), patch.object(worker, "read_result", return_value={}), patch.object(worker, "cleanup_taskfile"), patch.object(worker, "zcode_run", return_value="synthetic") as driver:
            self.assertEqual(worker.main(), 2)
            driver.assert_not_called()

    def test_gui_mode_receives_explicit_timeout(self):
        meta = {"task": "synthetic", "cmd": None, "callback_url": None, "timeout_s": .25}
        with patch.object(sys, "argv", ["worker", "zcode", "fixture", "unused"]), patch.object(worker, "load_task_meta", return_value=meta), patch.object(worker, "save", return_value={"status": "running"}), patch.object(worker, "read_result", return_value={}), patch.object(worker, "cleanup_taskfile"), patch.object(worker, "zcode_run", return_value="synthetic") as driver:
            self.assertEqual(worker.main(), 0)
            self.assertEqual(driver.call_args.kwargs.get("timeout"), .25)

    def test_cmd_argv_and_callback_credentials_not_persisted(self):
        meta = {"task": None, "cmd": [sys.executable, "--api-key", "PRIVATE_FIXTURE"], "callback_url": "https://invalid.local/callback?token=PRIVATE_FIXTURE", "timeout_s": 1}
        with patch.object(sys, "argv", ["worker", "cmd", "fixture", "unused"]), patch.object(worker, "load_task_meta", return_value=meta), patch.object(worker, "run_cmd_mode", return_value=("synthetic", 0)), patch.object(worker, "read_result", return_value={}), patch.object(worker, "push_callback"), patch.object(worker, "cleanup_taskfile"), patch.object(worker, "save", return_value={"status": "running"}) as save:
            self.assertEqual(worker.main(), 0)
            self.assertNotIn("PRIVATE_FIXTURE", str(save.call_args_list))

    def test_callback_logging_does_not_expose_url_or_exception_credentials(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), patch.object(worker.urllib.request, "urlopen", side_effect=OSError("token=PRIVATE_FIXTURE")):
            worker.push_callback("https://invalid.local/?token=PRIVATE_FIXTURE", {})
        self.assertNotIn("PRIVATE_FIXTURE", output.getvalue())

    def test_pty_zero_byte_read_is_immediate(self):
        stream = _PtyOutput()
        reader = threading.Thread(target=lambda: stream.read(0), daemon=True)
        reader.start()
        try:
            reader.join(.1)
            self.assertFalse(reader.is_alive())
        finally:
            stream.close()
            reader.join(1)

    def test_reader_cancel_reclaims_its_native_owned_process(self):
        stop, launched = threading.Event(), threading.Event()
        processes, errors = [], []
        original = worker.spawn_owned
        def spawn(*args, **kwargs):
            proc = original(*args, **kwargs)
            processes.append(proc)
            launched.set()
            return proc
        def run():
            try:
                worker.subprocess_run([sys.executable, "-c", "import time; time.sleep(30)"], timeout=20, stop_event=stop)
            except Exception as error:
                errors.append(error)
        reader = threading.Thread(target=run, daemon=True)
        try:
            with patch.object(worker, "spawn_owned", side_effect=spawn):
                reader.start()
                self.assertTrue(launched.wait(2))
                self.assertIsNone(processes[0].poll())
                started = time.monotonic()
                stop.set()
                reader.join(1)
                self.assertFalse(reader.is_alive())
                self.assertLess(time.monotonic() - started, 1)
                self.assertIsInstance(errors[0], worker.CommandCancelled)
                self.assertIsNotNone(processes[0].poll())
        finally:
            stop.set()
            for proc in processes:
                runtime.terminate_owned(proc)
            reader.join(1)

    def test_gui_native_driver_timeout_is_terminal_timeout(self):
        script = self.base / "synthetic_driver.py"
        script.write_text("import time; time.sleep(2)", encoding="utf-8")
        task = self.base / "fixture.task"
        task.write_text(json.dumps({"task": "SYNTHETIC_LOCAL_TEST_ONLY", "timeout_s": .1}), encoding="utf-8")
        started = time.monotonic()
        with patch.object(worker, "RESULTS", str(self.base / "results")), patch.object(worker, "NODE", sys.executable), patch.object(worker, "DOM_DRIVER_ZCODE", str(script)), patch.object(worker, "DOM_READ_ZCODE", str(self.base / "absent")), patch.object(sys, "argv", ["worker", "zcode", "fixture", str(task)]):
            self.assertEqual(worker.main(), 1)
            self.assertEqual(worker.read_result("fixture")["status"], "timeout")
            self.assertLess(time.monotonic() - started, 1)

    def test_closed_login_manager_reclaims_late_spawn_and_rejects_new_flow(self):
        manager = login.LoginManager()
        session = {"worker": "codebuddy", "status": "preparing", "deadline": time.monotonic() + 5}
        manager.sessions["codebuddy"] = session
        proc = SimpleNamespace(stdout=io.BytesIO(), stdin=io.BytesIO(), poll=lambda: 0, wait=lambda timeout=None: 0)
        def spawn(*args, **kwargs):
            manager.close()
            return proc
        try:
            with patch.object(login, "spawn_owned", side_effect=spawn), patch.object(login, "stop_owned") as stop:
                manager._run(session, [sys.executable], {}, {}, "start")
                stop.assert_any_call(proc)
            self.assertEqual(session["status"], "cancelled")
            self.assertEqual(manager.handle("codebuddy", "start", {})["status"], "unavailable")
        finally:
            manager.close()

    def test_posix_login_spawn_failure_closes_both_pty_descriptors(self):
        manager = login.LoginManager()
        fake_os = SimpleNamespace(name="posix", close=unittest.mock.Mock())
        fake_pty = SimpleNamespace(openpty=lambda: (123450, 123451))
        session = {"worker": "minimaxcode", "status": "preparing", "deadline": time.monotonic() + 5}
        try:
            with patch.object(login, "os", fake_os), patch.dict(sys.modules, {"pty": fake_pty}), patch.object(login, "spawn_owned", side_effect=OSError("synthetic launch failure")):
                manager._run(session, [sys.executable], {}, {}, "start")
            self.assertEqual(session["status"], "failed")
            self.assertEqual({call.args[0] for call in fake_os.close.call_args_list}, {123450, 123451})
        finally:
            manager.close()

    def test_malformed_login_protocol_fails_without_exposing_payload(self):
        manager = login.LoginManager()
        proc = SimpleNamespace(stdin=io.BytesIO(), stdout=io.BytesIO(b'{"type":"control_response","response":["PRIVATE_FIXTURE"]}\n'), poll=lambda: 0, wait=lambda timeout=None: 0)
        session = {"worker": "codebuddy", "status": "preparing", "deadline": time.monotonic() + 5}
        try:
            with patch.object(login, "spawn_owned", return_value=proc), patch.object(login, "stop_owned"):
                manager._run(session, [sys.executable], {}, {}, "status")
            self.assertEqual(session["status"], "failed")
            self.assertNotIn("PRIVATE_FIXTURE", json.dumps(manager._reply(session, "status")))
        finally:
            manager.close()

    @contextlib.contextmanager
    def gateway(self, payload, delay=0):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                time.sleep(delay)
                data = json.dumps(payload).encode()
                try:
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .02}, daemon=True)
        thread.start()
        try:
            with patch.object(worker, "GATEWAY", "http://127.0.0.1:" + str(server.server_port)):
                yield
        finally:
            server.shutdown()
            server.server_close()
            thread.join(1)

    def test_trae_timeout_cannot_perform_late_dom_read(self):
        reader = self.base / "reader.js"
        reader.touch()
        original = worker.subprocess_run
        late_reads = []
        def capture(cmd, *args, **kwargs):
            if cmd == [worker.NODE, str(reader)]:
                late_reads.append(cmd)
                return "late read"
            return original(cmd, *args, **kwargs)
        with self.gateway({"data": {"result": {"text": ""}}}, delay=.4), patch.object(worker, "DOM_READ_TRAE", str(reader)), patch.object(worker, "start_progress_poller", return_value=None), patch.object(worker, "subprocess_run", side_effect=capture):
            with self.assertRaises(RuntimeError):
                worker.trae_run("synthetic", "", "fixture", timeout=.1)
            time.sleep(.5)
            self.assertEqual(late_reads, [])

    def test_gateway_error_is_not_empty_completion(self):
        with self.gateway({"error": "SYNTHETIC_GATEWAY_ERROR"}), patch.object(worker, "DOM_READ_TRAE", str(self.base / "absent")), patch.object(worker, "start_progress_poller", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "SYNTHETIC_GATEWAY_ERROR"):
                worker.trae_run("synthetic", "", "fixture", timeout=2)

    def test_gateway_unknown_or_running_is_not_completed_even_with_text(self):
        for status in ("running", "unknown", "pending"):
            with self.subTest(status=status), self.gateway({"data": {"session": {"status": status}, "result": {"text": "partial synthetic text"}}}), patch.object(worker, "start_progress_poller", return_value=None):
                with self.assertRaisesRegex(RuntimeError, "请勿重新派发"):
                    worker.trae_run("synthetic", "", "fixture", timeout=2)

    def test_sync_gateway_override_does_not_start_poller_or_mutate_globals(self):
        original = worker.GATEWAY
        with self.gateway({"data": {"session": {"status": "completed"}, "result": {"text": "final synthetic text"}}}), patch.object(worker, "start_progress_poller") as poller:
            override = worker.GATEWAY
            worker.GATEWAY = original
            try:
                text, _ = worker.trae_run("synthetic", "", "", timeout=2, gateway=override, dom_read="absent", node=sys.executable)
            finally:
                worker.GATEWAY = override
            self.assertEqual(text, "final synthetic text")
            poller.assert_not_called()

    def test_legacy_gateway_accepts_only_nonempty_final_text_without_status(self):
        with self.gateway({"data": {"result": {"text": "legacy synthetic final text"}}}):
            text, _ = worker.trae_run("synthetic", "", "", timeout=2)
            self.assertEqual(text, "legacy synthetic final text")
        with self.gateway({"data": {"result": {"text": ""}}}):
            with self.assertRaisesRegex(RuntimeError, "请勿重新派发"):
                worker.trae_run("synthetic", "", "", timeout=2)

    def test_gateway_accepts_completed_and_ok_status(self):
        for result_status in ("ok", "success", "completed", "done"):
            with self.subTest(result_status=result_status), self.gateway({"data": {"session": {"status": "completed", "sessionId": "sid-123"}, "result": {"status": result_status, "text": "generated answer"}}}):
                text, sid = worker.trae_run("synthetic", "", "", timeout=2)
                self.assertEqual(text, "generated answer")
                self.assertEqual(sid, "sid-123")

    def test_placeholder_reply_is_detected_for_dom_fallback(self):
        # Trae 1.107 的 bridge 会在 ~5s 内把首屏「TRAE 思考中」当最终结果返回
        self.assertTrue(worker._is_placeholder_reply("TRAE\n思考中"))
        self.assertTrue(worker._is_placeholder_reply("  "))
        self.assertTrue(worker._is_placeholder_reply("thinking"))
        self.assertTrue(worker._is_placeholder_reply("生成中"))
        self.assertFalse(worker._is_placeholder_reply("91"))
        self.assertFalse(worker._is_placeholder_reply("思考中……这是足够长的一段真正回答，不应该被当成占位文本。"))


if __name__ == "__main__":
    unittest.main(verbosity=2)

