// FEAT-dumate: the DuMate chat driver. The account store, the token swap and the gateway are all fakes here.
import { describe, expect, it, vi } from "vitest";

import { BUILT_IN_DRIVERS } from "./builtIn.ts";
import { DEFAULT_FLEET, PRODUCT_FLEET_ADDITIONS } from "../instance-fleets.ts";
import { engineCapabilities } from "../runtime/capabilities.ts";
import { TOOL_SCOPE_SUPPORT } from "../../shared/tool-scope-support.ts";
import { engineForDriver } from "../../src/lib/analytics-allowlist.ts";
import { supportsWorkspaceFiles } from "../workspace.ts";
import {
  accountOrder, createDumateDriver, createDumateFetch, decodeDumateConfig, DUMATE_MODELS, NOT_SIGNED_IN, pointsShort,
  type DumateDeps,
} from "./dumate.ts";
import { RELOGIN_HINT } from "../checkin/dumate.mjs";
import { REASONING_ONLY, TRUNCATED_LENGTH, TRUNCATED_NO_FINISH } from "./openai-chat.ts";
import type { RuntimeEvent } from "../contracts.ts";

const acc = (id: string, extra: Record<string, unknown> = {}) => ({ id, uid: `${id}-uid`, name: `号${id}`, cookie: `BDUSS=${id}`, ...extra });

function deps(accounts: Array<Record<string, any>>, over: Partial<DumateDeps> = {}) {
  const tokens = new Map<string, number>();
  const base: DumateDeps = {
    loadStore: (async () => ({ accounts })) as never,
    gatewayToken: (async (a: { id: string }, opts?: { force?: boolean }) => {
      const n = (tokens.get(a.id) ?? 0) + (opts?.force || !tokens.has(a.id) ? 1 : 0);
      tokens.set(a.id, n);
      return { ok: true, token: `${a.id}-t${n}`, expiresAt: Date.now() + 3_600_000 };
    }) as never,
    forgetToken: vi.fn(),
    markExpired: vi.fn(async () => {}) as never,
    quotaOverview: (async () => ({ ok: true, total: 1000, used: 200, left: 800, throttled: false, subscribed: false, soonest: null, packages: [] })) as never,
    fetch: (async () => new Response("{}")) as never,
    now: () => Date.now(),
  };
  return { ...base, ...over };
}

const authOf = (init?: RequestInit) => new Headers(init?.headers).get("authorization");

describe("DuMate driver pieces", () => {
  it("decodes an optional account and tools flag", () => {
    expect(decodeDumateConfig({})).toEqual({});
    expect(decodeDumateConfig({ account: "dm-1", tools: false })).toEqual({ account: "dm-1", tools: false });
    expect(() => decodeDumateConfig({ tools: "no" })).toThrow();
  });

  it("knows the gateway's points-short answers", () => {
    expect(pointsShort(402, "")).toBe(true);
    expect(pointsShort(400, '{"error":{"message":"账户积分不足，请充值"}}')).toBe(true);
    expect(pointsShort(403, "insufficient points balance")).toBe(true);
    expect(pointsShort(400, "max_tokens range is [1, 131072]")).toBe(false);
  });

  it("puts the configured account first and skips lapsed ones", () => {
    const list = [acc("a", { expired: true }), acc("b"), acc("c")];
    expect(accountOrder(list as never).map((a) => a.id)).toEqual(["b", "c"]);
    expect(accountOrder(list as never, "c").map((a) => a.id)).toEqual(["c", "b"]);
  });

  it("offers the cloud route names the personal plan answers, model-text first", () => {
    expect(DUMATE_MODELS.default).toBe("model-text");
    expect(DUMATE_MODELS.options.map((o) => o.id)).toEqual(["model-text", "kimi-k31", "glm-53", "glm-53-flash", "deepseek-v4-pro", "deepseek-v41-flash", "qwen38-flash"]);
  });

  it("is a built-in chat engine with native tools and no workspace files", () => {
    expect(BUILT_IN_DRIVERS.some((d) => d.driverKind === "dumate")).toBe(true);
    expect((DEFAULT_FLEET as Record<string, { driver: string }>).dumate).toEqual({ driver: "dumate" });
    expect((PRODUCT_FLEET_ADDITIONS as Record<string, { driver: string }>).dumate).toEqual({ driver: "dumate" });
    expect(engineCapabilities("dumate").resume).toBe(engineCapabilities("greenference").resume);
    expect(TOOL_SCOPE_SUPPORT.dumate).toBe("native-and-mcp");
    expect(engineForDriver("dumate")).toBe("dumate");
    expect(supportsWorkspaceFiles("dumate")).toBe(false);
  });
});

