"""Hub state, task ownership and real HTTP regressions; no vendor calls."""
import contextlib
import http.client
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
import agent_hub as hub
import trae_mcp_server as trae
from result_store import read_result, update_result
from state_store import StateFileLock, safe_component


class HubCoreRegressions(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agenthub-core-")
        self.base = Path(self.temp.name)
        self.stack = contextlib.ExitStack()
        for name, value in {"STATE": self.base / "state", "RESULTS_DIR": str(self.base / "results"),
                            "AGENTS_JSON": self.base / "agents.json"}.items():
            self.stack.enter_context(patch.object(hub, name, value))
        hub.AGENTS_JSON.write_text(json.dumps({"agents": {"codebuddy": {"cli": None}}}), encoding="utf-8")

    def tearDown(self):
        self.stack.close()
        self.temp.cleanup()

    def task(self):
        hub.tool_hub_post_task({"from_agent": "owner", "to_agent": "cb", "title": "fixture"})
        return json.loads((hub.STATE / "tasks.json").read_text(encoding="utf-8"))["tasks"][0]["id"]

    def test_production_http_port_cannot_be_bound_by_a_second_process(self):
        for handler in (hub._HTTPHandler, trae.Handler):
            with self.subTest(service=handler.__name__):
                server = hub.HubHTTPServer(("127.0.0.1", 0), handler)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                port = server.server_port
                script = "import sys; sys.path.insert(0,sys.argv[1]); import agent_hub as h; import trae_mcp_server as t; handler=h._HTTPHandler if sys.argv[3]=='hub' else t.Handler\ntry:\n s=h.HubHTTPServer(('127.0.0.1',int(sys.argv[2])),handler)\nexcept OSError:\n print('BLOCKED')\nelse:\n s.server_close(); print('SECOND_LISTENER'); sys.exit(1)\n"
                try:
                    child = subprocess.run([sys.executable, "-c", script, str(ROOT / "hub"), str(port), "hub" if handler is hub._HTTPHandler else "trae"], capture_output=True, text=True, timeout=5)
                    self.assertEqual(child.returncode, 0, child.stderr)
                    self.assertEqual(child.stdout.strip(), "BLOCKED")
                    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
                    try:
                        connection.request("GET", "/health")
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        self.assertEqual(json.loads(response.read())["status"], "ok")
                    finally:
                        connection.close()
                finally:
                    server.shutdown(); server.server_close(); thread.join(timeout=2)

    def test_transient_result_sharing_failure_preserves_existing_metadata(self):
        original = {'agent': 'fixture-worker', 'status': 'running', 'task': 'original task'}
        with patch.object(Path, 'read_text', side_effect=[PermissionError('busy'), json.dumps(original)]):
            result = update_result(hub.RESULTS_DIR, 'sharing-fixture', {'progress': 'new text'})
        self.assertEqual(result['agent'], 'fixture-worker')
        self.assertEqual(result['task'], 'original task')
        self.assertEqual(read_result(hub.RESULTS_DIR, 'sharing-fixture')['progress'], 'new text')

    def test_corrupt_existing_result_is_never_overwritten_as_empty_state(self):
        path = Path(hub.RESULTS_DIR) / 'corrupt.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{broken fixture', encoding='utf-8')
        with self.assertRaises(RuntimeError):
            update_result(hub.RESULTS_DIR, 'corrupt', {'progress': 'new text'})
        self.assertEqual(path.read_text(encoding='utf-8'), '{broken fixture')

    def test_completion_requires_claim_owner_and_cannot_rewrite_terminal(self):
        tid = self.task()
        hub.tool_hub_complete_task({"task_id": tid, "agent": "cb", "result": "premature"})
        self.assertEqual(json.loads((hub.STATE / "tasks.json").read_text(encoding="utf-8"))["tasks"][0]["status"], "open")
        hub.tool_hub_claim_task({"task_id": tid, "agent": "CB"})
        hub.tool_hub_complete_task({"task_id": tid, "agent": "wrong", "result": "wrong"})
        hub.tool_hub_complete_task({"task_id": tid, "agent": "cb", "result": "failed fixture", "success": "false"})
        hub.tool_hub_complete_task({"task_id": tid, "agent": "cb", "result": "overwrite"})
        task = json.loads((hub.STATE / "tasks.json").read_text(encoding="utf-8"))["tasks"][0]
        self.assertEqual((task["status"], task["result"], task["claimed_by"]), ("failed", "failed fixture", "codebuddy"))

    def test_invalid_task_mailbox_is_rejected_before_queue_mutation(self):
        with self.assertRaises(ValueError):
            hub.tool_hub_post_task({"from_agent": "owner", "to_agent": "../outside", "title": "bad"})
        self.assertFalse((hub.STATE / "tasks.json").exists())

    def test_mailbox_marks_only_delivered_messages_and_respects_false(self):
        for i in range(65):
            hub._mail_push("codebuddy", "fixture", str(i))
        first = hub.tool_hub_read_messages({"agent": "cb", "mark_read": "false"})
        self.assertIn("65 条未读", first)
        hub.tool_hub_read_messages({"agent": "cb"})
        second = hub.tool_hub_read_messages({"agent": "cb"})
        self.assertIn("15 条未读", second)
        self.assertIn("fixture: 64", second)

    def test_external_refs_cannot_escape_state_directory(self):
        for name in ["../outside", "..\\outside", "C:outside", "NUL", "x.", "x\n"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                safe_component(name)
        with self.assertRaises(ValueError):
            hub.tool_hub_result({"ref": "../outside"})

    def test_reaper_does_not_overwrite_new_progress_or_completion(self):
        update_result(hub.RESULTS_DIR, "fixture", {"status": "running", "updated_at": 0})
        snapshot = read_result(hub.RESULTS_DIR, "fixture")
        # Simulate a stale Hub snapshot while the worker has written a terminal state.
        snapshot["updated_at"] = 0
        update_result(hub.RESULTS_DIR, "fixture", {"status": "completed", "text": "done"})
        result = hub._reap_result(snapshot)
        self.assertEqual((result["status"], result["text"]), ("completed", "done"))
        update_result(hub.RESULTS_DIR, "fixture", {"status": "running", "progress": "fresh"})
        self.assertEqual(hub._reap_result(snapshot)["progress"], "fresh")

    def test_multiple_process_result_updates_do_not_lose_fields(self):
        code = "import sys;sys.path.insert(0,sys.argv[1]);from result_store import update_result;update_result(sys.argv[2],'shared',{sys.argv[3]:True})"
        procs = [subprocess.Popen([sys.executable, "-c", code, str(ROOT / "hub"), hub.RESULTS_DIR, f"field{i}"],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.PIPE) for i in range(8)]
        for proc in procs:
            _, err = proc.communicate(timeout=10)
            self.assertEqual(proc.returncode, 0, err)
        result = read_result(hub.RESULTS_DIR, "shared")
        self.assertTrue(all(result.get(f"field{i}") for i in range(8)))

    def test_file_lock_times_out_without_stealing_live_owner(self):
        path = self.base / "owned.lock"
        code = "import sys;sys.path.insert(0,sys.argv[1]);from state_store import StateFileLock;\nwith StateFileLock(sys.argv[2],.15): print('stolen')"
        with StateFileLock(path):
            proc = subprocess.run([sys.executable, "-c", code, str(ROOT / "hub"), str(path)], capture_output=True, timeout=4)
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn(b"TimeoutError", proc.stderr)
        with StateFileLock(path, .2):
            pass
        self.assertTrue(path.exists())

    def test_unknown_ref_returns_immediately_with_unknown_status(self):
        start = time.monotonic()
        self.assertIn("status=unknown", hub.tool_hub_wait_result({"ref": "absent", "wait_s": 10}))
        self.assertLess(time.monotonic() - start, 1)

    def test_spawn_failure_leaves_terminal_result_without_task_metadata(self):
        with patch.object(hub.subprocess, "Popen", side_effect=OSError("fixture spawn failure")):
            with self.assertRaises(RuntimeError):
                hub._start_async("fixture", "cmd", "task", {"cmd": ["secret"], "callback_url": "secret"})
        paths = list(Path(hub.RESULTS_DIR).glob("*.json"))
        self.assertEqual(len(paths), 1)
        result = json.loads(paths[0].read_text(encoding="utf-8"))
        self.assertEqual(result["status"], "error")
        self.assertNotIn("cmd", result)
        self.assertFalse(list(Path(hub.RESULTS_DIR).glob("*.task")))

    def test_real_async_cli_keeps_worker_identity_and_task_context(self):
        hub.AGENTS_JSON.write_text(json.dumps({"agents": {"codebuddy": {
            "cli": [sys.executable, "-c", "print('ASYNC_IDENTITY_FIXTURE')"], "async_default": True,
            "env": {"CODEBUDDY_CONFIG_DIR": str(self.base / "isolated-codebuddy")}
        }}}), encoding="utf-8")
        reply = hub.tool_hub_dispatch_cli({"agent": "cb", "task": "original task", "timeout_s": 2})
        ref = re.search(r"\[codebuddy/([^\]]+)\]", reply)[1]
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            result = read_result(hub.RESULTS_DIR, ref)
            if result and result.get("status") != "running":
                break
            time.sleep(.02)
        self.assertEqual((result["status"], result["agent"], result["task"]), ("completed", "codebuddy", "original task"))
        self.assertIn("ASYNC_IDENTITY_FIXTURE", result["text"])
        # Terminal result visibility precedes optional availability metadata
        # and worker exit. Join this task's reaper before deleting its state.
        for thread in threading.enumerate():
            if thread.name == "hub-worker-" + ref:
                thread.join(timeout=5)
                self.assertFalse(thread.is_alive(), "Owned worker must finish cleanup")

    def test_gui_timeout_is_passed_to_async_metadata(self):
        with patch.object(hub, "_start_async", return_value="fixture") as spawn:
            hub.tool_trae_delegate({"task": "fixture", "wait": "false", "timeout_s": 1.25})
            self.assertEqual(spawn.call_args.args[3]["timeout_s"], 1.25)
            hub.tool_zcode_delegate({"task": "fixture", "wait": False, "timeout_s": .5})
            self.assertEqual(spawn.call_args.args[3]["timeout_s"], .5)

    def test_invalid_timeout_never_launches_gui_worker(self):
        with patch.object(hub, "_start_async") as spawn:
            for value in (True, 0, -1, float("nan"), float("inf")):
                for fn in (hub.tool_trae_delegate, hub.tool_zcode_delegate):
                    with self.subTest(value=value, fn=fn.__name__), self.assertRaises(ValueError):
                        fn({"task": "fixture", "wait": False, "timeout_s": value})
            spawn.assert_not_called()

    @unittest.skipUnless(shutil.which("node"), "Node fixture required")
    def test_sync_zcode_nonzero_exit_reports_diagnostic(self):
        script = self.base / "driver.mjs"
        script.write_text("console.error('FIXTURE_DRIVER_FAILURE');process.exit(7)", encoding="utf-8")
        with patch.object(hub, "ZCODE_DOM_DRIVER", str(script)):
            reply = hub.tool_zcode_delegate({"task": "fixture", "timeout_s": 2})
        self.assertIn("status=error exit=7", reply)
        self.assertIn("FIXTURE_DRIVER_FAILURE", reply)
        self.assertEqual(read_result(hub.RESULTS_DIR, "zcode-last")["exit_code"], 7)

    @unittest.skipUnless(shutil.which("node"), "Node fixture required")
    def test_sync_zcode_hanging_driver_has_bounded_timeout(self):
        script = self.base / "hang.mjs"
        script.write_text("setInterval(()=>{},1000)", encoding="utf-8")
        start = time.monotonic()
        with patch.object(hub, "ZCODE_DOM_DRIVER", str(script)):
            reply = hub.tool_zcode_delegate({"task": "fixture", "timeout_s": .15})
        self.assertIn("status=timeout", reply)
        self.assertLess(time.monotonic() - start, 2)

    def test_malformed_rpc_is_rejected_and_notifications_have_no_side_effects(self):
        for adapter in (hub, trae):
            for req in ([], {"jsonrpc": "2.0", "id": True, "method": "ping"}, {"jsonrpc": "2.0", "id": 1}):
                self.assertEqual(adapter.handle_request(req)["error"]["code"], -32600)
            for params in (0, "", [], None):
                self.assertEqual(adapter.handle_request({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": params})["error"]["code"], -32602)
        with patch.dict(hub.HANDLERS, {"fixture": [lambda _: self.fail("notification executed")]}):
            self.assertIsNone(hub.handle_request({"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "fixture"}}))

    def test_trae_scoped_server_does_not_expose_hub_write_tools(self):
        reply = trae.handle_request({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertNotIn("hub_post_task", {entry["name"] for entry in reply["result"]["tools"]})

    def test_http_notification_keepalive_cors_auth_and_body_limit(self):
        self.stack.enter_context(patch.object(hub, "HUB_TOKEN", "fixture-token"))
        self.stack.enter_context(patch.object(trae, "TOKEN", "fixture-token"))
        for handler in (hub._HTTPHandler, trae.Handler):
            server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            try:
                conn.request("POST", "/mcp", json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}), {"Authorization": "Bearer fixture-token"})
                response = conn.getresponse()
                self.assertEqual((response.status, response.read()), (202, b""))
                conn.request("POST", "/mcp", json.dumps({"jsonrpc": "2.0", "id": 2, "method": "ping"}), {"Authorization": "Bearer fixture-token"})
                response = conn.getresponse()
                self.assertEqual(json.loads(response.read())["id"], 2)
                conn.request("OPTIONS", "/mcp")
                response = conn.getresponse(); response.read()
                self.assertIn("Authorization", response.getheader("Access-Control-Allow-Headers"))
                captured = io.StringIO()
                with contextlib.redirect_stderr(captured):
                    conn.request("POST", "/mcp?token=fixture-token", json.dumps({"jsonrpc": "2.0", "id": 3, "method": "ping"}))
                    response = conn.getresponse(); response.read()
                self.assertNotIn("fixture-token", captured.getvalue())
                for rejected_body in ("unread fixture body", "x" * 131072, ""):
                    conn.request("POST", "/mcp", rejected_body)
                    response = conn.getresponse()
                    self.assertEqual(json.loads(response.read()), {"error": "unauthorized"})
                    self.assertEqual(response.status, 401)
                    self.assertEqual(response.getheader("Connection"), "close")
                conn.request("POST", "/mcp", b"", {"Authorization": "Bearer fixture-token", "Content-Length": "-1"})
                response = conn.getresponse()
                self.assertEqual((response.status, response.read()), (413, b""))
            finally:
                conn.close(); server.shutdown(); server.server_close(); thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
