// Acceptance tests for the MiniMax Code ACP bridge: the native `mcode exec` stream must reach the
// hub as observable tool and failure events, the reply must not be replayed, a cancel must stay a
// cancel, and the bridge's own heartbeat must never look like tool progress.
//
// The CLI is a fake written to a temp directory; the real `mcode` is never called.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { McodeTurnProjector } from "./mcode-acp.ts";

const BRIDGE = fileURLToPath(new URL("./mcode-acp.ts", import.meta.url));

/** The fake `mcode exec`: it writes the event lines its mode asks for, then ends the turn. */
const FAKE_CLI = `#!/usr/bin/env node
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const mode = process.env.FAKE_MCODE_MODE ?? "tools";
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const hang = () => setInterval(() => {}, 1000);
if (mode === "session-history") {
  const args = process.argv.slice(2);
  const path = require("node:path").join(process.cwd(), "fake-mcode-sessions.json");
  const sessions = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
  const index = args.indexOf("--session");
  const sessionId = index < 0 ? "mvs_" + randomUUID() : args[index + 1];
  if (args.includes("--continue") || (index >= 0 && !sessions[sessionId])) process.exit(1);
  const text = args.at(-1);
  const history = sessions[sessionId] ?? [];
  history.push(text);
  sessions[sessionId] = history;
  fs.writeFileSync(path, JSON.stringify(sessions));
  emit({ type: index < 0 ? "session.started" : "session.resumed", sessionId });
  const output = JSON.stringify({ sessionId, history });
  if (text === "cancel-first") {
    emit({ type: "item.started", item: { type: "agent_message", id: "m1", contentDelta: output } });
    hang();
  } else if (text === "fail-first") {
    emit({ type: "turn.failed", error: { message: "timeout" } });
  } else {
    emit({ type: "exec.completed", result: { status: "succeeded", output } });
  }
} else if (mode === "tools") {
  emit({ type: "item.started", item: { type: "agent_message", id: "m1", contentDelta: "Reading " } });
  emit({ type: "item.started", item: { type: "tool_call", id: "i1", toolCall: { id: "call-1", name: "Read", input: { path: "a.txt" } } } });
  emit({ type: "item.updated", item: { type: "tool_call", id: "i1", toolCall: { id: "call-1", name: "Read", status: "running", input: { path: "a.txt" } } } });
  emit({ type: "item.completed", item: { type: "tool_call", id: "i1", toolCall: { id: "call-1", name: "Read", status: "completed", output: "file body" } } });
  emit({ type: "item.updated", item: { type: "agent_message", id: "m1", contentDelta: "done" } });
  emit({ type: "item.completed", item: { type: "agent_message", id: "m1", content: "Reading done" } });
  emit({ type: "exec.completed", result: { status: "succeeded", output: "Reading done", usage: { inputTokens: 10, outputTokens: 5 } } });
} else if (mode === "failed-tool") {
  emit({ type: "item.started", item: { type: "tool_call", id: "i1", toolCall: { id: "call-1", name: "Bash", input: { command: "false" } } } });
  emit({ type: "item.completed", item: { type: "tool_call", id: "i1", toolCall: { id: "call-1", name: "Bash", status: "failed", error: { message: "exit status 1" } } } });
  emit({ type: "exec.completed", result: { status: "succeeded", output: "the tool failed" } });
} else if (mode === "turn-failed") {
  emit({ type: "item.started", item: { type: "agent_message", id: "m1", contentDelta: "working" } });
  emit({ type: "turn.failed", error: { message: "the model stream broke" } });
} else if (mode === "exec-failed") {
  emit({ type: "exec.failed", error: { message: "mcode exec crashed" } });
} else if (mode === "partial") {
  emit({ type: "item.started", item: { type: "agent_message", id: "m1", contentDelta: "I'll start by reading" } });
  hang();
} else {
  hang();
}
`;

interface Bridge {
  readonly dir: string;
  request(method: string, params: unknown): Promise<any>;
  notify(method: string, params: unknown): void;
  updates(): any[];
  stop(): Promise<void>;
}

const running: Bridge[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((bridge) => bridge.stop()));
});

