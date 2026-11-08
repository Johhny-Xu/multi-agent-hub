import { describe, expect, it } from "vitest";

import type { VpsInstanceView } from "../../shared/vps";
import { setLocale } from "./i18n";
import {
  checkVpsInstances,
  vpsCanCheck,
  vpsCheckedAtText,
  vpsDotState,
  vpsMergedRows,
  vpsRowAfterCheck,
  vpsRowAfterCheckFailure,
  vpsRowsToAutoCheck,
  vpsStatusLine,
  vpsUnsavedMessage,
} from "./vps-status";

const view = (id: string, name: string, extra: Partial<VpsInstanceView> = {}): VpsInstanceView => ({
  id,
  name,
  kind: "ssh",
  configured: true,
  available: null,
  capabilities: { status: true, join: true, screenshot: true, start: true, stop: true, remove: true },
  ...extra,
});

describe("VPS status line", () => {
  it("names the four states a computer can be in", () => {
    expect(vpsDotState(view("a", "Alpha"))).toBe("unknown");
    expect(vpsDotState(view("a", "Alpha", { online: true }))).toBe("online");
    expect(vpsDotState(view("a", "Alpha", { online: false }))).toBe("offline");
    expect(vpsDotState(view("a", "Alpha", { online: true }), true)).toBe("checking");
  });

  it("shows the round trip of an online computer", () => {
    setLocale("en");
    expect(vpsStatusLine(view("a", "Alpha", { online: true, latencyMs: 42 }))).toBe("Online · 42 ms");
    expect(vpsStatusLine(view("a", "Alpha", { online: true }))).toBe("Online");
  });

  it("shows why an offline computer is offline", () => {
    setLocale("en");
    expect(vpsStatusLine(view("a", "Alpha", { online: false, reason: "timeout" }))).toBe("Offline · The check timed out.");
    expect(vpsStatusLine(view("a", "Alpha", { online: false, error: "The host did not answer." }))).toBe("Offline · The host did not answer.");
  });

  it("says a computer that was never checked", () => {
    setLocale("en");
    expect(vpsStatusLine(view("a", "Alpha"))).toBe("Not checked");
    expect(vpsStatusLine(view("a", "Alpha", { online: true }), true)).toBe("Checking…");
  });

  it("speaks the page's language", () => {
    setLocale("zh");
    expect(vpsStatusLine(view("a", "Alpha", { online: true, latencyMs: 42 }))).toBe("在线 · 42 毫秒");
    expect(vpsStatusLine(view("a", "Alpha", { online: false, reason: "timeout" }))).toBe("离线 · 检测超时。");
    setLocale("en");
  });

  it("shows when the last check ran", () => {
    setLocale("en");
    expect(vpsCheckedAtText("2026-11-08T10:00:00.000Z")).toMatch(/^Checked /);
    expect(vpsCheckedAtText(undefined)).toBe("");
    expect(vpsCheckedAtText("not a time")).toBe("");
  });
});

describe("VPS list rows", () => {
  it("keeps the last answer of each computer on the list the server sends", () => {
    const rows = [view("a", "Alpha"), view("b", "Beta")];
    const local = [view("a", "Alpha", { online: true, latencyMs: 42, checkedAt: "2026-11-08T10:00:00.000Z" })];
    const merged = vpsMergedRows(rows, local);
    expect(merged[0]).toMatchObject({ name: "Alpha", online: true, latencyMs: 42 });
    expect(merged[1]).toMatchObject({ name: "Beta" });
    expect(merged[1]?.online).toBeUndefined();
  });

  it("takes the name from the server and keeps a computer that is only local", () => {
    const rows = [view("a", "Alpha")];
    const local = [view("a", "Alpha renamed", { online: true }), view("c", "Gamma")];
    const merged = vpsMergedRows(rows, local);
    expect(merged[0]).toMatchObject({ name: "Alpha", online: true });
    expect(merged.map((entry) => entry.id)).toEqual(["a", "c"]);
  });

  it("puts one check's answer on that row alone", () => {
    const rows = [view("a", "Alpha"), view("b", "Beta")];
    const after = vpsRowAfterCheck(rows, "b", view("b", "Beta", { online: true, latencyMs: 42, checkedAt: "2026-11-08T10:00:00.000Z" }));
    expect(after[0]).toMatchObject({ id: "a" });
    expect(after[0]?.online).toBeUndefined();
    expect(after[1]).toMatchObject({ id: "b", online: true, latencyMs: 42 });
  });
});

