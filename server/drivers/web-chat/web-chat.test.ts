import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent, SendTurnInput } from "../../contracts.ts";
import { BrowserService, type BrowserTarget } from "../../browser/service.ts";
import { FakeBackend, FakeChrome, type FakeDocument } from "../../browser/testing/fake-chrome.ts";
import type { ViewerHub } from "../../browser/viewers/core.ts";
import { WebChatUserscriptBridge } from "./userscript-bridge.ts";
import { createWebChatPageFromCdpEndpoint, resolveConnectOverCDP } from "./cdp-transport.ts";
import {
  checkPageLogin,
  createDefaultWorkbenchPageFactory,
  createWebChatDriver,
  createWebChatPageFromViewerHub,
  extractLatestAssistantText,
  resolveProfileDir,
  probeWebChatSubmitted,
  runWebChatTurn,
  setWorkbenchBrowserService,
  setWorkbenchBrowserTargetResolver,
  WebChatSessionStore,
  WebChatSubmittedError,
  webChatStabilityMs,
} from "./core.ts";
import { captureHarkBaseline, extractHarkReply, HARK_ADAPTER, HarkWebDriver, harkReplyFromEntries, harkSubmittedFromEntries } from "./hark.ts";
import { setWorkbenchBotIdsForInstance } from "./workbench-page.ts";
import type { WebChatPage } from "./types.ts";

// Shared by the real-factory fixtures and the ZBOX-webchat-admin block, which both boot FakeChrome with it.
const HARK_DOC: FakeDocument = {
  title: "Hark Chat",
  text: "Hark Chat\nWelcome",
  elements: [
    { role: "textbox", name: "Hidden Prompt", selector: "textarea", editable: true, box: [0, 0, 0, 0] },
    { role: "textbox", name: "Visible Prompt", selector: "textarea", editable: true, box: [10, 10, 400, 50] },
    {
      role: "button",
      name: "Send",
      selector: 'button[type="submit"]',
      box: [420, 10, 80, 50],
      onClick: (page) => {
        page.text += "\nAssistant response from real ViewerHub";
        page.elements.push({
          role: "paragraph",
          name: "Assistant",
          selector: ".assistant-message",
          box: [10, 70, 400, 100],
          value: "Assistant response from real ViewerHub",
        });
      },
    },
    { role: "paragraph", name: "Assistant First", selector: ".assistant-message", box: [10, 70, 400, 100], value: "First reply" },
    { role: "paragraph", name: "Assistant Last", selector: ".assistant-message", box: [10, 180, 400, 100], value: "Assistant response from real ViewerHub" },
  ],
};

class MockWebChatPage implements WebChatPage {
  currentUrl: string;
  elements = new Map<string, { visible: boolean; text: string; value: string }>();
  clicks: string[] = [];
  fills: Array<{ selector: string; text: string }> = [];
  navigations: string[] = [];
  closed = false;

  constructor(initialUrl = "about:blank") {
    this.currentUrl = initialUrl;
  }

  setElement(selector: string, state: { visible?: boolean; text?: string; value?: string }): void {
    const existing = this.elements.get(selector) ?? { visible: true, text: "", value: "" };
    this.elements.set(selector, {
      visible: state.visible ?? existing.visible,
      text: state.text ?? existing.text,
      value: state.value ?? existing.value,
    });
  }

  url(): string {
    return this.currentUrl;
  }

  async navigate(url: string): Promise<void> {
    this.navigations.push(url);
    this.currentUrl = url;
  }

  async waitForSelector(selector: string): Promise<boolean> {
    for (const part of selector.split(",").map((s) => s.trim())) {
      const el = this.elements.get(part);
      if (el?.visible) return true;
    }
    const el = this.elements.get(selector);
    return el ? el.visible : false;
  }

  async fill(selector: string, text: string): Promise<void> {
    this.fills.push({ selector, text });
    const el = this.elements.get(selector) ?? { visible: true, text: "", value: "" };
    el.value = text;
    this.elements.set(selector, el);
  }

  async click(selector: string): Promise<void> {
    this.clicks.push(selector);
  }

  async evaluate<T = unknown>(_script: string): Promise<T> {
    return true as unknown as T;
  }

  async isVisible(selector: string): Promise<boolean> {
    for (const part of selector.split(",").map((s) => s.trim())) {
      const el = this.elements.get(part);
      if (el?.visible) return true;
    }
    const el = this.elements.get(selector);
    return el ? el.visible : false;
  }

