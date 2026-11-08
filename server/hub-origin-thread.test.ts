// 8801 侧：发起线程 id 怎么进到 hub MCP 的环境/请求头里。
import { describe, expect, it } from "vitest";

import { HUB_ORIGIN_ENV, HUB_ORIGIN_HEADER, isHubMcpServer, markHubOriginThread } from "./hub-origin-thread.ts";
import type { McpServerSpec } from "./contracts.ts";

const stdioHub = { command: "node", args: ["/repo/mcp/server.mjs"], env: { AGENTHUB_URL: "http://127.0.0.1:8765/mcp", HUB_TOKEN: "secret" } } as McpServerSpec;
const remoteHub = { type: "http", url: "http://127.0.0.1:8765/mcp", headers: { Authorization: "Bearer secret" } } as McpServerSpec;
const otherServer = { type: "http", url: "https://example.com/mcp", headers: {} } as McpServerSpec;

describe("isHubMcpServer", () => {
  it("knows the hub by the name it is saved under", () => {
    expect(isHubMcpServer("hub", otherServer)).toBe(true);
    expect(isHubMcpServer("multi-agent-hub", otherServer)).toBe(true);
    expect(isHubMcpServer("notes", otherServer)).toBe(false);
  });

  it("knows the hub by the connection it names", () => {
    expect(isHubMcpServer("bridge", stdioHub)).toBe(true);
  });

  it("knows a loopback hub by its own MCP path", () => {
    expect(isHubMcpServer("bridge", remoteHub)).toBe(true);
    expect(isHubMcpServer("bridge", otherServer)).toBe(false);
  });
});

describe("markHubOriginThread", () => {
  it("puts the thread into a stdio hub bridge's environment", () => {
    const custom = { bridge: { ...stdioHub, env: { ...(stdioHub as { env: Record<string, string> }).env } } } as Record<string, McpServerSpec>;
    markHubOriginThread(custom, "thread-1");
    expect((custom.bridge as { env: Record<string, string> }).env[HUB_ORIGIN_ENV]).toBe("thread-1");
  });

  it("puts the thread into a URL hub server's headers", () => {
    const custom = { bridge: { ...remoteHub, headers: { ...(remoteHub as { headers: Record<string, string> }).headers } } } as Record<string, McpServerSpec>;
    markHubOriginThread(custom, "thread-2");
    expect((custom.bridge as { headers: Record<string, string> }).headers[HUB_ORIGIN_HEADER]).toBe("thread-2");
  });

  it("leaves another server alone", () => {
    const custom = { notes: { ...otherServer, headers: { ...(otherServer as { headers: Record<string, string> }).headers } } } as Record<string, McpServerSpec>;
    markHubOriginThread(custom, "thread-3");
    expect((custom.notes as { headers: Record<string, string> }).headers).toEqual({});
  });

  it("does not change the saved spec it copied", () => {
    const saved = { ...stdioHub, env: { AGENTHUB_URL: "http://127.0.0.1:8765/mcp" } } as McpServerSpec;
    const custom = { bridge: saved } as Record<string, McpServerSpec>;
    markHubOriginThread(custom, "thread-4");
    expect((saved as { env: Record<string, string> }).env[HUB_ORIGIN_ENV]).toBeUndefined();
    expect((custom.bridge as { env: Record<string, string> }).env[HUB_ORIGIN_ENV]).toBe("thread-4");
  });

  it("marks nothing without a thread", () => {
    const custom = { bridge: { ...stdioHub, env: {} } } as Record<string, McpServerSpec>;
    markHubOriginThread(custom, "");
    expect((custom.bridge as { env: Record<string, string> }).env[HUB_ORIGIN_ENV]).toBeUndefined();
  });
});
