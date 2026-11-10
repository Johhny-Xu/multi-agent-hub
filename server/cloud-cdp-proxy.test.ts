// The proxy stands between a CLI on this machine and the cloud's headless Chrome, so the tests stand a fake Chrome
// where the real one would be: it records every command it is sent, answers the ones the proxy depends on, and lets a
// test push the events a real Chrome would send. Nothing here starts a browser, so the suite stays fast and offline.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { CdpProxy, DEFAULT_MAX_LOCAL_BYTES, fromLocalMausUrl, insideRoots, mimeOf, toLocalMausUrl, type CdpProxyOptions } from "./cloud-cdp-proxy.ts";
import { scopedCdpUrl } from "./cloud-cdp-scope.ts";

type Command = { method: string; sessionId?: string; params: Record<string, unknown> };

/** A Chrome that only exists to be talked to: one command log, one page list, and events a test pushes by hand. */
class FakeChrome {
  readonly #server = createServer((req, res) => this.#http(req, res));
  readonly #sockets = new Set<WebSocket>();
  readonly #wss = new WebSocketServer({ server: this.#server });
  readonly commands: Command[] = [];
  readonly raws: string[] = [];
  /** Real Chrome drops a connection that sends it a binary frame; every frame the proxy forwards must be text. */
  binaryFrames = 0;
  readonly pages: Array<Record<string, string>> = [];
  /** The pages Chrome was asked to close, which is how a departed session's tabs go away. */
  readonly closed: string[] = [];
  /** Which target each session Chrome handed out belongs to, for the questions the proxy asks about one. */
  readonly #sessions = new Map<string, string>();
  #next = 0;
  #shot = Buffer.from("frame-a", "utf8").toString("base64");

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", () => resolve()));
    this.#wss.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.on("message", (data, isBinary) => {
        if (isBinary) this.binaryFrames++;
        this.#onData(data);
      });
      socket.on("close", () => this.#sockets.delete(socket));
    });
  }

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get port(): number {
    const address = this.#server.address();
    return address && typeof address === "object" ? address.port : 0;
  }

  set shot(data: string) {
    this.#shot = Buffer.from(data, "utf8").toString("base64");
  }

  get fulfill(): Command[] {
    return this.commands.filter((command) => command.method === "Fetch.fulfillRequest");
  }

  #http(req: { url?: string; method?: string }, res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }): void {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const json = (body: unknown): void => {
      res.writeHead(200, { "content-type": "application/json; charset=UTF-8" });
      res.end(JSON.stringify(body));
    };
    if (path === "/json/version") {
      json({ Browser: "FakeChrome/1.0", "Protocol-Version": "1.3", webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/browser/BROWSER`, devtoolsFrontendUrl: `http://127.0.0.1:${this.port}/devtools/inspector.html?ws=127.0.0.1:${this.port}/devtools/page/PAGE` });
    } else if (path === "/json" || path === "/json/list") {
      json(this.pages);
    } else if (path === "/json/protocol") {
      json({ domains: [] });
    } else if (path.startsWith("/json/close/")) {
      const id = decodeURIComponent(path.slice("/json/close/".length));
      this.closed.push(id);
      const at = this.pages.findIndex((page) => page.id === id);
      if (at !== -1) this.pages.splice(at, 1);
      json({ id, result: {} });
    } else if (path === "/json/new") {
      const id = `T${++this.#next}`;
      this.pages.push(this.page(id, "about:blank"));
      json({ id, result: {} });
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  }

  page(id: string, url: string): Record<string, string> {
    return { id, type: "page", title: url, url, webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/page/${id}`, faviconUrl: "" };
  }

  #onData(data: unknown): void {
    const text = String(data);
    this.raws.push(text);
    let message: { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (!message || typeof message.method !== "string" || message.id === undefined) return;
    this.commands.push({ method: message.method, ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }), params: message.params ?? {} });
    const result = this.#answer(message.method, message.params ?? {}, message.sessionId);
    for (const socket of this.#sockets) {
      socket.send(JSON.stringify({ id: message.id, ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }), result }));
    }
  }

  /** A session Chrome attached before the proxy was told, so the proxy has to ask which target it is on. */
  adopt(sessionId: string, targetId: string): void {
    this.#sessions.set(sessionId, targetId);
  }

  #answer(method: string, params: Record<string, unknown>, sessionId?: string): unknown {
    if (method === "Target.createTarget") {
      const targetId = `T${++this.#next}`;
      const url = String(params.url ?? "about:blank");
      this.pages.push(this.page(targetId, url));
      // Real Chrome announces the page before it answers, so the proxy sees the event while it is still waiting.
      this.push(undefined, "Target.targetCreated", { targetInfo: { targetId, type: "page", title: url, url, attached: true } });
      return { targetId };
    }
    if (method === "Target.getTargets") {
      return { targetInfos: this.pages.map((page) => ({ targetId: page.id, type: "page", title: page.title, url: page.url, attached: false })) };
    }
    if (method === "Target.attachToTarget") {
      const attachSession = `S${++this.#next}`;
      this.#sessions.set(attachSession, String(params.targetId ?? ""));
      // Real Chrome announces the attach before it answers, so the proxy sees the event while it is still waiting.
      for (const socket of this.#sockets) {
        socket.send(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: attachSession, targetInfo: { targetId: String(params.targetId ?? ""), type: "page", title: "", url: "about:blank", attached: true } } }));
      }
      return { sessionId: attachSession };
    }
    if (method === "Target.getTargetInfo") return { targetInfo: { targetId: this.#sessions.get(sessionId ?? "") ?? "" } };
    if (method === "Page.captureScreenshot") return { data: this.#shot };
    if (method === "Page.getLayoutMetrics") {
      return { layoutViewport: { clientWidth: 800, clientHeight: 600 }, visualViewport: { clientWidth: 800, clientHeight: 600, pageX: 3, pageY: 4, pageScale: 1 }, contentSize: { width: 800, height: 1200 } };
    }
    return {};
  }

  /** Send an event a real Chrome would have sent, on the session a test names. */
  push(sessionId: string | undefined, method: string, params: Record<string, unknown>): void {
    for (const socket of this.#sockets) {
      socket.send(JSON.stringify({ method, ...(sessionId === undefined ? {} : { sessionId }), params }));
    }
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.close();
    this.#wss.close();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

/** A CLI's side of the proxy: one WebSocket, commands that wait for their answer, and everything it has seen. */
class Link {
  readonly #socket: WebSocket;
  readonly #waiters = new Map<number, (message: Record<string, unknown>) => void>();
  readonly seen: Array<Record<string, unknown>> = [];
  #next = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      this.seen.push(message);
      if (typeof message.id === "number" && this.#waiters.has(message.id)) {
        const resolve = this.#waiters.get(message.id) as (message: Record<string, unknown>) => void;
        this.#waiters.delete(message.id);
        resolve(message);
      }
    });
  }

  static async open(url: string): Promise<Link> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return new Link(socket);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.#next++;
    this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    return new Promise((resolve) => {
      this.#waiters.set(id, resolve);
      setTimeout(() => {
        if (this.#waiters.delete(id)) resolve({ id, error: { message: "no answer" } });
      }, 3000);
    });
  }

  sendRaw(data: Buffer): void {
    this.#socket.send(data);
  }

  get events(): Array<Record<string, unknown>> {
    return this.seen.filter((message) => typeof message.method === "string");
  }

  get commandNames(): string[] {
    return this.events.map((message) => String(message.method));
  }

  close(): void {
    this.#socket.close();
  }
}

async function waitFor(check: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Harness {
  fake: FakeChrome;
  proxy: CdpProxy;
  dir: string;
  base: string;
  shutdown: () => Promise<void>;
}

const INDEX_HTML = "<!doctype html>\n<html><head><link rel=\"stylesheet\" href=\"./style.css\"></head><body><script type=\"module\" src=\"./app.js\"></script></body></html>\n";
const APP_JS = "import { util } from \"./util.js\";\nconsole.log(util);\n";
const UTIL_JS = "export const util = 1;\n";
const STYLE_CSS = "body { color: rebeccapurple; }\n";
const FIXTURES = { "index.html": INDEX_HTML, "app.js": APP_JS, "util.js": UTIL_JS, "style.css": STYLE_CSS };

/** A fake Chrome, a proxy in front of it, and a temp folder the proxy may preview. */
async function harness(options: Partial<CdpProxyOptions> = {}, files: Record<string, string> = FIXTURES, maxBytes?: number): Promise<Harness> {
  const fake = new FakeChrome();
  await fake.start();
  const dir = mkdtempSync(join(tmpdir(), "cloud-cdp-proxy-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const proxy = new CdpProxy({
    upstream: fake.base,
    port: 0,
    host: "127.0.0.1",
    log: () => {},
    local: { roots: () => [dir], ...(maxBytes === undefined ? {} : { maxBytes }) },
    ...options,
  });
  const port = await proxy.start();
  return {
    fake, proxy, dir, base: `http://127.0.0.1:${port}`,
    shutdown: async () => {
      await proxy.close();
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const headerOf = (params: Record<string, unknown>, name: string): string | undefined =>
  ((params.responseHeaders ?? []) as Array<{ name: string; value: string }>).find((header) => header.name.toLowerCase() === name)?.value;
const bodyOf = (params: Record<string, unknown>): string => Buffer.from(String(params.body ?? ""), "base64").toString("utf8");

describe("local.maus addresses", () => {
  it("maps a local file and a local port to local.maus and back", () => {
    expect(toLocalMausUrl("file:///home/me/site/index.html")).toBe("http://file.local.maus/home/me/site/index.html");
    expect(fromLocalMausUrl("http://file.local.maus/home/me/site/index.html")).toEqual({ kind: "file", path: "/home/me/site/index.html" });
    expect(toLocalMausUrl("http://localhost:5173/a?b=1")).toBe("http://p5173.local.maus/a?b=1");
    expect(fromLocalMausUrl("http://p5173.local.maus/a?b=1")).toEqual({ kind: "http", url: "http://127.0.0.1:5173/a?b=1" });
    expect(toLocalMausUrl("http://127.0.0.1:8080/x")).toBe("http://p8080.local.maus/x");
    expect(toLocalMausUrl("http://[::1]:3000/y")).toBe("http://p3000.local.maus/y");
    expect(toLocalMausUrl("http://localhost:80/z")).toBe("http://p80.local.maus/z");
    expect(toLocalMausUrl("http://localhost:8080/a b/c?q=1 2")).toBe("http://p8080.local.maus/a%20b/c?q=1%202");
    // An http replay keeps the address encoded, because that is the form a request has to be sent in.
    expect(fromLocalMausUrl("http://p8080.local.maus/a%20b/c?q=1%202")).toEqual({ kind: "http", url: "http://127.0.0.1:8080/a%20b/c?q=1%202" });
  });

  it("keeps a file path with spaces and non-ASCII characters intact through the round trip", () => {
    const encoded = toLocalMausUrl("file:///home/me/我的站点/页面 一.html");
    expect(encoded).toBe("http://file.local.maus/home/me/%E6%88%91%E7%9A%84%E7%AB%99%E7%82%B9/%E9%A1%B5%E9%9D%A2%20%E4%B8%80.html");
    expect(fromLocalMausUrl(encoded as string)).toEqual({ kind: "file", path: "/home/me/我的站点/页面 一.html" });
    expect(toLocalMausUrl("file:///home/me/100%.txt")).toBe("http://file.local.maus/home/me/100%25.txt");
    expect(fromLocalMausUrl("http://file.local.maus/home/me/100%25.txt")).toEqual({ kind: "file", path: "/home/me/100%.txt" });
  });

  it("leaves every address that is not this machine alone", () => {
    expect(toLocalMausUrl("https://example.com/a")).toBeNull();
    expect(toLocalMausUrl("http://example.test:5173/a")).toBeNull();
    expect(toLocalMausUrl("not a url")).toBeNull();
    expect(toLocalMausUrl("ws://localhost:5173/")).toBeNull();
    expect(fromLocalMausUrl("http://example.com/a")).toBeNull();
    expect(fromLocalMausUrl("http://p99999.local.maus/a")).toBeNull();
    expect(fromLocalMausUrl("http://pabc.local.maus/a")).toBeNull();
    expect(fromLocalMausUrl("https://file.local.maus/a")).toBeNull();
  });
});

describe("insideRoots", () => {
  it("refuses a path that climbs out, a prefix that only looks like a root, and allows the root itself", () => {
    expect(insideRoots("/a/b/index.html", ["/a/b"])).toBe(true);
    expect(insideRoots("/a/b", ["/a/b"])).toBe(true);
    expect(insideRoots("/a/b/../c.html", ["/a/b"])).toBe(false);
    expect(insideRoots("/a/bc/x.html", ["/a/b"])).toBe(false);
    expect(insideRoots("/other/x.html", ["/a/b", "/other"])).toBe(true);
    expect(insideRoots("relative/x.html", ["/a/b"])).toBe(false);
    expect(insideRoots("/anything/x.html", ["/"])).toBe(true);
  });
});

describe("mimeOf", () => {
  it("names the type of a previewed file, with utf-8 on the text ones", () => {
    expect(mimeOf("/x/index.html")).toBe("text/html; charset=utf-8");
    expect(mimeOf("/x/app.js")).toBe("text/javascript; charset=utf-8");
    expect(mimeOf("/x/app.mjs")).toBe("text/javascript; charset=utf-8");
    expect(mimeOf("/x/style.css")).toBe("text/css; charset=utf-8");
    expect(mimeOf("/x/data.json")).toBe("application/json; charset=utf-8");
    expect(mimeOf("/x/map.map")).toBe("application/json; charset=utf-8");
    expect(mimeOf("/x/a.svg")).toBe("image/svg+xml; charset=utf-8");
    expect(mimeOf("/x/a.png")).toBe("image/png");
    expect(mimeOf("/x/a.jpg")).toBe("image/jpeg");
    expect(mimeOf("/x/a.webp")).toBe("image/webp");
    expect(mimeOf("/x/a.avif")).toBe("image/avif");
    expect(mimeOf("/x/a.ico")).toBe("image/x-icon");
    expect(mimeOf("/x/a.woff2")).toBe("font/woff2");
    expect(mimeOf("/x/a.ttf")).toBe("font/ttf");
    expect(mimeOf("/x/a.otf")).toBe("font/otf");
    expect(mimeOf("/x/a.wasm")).toBe("application/wasm");
    expect(mimeOf("/x/a.txt")).toBe("text/plain; charset=utf-8");
    expect(mimeOf("/x/a.md")).toBe("text/markdown; charset=utf-8");
    expect(mimeOf("/x/a.xml")).toBe("text/xml; charset=utf-8");
    expect(mimeOf("/x/a.mp4")).toBe("video/mp4");
    expect(mimeOf("/x/a.webm")).toBe("video/webm");
    expect(mimeOf("/x/a.mp3")).toBe("audio/mpeg");
    expect(mimeOf("/x/a.wav")).toBe("audio/wav");
    expect(mimeOf("/x/a.unknown")).toBe("application/octet-stream");
    expect(mimeOf("/x/noextension")).toBe("application/octet-stream");
    expect(mimeOf("/x/.hidden")).toBe("application/octet-stream");
  });
});

describe("Chrome's own endpoints", () => {
  it("rewrites the WebSocket addresses in /json/version to this proxy", async () => {
    const { fake, base, shutdown } = await harness();
    try {
      const response = await fetch(`${base}/json/version`);
      expect(response.status).toBe(200);
      const body = await response.text();
      const port = new URL(base).port;
      expect(body).toContain(`ws://127.0.0.1:${port}/devtools/browser/BROWSER`);
      expect(body).toContain(`ws=127.0.0.1:${port}/devtools/page/PAGE`);
      expect(body).not.toContain(`ws://127.0.0.1:${fake.port}/`);
      expect(body).not.toContain(`ws=127.0.0.1:${fake.port}/`);
    } finally {
      await shutdown();
    }
  });

  it("forwards every frame as text both ways, as Chrome requires", async () => {
    const { fake, base, shutdown } = await harness();
    try {
      const port = new URL(base).port;
      const client = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/BROWSER`);
      const kinds: boolean[] = [];
      client.on("message", (_data, isBinary) => kinds.push(isBinary));
      await new Promise<void>((resolve, reject) => { client.once("open", () => resolve()); client.once("error", reject); });
      client.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
      client.send(JSON.stringify({ id: 2, method: "Page.navigate", sessionId: "S1", params: { url: "https://example.com/" } }));
      await waitFor(() => fake.commands.some((command) => command.method === "Page.navigate"), "the navigation upstream");
      await waitFor(() => kinds.length >= 1, "an answer");
      expect(fake.binaryFrames).toBe(0);
      expect(kinds.every((binary) => !binary)).toBe(true);
      client.close();
    } finally {
      await shutdown();
    }
  });

  it("starts a fallback upstream before it forwards an endpoint or a WebSocket (T3)", async () => {
    let ensured = 0;
    const { base, shutdown } = await harness({ ensureUpstream: async () => { ensured++; } });
    try {
      expect((await fetch(`${base}/json/version`)).status).toBe(200);
      expect(ensured).toBe(1);
      const port = new URL(base).port;
      const client = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/BROWSER`);
      await new Promise<void>((resolve, reject) => { client.once("open", () => resolve()); client.once("error", reject); });
      expect(ensured).toBe(2);
      client.close();
    } finally {
      await shutdown();
    }
  });

  it("refuses /json/new for a local page and for a domain that needs a login", async () => {
    const { base, shutdown } = await harness({ authDomain: (url) => (url.includes("github.com") ? "github.com" : null) });
    try {
      const local = await fetch(`${base}/json/new?${new URLSearchParams({ url: "file:///home/me/index.html" })}`);
      expect(local.status).toBe(400);
      expect(await local.text()).toContain("Target.createTarget");
      const blocked = await fetch(`${base}/json/new?${new URLSearchParams({ url: "https://github.com/login" })}`);
      expect(blocked.status).toBe(403);
      expect(await blocked.text()).toContain("需要登录");
      const port = await fetch(`${base}/json/new?${new URLSearchParams({ url: "https://example.com/a" })}`);
      expect(port.status).toBe(200);
    } finally {
      await shutdown();
    }
  });
});

describe("a local file opened in the cloud browser", () => {
  it("enables interception before it forwards the rewritten navigation", async () => {
    const { fake, base, dir, shutdown } = await harness();
    try {
      const link = await Link.open(`ws://127.0.0.1:${new URL(base).port}/devtools/page/T1`);
      const answer = await link.send("Page.navigate", { url: `file://${dir}/index.html` });
      expect(answer.error).toBeUndefined();
      expect(fake.commands.map((command) => command.method)).toEqual(["Fetch.enable", "Page.navigate"]);
      expect(fake.commands[1].params.url).toBe(`http://file.local.maus${dir}/index.html`);
      expect(fake.commands[0].params).toEqual({ patterns: [{ urlPattern: "http://*.local.maus/*" }] });
      expect(fake.commands[0].sessionId).toBeUndefined();
      link.close();
    } finally {
      await shutdown();
    }
  });

  it("answers every relative file a local page asks for, with the right content type", async () => {
    const { fake, base, dir, shutdown } = await harness();
    try {
      const link = await Link.open(`ws://127.0.0.1:${new URL(base).port}/devtools/page/T1`);
      await link.send("Page.navigate", { url: `file://${dir}/index.html` });
      for (const name of ["index.html", "app.js", "util.js", "style.css"]) {
        fake.push(undefined, "Fetch.requestPaused", { requestId: `r-${name}`, request: { url: `http://file.local.maus${dir}/${name}`, method: "GET", headers: {} } });
      }
      await waitFor(() => fake.fulfill.length === 4, "four fulfilled requests");
      const [html, app, util, css] = fake.fulfill.map((command) => command.params);
      expect(bodyOf(html)).toBe(INDEX_HTML);
      expect(headerOf(html, "content-type")).toBe("text/html; charset=utf-8");
      expect(headerOf(html, "cache-control")).toBe("no-store");
      expect(headerOf(html, "access-control-allow-origin")).toBe("*");
      expect(html.responseCode).toBe(200);
      expect(bodyOf(app)).toBe(APP_JS);
      expect(headerOf(app, "content-type")).toBe("text/javascript; charset=utf-8");
      expect(bodyOf(util)).toBe(UTIL_JS);
      expect(headerOf(util, "content-type")).toBe("text/javascript; charset=utf-8");
      expect(bodyOf(css)).toBe(STYLE_CSS);
      expect(headerOf(css, "content-type")).toBe("text/css; charset=utf-8");
      link.close();
    } finally {
      await shutdown();
    }
  });

  it("refuses a path outside the preview roots", async () => {
    const { fake, base, dir, shutdown } = await harness();
    try {
      const link = await Link.open(`ws://127.0.0.1:${new URL(base).port}/devtools/page/T1`);
      await link.send("Page.navigate", { url: `file://${dir}/index.html` });
      fake.push(undefined, "Fetch.requestPaused", { requestId: "r-out", request: { url: "http://file.local.maus/etc/passwd", method: "GET", headers: {} } });
      await waitFor(() => fake.fulfill.length === 1, "the refused request");
      expect(fake.fulfill[0].params.responseCode).toBe(403);
      expect(bodyOf(fake.fulfill[0].params)).toContain("目录");
      link.close();
    } finally {
      await shutdown();
    }
  });

  it("refuses a file over the size limit, a missing file, and answers a folder with its index", async () => {
    const { fake, base, dir, shutdown } = await harness({}, { ...FIXTURES, "big.bin": "x".repeat(2000) }, 1024);
    try {
      const link = await Link.open(`ws://127.0.0.1:${new URL(base).port}/devtools/page/T1`);
      await link.send("Page.navigate", { url: `file://${dir}/index.html` });
      fake.push(undefined, "Fetch.requestPaused", { requestId: "r-big", request: { url: `http://file.local.maus${dir}/big.bin`, method: "GET", headers: {} } });
      await waitFor(() => fake.fulfill.length === 1, "the oversized request");
      expect(fake.fulfill[0].params.responseCode).toBe(413);
      fake.push(undefined, "Fetch.requestPaused", { requestId: "r-missing", request: { url: `http://file.local.maus${dir}/nope.html`, method: "GET", headers: {} } });
      await waitFor(() => fake.fulfill.length === 2, "the missing request");
      expect(fake.fulfill[1].params.responseCode).toBe(404);
      fake.push(undefined, "Fetch.requestPaused", { requestId: "r-dir", request: { url: `http://file.local.maus${dir}`, method: "GET", headers: {} } });
      await waitFor(() => fake.fulfill.length === 3, "the folder request");
      expect(fake.fulfill[2].params.responseCode).toBe(200);
      expect(bodyOf(fake.fulfill[2].params)).toBe(INDEX_HTML);
      link.close();
    } finally {
      await shutdown();
    }
  });

  it("replays a local port through fetchLocal with the original method and passes its answer on", async () => {
    const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body?: Buffer } }> = [];
    const { fake, base, shutdown } = await harness({
      fetchLocal: async (url, init) => {
        calls.push({ url, init });
        return { status: 201, headers: { "content-type": "text/plain", "x-local": "yes" }, body: Buffer.from("served locally\n", "utf8") };
      },
    });
    try {
      const link = await Link.open(`ws://127.0.0.1:${new URL(base).port}/devtools/page/T1`);
      await link.send("Page.navigate", { url: "http://localhost:5173/api/items?page=2" });
      expect(fake.commands[1].params.url).toBe("http://p5173.local.maus/api/items?page=2");
      fake.push(undefined, "Fetch.requestPaused", { requestId: "r-port", request: { url: "http://p5173.local.maus/api/items?page=2", method: "POST", headers: { host: "p5173.local.maus", "content-type": "text/plain" }, postData: Buffer.from("hello", "utf8").toString("base64") } });
      await waitFor(() => fake.fulfill.length === 1, "the replayed request");
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://127.0.0.1:5173/api/items?page=2");
      expect(calls[0].init.method).toBe("POST");
      expect(calls[0].init.headers.host).toBeUndefined();
      expect(calls[0].init.body?.toString("utf8")).toBe("hello");
      expect(fake.fulfill[0].params.responseCode).toBe(201);
      expect(headerOf(fake.fulfill[0].params, "x-local")).toBe("yes");
      expect(bodyOf(fake.fulfill[0].params)).toBe("served locally\n");
      link.close();
    } finally {
      await shutdown();
    }
  });

  it("answers 502 when the local port does not answer", async () => {
    const { fake, base, shutdown } = await harness({ fetchLocal: async () => { throw new Error("connection refused"); } });
    try {
      const link = await Link.open(`ws://127.0.0.1:${new URL(base).port}/devtools/page/T1`);
      await link.send("Page.navigate", { url: "http://127.0.0.1:9/x" });
      fake.push(undefined, "Fetch.requestPaused", { requestId: "r-down", request: { url: "http://p9.local.maus/x", method: "GET", headers: {} } });
      await waitFor(() => fake.fulfill.length === 1, "the failed request");
      expect(fake.fulfill[0].params.responseCode).toBe(502);
      link.close();
    } finally {
      await shutdown();
    }
  });
});

describe("what a CLI never sees", () => {
  it("keeps the proxy's own paused requests, attachments and answers away from the client", async () => {
    const { fake, base, dir, shutdown } = await harness();
    try {
      const link = await Link.open(`ws://127.0.0.1:${new URL(base).port}/devtools/page/T1`);
      await link.send("Page.navigate", { url: `file://${dir}/index.html` });
      fake.push(undefined, "Fetch.requestPaused", { requestId: "r-hidden", request: { url: `http://file.local.maus${dir}/app.js`, method: "GET", headers: {} } });
      fake.push(undefined, "Page.loadEventFired", { timestamp: 1 });
      fake.push(undefined, "Page.frameNavigated", { frame: { id: "F1", url: "about:blank" } });
      await waitFor(() => link.commandNames.includes("Page.loadEventFired"), "the ordinary events");
      expect(link.commandNames).toEqual(["Page.loadEventFired", "Page.frameNavigated"]);
      expect(link.seen.some((message) => typeof message.id === "number" && message.id >= 2_000_000_000)).toBe(false);
      expect(link.seen.some((message) => message.method === "Fetch.requestPaused")).toBe(false);
      link.close();
    } finally {
      await shutdown();
    }
  });

  it("opens a local page in a new tab and only then hands the target id to the client", async () => {
    const { fake, base, dir, shutdown } = await harness();
    try {
      const link = await Link.open(`ws://127.0.0.1:${new URL(base).port}/devtools/browser/B1`);
      const answer = await link.send("Target.createTarget", { url: `file://${dir}/index.html` });
      expect(answer.error).toBeUndefined();
      expect((answer.result as { targetId?: string }).targetId).toBe("T1");
      expect(fake.commands.map((command) => command.method)).toEqual(["Target.createTarget", "Target.attachToTarget", "Fetch.enable", "Page.navigate"]);
      expect(fake.commands[0].params.url).toBe("about:blank");
      expect(fake.commands[1].params).toEqual({ targetId: "T1", flatten: true });
      expect(fake.commands[2].sessionId).toMatch(/^S\d+$/);
      expect(fake.commands[3].params.url).toBe(`http://file.local.maus${dir}/index.html`);
      expect(fake.commands[3].sessionId).toBe(fake.commands[2].sessionId);
      expect(link.commandNames).not.toContain("Target.attachedToTarget");
      link.close();
    } finally {
      await shutdown();
    }
  });

  it("refuses a navigation that needs a login without sending it upstream", async () => {
    const blocked: Array<[string, string]> = [];
    const { fake, base, shutdown } = await harness({ authDomain: (url) => (url.includes("github.com") ? "github.com" : null), onAuthBlocked: (domain, url) => blocked.push([domain, url]) });
    try {
      const link = await Link.open(`ws://127.0.0.1:${new URL(base).port}/devtools/page/T1`);
      const answer = await link.send("Page.navigate", { url: "https://github.com/private" });
      expect((answer.error as { message?: string } | undefined)?.message).toContain("需要登录");
      expect((answer.error as { code?: number } | undefined)?.code).toBe(-32000);
      expect(fake.commands.map((command) => command.method)).toEqual([]);
      expect(blocked).toEqual([["github.com", "https://github.com/private"]]);
      link.close();
    } finally {
      await shutdown();
    }
  });

  it("answers a navigation the proxy refuses with the message the person configured", async () => {
    const { base, shutdown } = await harness({ authDomain: () => "private.example", authMessage: (domain) => `OpenMausBot：${domain} 需要登录，请改用 mychrome。` });
    try {
      const link = await Link.open(`ws://127.0.0.1:${new URL(base).port}/devtools/page/T1`);
      const answer = await link.send("Page.navigate", { url: "https://private.example/x" });
      expect((answer.error as { message?: string } | undefined)?.message).toBe("OpenMausBot：private.example 需要登录，请改用 mychrome。");
      link.close();
    } finally {
      await shutdown();
    }
  });
});

describe("a session the CLI attached itself", () => {
  /** A CLI that attached to a target on its own, then opened a local page on that session. */
  async function attached(fake: FakeChrome, base: string, dir: string): Promise<{ link: Link; session: string; own: string }> {
    const link = await Link.open(`ws://127.0.0.1:${new URL(base).port}/devtools/browser/B1`);
    const reply = await link.send("Target.attachToTarget", { targetId: "T1", flatten: true });
    const session = String((reply.result as { sessionId?: string }).sessionId);
    const answer = await link.send("Page.navigate", { url: `file://${dir}/index.html` }, session);
    expect(answer.error).toBeUndefined();
    const own = String(fake.commands.find((command) => command.method === "Fetch.enable")?.sessionId);
    return { link, session, own };
  }

  it("attaches to the target itself instead of enabling Fetch on the CLI's session", async () => {
    const { fake, base, dir, shutdown } = await harness();
    try {
      const { link, session, own } = await attached(fake, base, dir);
      expect(fake.commands.map((command) => command.method)).toEqual(["Target.attachToTarget", "Target.attachToTarget", "Fetch.enable", "Page.navigate"]);
      expect(fake.commands[1].params).toEqual({ targetId: "T1", flatten: true });
      expect(fake.commands[1].sessionId).toBeUndefined();
      expect(fake.commands[2].sessionId).toBe(own);
      expect(own).not.toBe(session);
      expect(fake.commands[3].sessionId).toBe(session);
      expect(fake.commands[3].params.url).toBe(`http://file.local.maus${dir}/index.html`);
      expect(fake.commands.some((command) => command.method === "Fetch.enable" && command.sessionId === session)).toBe(false);
      link.close();
    } finally {
      await shutdown();
    }
  });

  it("answers a request paused on its own session without the CLI hearing about it", async () => {
    const { fake, base, dir, shutdown } = await harness();
    try {
      const { link, own } = await attached(fake, base, dir);
      for (const name of ["index.html", "app.js", "style.css"]) {
        fake.push(own, "Fetch.requestPaused", { requestId: `r-${name}`, request: { url: `http://file.local.maus${dir}/${name}`, method: "GET", headers: {} } });
      }
      await waitFor(() => fake.fulfill.length === 3, "three fulfilled requests");
      expect(fake.fulfill.every((command) => command.sessionId === own)).toBe(true);
      const [html, app, css] = fake.fulfill.map((command) => command.params);
      expect(headerOf(html, "content-type")).toBe("text/html; charset=utf-8");
      expect(headerOf(app, "content-type")).toBe("text/javascript; charset=utf-8");
      expect(headerOf(css, "content-type")).toBe("text/css; charset=utf-8");
      // The attach event for the proxy's own session arrives before its answer, and must not leak either.
      expect(link.events.filter((message) => message.method === "Target.attachedToTarget")).toHaveLength(1);
      expect(link.seen.some((message) => message.sessionId === own)).toBe(false);
      expect(link.seen.some((message) => message.method === "Fetch.requestPaused")).toBe(false);
      link.close();
    } finally {
      await shutdown();
    }
  });

  it("answers a local request paused on the CLI's session and passes an ordinary one on", async () => {
    const { fake, base, dir, shutdown } = await harness();
    try {
      const { link, session } = await attached(fake, base, dir);
      fake.push(session, "Fetch.requestPaused", { requestId: "r-cli", request: { url: `http://file.local.maus${dir}/index.html`, method: "GET", headers: {} } });
      await waitFor(() => fake.fulfill.length === 1, "the fulfilled local request");
      expect(fake.fulfill[0].sessionId).toBe(session);
      expect(bodyOf(fake.fulfill[0].params)).toBe(INDEX_HTML);
      fake.push(session, "Fetch.requestPaused", { requestId: "r-remote", request: { url: "https://example.com/a.js", method: "GET", headers: {} } });
      await waitFor(() => link.events.some((message) => message.method === "Fetch.requestPaused"), "the ordinary request");
      const paused = link.events.find((message) => message.method === "Fetch.requestPaused") as { params: Record<string, unknown> };
      expect(paused.params.requestId).toBe("r-remote");
      expect(link.seen.some((message) => message.method === "Fetch.requestPaused" && (message.params as { requestId?: string }).requestId === "r-cli")).toBe(false);
      link.close();
    } finally {
      await shutdown();
    }
  });

  it("continues an ordinary request that paused on its own session", async () => {
    const { fake, base, dir, shutdown } = await harness();
    try {
      const { link, own } = await attached(fake, base, dir);
      fake.push(own, "Fetch.requestPaused", { requestId: "r-own-remote", request: { url: "https://example.com/x.js", method: "GET", headers: {} } });
      await waitFor(() => fake.commands.some((command) => command.method === "Fetch.continueRequest"), "the continued request");
      const continued = fake.commands.find((command) => command.method === "Fetch.continueRequest");
      expect(continued?.sessionId).toBe(own);
      expect(continued?.params.requestId).toBe("r-own-remote");
      expect(link.seen.some((message) => message.method === "Fetch.requestPaused")).toBe(false);
      link.close();
    } finally {
      await shutdown();
    }
  });

  it("attaches once per target and again after the target is destroyed", async () => {
    const { fake, base, dir, shutdown } = await harness();
    try {
      const { link, session } = await attached(fake, base, dir);
      const attaches = (): number => fake.commands.filter((command) => command.method === "Target.attachToTarget").length;
      const enables = (): number => fake.commands.filter((command) => command.method === "Fetch.enable").length;
      await link.send("Page.navigate", { url: `file://${dir}/app.js` }, session);
      expect(attaches()).toBe(2);
      expect(enables()).toBe(1);
      fake.push(undefined, "Target.targetDestroyed", { targetId: "T1" });
      await waitFor(() => link.events.some((message) => message.method === "Target.targetDestroyed"), "the destroyed target");
      await link.send("Page.navigate", { url: `file://${dir}/style.css` }, session);
      await waitFor(() => attaches() === 3, "the second attach");
      expect(enables()).toBe(2);
      expect(fake.commands.filter((command) => command.method === "Page.navigate").every((command) => command.sessionId === session)).toBe(true);
      link.close();
    } finally {
      await shutdown();
    }
  });

  it("attaches again after its own session is detached", async () => {
    const { fake, base, dir, shutdown } = await harness();
    try {
      const { link, session, own } = await attached(fake, base, dir);
      fake.push(own, "Target.detachedFromTarget", { sessionId: own, targetId: "T1" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await link.send("Page.navigate", { url: `file://${dir}/app.js` }, session);
      await waitFor(() => fake.commands.filter((command) => command.method === "Target.attachToTarget").length === 3, "the second attach");
      expect(fake.commands.filter((command) => command.method === "Fetch.enable")).toHaveLength(2);
      expect(link.seen.some((message) => message.method === "Target.detachedFromTarget")).toBe(false);
      link.close();
    } finally {
      await shutdown();
    }
  });

  it("asks which target a session is on when the attach event was missed", async () => {
    const { fake, base, dir, shutdown } = await harness();
    try {
      fake.adopt("S9", "T1");
      const link = await Link.open(`ws://127.0.0.1:${new URL(base).port}/devtools/browser/B1`);
      const answer = await link.send("Page.navigate", { url: `file://${dir}/index.html` }, "S9");
      expect(answer.error).toBeUndefined();
      expect(fake.commands.find((command) => command.method === "Target.getTargetInfo")?.sessionId).toBe("S9");
      expect(fake.commands.find((command) => command.method === "Target.attachToTarget")?.params).toEqual({ targetId: "T1", flatten: true });
      const enabled = fake.commands.find((command) => command.method === "Fetch.enable");
      expect(enabled?.sessionId).toMatch(/^S\d+$/);
      expect(enabled?.sessionId).not.toBe("S9");
      const navigate = fake.commands.find((command) => command.method === "Page.navigate");
      expect(navigate?.sessionId).toBe("S9");
      expect(navigate?.params.url).toBe(`http://file.local.maus${dir}/index.html`);
      link.close();
    } finally {
      await shutdown();
    }
  });
});

describe("the page cap", () => {
  it("queues a new page until one closes and gives up when none does", async () => {
    const { fake, base, shutdown } = await harness({ pageCap: { max: 2, queueMs: 300, countAll: true }, timing: { queuePollMs: 10 } });
    try {
      fake.pages.push(fake.page("P1", "https://a.example"), fake.page("P2", "https://b.example"));
      const port = new URL(base).port;
      const waiting = await Link.open(`ws://127.0.0.1:${port}/devtools/browser/B1`);
      const opening = waiting.send("Target.createTarget", { url: "https://c.example" });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(fake.commands.map((command) => command.method)).toEqual([]);
      fake.pages.shift();
      const answer = await opening;
      expect(answer.error).toBeUndefined();
      await waitFor(() => fake.commands.some((command) => command.method === "Target.createTarget"), "the queued page");
      const second = await waiting.send("Target.createTarget", { url: "https://d.example" });
      expect((second.error as { message?: string } | undefined)?.message).toContain("同时最多 2 个页面");
      waiting.close();
    } finally {
      await shutdown();
    }
  });

  it("counts only the pages this proxy made when the cap says so", async () => {
    const { fake, base, shutdown } = await harness({ pageCap: { max: 1, queueMs: 200, countAll: false }, timing: { queuePollMs: 10 } });
    try {
      fake.pages.push(fake.page("P1", "https://a.example"), fake.page("P2", "https://b.example"), fake.page("P3", "https://c.example"));
      const link = await Link.open(`ws://127.0.0.1:${new URL(base).port}/devtools/browser/B1`);
      const answer = await link.send("Target.createTarget", { url: "https://d.example" });
      expect(answer.error).toBeUndefined();
      link.close();
    } finally {
      await shutdown();
    }
  });
});

describe("the low-frequency live view", () => {
  it("answers a screencast with stills instead of forwarding it", async () => {
    const { fake, base, shutdown } = await harness({ lowFpsLive: true, timing: { minShotMs: 5, settleMs: 5, idleShotMs: 20 } });
    try {
      const link = await Link.open(`ws://127.0.0.1:${new URL(base).port}/devtools/page/T1`);
      const started = await link.send("Page.startScreencast", { format: "jpeg" });
      expect(started).toEqual({ id: 1, result: {} });
      await waitFor(() => link.commandNames.includes("Page.screencastFrame"), "the first frame");
      const frame = link.events.find((message) => message.method === "Page.screencastFrame") as { params: Record<string, unknown> };
      expect(frame.params.data).toBe(Buffer.from("frame-a", "utf8").toString("base64"));
      expect((frame.params.metadata as Record<string, number>).deviceWidth).toBe(800);
      expect((frame.params.metadata as Record<string, number>).deviceHeight).toBe(600);
      expect((frame.params.metadata as Record<string, number>).scrollOffsetX).toBe(3);
      expect((frame.params.metadata as Record<string, number>).scrollOffsetY).toBe(4);
      expect(typeof frame.params.sessionId).toBe("number");
      expect(fake.commands.some((command) => command.method === "Page.startScreencast")).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(link.commandNames.filter((name) => name === "Page.screencastFrame")).toHaveLength(1);
      fake.shot = "frame-b";
      await waitFor(() => link.commandNames.filter((name) => name === "Page.screencastFrame").length === 2, "a new frame after a change");
      const stopped = await link.send("Page.stopScreencast", {});
      expect(stopped).toEqual({ id: 2, result: {} });
      fake.shot = "frame-c";
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(link.commandNames.filter((name) => name === "Page.screencastFrame")).toHaveLength(2);
      expect(fake.commands.some((command) => command.method === "Page.stopScreencast")).toBe(false);
      link.close();
    } finally {
      await shutdown();
    }
  });

  it("acknowledges a frame without forwarding it and takes a still after input", async () => {
    const { fake, base, shutdown } = await harness({ lowFpsLive: true, timing: { minShotMs: 5, settleMs: 5, idleShotMs: 20 } });
    try {
      const link = await Link.open(`ws://127.0.0.1:${new URL(base).port}/devtools/browser/B1`);
      const session = "S9";
      await link.send("Page.startScreencast", { format: "png" }, session);
      const ack = await link.send("Page.screencastFrameAck", { sessionId: 1 }, session);
      expect(ack).toEqual({ id: 2, sessionId: session, result: {} });
      await waitFor(() => fake.commands.some((command) => command.method === "Page.captureScreenshot"), "the first still");
      expect(fake.commands.find((command) => command.method === "Page.captureScreenshot")?.params.format).toBe("png");
      expect(fake.commands.some((command) => command.method === "Page.screencastFrameAck")).toBe(false);
      const before = fake.commands.length;
      await link.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 2 }, session);
      await waitFor(() => fake.commands.some((command) => command.method === "Page.captureScreenshot" && fake.commands.indexOf(command) > before), "a still after input");
      expect(fake.commands.some((command) => command.method === "Input.dispatchMouseEvent")).toBe(true);
      link.close();
    } finally {
      await shutdown();
    }
  });
});

describe("a scoped connection on a shared browser", () => {
  /** One session's own connection: its name rides in the path, and the upstream is the browser itself. */
  const scoped = (base: string, scope: string): Promise<Link> => Link.open(scopedCdpUrl(base, scope));

  const pageIds = (answer: Record<string, unknown>): string[] =>
    (((answer.result as { targetInfos?: Array<{ targetId?: unknown }> }).targetInfos) ?? []).map((info) => String(info.targetId));
  const created = (link: Link): string[] => link.events.filter((m) => m.method === "Target.targetCreated").map((m) => String((m.params as { targetInfo?: { targetId?: unknown } }).targetInfo?.targetId));

  it("gives each session a page of its own and shows it nobody else's", async () => {
    const { base, shutdown } = await harness();
    try {
      const a = await scoped(base, "alpha");
      const b = await scoped(base, "beta");
      expect(pageIds(await a.send("Target.getTargets"))).toEqual(["T1"]);
      expect(created(a)).toEqual(["T1"]);
      expect(pageIds(await b.send("Target.getTargets"))).toEqual(["T2"]);
      expect(created(b)).toEqual(["T2"]);
    } finally {
      await shutdown();
    }
  });

  it("answers a session's own createTarget with its page's event first, and no other session hears it", async () => {
    const { fake, base, shutdown } = await harness();
    try {
      const a = await scoped(base, "alpha");
      const b = await scoped(base, "beta");
      const answer = await a.send("Target.createTarget", { url: "https://c.example" });
      expect((answer.result as { targetId?: string }).targetId).toBe("T1");
      expect(a.commandNames).toEqual(["Target.targetCreated"]);
      expect(created(a)).toEqual(["T1"]);
      expect(b.events.some((message) => message.method === "Target.targetCreated")).toBe(false);
      expect(fake.commands.filter((command) => command.method === "Target.createTarget")).toHaveLength(1);
      // The page opens where the CLI asked, not blank.
      expect(fake.commands.find((command) => command.method === "Target.createTarget")?.params.url).toBe("https://c.example");
    } finally {
      await shutdown();
    }
  });

  it("closes a departed session's pages after the grace and leaves the other session's alone", async () => {
    const { fake, base, proxy, shutdown } = await harness();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const a = await scoped(base, "alpha");
      const b = await scoped(base, "beta");
      expect(pageIds(await a.send("Target.getTargets"))).toEqual(["T1"]);
      expect(pageIds(await b.send("Target.getTargets"))).toEqual(["T2"]);
      a.close();
      // The grace starts when the proxy sees the socket go, which is I/O the fake clock does not drive, so the clock
      // is stepped until that connection is gone and then far enough past the grace itself.
      for (let step = 0; step < 600 && proxy.connections() > 1; step++) await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(30_000);
      vi.useRealTimers();
      await waitFor(() => fake.closed.length === 1, "the departed session's page closed");
      expect(fake.closed).toEqual(["T1"]);
    } finally {
      vi.useRealTimers();
      await shutdown();
    }
  });

  it("leaves an ordinary connection seeing every page on the browser", async () => {
    const { base, shutdown } = await harness();
    try {
      const a = await scoped(base, "alpha");
      expect(pageIds(await a.send("Target.getTargets"))).toEqual(["T1"]);
      const plain = await Link.open(`ws://127.0.0.1:${new URL(base).port}/devtools/browser/B1`);
      expect(pageIds(await plain.send("Target.getTargets"))).toEqual(["T1"]);
      expect(plain.events.some((message) => message.method === "Target.targetCreated")).toBe(false);
    } finally {
      await shutdown();
    }
  });

  it("refuses the page a full browser cannot give a new session", async () => {
    const { fake, base, shutdown } = await harness({ pageCap: { max: 1, queueMs: 10, countAll: true }, timing: { queuePollMs: 5 } });
    try {
      fake.pages.push(fake.page("P1", "https://a.example"));
      const a = await scoped(base, "alpha");
      const answer = await a.send("Target.getTargets");
      expect((answer.error as { code?: number } | undefined)?.code).toBe(-32000);
      expect((answer.error as { message?: string } | undefined)?.message).toContain("这个浏览器同时最多 1 个页面");
      expect(fake.commands.some((command) => command.method === "Target.createTarget")).toBe(false);
    } finally {
      await shutdown();
    }
  });
});

describe("transparency", () => {
  it("leaves a client's own ids and its other messages alone", async () => {
    const { fake, base, shutdown } = await harness();
    try {
      const link = await Link.open(`ws://127.0.0.1:${new URL(base).port}/devtools/page/T1`);
      const answer = await link.send("Page.navigate", { url: "https://example.com/a" });
      expect(answer.id).toBe(1);
      expect((answer.result as { frameId?: string } | undefined)).toEqual({});
      expect(fake.commands[0].method).toBe("Page.navigate");
      link.sendRaw(Buffer.from("\x00not json at all", "utf8"));
      await waitFor(() => fake.raws.some((raw) => raw.includes("not json at all")), "the binary frame");
      await link.send("Runtime.evaluate", { expression: "1+1" });
      expect(fake.commands.map((command) => command.method)).toEqual(["Page.navigate", "Runtime.evaluate"]);
      link.close();
    } finally {
      await shutdown();
    }
  });

  it("closes the client when the upstream Chrome is not there", async () => {
    const proxy = new CdpProxy({ upstream: "http://127.0.0.1:1", port: 0, host: "127.0.0.1", log: () => {} });
    const port = await proxy.start();
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/B1`);
      const closed = await new Promise<number>((resolve) => {
        socket.on("close", (code) => resolve(code));
        socket.on("error", () => resolve(1006));
      });
      expect(closed).toBe(1011);
    } finally {
      await proxy.close();
    }
  });

  it("reports its own port and connection count", async () => {
    const { base, proxy, shutdown } = await harness();
    try {
      const port = Number(new URL(base).port);
      expect(port).toBeGreaterThan(0);
      expect(proxy.url).toBe(`http://127.0.0.1:${port}`);
      expect(proxy.connections()).toBe(0);
      const link = await Link.open(`ws://127.0.0.1:${port}/devtools/page/T1`);
      await waitFor(() => proxy.connections() === 1, "the connection");
      link.close();
      await waitFor(() => proxy.connections() === 0, "the disconnect");
    } finally {
      await shutdown();
    }
  });

  it("defaults the local size limit to five megabytes", async () => {
    const { fake, base, dir, shutdown } = await harness({}, { ...FIXTURES, "big.bin": "x".repeat(DEFAULT_MAX_LOCAL_BYTES + 1) });
    try {
      const link = await Link.open(`ws://127.0.0.1:${new URL(base).port}/devtools/page/T1`);
      await link.send("Page.navigate", { url: `file://${dir}/index.html` });
      fake.push(undefined, "Fetch.requestPaused", { requestId: "r-default", request: { url: `http://file.local.maus${dir}/big.bin`, method: "GET", headers: {} } });
      await waitFor(() => fake.fulfill.length === 1, "the oversized request");
      expect(fake.fulfill[0].params.responseCode).toBe(413);
      link.close();
    } finally {
      await shutdown();
    }
  });
});
