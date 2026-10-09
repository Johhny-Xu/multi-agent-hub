#!/usr/bin/env node
// Agent Hub 桥接 stdio MCP server（行分隔 JSON-RPC，与 agent_hub.py --http 同风格）。
// 工具：hub_ask / hub_dispatch / hub_fetch / hub_status / hub_login。
// 由插件 mcpServers 注册：node ${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs
import { createInterface } from "node:readline";
import { ask, hubStatus, hubLogin, CANONICAL, dispatchOnly, fetchRef } from "./hub.mjs";

const SERVER = { name: "agenthub-hub-bridge", version: "0.5.0" };

const TOOLS = [
  {
    name: "hub_ask",
    description:
      "把任务派发给 Agent Hub 的一个 worker 并阻塞到出最终结果。worker 支持简称：agy/cb/cbcnintl/mimo/gcp/mmx/trae，或规范名 " +
      CANONICAL.join("/") +
      "。task 需自包含（worker 无本会话历史；minimaxcode 是纯聊天型无文件操作）。返回 JSON 文本：{ok,status,worker,ref,answer}。仅派发一次；running/unknown 时任务可能仍执行，使用原 ref 续查，避免重复派发。",
    inputSchema: {
      type: "object",
      properties: {
        worker: { type: "string", description: "worker 名或简称（如 agy / cb / trae）" },
        task: { type: "string", description: "任务文本，需自包含" },
        timeout_s: { type: "number", exclusiveMinimum: 0, maximum: 86400, default: 300, description: "含派发的总等待上限秒数，默认 300" },
      },
      required: ["worker", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "hub_status",
    description: "列出 Agent Hub 注册代理与在线状态（原文文本）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hub_login",
    description: "在 Agent Hub 宿主机发起或查询 worker 的官方登录。start 返回 login_url / user_code，由用户在浏览器完成授权；status 查询完成或过期；cancel 只取消本工具发起的登录流程。支持 worker 简称。不会索取密码、API Key 或回传凭据；不支持链接登录的 worker 返回 manual_required 及官方操作指引。",
    inputSchema: {
      type: "object",
      properties: {
        worker: { type: "string", description: "worker 名或简称，如 cb / cbcn / gcp" },
        action: { type: "string", enum: ["start", "status", "cancel"], default: "status", description: "start 发起登录，status 查询，cancel 取消等待授权" },
      },
      required: ["worker"],
      additionalProperties: false,
    },
  },
  {
    name: "hub_dispatch",
    description:
      "异步 worker 秒回 ref，再用 hub_fetch 轮询；同步配置直接返回 status=completed/failed 及 answer。HTTP 受理等待最多 25s。worker 支持简称 agy/cb/cbcnintl/mimo/gcp/mmx/trae 或规范名。网络超时可能已受理，严禁仅因没拿到 ref 重复派发同一任务。",
    inputSchema: {
      type: "object",
      properties: {
        worker: { type: "string", description: "worker 名或简称" },
        task: { type: "string", description: "任务文本，需自包含" },
        timeout_s: { type: "number", exclusiveMinimum: 0, maximum: 86400, default: 900, description: "worker 侧任务超时秒数，默认 900" },
      },
      required: ["worker", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "hub_fetch",
    description: "按 ref 查询一次任务当前状态（非阻塞）：{status, answer}。running 时稍后再查；completed 时 answer 是最终回答；failed 是任务失败，unknown 是查询未能确认状态，应保留原 ref 续查。",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "派发时返回的任务 ref" },
      },
      required: ["ref"],
      additionalProperties: false,
    },
  },
];

function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function err(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function argumentError(tool, args) {
  if (!object(args)) return "arguments must be an object";
  const schema = tool.inputSchema;
  for (const key of schema.required || []) {
    if (!Object.hasOwn(args, key)) return `Missing argument: ${key}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key];
    if (!property) return `Unknown argument: ${key}`;
    if (typeof value !== property.type) return `${key} must be ${property.type}`;
    if (property.type === "number" && (!Number.isFinite(value) || value <= property.exclusiveMinimum || value > property.maximum)) {
      return `${key} must be a finite number greater than 0 and at most 86400`;
    }
    if (property.enum && !property.enum.includes(value)) return `Invalid ${key}: ${value}`;
  }
  return null;
}

async function handleRequest(req) {
  if (Array.isArray(req)) {
    if (!req.length) return err(null, -32600, "Invalid Request");
    const out = [];
    for (const one of req) {
      const r = await handleRequest(one);
      if (r !== null && r !== undefined) out.push(r);
    }
    return out.length ? out : null;
  }
  if (!object(req) || req.jsonrpc !== "2.0" || typeof req.method !== "string" || !req.method ||
      (Object.hasOwn(req, "id") && req.id !== null && typeof req.id !== "string" && typeof req.id !== "number")) {
    return err(null, -32600, "Invalid Request");
  }
  const { method, id, params } = req;
  // MCP tool calls are requests. Notifications never receive replies or dispatch work.
  if (!Object.hasOwn(req, "id")) return null;
  if (params !== undefined && !object(params)) return err(id, -32602, "params must be an object");
  if (method === "initialize") {
    const supported = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
    return ok(id, {
      protocolVersion: supported.includes(params?.protocolVersion) ? params.protocolVersion : "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: SERVER,
    });
  }
  if (method === "ping") return ok(id, {});
  if (method.startsWith("notifications/")) return err(id, -32601, "Notifications must not have a request ID");
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (!tool) return err(id, -32602, `Unknown tool: ${name}`);
    const invalid = argumentError(tool, args);
    if (invalid) return err(id, -32602, invalid);
    try {
      if (name === "hub_ask") {
        const r = await ask(args.worker, args.task, args.timeout_s ?? 300);
        return ok(id, { content: [{ type: "text", text: JSON.stringify(r, null, 1) }], isError: !r.ok });
      }
      if (name === "hub_status") {
        const text = await hubStatus();
        return ok(id, { content: [{ type: "text", text }] });
      }
      if (name === "hub_login") {
        const r = await hubLogin(args.worker, args.action ?? "status");
        return ok(id, { content: [{ type: "text", text: JSON.stringify(r, null, 1) }], isError: !r.ok });
      }
      if (name === "hub_dispatch") {
        const r = await dispatchOnly(args.worker, args.task, args.timeout_s ?? 900);
        return ok(id, { content: [{ type: "text", text: JSON.stringify(r, null, 1) }], isError: !r.ok });
      }
      if (name === "hub_fetch") {
        const r = await fetchRef(args.ref);
        return ok(id, { content: [{ type: "text", text: JSON.stringify(r, null, 1) }], isError: r.status === "failed" || r.status === "unknown" });
      }
      return err(id, -32602, `Unknown tool: ${name}`);
    } catch (e) {
      return ok(id, { content: [{ type: "text", text: "出错: " + String(e && e.message || e) }], isError: true });
    }
  }
  return err(id, -32601, `Method not found: ${method}`);
}

const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const raw = line.trim();
  if (!raw) return;
  let req;
  try {
    req = JSON.parse(raw);
  } catch {
    write(err(null, -32700, "Parse error"));
    return;
  }
  handleRequest(req)
    .then((resp) => {
      if (resp !== null && resp !== undefined) write(resp);
    })
    .catch((e) => write(err(null, -32603, "Internal error: " + String(e && e.message || e))));
});
