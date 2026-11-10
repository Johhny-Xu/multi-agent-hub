// 8801 侧：hub 的进度行回到发令线程时的行为。
// 关键点：写进去的是 bot 行，不是人的行——只有人的行才会让发令 bot 起新一轮回合。
import { describe, expect, it } from "vitest";

import { appendOriginLine } from "./hub-bridge.ts";
import type { BotRecord, Store, TaskPatch } from "./store.ts";

type BridgeStore = Pick<Store, "appendMessage" | "botByThread" | "patchTask">;
type AppendMessageInput = Parameters<BridgeStore["appendMessage"]>[1];

function fakeStore(threads: Record<string, string> = { "thread-1": "bot-1" }) {
  const appended: Array<{ threadId: string; message: AppendMessageInput }> = [];
  const patched: Array<{ botId: string; threadId: string; patch: TaskPatch }> = [];
  const store: BridgeStore = {
    botByThread: (threadId) => (threads[threadId] ? ({ id: threads[threadId] } as BotRecord) : null),
    appendMessage: (threadId, message) => {
      appended.push({ threadId, message });
      return { id: "line-1", at: 0, role: "bot", kind: "text" };
    },
    patchTask: (botId, threadId, patch) => {
      patched.push({ botId, threadId, patch });
      return null;
    },
  };
  return {
    appended,
    patched,
    store,
  };
}

describe("appendOriginLine", () => {
  it("writes a bot line into the asking thread", () => {
    const { store, appended, patched } = fakeStore();
    const outcome = appendOriginLine(store, "thread-1", "[hub mmx/mmx-1] 已受理，正在执行。");
    expect(outcome.ok).toBe(true);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.threadId).toBe("thread-1");
    expect(appended[0]?.message.role).toBe("bot");
    expect(appended[0]?.message.kind).toBe("text");
    expect(patched[0]?.botId).toBe("bot-1");
  });

  it("never writes a person's line, so the asking bot is not woken", () => {
    const { store, appended } = fakeStore();
    appendOriginLine(store, "thread-1", "[hub mmx/mmx-1] 完成");
    expect(appended[0]?.message.role).not.toBe("user");
  });

  it("keeps a key or a token out of the line", () => {
    const { store, appended } = fakeStore();
    appendOriginLine(store, "thread-1", "Bearer abcdefgh12345678 sk-abcdefgh12345678");
    const text = String(appended[0]?.message.text ?? "");
    expect(text).not.toContain("abcdefgh12345678");
    expect(text).toContain("[REDACTED]");
  });

  it("refuses a thread it does not know", () => {
    const { store, appended } = fakeStore();
    const outcome = appendOriginLine(store, "thread-x", "hello");
    expect(outcome).toEqual({ ok: false, status: 404, error: "no such thread" });
    expect(appended).toHaveLength(0);
  });

  it("refuses a thread id that is not a task id", () => {
    const { store } = fakeStore();
    const outcome = appendOriginLine(store, "../etc/passwd", "hello");
    expect(outcome.ok).toBe(false);
  });

  it("refuses an empty line", () => {
    const { store } = fakeStore();
    const outcome = appendOriginLine(store, "thread-1", "   ");
    expect(outcome).toEqual({ ok: false, status: 400, error: "text required" });
  });
});

