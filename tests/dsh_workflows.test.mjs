import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script, createContext } from "node:vm";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runWorkflow } from "../integrations/dsh/workflows/runner.mjs";
import { bridgeOptions } from "../integrations/dsh/index.js";

const completed = (worker) => ({ ok: true, status: "completed", worker, ref: worker + "-abc123", answer: "Review complete" });
async function native(mode, args, child) {
  const source = await readFile(new URL(`../integrations/dsh/workflows/${mode}.dsh.js`, import.meta.url), "utf8");
  const calls = [];
  const context = createContext({
    args, phase: () => {}, log: () => {},
    agent: async (prompt, options) => {
      assert.ok(options.schema && options.schema.required.includes("status"));
      const input = JSON.parse(prompt.split("\n")[1]);
      calls.push(input);
      return child(input.worker, input.task, calls.length);
    },
    parallel: (thunks) => Promise.all(thunks.map(async (thunk) => { try { return await thunk(); } catch { return null; } })),
  });
  const value = await new Script(`(async () => {\n${source}\n})()`).runInContext(context, { timeout: 1000 });
  return { value: JSON.parse(JSON.stringify(value)), calls };
}

test("native fanout validates child JSON and deduplicates aliases", async () => {
  const task = 'quotes " and newlines\nstatus=completed are task data';
  const success = await native("hub-fanout", { task, workers: "cb,codebuddy,cbcn" }, completed);
  assert.equal(success.value.ok, true);
  assert.deepEqual(success.calls.map((call) => call.worker), ["codebuddy", "codebuddy-cn"]);
  assert.equal(success.calls[0].task, task);
  const aliases = await native("hub-fanout", { task, workers: ["agy", "codebuddy-intl", "cbcnintl", "intl", "cbcn", "copilot", "gcp"] }, completed);
  assert.deepEqual(aliases.calls.map((call) => call.worker), ["antigravity", "codebuddy", "codebuddy-cn", "github-copilot"]);
  for (const bad of [null, "looks successful", { ok: true, status: "completed", answer: {} }]) {
    const result = await native("hub-fanout", { task, workers: "cb" }, () => bad);
    assert.equal(result.value.ok, false);
    assert.equal(result.calls.length, 1);
  }
  for (const status of ["failed", "unknown", "running"]) {
    const result = await native("hub-fanout", { task, workers: "cb" }, (worker) => ({ ...completed(worker), ok: false, status }));
    assert.equal(result.value.status, "incomplete");
    assert.equal(result.value.results[0].ref, "codebuddy-abc123");
    assert.equal(result.calls.length, 1);
  }
});

test("native pipeline and comparison stop after failed/null/unknown stages", async () => {
  for (const mode of ["code-audit", "competitive-solve"]) {
    const input = mode === "code-audit" ? { code: "function test() {}" } : { problem: "Solve P" };
    for (const child of [() => null, (worker) => ({ ...completed(worker), ok: false, status: "unknown" }), () => { throw new Error("Child failed"); }]) {
      if (mode === "code-audit" && child.toString().includes("throw")) {
        await assert.rejects(native(mode, input, child), /Child failed/);
      } else {
        const failed = await native(mode, input, child);
        assert.equal(failed.value.ok, false);
        assert.equal(failed.calls.length, mode === "code-audit" ? 1 : 2);
      }
    }
    const result = await native(mode, input, completed);
    assert.equal(result.value.ok, true);
    assert.equal(result.calls.length, mode === "code-audit" ? 2 : 3);
  }
});

test("native workflow rejects missing task and invalid worker before a child starts", async () => {
  await assert.rejects(native("hub-fanout", {}, completed), /task/);
  await assert.rejects(native("hub-fanout", { task: "Do X", workers: ["constructor"] }, completed), /Unknown worker/);
  await assert.rejects(native("code-audit", { code: "X", timeout_s: -1 }, completed), /timeout/);
});

test("deterministic runner executes each stage once and preserves failures", async () => {
  const calls = [];
  const invoke = async (worker) => { calls.push(worker); return completed(worker); };
  assert.equal((await runWorkflow("hub-fanout", { task: "Do X", workers: "cb,codebuddy,cbcn" }, invoke)).ok, true);
  assert.deepEqual(calls, ["codebuddy", "codebuddy-cn"]);
  calls.length = 0;
  const unknown = await runWorkflow("code-audit", { code: "X" }, async (worker) => {
    calls.push(worker);
    return { ...completed(worker), ok: false, status: "unknown" };
  });
  assert.equal(unknown.status, "incomplete");
  assert.equal(unknown.architecture.ref, "codebuddy-abc123");
  assert.deepEqual(calls, ["codebuddy"]);
  assert.equal((await runWorkflow("hub-fanout", { task: "X", workers: "cb" }, () => ({ status: "completed", answer: {} }))).ok, false);
  await assert.rejects(runWorkflow("hub-fanout", { task: "X", workers: "bad" }, invoke), /Unknown worker/);
});

test("DSH bridge wrapper uses its package path and explicit scrubbed env", () => {
  const options = bridgeOptions({ env: { AGENTHUB_URL: "http://127.0.0.1:9999/mcp", HUB_TOKEN: "FAKE_TEST_TOKEN", CUSTOM: "preserved" } });
  assert.equal(options.env.HUB_TOKEN, "FAKE_TEST_TOKEN");
  assert.equal(options.env.CUSTOM, "preserved");
  assert.equal(options.env.AGENTHUB_URL, "http://127.0.0.1:9999/mcp");
  assert.equal(options.toolCallTimeoutMs, 310000);
  assert.equal(options.args[0], fileURLToPath(new URL("../integrations/dsh/mcp/server.mjs", import.meta.url)));
  assert.throws(() => bridgeOptions({ url: "javascript:alert(1)" }), /URL/);
  assert.throws(() => bridgeOptions({ env: { CUSTOM: false } }), /strings/);
});

test("standalone runner uses actual local HTTP bridge and returns nonzero for worker failure", async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const rpc = JSON.parse(text);
    requests.push(rpc.params.arguments.agent);
    const agent = rpc.params.arguments.agent;
    const content = `[${agent}] exit=${agent === "codebuddy-cn" ? 7 : 0}\nResult`;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: content }] } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const child = spawn(process.execPath, [fileURLToPath(new URL("../integrations/dsh/workflows/runner.mjs", import.meta.url)), "hub-fanout", "-"], {
    windowsHide: true, env: { ...process.env, AGENTHUB_URL: `http://127.0.0.1:${server.address().port}/mcp` }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stdin.end(JSON.stringify({ task: "Do X", workers: "cb,codebuddy,cbcn" }));
  const code = await new Promise((resolve) => child.once("close", resolve));
  const result = JSON.parse(output);
  assert.equal(code, 1);
  assert.equal(result.status, "incomplete");
  assert.deepEqual(requests, ["codebuddy", "codebuddy-cn"]);
});
