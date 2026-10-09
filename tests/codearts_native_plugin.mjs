import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { MultiAgentHubPlugin, ROUTING_INSTRUCTIONS, isHubDispatch } from '../integrations/codearts/plugin.js';

// Native guidance is shipped separately to hooks, skills and every agent. Keep
// the host-specific tool route and permission boundary present in each entry.
const agentRoot = new URL('../integrations/codearts/agents/', import.meta.url);
const agentFiles = (await readdir(agentRoot)).filter(name => /^hub-.*\.md$/.test(name));
assert.equal(agentFiles.length, 9);
const guidance = [
  ['hook', ROUTING_INSTRUCTIONS],
  ['skill', await readFile(new URL('../integrations/codearts/skills/dispatch-hub/SKILL.md', import.meta.url), 'utf8')],
  ...await Promise.all(agentFiles.map(async name => [name, await readFile(new URL(name, agentRoot), 'utf8')])),
];
for (const [name, text] of guidance) {
  assert.match(text, /directly registered.*directly/i, `${name}: keep directly registered hosts supported`);
  assert.match(text, /tool_search[\s\S]*tool_describe[\s\S]*tool_call/, `${name}: describe the lazy tool route`);
  assert.match(text, /permission.*denied[\s\S]*blocked_permission[\s\S]*original ref/i, `${name}: stop on denial and preserve the reference`);
  assert.match(text, /Do not retry.*another tool name[\s\S]*explicit authorization/i, `${name}: forbid alternate-tool permission bypass`);
  assert.match(text, /total waiting budget[\s\S]*running[\s\S]*not.*completed/i, `${name}: bounded polling must not promote running to completed`);
}

const hooks = await MultiAgentHubPlugin();
const system = { system: ['original system'] };
await hooks['experimental.chat.system.transform']({}, system);
await hooks['experimental.chat.system.transform']({}, system);
assert.deepEqual(system.system, ['original system', ROUTING_INSTRUCTIONS]);
assert.equal(isHubDispatch('mcp__multi-agent-hub__hub_dispatch'), true);
assert.equal(isHubDispatch('multi_agent_hub_hub_ask'), true);
assert.equal(isHubDispatch('multi-agent-hub_hub_dispatch'), true);
assert.equal(isHubDispatch('unrelated_hub_dispatch'), false);
assert.equal(isHubDispatch('hub_fetch'), false);
const prior = process.env.AGENTHUB_WORKER_ID;
try {
  process.env.AGENTHUB_WORKER_ID = 'codearts';
  await assert.rejects(hooks['tool.execute.before']({ tool: 'mcp__multi-agent-hub__hub_ask' }, { args: { worker: 'codearts' } }), /recursive/);
  await hooks['tool.execute.before']({ tool: 'hub_ask' }, { args: { worker: 'mimocode' } });
  await hooks['tool.execute.before']({ tool: 'hub_fetch' }, { args: { worker: 'codearts' } });
  delete process.env.AGENTHUB_WORKER_ID;
  await hooks['tool.execute.before']({ tool: 'hub_ask' }, { args: { worker: 'codearts' } });
} finally {
  if (prior === undefined) delete process.env.AGENTHUB_WORKER_ID;
  else process.env.AGENTHUB_WORKER_ID = prior;
}
console.log('CodeArts native hook: system guidance, idempotence and recursive-dispatch guard passed');
