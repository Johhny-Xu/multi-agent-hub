// @ts-check
// Multi-Agent Hub WebUI 11-Worker 登录 / 退出 / 回调认证 / 模型管理模块（零第三方依赖）
// 支持全部 11 个子代理通过 WebUI 完成登录、退出、沙箱添加新账号与回调/Token 认证：
// 1. minimaxcode    : Python PTY 包装 mcode login --region cn --no-browser（提取授权链接与设备码）
// 2. codebuddy      : 官方 codebuddy --acp (external) JSON-RPC authenticate，秒级提取 _codebuddy.ai/authUrl 并自动落盘
// 3. codebuddy-cn   : 官方 codebuddy --acp (internal) JSON-RPC authenticate，秒级提取 copilot.tencent.com 链接并自动落盘
// 4. github-copilot : Python PTY 包装 copilot login --device-code（提取 GitHub 设备码与链接）+ 支持粘贴 GitHub Token
// 5. antigravity    : 官方 Google OAuth 2.0 授权流（accounts.google.com + 本地 20128 监听 + 粘贴回调 URL/code 自动换取令牌）
// 6. mimocode       : 官方 Xiaomi MiMo X25519 + AES-256-GCM 授权流（platform.xiaomimimo.com/authorize + 粘贴加密 Code 解密落盘）
// 7. traecode       : 官方 Trae GetLoginGuidance + ExchangeToken OAuth 授权流（www.trae.cn / www.trae.ai + 回调链接/JWT 落盘）
// 8. zcode          : 官方 ZCode CLI Polling OAuth（zcode.z.ai/api/v1/oauth/cli/init + 自动轮询 poll + enc:v1 加密落盘）
// 9. codearts       : 华为云 IAM 访问密钥页面引导 + WebUI 内联 AK/SK 认证落盘
// 10. opencode      : provider:api_key 直写官方 ~/.local/share/opencode/auth.json，并用 opencode auth list 复核
// 11. cline         : provider|api_key 非交互执行官方 cline auth -p/-k/-m/-b，校验 ~/.cline 凭据后归档

import { spawn, execFile as execFileCb } from 'node:child_process';
import { createDecipheriv, createDiffieHellman, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename, readdir, rm, chmod, stat } from 'node:fs/promises';
import http from 'node:http';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { clearQuotaCache, fetchJsonSmart, encryptZcodeCred } from './vendor-quota.mjs';
import { autoSyncLiveAccount, addFromSandbox, findCodeBuddySharedAuth } from './accounts.mjs';
import { QODER_MODELS } from './qoder.mjs';

const execFile = promisify(execFileCb);
const HOME = homedir();
const CONSOLE_DIR = dirname(fileURLToPath(import.meta.url));
function resolveAgentsJsonPath() {
  if (process.env.HUB_AGENTS_FILE && process.env.HUB_AGENTS_FILE.trim()) {
    return process.env.HUB_AGENTS_FILE.trim();
  }
  const candidates = [
    join(CONSOLE_DIR, '..', 'hub', 'agents.json'),
    join(HOME, '.config', 'agenthub', 'agents.json'),
    join(HOME, '.config', 'agenthub-codearts', 'agents.json'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return join(CONSOLE_DIR, '..', 'hub', 'agents.json');
}
function resolveCliBin(binName, fallbackPath) {
  const pathDirs = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  const searchDirs = [...pathDirs, join(HOME, '.npm-global', 'bin'), join(HOME, '.local', 'bin'), '/usr/local/bin', '/usr/bin'];
  for (const dir of searchDirs) {
    const candidate = join(dir, binName);
    if (existsSync(candidate)) return candidate;
  }
  return fallbackPath;
}
const AGENTS_JSON = resolveAgentsJsonPath();
const CODEARTS_ENV = join(HOME, '.config', 'agenthub-codearts', 'codearts-auth.env');
const SECRET_HELPER = join(CONSOLE_DIR, 'secret-get.py');

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

// ---------------------------------------------------------------- 官方 OAuth 常量
const ANTIGRAVITY_OAUTH = {
  clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
  installedVerifierB64: 'R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scopes: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
  ],
  defaultPort: 20128,
};

const MIMO_PLATFORM_URL = process.env.MIMO_PLATFORM_URL || 'https://platform.xiaomimimo.com';

const TRAE_OAUTH = {
  clientId: 'ono9krqynydwx5',
  clientSecret: '-',
  guidanceUrlsCn: ['https://api.trae.com.cn/cloudide/api/v3/trae/GetLoginGuidance'],
  guidanceUrlsIntl: [
    'https://api.trae.ai/cloudide/api/v3/trae/GetLoginGuidance',
    'https://api.marscode.com/cloudide/api/v3/trae/GetLoginGuidance',
  ],
  apiOrigins: [
    'https://api.trae.com.cn',
    'https://api.trae.ai',
    'https://api.marscode.com',
    'https://www.trae.ai',
  ],
  // IDE 原生兑换端点（AuthCode + PKCE CodeVerifier，与 Trae IDE main.js 一致）
  ideApiOrigins: ['https://api.trae.cn', 'https://api.trae.com.cn', 'https://api.trae.ai'],
  exchangeTokenPath: '/cloudide/api/v3/trae/oauth/ExchangeToken',
  ideExchangeTokenPath: '/trae/api/v3/oauth/ExchangeToken',
  userAgent: 'Trae/1.0.0 antigravity-cockpit-tools',
  defaultAppVersion: '3.5.54',
};

/** 通过官方 GetLoginGuidance 动态探测登录主机名，失败回退默认域名 */
async function fetchTraeLoginHost(urls, fallbackHost) {
  for (const u of urls) {
    try {
      const r = await fetchJsonSmart(u, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }, 6000);
      const host = r.json?.Result?.LoginHost || r.json?.result?.LoginHost || r.json?.result?.loginHost;
      if (typeof host === 'string' && host.trim()) {
        return host.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      }
    } catch { /* 尝试下一个 */ }
  }
  return fallbackHost;
}

const ZCODE_OAUTH = {
  initUrl: 'https://zcode.z.ai/api/v1/oauth/cli/init',
  pollBaseUrl: 'https://zcode.z.ai/api/v1/oauth/cli/poll',
  tokenUrl: 'https://zcode.z.ai/api/v1/oauth/token',
  userinfoUrl: 'https://bigmodel.cn/api/biz/customer/getCustomerInfo',
};

/** zcode 区域 → 官方 OAuth provider（与 ZCode 官方 CLI 的 zai/bigmodel 账号族一致） */
function zcodeProviderOf(region) {
  return String(region || '').trim().toLowerCase() === 'intl' ? 'zai' : 'bigmodel';
}

// ---------------------------------------------------------------- 登录命令表（全部 11 个 Worker 均支持 WebUI 登录）
export const LOGIN_COMMANDS = {
  'minimaxcode': {
    // MiniMax Code 官方 CLI（mcode）：--no-browser 打印授权链接 + 设备码，轮询落盘到 mcode 自己的配置目录
    cmd: [resolveCliBin('mcode', join(HOME, '.minimax-code', 'bin', 'mcode')), 'login', '--region', 'cn', '--no-browser'],
    headless: true,
    mode: 'pty_device',
    note: '打开 MiniMax 授权链接并确认设备码即可（与 MiniMax Code 桌面端同一账号，签到赠予积分在 Code 内可用）；登录态写入 mcode 配置目录，不再使用 mmx',
    callbackHint: '可选：完成授权后把浏览器最终地址粘到下方，便于立即确认',
  },
  'codebuddy': {
    cmd: [resolveCliBin('codebuddy', join(HOME, '.npm-global', 'bin', 'codebuddy')), '--acp'],
    headless: true,
    mode: 'acp_oauth',
    acpEnv: 'external',
    note: '点击下方 CodeBuddy 国际版 (www.codebuddy.ai) OAuth 链接完成登录；浏览器显示 started 成功页后系统会自动落盘（也可把该 started 链接粘贴到下方立即完成）。注意：官方单会话策略下重新授权会使同账号网页端会话下线',
    callbackHint: '可选：粘贴 started 成功页链接自动完成认证；或粘贴 auth.info JSON / accessToken 导入（不影响网页端会话）',
  },
  'codebuddy-cn': {
    cmd: [resolveCliBin('codebuddy', join(HOME, '.npm-global', 'bin', 'codebuddy')), '--acp'],
    headless: true,
    mode: 'acp_oauth',
    acpEnv: 'internal',
    note: '点击下方 CodeBuddy 国内版 (copilot.tencent.com) OAuth 链接完成微信/腾讯云扫码登录；浏览器显示 started 成功页后系统会自动落盘（也可把该 started 链接粘贴到下方立即完成）。注意：官方单会话策略下重新授权会使同账号网页端会话下线',
    callbackHint: '可选：粘贴 started 成功页链接自动完成认证；或粘贴 auth.info JSON / accessToken 导入（不影响网页端会话）',
  },
  'github-copilot': {
    cmd: [resolveCliBin('copilot', join(HOME, '.local', 'bin', 'copilot')), 'login', '--device-code'],
    headless: true,
    mode: 'pty_device',
    note: '点击打开 GitHub Device 授权页并输入下方 8 位设备码，授权后自动写入系统凭据环',
    callbackHint: '可选：直接粘贴 GitHub OAuth Token (gho_... / ghu_...) 立即保存',
  },
  'antigravity': {
    headless: true,
    mode: 'google_oauth',
    needsCallbackInput: true,
    note: '1. 点击下方链接登录 Google 账号；2. 浏览器跳转到 http://localhost:20128/oauth-callback?code=... 后（若远程访问显示无法连接属正常现象），复制浏览器地址栏完整链接粘贴到下方输入框并点击「提交完成认证」',
    callbackHint: '粘贴浏览器跳转后的完整 http://localhost:20128/oauth-callback?code=... 链接或 code 参数',
  },
  'mimocode': {
    headless: true,
    mode: 'mimo_oauth',
    needsCallbackInput: true,
    note: '1. 点击下方链接前往小米 MiMo 开放平台完成授权；2. 将网页显示的授权 Code（或回调链接 / API Key）粘贴到下方输入框并点击「提交完成认证」',
    callbackHint: '粘贴小米 MiMo 网页生成的授权 Code、含 ?u= 的回调链接或 API Key (sk-...)',
  },
  'traecode': {
    headless: true,
    mode: 'trae_oauth',
    needsCallbackInput: true,
    note: '1. 点击下方 Trae 国内版（或国际版）授权链接完成登录（已按官方 IDE 标准启用 PKCE）；2. 浏览器跳转到 http://127.0.0.1:<端口>/authorize?refreshToken=... 后，复制地址栏完整链接（或直接粘贴 Trae JWT Token）到下方输入框并点击「提交完成认证」',
    callbackHint: '粘贴浏览器跳转后的 http://127.0.0.1.../authorize?refreshToken=... 完整链接或 Trae JWT Token',
  },
  'zcode': {
    headless: true,
    mode: 'zcode_oauth',
    supportsRegion: true,
    note: '先在上方选择版本区域（🇨🇳 国内版 BigModel / 🌍 国际版 Z.ai），再点击下方官方 OAuth 链接登录，后端每 3 秒自动轮询并加密写入 ~/.zcode/v2/credentials.json；也可直接粘贴对应区域的 Coding Plan API Key',
    callbackHint: '可选：直接粘贴智谱 BigModel / Z.ai API Key 或 OAuth 回调链接',
  },
  'codearts': {
    headless: true,
    mode: 'codearts_aksk',
    needsCallbackInput: true,
    note: '点击下方链接前往华为云 IAM 控制台获取访问密钥（AK/SK），在下方输入 AK 与 SK（格式 AK:SK 或分别填入）并点击「提交完成认证」',
    callbackHint: '输入格式：AK:SK（例如 XXXXxxxx:xxxxSecretxxxx）',
  },
  'opencode': {
    headless: true,
    mode: 'opencode_key',
    needsCallbackInput: true,
    note: '把 API Key 粘进来直接提交即可，不用管格式：带 provider 前缀（anthropic:sk-ant-...）就原样采用，裸 Key 会按前缀自动识别（oc_sk_ → opencode、sk-ant- → anthropic、sk-or-v1- → openrouter），识别不出就按 opencode 写入并在日志里提示。后端写入 ~/.local/share/opencode/auth.json 后用 opencode auth list 复核；也可在服务器终端运行 opencode providers login 走浏览器授权',
    callbackHint: '直接粘贴 API Key 即可（oc_sk-… / sk-ant-… / sk-or-v1-… 自动识别），也可写成 provider:api_key',
  },
  'cline': {
    cmd: [resolveCliBin('cline', join(HOME, '.npm-global', 'bin', 'cline')), 'auth'],
    headless: true,
    mode: 'pty_device',
    ptyAutoEnter: true,
    needsCallbackInput: true,
    note: '点开下方 Cline 设备授权链接并输入面板显示的验证码，授权完成后 CLI 会自动写入 ~/.cline 并加入账号列表（cline-free 免费模型必须走这条路）。若想用 API Key，直接在下方输入框粘贴（裸 Key 或 provider|model|key|base_url），后端会改用非交互方式写入并做一次真实调用校验',
    callbackHint: '浏览器授权完成后会话会自己结束并自动入账；要加 API Key 账号时在此粘贴',
  },
  'qoder': {
    cmd: [resolveCliBin('qodercli', join(HOME, '.local', 'bin', 'qodercli')), 'login'],
    headless: true,
    mode: 'pty_device',
    note: '点开下方 Qoder 官方授权链接并在浏览器登录；授权完成后 CLI 会写入 ~/.qoder（凭据 + 密钥盐），控制台自动归档账号。Qoder CLI 登录态与桌面版相互独立',
    callbackHint: '浏览器授权完成后会话会自己结束并自动入账',
  },
  'qoder-cn': {
    cmd: [resolveCliBin('qoderclicn', join(HOME, '.local', 'bin', 'qoderclicn')), 'login'],
    headless: true,
    mode: 'pty_device',
    note: '点开下方 Qoder CN 官方授权链接并在浏览器登录；授权完成后 CLI 会写入 ~/.qoder-cn（凭据 + 密钥盐），控制台自动归档账号。Qoder CN CLI 登录态与桌面版相互独立',
    callbackHint: '浏览器授权完成后会话会自己结束并自动入账',
  },
};

