import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOCAL_CHROME_IDLE_MS,
  LOCAL_CHROME_PORT,
  LocalChromePool,
  localChromeArgv,
  type LocalChromePoolDeps,
} from "./local-chrome-pool.ts";

const URL = `http://127.0.0.1:${LOCAL_CHROME_PORT}`;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

interface FakeChild {
  pid: number;
  exit: ((code: number | null) => void) | null;
}

/** Controllable deps: one virtual clock (sleep advances it), one port that answers only while the test says so. */
function harness(options: { portUp?: boolean; binary?: string | null; systemdRun?: boolean } = {}) {
  const clock = { now: 1_700_000_000_000 };
  const port = { up: options.portUp ?? false };
  const state = { connections: 0 };
  const spawns: Array<{ command: string; args: string[] }> = [];
  const kills: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
  const probes: string[] = [];
  const lines: string[] = [];
  const children: FakeChild[] = [];
  const userDataDir = mkdtempSync(join(tmpdir(), "local-chrome-pool-"));
  tempDirs.push(userDataDir);
  const deps: LocalChromePoolDeps = {
    spawn(command, args) {
      spawns.push({ command, args });
      const pid = 4200 + spawns.length;
      children.push({ pid, exit: null });
      return {
        pid,
        onExit(cb) {
          const child = children[children.length - 1];
          if (child) child.exit = cb;
        },
      };
    },
    killGroup(pgid, signal) {
      kills.push({ pgid, signal });
    },
    async probe(url) {
      probes.push(url);
      return port.up;
    },
    connections() {
      return state.connections;
    },
    hasSystemdRun() {
      return options.systemdRun ?? true;
    },
    chromeBinary() {
      return options.binary === undefined ? "/usr/bin/google-chrome" : options.binary;
    },
    now() {
      return clock.now;
    },
    async sleep(ms) {
      clock.now += ms;
    },
    log: (line) => lines.push(line),
  };
  /** The process the pool started leaves on its own, as a crashed Chrome would. */
  const die = (pid: number) => {
    const child = children.find((entry) => entry.pid === pid);
    child?.exit?.(0);
  };
  return { clock, port, state, spawns, kills, probes, lines, userDataDir, deps, die };
}

/** A pool whose own Chrome already answers: the adopt probe fails, the ready probe succeeds. */
async function started(options: { idleMs?: number; systemdRun?: boolean } = {}) {
  const h = harness(options);
  const pool = new LocalChromePool({ userDataDir: h.userDataDir, idleMs: options.idleMs, deps: h.deps });
  const pending = pool.ensure();
  // The port only answers once Chrome is up: after the adopt probe, before the ready one.
  h.port.up = true;
  const url = await pending;
  expect(url).toBe(URL);
  return { h, pool, url };
}

describe("localChromeArgv", () => {
  it("wraps Chrome in a systemd scope with the memory and CPU caps", () => {
    const argv = localChromeArgv({
      binary: "/usr/bin/google-chrome",
      port: LOCAL_CHROME_PORT,
      userDataDir: "/tmp/omb-local-chrome",
      systemdRun: true,
    });

    expect(argv).toEqual([
      "systemd-run",
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "-p",
      "MemoryMax=1536M",
      "-p",
      "MemoryHigh=1200M",
      "-p",
      "CPUQuota=150%",
      "--",
      "/usr/bin/google-chrome",
      "--headless=new",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=9339",
      "--user-data-dir=/tmp/omb-local-chrome",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--renderer-process-limit=2",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--mute-audio",
      "--lang=zh-CN",
      "about:blank",
    ]);
  });

  it("runs the binary directly without systemd, and carries the port and profile dir", () => {
    const argv = localChromeArgv({ binary: "/usr/bin/chromium", port: 9444, userDataDir: "/tmp/p", systemdRun: false });

    expect(argv[0]).toBe("/usr/bin/chromium");
    expect(argv).toContain("--remote-debugging-port=9444");
    expect(argv).toContain("--user-data-dir=/tmp/p");
    expect(argv).not.toContain("systemd-run");
    expect(argv[argv.length - 1]).toBe("about:blank");
  });
});

