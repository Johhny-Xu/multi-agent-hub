import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { deciderConfigSchema } from "../decider/config.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createDeciderRoutes } from "./decider.ts";

async function call(route: ReturnType<typeof createDeciderRoutes>, path: string, method: string, body?: unknown) {
  const req = new IncomingMessage(new Socket());
  const res = new ServerResponse(req);
  let answer: { status: number; body: unknown } | null = null;
  const out = await route({
    req,
    res,
    url: new URL(`http://localhost${path}`),
    path,
    method,
    readBody: async () => body,
    auth: { kind: "loopback", scopes: ["admin"] } as RequestAuth,
    json: (_res, status, sent) => {
      answer = { status, body: sent };
    },
  });
  return { out, answer: answer as { status: number; body: unknown } | null };
}

describe("decider proxy schema validation", () => {
  it("accepts valid http and https URLs, rejects socks, or empty/undefined", () => {
    expect(deciderConfigSchema.safeParse({ proxyUrl: "http://127.0.0.1:7890" }).success).toBe(true);
    expect(deciderConfigSchema.safeParse({ proxyUrl: "https://proxy.example.com:8443" }).success).toBe(true);
    expect(deciderConfigSchema.safeParse({ proxyUrl: "socks5://127.0.0.1:1080" }).success).toBe(false);
    expect(deciderConfigSchema.safeParse({ proxyUrl: "socks://127.0.0.1:1080" }).success).toBe(false);
    expect(deciderConfigSchema.safeParse({ proxyUrl: "socks5h://user:secret@127.0.0.1:1080" }).success).toBe(false);
    expect(deciderConfigSchema.safeParse({ proxyUrl: "" }).success).toBe(true);
    expect(deciderConfigSchema.safeParse({ proxyUrl: undefined }).success).toBe(true);
    expect(deciderConfigSchema.safeParse({}).success).toBe(true);
  });

  it("rejects invalid schemes or malformed URLs", () => {
    expect(deciderConfigSchema.safeParse({ proxyUrl: "ftp://127.0.0.1:21" }).success).toBe(false);
    expect(deciderConfigSchema.safeParse({ proxyUrl: "not-a-url" }).success).toBe(false);
    expect(deciderConfigSchema.safeParse({ proxyUrl: "http://" }).success).toBe(false);
  });
});

describe("the Gemini provider's test", () => {
  it("accepts a Gemini draft, checks it at Gemini, and returns the verdict unchanged", async () => {
    const testKey = vi.fn()
      .mockResolvedValueOnce({ ok: true, latencyMs: 7 })
      .mockResolvedValueOnce({ ok: false, reason: "rejected", status: 400 });
    const route = createDeciderRoutes({ decider: { testKey } as any, config: () => ({}) });

    const first = await call(route, "/api/decider/test", "POST", { provider: "gemini", key: " AIza-draft " });
    expect(testKey).toHaveBeenCalledWith({ key: "AIza-draft", provider: "gemini" });
    expect(first.answer).toEqual({ status: 200, body: { ok: true, latencyMs: 7 } });

    const second = await call(route, "/api/decider/test", "POST", { provider: "gemini", key: "AIza-bad" });
    expect(second.answer).toEqual({ status: 200, body: { ok: false, reason: "rejected", status: 400 } });
  });
});

describe("decider proxy route read/write and masking", () => {
  it("GET /api/decider/proxy returns the masked proxyUrl", async () => {
    const cfg: AppConfig = {
      decider: { proxyUrl: "http://admin:secretPass123@127.0.0.1:7890" },
    };
    const route = createDeciderRoutes({
      decider: { testKey: vi.fn() as any },
      config: () => cfg,
    });
    const { answer } = await call(route, "/api/decider/proxy", "GET");
    expect(answer?.status).toBe(200);
    expect(answer?.body).toEqual({ proxyUrl: "http://******:******@127.0.0.1:7890" });
  });

  it("PUT /api/decider/proxy saves a new proxyUrl and returns masked result", async () => {
    let saved: Partial<AppConfig> | null = null;
    let cfg: AppConfig = { decider: {} };
    const route = createDeciderRoutes({
      decider: { testKey: vi.fn() as any },
      config: () => cfg,
      saveConfig: (patch) => {
        saved = patch;
        cfg = { ...cfg, decider: { ...cfg.decider, ...patch.decider } };
      },
    });

    const { answer } = await call(route, "/api/decider/proxy", "PUT", {
      proxyUrl: "http://alice:topsecret@127.0.0.1:8888",
    });
    expect(answer?.status).toBe(200);
    expect(answer?.body).toEqual({ ok: true, proxyUrl: "http://******:******@127.0.0.1:8888" });
    expect(saved).toEqual({ decider: { proxyUrl: "http://alice:topsecret@127.0.0.1:8888" } });
  });

  it("PUT /api/decider/proxy keeps the original credentials when re-submitting masked url", async () => {
    let cfg: AppConfig = {
      decider: { proxyUrl: "http://alice:topsecret@127.0.0.1:8888" },
    };
    let saved: Partial<AppConfig> | null = null;
    const route = createDeciderRoutes({
      decider: { testKey: vi.fn() as any },
      config: () => cfg,
      saveConfig: (patch) => {
        saved = patch;
      },
    });

    const { answer } = await call(route, "/api/decider/proxy", "PUT", {
      proxyUrl: "http://******:******@127.0.0.1:8888",
    });
    expect(answer?.status).toBe(200);
    expect(saved).toEqual({ decider: { proxyUrl: "http://alice:topsecret@127.0.0.1:8888" } });
  });

  it("PUT /api/decider/proxy rejects invalid url or non-string", async () => {
    const route = createDeciderRoutes({
      decider: { testKey: vi.fn() as any },
      config: () => ({}),
      saveConfig: vi.fn(),
    });

    const badType = await call(route, "/api/decider/proxy", "PUT", { proxyUrl: 12345 });
    expect(badType.answer?.status).toBe(400);

    const badScheme = await call(route, "/api/decider/proxy", "PUT", { proxyUrl: "ftp://127.0.0.1:21" });
    expect(badScheme.answer?.status).toBe(400);
  });
});
