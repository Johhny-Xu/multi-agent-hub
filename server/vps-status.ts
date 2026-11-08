// What the last health check found about each managed computer, kept between restarts so the list shows the last answer.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { redactSecretsInText } from "../shared/redact.ts";
import type { VpsCheckStatus } from "../shared/vps.ts";
import { writeFileAtomic } from "./atomic.ts";

export interface VpsStatusStore {
  /** The last check of one computer, or undefined when it has never been checked. */
  get(id: string): VpsCheckStatus | undefined;
  /** Remembers a check and returns the remembered result, scrubbed of anything secret. */
  set(id: string, status: VpsCheckStatus): VpsCheckStatus;
  /** Forgets every computer that is no longer listed. */
  prune(liveIds: readonly string[]): void;
}

const MAX_ERROR_CHARS = 200;

/** A short reason a check failed: one line, no secret, short enough to show in a list row. */
export function vpsErrorText(message: string | undefined): string {
  const text = (message ?? "").replace(/[\r\n\t]+/g, " ").trim();
  if (!text) return "";
  return redactSecretsInText(text).slice(0, MAX_ERROR_CHARS);
}

function statusOf(value: unknown): VpsCheckStatus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.online !== "boolean" || typeof raw.checkedAt !== "string") return undefined;
  const latencyMs = typeof raw.latencyMs === "number" && Number.isFinite(raw.latencyMs) ? Math.max(0, Math.round(raw.latencyMs)) : undefined;
  const error = typeof raw.error === "string" ? vpsErrorText(raw.error) : "";
  return {
    online: raw.online,
    ...(latencyMs === undefined ? {} : { latencyMs }),
    checkedAt: raw.checkedAt,
    ...(error ? { error } : {}),
  };
}

/** The file is a cache of the last answer, not the answer itself: a missing or broken file means no memory, never an error. */
export function createVpsStatusStore(file?: string): VpsStatusStore {
  const statuses = new Map<string, VpsCheckStatus>();
  let loaded = false;

  const load = () => {
    if (loaded) return;
    loaded = true;
    if (!file) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      const status = statusOf(value);
      if (status) statuses.set(id, status);
    }
  };

  const save = () => {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileAtomic(file, JSON.stringify(Object.fromEntries(statuses), null, 2), { mode: 0o600 });
    } catch {
      // A status that cannot be written is still shown now; it is forgotten on the next restart.
    }
  };

  return {
    get(id) {
      load();
      return statuses.get(id);
    },
    set(id, status) {
      load();
      const error = status.error === undefined ? "" : vpsErrorText(status.error);
      const remembered: VpsCheckStatus = {
        online: status.online,
        ...(status.latencyMs === undefined ? {} : { latencyMs: Math.max(0, Math.round(status.latencyMs)) }),
        checkedAt: status.checkedAt,
        ...(error ? { error } : {}),
      };
      statuses.set(id, remembered);
      save();
      return remembered;
    },
    prune(liveIds) {
      load();
      const live = new Set(liveIds);
      let changed = false;
      for (const id of [...statuses.keys()]) {
        if (!live.has(id)) {
          statuses.delete(id);
          changed = true;
        }
      }
      if (changed) save();
    },
  };
}
