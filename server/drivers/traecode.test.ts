// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { DEFAULT_FLEET, PRODUCT_FLEET_ADDITIONS } from "../instance-fleets.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { BUILT_IN_DRIVERS } from "./builtIn.ts";
import {
  TRAE_READ_EXPRESSION,
  TraecodeAgentDriver,
  cleanTraeReply,
  createTraecodeDriver,
  isTraePlaceholder,
  resolveTraecodeCli,
  traecodeEndpoints,
  traecodeLocalSnapshot,
  traecodeSignedIn,
  type TraePageReading,
} from "./traecode.ts";

type Reading = Partial<TraePageReading>;

/** A fake bridge + page: /v1/chat records prompts; each page read pops the next reading (the last one repeats). */
function fakeTrae(readings: Reading[], options: { chat?: unknown; ready?: unknown; chatThrows?: boolean } = {}) {
  const posts: Array<Record<string, unknown>> = [];
  const evaluated: string[] = [];
  let clock = 0;
  const queue = [...readings];
  const deps = {
    pollMs: 1,
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; await new Promise((r) => setImmediate(r)); },
    fetch: (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/v1/chat")) {
        if (options.chatThrows) throw new Error("ECONNREFUSED");
        posts.push(JSON.parse(String(init?.body ?? "{}")));
        return { json: async () => options.chat ?? { success: true, data: { result: { status: "ok", response: { text: "TRAE\n思考中" } } } } };
      }
      if (String(url).endsWith("/ready")) {
        return { json: async () => options.ready ?? { success: true, data: { automation: { ready: true, details: { composerFound: true } } } } };
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch,
    evaluate: async (_cdp: string, expression: string) => {
      evaluated.push(expression);
      if (expression !== TRAE_READ_EXPRESSION) return true;
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      return { count: 0, text: "", done: false, generating: false, composer: true, ...next };
    },
    advance: (ms: number) => { clock += ms; },
  };
  return { deps, posts, evaluated };
}

async function settle(events: RuntimeEvent[], type = "turn.completed", count = 1): Promise<void> {
  for (let i = 0; i < 400 && events.filter((e) => e.type === type).length < count; i++) await new Promise((r) => setTimeout(r, 1));
}

