// The helpers that need no proxy of their own: what a local address means on this machine, how a frame is spelled,
// and which commands change what a page looks like. Kept apart so the proxy stays about forwarding.
import { resolve, sep } from "node:path";

import type { RawData } from "ws";

/** The suffix every rewritten local address carries; the cloud browser resolves it through this proxy's Fetch domain. */
export const LOCAL_HOST_SUFFIX = "local.maus";
/** A local file or port response the cloud browser refuses to preview above this size. */
export const DEFAULT_MAX_LOCAL_BYTES = 5 * 1024 * 1024;

const TEXT_TYPES = new Set(["html", "htm", "js", "mjs", "cjs", "css", "json", "map", "svg", "txt", "md", "xml"]);
const MIME_BY_EXTENSION: Record<string, string> = {
  html: "text/html", htm: "text/html", js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript",
  css: "text/css", json: "application/json", map: "application/json", svg: "image/svg+xml", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", wasm: "application/wasm",
  txt: "text/plain", md: "text/markdown", xml: "text/xml", mp4: "video/mp4", webm: "video/webm",
  mp3: "audio/mpeg", wav: "audio/wav",
};

/** A rewritten address that names something on this machine: a file under a preview root, or a loopback port. */
export type LocalTarget = { kind: "file"; path: string } | { kind: "http"; url: string };

/** Only loopback counts as "this machine": a remote host that merely looks local is somebody else's page. */
function isLoopbackName(hostname: string): boolean {
  // A URL spells an IPv6 literal in brackets; the address inside them is what matters.
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Percent-decoding that never fails: a valid escape becomes its byte, a stray % stays a literal percent, so a path
 * such as /100%.txt survives a round trip instead of turning the whole address into nothing. */
function decodePath(pathname: string): string {
  const bytes: number[] = [];
  for (let at = 0; at < pathname.length; at++) {
    if (pathname[at] !== "%") {
      bytes.push(...Buffer.from(pathname[at], "utf8"));
      continue;
    }
    const hex = pathname.slice(at + 1, at + 3);
    if (/^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      at += 2;
    } else {
      bytes.push(0x25);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The canonical spelling of a path inside a local.maus address, so decoding it gives back exactly the same bytes. */
function encodePath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

/** file:///abs/x.html → http://file.local.maus/abs/x.html; http://localhost:5173/a?b → http://p5173.local.maus/a?b.
 * A remote address, or one that is not http, returns null: only this machine's own pages are previewed. */
export function toLocalMausUrl(url: string): string | null {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  const path = encodePath(decodePath(parsed.pathname));
  if (parsed.protocol === "file:") {
    return `http://file.${LOCAL_HOST_SUFFIX}${path}${parsed.search}`;
  }
  // https is left alone on purpose: the local replay below is plain http, so a TLS local server is not this proxy's.
  if (parsed.protocol !== "http:" || !isLoopbackName(parsed.hostname)) return null;
  return `http://p${parsed.port || "80"}.${LOCAL_HOST_SUFFIX}${path}${parsed.search}`;
}

/** The inverse of toLocalMausUrl, for the proxy's own Fetch domain: what on this machine does this address name. */
export function fromLocalMausUrl(url: string): LocalTarget | null {
  const parsed = parseUrl(url);
  if (!parsed || parsed.protocol !== "http:") return null;
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith(`.${LOCAL_HOST_SUFFIX}`)) return null;
  const label = host.slice(0, host.length - LOCAL_HOST_SUFFIX.length - 1);
  if (label === "file") {
    return { kind: "file", path: decodePath(parsed.pathname) };
  }
  const ported = /^p(\d{1,5})$/.exec(label);
  if (!ported) return null;
  const port = Number(ported[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { kind: "http", url: `http://127.0.0.1:${port}${parsed.pathname}${parsed.search}` };
}

/** Whether a path lands inside one of the roots, after both are resolved: ../ cannot climb out, and /a/bc is not in /a/b. */
export function insideRoots(path: string, roots: readonly string[]): boolean {
  const target = resolve(path);
  for (const root of roots) {
    const base = resolve(root);
    if (target === base) return true;
    if (base === sep || base.endsWith(sep)) {
      if (target.startsWith(base)) return true;
    } else if (target.startsWith(`${base}${sep}`)) return true;
  }
  return false;
}

/** The content type of a previewed file, from its extension; text carries utf-8 so a browser never guesses. */
export function mimeOf(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const mime = MIME_BY_EXTENSION[extension];
  if (!mime) return "application/octet-stream";
  return TEXT_TYPES.has(extension) ? `${mime}; charset=utf-8` : mime;
}

/** Chrome's endpoint addresses point at the cloud machine; a CLI must be sent to this proxy instead. */
export function rewriteEndpointBody(body: string, port: number): string {
  return body
    .replace(/ws:\/\/[^/"'\s\\]+\/devtools\//g, `ws://127.0.0.1:${port}/devtools/`)
    .replace(/ws=[^/"'\s\\&]+\//g, `ws=127.0.0.1:${port}/`);
}

/** The page list a Target.getTargets answer carries, in the shape a scope's filter takes it. */
export function targetInfosOf(answer: { result?: unknown }): Array<Record<string, unknown>> {
  return (((answer.result ?? {}) as { targetInfos?: unknown }).targetInfos ?? []) as Array<Record<string, unknown>>;
}

/** A frame on the wire either way: what ws hands over, plus the JSON the proxy writes itself. */
export type Frame = string | Buffer | ArrayBuffer | Buffer[];

export function toBuffer(data: RawData): Buffer {
  if (typeof data === "string") return Buffer.from(data);
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** CDP is JSON in text frames: ws hands a received text frame over as a Buffer, and sending that Buffer on would make
 * it a binary frame, which Chrome answers by dropping the connection (1006). */
export function asText(data: Frame): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return (Buffer.isBuffer(data) ? data : Buffer.from(data)).toString("utf8");
}

/** The commands whose result is a visibly different page, so a low-frequency view takes a new still after them. */
export const DIRTYING_COMMAND = /^(Input\.|Page\.navigate$|Page\.reload$|Runtime\.evaluate$|Runtime\.callFunctionOn$|DOM\.)/;
export const DIRTYING_EVENT = new Set(["Page.loadEventFired", "Page.frameNavigated"]);
