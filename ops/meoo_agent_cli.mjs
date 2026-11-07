#!/usr/bin/env node
// Meoo Agent 的 CLI 外壳：把 hub 的 {task} 转成一次 Agent Run，把结果打到 stdout。
// 让 meoo 能像 qoder / opencode 那样被 hub 当 Worker 调度（HTTP 后端，但接口是 CLI）。
//
// 用法：
//   node scripts/meoo_agent_cli.mjs --task "把首页改成暗色"
//   node scripts/meoo_agent_cli.mjs --task "..." --model qwen3.8-flash --tier deep
//
// 项目（project_url_id）来源优先级：
//   1. --project 参数
//   2. 环境变量 MEOO_PROJECT_URL_ID
//   3. ~/.config/agenthub-meoo/project.env 里的 MEOO_PROJECT_URL_ID
//   4. 都没有 → 在 ~/.config/agenthub-meoo/workspace 里自动建一个（只建一次，之后复用）

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runMeooAgent } from './meoo_agent_run.mjs';

const CFG_DIR = join(homedir(), '.config', 'agenthub-meoo');
const PROJECT_FILE = join(CFG_DIR, 'project.env');

function readAk() {
  if (process.env.MEOO_AK) return process.env.MEOO_AK.trim();
  const m = readFileSync(join(CFG_DIR, 'meoo-auth.env'), 'utf-8').match(/^\s*MEOO_AK\s*=\s*(\S+)/m);
  if (!m) throw new Error('没有 MEOO_AK');
  return m[1];
}

function readProject() {
  try {
    const m = readFileSync(PROJECT_FILE, 'utf-8').match(/^\s*MEOO_PROJECT_URL_ID\s*=\s*(\S+)/m);
    return m ? m[1] : '';
  } catch { return ''; }
}

/** 没有项目就建一个，写回 project.env，之后一直复用 */
function ensureProject() {
  const existed = readProject();
  if (existed) return existed;
  const dir = join(CFG_DIR, 'workspace');
  mkdirSync(dir, { recursive: true });
  try {
    execFileSync('meoo', ['projects', 'create', 'agenthub-worker'], { cwd: dir, stdio: 'pipe', timeout: 60000, shell: process.platform === 'win32' });
  } catch (e) {
    throw new Error(`自动建项目失败：${String(e.stderr || e.message).slice(0, 200)}`);
  }
  const env = readFileSync(join(dir, '.env'), 'utf-8');
  const m = env.match(/^\s*MEOO_PROJECT_URL_ID\s*=\s*(\S+)/m);
  if (!m) throw new Error('建项目后没拿到 MEOO_PROJECT_URL_ID');
  writeFileSync(PROJECT_FILE, `MEOO_PROJECT_URL_ID=${m[1]}\n`, 'utf-8');
  return m[1];
}

function parseArgs(argv) {
  const out = { task: '', project: '', model: '', tier: 'standard' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') out.task = argv[++i] || '';
    else if (a === '--project') out.project = argv[++i] || '';
    else if (a === '--model') out.model = argv[++i] || '';
    else if (a === '--tier') out.tier = argv[++i] || 'standard';
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const task = (args.task || '').trim();
  if (!task) {
    process.stderr.write('缺少 --task\n');
    process.exit(2);
  }
  const ak = readAk();
  const project = args.project || process.env.MEOO_PROJECT_URL_ID || ensureProject();

  // 必须等 run 结束再一次性输出：message.snapshot 是整段替换语义，
  // 边收边打到 stdout 时无法撤回，上游一旦重发/覆盖就会拼成 "66"。
  const r = await runMeooAgent({
    ak, project, message: task, model: args.model, tier: args.tier,
  });
  if (r.text) process.stdout.write(r.text.endsWith('\n') ? r.text : `${r.text}\n`);
  else process.stdout.write('(无文本输出)\n');
  if (r.prompt) process.stderr.write(`[meoo] 需要交互（OpenAPI 不能自动回复）：${r.prompt}\n`);
  process.stderr.write(`\n[meoo] run=${r.runId} status=${r.status} model=${r.model}\n`);
  process.exit(r.status === 'completed' ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`[meoo] 失败：${e.message}\n`);
  process.exit(1);
});
