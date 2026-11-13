// FEAT-cloud-offload / E72 / E73: an Auto bot's browser runs on a cloud machine (the configured VPS computers and
// Simular boxes), never on this host while one is up. Each SSH machine gets one headless Chrome on its
// own loopback (REMOTE_CDP_PORT) and one SSH tunnel to it from here; the least loaded machine that answers wins, a
// session keeps the machine it started on while that one still answers, and only when none answers does the browser
// fall back to this host's own Chrome. The pick is what the chat header shows ("浏览器 · <machine> / <profile>").
import { spawn } from "node:child_process";

import { boxDownScript, boxSshConfig, boxUpScript, parseBoxPub, relayHostDownScript, relayHostScript, sshResolve } from "./cloud-box-relay.ts";
import type { AppConfig } from "./config.ts";

/** Where every cloud machine's Chrome listens, on that machine's own loopback only. */
export const REMOTE_CDP_PORT = 9335;
/** Where CLIs reach the nth SSH machine's Chrome: the CDP proxy (cloud-cdp-proxy.ts) on LOCAL_CDP_BASE + n. */
export const LOCAL_CDP_BASE = 9341;
/** The proxy's upstream: the nth machine's SSH tunnel ends here on TUNNEL_CDP_BASE + n, internal to this host. */
export const TUNNEL_CDP_BASE = 19341;
/** A Simular box relayed through an SSH machine (cloud-box-relay.ts): its proxy door, this host's tunnel end, and the
 * relay host's loopback port that reaches the box's Chrome, each + n for the nth box. Apart from 9343/9344 (mychrome,
 * fallback). */
export const BOX_LOCAL_CDP_BASE = 9351;
export const BOX_TUNNEL_CDP_BASE = 19351;
export const BOX_RELAY_PORT_BASE = 19400;
/** The Simular box's own proxies on its loopback: it has no direct route out. */
const BOX_HTTP_PROXY_PORT = 3128;
const BOX_SOCKS_PORT = 1080;
/** Sites that need a sign-in: an Auto browser opening one goes to this host's signed-in mychrome instead of a cloud
 * Chrome, whose profile has no sign-ins. Cookies are never copied to a cloud machine (country hops lock accounts). */
export const DEFAULT_AUTH_DOMAINS: readonly string[] = [
  "google.com", "github.com", "x.com", "twitter.com", "doubao.com", "meoo.com", "qoder.com", "qoder.com.cn",
  "codebuddy.ai", "codebuddy.cn", "minimax.io", "minimaxi.com", "z.ai", "bigmodel.cn", "perchai.app", "trae.cn",
  "trae.com.cn", "huaweicloud.com", "kimi.com",
];
/** How long a machine's health stays good enough to pick it without asking again. */
const HEALTH_TTL_MS = 30_000;
/** A relayed box's check costs two MCP calls and an SSH round trip (~9 s, measured), and every pick waits for it:
 * it is asked again only every 5 minutes. A browser call that fails on it invalidates the answer sooner. */
const BOX_HEALTH_TTL_MS = 5 * 60_000;

export interface CloudBrowserMachine {
  id: string;
  name: string;
  kind: "ssh" | "mcp";
  sshAlias?: string;
  /** A DevTools URL the person configured for a machine with no SSH (a Simular box with its own tunnel). */
  cdpUrl?: string;
  /** This host's tunnel port for an SSH machine (internal; CLIs use proxyPort). */
  localPort?: number;
  /** This host's CDP proxy port for an SSH machine, the URL a browser attaches to. */
  proxyPort?: number;
  /** A relayed box: its MCP server, the SSH machine its Chrome is relayed through, and the relay's port there. */
  mcpServer?: string;
  relayAlias?: string;
  relayPort?: number;
  /** The dedicated, locked-down account the box logs in to the relay host as (cloudOffload.boxRelayUser); unset, the
   * box gets the relay host's own login as this host's ssh config has it. */
  relayUser?: string;
}

export interface MachineHealth {
  ok: boolean;
  /** One-minute load per core, 0–n; lower is idler. */
  load?: number;
  cdpUrl?: string;
  /** Why it is not usable: "没有 Chrome", "SSH 不通", "无 CDP 通道". */
  detail?: string;
  /** A relayed box that is awake but whose relay is not up (E80): it can be picked, and is brought up only then. */
  cold?: boolean;
}

