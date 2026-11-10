import { describe, expect, it } from "vitest";

import {
  CloudBrowserPool,
  LOCAL_CDP_BASE,
  TUNNEL_CDP_BASE,
  DEFAULT_AUTH_DOMAINS,
  authDomainOf,
  authDomains,
  cloudOffloadSettings,
  cloudBrowserMachines,
  cloudOffloadOn,
  parseRemoteAnswer,
  remoteChromeScript,
  tunnelArgs,
  type CloudBrowserDeps,
  type CloudBrowserMachine,
  type MachineHealth,
} from "./cloud-browser.ts";

const VPS = {
  instances: [
    { id: "a", name: "cloudA", kind: "ssh", sshAlias: "cloudA" },
    { id: "s1", name: "mcp-box", kind: "mcp", adapter: "simular-box", mcpServer: "mcp-box" },
    { id: "b", name: "cloudB", kind: "ssh", sshAlias: "cloudB" },
    { id: "s2", name: "mcp-box-2", kind: "mcp", browserCdpUrl: "http://127.0.0.1:9400" },
    { id: "bad", name: "evil", kind: "ssh", sshAlias: "x; rm -rf /" },
  ],
};

/** Machines that answer as the test says; counts what was asked. */
function fakeDeps(answers: Record<string, MachineHealth>, options: { tunnelOk?: boolean; probeOk?: (url: string) => boolean } = {}) {
  let clock = 0;
  const calls = { remote: 0, tunnel: 0 };
  const deps: CloudBrowserDeps & { tick(ms: number): void; calls: typeof calls } = {
    calls,
    tick: (ms) => { clock += ms; },
    now: () => clock,
    async ensureRemote(machine: CloudBrowserMachine) {
      calls.remote += 1;
      return answers[machine.name] ?? { ok: false, detail: "SSH 不通" };
    },
    async ensureTunnel() {
      calls.tunnel += 1;
      return options.tunnelOk ?? true;
    },
    async probe(url: string) {
      return options.probeOk ? options.probeOk(url) : true;
    },
  };
  return deps;
}

describe("cloud machines a browser may run on", () => {
  it("lists SSH machines with tunnel ports in order, Simular boxes with their CDP URL if any, and drops unsafe aliases", () => {
    const machines = cloudBrowserMachines({ vps: VPS } as never);
    expect(machines.map((m) => m.name)).toEqual(["cloudA", "mcp-box", "cloudB", "mcp-box-2"]);
    expect(machines[0]).toMatchObject({ kind: "ssh", sshAlias: "cloudA", localPort: TUNNEL_CDP_BASE, proxyPort: LOCAL_CDP_BASE });
    expect(machines[2]).toMatchObject({ kind: "ssh", sshAlias: "cloudB", localPort: TUNNEL_CDP_BASE + 1, proxyPort: LOCAL_CDP_BASE + 1 });
    expect(machines[1]!.cdpUrl).toBeUndefined();
    expect(machines[3]!.cdpUrl).toBe("http://127.0.0.1:9400");
  });

  it("is on unless the config turns it off", () => {
    expect(cloudOffloadOn({})).toBe(true);
    expect(cloudOffloadOn({ cloudOffload: { enabled: false } })).toBe(false);
  });
});

