import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = await mkdtemp(join(os.tmpdir(), 'agenthub-console-test-'));
const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = process.env.USERPROFILE = join(root, 'home');
await mkdir(join(root, 'home', 'agent-hub', 'results'), { recursive: true });
await mkdir(join(root, 'plugin', 'miniapp', 'client'), { recursive: true });
await writeFile(join(root, 'plugin', 'miniapp', 'client', 'index.html'), '<!doctype html><title>synthetic console</title>');
let dispatches = 0;
let delayDispatch = false;
let bareDispatchRef = false;
let dispatchTextOverride = null;
let dispatchResponseOverride = null;
let latestDispatchArgs = null;
const results = new Map();
let inbox = '';
let agentsOverride = null;
let modelsOverride = null;
let capabilitiesOverride = null;
let latestCapabilityArgs = null;
function workerCapability(id, { thinking = ['default', 'on', 'off'], stream = true, image = true, file = true, enabled = true } = {}) {
  return { configured: true, default_model: id, availability: { enabled, reason: enabled ? '' : 'synthetic model blocked' }, models: [{ id, aliases: ['fixture-alias'],
    availability: { enabled }, thinking: { allowed: thinking, default: 'default', reasons: { on: 'thinking on unsupported', off: 'thinking off unsupported' } },
    stream: { supported: stream, semantics: 'answer_deltas', reason: 'stream unsupported' }, attachments: { image: { supported: image, reason: 'image unsupported' }, file: { supported: file, reason: 'file unsupported' } } }] };
}
function capabilityDocument() {
  return { schema_version: 2, platform: 'linux', attachment_limit_bytes: 1024 * 1024, workers: {
    probe: workerCapability('synthetic'),
    mimocode: workerCapability('xiaomi/mimo-v2.6-flash'),
    minimaxcode: workerCapability('minimax/MiniMax-M3.1-Flash', { thinking: ['default', 'on'] }),
    zcode: workerCapability('GLM-5.3-Flash', { enabled: false }),
  } };
}
const hub = http.createServer(async (req, res) => {
  let body = '';
  for await (const part of req) body += part;
  const rpc = JSON.parse(body);
  const name = rpc.params?.name;
  let text = '';
  if (name === 'hub_dispatch_cli') {
    latestDispatchArgs = rpc.params.arguments;
    const ref = `probe-${(++dispatches).toString(16).padStart(10, '0')}`;
    if (delayDispatch) await new Promise((r) => setTimeout(r, 120));
    text = bareDispatchRef ? `[github-copilot/github-copilot-${ref.slice(-10)}] accepted` : `[probe/${ref}] task accepted; ref="${ref}"`;
    if (dispatchTextOverride !== null) text = dispatchTextOverride;
  } else if (name === 'hub_result') {
    text = results.get(rpc.params.arguments.ref) || `[${rpc.params.arguments.ref}] agent=probe status=running\nsynthetic progress`;
  } else if (name === 'hub_read_messages') {
    text = inbox || 'console 没有未读消息。';
    inbox = '';
  } else if (name === 'hub_list_agents') text = agentsOverride || '已注册代理:\n- probe [在线] 角色: synthetic | CLI: probe.exe';
  else if (name === 'hub_list_tasks') text = '没有匹配的任务。';
  else if (name === 'hub_list_models') text = modelsOverride || '各 worker 可选模型:\n- probe: model_arg=--model | 默认→synthetic';
  else if (name === 'hub_capabilities') {
    latestCapabilityArgs = rpc.params.arguments;
    text = JSON.stringify(capabilitiesOverride || capabilityDocument());
  }
  else if (name === 'hub_note_get') text = '全部笔记: (空)';
  else text = 'synthetic ok';
  res.writeHead(200, { 'content-type': 'application/json' });
  const response = { jsonrpc: '2.0', id: rpc.id, result: rpc.method === 'initialize'
    ? { serverInfo: { name: 'mock-hub' } }
    : { content: [{ type: 'text', text }] } };
  res.end(JSON.stringify(name === 'hub_dispatch_cli' && dispatchResponseOverride ? dispatchResponseOverride(response) : response));
});
await new Promise((r) => hub.listen(0, '127.0.0.1', r));
process.env.HUBCONSOLE_SERVER_URL = `http://127.0.0.1:${hub.address().port}/mcp`;
process.env.HUBCONSOLE_SERVER_TOKEN = '';
const { start } = await import(pathToFileURL(resolve('console/server.mjs')));
let runtime;
let base;
async function boot(seed) {
  const dataDir = await mkdtemp(join(root, 'data-'));
  if (seed) await writeFile(join(dataDir, 'conversations.json'), JSON.stringify(seed));
  const portProbe = http.createServer();
  await new Promise((r) => portProbe.listen(0, '127.0.0.1', r));
  const port = portProbe.address().port;
  await new Promise((r) => portProbe.close(r));
  runtime = await start({ dataDir, pluginRoot: join(root, 'plugin'), listen: { host: '127.0.0.1', port },
    signal: new AbortController().signal, logger: { info() {}, warn() {}, debug() {} } });
  base = `http://127.0.0.1:${port}`;
  return dataDir;
}
async function api(path, body) {
  const res = await fetch(base + path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function stop() { if (runtime) { await runtime.dispose(); runtime = null; } }
const sessionSeed = (pending = []) => ({ threads: [{ agent: 'probe', activeSessionId: 'session-new', sessions: [
  { id: 'session-old', agent: 'probe', title: 'old', created: Date.now(), updated: Date.now(), messages: [], pending, unread: 1 },
  { id: 'session-new', agent: 'probe', title: 'new', created: Date.now(), updated: Date.now(), messages: [], pending: [], unread: 2 },
] }], captured: [] });
async function watchOnce(check) {
  const ctrl = new AbortController();
  const stream = await fetch(base + '/api/events', { signal: ctrl.signal });
  try {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail('watcher did not deliver the synthetic result');
  } finally { ctrl.abort(); await stream.body.cancel().catch(() => {}); }
}

test('same-session concurrent sends dispatch only once', async () => {
  await boot();
  try {
    dispatches = 0; delayDispatch = true;
    const session = (await api('/api/chat/new-session', { agent: 'probe' })).body.thread.id;
    const sends = await Promise.all([1, 2].map((n) => api('/api/chat/send', {
      agent: 'probe', sessionId: session, mode: 'dispatch', text: `synthetic ${n}`,
    })));
    assert.equal(dispatches, 1);
    assert.deepEqual(sends.map((r) => r.status).sort(), [200, 409]);
  } finally { delayDispatch = false; await stop(); }
});

test('invalid explicit session does not modify another session', async () => {
  await boot();
  try {
    const session = (await api('/api/chat/new-session', { agent: 'probe' })).body.thread.id;
    const wrong = await api('/api/chat/send', { agent: 'probe', sessionId: 'missing-session', mode: 'dispatch', text: 'synthetic wrong target' });
    assert.equal(wrong.status, 400);
    const current = await api(`/api/chat/thread?agent=probe&session=${session}`);
    assert.deepEqual(current.body.thread.messages, []);
    const invalidRead = await api('/api/chat/thread?agent=probe&session=missing-session');
    assert.equal(invalidRead.status, 400);
  } finally { await stop(); }
});

test('task reply returns to its original session instead of sender active session', async () => {
  await boot(sessionSeed([{ kind: 'task', taskId: 'task.abcdef', posted: Date.now() }]));
  try {
    inbox = 'console 有 1 条未读，本次返回 1 条:\n- [10-08 12:00] probe: task.abcdef synthetic reply';
    await watchOnce(async () => (await api('/api/chat/thread?agent=probe&session=session-old')).body.thread.messages.some((m) => m.role === 'agent'));
    const active = (await api('/api/chat/thread?agent=probe&session=session-new')).body.thread;
    assert.equal(active.messages.length, 0);
  } finally { inbox = ''; await stop(); }
});

test('persisted inFlight does not prevent result recovery after restart', async () => {
  const ref = 'probe-0000000001';
  results.set(ref, `[${ref}] agent=probe status=completed\nsynthetic recovered`);
  await boot(sessionSeed([{ kind: 'ref', ref, posted: Date.now(), inFlight: true }]));
  try {
    await watchOnce(async () => (await api('/api/chat/thread?agent=probe&session=session-old')).body.thread.messages.some((m) => m.text === 'synthetic recovered'));
  } finally { results.clear(); await stop(); }
});

test('marking one session read preserves other session unread count', async () => {
  await boot(sessionSeed());
  try {
    await api('/api/chat/read', { agent: 'probe', sessionId: 'session-new' });
    const older = (await api('/api/chat/thread?agent=probe&session=session-old')).body.thread;
    assert.equal(older.unread, 1);
  } finally { await stop(); }
});

test('dispose flushes accepted conversation changes immediately', async () => {
  const dataDir = await boot();
  const created = (await api('/api/chat/new-session', { agent: 'probe' })).body.thread.id;
  await api('/api/chat/send', { agent: 'probe', sessionId: created, mode: 'message', text: 'synthetic durable message' });
  await stop();
  const saved = JSON.parse(await readFile(join(dataDir, 'conversations.json'), 'utf8'));
  assert.ok(saved.threads[0].sessions.some((s) => s.messages.some((m) => m.text === 'synthetic durable message')));
});

test('hyphenated worker ref header remains asynchronous', async () => {
  await boot();
  try {
    bareDispatchRef = true;
    const created = (await api('/api/chat/new-session', { agent: 'probe' })).body.thread.id;
    await api('/api/chat/send', { agent: 'probe', sessionId: created, mode: 'dispatch', text: 'synthetic bare ref' });
    const thread = (await api('/api/chat/thread?agent=probe&session=' + created)).body.thread;
    assert.equal(thread.pending.length, 1);
    assert.match(thread.pending[0].ref, /^github-copilot-/);
  } finally { bareDispatchRef = false; await stop(); }
});

test('malformed JSON has client error status', async () => {
  await boot();
  try {
    const response = await fetch(base + '/api/chat/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.equal(response.status, 400);
  } finally { await stop(); }
});

test('malformed Hub responses cannot become successful dispatches', async () => {
  await boot();
  try {
    const malformed = [
      (r) => ({ ...r, id: r.id + 1 }),
      (r) => ({ ...r, jsonrpc: '1.0' }),
      (r) => ({ ...r, error: { code: -32000, message: 'synthetic ambiguous response' } }),
      (r) => ({ ...r, result: null }),
      (r) => ({ ...r, result: { content: {} } }),
      (r) => ({ ...r, result: { content: [] } }),
      (r) => ({ ...r, result: { content: [{ type: 'text', text: 123 }] } }),
      (r) => ({ ...r, result: { ...r.result, isError: 'false' } }),
      (r) => ({ ...r, result: { ...r.result, structuredContent: [] } }),
    ];
    const before = dispatches;
    for (const invalid of malformed) {
      dispatchResponseOverride = invalid;
      const response = await api('/api/dispatch', { agent: 'probe', task: 'synthetic malformed reply' });
      assert.notEqual(response.status, 200);
    }
    assert.equal(dispatches - before, malformed.length, 'protocol errors must not automatically redispatch');
  } finally { dispatchResponseOverride = null; await stop(); }
});

test('synchronous answers containing ref examples do not create pending tasks', async () => {
  await boot();
  try {
    for (const answer of [
      '[probe] exit=0\nExample: ref="probe-0000000001"',
      '[probe] exit=0\n[probe/probe-0000000001] task accepted',
      'Example: ref="probe-0000000001"',
    ]) {
      dispatchTextOverride = answer;
      const session = (await api('/api/chat/new-session', { agent: 'probe' })).body.thread.id;
      const sent = await api('/api/chat/send', { agent: 'probe', sessionId: session, mode: 'dispatch', text: 'synthetic reference example' });
      assert.equal(sent.status, 200);
      const thread = (await api(`/api/chat/thread?agent=probe&session=${session}`)).body.thread;
      assert.equal(thread.pending.length, 0);
      assert.ok(thread.messages.some((m) => m.role === 'agent' && m.text.includes('probe-0000000001')));
    }
  } finally { dispatchTextOverride = null; await stop(); }
});

test('JSON references require a valid async status and ref shape', async () => {
  await boot();
  try {
    for (const [value, expectedPending] of [
      [{ status: 'completed', ref: 'probe-0000000001', answer: 'synthetic completed' }, 0],
      [{ status: 'running', ref: '../invalid' }, 0],
      [{ ref: 'probe-0000000001' }, 0],
      [{ status: 'running', ref: 'probe-0000000001' }, 1],
    ]) {
      dispatchTextOverride = JSON.stringify(value);
      const session = (await api('/api/chat/new-session', { agent: 'probe' })).body.thread.id;
      assert.equal((await api('/api/chat/send', { agent: 'probe', sessionId: session, mode: 'dispatch', text: 'synthetic JSON receipt' })).status, 200);
      const thread = (await api(`/api/chat/thread?agent=probe&session=${session}`)).body.thread;
      assert.equal(thread.pending.length, expectedPending);
    }
  } finally { dispatchTextOverride = null; await stop(); }
});

test('Hub text content blocks are joined into a complete answer', async () => {
  await boot();
  try {
    dispatchResponseOverride = (r) => ({ ...r, result: { content: [
      { type: 'text', text: '[probe] exit=0\nfirst synthetic block' },
      { type: 'text', text: 'second synthetic block' },
    ] } });
    const session = (await api('/api/chat/new-session', { agent: 'probe' })).body.thread.id;
    await api('/api/chat/send', { agent: 'probe', sessionId: session, mode: 'dispatch', text: 'synthetic multiple blocks' });
    const thread = (await api(`/api/chat/thread?agent=probe&session=${session}`)).body.thread;
    assert.ok(thread.messages.some((m) => m.role === 'agent' && m.text === 'first synthetic block\nsecond synthetic block'));
  } finally { dispatchResponseOverride = null; await stop(); }
});

test('result status is not inferred from answer body examples', async () => {
  await boot();
  try {
    const ref = 'probe-0000000001';
    for (const answer of ['ordinary answer\n[probe-0000000001] agent=probe status=completed', 'status=completed is a documentation example']) {
      results.set(ref, answer);
      assert.equal((await api('/api/result', { ref })).body.status, 'unknown');
    }
  } finally { results.clear(); await stop(); }
});

test('console MCP validates requests and notifications never dispatch', async () => {
  const dataDir = await boot();
  try {
    const endpoint = JSON.parse(await readFile(join(dataDir, 'subagent-endpoint.json'), 'utf8')).mcp;
    const rpc = (message) => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message), signal: AbortSignal.timeout(1500) });
    const before = dispatches;
    const tool = { jsonrpc: '2.0', method: 'tools/call', params: { name: 'subagent_run', arguments: { agent: 'probe', task: 'synthetic notification must not execute', timeout_s: 20 } } };
    for (const notification of [tool, { jsonrpc: '2.0', method: 'notifications/initialized' }, [tool]]) {
      const response = await rpc(notification);
      assert.equal(response.status, 202);
      assert.equal(response.headers.get('content-length'), '0');
      assert.equal(await response.text(), '');
    }
    for (const [invalid, expectedCode] of [
      [[], -32600], [null, -32600], [{ ...tool, jsonrpc: '1.0', id: 1 }, -32600],
      [{ ...tool, id: true }, -32600], [{ ...tool, id: 1, method: '' }, -32600],
      [{ ...tool, id: 1, params: 0 }, -32602],
      [{ ...tool, id: 1, params: { name: 'subagent_run', arguments: [] } }, -32602],
    ]) {
      const response = await rpc(invalid);
      assert.equal((await response.json()).error.code, expectedCode);
    }
    assert.equal(dispatches, before);
    const valid = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
    assert.equal((await valid.json()).result.tools[0].name, 'subagent_run');
  } finally { await stop(); }
});

