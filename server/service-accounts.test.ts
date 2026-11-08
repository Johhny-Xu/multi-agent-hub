import { createCipheriv, createDecipheriv } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { InstanceConfig } from "./contracts.ts";
import {
  removeServiceAccount, saveServiceAccount, serviceAccountsView, switchServiceAccount,
} from "./service-accounts.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "omb-service-accounts-"));
  roots.push(base);
  const home = join(base, "home");
  const data = join(base, "data");
  mkdirSync(home, { recursive: true });
  return { base, home, data };
}

function codebuddy(home: string): InstanceConfig {
  return { driver: "codebuddyAgent", environment: { HOME: home } };
}

function authInfo(home: string, nickname: string, token: string): string {
  const path = join(home, ".codebuddy", "auth.info");
  mkdirSync(join(home, ".codebuddy"), { recursive: true });
  writeFileSync(path, JSON.stringify({ account: { nickname }, auth: { accessToken: token } }));
  return path;
}

function readAuth(home: string): { account: { nickname: string }; auth: { accessToken: string } } {
  return JSON.parse(readFileSync(join(home, ".codebuddy", "auth.info"), "utf8"));
}

describe("saved engine accounts", () => {
  it("reports a supported engine and its live sign-in without any token", () => {
    const { home, data } = fixture();
    authInfo(home, "Ada", "secret-a");
    const view = serviceAccountsView("codebuddy", codebuddy(home), data);
    expect(view).toMatchObject({ supported: true, activeId: null, drifted: false, liveIdentity: "Ada", accounts: [] });
    expect(JSON.stringify(view)).not.toContain("secret-a");
  });

  it("saves the current sign-in as an account, with 600 files and 700 folders", () => {
    const { home, data } = fixture();
    authInfo(home, "Ada", "secret-a");
    const view = saveServiceAccount("codebuddy", codebuddy(home), undefined, data);
    expect(view.accounts).toHaveLength(1);
    expect(view.accounts[0]).toMatchObject({ label: "Ada", identity: "Ada" });
    expect(view.activeId).toBe(view.accounts[0]!.id);
    const dir = join(data, "codebuddy");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "index.json")).mode & 0o777).toBe(0o600);
    const account = join(dir, view.activeId!);
    expect(statSync(account).mode & 0o777).toBe(0o700);
    expect(statSync(join(account, "auth")).mode & 0o777).toBe(0o600);
  });

  it("switches accounts, keeping the sign-in that was live and restoring the chosen one", () => {
    const { home, data } = fixture();
    authInfo(home, "Ada", "secret-a");
    const first = saveServiceAccount("codebuddy", codebuddy(home), "Work", data);

    authInfo(home, "Bob", "secret-b");
    expect(serviceAccountsView("codebuddy", codebuddy(home), data).drifted).toBe(true);
    const second = saveServiceAccount("codebuddy", codebuddy(home), "Personal", data);
    expect(second.accounts.map((account) => account.label)).toEqual(["Work", "Personal"]);

    switchServiceAccount("codebuddy", codebuddy(home), first.accounts[0]!.id, data);
    expect(readAuth(home)).toMatchObject({ account: { nickname: "Ada" }, auth: { accessToken: "secret-a" } });
    const afterFirst = serviceAccountsView("codebuddy", codebuddy(home), data);
    expect(afterFirst.activeId).toBe(first.accounts[0]!.id);
    expect(afterFirst.drifted).toBe(false);

    switchServiceAccount("codebuddy", codebuddy(home), second.accounts[1]!.id, data);
    expect(readAuth(home)).toMatchObject({ account: { nickname: "Bob" }, auth: { accessToken: "secret-b" } });
  });

  it("removes a saved account but never the one in use", () => {
    const { home, data } = fixture();
    authInfo(home, "Ada", "secret-a");
    const first = saveServiceAccount("codebuddy", codebuddy(home), "Work", data);
    authInfo(home, "Bob", "secret-b");
    const second = saveServiceAccount("codebuddy", codebuddy(home), "Personal", data);

    expect(() => removeServiceAccount("codebuddy", codebuddy(home), second.activeId!, data))
      .toThrowError(/Switch to another account/);
    const left = removeServiceAccount("codebuddy", codebuddy(home), first.accounts[0]!.id, data);
    expect(left.accounts.map((account) => account.label)).toEqual(["Personal"]);
  });

  it("refuses to save before the engine is signed in", () => {
    const { home, data } = fixture();
    expect(() => saveServiceAccount("codebuddy", codebuddy(home), "Work", data))
      .toThrowError(/Sign in to this engine first/);
  });

  it("explains why Claude and ChatGPT accounts are not listed here", () => {
    const { home, data } = fixture();
    expect(serviceAccountsView("claude", { driver: "claudeAgent", environment: { HOME: home } }, data))
      .toMatchObject({ supported: false, reason: expect.stringContaining("separate accounts") });
    expect(serviceAccountsView("chatgpt", { driver: "codex", environment: { HOME: home } }, data))
      .toMatchObject({ supported: false, reason: expect.stringContaining("separate accounts") });
  });
});

