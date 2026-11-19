import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MUSE_RELAY_INPUT_SLICE_MAX_BYTES,
  MuseRelayError,
  MuseRelayHub,
  museRelayDeliveryRef,
  museRelayInputBytes,
  type MuseRelayClock,
  type MuseRelayHubEvent,
} from "./muse-relay.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class ManualClock implements MuseRelayClock {
  time = 1_700_000_000_000;
  private sequence = 0;
  private readonly timers = new Map<number, { at: number; run: () => void }>();

  now = () => this.time;

  setTimeout(run: () => void, ms: number): unknown {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + Math.max(0, ms), run });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    this.time += ms;
    for (let guard = 0; guard < 100; guard++) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.time).sort((a, b) => a[1].at - b[1].at);
      if (!due.length) return;
      for (const [id, timer] of due) {
        if (!this.timers.delete(id)) continue;
        timer.run();
      }
    }
  }
}

function harness(options: {
  queueTimeoutMs?: number;
  turnTimeoutMs?: number;
  leaseMs?: number;
  retentionMs?: number;
  maxPendingPerInstance?: number;
  maxEventsPerTurn?: number;
  maxConnectionsPerInstance?: number;
  maxTerminalPerInstance?: number;
  claimAckMs?: number;
  pickupMs?: number;
  maxResends?: number;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-muse-relay-"));
  dirs.push(dir);
  const clock = new ManualClock();
  const hub = new MuseRelayHub({
    dataDir: dir,
    clock,
    queueTimeoutMs: options.queueTimeoutMs ?? 1_000,
    turnTimeoutMs: options.turnTimeoutMs ?? 10_000,
    leaseMs: options.leaseMs ?? 500,
    retentionMs: options.retentionMs ?? 60_000,
    maxPendingPerInstance: options.maxPendingPerInstance,
    maxEventsPerTurn: options.maxEventsPerTurn,
    maxConnectionsPerInstance: options.maxConnectionsPerInstance,
    maxTerminalPerInstance: options.maxTerminalPerInstance,
    claimAckMs: options.claimAckMs,
    pickupMs: options.pickupMs,
    maxResends: options.maxResends,
  });
  return { dir, clock, hub };
}

const statusOf = (run: () => unknown): number => {
  try {
    run();
  } catch (error) {
    return error instanceof MuseRelayError ? error.status : -1;
  }
  return 0;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MuseRelayHub connections", () => {
  it("shows a connection once and never repeats its token", () => {
    const { dir, hub } = harness();
    const created = hub.createConnection("inst");
    expect(created.token).toMatch(/^mrt_/);
    expect(created.connectionId).toMatch(/^mrc_/);
    const view = hub.connectionViews("inst", true);
    expect(view.connections).toEqual([
      { connectionId: created.connectionId, createdAt: expect.any(String), lastSeenAt: null, online: false },
    ]);
    const raw = readFileSync(join(dir, "muse-relay.json"), "utf8");
    expect(raw).not.toContain(created.token);
    expect(raw).toContain(createHash("sha256").update(created.token).digest("hex"));
    expect(JSON.stringify(view)).not.toContain(created.token);
    expect(hub.authorize(created.connectionId, created.token)).toMatchObject({ ok: true });
    expect(hub.authorize(created.connectionId, "wrong")).toMatchObject({ ok: false, status: 401 });
  });

  it("rotates in place and refuses the old token at once", () => {
    const { hub } = harness();
    const first = hub.createConnection("inst");
    const rotated = hub.rotateConnection("inst", first.connectionId);
    expect(rotated.connectionId).toBe(first.connectionId);
    expect(rotated.token).not.toBe(first.token);
    expect(hub.authorize(first.connectionId, first.token)).toMatchObject({ ok: false, status: 401 });
    expect(hub.authorize(first.connectionId, rotated.token)).toMatchObject({ ok: true });
  });

  it("answers 403 for a removed connection and refuses another instance's connection", () => {
    const { hub } = harness();
    const one = hub.createConnection("inst-a");
    const two = hub.createConnection("inst-b");
    expect(statusOf(() => hub.rotateConnection("inst-b", one.connectionId))).toBe(403);
    expect(statusOf(() => hub.deleteConnection("inst-b", one.connectionId))).toBe(403);
    hub.deleteConnection("inst-a", one.connectionId);
    expect(hub.authorize(one.connectionId, one.token)).toMatchObject({ ok: false, status: 403 });
    expect(hub.authorize(two.connectionId, two.token)).toMatchObject({ ok: true });
  });

  it("counts a connection online only while its heartbeat is recent", async () => {
    const { clock, hub } = harness({ leaseMs: 500 });
    const created = hub.createConnection("inst");
    await hub.poll(created.connectionId, 0, 1);
    expect(hub.instanceOnline("inst")).toBe(true);
    expect(hub.connectionViews("inst", true).connections[0]!.online).toBe(true);
    clock.advance(150_001);
    expect(hub.instanceOnline("inst")).toBe(false);
  });
});

