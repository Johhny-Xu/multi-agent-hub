import { createSocket } from "node:dgram";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SERVER_VERSION, startHubCompat, type HubCompatOptions, type RunningHub } from "./main.ts";
import { hubEventLog } from "./events.ts";

const started: Array<{ hub: RunningHub; dir: string }> = [];

// The host's shell may carry the legacy agent-hub environment (HUB_TOKEN...).
// The compat tests must exercise their own token and never bind a live port.
for (const key of ["HUB_TOKEN", "HUB_AGENTS_FILE", "HUB_RESULTS_DIR", "HUB_STATE_DIR", "AGENTHUB_DISCOVERY"]) {
  delete process.env[key];
}

async function boot(options: HubCompatOptions = {}): Promise<{ hub: RunningHub; dir: string; url: string }> {
  const dir = await mkdtemp(join(tmpdir(), "hub-compat-main-"));
  const hub = await startHubCompat({ port: 0, host: "127.0.0.1", stateDir: dir, discovery: false, ...options });
  started.push({ hub, dir });
  return { hub, dir, url: `http://127.0.0.1:${hub.port}/mcp` };
}

afterEach(async () => {
  while (started.length) {
    const item = started.pop();
    if (!item) continue;
    try {
      await item.hub.close();
    } finally {
      await rm(item.dir, { recursive: true, force: true });
    }
  }
});