describe("engines with other layouts", () => {
  it("follows XDG_DATA_HOME for OpenCode and clears a stale copy on the other path", () => {
    const { home, data } = fixture();
    const xdg = join(home, "xdg");
    const primary = join(xdg, "opencode", "auth.json");
    const legacy = join(home, ".local", "share", "opencode", "auth.json");
    for (const path of [primary, legacy]) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify({ opencode: { type: "api", key: "secret" } }));
    }
    const instance: InstanceConfig = { driver: "opencodeGo", environment: { HOME: home, XDG_DATA_HOME: xdg } };
    const first = saveServiceAccount("opencode", instance, "One", data);
    writeFileSync(primary, JSON.stringify({ other: { type: "api", key: "other" } }));
    writeFileSync(legacy, JSON.stringify({ other: { type: "api", key: "other" } }));
    saveServiceAccount("opencode", instance, "Two", data);
    switchServiceAccount("opencode", instance, first.activeId!, data);
    expect(JSON.parse(readFileSync(primary, "utf8"))).toHaveProperty("opencode");
    expect(() => statSync(legacy)).toThrow();
  });

  it("snapshots MiniMax Code's auth folder without its lock files", () => {
    const { home, data } = fixture();
    const authDir = join(home, ".minimax", "auth", "prod", "cn", "mcode-public");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({ schemaVersion: 1, records: ["a"] }));
    writeFileSync(join(authDir, "auth.lock"), "");
    const instance: InstanceConfig = { driver: "mcodeAgent", environment: { HOME: home } };
    const first = saveServiceAccount("mcode", instance, "Work", data);
    const snapshot = join(data, "mcode", first.activeId!, "auth", "cn", "mcode-public");
    expect(readFileSync(join(snapshot, "auth.json"), "utf8")).toContain('"a"');
    expect(() => statSync(join(snapshot, "auth.lock"))).toThrow();

    writeFileSync(join(authDir, "auth.json"), JSON.stringify({ schemaVersion: 1, records: ["b"] }));
    saveServiceAccount("mcode", instance, "Other", data);
    switchServiceAccount("mcode", instance, first.activeId!, data);
    expect(readFileSync(join(authDir, "auth.json"), "utf8")).toContain('"a"');
  });

  it("reads a GitHub login from gh's hosts file and says the file is shared", () => {
    const { home, data } = fixture();
    const dir = join(home, ".config", "gh");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hosts.yml"), "github.com:\n    users:\n        octocat:\n            oauth_token: secret\n    user: octocat\n");
    const instance: InstanceConfig = { driver: "copilotAgent", environment: { HOME: home } };
    const view = saveServiceAccount("copilot", instance, undefined, data);
    expect(view).toMatchObject({ supported: true, note: "shared-gh", liveIdentity: "octocat" });
    expect(view.accounts[0]!.label).toBe("octocat");
    expect(JSON.stringify(view)).not.toContain("secret");
  });

  it("saves and switches Antigravity accounts from its OAuth token file", () => {
    const { home, data } = fixture();
    const tokenDir = join(home, ".gemini", "antigravity-cli");
    mkdirSync(tokenDir, { recursive: true });
    const payload = Buffer.from(JSON.stringify({ email: "ada@example.test" })).toString("base64");
    writeFileSync(join(tokenDir, "antigravity-oauth-token"), JSON.stringify({
      token: "secret-ada", id_token: `header.${payload}.sig`,
    }));
    const instance: InstanceConfig = { driver: "antigravityAgent", environment: { HOME: home } };
    const first = saveServiceAccount("antigravity", instance, undefined, data);
    expect(first).toMatchObject({ supported: true, liveIdentity: "ada@example.test" });
    expect(first.accounts[0]!.label).toBe("ada@example.test");

    const payloadBob = Buffer.from(JSON.stringify({ email: "bob@example.test" })).toString("base64");
    writeFileSync(join(tokenDir, "antigravity-oauth-token"), JSON.stringify({
      token: "secret-bob", id_token: `header.${payloadBob}.sig`,
    }));
    const second = saveServiceAccount("antigravity", instance, "Bob", data);
    expect(second.accounts).toHaveLength(2);

    switchServiceAccount("antigravity", instance, first.activeId!, data);
    const restored = JSON.parse(readFileSync(join(tokenDir, "antigravity-oauth-token"), "utf8"));
    expect(restored.token).toBe("secret-ada");
  });

  it("saves and switches CodeArts accounts from codearts-auth.env", () => {
    const { home, data } = fixture();
    const envDir = join(home, ".config", "agenthub-codearts");
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, "codearts-auth.env"), "CODEARTS_CLI_AK=AK123456\nCODEARTS_CLI_SK=secret-sk\n");
    const instance: InstanceConfig = { driver: "codeartsAcpAgent", environment: { HOME: home } };
    const first = saveServiceAccount("codearts", instance, undefined, data);
    expect(first).toMatchObject({ supported: true, liveIdentity: "AK:AK123456" });
    expect(first.accounts[0]!.label).toBe("AK:AK123456");

    writeFileSync(join(envDir, "codearts-auth.env"), "CODEARTS_CLI_AK=AK999999\nCODEARTS_CLI_SK=secret-other\n");
    const second = saveServiceAccount("codearts", instance, "Second", data);
    expect(second.accounts).toHaveLength(2);

    switchServiceAccount("codearts", instance, first.activeId!, data);
    const restored = readFileSync(join(envDir, "codearts-auth.env"), "utf8");
    expect(restored).toContain("AK123456");
  });

  it("saves and switches TraeCode accounts from trae-jwt-token", () => {
    const { home, data } = fixture();
    const traeDir = join(home, ".trae-cn");
    mkdirSync(traeDir, { recursive: true });
    const payload = Buffer.from(JSON.stringify({ data: { id: "1001" } })).toString("base64");
    writeFileSync(join(traeDir, "trae-jwt-token"), `head.${payload}.sig`);
    const instance: InstanceConfig = { driver: "traecodeAgent", environment: { HOME: home } };
    const first = saveServiceAccount("traecode", instance, undefined, data);
    expect(first).toMatchObject({ supported: true, liveIdentity: "UID:1001" });

    const payload2 = Buffer.from(JSON.stringify({ data: { id: "1002" } })).toString("base64");
    writeFileSync(join(traeDir, "trae-jwt-token"), `head.${payload2}.sig`);
    saveServiceAccount("traecode", instance, "Second", data);

    switchServiceAccount("traecode", instance, first.activeId!, data);
    expect(readFileSync(join(traeDir, "trae-jwt-token"), "utf8")).toBe(`head.${payload}.sig`);
  });

  it("saves and switches Cline accounts from providers.json", () => {
    const { home, data } = fixture();
    const clineDir = join(home, ".cline", "data", "settings");
    mkdirSync(clineDir, { recursive: true });
    writeFileSync(join(clineDir, "providers.json"), JSON.stringify({
      version: 1,
      lastUsedProvider: "cline",
      providers: {
        cline: {
          settings: {
            auth: {
              metadata: {
                userInfo: { name: "Huaqi", email: "huaqi@example.test" },
              },
            },
          },
        },
      },
    }));
    const instance: InstanceConfig = { driver: "clineAgent", environment: { HOME: home } };
    const first = saveServiceAccount("cline", instance, undefined, data);
    expect(first).toMatchObject({ supported: true, liveIdentity: "Huaqi (huaqi@example.test)" });
    expect(first.accounts[0]!.label).toBe("Huaqi (huaqi@example.test)");

    writeFileSync(join(clineDir, "providers.json"), JSON.stringify({
      version: 1,
      lastUsedProvider: "cline",
      providers: {
        cline: {
          settings: {
            auth: {
              metadata: {
                userInfo: { name: "Bob", email: "bob@example.test" },
              },
            },
          },
        },
      },
    }));
    saveServiceAccount("cline", instance, "Bob Account", data);

    switchServiceAccount("cline", instance, first.activeId!, data);
    const restored = JSON.parse(readFileSync(join(clineDir, "providers.json"), "utf8"));
    expect(restored.providers.cline.settings.auth.metadata.userInfo.name).toBe("Huaqi");
  });

  it("saves and switches Meoo accounts from meoo-auth.env", () => {
    const { home, data } = fixture();
    const meooDir = join(home, ".config", "agenthub-meoo");
    mkdirSync(meooDir, { recursive: true });
    writeFileSync(join(meooDir, "meoo-auth.env"), "MEOO_AK=meoo_ak_FL_vXqMauD2snFMksqjFtbOLqhi5OxIdbk2m5gIV\n");
    const instance: InstanceConfig = { driver: "meooAgent", environment: { HOME: home } };
    const first = saveServiceAccount("meoo", instance, undefined, data);
    expect(first).toMatchObject({ supported: true, liveIdentity: expect.stringMatching(/^ak-[0-9a-f]{8}$/) });

    writeFileSync(join(meooDir, "meoo-auth.env"), "MEOO_AK=meoo_ak_OTHER_KEY_VALUE\n");
    saveServiceAccount("meoo", instance, "Second", data);

    switchServiceAccount("meoo", instance, first.activeId!, data);
    expect(readFileSync(join(meooDir, "meoo-auth.env"), "utf8")).toContain("meoo_ak_FL_vXqMauD2snFMksqjFtbOLqhi5OxIdbk2m5gIV");
  });

  it("saves and switches ZCode accounts from credentials.json", () => {
    const { home, data } = fixture();
    const zcodeDir = join(home, ".zcode", "v2");
    mkdirSync(zcodeDir, { recursive: true });
    writeFileSync(join(zcodeDir, "credentials.json"), JSON.stringify({
      "oauth:bigmodel:user_info": JSON.stringify({ displayName: "prwzivbl", id: "84951781368488628" }),
    }));
    const instance: InstanceConfig = { driver: "zcodeAgent", environment: { HOME: home, OMB_ZCODE_HOME: join(home, ".zcode") } };
    const first = saveServiceAccount("zcode", instance, undefined, data);
    expect(first).toMatchObject({ supported: true, liveIdentity: "prwzivbl" });

    writeFileSync(join(zcodeDir, "credentials.json"), JSON.stringify({
      "oauth:zai:user_info": JSON.stringify({ displayName: "traveler", id: "1002" }),
    }));
    saveServiceAccount("zcode", instance, "Traveler", data);

    switchServiceAccount("zcode", instance, first.activeId!, data);
    const restored = JSON.parse(readFileSync(join(zcodeDir, "credentials.json"), "utf8"));
    expect(restored["oauth:bigmodel:user_info"]).toContain("prwzivbl");
  });
});

