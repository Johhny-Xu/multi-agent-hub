// GET /api/instances/antigravity-accounts — every Antigravity account as one list (the primary plus the ones
// added in Settings). POST /api/instances/antigravity-account-switch, body { accountInstanceId } — makes one of
// them the account the primary runs as. Adding and removing stay on the routes that already own them.
import { z } from "zod";
import type { InstanceConfigMap } from "../contracts.ts";
import { antigravityAccountsView, isAntigravityAccountInstance, switchAntigravityAccount } from "../antigravity-accounts.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface AntigravityAccountListDeps {
  instances(): InstanceConfigMap;
  /** The engine list probes each CLI again after a switch. */
  refresh(): void;
  /** After a switch: idle CLI processes still run under the account just switched away from. */
  reclaim(instanceId: string): void;
  exclusive<T>(work: () => Promise<T>): Promise<T> | null;
}

const LIST = "/api/instances/antigravity-accounts";
const SWITCH = "/api/instances/antigravity-account-switch";
const switchBody = z.object({ accountInstanceId: z.string().min(1).max(200) });

export function createAntigravityAccountListRoutes(deps: AntigravityAccountListDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (path === LIST) {
      if (method !== "GET") return PASS;
      res.setHeader("cache-control", "no-store");
      return json(res, 200, { accounts: await antigravityAccountsView(deps.instances()) });
    }
    if (path !== SWITCH) return PASS;
    if (method !== "POST") return PASS;
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return json(res, 415, { error: "content-type must be application/json" });
    }
    const parsed = switchBody.safeParse(await readBody(req, 8192));
    if (!parsed.success) return json(res, 400, { error: "Select an Antigravity account to switch to." });
    const answered = deps.exclusive(async () => {
      const instances = deps.instances();
      if (!isAntigravityAccountInstance(instances, parsed.data.accountInstanceId)) {
        return json(res, 404, { error: "That Antigravity account is gone." });
      }
      try {
        switchAntigravityAccount(instances, parsed.data.accountInstanceId);
      } catch (error) {
        const status = (error as { status?: number }).status ?? 500;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
      deps.reclaim("antigravity");
      deps.refresh();
      return json(res, 200, { accounts: await antigravityAccountsView(instances) });
    });
    if (!answered) return json(res, 409, { error: "provider settings are already being updated" });
    return answered;
  };
}
