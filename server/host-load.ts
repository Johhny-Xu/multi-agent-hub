import { readFileSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";

/** Thresholds Auto placement uses on this computer; `cpuHigh`/`memHighPct` enter high load,
 * `cpuLow`/`memLowPct` leave it, and `memMinMb` enters high load whatever the percentage. */
export interface AutoPlacementSettings {
  enabled: boolean;
  cpuHigh: number;
  cpuLow: number;
  memHighPct: number;
  memLowPct: number;
  memMinMb: number;
}

export const DEFAULT_AUTO_PLACEMENT: AutoPlacementSettings = {
  enabled: true, cpuHigh: 85, cpuLow: 60, memHighPct: 15, memLowPct: 25, memMinMb: 1_500,
};

export type Pressure = "low" | "high";

export interface HostLoadSample {
  /** Percent of every core, 0–100. */
  cpu: number;
  memAvailPct: number;
  memAvailMb: number;
}

export interface HostLoad extends HostLoadSample {
  pressure: Pressure;
  reason: string;
}

export interface CpuTimes {
  busy: number;
  total: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The first `cpu` line of /proc/stat: every field except idle and iowait is work. */
export function parseProcStat(text: string): CpuTimes | null {
  const line = text.split("\n", 1)[0]?.trim() ?? "";
  const fields = line.split(/\s+/);
  if (fields[0] !== "cpu" || fields.length < 5) return null;
  const values = fields.slice(1, 9).map(Number);
  if (values.some((value) => !Number.isFinite(value))) return null;
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = values;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { busy: total - idle - iowait, total };
}

/** Busy share of the work done between two readings; null when the counters did not advance. */
export function cpuPercentBetween(previous: CpuTimes, next: CpuTimes): number | null {
  const total = next.total - previous.total;
  if (!(total > 0)) return null;
  return clamp(((next.busy - previous.busy) / total) * 100, 0, 100);
}

export interface MemoryFacts {
  totalMb: number;
  availMb: number;
}

/** MemAvailable when the kernel reports it, else free + buffers + cached, as /proc/meminfo holds it. */
export function parseMeminfo(text: string): MemoryFacts | null {
  const fields = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(\w+):\s+(\d+)\s+kB$/.exec(line.trim());
    if (match) fields.set(match[1]!, Number(match[2]));
  }
  const totalKb = fields.get("MemTotal");
  if (!(totalKb && totalKb > 0)) return null;
  const availableKb = fields.get("MemAvailable")
    ?? (fields.get("MemFree") ?? 0) + (fields.get("Buffers") ?? 0) + (fields.get("Cached") ?? 0);
  return { totalMb: totalKb / 1024, availMb: availableKb / 1024 };
}

/** A fixture may state the load a test needs; it is the only way to make a test box look busy or idle. */
function statedLoad(): HostLoadSample | null {
  const raw = process.env.OMB_TEST_HOST_LOAD;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<HostLoadSample>;
    if (typeof parsed.cpu !== "number" || typeof parsed.memAvailPct !== "number" || typeof parsed.memAvailMb !== "number") return null;
    return { cpu: clamp(parsed.cpu, 0, 100), memAvailPct: clamp(parsed.memAvailPct, 0, 100), memAvailMb: Math.max(0, parsed.memAvailMb) };
  } catch {
    return null;
  }
}

let previousCpuTimes: CpuTimes | null = null;

function readSystem(): HostLoadSample {
  const stated = statedLoad();
  if (stated) return stated;
  const cores = Math.max(1, cpus().length);
  const loadCpu = clamp(((loadavg()[0] ?? 0) / cores) * 100, 0, 100);
  let statCpu: number | null = null;
  try {
    const times = parseProcStat(readFileSync("/proc/stat", "utf8"));
    if (times) {
      if (previousCpuTimes) statCpu = cpuPercentBetween(previousCpuTimes, times);
      previousCpuTimes = times;
    }
  } catch {}
  let memory: MemoryFacts | null = null;
  try {
    memory = parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
  } catch {}
  if (!memory) {
    const totalMb = totalmem() / 1_048_576;
    memory = { totalMb, availMb: freemem() / 1_048_576 };
  }
  return {
    cpu: statCpu === null ? loadCpu : Math.max(loadCpu, statCpu),
    memAvailPct: memory.totalMb > 0 ? (memory.availMb / memory.totalMb) * 100 : 0,
    memAvailMb: memory.availMb,
  };
}

