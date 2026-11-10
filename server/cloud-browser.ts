// FEAT-cloud-offload / E72 / E73: an Auto bot's browser runs on a cloud machine (the configured VPS computers and
// Simular boxes), never on this host while one is up. Each SSH machine gets one headless Chrome on its
// own loopback (REMOTE_CDP_PORT) and one SSH tunnel to it from here; the least loaded machine that answers wins, a
// session keeps the machine it started on while that one still answers, and only when none answers does the browser
// fall back to this host's own Chrome. The pick is what the chat header shows ("浏览器 · <machine> / <profile>").
import { spawn } from "node:child_process";

import type { AppConfig } from "./config.ts";

/** Where every cloud machine's Chrome listens, on that machine's own loopback only. */
export const REMOTE_CDP_PORT = 9335;
/** Where CLIs reach the nth SSH machine's Chrome: the CDP proxy (cloud-cdp-proxy.ts) on LOCAL_CDP_BASE + n. */
export const LOCAL_CDP_BASE = 9341;
/** The proxy's upstream: the nth machine's SSH tunnel ends here on TUNNEL_CDP_BASE + n, internal to this host. */
export const TUNNEL_CDP_BASE = 19341;
/** Sites that need a sign-in: an Auto browser opening one goes to this host's signed-in mychrome instead of a cloud
 * Chrome, whose profile has no sign-ins. Cookies are never copied to a cloud machine (country hops lock accounts). */
export const DEFAULT_AUTH_DOMAINS: readonly string[] = [
  "google.com", "github.com", "x.com", "twitter.com", "doubao.com", "meoo.com", "qoder.com", "qoder.com.cn",
  "codebuddy.ai", "codebuddy.cn", "minimax.io", "minimaxi.com", "z.ai", "bigmodel.cn", "perchai.app", "trae.cn",
  "trae.com.cn", "huaweicloud.com", "kimi.com",
];
/** How long a machine's health stays good enough to pick it without asking again. */
const HEALTH_TTL_MS = 30_000;

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
}

export interface MachineHealth {
  ok: boolean;
  /** One-minute load per core, 0–n; lower is idler. */
  load?: number;
  cdpUrl?: string;
  /** Why it is not usable: "没有 Chrome", "SSH 不通", "无 CDP 通道". */
  detail?: string;
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
}

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
export function cloudBrowserMachines(cfg: Pick<AppConfig, "vps">): CloudBrowserMachine[] {
  const instances = (cfg.vps as { instances?: Array<Record<string, unknown>> } | undefined)?.instances ?? [];
  let ssh = 0;
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
      machines.push({ id, name, kind: "mcp", ...(cdpUrl ? { cdpUrl } : {}) });
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

  constructor(deps: CloudBrowserDeps) {
    this.#deps = deps;
  }

  async #check(machine: CloudBrowserMachine): Promise<MachineHealth> {
    const cached = this.#health.get(machine.id);
    if (cached && this.#deps.now() - cached.at < HEALTH_TTL_MS) return cached.health;
    const running = this.#inflight.get(machine.id);
    if (running) return running;
    const work = (async (): Promise<MachineHealth> => {
      if (machine.kind === "mcp") {
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
      return health;
    } finally {
      this.#inflight.delete(machine.id);
    }
  }

  /** Forget a machine's health (all with no id), e.g. after a browser call to it failed. */
  invalidate(machineId?: string): void {
    if (machineId === undefined) this.#health.clear();
    else this.#health.delete(machineId);
  }

  /** The machine for `session`: the one it already runs on while that answers, else the idlest that answers. */
  async pick(machines: readonly CloudBrowserMachine[], session: string, localName = "本机"): Promise<CloudBrowserPick> {
    const checked = await Promise.all(machines.map(async (machine) => ({ machine, health: await this.#check(machine) })));
    const usable = checked.filter((entry) => entry.health.ok && entry.health.cdpUrl);
    const stuck = this.#sticky.get(session);
    const kept = usable.find((entry) => entry.machine.id === stuck);
    const chosen = kept ?? [...usable].sort((a, b) => (a.health.load ?? 1) - (b.health.load ?? 1))[0];
    if (chosen) {
      this.#sticky.set(session, chosen.machine.id);
      const others = usable.filter((entry) => entry !== chosen).map((entry) => `${entry.machine.name} ${pct(entry.health.load)}`);
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
export function tunnelArgs(alias: string, localPort: number): string[] {
  return [
    "-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2",
    "-o", "TCPKeepAlive=yes", "-o", "Compression=yes", "-o", "Ciphers=chacha20-poly1305@openssh.com,aes128-gcm@openssh.com", "-o", "ConnectTimeout=10",
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${REMOTE_CDP_PORT}`,
    alias,
  ];
}

/** The real deps: ssh for the remote Chrome and the tunnels, fetch for the probe. */
export function sshCloudBrowserDeps(options: { log?: (line: string) => void; onTunnelExit?: (machine: CloudBrowserMachine) => void } = {}): CloudBrowserDeps & { close(): void } {
  const tunnels = new Map<string, ReturnType<typeof spawn>>();
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
      if (!machine.sshAlias) return { ok: false, detail: "没有 SSH" };
      return parseRemoteAnswer(await runSsh(machine.sshAlias, remoteChromeScript()));
    },
    async ensureTunnel(machine) {
      if (!machine.sshAlias || !machine.localPort) return false;
      const url = `http://127.0.0.1:${machine.localPort}`;
      const open = tunnels.get(machine.id);
      if (open && open.exitCode === null && !open.killed && await probe(url)) return true;
      if (open) open.kill("SIGTERM");
      // A tunnel this process does not own (one left by a restart) already answers: use it.
      else if (await probe(url)) return true;
      const child = spawn("ssh", tunnelArgs(machine.sshAlias, machine.localPort), { stdio: "ignore" });
      child.on("error", () => {});
      child.on("exit", (code) => {
        if (tunnels.get(machine.id) === child) tunnels.delete(machine.id);
        options.log?.(`cloud browser: tunnel to ${machine.name} exited (${code})`);
        if (!closing) options.onTunnelExit?.(machine);
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
    close() {
      closing = true;
      for (const child of tunnels.values()) child.kill("SIGTERM");
      tunnels.clear();
    },
  };
}