/** 各 worker 退出时需要移走的凭据文件（相对 HOME） */
const LOGOUT_FILES = {
  'codebuddy': ['.codebuddy/auth.info'],
  'codebuddy-cn': ['.codebuddy-cn/auth.info'],
  'minimaxcode': ['.minimax-code/codex-auth.json', '.minimax-code/auth.json', '.minimax-code/config/auth.json', '.mmx/config.json'],
  'antigravity': ['.gemini/antigravity-cli/antigravity-oauth-token'],
  'traecode': ['.trae-cn/trae-jwt-token'],
  'zcode': ['.zcode/v2/credentials.json'],
  'codearts': ['.config/agenthub-codearts/codearts-auth.env'],
  'mimocode': ['.local/share/mimocode/auth.json'],
  'github-copilot': ['.config/github-copilot/copilot-token'],
  'opencode': ['.local/share/opencode/auth.json'],
  'cline': ['.cline/data/secrets.json', '.cline/data/settings/providers.json'],
  'qoder': ['.qoder/.auth/user', '.qoder/qoder-cli-credentials.json', '.qoder/.keychain-salt'],
  'qoder-cn': ['.qoder-cn/.auth/user', '.qoder-cn/qoder-cli-credentials.json', '.qoder-cn/.keychain-salt'],
};

function stripAnsi(str) {
  return String(str || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, '');
}

/**
 * 在指定 HOME 下执行一次官方 CLI（不经过 shell，超时即回收进程）。
 * opencode / cline 的 WebUI 认证都靠官方 CLI 自身落盘，这里只做「调用 + 复核」。
 * @returns {Promise<{ code: number, stdout: string, stderr: string, timeout?: boolean, error?: string }>}
 */
function runCliWithHome(bin, args, home, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const isWinWrapper = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    const child = spawn(bin, args, {
      env: { ...process.env, HOME: home, NO_COLOR: '1', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWinWrapper,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code, extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ...extra });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(-1, { timeout: true });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish(-1, { error: err.message }));
    child.on('close', (code) => finish(typeof code === 'number' ? code : -1));
  });
}

/** Cline 的 Key 前缀 → provider：粘裸 Key 时按此推断，避免用户必须先背 provider id */
const CLINE_KEY_PROVIDERS = [
  [/^sk-ant-/, 'anthropic'],
  [/^sk-or-v1-/, 'openrouter'],
  [/^gsk_/, 'groq'],
  [/^AIza/, 'gemini'],
  [/^xai-/, 'xai'],
  [/^hf_/, 'huggingface'],
  [/^sk-proj-/, 'openai'],
  [/^sk-/, 'openai'], // 其余 sk- 归为 OpenAI 兼容通道（SiliconFlow 等网关同样以 sk- 开头）
];

/**
 * opencode 的 Key 前缀 → provider：粘裸 Key 时按此推断，免得用户先背 provider id。
 * 注意：这里只用来「猜」，猜不中也不拦——统一走默认 provider 并提示，不做格式校验。
 */
const OPENCODE_KEY_PROVIDERS = [
  [/^oc_sk_/i, 'opencode'],      // OpenCode Zen 自家 Key
  [/^oc_/i, 'opencode'],
  [/^sk-ant-/i, 'anthropic'],
  [/^sk-or-v1-/i, 'openrouter'],
  [/^gsk_/i, 'groq'],
  [/^AIza/, 'gemini'],
  [/^xai-/i, 'xai'],
  [/^hf_/i, 'huggingface'],
  [/^sk-proj-/i, 'openai'],
  [/^sk-svcacct-/i, 'openai'],
];

/** opencode 猜不中前缀时的兜底 provider（OpenCode Zen 是这套 CLI 的默认通道） */
const OPENCODE_DEFAULT_PROVIDER = 'opencode';

/**
 * 解析 opencode 登录输入。**不做格式校验**，只要不是空、不是回调链接就收：
 *   provider:api_key / provider|api_key / provider api_key  → 原样采用
 *   裸 api_key                                             → 按前缀猜 provider，猜不中给默认值
 * @returns {{ok:true, provider:string, apiKey:string, note:string} | {ok:false, error:string}}
 */
export function parseOpencodeAuthInput(rawInput) {
  const raw = String(rawInput || '').trim().replace(/^[`"']+|[`"']+$/g, '');
  if (!raw) return { ok: false, error: '请粘贴 API Key' };
  // 回调链接不是 Key：写进 auth.json 只会得到一条无效凭据，明确提示改走终端 OAuth
  if (/^https?:\/\//i.test(raw) || /(?:^|[?&])(?:code|authCode)=/i.test(raw)) {
    return { ok: false, error: 'opencode 不支持回调链接：请直接粘贴 API Key，或在服务器终端运行 opencode providers login 走浏览器授权' };
  }
  const explicit = raw.match(/^([A-Za-z0-9][A-Za-z0-9._-]{0,39})\s*[:|]\s*(\S{2,})$/);
  if (explicit) {
    return { ok: true, provider: explicit[1].toLowerCase(), apiKey: explicit[2].trim(), note: '' };
  }
  // 「provider key」空格形式：只有当第一段不像 Key 前缀时才当 provider，
  // 否则（如 "oc_sk_abc def" 是被换行打断的同一个 Key）整段拼成一个 Key
  const spaceParts = raw.split(/\s+/).filter(Boolean);
  const firstLooksLikeKey = OPENCODE_KEY_PROVIDERS.some(([re]) => re.test(spaceParts[0] || ''));
  if (spaceParts.length === 2 && !firstLooksLikeKey) {
    return { ok: true, provider: spaceParts[0].toLowerCase(), apiKey: spaceParts[1], note: '' };
  }
  const apiKey = raw.replace(/\s+/g, ''); // 复制时被换行/空格打断的 Key 直接拼回去
  const hit = OPENCODE_KEY_PROVIDERS.find(([re]) => re.test(apiKey));
  const provider = hit ? hit[1] : OPENCODE_DEFAULT_PROVIDER;
  const note = hit
    ? `未写 provider，已按 Key 前缀识别为「${provider}」`
    : /^sk-/i.test(apiKey)
      // sk- 是多家通用前缀（siliconflow / deepseek / openai 都用），不硬猜，写默认值并把风险说清楚
      ? `未识别厂商前缀（sk- 开头可能是 siliconflow / deepseek / openai），已按默认 provider「${provider}」写入；若调用报 401，改用 siliconflow:${apiKey.slice(0, 6)}… 重贴`
      : `未识别 Key 前缀，已按默认 provider「${provider}」写入；若不对请用 provider:api_key 重贴`;
  return { ok: true, provider, apiKey, note };
}

/**
 * 解析 Cline 登录输入。支持：
 *   provider|api_key
 *   provider|model|api_key
 *   provider|model|api_key|base_url
 *   provider:api_key / provider api_key
 *   裸 api_key（按前缀推断 provider）
 * @returns {{ok: true, provider: string, model: string, apiKey: string, baseUrl: string, inferred: boolean} | {ok: false, error: string}}
 */
export function parseClineAuthInput(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) return { ok: false, error: '请粘贴 API Key，或使用 provider|api_key 形式' };
  const piped = raw.split('|').map((s) => s.trim()).filter(Boolean);
  let provider = '';
  let model = '';
  let apiKey = '';
  let baseUrl = '';
  if (piped.length === 2) { [provider, apiKey] = piped; }
  else if (piped.length === 3) { [provider, model, apiKey] = piped; }
  else if (piped.length >= 4) { [provider, model, apiKey, baseUrl] = piped; }

  let inferred = false;
  if (!provider) {
    const single = piped[0] || raw;
    const head = single.split(':')[0];
    if (single.includes(':') && /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/.test(head) && !/^sk-/.test(single)) {
      // provider:key（Key 自身以 sk- 开头时不要误判成 provider）
      provider = head;
      apiKey = single.slice(single.indexOf(':') + 1).trim();
    } else if (/\s+/.test(single) && single.split(/\s+/).filter(Boolean).length === 2
      && !CLINE_KEY_PROVIDERS.some(([re]) => re.test(single.split(/\s+/).filter(Boolean)[0]))) {
      // 第二段像 Key 时才算 provider + key；否则是被换行打断的同一个 Key，走下面的整段拼接
      [provider, apiKey] = single.split(/\s+/).filter(Boolean);
    } else {
      apiKey = single;
      const hit = CLINE_KEY_PROVIDERS.find(([re]) => re.test(apiKey));
      provider = hit ? hit[1] : '';
      inferred = !!provider;
    }
  }

  // 不做格式校验：粘多段/带换行的 Key 直接拼回去，长度也不再卡
  apiKey = String(apiKey || '').replace(/\s+/g, '');
  if (!apiKey) {
    return { ok: false, error: '请粘贴 API Key' };
  }
  let note = '';
  if (!provider) {
    // 猜不中就落到 openai 兼容通道，由 cline CLI 自己给出真正的错误，不在前端拦
    provider = 'openai';
    inferred = true;
    note = '未能识别厂商前缀，已按 openai 兼容通道提交，实际错误以 cline 返回为准';
  }
  return { ok: true, provider, model, apiKey, baseUrl, inferred, note };
}

/**
 * cline auth 的快捷认证（-p + -k）强制要求 --modelid，未给模型时按厂商取官方示例默认值。
 * 没有可靠默认值的厂商返回空串，由调用方要求用户补充模型。
 */
const CLINE_DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-6',
  'openai-native': 'gpt-5',
  openai: 'gpt-5',
  gemini: 'gemini-3-pro',
  'cline-free': 'cline-free/deepseek-v4.1-flash',
};

export function clineDefaultModel(provider) {
  return CLINE_DEFAULT_MODELS[String(provider || '').trim().toLowerCase()] || '';
}

/**
 * cline 官方 CLI 把凭据写在 ~/.cline/data 下；secrets.json 或 providers.json 任一非空即视为已落盘。
 * @returns {Promise<boolean>}
 */
async function isClineCredWritten(baseHome) {
  for (const rel of ['.cline/data/secrets.json', '.cline/data/settings/providers.json']) {
    try {
      const txt = (await readFile(join(baseHome, rel), 'utf-8')).trim();
      if (txt && txt !== '__LOGGED_OUT__' && txt !== '{}') return true;
    } catch { /* 文件不存在则继续看下一个 */ }
  }
  return false;
}

/**
 * cline auth 只把配置写入 ~/.cline，并不会校验 Key 是否可用（假 Key 也会返回 0）。
 * 所以落盘后再跑一次最小真实调用，只有拿到答案才算认证成功——不制造假成功。
 * @returns {Promise<{ ok: boolean, code: number, text: string }>}
 */
async function verifyClineCredential(bin, home, model, timeoutMs = 120_000) {
  const run = await runCliWithHome(bin, ['--json', '-m', model, 'reply with the single word OK'], home, timeoutMs);
  const text = stripAnsi(run.stdout + run.stderr);
  const authFailure = /Unauthorized|invalid[_ ]api[_ ]key|authentication (?:failed|required)|\b401\b|\b403\b|insufficient|quota/i.test(text)
    || /"type"\s*:\s*"error"/.test(text);
  return { ok: run.code === 0 && !authFailure, code: run.code, text };
}

function getMimoKeyName(targetHome) {
  const dir = join(targetHome, '.local', 'share', 'mimocode');
  const file = join(dir, 'mimo-key-name');
  try {
    const existing = readFileSync(file, 'utf-8').trim();
    if (existing) return existing;
  } catch { /* ignore */ }
  const generated = `mimo-code-cli-key-${randomBytes(4).toString('hex')}`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, generated, 'utf-8');
  } catch { /* ignore */ }
  return generated;
}

/**
 * 历史遗留：mmx 时代会把备注名注入 ~/.mmx/config.json 的 oauth.account。
 * 换成 mcode 后不再有该字段（登录态由 mcode 自己管理），此函数只在旧文件存在时才写，否则静默跳过。
 */
async function injectMinimaxAccountName(targetHome, name) {
  const nn = String(name || '').trim();
  if (!nn) return;
  const cfgFile = join(targetHome, '.mmx', 'config.json');
  try {
    const cfg = JSON.parse((await readFile(cfgFile, 'utf-8')).replace(/^\uFEFF/, ''));
    cfg.oauth = cfg.oauth && typeof cfg.oauth === 'object' ? cfg.oauth : {};
    if (!cfg.oauth.account) {
      cfg.oauth.account = nn;
      await writeFile(cfgFile, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    }
  } catch { /* ignore */ }
}

function decryptMimoCode(privateKeyDer, encryptedBase64Url) {
  let uParam = String(encryptedBase64Url || '').trim();
  if (uParam.includes('u=')) {
    try {
      const parsed = new URL(uParam.startsWith('http') ? uParam : `http://localhost/?${uParam.replace(/^[?#]/, '')}`);
      uParam = parsed.searchParams.get('u') || uParam;
    } catch { /* ignore */ }
  }
  const raw = Buffer.from(uParam, 'base64url');
  if (raw.length < 60) throw new Error('MiMo 授权码长度不足或格式不正确');
  const peerPubRaw = raw.subarray(0, 32);
  const iv = raw.subarray(32, 44);
  const bodyAndTag = raw.subarray(44);
  const authTag = bodyAndTag.subarray(bodyAndTag.length - 16);
  const ciphertext = bodyAndTag.subarray(0, bodyAndTag.length - 16);
  const privKey = createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });
  const pubKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), peerPubRaw]),
    format: 'der',
    type: 'spki',
  });
  const shared = diffieHellman({ privateKey: privKey, publicKey: pubKey });
  const aesKey = createHash('sha256').update(shared).digest();
  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
  return JSON.parse(plain);
}

// ---------------------------------------------------------------- 登录会话管理
const sessions = new Map();
let seq = 0;

function trim(entry) {
  if (entry.buf.length > 10000) entry.buf = entry.buf.slice(-10000);
}

