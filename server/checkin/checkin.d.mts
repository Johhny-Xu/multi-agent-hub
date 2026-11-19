// Type declarations for the check-in modules ported verbatim from the console
// (git tag webui-final-20261107). Only the surface the bridge calls is typed.

export interface CheckinOverview {
  ok: boolean;
  today: string;
  autoCheckin: boolean;
  autoCheckinTime: string;
  platforms: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export interface CheckinRunResult {
  ok: boolean;
  results: Record<string, unknown>;
  overview: CheckinOverview;
  due?: string[];
}

export const OPEN_SOURCE_PROJECTS: Record<string, unknown[]>;
export const CHECKIN_PLATFORMS: string[];

export function getCheckinOverview(): Promise<CheckinOverview>;
export function runCheckin(target?: string): Promise<CheckinRunResult>;
export function clearCheckinHistory(): Promise<unknown>;
export function updateCheckinConfig(config: Record<string, unknown>): Promise<unknown>;
export function startAutoCheckinScheduler(): void;
export function stopAutoCheckinScheduler(): void;
export function runAutoCheckinTick(): Promise<string[]>;

export interface CodeArtsCampaignGroups {
  claimable: Array<Record<string, any>>;
  claimed: Array<Record<string, any>>;
  upcoming: Array<Record<string, any>>;
  ineligible: Array<Record<string, any>>;
}
export function classifyCodeArtsCampaigns(items?: unknown[], nowSec?: number): CodeArtsCampaignGroups;
export function checkinCodeArtsOne(ak: string, sk: string, deps?: {
  fetch?: (ak: string, sk: string, method: string, url: string, body?: any) => Promise<{ status: number; json: any; text: string }>;
  nowSec?: number;
}): Promise<{ ok: boolean; status: string; message: string; credits?: number; consecutiveDays?: number; retryAt?: number; pendingReason?: string }>;
