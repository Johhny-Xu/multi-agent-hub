// @ts-check
// 子代理配额的「数据 → UI」判定（浏览器与 Node 共用，便于单测）。
//
// 为什么单独抽出来：
//   1. 后端把 quotas 从对象 map 改成了数组，前端原来三处（侧栏胶囊 / 状态栏 /
//      悬浮提示）各写一份平台映射与解析，口径不一致——codebuddy-cn 甚至会去读
//      `codebuddy` 这个国际版 worker 的数据，显示的是另一个账号的额度。
//   2. 侧栏额度胶囊曾被整段移除，只剩两份没人调用的死代码。
// 现在统一在这里归一化，三处 UI 只消费同一份 summary。
//
// 输入契约（见 console/vendor-quota.mjs 的 getAllQuotas）：
//   info = { worker, account, plan, quotas: Array|Object, message?, fetchedAt? }
// 输出契约：
//   summary = { ok, agent, plat, account, plan, items[], primary?, pct?, level, reason? }
(function (root) {
  'use strict';

  /** 子代理名 → 服务端 worker 键。两个 CodeBuddy 是两个独立 worker，不能混用。 */
  const QUOTA_AGENT_PLATFORM = {
    antigravity: 'antigravity',
    codebuddy: 'codebuddy',
    'codebuddy-cn': 'codebuddy-cn',
    traecode: 'traecode',
    'github-copilot': 'github-copilot',
    minimaxcode: 'minimaxcode',
    zcode: 'zcode',
    mimocode: 'mimocode',
    codearts: 'codearts',
    qoder: 'qoder',
    'qoder-cn': 'qoder-cn',
  };

  /** 这些条目不参与「这个账号还剩多少」的判定（签到只是 0/1 状态位） */
  const NON_BALANCE_NAMES = new Set(['每日签到', 'checkin', '每日登录']);

  function quotaPlatformOf(agent) {
    return QUOTA_AGENT_PLATFORM[agent] || null;
  }

  function fmtQuotaAmount(n) {
    if (n === null || n === undefined) return '-';
    const v = Number(n);
    if (!Number.isFinite(v)) return '-';
    if (Math.abs(v) >= 1e4) return `${Math.round(v / 100) / 10}K`;
    return String(Math.round(v * 100) / 100);
  }

  function defaultFormatReset(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} 重置`;
  }

  /** 后端可能下发数组，也可能是历史的对象 map → 统一成数组并补齐 remaining/pct */
  function quotaItemsOf(info) {
    if (!info) return [];
    const raw = info.quotas;
    let list = [];
    if (Array.isArray(raw)) {
      list = raw.slice();
    } else if (raw && typeof raw === 'object') {
      list = Object.keys(raw).map((k) => {
        const v = raw[k] || {};
        return {
          name: v.name || k,
          displayName: v.displayName || k,
          used: v.used,
          total: v.total,
          remaining: v.remaining,
          remainingPercentage: v.remainingPercentage,
          resetAt: v.resetAt,
          unlimited: !!v.unlimited,
          isCreditBalance: !!v.isCreditBalance,
          unit: v.unit,
          primary: !!v.primary,
        };
      });
    }
    return list.map((q) => {
      const used = Number(q.used || 0);
      const total = Number(q.total || 0);
      const remaining = q.remaining === null || q.remaining === undefined
        ? Math.max(0, total - used)
        : Number(q.remaining);
      let pct;
      if (typeof q.remainingPercentage === 'number') pct = q.remainingPercentage;
      else if (total > 0) pct = (remaining / total) * 100;
      else pct = q.unlimited ? 100 : 0;
      return {
        name: q.name || q.displayName || 'quota',
        displayName: q.displayName || q.name || 'quota',
        used: Number.isFinite(used) ? used : 0,
        total: Number.isFinite(total) ? total : 0,
        remaining: Number.isFinite(remaining) ? remaining : 0,
        pct: Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0)),
        resetAt: q.resetAt || null,
        unlimited: !!q.unlimited,
        isCreditBalance: !!q.isCreditBalance,
        unit: q.unit || '',
        primary: !!q.primary,
      };
    });
  }

  /** 挑一个最能代表「这个账号还剩多少」的额度项 */
  function pickPrimaryQuota(items) {
    if (!items || !items.length) return null;
    const meaningful = items.filter((q) => !(NON_BALANCE_NAMES.has(q.name) || (!q.isCreditBalance && q.total <= 1)));
    const pool = meaningful.length ? meaningful : items;
    const credited = pool.filter((q) => q.isCreditBalance || q.primary);
    if (credited.length) {
      const explicit = credited.filter((q) => q.primary)[0];
      if (explicit) return explicit;
      // 多个积分包（codebuddy 有几十个 Bonus Pack）时取总额最大的那个
      return credited.slice().sort((a, b) => b.total - a.total)[0];
    }
    const unlimited = pool.filter((q) => q.unlimited)[0];
    if (unlimited) return unlimited;
    return pool.slice().sort((a, b) => a.pct - b.pct)[0];
  }

  /**
   * @param {string} agent
   * @param {object|null} quotasData  /api/quotas 的返回值
   * @param {string|null} quotasError 加载错误文案
   */
  function quotaSummaryOf(agent, quotasData, quotasError) {
    const plat = quotaPlatformOf(agent);
    if (!plat) return { ok: false, agent: agent, reason: '未接入配额跟踪' };
    if (!quotasData) {
      return { ok: false, agent: agent, plat: plat, reason: quotasError || '正在查询配额…' };
    }
    const info = quotasData[plat];
    if (!info) return { ok: false, agent: agent, plat: plat, reason: '暂无该平台配额数据' };
    if (info.error) return { ok: false, agent: agent, plat: plat, reason: String(info.error) };
    const items = quotaItemsOf(info);
    const base = {
      agent: agent,
      plat: plat,
      account: info.account || '',
      plan: info.plan || '',
      message: info.message || '',
      fetchedAt: info.fetchedAt || '',
      items: items,
    };
    if (!items.length) {
      base.reason = info.message || '上游未返回额度明细';
      return base;
    }
    const primary = pickPrimaryQuota(items);
    const pct = primary ? primary.pct : null;
    let level = 'ok';
    if (pct !== null && pct < 15) level = 'critical';
    else if (pct !== null && pct < 40) level = 'warn';
    base.ok = true;
    base.primary = primary;
    base.pct = pct;
    base.level = level;
    return base;
  }

  /** 胶囊文案：积分口径给绝对值（剩22.4K 比 85% 更有信息量），配额口径给百分比 */
  function quotaCapsuleText(sum) {
    if (!sum || !sum.ok || !sum.primary) return '';
    const p = sum.primary;
    if (p.unlimited) return '不限额';
    if (p.isCreditBalance && p.total >= 100) return `剩${fmtQuotaAmount(p.remaining)}`;
    return `余${Math.round(p.pct)}%`;
  }

  function quotaTooltip(sum, formatReset) {
    const fmt = typeof formatReset === 'function' ? formatReset : defaultFormatReset;
    const head = `配额 · ${(sum && sum.agent) || '-'}`;
    if (!sum || !sum.ok) {
      const tail = [];
      if (sum && sum.account) tail.push(`账号: ${sum.account}`);
      if (sum && sum.plan) tail.push(`套餐: ${sum.plan}`);
      if (sum && sum.reason) tail.push(sum.reason);
      return head + (tail.length ? `\n${tail.join('\n')}` : '');
    }
    const lines = [head];
    if (sum.account) lines.push(`账号: ${sum.account}`);
    if (sum.plan) lines.push(`套餐: ${sum.plan}`);
    sum.items.slice(0, 6).forEach((q) => {
      const reset = q.resetAt ? ` · ${fmt(q.resetAt)}` : '';
      if (q.unlimited) lines.push(`· ${q.displayName}: 不限额`);
      else lines.push(`· ${q.displayName}: 剩${fmtQuotaAmount(q.remaining)}/${fmtQuotaAmount(q.total)} (${Math.round(q.pct)}%)${reset}`);
    });
    if (sum.items.length > 6) lines.push(`…共 ${sum.items.length} 项`);
    lines.push('点击查看详情 / 立即刷新');
    return lines.join('\n');
  }

  /** 侧栏胶囊：{ text, cls, title } 或 null（无数据且无套餐名时不占位） */
  function capsuleFor(agent, quotasData, quotasError, formatReset) {
    const sum = quotaSummaryOf(agent, quotasData, quotasError);
    if (!sum.ok) {
      // 有套餐名 = 凭据在线、只是上游没给额度明细（mimocode / zcode / workbuddy）。
      // 胶囊位置很窄，塞不下套餐名，用「已接入」占位，细节全部落到 tooltip。
      if (sum.plan || sum.account) {
        return { text: '已接入', cls: 'pill-quota', title: quotaTooltip(sum, formatReset) };
      }
      return null;
    }
    let cls = 'pill-quota';
    if (sum.level === 'critical') cls += ' critical';
    else if (sum.level === 'warn') cls += ' warn';
    const text = quotaCapsuleText(sum);
    if (!text) return null;
    return { text: text, cls: cls, title: quotaTooltip(sum, formatReset) };
  }

  const api = {
    QUOTA_AGENT_PLATFORM,
    quotaPlatformOf,
    quotaItemsOf,
    pickPrimaryQuota,
    fmtQuotaAmount,
    quotaSummaryOf,
    quotaCapsuleText,
    quotaTooltip,
    capsuleFor,
    defaultFormatReset,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.QuotaView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