describe("DuMate request auth", () => {
  it("answers 401 with the sign-in hint when nobody has scanned yet", async () => {
    const send = createDumateFetch({}, deps([]));
    const r = await send("https://gw/chat/completions", { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
    expect(JSON.stringify(await r.json())).toContain(NOT_SIGNED_IN);
  });

  it("swaps the placeholder bearer for the account's gateway token and marks the web client", async () => {
    const seen: RequestInit[] = [];
    const send = createDumateFetch({}, deps([acc("a")], { fetch: (async (_u: string, init: RequestInit) => { seen.push(init); return new Response("ok"); }) as never }));
    const r = await send("https://gw/chat/completions", { method: "POST", body: "{}", headers: { authorization: "Bearer dumate-gateway-token", "content-type": "application/json" } });
    expect(await r.text()).toBe("ok");
    const h = new Headers(seen[0]!.headers);
    expect(h.get("authorization")).toBe("Bearer a-t1");
    expect(h.get("x-dumate-client-type")).toBe("web");
    expect(h.get("content-type")).toBe("application/json");
  });

  it("re-mints a token the gateway refused once, then sends again", async () => {
    const seen: RequestInit[] = [];
    const d = deps([acc("a")], { fetch: (async (_u: string, init: RequestInit) => { seen.push(init); return seen.length === 1 ? new Response("", { status: 401 }) : new Response("ok"); }) as never });
    const r = await createDumateFetch({}, d)("https://gw/chat/completions", { method: "POST", body: "{}" });
    expect(r.status).toBe(200);
    expect(seen.map(authOf)).toEqual(["Bearer a-t1", "Bearer a-t2"]);
    expect(d.forgetToken).toHaveBeenCalledWith("a");
  });

  it("moves to the next account when one is out of points, and says so when all are", async () => {
    const short = () => new Response('{"error":{"message":"积分不足"}}', { status: 400 });
    const seen: string[] = [];
    const mixed = createDumateFetch({}, deps([acc("a"), acc("b")], { fetch: (async (_u: string, init: RequestInit) => { seen.push(authOf(init)!); return seen.length === 1 ? short() : new Response("ok"); }) as never }));
    expect((await mixed("https://gw/x", { method: "POST", body: "{}" })).status).toBe(200);
    expect(seen).toEqual(["Bearer a-t1", "Bearer b-t1"]);
    const allShort = createDumateFetch({}, deps([acc("a"), acc("b")], { fetch: (async () => short()) as never }));
    const r = await allShort("https://gw/x", { method: "POST", body: "{}" });
    expect(r.status).toBe(402);
    expect(JSON.stringify(await r.json())).toContain("insufficient credits");
  });

  it("asks for a new scan when the only account's cookie lapsed", async () => {
    const d = deps([acc("a")], { gatewayToken: (async () => ({ ok: false, expired: true, error: "登录已经过期" })) as never });
    const r = await createDumateFetch({}, d)("https://gw/x", { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
    expect(JSON.stringify(await r.json())).toContain(RELOGIN_HINT);
  });

  it("passes any other gateway error through untouched", async () => {
    const d = deps([acc("a")], { fetch: (async () => new Response("bad model", { status: 404 })) as never });
    const r = await createDumateFetch({}, d)("https://gw/x", { method: "POST", body: "{}" });
    expect(r.status).toBe(404);
    expect(await r.text()).toBe("bad model");
  });
});

describe("DuMate instance", () => {
  const create = (d: DumateDeps, config = {}) => createDumateDriver(d).create({
    instanceId: "dumate", displayName: "百度搭子 DuMate", enabled: true, config: decodeDumateConfig(config), environment: {},
  });

  it("is unavailable with the scan hint before any sign-in, and after the cookie lapsed", async () => {
    expect(await (await create(deps([]))).snapshot()).toMatchObject({ state: "unavailable", authenticated: false, reason: NOT_SIGNED_IN });
    const d = deps([acc("a")], { quotaOverview: (async () => ({ ok: false, expired: true, error: "登录已经过期" })) as never });
    expect(await (await create(d)).snapshot()).toMatchObject({ state: "unavailable", reason: RELOGIN_HINT });
    expect(d.markExpired).toHaveBeenCalledWith("a", true);
  });

  it("shows the account and its points balance when signed in", async () => {
    const snap = await (await create(deps([acc("a")]))).snapshot();
    expect(snap).toMatchObject({ state: "available", authenticated: true, billing: "subscription", account: { email: "号a", organization: "余额 800 积分", method: "login" } });
  });

  it("answers a helper call through the gateway with the minted token", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const d = deps([acc("a")], { fetch: (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
    }) as never });
    const instance = await create(d);
    expect(await instance.generateText!("hi")).toBe("你好");
    expect(seen[0]!.url).toBe("https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions");
    expect(authOf(seen[0]!.init)).toBe("Bearer a-t1");
    expect(JSON.parse(String(seen[0]!.init.body))).toMatchObject({ model: "model-text", stream: false });
    await instance.dispose();
  });
});

describe("E104/E105 DuMate turns", () => {
  const stream = (frames: unknown[], done = true) => new Response(
    frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""),
    { status: 200, headers: { "content-type": "text/event-stream" } });
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
  const turn = async (frames: unknown[]) => {
    const d = deps([acc("a")], { fetch: (async () => stream(frames)) as never });
    const instance = await createDumateDriver(d).create({
      instanceId: "dumate", displayName: "百度搭子 DuMate", enabled: true, config: decodeDumateConfig({}), environment: {},
    });
    const events: RuntimeEvent[] = [];
    instance.adapter.onEvent((event) => events.push(event));
    await instance.adapter.sendTurn({ threadId: "thread", text: "做个网页" });
    await vi.waitFor(() => { if (!events.some((e) => e.type === "turn.completed")) throw new Error("turn still running"); });
    await instance.dispose();
    const done = events.find((e) => e.type === "turn.completed") as RuntimeEvent & { ok: boolean; stopReason: string | null };
    const replies = events.filter((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_text");
    return { events, done, replies, all: JSON.stringify(events) };
  };

  it("fails a reasoning-only stream that ends with [DONE] but no finish_reason, without showing the draft as the reply", async () => {
    const r = await turn([chunk({ reasoning_content: "Let me think about this task. " }), chunk({ reasoning_content: "I need a three.js page…" })]);
    expect(r.done.ok).toBe(false);
    expect(r.done.stopReason).toBe("truncated");
    expect(r.replies).toHaveLength(0);
    expect(r.all).toContain(TRUNCATED_NO_FINISH);
    // the thinking stays visible as thinking
    expect(r.events.some((e) => e.type === "content.delta" && (e as { streamKind?: string }).streamKind === "reasoning_text")).toBe(true);
  });

  it("fails a round whose text was cut at the length limit, before showing it", async () => {
    const r = await turn([chunk({ content: "<html><body>半截" }), chunk({}, "length")]);
    expect(r.done.ok).toBe(false);
    expect(r.replies).toHaveLength(0);
    expect(r.all).toContain(TRUNCATED_LENGTH);
  });

  it("never turns reasoning into the answer even when the round stopped normally", async () => {
    const r = await turn([chunk({ reasoning_content: "只是在想" }), chunk({}, "stop")]);
    expect(r.done.ok).toBe(false);
    expect(r.replies).toHaveLength(0);
    expect(r.all).toContain(REASONING_ONLY);
  });

  it("still answers a normal round with content and stop", async () => {
    const r = await turn([chunk({ reasoning_content: "想一下" }), chunk({ content: "做好了" }), chunk({}, "stop")]);
    expect(r.done.ok).toBe(true);
    expect(r.replies.map((e) => (e as { text?: string }).text)).toEqual(["做好了"]);
  });

  it("works on this computer like other chat engines: computer tools on, images never sent to the gateway", async () => {
    const instance = await createDumateDriver(deps([acc("a")])).create({
      instanceId: "dumate", displayName: "百度搭子 DuMate", enabled: true, config: decodeDumateConfig({}), environment: {},
    });
    expect(instance.adapter.capabilities).toMatchObject({ localComputerMcp: true, computerMcp: true, browserMcp: true });
    const off = await createDumateDriver(deps([acc("a")])).create({
      instanceId: "dumate", displayName: "百度搭子 DuMate", enabled: true, config: decodeDumateConfig({ tools: false }), environment: {},
    });
    expect(off.adapter.capabilities.localComputerMcp).toBe(false);
    await instance.dispose(); await off.dispose();
  });
});
