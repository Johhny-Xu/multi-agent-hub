import { useEffect, useState } from "react";

import { api } from "@/state/store";
import { HIGHLEVEL_API, isHighLevelStatus, type HighLevelStatus } from "./highlevel-sign-in";

// Bot settings read the same answer the Connected apps card last saw, so the
// per-bot app list does not re-ask the server on every open.
let cached: HighLevelStatus | null = null;
let cachedAt = 0;
let request: Promise<HighLevelStatus | null> | null = null;
const CACHE_MS = 30_000;

/** The HighLevel connection as the server reports it; null when it could not be asked. */
export function preloadHighLevelStatus(force = false): Promise<HighLevelStatus | null> {
  if (!force && cached !== null && Date.now() - cachedAt < CACHE_MS) return Promise.resolve(cached);
  if (request) return request;
  request = api(HIGHLEVEL_API)
    .then((response) => (isHighLevelStatus(response) ? rememberHighLevelStatus(response) : null))
    .catch(() => null)
    .finally(() => {
      request = null;
    });
  return request;
}

export function rememberHighLevelStatus(status: HighLevelStatus): HighLevelStatus {
  cached = status;
  cachedAt = Date.now();
  return status;
}

export function forgetHighLevelStatus(): void {
  cached = null;
  cachedAt = 0;
}

export function highLevelConnected(status: HighLevelStatus | null | undefined): boolean {
  return status?.state === "connected";
}

export function useHighLevelStatus(): HighLevelStatus | null {
  const [status, setStatus] = useState<HighLevelStatus | null>(cached);
  useEffect(() => {
    let cancelled = false;
    void preloadHighLevelStatus().then((result) => {
      if (!cancelled) setStatus(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return status;
}
