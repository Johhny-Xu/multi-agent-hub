// The mocked removal stands in for docker-over-SSH: these tests pin which aliases may reach it.
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord } from "../store.ts";
import * as vps from "../vps-computer.ts";
import { createComputerRoutes, type ComputerRouteDeps } from "./computers.ts";
import { PASS, type RouteContext } from "./table.ts";

vi.mock("../vps-computer.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../vps-computer.ts")>();
  return { ...actual, removeManagedVpsComputer: vi.fn() };
});

const remove = vi.mocked(vps.removeManagedVpsComputer);
const CONTAINER = "openmausbot-vps-test-abc123";

beforeEach(() => {
  remove.mockReset();
  remove.mockResolvedValue({ removed: true, name: CONTAINER });
});

function fixture(bots: BotRecord[], cfg: AppConfig) {
  // Only what the VPS remove endpoint touches; any other dependency is absent, and a route that reached for one would throw.
  const deps = {
    store: { bot: () => null, bots, sections: [] },
    cfg,
    computerProviderConfigTransitions: new Set(),
    managedBoatOwners: () => [],
    claimManagedVpsMutation: () => () => {},
    teamComputers: { list: () => [] },
    routines: () => null,
  } as unknown as ComputerRouteDeps;
  const handler = createComputerRoutes(deps);
  const postRemove = async (input: { instanceId: string; body: Record<string, unknown> }) => {
    const sent: Array<{ status: number; body: any }> = [];
    const out = await handler({
      req: { headers: { "content-type": "application/json" } } as unknown as IncomingMessage,
      res: {} as ServerResponse,
      url: new URL(`http://localhost/api/computers/vps/${input.instanceId}/remove`),
      path: `/api/computers/vps/${input.instanceId}/remove`,
      method: "POST",
      auth: { kind: "loopback", scopes: ["admin"] } as RequestAuth,
      json: ((_res: ServerResponse, status: number, response: unknown) => {
        sent.push({ status, body: response });
      }) as RouteContext["json"],
      readBody: (async () => input.body) as RouteContext["readBody"],
    });
    expect(out).not.toBe(PASS);
    expect(sent).toHaveLength(1);
    return sent[0]!;
  };
  const getVps = async () => {
    const sent: Array<{ status: number; body: any }> = [];
    const out = await handler({
      req: { headers: {} } as unknown as IncomingMessage,
      res: { setHeader: () => {} } as unknown as ServerResponse,
      url: new URL("http://localhost/api/computers/vps"),
      path: "/api/computers/vps",
      method: "GET",
      auth: { kind: "loopback", scopes: ["admin"] } as RequestAuth,
      json: ((_res: ServerResponse, status: number, response: unknown) => {
        sent.push({ status, body: response });
      }) as RouteContext["json"],
      readBody: (async () => ({})) as RouteContext["readBody"],
    });
    expect(out).not.toBe(PASS);
    expect(sent).toHaveLength(1);
    return sent[0]!;
  };
  return { postRemove, getVps };
}

const CONTAINER_ID = "a".repeat(64);
const cfgWith = (): AppConfig => ({
  vps: {
    version: 2,
    instances: [
      { id: "alpha", name: "Alpha", kind: "ssh", sshAlias: "alpha-vps" },
      { id: "beta", name: "Beta", kind: "ssh", sshAlias: "production-vps" },
      { id: "boxed", name: "Boxed", kind: "mcp", adapter: "simular-box", mcpServer: "simular", boxId: "box-1" },
    ],
  },
}) as AppConfig;

describe("POST /api/computers/vps/:instanceId/remove", () => {
  it("refuses an instance that is not a configured SSH host without touching SSH", async () => {
    const { postRemove } = fixture([], cfgWith());

    const refused = await postRemove({ instanceId: "foreign-vps", body: { confirmName: CONTAINER, containerId: CONTAINER_ID, containerName: CONTAINER } });

    expect(refused.status).toBe(404);
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes by instance id with the immutable container identity", async () => {
    const { postRemove } = fixture([], cfgWith());

    const removed = await postRemove({ instanceId: "alpha", body: { confirmName: CONTAINER, containerId: CONTAINER_ID, containerName: CONTAINER } });

    expect(removed.status).toBe(200);
    expect(remove).toHaveBeenCalledWith(
      { instanceId: "alpha", sshAlias: "alpha-vps", revision: expect.any(String) },
      [],
      { containerName: CONTAINER, containerId: CONTAINER_ID },
      CONTAINER,
    );
  });

  it("rejects an MCP instance and a missing container id", async () => {
    const { postRemove } = fixture([], cfgWith());

    expect((await postRemove({ instanceId: "boxed", body: { confirmName: CONTAINER, containerId: CONTAINER_ID, containerName: CONTAINER } })).status).toBe(404);
    expect((await postRemove({ instanceId: "alpha", body: { confirmName: CONTAINER, containerName: CONTAINER } })).status).toBe(400);
  });

  it("returns inventory sections for both SSH and MCP VPS instances", async () => {
    const { getVps } = fixture([], cfgWith());
    const res = await getVps();

    expect(res.status).toBe(200);
    expect(res.body.sections).toBeDefined();
    expect(res.body.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "alpha", name: "Alpha", kind: "ssh", sshAlias: "alpha-vps" }),
        expect.objectContaining({ id: "beta", name: "Beta", kind: "ssh", sshAlias: "production-vps" }),
        expect.objectContaining({ id: "boxed", name: "Boxed", kind: "mcp", mcpServer: "simular", boxId: "box-1", state: "ready" }),
      ]),
    );
  });
});
