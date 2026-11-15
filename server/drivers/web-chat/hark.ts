import type { SiteAdapter, WebChatPage, WebChatTurnContext } from "./types.ts";
import { createWebChatDriver, extractLatestAssistantText } from "./core.ts";

/**
 * hark.com 真机核对（2026-11-14，mychrome 9333，已登录账号的 /chat 页）：
 * - 输入框：<textarea data-testid="chat-input" aria-label="消息输入">（无 contenteditable）。
 * - 发送：同一个 <button data-testid="send-button" data-composer-send>，框空时 aria-label 为「开始听写」（点了会开麦克风），
 *   有内容时切到 send 模式。所以发送选择器必须排除听写/语音态，排除不到就回落 Enter。
 * - 消息：每条为 <div data-message-id=… data-entry-kind="message">，文字在 [data-testid="message-text"]；
 *   用户与助手气泡在 DOM 上没有角色属性（用户是纯 span，助手是 markdown <p>），而且主聊天是一条连续对话、没有「新对话」，
 *   一次回复常拆成几条气泡。因此不能「取最后一条助手消息」：提交前记下已有消息 id，之后只读新出现、且不是本轮提示回显的消息，按顺序拼起来。
 * - 已登录：有 chat-input；未登录时站点跳登录页（URL 判定）或出现登录链接/按钮。
 * - E114（01:28 MutationObserver 实录一轮，提示让 Hark 查天气、要调工具）：发送后约 1.1 s 出现用户回显气泡；之后约 10.7 s
 *   页面上没有任何变化（无「思考中/生成中」气泡、无停止键、发送键 aria-busy 恒 false、无 aria-live 区更新），然后整条回复
 *   一次性插入（不逐字流式）。发送后输入框也没被清空（框里还是原文、按钮仍是「发送消息」），所以「输入框清空」不能当已发出的信号，
 *   只认「出现了基线之外、文字等于提示的新消息」。页面上没有可靠的完成信号，只能靠静默窗口：基线 20 s，回复分多段到达时每段
 *   再加 5 s，最多 40 s（总超时 240 s 不变）。
 */
const ENTRY_SELECTOR = '[data-message-id][data-entry-kind="message"]';
const TEXT_SELECTOR = '[data-testid="message-text"]';

export const HARK_ADAPTER: SiteAdapter = {
  id: "hark",
  driverKind: "harkWeb",
  displayName: "Hark",
  defaultUrl: "https://hark.com",
  defaultModel: "hark-web",
  // Hark 一次回复可能分几条气泡、中间还会调工具（工具期间页面完全静默），稳定窗口与总超时都放宽（E114：8 s 会截断）。
  defaultStabilitySec: 20,
  maxStabilitySec: 40,
  defaultTimeoutMs: 240_000,
  selectors: {
    input: 'textarea[data-testid="chat-input"]',
    submitButton:
      'button[data-testid="send-button"]:not([aria-label*="听写"]):not([aria-label*="聽寫"]):not([aria-label*="语音"]):not([aria-label*="語音"]):not([aria-label*="ictat"]):not([aria-label*="oice"]):not([disabled])',
    // 真站未见停止按钮（生成中发送键 aria-busy）；保留通用写法，出现时可取消。
    stopButton: 'button[data-testid="stop-button"], button[aria-label*="Stop"]',
    assistantMessage: `${ENTRY_SELECTOR} ${TEXT_SELECTOR}`,
    loggedInSelector: '[data-testid="chat-input"]',
    loggedOutSelector: 'a[href*="/login"], a[href*="/signin"], a[href*="/signup"], button[data-testid="login-button"]',
  },
  captureBaseline: (page: WebChatPage) => captureHarkBaseline(page),
  wasSubmitted: async (page: WebChatPage, _selectors, context: WebChatTurnContext) => harkWasSubmitted(page, context),
  extractResponse: async (page: WebChatPage, selectors, context?: WebChatTurnContext) =>
    Array.isArray(context?.baseline) ? extractHarkReply(page, context) : extractLatestAssistantText(page, selectors),
};

