"""Deliveries by reference (poll inputMode=ref + sliced /input) and long replies split into small events."""

import json
import time
import unittest

import support
from support import FakeOMB, Sandbox, write_text_file
from test_worker import fields

import omb_relay

RESPONSE_CAP = 6 * 1024


def big_transcript() -> list:
    return [
        {"role": "assistant" if index % 2 else "user", "text": f"消息 {index}: " + "x" * 900}
        for index in range(12)
    ]


class InputRefTest(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.cleanup)
        self.fake = FakeOMB(self.box.token).start()
        self.addCleanup(self.fake.close)
        self.box.write_config(self.fake.base_url)

    def add_big_turn(self) -> str:
        return self.fake.add_turn(text="总结一下 ✓", system="system prompt " * 300, transcript=big_transcript())

    def input_size(self, turn_id: str) -> int:
        from fake_omb import input_bytes

        return len(input_bytes(self.fake.turns[turn_id]["input"]))

    def poll(self):
        return self.box.run("poll", "--wait-ms", "0")

    def test_big_delivery_arrives_whole_through_small_responses(self):
        turn_id = self.add_big_turn()
        size = self.input_size(turn_id)
        self.assertGreater(size, 15_000)
        result = self.poll()
        self.assertIn("status=deliveries", result.stdout, result.stderr)
        polls = [r for r in self.fake.requests_snapshot() if r["endpoint"] == "poll"]
        self.assertEqual(polls[0]["input_mode"], "ref")
        slices = [r for r in self.fake.requests_snapshot() if r["endpoint"] == "input"]
        self.assertEqual(len(slices), -(-size // omb_relay.INPUT_SLICE_BYTES))
        self.assertEqual([r["offset"] for r in slices], [i * 4096 for i in range(len(slices))])
        self.assertLessEqual(self.fake.max_response(), RESPONSE_CAP)
        pending = self.box.pending_files()
        self.assertEqual(len(pending), 1)
        record = self.box.read_json(pending[0])
        self.assertEqual(record["input"], self.fake.turns[turn_id]["input"])
        self.assertNotIn("inputBytes", record)
        claimed = self.box.run("claim")
        self.assertEqual(claimed.returncode, 0, claimed.stderr)
        self.assertEqual(json.loads(claimed.stdout)["input"]["transcript"], big_transcript())
        self.box.assert_no_token(self, result.stdout, result.stderr)

    def test_sha_mismatch_is_retriable_and_saves_nothing(self):
        self.add_big_turn()
        self.fake.input_corrupt = 1
        result = self.poll()
        parsed = fields(result.stdout)
        self.assertEqual(parsed["status"], "error")
        self.assertEqual(parsed["reason"], "input_sha_mismatch")
        self.assertEqual(self.box.pending_files(), [])

    def test_slice_is_retried_after_transient_failures(self):
        turn_id = self.add_big_turn()
        self.fake.script_input(503, count=2)
        self.fake.input_drops = 1
        result = self.poll()
        self.assertIn("status=deliveries", result.stdout, result.stderr)
        slices = [r for r in self.fake.requests_snapshot() if r["endpoint"] == "input"]
        expected = -(-self.input_size(turn_id) // omb_relay.INPUT_SLICE_BYTES)
        self.assertEqual(len(slices), expected + 3)
        self.assertEqual(len(self.box.pending_files()), 1)

    def test_slice_gives_up_as_retriable_after_its_attempts(self):
        self.add_big_turn()
        self.fake.script_input(503, count=omb_relay.INPUT_SLICE_ATTEMPTS)
        started = time.time()
        result = self.poll()
        parsed = fields(result.stdout)
        self.assertEqual(parsed["status"], "error")
        self.assertEqual(parsed["reason"], "http_503")
        self.assertLess(time.time() - started, 30)
        self.assertEqual(self.box.pending_files(), [])
        slices = [r for r in self.fake.requests_snapshot() if r["endpoint"] == "input"]
        self.assertEqual(len(slices), omb_relay.INPUT_SLICE_ATTEMPTS)

    def test_stale_delivery_during_fetch_is_skipped(self):
        self.add_big_turn()
        self.fake.script_input(409)
        result = self.poll()
        self.assertIn("status=empty", result.stdout, result.stderr)
        self.assertEqual(self.box.pending_files(), [])

    def test_inline_delivery_from_an_older_server_still_works(self):
        now = omb_relay.now_iso()
        self.fake.script_poll_body(
            {
                "schemaVersion": 1,
                "deliveries": [
                    {
                        "turnId": "turn-inline",
                        "deliveryId": "del-inline",
                        "attempt": 1,
                        "leaseUntil": now,
                        "createdAt": now,
                        "input": {"threadId": "thread-1", "text": "hi", "system": "", "transcript": []},
                    }
                ],
                "cancellations": [],
                "serverTime": now,
            }
        )
        result = self.poll()
        self.assertIn("status=deliveries", result.stdout, result.stderr)
        self.assertEqual(self.fake.request_count("input"), 0)
        self.assertEqual(self.box.read_json(self.box.pending_files()[0])["input"]["text"], "hi")

    def test_invalid_ref_is_rejected(self):
        now = omb_relay.now_iso()
        self.fake.script_poll_body(
            {
                "schemaVersion": 1,
                "deliveries": [
                    {
                        "turnId": "turn-x",
                        "deliveryId": "del-x",
                        "attempt": 1,
                        "leaseUntil": now,
                        "createdAt": now,
                        "inputBytes": 10,
                        "inputSha256": "not-a-hash",
                    }
                ],
                "cancellations": [],
                "serverTime": now,
            }
        )
        result = self.poll()
        self.assertIn("reason=invalid_response", result.stdout)
        self.assertEqual(self.box.pending_files(), [])


class SplitTextTest(unittest.TestCase):
    def test_parts_rejoin_and_stay_small(self):
        samples = [
            "",
            "short",
            "a" * 10_000,
            "汉字" * 3_000,
            ("line of text\n" * 900),
            ("word " * 2_500) + "😀" * 700,
        ]
        for text in samples:
            parts = omb_relay.split_text(text)
            self.assertEqual("".join(parts), text)
            self.assertTrue(all(len(part.encode("utf-8")) <= omb_relay.TEXT_PART_BYTES for part in parts))
            self.assertTrue(all(part for part in parts) or text == "")
            for part in parts:
                encoded = json.dumps(part, ensure_ascii=False).encode("utf-8")
                self.assertLessEqual(len(encoded) - 2, omb_relay.TEXT_PART_BYTES)

    def test_escapes_count_toward_the_limit(self):
        for text in ("\n" * 10_000, '"' * 9_000, "\x01" * 5_000, "a\r\n" * 4_000):
            parts = omb_relay.split_text(text)
            self.assertEqual("".join(parts), text)
            for part in parts:
                self.assertLessEqual(len(json.dumps(part, ensure_ascii=False).encode("utf-8")) - 2, omb_relay.TEXT_PART_BYTES)
                self.assertFalse(part.endswith("\r") and text != part)

    def test_prefers_line_breaks(self):
        text = ("x" * 99 + "\n") * 100
        parts = omb_relay.split_text(text)
        self.assertTrue(all(part.endswith("\n") for part in parts))


class LongReplyTest(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.cleanup)
        self.fake = FakeOMB(self.box.token).start()
        self.addCleanup(self.fake.close)
        self.box.write_config(self.fake.base_url)

    def send(self, turn_id, delivery, text, *extra):
        path = write_text_file(self.box, f"reply-{time.time_ns()}.txt", text)
        return self.box.run("send-text", "--turn", turn_id, "--delivery", delivery, "--text-file", str(path), *extra)

    def test_long_text_goes_out_as_ordered_small_events_and_resumes(self):
        turn_id, claim = support.poll_and_claim(self.box, self.fake)
        delivery = claim["deliveryId"]
        text = "".join(f"段落 {index}: " + "y" * 300 + "\n" for index in range(40))
        self.assertGreater(len(text.encode("utf-8")), 3 * omb_relay.TEXT_PART_BYTES)
        parts = omb_relay.split_text(text)
        self.fake.script_events(503, count=1, skip=1)  # the first part goes through, the second gets a 503
        first = self.send(turn_id, delivery, text, "--final")
        self.assertEqual(first.returncode, 7, first.stdout + first.stderr)
        self.assertEqual(self.fake.event_types(turn_id), ["text"])
        second = self.send(turn_id, delivery, text, "--final")
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn(f"parts={len(parts)}", second.stdout)
        third = self.send(turn_id, delivery, text, "--final")
        self.assertEqual(third.returncode, 0, third.stderr)
        self.assertIn("duplicate=true", third.stdout)
        self.assertEqual(self.fake.event_types(turn_id), ["text"] * len(parts))
        events = sorted(self.fake.turns[turn_id]["events"].values(), key=lambda item: item["seq"])
        self.assertEqual("".join(item["content"][2] for item in events), text)
        self.assertEqual(len({item["content"][1] for item in events}), len(parts))
        bodies = [r["body_len"] for r in self.fake.requests_snapshot() if r["endpoint"] == "events"]
        self.assertTrue(all(size < 6 * 1024 for size in bodies), bodies)
        completed = self.box.run("complete", "--turn", turn_id, "--delivery", delivery)
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_short_text_is_one_event(self):
        turn_id, claim = support.poll_and_claim(self.box, self.fake)
        result = self.send(turn_id, claim["deliveryId"], "hello")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("parts=", result.stdout)
        self.assertEqual(self.fake.event_types(turn_id), ["text"])


if __name__ == "__main__":
    unittest.main()
