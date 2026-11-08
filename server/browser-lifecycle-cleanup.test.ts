import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserCleanupCoordinator,
  BrowserSweep,
  browserIdleMs,
  finalizeBrowserCleanupMutation,
  requireBrowserCleanupAcknowledged,
} from "./browser-lifecycle-cleanup.ts";
import { closeBrowserSession, runningBrowserSessionNames } from "./browser-engine.ts";
import { profileDir } from "./browser/chrome/profile.ts";
import { orphanedBrowsers, stopBrowserProcesses, type BrowserProcessTree } from "./browser-processes.ts";

vi.mock("./browser-engine.ts", async (original) => ({
  ...await original<typeof import("./browser-engine.ts")>(),
  closeBrowserSession: vi.fn(async () => true),
  runningBrowserSessionNames: vi.fn(async () => []),
}));
vi.mock("./browser-processes.ts", async (original) => ({
  ...await original<typeof import("./browser-processes.ts")>(),
  orphanedBrowsers: vi.fn(async () => []),
  stopBrowserProcesses: vi.fn(async () => true),
}));

const folders: string[] = [];
const journal = () => {
  const folder = mkdtempSync(join(tmpdir(), "openmaus-browser-cleanup-"));
  folders.push(folder);
  return join(folder, "browser-cleanups.json");
};
/** A HOME whose agent-browser sessions dir the coordinator reads at call time, and the data dir handed to it. */
const stubbedHome = () => {
  const folder = mkdtempSync(join(tmpdir(), "openmaus-browser-cleanup-home-"));
  folders.push(folder);
  vi.stubEnv("HOME", folder);
  return folder;
};
const savedState = (home: string, session: string) =>
  join(home, ".agent-browser", "sessions", `${session}-${session}.json`);