export interface CloudBrowserPick {
  /** The machine the browser runs on: a cloud machine's name, or "本机". */
  machine: string;
  cloud: boolean;
  /** The DevTools URL to attach to; null means this host's own browser as configured. */
  cdpUrl: string | null;
  reason: string;
}

export interface CloudBrowserDeps {
  /** Starts the machine's Chrome when it is not up and reports its load; never throws. */
  ensureRemote(machine: CloudBrowserMachine): Promise<MachineHealth>;
  /** Keeps a tunnel from localPort here to the machine's Chrome (and its file port back); idempotent. */
  ensureTunnel(machine: CloudBrowserMachine): Promise<boolean>;
  probe(url: string): Promise<boolean>;
  now(): number;
  log?(line: string): void;
  /** A relayed box's load without starting anything on it, its relay or Chrome (E80); never wakes a sleeping box. */
  probeBox?(machine: CloudBrowserMachine): Promise<MachineHealth>;
  /** Ends a relayed box's relay and Chrome, and this host's tunnel to it (idle teardown, E80). */
  teardown?(machine: CloudBrowserMachine): Promise<void>;
}

/** A pick for a browser call ("demand") may bring a relayed box's relay up; the guard's background pick ("passive")
 * uses one only while it is already up and recently checked, and never asks it anything (E80). */
export interface PickOptions { passive?: boolean }

export function cloudOffloadOn(cfg: Pick<AppConfig, "cloudOffload">): boolean {
  return cfg.cloudOffload?.enabled !== false;
}

/** On, and with a cloud machine configured to run browsers on: without one the offload leaves this host as it was. */
export function cloudOffloadActive(cfg: Pick<AppConfig, "cloudOffload" | "vps">): boolean {
  return cloudOffloadOn(cfg) && cloudBrowserMachines(cfg).length > 0;
}

/** The sign-in sites as configured (lowercase hosts), the defaults while the person set none. */
export function authDomains(cfg: Pick<AppConfig, "cloudOffload">): string[] {
  const set = cfg.cloudOffload?.authDomains;
  return (Array.isArray(set) ? set : DEFAULT_AUTH_DOMAINS).map((domain) => domain.trim().toLowerCase()).filter(Boolean);
}

/** The sign-in site `url` opens (the configured entry it matches), or null. Subdomains match: accounts.google.com. */
export function authDomainOf(url: string, domains: readonly string[]): string | null {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  return domains.find((domain) => host === domain || host.endsWith(`.${domain}`)) ?? null;
}

/** What the settings page shows and edits. */
export function cloudOffloadSettings(cfg: Pick<AppConfig, "cloudOffload">): { enabled: boolean; guard: boolean; authDomains: string[] } {
  return { enabled: cloudOffloadOn(cfg), guard: cfg.cloudOffload?.guard !== false, authDomains: authDomains(cfg) };
}

/** The cloud machines a browser may run on, in the order the person added them; SSH machines get tunnel ports. */
export function cloudBrowserMachines(cfg: Pick<AppConfig, "vps"> & Partial<Pick<AppConfig, "cloudOffload">>): CloudBrowserMachine[] {
  const instances = (cfg.vps as { instances?: Array<Record<string, unknown>> } | undefined)?.instances ?? [];
  // The SSH machine boxes are relayed through, named by its id or name in the settings; off while unset. "ssh:<alias>"
  // names a relay-only host from this host's ssh config instead: never a VPS computer, never a browser machine.
  const via = cfg.cloudOffload?.boxRelayVia;
  const relayOnly = via?.startsWith("ssh:") ? via.slice(4) : undefined;
  const relay = via && !relayOnly ? instances.find((instance) => instance.kind === "ssh" && (instance.id === via || instance.name === via)) : undefined;
  const aliasOf = relayOnly ?? relay?.sshAlias;
  const relayAlias = typeof aliasOf === "string" && /^[A-Za-z0-9_.-]+$/.test(aliasOf) ? aliasOf : undefined;
  const user = cfg.cloudOffload?.boxRelayUser;
  const relayUser = typeof user === "string" && /^[a-z_][a-z0-9_-]{0,31}$/.test(user) ? user : undefined;
  let ssh = 0;
  let boxes = 0;
  const machines: CloudBrowserMachine[] = [];
  for (const instance of instances) {
    const id = typeof instance.id === "string" ? instance.id : "";
    const name = typeof instance.name === "string" && instance.name.trim() ? instance.name.trim() : id;
    if (!id) continue;
    const cdpUrl = typeof instance.browserCdpUrl === "string" && /^https?:\/\/[^\s]+$/.test(instance.browserCdpUrl) ? instance.browserCdpUrl : undefined;
    if (instance.kind === "ssh" && typeof instance.sshAlias === "string" && /^[A-Za-z0-9_.-]+$/.test(instance.sshAlias)) {
      machines.push({ id, name, kind: "ssh", sshAlias: instance.sshAlias, localPort: TUNNEL_CDP_BASE + ssh, proxyPort: LOCAL_CDP_BASE + ssh });
      ssh++;
    } else if (instance.kind === "mcp") {
      const server = typeof instance.mcpServer === "string" ? instance.mcpServer : "";
      if (!cdpUrl && relayAlias && server && instance.adapter === "simular-box") {
        machines.push({ id, name, kind: "mcp", mcpServer: server, relayAlias, relayPort: BOX_RELAY_PORT_BASE + boxes, localPort: BOX_TUNNEL_CDP_BASE + boxes, proxyPort: BOX_LOCAL_CDP_BASE + boxes, ...(relayUser ? { relayUser } : {}) });
        boxes++;
      } else machines.push({ id, name, kind: "mcp", ...(cdpUrl ? { cdpUrl } : {}) });
    }
  }
  return machines;
}

