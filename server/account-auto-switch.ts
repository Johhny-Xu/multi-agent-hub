// When a bot turn fails on quota or rate limits, switch to the next saved account of the same engine
// instance and let the caller retry the turn. Off by default and enabled per engine instance: it only
// does what the person could do by hand from the accounts page (user decision 2026-11-10), so it runs
// only once turned on for that instance.
import { readFileSync } from "node:fs";

import type { ServiceAccountsView } from "../shared/service-accounts.ts";
import { writeFileAtomic } from "./atomic.ts";
import { classifyError } from "./drivers/retry.ts";

const DEFAULT_COOLDOWN_MS = 5 * 60 * 60_000;

export interface AutoSwitchDeps {
  /** Persisted JSON: `{ enabled: Record<instanceId, boolean>, limitedUntil: Record<instanceId, Record<accountId, number>> }`. */
  statePath: string;
  view(instanceId: string): ServiceAccountsView;
  switchTo(instanceId: string, accountId: string): ServiceAccountsView;
  now?: () => number;
  /** How long an account judged out of quota stays unselected. Default 5 hours. */
  cooldownMs?: number;
}

export type AutoSwitchOutcome =
  | { switched: true; instanceId: string; from: { id: string; label: string } | null; to: { id: string; label: string }; reason: "quota" | "rate_limited" }
  | { switched: false; instanceId: string; why: "disabled" | "not_limit_error" | "unsupported" | "no_other_account" | "drifted" | "switch_failed" };

interface AutoSwitchState {
  enabled: Record<string, boolean>;
  limitedUntil: Record<string, Record<string, number>>;
}

// Quota wordings the classifier misses on its own: the provider quota code and the Chinese wording.
const EXTRA_QUOTA_PATTERNS = [/\bexceed(?:ed|s)? quota\b/i, /\b1005\b/, /\busage limit\b/i, /额度/];

export function isLimitFailure(errorText: string): "quota" | "rate_limited" | null {
  const { reason } = classifyError(new Error(errorText));
  if (reason === "quota" || reason === "rate_limited") return reason;
  return EXTRA_QUOTA_PATTERNS.some((pattern) => pattern.test(errorText)) ? "quota" : null;
}

function objectsOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function loadState(path: string): AutoSwitchState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { enabled: {}, limitedUntil: {} };
  }
  const raw = objectsOf(parsed);
  const enabled: Record<string, boolean> = {};
  for (const [instanceId, on] of Object.entries(objectsOf(raw.enabled))) {
    if (typeof on === "boolean") enabled[instanceId] = on;
  }
  const limitedUntil: Record<string, Record<string, number>> = {};
  for (const [instanceId, accounts] of Object.entries(objectsOf(raw.limitedUntil))) {
    const entries: Record<string, number> = {};
    for (const [accountId, until] of Object.entries(objectsOf(accounts))) {
      if (typeof until === "number" && Number.isFinite(until)) entries[accountId] = until;
    }
    if (Object.keys(entries).length > 0) limitedUntil[instanceId] = entries;
  }
  return { enabled, limitedUntil };
}

export function createAccountAutoSwitch(deps: AutoSwitchDeps) {
  const cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const now = deps.now ?? Date.now;
  const state = loadState(deps.statePath);

  const save = (): void => {
    try {
      writeFileAtomic(deps.statePath, JSON.stringify(state), { mode: 0o600 });
    } catch (error) {
      console.error(`account auto-switch: could not save ${deps.statePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const prune = (): void => {
    const at = now();
    for (const [instanceId, perAccount] of Object.entries(state.limitedUntil)) {
      for (const [accountId, until] of Object.entries(perAccount)) {
        if (until <= at) delete perAccount[accountId];
      }
      if (Object.keys(perAccount).length === 0) delete state.limitedUntil[instanceId];
    }
  };

  const limitUntil = (instanceId: string, accountId: string): number =>
    state.limitedUntil[instanceId]?.[accountId] ?? 0;

  return {
    enabled(instanceId: string): boolean {
      prune();
      return state.enabled[instanceId] === true;
    },

    setEnabled(instanceId: string, on: boolean): void {
      prune();
      if (state.enabled[instanceId] === on) return;
      state.enabled[instanceId] = on;
      save();
    },

    onTurnFailed(instanceId: string, errorText: string): AutoSwitchOutcome {
      prune();
      if (state.enabled[instanceId] !== true) return { switched: false, instanceId, why: "disabled" };
      const reason = isLimitFailure(errorText);
      if (!reason) return { switched: false, instanceId, why: "not_limit_error" };
      let view: ServiceAccountsView;
      try {
        view = deps.view(instanceId);
      } catch {
        return { switched: false, instanceId, why: "unsupported" };
      }
      if (!view.supported) return { switched: false, instanceId, why: "unsupported" };
      // The live sign-in is no longer the saved snapshot: someone logged in by hand, and a switch here
      // would overwrite it.
      if (view.drifted) return { switched: false, instanceId, why: "drifted" };

      const accounts = view.accounts;
      const active = view.activeId ? accounts.find((account) => account.id === view.activeId) ?? null : null;
      const startIndex = active ? accounts.indexOf(active) + 1 : 0;
      if (active) {
        const perAccount = state.limitedUntil[instanceId] ?? {};
        perAccount[active.id] = now() + cooldownMs;
        state.limitedUntil[instanceId] = perAccount;
        save();
      }
      const at = now();
      for (let offset = 0; offset < accounts.length; offset += 1) {
        const candidate = accounts[(startIndex + offset) % accounts.length]!;
        if (limitUntil(instanceId, candidate.id) > at) continue;
        try {
          deps.switchTo(instanceId, candidate.id);
        } catch {
          return { switched: false, instanceId, why: "switch_failed" };
        }
        return {
          switched: true,
          instanceId,
          from: active ? { id: active.id, label: active.label } : null,
          to: { id: candidate.id, label: candidate.label },
          reason,
        };
      }
      return { switched: false, instanceId, why: "no_other_account" };
    },

    status(instanceId: string): { enabled: boolean; limited: Array<{ accountId: string; until: number }> } {
      prune();
      return {
        enabled: state.enabled[instanceId] === true,
        limited: Object.entries(state.limitedUntil[instanceId] ?? {})
          .map(([accountId, until]) => ({ accountId, until }))
          .sort((a, b) => a.until - b.until),
      };
    },
  };
}