describe("LocalChromePool.ensure", () => {
  it("starts one Chrome for concurrent calls and answers the same url", async () => {
    const h = harness();
    const pool = new LocalChromePool({ userDataDir: h.userDataDir, deps: h.deps });

    const first = pool.ensure();
    const second = pool.ensure();
    h.port.up = true;
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(URL);
    expect(b).toBe(URL);
    expect(h.spawns).toHaveLength(1);
    expect(h.lines.some((line) => line.includes("已启动（pid 4201"))).toBe(true);
  });

  it("reuses the running Chrome instead of spawning a second one", async () => {
    const { h, pool } = await started();

    expect(await pool.ensure()).toBe(URL);
    expect(h.spawns).toHaveLength(1);
    expect(pool.running()).toBe(true);
  });

  it("returns null and says so when this host has no Chrome", async () => {
    const h = harness({ binary: null });
    const pool = new LocalChromePool({ userDataDir: h.userDataDir, deps: h.deps });

    expect(await pool.ensure()).toBeNull();
    expect(h.spawns).toHaveLength(0);
    expect(h.lines).toContain("本机没有 Chrome，无法回落");
  });

  it("closes the group and gives up when the port never answers in time", async () => {
    const h = harness();
    const pool = new LocalChromePool({ userDataDir: h.userDataDir, readyTimeoutMs: 600, deps: h.deps });

    expect(await pool.ensure()).toBeNull();
    expect(h.spawns).toHaveLength(1);
    expect(h.kills).toEqual([{ pgid: 4201, signal: "SIGTERM" }]);
    expect(h.clock.now - 1_700_000_000_000).toBeGreaterThanOrEqual(600);
    expect(pool.running()).toBe(false);
  });

  it("closes a Chrome of its own that stopped answering and starts a fresh one", async () => {
    const { h, pool } = await started();

    h.port.up = false;
    expect(await pool.ensure()).toBeNull();
    expect(h.spawns).toHaveLength(2);
    expect(h.spawns[1]?.args).toContain(`--user-data-dir=${h.userDataDir}`);
    expect(h.kills).toEqual([
      { pgid: 4201, signal: "SIGTERM" },
      { pgid: 4202, signal: "SIGTERM" },
    ]);
  });

  it("spawns again after the process left on its own", async () => {
    const { h, pool } = await started();

    h.die(4201);
    h.port.up = false;
    expect(pool.running()).toBe(false);

    const pending = pool.ensure();
    h.port.up = true;
    expect(await pending).toBe(URL);
    expect(h.spawns).toHaveLength(2);
    expect(h.spawns[1]?.args).toContain("--headless=new");
  });
});

describe("LocalChromePool idle sweep", () => {
  it("keeps a Chrome with live connections", async () => {
    const { h, pool } = await started();

    h.state.connections = 2;
    h.clock.now += LOCAL_CHROME_IDLE_MS + 1;
    expect(await pool.tick()).toBe(false);
    expect(h.kills).toHaveLength(0);
    expect(pool.running()).toBe(true);
  });

  it("keeps a Chrome that has not been idle for the whole window", async () => {
    const { h, pool } = await started();

    h.clock.now += LOCAL_CHROME_IDLE_MS - 1;
    expect(await pool.tick()).toBe(false);
    expect(h.kills).toHaveLength(0);
  });

  it("closes the whole group once the idle window passed with no connections", async () => {
    const { h, pool } = await started();

    h.clock.now += LOCAL_CHROME_IDLE_MS + 1;
    expect(await pool.tick()).toBe(true);
    expect(h.kills[0]).toEqual({ pgid: 4201, signal: "SIGTERM" });
    expect(h.lines).toContain("本机回落 Chrome 空闲 90s，已整组关闭");
    expect(pool.running()).toBe(false);
  });

  it("restarts the idle clock on touch", async () => {
    const { h, pool } = await started();

    h.clock.now += 60_000;
    pool.touch();
    h.clock.now += 60_000;
    expect(await pool.tick()).toBe(false);

    h.clock.now += 31_000;
    expect(await pool.tick()).toBe(true);
  });

  it("sweeps on an interval and stops when asked", async () => {
    vi.useFakeTimers();
    const { pool } = await started();
    const tick = vi.spyOn(pool, "tick");

    const stop = pool.startIdleSweep(1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(3);

    stop();
    const seen = tick.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick.mock.calls.length).toBe(seen);
  });
});

describe("LocalChromePool.stop", () => {
  it("SIGTERMs the group and SIGKILLs it when it is still there after 3s", async () => {
    const { h, pool } = await started();
    const before = h.clock.now;

    await pool.stop();

    expect(h.kills).toEqual([
      { pgid: 4201, signal: "SIGTERM" },
      { pgid: 4201, signal: "SIGKILL" },
    ]);
    expect(h.kills[1] && h.clock.now - before).toBeGreaterThanOrEqual(3000);
    expect(pool.running()).toBe(false);
  });

  it("stops waiting as soon as the port stops answering", async () => {
    const { h, pool } = await started();

    h.port.up = false;
    await pool.stop();

    expect(h.kills).toEqual([{ pgid: 4201, signal: "SIGTERM" }]);
    expect(pool.running()).toBe(false);
  });
});

describe("LocalChromePool adopted Chrome", () => {
  it("uses a Chrome left on the port by an earlier run without spawning", async () => {
    const h = harness({ portUp: true });
    const pool = new LocalChromePool({ userDataDir: h.userDataDir, deps: h.deps });

    expect(await pool.ensure()).toBe(URL);
    expect(h.spawns).toHaveLength(0);
    expect(h.lines).toContain("本机回落 Chrome 由外部进程提供，直接使用");
    expect(pool.running()).toBe(true);
  });

  it("forgets an idle adopted Chrome without killing it", async () => {
    const h = harness({ portUp: true });
    const pool = new LocalChromePool({ userDataDir: h.userDataDir, deps: h.deps });
    await pool.ensure();

    h.clock.now += LOCAL_CHROME_IDLE_MS + 1;
    expect(await pool.tick()).toBe(false);
    expect(h.kills).toHaveLength(0);
    expect(pool.running()).toBe(false);
  });
});