describe("checking every computer at once", () => {
  it("asks every computer at the same time and reports each answer", async () => {
    const rows = [view("a", "Alpha"), view("b", "Beta"), view("c", "Gamma")];
    let inFlight = 0;
    let peak = 0;
    const asked: string[] = [];
    const results: string[] = [];
    await checkVpsInstances(rows, "rev", async (id) => {
      asked.push(id);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return view(id, id, { online: true, latencyMs: 5 });
    }, (answer) => results.push(answer.id));
    expect(asked.sort()).toEqual(["a", "b", "c"]);
    expect(peak).toBe(3);
    expect(results.sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps the other answers when one computer refuses the check", async () => {
    const rows = [view("a", "Alpha"), view("b", "Beta")];
    const results: string[] = [];
    await checkVpsInstances(rows, "rev", async (id) => {
      if (id === "a") throw new Error("refused");
      return view(id, id, { online: true });
    }, (answer) => results.push(answer.id));
    expect(results).toEqual(["b"]);
  });

  it("reports failure to the failure callback when a computer check fails", async () => {
    const rows = [view("a", "Alpha"), view("b", "Beta")];
    const failed: Array<{ id: string; error: unknown }> = [];
    await checkVpsInstances(
      rows,
      "rev",
      async (id) => {
        if (id === "a") throw new Error("timeout");
        return view(id, id, { online: true });
      },
      undefined,
      (id, reason) => failed.push({ id, error: reason }),
    );
    expect(failed.map((f) => f.id)).toEqual(["a"]);
    expect((failed[0]?.error as Error).message).toBe("timeout");
  });
});

describe("VPS check candidates and failure helpers", () => {
  it("auto-checks only rows actually returned by the server", () => {
    expect(vpsRowsToAutoCheck(null)).toEqual([]);
    expect(vpsRowsToAutoCheck([])).toEqual([]);
    const serverRows = [view("s1", "Server 1"), view("s2", "Server 2")];
    expect(vpsRowsToAutoCheck(serverRows).map((r) => r.id)).toEqual(["s1", "s2"]);
  });

  it("checks whether an instance is saved on the server before checking", () => {
    const saved = new Set(["s1", "s2"]);
    expect(vpsCanCheck(view("s1", "Server 1"), saved)).toBe(true);
    expect(vpsCanCheck(view("local", "Local"), saved)).toBe(false);
    expect(vpsCanCheck(view("s2", "Server 2"), ["s1", "s2"])).toBe(true);
    expect(vpsCanCheck(null, saved)).toBe(false);
  });

  it("provides an unsaved computer message in the active locale", () => {
    setLocale("en");
    expect(vpsUnsavedMessage()).toMatch(/unsaved/i);
    setLocale("zh");
    expect(vpsUnsavedMessage()).toMatch(/尚未保存/);
    setLocale("en");
  });

  it("updates only the target row with failure details after a check fails", () => {
    const rows = [view("a", "Alpha", { online: true, latencyMs: 50 }), view("b", "Beta")];
    const after = vpsRowAfterCheckFailure(rows, "a", new Error("The check timed out."));
    expect(after[0]).toMatchObject({ id: "a", online: false, reason: "timeout", latencyMs: undefined });
    expect(after[0]?.error).toBe("The check timed out.");
    expect(after[0]?.checkedAt).toBeDefined();
    expect(after[1]).toMatchObject({ id: "b" });
    expect(after[1]?.online).toBeUndefined();
  });
});
