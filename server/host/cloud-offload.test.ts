import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { RelayError, type CloudBrowserDeps, type MachineHealth } from "../cloud-browser.ts";
import type { CdpProxyOptions } from "../cloud-cdp-proxy.ts";
import { AUTH_STICKY_MS, CLOUD_PAGE_CAP, FALLBACK_PROXY_PORT, MYCHROME_PROXY_PORT, RELAY_IDLE_MS, RELAY_UPSTREAM_TIMEOUT_MS, browserLabel, createCloudOffload, guardedEnvHook, isConversationAlias, servableRoots } from "./cloud-offload.ts";

type FakeTask = { threadId: string; surface?: "cloud" | "vm" | "local" | "browser"; surfaceSource?: "user" | "auto"; browserPlacement?: unknown };
type FakeBot = { id: string; computer?: string | null; vpsInstanceId?: string; vpsAlias?: string; tasks: FakeTask[] };

function harness(options: { computer?: string | null; task?: Partial<FakeTask>; answers?: Record<string, MachineHealth>; cfg?: Partial<AppConfig>; bots?: FakeBot[]; failProxy?: boolean } = {}) {
  const bots = options.bots ?? [{ id: "b1", computer: options.computer ?? null, tasks: [{ threadId: "t1", ...options.task }] }];
  const patches: Array<{ threadId: string; patch: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const store = {
    bots,
    bot: (id: string) => bots.find((candidate) => candidate.id === id),
    patchTask: (_botId: string, threadId: string, patch: Record<string, unknown>) => {
      patches.push({ threadId, patch });
      const task = bots.flatMap((bot) => bot.tasks).find((candidate) => candidate.threadId === threadId);
      if (task) Object.assign(task, patch);
      return null;
    },
  };
  const answers = options.answers ?? { cloudA: { ok: true, load: 0.02 } };
  const cloud: CloudBrowserDeps = {
    now: () => 0,
    ensureRemote: async (machine) => answers[machine.name] ?? { ok: false, detail: "SSH 不通" },
    ensureTunnel: async () => true,
    probe: async () => true,
  };
  const cfg = { vps: { instances: [{ id: "i1", name: "cloudA", kind: "ssh", sshAlias: "cloudA" }] }, ...options.cfg } as unknown as AppConfig;
  const proxies: Array<{ port: number; upstream: string; local?: unknown; pageCap?: unknown; authDomain?: (url: string) => string | null }> = [];
  const fallback = { ensured: 0, stopped: 0 };
  const offload = createCloudOffload({
    cfg, dataDir: mkdtempSync(join(tmpdir(), "omb-offload-")), store: () => store as never, cloud, log: (line) => { logs.push(line); },
    makeProxy: (proxyOptions) => {
      proxies.push(proxyOptions as never);
      return { start: async () => { if (options.failProxy) throw new Error("port taken"); return proxyOptions.port; }, close: async () => {}, url: `http://127.0.0.1:${proxyOptions.port}`, connections: () => 0 };
    },
    fallback: () => ({ ensure: async () => { fallback.ensured++; return "http://127.0.0.1:9339"; }, touch: () => {}, stop: async () => { fallback.stopped++; }, startIdleSweep: () => () => {} }),
  });
  return { offload, bot: bots[0]!, bots, patches, proxies, fallback, logs };
}

/** The closer a conversation's own session is closed with, and every session it closed. */
function closer() {
  const closed: string[] = [];
  return { closed, close: async (session: string) => { closed.push(session); } };
}

describe("cloud offload for an Auto bot's browser (E72)", () => {
  it("attaches an Auto bot's browser to the cloud machine and records it for the header", async () => {
    const { offload, bot } = harness({ task: { surface: "browser", surfaceSource: "auto" } });
    const url = await offload.browserFor("b1", "sess", "t1", "mychrome");
    expect(url).toBe("http://127.0.0.1:9341");
    expect(bot.tasks[0]!.browserPlacement).toMatchObject({ machine: "cloudA", browser: "mychrome", cloud: true });
    expect(offload.guardState().cdpUrl).toBe("http://127.0.0.1:9341");
  });

  it("runs an Auto bot's browser on the cloud machine that bot is bound to, not the idlest one (E72)", async () => {
    // cloudB is idler, so a load-only pick would take it; the bot is bound to cloudA.
    const { offload, bot } = harness({
      bots: [{ id: "b1", vpsInstanceId: "i1", tasks: [{ threadId: "t1", surface: "browser", surfaceSource: "auto" }] }],
      answers: { cloudA: { ok: true, load: 0.9 }, cloudB: { ok: true, load: 0.01 } },
      cfg: { vps: { instances: [
        { id: "i1", name: "cloudA", kind: "ssh", sshAlias: "cloudA" },
        { id: "i2", name: "cloudB", kind: "ssh", sshAlias: "cloudB" },
      ] } } as never,
    });
    expect(await offload.browserFor("b1", "sess", "t1", "mychrome")).toBe("http://127.0.0.1:9341");
    expect(bot.tasks[0]!.browserPlacement).toMatchObject({ machine: "cloudA", cloud: true });
  });

  it("falls back to the idlest cloud machine when the bot's own does not answer (E72)", async () => {
    const { offload, bot } = harness({
      bots: [{ id: "b1", vpsInstanceId: "i1", tasks: [{ threadId: "t1", surface: "browser", surfaceSource: "auto" }] }],
      answers: { cloudA: { ok: false, detail: "SSH 不通" }, cloudB: { ok: true, load: 0.01 } },
      cfg: { vps: { instances: [
        { id: "i1", name: "cloudA", kind: "ssh", sshAlias: "cloudA" },
        { id: "i2", name: "cloudB", kind: "ssh", sshAlias: "cloudB" },
      ] } } as never,
    });
    expect(await offload.browserFor("b1", "sess", "t1", "mychrome")).toBe("http://127.0.0.1:9342");
    expect(bot.tasks[0]!.browserPlacement).toMatchObject({ machine: "cloudB", cloud: true });
  });

  it("prioritizes the cloud machine bound via vpsAlias over an idler machine (E72-VPSALIAS)", async () => {
    const { offload, bot, logs } = harness({
      bots: [{ id: "b1", vpsAlias: "cloudA-ssh", tasks: [{ threadId: "t1", surface: "browser", surfaceSource: "auto" }] }],
      answers: { cloudA: { ok: true, load: 0.9 }, cloudB: { ok: true, load: 0.01 } },
      cfg: { vps: { version: 2, instances: [
        { id: "i1", name: "cloudA", kind: "ssh", sshAlias: "cloudA-ssh" },
        { id: "i2", name: "cloudB", kind: "ssh", sshAlias: "cloudB-ssh" },
      ] } } as never,
    });
    expect(await offload.browserFor("b1", "sess", "t1", "mychrome")).toBe("http://127.0.0.1:9341");
    expect(bot.tasks[0]!.browserPlacement).toMatchObject({ machine: "cloudA", cloud: true });
    expect(logs).toEqual([]);
  });

  it("falls back to the remaining cloud pool when the vpsAlias-bound machine is unreachable (E72-VPSALIAS)", async () => {
    const { offload, bot, logs } = harness({
      bots: [{ id: "b1", vpsAlias: "cloudA-ssh", tasks: [{ threadId: "t1", surface: "browser", surfaceSource: "auto" }] }],
      answers: { cloudA: { ok: false, detail: "SSH 不通" }, cloudB: { ok: true, load: 0.05 } },
      cfg: { vps: { version: 2, instances: [
        { id: "i1", name: "cloudA", kind: "ssh", sshAlias: "cloudA-ssh" },
        { id: "i2", name: "cloudB", kind: "ssh", sshAlias: "cloudB-ssh" },
      ] } } as never,
    });
    expect(await offload.browserFor("b1", "sess", "t1", "mychrome")).toBe("http://127.0.0.1:9342");
    expect(bot.tasks[0]!.browserPlacement).toMatchObject({ machine: "cloudB", cloud: true });
    expect(logs).toEqual([]);
  });

  it("excludes pure relay/proxy hosts from vpsAlias binding and pool selection and logs without hostnames (E72-VPSALIAS)", async () => {
    // Case 1: boxRelayVia references an SSH entry in vps.instances that also has the lowest load (0.001); neither
    // vpsAlias binding nor fallback pool selection may pick it, and the log must not expose the relay hostname/alias.
    const relayInstance = harness({
      bots: [{ id: "b1", vpsAlias: "secret-relay-alias", tasks: [{ threadId: "t1", surface: "browser", surfaceSource: "auto" }] }],
      answers: { "secret-relay.example.net": { ok: true, load: 0.001 }, cloudB: { ok: true, load: 0.5 } },
      cfg: {
        vps: { version: 2, instances: [
          { id: "r1", name: "secret-relay.example.net", kind: "ssh", sshAlias: "secret-relay-alias" },
          { id: "i2", name: "cloudB", kind: "ssh", sshAlias: "cloudB-ssh" },
        ] },
        cloudOffload: { boxRelayVia: "r1" },
      } as never,
    });
    expect(await relayInstance.offload.browserFor("b1", "sess", "t1", "mychrome")).toBe("http://127.0.0.1:9342");
    expect(relayInstance.bot.tasks[0]!.browserPlacement).toMatchObject({ machine: "cloudB", cloud: true });
    expect(relayInstance.logs).toHaveLength(1);
    expect(relayInstance.logs[0]).toContain("relay-only");
    expect(relayInstance.logs.join("\n")).not.toContain("secret-relay");
    expect(relayInstance.logs.join("\n")).not.toContain("example.net");

    // Case 2: boxRelayVia uses "ssh:<alias>" (not in vps.instances) and bot.vpsAlias points to that relay alias.
    const sshRelayOnly = harness({
      bots: [{ id: "b2", vpsAlias: "secret-jump.example.org", tasks: [{ threadId: "t1", surface: "browser", surfaceSource: "auto" }] }],
      answers: { cloudA: { ok: true, load: 0.2 } },
      cfg: {
        vps: { version: 2, instances: [{ id: "i1", name: "cloudA", kind: "ssh", sshAlias: "cloudA" }] },
        cloudOffload: { boxRelayVia: "ssh:secret-jump.example.org" },
      } as never,
    });
    expect(await sshRelayOnly.offload.browserFor("b2", "sess", "t1", "mychrome")).toBe("http://127.0.0.1:9341");
    expect(sshRelayOnly.logs).toHaveLength(1);
    expect(sshRelayOnly.logs[0]).toContain("relay-only");
    expect(sshRelayOnly.logs.join("\n")).not.toContain("secret-jump");
    expect(sshRelayOnly.logs.join("\n")).not.toContain("example.org");

    // Case 3: unresolvable vpsAlias logs one sanitized line without exposing the alias/hostname and treats as unbound.
    const missingAlias = harness({
      bots: [{ id: "b3", vpsAlias: "missing-box.internal.corp", tasks: [{ threadId: "t1", surface: "browser", surfaceSource: "auto" }] }],
      answers: { cloudA: { ok: true, load: 0.2 } },
      cfg: { vps: { version: 2, instances: [{ id: "i1", name: "cloudA", kind: "ssh", sshAlias: "cloudA" }] } } as never,
    });
    expect(await missingAlias.offload.browserFor("b3", "sess", "t1", "mychrome")).toBe("http://127.0.0.1:9341");
    expect(missingAlias.logs).toHaveLength(1);
    expect(missingAlias.logs.join("\n")).not.toContain("missing-box");
    expect(missingAlias.logs.join("\n")).not.toContain("internal.corp");
  });

  it("keeps vpsInstanceId binding behavior unchanged even when vpsAlias is also present (E72-VPSALIAS)", async () => {
    let failA = false;
    const { offload, bot } = harness({
      bots: [{ id: "b1", vpsInstanceId: "i1", vpsAlias: "cloudB", tasks: [{ threadId: "t1", surface: "browser", surfaceSource: "auto" }] }],
      answers: {
        get cloudA() { return failA ? { ok: false, detail: "SSH 不通" } : { ok: true, load: 0.9 }; },
        cloudB: { ok: true, load: 0.01 },
      },
      cfg: { vps: { version: 2, instances: [
        { id: "i1", name: "cloudA", kind: "ssh", sshAlias: "cloudA" },
        { id: "i2", name: "cloudB", kind: "ssh", sshAlias: "cloudB" },
      ] } } as never,
    });
    expect(await offload.browserFor("b1", "sess1", "t1", "mychrome")).toBe("http://127.0.0.1:9341");
    expect(bot.tasks[0]!.browserPlacement).toMatchObject({ machine: "cloudA", cloud: true });

    failA = true;
    offload.pool.invalidate("i1");
    expect(await offload.browserFor("b1", "sess2", "t1", "mychrome")).toBe("http://127.0.0.1:9342");
    expect(bot.tasks[0]!.browserPlacement).toMatchObject({ machine: "cloudB", cloud: true });
  });

  it("does not patch the task again when the placement is the same", async () => {
    const { offload, patches } = harness();
    await offload.browserFor("b1", "sess", "t1", "mychrome");
    await offload.browserFor("b1", "sess", "t1", "mychrome");
    expect(patches.length).toBe(1);
  });

  it("keeps the browser a person chose: a pin in the conversation or the bot's Works on", async () => {
    const pinned = harness({ task: { surface: "browser", surfaceSource: "user", browserPlacement: { machine: "cloudA", browser: "mychrome", cloud: true } } });
    expect(await pinned.offload.browserFor("b1", "sess", "t1", "mychrome")).toBeUndefined();
    expect(pinned.bot.tasks[0]!.browserPlacement).toBeUndefined();
    const worksOn = harness({ computer: "browser" });
    expect(await worksOn.offload.browserFor("b1", "sess", "t1", "mychrome")).toBeUndefined();
  });

  it("falls back to this host when no cloud machine answers, and says so: a mychrome bot to capped mychrome", async () => {
    const { offload, bot, proxies } = harness({ answers: { cloudA: { ok: false, detail: "没有 Chrome" } }, cfg: { browserProfiles: [{ id: "mychrome", browser: "chrome" }] } as never });
    expect(await offload.browserFor("b1", "sess", "t1", "mychrome")).toBe(`http://127.0.0.1:${MYCHROME_PROXY_PORT}`);
    expect(bot.tasks[0]!.browserPlacement).toMatchObject({ machine: "本机", browser: "mychrome", cloud: false });
    expect((bot.tasks[0]!.browserPlacement as { reason: string }).reason).toContain("回落本机");
    expect(proxies.find((proxy) => proxy.port === MYCHROME_PROXY_PORT)?.pageCap).toEqual({ max: 2, countAll: false });
  });

  it("sends other bots to the one capped fallback Chrome when no cloud machine answers (T3)", async () => {
    const { offload, bot, proxies } = harness({ answers: { cloudA: { ok: false, detail: "没有 Chrome" } } });
    expect(await offload.browserFor("b1", "sess", "t1", "builtin")).toBe(`http://127.0.0.1:${FALLBACK_PROXY_PORT}`);
    expect(await offload.browserFor("b1", "sess2", "t1", "builtin")).toBe(`http://127.0.0.1:${FALLBACK_PROXY_PORT}`);
    expect(proxies.filter((proxy) => proxy.port === FALLBACK_PROXY_PORT)).toHaveLength(1);
    expect(proxies.find((proxy) => proxy.port === FALLBACK_PROXY_PORT)?.pageCap).toEqual({ max: 2, countAll: true });
    expect(bot.tasks[0]!.browserPlacement).toMatchObject({ machine: "本机", browser: "回落 Chrome", cloud: false });
  });

  it("puts the cloud Chrome behind a proxy that serves the bots' folders and knows the sign-in sites (T1, T2)", async () => {
    const { offload, proxies } = harness();
    await offload.browserFor("b1", "sess", "t1", "mychrome");
    const proxy = proxies.find((candidate) => candidate.port === 9341)!;
    expect(proxy.upstream).toBe("http://127.0.0.1:19341");
    expect(proxy.local).toBeDefined();
    expect(proxy.authDomain!("https://github.com/settings")).toBe("github.com");
    expect(proxy.authDomain!("https://example.com/")).toBeNull();
  });

  it("moves the conversation that opens a sign-in site from the cloud to mychrome, and says so (T2)", async () => {
    const { offload, bot } = harness({ task: { surface: "browser", surfaceSource: "auto" } });
    expect(await offload.browserFor("b1", "sess", "t1", "mychrome")).toBe("http://127.0.0.1:9341");
    const { closed } = closer();
    expect(offload.authRefusal("sess", "http://127.0.0.1:9341", { name: "agent_browser_open", arguments: { url: "https://example.com" } }, { botId: "b1", threadId: "t1" })).toBeNull();
    const text = offload.authRefusal("sess", "http://127.0.0.1:9341", { name: "agent_browser_open", arguments: { url: "github.com/login" } }, { botId: "b1", threadId: "t1" });
    expect(text).toContain("github.com");
    expect(text).toContain("这个对话的浏览器已切换到本机已登录的共享浏览器 mychrome（其他对话仍用云端）");
    expect(closed).toEqual([]);
    expect(bot.tasks[0]!.browserPlacement).toMatchObject({ machine: "本机", browser: "mychrome（需登录：github.com）", cloud: false });
    expect(await offload.browserFor("b1", "sess", "t1", "mychrome")).toBe(`http://127.0.0.1:${MYCHROME_PROXY_PORT}`);
    // Already on mychrome (not a cloud door): nothing to move.
    expect(offload.authRefusal("sess", `http://127.0.0.1:${MYCHROME_PROXY_PORT}`, { name: "agent_browser_open", arguments: { url: "https://github.com" } }, { botId: "b1", threadId: "t1" })).toBeNull();
    // Another conversation of the same bot keeps the cloud.
    expect(await offload.browserFor("b1", "other", "t3", "mychrome")).toBe("http://127.0.0.1:9341");
  });

  it("gives the conversation that needs a sign-in its own agent-browser session, and the shared cloud connection stays open (A)", async () => {
    const { offload, bot } = harness({ task: { surface: "browser", surfaceSource: "auto" } });
    const { closed, close } = closer();
    expect(offload.authRefusal("sess", "http://127.0.0.1:9341", { name: "agent_browser_open", arguments: { url: "github.com/login" } }, { botId: "b1", threadId: "t1" })).toContain("github.com");
    const alias = offload.conversationSession("b1", "t1", "mychrome", close);
    expect(alias).not.toBe("mychrome");
    expect(alias.startsWith("mychrome.auth-")).toBe(true);
    expect(alias).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(closed).toEqual([]);
    expect(await offload.browserFor("b1", alias, "t1", "mychrome")).toBe(`ws://127.0.0.1:${MYCHROME_PROXY_PORT}/devtools/browser/omb-scope/${alias}`);
    expect(bot.tasks[0]!.browserPlacement).toMatchObject({ machine: "本机" });
  });

  it("gives another bot's conversation its own cloud session, apart from this bot's (B)", async () => {
    const { offload, bots } = harness({ bots: [
      { id: "b1", tasks: [{ threadId: "t1" }] },
      { id: "b2", tasks: [{ threadId: "t2" }] },
    ] });
    const { close } = closer();
    const first = offload.conversationSession("b1", "t1", "mychrome", close);
    const second = offload.conversationSession("b2", "t2", "mychrome", close);
    expect(first).toMatch(/^mychrome\.c-[0-9a-f]{10}$/);
    expect(second).toMatch(/^mychrome\.c-[0-9a-f]{10}$/);
    expect(second).not.toBe(first);
    expect(await offload.browserFor("b2", "mychrome", "t2", "mychrome")).toBe("http://127.0.0.1:9341");
    expect(bots[1]!.tasks[0]!.browserPlacement).toMatchObject({ machine: "cloudA", cloud: true });
  });

  it("gives the same bot's other conversations their own cloud sessions, and the one that needs a sign-in its own (C)", async () => {
    const { offload, bots } = harness({ bots: [
      { id: "b1", tasks: [{ threadId: "t1" }, { threadId: "t3" }] },
    ] });
    const { close } = closer();
    offload.authRefusal("sess", "http://127.0.0.1:9341", { name: "agent_browser_open", arguments: { url: "github.com/login" } }, { botId: "b1", threadId: "t1" });
    const auth = offload.conversationSession("b1", "t1", "mychrome", close);
    const other = offload.conversationSession("b1", "t3", "mychrome", close);
    expect(auth).toMatch(/^mychrome\.auth-[0-9a-f]{10}$/);
    expect(other).toMatch(/^mychrome\.c-[0-9a-f]{10}$/);
    expect(other).not.toBe(auth);
    expect(await offload.browserFor("b1", "mychrome", "t3", "mychrome")).toBe("http://127.0.0.1:9341");
    expect(bots[0]!.tasks[1]!.browserPlacement).toMatchObject({ cloud: true });
  });

  it("closes nothing when a conversation is moved, and moves nothing without one (D)", async () => {
    const { offload } = harness({ bots: [{ id: "b1", tasks: [{ threadId: "t1" }, { threadId: "t2" }] }] });
    const { closed, close } = closer();
    const opens = { name: "agent_browser_open", arguments: { url: "github.com/login" } };
    expect(offload.authRefusal("sess", "http://127.0.0.1:9341", opens, { botId: "b1", threadId: "t1" })).toContain("github.com");
    expect(closed, "the shared cloud connection stays open").toEqual([]);
    expect(offload.conversationSession("b1", "t1", "mychrome", close)).toMatch(/^mychrome\.auth-/);
    expect(closed).toEqual([]);
    expect(offload.authRefusal("sess", "http://127.0.0.1:9341", opens, undefined), "a call with no conversation is let through").toBeNull();
    expect(offload.conversationSession("b1", "t2", "mychrome", close)).toMatch(/^mychrome\.c-/);
    expect(closed).toEqual([]);
  });

  it("closes a conversation's own session once its stickiness runs out, and only once (E)", async () => {
    vi.useFakeTimers();
    try {
      const { offload } = harness();
      const { closed, close } = closer();
      offload.authRefusal("sess", "http://127.0.0.1:9341", { name: "agent_browser_open", arguments: { url: "github.com/login" } }, { botId: "b1", threadId: "t1" });
      const alias = offload.conversationSession("b1", "t1", "mychrome", close);
      expect(alias).toMatch(/^mychrome\.auth-/);
      vi.advanceTimersByTime(AUTH_STICKY_MS + 1);
      expect(offload.conversationSession("b1", "t1", "mychrome", close)).toMatch(/^mychrome\.c-/);
      expect(closed).toEqual([alias]);
      expect(offload.conversationSession("b1", "t1", "mychrome", close)).toMatch(/^mychrome\.c-/);
      expect(closed).toEqual([alias]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a bot set to require sign-ins its own session, and only where there is a conversation (F)", () => {
    const { offload } = harness({ cfg: { cloudOffload: { requireAuthBots: ["b1"] } } });
    const { close } = closer();
    expect(offload.conversationSession("b1", "t1", "mychrome", close)).toMatch(/^mychrome\.auth-/);
    expect(offload.conversationSession("b1", undefined, "mychrome", close)).toBe("mychrome");
  });

  it("keeps one shared session while cloud offload is off (G)", () => {
    const { offload } = harness({ cfg: { cloudOffload: { enabled: false } } });
    const { close } = closer();
    expect(offload.conversationSession("b1", "t1", "mychrome", close)).toBe("mychrome");
    expect(offload.conversationSession("b1", undefined, "mychrome", close)).toBe("mychrome");
  });

  it("names every Auto conversation's own cloud session after it, and only a conversation's (H)", () => {
    const { offload } = harness({ bots: [
      { id: "b1", tasks: [{ threadId: "t1" }, { threadId: "t2" }] },
      { id: "b2", tasks: [{ threadId: "t1" }] },
    ] });
    const { close } = closer();
    const first = offload.conversationSession("b1", "t1", "mychrome", close);
    expect(first).toBe(`mychrome.c-${createHash("sha1").update("b1\nt1").digest("hex").slice(0, 10)}`);
    expect(isConversationAlias(first)).toBe(true);
    expect(offload.conversationSession("b1", "t2", "mychrome", close)).not.toBe(first);
    expect(offload.conversationSession("b2", "t1", "mychrome", close)).not.toBe(first);
    expect(offload.conversationSession("b1", undefined, "mychrome", close), "no conversation").toBe("mychrome");
    expect(isConversationAlias("mychrome")).toBe(false);
    expect(isConversationAlias("mychrome.auth-abc")).toBe(false);
    const off = harness({ cfg: { cloudOffload: { enabled: false } } });
    expect(off.offload.conversationSession("b1", "t1", "mychrome", close), "cloud offload off").toBe("mychrome");
  });

  it("moves a conversation that needs a sign-in onto its own session, closing the one it had, once (I)", () => {
    const { offload } = harness({ task: { surface: "browser", surfaceSource: "auto" } });
    const { closed, close } = closer();
    const first = offload.conversationSession("b1", "t1", "mychrome", close);
    expect(first).toMatch(/^mychrome\.c-[0-9a-f]{10}$/);
    expect(offload.authRefusal("sess", "http://127.0.0.1:9341", { name: "agent_browser_open", arguments: { url: "github.com/login" } }, { botId: "b1", threadId: "t1" })).toContain("github.com");
    const auth = offload.conversationSession("b1", "t1", "mychrome", close);
    expect(auth).toBe(`mychrome.auth-${first.slice("mychrome.c-".length)}`);
    expect(closed, "the cloud session this conversation had is closed").toEqual([first]);
    expect(offload.conversationSession("b1", "t1", "mychrome", close)).toBe(auth);
    expect(closed).toEqual([first]);
  });

  it("takes a conversation back to its cloud session once its sign-in stickiness runs out (J)", async () => {
    vi.useFakeTimers();
    try {
      const { offload } = harness({ task: { surface: "browser", surfaceSource: "auto" } });
      const { closed, close } = closer();
      const cloud = offload.conversationSession("b1", "t1", "mychrome", close);
      offload.authRefusal("sess", "http://127.0.0.1:9341", { name: "agent_browser_open", arguments: { url: "github.com/login" } }, { botId: "b1", threadId: "t1" });
      const auth = offload.conversationSession("b1", "t1", "mychrome", close);
      vi.advanceTimersByTime(AUTH_STICKY_MS + 1);
      expect(offload.conversationSession("b1", "t1", "mychrome", close)).toBe(cloud);
      expect(closed, "the cloud session it had gave way to the sign-in's, and that one to it again").toEqual([cloud, auth]);
      expect(offload.conversationSession("b1", "t1", "mychrome", close)).toBe(cloud);
      expect(closed).toEqual([cloud, auth]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the shared session for a conversation whose place the person chose, and closes the alias it had (K)", () => {
    const { offload, bot } = harness();
    const { closed, close } = closer();
    const alias = offload.conversationSession("b1", "t1", "mychrome", close);
    bot.tasks[0]!.surface = "browser";
    bot.tasks[0]!.surfaceSource = "user";
    expect(offload.conversationSession("b1", "t1", "mychrome", close), "a pin in the conversation").toBe("mychrome");
    expect(closed).toEqual([alias]);
    expect(offload.conversationSession("b1", "t1", "mychrome", close)).toBe("mychrome");
    expect(closed).toEqual([alias]);
    const worksOn = harness({ computer: "browser" });
    const { closed: none, close: closeNone } = closer();
    expect(worksOn.offload.conversationSession("b1", "t1", "mychrome", closeNone), "the bot's Works on").toBe("mychrome");
    expect(none).toEqual([]);
  });

  it("reaches a conversation's own session through its own scope on the door, and the guard through the door itself (L)", async () => {
    const { offload } = harness({ task: { surface: "browser", surfaceSource: "auto" } });
    const { close } = closer();
    const alias = offload.conversationSession("b1", "t1", "mychrome", close);
    expect(await offload.browserFor("b1", alias, "t1", "mychrome")).toBe(`ws://127.0.0.1:9341/devtools/browser/omb-scope/${alias}`);
    expect(await offload.browserFor("b1", "mychrome", undefined, "mychrome"), "the shared session").toBe("http://127.0.0.1:9341");
    expect(offload.guardState().cdpUrl, "the CLI shim reads the door, not a scope").toBe("http://127.0.0.1:9341");
  });

  it("leaves a conversation's session on the bare tunnel address when its door's proxy did not start (M)", async () => {
    const { offload } = harness({ task: { surface: "browser", surfaceSource: "auto" }, failProxy: true });
    const { close } = closer();
    const alias = offload.conversationSession("b1", "t1", "mychrome", close);
    expect(await offload.browserFor("b1", alias, "t1", "mychrome")).toBe("http://127.0.0.1:19341");
    expect(offload.guardState().cdpUrl).toBe("http://127.0.0.1:19341");
  });

  it("moves a conversation whose call opened a sign-in site through its scoped door too (N)", () => {
    const { offload } = harness({ task: { surface: "browser", surfaceSource: "auto" } });
    const alias = offload.conversationSession("b1", "t1", "mychrome", () => Promise.resolve());
    const scoped = `ws://127.0.0.1:9341/devtools/browser/omb-scope/${alias}`;
    expect(offload.authRefusal(alias, scoped, { name: "agent_browser_open", arguments: { url: "github.com/login" } }, { botId: "b1", threadId: "t1" })).toContain("github.com");
    expect(offload.authRefusal(alias, `ws://127.0.0.1:9342/devtools/browser/omb-scope/${alias}`, { name: "agent_browser_open", arguments: { url: "github.com/login" } }, { botId: "b1", threadId: "t1" }), "another machine's door").toBeNull();
  });

  it("reads a conversation's session without starting or closing anything, and caps each cloud Chrome's pages (O)", async () => {
    const { offload, proxies } = harness({ task: { surface: "browser", surfaceSource: "auto" } });
    const { closed, close } = closer();
    expect(offload.peekSession("b1", "t1", "mychrome")).toBe("mychrome");
    const alias = offload.conversationSession("b1", "t1", "mychrome", close);
    expect(offload.peekSession("b1", "t1", "mychrome")).toBe(alias);
    expect(offload.peekSession("b1", undefined, "mychrome")).toBe("mychrome");
    expect(offload.peekSession("b1", "other", "mychrome")).toBe("mychrome");
    expect(closed).toEqual([]);
    await offload.browserFor("b1", alias, "t1", "mychrome");
    expect(proxies.find((proxy) => proxy.port === 9341)?.pageCap).toEqual({ max: CLOUD_PAGE_CAP, countAll: false });
    const capped = harness({ cfg: { cloudOffload: { cloudPageCap: 3 } } });
    await capped.offload.browserFor("b1", "sess", "t1", "mychrome");
    expect(capped.proxies.find((proxy) => proxy.port === 9341)?.pageCap).toEqual({ max: 3, countAll: false });
  });

  it("keeps a temporary browser out of mychrome, and pins a bot set to require sign-ins", async () => {
    const temp = harness({ cfg: { cloudOffload: { requireAuthBots: ["b1"] } } });
    expect(await temp.offload.browserFor("b1", "sess", "t1", "guest")).toBe("http://127.0.0.1:9341");
    expect(await temp.offload.browserFor("b1", "sess", "t1", "mychrome")).toBe(`http://127.0.0.1:${MYCHROME_PROXY_PORT}`);
    expect(temp.bot.tasks[0]!.browserPlacement).toMatchObject({ browser: "mychrome（需登录：bot 设定）" });
  });

  it("serves only the bots' folders, never the home folder or above it", () => {
    const roots = servableRoots("/data/omb", ["/home/u/proj/site", "/home/u", "/home", "/", null], "/home/u");
    expect(roots).toEqual(["/data/omb/workspaces", "/data/omb/task-workspaces", "/home/u/proj/site"]);
  });

  it("changes nothing while no cloud machine is configured, though it is on by default", async () => {
    const { offload, patches, proxies, fallback } = harness({ cfg: { vps: { instances: [] } } });
    const { close, closed } = closer();
    expect(offload.conversationSession("b1", "t1", "mychrome", close)).toBe("mychrome");
    expect(await offload.browserFor("b1", "sess", "t1", "mychrome")).toBeUndefined();
    expect(await offload.browserFor("b1", "sess", "t1", undefined)).toBeUndefined();
    expect(offload.authRefusal("sess", "http://127.0.0.1:9339", { name: "agent_browser_open", arguments: { url: "https://github.com/login" } }, { botId: "b1", threadId: "t1" })).toBeNull();
    await offload.refreshGuard();
    expect(offload.guardState().cdpUrl).toBeNull();
    expect({ patches, proxies: proxies.length, ensured: fallback.ensured, closed }).toEqual({ patches: [], proxies: 0, ensured: 0, closed: [] });
  });

  it("stays out of the way when cloud offload is off", async () => {
    const { offload } = harness({ cfg: { cloudOffload: { enabled: false } } });
    expect(await offload.browserFor("b1", "sess", "t1", "mychrome")).toBeUndefined();
  });

  it("names browser profiles the way the header shows them", () => {
    expect(browserLabel("mychrome")).toBe("mychrome");
    expect(browserLabel("guest")).toBe("临时");
    expect(browserLabel(undefined)).toBe("内置");
  });

  it("sends every bot engine's Chrome to the cloud one, and leaves the env alone while unarmed or off (E73)", () => {
    const hook = (armed: boolean, off: boolean) => guardedEnvHook({
      armed: () => armed, off: () => off, shimDir: "/x/shim", stateFile: "/x/state",
      guard: () => ({ cdpUrl: "http://127.0.0.1:9341" }),
    });
    const env = { PATH: "/usr/bin" };
    expect(hook(true, false)(env)).toMatchObject({ PUPPETEER_EXECUTABLE_PATH: "/x/shim/chrome", OMB_CLOUD_CDP_URL: "http://127.0.0.1:9341" });
    expect(hook(false, false)(env)).toBe(env);
    expect(hook(true, true)(env)).toBe(env);
  });
});

describe("a relayed box's relay is up only while it is used (E80)", () => {
  function relayHarness() {
    let clock = 0;
    let connections = 0;
    const calls = { up: 0, light: 0, teardown: [] as string[] };
    const proxyOptions: CdpProxyOptions[] = [];
    const bots = [{ id: "b1", computer: null, tasks: [{ threadId: "t1" }] }];
    const store = { bots, bot: (id: string) => bots.find((bot) => bot.id === id), patchTask: () => null };
    const cloud: CloudBrowserDeps = {
      now: () => clock,
      ensureRemote: async (machine) => { if (machine.relayAlias) calls.up++; return { ok: true, load: machine.relayAlias ? 0.05 : 0.6 }; },
      ensureTunnel: async () => true,
      probe: async () => true,
      probeBox: async () => { calls.light++; return { ok: true, load: 0.05 }; },
      teardown: async (machine) => { calls.teardown.push(machine.name); },
    };
    const cfg = {
      vps: { instances: [{ id: "i1", name: "cloudA", kind: "ssh", sshAlias: "cloudA" }, { id: "box1", name: "box-one", kind: "mcp", adapter: "simular-box", mcpServer: "box-1" }] },
      cloudOffload: { boxRelayVia: "ssh:relay-host", boxRelayUser: "ombrelay" },
    } as unknown as AppConfig;
    const offload = createCloudOffload({
      cfg, dataDir: mkdtempSync(join(tmpdir(), "omb-offload-")), store: () => store as never, cloud, log: () => {},
      makeProxy: (options) => { proxyOptions.push(options); return { start: async () => options.port, close: async () => {}, url: `http://127.0.0.1:${options.port}`, connections: () => (options.port === 9351 ? connections : 0) }; },
      fallback: () => ({ ensure: async () => null, touch: () => {}, stop: async () => {}, startIdleSweep: () => () => {} }),
    });
    return { offload, calls, cloud, proxyOptions, tick: (ms: number) => { clock += ms; }, setConnections: (n: number) => { connections = n; } };
  }

  it("leaves a cold box alone from the guard, brings it up for a browser, keeps it while connected, and ends it idle", async () => {
    const { offload, calls, tick, setConnections } = relayHarness();
    await offload.refreshGuard();
    expect(calls).toMatchObject({ up: 0, light: 0 });
    expect(offload.guardState().cdpUrl).toBe("http://127.0.0.1:9341");

    expect(await offload.browserFor("b1", "sess", "t1", undefined)).toBe("http://127.0.0.1:9351");
    expect(calls.up).toBe(1);
    expect(offload.pool.warmBoxes()).toEqual(["box1"]);

    // Connected: kept however long it lasts.
    setConnections(1);
    tick(RELAY_IDLE_MS + 60_000);
    expect(await offload.sweepRelays()).toEqual([]);
    // Disconnected: kept until the idle time has passed since its last use, then ended once.
    setConnections(0);
    tick(RELAY_IDLE_MS - 60_000);
    expect(await offload.sweepRelays()).toEqual([]);
    tick(2 * 60_000);
    expect(await offload.sweepRelays()).toEqual(["box-one"]);
    expect(calls.teardown).toEqual(["box-one"]);
    expect(offload.pool.warmBoxes()).toEqual([]);
    // The guard was on the box's door: it moved back without asking the box.
    const up = calls.up;
    expect(offload.guardState().cdpUrl).toBe("http://127.0.0.1:9341");
    expect(await offload.sweepRelays()).toEqual([]);
    expect(calls.teardown).toEqual(["box-one"]);
    expect(calls.up).toBe(up);

    // The next browser call starts it again.
    expect(await offload.browserFor("b1", "sess", "t1", undefined)).toBe("http://127.0.0.1:9351");
    expect(calls.up).toBe(up + 1);
  });

  it("gives a relayed box's door a time limit, waits there for a rebuild under way, and rechecks the box after a timeout (E115)", async () => {
    const { offload, calls, cloud, proxyOptions } = relayHarness();
    expect(await offload.browserFor("b1", "sess", "t1", undefined)).toBe("http://127.0.0.1:9351");
    const door = proxyOptions.find((options) => options.port === 9351)!;
    expect(door.upstreamTimeoutMs).toBe(RELAY_UPSTREAM_TIMEOUT_MS);
    expect(typeof door.ensureUpstream).toBe("function");
    // The SSH machine's door keeps waiting as before.
    await offload.refreshGuard();
    expect(proxyOptions.find((options) => options.port === 9341)?.upstreamTimeoutMs).toBeUndefined();

    // Nothing under way: the door passes the call on at once.
    await door.ensureUpstream!();
    // A timeout forgets the box's answer, so the next browser call checks (and if need be repairs) it.
    const before = calls.up;
    door.onUpstreamTimeout!();
    let release: () => void = () => {};
    const original = cloud.ensureRemote;
    cloud.ensureRemote = (machine) => new Promise((resolve) => { release = () => void original(machine).then(resolve); });
    const picking = offload.browserFor("b1", "sess", "t1", undefined);
    await new Promise((r) => setTimeout(r, 10));
    let passed = false;
    const waiting = Promise.resolve(door.ensureUpstream!()).then(() => { passed = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(passed).toBe(false);
    release();
    await waiting;
    expect(passed).toBe(true);
    expect(await picking).toBe("http://127.0.0.1:9351");
    expect(calls.up).toBe(before + 1);
  });

  it("enforces V2 readiness deadline, rejects proxy bind failures, uses requestDrain on idle sweep, and supports hot-reload", async () => {
    vi.useFakeTimers();
    try {
      const store = {
        bots: [{ id: "b1", computer: null, vpsInstanceId: "box1", tasks: [{ threadId: "t1" }] }],
        bot: (id: string) => store.bots.find((b) => b.id === id),
        patchTask: () => null,
      };
      let clock = 0;
      let teardownCalls = 0;
      const cfg = {
        vps: {
          instances: [
            { id: "box1", name: "box-one", kind: "mcp", adapter: "simular-box", mcpServer: "box-1" },
            { id: "ssh2", name: "ssh-two", kind: "ssh", sshAlias: "ssh-two" },
          ],
        },
        cloudOffload: { boxRelayVia: "ssh:relay-host", boxRelayUser: "ombrelay", relayRecoveryV2: true },
      } as unknown as AppConfig;

      let failRemote = true;
      const cloud: CloudBrowserDeps = {
        now: () => clock,
        ensureRemote: async (machine) => {
          if (machine.id === "box1") return failRemote ? { ok: false, detail: "休眠中" } : { ok: true, load: 0.1 };
          return { ok: true, load: 0.2 };
        },
        ensureTunnel: async () => true,
        probe: async () => true,
        probeBox: async () => ({ ok: true, load: 0.1 }),
        teardown: async () => { teardownCalls += 1; },
      };

      let rejectProxy = true;
      const offload = createCloudOffload({
        cfg,
        dataDir: mkdtempSync(join(tmpdir(), "omb-offload-v2-")),
        store: () => store as never,
        cloud,
        log: () => {},
        makeProxy: (options) => ({
          start: async () => {
            if (rejectProxy) throw new Error("EADDRINUSE");
            return options.port;
          },
          close: async () => {},
          url: `http://127.0.0.1:${options.port}`,
          connections: () => 0,
        }),
        fallback: () => ({ ensure: async () => null, touch: () => {}, stop: async () => {}, startIdleSweep: () => () => {} }),
      });

      // V2 rejects proxy bind failure with RelayError instead of exposing bare tunnel URL.
      await expect(offload.browserFor("b1", "s1", "t1", undefined)).rejects.toThrow(RelayError);

      // Allow proxy start and bring up box1; tight budget (<5s reserve) rejects before dispatching.
      rejectProxy = false;
      failRemote = false;
      clock += 5 * 60_000 + 1_000;
      await expect(offload.browserFor("b1", "s2", "t1", undefined, { deadline: clock + 4_000 })).rejects.toMatchObject({ code: "RELAY_RECOVERY_TIMEOUT", sent: false });
      expect(await offload.browserFor("b1", "s2", "t1", undefined)).toBe("http://127.0.0.1:9351");

      // Active lease prevents idle teardown; once released and idle elapsed, requestDrain tears down exactly once even after config removal.
      const lease = offload.pool.acquireLease("box1");
      expect(lease).not.toBeNull();
      clock += RELAY_IDLE_MS + 10_000;
      expect(await offload.sweepRelays()).toEqual([]);
      expect(teardownCalls).toBe(0);
      lease!.release();
      (cfg.vps as { instances: unknown[] }).instances = [];
      clock += RELAY_IDLE_MS + 10_000;
      expect(await offload.sweepRelays()).toEqual(["box1"]);
      expect(teardownCalls).toBe(1);

      // Hot-reload toggle off restores legacy fallback behavior.
      cfg.cloudOffload!.relayRecoveryV2 = false;
      expect(offload.pool.phaseOf("box1")).toBe("cold");
    } finally {
      vi.useRealTimers();
    }
  });
});