  async getText(selector: string): Promise<string> {
    for (const part of selector.split(",").map((s) => s.trim())) {
      const el = this.elements.get(part);
      if (el && el.text) return el.text;
    }
    const el = this.elements.get(selector);
    return el ? el.text : "";
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class WebChatFakeChrome extends FakeChrome {
  readonly #listeners = new Set<(message: string) => void>();
  #markedElements = new Map<any, string | undefined>();

  override onMessage(listener: (message: string) => void): void {
    this.#listeners.add(listener);
    super.onMessage(listener);
  }

  emitResult(id: number, result: unknown, sessionId?: string | null): void {
    const text = JSON.stringify({ id, result: result ?? {}, ...(sessionId ? { sessionId } : {}) });
    for (const listener of this.#listeners) listener(text);
  }

  #pageFor(sessionId?: string | null): any {
    if (sessionId) {
      const match = /-(T\d+)$/.exec(sessionId);
      if (match && match[1] && this.pages.has(match[1])) {
        return this.pages.get(match[1]);
      }
    }
    const withElements = [...this.pages.values()].filter((p) => p.elements && p.elements.length > 0);
    if (withElements.length > 0) return withElements[withElements.length - 1];
    return [...this.pages.values()][this.pages.size - 1];
  }

  #matchesSelector(el: any, selector: string): boolean {
    if (!selector) return false;
    const parts = selector.split(",").map((s) => s.trim().toLowerCase());
    return parts.some((p) => {
      const elSel = (el.selector ?? "").toLowerCase();
      const elName = (el.name ?? "").toLowerCase();
      const elRole = (el.role ?? "").toLowerCase();

      // Login / Auth indicators
      if (p.includes("login") || p.includes("signin") || p.includes("auth")) {
        return elName.includes("login") || elName.includes("sign") || elSel.includes("login") || elSel.includes("auth");
      }

      // If exact match
      if (elSel && elSel === p) return true;

      // Textbox / textarea
      if (p.includes("textarea") || p.includes("textbox") || p.includes("prompt")) {
        return elRole === "textbox" || elSel.includes("textarea") || elSel.includes("prompt");
      }

      // Submit / Send button
      if (p.includes("submit") || p.includes("send")) {
        return (elRole === "button" || elSel.includes("button")) && (elName.includes("send") || elSel.includes("submit"));
      }

      // Stop / Cancel button
      if (p.includes("stop") || p.includes("cancel")) {
        return (elRole === "button" || elSel.includes("button")) && (elName.includes("stop") || elName.includes("cancel"));
      }

      // Generic button
      if (p === "button" || p.startsWith("button")) {
        return elRole === "button" || elSel.includes("button");
      }

      // Assistant message（hark.com 真站选择器是 [data-testid="message-text"]，fixture 仍用 .assistant-message 元素）
      if (p.includes("assistant") || p.includes("message-text")) {
        return elSel.includes("assistant") || elName.includes("assistant");
      }

      return false;
    });
  }

  override send(message: string): void {
    const parsed = JSON.parse(message) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string | null };
    if (parsed.method === "Runtime.evaluate") {
      const expr = String(parsed.params?.expression ?? "");
      const page = this.#pageFor(parsed.sessionId);
      if (page) {
        if (expr.includes("data-omb-webchat") && expr.includes("setAttribute")) {
          const markerMatch = /data-omb-webchat',\s*(?:JSON\.stringify\()?"([^"]+)"/u.exec(expr) || /"wc-[^"]+"/u.exec(expr);
          const marker = markerMatch ? markerMatch[1] || markerMatch[0].replace(/"/g, "") : "target";
          const selMatch = /const parts = ("(?:[^"\\]|\\.)*")\.split/.exec(expr) || /const sel = ("(?:[^"\\]|\\.)*");/.exec(expr);
          const sel = selMatch ? JSON.parse(selMatch[1]) : "";
          const matching = page.elements.filter((el: any) => this.#matchesSelector(el, sel));
          const visibleEl = matching.find((el: any) => (el.box?.[2] ?? 0) > 0 && (el.box?.[3] ?? 0) > 0);
          if (visibleEl) {
            this.#markedElements.set(visibleEl, visibleEl.selector);
            visibleEl.selector = `[data-omb-webchat="${marker}"]`;
            this.sent.push({ method: parsed.method, params: parsed.params ?? {}, sessionId: parsed.sessionId ?? null });
            queueMicrotask(() => this.emitResult(parsed.id, { result: { type: "boolean", value: true } }, parsed.sessionId));
            return;
          }
          this.sent.push({ method: parsed.method, params: parsed.params ?? {}, sessionId: parsed.sessionId ?? null });
          queueMicrotask(() => this.emitResult(parsed.id, { result: { type: "boolean", value: false } }, parsed.sessionId));
          return;
        }
        if (expr.includes("removeAttribute('data-omb-webchat')")) {
          for (const [el, orig] of this.#markedElements) {
            el.selector = orig;
          }
          this.#markedElements.clear();
          this.sent.push({ method: parsed.method, params: parsed.params ?? {}, sessionId: parsed.sessionId ?? null });
          queueMicrotask(() => this.emitResult(parsed.id, { result: { type: "undefined" } }, parsed.sessionId));
          return;
        }
        if (expr.includes("isElVisible")) {
          const selMatch = /const parts = ("(?:[^"\\]|\\.)*")\.split/.exec(expr) || /const sel = ("(?:[^"\\]|\\.)*");/.exec(expr);
          const sel = selMatch ? JSON.parse(selMatch[1]) : "";
          const matching = page.elements.filter((el: any) => this.#matchesSelector(el, sel));
          const visible = matching.some((el: any) => (el.box?.[2] ?? 0) > 0 && (el.box?.[3] ?? 0) > 0);
          this.sent.push({ method: parsed.method, params: parsed.params ?? {}, sessionId: parsed.sessionId ?? null });
          queueMicrotask(() => this.emitResult(parsed.id, { result: { type: "boolean", value: visible } }, parsed.sessionId));
          return;
        }
        if (expr.includes("lastNode") || expr.includes("assistantMessage") || expr.includes("assistant")) {
          const selMatch = /const parts = ("(?:[^"\\]|\\.)*")\.split/.exec(expr) || /const sel = ("(?:[^"\\]|\\.)*");/.exec(expr);
          const sel = selMatch ? JSON.parse(selMatch[1]) : "";
          const matching = page.elements.filter((el: any) => this.#matchesSelector(el, sel));
          const lastEl = matching[matching.length - 1];
          const text = lastEl ? (lastEl.value ?? lastEl.name ?? "") : "__NOT_FOUND__";
          this.sent.push({ method: parsed.method, params: parsed.params ?? {}, sessionId: parsed.sessionId ?? null });
          queueMicrotask(() => this.emitResult(parsed.id, { result: { type: "string", value: text } }, parsed.sessionId));
          return;
        }
      }
    }
    super.send(message);
  }
}

describe("Web-chat driver (Hark)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "web-chat-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("driver metadata & catalog", () => {
    it("registers harkWeb with fixed hark-web model and proper metadata", () => {
      expect(HarkWebDriver.driverKind).toBe("harkWeb");
      expect(HarkWebDriver.metadata.displayName).toBe("Hark (Web)");
      expect(HarkWebDriver.models).toEqual({
        default: "hark-web",
        options: [{ id: "hark-web", label: "Hark Web" }],
      });
      expect(HarkWebDriver.install?.docsUrl).toBe("https://hark.com");
    });
  });

  describe("standard CSS selectors (no Playwright :has-text, no article:nth-child)", () => {
    it("uses standard CSS selectors in Hark adapter", () => {
      const s = HARK_ADAPTER.selectors;
      expect(s.assistantMessage).not.toContain(":nth-child");
      expect(s.assistantMessage).not.toContain(":has-text");
      expect(s.loggedOutSelector).not.toContain(":has-text");
      expect(s.loggedInSelector).not.toContain(":has-text");
    });
  });

  describe("shared workbench browser profile directory", () => {
    it("resolves profile directory to workbench browser profile path", () => {
      const resolved = resolveProfileDir({ OMB_DATA_DIR: tempDir }, { key: "bot:hark-inst" });
      expect(resolved).toContain(join(tempDir, "browser", "profiles"));
      expect(resolved).not.toContain("web-chat/hark-inst/profile");
    });
  });

  describe("page-based login check", () => {
    it("detects logged out when logged-out indicator is visible", async () => {
      const mockPage = new MockWebChatPage("https://hark.com");
      mockPage.setElement(HARK_ADAPTER.selectors.loggedOutSelector!, { visible: true });

      const res = await checkPageLogin(mockPage, HARK_ADAPTER.selectors);
      expect(res.loggedIn).toBe(false);
      expect(res.reason).toContain("登录或注册");
    });

    it("detects logged out when redirected to login page", async () => {
      const mockPage = new MockWebChatPage("https://hark.com/login");

      const res = await checkPageLogin(mockPage, HARK_ADAPTER.selectors);
      expect(res.loggedIn).toBe(false);
      expect(res.reason).toContain("重定向至登录页");
    });

    it("detects logged in when input element appears", async () => {
      const mockPage = new MockWebChatPage("https://hark.com");
      mockPage.setElement(HARK_ADAPTER.selectors.input, { visible: true });

      const res = await checkPageLogin(mockPage, HARK_ADAPTER.selectors);
      expect(res.loggedIn).toBe(true);
    });

    it("snapshot reports unavailable when logged-out indicator is visible", async () => {
      const mockPage = new MockWebChatPage("https://hark.com");
      mockPage.setElement(HARK_ADAPTER.selectors.loggedOutSelector!, { visible: true });

      const driver = createWebChatDriver(HARK_ADAPTER, {
        pageFactory: async () => mockPage,
        sleep: async () => {},
      });

      const instance = await driver.create({
        instanceId: "hark-auth-snap",
        displayName: "Hark Test",
        enabled: true,
        environment: { HOME: tempDir },
        config: {},
      });

      const snapshot = await instance.snapshot();
      expect(snapshot.state).toBe("available");
      expect(snapshot.reason).toContain("首次回合时在页面上检查登录");
    });

    it("snapshot reports available without starting browser", async () => {
      const mockPage = new MockWebChatPage("https://hark.com");
      mockPage.setElement(HARK_ADAPTER.selectors.input, { visible: true });

      const driver = createWebChatDriver(HARK_ADAPTER, {
        pageFactory: async () => mockPage,
        sleep: async () => {},
      });

      const instance = await driver.create({
        instanceId: "hark-auth-avail",
        displayName: "Hark Test",
        enabled: true,
        environment: { HOME: tempDir },
        config: {},
      });

      const snapshot = await instance.snapshot();
      expect(snapshot.state).toBe("available");
      expect(snapshot.authenticated).toBe(true);
      expect(snapshot.reason).toContain("首次回合时在页面上检查登录");
    });
  });

  describe("turn execution with mock page", () => {
    it("runs prompt input -> completion detection -> extracts response text -> emits RuntimeEvents", async () => {
      const mockPage = new MockWebChatPage("https://hark.com");
      mockPage.setElement(HARK_ADAPTER.selectors.input, { visible: true });
      mockPage.setElement(HARK_ADAPTER.selectors.submitButton!, { visible: true });

      let time = 1000;
      let submitTime = 0;
      const customNow = () => time;
      const customSleep = async (ms: number) => {
        time += ms;
        if (mockPage.clicks.includes(HARK_ADAPTER.selectors.submitButton!)) {
          if (!submitTime) submitTime = time;
          const elapsedAfterSubmit = time - submitTime;
          if (elapsedAfterSubmit < 500) {
            mockPage.setElement(HARK_ADAPTER.selectors.stopButton!, { visible: true });
            mockPage.setElement(HARK_ADAPTER.selectors.assistantMessage, { text: "Hello from" });
          } else {
            mockPage.setElement(HARK_ADAPTER.selectors.stopButton!, { visible: false });
            mockPage.setElement(HARK_ADAPTER.selectors.assistantMessage, { text: "Hello from Hark web!" });
            mockPage.currentUrl = "https://hark.com/chat/hark-session-123";
          }
        }
      };

      const driver = createWebChatDriver(HARK_ADAPTER, {
        pageFactory: async () => mockPage,
        now: customNow,
        sleep: customSleep,
      });

      const instance = await driver.create({
        instanceId: "hark-run",
        displayName: "Hark",
        enabled: true,
        environment: { HOME: tempDir },
        config: { stabilitySec: 1.0 },
      });

      const events: RuntimeEvent[] = [];
      instance.adapter.onEvent((ev) => events.push(ev));

      const turn = await instance.adapter.sendTurn({
        threadId: "thread-1",
        turnId: "turn-1",
        text: "Say hello",
        botId: "bot-test",
      } as SendTurnInput & { turnId: string });

      expect(turn.turnId).toBe("turn-1");

      await new Promise((r) => setTimeout(r, 60));

      expect(mockPage.fills).toEqual([{ selector: HARK_ADAPTER.selectors.input, text: "Say hello" }]);
      expect(mockPage.clicks).toContain(HARK_ADAPTER.selectors.submitButton!);

      const types = events.map((e) => e.type);
      expect(types).toContain("turn.started");
      expect(types).toContain("session.started");
      expect(types).toContain("content.delta");
      expect(types).toContain("item.completed");
      expect(types).toContain("turn.completed");

      const itemCompleted = events.find((e) => e.type === "item.completed") as { text?: string; itemType?: string };
      expect(itemCompleted.text).toBe("Hello from Hark web!");
      expect(itemCompleted.itemType, "routines only collect assistant_text items").toBe("assistant_text");

      const turnCompleted = events.find((e) => e.type === "turn.completed") as { ok?: boolean; stopReason?: string };
      expect(turnCompleted.ok).toBe(true);
      expect(turnCompleted.stopReason).toBe("stop");
    });

    it("persists conversation URL across multiple turns in the same thread", async () => {
      const mockPage = new MockWebChatPage("https://hark.com");
      mockPage.setElement(HARK_ADAPTER.selectors.input, { visible: true });
      mockPage.setElement(HARK_ADAPTER.selectors.submitButton!, { visible: true });

      let time = 1000;
      const customNow = () => time;
      const customSleep = async (ms: number) => {
        time += ms;
        if (mockPage.clicks.includes(HARK_ADAPTER.selectors.submitButton!)) {
          mockPage.currentUrl = "https://hark.com/c/hark-thread-456";
        }
        mockPage.setElement(HARK_ADAPTER.selectors.assistantMessage, { text: "Response" });
      };

      const driver = createWebChatDriver(HARK_ADAPTER, {
        pageFactory: async () => mockPage,
        now: customNow,
        sleep: customSleep,
      });

      const instance = await driver.create({
        instanceId: "hark-multiturn",
        displayName: "Hark",
        enabled: true,
        environment: { HOME: tempDir },
        config: { stabilitySec: 0.5 },
      });

      await instance.adapter.sendTurn({
        threadId: "thread-multi",
        turnId: "turn-a",
        text: "First turn",
        botId: "bot-test",
      } as SendTurnInput & { turnId: string });
      await new Promise((r) => setTimeout(r, 60));

      const sessionsFile = join(tempDir, ".openmausbot", "web-chat", "hark-multiturn", "sessions.json");
      const store = new WebChatSessionStore(sessionsFile);
      expect(store.get("thread-multi")).toBe("https://hark.com/c/hark-thread-456");

      mockPage.currentUrl = "about:blank";
      await instance.adapter.sendTurn({
        threadId: "thread-multi",
        turnId: "turn-b",
        text: "Second turn",
        botId: "bot-test",
      } as SendTurnInput & { turnId: string });
      await new Promise((r) => setTimeout(r, 60));

      expect(mockPage.navigations).toContain("https://hark.com/c/hark-thread-456");
    });

    it("supports turn cancellation by clicking stop button", async () => {
      const mockPage = new MockWebChatPage("https://hark.com");
      mockPage.setElement(HARK_ADAPTER.selectors.input, { visible: true });
      mockPage.setElement(HARK_ADAPTER.selectors.submitButton!, { visible: true });
      mockPage.setElement(HARK_ADAPTER.selectors.stopButton!, { visible: true });

      let time = 1000;
      const customNow = () => time;
      const customSleep = async (ms: number) => {
        time += ms;
        mockPage.setElement(HARK_ADAPTER.selectors.assistantMessage, { text: "Working..." });
      };

      const driver = createWebChatDriver(HARK_ADAPTER, {
        pageFactory: async () => mockPage,
        now: customNow,
        sleep: customSleep,
      });

      const instance = await driver.create({
        instanceId: "hark-cancel",
        displayName: "Hark",
        enabled: true,
        environment: { HOME: tempDir },
        config: { stabilitySec: 1.0 },
      });

      const events: RuntimeEvent[] = [];
      instance.adapter.onEvent((ev) => events.push(ev));

      await instance.adapter.sendTurn({
        threadId: "thread-cancel",
        turnId: "turn-cancel",
        text: "Cancel me",
        botId: "bot-test",
      } as SendTurnInput & { turnId: string });

      await instance.adapter.interruptTurn("thread-cancel");
      await new Promise((r) => setTimeout(r, 50));

      expect(mockPage.clicks).toContain(HARK_ADAPTER.selectors.stopButton!);

      const turnCompleted = events.find((e) => e.type === "turn.completed") as { ok?: boolean; stopReason?: string };
      expect(turnCompleted).toBeDefined();
      expect(turnCompleted.ok).toBe(false);
      expect(turnCompleted.stopReason).toBe("cancelled");
    });

    it("handles timeout and retries 1 time", async () => {
      const mockPage = new MockWebChatPage("https://hark.com");
      mockPage.setElement(HARK_ADAPTER.selectors.input, { visible: true });
      mockPage.setElement(HARK_ADAPTER.selectors.submitButton!, { visible: true });

      let turnAttempts = 0;
      let time = 1000;
      const customNow = () => time;
      const customSleep = async (ms: number) => {
        time += ms;
        if (turnAttempts === 1) {
          time += 10_000;
        } else {
          mockPage.setElement(HARK_ADAPTER.selectors.assistantMessage, { text: "Recovered reply" });
        }
      };

      const driver = createWebChatDriver(HARK_ADAPTER, {
        pageFactory: async () => mockPage,
        now: customNow,
        sleep: customSleep,
      });

      const instance = await driver.create({
        instanceId: "hark-retry",
        displayName: "Hark",
        enabled: true,
        environment: { HOME: tempDir },
        config: { timeoutMs: 5000, stabilitySec: 0.2 },
      });

      const events: RuntimeEvent[] = [];
      instance.adapter.onEvent((ev) => {
        events.push(ev);
        if (ev.type === "turn.started" || ev.type === "turn.retrying") {
          turnAttempts++;
        }
      });

      await instance.adapter.sendTurn({
        threadId: "thread-retry",
        turnId: "turn-retry",
        text: "Test timeout retry",
        botId: "bot-test",
      } as SendTurnInput & { turnId: string });

      await new Promise((r) => setTimeout(r, 60));

      const retryEvent = events.find((e) => e.type === "turn.retrying") as { attempt?: number; reason?: string };
      expect(retryEvent).toBeDefined();
      expect(retryEvent.attempt).toBe(1);

      const itemCompleted = events.find((e) => e.type === "item.completed") as { text?: string };
      expect(itemCompleted?.text).toBe("Recovered reply");
      // E114: the timeout came after the submit, so the retry only kept waiting — the prompt was typed and sent once.
      expect(mockPage.fills).toHaveLength(1);
      expect(mockPage.clicks.filter((c) => c === HARK_ADAPTER.selectors.submitButton)).toHaveLength(1);
      expect(retryEvent.reason).toContain("不重发");
    });

    it("refuses turn when logged-out indicator is visible on page", async () => {
      const mockPage = new MockWebChatPage("https://hark.com");
      mockPage.setElement(HARK_ADAPTER.selectors.loggedOutSelector!, { visible: true });

      const driver = createWebChatDriver(HARK_ADAPTER, {
        pageFactory: async () => mockPage,
        sleep: async () => {},
      });

      const instance = await driver.create({
        instanceId: "hark-auth-fail",
        displayName: "Hark",
        enabled: true,
        environment: { HOME: tempDir },
        config: {},
      });

      const events: RuntimeEvent[] = [];
      instance.adapter.onEvent((ev) => events.push(ev));

      await instance.adapter.sendTurn({
        threadId: "thread-auth",
        turnId: "turn-auth",
        text: "Will fail auth",
        botId: "bot-test",
      } as SendTurnInput & { turnId: string });

      await new Promise((r) => setTimeout(r, 50));

      const runtimeError = events.find((e) => e.type === "runtime.error") as { message?: string };
      expect(runtimeError).toBeDefined();
      expect(runtimeError.message).toContain("未在浏览器中登录 Hark");
    });

    it("gives a clear descriptive error when a selector fails to match", async () => {
      const mockPage = new MockWebChatPage("https://hark.com");

      const driver = createWebChatDriver(HARK_ADAPTER, {
        pageFactory: async () => mockPage,
        sleep: async () => {},
      });

      const instance = await driver.create({
        instanceId: "hark-sel-fail",
        displayName: "Hark",
        enabled: true,
        environment: { HOME: tempDir },
        config: {},
      });

      const events: RuntimeEvent[] = [];
      instance.adapter.onEvent((ev) => events.push(ev));

      await instance.adapter.sendTurn({
        threadId: "thread-sel",
        turnId: "turn-sel",
        text: "Broken layout",
        botId: "bot-test",
      } as SendTurnInput & { turnId: string });

      await new Promise((r) => setTimeout(r, 50));

      const runtimeError = events.find((e) => e.type === "runtime.error") as { message?: string };
      expect(runtimeError).toBeDefined();
      expect(runtimeError.message).toContain("failed to match any element");
      expect(runtimeError.message).toContain("override this selector in instance config");
    });

    it("allows overriding selectors in instance configuration", async () => {
      const mockPage = new MockWebChatPage("https://hark.com");
      const customInputSelector = "#custom-chat-textarea";
      mockPage.setElement(customInputSelector, { visible: true });
      mockPage.setElement(HARK_ADAPTER.selectors.submitButton!, { visible: true });
      mockPage.setElement(HARK_ADAPTER.selectors.assistantMessage, { text: "Custom selector worked" });

      let time = 1000;
      const driver = createWebChatDriver(HARK_ADAPTER, {
        pageFactory: async () => mockPage,
        now: () => time,
        sleep: async (ms) => { time += ms; },
      });

      const instance = await driver.create({
        instanceId: "hark-custom-sel",
        displayName: "Hark",
        enabled: true,
        environment: { HOME: tempDir },
        config: {
          selectors: { input: customInputSelector },
          stabilitySec: 0.1,
        },
      });

      const events: RuntimeEvent[] = [];
      instance.adapter.onEvent((ev) => events.push(ev));

      await instance.adapter.sendTurn({
        threadId: "thread-csel",
        turnId: "turn-csel",
        text: "Using custom selector",
        botId: "bot-test",
      } as SendTurnInput & { turnId: string });

      await new Promise((r) => setTimeout(r, 60));

      expect(mockPage.fills[0]?.selector).toBe(customInputSelector);
      const itemCompleted = events.find((e) => e.type === "item.completed") as { text?: string };
      expect(itemCompleted?.text).toBe("Custom selector worked");
    });
  });

  describe("real page factory wiring (ViewerHub & BrowserService)", () => {
    let service: BrowserService;
    let backend: FakeBackend;
    let browserDir: string;

    beforeEach(() => {
      browserDir = mkdtempSync(join(tmpdir(), "omb-browser-real-factory-"));
      backend = new FakeBackend(() => new WebChatFakeChrome({ documents: () => HARK_DOC }));
      service = new BrowserService({
        dataDir: browserDir,
        backend: () => backend,
        maxRunning: 2,
        idleMs: () => 600_000,
        takeoverMs: 200,
      });
      setWorkbenchBrowserService(service);
      setWorkbenchBrowserTargetResolver((botId: string) => ({
        session: `bot-${botId}`,
        key: `bot:${botId}`,
      }));
    });

    afterEach(async () => {
      setWorkbenchBrowserService(null);
      setWorkbenchBrowserTargetResolver(null);
      await service.closeAll().catch(() => {});
      try {
        rmSync(browserDir, { recursive: true, force: true });
      } catch {}
    });

    it("wires directly to ViewerHub and creates a functioning WebChatPage", async () => {
      const target = { session: "bot-hark", key: "bot:hark" };
      const profile = service.profile(target);
      const page = await createWebChatPageFromViewerHub(profile.hub, "https://hark.com");

      expect(page.url()).toContain("https://hark.com");
      expect(await page.waitForSelector(HARK_ADAPTER.selectors.input)).toBe(true);

      await page.fill(HARK_ADAPTER.selectors.input, "Hello Hark");
      expect(await page.isVisible(HARK_ADAPTER.selectors.input)).toBe(true);
      await page.close?.();
    });

    it("runs driver turn through real ViewerHub workbench page factory without manual pageFactory", async () => {
      const target = { session: "bot-hark-auto", key: "bot:hark-auto" };
      const profile = service.profile(target);

      const userTab = await profile.hub.host.openTab(null, "person");
      await userTab.page.navigate("https://news.ycombinator.com");
      expect(userTab.page.url()).toBe("https://news.ycombinator.com");

      const driver = createWebChatDriver(HARK_ADAPTER, {
        viewerHub: profile.hub,
      });

      const instance = await driver.create({
        instanceId: "hark-auto",
        displayName: "Hark Auto",
        enabled: true,
        environment: { HOME: tempDir },
        config: { stabilitySec: 0.1, minDelayMs: 0, maxDelayMs: 0 },
      });

      const snapshot = await instance.snapshot();
      expect(snapshot.state).toBe("unknown");
      expect(snapshot.authenticated).toBe(false);

      const events: RuntimeEvent[] = [];
      instance.adapter.onEvent((e) => events.push(e));

      const turn = await instance.adapter.sendTurn({
        threadId: "thread-real-factory",
        turnId: "turn-rf-1",
        text: "Testing real factory",
        botId: "hark-auto",
      } as SendTurnInput & { turnId: string });

      expect(turn.turnId).toBe("turn-rf-1");

      for (let i = 0; i < 50; i++) {
        if (events.some((e) => e.type === "turn.completed")) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      const completed = events.find((e) => e.type === "turn.completed") as { ok?: boolean; stopReason?: string };
      expect(completed?.ok).toBe(true);
      expect(completed?.stopReason).toBe("stop");

      const itemCompleted = events.find((e) => e.type === "item.completed") as { text?: string };
      expect(itemCompleted?.text).toContain("Assistant response from real ViewerHub");

      expect(userTab.page.url()).toBe("https://news.ycombinator.com");

      await instance.dispose();
    });

    it("resolves the same ProfileState as the viewer for the same botId and keeps different botIds isolated", async () => {
      const resolver = (botId: string): BrowserTarget => ({
        session: `bot-${botId}`,
        key: `bot:${botId}`,
      });
      setWorkbenchBrowserTargetResolver(resolver);

      const targetA = resolver("bot-alpha");
      const targetB = resolver("bot-beta");

      const viewerProfileA = service.profile(targetA);
      const viewerProfileB = service.profile(targetB);

      const factory = createDefaultWorkbenchPageFactory({
        browserService: service,
        resolveBrowserTarget: resolver,
      });

      const pageA = await factory({ instanceId: "harkWeb", botId: "bot-alpha", url: "https://hark.com" });
      const pageB = await factory({ instanceId: "harkWeb", botId: "bot-beta", url: "https://hark.com" });

      expect(service.profile(targetA)).toBe(viewerProfileA);
      expect(service.profile(targetB)).toBe(viewerProfileB);
      expect(viewerProfileA).not.toBe(viewerProfileB);

      await pageA.close?.();
      await pageB.close?.();
    });

    it("fails turn explicitly with runtime.error when botId is missing without falling back to instanceId", async () => {
      const driver = createWebChatDriver(HARK_ADAPTER, {
        browserService: service,
      });
      const instance = await driver.create({
        instanceId: "harkWeb",
        displayName: "Hark",
        enabled: true,
        environment: { HOME: tempDir },
        config: {},
      });
      const events: RuntimeEvent[] = [];
      instance.adapter.onEvent((e) => events.push(e));

      await instance.adapter.sendTurn({
        threadId: "t-nobot",
        turnId: "turn-nobot-1",
        text: "hello",
      } as SendTurnInput & { turnId: string });

      const err = events.find((e) => e.type === "runtime.error") as { message?: string };
      expect(err).toBeDefined();
      expect(err.message).toContain("botId");

      const completed = events.find((e) => e.type === "turn.completed") as { ok?: boolean };
      expect(completed?.ok).toBe(false);
    });

    it("does not start any browser during snapshot when host is not awake", async () => {
      const driver = createWebChatDriver(HARK_ADAPTER, {
        browserService: service,
        resolveBrowserTarget: (botId) => ({ session: `bot-${botId}`, key: `bot:${botId}` }),
      });
      const instance = await driver.create({
        instanceId: "harkWeb",
        displayName: "Hark",
        enabled: true,
        environment: { HOME: tempDir },
        config: {},
      });

      const snapshot = await instance.snapshot();
      expect(snapshot.state).toBe("unknown");
      expect(snapshot.authenticated).toBe(false);
      expect(snapshot.reason).toContain("需在工作台浏览器查看器中打开并登录");

      const runningBrowsers = service.profiles().filter((p) => p.run !== null || p.starting !== null);
      expect(runningBrowsers).toHaveLength(0);
    });

    it("snapshot targets only this bot's profile and returns unknown if only another profile is awake", async () => {
      const otherTarget = { session: "bot-other", key: "bot:other" };
      const otherProfile = service.profile(otherTarget);
      otherProfile.hub.host.awake = () => true;

      const driver = createWebChatDriver(HARK_ADAPTER, {
        browserService: service,
        resolveBrowserTarget: (botId) => ({ session: `bot-${botId}`, key: `bot:${botId}` }),
      });
      const instance = await driver.create({
        instanceId: "harkWeb",
        displayName: "Hark",
        enabled: true,
        environment: { HOME: tempDir },
        config: {},
      });

      const snapshot = await instance.snapshot();
      expect(snapshot.state).toBe("unknown");
      expect(snapshot.authenticated).toBe(false);
      expect(snapshot.reason).toContain("需在工作台浏览器查看器中打开并登录");
    });

    it("does not throw ambiguous error when page contains multiple editable elements with one hidden", async () => {
      const docWithMultipleInputs: FakeDocument = {
        title: "Hark Chat",
        text: "Hark Chat\nWelcome",
        elements: [
          { role: "textbox", name: "Hidden Textarea", selector: "textarea", editable: true, box: [0, 0, 0, 0] },
          { role: "textbox", name: "Visible Textarea", selector: "textarea", editable: true, box: [10, 10, 400, 50] },
          { role: "button", name: "Send", selector: 'button[type="submit"]', box: [420, 10, 80, 50] },
        ],
      };
      const customBackend = new FakeBackend(() => new WebChatFakeChrome({ documents: () => docWithMultipleInputs }));
      const customDir = mkdtempSync(join(tmpdir(), "omb-multi-inputs-"));
      const customService = new BrowserService({
        dataDir: customDir,
        backend: () => customBackend,
        maxRunning: 1,
        idleMs: () => 600_000,
        takeoverMs: 200,
      });
      const target = { session: "bot-multi", key: "bot:multi" };
      const profile = customService.profile(target);
      const page = await createWebChatPageFromViewerHub(profile.hub, "https://hark.com");

      await expect(page.fill(HARK_ADAPTER.selectors.input, "test input")).resolves.not.toThrow();
      expect(await page.isVisible(HARK_ADAPTER.selectors.input)).toBe(true);

      await page.close?.();
      await customService.closeAll().catch(() => {});
      try {
        rmSync(customDir, { recursive: true, force: true });
      } catch {}
    });

    it("extracts the last assistant message and returns empty string if not matching instead of full page text", async () => {
      const docWithAssistantMessages: FakeDocument = {
        title: "Hark Chat",
        text: "Page Header\nFirst Assistant Message\nSecond Assistant Message\nFooter text",
        elements: [
          { role: "paragraph", name: "Assistant 1", selector: ".assistant-message", box: [10, 50, 400, 30], value: "First reply" },
          { role: "paragraph", name: "Assistant 2", selector: ".assistant-message", box: [10, 90, 400, 30], value: "Second reply" },
        ],
      };
      const customBackend = new FakeBackend(() => new WebChatFakeChrome({ documents: () => docWithAssistantMessages }));
      const customDir = mkdtempSync(join(tmpdir(), "omb-assistant-test-"));
      const customService = new BrowserService({
        dataDir: customDir,
        backend: () => customBackend,
        maxRunning: 1,
        idleMs: () => 600_000,
        takeoverMs: 200,
      });
      const target = { session: "bot-ast", key: "bot:ast" };
      const profile = customService.profile(target);
      const page = await createWebChatPageFromViewerHub(profile.hub, "https://hark.com");

      const lastText = await page.getText(HARK_ADAPTER.selectors.assistantMessage);
      expect(lastText).toBe("Second reply");

      await expect(page.getText(".non-existent-selector")).rejects.toThrow(/No assistant message found/);

      await page.close?.();
      await customService.closeAll().catch(() => {});
      try {
        rmSync(customDir, { recursive: true, force: true });
      } catch {}
    });

    it("connects HarkWebDriver to workbench browser service when transport is workbench and returns unknown when not awake", async () => {
      const instance = await HarkWebDriver.create({
        instanceId: "hark-default-wb",
        displayName: "Hark Default",
        enabled: true,
        environment: { HOME: tempDir },
        config: { transport: "workbench" },
      });

      const snapshot = await instance.snapshot();
      expect(snapshot.state).toBe("unknown");
      expect(snapshot.authenticated).toBe(false);
      expect(snapshot.reason).toContain("需在工作台浏览器查看器中打开并登录");
    });
  });

  describe("WebSocket protocol (push, delta, done, cancel, disconnect)", () => {
    class FakeTabSocket {
      readonly sent: string[] = [];
      closed = false;
      send(data: string): void {
        this.sent.push(data);
      }
      close(): void {
        this.closed = true;
      }
    }

    it("pushes prompt instruction to registered userscript tab with selectors and delay", async () => {
      const bridge = new WebChatUserscriptBridge();
      const fakeSocket = new FakeTabSocket();
      bridge.registerTab({
        tabId: "tab-hark-1",
        url: "https://hark.com/chat",
        title: "Hark Chat",
        ws: fakeSocket,
      });

      expect(fakeSocket.sent).toHaveLength(1);
      expect(JSON.parse(fakeSocket.sent[0])).toEqual({ type: "registered", tabId: "tab-hark-1" });

      const driver = createWebChatDriver(HARK_ADAPTER, {
        userscriptBridge: bridge,
      });

      const instance = await driver.create({
        instanceId: "hark-ws-push",
        displayName: "Hark",
        enabled: true,
        environment: { HOME: tempDir },
        config: { transport: "userscript", minDelayMs: 1200, maxDelayMs: 2500 },
      });

      const events: RuntimeEvent[] = [];
      instance.adapter.onEvent((ev) => events.push(ev));

      const turn = await instance.adapter.sendTurn({
        threadId: "th-ws-1",
        turnId: "turn-ws-1",
        text: "Generate test response",
        botId: "bot-test",
      } as SendTurnInput & { turnId: string });

      expect(turn.turnId).toBe("turn-ws-1");
      expect(fakeSocket.sent).toHaveLength(2);

      const promptMsg = JSON.parse(fakeSocket.sent[1]);
      expect(promptMsg.type).toBe("prompt");
      expect(promptMsg.turnId).toBe("turn-ws-1");
      expect(promptMsg.text).toBe("Generate test response");
      expect(promptMsg.selectors).toEqual(HARK_ADAPTER.selectors);
      expect(promptMsg.minDelayMs).toBe(1200);
      expect(promptMsg.maxDelayMs).toBe(2500);
    });

    it("handles incremental text_delta stream and done completion", async () => {
      const bridge = new WebChatUserscriptBridge();
      const fakeSocket = new FakeTabSocket();
      bridge.registerTab({
        tabId: "tab-hark-stream",
        url: "https://hark.com/chat",
        ws: fakeSocket,
      });

      const driver = createWebChatDriver(HARK_ADAPTER, { userscriptBridge: bridge });
      const instance = await driver.create({
        instanceId: "hark-ws-stream",
        displayName: "Hark",
        enabled: true,
        environment: { HOME: tempDir },
        config: { transport: "userscript" },
      });

      const events: RuntimeEvent[] = [];
      instance.adapter.onEvent((ev) => events.push(ev));

      await instance.adapter.sendTurn({
        threadId: "th-stream",
        turnId: "turn-stream-1",
        text: "Stream text",
        botId: "bot-test",
      } as SendTurnInput & { turnId: string });

      // Tab sends text deltas
      bridge.handleMessage(fakeSocket, JSON.stringify({ type: "text_delta", turnId: "turn-stream-1", text: "Hello" }));
      bridge.handleMessage(fakeSocket, JSON.stringify({ type: "text_delta", turnId: "turn-stream-1", text: "Hello world" }));

      const deltas = events.filter((e) => (e.type as string) === "item.delta") as Array<{ text?: string }>;
      expect(deltas).toHaveLength(2);
      expect(deltas[0]?.text).toBe("Hello");
      expect(deltas[1]?.text).toBe("Hello world");

      // Tab sends done
      bridge.handleMessage(fakeSocket, JSON.stringify({ type: "done", turnId: "turn-stream-1", text: "Hello world!" }));

      const itemCompleted = events.find((e) => e.type === "item.completed") as { text?: string };
      expect(itemCompleted?.text).toBe("Hello world!");

      const turnCompleted = events.find((e) => e.type === "turn.completed") as { ok?: boolean; stopReason?: string };
      expect(turnCompleted?.ok).toBe(true);
      expect(turnCompleted?.stopReason).toBe("stop");
    });

    it("sends cancel command over WebSocket and aborts turn when interrupted", async () => {
      const bridge = new WebChatUserscriptBridge();
      const fakeSocket = new FakeTabSocket();
      bridge.registerTab({
        tabId: "tab-hark-cancel",
        url: "https://hark.com/chat",
        ws: fakeSocket,
      });

      const driver = createWebChatDriver(HARK_ADAPTER, { userscriptBridge: bridge });
      const instance = await driver.create({
        instanceId: "hark-ws-cancel",
        displayName: "Hark",
        enabled: true,
        environment: { HOME: tempDir },
        config: { transport: "userscript" },
      });

      const events: RuntimeEvent[] = [];
      instance.adapter.onEvent((ev) => events.push(ev));

      await instance.adapter.sendTurn({
        threadId: "th-cancel",
        turnId: "turn-cancel-1",
        text: "Long response to cancel",
        botId: "bot-test",
      } as SendTurnInput & { turnId: string });

      // Interrupt turn
      await instance.adapter.interruptTurn("th-cancel");

      const cancelMsg = fakeSocket.sent.find((s) => s.includes('"type":"cancel"'));
      expect(cancelMsg).toBeDefined();
      expect(JSON.parse(cancelMsg!)).toEqual({ type: "cancel", turnId: "turn-cancel-1" });

      const turnCompleted = events.find((e) => e.type === "turn.completed") as { ok?: boolean; stopReason?: string };
      expect(turnCompleted?.ok).toBe(false);
      expect(turnCompleted?.stopReason).toBe("cancelled");
    });

    it("reports runtime.error and completes with error when tab disconnects unexpectedly", async () => {
      const bridge = new WebChatUserscriptBridge();
      const fakeSocket = new FakeTabSocket();
      bridge.registerTab({
        tabId: "tab-hark-disc",
        url: "https://hark.com/chat",
        ws: fakeSocket,
      });

      const driver = createWebChatDriver(HARK_ADAPTER, { userscriptBridge: bridge });
      const instance = await driver.create({
        instanceId: "hark-ws-disc",
        displayName: "Hark",
        enabled: true,
        environment: { HOME: tempDir },
        config: { transport: "userscript" },
      });

      const events: RuntimeEvent[] = [];
      instance.adapter.onEvent((ev) => events.push(ev));

      await instance.adapter.sendTurn({
        threadId: "th-disc",
        turnId: "turn-disc-1",
        text: "Disconnect test",
        botId: "bot-test",
      } as SendTurnInput & { turnId: string });

      // Tab disconnects
      bridge.removeTab("tab-hark-disc");
      expect(bridge.getTabCount()).toBe(0);

      const errEvent = events.find((e) => e.type === "runtime.error") as { message?: string };
      expect(errEvent).toBeDefined();
      expect(errEvent.message).toContain("Tab disconnected");

      const turnCompleted = events.find((e) => e.type === "turn.completed") as { ok?: boolean; stopReason?: string };
      expect(turnCompleted?.ok).toBe(false);
      expect(turnCompleted?.stopReason).toBe("error");
    });
  });

  describe("random delay range (1-3 seconds) in CDP transport", () => {
    it("enforces 1000-3000ms delay bounds during CDP native DOM typing and clicking", async () => {
      const fakeBrowser = {
        contexts: () => [
          {
            pages: () => [
              {
                url: () => "https://hark.com/chat",
                goto: async () => {},
                waitForSelector: async () => true,
                fill: async () => {},
                click: async () => {},
                evaluate: async () => "",
                isVisible: async () => true,
                textContent: async () => "Fake answer",
              },
            ],
          },
        ],
      };

      const measuredPage = await createWebChatPageFromCdpEndpoint(
        "https://hark.com",
        { minDelayMs: 15, maxDelayMs: 35 },
        { connectOverCDP: async () => fakeBrowser },
      );
      const t0 = Date.now();
      await measuredPage.fill("textarea", "hello");
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(10);
    });
  });

  describe("transport selection order and unavailable detection", () => {
    it("selects userscript (transport 1) when both userscript and CDP are available in auto mode", async () => {
      const bridge = new WebChatUserscriptBridge();
      const fakeSocket = { send: () => {}, close: () => {} };
      bridge.registerTab({ tabId: "t1", url: "https://hark.com/chat", ws: fakeSocket });

      const driver = createWebChatDriver(HARK_ADAPTER, {
        userscriptBridge: bridge,
        checkCdpAvailable: async () => true,
      });

      const instance = await driver.create({
        instanceId: "hark-auto-p1",
        displayName: "Hark",
        enabled: true,
        environment: { HOME: tempDir },
        config: {},
      });

      const snap = await instance.snapshot();
      expect(snap.state).toBe("available");
      expect(snap.reason).toContain("传输一：油猴脚本桥");
    });

    it("falls back to CDP (transport 2) when userscript has no tab but CDP is available in auto mode", async () => {
      const bridge = new WebChatUserscriptBridge();

      const driver = createWebChatDriver(HARK_ADAPTER, {
        userscriptBridge: bridge,
        checkCdpAvailable: async () => true,
      });

      const instance = await driver.create({
        instanceId: "hark-auto-p2",
        displayName: "Hark",
        enabled: true,
        environment: { HOME: tempDir },
        config: {},
      });

      const snap = await instance.snapshot();
      expect(snap.state).toBe("available");
      expect(snap.reason).toContain("传输二：CDP 接管");
    });

    it("reports unavailable in auto mode when neither userscript nor CDP is available without falling back to workbench", async () => {
      const bridge = new WebChatUserscriptBridge();

      const driver = createWebChatDriver(HARK_ADAPTER, {
        userscriptBridge: bridge,
        checkCdpAvailable: async () => false,
      });

      const instance = await driver.create({
        instanceId: "hark-auto-none",
        displayName: "Hark",
        enabled: true,
        environment: { HOME: tempDir },
        config: {},
      });

      const snap = await instance.snapshot();
      expect(snap.state).toBe("unknown");
      expect(snap.authenticated).toBe(false);
      expect(snap.reason).toContain("需在工作台浏览器查看器中打开并登录");

      const events: RuntimeEvent[] = [];
      instance.adapter.onEvent((ev) => events.push(ev));

      await instance.adapter.sendTurn({
        threadId: "th-fail",
        turnId: "turn-fail-1",
        text: "Should fail gracefully",
        botId: "bot-test",
      } as SendTurnInput & { turnId: string });

      const errEvent = events.find((e) => e.type === "runtime.error") as { message?: string };
      expect(errEvent).toBeDefined();
      expect(errEvent.message).toContain("未检测到可用的真实浏览器传输");
    });

    it("reports unavailable when explicit transport is selected but not ready", async () => {
      const bridge = new WebChatUserscriptBridge();

      const driver = createWebChatDriver(HARK_ADAPTER, {
        userscriptBridge: bridge,
        checkCdpAvailable: async () => false,
        resolveConnectOverCDP: async () => async () => ({}),
      });

      const instanceScript = await driver.create({
        instanceId: "hark-exp-script",
        displayName: "Hark",
        enabled: true,
        environment: { HOME: tempDir },
        config: { transport: "userscript" },
      });

      const snapScript = await instanceScript.snapshot();
      expect(snapScript.state).toBe("unavailable");
      expect(snapScript.reason).toContain("未检测到已连接的油猴脚本标签页");

      const instanceCdp = await driver.create({
        instanceId: "hark-exp-cdp",
        displayName: "Hark",
        enabled: true,
        environment: { HOME: tempDir },
        config: { transport: "cdp", cdpUrl: "http://127.0.0.1:9222" },
      });

      const snapCdp = await instanceCdp.snapshot();
      expect(snapCdp.state).toBe("unavailable");
      expect(snapCdp.reason).toContain("未检测到运行在 http://127.0.0.1:9222 的 Chrome");

      // 分别断言两种情况：缺 playwright-core → 安装提示；有模块但 9222 无 Chrome → 未检测到 Chrome
      const driverMissingPlaywright = createWebChatDriver(HARK_ADAPTER, {
        userscriptBridge: bridge,
        checkCdpAvailable: async () => false,
        resolveConnectOverCDP: async () => {
          throw new Error("需要安装 playwright-core");
        },
      });

      const instanceCdpMissing = await driverMissingPlaywright.create({
        instanceId: "hark-exp-cdp-missing",
        displayName: "Hark",
        enabled: true,
        environment: { HOME: tempDir },
        config: { transport: "cdp", cdpUrl: "http://127.0.0.1:9222" },
      });

      const snapCdpMissing = await instanceCdpMissing.snapshot();
      expect(snapCdpMissing.state).toBe("unavailable");
      expect(snapCdpMissing.reason).toContain("需要安装 playwright-core");
    });
  });

  describe("FIX-web-agents-d requirements", () => {
    describe("C & D: CDP Playwright connectOverCDP & Tab Lifecycle", () => {
      it("uses connectOverCDP default path and reuses only existing hark.com tabs without closing them", async () => {
        let closedTab = false;
        const mockHarkPage = {
          url: () => "https://hark.com/chat/active",
          goto: vi.fn(),
          close: vi.fn(async () => { closedTab = true; }),
          locator: vi.fn(() => ({
            first: () => ({ isVisible: async () => true, fill: vi.fn(), click: vi.fn() }),
            count: async () => 1,
            nth: () => ({ textContent: async () => "Hello from Hark" }),
          })),
          evaluate: vi.fn(),
          isVisible: vi.fn(async () => true),
        };

        const mockOtherPage = {
          url: () => "https://github.com/Johhny-Xu",
          close: vi.fn(),
        };

        const mockBrowser = {
          contexts: () => [
            {
              pages: () => [mockOtherPage, mockHarkPage],
              newPage: vi.fn(),
            },
          ],
          close: vi.fn(async () => {}),
        };

        const mockConnectOverCDP = vi.fn(async (_url: string) => mockBrowser);

        const page = await createWebChatPageFromCdpEndpoint(
          "https://hark.com",
          { cdpUrl: "http://127.0.0.1:9222", minDelayMs: 0, maxDelayMs: 0 },
          { connectOverCDP: mockConnectOverCDP },
        );

        expect(mockConnectOverCDP).toHaveBeenCalledWith("http://127.0.0.1:9222");
        expect(page.url()).toBe("https://hark.com/chat/active");
        expect(mockOtherPage.close).not.toHaveBeenCalled();

        // On close: since it reused an existing hark tab, it must NOT close it, but disconnects browser!
        await page.close?.();
        expect(mockHarkPage.close).not.toHaveBeenCalled();
        expect(closedTab).toBe(false);
        expect(mockBrowser.close).toHaveBeenCalled();
      });

      it("opens a new hark.com tab when none exists and closes only the newly opened tab on turn end", async () => {
        let newPageClosed = false;
        const mockNewPage = {
          url: () => "https://hark.com",
          goto: vi.fn(async () => {}),
          close: vi.fn(async () => { newPageClosed = true; }),
          locator: vi.fn(() => ({
            first: () => ({ isVisible: async () => true, fill: vi.fn(), click: vi.fn() }),
            count: async () => 1,
            nth: () => ({ textContent: async () => "New reply" }),
          })),
          evaluate: vi.fn(),
          isVisible: vi.fn(async () => true),
        };

        const mockUserPage = {
          url: () => "https://user-private-site.com/dashboard",
          close: vi.fn(),
        };

        const mockContext = {
          pages: () => [mockUserPage],
          newPage: vi.fn(async () => mockNewPage),
        };

        const mockBrowser = {
          contexts: () => [mockContext],
          close: vi.fn(async () => {}),
        };

        const mockConnectOverCDP = vi.fn(async () => mockBrowser);

        const page = await createWebChatPageFromCdpEndpoint(
          "https://hark.com",
          { cdpUrl: "http://127.0.0.1:9222", minDelayMs: 0, maxDelayMs: 0 },
          { connectOverCDP: mockConnectOverCDP },
        );

        expect(mockContext.newPage).toHaveBeenCalled();
        expect(mockNewPage.goto).toHaveBeenCalledWith("https://hark.com");
        expect(mockUserPage.close).not.toHaveBeenCalled();

        // On close: closes newly created tab and disconnects browser
        await page.close?.();
        expect(newPageClosed).toBe(true);
        expect(mockUserPage.close).not.toHaveBeenCalled();
        expect(mockBrowser.close).toHaveBeenCalled();
      });

      it("throws clear error when playwright-core is not installed", async () => {
        await expect(resolveConnectOverCDP({ importModule: async () => { throw new Error("not found"); } })).rejects.toThrow("需要安装 playwright-core");
      });

      it("returns unavailable when playwright-core is missing during CDP snapshot", async () => {
        const driver = createWebChatDriver(HARK_ADAPTER, {
          resolveConnectOverCDP: async () => {
            throw new Error("需要安装 playwright-core");
          },
        });
        const instance = await driver.create({
          instanceId: "hark-cdp-missing-playwright",
          displayName: "Hark",
          enabled: true,
          environment: { HOME: tempDir },
          config: { transport: "cdp" },
        });
        const snap = await instance.snapshot();
        expect(snap.state).toBe("unavailable");
        expect(snap.authenticated).toBe(false);
        expect(snap.reason).toContain("需要安装 playwright-core");
      });
    });

    describe("D: Workbench Transport Tab Behavior", () => {
      it("reuses existing hark.com tab without opening a new one or closing existing user tabs", async () => {
        const existingHarkTab = {
          id: "tab-hark-1",
          page: {
            url: () => "https://hark.com/chat/1",
            title: () => "Hark Chat",
            evaluate: async () => true,
            navigate: async () => {},
            close: async () => {},
          },
        };
        const userOtherTab = {
          id: "tab-user-2",
          page: {
            url: () => "https://mail.google.com",
            title: () => "Gmail",
            evaluate: async () => true,
            navigate: async () => {},
            close: async () => {},
          },
        };

        const mockHub = {
          host: {
            running: async () => {},
            tabs: () => [userOtherTab, existingHarkTab],
            openTab: vi.fn(async () => ({} as any)),
            closeTab: vi.fn(async () => {}),
          },
        } as unknown as ViewerHub;

        const page = await createWebChatPageFromViewerHub(mockHub, "https://hark.com");
        expect(page.url()).toBe("https://hark.com/chat/1");
        expect(mockHub.host.openTab).not.toHaveBeenCalled();

        // On close: does NOT close user's existing tab
        await page.close?.();
        expect(mockHub.host.closeTab).not.toHaveBeenCalled();
      });

      it("opens a new tab when no hark.com tab exists and closes only that new tab on finish", async () => {
        const newlyOpenedTab = {
          id: "tab-agent-new",
          page: {
            url: () => "https://hark.com",
            title: () => "Hark",
            evaluate: async () => true,
            navigate: async () => {},
            close: async () => {},
          },
        };
        const userPersonalTab = {
          id: "tab-personal",
          page: {
            url: () => "https://news.ycombinator.com",
            title: () => "HN",
            evaluate: async () => true,
            navigate: async () => {},
            close: async () => {},
          },
        };

        const mockHub = {
          host: {
            running: async () => {},
            tabs: () => [userPersonalTab],
            openTab: vi.fn(async () => newlyOpenedTab),
            closeTab: vi.fn(async () => {}),
          },
        } as unknown as ViewerHub;

        const page = await createWebChatPageFromViewerHub(mockHub, "https://hark.com");
        expect(mockHub.host.openTab).toHaveBeenCalledWith(null, "agent");

        await page.close?.();
        expect(mockHub.host.closeTab).toHaveBeenCalledWith(newlyOpenedTab);
      });
    });

    describe("-b legacy: Reply extraction & Error on missing reply", () => {
      it("throws error when assistant message is not found instead of returning whole page text", async () => {
        const mockPage = new MockWebChatPage("https://hark.com");
        await expect(
          extractLatestAssistantText(mockPage, {
            input: "textarea",
            assistantMessage: ".assistant-bubble-missing",
          })
        ).rejects.toThrow(/No assistant message found/);
      });
    });

    describe("-b legacy: Snapshot does not start browser and reports unknown with login prompt", () => {
      it("returns unknown without starting browser when no active browser session exists", async () => {
        const driver = createWebChatDriver(HARK_ADAPTER, {
          checkCdpAvailable: async () => false,
          userscriptBridge: new WebChatUserscriptBridge(),
        });

        const instance = await driver.create({
          instanceId: "hark-no-browser",
          displayName: "Hark",
          enabled: true,
          environment: { HOME: tempDir },
          config: { transport: "auto" },
        });

        const snap = await instance.snapshot();
        expect(snap.state).toBe("unknown");
        expect(snap.authenticated).toBe(false);
        expect(snap.reason).toContain("需在工作台浏览器查看器中打开并登录");
      });
    });

    describe("Random delay: default range 1000–3000ms", () => {
      it("asserts default delay is within 1000-3000ms using mock sleep / timer tracking", async () => {
        const delays: number[] = [];
        const trackingSleep = async (ms: number) => {
          delays.push(ms);
        };

        const mockPage = new MockWebChatPage("https://hark.com");
        mockPage.setElement(HARK_ADAPTER.selectors.input, { visible: true });
        mockPage.setElement(HARK_ADAPTER.selectors.submitButton!, { visible: true });
        mockPage.setElement(HARK_ADAPTER.selectors.assistantMessage, { visible: true, text: "Delayed reply" });

        const sessionStore = new WebChatSessionStore(join(tempDir, "delay-sessions.json"));

        await runWebChatTurn({
          page: mockPage,
          adapter: HARK_ADAPTER,
          // 只测默认打字延迟；稳定窗口压短，免得 Hark 默认 8s 稳定窗口拖慢用例。
          config: { stabilitySec: 0.1 },
          sessionStore,
          threadId: "th-delay",
          turnId: "turn-delay",
          prompt: "test delay",
          emit: () => {},
          sleep: trackingSleep,
        });

        expect(delays.length).toBeGreaterThanOrEqual(1);
        const typingDelay = delays[0];
        expect(typingDelay).toBeGreaterThanOrEqual(1000);
        expect(typingDelay).toBeLessThanOrEqual(3000);
      });

      it("asserts CDP transport default delay is within 1000–3000ms using timer tracking", async () => {
        let passedDelay = 0;
        const fakeBrowser = {
          contexts: () => [
            {
              pages: () => [
                {
                  url: () => "https://hark.com/chat",
                  goto: async () => {},
                  waitForSelector: async () => true,
                  fill: async () => {},
                  click: async () => {},
                  evaluate: async () => "",
                  isVisible: async () => true,
                  textContent: async () => "Fake answer",
                },
              ],
            },
          ],
        };

        const page = await createWebChatPageFromCdpEndpoint(
          "https://hark.com",
          {},
          { connectOverCDP: async () => fakeBrowser },
        );

        const realSetTimeout = globalThis.setTimeout;
        try {
          const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: any, ms?: number) => {
            if (typeof ms === "number" && ms >= 1000 && ms <= 3000) {
              passedDelay = ms;
            }
            if (typeof fn === "function") fn();
            return 0 as any;
          }) as any);

          await page.fill("textarea", "hello");
          expect(passedDelay).toBeGreaterThanOrEqual(1000);
          expect(passedDelay).toBeLessThanOrEqual(3000);
          timeoutSpy.mockRestore();
        } finally {
          globalThis.setTimeout = realSetTimeout;
        }
      });
    });
  });
});

describe("ZBOX-webchat-admin: snapshot uses botIdsForInstance real bot profiles", () => {
  let browserDir: string;
  let service: BrowserService;
  let backend: FakeBackend;

  beforeEach(() => {
    browserDir = mkdtempSync(join(tmpdir(), "omb-webchat-botids-"));
    backend = new FakeBackend(() => new WebChatFakeChrome({ documents: () => HARK_DOC }));
    service = new BrowserService({
      dataDir: browserDir,
      backend: () => backend,
      maxRunning: 2,
      idleMs: () => 600_000,
      takeoverMs: 200,
    });
  });

  afterEach(async () => {
    await service.closeAll().catch(() => {});
    try {
      rmSync(browserDir, { recursive: true, force: true });
    } catch {}
  });

  const makeInstance = async (deps: Record<string, unknown>) => {
    const driver = createWebChatDriver(HARK_ADAPTER, deps as never);
    return driver.create({
      instanceId: "harkWeb",
      displayName: "Hark",
      enabled: true,
      environment: { HOME: tmpdir() },
      config: {},
    });
  };

  it("snapshot consults botIdsForInstance real bot profiles: resolver receives the real botId, not the instanceId", async () => {
    const seen: string[] = [];
    const secondProfile = service.profile({ session: "bot-second", key: "bot:second" });
    secondProfile.hub.host.awake = () => true;

    const instance = await makeInstance({
      browserService: service,
      resolveBrowserTarget: (botId: string) => {
        seen.push(botId);
        return { session: `bot-${botId}`, key: `bot:${botId}` };
      },
      botIdsForInstance: (instanceId: string) => (instanceId === "harkWeb" ? ["bot-first", "bot-second"] : []),
    });

    const snapshot = await instance.snapshot();
    expect(snapshot).toBeDefined();
    // The real bots' ids are resolved, and the instanceId is never used as a botId while the mapping is non-empty.
    expect(seen).toContain("bot-second");
    expect(seen).not.toContain("harkWeb");
  });

  it("snapshot falls back to the instanceId behavior when botIdsForInstance returns an empty list", async () => {
    const seen: string[] = [];
    const instance = await makeInstance({
      browserService: service,
      resolveBrowserTarget: (botId: string) => {
        seen.push(botId);
        return { session: `bot-${botId}`, key: `bot:${botId}` };
      },
      botIdsForInstance: () => [],
    });

    const snapshot = await instance.snapshot();
    expect(snapshot.state).toBe("unknown");
    expect(snapshot.reason).toContain("需在工作台浏览器查看器中打开并登录");
    expect(seen).toEqual(["harkWeb"]);
  });

  it("snapshot without botIdsForInstance behaves exactly as before", async () => {
    const seen: string[] = [];
    const instance = await makeInstance({
      browserService: service,
      resolveBrowserTarget: (botId: string) => {
        seen.push(botId);
        return { session: `bot-${botId}`, key: `bot:${botId}` };
      },
    });

    const snapshot = await instance.snapshot();
    expect(snapshot.state).toBe("unknown");
    expect(snapshot.authenticated).toBe(false);
    expect(snapshot.reason).toContain("需在工作台浏览器查看器中打开并登录");
    expect(seen).toEqual(["harkWeb"]);
  });
});

describe("WEBCHAT-wire: snapshot reads botIdsForInstance from the workbench registry", () => {
  let browserDir: string;
  let service: BrowserService;
  let backend: FakeBackend;

  beforeEach(() => {
    browserDir = mkdtempSync(join(tmpdir(), "omb-webchat-wire-"));
    // No snapshot in this block may open a page: the factory only proves it.
    backend = new FakeBackend(() => {
      throw new Error("no fake Chrome should open");
    });
    service = new BrowserService({
      dataDir: browserDir,
      backend: () => backend,
      maxRunning: 2,
      idleMs: () => 600_000,
      takeoverMs: 200,
    });
  });

  afterEach(async () => {
    setWorkbenchBotIdsForInstance(null);
    await service.closeAll().catch(() => {});
    try {
      rmSync(browserDir, { recursive: true, force: true });
    } catch {}
  });

  const makeInstance = async (deps: Record<string, unknown>) => {
    const driver = createWebChatDriver(HARK_ADAPTER, deps as never);
    return driver.create({
      instanceId: "harkWeb",
      displayName: "Hark",
      enabled: true,
      environment: { HOME: tmpdir() },
      config: {},
    });
  };

  const watchingResolver = (seen: string[]) => (botId: string) => {
    seen.push(botId);
    return { session: `bot-${botId}`, key: `bot:${botId}` };
  };

  it("with only the registry set, snapshot resolves the registered real botIds and never the instanceId", async () => {
    const seen: string[] = [];
    setWorkbenchBotIdsForInstance((instanceId: string) => (instanceId === "harkWeb" ? ["wire-a", "wire-b"] : []));
    const instance = await makeInstance({
      browserService: service,
      resolveBrowserTarget: watchingResolver(seen),
    });

    const snapshot = await instance.snapshot();
    expect(snapshot).toBeDefined();
    expect(seen).toEqual(["wire-a", "wire-b"]);
  });

  it("deps.botIdsForInstance wins over the registry, which is never called", async () => {
    const seen: string[] = [];
    const registry = vi.fn(() => ["wire-a", "wire-b"]);
    setWorkbenchBotIdsForInstance(registry);
    const instance = await makeInstance({
      browserService: service,
      resolveBrowserTarget: watchingResolver(seen),
      botIdsForInstance: (instanceId: string) => (instanceId === "harkWeb" ? ["dep-only"] : []),
    });

    const snapshot = await instance.snapshot();
    expect(snapshot).toBeDefined();
    expect(seen).toEqual(["dep-only"]);
    expect(registry).not.toHaveBeenCalled();
  });

  it("after the registry is cleared, snapshot falls back to the instanceId behavior", async () => {
    const seen: string[] = [];
    setWorkbenchBotIdsForInstance(() => ["wire-a", "wire-b"]);
    setWorkbenchBotIdsForInstance(null);
    const instance = await makeInstance({
      browserService: service,
      resolveBrowserTarget: watchingResolver(seen),
    });

    const snapshot = await instance.snapshot();
    expect(snapshot.state).toBe("unknown");
    expect(snapshot.reason).toContain("需在工作台浏览器查看器中打开并登录");
    expect(seen).toEqual(["harkWeb"]);
  });

describe("workbench page factory fallback", () => {
  it("opens the first live browser profile by its own session and key when no target resolver is set", async () => {
    let opened: BrowserTarget | undefined;
    const service = {
      profiles: () => [{ session: "bot-one", key: "bot:bot-one" }],
      profile: (target: BrowserTarget) => { opened = target; throw new Error("stop-here"); },
    } as unknown as BrowserService;
    const factory = createDefaultWorkbenchPageFactory({ browserService: service });
    await expect(factory({ instanceId: "harkWeb-fallback-test", url: "https://example.com" })).rejects.toThrow("stop-here");
    expect(opened).toEqual({ session: "bot-one", key: "bot:bot-one" });
  });

  it("still names the bot when there is no profile to fall back to", async () => {
    const service = { profiles: () => [], profile: vi.fn() } as unknown as BrowserService;
    const factory = createDefaultWorkbenchPageFactory({ browserService: service });
    await expect(factory({ instanceId: "harkWeb-fallback-test", url: "https://example.com", botId: "b1" })).rejects.toThrow(/browser target for bot "b1"/);
  });
});
});

// E100: web-chat never drives an Electron app's DevTools port, and defaults to the shared browser (mychrome).
import { checkCdpAvailable as realCheckCdpAvailable } from "./cdp-transport.ts";
import { DEFAULT_WEBCHAT_CDP_URL, webChatCdpUrl } from "./core.ts";
describe("E100 web-chat CDP target", () => {
  const versionFetch = (userAgent: string) => (async () => new Response(JSON.stringify({ Browser: "Chrome/142", "User-Agent": userAgent }), { status: 200 })) as unknown as typeof fetch;
  it("accepts a real Chrome and refuses an Electron app's DevTools port", async () => {
    await expect(realCheckCdpAvailable("http://127.0.0.1:9333", 500, { fetchFn: versionFetch("Mozilla/5.0 (X11; Linux x86_64) Chrome/157.0 Safari/537.36") })).resolves.toBe(true);
    await expect(realCheckCdpAvailable("http://127.0.0.1:9222", 500, { fetchFn: versionFetch("Mozilla/5.0 TraeCN/1.107.1 Chrome/142.0 Electron/39.2.3 Safari/537.36") })).resolves.toBe(false);
    await expect(realCheckCdpAvailable("http://127.0.0.1:9333", 500, { fetchFn: (async () => new Response("", { status: 404 })) as unknown as typeof fetch })).resolves.toBe(false);
  });
  it("defaults to mychrome, and lets the instance config or OMB_WEBCHAT_CDP_URL choose another", () => {
    expect(DEFAULT_WEBCHAT_CDP_URL).toBe("http://127.0.0.1:9333");
    const saved = process.env.OMB_WEBCHAT_CDP_URL;
    delete process.env.OMB_WEBCHAT_CDP_URL;
    try {
      expect(webChatCdpUrl({}, {})).toBe("http://127.0.0.1:9333");
      expect(webChatCdpUrl({}, { OMB_WEBCHAT_CDP_URL: "http://127.0.0.1:9444" })).toBe("http://127.0.0.1:9444");
      expect(webChatCdpUrl({ cdpUrl: "http://127.0.0.1:9555" }, { OMB_WEBCHAT_CDP_URL: "http://127.0.0.1:9444" })).toBe("http://127.0.0.1:9555");
    } finally {
      if (saved === undefined) delete process.env.OMB_WEBCHAT_CDP_URL; else process.env.OMB_WEBCHAT_CDP_URL = saved;
    }
  });
});

// 2026-11-14 hark.com 真机 DOM：消息无角色属性、主聊天是连续对话、一次回复可拆多条气泡。
describe("harkWeb real hark.com DOM (2026-11-14)", () => {
  type Entry = { id: string; text: string };
  class HarkDomPage implements WebChatPage {
    entries: Entry[];
    fills: string[] = [];
    clicks: string[] = [];
    onSubmit: (page: HarkDomPage) => void = () => {};
    constructor(entries: Entry[]) {
      this.entries = entries;
    }
    url() { return "https://hark.com/chat"; }
    async navigate() {}
    async waitForSelector(selector: string) { return selector === HARK_ADAPTER.selectors.input; }
    async fill(_selector: string, text: string) { this.fills.push(text); }
    async click(selector: string) {
      this.clicks.push(selector);
      if (selector === HARK_ADAPTER.selectors.submitButton) this.onSubmit(this);
    }
    async evaluate<T = unknown>(script: string): Promise<T> {
      if (script.includes('getAttribute("data-message-id") || ""))')) return this.entries.map((e) => e.id) as T;
      return this.entries.map((e) => ({ ...e })) as T;
    }
    async isVisible(selector: string) {
      return selector === HARK_ADAPTER.selectors.input || selector === HARK_ADAPTER.selectors.submitButton;
    }
    async getText() { return this.entries.at(-1)?.text ?? ""; }
  }

  it("uses the real hark.com selectors and never clicks the dictation-state send button", () => {
    const s = HARK_ADAPTER.selectors;
    expect(s.input).toBe('textarea[data-testid="chat-input"]');
    expect(s.submitButton).toContain('button[data-testid="send-button"]');
    expect(s.submitButton).toContain(':not([aria-label*="听写"])');
    expect(s.submitButton).toContain(':not([aria-label*="ictat"])');
    expect(s.assistantMessage).toBe('[data-message-id][data-entry-kind="message"] [data-testid="message-text"]');
    expect(s.loggedInSelector).toBe('[data-testid="chat-input"]');
    // 真站上首页卡片里有手机号输入框（tel、无 name），不能被当成未登录
    expect(s.loggedOutSelector).not.toContain("input");
    expect(HARK_ADAPTER.defaultStabilitySec).toBeGreaterThanOrEqual(5);
    expect(HARK_ADAPTER.defaultTimeoutMs).toBeGreaterThanOrEqual(120_000);
  });

  it("reply = messages that appeared after the baseline, minus the prompt echo, in order", () => {
    const entries = [
      { id: "old-user", text: "我的电脑断网了" },
      { id: "old-reply", text: "先看看手机……" },
      { id: "temp-echo", text: "  回复 OK  两个字母 " },
      { id: "new-1", text: "OK" },
      { id: "new-2", text: "还要别的吗？" },
      { id: "empty-card", text: "" },
    ];
    expect(harkReplyFromEntries(entries, ["old-user", "old-reply"], "回复 OK 两个字母")).toBe("OK\n\n还要别的吗？");
    expect(harkReplyFromEntries(entries.slice(0, 3), ["old-user", "old-reply"], "回复 OK 两个字母")).toBe("");
    expect(harkReplyFromEntries([null, 3, { id: 5 }], [], "x")).toBe("");
  });

  it("captureHarkBaseline keeps only non-empty ids; extractHarkReply without a baseline returns nothing", async () => {
    const page = new HarkDomPage([{ id: "a", text: "x" }, { id: "", text: "y" }]);
    expect(await captureHarkBaseline(page)).toEqual(["a"]);
    expect(await extractHarkReply(page, { prompt: "p" })).toBe("");
    const opaque = new HarkDomPage([]);
    opaque.evaluate = (async () => true) as WebChatPage["evaluate"];
    expect(await captureHarkBaseline(opaque)).toBeUndefined();
  });

  it("a turn on the continuous chat returns only the new reply, never the previous one", async () => {
    const page = new HarkDomPage([
      { id: "u0", text: "上一轮问题" },
      { id: "r0", text: "上一轮的旧回复，绝不能当成本轮答案" },
    ]);
    let polls = 0;
    page.onSubmit = (p) => {
      p.entries.push({ id: "u1", text: "回复 OK 两个字母" });
    };
    const events: RuntimeEvent[] = [];
    let clock = 0;
    const text = await runWebChatTurn({
      page,
      adapter: HARK_ADAPTER,
      config: { minDelayMs: 0, maxDelayMs: 0, stabilitySec: 1 },
      sessionStore: new WebChatSessionStore(join(mkdtempSync(join(tmpdir(), "hark-dom-")), "s.json")),
      threadId: "th-hark-dom",
      turnId: "turn-hark-dom",
      prompt: "回复 OK 两个字母",
      emit: (e) => events.push(e),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        polls += 1;
        if (polls === 3) page.entries.push({ id: "r1", text: "OK" });
        if (polls === 5) page.entries.push({ id: "r2", text: "第二条气泡" });
      },
    });
    expect(page.fills).toEqual(["回复 OK 两个字母"]);
    expect(page.clicks).toEqual([HARK_ADAPTER.selectors.submitButton]);
    expect(text).toBe("OK\n\n第二条气泡");
    expect(text).not.toContain("旧回复");
    const completed = events.find((e) => e.type === "turn.completed") as { ok?: boolean } | undefined;
    expect(completed?.ok).toBe(true);
  });
});