describe("Trae Code driver", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "omb-traecode-contract-"));
  });
  afterEach(async () => {
    await instance?.dispose();
    instance = undefined;
    await removeTempDir(scratch);
  });

  function writeJwt(home: string): void {
    const path = join(home, ".trae-cn", "trae-jwt-token");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not-a-real-token-fixture\n");
  }

  function installed(): string {
    const cli = join(scratch, "trae-cn");
    writeFileSync(cli, "");
    writeJwt(scratch);
    return cli;
  }

  async function start(deps: ReturnType<typeof fakeTrae>["deps"], config: Record<string, unknown> = {}) {
    const driver = createTraecodeDriver(deps);
    instance = await driver.create({
      instanceId: "traecode-contract", displayName: "Trae Code", enabled: true,
      environment: { HOME: scratch },
      config: driver.decodeConfig({ cli: installed(), ...config }),
    });
    const events: RuntimeEvent[] = [];
    instance.adapter.onEvent((event) => { events.push(event); });
    return { instance, events };
  }

  const replyOf = (events: RuntimeEvent[]) => events
    .filter((e) => e.type === "content.delta").map((e) => (e as { delta: string }).delta).join("");

  it("is registered for the migrated fleet kind", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "traecodeAgent")).toBe(true);
    expect(DEFAULT_FLEET.traecode?.driver).toBe("traecodeAgent");
    expect(PRODUCT_FLEET_ADDITIONS.traecode?.driver).toBe("traecodeAgent");
    expect(TraecodeAgentDriver.metadata.displayName).toBe("Trae Code");
  });

  it("decodes the instance config, bridge and CDP endpoints included", () => {
    expect(TraecodeAgentDriver.decodeConfig({})).toEqual({ cli: "traecode", fullAuto: false });
    expect(TraecodeAgentDriver.decodeConfig({ cli: "/usr/bin/trae-cn", workspace: "/w", gatewayUrl: "http://10.0.0.2:8787/", cdpUrl: "nope" }))
      .toEqual({ cli: "/usr/bin/trae-cn", fullAuto: false, workspace: "/w", gatewayUrl: "http://10.0.0.2:8787" });
    expect(traecodeEndpoints({}, { cli: "traecode", fullAuto: false }))
      .toEqual({ gateway: "http://127.0.0.1:8787", cdp: "http://127.0.0.1:9222" });
    expect(traecodeEndpoints({ TRAE_GATEWAY: "http://127.0.0.1:9787/", OMB_TRAECODE_CDP: "http://127.0.0.1:9333" }, { cli: "traecode", fullAuto: false }))
      .toEqual({ gateway: "http://127.0.0.1:9787", cdp: "http://127.0.0.1:9333" });
  });

  it("resolves the CLI from an explicit path, else the standard install paths", () => {
    expect(resolveTraecodeCli({ HOME: scratch }, join(scratch, "missing"))).toBeNull();
    const explicit = join(scratch, "trae-cn");
    writeFileSync(explicit, "");
    expect(resolveTraecodeCli({ HOME: scratch }, explicit)).toBe(explicit);
    expect(resolveTraecodeCli({ HOME: scratch, OMB_TRAECODE_CLI: explicit }, "traecode")).toBe(explicit);
    expect(resolveTraecodeCli({ HOME: scratch, OMB_TRAECODE_CLI: join(scratch, "missing") }, "traecode")).toBeNull();
    const fallback = resolveTraecodeCli({ HOME: scratch }, "traecode");
    expect(fallback === null || existsSync(fallback)).toBe(true);
    const local = join(scratch, ".local", "bin", "traecode");
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, "");
    expect(existsSync(resolveTraecodeCli({ HOME: scratch }, "traecode") ?? "")).toBe(true);

    expect(traecodeSignedIn({ HOME: scratch })).toBe(false);
    writeJwt(scratch);
    expect(traecodeSignedIn({ HOME: scratch })).toBe(true);
  });

  it("checks the local install and sign-in only when the bridge is on this box", () => {
    const missing = traecodeLocalSnapshot({ HOME: scratch }, { cli: join(scratch, "missing"), fullAuto: false });
    expect(missing?.reason).toContain("isn't installed");
    const cli = join(scratch, "trae-cn");
    writeFileSync(cli, "");
    expect(traecodeLocalSnapshot({ HOME: scratch }, { cli, fullAuto: false })?.reason).toContain("not signed in");
    writeJwt(scratch);
    expect(traecodeLocalSnapshot({ HOME: scratch }, { cli, fullAuto: false })).toBeNull();
    expect(traecodeLocalSnapshot({ HOME: scratch }, { cli: join(scratch, "missing"), fullAuto: false, gatewayUrl: "http://10.1.2.3:8787" })).toBeNull();
  });

  it("is available when the bridge is ready, and says why when it is not", async () => {
    const ready = await start(fakeTrae([]).deps);
    await expect(ready.instance.snapshot()).resolves.toMatchObject({ state: "available", authenticated: true });
    await instance?.dispose();

    const noBox = await start(fakeTrae([], { ready: { success: true, data: { automation: { ready: false, details: { composerFound: false } } } } }).deps);
    const snap = await noBox.instance.snapshot();
    expect(snap.state).toBe("unavailable");
    expect(snap.reason).toContain("sign in");
    await instance?.dispose();

    const down = fakeTrae([]);
    down.deps.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const off = await start(down.deps);
    expect((await off.instance.snapshot()).reason).toContain("Can't reach the Trae bridge");
  });

  it("offers the desktop's own model", () => {
    expect(TraecodeAgentDriver.models.default).toBe("trae-desktop");
    expect(TraecodeAgentDriver.models.options.map((o) => o.id)).toEqual(["trae-desktop"]);
  });

  it("recognizes the first-paint placeholder and strips the turn chrome", () => {
    expect(isTraePlaceholder("TRAE\n思考中")).toBe(true);
    expect(isTraePlaceholder("")).toBe(true);
    expect(isTraePlaceholder("OK-E75")).toBe(false);
    expect(cleanTraeReply("TRAE\n\nOK-E75\n\n由 AI 生成\n12%")).toBe("OK-E75");
    expect(cleanTraeReply("done\n\n37%")).toBe("done");
  });

  it("sends through the bridge in a fresh task and returns the reply once the turn finishes", async () => {
    const trae = fakeTrae([
      { count: 1, text: "TRAE\n思考中" },
      { count: 1, text: "Working" },
      { count: 1, text: "OK-E75", done: true, generating: true },
      { count: 1, text: "OK-E75", done: true },
    ]);
    const { instance: inst, events } = await start(trae.deps);
    const { turnId } = await inst.adapter.sendTurn({ threadId: "t1", text: "reply OK-E75" });
    await settle(events);
    expect(trae.posts).toEqual([{ content: "reply OK-E75", newChat: true, sessionMetadata: { client: "omb" } }]);
    expect(events.map((e) => e.type)).toEqual(["turn.started", "session.started", "content.delta", "item.completed", "turn.completed"]);
    expect(events.find((e) => e.type === "item.completed")).toMatchObject({ itemType: "assistant_text", text: "OK-E75" });
    expect(events.every((e) => e.turnId === turnId)).toBe(true);
    expect(replyOf(events)).toBe("OK-E75");
    expect(events.at(-1)).toMatchObject({ ok: true, stopReason: "end_turn" });
    expect(inst.adapter.hasSession("t1")).toBe(true);
  });

  it("continues the open task for the same thread and reads only a newer turn", async () => {
    const trae = fakeTrae([
      { count: 1, text: "first", done: true },
      { count: 1, text: "first", done: true },
      { count: 1, text: "first", done: true }, // baseline read before the follow-up
      { count: 1, text: "first", done: true }, // still the old turn: ignored
      { count: 2, text: "second", done: true },
      { count: 2, text: "second", done: true },
    ]);
    const { instance: inst, events } = await start(trae.deps);
    await inst.adapter.sendTurn({ threadId: "t1", text: "one" });
    await settle(events);
    await inst.adapter.sendTurn({ threadId: "t1", text: "two" });
    await settle(events, "turn.completed", 2);
    expect(trae.posts.map((p) => p.newChat ?? false)).toEqual([true, false]);
    expect(events.filter((e) => e.type === "content.delta").map((e) => (e as { delta: string }).delta)).toEqual(["first", "second"]);
  });

  it("opens a new task for another thread or a reset", async () => {
    const trae = fakeTrae([{ count: 1, text: "a", done: true }]);
    const { instance: inst, events } = await start(trae.deps);
    await inst.adapter.sendTurn({ threadId: "t1", text: "one" });
    await inst.adapter.sendTurn({ threadId: "t2", text: "two" });
    await inst.adapter.sendTurn({ threadId: "t2", text: "three", sessionReset: true });
    await settle(events, "turn.completed", 3);
    expect(trae.posts.map((p) => p.newChat ?? false)).toEqual([true, true, true]);
    expect(inst.adapter.hasSession("t1")).toBe(false);
    expect(inst.adapter.hasSession("t2")).toBe(true);
  });

  it("fails the turn with a readable reason when the bridge is down or refuses", async () => {
    const down = fakeTrae([], { chatThrows: true });
    const first = await start(down.deps);
    await first.instance.adapter.sendTurn({ threadId: "t1", text: "x" });
    await settle(first.events);
    expect(first.events.find((e) => e.type === "runtime.error")).toMatchObject({ message: expect.stringContaining("Can't reach the Trae bridge") });
    expect(first.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "error" });
    expect(first.instance.adapter.hasSession("t1")).toBe(false);
    await instance?.dispose();

    const refused = fakeTrae([], { chat: { success: false, code: "AUTOMATION_NEW_CHAT_FAILED", message: "Failed to switch Trae into a fresh conversation" } });
    const second = await start(refused.deps);
    await second.instance.adapter.sendTurn({ threadId: "t1", text: "x" });
    await settle(second.events);
    expect(second.events.find((e) => e.type === "runtime.error")).toMatchObject({ message: expect.stringContaining("fresh conversation") });
  });

  it("reports Trae's request queue as an engine limit", async () => {
    const trae = fakeTrae([{ count: 1, text: "排队提醒：当前模型请求量较高", done: true }]);
    const { instance: inst, events } = await start(trae.deps);
    await inst.adapter.sendTurn({ threadId: "t1", text: "x" });
    await settle(events);
    expect(events.find((e) => e.type === "runtime.error")).toMatchObject({ limit: "engine" });
  });

  it("times out a turn that never finishes, keeping what it wrote", async () => {
    const trae = fakeTrae([{ count: 1, text: "half done", generating: true }]);
    trae.deps.pollMs = 60_000;
    const { instance: inst, events } = await start(trae.deps);
    await inst.adapter.sendTurn({ threadId: "t1", text: "x" });
    await settle(events);
    expect(replyOf(events)).toBe("half done");
    expect(events.find((e) => e.type === "runtime.error")).toMatchObject({ message: expect.stringContaining("didn't finish") });
  });

  it("interrupts a running turn by pressing stop", async () => {
    const trae = fakeTrae([{ count: 1, text: "busy", generating: true }]);
    const { instance: inst, events } = await start(trae.deps);
    await inst.adapter.sendTurn({ threadId: "t1", text: "x" });
    await new Promise((r) => setTimeout(r, 5));
    await inst.adapter.interruptTurn("t1");
    await settle(events);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "interrupted" });
    expect(trae.evaluated.some((expr) => expr !== TRAE_READ_EXPRESSION && expr.includes("click"))).toBe(true);
    await expect(inst.adapter.respondToRequest("t1", "req-1", { behavior: "allow" })).resolves.toBe("unavailable");
  });

  it("refuses a turn up front when the local IDE is signed out", async () => {
    const trae = fakeTrae([]);
    const driver = createTraecodeDriver(trae.deps);
    const cli = join(scratch, "trae-cn");
    writeFileSync(cli, "");
    instance = await driver.create({ instanceId: "x", displayName: "Trae Code", enabled: true, environment: { HOME: scratch }, config: driver.decodeConfig({ cli }) });
    const events: RuntimeEvent[] = [];
    instance.adapter.onEvent((event) => { events.push(event); });
    await instance.adapter.sendTurn({ threadId: "t1", text: "x" });
    await settle(events);
    expect(trae.posts).toHaveLength(0);
    expect(events.find((e) => e.type === "runtime.error")).toMatchObject({ message: expect.stringContaining("not signed in") });
  });
});
