"""Actual child-process identity contract for native Antigravity MCP recursion.

The subprocess fixtures only print environment values; they do not invoke an
installed agent, contact a provider, or require credentials.
"""
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
import agent_hub as hub


class AntigravityHubContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agenthub-native-identity-")
        self.base = Path(self.temp.name)
        self.enterContext(patch.object(hub, "STATE", self.base / "state"))
        self.enterContext(patch.object(hub, "RESULTS_DIR", str(self.base / "results")))
        self.enterContext(patch.dict(os.environ, {"AGENTHUB_WORKER_ID": "inherited-wrong-worker"}))
        self.addCleanup(self.temp.cleanup)

    def fixture(self, asynchronous=False):
        profile = {
            "cli": [sys.executable, "-c", "import os; print('WORKER_ID=' + os.environ.get('AGENTHUB_WORKER_ID', 'missing'))", "{task}"],
            "env": {"AGENTHUB_WORKER_ID": "profile-wrong-worker"},
            "async_default": asynchronous,
        }
        plan = {
            "task": "Only echo the worker identity",
            "extra_args": [],
            "env": {"AGENTHUB_WORKER_ID": "capability-wrong-worker"},
            "staging": None,
            "metadata": {"stream": False},
        }
        return profile, plan

    def test_sync_actual_child_gets_own_identity_after_all_environment_overrides(self):
        for agent in ("antigravity", "codearts", "mimocode"):
            with self.subTest(agent=agent):
                profile, plan = self.fixture()
                result = hub._dispatch_prepared_cli({"timeout_s": 5}, agent, profile, plan)
                self.assertIn("exit=0", result)
                self.assertIn("WORKER_ID=" + agent, result)
                self.assertNotIn("wrong-worker", result)
                self.assertEqual(os.environ["AGENTHUB_WORKER_ID"], "inherited-wrong-worker")

    def test_async_actual_child_inherits_identity_through_async_worker(self):
        original_popen = subprocess.Popen
        for agent in ("antigravity", "codearts"):
            with self.subTest(agent=agent):
                profile, plan = self.fixture(asynchronous=True)
                children = []

                def launch(*args, **kwargs):
                    child = original_popen(*args, **kwargs)
                    children.append(child)
                    return child

                with patch.object(hub.subprocess, "Popen", side_effect=launch):
                    receipt = hub._dispatch_prepared_cli({"timeout_s": 5}, agent, profile, plan)
                self.assertEqual(len(children), 1, "the task must launch exactly one async worker")
                try:
                    children[0].wait(timeout=10)
                finally:
                    if children[0].poll() is None:
                        children[0].kill()
                        children[0].wait(timeout=5)
                ref = re.search(r"/([a-z-]+-[0-9a-f]+)\]", receipt).group(1)
                result = hub._read_result(ref)
                self.assertEqual(result["status"], "completed", result)
                self.assertEqual(result["text"], "WORKER_ID=" + agent)
                self.assertEqual(os.environ["AGENTHUB_WORKER_ID"], "inherited-wrong-worker")

    def test_codebuddy_login_environment_cannot_replace_worker_identity(self):
        profile, plan = self.fixture(asynchronous=True)
        with patch("login_manager.worker_env", return_value={"AGENTHUB_WORKER_ID": "login-wrong-worker"}), patch.object(hub, "_start_async", return_value="codebuddy-abc123") as launch:
            hub._dispatch_prepared_cli({}, "codebuddy", profile, plan)
        self.assertEqual(launch.call_args.kwargs["env"]["AGENTHUB_WORKER_ID"], "codebuddy")
        self.assertEqual(launch.call_count, 1)


if __name__ == "__main__":
    unittest.main()
