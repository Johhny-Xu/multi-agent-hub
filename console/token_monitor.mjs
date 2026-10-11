import crypto from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import { readdir, readFile, stat, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import { join, resolve, basename } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

// ============================================================================
// Model Pricing Table (USD per 1M tokens: [input, output, cacheRead])
// Adapted from Javis603/token-monitor (MIT) & Tokscale pricing catalog
// ============================================================================
const MODEL_PRICING_PER_1M = [
  [/claude-opus-4/i, 15.0, 75.0, 1.5],
  [/claude-sonnet-4|claude-3-[57]-sonnet/i, 3.0, 15.0, 0.3],
  [/claude-haiku-4|claude-3-5-haiku/i, 0.8, 4.0, 0.08],
  [/gpt-5\.4-pro|o3-pro/i, 15.0, 60.0, 3.75],
  [/gpt-5|gpt-4\.1|gpt-4o(?!-mini)|o3(?!-mini)|o1/i, 2.5, 10.0, 0.625],
  [/gpt-5-mini|gpt-4\.1-mini|gpt-4o-mini|o3-mini|o4-mini|codex-mini/i, 0.4, 1.6, 0.1],
  [/gemini-2\.5-pro|gemini-3\.1-pro|gemini-pro/i, 1.25, 10.0, 0.31],
  [/gemini-2\.5-flash|gemini-3-flash|gemini-flash/i, 0.15, 0.6, 0.0375],
  [/glm-5|glm-4\.7|glm-4-plus/i, 0.7, 2.8, 0.14],
  [/glm-4-air|glm-4-flash|glm/i, 0.14, 0.56, 0.03],
  [/minimax-m2\.7|minimax-m1|abab/i, 0.3, 1.2, 0.06],
  [/deepseek-r1|deepseek-reasoner/i, 0.55, 2.19, 0.14],
  [/deepseek-v3|deepseek-chat|deepseek/i, 0.27, 1.1, 0.07],
  [/qwen3-coder-plus|qwen-max/i, 1.6, 6.4, 0.32],
  [/qwen3-coder|qwen-plus|qwen/i, 0.4, 1.2, 0.08],
  [/mimo-v2|mimo/i, 0.3, 1.2, 0.06],
  [/kimi-k2|moonshot/i, 0.6, 2.5, 0.15],
];

const DEFAULT_PRICING_PER_1M = [1.0, 4.0, 0.2];

export function estimateCostUsd(model, inputTokens, outputTokens, cacheReadTokens = 0) {
  const m = String(model || '');
  let rates = DEFAULT_PRICING_PER_1M;
  for (const [regex, inRate, outRate, cacheRate] of MODEL_PRICING_PER_1M) {
    if (regex.test(m)) {
      rates = [inRate, outRate, cacheRate];
      break;
    }
  }
  const billableInput = Math.max(0, inputTokens - cacheReadTokens);
  const cost = (billableInput * rates[0] + outputTokens * rates[1] + cacheReadTokens * rates[2]) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

// ============================================================================
// Tool Catalog & Local Session Source Paths (compatible with token-monitor)
// ============================================================================
export const TOOL_CATALOG = [
  { id: 'antigravity', name: 'Antigravity', vendor: 'Google', color: '#3b82f6' },
  { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', color: '#d97706' },
  { id: 'codex', name: 'OpenAI Codex', vendor: 'OpenAI', color: '#10b981' },
  { id: 'zcode', name: 'ZCode / GLM', vendor: 'Z.ai / 智谱', color: '#6366f1' },
  { id: 'minimaxcode', name: 'MiniMax Code', vendor: 'MiniMax', color: '#ec4899' },
  { id: 'dsh', name: 'DeepSeek / DSH', vendor: 'DeepSeek', color: '#0ea5e9' },
  { id: 'codebuddy', name: 'CodeBuddy (Intl)', vendor: 'Tencent', color: '#06b6d4' },
  { id: 'codebuddy-cn', name: 'CodeBuddy (CN)', vendor: 'Tencent', color: '#14b8a6' },
  { id: 'workbuddy', name: 'WorkBuddy', vendor: 'Tencent', color: '#0891b2' },
  { id: 'traecode', name: 'Trae / SOLO', vendor: 'ByteDance', color: '#8b5cf6' },
  { id: 'github-copilot', name: 'GitHub Copilot', vendor: 'GitHub', color: '#a855f7' },
  { id: 'mimocode', name: 'MiMo Code', vendor: 'Xiaomi', color: '#f97316' },
  { id: 'codearts', name: 'CodeArts Agent', vendor: 'Huawei', color: '#ef4444' },
  { id: 'kimi', name: 'Kimi Code / CLI', vendor: 'Moonshot', color: '#eab308' },
  { id: 'qwen', name: 'Qwen CLI', vendor: 'Alibaba', color: '#f59e0b' },
  { id: 'cline', name: 'Cline / Roo', vendor: 'Community', color: '#64748b' },
];

function resolveToolRoots(homeDir = os.homedir(), env = process.env) {
  const xdgData = (env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim()) || join(homeDir, '.local', 'share');
  const codexHome = (env.CODEX_HOME && env.CODEX_HOME.trim()) || join(homeDir, '.codex');
  const zcodeBase = (env.ZCODE_DATA_BASE_DIR && env.ZCODE_DATA_BASE_DIR.trim()) || homeDir;
  const minimaxBase = (env.MINIMAX_DATA_DIR && env.MINIMAX_DATA_DIR.trim())
    || (env.MAVIS_DATA_DIR && env.MAVIS_DATA_DIR.trim())
    || join(homeDir, '.minimax');
  const dshBase = (env.DSH_HOME && env.DSH_HOME.trim()) || join(homeDir, '.dsh');

  return {
    antigravity: [
      join(homeDir, '.gemini', 'antigravity', 'brain'),
      join(homeDir, '.gemini', 'antigravity-cli', 'conversations'),
    ],
    claude: [
      join(homeDir, '.claude', 'projects'),
      join(homeDir, '.claude', 'transcripts'),
    ],
    codex: [
      join(codexHome, 'sessions'),
      join(codexHome, 'archived_sessions'),
    ],
    zcode: [
      join(zcodeBase, '.zcode', 'projects'),
      join(zcodeBase, '.zcode', 'v2', 'sessions'),
      join(zcodeBase, '.zcode', 'cli', 'agents'),
      join(homeDir, '.zcode', 'cli', 'agents'),
    ],
    minimaxcode: [
      join(minimaxBase, 'v2', 'sessions'),
      join(homeDir, '.mavis', 'v2', 'sessions'),
      join(homeDir, '.minimax', 'sessions'),
      join(homeDir, '.minimax', 'agents'),
    ],
    dsh: [
      join(dshBase, 'sessions'),
    ],
    codebuddy: [
      join(homeDir, '.codebuddy', 'projects'),
    ],
    'codebuddy-cn': [
      join(homeDir, '.codebuddy-cn', 'projects'),
    ],
    workbuddy: [
      join(homeDir, '.workbuddy', 'projects'),
    ],
    'github-copilot': [
      join(homeDir, '.copilot', 'otel'),
    ],
    mimocode: [
      join(xdgData, 'mimocode'),
      ...(process.platform === 'win32' && env.APPDATA ? [join(env.APPDATA, 'Xiaomi MiMo')] : []),
    ],
    kimi: [
      join(homeDir, '.kimi', 'sessions'),
      join(homeDir, '.kimi-code', 'sessions'),
    ],
    qwen: [
      join(homeDir, '.qwen', 'projects'),
    ],
    cline: [
      join(homeDir, '.cline', 'data', 'sessions'),
    ],
  };
}

function localDayKey(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function estTextTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  let cjk = 0;
  const len = Math.min(s.length, 40_000);
  for (let i = 0; i < len; i++) {
    const c = s.codePointAt(i);
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
  }
  const scale = s.length / len;
  return Math.max(1, Math.ceil((cjk + (len - cjk) / 4) * scale));
}

// ============================================================================
// ZCode Local Credential Discovery & Quota Lookup (ported from token-monitor)
// ============================================================================
const ZCODE_CREDENTIAL_ENVELOPE = 'enc:v1:';

function zcodeCredentialSecret(env = process.env) {
  const explicit = String(env?.ZCODE_CREDENTIAL_SECRET || '').trim();
  if (explicit) return explicit;
  try {
    return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${os.userInfo().username}`;
  } catch {
    return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:unknown`;
  }
}

function decryptZcodeCredential(value, env = process.env) {
  if (typeof value !== 'string' || !value.startsWith(ZCODE_CREDENTIAL_ENVELOPE)) return null;
  const [ivPart, tagPart, cipherPart] = value.slice(ZCODE_CREDENTIAL_ENVELOPE.length).split('.');
  if (!ivPart || !tagPart || !cipherPart) return null;
  try {
    const key = crypto.createHash('sha256').update(zcodeCredentialSecret(env)).digest();
    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(cipherPart, 'base64url')), decipher.final()]).toString('utf8');
    return plain || null;
  } catch {
    return null;
  }
}

function readJsonSyncSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function discoverZcodeLocal(homeDir = os.homedir(), env = process.env) {
  const baseDir = String(env.ZCODE_DATA_BASE_DIR || '').trim() || homeDir;
  const v2Dir = join(baseDir, '.zcode', 'v2');
  const settings = readJsonSyncSafe(join(v2Dir, 'setting.json'));
  const registry = readJsonSyncSafe(join(v2Dir, 'config.json'));
  const store = readJsonSyncSafe(join(v2Dir, 'credentials.json'));
  const telemetry = readJsonSyncSafe(join(v2Dir, 'telemetry-state.json'));
  const deviceMid = String(telemetry?.deviceMid || '').trim() || null;

  for (const k of ['ZAI_API_KEY', 'Z_AI_API_KEY', 'GLM_API_KEY', 'ZHIPU_API_KEY']) {
    if (env[k] && String(env[k]).trim()) {
      const region = /bigmodel|cn/i.test(String(env.ZAI_API_REGION || env.Z_AI_API_HOST || 'bigmodel-cn')) ? 'bigmodel-cn' : 'global';
      return { apiKey: String(env[k]).trim(), region, jwt: null, deviceMid };
    }
  }

  const jwt = decryptZcodeCredential(store?.zcodejwttoken, env);
  const domain = String(settings?.providerFamilyDomain || 'bigmodel').trim();
  const family = domain === 'zai' ? 'zai' : 'bigmodel';
  const region = family === 'zai' ? 'global' : 'bigmodel-cn';

  let apiKey = null;
  if (store && typeof store === 'object') {
    for (const [k, v] of Object.entries(store)) {
      if (k.startsWith(`account-provider:coding-plan:account:${family}-`) && k.endsWith(':api-key')) {
        const dec = decryptZcodeCredential(v, env);
        if (dec) {
          apiKey = dec;
          break;
        }
      }
    }
  }
  if (!apiKey && registry?.provider) {
    for (const id of [`builtin:${family}-coding-plan`, `builtin:${family}-start-plan`, `builtin:${family}`]) {
      const mirror = String(registry.provider?.[id]?.options?.apiKey || '').trim();
      if (mirror) {
        apiKey = mirror;
        break;
      }
    }
  }
  return { apiKey, region, jwt, deviceMid };
}