function startBridge(env: Record<string, string> = {}): Bridge {
  const dir = mkdtempSync(join(tmpdir(), "omb-mcode-bridge-"));
  const cli = join(dir, "fake-mcode");
  writeFileSync(cli, FAKE_CLI, "utf8");
  chmodSync(cli, 0o755);
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [
    "--experimental-strip-types", BRIDGE, "--cli", cli, "--timeout", "30",
  ], {
    env: { ...process.env, HOME: dir, OMB_MCODE_HOME: dir, FAKE_MCODE_MODE: "tools", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const updates: any[] = [];
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let nextId = 1;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message?.method === "session/update") {
      updates.push(message.params?.update);
      return;
    }
    if (message?.id === undefined) return;
    const call = pending.get(Number(message.id));
    if (!call) return;
    pending.delete(Number(message.id));
    clearTimeout(call.timer);
    if (message.error) call.reject(new Error(`${message.error.code}: ${message.error.message}`));
    else call.resolve(message.result);
  });
  const write = (message: unknown): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const bridge: Bridge = {
    dir,
    request: (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`bridge did not answer ${method}`));
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
      write({ jsonrpc: "2.0", id, method, params });
    }),
    notify: (method, params) => write({ jsonrpc: "2.0", method, params }),
    updates: () => updates,
    stop: () => new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("close", () => {
        clearTimeout(timer);
        lines.close();
        rmSync(dir, { recursive: true, force: true });
        resolve();
      });
      child.kill("SIGTERM");
    }),
  };
  running.push(bridge);
  return bridge;
}

async function newSession(bridge: Bridge): Promise<string> {
  await bridge.request("initialize", { protocolVersion: 1 });
  const created = await bridge.request("session/new", { cwd: bridge.dir });
  return String(created.sessionId);
}

function prompt(bridge: Bridge, sessionId: string, text = "do the task"): Promise<any> {
  return bridge.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the bridge");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function collector(): { updates: any[]; projector: McodeTurnProjector } {
  const updates: any[] = [];
  return { updates, projector: new McodeTurnProjector((update) => updates.push(update)) };
}

