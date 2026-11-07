import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

const TOKEN = "external-runtime-busy-fixture-0123456789abcdef";

// An idle external caller consults a busy peer: the person's approval is asked once, before anything is queued, in both orders.
it.each(["already busy", "became busy during approval"])(
  "queues an idle external caller's ask behind a peer that is %s, without losing or repeating approval",
  async scenario => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-external-busy-"));
    const gate = join(scratch, "finish-peer");
    const prompts = join(scratch, "prompts.jsonl");
    let fixture: VerificationServer | undefined;
    const evidence: unknown[] = [];
    try {
      fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "slow",
        FAKE_CLAUDE_SLOW_FINISH_GATE: gate, FAKE_CLAUDE_PROMPTS: prompts });
      const session = fixture;
      const control = (...args: string[]) => runControlOmb([...args, "--url", session.info.url]) as Promise<any>;
      const api = async (method: string, path: string, body?: unknown, runtime = false): Promise<any> => {
        const response = await fetch(session.info.url + path, {
          method, headers: { "content-type": "application/json", ...(runtime ? { authorization: `Bearer ${TOKEN}` } : { origin: session.info.url }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const value = await response.json();
        expect(response.ok, `${method} ${path}: ${JSON.stringify(value)}`).toBe(true);
        return value;
      };
      const source = (await control("new-bot", "--name", "External gateway")).bot;
      const peer = (await control("new-bot", "--name", "Occupied peer")).bot;
      const sourceThread = source.activeTaskId;
      const peerThread = peer.activeTaskId;
      const messages = async (threadId: string): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages;
      const sourceCards = async () => (await messages(sourceThread)).filter(message => ["ask_bot", "delegate_bot"].includes(message.card?.tool));
      const peerRequests = async (threadId: string) => (await messages(threadId))
        .filter(message => message.roomRequest?.phase === "request" && message.from?.botId === source.id);
      const sourceState = async () => (await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === source.id);
      const receipt = (id: string) => api("GET", `/api/internal/assignment-status?id=${id}`, undefined, true);
      const row = (id: string) => readHandoffs(session.info.dataDir).find(node => node.id === id);
      const withholdAfterRevocation = async (id: string) => {
        await api("PATCH", `/api/bots/${source.id}`, { peers: [] });
        const response = await fetch(`${session.info.url}/api/internal/assignment-status?id=${id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: "Result withheld: team access changed while the teammate was working" });
        await api("PATCH", `/api/bots/${source.id}`, { peers: [peer.id], acknowledgePeerScope: true });
      };
      // One slot per bot: the peer's running turn holds its work thread too,
      // so "busy" means the consultation has to wait for that turn to end.
      await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
      // Peer review applies below Full access.
      await api("PATCH", `/api/bots/${source.id}`, { approvePeerComms: true, approvalMode: "ask" });
      writeFileSync(join(session.info.dataDir, "external-runtimes.json"), JSON.stringify({ [source.id]: { token: TOKEN, threadId: sourceThread } }), { mode: 0o600 });
      const requestText = `Only this queued request: ${scenario}`;
      const occupy = async () => {
        await control("send", "--bot", peer.id, "--task", peerThread, "--text", "Keep this unrelated turn running until the fixture gate opens.");
        await expect.poll(() => existsSync(prompts) && readFileSync(prompts, "utf8").includes("Keep this unrelated turn running"), { timeout: 15_000 }).toBe(true);
      };
      const approve = async (card: any) => api("POST", `/api/threads/${sourceThread}/respond`, { requestId: card.card.requestId, behavior: "allow" });
      // The route asks the person before it queues anything, so the call stays open; a rejection handler is attached at once so
      // teardown never turns a failed assertion into an unhandled HTTP rejection.
      if (scenario === "already busy") await occupy();
      const pendingAsk = api("POST", "/api/internal/coordinate-bots", { botIds: [peer.id], message: requestText, consult: true }, true)
        .then(value => ({ value }), error => ({ error }));
      await expect.poll(async () => (await sourceCards()).length, { timeout: 15_000 }).toBe(1);
      const [card] = await sourceCards();
      expect(card.card.tool).toBe("ask_bot");
      expect(card.card.answered).toBeFalsy();
      expect(readHandoffs(session.info.dataDir).filter(node => node.parentId || node.botId !== peer.id || node.threadId !== peerThread)).toEqual([]);
      if (scenario !== "already busy") await occupy();
      await approve(card);
      const outcome = await pendingAsk;
      if ("error" in outcome) throw outcome.error;
      const queued = outcome.value;
      expect(queued).toMatchObject({ rootId: expect.any(String), receipts: [{ botId: peer.id, outcome: "queued", requestId: expect.any(String) }] });
      expect(queued.deprecation).toBeUndefined();
      expect(queued.text).toBeUndefined();
      const id: string = queued.receipts[0].requestId;
      evidence.push({ scenario, queued, sourceThread, peerThread });
      await expect.poll(() => row(id)?.status, { timeout: 5_000 }).toBe("queued");
      expect(row(id)).toMatchObject({ botId: peer.id, mode: "consult", reply: "poll", approvalGranted: true });
      const workThread = row(id)!.threadId;
      expect(workThread).not.toBe(peerThread);
      expect(await peerRequests(workThread)).toHaveLength(0);
      expect((await sourceState()).busy).toBeFalsy();
      expect((await messages(sourceThread)).filter(message => message.role === "user")).toHaveLength(0);
      const early = await receipt(id);
      expect(early.assignment).toMatchObject({ id, botId: peer.id, status: "queued", mode: "consult", reply: "poll" });
      expect(early.deprecation).toBeUndefined();
      evidence.push({ scenario, queued, early, beforeRelease: await sourceCards() });

      writeFileSync(gate, "release only the isolated provider");
      await expect.poll(async () => (await receipt(id)).assignment.status, { timeout: 20_000 }).toBe("completed");
      expect((await receipt(id)).assignment.result).toContain(requestText);
      expect((await control("wait", "--bot", peer.id, "--task", workThread)).status).toBe("settled");
      expect((await control("wait", "--bot", source.id, "--task", sourceThread)).status).toBe("settled");
      expect((await messages(sourceThread)).filter(message => message.role === "bot" && message.turnId && !message.from)).toEqual([]);
      const requests = await peerRequests(workThread);
      expect(requests).toHaveLength(1);
      expect(requests[0].text).toContain(requestText);
      expect((await sourceCards()).map(card => ({ tool: card.card.tool, answered: card.card.answered })))
        .toEqual([{ tool: "ask_bot", answered: "allow" }]);
      await expect.poll(() => row(queued.rootId)?.status, { timeout: 10_000 }).toBe("completed");
      expect(row(queued.rootId)).toMatchObject({ reply: "poll", threadId: sourceThread });
      await withholdAfterRevocation(id);
      evidence.push({ receipt: await receipt(id), sourceMessages: await messages(sourceThread), peerMessages: await messages(workThread) });
    } finally {
      try {
        if (fixture) {
          const bots = await fetch(`${fixture.info.url}/api/bots?messages=0`).then(response => response.json()).catch(() => null);
          evidence.push({ finalBots: bots });
          writeFileSync(`${fixture.info.logPath}.external-busy.json`, JSON.stringify(evidence, null, 2));
          console.info("External runtime busy evidence saved.");
        }
      } finally {
        try { await fixture?.close(); }
        finally { await removeTempDir(scratch); }
      }
    }
  },
  60_000,
);
