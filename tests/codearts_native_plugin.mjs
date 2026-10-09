import assert from 'node:assert/strict';
import { MultiAgentHubPlugin, ROUTING_INSTRUCTIONS, isHubDispatch } from '../integrations/codearts/plugin.js';

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