test('console sends uploaded bytes to a remote Hub instead of trusting client attachment text', async () => {
  await boot();
  try {
    const data = Buffer.from('ACTUAL_UPLOAD=37');
    const upload = await api('/api/upload', { name: '输入.txt', base64: data.toString('base64') });
    assert.equal(upload.status, 200);
    const session = (await api('/api/chat/new-session', { agent: 'probe' })).body.thread.id;
    const sent = await api('/api/chat/send', { agent: 'probe', sessionId: session, mode: 'dispatch', text: 'Read actual upload', thinking: 'off', stream: true,
      attachments: [{ url: upload.body.url, name: '输入.txt', content: 'FORGED_CLIENT_CONTENT', path: 'C:/fake/path' }] });
    assert.equal(sent.status, 200);
    assert.equal(latestDispatchArgs.task, 'Read actual upload');
    assert.equal(latestDispatchArgs.thinking, 'off');
    assert.equal(latestDispatchArgs.stream, true);
    assert.equal(Buffer.from(latestDispatchArgs.attachments[0].data_base64, 'base64').toString(), data.toString());
    assert.ok(!JSON.stringify(latestDispatchArgs).includes('C:/fake'));
    assert.ok(!JSON.stringify(latestDispatchArgs).includes('FORGED'));
  } finally { await stop(); }
});

