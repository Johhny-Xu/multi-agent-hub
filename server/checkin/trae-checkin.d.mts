// Type declarations for trae-checkin.mjs. Only the surface the daily
// check-in tests import is typed.

export interface TraeAccount {
  token: string;
  refreshToken?: string;
  uid?: string;
  privateKeyPem?: string;
  publicKeyPem?: string;
  machineId?: string;
  deviceId?: string;
  [key: string]: unknown;
}

export function encryptTraeStorageValue(plain: string, opts?: { private?: boolean }): string;
export function decryptTraeStorageValue(base64Value: string): string;
export function traeStorageCandidates(home?: string): string[];
export function traeDeviceIdOfStorage(storage: Record<string, unknown>): string;
export function generatedTraeDeviceId(seed: string): string;
export function resolveTraeDeviceId(account?: { uid?: string; token?: string; [key: string]: unknown }, opts?: { home?: string; used?: Set<unknown> | null; cache?: unknown; usedDeviceIds?: unknown }): Promise<string>;
export function resetTraeDeviceCache(): void;
export function traeHeaders(token: string, deviceId: string): Record<string, string>;
export function jwtExpiry(token: string): number;
export function normalizeDerLowS(der: Buffer): Buffer;
export function checkinTraeAccount(account: TraeAccount, opts?: { home?: string; cache?: unknown; usedDeviceIds?: unknown }): Promise<{
  ok?: boolean;
  status: string;
  message: string;
  credits?: number;
  consecutiveDays?: number;
  deviceId?: string;
  [key: string]: unknown;
}>;
