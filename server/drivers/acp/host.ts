// One ACP agent process (JSON-RPC 2.0 over stdio) and the threads whose sessions it runs. An agent may run several
// sessions in one process (ACP keys every session request and update by sessionId), so a sharing driver links many
// threads to one host; every other driver links exactly one.
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { engineMemory } from "../../engine-memory.ts";
import { appendNative } from "../native.ts";
import { StderrTail } from "./exit-report.ts";
import { acpRpcError } from "./rpc-error.ts";

/** A catalog can contain credential-bearing native configuration, including late replies. */
export function acpNativeIncomingLogMessage(message: any, privateResponses: { has(id: number): boolean }): unknown {
  if (!privateResponses.has(message?.id)) return message;
  return { jsonrpc: message.jsonrpc, id: message.id, ...(message.error !== undefined ? { error: "[MCP catalog error omitted]" } : { result: "[MCP catalog omitted]" }) };
}

/** IDs whose responses must stay masked. A timed-out request can still answer later, so an ended
 * request's ID is remembered for a bounded while instead of becoming an ordinary log line. */
export class PrivateResponseIds {
  static readonly TTL_MS = 60_000;
  static readonly LIMIT = 1024;
  readonly #active = new Set<number>();
  readonly #expired = new Map<number, number>();

  add(id: number): void {
    this.prune();
    this.#active.add(id);
  }

  /** The request ended without an answer: keep masking its ID for `TTL_MS`, bounded by `LIMIT`. */
  retire(id: number): void {
    if (!this.#active.delete(id)) return;
    this.#expired.set(id, Date.now() + PrivateResponseIds.TTL_MS);
    // Map insertion order is age here, so the oldest entry goes first.
    while (this.#expired.size > PrivateResponseIds.LIMIT) {
      const oldest = this.#expired.keys().next().value;
      if (oldest === undefined) break;
      this.#expired.delete(oldest);
    }
  }

  /** The answer arrived (or never needs masking again). */
  forget(id: number): void {
    this.#active.delete(id);
    this.#expired.delete(id);
  }

  prune(now = Date.now()): void {
    for (const [id, expiresAt] of this.#expired) {
      if (expiresAt <= now) this.#expired.delete(id);
    }
  }

  has(id: number): boolean {
    return this.#active.has(id) || this.#expired.has(id);
  }
}

export interface AcpConnection {
  send(obj: unknown): void;
  /** `timeoutMs` is a hard deadline; `idleMs` restarts on every inbound line, tripping only on total silence. */
  request(
    method: string,
    params: unknown,
    timeoutMs?: number,
    receive?: (result: any) => void,
    idleMs?: number,
    idleMessage?: string | (() => string),
  ): Promise<any>;
  readonly lastInboundAt: number;
  touch(): void;
  failAll(error: Error): void;
  close(): void;
}

/** What a linked thread does with the agent's traffic for its session. */
export interface AcpInbound {
  request(msg: any): void;
  notification(msg: any): void;
  exit(code: number | null, signal: NodeJS.Signals | null): void;
  error(error: Error): void;
  /** A tool or a question is open: silence then is no stall. */
  busy(): boolean;
}

interface Pending {
  link: AcpLink | null;
  method: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  armIdle: () => void;
}

export interface AcpHostOptions {
  /** Native-protocol log label. */
  source: string;
  /** What the native log keeps of a message (images and tool payloads bounded). */
  logMessage(msg: any): unknown;
  /** A request for a session no thread holds: it must still be answered or the agent blocks. */
  unrouted(msg: any, send: (obj: unknown) => void): void;
}

export class AcpLink implements AcpConnection {
  sessionId: string | null = null;
  inbound: AcpInbound | null = null;
  closed = false;
  #lastInboundAt = Date.now();
  readonly host: AcpHost;
  readonly threadId: string;

  constructor(host: AcpHost, threadId: string) {
    this.host = host;
    this.threadId = threadId;
  }

  get lastInboundAt(): number { return this.#lastInboundAt; }

  heard(): void {
    this.#lastInboundAt = Date.now();
    this.touch();
  }

  send(obj: unknown): void {
    const message = obj as { id?: unknown; result?: unknown; error?: unknown };
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) this.touch();
    this.host.write(obj, this.threadId);
  }

