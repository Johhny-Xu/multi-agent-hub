// POST /api/bots takes a working folder at the top level as well as under settings. One choice, two spellings: the
// route fills settings.cwd from it, and refuses two different values instead of dropping one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BotRecord, Store } from "../store.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createBotCreateRoutes, type BotCreateRouteDeps } from "./bots-create.ts";

let folder = "";

beforeAll(() => { folder = mkdtempSync(join(tmpdir(), "omb-bots-create-")); });
afterAll(() => { rmSync(folder, { recursive: true, force: true }); });

type Answer = { status: number; body: any };

function fakeStore() {
  const bots: any[] = [];
  const store = {
    bots,
    sections: [] as string[],
    bot: (id: string) => bots.find((bot) => bot.id === id),
    botByThread: () => undefined,
    groupByThread: () => undefined,
    createBot: (profile: any, opts: any = {}) => {
      const bot = { id: opts.id ?? `bot-${bots.length + 1}`, threadId: `thread-${bots.length + 1}`, name: profile.name ?? "", ...profile };
      bots.unshift(bot);
      return bot;
    },
    patchBot: (id: string, patch: Record<string, unknown>) => {
      const bot = bots.find((row) => row.id === id);
      if (!bot) return null;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete bot[key];
        else bot[key] = value;
      }
      return bot;
    },
    deleteBot: (id: string) => {
      const at = bots.findIndex((bot) => bot.id === id);
      if (at < 0) return false;
      bots.splice(at, 1);
      return true;
    },
    messagesFor: () => [],
    activeLeaf: () => null,
    setChiefOfStaff: () => [],
  };
  return store;
}

function deps(store: ReturnType<typeof fakeStore>) {
  return {
    store: store as unknown as Store,
    cfg: { newBotDefaults: undefined, newBots: {} },
    presetStore: { resolve: () => null },
    orgInstallStatuses: () => new Map(),
    hostedWorkspace: false,
    hostedFullAccessRefusal: "",
    desktopManaged: false,
    maxWorkspaceBots: 50,
    paused: () => false,
    cloudOwnerKey: null,
    hostedModels: null,
    cloudRoutineAuthors: null,
    routines: () => null,
    storedAvatarExists: () => true,
    defaultSelection: async () => ({ instanceId: "personal", model: "claude-sonnet-5" }),
    checkedModelSelection: (raw: unknown) => ({ ok: true, selection: raw as never }),
    cloudOwnerSession: () => false,
    wireBot: (bot: BotRecord) => ({ ...bot }) as never,
  } as unknown as BotCreateRouteDeps;
}

async function post(store: ReturnType<typeof fakeStore>, body: unknown): Promise<Answer> {
  const answer: Answer = { status: 0, body: null };
  const handler = createBotCreateRoutes(deps(store));
  await handler({
    req: { headers: {} } as never,
    res: {} as never,
    url: new URL("http://localhost/api/bots"),
    path: "/api/bots",
    method: "POST",
    auth: { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth,
    json: ((_res: unknown, status: number, payload: unknown) => { answer.status = status; answer.body = payload; }) as never,
    readBody: async () => JSON.parse(JSON.stringify(body)),
  });
  return answer;
}

describe("POST /api/bots working folder", () => {
  it("uses top-level cwd when settings.cwd is absent", async () => {
    const store = fakeStore();
    const answer = await post(store, { name: "Sky", section: "General", cwd: folder });
    expect(answer.status).toBe(201);
    expect(answer.body.bot.cwd).toBe(folder);
    expect(store.bots[0]!.cwd).toBe(folder);
  });

  it("keeps settings.cwd when top-level cwd is absent", async () => {
    const store = fakeStore();
    const answer = await post(store, { name: "Sky", settings: { cwd: folder } });
    expect(answer.status).toBe(201);
    expect(answer.body.bot.cwd).toBe(folder);
    expect(store.bots[0]!.cwd).toBe(folder);
  });

  it("accepts identical top-level and settings cwd values", async () => {
    const store = fakeStore();
    const answer = await post(store, { name: "Sky", cwd: folder, settings: { cwd: folder } });
    expect(answer.status).toBe(201);
    expect(store.bots[0]!.cwd).toBe(folder);
  });

  it("returns 400 for conflicting cwd values", async () => {
    const store = fakeStore();
    const answer = await post(store, { name: "Sky", cwd: folder, settings: { cwd: tmpdir() } });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toContain("顶层 cwd 与 settings.cwd 不一致");
    expect(store.bots).toHaveLength(0);
  });

  it("treats settings.cwd null and a top-level string as a conflict", async () => {
    const store = fakeStore();
    const answer = await post(store, { name: "Sky", cwd: folder, settings: { cwd: null } });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toContain("顶层 cwd 与 settings.cwd 不一致");
    expect(store.bots).toHaveLength(0);
  });

  it("preserves the existing behavior when cwd is omitted", async () => {
    const store = fakeStore();
    const answer = await post(store, { name: "Sky" });
    expect(answer.status).toBe(201);
    expect(answer.body.bot.cwd).toBeUndefined();
    expect(store.bots[0]!.cwd).toBeUndefined();
  });
});
