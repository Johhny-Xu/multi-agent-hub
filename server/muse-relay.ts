// The durable outbox between a bot's turn and a Muse personal assistant that
// polls for work from its own authorized runtime. The hub owns connections,
// turn state, leases, cancellation and event idempotency; drivers and routes
// only translate between it and the rest of OpenMausBot.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

export const MUSE_RELAY_SCHEMA_VERSION = 1;
export const MUSE_RELAY_BASE_PREFIX = "/hooks/muse-relay/v1";
export const MUSE_RELAY_MODEL = "muse-personal-assistant";

export const MUSE_RELAY_QUEUE_TIMEOUT_MS = 120_000;
export const MUSE_RELAY_TURN_TIMEOUT_MS = 30 * 60_000;
export const MUSE_RELAY_LEASE_MS = 120_000;
/**
 * Leases for a ref-mode delivery before its worker answers. A claim lives MUSE_RELAY_CLAIM_ACK_MS, and each /input
 * slice renews that short window (the fetch is moving), so a poll answer lost between Cloudflare and Muse's egress
 * proxy or a fetch that dies half way costs ~20 s instead of the whole lease. The last slice opens the pickup window
 * (wake → worker claim → first heartbeat). Only a heartbeat or an event, which come from the worker, earns the full
 * lease. OMB_MUSE_RELAY_ACK_MS / OMB_MUSE_RELAY_PICKUP_MS override them; ACK 0 turns this off (full lease at claim).
 */
export const MUSE_RELAY_CLAIM_ACK_MS = 20_000;
export const MUSE_RELAY_PICKUP_MS = 60_000;
/**
 * A ref-mode claim nobody has touched yet (no /input slice, heartbeat or event) most likely never reached Muse: about
 * one poll answer in four dies on Muse's egress proxy. The next poll from the same connection then gets that same
 * delivery again (same deliveryId and attempt, short lease renewed) instead of an empty answer, so a lost answer costs
 * one poll interval, not the short lease. At most this many times in a row; after that the short lease lapses and the
 * turn is redelivered as a new attempt. OMB_MUSE_RELAY_MAX_RESENDS overrides it; 0 turns resending off.
 */
export const MUSE_RELAY_MAX_RESENDS = 5;
/** lastSeenAt only feeds the "online" badge (150 s window): persisting it on every poll rewrote the whole state file. */
const TOUCH_SAVE_MS = 30_000;
export const MUSE_RELAY_ONLINE_WINDOW_MS = 150_000;
export const MUSE_RELAY_MAX_PENDING_PER_INSTANCE = 100;
export const MUSE_RELAY_MAX_EVENTS_PER_TURN = 5_000;
export const MUSE_RELAY_MAX_WAITERS_PER_CONNECTION = 8;
export const MUSE_RELAY_MAX_CONNECTIONS_PER_INSTANCE = 10;
export const MUSE_RELAY_MAX_TERMINAL_PER_INSTANCE = 500;
export const MUSE_RELAY_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const MUSE_RELAY_MAX_TEXT_BYTES = 256 * 1024;
export const MUSE_RELAY_MAX_EVENT_BODY_BYTES = 1024 * 1024;
export const MUSE_RELAY_MAX_TURN_TEXT_BYTES = 1024 * 1024;
export const MUSE_RELAY_MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
/** Largest raw slice of a delivery's input one /input call returns (base64 keeps the response under 6 KB). */
export const MUSE_RELAY_INPUT_SLICE_MAX_BYTES = 4096;
const INPUT_CACHE_ENTRIES = 8;

const CONNECTION_PREFIX = "mrc_";
const TOKEN_PREFIX = "mrt_";
const CANCEL_NOTICE_MS = 10 * 60_000;
const DUMMY_HASH = createHash("sha256").update("muse-relay-dummy-token").digest("hex");

export interface MuseRelayClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: MuseRelayClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface MuseRelayTranscriptMessage {
  role: "user" | "assistant";
  text: string;
}

export interface MuseRelayTurnInput {
  threadId: string;
  text: string;
  system?: string;
  transcript: MuseRelayTranscriptMessage[];
}

export interface MuseRelayDelivery {
  turnId: string;
  deliveryId: string;
  attempt: number;
  leaseUntil: string;
  createdAt: string;
  input: MuseRelayTurnInput;
}

/** A delivery whose input is fetched in slices from /turns/<turnId>/input (poll inputMode "ref"). */
export interface MuseRelayDeliveryRef {
  turnId: string;
  deliveryId: string;
  attempt: number;
  leaseUntil: string;
  createdAt: string;
  /** Byte length of the UTF-8 JSON of input, as museRelayInputBytes serializes it. */
  inputBytes: number;
  /** Hex SHA-256 of those bytes. */
  inputSha256: string;
}

export interface MuseRelayInputSlice {
  offset: number;
  total: number;
  data: Buffer;
}

export interface MuseRelayPollOptions {
  /** Aborted when the client's connection closes: a poll that is gone must not claim anything. */
  signal?: AbortSignal;
  /** The client fetches input in slices (inputMode "ref"), so a claim can start on the short acknowledgement lease. */
  refMode?: boolean;
}

export interface MuseRelayPollResult {
  deliveries: MuseRelayDelivery[];
  cancellations: string[];
  serverTime: string;
}

export interface MuseRelayHeartbeatResult {
  ok: true;
  leaseUntil: string | null;
  cancelled: boolean;
}

export interface MuseRelayEventInput {
  deliveryId: string;
  eventId: string;
  seq: number;
  type: "delta" | "text" | "completed" | "failed";
  itemId?: string;
  text?: string;
  stopReason?: string;
}

export interface MuseRelayEventResult {
  accepted: true;
  duplicate: boolean;
  eventId: string;
  seq: number;
}

export interface MuseRelayFileInput {
  deliveryId: string;
  eventId: string;
  seq: number;
  kind: "image" | "file";
  path: string;
  mime: string;
  name?: string;
  bytes: number;
  hash: string;
}

export interface MuseRelayFileResult {
  accepted: true;
  duplicate: boolean;
  eventId: string;
  seq: number;
}

export interface MuseRelayConnectionView {
  connectionId: string;
  createdAt: string;
  lastSeenAt: string | null;
  online: boolean;
}

export interface MuseRelayConfigView {
  connections: MuseRelayConnectionView[];
  pendingTurns: number;
  canManage: boolean;
}

