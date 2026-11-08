// Live view of dispatched hub tasks for Settings → Hub, fed by /api/hub/tasks and its SSE stream.
// Pure shapes and transitions only, so the merge rules are testable without a DOM.

export type HubTaskStatus = "running" | "completed" | "error" | "timeout" | "unknown";

export interface HubTaskView {
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

export interface HubEventView {
  seq: number;
  at: number;
  ref: string;
  agent: string;
  kind: "accepted" | "started" | "progress" | "done" | "error" | "timeout";
  text: string;
}

export interface HubLiveRow {
  task: HubTaskView;
  status: HubTaskStatus;
  progress: string;
  result: string;
  lastSeq: number;
  updatedAt: number;
}

const TERMINAL: ReadonlySet<string> = new Set(["completed", "error", "timeout"]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}

function asStatus(value: string): HubTaskStatus {
  return value === "running" || value === "completed" || value === "error" || value === "timeout"
    ? value
    : "unknown";
}

/** A list refresh never undoes what the stream already saw: terminal stays terminal, newer text wins. */
export function mergeTaskSnapshot(row: HubLiveRow | undefined, task: HubTaskView): HubLiveRow {
  const kept = row ? asStatus(row.status) : asStatus(task.status);
  const status = row && isTerminalStatus(kept) ? kept : asStatus(task.status);
  const streamIsNewer = row !== undefined && row.updatedAt > task.updatedAt;
  const progress = streamIsNewer ? row?.progress || task.progress || "" : task.progress || row?.progress || "";
  const result = streamIsNewer ? row?.result || task.result || "" : task.result || row?.result || "";
  return {
    task,
    status,
    progress,
    result,
    lastSeq: row?.lastSeq ?? 0,
    updatedAt: Math.max(row?.updatedAt ?? 0, task.updatedAt),
  };
}

export function applyHubEvent(row: HubLiveRow, event: HubEventView): HubLiveRow {
  const status: HubTaskStatus = event.kind === "done" ? "completed"
    : event.kind === "error" ? "error"
    : event.kind === "timeout" ? "timeout"
    : "running";
  const terminal = isTerminalStatus(status);
  return {
    task: { ...row.task, ref: event.ref, agent: event.agent || row.task.agent },
    status,
    progress: terminal ? row.progress : event.text,
    result: terminal ? event.text : row.result,
    lastSeq: Math.max(row.lastSeq, event.seq),
    updatedAt: Math.max(row.updatedAt, event.at),
  };
}

/** `m:ss`, or `h:mm:ss` past an hour; never negative. */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/** Seconds a row has been running, measured from the list's start or the first event. */
export function rowElapsedSeconds(row: HubLiveRow, nowSeconds: number): number | null {
  if (row.task.startedAt) return Math.max(0, nowSeconds - row.task.startedAt);
  return row.status === "running" ? Math.max(0, nowSeconds - row.updatedAt) : null;
}

export function parseHubEvent(raw: string): HubEventView | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const event = value as Partial<HubEventView>;
    if (typeof event.seq !== "number" || typeof event.text !== "string" || !event.kind) return null;
    return {
      seq: event.seq,
      at: Number(event.at ?? 0),
      ref: String(event.ref ?? ""),
      agent: String(event.agent ?? ""),
      kind: event.kind,
      text: event.text,
    };
  } catch {
    return null;
  }
}