function cleanupSessionResources(entry) {
  if (!entry) return;
  if (entry.pollTimer) { clearInterval(entry.pollTimer); entry.pollTimer = null; }
  if (entry.timeoutTimer) { clearTimeout(entry.timeoutTimer); entry.timeoutTimer = null; }
  if (entry.server) {
    try { entry.server.closeAllConnections?.(); entry.server.close(); } catch { /* ignore */ }
    entry.server = null;
  }
  if (entry.proc) {
    const p = entry.proc;
    const ownGroup = entry.ownGroup;
    entry.proc = null;
    if (ownGroup && p.pid) {
      try { process.kill(-p.pid, 'SIGTERM'); } catch { /* ignore */ }
    }
    try { p.kill('SIGTERM'); } catch { /* ignore */ }
    const killTimer = setTimeout(() => {
      if (ownGroup && p.pid) {
        try { process.kill(-p.pid, 'SIGKILL'); } catch { /* ignore */ }
      }
      try { if (p.exitCode === null) p.kill('SIGKILL'); } catch { /* ignore */ }
    }, 300);
    killTimer.unref?.();
  }
}

/** 缓存最近 10 分钟内已成功向 Google 兑换过的单次授权码，彻底防止双击/重复提交触发 invalid_grant */
const recentExchangedCodes = new Map();

/**
 * 登录完成后自动将该账号归档至 ~/.agenthub/accounts/<worker>/<name> 并设为当前生效
 * @param {any} entry
 * @param {string} [preferredName]
 */
async function finalizeLoginAccount(entry, preferredName = '') {
  if (!entry) return null;
  const pref = String(preferredName || entry.name || '').trim();
  if (entry.savedAccountName && (!pref || pref === entry.savedAccountName)) {
    return { ok: true, worker: entry.worker, name: entry.savedAccountName };
  }
  try {
    const r = entry.sandbox
      ? await addFromSandbox(entry.worker, pref, entry.id)
      : await autoSyncLiveAccount(entry.worker, pref);
    if (r && r.ok && r.name) {
      entry.savedAccountName = r.name;
      entry.buf += `[账号管理] ✓ 已自动添加并切换至账号「${r.name}」\n`;
    }
    return r;
  } catch (err) {
    return { ok: false, error: err?.message || '自动归档账号失败' };
  }
}

async function exchangeAntigravityCode(entry, codeStr, preferredName = '') {
  const targetFile = join(entry.targetHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  if (entry.exited && entry.code === 0) {
    const acc = await finalizeLoginAccount(entry, preferredName);
    const accName = acc?.name || entry.savedAccountName || '';
    return {
      ok: true,
      worker: 'antigravity',
      accountName: accName,
      note: accName ? `Antigravity 认证已完成，已自动添加并切换至账号「${accName}」` : 'Antigravity Google OAuth 认证已完成并落盘',
    };
  }

  let code = String(codeStr || '').trim();
  let redirectUriFromInput = '';
  if (code.includes('code=')) {
    try {
      const isFullUrl = /^https?:\/\//i.test(code);
      const u = new URL(isFullUrl ? code : `http://localhost/oauth-callback?${code.replace(/^[?#]/, '')}`);
      code = u.searchParams.get('code') || code;
      if (isFullUrl) {
        redirectUriFromInput = `${u.protocol}//${u.host}${u.pathname}`;
      }
    } catch { /* ignore */ }
  } else if (code.includes('%2F') || code.includes('%2f')) {
    try { code = decodeURIComponent(code); } catch { /* ignore */ }
  }
  if (!code) throw new Error('未检测到有效的 Google OAuth 授权码 (code)');

  // 若该单次授权码刚在 10 分钟内兑换成功过，直接复用兑换结果，避免 Google 返回 invalid_grant
  const cached = recentExchangedCodes.get(code);
  if (cached && (Date.now() - cached.at < 600_000)) {
    await mkdir(dirname(targetFile), { recursive: true });
    await writeFile(targetFile, JSON.stringify(cached.payload, null, 2) + '\n', { mode: 0o600 });
    const acc = await finalizeLoginAccount(entry, preferredName);
    const accName = acc?.name || entry.savedAccountName || '';
    clearQuotaCache('antigravity');
    cleanupSessionResources(entry);
    entry.code = 0;
    entry.exited = true;
    return {
      ok: true,
      worker: 'antigravity',
      accountName: accName,
      note: accName ? `Antigravity 认证成功，已自动添加并切换至账号「${accName}」` : 'Antigravity Google OAuth 认证已完成',
    };
  }

  entry.buf += `\n[OAuth] 正在向 Google 换取访问令牌…\n`;
  const redirectUri = redirectUriFromInput || entry.redirectUri || `http://localhost:${ANTIGRAVITY_OAUTH.defaultPort}/oauth-callback`;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: ANTIGRAVITY_OAUTH.clientId,
    client_secret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || Buffer.from(ANTIGRAVITY_OAUTH.installedVerifierB64, 'base64').toString('utf8'),
    code,
    redirect_uri: redirectUri,
  }).toString();
  const res = await fetchJsonSmart(ANTIGRAVITY_OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  }, 20_000);
  if (!res.ok || !res.json?.access_token) {
    // 若本地回调服务刚刚已完成兑换落盘（90 秒内更新过），视为已成功并直接归档账号
    if (String(res.text || '').includes('invalid_grant')) {
      try {
        const st = await stat(targetFile);
        if (Date.now() - st.mtimeMs < 90_000) {
          const acc = await finalizeLoginAccount(entry, preferredName);
          const accName = acc?.name || entry.savedAccountName || '';
          clearQuotaCache('antigravity');
          cleanupSessionResources(entry);
          entry.code = 0;
          entry.exited = true;
          return {
            ok: true,
            worker: 'antigravity',
            accountName: accName,
            note: accName ? `Antigravity 认证成功，已自动添加并切换至账号「${accName}」` : 'Antigravity 认证已完成',
          };
        }
      } catch { /* ignore */ }
      throw new Error('该 Google 授权码已被使用或已过期（Google 授权码仅限单次兑换）。请点击上方「🚀 打开官方授权页面」重新获取最新回调链接');
    }
    throw new Error(`Google Token 交换失败 (${res.status}): ${res.text?.slice(0, 200) || 'unknown'}`);
  }
  const tok = res.json;
  const expiryIso = new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000).toISOString();
  const payload = {
    token: {
      access_token: tok.access_token,
      token_type: tok.token_type || 'Bearer',
      refresh_token: tok.refresh_token || '',
      expiry: expiryIso,
    },
    auth_method: 'oauth',
    ...(tok.id_token ? { id_token: tok.id_token } : {}),
  };
  recentExchangedCodes.set(code, { payload, at: Date.now() });
  if (recentExchangedCodes.size > 50) {
    const firstKey = recentExchangedCodes.keys().next().value;
    if (firstKey) recentExchangedCodes.delete(firstKey);
  }
  await mkdir(dirname(targetFile), { recursive: true });
  await writeFile(targetFile, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  entry.buf += `[OAuth] ✓ Antigravity OAuth 令牌已成功写入 ${targetFile}\n`;
  const acc = await finalizeLoginAccount(entry, preferredName);
  const accName = acc?.name || entry.savedAccountName || '';
  clearQuotaCache('antigravity');
  cleanupSessionResources(entry);
  entry.code = 0;
  entry.exited = true;
  return {
    ok: true,
    worker: 'antigravity',
    accountName: accName,
    note: accName ? `Antigravity 认证成功，已自动添加并切换至账号「${accName}」` : 'Antigravity Google OAuth 认证已完成并落盘',
  };
}

async function exchangeTraeCallback(entry, rawInput, preferredName = '') {
  const input = String(rawInput || '').trim();
  if (!input) throw new Error('请输入 Trae 回调链接或 JWT Token');
  let accessToken = '';
  const isCallbackUrl = input.includes('refreshToken=') || input.includes('refresh_token=')
    || input.includes('authCodeInfo=') || input.includes('userJwt=') || input.includes('user_jwt=');
  if (isCallbackUrl) {
    const q = input.includes('?') ? input.slice(input.indexOf('?') + 1) : input.replace(/^[?#]/, '');
    const params = new URLSearchParams(q);
    // 1) 官方 IDE 回调可能直接携带最终 JWT（userJwt）
    const directJwt = params.get('userJwt') || params.get('user_jwt') || '';
    const refreshToken = params.get('refreshToken') || params.get('refresh_token') || params.get('RefreshToken') || '';
    const cloudideToken = params.get('x-cloudide-token') || params.get('xCloudideToken') || params.get('accessToken') || params.get('token') || '';
    // authCodeInfo 是 URL 编码的 JSON（内含 AuthCode），配合登录时的 PKCE CodeVerifier 兑换
    let authCode = '';
    const authCodeInfoRaw = params.get('authCodeInfo') || params.get('auth_code_info') || '';
    if (authCodeInfoRaw) {
      try { authCode = String(JSON.parse(authCodeInfoRaw)?.AuthCode || ''); } catch { /* ignore */ }
    }
    if (!authCode) authCode = params.get('AuthCode') || params.get('authCode') || params.get('code') || '';

    if (directJwt) {
      accessToken = directJwt.replace(/^(Cloud-IDE-JWT|Bearer)\s+/i, '').trim();
    } else if (refreshToken) {
      entry.buf += `\n[OAuth] 正在通过 Trae ExchangeToken (cloudide refreshToken) 接口换取 JWT…\n`;
      let lastErr = '无响应';
      for (const origin of TRAE_OAUTH.apiOrigins) {
        try {
          const headers = {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': TRAE_OAUTH.userAgent,
            ...(cloudideToken ? { 'x-cloudide-token': cloudideToken } : {}),
          };
          const r = await fetchJsonSmart(`${origin}${TRAE_OAUTH.exchangeTokenPath}`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              ClientID: TRAE_OAUTH.clientId,
              RefreshToken: refreshToken,
              ClientSecret: TRAE_OAUTH.clientSecret,
              UserID: '',
            }),
          }, 12_000);
          const tok = r.json?.Result?.AccessToken || r.json?.Result?.accessToken || r.json?.result?.access_token || r.json?.accessToken;
          if (tok) {
            accessToken = String(tok).trim();
            break;
          }
          lastErr = r.json?.Result?.Message || r.json?.message || `HTTP ${r.status}`;
        } catch (e) {
          lastErr = e.message;
        }
      }
      if (!accessToken && !authCode) throw new Error(`Trae ExchangeToken 失败: ${lastErr}`);
    }
    // 2) refreshToken 不可用或兑换失败时，用 AuthCode + PKCE CodeVerifier 走 IDE 原生兑换端点
    if (!accessToken && authCode) {
      const verifier = entry.traeCodeVerifier || '';
      if (!verifier) throw new Error('回调包含 AuthCode 但当前会话缺少 PKCE CodeVerifier，请重新发起登录后再试');
      entry.buf += `\n[OAuth] 正在通过 Trae IDE 原生 ExchangeToken (AuthCode+PKCE) 接口换取 JWT…\n`;
      // 逐域名试：三个 origin 只有一个是对的，另外两个会 404 / 400。
      // 旧实现每轮都覆盖 lastErr，最后必然停在 api.trae.ai 的 404 上，
      // 把国内端点的真实原因（无效参数 / AuthCode 已消费）盖掉了——截图上
      // 「Trae AuthCode 兑换失败: HTTP 404」就是这么来的。
      const errs = [];
      for (const origin of TRAE_OAUTH.ideApiOrigins) {
        try {
          const r = await fetchJsonSmart(`${origin}${TRAE_OAUTH.ideExchangeTokenPath}`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': TRAE_OAUTH.userAgent },
            body: JSON.stringify({
              ClientID: TRAE_OAUTH.clientId,
              AuthCode: authCode,
              CodeVerifier: verifier,
              IDEVersion: TRAE_OAUTH.defaultAppVersion,
            }),
          }, 12_000);
          const tok = r.json?.Result?.AccessToken || r.json?.Result?.accessToken || r.json?.Result?.JwtToken
            || r.json?.result?.access_token || r.json?.accessToken || r.json?.token;
          if (tok) {
            accessToken = String(tok).trim();
            break;
          }
          const host = (() => { try { return new URL(origin).host; } catch { return origin; } })();
          const code = r.json?.ResponseMetadata?.Error?.Code || r.json?.Result?.Code || '';
          const msg = r.json?.Result?.Message || r.json?.message
            || r.json?.ResponseMetadata?.Error?.Message || `HTTP ${r.status}`;
          errs.push(`${host}${code ? `[${code}]` : ''} ${msg}${r.status ? ` (HTTP ${r.status})` : ''}`);
        } catch (e) {
          errs.push(`${origin} ${e.message}`);
        }
      }
      if (!accessToken) {
        // 优先展示真实业务错误；全是 404 时才回落到第一条，避免「最后一个域名 404」误导排查
        const real = errs.find((s) => !/HTTP 404/.test(s));
        // 20405 Device proof required：Trae 给授权码兑换加了设备证明（客户端私钥/证书），
        // 浏览器 OAuth 这条路已经走不通，别让用户对着 401 反复重试。
        if (/20405|Device proof required/i.test(real || '')) {
          throw new Error('Trae 已启用设备证明（20405），浏览器授权这条路已不可用。请在 Trae 客户端登录后重试，或用「配置 Token」粘贴 JWT。');
        }
        throw new Error(`Trae AuthCode 兑换失败: ${real || errs[0] || '无响应'}`);
      }
    }
    if (!accessToken) throw new Error('回调链接缺少可用参数（refreshToken / authCodeInfo / userJwt）');
  } else {
    accessToken = input.replace(/^(Cloud-IDE-JWT|Bearer)\s+/i, '').trim();
  }
  const targetFile = join(entry.targetHome, '.trae-cn', 'trae-jwt-token');
  await mkdir(dirname(targetFile), { recursive: true });
  await writeFile(targetFile, accessToken + '\n', { mode: 0o600 });
  entry.buf += `[OAuth] ✓ Trae 凭据已写入 ${targetFile}\n`;
  const acc = await finalizeLoginAccount(entry, preferredName);
  const accName = acc?.name || entry.savedAccountName || '';
  clearQuotaCache('traecode');
  cleanupSessionResources(entry);
  entry.code = 0;
  entry.exited = true;
  return {
    ok: true,
    worker: 'traecode',
    accountName: accName,
    note: accName ? `Trae 认证成功，已自动添加并切换至账号「${accName}」` : 'Trae 凭据已保存并生效',
  };
}

