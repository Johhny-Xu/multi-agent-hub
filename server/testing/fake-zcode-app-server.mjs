#!/usr/bin/env node
// Fake `zcode app-server` stdio surface for the bridge test: session/create, subscribe, send,
// events, stop and close. Every call is written to FAKE_ZCODE_STATE_FILE so a test can prove which
// session a prompt used. Modes (FAKE_ZCODE_MODE):
//   steady (default)  a turn that keeps producing tool and thinking events for longer than --timeout
//   text              streamed assistant text that equals the terminal response
//   silent            accept the prompt and never emit anything
//   stale             reject the first send as a dropped deferred session
//   busy              reject the first send because an earlier prompt is still active, then
//                     finish that earlier prompt (its own inputId) with "OK adopted"
//   timeout-then-ok   go silent for the first prompt, answer every later one
//   account           after the first send, ask for provider runtime headers: the bridge must
//                     grant account:bigmodel-start-plan with FAKE_ZCODE_EXPECTED_API_KEY and refuse
//                     every other provider; then the turn completes
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_ZCODE_MODE ?? "steady";
const stateFile = process.env.FAKE_ZCODE_STATE_FILE;
const tickMs = Number(process.env.FAKE_ZCODE_TICK_MS ?? 250);
const state = stateFile ? JSON.parse(readFileSync(stateFile, "utf8")) : { creates: [], sends: [], methods: [], stops: 0 };
const save = () => { if (stateFile) writeFileSync(stateFile, JSON.stringify(state)); };
save();

let probes = 0;
let sessions = 0;
let seq = 0;
let prompts = 0;
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const fail = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
const event = (sessionId, type, payload) => {
  seq += 1;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/event", params: { sessionId, seq, type, payload } })}\n`);
};
const complete = (sessionId, response) => event(sessionId, "turn.completed", {
  resultType: "success", response, tokenCount: 4, toolCallCount: 0, duration: 10,
  usage: { inputTokens: 2, outputTokens: 2 },
});

function steadyTurn(sessionId) {
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    if (tick === 1) event(sessionId, "turn.started", { turnNumber: 1, input: "task" });
    if (tick === 2) event(sessionId, "tool.updated", { kind: "scheduled", toolCallId: "call-1", toolName: "Bash", input: { command: "sleep 10" } });
    if (tick === 3) event(sessionId, "tool.updated", { kind: "started", toolCallId: "call-1", toolName: "Bash" });
    if (tick === 4) event(sessionId, "part.delta", { messageId: "m1", partId: "p1", field: "reasoning", delta: "thinking about the task" });
    if (tick === 5) event(sessionId, "tool.updated", { kind: "progress", toolCallId: "call-1", toolName: "Bash", elapsedMs: 1_000 });
    if (tick === 6) event(sessionId, "tool.updated", { kind: "result", toolCallId: "call-1", toolName: "Bash", result: { status: "completed", output: "ok" }, duration: 1 });
    if (tick >= 8) {
      clearInterval(timer);
      complete(sessionId, "OK long done");
    }
  }, tickMs);
}

