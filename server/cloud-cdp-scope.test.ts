// A scoped DevTools connection is what keeps two agent-browser sessions off the same tab of a shared cloud Chrome, so
// these tests stand a registry and a view on their own: which scope owns which page, and which messages a session is
// allowed to hear about them. Nothing here starts a browser, so the suite stays fast and offline.
import { describe, expect, it, vi } from "vitest";

import { ScopeRegistry, ScopeView, cdpUrlPort, scopeOfPath, scopedCdpUrl } from "./cloud-cdp-scope.ts";

/** A registry whose page closes are only recorded, with a grace short enough to reason about. */
function registryOf(closed: string[], graceMs = 30_000, log?: (line: string) => void): ScopeRegistry {
  return new ScopeRegistry({ graceMs, closeTarget: async (targetId) => { closed.push(targetId); }, log });
}

/** One connection's view of a scope, with the connection already counted. */
function viewOf(scope: string, closed: string[] = []): { view: ScopeView; scopes: ScopeRegistry } {
  const scopes = registryOf(closed);
  const view = new ScopeView(scope, scopes);
  scopes.join(scope);
  return { view, scopes };
}

const targetInfo = (targetId: string, type = "page", openerId?: string): Record<string, unknown> =>
  ({ targetId, type, ...(openerId === undefined ? {} : { openerId }) });

describe("a scoped DevTools address", () => {
  it("puts the session's name in the path of the door it was given", () => {
    expect(scopedCdpUrl("http://127.0.0.1:9341", "agent-browser-7")).toBe("ws://127.0.0.1:9341/devtools/browser/omb-scope/agent-browser-7");
    expect(scopedCdpUrl("https://door.example", "omb_1.2-3")).toBe("wss://door.example/devtools/browser/omb-scope/omb_1.2-3");
  });

  it("refuses a name that is not a session name", () => {
    for (const scope of ["", "a b", "a/b", "a%2Fb", "a".repeat(161), "scope\n"]) {
      expect(() => scopedCdpUrl("http://127.0.0.1:9341", scope)).toThrow(/not a scope name/);
    }
  });

  it("reads the scope out of an upgrade path, and nothing out of any other path", () => {
    expect(scopeOfPath("/devtools/browser/omb-scope/alpha")).toBe("alpha");
    expect(scopeOfPath("/devtools/browser/omb-scope/alpha?token=1")).toBe("alpha");
    expect(scopeOfPath("/devtools/browser/omb-scope/omb_1.2-3")).toBe("omb_1.2-3");
    expect(scopeOfPath("/devtools/browser/B1")).toBeNull();
    expect(scopeOfPath("/devtools/browser/omb-scope/")).toBeNull();
    expect(scopeOfPath("/devtools/browser/omb-scopex/alpha")).toBeNull();
    expect(scopeOfPath("/json/version")).toBeNull();
  });

  it("names the port a DevTools address is reached on", () => {
    expect(cdpUrlPort("http://127.0.0.1:9341/json/version")).toBe(9341);
    expect(cdpUrlPort("ws://127.0.0.1:9335/devtools/browser/X")).toBe(9335);
    expect(cdpUrlPort("ws://door.example/devtools/browser/omb-scope/a")).toBe(80);
    expect(cdpUrlPort("https://door.example/devtools/browser/omb-scope/a")).toBe(443);
    expect(cdpUrlPort("http://127.0.0.1:0/x")).toBeNull();
    expect(cdpUrlPort(undefined)).toBeNull();
    expect(cdpUrlPort("not an address")).toBeNull();
  });
});

