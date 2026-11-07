// @ts-check
// Trae 每日签到（设备号直签）
//
// 实现方式移植自 L0NE-6/Trae-AutoCheckin（https://github.com/L0NE-6/Trae-AutoCheckin，
// 见 README 致谢）。与旧实现的差别，也是能不能签成的关键：
//   1. 请求体必须带 {"req_source":1}，空体会被拒成 9074 / 9004；
//   2. x-device-id 必须是**客户端真实注册过的那串十进制数字**（storage.json 的
//      iCubeAuthInfo://icube-dc:<号> 键）。自己生成的号一律 9074；
//   3. 先查 status 再 claim；claim 返回 0 也要用同一设备号回查 checked_in 翻转，
//      否则只是「假成功」；
//   4. 9095 = 今日已签，9074 = 排队限流，1001/1002 = 鉴权失效；
//   5. token 失效时用 refreshToken + 设备证明（ECDSA P-256）走新版 ExchangeToken 续期，
//      refreshToken 会轮换，必须落盘缓存；
//   6. enable=false 表示该账号没开放签到，不要浪费 claim 次数。

import { createCipheriv, createDecipheriv, createHash, createSign } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { homedir, hostname, platform as osPlatform } from 'node:os';
import { dirname, join } from 'node:path';
import { fetchJsonSmart } from './vendor-quota.mjs';

export const TRAE_HOST = 'https://api.trae.cn';
const TRAE_OAUTH_HOST = 'https://api.trae.com.cn';

const EP_STATUS = '/trae/api/v2/ug/checkin_credits/status';
const EP_CLAIM = '/trae/api/v2/ug/checkin_credits/claim';
const EP_ENTITLE = '/trae/api/v2/pay/user_current_entitlement_list';
const EP_EXCHANGE_LEGACY = '/cloudide/api/v3/trae/oauth/ExchangeToken';
const EP_EXCHANGE_PROOF = '/trae/api/v3/oauth/ExchangeToken';

const CLIENT_ID_LEGACY = 'en1oxy7wnw8j9n';
const CLIENT_ID_IDE = (process.env.TRAE_CLIENT_ID || '').trim() || 'ono9krqynydwx5';
const IDE_VERSION = (process.env.TRAE_APP_VERSION || '').trim() || '1.107.1';
const UA = `Trae/${IDE_VERSION}`;

/** 业务码 */
export const TRAE_CODE = {
  ok: 0,
  already: 9095,
  rate: 9074,
  auth: new Set([1001, 1002, 401, 403]),
};

const REQ_BODY = JSON.stringify({ req_source: 1 });

// ---------------------------------------------------------------- 桌面端凭据解密
// storage.json 里的值：base64( [6 字节类型头][32 字节随机][AES-CBC 密文] )，
// key/iv 由 sha512(sha512(random) + salt) 取前 32 字节，明文前 64 字节是 sha512 校验。
const SALT_A = [82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
  124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
  84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78,
  8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37];
const SALT_B = [31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
  96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
  160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97,
  23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125];
const SALT_C = [191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176,
  135, 99, 96, 18, 127, 101, 203, 104, 211, 102, 125, 37, 72, 150, 156, 51,
  229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6, 18,
  140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209];
const SALT_D = [246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145,
  50, 196, 165, 42, 254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106,
  175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154,
  86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170];

const xorBytes = (a, b) => Buffer.from(a.map((value, index) => value ^ b[index]));
const SALT_AES = xorBytes(SALT_A, SALT_B);
const SALT_AES_PRIVATE = xorBytes(SALT_C, SALT_D);

const HEADER_AES = '746305100000';
const HEADER_AES_PRIVATE = '123920200203';
const STORAGE_KEY_AUTH = 'iCubeAuthInfo://icube.cloudide';
const STORAGE_KEY_DEVICE = 'iCubeAuthInfo://icube-dc:';