export async function fetchZcodeQuotas(homeDir = os.homedir(), env = process.env) {
  const { apiKey, region, jwt, deviceMid } = discoverZcodeLocal(homeDir, env);
  const baseUrl = region === 'global' ? 'https://api.z.ai' : 'https://open.bigmodel.cn';
  const quotas = [];
  let planName = '';

  if (apiKey) {
    try {
      const [quotaRes, subRes] = await Promise.allSettled([
        fetch(`${baseUrl}/api/monitor/usage/quota/limit`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
        fetch(`${baseUrl}/api/biz/subscription/list`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        }).then((r) => (r.ok ? r.json() : null)),
      ]);
      if (subRes.status === 'fulfilled' && Array.isArray(subRes.value?.data) && subRes.value.data.length) {
        const sub = subRes.value.data.find((x) => x?.inCurrentPeriod && x?.status === 'VALID') || subRes.value.data[0];
        planName = String(sub?.product_name || sub?.productName || sub?.plan_name || sub?.planName || '').trim();
      }
      if (quotaRes.status === 'fulfilled' && quotaRes.value?.data) {
        const d = quotaRes.value.data;
        if (!planName) planName = String(d.planName || d.plan_name || d.packageName || 'GLM Coding Plan').trim();
        const limits = Array.isArray(d.limits) ? d.limits : [];
        for (const lim of limits) {
          const total = Number(lim.usage ?? lim.total ?? 0);
          const remaining = Number(lim.remaining ?? 0);
          const used = total > 0 ? Math.max(0, total - remaining) : Number(lim.currentValue ?? 0);
          const pct = total > 0 ? Math.round((remaining / total) * 1000) / 10 : Math.max(0, 100 - Number(lim.percentage || 0));
          const unit = Number(lim.unit);
          const num = Number(lim.number);
          const label = unit === 3 && num === 5 ? '5小时窗口 (5h)' : unit === 6 ? '每周额度 (Weekly)' : (lim.type || 'Token 额度');
          quotas.push({
            name: String(lim.type || label),
            displayName: label,
            used,
            total,
            remaining,
            remainingPercentage: Math.max(0, Math.min(100, pct)),
            resetAt: lim.nextResetTime || lim.next_reset_time ? new Date(lim.nextResetTime || lim.next_reset_time).toISOString() : null,
          });
        }
      }
    } catch {
      // ignore and try start-plan billing leg
    }
  }

  const billingToken = jwt || apiKey;
  if (billingToken && !quotas.length) {
    try {
      const res = await fetch('https://zcode.z.ai/api/v1/zcode-plan/billing/balance', {
        headers: {
          Authorization: `Bearer ${billingToken}`,
          Accept: 'application/json',
          ...(deviceMid ? { 'X-Device-Mid': deviceMid } : {}),
        },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const body = await res.json();
        const balances = Array.isArray(body?.data?.balances) ? body.data.balances : [];
        for (const b of balances) {
          const total = Number(b.total_units ?? 0);
          const remaining = Number(b.remaining_units ?? 0);
          const used = Number(b.used_units ?? Math.max(0, total - remaining));
          const remPct = total > 0 ? Math.round((remaining / total) * 1000) / 10 : Math.max(0, 100 - Number(b.percentage || 0));
          const exp = Number(b.expires_at || b.period_end || 0);
          quotas.push({
            name: String(b.plan_id || b.show_name || 'start-plan'),
            displayName: String(b.show_name || 'ZCode Start Plan'),
            used,
            total,
            remaining,
            remainingPercentage: Math.max(0, Math.min(100, remPct)),
            resetAt: exp > 0 ? new Date(exp < 1e12 ? exp * 1000 : exp).toISOString() : null,
          });
        }
        if (!planName) planName = 'ZCode Plan';
      }
    } catch {
      // ignore
    }
  }

  if (quotas.length) {
    return { tracked: true, plan: planName || 'GLM / ZCode Plan', quotas, source: 'token-monitor-native' };
  }
  return { tracked: false };
}

// ============================================================================
// Additional Direct Provider Quota Fetchers (MiniMax, DeepSeek, Copilot, MiMo)
// ============================================================================
export async function fetchMinimaxDirect(homeDir = os.homedir(), env = process.env) {
  let apiKey = String(env.MINIMAX_CODING_API_KEY || env.MINIMAX_API_KEY || '').trim();
  if (!apiKey) {
    const mmxCfg = readJsonSyncSafe(join(homeDir, '.mmx', 'config.json'));
    apiKey = String(mmxCfg?.api_key || mmxCfg?.apiKey || mmxCfg?.token || '').trim();
  }
  if (apiKey) {
    for (const url of [
      'https://api.minimaxi.com/v1/token_plan/remains',
      'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
      'https://api.minimax.io/v1/token_plan/remains',
    ]) {
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) continue;
        const body = await res.json();
        const rows = body?.data?.model_remains || body?.model_remains;
        if (Array.isArray(rows) && rows.length) {
          const nameMap = { general: '通用 (5h窗口)', video: '视频', image: '图像', audio: '音频' };
          const quotas = rows.map((el) => ({
            name: el.model_name || 'general',
            displayName: nameMap[el.model_name] || el.model_name,
            used: Number(el.current_interval_usage_count || 0),
            total: Number(el.current_interval_total_count || 0),
            remaining: Math.max(0, Number(el.current_interval_total_count || 0) - Number(el.current_interval_usage_count || 0)),
            remainingPercentage: Number(el.current_interval_remaining_percent ?? 100),
            weeklyPercentage: Number(el.current_weekly_remaining_percent ?? 100),
            resetAt: el.EndTime ? new Date(Number(el.EndTime) < 1e12 ? Number(el.EndTime) * 1000 : Number(el.EndTime)).toISOString() : null,
          }));
          return { tracked: true, plan: 'MiniMax Token Plan', quotas, source: 'token-monitor-native' };
        }
      } catch {
        // try next endpoint
      }
    }
  }
  return null;
}

export async function fetchDeepSeekDirect(homeDir = os.homedir(), env = process.env) {
  let apiKey = String(env.DEEPSEEK_API_KEY || env.DEEPSEEK_KEY || '').trim();
  if (!apiKey) {
    const dshCfg = readJsonSyncSafe(join(homeDir, '.dsh', 'config.json'));
    apiKey = String(dshCfg?.apiKey || dshCfg?.api_key || dshCfg?.deepseekApiKey || '').trim();
  }
  if (!apiKey) return { tracked: false };
  try {
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { tracked: false };
    const body = await res.json();
    const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
    const row = infos.find((r) => Number(r.total_balance) > 0) || infos[0];
    if (!row) return { tracked: false };
    const bal = Number(row.total_balance || 0);
    return {
      tracked: true,
      plan: `DeepSeek API (${row.currency || 'CNY'})`,
      quotas: [{
        name: 'Credits',
        displayName: `账户余额 (${row.currency || 'CNY'})`,
        used: 0,
        total: bal,
        remaining: bal,
        remainingPercentage: 100,
        isCreditBalance: true,
        currency: row.currency || 'CNY',
      }],
      source: 'token-monitor-native',
    };
  } catch {
    return { tracked: false };
  }
}

