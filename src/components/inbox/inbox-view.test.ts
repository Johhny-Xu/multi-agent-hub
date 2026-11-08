import { describe, expect, it } from "vitest";

import { approvalRow, inboxView, messageRow, questionRow, reportRow, settledRow } from "@/testing/inbox-fixture";
import { askOf, choiceResponse, choicesOf, closeResponse, filterInboxView, inboxFixes, listedRows, quickActions, rowsIn, subjectOf, tabCounts } from "./inbox-view";

describe("the inbox's lines", () => {
  it("lists what waits on the person and their news as one list, newest first, and leaves settled lines out", () => {
    expect(listedRows(inboxView()).map((row) => row.id)).toEqual([approvalRow.id, questionRow.id, messageRow.id, reportRow.id]);
    expect(listedRows(inboxView([reportRow, approvalRow])).map((row) => row.id)).toEqual([approvalRow.id, reportRow.id]);
    expect(listedRows(null)).toEqual([]);
  });

  it("still knows each line's place, for the chat's card and its counts", () => {
    const view = inboxView();
    expect(rowsIn(view, "needs-you").map((row) => row.id)).toEqual([approvalRow.id, questionRow.id]);
    expect(rowsIn(view, "info").map((row) => row.id)).toEqual([messageRow.id, reportRow.id]);
    expect(rowsIn(view, "done").map((row) => row.id)).toEqual([settledRow.id]);
    expect(tabCounts(view)).toEqual({ "needs-you": 2, info: 2, done: 1 });
    expect(tabCounts(null)).toEqual({ "needs-you": 0, info: 0, done: 0 });
  });

  it("answers only an ask that is still open: news and a settled ask offer no answer", () => {
    expect([approvalRow, questionRow, messageRow, reportRow, settledRow].map(askOf)).toEqual(["approval", "question", null, null, null]);
  });
});

describe("a row's actions", () => {
  it("offers an approval's own answer first, a question's reply and close, news its done, anything else its chat", () => {
    expect(quickActions(approvalRow)).toEqual(["allow", "deny", "reply"]);
    expect(quickActions(questionRow)).toEqual(["reply", "close"]);
    expect(quickActions(messageRow)).toEqual(["done", "open"]);
    expect(quickActions(reportRow)).toEqual(["done", "open"]);
    expect(quickActions(settledRow)).toEqual(["open"]);
  });

  it("names each line's subject plainly, or by the conversation a message came from", () => {
    expect([approvalRow, questionRow, reportRow].map(subjectOf)).toEqual(["Approval", "Question", "Routine report"]);
    expect(subjectOf(messageRow)).toBe("Message");
    expect(subjectOf({ ...messageRow, origin: { botId: "scout", threadId: "scout-main", title: "Launch" } })).toBe("Launch");
  });

  it("taps a question's choice as its answer, in the card's own format, and closes it without one", () => {
    expect(choicesOf(questionRow)).toEqual(["Home", "Pricing"]);
    expect(choiceResponse(questionRow, "Home")).toEqual({ behavior: "answer", message: "Home" });
    const asked = { ...questionRow, card: { ...questionRow.card!, questionRequest: { version: 1 as const, questions: [{ question: "Which page?", options: [{ label: "Home" }, { label: "Pricing" }] }] } } };
    expect(choicesOf(asked)).toEqual(["Home", "Pricing"]);
    expect(choiceResponse(asked, "Pricing").message).toContain("Pricing");
    expect(closeResponse(questionRow)).toMatchObject({ behavior: "answer", dismiss: true });
    expect(closeResponse(approvalRow), "an approval closes as a deny").toMatchObject({ behavior: "deny" });
    expect(choicesOf(approvalRow)).toEqual([]);
  });

  it("filters debug bot rows when advanced mode is off", () => {
    const bots = [{ id: "debug-1", name: "hub·traecode" }, { id: "normal-1", name: "Atlas" }];
    const debugRow = { ...messageRow, id: "r-debug", from: { name: "hub·traecode", botId: "debug-1" } };
    const view = inboxView([debugRow, messageRow]);

    const filtered = filterInboxView(view, { advanced: false, bots });
    expect(filtered?.rows.map((r) => r.id)).toEqual([messageRow.id]);

    const kept = filterInboxView(view, { advanced: true, bots });
    expect(kept?.rows.map((r) => r.id)).toEqual(["r-debug", messageRow.id]);
  });

  it("filters needs-you fixes when associated exclusively with debug bots in simple mode", () => {
    const bots = [{ id: "debug-1", name: "hub·traecode" }, { id: "normal-1", name: "Atlas" }];
    const items = [
      { kind: "signed-out" as const, id: "fix-1", at: 100, instanceId: "i1", botIds: ["debug-1"] },
      { kind: "signed-out" as const, id: "fix-2", at: 101, instanceId: "i2", botIds: ["normal-1"] },
    ];
    expect(inboxFixes(items, null, { advanced: false, bots }).map((i) => i.id)).toEqual(["fix-2"]);
    expect(inboxFixes(items, null, { advanced: true, bots }).map((i) => i.id)).toEqual(["fix-1", "fix-2"]);
  });
});
