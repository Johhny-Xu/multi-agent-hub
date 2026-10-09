#!/usr/bin/env node
// Deterministic host runner: each stage calls the bridge once; no intermediate LLM.
import { ask, resolveWorker, CANONICAL } from "../mcp/hub.mjs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { workflowOptions } from "./options.mjs";

function nonempty(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a nonempty string`);
  return value;
}
function checked(value, worker) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.worker !== worker || typeof value.ok !== "boolean" || typeof value.answer !== "string" || typeof value.ref !== "string" || !["completed", "failed", "running", "unknown"].includes(value.status)) {
    return { ok: false, status: "failed", worker, ref: "", answer: "Invalid Hub result" };
  }
  return { ...value, ok: value.ok === true && value.status === "completed" && !!value.answer.trim() };
}

export async function runWorkflow(mode, input, invoke = ask) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be a JSON object");
  const budget = input.timeout_s ?? 300;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0 || budget > 86400) throw new Error("Invalid timeout_s");
  const options = workflowOptions(input);
  const call = async (worker, task) => {
    try { return checked(await invoke(worker, task, budget, options), worker); }
    catch (error) { return { ok: false, status: "unknown", worker, ref: "", answer: String(error?.message || error) }; }
  };
  if (mode === "hub-fanout") {
    const task = nonempty(input.task, "task");
    const raw = input.workers ?? ["antigravity", "codebuddy", "traecode"];
    const list = typeof raw === "string" ? raw.split(/[,，\s]+/).filter(Boolean) : raw;
    if (!Array.isArray(list) || !list.length || list.length > CANONICAL.length) throw new Error(`workers must contain 1 to ${CANONICAL.length} workers`);
    const workers = [...new Set(list.map((worker) => {
      const canonical = typeof worker === "string" && resolveWorker(worker);
      if (!canonical) throw new Error("Unknown worker");
      return canonical;
    }))];
    const results = await Promise.all(workers.map((worker) => call(worker, task)));
    const ok = results.every((result) => result.ok);
    return { ok, status: ok ? "completed" : "incomplete", task, results };
  }
  if (mode === "code-audit") {
    const code = nonempty(input.code, "code");
    const architecture = await call("codebuddy", "Review architecture and performance; list defects and improvements:\n\n" + code);
    if (!architecture.ok) return { ok: false, status: "incomplete", architecture, security: null };
    const security = await call("antigravity", "Review edge cases, errors and security. Original code:\n" + code + "\nPrevious review:\n" + architecture.answer);
    return { ok: security.ok, status: security.ok ? "completed" : "incomplete", architecture, security };
  }
  if (mode === "competitive-solve") {
    const problem = nonempty(input.problem, "problem");
    const candidates = await Promise.all(["antigravity", "codebuddy"].map((worker) => call(worker, "Solve independently with reasoning and final answer:\n" + problem)));
    if (candidates.some((result) => !result.ok)) return { ok: false, status: "incomplete", problem, candidates, verdict: null };
    const verdict = await call("codebuddy", "Compare solutions; identify agreement or flaws without assuming consensus:\n" + JSON.stringify({ problem, candidates }));
    return { ok: verdict.ok, status: verdict.ok ? "completed" : "incomplete", problem, candidates, verdict };
  }
  throw new Error("Unknown workflow");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, filename, ...extra] = process.argv.slice(2);
    if (!mode || !filename || extra.length) throw new Error("Usage: node runner.mjs <hub-fanout|code-audit|competitive-solve> <input.json|->");
    let text;
    if (filename === "-") {
      text = "";
      for await (const chunk of process.stdin) text += chunk;
    } else text = await readFile(filename, "utf8");
    const result = await runWorkflow(mode, JSON.parse(text));
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, status: "failed", error: String(error?.message || error) }) + "\n");
    process.exitCode = 1;
  }
}
