import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { createDecider } from "./index.ts";
import { roomRoutingRequest } from "./room-routing.ts";
import { jevProxyUrl, withJevProxy } from "./proxy.ts";

const undiciCalls: Array<[unknown, unknown]> = [];
const undiciFetchMock = vi.fn(async (url: unknown, init: unknown) => {
  undiciCalls.push([url, init]);
  return jsonResponse(choiceBody("theo", { theo: 0.97, maya: 0.03 }));
});

vi.mock("undici", () => {
  class ProxyAgent {
    dispatch = () => {};
    close = async () => {};
    constructor(public url: string) {}
  }
  return {
    ProxyAgent,
    fetch: (url: unknown, init: unknown) => undiciFetchMock(url, init),
  };
});

const KEY = "tsk_proxy_secret_key_0123456789abcdef";
const PROXY = "http://127.0.0.1:7890";
const ON: AppConfig = { decider: { enabled: true, key: KEY, proxyUrl: PROXY, jobs: { roomRouting: true } } };
const OPTIONS = { maya: "Maya, Product Designer bot.", theo: "Theo, Frontend Engineer bot." };
const QUESTION = { instructions: "Which bot should answer `new_message`?", options: OPTIONS };
const STATE = { new_message: { from: "Milind", text: "PRIVATE-MESSAGE-TEXT the navbar overlaps on Safari" } };

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function choiceBody(choice: string, probabilities: Record<string, number>) {
  return { answers: { answer: { type: "choice", choice, probabilities } } };
}

function decider(config: AppConfig, fetchImpl: FetchMock) {
  return createDecider({ config: () => config, fetch: fetchImpl as unknown as typeof fetch });
}

const isDispatcher = (value: unknown) => Boolean(value) && typeof (value as { dispatch?: unknown }).dispatch === "function";

beforeEach(() => {
  undiciCalls.length = 0;
  undiciFetchMock.mockClear();
});

afterEach(() => vi.unstubAllEnvs());

describe("which address proxies Jev", () => {
  it("the saved proxyUrl wins over JEV_PROXY, which wins over direct", () => {
    expect(jevProxyUrl(" http://cfg:1 ")).toBe("http://cfg:1");
    vi.stubEnv("JEV_PROXY", "http://env:2");
    expect(jevProxyUrl(" http://cfg:1 ")).toBe("http://cfg:1");
    expect(jevProxyUrl(undefined)).toBe("http://env:2");
    expect(jevProxyUrl("  ")).toBe("http://env:2");
    vi.stubEnv("JEV_PROXY", "");
    expect(jevProxyUrl(undefined)).toBeUndefined();
    expect(jevProxyUrl("  ")).toBeUndefined();
  });
});

describe("withJevProxy", () => {
  it("hands the base fetch a dispatcher and every other option unchanged", async () => {
    const base = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}));
    await withJevProxy(base as unknown as typeof fetch, PROXY)("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      redirect: "error",
      body: "{}",
    });
    expect(undiciFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = undiciCalls[0]! as [unknown, RequestInit & { dispatcher?: unknown }];
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(String(init?.body)).toBe("{}");
    expect(isDispatcher(init?.dispatcher)).toBe(true);
  });

  it("is the base fetch itself when no proxy is configured", () => {
    const base = vi.fn<typeof fetch>();
    expect(withJevProxy(base as unknown as typeof fetch, undefined)).toBe(base);
    expect(withJevProxy(base as unknown as typeof fetch, "  ")).toBe(base);
  });

  it("goes direct when the dispatcher cannot be built", async () => {
    const base = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}));
    await withJevProxy(base as unknown as typeof fetch, "not a url")("https://api.typesafe.ai/v1/systemone");
    expect(undiciFetchMock).toHaveBeenCalledTimes(1);
  });

  it("one address builds one dispatcher, reused across calls", async () => {
    const base = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}));
    const via = withJevProxy(base as unknown as typeof fetch, PROXY);
    await via("https://a.example"); await via("https://b.example");
    const firstDispatcher = (undiciCalls[0]![1] as { dispatcher?: unknown })?.dispatcher;
    const secondDispatcher = (undiciCalls[1]![1] as { dispatcher?: unknown })?.dispatcher;
    expect(firstDispatcher).toBe(secondDispatcher);
  });
});

