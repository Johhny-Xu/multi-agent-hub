// Management routes and the public data-plane door for a Muse relay. The
// door rides the existing webhook receiver; it never listens on a port of its
// own and never returns a token or a private path.
import { createHash } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { FILE_MAX_BYTES, IMAGE_MAX_BYTES, saveFile, saveImageUpload } from "../attachments.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { JsonValue } from "../schema.ts";
import {
  MUSE_RELAY_INPUT_SLICE_MAX_BYTES,
  MUSE_RELAY_MAX_EVENT_BODY_BYTES,
  MUSE_RELAY_SCHEMA_VERSION,
  MuseRelayError,
  museRelayBasePath,
  museRelayDeliveryRef,
  safeConnectionId,
  type MuseRelayHub,
} from "../muse-relay.ts";
import { bearerSecret, header, json, type IngressDoor } from "../webhook-ingress.ts";
import { PASS, type RouteHandler } from "./table.ts";

const MANAGEMENT_PATH = /^\/api\/instances\/([\w.-]+)\/muse-relay(?:\/(.*))?$/;
const DOOR_PATH = /^\/hooks\/muse-relay\/v1\/([^/]+)(\/.*)$/;
const TURN_PATH = /^\/turns\/([\w-]{1,128})\/(events|files|input)$/;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const pollSchema = z.object({
  schemaVersion: z.literal(MUSE_RELAY_SCHEMA_VERSION),
  waitMs: z.number().int().min(0).max(25_000).optional(),
  limit: z.number().int().min(1).max(4).optional(),
  // "ref": each delivery carries inputBytes/inputSha256 instead of input, fetched in slices from /input. Some paths
  // to a Muse sandbox cut response bodies near 8 KB, so a client behind one asks for this. Absent means "inline".
  inputMode: z.enum(["inline", "ref"]).optional(),
}).strict();

const inputSliceSchema = z.object({
  schemaVersion: z.literal(MUSE_RELAY_SCHEMA_VERSION).optional(),
  deliveryId: z.string().min(1).max(200),
  offset: z.number().int().min(0),
  length: z.number().int().min(1).max(MUSE_RELAY_INPUT_SLICE_MAX_BYTES),
}).strict();

const heartbeatSchema = z.object({
  schemaVersion: z.literal(MUSE_RELAY_SCHEMA_VERSION),
  turnId: z.string().min(1).max(200).optional(),
  deliveryId: z.string().min(1).max(200).optional(),
}).strict();

const eventSchema = z.object({
  schemaVersion: z.literal(MUSE_RELAY_SCHEMA_VERSION),
  deliveryId: z.string().min(1).max(200),
  eventId: z.string().min(1).max(200),
  seq: z.number().int().min(1),
  type: z.enum(["delta", "text", "completed", "failed"]),
  itemId: z.string().min(1).max(200).optional(),
  text: z.string().optional(),
  stopReason: z.string().max(200).optional(),
}).strict();

export interface MuseRelayHostDeps {
  hub: MuseRelayHub;
  /** The configured driver kind, so only a museRelay instance gets this management API. */
  instanceDriver(instanceId: string): string | undefined;
  canManage(auth: RequestAuth): boolean;
}

export interface MuseRelayHost {
  routes: RouteHandler;
  door: IngressDoor;
  close(): void;
}

function dataError(res: ServerResponse, error: unknown): void {
  if (error instanceof MuseRelayError) {
    json(res, error.status, { schemaVersion: MUSE_RELAY_SCHEMA_VERSION, error: error.message });
    return;
  }
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 400 || status === 409 || status === 413) {
    const message = status === 400 ? "The file is invalid" : status === 409 ? "The file conflicts with an earlier upload" : "The file is too large";
    json(res, status, { schemaVersion: MUSE_RELAY_SCHEMA_VERSION, error: message });
    return;
  }
  console.error("muse relay: request failed", error);
  json(res, 500, { schemaVersion: MUSE_RELAY_SCHEMA_VERSION, error: "The relay could not handle this request" });
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new MuseRelayError(413, "The request body is too large");
    chunks.push(buffer);
  }
  if (!bytes) return {};
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch {
    throw new MuseRelayError(400, "The request body must be JSON");
  }
}

async function readBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new MuseRelayError(413, "The file is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

function contentLength(req: IncomingMessage): number {
  const raw = header(req, "content-length")?.trim();
  if (!raw || !/^\d+$/.test(raw)) throw new MuseRelayError(400, "Content-Length is required");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new MuseRelayError(400, "Content-Length is invalid");
  return value;
}

function fileName(url: URL): string {
  const name = url.searchParams.get("name");
  if (!name) throw new MuseRelayError(400, "name is required");
  if (name.length > 255 || name === "." || name === ".." || /[/\\\0\r\n]/.test(name)) {
    throw new MuseRelayError(400, "name is invalid");
  }
  return name;
}

function mimeOf(req: IncomingMessage): string {
  const mime = header(req, "content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!mime) throw new MuseRelayError(400, "Content-Type is required");
  return mime;
}

function rejectSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      unlinkSync(path);
      throw new MuseRelayError(400, "A file cannot be a link");
    }
  } catch (error) {
    if (error instanceof MuseRelayError) throw error;
  }
}

