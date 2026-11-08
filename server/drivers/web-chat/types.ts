export interface WebChatSelectors {
  /** The text input element (e.g. textarea, div[contenteditable="true"], etc.) */
  input: string;
  /** Send/Submit button */
  submitButton?: string;
  /** Stop/Cancel generating button */
  stopButton?: string;
  /** Assistant message container/text selector */
  assistantMessage: string;
  /** Button/link to click to start a fresh chat */
  newChatButton?: string;
  /** Selector present when logged in (e.g. user avatar, account menu, chat input) */
  loggedInSelector?: string;
  /** Selector present when NOT logged in (e.g. login button, sign in link) */
  loggedOutSelector?: string;
}

export interface SiteAdapter {
  readonly id: string;
  readonly driverKind: string;
  readonly displayName: string;
  readonly defaultUrl: string;
  readonly defaultModel: string;
  readonly selectors: WebChatSelectors;
  /** Optional custom login checker */
  checkLogin?(page: WebChatPage): Promise<boolean>;
  /** Optional custom generator state checker */
  isGenerating?(page: WebChatPage, selectors: WebChatSelectors): Promise<boolean>;
  /** Optional custom extractor */
  extractResponse?(page: WebChatPage, selectors: WebChatSelectors): Promise<string>;
}

export type WebChatTransportMode = "auto" | "userscript" | "cdp" | "workbench";

export interface WebChatConfig {
  /** Target site URL override */
  url?: string;
  /** Selectors override */
  selectors?: Partial<WebChatSelectors>;
  /** Timeout in ms for page operations and generation */
  timeoutMs?: number;
  /** Seconds of stability for message completion (defaults to 1.5) */
  stabilitySec?: number;
  /** Custom profile directory under ~/.openmausbot */
  profileDir?: string;
  /** Custom sessions file path */
  sessionsFile?: string;
  /** Transport mode: "auto" (default: userscript -> cdp), "userscript", "cdp", "workbench" */
  transport?: WebChatTransportMode;
  /** CDP endpoint URL when using CDP transport (default: http://127.0.0.1:9222) */
  cdpUrl?: string;
  /** Authentication token for userscript WebSocket bridge */
  authToken?: string;
  /** Minimum random delay in ms before typing/clicking (default: 1000) */
  minDelayMs?: number;
  /** Maximum random delay in ms before typing/clicking (default: 3000) */
  maxDelayMs?: number;
}

export type UserscriptClientMessage =
  | { type: "register"; tabId: string; url: string; title?: string }
  | { type: "heartbeat"; tabId: string }
  | { type: "text_delta"; turnId: string; text: string }
  | { type: "done"; turnId: string; text: string }
  | { type: "error"; turnId: string; error: string };

export type UserscriptServerMessage =
  | { type: "registered"; tabId: string }
  | { type: "prompt"; turnId: string; text: string; sessionReset?: boolean; selectors: WebChatSelectors; minDelayMs?: number; maxDelayMs?: number }
  | { type: "cancel"; turnId: string }
  | { type: "ping" };

export interface WebChatPage {
  url(): string;
  navigate(url: string, options?: { timeoutMs?: number }): Promise<void>;
  waitForSelector(selector: string, options?: { timeoutMs?: number }): Promise<boolean>;
  fill(selector: string, text: string, options?: { timeoutMs?: number }): Promise<void>;
  click(selector: string, options?: { timeoutMs?: number }): Promise<void>;
  evaluate<T = unknown>(script: string): Promise<T>;
  isVisible(selector: string): Promise<boolean>;
  getText(selector: string): Promise<string>;
  close?(): Promise<void>;
}