// The route itself: the hub-compat process posts one line into the asking thread.
describe("the hub bridge origin route", () => {
  it("answers a write-back with the line it appended", async () => {
    const { store, appended } = fakeStore();
    const { createHubBridgeRoutes } = await import("./hub-bridge.ts");
    const route = createHubBridgeRoutes({ store });
    const answers: Array<{ status: number; body: unknown }> = [];
    const res = {} as never;
    await route({
      req: {} as never,
      res,
      url: new URL("http://127.0.0.1:8801/api/hub/origin"),
      path: "/api/hub/origin",
      method: "POST",
      auth: {} as never,
      json: ((_res: never, status: number, body: unknown) => { answers.push({ status, body }); return res; }) as never,
      readBody: (async () => ({ threadId: "thread-1", text: "[hub mmx/mmx-1] 已受理，正在执行。" })) as never,
    });
    expect(answers[0]?.status).toBe(201);
    expect(appended[0]?.message.role).toBe("bot");
  });

  it("relays /hub/quota from upstream console when reachable", async () => {
    const { store } = fakeStore();
    const { createHubBridgeRoutes } = await import("./hub-bridge.ts");
    const writtenHeaders: Record<string, unknown> = {};
    let writtenBody = "";
    const res = {
      writeHead: (status: number, headers: Record<string, unknown>) => {
        writtenHeaders.status = status;
        Object.assign(writtenHeaders, headers);
      },
      end: (chunk: Buffer) => {
        writtenBody = chunk.toString("utf-8");
      },
    } as never;
    const fakeUpstream = {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: Buffer.from(JSON.stringify({ updatedAt: "2026-11-08T00:00:00Z", workers: {} })),
    };
    const route = createHubBridgeRoutes({
      store,
      askConsole: async () => fakeUpstream as never,
    });
    await route({
      req: {} as never,
      res,
      url: new URL("http://127.0.0.1:8801/hub/quota"),
      path: "/hub/quota",
      method: "GET",
      auth: {} as never,
      json: (() => res) as never,
      readBody: (async () => ({})) as never,
    });
    expect(writtenHeaders.status).toBe(200);
    expect(JSON.parse(writtenBody)).toEqual({ updatedAt: "2026-11-08T00:00:00Z", workers: {} });
  });

  it("falls back to getAllQuotas on /hub/quota when console is unreachable", async () => {
    const { store } = fakeStore();
    const { createHubBridgeRoutes } = await import("./hub-bridge.ts");
    const answers: Array<{ status: number; body: unknown }> = [];
    const res = {} as never;
    const quotaData = {
      updatedAt: "2026-11-08T12:00:00Z",
      workers: {
        codebuddy: { worker: "codebuddy", plan: "Free Plan", quotas: [{ name: "Monthly", used: 10, total: 100 }] },
      },
    };
    const route = createHubBridgeRoutes({
      store,
      askConsole: async () => null,
      getAllQuotas: async () => quotaData,
      consoleReachable: async () => false,
    });
    await route({
      req: {} as never,
      res,
      url: new URL("http://127.0.0.1:8801/hub/quota"),
      path: "/hub/quota",
      method: "GET",
      auth: {} as never,
      json: ((_res: never, status: number, body: unknown) => { answers.push({ status, body }); return res; }) as never,
      readBody: (async () => ({})) as never,
    });
    expect(answers[0]?.status).toBe(200);
    expect(answers[0]?.body).toEqual(quotaData);
  });

  it("does not fetch quotas itself when the console is up but slow (E39)", async () => {
    const { store } = fakeStore();
    const { createHubBridgeRoutes } = await import("./hub-bridge.ts");
    const answers: Array<{ status: number; body: unknown }> = [];
    const res = {} as never;
    let fetched = 0;
    const route = createHubBridgeRoutes({
      store,
      askConsole: async () => null,
      getAllQuotas: async () => { fetched += 1; return {}; },
      consoleReachable: async () => true,
    });
    await route({
      req: {} as never, res, url: new URL("http://127.0.0.1:8801/hub/quota"), path: "/hub/quota", method: "GET", auth: {} as never,
      json: ((_res: never, status: number, body: unknown) => { answers.push({ status, body }); return res; }) as never,
      readBody: (async () => ({})) as never,
    });
    expect(fetched).toBe(0);
    expect(answers[0]?.status).toBe(504);
    expect(answers[0]?.body).toEqual({ ok: false, error: "console_slow" });
  });

  it("bounds the in-process quota fallback with a total timeout (E39)", async () => {
    const { store } = fakeStore();
    const { createHubBridgeRoutes } = await import("./hub-bridge.ts");
    const answers: Array<{ status: number; body: unknown }> = [];
    const res = {} as never;
    const route = createHubBridgeRoutes({
      store,
      askConsole: async () => null,
      getAllQuotas: () => new Promise(() => {}),
      consoleReachable: async () => false,
      quotaFallbackMs: 20,
    });
    await route({
      req: {} as never, res, url: new URL("http://127.0.0.1:8801/hub/quota"), path: "/hub/quota", method: "GET", auth: {} as never,
      json: ((_res: never, status: number, body: unknown) => { answers.push({ status, body }); return res; }) as never,
      readBody: (async () => ({})) as never,
    });
    expect(answers[0]?.status).toBe(504);
    expect(answers[0]?.body).toEqual({ ok: false, error: "quota_timeout" });
  });

  it("serves the last quotas it got, marked stale, when a later cold fallback runs past its budget (E66)", async () => {
    const { store } = fakeStore();
    const { createHubBridgeRoutes } = await import("./hub-bridge.ts");
    const answers: Array<{ status: number; body: unknown }> = [];
    const res = {} as never;
    const quotaData = { updatedAt: "Tue 2026-11-10 1:40 AM CST (UTC+08:00)", workers: { zcode: { worker: "zcode", quotas: [] } } };
    let calls = 0;
    const route = createHubBridgeRoutes({
      store,
      askConsole: async () => null,
      // first fetch finishes only after the budget (the background result is kept); later ones never finish
      getAllQuotas: () => (calls++ === 0 ? new Promise((resolve) => setTimeout(() => resolve(quotaData), 40)) : new Promise(() => {})),
      consoleReachable: async () => false,
      quotaFallbackMs: 10,
    });
    const ask = () => route({
      req: {} as never, res, url: new URL("http://127.0.0.1:8801/hub/quota"), path: "/hub/quota", method: "GET", auth: {} as never,
      json: ((_res: never, status: number, body: unknown) => { answers.push({ status, body }); return res; }) as never,
      readBody: (async () => ({})) as never,
    });
    await ask();
    expect(answers[0]).toEqual({ status: 504, body: { ok: false, error: "quota_timeout" } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ask();
    expect(answers[1]?.status).toBe(200);
    expect(answers[1]?.body).toEqual({ ...quotaData, stale: true });
  });

  it("returns 502 on /hub/quota when console is unreachable and getAllQuotas fails", async () => {
    const { store } = fakeStore();
    const { createHubBridgeRoutes } = await import("./hub-bridge.ts");
    const answers: Array<{ status: number; body: unknown }> = [];
    const res = {} as never;
    const route = createHubBridgeRoutes({
      store,
      askConsole: async () => null,
      getAllQuotas: async () => { throw new Error("fetch failed"); },
      consoleReachable: async () => false,
    });
    await route({
      req: {} as never,
      res,
      url: new URL("http://127.0.0.1:8801/hub/quota"),
      path: "/hub/quota",
      method: "GET",
      auth: {} as never,
      json: ((_res: never, status: number, body: unknown) => { answers.push({ status, body }); return res; }) as never,
      readBody: (async () => ({})) as never,
    });
    expect(answers[0]?.status).toBe(502);
    expect(answers[0]?.body).toEqual({ ok: false, error: "console_unreachable" });
  });
});

describe("the Doubao QR sign-in routes (FEAT-doubao-checkin)", () => {
  function fakeCheckinApi(loggedIn: boolean) {
    const runs: string[] = [];
    const api = {
      status: async () => ({ ok: true }),
      projects: () => ({ ok: true }),
      run: async (target: string) => { runs.push(target); return { ok: true }; },
      clearHistory: async () => ({ ok: true }),
      config: async () => ({ ok: true }),
      doubaoLoginStart: async () => ({ ok: true, loggedIn: false, qrPng: "iVBORw0K" }),
      doubaoLoginStatus: async () => ({ ok: true, loggedIn }),
    };
    return { api, runs };
  }
  async function call(route: any, method: string, path: string) {
    const answers: Array<{ status: number; body: any }> = [];
    const res = {} as never;
    await route({
      req: {} as never, res, url: new URL(`http://127.0.0.1:8801${path}`), path, method, auth: {} as never,
      json: ((_res: never, status: number, body: unknown) => { answers.push({ status, body }); return res; }) as never,
      readBody: (async () => ({})) as never,
    });
    return answers[0];
  }

  it("starts the sign-in with POST and hands back the cloud browser's QR screenshot", async () => {
    const { store } = fakeStore();
    const { api } = fakeCheckinApi(false);
    const { createHubBridgeRoutes } = await import("./hub-bridge.ts");
    const route = createHubBridgeRoutes({ store, checkinApi: api });
    expect(await call(route, "POST", "/hub/checkin/doubao/login")).toEqual({ status: 200, body: { ok: true, loggedIn: false, qrPng: "iVBORw0K" } });
    expect((await call(route, "GET", "/hub/checkin/doubao/login"))?.status).toBe(405);
  });

  it("signs in for today once after the scan, however many polls notice it", async () => {
    const { store } = fakeStore();
    const { api, runs } = fakeCheckinApi(true);
    const { createHubBridgeRoutes } = await import("./hub-bridge.ts");
    const route = createHubBridgeRoutes({ store, checkinApi: api });
    const [a, b] = await Promise.all([
      call(route, "GET", "/hub/checkin/doubao/login/status"),
      call(route, "GET", "/hub/checkin/doubao/login/status"),
    ]);
    expect(a?.body).toEqual({ ok: true, loggedIn: true });
    expect(b?.body).toEqual({ ok: true, loggedIn: true });
    expect(runs).toEqual(["doubao"]);
  });
});
