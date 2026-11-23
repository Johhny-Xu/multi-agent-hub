/** Product telemetry is off: nothing here loads a client, reads a preference or sends a request. The exports stay so callers
 * keep their shape, and every one of them is a no-op. */

export function analyticsEnabled(): boolean {
  return false;
}

export function setAnalyticsEnabled(_enabled: boolean): void {}

export function initAnalytics(): Promise<void> {
  return Promise.resolve();
}

export function track(_event: string, _props?: Record<string, unknown>): void {}

/** Which page this is: the desktop app's own page, or a server's. Telemetry is off either way; the export exists
 * so upstream's call sites (the sign-in gate) keep their shape without a telemetry client. */
export function analyticsSurface(): "local" | "server" {
  return globalThis.window?.ogb?.environments ? "local" : "server";
}

const GATE_KEY = "omb-email-gate";
export function emailGateDone(): boolean {
  return Boolean(localStorage.getItem(GATE_KEY));
}
export function setEmailGateDone(status: "submitted" | "skipped") {
  localStorage.setItem(GATE_KEY, status);
}
