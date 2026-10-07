// 读取 TraeCode CN 界面中最后一条 agent 回复的正文 (经 CDP)
// 优先提取 markdown 正文, 排除思考过程区块与 UI 碎片; 带稳定等待轮询
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
  const clean = (t) => (t || '')
    .replace(/^Agent/, '')
    .replace(/思考过程/g, '')
    .replace(/\\d+\\s*%\\s*$/, '')
    .trim();
  const turn = [...document.querySelectorAll('.turn__agent-message')].pop();
  if (turn) {
    const txts = [];
    turn.querySelectorAll('p, li, pre, code, h1, h2, h3, h4, table').forEach((e) => {
      if (e.closest('[class*="think"], [class*="reason"]')) return;
      const t = (e.textContent || '').trim();
      if (t && !txts.includes(t)) txts.push(t);
    });
    if (txts.length) {
      return JSON.stringify({ selector: 'turn-markdown', text: clean(txts.join('\\n')).slice(0, 4000) });
    }
    const raw = clean((turn.textContent || '').trim());
    if (raw) return JSON.stringify({ selector: 'turn-plain', text: raw.slice(0, 4000) });
  }
  const sels = ["[data-role='assistant']", '.assistant-chat-turn-content'];
  for (const s of sels) {
    const els = [...document.querySelectorAll(s)];
    if (els.length) {
      const last = els[els.length - 1];
      const txt = clean((last.textContent || '').trim());
      if (txt) return JSON.stringify({ selector: s, text: txt.slice(0, 4000) });
    }
  }
  return JSON.stringify({ selector: null, text: '' });
})()`;

(async () => {
  const targets = await get("/json/list");
  const page = targets.find((t) => t.type === "page");
  if (!page) { console.log(""); return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);

  const evalExpr = () => new Promise((res) => {
    const id = Math.floor(Math.random() * 1e6);
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) {
        ws.removeEventListener("message", onMsg);
        try {
          const parsed = JSON.parse(m.result?.result?.value || "{}");
          res(parsed.text || "");
        } catch { res(""); }
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
    setTimeout(() => res(""), 8000);
  });

  const finalText = await new Promise((resolve) => {
    let last = "";
    let stable = 0;
    const timer = setTimeout(() => resolve(last), 90000);
    ws.onopen = async () => {
      for (let i = 0; i < 30; i++) {
        const v = await evalExpr();
        if (v && v !== last) { last = v; stable = 0; }
        else if (v && v === last) {
          stable++;
          if (stable >= 2 && i > 1 && !/思考中|thinking/i.test(v)) { clearTimeout(timer); resolve(v); return; }
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      clearTimeout(timer);
      resolve(last);
    };
    ws.onerror = () => { clearTimeout(timer); resolve(last); };
  });

  console.log(finalText);
  ws.close();
})().catch(() => { console.log(""); });
