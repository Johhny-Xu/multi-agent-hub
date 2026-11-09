// Switching an engine's signed-in account: the snapshots live in this server's data folder, so a
// hosted workspace that does not own the CLI cannot change them.
import type { InstanceConfig } from "../contracts.ts";
import {
  removeServiceAccount, saveServiceAccount, serviceAccountsView, switchServiceAccount,
  type ServiceAccountsView,
} from "../service-accounts.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ServiceAccountRouteDeps {
  instance(instanceId: string): InstanceConfig | undefined;
  /** A turn on this engine keeps a process (and its tokens) alive; switching now would not reach it. */
  busy(instanceId: string): boolean;
  readOnly(): boolean;
  /** The engine list probes each CLI again after a switch. */
  refresh(): void;
  /** After a switch: idle CLI processes of this engine still run under the account just switched away from. */
  reclaim(instanceId: string): void;
  /** Per-engine quota auto-switch state; absent when the host does not wire the feature. */
  autoSwitch?: {
    enabled(id: string): boolean;
    setEnabled(id: string, on: boolean): void;
    status(id: string): { enabled: boolean; limited: Array<{ accountId: string; until: number }> };
  };
  /** Tests keep snapshots in their own folder. */
  root?: string;
}

const PATH = /^\/api\/instances\/([\w.-]+)\/service-accounts(?:\/([a-f0-9-]{36})(\/switch)?)?$/;
const AUTO_SWITCH_PATH = /^\/api\/instances\/([\w.-]+)\/service-accounts\/auto-switch$/;

const AUTO_SWITCH_UNAVAILABLE = { enabled: false, limited: [] as Array<{ accountId: string; until: number }>, available: false };

let pending: Promise<unknown> = Promise.resolve();

function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = pending.then(work, work);
  pending = next.catch(() => undefined);
  return next;
}

export function createServiceAccountRoutes(deps: ServiceAccountRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const autoSwitchMatch = AUTO_SWITCH_PATH.exec(path);
    if (autoSwitchMatch) {
      const instanceId = autoSwitchMatch[1]!;
      if (!deps.instance(instanceId)) return json(res, 404, { error: "Unknown engine." });
      if (method !== "GET" && method !== "PUT") return PASS;
      if (method === "GET") {
        return json(res, 200, { autoSwitch: deps.autoSwitch ? deps.autoSwitch.status(instanceId) : AUTO_SWITCH_UNAVAILABLE });
      }
      if (deps.readOnly()) return json(res, 403, { error: "Engine settings are managed by this workspace." });
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req, 8192);
      const enabled = body && typeof body === "object" ? (body as { enabled?: unknown }).enabled : undefined;
      if (typeof enabled !== "boolean") return json(res, 400, { error: "enabled must be true or false." });
      if (deps.autoSwitch) deps.autoSwitch.setEnabled(instanceId, enabled);
      return json(res, 200, { autoSwitch: deps.autoSwitch ? deps.autoSwitch.status(instanceId) : AUTO_SWITCH_UNAVAILABLE });
    }
    const match = PATH.exec(path);
    if (!match) return PASS;
    const instanceId = match[1]!;
    const accountId = match[2];
    const switching = match[3] !== undefined;
    const entry = deps.instance(instanceId);
    if (!entry) return json(res, 404, { error: "Unknown engine." });

    if (method === "GET" && !accountId) {
      return json(res, 200, { accounts: serviceAccountsView(instanceId, entry, deps.root) });
    }
    if (method !== "POST" && method !== "DELETE") return PASS;
    if (method === "POST" && accountId && !switching) return json(res, 404, { error: "Unknown saved account." });
    if (method === "DELETE" && (!accountId || switching)) return json(res, 404, { error: "Unknown saved account." });
    if (deps.readOnly()) return json(res, 403, { error: "Engine settings are managed by this workspace." });
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return json(res, 415, { error: "content-type must be application/json" });
    }
    if (deps.busy(instanceId)) {
      return json(res, 409, { error: "Wait for this engine's tasks to finish, then try again." });
    }
    try {
      let switched = false;
      const view = await exclusive(async (): Promise<ServiceAccountsView> => {
        if (method === "DELETE") return removeServiceAccount(instanceId, entry, accountId!, deps.root);
        if (switching) {
          const before = serviceAccountsView(instanceId, entry, deps.root).activeId;
          const next = switchServiceAccount(instanceId, entry, accountId!, deps.root);
          switched = next.activeId !== before;
          return next;
        }
        const body = await readBody(req, 8192);
        const label = body && typeof body === "object" && typeof (body as { label?: unknown }).label === "string"
          ? (body as { label: string }).label : undefined;
        return saveServiceAccount(instanceId, entry, label, deps.root);
      });
      // A switch changes which account the CLI reports, and the processes started before it still hold the old one.
      if (switched) {
        deps.reclaim(instanceId);
        deps.refresh();
      }
      return json(res, 200, { accounts: view });
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      return json(res, typeof status === "number" ? status : 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
