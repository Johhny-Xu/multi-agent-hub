// ZCode 桌面版界面文本快照 (经 CDP, 只读) — 供异步 worker 回传进度用
// 用法: node zcode_read.js  → stdout: 页面文本尾部 400 字符
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
  const t = (document.body.innerText || '').trim();
  return JSON.stringify({ tail: t.slice(-400) });
})()`;

(async () => {
  const targets = await get("/json/list");
  const page = targets.find((t) => t.type === "page");
  if (!page) { console.log(""); return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const out = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(""), 10000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(m.result?.result?.value || "{}").tail || "");
        } catch { resolve(""); }
        ws.close();
      }
    };
    ws.onerror = () => { clearTimeout(timer); resolve(""); };
  });
  console.log(out);
})().catch(() => { console.log(""); });
