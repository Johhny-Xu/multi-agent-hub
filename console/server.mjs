// @ts-check

import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat, lstat, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/** @typedef {import('./miniapp-api.js').MiniAppContext} MiniAppContext */
/** @typedef {import('./miniapp-api.js').MiniAppLifecycle} MiniAppLifecycle */

const VERSION = '1.4.0';
// 控制台自身身份与角色: 三级解析（优先级：环境变量 > config.json > 默认值）
// 1. env: HUBCONSOLE_SELF_AGENT (默认 'console'), HUBCONSOLE_SELF_ROLE (默认 '子代理控制台')
// 2. config.json: selfAgent, selfRole
// 3. 兜底默认值: 'console' / '子代理控制台'
let SELF_AGENT = process.env.HUBCONSOLE_SELF_AGENT || 'console';
// 别名自动识别: 简称统一映射到 agents.json 规范名 (2026-10-06)
const AGENT_ALIASES = {
  agy: 'antigravity',
  cb: 'codebuddy',
  cbcn: 'codebuddy-cn',
  mimo: 'mimocode',
  gcp: 'github-copilot',
  copilot: 'github-copilot',
  mmx: 'minimaxcode',
  trae: 'traecode',
  ca: 'codearts',
  codearts: 'codearts',
  'huawei-codearts': 'codearts',
};
const canonicalAgent = (value) => AGENT_ALIASES[String(value || '').trim().toLowerCase()] || String(value || '').trim();
// 子代理直通端点绑定地址: 默认仅回环; 设 0.0.0.0 才暴露给局域网(无鉴权, 慎用)
const SUB_BIND_HOST = process.env.HUBCONSOLE_SUB_HOST || '127.0.0.1';
// 对外公告地址(endpointFile/hub 笔记里写的 URL): 绑定到非回环时自动挑局域网 IPv4, 也可显式指定
const ADVERTISE_HOST = (() => {
  const v = process.env.HUBCONSOLE_ADVERTISE_HOST;
  if (v) return v;
  if (SUB_BIND_HOST !== '127.0.0.1' && SUB_BIND_HOST !== 'localhost') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list || []) if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return '127.0.0.1';
})();
let SELF_ROLE = process.env.HUBCONSOLE_SELF_ROLE || '子代理控制台';
const SELF_CAPS = ['派活', '查看信箱', '共享笔记', '任务队列', '实时对话', '子代理直通'];
const ONLINE_WINDOW_NOTE = '10 分钟心跳窗口';
const MAX_BODY = 1_000_000;
const UPLOAD_MAX_BODY = 12_000_000; // 上传接口单独放宽 (base64 后 ~8MB 文件)
const SUMMARY_CAP = 500;
const ARTIFACT_CAP = 200_000;
const MSGS_PER_THREAD = 200;
const THREADS_MAX = 30;
const SUBAGENT_PORTS = [8790, 8791, 8792, 8793, 8795, 8797, 8799];

/** 默认枢纽端点 (支持环境变量覆盖; token 仅存 Node 侧, 不下发 Client) */
const DEFAULT_CONFIG = {
  activeId: 'server',
  endpoints: [
    {
      id: 'server',
      label: process.env.HUBCONSOLE_SERVER_LABEL || 'multi-agent-hub 服务器枢纽',
      url: process.env.HUBCONSOLE_SERVER_URL || 'http://127.0.0.1:8765/mcp',
      token: process.env.HUBCONSOLE_SERVER_TOKEN || '',
    },
  ],
};

/** 特定代理的直接派发工具覆盖 (agents.json cli=null 但有专用通道) */
const DISPATCH_OVERRIDES = { traecode: { tool: 'trae_delegate', asyncFlag: { wait: false } } };

/**
 * 2026-10-05 实测模型目录 (逐一在各 CLI 交互界面查证, 替代 agents.json 旧表)
 */
