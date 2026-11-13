// T6: the box relay, exercised for real on this host — the two scripts that carry a Simular box's Chrome over one
// ssh session, and the shell fragments the box runs. Everything here is local: loopback ports, a throwaway script
// directory and placeholder host names, so the suite touches no machine of the person's.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  RELAY_PERL_SCRIPT,
  RELAY_SCRIPT,
  SOCKS_CONNECT_SCRIPT,
  boxDownScript,
  boxSshConfig,
  boxUpScript,
  parseBoxPub,
  parseSshG,
  relayHostDownScript,
  relayHostScript,
  scriptsHash,
} from "./cloud-box-relay.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

interface EchoServer {
  port: number;
  /** How many of its sockets the peer closed. */
  closes: () => number;
  stop: () => Promise<void>;
}

/** A loopback server that writes back every byte it is given, and counts the sockets the peer closed. */
function startEchoServer(): Promise<EchoServer> {
  return new Promise((resolve) => {
    let closes = 0;
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("data", (chunk) => socket.write(chunk));
      socket.on("close", () => { closes += 1; sockets.delete(socket); });
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        closes: () => closes,
        stop: async () => {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

/** A port the relay can bind, taken from the kernel and given back before the relay asks for it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

/** The first connection that gets through; a refused one leaves no socket behind on the server. */
function connect(port: number, deadlineMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => resolve(socket));
      socket.once("error", (error: Error) => {
        socket.destroy();
        if (Date.now() - started > deadlineMs) reject(error);
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

/** The first `count` bytes the socket delivers. */
function read(socket: net.Socket, count: number, deadlineMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => {
      socket.off("data", onData);
      reject(new Error(`only ${total} of ${count} bytes arrived`));
    }, deadlineMs);
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total < count) return;
      clearTimeout(timer);
      socket.off("data", onData);
      resolve(Buffer.concat(chunks));
    };
    socket.on("data", onData);
  });
}

function waitFor(condition: () => boolean, deadlineMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() - started > deadlineMs) return reject(new Error("the relay never settled"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe("the box relay script", () => {
  it("carries bytes over one session, keeps concurrent connections apart, and survives a 200 KB payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-relay-"));
    const relayPath = join(dir, "relay.mjs");
    writeFileSync(relayPath, RELAY_SCRIPT);
    const echo = await startEchoServer();
    const cloudPort = await freePort();
    // The box side spawns the cloud side, as the box's ssh session does.
    const relay = spawn(process.execPath, [relayPath, "box", String(echo.port), "--", process.execPath, relayPath, "cloud", String(cloudPort)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(relay);
    relay.stdout.resume();
    relay.stderr.resume();

    try {
      const first = await connect(cloudPort, 10_000);
      first.write("hello");
      expect((await read(first, 5, 10_000)).toString()).toBe("hello");

      const payloads = ["alpha", "bravo", "charlie"];
      const sockets = await Promise.all(payloads.map(() => connect(cloudPort, 10_000)));
      for (const [index, socket] of sockets.entries()) socket.write(payloads[index]!);
      const received = await Promise.all(sockets.map((socket, index) => read(socket, payloads[index]!.length, 10_000)));
      expect(received.map((chunk) => chunk.toString())).toEqual(payloads);
      for (const socket of sockets) socket.destroy();

      const big = Buffer.alloc(200 * 1024);
      for (let index = 0; index < big.length; index++) big[index] = index % 251;
      const bulk = await connect(cloudPort, 10_000);
      bulk.write(big);
      expect(await read(bulk, big.length, 15_000)).toEqual(big);
      bulk.destroy();
      first.destroy();
    } finally {
      await echo.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, hostTimeout(15_000));

  it("closes the far side when the client disconnects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-relay-"));
    const relayPath = join(dir, "relay.mjs");
    writeFileSync(relayPath, RELAY_SCRIPT);
    const echo = await startEchoServer();
    const cloudPort = await freePort();
    const relay = spawn(process.execPath, [relayPath, "box", String(echo.port), "--", process.execPath, relayPath, "cloud", String(cloudPort)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(relay);
    relay.stdout.resume();
    relay.stderr.resume();

    try {
      const client = await connect(cloudPort, 10_000);
      client.write("ping");
      expect((await read(client, 4, 10_000)).toString()).toBe("ping");
      const closesBefore = echo.closes();
      client.destroy();
      await waitFor(() => echo.closes() > closesBefore, 10_000);
      expect(echo.closes()).toBeGreaterThan(closesBefore);
    } finally {
      await echo.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, hostTimeout(15_000));

  it("reaches a target through the box's SOCKS5 proxy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-relay-"));
    const socksPath = join(dir, "socks.mjs");
    writeFileSync(socksPath, SOCKS_CONNECT_SCRIPT);
    const echo = await startEchoServer();
    const hosts: string[] = [];
    const socks = await new Promise<{ port: number }>((resolve) => {
      const server = net.createServer((socket) => {
        socket.on("error", () => {});
        let buffer = Buffer.alloc(0);
        let stage = 0;
        socket.on("data", (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (stage === 0) {
            if (buffer.length < 3) return;
            buffer = buffer.subarray(2 + buffer[1]!);
            socket.write(Buffer.from([5, 0]));
            stage = 1;
          }
          if (stage === 1) {
            if (buffer.length < 5) return;
            if (buffer[3] !== 3) return socket.destroy();
            const length = buffer[4]!;
            if (buffer.length < 5 + length + 2) return;
            hosts.push(buffer.subarray(5, 5 + length).toString("utf8"));
            const port = buffer.readUInt16BE(5 + length);
            buffer = buffer.subarray(7 + length);
            const upstream = net.connect(echo.port, "127.0.0.1", () => {
              socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, (port >> 8) & 0xff, port & 0xff]));
              socket.pipe(upstream);
              upstream.pipe(socket);
            });
            upstream.on("error", () => socket.destroy());
            stage = 2;
          }
        });
      });
      server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port }));
    });

    const client = spawn(process.execPath, [socksPath, String(socks.port), "target.invalid", String(echo.port)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(client);
    client.stderr.resume();

    try {
      const chunks: Buffer[] = [];
      client.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      client.stdin.write("ping");
      await waitFor(() => Buffer.concat(chunks).toString().includes("ping"), 10_000);
      expect(Buffer.concat(chunks).toString()).toContain("ping");
      expect(hosts).toContain("target.invalid");
    } finally {
      await echo.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, hostTimeout(15_000));
});

