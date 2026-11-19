"""The client-managed heartbeat loop: complete/fail stop it by pid, and a pid file
that points at another process is never killed.

The loop itself is a `sleep` whose argv[0] carries the real loop's markers
(`omb_relay.py heartbeat-loop --turn <turnId> --delivery <deliveryId>`), so the
/cmdline guard in _is_our_heartbeat_process is exercised for real; a plain
`sleep` has none of the markers and must survive.
"""

import os
import subprocess
import sys
import unittest

import support
from support import FakeOMB, Sandbox, poll_and_claim, wait_until, write_text_file


class HeartbeatLoopTest(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.cleanup)
        self.fake = FakeOMB(self.box.token).start()
        self.addCleanup(self.fake.close)
        self.box.write_config(self.fake.base_url)
        self.procs = []
        self.addCleanup(self._kill_procs)

    def _kill_procs(self):
        for proc in self.procs:
            if proc.poll() is None:
                proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)

    def _claimed_turn_with_text(self):
        turn_id, claim = poll_and_claim(self.box, self.fake, text="make a note")
        delivery = claim["deliveryId"]
        path = write_text_file(self.box, "reply.txt", "hello from muse")
        sent = self.box.run(
            "send-text", "--turn", turn_id, "--delivery", delivery,
            "--text-file", str(path), "--final",
        )
        self.assertEqual(sent.returncode, 0, sent.stderr)
        return turn_id, delivery

    def _pid_path(self, turn_id):
        return self.box.work / f"hb-{turn_id}.pid"

    def _spawn_fake_loop(self, turn_id, delivery_id):
        """A sleep whose argv[0] is the real loop's command line: /proc/<pid>/cmdline
        carries the omb_relay.py + heartbeat-loop + turnId markers."""
        proc = subprocess.Popen(
            ["omb_relay.py heartbeat-loop --turn %s --delivery %s" % (turn_id, delivery_id), "60"],
            executable="/bin/sleep",
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.procs.append(proc)
        return proc

    def _spawn_plain_sleep(self):
        proc = subprocess.Popen(
            ["sleep", "60"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.procs.append(proc)
        return proc

    def test_complete_stops_the_heartbeat_process(self):
        turn_id, delivery = self._claimed_turn_with_text()
        loop = self._spawn_fake_loop(turn_id, delivery)
        pid_path = self._pid_path(turn_id)
        pid_path.write_text(str(loop.pid))
        self.assertIsNone(loop.poll(), "fake loop should be alive before complete")
        done = self.box.run("complete", "--turn", turn_id, "--delivery", delivery)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("status=ok", done.stdout)
        self.assertTrue(
            wait_until(lambda: loop.poll() is not None, timeout=5.0),
            "complete must SIGTERM the heartbeat loop",
        )
        self.assertFalse(pid_path.exists(), "complete must delete the pid file")

    def test_pid_file_pointing_at_another_process_is_not_killed(self):
        turn_id, delivery = self._claimed_turn_with_text()
        other = self._spawn_plain_sleep()
        pid_path = self._pid_path(turn_id)
        pid_path.write_text(str(other.pid))
        done = self.box.run("complete", "--turn", turn_id, "--delivery", delivery)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("status=ok", done.stdout)
        self.assertIsNone(other.poll(), "a pid that is not our heartbeat loop must not be killed")
        self.assertTrue(pid_path.exists(), "the pid file must be left alone when it is not ours")


if __name__ == "__main__":
    unittest.main()