export async function fetchCopilotDirect(homeDir = os.homedir(), env = process.env) {
  let token = String(env.COPILOT_API_TOKEN || env.GITHUB_COPILOT_TOKEN || '').trim();
  if (!token) {
    const candidates = [
      join(homeDir, '.config', 'github-copilot', 'hosts.json'),
      join(homeDir, '.config', 'github-copilot', 'apps.json'),
      ...(process.platform === 'win32' && env.LOCALAPPDATA ? [
        join(env.LOCALAPPDATA, 'github-copilot', 'hosts.json'),
        join(env.LOCALAPPDATA, 'github-copilot', 'apps.json'),
      ] : []),
    ];
    for (const p of candidates) {
      const obj = readJsonSyncSafe(p);
      if (obj && typeof obj === 'object') {
        for (const v of Object.values(obj)) {
          if (v && typeof v.oauth_token === 'string' && v.oauth_token.trim()) {
            token = v.oauth_token.trim();
            break;
          }
        }
      }
      if (token) break;
    }
  }
  if (!token) return null;
  try {
    const res = await fetch('https://api.github.com/copilot_internal/user', {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/json',
        'User-Agent': 'GitHubCopilotChat/0.26.7',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const snapshots = data?.quota_snapshots || {};
    const quotas = [];
    for (const [k, snap] of Object.entries(snapshots)) {
      if (!snap || typeof snap !== 'object') continue;
      const total = Number(snap.entitlement ?? 0);
      const rem = Number(snap.remaining ?? 0);
      const unlimited = !!snap.unlimited;
      const pct = unlimited ? 100 : Number(snap.percent_remaining ?? (total > 0 ? (rem / total) * 100 : 100));
      quotas.push({
        name: k,
        displayName: k === 'premium_interactions' ? '高级请求 (Premium)' : k === 'chat' ? '对话 (Chat)' : k,
        used: Math.max(0, total - rem),
        total,
        remaining: rem,
        remainingPercentage: Math.round(pct * 10) / 10,
        unlimited,
        resetAt: data.quota_reset_date || null,
      });
    }
    if (quotas.length) {
      return {
        tracked: true,
        plan: data.copilot_plan || 'GitHub Copilot',
        quotas,
        source: 'token-monitor-native',
      };
    }
  } catch {
    // ignore
  }
  return null;
}

// ============================================================================
// Local Session File Scanner (Incremental mtime/size cache)
// ============================================================================
const fileScanCache = new Map(); // filePath -> { mtimeMs, size, records }

async function walkSessionFiles(dir, maxDepth = 4, maxFiles = 250, out = []) {
  if (maxDepth < 0 || out.length >= maxFiles) return out;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) break;
    const name = entry.name;
    if (name === 'node_modules' || name === '.git' || name === 'cache' || name === 'transcript_full.jsonl') continue;
    const full = join(dir, name);
    if (entry.isDirectory()) {
      await walkSessionFiles(full, maxDepth - 1, maxFiles, out);
    } else if (entry.isFile() && (name.endsWith('.jsonl') || name.endsWith('.json'))) {
      out.push(full);
    }
  }
  return out;
}

function parseJsonlRecord(obj, defaultTool, fallbackDay, fallbackTs, hintModel = '') {
  if (!obj || typeof obj !== 'object') return null;
  let inTok = 0;
  let outTok = 0;
  let cacheTok = 0;
  let model = obj.model || obj.modelId || obj.model_name || obj.message?.model || obj.payload?.model || hintModel || '';

  const u = obj.usage
    || obj.message?.usage
    || obj.response?.usage
    || obj.usageMetadata
    || obj.tokenUsage
    || obj.tokens
    || (obj.payload?.type === 'token_count' ? obj.payload?.info?.last_token_usage : null);
  if (u && typeof u === 'object') {
    inTok = Number(
      u.input_tokens ?? u.prompt_tokens ?? u.inputTokens ?? u.promptTokenCount ?? u.in ?? 0
    ) || 0;
    outTok = Number(
      u.output_tokens ?? u.completion_tokens ?? u.outputTokens ?? u.candidatesTokenCount ?? u.out ?? 0
    ) || 0;
    cacheTok = Number(
      u.cache_read_input_tokens
      ?? u.cached_input_tokens
      ?? u.cached_tokens
      ?? u.cachedContentTokenCount
      ?? u.prompt_cache_hit_tokens
      ?? u.cacheReadTokens
      ?? u.prompt_tokens_details?.cached_tokens
      ?? u.input_tokens_details?.cached_tokens
      ?? 0
    ) || 0;
  } else if (obj.type === 'USER_INPUT' || obj.role === 'user') {
    const content = typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content || '');
    inTok = estTextTokens(content);
  } else if (obj.type === 'PLANNER_RESPONSE' || obj.role === 'assistant' || obj.role === 'model') {
    const content = typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content || '');
    const thinking = typeof obj.thinking === 'string' ? obj.thinking : '';
    outTok = estTextTokens(content + thinking);
  }

  if (inTok <= 0 && outTok <= 0 && cacheTok <= 0) return null;

  const rawTs = obj.timestamp || obj.created_at || obj.createdAt || obj.updatedAt || obj.completedAt || obj.ts || obj.time || fallbackTs;
  const parsedMs = typeof rawTs === 'number'
    ? (rawTs < 1e12 ? rawTs * 1000 : rawTs)
    : Date.parse(String(rawTs || ''));
  const tsMs = Number.isFinite(parsedMs) && parsedMs > 0 ? parsedMs : fallbackTs;
  const day = localDayKey(tsMs);
  if (!model) {
    model = defaultTool === 'antigravity' ? 'gemini-2.5-pro'
      : defaultTool === 'claude' ? 'claude-sonnet-4'
      : defaultTool === 'codex' ? 'gpt-5-codex'
      : defaultTool === 'zcode' ? 'glm-5'
      : defaultTool === 'minimaxcode' ? 'MiniMax-M2.7'
      : defaultTool === 'dsh' ? 'deepseek-chat'
      : `${defaultTool}-default`;
  }

  return {
    inTok,
    outTok,
    cacheTok,
    model: String(model).slice(0, 64),
    day,
    tsMs,
  };
}

