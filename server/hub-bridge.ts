// /hub/*: the multi-agent-hub console (:8890) and its scheduler (:8790), reachable from inside OpenMausBot.
//
// Each handler has one hard-coded upstream. No caller-supplied URL is ever fetched, so this cannot be
// pointed at another host (SSRF); the only variable part is a path, and that path is normalised here.
// Everything degrades to { ok: false } when the hub is down: OpenMausBot itself never waits on it.
// Check-in is the exception: it runs in this process (./checkin), so it keeps working when the console is not up.
import { Buffer } from "node:buffer";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PASS, type RouteHandler } from "./routes/table.ts";
import { createCheckinApi, ensureCheckinScheduler } from "./checkin/routes.ts";
import { hubEventLog, redactEventText } from "./hub-compat/events.ts";
import { resolveStateDir } from "./hub-compat/store.ts";
import type { Store } from "./store.ts";

const CONSOLE = "http://127.0.0.1:8890";
const SCHEDULER = "http://127.0.0.1:8790/mcp";
/** A hub that is not answering in three seconds is reported as down, not waited on. */
const PROBE_MS = 3_000;
const QUOTA_RELAY_MS = 30_000;
const QUOTA_FALLBACK_MS = 25_000;
/** With earlier quotas in hand, wait only this long for a fresh walk before serving them marked stale (E66). */
const QUOTA_STALE_WAIT_MS = 4_000;

/** The check-in endpoints, keyed by the part after `/checkin`; the Daily page calls these. */
const CHECKIN_ROUTES: Record<string, "GET" | "POST"> = {
  "/status": "GET",
  "/projects": "GET",
  "/run": "POST",
  "/history/clear": "POST",
  "/config": "POST",
};

/** The console UI calls these absolute paths, so the embedded page keeps working under /hub/ui/. */
const CHECKIN_PREFIXES = ["/hub/checkin/", "/api/checkin/"] as const;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

interface Upstream {
  status: number;
  headers: Headers;
  body: Buffer;
}

/** One request to the console; null means it could not be reached (refused, timed out, DNS, ...). */
async function askConsole(method: "GET" | "POST", path: string, body?: string, timeoutMs = PROBE_MS): Promise<Upstream | null> {
  try {
    const response = await fetch(`${CONSOLE}${path}`, {
      method,
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      // Omitted entirely rather than passed as undefined: a GET that carries a body field is invalid, and the
      // quota relay added here only ever GETs.
      ...(body === undefined ? {} : { body }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
  } catch {
    return null;
  }
}

/** True when something is listening: any HTTP answer, even a 404, means the service is up. */
async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(PROBE_MS) });
    await response.arrayBuffer().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** `/hub/ui/…` maps to the console's own root; anything that could escape it is refused before fetching. */
function staticPathFor(path: string): string | null {
  const rest = path.slice("/hub/ui".length);
  if (rest === "" || rest === "/") return "/";
  if (!rest.startsWith("/")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (decoded.includes("..") || decoded.includes("\0") || decoded.includes("\\")) return null;
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(decoded)) return null;
  return decoded;
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot).toLowerCase();
}

/** Finished work stays on the page this long, so a task that ends while it is open is still readable. */
const RECENT_TASK_WINDOW_S = 300;
const TASK_LIST_LIMIT = 20;
/** Longest one SSE response lives before EventSource reconnects with the same cursor. */
const TASK_EVENTS_MAX_MS = 55_000;

interface HubTaskView {
  ref: string;
  agent: string;
  status: string;
  title: string;
  progress: string | null;
  startedAt: number | null;
  updatedAt: number;
  elapsedS: number | null;
  exitCode: number | null;
  result: string | null;
}

/**
 * The dispatch records hub-compat writes (`<stateDir>/results/<ref>.json`), shaped for the
 * settings page: running first, then whatever finished in the last five minutes.
 */
