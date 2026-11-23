"""Complete/fail retries: a finished turn must answer duplicate, and a retriable failure must not
drop the lease (BUGSCAN-1119 C01/C02)."""

from __future__ import annotations

import json
import os
import signal
import time
import unittest

import support
from support import FakeOMB, Sandbox, poll_and_claim, wait_until, write_text_file

omb_relay = support.omb_relay


def fields(stdout: str) -> dict:
    return dict(part.split("=", 1) for part in stdout.split() if "=" in part)


class TerminalRetryTest(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.cleanup)
        self.fake = FakeOMB(self.box.token, lease_seconds=1).start()
        self.addCleanup(self.fake.close)
        self.box.write_config(self.fake.base_url)

    def send_text(self, turn_id, delivery, text="done", *extra):
        path = write_text_file(self.box, f"reply-{time.time_ns()}.txt", text)
        return self.box.run("send-text", "--turn", turn_id, "--delivery", delivery, "--text-file", str(path), *extra)

    def event_requests(self, turn_id):
        return [
            item
            for item in self.fake.requests_snapshot()
            if item["endpoint"] == "events" and item["turn_id"] == turn_id
        ]

    def lose_terminal_responses(self):
        # Every quick retry of the terminal event loses its answer, so the command exits 7 with the
        # event stored on the server and its id still only in the local inflight record.
        self.fake.event_drops = 1 + omb_relay.EVENT_QUICK_RETRIES

    def test_a_complete_whose_answer_was_lost_retries_as_a_duplicate(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        sent = self.send_text(turn_id, delivery, "done", "--final")
        self.assertEqual(sent.returncode, 0, sent.stdout + sent.stderr)

        self.lose_terminal_responses()
        first = self.box.run("complete", "--turn", turn_id, "--delivery", delivery)
        self.assertEqual(first.returncode, 7, first.stdout + first.stderr)
        self.assertEqual(self.fake.turns[turn_id]["terminal"], "completed")
        ledger = self.box.ledger(turn_id)
        self.assertIsNone(ledger["terminal"])
        self.assertEqual(ledger["inflight"]["type"], "completed")

        heartbeats = self.fake.request_count("heartbeat")
        again = self.box.run("complete", "--turn", turn_id, "--delivery", delivery)
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertIn("status=ok", again.stdout)
        self.assertIn("duplicate=true", again.stdout)
        self.assertEqual(self.fake.event_types(turn_id), ["text", "completed"])
        self.assertEqual(self.box.ledger(turn_id)["terminal"], "completed")
        # The retry goes straight to the event: a heartbeat on a finished turn would answer 409 and
        # be mistaken for a stale delivery.
        self.assertEqual(self.fake.request_count("heartbeat"), heartbeats)

    def test_a_fail_whose_answer_was_lost_retries_as_a_duplicate(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        self.lose_terminal_responses()
        first = self.box.run("fail", "--turn", turn_id, "--delivery", delivery)
        self.assertEqual(first.returncode, 7, first.stdout + first.stderr)
        self.assertEqual(self.fake.turns[turn_id]["terminal"], "failed")

        again = self.box.run("fail", "--turn", turn_id, "--delivery", delivery)
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertIn("duplicate=true", again.stdout)
        self.assertEqual(self.fake.event_types(turn_id), ["failed"])
        self.assertEqual(self.box.ledger(turn_id)["terminal"], "failed")

    def test_a_second_identical_terminal_command_is_answered_locally(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        self.assertEqual(self.send_text(turn_id, delivery, "done", "--final").returncode, 0)
        first = self.box.run("complete", "--turn", turn_id, "--delivery", delivery)
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        requests = self.fake.request_count("events")

        again = self.box.run("complete", "--turn", turn_id, "--delivery", delivery)
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertIn("duplicate=true", again.stdout)
        self.assertIn("seq=2", again.stdout)
        self.assertEqual(self.fake.request_count("events"), requests)

    def test_a_fail_after_complete_is_a_conflict_and_keeps_the_terminal_state(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        self.assertEqual(self.send_text(turn_id, delivery, "done", "--final").returncode, 0)
        self.assertEqual(self.box.run("complete", "--turn", turn_id, "--delivery", delivery).returncode, 0)
        conflict = self.box.run("fail", "--turn", turn_id, "--delivery", delivery)
        self.assertEqual(conflict.returncode, 6, conflict.stdout + conflict.stderr)
        self.assertIn("turn is already terminal", conflict.stderr)
        self.assertEqual(self.box.ledger(turn_id)["terminal"], "completed")
        self.assertEqual(self.fake.event_types(turn_id), ["text", "completed"])

    def test_the_first_terminal_request_still_notices_cancellation(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        self.fake.cancel_turn(turn_id)
        result = self.box.run("complete", "--turn", turn_id, "--delivery", claim["deliveryId"])
        self.assertEqual(result.returncode, 8, result.stdout + result.stderr)
        self.assertIn("status=cancelled", result.stdout)
        self.assertEqual(self.fake.request_count("events"), 0)

    def test_the_retry_reuses_the_first_event_id_and_seq(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        self.assertEqual(self.send_text(turn_id, delivery, "done", "--final").returncode, 0)
        self.lose_terminal_responses()
        self.assertEqual(self.box.run("complete", "--turn", turn_id, "--delivery", delivery).returncode, 7)
        self.assertEqual(self.box.run("complete", "--turn", turn_id, "--delivery", delivery).returncode, 0)
        events = self.event_requests(turn_id)
        terminal = [item for item in events if item["type"] == "completed"]
        self.assertGreaterEqual(len(terminal), 2)
        self.assertEqual({item["event_id"] for item in terminal}, {terminal[0]["event_id"]})
        self.assertEqual({item["seq"] for item in terminal}, {terminal[0]["seq"]})
        self.assertEqual(len({item["body_sha256"] for item in terminal}), 1)


class TerminalHeartbeatTest(unittest.TestCase):
    """The background loop keeps the lease through a retriable terminal failure and stops on success."""

    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.cleanup)
        self.fake = FakeOMB(self.box.token, lease_seconds=1).start()
        self.addCleanup(self.fake.close)
        self.box.write_config(self.fake.base_url)
        self.pid = None
        self.addCleanup(self._kill_loop)

    def _kill_loop(self):
        if self.pid is None:
            return
        try:
            os.kill(self.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    def env(self):
        return self.box.env(OMB_RELAY_HEARTBEAT_LOOP="1", OMB_RELAY_HEARTBEAT_INTERVAL_S="1")

    def claim(self):
        turn_id = self.fake.add_turn(text="long job")
        self.assertIn("status=deliveries", self.box.run("poll", "--wait-ms", "0", env=self.env()).stdout)
        claimed = self.box.run("claim", env=self.env())
        self.assertEqual(claimed.returncode, 0, claimed.stdout + claimed.stderr)
        claim = json.loads(claimed.stdout)
        pid_path = self.box.work / f"hb-{turn_id}.pid"
        self.assertTrue(wait_until(pid_path.exists, timeout=5.0), "claim must start the heartbeat loop")
        self.pid = int(pid_path.read_text().strip())
        path = write_text_file(self.box, "reply.txt", "partial")
        sent = self.box.run("send-text", "--turn", turn_id, "--delivery", claim["deliveryId"], "--text-file", str(path), "--final", env=self.env())
        self.assertEqual(sent.returncode, 0, sent.stdout + sent.stderr)
        return turn_id, claim["deliveryId"]

    def test_a_retriable_failure_keeps_the_lease_and_the_retry_is_accepted(self):
        turn_id, delivery = self.claim()
        self.fake.script_events(503, count=1 + omb_relay.EVENT_QUICK_RETRIES)
        failed = self.box.run("complete", "--turn", turn_id, "--delivery", delivery, env=self.env())
        self.assertEqual(failed.returncode, 7, failed.stdout + failed.stderr)
        heartbeats = self.fake.request_count("heartbeat")
        self.assertTrue(
            wait_until(lambda: self.fake.request_count("heartbeat") > heartbeats, timeout=5.0),
            "the loop must keep beating after the failed terminal command",
        )
        self.assertIsNone(os.kill(self.pid, 0) or None, "the heartbeat loop must still be running")

        # Longer than the 1 s lease: only the loop's beats keep the delivery alive, so no poll may
        # hand out a new attempt in the meantime.
        time.sleep(2.0)
        self.assertEqual(self.box.run("poll", "--wait-ms", "0", env=self.env()).stdout.count("status=deliveries"), 0)
        done = self.box.run("complete", "--turn", turn_id, "--delivery", delivery, env=self.env())
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("duplicate=false", done.stdout)
        self.assertEqual(self.fake.event_types(turn_id), ["text", "completed"])

    def test_an_accepted_terminal_event_stops_the_loop(self):
        turn_id, delivery = self.claim()
        done = self.box.run("complete", "--turn", turn_id, "--delivery", delivery, env=self.env())
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertTrue(wait_until(lambda: not (self.box.work / f"hb-{turn_id}.pid").exists(), timeout=5.0))
        heartbeats = self.fake.request_count("heartbeat")
        time.sleep(1.5)
        self.assertEqual(self.fake.request_count("heartbeat"), heartbeats, "no beat may follow a finished turn")


if __name__ == "__main__":
    unittest.main()
