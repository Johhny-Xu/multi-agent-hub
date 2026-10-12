// @ts-check
// Multi-Agent Hub WebUI 9-Worker 全量 OAuth 登录 / 退出 / 回调认证 / 模型管理模块（零第三方依赖）
// 支持全部 9 个子代理 100% 通过 WebUI 完成 OAuth 授权登录、退出、沙箱添加新账号与回调/Token 认证：
// 1. minimaxcode    : Python PTY 包装 mmx auth login --recommend --region=cn（提取设备码与链接）+ 支持粘贴 API Key
// 2. codebuddy      : 官方 codebuddy --acp (external) JSON-RPC authenticate，秒级提取 _codebuddy.ai/authUrl 并自动落盘
// 3. codebuddy-cn   : 官方 codebuddy --acp (internal) JSON-RPC authenticate，秒级提取 copilot.tencent.com 链接并自动落盘
// 4. github-copilot : Python PTY 包装 copilot login --device-code（提取 GitHub 设备码与链接）+ 支持粘贴 GitHub Token
// 5. antigravity    : 官方 Google OAuth 2.0 授权流（accounts.google.com + 本地 20128 监听 + 粘贴回调 URL/code 自动换取令牌）
// 6. mimocode       : 官方 Xiaomi MiMo X25519 + AES-256-GCM 授权流（platform.xiaomimimo.com/authorize + 粘贴加密 Code 解密落盘）
// 7. traecode       : 官方 Trae GetLoginGuidance + ExchangeToken OAuth 授权流（www.trae.cn / www.trae.ai + 回调链接/JWT 落盘）
// 8. zcode          : 官方 ZCode CLI Polling OAuth（zcode.z.ai/api/v1/oauth/cli/init + 自动轮询 poll + enc:v1 加密落盘）
// 9. codearts       : 华为云 IAM 访问密钥页面引导 + WebUI 内联 AK/SK 认证落盘

import { spawn, execFile as execFileCb } from 'node:child_process';
import { createDecipheriv, createDiffieHellman, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename, readdir, rm, chmod } from 'node:fs/promises';
import http from 'node:http';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { clearQuotaCache, fetchJsonSmart, encryptZcodeCred } from './vendor-quota.mjs';

const execFile = promisify(execFileCb);
const HOME = homedir();
const AGENTS_JSON = join(HOME, '.config', 'agenthub-codearts', 'agents.json');
const CODEARTS_ENV = join(HOME, '.config', 'agenthub-codearts', 'codearts-auth.env');
const SECRET_HELPER = join(dirname(fileURLToPath(import.meta.url)), 'secret-get.py');

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
  exchangeTokenPath: '/cloudide/api/v3/trae/oauth/ExchangeToken',
  userAgent: 'Trae/1.0.0 antigravity-cockpit-tools',
  defaultAppVersion: '3.5.54',
};

const ZCODE_OAUTH = {
  initUrl: 'https://zcode.z.ai/api/v1/oauth/cli/init',
  pollBaseUrl: 'https://zcode.z.ai/api/v1/oauth/cli/poll',
  tokenUrl: 'https://zcode.z.ai/api/v1/oauth/token',
  userinfoUrl: 'https://bigmodel.cn/api/biz/customer/getCustomerInfo',
};