export type MuseRelayHubEvent =
  | {
      type: "turn.event";
      instanceId: string;
      threadId: string;
      turnId: string;
      event: {
        eventId: string;
        seq: number;
        type: "delta" | "text" | "completed" | "failed";
        itemId?: string;
        text?: string;
        stopReason?: string;
      };
    }
  | {
      type: "turn.file";
      instanceId: string;
      threadId: string;
      turnId: string;
      file: { eventId: string; seq: number; kind: "image" | "file"; path: string; mime: string; name?: string };
    }
  | { type: "turn.failed"; instanceId: string; threadId: string; turnId: string; stopReason: string; message: string }
  | { type: "turn.cancelled"; instanceId: string; threadId: string; turnId: string }
  /** The Muse client is fetching this delivery's input (via "input") or its worker holds it (heartbeat, event). */
  | { type: "turn.claimed"; instanceId: string; threadId: string; turnId: string; attempt: number; via: "input" | "heartbeat" | "event" };

export class MuseRelayError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "MuseRelayError";
    this.status = status;
  }
}

const transcriptSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});

const turnInputSchema = z.object({
  threadId: z.string().min(1).max(200),
  text: z.string(),
  system: z.string().optional(),
  transcript: z.array(transcriptSchema).max(1_000),
});

const eventRecordSchema = z.object({
  seq: z.number().int().positive(),
  type: z.enum(["delta", "text", "completed", "failed", "file"]),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});

const storedItemSchema = z.object({
  delta: z.string(),
  text: z.string().optional(),
});