/** A Qoder sign-in as `qodercli login` writes it: `user` encrypted with the machine id as key and IV. */
function qoderSignIn(home: string, configDir: string, account: { uid: string; nickname: string; token: string; machineId: string }): void {
  const authDir = join(home, configDir, ".auth");
  mkdirSync(authDir, { recursive: true });
  const key = Buffer.from(account.machineId.slice(0, 16), "utf8");
  const cipher = createCipheriv("aes-128-cbc", key, key);
  const plain = JSON.stringify({ uid: account.uid, nickname: account.nickname, token: account.token });
  writeFileSync(join(authDir, "user"), Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64"));
  writeFileSync(join(authDir, "machine_id"), account.machineId);
}

function qoderRead(dir: string): { uid: string; nickname: string; token: string; machineId: string } {
  const machineId = readFileSync(join(dir, "machine_id"), "utf8");
  const key = Buffer.from(machineId.slice(0, 16), "utf8");
  const decipher = createDecipheriv("aes-128-cbc", key, key);
  const body = readFileSync(join(dir, "user"), "utf8");
  const plain = Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
  return { machineId, ...JSON.parse(plain) };
}

function qoderAuth(home: string, configDir: string): string {
  return join(home, configDir, ".auth");
}

const QODER_A = { uid: "uid-a-019f6e23", nickname: "Ada", token: "qoder-secret-a", machineId: "machine-a-0123456789" };
const QODER_B = { uid: "uid-b-3bdd1d44", nickname: "Bob", token: "qoder-secret-b", machineId: "machine-b-9876543210" };

function qoderCn(home: string): InstanceConfig {
  return { driver: "qoderCnAgent", environment: { HOME: home } };
}

function qoderIntl(home: string): InstanceConfig {
  return { driver: "qoderAgent", environment: { HOME: home } };
}

describe("Qoder accounts", () => {
  it("saves the user file with the machine key that decrypts it, and reports the identity only", () => {
    const { home, data } = fixture();
    qoderSignIn(home, ".qoder-cn", QODER_A);
    const before = serviceAccountsView("qoder-cn", qoderCn(home), data);
    expect(before).toMatchObject({ supported: true, activeId: null, drifted: false, liveIdentity: "Ada" });
    expect(JSON.stringify(before)).not.toContain(QODER_A.token);

    const view = saveServiceAccount("qoder-cn", qoderCn(home), undefined, data);
    expect(view.accounts[0]).toMatchObject({ label: "Ada", identity: "Ada" });
    expect(JSON.stringify(view)).not.toContain(QODER_A.token);

    const account = join(data, "qoder-cn", view.activeId!);
    expect(statSync(join(account, "user")).mode & 0o777).toBe(0o600);
    expect(statSync(join(account, "machine_id")).mode & 0o777).toBe(0o600);
    expect(qoderRead(account).uid).toBe(QODER_A.uid);
    expect(readFileSync(join(data, "qoder-cn", "index.json"), "utf8")).not.toContain(QODER_A.token);
  });

  it("switches A→B→A with each snapshot decrypting against its own machine key", () => {
    const { home, data } = fixture();
    qoderSignIn(home, ".qoder-cn", QODER_A);
    const first = saveServiceAccount("qoder-cn", qoderCn(home), "A", data);
    qoderSignIn(home, ".qoder-cn", QODER_B);
    const second = saveServiceAccount("qoder-cn", qoderCn(home), "B", data);
    expect(second.accounts.map((account) => account.identity)).toEqual(["Ada", "Bob"]);

    const backToA = switchServiceAccount("qoder-cn", qoderCn(home), first.accounts[0]!.id, data);
    expect(backToA).toMatchObject({ activeId: first.accounts[0]!.id, drifted: false, liveIdentity: "Ada" });
    expect(qoderRead(qoderAuth(home, ".qoder-cn"))).toMatchObject({ uid: QODER_A.uid, token: QODER_A.token, machineId: QODER_A.machineId });

    switchServiceAccount("qoder-cn", qoderCn(home), second.accounts[1]!.id, data);
    expect(qoderRead(qoderAuth(home, ".qoder-cn"))).toMatchObject({ uid: QODER_B.uid, token: QODER_B.token, machineId: QODER_B.machineId });

    const savedA = join(data, "qoder-cn", first.accounts[0]!.id);
    expect(qoderRead(savedA)).toMatchObject({ uid: QODER_A.uid, machineId: QODER_A.machineId });
  });

  it("reports the active account's sign-in as drifted when another account signed in, and restores it", () => {
    const { home, data } = fixture();
    qoderSignIn(home, ".qoder-cn", QODER_A);
    const saved = saveServiceAccount("qoder-cn", qoderCn(home), "A", data);

    qoderSignIn(home, ".qoder-cn", QODER_B);
    expect(serviceAccountsView("qoder-cn", qoderCn(home), data))
      .toMatchObject({ drifted: true, liveIdentity: "Bob", activeId: saved.activeId });

    const repaired = switchServiceAccount("qoder-cn", qoderCn(home), saved.activeId!, data);
    expect(repaired).toMatchObject({ drifted: false, liveIdentity: "Ada" });
    expect(repaired.accounts.map((account) => account.identity)).toEqual(["Ada", "Bob"]);
    expect(qoderRead(qoderAuth(home, ".qoder-cn"))).toMatchObject({ uid: QODER_A.uid, token: QODER_A.token });
  });

  it("reports drift when the machine key no longer decrypts the user file, and repairs the pair", () => {
    const { home, data } = fixture();
    qoderSignIn(home, ".qoder-cn", QODER_A);
    const saved = saveServiceAccount("qoder-cn", qoderCn(home), "A", data);

    writeFileSync(join(home, ".qoder-cn", ".auth", "machine_id"), "another-machine-0001");
    expect(serviceAccountsView("qoder-cn", qoderCn(home), data))
      .toMatchObject({ drifted: true, activeId: saved.activeId });
    expect(serviceAccountsView("qoder-cn", qoderCn(home), data).liveIdentity).toBeUndefined();

    const repaired = switchServiceAccount("qoder-cn", qoderCn(home), saved.activeId!, data);
    expect(repaired).toMatchObject({ drifted: false, liveIdentity: "Ada" });
    expect(repaired.accounts).toHaveLength(1);
    expect(qoderRead(qoderAuth(home, ".qoder-cn"))).toMatchObject({ uid: QODER_A.uid, machineId: QODER_A.machineId });
  });

  it("refuses a sign-in whose machine key is missing", () => {
    const { home, data } = fixture();
    qoderSignIn(home, ".qoder-cn", QODER_A);
    rmSync(join(home, ".qoder-cn", ".auth", "machine_id"));
    expect(() => saveServiceAccount("qoder-cn", qoderCn(home), "A", data))
      .toThrowError(/machine key/);
  });

  it("refuses to restore a saved account whose machine key is gone", () => {
    const { home, data } = fixture();
    qoderSignIn(home, ".qoder-cn", QODER_A);
    const first = saveServiceAccount("qoder-cn", qoderCn(home), "A", data);
    qoderSignIn(home, ".qoder-cn", QODER_B);
    saveServiceAccount("qoder-cn", qoderCn(home), "B", data);

    rmSync(join(data, "qoder-cn", first.accounts[0]!.id, "machine_id"));
    expect(() => switchServiceAccount("qoder-cn", qoderCn(home), first.accounts[0]!.id, data))
      .toThrowError(/cannot be used/);
    expect(qoderRead(qoderAuth(home, ".qoder-cn"))).toMatchObject({ uid: QODER_B.uid });
    expect(serviceAccountsView("qoder-cn", qoderCn(home), data)).toMatchObject({ liveIdentity: "Bob", drifted: false });
  });

  it("keeps one entry across a token refresh of the same account", () => {
    const { home, data } = fixture();
    qoderSignIn(home, ".qoder-cn", QODER_A);
    const first = saveServiceAccount("qoder-cn", qoderCn(home), "A", data);
    qoderSignIn(home, ".qoder-cn", { ...QODER_A, token: "qoder-secret-a2" });
    const refreshed = saveServiceAccount("qoder-cn", qoderCn(home), undefined, data);

    expect(refreshed.accounts).toHaveLength(1);
    expect(refreshed.activeId).toBe(first.activeId);
    const saved = join(data, "qoder-cn", first.activeId!);
    expect(qoderRead(saved).token).toBe("qoder-secret-a2");
    expect(refreshed.drifted).toBe(false);
  });

  it("keeps the CN and international sign-ins apart", () => {
    const { home, data } = fixture();
    qoderSignIn(home, ".qoder-cn", QODER_A);
    qoderSignIn(home, ".qoder", QODER_B);

    const cn = saveServiceAccount("qoder-cn", qoderCn(home), "CN", data);
    const intl = saveServiceAccount("qoder", qoderIntl(home), "Intl", data);
    expect(cn).toMatchObject({ liveIdentity: "Ada", activeId: cn.accounts[0]!.id });
    expect(intl).toMatchObject({ liveIdentity: "Bob", activeId: intl.accounts[0]!.id });

    qoderSignIn(home, ".qoder-cn", { ...QODER_A, token: "qoder-secret-a2" });
    switchServiceAccount("qoder", qoderIntl(home), intl.activeId!, data);
    expect(qoderRead(qoderAuth(home, ".qoder"))).toMatchObject({ uid: QODER_B.uid, token: QODER_B.token, machineId: QODER_B.machineId });
    expect(qoderRead(qoderAuth(home, ".qoder-cn"))).toMatchObject({ uid: QODER_A.uid, token: "qoder-secret-a2" });
    expect(serviceAccountsView("qoder", qoderIntl(home), data)).toMatchObject({ liveIdentity: "Bob", drifted: false });
    expect(serviceAccountsView("qoder-cn", qoderCn(home), data).accounts).toHaveLength(1);
  });

  it("does not read the international sign-in for the CN engine", () => {
    const { home, data } = fixture();
    qoderSignIn(home, ".qoder", QODER_B);
    const cn = serviceAccountsView("qoder-cn", qoderCn(home), data);
    expect(cn).toMatchObject({ supported: true, accounts: [] });
    expect(cn.liveIdentity).toBeUndefined();
    expect(() => saveServiceAccount("qoder-cn", qoderCn(home), "A", data)).toThrowError(/Sign in to this engine first/);
  });

  it("reads a plain JSON user file without a machine key", () => {
    const { home, data } = fixture();
    const authDir = join(home, ".qoder-cn", ".auth");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "user"), JSON.stringify({ uid: "uid-c", nickname: "Cleo", token: "qoder-secret-c" }));
    const view = saveServiceAccount("qoder-cn", qoderCn(home), undefined, data);
    expect(view).toMatchObject({ liveIdentity: "Cleo", drifted: false });
    expect(view.accounts[0]).toMatchObject({ label: "Cleo", identity: "Cleo" });
  });
});