async function scanSingleSessionFile(filePath, toolId) {
  let st;
  try {
    st = await stat(filePath);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size <= 0 || st.size > 16 * 1024 * 1024) return null;
  const cached = fileScanCache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.summary;
  }

  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  const fallbackTs = st.mtimeMs || Date.now();
  const fallbackDay = localDayKey(fallbackTs);
  let inTok = 0;
  let outTok = 0;
  let cacheTok = 0;
  let turns = 0;
  let primaryModel = '';
  let hintModel = '';
  const byDayModel = new Map(); // `${day}|${model}` -> { day, model, inTok, outTok, cacheTok, turns }

  const addRec = (rec) => {
    if (!rec) return;
    inTok += rec.inTok;
    outTok += rec.outTok;
    cacheTok += rec.cacheTok;
    turns += 1;
    if (rec.model) primaryModel = rec.model;
    const key = `${rec.day}|${rec.model}`;
    let bucket = byDayModel.get(key);
    if (!bucket) {
      bucket = { day: rec.day, model: rec.model, inTok: 0, outTok: 0, cacheTok: 0, turns: 0 };
      byDayModel.set(key, bucket);
    }
    bucket.inTok += rec.inTok;
    bucket.outTok += rec.outTok;
    bucket.cacheTok += rec.cacheTok;
    bucket.turns += 1;
  };

  if (filePath.endsWith('.jsonl')) {
    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== '{') continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj?.type === 'turn_context' && obj?.payload?.model) {
          hintModel = String(obj.payload.model);
        }
        addRec(parseJsonlRecord(obj, toolId, fallbackDay, fallbackTs, hintModel));
      } catch {
        // skip malformed line
      }
    }
  } else if (filePath.endsWith('.json')) {
    try {
      const obj = JSON.parse(raw);
      const arr = Array.isArray(obj) ? obj : (Array.isArray(obj?.messages) ? obj.messages : [obj]);
      for (const item of arr) {
        addRec(parseJsonlRecord(item, toolId, fallbackDay, fallbackTs, hintModel));
      }
    } catch {
      // skip
    }
  }

  const summary = {
    toolId,
    filePath,
    sessionTitle: basename(filePath).replace(/\.(jsonl|json)$/i, '').slice(0, 48),
    mtimeMs: fallbackTs,
    day: fallbackDay,
    inTok,
    outTok,
    cacheTok,
    turns,
    model: primaryModel || `${toolId}-default`,
    slices: [...byDayModel.values()],
  };
  fileScanCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, summary });
  return summary;
}

