import fcntl
import json
import os
import shutil
import time
import unittest

from support import FakeOMB, Sandbox, age_processing, poll_and_claim


@unittest.skipUnless(shutil.which("bash") and shutil.which("flock"), "needs bash + flock")
class WatchScriptTest(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.cleanup)
        self.fake = FakeOMB(self.box.token).start()
        self.addCleanup(self.fake.close)
        self.box.write_config(self.fake.base_url)

    def test_empty_poll_is_silent(self):
        result = self.box.run_watch()
        self.assertEqual(result.returncode, 0, result.stderr)
        trace = self.box.read_trace()
        self.assertIn("SILENT no deliveries", trace)
        self.assertNotIn("WAKE", trace)

    def test_delivery_is_persisted_before_wake(self):
        self.fake.add_turn(text="from omb")
        result = self.box.run_watch()
        self.assertEqual(result.returncode, 0, result.stderr)
        trace = self.box.read_trace()
        self.assertIn('WAKE_AFTER_PERSIST muse_relay_turn {"count":1}', trace)
        self.assertEqual(len(self.box.pending_files()), 1)
        record = self.box.read_json(self.box.pending_files()[0])
        self.assertEqual(record["input"]["text"], "from omb")
        self.assertEqual(self.fake.request_count("poll"), 1)

    def test_existing_pending_wakes_without_poll(self):
        self.box.write_pending("turn-manual")
        result = self.box.run_watch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("WAKE_AFTER_PERSIST", self.box.read_trace())
        self.assertEqual(self.fake.request_count("poll"), 0)

    def test_invalid_poll_is_an_error_not_empty(self):
        self.fake.script_poll_body({"schemaVersion": 1, "deliveries": "nope"})
        result = self.box.run_watch()
        self.assertEqual(result.returncode, 0, result.stderr)
        trace = self.box.read_trace()
        self.assertIn("LOG muse-relay poll error reason=invalid_response", trace)
        self.assertIn("SILENT poll error", trace)
        self.assertEqual(self.box.pending_files(), [])
        state = self.box.read_json(self.box.state / "watch.state.json")
        self.assertEqual(state["failures"], 1)

    def test_backoff_skips_network(self):
        state = {
            "failures": 2,
            "nextPollAt": time.time() + 60,
            "lastReason": "http_503",
            "lastSuccessAt": 0,
        }
        (self.box.state / "watch.state.json").write_text(json.dumps(state))
        result = self.box.run_watch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("SILENT backoff", self.box.read_trace())
        self.assertEqual(self.fake.request_count(), 0)

    def test_single_instance_lock(self):
        lock_path = self.box.state / "watch.lock"
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            result = self.box.run_watch()
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.box.read_trace().strip(), "")
        self.assertEqual(self.fake.request_count(), 0)

    def test_cancellation_is_persisted(self):
        turn_id = self.fake.add_turn()
        self.fake.cancel_turn(turn_id)
        result = self.box.run_watch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(list((self.box.state / "cancelled").iterdir()))
        self.assertEqual(self.box.pending_files(), [])
        self.assertIn("SILENT no deliveries", self.box.read_trace())

    def test_recover_supersedes_stale_processing_then_wakes(self):
        turn_id, _ = poll_and_claim(self.box, self.fake)
        age_processing(self.box)
        self.box.write_pending(turn_id, delivery_id="del-new")
        result = self.box.run_watch()
        self.assertEqual(result.returncode, 0, result.stderr)
        pending = self.box.read_json(self.box.pending_files()[0])
        self.assertEqual(pending["deliveryId"], "del-new")
        self.assertTrue(list((self.box.state / "stale").iterdir()))
        self.assertIn("WAKE_AFTER_PERSIST", self.box.read_trace())

    def test_claim_retires_older_processing_for_a_redelivery(self):
        turn_id, first = poll_and_claim(self.box, self.fake)
        self.box.write_pending(turn_id, delivery_id="del-newer", attempt=first["attempt"] + 1)
        claimed = self.box.run("claim")
        self.assertEqual(claimed.returncode, 0, claimed.stderr)
        self.assertEqual(json.loads(claimed.stdout)["deliveryId"], "del-newer")
        self.assertTrue(list((self.box.state / "stale").iterdir()))

    def test_keepalive_drops_only_unclaimed_pending_past_the_pickup_window(self):
        self.fake.add_turn()
        polled = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("status=deliveries", polled.stdout)
        before = self.fake.request_count()
        fresh = self.box.run("keepalive")
        self.assertIn("waiting=1", fresh.stdout)
        self.assertEqual(len(self.box.pending_files()), 1)
        path = self.box.pending_files()[0]
        record = self.box.read_json(path)
        record["receivedAt"] = "2000-01-01T00:00:00Z"
        path.write_text(json.dumps(record))
        old = self.box.run("keepalive")
        self.assertIn("dropped=1", old.stdout)
        self.assertEqual(self.box.pending_files(), [])
        self.assertEqual(self.fake.request_count(), before)

    def test_recover_recycles_stale_claim_without_poll(self):
        poll_and_claim(self.box, self.fake)
        age_processing(self.box)
        before = self.fake.request_count("poll")
        result = self.box.run_watch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.box.pending_files()), 1)
        self.assertEqual(self.box.processing_files(), [])
        self.assertIn("WAKE_AFTER_PERSIST", self.box.read_trace())
        self.assertEqual(self.fake.request_count("poll"), before)

    def test_poll_429_logs_and_backs_off(self):
        self.fake.script_poll(429, {"Retry-After": "7"})
        result = self.box.run_watch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("LOG muse-relay poll error reason=http_429", self.box.read_trace())
        state = self.box.read_json(self.box.state / "watch.state.json")
        self.assertEqual(state["failures"], 1)
        self.assertGreater(state["nextPollAt"], time.time())

    def test_recovery_is_logged(self):
        state = {
            "failures": 1,
            "nextPollAt": 0,
            "lastReason": "http_503",
            "lastSuccessAt": 0,
        }
        (self.box.state / "watch.state.json").write_text(json.dumps(state))
        result = self.box.run_watch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("LOG muse-relay poll recovered", self.box.read_trace())

    def test_token_never_reaches_trace_or_state(self):
        self.fake.add_turn(text="private text")
        result = self.box.run_watch()
        self.box.assert_no_token(self, self.box.read_trace(), result.stdout, result.stderr)
        self.assertNotIn(self.box.token, self.box.read_trace())


if __name__ == "__main__":
    unittest.main()
