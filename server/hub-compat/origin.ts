/**
 * Write-back of a dispatch into the thread that asked for it.
 *
 * The hub client (mcp/hub.mjs) sends `X-Hub-Origin-Thread` on every tools/call, so a dispatch
 * knows which thread asked for the work. That thread lives in the workbench (8801) and this
 * process is not it: the line goes back over the workbench's own hub route, which appends a
 * bot line to the thread.
 *
 * A bot line is not a person's line, so the asking bot is not woken by it. A dispatch that
 * reported back as a person's words would start a new round of that bot, and that bot would
 * report back again: the loop this module exists to avoid.
 *
 * Every line is passed through redactEventText, so a key or a token can never reach a chat.
 */
import { redactEventText } from "./events.ts";

/** The header the client sends; the workbench route that receives it. */
export const ORIGIN_THREAD_HEADER = "x-hub-origin-thread";

/** Two progress lines for one task are at least this far apart. The terminal line always goes. */
export const ORIGIN_PROGRESS_THROTTLE_MS = 15_000;

/** The summary of a finished task: the first 300 characters, never more. */
export const ORIGIN_SUMMARY_CHARS = 300;

export type OriginKind = "accepted" | "progress" | "done" | "error" | "timeout";

export interface OriginWriteBack {
  threadId: string;
  text: string;
}

/** The thread id in a header value, or nothing: an absent thread means absent on the wire. */
export function originThreadOf(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  const value = String(raw ?? "").trim();
  return value ? value.slice(0, 200) : undefined;
}

/** The line a thread shows for one step of a task. No secret, no line break, one line. */
export function originLine(agent: string, ref: string, kind: OriginKind, text: string): string {
  const head = `[hub ${agent}/${ref}]`;
  const body = redactEventText(text).replace(/\s+/g, " ").slice(0, ORIGIN_SUMMARY_CHARS);
  if (kind === "accepted") return `${head} 已受理，正在执行。`;
  if (kind === "progress") return body ? `${head} 进行中：${body}` : `${head} 仍在执行。`;
  return body ? `${head} ${kind === "done" ? "完成" : kind === "timeout" ? "超时" : "失败"}：${body}` : `${head} ${kind === "done" ? "完成" : kind === "timeout" ? "超时" : "失败"}。`;
}

/** The terminal line: the summary and how long the task took. */
export function originTerminalLine(agent: string, ref: string, status: string, summary: string, elapsedS: number): string {
  const kind: OriginKind = status === "completed" ? "done" : status === "timeout" ? "timeout" : "error";
  const head = `[hub ${agent}/${ref}] ${kind === "done" ? "完成" : kind === "timeout" ? "超时" : "失败"}（耗时 ${elapsedS >= 60 ? `${Math.floor(elapsedS / 60)}m${elapsedS % 60}s` : `${elapsedS}s`}）`;
  const body = redactEventText(summary).replace(/\s+/g, " ").slice(0, ORIGIN_SUMMARY_CHARS);
  return body ? `${head}：${body}` : `${head}。`;
}

/**
 * One writer per hub-compat process. It remembers which thread each task belongs to, keeps
 * progress lines at least a quarter of a minute apart, and never lets a failed write-back
 * reach the dispatch: a write-back that fails is logged and forgotten.
 */
export interface OriginWriter {
  /** Remembers the asking thread and posts the acceptance line. */
  accepted(ref: string, agent: string, threadId: string | undefined): Promise<void>;
  /** Posts a progress line, unless the last one for this task was less than the throttle ago. */
  progress(ref: string, agent: string, text: string): Promise<void>;
  /** Posts the terminal line: the summary and the elapsed time. */
  terminal(ref: string, agent: string, status: string, summary: string, elapsedS: number): Promise<void>;
  /** The thread a task belongs to, when one asked for it. */
  threadOf(ref: string): string | undefined;
}

export interface OriginWriterOptions {
  /** The workbench base URL: the write-back goes to its hub route. */
  omBase: string;
  /** Where the workbench appends the line; the workbench's own hub route by default. */
  path?: string;
  now?: () => number;
  /** Failures are logged here and nowhere else. */
  log?: (message: string) => void;
  /** The transport, for a test that does not speak HTTP. */
  send?: (write: OriginWriteBack) => Promise<boolean>;
}

export function createOriginWriter(options: OriginWriterOptions): OriginWriter {
  const threads = new Map<string, string>();
  const lastProgress = new Map<string, number>();
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((message: string) => console.warn(`[agent-hub] ${message}`));
  const path = options.path ?? "/api/hub/origin";

  const send = options.send ?? (async (write: OriginWriteBack): Promise<boolean> => {
    const base = options.omBase.replace(/\/+$/, "");
    const response = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(write),
      signal: AbortSignal.timeout(10_000),
    });
    return response.status >= 200 && response.status < 300;
  });

  async function post(ref: string, text: string): Promise<void> {
    const threadId = threads.get(ref);
    if (!threadId) return;
    try {
      const taken = await send({ threadId, text });
      if (!taken) log(`回写未送达 (ref=${ref})`);
    } catch (error) {
      log(`回写失败 (ref=${ref}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    async accepted(ref, agent, threadId) {
      if (!threadId) return;
      threads.set(ref, threadId);
      await post(ref, originLine(agent, ref, "accepted", ""));
    },
    async progress(ref, agent, text) {
      if (!threads.has(ref)) return;
      const at = now();
      const last = lastProgress.get(ref);
      if (last !== undefined && at - last < ORIGIN_PROGRESS_THROTTLE_MS) return;
      lastProgress.set(ref, at);
      await post(ref, originLine(agent, ref, "progress", text));
    },
    async terminal(ref, agent, status, summary, elapsedS) {
      if (!threads.has(ref)) return;
      await post(ref, originTerminalLine(agent, ref, status, summary, elapsedS));
      lastProgress.delete(ref);
    },
    threadOf(ref) {
      return threads.get(ref);
    },
  };
}