async function saveZcodeOAuthResult(targetHome, provider, tokenData) {
  const credFile = join(targetHome, '.zcode', 'v2', 'credentials.json');
  await mkdir(dirname(credFile), { recursive: true });
  let existing = {};
  try { existing = JSON.parse(await readFile(credFile, 'utf-8')); } catch { existing = {}; }
  const prov = provider === 'zai' ? 'zai' : 'bigmodel';
  existing['oauth:active_provider'] = encryptZcodeCred(prov);
  if (tokenData.accessToken) {
    existing[`oauth:${prov}:access_token`] = encryptZcodeCred(tokenData.accessToken);
  }
  if (tokenData.refreshToken) {
    existing[`oauth:${prov}:refresh_token`] = encryptZcodeCred(tokenData.refreshToken);
  }
  if (tokenData.zcodeJwtToken) {
    existing['zcodejwttoken'] = encryptZcodeCred(tokenData.zcodeJwtToken);
  }
  if (tokenData.userInfo) {
    existing[`oauth:${prov}:user_info`] = encryptZcodeCred(JSON.stringify(tokenData.userInfo));
  }
  if (tokenData.apiKey) {
    const uid = tokenData.userInfo?.id || 'default';
    existing[`account-provider:coding-plan:account:${prov}-individual-coding-plan:account:${uid}:api-key`] = encryptZcodeCred(tokenData.apiKey);
  }
  await writeFile(credFile, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });
  clearQuotaCache('zcode');
}

// ---------------------------------------------------------------- CodeBuddy 官方 state→token 完成兑换
// 与官方 CLI（codebuddy-headless.js AccountScopedAuth）对齐：
//   POST {endpoint}/v2/plugin/auth/state?platform=CLI   → authUrl + state
//   GET  {endpoint}/v2/plugin/auth/token?state=<state>  → 轮询直到 accessToken 可用
//   GET  {endpoint}/v2/plugin/account                   → Bearer 换取账号信息（uid/nickname/phone）
const CODEBUDDY_AUTH_ENDPOINTS = {
  'codebuddy': 'https://www.codebuddy.ai',
  'codebuddy-cn': 'https://copilot.tencent.com',
};

