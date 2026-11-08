import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Socket, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { createWebChatRoutes, getOrCreateWebChatBridgeToken, isWebChatPublicWsPath } from "./web-chat.ts";
import { createUpgrades } from "./upgrades.ts";
import { WebChatUserscriptBridge } from "../drivers/web-chat/userscript-bridge.ts";
import { PASS, ROUTES, dispatchRoutes } from "./table.ts";

function createMockReqRes(options: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  remoteAddress?: string;
}) {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: options.remoteAddress ?? "127.0.0.1" });

  const req = {
    url: options.url,
    method: options.method ?? "GET",
    headers: options.headers ?? {},
    socket,
  } as unknown as IncomingMessage;

  const written = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
  };

  const res = {
    setHeader(name: string, value: string) {
      written.headers[name.toLowerCase()] = value;
    },
    writeHead(code: number) {
      written.statusCode = code;
      return res;
    },
    end(chunk?: string) {
      if (chunk) written.body += chunk;
      return res;
    },
    detachSocket(_s: any) {},
  } as unknown as ServerResponse;

  const json = (r: ServerResponse, status: number, data: unknown) => {
    r.writeHead(status);
    r.setHeader("content-type", "application/json");
    r.end(JSON.stringify(data));
  };

  return { req, res, written, json };
}

