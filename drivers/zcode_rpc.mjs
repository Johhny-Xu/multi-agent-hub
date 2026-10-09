#!/usr/bin/env node
// Official ZCode app-server NDJSON adapter. No global/workspace model setter.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const runtimePreferences = {
  nativeSearchEnhancementsEnabled: false, memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: 'preflight-v1',
};
const deniedTools = ['Bash', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Write', 'Edit'];

class AdapterError extends Error {
  constructor(code, status = 'failed') { super(code); this.code = code; this.status = status; }
}

export class AppServer {
  constructor({ cli, node = process.execPath, cwd, storage, env = process.env }) {
    this.pending = new Map(); this.notifications = []; this.nextId = 0; this.interactiveRequest = false;
    this.child = spawn(node, [cli, 'app-server', '--cwd', cwd], {
      cwd, env: { ...env, ZCODE_STORAGE_DIR: storage }, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    // Vendor stderr can include private settings. Do not forward its raw text.
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (typeof message.id === 'string' && typeof message.method === 'string') {
        if (message.method === 'session/requestRuntimePreferences') this.write({ id: message.id, result: runtimePreferences });
        else {
          this.interactiveRequest = true;
          this.write({ id: message.id, error: { code: -32601, message: 'This adapter does not approve interactive requests' } });
        }
      } else if (this.pending.has(message.id)) {
        const pending = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new AdapterError('RPC_REJECTED'));
        else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
        else pending.reject(new AdapterError('RPC_INVALID_RESPONSE', 'unknown'));
      } else if (message.method === 'session/event') this.notifications.push(message.params);
    });
    const rejectPending = code => { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new AdapterError(code, 'unknown')); } this.pending.clear(); };
    this.child.stdin.on('error', () => rejectPending('APP_SERVER_STDIN_FAILED'));
    this.child.once('error', () => { this.closed = true; rejectPending('APP_SERVER_START_FAILED'); });
    this.child.once('close', () => { this.closed = true; rejectPending('APP_SERVER_EXITED'); lines.close(); });
  }
  write(message) { if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  request(method, params, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new AdapterError('APP_SERVER_EXITED', 'unknown'));
    const id = 'hub-' + ++this.nextId;
    return new Promise((resolve_, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AdapterError('RPC_TIMEOUT', 'unknown')); }, Math.max(1, timeoutMs));
      this.pending.set(id, { resolve: resolve_, reject, timer }); this.write({ id, method, params });
    });
  }
  async shutdown() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new AdapterError('APP_SERVER_STOPPED', 'unknown')); }
    this.pending.clear();
    if (this.child.exitCode !== null || this.closed) return;
    this.child.stdin.end();
    await this.waitForExit(1500);
    if (this.child.exitCode !== null || this.closed) return;
    // Only the still-live ChildProcess started above is eligible for cleanup.
    if (process.platform === 'win32') {
      const kill = spawn('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await new Promise(resolve_ => {
        const finish = () => { clearTimeout(timer); kill.off('close', finish); kill.off('error', finish); resolve_(); };
        const timer = setTimeout(finish, 1500); kill.once('close', finish); kill.once('error', finish);
      });
    } else { try { process.kill(-this.child.pid, 'SIGTERM'); } catch { this.child.kill('SIGTERM'); } }
    await this.waitForExit(500);
    if (process.platform !== 'win32' && this.child.exitCode === null && !this.closed) {
      try { process.kill(-this.child.pid, 'SIGKILL'); } catch { this.child.kill('SIGKILL'); }
      await this.waitForExit(500);
    }
  }
  waitForExit(timeoutMs) {
    if (this.closed || this.child.exitCode !== null) return Promise.resolve();
    return new Promise(resolve_ => {
      const finish = () => { clearTimeout(timer); this.child.off('close', finish); resolve_(); };
      const timer = setTimeout(finish, timeoutMs); this.child.once('close', finish);
    });
  }
}

