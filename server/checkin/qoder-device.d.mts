// Type declarations for qoder-device.mjs. Only the surface the device
// regression tests import is typed.

import type { QoderDevice, QoderDeviceRisk } from './qoder.mjs';

export const QODER_DEFAULT_CLIENT_VERSION: string;
export const QODER_UMID_RUNTIME_ENV: Record<string, number>;
export const QODER_UMID_CLI_RUNTIME_ENV: { qoder: number; 'qoder-cn': number };

export function qoderMachineOs(): string;
export function qoderMachineHostname(raw?: string): string;
export function readQoderMachineId(home: string, worker?: string): Promise<string>;
export function qoderResourceDirs(home: string, worker?: string): string[];
export function detectQoderClientVersion(home: string, worker?: string): Promise<string>;
export function findCliUmid(home: string, worker: string): Promise<{ path: string; source: string; env: number; [key: string]: unknown } | null>;
export function findQoderUmidComponent(home?: string, worker?: string): Promise<{ path: string; source: string; env: number; [key: string]: unknown } | null>;
export function runQoderUmidComponent(componentPath: string, env: number, uid?: string): Promise<QoderDeviceRisk>;
export function readTarGzEntry(buffer: Buffer, wanted?: string): Buffer | null;
export function extractUmidElf(bundleText: string, machine: number): Buffer | null;
export function installQoderUmidComponent(home?: string, worker?: string): Promise<{ path: string; source: string; env: number; [key: string]: unknown }>;
export function resolveQoderDevice(worker?: string, opts?: { home?: string; uid?: string }): Promise<QoderDevice>;
export function resetQoderDeviceCache(): void;
