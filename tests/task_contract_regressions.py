"""Portable attachment, capability and actual asynchronous dispatch regressions."""
import base64
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
import agent_hub as hub
import async_worker as worker
from task_contract import UnsupportedCapability, apply_environment, cleanup_attachments, merge_cli_arguments, prepare_task


def attachment(name, value, mime="text/plain"):
    return {"name": name, "mime_type": mime, "data_base64": base64.b64encode(value).decode("ascii")}


class TaskContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agenthub-task-contract-")
        self.root = Path(self.temp.name)
        self.attachments = self.root / "state" / "attachments"

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self, worker="fixture", profile=None, **kwargs):
        return prepare_task(worker, profile or {}, {"task": "Read the provided fixture", **kwargs}, self.attachments)

    def test_unsupported_thinking_rejected_before_mutation(self):
        with self.assertRaises(UnsupportedCapability):
            self.prepare(thinking="off")
        self.assertFalse(self.attachments.exists())

    def test_always_thinking_model_rejects_off(self):
        with self.assertRaises(UnsupportedCapability):
            self.prepare(worker="minimaxcode", thinking="off")

    def test_mimo_thinking_sets_provider_option_and_limits_model(self):
        profile = {"models": {"default": "xiaomi/mimo-v2.6-flash"}}
        plan = self.prepare(worker="mimocode", profile=profile, thinking="off")
        config = json.loads(plan["env"]["MIMOCODE_CONFIG_CONTENT"])
        self.assertEqual(config["provider"]["xiaomi"]["models"]["mimo-v2.6-flash"]["options"]["thinking"]["type"], "disabled")
        self.assertEqual(self.prepare(worker="mimocode", profile=profile, thinking="off", model="默认")["env"], plan["env"])
        with self.assertRaises(UnsupportedCapability):
            self.prepare(worker="mimocode", profile=profile, thinking="off", model="other/model")

    def test_json_option_merge_preserves_other_settings(self):
        current = {"MIMOCODE_CONFIG_CONTENT": json.dumps({"permission": {"bash": "deny"}, "provider": {"xiaomi": {"name": "existing"}}})}
        update = {"MIMOCODE_CONFIG_CONTENT": json.dumps({"provider": {"xiaomi": {"models": {"model": {"options": {"thinking": {"type": "disabled"}}}}}}})}
        merged = json.loads(apply_environment(current, update)["MIMOCODE_CONFIG_CONTENT"])
        self.assertEqual(merged["permission"]["bash"], "deny")
        self.assertEqual(merged["provider"]["xiaomi"]["name"], "existing")

    def test_scalar_format_flags_are_replaced_and_attachment_flags_repeat(self):
        command = ['mimo', 'run', '--format', 'json', '--model=old', '{task}']
        result = merge_cli_arguments(command, ['--format', 'json', '--model', 'new', '--file', 'a', '--file', 'b'])
        self.assertEqual(result.count('--format'), 1)
        self.assertNotIn('--model=old', result)
        self.assertEqual(result.count('--file'), 2)
        self.assertIn('{task}', result)
        settings = merge_cli_arguments(['cb', '--settings', '{"permissions":{"deny":["Bash"]},"alwaysThinkingEnabled":true}'], ['--settings', '{"alwaysThinkingEnabled":false}'])
        merged = json.loads(settings[-1])
        self.assertFalse(merged['alwaysThinkingEnabled'])
        self.assertEqual(merged['permissions']['deny'], ['Bash'])
        with self.assertRaises(ValueError):
            merge_cli_arguments(['cb', '--settings', 'private-settings.json'], ['--settings', '{}'])

    def test_prompt_last_keeps_model_and_output_flags_outside_prompt(self):
        profile = {'cli': [sys.executable, 'fixture.py', '-p', '{task}'], 'options_before_prompt': True,
                   'async_default': True, 'model_arg': '--model', 'models': {'default': 'fixture'}}
        plan = {'task': '--format', 'extra_args': ['--format', 'json'], 'env': {}, 'metadata': {'stream': False}, 'staging': None}
        with patch.object(hub, '_start_async', return_value='fixture-a123456789') as launch:
            hub._dispatch_prepared_cli({}, 'fixture', profile, plan)
        command = launch.call_args.args[3]['cmd']
        self.assertEqual(command[-2:], ['-p', '--format'])
        self.assertEqual(command[-6:-2], ['--model', 'fixture', '--format', 'json'])

    def test_legacy_bare_prompt_is_not_consumed_by_variadic_permissions(self):
        profile = {'cli': [sys.executable, 'fixture.py', '-p', '--allowedTools', 'Read'],
                   'async_default': True, 'model_arg': '--model', 'models': {'default': 'fixture'}}
        plan = {'task': 'Read actual fixture', 'extra_args': [], 'env': {}, 'metadata': {'stream': False}, 'staging': None}
        with patch.object(hub, '_start_async', return_value='codebuddy-a123456789') as launch:
            hub._dispatch_prepared_cli({}, 'codebuddy', profile, plan)
        command = launch.call_args.args[3]['cmd']
        self.assertEqual(command[2:6], ['-p', 'Read actual fixture', '--allowedTools', 'Read'])

    def test_zcode_cannot_label_current_model_as_unselected_default(self):
        profile = {'cli': ['node', 'zcode.cjs', '--prompt', '{task}'],
                   'async_default': True, 'models': {'default': 'GLM-5.3-Flash'}}
        plan = {'task': 'fixture', 'extra_args': [], 'env': {}, 'metadata': {'stream': False}, 'staging': None}
        with patch.object(hub, '_start_async') as launch, self.assertRaisesRegex(ValueError, 'zcode_rpc'):
            hub._dispatch_prepared_cli({}, 'zcode', profile, plan)
        launch.assert_not_called()
        profile.update(model_arg='--model', timeout_arg='--timeout')
        with patch.object(hub, '_start_async', return_value='zcode-a123456789') as launch:
            hub._dispatch_prepared_cli({'timeout_s': 42}, 'zcode', profile, plan)
        command = launch.call_args.args[3]['cmd']
        self.assertEqual(command[command.index('--model') + 1], 'GLM-5.3-Flash')
        self.assertEqual(command[command.index('--timeout') + 1], '42.0')

    def test_portable_attachment_decodes_exact_bytes_and_cleans_only_owned_directory(self):
        data = "remote fixture 数据".encode("utf-8")
        profile = {"capabilities": {"attachments": {"file": {"mode": "cli", "flag": "--file"}}}}
        plan = self.prepare(profile=profile, attachments=[attachment("CON.txt", data)])
        staged = Path(plan["extra_args"][1])
        self.assertEqual(staged.read_bytes(), data)
        self.assertNotEqual(staged.name, "CON.txt")
        cleanup_attachments(plan["staging"], self.attachments)
        self.assertFalse(staged.exists())
        outside = self.root / "task-outside"
        outside.mkdir()
        with self.assertRaises(ValueError):
            cleanup_attachments(str(outside), self.attachments)
        self.assertTrue(outside.exists())

    def test_path_injection_and_bad_base64_rejected_without_staging(self):
        profile = {"capabilities": {"attachments": {"file": {"mode": "prompt_path"}}}}
        for invalid in [attachment("../escape", b"x"), attachment("C:\\escape", b"x"), {"name": "x", "mime_type": "text/plain", "data_base64": "%%%"}]:
            with self.subTest(invalid=invalid["name"]), self.assertRaises(ValueError):
                self.prepare(profile=profile, attachments=[invalid])
        self.assertFalse(self.attachments.exists())

    def test_direct_hub_cannot_bypass_credential_attachment_guard(self):
        profile = {'capabilities': {'attachments': {'file': {'mode': 'prompt_path'}}}}
        for name in ['.env', '.env.production', 'AUTH.json', '.credentials.yaml', 'id_ed25519', 'private.pem']:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'Credential'):
                self.prepare(profile=profile, attachments=[attachment(name, b'SYNTHETIC_FIXTURE')])
        self.assertFalse(self.attachments.exists())

    def test_message_file_contains_utf8_input_and_image_pixels(self):
        plan = self.prepare(worker="minimaxcode", attachments=[attachment("input.txt", b"VALUE=37")])
        self.assertTrue(plan['message_file'])
        messages = json.loads(Path(plan['extra_args'][-1]).read_text(encoding='utf-8'))
        self.assertIn('VALUE=37', messages[0]['content'][1]['text'])
        cleanup_attachments(plan["staging"], self.attachments)
        plan = self.prepare(worker='minimaxcode', attachments=[attachment('pixels.png', b'SYNTHETIC_PIXELS', 'image/png')])
        messages = json.loads(Path(plan['extra_args'][-1]).read_text(encoding='utf-8'))
        self.assertEqual(base64.b64decode(messages[0]['content'][1]['source']['data']), b'SYNTHETIC_PIXELS')
        cleanup_attachments(plan['staging'], self.attachments)

    def test_image_cannot_silently_become_text(self):
        with self.assertRaises(UnsupportedCapability):
            self.prepare(profile={'capabilities': {'attachments': {'image': {'mode': 'inline_text'}}}}, attachments=[attachment("image.png", b"synthetic", "image/png")])
        self.assertFalse(self.attachments.exists())

    def test_total_size_and_boolean_types(self):
        for invalid in ({"stream": "false"}, {"thinking": False}, {"attachments": {}}, {"attachments": [attachment("x", b"x" * (1024 * 1024 + 1))]}):
            with self.subTest(keys=list(invalid)), self.assertRaises(ValueError):
                self.prepare(**invalid)

    def test_real_async_worker_reads_staged_file_and_exposes_incremental_progress(self):
        script = self.root / "fixture.py"
        script.write_text("import sys,time\nfrom pathlib import Path\np=Path(sys.argv[sys.argv.index('--file')+1])\nprint('FIRST_PROGRESS',flush=True)\ntime.sleep(.65)\nprint(p.read_text(encoding='utf-8'),flush=True)\n", encoding="utf-8")
        profile = {"cli": [sys.executable, str(script), "{task}"], "async_default": True,
                   "capabilities": {"attachments": {"file": {"mode": "cli", "flag": "--file"}}}}
        config = self.root / "agents.json"
        config.write_text(json.dumps({"agents": {"fixture": profile}}), encoding="utf-8")
        with patch.object(hub, "STATE", self.root / "state"), patch.object(hub, "AGENTS_JSON", config), patch.object(hub, "RESULTS_DIR", str(self.root / "results")):
            receipt = hub.tool_hub_dispatch_cli({"agent": "fixture", "task": "Use supplied file", "stream": True,
                                                 "timeout_s": 3, "attachments": [attachment("跨系统.txt", "ATTACHMENT_ANSWER=37".encode("utf-8"))]})
            import re
            ref = re.search(r"fixture-[0-9a-f]{10}", receipt).group()
            saw_progress = False
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                data = json.loads(hub.tool_hub_result_json({"ref": ref}))
                if data["status"] == "running" and "FIRST_PROGRESS" in (data.get("progress") or ""):
                    saw_progress = True
                if data["status"] in ('completed', 'error', 'timeout'):
                    break
                time.sleep(.03)
            self.assertEqual(data["status"], "completed")
            self.assertIn("ATTACHMENT_ANSWER=37", data["text"])
            self.assertTrue(saw_progress)
            self.assertEqual(data["attachments"][0]["name"], "跨系统.txt")
            self.assertNotIn("env", data)
            for _ in range(20):
                if not list(self.attachments.glob("task-*")):
                    break
                time.sleep(.03)
            self.assertEqual(list(self.attachments.glob("task-*")), [])

    def test_async_output_preserves_answers_longer_than_old_4000_limit(self):
        expected = 'BEGIN_' + 'x' * 6000 + '_END'
        with patch.object(worker, 'RESULTS', str(self.root / 'results')):
            text, code = worker.run_cmd_mode([sys.executable, '-c', "print('BEGIN_' + 'x'*6000 + '_END')"], str(self.root / 'task'), 'fixture', timeout_s=3)
        self.assertEqual(code, 0)
        self.assertEqual(text, expected)

    def test_async_stderr_status_is_not_answer_and_failed_diagnostic_is_kept(self):
        with patch.object(worker, 'RESULTS', str(self.root / 'results')):
            text, code = worker.run_cmd_mode([sys.executable, '-c',
                "import sys; print('CLI_SPINNER',file=sys.stderr); print('{\"answer\":37}')"],
                str(self.root / 'task'), 'fixture', timeout_s=3)
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(text), {'answer': 37})
            self.assertFalse((self.root / 'task.err').exists())
            text, code = worker.run_cmd_mode([sys.executable, '-c',
                "import sys; print('PROVIDER_FAILURE',file=sys.stderr); sys.exit(2)"],
                str(self.root / 'task'), 'fixture', timeout_s=3)
            self.assertEqual(code, 2)
            self.assertIn('PROVIDER_FAILURE', text)

    def test_zero_exit_structured_cli_error_is_not_success(self):
        payload = json.dumps({'type': 'result', 'session_id': 'synthetic', 'is_error': True, 'result': 'synthetic provider failure'})
        script = self.root / 'failure.py'
        script.write_text('print(' + repr(payload) + ')', encoding='utf-8')
        with patch.object(worker, 'RESULTS', str(self.root / 'results')):
            text, code = worker.run_cmd_mode([sys.executable, str(script)], str(self.root / 'task'), 'fixture', timeout_s=3)
        self.assertEqual(code, 1)
        self.assertEqual(text, 'synthetic provider failure')

    def test_empty_zero_exit_is_unverified_and_not_completed(self):
        with patch.object(worker, 'RESULTS', str(self.root / 'results')):
            text, code = worker.run_cmd_mode([sys.executable, '-c', 'pass'], str(self.root / 'task'), 'fixture', timeout_s=3)
        self.assertEqual(code, 1)
        self.assertIn('不要自动重复派发', text)

    def test_async_usage_exposes_counts_without_reasoning_or_credentials(self):
        payload = {'type': 'result', 'session_id': 'synthetic', 'result': 'ANSWER=37',
                   'usage': {'input_tokens': 10, 'output_tokens': 7, 'reasoning_tokens': 0, 'apiKey': 'SYNTHETIC_NEVER_PUBLIC'}}
        script = self.root / 'usage.py'
        script.write_text('print(' + repr(json.dumps(payload)) + ')', encoding='utf-8')
        with patch.object(worker, 'RESULTS', str(self.root / 'results')):
            worker.save('fixture', status='running')
            text, code = worker.run_cmd_mode([sys.executable, str(script)], str(self.root / 'task'), 'fixture', timeout_s=3)
            result = worker.read_result('fixture')
        self.assertEqual(code, 0)
        self.assertEqual(result['usage'], {'input_tokens': 10, 'output_tokens': 7, 'reasoning_tokens': 0})
        self.assertNotIn('SYNTHETIC_NEVER_PUBLIC', json.dumps(result))


if __name__ == "__main__":
    unittest.main(verbosity=2)
