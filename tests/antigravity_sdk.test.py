"""Offline contract and behavior tests; no provider calls or user credentials."""
from __future__ import annotations

import asyncio
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("agenthub_antigravity_sdk", ROOT / "integrations/antigravity/sdk/agenthub_antigravity.py")
sdk = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sdk)
try:
    REAL_SDK = sdk._sdk()
except sdk.SetupError:
    REAL_SDK = None


def call(name="hub_ask", **args):
    return SimpleNamespace(name=name, server_name=sdk.SERVER_NAME,
        id="call-1", step_id="step-1", args=args)


def result(data, *, name="hub_ask", error=None):
    return SimpleNamespace(name=name, server_name=sdk.SERVER_NAME,
        id="call-1", step_id="step-1", result=data, error=error)


class LedgerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.ledger = sdk.DispatchLedger(sdk.plan_jobs("Return 42", ["mimocode"]))

    async def test_concurrent_duplicates_reserve_exactly_once(self):
        request = call(worker="mimocode", task="Return 42")
        answers = await asyncio.gather(*(self.ledger.before(request) for _ in range(12)))
        self.assertEqual(sum(x[0] for x in answers), 1)
        self.assertEqual(self.ledger.report()[0]["status"], "unknown")

    async def test_ref_survives_unknown_and_fetch_completes_without_redispatch(self):
        await self.ledger.before(call(worker="mimocode", task="Return 42"))
        ref = "mimocode-a123"
        self.ledger.after(result({"ok": False, "worker": "mimocode", "status": "running", "ref": ref}))
        self.assertTrue((await self.ledger.before(call("hub_fetch", ref=ref)))[0])
        self.ledger.after(result(None, name="hub_fetch", error="network error"))
        self.assertEqual(self.ledger.report()[0]["ref"], ref)
        self.ledger.after(result({"status": "completed", "ref": ref, "answer": "42"}, name="hub_fetch"))
        self.assertEqual(self.ledger.report()[0]["answer"], "42")
        self.assertFalse((await self.ledger.before(call(worker="mimocode", task="Return 42")))[0])

    async def test_changed_task_unknown_ref_and_unapproved_overrides_are_denied(self):
        for args in [dict(worker="zcode", task="Return 42"),
                     dict(worker="mimocode", task="Return 43"),
                     dict(worker="mimocode", task="Return 42", model="other"),
                     dict(worker="mimocode", task="Return 42", thinking="on")]:
            self.assertFalse((await self.ledger.before(call(**args)))[0])
        self.assertFalse((await self.ledger.before(call("hub_fetch", ref="unknown-123")))[0])
        self.assertFalse((await self.ledger.before(call("hub_login", worker="mimocode", action="start")))[0])
        self.assertFalse((await self.ledger.before(call("hub_capabilities", refresh=True)))[0])

    async def test_dispatch_timeout_preserves_return_margin_and_expired_plan_does_not_submit(self):
        self.ledger.deadline = 150
        with patch.object(sdk.time, "monotonic", return_value=100):
            allowed, _, modified = await self.ledger.before(call(worker="mimocode", task="Return 42"))
        self.assertTrue(allowed)
        self.assertEqual(modified["timeout_s"], 45)
        expired = sdk.DispatchLedger(sdk.plan_jobs("Return 42", ["mimocode"]))
        expired.deadline = 100
        with patch.object(sdk.time, "monotonic", return_value=100):
            self.assertFalse((await expired.before(call(worker="mimocode", task="Return 42")))[0])
        self.assertEqual(expired.report()[0]["status"], "not_dispatched")

    async def test_receipt_wrapper_and_non_success_are_not_confused(self):
        await self.ledger.before(call(worker="mimocode", task="Return 42"))
        payload = {"ok": False, "worker": "mimocode", "status": "completed", "answer": "fake success"}
        self.ledger.after(result(json.dumps({"content": [{"type": "text", "text": json.dumps(payload)}]})))
        self.assertEqual(self.ledger.report()[0]["status"], "unknown")
        payload.update(ok=True, answer="42")
        self.ledger.after(result(json.dumps({"content": [{"type": "text", "text": json.dumps(payload)}]})))
        self.assertEqual(self.ledger.report()[0]["status"], "completed")

    async def test_completed_requires_nonempty_answer_for_ask_and_fetch(self):
        await self.ledger.before(call(worker="mimocode", task="Return 42"))
        for name in ["hub_ask", "hub_dispatch", "hub_fetch"]:
            for answer in [None, "  ", 42]:
                with self.subTest(name=name, answer=answer):
                    self.ledger.after(result({"ok": True, "worker": "mimocode",
                        "ref": "mimocode-a123", "status": "completed", "answer": answer}, name=name))
                    self.assertEqual(self.ledger.report()[0]["status"], "unknown")
                    self.assertEqual(self.ledger.report()[0]["ref"], "mimocode-a123")

    def test_prompt_treats_task_as_data_and_plan_rejects_duplicates(self):
        task = "quote ' and newline\n__import__('os').system('unexpected')"
        job = sdk.plan_jobs(task, ["mimocode"])[0]
        self.assertEqual(json.loads(sdk.dispatch_prompt(job).splitlines()[-1]), job)
        with self.assertRaises(sdk.SetupError):
            sdk.plan_jobs(task, ["mimocode", "mimocode"])

    async def test_dispatch_and_ask_share_one_reservation(self):
        first = await self.ledger.before(call("hub_dispatch", worker="mimocode", task="Return 42"))
        self.assertTrue(first[0])
        self.assertEqual(first[2]["timeout_s"], 300)
        self.assertFalse((await self.ledger.before(call(worker="mimocode", task="Return 42")))[0])