describe("ScopeRegistry", () => {
  it("closes every page of a scope once its last connection is gone", async () => {
    vi.useFakeTimers();
    try {
      const closed: string[] = [];
      const scopes = registryOf(closed, 1000);
      scopes.join("alpha");
      scopes.add("alpha", "T1");
      scopes.add("alpha", "T2");
      scopes.leave("alpha");
      await vi.advanceTimersByTimeAsync(999);
      expect(closed).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(closed).toEqual(["T1", "T2"]);
      expect(scopes.targets("alpha")).toEqual([]);
      expect(scopes.owns("alpha", "T1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a scope's pages when a connection comes back inside the grace", async () => {
    vi.useFakeTimers();
    try {
      const closed: string[] = [];
      const scopes = registryOf(closed, 1000);
      scopes.join("alpha");
      scopes.add("alpha", "T1");
      scopes.leave("alpha");
      await vi.advanceTimersByTimeAsync(900);
      scopes.join("alpha");
      scopes.leave("alpha");
      await vi.advanceTimersByTimeAsync(900);
      expect(closed).toEqual([]);
      await vi.advanceTimersByTimeAsync(100);
      expect(closed).toEqual(["T1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the rest of a scope's pages when one of them refuses to close", async () => {
    vi.useFakeTimers();
    try {
      const closed: string[] = [];
      const lines: string[] = [];
      const scopes = new ScopeRegistry({
        graceMs: 0,
        closeTarget: async (targetId) => { if (targetId === "T2") throw new Error("already gone"); closed.push(targetId); },
        log: (line) => lines.push(line),
      });
      scopes.add("alpha", "T1");
      scopes.add("alpha", "T2");
      scopes.add("alpha", "T3");
      scopes.join("alpha");
      scopes.leave("alpha");
      await vi.advanceTimersByTimeAsync(1);
      expect(closed).toEqual(["T1", "T3"]);
      expect(lines.join("\n")).toContain("T2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets a page in every scope that owned it, and stops pending closes when the proxy closes", async () => {
    vi.useFakeTimers();
    try {
      const closed: string[] = [];
      const scopes = registryOf(closed, 1000);
      scopes.add("alpha", "T1");
      scopes.add("beta", "T1");
      scopes.forget("T1");
      expect(scopes.targets("alpha")).toEqual([]);
      expect(scopes.targets("beta")).toEqual([]);
      scopes.join("alpha");
      scopes.add("alpha", "T2");
      scopes.leave("alpha");
      scopes.close();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(closed).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ScopeView", () => {
  it("passes a scope's own page and any non-page target, and drops another session's page", () => {
    const { view, scopes } = viewOf("alpha");
    scopes.add("alpha", "T1");
    expect(view.filterUpstream({ method: "Target.targetCreated", params: { targetInfo: targetInfo("T1") } })).toBe("pass");
    expect(view.filterUpstream({ method: "Target.targetInfoChanged", params: { targetInfo: targetInfo("T1") } })).toBe("pass");
    expect(view.filterUpstream({ method: "Target.targetCreated", params: { targetInfo: targetInfo("W1", "service_worker") } })).toBe("pass");
    expect(view.filterUpstream({ method: "Target.targetCreated", params: { targetInfo: targetInfo("T9") } })).toBe("drop");
    expect(view.isForeign("T9")).toBe(true);
    expect(view.isForeign("T1")).toBe(false);
  });

  it("adopts a popup of one of the scope's own pages", () => {
    const { view, scopes } = viewOf("alpha");
    scopes.add("alpha", "T1");
    expect(view.filterUpstream({ method: "Target.targetCreated", params: { targetInfo: targetInfo("T5", "page", "T1") } })).toBe("pass");
    expect(scopes.owns("alpha", "T5")).toBe(true);
    expect(view.isForeign("T5")).toBe(false);
  });

  it("forgets a page the scope owned when it goes, and drops a stranger's", () => {
    const { view, scopes } = viewOf("alpha");
    scopes.add("alpha", "T1");
    view.filterUpstream({ method: "Target.targetCreated", params: { targetInfo: targetInfo("T9") } });
    expect(view.filterUpstream({ method: "Target.targetDestroyed", params: { targetId: "T9" } })).toBe("drop");
    expect(view.isForeign("T9")).toBe(false);
    expect(view.filterUpstream({ method: "Target.targetDestroyed", params: { targetId: "T1" } })).toBe("pass");
    expect(scopes.owns("alpha", "T1")).toBe(false);
    expect(view.filterUpstream({ method: "Target.targetCrashed", params: { targetId: "T7" } })).toBe("pass");
  });

  it("holds the pages named while its own createTarget is on its way, and keeps only its own", () => {
    const { view, scopes } = viewOf("alpha");
    scopes.add("alpha", "T1");
    view.beginCreate();
    expect(view.filterUpstream({ method: "Target.targetCreated", params: { targetInfo: targetInfo("T4") } })).toBe("hold");
    expect(view.filterUpstream({ method: "Target.targetCreated", params: { targetInfo: targetInfo("T8") } })).toBe("hold");
    const mine = view.endCreate("T4");
    expect(mine.map((message) => String((message.params as { targetInfo?: { targetId?: unknown } }).targetInfo?.targetId))).toEqual(["T4"]);
    expect(scopes.owns("alpha", "T4")).toBe(true);
    expect(view.isForeign("T8")).toBe(true);
    expect(view.filterUpstream({ method: "Target.targetCreated", params: { targetInfo: targetInfo("T8") } })).toBe("drop");
  });

  it("filters a page list down to the scope's own pages", () => {
    const { view, scopes } = viewOf("alpha");
    scopes.add("alpha", "T1");
    scopes.add("alpha", "T5");
    const infos = [targetInfo("T1"), targetInfo("T9"), targetInfo("W1", "service_worker"), targetInfo("T5")];
    expect(view.filterTargetInfos(infos).map((info) => String(info.targetId))).toEqual(["T1", "W1", "T5"]);
  });

  it("passes a session's own messages and everything that is not about a target", () => {
    const { view } = viewOf("alpha");
    expect(view.filterUpstream({ method: "Target.targetCreated", sessionId: "S1", params: { targetInfo: targetInfo("T9") } })).toBe("pass");
    expect(view.filterUpstream({ method: "Page.frameNavigated", params: { frame: { id: "F1" } } })).toBe("pass");
    expect(view.filterUpstream({ method: "Target.targetInfoChanged", params: {} })).toBe("pass");
    expect(view.filterUpstream({})).toBe("pass");
  });
});