describe("the Jev backend's requests through createDecider", () => {
  it("a saved proxyUrl reaches the fetch as a dispatcher, with redirect still refused", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(choiceBody("theo", { theo: 0.97, maya: 0.03 })));
    const result = await decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION);
    expect(result).toMatchObject({ ok: true, answers: { choice: "theo" } });
    const init = undiciCalls[0]![1] as RequestInit & { dispatcher?: unknown; headers?: Record<string, string> };
    expect(isDispatcher(init.dispatcher)).toBe(true);
    expect(init.redirect).toBe("error");
    expect(String(init.headers && init.headers.authorization)).toBe(`Bearer ${KEY}`);
  });

  it("JEV_PROXY proxies too, when nothing is saved", async () => {
    vi.stubEnv("JEV_PROXY", PROXY);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(choiceBody("maya", { theo: 0.03, maya: 0.97 })));
    await decider({ decider: { enabled: true, key: KEY, jobs: { roomRouting: true } } }, fetchImpl).choose("roomRouting", STATE, QUESTION);
    const init = undiciCalls[0]![1] as RequestInit & { dispatcher?: unknown };
    expect(isDispatcher(init?.dispatcher)).toBe(true);
  });

  it("no proxy configured: the fetch gets none", async () => {
    vi.stubEnv("JEV_PROXY", "");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(choiceBody("theo", { theo: 0.97, maya: 0.03 })));
    await decider({ decider: { enabled: true, key: KEY, jobs: { roomRouting: true } } }, fetchImpl).choose("roomRouting", STATE, QUESTION);
    expect(fetchImpl.mock.calls[0]![1]?.dispatcher).toBeUndefined();
  });

  it("Cloud's included relay rides the same proxy", async () => {
    vi.stubEnv("OMB_CLOUD_DECIDER_URL", "https://cloud.example.test/api/cloud/services/decider");
    vi.stubEnv("OMB_CLOUD_DECIDER_TOKEN", "omb_decide_unit_included_token_0123456789");
    const room = roomRoutingRequest({
      room: "Launch", humans: ["Milind"],
      members: [{ id: "maya", name: "Maya", title: "Product Designer" }, { id: "theo", name: "Theo", title: "Frontend Engineer" }],
      recent: [{ from: "Milind", text: "PRIVATE-MESSAGE-TEXT we ship Friday" }],
      message: { from: "Milind", text: "PRIVATE-MESSAGE-TEXT the navbar overlaps on Safari" },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ answers: { answer: { type: "noul", noul: 0.97 } } }));
    await decider({ decider: { proxyUrl: PROXY } }, fetchImpl).choose("roomRouting", room.state, room.question);
    expect(String(undiciCalls[0]![0])).toBe("https://cloud.example.test/api/cloud/services/decider/v1/systemone");
    const init = undiciCalls[0]![1] as RequestInit & { dispatcher?: unknown };
    expect(isDispatcher(init?.dispatcher)).toBe(true);
  });
});

describe("other backends never see the proxy", () => {
  it("OpenRouter's call carries no dispatcher, even with a proxy saved", async () => {
    const config: AppConfig = {
      decider: {
        enabled: true, provider: "openrouter", openrouterKey: "sk-or-v1-unit-openrouter-key-0123456789",
        openrouterModel: "openai/gpt-4o-mini", proxyUrl: PROXY, jobs: { roomRouting: true },
      },
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}));
    await decider(config, fetchImpl).choose("roomRouting", STATE, QUESTION);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(fetchImpl.mock.calls[0]![1]?.dispatcher).toBeUndefined();
  });

  it("Workers AI's call carries no dispatcher, even with a proxy saved", async () => {
    const config: AppConfig = {
      decider: {
        enabled: true, workersAiToken: "cf-token", workersAiAccountId: "0123456789abcdef0123456789abcdef",
        proxyUrl: PROXY, jobs: { roomRouting: true },
      },
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}));
    await decider(config, fetchImpl).choose("roomRouting", STATE, QUESTION);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/cloudflare/clef-flash");
    expect(fetchImpl.mock.calls[0]![1]?.dispatcher).toBeUndefined();
  });
});
