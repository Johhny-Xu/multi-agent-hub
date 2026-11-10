import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RequestOutcome,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  ThreadId,
  TurnId,
  TurnStartResult,
} from "../../contracts.ts";
import { TurnAuthenticationRefusedError } from "../../contracts.ts";
import { userHome } from "../../env-path.ts";
import { profileDir } from "../../browser/chrome/profile.ts";
import { DATA_DIR } from "../../config.ts";
import type { ViewerHub } from "../../browser/viewers/core.ts";
import type { BrowserService, BrowserTarget } from "../../browser/service.ts";
import type { SiteAdapter, WebChatConfig, WebChatPage, WebChatSelectors } from "./types.ts";
import { checkCdpAvailable, createWebChatPageFromCdpEndpoint, resolveConnectOverCDP } from "./cdp-transport.ts";
import type { CdpTransportDeps } from "./cdp-transport.ts";
import { getDefaultUserscriptBridge, WebChatUserscriptBridge } from "./userscript-bridge.ts";
import {
  createDefaultWorkbenchPageFactory,
  createWebChatPageFromViewerHub,
  createWebChatPageFromBrowserService,
  createWebChatPageFromCdp,
  setWorkbenchBrowserService,
  getWorkbenchBrowserService,
  setWorkbenchBrowserTargetResolver,
  getWorkbenchBrowserTargetResolver,
  getWorkbenchBotIdsForInstance,
  setWorkbenchViewerHub,
  getWorkbenchViewerHub,
} from "./workbench-page.ts";

export {
  createDefaultWorkbenchPageFactory,
  createWebChatPageFromViewerHub,
  createWebChatPageFromBrowserService,
  createWebChatPageFromCdp,
  setWorkbenchBrowserService,
  getWorkbenchBrowserService,
  setWorkbenchBrowserTargetResolver,
  getWorkbenchBrowserTargetResolver,
  setWorkbenchViewerHub,
  getWorkbenchViewerHub,
};

export const webChatConfigSchema = z.object({
  url: z.string().trim().url().optional(),
  selectors: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().positive().optional(),
  stabilitySec: z.number().positive().optional(),
  profileDir: z.string().optional(),
  sessionsFile: z.string().optional(),
  transport: z.enum(["auto", "userscript", "cdp", "workbench"]).optional(),
  cdpUrl: z.string().optional(),
  authToken: z.string().optional(),
  minDelayMs: z.number().positive().optional(),
  maxDelayMs: z.number().positive().optional(),
});

export function decodeWebChatConfig(raw: unknown): WebChatConfig {
  const parsed = webChatConfigSchema.parse(raw ?? {});
  return parsed as WebChatConfig;
}

// ProviderSnapshot only names "available"/"unavailable", but the workbench check answers "unknown"
// (present, just not verifiable without opening the page); the wire carries it as-is.
function unknownSnapshot(reason: string): ProviderSnapshot {
  return { state: "unknown" as unknown as ProviderSnapshot["state"], authenticated: false, reason };
}

export function resolveProfileDir(
  env: Record<string, string | undefined>,
  target?: { key: string } | string | null,
  config?: WebChatConfig,
): string | undefined {
  if (config?.profileDir) return config.profileDir;
  const key = typeof target === "string" ? target : target?.key;
  if (!key) return undefined;
  const dataDir = env.OMB_DATA_DIR || DATA_DIR || join(userHome(env), ".openmausbot");
  return profileDir(dataDir, key);
}

export function resolveSessionsFile(env: Record<string, string | undefined>, instanceId: string, config?: WebChatConfig): string {
  if (config?.sessionsFile) return config.sessionsFile;
  const home = userHome(env);
  return join(home, ".openmausbot", "web-chat", instanceId, "sessions.json");
}