describe("MuseRelayHub turns", () => {
  it("delivers a queued turn once and refuses a stale delivery id", async () => {
    const { clock, hub } = harness({ leaseMs: 500 });
    const { connectionId } = hub.createConnection("inst");
    const queued = hub.queueTurn({
      instanceId: "inst",
      threadId: "thread-1",
      text: "hello",
      system: "system prompt",
      transcript: [{ role: "user", text: "earlier" }, { role: "assistant", text: "reply" }],
    });
    const first = await hub.poll(connectionId, 0, 1);
    expect(first.deliveries).toHaveLength(1);
    const delivery = first.deliveries[0]!;
    expect(delivery.turnId).toBe(queued.turnId);
    expect(delivery.attempt).toBe(1);
    expect(delivery.input).toEqual({
      threadId: "thread-1",
      text: "hello",
      system: "system prompt",
      transcript: [{ role: "user", text: "earlier" }, { role: "assistant", text: "reply" }],
    });
    expect((await hub.poll(connectionId, 0, 1)).deliveries).toHaveLength(0);

    clock.advance(501);
    const second = await hub.poll(connectionId, 0, 1);
    expect(second.deliveries).toHaveLength(1);
    expect(second.deliveries[0]!.deliveryId).not.toBe(delivery.deliveryId);
    expect(second.deliveries[0]!.attempt).toBe(2);

    expect(statusOf(() => hub.recordEvent(connectionId, queued.turnId, {
      deliveryId: delivery.deliveryId, eventId: "e1", seq: 1, type: "text", itemId: "i1", text: "hello",
    }))).toBe(409);
    expect(statusOf(() => hub.heartbeat(connectionId, queued.turnId, delivery.deliveryId))).toBe(409);
    expect(hub.heartbeat(connectionId, queued.turnId, second.deliveries[0]!.deliveryId)).toMatchObject({ ok: true, cancelled: false });
  });

  it("keeps event order, dedupes one eventId and rejects conflicting content", async () => {
    const { hub } = harness();
    const { connectionId } = hub.createConnection("inst");
    const { turnId } = hub.queueTurn({ instanceId: "inst", threadId: "t", text: "hi", transcript: [] });
    const delivery = (await hub.poll(connectionId, 0, 1)).deliveries[0]!;
    const event = (body: Record<string, unknown>) => hub.recordEvent(connectionId, turnId, {
      deliveryId: delivery.deliveryId, eventId: "e1", seq: 1, type: "delta", itemId: "i1", text: "hel", ...body,
    } as never);

    expect(event({})).toMatchObject({ accepted: true, duplicate: false, seq: 1 });
    expect(event({})).toMatchObject({ accepted: true, duplicate: true, seq: 1 });
    expect(statusOf(() => event({ text: "other" }))).toBe(409);
    expect(statusOf(() => event({ eventId: "e2", seq: 3 }))).toBe(409);

    hub.recordEvent(connectionId, turnId, { deliveryId: delivery.deliveryId, eventId: "e2", seq: 2, type: "delta", itemId: "i1", text: "lo" });
    expect(statusOf(() => hub.recordEvent(connectionId, turnId, {
      deliveryId: delivery.deliveryId, eventId: "e3", seq: 3, type: "text", itemId: "i1", text: "nope",
    }))).toBe(400);
    expect(hub.recordEvent(connectionId, turnId, {
      deliveryId: delivery.deliveryId, eventId: "e3", seq: 3, type: "text", itemId: "i1", text: "hello",
    })).toMatchObject({ accepted: true, duplicate: false });
    expect(statusOf(() => hub.recordEvent(connectionId, turnId, {
      deliveryId: delivery.deliveryId, eventId: "e4", seq: 4, type: "delta", itemId: "i1", text: "!",
    }))).toBe(409);
  });

  it("makes the first terminal event final and keeps its retry idempotent", async () => {
    const { hub } = harness();
    const { connectionId } = hub.createConnection("inst");
    const { turnId } = hub.queueTurn({ instanceId: "inst", threadId: "t", text: "hi", transcript: [] });
    const delivery = (await hub.poll(connectionId, 0, 1)).deliveries[0]!;
    const completed = { deliveryId: delivery.deliveryId, eventId: "done", seq: 1, type: "completed", stopReason: "end_turn" } as const;
    expect(hub.recordEvent(connectionId, turnId, completed)).toMatchObject({ accepted: true, duplicate: false });
    expect(hub.recordEvent(connectionId, turnId, completed)).toMatchObject({ accepted: true, duplicate: true });
    expect(statusOf(() => hub.recordEvent(connectionId, turnId, {
      deliveryId: delivery.deliveryId, eventId: "late", seq: 2, type: "text", itemId: "i", text: "late",
    }))).toBe(409);
    expect(hub.connectionViews("inst", true).pendingTurns).toBe(0);
  });

  it("cancels a queued turn repeatably and cancels a delivered one through heartbeat", async () => {
    const { hub } = harness();
    const { connectionId } = hub.createConnection("inst");
    const queued = hub.queueTurn({ instanceId: "inst", threadId: "t", text: "hi", transcript: [] });
    hub.cancelTurn(queued.turnId);
    expect((await hub.poll(connectionId, 0, 1)).cancellations).toEqual([queued.turnId]);
    expect((await hub.poll(connectionId, 0, 1)).cancellations).toEqual([queued.turnId]);

    const running = hub.queueTurn({ instanceId: "inst", threadId: "t2", text: "work", transcript: [] });
    const delivery = (await hub.poll(connectionId, 0, 1)).deliveries[0]!;
    hub.cancelTurn(running.turnId);
    expect(hub.heartbeat(connectionId, running.turnId, delivery.deliveryId)).toEqual({ ok: true, leaseUntil: null, cancelled: true });
    expect(statusOf(() => hub.recordEvent(connectionId, running.turnId, {
      deliveryId: delivery.deliveryId, eventId: "e", seq: 1, type: "text", itemId: "i", text: "late",
    }))).toBe(409);
  });

  it("fails a turn that is never picked up and one that runs too long", async () => {
    const { clock, hub } = harness({ queueTimeoutMs: 1_000, turnTimeoutMs: 5_000, leaseMs: 500 });
    const { connectionId } = hub.createConnection("inst");
    const events: MuseRelayHubEvent[] = [];
    hub.subscribe((event) => events.push(event));

    hub.queueTurn({ instanceId: "inst", threadId: "slow-pickup", text: "hi", transcript: [] });
    clock.advance(1_001);
    expect(events.find((event) => event.type === "turn.failed")).toMatchObject({ stopReason: "queue_timeout" });

    const running = hub.queueTurn({ instanceId: "inst", threadId: "slow-turn", text: "hi", transcript: [] });
    const delivery = (await hub.poll(connectionId, 0, 1)).deliveries[0]!;
    expect(delivery.turnId).toBe(running.turnId);
    clock.advance(5_001);
    expect(events.find((event) => event.type === "turn.failed" && event.turnId === running.turnId)).toMatchObject({ stopReason: "turn_timeout" });
  });

  it("wakes a long poll when a turn is queued", async () => {
    const { hub } = harness();
    const { connectionId } = hub.createConnection("inst");
    const polling = hub.poll(connectionId, 5_000, 1);
    await tick();
    const queued = hub.queueTurn({ instanceId: "inst", threadId: "t", text: "hi", transcript: [] });
    const result = await polling;
    expect(result.deliveries.map((delivery) => delivery.turnId)).toEqual([queued.turnId]);
  });

  it("isolates instances and lets another connection of one instance reclaim a lease", async () => {
    const { clock, hub } = harness({ leaseMs: 500 });
    const one = hub.createConnection("inst-a");
    const two = hub.createConnection("inst-b");
    const sameInstance = hub.createConnection("inst-a");
    const queued = hub.queueTurn({ instanceId: "inst-a", threadId: "t", text: "hi", transcript: [] });
    expect((await hub.poll(two.connectionId, 0, 1)).deliveries).toHaveLength(0);
    expect(statusOf(() => hub.recordEvent(two.connectionId, queued.turnId, {
      deliveryId: "x", eventId: "e", seq: 1, type: "text", itemId: "i", text: "x",
    }))).toBe(404);

    const first = (await hub.poll(one.connectionId, 0, 1)).deliveries[0]!;
    clock.advance(501);
    const reclaimed = (await hub.poll(sameInstance.connectionId, 0, 1)).deliveries[0]!;
    expect(reclaimed.turnId).toBe(queued.turnId);
    expect(reclaimed.deliveryId).not.toBe(first.deliveryId);
    expect(statusOf(() => hub.recordEvent(one.connectionId, queued.turnId, {
      deliveryId: first.deliveryId, eventId: "e", seq: 1, type: "text", itemId: "i", text: "x",
    }))).toBe(409);
  });

  it("marks unfinished turns server_restarted on a new hub and never replays them", async () => {
    const { dir, hub } = harness();
    const { connectionId, token } = hub.createConnection("inst");
    hub.queueTurn({ instanceId: "inst", threadId: "t", text: "hi", transcript: [] });
    hub.dispose();

    const next = new MuseRelayHub({ dataDir: dir });
    expect(next.authorize(connectionId, token)).toMatchObject({ ok: true });
    expect(next.connectionViews("inst", true).pendingTurns).toBe(0);
    expect((await next.poll(connectionId, 0, 1)).deliveries).toHaveLength(0);
  });

  it("fails closed on unreadable state and never overwrites it", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-muse-relay-bad-"));
    dirs.push(dir);
    const file = join(dir, "muse-relay.json");
    writeFileSync(file, "{not json", { mode: 0o600 });
    const hub = new MuseRelayHub({ dataDir: dir });
    expect(hub.unavailable).toBe(true);
    expect(statusOf(() => hub.createConnection("inst"))).toBe(503);
    expect(statusOf(() => hub.connectionViews("inst", true))).toBe(503);
    expect(hub.authorize("mrc_0000000000000000", "token")).toMatchObject({ ok: false, status: 503 });
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });

  it("enforces queue and event capacity", async () => {
    const { hub } = harness({ maxPendingPerInstance: 1, maxEventsPerTurn: 1 });
    const { connectionId } = hub.createConnection("inst");
    hub.queueTurn({ instanceId: "inst", threadId: "t", text: "one", transcript: [] });
    expect(statusOf(() => hub.queueTurn({ instanceId: "inst", threadId: "t", text: "two", transcript: [] }))).toBe(429);
    const delivery = (await hub.poll(connectionId, 0, 1)).deliveries[0]!;
    hub.recordEvent(connectionId, delivery.turnId, { deliveryId: delivery.deliveryId, eventId: "e1", seq: 1, type: "delta", itemId: "i", text: "a" });
    expect(statusOf(() => hub.recordEvent(connectionId, delivery.turnId, {
      deliveryId: delivery.deliveryId, eventId: "e2", seq: 2, type: "delta", itemId: "i", text: "b",
    }))).toBe(429);
  });

  it("prunes terminal turns after the retention window", async () => {
    const { clock, dir, hub } = harness({ retentionMs: 1_000 });
    const { connectionId } = hub.createConnection("inst");
    const { turnId } = hub.queueTurn({ instanceId: "inst", threadId: "t", text: "hi", transcript: [] });
    const delivery = (await hub.poll(connectionId, 0, 1)).deliveries[0]!;
    hub.recordEvent(connectionId, turnId, { deliveryId: delivery.deliveryId, eventId: "done", seq: 1, type: "completed" });
    clock.advance(1_001);
    hub.queueTurn({ instanceId: "inst", threadId: "t2", text: "next", transcript: [] });
    const raw = readFileSync(join(dir, "muse-relay.json"), "utf8");
    expect(raw).not.toContain(turnId);
  });
});

