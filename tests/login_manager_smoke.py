"""Login contract checks using fake CLI processes; no network or real credentials."""
import io
import json
import queue
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hub"))
import login_manager as login


class FakeProcess:
    def __init__(self, messages):
        self.stdin = io.BytesIO()
        self.stdout = io.BytesIO(b"".join((json.dumps(message) + "\n").encode() for message in messages))
        self.pid = 123456789

    def poll(self):
        return 0

    def wait(self, timeout=None):
        return 0


class FakeTimer:
    def __init__(self, interval, callback):
        self.callback = callback

    def start(self):
        pass

    def cancel(self):
        pass


class ReactiveProcess(FakeProcess):
    """Reply using the request IDs emitted by either official transport."""
    def __init__(self):
        super().__init__([])
        self.lines = queue.Queue()
        self.sent = []
        self.stdout = self
        self.stdin = self

    def emit(self, message):
        self.lines.put((json.dumps(message) + "\n").encode())

    def readline(self):
        try:
            return self.lines.get(timeout=0.2)
        except queue.Empty:
            return b""

    def write(self, raw):
        message = json.loads(raw)
        self.sent.append(message)
        if message.get("type") == "control_request":
            subtype = message.get("request", {}).get("subtype")
            if subtype == "initialize":
                self.emit({"type": "control_response", "response": {"request_id": message["request_id"], "subtype": "success", "response": {"account": None}}})
            elif subtype == "authenticate":
                self.emit({"type": "control_request", "request_id": "url-callback", "request": {"subtype": "auth_url_callback", "authState": {"authUrl": "https://copilot.tencent.com/login?state=PUBLIC_EXAMPLE"}}})
                self.emit({"type": "control_request", "request_id": "result-callback", "request": {"subtype": "auth_result_callback", "success": True, "userinfo": {"token": "FAKE_SECRET"}}})
        elif message.get("method") == "initialize":
            self.emit({"jsonrpc": "2.0", "id": message["id"], "result": {"protocolVersion": 1, "authMethods": [{"id": "internal"}]}})
        elif message.get("method") == "authenticate":
            self.emit({"jsonrpc": "2.0", "method": "_codebuddy.ai/authUrl", "params": {"authUrl": "https://copilot.tencent.com/login?state=PUBLIC_EXAMPLE", "provider": "external"}})
            self.emit({"jsonrpc": "2.0", "id": message["id"], "result": {"_meta": {"codebuddy.ai/userinfo": {"token": "FAKE_SECRET"}}}})

    def flush(self):
        pass