export async function checkPageLogin(
  page: WebChatPage,
  selectors: WebChatSelectors,
): Promise<{ loggedIn: boolean; reason?: string }> {
  const currentUrl = page.url() || "";
  if (/\/login|\/signin|\/auth|\/signup/i.test(currentUrl)) {
    return { loggedIn: false, reason: `重定向至登录页: ${currentUrl}` };
  }

  if (selectors.loggedOutSelector && (await page.isVisible(selectors.loggedOutSelector))) {
    return { loggedIn: false, reason: "检测到登录或注册元素" };
  }

  if (selectors.input && (await page.isVisible(selectors.input))) {
    return { loggedIn: true };
  }

  const inputReady = await page.waitForSelector(selectors.input, { timeoutMs: 2_000 });
  if (inputReady) {
    return { loggedIn: true };
  }

  if (selectors.loggedInSelector && (await page.isVisible(selectors.loggedInSelector))) {
    return { loggedIn: true };
  }

  return { loggedIn: false, reason: "未检测到输入框且未处于已登录状态" };
}

export class WebChatSessionStore {
  readonly #filePath: string;
  readonly #cache = new Map<string, string>();

  constructor(filePath: string) {
    this.#filePath = filePath;
    this.#load();
  }

  #load(): void {
    try {
      if (existsSync(this.#filePath)) {
        const data = JSON.parse(readFileSync(this.#filePath, "utf8")) as Record<string, string>;
        if (data && typeof data === "object") {
          for (const [k, v] of Object.entries(data)) {
            if (typeof v === "string") this.#cache.set(k, v);
          }
        }
      }
    } catch {}
  }

  get(threadId: string): string | undefined {
    return this.#cache.get(threadId);
  }

  set(threadId: string, url: string): void {
    this.#cache.set(threadId, url);
    try {
      mkdirSync(dirname(this.#filePath), { recursive: true, mode: 0o700 });
      const obj = Object.fromEntries(this.#cache.entries());
      writeFileSync(this.#filePath, JSON.stringify(obj, null, 2), { mode: 0o600 });
    } catch {}
  }

  clear(threadId: string): void {
    this.#cache.delete(threadId);
    try {
      const obj = Object.fromEntries(this.#cache.entries());
      writeFileSync(this.#filePath, JSON.stringify(obj, null, 2), { mode: 0o600 });
    } catch {}
  }
}

export interface WebChatTurnOptions {
  page: WebChatPage;
  adapter: SiteAdapter;
  config: WebChatConfig;
  sessionStore: WebChatSessionStore;
  threadId: string;
  turnId: string;
  prompt: string;
  sessionReset?: boolean;
  abortSignal?: AbortSignal;
  emit: (event: RuntimeEvent) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  resolveConnectOverCDP?: (deps?: any) => Promise<any>;
}

export async function runWebChatTurn(options: WebChatTurnOptions): Promise<string> {
  const {
    page,
    adapter,
    config,
    sessionStore,
    threadId,
    turnId,
    prompt,
    sessionReset,
    abortSignal,
    emit,
    now = Date.now,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  const selectors: WebChatSelectors = {
    ...adapter.selectors,
    ...config.selectors,
  };

  const baseEvent = {
    eventId: `ev-${now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    provider: adapter.driverKind,
    threadId,
    turnId,
    createdAt: new Date(now()).toISOString(),
  };

  // 1. Navigation / Session URL resolution
  const savedUrl = sessionReset ? undefined : sessionStore.get(threadId);
  const targetUrl = savedUrl || config.url || adapter.defaultUrl;
  const currentUrl = page.url() || "";

  let shouldNavigate = false;
  try {
    const curOrigin = new URL(currentUrl).origin;
    const expectedOrigin = new URL(targetUrl).origin;
    if (curOrigin !== expectedOrigin || (savedUrl && currentUrl !== savedUrl)) {
      shouldNavigate = true;
    }
  } catch {
    shouldNavigate = true;
  }

  if (shouldNavigate) {
    await page.navigate(targetUrl, { timeoutMs: config.timeoutMs ?? 20_000 });
  }

  // 2. Check login on page: 出现登录按钮/跳转登录页=未登录
  const isLoggedOutUrl = /\/login|\/signin|\/auth|\/signup/i.test(page.url() || "");
  const isLoggedOutBtn = selectors.loggedOutSelector ? await page.isVisible(selectors.loggedOutSelector) : false;
  if (isLoggedOutUrl || isLoggedOutBtn) {
    throw new TurnAuthenticationRefusedError(
      turnId,
      `未在浏览器中登录 ${adapter.displayName}。请在工作台浏览器查看器中打开 ${targetUrl} 完成登录后再试。`
    );
  }

  if (adapter.checkLogin) {
    const isAuthed = await adapter.checkLogin(page);
    if (!isAuthed) {
      throw new TurnAuthenticationRefusedError(
        turnId,
        `未在浏览器中登录 ${adapter.displayName}。请在工作台浏览器查看器中打开 ${targetUrl} 完成登录后再试。`
      );
    }
  }

  // 3. Ensure input is ready: 出现输入框=已登录
  const inputReady = await page.waitForSelector(selectors.input, { timeoutMs: 15_000 });
  if (!inputReady) {
    throw new Error(
      `[${adapter.displayName}] Selector "${selectors.input}" (input) failed to match any element on ${page.url()}. ` +
      `The site layout may have changed; you can override this selector in instance config.`
    );
  }

  // 4. Random delay to mimic natural human typing (defaults to 1000–3000ms)
  const minDelay = config.minDelayMs ?? 1000;
  const maxDelay = config.maxDelayMs ?? 3000;
  if (maxDelay > 0 && maxDelay >= minDelay) {
    const randomDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    if (randomDelay > 0) await sleep(randomDelay);
  }

  if (abortSignal?.aborted) {
    if (selectors.stopButton && (await page.isVisible(selectors.stopButton))) {
      await page.click(selectors.stopButton).catch(() => {});
    }
    throw new Error("Turn was cancelled");
  }

  // 5. Fill prompt & submit
  await page.fill(selectors.input, prompt, { timeoutMs: 10_000 });

  if (selectors.submitButton && (await page.isVisible(selectors.submitButton))) {
    await page.click(selectors.submitButton, { timeoutMs: 10_000 });
  } else {
    await page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selectors.input)});
      if (el) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      }
    })()`);
  }

  // 5. Poll / observe DOM until generation finishes
  const stabilityMs = (config.stabilitySec ?? 1.5) * 1000;
  const timeoutMs = config.timeoutMs ?? 60_000;
  const startTime = now();
  let lastText = "";
  let stableSince: number | null = null;
  let generationStarted = false;

  while (now() - startTime < timeoutMs) {
    if (abortSignal?.aborted) {
      if (selectors.stopButton && (await page.isVisible(selectors.stopButton))) {
        await page.click(selectors.stopButton).catch(() => {});
      }
      throw new Error("Turn was cancelled by user.");
    }

    const isGenerating = adapter.isGenerating
      ? await adapter.isGenerating(page, selectors)
      : selectors.stopButton ? await page.isVisible(selectors.stopButton) : false;

    if (isGenerating) {
      generationStarted = true;
      stableSince = null;
    }

    let currentText = "";
    try {
      currentText = adapter.extractResponse
        ? await adapter.extractResponse(page, selectors)
        : await extractLatestAssistantText(page, selectors);
    } catch {}

    if (currentText.length > lastText.length) {
      generationStarted = true;
      const delta = currentText.slice(lastText.length);
      emit({
        ...baseEvent,
        type: "content.delta",
        streamKind: "assistant_text",
        delta,
      });
      lastText = currentText;
      stableSince = now();
    } else if (generationStarted && currentText.length > 0) {
      if (stableSince === null) {
        stableSince = now();
      } else if (now() - stableSince >= stabilityMs && !isGenerating) {
        break;
      }
    }

    await sleep(250);
  }

  const finalText = adapter.extractResponse
    ? await adapter.extractResponse(page, selectors)
    : await extractLatestAssistantText(page, selectors);

  if (!finalText && !generationStarted) {
    throw new Error(
      `[${adapter.displayName}] Generation timed out without producing any text response. ` +
      `Check if the website layout changed or generation was blocked.`
    );
  }

  // 6. Update sessionStore with current URL (for thread continuity)
  const afterUrl = page.url();
  if (afterUrl && afterUrl.startsWith("http")) {
    sessionStore.set(threadId, afterUrl);
  }

  emit({
    ...baseEvent,
    type: "item.completed",
    itemType: "assistant_text",
    text: finalText,
  } as unknown as RuntimeEvent);

  emit({
    ...baseEvent,
    type: "turn.completed",
    ok: true,
    stopReason: "stop",
  });

  return finalText;
}

export async function extractLatestAssistantText(page: WebChatPage, selectors: WebChatSelectors): Promise<string> {
  let directText = "";
  try {
    directText = await page.getText(selectors.assistantMessage);
  } catch {}
  if (directText && directText.trim().length > 0) {
    return directText.trim();
  }

  const script = `(() => {
    const selector = ${JSON.stringify(selectors.assistantMessage)};
    const nodes = document.querySelectorAll(selector);
    if (!nodes || nodes.length === 0) return '__NOT_FOUND__';
    const last = nodes[nodes.length - 1];
    return last ? (last.innerText || last.textContent || '').trim() : '__NOT_FOUND__';
  })()`;

  const text = await page.evaluate<string>(script).catch(() => '__NOT_FOUND__');
  if (!text || text === '__NOT_FOUND__' || (text as unknown) === true) {
    throw new Error(`No assistant message found matching selector "${selectors.assistantMessage}"`);
  }
  return text;
}

export interface WebChatDependencies {
  pageFactory?: (target: { instanceId: string; url: string; profileDir?: string; botId?: string; threadId?: string }) => Promise<WebChatPage>;
  viewerHub?: ViewerHub;
  browserService?: BrowserService;
  resolveBrowserTarget?: (botId: string) => BrowserTarget;
  /** Workbench mode: which real bots use this instance; snapshot tries each bot's viewer profile, and any awake one counts. Absent keeps the instanceId-only behavior. */
  botIdsForInstance?: (instanceId: string) => string[];
  userscriptBridge?: WebChatUserscriptBridge;
  checkCdpAvailable?: (cdpUrl?: string, timeoutMs?: number) => Promise<boolean>;
  cdpPageFactory?: (targetUrl: string, options?: { cdpUrl?: string; timeoutMs?: number; minDelayMs?: number; maxDelayMs?: number }) => Promise<WebChatPage>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  resolveConnectOverCDP?: (deps?: any) => Promise<any>;
}

export function createWebChatDriver(adapter: SiteAdapter, deps: WebChatDependencies = {}): ProviderDriver<WebChatConfig> {
  const models: ModelCatalog = {
    default: adapter.defaultModel,
    options: [{ id: adapter.defaultModel, label: `${adapter.displayName} Web` }],
  };

  const defaultFactory = (t: { instanceId: string; url: string; profileDir?: string; botId?: string; threadId?: string }) => {
    if (deps.viewerHub) {
      return createWebChatPageFromViewerHub(deps.viewerHub, t.url);
    }
    const instanceHub = getWorkbenchViewerHub(t.instanceId);
    if (instanceHub) {
      return createWebChatPageFromViewerHub(instanceHub, t.url);
    }
    const service = deps.browserService ?? getWorkbenchBrowserService() ?? (globalThis as unknown as { __ombBrowserService?: BrowserService }).__ombBrowserService;
    if (service) {
      if (!t.botId) {
        throw new Error("botId is required to resolve browser target for web chat driver");
      }
      const resolver = deps.resolveBrowserTarget ?? getWorkbenchBrowserTargetResolver();
      if (!resolver) {
        throw new Error("No browser target resolver registered");
      }
      const browserTarget = resolver(t.botId);
      return createWebChatPageFromBrowserService(service, browserTarget, t.url);
    }
    throw new Error(
      `No workbench browser service or ViewerHub available for instance "${t.instanceId}". ` +
      `Ensure the workbench browser is running or configure a browser page factory.`
    );
  };

  const effectivePageFactory = deps.pageFactory ?? defaultFactory;

  return {
    driverKind: adapter.driverKind,
    metadata: {
      displayName: `${adapter.displayName} (Web)`,
      supportsMultipleInstances: true,
      access: "subscription",
    },
    install: {
      docsUrl: adapter.defaultUrl,
      signInCommand: `在工作台浏览器查看器中打开 ${adapter.defaultUrl} 并手动登录`,
    },
    decodeConfig: decodeWebChatConfig,
    defaultConfig: () => ({}),
    models,
    async create(input: DriverCreateInput<WebChatConfig>): Promise<ProviderInstance> {
      const { instanceId, environment, config } = input;
      const selectors: WebChatSelectors = {
        ...adapter.selectors,
        ...config.selectors,
      };
      const sessionsFile = resolveSessionsFile(environment, instanceId, config);
      const sessionStore = new WebChatSessionStore(sessionsFile);

      const listeners = new Set<RuntimeEventListener>();
      const activeTurns = new Map<ThreadId, { turnId: TurnId; abortController: AbortController }>();
      const threadPages = new Map<ThreadId, WebChatPage>();

      async function getPageForTurn(threadId: string, botId?: string): Promise<WebChatPage> {
        const existing = threadPages.get(threadId);
        if (existing) {
          try {
            existing.url();
            return existing;
          } catch {}
        }
        const page = await effectivePageFactory({
          instanceId,
          url: config.url || adapter.defaultUrl,
          botId,
          threadId,
        });
        threadPages.set(threadId, page);
        return page;
      }

      const emit = (event: RuntimeEvent) => {
        for (const listener of listeners) {
          try {
            listener(event);
          } catch {}
        }
      };

      const adapterImpl = {
        provider: adapter.driverKind,
        capabilities: {
          sessionModelSwitch: "unsupported" as const,
        },
        async sendTurn(turnInput: SendTurnInput): Promise<TurnStartResult> {
          const { threadId, text, sessionReset, botId } = turnInput;
          // SendTurnInput doesn't name turnId, but the driver's callers (tests) pass it and the
          // driver echoes it back; when absent it rides as undefined, as before.
          const turnId = (turnInput as SendTurnInput & { turnId?: TurnId }).turnId as TurnId;
          const abortController = new AbortController();
          activeTurns.set(threadId, { turnId, abortController });

          const baseEvent = {
            eventId: `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            provider: adapter.driverKind,
            threadId,
            turnId,
            createdAt: new Date().toISOString(),
          };

          if (!botId) {
            emit({ ...baseEvent, type: "turn.started" });
            emit({
              ...baseEvent,
              type: "runtime.error",
              message: "Web chat driver requires botId (must be used within a bot context).",
            });
            emit({ ...baseEvent, type: "turn.completed", ok: false, stopReason: "error" });
            activeTurns.delete(threadId);
            return { turnId };
          }

          emit({ ...baseEvent, type: "turn.started" });
          emit({ ...baseEvent, type: "session.started", sessionId: threadId, model: adapter.defaultModel });

          const mode = config.transport ?? "auto";
          const bridge = deps.userscriptBridge ?? getDefaultUserscriptBridge();
          const targetOrigin = new URL(config.url || adapter.defaultUrl).origin;
          const checkCdp = deps.checkCdpAvailable ?? checkCdpAvailable;
          const cdpUrl = config.cdpUrl ?? "http://127.0.0.1:9222";

          let useUserscript = false;
          let useCdp = false;

          if (!deps.pageFactory && !deps.viewerHub && !deps.browserService) {
            if (mode === "userscript") {
              if (bridge.getTabCount(targetOrigin) === 0) {
                emit({
                  ...baseEvent,
                  type: "runtime.error",
                  message: "未检测到已连接的油猴脚本标签页，请在浏览器中打开 Hark 页面并确认油猴脚本运行",
                });
                emit({ ...baseEvent, type: "turn.completed", ok: false, stopReason: "error" });
                activeTurns.delete(threadId);
                return { turnId };
              }
              useUserscript = true;
            } else if (mode === "cdp") {
              if (!(await checkCdp(cdpUrl))) {
                emit({
                  ...baseEvent,
                  type: "runtime.error",
                  message: `未检测到运行在 ${cdpUrl} 的 Chrome，请以 --remote-debugging-port 启动`,
                });
                emit({ ...baseEvent, type: "turn.completed", ok: false, stopReason: "error" });
                activeTurns.delete(threadId);
                return { turnId };
              }
              useCdp = true;
            } else if (mode === "auto") {
              if (bridge.getTabCount(targetOrigin) > 0) {
                useUserscript = true;
              } else if (await checkCdp(cdpUrl)) {
                useCdp = true;
              } else {
                emit({
                  ...baseEvent,
                  type: "runtime.error",
                  message: "未检测到可用的真实浏览器传输：请安装油猴脚本并打开 Hark 页面，或以 --remote-debugging-port=9222 启动 Chrome",
                });
                emit({ ...baseEvent, type: "turn.completed", ok: false, stopReason: "error" });
                activeTurns.delete(threadId);
                return { turnId };
              }
            }
          }

          if (useUserscript) {
            const onAbort = () => {
              bridge.cancelTurn(turnId);
              emit({ ...baseEvent, type: "turn.completed", ok: false, stopReason: "cancelled" });
              activeTurns.delete(threadId);
            };
            abortController.signal.addEventListener("abort", onAbort, { once: true });

            try {
              await bridge.sendPrompt(
                {
                  origin: targetOrigin,
                  turnId,
                  text,
                  sessionReset,
                  selectors,
                  minDelayMs: config.minDelayMs,
                  maxDelayMs: config.maxDelayMs,
                },
                {
                  onDelta(deltaText) {
                    // "item.delta" has no variant in RuntimeEvent; the userscript stream rides the wire as-is.
                    emit({
                      ...baseEvent,
                      type: "item.delta",
                      text: deltaText,
                    } as unknown as RuntimeEvent);
                  },
                  onDone(finalText) {
                    abortController.signal.removeEventListener("abort", onAbort);
                    emit({
                      ...baseEvent,
                      type: "item.completed",
                      itemType: "assistant_text",
                      text: finalText,
                    } as unknown as RuntimeEvent);
                    emit({
                      ...baseEvent,
                      type: "turn.completed",
                      ok: true,
                      stopReason: "stop",
                    });
                    activeTurns.delete(threadId);
                  },
                  onError(err) {
                    abortController.signal.removeEventListener("abort", onAbort);
                    emit({
                      ...baseEvent,
                      type: "runtime.error",
                      message: err.message,
                    });
                    emit({
                      ...baseEvent,
                      type: "turn.completed",
                      ok: false,
                      stopReason: "error",
                    });
                    activeTurns.delete(threadId);
                  },
                },
              );
            } catch (err) {
              abortController.signal.removeEventListener("abort", onAbort);
              emit({
                ...baseEvent,
                type: "runtime.error",
                message: err instanceof Error ? err.message : String(err),
              });
              emit({
                ...baseEvent,
                type: "turn.completed",
                ok: false,
                stopReason: "error",
              });
              activeTurns.delete(threadId);
            }
            return { turnId };
          }

          let effectiveGetPage = getPageForTurn;
          if (useCdp) {
            const cdpFactory = deps.cdpPageFactory ?? createWebChatPageFromCdpEndpoint;
            effectiveGetPage = async () => {
              return cdpFactory(config.url || adapter.defaultUrl, {
                cdpUrl,
                timeoutMs: config.timeoutMs,
                minDelayMs: config.minDelayMs,
                maxDelayMs: config.maxDelayMs,
              });
            };
          }

          void (async () => {
            let attempt = 0;
            while (attempt < 2) {
              let page: WebChatPage | null = null;
              try {
                page = await effectiveGetPage(threadId, botId);
                await runWebChatTurn({
                  page,
                  adapter,
                  config,
                  sessionStore,
                  threadId,
                  turnId,
                  prompt: text,
                  sessionReset,
                  abortSignal: abortController.signal,
                  emit,
                  now: deps.now,
                  sleep: deps.sleep,
                });
                break;
              } catch (err) {
                if (abortController.signal.aborted || (err instanceof Error && err.message.includes("cancelled"))) {
                  emit({ ...baseEvent, type: "turn.completed", ok: false, stopReason: "cancelled" });
                  break;
                }
                if (err instanceof TurnAuthenticationRefusedError) {
                  emit({
                    ...baseEvent,
                    type: "runtime.error",
                    message: err.message,
                  });
                  emit({ ...baseEvent, type: "turn.completed", ok: false, stopReason: "error" });
                  break;
                }
                attempt++;
                if (attempt < 2) {
                  emit({
                    ...baseEvent,
                    type: "turn.retrying",
                    attempt: 1,
                    delayMs: 1000,
                    reason: err instanceof Error ? err.message : String(err),
                  });
                  const sleepFn = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
                  await sleepFn(1000);
                  continue;
                }
                emit({
                  ...baseEvent,
                  type: "runtime.error",
                  message: err instanceof Error ? err.message : String(err),
                });
                emit({ ...baseEvent, type: "turn.completed", ok: false, stopReason: "error" });
                break;
              } finally {
                await page?.close?.().catch(() => {});
                threadPages.delete(threadId);
              }
            }
            activeTurns.delete(threadId);
          })();

          return { turnId };
        },

        async interruptTurn(threadId: ThreadId, _turnId?: TurnId): Promise<void> {
          const running = activeTurns.get(threadId);
          if (running) {
            running.abortController.abort();
          }
        },

        async respondToRequest(): Promise<RequestOutcome> {
          return "unavailable";
        },

        hasSession(threadId: ThreadId): boolean {
          return activeTurns.has(threadId) || Boolean(sessionStore.get(threadId));
        },

        async stopAll(): Promise<void> {
          for (const { abortController } of activeTurns.values()) {
            abortController.abort();
          }
          activeTurns.clear();
        },

        onEvent(listener: RuntimeEventListener): () => void {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };

      return {
        instanceId,
        driverKind: adapter.driverKind,
        displayName: input.displayName,
        enabled: input.enabled,
        models,
        adapter: adapterImpl,
        async snapshot(): Promise<ProviderSnapshot> {
          const mode = config.transport ?? "auto";
          const bridge = deps.userscriptBridge ?? getDefaultUserscriptBridge();
          const targetOrigin = new URL(config.url || adapter.defaultUrl).origin;
          const checkCdp = deps.checkCdpAvailable ?? checkCdpAvailable;
          const cdpUrl = config.cdpUrl ?? "http://127.0.0.1:9222";

          if (deps.pageFactory) {
            return {
              state: "available",
              authenticated: true,
              reason: "首次回合时在页面上检查登录",
            };
          }

          if (mode === "userscript") {
            const count = bridge.getTabCount(targetOrigin);
            if (count > 0) {
              return {
                state: "available",
                authenticated: true,
                reason: `已连接 ${count} 个油猴脚本标签页`,
              };
            }
            return {
              state: "unavailable",
              authenticated: false,
              reason: "未检测到已连接的油猴脚本标签页，请在浏览器中打开 Hark 页面并确认油猴脚本运行",
            };
          }

          if (mode === "cdp") {
            try {
              const resolver = deps.resolveConnectOverCDP ?? resolveConnectOverCDP;
              await resolver(deps as unknown as CdpTransportDeps);
            } catch (err: any) {
              return {
                state: "unavailable",
                authenticated: false,
                reason: err?.message || "需要安装 playwright-core",
              };
            }
            const cdpOk = await checkCdp(cdpUrl);
            if (cdpOk) {
              return {
                state: "available",
                authenticated: true,
                reason: `已连接外部 Chrome CDP (${cdpUrl})`,
              };
            }
            return {
              state: "unavailable",
              authenticated: false,
              reason: `未检测到运行在 ${cdpUrl} 的 Chrome，请以 --remote-debugging-port 启动`,
            };
          }

          // Auto mode: check userscript first, then CDP; workbench is only for explicit mode === "workbench"
          if (mode === "auto") {
            const count = bridge.getTabCount(targetOrigin);
            if (count > 0) {
              return {
                state: "available",
                authenticated: true,
                reason: `已连接 ${count} 个油猴脚本标签页（传输一：油猴脚本桥）`,
              };
            }

            const cdpOk = await checkCdp(cdpUrl);
            if (cdpOk) {
              return {
                state: "available",
                authenticated: true,
                reason: `已连接外部 Chrome CDP（传输二：CDP 接管，${cdpUrl}）`,
              };
            }

            if (!deps.viewerHub && !deps.browserService) {
              return unknownSnapshot("需在工作台浏览器查看器中打开并登录 Hark，或连接油猴脚本/CDP");
            }
          }

          // Workbench browser check (mode === "workbench" or explicit viewerHub/browserService)
          if (mode === "workbench" || deps.viewerHub || deps.browserService) {
            let awakeHub: ViewerHub | null = null;
            const service = deps.browserService ?? getWorkbenchBrowserService() ?? (globalThis as unknown as { __ombBrowserService?: BrowserService }).__ombBrowserService;
            if (deps.viewerHub?.host.awake()) {
              awakeHub = deps.viewerHub;
            } else {
              const instanceHub = getWorkbenchViewerHub(instanceId);
              if (instanceHub?.host.awake()) {
                awakeHub = instanceHub;
              } else if (service) {
                const resolver = deps.resolveBrowserTarget ?? getWorkbenchBrowserTargetResolver();
                const botIdsFor = deps.botIdsForInstance ?? getWorkbenchBotIdsForInstance();
                const candidates = botIdsFor ? botIdsFor(instanceId) : [];
                const botIds = candidates.length > 0
                  ? candidates
                  : [(deps as any).botId ?? (instanceId.startsWith("bot:") ? instanceId.slice(4) : instanceId)];
                for (const botId of botIds) {
                  let targetKey: string | null = null;
                  if (resolver) {
                    try {
                      const target = resolver(botId);
                      targetKey = target?.key ?? null;
                    } catch {}
                  }
                  if (targetKey) {
                    const targetProfile = service.profiles().find((p) => p.key === targetKey);
                    if (targetProfile?.hub.host.awake()) {
                      awakeHub = targetProfile.hub;
                      break;
                    }
                  }
                }
              }
            }

            if (deps.viewerHub || getWorkbenchViewerHub(instanceId) || service) {
              if (!awakeHub) {
                return unknownSnapshot(`需在工作台浏览器查看器中打开并登录 ${adapter.displayName}（${config.url || adapter.defaultUrl}）`);
              }

              try {
                const tabs = awakeHub.host.tabs();
                const targetTab = tabs.find((t) => {
                  try {
                    return new URL(t.page.url()).origin === targetOrigin;
                  } catch {
                    return false;
                  }
                });

                if (!targetTab) {
                  return unknownSnapshot(`需在工作台浏览器查看器中打开并登录 ${adapter.displayName}（${config.url || adapter.defaultUrl}）`);
                }

                const page = createWebChatPageFromCdp(targetTab.page);
                const authStatus = await checkPageLogin(page, selectors);
                if (!authStatus.loggedIn) {
                  return {
                    state: "unavailable",
                    reason: `在工作台浏览器查看器中登录 ${adapter.displayName}（${config.url || adapter.defaultUrl}）`,
                    authenticated: false,
                  };
                }
                return {
                  state: "available",
                  authenticated: true,
                };
              } catch {
                return unknownSnapshot(`需在工作台浏览器查看器中打开并登录 ${adapter.displayName}（${config.url || adapter.defaultUrl}）`);
              }
            }
          }

          return unknownSnapshot("需在工作台浏览器查看器中打开并登录 Hark，或连接油猴脚本/CDP");
        },
        async dispose(): Promise<void> {
          listeners.clear();
          for (const page of threadPages.values()) {
            if (page.close) {
              await page.close().catch(() => {});
            }
          }
          threadPages.clear();
        },
      };
    },
  };
}
