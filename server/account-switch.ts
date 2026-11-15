// E83: an engine can hold several account instances (qoder and qoder-ks, several Antigravity sign-ins, several
// OpenAI-compatible keys). Moving work to another account of the same engine changes who pays, so every path that can
// do it (propose_model, set_up_team / create_bot, start_thread) asks the person first, whatever the access level.
import type { ModelRequestCardData } from "../shared/model-request.ts";
import type { ModelSelection } from "../shared/wire.ts";

type Instance = Pick<ModelSelection, "instanceId">;
export type EngineOf = (instanceId: string) => string | undefined;
export interface AccountSwitch { from: string; to: string }

/** Non-null when `selection` lands on an instance none of `references` uses, but some reference runs the same engine on
 * another instance. Choosing an account a reference already uses, or an engine no reference uses, is no switch. */
export function accountSwitch(engineOf: EngineOf, selection: Instance, references: ReadonlyArray<Instance | null | undefined>): AccountSwitch | null {
  const refs = references.filter((ref): ref is Instance => Boolean(ref?.instanceId));
  if (refs.some((ref) => ref.instanceId === selection.instanceId)) return null;
  const kind = engineOf(selection.instanceId);
  if (!kind) return null;
  const other = refs.find((ref) => engineOf(ref.instanceId) === kind);
  return other ? { from: other.instanceId, to: selection.instanceId } : null;
}

export const accountSwitchLine = (change: AccountSwitch): string =>
  "Account: " + change.from + " → " + change.to + " (another account of the same engine; usage is billed to it). This needs your Confirm.";

/** One-shot permission the person gave on a card: this bot, from this conversation, may open one thread on this account. */
export class AccountSwitchGrants {
  private readonly grants = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  constructor(ttlMs = 30 * 60_000, now: () => number = Date.now) { this.ttlMs = ttlMs; this.now = now; }
  private key(botId: string, threadId: string, instanceId: string) { return botId + "\u0000" + threadId + "\u0000" + instanceId; }
  grant(botId: string, threadId: string, instanceId: string): void {
    const at = this.now();
    for (const [key, until] of this.grants) if (until <= at) this.grants.delete(key);
    this.grants.set(this.key(botId, threadId, instanceId), at + this.ttlMs);
  }
  /** Whether a live grant exists, without using it. */
  has(botId: string, threadId: string, instanceId: string): boolean {
    const until = this.grants.get(this.key(botId, threadId, instanceId));
    return until !== undefined && until > this.now();
  }
  /** Uses the grant: true once, then false. */
  take(botId: string, threadId: string, instanceId: string): boolean {
    const key = this.key(botId, threadId, instanceId);
    const until = this.grants.get(key);
    this.grants.delete(key);
    return until !== undefined && until > this.now();
  }
}

/** E83: what a start_thread parked on another account's Confirm hears once the person decides. */
export const threadAccountDecisionText = (payload: ModelRequestCardData): string => payload.thread?.result === "allow"
  ? `OpenMausBot account decision ${payload.requestId}: the person confirmed opening thread #${payload.thread.title} on ${payload.selection.instanceId} (another account of the same engine; usage is billed to it). Call start_thread again now with the same title, message and model_selection {"instanceId":${JSON.stringify(payload.selection.instanceId)},"model":${JSON.stringify(payload.selection.model)}${payload.selection.effort ? `,"effort":${JSON.stringify(payload.selection.effort)}` : ""}}; it opens this one thread. Do not ask the person again.`
  : `OpenMausBot account decision ${payload.requestId}: the person cancelled opening thread #${payload.thread?.title ?? ""} on ${payload.selection.instanceId} (another account of the same engine). Do not open it on that account or on any other account of that engine. Continue without it, or tell the person what is still open.`;
