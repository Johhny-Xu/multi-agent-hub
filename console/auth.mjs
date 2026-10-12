// @ts-check
// Multi-Agent Hub WebUI 登录/退出/模型管理模块（零依赖）
// 登录：spawn 官方 CLI 登录命令，累积输出并提取授权 URL/device code，交由用户浏览器完成
// 退出：把凭据文件移入 ~/.agenthub/accounts/<worker>/.logged-out-<ts>/（绝不直接删除）
// 模型：以 ~/.config/agenthub-codearts/agents.json 为唯一权威（读-改-写 + 备份）

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const AGENTS_JSON = join(HOME, '.config', 'agenthub-codearts', 'agents.json');
const CODEARTS_ENV = join(HOME, '.config', 'agenthub-codearts', 'codearts-auth.env');

const _writeLocks = new Map();
/** 进程内异步互斥锁：同一 key 的临界区严格串行，消除并发读-改-写覆盖丢失（RMW lost update） */
async function withLock(key, fn) {
  const prev = _writeLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  _writeLocks.set(key, gate);
  try { await prev; } catch { /* 前序临界区失败不阻塞后续 */ }
  try {
    return await fn();
  } finally {
    release();
    if (_writeLocks.get(key) === gate) _writeLocks.delete(key);
  }
}
/** agents.json / codearts 凭据写操作共用一把互斥锁（低频管理操作，串行无性能影响） */
const AUTH_WRITE_LOCK = 'auth-write';
const BAK_MODEL_KEEP = 5;
let bakSeq = 0;

// ---------------------------------------------------------------- 登录命令表
export const LOGIN_COMMANDS = {
  'github-copilot': { cmd: [join(HOME, '.local', 'bin', 'copilot'), 'login', '--device-code'], headless: true, note: 'GitHub OAuth 设备码流程，输出中的 URL + Code 在浏览器完成' },
  'minimaxcode': { cmd: [join(HOME, '.npm-global', 'bin', 'mmx'), 'auth', 'login', '--recommend', '--region=cn'], headless: true, note: 'MiniMax OAuth，输出中的 URL 在浏览器完成' },
  'codebuddy': { interactive: true, note: '终端运行 codebuddy 进入会话后输入 /login（OAuth 走 www.codebuddy.ai），凭据落盘 .codebuddy/auth.info' },
  'codebuddy-cn': { interactive: true, note: '终端运行 codebuddy-cn 进入会话后输入 /login（OAuth 走 copilot.tencent.com），凭据落盘 .codebuddy-cn/auth.info' },
  'antigravity': { interactive: true, note: '终端运行 agy（TUI）触发 Google OAuth（accounts.google.com → antigravity.google/oauth-callback），令牌落盘 .gemini/antigravity-cli/antigravity-oauth-token' },
  'mimocode': { interactive: true, note: '终端运行 mimo auth login（TUI 选 provider）登录；凭据落盘 .local/share/mimocode/auth.json，支持快照切换' },
  'traecode': { desktop: true, note: '请在 TraeCode 桌面端登录' },
  'zcode': { desktop: true, note: '登录请走 ZCode 桌面端；多账号=对 .zcode/v2/credentials.json 做多次登录快照后切换（active_provider 为加密值，需桌面端切换）' },
  'codearts': { aksk: true, note: '填写华为云 CodeArts AK/SK' },
};

/** 各 worker 退出时需要移走的凭据文件（相对 HOME） */
const LOGOUT_FILES = {
  'codebuddy': ['.codebuddy/auth.info'],
  'codebuddy-cn': ['.codebuddy-cn/auth.info'],
  'minimaxcode': ['.mmx/config.json'],
  'antigravity': ['.gemini/antigravity-cli/antigravity-oauth-token'],
  'traecode': ['.trae-cn/trae-jwt-token'],
  'zcode': ['.zcode/v2/credentials.json'],
  'codearts': ['.config/agenthub-codearts/codearts-auth.env'],
  'mimocode': ['.local/share/mimocode/auth.json'],
};

// ---------------------------------------------------------------- 登录会话
/** @type {Map<string, {proc:import('node:child_process').ChildProcess, buf:string, exited:boolean, code:number|null, startedAt:number}>} */
const sessions = new Map();
let seq = 0;

