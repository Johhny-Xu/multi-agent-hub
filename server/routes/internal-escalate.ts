import type { EscalationOutcome } from "../host/chief-notices.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

const WAIT = "Say plainly that you stopped at this gate and why, then end your turn and wait; do not retry the gated work until the person lifts the gate.";

/** Only dispatch inside the internal capability gate, with its guarded body reader. */
export function createInternalEscalateRoutes(deps: {
  readBody(): ReturnType<RouteContext["readBody"]>;
  requireActive(): void;
  report(reason: string): EscalationOutcome;
}): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method !== "POST" || path !== "/api/internal/escalate") return PASS;
    const body = await deps.readBody();
    const raw = body && typeof body === "object" && !Array.isArray(body) ? body.reason : undefined;
    const reason = typeof raw === "string" ? raw.trim().slice(0, 500) : "";
    if (!reason) {
      return json(res, 400, { error: "raise_escalation needs reason: one line saying what you need from the person and why your work is parked on it" });
    }
    deps.requireActive();
    const outcome = deps.report(reason);
    if (outcome === "off" || outcome === "skipped") return json(res, 404, { error: "escalations are switched off on this server; say in your reply what you need from the person" });
    if (outcome === "failed") return json(res, 500, { error: `the escalation could not be delivered. ${WAIT}` });
    if (outcome === "muted") {
      return json(res, 429, { error: "this conversation has already raised several escalations in the last hour; the person was told about the first ones. Finish your turn and wait — do not keep flagging the same gate." });
    }
    return json(res, 200, {
      escalated: true,
      message: outcome === "chief" ? `your Chief of Staff was told in its Team escalations thread. ${WAIT}` : `the person was told directly. ${WAIT}`,
    });
  };
}
