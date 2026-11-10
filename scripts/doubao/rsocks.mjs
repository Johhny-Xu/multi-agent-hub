#!/usr/bin/env node
// rsocks.mjs —— 经 ssh 标准输入输出复用的「反向 SOCKS5」：云机上监听 127.0.0.1:<port>，连接从本机（运行 ssh 的一端）发出。
// 用途：豆包按 IP 拒绝海外访问（/security/doubao-region-ban），而云机的 ssh 网关不允许 -R 远程转发；
// 云机浏览器经它走本机的国内出口。只转发 TCP 字节，浏览器与渲染都在云机。
//   本机：  node rsocks.mjs local -- ssh -o BatchMode=yes <cloud-host> node doubao-signer/rsocks.mjs remote 19341
//   云机：  node rsocks.mjs remote <port>     （由上面的 ssh 拉起，stdin/stdout 即复用通道）
// 帧：type(1) id(4) len(4) payload。type: 1=OPEN("host:port") 2=OK 3=FAIL 4=DATA 5=CLOSE
import net from 'node:net';
import { spawn } from 'node:child_process';

const OPEN = 1, OK = 2, FAIL = 3, DATA = 4, CLOSE = 5;
const MAX_CHUNK = 64 * 1024;

export function frame(type, id, payload = Buffer.alloc(0)) {
  const h = Buffer.alloc(9);
  h.writeUInt8(type, 0); h.writeUInt32BE(id >>> 0, 1); h.writeUInt32BE(payload.length, 5);
  return Buffer.concat([h, payload]);
}

export function makeParser(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 9) {
      const len = buf.readUInt32BE(5);
      if (buf.length < 9 + len) break;
      onFrame(buf.readUInt8(0), buf.readUInt32BE(1), buf.subarray(9, 9 + len));
      buf = buf.subarray(9 + len);
    }
  };
}

function sendData(write, id, data) {
  for (let i = 0; i < data.length; i += MAX_CHUNK) write(frame(DATA, id, data.subarray(i, i + MAX_CHUNK)));
}

/** 云机端：SOCKS5（无认证，仅 CONNECT）→ 通道。 */
function remote(port) {
  const conns = new Map();
  let nextId = 1;
  const write = (b) => process.stdout.write(b);
  process.stdin.on('data', makeParser((type, id, p) => {
    const c = conns.get(id);
    if (!c) return;
    if (type === OK) { c.ready(true); }
    else if (type === FAIL) { c.ready(false); }
    else if (type === DATA) { c.sock.write(p); }
    else if (type === CLOSE) { conns.delete(id); c.sock.end(); }
  }));
  process.stdin.on('end', () => process.exit(0));
  const server = net.createServer((sock) => {
    const id = nextId++;
    let stage = 0; let pending = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('close', () => { if (conns.has(id)) { conns.delete(id); write(frame(CLOSE, id)); } });
    const onData = (chunk) => {
      if (stage === 2) { sendData(write, id, chunk); return; }
      pending = Buffer.concat([pending, chunk]);
      if (stage === 0) {
        if (pending.length < 2 || pending.length < 2 + pending[1]) return;
        if (pending[0] !== 5) { sock.destroy(); return; }
        pending = pending.subarray(2 + pending[1]);
        sock.write(Buffer.from([5, 0])); stage = 1;
      }
      if (stage === 1) {
        if (pending.length < 5) return;
        if (pending[1] !== 1) { sock.write(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); sock.destroy(); return; }
        const atyp = pending[3]; let host; let off;
        if (atyp === 1) { if (pending.length < 10) return; host = [...pending.subarray(4, 8)].join('.'); off = 8; }
        else if (atyp === 3) { const n = pending[4]; if (pending.length < 7 + n) return; host = pending.subarray(5, 5 + n).toString(); off = 5 + n; }
        else if (atyp === 4) { if (pending.length < 22) return; host = pending.subarray(4, 20).toString('hex').match(/.{4}/g).join(':'); off = 20; }
        else { sock.destroy(); return; }
        const dport = pending.readUInt16BE(off);
        const rest = pending.subarray(off + 2); pending = Buffer.alloc(0);
        stage = 3; // 等 OK
        conns.set(id, {
          sock,
          ready: (ok) => {
            sock.write(Buffer.from([5, ok ? 0 : 5, 0, 1, 0, 0, 0, 0, 0, 0]));
            if (!ok) { conns.delete(id); sock.end(); return; }
            stage = 2;
            if (rest.length) sendData(write, id, rest);
          },
        });
        write(frame(OPEN, id, Buffer.from(`${host}:${dport}`)));
      }
    };
    sock.on('data', onData);
  });
  server.on('error', (e) => { process.stderr.write(`rsocks listen failed: ${e.message}\n`); process.exit(1); });
  server.listen(port, '127.0.0.1', () => process.stderr.write(`rsocks listening 127.0.0.1:${port}\n`));
}

/** 本机端：拉起 ssh，按 OPEN 帧替云机发起 TCP 连接。 */
function local(cmd) {
  const child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
  const conns = new Map();
  const write = (b) => { if (!child.stdin.destroyed) child.stdin.write(b); };
  child.stdout.on('data', makeParser((type, id, p) => {
    if (type === OPEN) {
      const s = p.toString(); const i = s.lastIndexOf(':');
      const host = s.slice(0, i).replace(/^\[|\]$/g, ''); const port = Number(s.slice(i + 1));
      const sock = net.connect({ host, port });
      conns.set(id, sock);
      let connected = false;
      sock.once('connect', () => { connected = true; write(frame(OK, id)); });
      sock.on('data', (d) => sendData(write, id, d));
      sock.on('error', () => {});
      sock.on('close', () => {
        if (!conns.has(id)) return;
        conns.delete(id);
        write(frame(connected ? CLOSE : FAIL, id));
      });
    } else if (type === DATA) { conns.get(id)?.write(p); }
    else if (type === CLOSE) { const s = conns.get(id); conns.delete(id); s?.end(); }
  }));
  child.on('exit', (code) => { for (const s of conns.values()) s.destroy(); process.exit(code ?? 1); });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'remote') remote(Number(rest[0] || 19341));
else if (mode === 'local') local(rest[0] === '--' ? rest.slice(1) : rest);
else if (mode) { process.stderr.write('usage: rsocks.mjs local -- <ssh cmd…> | remote <port>\n'); process.exit(2); }
