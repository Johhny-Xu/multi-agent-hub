/**
 * hub-compat: a stdlib-only HTTP MCP endpoint that preserves the legacy
 * AgentHub (agent_hub.py) contract on 8765 while delegating work to the 8801
 * workbench. The plugin bridge (mcp/hub.mjs) is unchanged, so every response
 * shape, status code and receipt line matters here.
 */
import { timingSafeEqual } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

import { HubStore, createLocalTools, resolveStateDir, type JsonObject } from "./store.ts";
import { hubEventLog, redactEventText, type HubEvent } from "./events.ts";

export const SERVER_NAME = "agent-hub";
export const SERVER_VERSION = "1.3.0-compat";
export const PROTOCOL_VERSION_DEFAULT = "2024-11-05";
export const DISCOVERY_PORT = 18766;
const DISCOVERY_SERVICE = "agenthub-discovery";
const DISCOVERY_VERSION = 1;
const MAX_DATAGRAM = 1024;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DISCOVERY_RATE = 64;

export type ToolHandler = (args: JsonObject, context?: ToolCallContext) => string | Promise<string>;

/** What a long tool may say while it waits; only reaches clients that opened a progress channel. */
export interface ToolCallContext {
  progress(message: string): void;
  /** The thread that asked for this dispatch, when the client sent one. */
  originThreadId?: string;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface HubCompatOptions {
  port?: number;
  host?: string;
  stateDir?: string;
  /** Bearer token; defaults to HUB_TOKEN. A non-loopback bind requires one. */
  token?: string;
  /** false disables UDP discovery; defaults to AGENTHUB_DISCOVERY. */
  discovery?: boolean;
  discoveryPort?: number;
  /** Workbench base URL; defaults to HUB_OM_BASE or http://127.0.0.1:8801. */
  omBase?: string;
  /** Test seam: bypass loading dispatch.ts. */
  dispatchTools?: Record<string, ToolHandler>;
}

export interface RunningHub {
  port: number;
  host: string;
  stateDir: string;
  discoveryPort: number | null;
  authRequired: boolean;
  server: Server;
  close(): Promise<void>;
}

/** Tools implemented by the dispatch module (server/hub-compat/dispatch.ts). */
export const DISPATCH_TOOL_NAMES = [
  "hub_dispatch_cli",
  "hub_wait_result",
  "hub_result",
  "hub_result_json",
  "hub_task_status",
  "hub_events",
  "hub_list_agents",
  "hub_capabilities",
  "hub_list_models",
  "hub_set_agent_status",
  "hub_login",
  "zcode_delegate",
  "zcode_result",
  "trae_delegate",
  "trae_result",
  "trae_status",
  "trae_new_chat",
] as const;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1"
    || normalized.startsWith("127.");
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized.startsWith("127.") || normalized.startsWith("::ffff:127.");
}

function discoveryDisabledByEnv(): boolean {
  return ["0", "false", "off"].includes((process.env.AGENTHUB_DISCOVERY ?? "1").trim().toLowerCase());
}

/** Legacy discovery name: first hostname label, portable characters, max 63. */
function discoveryName(raw: string): string {
  const first = raw.split(".", 1)[0] ?? "";
  return first.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 63) || "Hub";
}

function loadContract(): { tools: ToolDefinition[] } {
  const raw = readFileSync(new URL("./contract.json", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed) || !Array.isArray(parsed.tools)) {
    throw new Error("contract.json 缺少 tools 数组");
  }
  return { tools: parsed.tools as ToolDefinition[] };
}

let dispatchWarningShown = false;

/**
 * The dispatch module is written by a separate worker and may not exist yet.
 * Loading it lazily keeps the HTTP/JSON-RPC contract testable on its own; a
 * missing module fails loudly per call instead of silently answering "ok".
 */