/** 解 storage.json 里的一条加密值（tc 头 + AES-128-CBC + sha512 校验） */
export function decryptTraeStorageValue(base64Value) {
  const buf = Buffer.from(String(base64Value || '').trim(), 'base64');
  if (buf.length < 70) throw new Error('密文长度不足');
  const header = buf.subarray(0, 6).toString('hex');
  const type = header === HEADER_AES ? 'aes' : header === HEADER_AES_PRIVATE ? 'private' : '';
  if (!type) throw new Error(`未知的加密类型（前 6 字节 ${header}）`);
  const salt = type === 'private' ? SALT_AES_PRIVATE : SALT_AES;
  const random = buf.subarray(6, 38);
  const digest = createHash('sha512')
    .update(Buffer.concat([createHash('sha512').update(random).digest(), salt]))
    .digest();
  const decipher = createDecipheriv('aes-128-cbc', digest.subarray(0, 16), digest.subarray(16, 32));
  decipher.setAutoPadding(false); // 明文尾部自己带填充，不能让 Node 先剥一层
  const plain = Buffer.concat([decipher.update(buf.subarray(38)), decipher.final()]);
  const stored = plain.subarray(0, 64);
  let body = plain.subarray(64);
  const pad = body.length ? body[body.length - 1] : 0;
  if (pad >= 1 && pad <= 16) body = body.subarray(0, body.length - pad);
  else {
    let end = body.length;
    while (end > 0 && (body[end - 1] === 0 || body[end - 1] === 32)) end -= 1;
    body = body.subarray(0, end);
  }
  if (!stored.equals(createHash('sha512').update(body).digest())) {
    throw new Error('SHA-512 校验失败，解密结果不可信');
  }
  return body.toString('utf-8');
}

/** 与 decryptTraeStorageValue 对称的加密（测试与自建 fixture 用，运行时不写 storage.json） */
export function encryptTraeStorageValue(plain, { private: isPrivate = false } = {}) {
  const salt = isPrivate ? SALT_AES_PRIVATE : SALT_AES;
  const random = Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256)));
  const digest = createHash('sha512')
    .update(Buffer.concat([createHash('sha512').update(random).digest(), salt]))
    .digest();
  const body = Buffer.from(String(plain), 'utf-8');
  const clear = Buffer.concat([createHash('sha512').update(body).digest(), body]);
  const pad = 16 - (clear.length % 16);
  const padded = Buffer.concat([clear, Buffer.alloc(pad, pad)]);
  const cipher = createCipheriv('aes-128-cbc', digest.subarray(0, 16), digest.subarray(16, 32));
  cipher.setAutoPadding(false);
  const data = Buffer.concat([cipher.update(padded), cipher.final()]);
  const header = isPrivate ? HEADER_AES_PRIVATE : HEADER_AES;
  const head = Buffer.from(header, 'hex');
  return Buffer.concat([head, random, data]).toString('base64');
}

/** 桌面端 storage.json 候选路径（Windows / macOS / Linux，含本机 ~/.config/Trae CN） */
export function traeStorageCandidates(home = homedir()) {
  const names = ['Trae CN', 'TRAE SOLO CN', 'TRAE SOLO', 'Trae'];
  const sub = ['User', 'globalStorage', 'storage.json'];
  const out = [];
  if (process.env.TRAE_STORAGE_PATH) out.push(process.env.TRAE_STORAGE_PATH);
  const appdata = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  for (const name of names) out.push(join(appdata, name, ...sub));
  for (const name of names) out.push(join(home, 'Library', 'Application Support', name, ...sub));
  for (const base of [join(home, '.config'), home]) {
    for (const name of [...names, '.trae-cn', '.trae']) out.push(join(base, name, ...sub));
  }
  return out;
}

const isDeviceId = (value) => /^\d{12,20}$/.test(String(value || '').trim());

/** 客户端真实注册过的设备号（键名带号，或键固定号在值里两种写法都认） */
export function traeDeviceIdOfStorage(storage) {
  for (const [key, value] of Object.entries(storage || {})) {
    if (key.startsWith(STORAGE_KEY_DEVICE)) {
      const id = key.slice(STORAGE_KEY_DEVICE.length).trim();
      if (isDeviceId(id)) return id;
    } else if (key.replace(/:+$/, '') === STORAGE_KEY_DEVICE.replace(/:+$/, '') && isDeviceId(value)) {
      return String(value).trim();
    }
  }
  return '';
}