const storedFileSchema = z.object({
  seq: z.number().int().positive(),
  eventId: z.string().min(1),
  kind: z.enum(["image", "file"]),
  path: z.string().min(1),
  mime: z.string().min(1),
  name: z.string().optional(),
  bytes: z.number().int().nonnegative(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});

const storedTurnSchema = z.object({
  turnId: z.string().min(1),
  instanceId: z.string().min(1),
  connectionId: z.string().min(1).optional(),
  threadId: z.string().min(1),
  input: turnInputSchema,
  createdAt: z.number().finite(),
  state: z.enum(["queued", "delivered", "completed", "failed", "cancelled"]),
  attempt: z.number().int().nonnegative(),
  deliveryId: z.string().min(1).optional(),
  leaseUntil: z.number().finite().optional(),
  /** When the client confirmed the current delivery; absent while a fresh claim is unconfirmed. */
  ackedAt: z.number().finite().optional(),
  deadlineAt: z.number().finite(),
  lastSeq: z.number().int().nonnegative(),
  events: z.record(z.string(), eventRecordSchema),
  items: z.record(z.string(), storedItemSchema),
  files: z.record(z.string(), storedFileSchema),
  stopReason: z.string().optional(),
  terminalAt: z.number().finite().optional(),
  cancelNoticeUntil: z.number().finite().optional(),
});

const connectionSchema = z.object({
  connectionId: z.string().min(1),
  instanceId: z.string().min(1),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().finite(),
  lastSeenAt: z.number().finite().optional(),
});

const revokedConnectionSchema = z.object({
  connectionId: z.string().min(1),
  instanceId: z.string().min(1),
  revokedAt: z.number().finite(),
});

const storedStateSchema = z.object({
  schemaVersion: z.literal(MUSE_RELAY_SCHEMA_VERSION),
  connections: z.array(connectionSchema),
  revoked: z.array(revokedConnectionSchema).default([]),
  turns: z.array(storedTurnSchema),
});

type StoredConnection = z.output<typeof connectionSchema>;
type StoredTurn = z.output<typeof storedTurnSchema>;
type StoredEventRecord = z.output<typeof eventRecordSchema>;
type StoredState = z.output<typeof storedStateSchema>;
type AuthorizeResult =
  | { ok: true; connection: StoredConnection }
  | { ok: false; status: 401 | 403 | 503 };

interface Waiter {
  connectionId: string;
  resolve: () => void;
  timer: unknown;
}

export interface MuseRelayHubOptions {
  dataDir: string;
  file?: string;
  clock?: MuseRelayClock;
  queueTimeoutMs?: number;
  turnTimeoutMs?: number;
  leaseMs?: number;
  claimAckMs?: number;
  pickupMs?: number;
  maxResends?: number;
  onlineWindowMs?: number;
  retentionMs?: number;
  maxPendingPerInstance?: number;
  maxEventsPerTurn?: number;
  maxWaitersPerConnection?: number;
  maxConnectionsPerInstance?: number;
  maxTerminalPerInstance?: number;
}

const isTerminal = (turn: StoredTurn) => turn.state === "completed" || turn.state === "failed" || turn.state === "cancelled";
const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeText(value: string | undefined): string | null {
  return value === undefined ? null : value.replace(/\r\n/g, "\n");
}

function eventHash(type: string, itemId: string | undefined, text: string | undefined, stopReason: string | undefined): string {
  return sha256(JSON.stringify([type, itemId ?? null, normalizeText(text), stopReason ?? null]));
}

/**
 * The one serialization of a turn's input that /input slices and inputSha256 are taken from. Keys are written in a
 * fixed order so a turn loaded back from disk serializes to the same bytes.
 */
export function museRelayInputBytes(input: MuseRelayTurnInput): Buffer {
  const canonical = {
    threadId: input.threadId,
    text: input.text,
    ...(input.system !== undefined ? { system: input.system } : {}),
    transcript: input.transcript.map((message) => ({ role: message.role, text: message.text })),
  };
  return Buffer.from(JSON.stringify(canonical), "utf8");
}

/** The poll form of a delivery that leaves input out and names its size and hash instead. */
export function museRelayDeliveryRef(delivery: MuseRelayDelivery): MuseRelayDeliveryRef {
  const bytes = museRelayInputBytes(delivery.input);
  return {
    turnId: delivery.turnId,
    deliveryId: delivery.deliveryId,
    attempt: delivery.attempt,
    leaseUntil: delivery.leaseUntil,
    createdAt: delivery.createdAt,
    inputBytes: bytes.byteLength,
    inputSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function safeIdentifier(value: string, what: string): string {
  if (!/^[\w.:-]{1,200}$/.test(value)) throw new MuseRelayError(400, `${what} is invalid`);
  return value;
}

function newConnectionId(): string {
  return `${CONNECTION_PREFIX}${randomBytes(8).toString("hex")}`;
}

function newToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** A UUID derived from the turn and event, so a retried upload lands on the same attachment. */
export function museRelayUploadId(turnId: string, eventId: string): string {
  const bytes = createHash("sha256").update(`${turnId}\0${eventId}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export class MuseRelayHub {
  private readonly file: string;
  private readonly clock: MuseRelayClock;
  private readonly queueTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly leaseMs: number;
  private readonly claimAckMs: number;
  private readonly pickupMs: number;
  private readonly maxResends: number;
  /** Ref-mode claims nobody has touched yet, by turnId: who claimed them and how often they were sent again. */
  private readonly untouched = new Map<string, { deliveryId: string; connectionId: string; resends: number }>();
  private readonly lastSaved = new Map<string, number>();
  /** Cancellations each connection has already been told about: an old notice must not end every long poll for 10 min. */
  private readonly toldCancelled = new Map<string, Set<string>>();
  private readonly onlineWindowMs: number;
  private readonly retentionMs: number;
  private readonly maxPendingPerInstance: number;
  private readonly maxEventsPerTurn: number;
  private readonly maxWaitersPerConnection: number;
  private readonly maxConnectionsPerInstance: number;
  private readonly maxTerminalPerInstance: number;

  private connections: StoredConnection[] = [];
  private revoked: z.output<typeof revokedConnectionSchema>[] = [];
  private turns: StoredTurn[] = [];
  private unreadable = false;
  private readonly listeners = new Set<(event: MuseRelayHubEvent) => void>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly turnTimers = new Map<string, unknown>();
  private readonly inputCache = new Map<string, Buffer>();
  private disposed = false;

  constructor(options: MuseRelayHubOptions) {
    this.file = options.file ?? join(options.dataDir, "muse-relay.json");
    this.clock = options.clock ?? systemClock;
    this.queueTimeoutMs = options.queueTimeoutMs ?? MUSE_RELAY_QUEUE_TIMEOUT_MS;
    this.turnTimeoutMs = options.turnTimeoutMs ?? MUSE_RELAY_TURN_TIMEOUT_MS;
    this.leaseMs = options.leaseMs ?? MUSE_RELAY_LEASE_MS;
    this.claimAckMs = options.claimAckMs ?? envMs("OMB_MUSE_RELAY_ACK_MS", MUSE_RELAY_CLAIM_ACK_MS);
    this.pickupMs = options.pickupMs ?? envMs("OMB_MUSE_RELAY_PICKUP_MS", MUSE_RELAY_PICKUP_MS);
    this.maxResends = Math.floor(options.maxResends ?? envMs("OMB_MUSE_RELAY_MAX_RESENDS", MUSE_RELAY_MAX_RESENDS));
    this.onlineWindowMs = options.onlineWindowMs ?? MUSE_RELAY_ONLINE_WINDOW_MS;
    this.retentionMs = options.retentionMs ?? MUSE_RELAY_RETENTION_MS;
    this.maxPendingPerInstance = options.maxPendingPerInstance ?? MUSE_RELAY_MAX_PENDING_PER_INSTANCE;
    this.maxEventsPerTurn = options.maxEventsPerTurn ?? MUSE_RELAY_MAX_EVENTS_PER_TURN;
    this.maxWaitersPerConnection = options.maxWaitersPerConnection ?? MUSE_RELAY_MAX_WAITERS_PER_CONNECTION;
    this.maxConnectionsPerInstance = options.maxConnectionsPerInstance ?? MUSE_RELAY_MAX_CONNECTIONS_PER_INSTANCE;
    this.maxTerminalPerInstance = options.maxTerminalPerInstance ?? MUSE_RELAY_MAX_TERMINAL_PER_INSTANCE;
    this.load();
  }

  get unavailable(): boolean {
    return this.unreadable;
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.unreadable = true;
      console.error(`muse relay: cannot read ${this.file}; refusing changes`);
      return;
    }
    try {
      const parsed = storedStateSchema.parse(JSON.parse(raw));
      this.connections = parsed.connections;
      this.revoked = parsed.revoked;
      this.turns = parsed.turns;
    } catch {
      this.unreadable = true;
      console.error(`muse relay: invalid state in ${this.file}; refusing changes`);
      return;
    }
    let changed = false;
    for (const turn of this.turns) {
      if (isTerminal(turn)) continue;
      turn.state = "failed";
      turn.stopReason = "server_restarted";
      turn.terminalAt = this.clock.now();
      delete turn.deliveryId;
      delete turn.leaseUntil;
      changed = true;
    }
    if (this.prune()) changed = true;
    if (changed) {
      try {
        this.save();
      } catch {
        console.error("muse relay: could not record turns interrupted by the previous stop");
      }
    }
  }

  private assertReadable(): void {
    if (this.unreadable) throw new MuseRelayError(503, "The Muse relay state could not be read");
  }

  private save(): void {
    if (this.unreadable) return;
    const state: StoredState = {
      schemaVersion: MUSE_RELAY_SCHEMA_VERSION,
      connections: this.connections,
      revoked: this.revoked,
      turns: this.turns,
    };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(state, null, 2), { mode: 0o600 });
  }

  /** Drops expired terminal turns and old revocation records; true when anything was removed. */
  private prune(): boolean {
    const now = this.clock.now();
    let changed = false;
    const kept: StoredTurn[] = [];
    for (const turn of this.turns) {
      if (isTerminal(turn) && now - (turn.terminalAt ?? turn.createdAt) > this.retentionMs) {
        changed = true;
        continue;
      }
      kept.push(turn);
    }
    this.turns = kept;
    for (const instanceId of new Set(this.turns.map((turn) => turn.instanceId))) {
      const terminal = this.turns
        .filter((turn) => turn.instanceId === instanceId && isTerminal(turn))
        .sort((a, b) => (a.terminalAt ?? a.createdAt) - (b.terminalAt ?? b.createdAt));
      const excess = terminal.length - this.maxTerminalPerInstance;
      if (excess <= 0) continue;
      const gone = new Set(terminal.slice(0, excess).map((turn) => turn.turnId));
      this.turns = this.turns.filter((turn) => !gone.has(turn.turnId));
      changed = true;
    }
    const revoked = this.revoked.filter((entry) => now - entry.revokedAt <= this.retentionMs);
    if (revoked.length !== this.revoked.length) {
      this.revoked = revoked;
      changed = true;
    }
    return changed;
  }

  private connection(connectionId: string): StoredConnection | undefined {
    return this.connections.find((candidate) => candidate.connectionId === connectionId);
  }

  private turn(turnId: string): StoredTurn | undefined {
    return this.turns.find((candidate) => candidate.turnId === turnId);
  }

  private instanceTurns(instanceId: string): StoredTurn[] {
    return this.turns.filter((turn) => turn.instanceId === instanceId);
  }

  private pendingCount(instanceId: string): number {
    return this.instanceTurns(instanceId).filter((turn) => !isTerminal(turn)).length;
  }

  private online(connection: StoredConnection): boolean {
    return connection.lastSeenAt !== undefined && this.clock.now() - connection.lastSeenAt <= this.onlineWindowMs;
  }

  private touch(connection: StoredConnection): void {
    const now = this.clock.now();
    connection.lastSeenAt = now;
    if (now - (this.lastSaved.get(connection.connectionId) ?? 0) < TOUCH_SAVE_MS) return;
    this.lastSaved.set(connection.connectionId, now);
    this.save();
  }

  /** The worker (heartbeat or event) holds the current delivery: the full lease, and the driver hears it once. */
  private acknowledge(turn: StoredTurn, via: "heartbeat" | "event"): void {
    const now = this.clock.now();
    this.untouched.delete(turn.turnId);
    turn.leaseUntil = Math.min(now + this.leaseMs, turn.deadlineAt);
    if (turn.ackedAt !== undefined) return;
    turn.ackedAt = now;
    console.log(`[muse-relay] ack turn=${shortId(turn.turnId)} attempt=${turn.attempt} via=${via} after=${now - turn.createdAt}ms`);
    this.notify({ type: "turn.claimed", instanceId: turn.instanceId, threadId: turn.threadId, turnId: turn.turnId, attempt: turn.attempt, via });
  }

  private notify(event: MuseRelayHubEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("muse relay: a listener failed", error);
      }
    }
  }

  subscribe(listener: (event: MuseRelayHubEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- connections -------------------------------------------------------

  createConnection(instanceId: string): { connectionId: string; token: string } {
    this.assertReadable();
    if (this.connections.filter((connection) => connection.instanceId === instanceId).length >= this.maxConnectionsPerInstance) {
      throw new MuseRelayError(409, "This instance has too many Muse connections");
    }
    const connectionId = newConnectionId();
    const token = newToken();
    this.connections.push({
      connectionId,
      instanceId,
      tokenHash: sha256(token),
      createdAt: this.clock.now(),
    });
    this.save();
    return { connectionId, token };
  }

  rotateConnection(instanceId: string, connectionId: string): { connectionId: string; token: string } {
    this.assertReadable();
    const connection = this.connection(connectionId);
    if (!connection) {
      if (this.revoked.some((entry) => entry.connectionId === connectionId)) throw new MuseRelayError(403, "This connection was removed");
      throw new MuseRelayError(404, "No such connection");
    }
    if (connection.instanceId !== instanceId) throw new MuseRelayError(403, "This connection belongs to another instance");
    const token = newToken();
    connection.tokenHash = sha256(token);
    this.save();
    this.wake(connectionId);
    return { connectionId, token };
  }

  deleteConnection(instanceId: string, connectionId: string): boolean {
    this.assertReadable();
    const index = this.connections.findIndex((connection) => connection.connectionId === connectionId);
    if (index === -1) {
      if (this.revoked.some((entry) => entry.connectionId === connectionId)) throw new MuseRelayError(403, "This connection was removed");
      throw new MuseRelayError(404, "No such connection");
    }
    const [connection] = this.connections.splice(index, 1);
    if (connection!.instanceId !== instanceId) {
      this.connections.splice(index, 0, connection!);
      throw new MuseRelayError(403, "This connection belongs to another instance");
    }
    this.revoked.push({ connectionId, instanceId, revokedAt: this.clock.now() });
    this.save();
    this.wake(connectionId);
    return true;
  }

  authorize(connectionId: string, token: string): AuthorizeResult {
    if (this.unreadable) return { ok: false, status: 503 };
    const connection = this.connection(connectionId);
    const actual = Buffer.from(sha256(token || ""), "hex");
    const expected = Buffer.from(connection?.tokenHash ?? DUMMY_HASH, "hex");
    const matches = actual.length === expected.length && timingSafeEqual(actual, expected);
    if (!connection) {
      if (this.revoked.some((entry) => entry.connectionId === connectionId)) return { ok: false, status: 403 };
      return { ok: false, status: 401 };
    }
    return matches ? { ok: true, connection } : { ok: false, status: 401 };
  }

  connectionViews(instanceId: string, canManage: boolean): MuseRelayConfigView {
    this.assertReadable();
    return {
      connections: this.connections
        .filter((connection) => connection.instanceId === instanceId)
        .map((connection) => ({
          connectionId: connection.connectionId,
          createdAt: new Date(connection.createdAt).toISOString(),
          lastSeenAt: iso(connection.lastSeenAt),
          online: this.online(connection),
        })),
      pendingTurns: this.pendingCount(instanceId),
      canManage,
    };
  }

  instanceOnline(instanceId: string): boolean {
    return this.connections.some((connection) => connection.instanceId === instanceId && this.online(connection));
  }

  // ---- turns -------------------------------------------------------------

  queueTurn(input: { instanceId: string; threadId: string; text: string; system?: string; transcript: MuseRelayTranscriptMessage[] }): {
    turnId: string;
    createdAt: number;
  } {
    this.assertReadable();
    if (this.pendingCount(input.instanceId) >= this.maxPendingPerInstance) {
      throw new MuseRelayError(429, "The Muse relay queue is full");
    }
    if (byteLength(input.text) > MUSE_RELAY_MAX_TURN_TEXT_BYTES) throw new MuseRelayError(413, "The message is too large");
    if (input.system !== undefined && byteLength(input.system) > MUSE_RELAY_MAX_TURN_TEXT_BYTES) {
      throw new MuseRelayError(413, "The system prompt is too large");
    }
    let transcriptBytes = 0;
    for (const message of input.transcript) {
      transcriptBytes += byteLength(message.text);
      if (transcriptBytes > MUSE_RELAY_MAX_TRANSCRIPT_BYTES) throw new MuseRelayError(413, "The transcript is too large");
    }
    const now = this.clock.now();
    const turn: StoredTurn = {
      turnId: randomUUID(),
      instanceId: input.instanceId,
      threadId: input.threadId,
      input: {
        threadId: input.threadId,
        text: input.text,
        ...(input.system ? { system: input.system } : {}),
        transcript: input.transcript,
      },
      createdAt: now,
      state: "queued",
      attempt: 0,
      deadlineAt: now + this.turnTimeoutMs,
      lastSeq: 0,
      events: {},
      items: {},
      files: {},
    };
    this.turns.push(turn);
    this.prune();
    this.schedule(turn);
    this.save();
    this.wakeInstance(input.instanceId);
    return { turnId: turn.turnId, createdAt: turn.createdAt };
  }

  private schedule(turn: StoredTurn): void {
    this.clearTimer(turn.turnId);
    if (isTerminal(turn)) return;
    const due = turn.attempt === 0
      ? Math.min(turn.createdAt + this.queueTimeoutMs, turn.deadlineAt)
      : turn.deadlineAt;
    const delay = Math.max(0, due - this.clock.now());
    const handle = this.clock.setTimeout(() => {
      this.turnTimers.delete(turn.turnId);
      this.expireTurn(turn.turnId);
    }, delay);
    this.turnTimers.set(turn.turnId, handle);
  }

  private clearTimer(turnId: string): void {
    const handle = this.turnTimers.get(turnId);
    if (handle === undefined) return;
    this.clock.clearTimeout(handle);
    this.turnTimers.delete(turnId);
  }

  private failTurn(turn: StoredTurn, stopReason: string, message: string): void {
    if (isTerminal(turn)) return;
    console.log(`[muse-relay] fail turn=${shortId(turn.turnId)} attempt=${turn.attempt} reason=${stopReason} acked=${turn.ackedAt !== undefined ? "yes" : "no"}`);
    turn.state = "failed";
    turn.stopReason = stopReason;
    turn.terminalAt = this.clock.now();
    this.untouched.delete(turn.turnId);
    delete turn.deliveryId;
    delete turn.leaseUntil;
    this.clearTimer(turn.turnId);
    this.save();
    this.notify({ type: "turn.failed", instanceId: turn.instanceId, threadId: turn.threadId, turnId: turn.turnId, stopReason, message });
  }

  private expireTurn(turnId: string): void {
    const turn = this.turn(turnId);
    if (!turn || isTerminal(turn)) return;
    const now = this.clock.now();
    if (now >= turn.deadlineAt) {
      this.failTurn(turn, "turn_timeout", "Muse did not finish this turn in time.");
      return;
    }
    if (turn.attempt === 0 && now >= turn.createdAt + this.queueTimeoutMs) {
      this.failTurn(turn, "queue_timeout", "Muse did not pick up this message in time.");
      return;
    }
    this.schedule(turn);
  }

  /** Fails turns whose deadline has passed even when their timer was delayed. */
  expireDue(): void {
    for (const turn of this.turns) {
      if (isTerminal(turn)) continue;
      const now = this.clock.now();
      if (now >= turn.deadlineAt) this.failTurn(turn, "turn_timeout", "Muse did not finish this turn in time.");
      else if (turn.attempt === 0 && now >= turn.createdAt + this.queueTimeoutMs) {
        this.failTurn(turn, "queue_timeout", "Muse did not pick up this message in time.");
      }
    }
  }

  async poll(connectionId: string, waitMs: number, limit: number, options: MuseRelayPollOptions = {}): Promise<MuseRelayPollResult> {
    this.assertReadable();
    const connection = this.connection(connectionId);
    if (!connection) throw new MuseRelayError(401, "Invalid connection token");
    this.touch(connection);
    const deadline = this.clock.now() + waitMs;
    for (;;) {
      this.expireDue();
      // A client that hung up mid-wait would get a claim written to a dead socket, hiding the turn for a whole lease.
      if (options.signal?.aborted) return { deliveries: [], cancellations: [], serverTime: new Date(this.clock.now()).toISOString() };
      const result = this.collect(connection, limit, options.refMode === true);
      const told = this.toldCancelled.get(connectionId) ?? new Set<string>();
      const fresh = result.cancellations.some((turnId) => !told.has(turnId));
      if (result.deliveries.length || fresh) {
        this.toldCancelled.set(connectionId, new Set(result.cancellations));
        this.touch(connection);
        return result;
      }
      const remaining = deadline - this.clock.now();
      if (remaining <= 0) {
        this.touch(connection);
        return result;
      }
      if ((this.waiters.get(connectionId)?.size ?? 0) >= this.maxWaitersPerConnection) {
        throw new MuseRelayError(429, "Too many polls on this connection");
      }
      await this.wait(connectionId, remaining, options.signal);
    }
  }

  private collect(connection: StoredConnection, limit: number, refMode = false): MuseRelayPollResult {
    const now = this.clock.now();
    const deliveries: MuseRelayDelivery[] = [];
    for (const turn of this.turns) {
      if (turn.instanceId !== connection.instanceId) continue;
      if (isTerminal(turn)) continue;
      if (refMode && deliveries.length < limit && this.resendable(turn, connection, now)) {
        deliveries.push(this.resend(turn, now));
        continue;
      }
      const claimable = turn.state === "queued"
        || (turn.state === "delivered" && (turn.leaseUntil ?? 0) <= now);
      if (!claimable) continue;
      if (deliveries.length >= limit) break;
      const previous = turn.state === "delivered" ? `redeliver acked=${turn.ackedAt !== undefined ? "yes" : "no"}` : "first";
      const leaseMs = refMode && this.claimAckMs > 0 ? Math.min(this.claimAckMs, this.leaseMs) : this.leaseMs;
      turn.state = "delivered";
      turn.attempt += 1;
      turn.connectionId = connection.connectionId;
      turn.deliveryId = `mrd_${randomUUID()}`;
      turn.leaseUntil = Math.min(now + leaseMs, turn.deadlineAt);
      delete turn.ackedAt;
      if (refMode && this.claimAckMs > 0 && this.maxResends > 0) {
        this.untouched.set(turn.turnId, { deliveryId: turn.deliveryId, connectionId: connection.connectionId, resends: 0 });
      } else {
        this.untouched.delete(turn.turnId);
      }
      console.log(`[muse-relay] deliver turn=${shortId(turn.turnId)} attempt=${turn.attempt} ${previous} queued=${now - turn.createdAt}ms lease=${leaseMs}ms mode=${refMode ? "ref" : "inline"}`);
      this.schedule(turn);
      // A waiting long poll is woken when an unconfirmed claim lapses, so the redelivery does not wait out the poll.
      if (leaseMs < this.leaseMs) this.clock.setTimeout(() => this.wakeInstance(turn.instanceId), leaseMs + 50);
      deliveries.push({
        turnId: turn.turnId,
        deliveryId: turn.deliveryId,
        attempt: turn.attempt,
        leaseUntil: new Date(turn.leaseUntil).toISOString(),
        createdAt: new Date(turn.createdAt).toISOString(),
        input: turn.input,
      });
    }
    if (deliveries.length) this.save();
    const cancellations: string[] = [];
    for (const turn of this.turns) {
      if (turn.instanceId !== connection.instanceId || turn.state !== "cancelled") continue;
      if ((turn.cancelNoticeUntil ?? 0) <= now) continue;
      if (turn.connectionId !== undefined && turn.connectionId !== connection.connectionId) continue;
      cancellations.push(turn.turnId);
    }
    return {
      deliveries,
      cancellations,
      serverTime: new Date(now).toISOString(),
    };
  }

  /**
   * The current delivery was claimed by this very connection in ref mode and nothing has touched it since: no slice,
   * no heartbeat, no event. The client never saw the poll answer (its next poll would not come while it fetched), so
   * sending the same delivery again is safe: the client dedupes by deliveryId, and the server state does not change.
   */
  private resendable(turn: StoredTurn, connection: StoredConnection, now: number): boolean {
    const entry = this.untouched.get(turn.turnId);
    if (!entry) return false;
    return turn.state === "delivered"
      && turn.ackedAt === undefined
      && turn.deliveryId === entry.deliveryId
      && turn.connectionId === connection.connectionId
      && entry.connectionId === connection.connectionId
      && (turn.leaseUntil ?? 0) > now
      && now < turn.deadlineAt
      && entry.resends < this.maxResends;
  }

  private resend(turn: StoredTurn, now: number): MuseRelayDelivery {
    const entry = this.untouched.get(turn.turnId)!;
    entry.resends += 1;
    const leaseMs = Math.min(this.claimAckMs, this.leaseMs);
    turn.leaseUntil = Math.max(turn.leaseUntil ?? 0, Math.min(now + leaseMs, turn.deadlineAt));
    console.log(`[muse-relay] resend turn=${shortId(turn.turnId)} attempt=${turn.attempt} resend=${entry.resends} queued=${now - turn.createdAt}ms lease=${leaseMs}ms`);
    this.clock.setTimeout(() => this.wakeInstance(turn.instanceId), leaseMs + 50);
    return {
      turnId: turn.turnId,
      deliveryId: turn.deliveryId!,
      attempt: turn.attempt,
      leaseUntil: new Date(turn.leaseUntil).toISOString(),
      createdAt: new Date(turn.createdAt).toISOString(),
      input: turn.input,
    };
  }

  private wait(connectionId: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const onAbort = () => waiter.resolve();
      const waiter: Waiter = {
        connectionId,
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          this.clock.clearTimeout(waiter.timer);
          const set = this.waiters.get(connectionId);
          set?.delete(waiter);
          if (set?.size === 0) this.waiters.delete(connectionId);
          resolve();
        },
        timer: undefined,
      };
      const set = this.waiters.get(connectionId) ?? new Set<Waiter>();
      this.waiters.set(connectionId, set);
      set.add(waiter);
      waiter.timer = this.clock.setTimeout(() => waiter.resolve(), Math.max(0, ms));
      if (signal?.aborted) waiter.resolve();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private wake(connectionId: string): void {
    for (const waiter of this.waiters.get(connectionId) ?? []) waiter.resolve();
  }

  private wakeInstance(instanceId: string): void {
    for (const connection of this.connections) {
      if (connection.instanceId === instanceId) this.wake(connection.connectionId);
    }
  }

  /**
   * The poll that claimed these deliveries lost its client before the answer left: drop the unconfirmed claims at once,
   * so the next poll gets them again instead of waiting out a lease nobody holds.
   */
  releaseClaims(connectionId: string, deliveryIds: string[]): void {
    if (this.unreadable || !deliveryIds.length) return;
    const now = this.clock.now();
    let changed = false;
    for (const turn of this.turns) {
      if (turn.connectionId !== connectionId || turn.state !== "delivered" || turn.ackedAt !== undefined) continue;
      if (!turn.deliveryId || !deliveryIds.includes(turn.deliveryId)) continue;
      turn.leaseUntil = now;
      this.untouched.delete(turn.turnId);
      changed = true;
      console.log(`[muse-relay] release turn=${shortId(turn.turnId)} attempt=${turn.attempt} (client gone before the poll answer)`);
    }
    if (changed) this.save();
  }

  heartbeat(connectionId: string, turnId?: string, deliveryId?: string): MuseRelayHeartbeatResult {
    this.assertReadable();
    const connection = this.connection(connectionId);
    if (!connection) throw new MuseRelayError(401, "Invalid connection token");
    this.touch(connection);
    if (turnId === undefined) return { ok: true, leaseUntil: null, cancelled: false };
    if (!deliveryId) throw new MuseRelayError(400, "deliveryId is required with turnId");
    const turn = this.turnFor(connection, turnId);
    if (turn.state === "cancelled") return { ok: true, leaseUntil: null, cancelled: true };
    if (isTerminal(turn)) throw new MuseRelayError(409, "This turn has already finished");
    if (turn.deliveryId !== deliveryId) throw new MuseRelayError(409, "This delivery is no longer current");
    const now = this.clock.now();
    if (now >= turn.deadlineAt) {
      this.failTurn(turn, "turn_timeout", "Muse did not finish this turn in time.");
      throw new MuseRelayError(409, "This turn has expired");
    }
    this.acknowledge(turn, "heartbeat");
    this.save();
    return { ok: true, leaseUntil: new Date(turn.leaseUntil!).toISOString(), cancelled: false };
  }

  private turnFor(connection: StoredConnection, turnId: string): StoredTurn {
    const turn = this.turn(turnId);
    if (!turn || turn.instanceId !== connection.instanceId) throw new MuseRelayError(404, "No such turn");
    if (turn.connectionId !== undefined && turn.connectionId !== connection.connectionId) {
      throw new MuseRelayError(409, "This turn is not delivered to this connection");
    }
    return turn;
  }

  recordEvent(connectionId: string, turnId: string, input: MuseRelayEventInput): MuseRelayEventResult {
    this.assertReadable();
    const connection = this.connection(connectionId);
    if (!connection) throw new MuseRelayError(401, "Invalid connection token");
    this.expireDue();
    const turn = this.turnFor(connection, turnId);
    this.touch(connection);
    return this.acceptEvent(turn, input);
  }

  private acceptEvent(turn: StoredTurn, input: MuseRelayEventInput): MuseRelayEventResult {
    if (turn.deliveryId !== input.deliveryId) throw new MuseRelayError(409, "This delivery is no longer current");
    if (input.type !== "completed" && input.type !== "failed" && input.itemId === undefined) {
      throw new MuseRelayError(400, "itemId is required for delta and text");
    }
    if ((input.type === "delta" || input.type === "text") && input.text === undefined) {
      throw new MuseRelayError(400, "text is required for delta and text");
    }
    if (input.text !== undefined && byteLength(input.text) > MUSE_RELAY_MAX_TEXT_BYTES) {
      throw new MuseRelayError(413, "Text is too large");
    }
    const hash = eventHash(input.type, input.itemId, input.text, input.stopReason);
    const existing = turn.events[input.eventId];
    if (existing) {
      if (existing.hash !== hash) throw new MuseRelayError(409, "This eventId was already used for different content");
      if (isTerminal(turn) && existing.type !== "completed" && existing.type !== "failed") {
        throw new MuseRelayError(409, "This turn has already finished");
      }
      return { accepted: true, duplicate: true, eventId: input.eventId, seq: existing.seq };
    }
    if (turn.files[input.eventId]) throw new MuseRelayError(409, "This eventId was already used for a file");
    if (isTerminal(turn)) throw new MuseRelayError(409, "This turn has already finished");
    if (input.seq !== turn.lastSeq + 1) throw new MuseRelayError(409, "Events must arrive in sequence");
    if (Object.keys(turn.events).length >= this.maxEventsPerTurn) {
      throw new MuseRelayError(429, "This turn has too many events");
    }

    if (input.type === "delta") {
      const item = turn.items[input.itemId!] ?? { delta: "" };
      if (item.text !== undefined) throw new MuseRelayError(409, "This item already has its final text");
      item.delta += normalizeText(input.text)!;
      turn.items[input.itemId!] = item;
    } else if (input.type === "text") {
      const item = turn.items[input.itemId!] ?? { delta: "" };
      if (item.text !== undefined) throw new MuseRelayError(409, "This item already has its final text");
      const final = normalizeText(input.text)!;
      if (item.delta && item.delta !== final) throw new MuseRelayError(400, "text does not match the deltas for this item");
      item.text = final;
      turn.items[input.itemId!] = item;
    }

    const record: StoredEventRecord = { seq: input.seq, type: input.type, hash };
    // An event is proof of life too: a worker that writes text never loses its lease between heartbeats.
    if (!isTerminal(turn) && turn.state === "delivered") this.acknowledge(turn, "event");
    turn.events[input.eventId] = record;
    turn.lastSeq = input.seq;
    console.log(`[muse-relay] event turn=${shortId(turn.turnId)} attempt=${turn.attempt} seq=${input.seq} type=${input.type} after=${this.clock.now() - turn.createdAt}ms`);
    if (input.type === "completed" || input.type === "failed") {
      turn.state = input.type === "completed" ? "completed" : "failed";
      turn.stopReason = input.stopReason ?? (input.type === "completed" ? "completed" : "failed");
      turn.terminalAt = this.clock.now();
      delete turn.leaseUntil;
      this.untouched.delete(turn.turnId);
      this.clearTimer(turn.turnId);
    }
    this.save();
    this.notify({
      type: "turn.event",
      instanceId: turn.instanceId,
      threadId: turn.threadId,
      turnId: turn.turnId,
      event: {
        eventId: input.eventId,
        seq: input.seq,
        type: input.type,
        ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
      },
    });
    return { accepted: true, duplicate: false, eventId: input.eventId, seq: input.seq };
  }

  /**
   * One slice of the current delivery's input, for a client that polled with inputMode "ref". Only the connection
   * holding the live lease may read it: a finished, cancelled, superseded or lapsed delivery answers 409.
   */
  inputSlice(connectionId: string, turnId: string, deliveryId: string, offset: number, length: number): MuseRelayInputSlice {
    this.assertReadable();
    const connection = this.connection(connectionId);
    if (!connection) throw new MuseRelayError(401, "Invalid connection token");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new MuseRelayError(400, "offset is invalid");
    if (!Number.isSafeInteger(length) || length < 1 || length > MUSE_RELAY_INPUT_SLICE_MAX_BYTES) {
      throw new MuseRelayError(400, "length is invalid");
    }
    this.expireDue();
    const turn = this.turnFor(connection, turnId);
    if (isTerminal(turn)) throw new MuseRelayError(409, "This turn has already finished");
    if (turn.state !== "delivered" || turn.deliveryId !== deliveryId) throw new MuseRelayError(409, "This delivery is no longer current");
    if ((turn.leaseUntil ?? 0) <= this.clock.now()) throw new MuseRelayError(409, "This delivery's lease has expired");
    let bytes = this.inputCache.get(deliveryId);
    if (!bytes) {
      bytes = museRelayInputBytes(turn.input);
      this.inputCache.set(deliveryId, bytes);
      while (this.inputCache.size > INPUT_CACHE_ENTRIES) this.inputCache.delete(this.inputCache.keys().next().value!);
    }
    if (offset > bytes.byteLength) throw new MuseRelayError(400, "offset is past the end of the input");
    const end = Math.min(bytes.byteLength, offset + length);
    // The client has the poll answer: from here a loss is handled by the short lease, never by sending it again.
    this.untouched.delete(turn.turnId);
    if (turn.ackedAt === undefined && this.claimAckMs > 0) {
      // Before the worker answers, a moving fetch keeps a short lease; the last slice opens the pickup window.
      const now = this.clock.now();
      const window = Math.min(this.leaseMs, end === bytes.byteLength ? Math.max(this.pickupMs, this.claimAckMs) : this.claimAckMs);
      const until = Math.min(now + window, turn.deadlineAt);
      if (until > (turn.leaseUntil ?? 0)) turn.leaseUntil = until;
      if (offset === 0) {
        this.notify({ type: "turn.claimed", instanceId: turn.instanceId, threadId: turn.threadId, turnId: turn.turnId, attempt: turn.attempt, via: "input" });
      }
      if (end === bytes.byteLength) this.save();
      if (end === bytes.byteLength && window < this.leaseMs) {
        this.clock.setTimeout(() => this.wakeInstance(turn.instanceId), window + 50);
      }
    }
    {
      console.log(`[muse-relay] input turn=${shortId(turnId)} attempt=${turn.attempt} offset=${offset} end=${end} total=${bytes.byteLength}`);
    }
    return { offset, total: bytes.byteLength, data: bytes.subarray(offset, end) };
  }

  /** Checks a file event before its body is read; the upload id is stable across retries. */
  beginFile(
    connectionId: string,
    turnId: string,
    input: { deliveryId: string; eventId: string; seq: number },
  ): { uploadId: string } {
    this.assertReadable();
    const connection = this.connection(connectionId);
    if (!connection) throw new MuseRelayError(401, "Invalid connection token");
    this.expireDue();
    const turn = this.turnFor(connection, turnId);
    this.touch(connection);
    if (turn.deliveryId !== input.deliveryId) throw new MuseRelayError(409, "This delivery is no longer current");
    const existing = turn.files[input.eventId];
    if (existing) {
      if (existing.seq !== input.seq) throw new MuseRelayError(409, "This eventId was already used with a different sequence");
      return { uploadId: museRelayUploadId(turn.turnId, input.eventId) };
    }
    if (turn.events[input.eventId]) throw new MuseRelayError(409, "This eventId was already used for an event");
    if (isTerminal(turn)) throw new MuseRelayError(409, "This turn has already finished");
    if (input.seq !== turn.lastSeq + 1) throw new MuseRelayError(409, "Events must arrive in sequence");
    if (Object.keys(turn.events).length >= this.maxEventsPerTurn) throw new MuseRelayError(429, "This turn has too many events");
    return { uploadId: museRelayUploadId(turn.turnId, input.eventId) };
  }

  recordFile(connectionId: string, turnId: string, input: MuseRelayFileInput): MuseRelayFileResult {
    this.assertReadable();
    const connection = this.connection(connectionId);
    if (!connection) throw new MuseRelayError(401, "Invalid connection token");
    this.expireDue();
    const turn = this.turnFor(connection, turnId);
    if (turn.deliveryId !== input.deliveryId) throw new MuseRelayError(409, "This delivery is no longer current");
    const existing = turn.files[input.eventId];
    if (existing) {
      if (existing.seq !== input.seq) throw new MuseRelayError(409, "This eventId was already used with a different sequence");
      if (existing.hash !== input.hash) throw new MuseRelayError(409, "This eventId was already used for different file bytes");
      return { accepted: true, duplicate: true, eventId: input.eventId, seq: existing.seq };
    }
    if (turn.events[input.eventId]) throw new MuseRelayError(409, "This eventId was already used for an event");
    if (isTerminal(turn)) throw new MuseRelayError(409, "This turn has already finished");
    if (input.seq !== turn.lastSeq + 1) throw new MuseRelayError(409, "Events must arrive in sequence");
    if (Object.keys(turn.events).length >= this.maxEventsPerTurn) throw new MuseRelayError(429, "This turn has too many events");
    turn.files[input.eventId] = {
      seq: input.seq,
      eventId: input.eventId,
      kind: input.kind,
      path: input.path,
      mime: input.mime,
      ...(input.name ? { name: input.name } : {}),
      bytes: input.bytes,
      hash: input.hash,
    };
    turn.lastSeq = input.seq;
    this.save();
    this.notify({
      type: "turn.file",
      instanceId: turn.instanceId,
      threadId: turn.threadId,
      turnId: turn.turnId,
      file: {
        eventId: input.eventId,
        seq: input.seq,
        kind: input.kind,
        path: input.path,
        mime: input.mime,
        ...(input.name ? { name: input.name } : {}),
      },
    });
    return { accepted: true, duplicate: false, eventId: input.eventId, seq: input.seq };
  }

  cancelTurn(turnId: string): void {
    this.assertReadable();
    const turn = this.turn(turnId);
    if (!turn || isTerminal(turn)) return;
    turn.state = "cancelled";
    turn.stopReason = "cancelled";
    turn.terminalAt = this.clock.now();
    turn.cancelNoticeUntil = this.clock.now() + CANCEL_NOTICE_MS;
    console.log(`[muse-relay] cancel turn=${shortId(turn.turnId)} attempt=${turn.attempt} acked=${turn.ackedAt !== undefined ? "yes" : "no"} lastSeq=${turn.lastSeq}`);
    this.untouched.delete(turn.turnId);
    delete turn.leaseUntil;
    this.clearTimer(turn.turnId);
    this.save();
    this.notify({ type: "turn.cancelled", instanceId: turn.instanceId, threadId: turn.threadId, turnId: turn.turnId });
    this.wakeInstance(turn.instanceId);
  }

  /** Tests and shutdown only: the state on disk is kept. */
  flush(): void {
    if (!this.unreadable) this.save();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const handle of this.turnTimers.values()) this.clock.clearTimeout(handle);
    this.turnTimers.clear();
    this.inputCache.clear();
    this.untouched.clear();
    for (const connectionId of this.waiters.keys()) this.wake(connectionId);
    this.listeners.clear();
  }
}

let defaultHub: MuseRelayHub | undefined;

export function defaultMuseRelayHub(): MuseRelayHub {
  return (defaultHub ??= new MuseRelayHub({ dataDir: DATA_DIR }));
}

export function disposeDefaultMuseRelayHub(): void {
  defaultHub?.dispose();
  defaultHub = undefined;
}

export function museRelayBasePath(connectionId: string): string {
  return `${MUSE_RELAY_BASE_PREFIX}/${encodeURIComponent(connectionId)}`;
}

export function safeConnectionId(value: string): string {
  return safeIdentifier(value, "connectionId");
}
