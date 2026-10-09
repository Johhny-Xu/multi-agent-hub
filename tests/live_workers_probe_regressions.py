"""Offline checks for live-probe evidence validation; makes no model calls."""
import json
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hub"))
from output_parser import parse_output
from live_workers_windows import verify_final


class ProbeValidationTests(unittest.TestCase):
    def test_only_final_text_can_prove_the_computation(self):
        expected = {"total":78,"nonce":"CHECK_TEST"}
        events = [
            {"type":"user","session_id":"test","message":{"content":json.dumps(expected)}},
            {"type":"assistant","session_id":"test","message":{"content":[{"type":"thinking","thinking":json.dumps(expected)},{"type":"tool_use","input":expected}]}},
            {"type":"result","is_error":False,"result":'{"total":77,"nonce":"CHECK_TEST"}'}]
        raw = "\n".join(json.dumps(event) for event in events)
        self.assertFalse(verify_final(parse_output(raw)["text"],78,"CHECK_TEST")[0])

    def test_final_json_and_code_fence_have_separate_format_evidence(self):
        text = '{"total":78,"nonce":"CHECK_TEST"}'
        self.assertEqual(verify_final(text,78,"CHECK_TEST")[:2],(True,True))
        self.assertEqual(verify_final('```json\n'+text+'\n```',78,"CHECK_TEST")[:2],(True,False))
        self.assertFalse(verify_final(text+'\n{"total":77,"nonce":"CHECK_TEST"}',78,"CHECK_TEST")[0])


if __name__ == "__main__":
    unittest.main()
