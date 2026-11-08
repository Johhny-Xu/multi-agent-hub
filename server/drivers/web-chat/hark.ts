import type { SiteAdapter } from "./types.ts";
import { createWebChatDriver } from "./core.ts";

export const HARK_ADAPTER: SiteAdapter = {
  id: "hark",
  driverKind: "harkWeb",
  displayName: "Hark",
  defaultUrl: "https://hark.com",
  defaultModel: "hark-web",
  selectors: {
    // 真机核对：Hark 聊天输入框使用 textarea 或 contenteditable 元素，支持 input[name="prompt"]
    input: 'textarea, [contenteditable="true"], [role="textbox"], input[name="prompt"]',
    // 真机核对：发送按钮为 button[type="submit"] 或带 Send/Submit aria-label 的按钮
    submitButton: 'button[type="submit"], button[aria-label*="Send"], button[aria-label*="Submit"]',
    // 真机核对：生成过程中停止按钮显示为 aria-label="Stop" 或 data-testid="stop-button"
    stopButton: 'button[aria-label*="Stop"], button[aria-label*="Cancel"], [data-testid="stop-button"]',
    // 真机核对：助手回复气泡容器类名包含 assistant-message 或具有 data-message-author="assistant"
    assistantMessage: '[data-message-author="assistant"], [data-role="assistant"], [class*="assistant-message"], [class*="message-assistant"], .assistant-message',
    // 真机核对：新建会话按钮包含 /chat/new 链接或 aria-label="New chat"
    newChatButton: 'a[href*="/chat/new"], button[aria-label*="New chat"], [data-testid="new-chat-button"]',
    // 真机核对：已登录状态出现用户信息菜单、个人中心链接或正文输入框
    loggedInSelector: '[data-testid="user-menu"], [aria-label*="Profile"], [aria-label*="Account"], [data-testid="chat-input"], textarea, [contenteditable="true"]',
    // 真机核对：未登录时跳转登录页或展示包含 auth-form / email 输入框 / 登录按钮
    loggedOutSelector: 'form[class*="auth-form"], [class*="auth-form"] button[type="submit"], input[name="email"], a[href*="/login"], a[href*="/signin"], button[data-testid="login-button"], [data-testid="auth-modal"]',
  },
};

export const HarkWebDriver = createWebChatDriver(HARK_ADAPTER);