export function startLogin(worker) {
  const spec = LOGIN_COMMANDS[worker];
  if (!spec) return { ok: false, error: `不支持的 worker: ${worker}` };
  if (!spec.cmd || !spec.headless) {
    return { ok: false, error: spec?.note || '该 worker 不支持 WebUI 发起登录', ...spec };
  }
  const id = `login-${Date.now()}-${++seq}`;
  const child = spawn(spec.cmd[0], spec.cmd.slice(1), {
    cwd: HOME,
    env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
  });
  const entry = { proc: child, buf: '', exited: false, code: null, startedAt: Date.now() };
  sessions.set(id, entry);
  child.stdout.on('data', (d) => { entry.buf += d.toString(); trim(entry); });
  child.stderr.on('data', (d) => { entry.buf += d.toString(); trim(entry); });
  child.on('exit', (code) => { entry.exited = true; entry.code = code; });
  child.on('error', (e) => { entry.buf += `
[spawn-error] ${e.message}
`; entry.exited = true; entry.code = -1; });
  return { ok: true, loginId: id, worker, note: spec.note };
}

function trim(entry) { if (entry.buf.length > 8000) entry.buf = entry.buf.slice(-8000); }

const URL_RE = /https?:\/\/[^\s"'<>]+/g;
const CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4,8}|[A-Z0-9]{8,12})\b/;

/** 沙箱添加账号：以隔离 HOME 启动登录命令，授权后凭据落在沙箱内，供快照成档案 */
export function startLoginSandbox(worker, name) {
  const spec = LOGIN_COMMANDS[worker];
  if (!spec || !spec.cmd || !spec.headless) {
    return { ok: false, error: (spec && spec.note) || '该 worker 不支持沙箱添加账号' };
  }
  const sandbox = join(HOME, '.agenthub', 'sandbox', `${worker}-${name}-${Date.now()}`);
  mkdirSync(sandbox, { recursive: true });
  const id = `add-${Date.now()}-${++seq}`;
  const child = spawn(spec.cmd[0], spec.cmd.slice(1), {
    cwd: sandbox,
    env: { ...process.env, HOME: sandbox, TERM: 'dumb', NO_COLOR: '1' },
  });
  const entry = { proc: child, buf: '', exited: false, code: null, startedAt: Date.now(), sandbox };
  sessions.set(id, entry);
  child.stdout.on('data', (d) => { entry.buf += d.toString(); trim(entry); });
  child.stderr.on('data', (d) => { entry.buf += d.toString(); trim(entry); });
  child.on('exit', (code) => { entry.exited = true; entry.code = code; });
  child.on('error', (e) => { entry.buf += `\n[spawn-error] ${e.message}\n`; entry.exited = true; entry.code = -1; });
  return { ok: true, loginId: id, worker, name, sandbox, note: spec.note };
}

/** 取登录会话的沙箱目录（供 addFromSandbox 快照） */
export function getSandbox(loginId) {
  const e = sessions.get(loginId);
  return e ? e.sandbox : null;
}

export function pollLogin(loginId) {
  const e = sessions.get(loginId);
  if (!e) return { ok: false, error: '登录会话不存在或已过期' };
  const urls = e.buf.match(URL_RE) || [];
  const deviceMatch = e.buf.match(/code[:：]?\s*([A-Z0-9]{4,8}-[A-Z0-9]{4,8})/i);
  return {
    ok: true,
    output: e.buf.slice(-1200),
    url: urls.find((u) => /auth|oauth|login|device|token/i.test(u)) || urls[0] || null,
    deviceCode: deviceMatch ? deviceMatch[1] : null,
    exited: e.exited,
    exitCode: e.code,
  };
}

export function finishLogin(loginId) {
  const e = sessions.get(loginId);
  if (!e) return { ok: false, error: '登录会话不存在或已过期' };
  try { e.proc.kill('SIGTERM'); } catch { /* 已退出 */ }
  sessions.delete(loginId);
  return { ok: true };
}

