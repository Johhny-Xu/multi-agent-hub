// @ts-check
// 签到模块用到的两个网络工具，从老 MAH 的 console/vendor-quota.mjs 原样截取：
// fetchJsonSmart（直连失败自动走本地代理重试）与华为云 SDK-HMAC-SHA256 签名。
// 配额抓取（getAllQuotas 等）不在签到回归范围内，未一并搬入。

import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

// 直连不可达的厂商（如 Google）经本地代理 CONNECT 隧道访问；可用环境变量覆盖
const PROXY_URL = process.env.AGENTHUB_QUOTA_PROXY || 'http://127.0.0.1:7890';

async function fetchJson(url, options = {}, timeoutMs = 10_000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, ok: res.ok, json, text };
}

/** 经 HTTP 代理 CONNECT 隧道的 HTTPS 请求（使用 Node 原生 https.request 解析 chunked 响应） */
function fetchViaProxy(targetUrl, options = {}, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const proxy = new URL(PROXY_URL);
    const port = Number(u.port) || 443;
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${u.hostname}:${port}`,
      headers: { Host: `${u.hostname}:${port}` },
    });
    const timer = setTimeout(() => {
      req.destroy(new Error('proxy connect timeout'));
      reject(new Error('proxy connect timeout'));
    }, timeoutMs);
    req.on('connect', (pres, socket) => {
      if (pres.statusCode !== 200) {
        clearTimeout(timer); socket.destroy();
        return reject(new Error(`proxy connect failed: ${pres.statusCode}`));
      }
      const tlsSocket = tls.connect({ socket, servername: u.hostname });
      tlsSocket.on('error', (e) => { clearTimeout(timer); reject(e); });
      const bodyStr = options.body ? String(options.body) : '';
      const reqHeaders = { ...(options.headers || {}) };
      if (bodyStr && !reqHeaders['Content-Length'] && !reqHeaders['content-length']) {
        reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);
      }
      const hreq = https.request({
        hostname: u.hostname,
        port,
        path: `${u.pathname}${u.search}`,
        method: options.method || 'GET',
        headers: reqHeaders,
        createConnection: () => tlsSocket,
      }, (hres) => {
        /** @type {Buffer[]} */
        const chunks = [];
        hres.on('data', (c) => chunks.push(c));
        hres.on('end', () => {
          clearTimeout(timer);
          const text = Buffer.concat(chunks).toString('utf-8');
          const status = hres.statusCode || 0;
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { json = null; }
          resolve({ status, ok: status >= 200 && status < 300, json, text });
        });
        hres.on('error', (e) => { clearTimeout(timer); reject(e); });
      });
      hreq.on('error', (e) => { clearTimeout(timer); reject(e); });
      if (bodyStr) hreq.write(bodyStr);
      hreq.end();
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

/** 直连优先，网络级失败（超时/DNS/拒连）自动走代理重试 */
export async function fetchJsonSmart(url, options = {}, timeoutMs = 15_000) {
  try {
    return await fetchJson(url, options, timeoutMs);
  } catch {
    try {
      return await fetchViaProxy(url, options, timeoutMs);
    } catch (pe) {
      throw new Error(`直连与代理(${PROXY_URL})均不可达: ${pe.message}`);
    }
  }
}


// ---------------------------------------------------------------- 华为云 SDK-HMAC-SHA256 签名
// 与 huaweicloud-sdk / 开放网关一致。两个必须复刻的坑：
//   1) CanonicalURI 必须以 / 结尾（path 已带尾斜杠时不能补第二个）
//   2) CanonicalHeaders 每行自带 \n 后，整体再与 CanonicalRequest 用 \n 连接（即尾部已有一个 \n，不再额外补）
const _hwsSha256hex = (buf) => createHash('sha256').update(buf).digest('hex');
const _hwsRfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function hwsSdkSignedHeaders(ak, sk, method, rawUrl, body, extra = {}) {
  const u = new URL(rawUrl);
  const headers = {};
  for (const [k, v] of Object.entries(extra)) headers[k.toLowerCase()] = v;
  headers.host = u.host;
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  headers['x-sdk-date'] = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;

  const payload = ['PUT', 'PATCH', 'POST', 'DELETE'].includes(method) ? body : null;
  const names = Object.keys(headers).sort();
  let canonicalHeaders = '';
  for (const k of names) canonicalHeaders += `${k}:${String(headers[k]).trim()}\n`;
  const signedHeaders = names.join(';');
  const segs = (u.pathname || '/').split('/').map((s) => _hwsRfc3986(decodeURIComponent(s)));
  let canonicalUri = segs.join('/');
  if (!canonicalUri.endsWith('/')) canonicalUri += '/';
  const canonicalQuery = [...u.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${_hwsRfc3986(k)}=${_hwsRfc3986(v)}`)
    .join('&');
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    _hwsSha256hex(payload || Buffer.alloc(0)),
  ].join('\n');
  const stringToSign = ['SDK-HMAC-SHA256', headers['x-sdk-date'], _hwsSha256hex(Buffer.from(canonicalRequest, 'utf-8'))].join('\n');
  const signature = createHmac('sha256', sk).update(stringToSign).digest('hex');
  headers.authorization = `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}