describe("Web-chat server routes", () => {
  it("ignores unrelated paths and passes through", async () => {
    const route = createWebChatRoutes();
    const { req, res, json } = createMockReqRes({ url: "/api/other-route" });

    const result = await route({
      req,
      res,
      path: "/api/other-route",
      url: new URL("http://localhost/api/other-route"),
      method: "GET",
      auth: { kind: "session", session: { id: "s1", email: "test@example.com" } } as any,
      json: json as any,
      readBody: async () => ({}),
    });

    expect(result).toBe(PASS);
  });

  it("serves userscript file with application/javascript content type", async () => {
    const route = createWebChatRoutes();
    const { req, res, written, json } = createMockReqRes({ url: "/harkweb.user.js" });

    await route({
      req,
      res,
      path: "/harkweb.user.js",
      url: new URL("http://localhost/harkweb.user.js"),
      method: "GET",
      auth: { kind: "session", session: { id: "s1", email: "test@example.com" } } as any,
      json: json as any,
      readBody: async () => ({}),
    });

    expect(written.statusCode).toBe(200);
    expect(written.headers["content-type"]).toContain("application/javascript");
    expect(written.body).toContain("// ==UserScript==");
    expect(written.body).toContain("@match        https://hark.com/*");
  });

  it("returns status with connected tab information", async () => {
    const bridge = new WebChatUserscriptBridge();
    const mockWs = { send: () => {}, close: () => {} };
    bridge.registerTab({
      tabId: "tab-test-1",
      url: "https://hark.com/chat/abc",
      title: "Hark Chat",
      ws: mockWs,
    });

    const route = createWebChatRoutes({ bridge });
    const { req, res, written, json } = createMockReqRes({ url: "/api/web-chat/status" });

    await route({
      req,
      res,
      path: "/api/web-chat/status",
      url: new URL("http://localhost/api/web-chat/status"),
      method: "GET",
      auth: { kind: "session", session: { id: "s1", email: "test@example.com" } } as any,
      json: json as any,
      readBody: async () => ({}),
    });

    expect(written.statusCode).toBe(200);
    const parsed = JSON.parse(written.body);
    expect(parsed.tabCount).toBe(1);
    expect(parsed.tabs[0].tabId).toBe("tab-test-1");
    expect(parsed.tabs[0].url).toBe("https://hark.com/chat/abc");
  });

  it("requires WebSocket upgrade on /api/web-chat/ws when no upgrade pending", async () => {
    const route = createWebChatRoutes();
    const { req, res, written, json } = createMockReqRes({ url: "/api/web-chat/ws" });

    await route({
      req,
      res,
      path: "/api/web-chat/ws",
      url: new URL("http://localhost/api/web-chat/ws"),
      method: "GET",
      auth: { kind: "session", session: { id: "s1", email: "test@example.com" } } as any,
      json: json as any,
      readBody: async () => ({}),
    });

    expect(written.statusCode).toBe(426);
    const parsed = JSON.parse(written.body);
    expect(parsed.error).toContain("WebSocket upgrade required");
  });

  it("rejects unauthorized WebSocket upgrades when token does not match", async () => {
    const bridge = new WebChatUserscriptBridge("secret-token-123");
    let routedPath = "";
    const mockUpgrades = {
      route(fn: (path: string) => boolean) {
        if (fn("/api/web-chat/ws")) routedPath = "/api/web-chat/ws";
      },
      attach() {},
      pending() {
        return {
          socket: new Socket(),
          head: Buffer.alloc(0),
          release: () => {},
        };
      },
      close() {},
    };

    const route = createWebChatRoutes({
      bridge,
      upgrades: mockUpgrades as any,
      token: () => "secret-token-123",
    });

    expect(routedPath).toBe("/api/web-chat/ws");

    const { req, res, written, json } = createMockReqRes({
      url: "/api/web-chat/ws?token=wrong-token",
      headers: {},
      remoteAddress: "192.168.1.100", // LAN
    });

    await route({
      req,
      res,
      path: "/api/web-chat/ws",
      url: new URL("http://192.168.1.100/api/web-chat/ws?token=wrong-token"),
      method: "GET",
      auth: { kind: "session", session: { id: "s1", email: "test@example.com" } } as any,
      json: json as any,
      readBody: async () => ({}),
    });

    expect(written.statusCode).toBe(401);
    const parsed = JSON.parse(written.body);
    expect(parsed.error).toBe("unauthorized");
  });

  it("accepts authorized WebSocket upgrades with correct token", async () => {
    const bridge = new WebChatUserscriptBridge("secret-token-123");
    let released = false;
    let upgraded = false;
    bridge.handleUpgrade = () => { upgraded = true; };

    const mockUpgrades = {
      route() {},
      attach() {},
      pending() {
        return {
          socket: new Socket(),
          head: Buffer.alloc(0),
          release: () => { released = true; },
        };
      },
      close() {},
    };

    const route = createWebChatRoutes({
      bridge,
      upgrades: mockUpgrades as any,
      token: () => "secret-token-123",
    });

    const { req, res, written, json } = createMockReqRes({
      url: "/api/web-chat/ws?token=secret-token-123",
      remoteAddress: "192.168.1.100",
    });

    await route({
      req,
      res,
      path: "/api/web-chat/ws",
      url: new URL("http://192.168.1.100/api/web-chat/ws?token=secret-token-123"),
      method: "GET",
      auth: { kind: "session", session: { id: "s1", email: "test@example.com" } } as any,
      json: json as any,
      readBody: async () => ({}),
    });

    expect(released).toBe(true);
    expect(upgraded).toBe(true);
  });

  it("authenticates LAN WebSocket connections using OMB sessions", async () => {
    const bridge = new WebChatUserscriptBridge();
    let released = false;
    let upgraded = false;
    bridge.handleUpgrade = () => { upgraded = true; };

    const mockUpgrades = {
      route() {},
      attach() {},
      pending() {
        return {
          socket: new Socket(),
          head: Buffer.alloc(0),
          release: () => { released = true; },
        };
      },
      close() {},
    };

    const validSession = { id: "s-admin", scopes: ["admin"] };
    const mockSessions = {
      authenticate(token: string | undefined) {
        return token === "omb_sess_valid_token" ? validSession : null;
      },
    };

    const route = createWebChatRoutes({
      bridge,
      upgrades: mockUpgrades as any,
      sessions: mockSessions,
    });

    // 1. LAN request without token rejected
    const { req: reqNoToken, res: resNoToken, written: writtenNoToken, json: jsonNoToken } = createMockReqRes({
      url: "/api/web-chat/ws",
      remoteAddress: "192.168.1.105",
    });
    await route({
      req: reqNoToken,
      res: resNoToken,
      path: "/api/web-chat/ws",
      url: new URL("http://192.168.1.105/api/web-chat/ws"),
      method: "GET",
      auth: { kind: "session", session: { id: "s1" } } as any,
      json: jsonNoToken as any,
      readBody: async () => ({}),
    });
    expect(writtenNoToken.statusCode).toBe(401);

    // 2. LAN request with valid session token accepted
    const { req: reqValid, res: resValid, json: jsonValid } = createMockReqRes({
      url: "/api/web-chat/ws?token=omb_sess_valid_token",
      remoteAddress: "192.168.1.105",
    });
    await route({
      req: reqValid,
      res: resValid,
      path: "/api/web-chat/ws",
      url: new URL("http://192.168.1.105/api/web-chat/ws?token=omb_sess_valid_token"),
      method: "GET",
      auth: { kind: "session", session: { id: "s1" } } as any,
      json: jsonValid as any,
      readBody: async () => ({}),
    });
    expect(released).toBe(true);
    expect(upgraded).toBe(true);
  });

  it("real HTTP server + real ws client handshake: asserts 101 Switching Protocols and bidirectional message roundtrip", async () => {
    const bridge = new WebChatUserscriptBridge("test-secret-token");
    const upgrades = createUpgrades();
    const route = createWebChatRoutes({
      bridge,
      upgrades,
      token: () => "test-secret-token",
    });

    const handler = async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";
      const json = (r: ServerResponse, status: number, data: unknown) => {
        r.writeHead(status, { "content-type": "application/json" });
        r.end(JSON.stringify(data));
      };
      await route({
        req,
        res,
        path,
        url,
        method,
        auth: { kind: "loopback", scopes: ["admin", "client"] },
        json: json as any,
        readBody: async () => ({}),
      });
    };

    const server = createServer((req, res) => { void handler(req, res); });
    upgrades.attach(server, handler);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    let statusCode101 = 0;
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/web-chat/ws?token=test-secret-token`);

    client.on("upgrade", (res) => {
      statusCode101 = res.statusCode ?? 0;
    });

    await new Promise<void>((resolve, reject) => {
      client.on("open", resolve);
      client.on("error", reject);
    });

    expect(statusCode101).toBe(101);

    // Register tab
    client.send(JSON.stringify({
      type: "register",
      tabId: "real-tab-1",
      url: "https://hark.com/chat/123",
      title: "Hark Chat Real",
    }));

    const regMsgPromise = new Promise<any>((resolve) => {
      client.on("message", (raw) => {
        resolve(JSON.parse(raw.toString()));
      });
    });

    const regMsg = await regMsgPromise;
    expect(regMsg).toEqual({ type: "registered", tabId: "real-tab-1" });
    expect(bridge.getTabCount()).toBe(1);

    // Roundtrip messaging
    const deltas: string[] = [];
    let completedText = "";
    const turnPromise = new Promise<string>((resolve, reject) => {
      bridge.sendPrompt(
        {
          tabId: "real-tab-1",
          turnId: "turn-roundtrip-1",
          text: "What is 2+2?",
          selectors: { input: "textarea", assistantMessage: ".msg" },
        },
        {
          onDelta: (d) => deltas.push(d),
          onDone: (final) => {
            completedText = final;
            resolve(final);
          },
          onError: reject,
        },
      );
    });

    const promptMsgPromise = new Promise<any>((resolve) => {
      client.once("message", (raw) => {
        resolve(JSON.parse(raw.toString()));
      });
    });
    const promptMsg = await promptMsgPromise;
    expect(promptMsg.type).toBe("prompt");
    expect(promptMsg.turnId).toBe("turn-roundtrip-1");
    expect(promptMsg.text).toBe("What is 2+2?");

    client.send(JSON.stringify({
      type: "text_delta",
      turnId: "turn-roundtrip-1",
      text: "4",
    }));
    client.send(JSON.stringify({
      type: "done",
      turnId: "turn-roundtrip-1",
      text: "4",
    }));

    const result = await turnPromise;
    expect(result).toBe("4");
    expect(deltas).toEqual(["4"]);
    expect(completedText).toBe("4");

    client.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    upgrades.close();
    bridge.close();
  });

  it("isWebChatPublicWsPath correctly identifies public ws endpoint", () => {
    expect(isWebChatPublicWsPath("/api/web-chat/ws")).toBe(true);
    expect(isWebChatPublicWsPath("/api/web-chat/status")).toBe(false);
    expect(isWebChatPublicWsPath("/api/web-chat/connection")).toBe(false);
    expect(isWebChatPublicWsPath("/api/other")).toBe(false);
  });

  it("getOrCreateWebChatBridgeToken creates token file with 0600 mode and reuses it", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "omb-token-test-"));
    try {
      const t1 = getOrCreateWebChatBridgeToken(tempDir);
      expect(t1).toHaveLength(64);
      const tokenFile = join(tempDir, "web-chat-token");
      expect(existsSync(tokenFile)).toBe(true);
      if (process.platform !== "win32") {
        expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
      }
      const t2 = getOrCreateWebChatBridgeToken(tempDir);
      expect(t2).toBe(t1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("serves connection details on GET /api/web-chat/connection", async () => {
    const route = createWebChatRoutes({ token: () => "conn-token-abc" });
    const { req, res, written, json } = createMockReqRes({
      url: "/api/web-chat/connection",
      headers: { host: "127.0.0.1:8801" },
    });

    await route({
      req,
      res,
      path: "/api/web-chat/connection",
      url: new URL("http://127.0.0.1:8801/api/web-chat/connection"),
      method: "GET",
      auth: { kind: "session", session: { id: "s1" } } as any,
      json: json as any,
      readBody: async () => ({}),
    });

    expect(written.statusCode).toBe(200);
    const parsed = JSON.parse(written.body);
    expect(parsed.wsUrl).toBe("ws://127.0.0.1:8801/api/web-chat/ws");
    expect(parsed.token).toBe("conn-token-abc");
  });

  it("production assembly integration: real HTTP server + upgrades.attach with dispatchRoutes, validates handshake, Origin, token, and rejection cases", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "omb-bridge-token-"));
    const token = getOrCreateWebChatBridgeToken(tempDir);
    expect(token).toHaveLength(64);

    const bridge = new WebChatUserscriptBridge(token);
    const upgrades = createUpgrades();
    const webChatRoute = createWebChatRoutes({
      bridge,
      upgrades,
      token: () => token,
    });

    const routes = [...ROUTES, webChatRoute];

    const handler = async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";
      const json = (r: ServerResponse, status: number, data: unknown) => {
        r.writeHead(status, { "content-type": "application/json" });
        r.end(JSON.stringify(data));
      };

      if (isWebChatPublicWsPath(path)) {
        const publicAuth = { kind: "loopback", scopes: [] } as any;
        if (await dispatchRoutes(routes, { req, res, url, path, method, auth: publicAuth, json, readBody: async () => ({}) })) return;
      }

      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    };

    const server = createServer((req, res) => { void handler(req, res); });
    upgrades.attach(server, handler);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      let statusCode101 = 0;
      const client = new WebSocket(`ws://127.0.0.1:${port}/api/web-chat/ws?token=${token}`, {
        headers: { Origin: "https://hark.com" },
      });
      client.on("upgrade", (res) => {
        statusCode101 = res.statusCode ?? 0;
      });
      await new Promise<void>((resolve, reject) => {
        client.on("open", resolve);
        client.on("error", reject);
      });
      expect(statusCode101).toBe(101);

      client.send(JSON.stringify({
        type: "register",
        tabId: "tab-prod-1",
        url: "https://hark.com/chat/main",
        title: "Hark Main",
      }));
      const regMsg = await new Promise<any>((resolve) => {
        client.once("message", (raw) => resolve(JSON.parse(raw.toString())));
      });
      expect(regMsg).toEqual({ type: "registered", tabId: "tab-prod-1" });
      expect(bridge.getTabCount()).toBe(1);

      const turnPromise = new Promise<string>((resolve, reject) => {
        bridge.sendPrompt(
          {
            tabId: "tab-prod-1",
            turnId: "turn-prod-1",
            text: "Hello from test",
            selectors: { input: "textarea", assistantMessage: ".msg" },
          },
          {
            onDelta: () => {},
            onDone: resolve,
            onError: reject,
          },
        );
      });
      const promptMsg = await new Promise<any>((resolve) => {
        client.once("message", (raw) => resolve(JSON.parse(raw.toString())));
      });
      expect(promptMsg.type).toBe("prompt");
      expect(promptMsg.text).toBe("Hello from test");

      client.send(JSON.stringify({
        type: "done",
        turnId: "turn-prod-1",
        text: "Echo: Hello from test",
      }));
      const turnResult = await turnPromise;
      expect(turnResult).toBe("Echo: Hello from test");
      client.close();

      const assertRejected = async (urlStr: string, origin?: string) => {
        const ws = new WebSocket(urlStr, origin ? { headers: { Origin: origin } } : undefined);
        let rejected = false;
        await new Promise<void>((resolve) => {
          ws.on("error", () => {
            rejected = true;
            resolve();
          });
          ws.on("open", () => {
            ws.close();
            resolve();
          });
        });
        expect(rejected).toBe(true);
      };

      await assertRejected(`ws://127.0.0.1:${port}/api/web-chat/ws`, "https://hark.com");
      await assertRejected(`ws://127.0.0.1:${port}/api/web-chat/ws?token=wrong-token`, "https://hark.com");
      await assertRejected(`ws://127.0.0.1:${port}/api/web-chat/ws?token=${token}`, "https://evil.com");
      await assertRejected(`ws://127.0.0.1:${port}/api/web-chat/ws`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      upgrades.close();
      bridge.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
