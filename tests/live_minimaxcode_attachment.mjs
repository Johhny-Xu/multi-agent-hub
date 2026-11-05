#!/usr/bin/env node
// Explicit, opt-in live acceptance for MiniMaxCode text attachments.
// This is a test/acceptance entry point, not a production MCP dispatch tool.
// Importing this module performs no network calls.
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dispatchOnly, fetchRef, hubCapabilities } from "../mcp/hub.mjs";

const TERMINAL = new Set(["completed", "failed"]);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function evidence(answer, marker, facts) {
  const normalized = String(answer || "").replace(/\s+/g, "").toLowerCase();
  const markerFound = Boolean(marker) && normalized.includes(String(marker).replace(/\s+/g, "").toLowerCase());
  const matched = facts.filter((fact) => normalized.includes(String(fact).replace(/\s+/g, "").toLowerCase()));
  return { marker_found: markerFound, facts_matched: matched, facts_expected: facts.length };
}

export async function verifyMiniMaxCodeAttachment(request = {}) {
  const file = String(request.file || "");
  const marker = String(request.expectedMarker || "");
  const facts = Array.isArray(request.expectedFacts) ? request.expectedFacts.map(String) : [];
  const budget = Number(request.waitBudgetSeconds);
  const report = {
    kind: "minimaxcode_text_attachment_acceptance",
    capability_configured: false,
    dispatch_count: 0,
    ref: "",
    status: "unverified",
    worker_status: "unverified",
    answer_nonempty: false,
    attachment_evidence: { marker_found: false, facts_matched: [], facts_expected: facts.length },
    verification: "unverified",
    unverified_items: [],
    errors: [],
  };
  if (!file || !marker || !Number.isFinite(budget) || budget <= 0) {
    report.verification = "inconclusive";
    report.unverified_items.push("file, expectedMarker and a positive waitBudgetSeconds are required");
    return report;
  }
  report.file = basename(file);
  try {
    const caps = await hubCapabilities("minimaxcode");
    const worker = caps?.workers?.minimaxcode || null;
    const models = Array.isArray(worker?.models) ? worker.models : [];
    const model = models.find((item) => item.id === worker?.default_model) || models[0] || {};
    const filePolicy = model?.attachments?.file || null;
    const imagePolicy = model?.attachments?.image || null;
    report.capability_configured = Boolean(worker?.configured) && Boolean(filePolicy?.supported);
    report.capabilities = worker ? {
      model: worker.default_model ?? null, platform: caps?.platform ?? null,
      attachments: worker.attachments ?? null,
      file: filePolicy, image: imagePolicy,
      max_count: filePolicy?.max_count ?? null, max_total_bytes: filePolicy?.max_total_bytes ?? null,
    } : null;
    if (!worker) {
      report.verification = "failed";
      report.errors.push("minimaxcode capability was not returned");
      return report;
    }
  } catch (error) {
    report.verification = "failed";
    report.errors.push("capability query failed: " + String(error?.message || error).slice(0, 200));
    return report;
  }
  const accepted = await dispatchOnly("minimaxcode",
    `概述附件内容，并原样引用唯一标记 ${marker}。`, 900, { files: [file] });
  report.dispatch_count = accepted.dispatch_count ?? (accepted.ref || accepted.status !== "failed" ? 1 : 0);
  report.ref = accepted.ref || "";
  report.status = accepted.status || "unknown";
  report.worker_status = accepted.worker_status || accepted.status || "unknown";
  if (accepted.error_code) report.errors.push(accepted.error_code);
  if (!accepted.ref) {
    report.verification = accepted.status === "unknown" ? "inconclusive" : "failed";
    report.unverified_items.push("attachment task was not accepted; no ref to query");
    return report;
  }
  if (TERMINAL.has(report.status)) {
    report.answer = accepted.answer || "";
  } else {
    const deadline = Date.now() + budget * 1000;
    while (Date.now() < deadline) {
      await sleep(1000);
      const current = await fetchRef(report.ref);
      report.status = current.status;
      report.worker_status = current.worker_status || current.status;
      if (current.error_code) report.errors.push(current.error_code);
      if (TERMINAL.has(current.status)) {
        report.answer = current.answer || "";
        break;
      }
    }
  }
  const trimmed = String(report.answer || "").trim();
  report.answer_nonempty = Boolean(trimmed) && !["(无输出)", "(no output)"].includes(trimmed.toLowerCase());
  report.attachment_evidence = evidence(report.answer, marker, facts);
  const evidenceComplete = report.attachment_evidence.marker_found &&
    report.attachment_evidence.facts_matched.length === facts.length;
  if (report.status === "completed" && report.answer_nonempty && evidenceComplete) {
    report.verification = "passed";
  } else if (report.status === "completed" && !report.answer_nonempty) {
    report.verification = "failed";
    report.errors.push("WORKER_ANSWER_EMPTY");
  } else if (report.status === "completed") {
    report.verification = "failed";
    report.errors.push("VERIFICATION_EVIDENCE_INSUFFICIENT");
    report.unverified_items.push("final answer lacks the expected attachment marker or facts");
  } else if (report.status === "failed") {
    report.verification = "failed";
  } else {
    report.verification = "inconclusive";
    report.unverified_items.push(`task did not reach a terminal state within ${budget}s`);
  }
  const passed = (flag) => flag ? "passed" : "failed";
  report.checks = [
    { item: "capability_configured", verdict: passed(report.capability_configured) },
    { item: "dispatch_count", verdict: report.dispatch_count === 1 ? "passed" : "failed" },
    { item: "original_ref", verdict: report.ref ? "passed" : "failed" },
    { item: "worker_completion", verdict: report.worker_status === "completed" ? "passed"
      : report.status === "failed" ? "failed" : "unverified" },
    { item: "answer_nonempty", verdict: passed(report.answer_nonempty) },
    { item: "attachment_content_evidence", verdict: passed(report.attachment_evidence.marker_found
      && report.attachment_evidence.facts_matched.length === facts.length) },
    { item: "no_attachment_regression", verdict: "unverified" },
  ];
  return report;
}

