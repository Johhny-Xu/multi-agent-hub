import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { MuseRelayHub } from "../muse-relay.ts";
import { BUILT_IN_DRIVERS } from "./builtIn.ts";
import { MuseRelayDriver, createMuseRelayDriver } from "./muse-relay.ts";

const dirs: string[] = [];
const hubs: MuseRelayHub[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "omb-muse-relay-driver-"));
  dirs.push(dir);
  const hub = new MuseRelayHub({ dataDir: dir });
  hubs.push(hub);
  const connection = hub.createConnection("inst");
  const driver = createMuseRelayDriver({ hub });
  const instance = await driver.create({
    instanceId: "inst",
    displayName: "Muse",
    environment: {},
    enabled: true,
    config: driver.defaultConfig(),
  });
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  return { dir, hub, connection, driver, instance, events };
}

const deliveryFor = async (hub: MuseRelayHub, connectionId: string) => (await hub.poll(connectionId, 0, 1)).deliveries[0]!;

describe("the Muse relay driver", () => {
  it("is registered as one custom model", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toContain("museRelay");
    expect(MuseRelayDriver.metadata.access).toBe("custom");
    expect(MuseRelayDriver.metadata.supportsMultipleInstances).toBe(true);
    expect(MuseRelayDriver.models).toEqual({
      default: "muse-personal-assistant",
      options: [{ id: "muse-personal-assistant", label: "Muse Personal Assistant", custom: true }],
    });
    expect(MuseRelayDriver.decodeConfig({})).toEqual({});
    expect(() => MuseRelayDriver.decodeConfig({ unexpected: true })).toThrow();
  });

  it("persists the turn before acknowledging it and emits its own turn start", async () => {
    const { dir, hub, instance, events } = await harness();
    const started = await instance.adapter.sendTurn({
      threadId: "thread-1",
      text: "hello",
      system: "be helpful",
      transcript: [{ role: "user", text: "earlier" }],
    });
    expect(started.turnId).toEqual(expect.any(String));
    expect(readFileSync(join(dir, "muse-relay.json"), "utf8")).toContain(started.turnId);
    expect(events.map((event) => event.type)).toEqual(["session.started", "turn.started"]);
    expect(events[0]).toMatchObject({ sessionId: null, model: "muse-personal-assistant" });
    expect(events.every((event) => event.turnId === started.turnId && event.threadId === "thread-1")).toBe(true);
    expect(hub.connectionViews("inst", true).pendingTurns).toBe(1);
    expect(instance.adapter.hasSession("thread-1")).toBe(false);
    expect(instance.adapter.capabilities).toEqual({ sessionModelSwitch: "unsupported" });
  });

  it("maps deltas, final text and completion into the original thread", async () => {
    const { hub, connection, instance, events } = await harness();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "thread-1", text: "hello", transcript: [] });
    const delivery = await deliveryFor(hub, connection.connectionId);
    hub.recordEvent(connection.connectionId, turnId, {
      deliveryId: delivery.deliveryId, eventId: "d1", seq: 1, type: "delta", itemId: "bubble", text: "hel",
    });
    hub.recordEvent(connection.connectionId, turnId, {
      deliveryId: delivery.deliveryId, eventId: "d2", seq: 2, type: "delta", itemId: "bubble", text: "lo",
    });
    hub.recordEvent(connection.connectionId, turnId, {
      deliveryId: delivery.deliveryId, eventId: "t1", seq: 3, type: "text", itemId: "bubble", text: "hello",
    });
    hub.recordEvent(connection.connectionId, turnId, {
      deliveryId: delivery.deliveryId, eventId: "done", seq: 4, type: "completed", stopReason: "end_turn",
    });

    // The worker's first event is its proof of life: one status line ("Muse") before the content (fix-1119).
    const [progress, ...mapped] = events.slice(2);
    expect(progress).toMatchObject({ type: "turn.progress", activity: "tool", tool: "Muse", itemId: `muse-relay:${turnId}:a1:worker` });
    expect(mapped.map((event) => event.type)).toEqual(["content.delta", "content.delta", "item.completed", "turn.completed"]);
    expect(mapped[0]).toMatchObject({ threadId: "thread-1", turnId, streamKind: "assistant_text", delta: "hel", itemId: "bubble" });
    expect(mapped[1]).toMatchObject({ delta: "lo" });
    expect(mapped[2]).toMatchObject({ itemType: "assistant_text", text: "hello", itemId: "bubble" });
    expect(mapped[3]).toMatchObject({ ok: true, stopReason: "end_turn" });
  });

  it("turns a failed event into an error and a failed completion", async () => {
    const { hub, connection, instance, events } = await harness();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "thread-1", text: "hello", transcript: [] });
    const delivery = await deliveryFor(hub, connection.connectionId);
    hub.recordEvent(connection.connectionId, turnId, {
      deliveryId: delivery.deliveryId, eventId: "failed", seq: 1, type: "failed", text: "the tool refused", stopReason: "error",
    });
    const [progress, ...mapped] = events.slice(2);
    expect(progress).toMatchObject({ type: "turn.progress", tool: "Muse" });
    expect(mapped.map((event) => event.type)).toEqual(["runtime.error", "turn.completed"]);
    expect(mapped[0]).toMatchObject({ message: "the tool refused", terminal: true });
    expect(mapped[1]).toMatchObject({ ok: false, stopReason: "error" });
  });

  it("shows receiving on the first slice and Muse once the worker answers, never for a resend (fix-1119)", async () => {
    const { hub, connection, instance, events } = await harness();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "thread-1", text: "hello", transcript: [] });
    const poll = () => hub.poll(connection.connectionId, 0, 1, { refMode: true });
    const delivery = (await poll()).deliveries[0]!;
    // A resend of the untouched claim (same delivery) shows nothing new.
    expect((await poll()).deliveries[0]!.deliveryId).toBe(delivery.deliveryId);
    expect(events.filter((event) => event.type === "turn.progress")).toHaveLength(0);
    hub.inputSlice(connection.connectionId, turnId, delivery.deliveryId, 0, 4);
    hub.heartbeat(connection.connectionId, turnId, delivery.deliveryId);
    hub.heartbeat(connection.connectionId, turnId, delivery.deliveryId);
    const progress = events.filter((event) => event.type === "turn.progress");
    expect(progress).toEqual([
      expect.objectContaining({ tool: "Muse · receiving", itemId: `muse-relay:${turnId}:a1:input` }),
      expect.objectContaining({ tool: "Muse", itemId: `muse-relay:${turnId}:a1:worker` }),
    ]);
  });

  it("never repeats an event the hub calls a duplicate", async () => {
    const { hub, connection, instance, events } = await harness();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "thread-1", text: "hello", transcript: [] });
    const delivery = await deliveryFor(hub, connection.connectionId);
    const body = { deliveryId: delivery.deliveryId, eventId: "d1", seq: 1, type: "delta" as const, itemId: "bubble", text: "hel" };
    hub.recordEvent(connection.connectionId, turnId, body);
    hub.recordEvent(connection.connectionId, turnId, body);
    expect(events.filter((event) => event.type === "content.delta")).toHaveLength(1);
  });

  it("ends a turn at once on interrupt and ignores a late result", async () => {
    const { hub, connection, instance, events } = await harness();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "thread-1", text: "hello", transcript: [] });
    const delivery = await deliveryFor(hub, connection.connectionId);
    await instance.adapter.interruptTurn("thread-1");
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "interrupted" });
    expect(hub.heartbeat(connection.connectionId, turnId, delivery.deliveryId)).toMatchObject({ cancelled: true });
    expect(() => hub.recordEvent(connection.connectionId, turnId, {
      deliveryId: delivery.deliveryId, eventId: "late", seq: 1, type: "text", itemId: "i", text: "late",
    })).toThrow();
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "item.completed")).toHaveLength(0);
  });

  it("shows offline until a heartbeat and online after one", async () => {
    const { hub, connection, instance } = await harness();
    expect(await instance.snapshot()).toMatchObject({
      state: "available",
      authenticated: true,
      warning: { title: "Muse is offline" },
    });
    await hub.poll(connection.connectionId, 0, 1);
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
    expect((await instance.snapshot()).warning).toBeUndefined();
  });

  it("drops its listener on dispose", async () => {
    const { hub, connection, instance, events } = await harness();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "thread-1", text: "hello", transcript: [] });
    const delivery = await deliveryFor(hub, connection.connectionId);
    await instance.dispose();
    const before = events.length;
    hub.recordEvent(connection.connectionId, turnId, {
      deliveryId: delivery.deliveryId, eventId: "d1", seq: 1, type: "delta", itemId: "bubble", text: "hi",
    });
    expect(events).toHaveLength(before);
  });

  it("refuses a second turn on one thread", async () => {
    const { instance } = await harness();
    await instance.adapter.sendTurn({ threadId: "thread-1", text: "one", transcript: [] });
    await expect(instance.adapter.sendTurn({ threadId: "thread-1", text: "two", transcript: [] }))
      .rejects.toThrow("a turn is already running on this thread");
  });
});
