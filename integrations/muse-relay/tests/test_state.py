import json
import os
import subprocess
import sys
import time
import unittest

import support
from support import FakeOMB, Sandbox, poll_and_claim, write_text_file


class StateMachineTest(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.cleanup)
        self.fake = FakeOMB(self.box.token).start()
        self.addCleanup(self.fake.close)
        self.box.write_config(self.fake.base_url)

    def send_text(self, turn_id, delivery_id, text, *extra):
        path = write_text_file(self.box, f"{turn_id}-{time.time_ns()}.txt", text)
        return self.box.run(
            "send-text",
            "--turn",
            turn_id,
            "--delivery",
            delivery_id,
            "--text-file",
            str(path),
            *extra,
        )

    def age_processing(self, seconds=3600):
        processing = self.box.processing_files()[0]
        record = self.box.read_json(processing)
        record["claimedAtEpoch"] = time.time() - seconds
        record["heartbeatEpoch"] = 0
        processing.write_text(json.dumps(record))
        old = time.time() - seconds
        os.utime(processing, (old, old))

    def test_claim_is_atomic_across_processes(self):
        self.fake.add_turn()
        self.box.run("poll", "--wait-ms", "0")
        env = self.box.env()
        procs = [
            subprocess.Popen(
                [sys.executable, str(support.CLI), "claim"],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            for _ in range(6)
        ]
        results = [proc.communicate(timeout=30) for proc in procs]
        codes = [proc.returncode for proc in procs]
        self.assertEqual(codes.count(0), 1, results)
        self.assertEqual(codes.count(3), 5, results)

    def test_second_claim_is_empty(self):
        _, claim = poll_and_claim(self.box, self.fake)
        second = self.box.run("claim")
        self.assertEqual(second.returncode, 3)
        self.assertIn("status=no_pending", second.stdout)

    def test_corrupt_pending_is_quarantined(self):
        (self.box.state / "pending").mkdir(parents=True, exist_ok=True)
        (self.box.state / "pending" / "bad.json").write_text("{not json")
        result = self.box.run("claim")
        self.assertEqual(result.returncode, 3)
        self.assertEqual(self.box.pending_files(), [])
        self.assertTrue(list((self.box.state / "corrupt").iterdir()))

    def test_recover_recycles_stale_processing(self):
        turn_id, _ = poll_and_claim(self.box, self.fake)
        self.age_processing()
        result = self.box.run("recover", "--stale-seconds", "60")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("recovered=1", result.stdout)
        self.assertEqual(len(self.box.pending_files()), 1)
        self.assertEqual(self.box.processing_files(), [])

    def test_recover_does_not_overwrite_pending(self):
        turn_id, _ = poll_and_claim(self.box, self.fake)
        self.age_processing()
        self.box.write_pending(turn_id, delivery_id="del-new")
        result = self.box.run("recover", "--stale-seconds", "60")
        self.assertEqual(result.returncode, 0, result.stderr)
        pending = self.box.read_json(self.box.pending_files()[0])
        self.assertEqual(pending["deliveryId"], "del-new")
        self.assertTrue(list((self.box.state / "stale").iterdir()))

    def test_recover_keeps_fresh_processing(self):
        poll_and_claim(self.box, self.fake)
        result = self.box.run("recover", "--stale-seconds", "900")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(self.box.processing_files()), 1)
        self.assertEqual(self.box.pending_files(), [])

    def test_ledger_seq_and_local_duplicate(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        first = self.send_text(turn_id, delivery, "first", "--event-id", "evt-a")
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIn("seq=1", first.stdout)
        second = self.send_text(turn_id, delivery, "second", "--event-id", "evt-b")
        self.assertIn("seq=2", second.stdout)
        requests = self.fake.request_count("events")
        again = self.send_text(turn_id, delivery, "first", "--event-id", "evt-a")
        self.assertEqual(again.returncode, 0)
        self.assertIn("duplicate=true", again.stdout)
        self.assertIn("seq=1", again.stdout)
        self.assertEqual(self.fake.request_count("events"), requests)
        self.assertEqual(self.fake.event_types(turn_id), ["text", "text"])

    def test_complete_requires_a_text(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        result = self.box.run("complete", "--turn", turn_id, "--delivery", claim["deliveryId"])
        self.assertEqual(result.returncode, 5)
        self.assertIn("reason=completed_requires_text", result.stdout)
        self.assertEqual(self.fake.request_count("events"), 0)

    def test_file_is_idempotent(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        first = self.box.work / "one.png"
        first.write_bytes(b"\x89PNG\r\n\x1a\n" + b"a" * 32)
        result = self.box.run(
            "send-file",
            "--turn",
            turn_id,
            "--delivery",
            delivery,
            "--path",
            str(first),
            "--event-id",
            "evt-f",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("seq=1", result.stdout)
        self.assertEqual(self.fake.request_count("files"), 1)
        again = self.box.run(
            "send-file",
            "--turn",
            turn_id,
            "--delivery",
            delivery,
            "--path",
            str(first),
            "--event-id",
            "evt-f",
        )
        self.assertEqual(again.returncode, 0)
        self.assertIn("duplicate=true", again.stdout)
        self.assertEqual(self.fake.request_count("files"), 1)
        other = self.box.work / "two.png"
        other.write_bytes(b"\x89PNG\r\n\x1a\n" + b"b" * 32)
        conflict = self.box.run(
            "send-file",
            "--turn",
            turn_id,
            "--delivery",
            delivery,
            "--path",
            str(other),
            "--event-id",
            "evt-f",
        )
        self.assertEqual(conflict.returncode, 6)

    def test_heartbeat_updates_processing(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        result = self.box.run(
            "heartbeat", "--turn", turn_id, "--delivery", claim["deliveryId"]
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("cancelled=false", result.stdout)
        processing = self.box.read_json(self.box.processing_files()[0])
        self.assertGreater(processing.get("heartbeatEpoch", 0), 0)

    def test_stale_delivery_stops_without_retry(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        self.fake.rotate_delivery(turn_id)
        first = self.send_text(turn_id, delivery, "late")
        self.assertEqual(first.returncode, 4)
        self.assertIn("status=stale", first.stdout)
        requests = self.fake.request_count("events")
        second = self.send_text(turn_id, delivery, "late")
        self.assertEqual(second.returncode, 4)
        self.assertEqual(self.fake.request_count("events"), requests)

    def test_cancelled_turn_stops_send(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        self.fake.cancel_turn(turn_id)
        heartbeat = self.box.run("heartbeat", "--turn", turn_id, "--delivery", delivery)
        self.assertIn("cancelled=true", heartbeat.stdout)
        result = self.send_text(turn_id, delivery, "should not send")
        self.assertEqual(result.returncode, 8)
        self.assertIn("status=cancelled", result.stdout)
        self.assertEqual(self.fake.request_count("events"), 0)
        finished = self.box.run(
            "finish", "--turn", turn_id, "--delivery", delivery, "--reason", "cancelled"
        )
        self.assertEqual(finished.returncode, 0)
        self.assertEqual(self.box.processing_files(), [])
        self.assertEqual(self.box.ledger(turn_id)["terminal"], "cancelled")

    def test_poll_cancellation_clears_pending(self):
        turn_id = self.fake.add_turn()
        self.box.run("poll", "--wait-ms", "0")
        self.assertEqual(len(self.box.pending_files()), 1)
        self.fake.cancel_turn(turn_id)
        self.box.run("poll", "--wait-ms", "0")
        self.assertEqual(self.box.pending_files(), [])
        self.assertTrue(list((self.box.state / "cancelled").iterdir()))
        self.assertEqual(self.box.run("claim").returncode, 3)

    def test_retry_inflight_resolves_lost_response(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        self.fake.event_drops = 1
        lost = self.send_text(turn_id, delivery, "only once")
        self.assertEqual(lost.returncode, 7)
        self.assertIn("status=retry", lost.stdout)
        retried = self.box.run("retry-inflight", "--turn", turn_id, "--delivery", delivery)
        self.assertEqual(retried.returncode, 0, retried.stderr)
        self.assertIn("duplicate=true", retried.stdout)
        self.assertIn("seq=1", retried.stdout)
        completed = self.box.run("complete", "--turn", turn_id, "--delivery", delivery)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(self.fake.event_types(turn_id), ["text", "completed"])

    def test_claim_reports_resume_after_crash(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        self.fake.event_drops = 1
        self.send_text(turn_id, delivery, "in flight")
        processing = self.box.processing_files()[0]
        os.replace(processing, self.box.state / "pending" / processing.name)
        claimed = self.box.run("claim")
        self.assertEqual(claimed.returncode, 0, claimed.stderr)
        output = json.loads(claimed.stdout)
        self.assertIsNotNone(output["resume"])
        self.assertEqual(output["resume"]["seq"], 1)
        self.assertEqual(output["resume"]["type"], "text")
        retried = self.box.run("retry-inflight", "--turn", turn_id, "--delivery", delivery)
        self.assertEqual(retried.returncode, 0, retried.stderr)

    def test_seq_continues_across_redelivery(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        old_delivery = claim["deliveryId"]
        first = self.send_text(turn_id, old_delivery, "one")
        self.assertIn("seq=1", first.stdout)
        self.fake.rotate_delivery(turn_id)
        self.box.run("finish", "--turn", turn_id, "--delivery", old_delivery, "--reason", "stale")
        self.fake.queue_turn(turn_id)
        polled = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("status=deliveries", polled.stdout)
        claimed = self.box.run("claim")
        self.assertEqual(claimed.returncode, 0, claimed.stderr)
        new_claim = json.loads(claimed.stdout)
        self.assertNotEqual(new_claim["deliveryId"], old_delivery)
        second = self.send_text(turn_id, new_claim["deliveryId"], "two")
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn("seq=2", second.stdout)
        seqs = sorted(item["seq"] for item in self.fake.turns[turn_id]["events"].values())
        self.assertEqual(seqs, [1, 2])
        old = self.send_text(turn_id, old_delivery, "late")
        self.assertEqual(old.returncode, 4)
        self.assertEqual(len(self.fake.turns[turn_id]["events"]), 2)


if __name__ == "__main__":
    unittest.main()