describe("the box's ssh config and up script", () => {
  it("names the relay host, its key and its proxy, and asks for no password", () => {
    const config = boxSshConfig({ hostname: "relay.example", user: "user-x", port: 2222 }, 1080);
    expect(config).toContain("HostName relay.example");
    expect(config).toContain("User user-x");
    expect(config).toContain("Port 2222");
    expect(config).toContain("socks-connect.mjs 1080 %h %p");
    expect(config).toContain("IdentitiesOnly yes");
    expect(config).toContain("BatchMode yes");
    expect(config).not.toContain("Password");
  });

  it("starts Chrome on the box's own loopback and hides the ssh config in base64", () => {
    const sshConfig = boxSshConfig({ hostname: "relay.example", user: "user-x", port: 2222 }, 1080);
    const script = boxUpScript({ cdpPort: 9335, relayPort: 19400, httpProxyPort: 3128, socksPort: 1080 }, sshConfig);
    expect(script).toContain("--remote-debugging-address=127.0.0.1");
    expect(script).toContain("--proxy-server=http://127.0.0.1:3128");
    expect(script).toContain("19400");
    expect(script).toContain("omb-relay-loop-");
    expect(script).toContain("OMB_OK");
    expect(script).toContain("OMB_ERR");
    expect(script).toContain(Buffer.from(sshConfig).toString("base64"));
    expect(script).not.toContain("relay.example");
  });

  it("writes shell fragments bash accepts", () => {
    const sshConfig = boxSshConfig({ hostname: "relay.example", user: "user-x", port: 2222 }, 1080);
    const up = spawnSync("bash", ["-n"], { input: boxUpScript({ cdpPort: 9335, relayPort: 19400, httpProxyPort: 3128, socksPort: 1080 }, sshConfig), encoding: "utf8" });
    expect(up.status).toBe(0);
    const host = spawnSync("bash", ["-n"], { input: relayHostScript(), encoding: "utf8" });
    expect(host.status).toBe(0);
  });
});