// ---------------------------------------------------------------- 登录命令表（全部 9 个 Worker 均支持 WebUI 登录）
export const LOGIN_COMMANDS = {
  'minimaxcode': {
    cmd: [join(HOME, '.npm-global', 'bin', 'mmx'), 'auth', 'login', '--recommend', '--region=cn'],
    headless: true,
    mode: 'pty_device',
    note: '打开 MiniMax 授权链接并确认设备码，后端将自动轮询并写入 ~/.mmx/config.json；也可直接在下方粘贴 MiniMax API Key (sk-...)',
    callbackHint: '可选：直接粘贴 MiniMax API Key (sk-...) 立即完成认证',
  },
  'codebuddy': {
    cmd: [join(HOME, '.npm-global', 'bin', 'codebuddy'), '--acp'],
    headless: true,
    mode: 'acp_oauth',
    acpEnv: 'external',
    note: '点击下方 CodeBuddy 国际版 (www.codebuddy.ai) OAuth 链接完成登录，后端通过 ACP 协议自动检测并落盘 ~/.codebuddy/auth.info',
    callbackHint: '可选：粘贴已有的 auth.info JSON 或 accessToken 直接导入',
  },
  'codebuddy-cn': {
    cmd: [join(HOME, '.npm-global', 'bin', 'codebuddy'), '--acp'],
    headless: true,
    mode: 'acp_oauth',
    acpEnv: 'internal',
    note: '点击下方 CodeBuddy 国内版 (copilot.tencent.com) OAuth 链接完成微信/腾讯云扫码登录，后端自动检测并落盘 ~/.codebuddy-cn/auth.info',
    callbackHint: '可选：粘贴已有的 auth.info JSON 或 accessToken 直接导入',
  },
  'github-copilot': {
    cmd: [join(HOME, '.local', 'bin', 'copilot'), 'login', '--device-code'],
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
    note: '1. 点击下方 Trae 国内版（或国际版）授权链接完成登录；2. 浏览器跳转到 http://127.0.0.1:<端口>/callback?refreshToken=... 后，复制地址栏完整链接（或直接粘贴 Trae JWT Token）到下方输入框并点击「提交完成认证」',
    callbackHint: '粘贴浏览器跳转后的 http://127.0.0.1.../callback?refreshToken=... 完整链接或 Trae JWT Token',
  },
  'zcode': {
    headless: true,
    mode: 'zcode_oauth',
    note: '点击下方智谱 BigModel（或 Z.ai）官方 OAuth 链接并在浏览器登录，后端每 3 秒自动轮询并加密写入 ~/.zcode/v2/credentials.json；也可直接在下方粘贴 Coding Plan API Key',
    callbackHint: '可选：直接粘贴智谱 BigModel / Z.ai API Key 或 OAuth 回调链接',
  },
  'codearts': {
    headless: true,
    mode: 'codearts_aksk',
    needsCallbackInput: true,
    note: '点击下方链接前往华为云 IAM 控制台获取访问密钥（AK/SK），在下方输入 AK 与 SK（格式 AK:SK 或分别填入）并点击「提交完成认证」',
    callbackHint: '输入格式：AK:SK（例如 XXXXxxxx:xxxxSecretxxxx）',
  },
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
  'github-copilot': ['.config/github-copilot/copilot-token'],
};

