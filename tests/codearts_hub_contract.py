"""CodeArts hub contract: conservative capabilities and native route identity."""
import base64
import json
from pathlib import Path
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
import agent_hub as hub
from task_contract import UnsupportedCapability, prepare_task, public_model_capabilities, resolve_model


class CodeArtsHubContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agenthub-codearts-contract-")
        self.attachments = Path(self.temp.name) / "attachments"
        self.profile = json.loads((ROOT / "hub/agents.example.json").read_text(encoding="utf-8"))["agents"]["codearts"]

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self, **options):
        return prepare_task("codearts", self.profile, {"task": "Review only", **options}, self.attachments)

    def test_native_default_is_preserved_without_inventing_model(self):
        self.assertEqual(resolve_model(self.profile), "")
        self.assertEqual(resolve_model(self.profile, "default"), "")
        self.assertEqual(self.profile["models"], {"default": ""})
        plan = self.prepare()
        self.assertEqual(plan["extra_args"], ["--stream", "off"])
        self.assertEqual(plan["metadata"]["thinking"], "default")
        self.assertFalse(self.attachments.exists())

    def test_unverified_controls_reject_before_staging(self):
        for options in ({"thinking": "on"}, {"thinking": "off"}, {"stream": True}):
            with self.subTest(options=options), self.assertRaises(UnsupportedCapability):
                self.prepare(**options)
        self.assertFalse(self.attachments.exists())

    def test_unverified_file_and_image_reject_before_staging(self):
        for name, mime in (("input.txt", "text/plain"), ("pixels.png", "image/png")):
            item = {"name": name, "mime_type": mime, "data_base64": base64.b64encode(b"synthetic fixture").decode("ascii")}
            with self.subTest(mime=mime), self.assertRaises(UnsupportedCapability):
                self.prepare(attachments=[item])
        self.assertFalse(self.attachments.exists())

    def test_public_caps_explain_disabled_controls(self):
        caps = public_model_capabilities("codearts", self.profile, "")
        self.assertEqual(caps["thinking"]["allowed"], ["default"])
        self.assertFalse(caps["stream"]["supported"])
        self.assertEqual(caps["stream"]["semantics"], "terminal_only")
        for mode in ("on", "off"):
            self.assertTrue(caps["thinking"]["reasons"][mode])
        for kind in ("file", "image"):
            self.assertFalse(caps["attachments"][kind]["supported"])
            self.assertTrue(caps["attachments"][kind]["reason"])
        self.assertIn("text/plain", caps["attachments"]["image"]["reason"])

    def test_declared_model_required_before_dispatch(self):
        with self.assertRaises(UnsupportedCapability):
            self.prepare(model="invented/provider")
        self.profile["models"]["pinned"] = "provider/verified-model"
        self.assertEqual(resolve_model(self.profile, "pinned"), "provider/verified-model")
        self.prepare(model="pinned")

    def test_hub_aliases_and_default_capability_row(self):
        with patch.object(hub, "_load_agents", return_value={"codearts": self.profile}), patch.object(hub, "local_availability", return_value={"enabled": True, "code": "ready", "reason": "Fixture", "refreshable": False}):
            for name in ("ca", "CA", "codearts", "CodeArts", "huawei-codearts"):
                with self.subTest(name=name):
                    self.assertEqual(hub._resolve_agent(name), "codearts")
            document = json.loads(hub.tool_hub_capabilities({"worker": "ca"}))
        worker = document["workers"]["codearts"]
        self.assertEqual(worker["default_model"], "")
        self.assertEqual(worker["models"][0]["id"], "")
        self.assertIn("default", worker["models"][0]["aliases"])

    def test_dispatch_inherits_model_but_passes_timeout_and_workdir(self):
        self.profile["cli"] = [sys.executable, str(ROOT / "drivers/codearts_cli.py"), "--task", "{task}"]
        plan = self.prepare()
        with patch.object(hub, "_start_async", return_value="codearts-abc123") as launch:
            hub._dispatch_prepared_cli({"timeout_s": 23, "cwd": self.temp.name}, "codearts", self.profile, plan)
        command = launch.call_args.args[3]["cmd"]
        self.assertNotIn("--model", command)
        self.assertEqual(command[command.index("--timeout") + 1], "23.0")
        self.assertEqual(command[command.index("--cwd") + 1], self.temp.name)
        self.assertEqual(command[command.index("--stream") + 1], "off")

    def test_windows_template_and_native_route_inherit_host_model(self):
        windows = json.loads((ROOT / "hub/agents.windows.example.json").read_text(encoding="utf-8"))["agents"]["codearts"]
        self.assertEqual(windows["models"], {"default": ""})
        self.assertEqual(windows["workdir_via"], "--cwd")
        self.assertTrue(windows["cli"][1].endswith("/drivers/codearts_cli.py"))
        agent = tomllib.loads((ROOT / "integrations/codex/templates/.codex/agents/agenthub_codearts.toml").read_text(encoding="utf-8"))
        self.assertEqual(agent["name"], "agenthub_codearts")
        self.assertEqual(set(agent), {"name", "description", "developer_instructions"})
        self.assertIn('worker 固定为 "codearts"', agent["developer_instructions"])


if __name__ == "__main__":
    unittest.main()
