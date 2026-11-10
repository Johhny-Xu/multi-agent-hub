// E73 (FEAT-cloud-offload): a bot's CLI that starts its own headless Chrome (a screenshot check of the page it built)
// must not render on this host while a cloud machine's Chrome answers. Two guards:
// 1. Every bot engine's env puts shims for the Chrome binaries first on PATH (and PUPPETEER_EXECUTABLE_PATH/CHROME_PATH
//    on them). With a cloud Chrome up, a shim refuses and says how to connect to it instead; without one it runs the
//    real Chrome at the lowest priority.
// 2. A sweep lowers to nice 19 any headless Chrome that still runs under this server (Playwright's own bundled Chrome
//    takes no PATH), so it can never take the host's cores from the person.
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { getPriority, setPriority } from "node:os";
import { delimiter, join } from "node:path";

export const CHROME_NAMES = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"] as const;

export interface GuardState {
  /** The cloud Chrome a CLI should connect to, through this host's tunnel; null while none answers. */
  cdpUrl: string | null;
}

export function shimScript(): string {
  return `#!/bin/sh
# OpenMausBot 本机负载保护（E73）：本机不跑浏览器/渲染，交给云端 Chrome。
url=""
[ -n "$OMB_CLOUD_STATE" ] && [ -r "$OMB_CLOUD_STATE" ] && url=$(sed -n 1p "$OMB_CLOUD_STATE")
[ -z "$url" ] && url="$OMB_CLOUD_CDP_URL"
if [ -n "$url" ] && [ "$OMB_ALLOW_LOCAL_CHROME" != "1" ]; then
  echo "OpenMausBot：这台主机不跑浏览器/渲染（负载保护）。请连接云端 Chrome：" >&2
  echo "  Playwright: chromium.connectOverCDP('$url')；Puppeteer: puppeteer.connect({ browserURL: '$url' })" >&2
  echo "  照常打开 file:///工作目录/index.html 或 http://localhost:<端口>/ 即可：这个地址会把本机文件透明地交给云端 Chrome。" >&2
  echo "  或者用 OpenMausBot 自带的浏览器工具（已在云端）。" >&2
  exit 3
fi
self=$(basename "$0")
dir=$(cd "$(dirname "$0")" && pwd)
PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vxF "$dir" | paste -sd: -)
export PATH
real=$(command -v "$self" || command -v google-chrome || command -v chromium || command -v chromium-browser)
[ -z "$real" ] && { echo "OpenMausBot: 本机没有 $self" >&2; exit 127; }
exec nice -n 19 "$real" "$@"
`;
}

/** Writes the shims into `dir` (idempotent) and returns it. */
export function writeChromeShims(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const script = shimScript();
  for (const name of CHROME_NAMES) {
    const path = join(dir, name);
    let current = "";
    try { current = readFileSync(path, "utf8"); } catch {}
    if (current !== script) writeFileSync(path, script);
    chmodSync(path, 0o755);
  }
  return dir;
}

/** A bot engine's env with the guard on: the shims first on PATH, and where the cloud Chrome is. */
export function guardedBotEnv(env: NodeJS.ProcessEnv, shimDir: string, stateFile: string, state: GuardState): NodeJS.ProcessEnv {
  const path = env.PATH ?? process.env.PATH ?? "";
  const parts = path.split(delimiter).filter((part) => part && part !== shimDir);
  return {
    ...env,
    PATH: [shimDir, ...parts].join(delimiter),
    PUPPETEER_EXECUTABLE_PATH: join(shimDir, "chrome"),
    CHROME_PATH: join(shimDir, "chrome"),
    OMB_CLOUD_STATE: stateFile,
    ...(state.cdpUrl ? { OMB_CLOUD_CDP_URL: state.cdpUrl } : {}),
  };
}

/** The file the shims read at run time, so an engine started before a cloud machine came up still learns of it. */
export function writeGuardState(stateFile: string, state: GuardState): void {
  try { writeFileSync(stateFile, `${state.cdpUrl ?? ""}\n`); } catch {}
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  comm: string;
  cmdline: string;
}

/** Headless Chrome processes (and their helpers) under `root`, from a process table. */
export function headlessChromesUnder(procs: readonly ProcInfo[], root: number): number[] {
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
  const under = (proc: ProcInfo) => {
    let current: ProcInfo | undefined = proc;
    for (let depth = 0; current && depth < 64; depth++) {
      if (current.ppid === root) return true;
      current = byPid.get(current.ppid);
    }
    return false;
  };
  const isChrome = (proc: ProcInfo) => /^(chrome|chromium|chromium-browse|headless_shell|chrome-headless)/.test(proc.comm);
  const headlessRoot = (proc: ProcInfo): boolean => {
    let current: ProcInfo | undefined = proc;
    for (let depth = 0; current && isChrome(current) && depth < 8; depth++) {
      if (/--headless/.test(current.cmdline)) return true;
      current = byPid.get(current.ppid);
    }
    return false;
  };
  return procs.filter((proc) => isChrome(proc) && headlessRoot(proc) && under(proc)).map((proc) => proc.pid);
}

function readProcs(): ProcInfo[] {
  const procs: ProcInfo[] = [];
  let entries: string[] = [];
  try { entries = readdirSync("/proc"); } catch { return procs; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const comm = stat.slice(stat.indexOf("(") + 1, close);
      const ppid = Number(stat.slice(close + 2).split(" ")[1]);
      let cmdline = "";
      if (/^(chrome|chromium|headless_shell)/.test(comm)) cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8").replace(/\0/g, " ");
      procs.push({ pid: Number(entry), ppid, comm, cmdline });
    } catch {}
  }
  return procs;
}

/** Every `intervalMs`, nice 19 for headless Chrome under this server; returns the stop. Linux only. */
export function startHeadlessChromeSweep(options: { intervalMs?: number; root?: number; log?: (line: string) => void; read?: () => ProcInfo[] } = {}): () => void {
  if (process.platform !== "linux" && !options.read) return () => {};
  const root = options.root ?? process.pid;
  const read = options.read ?? readProcs;
  const told = new Set<number>();
  const sweep = () => {
    for (const pid of headlessChromesUnder(read(), root)) {
      try {
        if (getPriority(pid) < 19) {
          setPriority(pid, 19);
          if (!told.has(pid)) {
            told.add(pid);
            options.log?.(`E73 本机负载保护：headless Chrome pid ${pid} 已降到 nice 19`);
          }
        }
      } catch {}
    }
    if (told.size > 512) told.clear();
  };
  const timer = setInterval(sweep, options.intervalMs ?? 15_000);
  timer.unref?.();
  sweep();
  return () => clearInterval(timer);
}