export function selectModel(snapshot, requested) {
  const catalog = snapshot?.settings?.model?.available;
  if (!Array.isArray(catalog)) throw new AdapterError('MODEL_CATALOG_UNAVAILABLE', 'blocked_model');
  const refs = catalog.map(item => item?.ref).filter(ref => ref && typeof ref.providerId === 'string' && typeof ref.modelId === 'string');
  const key = requested.toLowerCase();
  const matching = refs.filter(ref => (ref.providerId + '/' + ref.modelId).toLowerCase() === key || ref.modelId.toLowerCase() === key);
  const unique = new Map(matching.map(ref => [ref.providerId + '/' + ref.modelId, ref]));
  if (unique.size !== 1) throw new AdapterError(unique.size ? 'MODEL_AMBIGUOUS' : 'MODEL_UNAVAILABLE', 'blocked_model');
  const selected = [...unique.values()][0];
  const ref = { providerId: selected.providerId, modelId: selected.modelId };
  const current = snapshot?.settings?.model?.current;
  // Catalog refs can omit a required reasoning level. Preserve only the official
  // current options of this exact model; never infer settings from another model.
  const modelOptions = selected.options?.reasoningLevel === undefined && sameIdentity(current, selected) && current.options?.reasoningLevel !== undefined ? current.options : selected.options;
  if (modelOptions !== undefined) {
    if (!modelOptions || typeof modelOptions !== 'object' || Array.isArray(modelOptions) || Object.keys(modelOptions).some(key_ => key_ !== 'reasoningLevel') || modelOptions.reasoningLevel !== undefined && (typeof modelOptions.reasoningLevel !== 'string' || !modelOptions.reasoningLevel)) throw new AdapterError('MODEL_OPTIONS_UNSUPPORTED', 'blocked_model');
    ref.options = modelOptions.reasoningLevel === undefined ? {} : { reasoningLevel: modelOptions.reasoningLevel };
  }
  return ref;
}

function sameIdentity(actual, expected) {
  return actual?.providerId === expected?.providerId && actual?.modelId === expected?.modelId;
}
function sameModel(actual, expected) {
  return sameIdentity(actual, expected) &&
    (actual?.options?.reasoningLevel ?? null) === (expected.options?.reasoningLevel ?? null);
}
function publicUsage(value) {
  const result = {};
  const keys = { inputTokens: 'input_tokens', outputTokens: 'output_tokens', reasoningTokens: 'reasoning_tokens', totalTokens: 'total_tokens', cacheReadTokens: 'cache_read_tokens', cacheWriteTokens: 'cache_write_tokens', input_tokens: 'input_tokens', output_tokens: 'output_tokens', reasoning_tokens: 'reasoning_tokens', total_tokens: 'total_tokens' };
  if (value && typeof value === 'object') for (const [key, output] of Object.entries(keys)) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0) result[output] = value[key];
  }
  return result;
}

export class TurnEvents {
  constructor(sessionId, onText = () => {}) { this.sessionId = sessionId; this.onText = onText; this.seen = new Set(); this.parts = new Map(); this.roles = new Map(); this.buffered = []; this.started = false; this.lastSeq = 0; }
  rememberMessages(messages) {
    for (const message of messages || []) {
      const info = message?.info;
      if (!info || typeof info.messageId !== 'string' || !['assistant', 'user'].includes(info.role)) continue;
      this.roles.set(info.messageId, info.role);
      for (const part of message.parts || []) if (typeof part?.partId === 'string') this.parts.set(part.partId, part);
    }
    const buffered = this.buffered; this.buffered = [];
    for (const payload of buffered) this.emitText(payload);
  }
  emitText(payload) {
    const part = this.parts.get(payload.partId);
    // Even field='text' on a reasoning/tool part must never be published.
    if (part?.type !== 'text' || part.ignored || part.messageId !== payload.messageId) return;
    const role = this.roles.get(payload.messageId);
    if (role === 'assistant') this.onText(payload.delta);
    else if (role === undefined && this.buffered.length < 1000) this.buffered.push(payload);
  }
  consume(event) {
    if (!event || event.sessionId !== this.sessionId) return;
    const id = event.eventId || event.seq;
    if (id !== undefined && this.seen.has(id)) return;
    if (id !== undefined) this.seen.add(id);
    if (Number.isInteger(event.seq)) this.lastSeq = Math.max(this.lastSeq, event.seq);
    const payload = event.payload || {};
    if (event.type === 'turn.started') this.started = true;
    if (event.type === 'part.started' || event.type === 'part.upserted') {
      const part = payload.part;
      if (part && typeof part.partId === 'string') this.parts.set(part.partId, part);
    }
    if (this.started && event.type === 'part.delta' && typeof payload.delta === 'string' &&
        (payload.field === 'text' || payload.field === undefined)) this.emitText(payload);
    if (event.type === 'turn.failed') this.terminal = { status: 'failed', code: 'TURN_FAILED' };
    if (this.started && event.type === 'turn.completed') {
      const known = ['cancelled', 'error_max_turns', 'error_max_budget', 'error_during_execution', 'error_max_tool_calls'];
      if (payload.resultType !== 'success') this.terminal = { status: 'failed', code: known.includes(payload.resultType) ? 'TURN_' + payload.resultType.toUpperCase() : 'TURN_INVALID_RESULT_TYPE' };
      else if (typeof payload.response !== 'string' || !payload.response.trim()) this.terminal = { status: 'failed', code: 'EMPTY_RESPONSE' };
      else this.terminal = { status: 'completed', answer: payload.response, usage: publicUsage(payload.usage) };
    }
  }
}

