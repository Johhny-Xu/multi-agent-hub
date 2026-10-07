// 探查 ZCode 渲染进程的 DOM 全貌 (经 CDP)
const http = require("http");
// CDP 端口 (默认 9223; 可用环境变量 CDP_PORT 覆盖)
const CDP_PORT = process.env.CDP_PORT || "9223";
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
  out.push('title=' + document.title);
  out.push('url=' + location.href.slice(0, 90));
  out.push('body.children=' + document.body.children.length);
  [...document.body.children].slice(0, 8).forEach(ch => {
    out.push('  <' + ch.tagName + ' id="' + (ch.id || '') + '" class="' + String(ch.className).slice(0, 90) + '">');
  });
  const counts = {};
  ['textarea', '[contenteditable="true"]', '[contenteditable="plaintext-only"]', '[class*="input"]', '[class*="chat"]', '[class*="task"]', '[class*="composer"]', '[class*="editor"]', 'iframe', 'webview'].forEach(s => {
    try { counts[s] = document.querySelectorAll(s).length; } catch (e) { counts[s] = 'ERR'; }
  });
  out.push('计数: ' + JSON.stringify(counts));
  const iframes = [...document.querySelectorAll('iframe')];
  iframes.slice(0, 5).forEach(f => out.push('iframe: src=' + (f.src || '').slice(0, 80) + ' class=' + String(f.className).slice(0, 60)));
  const tas = [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')];
  tas.slice(0, 5).forEach(el => out.push('输入: <' + el.tagName + ' class="' + String(el.className).slice(0, 110) + '" ph="' + (el.getAttribute("placeholder") || el.dataset && el.dataset.placeholder || '').slice(0, 50) + '">'));
  return out.join('\\n');
})()`;

(async () => {
  const targets = await get("/json/list");
  const page = targets.find((t) => t.type === "page");
  if (!page) { console.log("无 page 目标"); process.exit(1); }
  console.log("目标:", page.title, "|", page.url.slice(0, 80));
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