async function loadDispatchTools(omBase: string, stateDir: string): Promise<Record<string, ToolHandler>> {
  try {
    const moduleUrl = new URL("./dispatch.ts", import.meta.url).href;
    const loaded = (await import(/* @vite-ignore */ moduleUrl)) as {
      createDispatchTools?: (opts: { omBase: string; stateDir: string }) => unknown;
    };
    if (typeof loaded.createDispatchTools === "function") {
      const built = await loaded.createDispatchTools({ omBase, stateDir });
      if (isPlainObject(built)) return built as Record<string, ToolHandler>;
    }
  } catch (error) {
    if (!dispatchWarningShown) {
      dispatchWarningShown = true;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[agent-hub] dispatch 模块加载失败: ${message}\n`);
    }
  }
  const missing = async (): Promise<string> => {
    throw new Error("dispatch 模块未就绪 (server/hub-compat/dispatch.ts)");
  };
  return Object.fromEntries(DISPATCH_TOOL_NAMES.map((name) => [name, missing]));
}

function jsonRpcOk(id: unknown, result: unknown): JsonObject {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: unknown, code: number, message: string): JsonObject {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function validRequestId(id: unknown): boolean {
  if (typeof id === "boolean") return false;
  if (id === null || id === undefined) return true;
  if (typeof id === "string") return true;
  if (typeof id === "number") return Number.isFinite(id);
  return false;
}

interface RpcContext {
  tools: ToolDefinition[];
  allowed: Set<string>;
  handlers: Map<string, ToolHandler>;
}

/** Where a tool call's side messages go: one SSE channel per MCP session, when the client opened one. */
interface RpcTransport {
  sessionId: string;
  notify: (frame: JsonObject) => void;
  /** The thread that asked for this dispatch, taken from the request header. */
  originThreadId?: string;
}

async function callToolHandler(
  context: RpcContext,
  name: string,
  args: JsonObject,
  callContext?: ToolCallContext,
): Promise<JsonObject> {
  const handler = context.handlers.get(name);
  if (!context.allowed.has(name) || !handler) return jsonRpcError(undefined, -32602, `Unknown tool: ${name}`);
  try {
    const value = await handler(args, callContext);
    return jsonRpcOk(undefined, { content: [{ type: "text", text: String(value) }], isError: false });
  } catch (error) {
    const structured = publicErrorPayload(error);
    if (structured) {
      return jsonRpcOk(undefined, {
        content: [{ type: "text", text: JSON.stringify(structured) }],
        isError: true,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return jsonRpcOk(undefined, {
      content: [{ type: "text", text: `工具执行出错: ${message}` }],
      isError: true,
    });
  }
}

/** Legacy `to_public()`: structured dispatch refusals keep their error_code. */
function publicErrorPayload(error: unknown): JsonObject | null {
  const candidate = error as { toPublic?: unknown; to_public?: unknown } | null;
  for (const method of [candidate?.toPublic, candidate?.to_public]) {
    if (typeof method !== "function") continue;
    try {
      const payload = method.call(error);
      if (isPlainObject(payload) && typeof payload.error_code === "string") return payload;
    } catch {
      return null;
    }
  }
  return null;
}

async function handleSingle(request: unknown, context: RpcContext, transport: RpcTransport): Promise<JsonObject | null> {
  const record = isPlainObject(request) ? request : null;
  const id = record?.id ?? null;
  if (!record || record.jsonrpc !== "2.0" || typeof record.method !== "string" || !validRequestId(record.id)) {
    return jsonRpcError(null, -32600, "Invalid Request");
  }
  // A notification must never execute a tool with side effects.
  if (!Object.hasOwn(record, "id")) return null;

  const params = Object.hasOwn(record, "params") ? record.params : {};
  if (!isPlainObject(params)) return jsonRpcError(id, -32602, "params must be an object");

  const method = record.method;
  if (method === "initialize") {
    return jsonRpcOk(id, {
      protocolVersion: params.protocolVersion || PROTOCOL_VERSION_DEFAULT,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === "ping") return jsonRpcOk(id, {});
  if (method === "tools/list") return jsonRpcOk(id, { tools: context.tools });
  if (method === "tools/call") {
    const toolName = params.name;
    const args = Object.hasOwn(params, "arguments") ? params.arguments : {};
    if (typeof toolName !== "string" || !isPlainObject(args)) {
      return jsonRpcError(id, -32602, "tool name must be a string and arguments must be an object");
    }
    const meta = isPlainObject(params._meta) ? params._meta : {};
    const token = meta.progressToken;
    const wantsProgress = typeof token === "string" || (typeof token === "number" && Number.isFinite(token));
    let sent = 0;
    const callContext: ToolCallContext = {
      originThreadId: transport.originThreadId,
      progress: (message: string) => {
        if (!wantsProgress) return;
        sent += 1;
        transport.notify({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: token, progress: sent, message: redactEventText(message) },
        });
      },
    };
    const reply = await callToolHandler(context, toolName, args, callContext);
    return { ...reply, id };
  }
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

async function handleRequest(request: unknown, context: RpcContext, transport: RpcTransport): Promise<unknown | null> {
  if (Array.isArray(request)) {
    if (!request.length) return jsonRpcError(null, -32600, "Invalid Request");
    const replies: JsonObject[] = [];
    for (const item of request) {
      const reply = await handleSingle(item, context, transport);
      if (reply) replies.push(reply);
    }
    return replies.length ? replies : null;
  }
  return handleSingle(request, context, transport);
}

function applyCors(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id");
  response.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
}

function send(response: ServerResponse, status: number, body?: string | Buffer, headers: Record<string, string> = {}): void {
  applyCors(response);
  const payload = body === undefined ? null : typeof body === "string" ? Buffer.from(body, "utf8") : body;
  response.setHeader("Content-Length", String(payload ? payload.length : 0));
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
  response.statusCode = status;
  response.end(payload ?? undefined);
}

/** Read at most `limit` bytes; null means the client sent more than allowed. */
async function readBody(request: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseBody(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch (utf8Error) {
    // Windows clients sometimes send GBK-encoded Chinese; legacy hub fell back too.
    try {
      return JSON.parse(new TextDecoder("gbk").decode(raw));
    } catch {
      throw utf8Error;
    }
  }
}

function requestPath(request: IncomingMessage): string {
  const raw = request.url ?? "/";
  const query = raw.indexOf("?");
  return query === -1 ? raw : raw.slice(0, query);
}

function suppliedToken(request: IncomingMessage): string {
  const auth = request.headers.authorization ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const raw = request.url ?? "";
  const query = raw.indexOf("?");
  if (query === -1) return "";
  const params = new URLSearchParams(raw.slice(query + 1));
  return params.get("token") ?? "";
}

interface ServerContext {
  token: string;
  rpc: RpcContext;
  stateDir: string;
  /** One SSE notification channel per MCP session (`Mcp-Session-Id`). */
  channels: Map<string, Set<ServerResponse>>;
}

/** Legacy compare_digest: same length, constant-time comparison. */
function tokenMatches(supplied: string, expected: string): boolean {
  const left = Buffer.from(supplied, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function refuseUnauthorized(request: IncomingMessage, response: ServerResponse): void {
  process.stderr.write(`[agent-hub.http] 401 unauthorized from ${request.socket.remoteAddress ?? "?"}\n`);
  request.resume();
  send(response, 401, '{"error":"unauthorized"}', {
    "WWW-Authenticate": 'Bearer realm="agent-hub"',
    "Content-Type": "application/json; charset=utf-8",
    Connection: "close",
  });
}

const SSE_MAX_MS = 55_000;

function openSse(response: ServerResponse): void {
  applyCors(response);
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(": connected\n\n");
}

/** A long tool's `notifications/progress`, on the session's own stream. Nothing is sent when it has none. */
function sendToSession(context: ServerContext, sessionId: string, frame: unknown): void {
  const streams = context.channels.get(sessionId);
  if (!streams?.size) return;
  const frameText = `event: message\ndata: ${JSON.stringify(frame)}\n\n`;
  for (const stream of streams) {
    try {
      stream.write(frameText);
    } catch {
      /* the close handler removes it */
    }
  }
}

/**
 * GET /mcp with Accept: text/event-stream. This is the channel `notifications/progress`
 * travels on; a client that only POSTs keeps working exactly as before.
 */
function openNotificationStream(request: IncomingMessage, response: ServerResponse, context: ServerContext): void {
  const sessionId = String(request.headers["mcp-session-id"] ?? "").trim() || "default";
  openSse(response);
  const streams = context.channels.get(sessionId) ?? new Set<ServerResponse>();
  streams.add(response);
  context.channels.set(sessionId, streams);
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    streams.delete(response);
    if (!streams.size && context.channels.get(sessionId) === streams) context.channels.delete(sessionId);
    if (!response.writableEnded) response.end();
  };
  timer = setInterval(() => {
    try {
      response.write(": ping\n\n");
    } catch {
      close();
    }
  }, 20_000);
  timer.unref();
  response.on("close", close);
  response.on("error", close);
}

/**
 * GET /api/hub/tasks/:ref/events — the task's events from `since` (query) or
 * `Last-Event-ID` on, then live ones until a terminal event, the client leaves, or 55s.
 * Authentication is the same HUB_TOKEN as /mcp, accepted via Authorization or ?token=.
 */
function openTaskEventStream(request: IncomingMessage, response: ServerResponse, context: ServerContext, ref: string): void {
  const log = hubEventLog(context.stateDir);
  const url = new URL(request.url ?? "/", "http://localhost");
  const headerSince = Number(request.headers["last-event-id"] ?? "");
  const querySince = Number(url.searchParams.get("since") ?? "");
  let cursor = Math.max(Number.isFinite(headerSince) ? headerSince : 0, Number.isFinite(querySince) ? querySince : 0);
  openSse(response);
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  let unsubscribe: () => void = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    unsubscribe();
    if (!response.writableEnded) response.end();
  };
  const push = (event: HubEvent) => {
    if (closed || event.seq <= cursor) return;
    cursor = event.seq;
    try {
      response.write(`id: ${event.seq}\nevent: hub\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      close();
      return;
    }
    if (event.kind === "done" || event.kind === "error" || event.kind === "timeout") {
      // The client keeps the last line; the stream itself should not stay open forever.
      setTimeout(() => {
        if (!closed) {
          try {
            response.write(`event: end\ndata: ${JSON.stringify({ ref: event.ref })}\n\n`);
          } catch {
            /* the close handler ends it */
          }
        }
        close();
      }, 120);
    }
  };
  for (const event of log.list(ref, cursor, 500)) push(event);
  if (closed) return;
  unsubscribe = log.subscribe(ref, push);
  timer = setInterval(() => {
    try {
      response.write(": ping\n\n");
    } catch {
      close();
    }
  }, 15_000);
  timer.unref();
  setTimeout(close, SSE_MAX_MS).unref();
  response.on("close", close);
  response.on("error", close);
}

