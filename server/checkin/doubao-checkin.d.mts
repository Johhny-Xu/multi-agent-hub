// Type declarations for doubao-checkin.mjs (FEAT-doubao-checkin). Only the surface the bridge and tests use is typed.

export interface DoubaoSignerResult { ok?: boolean; loggedIn?: boolean; error?: string; [key: string]: unknown }
export type DoubaoRunner = (cmd: string, opts?: { timeoutMs?: number }) => Promise<DoubaoSignerResult>;
export interface DoubaoDeps { runSigner?: DoubaoRunner; today?: string; time?: string }

export function signerCommand(env?: Record<string, string | undefined>): string[];
export function lastJsonLine(text: string): Record<string, unknown> | null;
export function runSigner(cmd: string, opts?: { timeoutMs?: number; env?: Record<string, string | undefined> }): Promise<DoubaoSignerResult>;
export function readDoubaoLogin(): Promise<{ loggedIn: boolean; checkedAt: number }>;
export function listDoubaoAccounts(): Promise<Array<Record<string, unknown>>>;
export function describeSignerError(error: unknown): string;
export function doubaoOutcome(r: unknown, today: string, time: string): Record<string, any>;
export function checkinDoubao(deps?: DoubaoDeps): Promise<Record<string, any>>;
export function doubaoLoginStart(deps?: DoubaoDeps): Promise<{ ok: boolean; loggedIn: boolean; qrPng?: string; error?: string }>;
export function doubaoLoginPoll(deps?: DoubaoDeps): Promise<{ ok: boolean; loggedIn: boolean; error?: string }>;
