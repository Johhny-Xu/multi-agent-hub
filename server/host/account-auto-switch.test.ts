import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ServiceAccountsView } from "../../shared/service-accounts.ts";
import { createAccountAutoSwitch, type AutoSwitchDeps } from "../account-auto-switch.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import "../server-line-packs.ts";
import { isServerLine } from "../server-lines.ts";
import { createAccountAutoSwitchHost, type AccountAutoSwitchHostDeps } from "./account-auto-switch.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ABC = [
  { id: "acc-a", label: "Alpha" },
  { id: "acc-b", label: "Beta" },
  { id: "acc-c", label: "Gamma" },
];

function coreSetup(accounts: { id: string; label: string }[], activeId: string | null, options: { cooldownMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "account-auto-switch-host-"));
  dirs.push(dir);
  let current = activeId;
  const switchedTo: string[] = [];
  const view = (): ServiceAccountsView => ({
    supported: true,
    accounts: accounts.map((account) => ({ ...account, createdAt: 0 })),
    activeId: current,
    drifted: false,
  });
  const deps: AutoSwitchDeps = {
    statePath: join(dir, "auto-switch.json"),
    view,
    switchTo: (_instanceId, accountId) => {
      current = accountId;
      switchedTo.push(accountId);
      return view();
    },
    ...(options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs }),
  };
  return { deps, switchedTo };
}

interface HostOptions {
  messageId?: string;
  noRequest?: boolean;
  otherBusy?: boolean;
  threadBusy?: boolean;
  resendThrows?: boolean;
}

function hostSetup(core: ReturnType<typeof createAccountAutoSwitch>, messages: Message[], options: HostOptions = {}) {
  const flags = {
    reclaimed: [] as string[],
    refreshed: 0,
    appended: [] as Array<{ threadId: string; message: Omit<Message, "id" | "at"> & { at?: number } }>,
    resends: [] as Array<{ botId: string; threadId: string; message: Message; replyTo: Message | undefined }>,
  };
  const store: Pick<Store, "activePath" | "messagesFor" | "appendMessage"> = {
    activePath: () => messages,
    messagesFor: () => messages,
    appendMessage: (threadId, message) => {
      flags.appended.push({ threadId, message });
      return { ...(message as object), id: `n${flags.appended.length}`, at: 1 } as Message;
    },
  };
  const deps: AccountAutoSwitchHostDeps = {
    core,
    store,
    request: () => (options.noRequest ? undefined : { messageId: options.messageId ?? "msg-1" }),
    otherTurnBusyOn: () => options.otherBusy ?? false,
    threadBusy: () => options.threadBusy ?? false,
    reclaim: (instanceId) => { flags.reclaimed.push(instanceId); },
    refresh: () => { flags.refreshed += 1; },
    resend: async (botId, threadId, message, replyTo) => {
      if (options.resendThrows) throw new Error("resend refused");
      flags.resends.push({ botId, threadId, message, replyTo });
      return undefined;
    },
  };
  return { deps, flags };
}

const bot = { id: "bot-1", modelSelection: { instanceId: "inst", model: "m" } } as unknown as BotRecord;

/** The line a notice carries, without the "notice: " prefix the status row adds. */
const noticeLine = (message: { tool?: { name?: string } }): string => {
  const name = message.tool?.name ?? "";
  return name.startsWith("notice: ") ? name.slice("notice: ".length) : name;
};

function userMessage(overrides: Partial<Message> = {}): Message {
  return { id: "msg-1", role: "user", kind: "text", text: "please carry on", ...overrides } as Message;
}