// ---------------------------------------------------------------- 退出登录
export async function logout(worker) {
  const files = LOGOUT_FILES[worker];
  if (!files) return { ok: false, error: `该 worker 无可退出的凭据文件: ${worker}` };
  const destDir = join(HOME, '.agenthub', 'accounts', worker, `.logged-out-${Date.now()}`);
  await mkdir(destDir, { recursive: true });
  const moved = [];
  for (const rel of files) {
    try {
      const src = join(HOME, rel);
      await rename(src, join(destDir, rel.split('/').pop()));
      moved.push(`~/${rel}`);
    } catch { /* 文件不存在则跳过 */ }
  }
  if (moved.length === 0) return { ok: false, error: '未找到任何凭据文件（可能已退出）' };
  return { ok: true, worker, moved, backup: destDir, note: '凭据已移出（可随时从该目录手动移回以恢复登录）' };
}

// ---------------------------------------------------------------- CodeArts AK/SK
async function _saveCodeArts(ak, sk) {
  if (!/^[\w-]{8,128}$/.test(ak) || !/^[\w-]{8,128}$/.test(sk)) {
    return { ok: false, error: 'AK/SK 格式不合法（仅限字母数字-_，长度 8~128）' };
  }
  await mkdir(join(HOME, '.config', 'agenthub-codearts'), { recursive: true });
  const body = `# Multi-Agent Hub CodeArts AK/SK (written via WebUI ${new Date().toISOString()})\nCODEARTS_CLI_AK=${ak}\nCODEARTS_CLI_SK=${sk}\n`;
  await writeFile(CODEARTS_ENV, body, { mode: 0o600 });
  return { ok: true, note: 'CodeArts AK/SK 已保存（0600），下次派发生效' };
}