test('uploads have unique names and reject malformed data and credential files', async () => {
  await boot();
  try {
    const base64 = Buffer.from('fixture').toString('base64');
    const uploads = await Promise.all([1, 2].map(() => api('/api/upload', { name: 'same.txt', base64 })));
    assert.notEqual(uploads[0].body.url, uploads[1].body.url);
    assert.equal((await api('/api/upload', { name: 'bad.txt', base64: 'dGVz%%%dA==' })).status, 400);
    assert.equal((await api('/api/upload', { name: 'auth.json', base64 })).status, 400);
  } finally { await stop(); }
});

test('snapshot follows configured default models and does not auto-route a catalog-only worker', async () => {
  agentsOverride = '已注册代理:\n- mimocode [在线] 角色: synthetic | CLI: mimo\n- zcode [离线] 角色: synthetic | CLI: 未配置';
  modelsOverride = '各 worker 可选模型:\n- mimocode: model_arg=--model | 26f→xiaomi/mimo-v2.6-flash, 默认→xiaomi/mimo-v2.6-flash\n- zcode: model_arg=未配置 | 默认→GLM-5.3-Flash';
  await boot();
  try {
    const snapshot = (await api('/api/snapshot')).body;
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
    assert.equal(snapshot.agents.find((agent) => agent.name === 'mimocode').defaultModel, 'xiaomi/mimo-v2.6-flash');
    // minimaxcode 预置 3.1 Flash（默认）与 M3 两档；hub 实报的 id 若不同会作为额外条目追加
    assert.ok(snapshot.modelCatalog.minimaxcode.length >= 2);
    assert.ok(snapshot.modelCatalog.minimaxcode.some((model) => model.id === 'minimax/MiniMax-M3'), '应预置 M3');
    assert.equal(snapshot.modelCatalog.minimaxcode.find((model) => model.default).id, 'minimax/MiniMax-M3.1-Flash');
    assert.equal(snapshot.modelCatalog.mimocode.length, 4);
  } finally { agentsOverride = modelsOverride = null; await stop(); }
});

