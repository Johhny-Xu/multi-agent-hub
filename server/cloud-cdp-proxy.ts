// The DevTools endpoint a CLI on this machine talks to when its browser is the cloud's headless Chrome: everything is
// forwarded to the real Chrome, and four things happen on the way. A local file or a local port is previewed through
// a *.local.maus address the cloud browser can resolve, a navigation to a domain that needs a login is refused with a
// message pointing at the browser that has the login, the number of pages is capped behind a queue, and a live view
// costs low-frequency stills instead of a screencast.
//
// The CLI sees an ordinary Chrome endpoint, so nothing about it changes: agent-browser, Playwright's connectOverCDP and
// Puppeteer all keep working. What changes is what reaches the cloud browser and what the person is asked about.
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import { DEFAULT_MAX_LOCAL_BYTES, asText, DIRTYING_COMMAND, DIRTYING_EVENT, fromLocalMausUrl, insideRoots, LOCAL_HOST_SUFFIX, mimeOf, rewriteEndpointBody, targetInfosOf, toBuffer, toLocalMausUrl, type Frame } from "./cloud-cdp-local.ts";
import { ScopeRegistry, ScopeView, scopeOfPath } from "./cloud-cdp-scope.ts";

export { DEFAULT_MAX_LOCAL_BYTES, fromLocalMausUrl, insideRoots, LOCAL_HOST_SUFFIX, mimeOf, toLocalMausUrl, type LocalTarget } from "./cloud-cdp-local.ts";

/** Chrome's own ids start at 1 and climb slowly; the proxy's own commands live far above any a CLI will reach. */
const PROXY_ID_BASE = 2_000_000_000;
/** The error code a refused navigation answers with, so a CLI shows the message instead of a transport failure. */
const REFUSED = -32000;

/** One client's local preview: which folders it may read, and how much of one it may read. */
export interface LocalOptions {
  /** Read per request, so the person can open a new folder without restarting the proxy. */
  roots: () => readonly string[];
  maxBytes?: number;
}

export interface CdpProxyOptions {
  upstream: string;
  port: number;
  host?: string;
  local?: LocalOptions;
  authDomain?: (url: string) => string | null;
  authMessage?: (domain: string) => string;
  pageCap?: { max: number; queueMs?: number; countAll?: boolean };
  lowFpsLive?: boolean;
  onNavigate?: (url: string) => void;
  onAuthBlocked?: (domain: string, url: string) => void;
  onActivity?: () => void;
  /** Starts the upstream Chrome when it may be down (this host's fallback Chrome is started on first use). */
  ensureUpstream?: () => Promise<unknown>;
  log?: (line: string) => void;
  fetchLocal?: (url: string, init: { method: string; headers: Record<string, string>; body?: Buffer }) => Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;
  /** Test seams for the low-frequency view and the page queue; production uses the defaults. */
  timing?: { minShotMs?: number; settleMs?: number; idleShotMs?: number; queuePollMs?: number };
}

interface ResolvedTiming { minShotMs: number; settleMs: number; idleShotMs: number; queuePollMs: number }

interface UpstreamMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
  sessionId?: string;
}

type FetchedLocal = { status: number; headers: Record<string, string>; body: Buffer };

/** A command the proxy issued and is waiting on: its answer, or the reason there will not be one. */
type Waiter = { answer: (message: UpstreamMessage) => void; fail: (reason: Error) => void };

interface SlotWaiter { done: boolean; timer: ReturnType<typeof setInterval>; timeout: ReturnType<typeof setTimeout>; resolve: (granted: boolean) => void }

/** A low-frequency replacement for Page.startScreencast: a still when the page changed, at most one a second. */
class LiveShot {
  readonly #pipe: Pipe;
  readonly #sessionId: string | undefined;
  readonly #format: "png" | "jpeg";
  readonly #timing: ResolvedTiming;
  #stopped = false;
  #busy = false;
  #dirty = true;
  #lastShotAt = 0;
  #lastData: string | null = null;
  #sequence = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #idle: ReturnType<typeof setInterval> | null = null;

  constructor(pipe: Pipe, sessionId: string | undefined, format: "png" | "jpeg", timing: ResolvedTiming) {
    this.#pipe = pipe;
    this.#sessionId = sessionId;
    this.#format = format;
    this.#timing = timing;
  }

