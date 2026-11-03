// @ts-check
// 异步任务的「探针状态 → UI 文案」判定（浏览器与 Node 单测共用）。
//
// 为什么单独抽出来：Hub 早就有 hub_task_status 探针（进程树存活 / CPU 时间 /
// 输出字节 / 心跳），能区分「还在思考」和「worker 已经死了但结果没落盘」。
// 但控制台的异步任务列表只看 hub_result 的 status，running 时永远显示一个死板的
// `running`，于是「模型在思考」和「进程崩了」在界面上长得一模一样。
//
// 这里把 verdict 翻译成人话 + 存活证据，供 inflight 列表与状态栏共用：
//   verdict ← hub/agent_hub.py::_task_liveness
//     working / alive_waiting / alive_quiet / starting / gui_working / gui_waiting
//     worker_exited_result_missing / unknown_no_liveness
//   终态：completed / failed / error / cancelled / timeout
(function (root) {
  'use strict';

  const TERMINAL = new Set(['completed', 'failed', 'error', 'cancelled', 'timeout']);

  /** verdict → 徽章文案 + 配色 + 是否"还活着" */
  const VERDICT_UI = {
    // 终态
    completed: { text: '已完成', cls: 'ok', alive: false, terminal: true },
    failed: { text: '失败', cls: 'err', alive: false, terminal: true },
    error: { text: '失败', cls: 'err', alive: false, terminal: true },
    cancelled: { text: '已取消', cls: 'err', alive: false, terminal: true },
    timeout: { text: '超时', cls: 'err', alive: false, terminal: true },
    // 运行中：有推进证据
    working: { text: '工作中', cls: 'acc', alive: true, terminal: false },
    gui_working: { text: '界面推进中', cls: 'acc', alive: true, terminal: false },
    starting: { text: '启动中', cls: 'acc', alive: true, terminal: false },
    // 运行中：进程活着但暂时没增量 —— 就是用户说的「思考中」
    alive_waiting: { text: '思考中', cls: 'acc', alive: true, terminal: false },
    gui_waiting: { text: '界面静止·存活', cls: 'warn', alive: true, terminal: false },
    alive_quiet: { text: '存活·静默', cls: 'warn', alive: true, terminal: false },
    // 异常：进程没了 / 没证据
    worker_exited_result_missing: { text: 'worker 已退出·无结果', cls: 'err', alive: false, terminal: false },
    unknown_no_liveness: { text: '无探活证据', cls: 'warn', alive: null, terminal: false },
  };

  function isTerminal(status) {
    return TERMINAL.has(String(status || ''));
  }

  /** 任务状态（status 或 verdict）→ 徽章描述 */
  function verdictUi(state) {
    const status = String((state && state.status) || '');
    const verdict = String((state && state.verdict) || '');
    if (isTerminal(status)) return VERDICT_UI[status] || { text: status, cls: 'ok', alive: false, terminal: true };
    if (verdict && VERDICT_UI[verdict]) return VERDICT_UI[verdict];
    if (isTerminal(verdict)) return VERDICT_UI[verdict];
    // 还没有 verdict：先按 status 兜底（running / pending / unknown）
    if (status === 'running') return { text: '运行中', cls: 'acc', alive: null, terminal: false };
    if (status === 'pending') return { text: '排队中', cls: 'warn', alive: null, terminal: false };
    return { text: status || '未知', cls: 'warn', alive: null, terminal: false };
  }

  function fmtBytes(n) {
    if (n === null || n === undefined || n === '') return '';
    const v = Number(n);
    if (!Number.isFinite(v)) return '';
    if (v >= 1048576) return `${(v / 1048576).toFixed(2)}MB`;
    if (v >= 1024) return `${(v / 1024).toFixed(1)}KB`;
    return `${Math.round(v)}B`;
  }

  function fmtAge(sec) {
    const v = Number(sec);
    if (!Number.isFinite(v) || v < 0) return '';
    if (v < 60) return `${Math.round(v)}s`;
    if (v < 3600) return `${Math.round(v / 60)}m`;
    return `${(v / 3600).toFixed(1)}h`;
  }

  /**
   * 存活证据一行字：PID / CPU（含增量）/ 输出（含增量）/ 最近输出距今。
   * 没有 liveness 时返回空串，UI 就不占位。
   */
  function livenessLine(state) {
    const l = (state && state.liveness) || null;
    if (!l) return '';
    const bits = [];
    if (l.pid != null) bits.push(`PID ${l.pid}`);
    if (l.process_count != null && Number(l.process_count) > 1) bits.push(`${l.process_count} 进程`);
    if (l.alive === false) bits.push('进程已退出');
    if (l.cpu_seconds != null) {
      const d = Number(l.cpu_delta);
      bits.push(`CPU ${Math.round(Number(l.cpu_seconds) * 10) / 10}s${Number.isFinite(d) && d > 0 ? ` +${Math.round(d * 10) / 10}s` : ''}`);
    }
    if (l.output_bytes != null) {
      const ob = fmtBytes(l.output_bytes);
      const od = Number(l.output_delta);
      bits.push(`输出 ${ob || '0B'}${Number.isFinite(od) && od > 0 ? ` +${fmtBytes(od)}` : ''}`);
    }
    if (l.output_age != null) bits.push(`${fmtAge(l.output_age)} 前有输出`);
    else if (l.heartbeat_age != null) bits.push(`心跳 ${fmtAge(l.heartbeat_age)} 前`);
    return bits.join(' · ');
  }

  /** 探针提示语（Hub 的 guidance），比我们自己编的准 */
  function hintOf(state) {
    return String((state && state.guidance) || '');
  }

  /**
   * 是否还在跑：UI 决定要不要继续轮询 + 要不要显示「等待结果落盘」。
   * unknown_no_liveness 也算在跑（没证据 ≠ 失败），避免误杀。
   */
  function keepPolling(state) {
    const status = String((state && state.status) || '');
    if (isTerminal(status)) return false;
    const ui = verdictUi(state);
    return ui.terminal !== true;
  }

  const api = { TERMINAL, VERDICT_UI, isTerminal, verdictUi, livenessLine, hintOf, keepPolling, fmtBytes, fmtAge };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TaskVerdict = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
