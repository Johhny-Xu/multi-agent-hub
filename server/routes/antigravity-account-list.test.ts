// The merged account list's wiring: the GET any Antigravity card reads, and the switch endpoint's refusals.
// The switch's file-copying behavior itself is covered in ../antigravity-accounts.test.ts; these cases never
// touch a real sign-in file.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { AntigravityAccountsView } from "../antigravity-accounts.ts";
import { json, readBody } from "../harness/http.ts";
import { createAntigravityAccountListRoutes, type AntigravityAccountListDeps } from "./antigravity-account-list.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const added = "antigravity-2f1c9a44-0000-4000-8000-000000000001";

async function serve(deps: Partial<AntigravityAccountListDeps> = {}): Promise<string> {
  const routes = [createAntigravityAccountListRoutes({
    instances: () => ({
      antigravity: { driver: "antigravityAgent", displayName: "Google Gemini" },
      [added]: { driver: "antigravityAgent", displayName: "Work" },
    }),
    persist: async () => {},
    refresh: () => {},
    reclaim: () => {},
    exclusive: (work) => work(),
    ...deps,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes: ["admin"] }, json, readBody,
    });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (url: string, body: string, contentType = "application/json") =>
  fetch(url, { method: "POST", headers: { "content-type": contentType }, body });

describe("Antigravity account list routes", () => {
  it("list every Antigravity account, primary first, without credentials", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/instances/antigravity-accounts`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { accounts: view } = (await response.json()) as { accounts: AntigravityAccountsView };
    expect(view.primaryId).toBe("antigravity");
    expect(view.accounts.map((account: { instanceId: string }) => account.instanceId)).toEqual(["antigravity", added]);
    expect(view.accounts.map((account: { removable: boolean }) => account.removable)).toEqual([false, true]);
    // This box has no Antigravity sign-in: the list still works, just without emails.
    expect(view.accounts.every((account: { email?: string }) => account.email === undefined)).toBe(true);
    expect(JSON.stringify(view.accounts)).not.toContain("refresh_token");
  });

  it("switch only on a JSON POST of a known account", async () => {
    const base = await serve();
    expect((await post(`${base}/api/instances/antigravity-account-switch`, "{}", "text/plain")).status).toBe(415);
    expect((await post(`${base}/api/instances/antigravity-account-switch`, "{}")).status).toBe(400);
    expect((await post(`${base}/api/instances/antigravity-account-switch`, JSON.stringify({ accountInstanceId: "antigravity-nope" }))).status).toBe(404);
  });

  it("refuses to switch to an account that is not signed in", async () => {
    let refreshed = 0;
    const base = await serve({ refresh: () => { refreshed++; } });
    const response = await post(`${base}/api/instances/antigravity-account-switch`, JSON.stringify({ accountInstanceId: added }));
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toMatch(/not signed in/u);
    expect(refreshed).toBe(0);
  });

  it("stays away while another provider-settings change is running", async () => {
    const base = await serve({ exclusive: () => null });
    const response = await post(`${base}/api/instances/antigravity-account-switch`, JSON.stringify({ accountInstanceId: added }));
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toMatch(/already being updated/u);
  });
});