  start(): void {
    if (this.#idle) return;
    this.#idle = setInterval(() => this.#shoot("idle"), this.#timing.idleShotMs);
    this.markDirty();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#idle) clearInterval(this.#idle);
    this.#timer = null;
    this.#idle = null;
  }

  /** Something may have changed: take a still shortly, and never faster than the floor allows. */
  markDirty(): void {
    this.#dirty = true;
    this.#schedule(this.#timing.settleMs);
  }

  #schedule(delay: number): void {
    if (this.#stopped || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#shoot("dirty");
    }, delay);
  }

  #shoot(reason: "dirty" | "idle"): void {
    if (this.#stopped || this.#busy) return;
    if (reason === "dirty" && !this.#dirty) return;
    const since = Date.now() - this.#lastShotAt;
    if (since < this.#timing.minShotMs) {
      this.#schedule(this.#timing.minShotMs - since);
      return;
    }
    this.#dirty = false;
    void this.#capture();
  }

  async #capture(): Promise<void> {
    this.#busy = true;
    try {
      const shot = await this.#pipe.call("Page.captureScreenshot", { format: this.#format, quality: 50 }, this.#sessionId);
      const metrics = await this.#pipe.call("Page.getLayoutMetrics", {}, this.#sessionId);
      const shotResult = (shot.result ?? {}) as { data?: unknown };
      const data = shotResult.data;
      // A frontend that draws the same frame twice wastes a round trip and looks like a freeze.
      if (typeof data !== "string" || data === this.#lastData) return;
      this.#lastData = data;
      this.#sequence += 1;
      const view = ((metrics.result ?? {}) as Record<string, Record<string, number>>);
      const visual = view.visualViewport ?? view.layoutViewport ?? {};
      const content = view.contentSize ?? {};
      this.#pipe.sendToClient({
        method: "Page.screencastFrame",
        ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
        params: {
          data,
          sessionId: this.#sequence,
          metadata: {
            offsetTop: 0,
            pageScaleFactor: 1,
            deviceWidth: visual.clientWidth ?? content.width ?? 0,
            deviceHeight: visual.clientHeight ?? content.height ?? 0,
            scrollOffsetX: visual.pageX ?? 0,
            scrollOffsetY: visual.pageY ?? 0,
            timestamp: Date.now() / 1000,
          },
        },
      });
    } catch {
      // The session went away; the pipe's teardown stops this loop.
    } finally {
      this.#busy = false;
      this.#lastShotAt = Date.now();
    }
  }
}

  /** One CLI connection and the one upstream connection it owns: interception, refusal and the live view live here. */
class Pipe {
  readonly #proxy: CdpProxy;
  readonly #client: WebSocket;
  readonly #upstreamUrl: string;
  /** Set when this connection is one session's own view of a shared browser, rather than a CLI's whole browser. */
  readonly #scope: ScopeView | null;
  #upstream: WebSocket | null = null;
  readonly #pending = new Map<number, Waiter>();
  readonly #proxyIds = new Set<number>();
  readonly #proxySessions = new Set<string>();
  readonly #proxyTargets = new Set<string>();
  readonly #intercepted = new Set<string>();
  /** Which target each CLI session is attached to, so a local navigation can attach to that target itself. */
  readonly #sessionTargets = new Map<string, string>();
  /** The proxy's own session per target: one attach and one Fetch.enable each, shared by every navigation. */
  readonly #ownByTarget = new Map<string, string>();
  /** The targets the proxy is attaching to right now: their attach event can arrive before the answer does. */
  readonly #pendingOwns = new Map<string, Promise<string | null>>();
  readonly #shots = new Map<string, LiveShot>();
  #outbox: Frame[] = [];
  #chain: Promise<void> = Promise.resolve();
  #work: Promise<void> = Promise.resolve();
  #nextId = PROXY_ID_BASE;
  #closed = false;

  constructor(proxy: CdpProxy, client: WebSocket, upstreamUrl: string, scope: ScopeView | null) {
    this.#proxy = proxy;
    this.#client = client;
    this.#upstreamUrl = upstreamUrl;
    this.#scope = scope;
    // The scope is held for as long as this connection is, and a little after it goes.
    scope?.join();
    this.#connectUpstream();
  }

