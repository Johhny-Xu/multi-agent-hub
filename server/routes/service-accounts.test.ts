import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { InstanceConfig } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import { createServiceAccountRoutes, type ServiceAccountRouteDeps } from "./service-accounts.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function serve(extraInstances?: (base: string) => Record<string, InstanceConfig>, autoSwitch?: ServiceAccountRouteDeps["autoSwitch"]) {
  const base = mkdtempSync(join(tmpdir(), "omb-service-account-routes-"));
  roots.push(base);
  const home = join(base, "home");
  const data = join(base, "data");
  mkdirSync(join(home, ".codebuddy"), { recursive: true });
  writeFileSync(join(home, ".codebuddy", "auth.info"), JSON.stringify({ account: { nickname: "Ada" } }));
  const instances: Record<string, InstanceConfig> = {
    codebuddy: { driver: "codebuddyAgent", environment: { HOME: home } },
    claude: { driver: "claudeAgent", environment: { HOME: home } },
    ...extraInstances?.(base),
  };
  const flags = { busy: false, readOnly: false, refreshed: 0, reclaimed: [] as string[] };
  const routes = [createServiceAccountRoutes({
    instance: (instanceId) => instances[instanceId],
    busy: () => flags.busy,
    readOnly: () => flags.readOnly,
    refresh: () => { flags.refreshed += 1; },
    reclaim: (instanceId) => { flags.reclaimed.push(instanceId); },
    ...(autoSwitch ? { autoSwitch } : {}),
    root: data,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    await dispatchRoutes(routes, {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes: ["admin"] }, json, readBody,
    });
    if (!res.writableEnded) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, contentType = "application/json") => {
    const response = await fetch(`${origin}${path}`, {
      method, headers: { "content-type": contentType }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { call, flags, base };
}

describe("the account routes", () => {
  it("lists, saves and switches, and refuses while a task runs or the workspace owns the settings", async () => {
    const { call, flags, base } = await serve();
    expect((await call("GET", "/api/instances/nope/service-accounts")).status).toBe(404);
    expect((await call("GET", "/api/instances/claude/service-accounts")).body.accounts)
      .toMatchObject({ supported: false, reason: expect.stringContaining("separate accounts") });

    const listed = await call("GET", "/api/instances/codebuddy/service-accounts");
    expect(listed.status).toBe(200);
    expect(listed.body.accounts).toMatchObject({ supported: true, liveIdentity: "Ada", accounts: [] });

    expect((await call("POST", "/api/instances/codebuddy/service-accounts", {}, "text/plain")).status).toBe(415);
    flags.busy = true;
    expect((await call("POST", "/api/instances/codebuddy/service-accounts", { label: "Work" })).status).toBe(409);
    flags.busy = false;
    flags.readOnly = true;
    expect((await call("POST", "/api/instances/codebuddy/service-accounts", { label: "Work" })).status).toBe(403);
    flags.readOnly = false;

    const saved = await call("POST", "/api/instances/codebuddy/service-accounts", { label: "Work" });
    expect(saved.status).toBe(200);
    expect(saved.body.accounts.accounts).toHaveLength(1);
    expect(flags.reclaimed).toEqual([]);
    const id = saved.body.accounts.activeId as string;

    writeFileSync(join(base, "home", ".codebuddy", "auth.info"), JSON.stringify({ account: { nickname: "Bob" } }));
    const second = await call("POST", "/api/instances/codebuddy/service-accounts", { label: "Personal" });
    expect(second.body.accounts.accounts).toHaveLength(2);

    const switched = await call("POST", `/api/instances/codebuddy/service-accounts/${id}/switch`, {});
    expect(switched.status).toBe(200);
    expect(switched.body.accounts.activeId).toBe(id);
    expect(switched.body.accounts.liveIdentity).toBe("Ada");
    expect(flags.reclaimed).toEqual(["codebuddy"]);
    expect(flags.refreshed).toBe(1);

    // Already the active account: nothing changed on disk, so no process is retired.
    expect((await call("POST", `/api/instances/codebuddy/service-accounts/${id}/switch`, {})).status).toBe(200);
    expect(flags.reclaimed).toEqual(["codebuddy"]);
    expect(flags.refreshed).toBe(1);

    expect((await call("DELETE", `/api/instances/codebuddy/service-accounts/${id}`)).status).toBe(409);
    expect((await call("DELETE", `/api/instances/codebuddy/service-accounts/${"0".repeat(36)}`)).status).toBe(404);
  });

  // scripts/import-mah-accounts.ts 把老 mah 档案按 WORKER_SPECS 的 instanceId 落盘：
  // traecode/、mimocode/ 两个目录 + index.json。fleet 注册前这两个引擎报 Unknown engine，
  // 注册后这里验收两类快照都能列出、能切换（与 ~/.openmausbot/service-accounts 的真实结构同构）。
  it("lists the migrated traecode and mimocode snapshots and switches between them", async () => {
    const traeJwt = `h.${Buffer.from(JSON.stringify({ data: { id: "2891045460773080" }, exp: Math.floor(Date.now() / 1000) + 86400 })).toString("base64url")}.s`;
    const uidAccount = randomUUID();
    const brokenAccount = randomUUID();
    const mimoAccount = randomUUID();
    const { call, base } = await serve((root) => ({
      traecode: { driver: "traecodeAgent", environment: { HOME: join(root, "home") } },
      mimocode: { driver: "mimocodeAgent", environment: { HOME: join(root, "home") } },
    }));
    mkdirSync(join(base, "data", "traecode", uidAccount), { recursive: true });
    mkdirSync(join(base, "data", "traecode", brokenAccount), { recursive: true });
    mkdirSync(join(base, "data", "mimocode", mimoAccount), { recursive: true });
    writeFileSync(join(base, "data", "traecode", uidAccount, "token"), traeJwt);
    writeFileSync(join(base, "data", "traecode", brokenAccount, "token"), "0432-4398\n");
    writeFileSync(join(base, "data", "traecode", "index.json"), JSON.stringify({
      version: 1, activeId: uidAccount,
      accounts: [
        { id: uidAccount, label: "UID:2891045460773080", identity: "2891045460773080", createdAt: 1794051192873, hashes: { token: "a".repeat(64) } },
        { id: brokenAccount, label: "trae-98ae5c", identity: "98ae5cf8bc37", createdAt: 1792429280085, hashes: { token: "b".repeat(64) } },
      ],
    }));
    writeFileSync(join(base, "data", "mimocode", mimoAccount, "auth"), JSON.stringify({ uid: "2297352705" }));
    writeFileSync(join(base, "data", "mimocode", "index.json"), JSON.stringify({
      version: 1, activeId: mimoAccount,
      accounts: [
        { id: mimoAccount, label: "小米 UID:2297352705", identity: "2297352705", createdAt: 1791774159799, hashes: { auth: "c".repeat(64) } },
      ],
    }));

    const trae = await call("GET", "/api/instances/traecode/service-accounts");
    expect(trae.status).toBe(200);
    expect(trae.body.accounts).toMatchObject({ supported: true, activeId: uidAccount });
    expect(trae.body.accounts.accounts).toHaveLength(2);
    expect(trae.body.accounts.accounts.map((a: { label: string }) => a.label))
      .toEqual(["UID:2891045460773080", "trae-98ae5c"]);

    const mimo = await call("GET", "/api/instances/mimocode/service-accounts");
    expect(mimo.status).toBe(200);
    expect(mimo.body.accounts.accounts).toMatchObject([
      { id: mimoAccount, label: "小米 UID:2297352705", identity: "2297352705" },
    ]);

    const toBroken = await call("POST", `/api/instances/traecode/service-accounts/${brokenAccount}/switch`, {});
    expect(toBroken.status).toBe(200);
    expect(toBroken.body.accounts.activeId).toBe(brokenAccount);
    expect(readFileSync(join(base, "home", ".trae-cn", "trae-jwt-token"), "utf8")).toBe("0432-4398\n");

    const back = await call("POST", `/api/instances/traecode/service-accounts/${uidAccount}/switch`, {});
    expect(back.status).toBe(200);
    expect(back.body.accounts.activeId).toBe(uidAccount);
    expect(back.body.accounts.liveIdentity).toBe("UID:2891045460773080");
    expect(readFileSync(join(base, "home", ".trae-cn", "trae-jwt-token"), "utf8")).toBe(traeJwt);

    const mimoSwitch = await call("POST", `/api/instances/mimocode/service-accounts/${mimoAccount}/switch`, {});
    expect(mimoSwitch.status).toBe(200);
    expect(mimoSwitch.body.accounts.activeId).toBe(mimoAccount);
    expect(JSON.parse(readFileSync(join(base, "home", ".local", "share", "mimocode", "auth.json"), "utf8")))
      .toMatchObject({ uid: "2297352705" });
  });
});

function fakeAutoSwitch() {
  const enabled: Record<string, boolean> = {};
  return {
    enabled: (id: string) => enabled[id] === true,
    setEnabled: (id: string, on: boolean) => { enabled[id] = on; },
    status: (id: string) => ({ enabled: enabled[id] === true, limited: [] as Array<{ accountId: string; until: number }> }),
  };
}

describe("the auto-switch route", () => {
  it("reports auto-switch off by default, and unavailable when the host does not wire it", async () => {
    const unwired = await serve();
    const missing = await unwired.call("GET", "/api/instances/codebuddy/service-accounts/auto-switch");
    expect(missing.status).toBe(200);
    expect(missing.body.autoSwitch).toEqual({ enabled: false, limited: [], available: false });

    const wired = await serve(undefined, fakeAutoSwitch());
    const status = await wired.call("GET", "/api/instances/codebuddy/service-accounts/auto-switch");
    expect(status.status).toBe(200);
    expect(status.body.autoSwitch).toEqual({ enabled: false, limited: [] });
  });

  it("turns auto-switch on with PUT and reads the new state back", async () => {
    const { call } = await serve(undefined, fakeAutoSwitch());
    const put = await call("PUT", "/api/instances/codebuddy/service-accounts/auto-switch", { enabled: true });
    expect(put.status).toBe(200);
    expect(put.body.autoSwitch).toEqual({ enabled: true, limited: [] });
    expect((await call("GET", "/api/instances/codebuddy/service-accounts/auto-switch")).body.autoSwitch.enabled).toBe(true);
    expect((await call("PUT", "/api/instances/codebuddy/service-accounts/auto-switch", { enabled: false })).body.autoSwitch.enabled).toBe(false);
  });

  it("refuses a PUT whose enabled is not a boolean", async () => {
    const { call } = await serve(undefined, fakeAutoSwitch());
    expect((await call("PUT", "/api/instances/codebuddy/service-accounts/auto-switch", { enabled: "yes" })).status).toBe(400);
    expect((await call("PUT", "/api/instances/codebuddy/service-accounts/auto-switch", {})).status).toBe(400);
  });

  it("guards the PUT like the other writes: unknown engine, content type and the read-only workspace", async () => {
    const { call, flags } = await serve(undefined, fakeAutoSwitch());
    expect((await call("PUT", "/api/instances/nope/service-accounts/auto-switch", { enabled: true })).status).toBe(404);
    expect((await call("PUT", "/api/instances/codebuddy/service-accounts/auto-switch", { enabled: true }, "text/plain")).status).toBe(415);
    flags.readOnly = true;
    expect((await call("PUT", "/api/instances/codebuddy/service-accounts/auto-switch", { enabled: true })).status).toBe(403);
    flags.readOnly = false;
    expect((await call("PUT", "/api/instances/codebuddy/service-accounts/auto-switch", { enabled: true })).status).toBe(200);
  });
});
