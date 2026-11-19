import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { chatNotice } from "../chat-notices.ts";
import {
  DEFAULT_TURN_STUCK_MS, durationFromEnv, formatSpan, livenessTickMs, loopbackPeer, sampleLinux, sampleTurnTree, statusNotice,
  statusUpdate, stuckErrorData, stuckNotice, TurnLiveness, turnMaxTotalMs, turnStuckMs, watchTurn, type LivenessSample, type ProcFs,
} from "./turn-liveness.ts";

const sample = (cpuMs: number | null, extra: Partial<LivenessSample> = {}): LivenessSample =>
  ({ alive: true, cpuMs, ioBytes: 0, connections: 0, external: 0, ...extra });

/** A TurnLiveness on a fake clock and a scripted status query. */
function rig(opts: { stuckMs?: number; maxTotalMs?: number; samples?: () => LivenessSample; pid?: boolean } = {}) {
  let now = 1_000_000;
  const liveness = new TurnLiveness({
    name: "CodeArts", stuckMs: opts.stuckMs ?? DEFAULT_TURN_STUCK_MS, maxTotalMs: opts.maxTotalMs,
    ...(opts.pid === false ? {} : { pid: () => 4242 }),
    sample: async () => (opts.samples ?? (() => sample(0)))(),
    now: () => now,
  });
  return { liveness, tick: (ms: number) => { now += ms; } };
}

describe("turn liveness settings", () => {
  it("defaults to a 30 minute stuck window and no total cap", () => {
    expect(turnStuckMs({})).toBe(30 * 60_000);
    expect(turnMaxTotalMs({})).toBe(0);
  });

  it("reads a driver's own variable first, seconds for _SEC names, and 0 as never", () => {
    expect(turnStuckMs({ OMB_TURN_STUCK_MS: "600000" }, "AGENTHUB_CODEARTS_STUCK_SEC")).toBe(600_000);
    expect(turnStuckMs({ OMB_TURN_STUCK_MS: "600000", AGENTHUB_CODEARTS_STUCK_SEC: "120" }, "AGENTHUB_CODEARTS_STUCK_SEC")).toBe(120_000);
    expect(turnStuckMs({ AGENTHUB_CODEARTS_STUCK_SEC: "0" }, "AGENTHUB_CODEARTS_STUCK_SEC")).toBe(0);
    expect(turnStuckMs({ OMB_TURN_STUCK_MS: "nonsense" })).toBe(DEFAULT_TURN_STUCK_MS);
    expect(turnMaxTotalMs({ OMB_DOUBAO_TIMEOUT_MS: "900000" }, "OMB_DOUBAO_MAX_MS", "OMB_DOUBAO_TIMEOUT_MS")).toBe(900_000);
    expect(durationFromEnv({ X: "1e309" }, ["X"], 5)).toBe(5);
  });

  it("looks at a short window several times before it can end", () => {
    expect(livenessTickMs({}, DEFAULT_TURN_STUCK_MS)).toBe(30_000);
    expect(livenessTickMs({}, 1_000)).toBe(250);
    expect(livenessTickMs({}, 0)).toBe(30_000);
    expect(livenessTickMs({ OMB_TURN_LIVENESS_TICK_MS: "10000" }, DEFAULT_TURN_STUCK_MS)).toBe(10_000);
  });

  it("formats spans the way the status line shows them", () => {
    expect(formatSpan(40_000)).toBe("40 s");
    expect(formatSpan(4 * 60_000)).toBe("4 min");
    expect(formatSpan(65 * 60_000)).toBe("1 h 05 min");
  });
});

describe("what counts as activity", () => {
  it("counts CPU above an idle runtime's timers, moving bytes and a remote connection", () => {
    const before = sample(10_000, { ioBytes: 100 });
    expect(TurnLiveness.activity(null, before, 30_000)).toEqual([]);
    expect(TurnLiveness.activity(before, sample(10_050, { ioBytes: 100 }), 30_000), "timers").toEqual([]);
    expect(TurnLiveness.activity(before, sample(11_000, { ioBytes: 100 }), 30_000)).toEqual(["cpu"]);
    expect(TurnLiveness.activity(before, sample(10_000, { ioBytes: 101 }), 30_000)).toEqual(["io"]);
    expect(TurnLiveness.activity(before, sample(10_000, { ioBytes: 100, connections: 1, external: 1 }), 30_000)).toEqual(["network"]);
  });

  it("does not count an idle loopback connection where bytes can be read, but does where they cannot", () => {
    const idle = sample(0, { ioBytes: 5, connections: 2, external: 0 });
    expect(TurnLiveness.activity(idle, idle, 30_000)).toEqual([]);
    const blind = { alive: true, cpuMs: 0, ioBytes: null, connections: 1, external: null };
    expect(TurnLiveness.activity(blind, blind, 30_000)).toEqual(["network"]);
  });
});

