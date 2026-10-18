"""Actual subprocess input plus local capability/failure state; no model calls."""
import base64
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
import agent_hub as hub
import async_worker as worker
from availability_store import BLOCKING, REASONS, classify_failure, local_availability, recorded, record_outcome, refresh, signature
from output_parser import parse_output
from task_contract import capabilities, cleanup_attachments, prepare_task, public_model_capabilities


class CapabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agenthub-capability-v2-")
        self.base = Path(self.temp.name)
        self.profile = {"cli": [sys.executable, "-c", "pass"], "model_arg": "--model", "models": {"default": "first", "alias": "first", "second": "second"}}

    def tearDown(self):
        self.temp.cleanup()

    def test_per_model_and_os_override_does_not_leak_command_or_environment(self):
        profile = dict(self.profile, env={"PRIVATE_SECRET": "SYNTHETIC_NOT_PUBLIC"}, capabilities={
            "platforms": {"linux": {"attachments": {"file": {"mode": "inline_text"}}}},
            "models": {"first": {"thinking": {"off": {"args": [], "env": {"PRIVATE_SECRET": "SYNTHETIC_NOT_PUBLIC"}}}}}})
        self.assertEqual(capabilities("fixture", profile, "first", "linux")["attachments"]["file"]["mode"], "inline_text")
        config = self.base / "agents.json"
        config.write_text(json.dumps({"agents": {"fixture": profile}}))
        with patch.object(hub, "AGENTS_JSON", config), patch.object(hub, "STATE", self.base / "state"):
            reply = json.loads(hub.tool_hub_capabilities({"worker": "fixture"}))
        self.assertEqual(reply["schema_version"], 2)
        models = {item["id"]: item for item in reply["workers"]["fixture"]["models"]}
        self.assertIn("off", models["first"]["thinking"]["allowed"])
        self.assertNotIn("off", models["second"]["thinking"]["allowed"])
        self.assertNotIn("SYNTHETIC_NOT_PUBLIC", json.dumps(reply))
        self.assertNotIn(sys.executable, json.dumps(reply))

    def test_auth_failure_is_expiring_and_refresh_never_launches_a_process(self):
        state = self.base / "state"
        record_outcome(state, "fixture", "first", "error", "401 authentication required SECRET_NOT_STORED", signature(self.profile))
        self.assertFalse(local_availability("fixture", self.profile, "first", state)["enabled"])
        self.assertNotIn("SECRET_NOT_STORED", (state / "availability.json").read_text())
        config = self.base / "agents.json"; config.write_text(json.dumps({"agents": {"fixture": self.profile}}))
        with patch.object(hub, "AGENTS_JSON", config), patch.object(hub, "STATE", state), patch.object(hub, "spawn_owned") as launch:
            reply = json.loads(hub.tool_hub_capabilities({"worker": "fixture", "model": "alias", "refresh": True}))
            launch.assert_not_called()
        self.assertTrue(reply["workers"]["fixture"]["models"][0]["availability"]["enabled"])
        record_outcome(state, "fixture", "first", "error", "Invalid API Key", signature(self.profile))
        with patch("availability_store.time.time", return_value=time.time() + 3601):
            self.assertTrue(local_availability("fixture", self.profile, "first", state)["enabled"])

    def test_empty_answer_and_timeout_do_not_disable_a_model(self):
        for status, text in (("error", "CLI 已退出但没有可验证的回答"), ("timeout", "deadline")):
            record_outcome(self.base, "fixture", "first", status, text, signature(self.profile))
            value = local_availability("fixture", self.profile, "first", self.base)
            self.assertTrue(value["enabled"])
            self.assertIn(value["last_failure"]["code"], {"empty_answer", "timeout"})

    def test_failures_are_model_and_profile_scoped_and_success_clears(self):
        record_outcome(self.base, "fixture", "first", "error", "model first not found", signature(self.profile))
        self.assertTrue(local_availability("fixture", self.profile, "second", self.base)["enabled"])
        changed = dict(self.profile, cli=[sys.executable, "-c", "print(37)"])
        self.assertTrue(local_availability("fixture", changed, "first", self.base)["enabled"])
        record_outcome(self.base, "fixture", "first", "completed", "answer")
        self.assertTrue(local_availability("fixture", self.profile, "first", self.base)["enabled"])

    def test_missing_cli_or_unselected_zcode_model_is_clear(self):
        self.assertEqual(local_availability("fixture", {}, None)["code"], "cli_not_configured")
        self.assertEqual(local_availability("fixture", {"cli": [str(self.base / "missing")]}, None)["code"], "cli_missing")
        self.assertEqual(local_availability("traecode", {}, None)["code"], "ready")
        self.assertTrue(local_availability("traecode", {}, None)["enabled"])
        self.assertEqual(local_availability("zcode", {"cli": [sys.executable]}, "GLM-5.3-Flash")["code"], "model_selection_unverified")
        self.assertTrue(local_availability("zcode", dict(self.profile), "first")["enabled"])

    def test_profile_path_expansion_matches_real_script_dispatch(self):
        binary_dir = self.base / "private-bin"
        binary_dir.mkdir()
        command = "agenthub-private-path-fixture"
        script = binary_dir / (command + ".cmd" if os.name == "nt" else command)
        script.write_text("@echo off\n@echo PROFILE_PATH_CHILD_OK\n" if os.name == "nt" else "#!/bin/sh\nprintf '%s\\n' PROFILE_PATH_CHILD_OK\n", encoding="utf-8")
        if os.name != "nt":
            script.chmod(0o700)
        variable = "AGENTHUB_FIXTURE_PRIVATE_BIN"
        expression = f"%{variable}%" if os.name == "nt" else f"${{{variable}}}"
        profile = {"cli": [command, "{task}"], "env": {"PATH": expression + os.pathsep + os.environ.get("PATH", os.defpath)}}
        self.assertEqual(local_availability("fixture", {"cli": [command]}, None)["code"], "cli_missing")
        with patch.dict(os.environ, {variable: str(binary_dir)}):
            self.assertTrue(local_availability("fixture", profile, None)["enabled"])
            plan = prepare_task("fixture", profile, {"task": "fixture"}, self.base / "attachments")
            with patch.object(hub, "STATE", self.base / "state"):
                result = hub._dispatch_prepared_cli({"timeout_s": 3}, "fixture", profile, plan)
        self.assertIn("PROFILE_PATH_CHILD_OK", result)
        self.assertIn("exit=0", result)

    @unittest.skip("shared_auth_wrapper check removed to allow multi-account wrapper scripts")
    def test_shared_auth_wrapper_is_blocked_before_calling_it(self):
        path = self.base / "codebuddy-wrapper"
        path.write_text('#!/bin/sh\n# CodeBuddyExtension/Data/Public/auth\ncp "$HOME/.codebuddy/auth.info" /shared\n')
        path.chmod(0o700)
        value = local_availability("codebuddy", {"cli": [str(path)]}, "deepseek-v4.1-flash")
        self.assertEqual(value["code"], "shared_auth_wrapper")
        self.assertFalse(value["enabled"])

    def test_unverified_stream_and_auto_thinking_are_rejected(self):
        for name, option in (("zcode", {"stream": True}), ("antigravity", {"stream": True}), ("github-copilot", {"thinking": "off"})):
            profile = {"models": {"default": "auto"}}
            with self.assertRaisesRegex(ValueError, "UNSUPPORTED"):
                prepare_task(name, profile, {"task": "fixture", **option}, self.base / "attachments")
        self.assertEqual(public_model_capabilities("zcode", self.profile, "first")["stream"]["semantics"], "terminal_only")

    def test_no_history_permanently_disables_another_machine(self):
        self.assertTrue(local_availability("antigravity", self.profile, "first", self.base)["enabled"])
        self.assertTrue(local_availability("mimocode", self.profile, "first", self.base)["enabled"])

    def test_vendor_region_and_rpc_model_codes_are_safe_classifications(self):
        self.assertEqual(classify_failure("error", "User location is not supported for the API use"), "region_restricted")
        self.assertEqual(classify_failure("error", "MODEL_UNAVAILABLE"), "model_unavailable")
        self.assertEqual(classify_failure("error", "MODEL_SELECTION_NOT_APPLIED"), "model_unavailable")
        self.assertIsNone(classify_failure("completed", "A document discusses invalid API key and MODEL_UNAVAILABLE"))

    def test_failures_are_visible_for_models_outside_the_alias_map(self):
        """目录里的模型多数不在 agents.json 别名表里，只能靠派发记录判断可用性。"""
        profile = {"cli": [sys.executable, "fixture.py", "{task}"], "models": {"default": "declared"}, "model_arg": "--model"}
        sig = signature(profile)
        self.assertEqual(recorded(self.base, "antigravity", profile), {})
        record_outcome(self.base, "antigravity", "undeclared-model", "error", "400 model [undeclared-model] is not allowed for user type [free]", sig)
        record_outcome(self.base, "antigravity", "declared", "completed", "ok", sig)
        rows = recorded(self.base, "antigravity", profile)
        self.assertEqual(rows["undeclared-model"]["code"], "plan_blocked")
        self.assertTrue(rows["undeclared-model"]["blocking"])
        self.assertNotIn("declared", rows)
        # 配置变了以后旧记录不能继续生效
        self.assertEqual(recorded(self.base, "antigravity", dict(profile, model_arg="--m")), {})

    def test_plan_rejection_is_separated_from_a_missing_model(self):
        # 两种 400 长得很像，但处置完全不同：换账号就能用 vs 换账号也没用。
        blocked = "400 model [primary-model] is not allowed for user type [personal_free_user] (01a1/01a1)"
        self.assertEqual(classify_failure("error", blocked), "plan_blocked")
        self.assertEqual(classify_failure("error", "model [grok-4.7] is not allowed for user type [personal_free_user]"), "plan_blocked")
        for text in ("error: invalid model selection (--model \"gemini-3.1-pro-high\" --effort \"\"): model gemini-3.1-pro-high is not recognized as a known model",
                     "400 model [deep-model] service info not found",
                     "Model not found: mimo-v2.6-pro/.",
                     "400 the reasoning effort value is not supported by the current model"):
            self.assertEqual(classify_failure("error", text), "model_unavailable", text)
        self.assertEqual(classify_failure("error", "This model is not available in your country"), "region_restricted")
        self.assertIn("plan_blocked", BLOCKING)
        self.assertIn("套餐", REASONS["plan_blocked"])

    def test_empty_stdout_keeps_the_stderr_diagnostic_instead_of_a_canned_message(self):
        """退码 0 + 空 stdout 时真实原因只在 stderr；丢掉它会让「套餐拒绝」变成「偶发空答」。"""
        diagnostic = "400 model [primary-model] is not allowed for user type [personal_free_user]"
        script = self.base / "ok_empty.py"
        script.write_text("import sys\nsys.stderr.write(%r + '\\n')\n" % diagnostic, encoding="utf-8")
        profile = {"cli": [sys.executable, str(script), "{task}"], "models": {"default": "primary-model"},
                   "model_arg": "--model", "async_default": False}
        plan = prepare_task("codebuddy", profile, {"task": "fixture", "model": "primary-model"}, self.base / "attachments")
        out = hub._dispatch_prepared_cli({"timeout_s": 20}, "codebuddy", profile, plan)
        self.assertIn("is not allowed for user type", out)
        self.assertNotIn("没有可验证的回答", out)
        self.assertEqual(classify_failure("error", out), "plan_blocked")

    def test_stream_off_removes_conflicting_configured_boolean_flags(self):
        for agent, flag, model in (("codebuddy", "--include-partial-messages", "deepseek-v4.1-flash"), ("minimaxcode", "--stream", "MiniMax-M3.1-Flash-Preview")):
            profile = {"cli": [sys.executable, "fixture.py", "-p" if agent == "codebuddy" else "--message", "{task}", flag],
                       "models": {"default": model}, "model_arg": "--model", "async_default": True}
            with patch.object(hub, "_start_async", return_value="fixture-a123456789") as launch:
                plan = prepare_task(agent, profile, {"task": "TASK", "stream": False}, self.base / "attachments")
                hub._dispatch_prepared_cli({}, agent, profile, plan)
            self.assertNotIn(flag, launch.call_args.args[3]["cmd"])

    def test_unknown_models_and_unimplemented_controls_fail_before_staging(self):
        for args in ({"model": "not-declared"}, {"autoTier": "fast"}, {"contextTier": "long"}, {"extra_args": ["--model=not-declared"]}, {"extra_args": ["--agent", "ptc"]}):
            with self.assertRaisesRegex(ValueError, "UNSUPPORTED"):
                prepare_task("fixture", self.profile, {"task": "fixture", **args}, self.base / "attachments")
        self.assertFalse((self.base / "attachments").exists())

    def test_availability_cache_failure_does_not_erase_sync_answer(self):
        profile = {"cli": [sys.executable, "-c", "print('REAL_CHILD_ANSWER')", "{task}"]}
        plan = prepare_task("fixture", profile, {"task": "fixture"}, self.base / "attachments")
        with patch.object(hub, "record_outcome", side_effect=ValueError("Invalid cached hints")):
            result = hub._dispatch_prepared_cli({}, "fixture", profile, plan)
        self.assertIn("REAL_CHILD_ANSWER", result)
        self.assertIn("exit=0", result)

    def test_initial_status_race_cannot_launch_after_a_terminal_result(self):
        meta = {"task": "fixture", "cmd": [sys.executable, "-c", "pass"], "callback_url": None}
        with patch.object(sys, "argv", ["worker", "cmd", "fixture", "unused"]), patch.object(worker, "load_task_meta", return_value=meta), patch.object(worker, "read_result", return_value={"status": "running"}), patch.object(worker, "save", return_value={"status": "timeout"}), patch.object(worker, "cleanup_taskfile"), patch.object(worker, "run_cmd_mode") as launch:
            self.assertEqual(worker.main(), 1)
            launch.assert_not_called()

    def test_image_needs_explicit_read_authorization_and_standard_agent(self):
        profile = {"models": {"default": "deepseek-v4.1-flash"}, "cli": [sys.executable, "-p", "{task}", "--agent", "ptc"]}
        self.assertFalse(public_model_capabilities("codebuddy", profile, "deepseek-v4.1-flash")["attachments"]["image"]["supported"])
        profile["cli"] += ["--tools", "Read", "--allowedTools", "Read", "--permission-mode", "acceptEdits"]
        self.assertTrue(public_model_capabilities("codebuddy", profile, "deepseek-v4.1-flash")["attachments"]["image"]["supported"])
        plan = prepare_task("codebuddy", profile, {"task": "fixture"}, self.base / "attachments")
        self.assertEqual(plan["extra_args"][:2], ["--agent", "standard"])

    def test_official_stdin_json_bytes_reach_real_child_and_leave_no_prompt_argv(self):
        data = "UTF8_SECRET_正文_" + "x" * 40000
        item = {"name": "input.txt", "mime_type": "text/plain", "data_base64": base64.b64encode(data.encode()).decode()}
        profile = {"cli": [sys.executable, "-c", "pass", "-p", "{task}"], "models": {"default": "deepseek-v4.1-flash"}, "async_default": True, "model_arg": "--model"}
        with patch.object(hub, "STATE", self.base / "state"), patch.object(hub, "_start_async", return_value="codebuddy-a123456789") as launch:
            plan = prepare_task("codebuddy", profile, {"task": "TASK_ONLY", "attachments": [item]}, self.base / "state/attachments")
            hub._dispatch_prepared_cli({}, "codebuddy", profile, plan)
        argv = launch.call_args.args[3]["cmd"]
        self.assertNotIn("TASK_ONLY", argv)
        self.assertEqual(argv[argv.index("--input-format") + 1], "stream-json")
        self.assertEqual(argv[argv.index("--output-format") + 1], "stream-json")
        with patch.object(worker, "RESULTS", str(self.base / "results")):
            text, code = worker.run_cmd_mode([sys.executable, "-c", "import sys,json; p=json.load(sys.stdin); print(p['message']['content'][1]['text'][-20:])"], str(self.base / "task"), "fixture", input_file=plan["input_file"], timeout_s=3)
        self.assertEqual(code, 0)
        self.assertEqual(text, "x" * 20)
        cleanup_attachments(plan["staging"], self.base / "state/attachments")

    def test_unexecuted_dsml_final_is_error_but_examples_remain_answers(self):
        body = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="Read">\n<｜｜DSML｜｜ parameter name="path" string="true">fixture.txt</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'
        def parse(text):
            return parse_output(json.dumps({"type": "result", "session_id": "fixture", "result": text}))
        self.assertIn("TOOL_PROTOCOL_UNVERIFIED", parse(body)["error"])
        self.assertIn("TOOL_PROTOCOL_UNVERIFIED", parse("I'll read the file first.\n\n" + body)["error"])
        for text in ("Here is a DSML example:\n" + body, "Example:\n```xml\n" + body + "\n```", "A document mentions DSML but no tool call."):
            self.assertIsNone(parse(text)["error"])
            self.assertEqual(parse(text)["text"], text)

    def test_child_is_cancelled_when_result_already_has_a_terminal_state(self):
        with patch.object(worker, "RESULTS", str(self.base / "results")):
            worker.save("fixture", status="running")
            def expire():
                time.sleep(.15)
                worker.save("fixture", status="timeout", text="original deadline")
            thread = threading.Thread(target=expire); thread.start()
            began = time.monotonic()
            with self.assertRaises(worker.CommandCancelled):
                worker.run_cmd_mode([sys.executable, "-c", "import time; time.sleep(10)"], str(self.base / "task"), "fixture", timeout_s=3, watch_result=True)
            thread.join()
            self.assertLess(time.monotonic() - began, 1.5)
            self.assertEqual(worker.read_result("fixture")["text"], "original deadline")


if __name__ == "__main__":
    unittest.main(verbosity=2)
