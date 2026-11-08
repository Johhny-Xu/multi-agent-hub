import type { VpsInstance, VpsInstanceView } from "../shared/vps.ts";
import { vpsCapabilities } from "../shared/vps.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import type { VpsTarget } from "./vps-hosts.ts";

export interface VpsMcpConnection {
  type: "http" | "sse";
  url: string;
  headers: Record<string, string>;
}

export interface VpsMcpClient {
  initialize(clientName: string, signal: AbortSignal): Promise<unknown>;
  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export type VpsMcpConnectionResult =
  | { ok: true; connection: VpsMcpConnection; identity: string }
  | { ok: false; reason: "missing-connection" | "disabled" | "denied" | "unsupported" };

export interface VpsMcpDeps {
  connection(server: string): VpsMcpConnectionResult;
  createClient(connection: VpsMcpConnection): VpsMcpClient;
  principal(target: VpsTarget, botId?: string): string;
}

export interface ComputerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  source: { server: string; tool: string };
  effect: "read" | "write" | "execute";
}

export interface ComputerCallContext {
  target: VpsTarget;
  principal: string;
  signal: AbortSignal;
}

export interface McpCallResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

/** What a health check on one box reports: whether it answered, and why not when it did not. */
export interface VpsMcpProbeResult {
  available: boolean;
  reason?: VpsInstanceView["reason"];
  detail?: string;
}

/** A health check that waits longer than this reports a timeout rather than hanging. */
export const MCP_PROBE_TIMEOUT_MS = 20_000;

export interface VpsMcpAdapter {
  describe(target: VpsTarget, principal: string, signal: AbortSignal): Promise<VpsInstanceView>;
  tools(target: VpsTarget, principal: string, signal: AbortSignal): Promise<ComputerTool[]>;
  call(ctx: ComputerCallContext, name: string, args: unknown): Promise<McpCallResult>;
  close(targetKey: string): Promise<void>;
  join(target: VpsTarget, principal: string, signal: AbortSignal): Promise<{ joinUrl: string; mode: "external" }>;
  action(target: VpsTarget, principal: string, action: "start" | "stop", signal: AbortSignal): Promise<VpsInstanceView>;
  listResources(server: string, signal: AbortSignal): Promise<Array<{ id: string; name: string; state: string }>>;
}

export interface VpsMcpProbeDeps {
  connection(server: string): VpsMcpConnectionResult;
  createClient(connection: VpsMcpConnection): VpsMcpClient;
}

type Mapping = { remote: string; effect: ComputerTool["effect"] };

/**
 * A real handshake against one saved MCP connection: initialize, find the provider's status tool, and
 * ask it about the box. It never returns a cached answer and never carries a credential in its result.
 */
export async function probeMcpBox(
  deps: VpsMcpProbeDeps,
  server: string,
  boxId: string,
  signal: AbortSignal,
  timeoutMs: number = MCP_PROBE_TIMEOUT_MS,
): Promise<VpsMcpProbeResult> {
  const found = deps.connection(server);
  if (!found.ok) return { available: false, reason: found.reason, detail: "This MCP connection is not usable as a computer." };
  const client = deps.createClient(found.connection);
  try {
    await client.initialize("openmausbot-vps", signal);
    const catalog = await client.request("tools/list", {}, signal);
    const tool = statusToolName(catalog);
    if (!tool) return { available: false, reason: "unsupported", detail: "This MCP connection exposes no box status tool." };
    const result = await client.request("tools/call", { name: tool, arguments: { box: boxId } }, signal);
    if (record(result) && result.isError) {
      return { available: false, reason: "tool-error", detail: toolComplaint(result) };
    }
    const state = reportedState(result);
    if (state && NOT_RUNNING_STATES.has(state.toLowerCase())) {
      return { available: false, reason: "stopped", detail: `The box is ${state}.` };
    }
    return { available: true, ...(state ? { detail: `The box is ${state}.` } : {}) };
  } catch (error) {
    if (signal.aborted) return { available: false, reason: "timeout", detail: `The box did not answer within ${Math.round(timeoutMs / 1000)} seconds.` };
    const message = error instanceof Error ? error.message : String(error);
    return { available: false, reason: "unreachable", detail: redactSecretsInText(message).slice(0, 300) };
  } finally {
    await client.close().catch(() => {});
  }
}

