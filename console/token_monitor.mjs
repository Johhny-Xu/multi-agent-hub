/**
 * Native Quota & Auth Engine for Agent Hub Console
 * Ported from Javis603/token-monitor (MIT)
 *
 * Provides:
 * 1. Native quota fetching for Antigravity, CodeBuddy/WorkBuddy, Trae, GitHub Copilot,
 *    MiniMax, ZCode/GLM (Z.ai / BigModel), MiMo, and DeepSeek without requiring 9router.
 * 2. Native login flows (GitHub Copilot Device Flow, Antigravity Google OAuth PKCE,
 *    local IDE/CLI credential auto-discovery, and credential storage).
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import https from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FETCH_TIMEOUT_MS = 9000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function cleanSecret(val) {
  if (typeof val !== "string") return "";
  let s = val.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (/^bearer\s+/i.test(s)) s = s.replace(/^bearer\s+/i, "").trim();
  return s;
}

function numberOrNull(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function clampPercent(v) {
  const n = numberOrNull(v);
  if (n === null) return null;
  return Math.max(0, Math.min(100, n));
}

function toIso(v) {
  if (!v) return null;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    const ms = v < 1_000_000_000_000 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    if (/^\d+$/.test(t)) return toIso(Number(t));
    const parsed = Date.parse(t);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

function formatResetCountdown(isoOrMs) {
  if (!isoOrMs) return "";
  const ts = typeof isoOrMs === "number" ? (isoOrMs < 1e12 ? isoOrMs * 1000 : isoOrMs) : new Date(isoOrMs).getTime();
  if (!Number.isFinite(ts)) return "";
  const diff = ts - Date.now();
  if (diff <= 0) return "即将重置";
  const mins = Math.floor(diff / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Credential Store (<dataDir>/provider-credentials.json) ─────────────────

function credentialsFilePath(dataDir) {
  const base = dataDir || path.join(os.homedir(), ".agent-hub", "data");
  return path.join(base, "provider-credentials.json");
}

export function loadProviderCredentials(dataDir) {
  const fp = credentialsFilePath(dataDir);
  try {
    const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export async function saveProviderCredentials(dataDir, patch = {}) {
  const fp = credentialsFilePath(dataDir);
  const current = loadProviderCredentials(dataDir);
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === "") {
      delete next[k];
    } else {
      next[k] = v;
    }
  }
  await fsp.mkdir(path.dirname(fp), { recursive: true });
  await fsp.writeFile(fp, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

// ─── 1. ZCode / Z.ai / 智谱 GLM (token-monitor/src/shared/providers/zai) ────

const ZCODE_CREDENTIAL_ENVELOPE = "enc:v1:";
let machineCredentialSecret = null;

function zcodeCredentialSecret(env = process.env) {
  const explicit = String(env?.ZCODE_CREDENTIAL_SECRET || "").trim();
  if (explicit) return explicit;
  if (machineCredentialSecret === null) {
    try {
      machineCredentialSecret = `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${os.userInfo().username}`;
    } catch {
      return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:unknown`;
    }
  }
  return machineCredentialSecret;
}

function decryptZcodeCredential(value, env = process.env) {
  if (typeof value !== "string" || !value.startsWith(ZCODE_CREDENTIAL_ENVELOPE)) return null;
  const [ivPart, tagPart, cipherPart] = value.slice(ZCODE_CREDENTIAL_ENVELOPE.length).split(".");
  if (!ivPart || !tagPart || !cipherPart) return null;
  try {
    const key = crypto.createHash("sha256").update(zcodeCredentialSecret(env)).digest();
    const iv = Buffer.from(ivPart, "base64url");
    const tag = Buffer.from(tagPart, "base64url");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(cipherPart, "base64url")), decipher.final()]).toString("utf8");
    return plain || null;
  } catch {
    return null;
  }
}

export function discoverZcodeLocalCredentials(env = process.env, homeDir = os.homedir()) {
  const baseDir = String(env.ZCODE_DATA_BASE_DIR || env.HOME || homeDir).trim();
  const zcodeV2 = path.join(baseDir, ".zcode", "v2");
  let settings = null;
  let registry = null;
  let store = null;
  let telemetry = null;
  try { settings = JSON.parse(fs.readFileSync(path.join(zcodeV2, "setting.json"), "utf8")); } catch {}
  try { registry = JSON.parse(fs.readFileSync(path.join(zcodeV2, "config.json"), "utf8")); } catch {}
  try { store = JSON.parse(fs.readFileSync(path.join(zcodeV2, "credentials.json"), "utf8")); } catch {}
  try { telemetry = JSON.parse(fs.readFileSync(path.join(zcodeV2, "telemetry-state.json"), "utf8")); } catch {}

  const jwtToken = store ? decryptZcodeCredential(store.zcodejwttoken, env) : null;
  const deviceMid = String(telemetry?.deviceMid || "").trim() || null;
  const domain = String(settings?.providerFamilyDomain || "bigmodel").trim();
  const family = domain === "zai" ? "zai" : "bigmodel";

  let apiKey = null;
  if (store) {
    for (const [k, v] of Object.entries(store)) {
      if (k.startsWith("account-provider:coding-plan:") && k.endsWith(":api-key")) {
        const dec = decryptZcodeCredential(v, env);
        if (dec) { apiKey = dec; break; }
      }
    }
  }
  if (!apiKey && registry?.provider) {
    for (const p of Object.values(registry.provider)) {
      if (p?.options?.apiKey) {
        apiKey = String(p.options.apiKey).trim();
        break;
      }
    }
  }
  return { jwtToken, apiKey, family, deviceMid, found: Boolean(jwtToken || apiKey) };
}

export async function fetchZcodeQuotas(options = {}) {
  const env = process.env;
  const explicitKey = cleanSecret(
    options.zaiApiKey || env.ZAI_API_KEY || env.Z_AI_API_KEY || env.GLM_API_KEY || env.ZHIPU_API_KEY || ""
  );
  const discovered = discoverZcodeLocalCredentials(env);
  const apiKey = explicitKey || discovered.apiKey;
  const region = options.zaiApiRegion || (discovered.family === "zai" ? "global" : "bigmodel-cn");
  const baseUrl = region === "global" ? "https://api.z.ai" : "https://open.bigmodel.cn";

  const models = [];
  let planName = "";
  let resetTime = null;

  // 1) Coding Plan / Console API Key Quota
  if (apiKey) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}/api/monitor/usage/quota/limit`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
      });
      if (res.ok) {
        const body = await res.json();
        const limits = Array.isArray(body?.data?.limits) ? body.data.limits : [];
        planName = body?.data?.planName || body?.data?.plan_name || body?.data?.level || "";
        for (const lim of limits) {
          const type = String(lim?.type || lim?.limit_type || "").toUpperCase();
          const total = numberOrNull(lim?.usage);
          const rem = numberOrNull(lim?.remaining);
          const cur = numberOrNull(lim?.currentValue ?? lim?.current_value);
          let usedPct = clampPercent(lim?.percentage ?? lim?.usedPercent);
          if (total && total > 0) {
            const usedVal = rem !== null ? Math.max(0, total - rem) : (cur ?? 0);
            usedPct = clampPercent((usedVal / total) * 100);
          }
          if (usedPct === null) continue;
          const remPct = Math.max(0, Math.min(100, Math.round(100 - usedPct)));
          const rAt = toIso(lim?.nextResetTime ?? lim?.next_reset_time);
          if (rAt && !resetTime) resetTime = rAt;
          const unit = numberOrNull(lim?.unit);
          const num = numberOrNull(lim?.number);
          let label = type === "TIME_LIMIT" ? "MCP (月度)" : "Coding Plan";
          if (unit === 3 && num) label = `${num}h 窗口`;
          else if (unit === 6 && num) label = `周度配额`;
          else if (unit === 1 && num) label = `${num}d 窗口`;
          models.push({
            name: label,
            pct: remPct,
            used: total && rem !== null ? total - rem : cur,
            total,
            reset: formatResetCountdown(rAt),
            resetAt: rAt
          });
        }
      }
    } catch {}
  }

  // 2) ZCode Start/Weekend Plan Billing Balance
  if (discovered.jwtToken) {
    try {
      const headers = {
        Authorization: `Bearer ${discovered.jwtToken}`,
        Accept: "application/json",
        ...(discovered.deviceMid ? { "X-Device-Mid": discovered.deviceMid } : {})
      };
      const res = await fetchWithTimeout("https://zcode.z.ai/api/v1/zcode-plan/billing/balance", { headers });
      if (res.ok) {
        const body = await res.json();
        const balances = Array.isArray(body?.data?.balances) ? body.data.balances : [];
        for (const b of balances) {
          const total = numberOrNull(b?.total_units);
          const rem = numberOrNull(b?.remaining_units);
          const used = numberOrNull(b?.used_units) ?? (total !== null && rem !== null ? total - rem : null);
          let remPct = total && total > 0 && rem !== null ? Math.round((rem / total) * 100) : null;
          if (remPct === null && b?.percentage != null) remPct = Math.round(100 - Number(b.percentage));
          if (remPct === null) continue;
          const rAt = toIso(b?.expires_at || b?.period_end);
          if (rAt && !resetTime) resetTime = rAt;
          models.push({
            name: String(b?.show_name || "ZCode Plan").trim(),
            pct: Math.max(0, Math.min(100, remPct)),
            used,
            total,
            reset: formatResetCountdown(rAt),
            resetAt: rAt
          });
        }
      }
    } catch {}
  }

  if (!models.length) return null;
  const minPct = Math.min(...models.map((m) => m.pct));
  return {
    name: "ZCode (智谱 GLM)",
    type: discovered.jwtToken ? "zcode-native" : "zai-api",
    source: "token-monitor",
    plan: planName || (discovered.jwtToken ? "ZCode Plan" : "GLM Coding"),
    remainingPct: minPct,
    resetCountdown: formatResetCountdown(resetTime),
    resetTime,
    models
  };
}

// ─── 2. CodeBuddy / WorkBuddy (token-monitor/src/shared/providers/workbuddy) ─

const WORKBUDDY_HOSTS = {
  cn: {
    baseUrl: "https://copilot.tencent.com",
    domain: "copilot.tencent.com"
  },
  intl: {
    baseUrl: "https://www.codebuddy.ai",
    domain: "www.codebuddy.ai"
  }
};

function discoverLocalCodeBuddyAuth(variant = "cn") {
  const home = os.homedir();
  const specificDirs = variant === "intl"
    ? [path.join(home, ".codebuddy-intl-home", ".local", "share", "CodeBuddyExtension", "Data", "Public", "auth")]
    : [path.join(home, ".codebuddy-cn-home", ".local", "share", "CodeBuddyExtension", "Data", "Public", "auth")];
  const candidates = [
    ...specificDirs,
    path.join(home, "AppData", "Local", "CodeBuddyExtension", "Data", "Public", "auth"),
    path.join(home, ".local", "share", "CodeBuddyExtension", "Data", "Public", "auth"),
    path.join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth"),
    path.join(home, ".codebuddy"),
    path.join(home, ".workbuddy")
  ];

  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".info") || f.endsWith(".json"));
      files.sort((a, b) => {
        if (a.includes("coding-copilot")) return -1;
        if (b.includes("coding-copilot")) return 1;
        return a.localeCompare(b);
      });
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(dir, file), "utf8").trim();
          if (!raw.startsWith("{")) continue;
          const parsed = JSON.parse(raw);
          const authObj = parsed?.auth && typeof parsed.auth === "object"
            ? parsed.auth
            : (parsed?.session && typeof parsed.session === "object" ? parsed.session : parsed);
          const account = parsed?.account && typeof parsed.account === "object"
            ? parsed.account
            : (authObj?.account && typeof authObj.account === "object" ? authObj.account : {});
          const accessToken = cleanSecret(authObj?.accessToken || parsed?.accessToken || parsed?.token || "");
          if (!accessToken) continue;
          const uid = String(account.uid || authObj.uid || parsed.uid || parsed.userId || "").trim();
          const domain = cleanSecret(authObj.domain || parsed.domain || "");
          const isIntl = /codebuddy\.ai/i.test(domain) || /intl/i.test(file) || /codebuddy-intl-home/i.test(dir);
          if ((variant === "intl" && isIntl) || (variant === "cn" && !isIntl)) {
            return { accessToken, uid, domain, nickname: account.nickname || "" };
          }
        } catch {}
      }
    } catch {}
  }
  return null;
}

export async function fetchCodebuddyDirect(options = {}, variant = "cn") {
  const isIntl = variant === "intl";
  const optToken = isIntl ? options.codebuddyIntlAccessToken : options.codebuddyCnAccessToken;
  const optUid = isIntl ? options.codebuddyIntlUid : options.codebuddyCnUid;

  const localAuth = discoverLocalCodeBuddyAuth(variant);
  const accessToken = cleanSecret(
    optToken ||
    (!isIntl ? options.workbuddyAccessToken : "") ||
    localAuth?.accessToken ||
    ""
  );
  if (!accessToken) return null;

  const uid = String(optUid || options.workbuddyUid || localAuth?.uid || "").trim();
  const hostCfg = isIntl ? WORKBUDDY_HOSTS.intl : WORKBUDDY_HOSTS.cn;
  const authDomain = cleanSecret(localAuth?.domain || hostCfg.domain);
  const candidateHosts = isIntl
    ? [
        { baseUrl: "https://www.codebuddy.ai", domain: authDomain || "www.codebuddy.ai" }
      ]
    : [
        { baseUrl: "https://copilot.tencent.com", domain: "copilot.tencent.com" },
        ...(authDomain && authDomain !== "copilot.tencent.com"
          ? [{ baseUrl: `https://${authDomain.replace(/^https?:\/\//, "")}`, domain: authDomain }]
          : [])
      ];

  for (const target of candidateHosts) {
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(uid ? { "X-User-Id": uid } : {}),
      ...(target.domain ? { "X-Domain": target.domain } : {})
    };

    try {
      const res = await fetchWithTimeout(`${target.baseUrl}/v2/billing/meter/get-user-resource`, {
        method: "POST",
        headers,
        body: JSON.stringify({})
      });
      if (!res.ok) continue;
      const payload = await res.json();
      const accounts = Array.isArray(payload?.data?.Response?.Data?.Accounts)
        ? payload.data.Response.Data.Accounts
        : (Array.isArray(payload?.data?.Accounts) ? payload.data.Accounts : []);
      const active = accounts.filter((a) => a && typeof a === "object" && (a.Status === 0 || a.Status === 1));
      if (!active.length) continue;

      let totalSize = 0;
      let totalRemain = 0;
      let totalUsed = 0;
      let earliestReset = null;
      let primaryPlan = "";
      const models = [];

      for (const acc of active) {
        const size = numberOrNull(acc.CycleCapacitySizePrecise ?? acc.CapacitySizePrecise ?? acc.CycleCapacitySize);
        const rem = numberOrNull(acc.CycleCapacityRemainPrecise ?? acc.CapacityRemainPrecise ?? acc.CycleCapacityRemain);
        if (size === null || size <= 0 || rem === null) continue;
        const used = numberOrNull(acc.CycleCapacityUsedPrecise) ?? Math.max(0, size - rem);
        totalSize += size;
        totalRemain += rem;
        totalUsed += used;
        const endIso = toIso(acc.CycleEndTime);
        if (endIso && (!earliestReset || endIso < earliestReset)) earliestReset = endIso;
        const pct = Math.max(0, Math.min(100, Math.round((rem / size) * 100)));
        const pkgName = String(acc.PackageName || acc.PackageCode || "资源包").trim();
        if (!primaryPlan && (String(acc.PackageType) === "1" || models.length === 0)) {
          primaryPlan = pkgName;
        }
        models.push({
          name: pkgName,
          pct,
          used: Math.round(used * 100) / 100,
          total: Math.round(size * 100) / 100,
          reset: formatResetCountdown(endIso),
          resetAt: endIso
        });
      }

      if (totalSize <= 0) continue;
      const remainingPct = Math.max(0, Math.min(100, Math.round((totalRemain / totalSize) * 100)));
      return {
        name: primaryPlan || (isIntl ? "CodeBuddy (国际)" : "CodeBuddy (国内)"),
        plan: primaryPlan || (isIntl ? "CodeBuddy (国际)" : "CodeBuddy (国内)"),
        type: "workbuddy-native",
        source: "token-monitor",
        remainingPct,
        used: Math.round(totalUsed * 100) / 100,
        total: Math.round(totalSize * 100) / 100,
        resetCountdown: formatResetCountdown(earliestReset),
        resetTime: earliestReset,
        account: localAuth?.nickname || uid || undefined,
        models
      };
    } catch {}
  }
  return null;
}

// ─── 3. Trae (token-monitor/src/shared/providers/trae) ──────────────────────

function discoverLocalTraeToken() {
  const home = os.homedir();
  const candidates = [
    path.join(home, "AppData", "Roaming", "Trae", "User", "globalStorage", "storage.json"),
    path.join(home, "AppData", "Roaming", "Trae CN", "User", "globalStorage", "storage.json"),
    path.join(home, ".config", "Trae", "User", "globalStorage", "storage.json"),
    path.join(home, "Library", "Application Support", "Trae", "User", "globalStorage", "storage.json")
  ];
  for (const fp of candidates) {
    try {
      if (!fs.existsSync(fp)) continue;
      const raw = fs.readFileSync(fp, "utf8");
      const m = raw.match(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/);
      if (m) return m[0];
    } catch {}
  }
  return "";
}

export async function fetchTraeDirect(options = {}) {
  const rawToken = cleanSecret(
    options.traeAccessToken ||
    process.env.TRAE_ACCESS_TOKEN ||
    process.env.TRAE_TOKEN ||
    discoverLocalTraeToken() ||
    ""
  ).replace(/^Cloud-IDE-JWT\s+/i, "").trim();

  if (!rawToken) return null;

  try {
    const res = await fetchWithTimeout("https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Cloud-IDE-JWT ${rawToken}`,
        "X-User-Region": "CN"
      },
      body: JSON.stringify({})
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (numberOrNull(body?.code) !== 0) return null;
    const packs = Array.isArray(body?.user_entitlement_pack_list) ? body.user_entitlement_pack_list : [];
    let totalLimit = 0;
    let totalUsed = 0;
    let endTimeSec = null;
    const models = [];

    for (const pack of packs) {
      const limit = numberOrNull(pack?.entitlement_base_info?.quota?.credits_limit);
      const used = numberOrNull(pack?.usage?.credits_amount);
      if (limit === null || limit <= 0 || used === null) continue;
      totalLimit += limit;
      totalUsed += used;
      const endSec = numberOrNull(pack?.entitlement_base_info?.end_time);
      if (endSec && (!endTimeSec || endSec < endTimeSec)) endTimeSec = endSec;
      const rem = Math.max(0, limit - used);
      const pct = Math.max(0, Math.min(100, Math.round((rem / limit) * 100)));
      models.push({
        name: pack?.entitlement_base_info?.product_name || "Credits",
        pct,
        used: Math.round(used * 100) / 100,
        total: Math.round(limit * 100) / 100,
        reset: endSec ? formatResetCountdown(endSec * 1000) : ""
      });
    }

    if (totalLimit <= 0) return null;
    const remaining = Math.max(0, totalLimit - totalUsed);
    const remainingPct = Math.max(0, Math.min(100, Math.round((remaining / totalLimit) * 100)));
    const resetTime = endTimeSec ? new Date(endTimeSec * 1000).toISOString() : null;
    return {
      name: "Trae CN",
      type: "trae-native",
      source: "token-monitor",
      remainingPct,
      used: Math.round(totalUsed * 100) / 100,
      total: Math.round(totalLimit * 100) / 100,
      resetCountdown: formatResetCountdown(resetTime),
      resetTime,
      models
    };
  } catch {
    return null;
  }
}

// ─── 4. Antigravity (token-monitor/src/shared/providers/antigravity) ────────

const ANTIGRAVITY_OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const ANTIGRAVITY_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email"
];
const ANTIGRAVITY_BASE_URLS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com"
];

// Local Language Server RPC Probe (from token-monitor antigravity/probe.js)
function postLocalRpc(host, port, rpcPath, csrfToken, body, useHttps = true) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const mod = useHttps ? https : null;
    if (!mod) return reject(new Error("HTTPS required"));
    const req = mod.request(
      {
        hostname: host,
        port,
        path: rpcPath,
        method: "POST",
        rejectUnauthorized: false,
        timeout: 3500,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "Connect-Protocol-Version": "1",
          ...(csrfToken ? { "x-codeium-csrf-token": csrfToken } : {})
        }
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(payload);
    req.end();
  });
}

async function probeLocalAntigravityProcess() {
  try {
    let cmdOutput = "";
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'csrf_token' } | Select-Object -ExpandProperty CommandLine"
      ], { timeout: 4000 });
      cmdOutput = stdout;
    } else {
      const { stdout } = await execFileAsync("ps", ["-ax", "-o", "command="], { timeout: 3000 });
      cmdOutput = stdout;
    }
    const lines = String(cmdOutput || "").split(/\r?\n/).filter((l) => l.includes("csrf_token"));
    for (const line of lines) {
      const csrfMatch = line.match(/--csrf_token[=\s]+([^\s"']+)/);
      const portMatch = line.match(/--extension_server_port[=\s]+(\d+)/) || line.match(/--port[=\s]+(\d+)/);
      if (!csrfMatch) continue;
      const csrfToken = csrfMatch[1];
      // Also find listening ports or try GetUserStatus if port is known
      if (portMatch) {
        const port = Number(portMatch[1]);
        try {
          const data = await postLocalRpc(
            "127.0.0.1",
            port,
            "/exa.language_server_pb.LanguageServerService/GetUserStatus",
            csrfToken,
            { metadata: { ideName: "antigravity", extensionName: "antigravity", locale: "en" } }
          );
          const configs = data?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
          if (Array.isArray(configs) && configs.length > 0) {
            return parseAntigravityModelConfigs(configs, "local-probe", data?.userStatus?.email);
          }
        } catch {}
      }
    }
  } catch {}
  return null;
}

function parseAntigravityModelConfigs(configs, sourceLabel = "oauth", email = "") {
  const models = [];
  let minPct = 100;
  let earliestReset = null;

  for (const cfg of configs) {
    const label = String(cfg?.label || cfg?.modelOrAlias?.model || "").trim();
    const frac = numberOrNull(cfg?.quotaInfo?.remainingFraction);
    if (!label || frac === null) continue;
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    if (pct < minPct) minPct = pct;
    const rAt = toIso(cfg?.quotaInfo?.resetTime);
    if (rAt && (!earliestReset || rAt < earliestReset)) earliestReset = rAt;
    models.push({
      name: label,
      pct,
      reset: formatResetCountdown(rAt),
      resetAt: rAt
    });
  }

  if (!models.length) return null;
  return {
    name: "Antigravity",
    type: `antigravity-${sourceLabel}`,
    source: "token-monitor",
    account: email || undefined,
    remainingPct: minPct,
    resetCountdown: formatResetCountdown(earliestReset),
    resetTime: earliestReset,
    models: models.slice(0, 8)
  };
}

export async function fetchAntigravityDirect(options = {}) {
  // 1) Try Google OAuth credentials (token-monitor antigravity/oauth.js)
  const creds = options.antigravityOAuthCredentials;
  if (creds && (creds.refreshToken || creds.accessToken)) {
    try {
      let accessToken = cleanSecret(creds.accessToken || "");
      const expiryMs = Date.parse(creds.expiryDate || "");
      if (!accessToken || (Number.isFinite(expiryMs) && expiryMs <= Date.now() + 60000)) {
        if (creds.refreshToken) {
          const tokenParams = new URLSearchParams({
            client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
            refresh_token: creds.refreshToken,
            grant_type: "refresh_token"
          });
          if (creds.clientSecret) tokenParams.set("client_secret", creds.clientSecret);
          const tokenRes = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenParams.toString()
          });
          if (tokenRes.ok) {
            const tokenData = await tokenRes.json();
            accessToken = cleanSecret(tokenData.access_token || "");
          }
        }
      }

      if (accessToken) {
        for (const baseUrl of ANTIGRAVITY_BASE_URLS) {
          try {
            const qRes = await fetchWithTimeout(`${baseUrl}/v1internal:retrieveUserQuota`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                "User-Agent": "antigravity"
              },
              body: JSON.stringify(creds.projectId ? { project: creds.projectId } : {})
            });
            if (qRes.ok) {
              const qData = await qRes.json();
              const buckets = Array.isArray(qData?.buckets) ? qData.buckets : [];
              const configs = buckets
                .filter((b) => b?.modelId && b?.remainingFraction !== undefined)
                .map((b) => ({
                  label: b.modelId,
                  quotaInfo: { remainingFraction: b.remainingFraction, resetTime: b.resetTime }
                }));
              const parsed = parseAntigravityModelConfigs(configs, "oauth", creds.email);
              if (parsed) return parsed;
            }
          } catch {}
        }
      }
    } catch {}
  }

  // 2) Try local Antigravity Language Server probe
  const probed = await probeLocalAntigravityProcess();
  if (probed) return probed;

  return null;
}

// Antigravity OAuth PKCE Login helper
const pendingAntigravityOAuth = new Map();

export function startAntigravityOAuth(redirectPort = 51121) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `http://localhost:${redirectPort}/oauth-callback`;
  pendingAntigravityOAuth.set(state, { verifier, redirectUri, createdAt: Date.now() });

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", ANTIGRAVITY_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", ANTIGRAVITY_OAUTH_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  return { authUrl: url.toString(), state, redirectUri };
}

export async function completeAntigravityOAuth(codeOrCallbackUrl, stateInput = "") {
  let code = String(codeOrCallbackUrl || "").trim();
  let state = String(stateInput || "").trim();
  if (code.startsWith("http://") || code.startsWith("https://")) {
    try {
      const u = new URL(code);
      code = u.searchParams.get("code") || "";
      state = u.searchParams.get("state") || state;
    } catch {}
  }
  if (!code) throw new Error("未检测到有效的 Google OAuth 授权码 (code)");

  const session = pendingAntigravityOAuth.get(state) || [...pendingAntigravityOAuth.values()].pop();
  if (!session) throw new Error("OAuth 会话已过期，请重新点击生成授权链接");

  const params = new URLSearchParams({
    client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
    code,
    code_verifier: session.verifier,
    grant_type: "authorization_code",
    redirect_uri: session.redirectUri
  });

  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Google OAuth 令牌交换失败 (${res.status}): ${errText.slice(0, 160)}`);
  }
  const tokenData = await res.json();
  const accessToken = cleanSecret(tokenData.access_token || "");
  const refreshToken = cleanSecret(tokenData.refresh_token || "");
  const expiresIn = Number(tokenData.expires_in || 3600);

  let email = "";
  try {
    const uRes = await fetchWithTimeout("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (uRes.ok) {
      const uData = await uRes.json();
      email = String(uData?.email || "").trim();
    }
  } catch {}

  return {
    accessToken,
    refreshToken,
    expiryDate: new Date(Date.now() + expiresIn * 1000).toISOString(),
    email
  };
}

// ─── 5. GitHub Copilot (token-monitor/src/shared/providers/copilot) ─────────

const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";

export async function startCopilotDeviceFlow() {
  const res = await fetchWithTimeout("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "GitHubCopilotChat/0.26.7"
    },
    body: new URLSearchParams({ client_id: COPILOT_CLIENT_ID, scope: "read:user" }).toString()
  });
  if (!res.ok) throw new Error(`GitHub Device Flow 启动失败: HTTP ${res.status}`);
  const data = await res.json();
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri || "https://github.com/login/device",
    expiresIn: Number(data.expires_in || 900),
    interval: Number(data.interval || 5)
  };
}

export async function pollCopilotDeviceFlowOnce(deviceCode) {
  const res = await fetchWithTimeout("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "GitHubCopilotChat/0.26.7"
    },
    body: new URLSearchParams({
      client_id: COPILOT_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code"
    }).toString()
  });
  if (!res.ok) return { status: "error", message: `HTTP ${res.status}` };
  const data = await res.json();
  if (data.access_token) {
    return { status: "ok", accessToken: cleanSecret(data.access_token) };
  }
  if (data.error === "authorization_pending" || data.error === "slow_down") {
    return { status: "pending", error: data.error };
  }
  return { status: "error", message: data.error_description || data.error || "授权失败" };
}

export async function fetchCopilotDirect(options = {}) {
  let token = cleanSecret(
    options.copilotApiToken ||
    process.env.COPILOT_API_TOKEN ||
    process.env.GITHUB_COPILOT_TOKEN ||
    ""
  );
  if (!token) {
    try {
      const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 3500 });
      token = cleanSecret(stdout);
    } catch {}
  }
  if (!token) return null;

  try {
    const res = await fetchWithTimeout("https://api.github.com/copilot_internal/user", {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/json",
        "Editor-Version": "vscode/1.96.2",
        "Editor-Plugin-Version": "copilot-chat/0.26.7",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-Github-Api-Version": "2025-04-01"
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const snaps = data?.quota_snapshots || data?.quotaSnapshots || {};
    const prem = snaps.premium_interactions || snaps.premium || {};
    const chat = snaps.chat || {};
    const resetDate = data?.quota_reset_date || data?.quotaResetDate || null;

    const total = numberOrNull(prem.entitlement) ?? 300;
    const rem = numberOrNull(prem.remaining) ?? total;
    const used = Math.max(0, total - rem);
    const pct = numberOrNull(prem.percent_remaining) !== null
      ? Math.round(Number(prem.percent_remaining))
      : total > 0 ? Math.round((rem / total) * 100) : 100;

    const models = [
      {
        name: "Premium Requests",
        pct: Math.max(0, Math.min(100, pct)),
        used,
        total,
        reset: formatResetCountdown(resetDate)
      }
    ];
    if (chat && (chat.unlimited || numberOrNull(chat.percent_remaining) !== null)) {
      const chatPct = chat.unlimited ? 100 : Math.round(Number(chat.percent_remaining));
      models.push({
        name: "Copilot Chat",
        pct: Math.max(0, Math.min(100, chatPct)),
        reset: chat.unlimited ? "Unlimited" : formatResetCountdown(resetDate)
      });
    }

    return {
      name: "GitHub Copilot",
      type: "copilot-native",
      source: "token-monitor",
      plan: data?.copilot_plan || "Individual",
      remainingPct: Math.max(0, Math.min(100, pct)),
      used,
      total,
      resetTime: resetDate,
      resetCountdown: formatResetCountdown(resetDate),
      models
    };
  } catch {
    return null;
  }
}

// ─── 6. MiniMax (token-monitor/src/shared/providers/minimax) ────────────────

function discoverLocalMinimaxKey() {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".mmx", "config.json"),
    path.join(home, ".minimax", "credentials.json"),
    path.join(home, ".minimax", "config.json"),
    path.join(home, ".config", "minimax", "credentials.json")
  ];
  for (const fp of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
      const k = cleanSecret(
        raw?.oauth?.access_token ||
        raw?.api_key ||
        raw?.apiKey ||
        raw?.token ||
        raw?.access_token ||
        ""
      );
      if (k) return k;
    } catch {}
  }
  return "";
}

export async function fetchMinimaxDirect(options = {}) {
  const key = cleanSecret(
    options.minimaxApiKey ||
    process.env.MINIMAX_CODING_API_KEY ||
    process.env.MINIMAX_API_KEY ||
    discoverLocalMinimaxKey() ||
    ""
  );
  if (!key) return null;

  const urls = [
    "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains",
    "https://api.minimaxi.com/v1/token_plan/remains",
    "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
    "https://api.minimax.io/v1/token_plan/remains",
    "https://api.minimax.io/v1/api/openplatform/coding_plan/remains"
  ];

  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, {
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
          "Content-Type": "application/json"
        }
      });
      if (!res.ok) continue;
      const body = await res.json();
      const baseCode = numberOrNull(body?.base_resp?.status_code);
      if (baseCode === 2062) {
        return {
          name: "Free",
          plan: "Free",
          type: "minimax-native",
          source: "token-monitor",
          remainingPct: 0,
          models: [{ name: "通用", pct: 0, used: 0, total: 0, reset: "Free" }]
        };
      }
      if (baseCode !== null && baseCode !== 0) continue;

      const rows = Array.isArray(body?.data?.model_remains)
        ? body.data.model_remains
        : Array.isArray(body?.model_remains)
          ? body.model_remains
          : [];
      if (!rows.length) continue;

      const general = rows.find((r) => r?.model_name === "general") || rows[0];
      const models = [];
      let minPct = 100;
      let earliestReset = null;

      // 5h interval window
      const remPct5h = numberOrNull(general?.current_interval_remaining_percent);
      const total5h = numberOrNull(general?.current_interval_total_count);
      const remCount5h = numberOrNull(general?.current_interval_usage_count);
      const rAt5h = toIso(general?.end_time);

      if (remPct5h !== null) {
        const pct = Math.max(0, Math.min(100, Math.round(remPct5h)));
        minPct = Math.min(minPct, pct);
        if (rAt5h) earliestReset = rAt5h;
        models.push({ name: "5h 窗口", pct, reset: formatResetCountdown(rAt5h) });
      } else if (total5h && total5h > 0 && remCount5h !== null) {
        const pct = Math.max(0, Math.min(100, Math.round((remCount5h / total5h) * 100)));
        minPct = Math.min(minPct, pct);
        if (rAt5h) earliestReset = rAt5h;
        models.push({
          name: general?.model_name || "Coding Plan (5h)",
          pct,
          used: total5h - remCount5h,
          total: total5h,
          reset: formatResetCountdown(rAt5h)
        });
      }

      // Weekly window
      const remPctWk = numberOrNull(general?.current_weekly_remaining_percent);
      const rAtWk = toIso(general?.weekly_end_time);
      if (remPctWk !== null && numberOrNull(general?.current_weekly_status) !== 3) {
        const pct = Math.max(0, Math.min(100, Math.round(remPctWk)));
        minPct = Math.min(minPct, pct);
        models.push({ name: "周度窗口", pct, reset: formatResetCountdown(rAtWk) });
      }

      if (!models.length) continue;
      return {
        name: "MiniMax Token Plan",
        type: "minimax-native",
        source: "token-monitor",
        remainingPct: minPct,
        resetCountdown: formatResetCountdown(earliestReset),
        resetTime: earliestReset,
        models
      };
    } catch {}
  }
  return null;
}

// ─── 7. MiMo (token-monitor/src/shared/providers/mimo) ──────────────────────

export async function fetchMimoDirect(options = {}) {
  const cookie = cleanSecret(options.mimoCookie || process.env.MIMO_COOKIE || "");
  if (cookie) {
    try {
      const headers = {
        Accept: "application/json",
        Cookie: cookie,
        Origin: "https://platform.xiaomimimo.com",
        Referer: "https://platform.xiaomimimo.com/"
      };
      const [balRes, usageRes] = await Promise.allSettled([
        fetchWithTimeout("https://platform.xiaomimimo.com/api/v1/balance", { headers }),
        fetchWithTimeout("https://platform.xiaomimimo.com/api/v1/plan/usage", { headers })
      ]);
      const models = [];
      let minPct = 100;
      if (usageRes.status === "fulfilled" && usageRes.value.ok) {
        const uBody = await usageRes.value.json();
        const items = Array.isArray(uBody?.data?.items) ? uBody.data.items : [];
        for (const item of items) {
          const usedPct = clampPercent(item?.usedPercent ?? item?.percentage);
          if (usedPct === null) continue;
          const remPct = Math.max(0, Math.min(100, Math.round(100 - usedPct)));
          minPct = Math.min(minPct, remPct);
          models.push({
            name: item?.name || item?.label || "Token Plan",
            pct: remPct,
            reset: formatResetCountdown(toIso(item?.resetAt || item?.nextResetTime))
          });
        }
      }
      if (balRes.status === "fulfilled" && balRes.value.ok) {
        const bBody = await balRes.value.json();
        const cash = numberOrNull(bBody?.data?.availableBalance ?? bBody?.data?.cashBalance ?? bBody?.data?.balance);
        if (cash !== null) {
          models.push({
            name: `余额 ¥${cash.toFixed(2)}`,
            pct: cash > 0 ? 100 : 0,
            reset: ""
          });
        }
      }
      if (models.length) {
        return {
          name: "MiMo (小米)",
          type: "mimo-native",
          source: "token-monitor",
          remainingPct: minPct,
          models
        };
      }
    } catch {}
  }

  // Fallback to local ~/.local/share/mimocode/auth.json subscription lookup
  try {
    const authPath = path.join(os.homedir(), ".local", "share", "mimocode", "auth.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const token = auth?.xiaomi?.access;
    if (token) {
      const res = await fetchWithTimeout("https://mimo-server-cn.xiaomimimo.com/api/user/xiaomi/subscription/self", {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const sub = data?.subscription;
        if (sub) {
          const active = sub.subscription_status === "active";
          return {
            name: "MiMo (小米)",
            type: "mimo-subscription",
            source: "token-monitor",
            plan: `${sub.current_plan_title || "Claw"} (${sub.billing_cycle || "monthly"})`,
            status: sub.subscription_status,
            remainingPct: active ? 100 : 0,
            resetTime: sub.current_period_end,
            resetCountdown: formatResetCountdown(sub.current_period_end),
            models: [
              {
                name: `${sub.current_plan_title || "Claw"} 订阅`,
                pct: active ? 100 : 0,
                reset: formatResetCountdown(sub.current_period_end)
              }
            ]
          };
        }
      }
    }
  } catch {}

  return null;
}

// ─── 8. DeepSeek (token-monitor/src/shared/providers/deepseek) ──────────────

export async function fetchDeepSeekDirect(options = {}) {
  const key = cleanSecret(options.deepseekApiKey || process.env.DEEPSEEK_API_KEY || "");
  if (!key) return null;
  try {
    const res = await fetchWithTimeout("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
    const cny = infos.find((i) => i.currency === "CNY") || infos[0];
    if (!cny) return null;
    const bal = Number(cny.total_balance || 0);
    return {
      name: "DeepSeek",
      type: "deepseek-native",
      source: "token-monitor",
      balance: `${bal.toFixed(2)} ${cny.currency || "CNY"}`,
      remainingPct: bal > 0 ? 100 : 0,
      models: [{ name: `余额 ¥${bal.toFixed(2)}`, pct: bal > 0 ? 100 : 0 }]
    };
  } catch {
    return null;
  }
}

// ─── Provider Credential Status Summary (Safe for UI) ───────────────────────

export function getProviderCredentialSummary(dataDir) {
  const creds = loadProviderCredentials(dataDir);
  const zcodeLocal = discoverZcodeLocalCredentials();
  const cbCnLocal = discoverLocalCodeBuddyAuth("cn");
  const cbIntlLocal = discoverLocalCodeBuddyAuth("intl");
  const traeLocal = discoverLocalTraeToken();
  const mmLocal = discoverLocalMinimaxKey();

  return {
    antigravity: {
      hasOAuth: Boolean(creds.antigravityOAuthCredentials?.refreshToken || creds.antigravityOAuthCredentials?.accessToken),
      email: creds.antigravityOAuthCredentials?.email || ""
    },
    "codebuddy-cn": {
      hasToken: Boolean(creds.codebuddyCnAccessToken || creds.workbuddyAccessToken || cbCnLocal?.accessToken),
      autoDetected: Boolean(cbCnLocal?.accessToken),
      uid: creds.codebuddyCnUid || cbCnLocal?.uid || ""
    },
    codebuddy: {
      hasToken: Boolean(creds.codebuddyIntlAccessToken || cbIntlLocal?.accessToken),
      autoDetected: Boolean(cbIntlLocal?.accessToken),
      uid: creds.codebuddyIntlUid || cbIntlLocal?.uid || ""
    },
    traecode: {
      hasToken: Boolean(creds.traeAccessToken || traeLocal),
      autoDetected: Boolean(traeLocal)
    },
    "github-copilot": {
      hasToken: Boolean(creds.copilotApiToken || process.env.COPILOT_API_TOKEN)
    },
    minimaxcode: {
      hasKey: Boolean(creds.minimaxApiKey || mmLocal || process.env.MINIMAX_API_KEY),
      autoDetected: Boolean(mmLocal)
    },
    zcode: {
      hasKey: Boolean(creds.zaiApiKey || zcodeLocal.found),
      autoDetected: zcodeLocal.found,
      region: creds.zaiApiRegion || (zcodeLocal.family === "zai" ? "global" : "bigmodel-cn")
    },
    mimocode: {
      hasCookie: Boolean(creds.mimoCookie)
    },
    dsh: {
      hasKey: Boolean(creds.deepseekApiKey)
    }
  };
}
