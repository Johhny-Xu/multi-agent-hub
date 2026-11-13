// Type declarations for quota-deep.mjs. Only the surface the tests and the
// hub-bridge quota fallback import is typed.

export function traePacksSummary(packs: unknown): { total: number; used: number; unlimited: boolean; [key: string]: unknown } | null;
export function getDeepQuota(worker: string): Promise<unknown>;
export function readQoderQuotaUsageJson(
  worker: string,
  token: string,
  device?: unknown,
  deps?: { fetchJson?: (url: string, options?: { headers: Record<string, string> }) => Promise<{ status: number; ok: boolean; json: unknown }> },
): Promise<Record<string, unknown> | null>;
export const DEEP_WORKERS: string[];
export function isDeepQuotaWorker(worker: string): boolean;
