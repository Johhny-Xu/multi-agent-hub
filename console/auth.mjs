// @ts-check
// Multi-Agent Hub WebUI 登录/退出/模型管理模块（零依赖）
// 登录：spawn 官方 CLI 登录命令，累积输出并提取授权 URL/device code，交由用户浏览器完成
// 退出：把凭据文件移入 ~/.agenthub/accounts/<worker>/.logged-out-<ts>/（绝不直接删除）
// 模型：以 ~/.config/agenthub-codearts/agents.json 为唯一权威（读-改-写 + 备份）

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const AGENTS_JSON = join(HOME, '.config', 'agenthub-codearts', 'agents.json');
const CODEARTS_ENV = join(HOME, '.config', 'agenthub-codearts', 'codearts-auth.env');

// ---------------------------------------------------------------- 登录命令表
export const LOGIN_COMMANDS = {
  'github-copilot': { cmd: [join(HOME, '.local', 'bin', 'copilot'), 'login', '--device-code'], headless: true, note: 'GitHub OAuth 设备码流程，输出中的 URL + Code 在浏览器完成' },
  'minimaxcode': { cmd: [join(HOME, '.npm-global', 'bin', 'mmx'), 'auth', 'login', '--recommend', '--region=cn'], headless: true, note: 'MiniMax OAuth，输出中的 URL 在浏览器完成' },
  'codebuddy': { interactive: true, note: '请在终端运行 codebuddy 后输入 /login（当前凭据目录见账号档案）' },
  'codebuddy-cn': { interactive: true, note: '请在终端运行 codebuddy-cn 后输入 /login（国内版）' },
  'antigravity': { desktop: true, note: '令牌由 Antigravity 桌面端/CLI 自动刷新，WebUI 暂不支持发起登录' },
  'mimocode': { note: 'serviceToken 由本机续期脚本管理，WebUI 暂不支持登录' },
  'traecode': { desktop: true, note: '请在 TraeCode 桌面端登录' },
  'zcode': { desktop: true, note: '请在 ZCode 桌面端登录' },
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
export async function saveCodeArts(ak, sk) {
  if (!/^[\w-]{8,128}$/.test(ak) || !/^[\w-]{8,128}$/.test(sk)) {
    return { ok: false, error: 'AK/SK 格式不合法（仅限字母数字-_，长度 8~128）' };
  }
  await mkdir(join(HOME, '.config', 'agenthub-codearts'), { recursive: true });
  const body = `# Multi-Agent Hub CodeArts AK/SK (written via WebUI ${new Date().toISOString()})\nCODEARTS_CLI_AK=${ak}\nCODEARTS_CLI_SK=${sk}\n`;
  await writeFile(CODEARTS_ENV, body, { mode: 0o600 });
  return { ok: true, note: 'CodeArts AK/SK 已保存（0600），下次派发生效' };
}

// ---------------------------------------------------------------- 模型管理
async function loadAgents() {
  try { return JSON.parse(await readFile(AGENTS_JSON, 'utf-8')); } catch { return { agents: {} }; }
}

async function saveAgents(data) {
  await mkdir(join(AGENTS_JSON, '..'), { recursive: true });
  await writeFile(`${AGENTS_JSON}.bak-model-${Date.now()}`, await readFile(AGENTS_JSON, 'utf-8').catch(() => '[]'));
  await writeFile(AGENTS_JSON, JSON.stringify(data, null, 2));
}

export async function listModels() {
  const d = await loadAgents();
  const workers = {};
  for (const [w, prof] of Object.entries(d.agents || {})) {
    const models = prof.models || {};
    workers[w] = {
      default: models.default || null,
      models: Object.entries(models).filter(([k]) => k !== 'default').map(([alias, id]) => ({ alias, id })),
    };
  }
  return { file: AGENTS_JSON, workers };
}

export async function setDefaultModel(worker, alias) {
  const d = await loadAgents();
  const prof = d.agents?.[worker];
  if (!prof) return { ok: false, error: `agents.json 中不存在 worker: ${worker}` };
  const models = prof.models || {};
  if (alias === 'default' || !(alias in models)) {
    return { ok: false, error: `别名 ${alias} 不存在（default 键不可直接指派；请用具体别名或先添加自定义模型）` };
  }
  const prev = models.default;
  // default 存别名解析后的真实 id，保持 hub 语义（models.default 为 id）
  models.default = models[alias];
  prof.models = models;
  await saveAgents(d);
  return { ok: true, worker, prev, now: models.default, note: 'hub 每次派发实时读取，无需重启' };
}

export async function addCustomModel(worker, alias, id) {
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

export async function removeCustomModel(worker, alias) {
  if (alias === 'default') return { ok: false, error: 'default 别名不可删除' };
  const d = await loadAgents();
  const prof = d.agents?.[worker];
  if (!prof || !prof.models || !(alias in prof.models)) return { ok: false, error: `别名 ${alias} 不存在` };
  delete prof.models[alias];
  await saveAgents(d);
  return { ok: true, worker, alias };
}
