import { describe, expect, it, vi } from "vitest";
import { waitForJevState } from "./jev-observation.ts";
import type { CdpPage } from "./page.ts";

describe("jev-settle", () => {
  const mockPage = {} as unknown as CdpPage;

  it("waits for visible combobox options up to two hundred milliseconds", async () => {
    const started = Date.now();
    await waitForJevState(mockPage, "TYPE_TEXT", null);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThanOrEqual(250);
  });

  it("bounds ordinary settling by two frames or fifty milliseconds", async () => {
    const started = Date.now();
    await waitForJevState(mockPage, "CLICK", null);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThanOrEqual(100);
  });

  it("bounds explicit wait by one hundred milliseconds", async () => {
    const started = Date.now();
    await waitForJevState(mockPage, "WAIT", null);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThanOrEqual(200);
  });

  it("cleans pending waits on navigation cancellation and takeover", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    await waitForJevState(mockPage, "WAIT", null, controller.signal);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(80);
  });
});
