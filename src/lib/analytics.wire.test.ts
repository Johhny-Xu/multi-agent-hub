// @vitest-environment happy-dom
// The real network stubs a telemetry client would use: with product telemetry gone, nothing may leave the machine.
import { expect, it, vi } from "vitest";

const sent: string[] = [];
vi.stubGlobal("fetch", async (input: unknown) => { sent.push(String((input as { url?: string })?.url ?? input)); return { status: 200, ok: true }; });
class RecordingXhr {
  withCredentials = false;
  open(_method: string, url: string) { sent.push(url); }
  setRequestHeader() {}
  send() {}
  abort() {}
}
vi.stubGlobal("XMLHttpRequest", RecordingXhr);
Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: (url: string) => (sent.push(url), true) });
vi.stubGlobal("localStorage", {
  getItem: () => "0",
  setItem: () => {},
  removeItem: () => {},
});

it("sends no event, loads no posthog-js and starts no timer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    const analytics = await import("./analytics");
    await analytics.initAnalytics();
    analytics.track("app_snapshot", { bots: 3 });
    analytics.track("app_opened");
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(sent).toEqual([]);
    expect(document.querySelectorAll("script")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    analytics.setAnalyticsEnabled(false);
    analytics.track("after_off");
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(sent).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});
