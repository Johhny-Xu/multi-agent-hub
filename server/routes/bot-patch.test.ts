// The relocation guard's scan is the only VPS call this route makes; the mocked scan stands in for SSH
// and lets each test mutate the store mid-scan deterministically.
import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WireBot } from "../../shared/wire.ts";
import { VPS_BOT_ALIAS_CHANGE_ERROR } from "../cloud-backend.ts";
import { DATA_DIR, type AppConfig } from "../config.ts";
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
  vpsInstanceIds: ["alpha"],
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

function fixture() {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" });
  const cfg = {
    vps: {
      version: 2,
      instances: [
        { id: "alpha", name: "Alpha", kind: "ssh", sshAlias: "production-vps" },
        { id: "gamma", name: "Gamma", kind: "ssh", sshAlias: "gamma-vps" },
        { id: "delta", name: "Delta", kind: "ssh", sshAlias: "delta-vps" },
      ],
    },
  } as AppConfig;
  const activeVpsThreads = new Set<string>();
  const privateThreads = new Set<string>();
  // Only what a vpsAlias patch touches; any other dependency is absent, and a route that reached for one would throw.
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
    // A member's session may chat with this bot: the level that still can't move it or change what it may do.
    levelOf: () => "chat",
    mainThreadTasks: (botId: string) => store.tasks(botId).filter((task) => !privateThreads.has(task.threadId)),
  } as unknown as BotPatchRouteDeps;
  const handler = createBotPatchRoutes(deps);
  const patch = async (botId: string, body: Record<string, unknown>, as: { auth?: RequestAuth; headers?: Record<string, string> } = {}) => {
    const sent: Array<{ status: number; body: any }> = [];
    const out = await handler({
      req: { headers: as.headers ?? {} } as unknown as IncomingMessage,
      res: {} as ServerResponse,
      url: new URL(`http://localhost/api/bots/${botId}`),
      path: `/api/bots/${botId}`,
      method: "PATCH",
      auth: as.auth ?? ({ kind: "loopback", scopes: ["admin"] } as RequestAuth),
      json: ((_res: ServerResponse, status: number, response: unknown) => {
        sent.push({ status, body: response });
      }) as RouteContext["json"],
      readBody: (async () => body) as RouteContext["readBody"],
    });
    expect(out).not.toBe(PASS);
    expect(sent).toHaveLength(1);
    return sent[0]!;
  };
  return { store, bot, activeVpsThreads, privateThreads, patch };
}

