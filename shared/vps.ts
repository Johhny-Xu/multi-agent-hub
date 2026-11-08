/** A managed VPS computer is one SSH container or one simular-box box reached through a saved MCP connection. */
export interface VpsSshInstance {
  id: string;
  name: string;
  kind: "ssh";
  sshAlias: string;
}

export interface VpsMcpInstance {
  id: string;
  name: string;
  kind: "mcp";
  adapter: "simular-box";
  mcpServer: string;
  boxId: string;
}

export type VpsInstance = VpsSshInstance | VpsMcpInstance;

export interface VpsConfig {
  version: 2;
  instances: VpsInstance[];
  defaultInstanceId?: string;
}

/** The pre-v2 file shape; read only until the migration writes a VpsConfig. */
export interface LegacyVpsConfig {
  sshAlias?: string;
}

export type StoredVpsConfig = Partial<VpsConfig> & LegacyVpsConfig;

export interface VpsCapabilities {
  status: boolean;
  join: boolean;
  screenshot: boolean;
  start: boolean;
  stop: boolean;
  remove: boolean;
}

/** What the last health check found about one computer. */
export interface VpsCheckStatus {
  /** Whether the computer answered the check. */
  online: boolean;
  /** The round trip of the check: SSH connect plus `true`, or an MCP handshake plus one light call. */
  latencyMs?: number;
  /** When the check ran, as an ISO timestamp. */
  checkedAt: string;
  /** A short reason the check failed; it never carries a credential. */
  error?: string;
}

export interface VpsInstanceView {
  id: string;
  name: string;
  kind: "ssh" | "mcp";
  configured: boolean;
  available: boolean | null;
  reason?: "missing-connection" | "disabled" | "denied" | "unreachable" | "unsupported" | "timeout" | "tool-error" | "stopped";
  /** A readable sentence about the last check; it never carries a credential. */
  detail?: string;
  /** The last check's outcome; absent while the computer has never been checked. */
  online?: boolean;
  latencyMs?: number;
  checkedAt?: string;
  error?: string;
  capabilities: VpsCapabilities;
}

/** A check result as the instance carries it: the same fields, flattened onto the view. */
export function vpsCheckStatusFields(status: VpsCheckStatus): Pick<VpsInstanceView, "online" | "latencyMs" | "checkedAt" | "error"> {
  return {
    online: status.online,
    ...(status.latencyMs === undefined ? {} : { latencyMs: status.latencyMs }),
    checkedAt: status.checkedAt,
    ...(status.error === undefined ? {} : { error: status.error }),
  };
}

export const MAX_VPS_INSTANCES = 64;
export const VPS_INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const VPS_INSTANCE_NAME_MAX = 80;
export const VPS_MCP_ADAPTERS = ["simular-box"] as const;

export function isVpsInstanceId(value: unknown): value is string {
  return typeof value === "string" && VPS_INSTANCE_ID.test(value);
}

export function vpsInstanceNameError(value: unknown): string | null {
  if (typeof value !== "string") return "The name must be text";
  const name = value.trim();
  if (!name) return "The name cannot be empty";
  if (name.length > VPS_INSTANCE_NAME_MAX) return `The name can be at most ${VPS_INSTANCE_NAME_MAX} characters`;
  return null;
}

export function vpsInstanceName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** Two instances with the same identity are the same computer, however they are named. */
export function vpsIdentityKey(instance: VpsInstance): string {
  return instance.kind === "ssh"
    ? `ssh:${instance.sshAlias}`
    : `mcp:${instance.adapter}:${instance.mcpServer}:${instance.boxId}`;
}

export function vpsInstanceById(config: Pick<VpsConfig, "instances"> | undefined, id: string | undefined): VpsInstance | undefined {
  if (!config || !id) return undefined;
  return config.instances.find((instance) => instance.id === id);
}

export function sshVpsInstance(alias: string, id: string, name = alias): VpsSshInstance {
  return { id, name, kind: "ssh", sshAlias: alias };
}

export function vpsCapabilities(kind: VpsInstance["kind"]): VpsCapabilities {
  return kind === "ssh"
    ? { status: true, join: true, screenshot: true, start: true, stop: true, remove: true }
    : { status: true, join: true, screenshot: true, start: true, stop: true, remove: false };
}

export function vpsConfigProblem(config: VpsConfig): string | null {
  if (!Array.isArray(config.instances)) return "The instance list is missing";
  if (config.instances.length > MAX_VPS_INSTANCES) return `At most ${MAX_VPS_INSTANCES} instances are allowed`;
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const instance of config.instances) {
    if (!isVpsInstanceId(instance.id)) return `“${instance.id}” is not a valid instance id`;
    if (ids.has(instance.id)) return `The instance id “${instance.id}” is used twice`;
    ids.add(instance.id);
    const nameError = vpsInstanceNameError(instance.name);
    if (nameError) return nameError;
    const identity = vpsIdentityKey(instance);
    if (identities.has(identity)) return "The same computer is registered twice";
    identities.add(identity);
  }
  if (config.defaultInstanceId !== undefined && !ids.has(config.defaultInstanceId)) {
    return "The default instance no longer exists";
  }
  return null;
}

export function normalizeVpsInstance(raw: unknown): VpsInstance {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Each VPS instance must be an object");
  const value = raw as Record<string, unknown>;
  const id = value.id;
  if (!isVpsInstanceId(id)) throw new Error("Each VPS instance needs a valid id");
  const name = typeof value.name === "string" ? vpsInstanceName(value.name) : "";
  const nameError = vpsInstanceNameError(name);
  if (nameError) throw new Error(nameError);
  if (value.kind === "ssh") {
    if (typeof value.sshAlias !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.sshAlias)) {
      throw new Error("vps.sshAlias must be a simple SSH config alias (letters, numbers, dot, dash, or underscore)");
    }
    return { id, name, kind: "ssh", sshAlias: value.sshAlias };
  }
  if (value.kind === "mcp") {
    if (value.adapter !== "simular-box") throw new Error("Only the simular-box adapter is supported");
    if (typeof value.mcpServer !== "string" || !value.mcpServer.trim()) throw new Error("An MCP instance needs a saved connection name");
    if (typeof value.boxId !== "string" || !value.boxId.trim()) throw new Error("An MCP instance needs a box id");
    return { id, name, kind: "mcp", adapter: "simular-box", mcpServer: value.mcpServer.trim(), boxId: value.boxId.trim() };
  }
  throw new Error("A VPS instance is either an SSH host or a simular-box MCP computer");
}

export function normalizeVpsConfigV2(raw: unknown): VpsConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("vps must be an object");
  const value = raw as Record<string, unknown>;
  if (value.version !== 2) throw new Error("vps.version must be 2");
  if (!Array.isArray(value.instances)) throw new Error("vps.instances must be a list");
  const config: VpsConfig = {
    version: 2,
    instances: value.instances.map(normalizeVpsInstance),
  };
  if (value.defaultInstanceId !== undefined && value.defaultInstanceId !== null) {
    if (!isVpsInstanceId(value.defaultInstanceId)) throw new Error("vps.defaultInstanceId is not a valid id");
    config.defaultInstanceId = value.defaultInstanceId;
  }
  const problem = vpsConfigProblem(config);
  if (problem) throw new Error(problem);
  return config;
}

export function isVpsConfigV2(value: unknown): value is VpsConfig {
  return Boolean(value && typeof value === "object" && (value as { version?: unknown }).version === 2);
}