const pct = (load: number | undefined) => load === undefined ? "?" : `${Math.round(load * 100)}%`;

/** Chooses, and remembers, where each browser session runs. */
export class CloudBrowserPool {
  readonly #deps: CloudBrowserDeps;
  readonly #health = new Map<string, { at: number; health: MachineHealth }>();
  readonly #sticky = new Map<string, string>();
  readonly #inflight = new Map<string, Promise<MachineHealth>>();
  /** Relayed boxes whose relay a demand pick brought up and no teardown has ended since (E80). */
  readonly #warm = new Set<string>();
  /** A cold relayed box's light answer (awake, load), kept as long as a relayed box's full one. */
  readonly #light = new Map<string, { at: number; health: MachineHealth }>();

  constructor(deps: CloudBrowserDeps) {
    this.#deps = deps;
  }

  #fresh(entry: { at: number; health: MachineHealth } | undefined, machine: CloudBrowserMachine): MachineHealth | undefined {
    return entry && this.#deps.now() - entry.at < (machine.relayAlias ? BOX_HEALTH_TTL_MS : HEALTH_TTL_MS) ? entry.health : undefined;
  }

  /** "passive": never asks a relayed box anything; "light": a cold relayed box only says whether it is awake and how
   * busy; "up": the machine is made usable, a relayed box's relay and Chrome brought up. Others ignore the mode. */
  async #check(machine: CloudBrowserMachine, mode: "passive" | "light" | "up"): Promise<MachineHealth> {
    if (machine.relayAlias && !this.#warm.has(machine.id)) {
      if (mode === "passive") return { ok: false, detail: "空闲未连" };
      if (mode === "light") {
        const known = this.#fresh(this.#light.get(machine.id), machine);
        if (known) return known;
        if (!this.#deps.probeBox) return { ok: true, load: 1, cold: true };
        const light = await this.#deps.probeBox(machine).catch((): MachineHealth => ({ ok: false, detail: "MCP 不通" }));
        const health: MachineHealth = light.ok ? { ...light, cold: true } : light;
        this.#light.set(machine.id, { at: this.#deps.now(), health });
        return health;
      }
    }
    const cached = this.#fresh(this.#health.get(machine.id), machine);
    if (cached) return cached;
    // A warm box whose answer went stale is not asked from the background: asking would keep its relay busy.
    if (machine.relayAlias && mode === "passive") return { ok: false, detail: "空闲未连" };
    const running = this.#inflight.get(machine.id);
    if (running) return running;
    const work = (async (): Promise<MachineHealth> => {
      if (machine.kind === "mcp" && !machine.relayAlias) {
        if (!machine.cdpUrl) return { ok: false, detail: "无 CDP 通道" };
        return await this.#deps.probe(machine.cdpUrl) ? { ok: true, load: 0.5, cdpUrl: machine.cdpUrl } : { ok: false, detail: "CDP 不通" };
      }
      const remote = await this.#deps.ensureRemote(machine);
      if (!remote.ok) return remote;
      const url = `http://127.0.0.1:${machine.localPort}`;
      if (!(await this.#deps.ensureTunnel(machine))) return { ok: false, detail: "隧道起不来" };
      if (!(await this.#deps.probe(url))) return { ok: false, detail: "隧道不通" };
      return { ok: true, ...(remote.load !== undefined ? { load: remote.load } : {}), cdpUrl: url };
    })().catch((error: unknown) => ({ ok: false, detail: error instanceof Error ? error.message.slice(0, 80) : "出错" }));
    this.#inflight.set(machine.id, work);
    try {
      const health = await work;
      this.#health.set(machine.id, { at: this.#deps.now(), health });
      if (machine.relayAlias) {
        this.#light.delete(machine.id);
        if (health.ok) this.#warm.add(machine.id);
        else {
          // A bring-up that did not get through must not leave the box dialing the relay host on its own (E80).
          const wasWarm = this.#warm.delete(machine.id);
          if (mode === "up" || wasWarm) void this.#deps.teardown?.(machine).catch(() => {});
        }
      }
      return health;
    } finally {
      this.#inflight.delete(machine.id);
    }
  }

  /** Forget a machine's health (all with no id), e.g. after a browser call to it failed. */
  invalidate(machineId?: string): void {
    if (machineId === undefined) {
      this.#health.clear();
      this.#light.clear();
    } else {
      this.#health.delete(machineId);
      this.#light.delete(machineId);
    }
  }

  /** The relayed boxes whose relay is up, as far as this pool knows. */
  warmBoxes(): string[] {
    return [...this.#warm];
  }

  /** A relayed box's relay was ended (idle teardown): it is cold again, and its sessions pick afresh. */
  release(machineId: string): void {
    this.#warm.delete(machineId);
    this.invalidate(machineId);
    for (const [session, id] of this.#sticky) if (id === machineId) this.#sticky.delete(session);
  }

  /** The machine for `session`: the one it already runs on while that answers, else the idlest that answers. A cold
   * relayed box counts with its load and is brought up only when it is the one chosen; a passive pick skips it. */
  async pick(machines: readonly CloudBrowserMachine[], session: string, localName = "本机", options: PickOptions = {}): Promise<CloudBrowserPick> {
    const mode = options.passive ? "passive" : "light";
    const checked = await Promise.all(machines.map(async (machine) => ({ machine, health: await this.#check(machine, mode) })));
    const usable = checked.filter((entry) => entry.health.ok && (entry.health.cdpUrl || entry.health.cold));
    const stuck = this.#sticky.get(session);
    const kept = usable.find((entry) => entry.machine.id === stuck && entry.health.cdpUrl);
    const order = kept ? [kept] : [...usable].sort((a, b) => (a.health.load ?? 1) - (b.health.load ?? 1));
    let chosen: (typeof checked)[number] | undefined;
    for (const entry of order) {
      if (entry.health.cdpUrl) {
        chosen = entry;
        break;
      }
      const up = await this.#check(entry.machine, "up");
      entry.health = up;
      if (up.ok && up.cdpUrl) {
        chosen = entry;
        break;
      }
    }
    if (chosen) {
      this.#sticky.set(session, chosen.machine.id);
      const others = usable.filter((entry) => entry !== chosen && entry.health.ok).map((entry) => `${entry.machine.name} ${pct(entry.health.load)}`);
      const why = kept ? `沿用 ${chosen.machine.name}` : `${chosen.machine.name} 最空闲（负载 ${pct(chosen.health.load)}${others.length ? `；${others.join("，")}` : ""}）`;
      return { machine: chosen.machine.name, cloud: true, cdpUrl: chosen.health.cdpUrl!, reason: `云端优先：${why}` };
    }
    this.#sticky.delete(session);
    const down = checked.map((entry) => `${entry.machine.name}：${entry.health.detail ?? "不可用"}`).join("；");
    return { machine: localName, cloud: false, cdpUrl: null, reason: machines.length ? `云端浏览器都不可用（${down}），回落${localName}` : `没有云端机器，用${localName}` };
  }
}

/** The script that makes sure an SSH machine's Chrome is up and prints "OMB_OK <load1> <cores>" or "OMB_ERR <why>". */
export function remoteChromeScript(port = REMOTE_CDP_PORT): string {
  return [
    `P=${port}`,
    `B=$(command -v chromium || command -v chromium-browser || command -v google-chrome || command -v google-chrome-stable)`,
    `[ -z "$B" ] && { echo "OMB_ERR 没有 Chrome"; exit 0; }`,
    `up() { curl -s -m 2 "http://127.0.0.1:$P/json/version" >/dev/null 2>&1; }`,
    `if ! up; then mkdir -p "$HOME/.omb-cloud-chrome"; setsid nohup "$B" --headless=new --remote-debugging-address=127.0.0.1 --remote-debugging-port=$P --user-data-dir="$HOME/.omb-cloud-chrome" --no-first-run --no-default-browser-check --disable-dev-shm-usage --lang=zh-CN about:blank >/tmp/omb-cloud-chrome.log 2>&1 </dev/null & for i in 1 2 3 4 5 6 7 8 9 10 11 12; do sleep 0.5; up && break; done; fi`,
    `up && echo "OMB_OK $(cut -d' ' -f1 /proc/loadavg) $(nproc 2>/dev/null || echo 1)" || echo "OMB_ERR Chrome 起不来"`,
  ].join("\n");
}

export function parseRemoteAnswer(out: string): MachineHealth {
  const ok = /OMB_OK\s+([\d.]+)\s+(\d+)/.exec(out);
  if (ok) {
    const load = Number(ok[1]) / Math.max(1, Number(ok[2]));
    return { ok: true, load: Number.isFinite(load) ? load : undefined };
  }
  const err = /OMB_ERR\s+(.+)/.exec(out);
  return { ok: false, detail: err ? err[1]!.trim().slice(0, 60) : "SSH 不通" };
}

/** The ssh argv of a machine's tunnel: its Chrome's loopback port to this host's. Reverse forwards are not used:
 * some SSH gateways refuse them, so this host's files reach the cloud Chrome through the CDP proxy instead. The link
 * crosses the Pacific (~190 ms): compression shrinks CDP's JSON and screenshots, the AEAD ciphers are the cheapest on
 * this host's weak CPU, and a 10 s heartbeat ends a dead link within 20 s so it is opened again (onTunnelExit). */
export function tunnelArgs(alias: string, localPort: number, remotePort = REMOTE_CDP_PORT): string[] {
  return [
    "-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2",
    "-o", "TCPKeepAlive=yes", "-o", "Compression=yes", "-o", "Ciphers=chacha20-poly1305@openssh.com,aes128-gcm@openssh.com", "-o", "ConnectTimeout=10",
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    alias,
  ];
}

/** The real deps: ssh for the remote Chrome and the tunnels, fetch for the probe. */
/** A box reached over its MCP server: whether it is awake (a check must not wake a hibernated box) and a shell in it. */
export interface BoxShell {
  running(server: string): Promise<boolean>;
  shell(server: string, command: string): Promise<string>;
}

export function sshCloudBrowserDeps(options: { log?: (line: string) => void; onTunnelExit?: (machine: CloudBrowserMachine) => void; box?: BoxShell } = {}): CloudBrowserDeps & { close(): void } {
  const tunnels = new Map<string, ReturnType<typeof spawn>>();
  /** Tunnels this host ended on purpose (idle teardown): their exit is not a dead link to reopen. */
  const ended = new WeakSet<ReturnType<typeof spawn>>();
  let closing = false;
  const probe = async (url: string) => {
    try {
      const response = await fetch(`${url.replace(/\/$/, "")}/json/version`, { signal: AbortSignal.timeout(3_000) });
      return response.ok;
    } catch {
      return false;
    }
  };
  const runSsh = (alias: string, script: string) => new Promise<string>((done) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", alias, "bash -s"], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 25_000);
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.on("error", () => { clearTimeout(timer); done(""); });
    child.on("close", () => { clearTimeout(timer); done(out); });
    child.stdin.end(script);
  });
  return {
    now: () => Date.now(),
    probe,
    ...(options.log ? { log: options.log } : {}),
    async ensureRemote(machine) {
      if (machine.kind === "mcp" && machine.relayAlias && machine.mcpServer && machine.relayPort) {
        if (!options.box) return { ok: false, detail: "无 MCP" };
        if (!(await options.box.running(machine.mcpServer).catch(() => false))) return { ok: false, detail: "休眠中" };
        const relay = await sshResolve(machine.relayAlias);
        if (!relay) return { ok: false, detail: "中继主机不明" };
        if (machine.relayUser) {
          // A dedicated relay account: the box gets only that account and its own key, never this host's login there.
          // The box goes first (it makes its key), then the key is authorized; its relay loop retries within seconds.
          const target = { cdpPort: REMOTE_CDP_PORT, relayPort: machine.relayPort, httpProxyPort: BOX_HTTP_PROXY_PORT, socksPort: BOX_SOCKS_PORT };
          const answer = await options.box.shell(machine.mcpServer, boxUpScript(target, boxSshConfig({ ...relay, user: machine.relayUser }, BOX_SOCKS_PORT))).catch(() => "");
          const health = parseRemoteAnswer(answer);
          if (!health.ok) return health;
          const pub = parseBoxPub(answer);
          if (!pub) return { ok: false, detail: "盒子中继密钥不明" };
          const host = await runSsh(machine.relayAlias, relayHostScript({ user: machine.relayUser, relayPort: machine.relayPort, pub, tag: machine.id.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64) || "box" }));
          if (!/OMB_RELAY_OK/.test(host)) return { ok: false, detail: /OMB_RELAY_ERR\s+(.+)/.exec(host)?.[1]?.trim().slice(0, 40) ?? "中继主机不通" };
          return health;
        }
        if (!/OMB_RELAY_OK/.test(await runSsh(machine.relayAlias, relayHostScript()))) return { ok: false, detail: "中继主机不通" };
        const script = boxUpScript({ cdpPort: REMOTE_CDP_PORT, relayPort: machine.relayPort, httpProxyPort: BOX_HTTP_PROXY_PORT, socksPort: BOX_SOCKS_PORT }, boxSshConfig(relay, BOX_SOCKS_PORT));
        return parseRemoteAnswer(await options.box.shell(machine.mcpServer, script).catch(() => ""));
      }
      if (!machine.sshAlias) return { ok: false, detail: "没有 SSH" };
      return parseRemoteAnswer(await runSsh(machine.sshAlias, remoteChromeScript()));
    },
    async ensureTunnel(machine) {
      const alias = machine.sshAlias ?? machine.relayAlias;
      if (!alias || !machine.localPort) return false;
      const url = `http://127.0.0.1:${machine.localPort}`;
      const open = tunnels.get(machine.id);
      if (open && open.exitCode === null && !open.killed && await probe(url)) return true;
      if (open) open.kill("SIGTERM");
      // A tunnel this process does not own (one left by a restart) already answers: use it.
      else if (await probe(url)) return true;
      const child = spawn("ssh", tunnelArgs(alias, machine.localPort, machine.relayPort ?? REMOTE_CDP_PORT), { stdio: "ignore" });
      child.on("error", () => {});
      child.on("exit", (code) => {
        if (tunnels.get(machine.id) === child) tunnels.delete(machine.id);
        options.log?.(`cloud browser: tunnel to ${machine.name} exited (${code})`);
        if (!closing && !ended.has(child)) options.onTunnelExit?.(machine);
      });
      tunnels.set(machine.id, child);
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (child.exitCode !== null) return false;
        if (await probe(url)) return true;
      }
      child.kill("SIGTERM");
      return false;
    },
    async probeBox(machine) {
      if (!options.box || !machine.mcpServer) return { ok: false, detail: "无 MCP" };
      if (!(await options.box.running(machine.mcpServer).catch(() => false))) return { ok: false, detail: "休眠中" };
      return parseRemoteAnswer(await options.box.shell(machine.mcpServer, `echo "OMB_OK $(cut -d' ' -f1 /proc/loadavg) $(nproc 2>/dev/null || echo 1)"`).catch(() => ""));
    },
    async teardown(machine) {
      // The box first, so its relay loop does not dial again; a sleeping box has nothing running and is not woken.
      if (options.box && machine.mcpServer && await options.box.running(machine.mcpServer).catch(() => false)) {
        const out = await options.box.shell(machine.mcpServer, boxDownScript(REMOTE_CDP_PORT)).catch(() => "");
        options.log?.(`cloud browser: ${machine.name} relay ended on the box (${/OMB_DOWN\s+(\d+)/.exec(out)?.[1] ?? "?"} left)`);
      }
      if (machine.relayAlias && machine.relayPort) await runSsh(machine.relayAlias, relayHostDownScript(machine.relayPort));
      const child = tunnels.get(machine.id);
      if (child) {
        ended.add(child);
        tunnels.delete(machine.id);
        child.kill("SIGTERM");
      }
    },
    close() {
      closing = true;
      for (const child of tunnels.values()) child.kill("SIGTERM");
      tunnels.clear();
    },
  };
}
