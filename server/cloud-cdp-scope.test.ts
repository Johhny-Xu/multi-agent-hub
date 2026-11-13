// A scoped DevTools connection is what keeps two agent-browser sessions off the same tab of a shared cloud Chrome, so
// these tests stand a registry and a view on their own: which scope owns which page, and which messages a session is
// allowed to hear about them. Nothing here starts a browser, so the suite stays fast and offline.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import type { CloudBrowserDeps } from "./cloud-browser.ts";
import { CdpProxy, type CdpProxyOptions } from "./cloud-cdp-proxy.ts";
import { ScopeRegistry, ScopeView, cdpUrlPort, scopeOfPath, scopedCdpUrl } from "./cloud-cdp-scope.ts";
import type { AppConfig } from "./config.ts";
import { FALLBACK_PROXY_PORT, MYCHROME_PROXY_PORT, createCloudOffload } from "./host/cloud-offload.ts";

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

/** A stand-in upstream Chrome for the state-file tests: records closes, names a browser endpoint, opens pages. */
async function upstreamOf(): Promise<{ base: string; closed: string[]; close(): Promise<void> }> {
  const closed: string[] = [];
  let next = 0;
  let port = 0;
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/BROWSER` }));
    } else if (path.startsWith("/json/close/")) {
      closed.push(decodeURIComponent(path.slice("/json/close/".length)));
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Target is closing");
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as { id?: number; method?: string };
      if (message.method !== "Target.createTarget" || message.id === undefined) return;
      const targetId = `T${++next}`;
      // Real Chrome names the page before it answers, the order the proxy's held-event path expects.
      socket.send(JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: { targetId, type: "page" } } }));
      socket.send(JSON.stringify({ id: message.id, result: { targetId } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  port = address !== null && typeof address === "object" ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    closed,
    close: async () => {
      for (const socket of wss.clients) socket.close();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

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

  it("writes the owned pages on every add and forget, once per page however many scopes own it", () => {
    const saved: string[][] = [];
    const scopes = new ScopeRegistry({ closeTarget: async () => {}, persist: { load: () => [], save: (ids) => { saved.push(ids); } } });
    scopes.add("alpha", "T1");
    scopes.add("alpha", "T2");
    expect(saved.at(-1)).toEqual(["T1", "T2"]);
    scopes.add("beta", "T1");
    expect(saved.at(-1)).toEqual(["T1", "T2"]);
    scopes.forget("T1");
    expect(saved.at(-1)).toEqual(["T2"]);
  });

  it("writes an empty list once a departed scope's pages are closed", async () => {
    vi.useFakeTimers();
    try {
      const saved: string[][] = [];
      const closed: string[] = [];
      const scopes = new ScopeRegistry({ graceMs: 1000, closeTarget: async (id) => { closed.push(id); }, persist: { load: () => [], save: (ids) => { saved.push(ids); } } });
      scopes.join("alpha");
      scopes.add("alpha", "T1");
      scopes.leave("alpha");
      await vi.advanceTimersByTimeAsync(1000);
      expect(closed).toEqual(["T1"]);
      expect(saved.at(-1)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes only the recorded pages no scope owns, and only on the first call", async () => {
    const saved: string[][] = [];
    const closed: string[] = [];
    const scopes = new ScopeRegistry({ closeTarget: async (id) => { closed.push(id); }, persist: { load: () => ["X", "Y", "Z"], save: (ids) => { saved.push(ids); } } });
    scopes.add("alpha", "Y");
    expect(await scopes.closeOrphans()).toBe(2);
    expect(closed).toEqual(["X", "Z"]);
    expect(saved.at(-1)).toEqual(["Y"]);
    expect(await scopes.closeOrphans()).toBe(0);
    expect(closed).toEqual(["X", "Z"]);
  });

  it("keeps closing orphaned pages when one of them refuses to close", async () => {
    const closed: string[] = [];
    const lines: string[] = [];
    const scopes = new ScopeRegistry({
      closeTarget: async (id) => { if (id === "X") throw new Error("already gone"); closed.push(id); },
      log: (line) => { lines.push(line); },
      persist: { load: () => ["X", "Z"], save: () => {} },
    });
    expect(await scopes.closeOrphans()).toBe(2);
    expect(closed).toEqual(["Z"]);
    expect(lines.join("\n")).toContain("X");
  });

  it("survives a persist that cannot read or write", async () => {
    const lines: string[] = [];
    const scopes = new ScopeRegistry({
      closeTarget: async () => {},
      log: (line) => { lines.push(line); },
      persist: { load: () => { throw new Error("unreadable"); }, save: () => { throw new Error("read-only"); } },
    });
    expect(await scopes.closeOrphans()).toBe(0);
    expect(() => scopes.add("alpha", "T1")).not.toThrow();
    expect(lines.join("\n")).toContain("read-only");
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

describe("a scope state file beside the proxy", () => {
  it("closes the pages a previous proxy left recorded, and nothing the file never named", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cdp-scope-state-"));
    const file = join(dir, "scoped-pages.json");
    writeFileSync(file, JSON.stringify(["OLD1", "OLD2", "../bad"]));
    const upstream = await upstreamOf();
    const proxy = new CdpProxy({ upstream: upstream.base, port: 0, host: "127.0.0.1", scopeStateFile: file, log: () => {} });
    try {
      await proxy.start();
      await vi.waitFor(() => {
        expect(upstream.closed).toEqual(["OLD1", "OLD2"]);
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
      }, { timeout: 3000 });
    } finally {
      await proxy.close();
      await upstream.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a scoped connection's new page in the state file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cdp-scope-state-"));
    const file = join(dir, "scoped-pages.json");
    const upstream = await upstreamOf();
    const proxy = new CdpProxy({ upstream: upstream.base, port: 0, host: "127.0.0.1", scopeStateFile: file, log: () => {} });
    try {
      const port = await proxy.start();
      const socket = new WebSocket(scopedCdpUrl(`http://127.0.0.1:${port}`, "alpha"));
      await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
      socket.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: "https://example.com" } }));
      await vi.waitFor(() => {
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(["T1"]);
      }, { timeout: 3000 });
      socket.close();
    } finally {
      await proxy.close();
      await upstream.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the offload doors' scope state files", () => {
  it("gives every door its own file under the guard folder", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-scope-doors-"));
    const options: CdpProxyOptions[] = [];
    const bots = [{ id: "b1", computer: null, tasks: [{ threadId: "t1" }] }];
    const store = { bots, bot: (id: string) => bots.find((bot) => bot.id === id), patchTask: () => null };
    const cloud = (ok: boolean): CloudBrowserDeps => ({
      now: () => 0,
      ensureRemote: async () => ok ? { ok: true, load: 0.02 } : { ok: false, detail: "no Chrome" },
      ensureTunnel: async () => true,
      probe: async () => true,
    });
    const offloadOf = (ok: boolean, profiles?: Array<{ id: string; browser: string }>) => createCloudOffload({
      cfg: { vps: { instances: [{ id: "i1", name: "cloudA", kind: "ssh", sshAlias: "cloudA" }] }, ...(profiles === undefined ? {} : { browserProfiles: profiles }) } as unknown as AppConfig,
      dataDir,
      store: () => store as never,
      cloud: cloud(ok),
      log: () => {},
      makeProxy: (proxyOptions) => {
        options.push(proxyOptions);
        return { start: async () => proxyOptions.port, close: async () => {}, url: `http://127.0.0.1:${proxyOptions.port}`, connections: () => 0 };
      },
      fallback: () => ({ ensure: async () => null, touch: () => {}, stop: async () => {}, startIdleSweep: () => () => {} }),
    });
    try {
      await offloadOf(true).browserFor("b1", "sess", "t1", "mychrome");
      await offloadOf(false, [{ id: "mychrome", browser: "chrome" }]).browserFor("b1", "sess", "t1", "mychrome");
      await offloadOf(false).browserFor("b1", "sess", "t1", "builtin");
      expect(options).toHaveLength(3);
      const guardDir = join(dataDir, "cloud-offload");
      const byPort = new Map(options.map((option) => [option.port, option.scopeStateFile]));
      expect(byPort.get(9341)).toBe(join(guardDir, "scoped-pages-9341.json"));
      expect(byPort.get(MYCHROME_PROXY_PORT)).toBe(join(guardDir, `scoped-pages-${MYCHROME_PROXY_PORT}.json`));
      expect(byPort.get(FALLBACK_PROXY_PORT)).toBe(join(guardDir, `scoped-pages-${FALLBACK_PROXY_PORT}.json`));
      expect(new Set(byPort.values()).size).toBe(3);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