// E114（2026-11-14）：已发出的提示在重试时绝不重打；hark.com 没有生成中标志，静默窗口放宽并随分段回复延长。
describe("E114 harkWeb: no duplicate send on retry, longer silence window", () => {
  type Entry = { id: string; text: string };
  class HarkPage implements WebChatPage {
    entries: Entry[] = [{ id: "old-u", text: "旧问题" }, { id: "old-r", text: "旧回复" }];
    fills: string[] = [];
    submits = 0;
    onSubmit: (p: HarkPage) => void = () => {};
    url() { return "https://hark.com/chat"; }
    async navigate() {}
    async waitForSelector(selector: string) { return selector === HARK_ADAPTER.selectors.input; }
    async fill(_s: string, text: string) { this.fills.push(text); }
    async click(selector: string) {
      if (selector === HARK_ADAPTER.selectors.submitButton) { this.submits += 1; this.onSubmit(this); }
    }
    async evaluate<T = unknown>(script: string): Promise<T> {
      if (script.includes('getAttribute("data-message-id") || ""))')) return this.entries.map((e) => e.id) as T;
      return this.entries.map((e) => ({ ...e })) as T;
    }
    async isVisible(selector: string) { return selector === HARK_ADAPTER.selectors.input || selector === HARK_ADAPTER.selectors.submitButton; }
    async getText() { return ""; }
  }

  async function drive(page: HarkPage, sleepHook: (clock: number, calls: number) => void, config: Record<string, unknown> = {}) {
    let clock = 0;
    let calls = 0;
    const driver = createWebChatDriver(HARK_ADAPTER, {
      pageFactory: async () => page,
      now: () => clock,
      sleep: async (ms) => { clock += ms; calls += 1; sleepHook(clock, calls); },
    });
    const home = mkdtempSync(join(tmpdir(), "e114-"));
    const instance = await driver.create({
      instanceId: "hark-e114",
      displayName: "Hark",
      enabled: true,
      environment: { HOME: home },
      config: { minDelayMs: 0, maxDelayMs: 0, ...config },
    });
    const events: RuntimeEvent[] = [];
    instance.adapter.onEvent((e) => events.push(e));
    await instance.adapter.sendTurn({ threadId: "t-e114", turnId: "turn-e114", text: "查一下天气", botId: "bot-e114" } as SendTurnInput & { turnId: string });
    for (let i = 0; i < 200 && !events.some((e) => e.type === "turn.completed"); i++) await new Promise((r) => setTimeout(r, 5));
    rmSync(home, { recursive: true, force: true });
    return events;
  }

  it("a reply that misses the first time window is waited for again, without sending the prompt a second time", async () => {
    const page = new HarkPage();
    let submittedAt = -1;
    page.onSubmit = (p) => { p.entries.push({ id: "u1", text: "查一下天气" }); submittedAt = 0; };
    // 第一次窗口（timeoutMs 5 s）内没有回复；重试期间回复才到。
    const events = await drive(page, (clock) => {
      if (submittedAt === 0 && clock > 8_000 && !page.entries.some((e) => e.id === "r1")) page.entries.push({ id: "r1", text: "上海今天有雨" });
    }, { timeoutMs: 5_000, stabilitySec: 1 });
    expect(page.fills).toEqual(["查一下天气"]);
    expect(page.submits).toBe(1);
    const retry = events.find((e) => e.type === "turn.retrying") as { reason?: string } | undefined;
    expect(retry?.reason).toContain("不重发");
    expect((events.find((e) => e.type === "item.completed") as { text?: string } | undefined)?.text).toBe("上海今天有雨");
    expect((events.find((e) => e.type === "turn.completed") as { ok?: boolean }).ok).toBe(true);
  });

  it("a failed click whose message already shows up is not sent again", async () => {
    const page = new HarkPage();
    page.onSubmit = (p) => { p.entries.push({ id: "u1", text: "查一下天气" }); throw new Error("click timed out"); };
    const events = await drive(page, (_c, calls) => {
      if (calls > 4 && !page.entries.some((e) => e.id === "r1")) page.entries.push({ id: "r1", text: "有雨" });
    }, { stabilitySec: 1 });
    expect(page.fills).toHaveLength(1);
    expect(page.submits).toBe(1);
    expect((events.find((e) => e.type === "item.completed") as { text?: string } | undefined)?.text).toBe("有雨");
  });

  it("a failed click with nothing new on the page is safe to type again", async () => {
    const page = new HarkPage();
    let n = 0;
    page.onSubmit = (p) => {
      n += 1;
      if (n === 1) throw new Error("click detached");
      p.entries.push({ id: "u1", text: "查一下天气" });
      p.entries.push({ id: "r1", text: "晴" });
    };
    const events = await drive(page, () => {}, { stabilitySec: 1 });
    expect(page.fills).toHaveLength(2);
    expect(page.submits).toBe(2);
    const retry = events.find((e) => e.type === "turn.retrying") as { reason?: string } | undefined;
    expect(retry?.reason).not.toContain("不重发");
    expect((events.find((e) => e.type === "item.completed") as { text?: string } | undefined)?.text).toBe("晴");
  });

  it("harkSubmittedFromEntries: echo = sent, nothing new = not sent, something unrelated = unknown", () => {
    const base = ["a", "b"];
    expect(harkSubmittedFromEntries([{ id: "a", text: "x" }, { id: "n", text: "  查一下\n天气 " }], base, "查一下 天气")).toBe(true);
    expect(harkSubmittedFromEntries([{ id: "a", text: "x" }, { id: "b", text: "y" }], base, "p")).toBe(false);
    expect(harkSubmittedFromEntries([{ id: "n", text: "别的" }], base, "p")).toBeUndefined();
    const long = "长".repeat(120);
    expect(harkSubmittedFromEntries([{ id: "n", text: long.slice(0, 90) }], base, long)).toBe(true);
  });

  it("generic probe reads the input box: empty = sent, still holding the prompt = not sent, unreadable = unknown", async () => {
    const generic = { ...HARK_ADAPTER, wasSubmitted: undefined };
    const page = (value: unknown) => ({ evaluate: async () => value }) as unknown as WebChatPage;
    const ctx = { prompt: "hello  world", baseline: undefined };
    expect(await probeWebChatSubmitted(page(""), generic, HARK_ADAPTER.selectors, ctx)).toBe(true);
    expect(await probeWebChatSubmitted(page("hello world"), generic, HARK_ADAPTER.selectors, ctx)).toBe(false);
    expect(await probeWebChatSubmitted(page(true), generic, HARK_ADAPTER.selectors, ctx)).toBeUndefined();
    const broken = { evaluate: async () => { throw new Error("target closed"); } } as unknown as WebChatPage;
    expect(await probeWebChatSubmitted(broken, generic, HARK_ADAPTER.selectors, ctx)).toBeUndefined();
    expect(new WebChatSubmittedError("x", { baseline: [], emittedText: "" }).resume.emittedText).toBe("");
  });

  it("hark waits 20 s of silence, stretching to 40 s while the reply keeps coming in pieces", async () => {
    expect(HARK_ADAPTER.defaultStabilitySec).toBe(20);
    expect(HARK_ADAPTER.maxStabilitySec).toBe(40);
    expect(webChatStabilityMs(20_000, 40_000, 1)).toBe(20_000);
    expect(webChatStabilityMs(20_000, 40_000, 2)).toBe(25_000);
    expect(webChatStabilityMs(20_000, 40_000, 9)).toBe(40_000);
    expect(webChatStabilityMs(1_500, undefined, 5)).toBe(1_500);

    // 第一段回复后 Hark 调工具静默 18 s（旧的 8 s 会在这里截断），再来第二段；之后又静默 22 s（>20 s 但 <25 s）出第三段。
    const page = new HarkPage();
    page.onSubmit = (p) => { p.entries.push({ id: "u1", text: "查一下天气" }); };
    let clock = 0;
    const text = await runWebChatTurn({
      page,
      adapter: HARK_ADAPTER,
      config: { minDelayMs: 0, maxDelayMs: 0 },
      sessionStore: new WebChatSessionStore(join(mkdtempSync(join(tmpdir(), "e114-st-")), "s.json")),
      threadId: "t",
      turnId: "turn",
      prompt: "查一下天气",
      emit: () => {},
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (clock >= 1_000 && !page.entries.some((e) => e.id === "r1")) page.entries.push({ id: "r1", text: "我查一下。" });
        if (clock >= 19_000 && !page.entries.some((e) => e.id === "r2")) page.entries.push({ id: "r2", text: "上海今天有雨" });
        if (clock >= 41_000 && !page.entries.some((e) => e.id === "r3")) page.entries.push({ id: "r3", text: "记得带伞" });
      },
    });
    expect(text).toBe("我查一下。\n\n上海今天有雨\n\n记得带伞");
  });
});