describe("MuseRelayHub input slices", () => {
  const bigInput = () => ({
    instanceId: "inst",
    threadId: "thread-big",
    text: "最新的问题 ✓ " + "q".repeat(500),
    system: "system ".repeat(1_200),
    transcript: Array.from({ length: 12 }, (_, index) => ({
      role: (index % 2 ? "assistant" : "user") as "user" | "assistant",
      text: `第 ${index} 条 ` + "t".repeat(600),
    })),
  });

  const reassemble = (hub: MuseRelayHub, connectionId: string, turnId: string, deliveryId: string, step: number) => {
    const parts: Buffer[] = [];
    let offset = 0;
    let total = -1;
    do {
      const slice = hub.inputSlice(connectionId, turnId, deliveryId, offset, step);
      expect(slice.offset).toBe(offset);
      expect(slice.data.byteLength).toBeLessThanOrEqual(step);
      total = slice.total;
      parts.push(slice.data);
      offset += slice.data.byteLength;
    } while (offset < total);
    return Buffer.concat(parts);
  };

  it("serves the delivery input in slices that match the ref's size and hash", async () => {
    const { hub } = harness({ leaseMs: 500 });
    const { connectionId } = hub.createConnection("inst");
    const { turnId } = hub.queueTurn(bigInput());
    const delivery = (await hub.poll(connectionId, 0, 1)).deliveries[0]!;
    const ref = museRelayDeliveryRef(delivery);
    expect(ref).not.toHaveProperty("input");
    expect(ref).toMatchObject({ turnId, deliveryId: delivery.deliveryId, attempt: 1 });
    expect(ref.inputBytes).toBeGreaterThan(10_000);
    const bytes = reassemble(hub, connectionId, turnId, delivery.deliveryId, MUSE_RELAY_INPUT_SLICE_MAX_BYTES);
    expect(bytes.byteLength).toBe(ref.inputBytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(ref.inputSha256);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(delivery.input);
    // Odd slice sizes split multi-byte characters; the bytes still join back to the same input.
    expect(reassemble(hub, connectionId, turnId, delivery.deliveryId, 1_001).equals(bytes)).toBe(true);
    // The hash survives a reload of the state file.
    expect(museRelayInputBytes(JSON.parse(JSON.stringify(delivery.input))).equals(bytes)).toBe(true);
    const end = hub.inputSlice(connectionId, turnId, delivery.deliveryId, ref.inputBytes, 10);
    expect(end).toMatchObject({ offset: ref.inputBytes, total: ref.inputBytes });
    expect(end.data.byteLength).toBe(0);
  });

  it("rejects an invalid slice request", async () => {
    const { hub } = harness();
    const { connectionId } = hub.createConnection("inst");
    const other = hub.createConnection("inst-b");
    const { turnId } = hub.queueTurn({ instanceId: "inst", threadId: "t", text: "hi", transcript: [] });
    const delivery = (await hub.poll(connectionId, 0, 1)).deliveries[0]!;
    expect(statusOf(() => hub.inputSlice(connectionId, turnId, delivery.deliveryId, 0, MUSE_RELAY_INPUT_SLICE_MAX_BYTES + 1))).toBe(400);
    expect(statusOf(() => hub.inputSlice(connectionId, turnId, delivery.deliveryId, 0, 0))).toBe(400);
    expect(statusOf(() => hub.inputSlice(connectionId, turnId, delivery.deliveryId, -1, 10))).toBe(400);
    expect(statusOf(() => hub.inputSlice(connectionId, turnId, delivery.deliveryId, 1_000_000, 10))).toBe(400);
    expect(statusOf(() => hub.inputSlice(other.connectionId, turnId, delivery.deliveryId, 0, 10))).toBe(404);
    expect(statusOf(() => hub.inputSlice("mrc_missing", turnId, delivery.deliveryId, 0, 10))).toBe(401);
  });

  it("answers 409 once the delivery is superseded, lapsed, finished or cancelled", async () => {
    const { clock, hub } = harness({ leaseMs: 500 });
    const { connectionId } = hub.createConnection("inst");
    const { turnId } = hub.queueTurn({ instanceId: "inst", threadId: "t", text: "hi", transcript: [] });
    const first = (await hub.poll(connectionId, 0, 1)).deliveries[0]!;
    expect(statusOf(() => hub.inputSlice(connectionId, turnId, "mrd_wrong", 0, 10))).toBe(409);
    clock.advance(501);
    expect(statusOf(() => hub.inputSlice(connectionId, turnId, first.deliveryId, 0, 10))).toBe(409);
    const second = (await hub.poll(connectionId, 0, 1)).deliveries[0]!;
    expect(statusOf(() => hub.inputSlice(connectionId, turnId, first.deliveryId, 0, 10))).toBe(409);
    expect(statusOf(() => hub.inputSlice(connectionId, turnId, second.deliveryId, 0, 10))).toBe(0);
    hub.recordEvent(connectionId, turnId, { deliveryId: second.deliveryId, eventId: "done", seq: 1, type: "completed" });
    expect(statusOf(() => hub.inputSlice(connectionId, turnId, second.deliveryId, 0, 10))).toBe(409);

    const cancelled = hub.queueTurn({ instanceId: "inst", threadId: "t2", text: "hi", transcript: [] });
    const delivery = (await hub.poll(connectionId, 0, 1)).deliveries[0]!;
    expect(delivery.turnId).toBe(cancelled.turnId);
    hub.cancelTurn(cancelled.turnId);
    expect(statusOf(() => hub.inputSlice(connectionId, cancelled.turnId, delivery.deliveryId, 0, 10))).toBe(409);
  });
});

describe("MuseRelayHub untouched ref claims (fix-1119)", () => {
  // A poll answer lost on Muse's egress proxy: the server claimed the turn, the client never saw it.
  const setup = (options: { maxResends?: number } = {}) => {
    const { clock, hub } = harness({ leaseMs: 10_000, claimAckMs: 1_000, pickupMs: 3_000, turnTimeoutMs: 60_000, queueTimeoutMs: 5_000, ...options });
    const { connectionId } = hub.createConnection("inst");
    const { turnId } = hub.queueTurn({ instanceId: "inst", threadId: "t", text: "hi", transcript: [] });
    const ref = (id = connectionId, wait = 0) => hub.poll(id, wait, 1, { refMode: true });
    return { clock, hub, connectionId, turnId, ref };
  };

  it("sends the same delivery again on the next poll, with its attempt and a renewed ack window", async () => {
    const { clock, connectionId, turnId, ref, hub } = setup();
    const first = (await ref()).deliveries[0]!;
    expect(first).toMatchObject({ turnId, attempt: 1 });
    expect(Date.parse(first.leaseUntil) - clock.now()).toBe(1_000);

    clock.advance(400);
    const again = (await ref()).deliveries;
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ turnId, deliveryId: first.deliveryId, attempt: 1 });
    expect(Date.parse(again[0]!.leaseUntil)).toBe(clock.now() + 1_000);

    // Past the first claim's window, but inside the renewed one: still the same delivery, not attempt 2.
    clock.advance(900);
    const third = (await ref()).deliveries[0]!;
    expect(third).toMatchObject({ deliveryId: first.deliveryId, attempt: 1 });

    // An inline poll never gets a resend (inline clients hold the input from the first answer).
    expect((await hub.poll(connectionId, 0, 1)).deliveries).toHaveLength(0);
    // A long poll returns the resend at once instead of waiting.
    const waited = await ref(connectionId, 5_000);
    expect(waited.deliveries[0]).toMatchObject({ deliveryId: first.deliveryId, attempt: 1 });
  });

  it("keeps the resent delivery fully usable: slices, heartbeat and events take the same deliveryId", async () => {
    const { connectionId, turnId, ref, hub } = setup();
    const first = (await ref()).deliveries[0]!;
    const again = (await ref()).deliveries[0]!;
    expect(again.deliveryId).toBe(first.deliveryId);
    const total = museRelayInputBytes(first.input).byteLength;
    const slice = hub.inputSlice(connectionId, turnId, again.deliveryId, 0, MUSE_RELAY_INPUT_SLICE_MAX_BYTES);
    expect(slice.total).toBe(total);
    expect(hub.heartbeat(connectionId, turnId, first.deliveryId)).toMatchObject({ ok: true, cancelled: false });
    expect(hub.recordEvent(connectionId, turnId, {
      deliveryId: first.deliveryId, eventId: "e1", seq: 1, type: "text", itemId: "i1", text: "hello",
    })).toMatchObject({ accepted: true, duplicate: false, seq: 1 });
    expect(hub.recordEvent(connectionId, turnId, { deliveryId: first.deliveryId, eventId: "done", seq: 2, type: "completed" }))
      .toMatchObject({ accepted: true, seq: 2 });
    expect((await ref()).deliveries).toHaveLength(0);
  });

  it("stops once a slice was fetched: the short lease then redelivers a new attempt", async () => {
    const { clock, connectionId, turnId, ref, hub } = setup();
    const first = (await ref()).deliveries[0]!;
    hub.inputSlice(connectionId, turnId, first.deliveryId, 0, 4);
    expect((await ref()).deliveries).toHaveLength(0);
    clock.advance(999);
    expect((await ref()).deliveries).toHaveLength(0);
    clock.advance(2);
    const next = (await ref()).deliveries[0]!;
    expect(next.attempt).toBe(2);
    expect(next.deliveryId).not.toBe(first.deliveryId);
  });

  it("stops once the worker answered (heartbeat or event) and keeps the full lease", async () => {
    const { clock, connectionId, turnId, ref, hub } = setup();
    const first = (await ref()).deliveries[0]!;
    hub.heartbeat(connectionId, turnId, first.deliveryId);
    expect((await ref()).deliveries).toHaveLength(0);
    clock.advance(9_000);
    expect((await ref()).deliveries).toHaveLength(0);

    const other = hub.queueTurn({ instanceId: "inst", threadId: "t2", text: "two", transcript: [] });
    const second = (await ref()).deliveries[0]!;
    expect(second.turnId).toBe(other.turnId);
    hub.recordEvent(connectionId, other.turnId, { deliveryId: second.deliveryId, eventId: "x1", seq: 1, type: "text", itemId: "i", text: "x" });
    expect((await ref()).deliveries).toHaveLength(0);
  });

  it("never sends it to another connection and gives up after maxResends, falling back to the lease", async () => {
    const { clock, turnId, ref, hub } = setup({ maxResends: 2 });
    const otherConnection = hub.createConnection("inst");
    const first = (await ref()).deliveries[0]!;
    expect((await ref(otherConnection.connectionId)).deliveries).toHaveLength(0);
    expect((await ref()).deliveries[0]!.deliveryId).toBe(first.deliveryId);
    expect((await ref()).deliveries[0]!.deliveryId).toBe(first.deliveryId);
    expect((await ref()).deliveries).toHaveLength(0);
    clock.advance(1_001);
    const next = (await ref()).deliveries[0]!;
    expect(next).toMatchObject({ turnId, attempt: 2 });
    // The new attempt is untouched again, so it may be resent in turn.
    expect((await ref()).deliveries[0]).toMatchObject({ deliveryId: next.deliveryId, attempt: 2 });
  });

  it("does nothing when resending is off, for a cancelled turn, or after the claim was released", async () => {
    const off = setup({ maxResends: 0 });
    expect((await off.ref()).deliveries).toHaveLength(1);
    expect((await off.ref()).deliveries).toHaveLength(0);

    const cancelled = setup();
    expect((await cancelled.ref()).deliveries).toHaveLength(1);
    cancelled.hub.cancelTurn(cancelled.turnId);
    const afterCancel = await cancelled.ref();
    expect(afterCancel.deliveries).toHaveLength(0);
    expect(afterCancel.cancellations).toEqual([cancelled.turnId]);

    const released = setup();
    const claim = (await released.ref()).deliveries[0]!;
    released.hub.releaseClaims(released.connectionId, [claim.deliveryId]);
    const redelivered = (await released.ref()).deliveries[0]!;
    expect(redelivered.attempt).toBe(2);
    expect(redelivered.deliveryId).not.toBe(claim.deliveryId);
  });

  it("counts a resend against the poll limit", async () => {
    const { connectionId, ref, hub } = setup();
    const first = (await ref()).deliveries[0]!;
    const queued = hub.queueTurn({ instanceId: "inst", threadId: "t2", text: "two", transcript: [] });
    const one = (await ref()).deliveries;
    expect(one.map((delivery) => delivery.deliveryId)).toEqual([first.deliveryId]);
    const both = (await hub.poll(connectionId, 0, 2, { refMode: true })).deliveries;
    expect(both.map((delivery) => delivery.turnId).sort()).toEqual([first.turnId, queued.turnId].sort());
    expect(both.find((delivery) => delivery.turnId === first.turnId)!.deliveryId).toBe(first.deliveryId);
  });
});