class LoginContractTests(unittest.TestCase):
    def setUp(self):
        self.manager = login.LoginManager()

    def tearDown(self):
        self.manager.close()

    def test_vendor_url_allowlist_and_credential_parameters(self):
        official = "https://www.codebuddy.ai/login?platform=CLI&state=PUBLIC_EXAMPLE"
        self.assertEqual(login.safe_url(official, "codebuddy"), official)
        self.assertEqual(login.safe_url("https://github.com/login/device", "github-copilot"), "https://github.com/login/device")
        for url in [
            "http://www.codebuddy.ai/login",
            "https://www.codebuddy.ai.attacker.invalid/login",
            "https://user:password@www.codebuddy.ai/login",
            "https://www.codebuddy.ai/login#access_token=FAKE_SECRET",
            "https://www.codebuddy.ai/login?access_token=FAKE_SECRET",
            "https://www.codebuddy.ai/login?%74oken=FAKE_SECRET",
            "https://www.codebuddy.ai/login?password=FAKE_SECRET",
            "https://www.codebuddy.ai/login?authorization=FAKE_SECRET",
        ]:
            with self.subTest(url=url):
                self.assertIsNone(login.safe_url(url, "codebuddy"))

    def test_codebuddy_environments_stay_separate(self):
        home = str(Path.home())
        with patch.dict(login.os.environ, {"CODEBUDDY_CONFIG_DIR": "inherited-international-directory", "USERPROFILE": home, "HOME": home}, clear=True):
            intl = login.worker_env({}, "codebuddy")
            cn = login.worker_env({}, "codebuddy-cn")
        self.assertNotEqual(intl["CODEBUDDY_CONFIG_DIR"], cn["CODEBUDDY_CONFIG_DIR"])
        self.assertEqual(cn["CODEBUDDY_INTERNET_ENVIRONMENT"], "internal")
        custom = str(Path.home() / ".agenthub-test-codebuddy-cn")
        cn = login.worker_env({"env": {"CODEBUDDY_CONFIG_DIR": custom}}, "codebuddy-cn")
        self.assertEqual(cn["CODEBUDDY_CONFIG_DIR"], custom)

    def test_mimo_exit_zero_requires_official_provider_label(self):
        class StatusProcess(FakeProcess):
            returncode = 0
            def communicate(self, timeout=None):
                return self.output, b""
        for output, expected in ((b"Not logged in. Run mimo auth login", "unknown"),
                                 (b"", "unknown"),
                                 (b"Provider: MiMo\nUser ID: PRIVATE_USER", "authenticated")):
            process = StatusProcess([])
            process.output = output
            with patch.object(login, "command_prefix", return_value=[sys.executable]), patch.object(login, "spawn_owned", return_value=process):
                reply = self.manager.handle("mimocode", "status", {})
            self.assertEqual(reply["status"], expected)
            self.assertNotIn("PRIVATE_USER", json.dumps(reply))

    def test_repeated_start_reuses_flow_cancel_drops_link_and_private_fields(self):
        session = {
            "worker": "codebuddy", "status": "awaiting_user", "deadline": time.monotonic() + 30,
            "login_url": "https://www.codebuddy.ai/login?state=PUBLIC_EXAMPLE", "user_code": "ABCD-EFGH",
            "token": "FAKE_SECRET", "account": {"token": "FAKE_SECRET"}, "userinfo": {"token": "FAKE_SECRET"},
        }
        self.manager.sessions["codebuddy"] = session
        with patch.object(login, "command_prefix") as command, patch.object(login, "stop_owned") as stop:
            first = self.manager.handle("codebuddy", "start", {})
            second = self.manager.handle("codebuddy", "start", {})
            self.assertEqual(first["login_url"], second["login_url"])
            self.assertFalse(command.called)
            self.assertNotIn("FAKE_SECRET", json.dumps(first))
            cancelled = self.manager.handle("codebuddy", "cancel", {})
            self.assertEqual(cancelled["status"], "cancelled")
            self.assertNotIn("login_url", cancelled)
            self.assertNotIn("user_code", cancelled)
            self.assertTrue(stop.called)

    def test_expiry_stops_owned_flow_and_hides_stale_url(self):
        self.manager.sessions["codebuddy"] = {
            "worker": "codebuddy", "status": "awaiting_user", "deadline": time.monotonic() - 1,
            "login_url": "https://www.codebuddy.ai/login?state=PUBLIC_EXAMPLE",
        }
        with patch.object(login, "stop_owned") as stop, patch.object(login, "command_prefix", side_effect=FileNotFoundError):
            result = self.manager.handle("codebuddy", "status", {})
            self.assertTrue(stop.called)
            self.assertNotIn("login_url", result)
            self.assertNotEqual(result["status"], "authenticated")

    def test_unknown_and_manual_workers_never_spawn(self):
        with patch.object(login.subprocess, "Popen") as popen:
            self.assertFalse(self.manager.handle("unknown", "start", {})["ok"])
            self.assertFalse(self.manager.handle("codebuddy", "execute", {})["ok"])
            self.assertEqual(self.manager.handle("zcode", "start", {})["status"], "unavailable")
            self.assertEqual(self.manager.handle("antigravity", "status", {})["status"], "manual_required")
            self.assertFalse(popen.called)

    def test_codebuddy_status_reads_only_account_presence(self):
        process = FakeProcess([{
            "type": "control_response", "response": {
                "request_id": "hub-login-init", "subtype": "success",
                "response": {"account": {"token": "FAKE_SECRET", "nickname": "PRIVATE_NICKNAME"}},
            },
        }])
        session = {"worker": "codebuddy", "status": "preparing", "deadline": time.monotonic() + 10}
        with patch.object(login, "spawn_owned", return_value=process), patch.object(login.threading, "Timer", FakeTimer):
            self.manager._run(session, [sys.executable], {}, {}, "status")
        reply = self.manager._reply(session, "status")
        self.assertEqual(reply["status"], "authenticated")
        self.assertNotIn("FAKE_SECRET", json.dumps(reply))
        self.assertNotIn("PRIVATE_NICKNAME", json.dumps(reply))
        self.assertNotIn("account", session)
        sent = [json.loads(line) for line in process.stdin.getvalue().splitlines()]
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["request"]["subtype"], "initialize")

    def test_codebuddy_authentication_callbacks_never_publish_userinfo(self):
        processes = []
        commands = []

        def spawn(*args, **kwargs):
            commands.append(args[0])
            process = ReactiveProcess()
            processes.append(process)
            return process

        session = {"worker": "codebuddy-cn", "status": "preparing", "deadline": time.monotonic() + 10}
        with patch.object(login, "spawn_owned", side_effect=spawn), patch.object(login.threading, "Timer", FakeTimer):
            self.manager._run(session, [sys.executable], {}, {}, "start")
        self.assertEqual(session["status"], "authenticated")
        reply = self.manager._reply(session, "status")
        self.assertNotIn("FAKE_SECRET", json.dumps(reply))
        self.assertNotIn("userinfo", session)
        self.assertNotIn("login_url", reply)
        self.assertTrue(any(message.get("method") == "authenticate" or message.get("request", {}).get("subtype") == "authenticate" for process in processes for message in process.sent))
        self.assertTrue(any("--acp" in command for command in commands))
        self.assertTrue(any(message.get("method") == "authenticate" and message["params"]["methodId"] == "internal" for process in processes for message in process.sent))

    def test_acp_url_notification_is_public_until_auth_error(self):
        session = {"worker": "codebuddy-cn", "status": "preparing", "deadline": time.monotonic() + 10}
        snapshots = []

        class Process(FakeProcess):
            def __init__(self):
                super().__init__([
                    {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": 1}},
                    {"jsonrpc": "2.0", "method": "_codebuddy.ai/authUrl", "params": {"authUrl": "https://copilot.tencent.com/login?state=PUBLIC_EXAMPLE", "token": "FAKE_SECRET"}},
                    {"jsonrpc": "2.0", "id": 2, "error": {"message": "Do not publish token=FAKE_SECRET"}},
                ])
                self.source = self.stdout
                self.stdout = self

            def readline(self):
                snapshots.append(self_outer.manager._reply(session, "status"))
                return self.source.readline()

        self_outer = self
        process = Process()
        with patch.object(login, "spawn_owned", return_value=process):
            self.manager._codebuddy_acp(session, [sys.executable], {})
        waiting = next(snapshot for snapshot in snapshots if snapshot["status"] == "awaiting_user")
        self.assertEqual(waiting["login_url"], "https://copilot.tencent.com/login?state=PUBLIC_EXAMPLE")
        self.assertNotIn("FAKE_SECRET", json.dumps(waiting))
        reply = self.manager._reply(session, "status")
        self.assertEqual(reply["status"], "failed")
        self.assertNotIn("login_url", reply)
        self.assertNotIn("FAKE_SECRET", json.dumps(reply))

    def test_expiry_terminates_current_acp_process_after_transport_switch(self):
        timers = []
        expired_processes = []

        class Timer(FakeTimer):
            def __init__(self, interval, callback):
                super().__init__(interval, callback)
                timers.append(self)

        class ExpiringProcess(FakeProcess):
            def __init__(self):
                super().__init__([])
                self.stdout = self

            def readline(self):
                before = stop.call_count
                timers[0].callback()
                expired_processes.append(stop.call_args_list[before].args[0])
                return b""

        current = ExpiringProcess()

        def spawn(command, **kwargs):
            return current if "--acp" in command else ReactiveProcess()

        session = {"worker": "codebuddy-cn", "status": "preparing", "deadline": time.monotonic() + 10}
        with patch.object(login, "spawn_owned", side_effect=spawn), patch.object(login.threading, "Timer", Timer), patch.object(login, "stop_owned") as stop:
            self.manager._run(session, [sys.executable], {}, {}, "start")
        self.assertEqual(session["status"], "expired")
        self.assertEqual(expired_processes, [current])

    def test_cancel_during_spawn_reclaims_late_process_without_reading(self):
        class LateProcess(FakeProcess):
            def __init__(self):
                super().__init__([])
                self.stdout = self
            def readline(self):
                raise AssertionError("Cancelled late process must never enter a blocking read")
        for acp in (False, True):
            session = {"worker": "codebuddy", "status": "preparing", "deadline": time.monotonic() + 10}
            process = LateProcess()
            def spawn(*args, **kwargs):
                session["status"] = "cancelled"
                return process
            with patch.object(login, "spawn_owned", side_effect=spawn), patch.object(login, "stop_owned") as stop:
                if acp:
                    self.manager._codebuddy_acp(session, [sys.executable], {})
                else:
                    self.manager._run(session, [sys.executable], {}, {}, "start")
                stop.assert_any_call(process)
            self.assertEqual(session["status"], "cancelled")
            self.assertIsNone(session.get("process"))

    def test_callbacks_cannot_reactivate_cancelled_flow(self):
        session = {"worker": "codebuddy", "status": "cancelled"}
        self.assertFalse(self.manager._transition(session, status="awaiting_user", login_url="https://www.codebuddy.ai/login"))
        self.assertEqual(session["status"], "cancelled")
        self.assertNotIn("login_url", session)


if __name__ == "__main__":
    unittest.main(verbosity=2)
