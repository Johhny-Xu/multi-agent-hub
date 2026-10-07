const http = require("http");
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
