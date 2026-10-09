"""Exercise the real optional SDK's hook protocol without a harness or model.

These tests use google-antigravity 0.1.21's HookRunner, HookRouter and protobuf
messages. They validate protocol adaptation, not autonomous model routing or
remote worker execution. Environments without that SDK explicitly skip them.
"""
import importlib.metadata
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "agenthub_sdk_protocol_fixture",
    ROOT / "integrations/antigravity/sdk/agenthub_antigravity.py",
)
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)

try:
    SDK_VERSION = importlib.metadata.version("google-antigravity")
except importlib.metadata.PackageNotFoundError:
    SDK_VERSION = None

SDK_READY = SDK_VERSION == adapter.SDK_VERSION
SKIP_REASON = (
    "Optional google-antigravity SDK is not installed; real SDK protocol checks were not run"
    if SDK_VERSION is None else
    f"Real protocol checks require google-antigravity {adapter.SDK_VERSION}; found {SDK_VERSION}"
)
if SDK_READY:
    from google.antigravity.connections.local import struct_converter
    from google.antigravity.connections.local.hook_router import HookRouter
    from google.antigravity.hooks.hook_runner import HookRunner
    from google.antigravity.proto import localharness_pb2 as pb


@unittest.skipUnless(SDK_READY, SKIP_REASON)
@unittest.skipUnless(shutil.which("node"), "Node.js is required to construct the real MCP configuration")
class AntigravitySDKProtocolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="agenthub-sdk-protocol-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.client = self.base / "client.json"
        # Configuration construction checks the path without reading this file
        # or starting a bridge. No real credentials are needed or copied.
        self.client.write_text("{}", encoding="utf-8")
        self.make_router()

    def make_router(self):
        config, self.ledger = adapter.build_config(
            client_file=self.client, workspace=self.base,
            jobs=[{"worker": "mimocode", "task": "Fixture task"}],
        )
        self.events = []

        async def capture(event):
            self.events.append(event)

        self.router = HookRouter(HookRunner(hooks=config.hooks), capture)

    async def pre(self, name, args, call_id, server=adapter.SERVER_NAME):
        message = pb.CallHookRequest(
            request_id="pre-" + call_id,
            type=pb.LIFECYCLE_HOOK_PRE_TOOL,
            pre_tool_args=pb.PreToolArgs(
                tool_name=name, server_name=server, call_id=call_id,
                trajectory_id="synthetic-sdk-subagent", step_index=1,
                arguments_json=json.dumps(args),
            ),
        )
        await self.router.handle(message)
        return self.events[-1].call_hook_response.pre_tool_result

    async def post(self, name, value, call_id, *, server=adapter.SERVER_NAME, error="", wrapper=True):
        content = {"content": [{"type": "text", "text": json.dumps(value)}]} if wrapper else value
        message = pb.CallHookRequest(
            request_id="post-" + call_id,
            type=pb.LIFECYCLE_HOOK_POST_TOOL,
            post_tool_args=pb.PostToolArgs(
                tool_name=name, server_name=server, call_id=call_id,
                trajectory_id="synthetic-sdk-subagent", step_index=1,
                result=json.dumps(content), error=error,
            ),
        )
        await self.router.handle(message)

    async def dispatch_running(self):
        result = await self.pre("hub_dispatch", {"worker": "mimocode", "task": "Fixture task"}, "dispatch")
        self.assertEqual(result.decision, pb.PreToolResult.Decision.ALLOW)
        await self.post("hub_dispatch", {
            "ok": True, "worker": "mimocode", "status": "running", "ref": "mimocode-abc123",
        }, "dispatch")
        self.assertEqual(self.ledger.report()[0]["status"], "running")

    async def test_partial_hook_overrides_merge_with_worker_and_task_on_real_wire(self):
        original = {"worker": "mimocode", "task": "Fixture task", "timeout_s": 1}
        result = await self.pre("hub_dispatch", original, "dispatch")
        expected = dict(original, timeout_s=300, thinking="default", stream=False)
        self.assertEqual(result.decision, pb.PreToolResult.Decision.ALLOW)
        self.assertEqual(result.modified_args, struct_converter.to_struct(expected))
        self.assertEqual(self.ledger.reserved, {"mimocode"})

    async def test_namespace_is_an_independent_server_field(self):
        await self.pre("hub_dispatch", {"worker": "mimocode", "task": "Fixture task"}, "dispatch")
        await self.post("hub_dispatch", {
            "ok": True, "worker": "mimocode", "status": "completed", "answer": "unrelated",
        }, "dispatch", server="other_server")
        self.assertEqual(self.ledger.report()[0]["status"], "unknown")
        self.assertEqual(self.ledger.report()[0]["answer"], "")
        await self.post("hub_dispatch", {
            "ok": True, "worker": "mimocode", "status": "completed", "answer": "observed receipt",
        }, "dispatch")
        self.assertEqual(self.ledger.report()[0]["answer"], "observed receipt")

    async def test_dispatch_wrapper_and_fetch_without_worker_preserve_original_ref(self):
        await self.dispatch_running()
        result = await self.pre("hub_fetch", {"ref": "mimocode-abc123"}, "fetch")
        self.assertEqual(result.decision, pb.PreToolResult.Decision.ALLOW)
        await self.post("hub_fetch", {"status": "completed", "answer": "remote answer"}, "fetch", wrapper=False)
        self.assertEqual(self.ledger.report()[0], {
            "worker": "mimocode", "status": "completed", "answer": "remote answer", "ref": "mimocode-abc123",
        })

    async def test_fetch_error_preserves_ref_and_blocks_repeat_dispatch(self):
        await self.dispatch_running()
        await self.pre("hub_fetch", {"ref": "mimocode-abc123"}, "fetch")
        await self.post("hub_fetch", None, "fetch", error="Synthetic transport failure")
        self.assertEqual(self.ledger.report()[0]["status"], "unknown")
        self.assertEqual(self.ledger.report()[0]["ref"], "mimocode-abc123")
        denied = await self.pre("hub_dispatch", {"worker": "mimocode", "task": "Fixture task"}, "repeat")
        self.assertEqual(denied.decision, pb.PreToolResult.Decision.DENY)
        self.assertIn("never resubmit", denied.reason)
        allowed = await self.pre("hub_fetch", {"ref": "mimocode-abc123"}, "continue-fetch")
        self.assertEqual(allowed.decision, pb.PreToolResult.Decision.ALLOW)

    async def test_empty_completed_receipts_stay_unknown_and_keep_ref(self):
        for answer_fields in ({}, {"answer": ""}, {"answer": " \n"}, {"answer": 42}):
            with self.subTest(answer_fields=answer_fields):
                self.make_router()
                await self.dispatch_running()
                await self.pre("hub_fetch", {"ref": "mimocode-abc123"}, "fetch")
                await self.post("hub_fetch", {"status": "completed", **answer_fields}, "fetch")
                self.assertEqual(self.ledger.report()[0]["status"], "unknown")
                self.assertEqual(self.ledger.report()[0]["ref"], "mimocode-abc123")


if __name__ == "__main__":
    unittest.main(verbosity=2)