/**
 * 读桌面端登录态：accessToken / refreshToken / 真实设备号 / 设备密钥 / machineId。
 * 读不到返回 null（不是错误 —— 免客户端部署本来就没有 storage.json）。
 */
export async function readTraeDesktopAuth(home = homedir()) {
  for (const file of traeStorageCandidates(home)) {
    let storage;
    try {
      storage = JSON.parse(await readFile(file, 'utf-8'));
    } catch {
      continue;
    }
    const deviceId = traeDeviceIdOfStorage(storage);
    let auth = null;
    const raw = storage?.[STORAGE_KEY_AUTH];
    if (typeof raw === 'string' && raw.trim()) {
      try {
        auth = raw.trim().startsWith('{') ? JSON.parse(raw) : JSON.parse(decryptTraeStorageValue(raw));
      } catch { auth = null; }
    }
    let keys = null;
    const deviceRaw = deviceId ? storage?.[`${STORAGE_KEY_DEVICE}${deviceId}`] : '';
    if (typeof deviceRaw === 'string' && deviceRaw.trim()) {
      try {
        const dev = JSON.parse(decryptTraeStorageValue(deviceRaw));
        if (dev?.privateKeyPEM && dev?.publicKeyPEM) {
          keys = { privateKeyPem: String(dev.privateKeyPEM).trim(), publicKeyPem: String(dev.publicKeyPEM).trim() };
        }
      } catch { keys = null; }
    }
    if (auth?.accessToken || auth?.refreshToken || deviceId) {
      return {
        storagePath: file,
        deviceId,
        accessToken: String(auth?.accessToken || '').trim(),
        refreshToken: String(auth?.refreshToken || auth?.refresh_token || '').trim(),
        uid: String(auth?.userId || auth?.uid || '').trim(),
        privateKeyPem: keys?.privateKeyPem || '',
        publicKeyPem: keys?.publicKeyPem || '',
        machineId: String(storage?.['telemetry.machineId'] || '').trim(),
      };
    }
  }
  return null;
}

/** 本机能读到的全部真实设备号（去重，供多账号分配） */
export async function traeRealDeviceIds(home = homedir()) {
  const ids = [];
  for (const file of traeStorageCandidates(home)) {
    try {
      const storage = JSON.parse(await readFile(file, 'utf-8'));
      const id = traeDeviceIdOfStorage(storage);
      if (id && !ids.includes(id)) ids.push(id);
    } catch { /* 没有就下一个 */ }
  }
  return ids;
}

// ---------------------------------------------------------------- 设备证明（ECDSA P-256）
const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

/** DER(SEQUENCE{INTEGER r, INTEGER s}) 里的 s 归一化成低半区，和客户端一致 */
export function normalizeDerLowS(der) {
  try {
    if (der[0] !== 0x30) return der;
    let offset = 2;
    if (der[1] & 0x80) offset = 2 + (der[1] & 0x7f);
    const rLen = der[offset + 1];
    const rStart = offset + 2;
    const r = Buffer.from(der.subarray(rStart, rStart + rLen));
    const sType = rStart + rLen;
    const sLen = der[sType + 1];
    const sStart = sType + 2;
    let s = der.subarray(sStart, sStart + sLen);
    const sValue = BigInt(`0x${s.toString('hex')}`);
    if (sValue <= P256_N / BigInt(2)) return der;
    let next = (P256_N - sValue).toString(16);
    if (next.length % 2) next = `0${next}`;
    let sBuf = Buffer.from(next, 'hex');
    if (sBuf[0] & 0x80) sBuf = Buffer.concat([Buffer.from([0]), sBuf]);
    const intS = Buffer.concat([Buffer.from([0x02, sBuf.length]), sBuf]);
    const intR = Buffer.concat([Buffer.from([0x02, r.length]), r]);
    const body = Buffer.concat([intR, intS]);
    return Buffer.concat([Buffer.from([0x30, body.length]), body]);
  } catch {
    return der;
  }
}