describe("TurnLiveness on a fake clock", () => {
  it("keeps a quiet turn running for hours while its CPU moves (a model thinking without printing)", async () => {
    let cpu = 0;
    const { liveness, tick } = rig({ samples: () => sample((cpu += 2_000)) });
    for (let i = 0; i < 6 * 120; i += 1) {
      tick(30_000);
      expect((await liveness.check()).kind).toBe("running");
    }
  });

  it("judges a turn stuck only after the whole window without CPU, bytes, network or output, and says why", async () => {
    const { liveness, tick } = rig({ samples: () => sample(500, { ioBytes: 9, connections: 1 }) });
    tick(29 * 60_000);
    expect((await liveness.check()).kind).toBe("running");
    liveness.output();
    tick(29 * 60_000);
    expect((await liveness.check()).kind).toBe("running");
    tick(60_000);
    const verdict = await liveness.check();
    expect(verdict.kind).toBe("stuck");
    if (verdict.kind !== "stuck") return;
    expect(verdict.quietMs).toBe(30 * 60_000);
    expect(verdict.notice.message).toBe("CodeArts was judged stuck by a status check: no CPU use, output or network activity for 30 min, so the turn was stopped. Send the message again to retry.");
    expect(verdict.notice.message).not.toMatch(/limit/);
    expect(chatNotice(verdict.notice.key, verdict.notice.params)).toBe(verdict.notice.message);
  });

  it("never judges a turn stuck with a 0 window, and caps it only when asked", async () => {
    const never = rig({ stuckMs: 0 });
    never.tick(24 * 60 * 60_000);
    expect((await never.liveness.check()).kind).toBe("running");
    const capped = rig({ stuckMs: 0, maxTotalMs: 60 * 60_000, samples: () => sample(Math.random() * 1e9) });
    capped.tick(60 * 60_000);
    const verdict = await capped.liveness.check();
    expect(verdict).toMatchObject({ kind: "over-cap", message: expect.stringContaining("OMB_TURN_MAX_MS") });
  });

  it("counts output alone for remote work with no process to query", async () => {
    const { liveness, tick } = rig({ pid: false, stuckMs: 10 * 60_000 });
    tick(9 * 60_000);
    liveness.output();
    tick(9 * 60_000);
    expect((await liveness.check()).kind).toBe("running");
    tick(60_000);
    expect((await liveness.check()).kind).toBe("stuck");
  });

  it("counts an engine's own 'still working' status without calling it output", async () => {
    const { liveness, tick } = rig({ pid: false, stuckMs: 10 * 60_000 });
    for (let i = 0; i < 30; i += 1) {
      tick(60_000);
      liveness.alive();
      const verdict = await liveness.check();
      expect(verdict.kind).toBe("running");
    }
  });

  it("tells the person how a long quiet turn is doing, at most every ten minutes", async () => {
    let cpu = 0;
    const { liveness, tick } = rig({ samples: () => sample((cpu += 3_000), { connections: 2, external: 1 }) });
    const statuses: string[] = [];
    for (let i = 0; i < 2 * 23; i += 1) {
      tick(30_000);
      const verdict = await liveness.check();
      if (verdict.kind === "running" && verdict.status) statuses.push(verdict.status.message);
    }
    expect(statuses).toEqual([
      "CodeArts is still running · 10 min · CPU +3.0 s in the last 30 s · 2 network connections · last output 10 min ago",
      "CodeArts is still running · 20 min · CPU +3.0 s in the last 30 s · 2 network connections · last output 20 min ago",
    ]);
  });

  it("stays quiet while the turn is printing", async () => {
    const { liveness, tick } = rig({ samples: () => sample(0) });
    for (let i = 0; i < 40; i += 1) {
      tick(30_000);
      liveness.output();
      const verdict = await liveness.check();
      expect(verdict.kind === "running" && verdict.status).toBeFalsy();
    }
  });
});

describe("notices", () => {
  it("speaks the chat's own words, so the chat can translate them", () => {
    const status = statusNotice("Meoo", { elapsedMs: 23 * 60_000, cpuMs: 1_500, windowMs: 30_000, connections: 1, outputAgoMs: 4 * 60_000 });
    expect(status.message).toBe("Meoo is still running · 23 min · CPU +1.5 s in the last 30 s · 1 network connections · last output 4 min ago");
    expect(chatNotice(status.key, status.params)).toBe(status.message);
    const stuck = stuckNotice("ZCode", 30 * 60_000);
    expect(statusUpdate(status)).toMatchObject({ sessionUpdate: "omb_turn_status", notice: { key: "chat.notice.turnStillRunning" } });
    expect(stuckErrorData(stuck)).toEqual({ ombNotice: { key: "chat.notice.turnStuck", params: { name: "ZCode", window: "30 min" } } });
  });
});