interface RpcReply {
  status: number;
  headers: Headers;
  text: string;
  json: any;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<RpcReply> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

function rpcRequest(method: string, params?: unknown, id: unknown = 1): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

describe("hub-compat HTTP surface", () => {
  it("serves /health and preserves the legacy status codes", async () => {
    const { hub, url } = await boot();
    const health = await fetch(`http://127.0.0.1:${hub.port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      service: "agent-hub",
      status: "ok",
      version: SERVER_VERSION,
      auth_required: false,
    });

    const missing = await post(`http://127.0.0.1:${hub.port}/other`, rpcRequest("ping"));
    expect(missing.status).toBe(404);
    expect(missing.text).toBe("Only /mcp is served");

    const wrongMethod = await fetch(url);
    expect(wrongMethod.status).toBe(405);

    const options = await fetch(url, { method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBe("*");
    expect(options.headers.get("access-control-allow-headers")).toBe(
      "Content-Type, Accept, Authorization, Mcp-Session-Id",
    );
    expect(options.headers.get("access-control-allow-methods")).toBe("POST, GET, OPTIONS");
  });

  it("checks HUB_TOKEN on /mcp but keeps /health public", async () => {
    const { hub, url } = await boot({ token: "s3cret" });
    const anonymous = await post(url, rpcRequest("ping"));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe('Bearer realm="agent-hub"');
    expect(anonymous.text).toBe('{"error":"unauthorized"}');

    const bearer = await post(url, rpcRequest("ping"), { Authorization: "Bearer s3cret" });
    expect(bearer.status).toBe(200);
    expect(bearer.json.result).toEqual({});

    const query = await post(`${url}?token=s3cret`, rpcRequest("ping"));
    expect(query.status).toBe(200);

    const wrong = await post(url, rpcRequest("ping"), { Authorization: "Bearer nope" });
    expect(wrong.status).toBe(401);

    const health = await fetch(`http://127.0.0.1:${hub.port}/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).auth_required).toBe(true);
  });

  it("refuses a non-loopback bind without a token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hub-compat-refuse-"));
    await expect(
      startHubCompat({ port: 0, host: "0.0.0.0", stateDir: dir, discovery: false, token: "" }),
    ).rejects.toThrow("非回环监听必须设置 HUB_TOKEN");
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects malformed bodies and oversized payloads", async () => {
    const { url } = await boot();
    const broken = await post(url, "{not json");
    expect(broken.status).toBe(400);

    const oversized = await post(url, "x".repeat(2 * 1024 * 1024 + 1));
    expect(oversized.status).toBe(413);
  });
});

describe("hub-compat JSON-RPC", () => {
  it("initializes with the legacy server identity and echoes the protocol version", async () => {
    const { url } = await boot();
    const echoed = await post(url, rpcRequest("initialize", { protocolVersion: "2025-03-26", capabilities: {} }));
    expect(echoed.status).toBe(200);
    expect(echoed.json).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-hub", version: SERVER_VERSION },
      },
    });

    const fallback = await post(url, rpcRequest("initialize", {}));
    expect(fallback.json.result.protocolVersion).toBe("2024-11-05");
  });

  it("lists the contract tools verbatim", async () => {
    const { url } = await boot();
    const contract = JSON.parse(await readFile(new URL("./contract.json", import.meta.url), "utf8"));
    const reply = await post(url, rpcRequest("tools/list"));
    expect(reply.json.result.tools).toEqual(contract.tools);
    expect(reply.json.result.tools.map((tool: { name: string }) => tool.name)).toHaveLength(27);
    expect(JSON.stringify(reply.json.result.tools)).toBe(JSON.stringify(contract.tools));
  });

  it("answers notifications with 202 and never executes a tool", async () => {
    const { url } = await boot();
    const notification = await post(url, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "hub_note_set", arguments: { key: "ghost", value: "1" } },
    });
    expect(notification.status).toBe(202);
    expect(notification.text).toBe("");

    const read = await post(url, rpcRequest("tools/call", { name: "hub_note_get", arguments: { key: "ghost" } }));
    expect(read.json.result.content[0].text).toBe("没有笔记「ghost」。");
  });

  it("runs local tools and reports their legacy text", async () => {
    const { url } = await boot();
    const saved = await post(url, rpcRequest("tools/call", {
      name: "hub_note_set",
      arguments: { key: "约定", value: "用 pnpm", agent: "alice" },
    }));
    expect(saved.json).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "笔记「约定」已保存。" }], isError: false },
    });

    const fetched = await post(url, rpcRequest("tools/call", {
      name: "hub_note_get",
      arguments: { key: "约定" },
    }));
    expect(fetched.json.result.content[0].text).toBe("约定 = 用 pnpm (by alice)");

    const listed = await post(url, rpcRequest("tools/call", { name: "hub_note_get", arguments: {} }));
    expect(listed.json.result.content[0].text).toBe("全部笔记: 约定");
  });

  it("turns handler failures into isError text, unknown tools into RPC errors", async () => {
    const { url } = await boot();
    const failed = await post(url, rpcRequest("tools/call", { name: "hub_claim_task", arguments: {} }));
    expect(failed.json.result.isError).toBe(true);
    expect(failed.json.result.content[0].text).toBe("工具执行出错: 缺少 task_id 或 agent");

    const unknown = await post(url, rpcRequest("tools/call", { name: "nope", arguments: {} }));
    expect(unknown.json).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "Unknown tool: nope" },
    });

    const badArguments = await post(url, rpcRequest("tools/call", { name: "hub_note_get", arguments: [] }));
    expect(badArguments.json.error.code).toBe(-32602);
  });

  it("handles ping, batches, invalid requests and unknown methods", async () => {
    const { url } = await boot();
    const ping = await post(url, rpcRequest("ping"));
    expect(ping.json).toEqual({ jsonrpc: "2.0", id: 1, result: {} });

    const batch = await post(url, [
      rpcRequest("ping", undefined, "a"),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      rpcRequest("ping", undefined, "b"),
    ]);
    expect(batch.json.map((reply: any) => reply.id)).toEqual(["a", "b"]);

    const emptyBatch = await post(url, []);
    expect(emptyBatch.json).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });

    const invalid = await post(url, { id: 3, method: "ping" });
    expect(invalid.json).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });

    const badParams = await post(url, rpcRequest("tools/list", []));
    expect(badParams.json.error).toEqual({ code: -32602, message: "params must be an object" });

    const unknownMethod = await post(url, rpcRequest("resources/list"));
    expect(unknownMethod.json.error).toEqual({ code: -32601, message: "Method not found: resources/list" });
  });

  it("keeps notes across a restart of the same state directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hub-compat-restart-"));
    const first = await startHubCompat({ port: 0, host: "127.0.0.1", stateDir: dir, discovery: false });
    try {
      await post(`http://127.0.0.1:${first.port}/mcp`, rpcRequest("tools/call", {
        name: "hub_note_set",
        arguments: { key: "k", value: "v" },
      }));
    } finally {
      await first.close();
    }
    const second = await startHubCompat({ port: 0, host: "127.0.0.1", stateDir: dir, discovery: false });
    try {
      const read = await post(`http://127.0.0.1:${second.port}/mcp`, rpcRequest("tools/call", {
        name: "hub_note_get",
        arguments: { key: "k" },
      }));
      expect(read.json.result.content[0].text).toBe("k = v (by unknown)");
    } finally {
      await second.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

interface DiscoveryReply {
  service: string;
  version: number;
  nonce: string;
  port: number;
  path: string;
  name: string;
  auth_required: boolean;
}

function askDiscovery(port: number, payload: unknown): Promise<DiscoveryReply | null> {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    const timer = setTimeout(() => {
      socket.close();
      resolve(null);
    }, 700);
    socket.once("message", (message) => {
      clearTimeout(timer);
      socket.close();
      try {
        resolve(JSON.parse(message.toString("utf8")) as DiscoveryReply);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
    socket.send(Buffer.from(JSON.stringify(payload)), port, "127.0.0.1");
  });
}

describe("hub-compat UDP discovery", () => {
  it("answers the legacy discovery handshake and ignores bad nonces", async () => {
    const { hub } = await boot({ discovery: true, discoveryPort: 0 });
    expect(hub.discoveryPort).not.toBeNull();
    const nonce = "0123456789abcdef0123456789abcdef";

    const reply = await askDiscovery(hub.discoveryPort as number, {
      service: "agenthub-discovery",
      version: 1,
      nonce,
    });
    expect(reply).toEqual({
      service: "agenthub-discovery",
      version: 1,
      nonce,
      port: hub.port,
      path: "/mcp",
      name: expect.any(String),
      auth_required: false,
    });
    expect(reply?.name.length).toBeGreaterThan(0);

    const ignoredNonce = await askDiscovery(hub.discoveryPort as number, {
      service: "agenthub-discovery",
      version: 1,
      nonce: "not-a-nonce",
    });
    expect(ignoredNonce).toBeNull();

    const ignoredVersion = await askDiscovery(hub.discoveryPort as number, {
      service: "agenthub-discovery",
      version: true,
      nonce,
    });
    expect(ignoredVersion).toBeNull();
  });
});

// ---------------------------------------------------------------- 实时事件（SSE / 进度通知）

/** Reads an SSE body until `until` matches, the stream ends, or the deadline passes. */
async function readSse(response: Response, until: (text: string) => boolean, timeoutMs = 5_000): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value?: undefined; done: true }>((done) => setTimeout(() => done({ done: true }), left)),
      ]);
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      if (until(text)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

describe("hub-compat live events", () => {
  it("streams /api/hub/tasks/:ref/events with the same token as /mcp", async () => {
    const { hub, dir } = await boot({ token: "s3cret" });
    const log = hubEventLog(dir);
    const ref = "codebuddy-abcdef0123";
    log.emit(ref, "codebuddy", "accepted", "任务已受理");
    log.emit(ref, "codebuddy", "progress", "工具调用: read_file");

    const denied = await fetch(`http://127.0.0.1:${hub.port}/api/hub/tasks/${ref}/events`);
    expect(denied.status).toBe(401);

    const stream = await fetch(`http://127.0.0.1:${hub.port}/api/hub/tasks/${ref}/events?token=s3cret&since=1`);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const text = await readSse(stream, (body) => body.includes("工具调用"));
    expect(text).toContain('"seq":2');
    expect(text).not.toContain("任务已受理");
  });

  it("delivers live events and ends the stream on a terminal one", async () => {
    const { hub, dir } = await boot();
    const log = hubEventLog(dir);
    const ref = "zcode-abcdef0123";
    const stream = await fetch(`http://127.0.0.1:${hub.port}/api/hub/tasks/${ref}/events`);
    const pending = readSse(stream, (body) => body.includes("event: end"));
    log.emit(ref, "zcode", "accepted", "已受理");
    log.emit(ref, "zcode", "done", "完成");
    const text = await pending;
    expect(text).toContain('"kind":"done"');
    expect(text).toContain("event: end");
  });

  it("rejects an unknown-shaped ref before opening a stream", async () => {
    const { hub } = await boot();
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/hub/tasks/${encodeURIComponent("../x")}/events`);
    expect(response.status).toBe(400);
  });

  it("sends notifications/progress on the client's own SSE channel", async () => {
    const { hub, url } = await boot({
      dispatchTools: {
        hub_wait_result: async (_args, context) => {
          context?.progress("第一段进度");
          context?.progress("第二段进度");
          return "ok";
        },
      },
    });
    const channel = await fetch(`http://127.0.0.1:${hub.port}/mcp`, {
      headers: { accept: "text/event-stream", "mcp-session-id": "session-1" },
    });
    expect(channel.headers.get("content-type")).toContain("text/event-stream");

    const reply = await post(url, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "hub_wait_result",
        arguments: { ref: "whatever" },
        _meta: { progressToken: "tok-1" },
      },
    }, { "Mcp-Session-Id": "session-1" });
    expect(reply.status).toBe(200);

    const frames = await readSse(channel, (body) => body.includes("第二段进度"));
    expect(frames).toContain('"progressToken":"tok-1"');
    expect(frames).toContain('"progress":1');
    expect(frames).toContain('"progress":2');
    expect(frames).toContain("第一段进度");
  });

  it("sends no progress frames when the client did not ask", async () => {
    const { hub, url } = await boot({
      dispatchTools: {
        hub_wait_result: async (_args, context) => {
          context?.progress("不该出现");
          return "ok";
        },
      },
    });
    const channel = await fetch(`http://127.0.0.1:${hub.port}/mcp`, {
      headers: { accept: "text/event-stream", "mcp-session-id": "session-2" },
    });
    await post(url, rpcRequest("tools/call", { name: "hub_wait_result", arguments: { ref: "x" } }), { "Mcp-Session-Id": "session-2" });
    const frames = await readSse(channel, (body) => body.includes("不该出现"), 1_200);
    expect(frames).not.toContain("不该出现");
  });
});
