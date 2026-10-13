import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const html = (await readFile(new URL('../console/client/index.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('index.html contains unified sidebar layout with platform session tree and search', () => {
  // Unified sidebar and main chat column
  assert.ok(html.includes('class="chat-threads cb-platforms-sidebar" id="chat-threads"'), 'Must have unified platforms and sessions sidebar');
  assert.ok(html.includes('id="thread-list" class="platform-list"'), 'Must have thread-list platform container');
  assert.ok(html.includes('id="platform-search"'), 'Must have platform and session search input');
  assert.ok(html.includes('id="btn-toggle-all-tree"'), 'Must have toggle all session trees button');
  assert.ok(html.includes('id="btn-view-archives"'), 'Must have view archives button');
  assert.ok(html.includes('class="chat-main" id="chat-main"'), 'Must have chat main column');

  // Verify separate 3rd sessions column is removed in favor of original unified sidebar
  assert.ok(!html.includes('id="chat-sessions-sidebar"'), 'Must not have decoupled sessions column');
});

test('index.html contains optimized clear and export controls with dropdown menu', () => {
  // Clear and export buttons in chat header
  assert.ok(html.includes('id="btn-chat-clear"'), 'Must have clear button');
  assert.ok(html.includes('id="btn-chat-export"'), 'Must have export button');
  assert.ok(html.includes('id="export-dropdown-wrap"'), 'Must have export dropdown wrapper');
  assert.ok(html.includes('id="export-dropdown-menu"'), 'Must have export dropdown menu');
  assert.ok(html.includes('id="btn-export-markdown"'), 'Must have export markdown button');
  assert.ok(html.includes('id="btn-export-json"'), 'Must have export json button');
  assert.ok(html.includes('id="btn-export-copy"'), 'Must have export copy button');
});

test('index.html contains Antigravity workbench layout with tabs and inline artifact viewer', () => {
  // Workbench container
  assert.ok(html.includes('id="workbench"'), 'Must have workbench aside container');
  assert.ok(html.includes('id="wb-tabs"'), 'Must have workbench tabs container');
  assert.ok(html.includes('id="wb-tab-cnt-artifacts"'), 'Must have workbench artifacts count');
  assert.ok(html.includes('id="wb-tab-cnt-files"'), 'Must have workbench files count');
  assert.ok(html.includes('id="wb-body"'), 'Must have workbench list body');

  // Antigravity inline preview pane
  assert.ok(html.includes('id="wb-preview-pane"'), 'Must have inline artifact preview pane');
  assert.ok(html.includes('id="wb-preview-back"'), 'Must have preview back button');
  assert.ok(html.includes('id="wb-preview-copy"'), 'Must have preview copy button');
  assert.ok(html.includes('id="wb-preview-download"'), 'Must have preview download button');
  assert.ok(html.includes('id="wb-preview-code"'), 'Must have preview code container');

  // Toggle handles & badges
  assert.ok(html.includes('id="wb-edge-tab"'), 'Must have workbench edge tab handle');
  assert.ok(html.includes('id="head-wb-badge"'), 'Must have chat header workbench count badge');
});

test('index.html contains custom background layer and settings card with presets and sliders', () => {
  // Fixed background layer
  assert.ok(html.includes('<div id="app-bg-layer" class="app-bg-layer"'), 'Must have app-bg-layer fixed container');

  // Tab 2 renamed to 设置
  assert.ok(html.includes('id="tab-agents"'), 'Must maintain tab-agents ID for backward compatibility');
  assert.ok(html.includes('title="系统设置与控制台个性化"'), 'Tab title updated to settings');

  // Background settings card
  assert.ok(html.includes('id="settings-bg-card"'), 'Must have settings-bg-card');
  assert.ok(html.includes('data-preset="default"'), 'Must have default preset');
  assert.ok(html.includes('data-preset="aurora"'), 'Must have aurora preset');
  assert.ok(html.includes('data-preset="dusk"'), 'Must have dusk preset');
  assert.ok(html.includes('data-preset="cyber"'), 'Must have cyber preset');
  assert.ok(html.includes('data-preset="grid"'), 'Must have grid preset');
  assert.ok(html.includes('data-preset="custom"'), 'Must have custom preset');
  assert.ok(html.includes('id="custom-bg-input"'), 'Must have URL input');
  assert.ok(html.includes('id="btn-upload-local-bg"'), 'Must have local upload button');
  assert.ok(html.includes('id="bg-opacity-slider"'), 'Must have opacity slider');
  assert.ok(html.includes('id="bg-blur-slider"'), 'Must have blur slider');
  assert.ok(html.includes('id="btn-reset-bg"'), 'Must have reset button');
});

test('index.html has zero emoji characters across UI markup and scripts', () => {
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1FA00}-\u{1FAFF}]/u;
  const lines = html.split('\n');
  const violations = [];
  lines.forEach((line, idx) => {
    // Exclude basic close crosses '✕' which are standard multiplication/close signs
    const cleaned = line.replace(/✕/g, '');
    if (emojiRegex.test(cleaned)) {
      violations.push(`${idx + 1}: ${line.trim()}`);
    }
  });
  assert.deepEqual(violations, [], `Expected 0 emojis in index.html, found:\n${violations.join('\n')}`);
});

test('renderPlatformList renders platform groups and expandable session tree', () => {
  const start = html.indexOf('  function renderPlatformList() {');
  assert.notEqual(start, -1, 'renderPlatformList must be defined');
  const end = html.indexOf('\n  }\n', start);
  const code = html.slice(start, end + 5);

  class Element {
    children = []; childNodes = []; style = {}; attributes = {}; text = ''; hidden = false;
    constructor(tag) { this.tagName = tag; }
    set textContent(v) { this.text = String(v); this.children = []; this.childNodes = []; }
    get textContent() { return this.text || ''; }
    appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; }
    setAttribute(k, v) { this.attributes[k] = v; }
    addEventListener() {}
  }
  const nodes = new Map();
  const $ = (s) => { if (!nodes.has(s)) nodes.set(s, new Element('div')); return nodes.get(s); };
  const el = (tag, cls, text) => { const n = new Element(tag); n.className = cls; if (text !== undefined) n.textContent = text; return n; };

  const context = vm.createContext({
    $, el, chat: {
      activeAgent: 'codebuddy',
      activeSessionId: 'sess-1',
      platformFilter: '',
      expandedAgents: { codebuddy: true },
      threads: [
        {
          agent: 'codebuddy',
          last: { role: 'agent', text: '你好，我是 CodeBuddy' },
          sessions: [
            { id: 'sess-1', title: '日常代码分析', msgCount: 4 },
            { id: 'sess-2', title: '架构方案探讨', msgCount: 7 }
          ]
        }
      ]
    },
    getPlatformList: () => [{ name: 'codebuddy' }],
    getAgentVisual: () => ({ bg: '#2563eb', code: 'CB' }),
    applyAvatar: () => {},
    threadMeta: () => '10:00',
    selectPlatform: () => {},
    api: async () => ({})
  });
  vm.runInContext(code, context);
  context.renderPlatformList();

  const listItems = $('#thread-list').children;
  assert.equal(listItems.length, 1); // 1 platform group
  const group = listItems[0];
  assert.equal(group.children.length, 2); // .platform-item and .platform-session-tree
  const tree = group.children[1];
  assert.ok(tree.className.includes('platform-session-tree'), 'Must create session tree');
  assert.equal(tree.children.length, 3); // 2 session items + 1 new session button
});
