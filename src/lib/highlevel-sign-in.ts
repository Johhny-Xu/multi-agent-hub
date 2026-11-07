import { mcpSignInLink } from "./mcp-sign-in";

/** GET /api/highlevel: one HighLevel connection per installation (desktop and Cloud home alike). */
export type HighLevelState = "unavailable" | "signed-out" | "connecting" | "connected" | "needs-sign-in";

export interface HighLevelFlow {
  flowId: string;
  authorizationUrl: string;
  expiresAt?: string;
}

export interface HighLevelStatus {
  state: HighLevelState;
  kind?: "oauth" | "token";
  location?: { id: string; name: string };
  connectedAt?: string;
  flow?: HighLevelFlow;
  problem?: string;
}

export type HighLevelSignInPhase = "waiting" | "connected" | "failed" | "expired" | "cancelled";

export interface HighLevelSignInResult {
  phase: HighLevelSignInPhase;
  message?: string;
}

export const HIGHLEVEL_API = "/api/highlevel";
export const HIGHLEVEL_SLUG = "highlevel";
const POLL_MS = 1_500;

interface Deps {
  api: (path: string, init?: { method?: string; body?: string }) => Promise<any>;
  /** Opens the sign-in page; a false result means the person has to open it by hand. */
  open: (url: string) => Promise<boolean | void>;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  onStarted?: (flow: HighLevelFlow) => void;
}

const CANCELLED: HighLevelSignInResult = { phase: "cancelled" };

export function isHighLevelStatus(value: unknown): value is HighLevelStatus {
  if (!value || typeof value !== "object") return false;
  const state = (value as { state?: unknown }).state;
  return state === "unavailable" || state === "signed-out" || state === "connecting" || state === "connected" || state === "needs-sign-in";
}

function flowOf(value: unknown): HighLevelFlow | null {
  if (!value || typeof value !== "object") return null;
  const { flowId, authorizationUrl, expiresAt } = value as Record<string, unknown>;
  if (typeof flowId !== "string" || !flowId) return null;
  const link = mcpSignInLink(typeof authorizationUrl === "string" ? authorizationUrl : null);
  if (!link) return null;
  return { flowId, authorizationUrl: link, ...(typeof expiresAt === "string" ? { expiresAt } : {}) };
}

function resultOf(value: unknown): HighLevelSignInResult {
  const phase = (value as { phase?: unknown } | null)?.phase;
  const message = (value as { message?: unknown } | null)?.message;
  const known = phase === "waiting" || phase === "connected" || phase === "failed" || phase === "expired";
  return { phase: known ? phase : "failed", ...(typeof message === "string" && message ? { message } : {}) };
}

/** Starts a sign-in, opens HighLevel's page and waits for the server to report the outcome. */
export async function runHighLevelSignIn(deps: Deps): Promise<HighLevelSignInResult> {
  const started = await deps.api(`${HIGHLEVEL_API}/sign-in`, { method: "POST" });
  const flow = flowOf(started);
  if (!flow) {
    const flowId = (started as { flowId?: unknown } | null)?.flowId;
    if (typeof flowId === "string" && flowId) await cancelHighLevelSignIn(flowId, deps.api);
    return { phase: "failed" };
  }
  if (deps.signal?.aborted) {
    await cancelHighLevelSignIn(flow.flowId, deps.api);
    return CANCELLED;
  }
  deps.onStarted?.(flow);
  return watchHighLevelSignIn(flow, deps, true);
}

export function cancelHighLevelSignIn(flowId: string, api: Deps["api"]): Promise<void> {
  return api(`${HIGHLEVEL_API}/sign-in/${encodeURIComponent(flowId)}`, { method: "DELETE" }).then(() => undefined, () => undefined);
}

/** Follows a flow the server already has (opening its page first when asked) until it ends or the person cancels. */
export async function watchHighLevelSignIn(flow: HighLevelFlow, deps: Deps, openPage = false): Promise<HighLevelSignInResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { signal } = deps;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<HighLevelSignInResult>((resolve) => {
    onAbort = () => resolve(CANCELLED);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  const cancelled = async () => {
    await cancelHighLevelSignIn(flow.flowId, deps.api);
    return CANCELLED;
  };
  try {
    if (signal?.aborted) return await cancelled();
    if (openPage) {
      // Cancellation must not wait for the page or the status request to settle.
      await Promise.race([Promise.resolve().then(() => deps.open(flow.authorizationUrl)).catch(() => undefined), aborted]);
      if (signal?.aborted) return await cancelled();
    }
    for (;;) {
      await Promise.race([sleep(POLL_MS), aborted]);
      if (signal?.aborted) return await cancelled();
      let status: HighLevelSignInResult;
      try {
        const response = await Promise.race([deps.api(`${HIGHLEVEL_API}/sign-in/${encodeURIComponent(flow.flowId)}`), aborted]);
        if (signal?.aborted) return await cancelled();
        status = resultOf(response);
      } catch (error) {
        if (signal?.aborted) return await cancelled();
        return { phase: "failed", message: error instanceof Error ? error.message : String(error) };
      }
      if (status.phase !== "waiting") return status;
    }
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