describe("createAccountAutoSwitchHost", () => {
  it("leaves an internal turn alone", async () => {
    const core = createAccountAutoSwitch(coreSetup(ABC, "acc-a").deps);
    core.setEnabled("inst", true);
    const host = hostSetup(core, [userMessage()]);
    const turnFailed = createAccountAutoSwitchHost(host.deps).turnFailed;
    expect(await turnFailed(bot, "t1", "quota exhausted", true)).toBe(false);
    expect(core.status("inst").limited).toEqual([]);
    expect(host.flags.reclaimed).toEqual([]);
  });

  it("leaves the turn alone while auto-switch is off for the engine", async () => {
    const core = createAccountAutoSwitch(coreSetup(ABC, "acc-a").deps);
    const host = hostSetup(core, [userMessage()]);
    const turnFailed = createAccountAutoSwitchHost(host.deps).turnFailed;
    expect(await turnFailed(bot, "t1", "quota exhausted", false)).toBe(false);
    expect(core.status("inst").limited).toEqual([]);
  });

  it("leaves the turn alone when the failure is not a limit error", async () => {
    const setup = coreSetup(ABC, "acc-a");
    const core = createAccountAutoSwitch(setup.deps);
    core.setEnabled("inst", true);
    const host = hostSetup(core, [userMessage()]);
    const turnFailed = createAccountAutoSwitchHost(host.deps).turnFailed;
    expect(await turnFailed(bot, "t1", "The model returned an invalid response", false)).toBe(false);
    expect(setup.switchedTo).toEqual([]);
    expect(host.flags.reclaimed).toEqual([]);
  });

  it("tells the person no account switched while another turn runs on the engine", async () => {
    const setup = coreSetup(ABC, "acc-a");
    const core = createAccountAutoSwitch(setup.deps);
    core.setEnabled("inst", true);
    const host = hostSetup(core, [userMessage()], { otherBusy: true });
    const turnFailed = createAccountAutoSwitchHost(host.deps).turnFailed;
    expect(await turnFailed(bot, "t1", "quota exhausted", false)).toBe(false);
    expect(setup.switchedTo).toEqual([]);
    expect(host.flags.appended).toHaveLength(1);
    expect(isServerLine("server.accountAutoSwitch.busy", noticeLine(host.flags.appended[0]!.message))).toBe(true);
    expect(host.flags.appended[0]!.message.tool).toMatchObject({ ok: false });
  });

  it("switches the account, retires the old sessions and resends the person's message", async () => {
    const setup = coreSetup(ABC, "acc-a");
    const core = createAccountAutoSwitch(setup.deps);
    core.setEnabled("inst", true);
    const original = userMessage({ replyToId: "root-1" });
    const root = { id: "root-1", role: "user", kind: "text", text: "root" } as Message;
    const host = hostSetup(core, [root, original]);
    const turnFailed = createAccountAutoSwitchHost(host.deps).turnFailed;
    expect(await turnFailed(bot, "t1", "429 Too Many Requests", false)).toBe(true);
    expect(setup.switchedTo).toEqual(["acc-b"]);
    expect(host.flags.reclaimed).toEqual(["inst"]);
    expect(host.flags.refreshed).toBe(1);
    expect(host.flags.appended).toHaveLength(1);
    expect(isServerLine("server.accountAutoSwitch.switchedResend", noticeLine(host.flags.appended[0]!.message))).toBe(true);
    expect(host.flags.appended[0]!.message.tool?.name).toContain("Alpha → Beta");
    expect(host.flags.resends).toHaveLength(1);
    expect(host.flags.resends[0]).toMatchObject({ botId: "bot-1", threadId: "t1", message: original, replyTo: root });
  });

  it("only tells the person to send the message again while the thread is busy", async () => {
    const setup = coreSetup(ABC, "acc-a");
    const core = createAccountAutoSwitch(setup.deps);
    core.setEnabled("inst", true);
    const host = hostSetup(core, [userMessage()], { threadBusy: true });
    const turnFailed = createAccountAutoSwitchHost(host.deps).turnFailed;
    expect(await turnFailed(bot, "t1", "quota exhausted", false)).toBe(true);
    expect(setup.switchedTo).toEqual(["acc-b"]);
    expect(host.flags.resends).toEqual([]);
    expect(host.flags.appended).toHaveLength(1);
    expect(isServerLine("server.accountAutoSwitch.switched", noticeLine(host.flags.appended[0]!.message))).toBe(true);
    expect(host.flags.appended[0]!.message.tool).toMatchObject({ ok: true });
  });

  it("only tells the person when the original message cannot be found", async () => {
    const setup = coreSetup(ABC, "acc-a");
    const core = createAccountAutoSwitch(setup.deps);
    core.setEnabled("inst", true);
    const host = hostSetup(core, [userMessage()], { messageId: "msg-gone" });
    const turnFailed = createAccountAutoSwitchHost(host.deps).turnFailed;
    expect(await turnFailed(bot, "t1", "quota exhausted", false)).toBe(true);
    expect(host.flags.resends).toEqual([]);
    expect(host.flags.appended).toHaveLength(1);
    expect(isServerLine("server.accountAutoSwitch.switched", noticeLine(host.flags.appended[0]!.message))).toBe(true);
  });

  it("names the account it left as unrecorded when the account list no longer knows it", async () => {
    const setup = coreSetup(ABC, "acc-gone");
    const core = createAccountAutoSwitch(setup.deps);
    core.setEnabled("inst", true);
    const host = hostSetup(core, [userMessage()]);
    const turnFailed = createAccountAutoSwitchHost(host.deps).turnFailed;
    expect(await turnFailed(bot, "t1", "quota exhausted", false)).toBe(true);
    expect(setup.switchedTo).toEqual(["acc-a"]);
    expect(host.flags.appended).toHaveLength(1);
    expect(isServerLine("server.accountAutoSwitch.switchedResend", noticeLine(host.flags.appended[0]!.message))).toBe(true);
    expect(noticeLine(host.flags.appended[0]!.message)).toContain("an unrecorded account");
  });

  it("stops switching after two resends of the same message and leaves the rest to quota switch", async () => {
    const setup = coreSetup(ABC, "acc-a", { cooldownMs: 0 });
    const core = createAccountAutoSwitch(setup.deps);
    core.setEnabled("inst", true);
    const host = hostSetup(core, [userMessage()]);
    const turnFailed = createAccountAutoSwitchHost(host.deps).turnFailed;
    expect(await turnFailed(bot, "t1", "quota exhausted", false)).toBe(true);
    expect(await turnFailed(bot, "t1", "quota exhausted", false)).toBe(true);
    expect(setup.switchedTo).toEqual(["acc-b", "acc-c"]);
    expect(host.flags.resends).toHaveLength(2);
    const noticesAfterTwo = host.flags.appended.length;
    expect(await turnFailed(bot, "t1", "quota exhausted", false)).toBe(false);
    expect(setup.switchedTo).toEqual(["acc-b", "acc-c"]);
    expect(host.flags.appended).toHaveLength(noticesAfterTwo);
  });

  it("reports a failed retry as a notice and still counts the switch as handled", async () => {
    const setup = coreSetup(ABC, "acc-a");
    const core = createAccountAutoSwitch(setup.deps);
    core.setEnabled("inst", true);
    const host = hostSetup(core, [userMessage()], { resendThrows: true });
    const turnFailed = createAccountAutoSwitchHost(host.deps).turnFailed;
    expect(await turnFailed(bot, "t1", "quota exhausted", false)).toBe(true);
    expect(host.flags.appended).toHaveLength(2);
    expect(isServerLine("server.accountAutoSwitch.switchedResend", noticeLine(host.flags.appended[0]!.message))).toBe(true);
    expect(isServerLine("server.accountAutoSwitch.retryFailed", noticeLine(host.flags.appended[1]!.message))).toBe(true);
    expect(noticeLine(host.flags.appended[1]!.message)).toContain("resend refused");
  });

  it("stays quiet when no other account is available to switch to", async () => {
    const setup = coreSetup([{ id: "acc-a", label: "Alpha" }], "acc-a");
    const core = createAccountAutoSwitch(setup.deps);
    core.setEnabled("inst", true);
    const host = hostSetup(core, [userMessage()]);
    const turnFailed = createAccountAutoSwitchHost(host.deps).turnFailed;
    expect(await turnFailed(bot, "t1", "quota exhausted", false)).toBe(false);
    expect(setup.switchedTo).toEqual([]);
    expect(host.flags.appended).toEqual([]);
    expect(host.flags.reclaimed).toEqual([]);
    expect(host.flags.refreshed).toBe(0);
  });
});