// ============================================================================
// External Token Monitor Hub Bridge (port 17321) & Config Manager
// ============================================================================
export function createTokenMonitorEngine({ dataDir, getHubUsage, getQuotas }) {
  const configPath = join(dataDir, 'token-monitor-config.json');
  let config = {
    externalHubUrl: process.env.TOKEN_MONITOR_HUB_URL || 'http://127.0.0.1:17321',
    externalHubSecret: process.env.TOKEN_MONITOR_SECRET || '',
    externalExportPath: process.env.TOKEN_MONITOR_EXPORT_PATH || '',
    currency: 'USD',
    cnyRate: 7.25,
    enableExternalBridge: true,
    minimaxApiKey: '',
    deepseekApiKey: '',
  };
  try {
    if (fs.existsSync(configPath)) {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (saved && typeof saved === 'object') config = { ...config, ...saved };
      if (config.minimaxApiKey && !process.env.MINIMAX_API_KEY) process.env.MINIMAX_API_KEY = config.minimaxApiKey;
      if (config.deepseekApiKey && !process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = config.deepseekApiKey;
    }
  } catch {
    // use defaults
  }

  async function saveConfig(patch = {}) {
    if (typeof patch.externalHubUrl === 'string') config.externalHubUrl = patch.externalHubUrl.trim().replace(/\/+$/, '');
    if (typeof patch.externalHubSecret === 'string') config.externalHubSecret = patch.externalHubSecret.trim();
    if (typeof patch.externalHubToken === 'string') config.externalHubSecret = patch.externalHubToken.trim();
    if (typeof patch.externalExportPath === 'string') config.externalExportPath = patch.externalExportPath.trim();
    if (patch.currency === 'USD' || patch.currency === 'CNY') config.currency = patch.currency;
    if (typeof patch.cnyRate === 'number' && patch.cnyRate > 0) config.cnyRate = patch.cnyRate;
    if (typeof patch.usdToCny === 'number' && patch.usdToCny > 0) config.cnyRate = patch.usdToCny;
    if (typeof patch.enableExternalBridge === 'boolean') config.enableExternalBridge = patch.enableExternalBridge;
    if (typeof patch.externalHubEnabled === 'boolean') config.enableExternalBridge = patch.externalHubEnabled;
    if (typeof patch.minimaxApiKey === 'string' && patch.minimaxApiKey.trim()) {
      config.minimaxApiKey = patch.minimaxApiKey.trim();
      process.env.MINIMAX_API_KEY = config.minimaxApiKey;
    }
    if (typeof patch.deepseekApiKey === 'string' && patch.deepseekApiKey.trim()) {
      config.deepseekApiKey = patch.deepseekApiKey.trim();
      process.env.DEEPSEEK_API_KEY = config.deepseekApiKey;
    }
    const tmp = `${configPath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
    await rename(tmp, configPath);
    cachedDashboard = null;
    return getPublicConfig();
  }

  function getPublicConfig() {
    return {
      externalHubUrl: config.externalHubUrl,
      hasSecret: Boolean(config.externalHubSecret),
      hasExternalToken: Boolean(config.externalHubSecret),
      externalExportPath: config.externalExportPath,
      currency: config.currency,
      cnyRate: config.cnyRate,
      usdToCny: config.cnyRate,
      enableExternalBridge: config.enableExternalBridge,
      externalHubEnabled: config.enableExternalBridge,
      hasMinimaxKey: Boolean(config.minimaxApiKey || process.env.MINIMAX_API_KEY || process.env.MINIMAX_CODING_API_KEY),
      hasDeepseekKey: Boolean(config.deepseekApiKey || process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY),
    };
  }

  async function probeExternalTokenMonitorHub() {
    if (!config.enableExternalBridge || !config.externalHubUrl) {
      return { connected: false, mode: 'disabled' };
    }
    const headers = { Accept: 'application/json' };
    if (config.externalHubSecret) {
      headers.Authorization = `Bearer ${config.externalHubSecret}`;
    }
    try {
      const [statsRes, devicesRes] = await Promise.all([
        fetch(`${config.externalHubUrl}/api/stats`, { headers, signal: AbortSignal.timeout(2500) }),
        fetch(`${config.externalHubUrl}/api/devices`, { headers, signal: AbortSignal.timeout(2500) }).catch(() => null),
      ]);
      if (!statsRes.ok) {
        return { connected: false, mode: 'unreachable', status: statsRes.status };
      }
      const stats = await statsRes.json();
      const devices = devicesRes && devicesRes.ok ? await devicesRes.json() : [];
      return {
        connected: true,
        mode: 'hub-17321',
        source: '17321-hub',
        hubUrl: config.externalHubUrl,
        stats,
        devices: Array.isArray(devices) ? devices : (devices?.devices || []),
      };
    } catch {
      // Fallback: check externalExportPath if configured
      if (config.externalExportPath) {
        try {
          const exportFile = config.externalExportPath.endsWith('.json')
            ? config.externalExportPath
            : join(config.externalExportPath, 'token-monitor-export.json');
          const raw = JSON.parse(await readFile(exportFile, 'utf8'));
          return {
            connected: true,
            mode: 'export-json',
            source: 'export-json',
            exportFile,
            stats: raw.stats || raw,
            devices: raw.devices || [],
          };
        } catch {
          // ignore
        }
      }
      return { connected: false, mode: 'standby', hubUrl: config.externalHubUrl };
    }
  }

  let cachedDashboard = null;
  let cachedAt = 0;

  async function buildDashboard({ force = false } = {}) {
    const now = Date.now();
    if (!force && cachedDashboard && now - cachedAt < 15_000) {
      return cachedDashboard;
    }

    const homeDir = os.homedir();
    const rootsByTool = resolveToolRoots(homeDir, process.env);
    const detectedTools = new Set();
    const allSessionSummaries = [];
    let scannedFilesCount = 0;

    await Promise.all(Object.entries(rootsByTool).map(async ([toolId, dirs]) => {
      for (const dir of dirs) {
        try {
          const st = await stat(dir);
          if (!st.isDirectory()) continue;
          detectedTools.add(toolId);
          const files = await walkSessionFiles(dir, 4, 150);
          scannedFilesCount += files.length;
          const summaries = await Promise.all(files.map((f) => scanSingleSessionFile(f, toolId)));
          for (const s of summaries) {
            if (s && (s.inTok > 0 || s.outTok > 0 || s.cacheTok > 0)) {
              allSessionSummaries.push(s);
            }
          }
        } catch {
          // directory not present
        }
      }
    }));

    // Merge Multi-Agent Hub's own console usage (data/usage.json)
    const hubUsage = typeof getHubUsage === 'function' ? getHubUsage() : null;
    if (hubUsage && hubUsage.days) {
      for (const [day, dayObj] of Object.entries(hubUsage.days)) {
        const agents = dayObj.agents || {};
        for (const [agName, agStat] of Object.entries(agents)) {
          const inTok = Number(agStat.in || 0);
          const outTok = Number(agStat.out || 0);
          if (inTok <= 0 && outTok <= 0) continue;
          detectedTools.add(agName);
          allSessionSummaries.push({
            toolId: agName,
            filePath: `hub://${agName}/${day}`,
            sessionTitle: `Hub 派发会话 (${day})`,
            mtimeMs: Date.parse(`${day}T12:00:00Z`) || now,
            day,
            inTok,
            outTok,
            cacheTok: 0,
            turns: Number(agStat.msgs || agStat.runs || 1),
            model: `${agName}-hub`,
            slices: [{ day, model: `${agName}-hub`, inTok, outTok, cacheTok: 0, turns: Number(agStat.msgs || 1) }],
          });
        }
      }
    }

    // Check external Token Monitor Hub (17321) & provider quotas in parallel
    const [externalBridge, quotas] = await Promise.all([
      probeExternalTokenMonitorHub(),
      typeof getQuotas === 'function' ? getQuotas().catch(() => ({})) : Promise.resolve({}),
    ]);

    const todayKey = localDayKey(now);
    const d7Key = localDayKey(now - 6 * 86400_000);
    const d30Key = localDayKey(now - 29 * 86400_000);

    const makeBucket = () => ({
      inTok: 0,
      outTok: 0,
      cacheTok: 0,
      totalTok: 0,
      costUsd: 0,
      turns: 0,
    });

    const periods = {
      today: makeBucket(),
      week: makeBucket(),
      month: makeBucket(),
      allTime: makeBucket(),
    };

    const byToolMap = new Map();
    for (const t of TOOL_CATALOG) {
      byToolMap.set(t.id, {
        id: t.id,
        name: t.name,
        vendor: t.vendor,
        color: t.color,
        detected: detectedTools.has(t.id) || Boolean(quotas?.[t.id]?.tracked),
        today: makeBucket(),
        week: makeBucket(),
        month: makeBucket(),
        allTime: makeBucket(),
        sessionsCount: 0,
        models: new Set(),
      });
    }

    const byModelMap = new Map();
    const dailyMap = new Map(); // day -> { day, inTok, outTok, cacheTok, totalTok, costUsd, turns, byTool: {} }

    const addSliceToBucket = (b, inTok, outTok, cacheTok, costUsd, turns) => {
      b.inTok += inTok;
      b.outTok += outTok;
      b.cacheTok += cacheTok;
      b.totalTok += inTok + outTok + cacheTok;
      b.costUsd = Math.round((b.costUsd + costUsd) * 1_000_000) / 1_000_000;
      b.turns += turns;
    };

    for (const sess of allSessionSummaries) {
      let toolEntry = byToolMap.get(sess.toolId);
      if (!toolEntry) {
        toolEntry = {
          id: sess.toolId,
          name: sess.toolId,
          vendor: 'Custom',
          color: '#64748b',
          detected: true,
          today: makeBucket(),
          week: makeBucket(),
          month: makeBucket(),
          allTime: makeBucket(),
          sessionsCount: 0,
          models: new Set(),
        };
        byToolMap.set(sess.toolId, toolEntry);
      }
      toolEntry.detected = true;
      toolEntry.sessionsCount += 1;

      for (const sl of sess.slices) {
        const cost = estimateCostUsd(sl.model, sl.inTok, sl.outTok, sl.cacheTok);
        toolEntry.models.add(sl.model);

        addSliceToBucket(periods.allTime, sl.inTok, sl.outTok, sl.cacheTok, cost, sl.turns);
        addSliceToBucket(toolEntry.allTime, sl.inTok, sl.outTok, sl.cacheTok, cost, sl.turns);

        if (sl.day === todayKey) {
          addSliceToBucket(periods.today, sl.inTok, sl.outTok, sl.cacheTok, cost, sl.turns);
          addSliceToBucket(toolEntry.today, sl.inTok, sl.outTok, sl.cacheTok, cost, sl.turns);
        }
        if (sl.day >= d7Key) {
          addSliceToBucket(periods.week, sl.inTok, sl.outTok, sl.cacheTok, cost, sl.turns);
          addSliceToBucket(toolEntry.week, sl.inTok, sl.outTok, sl.cacheTok, cost, sl.turns);
        }
        if (sl.day >= d30Key) {
          addSliceToBucket(periods.month, sl.inTok, sl.outTok, sl.cacheTok, cost, sl.turns);
          addSliceToBucket(toolEntry.month, sl.inTok, sl.outTok, sl.cacheTok, cost, sl.turns);
        }

        let modEntry = byModelMap.get(sl.model);
        if (!modEntry) {
          modEntry = {
            model: sl.model,
            tools: new Set(),
            today: makeBucket(),
            week: makeBucket(),
            month: makeBucket(),
            allTime: makeBucket(),
          };
          byModelMap.set(sl.model, modEntry);
        }
        modEntry.tools.add(sess.toolId);
        addSliceToBucket(modEntry.allTime, sl.inTok, sl.outTok, sl.cacheTok, cost, sl.turns);
        if (sl.day === todayKey) addSliceToBucket(modEntry.today, sl.inTok, sl.outTok, sl.cacheTok, cost, sl.turns);
        if (sl.day >= d7Key) addSliceToBucket(modEntry.week, sl.inTok, sl.outTok, sl.cacheTok, cost, sl.turns);
        if (sl.day >= d30Key) addSliceToBucket(modEntry.month, sl.inTok, sl.outTok, sl.cacheTok, cost, sl.turns);

        let dayEntry = dailyMap.get(sl.day);
        if (!dayEntry) {
          dayEntry = { day: sl.day, inTok: 0, outTok: 0, cacheTok: 0, totalTok: 0, costUsd: 0, turns: 0, byTool: {} };
          dailyMap.set(sl.day, dayEntry);
        }
        dayEntry.inTok += sl.inTok;
        dayEntry.outTok += sl.outTok;
        dayEntry.cacheTok += sl.cacheTok;
        dayEntry.totalTok += sl.inTok + sl.outTok + sl.cacheTok;
        dayEntry.costUsd = Math.round((dayEntry.costUsd + cost) * 1_000_000) / 1_000_000;
        dayEntry.turns += sl.turns;
        dayEntry.byTool[sess.toolId] = (dayEntry.byTool[sess.toolId] || 0) + sl.inTok + sl.outTok + sl.cacheTok;
      }
    }

    // Build 365-day activity heatmap & streak statistics
    const heatmapRaw = [];
    let currentStreak = 0;
    let longestStreak = 0;
    let runningStreak = 0;
    let activeDays = 0;
    let maxHeatTok = 0;

    for (let i = 364; i >= 0; i--) {
      const dayStr = localDayKey(now - i * 86400_000);
      const d = dailyMap.get(dayStr);
      const totalTok = d ? d.totalTok : 0;
      const costUsd = d ? d.costUsd : 0;
      if (totalTok > maxHeatTok) maxHeatTok = totalTok;
      if (totalTok > 0) {
        activeDays += 1;
        runningStreak += 1;
        if (runningStreak > longestStreak) longestStreak = runningStreak;
      } else if (i > 0) {
        runningStreak = 0;
      }
      heatmapRaw.push({
        day: dayStr,
        date: dayStr,
        totalTok,
        tokens: totalTok,
        costUsd,
        turns: d ? d.turns : 0,
        messages: d ? d.turns : 0,
      });
    }
    currentStreak = runningStreak;
    const heatmap = heatmapRaw.map((cell) => {
      let level = 0;
      if (cell.totalTok > 0 && maxHeatTok > 0) {
        const ratio = cell.totalTok / maxHeatTok;
        level = ratio > 0.65 ? 4 : ratio > 0.35 ? 3 : ratio > 0.12 ? 2 : 1;
      }
      return { ...cell, level };
    });

    const dailyHistory = [];
    for (let i = 29; i >= 0; i--) {
      const dayStr = localDayKey(now - i * 86400_000);
      const d = dailyMap.get(dayStr);
      dailyHistory.push({
        date: dayStr,
        day: dayStr,
        totalTokens: d ? d.totalTok : 0,
        inputTokens: d ? d.inTok : 0,
        outputTokens: d ? d.outTok : 0,
        cacheRead: d ? d.cacheTok : 0,
        costUsd: d ? d.costUsd : 0,
        messages: d ? d.turns : 0,
      });
    }

    const byTool = [...byToolMap.values()]
      .map((t) => ({
        ...t,
        models: [...t.models],
        cacheHitRate: (t.allTime.inTok + t.allTime.cacheTok) > 0
          ? Math.round((t.allTime.cacheTok / (t.allTime.inTok + t.allTime.cacheTok)) * 1000) / 10
          : 0,
      }))
      .sort((a, b) => (b.allTime.totalTok - a.allTime.totalTok) || (Number(b.detected) - Number(a.detected)));

    const byModel = [...byModelMap.values()]
      .map((m) => ({
        ...m,
        tools: [...m.tools],
        cacheHitRate: (m.allTime.inTok + m.allTime.cacheTok) > 0
          ? Math.round((m.allTime.cacheTok / (m.allTime.inTok + m.allTime.cacheTok)) * 1000) / 10
          : 0,
      }))
      .sort((a, b) => b.allTime.totalTok - a.allTime.totalTok);

    const periodLabels = {
      today: '今日',
      week: '本周 (近7天)',
      month: '本月 (近30天)',
      allTime: '全部累计',
    };
    for (const pKey of ['today', 'week', 'month', 'allTime']) {
      const pb = periods[pKey];
      const pTot = pb.totalTok || 0;
      const pTools = byTool
        .filter((t) => t[pKey] && t[pKey].totalTok > 0)
        .map((t) => {
          const tb = t[pKey];
          const hitRate = (tb.inTok + tb.cacheTok) > 0
            ? Math.round((tb.cacheTok / (tb.inTok + tb.cacheTok)) * 1000) / 10
            : 0;
          return {
            tool: t.id,
            displayName: t.name,
            vendor: t.vendor,
            color: t.color,
            totalTokens: tb.totalTok,
            inputTokens: tb.inTok,
            outputTokens: tb.outTok,
            cacheRead: tb.cacheTok,
            cacheHitRate: hitRate,
            messages: tb.turns,
            sharePercentage: pTot > 0 ? Math.round((tb.totalTok / pTot) * 1000) / 10 : 0,
            costUsd: tb.costUsd,
          };
        })
        .sort((a, b) => b.totalTokens - a.totalTokens);

      const pModels = byModel
        .filter((m) => m[pKey] && m[pKey].totalTok > 0)
        .map((m) => {
          const mb = m[pKey];
          return {
            model: m.model,
            tools: m.tools,
            totalTokens: mb.totalTok,
            inputTokens: mb.inTok,
            outputTokens: mb.outTok,
            cacheRead: mb.cacheTok,
            messages: mb.turns,
            sharePercentage: pTot > 0 ? Math.round((mb.totalTok / pTot) * 1000) / 10 : 0,
            costUsd: mb.costUsd,
          };
        })
        .sort((a, b) => b.totalTokens - a.totalTokens);

      pb.label = periodLabels[pKey];
      pb.totalTokens = pb.totalTok;
      pb.inputTokens = pb.inTok;
      pb.outputTokens = pb.outTok;
      pb.cacheRead = pb.cacheTok;
      pb.cacheWrite = 0;
      pb.costCny = Math.round(pb.costUsd * config.cnyRate * 100) / 100;
      pb.messages = pb.turns;
      pb.sessionsCount = allSessionSummaries.length;
      pb.toolsCount = pTools.length;
      pb.cacheHitRate = (pb.inTok + pb.cacheTok) > 0
        ? Math.round((pb.cacheTok / (pb.inTok + pb.cacheTok)) * 1000) / 10
        : 0;
      pb.tools = pTools;
      pb.models = pModels;
    }

    const recentSessions = allSessionSummaries
      .slice()
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 40)
      .map((s) => {
        const cat = byToolMap.get(s.toolId);
        return {
          toolId: s.toolId,
          tool: s.toolId,
          toolDisplay: cat ? cat.name : s.toolId,
          color: cat ? cat.color : '#38bdf8',
          title: s.sessionTitle,
          sessionId: s.sessionTitle,
          model: s.model,
          primaryModel: s.model,
          day: s.day,
          date: s.day,
          updatedAt: new Date(s.mtimeMs).toISOString(),
          inTok: s.inTok,
          outTok: s.outTok,
          cacheTok: s.cacheTok,
          totalTok: s.inTok + s.outTok + s.cacheTok,
          totalTokens: s.inTok + s.outTok + s.cacheTok,
          costUsd: estimateCostUsd(s.model, s.inTok, s.outTok, s.cacheTok),
          turns: s.turns,
          messages: s.turns,
        };
      });

    const localHostDevice = {
      deviceId: os.hostname(),
      hostname: os.hostname(),
      platform: `${process.platform} (${os.arch()})`,
      online: true,
      source: 'local-native',
      updatedAt: new Date(now).toISOString(),
      todayTok: periods.today.totalTok,
      allTimeTok: periods.allTime.totalTok,
      totalTokens: periods.allTime.totalTok,
      costUsd: periods.allTime.costUsd,
      detectedToolsCount: byTool.filter((t) => t.detected).length,
    };

    const devices = [
      localHostDevice,
      ...(externalBridge.connected && Array.isArray(externalBridge.devices)
        ? externalBridge.devices.map((d) => ({
            deviceId: d.deviceId || d.id || 'remote-device',
            hostname: d.hostname || d.deviceId || d.id || 'remote-device',
            platform: d.platform || d.os || 'remote',
            online: d.stale !== true,
            source: 'token-monitor-hub',
            updatedAt: d.updatedAt || new Date(now).toISOString(),
            todayTok: Number(d.today?.tokens || d.todayTokens || 0),
            allTimeTok: Number(d.allTime?.tokens || d.totalTokens || 0),
            totalTokens: Number(d.allTime?.tokens || d.totalTokens || 0),
            costUsd: Number(d.allTime?.cost || d.totalCost || 0),
            detectedToolsCount: Object.keys(d.clients || d.tools || {}).length,
          }))
        : []),
    ];

    cachedDashboard = {
      updatedAt: new Date(now).toISOString(),
      scannedFiles: scannedFilesCount,
      config: getPublicConfig(),
      externalBridge: {
        connected: externalBridge.connected,
        mode: externalBridge.mode,
        source: externalBridge.source || externalBridge.mode,
        hubUrl: config.externalHubUrl,
        devices,
      },
      periods,
      streaks: {
        currentStreak,
        longestStreak,
        activeDays,
      },
      byTool,
      byModel,
      recentSessions,
      heatmap,
      dailyHistory,
      daily: [...dailyMap.values()].sort((a, b) => b.day.localeCompare(a.day)).slice(0, 90),
      devices,
      quotas: quotas || {},
    };
    cachedAt = now;
    return cachedDashboard;
  }

  async function exportData(format = 'json') {
    const dash = await buildDashboard();
    if (format === 'csv' || format === 'csv-snapshot') {
      const lines = ['\uFEFFperiod,dimension,name,tokens,input_tokens,output_tokens,cache_tokens,cost_usd'];
      for (const p of ['today', 'week', 'month', 'allTime']) {
        for (const t of dash.byTool) {
          const b = t[p];
          if (!b || b.totalTok <= 0) continue;
          lines.push(`${p},tool,"${t.id}",${b.totalTok},${b.inTok},${b.outTok},${b.cacheTok},${b.costUsd.toFixed(6)}`);
        }
        for (const m of dash.byModel) {
          const b = m[p];
          if (!b || b.totalTok <= 0) continue;
          lines.push(`${p},model,"${m.model}",${b.totalTok},${b.inTok},${b.outTok},${b.cacheTok},${b.costUsd.toFixed(6)}`);
        }
      }
      return { contentType: 'text/csv; charset=utf-8', filename: 'token-monitor-snapshot.csv', body: lines.join('\n') + '\n' };
    }
    if (format === 'daily-csv' || format === 'csv-daily') {
      const lines = ['\uFEFFdate,tokens,input_tokens,output_tokens,cache_tokens,turns,cost_usd'];
      for (const d of dash.daily) {
        lines.push(`${d.day},${d.totalTok},${d.inTok},${d.outTok},${d.cacheTok},${d.turns},${d.costUsd.toFixed(6)}`);
      }
      return { contentType: 'text/csv; charset=utf-8', filename: 'token-monitor-daily.csv', body: lines.join('\n') + '\n' };
    }
    return {
      contentType: 'application/json; charset=utf-8',
      filename: 'token-monitor-export.json',
      body: JSON.stringify(dash, null, 2) + '\n',
    };
  }

  return {
    buildDashboard,
    saveConfig,
    getPublicConfig,
    exportData,
  };
}
