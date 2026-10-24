(function () {
  'use strict';
  var state = {
    snap: null, loading: true,
    inflight: JSON.parse(sessionStorage.getItem('ahc.inflight') || '[]'),
    taskFilter: '',
  };
  var SELF = (state.snap && state.snap.self && state.snap.self.agent) || 'console';
  var $ = function (s) { return document.querySelector(s); };

  function api(path, body) {
    var opt = { headers: { 'content-type': 'application/json' } };
    if (body !== undefined) { opt.method = 'POST'; opt.body = JSON.stringify(body); }
    return fetch(path, opt).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  var toastTimer = null;
  function toast(msg, isErr) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'show' + (isErr ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ''; }, isErr ? 5000 : 2600);
  }

  // 可撤销的一次性操作（归档等）：底部漂浮一行气泡，右侧「撤销」，带倒计时条
  var undoBarTimer = null;
  function showUndoBar(text, onUndo, opts) {
    var o = opts || {};
    var duration = Number(o.duration) || 8000;
    var bar = document.getElementById('undo-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'undo-bar';
      bar.className = 'undo-bar';
      document.body.appendChild(bar);
    }
    clearTimeout(undoBarTimer);
    bar.textContent = '';
    var txt = el('span', 'undo-text', text);
    txt.title = text;
    var action = el('button', 'undo-btn', o.actionLabel || '撤销');
    action.type = 'button';
    var timer = el('span', 'undo-timer');
    bar.appendChild(txt);
    bar.appendChild(action);
    bar.appendChild(timer);
    bar.style.setProperty('--undo-ms', duration + 'ms');
    // 浮在输入框上方（输入框高度会随内容变，所以每次按实际位置算）
    var composer = document.getElementById('chat-composer');
    if (composer) {
      var cRect = composer.getBoundingClientRect();
      if (cRect.height > 0 && cRect.top < window.innerHeight) {
        bar.style.bottom = Math.round(window.innerHeight - cRect.top + 12) + 'px';
      }
    }
    // 重新触发进场与倒计时动画
    bar.classList.remove('show');
    void bar.offsetWidth;
    bar.classList.add('show');
    var close = function () {
      bar.classList.remove('show');
      if (undoBarTimer) { clearTimeout(undoBarTimer); undoBarTimer = null; }
    };
    action.addEventListener('click', function (ev) {
      ev.stopPropagation();
      close();
      if (typeof onUndo === 'function') onUndo();
    });
    undoBarTimer = setTimeout(close, duration);
    return close;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function btn(label, cls, fn) {
    var b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }
  // 图片站内预览：点击图片在当前页放大，不再跳新标签页
  function openImageLightbox(url, alt) {
    var box = document.getElementById('img-lightbox');
    var img = document.getElementById('img-lightbox-img');
    if (!box || !img || !url) return;
    img.src = url;
    img.alt = alt || '图片预览';
    box.hidden = false;
  }
  (function bindImageLightbox() {
    var box = document.getElementById('img-lightbox');
    if (!box) return;
    box.addEventListener('click', function () {
      box.hidden = true;
      var img = document.getElementById('img-lightbox-img');
      if (img) img.removeAttribute('src');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !box.hidden) {
        box.hidden = true;
        var img = document.getElementById('img-lightbox-img');
        if (img) img.removeAttribute('src');
      }
    });
  })();

  function copyText(text, successMsg) {
    var str = String(text != null ? text : '');
    function fallback() {
      try {
        var tmp = document.createElement('textarea');
        tmp.value = str;
        tmp.setAttribute('readonly', '');
        tmp.style.position = 'fixed';
        tmp.style.top = '0';
        tmp.style.left = '0';
        tmp.style.width = '2em';
        tmp.style.height = '2em';
        tmp.style.padding = '0';
        tmp.style.border = 'none';
        tmp.style.outline = 'none';
        tmp.style.boxShadow = 'none';
        tmp.style.background = 'transparent';
        tmp.style.opacity = '0';
        tmp.style.zIndex = '-9999';
        document.body.appendChild(tmp);
        tmp.focus();
        tmp.select();
        tmp.setSelectionRange(0, str.length);
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(tmp);
        if (ok) {
          toast(successMsg || '已复制');
        } else {
          toast('复制失败，请手动选择复制', true);
        }
      } catch (e) {
        toast('复制失败，请手动选择复制', true);
      }
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(str).then(function () {
        toast(successMsg || '已复制');
      }).catch(function () {
        fallback();
      });
    } else {
      fallback();
    }
  }
  window.copyText = copyText;

  function loadSnapshot() {
    return api('/api/snapshot').then(function (snap) {
      state.snap = snap;
      state.loading = false;
      var prevSelf = SELF;
      SELF = (snap && snap.self && snap.self.agent) || 'console';
      var bb = $('#banner');
      bb.hidden = !!snap.ok;
      if (!snap.ok) $('#banner-text').textContent = '无法连接 ' + snap.endpoint.label + '（' + snap.endpoint.host + '）：' + snap.error;
      render();
      positionPillDock();
      if (prevSelf !== SELF) {
        populateChatTargets();
        renderPlatformList();
      }
    }).catch(function (err) {
      state.loading = false;
      state.snap = null;
      var bb = $('#banner');
      bb.hidden = false;
      $('#banner-text').textContent = '快照加载失败：' + err.message;
      render();
      positionPillDock();
    });
  }

  // ---------------- 模态框
  var modalResolver = null;
  var modalExtraAction = null;
  function openModal(title, fields, submitLabel, extraBtn) {
    $('#modal-title').textContent = title;
    var headActions = $('#modal-head-actions');
    if (headActions) headActions.textContent = '';
    var form = $('#modal-form');
    form.textContent = '';
    var inputs = {};
    fields.forEach(function (f) {
      var wrap = el('div', 'field');
      var lb = el('label', null, f.label);
      lb.htmlFor = 'mf-' + f.name;
      wrap.appendChild(lb);
      var ctl;
      if (f.type === 'select') {
        ctl = el('select');
        (f.options || []).forEach(function (o) {
          var op = el('option', null, o.label);
          op.value = o.value;
          if (o.value === f.value) op.selected = true;
          ctl.appendChild(op);
        });
      } else if (f.type === 'textarea') {
        ctl = el('textarea');
        ctl.rows = f.rows || 4;
        if (f.value) ctl.value = f.value;
        if (f.placeholder) ctl.placeholder = f.placeholder;
      } else {
        ctl = el('input');
        ctl.type = f.type || 'text';
        if (f.value !== undefined) ctl.value = f.value;
        if (f.placeholder) ctl.placeholder = f.placeholder;
      }
      ctl.id = 'mf-' + f.name;
      ctl.name = f.name;
      if (f.required) ctl.required = true;
      wrap.appendChild(ctl);
      form.appendChild(wrap);
      inputs[f.name] = ctl;
    });
    $('#modal-err').style.display = 'none';
    $('#modal-err').textContent = '';
    $('#modal-ok').textContent = submitLabel || '确认';
    var extraEl = $('#modal-extra');
    if (extraEl) {
      if (extraBtn && extraBtn.label) {
        extraEl.textContent = extraBtn.label;
        extraEl.style.display = 'inline-flex';
        modalExtraAction = extraBtn.action || null;
      } else {
        extraEl.style.display = 'none';
        modalExtraAction = null;
      }
    }
    $('#modal').showModal();
    setTimeout(function () { var first = form.querySelector('textarea,input,select'); if (first) first.focus(); }, 30);
    return new Promise(function (resolve) { modalResolver = { resolve: resolve, inputs: inputs, form: form }; });
  }
  function closeModal(result) {
    modalExtraAction = null;
    var headActions = $('#modal-head-actions');
    if (headActions) headActions.textContent = '';
    if (modalResolver) {
      var r = modalResolver;
      modalResolver = null;
      var dlg = $('#modal');
      if (dlg.open) {
        // 抽屉滑出后再真正关闭
        dlg.classList.add('drawer-closing');
        setTimeout(function () {
          dlg.classList.remove('drawer-closing');
          try { dlg.close(); } catch (e) { /* noop */ }
          r.resolve(result);
        }, 200);
      } else {
        r.resolve(result);
      }
    }
  }
  $('#modal-cancel').addEventListener('click', function () { closeModal(null); });
  var extraBtnEl = $('#modal-extra');
  if (extraBtnEl) extraBtnEl.addEventListener('click', function () {
    if (typeof modalExtraAction === 'function') modalExtraAction();
  });
  $('#modal').addEventListener('cancel', function () { closeModal(null); });
  // 点遮罩（dialog 自身空白区）退出当前弹层
  $('#modal').addEventListener('click', function (e) {
    if (e.target === this) closeModal(null);
  });
  $('#modal-ok').addEventListener('click', function () {
    if (!modalResolver) return;
    var vals = {};
    var f = modalResolver.form;
    var ok = true;
    Object.keys(modalResolver.inputs).forEach(function (k) {
      var ctl = modalResolver.inputs[k];
      vals[k] = ctl.value.trim();
      if (ctl.required && !vals[k]) ok = false;
    });
    if (!ok) {
      var e = $('#modal-err');
      e.textContent = '必填项不能为空';
      e.style.display = 'inline';
      return;
    }
    closeModal(vals);
  });

  // ---------------- 操作
  function withBusy(button, fn) {
    if (button) button.disabled = true;
    Promise.resolve().then(fn).catch(function (err) {
      toast(err.message, true);
    }).finally(function () {
      if (button) button.disabled = false;
    });
  }

  function agentOptions() {
    return (state.snap ? state.snap.agents : []).map(function (a) {
      return { value: a.name, label: a.name + (a.online ? '（在线）' : '') };
    });
  }

  function dispatchTo(agent, button) {
    withBusy(button, function () {
      var fields = [{ name: 'task', label: '任务内容（将作为无头 CLI 提示词 / 桌面驱动指令）', type: 'textarea', required: true, rows: 5, placeholder: '例：解释当前目录 src/hub 的调度流程并列出改进点' }];
      var dftLabel = agent.defaultModel ? ('默认模型：' + agent.defaultModel) : '默认模型（CLI 内置）';
      var modelOpts = [{ value: '', label: dftLabel }];
      if (agent.models && agent.models.length) {
        agent.models.forEach(function (mm) {
          if (mm.alias !== '默认' && mm.alias !== 'default') {
            modelOpts.push({ value: mm.alias, label: mm.alias + ' → ' + mm.id });
          }
        });
      }
      if (agent.defaultModel || (agent.models && agent.models.length)) {
        fields.push({ name: 'model', label: '模型（别名）', type: 'select', value: '', options: modelOpts });
      }
      return openModal('派活给子代理 ' + agent.name, fields, '派发').then(function (vals) {
        if (!vals) return null;
        toast('已提交，等待受理…');
        return api('/api/dispatch', { agent: agent.name, task: vals.task, model: vals.model || undefined }).then(function (r) {
          var ref = r.ref;
          if (ref) {
            addInflight(ref, agent.name, vals.task);
            toast('已异步受理：' + ref);
          } else {
            showSyncResult(agent.name, r.text);
          }
          refreshSoon();
        });
      });
    });
  }

  function showSyncResult(agent, text) {
    openModal(agent + ' · 同步返回', [{ name: 't', label: '输出', type: 'textarea', value: text, rows: 10 }], '关闭').then(function () { closeModal(null); });
    var ta = document.querySelector('#mf-t');
    if (ta) ta.readOnly = true;
    $('#modal-ok').textContent = '关闭';
  }

  function postTask(button) {
    withBusy(button, function () {
      return openModal('发布任务到共享队列', [
        { name: 'title', label: '标题', required: true, placeholder: '一句话任务标题' },
        { name: 'detail', label: '详情 / 上下文（可选）', type: 'textarea', rows: 4 },
        { name: 'to_agent', label: '指派子代理', type: 'select', options: [{ value: '', label: '不指派（任意代理认领）' }].concat(agentOptions()) },
        { name: 'priority', label: '优先级', type: 'select', value: 'normal', options: [{ value: 'low', label: 'low' }, { value: 'normal', label: 'normal' }, { value: 'high', label: 'high' }] },
      ], '入队').then(function (vals) {
        if (!vals) return null;
        return api('/api/task/post', vals).then(function (r) {
          toast(r.text);
          refreshSoon();
        });
      });
    });
  }

  function claimTask(task, button) {
    withBusy(button, function () {
      return openModal('认领任务 ' + task.id, [
        { name: 'agent', label: '以哪个代理身份认领', type: 'select', options: [{ value: SELF, label: SELF + '（本控制台）' }].concat(agentOptions()), value: SELF },
      ], '认领').then(function (vals) {
        if (!vals) return null;
        return api('/api/task/claim', { task_id: task.id, agent: vals.agent }).then(function (r) {
          toast(r.text);
          refreshSoon();
        });
      });
    });
  }

  function completeTask(task, button) {
    withBusy(button, function () {
      return openModal('完成任务 ' + task.id, [
        { name: 'agent', label: '完成方代理', type: 'select', options: [{ value: SELF, label: SELF }].concat(agentOptions()), value: task.claimedBy || SELF },
        { name: 'result', label: '结果（自动回传给发起方 ' + task.from + '）', type: 'textarea', rows: 4 },
        { name: 'success', label: '结果', type: 'select', value: 'yes', options: [{ value: 'yes', label: '成功完成' }, { value: 'no', label: '失败'} ] },
      ], '提交').then(function (vals) {
        if (!vals) return null;
        return api('/api/task/complete', { task_id: task.id, agent: vals.agent, result: vals.result, success: vals.success === 'yes' }).then(function (r) {
          toast(r.text);
          refreshSoon();
        });
      });
    });
  }

  function messageAgent(agent, button) {
    withBusy(button, function () {
      return openModal('发私信给 ' + agent.name, [
        { name: 'text', label: '消息内容', type: 'textarea', required: true, rows: 4 },
      ], '投递').then(function (vals) {
        if (!vals) return null;
        return api('/api/message', { to_agent: agent.name, from_agent: SELF, text: vals.text }).then(function (r) {
          toast(r.text);
        });
      });
    });
  }

  function inboxAgent(agent, button) {
    withBusy(button, function () { return loadInbox(agent, false); });
  }
  function loadInbox(agent, markRead) {
    return api('/api/inbox', { agent: agent.name, mark_read: !!markRead }).then(function (r) {
      var body = el('div', 'msgs');
      if (!r.messages.length) body.appendChild(el('div', 'empty', agent.name + ' 没有未读消息'));
      r.messages.forEach(function (m) {
        var box = el('div', 'msg');
        var head = el('div', 'mhead');
        head.appendChild(el('span', 'mono', m.ts));
        head.appendChild(el('span', null, '来自 ' + m.from));
        box.appendChild(head);
        box.appendChild(el('div', 'mtext', m.text));
        body.appendChild(box);
      });
      // 直接借用模态: 内容区替换
      $('#modal-title').textContent = '收件箱 · ' + agent.name;
      var headActions = $('#modal-head-actions');
      if (headActions) headActions.textContent = '';
      var form = $('#modal-form');
      form.textContent = '';
      form.appendChild(body);
      $('#modal-err').style.display = 'none';
      $('#modal-ok').textContent = '关闭';
      modalResolver = { resolve: function () {}, inputs: {}, form: form };
      $('#modal').showModal();
    });
  }

  function writeNote(button) {
    withBusy(button, function () {
      return openModal('写共享笔记', [
        { name: 'key', label: '键名（跨代理约定）', required: true, placeholder: '例 project-conventions' },
        { name: 'value', label: '内容', type: 'textarea', required: true, rows: 4 },
      ], '保存').then(function (vals) {
        if (!vals) return null;
        return api('/api/note/set', vals).then(function (r) {
          toast(r.text);
          refreshSoon();
        });
      });
    });
  }

  // ---------------- 实时对话（CodeBuddy 平台与多会话机制）
  var AGENT_THEMES = {
    'antigravity': { color: '#8ab4f8', glow: 'rgba(138, 180, 248, 0.35)', bg: 'linear-gradient(135deg, #1e1b4b, #312e81)', label: 'Antigravity' },
    'codearts': { color: '#ef4444', glow: 'rgba(239, 68, 68, 0.35)', bg: 'linear-gradient(135deg, #450a0a, #7f1d1d)', label: 'CodeArts' },
    'codebuddy': { color: '#818cf8', glow: 'rgba(129, 140, 248, 0.35)', bg: 'linear-gradient(135deg, #172554, #1e1b4b)', label: 'CodeBuddy' },
    'codebuddy-cn': { color: '#38bdf8', glow: 'rgba(56, 189, 248, 0.35)', bg: 'linear-gradient(135deg, #082f49, #1e1b4b)', label: 'CodeBuddy CN' },
    'github-copilot': { color: '#c084fc', glow: 'rgba(192, 132, 252, 0.35)', bg: 'linear-gradient(135deg, #18181b, #27272a)', label: 'Copilot' },
    'mimocode': { color: '#fb923c', glow: 'rgba(251, 146, 60, 0.35)', bg: 'linear-gradient(135deg, #431407, #7c2d12)', label: 'MiMo' },
    'minimaxcode': { color: '#f43f5e', glow: 'rgba(244, 63, 94, 0.35)', bg: 'linear-gradient(135deg, #4c0519, #881337)', label: 'MiniMax' },
    'traecode': { color: '#34d399', glow: 'rgba(52, 211, 153, 0.35)', bg: 'linear-gradient(135deg, #022c22, #064e3b)', label: 'TRAE' },
    'zcode': { color: '#60a5fa', glow: 'rgba(96, 165, 250, 0.35)', bg: 'linear-gradient(135deg, #172554, #1e3a8a)', label: 'ZCode' },
    'opencode': { color: '#cbd5e1', glow: 'rgba(203, 213, 225, 0.35)', bg: 'linear-gradient(135deg, #0b1220, #1f2937)', label: 'opencode' },
    'cline': { color: '#22d3ee', glow: 'rgba(34, 211, 238, 0.35)', bg: 'linear-gradient(135deg, #083344, #164e63)', label: 'Cline' },
    'qoder': { color: '#2ADB5C', glow: 'rgba(42, 219, 92, 0.35)', bg: 'linear-gradient(135deg, #052e16, #14532d)', label: 'Qoder' },
    'qoder-cn': { color: '#10b981', glow: 'rgba(16, 185, 129, 0.35)', bg: 'linear-gradient(135deg, #022c22, #065f46)', label: 'Qoder CN' },
    'console': { color: '#a78bfa', glow: 'rgba(167, 139, 250, 0.35)', bg: 'linear-gradient(135deg, #1e1b4b, #2e1065)', label: 'Console' }
  };
  // 这个脚本是 IIFE，var 不会挂到 window；第二个 script（签到卡片配色条）要用，显式导出
  window.AGENT_THEMES = AGENT_THEMES;

  var AGENT_COLORS = {
    'codearts': { bg: 'linear-gradient(135deg, #C7000B, #ef4444)', code: 'CA' },
    'codebuddy': { bg: 'linear-gradient(135deg, #2563eb, #7c3aed)', code: 'CB' },
    'codebuddy-cn': { bg: 'linear-gradient(135deg, #0284c7, #6366f1)', code: 'CN' },
    'zcode': { bg: 'linear-gradient(135deg, #059669, #0284c7)', code: 'ZC' },
    'antigravity': { bg: 'linear-gradient(135deg, #4f46e5, #9333ea)', code: 'AN' },
    'github-copilot': { bg: 'linear-gradient(135deg, #475569, #2563eb)', code: 'GH' },
    'mimocode': { bg: 'linear-gradient(135deg, #db2777, #7c3aed)', code: 'MC' },
    'traecode': { bg: 'linear-gradient(135deg, #ea580c, #dc2626)', code: 'TR' },
    'console': { bg: 'linear-gradient(135deg, #0ea5e9, #6366f1)', code: 'CS' },
    'minimax-code': { bg: 'linear-gradient(135deg, #d97706, #ea580c)', code: 'MX' },
    'minimaxcode': { bg: 'linear-gradient(135deg, #9d174d, #e2167e)', code: 'MX' },
    'meoo': { bg: 'linear-gradient(135deg, #34d399, #059669)', code: '秒' },
    'meoo-cn': { bg: 'linear-gradient(135deg, #34d399, #0d9488)', code: '秒' },
    'opencode': { bg: 'linear-gradient(135deg, #0f172a, #334155)', code: 'OC' },
    'cline': { bg: 'linear-gradient(135deg, #0891b2, #06b6d4)', code: 'CL' },
    'qoder': { bg: 'linear-gradient(135deg, #16a34a, #2ADB5C)', code: 'QD' },
    'qoder-cn': { bg: 'linear-gradient(135deg, #047857, #10b981)', code: 'QC' }
  };
  function getAgentVisual(name) {
    if (name && AGENT_COLORS[name]) return AGENT_COLORS[name];
    var str = String(name || 'AG');
    var hash = 0;
    for (var i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    var h1 = Math.abs(hash % 360);
    var h2 = (h1 + 45) % 360;
    return {
      bg: 'linear-gradient(135deg, hsl(' + h1 + ', 70%, 46%), hsl(' + h2 + ', 70%, 46%))',
      code: str.slice(0, 2).toUpperCase()
    };
  }

  // 取所选子代理的主题色（单一真源：AGENT_THEMES.color），未知代理按名称哈希生成稳定色
  function getAgentAccent(name) {
    var theme = AGENT_THEMES[name];
    if (theme && theme.color) return theme;
    var str = String(name || 'hub');
    var hash = 0;
    for (var i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    var hue = Math.abs(hash % 360);
    return {
      color: 'hsl(' + hue + ', 70%, 46%)',
      glow: 'hsla(' + hue + ', 70%, 46%, 0.32)',
      label: str
    };
  }

  // 把当前子代理主题色写入 <html> 的 CSS 变量，驱动发送按钮 / 模型胶囊 / 状态栏模型名 / 上下文进度条
  function applyAgentAccent(agent) {
    if (!agent) agent = chat.activeAgent || ($('#chat-target') ? $('#chat-target').value : '') || 'codebuddy';
    var accent = getAgentAccent(agent);
    var root = document.documentElement;
    root.style.setProperty('--agent-accent', accent.color);
    root.style.setProperty('--agent-accent-glow', accent.glow || 'rgba(59, 130, 246, 0.32)');
    root.setAttribute('data-active-agent', agent);
    return accent;
  }

  // 侧栏快速提炼额度摘要胶囊
  function getAgentQuotaCapsule(name) {
    var q = (quotasData && quotasData[name]) || (quotasData && quotasData.workers && quotasData.workers[name]) || null;
    if (!q || !q.quotas) {
      if (q && q.plan) {
        var pName = q.plan.replace(/开发者|专属版|企业专享版|版授权/g, '').trim();
        return { text: pName || 'Ready', cls: 'pill-quota' };
      }
      return null;
    }
    var keys = Object.keys(q.quotas);
    if (!keys.length) return null;
    var firstQ = q.quotas[keys[0]];
    if (!firstQ) return null;
    if (firstQ.unlimited) return { text: '无限制', cls: 'pill-quota' };
    var pct = firstQ.remainingPercentage;
    if (typeof pct === 'number') {
      var cls = 'pill-quota';
      if (pct < 15) cls += ' critical';
      else if (pct < 40) cls += ' warn';
      return { text: '余' + Math.round(pct) + '%', cls: cls };
    }
    if (firstQ.total && firstQ.used !== undefined) {
      var rem = Math.max(0, firstQ.total - firstQ.used);
      return { text: rem + '次', cls: 'pill-quota' };
    }
    return { text: '活跃', cls: 'pill-quota' };
  }

  // 侧栏 Cache 缓存或最后交互时间胶囊
  function getAgentCacheCapsule(name, updatedTs) {
    if (!updatedTs) return { text: 'cache 5m', cls: 'pill-cache' };
    var diff = Date.now() - updatedTs;
    if (diff < 60000) return { text: '刚刚活跃', cls: 'pill-cache' };
    if (diff < 3600000) return { text: 'cache ' + Math.max(1, Math.round(diff / 60000)) + 'm', cls: 'pill-cache' };
    if (diff < 86400000) return { text: Math.round(diff / 3600000) + 'h前', cls: 'pill-sess-count' };
    return { text: '冷备', cls: 'pill-sess-count' };
  }

  // 平台卡片底行摘要挂载/更新：无真实内容时不渲染整行（占位"待机"不再显示，卡片保持单行）
  function mountAgentSummaryRow(body, theme, text) {
    if (!body) return;
    var row = body.querySelector('.platform-capsule-summary');
    if (row) {
      var tEl = row.querySelector('.platform-capsule-summary-text');
      if (tEl) { tEl.textContent = text; tEl.title = text; }
      return;
    }
    row = el('div', 'platform-capsule-summary');
    var dot = el('span', 'platform-summary-dot');
    dot.style.background = (theme && theme.color) || 'var(--gem-primary)';
    dot.style.boxShadow = '0 0 6px ' + ((theme && theme.glow) || 'rgba(138, 180, 248, 0.4)');
    row.appendChild(dot);
    var textEl = el('span', 'platform-capsule-summary-text', text);
    textEl.title = text;
    row.appendChild(textEl);
    body.appendChild(row);
  }

  // 按 agent 名从当前 DOM 查找并挂载（异步摘要到达时用）
  function mountAgentSummaryByName(name, text) {
    var item = document.querySelector('.platform-item[data-agent="' + name + '"]');
    if (!item) return;
    var theme = (typeof AGENT_THEMES !== 'undefined' && AGENT_THEMES[name]) || null;
    mountAgentSummaryRow(item.querySelector('.platform-capsule-body'), theme, text);
  }

  // LLM 智能微总结客户端缓存与回调
  var agentSmartSummaries = {};
  function loadAgentSummaries() {
    return api('/api/chat/agent-summary').then(function (res) {
      if (res && res.summaries) {
        agentSmartSummaries = Object.assign(agentSmartSummaries, res.summaries);
        Object.keys(res.summaries).forEach(function (name) {
          if (res.summaries[name]) mountAgentSummaryByName(name, res.summaries[name]);
        });
      }
    }).catch(function () {});
  }
  window.__ahSetAgentSummary = function(name, summary) {
    if (name && summary) {
      agentSmartSummaries[name] = summary;
      mountAgentSummaryByName(name, summary);
    }
  };

  // Qoder / Qoder CN 共用官方品牌图标（LobeHub qoder-color.svg，品牌绿 #2ADB5C）
  var QODER_BRAND_ICON = "<svg fill=\"currentColor\" height=\"1em\" style=\"flex:none;line-height:1\" viewBox=\"0 0 24 24\" width=\"1em\" xmlns=\"http://www.w3.org/2000/svg\"><title>Qoder</title><path d=\"M23.376 14.458v-4.056c0-2.304-1.003-4.154-2.748-5.075L11.612.574l-.046.086-.045.086c1.68.886 2.644 2.673 2.644 4.902v4.056a7.928 7.928 0 01-.014.454l-.005.061c-.005.081-.01.164-.018.245a4.897 4.897 0 01-.011.1l-.01.076c-.008.068-.015.135-.025.203l-.018.113-.01.058a9.99 9.99 0 01-.098.513l-.007.03a7.209 7.209 0 01-.074.294l-.024.086c-.027.099-.056.197-.087.296l-.027.085a9.592 9.592 0 01-.111.323l-.033.085-.018.046c-.032.082-.064.166-.098.248-.019.048-.04.096-.061.145l-.007.017a6 6 0 01-.084.187c-.024.056-.05.11-.077.165-.03.061-.058.122-.089.182a9.423 9.423 0 01-.176.332c-.03.056-.062.111-.094.167-.031.053-.062.108-.095.16-.033.055-.066.11-.101.164-.033.053-.065.104-.1.155-.034.055-.07.107-.111.169l-.099.144a15.193 15.193 0 01-.34.457c-.04.05-.08.102-.121.151l-.107.128-.007.008a6.987 6.987 0 01-.262.298l-.149.16-.116.12a9.562 9.562 0 01-.204.198l-.03.03-.072.069a9.05 9.05 0 01-.263.235l-.025.022-.029.026-.042.035a11.7 11.7 0 01-.22.18l-.07.055-.018.013a8.904 8.904 0 01-.194.146c-.029.02-.057.042-.086.063a7.7 7.7 0 01-.22.152l-.057.04a8.865 8.865 0 01-.293.185l-.062.037a10.424 10.424 0 01-.307.173l-.037.02-.196.103-.108.052-.012.006a6.196 6.196 0 01-.315.143c-.065.028-.13.054-.196.08l-.035.014-.086.034c-.07.026-.143.05-.215.075l-.039.014-.064.023a8.056 8.056 0 01-.323.097l-.63.173a7.285 7.285 0 01-.33.08l-.07.015c-.053.012-.104.023-.157.032l-.065.011-.085.015a2.332 2.332 0 01-.194.027l-.085.01a4.715 4.715 0 01-.16.018l-.034.003a4.861 4.861 0 01-.246.016h-.033a2.714 2.714 0 01-.155.005h-.106a3.384 3.384 0 01-.225-.007H4.86l-.15-.012-.066-.006a5.586 5.586 0 01-.187-.02l-.04-.005a5.14 5.14 0 01-.219-.035l-.054-.01a6.943 6.943 0 01-.347-.082l-.03-.008-.038-.01a5.034 5.034 0 01-.269-.086l-.063-.023a4.216 4.216 0 01-.188-.073l-.071-.031-.016-.007a4.959 4.959 0 01-.16-.074l-.026-.013a.164.164 0 00-.014-.007l-.671-.351.486.486h.016l8.995 4.742.093.048.03.014.02.01c.056.026.111.052.169.076l.016.008.073.032.195.076.022.008a.718.718 0 01.03.012l.014.004a4.693 4.693 0 00.323.1l.027.007c.073.02.147.038.22.055l.018.004.027.006.066.013.088.016c.075.014.15.026.226.038l.042.004c.064.009.128.016.193.022l.126.012.06.003.05.002.098.005c.046.002.094.002.14.003h.12c.05 0 .1-.002.161-.005h.033l.07-.004a6.17 6.17 0 00.184-.014l.033-.003a.753.753 0 00.058-.005l.108-.012.081-.01.08-.01.129-.021.082-.014.071-.012c.054-.01.107-.021.16-.033l.066-.013.059-.013c.096-.022.192-.046.287-.073l.63-.172a7.354 7.354 0 00.397-.122l.04-.015c.075-.025.149-.051.222-.078.032-.011.062-.024.093-.037l.03-.012c.067-.027.135-.054.2-.082l.128-.056.195-.09.021-.01.102-.05c.068-.034.135-.069.202-.105l.037-.02.073-.038c.08-.044.16-.092.24-.139l.026-.015a8.086 8.086 0 00.322-.2l.065-.045 1.98.902a1.748 1.748 0 002.472-1.59v-7.33l.004.004z\" fill=\"#2ADB5C\"></path><path d=\"M11.617.576a3.904 3.904 0 00-.093-.047c-.016-.009-.033-.016-.05-.024a5.854 5.854 0 00-.166-.077l-.09-.04a4.094 4.094 0 00-.194-.074c-.017-.006-.035-.015-.053-.02l-.013-.005a5.18 5.18 0 00-.277-.088l-.07-.019a4.034 4.034 0 00-.219-.053c-.015-.003-.03-.008-.044-.012L10.253.1l-.057-.011a5.177 5.177 0 00-.225-.036L9.928.047a5.972 5.972 0 00-.191-.022L9.669.02a1.33 1.33 0 00-.058-.005L9.515.009a4.058 4.058 0 00-.111-.005C9.354 0 9.304 0 9.254 0h-.109c-.052 0-.106.004-.16.004L8.884.01A5.32 5.32 0 008.7.022l-.083.006h-.008c-.05.005-.1.013-.15.019l-.12.014c-.056.008-.112.018-.169.028-.037.006-.074.011-.11.018a7.054 7.054 0 00-.572.133l-.63.172c-.111.031-.22.064-.33.1-.037.011-.072.025-.108.037a12.91 12.91 0 00-.345.126c-.067.027-.133.054-.2.083l-.128.055a11.916 11.916 0 00-.318.15 7.376 7.376 0 00-.311.163c-.082.045-.16.092-.24.14a9.424 9.424 0 00-.35.218l-.016.01-.06.04a9.242 9.242 0 00-.51.37 12.54 12.54 0 00-.315.254l-.043.034-.01.007-.045.041c-.09.078-.18.158-.268.24l-.106.101c-.07.067-.139.135-.207.204l-.056.054-.063.067-.153.164-.12.133-.148.17c-.024.03-.049.057-.073.086l-.043.053a5.96 5.96 0 00-.123.155l-.118.151c-.04.053-.08.106-.118.16l-.075.101-.038.056-.107.155-.11.164a9.91 9.91 0 00-.168.265c-.012.02-.023.043-.037.063a12.43 12.43 0 00-.192.335l-.09.168c-.019.034-.04.07-.057.105-.011.022-.02.043-.032.065l-.092.188-.08.167a19.15 19.15 0 00-.083.192c-.017.038-.035.076-.05.115-.008.016-.014.034-.021.051-.035.083-.067.167-.1.253l-.051.134c-.04.11-.077.22-.113.33l-.02.057c0 .002 0 .005-.002.007l-.008.026c-.032.1-.06.2-.09.301l-.023.089c-.027.1-.052.2-.075.301l-.007.03a7.63 7.63 0 00-.057.267l-.008.048c-.015.074-.026.148-.038.223L.082 8.4c-.011.078-.02.156-.029.234-.006.051-.013.103-.017.154a6.57 6.57 0 00-.02.26c-.003.044-.007.086-.009.13-.004.128-.007.257-.007.386v4.056c0 1.478.42 2.741 1.138 3.692A4.75 4.75 0 002.73 18.67l9.015 4.753c-1.656-.874-2.728-2.685-2.73-5.051v-4.056c0-.13.004-.26.01-.39.002-.043.006-.085.01-.128.005-.088.01-.174.019-.261l.017-.155c.01-.077.018-.155.029-.234l.026-.164c.013-.074.025-.15.039-.223.02-.105.04-.21.064-.313l.008-.031c.023-.1.048-.201.075-.301l.023-.088c.028-.1.058-.202.09-.302l.008-.025.021-.063c.036-.11.073-.22.113-.33l.052-.134c.031-.085.065-.169.1-.253.022-.056.047-.111.07-.166a13.856 13.856 0 01.164-.358c.03-.063.06-.126.092-.188l.088-.172a9.22 9.22 0 01.187-.338l.096-.164c.034-.057.069-.112.104-.168l.1-.159a10.49 10.49 0 01.567-.786l.123-.155.116-.139c.05-.057.098-.115.148-.171a14.092 14.092 0 01.272-.297 9.706 9.706 0 01.432-.425c.088-.083.177-.163.268-.241l.054-.048a10.08 10.08 0 01.553-.435l.092-.068c.075-.053.15-.105.226-.156.019-.013.038-.028.06-.04a9.18 9.18 0 01.362-.227c.08-.047.16-.094.241-.139l.11-.058a7.643 7.643 0 01.521-.256l.126-.056a7.509 7.509 0 01.546-.208l.107-.037c.11-.036.22-.069.33-.1l.63-.172c.095-.026.191-.05.287-.072l.097-.02c.062-.014.125-.029.187-.04l.114-.018c.055-.01.11-.02.166-.028.04-.006.08-.01.12-.014.053-.007.105-.014.157-.019l.083-.006c.061-.005.123-.01.184-.013.034-.003.067-.003.101-.004l.16-.006h.11a3.187 3.187 0 01.261.008l.153.01.067.007c.064.006.128.013.192.022l.043.005a5.232 5.232 0 01.281.047l.141.03c.073.016.146.035.218.053l.07.019c.094.026.187.055.278.087l.067.025a4.326 4.326 0 01.449.19l.143.072L11.617.576z\"></path></svg>";
  var BRAND_ICONS = {
    'codearts': '<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Huawei</title><path d="M10.341 17.042s.062-.061 0-.061C7.516 10.902 3.646 6.22 3.646 6.22S1.557 8.168 1.68 10.174c.061 1.52 1.228 2.37 1.228 2.37 1.843 1.763 6.266 4.012 7.31 4.499h.123zm-.737 1.52c0-.061-.123-.061-.123-.061l-7.371.243c.798 1.398 2.15 2.492 3.563 2.188.983-.243 3.194-1.763 3.87-2.25.123-.12.061-.12.061-.12zm.123-.67c.062-.06 0-.12 0-.12C6.471 15.581.206 12.3.206 12.3c-.553 1.763.184 3.161.184 3.161.798 1.702 2.334 2.189 2.334 2.189.676.303 1.413.303 1.413.303h5.529c.061 0 .061-.06.061-.06zm.492-14.831c-.308 0-1.168.243-1.168.243-1.965.486-2.395 2.249-2.395 2.249-.369 1.094 0 2.31 0 2.31.675 2.857 3.87 7.598 4.545 8.57l.062.062c.061 0 .061-.061.061-.061C12.43 5.796 10.22 3.06 10.22 3.06zm2.457 13.373c.061 0 .123-.061.123-.061.737-1.033 3.87-5.714 4.545-8.57 0 0 .369-1.399 0-2.31 0 0-.491-1.764-2.457-2.25 0 0-.553-.121-1.167-.243 0 0-2.211 2.796-1.106 13.312 0 .122.062.122.062.122zm1.72 2.067s-.062 0-.062.06v.122c.738.486 2.826 2.006 3.87 2.249 0 0 1.905.669 3.563-2.188l-7.371-.243zm9.398-6.261s-6.265 3.343-9.521 5.531c0 0-.062.06-.062.122 0 0 0 .06.062.06h5.651s.553 0 1.29-.303c0 0 1.536-.487 2.396-2.25 0-.06.737-1.458.184-3.16zM13.66 17.042s.061.06.122 0c1.045-.547 5.468-2.736 7.31-4.499 0 0 1.168-.911 1.23-2.37.122-2.067-1.967-3.951-1.967-3.951s-3.87 4.559-6.695 10.698c0 0-.062.06 0 .122z" fill="#C7000B"></path></svg>',
    'antigravity': '<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Antigravity</title><mask height="23" id="lobe-icons-antigravity-0-_R_0_" maskUnits="userSpaceOnUse" width="24" x="0" y="1"><path d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z" fill="#fff"></path></mask><g mask="url(#lobe-icons-antigravity-0-_R_0_)"><g filter="url(#lobe-icons-antigravity-1-_R_0_)"><path d="M-1.018-3.992c-.408 3.591 2.686 6.89 6.91 7.37 4.225.48 7.98-2.043 8.387-5.633.408-3.59-2.686-6.89-6.91-7.37-4.225-.479-7.98 2.043-8.387 5.633z" fill="#FFE432"></path></g><g filter="url(#lobe-icons-antigravity-2-_R_0_)"><path d="M15.269 7.747c1.058 4.557 5.691 7.374 10.348 6.293 4.657-1.082 7.575-5.653 6.516-10.21-1.058-4.556-5.691-7.374-10.348-6.292-4.657 1.082-7.575 5.653-6.516 10.21z" fill="#FC413D"></path></g><g filter="url(#lobe-icons-antigravity-3-_R_0_)"><path d="M-12.443 10.804c1.338 4.703 7.36 7.11 13.453 5.378 6.092-1.733 9.947-6.95 8.61-11.652C8.282-.173 2.26-2.58-3.833-.848-9.925.884-13.78 6.1-12.443 10.804z" fill="#00B95C"></path></g><g filter="url(#lobe-icons-antigravity-4-_R_0_)"><path d="M-12.443 10.804c1.338 4.703 7.36 7.11 13.453 5.378 6.092-1.733 9.947-6.95 8.61-11.652C8.282-.173 2.26-2.58-3.833-.848-9.925.884-13.78 6.1-12.443 10.804z" fill="#00B95C"></path></g><g filter="url(#lobe-icons-antigravity-5-_R_0_)"><path d="M-7.608 14.703c3.352 3.424 9.126 3.208 12.896-.483 3.77-3.69 4.108-9.459.756-12.883C2.69-2.087-3.083-1.871-6.853 1.82c-3.77 3.69-4.108 9.458-.755 12.883z" fill="#00B95C"></path></g><g filter="url(#lobe-icons-antigravity-6-_R_0_)"><path d="M9.932 27.617c1.04 4.482 5.384 7.303 9.7 6.3 4.316-1.002 6.971-5.448 5.93-9.93-1.04-4.483-5.384-7.304-9.7-6.301-4.316 1.002-6.971 5.448-5.93 9.93z" fill="#3186FF"></path></g><g filter="url(#lobe-icons-antigravity-7-_R_0_)"><path d="M2.572-8.185C.392-3.329 2.778 2.472 7.9 4.771c5.122 2.3 11.042.227 13.222-4.63 2.18-4.855-.205-10.656-5.327-12.955-5.122-2.3-11.042-.227-13.222 4.63z" fill="#FBBC04"></path></g><g filter="url(#lobe-icons-antigravity-8-_R_0_)"><path d="M-3.267 38.686c-5.277-2.072 3.742-19.117 5.984-24.83 2.243-5.712 8.34-8.664 13.616-6.592 5.278 2.071 11.533 13.482 9.29 19.195-2.242 5.713-23.613 14.298-28.89 12.227z" fill="#3186FF"></path></g><g filter="url(#lobe-icons-antigravity-9-_R_0_)"><path d="M28.71 17.471c-1.413 1.649-5.1.808-8.236-1.878-3.135-2.687-4.531-6.201-3.118-7.85 1.412-1.649 5.1-.808 8.235 1.878s4.532 6.2 3.119 7.85z" fill="#749BFF"></path></g><g filter="url(#lobe-icons-antigravity-10-_R_0_)"><path d="M18.163 9.077c5.81 3.93 12.502 4.19 14.946.577 2.443-3.612-.287-9.727-6.098-13.658-5.81-3.931-12.502-4.19-14.946-.577-2.443 3.612.287 9.727 6.098 13.658z" fill="#FC413D"></path></g><g filter="url(#lobe-icons-antigravity-11-_R_0_)"><path d="M-.915 2.684c-1.44 3.473-.97 6.967 1.05 7.804 2.02.837 4.824-1.3 6.264-4.772 1.44-3.473.97-6.967-1.05-7.804-2.02-.837-4.824 1.3-6.264 4.772z" fill="#FFEE48"></path></g></g><defs><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="17.587" id="lobe-icons-antigravity-1-_R_0_" width="19.838" x="-3.288" y="-11.917"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="0.558"></feGaussianBlur></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="38.565" id="lobe-icons-antigravity-2-_R_0_" width="38.9" x="4.251" y="-13.493"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="2.7"></feGaussianBlur></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="36.517" id="lobe-icons-antigravity-3-_R_0_" width="40.955" x="-21.889" y="-10.592"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="2.296"></feGaussianBlur></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="36.517" id="lobe-icons-antigravity-4-_R_0_" width="40.955" x="-21.889" y="-10.592"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="2.296"></feGaussianBlur></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="36.595" id="lobe-icons-antigravity-5-_R_0_" width="36.632" x="-19.099" y="-10.278"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="2.296"></feGaussianBlur></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="34.087" id="lobe-icons-antigravity-6-_R_0_" width="33.533" x=".981" y="8.758"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="2.182"></feGaussianBlur></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="35.276" id="lobe-icons-antigravity-7-_R_0_" width="35.978" x="-6.143" y="-21.659"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="1.977"></feGaussianBlur></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="46.523" id="lobe-icons-antigravity-8-_R_0_" width="45.114" x="-11.96" y="-.46"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="1.766"></feGaussianBlur></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="24.054" id="lobe-icons-antigravity-9-_R_0_" width="25.094" x="10.485" y=".58"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="1.579"></feGaussianBlur></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="30.007" id="lobe-icons-antigravity-10-_R_0_" width="33.508" x="5.833" y="-12.467"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="1.335"></feGaussianBlur></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="26.151" id="lobe-icons-antigravity-11-_R_0_" width="22.194" x="-8.355" y="-8.876"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="1.651"></feGaussianBlur></filter></defs></svg>',
    'codebuddy': '<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>CodeBuddy</title><path d="M18.821 0H5.18A5.179 5.179 0 000 5.179V18.82A5.179 5.179 0 005.179 24H18.82A5.179 5.179 0 0024 18.821V5.18A5.179 5.179 0 0018.821 0z" fill="url(#lobe-icons-code-buddy-_R_0_)"></path><path d="M18.777 1.647c.28-.02.536.114.972.51 1.018.926 2.437 2.828 3.318 4.452l.34.631.482.24.11.06v3.638a5.206 5.206 0 00-5.32-1.23c-.491.166-1.021.471-2.08 1.082l-6.09 3.516c-1.057.61-1.586.916-1.975 1.259a5.208 5.208 0 00-1.493 5.572c.165.49.471 1.02 1.082 2.08l.315.543h-3.26c-.685 0-1.34-.135-1.939-.377-.169-.956-.009-1.789.469-2.335.158-.18.164-.189.13-.493a11.846 11.846 0 01-.057-1.711l.02-.444-.667-1.18C2.1 15.622 1.445 14.078 1.192 12.9c-.133-.647-.125-.934.04-1.146.1-.128.427-.261.822-.334.994-.175 3.162-.017 5.575.41l.25.043.551-.487c.915-.81 1.522-1.264 2.641-1.962 1.167-.73 2.484-1.331 3.967-1.807l.476-.152.261-.688c.937-2.471 1.896-4.293 2.58-4.9.235-.21.25-.22.422-.23z" fill="#fff"></path><path d="M12.139 18.2a1.203 1.203 0 011.642.44l1.296 2.243a1.204 1.204 0 01-2.083 1.203l-1.296-2.243a1.203 1.203 0 01.44-1.644zM18.629 14.452a1.203 1.203 0 011.642.44l1.295 2.244a1.203 1.203 0 11-2.083 1.203l-1.295-2.243a1.203 1.203 0 01.44-1.644z" fill="#fff"></path><defs><radialGradient cx="0" cy="0" gradientTransform="matrix(-9.00009 -16 16 -9.00009 21 24.5)" gradientUnits="userSpaceOnUse" id="lobe-icons-code-buddy-_R_0_" r="1"><stop stop-color="#2EA99D"></stop><stop offset="1" stop-color="#6C4DFF"></stop></radialGradient></defs></svg>',
    'codebuddy-cn': '<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>CodeBuddy</title><path d="M18.821 0H5.18A5.179 5.179 0 000 5.179V18.82A5.179 5.179 0 005.179 24H18.82A5.179 5.179 0 0024 18.821V5.18A5.179 5.179 0 0018.821 0z" fill="url(#lobe-icons-code-buddy-_R_0_)"></path><path d="M18.777 1.647c.28-.02.536.114.972.51 1.018.926 2.437 2.828 3.318 4.452l.34.631.482.24.11.06v3.638a5.206 5.206 0 00-5.32-1.23c-.491.166-1.021.471-2.08 1.082l-6.09 3.516c-1.057.61-1.586.916-1.975 1.259a5.208 5.208 0 00-1.493 5.572c.165.49.471 1.02 1.082 2.08l.315.543h-3.26c-.685 0-1.34-.135-1.939-.377-.169-.956-.009-1.789.469-2.335.158-.18.164-.189.13-.493a11.846 11.846 0 01-.057-1.711l.02-.444-.667-1.18C2.1 15.622 1.445 14.078 1.192 12.9c-.133-.647-.125-.934.04-1.146.1-.128.427-.261.822-.334.994-.175 3.162-.017 5.575.41l.25.043.551-.487c.915-.81 1.522-1.264 2.641-1.962 1.167-.73 2.484-1.331 3.967-1.807l.476-.152.261-.688c.937-2.471 1.896-4.293 2.58-4.9.235-.21.25-.22.422-.23z" fill="#fff"></path><path d="M12.139 18.2a1.203 1.203 0 011.642.44l1.296 2.243a1.204 1.204 0 01-2.083 1.203l-1.296-2.243a1.203 1.203 0 01.44-1.644zM18.629 14.452a1.203 1.203 0 011.642.44l1.295 2.244a1.203 1.203 0 11-2.083 1.203l-1.295-2.243a1.203 1.203 0 01.44-1.644z" fill="#fff"></path><defs><radialGradient cx="0" cy="0" gradientTransform="matrix(-9.00009 -16 16 -9.00009 21 24.5)" gradientUnits="userSpaceOnUse" id="lobe-icons-code-buddy-_R_0_" r="1"><stop stop-color="#2EA99D"></stop><stop offset="1" stop-color="#6C4DFF"></stop></radialGradient></defs></svg>',
    'github-copilot': '<svg fill="currentColor" fill-rule="evenodd" height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Github</title><path d="M12 0c6.63 0 12 5.276 12 11.79-.001 5.067-3.29 9.567-8.175 11.187-.6.118-.825-.25-.825-.56 0-.398.015-1.665.015-3.242 0-1.105-.375-1.813-.81-2.181 2.67-.295 5.475-1.297 5.475-5.822 0-1.297-.465-2.344-1.23-3.169.12-.295.54-1.503-.12-3.125 0 0-1.005-.324-3.3 1.209a11.32 11.32 0 00-3-.398c-1.02 0-2.04.133-3 .398-2.295-1.518-3.3-1.209-3.3-1.209-.66 1.622-.24 2.83-.12 3.125-.765.825-1.23 1.887-1.23 3.169 0 4.51 2.79 5.527 5.46 5.822-.345.294-.66.81-.765 1.577-.69.31-2.415.81-3.495-.973-.225-.354-.9-1.223-1.845-1.209-1.005.015-.405.56.015.781.51.28 1.095 1.327 1.23 1.666.24.663 1.02 1.93 4.035 1.385 0 .988.015 1.916.015 2.196 0 .31-.225.664-.825.56C3.303 21.374-.003 16.867 0 11.791 0 5.276 5.37 0 12 0z"></path></svg>',
    'mimocode': '<svg fill="currentColor" fill-rule="evenodd" height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>XiaomiMiMo</title><path d="M.958 15.936a.459.459 0 01.459.44v2.729a.46.46 0 01-.918 0v-2.729a.459.459 0 01.459-.44zm4.814-2.035a.46.46 0 01.553.45v4.754a.458.458 0 11-.918 0V15.48L3.74 17.202a.462.462 0 01-.655.016.462.462 0 01-.065-.082L.628 14.67a.459.459 0 01.658-.637l2.124 2.187 2.127-2.188a.46.46 0 01.235-.13zm2.068.004a.46.46 0 01.458.445v4.755a.46.46 0 01-.458.458.459.459 0 01-.458-.458V14.35a.459.459 0 01.458-.445zm1.973 2.014a.46.46 0 01.46.457v2.729a.46.46 0 01-.784.324.46.46 0 01-.134-.324v-2.729a.46.46 0 01.458-.458zm.002-2.045a.458.458 0 01.328.157l2.127 2.19 2.125-2.19a.459.459 0 01.784.318v4.756a.46.46 0 01-.455.458.46.46 0 01-.458-.458V15.48l-1.667 1.723a.46.46 0 01-.65.008l-.005-.005c0-.002-.002-.002-.004-.003l-2.455-2.534a.46.46 0 01-.008-.667.461.461 0 01.338-.128zm6.797 1.206a.46.46 0 01.53.651A1.966 1.966 0 0019.81 18.4a.462.462 0 01.623.18.46.46 0 01-.181.624 2.863 2.863 0 01-1.38.353l-.142-.004a2.88 2.88 0 01-2.393-4.263.461.461 0 01.274-.21zm.864-.931a2.884 2.884 0 013.915 3.914.46.46 0 01-.402.24l-.057-.004a.458.458 0 01-.164-.055.46.46 0 01-.182-.622 1.967 1.967 0 00-2.669-2.67.459.459 0 11-.441-.803zM9.59 6.368c1.481 0 1.696 1.202 1.696 1.654v2.648h-.917v-.432c-.26.346-.792.535-1.36.535-.133 0-1.289-.03-1.384-1.136-.082-.932.675-1.61 2.053-1.61h.691c0-.563-.367-.886-.983-.886-.44.013-.864.174-1.2.458l-.36-.664c.484-.379 1.012-.567 1.764-.567zm4.427.1c1.263 0 2.082.97 2.083 2.15 0 1.181-.824 2.154-2.083 2.154-1.26 0-2.084-.972-2.084-2.152 0-1.18.82-2.153 2.084-2.153zm6.801.015c.68 0 1.202.465 1.197 1.548v2.642H21.1V8.29c0-.312-.002-.98-.63-.98s-.628.667-.628.838v2.524h-.89V8.148c0-.17-.001-.838-.63-.838-.628 0-.628.668-.628.98v2.383h-.917v-4.03h.917V7a1.22 1.22 0 01.947-.516c.398 0 .76.193.982.686a1.321 1.321 0 011.195-.686zm-18.093.872l1.457-1.772H5.32L3.311 8.07l2.14 2.602H4.24L2.725 8.796 1.21 10.672H0L2.138 8.07.13 5.583h1.138l1.458 1.772zm4.149 3.317h-.916V6.644h.916v4.028zm16.99 0h-.916V6.644h.916v4.028zM9.925 8.71c-1.055 0-1.359.412-1.326.742.032.329.324.537.757.537a1.013 1.013 0 001.014-.968l.002-.31h-.447zM14.018 7.3c-.663 0-1.184.487-1.184 1.32 0 .832.52 1.32 1.184 1.32.662 0 1.182-.49 1.182-1.32 0-.832-.52-1.32-1.182-1.32zM6.417 5.001a.568.568 0 01.587.582.588.588 0 01-1.175 0A.57.57 0 016.417 5zm16.991 0a.57.57 0 01.592.582.588.588 0 01-1.174 0 .57.57 0 01.357-.542.572.572 0 01.225-.04z"></path></svg>',
    'minimaxcode': '<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Minimax</title><defs><linearGradient id="lobe-icons-minimax-_R_0_" x1="0%" x2="100.182%" y1="50.057%" y2="50.057%"><stop offset="0%" stop-color="#E2167E"></stop><stop offset="100%" stop-color="#FE603C"></stop></linearGradient></defs><path d="M16.278 2c1.156 0 2.093.927 2.093 2.07v12.501a.74.74 0 00.744.709.74.74 0 00.743-.709V9.099a2.06 2.06 0 012.071-2.049A2.06 2.06 0 0124 9.1v6.561a.649.649 0 01-.652.645.649.649 0 01-.653-.645V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v7.472a2.037 2.037 0 01-2.048 2.026 2.037 2.037 0 01-2.048-2.026v-12.5a.785.785 0 00-.788-.753.785.785 0 00-.789.752l-.001 15.904A2.037 2.037 0 0113.441 22a2.037 2.037 0 01-2.048-2.026V18.04c0-.356.292-.645.652-.645.36 0 .652.289.652.645v1.934c0 .263.142.506.372.638.23.131.514.131.744 0a.734.734 0 00.372-.638V4.07c0-1.143.937-2.07 2.093-2.07zm-5.674 0c1.156 0 2.093.927 2.093 2.07v11.523a.648.648 0 01-.652.645.648.648 0 01-.652-.645V4.07a.785.785 0 00-.789-.78.785.785 0 00-.789.78v14.013a2.06 2.06 0 01-2.07 2.048 2.06 2.06 0 01-2.071-2.048V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v3.8a2.06 2.06 0 01-2.071 2.049A2.06 2.06 0 010 12.9v-1.378c0-.357.292-.646.652-.646.36 0 .653.29.653.646V12.9c0 .418.343.757.766.757s.766-.339.766-.757V9.099a2.06 2.06 0 012.07-2.048 2.06 2.06 0 012.071 2.048v8.984c0 .419.343.758.767.758.423 0 .766-.339.766-.758V4.07c0-1.143.937-2.07 2.093-2.07z" fill="#E2167E" fill-rule="nonzero"></path></svg>',
    'traecode': '<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>TRAE</title><path d="M24 20.541H3.428v-3.426H0V3.4h24V20.54zM3.428 17.115h17.144V6.827H3.428v10.288zm8.573-5.196l-2.425 2.424-2.424-2.424 2.424-2.424 2.425 2.424zm6.857-.001l-2.424 2.423-2.425-2.423 2.425-2.425 2.424 2.425z" fill="#32F08C"></path></svg>',
    'zcode': '<svg fill="currentColor" fill-rule="evenodd" height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Z.ai</title><path d="M12.105 2L9.927 4.953H.653L2.83 2h9.276zM23.254 19.048L21.078 22h-9.242l2.174-2.952h9.244zM24 2L9.264 22H0L14.736 2H24z"></path></svg>',
    'opencode': '<svg fill="currentColor" fill-rule="evenodd" height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>opencode</title><path d="M16 6H8v12h8V6zm4 16H4V2h16v20z"></path></svg>',
    'cline': '<svg fill="currentColor" fill-rule="evenodd" height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Cline</title><path d="M17.035 3.991c2.75 0 4.98 2.24 4.98 5.003v1.667l1.45 2.896a1.01 1.01 0 01-.002.909l-1.448 2.864v1.668c0 2.762-2.23 5.002-4.98 5.002H7.074c-2.751 0-4.98-2.24-4.98-5.002V17.33l-1.48-2.855a1.01 1.01 0 01-.003-.927l1.482-2.887V8.994c0-2.763 2.23-5.003 4.98-5.003h9.962zM8.265 9.6a2.274 2.274 0 00-2.274 2.274v4.042a2.274 2.274 0 004.547 0v-4.042A2.274 2.274 0 008.265 9.6zm7.326 0a2.274 2.274 0 00-2.274 2.274v4.042a2.274 2.274 0 104.548 0v-4.042A2.274 2.274 0 0015.59 9.6z"></path><path d="M12.054 5.558a2.779 2.779 0 100-5.558 2.779 2.779 0 000 5.558z"></path></svg>',
    'qoder': QODER_BRAND_ICON,
    'qoder-cn': QODER_BRAND_ICON
  };

  function applyAvatar(container, agent) {
    if (!container || !agent) return;
    container.textContent = '';
    container.setAttribute('data-agent', agent);
    var vis = getAgentVisual(agent);
    container.style.background = vis.bg;
    var avData = (chat.avatars && chat.avatars[agent]) ? chat.avatars[agent] : null;
    if (avData && avData.img) {
      var img = document.createElement('img');
      img.className = 'avatar-img';
      img.src = avData.img;
      img.alt = agent;
      container.appendChild(img);
    } else if (avData && avData.emoji) {
      container.textContent = avData.emoji;
    } else if (BRAND_ICONS[agent]) {
      container.style.background = '';
      // 同一图标会在页面出现多次(侧栏+卡片), id/引用必须逐实例唯一,
      // 否则重复 mask/gradient 定义会让渲染互相干扰(空头像/方块)
      var uid = 'av' + (applyAvatar.seq = (applyAvatar.seq || 0) + 1);
      var iconSvg = String(BRAND_ICONS[agent])
        .replace(/id="([^"]+)"/g, 'id="$1-' + uid + '"')
        .replace(/url\(#([^)]+)\)/g, 'url(#$1-' + uid + ')')
        .replace(/href="#([^"]+)"/g, 'href="#$1-' + uid + '"');
      container.innerHTML = iconSvg;
      var svgEl = container.querySelector('svg');
      if (svgEl) svgEl.setAttribute('class', 'avatar-brand-svg');
      container.style.color = '';
    } else {
      container.textContent = vis.code;
    }
  }

  // 签到卡头像复用平台卡头像：品牌 logo / 用户自定义上传图 / 首字母兜底，三者同一套渲染
  function syncCheckinAvatars() {
    Array.prototype.forEach.call(
      document.querySelectorAll('.checkin-brand-icon[data-checkin-agent]'),
      function (el) {
        applyAvatar(el, el.getAttribute('data-checkin-agent'));
        el.style.width = '34px';
        el.style.height = '34px';
      }
    );
  }

  function loadAvatars() {
    return api('/api/avatars').then(function (res) {
      chat.avatars = res || {};
      renderPlatformList();
      renderThreadView();
      if (state.snap) renderAgents(state.snap);
      syncCheckinAvatars();
      return res;
    }).catch(function () {
      syncCheckinAvatars();
      return null;
    });
  }

  function promptChangeAvatar(agentName) {
    if (!agentName) return;
    var curAv = (chat.avatars && chat.avatars[agentName]) || {};
    openModal('更换头像 · ' + agentName, [
      { name: 'emoji', label: '自定义图标（如文字缩写，留空默认）', value: curAv.emoji || '' },
      { name: 'img', label: '图片 URL（/uploads/... 或 https://...，留空忽略）', value: curAv.img || '' }
    ], '保存', {
      label: '恢复默认',
      action: function () {
        api('/api/avatars', { agent: agentName, emoji: '', img: '' }).then(function (res) {
          chat.avatars = res || {};
          renderPlatformList();
          renderThreadView();
          if (state.snap) renderAgents(state.snap);
          toast('已恢复默认头像');
          closeModal(null);
        }).catch(function (e) {
          toast((e && e.message) || '恢复默认失败', true);
        });
      }
    }).then(function (vals) {
      if (!vals) return;
      api('/api/avatars', { agent: agentName, emoji: vals.emoji || '', img: vals.img || '' }).then(function (res) {
        chat.avatars = res || {};
        renderPlatformList();
        renderThreadView();
        if (state.snap) renderAgents(state.snap);
        toast('头像已更新');
      }).catch(function (e) {
        toast((e && e.message) || '设置头像失败', true);
      });
    });
  }

  var chat = {
    threads: [],
    full: {},
    avatars: {},
    activeAgent: null,
    activeSessionId: null,
    sessions: [],
    platformFilter: '',
    sending: false,
    firstLoad: true,
    since: 0,
    usage: null,
    usageLoaded: false,
    view: 'thread',
    _threadReqSeq: 0,
    atts: []
  };

  function findThread(agentName) {
    return chat.threads.find(function (t) { return t.agent === agentName; });
  }

  // ---- 子代理卡片拖动排序：本地顺序记忆 ----
  var AGENT_ORDER_KEY = 'agent_hub_agent_order';
  var agentOrderCache = (function () {
    try {
      var arr = JSON.parse(localStorage.getItem(AGENT_ORDER_KEY) || '[]');
      return Array.isArray(arr) ? arr.filter(function (x) { return typeof x === 'string' && x; }) : [];
    } catch (e) { return []; }
  })();
  var dragAgentName = null;
  var suppressAgentClickUntil = 0;
  function saveAgentOrder(names) {
    agentOrderCache = (names || []).slice();
    try { localStorage.setItem(AGENT_ORDER_KEY, JSON.stringify(agentOrderCache)); } catch (e) { /* noop */ }
  }
  function applyAgentOrder(list) {
    if (!agentOrderCache.length) return list;
    var rank = {};
    agentOrderCache.forEach(function (n, i) { rank[n] = i; });
    return list.slice().sort(function (a, b) {
      var ra = rank[a.name], rb = rank[b.name];
      if (ra === undefined && rb === undefined) return 0;
      if (ra === undefined) return 1;   // 没排过的排后面，保持原有相对顺序
      if (rb === undefined) return -1;
      return ra - rb;
    });
  }
  function clearAgentDropMarks() {
    var host = $('#thread-list');
    if (!host) return;
    Array.prototype.forEach.call(host.querySelectorAll('.drop-before, .drop-after'), function (n) {
      n.classList.remove('drop-before', 'drop-after');
    });
  }

  function getPlatformList() {
    var set = {};
    var list = [];
    if (state.snap && Array.isArray(state.snap.agents)) {
      state.snap.agents.forEach(function (a) {
        if (!a.dispatchable || a.name === SELF) return;
        set[a.name] = true;
        list.push(a);
      });
    }
    chat.threads.forEach(function (t) {
      if (t.agent === SELF || set[t.agent]) return;
      var snapAgent = state.snap && state.snap.agents && state.snap.agents.find(function (a) { return a.name === t.agent; });
      if (snapAgent && snapAgent.disabled) return;
      set[t.agent] = true;
      list.push({ name: t.agent, activation: 'standby', dispatchable: true });
    });
    return applyAgentOrder(list);
  }

  function threadMeta(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  // ---- 会话置顶与排序/筛选状态（localStorage 记忆） ----
  var chatSessSortMode = localStorage.getItem('agent_hub_sess_sort') || 'updated'; // 'updated' | 'created'
  var chatSessFilter = localStorage.getItem('agent_hub_sess_filter') || 'all';     // 'all' | 'active'(仅有消息)
  var chatAutoCollapse = localStorage.getItem('agent_hub_auto_collapse') !== 'false'; // 默认进入会话自动收起
  function getPinnedSessions(agent) {
    try {
      var all = JSON.parse(localStorage.getItem('agent_hub_pinned_sessions') || '{}');
      return Array.isArray(all[agent]) ? all[agent] : [];
    } catch (e) { return []; }
  }
  function togglePinSession(agent, sid) {
    var all = {};
    try { all = JSON.parse(localStorage.getItem('agent_hub_pinned_sessions') || '{}'); } catch (e) { all = {}; }
    var arr = Array.isArray(all[agent]) ? all[agent] : [];
    if (arr.indexOf(sid) >= 0) arr = arr.filter(function (x) { return x !== sid; });
    else arr.unshift(sid);
    all[agent] = arr;
    try { localStorage.setItem('agent_hub_pinned_sessions', JSON.stringify(all)); } catch (e) {}
  }

  function renderPlatformList() {
    var host = $('#thread-list');
    if (!host) return;
    host.textContent = '';
    var list = getPlatformList();
    var kw = (chat.platformFilter || '').trim().toLowerCase();
    if (kw) {
      list = list.filter(function (a) {
        if (a.name.toLowerCase().indexOf(kw) >= 0) return true;
        var t = chat.threads.find(function (x) { return x.agent === a.name; });
        if (t && t.last && String(t.last.text || '').toLowerCase().indexOf(kw) >= 0) return true;
        if (t && Array.isArray(t.sessions) && t.sessions.some(function (s) { return String(s.title || '').toLowerCase().indexOf(kw) >= 0; })) {
          if (!chat.expandedAgents) chat.expandedAgents = {};
          chat.expandedAgents[a.name] = true;
          return true;
        }
        return false;
      });
    }
    if (!list.length) {
      host.appendChild(el('div', 'empty', kw ? '无匹配平台' : '暂无可派发子代理'));
      return;
    }
    list.forEach(function (agent) {
      var name = agent.name;
      var t = chat.threads.find(function (x) { return x.agent === name; });
      var vis = getAgentVisual(name);
      var theme = (typeof AGENT_THEMES !== 'undefined' && AGENT_THEMES[name]) || { color: '#8ab4f8', glow: 'rgba(138, 180, 248, 0.25)', label: name };
      var isActive = (chat.activeAgent === name);
      var group = el('div', 'platform-group');
      group.setAttribute('data-agent', name);
      var item = el('div', 'platform-item' + (isActive ? ' active' : ''));
      item.setAttribute('data-agent', name);

      // 1. 左侧垂直微型栈：上图标，下 App 微标
      var stack = el('div', 'platform-avatar-stack');
      var av = el('div', 'platform-avatar');
      av.style.background = vis.bg;
      av.textContent = vis.code;
      applyAvatar(av, name);
      stack.appendChild(av);

      var appLabel = el('span', 'platform-app-label', theme.label || name);
      appLabel.title = name;
      stack.appendChild(appLabel);
      item.appendChild(stack);

      // 2. 右侧高价值信息胶囊区
      var capsuleBody = el('div', 'platform-capsule-body');
      
      // 顶行：左侧彩色微胶囊（额度、Cache、会话数），右侧时间戳
      var topRow = el('div', 'platform-capsule-top');
      var badges = el('div', 'platform-capsule-badges');

      // 注：额度胶囊与缓存时效胶囊已按用户要求移除（getAgentQuotaCapsule / getAgentCacheCapsule 定义保留备用）
      // 会话数胶囊：徽标区现有唯一元素，空间充足，不会再被 overflow 裁切
      var sessions = (t && Array.isArray(t.sessions) && t.sessions.length) ? t.sessions : (isActive && chat.sessions && chat.sessions.length ? chat.sessions : []);
      if (sessions.length > 1) {
        var sPill = el('span', 'pill-sess-count', sessions.length + '会话');
        badges.appendChild(sPill);
      }
      if (t && (t.unread || t.totalUnread)) {
        var badgePill = el('span', 'platform-badge-pill', t.unread || t.totalUnread);
        badges.appendChild(badgePill);
      }
      topRow.appendChild(badges);

      if (t && t.updated) {
        topRow.appendChild(el('span', 'platform-capsule-time', threadMeta(t.updated)));
      }
      capsuleBody.appendChild(topRow);

      // 底行：智能微总结 / 最后消息（无真实内容时整行不渲染，卡片保持单行）
      var summaryText = (agentSmartSummaries && agentSmartSummaries[name]) || '';
      if (!summaryText && t && t.last) {
        summaryText = (t.last.role === 'me' ? '我: ' : (t.last.role === 'sys' ? '[系统] ' : '')) + String(t.last.text || '').replace(/\s+/g, ' ');
      }
      if (summaryText) {
        mountAgentSummaryRow(capsuleBody, theme, summaryText);
      }

      item.appendChild(capsuleBody);

      // 折叠/展开指示器
      var isExpanded = chat.expandedAgents ? !!chat.expandedAgents[name] : (isActive);
      var chevron = el('span', 'platform-chevron' + (isExpanded ? ' expanded' : ''), '▶');
      chevron.title = isExpanded ? '收起会话列表' : '展开会话列表';
      item.appendChild(chevron);
      group.appendChild(item);

      // 会话子树（完整支持收起与展开的贝塞尔平滑过渡动画）
      var tree = null;
      if (sessions.length) {
        // 置顶会话排在当前 agent 顶部（本地记忆，pinned 优先）
        var pinnedArr = getPinnedSessions(name);
        var sortedSessions = sessions.slice().sort(function (a, b) {
          var pa = pinnedArr.indexOf(a.id), pb = pinnedArr.indexOf(b.id);
          if (pa !== -1 || pb !== -1) return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
          if (typeof chatSessSortMode !== 'undefined' && chatSessSortMode === 'created') return (b.created || 0) - (a.created || 0);
          return (b.updated || 0) - (a.updated || 0);
        });
        if (chatSessFilter === 'active') sortedSessions = sortedSessions.filter(function (s) { return (s.msgCount || 0) > 0; });
        tree = el('div', 'platform-session-tree' + (isExpanded ? ' expanded' : ' collapsed'));
        sortedSessions.slice(0, 8).forEach(function (s) {
          var isSessActive = isActive && (chat.activeSessionId === s.id);
          var isPinned = pinnedArr.indexOf(s.id) !== -1;
          var sItem = el('div', 'session-tree-item' + (isSessActive ? ' active' : ''));
          sItem.setAttribute('data-session-id', s.id);
          var titleEl = el('span', 'session-tree-title', s.title || '会话');
          sItem.appendChild(titleEl);

          var rightBox = el('div', 'session-tree-right');
          if (s.msgCount !== undefined) {
            rightBox.appendChild(el('span', 'session-tree-meta', s.msgCount + '条'));
          }
          // 置顶按钮（置顶到当前 agent 会话列表顶部）
          var pinBtn = el('span', 'session-pin-icon' + (isPinned ? ' pinned' : ''));
          pinBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="' + (isPinned ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3z"/></svg>';
          pinBtn.title = isPinned ? '取消置顶' : '置顶到当前平台顶部';
          pinBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            togglePinSession(name, s.id);
            renderPlatformList();
          });
          rightBox.appendChild(pinBtn);
          var archiveBtn = el('span', 'session-archive-icon');
          archiveBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect width="22" height="5" x="1" y="3"/><line x1="10" x2="14" y1="12" y2="12"/></svg>';
          archiveBtn.title = '归档此会话';
          archiveBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            // 不再二次确认：直接归档，底部气泡给 8 秒撤销窗口
            api('/api/chat/archive-session', { agent: name, sessionId: s.id }).then(function (r) {
              chat.sessions = r.sessions || [];
              chat.activeSessionId = r.activeSessionId;
              chat.full[name] = r.thread;
              loadThreads();
              showUndoBar('已归档「' + (s.title || '会话') + '」', function () {
                api('/api/chat/unarchive-session', { agent: name, sessionId: s.id }).then(function (res) {
                  chat.sessions = res.sessions || [];
                  chat.activeSessionId = res.activeSessionId;
                  chat.full[name] = res.thread;
                  loadThreads();
                  toast('已撤销归档');
                }).catch(function (err) { toast(err.message, true); });
              }, { duration: 8000 });
            }).catch(function (err) { toast(err.message, true); });
          });
          rightBox.appendChild(archiveBtn);
          sItem.appendChild(rightBox);

          sItem.addEventListener('click', function (e) {
            e.stopPropagation();
            chat.activeAgent = name;
            chat.activeSessionId = s.id;
            updatePlatformListActiveState(name, s.id);
            selectPlatform(name, s.id);
          });
          tree.appendChild(sItem);
        });

        // 快速新建会话按钮
        var newBtn = el('div', 'session-tree-new-btn');
        newBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg><span>新建会话</span>';
        newBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          api('/api/chat/new-session', { agent: name, title: '新会话' }).then(function (r) {
            chat.activeAgent = name;
            chat.full[name] = r.thread;
            chat.activeSessionId = r.activeSessionId;
            chat.sessions = r.sessions || [];
            if (!chat.expandedAgents) chat.expandedAgents = {};
            chat.expandedAgents[name] = true;
            loadThreads();
            toast('已开启新会话');
          }).catch(function (err) { toast(err.message, true); });
        });
        tree.appendChild(newBtn);
        group.appendChild(tree);
      }

      function toggleAgentSessions(doSelect) {
        if (!chat.expandedAgents) chat.expandedAgents = {};
        isExpanded = !isExpanded;
        chat.expandedAgents[name] = isExpanded;
        if (chevron) {
          chevron.classList.toggle('expanded', isExpanded);
          chevron.title = isExpanded ? '收起会话列表' : '展开会话列表';
        }
        if (tree) {
          if (isExpanded) {
            tree.classList.remove('collapsed');
            tree.classList.add('expanded');
          } else {
            tree.classList.remove('expanded');
            tree.classList.add('collapsed');
          }
        }
        if (doSelect) {
          if (chat.activeAgent !== name) {
            selectPlatform(name);
          } else {
            updatePlatformListActiveState(name, chat.activeSessionId);
          }
        }
      }

      chevron.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleAgentSessions(false);
      });

      // ---- 拖动排序：整卡可拖，落到目标卡片的上/下半区决定插入位置 ----
      item.draggable = true;
      item.title = (item.title ? item.title + ' · ' : '') + '按住可拖动调整子代理顺序';
      item.addEventListener('dragstart', function (e) {
        dragAgentName = name;
        item.classList.add('dragging');
        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', name); } catch (err) { /* noop */ }
      });
      item.addEventListener('dragend', function () {
        dragAgentName = null;
        item.classList.remove('dragging');
        clearAgentDropMarks();
      });
      item.addEventListener('dragover', function (e) {
        if (!dragAgentName || dragAgentName === name) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* noop */ }
        var r = item.getBoundingClientRect();
        var after = (e.clientY - r.top) > r.height / 2;
        clearAgentDropMarks();
        item.classList.add(after ? 'drop-after' : 'drop-before');
      });
      item.addEventListener('dragleave', function () {
        item.classList.remove('drop-before', 'drop-after');
      });
      item.addEventListener('drop', function (e) {
        if (!dragAgentName || dragAgentName === name) return;
        e.preventDefault();
        e.stopPropagation();
        var moved = dragAgentName;
        var names = getPlatformList().map(function (a) { return a.name; });
        var from = names.indexOf(moved);
        if (from < 0) return;
        var r = item.getBoundingClientRect();
        var after = (e.clientY - r.top) > r.height / 2;
        names.splice(from, 1);
        var to = names.indexOf(name);
        if (to < 0) return;
        names.splice(to + (after ? 1 : 0), 0, moved);
        saveAgentOrder(names);
        dragAgentName = null;
        suppressAgentClickUntil = Date.now() + 400;
        clearAgentDropMarks();
        renderPlatformList();
        toast('已调整子代理顺序');
      });

      item.addEventListener('click', function () {
        if (Date.now() < suppressAgentClickUntil) return;
        toggleAgentSessions(true);
      });

      host.appendChild(group);
    });

    var total = chat.threads.reduce(function (s, t) { return s + (t.unread || t.totalUnread || 0); }, 0);
    var badge = $('#chat-badge');
    if (badge) {
      badge.textContent = total > 99 ? '99+' : (total || '');
      badge.className = 'chat-badge' + (total ? ' show' : '');
    }
  }

  function renderSessionList() {
    // 兼容向后调用的空实现
  }

  // 就地更新平台列表与会话的高亮状态，不重构 DOM 从而保留收起/展开的平滑过渡动画
  function updatePlatformListActiveState(activeAgent, activeSessionId) {
    var host = $('#thread-list');
    if (!host) return false;
    var groups = host.querySelectorAll('.platform-group');
    if (!groups || !groups.length) return false;
    groups.forEach(function (group) {
      var pName = group.getAttribute('data-agent');
      var pItem = group.querySelector('.platform-item');
      var isAgActive = (pName === activeAgent);
      if (pItem) pItem.classList.toggle('active', isAgActive);
      var tree = group.querySelector('.platform-session-tree');
      if (tree) {
        tree.querySelectorAll('.session-tree-item').forEach(function (sItem) {
          var sId = sItem.getAttribute('data-session-id');
          sItem.classList.toggle('active', isAgActive && sId === activeSessionId);
        });
      }
    });
    return true;
  }

  function selectPlatform(name, targetSessionId) {
    if (!name) return Promise.resolve();
    chat.activeAgent = name;
    // 切换子代理时立即刷新主题色贯通（发送按钮 / 模型胶囊 / 状态栏模型名 / 上下文进度条）
    applyAgentAccent(name);
    var sel = $('#chat-target');
    if (sel && sel.value !== name && sel.querySelector('option[value="' + name + '"]')) {
      sel.value = name;
      syncComposer();
    } else {
      populateChatModels();
    }
    if (window.innerWidth < 860 || chatAutoCollapse) {
      var sb = $('#chat-threads');
      if (sb) sb.classList.add('collapsed');
    }
    if (!updatePlatformListActiveState(name, targetSessionId)) {
      renderPlatformList();
    }

    var seq = ++chat._threadReqSeq;
    var url = '/api/chat/thread?agent=' + encodeURIComponent(name);
    if (targetSessionId) url += '&session=' + encodeURIComponent(targetSessionId);
    return api(url).then(function (r) {
      if (seq !== chat._threadReqSeq) return;
      chat.full[name] = r.thread;
      chat.activeSessionId = r.activeSessionId || (r.thread ? r.thread.id : null);
      chat.sessions = r.sessions || [];
      renderSessionList();
      updatePlatformListActiveState(name, chat.activeSessionId);
      var t = chat.threads.find(function (x) { return x.agent === name; });
      if (t && (t.unread || t.totalUnread)) {
        // 修复老 bug：打开 agent 时按整 agent 标读（服务端清空其全部会话的未读），
        // 否则旧会话攒下的未读永远清不掉，每次刷新红点都会出现
        api('/api/chat/read', { agent: name }).then(function () {
          t.unread = 0; t.totalUnread = 0;
          renderPlatformList();
        }).catch(function () {});
      }
      renderThreadView();
    }).catch(function (e) {
      if (seq !== chat._threadReqSeq) return;
      toast(e.message, true);
    });
  }

  function loadThreads() {
    return api('/api/chat/list').then(function (r) {
      chat.threads = (r.threads || []).slice().sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
      if (!chat.activeAgent) {
        var defaultList = getPlatformList();
        if (defaultList.length) {
          var firstActive = chat.threads.find(function (t) { return t.msgCount > 0; }) || defaultList[0];
          chat.activeAgent = firstActive.name || firstActive.agent;
        }
      }
      renderPlatformList();
      renderSessionList();
      if (chat.activeAgent) {
        if (!chat.full[chat.activeAgent]) {
          selectPlatform(chat.activeAgent);
        } else {
          renderThreadView();
        }
      }
    }).catch(function () {});
  }

  function pollUpdates() {
    if (document.hidden) return Promise.resolve();
    return api('/api/chat/updates?since=' + chat.since).then(function (r) {
      chat.since = r.now;
      var touchedActive = false;
      (r.changed || []).forEach(function (c) {
        var t = chat.threads.find(function (x) { return x.agent === c.agent; });
        if (t) { Object.assign(t, c); }
        else { chat.threads.push(Object.assign({ last: null, msgCount: 0 }, c)); }
        if (c.agent === chat.activeAgent) touchedActive = true;
      });
      if (r.changed && r.changed.length) {
        chat.threads.sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
        renderPlatformList();
        if (touchedActive && chat.activeAgent) {
          var seq = ++chat._threadReqSeq;
          api('/api/chat/thread?agent=' + encodeURIComponent(chat.activeAgent) + (chat.activeSessionId ? '&session=' + encodeURIComponent(chat.activeSessionId) : '')).then(function (rr) {
            if (seq !== chat._threadReqSeq) return;
            if (rr.thread) {
              chat.full[chat.activeAgent] = rr.thread;
              chat.activeSessionId = rr.activeSessionId || rr.thread.id;
              chat.sessions = rr.sessions || [];
              renderSessionList();
              renderThreadView();
            }
          });
        }
      }
    }).catch(function () {});
  }

  var showSysMsgs = false;
  function stripExitSuffix(s) {
    if (!s) return '';
    return String(s).replace(/(?:\r?\n)*\(exit=\d+\)\s*$/g, '');
  }

  function renderThreadView() {
    var host = $('#chat-msgs');
    if (!host) return;
    renderSessionList();
    var agentName = chat.activeAgent;
    if (!agentName) {
      var list = getPlatformList();
      if (list.length) { selectPlatform(list[0].name); }
      return;
    }
    var vis = getAgentVisual(agentName);
    var t = chat.full[agentName];

    var avEl = $('#current-avatar-sm');
    if (avEl) { avEl.style.background = vis.bg; avEl.textContent = vis.code; applyAvatar(avEl, agentName); }
    var nmEl = $('#current-agent-name');
    if (nmEl) nmEl.textContent = agentName;

    // 历史会话下拉
    var sessSelect = $('#chat-session-select');
    if (sessSelect) {
      sessSelect.textContent = '';
      var sessions = chat.sessions || [];
      if (!sessions.length && t) {
        sessions = [{ id: t.id, title: t.title || '当前对话', msgCount: (t.messages || []).length }];
      }
      sessions.forEach(function (s, idx) {
        var op = el('option', null, (s.title || ('对话 ' + (idx + 1))) + ' (' + (s.msgCount || 0) + '条)');
        op.value = s.id;
        if (s.id === chat.activeSessionId) op.selected = true;
        sessSelect.appendChild(op);
      });
      // 一体胶囊同步当前会话名
      var curSessNameEl = $('#current-session-name');
      if (curSessNameEl) {
        var curSess = sessions.find(function (s) { return s.id === chat.activeSessionId; });
        var nm = (curSess && curSess.title) || (t && t.title) || '新会话';
        curSessNameEl.textContent = nm;
        curSessNameEl.title = nm;
      }
    }

    var msgs = (t && Array.isArray(t.messages)) ? t.messages : [];
    var contextKey = agentName + ':' + (chat.activeSessionId || '');
    var isContextSwitch = (chat._lastRenderedContext !== contextKey);
    chat._lastRenderedContext = contextKey;
    var wasNearBottom = isContextSwitch || (host.scrollHeight - host.scrollTop - host.clientHeight < 160) || (host.scrollHeight <= host.clientHeight + 20);
    var prevScrollTop = host.scrollTop;

    if (isContextSwitch) {
      host.classList.remove('thread-fading');
      void host.offsetWidth;
      host.classList.add('thread-fading');
    }

    host.textContent = '';
    var displayMsgs = showSysMsgs ? msgs : msgs.filter(function (m) { return m && m.role !== 'sys'; });

    // 智能剔除已完结或无效 pending
    var pendingItems = (t && Array.isArray(t.pending)) ? t.pending.filter(function (p) {
      if (!p) return false;
      // 1. 如果消息列表中已存在与该 ref 匹配的回复或错误记录，则任务已完结
      if (p.ref && msgs.some(function (m) { return m && m.ref && m.ref === p.ref; })) return false;
      if (p.taskId && msgs.some(function (m) { return m && m.text && m.text.indexOf(p.taskId) !== -1; })) return false;
      // 2. 超时守卫: 任务派发超过 10 分钟且消息列表已有 agent 回复，说明已归档
      var pTime = p.dispatchTime || p.posted || p.firstSeen || 0;
      if (pTime && (Date.now() - pTime > 10 * 60 * 1000)) return false;
      return true;
    }) : [];

    // 对话轮次完结守卫:
    // 如果最后一条回答是 agent 回复/任务完成/失败报错，且该回复之后没有新的用户输入，
    // 则说明当前对话轮次已经结束，绝不展示任何孤立/幽灵执行中提示
    var lastUserMsg = null;
    var lastAgentMsg = null;
    for (var mi = msgs.length - 1; mi >= 0; mi--) {
      var mm = msgs[mi];
      if (!mm) continue;
      if (!lastAgentMsg && (mm.role === 'agent' || mm.failed || (mm.text && mm.text.indexOf('任务未完成') !== -1))) {
        lastAgentMsg = mm;
      }
      if (!lastUserMsg && mm.role === 'me') {
        lastUserMsg = mm;
      }
      if (lastUserMsg && lastAgentMsg) break;
    }

    if (lastAgentMsg && (!lastUserMsg || (lastAgentMsg.ts || 0) >= (lastUserMsg.ts || 0))) {
      var hasNewerPending = pendingItems.some(function (p) {
        var pTime = p.dispatchTime || p.posted || p.firstSeen || 0;
        return pTime > (lastAgentMsg.ts || 0);
      });
      if (!hasNewerPending) {
        pendingItems = [];
      }
    }

    if (t) t.pending = pendingItems;
    var pendingCount = pendingItems.length;

    if (!displayMsgs.length && !pendingCount) {
      var emptyBox = el('div', 'chat-empty-state');
      var bigAv = el('div', 'empty-avatar');
      bigAv.style.background = vis.bg;
      bigAv.textContent = vis.code;
      bigAv.title = '点击更换头像（影响全局）';
      applyAvatar(bigAv, agentName);
      bigAv.addEventListener('click', function () {
        promptChangeAvatar(agentName);
      });
      emptyBox.appendChild(bigAv);

      var hour = new Date().getHours();
      var timeQuotes = {
        dawn: [
          '早上好，新的一天交给我吧',
          '早安！迎着晨光，今天我们一起高效推进',
          '早上好，喝杯温水，今天的大活交给我帮您梳理',
          '早安！电量已满格，今天有什么想法随时交待',
          '新的一天开始啦，代码和任务我都已准备就绪'
        ],
        morning: [
          '上午好，今天有什么任务交给我？',
          '上午好！专注力正值黄金期，复杂的逻辑放马过来',
          '上午好，今天需要编写或重构哪些模块？',
          '状态正佳，有需要查证、调试或编写的尽管派活',
          '灵感满满的上午，让我们把重要的需求先拿下'
        ],
        noon: [
          '中午好，先休息一下，我随时待命',
          '中午好！吃顿好的补充能量，任务先放着我看着',
          '午休时间到了，好好小憩一下，醒来再战',
          '中午好，劳逸结合效率更高，下午需要我随时叫我',
          '午间时光，喝杯咖啡歇歇眼睛，中枢一直在守护'
        ],
        afternoon: [
          '下午好，喝杯水，复杂的任务交给我',
          '下午茶时间！伸个懒腰，最硬的骨头我来啃',
          '下午好，感到疲倦就休息片刻，剩下的繁琐活我搞定',
          '下午好，思路卡壳了？让我来提供几个解题视角',
          '下午好，保持好节奏，今天的目标马上就能达成'
        ],
        dusk: [
          '快收工了，剩下的我帮你收尾',
          '傍晚好，今天进度很棒，剩下的边角料我来清理',
          '快到下班时间啦，整理好的工作交给我打包归档',
          '落日很美，辛苦一整天，最后的收尾工作我承包了',
          '暮色温柔，剩下的测试和验证放着让我跑'
        ],
        evening: [
          '晚上好，今天辛苦了，还有活就交给我',
          '晚间好！有夜间需要跑的长任务尽管交给我挂机',
          '晚上好，一天忙碌辛苦啦，有收尾代码交给我来写',
          '晚上的时光静谧高效，想攻克什么难题我陪你',
          '晚上好，累了就早点放松，琐碎的任务随时派给我'
        ],
        night: [
          '夜深了，注意休息，剩下的我来搞定',
          '夜深人静，赶工辛苦啦，别熬太晚，我来顶着',
          '夜深了，早点睡个好觉，任务交给我通宵跑完',
          '深夜的星星亮了，身体最重要，剩下的交给我吧',
          '夜深了，随时派发挂机任务，明天醒来直接看结果'
        ]
      };

      var quotePool = timeQuotes.evening;
      if (hour >= 5 && hour < 9) quotePool = timeQuotes.dawn;
      else if (hour >= 9 && hour < 12) quotePool = timeQuotes.morning;
      else if (hour >= 12 && hour < 14) quotePool = timeQuotes.noon;
      else if (hour >= 14 && hour < 17) quotePool = timeQuotes.afternoon;
      else if (hour >= 17 && hour < 20) quotePool = timeQuotes.dusk;
      else if (hour >= 20 && hour < 23) quotePool = timeQuotes.evening;
      else quotePool = timeQuotes.night;

      var timeGreeting = quotePool[Math.floor(Math.random() * quotePool.length)] || '随时在线，剩下的交给我';

      var slogan = el('div', 'empty-slogan', timeGreeting);
      emptyBox.appendChild(slogan);

      var subHint = el('div', 'empty-sub-hint', '点击下方快捷指令快速起草，或在底部输入框直接派发任务（支持粘贴/拖拽图片与文件）');
      emptyBox.appendChild(subHint);

      var starters = [
        {
          title: '架构审查与重构建议',
          desc: '梳理当前模块边界、潜在耦合点并输出分步可落地的重构方案',
          prompt: '请帮我审查当前模块的代码结构，指出潜在的边界问题、耦合点并给出可落地的重构方案：'
        },
        {
          title: '疑难 Bug 根因排查',
          desc: '按「现象分析 → 假设收敛 → 最小复现 → 修复验证」定位异常',
          prompt: '我遇到了一个异常问题，请按「现象分析 → 假设收敛 → 最小复现 → 修复验证」帮我排查根因：'
        },
        {
          title: '编写高覆盖率测试',
          desc: '覆盖正常路径、边界输入与异常竞态，生成可直接运行的测试代码',
          prompt: '请针对以下核心逻辑设计边界测试用例（含正常路径、异常输入与并发边界），并编写测试代码：'
        },
        {
          title: '跨代理协同任务拆解',
          desc: '将复杂需求拆解为可并行派发的子任务清单与明确验收标准',
          prompt: '请将以下复杂需求拆解为可并行派发的子任务清单，明确每个步骤的输入、输出与验收标准：'
        }
      ];
      var starterGrid = el('div', 'empty-starter-grid');
      starters.forEach(function (st) {
        var card = el('div', 'empty-starter-card');
        var topRow = el('div', 'empty-starter-top');
        var titleSpan = el('span', 'empty-starter-title', st.title);
        var arrowSpan = el('span', 'empty-starter-arrow', '→');
        topRow.appendChild(titleSpan);
        topRow.appendChild(arrowSpan);
        card.appendChild(topRow);
        card.appendChild(el('div', 'empty-starter-desc', st.desc));
        card.addEventListener('click', function () {
          var inp = $('#chat-input');
          if (!inp) return;
          inp.value = st.prompt;
          inp.style.height = 'auto';
          inp.style.height = Math.min(inp.scrollHeight, 160) + 'px';
          inp.focus();
          try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) {}
        });
        starterGrid.appendChild(card);
      });
      emptyBox.appendChild(starterGrid);

      host.appendChild(emptyBox);
    } else {
      displayMsgs.forEach(function (msg) {
        host.appendChild(bubbleFor(agentName, msg));
      });
    }

    if (pendingCount) {
      var tp = el('div', 'typing');
      tp.appendChild(el('span', 'd')); tp.appendChild(el('span', 'd')); tp.appendChild(el('span', 'd'));
      tp.appendChild(el('span', null, ' ' + agentName + ' 执行中，结果会自动回到本对话…'));
      host.appendChild(tp);
    }
    if (wasNearBottom) {
      host.scrollTop = host.scrollHeight;
      requestAnimationFrame(function () {
        if (host) host.scrollTop = host.scrollHeight;
      });
      setTimeout(function () {
        if (host) host.scrollTop = host.scrollHeight;
      }, 50);
    } else {
      host.scrollTop = prevScrollTop;
    }
    var sbBtn = $('#btn-scroll-bottom');
    if (sbBtn) {
      sbBtn.hidden = wasNearBottom || (host.scrollHeight - host.scrollTop - host.clientHeight < 160);
    }
    updateStatusBar();
    renderWorkbench();
  }

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  // 代码块复制按钮图标（复制 / 已复制勾）
  var CODE_COPY_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  var CODE_CHECK_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  // ---- 会话文本里的本地文件路径：渲染为可双击打开工作台预览的 chip ----
  var FILE_PATH_RE = /((?:[A-Za-z]:[\\/]|\/)[^\s<>"'`|]+?\.[A-Za-z0-9]{1,8})/g;
  var FILE_PATH_EXT_RE = /\.(svg|png|jpe?g|gif|webp|bmp|ico|pdf|md|markdown|txt|json|html?|css|js|mjs|cjs|ts|tsx|jsx|py|sh|sql|ya?ml|toml|csv|log)$/i;
  function extractFilePaths(text) {
    var out = [], m, s = String(text || '');
    FILE_PATH_RE.lastIndex = 0;
    while ((m = FILE_PATH_RE.exec(s))) {
      var p = m[1].replace(/[.,;:!?，。；：、！？）】」》]+$/, '');
      if (p.length > 3 && FILE_PATH_EXT_RE.test(p)) out.push(p);
    }
    return out;
  }
  function linkifyPaths(root) {
    if (!root || !document.createTreeWalker) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (node) {
      var pe = node.parentElement;
      if (!pe) return;
      var tag = pe.tagName;
      if (tag === 'A' || tag === 'PRE' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || pe.classList.contains('path-chip')) return;
      var text = node.nodeValue || '';
      if (text.indexOf('/') < 0 && text.indexOf('\\') < 0) return;
      var paths = extractFilePaths(text);
      if (!paths.length) return;
      var frag = document.createDocumentFragment();
      var last = 0, hit = 0;
      paths.forEach(function (p) {
        var idx = text.indexOf(p, last);
        if (idx < 0) return;
        if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
        var chip = document.createElement('span');
        chip.className = 'path-chip';
        chip.setAttribute('data-path', p);
        chip.setAttribute('title', '双击打开工作台预览');
        chip.textContent = p;
        frag.appendChild(chip);
        last = idx + p.length;
        hit++;
      });
      if (!hit) return;
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });
  }
  function openPathPreview(path) {
    if (!path) return;
    var bn = String(path).split(/[\\/]/).pop();
    openWbPreview({ kind: 'file', name: bn, path: path, source: '会话产物' });
  }
  document.addEventListener('dblclick', function (e) {
    var chip = e.target && e.target.closest ? e.target.closest('.path-chip') : null;
    if (!chip) return;
    e.preventDefault();
    e.stopPropagation();
    openPathPreview(chip.getAttribute('data-path') || '');
  });

  function renderMd(text) {
    var out = [];
    var lines = String(text).split('\n');
    var inCode = false; var codeBuf = []; var codeLang = '';
    var inline = function (s) {
      return esc(s)
        .replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
        .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    };
    var flushCode = function () {
      var langLabel = esc(codeLang || 'code');
      out.push(
        '<div class="code-block-wrap">' +
          '<div class="code-block-head"><span>' + langLabel + '</span><button type="button" class="code-block-copy" title="复制代码" aria-label="复制代码">' + CODE_COPY_ICON + '</button></div>' +
          '<pre>' + esc(codeBuf.join('\n')) + '</pre>' +
        '</div>'
      );
      codeBuf = [];
      codeLang = '';
      inCode = false;
    };
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var trimmed = ln.trim();
      var fence = /^```([a-zA-Z0-9_+-]*)/.exec(trimmed);
      if (fence) {
        if (inCode) { flushCode(); }
        else { inCode = true; codeLang = fence[1] || 'code'; }
        continue;
      }
      if (inCode) { codeBuf.push(ln); continue; }
      if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) {
        out.push('<hr class="md-hr">');
        continue;
      }
      if (/^\|.*\|$/.test(trimmed)) {
        var tRows = [trimmed];
        var j = i + 1;
        while (j < lines.length) {
          var tNext = lines[j].trim();
          if (/^\|.*\|$/.test(tNext)) {
            tRows.push(tNext);
            j++;
          } else if (!tNext && j + 1 < lines.length && /^\|.*\|$/.test(lines[j + 1].trim())) {
            j++;
          } else {
            break;
          }
        }
        if (tRows.length >= 2 && /^[|\s:-]+$/.test(tRows[1])) {
          var parseCells = function (rowStr) {
            return rowStr.replace(/^\||\|$/g, '').split('|').map(function (c) { return inline(c.trim()); });
          };
          var headCells = parseCells(tRows[0]);
          var bodyHtml = '';
          for (var r = 2; r < tRows.length; r++) {
            if (/^[|\s:-]+$/.test(tRows[r])) continue;
            var cells = parseCells(tRows[r]);
            bodyHtml += '<tr>' + cells.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
          }
          out.push(
            '<div class="md-table-wrap"><table class="md-table">' +
              '<thead><tr>' + headCells.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead>' +
              '<tbody>' + bodyHtml + '</tbody>' +
            '</table></div>'
          );
          i = j - 1;
          continue;
        }
      }
      var hm = /^(#{1,4})\s+(.*)$/.exec(ln);
      if (hm) {
        var lvl = hm[1].length;
        out.push('<h' + lvl + ' class="md-h' + lvl + '">' + inline(hm[2]) + '</h' + lvl + '>');
        continue;
      }
      if (/^>\s?/.test(trimmed)) {
        out.push('<blockquote class="md-quote">' + inline(trimmed.replace(/^>\s?/, '')) + '</blockquote>');
        continue;
      }
      if (/^[-*]\s+/.test(ln)) {
        var items = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) { items.push('<li>' + inline(lines[i].replace(/^[-*]\s+/, '')) + '</li>'); i++; }
        i--;
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }
      if (/^\d+\.\s+/.test(ln)) {
        var olItems = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) { olItems.push('<li>' + inline(lines[i].replace(/^\d+\.\s+/, '')) + '</li>'); i++; }
        i--;
        out.push('<ol>' + olItems.join('') + '</ol>');
        continue;
      }
      if (!trimmed) continue;
      out.push('<p>' + inline(ln) + '</p>');
    }
    if (inCode) flushCode();
    return out.join('');
  }

  function bubbleFor(agentName, m) {
    var role = m.role === 'me' ? 'user' : (m.role === 'sys' ? 'system' : 'agent');
    var b = el('div', 'bubble ' + role + (role === 'agent' ? ' md' : ''));

    // 元信息存入 title 悬停查看，彻底删除气泡顶部的冗余行，实现极简现代对话流
    var metaTime = threadMeta(m.ts);
    var roleTitle = role === 'user' ? '我' : (role === 'system' ? '系统' : (agentName || '智能体'));
    b.title = roleTitle + (metaTime ? ' · ' + metaTime : '') + (m.tok && role !== 'agent' ? ' · ≈' + m.tok + ' tok' : '');

    // 仅系统消息保留轻量头部
    if (role === 'system') {
      var bh = el('div', 'bhead');
      bh.appendChild(el('span', null, '系统'));
      if (metaTime) bh.appendChild(el('span', null, metaTime));
      b.appendChild(bh);
    }

    var displayText = (role === 'agent') ? stripExitSuffix(m.text) : m.text;

  // ---------------- 思考过程提取与自动折叠
  function parseThinking(text, m) {
    var raw = String(text || '');
    var thinking = '';
    // 1. 优先提取对象的 reasoning 或 thought 字段
    if (m && typeof m.reasoning === 'string' && m.reasoning.trim()) {
      thinking = m.reasoning.trim();
    } else if (m && typeof m.thought === 'string' && m.thought.trim()) {
      thinking = m.thought.trim();
    }
    // 2. 检查文本中是否包含 <think>...</think> 或未闭合的 <think>
    if (!thinking) {
      var thinkMatch = /<think>([\s\S]*?)(?:<\/think>|$)/i.exec(raw);
      if (thinkMatch) {
        thinking = thinkMatch[1].trim();
        raw = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/i, '').trim();
      }
    }
    // 3. 检查开头是否有 ```thought 或 ```thinking 代码块
    if (!thinking) {
      var blockMatch = /^```(?:thought|thinking)\s*\n([\s\S]*?)\n```/i.exec(raw);
      if (blockMatch) {
        thinking = blockMatch[1].trim();
        raw = raw.replace(/^```(?:thought|thinking)\s*\n[\s\S]*?\n```\s*/i, '').trim();
      }
    }
    if (!thinking) {
      return { hasThinking: false, thinkingText: '', cleanText: raw };
    }
    return { hasThinking: true, thinkingText: thinking, cleanText: raw };
  }

    if (role === 'agent') {
      var parsed = parseThinking(displayText, m);
      if (parsed.hasThinking) {
        var thinkBox = el('div', 'thinking-box');
        var thinkBody = el('div', 'thinking-body');
        thinkBody.setAttribute('hidden', '');
        thinkBody.innerHTML = renderMd(parsed.thinkingText);

        var toggleBtn = btn('', 'thinking-toggle-btn', function () {
          var isHidden = thinkBody.hasAttribute('hidden');
          if (isHidden) {
            thinkBody.removeAttribute('hidden');
            toggleBtn.setAttribute('aria-expanded', 'true');
            arrow.textContent = '▴';
            lbl.textContent = '收起思考过程';
          } else {
            thinkBody.setAttribute('hidden', '');
            toggleBtn.setAttribute('aria-expanded', 'false');
            arrow.textContent = '▾';
            lbl.textContent = '思考过程';
          }
        });
        toggleBtn.setAttribute('aria-expanded', 'false');
        var icon = el('span', 'thinking-icon');
        icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
        var lbl = el('span', 'thinking-label', '思考过程');
        var arrow = el('span', 'thinking-arrow', '▾');
        toggleBtn.appendChild(icon);
        toggleBtn.appendChild(lbl);
        toggleBtn.appendChild(arrow);
        thinkBox.appendChild(toggleBtn);
        thinkBox.appendChild(thinkBody);
        b.appendChild(thinkBox);
      }
      var body = el('div');
      body.innerHTML = renderMd(parsed.hasThinking ? parsed.cleanText : displayText);
      linkifyPaths(body);
      b.appendChild(body);
      b.querySelectorAll('.code-block-copy').forEach(function (cBtn) {
        cBtn.addEventListener('click', function (e) {
          // 阻止冒泡/默认行为：避免被外层容器当作链接打开新标签页
          e.preventDefault();
          e.stopPropagation();
          var wrap = cBtn.closest('.code-block-wrap');
          var pre = wrap ? wrap.querySelector('pre') : null;
          if (!pre) return;
          copyText(pre.textContent || '', '代码已复制');
          cBtn.innerHTML = CODE_CHECK_ICON;
          setTimeout(function () { cBtn.innerHTML = CODE_COPY_ICON; }, 1600);
        });
      });
    } else {
      b.appendChild(el('div', null, m.text));
    }
    if (m.artifact) {
      var ab = btn('查看产物文件', 'text', function () { viewArtifact(m.artifact); });
      ab.style.marginTop = '6px';
      b.appendChild(ab);
    }
    if (m.att && m.att.length) {
      m.att.forEach(function (a) {
        if (a.isImage && a.url) {
          var im = el('img', 'att-img');
          im.src = a.url;
          im.alt = a.name || '图片附件';
          im.title = a.name || '';
          im.addEventListener('click', function () { openImageLightbox(a.url, a.name); });
          b.appendChild(im);
        } else {
          b.appendChild(el('span', 'att-file', (a.name || 'file')));
        }
      });
    }

    // 气泡底部独立复制图标按钮（agent 在左下角，用户在右下角）
    if (role !== 'system' && displayText) {
      var bfoot = el('div', 'bfoot');
      var copyIconBtn = el('button', 'bubble-copy-btn');
      copyIconBtn.type = 'button';
      copyIconBtn.title = '复制内容';
      var copyIconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
      var checkIconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
      copyIconBtn.innerHTML = copyIconSvg;
      copyIconBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        copyText(displayText, '已复制');
        copyIconBtn.innerHTML = checkIconSvg;
        setTimeout(function () { copyIconBtn.innerHTML = copyIconSvg; }, 1500);
      });
      bfoot.appendChild(copyIconBtn);
      b.appendChild(bfoot);
    }

    return b;
  }

  var wbState = {
    tab: 'all',
    previewItem: null
  };

  // ---- 工作台条目的“已清理”集合：只隐藏列表项，不动原文件 ----
  var WB_HIDDEN_KEY = 'agent_hub_wb_hidden';
  var wbHidden = new Set();
  try {
    var savedWbHidden = JSON.parse(localStorage.getItem(WB_HIDDEN_KEY) || '[]');
    if (Array.isArray(savedWbHidden)) savedWbHidden.forEach(function (k) { if (k) wbHidden.add(k); });
  } catch (e) { /* noop */ }
  function wbSaveHidden() {
    try { localStorage.setItem(WB_HIDDEN_KEY, JSON.stringify(Array.from(wbHidden))); } catch (e) { /* noop */ }
  }
  function wbHideKeys(keys) {
    var n = 0;
    (keys || []).forEach(function (k) {
      if (k && !wbHidden.has(k)) { wbHidden.add(k); n++; }
    });
    if (n) wbSaveHidden();
    return n;
  }
  // 单条移除：按条目自身 key 隐藏（同时兜底按路径/URL 匹配其余 key 形态）
  function wbRemoveItem(item) {
    if (!item) return;
    var keys = [];
    if (item.key) keys.push(item.key);
    if (item.path) keys.push('A|' + item.path, 'P|' + item.path, 'LA|' + item.path);
    if (item.url) keys.push(item.url + '|i', item.url + '|f');
    wbHideKeys(keys);
    if (wbState.previewItem === item) {
      wbState.previewItem = null;
      var pane = $('#wb-preview-pane');
      if (pane) pane.hidden = true;
    }
    renderWorkbench();
    toast('已从工作台移除（原文件未删除）');
  }
  // 卡片右上角的删除 ×（点击不触发卡片自身的打开/预览）
  function wbDelBtn(item) {
    var b = el('button', 'wb-item-del');
    b.type = 'button';
    b.title = '从工作台移除（不删除原文件）';
    b.setAttribute('aria-label', '从工作台移除');
    b.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      wbRemoveItem(item);
    });
    return b;
  }
  function wbCollectAllKeys() {
    var t = chat.full[chat.activeAgent];
    var msgs = (t && Array.isArray(t.messages)) ? t.messages : [];
    var keys = [];
    msgs.forEach(function (m) {
      if (!m) return;
      if (Array.isArray(m.att)) m.att.forEach(function (a) {
        if (a) keys.push((a.url || a.name || '') + '|' + (a.isImage ? 'i' : 'f'));
      });
      if (m.artifact) keys.push('A|' + m.artifact);
      if (m.text) extractFilePaths(String(m.text)).forEach(function (p) { keys.push('P|' + p); });
    });
    (chat.localArtifacts || []).forEach(function (la) { keys.push('LA|' + (la.path || la.name)); });
    return keys;
  }

  // 会话文本中提到的文件 → 存在性缓存（'pending' | {ok,name,size,raw}）
  var wbPathStat = {};
  var wbStatInFlight = false;
  function wbQueuePathStats(paths) {
    var todo = paths.filter(function (p) { return !wbPathStat[p]; });
    if (!todo.length || wbStatInFlight) return;
    wbStatInFlight = true;
    todo.forEach(function (p) { wbPathStat[p] = 'pending'; });
    api('/api/artifact/stat', { paths: todo }).then(function (r) {
      var map = {};
      ((r && r.items) || []).forEach(function (it) { map[it.request || it.path] = it; });
      todo.forEach(function (p) {
        var it = map[p];
        wbPathStat[p] = it ? { ok: true, name: it.name, size: it.size, raw: !!it.raw } : { ok: false };
      });
    }).catch(function () {
      todo.forEach(function (p) { wbPathStat[p] = { ok: false }; });
    }).then(function () {
      wbStatInFlight = false;
      renderWorkbench();
    });
  }

  function wbCollect() {
    var t = chat.full[chat.activeAgent];
    var msgs = (t && Array.isArray(t.messages)) ? t.messages : [];
    var images = [], files = [], artifacts = [], seen = {};
    msgs.forEach(function (m) {
      if (!m) return;
      if (Array.isArray(m.att)) m.att.forEach(function (a) {
        if (!a) return;
        var key = (a.url || a.name || '') + '|' + (a.isImage ? 'i' : 'f');
        if (wbHidden.has(key)) return;
        if (seen[key]) return; seen[key] = true;
        if (a.isImage && a.url) images.push({ url: a.url, name: a.name || '图片', ts: m.ts, key: key });
        else if (!a.isImage) files.push({ kind: 'file', name: a.name || '文件', url: a.url || null, ts: m.ts, key: key });
      });
      if (m.artifact) {
        var bn = String(m.artifact).split(/[\\/]/).pop();
        var key2 = 'A|' + m.artifact;
        if (!wbHidden.has(key2) && !seen[key2]) {
          seen[key2] = true;
          artifacts.push({ kind: 'artifact', name: bn, path: m.artifact, ts: m.ts, source: chat.activeAgent || '系统', key: key2 });
        }
      }
    });
    if (Array.isArray(chat.localArtifacts)) {
      chat.localArtifacts.forEach(function (la) {
        var key3 = 'LA|' + (la.path || la.name);
        if (!wbHidden.has(key3) && !seen[key3]) {
          seen[key3] = true;
          artifacts.unshift(Object.assign({}, la, { key: key3 }));
        }
      });
    }
    // 会话文本里提到的本地文件 → 产物候选（异步确认存在性后并入列表）
    var pathTs = {};
    msgs.forEach(function (m) {
      if (!m || !m.text) return;
      extractFilePaths(String(m.text)).forEach(function (p) {
        if (pathTs[p] === undefined) pathTs[p] = m.ts || null;
      });
    });
    var pendingPaths = [];
    Object.keys(pathTs).forEach(function (p) {
      var st = wbPathStat[p];
      if (st === 'pending') return;
      if (st && st.ok) {
        var key4 = 'P|' + p;
        if (!wbHidden.has(key4) && !seen[key4]) {
          seen[key4] = true;
          artifacts.push({ kind: 'file', name: st.name || String(p).split(/[\\/]/).pop(), path: p, ts: pathTs[p], source: '产出文件', size: st.size, raw: st.raw, key: key4 });
        }
      } else if (!st) {
        pendingPaths.push(p);
      }
    });
    if (pendingPaths.length) wbQueuePathStats(pendingPaths);
    return { images: images, files: files, artifacts: artifacts };
  }

  function getArtifactTypeInfo(name) {
    var ext = (String(name).split('.').pop() || '').toLowerCase();
    if (ext === 'md') return { label: 'MD', cls: 'md' };
    if (ext === 'json') return { label: 'JSON', cls: 'json' };
    if (['js', 'ts', 'py', 'sh', 'sql', 'html', 'css'].indexOf(ext) >= 0) return { label: 'CODE', cls: 'code' };
    return { label: 'DOC', cls: 'file' };
  }

  function openWbPreview(item) {
    wbState.previewItem = item;
    var panel = $('#workbench');
    if (panel) {
      // 预览产物即展开工作台（持久为 open，显隐由 .open 类驱动）
      try { localStorage.setItem('agent_hub_wb_mode', 'open'); } catch (e) {}
      panel.classList.add('open');
      var pc = $('#panel-chat');
      if (pc) pc.classList.add('wb-open');
    }
    var previewPane = $('#wb-preview-pane');
    if (previewPane) previewPane.hidden = false;

    var titleEl = $('#wb-preview-title');
    var typeEl = $('#wb-preview-type');
    var metaEl = $('#wb-preview-meta');
    var codeEl = $('#wb-preview-code');

    var typeInfo = getArtifactTypeInfo(item.name);
    if (titleEl) titleEl.textContent = item.name;
    if (typeEl) {
      typeEl.textContent = typeInfo.label;
      typeEl.className = 'wb-preview-type-pill ' + typeInfo.cls;
    }
    if (metaEl) {
      metaEl.textContent = (item.path ? '路径: ' + item.path : '由控制台生成') + (item.ts ? ' · ' + threadMeta(item.ts) : '');
    }

    // 图片 / SVG 走二进制 raw 预览，其余走文本
    var isMedia = item.raw || /\.(svg|png|jpe?g|gif|webp|bmp|ico)$/i.test(item.name || item.path || '');
    var imgEl = $('#wb-preview-img');
    var preEl = $('#wb-preview-pre');
    if (imgEl && preEl) {
      if (isMedia && item.path) {
        imgEl.hidden = false;
        preEl.hidden = true;
        imgEl.src = '/api/artifact/raw?path=' + encodeURIComponent(item.path) + '&t=' + Date.now();
        imgEl.alt = item.name || '产物预览';
      } else {
        imgEl.hidden = true;
        imgEl.removeAttribute('src');
        preEl.hidden = false;
      }
    }

    if (isMedia && item.path) {
      // 图片预览已由 imgEl 承担，无需加载文本
    } else if (item.text) {
      if (codeEl) codeEl.textContent = item.text;
    } else if (item.path) {
      if (codeEl) codeEl.textContent = '正在从服务端加载产物内容...';
      api('/api/artifact?path=' + encodeURIComponent(item.path)).then(function (r) {
        item.text = r.text;
        if (codeEl) codeEl.textContent = r.text + (r.truncated ? '\n\n/* 产物内容过长，已截断展示 */' : '');
      }).catch(function (err) {
        if (codeEl) codeEl.textContent = '加载失败: ' + err.message;
      });
    }

    var copyBtn = $('#wb-preview-copy');
    if (copyBtn) {
      copyBtn.onclick = function () {
        var content = (codeEl && codeEl.textContent) || '';
        copyText(content, '产物内容已复制');
      };
    }

    var downloadBtn = $('#wb-preview-download');
    if (downloadBtn) {
      downloadBtn.onclick = function () {
        if (isMedia && item.path) {
          var a = document.createElement('a');
          a.href = '/api/artifact/raw?path=' + encodeURIComponent(item.path);
          a.download = item.name || 'artifact';
          document.body.appendChild(a);
          a.click();
          a.remove();
          toast('开始下载 ' + item.name);
          return;
        }
        var content = (codeEl && codeEl.textContent) || '';
        downloadBlob(content, item.name || 'artifact.txt');
        toast('正在下载 ' + item.name);
      };
    }

    var backBtn = $('#wb-preview-back');
    if (backBtn) {
      backBtn.onclick = function () {
        wbState.previewItem = null;
        if (previewPane) previewPane.hidden = true;
        renderWorkbench();
      };
    }
  }

  function viewArtifact(path) {
    var bn = String(path).split(/[\\/]/).pop();
    openWbPreview({ kind: 'artifact', name: bn, path: path });
  }

  function renderWorkbench() {
    var panel = $('#workbench'), cnt = $('#wb-count');
    var headBadge = $('#head-wb-badge');
    if (!panel) return;
    var data = wbCollect();
    var totalArtifacts = data.artifacts.length;
    var totalMedia = data.images.length + data.files.length;
    var total = totalArtifacts + totalMedia;

    var mode = null;
    try { mode = localStorage.getItem('agent_hub_wb_mode'); } catch (e) {}
    if (mode !== 'open' && mode !== 'closed') mode = 'auto';

    var isNarrowScreen = false;
    try { isNarrowScreen = window.matchMedia('(max-width: 640px)').matches; } catch (e) {}
    var showPanel = (mode === 'open') || (mode === 'auto' && total > 0 && !isNarrowScreen);
    // 显隐走 .open 类（宽度+透明度动画，与侧栏展开一致）；工作台展开时头部按钮自动平滑消失
    panel.classList.toggle('open', showPanel);
    var panelChat = $('#panel-chat');
    if (panelChat) panelChat.classList.toggle('wb-open', showPanel);
    if (headBadge) { headBadge.textContent = total > 0 ? String(total) : '0'; headBadge.hidden = !(total > 0); }
    if (cnt) cnt.textContent = total + ' 项';

    var tabCntArtifacts = $('#wb-tab-cnt-artifacts');
    if (tabCntArtifacts) tabCntArtifacts.textContent = String(totalArtifacts);
    var tabCntFiles = $('#wb-tab-cnt-files');
    if (tabCntFiles) tabCntFiles.textContent = String(totalMedia);

    // 绑定选项卡点击事件
    var tabsWrap = $('#wb-tabs');
    if (tabsWrap && !tabsWrap.__inited) {
      tabsWrap.__inited = true;
      tabsWrap.addEventListener('click', function (e) {
        var btn = e.target.closest('.wb-tab-btn');
        if (!btn) return;
        var tab = btn.getAttribute('data-tab');
        if (!tab) return;
        wbState.tab = tab;
        tabsWrap.querySelectorAll('.wb-tab-btn').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
        if (wbState.previewItem) {
          var previewPane = $('#wb-preview-pane');
          if (previewPane) previewPane.hidden = true;
          wbState.previewItem = null;
        }
        renderWorkbench();
      });
    }

    var refreshBtn = $('#wb-refresh-btn');
    if (refreshBtn && !refreshBtn.__inited) {
      refreshBtn.__inited = true;
      // 扫帚：一键清空工作台列表（只清理列表项，不删除服务器上的原文件）
      refreshBtn.addEventListener('click', function () {
        var keys = wbCollectAllKeys();
        if (!keys.length) { toast('工作台已经是空的'); return; }
        wbHideKeys(keys);
        wbState.previewItem = null;
        var pane = $('#wb-preview-pane');
        if (pane) pane.hidden = true;
        renderWorkbench();
        toast('已清空工作台（原文件未删除）');
      });
    }

    // 左上角 ×：删除当前预览中的条目
    var wbDeleteCurrentBtn = $('#wb-delete-current');
    if (wbDeleteCurrentBtn && !wbDeleteCurrentBtn.__inited) {
      wbDeleteCurrentBtn.__inited = true;
      wbDeleteCurrentBtn.addEventListener('click', function () {
        var item = wbState.previewItem;
        if (!item) { toast('先在列表里打开一个条目再删除', true); return; }
        wbRemoveItem(item);
      });
    }

    // 如果处于预览态，保持预览视窗
    var previewPane = $('#wb-preview-pane');
    if (wbState.previewItem && previewPane && !previewPane.hidden) {
      return;
    }

    var body = $('#wb-body');
    if (!body) return;
    body.textContent = '';

    if (!total) {
      var emptyBox = el('div', 'wb-empty-state');
      emptyBox.innerHTML = '<svg class="wb-empty-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg><div class="wb-empty-title">工作台暂无产物与附件</div><div class="wb-empty-desc">当前会话中生成的长文本产物、导出文档、代码记录与上传附件将自动汇聚在此，支持沉浸式预览与一键导出。</div>';
      if (wbHidden.size) {
        var restoreAllBtn = el('button', 'wb-artifact-btn primary', '恢复已清理的 ' + wbHidden.size + ' 项');
        restoreAllBtn.type = 'button';
        restoreAllBtn.style.marginTop = '10px';
        restoreAllBtn.addEventListener('click', function () {
          wbHidden.clear();
          wbSaveHidden();
          renderWorkbench();
          toast('已恢复显示');
        });
        emptyBox.appendChild(restoreAllBtn);
      }
      body.appendChild(emptyBox);
      return;
    }

    var showArtifacts = (wbState.tab === 'all' || wbState.tab === 'artifacts');
    var showFiles = (wbState.tab === 'all' || wbState.tab === 'files');

    // 1. 产物列表
    if (showArtifacts && data.artifacts.length) {
      var secArt = el('div', 'wb-sec');
      var artTitle = el('div', 'wb-sec-title', '生成产物 (' + data.artifacts.length + ')');
      secArt.appendChild(artTitle);

      data.artifacts.forEach(function (item) {
        var card = el('div', 'wb-artifact-card');
        card.appendChild(wbDelBtn(item));
        var top = el('div', 'wb-artifact-card-top');
        var badgeWrap = el('div', 'wb-artifact-badge-wrap');
        var typeInfo = getArtifactTypeInfo(item.name);
        var badge = el('span', 'wb-artifact-badge ' + typeInfo.cls, typeInfo.label);
        var nameSpan = el('span', 'wb-artifact-name', item.name);
        nameSpan.title = item.name;
        badgeWrap.append(badge, nameSpan);
        top.appendChild(badgeWrap);
        card.appendChild(top);

        var meta = el('div', 'wb-artifact-meta', (item.source ? item.source + ' · ' : '') + (item.ts ? threadMeta(item.ts) : ''));
        card.appendChild(meta);

        var actions = el('div', 'wb-artifact-actions');
        var previewBtn = el('button', 'wb-artifact-btn primary', '预览');
        previewBtn.type = 'button';
        previewBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          openWbPreview(item);
        });

        var copyBtn = el('button', 'wb-artifact-btn', '复制');
        copyBtn.type = 'button';
        copyBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (item.text) {
            copyText(item.text, '已复制产物内容');
          } else if (item.path) {
            api('/api/artifact?path=' + encodeURIComponent(item.path)).then(function (r) {
              item.text = r.text;
              copyText(r.text, '已复制产物内容');
            }).catch(function (err) { toast(err.message, true); });
          }
        });

        var downloadBtn = el('button', 'wb-artifact-btn', '下载');
        downloadBtn.type = 'button';
        downloadBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (item.text) {
            downloadBlob(item.text, item.name);
            toast('已开始下载 ' + item.name);
          } else if (item.path) {
            api('/api/artifact?path=' + encodeURIComponent(item.path)).then(function (r) {
              item.text = r.text;
              downloadBlob(r.text, item.name);
              toast('已开始下载 ' + item.name);
            }).catch(function (err) { toast(err.message, true); });
          }
        });

        actions.append(previewBtn, copyBtn, downloadBtn);
        card.appendChild(actions);

        card.addEventListener('click', function () {
          openWbPreview(item);
        });

        secArt.appendChild(card);
      });
      body.appendChild(secArt);
    }

    // 2. 图片网格
    if (showFiles && data.images.length) {
      var secImg = el('div', 'wb-sec');
      secImg.appendChild(el('div', 'wb-sec-title', '图片 (' + data.images.length + ')'));
      var grid = el('div', 'wb-img-grid');
      data.images.forEach(function (im) {
        var cell = el('div', 'wb-img-cell');
        var img = el('img');
        img.src = im.url;
        img.alt = im.name;
        img.title = im.name;
        img.addEventListener('click', function () { openImageLightbox(im.url, im.name); });
        cell.appendChild(img);
        cell.appendChild(wbDelBtn(im));
        grid.appendChild(cell);
      });
      secImg.appendChild(grid);
      body.appendChild(secImg);
    }

    // 3. 附件文件
    if (showFiles && data.files.length) {
      var secFiles = el('div', 'wb-sec');
      secFiles.appendChild(el('div', 'wb-sec-title', '附件 (' + data.files.length + ')'));
      data.files.forEach(function (f) {
        var row = el('div', 'wb-file-row');
        row.appendChild(wbDelBtn(f));
        row.appendChild(el('div', 'wb-file-name', f.name));
        var meta = (f.kind === 'artifact' ? '产物 · ' + f.path : '上传附件') + (f.ts ? ' · ' + threadMeta(f.ts) : '');
        row.appendChild(el('div', 'wb-file-meta', meta));
        row.addEventListener('click', function () {
          if (f.kind === 'artifact') viewArtifact(f.path);
          else if (f.url) window.open(f.url, '_blank');
        });
        secFiles.appendChild(row);
      });
      body.appendChild(secFiles);
    }
  }

  function populateChatTargets() {
    var sel = $('#chat-target');
    if (!state.snap) return;
    var prev = sel.value;
    sel.textContent = '';
    var list = agentOptions().filter(function (o) { return o.value !== SELF; });
    list.forEach(function (o) {
      var a = (state.snap.agents || []).filter(function (x) { return x.name === o.value; })[0];
      var extra = '';
      if (a && a.disabled) {
        extra = ' [已禁用]';
      } else if (a && a.activation === 'standby') {
        extra = ' [可直通]';
      } else if (a && a.activation === 'queue-only') {
        extra = '（仅队列）';
      }
      var op = el('option', null, o.label + extra);
      op.value = o.value;
      if (a && a.disabled) op.disabled = true;
      sel.appendChild(op);
    });
    if (chat.activeAgent && sel.querySelector('option[value="' + chat.activeAgent + '"]')) {
      sel.value = chat.activeAgent;
    } else if (prev && sel.querySelector('option[value="' + prev + '"]')) {
      sel.value = prev;
    } else if (list.length) {
      var prefer = list.filter(function (o) { return /codebuddy/i.test(o.value); })[0] || list[0];
      sel.value = prefer.value;
    }
    populateChatModels();
  }

  function syncComposer() {
    if ($('#chat-mode')) $('#chat-mode').value = 'dispatch';
    var mode = 'dispatch';
    var auto = false;
    $('#chat-target').hidden = auto;
    if (auto) $('#chat-target').disabled = true; else $('#chat-target').disabled = false;
    populateChatModels();
  }

  // Models and runtime controls come only from the current Hub capability document.
  var modelSettings = {};
  try {
    modelSettings = JSON.parse(localStorage.getItem('agent_hub_model_prefs') || '{}');
  } catch (e) {
    modelSettings = {};
  }

  function getModelCatalog(agent) {
    var cat = (state.snap && state.snap.modelCatalog) || {};
    var list = cat[agent];
    if (list && list.length) return list;
    // 兜底从 snap.agents 读取该 worker 声明的模型（例如旧版控制台后端或直通通道）
    if (state.snap && state.snap.agents) {
      var ag = state.snap.agents.find(function (a) { return a.name === agent; });
      if (ag && ag.models && ag.models.length) {
        return ag.models.map(function (m) {
          return { id: m.id || '', name: m.alias || m.name || m.id || '默认', default: !!m.default, available: true, credits: m.credits, tag: m.tag, capability: m.capability };
        });
      }
    }
    return list || [];
  }

  // GUI 通道（如 traecode）的模型是客户端界面里的会话状态，Hub 会拒绝带 model 的派发。
  function getAgentMeta(agent) {
    var list = (state.snap && state.snap.agents) || [];
    for (var i = 0; i < list.length; i++) if (list[i].name === agent) return list[i];
    return null;
  }

  function agentModelSelectable(agent) {
    var meta = getAgentMeta(agent);
    if (meta && typeof meta.modelSelection === 'boolean') return meta.modelSelection;
    var w = state.snap && state.snap.capabilities && state.snap.capabilities.workers[agent];
    return !w || w.model_selection !== false;
  }

  function agentFixedModelName(agent) {
    var meta = getAgentMeta(agent);
    var w = state.snap && state.snap.capabilities && state.snap.capabilities.workers[agent];
    var id = (meta && meta.defaultModel) || (w && w.default_model) || '';
    return id ? (getModelDisplayName(agent, id) || id) : '';
  }

  function getModelCapability(agent, model) {
    var worker = state.snap && state.snap.capabilities && state.snap.capabilities.workers[agent];
    var selected = worker && worker.models.find(function (entry) { return entry.id === model || (entry.aliases && entry.aliases.indexOf(model) >= 0); });
    if (selected) {
      return Object.assign({}, selected, {
        available: worker.configured && worker.availability.enabled && selected.availability.enabled,
        reason: selected.availability.reason || worker.availability.reason || ''
      });
    }
    var catList = getModelCatalog(agent);
    var catEntry = catList.find(function (m) { return m.id === model; });
    if (catEntry && catEntry.capability) {
      return Object.assign({}, catEntry.capability, {
        available: catEntry.available !== false,
        reason: catEntry.reason || ''
      });
    }
    if (!worker) return { available: false, reason: state.snap && state.snap.capabilitiesError || '尚未取得当前 Hub 的模型能力信息', thinking: { allowed: ['default'], reasons: {} }, stream: { supported: false }, attachments: {} };
    return {
      available: worker.configured && worker.availability.enabled,
      reason: worker.availability.reason || '',
      thinking: { allowed: ['default', 'on', 'off'], reasons: {} },
      stream: { supported: true },
      attachments: { image: { supported: true }, file: { supported: true } }
    };
  }

  function getAgentPrefs(agent) {
    if (!agent) agent = chat.activeAgent || ($('#chat-target') ? $('#chat-target').value : '') || 'codebuddy';
    if (!modelSettings[agent]) modelSettings[agent] = {};
    var p = modelSettings[agent];
    var list = getModelCatalog(agent);
    var defObj = list.find(function (m) { return m.default; }) || list[0];
    if (!p.model || !list.some(function (m) { return m.id === p.model; })) {
      p.model = defObj ? defObj.id : '';
    }
    p.effort = p.effort || '';
    p.permission = p.permission || '';
    delete p.contextTier; delete p.autoTier;
    // 不可切换模型的通道：一律不发 model，避免 Hub 侧 UNSUPPORTED
    if (!agentModelSelectable(agent)) p.model = '';
    return p;
  }

  function saveAgentPrefs(agent, newPrefs) {
    if (!agent) agent = chat.activeAgent || ($('#chat-target') ? $('#chat-target').value : '') || 'codebuddy';
    if (!modelSettings[agent]) modelSettings[agent] = {};
    Object.assign(modelSettings[agent], newPrefs);
    try {
      localStorage.setItem('agent_hub_model_prefs', JSON.stringify(modelSettings));
    } catch (e) {}
    updateModelSummaryUI();
    updateStatusBar();
  }

  // 模型 id → 目录展示名（绝不把 huaweicloud-maas/GLM-5.2 这类原始 id 直接展示给用户）
  function getModelDisplayName(agent, modelId) {
    if (!modelId) return '';
    // 用对话块本地目录（state.snap.modelCatalog），勿跨闭包引用 modelsData
    var list = [];
    try { list = getModelCatalog(agent) || []; } catch (e) { list = []; }
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.id === modelId || m.alias === modelId || (Array.isArray(m.aliases) && m.aliases.indexOf(modelId) >= 0)) {
        return m.name || m.alias || m.id;
      }
    }
    // 未命中目录（自定义模型）：剥掉 provider 前缀兜底
    var s = String(modelId);
    var idx = s.lastIndexOf('/');
    return idx >= 0 ? s.slice(idx + 1) : s;
  }

  function getModelSummaryText(agent, opts) {
    if (!agent) agent = chat.activeAgent || ($('#chat-target') ? $('#chat-target').value : '') || 'codebuddy';
    var withAgent = !!(opts && opts.withAgent);
    if (!agentModelSelectable(agent)) {
      var fixed = agentFixedModelName(agent);
      var label = '跟随客户端' + (fixed ? ' · ' + fixed : '');
      return withAgent ? agent + '/' + label : label;
    }
    var p = getAgentPrefs(agent);
    var name = getModelDisplayName(agent, p.model);
    var parts = [];
    if (withAgent) parts.push(agent + '/' + (name || '默认模型'));
    else if (name) parts.push(name);
    if (p.effort) parts.push(p.effort);
    if (p.permission) {
      var permNames = { readonly: '只读', edit: '受控编辑', full: '完全控制' };
      parts.push(permNames[p.permission] || p.permission);
    }
    return parts.join(' · ') || (name || '默认模型');
  }

  function updateModelSummaryUI() {
    var agent = chat.activeAgent || ($('#chat-target') ? $('#chat-target').value : '') || 'codebuddy';
    // 子代理主题色贯通（发送按钮 / 模型胶囊 / 状态栏模型名 / 上下文进度条）
    applyAgentAccent(agent);
    // 发送旁模型胶囊：显示 agent名/模型名（如 codearts/GLM-5.2），不显示原始模型 id
    var summary = getModelSummaryText(agent, { withAgent: true });
    var textEl = $('#model-summary-text');
    if (textEl) textEl.textContent = summary;
    var p = getAgentPrefs(agent);
    var sel = $('#chat-model');
    if (sel && p.model) sel.value = p.model;
    var sumFooter = $('#mp-summary');
    if (sumFooter) sumFooter.textContent = '已选：' + getModelSummaryText(agent);
    var badge = $('#mp-agent-badge');
    if (badge) badge.textContent = agent;
    updateCapabilityUI(agent, p);
  }

  function updateCapabilityUI(agent, prefs) {
    var attachmentButton = $('#btn-attach');
    if (attachmentButton) {
      attachmentButton.disabled = false;
      attachmentButton.title = '添加附件（图片或文本文件）';
    }
    var fileInput = $('#file-input');
    if (fileInput) {
      fileInput.disabled = false;
      fileInput.accept = '';
    }

    var options = $('#mp-options-effort');
    if (options) {
      options.textContent = '';
      ['low', 'medium', 'high', 'max'].forEach(function (val) {
        var label = val.charAt(0).toUpperCase() + val.slice(1);
        var button = el('button', 'mp-opt-btn' + (prefs.effort === val ? ' active' : ''), label);
        button.type = 'button';
        button.disabled = false;
        button.title = '思考程度：' + val;
        button.addEventListener('click', function () {
          var next = prefs.effort === val ? '' : val;
          saveAgentPrefs(agent, { effort: next });
          renderModelPanel();
        });
        options.appendChild(button);
      });
    }

    // 文件编辑权限：选项来自该 worker 自己的能力表（每家 CLI 的开关不一样，不能照搬）
    var permBox = $('#mp-options-permission');
    if (permBox) {
      permBox.textContent = '';
      var catalogForPerm = getModelCatalog(agent) || [];
      var modelForPerm = catalogForPerm.find(function (m) { return m.id === prefs.model; }) || catalogForPerm[0] || {};
      var permCap = (modelForPerm.capability && modelForPerm.capability.permission) || null;
      var permAllowed = (permCap && Array.isArray(permCap.allowed) && permCap.allowed.length) ? permCap.allowed : ['default'];
      var permLabels = (permCap && permCap.labels) || {};
      var permDescs = (permCap && permCap.descriptions) || {};
      var PERM_FALLBACK = { default: '跟随 CLI', readonly: '只读', edit: '受控', full: '完全控制' };
      var activePerm = prefs.permission || 'default';
      if (permAllowed.indexOf(activePerm) < 0) activePerm = 'default';
      permAllowed.forEach(function (val) {
        var button = el('button', 'mp-opt-btn' + (activePerm === val ? ' active' : ''), permLabels[val] || PERM_FALLBACK[val] || val);
        button.type = 'button';
        button.dataset.perm = val;
        button.title = (permCap && permCap.scope ? permCap.scope + '\n' : '') + (permDescs[val] || (val === 'default' ? '不加任何权限开关，完全跟随该 CLI 自身配置' : val));
        button.addEventListener('click', function () {
          saveAgentPrefs(agent, { permission: val === 'default' ? '' : val });
          renderModelPanel();
        });
        permBox.appendChild(button);
      });
      var permFlag = $('#mp-permission-flag');
      if (permFlag) {
        var onlyDefault = permAllowed.length <= 1;
        permFlag.textContent = onlyDefault ? '该子代理未提供开关' : (permCap && permCap.scope ? permCap.scope : '');
        permFlag.title = onlyDefault ? '这个子代理的 CLI 没有暴露文件编辑权限开关，只能跟随它自己的配置' : (permCap && permCap.scope) || '';
      }
      if (permAllowed.length <= 1) permBox.classList.add('is-disabled');
      else permBox.classList.remove('is-disabled');
    }

    var panelNote = $('#mp-capability-note');
    if (panelNote) panelNote.textContent = '';
    var composerNote = $('#composer-capabilities');
    if (composerNote) composerNote.textContent = '';

    var sendButton = $('#btn-chat-send');
    if (sendButton) {
      sendButton.disabled = chat.sending;
      sendButton.title = '发送 (Enter)';
    }
    var refreshButton = $('#btn-capability-refresh');
    if (refreshButton) refreshButton.hidden = true;
  }

  var currentModelPanelSide = null;

  function openModelPanel(side) {
    var pop = $('#model-popover-panel');
    var wrap = $('#model-picker-wrap');
    if (!pop) return;
    side = side || 'right';
    currentModelPanelSide = side;
    pop.hidden = false;
    if (wrap) wrap.classList.add('open');
    if (side === 'left') {
      var cont = $('#model-picker-container');
      var sb = $('#sb-model');
      var comp = $('#chat-composer') || $('.composer-floating-wrap');
      if (cont && (sb || comp)) {
        var contRect = cont.getBoundingClientRect();
        var compRect = comp ? comp.getBoundingClientRect() : null;
        var sbRect = sb ? sb.getBoundingClientRect() : null;
        var targetLeft = sbRect ? (sbRect.left - contRect.left) : (compRect ? compRect.left - contRect.left : 0);
        if (compRect && targetLeft < (compRect.left - contRect.left)) {
          targetLeft = compRect.left - contRect.left;
        }
        pop.style.left = Math.round(targetLeft) + 'px';
        pop.style.right = 'auto';
      }
    } else {
      pop.style.left = 'auto';
      pop.style.right = '0';
    }
    renderModelPanel();
    var inp = $('#mp-search-input');
    if (inp) {
      inp.value = '';
      var clr = $('#mp-search-clear');
      if (clr) clr.hidden = true;
      setTimeout(function () { inp.focus(); }, 50);
    }
    document.addEventListener('click', handleModelClickOutside, true);
    document.addEventListener('keydown', handleModelKeydown, true);
  }

  function closeModelPanel() {
    var pop = $('#model-popover-panel');
    var wrap = $('#model-picker-wrap');
    if (pop) {
      pop.hidden = true;
      pop.style.left = '';
      pop.style.right = '';
    }
    currentModelPanelSide = null;
    if (wrap) wrap.classList.remove('open');
    document.removeEventListener('click', handleModelClickOutside, true);
    document.removeEventListener('keydown', handleModelKeydown, true);
  }

  function toggleModelPanel(e, side) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    side = side || 'right';
    var pop = $('#model-popover-panel');
    if (pop && !pop.hidden) {
      if (currentModelPanelSide === side) {
        closeModelPanel();
      } else {
        openModelPanel(side);
      }
    } else {
      openModelPanel(side);
    }
  }

  function handleModelClickOutside(e) {
    var container = $('#model-picker-container');
    var sbModel = $('#sb-model');
    if (sbModel && (sbModel === e.target || sbModel.contains(e.target))) {
      return;
    }
    if (container && !container.contains(e.target)) {
      closeModelPanel();
    }
  }

  function handleModelKeydown(e) {
    if (e.key === 'Escape') {
      closeModelPanel();
    }
  }

  function renderModelPanel() {
    var agent = chat.activeAgent || ($('#chat-target') ? $('#chat-target').value : '') || 'codebuddy';
    var models = getModelCatalog(agent);
    var prefs = getAgentPrefs(agent);

    var badge = $('#mp-agent-badge');
    if (badge) badge.textContent = agent;

    var listEl = $('#mp-model-list');
    var countEl = $('#mp-model-count');

    if (listEl) listEl.hidden = false;

    // GUI 通道（traecode）没法从 API 换模型：别摆一列点了必报错的选项
    if (!agentModelSelectable(agent)) {
      if (countEl) countEl.textContent = '';
      if (listEl) {
        listEl.textContent = '';
        var fixedName = agentFixedModelName(agent) || '客户端当前模型';
        var note = el('div', 'mp-empty');
        note.style.padding = '14px 16px';
        note.style.color = 'var(--mcode-text-muted)';
        note.style.fontSize = '12px';
        note.style.lineHeight = '1.7';
        var noteTitle = el('div', null, '跟随客户端 · ' + fixedName);
        noteTitle.style.cssText = 'color:var(--mcode-text);font-size:13px;margin-bottom:4px';
        note.appendChild(noteTitle);
        note.appendChild(el('div', null, '这个通道（' + agent + '）的模型是客户端界面里的会话状态，接口改不了。要换模型请在对应的客户端里切换，这里派发时会沿用它当前的模型。'));
        listEl.appendChild(note);
      }
      var pc = $('#mp-params-container');
      if (pc) pc.style.display = 'none';
      updateModelSummaryUI();
      return;
    }

    var searchInp = $('#mp-search-input');
    var searchVal = (searchInp && searchInp.value) ? String(searchInp.value).trim().toLowerCase() : '';
    var filtered = models.filter(function (m) {
      if (!searchVal) return true;
      return (m.name && m.name.toLowerCase().indexOf(searchVal) !== -1) ||
             (m.id && m.id.toLowerCase().indexOf(searchVal) !== -1);
    });

    if (countEl) countEl.textContent = '(' + filtered.length + '/' + models.length + ')';

    if (listEl) {
      listEl.textContent = '';
      if (!filtered.length) {
        var empty = el('div', 'mp-empty', '无匹配模型');
        empty.style.padding = '12px';
        empty.style.textAlign = 'center';
        empty.style.color = 'var(--mcode-text-muted)';
        empty.style.fontSize = '12px';
        listEl.appendChild(empty);
      } else {
        filtered.forEach(function (m) {
          var isSelected = (prefs.model === m.id);
          var item = el('div', 'mp-model-item' + (isSelected ? ' selected' : ''));
          item.setAttribute('data-id', m.id);
          item.style.cursor = 'pointer';

          var main = el('div', 'mp-model-main');
          var nameSpan = el('span', 'mp-model-name', m.name);
          var idSpan = el('span', 'mp-model-id', m.id);
          main.appendChild(nameSpan);
          main.appendChild(idSpan);
          item.appendChild(main);

          var tagsDiv = el('div', 'mp-model-tags');
          if (m.credits) {
            var cred = String(m.credits).replace(/\s*credits\b/i, '').trim();
            if (cred === 'x0.00' || cred === 'x0' || cred === '0' || cred === '0.00x' || cred === '0x' || cred === '0.0x' || m.tag === '免费') {
              tagsDiv.appendChild(el('span', 'mp-tag mp-tag-free', '免费'));
            } else {
              tagsDiv.appendChild(el('span', 'mp-tag mp-tag-credits', cred));
            }
          } else if (m.tag === '免费') {
            tagsDiv.appendChild(el('span', 'mp-tag mp-tag-free', '免费'));
          }

          if (m.tag && m.tag !== '免费') {
            if (m.tag === '即将下线') {
              tagsDiv.appendChild(el('span', 'mp-tag mp-tag-depr', '即将下线'));
            } else if (m.tag.indexOf('福利') !== -1) {
              tagsDiv.appendChild(el('span', 'mp-tag mp-tag-promo', m.tag));
            } else if (m.tag.indexOf('折') !== -1 || m.tag.indexOf('补贴') !== -1 || m.tag.indexOf('限时') !== -1) {
              tagsDiv.appendChild(el('span', 'mp-tag mp-tag-discount', m.tag));
            } else if (m.tag === '默认' || m.default) {
              tagsDiv.appendChild(el('span', 'mp-tag mp-tag-default', m.tag || '默认'));
            } else {
              tagsDiv.appendChild(el('span', 'mp-tag mp-tag-default', m.tag));
            }
          } else if (!m.credits && (m.default || m.tag === '默认')) {
            tagsDiv.appendChild(el('span', 'mp-tag mp-tag-default', '默认'));
          }
          if (isSelected) {
            var chk = el('span', 'mp-check');
            chk.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
            tagsDiv.appendChild(chk);
          }
          item.appendChild(tagsDiv);

          item.addEventListener('click', function () {
            saveAgentPrefs(agent, { model: m.id });
            renderModelPanel();
          });
          listEl.appendChild(item);
        });
      }
    }

    var paramsContainer = $('#mp-params-container');
    if (paramsContainer) paramsContainer.style.display = 'flex';
    updateModelSummaryUI();
  }

  function populateChatModels() {
    var sel = $('#chat-model');
    if (!sel) return;
    var mode = $('#chat-mode') ? $('#chat-mode').value : 'dispatch';
    var agentName = chat.activeAgent || ($('#chat-target') ? $('#chat-target').value : '') || 'codebuddy';
    var show = (mode === 'dispatch' || mode === 'task' || mode === 'auto');
    sel.hidden = !show;
    var wrap = $('#model-picker-wrap');
    if (wrap) wrap.style.display = show ? 'inline-flex' : 'none';
    if (!show) { sel.textContent = ''; return; }

    var models = getModelCatalog(agentName);
    var prev = sel.value;
    sel.textContent = '';
    if (!agentModelSelectable(agentName)) {
      // 模型由客户端界面决定：只展示，不允许在这里选，也不往 Hub 传 model
      var fixedName = agentFixedModelName(agentName);
      var fixedOp = el('option', null, '跟随客户端' + (fixedName ? ' · ' + fixedName : ''));
      fixedOp.value = '';
      sel.appendChild(fixedOp);
      sel.disabled = true;
      sel.value = '';
      updateModelSummaryUI();
      return;
    }
    sel.disabled = false;
    models.forEach(function (m) {
      var badge = '';
      if (m.credits) {
        var cred = String(m.credits).replace(/\s*credits\b/i, '').trim();
        var isFree = (cred === 'x0.00' || cred === 'x0' || cred === '0' || cred === '0.00x' || cred === '0x' || cred === '0.0x' || m.tag === '免费');
        badge = isFree ? ' [免费]' : ' [' + cred + ']';
        if (m.tag && m.tag !== '免费') {
          badge = ' [' + m.tag + ']' + badge;
        }
      } else if (m.tag) {
        badge = ' [' + m.tag + ']';
      }
      var op = el('option', null, m.name + badge + ' (' + m.id + ')');
      op.value = m.id;
      sel.appendChild(op);
    });
    var prefs = getAgentPrefs(agentName);
    if (prefs.model && sel.querySelector('option[value="' + prefs.model + '"]')) {
      sel.value = prefs.model;
    }
    updateModelSummaryUI();
  }

  function sendChat() {
    if (chat.sending) return;
    if ($('#chat-mode')) $('#chat-mode').value = 'dispatch';
    var text = $('#chat-input').value.trim();
    var mode = 'dispatch';
    var agent = chat.activeAgent || ($('#chat-target') ? $('#chat-target').value : '');
    var ready = chat.atts.filter(function (a) { return a.status === 'ready' && a.url; });
    if (!text && !ready.length) { toast('消息为空', true); return; }
    if (!agent) { toast('请先选择一个子代理平台', true); return; }
    if (chat.atts.some(function (a) { return a.status === 'uploading'; })) { toast('附件还在上传，稍等…', true); return; }

    var prefs = getAgentPrefs(agent);
    var model = prefs.model || '';
    var payload = {
      agent: agent,
      mode: mode,
      text: text || (ready.length ? '请看附件。' : ''),
      sessionId: chat.activeSessionId
    };
    if (model) payload.model = model;
    if (prefs.effort) payload.effort = prefs.effort;
    if (prefs.permission) payload.permission = prefs.permission;
    if (prefs.thinking) payload.thinking = prefs.thinking;
    if (prefs.stream) payload.stream = prefs.stream;
    if (ready.length) payload.attachments = ready.map(function (a) {
      var o = { url: a.url, name: a.name, isImage: !!a.isImage };
      if (a.content) o.content = a.content;
      return o;
    });

    chat.sending = true;
    $('#btn-chat-send').disabled = true;
    api('/api/chat/send', payload).then(function (r) {
      // 看板娘：派发成功时蹦一下报个到（她没开就什么都不做）
      if (window.HubMascot) window.HubMascot.onDispatch(agent);
      $('#chat-input').value = '';
      $('#chat-input').style.height = 'auto';
      chat.atts.forEach(function (a) { if (a.local) { try { URL.revokeObjectURL(a.local); } catch (e) {} } });
      chat.atts = [];
      renderAttStrip();
      return loadThreads().then(function () {
        return selectPlatform(agent, chat.activeSessionId);
      });
    }).catch(function (e) {
      toast(e.message, true);
      if (chat.activeAgent === agent) {
        selectPlatform(agent, chat.activeSessionId);
      }
    }).finally(function () {
      chat.sending = false;
      updateModelSummaryUI();
    });
  }
  // ---------------- 附件（图片/文件）: 选择/粘贴后立即上传, 发送时携带 url 元数据
  function addFiles(files) {
    var arr = Array.prototype.slice.call(files || []);
    arr.forEach(function (f) {
      var agent = chat.activeAgent || ($('#chat-target') ? $('#chat-target').value : '');
      var prefs = getAgentPrefs(agent);
      var capability = getModelCapability(agent, prefs.model);
      var kind = /^image\//.test(f.type || '') || /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(f.name || '') ? 'image' : 'file';
      var option = capability.attachments[kind] || {};
      if (!capability.available || !option.supported) { toast(option.reason || capability.reason || '选定模型不支持此类附件', true); return; }
      if (kind === 'file' && (option.content_types || []).some(function (type) { return /charset=utf-8/i.test(type); }) && !/^text\//.test(f.type || '') && !/\.(?:txt|md|json|csv|log|py|js|ts|html|css|ya?ml)$/i.test(f.name || '')) { toast('选定模型的文件附件仅支持 UTF-8 文本', true); return; }
      if (chat.atts.length >= 4) { toast('最多 4 个附件', true); return; }
      if (f.size + chat.atts.reduce(function (sum, attachment) { return sum + attachment.size; }, 0) > 1024 * 1024) { toast('派发附件总计不能超过 1 MiB', true); return; }
      if (!f.size) { toast('「' + f.name + '」是空文件', true); return; }
      var rec = { name: f.name || 'file', size: f.size, isImage: /^image\//.test(f.type || ''), status: 'uploading', url: null, content: null, local: null };
      if (rec.isImage) { try { rec.local = URL.createObjectURL(f); } catch (e) { /* noop */ } }
      chat.atts.push(rec);
      renderAttStrip();
      var fr = new FileReader();
      fr.onload = function () {
        var b64 = String(fr.result).split(',')[1] || '';
        api('/api/upload', { name: f.name, base64: b64 }).then(function (r) {
          rec.status = 'ready';
          rec.url = r.url;
          rec.isImage = !!r.isImage;
          rec.content = r.content || null;
        }).catch(function (e) {
          rec.status = 'error';
          toast('上传失败: ' + e.message, true);
        }).finally(function () { renderAttStrip(); });
      };
      fr.onerror = function () { rec.status = 'error'; renderAttStrip(); toast('读取文件失败', true); };
      fr.readAsDataURL(f);
    });
  }
  function renderAttStrip() {
    var host = $('#att-strip');
    host.textContent = '';
    if (!chat.atts.length) { host.hidden = true; return; }
    host.hidden = false;
    chat.atts.forEach(function (a) {
      var chip = el('span', 'att-chip');
      if (a.local) { var im = el('img'); im.src = a.local; chip.appendChild(im); }
      else chip.appendChild(el('span', 'att-chip-icon', '文档'));
      var st = a.status === 'uploading' ? ' · 上传中…' : a.status === 'error' ? ' · 失败' : (a.content ? ' · 已内联' : '');
      chip.appendChild(el('span', 'nm', a.name.slice(0, 28) + ' (' + Math.max(1, Math.round(a.size / 1024)) + 'KB)' + st));
      chip.appendChild(btn('×', 'x', function () {
        var i = chat.atts.indexOf(a);
        if (i >= 0) chat.atts.splice(i, 1);
        if (a.local) { try { URL.revokeObjectURL(a.local); } catch (e) { /* noop */ } }
        renderAttStrip();
      }));
      host.appendChild(chip);
    });
  }
  // ---------------- 模式说明（图一问题答复的应用内版本）
  function showModeHelp() {
    showSyncResult('发送模式区别', [
      '【自动派发 (auto)】' + SELF + ' 本机没有 CLI, 此模式由控制台按「在线优先 + 支持所选模型 + 轮转均衡」自动挑一个可派发子代理转交任务, 结果自动回到本对话。目标选择框隐藏, 模型下拉作为硬性约束。',
      '',
      '【直通派发 (dispatch)】立即远程拉起指定代理的 CLI 执行一次性任务(hub_dispatch_cli)。对方心跳离线也不要紧, 只要配了 CLI 通道就能派发; 返回 ref, 完成后自动回复到本线程。支持选模型。适合「马上要结果」。',
      '',
      '【Trae 会话 (trae)】走 Trae 桌面版本机 AI(trae_delegate), 唯一支持多轮续接 session 的通道; 模型由桌面版固定, 不能指定。适合和 Trae 连续讨论。',
      '',
      '【任务 (task)】写入 hub 共享队列并指派给对方(hub_post_task), 不立即执行; 对方上线认领、执行完 hub_complete_task 后结果自动回到本线程。适合不急着要、要留痕的异步工作。',
      '',
      '【私信 (message)】写进对方 hub 信箱(hub_send_message), 对方下次轮询信箱才看得到, 且不保证回复。适合轻量通知/打招呼。',
      '',
      '附件: 点击附件或粘贴图片, ≤8MB、最多 4 个; 文本类文件内容会自动内联进任务; 图片对远程 worker 只以本机路径提示。'
    ].join('\n'));
  }
  var _chatEventTimer = null;
  function onChatEvent(d) {
    if (!d) return;
    if (d.agent === chat.activeAgent || (d.threadId && (d.threadId === chat.activeSessionId || d.threadId === 'th-' + chat.activeAgent))) {
      clearTimeout(_chatEventTimer);
      _chatEventTimer = setTimeout(function () {
        if (!chat.activeAgent) return;
        var seq = ++chat._threadReqSeq;
        api('/api/chat/thread?agent=' + encodeURIComponent(chat.activeAgent) + (chat.activeSessionId ? '&session=' + encodeURIComponent(chat.activeSessionId) : '')).then(function (r) {
          if (seq !== chat._threadReqSeq) return;
          if (r.thread) {
            chat.full[chat.activeAgent] = r.thread;
            chat.sessions = r.sessions || [];
            renderThreadView();
          }
        });
      }, 50);
    } else {
      pollUpdates();
    }
  }
  function loadUsage() {
    return api('/api/usage').then(function (u) {
      chat.usage = u; chat.usageLoaded = true;
      var bar = $('#usage-bar');
      var td = u.today || { in: 0, out: 0, msgs: 0, runs: 0 };
      if (bar) {
        bar.textContent = '';
        bar.appendChild(el('span', null, '今日 ≈' + td.in + ' tok 发出 · ≈' + td.out + ' tok 收到'));
        bar.appendChild(el('b', null, td.msgs + ' 条消息 · ' + td.runs + ' 次运行'));
        bar.appendChild(el('span', null, '累计 ≈' + u.total.in + ' / ≈' + u.total.out + '（点击看分代理明细）'));
      }
      updateStatusBar();
    }).catch(function () { /* noop */ });
  }
  function showUsageDetail() {
    if (!chat.usage) { loadUsage().then(showUsageDetail); return; }
    var u = chat.usage;
    var rows = ['agent,今日tok(in/out/条/次),累计tok(in/out/条/次)'];
    var day = new Date().toISOString().slice(0, 10);
    var td = u.days.filter(function (x) { return x.day === day; })[0];
    Object.keys(u.agents).forEach(function (k) {
      rows.push(k + ', -, ' + u.agents[k].in + '/' + u.agents[k].out + '/' + u.agents[k].msgs + '/' + u.agents[k].runs);
    });
    showSyncResult('tokens 采集明细 · ' + u.estNote, rows.join('\n') + '\n\n近 14 天:\n' + u.days.map(function (d2) { return d2.day + '  in≈' + d2.in + '  out≈' + d2.out + '  msgs=' + d2.msgs + '  runs=' + d2.runs; }).join('\n'));
  }

  // ---------------- 紧凑状态条逻辑
  var quotasData = null;
  var quotasLoading = false;
  var quotasLastFetch = 0;
  var quotasError = null;

  function fmtTok(n) {
    n = n || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1000) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  function fmtQuotaVal(v) {
    if (v == null) return '0';
    var n = Number(v);
    if (isNaN(n)) return String(v);
    if (n >= 1000) return fmtTok(n);
    return String(v);
  }

  function loadQuotas() {
    var now = Date.now();
    if (quotasData && (now - quotasLastFetch < 60000)) {
      return Promise.resolve(quotasData);
    }
    if (quotasLoading) return Promise.resolve(quotasData);
    quotasLoading = true;
    return api('/api/quotas').then(function (res) {
      quotasData = res;
      quotasLastFetch = Date.now();
      quotasLoading = false;
      quotasError = null;
      var qBox = $('#cb-pop-quotas-box');
      if (qBox) qBox.innerHTML = renderQuotasContent(quotasData, null);
      updateStatusBar();
      return res;
    }).catch(function (err) {
      quotasLoading = false;
      quotasError = (err && err.message) || '加载失败';
      var qBox = $('#cb-pop-quotas-box');
      if (qBox) qBox.innerHTML = renderQuotasContent(null, quotasError);
      updateStatusBar();
      return null;
    });
  }

  function formatResetTime(isoStr) {
    if (!isoStr) return '';
    try {
      var d = new Date(isoStr);
      if (isNaN(d.getTime())) return '';
      var now = new Date();
      var isToday = (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate());
      var h = String(d.getHours()).padStart(2, '0');
      var m = String(d.getMinutes()).padStart(2, '0');
      if (isToday) {
        return '今日 ' + h + ':' + m + ' 重置';
      }
      var month = String(d.getMonth() + 1).padStart(2, '0');
      var day = String(d.getDate()).padStart(2, '0');
      return month + '/' + day + ' ' + h + ':' + m + ' 重置';
    } catch (e) {
      return '';
    }
  }

  function renderQuotasContent(data, err, agent) {
    if (!agent) agent = chat.activeAgent || 'antigravity';
    var untrackedPlats = ['zcode', 'mimocode'];
    var plat = null;
    if (agent === 'antigravity') plat = 'antigravity';
    else if (agent === 'codebuddy' || agent === 'codebuddy-cn') plat = 'codebuddy';
    else if (agent === 'traecode') plat = 'traecode';
    else if (agent === 'github-copilot') plat = 'github-copilot';
    else if (agent === 'minimaxcode') plat = 'minimaxcode';

    if (!plat) {
      return '<div class="cb-pop-quotas-list">' +
        '<div class="cb-quota-plat-card">' +
          '<div class="cb-quota-untracked-item">' +
            '<span class="cb-quota-untracked-name">' + esc(agent) + '</span>' +
            '<span class="cb-quota-untracked-tag">未接入配额跟踪</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    if (err) {
      return '<div class="cb-pop-empty" style="color:var(--mcode-text-subtle)">配额信息暂时不可用 (' + esc(err) + ')</div>';
    }
    if (!data) {
      return '<div class="cb-pop-empty">正在查询平台配额…</div>';
    }

    var pInfo = data[plat];
    if (!pInfo || pInfo.error) {
      var errMsg = (!pInfo ? '数据缺失' : pInfo.error);
      return '<div class="cb-pop-quotas-list">' +
        '<div class="cb-quota-plat-card">' +
          '<div class="cb-quota-plat-header">' +
            '<span class="cb-quota-plat-name">' + esc(plat) + '</span>' +
            '<span class="cb-quota-err-text">查询失败 (' + esc(errMsg) + ')</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    var html = '<div class="cb-pop-quotas-list">';
    if (plat === 'codebuddy') {
      var allGroups = Array.isArray(pInfo.groups) ? pInfo.groups : [];
      var targetSource = (agent === 'codebuddy-cn') ? '国内' : '国际';
      var groups = allGroups.filter(function (g) { return g.source === targetSource; });
      if (!groups.length && allGroups.length) groups = [allGroups[0]];
      if (!groups.length) {
        html += '<div class="cb-quota-plat-card">' +
          '<div class="cb-quota-plat-header">' +
            '<span class="cb-quota-plat-name">' + esc('codebuddy ' + targetSource) + '</span>' +
            '<span class="cb-quota-plan-tag">' + esc(pInfo.plan || '已接入') + '</span>' +
          '</div>' +
          '<div class="cb-quota-reset">暂无配额数据</div>' +
        '</div>';
      } else {
        var g = groups[0];
        var tot = g.totalRemaining || 0;
        var totalHtml = '<div class="cb-quota-total" title="总剩余 ' + tot + ' 积分"><span>总剩余积分（' + (g.packageCount || 0) + ' 个有效包）</span><b>' + fmtTok(tot) + '</b></div>';
        var topList = Array.isArray(g.top) ? g.top : [];
        var cbItems = topList.map(function (q) {
          var remPct = typeof q.remainingPercentage === 'number' ? q.remainingPercentage : 100;
          var barColor = remPct > 30 ? 'var(--mcode-accent, #38bdf8)' : (remPct > 10 ? '#f59e0b' : '#ef4444');
          var resetText = formatResetTime(q.resetAt);
          return '<div class="cb-quota-item">' +
            '<div class="cb-quota-item-top">' +
              '<span class="cb-quota-item-name">' + esc(q.displayName || q.name) + '</span>' +
              '<span class="cb-quota-item-stat">剩 <b>' + fmtQuotaVal(q.remaining) + '</b>/' + fmtQuotaVal(q.total) + '</span>' +
            '</div>' +
            '<div class="cb-quota-bar-wrap"><div class="cb-quota-bar-fill" style="width:' + Math.min(100, Math.max(0, remPct)) + '%;background:' + barColor + '"></div></div>' +
            (resetText ? '<div class="cb-quota-reset">' + esc(resetText) + '</div>' : '') +
          '</div>';
        }).join('');
        if (!cbItems) cbItems = '<div class="cb-quota-reset">暂无剩余积分高于 50 的配额包</div>';
        html += '<div class="cb-quota-plat-card">' +
          '<div class="cb-quota-plat-header">' +
            '<span class="cb-quota-plat-name">' + esc('codebuddy ' + (g.source || '')) + '</span>' +
            '<span class="cb-quota-plan-tag">' + esc(g.plan || '已接入') + '</span>' +
          '</div>' +
          totalHtml + cbItems +
        '</div>';
      }
    } else {
      var qList = Array.isArray(pInfo.quotas) ? pInfo.quotas : [];
      var majorQuotas = [];
      if (plat === 'antigravity') {
        majorQuotas = qList.filter(function (q) {
          return q.name === 'gemini_session' || q.name === 'gemini_weekly' || q.name === 'claude_gpt_weekly';
        });
        if (!majorQuotas.length) majorQuotas = qList.slice(0, 3);
      } else if (plat === 'traecode') {
        majorQuotas = qList;
      } else if (plat === 'github-copilot') {
        var sortedCopilot = qList.slice().sort(function (a, b) {
          var aUnlim = a.unlimited ? 1 : 0;
          var bUnlim = b.unlimited ? 1 : 0;
          return aUnlim - bUnlim;
        });
        majorQuotas = sortedCopilot.slice(0, 2);
      } else if (plat === 'minimaxcode') {
        var cred = qList.filter(function (q) { return q.isCreditBalance || q.name === 'Credits'; })[0];
        if (cred) {
          majorQuotas = [cred];
        } else {
          majorQuotas = qList.slice().sort(function (a, b) {
            if (a.name === 'general') return -1;
            if (b.name === 'general') return 1;
            return 0;
          });
        }
      } else {
        majorQuotas = qList.slice(0, 2);
      }

      var itemsHtml = majorQuotas.map(function (q) {
        if (q.isCreditBalance || q.name === 'Credits') {
          var rem = q.remaining != null ? q.remaining : q.total;
          var remStr = typeof rem === 'number' ? rem.toFixed(2) : rem;
          return '<div class="cb-quota-item">' +
            '<div class="cb-quota-item-top">' +
              '<span class="cb-quota-item-name">' + esc(q.displayName || '剩余积分') + '</span>' +
              '<span class="cb-quota-item-stat"><b>' + remStr + '</b> 积分</span>' +
            '</div>' +
            '<div class="cb-quota-bar-wrap"><div class="cb-quota-bar-fill" style="width:100%;background:var(--mcode-accent, #38bdf8)"></div></div>' +
          '</div>';
        }
        var remPct = typeof q.remainingPercentage === 'number' ? q.remainingPercentage : 100;
        var barColor = remPct > 30 ? 'var(--mcode-accent, #38bdf8)' : (remPct > 10 ? '#f59e0b' : '#ef4444');
        var resetText = formatResetTime(q.resetAt);
        return '<div class="cb-quota-item">' +
          '<div class="cb-quota-item-top">' +
            '<span class="cb-quota-item-name">' + esc(q.displayName || q.name) + '</span>' +
            '<span class="cb-quota-item-stat"><b>' + fmtQuotaVal(q.used) + '</b>/' + fmtQuotaVal(q.total) + ' <small>(' + remPct + '% 余)</small></span>' +
          '</div>' +
          '<div class="cb-quota-bar-wrap"><div class="cb-quota-bar-fill" style="width:' + Math.min(100, Math.max(0, remPct)) + '%;background:' + barColor + '"></div></div>' +
          (resetText ? '<div class="cb-quota-reset">' + esc(resetText) + '</div>' : '') +
        '</div>';
      }).join('');

      html += '<div class="cb-quota-plat-card">' +
        '<div class="cb-quota-plat-header">' +
          '<span class="cb-quota-plat-name">' + esc(plat) + '</span>' +
          '<span class="cb-quota-plan-tag">' + esc(pInfo.plan || '已接入') + '</span>' +
        '</div>' +
        itemsHtml +
      '</div>';
    }
    html += '</div>';
    return html;
  }

  function sbStats(agent) {
    if (!agent) agent = chat.activeAgent || 'antigravity';
    var t = chat.full[agent];
    var msgs = (t && Array.isArray(t.messages)) ? t.messages : [];
    var totIn = 0, totOut = 0, lastMeIdx = -1, turnOut = 0, turnN = 0, lastAgent = null;
    msgs.forEach(function (m, i) {
      var k = m.tok || 0;
      if (m.role === 'me') {
        totIn += k;
        lastMeIdx = i;
        turnOut = 0;
        turnN = 0;
      } else if (m.role === 'agent') {
        totOut += k;
        if (lastMeIdx >= 0) {
          turnOut += k;
          turnN++;
        }
        lastAgent = m;
      }
    });

    var tps = null;
    var lastAgentTok = 0;
    var lastAgentSec = 0;
    if (lastAgent && lastMeIdx >= 0 && msgs[lastMeIdx]) {
      var tAgent = typeof lastAgent.ts === 'number' ? lastAgent.ts : new Date(lastAgent.ts).getTime();
      var tMe = typeof msgs[lastMeIdx].ts === 'number' ? msgs[lastMeIdx].ts : new Date(msgs[lastMeIdx].ts).getTime();
      var diffMs = tAgent - tMe;
      var diffSec = (tAgent > 1e11 || tMe > 1e11) ? (diffMs / 1000) : diffMs;
      if (diffSec > 0 && typeof lastAgent.tok === 'number' && lastAgent.tok > 0) {
        lastAgentTok = lastAgent.tok;
        lastAgentSec = diffSec;
        var secVal = Math.max(0.1, diffSec);
        tps = lastAgentTok / secVal;
      }
    }

    var tot = totIn + totOut;
    var pct = Math.min(100, Math.round(tot / 1000000 * 1000) / 10);

    var agUsage = (chat.usage && chat.usage.today && chat.usage.today.agents) ? chat.usage.today.agents[agent] : null;
    var td = {
      in: agUsage ? (agUsage.in || 0) : 0,
      out: agUsage ? (agUsage.out || 0) : 0,
      msgs: agUsage ? (agUsage.msgs || 0) : 0,
      runs: agUsage ? (agUsage.runs || 0) : 0
    };

    return {
      agent: agent,
      totIn: totIn,
      totOut: totOut,
      tot: tot,
      pct: pct,
      turnOut: turnOut,
      turnN: turnN,
      tps: tps,
      lastAgentTok: lastAgentTok,
      lastAgentSec: lastAgentSec,
      today: td
    };
  }

  var SB_TIPS = {
    agent: function () {
      var a = chat.activeAgent || 'codebuddy';
      return '当前子代理：' + a + '\n可在左侧会话列表切换子代理';
    },
    model: function () {
      var a = chat.activeAgent || 'codebuddy';
      return '当前模型：' + getModelSummaryText(a) + '\n点击直接展开模型与运行参数选择面板';
    },
    speed: function () {
      var st = sbStats();
      if (st.tps == null) {
        return '速度（估算）\n暂无最近回复速度数据\n口径: 输出 tokens ÷ 距你上一条消息的间隔';
      }
      return '速度（估算）\n最近回复 ≈' + st.lastAgentTok + ' tok / ' + st.lastAgentSec.toFixed(1) + 's ≈ ' + st.tps.toFixed(1) + ' t/s\n口径: 输出 tokens ÷ 距你上一条消息的间隔';
    },
    ctx: function () {
      var st = sbStats();
      return '上下文用量（估算）\n≈ ' + fmtTok(st.tot) + ' / 1M 名义窗口 (' + st.pct + '%)\n口径: 当前会话全部消息 tokens 累计';
    },
    turn: function () {
      var st = sbStats();
      return '本轮\n输出 ≈' + fmtTok(st.turnOut) + ' tok · ' + st.turnN + ' 条回复\n口径: 最后一条你发送的消息之后的回复';
    },
    sess: function () {
      var st = sbStats();
      return '会话总计（当前会话）\n输入 ≈' + fmtTok(st.totIn) + ' tok / 输出 ≈' + fmtTok(st.totOut) + ' tok\n口径: 当前会话全部消息的启发式估算';
    },
    today: function () {
      var st = sbStats();
      return '今日总计（' + st.agent + '）\n输入 ≈' + fmtTok(st.today.in) + ' tok / 输出 ≈' + fmtTok(st.today.out) + ' tok\n' + st.today.msgs + ' 条消息 · ' + st.today.runs + ' 次运行';
    },
    quota: function () {
      var agent = chat.activeAgent || 'antigravity';
      var plat = null;
      if (agent === 'antigravity') plat = 'antigravity';
      else if (agent === 'codebuddy' || agent === 'codebuddy-cn') plat = 'codebuddy';
      else if (agent === 'traecode') plat = 'traecode';
      else if (agent === 'github-copilot') plat = 'github-copilot';
      else if (agent === 'minimaxcode') plat = 'minimaxcode';

      var header = '平台配额（' + agent + '）';
      if (!plat) {
        return header + '\n当前平台未接入配额跟踪';
      }
      if (!quotasData || !quotasData[plat] || quotasData[plat].error) {
        return header + '\n当前平台未接入配额跟踪';
      }

      if (plat === 'codebuddy') {
        var cbData = quotasData.codebuddy;
        var groups = Array.isArray(cbData && cbData.groups) ? cbData.groups : [];
        var targetSource = (agent === 'codebuddy-cn') ? '国内' : '国际';
        var group = groups.filter(function (g) { return g.source === targetSource; })[0];
        if (!group && groups.length) group = groups[0];
        if (!group) {
          return header + '\n当前平台未接入配额跟踪';
        }
        var planStr = group.plan ? '（' + group.plan + '）' : '';
        var lines = [(group.source || '') + planStr + '总剩余 ' + (group.totalRemaining != null ? group.totalRemaining : 0) + ' 积分 · ' + (group.packageCount || 0) + ' 个有效包'];
        var topList = Array.isArray(group.top) ? group.top : [];
        topList.forEach(function (pkg) {
          var rTime = formatResetTime(pkg.resetAt);
          lines.push((pkg.displayName || pkg.name) + ' 剩' + pkg.remaining + '/' + pkg.total + (rTime ? ' · ' + rTime : ''));
        });
        return lines.join('\n');
      } else if (plat === 'antigravity') {
        var agyData = quotasData.antigravity;
        var qList = Array.isArray(agyData && agyData.quotas) ? agyData.quotas : [];
        if (!qList.length) {
          return '平台配额（antigravity）\n当前平台未接入配额跟踪';
        }
        var majorNames = ['gemini_session', 'gemini_weekly', 'claude_gpt_weekly'];
        var majorQuotas = qList.filter(function (q) {
          return majorNames.indexOf(q.name) >= 0;
        });
        if (!majorQuotas.length) {
          majorQuotas = qList.slice(0, 3);
        }
        if (!majorQuotas.length) {
          var minQ = qList.reduce(function (min, cur) {
            var minPct = typeof min.remainingPercentage === 'number' ? min.remainingPercentage : 100;
            var curPct = typeof cur.remainingPercentage === 'number' ? cur.remainingPercentage : 100;
            return curPct < minPct ? cur : min;
          }, qList[0]);
          if (minQ) majorQuotas = [minQ];
        }
        var lines = ['平台配额（antigravity）'];
        majorQuotas.forEach(function (q) {
          var pct = typeof q.remainingPercentage === 'number' ? q.remainingPercentage : 0;
          var rTime = formatResetTime(q.resetAt);
          lines.push((q.displayName || q.name) + ' ' + q.used + '/' + q.total + ' · 剩' + pct + '%' + (rTime ? ' · ' + rTime : ''));
        });
        return lines.join('\n');
      } else if (plat === 'traecode') {
        var traeData = quotasData.traecode;
        var qListTrae = Array.isArray(traeData.quotas) ? traeData.quotas : [];
        if (!qListTrae.length) {
          return header + '\n当前平台未接入配额跟踪';
        }
        var q0 = qListTrae[0];
        var rTime = formatResetTime(q0.resetAt);
        return header + '\n剩 ' + (q0.remaining != null ? q0.remaining : 0) + '/' + (q0.total != null ? q0.total : 0) + (rTime ? ' · ' + rTime : '');
      } else if (plat === 'github-copilot') {
        var cpData = quotasData['github-copilot'];
        var cpQuotas = Array.isArray(cpData && cpData.quotas) ? cpData.quotas : [];
        var pi = cpQuotas.filter(function (q) { return q.name === 'premium_interactions'; })[0];
        var lines = ['平台配额（github-copilot · individual）'];
        if (pi) {
          var rTime = formatResetTime(pi.resetAt);
          lines.push('premium_interactions ' + pi.used + '/' + pi.total + ' · 剩' + pi.remaining + (rTime ? ' · ' + rTime : ''));
        }
        lines.push('chat / completions 不限量');
        return lines.join('\n');
      } else if (plat === 'minimaxcode') {
        var mmData = quotasData.minimaxcode;
        var mmQuotas = Array.isArray(mmData && mmData.quotas) ? mmData.quotas : [];
        var cred = mmQuotas.filter(function (q) { return q.isCreditBalance || q.name === 'Credits'; })[0];
        if (cred) {
          var userStr = mmData.user ? ' (' + mmData.user + ')' : '';
          var planStr = mmData.plan ? ' · ' + mmData.plan : '';
          var lines = ['平台配额（minimaxcode' + userStr + planStr + '）'];
          var rem = cred.remaining != null ? cred.remaining : cred.total;
          var remStr = typeof rem === 'number' ? rem.toFixed(2) : rem;
          lines.push('剩余积分：' + remStr + ' 积分');
          if (cred.used) lines.push('已用积分：' + cred.used);
          return lines.join('\n');
        }
        var lines = ['平台配额（minimaxcode · MiniMax Token Plan）'];
        mmQuotas.forEach(function (q) {
          var remPct = typeof q.remainingPercentage === 'number' ? q.remainingPercentage : 0;
          var wkPct = typeof q.weeklyPercentage === 'number' ? q.weeklyPercentage : 0;
          lines.push((q.displayName || q.name) + ' 本窗口剩' + remPct + '% · 本周剩' + wkPct + '%');
        });
        return lines.join('\n');
      }
      return header + '\n当前平台未接入配额跟踪';
    },
    gear: function () {
      return '自定义状态栏显示项\n点击自由勾选/取消显示各项指标';
    }
  };

  var SB_ITEMS = [
    { key: 'model', label: '当前模型', desc: '显示当前模型名称及运行参数' },
    { key: 'speed', label: '生成速度', desc: '实时生成吞吐速率 (t/s)' },
    { key: 'ctx', label: '上下文占用', desc: '进度条、Token 计数与占用比例' },
    { key: 'turn', label: '本轮消息', desc: '本轮输出 Token 及消息条数' },
    { key: 'sess', label: '会话总计', desc: '当前会话累计消耗 Token' },
    { key: 'today', label: '今日用量', desc: '当日 ↑输入 与 ↓输出 Token' },
    { key: 'quota', label: '剩余配额', desc: '各平台可用积分 / 配额比例' }
  ];

  var SB_DEFAULT_PREFS = {
    model: true,
    speed: true,
    ctx: true,
    turn: true,
    sess: true,
    today: true,
    quota: true
  };

  function getStatusBarPrefs() {
    try {
      var raw = localStorage.getItem('agent_hub_statusbar_prefs');
      if (raw) {
        var p = JSON.parse(raw);
        if (p && typeof p === 'object') {
          return Object.assign({}, SB_DEFAULT_PREFS, p);
        }
      }
    } catch (e) {}
    return Object.assign({}, SB_DEFAULT_PREFS);
  }

  function saveStatusBarPrefs(p) {
    try {
      localStorage.setItem('agent_hub_statusbar_prefs', JSON.stringify(p));
    } catch (e) {}
  }

  function setStatusBarPref(key, val) {
    var p = getStatusBarPrefs();
    p[key] = !!val;
    saveStatusBarPrefs(p);
    updateStatusBar();
    renderStatusBarConfig();
  }

  function applyStatusBarVisibility(quotaHasData) {
    var bar = $('#status-bar');
    if (!bar) return;
    var prefs = getStatusBarPrefs();

    var order = [
      { key: 'model', el: $('#sb-model') },
      { key: 'speed', el: $('#sb-speed') },
      { key: 'ctx', el: $('#sb-ctx') },
      { key: 'turn', el: $('#sb-turn') },
      { key: 'sess', el: $('#sb-sess') },
      { key: 'today', el: $('#sb-today') },
      { key: 'quota', el: $('#sb-quota'), wrap: $('#sb-quota-wrap') }
    ];

    // 先隐藏全部 .cb-status-sep 分隔符
    bar.querySelectorAll('.cb-status-sep').forEach(function (s) { s.style.display = 'none'; });

    var hasPrevVisible = false;
    var visibleCount = 0;

    order.forEach(function (item) {
      var isPrefEnabled = (prefs[item.key] !== false);
      var isVisible = false;

      if (item.key === 'quota') {
        if (isPrefEnabled && quotaHasData) {
          if (item.wrap) item.wrap.hidden = false;
          isVisible = true;
        } else {
          if (item.wrap) item.wrap.hidden = true;
          isVisible = false;
        }
      } else if (item.el) {
        if (isPrefEnabled) {
          item.el.style.display = '';
          isVisible = true;
        } else {
          item.el.style.display = 'none';
          isVisible = false;
        }
      }

      if (isVisible) {
        visibleCount++;
        if (hasPrevVisible) {
          if (item.key === 'quota') {
            var sep = item.wrap ? item.wrap.querySelector('.cb-status-sep') : null;
            if (sep) sep.style.display = '';
          } else if (item.el) {
            var prevNode = item.el.previousElementSibling;
            while (prevNode && !prevNode.classList.contains('cb-status-sep')) {
              prevNode = prevNode.previousElementSibling;
            }
            if (prevNode && prevNode.classList.contains('cb-status-sep')) {
              prevNode.style.display = '';
            }
          }
        }
        hasPrevVisible = true;
      }
    });

    var emptyHint = $('#sb-empty-hint');
    if (visibleCount === 0) {
      if (!emptyHint) {
        emptyHint = el('span', 'cb-status-seg cb-status-empty', '状态栏项目已全部隐藏（点击自定义）');
        emptyHint.id = 'sb-empty-hint';
        emptyHint.style.cursor = 'pointer';
        emptyHint.style.opacity = '0.75';
        bar.appendChild(emptyHint);
      }
      emptyHint.style.display = '';
    } else if (emptyHint) {
      emptyHint.style.display = 'none';
    }
  }

  function renderStatusBarConfig() {
    var panel = $('#status-bar-config-panel');
    if (!panel) return;
    var list = $('#sb-config-list');
    if (!list) return;
    list.innerHTML = '';
    var prefs = getStatusBarPrefs();

    SB_ITEMS.forEach(function (it) {
      var checked = (prefs[it.key] !== false);
      var row = el('label', 'sb-config-row');

      var chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'sb-config-checkbox';
      chk.checked = checked;
      chk.addEventListener('change', function (e) {
        setStatusBarPref(it.key, e.target.checked);
      });

      var info = el('div', 'sb-config-info');
      var label = el('span', 'sb-config-label', it.label);
      var desc = el('span', 'sb-config-desc', it.desc);
      info.appendChild(label);
      info.appendChild(desc);

      row.appendChild(chk);
      row.appendChild(info);
      list.appendChild(row);
    });
  }

  function openStatusBarConfig() {
    var panel = $('#status-bar-config-panel');
    if (!panel) return;
    if (sbTipEl) sbTipEl.style.display = 'none';
    panel.hidden = false;
    renderStatusBarConfig();
    document.addEventListener('click', handleSbConfigClickOutside, true);
    document.addEventListener('keydown', handleSbConfigKeydown, true);
  }

  function closeStatusBarConfig() {
    var panel = $('#status-bar-config-panel');
    if (!panel) return;
    panel.hidden = true;
    document.removeEventListener('click', handleSbConfigClickOutside, true);
    document.removeEventListener('keydown', handleSbConfigKeydown, true);
  }

  function toggleStatusBarConfig(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    var panel = $('#status-bar-config-panel');
    if (panel && !panel.hidden) {
      closeStatusBarConfig();
    } else {
      // 在点击位置上方开面板（水平方向以点击点为中心并做边界钳制）
      if (e && typeof e.clientX === 'number') positionStatusBarConfig(e.clientX);
      openStatusBarConfig();
    }
  }

  function positionStatusBarConfig(clientX) {
    var panel = $('#status-bar-config-panel');
    var wrap = $('#status-bar-wrap');
    if (!panel || !wrap) return;
    var wrapRect = wrap.getBoundingClientRect();
    var panelW = panel.offsetWidth || 290;
    var x = clientX - wrapRect.left - panelW / 2;
    x = Math.max(0, Math.min(x, Math.max(0, wrapRect.width - panelW)));
    panel.style.left = Math.round(x) + 'px';
  }

  function handleSbConfigClickOutside(e) {
    var panel = $('#status-bar-config-panel');
    var bar = $('#status-bar-wrap');
    if (!panel || panel.hidden) return;
    if (!panel.contains(e.target) && (!bar || !bar.contains(e.target))) {
      closeStatusBarConfig();
    }
  }

  function handleSbConfigKeydown(e) {
    if (e.key === 'Escape') {
      closeStatusBarConfig();
    }
  }

  function updateStatusBar() {
    var bar = $('#status-bar');
    if (!bar) return;
    var agent = chat.activeAgent || 'antigravity';
    // 兜底：任何刷新状态栏的路径都同步一次子代理主题色变量
    applyAgentAccent(agent);

    // agent 名已在发送旁模型胶囊（agent/模型名）中呈现，状态栏不再重复；模型块只显示目录展示名
    var sbModel = $('#sb-model');
    if (sbModel) {
      var summaryText = getModelSummaryText(agent);
      sbModel.textContent = summaryText;
      sbModel.removeAttribute('title');
    }

    var st = sbStats(agent);

    var sbSpeed = $('#sb-speed');
    if (sbSpeed) {
      sbSpeed.textContent = (st.tps != null) ? (st.tps.toFixed(1) + ' t/s') : '—';
    }

    var sbCtx = $('#sb-ctx');
    if (sbCtx) {
      var barPct = Math.max(2, Math.min(100, st.pct));
      // 进度条内条颜色跟随所选子代理主题色（原 70%/85% 的蓝-黄-红阈值配色按需求统一为子代理色）
      var barColor = getAgentAccent(agent).color;
      sbCtx.innerHTML = '<span class="sb-cbar"><i style="width:' + barPct + '%;background:' + barColor + '"></i></span>上下文 ' + fmtTok(st.tot) + ' · ' + st.pct + '%';
    }

    var sbTurn = $('#sb-turn');
    if (sbTurn) {
      sbTurn.textContent = '本轮 ' + fmtTok(st.turnOut) + (st.turnN ? ' · ' + st.turnN + ' 条' : '');
    }

    var sbSess = $('#sb-sess');
    if (sbSess) {
      sbSess.textContent = '会话 ' + fmtTok(st.tot);
    }

    var sbToday = $('#sb-today');
    if (sbToday) {
      sbToday.textContent = '今日 ↑' + fmtTok(st.today.in) + ' ↓' + fmtTok(st.today.out);
    }

    var sbQuota = $('#sb-quota');
    var sbQuotaWrap = $('#sb-quota-wrap');
    var quotaShow = false;
    if (sbQuota && sbQuotaWrap) {
      var plat = null;
      if (agent === 'antigravity') plat = 'antigravity';
      else if (agent === 'codebuddy' || agent === 'codebuddy-cn') plat = 'codebuddy';
      else if (agent === 'traecode') plat = 'traecode';
      else if (agent === 'github-copilot') plat = 'github-copilot';
      else if (agent === 'minimaxcode') plat = 'minimaxcode';

      var quotaText = '';
      if (plat && quotasData && quotasData[plat] && !quotasData[plat].error) {
        if (plat === 'codebuddy') {
          var cbData = quotasData.codebuddy;
          var groups = Array.isArray(cbData && cbData.groups) ? cbData.groups : [];
          var targetSource = (agent === 'codebuddy-cn') ? '国内' : '国际';
          var group = groups.filter(function (g) { return g.source === targetSource; })[0];
          if (!group && groups.length) group = groups[0];
          if (group) {
            quotaText = '配额 ' + (group.source || '') + ' ' + fmtTok(group.totalRemaining || 0) + ' 积分';
            quotaShow = true;
          }
        } else if (plat === 'antigravity') {
          var agyData = quotasData.antigravity;
          var qList = Array.isArray(agyData.quotas) ? agyData.quotas : [];
          if (qList.length) {
            var minQ = qList.reduce(function (min, cur) {
              var minPct = typeof min.remainingPercentage === 'number' ? min.remainingPercentage : 100;
              var curPct = typeof cur.remainingPercentage === 'number' ? cur.remainingPercentage : 100;
              return curPct < minPct ? cur : min;
            }, qList[0]);
            var pct = typeof minQ.remainingPercentage === 'number' ? minQ.remainingPercentage : 0;
            quotaText = '配额 剩' + pct + '%';
            quotaShow = true;
          }
        } else if (plat === 'traecode') {
          var traeData = quotasData.traecode;
          var qListTrae = Array.isArray(traeData.quotas) ? traeData.quotas : [];
          if (qListTrae.length) {
            var q0 = qListTrae[0];
            quotaText = '配额 ' + fmtTok(q0.remaining || 0) + ' 积分';
            quotaShow = true;
          }
        } else if (plat === 'github-copilot') {
          var cpData = quotasData['github-copilot'];
          var cpQuotas = Array.isArray(cpData && cpData.quotas) ? cpData.quotas : [];
          var pi = cpQuotas.filter(function (q) { return q.name === 'premium_interactions'; })[0];
          if (pi && !pi.unlimited) {
            var pct = typeof pi.remainingPercentage === 'number' ? pi.remainingPercentage : 0;
            quotaText = '配额 ' + pct + '%';
          } else {
            quotaText = '配额 不限';
          }
          quotaShow = true;
        } else if (plat === 'minimaxcode') {
          var mmData = quotasData.minimaxcode;
          var mmQuotas = Array.isArray(mmData && mmData.quotas) ? mmData.quotas : [];
          var cred = mmQuotas.filter(function (q) { return q.isCreditBalance || q.name === 'Credits'; })[0];
          if (cred) {
            var rem = cred.remaining != null ? cred.remaining : cred.total;
            quotaText = '配额 ' + fmtTok(Math.round(rem || 0)) + ' 积分';
            quotaShow = true;
          } else {
            var gen = mmQuotas.filter(function (q) { return q.name === 'general'; })[0] || mmQuotas[0];
            if (gen) {
              var pct = typeof gen.remainingPercentage === 'number' ? gen.remainingPercentage : 0;
              quotaText = '配额 通用 ' + pct + '%';
              quotaShow = true;
            }
          }
        }
      }
      if (quotaShow) {
        sbQuota.textContent = quotaText;
      }
      if (plat) loadQuotas();
    }

    applyStatusBarVisibility(quotaShow);
  }

  // ---------------- 子代理接入端点展示
  function renderSubagentBox(snap) {
    var host = $('#subagent-box');
    host.textContent = '';
    var sa = snap && snap.subagent;
    if (!sa || !sa.url) {
      host.appendChild(el('div', 'empty', '子代理直通端点未启用（本机 8790-8799 端口全被占用时不会出现）。'));
      return;
    }
    var card = el('div', 'card');
    var line = el('div', 'subagent-line');
    line.style.display = 'flex';
    line.style.alignItems = 'center';
    line.style.gap = '8px';
    line.style.flexWrap = 'wrap';

    line.appendChild(el('span', 'mono', sa.mcp));
    line.appendChild(btn('复制 MCP URL', '', function () {
      copyText(sa.mcp, '已复制：' + sa.mcp);
    }));

    var copyPromptBtn = btn('复制本文（发给Agent配置）', '', function () {
      var agentPrompt = [
        '请帮我配置并接入以下 Multi-Agent Hub 的 HTTP MCP 服务端点：',
        '',
        '【MCP 端点】',
        sa.mcp,
        '',
        '【服务说明与工具】',
        'MCP 工具：subagent_run（派发→服务端等结果→产物落盘→只回摘要） / subagent_result / subagent_artifact / subagent_agents · 健康检查 GET ' + sa.url + '/health · 同步直通 POST ' + sa.url + '/run · v' + (sa.version || '1.0.14'),
        '',
        '把上面 URL 作为 HTTP MCP server 注册给本机 AI 会话后，即可像原生子代理一样直接指挥 traecode / workbuddy / zcode / qwen-work 等全部注册代理，长内容以本机文件形式交付，不进会话上下文。',
        '',
        '【配置参考 (JSON)】',
        '{\n  "mcpServers": {\n    "multi-agent-hub": {\n      "url": "' + sa.mcp + '"\n    }\n  }\n}',
        '',
        '请根据我当前使用的环境（如 Claude Desktop、Cursor、Windsurf、VS Code 或 Antigravity），帮我检查或写入相应的 MCP 配置文件并启用。'
      ].join('\n');
      copyText(agentPrompt, '已复制配置文本，直接发给 Agent 即可帮你配置');
    });
    copyPromptBtn.title = '复制完整配置指令，直接发给 AI Agent 即可帮你自动配置接入';
    line.appendChild(copyPromptBtn);
    card.appendChild(line);
    card.appendChild(el('div', 'subagent-line', 'MCP 工具：subagent_run（派发→服务端等结果→产物落盘→只回摘要） / subagent_result / subagent_artifact / subagent_agents · 健康检查 GET ' + sa.url + '/health · 同步直通 POST ' + sa.url + '/run · v' + sa.version));
    card.appendChild(el('div', 'subagent-line', '把上面 URL 作为 HTTP MCP server 注册给本机 AI 会话后，即可像原生子代理一样直接指挥 traecode / workbuddy / zcode / qwen-work 等全部注册代理，长内容以本机文件形式交付，不进会话上下文。'));
    host.appendChild(card);
  }

  // ---------------- 异步任务轮询
  function addInflight(ref, agent, task) {
    state.inflight.unshift({ ref: ref, agent: agent, task: task.slice(0, 120), status: 'running', text: '', polls: 0, ts: Date.now() });
    state.inflight = state.inflight.slice(0, 20);
    persistInflight();
    renderInflight();
  }
  function persistInflight() {
    try { sessionStorage.setItem('ahc.inflight', JSON.stringify(state.inflight)); } catch (e) { /* 满则忽略 */ }
  }
  function pollInflight() {
    var pending = state.inflight.filter(function (x) { return (x.status === 'running' || x.status === 'pending' || x.status === 'unknown') && x.polls < 140; });
    if (!pending.length) return Promise.resolve();
    return Promise.all(pending.map(function (x) {
      x.polls++;
      return api('/api/result', { ref: x.ref }).then(function (r) {
        x.status = r.status;
        x.text = r.text;
      }).catch(function () { x.status = x.status || 'pending'; });
    })).then(function () {
      persistInflight();
      renderInflight();
    });
  }
  function renderInflight() {
    var host = $('#inflight-list');
    host.textContent = '';
    if (!state.inflight.length) {
      host.appendChild(el('div', 'empty', '暂无异步任务。给配置了 CLI 或 Trae 通道的子代理派活后会出现在这里，每 5 秒自动查询结果。'));
      updateStatusBar();
      return;
    }
    state.inflight.forEach(function (x) {
      var card = el('div', 'card');
      var head = el('div', 'card-head');
      head.appendChild(el('h3', 'mono', x.ref));
      head.appendChild(statusPill(x.status));
      head.appendChild(el('span', 'meta', x.agent + ' · ' + x.task));
      card.appendChild(head);
      var out = el('pre', 'out mono', x.text || '（等待结果落盘…）');
      card.appendChild(out);
      var acts = el('div', 'card-actions');
      acts.appendChild(btn('刷新一次', '', function () { pollInflight(); }));
      acts.appendChild(btn('移除', 'text', function () {
        state.inflight = state.inflight.filter(function (y) { return y.ref !== x.ref; });
        persistInflight(); renderInflight();
      }));
      card.appendChild(acts);
      host.appendChild(card);
    });
    updateStatusBar();
  }
  function statusPill(s) {
    if (s === 'completed') return el('span', 'pill ok', 'completed');
    if (s === 'error' || s === 'failed') return el('span', 'pill err', s);
    if (s === 'running') return el('span', 'pill acc', 'running');
    return el('span', 'pill', s || 'pending');
  }

  // ---------------- 渲染
  function render() {
    var epSel = $('#endpoint');
    var snap = state.snap;
    epSel.textContent = '';
    var eps = (snap && snap.endpoints) || [];
    eps.forEach(function (e) {
      // 端点下拉只显示「本机/服务器」，主机详情放悬停提示
      var host = String(e.host || '');
      var isLocal = /^(localhost|127\.|0\.0\.0\.0|\[?::1)/i.test(host);
      var op = el('option', null, isLocal ? '本机' : '服务器');
      op.value = e.id;
      op.title = (e.label || '') + (e.host ? ' · ' + e.host : '');
      if (snap && e.id === snap.endpoint.id) op.selected = true;
      epSel.appendChild(op);
    });
    // 自定义端点胶囊标签同步（本机/服务器）
    var epLabel = $('#endpoint-label');
    if (epLabel && snap && snap.endpoint) {
      var curEp = eps.find(function (e) { return e.id === snap.endpoint.id; }) || snap.endpoint;
      var curHost = String(curEp.host || '');
      epLabel.textContent = /^(localhost|127\.|0\.0\.0\.0|\[?::1)/i.test(curHost) ? '本机' : '服务器';
      epLabel.title = (curEp.label || '') + (curEp.host ? ' · ' + curEp.host : '');
    }
    var dot = $('#conn-dot');
    dot.className = 'dot' + (snap ? (snap.ok ? ' ok' : ' err') : '');
    dot.title = snap ? (snap.ok ? '枢纽在线 · ' + snap.latencyMs + 'ms' : '枢纽不可达') : '加载中';

    if (state.loading) {
      $('#agents').textContent = '';
      $('#agents').appendChild(el('div', 'skeleton', '正在连接枢纽…'));
      return;
    }
    if (!snap || !snap.ok) {
      renderInflight();
      updateModelSummaryUI();
      return;
    }
    renderKpis(snap);
    renderAgents(snap);
    renderTasks(snap);
    renderNotes(snap);
    renderInflight();
    populateChatTargets();
    renderPlatformList();
    renderSubagentBox(snap);
    var ver = (snap && (snap.version || (snap.subagent && snap.subagent.version))) || '1.0.14';
    var verText = ver.startsWith('v') ? ver : ('v' + ver);
    document.querySelectorAll('.footer-version').forEach(function (fv) { fv.textContent = verText; });
  }

  function renderKpis(snap) {
    // 代理页 KPI 概览已精简隐藏
    var host = $('#kpis');
    if (host) { host.textContent = ''; host.style.display = 'none'; }
  }

  function applyAgentCardFilter() {
    var inp = $('#agent-card-search');
    var kw = (inp && inp.value) ? String(inp.value).trim().toLowerCase() : '';
    var visible = {};
    document.querySelectorAll('#agents .card.uh-card').forEach(function (card) {
      if (!kw) {
        card.style.display = '';
        visible[card.getAttribute('data-worker')] = true;
        return;
      }
      var worker = String(card.getAttribute('data-worker') || '').toLowerCase();
      var text = String(card.textContent || '').toLowerCase();
      var hit = worker.indexOf(kw) >= 0 || text.indexOf(kw) >= 0;
      card.style.display = hit ? '' : 'none';
      if (hit) visible[card.getAttribute('data-worker')] = true;
    });
    // 快速跳转胶囊跟着一起过滤，避免点了跳到一张看不见的卡
    document.querySelectorAll('#qa-agent-tabs .qa-agent-tab').forEach(function (b) {
      var name = b.getAttribute('data-worker');
      b.style.display = (!kw || visible[name]) ? '' : 'none';
    });
  }

  // ---------------- 通用横向滑轨：鼠标拖动 + 松手惯性 + 平滑跳转
  // 两处复用：打卡卡片区（script 2）与子代理卡片区（这里）。挂在 window 上跨 script 共享。
  window.HubRail = window.HubRail || (function () {
    /** 用 easeOutCubic 自己跑动画，比原生 smooth 更可控、更像「丝滑滑过去」 */
    function animate(el, target, duration) {
      if (!el) return;
      var start = el.scrollLeft;
      var delta = target - start;
      if (Math.abs(delta) < 1) return;
      var dur = Math.max(200, Math.min(duration || 480, 760));
      var t0 = performance.now();
      var ease = function (t) { return 1 - Math.pow(1 - t, 3); };
      if (el.__railRaf) cancelAnimationFrame(el.__railRaf);
      var step = function (now) {
        var p = Math.min(1, (now - t0) / dur);
        el.scrollLeft = start + delta * ease(p);
        el.__railRaf = p < 1 ? requestAnimationFrame(step) : 0;
      };
      el.__railRaf = requestAnimationFrame(step);
    }
    /**
     * 把某张卡对齐到目标位置，并保证「滑得到」：
     *   - 默认 slot=1 → 对齐到第二格（第一格留给上一张）
     *   - center:true → 对齐到视口正中（子代理滑轨用）
     *   - loop:true → 越界时用「首尾搬家 + scrollLeft 补偿」补位/腾位
     */
    function alignToSlot(el, card, opts) {
      if (!el || !card) return;
      var o = opts || {};
      var slot = o.slot === undefined ? 1 : o.slot;
      var cs = getComputedStyle(el);
      var gap = parseFloat(cs.columnGap || cs.gap || '0') || 0;
      var step = card.offsetWidth + gap;
      var want = function () {
        if (o.center) return card.offsetLeft - (el.clientWidth - card.offsetWidth) / 2;
        return card.offsetLeft - step * slot;
      };
      var guard = 0;
      if (o.loop) {
        // ① 目标太靠左（前面没卡）→ 从末尾搬卡到最前，位置补偿保证视觉不动
        while (want() < 0 && guard++ < 20) {
          var last = el.lastElementChild;
          if (!last || last === card || last === el.firstElementChild) break;
          var w = last.offsetWidth + gap;
          el.insertBefore(last, el.firstElementChild);
          el.scrollLeft += w;
        }
        // ② 目标太靠右（超出现有滚动范围）→ 把最前面的卡搬到末尾给它腾位置，
        //    否则 animate 到不了目标，scrollLeft 会卡在 max 上（点 Qoder 只走一半就是这个原因）
        var maxScroll = el.scrollWidth - el.clientWidth;
        while (want() > maxScroll && guard++ < 40) {
          var first = el.firstElementChild;
          if (!first || first === card || first === el.lastElementChild) break;
          var w2 = first.offsetWidth + gap;
          el.appendChild(first);
          el.scrollLeft -= w2;
          maxScroll = el.scrollWidth - el.clientWidth;
        }
      }
      animate(el, Math.max(0, want()), o.duration);
    }
    /** 给容器挂上「按住拖动 + 惯性」；点击按钮不会被吃掉 */
    function attach(el, opts) {
      if (!el || el.__railBound) return;
      el.__railBound = true;
      var o = opts || {};
      var dragging = false, moved = false, captured = false;
      var startX = 0, startLeft = 0, lastX = 0, lastT = 0, velocity = 0;
      var raf = 0;
      var stopGlide = function () { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
      el.addEventListener('pointerdown', function (ev) {
        if (ev.pointerType !== 'mouse' || ev.button !== 0) return;
        if (el.__railRaf) { cancelAnimationFrame(el.__railRaf); el.__railRaf = 0; }
        stopGlide();
        dragging = true; moved = false; captured = false;
        startX = lastX = ev.clientX; startLeft = el.scrollLeft;
        lastT = performance.now(); velocity = 0;
      });
      el.addEventListener('pointermove', function (ev) {
        if (!dragging) return;
        var dx = ev.clientX - startX;
        if (!moved && Math.abs(dx) <= 4) return;
        if (!captured) {
          // 关键：真的开始拖了才捕获指针。否则 pointerup 的目标会变成容器，
          // 里面按钮的 click 永远不触发——这就是「点了没反应」的根因。
          moved = true; captured = true;
          el.classList.add('dragging');
          try { el.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
        }
        var now = performance.now();
        var dt = Math.max(1, now - lastT);
        velocity = (ev.clientX - lastX) / dt;
        lastX = ev.clientX; lastT = now;
        el.scrollLeft = startLeft - dx;
        if (ev.cancelable) ev.preventDefault();
      });
      var end = function () {
        if (!dragging) return;
        dragging = false;
        el.classList.remove('dragging');
        // 惯性：按松手瞬间的速度继续滑，指数衰减
        if (moved && Math.abs(velocity) > 0.02) {
          var v = -velocity * 15;
          var glide = function () {
            v *= 0.94;
            el.scrollLeft += v;
            raf = Math.abs(v) > 0.5 ? requestAnimationFrame(glide) : 0;
          };
          raf = requestAnimationFrame(glide);
        }
        if (moved && typeof o.onDragEnd === 'function') o.onDragEnd();
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('pointerleave', function () { if (dragging && !captured) end(); });
      // 拖动结束后吞掉紧随的 click，避免「想滑动却点到了卡片里的按钮」
      el.addEventListener('click', function (ev) {
        if (!moved) return;
        moved = false;
        ev.stopPropagation();
        ev.preventDefault();
      }, true);
    }
    return { attach: attach, animate: animate, alignToSlot: alignToSlot };
  })();

  function renderAgents(snap) {
    var host = $('#agents');
    host.textContent = '';
    if (!snap.agents.length) {
      host.appendChild(el('div', 'empty', '枢纽还没有注册代理。各端调用 hub_heartbeat 后，会以子代理卡片出现在这里。'));
      return;
    }
    var summaryBadge = $('#qaSummaryBadge');
    if (summaryBadge) {
      var onlineCount = snap.agents.filter(function (x) { return !x.disabled && (x.activation === 'online' || (!x.activation && x.online)); }).length;
      var readyCount = snap.agents.filter(function (x) { return !x.disabled && (x.dispatchable || x.activation === 'standby' || x.ready); }).length;
      summaryBadge.textContent = onlineCount + ' 在线 · ' + readyCount + ' 可派发 · 共 ' + snap.agents.length + ' Workers';
    }
    snap.agents.forEach(function (a) {
      var card = el('div', 'card uh-card');
      card.setAttribute('data-worker', a.name);
      var head = el('div', 'card-head');

      var headLeft = el('div', 'uh-head-left');
      var vis = getAgentVisual(a.name);
      var av = el('div', 'platform-avatar');
      av.style.background = vis.bg;
      av.textContent = vis.code;
      av.title = '点击更换 ' + a.name + ' 头像';
      av.addEventListener('click', function () { promptChangeAvatar(a.name); });
      applyAvatar(av, a.name);
      headLeft.appendChild(av);

      var titleStack = el('div', 'uh-title-stack');
      var titleLine = el('div', 'uh-title-line');
      titleLine.appendChild(el('h3', 'mono', a.name));
      if (a.disabled) {
        card.classList.add('disabled-card');
        titleLine.appendChild(el('span', 'pill err', '已禁用'));
      } else if (a.activation === 'online' || (!a.activation && a.online)) {
        titleLine.appendChild(el('span', 'pill ok', '在线'));
      } else if (a.dispatchable || a.activation === 'standby' || a.ready) {
        titleLine.appendChild(el('span', 'pill', '就绪'));
      } else {
        titleLine.appendChild(el('span', 'pill warn', '离线'));
      }
      if (a.name === SELF) titleLine.appendChild(el('span', 'pill acc', '本控制台'));
      var planBadge = el('span', 'qa-plan');
      planBadge.setAttribute('data-plan-for', a.name);
      planBadge.hidden = true;
      titleLine.appendChild(planBadge);
      var accBadge = el('span', 'uh-card-acc-badge');
      accBadge.setAttribute('data-acc-badge-for', a.name);
      accBadge.hidden = true;
      titleLine.appendChild(accBadge);
      titleStack.appendChild(titleLine);

      var roleEl = el('div', 'role', a.role || '未声明角色');
      roleEl.title = a.role || '';
      titleStack.appendChild(roleEl);
      headLeft.appendChild(titleStack);
      head.appendChild(headLeft);

      var headRight = el('div', 'uh-head-right');
      if (a.name !== SELF && a.dispatchable && !a.disabled) {
        var jumpBtn = btn('对话', 'uh-chat-jump-btn', function () {
          var chatTab = $('#tab-chat');
          if (chatTab && !chatTab.classList.contains('active')) {
            chatTab.click();
          }
          selectPlatform(a.name).then(function () {
            var inp = $('#chat-input');
            if (inp) inp.focus();
          });
        });
        jumpBtn.title = '切换到对话面板并与 ' + a.name + ' 对话';
        headRight.appendChild(jumpBtn);
      }
      if (a.name !== SELF) {
        var isEnabled = !a.disabled;
        var toggleWrap = el('label', 'agent-toggle-wrap');
        toggleWrap.title = isEnabled ? '点击停用此子代理（全端及各插件同步生效）' : '点击激活此子代理（全端及各插件同步生效）';
        var toggleInput = document.createElement('input');
        toggleInput.type = 'checkbox';
        toggleInput.className = 'agent-toggle-input';
        toggleInput.checked = isEnabled;
        var toggleSlider = el('span', 'agent-toggle-slider');
        var toggleText = el('span', 'agent-toggle-text mono', isEnabled ? '已启用' : '已停用');
        toggleInput.addEventListener('change', function () {
          var targetEnabled = toggleInput.checked;
          toggleText.textContent = '切换中...';
          toggleInput.disabled = true;
          api('/api/agents/toggle', { agent: a.name, enabled: targetEnabled }).then(function (res) {
            toast(res.message || ('子代理 ' + a.name + (targetEnabled ? ' 已激活' : ' 已停用')));
            pollUpdates();
          }).catch(function (e) {
            toast((e && e.message) || '切换状态失败', true);
            toggleInput.checked = !targetEnabled;
            toggleText.textContent = !targetEnabled ? '已启用' : '已停用';
            toggleInput.disabled = false;
          });
        });
        toggleWrap.appendChild(toggleInput);
        toggleWrap.appendChild(toggleSlider);
        toggleWrap.appendChild(toggleText);
        headRight.appendChild(toggleWrap);
      }

      // 「头像」按钮已移除——直接点左侧头像即可更换，避免重复入口
      head.appendChild(headRight);
      card.appendChild(head);

      // 内嵌配额进度槽位
      var quotaSlot = el('div', 'uh-quota-slot');
      quotaSlot.setAttribute('data-quota-slot', a.name);
      quotaSlot.innerHTML = '<div class="qa-msg"><span class="qa-status-dot"></span><span>实时配额同步中…</span></div>';
      card.appendChild(quotaSlot);

      // 统一模型配置工作台与多账号切换内嵌槽位
      var modelSlot = el('div', 'uh-model-slot');
      modelSlot.setAttribute('data-model-slot', a.name);
      card.appendChild(modelSlot);

      var authSlot = el('div', 'uh-auth-slot');
      authSlot.setAttribute('data-auth-slot', a.name);
      card.appendChild(authSlot);

      var mine = snap.tasks.filter(function (t) { return (t.to === a.name || t.claimedBy === a.name) && (t.status === 'open' || t.status === 'in_progress'); }).length;
      if (mine) card.appendChild(el('div', 'meta', '进行中 / 指派中任务: ' + mine));
      host.appendChild(card);
    });
    if (typeof window.__ahHydrateUnifiedCards === 'function') {
      window.__ahHydrateUnifiedCards();
    }
    renderAgentTabs(snap.agents);
    applyAgentCardFilter();
  }

  // ---- 子代理快速跳转胶囊：一行可滑，点哪个滑轨就滑到那张卡 ----
  function agentCardOf(name) {
    var list = document.querySelectorAll('#agents .card.uh-card');
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].getAttribute('data-worker') === name) return list[i];
    }
    return null;
  }
  function setActiveAgentTab(name) {
    document.querySelectorAll('#qa-agent-tabs .qa-agent-tab').forEach(function (b) {
      var on = b.getAttribute('data-worker') === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    // 选中卡片的顶部配色条：取该子代理的主题色
    var themes = window.AGENT_THEMES || {};
    document.querySelectorAll('#agents .card.uh-card').forEach(function (card) {
      var worker = card.getAttribute('data-worker');
      var on = worker === name;
      card.classList.toggle('is-selected', on);
      if (on) {
        var theme = themes[worker];
        if (theme && theme.color) card.style.setProperty('--card-accent', theme.color);
      }
    });
  }
  var agentRailBusyUntil = 0;
  function jumpToAgent(name) {
    var rail = $('#agents');
    var card = agentCardOf(name);
    if (!rail || !card || card.style.display === 'none') return;
    AGENT_TOUR.pause();
    agentRailBusyUntil = Date.now() + 900; // 程序化滚动期间不搬家
    // 和打卡滑轨同一套手感：目标卡居中，越界时靠搬家补位，所以能一直循环
    window.HubRail.alignToSlot(rail, card, { center: true, loop: true, duration: 520 });
    setActiveAgentTab(name);
  }

  // ---- 子代理滑轨自动巡览：无人操作时缓慢横滑展示各卡；点击/拖动/横滚轮后停 20 秒再恢复 ----
  var AGENT_TOUR = (function () {
    var SPEED_PX_S = 15;   // 「缓慢滑动」一秒 15px，走完一圈要几分钟
    var RESUME_MS = 20000; // 交互后停止 20 秒
    var reduced = false;
    try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* 老浏览器忽略 */ }
    var rail = null;
    var tabs = null;
    var raf = 0;
    var resumeTimer = 0;
    var pausedUntil = 0;
    var lastT = 0;
    var followAt = 0;
    var followedName = '';
    var acc = 0; // Safari/旧 WebKit 对 scrollLeft 赋值取整，0.25px 步进会被吃掉，累计到整像素再走

    function canRun() {
      if (reduced || !rail) return false;
      var panel = $('#panel-agents');
      if (!panel || panel.hidden) return false;   // 设置页子代理选项卡不在前台不巡览
      if (document.hidden) return false;
      if (Date.now() < pausedUntil) return false;
      return rail.scrollWidth > rail.clientWidth + 8; // 卡片装得下就不动
    }
    // 巡览时胶囊条跟着高亮走：把当前居中的那张卡对应的胶囊轻推到胶囊条中间。
    // 目标位用 getBoundingClientRect 相对差算（胶囊条没有 position:relative，offsetLeft 参照系不可靠）。
    function followActiveTab() {
      if (!tabs || tabs.scrollWidth <= tabs.clientWidth + 8) return;
      var pill = tabs.querySelector('.qa-agent-tab.active');
      if (!pill) return;
      var name = pill.getAttribute('data-worker') || '';
      if (!name || name === followedName) return; // 按名字 memo：胶囊每个快照都会重建，节点身份靠不住
      followedName = name;
      var inView = pill.getBoundingClientRect().left - tabs.getBoundingClientRect().left + tabs.scrollLeft;
      var max = tabs.scrollWidth - tabs.clientWidth;
      var target = inView - (tabs.clientWidth - pill.offsetWidth) / 2;
      window.HubRail.animate(tabs, Math.max(0, Math.min(max, target)), 420);
    }
    function step(now) {
      raf = 0;
      if (!canRun()) return;
      var dt = Math.min(120, now - (lastT || now));
      lastT = now;
      acc += SPEED_PX_S * dt / 1000;
      var px = Math.floor(acc);
      if (px > 0) {
        rail.scrollLeft += px;
        acc -= px;
      }
      if (now - followAt > 700) { followAt = now; followActiveTab(); }
      raf = requestAnimationFrame(step);
    }
    function ensure() {
      if (raf || reduced) return;
      lastT = 0;
      raf = requestAnimationFrame(step);
    }
    function pause() {
      if (reduced) return; // reduced 下巡览根本不跑，别白挂 20s 定时器
      pausedUntil = Date.now() + RESUME_MS;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeTimer = setTimeout(function () { resumeTimer = 0; ensure(); }, RESUME_MS + 80);
    }
    function bind() {
      if (rail || reduced) return;
      var r = $('#agents');
      var t = $('#qa-agent-tabs');
      if (!r || !t) return; // 两个都拿到才落引用，半失败状态不能被缓存成「已绑定」
      rail = r;
      tabs = t;
      // 点击卡片、点击/拖动胶囊条、拖动滑轨、横向滚轮（滑轨和胶囊条都要）都算「在看」，立即停下
      rail.addEventListener('pointerdown', pause);
      tabs.addEventListener('pointerdown', pause);
      [rail, tabs].forEach(function (n) {
        n.addEventListener('wheel', function (ev) { if (Math.abs(ev.deltaX) > 0) pause(); }, { passive: true });
      });
      document.addEventListener('visibilitychange', function () { if (!document.hidden) ensure(); });
      document.querySelectorAll('nav.tabs > button[role="tab"]').forEach(function (t2) {
        t2.addEventListener('click', function () { setTimeout(ensure, 0); });
      });
    }
    return { bind: bind, ensure: ensure, pause: pause };
  })();

  function renderAgentTabs(agents) {
    var host = $('#qa-agent-tabs');
    if (!host) return;
    host.textContent = '';
    (agents || []).forEach(function (a) {
      var vis = getAgentVisual(a.name) || {};
      var b = el('button', 'qa-agent-tab');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('data-worker', a.name);
      b.setAttribute('aria-selected', 'false');
      b.title = (a.role || '') + (a.role ? ' · ' : '') + a.name;
      if (vis.color) b.style.setProperty('--tab-accent', vis.color);
      b.appendChild(el('span', 'qa-agent-tab-dot'));
      b.appendChild(document.createTextNode(a.name));
      b.addEventListener('click', function () { jumpToAgent(a.name); });
      host.appendChild(b);
    });
    if (!host.__railBound) window.HubRail.attach(host);
    AGENT_TOUR.bind();
    AGENT_TOUR.ensure();
    // 滑轨本身也挂拖动 + 惯性 + 无限循环；高亮跟随「居中」的那张卡
    var rail = $('#agents');
    if (rail && !rail.__railBound) {
      window.HubRail.attach(rail);
      var raf = 0;
      // 循环：两端各留半张卡的余量，搬家时补偿 scrollLeft，视觉不跳
      var rebalance = function () {
        if (rail.scrollWidth <= rail.clientWidth + 8) return;
        if (rail.classList.contains('dragging')) return;
        if (Date.now() < agentRailBusyUntil) return;
        var gap = parseFloat(getComputedStyle(rail).columnGap || getComputedStyle(rail).gap || '0') || 0;
        var first = rail.firstElementChild;
        var last = rail.lastElementChild;
        if (!first || !last || first === last) return;
        var step = first.offsetWidth + gap;
        var max = rail.scrollWidth - rail.clientWidth;
        var margin = Math.max(24, step * 0.5);
        if (rail.scrollLeft < margin) {
          rail.insertBefore(last, first);
          rail.scrollLeft += last.offsetWidth + gap;
        } else if (rail.scrollLeft > max - margin) {
          rail.appendChild(first);
          rail.scrollLeft -= step;
        }
      };
      // 高亮 = 最靠近视口中心的那张卡（与 jumpToAgent 的居中落点一致）
      var syncActiveFromCenter = function () {
        var center = rail.scrollLeft + rail.clientWidth / 2;
        var best = null, bestDist = Infinity;
        document.querySelectorAll('#agents .card.uh-card').forEach(function (card) {
          if (card.style.display === 'none') return;
          var mid = card.offsetLeft + card.offsetWidth / 2;
          var d = Math.abs(mid - center);
          if (d < bestDist) { bestDist = d; best = card; }
        });
        if (best) setActiveAgentTab(best.getAttribute('data-worker'));
      };
      rail.addEventListener('scroll', function () {
        if (raf) return;
        raf = requestAnimationFrame(function () {
          raf = 0;
          rebalance();
          syncActiveFromCenter();
        });
      }, { passive: true });
      rail.addEventListener('pointerup', function () { setTimeout(rebalance, 0); });
      syncActiveFromCenter();
    }
  }

  function renderTasks(snap) {
    var host = $('#tasks');
    host.textContent = '';
    var tasks = snap.tasks.slice().reverse();
    if (state.taskFilter) tasks = tasks.filter(function (t) { return t.status === state.taskFilter; });
    if (!tasks.length) {
      host.appendChild(el('div', 'empty', snap.taskTotal ? '当前过滤下没有任务（队列共 ' + snap.taskTotal + ' 条）。' : '队列是空的。点「发布任务」投入共享队列，或直接在子代理卡片上「指派任务」。'));
      return;
    }
    var wrap = el('div', 'table-wrap');
    var table = el('table');
    var thead = el('thead');
    var trh = el('tr');
    ['任务 ID', '状态', '标题', '发起 → 指派', '执行', '优先级', '操作'].forEach(function (h) { trh.appendChild(el('th', null, h)); });
    thead.appendChild(trh);
    table.appendChild(thead);
    var tb = el('tbody');
    tasks.forEach(function (t) {
      var tr = el('tr');
      tr.appendChild(el('td', 'mono', t.id));
      var st = el('td');
      st.appendChild(taskPill(t.status));
      tr.appendChild(st);
      tr.appendChild(el('td', null, t.title));
      tr.appendChild(el('td', null, t.from + ' → ' + (t.to || '任意')));
      tr.appendChild(el('td', 'mono', t.claimedBy || '—'));
      tr.appendChild(el('td', null, t.priority));
      var td = el('td');
      if (t.status === 'open') td.appendChild(btn('认领', '', function () { claimTask(t, null); }));
      if (t.status === 'in_progress') {
        td.appendChild(btn('完成', 'primary', function () { completeTask(t, null); }));
        td.appendChild(document.createTextNode(' '));
        td.appendChild(btn('认领', '', function () { claimTask(t, null); }));
      }
      if (t.status === 'done' || t.status === 'failed') td.appendChild(el('span', 'meta', t.status === 'done' ? '已完成' : '已失败'));
      tr.appendChild(td);
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    wrap.appendChild(table);
    host.appendChild(wrap);
    if (snap.taskTotal > snap.tasks.length) host.appendChild(el('div', 'meta', '（队列共 ' + snap.taskTotal + ' 条，枢纽最多返回最近 50 条）'));
  }
  function taskPill(s) {
    if (s === 'open') return el('span', 'pill warn', 'open');
    if (s === 'in_progress') return el('span', 'pill acc', 'in_progress');
    if (s === 'done') return el('span', 'pill ok', 'done');
    if (s === 'failed') return el('span', 'pill err', 'failed');
    return el('span', 'pill', s);
  }

  function renderNotes(snap) {
    var host = $('#notes');
    host.textContent = '';
    if (!snap.notes.length) {
      host.appendChild(el('div', 'empty', '还没有共享笔记。跨代理的项目约定、进度、账号上下文都可以写在这里。'));
      return;
    }
    snap.notes.forEach(function (n) {
      var box = el('div', 'note-item');
      var head = el('header');
      head.appendChild(el('span', 'k mono', n.key));
      head.appendChild(el('span', 'by', 'by ' + n.by));
      box.appendChild(head);
      box.appendChild(el('pre', 'out mono', n.value || '（空）'));
      host.appendChild(box);
    });
  }

  // ---------------- 刷新调度
  var refreshTimer = null;
  function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(loadSnapshot, 400);
  }

  $('#banner-retry').addEventListener('click', function () { loadSnapshot(); });
  $('#endpoint').addEventListener('change', function (ev) {
    api('/api/endpoint', { id: ev.currentTarget.value }).then(loadSnapshot).catch(function (e) { toast(e.message, true); });
  });

  // 端点选择：自定义菜单（与 agent 选择器同风格）
  var epBtn = $('#endpoint-btn');
  var epMenu = $('#endpoint-menu');
  var epHiddenSel = $('#endpoint');
  if (epBtn && epMenu && epHiddenSel) {
    var renderEndpointMenu = function () {
      epMenu.textContent = '';
      var eps = (state.snap && state.snap.endpoints) || [];
      var curId = state.snap && state.snap.endpoint && state.snap.endpoint.id;
      eps.forEach(function (e) {
        var host = String(e.host || '');
        var isLocal = /^(localhost|127\.|0\.0\.0\.0|\[?::1)/i.test(host);
        var item = document.createElement('button');
        item.type = 'button'; item.className = 'export-menu-item';
        var txt = document.createElement('span');
        txt.style.cssText = 'flex:1;min-width:0;text-align:left';
        var nm = document.createElement('div');
        nm.style.cssText = 'font-size:12px;font-weight:600;color:var(--mcode-text)';
        nm.textContent = isLocal ? '本机' : '服务器';
        var hs = document.createElement('div');
        hs.className = 'ep-host';
        hs.textContent = (e.label || '') + (e.host ? ' · ' + e.host : '');
        txt.append(nm, hs);
        item.appendChild(txt);
        if (e.id === curId) {
          var ck = document.createElement('span');
          ck.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
          ck.style.cssText = 'color:#34d399;font-weight:700;display:inline-flex;align-items:center';
          item.appendChild(ck);
        }
        item.addEventListener('click', function (ev) {
          ev.stopPropagation();
          epMenu.hidden = true;
          if (e.id !== curId) {
            epHiddenSel.value = e.id;
            epHiddenSel.dispatchEvent(new Event('change'));
          }
        });
        epMenu.appendChild(item);
      });
      if (!eps.length) epMenu.appendChild(el('div', 'qa-msg', '暂无可用端点'));
    };
    epBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (epMenu.hidden) renderEndpointMenu();
      epMenu.hidden = !epMenu.hidden;
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#endpoint-wrap')) epMenu.hidden = true;
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') epMenu.hidden = true; });
  }
  $('#btn-new-task').addEventListener('click', function (ev) { postTask(ev.currentTarget); });
  $('#btn-new-note').addEventListener('click', function (ev) { writeNote(ev.currentTarget); });
  $('#task-filter').addEventListener('change', function (ev) {
    state.taskFilter = ev.currentTarget.value;
    if (state.snap && state.snap.ok) renderTasks(state.snap);
  });

  // ---------------- 底部捐献与彩蛋
  function triggerDonateEasterEgg() {
    toast('谢谢你，心领了！');
    var oldEgg = document.querySelector('.donate-egg-overlay');
    if (oldEgg && oldEgg.parentNode) oldEgg.parentNode.removeChild(oldEgg);
    var egg = el('div', 'donate-egg-overlay');
    egg.innerHTML = '<div class="donate-egg-box"><div class="donate-egg-heart"><svg width="32" height="32" viewBox="0 0 24 24" fill="#f43f5e"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></div><div class="donate-egg-text">谢谢你，心领了！</div><div class="donate-egg-sub">好好吃饭更重要，去 GitHub 点个 Star 就是最好的支持啦 ~</div></div>';
    document.body.appendChild(egg);
    setTimeout(function () {
      egg.classList.add('fade-out');
      setTimeout(function () { if (egg.parentNode) egg.parentNode.removeChild(egg); }, 500);
    }, 2400);
  }

  document.querySelectorAll('.footer-donate-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var dlg = $('#donate-dialog');
      if (dlg) {
        if (typeof dlg.showModal === 'function') dlg.showModal();
        else dlg.setAttribute('open', '');
      }
    });
  });

  var btnDonateCancel = $('#btn-donate-cancel');
  if (btnDonateCancel) {
    btnDonateCancel.addEventListener('click', function () {
      var dlg = $('#donate-dialog');
      if (dlg) {
        if (typeof dlg.close === 'function') dlg.close();
        else dlg.removeAttribute('open');
      }
    });
  }

  var btnDonateConfirm = $('#btn-donate-confirm');
  if (btnDonateConfirm) {
    btnDonateConfirm.addEventListener('click', function () {
      var dlg = $('#donate-dialog');
      if (dlg) {
        if (typeof dlg.close === 'function') dlg.close();
        else dlg.removeAttribute('open');
      }
      triggerDonateEasterEgg();
    });
  }

  document.querySelectorAll('nav.tabs [role="tab"]').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var isCurrentActive = tab.classList.contains('active');
      document.querySelectorAll('nav.tabs [role="tab"]').forEach(function (t2) {
        t2.setAttribute('aria-selected', t2 === tab ? 'true' : 'false');
        t2.classList.toggle('active', t2 === tab);
      });
      document.querySelectorAll('main section.tabpanel').forEach(function (p) {
        var show = p.id === 'panel-' + tab.id.replace('tab-', '');
        p.classList.toggle('active', show);
        p.hidden = !show;
      });
      // 需求：对话这个侧边栏按钮按下收起或者展开侧边栏
      if (tab.id === 'tab-chat') {
        if (isCurrentActive) {
          togglePlatformsSidebar();
        } else {
          togglePlatformsSidebar(true);
        }
      }
    });
  });

  // SSE + 轮询兜底
  try {
    var es = new EventSource('/api/events');
    es.onmessage = function (e) {
      try {
        var d = JSON.parse(e.data);
        if (d.type === 'hello') {
          if (d.buildId) {
            if (window.__ahBuildId && window.__ahBuildId !== d.buildId) {
              window.location.reload();
              return;
            }
            window.__ahBuildId = d.buildId;
          }
        } else if (d.type === 'changed') refreshSoon();
        else if (d.type === 'chat') onChatEvent(d);
        else if (d.type === 'inbox') { loadThreads(); }
      } catch (err) { /* keepalive */ }
    };
  } catch (e) { /* 老浏览器忽略 */ }
  // 降载：页面隐藏时全部轮询停摆；SSE 在线时服务端 watcher 也会自动放缓
  setInterval(function () { if (document.hidden) return; loadSnapshot(); }, 30000);
  setInterval(function () { if (document.hidden) return; pollInflight(); }, 5000);
  setInterval(function () { if (document.hidden) return; pollUpdates(); }, 8000);
  setInterval(function () { if (document.hidden) return; loadThreads(); }, 45000);
  setInterval(function () { if (document.hidden) return; loadUsage(); }, 60000);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    pollUpdates(); loadThreads(); loadUsage();
  });

  $('#btn-chat-send').addEventListener('click', sendChat);
  $('#chat-input').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) { ev.preventDefault(); sendChat(); }
  });
  $('#chat-input').addEventListener('input', function (ev) {
    ev.target.style.height = 'auto';
    ev.target.style.height = Math.min(ev.target.scrollHeight, 160) + 'px';
  });
  $('#chat-input').addEventListener('paste', function (ev) {
    var items = (ev.clipboardData && ev.clipboardData.items) || [];
    var files = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') { var f = items[i].getAsFile(); if (f) files.push(f); }
    }
    if (files.length) { ev.preventDefault(); addFiles(files); }
  });

  // 现代聊天交互：拖拽上传图片/文件 + 回到底部悬浮按钮 + 快捷键 (⌘K / Ctrl+K / /)
  var chatMsgsEl = $('#chat-msgs');
  var scrollBottomBtn = $('#btn-scroll-bottom');
  if (chatMsgsEl && scrollBottomBtn) {
    chatMsgsEl.addEventListener('scroll', function () {
      var dist = chatMsgsEl.scrollHeight - chatMsgsEl.scrollTop - chatMsgsEl.clientHeight;
      scrollBottomBtn.hidden = dist < 160;
    });
    scrollBottomBtn.addEventListener('click', function () {
      chatMsgsEl.scrollTo({ top: chatMsgsEl.scrollHeight, behavior: 'smooth' });
      scrollBottomBtn.hidden = true;
    });
  }
  [$('#chat-composer'), $('#chat-msgs')].forEach(function (dropZone) {
    if (!dropZone) return;
    dropZone.addEventListener('dragover', function (ev) {
      ev.preventDefault();
      dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', function (ev) {
      if (!dropZone.contains(ev.relatedTarget)) dropZone.classList.remove('drag-over');
    });
    dropZone.addEventListener('drop', function (ev) {
      ev.preventDefault();
      dropZone.classList.remove('drag-over');
      if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) {
        addFiles(ev.dataTransfer.files);
      }
    });
  });
  var agentSearchInp = $('#agent-card-search');
  if (agentSearchInp) {
    agentSearchInp.addEventListener('input', applyAgentCardFilter);
  }
  document.addEventListener('keydown', function (ev) {
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'k' || ev.key === 'K')) {
      ev.preventDefault();
      var agentsPanel = $('#panel-agents');
      if (agentsPanel && !agentsPanel.hidden && agentSearchInp) {
        agentSearchInp.focus();
        agentSearchInp.select();
      } else {
        var ps = $('#platform-search');
        if (ps) { ps.focus(); ps.select(); }
      }
      return;
    }
    var tag = (ev.target && ev.target.tagName) ? ev.target.tagName.toLowerCase() : '';
    if (ev.key === '/' && tag !== 'input' && tag !== 'textarea' && tag !== 'select' && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      var chatPanel = $('#panel-chat');
      var ci = $('#chat-input');
      if (chatPanel && !chatPanel.hidden && ci && !$('#modal').open) {
        ev.preventDefault();
        ci.focus();
      }
    }
  });

  $('#btn-attach').addEventListener('click', function () { $('#file-input').click(); });
  $('#file-input').addEventListener('change', function (ev) { addFiles(ev.target.files); ev.target.value = ''; });
  $('#chat-target').addEventListener('change', populateChatModels);
  $('#chat-mode').addEventListener('change', function (ev) {
    var sel = $('#chat-target');
    if (ev.target.value === 'trae' && !/trae/i.test(sel.value || '')) {
      for (var i = 0; i < sel.options.length; i++) {
        if (/trae/i.test(sel.options[i].value)) { sel.value = sel.options[i].value; break; }
      }
    }
    syncComposer();
  });
  $('#chat-model').addEventListener('change', function (ev) {
    if (ev.target.value) {
      saveAgentPrefs(chat.activeAgent, { model: ev.target.value });
    }
  });
  var mpStream = $('#mp-stream');
  if (mpStream) mpStream.addEventListener('change', function (ev) { saveAgentPrefs(chat.activeAgent, { stream: ev.target.checked }); });
  $('#btn-capability-refresh').addEventListener('click', function () {
    var agent = chat.activeAgent;
    var model = getAgentPrefs(agent).model;
    api('/api/capabilities/refresh', { agent: agent, model: model }).then(function (result) { toast(result.note); return loadSnapshot(); }).catch(function (error) { toast(error.message, true); });
  });
  $('#usage-bar').addEventListener('click', showUsageDetail);
    var modeHelpBtn = $('#btn-mode-help');
  if (modeHelpBtn) modeHelpBtn.addEventListener('click', showModeHelp);

  // 二级模型面板事件绑定
  var mpWrap = $('#model-picker-wrap');
  if (mpWrap) mpWrap.addEventListener('click', function (e) { toggleModelPanel(e, 'right'); });
  var sbModel = $('#sb-model');
  if (sbModel) sbModel.addEventListener('click', function (e) { toggleModelPanel(e, 'left'); });
  var mpClose = $('#mp-close-btn');
  if (mpClose) mpClose.addEventListener('click', closeModelPanel);
  var mpDone = $('#mp-done-btn');
  if (mpDone) mpDone.addEventListener('click', closeModelPanel);
  var mpSearch = $('#mp-search-input');
  if (mpSearch) {
    mpSearch.addEventListener('input', function () {
      var clr = $('#mp-search-clear');
      if (clr) clr.hidden = !mpSearch.value;
      renderModelPanel();
    });
  }
  var mpClr = $('#mp-search-clear');
  if (mpClr) {
    mpClr.addEventListener('click', function () {
      mpSearch.value = '';
      mpClr.hidden = true;
      renderModelPanel();
      mpSearch.focus();
    });
  }

  // 紧凑状态条交互 (独立分段 tooltip)
  var sbTipEl = el('div', 'sb-tip');
  document.body.appendChild(sbTipEl);

  var sbBar = $('#status-bar');
  if (sbBar) {
    sbBar.addEventListener('mouseover', function (e) {
      var target = e.target;
      var seg = target && (target.closest ? target : target.parentElement) ? (target.closest ? target : target.parentElement).closest('[data-sb]') : null;
      if (!seg || !seg.dataset || !seg.dataset.sb || !SB_TIPS[seg.dataset.sb]) {
        sbTipEl.style.display = 'none';
        return;
      }
      var text = SB_TIPS[seg.dataset.sb]();
      if (!text) {
        sbTipEl.style.display = 'none';
        return;
      }
      sbTipEl.textContent = text;
      sbTipEl.style.display = 'block';
      var rect = seg.getBoundingClientRect();
      var w = sbTipEl.offsetWidth;
      var h = sbTipEl.offsetHeight;
      var left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
      var top = rect.top - h - 8;
      if (top < 8) {
        top = rect.bottom + 8;
      }
      sbTipEl.style.left = Math.round(left) + 'px';
      sbTipEl.style.top = Math.round(top) + 'px';
    });

    sbBar.addEventListener('mouseleave', function () {
      sbTipEl.style.display = 'none';
    });

    sbBar.addEventListener('click', function (e) {
      var target = e.target;
      var seg = target && (target.closest ? target : target.parentElement) ? (target.closest ? target : target.parentElement).closest('[data-sb]') : null;
      if (seg && seg.dataset && seg.dataset.sb === 'model') {
        return; // 已由 sbModel 专属监听器处理
      }
      toggleStatusBarConfig(e);
    });

    var sbSelAllBtn = $('#sb-config-select-all');
    if (sbSelAllBtn) {
      sbSelAllBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var p = {};
        SB_ITEMS.forEach(function (it) { p[it.key] = true; });
        saveStatusBarPrefs(p);
        updateStatusBar();
        renderStatusBarConfig();
      });
    }

    var sbResetBtn = $('#sb-config-reset');
    if (sbResetBtn) {
      sbResetBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        saveStatusBarPrefs(Object.assign({}, SB_DEFAULT_PREFS));
        updateStatusBar();
        renderStatusBarConfig();
      });
    }

    var sbCloseBtn = $('#sb-config-close');
    if (sbCloseBtn) {
      sbCloseBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        closeStatusBarConfig();
      });
    }
  }

  // 智能侧栏悬浮收展引擎 (Hover Auto-Expand & Cursor Mouseleave Auto-Collapse)
  var hoverExpandTimer = null;
  var hoverCollapseTimer = null;
  var isPointerInSidebarZone = false;
  var HOVER_EXPAND_DELAY = 180;   // 鼠标移入任务栏/侧栏触发延时 (180ms防误触)
  var HOVER_COLLAPSE_DELAY = 650; // 鼠标移出侧栏平滑收起延时 (650ms防抖缓冲)

  // 展开触发范围 = 「红色框」= 活动栏 + 侧边栏展开后的整块占位宽度，
  // 而不再只是活动栏那一条窄带（原先仅 actBar.right + 14px，鼠标必须贴到最左侧才展开）。
  var SIDEBAR_REVEAL_FALLBACK = 268;   // 与 .cb-platforms-sidebar 的 width: 268px 对齐
  var sidebarRevealWidthCache = SIDEBAR_REVEAL_FALLBACK;
  var lastPointer = { x: -1, y: -1 };

  // 取侧边栏展开宽度：展开时实时量取并缓存，收起时（宽度为 0）用最近一次已知值
  function getSidebarRevealWidth() {
    var sb = $('#chat-threads');
    if (sb && !sb.classList.contains('collapsed')) {
      var w = sb.getBoundingClientRect().width;
      if (w > 0) sidebarRevealWidthCache = w;
    }
    return sidebarRevealWidthCache;
  }

  // 光标是否落在红色框范围内（活动栏 + 侧边栏占位整块）
  function isPointerInRevealZone(x, y) {
    var sb = $('#chat-threads');
    var actBar = $('.cb-activity-bar');
    if (!sb || !actBar) return false;
    var actRect = actBar.getBoundingClientRect();
    var sbRect = sb.getBoundingClientRect();
    var isCollapsed = sb.classList.contains('collapsed');
    var revealRight = actRect.right + getSidebarRevealWidth();
    var inZoneX = isCollapsed ? (x <= revealRight) : (x <= Math.max(sbRect.right, revealRight));
    var inZoneY = (y >= actRect.top && y <= actRect.bottom);
    return inZoneX && inZoneY;
  }

  function isChatTabActive() {
    var chatPanel = $('#panel-chat');
    return chatPanel && chatPanel.classList.contains('active');
  }

  function cancelHoverExpand() {
    if (hoverExpandTimer) { clearTimeout(hoverExpandTimer); hoverExpandTimer = null; }
  }

  function cancelHoverCollapse() {
    if (hoverCollapseTimer) { clearTimeout(hoverCollapseTimer); hoverCollapseTimer = null; }
  }

  function cancelHoverTimers() {
    cancelHoverExpand();
    cancelHoverCollapse();
  }

  function scheduleHoverExpand() {
    if (hoverCollapseTimer) { clearTimeout(hoverCollapseTimer); hoverCollapseTimer = null; }
    if (!chatAutoCollapse || !isChatTabActive()) return;
    var sb = $('#chat-threads');
    if (!sb || !sb.classList.contains('collapsed')) return;
    if (hoverExpandTimer) return;
    hoverExpandTimer = setTimeout(function () {
      hoverExpandTimer = null;
      // 展开前再核对一次：光标确实还在红色框范围内
      if (isPointerInSidebarZone || isPointerInRevealZone(lastPointer.x, lastPointer.y)) {
        togglePlatformsSidebar(true);
      }
    }, HOVER_EXPAND_DELAY);
  }

  function scheduleHoverCollapse() {
    if (hoverExpandTimer) { clearTimeout(hoverExpandTimer); hoverExpandTimer = null; }
    if (!chatAutoCollapse || !isChatTabActive()) return;
    var sb = $('#chat-threads');
    if (!sb || sb.classList.contains('collapsed')) return;
    if (hoverCollapseTimer) return;
    hoverCollapseTimer = setTimeout(function () {
      hoverCollapseTimer = null;
      // 收起前再核对一次：光标仍在红色框范围内（或停在侧栏内）就不收起
      var stillInZone = isPointerInSidebarZone ||
        isPointerInRevealZone(lastPointer.x, lastPointer.y);
      if (!stillInZone) {
        var activeEl = document.activeElement;
        // 只有「正在输入」或「键盘焦点」才保持展开。
        // 旧逻辑用 sb.contains(activeEl) 兜底 → 只要点过一次会话，焦点留在侧栏里，
        // 之后鼠标移开也永远不收起（这就是「不自动收起」的真正原因）。
        var isTyping = !!(activeEl && sb.contains(activeEl) && (
          activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.tagName === 'SELECT' ||
          activeEl.isContentEditable
        ));
        var keyboardFocus = false;
        try {
          keyboardFocus = !!(activeEl && sb.contains(activeEl) &&
            activeEl.matches && activeEl.matches(':focus-visible'));
        } catch (e) { keyboardFocus = false; }
        if (!isTyping && !keyboardFocus) {
          togglePlatformsSidebar(false);
        }
      }
    }, HOVER_COLLAPSE_DELAY);
  }

  // 通用侧栏展开/收起切换
  function togglePlatformsSidebar(forceState) {
    var sb = $('#chat-threads');
    if (!sb) return;
    var willCollapse = (typeof forceState === 'boolean') ? !forceState : !sb.classList.contains('collapsed');
    cancelHoverTimers();
    if (willCollapse) {
      sb.classList.add('collapsed');
    } else {
      sb.classList.remove('collapsed');
    }
    // 对话列表展开时，活动栏（对话 / 设置标签页）必须同时常驻
    chromeSyncActbarWithSidebar();
    // 列表视图隐藏「← 平台」，单行头部里的胶囊要跟着回到最左边
    if (typeof positionPillDock === 'function') {
      if (window.requestAnimationFrame) requestAnimationFrame(positionPillDock);
      else setTimeout(positionPillDock, 0);
    }
  }

  // 跨区域光标进出检测 (涵盖最左侧任务栏与展开后的侧栏)
  function setupSidebarHoverEngine() {
    var actBar = $('.cb-activity-bar');
    var sb = $('#chat-threads');

    function onPointerEnter() {
      isPointerInSidebarZone = true;
      cancelHoverCollapse();
      if (chatAutoCollapse && sb && sb.classList.contains('collapsed')) {
        scheduleHoverExpand();
      }
    }

    function onPointerLeave(e) {
      var toEl = e.relatedTarget;
      if (toEl) {
        if ((actBar && actBar.contains(toEl)) || (sb && sb.contains(toEl))) {
          return;
        }
      }
      isPointerInSidebarZone = false;
      cancelHoverExpand();
      if (chatAutoCollapse && sb && !sb.classList.contains('collapsed')) {
        scheduleHoverCollapse();
      }
    }

    if (actBar) {
      actBar.addEventListener('mouseenter', onPointerEnter);
      actBar.addEventListener('mouseleave', onPointerLeave);
    }
    if (sb) {
      sb.addEventListener('mouseenter', onPointerEnter);
      sb.addEventListener('mouseleave', onPointerLeave);
      sb.addEventListener('focusin', function () {
        cancelHoverCollapse();
        isPointerInSidebarZone = true;
      });
      sb.addEventListener('focusout', function () {
        if (!isPointerInSidebarZone && chatAutoCollapse) {
          scheduleHoverCollapse();
        }
      });
    }

    // 全局边界几何感知检测：无论是否处于CSS过渡期均能无缝追踪光标
    window.addEventListener('mousemove', function (e) {
      lastPointer.x = e.clientX;
      lastPointer.y = e.clientY;
      if (!chatAutoCollapse || !isChatTabActive()) return;
      if (!sb || !actBar) return;
      var isCollapsed = sb.classList.contains('collapsed');

      // 触发范围改为「红色框」：活动栏 + 侧边栏展开后的整块占位宽度
      var currentlyInZone = isPointerInRevealZone(e.clientX, e.clientY);

      if (currentlyInZone) {
        cancelHoverCollapse();
        isPointerInSidebarZone = true;
        if (isCollapsed) {
          scheduleHoverExpand();
        }
      } else {
        cancelHoverExpand();
        isPointerInSidebarZone = false;
        if (!isCollapsed) {
          scheduleHoverCollapse();
        }
      }
    }, { passive: true });
  }
  setupSidebarHoverEngine();

  // ================= 顶栏与活动栏智能收展引擎 (Chrome Auto-Hide Engine) =================
  // 需求：左上角品牌 Logo 常驻锚点永不隐藏；顶栏整行与活动栏整列在无交互时平滑收起进入专注模式。
  // 交互：光标靠近顶部边缘(Y<=38)展开顶栏，靠近左侧边缘(X<=42)展开活动栏；悬浮 Logo 同时展开两者；
  //       离开后 650ms 舒适防抖收起；下拉菜单打开 / 弹窗打开 / 顶栏内有输入焦点时禁止收起；
  //       点击 Logo 切换「自动收展 / 常驻」并持久化。
  var CHROME_EDGE_Y = 38;          // 光标 Y <= 38px 视为命中顶栏边缘
  var CHROME_EDGE_X = 42;          // 光标 X <= 42px 视为命中活动栏边缘
  var CHROME_EXPAND_DELAY = 90;    // 命中边缘后的展开延时（避免过路误触）
  var CHROME_COLLAPSE_DELAY = 650; // 离开后的舒适防抖收起延时
  var CHROME_AUTOHIDE_KEY = 'agent_hub_chrome_autohide';
  var chromeAutoHide = true;
  var chromeHit = { header: false, actbar: false };
  var chromeTimers = { headerExpand: null, headerCollapse: null, actbarExpand: null, actbarCollapse: null };

  try {
    if (localStorage.getItem(CHROME_AUTOHIDE_KEY) === 'false') chromeAutoHide = false;
  } catch (e) { /* ignore */ }

  function chromePinEl() { return document.getElementById('brand-logo-pin'); }
  function chromeHeaderEl() { return document.querySelector('header.top'); }
  function chromeActBarEl() { return document.querySelector('.cb-activity-bar'); }

  // 挂载 Logo 图片：复用顶栏内那一张，避免在 HTML 里重复一份 base64
  (function mountBrandLogoPin() {
    var pin = chromePinEl();
    if (!pin) return;
    var srcImg = document.querySelector('header.top .brand-logo img');
    if (srcImg && !pin.querySelector('img')) {
      var img = srcImg.cloneNode(true);
      img.className = 'brand-logo-img';
      img.setAttribute('alt', 'multi-agent-hub');
      img.removeAttribute('width');
      img.removeAttribute('height');
      pin.appendChild(img);
    }
  })();

  function chromeClearTimer(key) {
    if (chromeTimers[key]) { clearTimeout(chromeTimers[key]); chromeTimers[key] = null; }
  }
  function chromeClearAllTimers() {
    for (var k in chromeTimers) chromeClearTimer(k);
  }

  function chromeIsCollapsed(which) {
    if (which === 'header') {
      var h = chromeHeaderEl();
      return !!(h && h.classList.contains('collapsed-row'));
    }
    var a = chromeActBarEl();
    return !!(a && a.classList.contains('collapsed-col'));
  }

  function chromeSetCollapsed(which, collapsed) {
    if (which === 'header') {
      var h = chromeHeaderEl();
      if (h) h.classList.toggle('collapsed-row', collapsed);
      document.body.classList.toggle('header-collapsed', collapsed);
    } else {
      var a = chromeActBarEl();
      if (a) a.classList.toggle('collapsed-col', collapsed);
      document.body.classList.toggle('actbar-collapsed', collapsed);
    }
  }

  // 手机端布局不同，不做自动收展
  function chromeSupported() { return window.innerWidth > 859; }

  function chromeMenuOpen() {
    var menus = document.querySelectorAll('.export-dropdown-menu, #model-popover-panel, #status-bar-config-panel');
    for (var i = 0; i < menus.length; i++) {
      if (!menus[i].hidden) return true;
    }
    return false;
  }

  function chromeBusy() {
    var modal = document.getElementById('modal');
    if (modal && modal.open) return true;
    if (chromeMenuOpen()) return true;
    var h = chromeHeaderEl();
    var active = document.activeElement;
    if (h && active && h.contains(active)) return true;
    return false;
  }

  // 对话列表（会话侧栏）是否处于展开可见状态
  function chromeSidebarExpanded() {
    var sb = document.getElementById('chat-threads');
    return !!(sb && !sb.classList.contains('collapsed'));
  }

  function chromeCanCollapse(which) {
    if (!chromeAutoHide || !chromeSupported() || chromeBusy()) return false;
    // 对话列表展开时，「对话 / 设置」活动栏必须常驻：
    // 一旦活动栏收起，它那 56px 会被回收，侧栏会整体左移贴到 Logo 锚点下方，
    // 布局会突兀地跳一下；同时用户也就点不到这两个标签页了。
    if (which === 'actbar' && chromeSidebarExpanded()) return false;
    return true;
  }

  // 对话列表一展开，立刻把活动栏拉回来（不等 650ms 防抖，避免闪一下）
  function chromeSyncActbarWithSidebar() {
    if (!chromeAutoHide || !chromeSupported()) return;
    if (!chromeSidebarExpanded()) return;
    chromeClearTimer('actbarCollapse');
    chromeHit.actbar = false;
    chromeSetCollapsed('actbar', false);
  }

  function chromeSchedule(which, expand) {
    var expandKey = which + 'Expand';
    var collapseKey = which + 'Collapse';
    var collapsed = chromeIsCollapsed(which);
    if (expand) {
      chromeClearTimer(collapseKey);
      if (!collapsed || chromeTimers[expandKey]) return;
      chromeTimers[expandKey] = setTimeout(function () {
        chromeTimers[expandKey] = null;
        chromeSetCollapsed(which, false);
      }, CHROME_EXPAND_DELAY);
    } else {
      chromeClearTimer(expandKey);
      if (collapsed || chromeTimers[collapseKey]) return;
      chromeTimers[collapseKey] = setTimeout(function () {
        chromeTimers[collapseKey] = null;
        if (chromeHit[which] || !chromeCanCollapse(which)) return;
        chromeSetCollapsed(which, true);
      }, CHROME_COLLAPSE_DELAY);
    }
  }

  function chromeExpandAll() {
    chromeClearAllTimers();
    chromeSetCollapsed('header', false);
    chromeSetCollapsed('actbar', false);
  }

  function chromeCollapseAll() {
    chromeClearAllTimers();
    chromeSetCollapsed('header', true);
    chromeSetCollapsed('actbar', true);
  }

  function chromeApplyMode() {
    document.body.classList.toggle('chrome-pinned', !chromeAutoHide);
    var pin = chromePinEl();
    if (pin) {
      pin.title = chromeAutoHide
        ? 'multi-agent-hub · 自动收展已开启（光标移到顶部/左侧边缘自动展开，点击切换为常驻）'
        : 'multi-agent-hub · 顶栏与活动栏已常驻（点击切换为自动收展）';
    }
    if (!chromeAutoHide) chromeExpandAll();
  }

  function chromeToggleMode() {
    chromeAutoHide = !chromeAutoHide;
    try { localStorage.setItem(CHROME_AUTOHIDE_KEY, chromeAutoHide ? 'true' : 'false'); } catch (e) { /* ignore */ }
    chromeApplyMode();
    toast(chromeAutoHide
      ? '已开启自动收展：光标移到顶部 / 左侧边缘自动展开，离开后平滑收起'
      : '已切换为常驻模式：顶栏与活动栏保持展开');
  }

  function chromeOnPointerMove(x, y) {
    var h = chromeHeaderEl();
    var a = chromeActBarEl();
    if (!h || !a) return;

    var hRect = h.getBoundingClientRect();
    var aRect = a.getBoundingClientRect();
    // 收起后元素被移出视口（负坐标），因此几何命中会自动失效，仅靠边缘判定展开
    var headerHit = (y <= CHROME_EDGE_Y) ||
      (x >= hRect.left && x <= hRect.right && y >= hRect.top && y <= hRect.bottom);
    var actbarHit = (x <= CHROME_EDGE_X) ||
      (x >= aRect.left && x <= aRect.right && y >= aRect.top && y <= aRect.bottom);

    // 悬浮常驻 Logo 锚点：同时展开顶栏与活动栏
    var pin = chromePinEl();
    if (pin) {
      var pRect = pin.getBoundingClientRect();
      if (x >= pRect.left - 8 && x <= pRect.right + 8 && y >= pRect.top - 8 && y <= pRect.bottom + 8) {
        headerHit = true;
        actbarHit = true;
      }
    }

    chromeHit.header = headerHit;
    chromeHit.actbar = actbarHit;
    chromeSchedule('header', headerHit);
    chromeSchedule('actbar', actbarHit);
  }

  function setupChromeAutoHideEngine() {
    chromeApplyMode();
    // 初始若对话列表已是展开态（例如关闭了自动收起），活动栏也保持常驻
    chromeSyncActbarWithSidebar();

    window.addEventListener('mousemove', function (e) {
      if (!chromeAutoHide) return;
      chromeOnPointerMove(e.clientX, e.clientY);
    }, { passive: true });

    // 失焦 / 尺寸变化时清理定时器，避免状态错乱
    window.addEventListener('blur', chromeClearAllTimers);
    window.addEventListener('resize', function () {
      if (!chromeSupported()) chromeExpandAll();
    });

    var pin = chromePinEl();
    if (pin) {
      pin.addEventListener('click', function (e) {
        e.stopPropagation();
        chromeToggleMode();
      });
      pin.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          chromeToggleMode();
        }
      });
      pin.addEventListener('mouseenter', function () {
        if (!chromeAutoHide) return;
        chromeHit.header = true;
        chromeHit.actbar = true;
        chromeExpandAll();
      });
    }
  }
  setupChromeAutoHideEngine();

  // 会话胶囊停靠层：贴合品牌栏下沿；侧栏收展不影响其位置
  function positionPillDock() {
    var head = document.querySelector('header.top');
    var dock = document.getElementById('pill-dock');
    if (!head || !dock) return;
    var r = head.getBoundingClientRect();
    var dockTop = Math.round(r.bottom + 12);
    // 连接失败横幅出现时会把工作区整体下移，胶囊要跟着让位，否则压住横幅文字
    var banner = document.getElementById('banner');
    if (banner && !banner.hidden) {
      var br = banner.getBoundingClientRect();
      if (br.height > 0) dockTop = Math.max(dockTop, Math.round(br.bottom + 8));
    }
    dock.style.top = dockTop + 'px';
    // 移动端是单行头部：胶囊接在「← 平台」右侧；列表视图返回按钮隐藏时贴左 10px
    if (document.documentElement.getAttribute('data-ui') === 'mobile') {
      var backBtn = document.getElementById('btn-chat-back');
      var backRect = backBtn ? backBtn.getBoundingClientRect() : null;
      var backShown = !!(backRect && backRect.width > 0);
      dock.style.left = Math.round(backShown ? backRect.right + 8 : 10) + 'px';
    } else {
      dock.style.left = '';
    }
    var pill = document.getElementById('current-agent-pill');
    if (pill) {
      var w = Math.round(pill.getBoundingClientRect().width);
      if (w > 0) document.documentElement.style.setProperty('--pill-dock-w', (w + 12) + 'px');
    }
    // 手机端工作台抽屉要让开对话头（头部两行按钮高度随字号/换行浮动），实测后写回变量
    var chatHead = document.querySelector('.chat-head');
    if (chatHead) {
      var h = Math.round(chatHead.getBoundingClientRect().height);
      if (h > 0) document.documentElement.style.setProperty('--chat-head-h', h + 'px');
    }
  }
  positionPillDock();
  window.addEventListener('resize', positionPillDock);
  if (window.ResizeObserver) {
    try {
      var chatHeadForResize = document.querySelector('.chat-head');
      if (chatHeadForResize) new ResizeObserver(positionPillDock).observe(chatHeadForResize);
    } catch (e) { /* noop */ }
  }

  // 非对话页（设置 / 队列 / 笔记）隐藏会话胶囊；:has() 不支持时的兜底
  function syncPillDockVisibility() {
    var dock = document.getElementById('pill-dock');
    if (!dock) return;
    var chatPanel = document.getElementById('panel-chat');
    var visible = !!(chatPanel && chatPanel.classList.contains('active'));
    dock.style.display = visible ? '' : 'none';
  }
  document.addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('.cb-activity-tab')) {
      setTimeout(syncPillDockVisibility, 0);
    }
  });
  syncPillDockVisibility();
  if (window.ResizeObserver) {
    try {
      var pillForResize = document.getElementById('current-agent-pill');
      if (pillForResize) new ResizeObserver(positionPillDock).observe(pillForResize);
    } catch (e) { /* noop */ }
  }

  // 侧栏折叠/展开与返回
  var toggleSidebarBtn = $('#btn-toggle-sidebar-collapse');
  if (toggleSidebarBtn) toggleSidebarBtn.addEventListener('click', function () {
    togglePlatformsSidebar();
  });
  var autoCollapseBtn = $('#btn-auto-collapse-toggle');
  function updateAutoCollapseBtn() {
    if (!autoCollapseBtn) return;
    autoCollapseBtn.classList.toggle('active', !!chatAutoCollapse);
    autoCollapseBtn.style.color = chatAutoCollapse ? 'var(--gem-primary)' : 'var(--gem-text-muted)';
    autoCollapseBtn.title = chatAutoCollapse
      ? '智能悬浮收展 · 已开启：光标移出左侧区域会自动收起（点击改为常驻展开）'
      : '常驻展开 · 已锁定：侧栏不会自动收起（点击恢复智能悬浮收展）';
    autoCollapseBtn.setAttribute('aria-label', chatAutoCollapse ? '智能悬浮收展已开启' : '常驻展开已锁定');
  }
  if (autoCollapseBtn) {
    updateAutoCollapseBtn();
    autoCollapseBtn.addEventListener('click', function () {
      chatAutoCollapse = !chatAutoCollapse;
      try { localStorage.setItem('agent_hub_auto_collapse', chatAutoCollapse ? 'true' : 'false'); } catch (e) {}
      updateAutoCollapseBtn();
      if (!chatAutoCollapse) {
        cancelHoverTimers();
        toast('已锁定为常驻展开：侧栏不再自动收起');
      } else {
        toast('已开启智能悬浮收展：光标移出左侧区域后自动收起');
        // 开启时若光标已在侧栏外，立刻按规则收起，避免"开了却没反应"
        var sbNow = $('#chat-threads');
        if (sbNow && !sbNow.classList.contains('collapsed') &&
            !isPointerInRevealZone(lastPointer.x, lastPointer.y)) {
          scheduleHoverCollapse();
        }
      }
    });
  }
  var toggleAllTreeBtn = $('#btn-toggle-all-tree');
  if (toggleAllTreeBtn) toggleAllTreeBtn.addEventListener('click', function () {
    if (!chat.expandedAgents) chat.expandedAgents = {};
    var list = getPlatformList();
    var anyOpen = list.some(function (a) { return !!chat.expandedAgents[a.name]; });
    var targetState = !anyOpen;
    list.forEach(function (a) { chat.expandedAgents[a.name] = targetState; });
    var host = $('#thread-list');
    if (host && host.querySelectorAll('.platform-group').length) {
      host.querySelectorAll('.platform-group').forEach(function (group) {
        var chevron = group.querySelector('.platform-chevron');
        var tree = group.querySelector('.platform-session-tree');
        if (chevron) {
          chevron.classList.toggle('expanded', targetState);
          chevron.title = targetState ? '收起会话列表' : '展开会话列表';
        }
        if (tree) {
          if (targetState) {
            tree.classList.remove('collapsed');
            tree.classList.add('expanded');
          } else {
            tree.classList.remove('expanded');
            tree.classList.add('collapsed');
          }
        }
      });
    } else {
      renderPlatformList();
    }
    toggleAllTreeBtn.classList.toggle('expanded', targetState);
    toast(targetState ? '已展开所有平台会话' : '已收起所有平台会话');
  });
  var viewArchivesBtn = $('#btn-view-archives');
  if (viewArchivesBtn) viewArchivesBtn.addEventListener('click', function () {
    viewArchivesBtn.classList.remove('pulling');
    void viewArchivesBtn.offsetWidth;
    viewArchivesBtn.classList.add('pulling');
    setTimeout(function () { viewArchivesBtn.classList.remove('pulling'); }, 460);
    openArchivesViewer();
  });

  // 会话筛选与排序漏斗菜单（排序方式：更新时间/创建时间；筛选：全部/仅有消息）
  var sessFilterBtn = $('#btn-session-filter');
  var sessFilterMenu = $('#sess-filter-menu');
  if (sessFilterBtn && sessFilterMenu) {
    function renderSessFilterMenu() {
      sessFilterMenu.textContent = '';
      function secLabel(t) {
        var d = el('div');
        d.textContent = t;
        d.style.cssText = 'font-size:10.5px;color:var(--mcode-text-subtle);padding:6px 10px 2px;font-weight:600';
        return d;
      }
      function mItem(label, active, fn) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'export-menu-item';
        var t = document.createElement('span');
        t.style.cssText = 'flex:1;text-align:left;font-size:12px;color:var(--mcode-text)';
        t.textContent = label;
        var c = document.createElement('span');
        c.style.cssText = 'width:14px;display:inline-flex;align-items:center;justify-content:center;color:#34d399';
        c.innerHTML = active ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' : '';
        b.append(t, c);
        b.onclick = function () { fn(); renderSessFilterMenu(); sessFilterMenu.hidden = true; };
        return b;
      }
      sessFilterMenu.appendChild(secLabel('排序方式'));
      sessFilterMenu.appendChild(mItem('更新时间', chatSessSortMode === 'updated', function () {
        chatSessSortMode = 'updated';
        try { localStorage.setItem('agent_hub_sess_sort', 'updated'); } catch (e) {}
        renderPlatformList();
      }));
      sessFilterMenu.appendChild(mItem('创建时间', chatSessSortMode === 'created', function () {
        chatSessSortMode = 'created';
        try { localStorage.setItem('agent_hub_sess_sort', 'created'); } catch (e) {}
        renderPlatformList();
      }));
      sessFilterMenu.appendChild(el('div', 'head-more-sep'));
      sessFilterMenu.appendChild(secLabel('筛选'));
      sessFilterMenu.appendChild(mItem('全部会话', chatSessFilter === 'all', function () {
        chatSessFilter = 'all';
        try { localStorage.setItem('agent_hub_sess_filter', 'all'); } catch (e) {}
        renderPlatformList();
      }));
      sessFilterMenu.appendChild(mItem('仅有消息', chatSessFilter === 'active', function () {
        chatSessFilter = 'active';
        try { localStorage.setItem('agent_hub_sess_filter', 'active'); } catch (e) {}
        renderPlatformList();
      }));
    }
    renderSessFilterMenu();
    // 菜单右对齐到漏斗按钮；按钮紧贴侧栏左缘时，整块会越过 #chat-threads 的左边界
    // （实测侧栏左缘 56、菜单左缘 49，被 overflow:hidden 裁掉 7px，左边框和圆角都看不见）。
    // 夹取时直接调 right：盒子是 right 锚定的，margin-left 会被约束吸收、推不动它；
    // 也不用 transform，避免和 menuDrop 动画抢同一个属性。
    function clampSessFilterMenu() {
      sessFilterMenu.style.right = '';
      var wrap = sessFilterMenu.parentElement;
      if (!wrap) return;
      var sb = $('#chat-threads');
      var minLeft = (sb ? sb.getBoundingClientRect().left : 0) + 8;
      var menuLeft = wrap.getBoundingClientRect().left + sessFilterMenu.offsetLeft;
      var shift = Math.ceil(minLeft - menuLeft);
      if (shift > 0) sessFilterMenu.style.right = (-shift) + 'px';
    }
    sessFilterBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      sessFilterMenu.hidden = !sessFilterMenu.hidden;
      if (!sessFilterMenu.hidden) clampSessFilterMenu();
      sessFilterBtn.classList.remove('pouring');
      void sessFilterBtn.offsetWidth;
      sessFilterBtn.classList.add('pouring');
      setTimeout(function () { sessFilterBtn.classList.remove('pouring'); }, 420);
    });
    window.addEventListener('resize', function () {
      if (!sessFilterMenu.hidden) clampSessFilterMenu();
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#sess-filter-wrap')) sessFilterMenu.hidden = true;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') sessFilterMenu.hidden = true;
    });
  }

  function openArchivesViewer() {
    // 撤销式删除：点「删除」只做标记，关闭弹层（含点遮罩）时才真正落盘删除
    var pendingDeletes = {};
    $('#modal').classList.add('archive-viewer');
    api('/api/chat/archives').then(function (res) {
      var allArchives = (res && res.archives) || [];
      var searchQuery = '';

      // 获取所有有归档记录的代理列表
      var agentSet = {};
      allArchives.forEach(function (a) { if (a.agent) agentSet[a.agent] = true; });
      var agentList = Object.keys(agentSet).sort();

      var wrapper = el('div', 'archive-modal-wrapper');
      wrapper.style.display = 'flex';
      wrapper.style.flexDirection = 'column';
      wrapper.style.gap = '10px';

      // 顶部工具栏（筛选、搜索、排序）
      var toolbar = el('div', 'archive-toolbar');
      toolbar.style.display = 'flex';
      toolbar.style.alignItems = 'center';
      toolbar.style.justifyContent = 'space-between';
      toolbar.style.gap = '8px';
      toolbar.style.flexWrap = 'wrap';
      toolbar.style.padding = '4px 0 8px 0';
      toolbar.style.borderBottom = '1px solid var(--mcode-border)';

      // 搜索框
      var searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.placeholder = '搜索标题或文件名...';
      searchInput.style.flex = '1';
      searchInput.style.minWidth = '140px';
      searchInput.style.height = '28px';
      searchInput.style.padding = '0 8px';
      searchInput.style.fontSize = '12px';
      searchInput.style.borderRadius = '6px';
      searchInput.style.background = 'var(--mcode-surface-muted, rgba(255,255,255,0.04))';
      searchInput.style.border = '1px solid var(--mcode-border)';
      searchInput.style.color = 'var(--mcode-text)';
      searchInput.addEventListener('input', function (e) {
        searchQuery = e.target.value.trim().toLowerCase();
        renderList();
      });

      // 平台筛选已并入漏斗菜单的「视图 · 按项目」分组
      var agentSelect = null;

      // 排序选择
      var sortSelect = document.createElement('select');
      sortSelect.style.display = 'none';

      // 筛选+排序 单漏斗图标（菜单：视图 按项目/时间线 · 排序方式 更新时间/创建时间）
      var viewMode = 'agent';   // 'agent'(按项目) | 'timeline'(时间线)
      var sortMode = 'updated'; // 'updated'(更新时间) | 'created'(创建时间)
      var filterWrap = el('div', 'export-dropdown-wrap');
      filterWrap.style.position = 'relative';
      var funnelBtn = document.createElement('button');
      funnelBtn.type = 'button';
      funnelBtn.className = 'archive-filter-btn icon-toggle-btn';
      funnelBtn.title = '筛选与排序';
      funnelBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>';
      var filterMenu = el('div', 'export-dropdown-menu');
      filterMenu.hidden = true;
      filterMenu.style.minWidth = '190px';

      function sectionLabel(text) {
        var d = el('div');
        d.textContent = text;
        d.style.cssText = 'font-size:10.5px;color:var(--mcode-text-subtle);padding:6px 10px 2px;font-weight:600';
        return d;
      }
      function menuItem(label, active, onClick) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'export-menu-item';
        var t = document.createElement('span');
        t.style.cssText = 'flex:1;text-align:left;font-size:12px;color:var(--mcode-text)';
        t.textContent = label;
        var c = document.createElement('span');
        c.style.cssText = 'width:14px;display:inline-flex;align-items:center;justify-content:center;color:#34d399';
        c.innerHTML = active ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' : '';
        b.append(t, c);
        b.onclick = function () { onClick(); renderFilterMenu(); filterMenu.hidden = true; };
        return b;
      }
      function renderFilterMenu() {
        filterMenu.textContent = '';
        filterMenu.appendChild(sectionLabel('视图'));
        filterMenu.appendChild(menuItem('按项目', viewMode === 'agent', function () { viewMode = 'agent'; renderList(); }));
        filterMenu.appendChild(menuItem('时间线', viewMode === 'timeline', function () { viewMode = 'timeline'; renderList(); }));
        filterMenu.appendChild(el('div', 'head-more-sep'));
        filterMenu.appendChild(sectionLabel('排序方式'));
        filterMenu.appendChild(menuItem('更新时间', sortMode === 'updated', function () { sortMode = 'updated'; renderList(); }));
        filterMenu.appendChild(menuItem('创建时间', sortMode === 'created', function () { sortMode = 'created'; renderList(); }));
      }
      renderFilterMenu();
      funnelBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        filterMenu.hidden = !filterMenu.hidden;
      });
      document.addEventListener('click', function (e) {
        if (!filterWrap.contains(e.target)) filterMenu.hidden = true;
      });
      filterWrap.appendChild(funnelBtn);
      filterWrap.appendChild(filterMenu);

      toolbar.appendChild(searchInput);
      toolbar.appendChild(filterWrap);
      wrapper.appendChild(toolbar);

      // 列表容器
      var listContainer = el('div', 'archive-modal-content');
      listContainer.style.maxHeight = '380px';
      listContainer.style.overflowY = 'auto';
      listContainer.style.display = 'flex';
      listContainer.style.flexDirection = 'column';
      listContainer.style.gap = '8px';
      listContainer.style.padding = '4px 0';
      wrapper.appendChild(listContainer);

      function renderList() {
        listContainer.textContent = '';
        var filtered = allArchives.filter(function (a) {
          if (searchQuery) {
            var matchTitle = String(a.title || '').toLowerCase().indexOf(searchQuery) >= 0;
            var matchAgent = String(a.agent || '').toLowerCase().indexOf(searchQuery) >= 0;
            var matchFile = String(a.file || '').toLowerCase().indexOf(searchQuery) >= 0;
            if (!matchTitle && !matchAgent && !matchFile) return false;
          }
          return true;
        });

        // 排序方式：更新时间 / 创建时间（均倒序）
        filtered.sort(function (a, b) {
          var av = sortMode === 'created' ? (a.created || a.updated || 0) : (a.updated || 0);
          var bv = sortMode === 'created' ? (b.created || b.updated || 0) : (b.updated || 0);
          return bv - av;
        });

        if (!filtered.length) {
          var empty = el('div', 'empty', '无匹配的归档会话记录');
          empty.style.padding = '32px 0';
          listContainer.appendChild(empty);
          return;
        }

        function appendArchiveRow(arch) {
          var row = el('div', 'archive-item-row');
          if (pendingDeletes[arch.file]) {
            row.style.opacity = '0.42';
            row.style.textDecoration = 'line-through';
          }
          row.style.display = 'flex';
          row.style.alignItems = 'center';
          row.style.justifyContent = 'space-between';
          row.style.padding = '8px 12px';
          row.style.borderRadius = '8px';
          row.style.background = 'var(--mcode-surface-muted, rgba(255,255,255,0.04))';
          row.style.border = '1px solid var(--mcode-border)';
          row.style.gap = '10px';

          var info = el('div');
          info.style.minWidth = '0';
          info.style.flex = '1';
          var titleLine = el('div');
          titleLine.style.fontWeight = '500';
          titleLine.style.fontSize = '13px';
          titleLine.style.color = 'var(--mcode-text)';
          titleLine.textContent = '[' + (arch.agent || '未知') + '] ' + (arch.title || '归档会话');
          var metaLine = el('div');
          metaLine.style.fontSize = '11px';
          metaLine.style.color = 'var(--mcode-text-subtle)';
          metaLine.style.marginTop = '2px';
          metaLine.textContent = (arch.msgCount || 0) + '条消息 · 归档时间: ' + (arch.updated ? new Date(arch.updated).toLocaleString() : '未知');
          info.appendChild(titleLine);
          info.appendChild(metaLine);
          row.appendChild(info);

          var actions = el('div', 'archive-item-actions');
          actions.style.display = 'flex';
          actions.style.alignItems = 'center';
          actions.style.gap = '6px';
          actions.style.flexShrink = '0';

          var viewBtn = btn('查看', 'small', function () {
            api('/api/artifact?path=' + encodeURIComponent('data/archives/' + arch.file)).then(function (art) {
              try {
                var sessObj = JSON.parse(art.text);
                var msgsText = (sessObj.messages || []).map(function (m) {
                  return '[' + (m.role === 'me' ? '我' : (m.role === 'sys' ? '系统' : arch.agent)) + '] ' + (m.text || '');
                }).join('\n\n---\n\n');
                showSyncResult(arch.agent + ' · ' + (arch.title || '归档会话'), msgsText || '该会话无消息记录');
              } catch (e) {
                showSyncResult(arch.agent, art.text);
              }
            }).catch(function (err) { toast(err.message, true); });
          });

          var restoreBtn = btn('复原', 'small primary', function () {
            withBusy(restoreBtn, function () {
              return api('/api/chat/restore-archive', { file: arch.file }).then(function (res) {
                toast('会话已复原');
                allArchives = allArchives.filter(function (x) { return x.file !== arch.file; });
                $('#modal-title').textContent = '全部归档会话 (' + allArchives.length + ')';
                renderList();
                renderHeadActions();
                chat.activeAgent = arch.agent;
                chat.activeSessionId = arch.id;
                loadThreads();
                selectPlatform(arch.agent, arch.id);
              }).catch(function (err) {
                toast('复原失败: ' + err.message, true);
              });
            });
          });

          var deleteBtn = btn('删除', 'small danger', function () {
            pendingDeletes[arch.file] = true;
            renderList();
            renderHeadActions();
            toast('已标记删除 · 点「撤销」可恢复；关闭面板后生效');
          });

          actions.appendChild(viewBtn);
          actions.appendChild(restoreBtn);
          actions.appendChild(deleteBtn);
          row.appendChild(actions);
          listContainer.appendChild(row);
        }

        if (viewMode === 'agent') {
          // 视图 · 按项目：按 agent 分组，组标题带数量
          var groups = {};
          filtered.forEach(function (a) {
            var k = a.agent || '未知';
            (groups[k] = groups[k] || []).push(a);
          });
          Object.keys(groups).sort().forEach(function (ag) {
            var hdr = el('div');
            hdr.innerHTML = '<span style="display:inline-flex;align-items:center;gap:5px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' + esc(ag) + ' (' + groups[ag].length + ')</span>';
            hdr.style.cssText = 'font-size:11.5px;font-weight:600;color:var(--mcode-text-subtle);padding:6px 2px 0;border-top:1px solid var(--mcode-border);margin-top:2px';
            listContainer.appendChild(hdr);
            groups[ag].forEach(appendArchiveRow);
          });
        } else {
          // 视图 · 时间线：平铺
          filtered.forEach(appendArchiveRow);
        }
      }

      function renderHeadActions() {
        var headActions = $('#modal-head-actions');
        if (!headActions) return;
        headActions.textContent = '';
        if (!allArchives.length) return;

        var delAllBtn = btn('一键删除', 'danger small', function () {
          headActions.textContent = '';
          var confirmPrompt = el('span', null, '确定全删？');
          confirmPrompt.style.fontSize = '12px';
          confirmPrompt.style.color = 'var(--mcode-danger, #f85149)';
          confirmPrompt.style.fontWeight = '500';

          var confirmBtn = btn('确认删除', 'danger small', function () {
            allArchives.forEach(function (a) { pendingDeletes[a.file] = true; });
            renderList();
            renderHeadActions();
            toast('已全部标记删除 · 关闭面板后生效');
          });

          var cancelBtn = btn('取消', 'small', function () {
            renderHeadActions();
          });

          headActions.appendChild(confirmPrompt);
          headActions.appendChild(confirmBtn);
          headActions.appendChild(cancelBtn);
        });

        headActions.appendChild(delAllBtn);
      }

      renderList();
      renderHeadActions();

      $('#modal-title').textContent = '全部归档会话 (' + allArchives.length + ')';
      var form = $('#modal-form');
      form.textContent = '';
      form.appendChild(wrapper);
      $('#modal-err').style.display = 'none';
      $('#modal-ok').textContent = '关闭';
      modalResolver = { resolve: function () {}, inputs: {}, form: form };

      // 「取消」在归档面板内改为「撤销」：有标记时恢复列表；无标记时保持原关闭行为
      var cancelBtnEl = $('#modal-cancel');
      var prevCancelText = cancelBtnEl.textContent;
      cancelBtnEl.textContent = '撤销';
      var undoHandler = function (e) {
        if (Object.keys(pendingDeletes).length) {
          e.stopImmediatePropagation();
          e.preventDefault();
          pendingDeletes = {};
          renderList();
          renderHeadActions();
          toast('已撤销删除');
        }
      };
      cancelBtnEl.addEventListener('click', undoHandler, true);

      // 关闭（含点遮罩、Esc、关闭按钮）时才提交待删除
      var commitPendingDeletes = function () {
        cancelBtnEl.textContent = prevCancelText;
        cancelBtnEl.removeEventListener('click', undoHandler, true);
        $('#modal').classList.remove('archive-viewer');
        var files = Object.keys(pendingDeletes);
        if (!files.length) return;
        Promise.all(files.map(function (f) {
          return api('/api/chat/delete-archive', { file: f }).catch(function () {});
        })).then(function () {
          toast('已删除 ' + files.length + ' 个归档会话');
        });
      };
      $('#modal').addEventListener('close', commitPendingDeletes, { once: true });

      $('#modal').showModal();
    }).catch(function (err) {
      $('#modal').classList.remove('archive-viewer');
      toast('获取归档列表失败: ' + err.message, true);
    });
  }

  $('#btn-chat-back').addEventListener('click', function () {
    togglePlatformsSidebar(true);
  });

  // 搜索平台过滤
  var searchInput = $('#platform-search');
  if (searchInput) searchInput.addEventListener('input', function (ev) {
    chat.platformFilter = ev.target.value;
    renderPlatformList();
  });

  // 独立会话搜索过滤
  var sessSearchInput = $('#session-search-input');
  if (sessSearchInput) sessSearchInput.addEventListener('input', function (ev) {
    chat.sessionFilter = ev.target.value;
    renderSessionList();
  });
  var sessSearchClearBtn = $('#btn-session-search-clear');
  if (sessSearchClearBtn) sessSearchClearBtn.addEventListener('click', function () {
    if (sessSearchInput) sessSearchInput.value = '';
    chat.sessionFilter = '';
    renderSessionList();
    if (sessSearchInput) sessSearchInput.focus();
  });
  var btnSessionNew = $('#btn-session-new');
  if (btnSessionNew) btnSessionNew.addEventListener('click', createNewChatSession);

  // 历史会话下拉切换
  var sessSelect = $('#chat-session-select');
  if (sessSelect) sessSelect.addEventListener('change', function (ev) {
    var sid = ev.target.value;
    if (sid && chat.activeAgent) {
      selectPlatform(chat.activeAgent, sid);
    }
  });

  // 会话选择：自定义菜单（与 agent 选择器同风格）
  var sessPillEl = $('#session-selector-pill');
  var sessPickerMenu = $('#session-picker-menu');
  var sessHiddenSel = $('#chat-session-select');
  if (sessPillEl && sessPickerMenu) {
    var renderSessionPicker = function () {
      sessPickerMenu.textContent = '';
      var sessions = chat.sessions || [];
      if (!sessions.length) {
        sessPickerMenu.appendChild(el('div', 'qa-msg', '暂无会话'));
        return;
      }
      sessions.forEach(function (sess) {
        var item = document.createElement('button');
        item.type = 'button'; item.className = 'export-menu-item';
        var t = el('span', 'sp-title', sess.title || '新会话');
        t.style.cssText = 'flex:1;min-width:0;text-align:left;font-size:12px;color:var(--mcode-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        item.appendChild(t);
        var cnt = el('span', 'sp-count', (sess.msgCount || 0) + '条');
        item.appendChild(cnt);
        if (sess.id === chat.activeSessionId) {
          var ck = document.createElement('span');
          ck.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
          ck.style.cssText = 'color:#34d399;font-weight:700;display:inline-flex;align-items:center';
          item.appendChild(ck);
        }
        item.addEventListener('click', function (e) {
          e.stopPropagation();
          sessPickerMenu.hidden = true;
          if (sess.id !== chat.activeSessionId && chat.activeAgent) selectPlatform(chat.activeAgent, sess.id);
        });
        sessPickerMenu.appendChild(item);
      });
    };
    sessPillEl.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = sessPickerMenu.hidden;
      closeOtherPickerMenus(sessPickerMenu);
      if (willOpen) {
        renderSessionPicker();
        bringToFront(sessPickerMenu);
        sessPickerMenu.hidden = false;
      } else {
        sessPickerMenu.hidden = true;
      }
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#session-selector-pill')) sessPickerMenu.hidden = true;
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') sessPickerMenu.hidden = true; });
  }

  // 弹窗层级管理（后打开的选项页排在先打开的上面）与互斥关闭
  var popupZIndex = 1100;
  function bringToFront(menuEl) {
    if (menuEl) {
      popupZIndex += 2;
      menuEl.style.zIndex = popupZIndex;
    }
  }
  function closeOtherPickerMenus(except) {
    if (agentPickerMenu && agentPickerMenu !== except) agentPickerMenu.hidden = true;
    if (sessPickerMenu && sessPickerMenu !== except) sessPickerMenu.hidden = true;
    if (headMoreMenu && headMoreMenu !== except) headMoreMenu.hidden = true;
  }

  // 一体胶囊：点头像打开子代理切换菜单
  var agentAvatarBtn = $('#current-avatar-sm');
  var agentPickerMenu = $('#agent-picker-menu');
  if (agentAvatarBtn && agentPickerMenu) {
    var renderAgentPicker = function () {
      agentPickerMenu.textContent = '';
      var agents = (state.snap && state.snap.agents) || [];
      agents.forEach(function (a) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'export-menu-item';
        var vis = getAgentVisual(a.name);
        var av = el('span', 'agent-avatar-sm');
        av.style.background = vis.bg;
        av.textContent = vis.code;
        applyAvatar(av, a.name);
        var nm = el('span', 'apk-name', a.name);
        item.append(av, nm);
        if (a.name === chat.activeAgent) {
          var ck = document.createElement('span');
          ck.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
          ck.style.cssText = 'color:#34d399;font-weight:700;display:inline-flex;align-items:center';
          item.appendChild(ck);
        }
        item.addEventListener('click', function (e) {
          e.stopPropagation();
          agentPickerMenu.hidden = true;
          if (a.name !== chat.activeAgent) selectPlatform(a.name);
        });
        agentPickerMenu.appendChild(item);
      });
      if (!agents.length) {
        agentPickerMenu.appendChild(el('div', 'qa-msg', '暂无子代理'));
      }
    };
    agentAvatarBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = agentPickerMenu.hidden;
      closeOtherPickerMenus(agentPickerMenu);
      if (willOpen) {
        renderAgentPicker();
        bringToFront(agentPickerMenu);
        agentPickerMenu.hidden = false;
      } else {
        agentPickerMenu.hidden = true;
      }
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#current-agent-pill')) agentPickerMenu.hidden = true;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') agentPickerMenu.hidden = true;
    });
  }

  // 新建对话
  function createNewChatSession() {
    var agentName = chat.activeAgent;
    if (!agentName) { toast('请先选择一个平台', true); return; }
    api('/api/chat/new-session', { agent: agentName }).then(function (r) {
      chat.full[agentName] = r.thread;
      chat.activeSessionId = r.activeSessionId;
      chat.sessions = r.sessions || [];
      renderSessionList();
      renderThreadView();
      loadThreads();
      $('#chat-input').focus();
      toast('已开启新对话');
    }).catch(function (e) { toast(e.message, true); });
  }
  $('#btn-new-chat').addEventListener('click', createNewChatSession);

  // 清空当前对话
  var clearBtn = $('#btn-chat-clear');
  if (clearBtn) clearBtn.addEventListener('click', function () {
    if (!chat.activeAgent) return;
    var msgs = (chat.full[chat.activeAgent] && chat.full[chat.activeAgent].messages) || [];
    if (!msgs.length) { toast('当前会话暂无消息记录'); return; }
    if (!confirm('确定清空当前会话“' + (chat.activeAgent || '') + '”的所有消息吗？\n清空后将无法恢复。如需备份，建议先点击【导出】。')) return;
    api('/api/chat/clear', { agent: chat.activeAgent, sessionId: chat.activeSessionId }).then(function () {
      if (chat.full[chat.activeAgent]) chat.full[chat.activeAgent].messages = [];
      renderThreadView();
      loadThreads();
      renderWorkbench();
      toast('当前对话已清空');
    }).catch(function (e) { toast(e.message, true); });
  });

  // 「⋯」更多操作菜单（新建 / 清空 / 导出 统一收口，提升对话信息密度）
  var headMoreBtn = $('#btn-head-more');
  var headMoreMenu = $('#head-more-menu');
  if (headMoreBtn && headMoreMenu) {
    headMoreBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = headMoreMenu.hidden;
      closeOtherPickerMenus(headMoreMenu);
      if (willOpen) {
        bringToFront(headMoreMenu);
        headMoreMenu.hidden = false;
      } else {
        headMoreMenu.hidden = true;
      }
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#head-more-wrap')) {
        headMoreMenu.hidden = true;
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') headMoreMenu.hidden = true;
    });
    headMoreMenu.addEventListener('click', function (e) {
      if (e.target.closest('button')) headMoreMenu.hidden = true;
    });
  }

  function getExportBaseName() {
    var ag = chat.activeAgent || 'chat';
    var sid = (chat.activeSessionId || 'default').slice(0, 16);
    var d = new Date();
    var ts = d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2) + '_' + ('0' + d.getHours()).slice(-2) + ('0' + d.getMinutes()).slice(-2);
    return ag + '_' + sid + '_' + ts;
  }

  function buildChatMarkdown(agent, thread) {
    var title = (thread && thread.title) || '会话';
    var d = new Date();
    var timeStr = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    var out = ['# ' + agent + ' · ' + title, ''];
    out.push('> 导出时间: ' + timeStr + ' | 平台: ' + agent + ' | 会话 ID: ' + (chat.activeSessionId || (thread && thread.id) || 'default'));
    out.push('');
    out.push('---');
    out.push('');
    var msgs = (thread && Array.isArray(thread.messages)) ? thread.messages : [];
    msgs.forEach(function (m) {
      if (!m) return;
      var speaker = m.role === 'me' ? 'User' : (m.role === 'agent' ? agent : 'System');
      var ts = m.ts ? threadMeta(m.ts) : '';
      out.push('### ' + speaker + (ts ? ' (' + ts + ')' : ''));
      out.push('');
      out.push(m.text || '');
      out.push('');
    });
    return out.join('\n');
  }

  function downloadBlob(content, filename, mimeType) {
    var blob = new Blob([content], { type: mimeType || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  var btnExportMd = $('#btn-export-markdown');
  if (btnExportMd) btnExportMd.addEventListener('click', function () {
    if (headMoreMenu) headMoreMenu.hidden = true;
    if (!chat.activeAgent) { toast('请先选择一个平台', true); return; }
    var t = chat.full[chat.activeAgent];
    var mdText = buildChatMarkdown(chat.activeAgent, t);
    var fn = getExportBaseName() + '.md';
    downloadBlob(mdText, fn, 'text/markdown;charset=utf-8');
    api('/api/chat/export', { agent: chat.activeAgent, sessionId: chat.activeSessionId }).then(function (r) {
      if (!chat.localArtifacts) chat.localArtifacts = [];
      chat.localArtifacts.unshift({ kind: 'artifact', name: fn, path: r.path, text: mdText, ts: Date.now(), source: chat.activeAgent });
      renderWorkbench();
    }).catch(function () {});
    toast('已导出 Markdown 并开始下载');
  });

  var btnExportJson = $('#btn-export-json');
  if (btnExportJson) btnExportJson.addEventListener('click', function () {
    if (headMoreMenu) headMoreMenu.hidden = true;
    if (!chat.activeAgent) { toast('请先选择一个平台', true); return; }
    var t = chat.full[chat.activeAgent] || {};
    var fn = getExportBaseName() + '.json';
    downloadBlob(JSON.stringify(t, null, 2), fn, 'application/json');
    toast('已导出 JSON 数据并开始下载');
  });

  var btnExportCopy = $('#btn-export-copy');
  if (btnExportCopy) btnExportCopy.addEventListener('click', function () {
    if (headMoreMenu) headMoreMenu.hidden = true;
    if (!chat.activeAgent) { toast('请先选择一个平台', true); return; }
    var t = chat.full[chat.activeAgent];
    var mdText = buildChatMarkdown(chat.activeAgent, t);
    copyText(mdText, '当前会话 Markdown 已复制到剪贴板');
  });

  // 工作台展开 / 收起
  var wbCloseBtn = $('#wb-close');
  if (wbCloseBtn) wbCloseBtn.addEventListener('click', function () {
    try { localStorage.setItem('agent_hub_wb_mode', 'closed'); } catch (e) {}
    renderWorkbench();
  });
  var wbToggleBtn = $('#btn-workbench-toggle');
  if (wbToggleBtn) wbToggleBtn.addEventListener('click', function () {
    var panel = $('#workbench');
    var isHidden = !panel || !panel.classList.contains('open');
    try { localStorage.setItem('agent_hub_wb_mode', isHidden ? 'open' : 'closed'); } catch (e) {}
    renderWorkbench();
  });

  document.querySelectorAll('nav.tabs [role="tab"]').forEach(function (tab) {
    if (tab.id === 'tab-chat') tab.addEventListener('click', function () { loadThreads(); loadUsage(); updateStatusBar(); });
  });

  loadSnapshot().then(function () { renderInflight(); loadThreads(); updateStatusBar(); updateModelSummaryUI(); });
  loadUsage().then(updateStatusBar);
  loadQuotas().then(function () { renderPlatformList(); });
  loadAvatars();
  loadAgentSummaries();
  window.__ahToast = toast;
  window.__ahLoadSnapshot = loadSnapshot;
})();
