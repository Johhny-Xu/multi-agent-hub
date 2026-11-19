"""fix-1119: quick retries for transient errors, resent deliveries, lease-aware pending pickup and the hook loop."""

from __future__ import annotations

import json
import time
import unittest

import support
from support import FakeOMB, Sandbox, poll_and_claim, write_text_file

omb_relay = support.omb_relay


def fields(stdout: str) -> dict:
    return dict(part.split("=", 1) for part in stdout.split() if "=" in part)


class QuickPollRetryTest(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.cleanup)
        self.fake = FakeOMB(self.box.token).start()
        self.addCleanup(self.fake.close)
        self.box.write_config(self.fake.base_url)

    def watch_state(self) -> dict:
        return self.box.read_json(self.box.state / "watch.state.json")

    def test_a_dropped_poll_answer_is_retried_in_the_same_run(self):
        self.fake.add_turn()
        self.fake.poll_drops = 1
        result = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("status=deliveries", result.stdout)
        # A failure this run recovered from is not a "recovered" notice: nothing was logged as an error.
        self.assertEqual(fields(result.stdout)["notify"], "0")
        self.assertEqual(self.fake.request_count("poll"), 2)
        self.assertEqual(self.watch_state()["failures"], 0)
        self.assertEqual(len(self.box.pending_files()), 1)
        self.assertIn("poll_retry reason=network", (self.box.state / "trace.log").read_text())

    def test_up_to_three_transient_failures_are_retried_at_once(self):
        self.fake.add_turn()
        self.fake.poll_drops = 2
        self.fake.script_poll(503, count=1)
        result = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("status=deliveries", result.stdout)
        self.assertEqual(self.fake.request_count("poll"), 1 + omb_relay.POLL_QUICK_RETRIES)

    def test_backoff_starts_only_after_the_quick_retries(self):
        self.fake.poll_drops = 1 + omb_relay.POLL_QUICK_RETRIES
        before = time.time()
        result = self.box.run("poll", "--wait-ms", "0")
        parsed = fields(result.stdout)
        self.assertEqual(parsed["status"], "error")
        self.assertEqual(parsed["reason"], "network")
        self.assertEqual(parsed["retry_ms"], "1000")
        self.assertEqual(parsed["notify"], "1")
        self.assertEqual(self.fake.request_count("poll"), 1 + omb_relay.POLL_QUICK_RETRIES)
        state = self.watch_state()
        self.assertEqual(state["failures"], 1 + omb_relay.POLL_QUICK_RETRIES)
        self.assertGreaterEqual(state["nextPollAt"], before + 1)
        # The next failure doubles the pause and makes a single request.
        state["nextPollAt"] = 0
        (self.box.state / "watch.state.json").write_text(json.dumps(state))
        self.fake.poll_drops = 1
        again = fields(self.box.run("poll", "--wait-ms", "0").stdout)
        self.assertEqual(again["retry_ms"], "2000")
        self.assertEqual(self.fake.request_count("poll"), 2 + omb_relay.POLL_QUICK_RETRIES)

    def test_quick_retries_count_failures_carried_over_from_earlier_runs(self):
        state = {"failures": 2, "nextPollAt": 0, "lastReason": "network", "lastSuccessAt": 0}
        (self.box.state / "watch.state.json").write_text(json.dumps(state))
        self.fake.poll_drops = 5
        parsed = fields(self.box.run("poll", "--wait-ms", "0").stdout)
        self.assertEqual(parsed["status"], "error")
        self.assertEqual(self.fake.request_count("poll"), 2)
        self.assertEqual(self.watch_state()["failures"], 4)
        self.assertEqual(parsed["retry_ms"], "1000")

    def test_retry_after_and_non_transient_errors_are_not_retried_at_once(self):
        self.fake.script_poll(429, {"Retry-After": "7"})
        parsed = fields(self.box.run("poll", "--wait-ms", "0").stdout)
        self.assertEqual(parsed["reason"], "http_429")
        self.assertEqual(parsed["retry_ms"], "7000")
        self.assertEqual(self.fake.request_count("poll"), 1)
        self.fake.script_poll(503, {"Retry-After": "3"})
        state = self.watch_state()
        state["nextPollAt"] = 0
        (self.box.state / "watch.state.json").write_text(json.dumps(state))
        parsed = fields(self.box.run("poll", "--wait-ms", "0").stdout)
        self.assertEqual(parsed["reason"], "http_503")
        self.assertEqual(self.fake.request_count("poll"), 2)
        self.assertGreaterEqual(int(parsed["retry_ms"]), 3000)

    def test_without_time_left_the_next_run_retries_without_backoff(self):
        self.fake.poll_drops = 3
        env = self.box.env(OMB_RELAY_RUN_DEADLINE=int(time.time()) + 2)
        parsed = fields(self.box.run("poll", "--wait-ms", "0", env=env).stdout)
        self.assertEqual(parsed["status"], "error")
        self.assertEqual(parsed["retry_ms"], "0")
        self.assertEqual(self.fake.request_count("poll"), 1)
        self.assertEqual(self.watch_state()["failures"], 1)
        self.fake.add_turn()
        again = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("status=deliveries", again.stdout)
        self.assertEqual(fields(again.stdout)["notify"], "1")


