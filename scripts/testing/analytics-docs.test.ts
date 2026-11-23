// docs/analytics.md is the promise of what the app sends, and this version sends nothing: the module is a no-op, so the
// test holds the source and both copies of the page to that promise instead of an event table that no longer exists.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");

describe("product telemetry", () => {
  it("stays a no-op: no client, no request, no telemetry preference", async () => {
    const source = read("src/lib/analytics.ts");
    expect(source).not.toMatch(/posthog/i);
    expect(source).not.toMatch(/\bfetch\s*\(|sendBeacon|XMLHttpRequest/);
    expect(source).not.toMatch(/omb-analytics-opt-out/);
    const analytics = await import("../../src/lib/analytics.ts");
    expect(analytics.analyticsEnabled()).toBe(false);
    expect(() => analytics.track("app_opened", { platform: "desktop" })).not.toThrow();
    analytics.setAnalyticsEnabled(true);
    expect(analytics.analyticsEnabled(), "no preference can turn it back on").toBe(false);
  });

  it("says in both copies that telemetry is off and nothing is sent", () => {
    for (const path of ["docs/analytics.md", "apps/docs/content/docs/security/analytics.mdx"]) {
      const docs = read(path);
      expect(docs, path).toContain("**Product telemetry is off.**");
      expect(docs, path).toMatch(/no events, no daily snapshot/i);
      expect(docs, path).toMatch(/loads no third-party analytics client/i);
      expect(docs, path).not.toMatch(/`app_snapshot` is one count/, "no removed event described as sent");
      expect(docs, path).not.toMatch(/\| `app_opened` \|/, "no removed event in a current table");
    }
  });

  it("is the page the docs site shows", () => {
    const docs = read("docs/analytics.md");
    const site = read("apps/docs/content/docs/security/analytics.mdx");
    expect(site.slice(site.indexOf("\n---\n", 3) + "\n---\n".length)).toBe(docs.slice(docs.indexOf("\n") + 1));
  });
});
