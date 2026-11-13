// Type declarations for dumate.mjs (FEAT-dumate). Only the surface the driver, the bridge and the tests use is typed.

export interface DumateAccount { id: string; uid?: string; name?: string; cookie: string; source?: string; addedAt?: number; expired?: boolean; [key: string]: unknown }
export interface DumatePublicAccount { id: string; name: string; uid: string; source: string; addedAt: number; expired: boolean }
export interface WebAnswer { ok: boolean; status: number; expired: boolean; code: number | null; message: string; result: any }
export interface QuotaOverview {
  total: number; used: number; left: number; throttled: boolean; subscribed: boolean;
  soonest: { expireAt: number; points: number } | null;
  packages: Array<{ kind: string; source: string; total: number; used: number; left: number; expireAt: number | null; active: boolean }>;
}
export interface LoginAnswer { ok: boolean; loggedIn: boolean; qrPng?: string; error?: string; stage?: string; account?: string }

export const WEB_BASE: string;
export const CONSOLE_BASE: string;
export const GATEWAY_URL: string;
export const LOGIN_URL: string;
export const CDP_URL: string;
export const RELOGIN_HINT: string;

export function maskName(value: unknown): string;
export function loadStore(): Promise<{ accounts: DumateAccount[] }>;
export function publicAccount(a: DumateAccount): DumatePublicAccount;
export function listDumateAccounts(): Promise<DumatePublicAccount[]>;
export function getDumateAccount(id?: string): Promise<DumateAccount | null>;
export function saveDumateAccount(a: { cookie: string; uid?: string; name?: string; source?: string }): Promise<DumatePublicAccount>;
export function removeDumateAccount(id: string): Promise<{ ok: boolean }>;
export function markDumateExpired(id: string, expired: boolean): Promise<void>;
export function classifyWebAnswer(status: number, json: unknown, location?: string): { ok: boolean; expired: boolean; code: number | null; message: string };
export function webCall(cookie: string, method: string, path: string, opts?: { base?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; fetch?: typeof fetch }): Promise<WebAnswer>;
export function userInfo(cookie: string, opts?: Record<string, unknown>): Promise<{ ok: true; uid: string; name: string } | { ok: false; expired: boolean; error: string }>;
export function loginBonusInfo(cookie: string, opts?: Record<string, unknown>): Promise<{ ok: true; hasIssued: boolean; totalPoints: number; totalTimes: number } | { ok: false; expired: boolean; error: string }>;
export function csrfFromCookie(cookie: string): string;
export function claimLoginBonus(cookie: string, opts?: Record<string, unknown>): Promise<{ ok: boolean; expired: boolean; error: string }>;
export function parseQuotaOverview(o: unknown): QuotaOverview;
export function quotaOverview(cookie: string, opts?: Record<string, unknown>): Promise<({ ok: true } & QuotaOverview) | { ok: false; expired: boolean; error: string }>;
export function forgetDumateToken(id: string): void;
export function gatewayToken(account: DumateAccount, opts?: { force?: boolean; noMark?: boolean; fetch?: typeof fetch }): Promise<{ ok: true; token: string; expiresAt: number } | { ok: false; expired: boolean; error: string }>;
export function balanceText(q: unknown): string;
export function listDumateCheckinAccounts(): Promise<Array<Record<string, unknown>>>;
export function checkinDumateAccount(account: DumateAccount, deps?: Record<string, any>): Promise<{ row: Record<string, any>; expired?: boolean; credits?: number; days?: number }>;
export function checkinDumate(deps?: Record<string, any>): Promise<Record<string, any>>;
export function fetchDumateQuota(deps?: Record<string, any>): Promise<Record<string, any>>;
export function cookieHeaderFrom(cookies: Array<{ name: string; value: string; domain?: string }>): { stage: "need_login" | "need_console" | "ready"; header: string };
export function wantsIsolatedContext(accounts: Array<{ source?: string; expired?: boolean }>): boolean;
export function cdpConnect(cdpUrl?: string, deps?: Record<string, any>): Promise<{ call(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<any>; close(): void }>;
export function dumateLoginStart(deps?: Record<string, any>): Promise<LoginAnswer>;
export function dumateLoginPoll(deps?: Record<string, any>): Promise<LoginAnswer>;
