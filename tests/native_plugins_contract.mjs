import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import { runWorkflow } from '../integrations/dsh/workflows/runner.mjs';

const options = { model: 'test-model', thinking: 'off', stream: true, files: ['C:/fixture/input.png'], cwd: '/tmp/hub-project' };
const result = worker => ({ ok: true, status: 'completed', worker, ref: worker + '-fixture', answer: 'Fixture output' });

async function native(mode, input) {
  const calls = [];
  const source = await readFile(new URL('../integrations/dsh/workflows/' + mode + '.dsh.js', import.meta.url), 'utf8');
  const context = createContext({ args: input, phase() {}, log() {},
    parallel: thunks => Promise.all(thunks.map(thunk => thunk())),
    agent: async prompt => { const arguments_ = JSON.parse(prompt.split('\n')[1]); calls.push(arguments_); return result(arguments_.worker); },
  });
  await new Script('(async()=>{\n' + source + '\n})()').runInContext(context, { timeout: 1000 });
  return calls;
}

for (const [mode, task] of [['hub-fanout', { task: 'Test', workers: ['cbcn'] }], ['code-audit', { code: 'Test' }], ['competitive-solve', { problem: 'Test' }]]) {
  test(mode + ' preserves task options through native child and direct runner', async () => {
    const calls = await native(mode, { ...task, ...options });
    assert.ok(calls.length);
    for (const call of calls) for (const key of Object.keys(options)) assert.deepEqual(call[key], options[key]);
    const observed = [];
    await runWorkflow(mode, { ...task, ...options }, async (worker, task_, budget, forwarded) => {
      observed.push(forwarded); return result(worker);
    });
    assert.equal(observed.length, calls.length);
    for (const forwarded of observed) assert.deepEqual(forwarded, options);
  });
}

test('invalid options fail before any native child or runner dispatch', async () => {
  for (const bad of [{ thinking: 'high' }, { stream: 'true' }, { files: [''] }, { files: Array(9).fill('x') }, { model: '' }, { cwd: 1 }]) {
    await assert.rejects(native('hub-fanout', { task: 'Test', workers: ['cbcn'], ...bad }), /Invalid/);
    let called = false;
    await assert.rejects(runWorkflow('hub-fanout', { task: 'Test', workers: ['cbcn'], ...bad }, async () => { called = true; }), /Invalid/);
    assert.equal(called, false);
  }
});
