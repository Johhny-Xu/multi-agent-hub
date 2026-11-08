import { describe, expect, it } from "vitest";

import { sshRoundTrip, sshRoundTripArgs, type SshRunner } from "./vps-check.ts";

function runnerOf(waitMs: number, fail?: string): SshRunner {
  return async () => {
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    if (fail) throw new Error(fail);
    return { stdout: "", stderr: "" };
  };
}

describe("SSH health check", () => {
  it("measures the round trip of the connection and one `true` on the host", async () => {
    const calls: string[][] = [];
    const runner: SshRunner = async (args) => {
      calls.push(args);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { stdout: "", stderr: "" };
    };
    const trip = await sshRoundTrip("alpha-vps", { runner });
    expect(trip.ok).toBe(true);
    expect(trip.latencyMs).toBeGreaterThanOrEqual(25);
    expect(calls[0]).toEqual(sshRoundTripArgs("alpha-vps"));
    expect(calls[0]).toContain("alpha-vps");
    expect(calls[0]).toContain("true");
    expect(calls[0]).toContain("BatchMode=yes");
  });

  it("reports a host that does not answer as offline with a reason", async () => {
    const trip = await sshRoundTrip("alpha-vps", { runner: runnerOf(0, "ssh: connect to host alpha-vps port 22: Connection refused") });
    expect(trip.ok).toBe(false);
    expect(trip.reason).toBe("unreachable");
    expect(trip.error).toContain("Connection refused");
  });

  it("reports a check that ran out of time as offline with the budget", async () => {
    const trip = await sshRoundTrip("alpha-vps", { timeoutMs: 40, runner: runnerOf(0, "The SSH command timed out") });
    expect(trip.ok).toBe(false);
    expect(trip.reason).toBe("timeout");
    expect(trip.error).toContain("40 ms");
  });

  it("refuses an alias that is not a host name", async () => {
    const trip = await sshRoundTrip("not a host", { runner: runnerOf(0) });
    expect(trip.ok).toBe(false);
    expect(trip.reason).toBe("unreachable");
  });
});
