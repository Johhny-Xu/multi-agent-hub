"""Liveness/status regressions: never infer death from wall-clock silence alone."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
import agent_hub as hub
import async_worker as worker
from process_liveness import probe_process_tree


class ProcessLivenessTests(unittest.TestCase):
    def test_current_process_is_alive_with_cpu_accounting(self):
        info = probe_process_tree(os.getpid())
        self.assertTrue(info["alive"])
        self.assertGreaterEqual(info["process_count"], 1)
        if info["source"] == "proc":
            self.assertIsNotNone(info["cpu_seconds"])
            self.assertGreaterEqual(info["cpu_seconds"], 0)

    def test_child_process_can_be_probed_and_reaped(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(5)"])
        try:
            info = probe_process_tree(child.pid)
            self.assertTrue(info["alive"])
        finally:
            child.terminate()
            child.wait(timeout=10)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if not probe_process_tree(child.pid)["alive"]:
                break
            time.sleep(0.05)
        self.assertFalse(probe_process_tree(child.pid)["alive"])


class TaskLivenessTests(unittest.TestCase):
    def setUp(self):
        hub._LIVENESS_PROBES.clear()
        self.now = time.time()

    def base(self, **overrides):
        data = {
            "ref": "fixture-live", "agent": "fixture", "status": "running",
            "pid": 4242, "started_at": self.now - 120, "updated_at": self.now - 2,
            "heartbeat": self.now - 2, "output_bytes": 100,
            "last_output_at": self.now - 5, "liveness_source": "process",
        }
        data.update(overrides)
        return data

    def alive(self, cpu=10.0):
        return {"alive": True, "cpu_seconds": cpu, "process_count": 3, "children": 2, "source": "proc"}

    def test_working_when_process_alive_and_output_recent(self):
        with patch.object(hub, "probe_process_tree", return_value=self.alive()):
            live = hub._task_liveness(self.base())
        self.assertEqual(live["verdict"], "working")
        self.assertEqual(live["action"], "wait")
        self.assertTrue(live["process_alive"])
        self.assertIn("不要因为一段时间没打印就截断", live["guidance"])

    def test_cpu_growth_counts_as_work_even_when_output_is_old(self):
        old = self.base(last_output_at=self.now - 500, heartbeat=self.now - 200, updated_at=self.now - 200)
        with patch.object(hub, "probe_process_tree", return_value=self.alive(10)):
            hub._task_liveness(old)
        with patch.object(hub, "probe_process_tree", return_value=self.alive(12)):
            live = hub._task_liveness(old)
        self.assertEqual(live["verdict"], "working")
        self.assertGreaterEqual(live["cpu_delta_seconds"], 2)

    def test_alive_but_quiet_is_waiting_not_dead(self):
        quiet = self.base(last_output_at=self.now - 500, heartbeat=self.now - 5, output_bytes=100)
        with patch.object(hub, "probe_process_tree", return_value=self.alive()):
            live = hub._task_liveness(quiet)
        self.assertEqual(live["verdict"], "alive_waiting")
        self.assertEqual(live["action"], "wait")
        self.assertTrue(live["preserve_ref"])

    def test_exited_process_is_a_delivery_problem_not_timeout(self):
        with patch.object(hub, "probe_process_tree", return_value={"alive": False, "cpu_seconds": None, "process_count": 0, "children": 0, "source": "proc"}):
            live = hub._task_liveness(self.base())
        self.assertEqual(live["verdict"], "worker_exited_result_missing")
        self.assertEqual(live["action"], "inspect_delivery")
        self.assertIn("不要重新派发", live["guidance"])

    def test_gui_worker_uses_progress_heartbeat_without_pid(self):
        gui = self.base(pid=None, liveness_source="gui", progress="界面快照", progress_at=self.now - 5)
        live = hub._task_liveness(gui, probe=False)
        self.assertEqual(live["verdict"], "gui_working")
        self.assertEqual(live["action"], "wait")

    def test_terminal_status_is_not_overridden_by_probe(self):
        done = self.base(status="completed", pid=4242)
        if "last_output_at" in done:
            del done["last_output_at"]
        with patch.object(hub, "probe_process_tree", return_value=self.alive()):
            live = hub._task_liveness(done)
        self.assertEqual(live["verdict"], "completed")
        self.assertEqual(live["action"], "done")
        self.assertFalse(live["preserve_ref"])

    def test_reaper_does_not_timeout_live_pid(self):
        stale = self.base(updated_at=self.now - hub.STALE_RUNNING_SEC - 10)
        with patch.object(hub, "probe_process_tree", return_value=self.alive()):
            self.assertEqual(hub._reap_result(stale), stale)
        with patch.object(hub, "probe_process_tree", return_value={"alive": False}), \
                patch.object(hub, "update_result", return_value={**stale, "status": "timeout"}):
            self.assertEqual(hub._reap_result(stale)["status"], "timeout")

    def test_result_json_exposes_verdict_and_liveness(self):
        with patch.object(hub, "_read_result", return_value=self.base()), \
                patch.object(hub, "probe_process_tree", return_value=self.alive()):
            data = json.loads(hub.tool_hub_result_json({"ref": "fixture-live"}))
        self.assertEqual(data["verdict"], "working")
        self.assertEqual(data["liveness"]["verdict"], "working")
        self.assertEqual(data["liveness"]["pid"], 4242)

    def test_task_status_tool_is_registered_and_formats_guidance(self):
        self.assertIn("hub_task_status", {tool["name"] for tool in hub.TOOLS_JSON})
        self.assertIn("hub_task_status", hub.HANDLERS)
        with patch.object(hub, "_read_result", return_value=self.base()), \
                patch.object(hub, "probe_process_tree", return_value=self.alive()):
            text = hub.tool_hub_task_status({"ref": "fixture-live"})
            payload = json.loads(hub.tool_hub_task_status({"ref": "fixture-live", "json": True}))
        self.assertIn("verdict=working", text)
        self.assertIn("guidance:", text)
        self.assertEqual(payload["action"], "wait")

    def test_silent_but_cpu_busy_worker_extends_idle_budget(self):
        """A CLI that computes silently must not be killed by stdout idle alone."""
        state = {"cpu": 0.0}

        def fake_probe(_pid):
            state["cpu"] += 0.2
            return {"alive": True, "cpu_seconds": state["cpu"], "process_count": 1,
                    "children": 0, "source": "synthetic"}

        with tempfile.TemporaryDirectory(prefix="agenthub-cpu-live-") as temp:
            taskfile = str(Path(temp) / "task")
            with patch.object(worker, "RESULTS", str(Path(temp) / "results")), \
                    patch.object(worker, "CPU_SAMPLE_INTERVAL", 0.1), \
                    patch.object(worker, "probe_process_tree", side_effect=fake_probe):
                text, code = worker.run_cmd_mode(
                    [sys.executable, "-c", "import time; time.sleep(1.4); print('SILENT_CPU_DONE')"],
                    taskfile, "fixture", timeout_s=0.8)
        self.assertEqual(code, 0)
        self.assertEqual(text.strip(), "SILENT_CPU_DONE")


if __name__ == "__main__":
    unittest.main()
