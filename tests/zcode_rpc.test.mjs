import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppServer, selectModel, TurnEvents, runZcodeTask, parseArguments } from '../drivers/zcode_rpc.mjs';

const selected = { providerId: 'official', modelId: 'test-model', options: {} };
const options = { model: 'official/test-model', task: 'Return the public marker.', timeoutMs: 10000 };
const event = (seq, type, payload = {}, sessionId = 'own-task') => ({ eventId: 'event-' + seq, sessionId, seq, type, payload });
const complete = response => [event(1, 'turn.started'), event(2, 'turn.completed', { resultType: 'success', response, usage: { inputTokens: 12, reasoningTokens: 0, privateValue: 'not published' } })];
const part = (partId, type = 'text', messageId = 'assistant-message') => ({ partId, sessionId: 'own-task', messageId, type });

function fixture(config = {}) {
  const calls = []; let creates = 0, clock = 0, shutdown = false, runtimeDirectory;
  const rpc = {
    notifications: [], interactiveRequest: false,
    async request(method, params) {
      calls.push({ method, params });
      if (config.onRequest) await config.onRequest(method, params, rpc);
      if (method === 'session/create') {
        creates++;
        if (config.expireOnCreate) clock += 10001;
        return { session: { sessionId: creates === 1 ? 'own-catalog' : 'own-task', model: config.actualModel || selected },
          settings: { model: { available: (config.catalog || [selected]).map(ref => ({ ref })), ...(config.currentModel ? { current: config.currentModel } : {}) } } };
      }
      if (method === 'session/close') return { closed: true };
      if (method === 'session/subscribe') return config.subscription || { eventSeq: 0, events: [] };
      if (method === 'session/send') {
        if (config.sendError) throw new Error('Transport disconnected');
        return { accepted: config.accepted !== false };
      }
      if (method === 'session/events') return { events: config.events ?? complete('HUB_TEST_OK') };
      if (method === 'session/read') return { messages: config.messages || [] };
      throw new Error('Unexpected method ' + method);
    },
    async shutdown() { shutdown = true; if (config.shutdownError) throw new Error('Shutdown failed'); },
  };
  return { calls, rpc, get shutdown() { return shutdown; }, get runtimeDirectory() { return runtimeDirectory; },
    dependencies: { connect: async ({ directory }) => { runtimeDirectory = directory; return rpc; }, now: () => clock,
      pause: async () => { clock += 1000; } } };
}

test('catalog selection requires an available unique explicit model and accepts empty options', () => {
  const snapshot = refs => ({ settings: { model: { available: refs.map(ref => ({ ref })) } } });
  assert.deepEqual(selectModel(snapshot([selected]), 'OFFICIAL/TEST-MODEL'), selected);
  assert.deepEqual(selectModel(snapshot([selected]), 'test-model'), selected);
  assert.throws(() => selectModel(snapshot([selected]), 'GLM-5.3-Flash'), error => error.code === 'MODEL_UNAVAILABLE');
  assert.throws(() => selectModel(snapshot([selected, { providerId: 'other', modelId: 'test-model' }]), 'test-model'), error => error.code === 'MODEL_AMBIGUOUS');
  assert.throws(() => selectModel(snapshot([{ ...selected, options: { temperature: 1 } }]), 'test-model'), error => error.code === 'MODEL_OPTIONS_UNSUPPORTED');
});

test('missing model and unsupported thinking stop before starting a server', async () => {
  const f = fixture();
  assert.equal((await runZcodeTask({ ...options, model: '' }, f.dependencies)).status, 'blocked_model');
  assert.equal((await runZcodeTask({ ...options, thinking: 'off' }, f.dependencies)).error.code, 'UNSUPPORTED_THINKING');
  assert.equal((await runZcodeTask({ ...options, thinking: 'on' }, f.dependencies)).error.code, 'UNSUPPORTED_THINKING');
  assert.equal(f.calls.length, 0);
});

test('catalog refs missing reasoning options preserve only the same official current model setting', () => {
  const ref = { providerId: 'official', modelId: 'wx/test-model' };
  const current = { ...ref, options: { reasoningLevel: 'max' } };
  const snapshot = { settings: { model: { available: [{ ref }], current } } };
  assert.deepEqual(selectModel(snapshot, 'wx/test-model'), current);
  snapshot.settings.model.current = { providerId: 'other', modelId: 'another-model', options: { reasoningLevel: 'max' } };
  assert.deepEqual(selectModel(snapshot, 'wx/test-model'), ref);
});

