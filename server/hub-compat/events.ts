/**
 * Per-ref dispatch event log.
 *
 * Every dispatched task (hub_dispatch_cli / zcode_delegate / trae_delegate) gets one
 * append-only JSONL file under `<stateDir>/events/<ref>.jsonl`. The record is the
 * thing the console, `hub_events`, the SSE endpoint and the workbench UI read, so it
 * carries only what a caller may see: a sequence number, a timestamp, the ref/agent,
 * one of six kinds and a one-line summary. Keys and tokens are scrubbed on the way in.
 *
 * Writes are synchronous on purpose: a status transition must be visible to a reader
 * in the same tick that it lands in the result file, and the volume is a few lines per
 * task per minute.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type HubEventKind = "accepted" | "started" | "progress" | "done" | "error" | "timeout";

export interface HubEvent {
  seq: number;
  /** Epoch seconds, same clock as the result records. */
  at: number;
  ref: string;
  agent: string;
  kind: HubEventKind;
  text: string;
}

const MAX_TEXT_CHARS = 400;
const MAX_MEMORY_EVENTS = 500;
const MAX_LIST_EVENTS = 200;

const REDACTIONS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [REDACTED]"],
  [/([?&]token=)[^&\s"']+/gi, "$1[REDACTED]"],
  [/\b(?:sk|pk|ghp|gho|ghs|ghu|oat|dfrt|xox[abp])-[A-Za-z0-9._-]{8,}/g, "[REDACTED]"],
  // JWTs and other three-part blobs.
  [/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"],
  // Long hex runs are API keys, hashes of secrets or trace ids; nothing a task summary needs.
  [/\b[a-f0-9]{32,}\b/gi, "[REDACTED]"],
];

/** One line, no control characters, no credentials. */
export function redactEventText(value: unknown): string {
  let text = String(value ?? "");
  const hubToken = (process.env.HUB_TOKEN ?? "").trim();
  if (hubToken.length >= 8) text = text.replaceAll(hubToken, "[REDACTED]");
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  return text.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

function parseLine(line: string): HubEvent | null {
  if (!line.trim()) return null;
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const event = value as Partial<HubEvent>;
    if (typeof event.seq !== "number" || !event.ref || !event.agent || !event.kind) return null;
    return {
      seq: event.seq,
      at: Number(event.at ?? 0),
      ref: String(event.ref),
      agent: String(event.agent),
      kind: event.kind,
      text: String(event.text ?? ""),
    };
  } catch {
    return null;
  }
}

/**
 * The log is per state directory: the compat process writes it, the workbench's
 * `/api/hub/tasks` bridge and the SSE route read the same files, and a restart
 * continues the sequence rather than starting over at 1.
 */
export class HubEventLog {
  readonly eventsDir: string;
  private readonly memory = new Map<string, HubEvent[]>();
  private readonly listeners = new Map<string, Set<(event: HubEvent) => void>>();

  constructor(stateDir: string) {
    this.eventsDir = join(stateDir, "events");
  }

  pathFor(ref: string): string {
    return join(this.eventsDir, `${ref.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`);
  }

  private readFileEvents(ref: string): HubEvent[] {
    const path = this.pathFor(ref);
    if (!existsSync(path)) return [];
    try {
      return readFileSync(path, "utf8").split("\n").map(parseLine).filter((event): event is HubEvent => event !== null);
    } catch {
      return [];
    }
  }

  private eventsFor(ref: string): HubEvent[] {
    const cached = this.memory.get(ref);
    if (cached) return cached;
    const loaded = this.readFileEvents(ref).slice(-MAX_MEMORY_EVENTS);
    this.memory.set(ref, loaded);
    return loaded;
  }

  private nextSeq(ref: string): number {
    const events = this.eventsFor(ref);
    return (events.at(-1)?.seq ?? 0) + 1;
  }

  /** Append one event and hand it to live subscribers; returns the stored record. */
  emit(ref: unknown, agent: unknown, kind: HubEventKind, text: unknown): HubEvent {
    const cleanRef = String(ref ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "unknown";
    const event: HubEvent = {
      seq: this.nextSeq(cleanRef),
      at: Date.now() / 1000,
      ref: cleanRef,
      agent: String(agent ?? "").slice(0, 80) || "unknown",
      kind,
      text: redactEventText(text),
    };
    const events = this.eventsFor(cleanRef);
    events.push(event);
    if (events.length > MAX_MEMORY_EVENTS) events.splice(0, events.length - MAX_MEMORY_EVENTS);
    try {
      mkdirSync(this.eventsDir, { recursive: true });
      appendFileSync(this.pathFor(cleanRef), JSON.stringify(event) + "\n", "utf8");
    } catch {
      // The in-memory stream still reaches live readers; a disk problem must not fail a dispatch.
    }
    for (const listener of this.listeners.get(cleanRef) ?? []) {
      try {
        listener(event);
      } catch {
        /* one broken subscriber must not stop the others */
      }
    }
    return event;
  }

  /** Events with `seq > since`, oldest first, at most `limit`. */
  list(ref: unknown, since = 0, limit = MAX_LIST_EVENTS): HubEvent[] {
    const cleanRef = String(ref ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
    if (!cleanRef) return [];
    // The file is authoritative: the workbench bridge reads a log another process writes.
    const fromDisk = this.readFileEvents(cleanRef);
    const all = fromDisk.length ? fromDisk : this.eventsFor(cleanRef);
    const after = Number.isFinite(since) ? since : 0;
    return all.filter((event) => event.seq > after).slice(0, Math.max(1, Math.min(limit, MAX_MEMORY_EVENTS)));
  }

  subscribe(ref: unknown, listener: (event: HubEvent) => void): () => void {
    const cleanRef = String(ref ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
    if (!cleanRef) return () => {};
    const set = this.listeners.get(cleanRef) ?? new Set();
    set.add(listener);
    this.listeners.set(cleanRef, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(cleanRef);
    };
  }
}

const logs = new Map<string, HubEventLog>();

/** One log per state directory, shared by the dispatch layer and the HTTP surface. */
export function hubEventLog(stateDir: string): HubEventLog {
  const key = join(stateDir);
  const existing = logs.get(key);
  if (existing) return existing;
  const created = new HubEventLog(stateDir);
  logs.set(key, created);
  return created;
}
