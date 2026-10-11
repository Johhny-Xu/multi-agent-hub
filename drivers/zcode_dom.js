// ZCode 桌面版聊天驱动 v4 (经 CDP): 基线快照 → 聚焦清空 → Input.insertText → Enter → 抓增量回复
// 用法: node zcode_dom.js "提示词"  → stdout: 本次新增的回复文本
// 调试: ZCODE_DEBUG_DIR=/tmp/x node zcode_dom.js "..."  → 额外落盘 before/after 正文, 便于离线调参
//
// v4 相对 v3 的改动:
//   1) 提交前记录正文基线, 返回时只取"本次新增部分", 不再把整段历史对话当回复返回;
//   2) 提交前清空输入框, 避免上次残留文本与新提示词拼接;
//   3) 稳定性判定基于增量文本, 长历史对话下也能正确收敛;
//   4) 异常路径统一关闭 WebSocket, 不留悬挂连接。
const http = require("http");
const fs = require("fs");
const path = require("path");

// CDP 端口 (默认 9223; 可用环境变量 CDP_PORT 覆盖)
const CDP_PORT = process.env.CDP_PORT || "9223";

function get(url) {
  return new Promise((resolve, reject) => {
    http.get("http://127.0.0.1:" + CDP_PORT + url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
    }).on("error", reject);
  });
}

let parsedPrompt = "";
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--model" || arg === "--timeout") {
    i++;
  } else if (arg === "--prompt") {
    parsedPrompt = process.argv[++i] || "";
  } else if (!arg.startsWith("-")) {
    parsedPrompt = arg;
  }
}
const PROMPT = parsedPrompt || "只回复两个字: 收到";
const DEBUG_DIR = process.env.ZCODE_DEBUG_DIR || "";
// 单次回复最多返回的字符数 (可用 ZCODE_MAX_CHARS 覆盖; 长报告需要更大值)
const MAX_REPLY_CHARS = parseInt(process.env.ZCODE_MAX_CHARS || "8000", 10);
// 输入区 UI 尾块长度: 用于把常驻的输入框/按钮文案从结果里切掉
const UI_TAIL_LEN = 240;
// 消息操作栏/界面噪音行, 提取正文时剔除
const NOISE_LINES = new Set([
  "复制", "编辑", "赞", "踩", "分叉", "重试", "删除", "分享", "反馈",
  "提出后续修改要求", "添加上下文", "完全访问", "自动编辑", "计划模式",
  "变更前确认", "自动编辑文件", "减少确认次数", "发送", "停止",
  "停止生成", "继续输入以排队后续修改", "思考", "终端", "读取",
]);

function dump(name, text) {
  if (!DEBUG_DIR) return;
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEBUG_DIR, name), text, "utf8");
  } catch (_) { /* 调试落盘失败不影响主流程 */ }
}

// 聚焦并清空输入框: 只 focus 不清理时, 上次未提交的残留文本会与新提示词拼接
const prepExpr = `(() => {
  let input = document.querySelector('[contenteditable="true"]');
  // PALETTE_HEAL: 若输入框不存在，多半是窗口卡在命令面板视图 —— 点「新建任务」自愈
  if (!input) {
    const cands = [...document.querySelectorAll('div,span,button,li,a')].filter((el) => el.childElementCount === 0 && (el.innerText || '').trim() === '新建任务');
    if (cands.length) {
      const clickable = cands[0].closest('[role=button],button,[class*=item],[class*=row]') || cands[0];
      clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      clickable.click();
      return JSON.stringify({ ok: false, why: 'PALETTE_HEALED_RETRY' });
    }
  }
  if (!input) return JSON.stringify({ ok: false, why: 'NO_INPUT' });
  input.focus();
  if ((input.textContent || '').length > 0) {
    input.innerHTML = '';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }
  return JSON.stringify({ ok: true });
})()`;

// busy 判定: 界面出现"停止生成"按钮说明模型仍在输出。
// 这是唯一可靠的"进行中"信号 —— "已工作 N 秒" 完成后仍留在历史里, 不能用作判据。
// 若不判定 busy, 模型"思考中"的停顿会被误认为回复已稳定, 导致提前返回半截结果。
const bodyExpr = `(() => {
  const t = (document.body.innerText || '').trim();
  const input = document.querySelector('[contenteditable="true"]');
  const busy = t.indexOf('停止生成') !== -1;
  return JSON.stringify({ text: t, inputLen: input ? (input.textContent || '').length : -1, busy: busy });
})()`;

// 界面噪音标记行 (不含空行): 消息操作栏、计时、时间戳、输入区文案等
function isNoiseLine(line) {
  const s = line.trim();
  if (!s) return false;
  if (NOISE_LINES.has(s)) return true;
  if (/^已工作\s*\d+\s*秒$/.test(s)) return true;    // 计时提示
  if (/^\d{1,2}:\d{2}$/.test(s)) return true;        // 消息时间戳
  if (/^(昨天|今天|前天)\s/.test(s)) return true;     // 日期分组
  if (/^模型已切换/.test(s)) return true;
  return false;
}

