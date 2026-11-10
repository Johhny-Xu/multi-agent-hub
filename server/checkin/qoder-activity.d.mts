// Type declarations for qoder-activity.mjs (C2-W3: helpers moved verbatim out of checkin.mjs).
// Only the surface checkin.mjs and the qoder tests use is typed.

export interface QoderCampaignRow {
  campaignId?: string;
  campaign_id?: string;
  actionType?: string;
  action_type?: string;
  claimStatus?: string;
  claim_status?: string;
  startAt?: number | string;
  endAt?: number | string;
  [key: string]: unknown;
}

export interface QoderWindow { start: number; end: number; nextStart: number }
export interface QoderQuotaCooldown { kind: string; seconds: number }
export interface QoderPendingWindow { retryAt: number; message: string }
export interface QoderClaimOutcome { status: string; kind?: string; message?: string; cooldownSeconds?: number; [key: string]: unknown }

export const QODER_BENEFIT_ACTION: string;

export function extractQoderCampaigns(payload: unknown): QoderCampaignRow[];
export function qoderClaimStatus(row: QoderCampaignRow): string;
export function qoderEpoch(value: unknown): number;
export function qoderInWindow(row: QoderCampaignRow, nowSec?: number): boolean;
export function qoderDayKey(sec: number): string;
export function qoderWindowDay(row: QoderCampaignRow): string;
export function qoderClaimedToday(row: QoderCampaignRow, nowSec?: number): boolean;
export function qoderTodayWindowStart(nowSec?: number): number;
export function qoderNextWindowStart(row: QoderCampaignRow): number;
export function qoderPendingWindow(staleClaimed: QoderCampaignRow[], nowSec?: number): QoderPendingWindow | null;
export function qoderClock(sec: number): string;
export function qoderClockDay(sec: number): string;
export function qoderOpenWindow(nowSec?: number): QoderWindow;
export function qoderPollAt(nowSec: number, win?: QoderWindow): number;
export function qoderResponseMessage(res: unknown): string;
export function qoderBenefit(item: unknown): number;
export function qoderQuotaCooldown(res: unknown): QoderQuotaCooldown;
export function qoderAuthDead(res: unknown): boolean;
export function qoderClaimOutcome(res: unknown): QoderClaimOutcome;