@unittest.skipUnless(REAL_SDK, "optional google-antigravity==0.1.21 is not installed")
class SDKTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.client = self.folder / "client.json"
        # Not a real configuration; SDK setup must never read or validate its token.
        self.client.write_text("not-json", encoding="utf-8")
        self.base = dict(client_file=self.client, workspace=self.folder, bridge=ROOT / "mcp/server.mjs")

    def tearDown(self):
        self.temp.cleanup()

    def test_real_config_types_permissions_defaults_and_worker_marker(self):
        with patch.dict(os.environ, {"AGENTHUB_WORKER_ID": "antigravity"}):
            config, _ = sdk.build_config(**self.base, jobs=sdk.plan_jobs("Return 42", ["mimocode"]))
        self.assertIsInstance(config, REAL_SDK[1])
        self.assertEqual(len(config.subagents), 9)
        self.assertTrue(all(x.capabilities.enabled_tools == [] for x in config.subagents))
        self.assertTrue(all(x.model is None for x in config.subagents))
        self.assertIsNone(config.model)
        self.assertEqual(config.capabilities.max_subagent_depth, 1)
        self.assertEqual(config.capabilities.allowed_subagents, ["hub_mimocode"])
        self.assertIsInstance(config.mcp_servers[0], REAL_SDK[3].McpStdioServer)
        self.assertEqual(config.mcp_servers[0].env["AGENTHUB_WORKER_ID"], "antigravity")
        self.assertEqual(config.mcp_servers[0].env["AGENTHUB_CONFIG"], str(self.client.resolve()))
        self.assertEqual(config.mcp_servers[0].env["AGENTHUB_CONNECTION_MODE"], "file")
        self.assertIn("hub_dispatch", config.mcp_servers[0].enabled_tools)
        self.assertNotIn("hub_ask", config.mcp_servers[0].enabled_tools)
        self.assertNotIn("hub_login", config.mcp_servers[0].enabled_tools)
        with patch.dict(os.environ, {}, clear=True):
            # Absolute node path avoids depending on PATH in this assertion.
            cfg, _ = sdk.build_config(**self.base, node=config.mcp_servers[0].command,
                jobs=sdk.plan_jobs("Return 42", ["mimocode"]))
        self.assertNotIn("AGENTHUB_WORKER_ID", cfg.mcp_servers[0].env)

    async def test_missing_key_prevents_agent_creation_and_reports_setup_link(self):
        with patch.dict(os.environ, {"GEMINI_API_KEY": ""}), patch.object(sdk, "build_config") as build:
            response = await sdk.run_workflow(**self.base, jobs=sdk.plan_jobs("Return 42", ["mimocode"]))
        self.assertEqual(response["status"], "blocked_auth")
        self.assertFalse(response["model_called"])
        self.assertEqual(response["credential_setup_url"], sdk.API_KEY_URL)
        build.assert_not_called()

    async def test_public_run_api_rejects_duplicate_workers_before_session_creation(self):
        jobs = [{"worker": "mimocode", "task": "Return 42"}] * 2
        with patch.object(sdk, "build_config") as build:
            with self.assertRaises(sdk.SetupError):
                await sdk.run_workflow(**self.base, jobs=jobs)
        build.assert_not_called()

    def test_doctor_never_exposes_key_or_client_contents(self):
        with patch.dict(os.environ, {"GEMINI_API_KEY": "dummy-test-value"}):
            report = sdk.doctor(**self.base)
        serialized = json.dumps(report)
        self.assertNotIn("dummy-test-value", serialized)
        self.assertNotIn("not-json", serialized)
        self.assertFalse(report["model_called"])
        self.assertFalse(report["beta_run_workflow_available"])

    async def _exercise(self, *, mode="parallel", hallucinate=False, hanging=False):
        trace = {"active": 0, "peak": 0, "order": [], "cancels": 0}
        types = REAL_SDK[3]

        class FakeResponse:
            stop_reason = types.StopReason.UNSPECIFIED

            def __init__(self, config, job):
                self.config, self.job = config, job

            async def text(self):
                if hallucinate:
                    return "All remote workers completed successfully."
                data = types.ToolCall(name="hub_dispatch", server_name=sdk.SERVER_NAME,
                    id="test-call", step_id="test-step", args=self.job)
                decision = await self.config.hooks[0].run(None, data)
                if not decision.allow:
                    raise AssertionError(decision.message)
                if hanging:
                    await asyncio.Event().wait()
                await asyncio.sleep(0.01)
                receipt = {"ok": True, "worker": self.job["worker"], "status": "completed", "answer": "42"}
                await self.config.hooks[1].run(None, types.ToolResult(
                    name="hub_dispatch", server_name=sdk.SERVER_NAME, id="test-call",
                    result=json.dumps(receipt)))
                return "Controller commentary is not used as a worker result."

            async def cancel(self):
                trace["cancels"] += 1

        class FakeAgent:
            def __init__(self, config):
                self.config = config

            async def __aenter__(self):
                trace["active"] += 1
                trace["peak"] = max(trace["peak"], trace["active"])
                return self

            async def __aexit__(self, *exc):
                trace["active"] -= 1

            async def chat(self, prompt):
                job = json.loads(prompt.splitlines()[-1])
                trace["order"].append(job["worker"])
                return FakeResponse(self.config, job)

        bundle = (FakeAgent,) + REAL_SDK[1:]
        with patch.object(sdk, "_sdk", return_value=bundle), patch.dict(os.environ, {"GEMINI_API_KEY": "dummy-test-value"}):
            output = await sdk.run_workflow(**self.base,
                jobs=sdk.plan_jobs("Return 42", ["mimocode", "codearts", "zcode"]),
                mode=mode, concurrency=2, timeout_s=0.1 if hanging else 5)
        return output, trace

    async def test_parallel_is_bounded_and_success_comes_from_hub_receipts(self):
        output, trace = await self._exercise()
        self.assertTrue(output["ok"])
        self.assertEqual(trace["peak"], 2)
        self.assertEqual([r["answer"] for r in output["results"]], ["42"] * 3)

    async def test_sequential_preserves_order_and_does_not_rewrite_tasks(self):
        output, trace = await self._exercise(mode="sequential")
        self.assertTrue(output["ok"])
        self.assertEqual(trace["peak"], 1)
        self.assertEqual(trace["order"], ["mimocode", "codearts", "zcode"])

    async def test_sdk_prose_without_receipts_is_not_success(self):
        output, _ = await self._exercise(hallucinate=True)
        self.assertFalse(output["ok"])
        self.assertTrue(all(r["status"] == "not_dispatched" for r in output["results"]))

    async def test_timeout_cancels_active_turn_and_does_not_retry(self):
        output, trace = await self._exercise(hanging=True)
        self.assertFalse(output["ok"])
        self.assertEqual(output["workflow_status"], "timeout")
        self.assertEqual(trace["cancels"], 2)
        self.assertEqual(trace["order"], ["mimocode", "codearts"])
        self.assertEqual([r["status"] for r in output["results"]], ["unknown", "unknown", "not_dispatched"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