// 从"提交后的正文"里切出本次新增的回复
//
// 版面结构 (innerText):
//   [历史消息...] <本次提示词> [操作栏/计时噪音] <回复正文> [操作栏/时间戳] [常驻输入区 UI]
// 注意: 常驻输入区 UI 在正文末尾, 而新消息插在它"之前", 因此不能用"尾部定长切片"
// 或"提交前正文末尾块"来定位 — 后者会跨越消息边界, 新消息一插入就匹配不上。
// 这里改用"提示词锚点 + 遇到下一条界面噪音即停止"的方式, 稳定且不依赖固定偏移。
function extractDelta(beforeText, afterText, prompt) {
  if (!afterText) return "";
  if (afterText === beforeText) return "";

  if (prompt) {
    const p = afterText.lastIndexOf(prompt);
    if (p !== -1) {
      const lines = afterText.slice(p + prompt.length).split("\n");
      // 1) 跳过提示词之后的界面噪音与空行
      let i = 0;
      while (i < lines.length && (isNoiseLine(lines[i]) || !lines[i].trim())) i++;
      // 2) 收集正文, 直到遇到下一条界面噪音标记 (空行保留, 支持多段回复)
      const body = [];
      for (; i < lines.length; i++) {
        if (isNoiseLine(lines[i])) break;
        body.push(lines[i]);
      }
      const delta = body.join("\n").trim();
      if (delta) return delta.slice(-MAX_REPLY_CHARS);
    }
  }

  // 3) 回退: 提交前正文整体仍是前缀 (界面未裁剪旧内容)
  if (afterText.startsWith(beforeText)) {
    const d = afterText.slice(beforeText.length).trim();
    if (d) return d;
  }

  // 4) 最后回退: 无法定位 — 返回尾部交由调用方甄别
  return afterText.slice(-MAX_REPLY_CHARS);
}

(async () => {
  const targets = await get("/json/list");
  const page = targets.find((t) => t.type === "page");
  if (!page) { console.log(""); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);

  let msgId = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalExpr = (expr) => send("Runtime.evaluate", { expression: expr, returnByValue: true })
    .then((m) => (typeof m.result?.result?.value === "string" ? m.result.result.value : ""));

  let exitCode = 0;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws timeout")), 15000);
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
          const res = pending.get(m.id);
          pending.delete(m.id);
          res(m);
        }
      };
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
    });

    await send("Page.bringToFront", {});

    // 1) 提交前基线快照
    const beforeState = JSON.parse((await evalExpr(bodyExpr)) || "{}");
    const beforeText = beforeState.text || "";
    dump("before.txt", beforeText);

    // 2) 聚焦 + 清空输入框
    let prepRes = await evalExpr(prepExpr);
    // PALETTE_RETRY_ONCE: 自愈点击后重试一次聚焦
    if (!prepRes.includes('"ok":true') && prepRes.includes('PALETTE_HEALED_RETRY')) {
      await new Promise((r) => setTimeout(r, 1200));
      prepRes = await evalExpr(prepExpr);
    }
    if (!prepRes.includes('"ok":true')) {
      console.log("输入框未找到");
      ws.close();
      process.exit(1);
    } // PALETTE_RETRY_ONCE

    // 3) 输入 + 回车
    await send("Input.insertText", { text: PROMPT });
    for (const type of ["rawKeyDown", "char", "keyUp"]) {
      await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
    }

    // 4) 轮询增量文本, 稳定后返回
    let afterText = "";
    let sawBusy = false;
    const reply = await new Promise((resolve) => {
      let last = "";
      let stable = 0;
      let submitted = false;
      const timer = setTimeout(() => resolve(last), 900000);
      (async () => {
        for (let i = 0; i < 300; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const s = JSON.parse((await evalExpr(bodyExpr)) || "{}");
          afterText = s.text || "";
          if (!submitted && s.inputLen === 0) submitted = true;
          if (s.busy) sawBusy = true;
          if (!submitted) continue;
          // 仍在生成中: 不判定稳定, 且重置计数 (避免思考停顿导致提前返回)
          if (s.busy) { stable = 0; continue; }
          const delta = extractDelta(beforeText, afterText, PROMPT);
          if (delta !== last) { last = delta; stable = 0; continue; }
          // 增量文本已生成且停止变动（若曾观测到 busy 则只需 2 次稳定，未观测到 busy 则需 3 次稳定）
          if (delta) {
            stable++;
            if (stable >= (sawBusy ? 2 : 3)) { clearTimeout(timer); resolve(delta); return; }
          }
        }
        clearTimeout(timer);
        resolve(last);
      })();
    });

    dump("after.txt", afterText);
    dump("delta.txt", reply);
    console.log(reply.slice(-MAX_REPLY_CHARS));
  } catch (e) {
    console.error("ERR:", e.message);
    exitCode = 1;
  } finally {
    try { ws.close(); } catch (_) {}
  }
  process.exit(exitCode);
})();
