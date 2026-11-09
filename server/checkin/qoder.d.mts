// Type declarations for qoder.mjs. Only the surface the check-in tests import
// is typed; the credential-file payloads stay loose.

export interface QoderDeviceRisk {
  machineToken: string;
  machineCode: string;
  machineType: string;
  [key: string]: unknown;
}

export interface QoderDevice {
  worker?: string;
  clientVersion?: string;
  machineOs?: string;
  machineId?: string;
  machineHostname?: string;
  risk?: QoderDeviceRisk | null;
  source: string;
  note: string;
  [key: string]: unknown;
}

export interface QoderCredentialEntry {
  token: string;
  refreshToken: string;
  expiresAt: number;
  identity: string;
  display?: string;
  format?: string;
  source?: string;
  [key: string]: unknown;
}

export interface QoderCredentialResult {
  ok: boolean;
  file: string;
  saltFile: string;
  entries: QoderCredentialEntry[];
  primary: QoderCredentialEntry | null;
  region?: unknown;
  reason?: string;
  error?: string;
}

export function encryptLegacyQoderUser(plain: string, machineId: string): string;
export function readQoderCredential(home: string, worker?: string): Promise<QoderCredentialResult>;
export function readQoderCredentialAt(dir: string, worker?: string): Promise<QoderCredentialResult>;
export function persistQoderToken(input: {
  credFile: string;
  saltFile: string;
  identity: string;
  token: string;
  refreshToken?: string;
  expiresAt?: number;
}): Promise<boolean>;
export function qoderHeaders(worker: string, token: string, device?: QoderDevice | null): Record<string, string>;