function result(status, answer, model, code, sessionId, usage) {
  const ok = status === 'completed';
  return { type: 'result', is_error: !ok, subtype: ok ? 'success' : 'error_' + (code || status).toLowerCase(), status,
    result: answer || '', model, ...(sessionId ? { session_id: sessionId } : {}),
    ...(usage && Object.keys(usage).length ? { usage } : {}), ...(ok ? {} : { error: { code: code || status, message: code || status } }) };
}

export async function runZcodeTask(options, { connect, onText = () => {}, now = Date.now, pause = ms => new Promise(resolve_ => setTimeout(resolve_, ms)) } = {}) {
  if (typeof options.model !== 'string' || !options.model.trim()) return result('blocked_model', '', '', 'MODEL_REQUIRED');
  if (options.thinking && options.thinking !== 'default') return result('failed', '', options.model, 'UNSUPPORTED_THINKING');
  if (typeof options.task !== 'string' || !options.task.trim()) return result('failed', '', options.model, 'TASK_REQUIRED');
  const timeout = options.timeoutMs ?? 300000;
  if (!Number.isFinite(timeout) || timeout <= 0) return result('failed', '', options.model, 'INVALID_TIMEOUT');
  let rpc, directory, sent = false, accepted = false, sessionId, selected;
  const own = new Set();
  const deadline = now() + timeout;
  const remaining = () => {
    const left = deadline - now();
    if (left <= 0) throw new AdapterError('TURN_TIMEOUT', 'timeout');
    return Math.min(30000, left);
  };
  try {
    directory = await mkdtemp(join(tmpdir(), 'agenthub-zcode-rpc-'));
    const cwd = resolve(options.cwd || process.cwd());
    const workspace = { workspacePath: cwd, workspaceKey: 'agenthub-rpc-' + randomUUID() };
    rpc = connect ? await connect({ directory, cwd }) : new AppServer({ cli: options.cli, node: options.node, cwd, storage: directory });
    const create = async model => {
      // Official 0.16.9 formats create.model as provider/model internally and
      // drops ref.options; create.thoughtLevel is required to retain the level.
      const snapshot = await rpc.request('session/create', { workspace, persistence: 'deferred', mode: 'plan', mcpServers: [], toolDenylist: deniedTools,
        ...(model ? { model, ...(model.options?.reasoningLevel ? { thoughtLevel: model.options.reasoningLevel } : {}) } : {}) }, remaining());
      const id = snapshot?.session?.sessionId;
      if (typeof id !== 'string' || !id) throw new AdapterError('CREATE_SESSION_INVALID', 'unknown');
      own.add(id); return snapshot;
    };
    const catalogSnapshot = await create();
    selected = selectModel(catalogSnapshot, options.model);
    const closed = await rpc.request('session/close', { sessionId: catalogSnapshot.session.sessionId, expectedPersistence: 'deferred' }, remaining());
    if (closed?.closed !== true) throw new AdapterError('SESSION_CLOSE_NOT_CONFIRMED');
    own.delete(catalogSnapshot.session.sessionId);
    const snapshot = await create(selected); sessionId = snapshot.session.sessionId;
    // session.model identifies the model, while settings.model.current also
    // carries its reasoning options in official 0.16.9 snapshots.
    if (!sameIdentity(snapshot.session.model, selected) || !sameModel(snapshot.settings?.model?.current ?? snapshot.session.model, selected)) throw new AdapterError('MODEL_SELECTION_NOT_APPLIED', 'blocked_model');
    const turn = new TurnEvents(sessionId, text => { if (options.stream) onText(text, sessionId); });
    const subscription = await rpc.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: false }, remaining());
    // Subscribe before sending, but never complete a task from an old/idle event.
    turn.lastSeq = Number.isInteger(subscription?.eventSeq) ? subscription.eventSeq : 0;
    for (const event of subscription?.events || []) if (Number.isInteger(event?.seq)) turn.lastSeq = Math.max(turn.lastSeq, event.seq);
    const baselineSeq = turn.lastSeq;
    const consume = event => { if (Number.isInteger(event?.seq) && event.seq > baselineSeq) turn.consume(event); };
    // A transport loss after this point may have accepted the task. Never resend.
    sent = true;
    const response = await rpc.request('session/send', { sessionId, content: options.task, inputId: randomUUID(), ...(options.attachments?.length ? { attachments: options.attachments } : {}) }, remaining());
    if (response?.accepted !== true) throw new AdapterError('SEND_NOT_CONFIRMED', 'unknown');
    accepted = true;
    while (now() < deadline) {
      for (const event of rpc.notifications.splice(0)) consume(event);
      if (rpc.interactiveRequest) throw new AdapterError('INTERACTIVE_REQUEST_DENIED', 'blocked_permission');
      if (options.stream && turn.buffered.length) {
        const snapshot_ = await rpc.request('session/read', { sessionId, messageLimit: 1 }, remaining());
        turn.rememberMessages(snapshot_?.messages);
      }
      if (turn.terminal) {
        const terminal = turn.terminal;
        return result(terminal.status, terminal.answer, selected.providerId + '/' + selected.modelId, terminal.code, sessionId, terminal.usage);
      }
      const page = await rpc.request('session/events', { sessionId, afterSeq: turn.lastSeq, limit: 100 }, remaining());
      for (const event of page?.events || []) consume(event);
      if (!turn.terminal) await pause(Math.min(200, Math.max(1, deadline - now())));
    }
    throw new AdapterError('TURN_TIMEOUT', 'timeout');
  } catch (error) {
    const status = error instanceof AdapterError ? (!sent && error.status === 'unknown' ? 'failed' : error.status) : sent ? 'unknown' : 'failed';
    return result(status, '', selected ? selected.providerId + '/' + selected.modelId : options.model, error instanceof AdapterError ? error.code : 'ADAPTER_FAILED', sessionId);
  } finally {
    if (rpc) {
      for (const id of own) try { await rpc.request('session/close', { sessionId: id, ...(!sent && !accepted ? { expectedPersistence: 'deferred' } : {}) }, 1500); } catch { /* Only our created IDs are closed; stop the owned server below. */ }
      try { await rpc.shutdown(); } catch { /* Cleanup cannot turn a known task result into an unhandled exception. */ }
    }
    if (directory) try { await rm(directory, { recursive: true, force: true }); } catch { /* A locked owned runtime directory must not mask the task result. */ }
  }
}

