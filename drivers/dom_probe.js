const http = require("http");
if (typeof globalThis.WebSocket === "undefined") {
  const crypto = require("crypto");
  globalThis.WebSocket = class WebSocket {
    constructor(url) {
      this._listeners = { message: new Set(), open: new Set(), error: new Set() };
      const u = new URL(url);
      const key = crypto.randomBytes(16).toString("base64");
      const req = http.request({
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key },
      });
      req.on("upgrade", (_res, socket, head) => {
        this._socket = socket;
        let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
        socket.on("data", (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= 2) {
            const op = buf[0] & 0x0f;
            let len = buf[1] & 0x7f;
            let offset = 2;
            if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); offset = 4; }
            else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
            if (buf.length < offset + len) return;
            const payload = buf.subarray(offset, offset + len);
            buf = buf.subarray(offset + len);
            if (op === 0x1) {
              const ev = { data: payload.toString("utf8") };
              if (typeof this.onmessage === "function") this.onmessage(ev);
              for (const fn of this._listeners.message) fn(ev);
            } else if (op === 0x8) { socket.end(); }
          }
        });
        socket.on("error", (e) => { if (typeof this.onerror === "function") this.onerror(e); });
        if (typeof this.onopen === "function") this.onopen({});
      });
      req.on("error", (e) => { if (typeof this.onerror === "function") this.onerror(e); });
      req.end();
    }
    addEventListener(type, fn) { if (this._listeners[type]) this._listeners[type].add(fn); }
    removeEventListener(type, fn) { if (this._listeners[type]) this._listeners[type].delete(fn); }
    send(data) {
      if (!this._socket) return;
      const payload = Buffer.from(String(data), "utf8");
      const mask = crypto.randomBytes(4);
      let header;
      if (payload.length < 126) { header = Buffer.from([0x81, 0x80 | payload.length]); }
      else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
      this._socket.write(Buffer.concat([header, mask, masked]));
    }
    close() { if (this._socket) { try { this._socket.destroy(); } catch (_) {} } }
  };
}

// CDP 端口 (默认 9222; 可用环境变量 CDP_PORT 覆盖)
const CDP_PORT = process.env.CDP_PORT || "9222";
function get(path) {
  return new Promise((resolve, reject) => {
    http.get("http://127.0.0.1:" + CDP_PORT + path, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
    }).on("error", reject);
  });
}

const expr = `(() => {
  const out = [];
  const els = [...document.querySelectorAll('.turn__agent-message')];
  out.push('.turn__agent-message 总数: ' + els.length);
  els.slice(-2).forEach((el, i) => {
    const txt = (el.textContent || '').trim();
    out.push('[' + (els.length - 1 - i) + '] textLength=' + txt.length + ' | ' + txt.slice(0, 120).replace(/\\n/g, ' '));
    out.push('   innerHTML长度=' + (el.innerHTML || '').length + ' | 子元素数=' + el.children.length);
    if (el.children.length) {
      [...el.children].slice(0, 3).forEach(ch => out.push('     子: <' + ch.tagName + ' class="' + String(ch.className).slice(0, 100) + '" text=' + (ch.textContent || '').trim().slice(0, 60).replace(/\\n/g, ' ') + '>'));
    }
  });
  const bar = document.querySelector('.latest-assistant-bar-right-part');
  if (bar) out.push('latest-assistant-bar: <' + bar.tagName + '> text=' + (bar.textContent || '').trim().slice(0, 60));
  const all = [...document.querySelectorAll('[data-role]')];
  out.push('data-role 值分布: ' + JSON.stringify(all.reduce((a, e) => { const v = e.getAttribute('data-role'); a[v] = (a[v] || 0) + 1; return a; }, {})));
  return out.join('\\n');
})()`;

(async () => {
  const targets = await get("/json/list");
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 15000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) { clearTimeout(timer); resolve(m.result?.result?.value ?? JSON.stringify(m.result)); ws.close(); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });
  console.log(result);
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
