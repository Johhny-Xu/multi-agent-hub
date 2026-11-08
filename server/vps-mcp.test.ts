import { describe, expect, it, vi } from "vitest";

import type { VpsTarget } from "./vps-hosts.ts";
import { createVpsMcpAdapter, vpsMcpRpc, type VpsMcpClient, type VpsMcpConnection } from "./vps-mcp.ts";

const instance = {
  id: "boxed",
  name: "Boxed",
  kind: "mcp" as const,
  adapter: "simular-box" as const,
  mcpServer: "simular",
  boxId: "box-1",
};
const target: VpsTarget = { instance, revision: "rev-1", physicalKey: "mcp:simular-box:simular:box-1" };

const catalog = [
  { name: "shell", description: "Run a command", inputSchema: { type: "object", properties: { command: { type: "string" }, box: { type: "string" } }, required: ["command", "box"] } },
  { name: "read_file", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "browser_navigate", description: "Open", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
  { name: "screenshot", description: "See", inputSchema: { type: "object", properties: {} } },
  { name: "box_delete", description: "Delete", inputSchema: { type: "object", properties: {} } },
  { name: "box_create", description: "Create", inputSchema: { type: "object", properties: {} } },
  { name: "mystery", description: "Unknown", inputSchema: { type: "object", properties: {} } },
];

function fixture(overrides: { enabled?: boolean; results?: Record<string, unknown>; callError?: Error; holdCommand?: string; gate?: Promise<void> } = {}) {
  const created: string[] = [];
  const requests: Array<{ method: string; params: any }> = [];
  const clients: Array<VpsMcpClient & { closed: boolean }> = [];
  const createClient = (connection: VpsMcpConnection) => {
    created.push(connection.url);
    const client = {
      closed: false,
      initialize: vi.fn(async () => ({})),
      request: vi.fn(async (method: string, params: any) => {
        requests.push({ method, params });
        if (method === "tools/list") return { tools: catalog };
        if (overrides.callError) throw overrides.callError;
        if (overrides.holdCommand && params.arguments?.command === overrides.holdCommand) await overrides.gate;
        return overrides.results?.[params.name] ?? { content: [{ type: "text", text: params.name }] };
      }),
      close: vi.fn(async () => { client.closed = true; }),
    };
    clients.push(client);
    return client;
  };
  const adapter = createVpsMcpAdapter({
    connection: () => overrides.enabled === false
      ? { ok: false, reason: "disabled" }
      : { ok: true, identity: "conn-1", connection: { type: "http", url: "https://mcp.example/mcp", headers: {} } },
    createClient,
    principal: (_target, botId) => botId ?? "settings",
  });
  return { adapter, created, requests, clients };
}

describe("simular-box computer adapter", () => {
  it("injects only the bound box into every provider call", async () => {
    const { adapter, requests } = fixture();
    await adapter.call({ target, principal: "bot-a", signal: AbortSignal.timeout(1_000) }, "shell", { command: "ls" });
    await adapter.call({ target, principal: "bot-a", signal: AbortSignal.timeout(1_000) }, "browser_navigate", { url: "https://example.com" });
    const calls = requests.filter((entry) => entry.method === "tools/call");
    expect(calls.map((entry) => entry.params.name)).toEqual(["shell", "browser_navigate"]);
    expect(calls.map((entry) => entry.params.arguments.box)).toEqual(["box-1", "box-1"]);
  });

  it("rejects a caller supplied different box", async () => {
    const { adapter, requests } = fixture();
    const result = await adapter.call({ target, principal: "bot-a", signal: AbortSignal.timeout(1_000) }, "shell", { command: "ls", box: "box-2" });
    expect(result.isError).toBe(true);
    expect(requests.filter((entry) => entry.method === "tools/call")).toHaveLength(0);
  });

  it("preserves image and structured MCP results", async () => {
    const image = { content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }], structuredContent: { width: 1280 }, isError: false };
    const { adapter } = fixture({ results: { screenshot: image } });
    await expect(adapter.call({ target, principal: "bot-a", signal: AbortSignal.timeout(1_000) }, "screenshot", {}))
      .resolves.toEqual(image);
  });

  it("stops on disabled or missing source connections", async () => {
    const disabled = fixture({ enabled: false });
    await expect(disabled.adapter.tools(target, "bot-a", AbortSignal.timeout(1_000))).rejects.toMatchObject({ status: 409 });
    const missing = createVpsMcpAdapter({
      connection: () => ({ ok: false, reason: "missing-connection" }),
      createClient: () => { throw new Error("must not connect"); },
      principal: () => "bot-a",
    });
    const result = await missing.call({ target, principal: "bot-a", signal: AbortSignal.timeout(1_000) }, "shell", { command: "ls" });
    expect(result.isError).toBe(true);
  });

  it("isolates clients by principal and connection revision", async () => {
    const { adapter, created } = fixture();
    await adapter.tools(target, "bot-a", AbortSignal.timeout(1_000));
    await adapter.tools(target, "bot-b", AbortSignal.timeout(1_000));
    await adapter.tools(target, "bot-a", AbortSignal.timeout(1_000));
    expect(created).toHaveLength(2);
  });

  it("does not expose unsupported destructive lifecycle tools", async () => {
    const { adapter } = fixture();
    const tools = await adapter.tools(target, "bot-a", AbortSignal.timeout(1_000));
    expect(tools.map((tool) => tool.name)).toEqual(["shell", "read_file", "browser_navigate", "screenshot"]);
    expect(tools.find((tool) => tool.name === "shell")!.inputSchema).toMatchObject({
      properties: { command: { type: "string" } },
      required: ["command"],
    });
  });

  it("serializes two sessions using the same physical box", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { adapter, requests } = fixture({ holdCommand: "first", gate });
    const first = adapter.call({ target, principal: "bot-a", signal: AbortSignal.timeout(5_000) }, "shell", { command: "first" });
    const second = adapter.call({ target, principal: "bot-b", signal: AbortSignal.timeout(5_000) }, "shell", { command: "second" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests.filter((entry) => entry.method === "tools/call")).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(requests.filter((entry) => entry.method === "tools/call")).toHaveLength(2);
  });

  it("applies source and computer denies to mapped tool names", async () => {
    const { adapter, requests } = fixture();
    const denied = await adapter.call({ target, principal: "bot-a", signal: AbortSignal.timeout(1_000) }, "box_delete", {});
    expect(denied.isError).toBe(true);
    const alias = await adapter.call({ target, principal: "bot-a", signal: AbortSignal.timeout(1_000) }, "open_url", { url: "https://example.com" });
    expect(alias.isError).not.toBe(true);
    expect(requests.find((entry) => entry.method === "tools/call")?.params.name).toBe("browser_navigate");
  });

  it("does not retry a dispatched call with an unknown outcome", async () => {
    const { adapter, requests } = fixture({ callError: new Error("socket closed after dispatch") });
    const result = await adapter.call({ target, principal: "bot-a", signal: AbortSignal.timeout(1_000) }, "shell", { command: "touch x" });
    expect(result.isError).toBe(true);
    expect(requests.filter((entry) => entry.method === "tools/call")).toHaveLength(1);
  });

  it("answers copy_* and other unmapped tools with a clear refusal and no provider call", async () => {
    const { adapter, requests } = fixture();
    const deps = {
      adapter,
      target,
      principal: "bot-a",
      gate: async () => ({ held: false, blockedReason: null }),
      assertActive: () => {},
      signal: AbortSignal.timeout(1_000),
    };
    for (const name of ["copy_to_computer", "copy_from_computer"]) {
      const refused = await vpsMcpRpc({ method: "tools/call", params: { name, arguments: { path: "report.csv" } } }, deps);
      expect(refused).toMatchObject({ isError: true });
      expect((refused as { content: Array<{ text?: string }> }).content[0]?.text).toMatch(/Unknown computer tool for this connection/);
    }
    await expect(vpsMcpRpc({ method: "resources/list" }, deps)).rejects.toMatchObject({ status: 400 });
    expect(requests.filter((entry) => entry.method === "tools/call")).toHaveLength(0);
  });
});