afterEach(() => {
  vi.unstubAllEnvs();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("durable browser lifecycle cleanup", () => {
  it("keeps a deletion journaled until Electron acknowledges the wipe", async () => {
    const file = journal();
    let coordinator!: BrowserCleanupCoordinator;
    coordinator = new BrowserCleanupCoordinator({
      file,
      timeoutMs: 50,
      retryMs: [60_000],
      send(message) {
        const { requestId } = message;
        queueMicrotask(() => coordinator.receive({
          type: "openmausbot:browser-lifecycle-result",
          requestId,
          ok: true,
        }));
        return true;
      },
    });
    const prepared = coordinator.prepare("profile", "work");
    expect(coordinator.hasPendingProfile("work")).toBe(true);
    const request = coordinator.commit(prepared);

    await expect(coordinator.ensure(request)).resolves.toBe(true);
    expect(coordinator.pending()).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
  });

  it("does not report completion without an ACK and blocks profile-id reuse across restart", async () => {
    const file = journal();
    const home = stubbedHome();
    mkdirSync(join(home, ".agent-browser", "sessions"), { recursive: true });
    writeFileSync(savedState(home, "client_1"), "{}");
    const coordinator = new BrowserCleanupCoordinator({
      file,
      dataDir: join(home, "data"),
      timeoutMs: 10,
      retryMs: [60_000],
      send: () => true,
    });
    const request = coordinator.commit(coordinator.prepare("profile", "client_1"));

    const acknowledged = await coordinator.ensure(request);
    expect(acknowledged).toBe(false);
    expect(() => requireBrowserCleanupAcknowledged(acknowledged, "The browser profile"))
      .toThrow(expect.objectContaining({ status: 503 }));
    expect(coordinator.hasPendingProfile("client_1")).toBe(true);

    const afterRestart = new BrowserCleanupCoordinator({
      file,
      timeoutMs: 10,
      retryMs: [60_000],
      send: () => false,
    });
    expect(afterRestart.hasPendingProfile("client_1")).toBe(true);
    expect(afterRestart.pending()).toEqual([request]);
  });

  it("treats a bot whose browser data is already gone as erased without any ack", async () => {
    const file = journal();
    const home = stubbedHome();
    const coordinator = new BrowserCleanupCoordinator({
      file,
      dataDir: join(home, "data"),
      timeoutMs: 50,
      retryMs: [60_000],
      send: () => false,
    });
    const request = coordinator.commit(coordinator.prepare("bot", "copilot-test"));

    await expect(coordinator.ensure(request)).resolves.toBe(true);
    expect(() => requireBrowserCleanupAcknowledged(true, "Browser data for Copilot test")).not.toThrow();
    expect(coordinator.pending()).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
  });

  it("treats browser data an earlier erase already removed as erased", async () => {
    const file = journal();
    const home = stubbedHome();
    mkdirSync(join(home, ".agent-browser", "sessions"), { recursive: true });
    writeFileSync(savedState(home, "bot-copilot-test"), "{}");
    rmSync(savedState(home, "bot-copilot-test"));
    let coordinator!: BrowserCleanupCoordinator;
    coordinator = new BrowserCleanupCoordinator({
      file,
      dataDir: join(home, "data"),
      timeoutMs: 50,
      retryMs: [60_000],
      send(message) {
        queueMicrotask(() => coordinator.receive({
          type: "openmausbot:browser-lifecycle-result",
          requestId: message.requestId,
          ok: false,
        }));
        return true;
      },
    });
    const request = coordinator.commit(coordinator.prepare("bot", "copilot-test"));

    await expect(coordinator.ensure(request)).resolves.toBe(true);
    expect(coordinator.pending()).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
  });

  it("still reports an erase it cannot confirm while the bot's saved state remains", async () => {
    const file = journal();
    const home = stubbedHome();
    mkdirSync(join(home, ".agent-browser", "sessions"), { recursive: true });
    writeFileSync(savedState(home, "bot-copilot-test"), "{}");
    let coordinator!: BrowserCleanupCoordinator;
    coordinator = new BrowserCleanupCoordinator({
      file,
      dataDir: join(home, "data"),
      timeoutMs: 50,
      retryMs: [60_000],
      send(message) {
        queueMicrotask(() => coordinator.receive({
          type: "openmausbot:browser-lifecycle-result",
          requestId: message.requestId,
          ok: false,
        }));
        return true;
      },
    });
    const request = coordinator.commit(coordinator.prepare("bot", "copilot-test"));

    const acknowledged = await coordinator.ensure(request);
    expect(acknowledged).toBe(false);
    expect(() => requireBrowserCleanupAcknowledged(acknowledged, "Browser data for Copilot test"))
      .toThrow(expect.objectContaining({ status: 503 }));
    expect(coordinator.pending()).toEqual([request]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([request]);
  });

  it("does not settle while an audience's own browser state remains", async () => {
    const file = journal();
    const home = stubbedHome();
    mkdirSync(join(home, ".agent-browser", "sessions"), { recursive: true });
    writeFileSync(savedState(home, "bot-copilot-test--member-0123456789abcdef"), "{}");
    let coordinator!: BrowserCleanupCoordinator;
    coordinator = new BrowserCleanupCoordinator({
      file,
      dataDir: join(home, "data"),
      timeoutMs: 50,
      retryMs: [60_000],
      send(message) {
        queueMicrotask(() => coordinator.receive({
          type: "openmausbot:browser-lifecycle-result",
          requestId: message.requestId,
          ok: false,
        }));
        return true;
      },
    });
    const request = coordinator.commit(coordinator.prepare("bot", "copilot-test"));

    await expect(coordinator.ensure(request)).resolves.toBe(false);
    expect(coordinator.pending()).toEqual([request]);
  });

  it("does not settle while the chrome engine still keeps the bot's profile", async () => {
    const file = journal();
    const home = stubbedHome();
    const dataDir = join(home, "data");
    mkdirSync(profileDir(dataDir, "bot:copilot-test"), { recursive: true });
    let coordinator!: BrowserCleanupCoordinator;
    coordinator = new BrowserCleanupCoordinator({
      file,
      dataDir,
      timeoutMs: 50,
      retryMs: [60_000],
      send(message) {
        queueMicrotask(() => coordinator.receive({
          type: "openmausbot:browser-lifecycle-result",
          requestId: message.requestId,
          ok: false,
        }));
        return true;
      },
    });
    const request = coordinator.commit(coordinator.prepare("bot", "copilot-test"));

    await expect(coordinator.ensure(request)).resolves.toBe(false);
    expect(coordinator.pending()).toEqual([request]);
  });

  it("locks the canonical profile id while wiping its exact legacy partition", async () => {
    const file = journal();
    let sentProfileId = "";
    let coordinator!: BrowserCleanupCoordinator;
    coordinator = new BrowserCleanupCoordinator({
      file,
      timeoutMs: 50,
      retryMs: [60_000],
      send(message) {
        sentProfileId = message.partitionId ?? "";
        queueMicrotask(() => coordinator.receive({
          type: "openmausbot:browser-lifecycle-result",
          requestId: message.requestId,
          ok: true,
        }));
        return true;
      },
    });
    const request = coordinator.commit(coordinator.prepare("profile", "work-2", "Work"));
    expect(coordinator.hasPendingProfile("work-2")).toBe(true);
    expect(coordinator.hasPendingProfile("different-id", "work")).toBe(true);
    expect(coordinator.committedProfileIds()).toEqual(["work-2"]);

    await expect(coordinator.ensure(request)).resolves.toBe(true);
    expect(sentProfileId).toBe("Work");
    expect(coordinator.hasPendingProfile("work-2")).toBe(false);
    expect(coordinator.committedProfileIds()).toEqual([]);
  });

  it("does not dispatch an ambiguous prepared intent after a crash", async () => {
    const file = journal();
    const coordinator = new BrowserCleanupCoordinator({ file, send: () => false });
    const request = coordinator.prepare("profile", "client-crash");

    let sends = 0;
    const afterRestart = new BrowserCleanupCoordinator({
      file,
      timeoutMs: 10,
      retryMs: [10],
      send: () => {
        sends += 1;
        return true;
      },
    });
    afterRestart.startPending();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(sends).toBe(0);
    expect(afterRestart.pending()).toEqual([request]);
    expect(afterRestart.hasPendingProfile("client-crash")).toBe(true);
    expect(afterRestart.committedProfileIds()).toEqual([]);
    await expect(afterRestart.ensure(request)).resolves.toBe(false);
  });

  it("replays only an explicitly committed intent after a crash", async () => {
    const file = journal();
    const beforeCrash = new BrowserCleanupCoordinator({ file, send: () => false });
    const request = beforeCrash.commit(beforeCrash.prepare("profile", "client-committed"));

    let afterRestart!: BrowserCleanupCoordinator;
    afterRestart = new BrowserCleanupCoordinator({
      file,
      timeoutMs: 50,
      retryMs: [10],
      send(message) {
        queueMicrotask(() => afterRestart.receive({
          type: "openmausbot:browser-lifecycle-result",
          requestId: message.requestId,
          ok: true,
        }));
        return true;
      },
    });
    await expect(afterRestart.ensure(request)).resolves.toBe(true);
    expect(afterRestart.pending()).toEqual([]);
  });

  it("treats malformed journal JSON as unknown state and blocks profile reuse", () => {
    const file = journal();
    writeFileSync(file, "{ definitely not json");
    const coordinator = new BrowserCleanupCoordinator({ file, send: () => false });

    expect(() => coordinator.hasPendingProfile("work")).toThrow(expect.objectContaining({
      status: 503,
      message: expect.stringMatching(/could not be read safely.*blocked/i),
    }));
    expect(() => coordinator.prepare("profile", "work")).toThrow(expect.objectContaining({ status: 503 }));
    expect(() => coordinator.pending()).toThrow(expect.objectContaining({ status: 503 }));
  });

  it("rejects a syntactically valid journal containing an invalid entry", () => {
    const file = journal();
    writeFileSync(file, JSON.stringify([{
      requestId: "00000000-0000-4000-8000-000000000000",
      kind: "profile",
      id: "work",
      phase: "maybe",
    }]));
    const coordinator = new BrowserCleanupCoordinator({ file, send: () => false });

    expect(() => coordinator.hasPendingProfile("work")).toThrow(expect.objectContaining({
      status: 503,
      message: expect.stringMatching(/invalid browser cleanup journal/i),
    }));
  });

  it("uses ENOENT alone as the empty-journal state", () => {
    const file = journal();
    const coordinator = new BrowserCleanupCoordinator({ file, send: () => false });
    expect(coordinator.pending()).toEqual([]);
    expect(coordinator.hasPendingProfile("work")).toBe(false);
  });

  it("runs mandatory post-config effects when the commit journal write fails", async () => {
    const file = journal();
    let writes = 0;
    const events: string[] = [];
    const coordinator = new BrowserCleanupCoordinator({
      file,
      send: () => false,
      write(path, data, options) {
        writes += 1;
        if (writes === 2) throw new Error("simulated commit journal failure");
        writeFileSync(path, data, options);
      },
    });
    const request = coordinator.prepare("profile", "work");

    await expect(finalizeBrowserCleanupMutation({
      requests: [request],
      commit(entry) {
        events.push("commit");
        return coordinator.commit(entry);
      },
      ensure(entry) {
        events.push("ensure");
        return coordinator.ensure(entry);
      },
      async mandatory() {
        events.push("mandatory");
        return "status";
      },
    })).rejects.toThrow("simulated commit journal failure");

    expect(events).toEqual(["commit", "mandatory"]);
    expect(coordinator.pending()).toEqual([request]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([request]);
  });
});

describe("closing this data dir's browsers nothing uses", () => {
  /** A HOME whose agent-browser run directory holds a pid file per daemon. */
  function home(daemons: string[]) {
    const folder = mkdtempSync(join(tmpdir(), "openmaus-browser-sweep-"));
    folders.push(folder);
    mkdirSync(join(folder, "agent-browser"));
    for (const session of daemons) writeFileSync(join(folder, "agent-browser", `${session}.pid`), "0");
    vi.stubEnv("XDG_RUNTIME_DIR", folder);
    vi.mocked(runningBrowserSessionNames).mockClear().mockResolvedValue(daemons);
    vi.mocked(closeBrowserSession).mockClear().mockResolvedValue(true);
    vi.mocked(orphanedBrowsers).mockClear().mockResolvedValue([]);
    vi.mocked(stopBrowserProcesses).mockClear().mockResolvedValue(true);
  }
  function sweep(options: { live?: string[]; held?: string[]; idle?: (session: string) => Promise<boolean> } = {}) {
    const closeIdle = vi.fn(options.idle ?? (async () => false));
    const value = new BrowserSweep({
      engine: () => "/engine/agent-browser",
      owns: (session) => session === "bot-a" || session === "bot-b" || session.startsWith("guest-0f0f0f0f-"),
      live: (session) => options.live?.includes(session) ?? false,
      held: (session) => options.held?.includes(session) ?? false,
      closeIdle,
    });
    return { value, closeIdle, closed: () => vi.mocked(closeBrowserSession).mock.calls.map(([binary, env]) => `${binary} ${env.AGENT_BROWSER_SESSION}`) };
  }
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

  it("closes the browsers an earlier run left, and nothing else under the same HOME", async () => {
    home(["bot-a", "guest-0f0f0f0f-1234", "someone-elses", "work"]);
    const { value, closeIdle, closed } = sweep();
    await value.sweep();
    expect(closed()).toEqual(["/engine/agent-browser bot-a", "/engine/agent-browser guest-0f0f0f0f-1234"]);
    expect(closeIdle).not.toHaveBeenCalled();
  });

  it("closes a browser this run uses only once it sat unused", async () => {
    home(["bot-a", "bot-b"]);
    const { value, closeIdle, closed } = sweep({ live: ["bot-a"] });
    await value.sweep();
    expect(closeIdle.mock.calls).toEqual([["bot-a"]]);
    expect(closed()).toEqual(["/engine/agent-browser bot-b"]);
  });

  it("never closes a browser a turn holds, however long it went unused", async () => {
    home(["bot-a", "bot-b"]);
    const { value, closeIdle, closed } = sweep({ live: ["bot-a"], held: ["bot-a", "bot-b"], idle: async () => true });
    await value.sweep();
    expect(closeIdle).not.toHaveBeenCalled();
    expect(closed()).toEqual([]);
  });

  it("asks the engine nothing while no daemon has a pid file, or there is no engine", async () => {
    home([]);
    writeFileSync(join(process.env.XDG_RUNTIME_DIR!, "agent-browser", "dashboard.pid"), "0");
    await sweep().value.sweep();
    expect(runningBrowserSessionNames).not.toHaveBeenCalled();
    home(["bot-a"]);
    await new BrowserSweep({ engine: () => null, owns: () => true, live: () => false, held: () => false, closeIdle: async () => false }).sweep();
    expect(runningBrowserSessionNames).not.toHaveBeenCalled();
  });

  it("runs one pass at a time, and keeps trying a browser it could not close with one warning", async () => {
    home(["bot-a"]);
    vi.mocked(closeBrowserSession).mockResolvedValue(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { value, closed } = sweep();
    await Promise.all([value.sweep(), value.sweep()]);
    await value.sweep();
    expect(closed()).toEqual(["/engine/agent-browser bot-a", "/engine/agent-browser bot-a"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("sweeps at boot and every minute, and at shutdown closes every browser of this data dir, used or not", async () => {
    vi.useFakeTimers();
    home(["bot-a", "bot-b", "someone-elses"]);
    const { value, closeIdle, closed } = sweep({ live: ["bot-a", "bot-b"] });
    value.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(closeIdle).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closeIdle).toHaveBeenCalledTimes(4);
    await value.closeAll(1_000);
    expect(closed()).toEqual(["/engine/agent-browser bot-a", "/engine/agent-browser bot-b"]);
    expect(vi.mocked(closeBrowserSession).mock.calls.every(([, , timeout]) => timeout === 1_000)).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(closeIdle).toHaveBeenCalledTimes(4);
  });

  it("stops a browser of this data dir whose engine was killed, at boot and while daemons run, and no one else's", async () => {
    const orphan = (session: string): { session: string; tree: BrowserProcessTree } => ({ session, tree: { daemon: 42, members: new Map([[42, "t"]]), groups: [42] } });
    home([]);
    vi.mocked(orphanedBrowsers).mockResolvedValue([orphan("bot-a"), orphan("someone-elses")]);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await sweep().value.sweep();
    expect(orphanedBrowsers).not.toHaveBeenCalled(); // no pid file: nothing died since the last pass
    await sweep().value.sweep(true);
    expect(vi.mocked(stopBrowserProcesses).mock.calls).toEqual([[orphan("bot-a").tree]]);
    home(["bot-b"]);
    vi.mocked(orphanedBrowsers).mockResolvedValue([orphan("guest-0f0f0f0f-1")]);
    const running = sweep({ live: ["bot-b"] }).value;
    await running.sweep();
    expect(vi.mocked(stopBrowserProcesses).mock.calls).toEqual([[orphan("guest-0f0f0f0f-1").tree]]);
    rmSync(join(process.env.XDG_RUNTIME_DIR!, "agent-browser", "bot-b.pid"));
    await running.sweep();
    expect(orphanedBrowsers).toHaveBeenCalledTimes(2);
    await running.sweep();
    expect(orphanedBrowsers).toHaveBeenCalledTimes(2);
    info.mockRestore();
  });

  it("closes an unused browser after ten minutes, three on a Cloud home, unless config.json says otherwise", () => {
    expect(browserIdleMs({})).toBe(10 * 60_000);
    expect(browserIdleMs({}, { cloudHome: true })).toBe(3 * 60_000);
    expect(browserIdleMs({ browserEngine: { idleTimeoutMinutes: 2 } })).toBe(2 * 60_000);
    expect(browserIdleMs({ browserEngine: { idleTimeoutMinutes: 20 } }, { cloudHome: true })).toBe(20 * 60_000);
  });
});
