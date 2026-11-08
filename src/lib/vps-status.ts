// What the settings list shows about each managed computer: a status dot, the last answer, and the checks that answer.
import type { VpsInstanceView } from "../../shared/vps";
import { en, type LocaleKey } from "@/locales";
import { formatTime } from "@/lib/clock-time";
import { t } from "@/lib/i18n";

export type VpsDotState = "online" | "offline" | "unknown" | "checking";

/** The dot before a computer's name: green, red, grey, or a spinner while it is checked. */
export function vpsDotState(view: Pick<VpsInstanceView, "online">, checking = false): VpsDotState {
  if (checking) return "checking";
  if (view.online === true) return "online";
  if (view.online === false) return "offline";
  return "unknown";
}

export function vpsStatusLabel(state: VpsDotState): string {
  if (state === "online") return t("keys.vps.statusOnline");
  if (state === "offline") return t("keys.vps.statusOffline");
  if (state === "checking") return t("keys.vps.statusChecking");
  return t("keys.vps.statusUnknown");
}

/** Every reason the server names, in the page's language. */
const REASON_KEYS: Record<string, LocaleKey> = {
  "missing-connection": "keys.vps.reasonMissingConnection",
  disabled: "keys.vps.reasonDisabled",
  denied: "keys.vps.reasonDenied",
  unreachable: "keys.vps.reasonUnreachable",
  unsupported: "keys.vps.reasonUnsupported",
  timeout: "keys.vps.reasonTimeout",
  "tool-error": "keys.vps.reasonToolError",
  stopped: "keys.vps.reasonStopped",
};

/** Why the last check failed: the server's own words when it named a reason we do not know. */
export function vpsFailureText(view: Pick<VpsInstanceView, "reason" | "error">): string {
  const key = view.reason ? REASON_KEYS[view.reason] : undefined;
  if (key && Object.hasOwn(en, key)) return t(key);
  return view.error?.trim() || t("keys.vps.statusOffline");
}

/** The line under the name: online with the round trip, offline with the reason. */
export function vpsStatusLine(view: VpsInstanceView, checking = false): string {
  const state = vpsDotState(view, checking);
  const label = vpsStatusLabel(state);
  if (state === "online") {
    return view.latencyMs === undefined ? label : `${label} · ${t("keys.vps.latency", { ms: view.latencyMs })}`;
  }
  if (state === "offline") return `${label} · ${vpsFailureText(view)}`;
  return label;
}

/** When the last check ran, on this device's clock. */
export function vpsCheckedAtText(checkedAt: string | undefined): string {
  if (!checkedAt) return "";
  const at = Date.parse(checkedAt);
  if (Number.isNaN(at)) return "";
  return t("keys.vps.checkedAt", { time: formatTime(at) });
}

/** The fields a check changes; everything else about the computer stays as the server lists it. */
export function vpsStatusPatch(view: VpsInstanceView): Partial<VpsInstanceView> {
  return {
    ...(view.online === undefined ? {} : { online: view.online }),
    ...(view.latencyMs === undefined ? {} : { latencyMs: view.latencyMs }),
    ...(view.checkedAt === undefined ? {} : { checkedAt: view.checkedAt }),
    ...(view.error === undefined ? {} : { error: view.error }),
    ...(view.reason === undefined ? {} : { reason: view.reason }),
    ...(view.detail === undefined ? {} : { detail: view.detail }),
    ...(view.available === undefined ? {} : { available: view.available }),
  };
}

/** The list as the server has it, with the last answer of each computer kept on top. */
export function vpsMergedRows(rows: readonly VpsInstanceView[], local: readonly VpsInstanceView[] | null): VpsInstanceView[] {
  if (!local) return [...rows];
  const patches = new Map(local.map((entry) => [entry.id, vpsStatusPatch(entry)]));
  const merged = rows.map((row) => ({ ...row, ...(patches.get(row.id) ?? {}) }));
  for (const entry of local) {
    if (!rows.some((row) => row.id === entry.id)) merged.push(entry);
  }
  return merged;
}

/** One row after its check: the answer lands on that row alone. */
export function vpsRowAfterCheck(rows: readonly VpsInstanceView[], id: string, result: VpsInstanceView): VpsInstanceView[] {
  return rows.map((row) => row.id === id ? { ...row, ...vpsStatusPatch(result) } : row);
}

export function vpsRowAfterCheckFailure(
  rows: readonly VpsInstanceView[],
  id: string,
  error: unknown,
): VpsInstanceView[] {
  const message = error instanceof Error ? error.message : String(error);
  const isTimeout = /timeout|timed out/i.test(message);
  return rows.map((row) => {
    if (row.id !== id) return row;
    return {
      ...row,
      online: false,
      reason: isTimeout ? "timeout" : undefined,
      error: message,
      latencyMs: undefined,
      checkedAt: new Date().toISOString(),
    };
  });
}

export function vpsRowsToAutoCheck(serverRows?: readonly VpsInstanceView[] | null): VpsInstanceView[] {
  if (!serverRows || serverRows.length === 0) return [];
  return [...serverRows];
}

export function vpsCanCheck(
  row: Pick<VpsInstanceView, "id"> | null | undefined,
  serverIds: ReadonlySet<string> | readonly string[],
): boolean {
  if (!row?.id) return false;
  return serverIds instanceof Set ? serverIds.has(row.id) : serverIds.includes(row.id);
}

export function vpsUnsavedMessage(): string {
  return t("keys.vps.unsaved");
}

export type VpsCheckRequest = (id: string, expectedRevision: string) => Promise<VpsInstanceView>;

/** Every computer is checked at once, so one dead host does not hold the others up. */
export async function checkVpsInstances(
  instances: readonly VpsInstanceView[],
  revision: string,
  request: VpsCheckRequest,
  onResult?: (view: VpsInstanceView) => void,
  onFailure?: (id: string, reason: unknown) => void,
): Promise<void> {
  await Promise.all(instances.map(async (instance) => {
    try {
      const result = await request(instance.id, revision);
      onResult?.(result);
    } catch (reason) {
      onFailure?.(instance.id, reason);
    }
  }));
}
