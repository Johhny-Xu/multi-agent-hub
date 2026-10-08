#!/usr/bin/env node
// Agent Hub 桥接 stdio MCP server（行分隔 JSON-RPC，与 agent_hub.py --http 同风格）。
// 工具：hub_ask（派给任意 worker 并阻塞到出结果）、hub_status（列出注册代理）。
// 由插件 mcpServers 注册：node ${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs
import { createInterface } from "node:readline";
import { ask, hubStatus, CANONICAL, dispatchOnly, fetchRef } from "./hub.mjs";

const SERVER = { name: "agenthub-hub-bridge", version: "0.3.0" };

const TOOLS = [
  {
    name: "hub_ask",
    description:
      "把任务派发给 Agent Hub 的一个 worker 并阻塞到出最终结果。worker 支持简称：agy/cb/cbcnintl/mimo/gcp/mmx/trae，或规范名 " +
      CANONICAL.join("/") +
      "。task 需自包含（worker 无本会话历史；minimaxcode 是纯聊天型无文件操作）。返回 JSON 文本：{ok,status,worker,ref,answer}。",
    inputSchema: {
      type: "object",
      properties: {
        worker: { type: "string", description: "worker 名或简称（如 agy / cb / trae）" },
        task: { type: "string", description: "任务文本，需自包含" },
        timeout_s: { type: "number", description: "等待上限秒数，默认 300" },
      },
      required: ["worker", "task"],
    },
  },
  {
    name: "hub_status",
    description: "列出 Agent Hub 注册代理与在线状态（原文文本）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hub_dispatch",
    description:
      "只派发不等待（秒回 ref）。适合有调用时长上限的场合（如工作流子代理 30s 框架超时）：拿到 ref 后用 hub_fetch 轮询结果。worker 支持简称 agy/cb/cbcnintl/mimo/gcp/mmx/trae 或规范名。严禁对同一任务重复派发（30s 内没返回 ref 就是失败，不是慢）。",
    inputSchema: {
      type: "object",
      properties: {
        worker: { type: "string", description: "worker 名或简称" },
        task: { type: "string", description: "任务文本，需自包含" },
        timeout_s: { type: "number", description: "worker 侧任务超时秒数，默认 900" },
      },
      required: ["worker", "task"],
    },
  },
  {
    name: "hub_fetch",
    description: "按 ref 查询一次任务当前状态（非阻塞，秒回）：{status, answer}。status=running 时稍后再查；completed 时 answer 是最终回答。",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "派发时返回的任务 ref" },
      },
      required: ["ref"],
    },
  },
];

function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function err(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRequest(req) {
  if (Array.isArray(req)) {
    const out = [];
    for (const one of req) {
      const r = await handleRequest(one);
      if (r !== null && r !== undefined) out.push(r);
    }
    return out.length ? out : null;
  }
  if (!req || typeof req !== "object" || req.jsonrpc !== "2.0") {
    return err(null, -32600, "Invalid Request");
  }
  const { method, id, params } = req;
  const isNotification = !("id" in req);
  if (method === "initialize") {
    return ok(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: SERVER,
    });
  }
  if (method === "ping") return ok(id, {});
  if (typeof method === "string" && method.startsWith("notifications/")) return null;
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      if (name === "hub_ask") {
        const r = await ask(args.worker, args.task, Number(args.timeout_s) || 300);
        return ok(id, { content: [{ type: "text", text: JSON.stringify(r, null, 1) }], isError: !r.ok });
      }
      if (name === "hub_status") {
        const text = await hubStatus();
        return ok(id, { content: [{ type: "text", text }] });
      }
      if (name === "hub_dispatch") {
        const r = await dispatchOnly(args.worker, args.task, Number(args.timeout_s) || 900);
        return ok(id, { content: [{ type: "text", text: JSON.stringify(r, null, 1) }], isError: !r.ok });
      }
      if (name === "hub_fetch") {
        const r = await fetchRef(args.ref);
        return ok(id, { content: [{ type: "text", text: JSON.stringify(r, null, 1) }] });
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