describe("the relay host", () => {
  it("reads the host out of ssh -G and refuses a user it cannot trust", () => {
    expect(parseSshG("host relay-a\nhostname relay.example\nuser user-x\nport 2222\n")).toEqual({
      hostname: "relay.example",
      user: "user-x",
      port: 2222,
    });
    expect(parseSshG("host relay-a\nhostname relay.example\nport 2222\n")).toBeNull();
    expect(parseSshG("host relay-a\nhostname relay.example\nuser user x\nport 2222\n")).toBeNull();
    expect(parseSshG("host relay-a\nhostname relay.example\nuser user;rm\nport 2222\n")).toBeNull();
    expect(parseSshG("host relay-a\nhostname relay.example\nuser user-x\n")).toEqual({
      hostname: "relay.example",
      user: "user-x",
      port: 22,
    });
  });

  it("hashes the scripts it writes, so a box gets them rewritten when they change", () => {
    expect(scriptsHash).toMatch(/^[0-9a-f]{12}$/);
    // A second, independent import of the module must land on the same hash: the box's copy of the scripts is
    // only rewritten when this changes, so a hash that moved on its own would leave the box on stale scripts.
    const modulePath = fileURLToPath(new URL("./cloud-box-relay.ts", import.meta.url));
    const other = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { scriptsHash } from ${JSON.stringify(modulePath)}; process.stdout.write(scriptsHash);`], { encoding: "utf8" });
    expect(other.status).toBe(0);
    expect(other.stdout).toBe(scriptsHash);
  });
});

const hasPerl = spawnSync("perl", ["-MIO::Select", "-MIO::Socket::INET", "-e", "1"]).status === 0;
const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHk7cXbqv6m1Yl0d3Wn3ZbUu0Zz4o2Qm9Gm8b0c1d2e3";

describe("a dedicated relay account (E88)", () => {
  it.skipIf(!hasPerl)("carries bytes through the Perl relay host side, apart per connection, and closes the far side", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-relay-"));
    const relayPath = join(dir, "relay.mjs");
    const perlPath = join(dir, "cdp-relay.pl");
    writeFileSync(relayPath, RELAY_SCRIPT);
    writeFileSync(perlPath, RELAY_PERL_SCRIPT);
    const echo = await startEchoServer();
    const cloudPort = await freePort();
    const relay = spawn(process.execPath, [relayPath, "box", String(echo.port), "--", "perl", perlPath, "cloud", String(cloudPort)], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(relay);
    relay.stdout.resume();
    relay.stderr.resume();
    try {
      const payloads = ["alpha", "bravo", "charlie"];
      const sockets = await Promise.all(payloads.map(() => connect(cloudPort, 10_000)));
      for (const [index, socket] of sockets.entries()) socket.write(payloads[index]!);
      const received = await Promise.all(sockets.map((socket, index) => read(socket, payloads[index]!.length, 10_000)));
      expect(received.map((chunk) => chunk.toString())).toEqual(payloads);
      for (const socket of sockets) socket.destroy();
      const big = Buffer.alloc(300 * 1024);
      for (let index = 0; index < big.length; index++) big[index] = index % 241;
      const bulk = await connect(cloudPort, 10_000);
      bulk.write(big);
      expect(await read(bulk, big.length, 15_000)).toEqual(big);
      const closesBefore = echo.closes();
      bulk.destroy();
      await waitFor(() => echo.closes() > closesBefore, 10_000);
    } finally {
      await echo.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, hostTimeout(20_000));

  it("ends a box's relay session with 9 once nothing has been relayed for the idle time, not while a connection is open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-relay-"));
    const relayPath = join(dir, "relay.mjs");
    writeFileSync(relayPath, RELAY_SCRIPT);
    const echo = await startEchoServer();
    const cloudPort = await freePort();
    const started = Date.now();
    const relay = spawn(process.execPath, [relayPath, "box", String(echo.port), "--", process.execPath, relayPath, "cloud", String(cloudPort)], {
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OMB_RELAY_IDLE_S: "1" },
    });
    children.push(relay);
    relay.stdout.resume();
    relay.stderr.resume();
    let code: number | null = null;
    relay.on("exit", (exitCode) => { code = exitCode; });
    try {
      const held = await connect(cloudPort, 10_000);
      held.write("x");
      await read(held, 1, 10_000);
      await new Promise((r) => setTimeout(r, 2_500));
      expect(code).toBeNull();
      held.destroy();
      await waitFor(() => code !== null, 10_000);
      expect(code).toBe(9);
      expect(Date.now() - started).toBeGreaterThan(2_500);
    } finally {
      await echo.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, hostTimeout(20_000));

  it("authorizes a box's key with restrict and a forced command on its own port, root-owned, and refuses odd input", () => {
    const script = relayHostScript({ user: "ombrelay", relayPort: 19400, pub: PUB, tag: "box-1" });
    expect(script).toContain("U=ombrelay; R=19400; T=omb-relay-box-1; D=/opt/omb-relay");
    expect(script).toContain('L="restrict,command=\\"$PL $D/cdp-relay.pl cloud $R\\" ' + PUB + ' $T"');
    expect(script).toContain("install -d -o root -g root -m 755");
    expect(script).toContain('[ "$(id -u)" = 0 ]');
    expect(script).toContain(Buffer.from(RELAY_PERL_SCRIPT).toString("base64"));
    expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8" }).status).toBe(0);
    expect(() => relayHostScript({ user: "root; rm", relayPort: 19400, pub: PUB, tag: "b" })).toThrow();
    expect(() => relayHostScript({ user: "ombrelay", relayPort: 19400, pub: `${PUB}\nssh-ed25519 AAAA evil`, tag: "b" })).toThrow();
    expect(() => relayHostScript({ user: "ombrelay", relayPort: 19400, pub: "ssh-rsa AAAAB3", tag: "b" })).toThrow();
    expect(() => relayHostScript({ user: "ombrelay", relayPort: 19400, pub: PUB, tag: "a b" })).toThrow();
    expect(() => relayHostScript({ user: "ombrelay", relayPort: 22, pub: PUB, tag: "b" })).toThrow();
  });

  it("prints the box's public key only, gives the relay loop its idle time, and reads the key back", () => {
    const script = boxUpScript({ cdpPort: 9335, relayPort: 19400, httpProxyPort: 3128, socksPort: 1080 }, boxSshConfig({ hostname: "relay.example", user: "ombrelay", port: 2222 }, 1080));
    expect(script).toContain(`echo "OMB_PUB $(cut -d' ' -f1,2 "$D/id.pub")"`);
    expect(script).not.toMatch(/cat "\$D\/id"/);
    expect(script).toContain("OMB_RELAY_IDLE_S=720");
    expect(script).toContain("[ $? -eq 9 ]");
    expect(parseBoxPub(`noise\nOMB_PUB ${PUB}\nOMB_OK 0.1 4\n`)).toBe(PUB);
    expect(parseBoxPub("OMB_PUB ssh-ed25519 AAAA;rm -rf /\n")).toBeNull();
    expect(parseBoxPub("OMB_OK 0.1 4\n")).toBeNull();
  });

  it("stops a box's relay processes by port without matching its own shell, and says how many are left", async () => {
    const port = 50000 + Math.floor(Math.random() * 9000);
    const home = mkdtempSync(join(tmpdir(), "omb-home-"));
    const loop = spawn("bash", ["-c", "sleep 60; true", `omb-relay-loop-${port}`], { stdio: "ignore", detached: true });
    children.push(loop);
    const other = spawn("bash", ["-c", "sleep 60; true", `omb-relay-loop-${port + 1}`], { stdio: "ignore", detached: true });
    children.push(other);
    await new Promise((r) => setTimeout(r, 300));
    try {
      const script = boxDownScript(port);
      expect(script).not.toContain(`omb-relay-loop-${port}`);
      const run = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, HOME: home } });
      expect(run.stdout).toMatch(/OMB_DOWN 0/);
      await waitFor(() => loop.exitCode !== null || loop.signalCode !== null, 5_000);
      expect(other.exitCode).toBeNull();
      expect(other.signalCode).toBeNull();
      const host = relayHostDownScript(19400);
      expect(host).toContain("R=19400");
      expect(host).not.toContain("cloud 19400");
      expect(spawnSync("bash", ["-n"], { input: host, encoding: "utf8" }).status).toBe(0);
      expect(() => relayHostDownScript(80)).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, hostTimeout(15_000));
});