async function readHubTasks(): Promise<HubTaskView[]> {
  const resultsDir = join(resolveStateDir(), "results");
  let names: string[];
  try {
    names = await readdir(resultsDir);
  } catch {
    return [];
  }
  const now = Date.now() / 1000;
  const tasks: HubTaskView[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const ref = name.slice(0, -5);
    // The compat tools also keep "zcode-last"/"trae-last" summaries; they are not dispatches.
    if (ref === "zcode-last" || ref === "trae-last") continue;
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(resultsDir, name), "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      data = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const status = String(data.status ?? "unknown");
    const updatedAt = Number(data.updated_at ?? 0) || now;
    if (status !== "running" && now - updatedAt > RECENT_TASK_WINDOW_S) continue;
    const startedAt = Number(data.started_at ?? 0) || null;
    const ended = status === "completed" || status === "error" || status === "timeout";
    tasks.push({
      ref: String(data.ref ?? ref),
      agent: String(data.agent ?? "unknown"),
      status,
      title: data.task ? redactEventText(data.task).slice(0, 160) : "",
      progress: data.progress ? redactEventText(data.progress).slice(0, 240) : null,
      startedAt,
      updatedAt,
      elapsedS: startedAt ? Math.max(0, Math.round((status === "running" ? now : updatedAt) - startedAt)) : null,
      exitCode: data.exit_code === null || data.exit_code === undefined ? null : Number(data.exit_code),
      result: ended && data.text ? redactEventText(data.text).slice(0, 400) : null,
    });
  }
  tasks.sort((left, right) =>
    (left.status === "running" ? 0 : 1) - (right.status === "running" ? 0 : 1) || right.updatedAt - left.updatedAt);
  return tasks.slice(0, TASK_LIST_LIMIT);
}

/**
 * SSE over the same JSONL the compat process appends to: replay from `since`, then poll
 * the file (a 700ms tail is plenty for a status line) until a terminal event.
 */
