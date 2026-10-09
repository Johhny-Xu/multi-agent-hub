import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

test("login bridge forwards only worker/action and excludes credential fields", async (t) => {
  const requests = [];
  let fixtureMode = "normal";
  let zcodeConfigured = false;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    requests.push(rpc.params);
    response.setHeader("Content-Type", "application/json");
    if (fixtureMode === "httpError") {
      response.writeHead(503);
      response.end(JSON.stringify({ error: { message: "Service unavailable" } }));
      return;
    }
    if (fixtureMode === "toolError") {
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { isError: true, content: [{ type: "text", text: "Worker denied request" }] } }));
      return;
    }
    if (fixtureMode === "manualRequired") {
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, status: "manual_required", instructions: "Run the official login command on the worker host." }) }] } }));
      return;
    }
    if (rpc.params.name === "hub_result") {
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "[codebuddy/codebuddy-abc123] status=error\nOfficial authentication failed" }] } }));
      return;
    }
    if (rpc.params.name === "hub_dispatch_cli" || rpc.params.name === "zcode_delegate") {
      const text = rpc.params.name === "zcode_delegate" ? "[zcode/zcode-abc123] status=running" : zcodeConfigured ? "[zcode/zcode-def456] status=running" : "zcode 未配置 CLI (agents.json 中 cli 为 null)。";
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text }] } }));
      return;
    }
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify({
      ok: true, status: rpc.params.arguments.action === "cancel" ? "cancelled" : "awaiting_user",
      login_url: "https://www.codebuddy.ai/login?platform=CLI&state=example-public-state",
      user_code: "ABCD-EFGH", expires_at: "2026-10-08T08:00:00Z",
      instructions: "Complete authorization in the browser. token=TEST_SECRET",
      token: "TEST_SECRET", account: { token: "TEST_SECRET" }, userinfo: { token: "TEST_SECRET" },
    }) }] } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  process.env.AGENTHUB_URL = endpoint;
  const { hubLogin, publicLoginResult, dispatchOnly, fetchRef } = await import("../mcp/hub.mjs");

  const result = await hubLogin("cb", "start");
  assert.equal(result.worker, "codebuddy");
  assert.equal(result.status, "awaiting_user");
  assert.equal(result.login_url, "https://www.codebuddy.ai/login?platform=CLI&state=example-public-state");
  assert.equal(result.user_code, "ABCD-EFGH");
  assert.equal(JSON.stringify(result).includes("TEST_SECRET"), false);
  assert.deepEqual(requests[0], { name: "hub_login", arguments: { agent: "codebuddy", action: "start" } });
  assert.equal((await hubLogin("cbcn", "cancel")).status, "cancelled");
  assert.deepEqual(requests[1].arguments, { agent: "codebuddy-cn", action: "cancel" });
  const count = requests.length;
  assert.equal((await hubLogin("unknown", "start")).ok, false);
  assert.equal((await hubLogin("cb", "execute")).ok, false);
  assert.equal(requests.length, count);

  for (const login_url of ["javascript:alert(1)", "http://www.codebuddy.ai/login", "https://username:password@www.codebuddy.ai/login", "https://www.codebuddy.ai/login?access_token=TEST_SECRET", "https://www.codebuddy.ai/login#access_token=TEST_SECRET"]) {
    const rejected = publicLoginResult({ ok: true, status: "awaiting_user", login_url }, "codebuddy", "start");
    assert.equal(rejected.ok, false);
    assert.equal(rejected.login_url, undefined);
  }

  const child = spawn(process.execPath, [fileURLToPath(new URL("../mcp/server.mjs", import.meta.url))], {
    env: { ...process.env, AGENTHUB_URL: endpoint }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const timeout = setTimeout(() => child.kill(), 15000);
  t.after(() => { clearTimeout(timeout); child.kill(); });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  function rpc(id, method, params) {
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  const list = await rpc(1, "tools/list");
  const schema = list.result.tools.find((tool) => tool.name === "hub_login").inputSchema;
  assert.deepEqual(schema.required, ["worker"]);
  assert.deepEqual(schema.properties.action.enum, ["start", "status", "cancel"]);
  assert.equal(schema.additionalProperties, false);
  const beforeInvalid = requests.length;
  const invalid = await rpc(2, "tools/call", { name: "hub_login", arguments: { worker: "cbcn", command: "ignored", url: "https://example.invalid" } });
  assert.equal(invalid.error.code, -32602);
  assert.equal(requests.length, beforeInvalid);
  const call = await rpc(3, "tools/call", { name: "hub_login", arguments: { worker: "cbcn" } });
  const publicResult = JSON.parse(call.result.content[0].text);
  assert.equal(publicResult.worker, "codebuddy-cn");
  assert.equal(publicResult.action, "status");
  assert.equal(JSON.stringify(publicResult).includes("TEST_SECRET"), false);
  assert.deepEqual(requests.at(-1), { name: "hub_login", arguments: { agent: "codebuddy-cn", action: "status" } });
  child.stdin.end();
  await new Promise((resolve) => child.once("close", resolve));

  fixtureMode = "httpError";
  assert.match((await dispatchOnly("cb", "Reply OK")).error, /HTTP 503/);
  fixtureMode = "toolError";
  assert.match((await dispatchOnly("cb", "Reply OK")).error, /TOOL-ERROR/);
  fixtureMode = "manualRequired";
  assert.equal((await hubLogin("mmx", "start")).status, "manual_required");
  fixtureMode = "normal";
  const beforeFallback = requests.length;
  assert.equal((await dispatchOnly("zcode", "Reply OK")).ref, "zcode-abc123");
  assert.deepEqual(requests.slice(beforeFallback).map((request) => request.name), ["hub_dispatch_cli", "zcode_delegate"]);
  assert.deepEqual(requests.at(-1).arguments, { task: "Reply OK", wait: false, timeout_s: 900 });
  zcodeConfigured = true;
  const beforeCLI = requests.length;
  assert.equal((await dispatchOnly("zcode", "Reply OK")).ref, "zcode-def456");
  assert.equal(requests.length, beforeCLI + 1);
  const errorResult = await fetchRef("codebuddy-abc123");
  assert.equal(errorResult.status, "failed");
  assert.match(errorResult.answer, /Official authentication failed/);
});