function toolUpdates(bridge: Bridge): any[] {
  return bridge.updates().filter((update) => update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update");
}

describe("mcode turn projection", () => {
  it("keeps a tool call's start, update and result under one id", () => {
    const { updates, projector } = collector();
    projector.handle({ type: "item.started", item: { type: "tool_call", id: "i1", toolCall: { id: "call-1", name: "Read", input: { path: "a.txt" } } } });
    projector.handle({ type: "item.updated", item: { type: "tool_call", id: "i1", toolCall: { id: "call-1", name: "Read", status: "running" } } });
    projector.handle({ type: "item.completed", item: { type: "tool_call", id: "i1", toolCall: { id: "call-1", name: "Read", status: "completed", output: "file body" } } });

    expect(updates.map((update) => update.sessionUpdate)).toEqual(["tool_call", "tool_call_update", "tool_call_update"]);
    expect([...new Set(updates.map((update) => update.toolCallId))]).toEqual(["call-1"]);
    expect(updates.map((update) => update.status)).toEqual(["pending", "in_progress", "completed"]);
    expect(updates[0].kind).toBe("read");
    expect(updates[2].rawOutput).toBe("file body");
  });

  it("marks a failed tool call as failed under the same id", () => {
    const { updates, projector } = collector();
    projector.handle({ type: "item.started", item: { type: "tool_call", id: "i1", toolCall: { id: "call-1", name: "Bash", input: { command: "false" } } } });
    projector.handle({ type: "item.completed", item: { type: "tool_call", id: "i1", toolCall: { id: "call-1", name: "Bash", status: "failed", error: { message: "exit status 1" } } } });

    expect(updates.at(-1)?.status).toBe("failed");
    expect(updates.at(-1)?.toolCallId).toBe("call-1");
    expect(updates.at(-1)?.rawOutput).toEqual({ error: { message: "exit status 1" } });
  });

  it("does not replay text that was already streamed", () => {
    const { updates, projector } = collector();
    projector.handle({ type: "item.started", item: { type: "agent_message", id: "m1", contentDelta: "Hello " } });
    projector.handle({ type: "item.completed", item: { type: "agent_message", id: "m1", content: "Hello world" } });
    projector.handle({ type: "exec.completed", result: { status: "succeeded", output: "Hello world" } });

    expect(updates.filter((update) => update.sessionUpdate === "agent_message_chunk").map((update) => update.content.text)).toEqual(["Hello "]);
    expect(projector.text).toBe("Hello ");
  });

  it("takes the reply from exec.completed when no delta was streamed", () => {
    const { updates, projector } = collector();
    projector.handle({ type: "exec.completed", result: { status: "succeeded", output: "final answer" } });

    expect(projector.text).toBe("final answer");
    expect(updates).toHaveLength(1);
    expect(updates[0].sessionUpdate).toBe("agent_message_chunk");
  });

  it("records a failed turn and a failed exec as failures", () => {
    const turn = collector();
    turn.projector.handle({ type: "turn.failed", error: { message: "the model stream broke" } });
    expect(turn.projector.failed).toBe(true);
    expect(turn.projector.failureMessage).toBe("the model stream broke");

    const exec = collector();
    exec.projector.handle({ type: "exec.failed", error: { message: "mcode exec crashed" } });
    expect(exec.projector.failed).toBe(true);
    expect(exec.projector.failureMessage).toBe("mcode exec crashed");
  });

  it("recognises a sign-in failure in the turn's error", () => {
    const { projector } = collector();
    projector.handle({ type: "turn.failed", error: { message: "Please sign in to minimax" } });

    expect(projector.failed).toBe(true);
    expect(projector.authFailed).toBe(true);
  });
});

describe("mcode ACP bridge", () => {
  function lastHistory(bridge: Bridge): { sessionId: string; history: string[] } {
    const update = bridge.updates().findLast((entry) => entry?.sessionUpdate === "agent_message_chunk");
    return JSON.parse(update.content.text);
  }

  it("isolates native sessions by ACP session even when tasks share a cwd", async () => {
    const bridge = startBridge({ FAKE_MCODE_MODE: "session-history" });
    const first = await newSession(bridge);
    const second = await newSession(bridge);
    await prompt(bridge, first, "R6-A2");
    const firstNative = lastHistory(bridge).sessionId;
    await prompt(bridge, second, "R6-B");
    const secondNative = lastHistory(bridge).sessionId;
    expect(secondNative).not.toBe(firstNative);
    expect(lastHistory(bridge).history).toEqual(["R6-B"]);

    await prompt(bridge, first, "check A2");
    expect(lastHistory(bridge)).toEqual({ sessionId: firstNative, history: ["R6-A2", "check A2"] });
    await prompt(bridge, second, "check B");
    expect(lastHistory(bridge)).toEqual({ sessionId: secondNative, history: ["R6-B", "check B"] });
  });

  it("resumes the failed task's native session rather than a previous task", async () => {
    const bridge = startBridge({ FAKE_MCODE_MODE: "session-history" });
    const oldTask = await newSession(bridge);
    await prompt(bridge, oldTask, "R6-A2");
    const oldNative = lastHistory(bridge).sessionId;
    const task = await newSession(bridge);
    await prompt(bridge, task, "R6-B");
    const native = lastHistory(bridge).sessionId;
    await expect(prompt(bridge, task, "fail-first")).rejects.toThrow(/failed to answer/);
    await prompt(bridge, task, "Continue the request above");

    expect(native).not.toBe(oldNative);
    expect(lastHistory(bridge)).toEqual({ sessionId: native, history: ["R6-B", "fail-first", "Continue the request above"] });
  });

  it("keeps the native session announced by a failed first prompt", async () => {
    const bridge = startBridge({ FAKE_MCODE_MODE: "session-history" });
    const task = await newSession(bridge);
    await expect(prompt(bridge, task, "fail-first")).rejects.toThrow(/failed to answer/);
    await prompt(bridge, task, "retry");

    expect(lastHistory(bridge).history).toEqual(["fail-first", "retry"]);
  });

  it("retains only the cancelled session's history on the next prompt", async () => {
    const bridge = startBridge({ FAKE_MCODE_MODE: "session-history" });
    const task = await newSession(bridge);
    const pending = prompt(bridge, task, "cancel-first");
    await waitFor(() => bridge.updates().some((entry) => entry?.sessionUpdate === "agent_message_chunk"));
    const native = lastHistory(bridge).sessionId;
    bridge.notify("session/cancel", { sessionId: task });
    await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
    await prompt(bridge, task, "resume cancelled task");

    expect(lastHistory(bridge)).toEqual({ sessionId: native, history: ["cancel-first", "resume cancelled task"] });
  });

  it("starts clean in another bridge with existing native history in the same cwd", async () => {
    const oldBridge = startBridge({ FAKE_MCODE_MODE: "session-history" });
    const oldTask = await newSession(oldBridge);
    await prompt(oldBridge, oldTask, "R6-A2");
    const bridge = startBridge({ FAKE_MCODE_MODE: "session-history" });
    await bridge.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await bridge.request("session/new", { cwd: oldBridge.dir });
    await prompt(bridge, sessionId, "R6-B");

    expect(lastHistory(bridge).sessionId).not.toBe(lastHistory(oldBridge).sessionId);
    expect(lastHistory(bridge).history).toEqual(["R6-B"]);
    await expect(bridge.request("session/load", { sessionId: oldTask })).rejects.toThrow(/not supported/);
  });

  it("forwards the tool lifecycle to the hub under one tool id", async () => {
    const bridge = startBridge({ FAKE_MCODE_MODE: "tools" });
    const sessionId = await newSession(bridge);
    const result = await prompt(bridge, sessionId);

    expect(result.stopReason).toBe("end_turn");
    const tools = toolUpdates(bridge);
    expect(tools.length).toBeGreaterThanOrEqual(3);
    expect([...new Set(tools.map((update) => update.toolCallId))]).toEqual(["call-1"]);
    expect(tools.map((update) => update.status)).toEqual(["pending", "in_progress", "completed"]);
    expect(tools.at(-1)?.rawOutput).toBe("file body");
  });

  it("forwards a failed tool call to the hub", async () => {
    const bridge = startBridge({ FAKE_MCODE_MODE: "failed-tool" });
    const sessionId = await newSession(bridge);
    await prompt(bridge, sessionId);

    const tools = toolUpdates(bridge);
    expect(tools.at(-1)?.status).toBe("failed");
    expect(tools.at(-1)?.toolCallId).toBe("call-1");
    expect(tools.at(-1)?.rawOutput).toEqual({ error: { message: "exit status 1" } });
  });

  it("does not replay the reply after it was already streamed", async () => {
    const bridge = startBridge({ FAKE_MCODE_MODE: "tools" });
    const sessionId = await newSession(bridge);
    await prompt(bridge, sessionId);

    const texts = bridge.updates()
      .filter((update) => update?.sessionUpdate === "agent_message_chunk")
      .map((update) => update.content.text);
    expect(texts).toEqual(["Reading ", "done"]);
    expect(texts.join("")).toBe("Reading done");
  });

  it("answers a cancelled turn with the cancelled stop reason", async () => {
    const bridge = startBridge({ FAKE_MCODE_MODE: "partial" });
    const sessionId = await newSession(bridge);
    const pending = prompt(bridge, sessionId);
    await waitFor(() => bridge.updates().some((update) => update?.sessionUpdate === "agent_message_chunk"));

    bridge.notify("session/cancel", { sessionId });
    await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
    expect(bridge.updates().some((update) => update?.sessionUpdate === "agent_message_chunk")).toBe(true);
  });

  it("keeps the bridge heartbeat out of the tool events", async () => {
    const bridge = startBridge({ FAKE_MCODE_MODE: "idle", OMB_MCODE_HEARTBEAT_MS: "50" });
    const sessionId = await newSession(bridge);
    const pending = prompt(bridge, sessionId);
    await waitFor(() => bridge.updates().some((update) => update?.sessionUpdate === "mcode_bridge_heartbeat"));

    expect(toolUpdates(bridge)).toHaveLength(0);
    expect(bridge.updates().filter((update) => update?.toolCallId !== undefined)).toHaveLength(0);
    expect(bridge.updates().filter((update) => update?.sessionUpdate === "agent_message_chunk")).toHaveLength(0);

    bridge.notify("session/cancel", { sessionId });
    await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
  });

  it("fails the turn when the native turn reports turn.failed", async () => {
    const bridge = startBridge({ FAKE_MCODE_MODE: "turn-failed" });
    const sessionId = await newSession(bridge);

    await expect(prompt(bridge, sessionId)).rejects.toThrow(/failed to answer/);
  });

  it("fails the turn when the native exec reports exec.failed", async () => {
    const bridge = startBridge({ FAKE_MCODE_MODE: "exec-failed" });
    const sessionId = await newSession(bridge);

    await expect(prompt(bridge, sessionId)).rejects.toThrow(/failed to answer/);
  });
});