export async function parseArguments(argv) {
  const options = { attachments: [], stream: false, thinking: 'default' };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === '--stream') {
      if (['on', 'off', 'true', 'false'].includes(argv[index + 1])) options.stream = ['on', 'true'].includes(argv[++index]);
      else options.stream = true;
      continue;
    }
    if (!['--cli', '--node', '--model', '--task', '--cwd', '--timeout', '--thinking', '--attach'].includes(name) || index + 1 >= argv.length) throw new AdapterError('INVALID_ARGUMENTS');
    const value = argv[++index];
    if (name === '--attach') {
      if (!isAbsolute(value)) throw new AdapterError('ATTACHMENT_PATH_NOT_ABSOLUTE');
      if (/^(auth|credentials|tokens?)\.(json|ya?ml)$/i.test(basename(value)) || basename(value) === '.env') throw new AdapterError('CREDENTIAL_ATTACHMENT_DENIED');
      const info = await stat(value);
      if (!info.isFile() || options.attachments.length >= 8) throw new AdapterError('INVALID_ATTACHMENT');
      const type = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(extname(value).toLowerCase()) ? 'image' : 'file';
      options.attachments.push({ type, path: value });
    } else if (name === '--timeout') options.timeoutMs = Number(value) * 1000;
    else options[name.slice(2)] = value;
  }
  if (!options.cli || !isAbsolute(options.cli)) throw new AdapterError('ABSOLUTE_CLI_REQUIRED');
  if (!['default', 'on', 'off'].includes(options.thinking)) throw new AdapterError('INVALID_THINKING');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let output;
  try {
    const options = await parseArguments(process.argv.slice(2));
    output = await runZcodeTask(options, { onText: (text, sessionId) => process.stdout.write(JSON.stringify({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }) + '\n') });
  } catch (error) { output = result('failed', '', '', error instanceof AdapterError ? error.code : 'INVALID_INPUT'); }
  process.stdout.write(JSON.stringify(output) + '\n');
  process.exitCode = output.is_error ? 1 : 0;
}
