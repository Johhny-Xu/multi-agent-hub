import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  MAX_VPS_INSTANCES,
  VPS_INSTANCE_NAME_MAX,
  normalizeVpsInstance,
  vpsCapabilities,
  vpsCheckStatusFields,
  vpsConfigProblem,
  vpsIdentityKey,
  type VpsCheckStatus,
  type VpsConfig,
  type VpsInstance,
  type VpsInstanceView,
} from "../../shared/vps.ts";
import { isValidSshAlias, type AppConfig } from "../config.ts";
import type { BotRecord } from "../store.ts";
import type { SshVpsTarget } from "../vps-computer.ts";
import { vpsConfigRevision, vpsInstanceRevision } from "../vps-hosts.ts";
import { vpsErrorText, type VpsStatusStore } from "../vps-status.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface VpsProbeResult {
  available: boolean;
  reason?: VpsInstanceView["reason"];
  detail?: string;
  /** The round trip the probe measured, when it measured one itself. */
  latencyMs?: number;
}

export interface VpsInstanceRouteDeps {
  cfg: AppConfig;
  bots: readonly BotRecord[];
  save(config: VpsConfig): void;
  probeSsh?(target: SshVpsTarget, signal: AbortSignal): Promise<VpsProbeResult>;
  probeMcp?(server: string, boxId: string, signal: AbortSignal, timeoutMs?: number): Promise<VpsProbeResult>;
  listMcpResources?(server: string, signal: AbortSignal): Promise<Array<{ id: string; name: string; state: string }>>;
  /** Where the last check of each computer is remembered. */
  statusStore?: VpsStatusStore;
  /** How long a check may take before it reports a timeout. */
  checkTimeoutMs?: number;
  activeVpsThreads?: { has(botId: string): boolean };
  lifecycleBusy?(): boolean;
  /** A resource the instance still owns, named for the refusal; null when it owns none. */
  ownedResources?(instance: VpsInstance): Promise<string | null>;
}

/** A check that runs longer than this reports a timeout instead of holding the request open. */
export const VPS_CHECK_TIMEOUT_MS = 10_000;

const name = z.string().trim().min(1).max(VPS_INSTANCE_NAME_MAX);
const sshBody = z.object({
  kind: z.literal("ssh"),
  name,
  sshAlias: z.string().refine(isValidSshAlias, { message: "must be a simple SSH config alias" }),
  expectedRevision: z.string().min(1),
}).strict();
const mcpBody = z.object({
  kind: z.literal("mcp"),
  adapter: z.literal("simular-box"),
  name,
  mcpServer: z.string().trim().min(1).max(64),
  boxId: z.string().trim().min(1).max(200),
  expectedRevision: z.string().min(1),
}).strict();

function instances(cfg: AppConfig): VpsInstance[] {
  return cfg.vps?.version === 2 && Array.isArray(cfg.vps.instances) ? cfg.vps.instances : [];
}

function view(instance: VpsInstance, store?: VpsStatusStore): VpsInstanceView {
  const status = store?.get(instance.id);
  return {
    id: instance.id,
    name: instance.name,
    kind: instance.kind,
    configured: true,
    available: null,
    capabilities: vpsCapabilities(instance.kind),
    ...(status ? vpsCheckStatusFields(status) : {}),
  };
}

/** What each failure reason reads as in one short line. */
const REASON_TEXT: Record<NonNullable<VpsInstanceView["reason"]>, string> = {
  "missing-connection": "The saved connection is gone.",
  disabled: "The connection is turned off.",
  denied: "The connection refused this computer.",
  unreachable: "The computer did not answer.",
  unsupported: "This connection cannot check the computer.",
  timeout: "The check did not finish in time.",
  "tool-error": "The computer reported an error.",
  stopped: "The computer is stopped.",
};

type CheckOutcome = VpsCheckStatus & { reason?: VpsInstanceView["reason"]; detail?: string };

