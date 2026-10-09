import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const roots = ["../mcp/", "../plugins/agenthub-workers/mcp/", "../integrations/dsh/mcp/", "../integrations/codex/mcp/", "../integrations/codearts/mcp/"];

test("Hub tokens are sent in Authorization and explicit URL credentials take precedence", async (t) => {
  const received = [];
  const hub = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ url: req.url, authorization: req.headers.authorization });
    const rpc = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'synthetic status' }] } }));
  });
  await new Promise((r) => hub.listen(0, '127.0.0.1', r));
  const original = { url: process.env.AGENTHUB_URL, token: process.env.HUB_TOKEN };
  t.after(() => {
    hub.close();
    for (const [key, value] of [["AGENTHUB_URL", original.url], ["HUB_TOKEN", original.token]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.HUB_TOKEN = "FAKE_TEST_TOKEN +&";
  for (const root of roots) {
    process.env.AGENTHUB_URL = `http://127.0.0.1:${hub.address().port}/mcp?route=test`;
    const merged = await import(new URL(root + "hub.mjs?url-token-test", import.meta.url));
    await merged.hubStatus();
    assert.deepEqual(received.at(-1), { url: '/mcp?route=test', authorization: 'Bearer FAKE_TEST_TOKEN +&' });
    process.env.AGENTHUB_URL = `http://127.0.0.1:${hub.address().port}/mcp?token=FAKE_URL_TOKEN`;
    const retained = await import(new URL(root + "hub.mjs?url-token-existing", import.meta.url));
    await retained.hubStatus();
    assert.deepEqual(received.at(-1), { url: '/mcp', authorization: 'Bearer FAKE_URL_TOKEN' });
  }
});

test("bridge copies stay independently installable and identical", async () => {
  for (const file of ["hub.mjs", "server.mjs", "ask.mjs", "login.mjs", "config.mjs", "discovery.mjs"]) {
    const copies = await Promise.all(roots.map((root) => readFile(new URL(root + file, import.meta.url), "utf8")));
    const hashes = copies.map((copy) => createHash("sha256").update(copy).digest("hex"));
    for (const hash of hashes.slice(1)) assert.equal(hash, hashes[0], `${file} drifted`);
  }
});

test("bridge task and transport regressions", async (t) => {
  let mode = "completed";
  let requests = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const rpc = JSON.parse(text);
    requests.push(rpc.params);
    response.setHeader("Content-Type", "application/json");
    const name = rpc.params.name;
    const worker = rpc.params.arguments.agent || "codebuddy";
    const ref = `${worker}-abc123`;
    let output = `[${worker}/${ref}] accepted`;
    let isError = false;
    if (mode === "http") response.statusCode = 503;
    if (mode === "tool") { isError = true; output = `[${worker}/${ref}] rejected`; }
    if (mode === "sync") output = `[${worker}/model] exit=0\nDONE`;
    if (mode === "syncFailure") output = `[${worker}/model] exit=7\nfailed; quoted ${ref}`;
    if (mode === "zcodeBody") output += "\nzcode 未配置 CLI is quoted by the user";
    if (mode === "zcodeUnavailable" && name === "hub_dispatch_cli") output = "zcode 未配置 CLI";
    if (name === "hub_wait_result" || name === "hub_result") {
      output = `[codebuddy-abc123] agent=codebuddy status=completed\nDONE\n(继续对话 session_id: s)\n(exit=0)`;
      if (mode === "empty") output = `[codebuddy-abc123] status=completed\n(无输出)\n(exit=0)`;
      if (mode === "workerError") output = `[codebuddy-abc123] status=error\nAuthentication failed`;
      if (mode === "bodyStatus") output = `[codebuddy-abc123] status=running\nThe task says status=completed`;
      if (mode === "conflictingExit") output = `[codebuddy-abc123] status=completed\nFailure\n(exit=7)`;
      if (mode === "wrongRef") output = `[codebuddy-fff999] status=completed\nOther task`;
      if (mode === "missing") output = "未找到 codebuddy-abc123 的结果 (可能尚未落盘, 稍后再查)。";
      if (mode === "waitNetwork") { response.destroy(); return; }
      if (mode === "waitDelay") await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (mode === "dispatchDelay" && name === "hub_dispatch_cli") await new Promise((resolve) => setTimeout(resolve, 400));
    if (mode === "rpcError") {
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32603, message: "Rejected by Hub" } }));
      return;
    }
    if (mode === "invalidJson") { response.end("not-json"); return; }
    const content = mode === "multiText" && name === "hub_result"
      ? [{ type: "text", text: "[codebuddy-abc123] status=completed" }, { type: "text", text: "SECOND BLOCK" }]
      : [{ type: "text", text: output }];
    response.end(JSON.stringify({ jsonrpc: "2.0", id: mode === "wrongId" ? "unexpected" : rpc.id, result: { content, isError } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  process.env.AGENTHUB_URL = `http://127.0.0.1:${server.address().port}/mcp`;
  for (const root of roots) {
    const bridge = await import(new URL(root + "hub.mjs", import.meta.url));
    await t.test(root, async (t) => {
      await t.test("rejects inherited aliases", () => {
        for (const name of ["constructor", "__proto__", "toString"]) assert.equal(bridge.resolveWorker(name), null);
        assert.equal(bridge.resolveWorker(" CBCN "), "codebuddy-cn");
        assert.equal(bridge.resolveWorker(" CA "), "codearts");
        assert.equal(bridge.resolveWorker("huawei-codearts"), "codearts");
      });
      await t.test("CodeArts workers cannot recursively dispatch through any bridge copy", async () => {
        const previous = process.env.AGENTHUB_WORKER_ID;
        requests = [];
        try {
          process.env.AGENTHUB_WORKER_ID = 'codearts';
          for (const alias of ['codearts', 'ca', 'huawei-codearts']) {
            const reply = await bridge.ask(alias, 'This must never reach the Hub');
            assert.equal(reply.ok, false);
            assert.match(reply.answer, /RECURSIVE_DISPATCH_DENIED/);
            assert.equal((await bridge.dispatchOnly(alias, 'This must never reach the Hub')).ok, false);
          }
          assert.equal(requests.length, 0);
        } finally {
          if (previous === undefined) delete process.env.AGENTHUB_WORKER_ID;
          else process.env.AGENTHUB_WORKER_ID = previous;
        }
      });
      await t.test("does not repeat a completed task with empty text", async () => {
        mode = "empty"; requests = [];
        await bridge.ask("cb", "Perform one side effect");
        assert.equal(requests.filter((request) => request.name === "hub_dispatch_cli").length, 1);
      });
      await t.test("handles synchronous success and failure without a ref", async () => {
        mode = "sync";
        assert.equal((await bridge.ask("cb", "Reply DONE")).status, "completed");
        const sync = await bridge.dispatchOnly("cb", "Reply DONE");
        assert.equal(sync.ok, true);
        assert.equal(sync.status, "completed");
        assert.equal(sync.answer, "DONE");
        mode = "syncFailure";
        const failed = await bridge.ask("cb", "Fail");
        assert.equal(failed.status, "failed");
        assert.equal(failed.ref, "");
        assert.match(failed.answer, /exit=7/);
      });
      await t.test("handles HTTP, tool, RPC and malformed responses", async () => {
        for (const fixture of ["http", "tool", "rpcError", "wrongId", "invalidJson"]) {
          mode = fixture;
          const reply = await bridge.dispatchOnly("cb", "Reply DONE");
          assert.equal(reply.ok, false, fixture);
          assert.equal(reply.ref, "", fixture);
          assert.ok(reply.error, fixture);
        }
      });
      await t.test("recognizes worker errors and nonzero exit", async () => {
        mode = "workerError";
        const error = await bridge.fetchRef("codebuddy-abc123");
        assert.equal(error.status, "failed");
        assert.match(error.answer, /Authentication failed/);
        mode = "conflictingExit";
        assert.equal((await bridge.fetchRef("codebuddy-abc123")).status, "failed");
      });
      await t.test("uses receipt header and matching ref for status", async () => {
        mode = "bodyStatus";
        assert.equal((await bridge.fetchRef("codebuddy-abc123")).status, "running");
        mode = "wrongRef";
        assert.equal((await bridge.fetchRef("codebuddy-abc123")).status, "unknown");
        mode = "missing";
        const missing = await bridge.fetchRef("codebuddy-abc123");
        assert.equal(missing.status, "unknown");
        assert.match(missing.answer, /未找到/);
        const collected = await bridge.ask("cb", "Reply DONE");
        assert.equal(collected.status, "unknown");
        assert.equal(collected.ref, "codebuddy-abc123");
      });
      await t.test("preserves all text blocks and removes both metadata footers", async () => {
        mode = "multiText";
        assert.equal((await bridge.fetchRef("codebuddy-abc123")).answer, "SECOND BLOCK");
        mode = "completed";
        assert.equal((await bridge.fetchRef("codebuddy-abc123")).answer, "DONE");
      });
      await t.test("does not fall back after ZCode accepted the task", async () => {
        mode = "zcodeBody"; requests = [];
        assert.equal((await bridge.dispatchOnly("zcode", "Reply DONE")).ref, "zcode-abc123");
        assert.equal(requests.length, 1);
      });
      await t.test("passes the requested timeout through GUI dispatch and safe ZCode fallback", async () => {
        mode = "completed"; requests = [];
        await bridge.dispatchOnly("trae", "Reply DONE", 1);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].name, "trae_delegate");
        assert.equal(requests[0].arguments.timeout_s, 1);
        mode = "zcodeUnavailable"; requests = [];
        await bridge.dispatchOnly("zcode", "Reply DONE", 1);
        assert.deepEqual(requests.map((request) => request.name), ["hub_dispatch_cli", "zcode_delegate"]);
        assert.equal(requests[1].arguments.timeout_s, 1);
      });
      await t.test("invalid timeout is rejected before dispatch", async () => {
        mode = "completed"; requests = [];
        for (const timeout of [-1, 0, NaN, Infinity, "100", 86401]) {
          assert.equal((await bridge.ask("cb", "Reply DONE", timeout)).status, "failed");
          assert.equal((await bridge.dispatchOnly("cb", "Reply DONE", timeout)).ok, false);
        }
        assert.equal(requests.length, 0);
      });
      await t.test("collection network failure preserves an uncertain task and ref", async () => {
        mode = "waitNetwork"; requests = [];
        const result = await bridge.ask("cb", "Reply DONE");
        assert.equal(result.status, "unknown");
        assert.equal(result.ref, "codebuddy-abc123");
        assert.equal(requests.filter((request) => request.name === "hub_dispatch_cli").length, 1);
      });
      await t.test("wait timeout includes dispatch and preserves running ref", async () => {
        mode = "waitDelay"; requests = [];
        const start = performance.now();
        const result = await bridge.ask("cb", "Reply DONE", 0.08);
        assert.equal(result.status, "running");
        assert.equal(result.ref, "codebuddy-abc123");
        assert.ok(performance.now() - start < 300);
        assert.ok(requests.at(-1).arguments.wait_s <= 0.08);
        mode = "dispatchDelay";
        const dispatchStart = performance.now();
        const uncertain = await bridge.ask("cb", "Reply DONE", 0.08);
        assert.equal(uncertain.status, "unknown");
        assert.ok(performance.now() - dispatchStart < 300);
      });
    });
  }
});

