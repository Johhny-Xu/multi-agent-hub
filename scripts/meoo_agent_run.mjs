#!/usr/bin/env node
// Meoo（秒悟）Agent OpenAPI 的最小调用器：起一个 Run → 订阅 SSE → 打印文本结果。
//
// 用法：
//   node scripts/meoo_agent_run.mjs --project <url_id> "帮我做一个报名页"
//   MEOO_AK=... node scripts/meoo_agent_run.mjs --project l3p11ei02gzz "你好"
//
// AK 读取顺序：环境变量 MEOO_AK → ~/.config/agenthub-meoo/meoo-auth.env
// 文档：https://docs.meoo.com/open/reference/ai-generation.md

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = process.env.MEOO_BASE_URL || 'https://meoo.com/open/v1';

function readAk() {
  if (process.env.MEOO_AK) return process.env.MEOO_AK.trim();
  try {
    const raw = readFileSync(join(homedir(), '.config', 'agenthub-meoo', 'meoo-auth.env'), 'utf-8');
    const m = raw.match(/^\s*MEOO_AK\s*=\s*(\S+)/m);
    if (m) return m[1];
  } catch { /* ignore */ }
  throw new Error('没有 MEOO_AK（环境变量或 ~/.config/agenthub-meoo/meoo-auth.env）');
}

function parseArgs(argv) {
  const out = { project: '', model: '', tier: 'standard', message: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') out.project = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--tier') out.tier = argv[++i];
    else rest.push(a);
  }
  out.message = rest.join(' ').trim();
  return out;
}

async function pickModel(ak, project, want) {
  if (want) return want;
  const r = await fetch(`${BASE}/projects/${project}/agent/capabilities`, { headers: { Authorization: `Bearer ${ak}` } });
  if (!r.ok) throw new Error(`capabilities ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j?.models?.[0]?.id || 'auto';
}

/** 起 Run 并消费 SSE，返回 { text, status, runId } */
export async function runMeooAgent({ ak, project, message, model = '', tier = 'standard', onText = null, timeoutMs = 300000 }) {
  const chosen = await pickModel(ak, project, model);
  const start = await fetch(`${BASE}/projects/${project}/agent/runs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ak}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    },
    body: JSON.stringify({ message, model: chosen, speed_tier: tier }),
  });
  const sj = await start.json().catch(() => ({}));
  if (!start.ok) throw new Error(`runs ${start.status}: ${JSON.stringify(sj).slice(0, 300)}`);
  const runId = sj.run_id;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const ev = await fetch(`${BASE}/projects/${project}/agent/runs/${runId}/events`, {
    headers: { Authorization: `Bearer ${ak}`, Accept: 'text/event-stream' },
    signal: ctl.signal,
  });
  if (!ev.ok) throw new Error(`events ${ev.status}: ${await ev.text()}`);

  let buf = '';
  let text = '';
  let status = 'running';
  const TERMINAL = ['run.completed', 'run.failed', 'run.canceled', 'run.interrupted', 'run.superseded'];

  try {
    for await (const chunk of ev.body) {
      buf += Buffer.from(chunk).toString('utf-8');
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = raw.split('\n');
        const name = (lines.find((l) => l.startsWith('event:')) || '').slice(6).trim();
        const dataLine = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!dataLine) continue;
        let payload;
        try { payload = JSON.parse(dataLine); } catch { continue; }
        const type = name || payload?.type || '';
        if (type === 'message.delta' || type === 'message.snapshot') {
          const t = payload?.delta ?? payload?.content ?? payload?.text ?? '';
          if (typeof t === 'string' && t) {
            if (type === 'message.delta') { text += t; if (onText) onText(t); }
          }
        }
        if (TERMINAL.includes(type)) { status = type.replace('run.', ''); break; }
      }
      if (TERMINAL.includes(`run.${status}`)) break;
    }
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
    status = 'timeout';
  } finally {
    clearTimeout(timer);
    try { ctl.abort(); } catch { /* ignore */ }
  }
  return { text, status, runId, model: chosen };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project || !args.message) {
    console.error('用法: node scripts/meoo_agent_run.mjs --project <url_id> "任务描述"');
    process.exit(2);
  }
  const ak = readAk();
  process.stdout.write(`▶ project=${args.project} model=${args.model || 'auto'} tier=${args.tier}\n`);
  const r = await runMeooAgent({ ak, project: args.project, message: args.message, model: args.model, tier: args.tier, onText: (t) => process.stdout.write(t) });
  process.stdout.write(`\n\n✔ 结束：${r.status}（run_id=${r.runId}）\n`);
}
