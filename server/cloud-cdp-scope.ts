// A scoped DevTools connection: one bot conversation's own view of a shared Chrome. agent-browser attaches to the first
// page it finds, so two sessions on one cloud Chrome would drive the same tab; through a scope each session sees only
// the pages it opened (and their popups), gets a blank page of its own when it has none, and its pages are closed a
// little while after its last connection goes away.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/** The path a scoped connection asks the proxy for; the scope is an agent-browser session name. */
export const SCOPE_PATH_PREFIX = "/devtools/browser/omb-scope/";
const SCOPE_NAME = /^[A-Za-z0-9_.-]{1,160}$/;

/** The DevTools URL a session opens to get its own scope behind a proxy at `doorUrl` (http://host:port). */
export function scopedCdpUrl(doorUrl: string, scope: string): string {
  if (!SCOPE_NAME.test(scope)) throw new Error(`not a scope name: ${scope}`);
  const door = new URL(doorUrl);
  const scheme = door.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${door.host}${SCOPE_PATH_PREFIX}${scope}`;
}

/** The scope a WebSocket upgrade path asks for, or null for an ordinary (unscoped) DevTools path. */
export function scopeOfPath(path: string): string | null {
  const bare = path.split("?")[0] ?? "";
  if (!bare.startsWith(SCOPE_PATH_PREFIX)) return null;
  const scope = decodeURIComponent(bare.slice(SCOPE_PATH_PREFIX.length));
  return SCOPE_NAME.test(scope) ? scope : null;
}

/** The port a DevTools URL (http, ws, scoped or not) is reached on, or null. */
export function cdpUrlPort(url: string | undefined): number | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port || (parsed.protocol === "https:" || parsed.protocol === "wss:" ? 443 : 80));
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

interface ScopeEntry { targets: Set<string>; connections: number; timer: ReturnType<typeof setTimeout> | null }

/** Chrome's target ids use only these characters; anything else in a state file is not an id the proxy may close. */
const TARGET_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Where a registry keeps the pages its scopes own, so the next process can close what this one leaves behind. */
export interface ScopePersist {
  load(): string[];
  save(targetIds: string[]): void;
}

/** A scope state file: a JSON array of target ids, landed by rename so a crash mid-write cannot tear the list. */
export function scopeFilePersist(file: string): ScopePersist {
  return {
    load() {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && TARGET_ID.test(id)) : [];
      } catch {
        return [];
      }
    },
    save(targetIds) {
      writeFileSync(`${file}.tmp`, JSON.stringify(targetIds), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    },
  };
}

/** Every scope the proxy serves: which pages each one owns, and how many connections still hold it open. */
export class ScopeRegistry {
  readonly #closeTarget: (targetId: string) => Promise<void>;
  readonly #graceMs: number;
  readonly #log: (line: string) => void;
  readonly #persist: ScopePersist | null;
  readonly #scopes = new Map<string, ScopeEntry>();
  #orphansClosed = false;

  constructor(options: { graceMs?: number; closeTarget: (targetId: string) => Promise<void>; log?: (line: string) => void; persist?: ScopePersist }) {
    this.#closeTarget = options.closeTarget;
    this.#graceMs = options.graceMs ?? 30_000;
    this.#log = options.log ?? (() => {});
    this.#persist = options.persist ?? null;
  }

  join(scope: string): void {
    const entry = this.#entry(scope);
    entry.connections += 1;
    // A browser that reconnects right away would otherwise find its pages already gone.
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  leave(scope: string): void {
    const entry = this.#scopes.get(scope);
    if (entry === undefined || entry.connections === 0) return;
    entry.connections -= 1;
    if (entry.connections > 0) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.#scopes.delete(scope);
      void this.#closeAll([...entry.targets]).then(() => this.#save());
    }, this.#graceMs);
    // The proxy must not be held open by a scope nobody is connected to.
    entry.timer.unref?.();
  }

  async #closeAll(targetIds: string[]): Promise<void> {
    for (const targetId of targetIds) {
      try {
        await this.#closeTarget(targetId);
      } catch (error) {
        this.#log(`could not close the page ${targetId} of a scope that went away: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  owns(scope: string, targetId: string): boolean {
    return this.#scopes.get(scope)?.targets.has(targetId) === true;
  }

  add(scope: string, targetId: string): void {
    this.#entry(scope).targets.add(targetId);
    this.#save();
  }

  forget(targetId: string): void {
    for (const entry of this.#scopes.values()) entry.targets.delete(targetId);
    this.#save();
  }

  targets(scope: string): string[] {
    return [...(this.#scopes.get(scope)?.targets ?? [])];
  }

  /** Closes the pages a previous process recorded but no current scope owns, once per registry. Only recorded ids
   * are touched: on the person's own Chrome, every tab the proxy never opened must stay. */
  async closeOrphans(): Promise<number> {
    if (this.#orphansClosed) return 0;
    this.#orphansClosed = true;
    let recorded: string[] = [];
    try {
      recorded = this.#persist?.load() ?? [];
    } catch {
      // An unreadable list names nothing this process is allowed to close.
      recorded = [];
    }
    const owned = new Set(this.#owned());
    let attempted = 0;
    for (const targetId of new Set(recorded)) {
      if (owned.has(targetId)) continue;
      attempted += 1;
      try {
        await this.#closeTarget(targetId);
      } catch (error) {
        this.#log(`could not close the orphaned page ${targetId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.#save();
    return attempted;
  }

  close(): void {
    for (const entry of this.#scopes.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.timer = null;
    }
    this.#scopes.clear();
  }

  #entry(scope: string): ScopeEntry {
    const existing = this.#scopes.get(scope);
    if (existing !== undefined) return existing;
    const created: ScopeEntry = { targets: new Set(), connections: 0, timer: null };
    this.#scopes.set(scope, created);
    return created;
  }

  #owned(): string[] {
    return [...new Set([...this.#scopes.values()].flatMap((entry) => [...entry.targets]))];
  }

  #save(): void {
    if (this.#persist === null) return;
    try {
      this.#persist.save(this.#owned());
    } catch (error) {
      this.#log(`could not write the scope state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** One scoped connection's view of the shared browser: what it owns, and what it is still waiting for. */
export class ScopeView {
  readonly scope: string;
  readonly #registry: ScopeRegistry;
  /** Pages that belong to another session, so attaching to one is refused instead of stealing it. */
  readonly #foreign = new Set<string>();
  /** The messages held while this connection's own createTarget is on its way to the upstream. */
  #held: Array<Record<string, unknown>> = [];
  #creating = false;

  constructor(scope: string, registry: ScopeRegistry) {
    this.scope = scope;
    this.#registry = registry;
  }

  join(): void {
    this.#registry.join(this.scope);
  }

  leave(): void {
    this.#registry.leave(this.scope);
  }

  /** Only the browser level is filtered: a session's messages belong to the target that session is attached to. */
  filterUpstream(message: { method?: string; params?: unknown; sessionId?: string }): "pass" | "drop" | "hold" {
    if (message.sessionId !== undefined) return "pass";
    const params = asRecord(message.params);
    switch (message.method) {
      case "Target.targetCreated":
      case "Target.targetInfoChanged":
      case "Target.attachedToTarget":
        return this.#onTargetInfo(message, asRecord(params.targetInfo));
      case "Target.targetDestroyed":
      case "Target.targetCrashed":
        return this.#onTargetGone(String(params.targetId ?? ""));
      default:
        return "pass";
    }
  }

  #onTargetInfo(message: Record<string, unknown>, info: Record<string, unknown>): "pass" | "drop" | "hold" {
    const targetId = String(info.targetId ?? "");
    // Only pages are a session's own; a service worker or a shared worker is nobody's to own.
    if (info.type !== "page") return "pass";
    if (this.#registry.owns(this.scope, targetId)) return "pass";
    // A popup arrives with the opener's id, and belongs to the session that opened it from then on.
    const openerId = String(info.openerId ?? "");
    if (openerId !== "" && this.#registry.owns(this.scope, openerId)) {
      this.#registry.add(this.scope, targetId);
      return "pass";
    }
    // The page this connection just asked for is named by an event that can arrive before the answer does.
    if (this.#creating) {
      this.#held.push(message);
      return "hold";
    }
    this.#foreign.add(targetId);
    return "drop";
  }

  #onTargetGone(targetId: string): "pass" | "drop" {
    if (this.#registry.owns(this.scope, targetId)) {
      this.#registry.forget(targetId);
      return "pass";
    }
    // A page this connection never knew about going away is not news it needs.
    if (this.#foreign.delete(targetId)) return "drop";
    return "pass";
  }

  beginCreate(): void {
    this.#creating = true;
  }

  /** The answer to a createTarget is in: the page it names is ours, and so is every held message about it. */
  endCreate(targetId: string | null): Array<Record<string, unknown>> {
    this.#creating = false;
    if (targetId !== null) this.#registry.add(this.scope, targetId);
    const held = this.#held;
    this.#held = [];
    const mine: Array<Record<string, unknown>> = [];
    for (const message of held) {
      const info = asRecord(asRecord(message.params).targetInfo);
      if (this.#isOurs(info)) mine.push(message);
      else this.#foreign.add(String(info.targetId ?? ""));
    }
    return mine;
  }

  /** Non-page targets are everybody's, and a page is ours once we own it or opened the window it came from. */
  #isOurs(info: { targetId?: unknown; type?: unknown; openerId?: unknown }): boolean {
    if (info.type !== "page") return true;
    const targetId = String(info.targetId ?? "");
    if (this.#registry.owns(this.scope, targetId)) return true;
    const openerId = String(info.openerId ?? "");
    return openerId !== "" && this.#registry.owns(this.scope, openerId);
  }

  filterTargetInfos<T extends { targetId?: unknown; type?: unknown; openerId?: unknown }>(infos: T[]): T[] {
    return infos.filter((info) => this.#isOurs(info));
  }

  isForeign(targetId: string): boolean {
    return this.#foreign.has(targetId);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
