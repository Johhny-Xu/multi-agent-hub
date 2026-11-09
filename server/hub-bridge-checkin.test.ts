// The check-in routes the Daily page calls: they run in this process (server/checkin), so the bridge must answer
// them even when the console is down. The check-in module itself is stubbed; what is under test is the dispatch
// through server/checkin/routes.ts and the bridge, not the check-ins.
import { describe, expect, it, vi } from "vitest";
import type { Store } from "./store.ts";

type BridgeStore = Pick<Store, "appendMessage" | "botByThread" | "patchTask">;

const checkin = vi.hoisted(() => ({
  OPEN_SOURCE_PROJECTS: { workbuddy: [], codebuddy: [], traecode: [], codearts: [], qoder: [] },
  clearCheckinHistory: vi.fn(async () => ({ ok: true })),
  getCheckinOverview: vi.fn(async () => ({ ok: true, today: "2026-11-08", platforms: {} })),
  runCheckin: vi.fn(async (target: string) => ({ ok: true, target, results: {} })),
  startAutoCheckinScheduler: vi.fn(),
  updateCheckinConfig: vi.fn(async (body: Record<string, unknown>) => ({ ok: true, ...body })),
}));

vi.mock("./checkin/checkin.mjs", () => checkin);

import { PASS } from "./routes/table.ts";
import { createHubBridgeRoutes } from "./hub-bridge.ts";
import { ensureCheckinScheduler } from "./checkin/routes.ts";

const store: BridgeStore = {
  appendMessage: () => ({ id: "line-1", at: 0, role: "bot", kind: "text" }),
  botByThread: () => null,
  patchTask: () => null,
};

async function call(route: ReturnType<typeof createHubBridgeRoutes>, init: {
  path: string;
  method: string;
  body?: Record<string, unknown>;
}) {
  const answers: Array<{ status: number; body: unknown }> = [];
  const res = {} as never;
  const outcome = await route({
    req: {} as never,
    res,
    url: new URL(`http://127.0.0.1:8801${init.path}`),
    path: init.path,
    method: init.method,
    auth: {} as never,
    json: ((_res: never, status: number, body: unknown) => {
      answers.push({ status, body });
      return res;
    }) as never,
    readBody: (async () => init.body ?? {}) as never,
  });
  return { outcome, answers };
}

describe("starting the auto check-in scheduler", () => {
  it("starts it once however often it is asked", () => {
    expect(checkin.startAutoCheckinScheduler).not.toHaveBeenCalled();
    ensureCheckinScheduler();
    ensureCheckinScheduler();
    expect(checkin.startAutoCheckinScheduler).toHaveBeenCalledTimes(1);
  });
});

describe("the hub bridge check-in routes", () => {
  it("answers a status read from the in-process API, on both prefixes", async () => {
    const route = createHubBridgeRoutes({ store });
    for (const path of ["/hub/checkin/status", "/api/checkin/status"]) {
      checkin.getCheckinOverview.mockClear();
      const { outcome, answers } = await call(route, { path, method: "GET" });
      expect(outcome).not.toBe(PASS);
      expect(answers[0]?.status).toBe(200);
      expect(answers[0]?.body).toMatchObject({ ok: true });
      expect(checkin.getCheckinOverview).toHaveBeenCalledTimes(1);
    }
  });

  it("hands the run target from the body to the API, defaulting to every platform", async () => {
    const route = createHubBridgeRoutes({ store });
    await call(route, { path: "/hub/checkin/run", method: "POST", body: { platform: "qoder-cn" } });
    expect(checkin.runCheckin).toHaveBeenLastCalledWith("qoder-cn");
    await call(route, { path: "/hub/checkin/run", method: "POST", body: {} });
    expect(checkin.runCheckin).toHaveBeenLastCalledWith("all");
  });

  it("executes single platform check-in via POST /hub/checkin/run and returns result", async () => {
    const route = createHubBridgeRoutes({ store });
    checkin.runCheckin.mockResolvedValueOnce({
      ok: true,
      target: "workbuddy",
      results: { workbuddy: { ok: true, status: "success", message: "2 个账号已完成" } },
    });
    const { outcome, answers } = await call(route, {
      path: "/hub/checkin/run",
      method: "POST",
      body: { platform: "workbuddy" },
    });
    expect(outcome).not.toBe(PASS);
    expect(answers[0]?.status).toBe(200);
    expect(answers[0]?.body).toMatchObject({
      ok: true,
      target: "workbuddy",
      results: { workbuddy: { ok: true, status: "success" } },
    });
    expect(checkin.runCheckin).toHaveBeenLastCalledWith("workbuddy");
  });

  it("passes the config body through and clears history", async () => {
    const route = createHubBridgeRoutes({ store });
    await call(route, { path: "/hub/checkin/config", method: "POST", body: { autoCheckin: false } });
    expect(checkin.updateCheckinConfig).toHaveBeenCalledWith({ autoCheckin: false });
    await call(route, { path: "/hub/checkin/history/clear", method: "POST" });
    expect(checkin.clearCheckinHistory).toHaveBeenCalledTimes(1);
  });

  it("refuses a wrong method on a known route", async () => {
    const route = createHubBridgeRoutes({ store });
    const { answers } = await call(route, { path: "/hub/checkin/status", method: "POST" });
    expect(answers[0]?.status).toBe(405);
    expect(answers[0]?.body).toMatchObject({ ok: false });
  });

  it("declines an unknown check-in path so other routes still see it", async () => {
    const route = createHubBridgeRoutes({ store });
    const { outcome } = await call(route, { path: "/hub/checkin/unknown", method: "GET" });
    expect(outcome).toBe(PASS);
  });

  it("reports a failed run as a 500 instead of dying", async () => {
    const route = createHubBridgeRoutes({ store });
    checkin.runCheckin.mockRejectedValueOnce(new Error("upstream broke"));
    const { answers } = await call(route, { path: "/hub/checkin/run", method: "POST", body: { platform: "all" } });
    expect(answers[0]?.status).toBe(500);
    expect(answers[0]?.body).toMatchObject({ ok: false, error: "upstream broke" });
  });
});
