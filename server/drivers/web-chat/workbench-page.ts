import type { CdpPage } from "../../browser/cdp/page.ts";
import type { ViewerHub } from "../../browser/viewers/core.ts";
import type { BrowserService, BrowserTarget } from "../../browser/service.ts";
import type { WebChatPage } from "./types.ts";

export type WorkbenchBrowserTargetResolver = (botId: string) => BrowserTarget;

let activeBrowserService: BrowserService | null = null;
let activeBrowserTargetResolver: WorkbenchBrowserTargetResolver | null = null;
const activeViewerHubs = new Map<string, ViewerHub>();

export function setWorkbenchBrowserService(service: BrowserService | null): void {
  activeBrowserService = service;
}

export function getWorkbenchBrowserService(): BrowserService | null {
  return activeBrowserService;
}

export function setWorkbenchBrowserTargetResolver(resolver: WorkbenchBrowserTargetResolver | null): void {
  activeBrowserTargetResolver = resolver;
}

export function getWorkbenchBrowserTargetResolver(): WorkbenchBrowserTargetResolver | null {
  return activeBrowserTargetResolver;
}

export type WorkbenchBotIdsForInstance = (instanceId: string) => string[];

let activeBotIdsForInstance: WorkbenchBotIdsForInstance | null = null;

export function setWorkbenchBotIdsForInstance(fn: WorkbenchBotIdsForInstance | null): void {
  activeBotIdsForInstance = fn;
}

export function getWorkbenchBotIdsForInstance(): WorkbenchBotIdsForInstance | null {
  return activeBotIdsForInstance;
}

export function setWorkbenchViewerHub(instanceId: string, hub: ViewerHub | null): void {
  if (hub) {
    activeViewerHubs.set(instanceId, hub);
  } else {
    activeViewerHubs.delete(instanceId);
  }
}

export function getWorkbenchViewerHub(instanceId: string): ViewerHub | null {
  return activeViewerHubs.get(instanceId) ?? null;
}