const TOOL_MAP: Record<string, Mapping> = {
  shell: { remote: "shell", effect: "execute" },
  read_file: { remote: "read_file", effect: "read" },
  write_file: { remote: "write_file", effect: "write" },
  edit_file: { remote: "edit_file", effect: "write" },
  list_dir: { remote: "list_dir", effect: "read" },
  browser_navigate: { remote: "browser_navigate", effect: "read" },
  browser_snapshot: { remote: "browser_snapshot", effect: "read" },
  browser_click: { remote: "browser_click", effect: "write" },
  browser_type: { remote: "browser_type", effect: "write" },
  browser_fill: { remote: "browser_fill", effect: "write" },
  browser_read: { remote: "browser_read", effect: "read" },
  browser_fetch: { remote: "browser_fetch", effect: "read" },
  browser_tabs: { remote: "browser_tabs", effect: "read" },
  screenshot: { remote: "screenshot", effect: "read" },
  computer_act: { remote: "computer_act", effect: "execute" },
  computer_state: { remote: "computer_state", effect: "read" },
  desk: { remote: "desk", effect: "read" },
  gui_plan: { remote: "gui_plan", effect: "read" },
  script_run: { remote: "script_run", effect: "execute" },
  open_url: { remote: "browser_navigate", effect: "read" },
};

const LIFECYCLE = {
  status: { remote: "box_status" },
  view: { remote: "box_view" },
  start: { remote: "box_wake", fallback: "box_ensure" },
  stop: { remote: "box_hibernate" },
  list: { remote: "box_list" },
} as const;

/** A box is only usable while it runs; any other state the provider names is not usable either. */
const NOT_RUNNING_STATES = new Set(["stopped", "halted", "asleep", "hibernated", "suspended", "offline", "paused", "error", "failed", "terminated", "deleted"]);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toolList(result: unknown): { tools: Array<Record<string, unknown>>; nextCursor?: string } {
  const value = record(result) ? result : {};
  const tools = Array.isArray(value.tools) ? value.tools.filter(record) : [];
  return { tools, ...(typeof value.nextCursor === "string" ? { nextCursor: value.nextCursor } : {}) };
}

/** The provider names its status tool per connection, so the catalog decides which one to call. */
const STATUS_TOOL_NAMES = ["box_status", "box_state", "status"];

function statusToolName(catalog: unknown): string | null {
  const { tools } = toolList(catalog);
  const names = tools.map((tool) => tool.name).filter((name): name is string => typeof name === "string");
  for (const candidate of STATUS_TOOL_NAMES) {
    const found = names.find((name) => name.toLowerCase() === candidate);
    if (found) return found;
  }
  return names.find((name) => name.toLowerCase().includes("status")) ?? null;
}

/** What the status tool said about the box, as its own words; never a credential. */
function reportedState(result: unknown): string | null {
  const value = record(result) ? result : {};
  const structured = record(value.structuredContent) ? value.structuredContent : {};
  for (const key of ["state", "status"]) {
    if (typeof structured[key] === "string" && structured[key].trim()) return structured[key].trim();
  }
  const content = Array.isArray(value.content) ? value.content : [];
  for (const item of content) {
    if (!record(item) || typeof item.text !== "string") continue;
    try {
      const parsed = JSON.parse(item.text) as unknown;
      if (record(parsed)) {
        for (const key of ["state", "status"]) {
          if (typeof parsed[key] === "string" && parsed[key].trim()) return parsed[key].trim();
        }
      }
    } catch { /* the tool answered in prose */ }
    if (item.text.trim()) return item.text.trim().slice(0, 120);
  }
  return null;
}

/** The tool's own complaint, scrubbed: a server may echo a header value in its error text. */
function toolComplaint(result: unknown): string {
  const value = record(result) ? result : {};
  const content = Array.isArray(value.content) ? value.content : [];
  const text = content
    .filter((item) => record(item) && typeof item.text === "string")
    .map((item) => (item as { text: string }).text)
    .join(" ")
    .trim();
  if (!text) return "The box status tool reported an error.";
  return redactSecretsInText(text).slice(0, 300);
}

function targetBox(target: VpsTarget): string {
  if (target.instance.kind !== "mcp") throw new Error("not an MCP computer");
  return target.instance.boxId;
}

/** The bound box always wins: a caller's box is refused rather than merged. */
function withBox(args: unknown, boxId: string): Record<string, unknown> {
  const input = record(args) ? args : {};
  if (input.box !== undefined && input.box !== boxId) {
    throw Object.assign(new Error("This computer call named a different box; only the bound box is allowed"), { status: 403 });
  }
  return { ...input, box: boxId };
}

