import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { isActivePromptError, isStaleZcodeSessionError } from "./zcode-acp.ts";

const BRIDGE = fileURLToPath(new URL("./zcode-acp.ts", import.meta.url));
const FAKE = fileURLToPath(new URL("../testing/fake-zcode-app-server.mjs", import.meta.url));
const ACCOUNT_SECRET = "omb-test-credential-secret";
const ACCOUNT_JWT = "test-jwt-token";

function seal(value: string): string {
  const key = createHash("sha256").update(ACCOUNT_SECRET).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

interface Bridge {
  readonly dir: string;
  request(method: string, params: unknown): Promise<any>;
  updates(): any[];
  state(): any;
  stop(): Promise<void>;
}

const running: Bridge[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((bridge) => bridge.stop()));
});

function startBridge(
  mode: string,
  timeoutSec: number,
  tickMs?: number,
  setup?: (dir: string) => Record<string, string>,
): Bridge {
  const dir = mkdtempSync(join(tmpdir(), "omb-zcode-bridge-"));
  const stateFile = join(dir, "state.json");
  writeFileSync(stateFile, JSON.stringify({ creates: [], sends: [], methods: [], stops: 0 }));
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [
    "--experimental-strip-types", BRIDGE, "--cli", FAKE, "--mode", "yolo", "--timeout", String(timeoutSec),
  ], {
    env: {
      ...process.env,
      HOME: dir,
      OMB_ZCODE_HOME: dir,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(dir, "providers.json"),
      FAKE_ZCODE_MODE: mode,
      FAKE_ZCODE_STATE_FILE: stateFile,
      ...(tickMs === undefined ? {} : { FAKE_ZCODE_TICK_MS: String(tickMs) }),
      ...setup?.(dir),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const updates: any[] = [];
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let nextId = 1;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message?.method === "session/update") {
      updates.push(message.params);
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
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`bridge did not answer ${method}`));
    }, 10_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const bridge: Bridge = {
    dir,
    request,
    updates: () => updates,
    state: () => JSON.parse(readFileSync(stateFile, "utf8")),
    stop: () => new Promise<void>((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
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

/** A bridge whose app server will see a logged-in account: a credential store in a temp data
 * directory plus a builtin config whose revision the entitlement push can be based on. */
function startAccountBridge(mode: string, withLogin = true): Bridge {
  return startBridge(mode, 5, undefined, (dir) => {
    mkdirSync(join(dir, ".zcode", "v2"), { recursive: true });
    if (withLogin) {
      writeFileSync(join(dir, ".zcode", "v2", "credentials.json"), JSON.stringify({
        zcodejwttoken: seal(ACCOUNT_JWT),
        "oauth:bigmodel:access_token": seal("test-access-token"),
      }), { mode: 0o600 });
    }
    const builtin = join(dir, "zcode-builtin.json");
    writeFileSync(builtin, JSON.stringify({ schemaVersion: 1, revision: "30", config: {} }));
    return {
      ZCODE_DATA_BASE_DIR: dir,
      ZCODE_CREDENTIAL_SECRET: ACCOUNT_SECRET,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
      FAKE_ZCODE_EXPECTED_API_KEY: ACCOUNT_JWT,
    };
  });
}

async function newSession(bridge: Bridge): Promise<string> {
  await bridge.request("initialize", { protocolVersion: 1, clientInfo: { name: "test", version: "0" } });
  const created = await bridge.request("session/new", { cwd: bridge.dir, mcpServers: [] });
  expect(created.sessionId).toMatch(/^zcode-/);
  expect(created.models.availableModels.map((model: any) => model.modelId)).toContain("GLM-5.3-Flash");
  return created.sessionId;
}

const prompt = (bridge: Bridge, sessionId: string, text: string) =>
  bridge.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });

const chunkText = (updates: any[]): string => updates
  .filter((entry) => entry.update?.sessionUpdate === "agent_message_chunk")
  .map((entry) => entry.update.content?.text ?? "")
  .join("");

describe("zcode ACP bridge", () => {
  it("keeps a turn alive while the app server still produces events, past the idle timeout", async () => {
    const bridge = startBridge("steady", 1);
    const sessionId = await newSession(bridge);
    const result = await prompt(bridge, sessionId, "long task");
    expect(result.stopReason).toBe("end_turn");

    const kinds = bridge.updates().map((entry) => entry.update?.sessionUpdate);
    expect(kinds).toContain("agent_thought_chunk");
    const tool = bridge.updates().find((entry) => entry.update?.sessionUpdate === "tool_call");
    expect(tool?.update.toolCallId).toBe("call-1");
    expect(bridge.updates().some((entry) => entry.update?.sessionUpdate === "tool_call_update"
      && entry.update.toolCallId === "call-1" && entry.update.status === "completed")).toBe(true);
    expect(chunkText(bridge.updates())).toBe("OK long done");
  });

  it("streams assistant text once, without replaying it at the end", async () => {
    const bridge = startBridge("text", 5);
    const sessionId = await newSession(bridge);
    const result = await prompt(bridge, sessionId, "say OK");
    expect(result.stopReason).toBe("end_turn");
    expect(chunkText(bridge.updates())).toBe("OK done");
    expect(bridge.updates().filter((entry) => entry.update?.sessionUpdate === "agent_message_chunk")).toHaveLength(2);
  });

  it("times out a silent turn, stops it, and opens a new native session for the retry", async () => {
    const bridge = startBridge("timeout-then-ok", 1);
    const sessionId = await newSession(bridge);
    await expect(prompt(bridge, sessionId, "stuck task")).rejects.toThrow(/TURN_TIMEOUT/);
    const retry = await prompt(bridge, sessionId, "stuck task");
    expect(retry.stopReason).toBe("end_turn");
    expect(chunkText(bridge.updates())).toBe("OK after timeout");
    const state = bridge.state();
    expect(state.stops).toBeGreaterThan(0);
    expect(state.creates).toHaveLength(2);
  });

  it("E18. follows the earlier prompt still running instead of failing when the send is refused as busy", async () => {
    const bridge = startBridge("busy", 5);
    const sessionId = await newSession(bridge);
    const result = await prompt(bridge, sessionId, "retry of the same request");
    expect(result.stopReason).toBe("end_turn");
    expect(chunkText(bridge.updates())).toBe("OK adopted");
    const state = bridge.state();
    expect(state.sends).toHaveLength(1);
    expect(state.creates).toHaveLength(1);
  });

  it("replaces a session the app server dropped instead of reusing it", async () => {
    const bridge = startBridge("stale", 5);
    const sessionId = await newSession(bridge);
    const result = await prompt(bridge, sessionId, "long task");
    expect(result.stopReason).toBe("end_turn");
    expect(chunkText(bridge.updates())).toBe("OK after retry");
    const state = bridge.state();
    expect(state.sends).toHaveLength(2);
    expect(state.creates).toHaveLength(2);
  });
});

describe("zcode ACP bridge account plan", () => {
  it("pushes the account Start Plan entitlement and serves its runtime headers, refusing the rest", async () => {
    const bridge = startAccountBridge("account");
    const sessionId = await newSession(bridge);
    const result = await prompt(bridge, sessionId, "plan task");
    expect(result.stopReason).toBe("end_turn");
    expect(chunkText(bridge.updates())).toBe("OK account");

    const state = bridge.state();
    expect(state.accountPushes).toHaveLength(1);
    const push = state.accountPushes[0];
    expect(push.providers).toEqual({
      "account:bigmodel-start-plan": { access: { type: "zhipu-account", entitled: true } },
    });
    expect(push.states).toEqual({
      "account:bigmodel-start-plan": { availability: "available", entitled: true, current: true },
    });
    expect(push.revision).toMatch(/^omb-bridge-/);
    expect(push.basedOnZCodeBuiltinRevision).toBe(
      `zcode-builtin:30:${createHash("sha256").update(join(bridge.dir, "zcode-builtin.json")).digest("hex")}`,
    );

    expect(state.headerRequests).toEqual([
      { askedProvider: "account:bigmodel-start-plan", granted: true, keyOk: true },
      { askedProvider: "builtin:bigmodel", granted: false, keyOk: false },
      { askedProvider: "account:bigmodel-start-plan:individual-coding-plan", granted: false, keyOk: false },
    ]);
  });

  it("pushes nothing and refuses runtime headers without an account login", async () => {
    const bridge = startAccountBridge("account", false);
    const sessionId = await newSession(bridge);
    const result = await prompt(bridge, sessionId, "plan task");
    expect(result.stopReason).toBe("end_turn");
    const state = bridge.state();
    expect(state.accountPushes ?? []).toHaveLength(0);
    expect(state.headerRequests.every((entry: any) => entry.granted === false)).toBe(true);
  });
});

describe("isStaleZcodeSessionError", () => {
  it("recognises the app server's dropped-session wording", () => {
    expect(isStaleZcodeSessionError(new Error("session is not resident: sess-1 (proto.sessionNotResident)"))).toBe(true);
    expect(isStaleZcodeSessionError(new Error("Session is not active and not persisted: sess-1 (fault.subscribe.sessionNotFound)"))).toBe(true);
    expect(isStaleZcodeSessionError(new Error("proto.sessionNotFound"))).toBe(true);
  });

  it("leaves an ordinary failure alone", () => {
    expect(isStaleZcodeSessionError(new Error("RPC_TIMEOUT"))).toBe(false);
    expect(isStaleZcodeSessionError(undefined)).toBe(false);
  });
});

describe("isActivePromptError (E18)", () => {
  it("recognises the app server's busy-session refusal", () => {
    expect(isActivePromptError(new Error("-32010: A prompt is already running for this session"))).toBe(true);
    const rpc = new Error("RPC_REJECTED");
    (rpc as any).detail = { message: "active prompt exists" };
    expect(isActivePromptError(rpc)).toBe(true);
  });

  it("leaves a dropped session or an ordinary failure alone", () => {
    expect(isActivePromptError(new Error("session is not resident: sess-1 (proto.sessionNotResident)"))).toBe(false);
    expect(isActivePromptError(new Error("RPC_TIMEOUT"))).toBe(false);
  });
});