  #connectUpstream(): void {
    const upstream = new WebSocket(this.#upstreamUrl);
    this.#upstream = upstream;
    upstream.on("open", () => {
      const waiting = this.#outbox;
      this.#outbox = [];
      for (const data of waiting) upstream.send(asText(data));
    });
    upstream.on("message", (data: RawData) => this.#onUpstreamData(data));
    upstream.on("error", () => this.#closeBoth());
    upstream.on("close", () => this.#closeBoth());
    this.#client.on("message", (data: RawData) => this.#onClientData(data));
    this.#client.on("error", () => this.#closeBoth());
    this.#client.on("close", () => this.#closeBoth());
  }

  /** Every client message is handled in arrival order: one that must prepare something holds the ones behind it. */
  #onClientData(data: RawData): void {
    this.#proxy.activity();
    this.#chain = this.#chain.then(async () => {
      try {
        await this.#handle(data);
      } catch (error) {
        this.#proxy.log(`a client message failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  async #handle(data: RawData): Promise<void> {
    let message: UpstreamMessage;
    try {
      message = JSON.parse(toBuffer(data).toString("utf8")) as UpstreamMessage;
    } catch {
      this.#toUpstreamRaw(data);
      return;
    }
    if (!message || typeof message !== "object" || typeof message.method !== "string") {
      this.#toUpstreamRaw(data);
      return;
    }
    await this.#command(message, data);
  }

  async #command(message: UpstreamMessage, original: RawData): Promise<void> {
    const method = message.method as string;
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
    const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, unknown>;
    const url = typeof params.url === "string" ? params.url : null;
    const key = sessionId ?? "";

    const scope = this.#scope;
    if (scope !== null && sessionId === undefined) {
      if (method === "Target.getTargets") {
        await this.#scopedTargets(scope, message.id);
        return;
      }
      // Two sessions on one browser must not drive each other's page, however one of them learned its id.
      if (method === "Target.attachToTarget" && scope.isForeign(String(params.targetId ?? ""))) {
        this.sendToClient({ ...(message.id === undefined ? {} : { id: message.id }), error: { code: REFUSED, message: "这个页面属于别的会话" } });
        return;
      }
    }

    if (this.#proxy.lowFpsLive) {
      if (method === "Page.screencastFrameAck") {
        this.#reply(message.id, sessionId, {});
        return;
      }
      if (method === "Page.stopScreencast") {
        this.#shots.get(key)?.stop();
        this.#shots.delete(key);
        this.#reply(message.id, sessionId, {});
        return;
      }
      if (method === "Page.startScreencast") {
        this.#startShot(sessionId, params);
        this.#reply(message.id, sessionId, {});
        return;
      }
    }

    const navigates = method === "Page.navigate" || method === "Target.createTarget";
    if (url !== null && navigates) {
      this.#proxy.navigated(url);
      const domain = this.#proxy.blockedDomain(url);
      if (domain !== null) {
        this.#proxy.authBlocked(domain, url);
        this.sendToClient({ ...(message.id === undefined ? {} : { id: message.id }), ...(sessionId === undefined ? {} : { sessionId }), error: { code: REFUSED, message: this.#proxy.authMessage(domain) } });
        return;
      }
      const local = this.#proxy.localAddress(url);
      if (local !== null) {
        if (method === "Page.navigate") await this.#navigateLocal(message.id, sessionId, params, local);
        else await this.#createLocal(message.id, sessionId, params, local);
        return;
      }
      if (method === "Target.createTarget" && !await this.#proxy.acquireSlot()) {
        this.sendToClient({ ...(message.id === undefined ? {} : { id: message.id }), ...(sessionId === undefined ? {} : { sessionId }), error: { code: REFUSED, message: this.#proxy.capMessage() } });
        return;
      }
    }

    if (scope !== null && method === "Target.createTarget" && sessionId === undefined) {
      const answer = await this.#openBlank(scope, params);
      this.sendToClient({ ...(message.id === undefined ? {} : { id: message.id }), ...(answer.error === undefined ? {} : { error: answer.error }), ...(answer.result === undefined ? {} : { result: answer.result }) });
      return;
    }

    this.#toUpstreamRaw(original);
    if (DIRTYING_COMMAND.test(method)) this.#shots.get(key)?.markDirty();
  }

  /** A scoped connection's page list: its own pages, and a blank one of its own when it has none. */
  async #scopedTargets(scope: ScopeView, id: number | undefined): Promise<void> {
    const list = async (): Promise<Array<Record<string, unknown>> | null> => {
      const answer = await this.call("Target.getTargets", {});
      if (answer.error !== undefined) {
        this.sendToClient({ ...(id === undefined ? {} : { id }), error: answer.error });
        return null;
      }
      return scope.filterTargetInfos(targetInfosOf(answer));
    };
    let infos = await list();
    if (infos === null) return;
    if (infos.length === 0) {
      if (!await this.#proxy.acquireSlot()) {
        this.sendToClient({ ...(id === undefined ? {} : { id }), error: { code: REFUSED, message: this.#proxy.capMessage() } });
        return;
      }
      const opened = await this.#openBlank(scope);
      if (opened.error !== undefined) {
        this.sendToClient({ ...(id === undefined ? {} : { id }), error: opened.error });
        return;
      }
      infos = await list();
      if (infos === null) return;
    }
    this.#reply(id, undefined, { targetInfos: infos });
  }

  /** A page of this connection's own (the CLI's createTarget as asked, or a blank one): the event that names it is
   * sorted out before the answer goes back. */
  async #openBlank(scope: ScopeView, params: Record<string, unknown> = {}): Promise<UpstreamMessage> {
    scope.beginCreate();
    const answer = await this.call("Target.createTarget", { ...params, url: typeof params.url === "string" ? params.url : "about:blank" });
    const created = (answer.result ?? {}) as { targetId?: unknown };
    const targetId = typeof created.targetId === "string" ? created.targetId : null;
    // The page's own event reaches the client before the answer that names it, or a CLI would attach too late.
    for (const held of scope.endCreate(targetId)) this.sendToClient(held);
    if (targetId !== null) this.#proxy.createdTarget(targetId);
    return answer;
  }

  /** A local file or port opened in this session: the Fetch domain has to be on before the page asks for anything. */
  async #navigateLocal(id: number | undefined, sessionId: string | undefined, params: Record<string, unknown>, local: string): Promise<void> {
    // A page-level connection owns its target; a browser-level session only borrows one, and Fetch there would let the CLI answer the pauses this proxy has to serve.
    if (sessionId === undefined) await this.#intercept(undefined);
    else {
      let targetId = this.#sessionTargets.get(sessionId);
      if (targetId === undefined) {
        const answer = await this.call("Target.getTargetInfo", {}, sessionId).catch(() => null);
        const asked = ((answer?.result ?? {}) as { targetInfo?: { targetId?: unknown } }).targetInfo?.targetId;
        targetId = typeof asked === "string" ? asked : undefined;
      }
      if (targetId !== undefined) await this.#ownSession(targetId);
    }
    this.#toUpstream({ ...(id === undefined ? {} : { id }), ...(sessionId === undefined ? {} : { sessionId }), method: "Page.navigate", params: { ...params, url: local } });
    this.#shots.get(sessionId ?? "")?.markDirty();
  }

  /** The same, for a new tab: open it blank, attach and intercept, then navigate, and only then answer the CLI. */
  async #createLocal(id: number | undefined, sessionId: string | undefined, params: Record<string, unknown>, local: string): Promise<void> {
    // Held like any other createTarget's page, or the scope would take its own new tab for a stranger's.
    this.#scope?.beginCreate();
    const created = await this.call("Target.createTarget", { ...params, url: "about:blank" });
    const targetId = typeof (created.result as { targetId?: unknown } | undefined)?.targetId === "string"
      ? (created.result as { targetId: string }).targetId
      : null;
    for (const held of this.#scope?.endCreate(targetId) ?? []) this.sendToClient(held);
    if (targetId) {
      this.#proxy.createdTarget(targetId);
      this.#proxyTargets.add(targetId);
      const own = await this.#ownSession(targetId);
      if (own !== null) await this.call("Page.navigate", { url: local }, own);
      this.#shots.get(own ?? "")?.markDirty();
    }
    this.sendToClient({ ...(id === undefined ? {} : { id }), ...(sessionId === undefined ? {} : { sessionId }), result: created.result ?? {} });
  }

  /** The proxy's own session on a target: one attach and one Fetch.enable per target, shared by everyone. */
  #ownSession(targetId: string): Promise<string | null> {
    const own = this.#ownByTarget.get(targetId);
    if (own !== undefined) return Promise.resolve(own);
    const running = this.#pendingOwns.get(targetId);
    if (running) return running;
    const work = this.#attachOwn(targetId);
    this.#pendingOwns.set(targetId, work);
    void work.finally(() => { if (this.#pendingOwns.get(targetId) === work) this.#pendingOwns.delete(targetId); });
    return work;
  }

  async #attachOwn(targetId: string): Promise<string | null> {
    const attached = await this.call("Target.attachToTarget", { targetId, flatten: true }).catch((error: unknown) => {
      this.#proxy.log(`could not attach to the page for a local preview: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    const session = (attached?.result ?? {}) as { sessionId?: unknown };
    if (typeof session.sessionId !== "string") return null;
    this.#proxySessions.add(session.sessionId);
    this.#ownByTarget.set(targetId, session.sessionId);
    // Without the Fetch domain nothing can be served, so the next navigation tries a fresh attach.
    if (!await this.#intercept(session.sessionId)) {
      this.#ownByTarget.delete(targetId);
      return null;
    }
    return session.sessionId;
  }

  /** One Fetch.enable per session, acknowledged before anything navigates through it. */
  async #intercept(sessionId: string | undefined): Promise<boolean> {
    const key = sessionId ?? "";
    if (this.#intercepted.has(key)) return true;
    this.#intercepted.add(key);
    try {
      await this.call("Fetch.enable", { patterns: [{ urlPattern: `http://*.${LOCAL_HOST_SUFFIX}/*` }] }, sessionId);
      return true;
    } catch (error) {
      this.#intercepted.delete(key);
      this.#proxy.log(`could not intercept local pages: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  #startShot(sessionId: string | undefined, params: Record<string, unknown>): void {
    const key = sessionId ?? "";
    this.#shots.get(key)?.stop();
    const shot = new LiveShot(this, sessionId, params.format === "png" ? "png" : "jpeg", this.#proxy.timing);
    this.#shots.set(key, shot);
    shot.start();
  }

  /** A paused local request, read from this machine and answered here. One at a time, so a page's requests are
   * fulfilled in the order they paused instead of whichever file read happened to finish first. */
  answerLocal(request: Record<string, unknown>, sessionId: string | undefined): void {
    this.#work = this.#work.then(async () => {
      try {
        await answerPaused(this.#proxy, request, this, sessionId);
      } catch (error) {
        this.#proxy.log(`a local request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /** A command the proxy issues itself, answered by the upstream and consumed here rather than by the CLI. */
  call(method: string, params: Record<string, unknown>, sessionId?: string): Promise<UpstreamMessage> {
    const id = this.#nextId++;
    this.#proxyIds.add(id);
    return new Promise<UpstreamMessage>((resolve, reject) => {
      if (this.#closed) {
        this.#proxyIds.delete(id);
        reject(new Error("the proxy closed"));
        return;
      }
      // The upstream may still be connecting: the command waits in the outbox and the answer waits here.
      this.#pending.set(id, { answer: resolve, fail: reject });
      this.#toUpstream({ id, ...(sessionId === undefined ? {} : { sessionId }), method, params });
    });
  }

  #onUpstreamData(data: RawData): void {
    let message: UpstreamMessage;
    try {
      message = JSON.parse(toBuffer(data).toString("utf8")) as UpstreamMessage;
    } catch {
      this.#toClientRaw(data);
      return;
    }
    if (!message || typeof message !== "object") {
      this.#toClientRaw(data);
      return;
    }
    if (typeof message.id === "number" && this.#pending.has(message.id)) {
      const waiter = this.#pending.get(message.id) as Waiter;
      this.#pending.delete(message.id);
      this.#proxyIds.delete(message.id);
      waiter.answer(message);
      return;
    }
    // A scoped connection hears about the pages of its own session, and nothing about anybody else's.
    if (this.#scope !== null && message.sessionId === undefined && this.#scope.filterUpstream(message) !== "pass") return;
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
    const hidden = this.#track(message);
    // A local address is answered here wherever it paused (own session, the CLI's, a page connection); others go to the CLI, or are continued on the proxy's own session.
    if (message.method === "Fetch.requestPaused") {
      const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, unknown>;
      // Chrome nests the request (url, method, headers, postData) under params.request, beside the requestId.
      const request = { ...params, ...(params.request && typeof params.request === "object" ? params.request : {}), requestId: params.requestId } as Record<string, unknown>;
      const url = typeof request.url === "string" ? request.url : "";
      if (fromLocalMausUrl(url) !== null) {
        this.answerLocal(request, sessionId);
        return;
      }
      if (this.#proxySessions.has(sessionId ?? "")) {
        void this.call("Fetch.continueRequest", { requestId: String(request.requestId ?? "") }, sessionId).catch(() => {});
        return;
      }
    }
    if (hidden) return;
    this.#toClientRaw(data);
    if (message.method && DIRTYING_EVENT.has(message.method)) this.#shots.get(sessionId ?? "")?.markDirty();
  }

  /** Which target a session is on, and whether a message is the proxy's own business and stays away from the CLI. */
  #track(message: UpstreamMessage): boolean {
    const method = message.method;
    if (typeof method !== "string") return false;
    const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, unknown>;
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
    const targetId = String((params.targetInfo as { targetId?: unknown } | undefined)?.targetId ?? params.targetId ?? "");
    if (method === "Target.attachedToTarget") {
      const attached = String(params.sessionId ?? "");
      // The proxy's own attach, announced before its answer: the CLI never asked for this session.
      if (targetId !== "" && this.#pendingOwns.has(targetId) && !this.#sessionTargets.has(attached)) {
        this.#proxySessions.add(attached);
        return true;
      }
      if (attached !== "" && targetId !== "") this.#sessionTargets.set(attached, targetId);
      return this.#proxySessions.has(attached) || this.#proxyTargets.has(targetId);
    }
    if (method === "Target.detachedFromTarget") {
      // Whether this was the proxy's own is decided before forgetting it, which would hide the answer.
      const own = this.#proxySessions.has(sessionId) || this.#proxyTargets.has(targetId);
      this.#forget(sessionId, "");
      return own;
    }
    if (method === "Target.targetDestroyed") {
      this.#forget("", targetId);
      return false;
    }
    return this.#proxySessions.has(sessionId);
  }

  /** A session or a target going away: the proxy's own attach to it is spent, so a navigation starts over. */
  #forget(sessionId: string, targetId: string): void {
    if (sessionId !== "") {
      this.#sessionTargets.delete(sessionId);
      this.#intercepted.delete(sessionId);
      this.#shots.get(sessionId)?.stop();
      this.#shots.delete(sessionId);
      if (this.#proxySessions.delete(sessionId)) {
        // The attach is spent even when the event did not name the target, or a dead session would be reused.
        for (const [target, own] of this.#ownByTarget) if (own === sessionId) this.#ownByTarget.delete(target);
      }
    }
    const own = targetId === "" ? undefined : this.#ownByTarget.get(targetId);
    if (own === undefined) return;
    this.#ownByTarget.delete(targetId);
    this.#proxySessions.delete(own);
    this.#intercepted.delete(own);
  }

  #reply(id: number | undefined, sessionId: string | undefined, result: unknown): void {
    this.sendToClient({ ...(id === undefined ? {} : { id }), ...(sessionId === undefined ? {} : { sessionId }), result });
  }

  sendToClient(message: Record<string, unknown>): void {
    if (this.#closed || this.#client.readyState !== WebSocket.OPEN) return;
    this.#client.send(JSON.stringify(message));
  }

  #toClientRaw(data: Frame): void {
    if (this.#closed || this.#client.readyState !== WebSocket.OPEN) return;
    this.#client.send(asText(data));
  }

  #toUpstream(message: Record<string, unknown>): void {
    this.#toUpstreamRaw(JSON.stringify(message));
  }

  #toUpstreamRaw(data: Frame): void {
    if (this.#closed || !this.#upstream || this.#upstream.readyState !== WebSocket.OPEN) {
      this.#outbox.push(data);
      return;
    }
    this.#upstream.send(asText(data));
  }

  /** One end going away takes the other with it; an unreachable upstream tells the CLI with 1011. */
  #closeBoth(): void {
    this.close(1011);
  }

  close(code = 1000): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#scope?.leave();
    for (const shot of this.#shots.values()) shot.stop();
    this.#shots.clear();
    for (const waiter of this.#pending.values()) waiter.fail(new Error("the proxy closed"));
    this.#pending.clear();
    this.#proxyIds.clear();
    this.#upstream?.close();
    this.#client.close(code);
  }
}

/** A paused local request, read from this machine and answered as if the cloud browser had asked directly. */
async function answerPaused(proxy: CdpProxy, request: Record<string, unknown>, pipe: Pipe, sessionId: string | undefined): Promise<void> {
  const requestId = String(request.requestId ?? "");
  const url = typeof request.url === "string" ? request.url : "";
  const target = fromLocalMausUrl(url);
  // A flattened session only accepts an answer on the session the request paused on, so it travels along.
  const fulfill = (status: number, headers: Array<{ name: string; value: string }>, body: Buffer): void => {
    // A page closed mid-answer rejects; an unhandled rejection would take the whole server down.
    void pipe.call("Fetch.fulfillRequest", { requestId, responseCode: status, responseHeaders: headers, body: body.toString("base64") }, sessionId).catch(() => {});
  };
  const fail = (status: number, reason: string): void => {
    fulfill(status, [{ name: "content-type", value: "text/plain; charset=utf-8" }, { name: "cache-control", value: "no-store" }], Buffer.from(`${reason}\n`, "utf8"));
  };
  if (!target) {
    // Not a local address: the page asked for something real, so let it through untouched.
    void pipe.call("Fetch.continueRequest", { requestId }, sessionId).catch(() => {});
    return;
  }
  if (target.kind === "http") {
    const headers: Record<string, string> = {};
    const source = (request.headers && typeof request.headers === "object" ? request.headers : {}) as Record<string, unknown>;
    for (const [name, value] of Object.entries(source)) {
      const lower = name.toLowerCase();
      if (lower === "host" || lower === "accept-encoding" || lower === "content-length") continue;
      headers[lower] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    let body: Buffer | undefined;
    if (typeof request.postData === "string") body = Buffer.from(request.postData, "base64");
    else if (Array.isArray(request.postDataEntries)) {
      body = Buffer.concat(request.postDataEntries.map((entry) => Buffer.from(String((entry as { bytes?: unknown }).bytes ?? ""), "base64")));
    }
    let fetched: FetchedLocal;
    try {
      fetched = await proxy.fetchLocal(target.url, { method: typeof request.method === "string" ? request.method : "GET", headers, body });
    } catch {
      fail(502, "本机服务没有响应，预览失败");
      return;
    }
    if (fetched.body.length > proxy.maxLocalBytes) {
      fail(413, `本机服务响应超过 ${Math.round(proxy.maxLocalBytes / 1024 / 1024)}MB，云端预览不加载`);
      return;
    }
    fulfill(fetched.status, Object.entries(fetched.headers)
      .filter(([name]) => !["content-encoding", "content-length", "transfer-encoding"].includes(name.toLowerCase()))
      .map(([name, value]) => ({ name, value: String(value) })), fetched.body);
    return;
  }
  const path = resolve(target.path);
  if (!insideRoots(path, proxy.localRoots())) {
    fail(403, "该路径不在允许预览的目录内");
    return;
  }
  let file = path;
  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    file = resolve(file, "index.html");
    info = await stat(file).catch(() => null);
  }
  if (!info || !info.isFile()) {
    fail(404, "没有这个本机文件");
    return;
  }
  if (info.size > proxy.maxLocalBytes) {
    proxy.log(`本机文件 ${file} 超过 ${Math.round(proxy.maxLocalBytes / 1024 / 1024)}MB，云端预览不加载`);
    fail(413, `本机文件超过 ${Math.round(proxy.maxLocalBytes / 1024 / 1024)}MB，云端预览不加载`);
    return;
  }
  const body = await readFile(file);
  fulfill(200, [
    { name: "content-type", value: mimeOf(file) },
    { name: "cache-control", value: "no-store" },
    { name: "access-control-allow-origin", value: "*" },
  ], body);
}

/** The local stand-in for Chrome's DevTools endpoint: transparent to a CLI, guarded for the cloud browser. */
export class CdpProxy {
  readonly #options: CdpProxyOptions;
  readonly #upstreamBase: URL;
  readonly #timing: ResolvedTiming;
  readonly #server: Server;
  readonly #wss: WebSocketServer;
  readonly #pipes = new Set<Pipe>();
  readonly #created = new Set<string>();
  readonly #scopes = new ScopeRegistry({ closeTarget: (targetId) => this.#closeTarget(targetId), log: (line) => this.log(line) });
  readonly #slots: SlotWaiter[] = [];
  #port: number;
  #closed = false;

  constructor(options: CdpProxyOptions) {
    this.#options = options;
    this.#upstreamBase = new URL(options.upstream);
    this.#port = options.port;
    const timing = options.timing ?? {};
    this.#timing = {
      minShotMs: timing.minShotMs ?? 1000,
      settleMs: timing.settleMs ?? 300,
      idleShotMs: timing.idleShotMs ?? 5000,
      queuePollMs: timing.queuePollMs ?? 1000,
    };
    this.#server = createServer((req, res) => this.#http(req, res));
    this.#wss = new WebSocketServer({ noServer: true });
    this.#server.on("upgrade", (req, socket, head) => {
      if (!(req.url ?? "").startsWith("/devtools/")) {
        socket.destroy();
        return;
      }
      this.activity();
      // An upstream that stops answering mid-upgrade must not become an unhandled rejection that takes the server down.
      void this.#ensureUpstream().then(() => this.#upgrade(req, socket, head, req.url ?? "/")).catch(() => socket.destroy());
    });
  }

  /** A scoped connection talks to the browser itself, so that its own pages are the only ones it can reach. */
  async #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, path: string): Promise<void> {
    const scope = scopeOfPath(path);
    let upstreamUrl = this.#webSocketUrl(path);
    let view: ScopeView | null = null;
    if (scope !== null) {
      const browserUrl = await this.#browserUrl();
      // A scope only exists behind a browser-level address, so without one there is nothing to give it.
      if (browserUrl === null) {
        this.log(`the upstream Chrome named no browser-level DevTools address, so scope ${scope} was refused`);
        socket.destroy();
        return;
      }
      upstreamUrl = browserUrl;
      view = new ScopeView(scope, this.#scopes);
    }
    this.#wss.handleUpgrade(req, socket, head, (client) => {
      const pipe = new Pipe(this, client, upstreamUrl, view);
      this.#pipes.add(pipe);
      client.on("close", () => this.#pipes.delete(pipe));
    });
  }

  /** The same path on the upstream Chrome, so a browser endpoint and a page endpoint both keep working. */
  #webSocketUrl(path: string): string {
    const scheme = this.#upstreamBase.protocol === "https:" ? "wss:" : "ws:";
    return `${scheme}//${this.#upstreamBase.host}${path}`;
  }

  /** The upstream Chrome's own browser-level address, which is the only one a scoped connection may be sent to. */
  async #browserUrl(): Promise<string | null> {
    const version = await this.#upstreamJson("/json/version") as { webSocketDebuggerUrl?: unknown } | null;
    try {
      const named = version?.webSocketDebuggerUrl;
      return typeof named === "string" ? this.#webSocketUrl(new URL(named).pathname) : null;
    } catch {
      return null;
    }
  }

  /** A page of a scope that went away, closed on the upstream Chrome itself. */
  async #closeTarget(targetId: string): Promise<void> {
    // Chrome answers /json/close with plain text, not JSON.
    this.#created.delete(targetId);
    await fetch(new URL(`/json/close/${encodeURIComponent(targetId)}`, this.#upstreamBase), { headers: { host: this.#upstreamBase.host } });
  }

  async #ensureUpstream(): Promise<void> {
    try {
      await this.#options.ensureUpstream?.();
    } catch (error) {
      this.log(`上游 Chrome 没起来：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  get url(): string {
    return `http://${this.#options.host ?? "127.0.0.1"}:${this.#port}`;
  }

  get timing(): ResolvedTiming {
    return this.#timing;
  }

  get lowFpsLive(): boolean {
    return this.#options.lowFpsLive === true;
  }

  get maxLocalBytes(): number {
    return this.#options.local?.maxBytes ?? DEFAULT_MAX_LOCAL_BYTES;
  }

  connections(): number {
    return this.#pipes.size;
  }

  localRoots(): readonly string[] {
    return this.#options.local?.roots() ?? [];
  }

  log(line: string): void {
    this.#options.log?.(line);
  }

  activity(): void {
    this.#options.onActivity?.();
  }

  navigated(url: string): void {
    this.#options.onNavigate?.(url);
  }

  authBlocked(domain: string, url: string): void {
    this.#options.onAuthBlocked?.(domain, url);
  }

  blockedDomain(url: string): string | null {
    return this.#options.authDomain?.(url) ?? null;
  }

  authMessage(domain: string): string {
    return this.#options.authMessage?.(domain)
      ?? `OpenMausBot：${domain} 需要登录，云端浏览器没有登录态。请改用本机共享浏览器 mychrome（已登录）。`;
  }

  capMessage(): string {
    const max = this.#options.pageCap?.max ?? 0;
    return `这个浏览器同时最多 ${max} 个页面，请先关掉不用的标签（Target.closeTarget）再开`;
  }

  /** A local address only exists when the person turned local preview on; a browser on this machine needs no rewriting. */
  localAddress(url: string): string | null {
    return this.#options.local ? toLocalMausUrl(url) : null;
  }

  createdTarget(targetId: string): void {
    this.#created.add(targetId);
  }

  async #upstreamJson(path: string): Promise<unknown> {
    const response = await fetch(new URL(path, this.#upstreamBase), { headers: { host: this.#upstreamBase.host, "accept-encoding": "identity" } });
    return response.status === 200 ? await response.json() : null;
  }

  async #pageCount(countAll: boolean): Promise<number> {
    const list = await this.#upstreamJson("/json/list");
    const pages = (Array.isArray(list) ? list : []).filter((target) => (target as { type?: unknown }).type === "page");
    if (countAll) return pages.length;
    return pages.filter((target) => this.#created.has(String((target as { id?: unknown }).id))).length;
  }

  /** Wait for a free page slot, first come first served, or give up after the queue's patience runs out. */
  async acquireSlot(): Promise<boolean> {
    const cap = this.#options.pageCap;
    if (!cap) return true;
    const countAll = cap.countAll === true;
    if (await this.#pageCount(countAll) < cap.max) return true;
    this.log(`页面数已达上限 ${cap.max}，新的页面排队中`);
    const queueMs = cap.queueMs ?? 60_000;
    return await new Promise<boolean>((resolve) => {
      const waiter: SlotWaiter = {
        done: false,
        timer: setInterval(() => void this.#drainSlots(cap.max, countAll), this.#timing.queuePollMs),
        timeout: setTimeout(() => {
          if (waiter.done) return;
          waiter.done = true;
          clearInterval(waiter.timer);
          const at = this.#slots.indexOf(waiter);
          if (at !== -1) this.#slots.splice(at, 1);
          resolve(false);
        }, queueMs),
        resolve: (granted: boolean) => {
          if (waiter.done) return;
          waiter.done = true;
          clearTimeout(waiter.timeout);
          resolve(granted);
        },
      };
      this.#slots.push(waiter);
    });
  }

  async #drainSlots(max: number, countAll: boolean): Promise<void> {
    while (this.#slots.length > 0 && await this.#pageCount(countAll) < max) {
      const waiter = this.#slots.shift();
      clearInterval(waiter?.timer);
      waiter?.resolve(true);
    }
  }

  async fetchLocal(url: string, init: { method: string; headers: Record<string, string>; body?: Buffer }): Promise<FetchedLocal> {
    if (this.#options.fetchLocal) return await this.#options.fetchLocal(url, init);
    const response = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: Buffer.from(await response.arrayBuffer()) };
  }

  async #http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.activity();
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (!path.startsWith("/json")) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("This is the local CDP proxy; Chrome's endpoints are under /json.\n");
      return;
    }
    const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
    await this.#ensureUpstream();
    try {
      if (path === "/json/new") {
        const url = query.get("url") ?? "";
        if (this.localAddress(url) !== null) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end("请用 CDP Target.createTarget 打开本机页面\n");
          return;
        }
        const domain = this.blockedDomain(url);
        if (domain !== null) {
          this.authBlocked(domain, url);
          res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          res.end(`${this.authMessage(domain)}\n`);
          return;
        }
      }
      const target = new URL(`${path}${new URL(req.url ?? "/", "http://127.0.0.1").search}`, this.#upstreamBase);
      const headers: Record<string, string> = { host: this.#upstreamBase.host, "accept-encoding": "identity" };
      for (const [name, value] of Object.entries(req.headers)) {
        const lower = name.toLowerCase();
        if (lower === "host" || lower === "accept-encoding") continue;
        headers[lower] = Array.isArray(value) ? value.join(", ") : String(value);
      }
      const response = await fetch(target, { method: req.method, headers });
      const body = rewriteEndpointBody(await response.text(), this.#port);
      const sent: Record<string, string> = { "content-type": response.headers.get("content-type") ?? "application/json" };
      res.writeHead(response.status, sent);
      res.end(body);
    } catch {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("上游 Chrome 没有响应\n");
    }
  }

  async start(): Promise<number> {
    await new Promise<void>((resolvePromise, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.#port, this.#options.host ?? "127.0.0.1", () => {
        this.#server.removeListener("error", reject);
        resolvePromise();
      });
    });
    const address = this.#server.address();
    if (address && typeof address === "object") this.#port = address.port;
    return this.#port;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#scopes.close();
    for (const waiter of this.#slots) {
      waiter.done = true;
      clearInterval(waiter.timer);
      clearTimeout(waiter.timeout);
    }
    this.#slots.length = 0;
    for (const pipe of Array.from(this.#pipes)) pipe.close();
    this.#pipes.clear();
    this.#server.closeAllConnections?.();
    await new Promise<void>((resolvePromise) => this.#server.close(() => resolvePromise()));
  }
}