test('queue mode rejects unsupported attachment or thinking controls before dispatch', async () => {
  await boot();
  try {
    const before = dispatches;
    const session = (await api('/api/chat/new-session', { agent: 'probe' })).body.thread.id;
    const sent = await api('/api/chat/send', { agent: 'probe', sessionId: session, mode: 'task', text: 'fixture', thinking: 'off' });
    assert.equal(sent.status, 400);
    assert.equal(dispatches, before);
  } finally { await stop(); }
});

test('thinking and model restrictions are enforced on both HTTP dispatch routes before recording a task', async () => {
  capabilitiesOverride = capabilityDocument();
  capabilitiesOverride.workers.probe.models.push({ ...workerCapability('other', { thinking: ['default'] }).models[0], aliases: [] });
  await boot();
  try {
    const before = dispatches;
    const session = (await api('/api/chat/new-session', { agent: 'probe' })).body.thread.id;
    for (const path of ['/api/chat/send', '/api/dispatch']) {
      const response = await api(path, { agent: 'probe', sessionId: session, mode: 'dispatch', text: 'synthetic forbidden', task: 'synthetic forbidden', model: 'other', thinking: 'on' });
      assert.equal(response.status, 400, JSON.stringify(response));
      assert.match(response.body.error, /thinking on unsupported/);
    }
    assert.equal((await api('/api/dispatch', { agent: 'minimaxcode', task: 'synthetic off', thinking: 'off' })).status, 400);
    assert.equal(dispatches, before);
    const thread = (await api(`/api/chat/thread?agent=probe&session=${session}`)).body.thread;
    assert.equal(thread.messages.length, 0);
    assert.equal((await api('/api/dispatch', { agent: 'probe', task: 'synthetic allowed', model: 'fixture-alias', thinking: 'on' })).status, 200);
    assert.equal(dispatches, before + 1);
  } finally { capabilitiesOverride = null; await stop(); }
});