async function fetchCodeBuddyAuthByState(worker, state, maxAttempts = 20, intervalMs = 3000, shouldAbort = null) {
  const base = CODEBUDDY_AUTH_ENDPOINTS[worker] || CODEBUDDY_AUTH_ENDPOINTS.codebuddy;
  const headers = {
    Accept: 'application/json',
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
  };
  let lastErr = '无响应';
  for (let i = 0; i < maxAttempts; i += 1) {
    if (typeof shouldAbort === 'function' && shouldAbort()) {
      throw new Error('登录会话已结束或已取消');
    }
    try {
      const r = await fetchJsonSmart(`${base}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, { headers }, 10_000);
      const data = r.json?.data?.data ?? r.json?.data ?? null;
      if (data && (data.accessToken || data.access_token)) {
        const now = Date.now();
        const auth = { ...data, lastRefreshTime: now };
        if (data.expiresIn && !data.expiresAt) auth.expiresAt = now + Number(data.expiresIn) * 1000;
        if (data.refreshExpiresIn && !data.refreshExpiresAt) auth.refreshExpiresAt = now + Number(data.refreshExpiresIn) * 1000;
        // 再取账号信息（uid/nickname/phone），失败不阻塞登录
        let account = null;
        try {
          const ar = await fetchJsonSmart(`${base}/v2/plugin/account`, {
            headers: { Accept: 'application/json', Authorization: `Bearer ${data.accessToken || data.access_token}` },
          }, 10_000);
          account = ar.json?.data?.data ?? ar.json?.data ?? null;
        } catch { /* ignore */ }
        return { auth, account };
      }
      lastErr = r.json?.msg || r.json?.message || `HTTP ${r.status}`;
    } catch (err) {
      lastErr = err.message;
    }
    await new Promise((r) => { const t = setTimeout(r, intervalMs); t.unref?.(); });
  }
  throw new Error(`CodeBuddy 官方 token 兑换未完成（${lastErr}）`);
}

/** 从 ACP authenticate 结果里的 userinfo 提取账号对象（落盘身份兜底） */
function codeBuddyAccountFromHint(hint) {
  if (!hint || typeof hint !== 'object') return null;
  const uid = String(hint.userId || hint.uid || '').trim();
  const nick = String(hint.userNickname || hint.userName || hint.nickname || '').trim();
  if (!uid && !nick) return null;
  return { uid, nickname: nick, userName: String(hint.userName || nick) };
}

/** 粘贴 /started 成功页链接时：提取 state 直接向官方完成兑换并落盘归档（短轮询，长等待交给后台 watchdog） */
async function completeCodeBuddyByState(e, state, prefName) {
  e.buf += `\n[CodeBuddy] 检测到 started 授权完成页链接，正在用 state 向官方服务换取凭据…\n`;
  let result;
  try {
    result = await fetchCodeBuddyAuthByState(e.worker, state, 3, 2000, () => e.exited);
  } catch (err) {
    return { ok: false, worker: e.worker, error: `${err.message}。授权若已完成，后台会持续自动检测并收口；也可稍后点击「我已完成授权」重试` };
  }
  const dirName = e.worker === 'codebuddy-cn' ? '.codebuddy-cn' : '.codebuddy';
  const authInfoFile = join(e.targetHome, dirName, 'auth.info');
  await mkdir(dirname(authInfoFile), { recursive: true });
  const account = result.account || codeBuddyAccountFromHint(e.cbUserInfo);
  const payload = {
    ...(account ? { account, accounts: [account], allAccounts: [account] } : {}),
    auth: result.auth,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(authInfoFile, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  e.buf += `[CodeBuddy] ✓ 官方凭据已换取并写入 ${authInfoFile}\n`;
  const acc = await finalizeLoginAccount(e, prefName);
  if (acc && acc.ok === false) return { ok: false, worker: e.worker, error: acc.error || '凭据归档失败，请重试' };
  const accName = acc?.name || e.savedAccountName || '';
  clearQuotaCache(e.worker);
  cleanupSessionResources(e);
  e.code = 0;
  e.exited = true;
  return {
    ok: true,
    worker: e.worker,
    accountName: accName,
    note: accName ? `${e.worker} 认证成功，已自动添加并切换至账号「${accName}」` : `${e.worker} 凭据已保存并生效`,
  };
}

/**
 * ACP 授权链接到达后启动的后台兜底轮询：官方 CLI 的 loopGetToken 在部分网络环境下会卡住，
 * 这里用同一 state 并行向官方轮询，拿到 token 后自行落盘并完成会话（与 CLI 完成路径互斥）。
 */
function startCodeBuddyCompletionWatchdog(e, state) {
  if (!state || e.cbWatchdog) return;
  e.cbWatchdog = true;
  (async () => {
    try {
      const result = await fetchCodeBuddyAuthByState(e.worker, state, 170, 3000, () => e.exited);
      if (e.exited) return; // CLI 已完成或已取消，无需兜底
      e.buf += `\n[CodeBuddy] ✓ 后台兜底轮询拿到官方凭据（CLI 未完成，由 Hub 直接完成）\n`;
      const dirName = e.worker === 'codebuddy-cn' ? '.codebuddy-cn' : '.codebuddy';
      const authInfoFile = join(e.targetHome, dirName, 'auth.info');
      await mkdir(dirname(authInfoFile), { recursive: true });
      const payload = {
        ...(result.account ? { account: result.account, accounts: [result.account], allAccounts: [result.account] } : {}),
        auth: result.auth,
        updatedAt: new Date().toISOString(),
      };
      await writeFile(authInfoFile, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
      await finalizeLoginAccount(e);
      e.exited = true;
      e.code = 0;
      clearQuotaCache(e.worker);
      cleanupSessionResources(e);
    } catch { /* 超时或取消放弃：用户仍可粘贴 started 链接手动兑换 */ }
  })();
}

function launchWorkerSession(worker, { sandbox = null, name = null, region = '' } = {}) {
  const spec = LOGIN_COMMANDS[worker];
  if (!spec) return { ok: false, error: `不支持的 worker: ${worker}` };
  // 启动新登录前自动将当前已生效凭据归档保存，避免新账号登录覆盖丢失原账号
  autoSyncLiveAccount(worker).catch(() => {});
  // 统一使用独立沙箱目录承接新登录凭据，确保中途取消或未完成授权时绝不污染现有生效账号
  const safeDirName = String(name || 'oauth').replace(/[^\p{L}\p{N}._-]/gu, '_');
  const effectiveSandbox = sandbox || join(HOME, '.agenthub', 'sandbox', `${worker}-${safeDirName}-${Date.now()}`);
  mkdirSync(effectiveSandbox, { recursive: true });
  const targetHome = effectiveSandbox;
  const id = `${sandbox ? 'add' : 'login'}-${Date.now()}-${++seq}`;
  /** @type {any} */
  const entry = {
    id,
    worker,
    name: name || null,
    region: region || null,
    sandbox: effectiveSandbox,
    targetHome,
    mode: spec.mode,
    note: spec.note,
    callbackHint: spec.callbackHint || '',
    needsCallbackInput: !!spec.needsCallbackInput,
    authUrl: null,
    secondaryUrl: null,
    deviceCode: null,
    savedAccountName: null,
    inflightCallback: null,
    proc: null,
    server: null,
    pollTimer: null,
    timeoutTimer: null,
    buf: '',
    exited: false,
    code: null,
    startedAt: Date.now(),
  };
  sessions.set(id, entry);

  // 20 分钟兜底超时回收
  // Trae / 华为云这类要走「浏览器登录 + 复制回调」的流程，10 分钟经常不够：
  // 用户去翻账号密码、过二次验证、再切回控制台粘贴，很容易超时重来。
  entry.timeoutTimer = setTimeout(() => {
    if (!entry.exited) {
      entry.buf += '\n[timeout] 登录会话已超时（20 分钟）\n';
      entry.exited = true;
      entry.code = -1;
      cleanupSessionResources(entry);
    }
  }, 1_200_000);
  entry.timeoutTimer.unref?.();

  // ---------------- 分支 1：Python PTY 设备码流 (minimaxcode / github-copilot)
  if (spec.mode === 'pty_device' && spec.cmd) {
    const cleanEnv = { ...process.env, HOME: targetHome, DISPLAY: '', BROWSER: 'echo', TERM: 'xterm-256color', NO_COLOR: '1' };
    delete cleanEnv.CI;
    const ptyScript = [
      'import os, pty, select, signal, sys',
      'pid, fd = pty.fork()',
      'if pid == 0:',
      '    os.execvp(sys.argv[1], sys.argv[1:])',
      'def _forward(sig, _frame):',
      '    try: os.kill(pid, sig)',
      '    except OSError: pass',
      'for _s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):',
      '    signal.signal(_s, _forward)',
      'try:',
      '    while True:',
      '        ready, _, _ = select.select([fd, 0], [], [], 1.0)',
      '        if fd in ready:',
      '            try:',
      '                data = os.read(fd, 4096)',
      '            except OSError:',
      '                break',
      '            if not data: break',
      '            os.write(1, data)',
      '        if 0 in ready:',
      '            try:',
      '                typed = os.read(0, 1024)',
      '            except OSError:',
      '                typed = b""',
      '            if typed:',
      '                try: os.write(fd, typed)',
      '                except OSError: pass',
      'finally:',
      '    try: os.close(fd)',
      '    except OSError: pass',
      '    _, status = os.waitpid(pid, 0)',
      '    sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)',
    ].join('\n');
    const ownGroup = process.platform !== 'win32';
    const child = spawn('python3', ['-c', ptyScript, ...spec.cmd], {
      cwd: targetHome,
      env: cleanEnv,
      detached: ownGroup,
    });
    entry.proc = child;
    entry.ownGroup = ownGroup;
    child.stdout.on('data', (d) => { entry.buf += d.toString(); trim(entry); });
    child.stderr.on('data', (d) => { entry.buf += d.toString(); trim(entry); });
    // cline auth 先显示「Sign in with Cline / ClinePass / ChatGPT / 自带 Key」菜单，默认项即账号登录。
    // TUI 进入原始模式的时机不定，单次回车可能落在初始化前，所以按条件重试几次。
    if (spec.ptyAutoEnter) {
      const alreadyMoved = () => /Signing in|Your code|authkit\.cline|device\?user_code/i.test(stripAnsi(entry.buf));
      [2500, 5000, 8000].forEach((delay) => {
        const timer = setTimeout(() => {
          if (alreadyMoved() || entry.exited) return;
          try { child.stdin?.write('\r'); } catch { /* 子进程已退出 */ }
        }, delay);
        timer.unref?.();
      });
    }
    child.on('exit', async (code) => {
      if (worker === 'github-copilot' && code === 0) {
        try {
          const { stdout } = await execFile('python3', [SECRET_HELPER, 'copilot-cli', 'https://github.com'], { timeout: 6000 });
          const tok = String(stdout || '').trim();
          if (tok) {
            const mirror = join(targetHome, '.config', 'github-copilot', 'copilot-token');
            await mkdir(dirname(mirror), { recursive: true });
            await writeFile(mirror, tok, { mode: 0o600 });
          }
        } catch { /* ignore */ }
      }
      if (code === 0) {
        // MiniMax：官方不落盘账户名，注入用户备注名到 oauth.account（官方保留字段）后再归档
        if (worker === 'minimaxcode') await injectMinimaxAccountName(targetHome, entry.name);
        await finalizeLoginAccount(entry);
      }
      entry.exited = true;
      entry.code = code;
      clearQuotaCache(worker);
      cleanupSessionResources(entry);
    });
    child.on('error', (e) => {
      entry.buf += `\n[spawn-error] ${e.message}\n`;
      entry.exited = true;
      entry.code = -1;
      cleanupSessionResources(entry);
    });
    return { ok: true, loginId: id, worker, name, sandbox, mode: spec.mode, note: spec.note, callbackHint: spec.callbackHint };
  }

  // ---------------- 分支 2：CodeBuddy / CodeBuddy-CN 官方 ACP JSON-RPC OAuth 流
  if (spec.mode === 'acp_oauth' && spec.cmd) {
    const cfgDirName = worker === 'codebuddy-cn' ? '.codebuddy-cn' : '.codebuddy';
    const cfgDir = join(targetHome, cfgDirName);
    mkdirSync(cfgDir, { recursive: true });
    const envMode = spec.acpEnv || (worker === 'codebuddy-cn' ? 'internal' : 'external');
    const child = spawn(spec.cmd[0], spec.cmd.slice(1), {
      cwd: targetHome,
      env: {
        ...process.env,
        HOME: targetHome,
        DISPLAY: '',
        BROWSER: 'echo',
        CODEBUDDY_CONFIG_DIR: cfgDir,
        CODEBUDDY_INTERNET_ENVIRONMENT: envMode,
      },
    });
    entry.proc = child;
    entry.buf = `[ACP] 正在请求 ${worker} (${envMode}) OAuth 授权链接…\n`;
    let lineBuf = '';
    child.stdout.on('data', async (chunk) => {
      const text = chunk.toString();
      lineBuf += text;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.method === '_codebuddy.ai/authUrl' && msg.params?.authUrl) {
            entry.authUrl = msg.params.authUrl;
            entry.buf += `[ACP] 已获取 OAuth 授权链接:\n${msg.params.authUrl}\n请在浏览器打开该链接完成登录授权，系统正在自动等待回调…\n`;
            // 授权链接内含 state：启动后台兜底轮询（CLI 的 loopGetToken 卡住时由 Hub 直接完成兑换）
            try {
              const st = new URL(msg.params.authUrl).searchParams.get('state')
                || new URL(msg.params.authUrl).searchParams.get('stateId') || '';
              if (st) {
                entry.cbState = st;
                startCodeBuddyCompletionWatchdog(entry, st);
              }
            } catch { /* ignore */ }
          } else if (msg.id === 2 && (msg.result !== undefined || msg.error)) {
            if (msg.error) {
              entry.buf += `[ACP] 授权返回错误: ${JSON.stringify(msg.error)}\n`;
            } else {
              if (msg.result) entry.buf += `[ACP] 授权返回: ${JSON.stringify(msg.result).slice(0, 400)}\n`;
              // ACP 结果里直接带账号信息（userId/userName/userNickname），留作归档身份兜底
              const uiHint = msg.result?._meta?.['codebuddy.ai/userinfo'] || msg.result?.userinfo || null;
              if (uiHint) entry.cbUserInfo = uiHint;
              const authFile = join(cfgDir, 'auth.info');
              // 轮询等待真实凭据落盘（最长 25s）：优先 legacy auth.info，其次新版 CLI 的 XDG 共享会话存储
              let ready = false;
              for (let i = 0; i < 125; i += 1) {
                try {
                  const d = JSON.parse((await readFile(authFile, 'utf-8')).replace(/^\uFEFF/, ''));
                  const tok = String(d?.auth?.accessToken || '').trim();
                  if (tok && !tok.startsWith('http')) { ready = true; break; }
                } catch { /* 尚未落盘 */ }
                // 新版 CLI（≥2.164）写入 ~/.local/share/CodeBuddyExtension/.../auth/*.info（随 HOME，不随 CONFIG_DIR）
                const shared = await findCodeBuddySharedAuth(targetHome);
                if (shared) {
                  const payload = { ...shared.data };
                  if (!payload.allAccounts && payload.account) payload.allAccounts = [payload.account];
                  payload.updatedAt = payload.updatedAt || new Date().toISOString();
                  await mkdir(dirname(authFile), { recursive: true });
                  await writeFile(authFile, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
                  entry.buf += `[ACP] ✓ 检测到官方共享会话存储，已镜像为 ${authFile}\n`;
                  ready = true;
                  break;
                }
                await new Promise((r) => setTimeout(r, 200));
              }
              if (!ready && entry.cbState) {
                // 最后兜底：直接用 state 向官方兑换（CLI 轮询卡死时）
                try {
                  entry.buf += `[ACP] CLI 未落盘，改用 state 向官方服务直接兑换…\n`;
                  const result = await fetchCodeBuddyAuthByState(worker, entry.cbState, 4, 2000);
                  const acctFromApi = result.account || codeBuddyAccountFromHint(entry.cbUserInfo);
                  const payload = {
                    ...(acctFromApi ? { account: acctFromApi, accounts: [acctFromApi], allAccounts: [acctFromApi] } : {}),
                    auth: result.auth,
                    updatedAt: new Date().toISOString(),
                  };
                  await mkdir(dirname(authFile), { recursive: true });
                  await writeFile(authFile, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
                  ready = true;
                } catch { /* 交给后台 watchdog 继续 */ }
              }
              if (ready) {
                entry.buf += `[ACP] ✓ 授权成功！凭据已写入 ${authFile}\n`;
                await finalizeLoginAccount(entry);
                entry.exited = true;
                entry.code = 0;
                clearQuotaCache(worker);
                cleanupSessionResources(entry);
              } else {
                entry.buf += `[ACP] ⚠️ 授权已返回成功但暂未检测到落盘凭据，后台仍在自动检测；也可稍后点击「我已完成授权」重新检测\n`;
              }
            }
          }
        } catch {
          entry.buf += trimmed + '\n';
        }
      }
      trim(entry);
    });
    child.stderr.on('data', (d) => { entry.buf += d.toString(); trim(entry); });
    child.on('exit', async (code) => {
      if (!entry.exited) {
        if (code === 0) await finalizeLoginAccount(entry);
        entry.exited = true;
        entry.code = code;
        clearQuotaCache(worker);
        cleanupSessionResources(entry);
      }
    });
    try {
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'agenthub-webui-login', version: '1.0' } },
      }) + '\n');
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'authenticate',
        params: { methodId: envMode },
      }) + '\n');
    } catch (e) {
      entry.buf += `[ACP-write-error] ${e.message}\n`;
    }
    return { ok: true, loginId: id, worker, name, sandbox, mode: spec.mode, note: spec.note, callbackHint: spec.callbackHint };
  }

  // ---------------- 分支 3：Antigravity 官方 Google OAuth 2.0 授权流
  if (spec.mode === 'google_oauth') {
    const state = randomBytes(16).toString('hex');
    entry.oauthState = state;
    const srv = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url || '/', 'http://localhost');
        if (u.pathname === '/oauth-callback' || u.pathname === '/callback') {
          const code = u.searchParams.get('code');
          if (code) {
            await exchangeAntigravityCode(entry, code);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<!doctype html><meta charset="utf-8"><title>Antigravity 授权成功</title><body style="font-family:system-ui;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center;padding:32px;border:1px solid #30363d;border-radius:12px;background:#161b22"><h2 style="color:#3fb950">✓ Antigravity Google OAuth 授权成功</h2><p>凭据已自动写入 Multi-Agent Hub，您可以关闭此页面。</p></div></body>');
            return;
          }
        }
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Missing code parameter');
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`OAuth callback error: ${err.message}`);
      }
    });
    entry.server = srv;
    const setupUrl = (port) => {
      const redirectUri = `http://localhost:${port}/oauth-callback`;
      entry.redirectUri = redirectUri;
      const qs = new URLSearchParams({
        client_id: ANTIGRAVITY_OAUTH.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: ANTIGRAVITY_OAUTH.scopes.join(' '),
        state,
        access_type: 'offline',
        prompt: 'consent',
      });
      entry.authUrl = `${ANTIGRAVITY_OAUTH.authorizeUrl}?${qs.toString()}`;
      entry.buf = `[Google OAuth] 已生成 Antigravity 授权链接（回调端口 ${port}）：\n${entry.authUrl}\n\n提示：若您在远程电脑浏览器打开，Google 授权后会跳转到 http://localhost:${port}/oauth-callback?code=...（页面提示无法访问属正常现象），请直接复制浏览器地址栏完整 URL 粘贴到下方输入框完成认证。\n`;
    };
    srv.on('error', () => {
      // 若 20128 被占用则回退随机端口，或直接生成 20128 链接供手动粘贴回调 URL
      setupUrl(ANTIGRAVITY_OAUTH.defaultPort);
    });
    srv.listen(ANTIGRAVITY_OAUTH.defaultPort, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : ANTIGRAVITY_OAUTH.defaultPort;
      setupUrl(port);
    });
    return { ok: true, loginId: id, worker, name, sandbox, mode: spec.mode, note: spec.note, callbackHint: spec.callbackHint, needsCallbackInput: true };
  }

  // ---------------- 分支 4：Xiaomi MiMo (mimocode) 官方 X25519 + AES-256-GCM OAuth 授权流
  if (spec.mode === 'mimo_oauth') {
    const kp = generateKeyPairSync('x25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const publicKey = Buffer.from(kp.publicKey).toString('base64url');
    entry.mimoPrivateKeyDer = kp.privateKey;
    const keyName = getMimoKeyName(targetHome);
    const codeCallbackUri = `${MIMO_PLATFORM_URL}/authorize/code/callback`;
    const qs = new URLSearchParams({
      pk: publicKey,
      redirect_uri: codeCallbackUri,
      kn: 'mimocode',
      key_name: keyName,
    });
    entry.authUrl = `${MIMO_PLATFORM_URL}/authorize?${qs.toString()}`;
    entry.buf = `[Xiaomi MiMo OAuth] 已生成 X25519 加密授权链接 (key_name=${keyName})：\n${entry.authUrl}\n\n请在浏览器中打开上方链接登录小米账号并确认授权，然后将页面显示的授权 Code（或回调 URL / API Key）粘贴到下方输入框并点击「提交完成认证」。\n`;
    return { ok: true, loginId: id, worker, name, sandbox, mode: spec.mode, url: entry.authUrl, note: spec.note, callbackHint: spec.callbackHint, needsCallbackInput: true };
  }

  // ---------------- 分支 5：TraeCode 官方 GetLoginGuidance + PKCE + ExchangeToken OAuth 流
  if (spec.mode === 'trae_oauth') {
    const traceId = randomUUID();
    entry.traeTraceId = traceId;
    // Trae IDE 登录强制 PKCE（S256），缺失 code_challenge 会导致授权页报错（即"链接有误"根因）
    const codeVerifier = randomBytes(48).toString('base64url');
    entry.traeCodeVerifier = codeVerifier;
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const srv = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url || '/', 'http://127.0.0.1');
        if (u.pathname === '/authorize' || u.pathname === '/callback' || u.pathname === '/auth/callback') {
          await exchangeTraeCallback(entry, `${u.pathname}?${u.searchParams.toString()}`);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><meta charset="utf-8"><title>Trae 授权成功</title><body style="font-family:system-ui;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center;padding:32px;border:1px solid #30363d;border-radius:12px;background:#161b22"><h2 style="color:#3fb950">✓ Trae OAuth 授权成功</h2><p>凭据已自动写入 Multi-Agent Hub，您可以关闭此页面。</p></div></body>');
          return;
        }
        res.writeHead(404); res.end('Not found');
      } catch (err) {
        res.writeHead(500); res.end(`Trae OAuth Error: ${err.message}`);
      }
    });
    entry.server = srv;
    const buildTraeUrl = (host, callbackUrl) => {
      const u = new URL(host.startsWith('http') ? host : `https://${host.replace(/^\/+/, '')}`);
      u.pathname = '/authorization';
      const machineId = randomUUID();
      const qs = new URLSearchParams({
        login_version: '1',
        auth_from: 'trae',
        login_channel: 'native_ide',
        plugin_version: TRAE_OAUTH.defaultAppVersion,
        auth_type: 'local',
        client_id: TRAE_OAUTH.clientId,
        redirect: '0',
        login_trace_id: traceId,
        auth_callback_url: callbackUrl,
        machine_id: machineId,
        device_id: '0',
        x_device_id: '0',
        x_machine_id: machineId,
        x_device_brand: 'unknown',
        x_device_type: 'unknown',
        x_os_version: 'unknown',
        x_env: '',
        x_app_version: TRAE_OAUTH.defaultAppVersion,
        x_app_type: 'stable',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      u.search = qs.toString();
      return u.toString();
    };
    srv.listen(0, '127.0.0.1', async () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 38911;
      // 与 Trae IDE 一致使用 /authorize 作为回调路径
      const callbackUrl = `http://127.0.0.1:${port}/authorize`;
      entry.redirectUri = callbackUrl;
      // 通过官方 GetLoginGuidance 动态探测登录主机，失败回退默认域名
      const [cnHost, intlHost] = await Promise.all([
        fetchTraeLoginHost(TRAE_OAUTH.guidanceUrlsCn, 'www.trae.cn'),
        fetchTraeLoginHost(TRAE_OAUTH.guidanceUrlsIntl, 'www.trae.ai'),
      ]);
      entry.authUrl = buildTraeUrl(cnHost, callbackUrl);
      entry.secondaryUrl = buildTraeUrl(intlHost, callbackUrl);
      entry.buf = `[Trae OAuth] 已生成 Trae 国内版与国际版 OAuth 授权链接（已启用 PKCE，登录主机由 GetLoginGuidance 探测：${cnHost} / ${intlHost}，回调 ${callbackUrl}）：\n国内版 (${cnHost}): ${entry.authUrl}\n国际版 (${intlHost}): ${entry.secondaryUrl}\n\n在浏览器完成登录后，浏览器会跳转到 http://127.0.0.1:${port}/authorize?...（若您不在服务器本机打开会提示无法连接，属正常现象），请复制地址栏完整链接粘贴到下方输入框并点击「提交完成认证」。\n`;
    });
    return { ok: true, loginId: id, worker, name, sandbox, mode: spec.mode, note: spec.note, callbackHint: spec.callbackHint, needsCallbackInput: true };
  }

  // ---------------- 分支 6：ZCode 官方 CLI Polling OAuth 流 (bigmodel 国内版 / zai 国际版)
  if (spec.mode === 'zcode_oauth') {
    const provider = zcodeProviderOf(entry.region);
    entry.zcodeProvider = provider;
    const regionLabel = provider === 'zai' ? '国际版 Z.ai' : '国内版 智谱 BigModel';
    const pollToken = randomBytes(32).toString('hex');
    entry.zcodePollToken = pollToken;
    entry.buf = `[ZCode OAuth] 正在初始化 ${regionLabel} 官方 OAuth 会话…\n`;
    (async () => {
      try {
        const res = await fetchJsonSmart(ZCODE_OAUTH.initUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${pollToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider }),
        }, 12_000);
        const data = res.json?.data;
        if (!res.ok || res.json?.code !== 0 || !data?.flow_id || !data?.authorize_url) {
          throw new Error(res.json?.msg || `HTTP ${res.status}`);
        }
        entry.zcodeFlowId = data.flow_id;
        entry.authUrl = data.authorize_url;
        const u = new URL(data.authorize_url);
        entry.oauthState = u.searchParams.get('state') || '';
        const intervalMs = Math.max(3000, (Number(data.poll_interval_sec) || 3) * 1000);
        entry.buf += `[ZCode OAuth] 已获取 ${regionLabel} 官方授权链接：\n${entry.authUrl}\n正在后台每 ${intervalMs / 1000}s 自动轮询授权状态…\n`;
        entry.pollTimer = setInterval(async () => {
          if (entry.exited) return;
          try {
            const pr = await fetchJsonSmart(`${ZCODE_OAUTH.pollBaseUrl}/${encodeURIComponent(data.flow_id)}`, {
              headers: { Authorization: `Bearer ${pollToken}` },
            }, 10_000);
            const pd = pr.json?.data;
            if (pr.json?.code === 0 && pd?.status === 'ready') {
              const bm = pd[provider] || pd.bigmodel || pd.zai || {};
              const accessToken = bm.access_token || bm.accessToken || '';
              const refreshToken = bm.refresh_token || bm.refreshToken || '';
              const zcodeJwtToken = pd.token || '';
              const usr = pd.user || {};
              const userInfo = {
                id: String(usr.user_id || usr.id || 'unknown'),
                username: String(usr.name || usr.email || usr.user_id || 'user'),
                displayName: String(usr.name || usr.email || usr.user_id || 'user'),
                rawProfile: { ...usr, zcodeProfileSchemaVersion: 2 },
              };
              await saveZcodeOAuthResult(targetHome, provider, { accessToken, refreshToken, zcodeJwtToken, userInfo });
              entry.buf += `\n[ZCode OAuth] ✓ ${regionLabel} 授权成功！账号 ${userInfo.username} 已加密写入 ${join(targetHome, '.zcode/v2/credentials.json')}\n`;
              await finalizeLoginAccount(entry);
              entry.exited = true;
              entry.code = 0;
              cleanupSessionResources(entry);
            } else if (pd?.status === 'failed') {
              entry.buf += `\n[ZCode OAuth] 授权失败，请重试或在下方粘贴 API Key。\n`;
              entry.exited = true;
              entry.code = 1;
              cleanupSessionResources(entry);
            }
          } catch { /* ignore transient poll errors */ }
        }, intervalMs);
        entry.pollTimer.unref?.();
      } catch (e) {
        entry.authUrl = provider === 'zai'
          ? 'https://z.ai/manage-apikey/apikey-list'
          : 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys';
        entry.needsCallbackInput = true;
        entry.buf += `[ZCode OAuth] 在线初始化提示 (${e.message})，您可点击上方链接获取 ${regionLabel} API Key 并粘贴到下方输入框直接保存。\n`;
      }
    })();
    return { ok: true, loginId: id, worker, name, sandbox, mode: spec.mode, note: spec.note, callbackHint: spec.callbackHint };
  }

  // ---------------- 分支 7：CodeArts 华为云 AK/SK WebUI 认证流
  if (spec.mode === 'codearts_aksk') {
    entry.authUrl = 'https://console.huaweicloud.com/iam/?#/mine/accessKey';
    entry.buf = `[CodeArts] 请点击上方链接前往华为云 IAM 控制台 ->「我的凭证 > 访问密钥」创建或查看 AK/SK，并在下方输入框提交。\n`;
    return { ok: true, loginId: id, worker, name, sandbox, mode: spec.mode, url: entry.authUrl, note: spec.note, callbackHint: spec.callbackHint, needsCallbackInput: true };
  }

  // ---------------- 分支 8：opencode / cline 的 provider + API Key 认证流
  if (spec.mode === 'opencode_key' || spec.mode === 'cline_key') {
    if (spec.mode === 'opencode_key') {
      entry.authUrl = 'https://opencode.ai/docs/providers';
      entry.buf = '[opencode] 直接粘贴 API Key 并提交即可（不校验格式）。带前缀写成 provider:api_key 会原样采用；裸 Key 自动识别：oc_sk_ → opencode、sk-ant- → anthropic、sk-or-v1- → openrouter，识别不出按 opencode 写入。后端写入 auth.json 后用 opencode auth list 复核。\n';
    } else {
      entry.authUrl = 'https://app.cline.bot/';
      entry.buf = '[cline] 直接粘贴 API Key 并提交即可（不校验格式）；需要指定厂商/模型时再写 provider|model|api_key|base_url。后端执行 cline auth 非交互写入。\n';
    }
    return { ok: true, loginId: id, worker, name, sandbox, mode: spec.mode, url: entry.authUrl, note: spec.note, callbackHint: spec.callbackHint, needsCallbackInput: true };
  }

  return { ok: false, error: `未知的登录模式: ${spec.mode}` };
}

