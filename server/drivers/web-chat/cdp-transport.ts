import type { WebChatPage } from "./types.ts";

export interface CdpTabInfo {
  id: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpTransportDeps {
  fetchFn?: typeof fetch;
  connectOverCDP?: (endpointURL: string) => Promise<any>;
  importModule?: (name: string) => Promise<any>;
}

export async function checkCdpAvailable(
  cdpUrl = "http://127.0.0.1:9222",
  timeoutMs = 1500,
  deps: CdpTransportDeps = {},
): Promise<boolean> {
  const fetchImpl = deps.fetchFn ?? fetch;
  try {
    const res = await fetchImpl(`${cdpUrl.replace(/\/+$/, "")}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listCdpTabs(
  cdpUrl = "http://127.0.0.1:9222",
  timeoutMs = 2000,
  deps: CdpTransportDeps = {},
): Promise<CdpTabInfo[]> {
  const fetchImpl = deps.fetchFn ?? fetch;
  try {
    const res = await fetchImpl(`${cdpUrl.replace(/\/+$/, "")}/json/list`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    return (await res.json()) as CdpTabInfo[];
  } catch {
    return [];
  }
}

export async function resolveConnectOverCDP(deps: CdpTransportDeps = {}): Promise<(endpointURL: string) => Promise<any>> {
  if (deps.connectOverCDP) return deps.connectOverCDP;
  const importFn = deps.importModule ?? ((name: string) => import(name));
  try {
    const mod = await importFn("playwright-core");
    return mod.chromium.connectOverCDP.bind(mod.chromium);
  } catch {
    try {
      const mod = await importFn("playwright");
      return mod.chromium.connectOverCDP.bind(mod.chromium);
    } catch {
      throw new Error("需要安装 playwright-core");
    }
  }
}

export async function createWebChatPageFromCdpEndpoint(
  targetUrl: string,
  options: {
    cdpUrl?: string;
    timeoutMs?: number;
    minDelayMs?: number;
    maxDelayMs?: number;
  } = {},
  deps: CdpTransportDeps = {},
): Promise<WebChatPage> {
  const cdpUrl = options.cdpUrl ?? "http://127.0.0.1:9222";
  const targetHost = new URL(targetUrl).hostname;
  const isTargetHost = (uStr: string) => {
    try {
      const h = new URL(uStr).hostname;
      return h === targetHost || h.endsWith("." + targetHost);
    } catch {
      return false;
    }
  };

  const connect = await resolveConnectOverCDP(deps);
  const browser = await connect(cdpUrl);
  const contexts = browser.contexts?.() ?? [];

  // D: 只用 URL 属于 hark.com 的标签页；没有就新开一个标签页打开 hark.com，回合结束只关自己新开的那个，绝不复用或关闭用户其他标签页
  let playwrightPage: any = null;
  let isNewTab = false;

  for (const ctx of contexts) {
    const pages = ctx.pages?.() ?? [];
    for (const p of pages) {
      if (isTargetHost(p.url())) {
        playwrightPage = p;
        break;
      }
    }
    if (playwrightPage) break;
  }

  if (!playwrightPage) {
    const ctx = contexts[0] ?? (await browser.newContext());
    playwrightPage = await ctx.newPage();
    isNewTab = true;
    await playwrightPage.goto(targetUrl);
  }

  const minDelay = options.minDelayMs ?? 1000;
  const maxDelay = options.maxDelayMs ?? 3000;

  async function randomDelay(): Promise<void> {
    const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    await new Promise((r) => setTimeout(r, delay));
  }

  // -b: 选择器逐个 first() 取、可见性用 isVisible
  async function findVisibleLocator(selector: string) {
    if (typeof playwrightPage.locator !== "function") return null;
    const parts = selector.split(",").map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      const locator = playwrightPage.locator(part).first();
      const visible = await locator.isVisible().catch(() => false);
      if (visible) return locator;
    }
    return null;
  }

  return {
    url: () => playwrightPage.url(),
    navigate: async (u) => { await playwrightPage.goto(u); },
    waitForSelector: async (s, opt) => {
      if (typeof playwrightPage.waitForSelector === "function") {
        try {
          await playwrightPage.waitForSelector(s, { timeout: opt?.timeoutMs ?? 5000 });
          return true;
        } catch {
          return false;
        }
      }
      const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
      const start = Date.now();
      const timeout = opt?.timeoutMs ?? 5000;
      while (Date.now() - start < timeout) {
        for (const part of parts) {
          if (typeof playwrightPage.locator === "function") {
            const locator = playwrightPage.locator(part).first();
            if (await locator.isVisible().catch(() => false)) return true;
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    },
    fill: async (s, text, opt) => {
      await randomDelay();
      const locator = await findVisibleLocator(s);
      if (locator) {
        await locator.fill(text, { timeout: opt?.timeoutMs ?? 5000 });
        return;
      }
      if (typeof playwrightPage.fill === "function") {
        await playwrightPage.fill(s, text, opt);
        return;
      }
      const firstPart = s.split(",")[0].trim();
      await playwrightPage.locator(firstPart).first().fill(text, { timeout: opt?.timeoutMs ?? 5000 });
    },
    click: async (s, opt) => {
      await randomDelay();
      const locator = await findVisibleLocator(s);
      if (locator) {
        await locator.click({ timeout: opt?.timeoutMs ?? 5000 });
        return;
      }
      if (typeof playwrightPage.click === "function") {
        await playwrightPage.click(s, opt);
        return;
      }
      const firstPart = s.split(",")[0].trim();
      await playwrightPage.locator(firstPart).first().click({ timeout: opt?.timeoutMs ?? 5000 });
    },
    evaluate: async (script) => playwrightPage.evaluate(script),
    isVisible: async (s) => {
      const locator = await findVisibleLocator(s);
      if (locator !== null) return true;
      if (typeof playwrightPage.isVisible === "function") {
        return Boolean(await playwrightPage.isVisible(s).catch(() => false));
      }
      return false;
    },
    getText: async (s) => {
      // -b: 回复取最后一条，找不到时报错而不是返回整页文字。
      if (typeof playwrightPage.locator === "function") {
        const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
        for (const part of parts) {
          const locators = playwrightPage.locator(part);
          const count = await locators.count().catch(() => 0);
          if (count > 0) {
            const lastLocator = locators.nth(count - 1);
            const text = await lastLocator.textContent().catch(() => "");
            if (text && text.trim().length > 0) {
              return text.trim();
            }
          }
        }
      } else if (typeof playwrightPage.textContent === "function") {
        const text = await playwrightPage.textContent(s).catch(() => "");
        if (text && text.trim().length > 0) return text.trim();
      }
      throw new Error(`No assistant message found matching selector "${s}"`);
    },
    close: async () => {
      if (isNewTab) {
        await playwrightPage.close?.().catch(() => {});
      }
      await browser.close?.().catch(() => {});
    },
  };
}
