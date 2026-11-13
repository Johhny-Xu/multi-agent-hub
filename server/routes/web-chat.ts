import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { PASS, type RouteContext, type RouteHandler } from "./table.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import type { Upgrades } from "./upgrades.ts";
import {
  getDefaultUserscriptBridge,
  WebChatUserscriptBridge,
} from "../drivers/web-chat/userscript-bridge.ts";

export interface WebChatRouteDeps {
  upgrades?: Upgrades;
  bridge?: WebChatUserscriptBridge;
  token?: () => string | null;
  sessions?: { authenticate(token: string | undefined): unknown | null };
}

export const WS_PATH = "/api/web-chat/ws";

export function isWebChatPublicWsPath(path: string): boolean {
  return path === WS_PATH;
}

export function getOrCreateWebChatBridgeToken(dataDir: string): string {
  const tokenFile = join(dataDir, "web-chat-token");
  if (existsSync(tokenFile)) {
    try {
      const existing = readFileSync(tokenFile, "utf8").trim();
      if (existing) return existing;
    } catch {}
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
  try {
    chmodSync(tokenFile, 0o600);
  } catch {}
  return token;
}

export function createWebChatRoutes(deps: WebChatRouteDeps = {}): RouteHandler {
  const bridge = deps.bridge ?? getDefaultUserscriptBridge();
  deps.upgrades?.route((path) => path === WS_PATH);

  return async ({ req, res, path, method, json, auth }: RouteContext) => {
    if (!path.startsWith("/api/web-chat") && path !== "/harkweb.user.js") {
      return PASS;
    }

    if (path === WS_PATH) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      const pending = deps.upgrades?.pending(req);
      if (!pending) return json(res, 426, { error: "WebSocket upgrade required" });

      const expectedToken = deps.token?.() ?? undefined;
      const sessionsValidator = deps.sessions
        ? (token: string) => Boolean(deps.sessions?.authenticate(token))
        : undefined;
      if (!bridge.verifyAuth(req, expectedToken, sessionsValidator)) {
        return json(res, 401, { error: "unauthorized" });
      }

      if (pending.socket.destroyed) return;
      pending.release();
      bridge.handleUpgrade(req, pending.socket, pending.head);
      res.detachSocket(pending.socket);
      return;
    }

    // Returns the userscript bridge token: admin-only under the central gate (requiredScope / ADMIN_ALLOW), and checked
    // again here so a route table that skips the gate still never hands it to a guest or a shared server's bot shell.
    // POST is the app's way in: a same-origin POST carries Origin, which a plain-HTTP LAN page's GET does not (no
    // Sec-Fetch-Site off a secure context), so a cookie session could never prove it was its own page (403 in the app).
    if ((method === "GET" || method === "POST") && path === "/api/web-chat/connection") {
      if (auth && !ownerOrAdmin(auth)) return json(res, 403, { error: "forbidden: only an admin can read the web-chat connection token" });
      const host = req.headers.host || "127.0.0.1:8801";
      const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim().toLowerCase();
      const secure = forwardedProto === "https" || Boolean((req.socket as { encrypted?: boolean } | undefined)?.encrypted);
      const token = deps.token?.() ?? "";
      return json(res, 200, {
        wsUrl: `${secure ? "wss" : "ws"}://${host}/api/web-chat/ws`,
        token,
      });
    }

    if (method === "GET" && (path === "/api/web-chat/userscript" || path === "/harkweb.user.js")) {
      const publicScript = join(process.cwd(), "public", "harkweb.user.js");
      if (existsSync(publicScript)) {
        const content = readFileSync(publicScript, "utf8");
        res.setHeader("content-type", "application/javascript; charset=utf-8");
        res.setHeader("cache-control", "no-cache");
        res.writeHead(200);
        res.end(content);
        return;
      }
      return json(res, 404, { error: "Userscript file not found" });
    }

    if (method === "GET" && path === "/api/web-chat/status") {
      const tabs = bridge.getConnectedTabs().map((t) => ({
        tabId: t.tabId,
        url: t.url,
        title: t.title,
        lastSeen: t.lastSeen,
      }));
      return json(res, 200, {
        tabCount: tabs.length,
        tabs,
      });
    }

    return PASS;
  };
}
