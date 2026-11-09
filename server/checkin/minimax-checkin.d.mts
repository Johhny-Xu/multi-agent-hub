// Type declarations for minimax-checkin.mjs. Only the surface the daily
// check-in tests import is typed.

export interface MiniMaxCredential {
  token: string;
  refreshToken: string;
  expiresAtMs: number;
  clientId: string;
  recordKey?: string;
  region?: string;
  status?: string;
  file?: string;
  source: string;
  [key: string]: unknown;
}

export interface MiniMaxCheckinResult {
  ok?: boolean;
  status: string;
  message: string;
  credits?: number;
  consecutiveDays?: number;
  region?: string;
  credentialVersion?: string;
  source: string;
  [key: string]: unknown;
}

export const MINIMAX_REGIONS: Record<string, { key?: string; name?: string; authDir: string; [key: string]: unknown }>;

export function minimaxAuthDir(baseHome: string, region?: string): string;
export function readMinimaxCredential(baseHome?: string, region?: string): Promise<MiniMaxCredential | null>;
export function readMinimaxCredentialFile(file: string, region?: string): Promise<MiniMaxCredential | null>;
export function minimaxCredentialVersion(cred?: { token?: string; refreshToken?: string } | null): string;
export function checkinMiniMax(region?: string, override?: string | MiniMaxCredential | null): Promise<MiniMaxCheckinResult>;
export function fetchMiniMaxSignin(region?: string): Promise<{
  ok?: boolean;
  panel: unknown;
  phase?: string;
  status?: number;
  message: string;
  [key: string]: unknown;
}>;