test("stdio MCP validates requests and respects notifications", async (t) => {
  for (const root of roots) {
    await t.test(root, async (t) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL(root + "server.mjs", import.meta.url))], {
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      t.after(() => child.kill());
      const replies = [];
      const pending = new Map();
      createInterface({ input: child.stdout }).on("line", (line) => {
        const reply = JSON.parse(line);
        replies.push(reply);
        pending.get(reply.id)?.(reply);
        pending.delete(reply.id);
      });
      function send(message) { child.stdin.write(JSON.stringify(message) + "\n"); }
      function request(id, method, params) {
        return new Promise((resolve) => { pending.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }); });
      }
      send({ jsonrpc: "2.0", method: "ping" });
      send({ jsonrpc: "2.0", method: "tools/list" });
      send({ jsonrpc: "2.0", method: "tools/call", params: { name: "hub_dispatch", arguments: { worker: "cb", task: "must not dispatch" } } });
      const list = await request(1, "tools/list");
      assert.deepEqual(replies.map((reply) => reply.id), [1]);
      assert.ok(list.result.tools.some((tool) => tool.name === "hub_login"));
      const missing = await request(2, "tools/call", { name: "hub_dispatch", arguments: { worker: "cb" } });
      assert.equal(missing.error?.code, -32602);
      const stringTimeout = await request(3, "tools/call", { name: "hub_ask", arguments: { worker: "cb", task: "DONE", timeout_s: "1" } });
      assert.equal(stringTimeout.error?.code, -32602);
      const badArgs = await request(4, "tools/call", { name: "hub_status", arguments: [] });
      assert.equal(badArgs.error?.code, -32602);
      child.stdin.end();
      await new Promise((resolve) => child.once("close", resolve));
    });
  }
});
