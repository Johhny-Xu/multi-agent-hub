// 8801 侧：hub 的进度行回到发令线程时的行为。
// 关键点：写进去的是 bot 行，不是人的行——只有人的行才会让发令 bot 起新一轮回合。
import { describe, expect, it } from "vitest";

import { appendOriginLine } from "./hub-bridge.ts";

function fakeStore(threads: Record<string, string> = { "thread-1": "bot-1" }) {
  const appended: Array<{ threadId: string; message: Record<string, unknown> }> = [];
  const patched: Array<{ botId: string; threadId: string; patch: Record<string, unknown> }> = [];
  return {
    appended,
    patched,
    store: {
      botByThread: (threadId: string) => (threads[threadId] ? { id: threads[threadId] } : undefined),
      appendMessage: (threadId: string, message: Record<string, unknown>) => {
        appended.push({ threadId, message });
        return { id: "line-1" };
      },
      patchTask: (botId: string, threadId: string, patch: Record<string, unknown>) => {
        patched.push({ botId, threadId, patch });
      },
    },
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