// ---------------------------------------------------------------- 模型管理
const CATALOG_MODELS = {
  codearts: [
    { id: 'huaweicloud-maas/GLM-5.2', name: 'GLM-5.2', credits: '0.70x', default: true },
    { id: 'huaweicloud-maas/glm-5.2-sft-harmony', name: 'GLM-5.2-ArkTS-SPARK', credits: '0.70x' },
    { id: 'huaweicloud-maas/openpangu-2.0-pro', name: 'OpenPangu-2.0-Pro', credits: '0.70x' },
    { id: 'huaweicloud-maas/openpangu-2.0-flash', name: 'OpenPangu-2.0-Flash', credits: '0.35x' },
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
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', tag: '免费', default: true },
    { id: 'gpt-6-astra', name: 'GPT-6-Astra' },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' },
    { id: 'gpt-5.5', name: 'GPT-5.5' },
    { id: 'glm-5.3', name: 'GLM-5.3' },
    { id: 'glm-5.2', name: 'GLM-5.2' },
    { id: 'kimi-k3', name: 'Kimi-K3' },
    { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview' },
    { id: 'grok-4.7', name: 'Grok-4.7' },
    { id: 'custom-local:trae', name: 'Trae (9router)' },
  ],
  'codebuddy-cn': [
    { id: 'default', name: 'Default', credits: 'x2.00' },
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', credits: 'x0.11', default: true },
    { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', credits: 'x0.51' },
    { id: 'minimax-m3', name: 'MiniMax-M3', credits: 'x0.25' },
    { id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.79' },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', credits: 'x0.06' },
    { id: 'glm-5.2', name: 'GLM-5.2', credits: 'x0.79' },
    { id: 'glm-5.1', name: 'GLM-5.1', credits: 'x0.79' },
    { id: 'kimi-k3-1', name: 'Kimi-K3', credits: 'x1.62' },
    { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', credits: 'x0.77' },
    { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', credits: 'x0.57' },
    { id: 'hy4-preview', name: 'Hy4 preview', credits: 'x0.29', tag: '试用' },
    { id: 'hunyuan-chat', name: 'Hunyuan-Turbos', credits: 'x0.10' },
  ],
  antigravity: [
    { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash Medium', default: true },
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash High' },
    { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro High' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
    { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
  ],
  mimocode: [
    { id: 'xiaomi/mimo-v2.6-flash', name: 'MiMo-V2.6-Flash (26f)', default: true },
    { id: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro' },
    { id: 'mimo-v2.6-pro-ultraspeed', name: 'MiMo-V2.6-Pro-UltraSpeed' },
    { id: '9router/trae', name: 'Trae (9router 通道)' },
  ],
  minimaxcode: [
    { id: 'MiniMax-M3.1-Flash-Preview', name: 'MiniMax-M3.1-Flash-Preview', tag: '512K/1M', default: true },
    { id: 'MiniMax-M3', name: 'MiniMax-M3', tag: '1M 上下文' },
  ],
  zcode: [
    { id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash', default: true },
  ],
  traecode: [
    { id: 'GLM-5.3-FlashX', name: 'GLM-5.3-FlashX', credits: '0.31x', default: true },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', credits: '0.06x' },
    { id: 'glm-5.3', name: 'GLM-5.3', credits: '0.78x', tag: '会员 5 折' },
    { id: 'glm-5.2', name: 'GLM-5.2', credits: '0.78x', tag: '会员 5 折' },
    { id: 'MiMo-V2.6-Flash', name: 'MiMo-V2.6-Flash', credits: '0.06x' },
    { id: 'MiMo-V2.6-Pro', name: 'MiMo-V2.6-Pro', credits: '0.15x' },
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', credits: '0.20x', tag: '限时折扣' },
    { id: 'DeepSeek-V4-Flash', name: 'DeepSeek-V4-Flash', credits: '0.20x', tag: '限时折扣' },
    { id: 'DeepSeek-V4-Pro', name: 'DeepSeek-V4-Pro', credits: '0.72x', tag: '限时折扣' },
    { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', credits: '0.08x' },
    { id: 'qwen3.8-max', name: 'Qwen3.8-Max', credits: '1.50x' },
    { id: 'qwen-3.7-plus', name: 'Qwen-3.7-Plus', credits: '0.25x' },
    { id: 'Doubao-Seed-Evolving', name: 'Seed-Evolving', credits: '0.08x', tag: '限时 1 折' },
    { id: 'Doubao-Seed-2.1-Pro', name: 'Seed-2.1-Pro', credits: '0.08x', tag: '限时 1 折' },
    { id: 'Doubao-Seed-2.1-Turbo', name: 'Seed-2.1-Turbo', credits: '0.20x', tag: '专属补贴' },
    { id: 'Doubao-Seed-Code', name: 'Seed-Code', credits: '0.06x', tag: '专属补贴' },
    { id: 'kimi-k3', name: 'Kimi-K3', credits: '1.50x' },
    { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', credits: '0.60x' },
    { id: 'minimax-m3', name: 'MiniMax-M3', credits: '0.25x' },
    { id: 'step-5-preview', name: 'Step-5-Preview', credits: '0.50x' },
  ],
};

async function loadAgents() {
  try { return JSON.parse((await readFile(AGENTS_JSON, 'utf-8')).replace(/^\uFEFF/, '')); } catch { return { agents: {} }; }
}

/** 生成新备份后清理 .bak-model-*，仅保留最新 BAK_MODEL_KEEP 份 */
async function pruneModelBackups() {
  try {
    const dir = join(AGENTS_JSON, '..');
    const files = (await readdir(dir)).filter((f) => f.startsWith('agents.json.bak-model-')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - BAK_MODEL_KEEP))) {
      try { await rm(join(dir, f)); } catch { /* 单个删除失败忽略 */ }
    }
  } catch { /* 目录不存在等 */ }
}

async function saveAgents(data) {
  await mkdir(join(AGENTS_JSON, '..'), { recursive: true });
  await writeFile(`${AGENTS_JSON}.bak-model-${Date.now()}-${++bakSeq}`, await readFile(AGENTS_JSON, 'utf-8').catch(() => '[]'));
  await writeFile(AGENTS_JSON, JSON.stringify(data, null, 2));
  await pruneModelBackups();
}

export async function listModels() {
  const d = await loadAgents();
  const workers = {};
  const allWorkerNames = new Set([...Object.keys(CATALOG_MODELS), ...Object.keys(d.agents || {})]);
  for (const w of allWorkerNames) {
    const prof = (d.agents && d.agents[w]) || {};
    const rawModels = prof.models || {};
    const catalog = CATALOG_MODELS[w] || [];
    const rawDefault = rawModels.default || catalog.find((m) => m.default)?.id || null;
    const defaultId = (rawDefault && rawDefault !== 'default' && rawModels[rawDefault]) ? rawModels[rawDefault] : rawDefault;
    const merged = [];
    const seenIds = new Set();

    for (const cat of catalog) {
      const shortAliases = Object.entries(rawModels)
        .filter(([k, v]) => k !== 'default' && v === cat.id && k !== cat.id)
        .map(([k]) => k);
      merged.push({
        alias: shortAliases[0] || cat.id,
        id: cat.id,
        name: cat.name || cat.id,
        credits: cat.credits || null,
        tag: cat.tag || null,
        aliases: shortAliases,
        custom: false,
        isDefault: cat.id === defaultId,
      });
      seenIds.add(cat.id);
    }

    for (const [alias, id] of Object.entries(rawModels)) {
      if (alias === 'default' || !id) continue;
      if (seenIds.has(id)) continue;
      merged.push({
        alias,
        id,
        name: alias === id ? id : `${alias} (${id})`,
        credits: null,
        tag: '自定义',
        aliases: [alias],
        custom: true,
        isDefault: id === defaultId,
      });
    }

    workers[w] = {
      default: defaultId,
      models: merged,
    };
  }
  return { file: AGENTS_JSON, workers };
}

async function _setDefaultModel(worker, aliasOrId) {
  const d = await loadAgents();
  const prof = d.agents?.[worker];
  if (!prof) return { ok: false, error: `agents.json 中不存在 worker: ${worker}` };
  const models = prof.models || {};
  const catalog = CATALOG_MODELS[worker] || [];
  let targetId = null;

  if (aliasOrId !== 'default' && aliasOrId in models) {
    targetId = models[aliasOrId];
  } else {
    const catMatch = catalog.find((m) => m.id === aliasOrId || m.name === aliasOrId);
    if (catMatch) {
      targetId = catMatch.id;
      // 确保该模型写入 agents.json 的别名表，便于 Hub 校验与直接调用
      const hasEntry = Object.entries(models).some(([k, v]) => k !== 'default' && v === targetId);
      if (!hasEntry) {
        const safeKey = targetId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 32) || 'model';
        models[safeKey] = targetId;
      }
    } else if (Object.values(models).includes(aliasOrId)) {
      targetId = aliasOrId;
    }
  }

  if (!targetId) {
    return { ok: false, error: `模型或别名 ${aliasOrId} 不存在` };
  }
  const prev = models.default;
  models.default = targetId;
  prof.models = models;
  await saveAgents(d);
  return { ok: true, worker, prev, now: models.default, note: 'hub 每次派发实时读取，无需重启' };
}

async function _addCustomModel(worker, alias, id) {
  if (!/^[\w.-]{1,32}$/.test(alias)) return { ok: false, error: '别名不合法（字母数字._-，≤32）' };
  if (typeof id !== 'string' || id.length < 1 || id.length > 96) return { ok: false, error: '模型 id 不合法（1~96 字符）' };
  const d = await loadAgents();
  const prof = d.agents?.[worker];
  if (!prof) return { ok: false, error: `agents.json 中不存在 worker: ${worker}` };
  prof.models = prof.models || {};
  if (alias in prof.models) return { ok: false, error: `别名 ${alias} 已存在` };
  prof.models[alias] = id;
  await saveAgents(d);
  return { ok: true, worker, alias, id };
}

async function _removeCustomModel(worker, alias) {
  if (alias === 'default') return { ok: false, error: 'default 别名不可删除' };
  const d = await loadAgents();
  const prof = d.agents?.[worker];
  if (!prof || !prof.models || !(alias in prof.models)) return { ok: false, error: `仅可删除已保存的自定义模型别名（内置预设模型不可删除）` };
  delete prof.models[alias];
  await saveAgents(d);
  return { ok: true, worker, alias };
}

// ---- 并发加固：以下导出为串行互斥包装（内部实现为 _<name>） ----
export function saveCodeArts(ak, sk) { return withLock(AUTH_WRITE_LOCK, () => _saveCodeArts(ak, sk)); }
export function setDefaultModel(worker, alias) { return withLock(AUTH_WRITE_LOCK, () => _setDefaultModel(worker, alias)); }
export function addCustomModel(worker, alias, id) { return withLock(AUTH_WRITE_LOCK, () => _addCustomModel(worker, alias, id)); }
export function removeCustomModel(worker, alias) { return withLock(AUTH_WRITE_LOCK, () => _removeCustomModel(worker, alias)); }