function authorized(hub: MuseRelayHub, connectionId: string, req: IncomingMessage): void {
  const result = hub.authorize(connectionId, bearerSecret(req));
  if (result.ok) return;
  if (result.status === 403) throw new MuseRelayError(403, "This connection was removed");
  if (result.status === 503) throw new MuseRelayError(503, "The relay is unavailable");
  throw new MuseRelayError(401, "Invalid connection token");
}

export function createMuseRelayHost(deps: MuseRelayHostDeps): MuseRelayHost {
  const { hub } = deps;
  const fileLocks = new Map<string, Promise<void>>();

  const config = (instanceId: string) => ({ config: hub.connectionViews(instanceId, true) });

  const routes: RouteHandler = async ({ res, path, method, auth, json: answer }) => {
    const match = MANAGEMENT_PATH.exec(path);
    if (!match) return PASS;
    const instanceId = match[1]!;
    if (!deps.canManage(auth)) return answer(res, 403, { error: "Only the owner or an admin can manage Muse connections." });
    if (deps.instanceDriver(instanceId) !== "museRelay") return answer(res, 404, { error: "No such Muse relay instance." });
    const rest = match[2] ?? "";
    try {
      if (!rest && method === "GET") return answer(res, 200, config(instanceId));
      if (rest === "connections" && method === "POST") {
        const created = hub.createConnection(instanceId);
        return answer(res, 200, {
          ...config(instanceId),
          credentials: { ...created, basePath: museRelayBasePath(created.connectionId) },
        });
      }
      const rotate = /^connections\/([\w-]+)\/rotate$/.exec(rest);
      if (rotate && method === "POST") {
        const connectionId = safeConnectionId(rotate[1]!);
        const rotated = hub.rotateConnection(instanceId, connectionId);
        return answer(res, 200, {
          ...config(instanceId),
          credentials: { ...rotated, basePath: museRelayBasePath(rotated.connectionId) },
        });
      }
      const removed = /^connections\/([\w-]+)$/.exec(rest);
      if (removed && method === "DELETE") {
        hub.deleteConnection(instanceId, safeConnectionId(removed[1]!));
        return answer(res, 200, config(instanceId));
      }
      return answer(res, 404, { error: "Unknown Muse relay route." });
    } catch (error) {
      if (error instanceof MuseRelayError) return answer(res, error.status, { error: error.message });
      console.error("muse relay: management request failed", error);
      return answer(res, 500, { error: "The relay could not handle this request." });
    }
  };

  const withTurnLock = async <T>(turnId: string, task: () => Promise<T>): Promise<T> => {
    const previous = fileLocks.get(turnId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.then(() => {}, () => {});
    fileLocks.set(turnId, settled);
    void settled.then(() => {
      if (fileLocks.get(turnId) === settled) fileLocks.delete(turnId);
    });
    return run;
  };

  const uploadFile = async (req: IncomingMessage, url: URL, connectionId: string, turnId: string): Promise<{ duplicate: boolean; eventId: string; seq: number }> => {
    const deliveryId = url.searchParams.get("deliveryId");
    const eventId = url.searchParams.get("eventId");
    const seqRaw = url.searchParams.get("seq");
    if (!deliveryId || !eventId || !seqRaw) throw new MuseRelayError(400, "deliveryId, eventId and seq are required");
    if (!/^\d+$/.test(seqRaw)) throw new MuseRelayError(400, "seq is invalid");
    const seq = Number(seqRaw);
    if (!Number.isSafeInteger(seq) || seq < 1) throw new MuseRelayError(400, "seq is invalid");
    if (!/^[\w.:-]{1,200}$/.test(eventId)) throw new MuseRelayError(400, "eventId is invalid");
    const name = fileName(url);
    const mime = mimeOf(req);
    const kind = IMAGE_MIMES.has(mime) ? "image" : "file";
    const limit = kind === "image" ? IMAGE_MAX_BYTES : FILE_MAX_BYTES;
    const length = contentLength(req);
    if (length > limit) throw new MuseRelayError(413, kind === "image" ? "The image is too large" : "The file is too large");

    return withTurnLock(turnId, async () => {
      const { uploadId } = hub.beginFile(connectionId, turnId, { deliveryId, eventId, seq });
      const hash = createHash("sha256");
      let saved: { path: string; name: string; mime: string; bytes: number };
      if (kind === "image") {
        const bytes = await readBytes(req, limit);
        if (bytes.byteLength !== length) throw new MuseRelayError(400, "Content-Length did not match the image");
        hash.update(bytes);
        const image = await saveImageUpload(bytes, mime, uploadId);
        saved = { path: image.path, name, mime: image.mime, bytes: image.bytes };
      } else {
        let bytes = 0;
        const leaseDeliveryId: string = deliveryId;
        async function* chunks() {
          for await (const chunk of req) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > limit) throw new MuseRelayError(413, "The file is too large");
            hash.update(buffer);
            // Reads are the upload's proof of life: a body slower than the lease must not be redelivered.
            hub.acknowledgeFileUpload(connectionId, turnId, leaseDeliveryId, uploadId);
            yield buffer;
          }
        }
        const file = await saveFile(chunks(), name, mime, { uploadId, expectedBytes: length });
        if (bytes !== length) {
          unlinkSync(file.path);
          throw new MuseRelayError(400, "Content-Length did not match the file");
        }
        saved = file;
      }
      rejectSymlink(saved.path);
      const result = hub.recordFile(connectionId, turnId, {
        deliveryId,
        eventId,
        seq,
        kind,
        path: saved.path,
        mime: saved.mime,
        name: saved.name,
        bytes: saved.bytes,
        hash: hash.digest("hex"),
      });
      return { duplicate: result.duplicate, eventId: result.eventId, seq: result.seq };
    });
  };

  const door: IngressDoor = async (req, res, url) => {
    const match = DOOR_PATH.exec(url.pathname);
    if (!match) return false;
    try {
      const connectionId = safeConnectionId(match[1]!);
      const rest = match[2]!;
      if (req.method !== "POST") {
        json(res, 405, { schemaVersion: MUSE_RELAY_SCHEMA_VERSION, error: "Muse relay endpoints take POST" });
        return true;
      }
      authorized(hub, connectionId, req);
      if (rest === "/poll") {
        const body = pollSchema.safeParse(await readJson(req, 16 * 1024));
        if (!body.success) throw new MuseRelayError(400, "The poll body is invalid");
        // Node fires res "close" without writableEnded when the client (or Cloudflare) hung up first.
        const gone = new AbortController();
        res.once("close", () => {
          if (!res.writableEnded) gone.abort();
        });
        const refMode = body.data.inputMode === "ref";
        const result = await hub.poll(connectionId, body.data.waitMs ?? 0, body.data.limit ?? 1, { signal: gone.signal, refMode });
        if (gone.signal.aborted || res.destroyed) {
          hub.releaseClaims(connectionId, result.deliveries.map((delivery) => delivery.deliveryId));
          return true;
        }
        // A rotation during the wait must invalidate the answer before it leaves the server.
        authorized(hub, connectionId, req);
        json(res, 200, {
          schemaVersion: MUSE_RELAY_SCHEMA_VERSION,
          deliveries: refMode ? result.deliveries.map(museRelayDeliveryRef) : result.deliveries,
          cancellations: result.cancellations,
          serverTime: result.serverTime,
        } as unknown as JsonValue);
        return true;
      }
      if (rest === "/heartbeat") {
        const body = heartbeatSchema.safeParse(await readJson(req, 16 * 1024));
        if (!body.success) throw new MuseRelayError(400, "The heartbeat body is invalid");
        const result = hub.heartbeat(connectionId, body.data.turnId, body.data.deliveryId);
        json(res, 200, { schemaVersion: MUSE_RELAY_SCHEMA_VERSION, ...result } as unknown as JsonValue);
        return true;
      }
      const turn = TURN_PATH.exec(rest);
      if (!turn) {
        json(res, 404, { schemaVersion: MUSE_RELAY_SCHEMA_VERSION, error: "Unknown Muse relay endpoint" });
        return true;
      }
      const turnId = turn[1]!;
      if (turn[2] === "input") {
        const body = inputSliceSchema.safeParse(await readJson(req, 4 * 1024));
        if (!body.success) throw new MuseRelayError(400, "The input body is invalid");
        const slice = hub.inputSlice(connectionId, turnId, body.data.deliveryId, body.data.offset, body.data.length);
        json(res, 200, {
          schemaVersion: MUSE_RELAY_SCHEMA_VERSION,
          offset: slice.offset,
          total: slice.total,
          data: slice.data.toString("base64"),
        });
        return true;
      }
      if (turn[2] === "events") {
        const body = eventSchema.safeParse(await readJson(req, MUSE_RELAY_MAX_EVENT_BODY_BYTES));
        if (!body.success) throw new MuseRelayError(400, "The event body is invalid");
        const result = hub.recordEvent(connectionId, turnId, body.data);
        json(res, 200, { schemaVersion: MUSE_RELAY_SCHEMA_VERSION, ...result } as unknown as JsonValue);
        return true;
      }
      const result = await uploadFile(req, url, connectionId, turnId);
      json(res, 200, { schemaVersion: MUSE_RELAY_SCHEMA_VERSION, accepted: true, ...result } as unknown as JsonValue);
      return true;
    } catch (error) {
      dataError(res, error);
      return true;
    }
  };

  return {
    routes,
    door,
    close: () => hub.dispose(),
  };
}