export function traeDeviceProof(path, refreshToken, keys, clientId, platformCode = 'IDE_PC') {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = createHash('sha256')
    .update(`${Date.now()}:${Math.random()}:${process.pid}`)
    .digest('hex')
    .slice(0, 32);
  const canonical = ['POST', path, clientId, refreshToken, String(timestamp), nonce].join('\n');
  const signer = createSign('SHA256');
  signer.update(canonical);
  const signature = normalizeDerLowS(signer.sign(keys.privateKeyPem)).toString('base64');
  const info = {
    DeviceID: keys.deviceId || '',
    MachineID: keys.machineId || '',
    PlatformCode: platformCode,
    DeviceType: 'PC',
    DeviceName: process.env.TRAE_DEVICE_NAME || hostname() || 'PC',
    DeviceModel: process.env.TRAE_DEVICE_MODEL || '',
    ClientVersion: IDE_VERSION,
    DevicePublicKey: keys.publicKeyPem,
    DeviceBrand: process.env.TRAE_DEVICE_BRAND || '',
    DeviceCPU: '',
    OSInfo: osPlatform() === 'win32' ? 'Windows' : osPlatform() === 'darwin' ? 'Darwin' : 'Linux',
    OSVersion: process.env.TRAE_OS_VERSION || '',
  };
  return { proof: { Timestamp: timestamp, Nonce: nonce, Signature: signature }, info };
}

function explainRefreshError(text) {
  let code;
  let detail = '';
  try {
    const err = JSON.parse(text)?.ResponseMetadata?.Error || {};
    code = err.Code;
    detail = err.Data?.['__Message.error'] || err.Message || '';
  } catch {
    return String(text || '').slice(0, 200);
  }
  const hint = {
    20101: 'refreshToken 已失效或被轮换掉了，需要重新提取',
    10101: 'refreshToken 与客户端不匹配（可能被别处轮换过，或来自另一条产品线）',
    20405: '服务端要求设备证明：需要客户端 storage.json 里的设备密钥',
    20403: '设备与 token 不匹配：设备密钥必须来自签发该 token 的同一台机器',
  }[code];
  return `code=${code} ${detail}${hint ? `（${hint}）` : ''}`;
}

/**
 * 用 refreshToken 换新 token。新版端点要求设备证明；没有设备密钥时退回旧端点。
 * 返回 { token, refreshToken, error }。
 */
export async function refreshTraeToken({ refreshToken, keys = null }) {
  const rt = String(refreshToken || '').trim();
  if (!rt) return { token: '', refreshToken: '', error: '没有 refreshToken' };

  if (keys?.privateKeyPem && keys?.publicKeyPem) {
    const combos = [[CLIENT_ID_IDE, 'IDE_PC'], [CLIENT_ID_LEGACY, 'IDE_PC'], [CLIENT_ID_LEGACY, 'SOLO_PC']];
    let last = null;
    for (const [clientId, platformCode] of combos) {
      const { proof, info } = traeDeviceProof(EP_EXCHANGE_PROOF, rt, keys, clientId, platformCode);
      const res = await fetchJsonSmart(`${TRAE_HOST}${EP_EXCHANGE_PROOF}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cloudide-token': '' },
        body: JSON.stringify({
          ClientID: clientId,
          ClientSecret: '',
          RefreshToken: rt,
          DeviceInfo: info,
          DeviceProof: proof,
          IDEVersion: IDE_VERSION,
        }),
      }, 20_000).catch((err) => ({ status: -1, text: String(err?.message || err), json: null }));
      if (res.status < 400 && res.json?.Result) {
        return {
          token: String(res.json.Result.Token || '').trim(),
          refreshToken: String(res.json.Result.RefreshToken || rt).trim(),
          error: '',
        };
      }
      last = res;
      const reason = `${res.text || ''}`;
      if (!reason.includes('10101') && !reason.includes('20403')) break;
    }
    const text = last?.text || '';
    return { token: '', refreshToken: '', error: `refresh http=${last?.status} ${explainRefreshError(text)}` };
  }

  const res = await fetchJsonSmart(`${TRAE_OAUTH_HOST}${EP_EXCHANGE_LEGACY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ ClientID: CLIENT_ID_LEGACY, RefreshToken: rt, ClientSecret: '-', UserID: '' }),
  }, 20_000).catch((err) => ({ status: -1, text: String(err?.message || err), json: null }));
  if (res.status >= 400 || !res.json?.Result) {
    return { token: '', refreshToken: '', error: `refresh http=${res.status} ${explainRefreshError(res.text || '')}` };
  }
  return {
    token: String(res.json.Result.Token || '').trim(),
    refreshToken: String(res.json.Result.RefreshToken || rt).trim(),
    error: '',
  };
}