function stripAnsi(str) {
  return String(str || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, '');
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
    try { entry.server.close(); } catch { /* ignore */ }
    entry.server = null;
  }
  if (entry.proc) {
    try { entry.proc.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

async function exchangeAntigravityCode(entry, codeStr) {
  let code = String(codeStr || '').trim();
  if (code.includes('code=')) {
    try {
      const u = new URL(code.startsWith('http') ? code : `http://localhost/?${code.replace(/^[?#]/, '')}`);
      code = u.searchParams.get('code') || code;
    } catch { /* ignore */ }
  }
  if (!code) throw new Error('未检测到有效的 Google OAuth 授权码 (code)');
  entry.buf += `\n[OAuth] 正在向 Google 换取访问令牌…\n`;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: ANTIGRAVITY_OAUTH.clientId,
    client_secret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || Buffer.from(ANTIGRAVITY_OAUTH.installedVerifierB64, 'base64').toString('utf8'),
    code,
    redirect_uri: entry.redirectUri || `http://localhost:${ANTIGRAVITY_OAUTH.defaultPort}/oauth-callback`,
  }).toString();
  const res = await fetchJsonSmart(ANTIGRAVITY_OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  }, 20_000);
  if (!res.ok || !res.json?.access_token) {
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
  const targetFile = join(entry.targetHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  await mkdir(dirname(targetFile), { recursive: true });
  await writeFile(targetFile, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  entry.buf += `[OAuth] ✓ Antigravity OAuth 令牌已成功写入 ${targetFile}\n`;
  entry.exited = true;
  entry.code = 0;
  cleanupSessionResources(entry);
  clearQuotaCache('antigravity');
  return { ok: true, worker: 'antigravity', note: 'Antigravity Google OAuth 认证已完成并落盘' };
}

async function exchangeTraeCallback(entry, rawInput) {
  const input = String(rawInput || '').trim();
  if (!input) throw new Error('请输入 Trae 回调链接或 JWT Token');
  let accessToken = '';
  if (input.includes('refreshToken=') || input.includes('refresh_token=')) {
    const q = input.includes('?') ? input.slice(input.indexOf('?') + 1) : input.replace(/^[?#]/, '');
    const params = new URLSearchParams(q);
    const refreshToken = params.get('refreshToken') || params.get('refresh_token') || params.get('RefreshToken') || '';
    const cloudideToken = params.get('x-cloudide-token') || params.get('xCloudideToken') || params.get('accessToken') || params.get('token') || '';
    if (!refreshToken) throw new Error('回调链接缺少 refreshToken 参数');
    entry.buf += `\n[OAuth] 正在通过 Trae ExchangeToken 接口换取 JWT…\n`;
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
    if (!accessToken) throw new Error(`Trae ExchangeToken 失败: ${lastErr}`);
  } else {
    accessToken = input.replace(/^(Cloud-IDE-JWT|Bearer)\s+/i, '').trim();
  }
  const targetFile = join(entry.targetHome, '.trae-cn', 'trae-jwt-token');
  await mkdir(dirname(targetFile), { recursive: true });
  await writeFile(targetFile, accessToken + '\n', { mode: 0o600 });
  entry.buf += `[OAuth] ✓ Trae 凭据已写入 ${targetFile}\n`;
  entry.exited = true;
  entry.code = 0;
  cleanupSessionResources(entry);
  clearQuotaCache('traecode');
  return { ok: true, worker: 'traecode', note: 'Trae 凭据已保存并生效' };
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

function launchWorkerSession(worker, { sandbox = null, name = null } = {}) {
  const spec = LOGIN_COMMANDS[worker];
  if (!spec) return { ok: false, error: `不支持的 worker: ${worker}` };
  const targetHome = sandbox || HOME;
  if (sandbox) mkdirSync(sandbox, { recursive: true });
  const id = `${sandbox ? 'add' : 'login'}-${Date.now()}-${++seq}`;
  /** @type {any} */
  const entry = {
    id,
    worker,
    name,
    sandbox,
    targetHome,
    mode: spec.mode,
    note: spec.note,
    callbackHint: spec.callbackHint || '',
    needsCallbackInput: !!spec.needsCallbackInput,
    authUrl: null,
    secondaryUrl: null,
    deviceCode: null,
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

  // 10 分钟兜底超时回收
  entry.timeoutTimer = setTimeout(() => {
    if (!entry.exited) {
      entry.buf += '\n[timeout] 登录会话已超时（10 分钟）\n';
      entry.exited = true;
      entry.code = -1;
      cleanupSessionResources(entry);
    }
  }, 600_000);

  // ---------------- 分支 1：Python PTY 设备码流 (minimaxcode / github-copilot)
  if (spec.mode === 'pty_device' && spec.cmd) {
    const cleanEnv = { ...process.env, HOME: targetHome, DISPLAY: '', BROWSER: 'echo', TERM: 'xterm-256color', NO_COLOR: '1' };
    delete cleanEnv.CI;
    const child = spawn('python3', ['-c', 'import pty, sys; pty.spawn(sys.argv[1:])', ...spec.cmd], {
      cwd: targetHome,
      env: cleanEnv,
    });
    entry.proc = child;
    child.stdout.on('data', (d) => { entry.buf += d.toString(); trim(entry); });
    child.stderr.on('data', (d) => { entry.buf += d.toString(); trim(entry); });
    child.on('exit', async (code) => {
      entry.exited = true;
      entry.code = code;
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
    child.stdout.on('data', (chunk) => {
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
          } else if (msg.id === 2 && (msg.result !== undefined || msg.error)) {
            if (msg.error) {
              entry.buf += `[ACP] 授权返回错误: ${JSON.stringify(msg.error)}\n`;
            } else {
              entry.buf += `[ACP] ✓ 授权成功！凭据已自动写入 ${join(cfgDir, 'auth.info')}\n`;
              entry.exited = true;
              entry.code = 0;
              clearQuotaCache(worker);
              cleanupSessionResources(entry);
            }
          }
        } catch {
          entry.buf += trimmed + '\n';
        }
      }
      trim(entry);
    });
    child.stderr.on('data', (d) => { entry.buf += d.toString(); trim(entry); });
    child.on('exit', (code) => {
      if (!entry.exited) {
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

  // ---------------- 分支 5：TraeCode 官方 GetLoginGuidance + ExchangeToken OAuth 流
  if (spec.mode === 'trae_oauth') {
    const traceId = randomUUID();
    entry.traeTraceId = traceId;
    const srv = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url || '/', 'http://127.0.0.1');
        if (u.pathname === '/callback' || u.pathname === '/auth/callback') {
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
        plugin_version: 'local',
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
      });
      u.search = qs.toString();
      return u.toString();
    };
    srv.listen(0, '127.0.0.1', async () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 38911;
      const callbackUrl = `http://127.0.0.1:${port}/callback`;
      entry.redirectUri = callbackUrl;
      entry.authUrl = buildTraeUrl('www.trae.cn', callbackUrl);
      entry.secondaryUrl = buildTraeUrl('www.trae.ai', callbackUrl);
      entry.buf = `[Trae OAuth] 已生成 Trae 国内版与国际版 OAuth 授权链接（回调 ${callbackUrl}）：\n国内版 (trae.cn): ${entry.authUrl}\n国际版 (trae.ai): ${entry.secondaryUrl}\n\n在浏览器完成登录后，若跳转到 http://127.0.0.1:${port}/callback?refreshToken=...，请复制地址栏完整链接粘贴到下方输入框并点击「提交完成认证」。\n`;
    });
    return { ok: true, loginId: id, worker, name, sandbox, mode: spec.mode, note: spec.note, callbackHint: spec.callbackHint, needsCallbackInput: true };
  }

  // ---------------- 分支 6：ZCode 官方 CLI Polling OAuth 流 (bigmodel / zai)
  if (spec.mode === 'zcode_oauth') {
    const pollToken = randomBytes(32).toString('hex');
    entry.zcodePollToken = pollToken;
    entry.buf = '[ZCode OAuth] 正在初始化智谱 BigModel / ZCode 官方 OAuth 会话…\n';
    (async () => {
      try {
        const res = await fetchJsonSmart(ZCODE_OAUTH.initUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${pollToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'bigmodel' }),
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
        entry.buf += `[ZCode OAuth] 已获取智谱 BigModel 官方授权链接：\n${entry.authUrl}\n正在后台每 ${intervalMs / 1000}s 自动轮询授权状态…\n`;
        entry.pollTimer = setInterval(async () => {
          if (entry.exited) return;
          try {
            const pr = await fetchJsonSmart(`${ZCODE_OAUTH.pollBaseUrl}/${encodeURIComponent(data.flow_id)}`, {
              headers: { Authorization: `Bearer ${pollToken}` },
            }, 10_000);
            const pd = pr.json?.data;
            if (pr.json?.code === 0 && pd?.status === 'ready') {
              const bm = pd.bigmodel || {};
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
              await saveZcodeOAuthResult(targetHome, 'bigmodel', { accessToken, refreshToken, zcodeJwtToken, userInfo });
              entry.buf += `\n[ZCode OAuth] ✓ 授权成功！账号 ${userInfo.username} 已加密写入 ${join(targetHome, '.zcode/v2/credentials.json')}\n`;
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
      } catch (e) {
        entry.authUrl = 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys';
        entry.needsCallbackInput = true;
        entry.buf += `[ZCode OAuth] 在线初始化提示 (${e.message})，您可点击上方链接获取智谱 BigModel API Key 并粘贴到下方输入框直接保存。\n`;
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

  return { ok: false, error: `未知的登录模式: ${spec.mode}` };
}

export function startLogin(worker) {
  return launchWorkerSession(worker);
}

/** 沙箱添加账号：以隔离 HOME 启动登录流程，授权后凭据落在沙箱内，供快照成档案 */
export function startLoginSandbox(worker, name) {
  const sandbox = join(HOME, '.agenthub', 'sandbox', `${worker}-${name}-${Date.now()}`);
  return launchWorkerSession(worker, { sandbox, name });
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
  const extractedUrl = urls.find((u) => /auth|oauth|login|device|token|authorize|iam/i.test(u)) || urls[0] || null;
  return {
    ok: true,
    worker: e.worker,
    mode: e.mode,
    output: cleanOut.slice(-1600),
    url: e.authUrl || extractedUrl,
    secondaryUrl: e.secondaryUrl || null,
    deviceCode: e.deviceCode || (deviceMatch ? deviceMatch[1] : null),
    needsCallbackInput: !!e.needsCallbackInput,
    callbackHint: e.callbackHint || '',
    exited: e.exited,
    exitCode: e.code,
  };
}

/**
 * WebUI 提交回调 URL / 授权码 / API Key / TUI 交互输入
 * @param {string} loginId
 * @param {string} rawInput
 * @param {{ ak?: string, sk?: string }} [extra]
 */
export async function submitLoginCallback(loginId, rawInput, extra = {}) {
  const e = sessions.get(loginId);
  if (!e) return { ok: false, error: '登录会话不存在或已过期，请重新点击登录' };
  const input = String(rawInput || '').trim();

  try {
    // 1. Antigravity: Google OAuth 回调 URL 或 code
    if (e.worker === 'antigravity') {
      return await exchangeAntigravityCode(e, input);
    }

    // 2. MiMoCode: 小米 MiMo 加密授权码 u / 回调链接 / 直接 API Key
    if (e.worker === 'mimocode') {
      if (!input) return { ok: false, error: '请粘贴小米 MiMo 授权 Code、回调链接或 API Key' };
      const authFile = join(e.targetHome, '.local', 'share', 'mimocode', 'auth.json');
      await mkdir(dirname(authFile), { recursive: true });
      let authData = {};
      try { authData = JSON.parse(await readFile(authFile, 'utf-8')); } catch { authData = {}; }
      if (/^sk-[A-Za-z0-9_-]{12,}$/.test(input)) {
        authData.xiaomi = { type: 'api', key: input };
      } else {
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
      }
      await writeFile(authFile, JSON.stringify(authData, null, 2) + '\n', { mode: 0o600 });
      e.buf += `\n[MiMo OAuth] ✓ 小米 MiMo 凭据已成功解密并写入 ${authFile}\n`;
      e.exited = true;
      e.code = 0;
      cleanupSessionResources(e);
      clearQuotaCache('mimocode');
      return { ok: true, worker: 'mimocode', note: '小米 MiMo 凭据已验证并落盘' };
    }

    // 3. TraeCode: 回调链接或 JWT Token
    if (e.worker === 'traecode') {
      return await exchangeTraeCallback(e, input);
    }

    // 4. ZCode: 智谱 BigModel / Z.ai OAuth 回调链接或 Coding Plan API Key
    if (e.worker === 'zcode') {
      if (!input) return { ok: false, error: '请粘贴智谱 BigModel / Z.ai API Key 或回调链接' };
      if (input.includes('code=') || input.includes('authCode=')) {
        const u = new URL(input.startsWith('http') || input.startsWith('zcode:') ? input : `http://localhost/?${input.replace(/^[?#]/, '')}`);
        const code = u.searchParams.get('authCode') || u.searchParams.get('code') || '';
        const state = u.searchParams.get('state') || e.oauthState || '';
        const redirectUri = 'https://zcode.z.ai/app/oauth/login?redirect=zcode%3A%2F%2Foauth%2Fcallback&app_version=3.15.0';
        const r = await fetchJsonSmart(ZCODE_OAUTH.tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'bigmodel', code, redirect_uri: redirectUri, state }),
        }, 15_000);
        if (!r.ok || r.json?.code !== 0 || !r.json?.data?.token) {
          throw new Error(r.json?.msg || `ZCode Token 交换失败 (${r.status})`);
        }
        const bm = r.json.data.bigmodel || {};
        await saveZcodeOAuthResult(e.targetHome, 'bigmodel', {
          accessToken: bm.access_token || bm.accessToken || '',
          refreshToken: bm.refresh_token || bm.refreshToken || '',
          zcodeJwtToken: r.json.data.token,
        });
      } else {
        await saveZcodeOAuthResult(e.targetHome, 'bigmodel', { apiKey: input });
      }
      e.buf += `\n[ZCode] ✓ ZCode 凭据已加密写入 ${join(e.targetHome, '.zcode/v2/credentials.json')}\n`;
      e.exited = true;
      e.code = 0;
      cleanupSessionResources(e);
      return { ok: true, worker: 'zcode', note: 'ZCode 凭据已加密保存并生效' };
    }

    // 5. CodeArts: AK/SK
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
      e.exited = true;
      e.code = 0;
      cleanupSessionResources(e);
      return res;
    }

    // 6. MiniMaxCode: 支持直接粘贴 sk-... API Key 或向 PTY 发送输入
    if (e.worker === 'minimaxcode' && /^sk-[A-Za-z0-9_-]{10,}$/.test(input)) {
      const mmxFile = join(e.targetHome, '.mmx', 'config.json');
      await mkdir(dirname(mmxFile), { recursive: true });
      let cfg = { region: 'cn' };
      try { cfg = JSON.parse(await readFile(mmxFile, 'utf-8')); } catch { /* ignore */ }
      cfg.api_key = input;
      await writeFile(mmxFile, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
      e.buf += `\n[MiniMax] ✓ API Key 已直接写入 ${mmxFile}\n`;
      e.exited = true;
      e.code = 0;
      cleanupSessionResources(e);
      clearQuotaCache('minimaxcode');
      return { ok: true, worker: 'minimaxcode', note: 'MiniMax API Key 已保存并生效' };
    }

    // 7. CodeBuddy / CodeBuddy-CN: 支持直接粘贴 auth.info JSON 或 accessToken
    if ((e.worker === 'codebuddy' || e.worker === 'codebuddy-cn') && input) {
      const dirName = e.worker === 'codebuddy-cn' ? '.codebuddy-cn' : '.codebuddy';
      const authInfoFile = join(e.targetHome, dirName, 'auth.info');
      await mkdir(dirname(authInfoFile), { recursive: true });
      let payload;
      try {
        payload = JSON.parse(input);
      } catch {
        payload = { auth: { accessToken: input.replace(/^Bearer\s+/i, '').trim() }, updatedAt: new Date().toISOString() };
      }
      await writeFile(authInfoFile, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
      e.buf += `\n[CodeBuddy] ✓ 凭据已写入 ${authInfoFile}\n`;
      e.exited = true;
      e.code = 0;
      cleanupSessionResources(e);
      clearQuotaCache(e.worker);
      return { ok: true, worker: e.worker, note: `${e.worker} 凭据已保存并生效` };
    }

    // 8. GitHub Copilot: 支持直接粘贴 gho_ / ghu_ / github_pat_ Token
    if (e.worker === 'github-copilot' && /^(gh[opusr]_|github_pat_)[A-Za-z0-9_]{10,}$/.test(input)) {
      const mirror = join(e.targetHome, '.config', 'github-copilot', 'copilot-token');
      await mkdir(dirname(mirror), { recursive: true });
      await writeFile(mirror, input, { mode: 0o600 });
      if (!e.sandbox) {
        try { await execFile('python3', [SECRET_HELPER, '--set', 'copilot-cli', 'https://github.com', input], { timeout: 6000 }); } catch { /* ignore */ }
      }
      e.buf += `\n[Copilot] ✓ GitHub Copilot Token 已保存\n`;
      e.exited = true;
      e.code = 0;
      cleanupSessionResources(e);
      clearQuotaCache('github-copilot');
      return { ok: true, worker: 'github-copilot', note: 'GitHub Copilot Token 已保存并生效' };
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
}

export function finishLogin(loginId) {
  const e = sessions.get(loginId);
  if (!e) return { ok: false, error: '登录会话不存在或已过期' };
  clearQuotaCache(e.worker);
  cleanupSessionResources(e);
  sessions.delete(loginId);
  return { ok: true };
}

// ---------------------------------------------------------------- 退出登录（全部 9 个 Worker）
export async function logout(worker) {
  const files = LOGOUT_FILES[worker];
  if (!files) return { ok: false, error: `该 worker 无可退出的凭据文件: ${worker}` };
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
  return { ok: true, worker, moved, backup: destDir, note: '凭据已安全移入备份目录并清空配额缓存（可随时恢复）' };
}

// ---------------------------------------------------------------- CodeArts AK/SK
async function _saveCodeArtsToHome(targetHome, ak, sk) {
  if (!/^[\w-]{8,128}$/.test(ak) || !/^[\w-]{8,128}$/.test(sk)) {
    return { ok: false, error: 'AK/SK 格式不合法（仅限字母数字-_，长度 8~128）' };
  }
  const envFile = join(targetHome, '.config', 'agenthub-codearts', 'codearts-auth.env');
  await mkdir(dirname(envFile), { recursive: true });
  const body = `# Multi-Agent Hub CodeArts AK/SK (written via WebUI ${new Date().toISOString()})\nCODEARTS_CLI_AK=${ak}\nCODEARTS_CLI_SK=${sk}\n`;
  await writeFile(envFile, body, { mode: 0o600 });
  clearQuotaCache('codearts');
  return { ok: true, worker: 'codearts', note: 'CodeArts AK/SK 已保存（0600），配额状态已更新' };
}

async function _saveCodeArts(ak, sk) {
  return _saveCodeArtsToHome(HOME, ak, sk);
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