/** 提交前已有的消息 id；页面给不出列表时返回 undefined，回合退回通用的「取最后一条」读法。 */
export async function captureHarkBaseline(page: WebChatPage): Promise<string[] | undefined> {
  const ids = await page.evaluate<unknown>(
    `(() => Array.from(document.querySelectorAll(${JSON.stringify(ENTRY_SELECTOR)})).map((e) => e.getAttribute("data-message-id") || ""))()`,
  );
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.length > 0) : undefined;
}

/** 读提交后新出现的消息：去掉提示回显，按出现顺序拼接；还没有回复时返回空串。 */
export async function extractHarkReply(page: WebChatPage, context?: WebChatTurnContext): Promise<string> {
  const known = Array.isArray(context?.baseline) ? (context!.baseline as string[]) : null;
  if (!known) return "";
  const entries = await page.evaluate<unknown>(
    `(() => Array.from(document.querySelectorAll(${JSON.stringify(ENTRY_SELECTOR)})).map((e) => {
      const t = e.querySelector(${JSON.stringify(TEXT_SELECTOR)});
      return { id: e.getAttribute("data-message-id") || "", text: t ? (t.innerText || t.textContent || "") : "" };
    }))()`,
  );
  return harkReplyFromEntries(Array.isArray(entries) ? entries : [], known, context?.prompt ?? "");
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * E114：本轮提示是否已经发到 hark.com 上。true = 基线之外出现了文字等于提示的新消息（用户回显）；
 * false = 基线之外什么新消息都没有（可以安全重打）；undefined = 有新消息但对不上提示，或页面读不了——按「可能已发」处理，不重发。
 */
export async function harkWasSubmitted(page: WebChatPage, context: WebChatTurnContext): Promise<boolean | undefined> {
  const known = Array.isArray(context.baseline) ? (context.baseline as string[]) : null;
  if (!known) return undefined;
  const entries = await page.evaluate<unknown>(
    `(() => Array.from(document.querySelectorAll(${JSON.stringify(ENTRY_SELECTOR)})).map((e) => {
      const t = e.querySelector(${JSON.stringify(TEXT_SELECTOR)});
      return { id: e.getAttribute("data-message-id") || "", text: t ? (t.innerText || t.textContent || "") : "" };
    }))()`,
  );
  if (!Array.isArray(entries)) return undefined;
  return harkSubmittedFromEntries(entries, known, context.prompt);
}

export function harkSubmittedFromEntries(entries: unknown[], baselineIds: readonly string[], prompt: string): boolean | undefined {
  const known = new Set(baselineIds);
  const echo = normalize(prompt);
  let fresh = 0;
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const { id, text } = raw as { id?: unknown; text?: unknown };
    if (typeof id !== "string" || !id || known.has(id)) continue;
    fresh += 1;
    const body = typeof text === "string" ? normalize(text) : "";
    if (!body || !echo) continue;
    if (body === echo) return true;
    // 长提示可能被气泡截断显示：前 80 字对上也算回显。
    if (echo.length > 80 && body.length >= 80 && echo.startsWith(body.slice(0, 80))) return true;
  }
  return fresh === 0 ? false : undefined;
}

export function harkReplyFromEntries(entries: unknown[], baselineIds: readonly string[], prompt: string): string {
  const known = new Set(baselineIds);
  const echo = normalize(prompt);
  const parts: string[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const { id, text } = raw as { id?: unknown; text?: unknown };
    if (typeof id !== "string" || !id || known.has(id)) continue;
    const body = typeof text === "string" ? text.trim() : "";
    if (!body) continue;
    if (echo && normalize(body) === echo) continue;
    parts.push(body);
  }
  return parts.join("\n\n");
}

export const HarkWebDriver = createWebChatDriver(HARK_ADAPTER);