const MODEL_CATALOG = {
  codearts: [
    { id: '', name: '默认（继承 CodeArts 已配置模型）', default: true },
  ],
  'github-copilot': [
    { id: 'auto', name: 'Auto (Copilot 自动选型)', default: true },
  ],
  codebuddy: [
    { id: 'default-model', name: 'Auto' },
    { id: 'fast-model', name: 'Fast' },
    { id: 'balanced-model', name: 'Balanced' },
    { id: 'primary-model', name: 'Primary' },
    { id: 'deep-model', name: 'Deep' },
    { id: 'hy4-preview', name: 'Hy4 preview' },
    { id: 'hy3', name: 'Hy3', tag: '免费' },
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', tag: '免费', default: true },
    { id: 'gpt-6-astra', name: 'GPT-6-Astra' },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' },
    { id: 'gpt-5.5', name: 'GPT-5.5' },
    { id: 'gpt-5.4', name: 'GPT-5.4' },
    { id: 'gemini-3.5-flash', name: 'Gemini-3.5-Flash' },
    { id: 'glm-5.3', name: 'GLM-5.3' },
    { id: 'glm-5.2', name: 'GLM-5.2' },
    { id: 'kimi-k3', name: 'Kimi-K3' },
    { id: 'kimi-k2.6', name: 'Kimi-K2.6' },
    { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview' },
    { id: 'custom-local:trae', name: 'Trae (9router)' },
  ],
  'codebuddy-cn': [
    { id: 'default', name: 'Default', credits: 'x2.00' },
    { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', credits: 'x0.51' },
    { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', credits: 'x0.17' },
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', credits: 'x0.11', default: true },
    { id: 'deepseek-v3-2-volc', name: 'DeepSeek-V3.2', credits: 'x0.29' },
    { id: 'minimax-m2.5', name: 'MiniMax-M2.5', credits: 'x0.18' },
    { id: 'minimax-m3', name: 'MiniMax-M3', credits: 'x0.25' },
    { id: 'minimax-m2.7', name: 'MiniMax-M2.7', credits: 'x0.19' },
    { id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.79' },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', credits: 'x0.06' },
    { id: 'glm-5.2', name: 'GLM-5.2', credits: 'x0.79' },
    { id: 'glm-5.1', name: 'GLM-5.1', credits: 'x0.79' },
    { id: 'glm-5.0', name: 'GLM-5.0', credits: 'x0.80' },
    { id: 'glm-5.0-turbo', name: 'GLM-5.0-Turbo', credits: 'x0.95' },
    { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', credits: 'x0.71' },
    { id: 'glm-4.7', name: 'GLM-4.7', credits: 'x0.23' },
    { id: 'glm-4.6', name: 'GLM-4.6', credits: 'x0.23' },
    { id: 'glm-4.6v', name: 'GLM-4.6V', credits: 'x0.11' },
    { id: 'kimi-k3-1', name: 'Kimi-K3', credits: 'x1.62' },
    { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', credits: 'x0.77' },
    { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', credits: 'x0.57' },
    { id: 'kimi-k2.6', name: 'Kimi-K2.6', credits: 'x0.52' },
    { id: 'kimi-k2.5', name: 'Kimi-K2.5', credits: 'x0.45' },
    { id: 'kimi-k2-thinking', name: 'Kimi-K2-Thinking', credits: 'x0.54' },
    { id: 'hy3', name: 'Hy3', credits: 'x0.00', tag: '免费' },
    { id: 'hy3-x', name: 'Hy3-X', credits: 'x0.05' },
    { id: 'hy4-preview', name: 'Hy4 preview', credits: 'x0.29', tag: '试用' },
    { id: 'hy4-preview-x', name: 'Hy4 preview-X', credits: 'x0.29', tag: '试用' },
    { id: 'hunyuan-chat', name: 'Hunyuan-Turbos', credits: 'x0.10' },
    { id: 'hunyuan-image-alpha', name: 'Hunyuan Image Alpha' },
    { id: 'hunyuan-image-alpha-edit', name: 'Hunyuan Image Alpha Edit' },
    { id: 'space-bunny', name: 'Space-Bunny', credits: 'x0.03' },
  ],
  antigravity: [
    { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash Medium', default: true },
    { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', tag: '即将下线' },
    { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', tag: '即将下线' },
    { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
    { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
  ],
  mimocode: [
    { id: 'xiaomi/mimo-v2.6-flash', name: 'MiMo-V2.6-Flash (26f)', default: true },
    { id: '9router/trae', name: 'Trae (9router 通道)' },
    { id: 'mimo-auto', name: 'MiMo Auto (MiMo-V2.5)' },
    { id: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro' },
    { id: 'mimo-v2.5', name: 'MiMo-V2.5' },
    { id: 'mimo-v2.6-pro-ultraspeed', name: 'MiMo-V2.6-Pro-UltraSpeed' },
    { id: 'mimo-v2.6-flash', name: 'MiMo-V2.6-Flash' },
    { id: 'mimo-v2.5-pro', name: 'MiMo-V2.5-Pro' },
    { id: 'mimo-v2.5-pro-ultraspeed', name: 'MiMo-V2.5-Pro-UltraSpeed' },
    { id: 'mimo-v2.5-flash', name: 'MiMo-V2.5-Flash' },
  ],
  minimaxcode: [
    { id: 'MiniMax-M3', name: 'MiniMax-M3', tag: '1M 上下文' },
    { id: 'MiniMax-M3.1-Flash-Preview', name: 'MiniMax-M3.1-Flash-Preview', tag: '512K/1M', default: true },
    { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', tag: '204.8K' },
    { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax-M2.7-highspeed', tag: '204.8K · 高速' },
  ],
  zcode: [
    { id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash', default: true },
  ],
  traecode: [
    { id: 'GLM-5.3-FlashX', name: 'GLM-5.3-FlashX', default: true },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
    { id: 'glm-5.3', name: 'GLM-5.3' },
    { id: 'glm-5.3-flashx', name: 'GLM-5.3-FlashX' },
    { id: 'glm-5.2', name: 'GLM-5.2' },
    { id: 'glm-5.1', name: 'GLM-5.1' },
    { id: 'glm-5', name: 'GLM-5' },
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
    { id: 'DeepSeek-V4-Pro', name: 'DeepSeek-V4-Pro' },
    { id: 'DeepSeek-V4-Pro-Official', name: 'DeepSeek-V4-Pro-Official' },
    { id: 'DeepSeek-V4-Flash', name: 'DeepSeek-V4-Flash' },
    { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek-V4-Flash-Official' },
    { id: 'kimi-k3', name: 'Kimi-K3' },
    { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview' },
    { id: 'kimi-k2.7-code', name: 'Kimi-K2.7-Code' },
    { id: 'minimax-m3', name: 'MiniMax-M3' },
    { id: 'qwen3.8-max', name: 'Qwen3.8-Max' },
    { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash' },
    { id: 'qwen-3.7-plus', name: 'Qwen-3.7-Plus' },
    { id: 'step-5-preview', name: 'Step-5-Preview' },
    { id: 'Doubao-Seed-2.1-Pro', name: 'Doubao-Seed-2.1-Pro' },
    { id: 'Doubao-Seed-2.1-Turbo', name: 'Doubao-Seed-2.1-Turbo' },
    { id: 'Doubao-Seed-2.0-Code', name: 'Doubao-Seed-2.0-Code' },
    { id: 'Doubao-Seed-Code', name: 'Doubao-Seed-Code' },
    { id: 'Doubao-Seed-Evolving', name: 'Doubao-Seed-Evolving' },
  ],
};

// Display labels are historical metadata; only hub_capabilities can authorize
// a model or runtime option on the selected Hub host.
const WORKER_PARAMS = {};
const objectValue = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const publicReason = (value) => typeof value === 'string' ? sanitizeHubError(value).slice(0, 400) : '';
const availability = (value, fallback) => ({
  enabled: objectValue(value) ? value.enabled === true : fallback?.enabled === true,
  code: publicReason(value?.code || fallback?.code),
  reason: publicReason(value?.reason || fallback?.reason),
  refreshable: value?.refreshable === true || fallback?.refreshable === true,
});

export function normalizeCapabilities(value) {
  if (!objectValue(value) || value.schema_version !== 2 || !objectValue(value.workers)) {
    throw new Error('Hub 未提供新版能力信息，请更新 Hub；运行选项暂不可用');
  }
  const workers = {};
  for (const [name, worker] of Object.entries(value.workers)) {
    if (!/^[\w.-]{1,64}$/.test(name) || !objectValue(worker)) continue;
    const ready = availability(worker.availability);
    const models = (Array.isArray(worker.models) ? worker.models : []).filter((model) => objectValue(model) && typeof model.id === 'string').map((model) => {
      const attachments = {};
      for (const kind of ['image', 'file']) {
        const option = model.attachments?.[kind];
        attachments[kind] = { supported: option?.supported === true, mode: publicReason(option?.mode), reason: publicReason(option?.reason),
          content_types: (Array.isArray(option?.content_types) ? option.content_types : []).filter((item) => typeof item === 'string').map(publicReason).slice(0, 16) };
      }
      return {
        id: model.id.slice(0, 180), aliases: (Array.isArray(model.aliases) ? model.aliases : []).filter((a) => typeof a === 'string').slice(0, 40),
        availability: availability(model.availability, ready),
        thinking: { allowed: ['default', ...(Array.isArray(model.thinking?.allowed) ? model.thinking.allowed : []).filter((mode) => ['on', 'off'].includes(mode))],
          default: 'default', reasons: { on: publicReason(model.thinking?.reasons?.on), off: publicReason(model.thinking?.reasons?.off) } },
        stream: { supported: model.stream?.supported === true, semantics: publicReason(model.stream?.semantics), reason: publicReason(model.stream?.reason) }, attachments,
      };
    });
    workers[name] = { configured: worker.configured === true, default_model: typeof worker.default_model === 'string' ? worker.default_model : null, availability: ready, models };
  }
  return { schema_version: 2, platform: publicReason(value.platform) || 'unknown', workers,
    attachment_limit_bytes: Number(value.attachment_limit_bytes) > 0 ? Number(value.attachment_limit_bytes) : 1024 * 1024 };
}

export function taskCapability(document, agent, model, options = {}) {
  agent = canonicalAgent(agent);
  const fail = (reason) => ({ allowed: false, reason });
  for (const key of ['effort', 'contextTier', 'autoTier', 'extra_args']) {
    if (options[key] !== undefined && options[key] !== null && options[key] !== '') return fail(`${key} 不是已验证的运行控制；请使用思考开关和流式选项`);
  }
  if (options.thinking !== undefined && !['default', 'on', 'off'].includes(options.thinking)) return fail('thinking 必须为 default/on/off');
  if (options.stream !== undefined && typeof options.stream !== 'boolean') return fail('stream 必须是布尔值');
  const worker = document?.workers?.[agent];
  if (!worker?.configured || !worker.availability?.enabled) return fail(worker?.availability?.reason || '该 worker 尚无可用的能力信息或运行通道');
  const requested = !model || ['default', '默认'].includes(model) ? worker.default_model : model;
  const selected = worker.models.find((entry) => entry.id === requested || entry.aliases.includes(requested));
  if (!selected) return fail(`当前 Hub 未配置模型 ${requested || '(默认模型未知)'}`);
  if (!selected.availability.enabled) return fail(selected.availability.reason || '选定模型当前不可用');
  const thinking = options.thinking || 'default';
  if (!selected.thinking.allowed.includes(thinking)) return fail(selected.thinking.reasons[thinking] || `选定模型不支持 thinking=${thinking}`);
  if (options.stream === true && !selected.stream.supported) return fail(selected.stream.reason || '该通道尚未验证流式正文输出');
  if (options.attachments !== undefined && !Array.isArray(options.attachments)) return fail('attachments 必须是数组');
  for (const attachment of options.attachments || []) {
    const kind = typeof attachment?.mime_type === 'string' && attachment.mime_type.startsWith('image/') ? 'image' : 'file';
    if (!selected.attachments[kind].supported) return fail(selected.attachments[kind].reason || `选定模型不支持${kind === 'image' ? '图片' : '文件'}附件`);
  }
  return { allowed: true, model: selected.id, capability: selected };
}

function buildWorkerExtraArgs(agentName, params = {}) {
  for (const key of ['effort', 'contextTier', 'autoTier']) {
    if (params[key] !== undefined) { const error = new Error(`${key} 不是已验证的运行控制，请使用 thinking`); error.status = 400; throw error; }
  }
  return [];
}

/** 各 CLI worker 的会话续接 flag 映射 */
const CLI_RESUME_FLAGS = {
  'github-copilot': '-r',
  codebuddy: '-r',
  'codebuddy-cn': '-r',
  antigravity: '--conversation',
  mimocode: '-s',
};

/**
 * 构造用于 CLI 会话续接的额外参数
 * @param {string} agentName
 * @param {any} thread
 */
function buildDispatchExtraArgs(agentName, thread) {
  if (!thread) return undefined;
  // copilot 特例: 首次发送即带 extra_args=['-n', <WebUI session id>], 完成后直接 cliSessionId=<WebUI session id>
  if (agentName === 'github-copilot') {
    if (thread.cliSessionId) {
      return ['-r', String(thread.cliSessionId)];
    }
    return ['-n', String(thread.id)];
  }
  if (!thread.cliSessionId) {
    return undefined; // 全新 CLI 会话
  }
  const sid = String(thread.cliSessionId);
  const flag = CLI_RESUME_FLAGS[agentName];
  if (!flag) return undefined;
  if (agentName === 'mimocode' && sid === 'CONTINUE') {
    return ['-c'];
  }
  return [flag, sid];
}

const DEFAULT_TIMEOUT_MS = 25_000;
const DISPATCH_TIMEOUT_MS = 130_000;
const WATCHER_MS = 6_000;
const REF_POLL_MS = 5_000;

// ---------------------------------------------------------------- hub JSON-RPC

/** @param {string} url @param {object} payload @param {number} timeoutMs */
function rpcRaw(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error('枢纽地址无效'));
      return;
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf-8');
    const req = createHttpReq(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'content-length': String(body.length),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', (err) => reject(new Error(sanitizeHubError(err.message))));
      res.on('aborted', () => reject(new Error('枢纽响应中断，执行状态未确认')));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode && res.statusCode >= 400) {
          let host = '';
          try { host = hostOf(url); } catch { /* ignore */ }
          // 常见坑: 端口被 python -m http.server 等静态服务占用, POST 一律 501/405
          if (res.statusCode === 501 && /Directory listing|<!DOCTYPE HTML>/i.test(text)) {
            reject(new Error(`${host} 被静态文件服务器占用(不是枢纽)。先结束该进程, 再运行 start-hub.bat 启动 agent_hub.py --http`));
          } else {
            reject(new Error(`枢纽 HTTP ${res.statusCode}`));
          }
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error('枢纽响应不是合法 JSON'));
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('枢纽请求超时')));
    req.on('error', (err) => reject(new Error(sanitizeHubError(err.message))));
    req.end(body);
  });
}

function createHttpReq(target, options, cb) {
  const mod = target.protocol === 'https:' ? https : http;
  return mod.request({
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.pathname + target.search,
    ...options,
  }, cb);
}

/** URL 或错误文本可能带 token, 一律脱敏 */
function sanitizeHubError(msg) {
  return String(msg || '').replace(/([?&]token=)[^&\s]+/g, '$1***').slice(0, 200);
}

function makeHub(getEndpoint) {
  let seq = 0;
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  function validateResponse(resp, id) {
    if (!object(resp) || resp.jsonrpc !== '2.0' || resp.id !== id ||
        Object.hasOwn(resp, 'result') === Object.hasOwn(resp, 'error')) {
      throw new Error('枢纽 JSON-RPC 响应格式或请求 ID 不匹配');
    }
    if (Object.hasOwn(resp, 'error')) {
      if (!object(resp.error) || typeof resp.error.message !== 'string' || !Number.isInteger(resp.error.code)) {
        throw new Error('枢纽 JSON-RPC 错误格式无效');
      }
      throw new Error(sanitizeHubError(resp.error.message));
    }
    if (!object(resp.result)) throw new Error('枢纽结果格式无效');
    return resp.result;
  }
  /** @returns {Promise<string>} 工具返回的文本 */
  async function callTool(name, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const ep = getEndpoint();
    const url = ep.token ? `${ep.url}${ep.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(ep.token)}` : ep.url;
    const id = ++seq;
    const resp = await rpcRaw(url, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args || {} } }, timeoutMs);
    const toolResult = validateResponse(resp, id);
    const content = toolResult.content;
    if (!Array.isArray(content) || content.some((c) => !object(c) || typeof c.type !== 'string' || (c.type === 'text' && typeof c.text !== 'string')) ||
        (Object.hasOwn(toolResult, 'isError') && typeof toolResult.isError !== 'boolean') ||
        (Object.hasOwn(toolResult, 'structuredContent') && !object(toolResult.structuredContent))) {
      throw new Error('枢纽工具结果格式无效');
    }
    const blocks = content.filter((c) => c.type === 'text');
    if (!blocks.length) throw new Error('枢纽工具未返回文本内容');
    const text = blocks.map((c) => c.text).join('\n');
    let result = toolResult.structuredContent;
    if (!result) { try { result = JSON.parse(text); } catch { /* 普通文本合同 */ } }
    if (toolResult.isError || ['failed', 'unknown', 'error'].includes(result?.status)) {
      const error = new Error(result?.answer || result?.error || text || '工具执行出错');
      error.hubStatus = result?.status || 'failed';
      error.ref = validHubRef(result?.ref) ? result.ref : extractDispatchRef(text);
      throw error;
    }
    return text;
  }
  async function ping(timeoutMs = 8_000) {
    const ep = getEndpoint();
    const url = ep.token ? `${ep.url}${ep.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(ep.token)}` : ep.url;
    const t0 = Date.now();
    const id = ++seq;
    const resp = await rpcRaw(url, { jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-hub-console', version: VERSION } } }, timeoutMs);
    const result = validateResponse(resp, id);
    if (!object(result.serverInfo) || typeof result.serverInfo.name !== 'string') throw new Error('枢纽初始化结果格式无效');
    return { latencyMs: Date.now() - t0, serverInfo: result.serverInfo };
  }
  return { callTool, ping };
}

// ---------------------------------------------------------------- 文本解析 (以源码+实测格式为准)

function failParse(what, text) {
  const err = new Error(`${what}返回了无法解析的内容`);
  // @ts-ignore
  err.raw = text.slice(0, 400);
  throw err;
}

function parseAgents(text) {
  if (/^\(暂无/.test(text.replace(/^已注册代理:\s*/, ''))) return [];
  if (!text.startsWith('已注册代理')) failParse('代理清单', text);
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('- ')) {
      if (line.trim() === '' || line.startsWith('已注册代理')) continue;
      failParse('代理清单', text);
    }
    const m = line.match(/^- (\S+) \[(在线|离线)\] 角色: (.*?) \| CLI: (.*)$/);
    if (!m) failParse('代理清单', text);
    out.push({
      name: m[1],
      online: m[2] === '在线',
      role: m[3],
      cli: m[4] === '未配置' ? null : m[4],
    });
  }
  return out;
}

function parseTasks(text) {
  if (/^没有匹配的任务/.test(text)) return { items: [], shown: 0, total: 0 };
  const m0 = text.match(/^共 (\d+) 条/);
  if (!m0 || !text.includes(':\n')) failParse('任务队列', text);
  const items = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('- ')) {
      if (line.startsWith('共 ')) continue;
      failParse('任务队列', text);
    }
    const m = line.match(/^- (\S+) \[(\w+)\] (.*?) \| 发起: (\S+) -> 指派: (\S+) \| 执行: (\S+) \| 优先级: (\S+)$/);
    if (!m) failParse('任务队列', text);
    items.push({
      id: m[1], status: m[2], title: m[3], from: m[4],
      to: m[5] === '无' ? null : m[5], claimedBy: m[6] === '-' ? null : m[6], priority: m[7],
    });
  }
  return { items, shown: items.length, total: Number(m0[1]) };
}

function parseModels(text) {
  /** @type {Record<string, {modelArg: string|null, models: Array<{alias:string,id:string}>, defaultModelId: string|null, note?:string}>} */
  const map = {};
  const body = text.replace(/^各 worker 可选模型:\s*/, '');
  if (body.startsWith('(还没有')) return map;
  for (const line of body.split('\n')) {
    if (!line.startsWith('- ')) {
      if (line.trim() === '') continue;
      failParse('模型清单', text);
    }
    const m = line.match(/^- (\S+): model_arg=(\S+)(?: \| (.*))?$/);
    if (!m) failParse('模型清单', text);
    const models = [];
    let defaultModelId = null;
    let note = '';
    const rest = m[3] || '';
    if (rest.includes('未配别名表')) {
      note = 'model 参数原样传给 CLI';
    } else {
      for (const seg of rest.split(', ')) {
        if (!seg) continue;
        const p = seg.split('→');
        if (p.length !== 2) { failParse('模型清单', text); }
        if (p[0] === '默认' || p[0] === 'default') {
          defaultModelId = p[1];
        } else {
          models.push({ alias: p[0], id: p[1] });
        }
      }
    }
    map[m[1]] = { modelArg: m[2] === '未配置' ? null : m[2], models, defaultModelId, note };
  }
  return map;
}

function parseNoteKeys(text) {
  const body = text.replace(/^全部笔记:\s*/, '');
  if (body === '(空)' || body === '') return [];
  return body.split(', ').map((s) => s.trim()).filter(Boolean);
}

function parseNoteOne(key, text) {
  if (text.startsWith(`没有笔记「${key}」`)) return null;
  const m = text.match(/^(.*?) = ([\s\S]*) \(by ([^)]+)\)$/);
  if (!m || m[1] !== key) failParse(`笔记「${key}」`, text);
  return { key, value: m[2], by: m[3] };
}

function parseInbox(agent, text) {
  const body = text.startsWith(`${agent} 没有未读消息。`) ? null : text;
  if (body === null) return [];
  const m0 = body.match(new RegExp(`^${agent} 有 (\\d+) 条未读(?:，本次返回 \\d+ 条)?:\\n`));
  if (!m0) return [];
  /** @type {Array<{ts:string,from:string,text:string}>} */
  const msgs = [];
  let cur = null;
  for (const line of body.slice(m0[0].length).split('\n')) {
    const m2 = line.match(/^- \[(\d\d-\d\d \d\d:\d\d)\] ([^:]+): ([\s\S]*)$/);
    if (m2) {
      if (cur) msgs.push(cur);
      cur = { ts: m2[1], from: m2[2], text: m2[3] };
    } else if (cur) {
      cur.text += '\n' + line;
    } else if (line.trim() !== '') {
      failParse('收件箱', text);
    }
  }
  if (cur) msgs.push(cur);
  return msgs;
}

function validHubRef(value) {
  return typeof value === 'string' && /^[\w.-]+-[0-9a-f]{10}$/i.test(value);
}

function extractDispatchRef(text) {
  try {
    const value = JSON.parse(text);
    if (value && ['running', 'pending', 'accepted', 'unknown'].includes(value.status) && validHubRef(value.ref)) return value.ref;
    return null;
  } catch { /* 文本合同 */ }
  const header = /^\[([^\]\r\n]+)\]([^\r\n]*)/.exec(String(text).trimStart());
  if (!header || /\bexit=|\bstatus=(?:completed|failed|error|cancelled|timeout)\b/.test(header[2]) ||
      !/受理|异步|\baccepted\b|\bstatus=(?:running|pending)\b/i.test(header[2])) return null;
  const ref = header[1].split('/').at(-1);
  if (header[1].includes('/') && validHubRef(ref)) return ref;
  const quoted = /\bref="([^"]+)"/.exec(header[2]);
  return quoted && validHubRef(quoted[1]) ? quoted[1] : null;
}

function extractResultStatus(text) {
  const statuses = new Set(['running', 'pending', 'completed', 'failed', 'error', 'unknown', 'cancelled', 'timeout']);
  try { const value = JSON.parse(text); if (statuses.has(value?.status)) return value.status; } catch { /* 文本合同 */ }
  const m = text.split('\n', 1)[0].match(/^\[[^\]\r\n]+\][^\r\n]*\bstatus=([\w-]+)/);
  if (m && statuses.has(m[1])) return m[1];
  if (/^未找到 /.test(text)) return 'pending';
  return 'unknown';
}

/** 从 hub_result 文本里剥离头部, 拿正文 */
function extractResultBody(text) {
  return String(text).replace(/^\[[^\]]*\][^\n]*\n+?/, '').trim() || String(text).trim();
}

/** 从 results/<ref>.json 解析任务文本 (兼容字符串、数组 cmd、JSON 字符串) */
function extractTaskText(data) {
  if (!data) return '';
  let raw = data.task ?? data.cmd;
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try { raw = JSON.parse(raw); } catch { /* noop */ }
  }
  if (Array.isArray(raw)) {
    const pIdx = raw.indexOf('-p');
    if (pIdx !== -1) {
      if (raw[pIdx + 1] === '-y' && raw[pIdx + 2] && !raw[pIdx + 2].startsWith('-')) {
        return raw[pIdx + 2];
      }
      if (raw[pIdx + 1] && !raw[pIdx + 1].startsWith('-')) {
        return raw[pIdx + 1];
      }
    }
    const msgIdx = raw.indexOf('--message');
    if (msgIdx !== -1 && raw[msgIdx + 1]) {
      return raw[msgIdx + 1];
    }
    if (raw.length >= 3 && typeof raw[1] === 'string' && raw[1].includes('zcode_dom.js')) {
      return raw[2];
    }
    const nonOptions = raw.filter((x) => typeof x === 'string' && !x.startsWith('-') && !x.startsWith('/'));
    if (nonOptions.length) {
      return nonOptions.sort((a, b) => b.length - a.length)[0];
    }
    return raw.join(' ');
  }
  return typeof raw === 'string' ? raw : (raw ? String(raw) : '');
}

function tsNow() { return Date.now(); }

/** 对相邻连续消息去重: role 相同、text 完全相同且 ts 相差 < 10s 的连续消息只保留最早一条（用户消息 role=me 不去重） */
function dedupAdjacentMessages(messages) {
  if (!Array.isArray(messages) || messages.length <= 1) return messages || [];
  const res = [];
  for (const m of messages) {
    const prev = res[res.length - 1];
    const isDup = prev &&
      m.role !== 'me' &&
      m.role === prev.role &&
      m.text === prev.text &&
      Math.abs((m.ts || 0) - (prev.ts || 0)) < 10_000;
    if (!isDup) res.push(m);
  }
  return res;
}

function fmtClock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function slug(s) {
  return String(s).replace(/[^\w.\-一-龥]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'agent';
}

// ---------------------------------------------------------------- 客户端页面由 Node 读取

/** @param {MiniAppContext} context */
export async function start(context) {
  // 宿主安装包使用 miniapp/client，源码和 standalone 使用相邻的 client。
  // 在绑定端口前读取，启动失败时不会留下后台服务。
  const clientPath = [join(context.pluginRoot, 'miniapp/client/index.html'), join(dirname(fileURLToPath(import.meta.url)), 'client/index.html')].find(existsSync);
  if (!clientPath) throw new Error('控制台页面不存在');
  const clientEntry = await readFile(clientPath);
  let disposing = false;
  const dataDir = context.dataDir;
  await mkdir(dataDir, { recursive: true });
  const configPath = join(dataDir, 'config.json');
  const artifactDir = join(dataDir, 'artifacts');
  const uploadsDir = join(dataDir, 'uploads');
  await mkdir(uploadsDir, { recursive: true });
  const convPath = join(dataDir, 'conversations.json');
  const endpointFile = join(dataDir, 'subagent-endpoint.json');
  const avatarsPath = join(dataDir, 'avatars.json');
  await mkdir(artifactDir, { recursive: true });

  /** @type {Record<string, { emoji?: string, img?: string }> | null} */
  let avatarsCache = null;
  async function loadAvatars() {
    if (avatarsCache !== null) return avatarsCache;
    try {
      const raw = await readFile(avatarsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      avatarsCache = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch {
      avatarsCache = {};
    }
    return avatarsCache;
  }

  /** @type {{activeId:string, endpoints:Array<{id:string,label:string,url:string,token:string}>, selfAgent?:string, selfRole?:string, autoDispatch?:boolean}} */
  let config = { ...DEFAULT_CONFIG, endpoints: DEFAULT_CONFIG.endpoints.map((e) => ({ ...e })) };
  let configDirty = false;
  try {
    const saved = JSON.parse(await readFile(configPath, 'utf-8'));
    if (saved && typeof saved === 'object') {
      if (Array.isArray(saved.endpoints) && saved.endpoints.length > 0) {
        const cleaned = saved.endpoints.filter((e) => e && e.id && e.id !== 'local');
        if (cleaned.length > 0) {
          config.endpoints = cleaned;
          if (cleaned.length !== saved.endpoints.length) configDirty = true;
        } else {
          configDirty = true;
        }
      }
      if (typeof saved.activeId === 'string') {
        config.activeId = saved.activeId;
      }
      if (typeof saved.selfAgent === 'string' && saved.selfAgent.trim()) {
        config.selfAgent = saved.selfAgent.trim();
      }
      if (typeof saved.selfRole === 'string' && saved.selfRole.trim()) {
        config.selfRole = saved.selfRole.trim();
      }
    }
  } catch {
    /* 首次运行使用默认配置 */
    configDirty = true;
  }

  // 兜底：若 saved.activeId 缺失/为 "local"/不在端点表内 → 强制纠正为 "server" 并写回 config.json
  if (!config.activeId || config.activeId === 'local' || !config.endpoints.some((e) => e.id === config.activeId)) {
    config.activeId = config.endpoints.some((e) => e.id === 'server') ? 'server' : (config.endpoints[0]?.id || 'server');
    configDirty = true;
  }

  if (configDirty) {
    try {
      await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch {
      /* 写回失败不影响主流程 */
    }
  }

  // 三级身份解析: env > config.json (selfAgent/selfRole) > 默认值 ('console' / '子代理控制台')
  SELF_AGENT = (process.env.HUBCONSOLE_SELF_AGENT && process.env.HUBCONSOLE_SELF_AGENT.trim())
    || (config.selfAgent && String(config.selfAgent).trim())
    || 'console';
  SELF_ROLE = (process.env.HUBCONSOLE_SELF_ROLE && process.env.HUBCONSOLE_SELF_ROLE.trim())
    || (config.selfRole && String(config.selfRole).trim())
    || '子代理控制台';

  const getEndpoint = () => {
    const ep = config.endpoints.find((e) => e.id === config.activeId) || config.endpoints[0];
    if (!ep) throw new Error('没有可用枢纽端点');
    return ep;
  };
  const hub = makeHub(getEndpoint);

  async function readCapabilities() {
    try { return normalizeCapabilities(JSON.parse(await hub.callTool('hub_capabilities', {}))); }
    catch (error) { throw badReqSoft(publicReason(error?.message) || '无法读取 Hub 能力信息，尚未派发任务'); }
  }
  async function requireTaskCapability(agent, model, options, document) {
    const check = taskCapability(document || await readCapabilities(), agent, model, options);
    if (!check.allowed) throw badReqSoft(check.reason);
    return check;
  }
  function capabilityCatalog(document) {
    return Object.fromEntries(Object.entries(document?.workers || {}).map(([agent, worker]) => [agent, worker.models.map((model) => {
      const label = (MODEL_CATALOG[agent] || []).find((entry) => entry.id === model.id);
      return { id: model.id, name: label?.name || model.id, default: worker.default_model === model.id,
        available: worker.availability.enabled && model.availability.enabled,
        reason: model.availability.reason || worker.availability.reason, capability: model };
    })]));
  }

  // ---------------- 单一域服务: 所有变更都经这里, 成功(远端已提交)后广播
  const sseClients = new Set();
  function broadcast(payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
      try { res.write(data); } catch { /* 广播失败不回滚, 重连页面按快照恢复 */ }
    }
  }

  /** @type {null | Promise<any>} 合并并发快照请求 */
  let snapshotInFlight = null;
  function snapshot() {
    if (snapshotInFlight) return snapshotInFlight;
    snapshotInFlight = (async () => {
      const ep = getEndpoint();
      let pingInfo = null;
      let pingError = null;
      try {
        pingInfo = await hub.ping();
      } catch (err) {
        pingError = sanitizeHubError(err && err.message);
      }
      if (pingError) {
        return {
          ok: false,
          error: pingError,
          endpoint: { id: ep.id, label: ep.label, host: hostOf(ep.url) },
          agents: [], tasks: [], notes: [], models: {},
          subagent: subagentInfo(),
          modelCatalog: {}, capabilities: null, capabilitiesError: pingError,
          workerParams: WORKER_PARAMS,
        };
      }
      const [agentsText, tasksText, modelsText, noteKeysText, capsResult] = await Promise.all([
        hub.callTool('hub_list_agents', {}),
        hub.callTool('hub_list_tasks', {}),
        hub.callTool('hub_list_models', {}),
        hub.callTool('hub_note_get', {}),
        readCapabilities().then((value) => ({ value })).catch((error) => ({ error: publicReason(error.message) })),
      ]);
      const capabilityDocument = capsResult.value || null;
      const modelCatalog = capabilityCatalog(capabilityDocument);
      const agents = parseAgents(agentsText);
      const modelsMap = parseModels(modelsText);
      const tasks = parseTasks(tasksText);
      const noteKeys = parseNoteKeys(noteKeysText);
      const noteResults = await Promise.all(noteKeys.map((k) => hub.callTool('hub_note_get', { key: k }).then((t) => parseNoteOne(k, t)).catch(() => null)));
      for (const a of agents) {
        const mi = modelsMap[a.name];
        a.modelArg = mi ? mi.modelArg : null;
        const worker = capabilityDocument?.workers[a.name];
        a.models = (modelCatalog[a.name] || []).map((entry) => ({ ...entry, alias: entry.name }));
        a.defaultModel = worker?.default_model || null;
        a.availability = worker?.availability || { enabled: false, reason: capsResult.error || 'Hub 未提供此 worker 的能力信息' };
        a.modelNote = mi ? mi.note || '' : (a.cli ? '未出现在模型别名表' : '未配置 CLI 通道');
        // 激活判定优化: 心跳窗口过期 ≠ 不可用。有 CLI 直通/专用通道即可随时派发(服务端主动拉起 worker)
        a.dispatchable = (!!a.cli || !!DISPATCH_OVERRIDES[a.name]) && !!worker?.configured && worker.availability.enabled;
        a.activation = a.online ? 'online' : (a.dispatchable ? 'standby' : 'queue-only');
        a.activationNote = a.online ? '在线 · 可即时收发消息'
          : (a.dispatchable ? '心跳窗口过期 · CLI/专用通道仍可直通派发（首次响应较慢）' : '心跳过期且无直通通道 · 仅可入队等待其认领');
      }
      return {
        ok: true,
        version: VERSION,
        latencyMs: pingInfo.latencyMs,
        serverInfo: pingInfo.serverInfo,
        endpoint: { id: ep.id, label: ep.label, host: hostOf(ep.url) },
        self: { agent: SELF_AGENT, role: SELF_ROLE, onlineWindowSec: 600 },
        onlineWindowNote: ONLINE_WINDOW_NOTE,
        agents,
        tasks: tasks.items,
        taskTotal: tasks.total,
        notes: noteResults.filter(Boolean),
        endpoints: config.endpoints.map((e) => ({ id: e.id, label: e.label, host: hostOf(e.url) })),
        subagent: subagentInfo(),
        modelCatalog, capabilities: capabilityDocument, capabilitiesError: capsResult.error || null,
        platform: capabilityDocument?.platform || 'unknown',
        workerParams: WORKER_PARAMS,
      };
    })().finally(() => { snapshotInFlight = null; });
    return snapshotInFlight;
  }

  function hostOf(u) {
    try { return new URL(u).host; } catch { return '?'; }
  }

  let quotasCache = null;
  let quotasCacheTime = 0;
  let quotasFetchInFlight = null;

  async function getQuotas() {
    const now = Date.now();
    if (quotasCache && (now - quotasCacheTime < 60_000)) {
      return quotasCache;
    }
    if (quotasFetchInFlight) {
      return quotasFetchInFlight;
    }
    quotasFetchInFlight = (async () => {
      const ROUTER_URL = 'http://127.0.0.1:20128';
      const CID_MAP = {
        antigravity: '258f489a-1b2d-430c-b5e7-9e64df53706b',
        codebuddy: 'ae5ef69e-df9a-4417-9b1f-d081d75b336f',
        'codebuddy-cn': '275e1c1a-b25e-4b3f-848f-958af1c3132d',
        traecode: '57066f52-4027-4a2d-9fd4-756e047ad5f0',
        'github-copilot': 'c19b0e0c-5792-4dd3-aeb1-07d345f353d9',
      };
      const result = {
        zcode: { tracked: false },
        mimocode: { tracked: false },
      };
      await Promise.all(Object.entries(CID_MAP).map(async ([platform, cid]) => {
        try {
          const res = await fetch(`${ROUTER_URL}/api/usage/${cid}`, { signal: AbortSignal.timeout(8000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const plan = data.plan || (data.subscriptionInfo && data.subscriptionInfo.currentTier && data.subscriptionInfo.currentTier.name) || '未知套餐';
          const quotas = Object.entries(data.quotas || {}).map(([name, q]) => ({
            name,
            displayName: q.displayName || name,
            used: typeof q.used === 'number' ? q.used : 0,
            total: typeof q.total === 'number' ? q.total : 0,
            remaining: typeof q.remaining === 'number' ? q.remaining : (typeof q.total === 'number' && typeof q.used === 'number' ? Math.max(0, q.total - q.used) : 0),
            remainingPercentage: typeof q.remainingPercentage === 'number' ? Math.round(q.remainingPercentage * 10) / 10 : (q.total ? Math.round((q.total - q.used) / q.total * 1000) / 10 : 0),
            resetAt: q.resetAt || null,
            unlimited: !!q.unlimited,
            recurring: !!q.recurring,
          }));
          result[platform] = { tracked: true, plan, quotas };
        } catch (err) {
          result[platform] = { error: err.message || '查询失败' };
        }
      }));
      // minimaxcode 配额走 mmx CLI
      try {
        const mmxBin = process.env.MMX_BIN || join(os.homedir(), '.npm-global', 'bin', 'mmx');
        const { stdout } = await execFile(mmxBin, ['quota', 'show', '--output', 'json'], { timeout: 10_000 });
        const jsonIdx = stdout.indexOf('{');
        const jsonText = jsonIdx >= 0 ? stdout.slice(jsonIdx) : stdout;
        const mmxData = JSON.parse(jsonText);
        const nameMap = { general: '通用', video: '视频', image: '图像', audio: '音频' };
        const quotas = (mmxData.model_remains || []).map((element) => {
          const model_name = element.model_name;
          return {
            name: model_name,
            displayName: nameMap[model_name] || model_name,
            used: typeof element.current_interval_usage_count === 'number' ? element.current_interval_usage_count : 0,
            total: typeof element.current_interval_total_count === 'number' ? element.current_interval_total_count : 0,
            remaining: 0,
            remainingPercentage: typeof element.current_interval_remaining_percent === 'number' ? element.current_interval_remaining_percent : 0,
            resetAt: null,
            weeklyPercentage: typeof element.current_weekly_remaining_percent === 'number' ? element.current_weekly_remaining_percent : 0,
          };
        });
        result.minimaxcode = { tracked: true, plan: 'MiniMax Token Plan', quotas };
      } catch (err) {
        result.minimaxcode = { tracked: false };
      }
      // codebuddy 国内+国际分组: 各组分别计算总剩余与 top 5
      const round2 = (n) => Math.round(n * 100) / 100;
      const parts = [];
      if (result.codebuddy && result.codebuddy.tracked) parts.push({ src: '国际', r: result.codebuddy });
      if (result['codebuddy-cn'] && result['codebuddy-cn'].tracked) parts.push({ src: '国内', r: result['codebuddy-cn'] });
      if (parts.length) {
        const ts = Date.now();
        const byExpiry = (q) => (q.resetAt ? new Date(q.resetAt).getTime() : Number.MAX_SAFE_INTEGER);
        const groups = [];
        for (const { src, r } of parts) {
          const quotas = [];
          for (const q of r.quotas || []) {
            // 非循环且已过期的包视为已失效, 不计入总数与清单
            if (!q.unlimited && !q.recurring && q.resetAt && new Date(q.resetAt).getTime() <= ts) continue;
            quotas.push({
              ...q,
              source: src,
              displayName: q.displayName || q.name,
              remaining: round2(q.remaining || 0),
            });
          }
          const top = quotas
            .filter((q) => !q.unlimited && (q.remaining || 0) > 50)
            .sort((a, b) => byExpiry(a) - byExpiry(b))
            .slice(0, 5);
          groups.push({
            source: src,
            plan: r.plan,
            totalRemaining: round2(quotas.reduce((s, q) => s + (q.remaining || 0), 0)),
            packageCount: quotas.length,
            top,
            quotas,
          });
        }
        const SOURCE_ORDER = { '国内': 0, '国际': 1 };
        groups.sort((a, b) => (SOURCE_ORDER[a.source] ?? 99) - (SOURCE_ORDER[b.source] ?? 99));

        const sources = groups.map((g) => g.source);
        result.codebuddy = {
          tracked: true,
          plan: groups.length === 2 ? '国内+国际' : `${sources.join('+')}（${groups[0].plan}）`,
          groups,
        };
      } else {
        result.codebuddy = { error: (result.codebuddy && result.codebuddy.error) || (result['codebuddy-cn'] && result['codebuddy-cn'].error) || '查询失败' };
      }
      delete result['codebuddy-cn'];
      quotasCache = result;
      quotasCacheTime = Date.now();
      return result;
    })().finally(() => {
      quotasFetchInFlight = null;
    });
    return quotasFetchInFlight;
  }

  async function mutate(label, fn) {
    try {
      const result = await fn();
      broadcast({ type: 'changed', label });
      context.logger.info('miniapp.hub.mutation', { label });
      return result;
    } catch (err) {
      const msg = sanitizeHubError(err && err.message);
      context.logger.warn('miniapp.hub.mutation_failed', { label, error: msg.slice(0, 120) });
      const e = new Error(msg);
      // @ts-ignore
      e.status = 502;
      throw e;
    }
  }

  // ---------------- 产物落盘 (内容产物留在本机, 对话只回摘要)
  async function writeArtifact(agentName, tag, text) {
    const name = `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${slug(agentName)}-${slug(tag)}.md`;
    const path = join(artifactDir, name);
    try {
      await writeFile(path, `# ${agentName} · ${tag}\n\n> ${new Date().toISOString()} · agent-hub-console v${VERSION}\n\n${String(text).slice(0, ARTIFACT_CAP)}\n`, 'utf-8');
      return path;
    } catch (err) {
      context.logger.warn('miniapp.artifact.write_failed', { error: String(err && err.message).slice(0, 120) });
      return null;
    }
  }

  // ---------------- 上传 (图片输入/文件上传): 存 dataDir/uploads, /uploads/ 回读
  const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
  const TEXT_EXT_RE = /\.(md|txt|log|markdown|json|ya?ml|csv|tsv|js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|c|h|cpp|hpp|cs|php|rb|sh|ps1|bat|cmd|sql|ini|conf|cfg|toml|html|htm|css|xml|vue|svelte|swift|kt|lua|r|tex|srt|vtt|diff|patch)$/i;
  const UPLOAD_MAX_BYTES = 8_000_000;
  const INLINE_TEXT_MAX = 30_000;
  function badReqSoft(msg) { const e = new Error(msg); /** @ts-ignore */ e.status = 400; return e; }
  function safeFileName(name) {
    let s = String(name || 'file').split(/[\\/]/).pop().replace(/[\x00-\x1f"<>|:*?]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
    return s || 'file';
  }
  async function saveUpload(name, b64) {
    const base = safeFileName(name);
    if (/^(?:\.env(?:\..*)?|\.?auth\.json|\.?credentials(?:\.json|\.ya?ml)?|id_(?:rsa|ed25519))$/i.test(base) || /\.(?:key|pem)$/i.test(base)) throw badReqSoft('凭据文件不能作为任务附件上传');
    const encoded = String(b64 || '').replace(/^data:[^;]+;base64,/, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw badReqSoft('base64 不合法');
    const buf = Buffer.from(encoded, 'base64');
    if (!buf.length) throw badReqSoft('文件内容为空或 base64 不合法');
    if (buf.length > UPLOAD_MAX_BYTES) throw badReqSoft(`文件超过 ${UPLOAD_MAX_BYTES / 1e6}MB 上限`);
    const fname = `${randomUUID()}-${base}`;
    await writeFile(join(uploadsDir, fname), buf, { flag: 'wx' });
    let content = null;
    if (TEXT_EXT_RE.test(base) && buf.length <= INLINE_TEXT_MAX * 4) {
      const s = buf.toString('utf-8');
      if (!s.includes('\u0000')) content = s.slice(0, INLINE_TEXT_MAX);
    }
    return { name: base, url: `/uploads/${encodeURIComponent(fname)}`, path: join(uploadsDir, fname), size: buf.length, isImage: IMG_RE.test(base), content };
  }
  async function portableAttachments(attachments) {
    const out = [];
    let total = 0;
    for (const item of attachments || []) {
      let name;
      try { name = decodeURIComponent(item.url.slice('/uploads/'.length)); } catch { throw badReqSoft('附件 URL 无效'); }
      if (!name || /[\\/\0]/.test(name) || name.includes('..')) throw badReqSoft('附件路径无效');
      const path = resolve(uploadsDir, name);
      if (dirname(path) !== resolve(uploadsDir)) throw badReqSoft('附件超出上传目录');
      let info, data;
      try {
        info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('not a regular file');
        total += info.size;
        if (total > 1024 * 1024) throw badReqSoft('派发附件总计不能超过 1 MiB');
        data = await readFile(path);
      } catch (error) { if (error.status) throw error; throw badReqSoft('附件不存在或不可读'); }
      const ext = name.split('.').at(-1).toLowerCase();
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', pdf: 'application/pdf', json: 'application/json' }[ext] || 'text/plain';
      out.push({ name: item.name, mime_type: mime, data_base64: data.toString('base64') });
    }
    return out;
  }
  function uploadAttachments(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 4) throw badReqSoft('attachments 必须是数组，最多 4 个附件');
    return value.map((item) => {
      if (!objectValue(item) || typeof item.url !== 'string' || !/^\/uploads\/[\w.%\-]{1,2048}$/.test(item.url)) throw badReqSoft('附件 url 非法');
      return { url: item.url, name: typeof item.name === 'string' ? item.name.slice(0, 160) : 'file', isImage: !!item.isImage };
    });
  }
  /** 把附件拼成 worker 可用文本: 文本类内联内容, 图片/二进制给本机路径提示 */
  function attBlock(text, attachments) {
    if (!attachments || !attachments.length) return text;
    let out = text;
    for (const a of attachments) {
      if (a.content) out += `\n\n--- 附件「${a.name}」内容 ---\n${a.content}`;
      else if (a.isImage) out += `\n\n[图片附件: ${a.name} · 存于本机 ${a.path || a.url} · 远程 worker 无法直接查看图片文件]`;
      else out += `\n\n[附件: ${a.name} · 本机路径 ${a.path || a.url}]`;
    }
    return out.slice(0, 60_000);
  }

  // ---------------- auto 自动派发: SELF_AGENT 本机无 CLI, 被调用时转派给可用子代理
  const autoPickAt = new Map(); // agent -> 上次自动选用时间 (轮转均衡)
  function pickAutoAgent(agents, model, options, document) {
    const cands = (agents || []).filter((a) => a.name !== SELF_AGENT && a.dispatchable && taskCapability(document, a.name, model, options).allowed);
    if (!cands.length) return null;
    let pool = cands;
    const rank = (a) => (a.activation === 'online' ? 0 : 1);
    pool = pool.slice().sort((a, b) => rank(a) - rank(b) || ((autoPickAt.get(a.name) || 0) - (autoPickAt.get(b.name) || 0)));
    const pick = pool[0];
    autoPickAt.set(pick.name, tsNow());
    return pick;
  }

  // ---------------- tokens 采集
  const usagePath = join(dataDir, 'usage.json');
  /** @type {{total:{in:number,out:number,msgs:number,runs:number}, days:Record<string,{in:number,out:number,msgs:number,runs:number,agents:Record<string,{in:number,out:number,msgs:number,runs:number}>}>, agents:Record<string,{in:number,out:number,msgs:number,runs:number}>}} */
  let usage = { total: { in: 0, out: 0, msgs: 0, runs: 0 }, days: {}, agents: {} };
  try {
    const saved = JSON.parse(await readFile(usagePath, 'utf-8'));
    if (saved && saved.total) usage = saved;
  } catch { /* 首次运行 */ }
  // 每个文件串行、原子替换；退出时等待最后一次写入，避免半份 JSON 和延迟保存丢失。
  function jsonWriter(path, value, delay, event) {
    let dirty = false, timer = null, tail = Promise.resolve();
    const flush = () => {
      clearTimeout(timer); timer = null;
      if (dirty) {
        dirty = false;
        const body = JSON.stringify(value(), (key, v) => key === 'inFlight' ? undefined : v, 1);
        tail = tail.then(async () => {
          const temporary = `${path}.${process.pid}.tmp`;
          try { await writeFile(temporary, body, 'utf-8'); await rename(temporary, path); }
          catch (err) {
            dirty = true;
            await rm(temporary, { force: true }).catch(() => {});
            context.logger.warn(event, { error: String(err?.message).slice(0, 120) });
          }
        });
      }
      return tail;
    };
    return { flush, schedule() {
      dirty = true;
      if (!timer && !disposing) { timer = setTimeout(() => { void flush(); }, delay); timer.unref?.(); }
    } };
  }
  const usageWriter = jsonWriter(usagePath, () => usage, 3000, 'miniapp.usage.save_failed');
  const scheduleUsageSave = () => usageWriter.schedule();
  function estTokens(text) {
    const s = String(text);
    let cjk = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.codePointAt(i);
      if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) || (c >= 0x20000 && c <= 0x3134f)) cjk++;
    }
    return Math.max(1, Math.ceil(cjk + (s.length - cjk) / 4));
  }
  function bump(bucket, dir, t) {
    if (dir === 'in') bucket.in += t; else bucket.out += t;
    bucket.msgs += 1;
  }
  function recordUsage(agentName, dir, text) {
    const t = estTokens(text);
    const day = new Date().toISOString().slice(0, 10);
    if (!usage.days[day]) usage.days[day] = { in: 0, out: 0, msgs: 0, runs: 0, agents: {} };
    const d = usage.days[day];
    if (!d.agents[agentName]) d.agents[agentName] = { in: 0, out: 0, msgs: 0, runs: 0 };
    if (!usage.agents[agentName]) usage.agents[agentName] = { in: 0, out: 0, msgs: 0, runs: 0 };
    bump(usage.total, dir, t); bump(d, dir, t); bump(d.agents[agentName], dir, t); bump(usage.agents[agentName], dir, t);
    scheduleUsageSave();
    return t;
  }
  function recordRun(agentName, ran) {
    if (!ran) return;
    const day = new Date().toISOString().slice(0, 10);
    if (!usage.days[day]) usage.days[day] = { in: 0, out: 0, msgs: 0, runs: 0, agents: {} };
    if (!usage.days[day].agents[agentName]) usage.days[day].agents[agentName] = { in: 0, out: 0, msgs: 0, runs: 0 };
    if (!usage.agents[agentName]) usage.agents[agentName] = { in: 0, out: 0, msgs: 0, runs: 0 };
    usage.total.runs += 1; usage.days[day].runs += 1; usage.days[day].agents[agentName].runs += 1; usage.agents[agentName].runs += 1;
    scheduleUsageSave();
  }

  // ---------------- 会话线程引擎: 服务端持有对话与轮询, 本机会话零 token 消耗 (支持平台内多会话)
  /** @type {{threads: Array<any>, captured: Array<any>}} */
  const conv = { threads: [], captured: [] };
  const convWriter = jsonWriter(convPath, () => conv, 1200, 'miniapp.chat.save_failed');
  const saveConv = () => convWriter.schedule();

  try {
    const saved = JSON.parse(await readFile(convPath, 'utf-8'));
    if (saved && Array.isArray(saved.threads)) {
      conv.threads = saved.threads;
      let cleanedAny = false;
      // 兼容旧结构: 无 sessions 的旧 agent 自动迁移为 sessions[0], 绝不丢历史数据
      for (const t of conv.threads) {
        if (!Array.isArray(t.sessions) || t.sessions.length === 0) {
          const initSessId = t.id || `sess-${t.agent}-${t.created || tsNow()}`;
          const msgs = Array.isArray(t.messages) ? t.messages : [];
          const firstUserMsg = msgs.find((m) => m.role === 'me');
          const title = firstUserMsg ? firstUserMsg.text.slice(0, 30).replace(/\s+/g, ' ') : (msgs[0] ? msgs[0].text.slice(0, 30).replace(/\s+/g, ' ') : '初始对话');
          const s = {
            id: initSessId,
            agent: t.agent,
            title,
            created: t.created || tsNow(),
            updated: t.updated || tsNow(),
            messages: msgs,
            pending: Array.isArray(t.pending) ? t.pending : [],
            unread: t.unread || 0,
            traeSession: t.traeSession,
            cliSessionId: t.cliSessionId || null,
          };
          t.sessions = [s];
          t.activeSessionId = initSessId;
        } else {
          for (const s of t.sessions) {
            s.agent = t.agent;
            if (!Array.isArray(s.messages)) s.messages = [];
            if (!Array.isArray(s.pending)) s.pending = [];
            if (s.unread == null) s.unread = 0;
            if (s.cliSessionId === undefined) s.cliSessionId = null;
            if (!s.title) {
              const u = s.messages.find((m) => m.role === 'me');
              s.title = u ? u.text.slice(0, 30).replace(/\s+/g, ' ') : '新会话';
            }
          }
          if (!t.activeSessionId && t.sessions.length > 0) {
            t.activeSessionId = t.sessions[0].id;
          }
        }
        for (const s of t.sessions) {
          for (const p of s.pending || []) {
            if ('inFlight' in p) { delete p.inFlight; cleanedAny = true; }
            if (!p.posted && !p.firstSeen) { p.posted = tsNow(); cleanedAny = true; }
          }
          const before = (s.messages || []).length;
          s.messages = dedupAdjacentMessages(s.messages);
          if (s.messages.length !== before) cleanedAny = true;
        }
        if (Array.isArray(t.messages)) {
          t.messages = dedupAdjacentMessages(t.messages);
        }
      }
      if (cleanedAny) saveConv();
    }
    if (saved && Array.isArray(saved.captured)) conv.captured = saved.captured;
  } catch { /* 首次运行 */ }

  function getAgentEntry(agentName, create) {
    agentName = AGENT_ALIASES[String(agentName || '').trim().toLowerCase()] || String(agentName || '').trim();
    let t = conv.threads.find((x) => x.agent === agentName);
    if (!t && create) {
      const initSessId = `sess-${agentName}-${tsNow()}`;
      t = {
        id: `th-${agentName}`,
        agent: agentName,
        activeSessionId: initSessId,
        sessions: [
          {
            id: initSessId,
            agent: agentName,
            title: '初始对话',
            created: tsNow(),
            updated: tsNow(),
            messages: [],
            pending: [],
            unread: 0,
            cliSessionId: null,
          },
        ],
      };
      conv.threads.push(t);
      if (conv.threads.length > THREADS_MAX) {
        conv.threads.sort((a, b) => (a.updated || 0) - (b.updated || 0));
        conv.threads = conv.threads.slice(-THREADS_MAX);
      }
    }
    return t;
  }

  function createSession(agentName, initialTitle) {
    const entry = getAgentEntry(agentName, true);
    const sessId = `sess-${agentName}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const newSess = {
      id: sessId,
      agent: agentName,
      title: initialTitle || '新对话',
      created: tsNow(),
      updated: tsNow(),
      messages: [],
      pending: [],
      unread: 0,
      cliSessionId: null,
    };
    if (!Array.isArray(entry.sessions)) entry.sessions = [];
    entry.sessions.unshift(newSess);
    if (entry.sessions.length > 30) {
      entry.sessions = entry.sessions.slice(0, 30);
    }
    entry.activeSessionId = sessId;
    entry.updated = tsNow();
    saveConv();
    broadcast({ type: 'chat', threadId: sessId, agent: agentName, role: 'new-session' });
    return newSess;
  }

  function getThread(agentName, create, sessionId) {
    const entry = getAgentEntry(agentName, create);
    if (!entry) return null;
    if (!Array.isArray(entry.sessions)) entry.sessions = [];
    if (sessionId) {
      const s = entry.sessions.find((x) => x.id === sessionId);
      if (s) {
        s.agent = entry.agent;
        return s;
      }
      throw badReqSoft('会话不存在，请刷新会话列表');
    }
    let active = entry.sessions.find((x) => x.id === entry.activeSessionId);
    if (!active && entry.sessions.length > 0) {
      active = entry.sessions[0];
      entry.activeSessionId = active.id;
    }
    if (!active && create) {
      active = createSession(agentName, '初始对话');
    }
    if (active) active.agent = entry.agent;
    return active;
  }

  function addMsg(thread, role, text, extra) {
    if (!thread) return;
    const str = String(text).slice(0, 8_000);
    const now = tsNow();
    const ref = extra?.ref;
    if (!Array.isArray(thread.messages)) thread.messages = [];
    const isDup = thread.messages.some((m) =>
      (ref && m.ref === ref) ||
      (role !== 'me' && m.role === role && m.text === str && Math.abs(now - (m.ts || 0)) < 10_000)
    );
    if (isDup) return;
    const msg = { role, text: str, ts: now, ...(extra || {}) };
    if (role === 'me' || role === 'agent') msg.tok = recordUsage(thread.agent, role === 'me' ? 'in' : 'out', msg.text);
    thread.messages.push(msg);
    if (thread.messages.length > MSGS_PER_THREAD) thread.messages = thread.messages.slice(-MSGS_PER_THREAD);
    thread.updated = now;
    if (thread.title === '新对话' || thread.title === '初始对话') {
      if (role === 'me' && text) {
        thread.title = text.trim().slice(0, 30).replace(/\s+/g, ' ');
      }
    }
    const entry = getAgentEntry(thread.agent, false);
    if (entry) entry.updated = thread.updated;
    if (role === 'agent') thread.unread = (thread.unread || 0) + 1;
    saveConv();
    broadcast({ type: 'chat', threadId: thread.id, agent: thread.agent, role });
    return msg;
  }

  const deliveringRefs = new Set();
  /** 任务完成后回填 session 的 cliSessionId，用于同 WebUI 会话后续轮次续接 CLI 上下文 */
  async function backfillCliSessionId(thread, dispatchTime) {
    if (!thread || !thread.agent) return;
    const agent = thread.agent;

    // copilot 特例: 首次发送即带 extra_args=['-n', <WebUI session id>], 完成后直接 cliSessionId=<WebUI session id>
    if (agent === 'github-copilot') {
      if (!thread.cliSessionId) {
        thread.cliSessionId = thread.id;
        saveConv();
      }
      return;
    }

    // 已有具体 CLI session 绑定 (且非 CONTINUE 降级哨兵) 则维持当前绑定
    if (thread.cliSessionId && thread.cliSessionId !== 'CONTINUE') {
      return;
    }

    const baseTime = typeof dispatchTime === 'number' ? dispatchTime : tsNow() - 60_000;
    const timeThreshold = baseTime - 5000;

    // codebuddy / codebuddy-cn: 扫 ~/.codebuddy/projects/<home-dir>/ 取 mtime 晚于任务派发时刻的最新 .jsonl 文件名 (去 .jsonl)
    if (agent === 'codebuddy' || agent === 'codebuddy-cn') {
      const homeSlug = os.homedir().replace(/^\/+/, '').replace(/[/\\]+/g, '-');
      const dir = join(os.homedir(), '.codebuddy', 'projects', homeSlug);
      try {
        if (existsSync(dir)) {
          const files = await readdir(dir);
          let newest = null;
          let newestMtime = 0;
          let overallNewest = null;
          let overallNewestMtime = 0;
          for (const f of files) {
            if (!f.endsWith('.jsonl') || f.startsWith('.')) continue;
            try {
              const st = await stat(join(dir, f));
              const mt = st.mtimeMs;
              if (mt > overallNewestMtime) {
                overallNewestMtime = mt;
                overallNewest = f;
              }
              if (mt >= timeThreshold && mt > newestMtime) {
                newestMtime = mt;
                newest = f;
              }
            } catch {}
          }
          const target = newest || (overallNewestMtime >= baseTime - 600_000 ? overallNewest : null);
          if (target) {
            thread.cliSessionId = target.replace(/\.jsonl$/i, '');
            saveConv();
          }
        }
      } catch (e) {
        context.logger.warn('miniapp.session_backfill.codebuddy_error', { error: String(e && e.message) });
      }
      return;
    }

    // agy: 优先读 ~/.gemini/antigravity-cli/cache/last_conversations.json 取最新 id; 兜底扫 conversations/ 最新 .db 文件
    if (agent === 'antigravity') {
      try {
        const cachePath = join(os.homedir(), '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json');
        if (existsSync(cachePath)) {
          const raw = await readFile(cachePath, 'utf-8');
          const data = JSON.parse(raw);
          const sid = data[os.homedir()] || Object.values(data)[0];
          if (sid && typeof sid === 'string') {
            thread.cliSessionId = sid;
            saveConv();
            return;
          }
        }
      } catch (e) {
        context.logger.warn('miniapp.session_backfill.agy_cache_error', { error: String(e && e.message) });
      }
      try {
        const convDir = join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
        if (existsSync(convDir)) {
          const files = await readdir(convDir);
          let newest = null;
          let newestMtime = 0;
          for (const f of files) {
            if (!f.endsWith('.db') || f.endsWith('-wal') || f.endsWith('-shm')) continue;
            try {
              const st = await stat(join(convDir, f));
              if (st.mtimeMs >= timeThreshold && st.mtimeMs > newestMtime) {
                newestMtime = st.mtimeMs;
                newest = f;
              }
            } catch {}
          }
          if (newest) {
            thread.cliSessionId = newest.replace(/\.db$/i, '');
            saveConv();
          }
        }
      } catch {}
      return;
    }

    // mimo: 探查自 ~/.local/share/mimocode/storage/session_diff/ses_<id>.json 提取; 探不出降级为哨兵 'CONTINUE' (恒为 -c)
    if (agent === 'mimocode') {
      try {
        const diffDir = join(os.homedir(), '.local', 'share', 'mimocode', 'storage', 'session_diff');
        if (existsSync(diffDir)) {
          const files = await readdir(diffDir);
          let newest = null;
          let newestMtime = 0;
          let overallNewest = null;
          let overallNewestMtime = 0;
          for (const f of files) {
            if (!f.startsWith('ses_') || !f.endsWith('.json')) continue;
            try {
              const st = await stat(join(diffDir, f));
              const mt = st.mtimeMs;
              if (mt > overallNewestMtime) {
                overallNewestMtime = mt;
                overallNewest = f;
              }
              if (mt >= timeThreshold && mt > newestMtime) {
                newestMtime = mt;
                newest = f;
              }
            } catch {}
          }
          const target = newest || (overallNewestMtime >= baseTime - 600_000 ? overallNewest : null);
          if (target) {
            thread.cliSessionId = target.replace(/\.json$/i, '');
            saveConv();
            return;
          }
        }
      } catch (e) {
        context.logger.warn('miniapp.session_backfill.mimo_error', { error: String(e && e.message) });
      }
      thread.cliSessionId = 'CONTINUE';
      saveConv();
      return;
    }
  }

  /** 服务端统一入站: 完整文本落盘 + 线程里留摘要 */
  async function deliverAgentReply(thread, fullText, tag, ref) {
    if (!thread) return;
    const theRef = ref || extractDispatchRef(fullText);
    const msgs = Array.isArray(thread.messages) ? thread.messages : [];
    if (theRef && msgs.some((m) => m.ref === theRef)) return;
    if (theRef && deliveringRefs.has(theRef)) return;
    if (theRef) deliveringRefs.add(theRef);
    try {
      const body = extractResultBody(fullText);
      let artifact = null;
      if (body.length > 900) {
        artifact = await writeArtifact(thread.agent, tag || 'reply', body);
      }
      const preview = artifact
        ? `${body.slice(0, SUMMARY_CAP)}\n…（完整输出已落盘本机）`
        : body;
      addMsg(thread, 'agent', preview, { ...(artifact ? { artifact } : {}), ...(theRef ? { ref: theRef } : {}) });
    } finally {
      if (theRef) deliveringRefs.delete(theRef);
    }
  }

  const sendingSessions = new Set();
  async function chatSend(agentName, text, mode, model, attachments, sessionId, options = {}) {
    const thread = getThread(agentName, true, sessionId);
    agentName = thread.agent;
    // 并发保护: 同一 session 已有 pending 任务时不重复派发
    const activePend = (thread.pending || []).filter((p) => {
      if (p.kind !== 'ref' && p.kind !== 'task') return false;
      if (tsNow() - (p.firstSeen || p.posted || 0) > 30 * 60_000) return false;
      return true;
    });
    if (sendingSessions.has(thread.id) || activePend.length > 0) {
      const error = new Error('当前会话已有正在派发或执行的任务，请等待完成后再发送');
      error.status = 409;
      throw error;
    }
    sendingSessions.add(thread.id);
    try {
    const atts = (attachments || []).slice(0, 4);
    const direct = ['auto', 'dispatch', 'trae'].includes(mode) || (mode == null && agentName === 'traecode');
    if (!direct && (atts.length || options.thinking && options.thinking !== 'default' || options.stream === true)) {
      throw badReqSoft('附件、思考和流式选项需要使用自动派发或直通派发');
    }
    const taskOptions = {
      ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
      ...(options.stream !== undefined ? { stream: options.stream } : {}),
      ...(direct && atts.length ? { attachments: await portableAttachments(atts) } : {}),
    };
    // Capabilities are checked before recording a user message or dispatching.
    // Use MIME determined from the stored upload, never client isImage/content.
    const capabilityOptions = { ...options, ...taskOptions };
    const snap = direct ? await snapshot() : null;
    const pick = mode === 'auto' && snap?.ok ? pickAutoAgent(snap.agents, model, capabilityOptions, snap.capabilities) : null;
    if (direct) {
      if (mode === 'auto' && !pick) throw badReqSoft('没有满足所选模型、思考、流式和附件要求的可用 worker；任务尚未派发');
      await requireTaskCapability(pick?.name || agentName, model, capabilityOptions, snap?.capabilities);
    }
    const attMeta = atts.length ? atts.map((a) => ({ name: String(a.name || 'file').slice(0, 120), url: a.url, isImage: !!a.isImage })) : undefined;
    addMsg(thread, 'me', text, attMeta ? { att: attMeta } : undefined);
    if (mode === 'auto') {
      const full = text;
      addMsg(thread, 'sys', `⚡ 自动派发：${SELF_AGENT} 本机无 CLI，任务已转给 ${pick.name}（${pick.activation === 'online' ? '在线' : '待机·CLI 可直派'}${model ? ` · model=${model}` : ''}）。`);
      const ov = DISPATCH_OVERRIDES[pick.name];
      const workerExtra = buildWorkerExtraArgs(pick.name, options);
      const toolText = await hub.callTool(
        ov ? ov.tool : 'hub_dispatch_cli',
        ov
          ? { task: full, ...ov.asyncFlag, ...taskOptions, ...(model ? { model } : {}) }
          : {
              agent: pick.name,
              task: full,
              ...(model ? { model } : {}),
              ...(workerExtra.length ? { extra_args: workerExtra } : {}),
              ...taskOptions,
            },
        DISPATCH_TIMEOUT_MS
      );
      const ref = extractDispatchRef(toolText);
      if (ref) {
        thread.pending = (thread.pending || []).filter((p) => p.ref !== ref);
        thread.pending.push({ kind: 'ref', ref, tag: `auto-${pick.name}`, posted: tsNow(), dispatchTime: tsNow() });
        addMsg(thread, 'sys', `已受理（ref=${ref}），${pick.name} 完成后结果自动回到本对话。`);
      } else {
        await deliverAgentReply(thread, toolText, 'auto-sync');
      }
      return thread;
    }
    const fullText = direct ? text : mode === 'message' ? `${text}${atts.length ? `\n[附件: ${atts.map((a) => a.name).join('、')} · 已存本机控制台, 详见对话]` : ''}` : attBlock(text, atts);
    if (mode === 'trae' || (mode == null && agentName === 'traecode')) {
      const toolText = await hub.callTool('trae_delegate', { task: fullText, wait: false, ...taskOptions, ...(model ? { model } : {}), ...(thread.traeSession ? { session_id: thread.traeSession } : {}) }, DISPATCH_TIMEOUT_MS);
      const ref = extractDispatchRef(toolText);
      const sm = toolText.match(/session[_ ]?id[=":]+\s*([^\s",;]+)/i);
      if (sm) thread.traeSession = sm[1];
      if (ref) {
        thread.pending = (thread.pending || []).filter((p) => p.ref !== ref);
        thread.pending.push({ kind: 'ref', ref, tag: 'trae', posted: tsNow(), dispatchTime: tsNow() });
        addMsg(thread, 'sys', `已异步派发 Trae 会话（ref=${ref}），完成后结果自动回到本对话。`);
      } else {
        await deliverAgentReply(thread, toolText, 'trae-sync');
      }
    } else if (mode === 'dispatch') {
      const ov = DISPATCH_OVERRIDES[agentName];
      const sessionExtra = buildDispatchExtraArgs(agentName, thread) || [];
      const workerExtra = buildWorkerExtraArgs(agentName, options);
      const extraArgs = [...sessionExtra, ...workerExtra];
      const dispatchTime = tsNow();
      const toolText = await hub.callTool(
        ov ? ov.tool : 'hub_dispatch_cli',
        ov
          ? { task: fullText, ...ov.asyncFlag, ...taskOptions, ...(model ? { model } : {}) }
          : {
              agent: agentName,
              task: fullText,
              ...(model ? { model } : {}),
              ...(extraArgs.length ? { extra_args: extraArgs } : {}),
              ...taskOptions,
            },
        DISPATCH_TIMEOUT_MS
      );
      const ref = extractDispatchRef(toolText);
      if (ref) {
        thread.pending = (thread.pending || []).filter((p) => p.ref !== ref);
        thread.pending.push({ kind: 'ref', ref, tag: 'chat-dispatch', posted: dispatchTime, dispatchTime });
        const paramDesc = [
          model ? `模型 ${model}` : '',
          options?.thinking && options.thinking !== 'default' ? `思考 ${options.thinking}` : '',
          options?.stream ? '流式正文' : '',
        ].filter(Boolean).join(' · ');
        addMsg(thread, 'sys', `已${paramDesc ? `按【${paramDesc}】` : ''}直通派发（ref=${ref}），完成后自动回复到本对话。`);
      } else {
        await deliverAgentReply(thread, toolText, 'dispatch-sync');
        await backfillCliSessionId(thread, dispatchTime);
      }
    } else if (mode === 'task') {
      const title = text.split('\n')[0].slice(0, 100);
      const detail = `${model ? `[model: ${model}]\n` : ''}${fullText}`;
      const postText = await hub.callTool('hub_post_task', { from_agent: SELF_AGENT, title, detail, to_agent: agentName, priority: 'normal' });
      const tm = postText.match(/([a-z]{1,6}\.[A-Za-z0-9]{6,})/);
      thread.pending = (thread.pending || []).filter((p) => p.kind !== 'task');
      thread.pending.push({ kind: 'task', taskId: tm ? tm[1] : null, agent: agentName, posted: tsNow() });
      addMsg(thread, 'sys', `任务已指派${model ? `（偏好模型 ${model}，写入任务详情）` : ''}（${tm ? tm[1] : 'id 未解析'}）。对方认领执行后, hub_complete_task 的结果会自动送回本信箱并入线程。`);
    } else {
      const sendText = await hub.callTool('hub_send_message', { from_agent: SELF_AGENT, to_agent: agentName, text: fullText.slice(0, 4_000) });
      addMsg(thread, 'sys', `${sendText.trim()} 提示: 私信需要对方代理在线并轮询自己的信箱才能收到并回复。`);
    }
    return thread;
    } catch (err) {
      if (err.ref) {
        if (!thread.pending.some((p) => p.ref === err.ref)) thread.pending.push({ kind: 'ref', ref: err.ref, posted: tsNow(), tag: 'chat-recovery' });
        saveConv();
      }
      if (!err.status) {
        err.hubStatus ||= 'unknown';
        addMsg(thread, 'sys', err.hubStatus === 'unknown' ? '未能确认执行状态；任务可能已受理，请先检查枢纽或使用原 ref 查询，避免重复派发。' : `派发失败：${sanitizeHubError(err.message)}`);
      }
      throw err;
    } finally { sendingSessions.delete(thread.id); }
  }

  async function routeInboxMessage(msg) {
    // 任务完成/回复 → 匹配对应线程 (按发送者; 若文本含未决 taskId 也归位到相应 session)
    let thread;
    {
      for (const entry of conv.threads) {
        const found = (entry.sessions || []).find((s) => (s.pending || []).some((p) => p.taskId && msg.text.includes(p.taskId)));
        if (found) {
          thread = found;
          thread.agent = entry.agent;
          break;
        }
      }
    }
    if (!thread) thread = getThread(msg.from, false);
    if (!thread) {
      conv.captured.unshift({ ...msg, ts2: tsNow() });
      conv.captured = conv.captured.slice(0, 100);
      saveConv();
      broadcast({ type: 'inbox' });
      return false;
    }
    await deliverAgentReply(thread, msg.text, 'inbox');
    if (thread.pending?.length) {
      thread.pending = thread.pending.filter((p) => !(p.kind === 'task' && msg.text.includes(p.taskId || '__none__')));
      saveConv();
    }
    return true;
  }

  const pollingPending = new WeakSet();
  async function pollThreadPending() {
    for (const entry of conv.threads) {
      const sessions = Array.isArray(entry.sessions) ? entry.sessions : (entry.messages ? [entry] : []);
      for (const t of sessions) {
        t.agent = entry.agent || t.agent;
        const pend = (t.pending || []).filter((p) => p.kind === 'ref');
        for (const p of pend) {
          if (pollingPending.has(p)) continue;
          if (tsNow() - (p.firstSeen || p.posted) > 30 * 60_000) {
            t.pending = t.pending.filter((x) => x !== p);
            addMsg(t, 'sys', `ref ${p.ref} 超过 30 分钟未回, 已停止跟踪（可到「任务队列/异步任务」手动查询）。`);
            continue;
          }
          pollingPending.add(p);
          try {
            const text = await hub.callTool('hub_result', { ref: p.ref });
            const status = extractResultStatus(text);
            if (status === 'completed') {
              t.pending = t.pending.filter((x) => x !== p);
              if (t.agent === 'traecode' && !t.traeSession) {
                const sm = text.match(/session[_ ]?id[=":]+\s*([^\s",;]+)/i);
                if (sm) t.traeSession = sm[1];
              }
              await deliverAgentReply(t, text, p.tag || 'result', p.ref);
              await backfillCliSessionId(t, p.dispatchTime || p.posted);
            } else if (status === 'error' || status === 'failed' || status === 'timeout') {
              t.pending = t.pending.filter((x) => x !== p);
              addMsg(t, 'sys', `异步任务结束但状态为 ${status}: ${String(text).slice(0, 300)}`, { ref: p.ref });
            }
          } catch { /* 枢纽抖动, 下轮再试 */ }
          finally { pollingPending.delete(p); }
        }
      }
    }
  }

  // ---------------- SELF_AGENT 被调用时的自动派发: 认领指派给本控制台的 hub 任务 → 转派可用子代理 → 回传结果
  // 注意: 任务队列接口只回传标题(无 detail), 完整需求请写进任务标题; 标题里可用 [model: xxx] 指定期望模型。
  const autoSeenTasks = new Set();
  let lastAutoScan = 0;
  async function autoDispatchTick() {
    if (config.autoDispatch === false) return;
    if (tsNow() - lastAutoScan < 20_000) return;
    lastAutoScan = tsNow();
    const tasksText = await hub.callTool('hub_list_tasks', { status: 'open' });
    const mine = parseTasks(tasksText).items.filter((t) => t.to === SELF_AGENT && !autoSeenTasks.has(t.id));
    for (const t of mine.slice(0, 2)) {
      autoSeenTasks.add(t.id);
      void autoRunTask(t);
    }
    if (autoSeenTasks.size > 500) {
      for (const x of autoSeenTasks) { if (autoSeenTasks.size <= 300) break; autoSeenTasks.delete(x); }
    }
  }
  async function autoRunTask(t) {
    const selfThread = getThread(SELF_AGENT, true);
    let claim;
    try {
      claim = await hub.callTool('hub_claim_task', { task_id: t.id, agent: SELF_AGENT });
    } catch (err) {
      addMsg(selfThread, 'sys', `自动派发: 认领任务 ${t.id} 失败: ${String(err && err.message).slice(0, 120)}`);
      return;
    }
    if (/不属于|已被|无法|失败/.test(String(claim))) {
      addMsg(selfThread, 'sys', `自动派发: 任务 ${t.id} 未能认领（${String(claim).slice(0, 100)}）`);
      return;
    }
    addMsg(selfThread, 'sys', `📥 收到任务 ${t.id}「${t.title.slice(0, 60)}」— 自动转派子代理…`);
    const mm = String(t.title).match(/\[model[:：]\s*([\w.\-:/]{1,120})\]/);
    const model = mm ? mm[1] : undefined;
    const snap = await snapshot();
    const pick = snap.ok ? pickAutoAgent(snap.agents, model, {}, snap.capabilities) : null;
    if (!pick) {
      try { await hub.callTool('hub_complete_task', { task_id: t.id, agent: SELF_AGENT, success: false, result: `${SELF_AGENT}(自动派发): 没有可派发的子代理${model ? `（无人支持模型 ${model}）` : ''}` }); } catch { /* noop */ }
      addMsg(selfThread, 'sys', `自动派发: 无可用子代理${model ? `（需支持模型 ${model}）` : ''}, 任务 ${t.id} 已置失败`);
      return;
    }
    try {
      const r = await runSubagent(pick.name, t.title, { model });
      const resultText = `【${SELF_AGENT} 自动派发 · ${pick.name}${r.ref ? ` · ref=${r.ref}` : ''}】status=${r.status}\n${r.summary || ''}${r.artifactPath ? `\n(完整输出: ${r.artifactPath})` : ''}`;
      await hub.callTool('hub_complete_task', { task_id: t.id, agent: SELF_AGENT, success: r.status === 'completed', result: resultText.slice(0, 4_000) });
      addMsg(selfThread, 'sys', `✅ 任务 ${t.id} 已经 ${pick.name} 执行(${r.status}), 结果已回传发起方`);
    } catch (err) {
      const msg = sanitizeHubError(err && err.message);
      try { await hub.callTool('hub_complete_task', { task_id: t.id, agent: SELF_AGENT, success: false, result: `自动派发给 ${pick.name} 失败: ${msg.slice(0, 300)}` }); } catch { /* noop */ }
      addMsg(selfThread, 'sys', `❌ 任务 ${t.id} 派发失败: ${msg.slice(0, 200)}`);
    }
  }

  let watcherBusy = false;
  async function watcherTick() {
    if (disposing || watcherBusy) return;
    watcherBusy = true;
    try {
      const text = await hub.callTool('hub_read_messages', { agent: SELF_AGENT, mark_read: true });
      const msgs = parseInbox(SELF_AGENT, text);
      for (const m of msgs) await routeInboxMessage(m);
      if (msgs.length) saveConv();
    } catch { /* 枢纽不可达: 静默等下一轮 */ }
    try { await pollThreadPending(); } catch { /* noop */ }
    try { await autoDispatchTick(); } catch { /* 枢纽抖动, 下轮再试 */ }
    watcherBusy = false;
  }
  // 自适应节律: 有 SSE 客户端(有人在界面上)时 6s, 全空闲时放宽到 20s 降低资源占用
  let watcherTimer = null;
  let watcherFast = false;
  function tuneWatcher() {
    if (disposing) return;
    const fast = sseClients.size > 0 || conv.threads.some((t) => (t.sessions || []).some((s) => (s.pending || []).length > 0));
    if (fast === watcherFast && watcherTimer) return;
    watcherFast = fast;
    if (watcherTimer) clearInterval(watcherTimer);
    watcherTimer = setInterval(() => void watcherTick(), fast ? WATCHER_MS : 20_000);
    watcherTimer.unref?.();
  }
  tuneWatcher();
  const watcherKick = setInterval(() => tuneWatcher(), 10_000);
  watcherKick.unref?.();

  // ---------------- 外部派发任务同步: 周期扫描 ~/agent-hub/results/*.json 归组进各 agent 线程
  const RESULTS_DIR = join(os.homedir(), 'agent-hub', 'results');
  const seenRefsFile = join(dataDir, 'external-refs-seen.json');
  const seenExternalRefs = new Set();
  try {
    const rawSeen = await readFile(seenRefsFile, 'utf-8');
    const arr = JSON.parse(rawSeen);
    if (Array.isArray(arr)) {
      for (const r of arr) if (typeof r === 'string') seenExternalRefs.add(r);
    }
  } catch { /* 首次运行或文件不存在 */ }
  for (const t of conv.threads) {
    for (const s of (t.sessions || [])) {
      for (const m of (s.messages || [])) if (m.ref) seenExternalRefs.add(m.ref);
      for (const p of (s.pending || [])) if (p.ref) seenExternalRefs.add(p.ref);
    }
  }

  let sweepBusy = false;
  async function sweepResults() {
    if (sweepBusy) return;
    sweepBusy = true;
    try {
      if (!existsSync(RESULTS_DIR)) return;
      const files = await readdir(RESULTS_DIR);
      const newEntries = [];
      for (const f of files) {
        if (!f.endsWith('.json') || f.endsWith('-last.json')) continue;
        const ref = f.slice(0, -5);
        if (seenExternalRefs.has(ref) || deliveringRefs.has(ref)) continue;
        newEntries.push({ file: f, ref });
      }
      if (newEntries.length === 0) return;

      const items = [];
      for (const entry of newEntries) {
        try {
          const raw = await readFile(join(RESULTS_DIR, entry.file), 'utf-8');
          const data = JSON.parse(raw);
          if (!data || data.status === 'running' || data.status === 'pending') continue;
          items.push({ ...entry, data });
        } catch { /* 正在写入或异常 */ }
      }
      if (items.length === 0) return;

      items.sort((a, b) => (Number(a.data.updated_at) || 0) - (Number(b.data.updated_at) || 0));

      let imported = 0;
      for (const item of items) {
        const { ref, data } = item;
        const lastDash = ref.lastIndexOf('-');
        if (lastDash <= 0) {
          seenExternalRefs.add(ref);
          continue;
        }
        const hex = ref.slice(lastDash + 1);
        if (!/^[0-9a-fA-F]{6,}$/.test(hex)) {
          seenExternalRefs.add(ref);
          continue;
        }
        const prefix = ref.slice(0, lastDash);
        const targetAgent = prefix === 'trae' ? 'traecode' : (AGENT_ALIASES[prefix] || prefix);
        const thread = getThread(targetAgent, true);
        if (!thread) {
          seenExternalRefs.add(ref);
          continue;
        }
        if (Array.isArray(thread.messages) && thread.messages.some((m) => m.ref === ref)) {
          seenExternalRefs.add(ref);
          continue;
        }

        const taskText = extractTaskText(data) || '（外部派发任务）';
        let replyText = typeof data.text === 'string' ? data.text.trim() : '';
        if (!replyText) {
          if (data.status === 'error') replyText = '执行出错（无详细输出）';
          else if (data.status === 'timeout') replyText = '任务超时（worker 异常退出）';
          else replyText = '（任务已完成，无输出文本）';
        }

        const replyTs = typeof data.updated_at === 'number' ? Math.round(data.updated_at * 1000) : tsNow();
        const taskTs = Math.max(0, replyTs - 1000);

        addMsg(thread, 'me', taskText, { ts: taskTs });

        const body = extractResultBody(replyText);
        let artifact = null;
        if (body.length > 900) {
          artifact = await writeArtifact(thread.agent, 'external', body);
        }
        const preview = artifact
          ? `${body.slice(0, SUMMARY_CAP)}\n…（完整输出已落盘本机）`
          : body;
        addMsg(thread, 'agent', preview, { ...(artifact ? { artifact } : {}), ref, ts: replyTs });

        seenExternalRefs.add(ref);
        imported++;
      }

      if (imported > 0) {
        saveConv();
        try {
          await writeFile(seenRefsFile, JSON.stringify(Array.from(seenExternalRefs)), 'utf-8');
        } catch (err) {
          context.logger.warn('miniapp.sweep.save_seen_failed', { error: String(err && err.message).slice(0, 120) });
        }
      }
    } catch (err) {
      context.logger.warn('miniapp.sweep.failed', { error: String(err && err.message).slice(0, 120) });
    } finally {
      sweepBusy = false;
    }
  }

  void sweepResults();
  const resultsSweepTimer = setInterval(() => void sweepResults(), 30_000);
  resultsSweepTimer.unref?.();

  // ---------------- 子代理直通服务: 固定端口 + MCP(JSON-RPC) 面, 供本机会话/其它代理调用
  let subPort = null;
  const subInflight = new Map(); // key -> Promise (合并同一 agent+task 的并发 run)

  function subagentInfo() {
    return { port: subPort, url: subPort ? `http://127.0.0.1:${subPort}` : null, mcp: subPort ? `http://127.0.0.1:${subPort}/mcp` : null, version: VERSION };
  }

  async function dispatchAsync(agentName, task, model, opts = {}) {
    const taskOptions = {
      ...(model ? { model } : {}),
      ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
      ...(opts.stream !== undefined ? { stream: opts.stream } : {}),
      ...(opts.attachments !== undefined ? { attachments: opts.attachments } : {}),
      ...(Number(opts.timeout_s) > 0 ? { timeout_s: Number(opts.timeout_s) } : {}),
    };
    const ov = DISPATCH_OVERRIDES[agentName];
    if (ov) {
      const text = await hub.callTool(ov.tool, { task, ...ov.asyncFlag, ...taskOptions }, DISPATCH_TIMEOUT_MS);
      return { text, ref: extractDispatchRef(text) };
    }
    const workerExtra = buildWorkerExtraArgs(agentName, opts);
    const extraArgs = [
      ...(Array.isArray(opts.extra_args) ? opts.extra_args : []),
      ...workerExtra,
    ];
    const text = await hub.callTool(
      'hub_dispatch_cli',
      {
        agent: agentName,
        task,
        ...(extraArgs.length ? { extra_args: extraArgs } : {}),
        ...taskOptions,
      },
      DISPATCH_TIMEOUT_MS
    );
    return { text, ref: extractDispatchRef(text) };
  }

  /** 一次性子代理调用: 服务端派发+轮询, 完整输出落盘, 只回摘要 */
  async function runSubagent(agentName, task, opts = {}) {
    agentName = canonicalAgent(agentName);
    // auto 入口: SELF_AGENT(本控制台, 无 CLI)被调用 → 自动挑选最优可派发子代理转派
    if (agentName === 'auto' || agentName === SELF_AGENT) {
      const snap = await snapshot();
      const pick = snap.ok ? pickAutoAgent(snap.agents, opts.model, opts, snap.capabilities) : null;
      if (!pick) {
        return { status: 'failed', ref: null, summary: 'auto: 没有满足模型、思考、流式和附件要求的可用 worker，任务尚未派发', artifactPath: null, elapsedMs: 0, note: 'auto 能力预检失败' };
      }
      return runSubagent(pick.name, task, { ...opts, viaAuto: true });
    }
    const timeoutMs = Math.min(Math.max(Number(opts.timeout_s) || 240, 20), 1_800) * 1000;
    await requireTaskCapability(agentName, opts.model, opts);
    const key = JSON.stringify([agentName, task, opts.model, opts.thinking, opts.stream, opts.attachments, timeoutMs]);
    if (subInflight.has(key)) return subInflight.get(key);
    const p = (async () => {
      recordRun(agentName, true);
      const thread = getThread(agentName, true);
      const paramTag = [
        opts.model ? `model=${opts.model}` : '',
        opts.thinking ? `thinking=${opts.thinking}` : '',
        opts.stream ? 'stream=true' : '',
      ].filter(Boolean).join(' ');
      addMsg(thread, 'sys', `⚡ 本机会话经子代理直通派发: ${task.slice(0, 120)}${task.length > 120 ? '…' : ''}${paramTag ? ` (${paramTag})` : ''}`);
      const { text, ref } = await dispatchAsync(agentName, task, opts.model, opts);
      if (!ref) {
        const path = await writeArtifact(agentName, 'run-sync', text);
        await deliverAgentReply(thread, text, 'run-sync');
        await backfillCliSessionId(thread, tsNow());
        return {
          status: 'completed',
          ref: null,
          summary: String(text).slice(0, SUMMARY_CAP),
          artifactPath: path,
          elapsedMs: 0,
          note: '同步返回（未走异步 ref）',
        };
      }
      thread.pending = (thread.pending || []).filter((x) => x.ref !== ref);
      thread.pending.push({ kind: 'ref', ref, tag: 'run', posted: tsNow() });
      saveConv();
      const deadline = tsNow() + timeoutMs;
      let lastText = '';
      let status = 'pending';
      while (!disposing && tsNow() < deadline) {
        await new Promise((r) => setTimeout(r, REF_POLL_MS));
        if (disposing) break;
        try {
          const r = await hub.callTool('hub_result', { ref });
          status = extractResultStatus(r);
          lastText = r;
          if (status === 'completed' || status === 'error' || status === 'failed' || status === 'timeout') break;
        } catch { /* 抖动继续 */ }
      }
      let artifactPath = null;
      let summary = '';
      if (status === 'completed') {
        thread.pending = (thread.pending || []).filter((x) => x.ref !== ref);
        const body = extractResultBody(lastText);
        artifactPath = body.length > SUMMARY_CAP ? await writeArtifact(agentName, `run-${ref.replace(/[^\w-]/g, '_').slice(-24)}`, body) : null;
        summary = (artifactPath ? `${body.slice(0, SUMMARY_CAP)}\n…(完整输出见 artifactPath)` : body);
        await deliverAgentReply(thread, lastText, 'run', ref);
        await backfillCliSessionId(thread, deadline - timeoutMs);
      } else if (['failed', 'error', 'timeout'].includes(status)) {
        thread.pending = (thread.pending || []).filter((x) => x.ref !== ref);
        summary = extractResultBody(lastText);
        addMsg(thread, 'sys', `异步任务结束但状态为 ${status}: ${summary.slice(0, 300)}`, { ref });
        saveConv();
      } else {
        summary = `任务仍在执行或超时 (status=${status})。ref=${ref} 可稍后用 subagent_result 查询, 完成后会自动回到控制台「对话」线程。`;
        if (!thread.pending.some((x) => x.ref === ref)) {
          thread.pending.push({ kind: 'ref', ref, tag: 'run', posted: tsNow() });
        }
      }
      return { status, ref, summary, artifactPath, elapsedMs: Date.now() - (deadline - timeoutMs) };
    })().finally(() => subInflight.delete(key));
    subInflight.set(key, p);
    return p;
  }

  async function mcpToolsList() {
    return {
      tools: [
        {
          name: 'subagent_run',
          description: `把一个任务派给 multi-agent-hub 上的子代理(trae/zcode/workbuddy/codebuddy 等)并等待完成。agent 也可传 auto 或 ${SELF_AGENT}: 自动挑选最优可派发子代理(在线优先, 可用 model 参数约束必须支持的模型)。全量结果落盘本机文件, 对话里只返回 ≤500 字摘要 + artifactPath, 最大幅度节省本机会话 tokens。需控制台运行时打开中。`,
          inputSchema: {
            type: 'object',
            properties: {
              agent: { type: 'string', description: `子代理名, 见 subagent_agents; 或 auto/${SELF_AGENT} = 自动选路` },
              task: { type: 'string', description: '完整任务描述/提示词' },
              model: { type: 'string', description: '可选: 模型别名' },
              timeout_s: { type: 'number', description: '等待上限秒数 20-1800, 默认 240' },
              thinking: { type: 'string', enum: ['default', 'on', 'off'], description: '仅允许该平台/worker/模型已验证的思考开关' },
              stream: { type: 'boolean', description: '请求已验证的正文进度，非隐藏思考' },
            },
            required: ['agent', 'task'],
          },
        },
        {
          name: 'subagent_result',
          description: '按 ref 查询异步子代理任务状态/结果; completed 时同样返回摘要+落盘路径。',
          inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
        },
        {
          name: 'subagent_artifact',
          description: '读取本机 artifact 文件完整内容 (仅允许控制台 artifacts 目录内路径; 超长会截断并提示)。',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
        {
          name: 'subagent_agents',
          description: '列出枢纽注册子代理: name/online/cli/可用模型别名, 紧凑 JSON。',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    };
  }

  async function mcpCallTool(name, args) {
    args = args || {};
    if (name === 'subagent_run') {
      const agent = String(args.agent || '').trim();
      const task = String(args.task || '').trim();
      if (!/^[\w.\-]{1,64}$/.test(agent)) throw new Error('agent 无效');
      // agent=auto 或 SELF_AGENT → runSubagent 内部自动选路转派
      if (!task || task.length > 20_000) throw new Error('task 需要 1-20000 字符');
      const r = await runSubagent(agent, task, args);
      return JSON.stringify(r, null, 0);
    }
    if (name === 'subagent_result') {
      const ref = String(args.ref || '').trim();
      if (!/^[\w.\-:/]{1,120}$/.test(ref)) throw new Error('ref 无效');
      const text = await hub.callTool('hub_result', { ref });
      const status = extractResultStatus(text);
      let artifactPath = null;
      let summary = '';
      if (status === 'completed') {
        const body = extractResultBody(text);
        artifactPath = body.length > SUMMARY_CAP ? await writeArtifact('hub', `result-${ref.replace(/[^\w-]/g, '_').slice(-24)}`, body) : null;
        summary = artifactPath ? `${body.slice(0, SUMMARY_CAP)}\n…(完整输出见 artifactPath)` : body;
      } else summary = String(text).slice(0, 800);
      return JSON.stringify({ status, ref, summary, artifactPath });
    }
    if (name === 'subagent_artifact') {
      const rp = resolve(String(args.path || ''));
      const root = resolve(artifactDir);
      if (!rp.startsWith(root + sep)) throw new Error('path 必须位于控制台 artifacts 目录内');
      const text = await readFile(rp, 'utf-8');
      return text.length > 20_000 ? text.slice(0, 20_000) + `\n…(截断, 共 ${text.length} 字符, 请本机直接打开文件)` : text;
    }
    if (name === 'subagent_agents') {
      const text = await hub.callTool('hub_list_agents', {});
      const agents = parseAgents(text).map((a) => ({ name: a.name, online: a.online, cli: a.cli, role: a.role }));
      return JSON.stringify({ agents, self: SELF_AGENT });
    }
    throw new Error(`未知工具 ${name}`);
  }

  /** 极简无状态 MCP (JSON-RPC over HTTP), 与枢纽同风格, 支持 streamable-http 客户端 */
  async function handleMcp(request, response, body) {
    let msg;
    try { msg = JSON.parse(body || '{}'); } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
      return;
    }
    const sess = request.headers['mcp-session-id'];
    const wantSse = String(request.headers.accept || '').includes('text/event-stream');
    const send = (obj) => {
      const headers = { 'content-type': wantSse ? 'text/event-stream' : 'application/json; charset=utf-8', 'cache-control': 'no-store' };
      if (sess) headers['mcp-session-id'] = sess;
      const payload = wantSse ? `event: message\ndata: ${JSON.stringify(obj)}\n\n` : JSON.stringify(obj);
      response.writeHead(200, headers);
      response.end(payload);
    };
    const replies = [];
    const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    const errorReply = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (Array.isArray(msg) && !msg.length) {
      send(errorReply(null, -32600, 'invalid request'));
      return;
    }
    for (const one of (Array.isArray(msg) ? msg : [msg])) {
      const hasId = object(one) && Object.hasOwn(one, 'id');
      const validId = hasId && (one.id === null || typeof one.id === 'string' || (typeof one.id === 'number' && Number.isFinite(one.id)));
      const id = validId ? one.id : null;
      if (!object(one) || one.jsonrpc !== '2.0' || typeof one.method !== 'string' || !one.method || (hasId && !validId)) {
        replies.push(errorReply(null, -32600, 'invalid request'));
        continue;
      }
      if (Object.hasOwn(one, 'params') && !object(one.params)) {
        replies.push(errorReply(id, -32602, 'params must be an object'));
        continue;
      }
      // MCP 工具调用必须有请求 ID；通知不启动任何工作，也没有 JSON-RPC 回应。
      if (!hasId) continue;
      if (one.method === 'tools/call' && (typeof one.params?.name !== 'string' || !one.params.name ||
          (Object.hasOwn(one.params, 'arguments') && !object(one.params.arguments)))) {
        replies.push(errorReply(id, -32602, 'invalid tool parameters'));
        continue;
      }
      try {
        let result;
        switch (one && one.method) {
          case 'initialize':
            result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agent-hub-subagent', version: VERSION } };
            break;
          case 'ping':
            result = { ok: true };
            break;
          case 'tools/list':
            result = await mcpToolsList();
            break;
          case 'tools/call': {
            const t0 = Date.now();
            const text = await mcpCallTool(one.params?.name, one.params?.arguments);
            result = { content: [{ type: 'text', text }], isError: false, meta: { durationMs: Date.now() - t0 } };
            break;
          }
          default:
            replies.push({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
            continue;
        }
        replies.push({ jsonrpc: '2.0', id, result });
      } catch (err) {
        replies.push({ jsonrpc: '2.0', id, error: { code: -32000, message: sanitizeHubError(err && err.message) } });
      }
    }
    if (!replies.length) {
      response.writeHead(202, { 'content-length': '0' });
      response.end();
      return;
    }
    const out = Array.isArray(msg) ? replies : replies[0];
    send(out);
  }

  function readBody(request, limit = MAX_BODY) {
    return new Promise((res, rej) => {
      const chunks = [];
      let size = 0;
      request.on('data', (c) => {
        size += c.length;
        if (size > limit) { rej(new Error('请求体过大')); request.destroy(); return; }
        chunks.push(c);
      });
      request.on('end', () => res(Buffer.concat(chunks).toString('utf-8')));
      request.on('error', rej);
    });
  }

  const subServer = http.createServer((request, response) => {
    const done = (status, obj) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      response.end(JSON.stringify(obj));
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,mcp-session-id,accept' });
      response.end();
      return;
    }
    const u = new URL(request.url || '/', 'http://subagent.local');
    const route = async () => {
      if (request.method === 'GET' && u.pathname === '/health') {
        done(200, { ok: true, version: VERSION, subagent: subagentInfo(), endpoint: getEndpoint().label, threads: conv.threads.length });
        return;
      }
      if (request.method === 'POST' && u.pathname === '/run') {
        const b = JSON.parse((await readBody(request)) || '{}');
        const agent = String(b.agent || '').trim().slice(0, 64);
        const task = String(b.task || '').trim();
        if (!agent || !task || task.length > 20_000) { done(400, { error: '需要 agent 与 task(≤20000字)' }); return; }
        const r = await runSubagent(agent, task, b);
        done(200, r);
        return;
      }
      if (request.method === 'POST' && u.pathname === '/threads') {
        done(200, {
          threads: conv.threads.map((entry) => {
            const sessions = Array.isArray(entry.sessions) ? entry.sessions : [];
            const active = sessions.find((s) => s.id === entry.activeSessionId) || sessions[0] || entry;
            const msgs = Array.isArray(active.messages) ? active.messages : (Array.isArray(entry.messages) ? entry.messages : []);
            return {
              agent: entry.agent,
              updated: active.updated || entry.updated,
              messages: msgs.slice(-30),
              pending: (active.pending || entry.pending || []).length,
              sessions: sessions.length || 1,
            };
          }),
        });
        return;
      }
      if (request.method === 'POST' && u.pathname === '/mcp') {
        await handleMcp(request, response, await readBody(request));
        return;
      }
      done(404, { error: 'not_found', hint: 'GET /health · POST /run · POST /mcp' });
    };
    route().catch((err) => {
      if (!response.headersSent) done(err.status || 500, { error: sanitizeHubError(err && err.message) });
    });
  });

  async function bindSubServer() {
    for (const port of SUBAGENT_PORTS) {
      try {
        await new Promise((res, rej) => {
          const onErr = (e) => rej(e);
          subServer.once('error', onErr);
          subServer.listen(port, SUB_BIND_HOST, () => { subServer.off('error', onErr); res(); });
        });
        subPort = port;
        try { await writeFile(endpointFile, JSON.stringify({ port, url: `http://${ADVERTISE_HOST}:${port}`, mcp: `http://${ADVERTISE_HOST}:${port}/mcp`, version: VERSION, pid: process.pid, ts: tsNow() }, null, 2), 'utf-8'); } catch { /* noop */ }
        context.logger.info('miniapp.subagent.listening', { port, advertise: ADVERTISE_HOST });
        // 把端点写进共享笔记, 让 hub 上其它代理也能发现子代理直通
        try { await hub.callTool('hub_note_set', { key: 'subagent-endpoint', value: `http://${ADVERTISE_HOST}:${port} (mcp: /mcp, 摘要+本机产物路径, v${VERSION})`, agent: SELF_AGENT }); } catch { /* 枢纽离线时跳过 */ }
        return;
      } catch (e) {
        context.logger.debug('miniapp.subagent.port_busy', { port, error: String(e && e.message).slice(0, 80) });
      }
    }
    context.logger.warn('miniapp.subagent.bind_failed', { ports: SUBAGENT_PORTS.join(',') });
  }
  await bindSubServer();

  // ---------------- 控制台路由 (原 /dashboard 与 /api/*)

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://agent-hub-console.local');
    const p = url.pathname;
    const send = (status, obj) => {
      const body = JSON.stringify(obj);
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(body);
    };
    const readJson = () => readBody(request).then((raw) => {
      if (!raw) return {};
      try {
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw badReq('请求体须为 JSON 对象');
        return value;
      } catch (err) { throw badReq(err.status ? err.message : '请求体不是合法 JSON'); }
    });
    const str = (v, max, name) => {
      if (typeof v !== 'string' || !v.trim()) throw badReq(`${name} 不能为空`);
      if (v.length > max) throw badReq(`${name} 超过 ${max} 字符`);
      return v;
    };
    const badReq = (msg) => { const e = new Error(msg); /** @ts-ignore */ e.status = 400; return e; };
    const nameRe = /^[\w.\-]{1,64}$/;
    const safeName = (v, name) => { const s = str(v, 64, name); if (!nameRe.test(s)) throw badReq(`${name} 含非法字符`); return s; };

    const route = async () => {
      if (request.method === 'GET' && (p === '/dashboard' || p === '/')) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(clientEntry);
        return;
      }
      if (request.method === 'GET' && p === '/api/events') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        response.write(`data: ${JSON.stringify({ type: 'hello', version: VERSION })}\n\n`);
        sseClients.add(response);
        tuneWatcher();
        void watcherTick();
        const ka = setInterval(() => { try { response.write(': ka\n\n'); } catch { /* closed */ } }, 25_000);
        request.on('close', () => { clearInterval(ka); sseClients.delete(response); tuneWatcher(); });
        return;
      }
      if (request.method === 'GET' && p === '/api/snapshot') {
        send(200, await snapshot());
        return;
      }
      if (request.method === 'GET' && p === '/api/chat/list') {
        // 摘要化: 返回每 agent 活跃会话预览 + sessions 数量, 详情走 /api/chat/thread
        send(200, {
          threads: conv.threads.map((entry) => {
            const sessions = Array.isArray(entry.sessions) ? entry.sessions : [];
            const active = sessions.find((s) => s.id === entry.activeSessionId) || sessions[0] || entry;
            const messages = Array.isArray(active.messages) ? active.messages : (Array.isArray(entry.messages) ? entry.messages : []);
            const last = messages.length ? messages[messages.length - 1] : null;
            const totalUnread = sessions.reduce((acc, s) => acc + (s.unread || 0), 0);
            return {
              id: active.id || entry.id,
              agent: entry.agent,
              activeSessionId: entry.activeSessionId || active.id,
              sessionCount: sessions.length || 1,
              sessions: sessions.map((s) => ({
                id: s.id,
                title: s.title || '会话',
                created: s.created,
                updated: s.updated,
                unread: s.unread || 0,
                msgCount: (s.messages || []).length,
                cliSessionId: s.cliSessionId || null,
              })),
              updated: active.updated || entry.updated,
              unread: active.unread !== undefined ? active.unread : totalUnread,
              totalUnread,
              pending: (active.pending || []).length,
              msgCount: messages.length,
              traeSession: !!active.traeSession,
              cliSessionId: active.cliSessionId || null,
              last: last ? { role: last.role, text: String(last.text).slice(0, 80), ts: last.ts } : null,
            };
          }),
          captured: conv.captured.length,
        });
        return;
      }
      if (request.method === 'GET' && p === '/api/chat/thread') {
        const agent = safeName(url.searchParams.get('agent'), 'agent');
        const sessionId = url.searchParams.get('session');
        const entry = getAgentEntry(agent, false);
        const t = getThread(agent, false, sessionId);
        if (sessionId && entry && t && entry.activeSessionId !== sessionId) {
          entry.activeSessionId = sessionId;
          saveConv();
        }
        const sessions = entry ? (entry.sessions || []).map((s) => ({
          id: s.id,
          title: s.title || '会话',
          created: s.created,
          updated: s.updated,
          unread: s.unread || 0,
          msgCount: (s.messages || []).length,
          cliSessionId: s.cliSessionId || null,
        })) : [];
        send(200, {
          thread: t || null,
          sessions,
          activeSessionId: entry?.activeSessionId || t?.id || null,
        });
        return;
      }
      if (request.method === 'GET' && p === '/api/chat/sessions') {
        const agent = safeName(url.searchParams.get('agent'), 'agent');
        const entry = getAgentEntry(agent, false);
        const sessions = entry ? (entry.sessions || []).map((s) => ({
          id: s.id,
          title: s.title || '会话',
          created: s.created,
          updated: s.updated,
          unread: s.unread || 0,
          msgCount: (s.messages || []).length,
          cliSessionId: s.cliSessionId || null,
        })) : [];
        send(200, {
          agent,
          activeSessionId: entry?.activeSessionId || null,
          sessions,
        });
        return;
      }
      if (request.method === 'GET' && p === '/api/chat/updates') {
        const since = Number(url.searchParams.get('since')) || 0;
        const changed = [];
        for (const entry of conv.threads) {
          const sessions = Array.isArray(entry.sessions) ? entry.sessions : [];
          const active = sessions.find((s) => s.id === entry.activeSessionId) || sessions[0] || entry;
          const latestUpdated = Math.max(entry.updated || 0, ...(sessions.map((s) => s.updated || 0)));
          if (latestUpdated > since) {
            changed.push({
              id: active.id || entry.id,
              agent: entry.agent,
              activeSessionId: entry.activeSessionId || active.id,
              sessionCount: sessions.length || 1,
              updated: latestUpdated,
              unread: active.unread || 0,
              pending: (active.pending || []).length,
              msgCount: (active.messages || []).length,
            });
          }
        }
        send(200, { now: tsNow(), changed });
        return;
      }
      if (request.method === 'GET' && p === '/api/usage') {
        const day = new Date().toISOString().slice(0, 10);
        send(200, { estNote: 'tokens 为启发式估算(CJK≈1/字, 其他≈1/4字); 枢纽不提供真实计量', today: usage.days[day] || null, total: usage.total, agents: usage.agents, days: Object.keys(usage.days).sort().slice(-14).map((k) => ({ day: k, in: usage.days[k].in, out: usage.days[k].out, msgs: usage.days[k].msgs, runs: usage.days[k].runs })) });
        return;
      }
      if (request.method === 'GET' && p === '/api/quotas') {
        const data = await getQuotas();
        send(200, data);
        return;
      }
      if (request.method === 'GET' && p === '/api/avatars') {
        send(200, await loadAvatars());
        return;
      }
      if (request.method === 'GET' && p === '/api/artifact') {
        const rp = resolve(url.searchParams.get('path') || '');
        const roots = [resolve(artifactDir), RESULTS_DIR].map((r) => resolve(r));
        if (!roots.some((root) => rp.startsWith(root + sep))) throw badReq('仅允许读取控制台产物或枢纽 results 产物: ' + rp);
        const text = await readFile(rp, 'utf-8');
        send(200, { text: text.slice(0, 120_000), truncated: text.length > 120_000 });
        return;
      }
      // 聊天附件静态回读: /uploads/<file>（文件均由 /api/upload 以 [A-Za-z0-9+/=-] 字符集落盘）
      if (request.method === 'GET' && p.startsWith('/uploads/')) {
        let fname = p.slice('/uploads/'.length);
        try { fname = decodeURIComponent(fname); } catch { /* 保留原样 */ }
        if (!/^[\w.\-\u4e00-\u9fa5]{1,240}$/.test(fname) || fname.includes('..')) throw badReq('非法附件名');
        try {
          const buf = await readFile(join(uploadsDir, fname));
          const ext = (fname.split('.').pop() || '').toLowerCase();
          const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8' }[ext] || 'application/octet-stream';
          response.writeHead(200, { 'content-type': mime, 'content-length': buf.length, 'cache-control': 'private, max-age=3600' });
          response.end(buf);
        } catch {
          response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('not found');
        }
        return;
      }

      // 图片/文件上传（base64）：单独走大 body 限制，必须先于通用 /api/ JSON 处理
      if (request.method === 'POST' && p === '/api/upload') {
        const raw = await readBody(request, UPLOAD_MAX_BODY);
        let b;
        try { b = JSON.parse(raw || '{}'); } catch { throw badReq('body 须为 JSON'); }
        const saved = await saveUpload(b.name, b.base64 || b.dataBase64);
        send(200, { ok: true, name: saved.name, url: saved.url, path: saved.path, size: saved.size, isImage: saved.isImage, content: saved.content });
        return;
      }

      if (request.method === 'POST' && p.startsWith('/api/')) {
        const body = await readJson();
        if (p === '/api/endpoint') {
          const id = String(body.id || '');
          if (!id || id === 'local' || !config.endpoints.some((e) => e.id === id)) throw badReq('未知或已移除端点');
          config.activeId = id;
          await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
          broadcast({ type: 'changed', label: 'endpoint' });
          send(200, { ok: true });
          return;
        }
        if (p === '/api/heartbeat-check') {
          const t0 = Date.now();
          const raw = await hub.callTool('hub_list_agents', {});
          const latencyMs = Date.now() - t0;
          const agents = parseAgents(raw);
          const online = agents.filter((a) => a.online).map((a) => a.name);
          const offline = agents.filter((a) => !a.online).map((a) => a.name);
          const fmtList = (arr) => {
            if (!arr.length) return '无';
            if (arr.length <= 3) return arr.join(', ');
            return `${arr.slice(0, 3).join(', ')} 等 ${arr.length} 个`;
          };
          const text = `枢纽在线 · ${latencyMs}ms · 在线: ${fmtList(online)} · 离线: ${fmtList(offline)}`;
          send(200, { ok: true, latencyMs, online, offline, text });
          return;
        }
        if (p === '/api/dispatch') {
          const agent = canonicalAgent(safeName(body.agent, 'agent'));
          const task = str(body.task, 20_000, 'task');
          const model = typeof body.model === 'string' && body.model.trim() && !['默认', 'default'].includes(body.model.trim()) ? body.model.trim().slice(0, 120) : undefined;
          const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim().slice(0, 500) : undefined;
          const to = Number(body.timeout_s) > 0 ? Math.min(Number(body.timeout_s), 600) : undefined;
          const portable = await portableAttachments(uploadAttachments(body.attachments));
          const options = { ...body, attachments: portable };
          await requireTaskCapability(agent, model, options);
          const taskOptions = { thinking: body.thinking || 'default', stream: body.stream === true,
            ...(portable.length ? { attachments: portable } : {}), ...(model ? { model } : {}), ...(to ? { timeout_s: to } : {}) };
          const ov = DISPATCH_OVERRIDES[agent];
          const text = await mutate('dispatch', () => (ov
            ? hub.callTool(ov.tool, { task, ...ov.asyncFlag, ...taskOptions }, DISPATCH_TIMEOUT_MS)
            : hub.callTool('hub_dispatch_cli', { agent, task, ...taskOptions, ...(cwd ? { cwd } : {}) }, DISPATCH_TIMEOUT_MS)));
          const ref = extractDispatchRef(text);
          if (ref) {
            const thread = getThread(agent, true);
            thread.pending = (thread.pending || []).filter((x) => x.ref !== ref);
            thread.pending.push({ kind: 'ref', ref, tag: 'dispatch' });
            addMsg(thread, 'sys', `🛫 控制台派活已受理 (ref=${ref})，结果回来后自动进入「对话」线程。`);
          }
          send(200, { text, ref });
          return;
        }
        if (p === '/api/capabilities/refresh') {
          const agent = canonicalAgent(safeName(body.agent, 'agent'));
          const document = await readCapabilities();
          const worker = document.workers[agent];
          const model = typeof body.model === 'string' ? body.model : worker?.default_model;
          const selected = worker?.models.find((entry) => entry.id === model || entry.aliases.includes(model));
          if (!selected?.availability.refreshable) throw badReq('该状态不能通过清除近期失败提示恢复，请检查本机配置或供应商支持');
          await hub.callTool('hub_capabilities', { agent, model: selected.id, refresh: true });
          send(200, { ok: true, note: '已清除该模型的近期失败提示；此操作不验证登录或调用模型' });
          return;
        }
        if (p === '/api/result') {
          const ref = safeName(body.ref, 'ref');
          const text = await hub.callTool('hub_result', { ref });
          send(200, { text, status: extractResultStatus(text) });
          return;
        }
        if (p === '/api/chat/new-session') {
          const agent = safeName(body.agent, 'agent');
          const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 60) : '新对话';
          const newSess = createSession(agent, title);
          const entry = getAgentEntry(agent, false);
          const sessions = entry ? (entry.sessions || []).map((s) => ({
            id: s.id,
            title: s.title || '会话',
            created: s.created,
            updated: s.updated,
            unread: s.unread || 0,
            msgCount: (s.messages || []).length,
            cliSessionId: s.cliSessionId || null,
          })) : [];
          send(200, {
            ok: true,
            thread: newSess,
            activeSessionId: newSess.id,
            sessions,
          });
          return;
        }
        if (p === '/api/chat/switch-session') {
          const agent = safeName(body.agent, 'agent');
          const sessionId = safeName(body.sessionId, 'sessionId');
          const entry = getAgentEntry(agent, false);
          if (!entry) throw badReq('平台不存在');
          const target = (entry.sessions || []).find((s) => s.id === sessionId);
          if (!target) throw badReq('会话不存在');
          entry.activeSessionId = sessionId;
          saveConv();
          target.agent = agent;
          const sessions = (entry.sessions || []).map((s) => ({
            id: s.id,
            title: s.title || '会话',
            created: s.created,
            updated: s.updated,
            unread: s.unread || 0,
            msgCount: (s.messages || []).length,
            cliSessionId: s.cliSessionId || null,
          }));
          send(200, {
            ok: true,
            thread: target,
            activeSessionId: sessionId,
            sessions,
          });
          return;
        }
        if (p === '/api/chat/send') {
          const agent = safeName(body.agent, 'agent');
          const modeKnown = ['message', 'task', 'trae', 'dispatch', 'auto'].includes(body.mode);
          if (body.mode !== undefined && body.mode !== '' && !modeKnown) throw badReq('未知发送模式');
          if (agent === SELF_AGENT && body.mode !== 'auto') throw badReq('不能和自己开线程');
          const text = str(body.text, 20_000, 'text');
          const mode = modeKnown ? body.mode : (agent === 'traecode' ? 'trae' : 'message');
          const model = typeof body.model === 'string' && body.model.trim() && !['默认', 'default'].includes(body.model.trim()) ? (() => { const s = body.model.trim().slice(0, 120); if (!/^[\w.\-:\/一-龥]{1,120}$/.test(s)) throw badReq('model 含非法字符'); return s; })() : undefined;
          const sessionId = body.sessionId || body.session;
          const effort = typeof body.effort === 'string' && body.effort.trim() ? body.effort.trim().slice(0, 32) : undefined;
          const contextTier = typeof body.contextTier === 'string' && body.contextTier.trim() ? body.contextTier.trim().slice(0, 32) : undefined;
          const autoTier = typeof body.autoTier === 'string' && body.autoTier.trim() ? body.autoTier.trim().slice(0, 32) : undefined;
          if (body.thinking !== undefined && !['default', 'on', 'off'].includes(body.thinking)) throw badReq('thinking 无效');
          if (body.stream !== undefined && typeof body.stream !== 'boolean') throw badReq('stream 必须是布尔值');
          // 附件：客户端先经 /api/upload 落盘，这里只认 url 白名单与元数据
          const attachments = uploadAttachments(body.attachments);
          try {
            const thread = await chatSend(agent, text, mode, model, attachments, sessionId, { effort, contextTier, autoTier, thinking: body.thinking, stream: body.stream });
            send(200, { thread: { id: thread.id, agent: thread.agent } });
          } catch (err) {
            const e = new Error(sanitizeHubError(err && err.message));
            // @ts-ignore
            e.status = err.status || 502;
            e.hubStatus = err.hubStatus;
            e.ref = err.ref;
            throw e;
          }
          return;
        }
        if (p === '/api/chat/clear') {
          const agent = safeName(body.agent, 'agent');
          const sessionId = body.sessionId || body.session;
          const thread = getThread(agent, false, sessionId);
          if (thread) {
            thread.messages = [];
            thread.unread = 0;
            saveConv();
            broadcast({ type: 'chat', threadId: thread.id, agent, role: 'clear' });
          }
          send(200, { ok: true });
          return;
        }
        if (p === '/api/chat/read') {
          const agent = safeName(body.agent, 'agent');
          const entry = getAgentEntry(agent, false);
          if (entry) {
            const sessionId = body.sessionId || body.session;
            if (sessionId) getThread(agent, false, sessionId).unread = 0;
            else if (Array.isArray(entry.sessions)) for (const s of entry.sessions) s.unread = 0;
            entry.unread = (entry.sessions || []).reduce((n, s) => n + (s.unread || 0), 0);
            saveConv();
          }
          send(200, { ok: true });
          return;
        }
        if (p === '/api/avatars') {
          const agent = safeName(body.agent, 'agent');
          const emoji = typeof body.emoji === 'string' ? body.emoji.trim().slice(0, 16) : '';
          const img = typeof body.img === 'string' ? body.img.trim().slice(0, 500) : '';
          if (img && !img.startsWith('/uploads/') && !img.startsWith('https://') && !img.startsWith('http://')) {
            throw badReq('图片 URL 必须以 /uploads/、https:// 或 http:// 开头');
          }
          const current = await loadAvatars();
          if (!emoji && !img) {
            delete current[agent];
          } else {
            /** @type {{ emoji?: string, img?: string }} */
            const entry = {};
            if (emoji) entry.emoji = emoji;
            if (img) entry.img = img;
            current[agent] = entry;
          }
          avatarsCache = current;
          await writeFile(avatarsPath, JSON.stringify(avatarsCache, null, 1), 'utf-8');
          send(200, avatarsCache);
          return;
        }
        if (p === '/api/chat/export') {
          const agent = safeName(body.agent, 'agent');
          const sessionId = body.sessionId || body.session;
          const thread = getThread(agent, false, sessionId);
          if (!thread) throw badReq('无此线程');
          const lines = (thread.messages || []).map((m) => `[${fmtClock(m.ts)}] ${m.role === 'me' ? SELF_AGENT : m.role === 'agent' ? thread.agent : 'sys'}: ${m.text}`);
          const path = await writeArtifact(thread.agent, `chat-export-${thread.id || 'sess'}`, lines.join('\n\n'));
          send(200, { path });
          return;
        }
        if (p === '/api/task/post') {
          const from = safeName(body.from_agent || SELF_AGENT, 'from_agent');
          const title = str(body.title, 300, 'title');
          const detail = typeof body.detail === 'string' ? body.detail.slice(0, 20_000) : '';
          const toAgent = body.to_agent && String(body.to_agent).trim() ? safeName(body.to_agent, 'to_agent') : undefined;
          const priority = ['low', 'normal', 'high'].includes(body.priority) ? body.priority : 'normal';
          const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim().slice(0, 500) : undefined;
          const text = await mutate('task.post', () => hub.callTool('hub_post_task', { from_agent: from, title, detail, priority, ...(toAgent ? { to_agent: toAgent } : {}), ...(cwd ? { cwd } : {}) }));
          send(200, { text });
          return;
        }
        if (p === '/api/task/claim') {
          const task_id = safeName(body.task_id, 'task_id');
          const agent = safeName(body.agent, 'agent');
          const text = await mutate('task.claim', () => hub.callTool('hub_claim_task', { task_id, agent }));
          send(200, { text });
          return;
        }
        if (p === '/api/task/complete') {
          const task_id = safeName(body.task_id, 'task_id');
          const agent = safeName(body.agent, 'agent');
          const result = typeof body.result === 'string' ? body.result.slice(0, 20_000) : '';
          const success = body.success !== false;
          const text = await mutate('task.complete', () => hub.callTool('hub_complete_task', { task_id, agent, result, success }));
          send(200, { text });
          return;
        }
        if (p === '/api/message') {
          const to_agent = safeName(body.to_agent, 'to_agent');
          const from_agent = safeName(body.from_agent || SELF_AGENT, 'from_agent');
          const text = str(body.text, 20_000, 'text');
          const res = await mutate('message', () => hub.callTool('hub_send_message', { from_agent, to_agent, text }));
          send(200, { text: res });
          return;
        }
        if (p === '/api/inbox') {
          const agent = safeName(body.agent, 'agent');
          const mark_read = body.mark_read === true;
          if (agent === SELF_AGENT) {
            // 本控制台收件箱已由会话引擎接管(实时入库+路由进线程), 这里返回未匹配消息
            send(200, { messages: conv.captured.map((m) => ({ ts: m.ts2 ? fmtClock(m.ts2) : m.ts, from: m.from, text: m.text })), engine: true });
            return;
          }
          const text = await (mark_read
            ? mutate('inbox.read', () => hub.callTool('hub_read_messages', { agent, mark_read: true }))
            : hub.callTool('hub_read_messages', { agent, mark_read: false }).catch((err) => { const e = new Error(sanitizeHubError(err.message)); /** @ts-ignore */ e.status = 502; throw e; }));
          send(200, { messages: parseInbox(agent, text) });
          return;
        }
        if (p === '/api/note/set') {
          const key = str(body.key, 120, 'key').trim();
          if (!/^[\w.\-一-龥]{1,120}$/.test(key)) throw badReq('key 含非法字符');
          const value = str(body.value, 20_000, 'value');
          const text = await mutate('note.set', () => hub.callTool('hub_note_set', { key, value, agent: SELF_AGENT }));
          send(200, { text });
          return;
        }
        throw badReq('未知操作');
      }
      send(404, { error: 'not_found' });
    };

    route().catch((err) => {
      if (response.headersSent) { try { response.end(); } catch { /* noop */ } return; }
      send(err && err.status ? err.status : 500, { error: sanitizeHubError(err && err.message) || '内部错误', ...(err.hubStatus ? { status: err.hubStatus } : {}), ...(err.ref ? { ref: err.ref } : {}) });
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(context.listen.port, context.listen.host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  context.logger.info('miniapp.runtime.listening');

  let disposal;
  const dispose = () => {
    if (disposal) return disposal;
    disposing = true;
    context.signal.removeEventListener('abort', onAbort);
    clearInterval(watcherTimer);
    clearInterval(watcherKick);
    clearInterval(resultsSweepTimer);
    for (const res of sseClients) { try { res.end(); } catch { /* noop */ } }
    sseClients.clear();
    disposal = new Promise((resolve, reject) => {
      server.close((error) => {
        subServer.close(() => {
          if (endpointFile && existsSync(endpointFile)) { /* 保留端口文件供发现, 内容含 pid 可判活 */ }
          error ? reject(error) : resolve();
        });
      });
    }).then(async () => {
      while (watcherBusy) await new Promise((r) => setTimeout(r, 20));
      await Promise.all([convWriter.flush(), usageWriter.flush()]);
    });
    return disposal;
  };
  const onAbort = () => { void dispose().catch(() => undefined); };
  context.signal.addEventListener('abort', onAbort, { once: true });
  if (context.signal.aborted) await dispose();

  return { dispose };
}

// ---------------- standalone 模式: 直接 `node server.mjs` 运行 (部署到 Linux 服务器 / 本机调试)。
// miniapp 宿主是动态 import 本模块, 其进程 argv[1] 不是 server.mjs, 不会触发这段。
// 环境变量: HUBCONSOLE_HOST(默认127.0.0.1) HUBCONSOLE_PORT(默认8890) HUBCONSOLE_DATA_DIR
//          HUBCONSOLE_SELF_AGENT HUBCONSOLE_SELF_ROLE HUBCONSOLE_SUB_HOST HUBCONSOLE_DEBUG
const __isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    return resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch { return false; }
})();
if (__isMain) {
  const standaloneLogger = {
    info: (...a) => console.log(new Date().toISOString(), '[info ]', ...a),
    warn: (...a) => console.log(new Date().toISOString(), '[warn ]', ...a),
    debug: (...a) => { if (process.env.HUBCONSOLE_DEBUG) console.log(new Date().toISOString(), '[debug]', ...a); },
  };
  const ctrl = new AbortController();
  const kill = () => ctrl.abort();
  process.on('SIGINT', kill);
  process.on('SIGTERM', kill);
  const sHost = process.env.HUBCONSOLE_HOST || '127.0.0.1';
  const sPort = Number(process.env.HUBCONSOLE_PORT || 8890);
  const sData = process.env.HUBCONSOLE_DATA_DIR || join(os.homedir(), '.agent-hub-console');
  await start({
    dataDir: sData,
    pluginRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
    listen: { host: sHost, port: sPort },
    logger: standaloneLogger,
    signal: ctrl.signal,
  });
  console.log(`[agent-hub-console] v${VERSION} standalone → http://${sHost}:${sPort}/dashboard | agent=${SELF_AGENT} | data=${sData} | sub=${SUB_BIND_HOST}:${SUBAGENT_PORTS.join('/')}`);
  await new Promise((res) => { ctrl.signal.addEventListener('abort', res, { once: true }); });
  // start() 内部监听 signal 后会 dispose 并关闭服务器, 事件循环自然清空退出
}