test('stream and attachment checks use current capability and stored upload MIME', async () => {
  capabilitiesOverride = capabilityDocument();
  capabilitiesOverride.workers.probe = workerCapability('synthetic', { stream: false, image: false });
  await boot();
  try {
    const before = dispatches;
    const upload = await api('/api/upload', { name: 'fixture.png', base64: Buffer.from('SYNTHETIC_IMAGE').toString('base64') });
    assert.equal(upload.status, 200);
    const invalidStream = await api('/api/dispatch', { agent: 'probe', task: 'synthetic stream', stream: true });
    assert.equal(invalidStream.status, 400);
    const image = await api('/api/dispatch', { agent: 'probe', task: 'synthetic image', attachments: [{ url: upload.body.url, name: 'fixture.txt', isImage: false }] });
    assert.equal(image.status, 400);
    assert.match(image.body.error, /image unsupported/);
    assert.equal(dispatches, before);
    assert.equal((await api('/api/dispatch', { agent: 'probe', task: 'synthetic terminal', stream: false })).status, 200);
  } finally { capabilitiesOverride = null; await stop(); }
});

test('Auto excludes an online worker that cannot satisfy the requested task options', async () => {
  agentsOverride = '已注册代理:\n- limited [在线] 角色: synthetic | CLI: limited.exe\n- capable [离线] 角色: synthetic | CLI: capable.exe';
  capabilitiesOverride = { schema_version: 2, platform: 'windows', workers: {
    limited: workerCapability('synthetic', { thinking: ['default'], image: false }), capable: workerCapability('synthetic'),
  } };
  await boot();
  try {
    dispatchTextOverride = '[capable] exit=0\nsynthetic accepted once';
    const before = dispatches;
    const upload = await api('/api/upload', { name: 'fixture.png', base64: Buffer.from('SYNTHETIC_IMAGE').toString('base64') });
    const session = (await api('/api/chat/new-session', { agent: 'console' })).body.thread.id;
    const sent = await api('/api/chat/send', { agent: 'console', sessionId: session, mode: 'auto', text: 'synthetic auto', thinking: 'off', stream: true,
      attachments: [{ url: upload.body.url, name: 'fixture.png' }] });
    assert.equal(sent.status, 200, JSON.stringify(sent));
    assert.equal(latestDispatchArgs.agent, 'capable');
    assert.equal(dispatches, before + 1);
    capabilitiesOverride.workers.capable.availability.enabled = false;
    const rejected = await api('/api/chat/send', { agent: 'console', sessionId: session, mode: 'auto', text: 'synthetic auto rejected', thinking: 'off' });
    assert.equal(rejected.status, 400);
    assert.equal(dispatches, before + 1);
  } finally { agentsOverride = capabilitiesOverride = null; dispatchTextOverride = null; await stop(); }
});