// ---------------------------------------------------------------- token 缓存（续期会轮换）
function cacheFile(home = homedir()) {
  return process.env.AGENTHUB_TRAE_TOKEN_CACHE || join(home, '.agenthub', 'trae-token-cache.json');
}

export async function readTraeTokenCache(home = homedir()) {
  try {
    const data = JSON.parse(await readFile(cacheFile(home), 'utf-8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export async function writeTraeTokenCache(cache, home = homedir()) {
  const file = cacheFile(home);
  try {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  } catch { /* 缓存写不进去不影响本次签到 */ }
}

/** 用缓存里更新的 token 覆盖（只在有效期更长时） */
export function applyCachedTraeToken(record, cached) {
  if (!cached?.accessToken) return record;
  const cachedExp = Number(cached.expiresAt) || 0;
  const currentExp = jwtExpiry(record.token) || 0;
  if (cachedExp >= currentExp) {
    return {
      ...record,
      token: String(cached.accessToken),
      refreshToken: String(cached.refreshToken || record.refreshToken || ''),
    };
  }
  return record;
}

// ---------------------------------------------------------------- JWT 小工具
function jwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

/** 中国版把到期写进 TokenExpireAt（可能是字符串），只读 exp 会静默落 0 */
export function jwtExpiry(token) {
  const payload = jwtPayload(token);
  if (!payload) return 0;
  for (const claim of ['exp', 'TokenExpireAt', 'tokenExpireAt']) {
    const raw = payload[claim];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = Number(String(raw).trim());
    if (!Number.isFinite(value) || value <= 0) continue;
    return Math.floor(value > 100_000_000_000 ? value / 1000 : value);
  }
  return 0;
}

export function jwtUid(token) {
  const payload = jwtPayload(token);
  return String(payload?.data?.id ?? payload?.sub ?? '');
}

// ---------------------------------------------------------------- 上游调用
export function traeHeaders(token, deviceId) {
  const headers = {
    Authorization: `Cloud-IDE-JWT ${token}`,
    'X-User-Region': 'CN',
    'User-Agent': UA,
    'Content-Type': 'application/json',
  };
  // 只发小写 x-device-id 一个：大小写两份同时发会被风控当异常客户端
  if (deviceId) headers['x-device-id'] = String(deviceId);
  headers['x-device-type'] = process.env.TRAE_DEVICE_TYPE || (osPlatform() === 'win32' ? 'Windows' : osPlatform() === 'darwin' ? 'Darwin' : 'Linux');
  headers['x-os-version'] = process.env.TRAE_OS_VERSION || '';
  headers['x-app-version'] = IDE_VERSION;
  const brand = String(process.env.TRAE_DEVICE_BRAND || '').trim();
  if (brand) headers['x-device-brand'] = brand;
  return headers;
}

async function traePost(token, deviceId, path, body, timeout = 15_000) {
  const res = await fetchJsonSmart(`${TRAE_HOST}${path}`, {
    method: 'POST',
    headers: traeHeaders(token, deviceId),
    body,
  }, timeout);
  return { status: res.status, json: res.json || {}, text: res.text || '' };
}

export const traeStatusOf = (token, deviceId) => traePost(token, deviceId, EP_STATUS, REQ_BODY);
export const traeClaimOf = (token, deviceId) => traePost(token, deviceId, EP_CLAIM, REQ_BODY);

/** 积分余额：优先 usage_summary（总额 - 已用），再按权益包求和兜底 */
export async function traeCredits(token, deviceId) {
  try {
    const res = await traePost(token, deviceId, EP_ENTITLE, '{"require_usage": true}', 15_000);
    const root = res.json?.data || res.json || {};
    const summary = root.usage_summary || {};
    const total = Number(summary.total_amount || 0);
    const consumed = Number(summary.consumed_amount || 0);
    if (total > 0) return total - consumed;
    let sum = 0;
    let found = false;
    for (const pack of root.user_entitlement_pack_list || []) {
      const limit = Number(pack?.entitlement_base_info?.quota?.credits_limit || 0);
      const used = Number(pack?.usage?.credits_amount || 0);
      if (limit > 0) {
        found = true;
        sum += Math.max(limit - used, 0);
      }
    }
    return found ? sum : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 设备号
const DEVICE_CACHE = { ids: null };

/** 稳定兜底设备号：真号读不到时用（服务端基本会判 9074，只用于给出可读失败原因） */
export function generatedTraeDeviceId(seed) {
  const hash = createHash('sha256').update(String(seed)).digest();
  const value = BigInt(`0x${hash.subarray(0, 8).toString('hex')}`) % BigInt(9_000_000_000_000_000);
  return String(value + BigInt(1_000_000_000_000_000));
}

/**
 * 给账号分配设备号：真实号优先（一天一个真号只能签一个账号），
 * 用完了就按账号派生兜底号；显式配置的 TRAE_DEVICE_ID / account.deviceId 优先于兜底。
 */
export async function resolveTraeDeviceId(account = {}, { home = homedir(), used = null } = {}) {
  const manual = String(account.deviceId || process.env.TRAE_DEVICE_ID || '').trim();
  if (isDeviceId(manual)) return manual;
  if (!DEVICE_CACHE.ids) DEVICE_CACHE.ids = await traeRealDeviceIds(home);
  const real = DEVICE_CACHE.ids.find((id) => id && (!used || !used.has(id)));
  if (real) {
    used?.add(real);
    return real;
  }
  return generatedTraeDeviceId(String(account.identity || account.uid || account.name || 'default'));
}

/** 测试用：清掉设备号缓存 */
export function resetTraeDeviceCache() {
  DEVICE_CACHE.ids = null;
}

const fmt = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

/**
 * 单账号签到主流程（移植自 Trae-AutoCheckin 的 checkin_account）：
 * 状态 → 必要时续期 → 领取 → 同设备号回查确认。
 * 返回 { ok, status, message, credits, consecutiveDays, deviceId, ticket }
 *   status: success / already / unsupported / rate_limited / expired / failed
 */
export async function checkinTraeAccount(account, { home = homedir(), cache = null, usedDeviceIds = null } = {}) {
  const tokenCache = cache || await readTraeTokenCache(home);
  let token = String(account.token || '').trim();
  let refreshToken = String(account.refreshToken || '').trim();
  const cacheKey = String(account.uid || account.identity || account.name || 'default');
  const cached = tokenCache[cacheKey];
  if (cached?.accessToken) {
    const merged = applyCachedTraeToken({ token, refreshToken }, cached);
    token = merged.token;
    refreshToken = merged.refreshToken;
  }

  const deviceId = await resolveTraeDeviceId(account, { home, used: usedDeviceIds });
  const noteDevice = isDeviceId(deviceId) && !String(deviceId).startsWith('0') ? deviceId : '';

  /** 续期并落盘 */
  const renew = async () => {
    const keys = account.privateKeyPem && account.publicKeyPem
      ? { privateKeyPem: account.privateKeyPem, publicKeyPem: account.publicKeyPem, deviceId, machineId: account.machineId || '' }
      : null;
    const result = await refreshTraeToken({ refreshToken, keys });
    if (!result.token) return false;
    token = result.token;
    refreshToken = result.refreshToken || refreshToken;
    tokenCache[cacheKey] = {
      accessToken: token,
      refreshToken,
      expiresAt: jwtExpiry(token),
      updatedAt: Math.floor(Date.now() / 1000),
    };
    await writeTraeTokenCache(tokenCache, home);
    account.token = token;
    account.refreshToken = refreshToken;
    return true;
  };

  if (!token) {
    if (!refreshToken) {
      return { ok: false, status: 'expired', message: '没有可用 JWT，也没有 refreshToken，需要在 Trae 客户端重新登录一次', credits: 0, consecutiveDays: 0, deviceId };
    }
    if (!(await renew())) {
      return { ok: false, status: 'expired', message: 'JWT 缺失且续期失败（refreshToken 可能已轮换），需要重新从客户端读取凭据', credits: 0, consecutiveDays: 0, deviceId };
    }
  }

  let st = await traeStatusOf(token, deviceId);
  if (TRAE_CODE.auth.has(Number(st.json?.code)) && refreshToken) {
    if (await renew()) st = await traeStatusOf(token, deviceId);
  }
  const statusCode = Number(st.json?.code);
  if (TRAE_CODE.auth.has(statusCode)) {
    return {
      ok: false,
      status: 'expired',
      message: `JWT 已被服务端注销（${statusCode}），自动续期也失败；请让 Trae 客户端重新登录一次`,
      credits: 0,
      consecutiveDays: 0,
      deviceId,
    };
  }
  if (st.json?.checked_in === true) {
    const balance = await traeCredits(token, deviceId);
    return {
      ok: true,
      status: 'already',
      message: balance === null ? '今日已签到' : `今日已签到，积分余额 ${fmt(balance)}`,
      credits: balance === null ? 0 : fmt(balance),
      consecutiveDays: fmt(st.json?.streak || st.json?.consecutive_days),
      deviceId,
    };
  }
  if (st.json?.enable === false) {
    return { ok: true, status: 'unsupported', message: '该账号未开放签到（enable=false），不再重复请求', credits: 0, consecutiveDays: 0, deviceId };
  }
  if (st.status >= 400 || st.json?.code === undefined) {
    return {
      ok: false,
      status: 'failed',
      message: `状态查询失败 [${st.status}]：${String(st.text || '').slice(0, 80)}`,
      credits: 0,
      consecutiveDays: 0,
      deviceId,
    };
  }

  // 每账号每轮只发一次 claim：9074 是服务端排队限流，连发会延长惩罚窗口
  const claim = await traeClaimOf(token, deviceId);
  const claimCode = Number(claim.json?.code);
  if (claimCode === TRAE_CODE.already) {
    const balance = await traeCredits(token, deviceId);
    return { ok: true, status: 'already', message: '今日已签到(9095)', credits: balance === null ? 0 : fmt(balance), consecutiveDays: 0, deviceId };
  }
  if (claimCode === TRAE_CODE.rate || [429, 500, 502, 503, 504].includes(claim.status)) {
    return {
      ok: false,
      status: 'rate_limited',
      message: `排队限流（9074），本轮未签成；若持续出现，说明 x-device-id 不是客户端注册过的真实设备号`,
      credits: 0,
      consecutiveDays: 0,
      deviceId,
    };
  }
  if (TRAE_CODE.auth.has(claimCode)) {
    return { ok: false, status: 'expired', message: `领取时鉴权失效（${claimCode}），需要重新登录客户端`, credits: 0, consecutiveDays: 0, deviceId };
  }
  if (claimCode !== TRAE_CODE.ok) {
    return {
      ok: false,
      status: 'failed',
      message: `领取失败 [${claim.status}/${claimCode}]：${claim.json?.message || claim.text?.slice(0, 80) || '未知错误'}`,
      credits: 0,
      consecutiveDays: 0,
      deviceId,
    };
  }

  // code=0 可能是假成功（当日已签过的账号对任何设备号都回 0），必须同设备号回查
  const after = await traeStatusOf(token, deviceId);
  if (after.json?.checked_in !== true) {
    return {
      ok: false,
      status: 'rate_limited',
      message: `领取接口返回成功，但同设备号回查未确认（已签=${after.json?.checked_in}）——本轮不算签到成功，稍后重试`,
      credits: 0,
      consecutiveDays: 0,
      deviceId,
    };
  }
  const gained = claim.json?.data?.points ?? null;
  const balance = await traeCredits(token, deviceId);
  const gainText = gained ? `，本次 +${fmt(gained)} 积分` : '';
  return {
    ok: true,
    status: 'success',
    message: balance === null ? `签到成功${gainText}（已回查确认）` : `签到成功${gainText}，当前余额 ${fmt(balance)}`,
    credits: balance === null ? fmt(gained) : fmt(balance),
    consecutiveDays: fmt(after.json?.streak || after.json?.consecutive_days),
    deviceId: noteDevice || deviceId,
  };
}
