import { describe, expect, it } from "vitest";

import {
  DEFAULT_AUTO_PLACEMENT,
  HostLoadSampler,
  cpuPercentBetween,
  parseMeminfo,
  parseProcStat,
  type HostLoadSample,
} from "./host-load.ts";

const sample = (cpu: number, memAvailPct: number, memAvailMb: number): HostLoadSample => ({ cpu, memAvailPct, memAvailMb });

/** A sampler whose clock and readings the test writes. */
function fakeSampler(readings: HostLoadSample[], stepMs = 30_000, tauMs = 0) {
  let index = 0;
  let clock = 0;
  const sampler = new HostLoadSampler({
    read: () => readings[Math.min(index, readings.length - 1)]!,
    now: () => {
      const at = clock;
      index += 1;
      clock += stepMs;
      return at;
    },
    tauMs,
  });
  return sampler;
}

describe("/proc readers", () => {
  it("reads busy work out of the first cpu line", () => {
    expect(parseProcStat("cpu  100 0 100 800 0 0 0 0\ncpu0 1 2 3 4 5 6 7 8")).toEqual({ busy: 200, total: 1_000 });
    expect(parseProcStat("cpu  10 0 10 80")).toEqual({ busy: 20, total: 100 });
    expect(parseProcStat("intr 1 2 3")).toBeNull();
  });

  it("turns two counter readings into the busy share between them", () => {
    expect(cpuPercentBetween({ busy: 200, total: 1_000 }, { busy: 400, total: 2_000 })).toBe(20);
    expect(cpuPercentBetween({ busy: 200, total: 1_000 }, { busy: 200, total: 1_000 })).toBeNull();
  });

  it("reads MemAvailable, and falls back to free + buffers + cached", () => {
    const text = "MemTotal: 16384000 kB\nMemFree: 1000000 kB\nMemAvailable: 8192000 kB\n";
    expect(parseMeminfo(text)).toEqual({ totalMb: 16_000, availMb: 8_000 });
    const legacy = "MemTotal: 8192000 kB\nMemFree: 1048576 kB\nBuffers: 524288 kB\nCached: 2097152 kB\n";
    expect(parseMeminfo(legacy)).toEqual({ totalMb: 8_000, availMb: 3_584 });
    expect(parseMeminfo("nonsense")).toBeNull();
  });
});

describe("the host-load sampler", () => {
  it("is enabled by default and starts calm on an idle machine", () => {
    expect(DEFAULT_AUTO_PLACEMENT.enabled).toBe(true);
    const load = fakeSampler([sample(12, 70, 12_000)]).sample();
    expect(load).toMatchObject({ pressure: "low", cpu: 12 });
    expect(load.reason).toBe("本机 CPU 12%，可用内存 70%");
  });

  it("smooths toward a new reading over about 30 seconds", () => {
    const sampler = fakeSampler([sample(0, 80, 8_000), sample(100, 80, 8_000)], 30_000, 30_000);
    expect(sampler.sample().cpu).toBe(0);
    // One time constant: 1 - e^-1 of the way to 100.
    expect(sampler.sample().cpu).toBeCloseTo(63.21, 1);
  });

  it("enters high load on CPU or memory and leaves only when both have recovered", () => {
    const cpu = fakeSampler([sample(90, 70, 12_000), sample(70, 70, 12_000), sample(55, 70, 12_000)]);
    expect(cpu.sample().pressure).toBe("high");
    expect(cpu.sample().pressure).toBe("high");
    expect(cpu.sample().pressure).toBe("low");

    const memory = fakeSampler([sample(10, 10, 12_000), sample(10, 20, 12_000), sample(10, 30, 12_000)]);
    expect(memory.sample().pressure).toBe("high");
    expect(memory.sample().pressure).toBe("high");
    expect(memory.sample().pressure).toBe("low");

    const absolute = fakeSampler([sample(10, 60, 1_000), sample(10, 60, 2_000)]);
    expect(absolute.sample().pressure).toBe("high");
    expect(absolute.sample().pressure).toBe("low");
  });

  it("names the measurement that sent the turn to the cloud", () => {
    const cpu = fakeSampler([sample(92, 70, 12_000)]).sample();
    expect(cpu.reason).toBe("本机 CPU 92%");
    const memory = fakeSampler([sample(10, 9, 700)]).sample();
    expect(memory.reason).toBe("本机可用内存 9%（0.7GB）");
  });

  it("takes the thresholds it is given", () => {
    const sampler = fakeSampler([sample(70, 70, 12_000)]);
    const settings = { ...DEFAULT_AUTO_PLACEMENT, cpuHigh: 65 };
    expect(sampler.sample(settings).pressure).toBe("high");
  });
});