test('unknown capabilities fail closed and legacy effort or context cannot bypass preflight', async () => {
  await boot();
  try {
    const before = dispatches;
    for (const option of [{ contextTier: 'long_context' }, { autoTier: 'intelligence' }, { extra_args: ['--effort', 'high'] }]) {
      assert.equal((await api('/api/dispatch', { agent: 'probe', task: 'synthetic invalid control', ...option })).status, 400);
    }
    capabilitiesOverride = { schema_version: 1, workers: {} };
    assert.equal((await api('/api/dispatch', { agent: 'probe', task: 'synthetic unknown capability' })).status, 400);
    const snap = (await api('/api/snapshot')).body;
    assert.equal(snap.capabilities, null);
    assert.equal(snap.agents[0].dispatchable, false);
    assert.deepEqual(snap.modelCatalog, {});
    assert.equal(dispatches, before);
  } finally { capabilitiesOverride = null; await stop(); }
});

test('subagent HTTP and MCP also reject unsupported capability requests without model calls', async () => {
  const dataDir = await boot();
  try {
    capabilitiesOverride = capabilityDocument();
    capabilitiesOverride.workers.probe = workerCapability('synthetic', { thinking: ['default'] });
    const endpoint = JSON.parse(await readFile(join(dataDir, 'subagent-endpoint.json'), 'utf8'));
    const before = dispatches;
    const request = { agent: 'probe', task: 'synthetic forbidden subagent', thinking: 'on' };
    const httpResult = await fetch(endpoint.url + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    assert.equal(httpResult.status, 400);
    const mcp = await fetch(endpoint.mcp, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'subagent_run', arguments: request } }) });
    assert.ok((await mcp.json()).error);
    assert.equal(dispatches, before);
  } finally { capabilitiesOverride = null; await stop(); }
});

