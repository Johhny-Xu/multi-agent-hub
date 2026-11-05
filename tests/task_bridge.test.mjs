import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, symlink, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

const temp = await mkdtemp(join(os.tmpdir(), 'agenthub-task-bridge-'));
const calls = [];
let polls = 0;
const ref = 'mimocode-a1b2c3d4e5';
const hub = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const rpc = JSON.parse(body);
  calls.push({ name: rpc.params.name, args: rpc.params.arguments, auth: req.headers.authorization, url: req.url });
  let value;
  switch (rpc.params.name) {
    case 'hub_dispatch_cli': polls = 0; value = `[mimocode/${ref}] task accepted`; break;
    case 'hub_result_json': value = JSON.stringify(++polls < 3 ? { ref, status: 'running', progress: `answer portion ${polls}` } : { ref, status: 'completed', text: 'ANSWER=37' }); break;
    case 'hub_wait_result': value = `[${ref}] agent=mimocode status=completed\nANSWER=37`; break;
    case 'hub_capabilities': value = JSON.stringify({ workers: { mimocode: { thinking: ['default', 'on', 'off'] } } }); break;
    default: value = 'unexpected tool';
  }
  const text = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: value }] } });
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
});
await new Promise((r) => hub.listen(0, '127.0.0.1', r));
process.env.AGENTHUB_URL = `http://127.0.0.1:${hub.address().port}/mcp`;
process.env.HUB_TOKEN = 'SYNTHETIC_TASK_BRIDGE';
const bridge = await import('../mcp/hub.mjs');

test('attachments cross HTTP as content with a basename, not a client path', async () => {
  const file = join(temp, 'input 数据.txt');
  const contents = 'fixture input=37';
  await writeFile(file, contents);
  const result = await bridge.ask('mimo', 'Read supplied input', 3, { files: [file], thinking: 'off', model: '26f' });
  assert.equal(result.status, 'completed');
  const request = calls.findLast((c) => c.name === 'hub_dispatch_cli');
  assert.equal(request.args.thinking, 'off');
  assert.equal(request.args.model, '26f');
  assert.equal(request.args.attachments[0].name, 'input 数据.txt');
  assert.equal(Buffer.from(request.args.attachments[0].data_base64, 'base64').toString(), contents);
  assert.ok(!JSON.stringify(request.args).includes(temp));
  assert.equal(request.auth, 'Bearer SYNTHETIC_TASK_BRIDGE');
  assert.ok(!request.url.includes('token='));
});

test('streaming emits intermediate progress before the final answer', async () => {
  const chunks = [];
  const result = await bridge.ask('mimo', 'Stream supplied input', 3, { stream: true, onProgress: (event) => chunks.push(event.text) });
  assert.equal(result.answer, 'ANSWER=37');
  assert.deepEqual(chunks, ['answer portion 1', 'answer portion 2']);
});

test('nonstreaming buffers the final result and does not query streaming state', async () => {
  const before = calls.length;
  const chunks = [];
  const result = await bridge.ask('mimo', 'Return final result', 3, { stream: false, onProgress: (event) => chunks.push(event) });
  assert.equal(result.answer, 'ANSWER=37');
  assert.equal(chunks.length, 0);
  assert.ok(!calls.slice(before).some((c) => c.name === 'hub_result_json'));
});

test('invalid options and credential files are rejected before any dispatch', async () => {
  const before = calls.length;
  await writeFile(join(temp, '.credentials.yaml'), 'SYNTHETIC_LOCAL_FIXTURE');
  for (const options of [{ stream: 'false' }, { thinking: 'low' }, { files: 'input.txt' }, { files: [join(temp, 'auth.json')] }, { files: [join(temp, '.credentials.yaml')] }, { files: [join(temp, 'missing.txt')] }]) {
    const result = await bridge.ask('mimo', 'Must not run', 3, options);
    assert.equal(result.status, 'failed');
  }
  assert.equal(calls.length, before);
});

test('capability discovery returns public worker metadata', async () => {
  assert.deepEqual((await bridge.hubCapabilities('mimo')).workers.mimocode.thinking, ['default', 'on', 'off']);
});

