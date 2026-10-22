import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceAgentText } from '../scripts/meoo_agent_run.mjs';

// Meoo 官方 reducer：message.delta 追加，message.snapshot 整段替换。
// 回归用例来自线上真实事件流（auto 模型，任务「3+3=?」）：
//   delta "6" → delta "6" → delta "\n\n" → message.snapshot content "6"
// 旧实现只累加 delta，于是答案打成 "66"。

test('delta appends to the current text', () => {
  assert.equal(reduceAgentText('', 'message.delta', { delta: '下' }), '下');
  assert.equal(reduceAgentText('下', 'message.delta', { delta: '载' }), '下载');
});

test('snapshot replaces the whole text instead of appending', () => {
  assert.equal(reduceAgentText('66\n\n', 'message.snapshot', { content: '6' }), '6');
});

test('replayed deltas followed by a snapshot settle on the snapshot content', () => {
  let text = '';
  for (const evt of [
    ['message.delta', { delta: '6' }],
    ['message.delta', { delta: '6' }],
    ['message.delta', { delta: '\n\n' }],
    ['message.snapshot', { content: '6' }],
  ]) text = reduceAgentText(text, evt[0], evt[1]);
  assert.equal(text, '6');
});

test('deltas after a snapshot continue from the snapshot content', () => {
  assert.equal(reduceAgentText('6', 'message.delta', { delta: '0' }), '60');
});

test('snapshot may legitimately clear the text', () => {
  assert.equal(reduceAgentText('进行中', 'message.snapshot', { content: '' }), '');
});

test('unknown or malformed events leave the text untouched', () => {
  assert.equal(reduceAgentText('正文', 'run.working', { status: 'working' }), '正文');
  assert.equal(reduceAgentText('正文', 'message.delta', {}), '正文');
  assert.equal(reduceAgentText('正文', 'message.delta', { delta: 42 }), '正文');
  assert.equal(reduceAgentText('正文', 'message.snapshot', null), '正文');
});