function streamHubTaskEvents(res: import("node:http").ServerResponse, ref: string, since: number): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const log = hubEventLog(resolveStateDir());
  let cursor = Number.isFinite(since) ? since : 0;
  let closed = false;
  let poll: ReturnType<typeof setInterval> | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  const close = () => {
    if (closed) return;
    closed = true;
    if (poll) clearInterval(poll);
    if (ping) clearInterval(ping);
    if (deadline) clearTimeout(deadline);
    if (!res.writableEnded) res.end();
  };
  const flush = () => {
    if (closed) return;
    let terminal = false;
    for (const event of log.list(ref, cursor, 500)) {
      cursor = event.seq;
      try {
        res.write(`id: ${event.seq}\nevent: hub\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        close();
        return;
      }
      if (event.kind === "done" || event.kind === "error" || event.kind === "timeout") terminal = true;
    }
    if (terminal) {
      res.write(`event: end\ndata: ${JSON.stringify({ ref, at: Date.now() / 1000 })}\n\n`);
      close();
    }
  };
  flush();
  if (closed) return;
  poll = setInterval(flush, 700);
  ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      close();
    }
  }, 15_000);
  deadline = setTimeout(close, TASK_EVENTS_MAX_MS);
  res.on("close", close);
  res.on("error", close);
}

/**
 * The hub-compat process writes a dispatch's progress back into the thread that asked for it.
 *
 * The line is a bot line, not a person's: a person's line is what starts a turn of that bot, so
 * a dispatch that reported back as a person's words would make the asking bot report back
 * again. A bot line is read by the person and never wakes anybody.
 */
export function appendOriginLine(
  store: Pick<Store, "appendMessage" | "botByThread" | "patchTask">,
  threadId: string,
  text: string,
): { ok: true; threadId: string; messageId?: string } | { ok: false; status: number; error: string } {
  if (!/^[\w-]{1,128}$/.test(threadId)) return { ok: false, status: 400, error: "threadId must be a task id" };
  const line = redactEventText(text).slice(0, 400);
  if (!line) return { ok: false, status: 400, error: "text required" };
  const bot = store.botByThread(threadId);
  if (!bot) return { ok: false, status: 404, error: "no such thread" };
  const message = store.appendMessage(threadId, { role: "bot", kind: "text", text: line });
  store.patchTask(bot.id, threadId, { unread: true });
  return { ok: true, threadId, messageId: message?.id };
}

export function createHubBridgeRoutes(deps: {
  store: Pick<Store, "appendMessage" | "botByThread" | "patchTask">;
  getAllQuotas?: (opts?: { force?: boolean }) => Promise<unknown>;
  /** Whether the console answers at all; a console that is up but slow must not trigger a second quota fetch. */
  consoleReachable?: () => Promise<boolean>;
  /** Total budget for the in-process quota fallback. */
  quotaFallbackMs?: number;
  askConsole?: typeof askConsole;
}): RouteHandler {
  const checkinApi = createCheckinApi();
  ensureCheckinScheduler();
  // E66: the in-process fallback walks 14 vendors and takes ~25-40 s cold, longer than its budget. The fetch keeps
  // running after a timeout; whatever it (or any earlier fetch) returns is kept here and served, marked stale, the
  // next time the budget runs out, so the quota page and the dispatch quota gate are not left with 504 every minute.
  let lastQuotas: Record<string, unknown> | null = null;
  return async ({ req, res, path, url, method, json, readBody }) => {
    if (!path.startsWith("/hub/") && !path.startsWith("/api/checkin/")
      && path !== "/api/hub/tasks" && !path.startsWith("/api/hub/")) return PASS;

    if (method === "POST" && path === "/api/hub/origin") {
      const body = await readBody(req, 64 * 1024);
      const threadId = typeof (body as { threadId?: unknown })?.threadId === "string" ? (body as { threadId: string }).threadId : "";
      const text = typeof (body as { text?: unknown })?.text === "string" ? (body as { text: string }).text : "";
      const outcome = appendOriginLine(deps.store, threadId, text);
      if (!outcome.ok) return json(res, outcome.status, { error: outcome.error });
      return json(res, 201, { ok: true, threadId: outcome.threadId, messageId: outcome.messageId });
    }

    // A trailing slash keeps the console page's relative asset URLs under /hub/ui/.
    if (method === "GET" && path === "/hub/ui") {
      res.writeHead(302, { location: "/hub/ui/", "cache-control": "no-store" });
      res.end();
      return;
    }

    if (method === "GET" && path === "/hub/health") {
      const [consoleOk, schedulerOk] = await Promise.all([reachable(`${CONSOLE}/`), reachable(SCHEDULER)]);
      return json(res, 200, { console: { ok: consoleOk, url: CONSOLE }, scheduler: { ok: schedulerOk, url: SCHEDULER } });
    }

    // Dispatched work, read from the compat process's own state: the settings page subscribes here
    // instead of polling hub_task_status. Both routes sit behind this server's normal auth gate.
    if (method === "GET" && path === "/api/hub/tasks") {
      return json(res, 200, { ok: true, tasks: await readHubTasks() });
    }

    const taskEvents = /^\/api\/hub\/tasks\/([^/]+)\/events$/.exec(path);
    if (taskEvents) {
      if (method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
      let ref: string;
      try {
        ref = decodeURIComponent(taskEvents[1]!);
      } catch {
        return json(res, 400, { ok: false, error: "bad_ref" });
      }
      if (!/^[A-Za-z0-9._-]{1,160}$/.test(ref)) return json(res, 400, { ok: false, error: "bad_ref" });
      const headerSince = Number(req.headers["last-event-id"] ?? "");
      const querySince = Number(url.searchParams.get("since") ?? "");
      const since = Math.max(Number.isFinite(headerSince) ? headerSince : 0, Number.isFinite(querySince) ? querySince : 0);
      streamHubTaskEvents(res, ref, since);
      return;
    }
    if (path.startsWith("/api/hub/")) return json(res, 405, { ok: false, error: "method_not_allowed" });

    // The console already aggregates each worker's remaining allowance; the daily page reads it through here so the
    // phone never needs a second origin (and a second sign-in) to see quotas.
    // When the external console is unreachable, fall back to native in-process quota tracking (vendor-quota.mjs).
    if (method === "GET" && path === "/hub/quota") {
      const ask = deps.askConsole ?? askConsole;
      // The console's /api/quota takes ~4 s warm and 20 s+ cold (E39): wait for it rather than racing it.
      const upstream = await ask("GET", "/api/quota", undefined, QUOTA_RELAY_MS);
      if (upstream) {
        res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8", "content-length": String(upstream.body.length), "cache-control": "no-store" });
        res.end(upstream.body);
        return;
      }
      // Up but slow: the console is already fetching (and may be refreshing OAuth tokens it writes back to the
      // credential files), so a second fetch here would race it. Only a console that is down hands over (E39).
      const up = await (deps.consoleReachable ?? (() => reachable(CONSOLE)))();
      if (up) return json(res, 504, { ok: false, error: "console_slow" });
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        // server/checkin/vendor-quota.mjs is the full quota tracker (E66); the old repo-level checkin/ copy is not read here.
        const fetchQuotas = deps.getAllQuotas ?? (await import("./checkin/vendor-quota.mjs")).getAllQuotas;
        const budget = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("quota_timeout")), Math.min(deps.quotaFallbackMs ?? QUOTA_FALLBACK_MS, lastQuotas ? QUOTA_STALE_WAIT_MS : Infinity)); });
        const fetching = Promise.resolve(fetchQuotas({ force: url.searchParams.get("refresh") === "1" }));
        fetching.then((data) => { if (data && typeof data === "object") lastQuotas = data as Record<string, unknown>; }, () => {});
        const data = await Promise.race([fetching, budget]);
        return json(res, 200, data);
      } catch (error) {
        const timedOut = (error as Error)?.message === "quota_timeout";
        if (timedOut && lastQuotas) return json(res, 200, { ...lastQuotas, stale: true });
        return json(res, timedOut ? 504 : 502, { ok: false, error: timedOut ? "quota_timeout" : "console_unreachable" });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    if (method === "GET" && (path === "/hub/ui/" || path.startsWith("/hub/ui/"))) {
      const upstreamPath = staticPathFor(path);
      if (!upstreamPath) return json(res, 400, { ok: false, error: "bad_path" });
      const upstream = await askConsole("GET", upstreamPath);
      if (!upstream) return json(res, 502, { ok: false, error: "console_unreachable" });
      const type = TYPES[extensionOf(upstreamPath)] ?? upstream.headers.get("content-type") ?? "application/octet-stream";
      const headers: Record<string, string> = { "content-type": type, "content-length": String(upstream.body.length), "cache-control": "no-store" };
      // The console's own policy, if it ever sends one, is forwarded untouched; framing must stay allowed for the iframe.
      const csp = upstream.headers.get("content-security-policy");
      if (csp) headers["content-security-policy"] = csp;
      res.writeHead(upstream.status, headers);
      res.end(upstream.body);
      return;
    }

    const wanted = CHECKIN_PREFIXES.some((prefix) => path.startsWith(prefix));
    if (!wanted) return PASS;
    const checkin = path.slice(path.indexOf("/checkin/") + "/checkin".length);
    const expected = CHECKIN_ROUTES[checkin];
    if (!expected) return PASS;
    if (method !== expected) return json(res, 405, { ok: false, error: "method_not_allowed" });

    if (method === "GET") {
      return json(res, 200, checkin === "/status" ? await checkinApi.status() : checkinApi.projects());
    }

    let body: Record<string, unknown> = {};
    try {
      const sent = await readBody(req, 64 * 1024);
      if (sent && typeof sent === "object") body = sent as Record<string, unknown>;
    } catch {
      return json(res, 400, { ok: false, error: "bad_body" });
    }
    try {
      if (checkin === "/run") {
        const target = typeof body.platform === "string" && body.platform ? body.platform : "all";
        return json(res, 200, await checkinApi.run(target));
      }
      if (checkin === "/history/clear") return json(res, 200, await checkinApi.clearHistory());
      return json(res, 200, await checkinApi.config(body));
    } catch (error) {
      return json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
}
