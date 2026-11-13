// @vitest-environment node
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { DEFAULT_FLEET, PRODUCT_FLEET_ADDITIONS } from "../instance-fleets.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { BUILT_IN_DRIVERS } from "./builtIn.ts";
import {
  DOUBAO_MODELS,
  DoubaoAgentDriver,
  cleanDoubaoReply,
  classifyDoubaoFailure,
  createDoubaoDriver,
  doubaoArgs,
  doubaoEffort,
  doubaoSessionsRoot,
  listDoubaoSessionIds,
  resolveDoubaoCli,
  type DoubaoDeps,
} from "./doubao.ts";

interface Plan {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  /** The process never finishes until it is killed. */
  hang?: boolean;
}

function fakeChild(plan: Plan) {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const killed: string[] = [];
  const add = (key: string, handler: (...args: unknown[]) => void) => {
    const list = handlers.get(key) ?? [];
    list.push(handler);
    handlers.set(key, list);
  };
  const emit = (key: string, ...args: unknown[]) => {
    for (const handler of Array.from(handlers.get(key) ?? [])) handler(...args);
  };
  const child = {
    stdout: { setEncoding() {}, on(event: string, handler: (chunk: string) => void) { add(`stdout:${event}`, handler as (...args: unknown[]) => void); } },
    stderr: { setEncoding() {}, on(event: string, handler: (chunk: string) => void) { add(`stderr:${event}`, handler as (...args: unknown[]) => void); } },
    once(event: string, handler: (...args: unknown[]) => void) { add(event, handler); return child; },
    kill(signal?: string) {
      killed.push(signal ?? "SIGTERM");
      setTimeout(() => emit("close", null, "SIGTERM"), 0);
      return true;
    },
  };
  setTimeout(() => {
    if (plan.hang) return;
    if (plan.stdout) emit("stdout:data", plan.stdout);
    if (plan.stderr) emit("stderr:data", plan.stderr);
    emit("close", plan.code ?? 0, null);
  }, 0);
  return { child: child as unknown as ChildProcess, killed };
}