export async function verifyMiniMaxCodeNoAttachment(request = {}) {
  const budget = Number(request.waitBudgetSeconds);
  const report = {
    kind: "minimaxcode_no_attachment_regression",
    dispatch_count: 0, ref: "", status: "unverified", worker_status: "unverified",
    answer_nonempty: false, verification: "unverified", unverified_items: [],
  };
  if (!Number.isFinite(budget) || budget <= 0) {
    report.unverified_items.push("positive waitBudgetSeconds is required");
    return report;
  }
  const accepted = await dispatchOnly("minimaxcode", "只回答数字：2+2 等于多少？", 900);
  report.dispatch_count = accepted.dispatch_count ?? (accepted.ref || accepted.status !== "failed" ? 1 : 0);
  report.ref = accepted.ref || "";
  report.status = accepted.status || "unknown";
  report.worker_status = accepted.worker_status || accepted.status || "unknown";
  if (!report.ref) {
    report.verification = report.status === "unknown" ? "inconclusive" : "failed";
    report.unverified_items.push("no-attachment task was not accepted; no ref to query");
    return report;
  }
  if (!TERMINAL.has(report.status)) {
    const deadline = Date.now() + budget * 1000;
    while (Date.now() < deadline) {
      await sleep(1000);
      const current = await fetchRef(report.ref);
      report.status = current.status;
      report.worker_status = current.worker_status || current.status;
      if (TERMINAL.has(current.status)) { report.answer = current.answer || ""; break; }
    }
  } else {
    report.answer = accepted.answer || "";
  }
  report.answer_nonempty = Boolean(String(report.answer || "").trim());
  report.verification = report.status === "completed" && report.answer_nonempty ? "passed"
    : report.status === "failed" ? "failed" : "inconclusive";
  return report;
}

async function main(argv) {
  const args = Object.fromEntries(argv.slice(2).map((item) => item.replace(/^--/, "").split("=")));
  if (!args.file || !args.marker) {
    process.stderr.write("usage: node tests/live_minimaxcode_attachment.mjs --file=<path> --marker=<unique> " +
      "[--facts=fact1|fact2] [--budget=180] [--no-attachment]\n");
    return 2;
  }
  const facts = args.facts ? args.facts.split("|") : [];
  const budget = Number(args.budget || 180);
  const report = { text_attachment: await verifyMiniMaxCodeAttachment({
    file: args.file, expectedMarker: args.marker, expectedFacts: facts, waitBudgetSeconds: budget,
  }) };
  report.no_attachment_regression = args["no-attachment"]
    ? await verifyMiniMaxCodeNoAttachment({ waitBudgetSeconds: budget })
    : { verification: "unverified", unverified_items: ["无附件任务回归未验证"] };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  return report.text_attachment.verification === "passed" &&
    report.no_attachment_regression.verification === "passed" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv);
}