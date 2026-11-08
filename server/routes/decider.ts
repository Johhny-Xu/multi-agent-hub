import { userError } from "../user-errors.ts";
// The answer is a verdict (and how long it took), never the key and never the vendor's raw body.
import { saveConfig, type AppConfig } from "../config.ts";
import { deciderConfigSchema, OPENROUTER_MODEL_ID_MAX, WORKERS_AI_ACCOUNT_ID } from "../decider/config.ts";
import type { Decider } from "../decider/index.ts";
import type { Extractor } from "../extractor/index.ts";
import { isMaskedProxyUrl, maskProxyUrl } from "../decider/proxy.ts";
import { createOpenRouterModelCatalog, type OpenRouterModelCatalog } from "../decider/openrouter-models.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface DeciderRouteDeps {
  decider: Pick<Decider, "testKey">;
  /** Tested beside a saved key, when something can extract. */
  extractor?: Pick<Extractor, "testKey">;
  models?: Pick<OpenRouterModelCatalog, "load">;
  config(): AppConfig;
  saveConfig?(patch: Partial<AppConfig>): void;
}

const MAX_KEY_LENGTH = 512;

export function createDeciderRoutes(deps: DeciderRouteDeps): RouteHandler {
  const models = deps.models ?? createOpenRouterModelCatalog();
  return async ({ req, res, path, method, json, readBody }) => {
    if (path === "/api/decider/models" && method === "GET") {
      res.setHeader("cache-control", "no-store");
      return json(res, 200, await models.load(deps.config().decider?.openrouterBaseUrl));
    }
    if (path === "/api/decider/proxy") {
      if (method === "GET") {
        res.setHeader("cache-control", "no-store");
        const raw = deps.config().decider?.proxyUrl;
        return json(res, 200, { proxyUrl: maskProxyUrl(raw) });
      }
      if (method === "POST" || method === "PUT" || method === "PATCH") {
        res.setHeader("cache-control", "no-store");
        const body = await readBody(req, 8192);
        if (body?.proxyUrl !== undefined && typeof body.proxyUrl !== "string") {
          return json(res, 400, { error: "proxyUrl must be a string" });
        }
        const candidate = typeof body?.proxyUrl === "string" ? body.proxyUrl.trim() : "";
        const current = deps.config().decider?.proxyUrl;
        const resolved = isMaskedProxyUrl(candidate) && current ? current : candidate;
        const parsed = deciderConfigSchema.shape.proxyUrl.safeParse(resolved);
        if (!parsed.success) {
          return json(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid proxy url" });
        }
        const save = deps.saveConfig ?? saveConfig;
        save({ decider: { proxyUrl: resolved } });
        return json(res, 200, { ok: true, proxyUrl: maskProxyUrl(resolved) });
      }
      return json(res, 405, { error: "method not allowed" });
    }
    if (path !== "/api/decider/test" || method !== "POST") return PASS;
    const body = await readBody(req, 8192);
    if (body?.key !== undefined && typeof body.key !== "string") return json(res, 400, { error: "key must be a string" });
    const draft = typeof body?.key === "string" ? body.key.trim() : "";
    if (draft.length > MAX_KEY_LENGTH) return json(res, 400, { error: "That does not look like an API key." });
    res.setHeader("cache-control", "no-store");
    const provider = body?.provider === "jev" || body?.provider === "openrouter" || body?.provider === "workersai" ? body.provider : undefined;
    if (body?.accountId !== undefined && (typeof body.accountId !== "string" || !WORKERS_AI_ACCOUNT_ID.test(body.accountId.trim()))) {
      return json(res, 400, userError("serverError.decider.accountId"));
    }
    const accountId = typeof body?.accountId === "string" ? body.accountId.trim() : undefined;
    if (body?.model !== undefined && (typeof body.model !== "string" || body.model.length > OPENROUTER_MODEL_ID_MAX)) {
      return json(res, 400, { error: "model must be an OpenRouter model id" });
    }
    const model = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : undefined;
    const api = body?.api === "decisions" || body?.api === "chat" ? body.api : undefined;
    const result = await deps.decider.testKey({
      ...(draft ? { key: draft } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(api ? { api } : {}),
      ...(accountId ? { accountId } : {}),
    });
    // The saved keys also read: say whether extraction works too. A draft key is checked for decisions only.
    const read = !draft && (!provider || provider === "workersai") && deps.extractor ? await deps.extractor.testKey() : null;
    const extraction = read && !(read.ok === false && read.reason === "no_key")
      ? { extraction: read.ok ? { ok: true } : { ok: false, reason: read.reason, ...(read.status ? { status: read.status } : {}) } }
      : {};
    if (result.ok) return json(res, 200, { ok: true, latencyMs: result.latencyMs, ...extraction });
    return json(res, 200, { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}), ...extraction });
  };
}