test('native stdio MCP stream uses the client progress token and validates file arrays', async () => {
  const child = spawn(process.execPath, [resolve('mcp/server.mjs')], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const messages = [];
  lines.on('line', (line) => messages.push(JSON.parse(line)));
  const wait = async (id) => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const result = messages.find((r) => r.id === id);
      if (result) return result;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail('MCP did not complete');
  };
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hub_ask', arguments: { worker: 'mimo', task: 'Stream fixture', stream: true, timeout_s: 3 }, _meta: { progressToken: 'fixture-progress' } } }) + '\n');
    const completed = await wait(1);
    const events = messages.filter((m) => m.method === 'notifications/progress');
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.params.progressToken === 'fixture-progress'));
    assert.equal(JSON.parse(completed.result.content[0].text).delivery, 'mcp_progress');
    const before = calls.length;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hub_dispatch', arguments: { worker: 'mimo', task: 'Invalid files', files: [17] } } }) + '\n');
    assert.equal((await wait(2)).error.code, -32602);
    assert.equal(calls.length, before);
  } finally {
    child.stdin.end();
    await new Promise((r) => child.once('exit', r));
    lines.close();
  }
});

test('explicit file list is the only authorization boundary and dispatch happens once', async () => {
  const files = [];
  for (let index = 0; index < 8; index += 1) {
    const file = join(temp, `part-${index}.txt`);
    await writeFile(file, 'a'.repeat(131072));
    files.push(file);
  }
  calls.length = 0;
  const accepted = await bridge.ask('mimo', 'Read all authorized parts', 3, { files });
  assert.equal(accepted.status, 'completed');
  assert.equal(accepted.dispatch_count, 1);
  const dispatches = calls.filter((call) => call.name === 'hub_dispatch_cli');
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].args.attachments.length, 8);
  assert.ok(!JSON.stringify(dispatches[0].args).includes(temp));
});

test('attachment limit, type, symlink, directory and unreadable failures never dispatch', async () => {
  const small = join(temp, 'small.txt');
  await writeFile(small, 'x');
  const tooMany = Array.from({ length: 9 }, (_, index) => join(temp, `many-${index}.txt`));
  for (const file of tooMany) await writeFile(file, 'x');
  const oversized = join(temp, 'oversized.txt');
  await writeFile(oversized, 'y'.repeat(1024 * 1024 + 1));
  const link = join(temp, 'link.txt');
  await symlink(small, link);
  const directory = join(temp, 'directory');
  await mkdir(directory);
  const unreadable = join(temp, 'unreadable.txt');
  await writeFile(unreadable, 'secret');
  await chmod(unreadable, 0o000);
  const fakeImage = join(temp, 'fake.png');
  await writeFile(fakeImage, 'NOT_A_PNG');
  const cases = [
    { files: tooMany, code: 'ATTACHMENT_LIMIT_EXCEEDED', stage: 'validation' },
    { files: [oversized], code: 'ATTACHMENT_LIMIT_EXCEEDED', stage: 'validation' },
    { files: [link], code: 'ATTACHMENT_ACCESS_DENIED', stage: 'validation' },
    { files: [directory], code: 'ATTACHMENT_UNREADABLE', stage: 'validation' },
    { files: [unreadable], code: 'blocked_permission', stage: 'validation' },
  ];
  try {
    for (const item of cases) {
      calls.length = 0;
      const result = await bridge.dispatchOnly('mimo', 'Must never dispatch', 3, { files: item.files });
      assert.equal(result.ok, false);
      assert.equal(result.ref, '');
      assert.equal(result.status, 'failed');
      assert.equal(result.error_code, item.code);
      assert.equal(result.failure_stage, item.stage);
      assert.equal(result.dispatch_count, 0);
      assert.equal(calls.length, 0);
    }
  } finally {
    await chmod(unreadable, 0o600);
  }
  // The image signature itself is a Hub-side check; this only proves the
  // client did not silently downgrade a declared image to a text attachment.
  assert.equal((await bridge.dispatchOnly('mimo', 'Image fixture', 3, { files: [fakeImage] })).ok, true);
});

test('fetch and budget results always echo the original ref and never add a dispatch', async () => {
  calls.length = 0;
  const fetch = await bridge.fetchRef(ref);
  assert.equal(fetch.ref, ref);
  assert.equal(calls.filter((call) => call.name === 'hub_dispatch_cli').length, 0);
  const unknown = await bridge.fetchRef('mimocode-ffffffff');
  assert.equal(unknown.ref, 'mimocode-ffffffff');
  assert.equal(unknown.status, 'unknown');
});

test.after(async () => {
  await new Promise((r) => hub.close(r));
  assert.equal(resolve(temp).startsWith(resolve(os.tmpdir()) + '\\') || resolve(temp).startsWith(resolve(os.tmpdir()) + '/'), true);
  await rm(temp, { recursive: true, force: true });
});
