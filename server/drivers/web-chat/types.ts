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
  /** Optional: snapshot the conversation right before the prompt is submitted, so the extractor only reads what arrived after it. */
  captureBaseline?(page: WebChatPage, selectors: WebChatSelectors): Promise<unknown>;
  /** Optional custom generator state checker */
  isGenerating?(page: WebChatPage, selectors: WebChatSelectors, context?: WebChatTurnContext): Promise<boolean>;
  /** Optional custom extractor */
  extractResponse?(page: WebChatPage, selectors: WebChatSelectors, context?: WebChatTurnContext): Promise<string>;
  /**
   * Optional (E114): after the submit step, did the prompt actually go out? true = sent (a new user message showed up),
   * false = definitely not sent (safe to type it again), undefined = can't tell. A turn whose prompt went out (or might have)
   * is never typed again on retry; the retry only keeps waiting for / reading the reply.
   */
  wasSubmitted?(page: WebChatPage, selectors: WebChatSelectors, context: WebChatTurnContext): Promise<boolean | undefined>;
  /** Site default for the reply stability window (config.stabilitySec wins). */
  readonly defaultStabilitySec?: number;
  /**
   * Optional (E114): ceiling for the stability window when the reply keeps arriving in pieces. Each further piece after the
   * first stretches the window by a quarter of the base, up to this many seconds (sites with no "generating" flag, where a
   * tool call is just a silent gap between bubbles). Absent = fixed window.
   */
  readonly maxStabilitySec?: number;
  /** Site default for the whole-turn timeout (config.timeoutMs wins). */
  readonly defaultTimeoutMs?: number;
}

/** What the turn knows when it asks an adapter about the page. */
export interface WebChatTurnContext {
  /** Whatever captureBaseline returned (undefined when the adapter has none or it failed). */
  baseline?: unknown;
  /** The prompt this turn submitted. */
  prompt: string;
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
  /** CDP endpoint URL when using CDP transport (default: mychrome http://127.0.0.1:9333, see webChatCdpUrl) */
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