function stripBox(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = record(schema.properties) ? { ...schema.properties } : undefined;
  if (!properties) return schema;
  delete properties.box;
  const required = Array.isArray(schema.required) ? schema.required.filter((key) => key !== "box") : undefined;
  return { ...schema, properties, ...(required ? { required } : {}) };
}

export function createVpsMcpAdapter(deps: VpsMcpDeps): VpsMcpAdapter {
  const clients = new Map<string, { client: VpsMcpClient; identity: string; ready: Promise<void> }>();
  const leases = new Map<string, Promise<unknown>>();

  const connectionFor = (instance: VpsInstance) => {
    if (instance.kind !== "mcp") throw Object.assign(new Error("not an MCP computer"), { status: 400 });
    return deps.connection(instance.mcpServer);
  };

  const clientFor = async (target: VpsTarget, principal: string, signal: AbortSignal) => {
    const instance = target.instance;
    if (instance.kind !== "mcp") throw Object.assign(new Error("not an MCP computer"), { status: 400 });
    const found = connectionFor(instance);
    if (!found.ok) throw Object.assign(new Error(found.reason === "disabled" ? "This MCP connection is turned off" : "This MCP connection is unavailable"), { status: 409 });
    const key = `${found.identity}:${principal}:${instance.id}:${instance.boxId}`;
    const existing = clients.get(key);
    if (existing && existing.identity === found.identity) {
      await existing.ready;
      return existing.client;
    }
    const client = deps.createClient(found.connection);
    const ready = client.initialize("openmausbot-vps", signal).then(() => undefined);
    clients.set(key, { client, identity: found.identity, ready });
    await ready;
    return client;
  };

  const serialized = async <T>(target: VpsTarget, operation: () => Promise<T>): Promise<T> => {
    const key = `${target.physicalKey}:${targetBox(target)}`;
    const previous = leases.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    leases.set(key, current.catch(() => {}));
    try {
      return await current;
    } finally {
      if (leases.get(key) === current) leases.delete(key);
    }
  };

  const request = async (target: VpsTarget, principal: string, signal: AbortSignal, method: string, params: unknown) => {
    const client = await clientFor(target, principal, signal);
    return client.request(method, params, signal);
  };

  const boxCall = async (target: VpsTarget, principal: string, signal: AbortSignal, remote: string, args: Record<string, unknown>) => {
    const result = await request(target, principal, signal, "tools/call", { name: remote, arguments: args });
    return record(result) ? result as McpCallResult : { content: [{ type: "text", text: String(result) }] };
  };

  const catalog = async (target: VpsTarget, principal: string, signal: AbortSignal) => {
    const tools: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await request(target, principal, signal, "tools/list", cursor ? { cursor } : {});
      const listed = toolList(result);
      tools.push(...listed.tools);
      cursor = listed.nextCursor;
      if (!cursor) break;
    }
    return tools;
  };

  const mapped = (tools: Array<Record<string, unknown>>, instance: VpsInstance): ComputerTool[] => {
    const source = instance.kind === "mcp" ? instance.mcpServer : "";
    return tools.flatMap((tool) => {
      const name = typeof tool.name === "string" ? tool.name : "";
      const mapping = TOOL_MAP[name];
      if (!mapping) return [];
      const schema = record(tool.inputSchema) ? stripBox(tool.inputSchema) : { type: "object", properties: {} };
      return [{
        name,
        description: typeof tool.description === "string" ? tool.description : name,
        inputSchema: schema,
        source: { server: source, tool: mapping.remote },
        effect: mapping.effect,
      }];
    });
  };

  const view = (instance: VpsInstance, state: string | null, reason?: VpsInstanceView["reason"]): VpsInstanceView => ({
    id: instance.id,
    name: instance.name,
    kind: instance.kind,
    configured: true,
    available: state === null ? null : Boolean(state),
    ...(reason ? { reason } : {}),
    capabilities: vpsCapabilities(instance.kind),
  });

  return {
    async describe(target, principal, signal) {
      const instance = target.instance;
      try {
        const result = await boxCall(target, principal, signal, LIFECYCLE.status.remote, { box: targetBox(target) });
        if (result.isError) return view(instance, null, "unreachable");
        const state = record(result.structuredContent) && typeof result.structuredContent.state === "string"
          ? result.structuredContent.state
          : null;
        return view(instance, state ?? "running");
      } catch {
        return view(instance, null, "unreachable");
      }
    },
    async tools(target, principal, signal) {
      if (target.instance.kind !== "mcp") throw Object.assign(new Error("not an MCP computer"), { status: 400 });
      const found = connectionFor(target.instance);
      if (!found.ok) throw Object.assign(new Error("This MCP connection is unavailable"), { status: 409 });
      return mapped(await catalog(target, principal, signal), target.instance);
    },
    async call(ctx, name, args) {
      const mapping = TOOL_MAP[name];
      if (!mapping) return { isError: true, content: [{ type: "text", text: "Unknown computer tool for this connection." }] };
      try {
        return await serialized(ctx.target, () => boxCall(
          ctx.target,
          ctx.principal,
          ctx.signal,
          mapping.remote,
          withBox(args, targetBox(ctx.target)),
        ));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: message.slice(0, 400) }] };
      }
    },
    async close(targetKey) {
      for (const [key, entry] of Array.from(clients)) {
        if (!key.startsWith(`${targetKey}:`)) continue;
        clients.delete(key);
        await entry.client.close().catch(() => {});
      }
    },
    async join(target, principal, signal) {
      const result = await boxCall(target, principal, signal, LIFECYCLE.view.remote, { box: targetBox(target) });
      const value = record(result.structuredContent) ? result.structuredContent : {};
      const joinUrl = typeof value.url === "string" ? value.url : typeof value.view_url === "string" ? value.view_url : "";
      if (!joinUrl) throw Object.assign(new Error("The box did not return a viewer address"), { status: 502 });
      return { joinUrl, mode: "external" };
    },
    async action(target, principal, action, signal) {
      const box = { box: targetBox(target) };
      try {
        if (action === "start") {
          const first = await boxCall(target, principal, signal, LIFECYCLE.start.remote, box);
          if (first.isError) await boxCall(target, principal, signal, LIFECYCLE.start.fallback, box);
        } else {
          await boxCall(target, principal, signal, LIFECYCLE.stop.remote, box);
        }
      } catch {
        return view(target.instance, null, "unreachable");
      }
      return view(target.instance, "running");
    },
    async listResources(server, signal) {
      const found = deps.connection(server);
      if (!found.ok) throw Object.assign(new Error("This MCP connection is unavailable"), { status: 409 });
      const client = deps.createClient(found.connection);
      try {
        await client.initialize("openmausbot-vps", signal);
        const result = await client.request("tools/call", { name: LIFECYCLE.list.remote, arguments: {} }, signal);
        const value = record(result) ? result : {};
        const rows = Array.isArray(value.structuredContent)
          ? value.structuredContent
          : record(value.structuredContent) && Array.isArray(value.structuredContent.boxes) ? value.structuredContent.boxes : [];
        return rows.filter(record).flatMap((row) => {
          const id = typeof row.id === "string" ? row.id : typeof row.box_id === "string" ? row.box_id : "";
          if (!id) return [];
          return [{ id, name: typeof row.name === "string" ? row.name : id, state: typeof row.state === "string" ? row.state : "unknown" }];
        });
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}

/** tools/list reads the catalog only; the gate runs before a call, never before a listing or a wake decision. */
export async function vpsMcpRpc(
  request: { method?: unknown; params?: unknown } | null | undefined,
  deps: {
    adapter: VpsMcpAdapter;
    target: VpsTarget;
    principal: string;
    gate(): Promise<{ held: boolean; blockedReason?: string | null }>;
    assertActive(): void;
    signal: AbortSignal;
  },
): Promise<{ tools: ComputerTool[] } | McpCallResult> {
  if (request?.method === "tools/list") {
    deps.assertActive();
    return { tools: await deps.adapter.tools(deps.target, deps.principal, deps.signal) };
  }
  if (request?.method !== "tools/call") throw Object.assign(new Error("unsupported computer method"), { status: 400 });
  const params = (request.params && typeof request.params === "object" ? request.params : {}) as { name?: unknown; arguments?: unknown };
  if (typeof params.name !== "string" || !TOOL_MAP[params.name]) {
    return { isError: true, content: [{ type: "text", text: "Unknown computer tool for this connection." }] };
  }
  const control = await deps.gate();
  if (control.held) return { isError: true, content: [{ type: "text", text: control.blockedReason ?? "This computer is in use by the person." }] };
  deps.assertActive();
  return deps.adapter.call({ target: deps.target, principal: deps.principal, signal: deps.signal }, params.name, params.arguments ?? {});
}
