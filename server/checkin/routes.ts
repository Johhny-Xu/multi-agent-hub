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

export interface CheckinApi {
  status(): Promise<unknown>;
  projects(): unknown;
  run(target: string): Promise<unknown>;
  clearHistory(): Promise<unknown>;
  config(body: Record<string, unknown>): Promise<unknown>;
}

export function createCheckinApi(): CheckinApi {
  return {
    status: () => getCheckinOverview(),
    projects: () => ({ ok: true, projects: OPEN_SOURCE_PROJECTS }),
    run: (target) => runCheckin(target),
    clearHistory: () => clearCheckinHistory(),
    config: (body) => updateCheckinConfig(body),
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
