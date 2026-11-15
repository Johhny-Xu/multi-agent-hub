"""E116: CodeArts adapter reports progress live and times out on idleness, not total length."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]
ADAPTER = ROOT / "drivers" / "codearts_cli.py"

FAKE = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, sys, time
    if sys.argv[1] == "models":
        print("huaweicloud-maas/kimi-k3.1-pro"); sys.exit()
    sys.stdin.read()
    S = "ses_1"
    def e(t, p): print(json.dumps({"type": t, "sessionID": S, "part": dict(p, sessionID=S)}), flush=True)
    for i in range(4):
        e("step_start", {}); time.sleep(0.6)
        e("tool_use", {"id": f"t{i}", "callID": f"c{i}", "tool": "bash", "state": {"status": "completed", "title": f"step {i}", "output": "SECRET-OUTPUT"}})
    e("text", {"id": "x", "text": "done text"}); e("step_finish", {"reason": "stop"})
''')


class CodeArtsProgress(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agenthub-codearts-e116-")
        self.cli = Path(self.temp.name) / "fakecli"
        self.cli.write_text(FAKE)
        self.cli.chmod(0o755)

    def tearDown(self):
        self.temp.cleanup()

    def run_adapter(self, *extra, env=None):
        result = subprocess.run([sys.executable, str(ADAPTER), "--task", "hi", "--cli", str(self.cli), "--cwd", self.temp.name, *extra],
                                capture_output=True, text=True, timeout=60, env={**os.environ, **(env or {})})
        return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]

    def test_progress_lines_precede_the_envelope_and_hide_tool_output(self):
        lines = self.run_adapter("--timeout", "2", "--progress")
        self.assertEqual(lines[-1]["type"], "result")
        self.assertEqual(lines[-1]["status"], "completed")
        tools = [line for line in lines if line.get("event") == "tool"]
        self.assertEqual([tool["title"] for tool in tools], ["step 0", "step 1", "step 2", "step 3"])
        self.assertNotIn("SECRET-OUTPUT", json.dumps(lines))

    def test_without_progress_only_the_envelope_is_printed(self):
        lines = self.run_adapter("--timeout", "2")
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["status"], "completed")

    def test_timeout_is_idle_based_so_a_long_busy_task_finishes(self):
        # Total run is ~2.4 s, longer than the 1.5 s idle limit, but events arrive every 0.6 s.
        self.assertEqual(self.run_adapter("--timeout", "1.5")[-1]["status"], "completed")

    def test_silence_longer_than_the_idle_limit_times_out(self):
        self.assertEqual(self.run_adapter("--timeout", "0.3")[-1]["error"]["code"], "CODEARTS_TIMEOUT")

    def test_total_cap_still_applies(self):
        lines = self.run_adapter("--timeout", "2", env={"AGENTHUB_CODEARTS_MAX_SEC": "1"})
        self.assertEqual(lines[-1]["error"]["code"], "CODEARTS_TIMEOUT")


if __name__ == "__main__":
    unittest.main(verbosity=2)
