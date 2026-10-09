// Executable client-function/DOM contract tests; no browser or vendor calls.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const html = (await readFile(new URL('../console/client/index.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const names = ['getModelCatalog', 'getModelCapability', 'getAgentPrefs', 'saveAgentPrefs', 'getModelSummaryText', 'updateModelSummaryUI',
  'updateCapabilityUI', 'renderModelPanel', 'populateChatModels', 'sendChat', 'addFiles'];
const functions = names.map((name) => {
  const start = html.indexOf('  function ' + name + '(');
  assert.notEqual(start, -1, name);
  const end = html.indexOf('\n  }\n', start);
  assert.notEqual(end, -1, name);
  return html.slice(start, end + 5);
}).join('\n');
const selection = (id, { on = true, off = true, stream = true, image = true, file = true, available = true } = {}) => ({
  id, aliases: [], availability: { enabled: available, reason: available ? '' : '缺少要求模型' },
  thinking: { allowed: ['default', ...(on ? ['on'] : []), ...(off ? ['off'] : [])], reasons: { on: '不能开启思考', off: '始终思考，不能关闭' } },
  stream: { supported: stream, semantics: 'answer_deltas', reason: '尚未验证流式正文' }, attachments: { image: { supported: image, reason: '图片不支持' }, file: { supported: file, reason: '文件不支持' } },
});
function fixture(models = [selection('fixture')]) {
  const nodes = new Map();
  class Element {
    children = []; style = {}; value = ''; hidden = false; disabled = false; attributes = {}; listeners = {};
    constructor(tag) { this.tagName = tag; }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text || ''; }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    querySelector(selector) { const value = /value="([^"]+)"/.exec(selector)?.[1]; return this.children.find((child) => child.value === value) || null; }
  }
  const $ = (selector) => { if (!nodes.has(selector)) nodes.set(selector, new Element('div')); return nodes.get(selector); };
  const el = (tag, className, text) => { const node = new Element(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const calls = [], notices = [];
  const worker = { configured: true, default_model: models[0].id, availability: { enabled: true, reason: '' }, models };
  const context = vm.createContext({ $, el, Object, Array, JSON, localStorage: { setItem() {} },
    state: { snap: { platform: 'linux', capabilities: { workers: { probe: worker } }, modelCatalog: { probe: models.map((model, index) => ({ id: model.id, name: model.id, default: index === 0, available: model.availability.enabled, reason: model.availability.reason, capability: model })) } } },
    chat: { activeAgent: 'probe', activeSessionId: 'session', atts: [], sending: false }, modelSettings: {},
    toast: (message) => notices.push(message), updateStatusBar() {}, renderAttStrip() {}, URL: { revokeObjectURL() {}, createObjectURL() {} },
    api: async (path, body) => { calls.push({ path, body }); return {}; }, loadThreads: async () => {}, selectPlatform: async () => {},
    FileReader: class { constructor() { calls.push({ path: 'FileReader' }); } readAsDataURL() {} },
  });
  vm.runInContext(functions, context);
  return { context, $, nodes, calls, notices, worker };
}

test('unsupported thinking modes are disabled with an explicit reason and stale preferences are reset', () => {
  const { context, $ } = fixture([selection('always-thinking', { off: false })]);
  context.modelSettings.probe = { model: 'always-thinking', thinking: 'off', effort: 'max', contextTier: 'long_context', autoTier: 'intelligence' };
  context.updateModelSummaryUI();
  const buttons = $('#mp-options-thinking').children;
  assert.equal(buttons.find((node) => node.textContent === '关闭').disabled, true);
  assert.match(buttons.find((node) => node.textContent === '关闭').title, /不能关闭/);
  assert.equal(buttons.find((node) => node.textContent === '开启').disabled, false);
  assert.equal(context.modelSettings.probe.thinking, 'default');
  assert.equal(context.modelSettings.probe.effort, undefined);
  assert.match($('#composer-capabilities').textContent, /Hub 平台：linux/);
});

test('changing the selected model updates stream and attachment controls instead of worker-wide assumptions', () => {
  const { context, $ } = fixture([selection('full'), selection('limited', { on: false, off: false, stream: false, image: false })]);
  context.modelSettings.probe = { model: 'full', thinking: 'on', stream: true };
  context.updateModelSummaryUI();
  assert.equal($('#mp-stream').disabled, false);
  context.saveAgentPrefs('probe', { model: 'limited' });
  assert.equal($('#mp-stream').disabled, true);
  assert.equal($('#mp-stream').checked, false);
  assert.equal(context.modelSettings.probe.thinking, 'default');
  assert.equal($('#btn-attach').disabled, false, 'file remains supported');
  assert.ok(!$('#file-input').accept.includes('image/'));
  assert.match($('#composer-capabilities').textContent, /图片不支持/);
});

test('blocked model cannot be selected or sent, and an unknown capability document also disables send', () => {
  const { context, $ } = fixture([selection('available'), selection('missing-glm', { available: false })]);
  context.renderModelPanel();
  const item = $('#mp-model-list').children.find((node) => node.attributes['data-id'] === 'missing-glm');
  assert.equal(item.attributes['aria-disabled'], 'true');
  item.listeners.click();
  assert.equal(context.modelSettings.probe.model, 'available');
  context.modelSettings.probe.model = 'missing-glm';
  context.updateModelSummaryUI();
  assert.equal($('#btn-chat-send').disabled, true);
  context.state.snap = null;
  context.updateModelSummaryUI();
  assert.equal($('#btn-chat-send').disabled, true);
  assert.equal($('#btn-attach').disabled, true);
});

test('actual send payload contains validated thinking/stream without effort or prompt prefixes', async () => {
  const { context, $, calls } = fixture();
  context.modelSettings.probe = { model: 'fixture', thinking: 'off', stream: true, effort: 'max', contextTier: 'long_context' };
  $('#chat-input').value = 'EXACT_TASK';
  context.sendChat();
  await new Promise((done) => setImmediate(done));
  const payload = calls.find((call) => call.path === '/api/chat/send').body;
  assert.equal(payload.text, 'EXACT_TASK');
  assert.equal(payload.thinking, 'off');
  assert.equal(payload.stream, true);
  assert.equal(payload.effort, undefined);
  assert.equal(payload.contextTier, undefined);
});

test('unsupported pasted images are rejected before FileReader/upload and pending incompatible attachments block send', () => {
  const { context, $, calls, notices } = fixture([selection('no-image', { image: false })]);
  context.addFiles([{ name: 'image.png', type: 'image/png', size: 100 }]);
  assert.equal(calls.length, 0);
  assert.match(notices[0], /图片不支持/);
  context.chat.atts.push({ name: 'old.png', isImage: true, status: 'ready', url: '/uploads/mock.png' });
  $('#chat-input').value = 'fixture';
  context.sendChat();
  assert.equal(calls.length, 0);
  assert.match(notices.at(-1), /现有附件/);
});
