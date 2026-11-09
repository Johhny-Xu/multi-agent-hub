// Type declarations for vendor-quota.mjs. Only the surface the tests and the
// hub-bridge quota fallback import is typed; the vendor payloads stay loose.

export interface QuotaRow {
  name: string;
  displayName?: string;
  used?: number;
  total?: number;
  remaining?: number | null;
  remainingPercentage?: number;
  unit?: string;
  unlimited?: boolean;
  resetAt?: string | null;
  [key: string]: unknown;
}

export interface QuotaAnswer {
  account?: string | null;
  plan?: string;
  quotas?: QuotaRow[];
  message?: string;
  [key: string]: unknown;
}

export const QUOTA_WORKERS: string[];
export const ANTIGRAVITY_DISPLAY_KEYS: string[];

export function normalizeQuotas(quotas: Record<string, unknown> | Array<Record<string, unknown>>): Array<Record<string, unknown>>;
export function fetchJsonSmart(url: unknown, options?: RequestInit, timeoutMs?: number): Promise<Response>;
export function hwsSdkSignedHeaders(ak: string, sk: string, method: string, rawUrl: string, body: unknown, extra?: Record<string, unknown>): Record<string, string>;
export function parseZcodeBalance(json: unknown): {
  enterprise: boolean;
  buckets: Array<{
    planId: string | null;
    showName: string | null;
    unitType: string | null;
    total: number;
    used: number;
    remaining: number | null;
    expiresAt: string | null;
    models: string[];
    [key: string]: unknown;
  }>;
} | null;
export function parseGlmQuotaLimits(json: unknown): { plan: string; quotas: Record<string, QuotaRow> };
export function parseMinimaxCreditDetails(json: unknown): {
  balance: number;
  packages: Array<{ name: string; remaining: number; expireAt: string | null; [key: string]: unknown }>;
  error?: string;
  [key: string]: unknown;
} | null;
export function parseAntigravityWeeklySummary(data: unknown): Record<string, QuotaRow>;
export function antigravityModelQuotas(data: unknown): Record<string, QuotaRow>;
export function clineBearerValue(accessToken: string): string;
export function parseClineUsageLimits(value: unknown): { windows: Array<{ type: string; percentUsed: number; resetsAt: string }>; error?: string };
export function parsePerchAccount(json: unknown): { planCode: string | null; planName: string | null; dailyPt: number | null } | null;
export function resolveZcodeDeviceMid(home?: string): Promise<{ deviceMid: string; source: string; [key: string]: unknown }>;
export function zcodeQuotaHeaders(deviceMid: string, authorization?: string): Record<string, string>;
export function fetchZcodeQuota(tokenObj: unknown): Promise<QuotaAnswer>;
export function fetchMiniMaxQuota(token: unknown): Promise<QuotaAnswer>;
export function fetchAntigravityQuota(tokenObj: unknown): Promise<QuotaAnswer>;
export function fetchClineQuota(tokenObj: unknown): Promise<QuotaAnswer>;
export function fetchPerchQuota(tokenObj: unknown): Promise<QuotaAnswer>;
export function clearQuotaCache(worker: string): void;
export function getQuota(worker: string, opts?: { force?: boolean }): Promise<QuotaAnswer>;
export function getAllQuotas(opts?: { force?: boolean }): Promise<{ updatedAt: string; workers: Record<string, unknown>; [key: string]: unknown }>;
