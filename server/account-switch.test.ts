import { describe, expect, it } from "vitest";
import { accountSwitch, accountSwitchLine, AccountSwitchGrants, threadAccountDecisionText } from "./account-switch.ts";

const KINDS: Record<string, string> = { "qoder": "qoderAgent", "qoder-ks": "qoderAgent", "claude": "claudeAgent", "codex": "codex", "chatgpt": "codex" };
const engineOf = (id: string) => KINDS[id];
const at = (instanceId: string) => ({ instanceId });

describe("accountSwitch (E83)", () => {
  it("flags another account of an engine a reference runs on", () => {
    expect(accountSwitch(engineOf, at("qoder"), [at("qoder-ks")])).toEqual({ from: "qoder-ks", to: "qoder" });
  });
  it("does not flag the same account, a different engine, or an engine no reference uses", () => {
    expect(accountSwitch(engineOf, at("qoder-ks"), [at("qoder-ks")])).toBeNull();
    expect(accountSwitch(engineOf, at("codex"), [at("qoder-ks")])).toBeNull();
    expect(accountSwitch(engineOf, at("qoder"), [at("claude"), undefined, null])).toBeNull();
    expect(accountSwitch(engineOf, at("qoder"), [])).toBeNull();
  });
  it("does not flag an account any reference already uses", () => {
    expect(accountSwitch(engineOf, at("qoder"), [at("qoder-ks"), at("qoder")])).toBeNull();
  });
  it("does not flag an unknown instance", () => {
    expect(accountSwitch(engineOf, at("gone"), [at("qoder")])).toBeNull();
  });
  it("words the card line like propose_model's", () => {
    expect(accountSwitchLine({ from: "chatgpt", to: "codex" })).toBe("Account: chatgpt → codex (another account of the same engine; usage is billed to it). This needs your Confirm.");
  });
});

describe("AccountSwitchGrants (E83)", () => {
  it("is one-shot and scoped to bot, conversation and instance", () => {
    const grants = new AccountSwitchGrants();
    grants.grant("b", "t", "qoder");
    expect(grants.take("b", "other", "qoder")).toBe(false);
    expect(grants.take("b", "t", "qoder-ks")).toBe(false);
    expect(grants.has("b", "t", "qoder")).toBe(true);
    expect(grants.take("b", "t", "qoder")).toBe(true);
    expect(grants.take("b", "t", "qoder")).toBe(false);
  });
  it("expires", () => {
    let now = 1000;
    const grants = new AccountSwitchGrants(60_000, () => now);
    grants.grant("b", "t", "qoder");
    now += 60_001;
    expect(grants.take("b", "t", "qoder")).toBe(false);
  });
});

describe("threadAccountDecisionText (E83)", () => {
  const payload = (result: "allow" | "deny") => ({ version: 1 as const, requestId: "r1", botId: "b", threadId: "t", targetBotId: "b", targetName: "Pot", createdAt: 1,
    reason: "Open thread #Review", selection: { instanceId: "qoder", model: "qmodel_latest", effort: "high" as const }, before: { instanceId: "qoder-ks", model: "qmodel_latest" },
    thread: { title: "Review", result } });
  it("tells a confirmed start_thread to call again with the exact same choice", () => {
    const text = threadAccountDecisionText(payload("allow"));
    expect(text).toContain("confirmed opening thread #Review on qoder");
    expect(text).toContain('{"instanceId":"qoder","model":"qmodel_latest","effort":"high"}');
  });
  it("tells a cancelled one not to substitute another account", () => {
    const text = threadAccountDecisionText(payload("deny"));
    expect(text).toContain("cancelled");
    expect(text).toContain("Do not open it on that account or on any other account of that engine");
  });
});
