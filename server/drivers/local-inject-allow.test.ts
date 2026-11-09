import { describe, expect, it } from "vitest";
import { injectAllowList, probeLocalInjects } from "./local-inject.ts";

describe("injectAllowList", () => {
  it("is null when unset or empty, so every model stays", () => {
    expect(injectAllowList("9router", {})).toBeNull();
    expect(injectAllowList("9router", { OMB_INJECT_ALLOW_9ROUTER: " , " })).toBeNull();
  });

  it("parses a comma list for the host's env name", () => {
    const allow = injectAllowList("9router", { OMB_INJECT_ALLOW_9ROUTER: "ollama/gpt-oss:120b, zd/gpt-6.1-sol,trae" });
    expect([...allow!]).toEqual(["ollama/gpt-oss:120b", "zd/gpt-6.1-sol", "trae"]);
  });

  it("keeps only allowed 9router models in the probe", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("http://127.0.0.1:20128/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "trae" }, { id: "gh/gpt-4o" }, { id: "ollama/gpt-oss:120b" }] }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    const found = await probeLocalInjects({ OMB_9ROUTER_API_KEY: "k", OMB_INJECT_ALLOW_9ROUTER: "trae,ollama/gpt-oss:120b" }, fetchImpl);
    expect(found.filter((m) => m.host === "9router").map((m) => m.model).sort()).toEqual(["ollama/gpt-oss:120b", "trae"]);
  });
});