export function startLogin(worker, name = '', opts = {}) {
  return launchWorkerSession(worker, { name: name || null, region: opts.region || '' });
}

/** 沙箱添加账号：以隔离 HOME 启动登录流程，授权后凭据落在沙箱内，供快照成档案 */
export function startLoginSandbox(worker, name) {
  const safeDirName = String(name || 'auto').replace(/[^\p{L}\p{N}._-]/gu, '_');
  const sandbox = join(HOME, '.agenthub', 'sandbox', `${worker}-${safeDirName}-${Date.now()}`);
  return launchWorkerSession(worker, { sandbox, name: name || null });
}

/** 取登录会话的沙箱目录（供 addFromSandbox 快照） */
export function getSandbox(loginId) {
  const e = sessions.get(loginId);
  return e ? e.sandbox : null;
}

const URL_RE = /https?:\/\/[^\s"'<>)\x1b]+/g;

export function pollLogin(loginId) {
  const e = sessions.get(loginId);
  if (!e) return { ok: false, error: '登录会话不存在或已过期' };
  const cleanOut = stripAnsi(e.buf);
  const urls = cleanOut.match(URL_RE) || [];
  const deviceMatch = cleanOut.match(/(?:code|设备码)[:：\s]+([A-Z0-9]{4,8}-[A-Z0-9]{4,8})/i)
    || cleanOut.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
  // TUI 在链接后面紧贴边框字符（│ ─ ╯ …），URL_RE 会把它们一起吃掉，这里在第一个边框字符处截断
  const needsUrl = (u) => u ? u.split(/[│┃┌┐└┘├┤┬┴┼─╭╮╰╯]/)[0].trim() : u;
  const extractedUrl = urls.map(needsUrl).find((u) => /auth|oauth|login|device|token|authorize|iam/i.test(u)) || null;
  return {
    ok: true,
    worker: e.worker,
    mode: e.mode,
    region: e.region || null,
    output: cleanOut.slice(-1600),
    url: needsUrl(e.authUrl) || extractedUrl,
    secondaryUrl: e.secondaryUrl || null,
    deviceCode: e.deviceCode || (deviceMatch ? deviceMatch[1] : null),
    needsCallbackInput: !!e.needsCallbackInput,
    callbackHint: e.callbackHint || '',
    accountName: e.savedAccountName || null,
    apiKeyOnly: !!e.apiKeyOnly,
    exited: e.exited,
    exitCode: e.code,
  };
}

/**
 * WebUI 提交回调 URL / 授权码 / API Key / TUI 交互输入
 * @param {string} loginId
 * @param {string} rawInput
 * @param {{ ak?: string, sk?: string, accountName?: string }} [extra]
 */
export async function submitLoginCallback(loginId, rawInput, extra = {}) {
  const e = sessions.get(loginId);
  if (!e) return { ok: false, error: '登录会话不存在或已过期，请重新点击登录' };
  if (extra.accountName) e.name = String(extra.accountName).trim();

  // Singleflight：同一登录会话若正在执行回调兑换，直接复用 Promise，防止双击/并发提交单次授权码
  if (e.inflightCallback) {
    return await e.inflightCallback;
  }

  const runCallback = async () => {
    const input = String(rawInput || '').trim();
    const prefName = String(extra.accountName || e.name || '').trim();
    try {
      // 1. Antigravity: Google OAuth 回调 URL 或 code
      if (e.worker === 'antigravity') {
        return await exchangeAntigravityCode(e, input, prefName);
      }

      // 2. MiMoCode: 小米 MiMo 加密授权码 u / 回调链接（入账号库）/ 直接 API Key（仅通道配置，不入账号库）
      if (e.worker === 'mimocode') {
        if (!input) return { ok: false, error: '请粘贴小米 MiMo 授权 Code、回调链接或 API Key' };
        if (/^sk-[A-Za-z0-9_-]{12,}$/.test(input)) {
          // API Key 是通道配置而非账号身份：先归档保护当前生效凭据，再直接合并进线上配置，
          // 不触发账号归档，避免「自添加 API Key 被当作账号加入列表」
          try { await autoSyncLiveAccount('mimocode'); } catch { /* ignore */ }
          const liveFile = join(HOME, '.local', 'share', 'mimocode', 'auth.json');
          await mkdir(dirname(liveFile), { recursive: true });
          let liveData = {};
          try { liveData = JSON.parse((await readFile(liveFile, 'utf-8')).replace(/^\uFEFF/, '')); } catch { liveData = {}; }
          liveData.xiaomi = { type: 'api', key: input };
          await writeFile(liveFile, JSON.stringify(liveData, null, 2) + '\n', { mode: 0o600 });
          e.apiKeyOnly = true;
          e.buf += `\n[MiMo] ✓ API Key 已直接写入 ${liveFile}（通道配置，不加入账号列表）\n`;
          clearQuotaCache('mimocode');
          cleanupSessionResources(e);
          e.code = 0;
          e.exited = true;
          return {
            ok: true,
            worker: 'mimocode',
            accountName: null,
            apiKeyOnly: true,
            note: 'MiMo API Key 已更新并立即生效（作为通道配置，不作为账号加入列表）',
          };
        }
        const authFile = join(e.targetHome, '.local', 'share', 'mimocode', 'auth.json');
        await mkdir(dirname(authFile), { recursive: true });
        let authData = {};
        try { authData = JSON.parse(await readFile(authFile, 'utf-8')); } catch { authData = {}; }
        if (!e.mimoPrivateKeyDer) return { ok: false, error: '当前会话缺少 X25519 私钥，请重新发起登录' };
        const dec = decryptMimoCode(e.mimoPrivateKeyDer, input);
        if (!dec || !dec.sk) throw new Error('解密后未包含有效的 MiMo 密钥 (sk)');
        authData.xiaomi = {
          type: 'api',
          key: dec.sk,
          metadata: {
            ...(dec.uid ? { uid: dec.uid } : {}),
            ...(dec.url ? { base_url: dec.url } : {}),
          },
        };
        await writeFile(authFile, JSON.stringify(authData, null, 2) + '\n', { mode: 0o600 });
        e.buf += `\n[MiMo OAuth] ✓ 小米 MiMo 凭据已成功解密并写入 ${authFile}\n`;
        const acc = await finalizeLoginAccount(e, prefName);
        if (acc && acc.ok === false) return { ok: false, worker: e.worker, error: acc.error || '凭据归档失败，请重试或稍候再检测' };
        const accName = acc?.name || e.savedAccountName || '';
        clearQuotaCache('mimocode');
        cleanupSessionResources(e);
        e.code = 0;
        e.exited = true;
        return {
          ok: true,
          worker: 'mimocode',
          accountName: accName,
          note: accName ? `小米 MiMo 认证成功，已自动添加并切换至账号「${accName}」` : '小米 MiMo 凭据已验证并落盘',
        };
      }

      // 3. TraeCode: 回调链接或 JWT Token
      if (e.worker === 'traecode') {
        return await exchangeTraeCallback(e, input, prefName);
      }

      // 4. ZCode: 智谱 BigModel 国内版 / Z.ai 国际版 OAuth 回调链接或 Coding Plan API Key
      if (e.worker === 'zcode') {
        if (!input) return { ok: false, error: '请粘贴智谱 BigModel / Z.ai API Key 或回调链接' };
        const zprov = e.zcodeProvider || zcodeProviderOf(e.region);
        if (input.includes('code=') || input.includes('authCode=')) {
          const u = new URL(input.startsWith('http') || input.startsWith('zcode:') ? input : `http://localhost/?${input.replace(/^[?#]/, '')}`);
          const code = u.searchParams.get('authCode') || u.searchParams.get('code') || '';
          const state = u.searchParams.get('state') || e.oauthState || '';
          const redirectUri = 'https://zcode.z.ai/app/oauth/login?redirect=zcode%3A%2F%2Foauth%2Fcallback&app_version=3.15.0';
          const r = await fetchJsonSmart(ZCODE_OAUTH.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: zprov, code, redirect_uri: redirectUri, state }),
          }, 15_000);
          if (!r.ok || r.json?.code !== 0 || !r.json?.data?.token) {
            throw new Error(r.json?.msg || `ZCode Token 交换失败 (${r.status})`);
          }
          const bm = r.json.data[zprov] || r.json.data.bigmodel || r.json.data.zai || {};
          await saveZcodeOAuthResult(e.targetHome, zprov, {
            accessToken: bm.access_token || bm.accessToken || '',
            refreshToken: bm.refresh_token || bm.refreshToken || '',
            zcodeJwtToken: r.json.data.token,
          });
        } else {
          await saveZcodeOAuthResult(e.targetHome, zprov, { apiKey: input });
        }
        e.buf += `\n[ZCode] ✓ ZCode 凭据已加密写入 ${join(e.targetHome, '.zcode/v2/credentials.json')}\n`;
        const acc = await finalizeLoginAccount(e, prefName);
        if (acc && acc.ok === false) return { ok: false, worker: e.worker, error: acc.error || '凭据归档失败，请重试或稍候再检测' };
        const accName = acc?.name || e.savedAccountName || '';
        clearQuotaCache('zcode');
        cleanupSessionResources(e);
        e.code = 0;
        e.exited = true;
        return {
          ok: true,
          worker: 'zcode',
          accountName: accName,
          note: accName ? `ZCode 认证成功，已自动添加并切换至账号「${accName}」` : 'ZCode 凭据已加密保存并生效',
        };
      }

      // 5. opencode: provider:api_key 直写官方 auth.json（随后用官方 CLI 复核）
      if (e.worker === 'opencode') {
        const parsed = parseOpencodeAuthInput(input);
        if (!parsed.ok) return { ok: false, worker: 'opencode', error: parsed.error };
        const provider = parsed.provider;
        const apiKey = parsed.apiKey;
        if (parsed.note) e.buf += `[opencode] ${parsed.note}\n`;
        const authFile = join(e.targetHome, '.local', 'share', 'opencode', 'auth.json');
        await mkdir(dirname(authFile), { recursive: true });
        // auth.json 是「一个文件装 N 个 provider」的凭据库，而这里跑在隔离 HOME 里：
        // 只读沙箱会得到 {}，写回去就把用户之前加的 provider 全冲掉（实测：先加 siliconflow 再加 opencode，
        // 第二个 key 会把第一个抹掉）。所以以线上 auth.json 为底，再叠沙箱里已写的内容。
        const liveAuthFile = join(HOME, '.local', 'share', 'opencode', 'auth.json');
        /** @type {Record<string, any>} */
        let authData = {};
        for (const f of [liveAuthFile, authFile]) {
          try {
            const parsedFile = JSON.parse((await readFile(f, 'utf-8')).replace(/^\uFEFF/, ''));
            if (parsedFile && typeof parsedFile === 'object' && !Array.isArray(parsedFile)) authData = { ...authData, ...parsedFile };
          } catch { /* 文件不存在或内容损坏时跳过 */ }
        }
        // 覆盖前留一份备份：别把已经登录好的条目写坏
        try {
          const prev = (await readFile(authFile, 'utf-8')).trim();
          if (prev) await writeFile(`${authFile}.bak`, prev, { mode: 0o600 });
        } catch { /* 首次写入没有旧文件 */ }
        try {
          const prevLive = (await readFile(liveAuthFile, 'utf-8')).trim();
          if (prevLive) await writeFile(`${liveAuthFile}.bak`, prevLive, { mode: 0o600 });
        } catch { /* 线上还没有 auth.json */ }
        const prevKey = authData[provider] && (authData[provider].key || authData[provider].access);
        const overwroteKey = !!prevKey && prevKey !== apiKey;
        authData[provider] = { type: 'api', key: apiKey };
        const payload = JSON.stringify(authData, null, 2) + '\n';
        await writeFile(authFile, payload, { mode: 0o600 });
        if (liveAuthFile !== authFile) {
          await mkdir(dirname(liveAuthFile), { recursive: true });
          await writeFile(liveAuthFile, payload, { mode: 0o600 });
        }
        const others = Object.keys(authData).filter((p) => p !== provider);
        e.buf += `\n[opencode] ✓ API Key 已写入 ${liveAuthFile}\n`;
        e.buf += `[opencode] 当前共 ${Object.keys(authData).length} 个 provider：${Object.keys(authData).join(' / ')}\n`;
        if (overwroteKey) {
          // 同一 provider 只能存一把 Key，旧的一定会被换掉；不说明白用户会以为「加了两个只剩一个」
          e.buf += `[opencode] ! provider「${provider}」原本已有 Key，已用新 Key 覆盖（auth.json 里同一 provider 只存一把；要并存请换一个 provider 名，写成 provider:api_key）\n`;
        }
        if (others.length) e.buf += `[opencode] 已保留原有 provider：${others.join(' / ')}\n`;
        // 用官方 CLI 复核 provider 是否被识别；识别不到只警告，不把已经写好的凭据判成失败
        const ocBin = resolveCliBin('opencode', join(HOME, '.npm-global', 'bin', 'opencode'));
        const ocCheck = await runCliWithHome(ocBin, ['auth', 'list'], e.targetHome, 30_000);
        const ocText = stripAnsi(ocCheck.stdout + ocCheck.stderr);
        const ocSeen = ocCheck.code === 0 && new RegExp(provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(ocText);
        if (ocSeen) {
          e.buf += `[opencode] ✓ opencode auth list 已确认 provider ${provider}\n`;
        } else {
          e.buf += `[opencode] ! opencode auth list 未列出 provider「${provider}」（exit=${ocCheck.code}）；凭据已写入，如调用报错请核对 provider id（参考 opencode.ai/docs/providers）\n`;
        }
        const ocAcc = await finalizeLoginAccount(e, prefName || provider);
        if (ocAcc && ocAcc.ok === false) return { ok: false, worker: e.worker, error: ocAcc.error || '凭据归档失败，请重试或稍候再检测' };
        const ocName = ocAcc?.name || e.savedAccountName || '';
        clearQuotaCache('opencode');
        cleanupSessionResources(e);
        e.code = 0;
        e.exited = true;
        return {
          ok: true,
          worker: 'opencode',
          accountName: ocName,
          note: ocName ? `opencode 认证成功，已自动添加并切换至账号「${ocName}」` : `opencode 凭据已写入并生效（provider: ${provider}）`,
        };
      }

      // 6. cline: PTY 设备码会话中的非 Key 输入转给 TUI；粘贴 API Key 则走非交互落盘
      if (e.worker === 'cline' && e.mode === 'pty_device') {
        const looksLikeKey = /^(sk-|gsk_|AIza|xai-|hf[-_])/i.test(input) || /^[A-Za-z0-9._-]{2,40}\s*[|:].{8,}$/.test(input);
        if (!looksLikeKey) {
          if (e.proc && e.proc.stdin && !e.exited) {
            try { e.proc.stdin.write(input + '\r'); } catch { /* 子进程已退出 */ }
            return { ok: true, worker: 'cline', note: '已发送到登录终端' };
          }
          return { ok: false, worker: 'cline', error: '登录终端已结束，请重新点击「登录」发起一次授权' };
        }
      }

      // 6b. cline: provider|api_key（可选 model / base_url）→ cline auth 非交互落盘
      if (e.worker === 'cline') {
        const parsed = parseClineAuthInput(input);
        if (!parsed.ok) return { ok: false, worker: 'cline', error: parsed.error };
        const { provider, apiKey, baseUrl } = parsed;
        // cline 的快捷认证强制要求 --modelid：未指定时按厂商取默认值，取不到就明确要求补模型
        const model = parsed.model || clineDefaultModel(provider);
        if (!model) {
          return {
            ok: false,
            worker: 'cline',
            error: `cline 需要同时指定模型：请写成 ${provider}|模型ID|Key（例如 ${provider}|<model-id>|${apiKey.slice(0, 4)}…）`,
          };
        }
        const clBin = resolveCliBin('cline', join(HOME, '.npm-global', 'bin', 'cline'));
        const args = ['auth', '-p', provider, '-k', apiKey, '-m', model];
        if (baseUrl) args.push('-b', baseUrl);
        // 密钥只经 argv 传给官方 CLI，不落日志
        const clRun = await runCliWithHome(clBin, args, e.targetHome, 90_000);
        const clText = stripAnsi(clRun.stdout + clRun.stderr);
        e.buf += `\n[cline] provider=${provider} / model=${model}${parsed.inferred ? '（provider 由 Key 前缀推断）' : ''}，cline auth 退出码=${clRun.code}${clRun.timeout ? '（超时）' : ''}\n`;
        if (clRun.code !== 0) {
          return { ok: false, worker: 'cline', error: `cline auth 失败: ${clText.slice(-300) || clRun.error || '未知错误'}` };
        }
        const credOK = await isClineCredWritten(e.targetHome);
        if (!credOK) {
          e.buf += '[cline] ! 未检测到 ~/.cline 凭据文件\n';
          return { ok: false, worker: 'cline', error: 'cline auth 已返回成功，但未检测到 ~/.cline 凭据文件，请在服务器终端手动执行 cline auth 复核' };
        }
        e.buf += '[cline] ✓ ~/.cline 凭据已写入，开始最小真实调用校验…\n';
        const verify = await verifyClineCredential(clBin, e.targetHome, model);
        if (!verify.ok) {
          e.buf += `[cline] ! 校验调用失败（exit=${verify.code}）：${verify.text.slice(-200)}\n`;
          return {
            ok: false,
            worker: 'cline',
            error: `凭据已写入但真实调用失败，未加入账号列表：${verify.text.slice(-200) || `exit=${verify.code}`}`
              + (provider === 'openai' && !baseUrl ? '（若是兼容网关的 Key，请用 provider|model|key|base_url 形式）' : ''),
          };
        }
        e.buf += '[cline] ✓ 真实调用通过\n';
        const clAcc = await finalizeLoginAccount(e, prefName || provider);
        if (clAcc && clAcc.ok === false) return { ok: false, worker: e.worker, error: clAcc.error || '凭据归档失败，请重试或稍候再检测' };
        const clName = clAcc?.name || e.savedAccountName || '';
        clearQuotaCache('cline');
        cleanupSessionResources(e);
        e.code = 0;
        e.exited = true;
        return {
          ok: true,
          worker: 'cline',
          accountName: clName,
          note: clName ? `Cline 认证成功，已自动添加并切换至账号「${clName}」` : `Cline 凭据已写入并生效（provider: ${provider}）`,
          ...(parsed.inferred && provider === 'openai' && !baseUrl
            ? { hint: '已按 openai 官方端点处理；若这是 SiliconFlow 等兼容网关的 Key，请用 provider|model|key|base_url 重新提交' }
            : {}),
        };
      }

      // 7. CodeArts: AK/SK
      if (e.worker === 'codearts') {
        let ak = String(extra.ak || '').trim();
        let sk = String(extra.sk || '').trim();
        if ((!ak || !sk) && input.includes(':')) {
          const idx = input.indexOf(':');
          ak = input.slice(0, idx).trim();
          sk = input.slice(idx + 1).trim();
        }
        const res = await _saveCodeArtsToHome(e.targetHome, ak, sk);
        if (!res.ok) return res;
        e.buf += `\n[CodeArts] ✓ AK/SK 已保存到 ${join(e.targetHome, '.config/agenthub-codearts/codearts-auth.env')}\n`;
        const acc = await finalizeLoginAccount(e, prefName);
        if (acc && acc.ok === false) return { ok: false, worker: e.worker, error: acc.error || '凭据归档失败，请重试或稍候再检测' };
        const accName = acc?.name || e.savedAccountName || '';
        clearQuotaCache('codearts');
        cleanupSessionResources(e);
        e.code = 0;
        e.exited = true;
        return {
          ...res,
          accountName: accName,
          note: accName ? `CodeArts 认证成功，已自动添加并切换至账号「${accName}」` : res.note,
        };
      }

      // 6. MiniMaxCode(mcode)：官方 CLI 不接受把 API Key 写进登录态文件，
      //    这里只提示正确做法，避免往已废弃的 ~/.mmx/config.json 里写脏数据
      if (e.worker === 'minimaxcode' && /^sk-[A-Za-z0-9_-]{10,}$/.test(input)) {
        e.buf += '\n[MiniMax] mcode 不接受直接粘贴 API Key：请走设备码授权，或在终端执行 '
          + '`export MCODE_PROVIDER_API_KEY=... && mcode provider set-minimax-key && mcode provider use api-key`\n';
        return {
          ok: false,
          worker: 'minimaxcode',
          error: 'mcode 请用设备码授权（点「登录」）；API Key 需在终端用 mcode provider set-minimax-key 配置',
        };
      }

      // 7. CodeBuddy / CodeBuddy-CN: 支持直接粘贴 auth.info JSON 或 accessToken
      if ((e.worker === 'codebuddy' || e.worker === 'codebuddy-cn') && input) {
        // 网页 URL 不是凭据：/started 页只是"浏览器授权已完成"提示页，绝不可当 accessToken 写入
        if (/^https?:\/\//i.test(input)) {
          let u = null;
          try { u = new URL(input); } catch { u = null; }
          const state = u ? (u.searchParams.get('state') || '') : '';
          if (u && /\/started\b/i.test(u.pathname) && state) {
            return await completeCodeBuddyByState(e, state, prefName);
          }
          return { ok: false, error: '该链接是网页地址而非凭据。若浏览器显示 started 成功页，说明授权已完成——请直接点击「我已完成授权」让系统自动检测落盘；或粘贴 auth.info JSON / accessToken 导入' };
        }
        const dirName = e.worker === 'codebuddy-cn' ? '.codebuddy-cn' : '.codebuddy';
        const authInfoFile = join(e.targetHome, dirName, 'auth.info');
        await mkdir(dirname(authInfoFile), { recursive: true });
        let payload;
        try {
          payload = JSON.parse(input);
        } catch {
          payload = { auth: { accessToken: input.replace(/^Bearer\s+/i, '').trim() }, updatedAt: new Date().toISOString() };
        }
        // 拒绝半成品：accessToken 缺失或是跳转 URL（未完成授权的占位）
        const pastedTok = String(payload?.auth?.accessToken || '').trim();
        if (!pastedTok || pastedTok.startsWith('http')) {
          return { ok: false, error: '粘贴的内容不含有效 accessToken（若是 started 跳转链接，说明授权刚完成，请直接点「我已完成授权」检测落盘）' };
        }
        await writeFile(authInfoFile, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
        e.buf += `\n[CodeBuddy] ✓ 凭据已写入 ${authInfoFile}\n`;
        const acc = await finalizeLoginAccount(e, prefName);
        if (acc && acc.ok === false) return { ok: false, worker: e.worker, error: acc.error || '凭据归档失败，请重试' };
        const accName = acc?.name || e.savedAccountName || '';
        clearQuotaCache(e.worker);
        cleanupSessionResources(e);
        e.code = 0;
        e.exited = true;
        return {
          ok: true,
          worker: e.worker,
          accountName: accName,
          note: accName ? `${e.worker} 认证成功，已自动添加并切换至账号「${accName}」` : `${e.worker} 凭据已保存并生效`,
        };
      }

      // 8. GitHub Copilot: 支持直接粘贴 gho_ / ghu_ / github_pat_ Token
      if (e.worker === 'github-copilot' && /^(gh[opusr]_|github_pat_)[A-Za-z0-9_]{10,}$/.test(input)) {
        const mirror = join(e.targetHome, '.config', 'github-copilot', 'copilot-token');
        await mkdir(dirname(mirror), { recursive: true });
        await writeFile(mirror, input, { mode: 0o600 });
        try { await execFile('python3', [SECRET_HELPER, '--set', 'copilot-cli', 'https://github.com', input], { timeout: 6000 }); } catch { /* ignore */ }
        e.buf += `\n[Copilot] ✓ GitHub Copilot Token 已保存\n`;
        const acc = await finalizeLoginAccount(e, prefName);
        if (acc && acc.ok === false) return { ok: false, worker: e.worker, error: acc.error || '凭据归档失败，请重试或稍候再检测' };
        const accName = acc?.name || e.savedAccountName || '';
        clearQuotaCache('github-copilot');
        cleanupSessionResources(e);
        e.code = 0;
        e.exited = true;
        return {
          ok: true,
          worker: 'github-copilot',
          accountName: accName,
          note: accName ? `GitHub Copilot 认证成功，已自动添加并切换至账号「${accName}」` : 'GitHub Copilot Token 已保存并生效',
        };
      }

      // 9. 通用 PTY 终端交互输入（如向正在运行的 CLI 发送回车或文本）
      if (e.proc && e.proc.stdin && !e.exited) {
        e.proc.stdin.write(input + '\n');
        return { ok: true, worker: e.worker, note: '已发送到登录终端' };
      }

      return { ok: false, error: '当前会话不支持该输入或已结束' };
    } catch (err) {
      return { ok: false, error: err.message || '认证处理失败' };
    }
  };

  const p = runCallback();
  e.inflightCallback = p;
  try {
    return await p;
  } finally {
    if (e.inflightCallback === p) e.inflightCallback = null;
  }
}