describe("CloudBrowserPool.pick", () => {
  const machines = cloudBrowserMachines({ vps: VPS } as never);

  it("picks the idlest cloud machine and says why", async () => {
    const pool = new CloudBrowserPool(fakeDeps({ cloudA: { ok: true, load: 0.4 }, cloudB: { ok: true, load: 0.05 } }, { probeOk: (url) => !url.includes("9400") }));
    const pick = await pool.pick(machines, "s1");
    expect(pick).toMatchObject({ machine: "cloudB", cloud: true, cdpUrl: `http://127.0.0.1:${TUNNEL_CDP_BASE + 1}` });
    expect(pick.reason).toContain("cloudB 最空闲");
    expect(pick.reason).toContain("cloudA 40%");
  });

  it("keeps a session on the machine it started on while that one answers", async () => {
    const answers: Record<string, MachineHealth> = { cloudA: { ok: true, load: 0.1 }, cloudB: { ok: true, load: 0.5 } };
    const deps = fakeDeps(answers, { probeOk: (url) => !url.includes("9400") });
    const pool = new CloudBrowserPool(deps);
    expect((await pool.pick(machines, "s1")).machine).toBe("cloudA");
    answers.cloudA = { ok: true, load: 0.9 };
    deps.tick(60_000);
    const again = await pool.pick(machines, "s1");
    expect(again.machine).toBe("cloudA");
    expect(again.reason).toContain("沿用 cloudA");
    expect((await pool.pick(machines, "s2")).machine).toBe("cloudB");
  });

  it("moves a session when its machine stops answering", async () => {
    const answers: Record<string, MachineHealth> = { cloudA: { ok: true, load: 0.1 }, cloudB: { ok: true, load: 0.5 } };
    const deps = fakeDeps(answers, { probeOk: (url) => !url.includes("9400") });
    const pool = new CloudBrowserPool(deps);
    await pool.pick(machines, "s1");
    answers.cloudA = { ok: false, detail: "Chrome 起不来" };
    deps.tick(60_000);
    expect((await pool.pick(machines, "s1")).machine).toBe("cloudB");
  });

  it("uses a Simular box only through a configured CDP URL", async () => {
    const pool = new CloudBrowserPool(fakeDeps({}));
    const pick = await pool.pick(machines, "s1");
    expect(pick).toMatchObject({ machine: "mcp-box-2", cloud: true, cdpUrl: "http://127.0.0.1:9400" });
  });

  it("falls back to this host, naming why each machine was out", async () => {
    const pool = new CloudBrowserPool(fakeDeps({ cloudA: { ok: false, detail: "没有 Chrome" } }, { probeOk: () => false }));
    const pick = await pool.pick(machines, "s1");
    expect(pick).toMatchObject({ machine: "本机", cloud: false, cdpUrl: null });
    expect(pick.reason).toContain("cloudA：没有 Chrome");
    expect(pick.reason).toContain("mcp-box：无 CDP 通道");
    expect(pick.reason).toContain("回落本机");
  });

  it("does not count a machine whose tunnel will not come up", async () => {
    const pool = new CloudBrowserPool(fakeDeps({ cloudA: { ok: true, load: 0 } }, { tunnelOk: false, probeOk: () => false }));
    const pick = await pool.pick(machines.slice(0, 1), "s1");
    expect(pick.cloud).toBe(false);
    expect(pick.reason).toContain("隧道起不来");
  });

  it("asks each machine once per health window", async () => {
    const deps = fakeDeps({ cloudA: { ok: true, load: 0 } });
    const pool = new CloudBrowserPool(deps);
    const one = machines.slice(0, 1);
    await Promise.all([pool.pick(one, "a"), pool.pick(one, "b")]);
    await pool.pick(one, "c");
    expect(deps.calls.remote).toBe(1);
    deps.tick(31_000);
    await pool.pick(one, "c");
    expect(deps.calls.remote).toBe(2);
    pool.invalidate("a");
    await pool.pick(one, "c");
    expect(deps.calls.remote).toBe(3);
  });

  it("says so when there is no cloud machine at all", async () => {
    const pick = await new CloudBrowserPool(fakeDeps({})).pick([], "s1");
    expect(pick).toMatchObject({ cloud: false, cdpUrl: null, reason: "没有云端机器，用本机" });
  });
});

describe("remote Chrome and tunnels", () => {
  it("reads the remote script's answer as load per core or a reason", () => {
    expect(parseRemoteAnswer("OMB_OK 1.00 4\n")).toEqual({ ok: true, load: 0.25 });
    expect(parseRemoteAnswer("OMB_ERR 没有 Chrome\n")).toEqual({ ok: false, detail: "没有 Chrome" });
    expect(parseRemoteAnswer("")).toEqual({ ok: false, detail: "SSH 不通" });
  });

  it("starts Chrome headless on the remote loopback only", () => {
    const script = remoteChromeScript(9335);
    expect(script).toContain("--headless=new");
    expect(script).toContain("--remote-debugging-address=127.0.0.1");
    expect(script).toContain("--remote-debugging-port=$P");
    expect(script).toContain("P=9335");
  });

  it("tunnels the cloud Chrome's loopback port here, with no reverse forward", () => {
    const args = tunnelArgs("cloudA", 9341);
    expect(args).toEqual(expect.arrayContaining(["-L", "127.0.0.1:9341:127.0.0.1:9335", "cloudA", "ExitOnForwardFailure=yes"]));
    expect(args).not.toContain("-R");
  });

  it("tunes the tunnel for a slow trans-Pacific link: compression, cheap ciphers, a 20 s dead-link limit (T4)", () => {
    const args = tunnelArgs("cloudA", 19341).join(" ");
    expect(args).toContain("Compression=yes");
    expect(args).toContain("Ciphers=chacha20-poly1305@openssh.com,aes128-gcm@openssh.com");
    expect(args).toContain("ServerAliveInterval=10");
    expect(args).toContain("ServerAliveCountMax=2");
    expect(args).toContain("-L 127.0.0.1:19341:127.0.0.1:9335");
  });
});

describe("sign-in sites (T2)", () => {
  it("matches a configured site and its subdomains, nothing else", () => {
    const domains = ["github.com", "google.com"];
    expect(authDomainOf("https://github.com/login", domains)).toBe("github.com");
    expect(authDomainOf("https://accounts.google.com/x", domains)).toBe("google.com");
    expect(authDomainOf("https://notgithub.com/", domains)).toBeNull();
    expect(authDomainOf("https://example.com/", domains)).toBeNull();
    expect(authDomainOf("file:///tmp/github.com", domains)).toBeNull();
    expect(authDomainOf("not a url", domains)).toBeNull();
  });

  it("uses the defaults until the person sets a list, and shows the settings", () => {
    expect(authDomains({})).toEqual([...DEFAULT_AUTH_DOMAINS]);
    expect(authDomains({ cloudOffload: { authDomains: [" X.com "] } })).toEqual(["x.com"]);
    expect(authDomains({ cloudOffload: { authDomains: [] } })).toEqual([]);
    expect(cloudOffloadSettings({ cloudOffload: { guard: false } })).toEqual({ enabled: true, guard: false, authDomains: [...DEFAULT_AUTH_DOMAINS] });
  });
});
