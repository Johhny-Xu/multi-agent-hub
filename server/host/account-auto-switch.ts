// Glue between the account auto-switch core and a running server: when a turn fails on a usage limit it
// switches the engine's saved account, retires the CLI processes still holding the old one and sends the
// person's message again, or says in the thread why it did not. The caller runs quota switch (backup
// engines) only when this reports the failure unhandled.
import { isLimitFailure, type createAccountAutoSwitch } from "../account-auto-switch.ts";
import { conversationLanguage, serverLine, type ServerLineKey } from "../server-lines.ts";
import type { BotRecord, Message, Store } from "../store.ts";

export interface AccountAutoSwitchHostDeps {
  core: ReturnType<typeof createAccountAutoSwitch>;
  store: Pick<Store, "activePath" | "messagesFor" | "appendMessage">;
  request(threadId: string): { messageId?: string } | undefined;
  otherTurnBusyOn(instanceId: string, exceptThreadId: string): boolean;
  threadBusy(botId: string, threadId: string): boolean;
  reclaim(instanceId: string): void;
  refresh(): void;
  resend(botId: string, threadId: string, message: Message, replyTo: Message | undefined): Promise<unknown>;
  /** Cap on resends of one user message, so a thread cannot loop on an engine that always fails. Default 2. */
  maxSwitchesPerMessage?: number;
  /** The language a line in this conversation is written in; defaults to the conversation's. */
  language?: (threadId: string) => string | undefined;
}

export function createAccountAutoSwitchHost(deps: AccountAutoSwitchHostDeps): {
  /** true = handled (switched, and the message resent or the person told what to do), so the caller skips
   * quota switch; false = untouched, quota switch takes over. Never throws. */
  turnFailed(bot: BotRecord, threadId: string, failureDetail: string, internal: boolean): Promise<boolean>;
} {
  const maxSwitches = deps.maxSwitchesPerMessage ?? 2;
  const language = deps.language ?? conversationLanguage;
  /** Resends already made for one user message, keyed `${threadId}:${messageId}`. */
  const resent = new Map<string, number>();

  const notice = (threadId: string, key: ServerLineKey, params: Record<string, string> | undefined, ok: boolean): void => {
    deps.store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: `notice: ${serverLine(language(threadId), key, params)}`, ok } });
  };

  const turnFailed = async (bot: BotRecord, threadId: string, failureDetail: string, internal: boolean): Promise<boolean> => {
    try {
      if (internal) return false;
      const instanceId = bot.modelSelection?.instanceId;
      if (!instanceId || !deps.core.enabled(instanceId)) return false;
      if (!isLimitFailure(failureDetail)) return false;
      const messageId = deps.request(threadId)?.messageId;
      if (messageId && (resent.get(`${threadId}:${messageId}`) ?? 0) >= maxSwitches) return false;
      if (deps.otherTurnBusyOn(instanceId, threadId)) {
        notice(threadId, "server.accountAutoSwitch.busy", undefined, false);
        return false;
      }
      const outcome = deps.core.onTurnFailed(instanceId, failureDetail);
      if (!outcome.switched) return false;
      deps.reclaim(instanceId);
      deps.refresh();
      const candidate = messageId ? deps.store.activePath(threadId).find((message) => message.id === messageId) : undefined;
      // A line a bot delivered (peerAsk) is never resent in the person's name.
      const original = candidate?.role === "user" && candidate.kind === "text" && candidate.text && !candidate.peerAsk ? candidate : undefined;
      const from = outcome.from?.label ?? serverLine(language(threadId), "server.accountAutoSwitch.unrecorded");
      const to = outcome.to.label;
      if (!original || deps.threadBusy(bot.id, threadId)) {
        notice(threadId, "server.accountAutoSwitch.switched", { from, to }, true);
        return true;
      }
      notice(threadId, "server.accountAutoSwitch.switchedResend", { from, to }, true);
      const countKey = `${threadId}:${messageId}`;
      resent.set(countKey, (resent.get(countKey) ?? 0) + 1);
      try {
        await deps.resend(bot.id, threadId, original, original.replyToId ? deps.store.messagesFor(threadId).find((message) => message.id === original.replyToId) : undefined);
      } catch (error) {
        const words = (error instanceof Error ? error.message : String(error)).slice(0, 200);
        notice(threadId, "server.accountAutoSwitch.retryFailed", { error: words }, false);
      }
      return true;
    } catch {
      return false;
    }
  };

  return { turnFailed };
}