test('official snapshot model identity and current options are separately checked before send', async () => {
  const identity = { providerId: 'official', modelId: 'wx/test-model' };
  const current = { ...identity, options: { reasoningLevel: 'max' } };
  const f = fixture({ catalog: [identity], actualModel: identity, currentModel: current });
  assert.equal((await runZcodeTask({ ...options, model: identity.modelId }, f.dependencies)).status, 'completed');
  assert.deepEqual(f.calls.filter(call => call.method === 'session/create')[1].params.model, current);
  assert.equal(f.calls.filter(call => call.method === 'session/create')[1].params.thoughtLevel, 'max');
  const mismatch = fixture({ catalog: [identity], actualModel: { providerId: 'wrong', modelId: identity.modelId }, currentModel: current });
  assert.equal((await runZcodeTask({ ...options, model: identity.modelId }, mismatch.dependencies)).status, 'blocked_model');
  assert.equal(mismatch.calls.some(call => call.method === 'session/send'), false);
});

test('real official metadata fixtures cover bootstrap, dropped options, and explicit thoughtLevel shapes', async () => {
  const captured = JSON.parse(await readFile(new URL('./fixtures/zcode_rpc_metadata.json', import.meta.url), 'utf8'));
  const [bootstrap, dropped, retained] = captured.fixtures;
  assert.equal(bootstrap.settings.model.current.options.reasoningLevel, 'max');
  assert.equal(bootstrap.session.model.options, undefined);
  assert.equal(dropped.settings.model.current.options, undefined);
  assert.equal(dropped.settings.thoughtLevel.current, undefined);
  assert.equal(retained.settings.model.current.options.reasoningLevel, 'max');
  assert.equal(retained.settings.thoughtLevel.current, 'max');
  for (const [snapshot, expectedStatus] of [[dropped, 'blocked_model'], [retained, 'completed']]) {
    const f = fixture(); let creates = 0;
    const original = f.rpc.request.bind(f.rpc);
    f.rpc.request = async (method, params) => {
      const value = await original(method, params);
      if (method !== 'session/create') return value;
      const actual = structuredClone(++creates === 1 ? bootstrap : snapshot);
      actual.session.sessionId = creates === 1 ? 'own-catalog' : 'own-task';
      return actual;
    };
    const output = await runZcodeTask({ ...options, model: 'wx/Deepseek-v4-flash' }, f.dependencies);
    assert.equal(output.status, expectedStatus);
    assert.equal(f.calls.filter(call => call.method === 'session/create')[1].params.thoughtLevel, 'max');
    assert.equal(f.calls.filter(call => call.method === 'session/send').length, expectedStatus === 'completed' ? 1 : 0);
  }
});

test('unavailable default model closes its own deferred catalog session without sending', async () => {
  const f = fixture();
  const output = await runZcodeTask({ ...options, model: 'GLM-5.3-Flash' }, f.dependencies);
  assert.equal(output.status, 'blocked_model'); assert.equal(output.error.code, 'MODEL_UNAVAILABLE');
  assert.deepEqual(f.calls.map(call => call.method), ['session/create', 'session/close']);
  assert.deepEqual(f.calls[1].params, { sessionId: 'own-catalog', expectedPersistence: 'deferred' });
  assert.equal(f.shutdown, true);
  await assert.rejects(access(f.runtimeDirectory));
});

test('explicit model mismatch is rejected before generation', async () => {
  const f = fixture({ actualModel: { providerId: 'wrong', modelId: 'test-model' } });
  const output = await runZcodeTask(options, f.dependencies);
  assert.equal(output.status, 'blocked_model'); assert.equal(output.error.code, 'MODEL_SELECTION_NOT_APPLIED');
  assert.equal(f.calls.some(call => call.method === 'session/send'), false);
});

