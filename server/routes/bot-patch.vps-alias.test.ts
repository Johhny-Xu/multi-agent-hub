// The legacy vpsAlias branch scans SSH asynchronously; these tests change the store or the VPS lifecycle mid-scan and
// require the branch to re-read the bot and re-check busy/lifecycle before it acts on the inventory.
import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WireBot } from "../../shared/wire.ts";
import { VPS_BOT_ALIAS_CHANGE_ERROR, VPS_BOT_ALIAS_LIFECYCLE_ERROR, VPS_BOT_ALIAS_RESOURCES_ERROR } from "../cloud-backend.ts";
import { DATA_DIR, LEGACY_VPS_ALIAS_ERROR, type AppConfig } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store, type BotRecord } from "../store.ts";
import * as vps from "../vps-computer.ts";
import type { ManagedVpsInventory } from "../vps-computer.ts";
import { createBotPatchRoutes, type BotPatchRouteDeps } from "./bot-patch.ts";
import { PASS, type RouteContext } from "./table.ts";

vi.mock("../vps-computer.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../vps-computer.ts")>();
  return { ...actual, listManagedVpsComputers: vi.fn(), vpsLifecycleBusy: vi.fn() };
});

const scan = vi.mocked(vps.listManagedVpsComputers);
const lifecycleBusy = vi.mocked(vps.vpsLifecycleBusy);
const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };

const emptyInventory = (): ManagedVpsInventory => ({
  configured: true,
  available: true,
  vpsAliases: ["production-vps"],
  vpsInstanceIds: ["production-vps"],
  problem: null,
  instances: [],
});

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  scan.mockReset();
  scan.mockResolvedValue(emptyInventory());
  lifecycleBusy.mockReset();
  lifecycleBusy.mockReturnValue(false);
});

function fixture(version?: number) {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" });
  const cfg = {
    vps: {
      ...(version === undefined ? {} : { version }),
      sshAlias: "production-vps",
    },
  } as AppConfig;
  const activeVpsThreads = new Set<string>();
  const privateThreads = new Set<string>();
  const deps = {
    store,
    cfg,
    requestedTaskBot: () => null,
    activeVpsThreads,
    wireBot: (record: BotRecord) => record as unknown as WireBot,
    broadcast: () => {},
    audienceChanged: () => {},
    assertTeamComputerChangeIdle: () => {},
    routines: () => null,
    levelOf: () => "chat",
    mainThreadTasks: (botId: string) => store.tasks(botId).filter((task) => !privateThreads.has(task.threadId)),
  } as unknown as BotPatchRouteDeps;
  const handler = createBotPatchRoutes(deps);
  const patch = async (body: Record<string, unknown>) => {
    const sent: Array<{ status: number; body: any }> = [];
    const out = await handler({
      req: { headers: {} } as unknown as IncomingMessage,
      res: {} as ServerResponse,
      url: new URL(`http://localhost/api/bots/${bot.id}`),
      path: `/api/bots/${bot.id}`,
      method: "PATCH",
      auth: { kind: "loopback", scopes: ["admin"] } as RequestAuth,
      json: ((_res: ServerResponse, status: number, response: unknown) => {
        sent.push({ status, body: response });
      }) as RouteContext["json"],
      readBody: (async () => body) as RouteContext["readBody"],
    });
    expect(out).not.toBe(PASS);
    expect(sent).toHaveLength(1);
    return sent[0]!;
  };
  return { store, bot, cfg, activeVpsThreads, patch };
}

describe("PATCH /api/bots/:id with the legacy vpsAlias", () => {
  it("moves the bot when the scanned state held still", async () => {
    const { store, bot, patch } = fixture();

    const moved = await patch({ vpsAlias: "gamma-vps" });

    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(store.bot(bot.id)?.vpsAlias).toBe("gamma-vps");
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan.mock.calls[0]?.[0]).toEqual([{ instanceId: "production-vps", sshAlias: "production-vps", revision: "" }]);
    expect(scan.mock.calls[0]?.[1]).toEqual([{ botId: bot.id, name: "Scout", inUse: false }]);
  });

  it("refuses when a turn started during the scan, instead of moving a busy bot", async () => {
    const { store, bot, patch } = fixture();
    scan.mockImplementationOnce(async () => {
      store.patchBot(bot.id, { busy: true });
      return emptyInventory();
    });

    const refused = await patch({ vpsAlias: "gamma-vps" });

    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(VPS_BOT_ALIAS_CHANGE_ERROR);
    expect(store.bot(bot.id)?.vpsAlias).toBeUndefined();
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("discards an inventory taken before another PATCH changed the alias, and scans again", async () => {
    const { store, bot, patch } = fixture();
    scan.mockImplementationOnce(async () => {
      store.patchBot(bot.id, { vpsAlias: "delta-vps" });
      return { ...emptyInventory(), instances: [{ name: vps.vpsContainerName(bot.id) }] } as ManagedVpsInventory;
    });

    const moved = await patch({ vpsAlias: "gamma-vps" });

    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.error).toBeUndefined();
    expect(scan).toHaveBeenCalledTimes(2);
    expect(store.bot(bot.id)?.vpsAlias).toBe("gamma-vps");
  });

  it("refuses when the VPS lifecycle became busy during the scan", async () => {
    const { store, bot, patch } = fixture();
    scan.mockImplementationOnce(async () => {
      lifecycleBusy.mockReturnValue(true);
      return emptyInventory();
    });

    const refused = await patch({ vpsAlias: "gamma-vps" });

    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(VPS_BOT_ALIAS_LIFECYCLE_ERROR);
    expect(store.bot(bot.id)?.vpsAlias).toBeUndefined();
  });

  it("re-scans when the bot's name changed, instead of judging remote resources by the old name", async () => {
    const { store, bot, patch } = fixture();
    scan.mockImplementationOnce(async () => {
      store.patchBot(bot.id, { name: "Renamed" });
      return { ...emptyInventory(), instances: [{ name: vps.vpsContainerName(bot.id) }] } as ManagedVpsInventory;
    });

    const moved = await patch({ vpsAlias: "gamma-vps" });

    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(store.bot(bot.id)?.vpsAlias).toBe("gamma-vps");
  });

  it("keeps the former alias available for cleanup when its host could not be reached", async () => {
    const { store, bot, patch } = fixture();
    scan.mockResolvedValue({
      ...emptyInventory(),
      available: false,
      problem: "Docker over SSH could not list managed computers on production-vps: ssh: Could not resolve hostname production-vps",
    });

    const moved = await patch({ vpsAlias: "gamma-vps" });

    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.notice).toContain("production-vps could not be reached");
    expect(moved.body.notice).toContain(`docker -H ssh://production-vps rm -f ${vps.vpsContainerName(bot.id)}`);
    expect(store.bot(bot.id)?.vpsAlias).toBe("gamma-vps");
  });

  it("refuses to move onto a host that already holds this bot's container", async () => {
    const { store, bot, patch } = fixture();
    scan.mockResolvedValue({ ...emptyInventory(), instances: [{ name: vps.vpsContainerName(bot.id) }] as ManagedVpsInventory["instances"] });

    const refused = await patch({ vpsAlias: "gamma-vps" });

    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(VPS_BOT_ALIAS_RESOURCES_ERROR);
    expect(store.bot(bot.id)?.vpsAlias).toBeUndefined();
  });

  it("never enters the legacy branch on a v2 config", async () => {
    const { patch } = fixture(2);

    const refused = await patch({ vpsAlias: "gamma-vps" });

    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe(LEGACY_VPS_ALIAS_ERROR);
    expect(scan).not.toHaveBeenCalled();
  });
});
