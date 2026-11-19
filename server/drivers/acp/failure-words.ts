import type { ServerText } from "../../../shared/server-text.ts";
import { runtimeErrorText } from "../runtime-notice-error.ts";
import { noticeFailure } from "../../chat-notices.ts";
import { engineFailure, stopFailure } from "../engine-errors.ts";

export function acpStopFailure(result: { error?: unknown; message?: unknown; stopReason?: string | null }, provider: string) {
  const message = typeof result?.error === "string" && result.error ? result.error
    : typeof result?.message === "string" && result.message ? result.message : undefined;
  if (message) return engineFailure(provider, message) ?? { message };
  const failure = stopFailure(result?.stopReason, provider) ?? noticeFailure("chat.notice.acpNoReason", { provider });
  return engineFailure(provider, failure.message) ?? failure;
}

/** DeepSeek Harness (dsh) words for an MCP server that failed to connect or sync its tools while the
 * session started. The whole error must be that failure (after an optional JSON-RPC message and before
 * an optional request context), so an earlier MCP failure quoted in other diagnostics keeps its text. */
const MCP_START_FAILED = /^(?:[^:\n]*: )?mcp-client\(([^)\n]+)\): initial connection or tool synchronization failed(?: \([^)\n]*\))?$/;

function mcpStartFailure(message: string, provider: string) {
  const server = MCP_START_FAILED.exec(message)?.[1];
  if (!server) return null;
  return server === "composio" ? noticeFailure("chat.notice.acpMcpAppsFailed", { provider }) : noticeFailure("chat.notice.acpMcpServerFailed", { server, provider });
}

/** A failure the agent reported as an ordinary reply, already in the words the person reads. */
export class AcpReportedFailure extends Error {
  readonly facts: { message: string; text?: ServerText; limitResetsAt?: number };
  readonly acpUsageLimit: boolean;

  constructor(facts: { message: string; text?: ServerText; limitResetsAt?: number }, usageLimit: boolean) {
    super(facts.message);
    this.facts = facts;
    this.acpUsageLimit = usageLimit;
  }
}

export function acpRuntimeFailure(error: unknown, provider: string, account?: { message?: string; text?: ServerText }) {
  if (account?.message !== undefined) return { message: account.message, text: account.text };
  if (error instanceof AcpReportedFailure) return error.facts;
  const message = error instanceof Error ? error.message : String(error);
  // Account wording, when given, wins over the MCP rewrite.
  const mcp = account?.text ? null : mcpStartFailure(message, provider);
  if (mcp) return mcp;
  // A bridge that stopped a turn by its status query (turn-liveness.ts) says why in words the chat can translate.
  const stuck = bridgeStuckNotice(error);
  if (stuck && !account?.text) return stuck;
  const failure = engineFailure(provider, message) ?? { message };
  const text = account?.text ?? runtimeErrorText(error) ?? failure.text;
  return text ? { ...failure, text } : failure;
}

/** The ACP error data a bridge attaches to a turn it judged stuck: `{ ombNotice: { key, params } }`. */
export function bridgeStuckNotice(error: unknown) {
  const notice = (error as { data?: { ombNotice?: { key?: unknown; params?: unknown } } } | null)?.data?.ombNotice;
  if (!notice || notice.key !== "chat.notice.turnStuck" || !notice.params || typeof notice.params !== "object") return null;
  const params = Object.fromEntries(Object.entries(notice.params as Record<string, unknown>)
    .filter(([key, value]) => (key === "name" || key === "window") && typeof value === "string")
    .map(([key, value]) => [key, (value as string).slice(0, 80)]));
  return typeof params.name === "string" && typeof params.window === "string" ? noticeFailure("chat.notice.turnStuck", params) : null;
}
