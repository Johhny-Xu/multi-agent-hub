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
  cloudOffloadActive,
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

  it("acts only while a cloud machine is configured, however it is switched", () => {
    const one = { instances: [{ id: "i1", name: "cloud-a", kind: "ssh", sshAlias: "cloud-a" }] };
    expect(cloudOffloadActive({})).toBe(false);
    expect(cloudOffloadActive({ vps: { instances: [] } } as never)).toBe(false);
    expect(cloudOffloadActive({ vps: one } as never)).toBe(true);
    expect(cloudOffloadActive({ vps: one, cloudOffload: { enabled: false } } as never)).toBe(false);
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

describe("Simular boxes relayed through an SSH machine (T6)", () => {
  const BOX_VPS = {
    instances: [
      { id: "a", name: "cloud-a", kind: "ssh", sshAlias: "cloud-a" },
      { id: "b", name: "cloud-b", kind: "ssh", sshAlias: "cloud-b" },
      { id: "box1", name: "box-one", kind: "mcp", adapter: "simular-box", mcpServer: "box-1" },
      { id: "box2", name: "box-two", kind: "mcp", adapter: "simular-box", mcpServer: "box-2" },
    ],
  };

  it("gives every box the relay host's alias and its own relay, tunnel and proxy ports", () => {
    const machines = cloudBrowserMachines({ vps: BOX_VPS, cloudOffload: { boxRelayVia: "a" } } as never);
    expect(machines.map((m) => m.name)).toEqual(["cloud-a", "cloud-b", "box-one", "box-two"]);
    expect(machines[2]).toMatchObject({
      kind: "mcp",
      mcpServer: "box-1",
      relayAlias: "cloud-a",
      relayPort: 19400,
      localPort: 19351,
      proxyPort: 9351,
    });
    expect(machines[3]).toMatchObject({
      kind: "mcp",
      mcpServer: "box-2",
      relayAlias: "cloud-a",
      relayPort: 19401,
      localPort: 19352,
      proxyPort: 9352,
    });
    // The SSH machines keep the ports they had before the boxes existed.
    expect(machines[0]).toMatchObject({ kind: "ssh", sshAlias: "cloud-a", localPort: 19341, proxyPort: 9341 });
    expect(machines[1]).toMatchObject({ kind: "ssh", sshAlias: "cloud-b", localPort: 19342, proxyPort: 9342 });
  });

  it("relays a box only when a named SSH machine says so, and never over a box's own CDP URL", () => {
    const withoutRelay = cloudBrowserMachines({ vps: BOX_VPS } as never);
    expect(withoutRelay[2]).toEqual({ id: "box1", name: "box-one", kind: "mcp" });

    const unknown = cloudBrowserMachines({ vps: BOX_VPS, cloudOffload: { boxRelayVia: "no-such-machine" } } as never);
    expect(unknown[2]).toEqual({ id: "box1", name: "box-one", kind: "mcp" });

    const notAnSshMachine = cloudBrowserMachines({ vps: BOX_VPS, cloudOffload: { boxRelayVia: "box1" } } as never);
    expect(notAnSshMachine[2]).toEqual({ id: "box1", name: "box-one", kind: "mcp" });

    const withCdpUrl = cloudBrowserMachines({
      vps: { instances: [...BOX_VPS.instances, { id: "box3", name: "box-three", kind: "mcp", adapter: "simular-box", mcpServer: "box-3", browserCdpUrl: "http://127.0.0.1:9400" }] },
      cloudOffload: { boxRelayVia: "a" },
    } as never);
    expect(withCdpUrl[4]).toEqual({ id: "box3", name: "box-three", kind: "mcp", cdpUrl: "http://127.0.0.1:9400" });
  });

  it("asks a relayed box again only every 5 minutes, an SSH machine every 30 seconds", async () => {
    const machines = cloudBrowserMachines({ vps: BOX_VPS, cloudOffload: { boxRelayVia: "a" } } as never);
    const box = machines.find((machine) => machine.relayAlias !== undefined)!;
    const ssh = machines.find((machine) => machine.kind === "ssh")!;
    const deps = fakeDeps({ [box.name]: { ok: true, load: 0.05 }, [ssh.name]: { ok: true, load: 0.1 } });
    // The box is the idler one, so the first pick brings it up (E80: a cold box is brought up only when chosen).
    deps.probeBox = async () => ({ ok: true, load: 0.05 });
    const asked: string[] = [];
    const ensureRemote = deps.ensureRemote.bind(deps);
    deps.ensureRemote = async (machine) => { asked.push(machine.name); return await ensureRemote(machine); };
    const pool = new CloudBrowserPool(deps);
    await pool.pick([box, ssh], "s1");
    deps.tick(31_000);
    await pool.pick([box, ssh], "s1");
    expect(asked.filter((name) => name === box.name)).toHaveLength(1);
    expect(asked.filter((name) => name === ssh.name)).toHaveLength(2);
    deps.tick(5 * 60_000);
    await pool.pick([box, ssh], "s1");
    expect(asked.filter((name) => name === box.name)).toHaveLength(2);
  });

  it("brings a box up over the relay and tunnels to it, and falls back when the box sleeps", async () => {
    const machines = cloudBrowserMachines({ vps: BOX_VPS, cloudOffload: { boxRelayVia: "a" } } as never);
    const box = machines[2]!;
    const calls = { remote: [] as string[], tunnel: [] as string[], probe: [] as string[] };
    const deps: CloudBrowserDeps = {
      now: () => 0,
      async ensureRemote(machine) {
        calls.remote.push(machine.id);
        return { ok: true, load: 0.2 };
      },
      async ensureTunnel(machine) {
        calls.tunnel.push(machine.id);
        return true;
      },
      async probe(url) {
        calls.probe.push(url);
        return true;
      },
    };
    const pick = await new CloudBrowserPool(deps).pick([box], "s1");
    expect(pick).toMatchObject({ machine: "box-one", cloud: true, cdpUrl: "http://127.0.0.1:19351" });
    expect(calls.remote).toEqual(["box1"]);
    expect(calls.tunnel).toEqual(["box1"]);
    expect(calls.probe).toContain("http://127.0.0.1:19351");

    const asleepCalls = { remote: 0 };
    const asleep: CloudBrowserDeps = {
      now: () => 0,
      async ensureRemote() {
        asleepCalls.remote += 1;
        return { ok: false, detail: "休眠中" };
      },
      async ensureTunnel() {
        return false;
      },
      async probe() {
        return false;
      },
    };
    const fallback = await new CloudBrowserPool(asleep).pick([box], "s2");
    expect(fallback).toMatchObject({ machine: "本机", cloud: false, cdpUrl: null });
    expect(fallback.reason).toContain("休眠中");
    expect(asleepCalls.remote).toBe(1);
  });

  it("tunnels a box's relay port to this host, not the Chrome port", () => {
    const args = tunnelArgs("cloud-a", 19351, 19400);
    expect(args).toEqual(expect.arrayContaining(["-L", "127.0.0.1:19351:127.0.0.1:19400", "cloud-a"]));
    expect(tunnelArgs("cloud-a", 19351).join(" ")).toContain("-L 127.0.0.1:19351:127.0.0.1:9335");
  });
});

describe("relayed boxes only while they are used (E80, E88)", () => {
  const VPS_RELAY = {
    instances: [
      { id: "a", name: "cloud-a", kind: "ssh", sshAlias: "cloud-a" },
      { id: "box1", name: "box-one", kind: "mcp", adapter: "simular-box", mcpServer: "box-1" },
    ],
  };

  it("relays through a relay-only ssh host that is neither a VPS computer nor a browser machine, as a dedicated account", () => {
    const machines = cloudBrowserMachines({ vps: VPS_RELAY, cloudOffload: { boxRelayVia: "ssh:relay-host", boxRelayUser: "ombrelay" } } as never);
    expect(machines.map((m) => m.name)).toEqual(["cloud-a", "box-one"]);
    expect(machines.some((m) => m.sshAlias === "relay-host")).toBe(false);
    expect(machines[1]).toMatchObject({ relayAlias: "relay-host", relayUser: "ombrelay", relayPort: 19400, localPort: 19351, proxyPort: 9351 });
    // Without a dedicated account the box gets the relay host's login, as before; an unsafe alias or account is dropped.
    expect(cloudBrowserMachines({ vps: VPS_RELAY, cloudOffload: { boxRelayVia: "a" } } as never)[1]!.relayUser).toBeUndefined();
    expect(cloudBrowserMachines({ vps: VPS_RELAY, cloudOffload: { boxRelayVia: "ssh:x; rm" } } as never)[1]).toEqual({ id: "box1", name: "box-one", kind: "mcp" });
    expect(cloudBrowserMachines({ vps: VPS_RELAY, cloudOffload: { boxRelayVia: "ssh:relay-host", boxRelayUser: "Root;x" } } as never)[1]!.relayUser).toBeUndefined();
  });

  it("never asks a cold box anything from a passive pick, and brings it up only when a demand pick chooses it", async () => {
    const machines = cloudBrowserMachines({ vps: VPS_RELAY, cloudOffload: { boxRelayVia: "ssh:relay-host" } } as never);
    const calls = { up: [] as string[], light: [] as string[] };
    let boxLoad = 0.05;
    const deps: CloudBrowserDeps = {
      now: () => 0,
      async ensureRemote(machine) { calls.up.push(machine.name); return { ok: true, load: machine.name === "box-one" ? boxLoad : 0.5 }; },
      async ensureTunnel() { return true; },
      async probe() { return true; },
      async probeBox(machine) { calls.light.push(machine.name); return { ok: true, load: boxLoad }; },
    };
    const pool = new CloudBrowserPool(deps);
    const passive = await pool.pick(machines, "guard", "本机", { passive: true });
    expect(passive.machine).toBe("cloud-a");
    expect(calls.light).toEqual([]);
    expect(calls.up).toEqual(["cloud-a"]);
    expect(pool.warmBoxes()).toEqual([]);

    const demand = await pool.pick(machines, "s1");
    expect(demand).toMatchObject({ machine: "box-one", cdpUrl: "http://127.0.0.1:19351" });
    expect(calls.light).toEqual(["box-one"]);
    expect(calls.up).toEqual(["cloud-a", "box-one"]);
    expect(pool.warmBoxes()).toEqual(["box1"]);

    // A busier cold box is weighed by its light answer and left down.
    const other = new CloudBrowserPool({ ...deps, probeBox: async (machine) => { calls.light.push(machine.name); return { ok: true, load: 0.9 }; } });
    calls.up.length = 0;
    expect((await other.pick(machines, "s2")).machine).toBe("cloud-a");
    expect(calls.up).toEqual(["cloud-a"]);
    expect(other.warmBoxes()).toEqual([]);

    // A sleeping box is never brought up.
    const asleep = new CloudBrowserPool({ ...deps, probeBox: async () => ({ ok: false, detail: "休眠中" }) });
    calls.up.length = 0;
    const pick = await asleep.pick([machines[1]!], "s3");
    expect(pick).toMatchObject({ cloud: false });
    expect(pick.reason).toContain("休眠中");
    expect(calls.up).toEqual([]);
  });

  it("keeps a warm box out of the background once its answer is stale, and forgets it on release", async () => {
    const machines = cloudBrowserMachines({ vps: VPS_RELAY, cloudOffload: { boxRelayVia: "ssh:relay-host" } } as never);
    const box = machines[1]!;
    let clock = 0;
    const up: string[] = [];
    const deps: CloudBrowserDeps = {
      now: () => clock,
      async ensureRemote(machine) { up.push(machine.name); return { ok: true, load: 0.1 }; },
      async ensureTunnel() { return true; },
      async probe() { return true; },
      async probeBox() { return { ok: true, load: 0.1 }; },
    };
    const pool = new CloudBrowserPool(deps);
    await pool.pick([box], "s1");
    expect(up).toEqual(["box-one"]);
    // Within its health window the guard may reuse the warm box's door, without asking it.
    expect((await pool.pick([box], "guard", "本机", { passive: true })).machine).toBe("box-one");
    clock += 6 * 60_000;
    const stale = await pool.pick([box], "guard", "本机", { passive: true });
    expect(stale).toMatchObject({ cloud: false });
    expect(stale.reason).toContain("空闲未连");
    expect(up).toEqual(["box-one"]);
    pool.release("box1");
    expect(pool.warmBoxes()).toEqual([]);
    expect((await pool.pick([box], "guard", "本机", { passive: true })).cloud).toBe(false);
    expect(up).toEqual(["box-one"]);
    // The next browser call brings it up again.
    expect((await pool.pick([box], "s1")).machine).toBe("box-one");
    expect(up).toEqual(["box-one", "box-one"]);
  });

  it("ends what a bring-up started when the box's relay never answers, and leaves a sleeping box untouched", async () => {
    const machines = cloudBrowserMachines({ vps: VPS_RELAY, cloudOffload: { boxRelayVia: "ssh:relay-host" } } as never);
    const box = machines[1]!;
    const ended: string[] = [];
    const base: CloudBrowserDeps = {
      now: () => 0,
      async ensureRemote() { return { ok: true, load: 0.1 }; },
      async ensureTunnel() { return true; },
      async probe() { return false; },
      async probeBox() { return { ok: true, load: 0.1 }; },
      async teardown(machine) { ended.push(machine.name); },
    };
    const pick = await new CloudBrowserPool(base).pick([box], "s1");
    expect(pick).toMatchObject({ cloud: false });
    expect(pick.reason).toContain("隧道不通");
    expect(ended).toEqual(["box-one"]);
    ended.length = 0;
    const asleep = await new CloudBrowserPool({ ...base, probeBox: async () => ({ ok: false, detail: "休眠中" }) }).pick([box], "s1");
    expect(asleep.reason).toContain("休眠中");
    expect(ended).toEqual([]);
  });
});