const SANDBOX_ROOT = join(HOME, '.agenthub', 'sandbox');
async function removeSandboxDir(sandboxPath) {
  if (sandboxPath && sandboxPath.startsWith(SANDBOX_ROOT)) {
    await rm(sandboxPath, { recursive: true, force: true }).catch(() => {});
  }
}

export async function finishLogin(loginId, preferredName = '') {
  const e = sessions.get(loginId);
  if (!e) return { ok: false, error: '登录会话不存在或已过期' };
  // API Key 直配通道（如 mimocode sk-）：已直接写入线上配置生效，不作为账号归档
  if (e.apiKeyOnly) {
    e.exited = true;
    cleanupSessionResources(e);
    await removeSandboxDir(e.sandbox);
    sessions.delete(loginId);
    return { ok: true, worker: e.worker, accountName: null, apiKeyOnly: true, note: 'API Key 已生效（通道配置，不作为账号入库）' };
  }
  const acc = await finalizeLoginAccount(e, preferredName);
  const accountName = acc?.name || e.savedAccountName || null;
  if (!accountName && acc && acc.ok === false) {
    return { ok: false, worker: e.worker, error: acc.error || '尚未检测到新登录凭据，请先完成授权或粘贴回调链接提交' };
  }
  e.exited = true;
  clearQuotaCache(e.worker);
  cleanupSessionResources(e);
  await removeSandboxDir(e.sandbox);
  sessions.delete(loginId);
  return { ok: true, worker: e.worker, accountName };
}