function isHigh(sample: HostLoadSample, settings: AutoPlacementSettings): boolean {
  return sample.cpu >= settings.cpuHigh || sample.memAvailPct < settings.memHighPct || sample.memAvailMb < settings.memMinMb;
}

/** High until both the CPU and the memory have recovered: a machine that just came down from 95% is still busy. */
function nextPressure(previous: Pressure, sample: HostLoadSample, settings: AutoPlacementSettings): Pressure {
  if (previous === "high") return sample.cpu <= settings.cpuLow && sample.memAvailPct >= settings.memLowPct ? "low" : "high";
  return isHigh(sample, settings) ? "high" : "low";
}

function reasonFor(sample: HostLoadSample, settings: AutoPlacementSettings, pressure: Pressure): string {
  const cpu = Math.round(sample.cpu);
  const pct = Math.round(sample.memAvailPct);
  if (pressure === "high") {
    if (sample.cpu >= settings.cpuHigh) return `本机 CPU ${cpu}%`;
    return `本机可用内存 ${pct}%（${(sample.memAvailMb / 1024).toFixed(1)}GB）`;
  }
  return `本机 CPU ${cpu}%，可用内存 ${pct}%`;
}

/** One reading every 30s of wall time is what the smoothing remembers; a burst of calls moves it faster. */
export const DEFAULT_SMOOTHING_MS = 30_000;

export class HostLoadSampler {
  private readonly read: () => HostLoadSample;
  private readonly now: () => number;
  private readonly tauMs: number;
  private smoothed: HostLoadSample | undefined;
  private sampledAt: number | undefined;
  private pressure: Pressure = "low";
  private settings: AutoPlacementSettings;

  constructor(options: { read?: () => HostLoadSample; now?: () => number; tauMs?: number; settings?: AutoPlacementSettings } = {}) {
    this.read = options.read ?? readSystem;
    this.now = options.now ?? Date.now;
    this.tauMs = options.tauMs ?? DEFAULT_SMOOTHING_MS;
    this.settings = options.settings ?? DEFAULT_AUTO_PLACEMENT;
  }

  sample(settings?: AutoPlacementSettings): HostLoad {
    this.settings = settings ?? this.settings;
    const raw = this.read();
    const at = this.now();
    const elapsed = this.sampledAt === undefined ? 0 : Math.max(0, at - this.sampledAt);
    const alpha = this.smoothed === undefined || this.tauMs <= 0 ? 1 : 1 - Math.exp(-elapsed / this.tauMs);
    this.smoothed = this.smoothed === undefined ? raw : {
      cpu: this.smoothed.cpu + (raw.cpu - this.smoothed.cpu) * alpha,
      memAvailPct: this.smoothed.memAvailPct + (raw.memAvailPct - this.smoothed.memAvailPct) * alpha,
      memAvailMb: this.smoothed.memAvailMb + (raw.memAvailMb - this.smoothed.memAvailMb) * alpha,
    };
    this.sampledAt = at;
    this.pressure = nextPressure(this.pressure, this.smoothed, this.settings);
    return this.current();
  }

  current(): HostLoad {
    const sample = this.smoothed ?? { cpu: 0, memAvailPct: 100, memAvailMb: 0 };
    return { ...sample, pressure: this.pressure, reason: reasonFor(sample, this.settings, this.pressure) };
  }
}

let singleton: HostLoadSampler | null = null;

/** The process-wide sampler: one history of readings for every turn that asks. */
export function hostLoadSampler(): HostLoadSampler {
  return singleton ??= new HostLoadSampler();
}

export function hostLoad(settings?: AutoPlacementSettings): HostLoad {
  return hostLoadSampler().sample(settings);
}