  request(method: string, params: unknown, timeoutMs?: number, receive?: (result: any) => void, idleMs?: number,
    idleMessage?: string | (() => string)): Promise<any> {
    return this.host.request(this, method, params, timeoutMs, receive, idleMs, idleMessage);
  }

  touch(): void { this.host.touch(this); }

  failAll(error: Error): void { this.host.failAll(this, error); }

  close(): void {
    if (this.closed) return;
    this.failAll(new Error("session closed"));
    this.closed = true;
    this.host.unlink(this);
  }
}

export class AcpHost {
  readonly links = new Set<AcpLink>();
  /** The last thread to leave still hears the process end: its stopped turn settles on it. */
  #lastOut: AcpLink | null = null;
  initResult: any = null;
  authenticated = false;
  /** The last stderr lines, masked, for the exit message. */
  readonly stderrTail = new StderrTail();
  dead = false;
  /** Takes no new sessions; it ends when its last one closes. */
  draining = false;
  /** Sessions ever linked, and those closed while others went on: an agent may keep a closed session's memory and MCP
   * servers until its process exits (OpenCode 1.19.3 does). */
  opened = 0;
  retired = 0;
  recycle: ReturnType<typeof setTimeout> | null = null;
  /** Security: the thread each folder belongs to, for the process's life. An agent may keep MCP servers per folder and
   * name, not per session (OpenCode 1.18.27: session/new and session/load call mcp.add({ directory, name })), so a
   * second thread in a folder would call through the first one's servers and act on that thread's turn capability. */
  readonly #folders = new Map<string, string>();
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  readonly #private = new PrivateResponseIds();
  readonly #once = new Map<string, Promise<unknown>>();
  readonly child: ChildProcessWithoutNullStreams;
  readonly key: string | null;
  readonly options: AcpHostOptions;

