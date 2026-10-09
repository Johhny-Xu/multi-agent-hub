"""CodeArts CLI boundary regressions; fixtures are not live-provider evidence."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("codearts_cli", ROOT / "drivers/codearts_cli.py")
driver = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(driver)


def event(kind, part=None, **extra):
    return {"type": kind, "sessionID": "session-test", **({"part": part} if part is not None else {}), **extra}


def success(text="answer"):
    return "\n".join(json.dumps(record) for record in [
        event("step_start", {"type": "step-start"}),
        event("text", {"id": "part-test", "type": "text", "text": text, "time": {"end": 1}}),
        event("step_finish", {"type": "step-finish", "reason": "stop"}),
    ])


class CodeArtsDriver(unittest.TestCase):
    def test_exit_zero_auth_error_is_not_success(self):
        result = driver.parse_events("认证失败，没有设置环境变量CODEARTS_CLI_AK/CODEARTS_CLI_SK", "", 0)
        self.assertEqual(result["status"], "blocked_auth")
        self.assertEqual(result["error"]["code"], "CODEARTS_AUTH_REQUIRED")
        self.assertEqual(result["result"], "")

    def test_exit_zero_ide_without_provider_is_blocked(self):
        result = driver.parse_events("", "error: no providers found\nprivate-secret", 0)
        self.assertEqual(result["error"]["code"], "CODEARTS_PROVIDER_UNAVAILABLE")
        self.assertNotIn("private-secret", json.dumps(result))

    def test_success_requires_terminal_stop(self):
        self.assertFalse(driver.parse_events(success(), "", 0)["is_error"])
        pending = success().replace('"stop"', '"tool-calls"')
        self.assertEqual(driver.parse_events(pending, "", 0)["status"], "unknown")
        self.assertTrue(driver.parse_events("", "", 0)["is_error"])
        self.assertTrue(driver.parse_events(success(), "", 1)["is_error"])

    def test_only_public_text_not_reasoning_tools_or_plaintext(self):
        extra = [event("reasoning", {"text": "private thought"}), event("tool_use", {"state": {"output": "private tool"}})]
        result = driver.parse_events("debug-private\n" + "\n".join(map(json.dumps, extra)) + "\n" + success(), "", 0)
        self.assertEqual(result["result"], "answer")
        self.assertNotIn("private", json.dumps(result))

    def test_provider_errors_are_sanitized(self):
        error = json.dumps(event("error", error={"name": "APIError", "data": {"message": "sensitive-header-value"}}))
        result = driver.parse_events(success() + "\n" + error, "", 0)
        self.assertTrue(result["is_error"])
        self.assertNotIn("sensitive-header", json.dumps(result))

    def test_real_answer_can_discuss_authentication_errors(self):
        result = driver.parse_events(success("Authentication required is an error; CODEARTS_CLI_AK is an environment name."), "", 0)
        self.assertFalse(result["is_error"])

    def test_multiple_sessions_fail_closed(self):
        record = event("text", {"id": "other", "text": "other"}, sessionID="different")
        self.assertEqual(driver.parse_events(success() + "\n" + json.dumps(record), "", 0)["error"]["code"], "CODEARTS_MULTIPLE_SESSIONS")

    def test_duplicate_parts_are_not_duplicated(self):
        record = event("text", {"id": "part-test", "text": "answer"})
        self.assertEqual(driver.parse_events(success() + "\n" + json.dumps(record), "", 0)["result"], "answer")

    def test_new_unfinished_step_invalidates_old_completion(self):
        record = event("step_start", {"type": "step-start"})
        self.assertTrue(driver.parse_events(success() + "\n" + json.dumps(record), "", 0)["is_error"])

    def test_unknown_model_is_not_sent_or_fallback(self):
        calls = []
        def fake(command, **kwargs):
            calls.append(command)
            return "provider/available\n", "", 0
        result = driver.run_task(task="secret task", cli=sys.executable, model="provider/missing", capture=fake)
        self.assertEqual(result["status"], "blocked_model")
        self.assertEqual(len(calls), 1)
        self.assertIn("models", calls[0])

    def test_model_match_and_task_stdin_no_resume_or_auto_permission(self):
        calls = []
        def fake(command, **kwargs):
            calls.append((command, kwargs))
            return ("provider/chosen\n", "", 0) if "models" in command else (success(), "", 0)
        task = 'do work & echo "credential"'
        result = driver.run_task(task=task, cli=sys.executable, model="provider/chosen", capture=fake)
        self.assertFalse(result["is_error"])
        command, kwargs = calls[-1]
        self.assertNotIn(task, command)
        self.assertEqual(kwargs["stdin"], task)
        self.assertIn("--pure", command)
        for argument in ("--continue", "--session", "--auto", "--share"):
            self.assertNotIn(argument, command)
        self.assertNotIn("--dir", command)
        self.assertTrue(Path(kwargs["cwd"]).is_dir())
        self.assertEqual(kwargs["env"]["OPENCODE_DISABLE_SHARE"], "true")
        self.assertTrue(Path(kwargs["env"]["OPENCODE_DB"]).is_absolute())

    def test_default_model_is_not_invented(self):
        calls = []
        def fake(command, **kwargs):
            calls.append(command)
            return success(), "", 0
        result = driver.run_task(task="hi", cli=sys.executable, capture=fake)
        self.assertFalse(result["is_error"])
        self.assertEqual(len(calls), 1)
        self.assertNotIn("--model", calls[0])

    def test_official_two_column_catalog_allows_the_selected_model(self):
        # CLI 26.9.12 pads model_id to the longest provider/model plus two
        # spaces, followed by model_name; each provider has its own header.
        def table(rows):
            width = max(len(identifier) for identifier, _ in rows) + 2
            return "\r\n".join([
                "model_id".ljust(width) + "model_name", "-" * (width + 10),
                *(identifier.ljust(width) + name for identifier, name in rows),
            ])
        catalog = table([("other/model", "Other Model")]) + "\r\n" + table([
            ("provider/chosen", "Chosen Model"), ("provider/longer-name", "Longer Model"),
        ])
        calls = []
        def fake(command, **kwargs):
            calls.append(command)
            return (catalog, "", 0) if "models" in command else (success("46"), "", 0)
        result = driver.run_task(task="17+29. Only the number.", cli=sys.executable, model="provider/chosen", capture=fake)
        self.assertEqual(result["result"], "46")
        self.assertEqual(len(calls), 2)

    def test_official_short_ids_have_a_collapsed_header(self):
        for identifier in ("p/m", "ab/mod", "abc/mod"):
            width = len(identifier) + 2
            catalog = ("model_id".ljust(width) + "model_name\n"
                       + "-" * (width + 10) + "\n" + identifier.ljust(width) + "Short Model\n")
            self.assertEqual(driver.parse_model_catalog(catalog), {identifier})

    def test_catalog_rejects_banner_mentions_and_malformed_table_rows(self):
        invalid = [
            "provider/chosen  was mentioned in a diagnostic",  # no table header
            "model_id         model_name\nprovider/chosen  Chosen",  # no ruler
            "model_id         model_name\n---------------------------\nprovider/chosen Chosen",  # only one gap
            "model_id         model_name\n---------------------------\n!provider/chosen Chosen",
            "model_id         model_name\n---------------------------\nwarning: unavailable\nprovider/chosen  Chosen",
        ]
        for catalog in invalid:
            with self.subTest(catalog=catalog):
                calls = []
                def fake(command, **kwargs):
                    calls.append(command)
                    return catalog, "", 0
                result = driver.run_task(task="hi", cli=sys.executable, model="provider/chosen", capture=fake)
                self.assertEqual(result["status"], "blocked_model")
                self.assertEqual(len(calls), 1)

    def test_unsupported_controls_do_not_launch(self):
        def never(*args, **kwargs):
            self.fail("must not start process")
        for control in ({"stream": "on"}, {"thinking": "on"}, {"thinking": "off"}):
            self.assertTrue(driver.run_task(task="hi", cli=sys.executable, capture=never, **control)["is_error"])

    def test_text_attachments_validate_and_images_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            text = root / "input.md"
            text.write_text("你好", encoding="utf-8")
            self.assertEqual(driver._validate_files([str(text)]), [str(text.resolve())])
            for name, data in [("picture.png", b"png"), ("auth.json", b"{}"), ("binary.txt", b"a\x00b"), ("not-utf8.txt", b"\xff\xfe")]:
                file = root / name
                file.write_bytes(data)
                with self.assertRaises(driver.AdapterError):
                    driver._validate_files([str(file)])

    def test_discovery_uses_codearts_not_opencode(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            kernel = root / ".codeartsdoer/CodeArts_Agent/AgentKernel_test.exe"
            kernel.parent.mkdir(parents=True)
            kernel.write_bytes(b"fixture")
            self.assertEqual(driver.discover_cli(home=root, env={"PATH": ""}), str(kernel))
            self.assertIsNone(driver.discover_cli(home=root, env={"PATH": "", "AGENTHUB_CODEARTS_CLI": str(root / "missing")}))

    def test_kernel_env_keeps_credentials_external_and_isolates_database(self):
        result = driver.runtime_environment(Path("AgentKernel_test.exe"), Path("/runtime"), home=Path("/home/test"), env={"CODEARTS_CLI_AK": "fixture-external", "OPENCODE_AUTO_SHARE": "true"})
        self.assertEqual(result["SCENARIO"], "codeartsdoer")
        self.assertEqual(result["CODEARTS_CLI_AK"], "fixture-external")
        self.assertNotIn("OPENCODE_AUTO_SHARE", result)
        self.assertEqual(Path(result["OPENCODE_DB"]).name, "session.db")

    def test_worker_identity_is_set_for_both_launchers(self):
        for filename in ("codearts", "AgentKernel_test.exe"):
            result = driver.runtime_environment(Path(filename), Path("/runtime"), env={"AGENTHUB_WORKER_ID": "something-else"})
            self.assertEqual(result["AGENTHUB_WORKER_ID"], "codearts")

    def test_timeout_kills_only_owned_process(self):
        with self.assertRaises(driver.AdapterError) as raised:
            driver._capture([sys.executable, "-c", "import time;time.sleep(30)"], cwd=str(ROOT), env=dict(driver.os.environ), timeout=0.1)
        self.assertEqual(raised.exception.code, "CODEARTS_TIMEOUT")

    def test_hub_parser_understands_envelope(self):
        sys.path.insert(0, str(ROOT / "hub"))
        from output_parser import parse_output
        parsed = parse_output(json.dumps(driver.envelope("blocked_auth", code="CODEARTS_AUTH_REQUIRED")))
        self.assertEqual(parsed["text"], "")
        self.assertEqual(parsed["error"], "CODEARTS_AUTH_REQUIRED")
        self.assertEqual(parse_output(json.dumps(driver.parse_events(success(), "", 0)))["text"], "answer")


if __name__ == "__main__":
    unittest.main(verbosity=2)