function fakeDoubao(options: {
  plans?: Plan[];
  /** Successive reads of the sessions folder; the last one repeats. */
  sessions?: string[][];
  exec?: (args: string[]) => { code: number | null; stdout?: string; stderr?: string };
} = {}) {
  const plans = [...(options.plans ?? [{ stdout: "OK" }])];
  const sessions = [...(options.sessions ?? [[]])];
  const spawns: Array<{ args: string[]; env: NodeJS.ProcessEnv; cwd: string }> = [];
  const kills: string[][] = [];
  const execs: Array<{ args: string[]; env: NodeJS.ProcessEnv; timeout: number }> = [];
  let clock = 0;
  let execCalls = 0;
  const deps: DoubaoDeps = {
    spawn: (_cli, args, opts) => {
      spawns.push({ args, env: opts.env, cwd: opts.cwd });
      const plan = plans.length > 1 ? plans.shift()! : plans[0]!;
      const fake = fakeChild(plan);
      kills.push(fake.killed);
      return fake.child;
    },
    exec: async (_cli, args, opts) => {
      execCalls += 1;
      execs.push({ args, env: opts.env, timeout: opts.timeout });
      const result = options.exec?.(args) ?? { code: 0 };
      return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    listSessions: () => (sessions.length > 1 ? sessions.shift()! : sessions[0] ?? []),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return { deps, spawns, kills, execs, execCount: () => execCalls, advance: (ms: number) => { clock += ms; } };
}

async function settle(events: RuntimeEvent[], count = 1, type = "turn.completed"): Promise<void> {
  for (let i = 0; i < 3_000 && events.filter((event) => event.type === type).length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const promptOf = (args: string[]): string => args[args.indexOf("-p") + 1] ?? "";
const replyOf = (events: RuntimeEvent[]): string => events
  .filter((event) => event.type === "content.delta").map((event) => (event as { delta: string }).delta).join("");
const eventTypes = (events: RuntimeEvent[]): string[] => events.map((event) => event.type);

describe("豆包 CLI driver", () => {
  let scratch: string;
  let cliPath: string;
  let instance: ProviderInstance | undefined;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "omb-doubao-contract-"));
    cliPath = join(scratch, "doubao");
    writeFileSync(cliPath, "");
  });
  afterEach(async () => {
    await instance?.dispose();
    instance = undefined;
    await removeTempDir(scratch);
  });

  async function start(
    fake: ReturnType<typeof fakeDoubao>,
    config: Record<string, unknown> = {},
    envExtra: Record<string, string> = {},
  ) {
    const driver = createDoubaoDriver(fake.deps);
    const created = await driver.create({
      instanceId: "doubao-contract", displayName: "豆包", enabled: true,
      environment: { HOME: scratch, PATH: "", ...envExtra },
      config: driver.decodeConfig({ cli: cliPath, ...config }),
    });
    instance = created;
    const events: RuntimeEvent[] = [];
    created.adapter.onEvent((event) => { events.push(event); });
    return { instance: created, events };
  }

  it("is registered with a fleet slot and its own display name", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "doubaoAgent")).toBe(true);
    expect(DEFAULT_FLEET.doubao?.driver).toBe("doubaoAgent");
    expect(PRODUCT_FLEET_ADDITIONS.doubao?.driver).toBe("doubaoAgent");
    expect(DoubaoAgentDriver.metadata.displayName).toBe("豆包 Doubao");
    expect(DoubaoAgentDriver.metadata.access).toBe("subscription");
    expect(DoubaoAgentDriver.install?.docsUrl).toBe("https://www.doubao.com/work/docs/zh-cn/doubao-cli");
  });

  it("decodes the instance config", () => {
    expect(DoubaoAgentDriver.decodeConfig({})).toEqual({ cli: "doubao" });
    expect(DoubaoAgentDriver.decodeConfig({ cli: " /opt/doubao ", workspace: "/w" })).toEqual({ cli: "/opt/doubao", workspace: "/w" });
  });

  it("resolves the CLI from an explicit path, else nothing", () => {
    expect(resolveDoubaoCli({ HOME: scratch, PATH: "" }, join(scratch, "missing"))).toBeNull();
    expect(resolveDoubaoCli({ HOME: scratch, PATH: "" }, cliPath)).toBe(cliPath);
    expect(resolveDoubaoCli({ HOME: scratch, PATH: "", OMB_DOUBAO_CLI: cliPath }, "doubao")).toBe(cliPath);
    expect(resolveDoubaoCli({ HOME: scratch, PATH: "", OMB_DOUBAO_CLI: join(scratch, "missing") }, "doubao")).toBeNull();
  });

  it("finds doubao on PATH and in the two install folders", () => {
    const onPath = join(scratch, "bin", "doubao");
    mkdirSync(dirname(onPath), { recursive: true });
    writeFileSync(onPath, "");
    expect(resolveDoubaoCli({ HOME: scratch, PATH: join(scratch, "bin") }, "doubao")).toBe(onPath);

    const global = join(scratch, ".npm-global", "bin", "doubao");
    mkdirSync(dirname(global), { recursive: true });
    writeFileSync(global, "");
    expect(resolveDoubaoCli({ HOME: scratch, PATH: "" }, "doubao")).toBe(global);

    const local = join(scratch, ".local", "bin", "doubao");
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, "");
    expect(resolveDoubaoCli({ HOME: scratch, PATH: "" }, "doubao")).toBe(global);
  });

  it("reads numeric session folders under the account's data folder", () => {
    expect(doubaoSessionsRoot({ HOME: scratch })).toBe(join(scratch, ".local", "share", "doubao_cli", "agent_mode"));
    expect(doubaoSessionsRoot({ HOME: scratch, XDG_DATA_HOME: "/data" })).toBe(join("/data", "doubao_cli", "agent_mode"));

    const root = join(scratch, "agent_mode");
    const sessions = join(root, "acct", "workspace", ".sessions");
    mkdirSync(join(sessions, "42"), { recursive: true });
    mkdirSync(join(sessions, "7"), { recursive: true });
    mkdirSync(join(sessions, "notes"), { recursive: true });
    writeFileSync(join(sessions, "99"), "");
    expect(listDoubaoSessionIds(root)).toEqual(["7", "42"]);
    expect(listDoubaoSessionIds(sessions)).toEqual(["7", "42"]);
    expect(listDoubaoSessionIds(join(scratch, "nope"))).toEqual([]);
  });

  it("builds an unattended argv with the working folder and the prompt", () => {
    expect(doubaoArgs({ prompt: "hello", cwd: "/work" })).toEqual([
      "-C", "/work", "--permission-mode", "always_allow", "-p", "hello",
    ]);
    expect(doubaoArgs({ prompt: "hello", cwd: "/work" })).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("passes a named model, effort and a resume id", () => {
    expect(doubaoArgs({ prompt: "again", cwd: "/w", model: "doubao-pro", effort: "medium", resumeId: "42" })).toEqual([
      "--resume", "42", "-C", "/w", "--model", "doubao-pro", "--effort", "medium",
      "--permission-mode", "always_allow", "-p", "again",
    ]);
  });

  it("leaves Auto to the CLI's own choice", () => {
    expect(doubaoArgs({ prompt: "x", cwd: "/w", model: "Auto" })).not.toContain("--model");
    expect(DOUBAO_MODELS.options.map((option) => option.id)).toEqual(["Auto"]);
  });

  it("maps the harness effort levels", () => {
    expect(doubaoEffort(undefined)).toBeUndefined();
    expect(doubaoEffort("none")).toBe("low");
    expect(doubaoEffort("low")).toBe("low");
    expect(doubaoEffort("medium")).toBe("medium");
    expect(doubaoEffort("high")).toBe("high");
    expect(doubaoEffort("xhigh")).toBe("high");
    expect(doubaoEffort("max")).toBe("high");
  });

  it("strips terminal colouring and surrounding whitespace from the reply", () => {
    expect(cleanDoubaoReply("  \u001b[32mOK-E75\u001b[0m\n\n")).toBe("OK-E75");
    expect(cleanDoubaoReply("\u001b]0;title\u0007done")).toBe("done");
    expect(cleanDoubaoReply("")).toBe("");
  });

  it("classifies a sign-in failure as setup", () => {
    for (const failure of [
      classifyDoubaoFailure(4, "", ""),
      classifyDoubaoFailure(1, "login_required: run doubao login", ""),
      classifyDoubaoFailure(null, "auth_unavailable", ""),
    ]) {
      expect(failure.setup).toBe(true);
      expect(failure.message).toContain("doubao login");
    }
  });

  it("classifies a plan limit and otherwise shows the CLI's stderr", () => {
    expect(classifyDoubaoFailure(1, "当前套餐订阅额度已用完", "")).toMatchObject({ limit: "engine" });
    expect(classifyDoubaoFailure(1, "quota exceeded", "")).toMatchObject({ limit: "engine" });
    const other = classifyDoubaoFailure(2, "  something broke\n", "");
    expect(other.limit).toBeUndefined();
    expect(other.setup).toBeUndefined();
    expect(other.message).toBe("something broke");
  });

  it("runs one turn, then streams and stores the reply", async () => {
    const fake = fakeDoubao({ plans: [{ stdout: "\u001b[32m 你好\u001b[0m\n", code: 0 }], sessions: [[], ["7"]] });
    const { instance: inst, events } = await start(fake);
    const { turnId } = await inst.adapter.sendTurn({ threadId: "t1", text: "hi" });
    await settle(events);

    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0]!.cwd).toBe(scratch);
    expect(promptOf(fake.spawns[0]!.args)).toBe("hi");
    expect(eventTypes(events)).toEqual(["turn.started", "session.started", "content.delta", "item.completed", "turn.completed"]);
    expect(events.find((event) => event.type === "item.completed")).toMatchObject({ itemType: "assistant_text", text: "你好" });
    expect(events.every((event) => event.turnId === turnId)).toBe(true);
    expect(replyOf(events)).toBe("你好");
    expect(events.at(-1)).toMatchObject({ ok: true, stopReason: "end_turn" });
    expect(inst.adapter.hasSession("t1")).toBe(true);
    await expect(inst.adapter.respondToRequest("t1", "req", { behavior: "allow" })).resolves.toBe("unavailable");
  });

  it("puts the persona and the old thread in a new session, and only the new words on a resume", async () => {
    const fake = fakeDoubao({
      plans: [{ stdout: "first" }, { stdout: "second" }],
      sessions: [[], ["7"], ["7"], ["7"]],
    });
    const { instance: inst, events } = await start(fake);
    await inst.adapter.sendTurn({
      threadId: "t1", text: "hi", system: "SYS",
      transcript: [{ role: "user", text: "u1" }, { role: "assistant", text: "a1" }],
    });
    await settle(events);
    const first = promptOf(fake.spawns[0]!.args);
    expect(first).toContain("用户：u1");
    expect(first).toContain("助手：a1");
    expect(first).toContain("SYS");
    expect(first).toContain("---");
    expect(first.endsWith("hi")).toBe(true);

    await inst.adapter.sendTurn({ threadId: "t1", text: "again", system: "SYS", transcript: [{ role: "user", text: "u2" }] });
    await settle(events, 2);
    expect(fake.spawns[1]!.args).toContain("--resume");
    expect(fake.spawns[1]!.args[fake.spawns[1]!.args.indexOf("--resume") + 1]).toBe("7");
    expect(promptOf(fake.spawns[1]!.args)).toBe("again");
  });

  it("remembers the one new session folder, and a reset drops it", async () => {
    const fake = fakeDoubao({
      plans: [{ stdout: "a" }, { stdout: "b" }],
      sessions: [[], ["7"], ["7"], ["7", "8"]],
    });
    const { instance: inst, events } = await start(fake);
    await inst.adapter.sendTurn({ threadId: "t1", text: "one" });
    await settle(events);
    expect(inst.adapter.hasSession("t1")).toBe(true);

    await inst.adapter.sendTurn({ threadId: "t1", text: "two", sessionReset: true });
    await settle(events, 2);
    expect(fake.spawns[1]!.args).not.toContain("--resume");
    expect(promptOf(fake.spawns[1]!.args)).toBe("two");
    expect(inst.adapter.hasSession("t1")).toBe(true);
  });

  it("does not remember a session when several new folders appear", async () => {
    const fake = fakeDoubao({
      plans: [{ stdout: "a" }, { stdout: "b" }],
      sessions: [[], ["7", "8"], ["7", "8"], ["7", "8", "9"]],
    });
    const { instance: inst, events } = await start(fake);
    await inst.adapter.sendTurn({ threadId: "t1", text: "one" });
    await settle(events);
    expect(inst.adapter.hasSession("t1")).toBe(false);

    await inst.adapter.sendTurn({ threadId: "t1", text: "two" });
    await settle(events, 2);
    expect(fake.spawns[1]!.args).not.toContain("--resume");
  });

  it("interrupts the running CLI and ends the turn as interrupted", async () => {
    const fake = fakeDoubao({ plans: [{ hang: true }], sessions: [[], []] });
    const { instance: inst, events } = await start(fake);
    await inst.adapter.sendTurn({ threadId: "t1", text: "x" });
    for (let i = 0; i < 200 && fake.spawns.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(fake.spawns).toHaveLength(1);
    await inst.adapter.interruptTurn("t1");
    await settle(events);
    expect(fake.kills[0]).toContain("SIGTERM");
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "interrupted" });
  });

  it("stops a turn that runs past OMB_DOUBAO_TIMEOUT_MS", async () => {
    const fake = fakeDoubao({ plans: [{ hang: true }], sessions: [[], []] });
    const { instance: inst, events } = await start(fake, {}, { OMB_DOUBAO_TIMEOUT_MS: "1200" });
    await inst.adapter.sendTurn({ threadId: "t1", text: "x" });
    await settle(events);
    expect(fake.kills[0]).toContain("SIGTERM");
    expect(events.find((event) => event.type === "runtime.error")).toMatchObject({ message: expect.stringContaining("秒内没有完成") });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "error" });
  });

  it("snapshots a missing CLI, a signed-out CLI and a signed-in one, cached for a minute", async () => {
    const missing = fakeDoubao();
    const driver = createDoubaoDriver(missing.deps);
    instance = await driver.create({
      instanceId: "doubao-missing", displayName: "豆包", enabled: true,
      environment: { HOME: scratch, PATH: "" },
      config: driver.decodeConfig({ cli: join(scratch, "missing") }),
    });
    expect((await instance.snapshot()).reason).toContain("安装");
    await instance.dispose();

    const signedOut = fakeDoubao({ exec: () => ({ code: 4, stdout: "login_required: no account" }) });
    const out = await start(signedOut);
    expect(await out.instance.snapshot()).toMatchObject({ state: "unavailable", authenticated: false });
    await instance?.dispose();

    const signedIn = fakeDoubao({ exec: () => ({ code: 0, stdout: "ok" }) });
    const inside = await start(signedIn);
    await expect(inside.instance.snapshot()).resolves.toMatchObject({ state: "available", authenticated: true, billing: "subscription" });
    await expect(inside.instance.snapshot()).resolves.toMatchObject({ state: "available" });
    expect(signedIn.execCount()).toBe(1);
    expect(signedIn.execs[0]!.args).toEqual(["auth", "status"]);
    signedIn.advance(60_001);
    await expect(inside.instance.snapshot()).resolves.toMatchObject({ state: "available" });
    expect(signedIn.execCount()).toBe(2);
  });

  it("gives the CLI no control-plane variables and turns off its update prompt", async () => {
    const fake = fakeDoubao({ plans: [{ stdout: "ok" }] });
    const { instance: inst, events } = await start(fake, {}, {
      OMB_CLOUD_AI_TOKEN: "cloud-secret",
      OMB_LICENSE_KEY: "license-secret",
    });
    await inst.adapter.sendTurn({ threadId: "t1", text: "x" });
    await settle(events);
    const env = fake.spawns[0]!.env;
    expect(env.DOUBAO_CLI_NO_UPDATE_CHECK).toBe("1");
    expect(env.OMB_CLOUD_AI_TOKEN).toBeUndefined();
    expect(env.OMB_LICENSE_KEY).toBeUndefined();
    expect(env.PATH).toBe("");
  });

  it("refuses a confined guest turn without starting the CLI", async () => {
    const fake = fakeDoubao();
    const { instance: inst, events } = await start(fake);
    await inst.adapter.sendTurn({ threadId: "t1", text: "x", guestConfined: true });
    await settle(events);
    expect(fake.spawns).toHaveLength(0);
    expect(events.find((event) => event.type === "runtime.error")).toMatchObject({ setup: true, message: expect.stringContaining("受限访客") });
  });
});