describe("PATCH /api/bots/:id VPS instance selection", () => {
  const targetOf = (id: string, sshAlias: string) => ({ instanceId: id, sshAlias, revision: expect.any(String) });

  it("updates backend and instance in one validated patch", async () => {
    const { store, bot, patch } = fixture();
    store.patchBot(bot.id, { cloudBackend: "vps", vpsInstanceId: "alpha" });
    scan.mockClear();

    const moved = await patch(bot.id, { cloudBackend: "vps", vpsInstanceId: "gamma" });

    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.bot.cloudBackend).toBe("vps");
    expect(moved.body.bot.vpsInstanceId).toBe("gamma");
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan.mock.calls[0]?.[0]).toEqual([targetOf("alpha", "production-vps")]);
  });

  it("rechecks the target after asynchronous inventory", async () => {
    const { store, bot, patch } = fixture();
    store.patchBot(bot.id, { vpsInstanceId: "alpha" });
    scan.mockImplementationOnce(async () => {
      store.patchBot(bot.id, { vpsInstanceId: "delta" });
      return emptyInventory();
    });

    const moved = await patch(bot.id, { vpsInstanceId: "gamma" });

    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(store.bot(bot.id)?.vpsInstanceId).toBe("gamma");
  });

  it("blocks instance switching during an active turn", async () => {
    const { store, bot, patch } = fixture();
    store.patchBot(bot.id, { vpsInstanceId: "alpha", busy: true });

    const refused = await patch(bot.id, { vpsInstanceId: "gamma" });

    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(VPS_BOT_ALIAS_CHANGE_ERROR);
    expect(scan).not.toHaveBeenCalled();
  });

  it("keeps an unreachable former instance available for cleanup", async () => {
    const { store, bot, patch } = fixture();
    store.patchBot(bot.id, { vpsInstanceId: "alpha" });
    scan.mockResolvedValue({
      ...emptyInventory(),
      available: false,
      problem: "Docker over SSH could not list managed computers on production-vps: ssh: Could not resolve hostname production-vps",
    });

    const moved = await patch(bot.id, { vpsInstanceId: "gamma" });

    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(store.bot(bot.id)?.vpsInstanceId).toBe("gamma");
    expect(moved.body.notice).toContain("production-vps could not be reached");
    expect(moved.body.notice).toContain(`docker -H ssh://production-vps rm -f ${vps.vpsContainerName(bot.id)}`);
  });

  it("never lets a member or a paired phone choose a bot's computer", async () => {
    const { store, bot, patch } = fixture();
    const member = { kind: "session", via: "bearer", scopes: ["client"], session: { id: "s", label: "Laptop", scopes: ["client"] } } as unknown as RequestAuth;

    const fromMember = await patch(bot.id, { vpsInstanceId: "gamma" }, { auth: member });
    const fromPhone = await patch(bot.id, { vpsInstanceId: "gamma" }, { headers: { "x-openmausbot-companion": "1" } });

    expect(fromMember.status).toBe(403);
    expect(fromPhone.status).toBe(403);
    expect(scan).not.toHaveBeenCalled();
    expect(store.bot(bot.id)?.vpsInstanceId).toBeUndefined();
  });

  it("rejects the legacy alias and an unknown instance", async () => {
    const { bot, patch } = fixture();

    expect((await patch(bot.id, { vpsAlias: "gamma-vps" })).status).toBe(400);
    const unknown = await patch(bot.id, { vpsInstanceId: "missing" });

    expect(unknown.status).toBe(400);
    expect(scan).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/bots/:id phoneApps", () => {
  it("stores phoneApps and clears it with null", async () => {
    const { store, bot, patch } = fixture();

    const stored = await patch(bot.id, { phoneApps: { calendar: "read", location: "write" } });

    expect(stored.status).toBe(200);
    expect(store.bot(bot.id)?.phoneApps).toEqual({ calendar: "read", location: "write" });

    const cleared = await patch(bot.id, { phoneApps: null });

    expect(cleared.status).toBe(200);
    expect(store.bot(bot.id)?.phoneApps).toBeUndefined();
  });

  it("rejects an unknown capability or grant", async () => {
    const { store, bot, patch } = fixture();
    const error = "phoneApps must be { <calendar|reminders|contacts|location|home|messages>: read | write } or null";

    const unknownApp = await patch(bot.id, { phoneApps: { camera: "read" } });
    const unknownGrant = await patch(bot.id, { phoneApps: { calendar: "admin" } });

    expect(unknownApp.status).toBe(400);
    expect(unknownApp.body.error).toBe(error);
    expect(unknownGrant.status).toBe(400);
    expect(unknownGrant.body.error).toBe(error);
    expect(store.bot(bot.id)?.phoneApps).toBeUndefined();
  });

  it("treats a raised phone grant as loosening", async () => {
    const { store, bot, patch } = fixture();
    store.patchBot(bot.id, { phoneApps: { calendar: "read" } });
    store.patchBot(bot.id, { busy: true });

    const raised = await patch(bot.id, { phoneApps: { calendar: "write" } });
    const added = await patch(bot.id, { phoneApps: { calendar: "read", contacts: "read" } });

    expect(raised.status).toBe(409);
    expect(added.status).toBe(409);
    expect(store.bot(bot.id)?.phoneApps).toEqual({ calendar: "read" });

    const narrowed = await patch(bot.id, { phoneApps: {} });

    expect(narrowed.status).toBe(200);
  });

  it("treats clearing a narrower grant as loosening on any bot, since the default is every app", async () => {
    const { store, bot, patch } = fixture();
    store.patchBot(bot.id, { phoneApps: { calendar: "read" } });
    store.patchBot(bot.id, { busy: true });

    const cleared = await patch(bot.id, { phoneApps: null });
    store.patchBot(bot.id, { chiefOfStaff: true });
    const clearedOnChief = await patch(bot.id, { phoneApps: null });

    expect(cleared.status).toBe(409);
    expect(clearedOnChief.status).toBe(409);
    expect(store.bot(bot.id)?.phoneApps).toEqual({ calendar: "read" });
  });

  it("treats switching every app off from the default as tightening", async () => {
    const { store, bot, patch } = fixture();
    store.patchBot(bot.id, { busy: true });

    const off = await patch(bot.id, { phoneApps: {} });

    expect(off.status).toBe(200);
    expect(store.bot(bot.id)?.phoneApps).toEqual({});
  });

  it("refuses an archived conversation, which the main-thread resolver skips", async () => {
    const { store, bot, patch } = fixture();
    const archived = store.createTask(bot.id, "Done", false)!;
    store.patchTask(bot.id, archived.threadId, { archivedAt: Date.now() });
    expect((await patch(bot.id, { mainThreadChoice: archived.threadId })).status).toBe(400);
    expect(store.bot(bot.id)?.mainThreadChoice).toBeUndefined();
  });

  it("refuses a client session and a paired device", async () => {
    const { store, bot, patch } = fixture();

    const client = await patch(bot.id, { phoneApps: { calendar: "write" } }, { auth: { kind: "session", via: "bearer", scopes: ["client"], session: { id: "s-member", email: "member@example.com", label: "Front desk" } } as unknown as RequestAuth });
    const paired = await patch(bot.id, { phoneApps: { calendar: "write" } }, { headers: { "x-openmausbot-companion": "1" } });

    expect(client.status).toBe(403);
    expect(paired.status).toBe(403);
    expect(store.bot(bot.id)?.phoneApps).toBeUndefined();
  });
});