/** The budget as a person reads it: milliseconds under a second, seconds above it. */
function budgetText(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} seconds`;
}

/** One health check: the host answers, and the round trip is measured. */
async function checkInstance(deps: VpsInstanceRouteDeps, instance: VpsInstance): Promise<CheckOutcome> {
  const timeoutMs = deps.checkTimeoutMs ?? VPS_CHECK_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const probe = instance.kind === "ssh"
    ? deps.probeSsh?.(sshTarget(instance), signal)
    : deps.probeMcp?.(instance.mcpServer, instance.boxId, signal, timeoutMs);
  const startedAt = Date.now();
  const checkedAt = () => new Date().toISOString();
  if (!probe) {
    return { online: false, checkedAt: checkedAt(), error: "This computer cannot be checked from here." };
  }
  try {
    const result = await probe;
    return {
      online: result.available === true,
      latencyMs: result.latencyMs ?? Date.now() - startedAt,
      checkedAt: checkedAt(),
      ...(result.available ? {} : { error: vpsErrorText(result.detail ?? (result.reason ? REASON_TEXT[result.reason] : "The check failed.")) }),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = signal.aborted;
    return {
      online: false,
      latencyMs: Date.now() - startedAt,
      checkedAt: checkedAt(),
      reason: timedOut ? "timeout" : "unreachable",
      error: vpsErrorText(timedOut ? `The check did not finish within ${budgetText(timeoutMs)}.` : message),
    };
  }
}

function write(deps: VpsInstanceRouteDeps, config: VpsConfig): VpsConfig {
  const problem = vpsConfigProblem(config);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });
  deps.save(config);
  return config;
}

function sshTarget(instance: VpsInstance): SshVpsTarget {
  if (instance.kind !== "ssh") throw new Error("not an SSH instance");
  return {
    instanceId: instance.id,
    sshAlias: instance.sshAlias,
    revision: vpsInstanceRevision(instance),
  };
}

export function createVpsInstanceRoutes(deps: VpsInstanceRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (!path.startsWith("/api/vps/")) return PASS;
    if (auth.kind === "session" && !auth.scopes.includes("admin")) {
      return json(res, 403, { error: "Only the owner can manage VPS computers" });
    }
    const current = () => deps.cfg;
    const currentInstances = () => instances(current());
    const revision = () => vpsConfigRevision(current());

    const requireRevision = (expected: string) => {
      if (expected !== revision()) {
        throw Object.assign(new Error("The VPS list changed elsewhere. Reload and try again"), { status: 409 });
      }
    };
    const contentType = () => String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json");
    const readJson = async () => {
      if (!contentType()) throw Object.assign(new Error("content-type must be application/json"), { status: 415 });
      return readBody(req);
    };

    if (path === "/api/vps/instances" && method === "GET") {
      const vps = current().vps;
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, {
        revision: revision(),
        ...(vps?.version === 2 && vps.defaultInstanceId ? { defaultInstanceId: vps.defaultInstanceId } : {}),
        instances: currentInstances().map((instance) => view(instance, deps.statusStore)),
      });
    }

    if (path === "/api/vps/instances" && method === "POST") {
      const body = await readJson();
      const parsed = z.union([sshBody, mcpBody]).safeParse(body);
      if (!parsed.success) return json(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid VPS instance" });
      requireRevision(parsed.data.expectedRevision);
      const list = currentInstances();
      if (list.length >= MAX_VPS_INSTANCES) return json(res, 409, { error: `At most ${MAX_VPS_INSTANCES} instances are allowed` });
      const instance: VpsInstance = normalizeVpsInstance({ ...parsed.data, id: randomUUID() });
      if (instance.kind === "ssh") {
        if (list.some((entry) => entry.kind === "ssh" && entry.sshAlias === instance.sshAlias)) {
          return json(res, 409, { error: "That SSH host is already listed" });
        }
      } else {
        if (!current().mcpServers?.[instance.mcpServer]) {
          return json(res, 400, { error: "Choose an existing saved MCP connection" });
        }
        if (list.some((entry) => vpsIdentityKey(entry) === vpsIdentityKey(instance))) {
          return json(res, 409, { error: "That box is already listed" });
        }
      }
      const vps = current().vps;
      const config = write(deps, {
        version: 2,
        instances: [...list, instance],
        ...(vps?.version === 2 && vps.defaultInstanceId ? { defaultInstanceId: vps.defaultInstanceId } : {}),
      });
      return json(res, 201, { instance: view(instance), revision: vpsConfigRevision({ ...current(), vps: config }) });
    }

    let m = path.match(/^\/api\/vps\/instances\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readJson();
      const parsed = z.object({ name, expectedRevision: z.string().min(1) }).strict().safeParse(body);
      if (!parsed.success) return json(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid name" });
      requireRevision(parsed.data.expectedRevision);
      const list = currentInstances();
      const found = list.find((entry) => entry.id === m![1]);
      if (!found) return json(res, 404, { error: "no such VPS instance" });
      const config = write(deps, { ...(current().vps as VpsConfig), instances: list.map((entry) => entry.id === found.id ? { ...entry, name: parsed.data.name } : entry) });
      return json(res, 200, { instance: view({ ...found, name: parsed.data.name }), revision: vpsConfigRevision({ ...current(), vps: config }) });
    }

    if (m && method === "DELETE") {
      const body = await readJson();
      const parsed = z.object({ expectedRevision: z.string().min(1) }).strict().safeParse(body);
      if (!parsed.success) return json(res, 400, { error: "expectedRevision is required" });
      requireRevision(parsed.data.expectedRevision);
      const found = currentInstances().find((entry) => entry.id === m![1]);
      if (!found) return json(res, 404, { error: "no such VPS instance" });
      const users = deps.bots.filter((bot) => bot.vpsInstanceId === found.id);
      if (users.length > 0) {
        return json(res, 409, {
          error: `This computer is used by ${users.map((bot) => bot.name).join(", ")}. Choose another computer for them first`,
        });
      }
      if (users.some((bot) => bot.busy || deps.activeVpsThreads?.has(bot.id))) {
        return json(res, 409, { error: "This computer is in use" });
      }
      if (deps.lifecycleBusy?.()) return json(res, 409, { error: "A computer action is still running" });
      const owned = await deps.ownedResources?.(found);
      if (owned) return json(res, 409, { error: owned });
      const vps = current().vps as VpsConfig;
      const kept = currentInstances().filter((entry) => entry.id !== found.id);
      const config = write(deps, {
        version: 2,
        instances: kept,
        ...(vps.defaultInstanceId && vps.defaultInstanceId !== found.id ? { defaultInstanceId: vps.defaultInstanceId } : {}),
      });
      deps.statusStore?.prune(kept.map((entry) => entry.id));
      return json(res, 200, { removed: true, revision: vpsConfigRevision({ ...current(), vps: config }) });
    }

    if (path === "/api/vps/default-instance" && method === "PUT") {
      const body = await readJson();
      const parsed = z.object({ id: z.string().nullable(), expectedRevision: z.string().min(1) }).strict().safeParse(body);
      if (!parsed.success) return json(res, 400, { error: "id and expectedRevision are required" });
      requireRevision(parsed.data.expectedRevision);
      if (parsed.data.id !== null && !currentInstances().some((entry) => entry.id === parsed.data.id)) {
        return json(res, 404, { error: "no such VPS instance" });
      }
      const config = write(deps, {
        version: 2,
        instances: currentInstances(),
        ...(parsed.data.id ? { defaultInstanceId: parsed.data.id } : {}),
      });
      return json(res, 200, { revision: vpsConfigRevision({ ...current(), vps: config }) });
    }

    m = path.match(/^\/api\/vps\/instances\/([\w-]+)\/check$/);
    if (m && method === "POST") {
      const body = await readJson();
      const parsed = z.object({ expectedRevision: z.string().min(1) }).strict().safeParse(body);
      if (!parsed.success) return json(res, 400, { error: "expectedRevision is required" });
      requireRevision(parsed.data.expectedRevision);
      const found = currentInstances().find((entry) => entry.id === m![1]);
      if (!found) return json(res, 404, { error: "no such VPS instance" });
      const outcome = await checkInstance(deps, found);
      const remembered = deps.statusStore?.set(found.id, outcome) ?? outcome;
      return json(res, 200, {
        ...view(found, deps.statusStore),
        available: remembered.online,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(outcome.detail ? { detail: outcome.detail } : {}),
        ...vpsCheckStatusFields(remembered),
      });
    }

    if (path === "/api/vps/mcp-resources" && method === "GET") {
      const server = url.searchParams.get("server") ?? "";
      if (!server || !current().mcpServers?.[server]) return json(res, 400, { error: "server must name a saved MCP connection" });
      if (!deps.listMcpResources) return json(res, 501, { error: "This connection does not support listing boxes" });
      const signal = AbortSignal.timeout(10_000);
      return json(res, 200, { resources: await deps.listMcpResources(server, signal) });
    }

    return PASS;
  };
}
