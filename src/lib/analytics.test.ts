import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Counts evaluations of posthog-js: product telemetry is gone, so a session must leave it at 0 and send nothing.
const ph = vi.hoisted(() => ({ loads: 0 }));
vi.mock("posthog-js", () => { ph.loads += 1; return { default: {} }; });

const store = new Map<string, string>();
const baseStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};
vi.stubGlobal("localStorage", baseStorage);

beforeEach(() => { store.clear(); ph.loads = 0; });
afterEach(() => vi.unstubAllGlobals());

async function freshAnalytics() {
  vi.resetModules();
  vi.doMock("posthog-js", () => { ph.loads += 1; return { default: {} }; });
  return import("./analytics");
}

it("is off for a fresh install, after a saved choice, and with any old stored value", async () => {
  const fresh = await freshAnalytics();
  expect(fresh.analyticsEnabled()).toBe(false);
  fresh.setAnalyticsEnabled(true);
  expect(fresh.analyticsEnabled(), "a preference cannot turn it back on").toBe(false);
  store.set("omb-analytics-opt-out", "0");
  expect((await freshAnalytics()).analyticsEnabled()).toBe(false);
  store.set("omb-analytics-opt-out", "1");
  expect((await freshAnalytics()).analyticsEnabled()).toBe(false);
});

it("ignores a desktop switch that an older main would answer", async () => {
  const fresh = await freshAnalytics();
  vi.stubGlobal("window", { ogb: { desktopAnalytics: { enabled: () => true } } });
  try { expect(fresh.analyticsEnabled()).toBe(false); } finally { vi.unstubAllGlobals(); vi.stubGlobal("localStorage", baseStorage); }
});

it("never loads posthog-js, whatever is persisted or passed to init", async () => {
  const fresh = await freshAnalytics();
  store.set("omb-analytics-opt-out", "0");
  store.set("omb-installed", new Date().toISOString());
  await expect(fresh.initAnalytics()).resolves.toBeUndefined();
  fresh.track("app_snapshot", { bots: 3 });
  fresh.setAnalyticsEnabled(false);
  fresh.setAnalyticsEnabled(true);
  expect(ph.loads).toBe(0);
  expect(store.get("omb-analytics-active-day")).toBeUndefined();
});

it("App mounts no analytics init and no usage snapshot", () => {
  const app = readFileSync("src/App.tsx", "utf8");
  expect(app).not.toContain("useUsageSnapshot");
  expect(app).not.toContain("initAnalytics(");
});