describe("PATCH /api/bots/:id mainThreadChoice", () => {
  it("stores the conversation the person chose, clears it with null, and refuses a routine run or another bot's thread", async () => {
    const { store, bot, patch } = fixture();
    const chosen = store.createTask(bot.id, "Chosen", false)!;
    const run = store.createTask(bot.id, "Run", false)!;
    store.patchTask(bot.id, run.threadId, { routineRunId: "run-1" });
    const other = store.createBot({ name: "Other" });

    expect((await patch(bot.id, { mainThreadChoice: chosen.threadId })).status).toBe(200);
    expect(store.bot(bot.id)?.mainThreadChoice).toBe(chosen.threadId);

    for (const refused of [run.threadId, other.threadId, "missing", 7]) {
      expect((await patch(bot.id, { mainThreadChoice: refused })).status).toBe(400);
    }
    expect(store.bot(bot.id)?.mainThreadChoice).toBe(chosen.threadId);

    expect((await patch(bot.id, { mainThreadChoice: null })).status).toBe(200);
    expect(store.bot(bot.id)?.mainThreadChoice).toBeUndefined();
  });

  it("refuses a conversation the main-thread resolver can't pick, the same way as an unknown id", async () => {
    const { store, bot, patch, privateThreads } = fixture();
    const hidden = store.createTask(bot.id, "Private", false)!;
    privateThreads.add(hidden.threadId);
    const refused = await patch(bot.id, { mainThreadChoice: hidden.threadId });
    const unknown = await patch(bot.id, { mainThreadChoice: "missing" });
    expect(refused).toEqual(unknown);
    expect(refused.status).toBe(400);
    expect(store.bot(bot.id)?.mainThreadChoice).toBeUndefined();
  });

  it("refuses a client session and a paired device", async () => {
    const { store, bot, patch } = fixture();
    const client = await patch(bot.id, { mainThreadChoice: bot.threadId }, { auth: { kind: "session", via: "bearer", scopes: ["client"], session: { id: "s-member", email: "member@example.com", label: "Front desk" } } as unknown as RequestAuth });
    const paired = await patch(bot.id, { mainThreadChoice: bot.threadId }, { headers: { "x-openmausbot-companion": "1" } });
    expect(client.status).toBe(403);
    expect(paired.status).toBe(403);
    expect(store.bot(bot.id)?.mainThreadChoice).toBeUndefined();
  });

  describe("hidden and archive audit", () => {
    it("distinguishes deleted bots from missing bots with distinguishable 404 responses", async () => {
      const { store, patch } = fixture();
      const doomed = store.createBot({ name: "Doomed" });
      store.deleteBot(doomed.id);

      const deletedRes = await patch(doomed.id, { name: "New Name" });
      expect(deletedRes.status).toBe(404);
      expect(deletedRes.body).toEqual({ error: "The addressed agent was deleted", status: "deleted" });

      const missingRes = await patch("completely-non-existent", { name: "New Name" });
      expect(missingRes.status).toBe(404);
      expect(missingRes.body).toEqual({ error: "no such bot", status: "missing" });
    });

    it("validates hidden as boolean and refuses hiding Chief of Staff", async () => {
      const { store, bot, patch } = fixture();
      const badType = await patch(bot.id, { hidden: "yes" });
      expect(badType.status).toBe(400);
      expect(badType.body).toEqual({ error: "hidden must be true or false" });

      store.setChiefOfStaff(bot.id);
      const hideChief = await patch(bot.id, { hidden: true });
      expect(hideChief.status).toBe(400);
      expect(hideChief.body).toEqual({ error: "choose another Chief of Staff before hiding this bot" });

      // No audit written for rejected requests
      expect(store.getArchiveAudits(bot.id)).toHaveLength(0);
    });

    it("records audit with actor, entry, and request correlation on hidden transitions", async () => {
      const { store, bot, patch } = fixture();

      // 1. Archiving via loopback API (actor: unknown, requestId preserved)
      const archiveRes = await patch(bot.id, { hidden: true }, {
        headers: { "x-request-id": "trace-req-001" },
      });
      expect(archiveRes.status).toBe(200);
      expect(archiveRes.body.status).toBe("archived");
      expect(archiveRes.body.bot.hidden).toBe(true);

      const audits = store.getArchiveAudits(bot.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        botId: bot.id,
        previousHidden: false,
        nextHidden: true,
        entry: "api:bot-patch",
        actor: "unknown",
        request: {
          requestId: "trace-req-001",
          via: "loopback",
        },
      });

      // 2. Idempotent request: repeated hidden: true does NOT write audit
      const idempotentRes = await patch(bot.id, { hidden: true });
      expect(idempotentRes.status).toBe(200);
      expect(idempotentRes.body.status).toBe("archived");
      expect(store.getArchiveAudits(bot.id)).toHaveLength(1);

      // 3. Unarchiving via session auth (actor: session.email)
      const sessionAuth: RequestAuth = {
        kind: "session",
        via: "bearer",
        scopes: ["admin"],
        session: { id: "sess-99", email: "alice@example.org", label: "Alice Admin" },
      } as unknown as RequestAuth;

      const unarchiveRes = await patch(bot.id, { hidden: false }, {
        auth: sessionAuth,
        headers: { "x-request-id": "trace-req-002" },
      });
      expect(unarchiveRes.status).toBe(200);
      expect(unarchiveRes.body.status).toBe("active");
      expect(unarchiveRes.body.bot.hidden).toBe(false);

      const auditsAfter = store.getArchiveAudits(bot.id);
      expect(auditsAfter).toHaveLength(2);
      expect(auditsAfter[1]).toMatchObject({
        botId: bot.id,
        previousHidden: true,
        nextHidden: false,
        entry: "api:bot-patch",
        actor: "alice@example.org",
        request: {
          requestId: "trace-req-002",
          via: "bearer",
        },
      });

      // Check no secret tokens or credentials in audit logs
      const rawJson = JSON.stringify(auditsAfter);
      expect(rawJson).not.toMatch(/sk-|token|secret|password|bearer\s+\w+/i);
    });

    it("does not create audit records on unauthorized PATCH requests", async () => {
      const { store, bot, patch } = fixture();
      const forbiddenAuth: RequestAuth = {
        kind: "session",
        via: "bearer",
        scopes: ["client"],
        session: { id: "sess-guest", email: "guest@example.org", label: "Guest" },
      } as unknown as RequestAuth;

      const res = await patch(bot.id, { hidden: true }, { auth: forbiddenAuth });
      expect(res.status).toBe(403);
      expect(store.getArchiveAudits(bot.id)).toHaveLength(0);
    });
  });
});
