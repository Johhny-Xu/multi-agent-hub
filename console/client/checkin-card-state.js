// @ts-check
// 签到卡片的「状态 → UI」判定（浏览器与 Node 共用，便于单测）。
//
// 单独抽出来的原因：以前这段逻辑散在 qa-grid.js 里、每个平台各写一份，
// 而且只认 `status === 'success' || status === 'already'`，
// 于是 pending（等开窗 / 等额度冷却 / 上游活动没开）一律被渲染成可点的「立即签到」，
// 用户点下去状态不变、界面只是重渲染同一份数据 → 体感就是「点了没用」。
//
// 现在由服务端把状态拆细（pendingReason），这里负责如实翻译成人话：
//   status + pendingReason → 徽章文案 / 按钮文案 / 按钮可点性 / tooltip
(function (root) {
  'use strict';

  /** 各平台卡片徽章的 DOM id */
  const CHECKIN_BADGE_IDS = {
    workbuddy: 'badge-wb',
    codebuddy: 'badge-cb',
    traecode: 'badge-trae',
    codearts: 'badge-ca',
    qoder: 'badge-qd',
    'qoder-cn': 'badge-qdcn',
    minimaxcode: 'badge-mm',
    meoo: 'badge-meoo',
  };

  /** 这几个平台签到拿的是 Credits / 积分，已签文案跟别家区分开 */
  const CREDIT_PLATFORMS = { qoder: 1, 'qoder-cn': 1, minimaxcode: 1 };

  const fmtClock = (ts) => {
    if (!ts) return '';
    const d = new Date(Number(ts) * 1000);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  /**
   * @param {{status?:string,pendingReason?:string,pendingAccounts?:number,
   *          signedAccounts?:number,accountCount?:number,retryAt?:number,
   *          platform?:string,message?:string}} info
   * @returns {{badge:string,btn:string,clickable:boolean,tip:string}}
   */
  const cardState = (info) => {
    const data = info || {};
    const status = String(data.status || 'pending');
    const pending = Number(data.pendingAccounts) || 0;
    const signed = Number(data.signedAccounts) || 0;
    const total = Number(data.accountCount) || 0;
    const reason = String(data.pendingReason || '');
    const clock = fmtClock(data.retryAt);
    const credit = CREDIT_PLATFORMS[data.platform] ? '今日已领取' : '今日已签到';
    const signedTip = '今天已经签过了，重复点击只会拿到「今日已领」';
    const makeUp = (n) => ({
      badge: '部分已签',
      btn: `补签新增账号 ${n}`,
      clickable: true,
      tip: `还有 ${n} 个账号今天没签（多为在 worker 里新加的），点一下补签`,
    });

    switch (status) {
      case 'success':
      case 'already':
        if (pending > 0) return makeUp(pending);
        return { badge: status === 'success' ? credit : '今日已签', btn: '今日已签', clickable: false, tip: signedTip };
      case 'partial': {
        // 补签个数按「总数 - 已签数」推导，不依赖 pendingAccounts
        // （等窗口时 pendingAccounts 会被服务端归零，但 partial 仍要告诉用户还差几个号）
        const missing = Math.max(0, (total || signed) - signed);
        const badge = `部分成功（${signed}/${total || signed}）`;
        if (reason === 'quota_cooldown') {
          return { badge, btn: '冷却中', clickable: false, tip: data.message || '额度用尽，冷却期内不会重复请求' };
        }
        if (reason === 'awaiting_window') {
          return { badge, btn: '待开启', clickable: false, tip: data.message || `活动窗口未到${clock ? '，' + clock + ' 开启' : ''}` };
        }
        if (reason === 'identity_missing') {
          return { badge, btn: '无法签到', clickable: false, tip: data.message || '缺少设备身份组件' };
        }
        return {
          badge,
          btn: missing > 0 ? `补签 ${missing} 个账号` : '重试签到',
          clickable: true,
          tip: data.message || '部分账号没签成，可以再试一次',
        };
      }
      case 'pending':
        if (reason === 'quota_cooldown') {
          return {
            badge: `冷却中${clock ? '（至 ' + clock + '）' : ''}`,
            btn: '冷却中',
            clickable: false,
            tip: data.message || '额度用尽，冷却期内重复请求只会再被拒',
          };
        }
        if (reason === 'awaiting_window') {
          return {
            badge: `待活动开启${clock ? '（' + clock + '）' : ''}`,
            btn: '待开启',
            clickable: false,
            tip: '官方活动窗口还没到，到点会自动补领',
          };
        }
        if (reason === 'identity_missing') {
          return {
            badge: '缺少设备身份',
            btn: '无法签到',
            clickable: false,
            tip: data.message || '本机缺少该地区的 Qoder 设备身份组件',
          };
        }
        if (reason === 'awaiting_campaign') {
          // 上游还没下发本期活动行，但**窗口还开着**：我们在窗口内按小时补拉，
          // 所以按钮保持可点（点了是真去拉一次，不是空转）。
          return {
            badge: '等上游下发',
            btn: '立即签到',
            clickable: true,
            tip: data.message || '上游活动行还没下发，窗口内会自动补拉；也可以手动再试一次',
          };
        }
        if (reason === 'campaign_closed') {
          return {
            badge: '活动未开启',
            btn: '再试一次',
            clickable: true,
            tip: data.message || '上游签到活动当前关闭；活跃链路已完成，活动开启后会自动补签',
          };
        }
        if (reason === 'await_credits') {
          return {
            badge: '积分待确认',
            btn: '待确认',
            clickable: false,
            tip: data.message || '活跃链路已完成，积分到账以上游确认为准，重复点击不会再领一次',
          };
        }
        return {
          badge: '待补签',
          btn: '立即签到',
          clickable: true,
          tip: data.message || '上游活动行还没下发，窗口内会自动补拉；也可以手动再试一次',
        };
      case 'failed':
        return { badge: '签到失败', btn: '重试签到', clickable: true, tip: data.message || '' };
      case 'restricted':
        return { badge: '账号受限', btn: '账号受限', clickable: false, tip: data.message || '上游已限制该账号，不续期也不重试' };
      case 'expired':
        return { badge: '凭据失效', btn: '需重新登录', clickable: false, tip: data.message || '请在对应客户端重新登录后刷新页面' };
      case 'unconfigured':
        return { badge: '未配置凭据', btn: '配置凭据', clickable: false, tip: data.message || '先配置凭据才能签到' };
      default:
        return { badge: '今日待打卡', btn: '立即签到', clickable: true, tip: data.message || '' };
    }
  };

  /** 一次签到动作的结果文案（点击后闪示在按钮上） */
  const verdictText = (r) => {
    const data = r || {};
    const status = String(data.status || '');
    const reason = String(data.pendingReason || '');
    if (status === 'pending') {
      if (reason === 'awaiting_window') return '仍未开启，已约自动补领';
      if (reason === 'quota_cooldown') return '已入冷却，稍后自动重试';
      if (reason === 'identity_missing') return '缺少设备身份，未领取';
      if (reason === 'awaiting_campaign') return '上游还没下发，窗口内继续补拉';
      if (reason === 'campaign_closed') return '活动未开启，稍后再试';
      if (reason === 'await_credits') return '已签到，积分待上游确认';
      return '仍未签到，已安排自动重试';
    }
    return {
      success: '已签到',
      already: '今日已签',
      partial: '部分账号已完成',
      failed: '失败，可重试',
      restricted: '账号受限',
      expired: '凭据失效',
      unconfigured: '未配置凭据',
    }[status] || status || '已完成';
  };

  const parseRunResponse = async (res) => {
    const text = await res.text();
    let json = null;
    if (text.trim()) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`服务返回非 JSON（HTTP ${res.status}）`);
      }
    }
    if (!res.ok) throw new Error(json?.error || json?.message || `HTTP ${res.status}`);
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('服务返回空响应或无效 JSON');
    if (json.ok !== true) throw new Error(json.error || json.message || '签到请求失败');
    return json;
  };

  const allCheckinSummary = (overview) => {
    const entries = Object.entries(overview?.platforms || {}).filter(([, info]) => info);
    if (!entries.length) return { ok: false, text: '未取得平台状态', title: '无法确认签到结果', still: [] };
    const done = entries.filter(([, info]) => ['success', 'already'].includes(info.status)).length;
    const still = entries.filter(([, info]) => !['success', 'already'].includes(info.status)).map(([key]) => key);
    return {
      ok: still.length === 0,
      text: `全签完成 ${done}/${entries.length}${still.length ? ` · ${still.length} 个待补` : ''}`,
      title: still.length ? `仍在等：${still.join('、')}` : '全部平台今日已完成',
      still,
    };
  };

  const api = { cardState, verdictText, parseRunResponse, allCheckinSummary, CHECKIN_BADGE_IDS, CREDIT_PLATFORMS, fmtClock };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CheckinCardState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
