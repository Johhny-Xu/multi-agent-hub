// In-process check-in API, replacing the loopback proxy to the console's /api/checkin/*.
// The implementations are the console's own modules, ported verbatim into this directory.
import {
  OPEN_SOURCE_PROJECTS,
  clearCheckinHistory,
  getCheckinOverview,
  runCheckin,
  startAutoCheckinScheduler,
  updateCheckinConfig,
} from "./checkin.mjs";
import { doubaoLoginPoll, doubaoLoginStart } from "./doubao-checkin.mjs";
import { dumateLoginPoll, dumateLoginStart, listDumateAccounts, removeDumateAccount } from "./dumate.mjs";

export interface CheckinApi {
  status(): Promise<unknown>;
  projects(): unknown;
  run(target: string): Promise<unknown>;
  clearHistory(): Promise<unknown>;
  config(body: Record<string, unknown>): Promise<unknown>;
  /** Doubao QR sign-in in the cloud browser (FEAT-doubao-checkin): start shows a QR, status polls for the scan. */
  doubaoLoginStart(): Promise<{ ok: boolean; loggedIn: boolean; qrPng?: string; error?: string }>;
  doubaoLoginStatus(): Promise<{ ok: boolean; loggedIn: boolean; error?: string }>;
  /** DuMate (百度搭子) QR sign-in in the shared browser (FEAT-dumate): start hands back the Baidu login page's QR, status
   * polls until the scan lands and the cookie is saved on this server. Accounts never leave the server with a cookie. */
  dumateLoginStart(): Promise<{ ok: boolean; loggedIn: boolean; qrPng?: string; error?: string }>;
  dumateLoginStatus(): Promise<{ ok: boolean; loggedIn: boolean; error?: string; stage?: string }>;
  dumateAccounts(): Promise<{ ok: boolean; accounts: Array<Record<string, unknown>> }>;
  dumateRemoveAccount(id: string): Promise<{ ok: boolean }>;
}

export function createCheckinApi(): CheckinApi {
  return {
    status: () => getCheckinOverview(),
    projects: () => ({ ok: true, projects: OPEN_SOURCE_PROJECTS }),
    run: (target) => runCheckin(target),
    clearHistory: () => clearCheckinHistory(),
    config: (body) => updateCheckinConfig(body),
    doubaoLoginStart: () => doubaoLoginStart(),
    doubaoLoginStatus: () => doubaoLoginPoll(),
    dumateLoginStart: () => dumateLoginStart(),
    dumateLoginStatus: () => dumateLoginPoll(),
    dumateAccounts: async () => ({ ok: true, accounts: await listDumateAccounts() }),
    dumateRemoveAccount: (id) => removeDumateAccount(id),
  };
}

let started = false;

/**
 * Started by createHubBridgeRoutes, the one place index.ts already wires: the auto
 * check-in timer has to run without anyone opening the Daily page, and its timers
 * are unref'd, so it neither holds the process open nor keeps a test alive.
 */
export function ensureCheckinScheduler(): void {
  if (started) return;
  started = true;
  startAutoCheckinScheduler();
}
