// Executable client-function/DOM contract tests; no browser or vendor calls.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const clientText = async (name) => (await readFile(new URL(`../console/client/${name}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const html = (await Promise.all(['index.html', 'styles.css', 'app-main.js', 'qa-grid.js', 'mascot.js'].map(clientText))).join('\n');
const names = ['getModelCatalog', 'getModelCapability', 'getAgentPrefs', 'saveAgentPrefs', 'getModelDisplayName', 'getModelSummaryText',
  'getAgentMeta', 'agentModelSelectable', 'agentFixedModelName',
  'getAgentAccent', 'applyAgentAccent', 'updateModelSummaryUI',
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
function fixture(models = [selection('fixture')], opts = {}) {
  const nodes = new Map();
  class Element {
    children = []; style = { setProperty() {} }; value = ''; hidden = false; disabled = false; attributes = {}; listeners = {}; dataset = {};
    constructor(tag) { this.tagName = tag; }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text || ''; }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    querySelector(selector) { const value = /value="([^"]+)"/.exec(selector)?.[1]; return this.children.find((child) => child.value === value) || null; }
    // 真实 DOM 有 classList；桩里补上，否则 updateCapabilityUI 一碰高亮就抛错，
    // 整组能力测试只能停在“没跑到断言”的状态。
    get classList() {
      const node = this;
      const tokens = () => String(node.className || '').split(/\s+/).filter(Boolean);
      const write = (list) => { node.className = list.join(' '); };
      return {
        add(...names) { const list = tokens(); for (const name of names) if (!list.includes(name)) list.push(name); write(list); },
        remove(...names) { write(tokens().filter((token) => !names.includes(token))); },
        contains(name) { return tokens().includes(name); },
      };
    }
  }
  const $ = (selector) => { if (!nodes.has(selector)) nodes.set(selector, new Element('div')); return nodes.get(selector); };
  const el = (tag, className, text) => { const node = new Element(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const calls = [], notices = [];
  const worker = { configured: true, default_model: models[0].id, availability: { enabled: true, reason: '' }, models };
  // applyAgentAccent() writes onto <html>; the context only needs the two members it touches.
  const documentElement = new Element('html');
  const context = vm.createContext({ $, el, Object, Array, JSON, localStorage: { setItem() {} },
    document: { documentElement },
    AGENT_THEMES: { probe: { color: '#818cf8', glow: 'rgba(129, 140, 248, 0.35)', label: 'probe' } },
    state: { snap: { platform: 'linux', agents: [{ name: 'probe', modelSelection: opts.modelSelection !== false, defaultModel: opts.defaultModel || models[0].id }], capabilities: { workers: { probe: worker } }, modelCatalog: { probe: models.map((model, index) => ({ id: model.id, name: model.id, default: index === 0, available: model.availability.enabled, reason: model.availability.reason, capability: model })) } } },
    chat: { activeAgent: 'probe', activeSessionId: 'session', atts: [], sending: false }, modelSettings: {},
    toast: (message) => notices.push(message), updateStatusBar() {}, renderAttStrip() {}, URL: { revokeObjectURL() {}, createObjectURL() {} },
    api: async (path, body) => { calls.push({ path, body }); return {}; }, loadThreads: async () => {}, selectPlatform: async () => {},
    FileReader: class { constructor() { calls.push({ path: 'FileReader' }); } readAsDataURL() {} },
  });
  vm.runInContext(functions, context);
  return { context, $, nodes, calls, notices, worker };
}

test('effort options render low medium high max controls and preserve user selection', () => {
  const { context, $ } = fixture([selection('always-thinking')]);
  context.modelSettings.probe = { model: 'always-thinking', effort: 'max' };
  context.updateModelSummaryUI();
  const buttons = $('#mp-options-effort').children;
  assert.equal(buttons.length, 4);
  assert.equal(buttons.find((node) => node.textContent === 'Max').disabled, false);
  assert.equal(context.modelSettings.probe.effort, 'max');
});

test('changing the selected model updates active preferences correctly', () => {
  const { context, $ } = fixture([selection('full'), selection('limited')]);
  context.modelSettings.probe = { model: 'full', effort: 'high' };
  context.updateModelSummaryUI();
  context.saveAgentPrefs('probe', { model: 'limited' });
  assert.equal(context.modelSettings.probe.model, 'limited');
  assert.equal($('#btn-attach').disabled, false, 'attachment button remains available');
});

test('model list renders configured items with selectable clicks', () => {
  const { context, $ } = fixture([selection('available'), selection('missing-glm', { available: false })]);
  context.renderModelPanel();
  const item = $('#mp-model-list').children.find((node) => node.attributes['data-id'] === 'missing-glm');
  assert.ok(item);
  item.listeners.click();
  assert.equal(context.modelSettings.probe.model, 'missing-glm');
});

test('actual send payload contains validated model and effort without legacy tiers', async () => {
  const { context, $, calls } = fixture();
  context.modelSettings.probe = { model: 'fixture', effort: 'max' };
  $('#chat-input').value = 'EXACT_TASK';
  context.sendChat();
  await new Promise((done) => setImmediate(done));
  const payload = calls.find((call) => call.path === '/api/chat/send').body;
  assert.equal(payload.text, 'EXACT_TASK');
  assert.equal(payload.effort, 'max');
  assert.equal(payload.contextTier, undefined);
});

test('adding file attachments invokes FileReader upload pathway', () => {
  const { context, $, calls } = fixture();
  context.addFiles([{ name: 'test.txt', type: 'text/plain', size: 100 }]);
  assert.ok(calls.length > 0 || context.chat.atts.length > 0);
});

// GUI 通道（traecode）的模型由客户端界面决定：Hub 会拒绝带 model 的派发，
// 前端必须既不给选、也不往 payload 里塞 model，否则用户点发送就吃一条 UNSUPPORTED。
test('模型不可切换的通道不发送 model，胶囊显示「跟随客户端」', async () => {
  const { context, $, calls } = fixture([selection('fixed-model')], { modelSelection: false, defaultModel: 'fixed-model' });
  context.modelSettings.probe = { model: 'fixed-model' };
  $('#chat-mode').value = 'dispatch';
  context.populateChatModels();
  assert.equal($('#chat-model').disabled, true, '下拉不给出可点选项');
  assert.equal($('#chat-model').children.length, 1);
  assert.equal($('#chat-model').children[0].value, '', '唯一选项的空值代表「跟随客户端」');
  assert.equal(context.getAgentPrefs('probe').model, '', '偏好里的旧模型要被清掉');
  assert.match(context.getModelSummaryText('probe'), /跟随客户端/);

  $('#chat-input').value = 'TASK';
  context.sendChat();
  await new Promise((done) => setImmediate(done));
  const payload = calls.find((call) => call.path === '/api/chat/send').body;
  assert.equal(payload.model, undefined, '不能把 model 传给 Hub');
});

test('可切换模型的通道照常带上所选模型', async () => {
  const { context, $, calls } = fixture([selection('a'), selection('b')], { modelSelection: true });
  context.modelSettings.probe = { model: 'b' };
  $('#chat-input').value = 'TASK';
  context.sendChat();
  await new Promise((done) => setImmediate(done));
  const payload = calls.find((call) => call.path === '/api/chat/send').body;
  assert.equal(payload.model, 'b');
});
