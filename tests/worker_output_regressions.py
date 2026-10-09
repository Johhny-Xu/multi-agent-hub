import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hub"))
from output_parser import parse_output, parse_usage

def lines(*events):
    return "\n".join(json.dumps(event) for event in events)

class WorkerOutputTests(unittest.TestCase):
    def test_plain_and_unknown_user_json_remain_intact(self):
        for text in ('{"type":"result","value":42}', '{"text":"document"}', '{"error":{"message":"example in a document"}}', 'a plain answer\nwith lines'):
            self.assertEqual(parse_output(text), {"text":text,"error":None})

    def test_codebuddy_final_takes_priority_and_keeps_long_answer(self):
        answer = "complete start\n" + "x" * 12000 + "\ncomplete end"
        raw = lines({"type":"assistant","session_id":"test","message":{"content":[{"type":"thinking","thinking":"DO NOT DISPLAY"},{"type":"text","text":"interim"}]}}, {"type":"result","session_id":"test","is_error":False,"subtype":"success","result":answer})
        self.assertEqual(parse_output(raw), {"text":answer,"error":None})

    def test_codebuddy_error_exit_zero_and_empty_final_are_preserved(self):
        raw = lines({"type":"assistant","session_id":"test","message":{"content":[{"type":"text","text":"interim"}]}}, {"type":"result","is_error":True,"subtype":"error_during_execution","result":"Permission denied"})
        self.assertEqual(parse_output(raw)["error"], "Permission denied")
        self.assertEqual(parse_output(lines({"type":"result","is_error":False,"result":""}))["text"], "")

    def test_codebuddy_plain_auth_diagnostic_exit_zero(self):
        result = parse_output("401 Authentication required. Please use /login command to sign in to your account (auth-type:cli-external-link,token-type:Bearer,token-length:1234)")
        self.assertEqual(result["text"], "")
        self.assertIn("authentication required", result["error"])
        self.assertNotIn("1234", result["error"])
        self.assertEqual(parse_output("401 Authentication required is an example status in this document")["error"], None)

    def test_codebuddy_delta_fallback_excludes_tool_arguments_and_thinking(self):
        def delta(kind, **values):
            return {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":kind,**values}}}
        raw = lines(delta("thinking_delta",thinking="PRIVATE"), delta("input_json_delta",partial_json='{"answer":"not real"}'), delta("text_delta",text="Hello "), delta("text_delta",text="world"))
        self.assertEqual(parse_output(raw), {"text":"Hello world","error":None})

    def test_mimo_parts_error_and_tool_results(self):
        raw = lines({"type":"tool_use","sessionID":"test","part":{"type":"tool_use","state":{"output":"NOT THE ANSWER"}}}, {"type":"reasoning","sessionID":"test","part":{"type":"reasoning","text":"PRIVATE"}}, {"type":"text","sessionID":"test","part":{"id":"part1","messageID":"message1","type":"text","text":"Final answer"}})
        self.assertEqual(parse_output(raw), {"text":"Final answer","error":None})
        failed = {"type":"error","sessionID":"test","error":{"name":"UnknownError","data":{"message":"MiMo free API service has ended"}}}
        self.assertEqual(parse_output(json.dumps(failed))["error"], "MiMo free API service has ended")

    def test_copilot_final_replaces_deltas_and_error_exit(self):
        raw = lines({"type":"assistant.message_delta","timestamp":"now","data":{"messageId":"a","deltaContent":"Final"}}, {"type":"assistant.message","timestamp":"now","data":{"content":"Final answer","phase":"response"}}, {"type":"result","sessionId":"test","exitCode":0})
        self.assertEqual(parse_output(raw), {"text":"Final answer","error":None})
        failed = lines({"type":"session.error","timestamp":"now","data":{"message":"Unavailable model"}}, {"type":"result","sessionId":"test","exitCode":1})
        self.assertIsNotNone(parse_output(failed)["error"])

    def test_zcode_and_minimax_envelopes_only_return_public_text(self):
        zcode = {"sessionId":"test","traceId":"test","response":"answer","usage":{"reasoningTokens":99}}
        self.assertEqual(parse_output(json.dumps(zcode)), {"text":"answer","error":None})
        self.assertEqual(parse_output(json.dumps(dict(zcode,type="result"))), {"text":"answer","error":None})
        minimax = {"type":"message","role":"assistant","model":"MiniMax-M3.1-Flash-Preview","usage":{},"content":[{"type":"thinking","thinking":"PRIVATE"},{"type":"text","text":"answer"}]}
        self.assertEqual(parse_output(json.dumps(minimax)), {"text":"answer","error":None})

    def test_subagent_output_does_not_replace_primary_worker_answer(self):
        raw = lines({"type":"assistant","session_id":"test","parent_tool_use_id":"child","message":{"content":[{"type":"text","text":"Child output"}]}}, {"type":"assistant","session_id":"test","message":{"content":[{"type":"text","text":"Primary output"}]}})
        self.assertEqual(parse_output(raw)["text"], "Primary output")

    def test_antigravity_official_json_and_stream_error_shapes(self):
        completed = {"conversation_id":"test","status":"SUCCESS","response":"Final answer","usage":{"thinking_tokens":5}}
        self.assertEqual(parse_output(json.dumps(completed)), {"text":"Final answer","error":None})
        raw = lines({"event":"step_update","step_update":{"conversation_id":"test","step_type":"tool","tool_info":{"output":"NOT THE ANSWER"}}},
            {"event":"step_update","step_update":{"conversation_id":"test","step_type":"agent_response","text_delta":"Partial"}}, {"event":"result","result":completed})
        self.assertEqual(parse_output(raw), {"text":"Final answer","error":None})
        failed = dict(completed,status="ERROR",response="",error="User location is not supported for the API use")
        self.assertEqual(parse_output(json.dumps({"event":"result","result":failed})), {"text":"","error":failed["error"]})

    def test_antigravity_print_timeout_overrides_success_only_on_stderr(self):
        diagnostic = '[agy] print timeout after 1m0s with turn in progress; returning partial output\n'
        for response in ('', 'unfinished answer'):
            payload = json.dumps({'conversation_id': 'test', 'status': 'SUCCESS', 'response': response, 'usage': {}})
            result = parse_output(payload, stderr=diagnostic)
            self.assertEqual(result['text'], '')
            self.assertIn('CLI_PARTIAL_TIMEOUT', result['error'])
        self.assertIsNone(parse_output(diagnostic)['error'])
        self.assertIsNone(parse_output('answer', stderr='CLI_SPINNER')['error'])

    def test_public_usage_allowlist_never_returns_reasoning_or_metadata(self):
        raw = lines({"type":"assistant","session_id":"test","message":{"model":"deepseek-v4.1-flash","content":[{"type":"thinking","thinking":"PRIVATE"}],"usage":{"input_tokens":9,"reasoning_tokens":0,"api_key":"PRIVATE"}}},
            {"type":"result","is_error":False,"result":"answer","usage":{"reasoning_tokens":11,"output_tokens":12,"total_tokens":21,"account":{"token":"PRIVATE"},"thinking":"PRIVATE"}})
        self.assertEqual(parse_usage(raw), {"model":"deepseek-v4.1-flash","input_tokens":9,"reasoning_tokens":11,"output_tokens":12,"total_tokens":21})
        self.assertEqual(parse_usage('{"model":"document","usage":{"reasoning_tokens":99}}'), {})
        self.assertEqual(parse_usage(lines({"type":"step_finish","sessionID":"test","part":{"tokens":{"input":5,"output":6,"reasoning":7}}})), {"input_tokens":5,"output_tokens":6,"reasoning_tokens":7})

    def test_new_message_progress_does_not_reuse_previous_turn(self):
        cb = lines({"type":"assistant","session_id":"test","message":{"content":[{"type":"text","text":"Previous round"}]}},
            {"type":"stream_event","event":{"type":"message_start"}},
            {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Current round"}}})
        self.assertEqual(parse_output(cb)["text"], "Current round")
        copilot = lines({"type":"assistant.message","id":"test","data":{"content":"Previous round"}},
            {"type":"assistant.message_delta","id":"test","data":{"messageId":"new","deltaContent":"Current round"}})
        self.assertEqual(parse_output(copilot)["text"], "Current round")

    def test_codebuddy_provider_numeric_reasoning_details_are_summed_once(self):
        event = {"type":"message","role":"assistant","providerData":{"messageId":"a","stepSeq":1,"reasoning":"PRIVATE","usage":{"outputTokensDetails":[{"reasoning_tokens":12}]}}}
        second = {"type":"message","role":"assistant","providerData":{"messageId":"b","stepSeq":2,"usage":{"outputTokensDetails":[{"reasoning_tokens":4}]}}}
        self.assertEqual(parse_usage(lines(event,event,second))["reasoning_tokens"],16)

    def test_codebuddy_final_token_details_and_single_model_usage(self):
        event = {"type":"result","is_error":False,"result":"answer","usage":{"outputTokensDetails":[{"reasoning_tokens":0}]}}
        self.assertEqual(parse_usage(json.dumps(event))["reasoning_tokens"],0)
        event["modelUsage"] = {"deepseek-v4.1-flash":{"inputTokens":7,"outputTokens":8,"output_tokens_details":{"reasoning_tokens":4}}}
        self.assertEqual(parse_usage(json.dumps(event)), {"model":"deepseek-v4.1-flash","input_tokens":7,"output_tokens":8,"reasoning_tokens":4})
        event["modelUsage"]["second-model"] = {"inputTokens":100,"reasoning_tokens":99}
        self.assertEqual(parse_usage(json.dumps(event)), {"reasoning_tokens":0})

    def test_codebuddy_function_usage_counters_do_not_expose_tool_arguments(self):
        event = {"type":"function_call","sessionId":"test","arguments":"PRIVATE","providerData":{"messageId":"a","stepSeq":1,"reasoning":"PRIVATE","usage":{"outputTokensDetails":[{"reasoning_tokens":10}]}}}
        final = {"type":"message","role":"assistant","sessionId":"test","content":"answer","providerData":{"messageId":"b","stepSeq":2,"usage":{"outputTokensDetails":[{"reasoning_tokens":0}]}}}
        self.assertEqual(parse_usage(lines(event,final)), {"reasoning_tokens":10})

if __name__ == "__main__":
    unittest.main()