test('accepted generation uses a fresh deferred session, sends exactly once, and never changes defaults', async () => {
  const f = fixture();
  const attachments = [{ type: 'image', path: 'C:/public/synthetic.png' }];
  const output = await runZcodeTask({ ...options, attachments }, f.dependencies);
  assert.equal(output.status, 'completed'); assert.equal(output.result, 'HUB_TEST_OK');
  assert.deepEqual(output.usage, { input_tokens: 12, reasoning_tokens: 0 });
  const creates = f.calls.filter(call => call.method === 'session/create');
  assert.equal(creates.length, 2); assert.deepEqual(creates[1].params.model, selected);
  assert.match(creates[0].params.workspace.workspaceKey, /^agenthub-rpc-/);
  assert.equal(creates[1].params.persistence, 'deferred'); assert.equal(creates[1].params.mode, 'plan');
  assert.deepEqual(creates[1].params.mcpServers, []);
  assert.deepEqual(creates[1].params.toolDenylist, ['Bash', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Write', 'Edit']);
  const sends = f.calls.filter(call => call.method === 'session/send');
  assert.equal(sends.length, 1); assert.deepEqual(sends[0].params.attachments, attachments);
  assert.equal(Object.hasOwn(sends[0].params, 'modelSelection'), false);
  assert.equal(f.calls.some(call => call.method === 'session/setModel'), false);
  assert.deepEqual(f.calls.at(-1).params, { sessionId: 'own-task' });
});

test('expired preflight does not send a task after its deadline', async () => {
  const f = fixture({ expireOnCreate: true });
  const output = await runZcodeTask(options, f.dependencies);
  assert.equal(output.status, 'timeout');
  assert.equal(f.calls.some(call => call.method === 'session/send'), false);
});

test('send transport failure is unknown and is never retried or rerouted', async () => {
  const f = fixture({ sendError: true });
  const output = await runZcodeTask(options, f.dependencies);
  assert.equal(output.status, 'unknown'); assert.equal(output.is_error, true);
  assert.equal(f.calls.filter(call => call.method === 'session/send').length, 1);
  assert.deepEqual(f.calls.at(-1).params, { sessionId: 'own-task' });
});

test('unconfirmed acceptance is unknown and cleanup failures do not mask it', async () => {
  const f = fixture({ accepted: false, shutdownError: true });
  const output = await runZcodeTask(options, f.dependencies);
  assert.equal(output.status, 'unknown'); assert.equal(output.error.code, 'SEND_NOT_CONFIRMED');
  assert.equal(f.calls.filter(call => call.method === 'session/send').length, 1);
});

test('initial idle and old terminal events cannot mark a new task complete', async () => {
  const f = fixture({ subscription: { eventSeq: 9, events: [event(9, 'turn.completed', { resultType: 'success', response: 'old answer' })] },
    events: [event(10, 'turn.completed', { resultType: 'success', response: 'not started' })] });
  const output = await runZcodeTask(options, f.dependencies);
  assert.equal(output.status, 'timeout'); assert.equal(output.result, '');
});

for (const [label, events, code] of [
  ['empty', complete('  '), 'EMPTY_RESPONSE'],
  ['cancelled', [event(1, 'turn.started'), event(2, 'turn.completed', { resultType: 'cancelled', response: 'partial' })], 'TURN_CANCELLED'],
  ['execution error', [event(1, 'turn.started'), event(2, 'turn.completed', { resultType: 'error_during_execution', response: 'partial' })], 'TURN_ERROR_DURING_EXECUTION'],
  ['unknown result type', [event(1, 'turn.started'), event(2, 'turn.completed', { resultType: 'future_result', response: 'partial' })], 'TURN_INVALID_RESULT_TYPE'],
  ['turn failure', [event(1, 'turn.failed', { error: { message: 'vendor private details' } })], 'TURN_FAILED'],
]) test(label + ' terminal is an error, never successful output', async () => {
  const f = fixture({ events }); const output = await runZcodeTask(options, f.dependencies);
  assert.equal(output.status, 'failed'); assert.equal(output.error.code, code); assert.equal(output.result, '');
  assert.equal(JSON.stringify(output).includes('vendor private'), false);
});

test('interactive permission is refused without autoapproval or a second send', async () => {
  const f = fixture({ onRequest: (method, _params, rpc) => { if (method === 'session/send') rpc.interactiveRequest = true; } });
  const output = await runZcodeTask(options, f.dependencies);
  assert.equal(output.status, 'blocked_permission'); assert.equal(f.calls.filter(call => call.method === 'session/send').length, 1);
});

test('streaming requires a confirmed assistant text part; reasoning/tool/user/unknown are hidden', () => {
  const output = []; const turn = new TurnEvents('own-task', text => output.push(text));
  turn.consume(event(1, 'turn.started'));
  for (const [index, type] of ['text', 'reasoning', 'tool', 'future'].entries()) turn.consume(event(2 + index, 'part.started', { part: part('p-' + type, type) }));
  turn.consume(event(6, 'message.upserted', { content: 'do not infer an assistant role', type: 'assistant' }));
  turn.consume(event(7, 'part.delta', { partId: 'p-text', messageId: 'assistant-message', field: 'text', delta: 'public' }));
  turn.consume(event(8, 'part.delta', { partId: 'p-reasoning', messageId: 'assistant-message', field: 'text', delta: 'hidden reasoning' }));
  turn.consume(event(9, 'part.delta', { partId: 'p-tool', messageId: 'assistant-message', field: 'text', delta: 'hidden tool' }));
  turn.consume(event(10, 'part.delta', { partId: 'p-future', messageId: 'assistant-message', field: 'text', delta: 'hidden unknown' }));
  assert.deepEqual(output, []);
  turn.rememberMessages([{ info: { messageId: 'assistant-message', role: 'assistant' }, parts: [part('p-text'), part('p-reasoning', 'reasoning')] }]);
  assert.deepEqual(output, ['public']);
  turn.consume(event(11, 'part.delta', { partId: 'p-text', messageId: 'assistant-message', field: 'reasoning', delta: 'hidden field' }));
  turn.consume(event(12, 'part.delta', { partId: 'p-text', messageId: 'wrong-message', field: 'text', delta: 'wrong owner' }));
  const delta = event(13, 'part.delta', { partId: 'p-text', messageId: 'assistant-message', delta: ' continuation' });
  turn.consume(delta); turn.consume(delta);
  turn.rememberMessages([{ info: { messageId: 'user-message', role: 'user' }, parts: [part('p-user', 'text', 'user-message')] }]);
  turn.consume(event(14, 'part.delta', { partId: 'p-user', messageId: 'user-message', field: 'text', delta: 'hidden user' }));
  assert.deepEqual(output, ['public', ' continuation']);
});

test('real run stream role confirmation uses session/read and terminal output remains available', async () => {
  const stream = []; const textPart = part('public-part');
  const f = fixture({ events: [event(1, 'turn.started'), event(2, 'part.started', { part: textPart }),
    event(3, 'part.delta', { partId: textPart.partId, messageId: textPart.messageId, field: 'text', delta: 'public stream' }),
    event(4, 'turn.completed', { resultType: 'success', response: 'public stream' })],
    messages: [{ info: { messageId: 'assistant-message', role: 'assistant' }, parts: [textPart] }] });
  const output = await runZcodeTask({ ...options, stream: true }, { ...f.dependencies, onText: text => stream.push(text) });
  assert.equal(output.status, 'completed'); assert.deepEqual(stream, ['public stream']);
  assert.equal(f.calls.some(call => call.method === 'session/read'), true);
});

test('CLI validates local attachments and parses on/off without forwarding credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agenthub-zcode-args-'));
  try {
    const image = join(directory, 'public.png'), file = join(directory, 'public.txt'), auth = join(directory, 'auth.json');
    await Promise.all([writeFile(image, 'synthetic'), writeFile(file, 'synthetic'), writeFile(auth, '{}')]);
    const parsed = await parseArguments(['--cli', join(directory, 'zcode.cjs'), '--model', 'test-model', '--task', 'marker', '--stream', 'off', '--attach', image, '--attach', file, '--timeout', '12']);
    assert.equal(parsed.stream, false); assert.equal(parsed.timeoutMs, 12000);
    assert.deepEqual(parsed.attachments, [{ type: 'image', path: image }, { type: 'file', path: file }]);
    await assert.rejects(parseArguments(['--cli', join(directory, 'zcode.cjs'), '--attach', auth]), error => error.code === 'CREDENTIAL_ATTACHMENT_DENIED');
    await assert.rejects(parseArguments(['--cli', 'relative.cjs']), error => error.code === 'ABSOLUTE_CLI_REQUIRED');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('app-server speaks official string-id NDJSON and acknowledges runtime preferences without jsonrpc', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agenthub-zcode-protocol-'));
  let rpc;
  try {
    const cli = join(directory, 'mock-app-server.mjs');
    await writeFile(cli, `import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});let first;
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
lines.on('line',line=>{const m=JSON.parse(line);
if(m.method==='session/create'){first=m;send({id:'prefs-1',method:'session/requestRuntimePreferences',params:{}});}
else if(m.id==='prefs-1')send({id:first.id,result:{stringId:typeof first.id==='string',noJsonrpc:!('jsonrpc'in first),prefs:m.result,storageOwn:process.env.ZCODE_STORAGE_DIR===process.cwd()}});
else if(m.method==='permission/request')send({id:'permission-1',method:'runtime/permission',params:{}});
else if(m.id==='permission-1')send({id:'hub-2',result:{approved:!m.error}});
});lines.on('close',()=>process.exit(0));`);
    rpc = new AppServer({ cli, cwd: directory, storage: directory });
    const audit = await rpc.request('session/create', {}, 5000);
    assert.equal(audit.stringId, true); assert.equal(audit.noJsonrpc, true); assert.equal(audit.storageOwn, true);
    assert.deepEqual(audit.prefs, { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: 'preflight-v1' });
    assert.equal((await rpc.request('permission/request', {}, 5000)).approved, false);
    assert.equal(rpc.interactiveRequest, true);
  } finally { if (rpc) await rpc.shutdown(); await rm(directory, { recursive: true, force: true }); }
});