/** 取消未完成的登录会话：终止 PTY/ACP 子进程、关闭回调监听与轮询定时器、清理沙箱临时目录 */
export async function cancelLogin(loginId) {
  const e = sessions.get(loginId);
  if (!e) return { ok: true, cancelled: false, note: '会话已结束' };
  e.exited = true;
  if (e.code === null) e.code = -1;
  cleanupSessionResources(e);
  await removeSandboxDir(e.sandbox);
  sessions.delete(loginId);
  return {
    ok: true,
    cancelled: !e.savedAccountName && !e.apiKeyOnly,
    worker: e.worker,
    accountName: e.savedAccountName || null,
  };
}

/** 服务退出时清理所有活跃登录会话的子进程、回调端口与定时器 */
export function cancelAllLogins() {
  for (const [id, e] of sessions.entries()) {
    e.exited = true;
    cleanupSessionResources(e);
    removeSandboxDir(e.sandbox).catch(() => {});
    sessions.delete(id);
  }
}

// ---------------------------------------------------------------- 退出登录（全部 11 个 Worker）
export async function logout(worker) {
  const files = LOGOUT_FILES[worker];
  if (!files) return { ok: false, error: `该 worker 无可退出的凭据文件: ${worker}` };
  // 退出登录前先将当前有效凭据自动归档至账号列表，方便随时从下拉框一键切回
  try { await autoSyncLiveAccount(worker); } catch { /* ignore */ }
  const destDir = join(HOME, '.agenthub', 'accounts', worker, `.logged-out-${Date.now()}`);
  await mkdir(destDir, { recursive: true });
  const moved = [];

  if (worker === 'github-copilot') {
    try {
      const { stdout } = await execFile('python3', [SECRET_HELPER, 'copilot-cli', 'https://github.com'], { timeout: 6000 });
      const tok = String(stdout || '').trim();
      if (tok) {
        await writeFile(join(destDir, 'copilot-token'), tok, { mode: 0o600 });
        moved.push('gnome-keyring:copilot-cli');
      }
      await execFile('python3', [SECRET_HELPER, '--delete', 'copilot-cli', 'https://github.com'], { timeout: 6000 }).catch(() => {});
    } catch { /* ignore */ }
  }

  for (const rel of files) {
    try {
      const src = join(HOME, rel);
      await rename(src, join(destDir, rel.split('/').pop()));
      moved.push(`~/${rel}`);
    } catch { /* 文件不存在则跳过 */ }
  }

  if (worker === 'github-copilot') {
    const mirror = join(HOME, '.config', 'github-copilot', 'copilot-token');
    await mkdir(dirname(mirror), { recursive: true });
    await writeFile(mirror, '__LOGGED_OUT__\n', { mode: 0o600 });
  }

  clearQuotaCache(worker);
  if (moved.length === 0) return { ok: false, error: '未找到任何生效凭据（当前可能已处于退出状态）' };
  return { ok: true, worker, moved, backup: destDir, note: '已退出当前账号（原账号已保存在账号档案列表中，可随时切换恢复）' };
}

// ---------------------------------------------------------------- CodeArts AK/SK
async function _saveCodeArtsToHome(targetHome, ak, sk) {
  // 不做格式校验：只清掉粘贴带入的空白，是否可用由 CodeArts 自己判定
  ak = String(ak || '').replace(/\s+/g, '');
  sk = String(sk || '').replace(/\s+/g, '');
  if (!ak || !sk) return { ok: false, error: '请同时填写 AK 与 SK' };
  const envFile = join(targetHome, '.config', 'agenthub-codearts', 'codearts-auth.env');
  await mkdir(dirname(envFile), { recursive: true });
  const body = `# Multi-Agent Hub CodeArts AK/SK (written via WebUI ${new Date().toISOString()})\nCODEARTS_CLI_AK=${ak}\nCODEARTS_CLI_SK=${sk}\n`;
  await writeFile(envFile, body, { mode: 0o600 });
  clearQuotaCache('codearts');
  return { ok: true, worker: 'codearts', note: 'CodeArts AK/SK 已保存（0600），配额状态已更新' };
}

async function _saveCodeArts(ak, sk) {
  const res = await _saveCodeArtsToHome(HOME, ak, sk);
  if (res.ok) {
    try { await autoSyncLiveAccount('codearts'); } catch { /* ignore */ }
  }
  return res;
}

// ---------------------------------------------------------------- 模型管理
/**
 * 同一 model id 挂着多个别名时，挑一个最适合当显示名的：
 * 与 id 末段同形（忽略大小写与标点）> 含大写（更像正式名）> 不做 id 那种长串
 */
function pickDisplayAlias(id, aliases) {
  const bare = String(id).split('/').pop();
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const ranked = (aliases || []).map((a) => {
    let score = 0;
    if (norm(a) === norm(bare)) score += 4;
    if (/[A-Z]/.test(a)) score += 2;
    if (a === id) score -= 1;
    if (String(a).length > 24) score -= 3;
    return { a, score };
  }).sort((x, y) => y.score - x.score);
  return ranked.length ? ranked[0].a : bare;
}

const CATALOG_MODELS = {
  qoder: QODER_MODELS,
  'qoder-cn': QODER_MODELS,
  codearts: [
    { id: 'huaweicloud-maas/glm-5.3', name: 'GLM-5.3', credits: '0.70x', default: true },
    { id: 'huaweicloud-maas/GLM-5.2', name: 'GLM-5.2', credits: '0.70x' },
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
    { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash Low' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
    { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
  ],
  mimocode: [
    { id: 'xiaomi/mimo-v2.6-flash', name: 'MiMo-V2.6-Flash (26f)', default: true },
    { id: 'xiaomi/mimo-v2.6-pro', name: 'MiMo-V2.6-Pro' },
    { id: 'xiaomi/mimo-v2.6-pro-ultraspeed', name: 'MiMo-V2.6-Pro-UltraSpeed' },
    { id: '9router/trae', name: 'Trae (9router 通道)' },
  ],
  // mcode 的模型引用是 provider/model；国内区与国际区都是 minimax/*（实测 minimax-cn/* 会报
  // not available for the configured_provider route）。默认 3.1 Flash，另留一档 M3。
  minimaxcode: [
    { id: 'minimax/MiniMax-M3.1-Flash', name: 'MiniMax-M3.1-Flash', tag: '默认 · 1M 上下文', ctx: '1M', default: true },
    { id: 'minimax/MiniMax-M3', name: 'MiniMax-M3', tag: '1M 上下文', ctx: '1M' },
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
  // opencode 自带免费档：opencode models 列出的 *-free 系列，无需任何 API Key
  opencode: [
    { id: 'opencode/deepseek-v4.1-flash-free', name: 'DeepSeek-V4.1-Flash (free)', tag: '免费' },
    { id: 'opencode/glm-5.3-flash-free', name: 'GLM-5.3-Flash (free)', tag: '免费' },
    { id: 'opencode/mimo-v2.6-flash-free', name: 'MiMo-V2.6-Flash (free)', tag: '免费' },
    { id: 'opencode/longcat-2.5-preview-free', name: 'LongCat-2.5-Preview (free)', tag: '免费' },
    { id: 'opencode/nemotron-3-ultra-free', name: 'Nemotron-3-Ultra (free)', tag: '免费' },
    { id: 'opencode/nemotron-3.5-lightning-free', name: 'Nemotron-3.5-Lightning (free)', tag: '免费' },
    { id: 'opencode/nemotron-3.5-super-vl-free', name: 'Nemotron-3.5-Super-VL (free)', tag: '免费' },
    { id: 'opencode/space-bunny-free', name: 'Space-Bunny (free)', tag: '免费' },
    { id: 'opencode/beam-free', name: 'Beam (free)', tag: '免费' },
    { id: 'opencode/big-pickle', name: 'Big Pickle (free)', tag: '免费' },
  ],
  // cline 的模型取决于所配 provider / 账号。cline-free 的旧免费推广已结束（返回 Free model promotion
  // ended），但目录里 :free 结尾的仍然可用；下面三条是 2026-10-17 实测能答话的免费项。
  cline: [
    { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', tag: 'Cline 账号', default: true },
    { id: 'anthropic/claude-sonnet-5.5', name: 'Claude-Sonnet-5.5', tag: 'Cline 账号' },
    { id: 'openrouter/free', name: 'OpenRouter Free', tag: '免费' },
    { id: 'nvidia/nemotron-3.5-lightning:free', name: 'Nemotron-3.5-Lightning (free)', tag: '免费' },
    { id: 'cohere/north-mini-code:free', name: 'North-Mini-Code (free)', tag: '免费' },
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
        ctx: cat.ctx || null,
        aliases: shortAliases,
        removableAliases: shortAliases,
        custom: false,
        isDefault: cat.id === defaultId,
      });
      seenIds.add(cat.id);
    }

    // 同一个 id 常挂多个别名（GLM-5.3 就有 GLM-5.3 / glm5.3 / gm5.3 / glm-5.3 / huaweicloud-maas/glm-5.3），
    // 按 id 归并成一行、别名收进 aliases，否则同款模型会在列表里刷出 5 个
    const aliasGroups = new Map();
    for (const [alias, id] of Object.entries(rawModels)) {
      if (alias === 'default' || !id) continue;
      if (seenIds.has(id)) continue;
      if (!aliasGroups.has(id)) aliasGroups.set(id, []);
      aliasGroups.get(id).push(alias);
    }
    for (const [id, aliasList] of aliasGroups) {
      const displayAlias = pickDisplayAlias(id, aliasList);
      merged.push({
        alias: displayAlias,
        id,
        name: displayAlias,
        credits: null,
        tag: '自定义',
        aliases: aliasList,
        removableAliases: aliasList.filter((a) => a !== displayAlias && a !== id),
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
  // 若被删别名正是当前 default 指向，回退到内置默认模型，避免 default 悬空
  if (prof.models.default === alias) {
    const catalogDefault = (CATALOG_MODELS[worker] || []).find((m) => m.default)?.id;
    if (catalogDefault) prof.models.default = catalogDefault;
    else delete prof.models.default;
  }
  await saveAgents(d);
  return { ok: true, worker, alias };
}

// ---- 并发加固：以下导出为串行互斥包装（内部实现为 _<name>） ----
export function saveCodeArts(ak, sk) { return withLock(AUTH_WRITE_LOCK, () => _saveCodeArts(ak, sk)); }
export function setDefaultModel(worker, alias) { return withLock(AUTH_WRITE_LOCK, () => _setDefaultModel(worker, alias)); }
export function addCustomModel(worker, alias, id) { return withLock(AUTH_WRITE_LOCK, () => _addCustomModel(worker, alias, id)); }
export function removeCustomModel(worker, alias) { return withLock(AUTH_WRITE_LOCK, () => _removeCustomModel(worker, alias)); }
