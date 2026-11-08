import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import type { BotRecord } from "../store.ts";
import { vpsConfigRevision } from "../vps-hosts.ts";
import { createVpsStatusStore } from "../vps-status.ts";
import { createVpsInstanceRoutes, type VpsInstanceRouteDeps } from "./vps-instances.ts";
import { PASS, type RouteContext } from "./table.ts";

function fixture(
  bots: BotRecord[] = [],
  seed = {},
  auth: RouteContext["auth"] = { kind: "loopback", scopes: ["admin"] },
  overrides: Partial<VpsInstanceRouteDeps> = {},
) {
  const cfg = {
    mcpServers: { simular: { type: "http", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer secret" }, enabled: true } },
    vps: { version: 2, instances: [], ...seed },
  } as unknown as AppConfig;
  const probeSsh = vi.fn(async () => ({ available: true }));
  const probeMcp = vi.fn(async () => ({ available: true }));
  const listMcpResources = vi.fn(async () => [{ id: "box-1", name: "Work", state: "running" }]);
  const statusStore = createVpsStatusStore();
  const deps: VpsInstanceRouteDeps = {
    cfg,
    bots,
    save: (config) => { cfg.vps = config; },
    probeSsh,
    probeMcp,
    listMcpResources,
    statusStore,
    ...overrides,
  };
  const handler = createVpsInstanceRoutes(deps);
  const call = async (method: string, path: string, body?: Record<string, unknown>, search = "") => {
    const sent: Array<{ status: number; body: any }> = [];
    let out: typeof PASS | void;
    try {
    out = await handler({
      req: { headers: body === undefined ? {} : { "content-type": "application/json" } } as unknown as IncomingMessage,
      res: { setHeader: () => {} } as unknown as ServerResponse,
      url: new URL(`http://localhost${path}${search}`),
      path,
      method,
      auth,
      json: ((_res: ServerResponse, status: number, response: unknown) => { sent.push({ status, body: response }); }) as RouteContext["json"],
      readBody: (async () => body ?? {}) as RouteContext["readBody"],
    });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      return { status, body: { error: (error as Error).message } };
    }
    if (out === PASS) throw new Error(`route passed ${method} ${path}`);
    return sent[0]!;
  };
  return { cfg, call, probeSsh, probeMcp, listMcpResources, statusStore };
}
type RequestAuthLike = RouteContext["auth"];

describe("VPS instance routes", () => {
  it("creates and renames an SSH instance", async () => {
    const { cfg, call } = fixture();
    const created = await call("POST", "/api/vps/instances", {
      kind: "ssh", name: "Alpha", sshAlias: "alpha-vps", expectedRevision: vpsConfigRevision(cfg),
    });
    expect(created.status).toBe(201);
    const id = created.body.instance.id as string;
    expect(created.body.instance.name).toBe("Alpha");

    const renamed = await call("PATCH", `/api/vps/instances/${id}`, {
      name: "Production", expectedRevision: created.body.revision,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.instance.name).toBe("Production");
    expect((cfg.vps as { instances: Array<{ sshAlias: string }> }).instances[0]!.sshAlias).toBe("alpha-vps");
  });

  it("references a saved MCP connection without returning credentials", async () => {
    const { cfg, call } = fixture();
    const created = await call("POST", "/api/vps/instances", {
      kind: "mcp", adapter: "simular-box", name: "Boxed", mcpServer: "simular", boxId: "box-1",
      expectedRevision: vpsConfigRevision(cfg),
    });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toMatch(/Bearer|mcp\.example|secret/);

    const listed = await call("GET", "/api/vps/instances");
    expect(JSON.stringify(listed.body)).not.toMatch(/Bearer|mcp\.example|secret/);
    expect(listed.body.instances[0]).toMatchObject({ kind: "mcp", name: "Boxed" });
  });

  it("rejects deleting an instance still in use", async () => {
    const bot = { id: "b", name: "Scout", vpsInstanceId: "alpha" } as BotRecord;
    const { cfg, call } = fixture([bot], {
      instances: [{ id: "alpha", name: "Alpha", kind: "ssh", sshAlias: "alpha-vps" }],
    });
    const refused = await call("DELETE", "/api/vps/instances/alpha", { expectedRevision: vpsConfigRevision(cfg) });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("Scout");
    expect((cfg.vps as { instances: unknown[] }).instances).toHaveLength(1);
  });

  it("rejects stale revision updates", async () => {
    const { call } = fixture();
    const refused = await call("POST", "/api/vps/instances", {
      kind: "ssh", name: "Alpha", sshAlias: "alpha-vps", expectedRevision: "stale",
    });
    expect(refused.status).toBe(409);
  });

  it("does not wake a box when checking its catalog", async () => {
    const { cfg, call, probeMcp, listMcpResources } = fixture([], {
      instances: [{ id: "boxed", name: "Boxed", kind: "mcp", adapter: "simular-box", mcpServer: "simular", boxId: "box-1" }],
    });
    const listed = await call("GET", "/api/vps/instances");
    expect(listed.body.instances[0].available).toBeNull();
    expect(await listed.body.instances[0].available).not.toBe(true);
    expect(probeMcp).not.toHaveBeenCalled();
    expect(listMcpResources).not.toHaveBeenCalled();

    const checked = await call("POST", "/api/vps/instances/boxed/check", { expectedRevision: vpsConfigRevision(cfg) });
    expect(checked.status).toBe(200);
    expect(probeMcp).toHaveBeenCalledWith("simular", "box-1", expect.anything(), expect.anything());
  });

  it("leaves other routes to their own handlers", async () => {
    const { call } = fixture([], {}, { kind: "session", scopes: ["client"] } as RequestAuthLike);
    await expect(call("GET", "/api/auth/session")).rejects.toThrow("route passed GET /api/auth/session");
    await expect(call("POST", "/api/routines")).rejects.toThrow("route passed POST /api/routines");
  });

  it("keeps VPS management to the owner", async () => {
    const { call } = fixture([], {}, { kind: "session", scopes: ["client"] } as RequestAuthLike);
    const refused = await call("GET", "/api/vps/instances");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain("owner");
  });

  it("removes an unused instance and drops a default that pointed at it", async () => {
    const { cfg, call } = fixture([], {
      instances: [
        { id: "alpha", name: "Alpha", kind: "ssh", sshAlias: "alpha-vps" },
        { id: "beta", name: "Beta", kind: "ssh", sshAlias: "beta-vps" },
      ],
      defaultInstanceId: "alpha",
    });
    const kept = await call("DELETE", "/api/vps/instances/beta", { expectedRevision: vpsConfigRevision(cfg) });
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ removed: true });
    const afterFirst = cfg.vps as { instances: Array<{ id: string }>; defaultInstanceId?: string };
    expect(afterFirst.instances.map((instance) => instance.id)).toEqual(["alpha"]);
    expect(afterFirst.defaultInstanceId).toBe("alpha");

    const dropped = await call("DELETE", "/api/vps/instances/alpha", { expectedRevision: vpsConfigRevision(cfg) });
    expect(dropped.status).toBe(200);
    const afterSecond = cfg.vps as { instances: unknown[]; defaultInstanceId?: string };
    expect(afterSecond.instances).toHaveLength(0);
    expect(afterSecond.defaultInstanceId).toBeUndefined();
  });

  it("rejects stale revisions on rename, delete, and the default switch", async () => {
    const { cfg, call } = fixture([], {
      instances: [{ id: "alpha", name: "Alpha", kind: "ssh", sshAlias: "alpha-vps" }],
      defaultInstanceId: "alpha",
    });
    expect((await call("PATCH", "/api/vps/instances/alpha", { name: "New", expectedRevision: "stale" })).status).toBe(409);
    expect((await call("DELETE", "/api/vps/instances/alpha", { expectedRevision: "stale" })).status).toBe(409);
    expect((await call("PUT", "/api/vps/default-instance", { id: null, expectedRevision: "stale" })).status).toBe(409);
    expect((cfg.vps as { instances: unknown[]; defaultInstanceId?: string }).instances).toHaveLength(1);
    expect((cfg.vps as { defaultInstanceId?: string }).defaultInstanceId).toBe("alpha");
  });

  it("refuses a second registration of the same SSH host or box, and an unknown MCP connection", async () => {
    const { cfg, call } = fixture([], {
      instances: [
        { id: "alpha", name: "Alpha", kind: "ssh", sshAlias: "alpha-vps" },
        { id: "boxed", name: "Boxed", kind: "mcp", adapter: "simular-box", mcpServer: "simular", boxId: "box-1" },
      ],
    });
    const duplicateHost = await call("POST", "/api/vps/instances", {
      kind: "ssh", name: "Again", sshAlias: "alpha-vps", expectedRevision: vpsConfigRevision(cfg),
    });
    expect(duplicateHost.status).toBe(409);
    expect(duplicateHost.body.error).toContain("already listed");
    const duplicateBox = await call("POST", "/api/vps/instances", {
      kind: "mcp", adapter: "simular-box", name: "Again", mcpServer: "simular", boxId: "box-1",
      expectedRevision: vpsConfigRevision(cfg),
    });
    expect(duplicateBox.status).toBe(409);
    const unknownConnection = await call("POST", "/api/vps/instances", {
      kind: "mcp", adapter: "simular-box", name: "Other", mcpServer: "ghost", boxId: "box-9",
      expectedRevision: vpsConfigRevision(cfg),
    });
    expect(unknownConnection.status).toBe(400);
    expect(unknownConnection.body.error).toContain("saved MCP connection");
    expect((cfg.vps as { instances: unknown[] }).instances).toHaveLength(2);
  });

  it("switches and clears the default instance", async () => {
    const { cfg, call } = fixture([], {
      instances: [
        { id: "alpha", name: "Alpha", kind: "ssh", sshAlias: "alpha-vps" },
        { id: "beta", name: "Beta", kind: "ssh", sshAlias: "beta-vps" },
      ],
      defaultInstanceId: "alpha",
    });
    const switched = await call("PUT", "/api/vps/default-instance", { id: "beta", expectedRevision: vpsConfigRevision(cfg) });
    expect(switched.status).toBe(200);
    expect((cfg.vps as { defaultInstanceId?: string }).defaultInstanceId).toBe("beta");

    const cleared = await call("PUT", "/api/vps/default-instance", { id: null, expectedRevision: vpsConfigRevision(cfg) });
    expect(cleared.status).toBe(200);
    expect((cfg.vps as { defaultInstanceId?: string }).defaultInstanceId).toBeUndefined();

    const missing = await call("PUT", "/api/vps/default-instance", { id: "ghost", expectedRevision: vpsConfigRevision(cfg) });
    expect(missing.status).toBe(404);
    expect((cfg.vps as { defaultInstanceId?: string }).defaultInstanceId).toBeUndefined();
  });

  it("reports the SSH round trip and remembers it for the list", async () => {
    const { cfg, call, statusStore } = fixture([], {
      instances: [{ id: "alpha", name: "Alpha", kind: "ssh", sshAlias: "alpha-vps" }],
    }, undefined, { probeSsh: async () => ({ available: true, latencyMs: 42 }) });
    const checked = await call("POST", "/api/vps/instances/alpha/check", { expectedRevision: vpsConfigRevision(cfg) });
    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({ online: true, latencyMs: 42, available: true });
    expect(String(checked.body.checkedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(statusStore.get("alpha")).toMatchObject({ online: true, latencyMs: 42 });

    const listed = await call("GET", "/api/vps/instances");
    expect(listed.body.instances[0]).toMatchObject({ online: true, latencyMs: 42 });
    expect(String(listed.body.instances[0].checkedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("measures the MCP round trip when the probe does not time it itself", async () => {
    const { cfg, call } = fixture([], {
      instances: [{ id: "boxed", name: "Boxed", kind: "mcp", adapter: "simular-box", mcpServer: "simular", boxId: "box-1" }],
    }, undefined, { probeMcp: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { available: true };
    } });
    const checked = await call("POST", "/api/vps/instances/boxed/check", { expectedRevision: vpsConfigRevision(cfg) });
    expect(checked.body).toMatchObject({ online: true, available: true });
    expect(checked.body.latencyMs).toBeGreaterThanOrEqual(20);
  });

  it("records a failed check as offline with a short reason", async () => {
    const { cfg, call } = fixture([], {
      instances: [{ id: "alpha", name: "Alpha", kind: "ssh", sshAlias: "alpha-vps" }],
    }, undefined, { probeSsh: async () => ({ available: false, reason: "unreachable", detail: "ssh: connect to host alpha-vps port 22: Connection refused" }) });
    const checked = await call("POST", "/api/vps/instances/alpha/check", { expectedRevision: vpsConfigRevision(cfg) });
    expect(checked.body).toMatchObject({ online: false, available: false, reason: "unreachable" });
    expect(checked.body.error).toContain("Connection refused");
    const listed = await call("GET", "/api/vps/instances");
    expect(listed.body.instances[0]).toMatchObject({ online: false });
  });

  it("records a check that ran out of time as offline with the budget", async () => {
    const { cfg, call } = fixture([], {
      instances: [{ id: "alpha", name: "Alpha", kind: "ssh", sshAlias: "alpha-vps" }],
    }, undefined, {
      checkTimeoutMs: 30,
      probeSsh: async (_target, signal) => await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    const checked = await call("POST", "/api/vps/instances/alpha/check", { expectedRevision: vpsConfigRevision(cfg) });
    expect(checked.body).toMatchObject({ online: false, available: false, reason: "timeout" });
    expect(checked.body.error).toContain("30 ms");
  });

  it("keeps a removed computer's status out of the list", async () => {
    const { cfg, call, statusStore } = fixture([], {
      instances: [
        { id: "alpha", name: "Alpha", kind: "ssh", sshAlias: "alpha-vps" },
        { id: "beta", name: "Beta", kind: "ssh", sshAlias: "beta-vps" },
      ],
    });
    await call("POST", "/api/vps/instances/alpha/check", { expectedRevision: vpsConfigRevision(cfg) });
    expect(statusStore.get("alpha")).toBeDefined();
    await call("DELETE", "/api/vps/instances/alpha", { expectedRevision: vpsConfigRevision(cfg) });
    expect(statusStore.get("alpha")).toBeUndefined();
  });
});
