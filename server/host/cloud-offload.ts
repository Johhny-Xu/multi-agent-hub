// FEAT-cloud-offload as the server hosts it: where an Auto bot's browser runs (a cloud machine first, this host only
// when none answers), what the chat header says about it (E72), and the guard that keeps the bots' own headless Chrome
// off this host (E73). PLAN-C2: every browser is reached through a CDP proxy (cloud-cdp-proxy.ts): a cloud Chrome's
// proxy serves this host's files and dev servers to it (T1) and turns sign-in sites away to mychrome (T2); this host's
// own Chromes get a two-page cap, and the fallback Chrome is one capped instance closed when idle (T3).
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { browserEngineAttachCdpUrl, type AppConfig } from "../config.ts";
import { chosenPlace } from "../computer-selection.ts";
import { CdpProxy, type CdpProxyOptions } from "../cloud-cdp-proxy.ts";
import { cdpUrlPort, scopedCdpUrl } from "../cloud-cdp-scope.ts";
import { CloudBrowserPool, authDomainOf, authDomains, cloudBrowserMachines, cloudOffloadActive, sshCloudBrowserDeps, type BoxShell, type CloudBrowserDeps, type CloudBrowserMachine } from "../cloud-browser.ts";
import { RemoteMcpClient } from "../mcp-http.ts";
import { isRemoteMcpServer, parseStoredMcpServer } from "../mcp-registry.ts";
import { guardedBotEnv, startHeadlessChromeSweep, writeChromeShims, writeGuardState, type GuardState } from "../local-chrome-guard.ts";
import { LOCAL_CHROME_PORT, LocalChromePool, realLocalChromeDeps } from "../local-chrome-pool.ts";
import { setBotSpawnEnvHook } from "../procs.ts";
import type { Store } from "../store.ts";
import type { BrowserPlacement } from "../../shared/wire.ts";

/** The pick a guard refresh keeps for itself, apart from any bot's session. */
const GUARD_SESSION = "__omb_cloud_guard__";
const REFRESH_MS = 120_000;
/** This host's capped doors: mychrome's (the person's signed-in Chrome) and the fallback Chrome's. */
export const MYCHROME_PROXY_PORT = 9343;
export const FALLBACK_PROXY_PORT = 9344;
/** This host's Chromes keep at most this many pages open at once; more wait their turn. */
export const LOCAL_PAGE_CAP = 2;
/** A cloud machine's Chrome keeps at most this many pages open at once, every conversation's together. */
export const CLOUD_PAGE_CAP = 6;
/** A session that opened a sign-in site stays on mychrome this long after its last one. */
export const AUTH_STICKY_MS = 30 * 60_000;
/** A relayed Simular box (T6) keeps its relay up only while it is used: with no CDP connection on its door and no
 * use for this long, its relay, its Chrome and this host's tunnel to it are ended; the next pick starts them again
 * (E80: a link held open keeps the relay host and the box from ever idling). */
export const RELAY_IDLE_MS = 10 * 60_000;
const RELAY_SWEEP_MS = 60_000;
/** Tools whose url argument opens a page. */
const OPENING_TOOLS = new Set(["agent_browser_open", "agent_browser_navigate", "agent_browser_tab_new"]);

export interface ProxyHandle { start(): Promise<number>; close(): Promise<void>; readonly url: string; connections(): number }
export interface FallbackChrome { ensure(): Promise<string | null>; touch(): void; stop(): Promise<void>; startIdleSweep(intervalMs?: number): () => void }

export interface CloudOffloadDeps {
  cfg: AppConfig;
  dataDir: string;
  store(): Pick<Store, "bot" | "patchTask"> & { bots?: Store["bots"] };
  /** Tests give their own machines' answers. */
  cloud?: CloudBrowserDeps & { close?(): void };
  /** Tests give proxies that bind nothing. */
  makeProxy?(options: CdpProxyOptions): ProxyHandle;
  /** Tests give a fallback Chrome that starts nothing. */
  fallback?(connections: () => number): FallbackChrome;
  log?(line: string): void;
}

