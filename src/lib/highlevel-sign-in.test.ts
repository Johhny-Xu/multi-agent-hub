import { describe, expect, it, vi } from "vitest";

import { isHighLevelStatus, runHighLevelSignIn, watchHighLevelSignIn } from "./highlevel-sign-in";

const flow = { flowId: "flow-1", authorizationUrl: "https://marketplace.leadconnectorhq.com/v2/oauth/chooselocation?state=abc", expiresAt: "2026-10-15T12:10:00Z" };

/** A fake server: POST starts the flow, each GET answers the next queued status, DELETE cancels. */
function stubApi(statuses: unknown[], started: unknown = flow) {
  const calls: Array<[string, string, string | undefined]> = [];
  const api = vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push([method, path, init?.body]);
    if (method === "POST") return started;
    if (method === "DELETE") return { ok: true };
    const next = statuses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return { api, calls };
}
const noSleep = async () => {};

describe("runHighLevelSignIn", () => {
  it("starts the flow, opens HighLevel's page once, polls until connected", async () => {
    const { api, calls } = stubApi([{ phase: "waiting" }, { phase: "waiting" }, { phase: "connected" }]);
    const open = vi.fn(async () => true);
    const onStarted = vi.fn();
    const result = await runHighLevelSignIn({ api, open, sleep: noSleep, onStarted });
    expect(result).toEqual({ phase: "connected" });
    expect(onStarted).toHaveBeenCalledWith(flow);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(flow.authorizationUrl);
    expect(calls).toEqual([
      ["POST", "/api/highlevel/sign-in", undefined],
      ["GET", "/api/highlevel/sign-in/flow-1", undefined],
      ["GET", "/api/highlevel/sign-in/flow-1", undefined],
      ["GET", "/api/highlevel/sign-in/flow-1", undefined],
    ]);
  });

  it("passes the server's failure message through and treats expiry as its own phase", async () => {
    const failed = stubApi([{ phase: "failed", message: "HighLevel refused the sign-in." }]);
    expect(await runHighLevelSignIn({ api: failed.api, open: async () => true, sleep: noSleep })).toEqual({ phase: "failed", message: "HighLevel refused the sign-in." });
    const expired = stubApi([{ phase: "expired" }]);
    expect(await runHighLevelSignIn({ api: expired.api, open: async () => true, sleep: noSleep })).toEqual({ phase: "expired" });
  });

  it("refuses a sign-in page that is not https and cancels the flow without opening it", async () => {
    const { api, calls } = stubApi([], { ...flow, authorizationUrl: "http://evil.example/login" });
    const open = vi.fn(async () => true);
    const result = await runHighLevelSignIn({ api, open, sleep: noSleep });
    expect(result.phase).toBe("failed");
    expect(open).not.toHaveBeenCalled();
    expect(calls).toContainEqual(["DELETE", "/api/highlevel/sign-in/flow-1", undefined]);
  });

  it("cancels on the server when the person cancels, and stops polling", async () => {
    const { api, calls } = stubApi([{ phase: "waiting" }, { phase: "waiting" }, { phase: "waiting" }]);
    const controller = new AbortController();
    let polls = 0;
    const sleep = async () => { if (++polls === 2) controller.abort(); };
    const result = await runHighLevelSignIn({ api, open: async () => true, sleep, signal: controller.signal });
    expect(result).toEqual({ phase: "cancelled" });
    expect(calls.filter(([method]) => method === "DELETE")).toEqual([["DELETE", "/api/highlevel/sign-in/flow-1", undefined]]);
    expect(calls.filter(([method]) => method === "GET")).toHaveLength(1);
  });

  it("does not wait for a slow page opener before honouring a cancel", async () => {
    const { api, calls } = stubApi([]);
    const controller = new AbortController();
    const open = vi.fn(() => new Promise<boolean>(() => {}));
    const pending = runHighLevelSignIn({ api, open, sleep: noSleep, signal: controller.signal });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    expect(await pending).toEqual({ phase: "cancelled" });
    expect(calls.map(([method]) => method)).toEqual(["POST", "DELETE"]);
  });

  it("reports a failed poll as a failure with the reason, not as success", async () => {
    const { api } = stubApi([{ phase: "waiting" }, new Error("502 Bad Gateway")]);
    const result = await runHighLevelSignIn({ api, open: async () => true, sleep: noSleep });
    expect(result).toEqual({ phase: "failed", message: "502 Bad Gateway" });
  });
});

describe("watchHighLevelSignIn", () => {
  it("follows a flow the server already has without opening the page again", async () => {
    const { api, calls } = stubApi([{ phase: "connected" }]);
    const open = vi.fn(async () => true);
    expect(await watchHighLevelSignIn(flow, { api, open, sleep: noSleep })).toEqual({ phase: "connected" });
    expect(open).not.toHaveBeenCalled();
    expect(calls).toEqual([["GET", "/api/highlevel/sign-in/flow-1", undefined]]);
  });
});

describe("isHighLevelStatus", () => {
  it("accepts the five states and nothing else", () => {
    for (const state of ["unavailable", "signed-out", "connecting", "connected", "needs-sign-in"]) expect(isHighLevelStatus({ state })).toBe(true);
    expect(isHighLevelStatus({ state: "ready" })).toBe(false);
    expect(isHighLevelStatus(null)).toBe(false);
    expect(isHighLevelStatus("connected")).toBe(false);
  });
});