class ResentDeliveryTest(unittest.TestCase):
    """OMB resends an untouched claim (same deliveryId and attempt): the client must keep exactly one copy."""

    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.cleanup)
        self.fake = FakeOMB(self.box.token).start()
        self.addCleanup(self.fake.close)
        self.box.write_config(self.fake.base_url)

    def body(self, delivery: dict) -> dict:
        return {"schemaVersion": 1, "deliveries": [dict(delivery)], "cancellations": [], "serverTime": omb_relay.now_iso()}

    def test_a_resent_delivery_is_kept_once_in_pending_processing_and_done(self):
        turn_id = self.fake.add_turn(text="resend me")
        with self.fake.lock:
            self.fake.queue.remove(turn_id)
            delivery = self.fake._issue(turn_id, by_ref=True)
        self.fake.script_poll_body(self.body(delivery), count=4)

        first = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("status=deliveries", first.stdout)
        slices = self.fake.request_count("input")
        self.assertGreater(slices, 0)

        while_pending = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("status=empty", while_pending.stdout)
        self.assertEqual(len(self.box.pending_files()), 1)
        self.assertEqual(self.fake.request_count("input"), slices)

        claimed = self.box.run("claim")
        self.assertEqual(claimed.returncode, 0, claimed.stderr)
        claim = json.loads(claimed.stdout)
        self.assertEqual((claim["deliveryId"], claim["attempt"]), (delivery["deliveryId"], delivery["attempt"]))

        while_processing = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("status=empty", while_processing.stdout)
        self.assertEqual(self.box.pending_files(), [])
        self.assertEqual(self.box.run("claim").returncode, 3)

        path = write_text_file(self.box, "reply.txt", "done once")
        sent = self.box.run("send-text", "--turn", turn_id, "--delivery", claim["deliveryId"], "--text-file", str(path), "--final")
        self.assertEqual(sent.returncode, 0, sent.stdout + sent.stderr)
        completed = self.box.run("complete", "--turn", turn_id, "--delivery", claim["deliveryId"])
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)

        after_done = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("status=empty", after_done.stdout)
        self.assertEqual(self.box.pending_files(), [])
        self.assertEqual(self.fake.event_types(turn_id), ["text", "completed"])
        trace = (self.box.state / "trace.log").read_text()
        self.assertIn("duplicate turn=", trace)

    def test_poll_records_the_granted_lease_for_keepalive(self):
        self.fake.add_turn()
        self.box.run("poll", "--wait-ms", "0")
        record = self.box.read_json(self.box.pending_files()[0])
        self.assertEqual(record["leaseSeconds"], self.fake.lease_seconds)


class LeaseAwareKeepaliveTest(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.cleanup)
        self.fake = FakeOMB(self.box.token).start()
        self.addCleanup(self.fake.close)
        self.box.write_config(self.fake.base_url)

    def age_pending(self, seconds: float, lease: int | None) -> None:
        path = self.box.write_pending("turn-keepalive-0001")
        record = self.box.read_json(path)
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - seconds)) + ".000Z"
        record["receivedAt"] = stamp
        if lease is not None:
            record["leaseSeconds"] = lease
        path.write_text(json.dumps(record))

    def test_an_old_server_lease_is_waited_out_before_dropping(self):
        # An OMB without fix-1119 gives the claim its full 120 s lease: dropping at 75 s would only lose time.
        self.age_pending(100, 120)
        self.assertIn("waiting=1", self.box.run("keepalive").stdout)
        self.assertEqual(len(self.box.pending_files()), 1)
        self.age_pending(130, 120)
        self.assertIn("dropped=1", self.box.run("keepalive").stdout)
        self.assertEqual(self.box.pending_files(), [])

    def test_a_short_lease_or_none_uses_the_pickup_window(self):
        self.age_pending(80, 20)
        self.assertIn("dropped=1", self.box.run("keepalive").stdout)
        self.age_pending(80, None)
        self.assertIn("dropped=1", self.box.run("keepalive").stdout)
        self.age_pending(60, 20)
        self.assertIn("waiting=1", self.box.run("keepalive").stdout)
        self.assertEqual(self.fake.request_count(), 0)