/** The browser profile's name as the header shows it: "mychrome", "临时", "内置". */
export function browserLabel(profile: string | undefined): string {
  if (profile === "guest") return "临时";
  return profile?.trim() || "内置";
}

/** Folders a cloud Chrome may be served from: the bots' own and their conversations', never the home folder itself or
 * anything above it (a bot set to work in ~ must not hand out ~/.ssh). */
export function servableRoots(dataDir: string, cwds: readonly (string | null | undefined)[], home = homedir()): string[] {
  const homeAbs = resolve(home);
  const safe = (dir: string) => {
    const abs = resolve(dir);
    if (abs.split(sep).filter(Boolean).length < 3) return false;
    return !(homeAbs === abs || homeAbs.startsWith(abs + sep));
  };
  const roots = [join(dataDir, "workspaces"), join(dataDir, "task-workspaces"), ...cwds.filter((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0)];
  return [...new Set(roots.map((root) => resolve(root)))].filter(safe);
}

/** Whether an agent-browser session name is one conversation's own, on a cloud door (`.c-` or `.auth-` and ten hex). */
export function isConversationAlias(session: string): boolean {
  return /\.(c|auth)-[0-9a-f]{10}$/.test(session);
}

/** T6: a Simular box's state and shell over its saved MCP connection; the connection's credential stays in it. */
export function mcpBoxShell(cfg: Pick<AppConfig, "mcpServers">): BoxShell {
  async function call(server: string, tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<{ text: string; state?: unknown }> {
    const raw = cfg.mcpServers?.[server];
    const parsed = raw === undefined ? null : parseStoredMcpServer(server, raw);
    if (!parsed?.ok || !isRemoteMcpServer(parsed.server) || parsed.server.enabled === false) throw new Error("no MCP connection");
    const client = new RemoteMcpClient({ type: parsed.server.type, url: parsed.server.url, headers: parsed.server.headers } as never);
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      await client.initialize("omb-cloud-browser", signal);
      const result = await client.request("tools/call", { name: tool, arguments: args }, signal) as { content?: Array<{ type?: string; text?: string }>; structuredContent?: { state?: unknown } };
      return { text: (result?.content ?? []).map((part) => part.type === "text" ? part.text ?? "" : "").join(""), state: result?.structuredContent?.state };
    } finally {
      await client.close().catch(() => {});
    }
  }
  return {
    // A health check must not wake a hibernated box: only a running one is asked for its Chrome.
    running: async (server) => (await call(server, "box_status", {}, 20_000)).state === "running",
    shell: async (server, command) => (await call(server, "shell", { command, timeout_s: 60 }, 90_000)).text,
  };
}

export function createCloudOffload(deps: CloudOffloadDeps) {
  const { cfg } = deps;
  const log = deps.log ?? ((line: string) => console.warn(line));
  let pool: CloudBrowserPool;
  const cloud = deps.cloud ?? sshCloudBrowserDeps({ log, box: mcpBoxShell(cfg), onTunnelExit: (machine) => {
    // A dead tunnel is opened again by the next pick; the guard's pick comes soon so CLIs are not left on it.
    pool.invalidate(machine.id);
    const retry = setTimeout(() => void refreshGuard().catch(() => {}), 3_000);
    retry.unref?.();
  } });
  pool = new CloudBrowserPool(cloud);
  const makeProxy = deps.makeProxy ?? ((options: CdpProxyOptions) => new CdpProxy(options));
  const guardDir = join(deps.dataDir, "cloud-offload");
  const shimDir = join(guardDir, "bin");
  const stateFile = join(guardDir, "cdp-url");
  let guard: GuardState = { cdpUrl: null };
  let stopSweep: (() => void) | null = null;
  let stopIdle: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let relayTimer: ReturnType<typeof setInterval> | null = null;
  /** When each relayed box was last used: picked for a browser, or traffic through its door. */
  const relayUse = new Map<string, number>();
  const relayDoors = new Map<string, ProxyHandle>();
  const touchRelay = (machine: CloudBrowserMachine | undefined) => {
    if (machine?.relayAlias) relayUse.set(machine.id, cloud.now());
  };
  const proxies = new Map<string, Promise<string>>();
  const proxyHandles: ProxyHandle[] = [];
  /** The doors a proxy really took: a bare tunnel address a fallback left behind answers no scoped connection. */
  const startedDoors = new Set<string>();
  const authSessions = new Map<string, { domain: string; at: number }>();
  /** The agent-browser session each conversation of a cloud browser runs in, apart from the one its bot shares. */
  const aliases = new Map<string, string>();
  const convoKey = (botId: string, threadId: string) => `${botId}\n${threadId}`;

  const roots = () => {
    const store = deps.store();
    const cwds = (store.bots ?? []).flatMap((bot) => [(bot as { cwd?: string | null }).cwd, ...(bot.tasks ?? []).map((task) => task.cwd)]);
    return servableRoots(deps.dataDir, cwds);
  };
  const authDomain = (url: string) => authDomainOf(url, authDomains(cfg));

  /** Starts a proxy once per port; a port it cannot take (an old tunnel still on it) leaves `fallbackUrl` in use. */
  function door(key: string, options: CdpProxyOptions, fallbackUrl: string, onStarted?: (proxy: ProxyHandle) => void): Promise<string> {
    let open = proxies.get(key);
    if (!open) {
      const proxy = makeProxy(options);
      open = proxy.start().then(() => {
        proxyHandles.push(proxy);
        onStarted?.(proxy);
        startedDoors.add(proxy.url);
        return proxy.url;
      }, (error: unknown) => {
        proxies.delete(key);
        log(`cloud offload: CDP proxy on ${options.port} not started (${error instanceof Error ? error.message : String(error)}); using ${fallbackUrl} directly`);
        return fallbackUrl;
      });
      proxies.set(key, open);
    }
    return open;
  }

  function cloudDoor(machine: CloudBrowserMachine, tunnelUrl: string): Promise<string> {
    if (!machine.proxyPort) return Promise.resolve(tunnelUrl);
    return door(`cloud:${machine.id}`, {
      upstream: tunnelUrl, port: machine.proxyPort,
      scopeStateFile: join(guardDir, `scoped-pages-${machine.proxyPort}.json`),
      local: { roots },
      authDomain,
      onAuthBlocked: (domain, url) => log(`cloud offload: ${new URL(url).host} needs a sign-in (${domain}); a CLI was sent to mychrome`),
      pageCap: { max: cfg.cloudOffload?.cloudPageCap ?? CLOUD_PAGE_CAP, countAll: false },
      lowFpsLive: true,
      ...(machine.relayAlias ? { onActivity: () => touchRelay(machine) } : {}),
      log,
    }, tunnelUrl, machine.relayAlias ? (proxy) => relayDoors.set(machine.id, proxy) : undefined);
  }

  /** E80: ends the relay of every relayed box that has had no CDP connection and no use for RELAY_IDLE_MS. A box with
   * a connection on its door counts as in use. Returns the names of the boxes it ended. */
  async function sweepRelays(): Promise<string[]> {
    const ended: string[] = [];
    const now = cloud.now();
    const machines = cloudBrowserMachines(cfg);
    for (const id of pool.warmBoxes()) {
      const machine = machines.find((candidate) => candidate.id === id);
      if ((relayDoors.get(id)?.connections() ?? 0) > 0) {
        relayUse.set(id, now);
        continue;
      }
      const last = relayUse.get(id) ?? now;
      if (!relayUse.has(id)) relayUse.set(id, now);
      if (machine && now - last < RELAY_IDLE_MS) continue;
      pool.release(id);
      relayUse.delete(id);
      ended.push(machine?.name ?? id);
      if (machine) {
        log(`cloud offload: ${machine.name} relay idle ${Math.round((now - last) / 60_000)} min, ended (E80)`);
        await cloud.teardown?.(machine).catch((error: unknown) => log(`cloud offload: ${machine.name} relay teardown failed: ${error instanceof Error ? error.message : String(error)}`));
      }
      // The guard may have pointed the CLIs at that box's door: it picks again, without the box.
      if (machine?.proxyPort && guard.cdpUrl === `http://127.0.0.1:${machine.proxyPort}`) await refreshGuard().catch(() => {});
    }
    return ended;
  }

  function mychromeUpstream(): string {
    return browserEngineAttachCdpUrl(cfg) ?? "http://127.0.0.1:9333";
  }
  function mychromeDoor(): Promise<string> {
    const upstream = mychromeUpstream();
    return door("mychrome", {
      upstream, port: MYCHROME_PROXY_PORT,
      scopeStateFile: join(guardDir, `scoped-pages-${MYCHROME_PROXY_PORT}.json`),
      pageCap: { max: LOCAL_PAGE_CAP, countAll: false }, log,
    }, upstream);
  }

  let fallbackChrome: FallbackChrome | null = null;
  let fallbackProxy: ProxyHandle | null = null;
  function fallbackDoor(): Promise<string> {
    if (!fallbackChrome) {
      const connections = () => fallbackProxy?.connections() ?? 0;
      fallbackChrome = deps.fallback ? deps.fallback(connections) : new LocalChromePool({ userDataDir: join(guardDir, "local-chrome"), deps: realLocalChromeDeps(connections, log) });
      stopIdle = fallbackChrome.startIdleSweep();
    }
    const chrome = fallbackChrome;
    const upstream = `http://127.0.0.1:${LOCAL_CHROME_PORT}`;
    return door("fallback", {
      upstream, port: FALLBACK_PROXY_PORT,
      scopeStateFile: join(guardDir, `scoped-pages-${FALLBACK_PROXY_PORT}.json`),
      pageCap: { max: LOCAL_PAGE_CAP, countAll: true },
      ensureUpstream: async () => { await chrome.ensure(); },
      onActivity: () => chrome.touch(),
      log,
    }, upstream).then((url) => {
      if (!fallbackProxy) fallbackProxy = proxyHandles.find((proxy) => proxy.url === url) ?? null;
      return url;
    });
  }

  const noteGuard = (cdpUrl: string | null) => {
    if (guard.cdpUrl === cdpUrl) return;
    guard = { ...guard, cdpUrl };
    writeGuardState(stateFile, guard);
  };

  /** Where a pick's tunnel URL is reached: its machine's proxy. */
  async function doorFor(pickUrl: string): Promise<string> {
    const machine = cloudBrowserMachines(cfg).find((candidate) => candidate.localPort && pickUrl === `http://127.0.0.1:${candidate.localPort}`);
    return machine ? cloudDoor(machine, pickUrl) : pickUrl;
  }

  async function refreshGuard(): Promise<void> {
    if (!cloudOffloadActive(cfg)) return noteGuard(null);
    // The background pick never brings a relayed box's relay up, nor keeps it busy (E80).
    const pick = await pool.pick(cloudBrowserMachines(cfg), GUARD_SESSION, "本机", { passive: true });
    // With no cloud Chrome a CLI still gets one Chrome here: the capped fallback, started when it connects.
    noteGuard(pick.cdpUrl ? await doorFor(pick.cdpUrl) : await fallbackDoor());
  }

  /** Which sign-in domain, if any, a conversation's browser is stuck on: its own need, or its bot's setting. */
  function authFor(botId: string, threadId: string | undefined): string | null {
    if ((cfg.cloudOffload?.requireAuthBots ?? []).includes(botId)) return "bot 设定";
    if (!threadId) return null;
    const key = convoKey(botId, threadId);
    const sticky = authSessions.get(key);
    if (!sticky) return null;
    if (Date.now() - sticky.at > AUTH_STICKY_MS) {
      authSessions.delete(key);
      return null;
    }
    return sticky.domain;
  }

  /** The agent-browser session a conversation's browser is on a cloud door: its own, so one conversation never drives
   * another's page; its own again while it needs a sign-in, closing the first; or the one its bot shares when it keeps a
   * browser the person chose. */
  function conversationSession(botId: string, threadId: string | undefined, base: string, close: (session: string) => Promise<void>): string {
    if (!cloudOffloadActive(cfg) || !threadId) return base;
    const key = convoKey(botId, threadId);
    const bot = deps.store().bot(botId);
    const task = bot?.tasks?.find((candidate) => candidate.threadId === threadId);
    if (chosenPlace(task, bot?.computer ?? undefined) !== undefined) {
      // A place the person chose keeps the browser it names, and this conversation's own session goes.
      const stale = aliases.get(key);
      if (stale) {
        aliases.delete(key);
        void close(stale).catch(() => {});
      }
      return base;
    }
    const auth = authFor(botId, threadId);
    const want = `${base.slice(0, 80)}.${auth ? "auth" : "c"}-${createHash("sha1").update(botId + "\n" + threadId).digest("hex").slice(0, 10)}`;
    const stale = aliases.get(key);
    if (stale && stale !== want) void close(stale).catch(() => {});
    aliases.set(key, want);
    return want;
  }

  /** The alias a conversation's browser runs in, without starting or closing anything. */
  function peekSession(botId: string, threadId: string | undefined, base: string): string {
    return threadId ? aliases.get(convoKey(botId, threadId)) ?? base : base;
  }

  const usesMyChromeProfile = (profile: string | undefined) => Boolean(profile) && cfg.browserProfiles?.some((candidate) => candidate.id === profile && candidate.browser === "chrome") === true;

  /** The DevTools URL a bot's browser attaches to this turn, or undefined for this host's own browser as configured.
   * Only Auto picks: a place the person chose (a pin, the bot's Works on) keeps the browser it names. */
  async function browserFor(botId: string, session: string, threadId: string | undefined, profile: string | undefined): Promise<string | undefined> {
    const store = deps.store();
    const bot = store.bot(botId);
    if (!bot) return undefined;
    const task = threadId ? bot.tasks?.find((candidate) => candidate.threadId === threadId) : undefined;
    const record = (placement: BrowserPlacement | undefined) => {
      if (!threadId || !task) return;
      // The same machine and browser keep the first reason: "沿用 <machine>" would only churn the header.
      const key = (value: BrowserPlacement | undefined) => value ? [value.machine, value.browser, value.cloud].join("|") : "";
      if (key(task.browserPlacement) === key(placement)) return;
      store.patchTask(botId, threadId, { browserPlacement: placement });
    };
    if (!cloudOffloadActive(cfg) || chosenPlace(task, bot.computer ?? undefined) !== undefined) {
      record(undefined);
      return undefined;
    }
    // A conversation's own session reaches the Chrome through its own scope, so its pages are the only ones it drives.
    const scoped = (url: string) => isConversationAlias(session) && startedDoors.has(url) ? scopedCdpUrl(url, session) : url;
    const auth = profile === "guest" ? null : authFor(botId, threadId);
    if (auth) {
      const url = await mychromeDoor();
      record({ machine: "本机", browser: `mychrome（需登录：${auth}）`, cloud: false, reason: `需登录站点（${auth}）用本机已登录的 mychrome，不把登录态复制到云端` });
      return scoped(url);
    }
    const machines = cloudBrowserMachines(cfg);
    const pick = await pool.pick(machines, session);
    if (pick.cdpUrl) {
      touchRelay(machines.find((machine) => machine.name === pick.machine));
      const url = await doorFor(pick.cdpUrl);
      noteGuard(url);
      record({ machine: pick.machine, browser: browserLabel(profile), cloud: true, reason: pick.reason });
      return scoped(url);
    }
    // No cloud Chrome: mychrome bots keep the person's Chrome (capped), the rest share one capped fallback Chrome.
    const url = usesMyChromeProfile(profile) ? await mychromeDoor() : await fallbackDoor();
    record({ machine: pick.machine, browser: usesMyChromeProfile(profile) ? "mychrome" : "回落 Chrome", cloud: false, reason: `${pick.reason}（本机最多 ${LOCAL_PAGE_CAP} 页${usesMyChromeProfile(profile) ? "" : "，空闲 90 秒关闭"}）` });
    return scoped(url);
  }

  /** Whether `cdpUrl` is one of the cloud machines' doors, scoped or not. */
  function isCloudUrl(cdpUrl: string | undefined): boolean {
    const port = cdpUrlPort(cdpUrl);
    if (port === null) return false;
    return cloudBrowserMachines(cfg).some((machine) => [machine.proxyPort, machine.localPort].some((candidate) => candidate === port));
  }

  /** T2 for OpenMausBot's own browser tools: a call that opens a sign-in site in a cloud Chrome moves the conversation
   * that made it to mychrome, and only that one. The call itself is refused with what happened; the shared cloud
   * connection stays open for every other conversation. Returns the text for the bot, or null to let the call through. */
  function authRefusal(_session: string, cdpUrl: string | undefined, params: unknown, who: { botId: string; threadId: string } | undefined): string | null {
    if (!cloudOffloadActive(cfg) || !isCloudUrl(cdpUrl)) return null;
    const call = params as { name?: unknown; arguments?: { url?: unknown } } | null;
    if (typeof call?.name !== "string" || !OPENING_TOOLS.has(call.name) || typeof call.arguments?.url !== "string") return null;
    const domain = authDomain(/^[a-z][a-z0-9+.-]*:/i.test(call.arguments.url) ? call.arguments.url : `https://${call.arguments.url}`);
    if (!domain || !who) return null;
    const key = convoKey(who.botId, who.threadId);
    authSessions.set(key, { domain, at: Date.now() });
    const store = deps.store();
    const task = store.bot(who.botId)?.tasks?.find((candidate) => candidate.threadId === who.threadId);
    if (task) store.patchTask(who.botId, who.threadId, { browserPlacement: { machine: "本机", browser: `mychrome（需登录：${domain}）`, cloud: false, reason: `需登录站点（${domain}）用本机已登录的 mychrome` } });
    log(`cloud offload: bot ${who.botId} thread ${who.threadId} opened ${domain}; this conversation moved to mychrome`);
    return `「${domain}」需要登录：云端浏览器没有登录态，这个对话的浏览器已切换到本机已登录的共享浏览器 mychrome（其他对话仍用云端）。请再调用一次刚才的 ${call.name}（之前的 @eN 引用作废）。`;
  }

  return {
    browserFor,
    authRefusal,
    conversationSession,
    peekSession,
    pool,
    refreshGuard,
    sweepRelays,
    shimDir,
    stateFile,
    guardState: () => guard,
    start(): void {
      if (process.env.VITEST) return;
      // Nothing is written, swept or injected until a cloud machine is configured; adding one later arms it on the next tick.
      let shims = false;
      const arm = () => {
        if (!cloudOffloadActive(cfg)) return;
        if (!shims) {
          try {
            writeChromeShims(shimDir);
            writeGuardState(stateFile, guard);
            shims = true;
          } catch (error) {
            log(`cloud offload: chrome shims not written: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (!stopSweep && cfg.cloudOffload?.guard !== false) stopSweep = startHeadlessChromeSweep({ log });
      };
      setBotSpawnEnvHook((env) => shims && cloudOffloadActive(cfg) && cfg.cloudOffload?.guard !== false ? guardedBotEnv(env, shimDir, stateFile, guard) : env);
      const tick = () => {
        arm();
        void refreshGuard().catch(() => {});
      };
      tick();
      timer = setInterval(tick, REFRESH_MS);
      timer.unref?.();
      relayTimer = setInterval(() => void sweepRelays().catch(() => {}), RELAY_SWEEP_MS);
      relayTimer.unref?.();
    },
    close(): void {
      stopSweep?.();
      stopIdle?.();
      if (timer) clearInterval(timer);
      if (relayTimer) clearInterval(relayTimer);
      // A relay left up would hold the relay host's link with no server to end it; the box also ends it by itself
      // after BOX_RELAY_IDLE_S with nothing relayed.
      const machines = cloudBrowserMachines(cfg);
      for (const id of pool.warmBoxes()) {
        const machine = machines.find((candidate) => candidate.id === id);
        if (machine) void cloud.teardown?.(machine).catch(() => {});
      }
      setBotSpawnEnvHook(null);
      cloud.close?.();
      for (const proxy of proxyHandles) void proxy.close().catch(() => {});
      void fallbackChrome?.stop().catch(() => {});
    },
  };
}
