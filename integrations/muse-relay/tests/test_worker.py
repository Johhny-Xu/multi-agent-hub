import json
import os
import signal
import subprocess
import sys
import time
import unittest

import support
from support import FakeOMB, Sandbox, poll_and_claim, write_text_file


def fields(stdout: str) -> dict:
    result = {}
    for part in stdout.split():
        if "=" in part:
            key, value = part.split("=", 1)
            result[key] = value
    return result


class WorkerFlowTest(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.cleanup)
        self.fake = FakeOMB(self.box.token).start()
        self.addCleanup(self.fake.close)
        self.box.write_config(self.fake.base_url)

    def send(self, turn_id, delivery, text, *extra):
        path = write_text_file(self.box, f"reply-{time.time_ns()}.txt", text)
        return self.box.run(
            "send-text", "--turn", turn_id, "--delivery", delivery, "--text-file", str(path), *extra
        )

    def test_full_turn_round_trip(self):
        turn_id, claim = poll_and_claim(self.box, self.fake, text="make a note")
        delivery = claim["deliveryId"]
        text = self.send(turn_id, delivery, "hello from muse", "--final")
        self.assertEqual(text.returncode, 0, text.stderr)
        self.assertIn("seq=1", text.stdout)
        image = self.box.work / "pic.png"
        image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"pixels" * 10)
        upload = self.box.run(
            "send-file",
            "--turn",
            turn_id,
            "--delivery",
            delivery,
            "--path",
            str(image),
        )
        self.assertEqual(upload.returncode, 0, upload.stderr)
        self.assertIn("seq=2", upload.stdout)
        completed = self.box.run("complete", "--turn", turn_id, "--delivery", delivery)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("seq=3", completed.stdout)
        self.assertEqual(self.fake.event_types(turn_id), ["text", "file", "completed"])
        event_id = next(iter(self.fake.turns[turn_id]["files"]))
        self.assertEqual(self.fake.file_bytes(turn_id, event_id), image.read_bytes())
        ledger = self.box.ledger(turn_id)
        self.assertEqual(ledger["terminal"], "completed")
        self.assertEqual(ledger["nextSeq"], 4)
        self.assertEqual(self.box.processing_files(), [])
        self.assertEqual(self.box.pending_files(), [])
        self.box.assert_no_token(
            self,
            text.stdout,
            text.stderr,
            upload.stdout,
            upload.stderr,
            completed.stdout,
            completed.stderr,
        )

    def test_delta_then_final_text_share_item(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        delta = self.send(turn_id, delivery, "Hel", "--delta", "--item-id", "bubble-1")
        self.assertEqual(delta.returncode, 0, delta.stderr)
        self.assertIn("seq=1", delta.stdout)
        more = self.send(turn_id, delivery, "lo", "--delta", "--item-id", "bubble-1")
        self.assertEqual(more.returncode, 0, more.stderr)
        self.assertIn("seq=2", more.stdout)
        final = self.send(turn_id, delivery, "Hello", "--final", "--item-id", "bubble-1")
        self.assertEqual(final.returncode, 0, final.stderr)
        self.assertIn("seq=3", final.stdout)
        completed = self.box.run("complete", "--turn", turn_id, "--delivery", delivery)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(self.fake.event_types(turn_id), ["delta", "delta", "text", "completed"])
        events = self.fake.turns[turn_id]["events"]
        item_ids = {item["content"][1] for item in events.values() if item["type"] in ("delta", "text")}
        self.assertEqual(item_ids, {"bubble-1"})

    def test_final_text_must_match_deltas(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        delta = self.send(turn_id, delivery, "Hel", "--delta")
        self.assertEqual(delta.returncode, 0, delta.stderr)
        mismatch = self.send(turn_id, delivery, "World", "--final")
        self.assertEqual(mismatch.returncode, 5)
        self.assertIn("reason=delta_mismatch", mismatch.stdout)
        self.assertEqual(self.fake.event_types(turn_id), ["delta"])
        good = self.send(turn_id, delivery, "Hel", "--final")
        self.assertEqual(good.returncode, 0, good.stderr)
        self.assertIn("seq=2", good.stdout)

    def test_fail_is_terminal(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        self.send(turn_id, delivery, "partial")
        path = write_text_file(self.box, "failure.txt", "Muse could not finish this turn.")
        failed = self.box.run(
            "fail",
            "--turn",
            turn_id,
            "--delivery",
            delivery,
            "--text-file",
            str(path),
        )
        self.assertEqual(failed.returncode, 0, failed.stderr)
        self.assertEqual(self.fake.event_types(turn_id), ["text", "failed"])
        self.assertEqual(self.fake.turns[turn_id]["terminal"], "failed")
        after = self.box.run("complete", "--turn", turn_id, "--delivery", delivery)
        self.assertEqual(after.returncode, 6)

    def test_429_uses_retry_after(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        self.fake.script_events(429, {"Retry-After": "7"})
        first = self.send(turn_id, delivery, "retry me")
        self.assertEqual(first.returncode, 7)
        parsed = fields(first.stdout)
        self.assertEqual(parsed["reason"], "http_429")
        self.assertEqual(parsed["retry_ms"], "7000")
        ledger = self.box.ledger(turn_id)
        self.assertEqual(ledger["inflight"]["attempts"], 1)
        second = self.send(turn_id, delivery, "retry me")
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn("seq=1", second.stdout)
        self.assertEqual(self.fake.event_types(turn_id), ["text"])

    def test_5xx_is_retriable(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        self.fake.script_events(503, count=1 + support.omb_relay.EVENT_QUICK_RETRIES)
        first = self.send(turn_id, delivery, "again")
        self.assertEqual(first.returncode, 7)
        self.assertEqual(fields(first.stdout)["reason"], "http_503")
        second = self.send(turn_id, delivery, "again")
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn("seq=1", second.stdout)

    def test_sigterm_during_poll(self):
        self.fake.poll_hold_seconds = 5.0
        env = self.box.env()
        proc = subprocess.Popen(
            [sys.executable, str(support.CLI), "poll", "--wait-ms", "25000"],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        time.sleep(0.4)
        self.assertTrue(
            support.wait_until(lambda: self.fake.request_count("poll") == 1, timeout=10),
            "poll request never reached the fake",
        )
        proc.send_signal(signal.SIGTERM)
        stdout, stderr = proc.communicate(timeout=10)
        self.assertEqual(proc.returncode, 143, (stdout, stderr))
        self.assertEqual(self.box.pending_files(), [])
        self.box.assert_no_token(self, stdout, stderr)

    def test_missing_config_fails_closed(self):
        self.box.config.unlink()
        path = write_text_file(self.box, "reply.txt", "no config")
        result = self.box.run(
            "send-text", "--turn", "turn-1", "--delivery", "del-1", "--text-file", str(path)
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("config", result.stderr)
        self.assertEqual(self.fake.request_count(), 0)

    def test_file_name_traversal_rejected(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        path = self.box.work / "safe.bin"
        path.write_bytes(b"data")
        result = self.box.run(
            "send-file",
            "--turn",
            turn_id,
            "--delivery",
            claim["deliveryId"],
            "--path",
            str(path),
            "--name",
            "../evil.bin",
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.fake.request_count("files"), 0)

    def test_image_size_limit(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        path = self.box.work / "big.png"
        with open(path, "wb") as handle:
            handle.truncate((10 << 20) + 1)
        result = self.box.run(
            "send-file",
            "--turn",
            turn_id,
            "--delivery",
            claim["deliveryId"],
            "--path",
            str(path),
        )
        self.assertEqual(result.returncode, 5)
        self.assertIn("reason=too_large", result.stdout)
        self.assertEqual(self.fake.request_count("files"), 0)

    def test_symlink_file_rejected(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        real = self.box.work / "real.bin"
        real.write_bytes(b"data")
        link = self.box.work / "link.bin"
        os.symlink(real, link)
        result = self.box.run(
            "send-file",
            "--turn",
            turn_id,
            "--delivery",
            claim["deliveryId"],
            "--path",
            str(link),
        )
        self.assertEqual(result.returncode, 5)
        self.assertIn("reason=file_symlink", result.stdout)
        self.assertEqual(self.fake.request_count("files"), 0)

    def test_heartbeat_without_turn(self):
        result = self.box.run("heartbeat")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("cancelled=false", result.stdout)
        heartbeat = [item for item in self.fake.requests_snapshot() if item["endpoint"] == "heartbeat"]
        self.assertEqual(len(heartbeat), 1)
        self.assertIsNone(heartbeat[0]["turn_id"])

    def test_completed_turn_is_not_queued_again(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        self.send(turn_id, delivery, "done", "--final")
        self.box.run("complete", "--turn", turn_id, "--delivery", delivery)
        self.fake.queue_turn(turn_id)
        polled = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("status=empty", polled.stdout)
        self.assertEqual(self.box.pending_files(), [])
        self.assertEqual(self.box.run("claim").returncode, 3)


if __name__ == "__main__":
    unittest.main()