function answerPrompt(sessionId) {
  prompts += 1;
  const first = prompts === 1;
  if (mode === "silent") return;
  if (mode === "account") {
    void accountTurn(sessionId);
    return;
  }
  if (mode === "timeout-then-ok") {
    if (first) return;
    setTimeout(() => complete(sessionId, "OK after timeout"), 10);
    return;
  }
  if (mode === "stale") {
    setTimeout(() => complete(sessionId, "OK after retry"), 10);
    return;
  }
  if (mode === "text") {
    setTimeout(() => {
      event(sessionId, "part.started", { part: { partId: "p2", sessionId, messageId: "m2", type: "text", text: "" } });
      event(sessionId, "part.delta", { messageId: "m2", partId: "p2", field: "text", delta: "OK" });
      event(sessionId, "part.delta", { messageId: "m2", partId: "p2", field: "text", delta: " done" });
      complete(sessionId, "OK done");
    }, 10);
    return;
  }
  steadyTurn(sessionId);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

// Answers the bridge sends to this fake's own interaction requests.
const asked = new Map();
const ask = (method, params, timeoutMs = 5000) => new Promise((resolveRequest) => {
  const id = `hdr-${asked.size + 1}`;
  const timer = setTimeout(() => {
    asked.delete(id);
    resolveRequest({ timeout: true });
  }, timeoutMs);
  asked.set(id, (message) => {
    clearTimeout(timer);
    asked.delete(id);
    resolveRequest(message);
  });
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
const recordHeader = (askedProvider, granted, keyOk) => {
  state.headerRequests ??= [];
  state.headerRequests.push({ askedProvider, granted, keyOk });
  save();
};

async function accountTurn(sessionId) {
  const expected = process.env.FAKE_ZCODE_EXPECTED_API_KEY ?? "";
  const grant = await ask("interaction/requestProviderRuntimeHeaders", {
    requestId: `${sessionId}:provider-runtime-headers:test-1`,
    sessionId,
    providerId: "account:bigmodel-start-plan",
    modelSelection: { providerId: "account:bigmodel-start-plan", modelId: "GLM-5.3-Flash" },
    accountAccess: { type: "zhipu-account", accountType: "bigmodel", mode: "start-plan", entitled: true },
  });
  const granted = grant?.result?.headersApplied === true;
  const keyOk = granted && grant.result.requestAuth?.apiKey === expected;
  recordHeader("account:bigmodel-start-plan", granted, keyOk);
  const wrongProvider = await ask("interaction/requestProviderRuntimeHeaders", {
    requestId: `${sessionId}:provider-runtime-headers:test-2`,
    sessionId,
    providerId: "builtin:bigmodel",
    modelSelection: { providerId: "builtin:bigmodel", modelId: "GLM-5.3-Flash" },
    accountAccess: { type: "zhipu-account", accountType: "bigmodel", mode: "start-plan", entitled: true },
  });
  recordHeader("builtin:bigmodel", wrongProvider?.result?.headersApplied === true, false);
  const wrongMode = await ask("interaction/requestProviderRuntimeHeaders", {
    requestId: `${sessionId}:provider-runtime-headers:test-3`,
    sessionId,
    providerId: "account:bigmodel-start-plan",
    modelSelection: { providerId: "account:bigmodel-start-plan", modelId: "GLM-5.3-Flash" },
    accountAccess: { type: "zhipu-account", accountType: "bigmodel", mode: "individual-coding-plan", entitled: true },
  });
  recordHeader("account:bigmodel-start-plan:individual-coding-plan", wrongMode?.result?.headersApplied === true, false);
  setTimeout(() => complete(sessionId, "OK account"), 10);
}

lines.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try { message = JSON.parse(trimmed); } catch { return; }
  if (message.method === undefined && asked.has(String(message.id))) {
    asked.get(String(message.id))(message);
    return;
  }
  const id = message.id;
  const params = message.params ?? {};
  if (typeof message.method !== "string") return;
  state.methods.push(message.method);
  switch (message.method) {
    case "provider/updateAccountConfig": {
      state.accountPushes ??= [];
      state.accountPushes.push(params);
      save();
      reply(id, { receivedRevision: params.revision, providerCount: Object.keys(params.providers ?? {}).length, status: "received" });
      break;
    }
    case "session/create": {
      const workspaceKey = String(params.workspace?.workspaceKey ?? "");
      if (workspaceKey.startsWith("omb-catalog-")) {
        probes += 1;
        reply(id, {
          session: { sessionId: `probe-${probes}` },
          settings: {
            model: {
              available: [{
                ref: { providerId: "plan", modelId: "GLM-5.3-Flash" },
                label: "GLM-5.3-Flash",
                reasoning: { levels: [{ value: "max" }, { value: "high" }], defaultLevel: "max" },
              }],
              current: { providerId: "plan", modelId: "GLM-5.3-Flash" },
            },
          },
        });
        break;
      }
      sessions += 1;
      const sessionId = `sess-${sessions}`;
      state.creates.push(sessionId);
      save();
      reply(id, { session: { sessionId } });
      break;
    }
    case "session/subscribe":
      reply(id, { eventSeq: seq, events: [] });
      break;
    case "session/send": {
      const sessionId = String(params.sessionId ?? "");
      state.sends.push(sessionId);
      save();
      if (mode === "busy" && state.sends.length === 1) {
        fail(id, -32010, "A prompt is already running for this session");
        setTimeout(() => event(sessionId, "turn.completed", {
          inputId: "earlier-input", resultType: "success", response: "OK adopted", tokenCount: 4, toolCallCount: 0, duration: 10,
          usage: { inputTokens: 2, outputTokens: 2 },
        }), 30);
        break;
      }
      if (mode === "stale" && state.sends.length === 1) {
        fail(id, -32000, `session is not resident: ${sessionId} (proto.sessionNotResident)`);
        break;
      }
      reply(id, { accepted: true });
      answerPrompt(sessionId);
      break;
    }
    case "session/events":
      reply(id, { events: [] });
      break;
    case "session/stop":
      state.stops += 1;
      save();
      reply(id, {});
      break;
    case "session/close":
      reply(id, {});
      break;
    default:
      reply(id, {});
  }
});
lines.on("close", () => process.exit(0));

const spawner = process.ppid;
setInterval(() => { if (process.ppid !== spawner) process.exit(0); }, 200).unref();