/** The same account saved twice: the live sign-in is read from the CLI's own files, the snapshot from the copy. */
describe("recognising a saved account by its stable id", () => {
  it("matches a ZCode snapshot by its uid even when the nickname is what the view shows", () => {
    const { home, data } = fixture();
    const zcodeDir = join(home, ".zcode", "v2");
    mkdirSync(zcodeDir, { recursive: true });
    const credentials = join(zcodeDir, "credentials.json");
    writeFileSync(credentials, JSON.stringify({
      "oauth:bigmodel:user_info": JSON.stringify({ displayName: "prwzivbl", id: "84951781368488628" }),
    }));
    const instance: InstanceConfig = { driver: "zcodeAgent", environment: { HOME: home, OMB_ZCODE_HOME: join(home, ".zcode") } };
    const first = saveServiceAccount("zcode", instance, undefined, data);
    expect(first).toMatchObject({ supported: true, liveIdentity: "prwzivbl" });

    // Another account signed in outside OpenMausBot, then the saved one is used again.
    writeFileSync(credentials, JSON.stringify({
      "oauth:zai:user_info": JSON.stringify({ displayName: "traveler", id: "1002" }),
    }));
    const second = saveServiceAccount("zcode", instance, "Traveler", data);
    expect(second.accounts).toHaveLength(2);

    const back = switchServiceAccount("zcode", instance, first.activeId!, data);
    expect(back.accounts).toHaveLength(2);
    expect(back.drifted).toBe(false);
    expect(back.activeId).toBe(first.activeId);

    const again = switchServiceAccount("zcode", instance, second.accounts[1]!.id, data);
    expect(again.accounts).toHaveLength(2);
    expect(again.drifted).toBe(false);
  });

  it("recognises an old snapshot that stored only its nickname, without making a copy of it", () => {
    const { home, data } = fixture();
    const zcodeDir = join(home, ".zcode", "v2");
    mkdirSync(zcodeDir, { recursive: true });
    const credentials = join(zcodeDir, "credentials.json");
    const saved = JSON.stringify({
      "oauth:bigmodel:user_info": JSON.stringify({ displayName: "prwzivbl", id: "84951781368488628" }),
    });
    writeFileSync(credentials, saved);
    const instance: InstanceConfig = { driver: "zcodeAgent", environment: { HOME: home, OMB_ZCODE_HOME: join(home, ".zcode") } };
    const first = saveServiceAccount("zcode", instance, undefined, data);

    // An index written by an older build: the id it stored is the nickname, not the uid.
    const indexPath = join(data, "zcode", "index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    for (const account of index.accounts) account.identity = "prwzivbl";
    writeFileSync(indexPath, JSON.stringify(index));

    writeFileSync(credentials, JSON.stringify({
      "oauth:zai:user_info": JSON.stringify({ displayName: "traveler", id: "1002" }),
    }));
    const second = saveServiceAccount("zcode", instance, "Traveler", data);
    expect(second.accounts).toHaveLength(2);

    const back = switchServiceAccount("zcode", instance, first.activeId!, data);
    expect(back.accounts).toHaveLength(2);
    expect(back.drifted).toBe(false);
    expect(JSON.parse(readFileSync(credentials, "utf8"))["oauth:bigmodel:user_info"]).toContain("prwzivbl");
  });

  it("matches a CodeBuddy snapshot by its uid while the nickname stays the display name", () => {
    const { home, data } = fixture();
    const authPath = join(home, ".codebuddy", "auth.info");
    mkdirSync(join(home, ".codebuddy"), { recursive: true });
    writeFileSync(authPath, JSON.stringify({ account: { nickname: "Ada", uid: "uid-ada-1" }, auth: { accessToken: "secret-a" } }));
    const instance: InstanceConfig = { driver: "codebuddyAgent", environment: { HOME: home } };
    const first = saveServiceAccount("codebuddy", instance, undefined, data);
    expect(first.liveIdentity).toBe("Ada");

    writeFileSync(authPath, JSON.stringify({ account: { nickname: "Bob", uid: "uid-bob-2" }, auth: { accessToken: "secret-b" } }));
    const second = saveServiceAccount("codebuddy", instance, "Bob", data);
    expect(second.accounts).toHaveLength(2);

    const back = switchServiceAccount("codebuddy", instance, first.activeId!, data);
    expect(back.accounts).toHaveLength(2);
    expect(back.drifted).toBe(false);
    expect(readAuth(home)).toMatchObject({ account: { nickname: "Ada" } });

    const again = switchServiceAccount("codebuddy", instance, second.accounts[1]!.id, data);
    expect(again.accounts).toHaveLength(2);
    expect(again.drifted).toBe(false);
  });
});

/**
 * A reissued token is the same account: the key must name the account, not the credential it holds.
 */
describe("a token refresh keeps one account", () => {
  it("keeps the Copilot account when its token is reissued, and switches back without a new snapshot", () => {
    const { home, data } = fixture();
    const ghDir = join(home, ".config", "gh");
    const copilotDir = join(home, ".config", "github-copilot");
    mkdirSync(ghDir, { recursive: true });
    mkdirSync(copilotDir, { recursive: true });
    writeFileSync(join(ghDir, "hosts.yml"), "github.com:\n    users:\n        octocat:\n            oauth_token: secret\n    user: octocat\n");
    writeFileSync(join(copilotDir, "copilot-token"), "gho_first_token_value");
    const instance: InstanceConfig = { driver: "copilotAgent", environment: { HOME: home } };

    const first = saveServiceAccount("copilot", instance, "Work", data);
    expect(first.accounts).toHaveLength(1);

    // The token is reissued; the GitHub account behind it is the same one.
    writeFileSync(join(copilotDir, "copilot-token"), "gho_second_token_value");
    const refreshed = saveServiceAccount("copilot", instance, undefined, data);
    expect(refreshed.accounts).toHaveLength(1);
    expect(refreshed.activeId).toBe(first.activeId);

    // A different GitHub account is a different account.
    writeFileSync(join(ghDir, "hosts.yml"), "github.com:\n    users:\n        hubot:\n            oauth_token: secret\n    user: hubot\n");
    writeFileSync(join(copilotDir, "copilot-token"), "gho_third_token_value");
    const second = saveServiceAccount("copilot", instance, "Personal", data);
    expect(second.accounts).toHaveLength(2);

    // Switching back to the first account restores it and creates nothing new.
    const back = switchServiceAccount("copilot", instance, first.activeId!, data);
    expect(back.accounts).toHaveLength(2);
    expect(back.drifted).toBe(false);
    expect(readFileSync(join(ghDir, "hosts.yml"), "utf8")).toContain("octocat");
  });

  it("keeps the Meoo account when its AK is reissued, and switches back without a new snapshot", () => {
    const { home, data } = fixture();
    const meooDir = join(home, ".config", "agenthub-meoo");
    const credDir = join(home, ".meoo");
    mkdirSync(meooDir, { recursive: true });
    mkdirSync(credDir, { recursive: true });
    writeFileSync(join(meooDir, "meoo-auth.env"), "MEOO_AK=meoo_ak_FIRST_KEY_VALUE\n");
    writeFileSync(join(credDir, "credentials.json"), JSON.stringify({
      version: 1, credentialType: "api_key", apiKey: "meoo_ak_FIRST_KEY_VALUE",
      userId: "37120000000000001", username: "Johhny", tenantId: "7",
    }));
    const instance: InstanceConfig = { driver: "meooAgent", environment: { HOME: home } };

    const first = saveServiceAccount("meoo", instance, "Work", data);
    expect(first.accounts).toHaveLength(1);

    // The AK is reissued for the same user id.
    writeFileSync(join(meooDir, "meoo-auth.env"), "MEOO_AK=meoo_ak_SECOND_KEY_VALUE\n");
    writeFileSync(join(credDir, "credentials.json"), JSON.stringify({
      version: 1, credentialType: "api_key", apiKey: "meoo_ak_SECOND_KEY_VALUE",
      userId: "37120000000000001", username: "Johhny", tenantId: "7",
    }));
    const refreshed = saveServiceAccount("meoo", instance, undefined, data);
    expect(refreshed.accounts).toHaveLength(1);
    expect(refreshed.activeId).toBe(first.activeId);

    // Another user id is another account.
    writeFileSync(join(credDir, "credentials.json"), JSON.stringify({
      version: 1, credentialType: "api_key", apiKey: "meoo_ak_OTHER_USER_VALUE",
      userId: "37120000000000002", username: "Someone", tenantId: "7",
    }));
    const second = saveServiceAccount("meoo", instance, "Personal", data);
    expect(second.accounts).toHaveLength(2);

    const back = switchServiceAccount("meoo", instance, first.activeId!, data);
    expect(back.accounts).toHaveLength(2);
    expect(back.drifted).toBe(false);
    // The refreshed AK is what the account holds now, so switching back restores that one.
    expect(readFileSync(join(meooDir, "meoo-auth.env"), "utf8")).toContain("meoo_ak_SECOND_KEY_VALUE");
  });

  it("keeps the CodeArts account when its AK is reissued, using the domain and user it carries", () => {
    const { home, data } = fixture();
    const envDir = join(home, ".config", "agenthub-codearts");
    const authDir = join(home, ".codeartsdoer", "cli-data");
    mkdirSync(envDir, { recursive: true });
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(envDir, "codearts-auth.env"), "CODEARTS_CLI_AK=AK_FIRST_VALUE\nCODEARTS_CLI_SK=secret\n");
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      "inferhub-provider": {
        type: "oauth", access: "access-first", refresh: "refresh-first", expires: 1,
        accountId: JSON.stringify({ domain_id: "dom-1", domain_name: "team", user_id: "user-1", user_name: "ada" }),
        enterpriseUrl: "prod",
      },
    }));
    const instance: InstanceConfig = { driver: "codeartsAcpAgent", environment: { HOME: home } };

    const first = saveServiceAccount("codearts", instance, "Work", data);
    expect(first.accounts).toHaveLength(1);

    writeFileSync(join(envDir, "codearts-auth.env"), "CODEARTS_CLI_AK=AK_SECOND_VALUE\nCODEARTS_CLI_SK=secret\n");
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      "inferhub-provider": {
        type: "oauth", access: "access-second", refresh: "refresh-second", expires: 2,
        accountId: JSON.stringify({ domain_id: "dom-1", domain_name: "team", user_id: "user-1", user_name: "ada" }),
        enterpriseUrl: "prod",
      },
    }));
    const refreshed = saveServiceAccount("codearts", instance, undefined, data);
    expect(refreshed.accounts).toHaveLength(1);
    expect(refreshed.activeId).toBe(first.activeId);

    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      "inferhub-provider": {
        type: "oauth", access: "access-third", refresh: "refresh-third", expires: 3,
        accountId: JSON.stringify({ domain_id: "dom-2", domain_name: "other", user_id: "user-2", user_name: "bob" }),
        enterpriseUrl: "prod",
      },
    }));
    const second = saveServiceAccount("codearts", instance, "Personal", data);
    expect(second.accounts).toHaveLength(2);

    const back = switchServiceAccount("codearts", instance, first.activeId!, data);
    expect(back.accounts).toHaveLength(2);
    expect(back.drifted).toBe(false);
    expect(readFileSync(join(envDir, "codearts-auth.env"), "utf8")).toContain("AK_SECOND_VALUE");
  });
});
