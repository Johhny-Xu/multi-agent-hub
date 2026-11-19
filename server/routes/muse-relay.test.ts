import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MuseRelayHub } from "../muse-relay.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createWebhookIngressHandler } from "../webhook-ingress.ts";
import type { WebhookManager } from "../webhooks.ts";
import { createMuseRelayHost, type MuseRelayHost } from "./muse-relay.ts";

const dirs: string[] = [];
const servers: Server[] = [];
const hosts: MuseRelayHost[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const host of hosts.splice(0)) host.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "omb-muse-relay-routes-"));
  dirs.push(dir);
  const hub = new MuseRelayHub({ dataDir: dir });
  const host = createMuseRelayHost({
    hub,
    instanceDriver: (instanceId) => instanceId === "inst" ? "museRelay" : instanceId === "other" ? "meta" : undefined,
    canManage: (auth: RequestAuth) => auth.kind === "loopback" && auth.scopes.includes("admin"),
  });
  hosts.push(host);
  const webhooks = {} as WebhookManager;
  const handle = createWebhookIngressHandler(webhooks, undefined, host.door);
  const server = createServer((req, res) => { void handle(req, res); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const admin: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
  const viewer: RequestAuth = { kind: "loopback", scopes: ["client"] };

  const app = async (method: string, path: string, auth: RequestAuth = admin) => {
    let answered: { status: number; body: Record<string, any> } | undefined;
    const res = { headersSent: false, writableEnded: false } as never;
    await host.routes({
      req: {} as never, res, url: new URL(`http://x${path}`), path, method, auth,
      json: ((_res: unknown, status: number, value: Record<string, any>) => { answered = { status, body: value }; }) as never,
      readBody: (async () => undefined) as never,
    });
    return answered!;
  };

  const call = async (path: string, init: {
    token?: string;
    body?: RequestInit["body"];
    method?: string;
    headers?: Record<string, string>;
  } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? "POST",
      headers: {
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    const text = await response.text();
    return { status: response.status, bytes: Buffer.byteLength(text), body: text ? JSON.parse(text) as Record<string, any> : {} };
  };

  return { dir, hub, host, base, admin, viewer, app, call };
}

async function connection(h: Awaited<ReturnType<typeof harness>>) {
  const created = await h.app("POST", "/api/instances/inst/muse-relay/connections");
  expect(created.status).toBe(200);
  return created.body.credentials as { connectionId: string; token: string; basePath: string };
}

describe("the Muse relay management API", () => {
  it("is owner/admin only and only for a museRelay instance", async () => {
    const h = await harness();
    expect((await h.app("GET", "/api/instances/inst/muse-relay", h.viewer)).status).toBe(403);
    expect((await h.app("GET", "/api/instances/nope/muse-relay")).status).toBe(404);
    expect((await h.app("GET", "/api/instances/other/muse-relay")).status).toBe(404);
  });

  it("returns a token once and never in a later view", async () => {
    const h = await harness();
    const credentials = await connection(h);
    expect(credentials.basePath).toBe(`/hooks/muse-relay/v1/${credentials.connectionId}`);
    const listed = await h.app("GET", "/api/instances/inst/muse-relay");
    expect(listed.status).toBe(200);
    expect(listed.body.config.connections).toHaveLength(1);
    expect(listed.body.config.connections[0]).toMatchObject({ connectionId: credentials.connectionId, online: false, lastSeenAt: null });
    expect(listed.body.config.pendingTurns).toBe(0);
    expect(listed.body.config.canManage).toBe(true);
    expect(JSON.stringify(listed.body)).not.toContain(credentials.token);
  });

  it("rotates the token in place and deletes the connection", async () => {
    const h = await harness();
    const first = await connection(h);
    const rotated = await h.app("POST", `/api/instances/inst/muse-relay/connections/${first.connectionId}/rotate`);
    expect(rotated.status).toBe(200);
    expect(rotated.body.credentials.connectionId).toBe(first.connectionId);
    expect(rotated.body.credentials.token).not.toBe(first.token);
    expect((await h.call(`${first.basePath}/heartbeat`, { token: first.token, body: JSON.stringify({ schemaVersion: 1 }) })).status).toBe(401);
    expect((await h.call(`${first.basePath}/heartbeat`, { token: rotated.body.credentials.token, body: JSON.stringify({ schemaVersion: 1 }) })).status).toBe(200);

    const removed = await h.app("DELETE", `/api/instances/inst/muse-relay/connections/${first.connectionId}`);
    expect(removed.status).toBe(200);
    expect(removed.body.config.connections).toHaveLength(0);
    expect((await h.call(`${first.basePath}/heartbeat`, { token: rotated.body.credentials.token, body: JSON.stringify({ schemaVersion: 1 }) })).status).toBe(403);
  });
});

describe("the Muse relay door", () => {
  it("requires a valid token and POST", async () => {
    const h = await harness();
    const credentials = await connection(h);
    expect((await h.call(`${credentials.basePath}/poll`, { body: JSON.stringify({ schemaVersion: 1 }) })).status).toBe(401);
    expect((await h.call(`${credentials.basePath}/poll`, { token: "wrong", body: JSON.stringify({ schemaVersion: 1 }) })).status).toBe(401);
    expect((await h.call(`${credentials.basePath}/poll`, { token: credentials.token, method: "GET" })).status).toBe(405);
    expect((await h.call(`${credentials.basePath}/poll`, { token: credentials.token, body: JSON.stringify({ schemaVersion: 2 }) })).status).toBe(400);
  });

  it("polls, heartbeats and writes ordered events", async () => {
    const h = await harness();
    const credentials = await connection(h);
    const queued = h.hub.queueTurn({ instanceId: "inst", threadId: "thread-1", text: "hello", transcript: [] });
    const polled = await h.call(`${credentials.basePath}/poll`, {
      token: credentials.token,
      body: JSON.stringify({ schemaVersion: 1, waitMs: 0, limit: 1 }),
    });
    expect(polled.status).toBe(200);
    expect(polled.body.schemaVersion).toBe(1);
    expect(polled.body.deliveries).toHaveLength(1);
    const delivery = polled.body.deliveries[0];
    expect(delivery).toMatchObject({ turnId: queued.turnId, attempt: 1, input: { threadId: "thread-1", text: "hello", transcript: [] } });

    const heartbeat = await h.call(`${credentials.basePath}/heartbeat`, {
      token: credentials.token,
      body: JSON.stringify({ schemaVersion: 1, turnId: queued.turnId, deliveryId: delivery.deliveryId }),
    });
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body).toMatchObject({ ok: true, cancelled: false, leaseUntil: expect.any(String) });

    const event = async (body: Record<string, unknown>) => h.call(`${credentials.basePath}/turns/${queued.turnId}/events`, {
      token: credentials.token,
      body: JSON.stringify({ schemaVersion: 1, deliveryId: delivery.deliveryId, ...body }),
    });
    const accepted = await event({ eventId: "d1", seq: 1, type: "delta", itemId: "i", text: "hel" });
    expect(accepted).toMatchObject({ status: 200, body: { accepted: true, duplicate: false, eventId: "d1", seq: 1 } });
    expect(await event({ eventId: "d1", seq: 1, type: "delta", itemId: "i", text: "hel" })).toMatchObject({ status: 200, body: { duplicate: true } });
    expect((await event({ eventId: "d1", seq: 1, type: "delta", itemId: "i", text: "different" })).status).toBe(409);
    expect((await event({ eventId: "d2", seq: 3, type: "delta", itemId: "i", text: "x" })).status).toBe(409);
    expect((await event({ eventId: "d2", seq: 2, type: "delta", itemId: "i", text: "lo" })).status).toBe(200);
    expect((await event({ eventId: "d3", seq: 3, type: "text", itemId: "i", text: "wrong" })).status).toBe(400);
    expect((await event({ eventId: "d3", seq: 3, type: "text", itemId: "i", text: "hello" })).status).toBe(200);
    expect((await event({ eventId: "done", seq: 4, type: "completed" })).status).toBe(200);
    expect((await event({ eventId: "late", seq: 5, type: "text", itemId: "i", text: "late" })).status).toBe(409);
  });

  it("accepts a file once, dedupes the same bytes and rejects different bytes", async () => {
    const h = await harness();
    const credentials = await connection(h);
    const queued = h.hub.queueTurn({ instanceId: "inst", threadId: "thread-1", text: "hello", transcript: [] });
    const delivery = (await h.call(`${credentials.basePath}/poll`, {
      token: credentials.token,
      body: JSON.stringify({ schemaVersion: 1, waitMs: 0, limit: 1 }),
    })).body.deliveries[0];
    const files: string[] = [];
    let savedPath = "";
    h.hub.subscribe((event) => { if (event.type === "turn.file") { files.push(event.file.eventId); savedPath = event.file.path; } });
    const url = `${credentials.basePath}/turns/${queued.turnId}/files?deliveryId=${encodeURIComponent(delivery.deliveryId)}&eventId=file-1&seq=1&name=note.txt`;
    const first = await h.call(url, { token: credentials.token, body: "hello file", headers: { "content-type": "text/plain" } });
    expect(first).toMatchObject({ status: 200, body: { accepted: true, duplicate: false, eventId: "file-1", seq: 1 } });
    expect(files).toEqual(["file-1"]);
    const second = await h.call(url, { token: credentials.token, body: "hello file", headers: { "content-type": "text/plain" } });
    expect(second).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(files).toEqual(["file-1"]);
    const conflict = await h.call(url, { token: credentials.token, body: "different", headers: { "content-type": "text/plain" } });
    expect(conflict.status).toBe(409);
    expect(readFileSync(savedPath, "utf8")).toBe("hello file");
    expect(files).toEqual(["file-1"]);
  });

  it("stores an image as an image and rejects a traversal name", async () => {
    const h = await harness();
    const credentials = await connection(h);
    const queued = h.hub.queueTurn({ instanceId: "inst", threadId: "thread-1", text: "hello", transcript: [] });
    const delivery = (await h.call(`${credentials.basePath}/poll`, {
      token: credentials.token,
      body: JSON.stringify({ schemaVersion: 1, waitMs: 0, limit: 1 }),
    })).body.deliveries[0];
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const base = `${credentials.basePath}/turns/${queued.turnId}/files?deliveryId=${encodeURIComponent(delivery.deliveryId)}&eventId=image-1&seq=1`;
    expect((await h.call(`${base}&name=../evil.png`, { token: credentials.token, body: png, headers: { "content-type": "image/png" } })).status).toBe(400);
    const stored = await h.call(`${base}&name=photo.png`, { token: credentials.token, body: png, headers: { "content-type": "image/png" } });
    expect(stored.status).toBe(200);
    expect(stored.body.duplicate).toBe(false);
  });

  it("never echoes a token or a private path in an error", async () => {
    const h = await harness();
    const credentials = await connection(h);
    const response = await h.call(`${credentials.basePath}/turns/not-a-turn/events`, {
      token: credentials.token,
      body: JSON.stringify({ schemaVersion: 1, deliveryId: "x", eventId: "e", seq: 1, type: "text", itemId: "i", text: "x" }),
    });
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(credentials.token);
    expect(JSON.stringify(response.body)).not.toContain("/tmp/");
  });

  describe("input by reference", () => {
    const RESPONSE_CAP = 6 * 1024;
    const bigTurn = (h: Awaited<ReturnType<typeof harness>>) => h.hub.queueTurn({
      instanceId: "inst",
      threadId: "thread-big",
      text: "请总结一下 ✓",
      system: "You are OMB's Muse assistant. ".repeat(200),
      transcript: Array.from({ length: 10 }, (_, index) => ({
        role: (index % 2 ? "assistant" : "user") as "user" | "assistant",
        text: `消息 ${index}: ` + "x".repeat(700),
      })),
    });

    it("keeps the legacy inline delivery when the poll names no inputMode", async () => {
      const h = await harness();
      const credentials = await connection(h);
      const queued = bigTurn(h);
      const polled = await h.call(`${credentials.basePath}/poll`, {
        token: credentials.token,
        body: JSON.stringify({ schemaVersion: 1, waitMs: 0, limit: 1 }),
      });
      expect(polled.status).toBe(200);
      expect(polled.body.deliveries[0]).toMatchObject({ turnId: queued.turnId, input: { threadId: "thread-big", text: "请总结一下 ✓" } });
      expect(polled.body.deliveries[0]).not.toHaveProperty("inputBytes");
      expect(polled.bytes).toBeGreaterThan(RESPONSE_CAP);
    });

    it("polls a small ref and returns the input in slices under 6 KB each", async () => {
      const h = await harness();
      const credentials = await connection(h);
      const queued = bigTurn(h);
      const polled = await h.call(`${credentials.basePath}/poll`, {
        token: credentials.token,
        body: JSON.stringify({ schemaVersion: 1, waitMs: 0, limit: 1, inputMode: "ref" }),
      });
      expect(polled.status).toBe(200);
      expect(polled.bytes).toBeLessThan(1024);
      const ref = polled.body.deliveries[0];
      expect(ref).toMatchObject({ turnId: queued.turnId, attempt: 1, inputBytes: expect.any(Number), inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(ref).not.toHaveProperty("input");
      expect(ref.inputBytes).toBeGreaterThan(10_000);

      const slice = (body: Record<string, unknown>, turnId = queued.turnId) => h.call(`${credentials.basePath}/turns/${turnId}/input`, {
        token: credentials.token,
        body: JSON.stringify({ deliveryId: ref.deliveryId, ...body }),
      });
      const parts: Buffer[] = [];
      for (let offset = 0; offset < ref.inputBytes;) {
        const answer = await slice({ schemaVersion: 1, offset, length: 4096 });
        expect(answer.status).toBe(200);
        expect(answer.bytes).toBeLessThanOrEqual(RESPONSE_CAP);
        expect(answer.body).toMatchObject({ schemaVersion: 1, offset, total: ref.inputBytes });
        const data = Buffer.from(answer.body.data, "base64");
        expect(data.byteLength).toBeGreaterThan(0);
        parts.push(data);
        offset += data.byteLength;
      }
      const joined = Buffer.concat(parts);
      expect(joined.byteLength).toBe(ref.inputBytes);
      expect(createHash("sha256").update(joined).digest("hex")).toBe(ref.inputSha256);
      expect(JSON.parse(joined.toString("utf8"))).toMatchObject({ threadId: "thread-big", text: "请总结一下 ✓" });

      expect((await slice({ offset: 0, length: 4097 })).status).toBe(400);
      expect((await slice({ offset: 0, length: 10, extra: 1 })).status).toBe(400);
      expect((await slice({ offset: 0, length: 10, deliveryId: "mrd_other" })).status).toBe(409);
      expect((await slice({ offset: 0, length: 10 }, "not-a-turn")).status).toBe(404);
      const wrongToken = await h.call(`${credentials.basePath}/turns/${queued.turnId}/input`, {
        token: "wrong",
        body: JSON.stringify({ deliveryId: ref.deliveryId, offset: 0, length: 10 }),
      });
      expect(wrongToken.status).toBe(401);

      const heartbeat = await h.call(`${credentials.basePath}/heartbeat`, {
        token: credentials.token,
        body: JSON.stringify({ schemaVersion: 1, turnId: queued.turnId, deliveryId: ref.deliveryId }),
      });
      expect(heartbeat.bytes).toBeLessThan(512);
      const done = await h.call(`${credentials.basePath}/turns/${queued.turnId}/events`, {
        token: credentials.token,
        body: JSON.stringify({ schemaVersion: 1, deliveryId: ref.deliveryId, eventId: "done", seq: 1, type: "completed" }),
      });
      expect(done.status).toBe(200);
      expect(done.bytes).toBeLessThan(512);
      const afterDone = await slice({ offset: 0, length: 10 });
      expect(afterDone.status).toBe(409);
      expect(JSON.stringify(afterDone.body)).not.toContain(credentials.token);
    });

    it("rejects an unknown inputMode", async () => {
      const h = await harness();
      const credentials = await connection(h);
      const polled = await h.call(`${credentials.basePath}/poll`, {
        token: credentials.token,
        body: JSON.stringify({ schemaVersion: 1, waitMs: 0, inputMode: "chunks" }),
      });
      expect(polled.status).toBe(400);
    });
  });
});