async function operateOnFirstVisible(
  cdpPage: CdpPage,
  selector: string,
  action: (singleSelector: string) => Promise<void>,
  _timeoutMs?: number,
): Promise<void> {
  const marker = `wc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const marked = await cdpPage.evaluate<boolean>(`(() => {
    // data-omb-webchat setAttribute
    const parts = ${JSON.stringify(selector)}.split(',').map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
      const nodes = document.querySelectorAll(part);
      for (const el of nodes) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          el.setAttribute('data-omb-webchat', ${JSON.stringify(marker)});
          return true;
        }
      }
    }
    return false;
  })()`).catch(() => false);

  const targetSelector = marked ? `[data-omb-webchat="${marker}"]` : selector.split(",")[0]?.trim() ?? selector;
  try {
    await action(targetSelector);
  } finally {
    if (marked) {
      await cdpPage.evaluate(`(() => {
        // removeAttribute('data-omb-webchat')
        const el = document.querySelector('[data-omb-webchat="${marker}"]');
        if (el) el.removeAttribute('data-omb-webchat');
      })()`).catch(() => {});
    }
  }
}

export function createWebChatPageFromCdp(cdpPage: CdpPage): WebChatPage {
  return {
    url(): string {
      return cdpPage.url();
    },
    async navigate(url: string, options?: { timeoutMs?: number }): Promise<void> {
      await cdpPage.navigate(url, { timeoutMs: options?.timeoutMs });
    },
    async waitForSelector(selector: string, options?: { timeoutMs?: number }): Promise<boolean> {
      const timeoutMs = options?.timeoutMs ?? 15_000;
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (await this.isVisible(selector)) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    },
    async fill(selector: string, text: string, options?: { timeoutMs?: number }): Promise<void> {
      await operateOnFirstVisible(
        cdpPage,
        selector,
        (target) => cdpPage.fill({ selector: target }, text, { timeoutMs: options?.timeoutMs }),
        options?.timeoutMs,
      );
    },
    async click(selector: string, options?: { timeoutMs?: number }): Promise<void> {
      await operateOnFirstVisible(
        cdpPage,
        selector,
        (target) => cdpPage.click({ selector: target }, { timeoutMs: options?.timeoutMs }),
        options?.timeoutMs,
      );
    },
    async evaluate<T = unknown>(script: string): Promise<T> {
      return (await cdpPage.evaluate(script)) as T;
    },
    async isVisible(selector: string): Promise<boolean> {
      try {
        const visible = await cdpPage.evaluate<boolean>(`(() => {
          // isElVisible
          const parts = ${JSON.stringify(selector)}.split(',').map(s => s.trim()).filter(Boolean);
          for (const part of parts) {
            const el = document.querySelector(part);
            if (!el) continue;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return true;
          }
          return false;
        })()`).catch(() => false);
        return Boolean(visible);
      } catch {
        return false;
      }
    },
    async getText(selector: string): Promise<string> {
      // -b: 回复取最后一条，找不到时报错而不是返回整页文字。
      const text = await cdpPage.evaluate<string>(`(() => {
        // lastNode assistantMessage
        const parts = ${JSON.stringify(selector)}.split(',').map(s => s.trim()).filter(Boolean);
        let lastNode = null;
        for (const part of parts) {
          try {
            const nodes = document.querySelectorAll(part);
            if (nodes && nodes.length > 0) {
              lastNode = nodes[nodes.length - 1];
            }
          } catch {}
        }
        if (!lastNode) {
          try {
            const nodes = document.querySelectorAll(${JSON.stringify(selector)});
            if (nodes && nodes.length > 0) {
              lastNode = nodes[nodes.length - 1];
            }
          } catch {}
        }
        if (!lastNode) return '__NOT_FOUND__';
        return (lastNode.innerText || lastNode.textContent || '').trim();
      })()`).catch(() => '__NOT_FOUND__');

      if (text === '__NOT_FOUND__') {
        throw new Error(`No assistant message found matching selector "${selector}"`);
      }
      return text;
    },
    async close(): Promise<void> {
      await cdpPage.close().catch(() => {});
    },
  };
}

export async function createWebChatPageFromViewerHub(
  hub: ViewerHub,
  targetUrl: string = "https://hark.com",
): Promise<WebChatPage> {
  await hub.host.running();
  const targetHost = new URL(targetUrl).hostname;
  const isTargetHost = (uStr: string) => {
    try {
      const h = new URL(uStr).hostname;
      return h === targetHost || h.endsWith("." + targetHost);
    } catch {
      return false;
    }
  };

  // D: 只用 URL 属于 hark.com 的标签页；没有就新开一个标签页打开 hark.com，回合结束只关自己新开的那个，绝不复用或关闭用户其他标签页。
  const existingTabs = hub.host.tabs();
  let chosenTab = existingTabs.find((t) => isTargetHost(t.page.url()));
  let newlyCreatedTab: any = null;

  if (!chosenTab) {
    newlyCreatedTab = await hub.host.openTab(null, "agent");
    chosenTab = newlyCreatedTab;
    if (targetUrl) {
      await chosenTab.page.navigate(targetUrl).catch(() => {});
    }
  }

  const cdpPage = chosenTab.page;
  const page = createWebChatPageFromCdp(cdpPage);
  return {
    ...page,
    async close(): Promise<void> {
      if (newlyCreatedTab) {
        try {
          await hub.host.closeTab(newlyCreatedTab);
        } catch {
          await page.close?.();
        }
      }
    },
  };
}

export async function createWebChatPageFromBrowserService(
  service: BrowserService,
  target: BrowserTarget,
  targetUrl?: string,
): Promise<WebChatPage> {
  const profile = service.profile(target);
  return createWebChatPageFromViewerHub(profile.hub, targetUrl);
}

export interface WorkbenchPageFactoryDeps {
  browserService?: BrowserService;
  viewerHub?: ViewerHub;
  resolveBrowserTarget?: (botId: string) => BrowserTarget;
}

export function createDefaultWorkbenchPageFactory(
  deps?: WorkbenchPageFactoryDeps,
): (target: { instanceId: string; url: string; profileDir?: string; botId?: string }) => Promise<WebChatPage> {
  return async ({ instanceId, url, botId }) => {
    if (deps?.viewerHub) {
      return createWebChatPageFromViewerHub(deps.viewerHub, url);
    }
    const instanceHub = getWorkbenchViewerHub(instanceId);
    if (instanceHub) {
      return createWebChatPageFromViewerHub(instanceHub, url);
    }

    const service = deps?.browserService ?? getWorkbenchBrowserService() ?? (globalThis as unknown as { __ombBrowserService?: BrowserService }).__ombBrowserService;
    if (service) {
      const resolver = deps?.resolveBrowserTarget ?? getWorkbenchBrowserTargetResolver();
      const targetBotId = botId || "harkWeb";
      const browserTarget = resolver ? resolver(targetBotId) : service.profiles()[0]?.target;
      if (!browserTarget) {
        throw new Error(`Failed to resolve browser target for bot "${targetBotId}"`);
      }
      return createWebChatPageFromBrowserService(service, browserTarget, url);
    }

    throw new Error(
      `No workbench browser service or ViewerHub available for instance "${instanceId}". ` +
      `Ensure the workbench browser is running or configure a browser page factory.`
    );
  };
}