class QuickEventRetryTest(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.cleanup)
        self.fake = FakeOMB(self.box.token).start()
        self.addCleanup(self.fake.close)
        self.box.write_config(self.fake.base_url)

    def send(self, turn_id, delivery, text, *extra):
        path = write_text_file(self.box, f"reply-{time.time_ns()}.txt", text)
        return self.box.run("send-text", "--turn", turn_id, "--delivery", delivery, "--text-file", str(path), *extra)

    def test_send_text_survives_a_503_and_a_lost_answer_without_exit_7(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        self.fake.script_events(503)
        first = self.send(turn_id, delivery, "one", "--final")
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertIn("seq=1", first.stdout)
        # The server stores the completed event but its answer is lost: the repeat (same eventId) is a duplicate.
        self.fake.event_drops = 1
        done = self.box.run("complete", "--turn", turn_id, "--delivery", delivery)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("duplicate=true", done.stdout)
        self.assertEqual(self.fake.event_types(turn_id), ["text", "completed"])
        self.assertIsNone(self.box.ledger(turn_id)["inflight"])
        trace = (self.box.state / "trace.log").read_text()
        self.assertIn("quick_retry what=text", trace)
        self.assertIn("quick_retry what=completed", trace)

    def test_heartbeat_is_retried_at_once(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        self.fake.script_heartbeat(502)
        result = self.box.run("heartbeat", "--turn", turn_id, "--delivery", claim["deliveryId"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("cancelled=false", result.stdout)
        self.assertEqual(self.fake.request_count("heartbeat"), 2)

    def test_quick_retries_are_bounded_then_exit_7_as_before(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        self.fake.script_events(504, count=10)
        result = self.send(turn_id, claim["deliveryId"], "bounded")
        self.assertEqual(result.returncode, 7)
        self.assertEqual(fields(result.stdout)["reason"], "http_504")
        self.assertEqual(self.fake.request_count("events"), 1 + omb_relay.EVENT_QUICK_RETRIES)


class HookLoopTest(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.cleanup)
        self.fake = FakeOMB(self.box.token).start()
        self.addCleanup(self.fake.close)
        self.box.write_config(self.fake.base_url)

    def run_watch(self, **extra):
        import subprocess

        return subprocess.run(
            ["bash", str(support.WATCH)], env=self.box.env(**extra), capture_output=True, text=True, timeout=60
        )

    def test_an_error_inside_the_loop_pauses_it_instead_of_ending_the_run(self):
        self.fake.add_turn()
        self.fake.poll_drops = 1 + omb_relay.POLL_QUICK_RETRIES
        started = time.time()
        result = self.run_watch(OMB_RELAY_LOOP_SECONDS=6, OMB_RELAY_POLL_INTERVAL_MS=1000)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.box.read_trace()
        self.assertIn("LOG muse-relay poll error reason=network", calls)
        self.assertIn("LOG muse-relay poll recovered", calls)
        self.assertIn("WAKE_AFTER_PERSIST muse_relay_turn", calls)
        self.assertNotIn("SILENT", calls)
        self.assertEqual(len(self.box.pending_files()), 1)
        self.assertLess(time.time() - started, 6)

    def test_the_loop_keeps_polling_until_a_turn_arrives(self):
        import threading

        timer = threading.Timer(2.0, lambda: self.fake.add_turn())
        timer.start()
        self.addCleanup(timer.cancel)
        result = self.run_watch(OMB_RELAY_LOOP_SECONDS=8, OMB_RELAY_POLL_INTERVAL_MS=1000)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("WAKE_AFTER_PERSIST muse_relay_turn", self.box.read_trace())
        self.assertGreaterEqual(self.fake.request_count("poll"), 2)

    def test_the_loop_ends_with_one_silent_when_nothing_comes(self):
        started = time.time()
        result = self.run_watch(OMB_RELAY_LOOP_SECONDS=3, OMB_RELAY_POLL_INTERVAL_MS=1000)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.box.read_trace().count("SILENT no deliveries"), 1)
        self.assertGreaterEqual(self.fake.request_count("poll"), 3)
        self.assertLess(time.time() - started, 8)


if __name__ == "__main__":
    unittest.main()