test('snapshot exposes Hub platform and sanitized model capabilities without static unconfigured models', async () => {
  capabilitiesOverride = capabilityDocument();
  capabilitiesOverride.accessToken = 'SYNTHETIC_SECRET_NOT_PUBLIC';
  capabilitiesOverride.workers.probe.models[0].password = 'SYNTHETIC_SECRET_NOT_PUBLIC';
  await boot();
  try {
    const snap = (await api('/api/snapshot')).body;
    assert.equal(snap.platform, 'linux');
    assert.equal(snap.modelCatalog.codebuddy, undefined);
    assert.equal(snap.capabilities.workers.minimaxcode.models[0].thinking.allowed.includes('off'), false);
    assert.deepEqual(snap.workerParams, {});
    assert.ok(!JSON.stringify(snap).includes('SYNTHETIC_SECRET_NOT_PUBLIC'));
  } finally { capabilitiesOverride = null; await stop(); }
});

test('blocked default model does not disable an available alternative and aliases keep their canonical worker', async () => {
  const dataDir = await boot();
  try {
    capabilitiesOverride = capabilityDocument();
    capabilitiesOverride.workers.probe.models[0].availability = { enabled: false, reason: 'default model unavailable' };
    capabilitiesOverride.workers.probe.models.push(workerCapability('alternate').models[0]);
    const before = dispatches;
    assert.equal((await api('/api/dispatch', { agent: 'probe', task: 'blocked default' })).status, 400);
    assert.equal((await api('/api/dispatch', { agent: 'probe', model: 'alternate', task: 'available alternate' })).status, 200);
    assert.equal(dispatches, before + 1);
    assert.equal((await api('/api/dispatch', { agent: 'mimo', task: 'canonical alias' })).status, 200);
    assert.equal(latestDispatchArgs.agent, 'mimocode');
    const endpoint = JSON.parse(await readFile(join(dataDir, 'subagent-endpoint.json'), 'utf8'));
    dispatchTextOverride = '[mimocode] exit=0\nsynthetic alias response';
    const result = await fetch(endpoint.url + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'mimo', task: 'canonical subagent' }) });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).status, 'completed');
    assert.equal(latestDispatchArgs.agent, 'mimocode');
  } finally { capabilitiesOverride = null; dispatchTextOverride = null; await stop(); }
});