describe("watchTurn", () => {
  it("stops once and reports the verdict when a real quiet process shows nothing", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const verdicts: string[] = [];
      const watch = watchTurn({ name: "Test", stuckMs: 600, pid: () => child.pid, onStuck: (verdict) => verdicts.push(verdict.kind) });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      watch.stop();
      expect(verdicts).toEqual(["stuck"]);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("keeps a busy real process alive", async () => {
    const child = spawn(process.execPath, ["-e", "const end = Date.now() + 2500; while (Date.now() < end) {}"], { stdio: "ignore" });
    try {
      const verdicts: string[] = [];
      const watch = watchTurn({ name: "Test", stuckMs: 1_000, pid: () => child.pid, onStuck: (verdict) => verdicts.push(verdict.kind) });
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      watch.stop();
      expect(verdicts).toEqual([]);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("Linux status query", () => {
  const files: Record<string, string> = {
    "/proc/100/stat": "100 (bridge) S 1 100 100 0 -1 0 0 0 0 0 150 50 0 0 20 0 1 0 1 0 0",
    "/proc/101/stat": "101 (code (cli)) S 100 100 100 0 -1 0 0 0 0 0 300 100 0 0 20 0 1 0 1 0 0",
    "/proc/102/stat": "102 (orphan) S 1 100 100 0 -1 0 0 0 0 0 10 0 0 0 20 0 1 0 1 0 0",
    "/proc/200/stat": "200 (other) S 1 200 200 0 -1 0 0 0 0 0 999 0 0 0 20 0 1 0 1 0 0",
    "/proc/100/io": "rchar: 10\nwchar: 5\n",
    "/proc/101/io": "rchar: 1000\nwchar: 20\n",
    "/proc/102/io": "rchar: 0\nwchar: 0\n",
    "/proc/100/net/tcp": "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
      + "   0: 0100007F:9C40 0100007F:1ED2 01 00000000:00000000 00:00000000 00000000  1000        0 777\n"
      + "   1: 0A00000A:9C41 08080808:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 778\n"
      + "   2: 0A00000A:9C42 08080808:01BB 06 00000000:00000000 00:00000000 00000000  1000        0 779\n",
    "/proc/100/net/tcp6": "  sl header\n",
  };
  const links: Record<string, string> = {
    "/proc/100/ns/net": "net:[1]", "/proc/101/ns/net": "net:[1]", "/proc/102/ns/net": "net:[1]",
    "/proc/101/fd/3": "socket:[777]", "/proc/101/fd/4": "socket:[778]", "/proc/101/fd/5": "socket:[779]",
  };
  const missing = (path: string) => Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
  const proc: ProcFs = {
    read: (path) => { if (path in files) return files[path]!; throw missing(path); },
    list: (path) => { if (path === "/proc") return ["100", "101", "102", "200", "self"]; if (path === "/proc/101/fd") return ["3", "4", "5"]; throw missing(path); },
    link: (path) => { if (path in links) return links[path]!; throw missing(path); },
  };

  it("sums the tree and its process group, reads bytes moved and tells remote peers from loopback", () => {
    expect(sampleLinux(100, proc)).toEqual({ alive: true, cpuMs: 6_100, ioBytes: 1_035, connections: 2, external: 1 });
  });

  it("reads a gone process as not alive and anything unreadable as unknown, never as idle", () => {
    expect(sampleLinux(999, proc).alive).toBe(false);
    expect(sampleLinux(100, { ...proc, list: () => { throw missing("/proc"); } })).toEqual({ alive: null, cpuMs: null, ioBytes: null, connections: null, external: null });
    const noIo = { ...proc, read: (path: string) => { if (path.endsWith("/io")) throw missing(path); return proc.read(path); } };
    expect(sampleLinux(100, noIo).ioBytes).toBeNull();
  });

  it("knows loopback peers in both tables", () => {
    expect(loopbackPeer("0100007F:1ED2")).toBe(true);
    expect(loopbackPeer("08080808:01BB")).toBe(false);
    expect(loopbackPeer("00000000000000000000000001000000:1ED2")).toBe(true);
    expect(loopbackPeer("0000000000000000FFFF00000100007F:1ED2")).toBe(true);
    expect(loopbackPeer("0000000000000000FFFF000008080808:01BB")).toBe(false);
  });

  it.runIf(process.platform === "linux")("reads this very process", async () => {
    const own = await sampleTurnTree(process.pid);
    expect(own.alive).toBe(true);
    expect(own.cpuMs).toBeGreaterThan(0);
  });
});