  constructor(child: ChildProcessWithoutNullStreams, key: string | null, options: AcpHostOptions) {
    this.child = child;
    this.key = key;
    this.options = options;
    let buf = "";
    // decode as UTF-8 across chunk boundaries — a raw `buf += chunk` splits
    // multibyte characters that straddle two reads and corrupts the text
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        this.#receive(msg);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.stderrTail.write(chunk));
    child.on("error", (error) => {
      this.dead = true;
      for (const link of this.#listening()) link.inbound?.error(error);
    });
    child.on("close", (code, signal) => {
      this.dead = true;
      this.stderrTail.flush();
      for (const link of this.#listening()) link.inbound?.exit(code, signal);
    });
  }

  /** Room for `threadId` in `folder`: alive, not draining, under `limit` sessions open and `lifetime` ever opened, and
   * no other thread has had a session in that folder here. */
  accepts(limit: number, lifetime: number, threadId: string, folder: string): boolean {
    const owner = this.#folders.get(folder);
    return !this.dead && !this.draining && this.child.exitCode === null && this.links.size < limit && this.opened < lifetime &&
      (owner === undefined || owner === threadId);
  }

  link(threadId: string, folder: string): AcpLink {
    this.#folders.set(folder, threadId);
    const link = new AcpLink(this, threadId);
    this.links.add(link);
    this.opened += 1;
    engineMemory.attach(this.child, threadId);
    return link;
  }

  unlink(link: AcpLink): void {
    if (!this.links.delete(link)) return;
    if (!this.links.size) this.#lastOut = link;
    if (![...this.links].some((other) => other.threadId === link.threadId)) engineMemory.detach(this.child, link.threadId);
  }

  #listening(): AcpLink[] {
    return this.#lastOut ? [...this.links, this.#lastOut] : [...this.links];
  }

  /** Runs `start` once per process (initialize, authenticate): later sessions reuse its answer. A failure lets the next
   * session try again. */
  once<T>(name: string, start: () => Promise<T>): Promise<T> {
    let running = this.#once.get(name) as Promise<T> | undefined;
    if (!running) {
      running = start();
      this.#once.set(name, running);
      running.catch(() => { if (this.#once.get(name) === running) this.#once.delete(name); });
    }
    return running;
  }

  write(obj: unknown, threadId: string | null): void {
    try {
      this.child.stdin.write(JSON.stringify(obj) + "\n");
    } catch {}
    if (threadId !== null) appendNative(threadId, { dir: "out", source: this.options.source, msg: this.options.logMessage(obj) });
  }

  request(link: AcpLink | null, method: string, params: unknown, timeoutMs?: number, receive?: (result: any) => void,
    idleMs?: number, idleMessage?: string | (() => string)): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      this.#private.prune();
      const id = this.#nextId++;
      const pending: Pending = {
        link,
        method,
        // Wire order: an update following this response may arrive before the awaiting continuation resumes.
        resolve: (result) => { receive?.(result); resolve(result); },
        reject,
        timer: null,
        idleTimer: null,
        armIdle: () => {},
      };
      // Both deadlines end the request through here, so the other timer can never fire afterwards.
      const finish = (error: Error): void => {
        if (this.#pending.get(id) !== pending) return;
        this.#cleanupPending(id, pending);
        this.#private.retire(id);
        reject(error);
      };
      if (method === "_x.ai/mcp/list") this.#private.add(id);
      if (timeoutMs) {
        pending.timer = setTimeout(() => {
          finish(Object.assign(new Error(`${method} timed out`), { acpSessionFailure: true }));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      pending.armIdle = () => {
        if (!(idleMs && idleMs > 0)) return;
        if (pending.idleTimer) clearTimeout(pending.idleTimer);
        pending.idleTimer = setTimeout(() => {
          if (link?.inbound?.busy()) { pending.armIdle(); return; }
          const error = new Error((typeof idleMessage === "function" ? idleMessage() : idleMessage) ?? `${method} stopped responding`);
          Object.assign(error, { acpPromptStall: true });
          finish(error);
        }, idleMs);
        pending.idleTimer.unref?.();
      };
      pending.armIdle();
      this.#pending.set(id, pending);
      this.write({ jsonrpc: "2.0", id, method, params }, link?.threadId ?? null);
    });
  }

  #cleanupPending(id: number, pending: Pending): void {
    if (this.#pending.get(id) === pending) this.#pending.delete(id);
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    if (pending.idleTimer) {
      clearTimeout(pending.idleTimer);
      pending.idleTimer = null;
    }
  }

  touch(link: AcpLink): void {
    for (const pending of this.#pending.values()) if (pending.link === link) pending.armIdle();
  }

  failAll(link: AcpLink, error: Error): void {
    for (const [id, pending] of this.#pending) {
      if (pending.link !== link) continue;
      this.#cleanupPending(id, pending);
      this.#private.retire(id);
      pending.reject(error);
    }
  }

  /** The session's own traffic goes to the thread holding it; with one thread linked, everything does. */
  #route(msg: any): AcpLink | null {
    const only = this.links.size === 1 ? this.links.values().next().value! : null;
    if (msg.id !== undefined && msg.method === undefined) return this.#pending.get(msg.id)?.link ?? only;
    const sessionId = msg.params?.sessionId;
    if (typeof sessionId === "string") {
      for (const link of this.links) if (link.sessionId === sessionId) return link;
      // A shared process never hands one session's traffic to another thread, such as a closed session's late update.
      if (this.key !== null) return only?.sessionId === null ? only : null;
    }
    return only;
  }

  #receive(msg: any): void {
    this.#private.prune();
    const link = this.#route(msg);
    if (link) {
      appendNative(link.threadId, { dir: "in", source: this.options.source,
        msg: this.options.logMessage(acpNativeIncomingLogMessage(msg, this.#private)) });
      // Inbound traffic proves the session is alive and making progress, so its idle deadlines restart; only its
      // own silence trips one.
      link.heard();
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.#pending.get(msg.id);
      // Logged above while still private, so a late answer stays masked; it is the last word on that ID.
      this.#private.forget(msg.id);
      if (!pending) return;
      this.#cleanupPending(msg.id, pending);
      if (msg.error) pending.reject(acpRpcError(msg.error, pending.method));
      else pending.resolve(msg.result);
    } else if (msg.id !== undefined && msg.method) {
      if (link?.inbound && !link.closed) link.inbound.request(msg);
      else this.options.unrouted(msg, (obj) => this.write(obj, link?.threadId ?? null));
    } else if (msg.method && link && !link.closed) {
      link.inbound?.notification(msg);
    }
  }
}