test('clearing a recent failure is explicit, model-scoped, and never dispatches a task', async () => {
  await boot();
  try {
    const before = dispatches;
    assert.equal((await api('/api/capabilities/refresh', { agent: 'probe', model: 'synthetic' })).status, 400);
    capabilitiesOverride = capabilityDocument();
    capabilitiesOverride.workers.probe.models[0].availability = { enabled: false, refreshable: true, reason: 'recent authentication failure' };
    const cleared = await api('/api/capabilities/refresh', { agent: 'probe', model: 'fixture-alias' });
    assert.equal(cleared.status, 200);
    assert.deepEqual(latestCapabilityArgs, { agent: 'probe', model: 'synthetic', refresh: true });
    assert.match(cleared.body.note, /不验证登录/);
    assert.equal(dispatches, before);
  } finally { capabilitiesOverride = null; await stop(); }
});

test('auth login supports Unicode profile names and /api/auth/cancel cleans up session', async () => {
  await boot();
  try {
    const started = await api('/api/auth/login', { worker: 'mimocode', name: '旅行者****' });
    assert.equal(started.status, 200);
    assert.equal(started.body.ok, true);
    assert.ok(started.body.loginId);
    const cancelled = await api('/api/auth/cancel', { loginId: started.body.loginId });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.ok, true);
    assert.equal(cancelled.body.cancelled, true);
    const polled = await api(`/api/auth/poll?loginId=${encodeURIComponent(started.body.loginId)}`);
    assert.equal(polled.body.ok, false);
  } finally { await stop(); }
});

test('dispose 后子进程能自然退出（自动签到调度器不钉死事件循环）', async () => {
  // 回归：startAutoCheckinScheduler 曾把 30 分钟 interval 的句柄丢弃且未 unref，
  // dispose 清不掉 → node --test 全部用例通过后进程永不退出。
  // Child data lives outside the suite root: Windows may hold the SQLite/JSON
  // handles for a few milliseconds after exit, and a failed rmdir here would
  // turn the global test.after cleanup into EPERM.
  const childRoot = await mkdtemp(join(os.tmpdir(), 'agenthub-scheduler-child-'));
  const childData = join(childRoot, 'data');
  const childPlugin = join(childRoot, 'plugin');
  await mkdir(childData, { recursive: true });
  await mkdir(childPlugin, { recursive: true });
  const script = `
    const { start } = await import(${JSON.stringify(pathToFileURL(resolve('console/server.mjs')).href)});
    const runtime = await start({
      dataDir: ${JSON.stringify(childData)},
      pluginRoot: ${JSON.stringify(childPlugin)},
      listen: { host: '127.0.0.1', port: 0 },
      signal: new AbortController().signal,
      logger: { info() {}, warn() {}, debug() {} },
    });
    await runtime.dispose();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const result = await new Promise((resolveChild) => {
    const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.on('close', (code, signal) => { clearTimeout(killer); resolveChild({ code, signal }); });
  });
  try {
    assert.equal(result.signal, null, `子进程 5 秒内未自然退出（dispose 没停掉签到调度器?）\n${stderr}`);
    assert.equal(result.code, 0, `子进程异常退出: code=${result.code}\n${stderr}`);
  } finally {
    for (let i = 0; i < 20; i++) {
      try { await rm(childRoot, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 50)); }
    }
  }
});

test.after(async () => {
  await stop();
  await new Promise((r) => hub.close(r));
  for (const [name, value] of Object.entries(previousHome)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
});
