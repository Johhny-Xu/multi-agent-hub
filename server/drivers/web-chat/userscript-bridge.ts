import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  UserscriptClientMessage,
  UserscriptServerMessage,
  WebChatSelectors,
} from "./types.ts";

export interface ConnectedTab {
  readonly tabId: string;
  url: string;
  title?: string;
  readonly ws: {
    send(data: string): void;
    readyState?: number;
    close?(): void;
  };
  lastSeen: number;
}

export interface PromptTurnCallbacks {
  onDelta(text: string): void;
  onDone(text: string): void;
  onError(err: Error): void;
}

interface ActiveTurnRecord {
  readonly tabId: string;
  readonly callbacks: PromptTurnCallbacks;
}

export function secureTokenMatch(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isAllowedWebChatOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:") return false;
    return parsed.hostname === "hark.com" || parsed.hostname.endsWith(".hark.com");
  } catch {
    return false;
  }
}

export class WebChatUserscriptBridge {
  private readonly tabs = new Map<string, ConnectedTab>();
  private readonly activeTurns = new Map<string, ActiveTurnRecord>();
  private readonly token: string | null;
  private wss: WebSocketServer | null = null;

  constructor(token?: string | null) {
    this.token = token ?? null;
  }

  getConnectedTabs(origin?: string): ConnectedTab[] {
    const list = Array.from(this.tabs.values());
    if (!origin) return list;
    return list.filter((tab) => {
      try {
        return new URL(tab.url).origin === origin;
      } catch {
        return tab.url.includes(origin);
      }
    });
  }

  getTabCount(origin?: string): number {
    return this.getConnectedTabs(origin).length;
  }

  verifyAuth(
    reqOrToken: IncomingMessage | string,
    expectedToken?: string,
    sessionsValidator?: (token: string) => boolean,
  ): boolean {
    const validToken = expectedToken ?? this.token;
    if (typeof reqOrToken === "string") {
      if (validToken && secureTokenMatch(reqOrToken, validToken)) return true;
      if (sessionsValidator && sessionsValidator(reqOrToken)) return true;
      return false;
    }
    const req = reqOrToken;
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!isAllowedWebChatOrigin(origin)) {
      return false;
    }

    let presentedToken = "";
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      presentedToken = url.searchParams.get("token") || "";
    } catch {}

    if (!presentedToken) {
      const authHeader = req.headers["authorization"] || "";
      const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
      if (match) presentedToken = match[1];
    }

    if (!presentedToken) {
      return false;
    }

    if (validToken && secureTokenMatch(presentedToken, validToken)) return true;
    if (sessionsValidator && sessionsValidator(presentedToken)) return true;
    return false;
  }

  registerTab(tab: { tabId: string; url: string; title?: string; ws: ConnectedTab["ws"] }): void {
    const connected: ConnectedTab = {
      tabId: tab.tabId,
      url: tab.url,
      title: tab.title,
      ws: tab.ws,
      lastSeen: Date.now(),
    };
    this.tabs.set(tab.tabId, connected);
    this.send(tab.ws, { type: "registered", tabId: tab.tabId });
  }

  removeTab(tabId: string): void {
    this.tabs.delete(tabId);
    for (const [turnId, record] of this.activeTurns.entries()) {
      if (record.tabId === tabId) {
        this.activeTurns.delete(turnId);
        record.callbacks.onError(new Error("Tab disconnected while executing turn"));
      }
    }
  }

  handleMessage(ws: ConnectedTab["ws"], rawMessage: string | Buffer): void {
    let msg: UserscriptClientMessage;
    try {
      msg = JSON.parse(rawMessage.toString()) as UserscriptClientMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case "register":
        this.registerTab({
          tabId: msg.tabId,
          url: msg.url,
          title: msg.title,
          ws,
        });
        break;

      case "heartbeat": {
        const tab = this.tabs.get(msg.tabId);
        if (tab) {
          tab.lastSeen = Date.now();
        }
        break;
      }

      case "text_delta": {
        const record = this.activeTurns.get(msg.turnId);
        if (record) {
          record.callbacks.onDelta(msg.text);
        }
        break;
      }

      case "done": {
        const record = this.activeTurns.get(msg.turnId);
        if (record) {
          this.activeTurns.delete(msg.turnId);
          record.callbacks.onDone(msg.text);
        }
        break;
      }

      case "error": {
        const record = this.activeTurns.get(msg.turnId);
        if (record) {
          this.activeTurns.delete(msg.turnId);
          record.callbacks.onError(new Error(msg.error));
        }
        break;
      }
    }
  }

  async sendPrompt(
    target: {
      tabId?: string;
      origin?: string;
      turnId: string;
      text: string;
      sessionReset?: boolean;
      selectors: WebChatSelectors;
      minDelayMs?: number;
      maxDelayMs?: number;
    },
    callbacks: PromptTurnCallbacks,
  ): Promise<void> {
    let tab: ConnectedTab | undefined;
    if (target.tabId) {
      tab = this.tabs.get(target.tabId);
    } else {
      const candidates = this.getConnectedTabs(target.origin);
      tab = candidates[0];
    }

    if (!tab) {
      throw new Error("No connected userscript tab available for prompt");
    }

    this.activeTurns.set(target.turnId, { tabId: tab.tabId, callbacks });
    this.send(tab.ws, {
      type: "prompt",
      turnId: target.turnId,
      text: target.text,
      sessionReset: target.sessionReset,
      selectors: target.selectors,
      minDelayMs: target.minDelayMs ?? 1000,
      maxDelayMs: target.maxDelayMs ?? 3000,
    });
  }

  cancelTurn(turnId: string): void {
    const record = this.activeTurns.get(turnId);
    if (!record) return;
    const tab = this.tabs.get(record.tabId);
    this.activeTurns.delete(turnId);
    if (tab) {
      this.send(tab.ws, { type: "cancel", turnId });
    }
  }

  private send(ws: ConnectedTab["ws"], message: UserscriptServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {}
  }

  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    if (!this.wss) {
      this.wss = new WebSocketServer({ noServer: true });
    }
    this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      let registeredTabId: string | null = null;
      ws.on("message", (raw) => {
        try {
          const parsed = JSON.parse(raw.toString()) as UserscriptClientMessage;
          if (parsed.type === "register") {
            registeredTabId = parsed.tabId;
          }
        } catch {}
        this.handleMessage(ws, raw.toString());
      });
      ws.on("close", () => {
        if (registeredTabId) {
          this.removeTab(registeredTabId);
        } else {
          for (const [id, tab] of this.tabs.entries()) {
            if (tab.ws === ws) {
              this.removeTab(id);
              break;
            }
          }
        }
      });
      ws.on("error", () => {
        try { ws.close(); } catch {}
      });
    });
  }

  close(): void {
    for (const tab of this.tabs.values()) {
      try {
        tab.ws.close?.();
      } catch {}
    }
    this.tabs.clear();
    this.activeTurns.clear();
    if (this.wss) {
      try {
        this.wss.close();
      } catch {}
      this.wss = null;
    }
  }
}

let defaultBridge: WebChatUserscriptBridge | null = null;

export function getDefaultUserscriptBridge(): WebChatUserscriptBridge {
  if (!defaultBridge) {
    defaultBridge = new WebChatUserscriptBridge();
  }
  return defaultBridge;
}

export function setDefaultUserscriptBridge(bridge: WebChatUserscriptBridge | null): void {
  defaultBridge = bridge;
}
