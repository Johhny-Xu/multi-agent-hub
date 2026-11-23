"""Inbound system-prompt limits and file uploads (BUGSCAN-1119 C04/C15)."""

from __future__ import annotations

import json
import threading
import time
import unittest

import support
from support import FakeOMB, Sandbox, poll_and_claim, write_text_file

omb_relay = support.omb_relay
KIB = 1024


class SystemPromptLimitTest(unittest.TestCase):
    """The client must accept what the server queues: one MiB of UTF-8 per text or system prompt."""

    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.cleanup)
        self.fake = FakeOMB(self.box.token).start()
        self.addCleanup(self.fake.close)
        self.box.write_config(self.fake.base_url)

    def poll(self):
        return self.box.run("poll", "--wait-ms", "0")

    def test_a_system_prompt_above_the_single_event_limit_is_accepted(self):
        system = "s" * ((256 * KIB) + 1)
        turn_id = self.fake.add_turn(system=system)
        result = self.poll()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("status=deliveries", result.stdout)
        record = self.box.read_json(self.box.pending_files()[0])
        self.assertEqual(record["turnId"], turn_id)
        self.assertEqual(record["input"]["system"], system)

    def test_the_one_mib_boundary_is_accepted(self):
        system = "s" * (1 << 20)
        self.fake.add_turn(system=system)
        result = self.poll()
        self.assertIn("status=deliveries", result.stdout)
        record = self.box.read_json(self.box.pending_files()[0])
        self.assertEqual(len(record["input"]["system"].encode("utf-8")), 1 << 20)

    def test_one_byte_over_one_mib_is_rejected_and_saves_nothing(self):
        self.fake.add_turn(system="s" * ((1 << 20) + 1))
        result = self.poll()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("status=error", result.stdout)
        self.assertIn("reason=invalid_response", result.stdout)
        self.assertEqual(self.box.pending_files(), [])

    def test_the_limit_counts_utf8_bytes_not_characters(self):
        # 100k characters are 300 KB of UTF-8: above the 256 KiB single-event limit, under one MiB.
        system = "字" * 100_000
        self.fake.add_turn(system=system)
        self.assertIn("status=deliveries", self.poll().stdout)
        record = self.box.read_json(self.box.pending_files()[0])
        self.assertEqual(record["input"]["system"], system)

        self.fake.add_turn(system="字" * ((1 << 20) // 3 + 1))
        rejected = self.poll()
        self.assertIn("status=error", rejected.stdout)
        self.assertEqual(len(self.box.pending_files()), 1)


class FileUploadTest(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.cleanup)
        self.fake = FakeOMB(self.box.token, lease_seconds=1, file_chunk_delay=0.05, file_chunk_bytes=4096).start()
        self.addCleanup(self.fake.close)
        self.box.write_config(self.fake.base_url)

    def upload(self, turn_id, delivery, path, *extra):
        return self.box.run("send-file", "--turn", turn_id, "--delivery", delivery, "--path", str(path), *extra)

    def file_requests(self):
        return [item for item in self.fake.requests_snapshot() if item["endpoint"] == "files"]

    def test_a_slow_upload_outlives_the_lease_because_the_server_renews_per_chunk(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        path = self.box.work / "big.bin"
        path.write_bytes(b"x" * (256 * KIB))
        polls: list[list] = []

        def poll_once():
            body = json.dumps({"schemaVersion": 1, "waitMs": 0, "limit": 1, "inputMode": "ref"}).encode("utf-8")
            polls.append(self.fake._poll("", {}, body).body["deliveries"])

        timer = threading.Timer(1.5, poll_once)
        started = time.time()
        timer.start()
        result = self.upload(turn_id, delivery, path)
        timer.cancel()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertGreater(time.time() - started, 1.5, "the upload must outlive the lease")
        self.assertGreater(self.fake.upload_renewals, 5)
        self.assertEqual(len(polls), 1)
        self.assertEqual(polls[0], [], "a live lease must not hand out a second attempt")
        self.assertEqual(self.fake.request_count("files"), 1)
        record = self.box.ledger(turn_id)["events"]
        self.assertEqual(len(record), 1)
        self.assertEqual(next(iter(record.values()))["type"], "file")

    def test_the_pre_upload_heartbeat_discovers_a_replaced_delivery_first(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        path = self.box.work / "note.txt"
        path.write_bytes(b"hello")
        self.fake.rotate_delivery(turn_id)
        result = self.upload(turn_id, claim["deliveryId"], path)
        self.assertEqual(result.returncode, 4, result.stdout + result.stderr)
        self.assertIn("status=stale", result.stdout)
        self.assertEqual(self.fake.request_count("files"), 0)

    def test_a_cancelled_turn_is_discovered_before_any_byte_is_sent(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        path = self.box.work / "note.txt"
        path.write_bytes(b"hello")
        self.fake.cancel_turn(turn_id)
        result = self.upload(turn_id, claim["deliveryId"], path)
        self.assertEqual(result.returncode, 8, result.stdout + result.stderr)
        self.assertIn("status=cancelled", result.stdout)
        self.assertEqual(self.fake.request_count("files"), 0)

    def test_a_retried_upload_keeps_its_event_id_seq_and_upload_id(self):
        turn_id, claim = poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        path = write_text_file(self.box, "note.txt", "retry me")
        self.fake.script_files(503)
        first = self.upload(turn_id, delivery, path, "--event-id", "evt-f")
        self.assertEqual(first.returncode, 7, first.stdout + first.stderr)
        inflight = self.box.ledger(turn_id)["inflight"]
        self.assertEqual(inflight["type"], "file")
        self.assertIsNone(self.box.ledger(turn_id)["events"].get(inflight["eventId"]))

        again = self.upload(turn_id, delivery, path, "--event-id", "evt-f")
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertIn("duplicate=false", again.stdout)
        requests = self.file_requests()
        self.assertEqual(len(requests), 2)
        self.assertEqual({item["event_id"] for item in requests}, {inflight["eventId"]})
        self.assertEqual({item["seq"] for item in requests}, {str(inflight["seq"])})
        record = self.box.ledger(turn_id)["events"][inflight["eventId"]]
        self.assertEqual(record["uploadId"], f"up-{inflight['eventId']}")

        # The same command again is a local duplicate: the server already holds these bytes.
        third = self.upload(turn_id, delivery, path, "--event-id", "evt-f")
        self.assertEqual(third.returncode, 0, third.stdout + third.stderr)
        self.assertIn("duplicate=true", third.stdout)
        self.assertEqual(self.fake.request_count("files"), 2)


if __name__ == "__main__":
    unittest.main()
