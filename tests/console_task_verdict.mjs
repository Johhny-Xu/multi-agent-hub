// @ts-check
// 异步任务探针（hub_task_status）→ UI 文案的回归测试。
//
// 用户报的问题：控制台异步任务列表在 running 时只显示死板的 `running`，
// 「模型正在思考」和「worker 已经死了但结果没落盘」在界面上完全一样，
// 只能靠人肉等墙钟去猜。Hub 侧的 verdict 早就有，是前端没消费。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { verdictUi, livenessLine, hintOf, keepPolling, isTerminal, fmtBytes } = require(join(process.cwd(), 'console', 'client', 'task-verdict.js'));

test('还在思考：alive_waiting 显示「思考中」且仍存活', () => {
  const ui = verdictUi({ status: 'running', verdict: 'alive_waiting' });
  assert.equal(ui.text, '思考中');
  assert.equal(ui.alive, true);
  assert.equal(ui.cls, 'acc');
  assert.equal(ui.terminal, false);
});

test('真在推进：working 显示「工作中」', () => {
  assert.equal(verdictUi({ status: 'running', verdict: 'working' }).text, '工作中');
});

test('worker 已退出但没结果：必须显眼标红（这才是真失败）', () => {
  const ui = verdictUi({ status: 'running', verdict: 'worker_exited_result_missing' });
  assert.equal(ui.text, 'worker 已退出·无结果');
  assert.equal(ui.cls, 'err');
  assert.equal(ui.alive, false);
});

test('终态覆盖 verdict：completed 就是已完成', () => {
  const ui = verdictUi({ status: 'completed', verdict: 'working' });
  assert.equal(ui.text, '已完成');
  assert.equal(ui.terminal, true);
  assert.equal(keepPolling({ status: 'completed' }), false);
});

test('没有 verdict（探针不可用）时按 status 兜底，不误报失败', () => {
  assert.equal(verdictUi({ status: 'running' }).text, '运行中');
  assert.equal(verdictUi({ status: 'pending' }).text, '排队中');
  assert.equal(keepPolling({ status: 'running' }), true);
  assert.equal(keepPolling({ status: 'running', verdict: 'unknown_no_liveness' }), true, '没证据 ≠ 失败，不能停止轮询');
});

test('存活证据一行字：PID / CPU 增量 / 输出增量', () => {
  const line = livenessLine({
    status: 'running',
    liveness: { pid: 419161, cpu_seconds: 60.59, cpu_delta: 0.4, output_bytes: 269, output_delta: 0, output_age: 8 },
  });
  assert.match(line, /PID 419161/);
  assert.match(line, /CPU 60\.6s \+0\.4s/);
  assert.match(line, /输出 269B/);
  assert.match(line, /8s 前有输出/);
});

test('输出增量会换算单位，CPU 无增量时不写 +0', () => {
  const line = livenessLine({
    status: 'running',
    liveness: { pid: 7, cpu_seconds: 3, cpu_delta: 0, output_bytes: 2048, output_delta: 1536 },
  });
  assert.match(line, /输出 2\.0KB \+1\.5KB/);
  assert.doesNotMatch(line, /\+0s/);
});

test('进程已退出写进证据行', () => {
  const line = livenessLine({ status: 'running', liveness: { pid: 9, alive: false, cpu_seconds: 1 } });
  assert.match(line, /进程已退出/);
});

test('没有 liveness 就不占位（返回空串而不是拼一堆 undefined）', () => {
  assert.equal(livenessLine({ status: 'running' }), '');
  assert.equal(livenessLine({ status: 'running', liveness: { pid: 5 } }), 'PID 5');
});

test('探针建议语原样透出', () => {
  assert.match(hintOf({ guidance: '进程存活且有 CPU/输出进展，继续等待' }), /继续等待/);
  assert.equal(hintOf({}), '');
});

test('fmtBytes 边界', () => {
  assert.equal(fmtBytes(0), '0B');
  assert.equal(fmtBytes(999), '999B');
  assert.equal(fmtBytes(1024), '1.0KB');
  assert.equal(fmtBytes(1048576), '1.00MB');
  assert.equal(fmtBytes(null), '');
});

test('isTerminal 只认五种终态', () => {
  for (const s of ['completed', 'failed', 'error', 'cancelled', 'timeout']) assert.equal(isTerminal(s), true, s);
  for (const s of ['running', 'pending', 'unknown', '']) assert.equal(isTerminal(s), false, s);
});