/** The thread that asked for this dispatch. Only a thread id is accepted; anything else is no thread. */
function originThreadIdOf(request: IncomingMessage): string | undefined {
  const raw = request.headers["x-hub-origin-thread"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const thread = String(value ?? "").trim();
  return /^[\w-]{1,64}$/.test(thread) ? thread : undefined;
}

async function handleHttp(request: IncomingMessage, response: ServerResponse, context: ServerContext): Promise<void> {
  const method = request.method ?? "GET";

  if (method === "OPTIONS") {
    send(response, 204);
    return;
  }

  if (method === "GET") {
    const path = requestPath(request).replace(/\/+$/, "");
    if (path === "/health") {
      send(response, 200, JSON.stringify({
        service: SERVER_NAME,
        status: "ok",
        version: SERVER_VERSION,
        auth_required: Boolean(context.token),
      }), { "Content-Type": "application/json" });
      return;
    }
    if (path === "/mcp" && String(request.headers.accept ?? "").includes("text/event-stream")) {
      if (context.token && !tokenMatches(suppliedToken(request), context.token)) {
        refuseUnauthorized(request, response);
        return;
      }
      openNotificationStream(request, response, context);
      return;
    }
    const taskEvents = /^\/api\/hub\/tasks\/([^/]+)\/events$/.exec(path);
    if (taskEvents) {
      if (context.token && !tokenMatches(suppliedToken(request), context.token)) {
        refuseUnauthorized(request, response);
        return;
      }
      let ref: string;
      try {
        ref = decodeURIComponent(taskEvents[1]!);
      } catch {
        send(response, 400, undefined, { Connection: "close" });
        return;
      }
      if (!/^[A-Za-z0-9._-]{1,160}$/.test(ref)) {
        send(response, 400, undefined, { Connection: "close" });
        return;
      }
      openTaskEventStream(request, response, context, ref);
      return;
    }
    send(response, 405);
    return;
  }

  if (method !== "POST") {
    send(response, 405);
    return;
  }

  const path = requestPath(request).replace(/\/+$/, "");
  if (path !== "/mcp") {
    send(response, 404, "Only /mcp is served", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  if (context.token && !tokenMatches(suppliedToken(request), context.token)) {
    refuseUnauthorized(request, response);
    return;
  }

  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0) {
      request.resume();
      send(response, 400, undefined, { Connection: "close" });
      return;
    }
    if (length > MAX_BODY_BYTES) {
      request.resume();
      send(response, 413, undefined, { Connection: "close" });
      return;
    }
  }

  let raw: Buffer | null;
  try {
    raw = await readBody(request, MAX_BODY_BYTES);
  } catch {
    send(response, 400, undefined, { Connection: "close" });
    return;
  }
  if (raw === null) {
    send(response, 413, undefined, { Connection: "close" });
    return;
  }

  let payload: unknown;
  try {
    payload = parseBody(raw);
  } catch {
    send(response, 400, undefined, { Connection: "close" });
    return;
  }

  const sessionId = String(request.headers["mcp-session-id"] ?? "").trim() || "default";
  const transport: RpcTransport = {
    sessionId,
    originThreadId: originThreadIdOf(request),
    notify: (frame) => sendToSession(context, sessionId, frame),
  };
  const reply = await handleRequest(payload, context.rpc, transport);
  if (reply === null) {
    send(response, 202);
    return;
  }
  send(response, 200, JSON.stringify(reply), { "Content-Type": "application/json; charset=utf-8" });
}

interface DiscoveryOptions {
  address: string;
  httpPort: number;
  authRequired: boolean;
  port: number;
  name: string;
  loopback: boolean;
}

interface DiscoveryHandle {
  port: number;
  close(): void;
}

function discoveryReply(packet: Buffer, options: DiscoveryOptions): Buffer | null {
  if (packet.length > MAX_DATAGRAM) return null;
  let request: unknown;
  try {
    request = JSON.parse(packet.toString("utf8"));
  } catch {
    return null;
  }
  if (!isPlainObject(request) || request.service !== DISCOVERY_SERVICE) return null;
  if (typeof request.version !== "number" || !Number.isInteger(request.version) || request.version !== DISCOVERY_VERSION) {
    return null;
  }
  if (typeof request.nonce !== "string" || !/^[0-9a-fA-F]{32}$/.test(request.nonce)) return null;
  return Buffer.from(JSON.stringify({
    service: DISCOVERY_SERVICE,
    version: DISCOVERY_VERSION,
    nonce: request.nonce,
    port: options.httpPort,
    path: "/mcp",
    name: options.name,
    auth_required: options.authRequired,
  }), "utf8");
}

/** UDP discovery is optional: a bind failure must never stop the HTTP server. */
async function startDiscovery(options: DiscoveryOptions): Promise<DiscoveryHandle | null> {
  const socket: Socket = createSocket("udp4");
  let windowStart = Date.now();
  let windowCount = 0;

  socket.on("message", (packet: Buffer, source: RemoteInfo) => {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      windowCount = 0;
    }
    windowCount += 1;
    if (windowCount > DISCOVERY_RATE) return;
    if (options.loopback && !isLoopbackAddress(source.address)) return;
    const reply = discoveryReply(packet, options);
    if (!reply) return;
    socket.send(reply, source.port, source.address, () => {});
  });

  try {
    await new Promise<void>((done, fail) => {
      const onError = (error: Error): void => {
        socket.off("error", onError);
        fail(error);
      };
      socket.once("error", onError);
      socket.bind({ port: options.port, address: options.address, exclusive: true }, () => {
        socket.off("error", onError);
        done();
      });
    });
  } catch {
    socket.close();
    process.stderr.write("[agent-hub.discovery] UDP discovery unavailable; HTTP remains enabled.\n");
    return null;
  }

  socket.on("error", () => {});
  const address = socket.address();
  return {
    port: typeof address === "object" && address ? address.port : options.port,
    close: () => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/**
 * Start the compat endpoint. Everything is resolved here rather than at module
 * load so tests can point at a throwaway state directory and random ports.
 */
export async function startHubCompat(options: HubCompatOptions = {}): Promise<RunningHub> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8765;
  const token = (options.token ?? process.env.HUB_TOKEN ?? "").trim();
  if (!isLoopbackHost(host) && !token) {
    throw new Error("拒绝启动: 非回环监听必须设置 HUB_TOKEN 环境变量 (防裸奔)");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`端口无效: ${String(port)}`);
  }

  const stateDir = options.stateDir ?? resolveStateDir();
  await mkdir(stateDir, { recursive: true });
  const store = new HubStore({ stateDir });

  const { tools } = loadContract();
  const handlers = new Map<string, ToolHandler>(Object.entries(createLocalTools(store)));
  const dispatch = options.dispatchTools
    ?? await loadDispatchTools(options.omBase ?? process.env.HUB_OM_BASE ?? "http://127.0.0.1:8801", stateDir);
  for (const [name, handler] of Object.entries(dispatch)) {
    if (!handlers.has(name)) handlers.set(name, handler);
  }

  const rpc: RpcContext = {
    tools,
    allowed: new Set(tools.map((tool) => tool.name)),
    handlers,
  };
  const context: ServerContext = { token, rpc, stateDir, channels: new Map() };

  const server = createServer((request, response) => {
    void handleHttp(request, response, context).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[agent-hub.http] ${message}\n`);
      if (!response.headersSent) send(response, 500, "Internal Server Error");
      else response.destroy();
    });
  });

  await new Promise<void>((done, fail) => {
    const onError = (error: Error): void => {
      server.off("error", onError);
      fail(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      done();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  let discovery: DiscoveryHandle | null = null;
  if (options.discovery ?? !discoveryDisabledByEnv()) {
    const bindAddress = isLoopbackHost(host)
      ? "127.0.0.1"
      : await lookup(host, { family: 4 }).then((resolved) => resolved.address).catch(() => host);
    discovery = await startDiscovery({
      address: bindAddress,
      httpPort: actualPort,
      authRequired: Boolean(token),
      port: options.discoveryPort ?? DISCOVERY_PORT,
      name: discoveryName(hostname()),
      loopback: isLoopbackHost(host),
    });
  }

  return {
    port: actualPort,
    host,
    stateDir,
    discoveryPort: discovery ? discovery.port : null,
    authRequired: Boolean(token),
    server,
    close: async () => {
      discovery?.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

function argument(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function runCli(): Promise<void> {
  const argv = process.argv.slice(2);
  const port = Number(argument(argv, "--port") ?? process.env.AGENTHUB_PORT ?? 8765);
  const host = argument(argv, "--host") ?? process.env.AGENTHUB_HOST ?? "127.0.0.1";
  const stateDir = argument(argv, "--state-dir");
  const discoveryPort = argument(argv, "--discovery-port");
  try {
    const hub = await startHubCompat({
      port,
      host,
      ...(stateDir ? { stateDir } : {}),
      ...(discoveryPort !== undefined ? { discoveryPort: Number(discoveryPort) } : {}),
      ...(argv.includes("--no-discovery") ? { discovery: false } : {}),
      ...(argument(argv, "--om-base") ? { omBase: argument(argv, "--om-base") } : {}),
    });
    const auth = hub.authRequired ? "已启用 token 鉴权" : "未鉴权 (仅限本机回环!)";
    process.stderr.write(`[agent-hub] HTTP MCP 端点: http://${host}:${hub.port}/mcp (${auth})\n`);
    process.stderr.write(`[agent-hub] 状态目录: ${hub.stateDir}\n`);
    const shutdown = (): void => {
      void hub.close().then(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[agent-hub] ${message}\n`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void runCli();
}
