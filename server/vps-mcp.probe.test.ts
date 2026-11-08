import { describe, expect, it, vi } from "vitest";

import { probeMcpBox, type VpsMcpClient, type VpsMcpConnection } from "./vps-mcp.ts";

function fixture(options: {
  connection?: "ok" | "missing" | "disabled";
  catalog?: Array<Record<string, unknown>>;
  callResult?: unknown;
  callError?: Error;
  hang?: boolean;
} = {}) {
  const requests: Array<{ method: string; params: any }> = [];
  const clients: Array<VpsMcpClient & { closed: boolean }> = [];
  const createClient = (connection: VpsMcpConnection) => {
    const client = {
      closed: false,
      initialize: vi.fn(async () => ({})),
      request: vi.fn(async (method: string, params: any, signal: AbortSignal) => {
        requests.push({ method, params });
        if (options.hang) {
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        if (method === "tools/list") return { tools: options.catalog ?? [{ name: "box_status" }] };
        if (options.callError) throw options.callError;
        return options.callResult ?? { structuredContent: { state: "running" }, content: [{ type: "text", text: "running" }] };
      }),
      close: vi.fn(async () => { client.closed = true; }),
    };
    clients.push(client);
    return client;
  };
  const deps = {
    connection: () => options.connection === "missing"
      ? { ok: false as const, reason: "missing-connection" as const }
      : options.connection === "disabled"
        ? { ok: false as const, reason: "disabled" as const }
        : { ok: true as const, identity: "conn-1", connection: { type: "http" as const, url: "https://mcp.example/mcp", headers: { Authorization: "Bearer secret-token-value" } } },
    createClient,
  };
  return { deps, requests, clients };
}

describe("MCP computer health check", () => {
  it("reports a running box as available after a real handshake", async () => {
    const { deps, requests, clients } = fixture();
    const result = await probeMcpBox(deps, "simular-box", "box-1", AbortSignal.timeout(5_000));
    expect(result).toMatchObject({ available: true });
    expect(requests.map((entry) => entry.method)).toEqual(["tools/list", "tools/call"]);
    expect(requests[1]?.params).toEqual({ name: "box_status", arguments: { box: "box-1" } });
    expect(clients[0]?.closed).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/secret-token-value|Bearer/);
  });

  it("reports a tool error as unavailable with a readable reason", async () => {
    const { deps } = fixture({
      callResult: { isError: true, content: [{ type: "text", text: "box not found in this account" }] },
    });
    const result = await probeMcpBox(deps, "simular-box", "box-1", AbortSignal.timeout(5_000));
    expect(result.available).toBe(false);
    expect(result.reason).toBe("tool-error");
    expect(result.detail).toContain("box not found");
  });

  it("reports a timeout as unavailable instead of waiting forever", async () => {
    const { deps } = fixture({ hang: true });
    const result = await probeMcpBox(deps, "simular-box", "box-1", AbortSignal.timeout(50));
    expect(result.available).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  it("reports a missing or disabled connection without connecting", async () => {
    const missing = fixture({ connection: "missing" });
    await expect(probeMcpBox(missing.deps, "simular-box", "box-1", AbortSignal.timeout(1_000)))
      .resolves.toMatchObject({ available: false, reason: "missing-connection" });
    expect(missing.clients).toHaveLength(0);

    const disabled = fixture({ connection: "disabled" });
    await expect(probeMcpBox(disabled.deps, "simular-box", "box-1", AbortSignal.timeout(1_000)))
      .resolves.toMatchObject({ available: false, reason: "disabled" });
    expect(disabled.clients).toHaveLength(0);
  });

  it("reports a box that is not running as unavailable", async () => {
    const { deps } = fixture({ callResult: { structuredContent: { state: "stopped" } } });
    const result = await probeMcpBox(deps, "simular-box", "box-1", AbortSignal.timeout(5_000));
    expect(result).toMatchObject({ available: false, reason: "stopped" });
    expect(result.detail).toContain("stopped");
  });
});
