(() => {
  const grid = document.getElementById('qaGrid');
  const esc = (s) => String(s ?? '');
  const pctColor = (p) => (p >= 99.5 ? ' full' : p >= 80 ? ' warn' : '');
  const shortTime = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : ` ${d.getMonth()+1}/${d.getDate()}`; };
  let quotaData = null, accountData = null, modelsData = null;
  const jpost = (u, b) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json());
  const notify = (msg, isErr = false) => (typeof window.__ahToast === 'function' ? window.__ahToast(msg, isErr) : window.alert(msg));

  // 账号隐私脱敏与加密防护：只显示头 2 位与后 2 位（中间 ***）
  // 只有「像标识符」的串才打码：邮箱本地部分、UID/AK 前缀、长 ID 串。
  // 用户自己起的别名、含中文或空格的展示名一律原样显示 —— 之前把「siliconflow」打成「si***ow」、
  // 把「(2 个提供方)」打成「(2 ***供方)」就是这条规则的锅。
  function looksLikeIdentifier(s) {
    if (!s) return false;
    if (String(s).includes('@')) return true;
    if (!/^[\x20-\x7e]+$/.test(String(s))) return false;   // 含中文/全角 → 给人看的名字
    if (/\s/.test(String(s))) return false;                 // 有空格 → 短语而非 ID
    if (/^(UID|AK|SK)[:：\s]/i.test(String(s))) return true;
    return /^[A-Za-z0-9._-]{12,}$/.test(String(s));         // 长标识符（指纹、token 片段）
  }

  function maskPart(s) {
    if (!s) return '';
    s = String(s).trim();
    if (!looksLikeIdentifier(s)) return s;
    if (s.length <= 2) return s[0] + '***' + (s[1] || '');
    if (s.length <= 4) return s.slice(0, 1) + '***' + s.slice(-1);
    return s.slice(0, 2) + '***' + s.slice(-2);
  }

  function maskAccount(raw) {
    if (!raw) return '';
    var str = String(raw).trim();
    var paren = str.match(/^([^(（]+)[(（]([^()（）]+)[)）]$/);
    if (paren) return maskAccount(paren[1].trim()) + ' (' + maskAccount(paren[2].trim()) + ')';
    var pfx = str.match(/^(UID[:：\s]*|AK[:：\s]*|小米\s*UID[:：\s]*|mimo-|trae-|cb-|cb-cn-|ak-|zcode-)(.+)$/i);
    if (pfx && looksLikeIdentifier(str)) return pfx[1] + maskPart(pfx[2]);
    if (str.includes('@')) {
      var parts = str.split('@');
      return maskPart(parts[0]) + '@' + parts.slice(1).join('@');
    }
    return maskPart(str);
  }

  function maskMessageText(text) {
    if (!text) return '';
    var out = String(text);
    out = out.replace(/([a-zA-Z0-9_.+-]+)@([a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)/g, function (m, u, d) { return maskPart(u) + '@' + d; });
    out = out.replace(/(小米\s*UID[:：\s]*|UID[:：\s]*)(\d{4,})/gi, function (m, pfx, uid) { return pfx + maskPart(uid); });
    out = out.replace(/([A-Za-z0-9]{2,8})(?:…|\.{2,3})([A-Za-z0-9]{2,8})/g, function (m, h, t) { return h.slice(0, 2) + '***' + t.slice(-2); });
    out = out.replace(/(账号[:：\s]+)([^\s()（）·,，;；]{3,})/gi, function (m, pfx, u) { return pfx + maskAccount(u); });
    return out;
  }

  function bar(name, q) {
    const row = document.createElement('div'); row.className = 'qa-row';
    const head = document.createElement('div'); head.className = 'qa-qname';
    const left = document.createElement('span'); const right = document.createElement('span');
    let pct = null;
    if (typeof q.remainingPercentage === 'number') pct = 100 - q.remainingPercentage;
    else if (q.total > 0) pct = (q.used / q.total) * 100;
    const fmtNum = (v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toFixed(2)) : v);
    const label = q.unlimited ? '不限量' : (q.total > 0 ? `${fmtNum(q.used)}/${fmtNum(q.total)}` : '—');
    left.textContent = name;
    right.textContent = label + (q.recurring === false ? shortTime(q.resetAt) : (q.resetAt ? ` ↻${shortTime(q.resetAt)}` : ''));
    head.append(left, right);
    const bar = document.createElement('div'); bar.className = 'qa-bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.max(2, Math.min(100, pct ?? 100))}%`;
    fill.className = pctColor(pct ?? 0);
    bar.appendChild(fill);
    row.append(head, bar);
    return row;
  }

  function sectionTitle(text) {
    const el = document.createElement('div');
    el.className = 'qa-section-title';
    el.textContent = text;
    return el;
  }

  function qaBtn(text, cls) {
    const b = document.createElement('button');
    b.className = cls ? `qa-btn ${cls}` : 'qa-btn';
    b.type = 'button';
    b.textContent = text;
    return b;
  }

  // 全局点击外部关闭模型下拉菜单
  if (!window.__uhMpOutsideBound) {
    window.__uhMpOutsideBound = true;
    document.addEventListener('click', (ev) => {
      document.querySelectorAll('.uh-mp-wrap.open').forEach((w) => {
        if (!w.contains(ev.target)) {
          w.classList.remove('open');
          const c = w.closest('.uh-card');
          if (c) c.classList.remove('uh-dropdown-open');
        }
      });
    });
  }

  const expandedPillsWorkers = new Set();

  function modelRow(worker) {
    const mw = (modelsData && modelsData.workers && modelsData.workers[worker]) || null;
    const wrap = document.createElement('div'); wrap.className = 'qa-section';
    if (!mw) return wrap;

    const allModels = Array.isArray(mw.models) ? mw.models : [];
    const curDefaultId = mw.default || (allModels.find((m) => m.isDefault) || allModels[0] || {}).id || '';
    const curModel = allModels.find((m) => m.id === curDefaultId || m.alias === curDefaultId)
      || (curDefaultId ? { alias: curDefaultId, id: curDefaultId, name: curDefaultId, credits: null, tag: null } : { alias: '', id: '', name: '(系统默认)', credits: null, tag: null });
    let ctxBarRef = null;

    function switchDefault(targetKey, displayName) {
      if (!targetKey || targetKey === curDefaultId) return;
      // 乐观更新：立即刷新触发器文字与上下文胶囊选中态，后台再持久化
      curNameEl.textContent = displayName || targetKey;
      if (curIdEl) curIdEl.textContent = targetKey;
      if (ctxBarRef) {
        const targetModel = allModels.find((m) => m.id === targetKey || m.alias === targetKey);
        const targetCtx = (targetModel && targetModel.ctx) || '';
        for (const pill of ctxBarRef.querySelectorAll('.uh-ctx-pill')) {
          pill.classList.toggle('active', !!targetCtx && pill.textContent === targetCtx);
        }
      }
      jpost('/api/models/default', { worker, alias: targetKey })
        .then((r) => {
          notify(r.ok ? `${worker} 默认模型已切换为 ${displayName || targetKey}` : `失败: ${r.error || '?'}`, !r.ok);
          if (typeof window.__ahLoadSnapshot === 'function') window.__ahLoadSnapshot();
          load(); // 后台确认重绘；失败时以服务端状态回滚
        })
        .catch((e) => { notify(`失败: ${e.message || '?'}`, true); load(); });
    }

    // 1. 顶部标题栏：模型配置 + 数量徽章 + 「+自定义模型」按钮
    const head = document.createElement('div'); head.className = 'qa-section-title';
    const headLeft = document.createElement('div'); headLeft.className = 'uh-mp-head-left';
    const titleSpan = document.createElement('span'); titleSpan.textContent = '模型配置';
    const countBadge = document.createElement('span'); countBadge.className = 'uh-mp-count';
    countBadge.textContent = `${allModels.length} 款可选`;
    headLeft.append(titleSpan, countBadge);

    const addToggleBtn = document.createElement('button');
    addToggleBtn.type = 'button';
    addToggleBtn.className = 'uh-mp-add-btn';
    addToggleBtn.textContent = '+ 自定义模型';
    head.append(headLeft, addToggleBtn);
    wrap.appendChild(head);

    // 2. 暗色毛玻璃自定义下拉选择器
    const mpWrap = document.createElement('div'); mpWrap.className = 'uh-mp-wrap';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'uh-mp-trigger';
    trigger.title = '点击展开完整模型目录并切换默认模型';

    const trigLeft = document.createElement('div'); trigLeft.className = 'uh-mp-trigger-left';
    const starBadge = document.createElement('span'); starBadge.className = 'uh-mp-star'; starBadge.textContent = '默认';
    const curNameEl = document.createElement('span'); curNameEl.className = 'uh-mp-cur-name'; curNameEl.textContent = curModel.name || curModel.id || '(未设置)';
    trigLeft.append(starBadge, curNameEl);
    let curIdEl = null;
    if (curModel.id && curModel.name && curModel.id !== curModel.name) {
      curIdEl = document.createElement('span'); curIdEl.className = 'uh-mp-cur-id'; curIdEl.textContent = curModel.id;
      trigLeft.appendChild(curIdEl);
    }

    const trigRight = document.createElement('div'); trigRight.className = 'uh-mp-trigger-right';
    if (curModel.credits) {
      const cb = document.createElement('span'); cb.className = 'uh-mp-badge credits'; cb.textContent = curModel.credits;
      trigRight.appendChild(cb);
    }
    if (curModel.tag) {
      const tb = document.createElement('span'); tb.className = 'uh-mp-badge tag'; tb.textContent = curModel.tag;
      trigRight.appendChild(tb);
    }
    const caret = document.createElement('span'); caret.className = 'uh-mp-caret'; caret.textContent = '▾';
    trigRight.appendChild(caret);
    trigger.append(trigLeft, trigRight);

    const dropdown = document.createElement('div'); dropdown.className = 'uh-mp-dropdown';
    let searchInput = null;
    if (allModels.length > 5) {
      searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.className = 'uh-mp-search';
      searchInput.placeholder = `搜索 ${worker} 的 ${allModels.length} 款模型名称或 ID…`;
      dropdown.appendChild(searchInput);
    }

    const listEl = document.createElement('div'); listEl.className = 'uh-mp-list';
    function renderDropdownItems(filterText) {
      listEl.textContent = '';
      const q = String(filterText || '').trim().toLowerCase();
      const filtered = allModels.filter((m) => {
        if (!q) return true;
        return String(m.name || '').toLowerCase().includes(q)
          || String(m.id || '').toLowerCase().includes(q)
          || String(m.alias || '').toLowerCase().includes(q)
          || (Array.isArray(m.aliases) && m.aliases.some((a) => String(a).toLowerCase().includes(q)));
      });
      if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'qa-msg';
        empty.style.padding = '6px 8px';
        empty.textContent = '未匹配到模型，可点击右上角「+ 自定义模型」添加';
        listEl.appendChild(empty);
        return;
      }
      for (const m of filtered) {
        const isAct = (m.id && m.id === curDefaultId) || (m.alias && m.alias === curDefaultId) || !!m.isDefault;
        const item = document.createElement('div');
        item.className = 'uh-mp-item' + (isAct ? ' is-active' : '');

        const itemLeft = document.createElement('div'); itemLeft.className = 'uh-mp-item-left';
        const titleRow = document.createElement('div'); titleRow.className = 'uh-mp-item-title';
        const nameEl = document.createElement('span'); nameEl.className = 'uh-mp-item-name';
        nameEl.textContent = (isAct ? '[默认] ' : '') + (m.name || m.id);
        titleRow.appendChild(nameEl);
        if (Array.isArray(m.aliases) && m.aliases.length) {
          for (const al of m.aliases.slice(0, 3)) {
            if (al !== m.id && al !== m.name) {
              const ab = document.createElement('span');
              const removable = Array.isArray(m.removableAliases) && m.removableAliases.includes(al);
              ab.className = 'uh-mp-badge alias' + (removable ? ' removable' : '');
              ab.textContent = removable ? `${al} ×` : al;
              if (removable) {
                ab.title = `点击删除别名 ${al}（仅移除该别名映射，不影响内置模型）`;
                ab.onclick = async (ev) => {
                  ev.stopPropagation();
                  if (!window.confirm(`删除 ${worker} 的模型别名「${al}」？（内置模型本身保留）`)) return;
                  const r = await jpost('/api/models/remove', { worker, alias: al });
                  notify(r.ok ? `已删除别名 ${al}` : `失败: ${r.error || '?'}`, !r.ok);
                  if (typeof window.__ahLoadSnapshot === 'function') await window.__ahLoadSnapshot();
                  load();
                };
              }
              titleRow.appendChild(ab);
            }
          }
        }
        itemLeft.appendChild(titleRow);
        if (m.id && m.id !== m.name) {
          const subEl = document.createElement('div'); subEl.className = 'uh-mp-item-sub'; subEl.textContent = m.id;
          itemLeft.appendChild(subEl);
        }

        const itemRight = document.createElement('div'); itemRight.className = 'uh-mp-item-right';
        if (m.credits) {
          const cb = document.createElement('span'); cb.className = 'uh-mp-badge credits'; cb.textContent = m.credits;
          itemRight.appendChild(cb);
        }
        if (m.tag) {
          const tb = document.createElement('span'); tb.className = 'uh-mp-badge tag'; tb.textContent = m.tag;
          itemRight.appendChild(tb);
        }
        if (m.custom) {
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'uh-mp-del';
          delBtn.textContent = '删除';
          delBtn.title = `删除自定义模型 ${m.alias}`;
          delBtn.onclick = async (ev) => {
            ev.stopPropagation();
            if (!window.confirm(`删除 ${worker} 的自定义模型「${m.alias}」？`)) return;
            const r = await jpost('/api/models/remove', { worker, alias: m.alias });
            notify(r.ok ? `已删除自定义模型 ${m.alias}` : `失败: ${r.error || '?'}`, !r.ok);
            if (typeof window.__ahLoadSnapshot === 'function') await window.__ahLoadSnapshot();
            load();
          };
          itemRight.appendChild(delBtn);
        }

        item.append(itemLeft, itemRight);
        item.onclick = () => {
          mpWrap.classList.remove('open');
          const parentCard = mpWrap.closest('.uh-card');
          if (parentCard) parentCard.classList.remove('uh-dropdown-open');
          switchDefault(m.id || m.alias, m.name || m.id);
        };
        listEl.appendChild(item);
      }
    }
    renderDropdownItems('');
    if (searchInput) {
      searchInput.addEventListener('input', () => renderDropdownItems(searchInput.value));
      searchInput.addEventListener('click', (ev) => ev.stopPropagation());
    }
    dropdown.appendChild(listEl);

    trigger.onclick = (ev) => {
      ev.stopPropagation();
      const willOpen = !mpWrap.classList.contains('open');
      document.querySelectorAll('.uh-mp-wrap.open').forEach((w) => {
        w.classList.remove('open');
        const c = w.closest('.uh-card');
        if (c) c.classList.remove('uh-dropdown-open');
      });
      if (willOpen) {
        mpWrap.classList.add('open');
        const parentCard = mpWrap.closest('.uh-card');
        if (parentCard) parentCard.classList.add('uh-dropdown-open');
        if (searchInput) {
          searchInput.value = '';
          renderDropdownItems('');
          setTimeout(() => searchInput.focus(), 20);
        }
      }
    };

    mpWrap.append(trigger, dropdown);
    wrap.appendChild(mpWrap);

    // 2.5 上下文档位分段选择器（仅当该 worker 有多档内置上下文的模型时出现，当前仅 MiniMax：512K=M3.1-Flash-Preview / 1M=M3）
    const ctxGroups = new Map();
    for (const m of allModels) {
      if (!m.custom && m.ctx) {
        if (!ctxGroups.has(m.ctx)) ctxGroups.set(m.ctx, []);
        ctxGroups.get(m.ctx).push(m);
      }
    }
    if (ctxGroups.size >= 2) {
      const ctxBar = document.createElement('div'); ctxBar.className = 'uh-ctx-bar';
      ctxBarRef = ctxBar;
      const ctxLabel = document.createElement('span'); ctxLabel.className = 'uh-ctx-label';
      ctxLabel.textContent = '上下文';
      ctxLabel.title = '选择上下文窗口档位（对应官方模型能力，切换即改默认模型）';
      ctxBar.appendChild(ctxLabel);
      const curCtx = (allModels.find((m) => m.id === curDefaultId || m.alias === curDefaultId) || {}).ctx || '';
      for (const [ctxVal, models] of [...ctxGroups.entries()].sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'uh-ctx-pill' + (ctxVal === curCtx ? ' active' : '');
        pill.textContent = ctxVal;
        const target = models.find((m) => m.isDefault) || models[0];
        pill.title = `${ctxVal} 上下文 → ${target.name || target.id}`;
        pill.onclick = () => {
          if (ctxVal === curCtx) return;
          // 乐观选中：点击立即变绿，后台持久化
          for (const x of ctxBar.querySelectorAll('.uh-ctx-pill')) x.classList.remove('active');
          pill.classList.add('active');
          switchDefault(target.id, `${target.name || target.id}（${ctxVal} 上下文）`);
        };
        ctxBar.appendChild(pill);
      }
      wrap.appendChild(ctxBar);
    }

    // 3. 快捷模型胶囊栏（一键点击即切换默认模型，超 5 款可展开/收起）
    if (allModels.length > 0) {
      const pillsWrap = document.createElement('div'); pillsWrap.className = 'uh-mp-pills';
      const PILL_LIMIT = 5;
      const isExpanded = expandedPillsWorkers.has(worker);
      // 确保当前默认模型始终排在可见区域前列
      const sortedForPills = [...allModels].sort((a, b) => {
        const aDef = (a.id === curDefaultId || a.isDefault) ? 1 : 0;
        const bDef = (b.id === curDefaultId || b.isDefault) ? 1 : 0;
        return bDef - aDef;
      });
      const visibleModels = isExpanded ? sortedForPills : sortedForPills.slice(0, PILL_LIMIT);
      for (const m of visibleModels) {
        const isDef = (m.id && m.id === curDefaultId) || !!m.isDefault;
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'uh-mp-pill' + (isDef ? ' is-default' : '');
        pill.title = `${m.name || m.id} (${m.id})${m.credits ? ' · ' + m.credits : ''}${m.tag ? ' · ' + m.tag : ''}\n点击直接设为 ${worker} 默认模型`;
        const txt = document.createElement('span'); txt.className = 'uh-mp-pill-text';
        txt.textContent = (isDef ? '[默认] ' : '') + (m.name || m.id);
        pill.appendChild(txt);
        if (m.credits) {
          const cr = document.createElement('span'); cr.className = 'uh-mp-pill-credit'; cr.textContent = m.credits;
          pill.appendChild(cr);
        }
        pill.onclick = () => switchDefault(m.id || m.alias, m.name || m.id);
        pillsWrap.appendChild(pill);
      }
      if (allModels.length > PILL_LIMIT) {
        const moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'uh-mp-more';
        moreBtn.textContent = isExpanded ? '收起 ▴' : `+${allModels.length - PILL_LIMIT} 款更多 ▾`;
        moreBtn.onclick = () => {
          if (expandedPillsWorkers.has(worker)) expandedPillsWorkers.delete(worker);
          else expandedPillsWorkers.add(worker);
          hydrateAllUnifiedCards();
        };
        pillsWrap.appendChild(moreBtn);
      }
      wrap.appendChild(pillsWrap);
    }

    // 4. 内联自定义模型抽屉（告别生硬的 window.prompt 弹窗）
    const customForm = document.createElement('div'); customForm.className = 'uh-mp-custom-form';
    const inputRow = document.createElement('div'); inputRow.className = 'uh-mp-custom-row';
    const aliasInput = document.createElement('input');
    aliasInput.className = 'qa-input';
    aliasInput.placeholder = '别名 (如 gpt-max)';
    const idInput = document.createElement('input');
    idInput.className = 'qa-input';
    idInput.placeholder = '真实模型 ID (发给 CLI)';
    inputRow.append(aliasInput, idInput);

    const formBtns = document.createElement('div'); formBtns.className = 'qa-rowbtns';
    const saveSetBtn = qaBtn('添加并设默认', 'qa-primary');
    const saveOnlyBtn = qaBtn('仅添加');
    const cancelBtn = qaBtn('取消');

    async function submitCustom(alsoSetDefault) {
      const alias = aliasInput.value.trim();
      const id = idInput.value.trim();
      if (!alias || !id) { notify('请填写自定义模型别名与真实模型 ID', true); return; }
      const r = await jpost('/api/models/custom', { worker, alias, id });
      if (!r.ok) { notify(`添加失败: ${r.error || '?'}`, true); return; }
      if (alsoSetDefault) {
        await jpost('/api/models/default', { worker, alias });
      }
      notify(alsoSetDefault ? `已添加 ${alias} 并设为 ${worker} 默认模型` : `已添加自定义模型 ${alias}`);
      customForm.classList.remove('open');
      if (typeof window.__ahLoadSnapshot === 'function') await window.__ahLoadSnapshot();
      load();
    }
    saveSetBtn.onclick = () => submitCustom(true);
    saveOnlyBtn.onclick = () => submitCustom(false);
    cancelBtn.onclick = () => { customForm.classList.remove('open'); };
    addToggleBtn.onclick = () => {
      customForm.classList.toggle('open');
      if (customForm.classList.contains('open')) setTimeout(() => aliasInput.focus(), 20);
    };

    formBtns.append(saveSetBtn, saveOnlyBtn, cancelBtn);
    customForm.append(inputRow, formBtns);
    wrap.appendChild(customForm);

    return wrap;
  }

  // 注入暗色毛玻璃 OAuth 登录弹窗与账号管理样式
  if (!document.getElementById('uh-auth-modal-styles')) {
    const st = document.createElement('style');
    st.id = 'uh-auth-modal-styles';
    st.textContent = `
      .uh-acc-status-pill {
        display: inline-flex; align-items: center; gap: 4px;
        font-size: 10.5px; font-weight: 600; padding: 1.5px 8px; border-radius: 999px;
      }
      .uh-acc-status-pill.ok {
        background: rgba(16, 185, 129, 0.12); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.28);
      }
      .uh-acc-status-pill.warn {
        background: rgba(245, 158, 11, 0.12); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.28);
      }
      .uh-acc-chips-wrap {
        display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 6px 0 8px;
      }
      .uh-acc-chip {
        display: inline-flex; align-items: center; gap: 6px; padding: 4px 11px;
        background: var(--gem-surface-low); border: 1px solid var(--gem-border);
        border-radius: 999px; font-size: 11.5px; color: var(--gem-text); cursor: pointer;
        transition: all .15s ease; user-select: none;
      }
      .uh-acc-chip:hover {
        border-color: var(--gem-primary); background: var(--gem-surface-high); color: var(--gem-text); transform: translateY(-1px);
      }
      .uh-acc-chip.active {
        background: rgba(16, 185, 129, 0.12); border-color: rgba(16, 185, 129, 0.45);
        color: #10b981; font-weight: 600; cursor: default; transform: none;
        box-shadow: 0 0 8px rgba(16, 185, 129, 0.18);
      }
      .uh-acc-chip-dot {
        width: 7px; height: 7px; border-radius: 50%; background: var(--gem-text-muted); flex-shrink: 0;
      }
      .uh-acc-chip.active .uh-acc-chip-dot {
        background: #10b981; box-shadow: 0 0 6px #10b981;
      }
      .uh-acc-chip-sub {
        font-size: 10px; opacity: 0.75; font-weight: 400; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .uh-acc-chip-badge {
        font-size: 10px; padding: 1px 5px; border-radius: 4px;
        background: rgba(16, 185, 129, 0.18); color: #10b981; font-weight: 600;
      }
      .uh-acc-chip-del {
        display: inline-flex; align-items: center; justify-content: center;
        width: 15px; height: 15px; border-radius: 4px; margin-left: 2px;
        color: var(--gem-text-muted); font-size: 11px; cursor: pointer; transition: all .12s ease;
      }
      .uh-acc-chip-del:hover {
        background: rgba(239, 68, 68, 0.22); color: #ef4444;
      }
      /* 同一份凭据的旧快照：可切换但视觉上弱化，避免被误认成第二个账号 */
      .uh-acc-chip.stale {
        opacity: 0.62; border-style: dashed;
      }
      .uh-acc-chip.stale:hover { opacity: 0.9; }
      .uh-acc-chip.stale .uh-acc-chip-dot { background: var(--gem-text-muted); box-shadow: none; }
      .uh-acc-chip-stale-tag {
        font-size: 10px; padding: 1px 5px; border-radius: 4px;
        background: rgba(148, 163, 184, 0.2); color: var(--gem-text-secondary); font-weight: 500;
      }
      .uh-acc-chip-save {
        border-style: dashed; color: var(--gem-text-secondary); font-weight: 500;
      }
      .uh-acc-chip-save:hover {
        border-color: #10b981; color: #10b981; background: rgba(16, 185, 129, 0.08);
      }
      .uh-card-acc-badge {
        font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 999px;
        background: var(--gem-primary-container); color: var(--gem-on-primary-container); border: 1px solid var(--gem-border-strong);
        flex-shrink: 0; max-width: none; overflow: visible; text-overflow: clip;
      }
      .uh-acc-save-drawer {
        display: none; flex-direction: column; gap: 6px; margin-top: 6px; padding: 8px;
        border-radius: 8px; background: var(--gem-bg-card-inner); border: 1px dashed var(--gem-border-strong);
      }
      .uh-acc-save-drawer.open { display: flex; }
      .uh-auth-backdrop {
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(0, 0, 0, 0.65); backdrop-filter: blur(8px);
        display: flex; align-items: center; justify-content: center; padding: 16px;
        animation: uhAuthFade .16s ease-out;
      }
      @keyframes uhAuthFade { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: scale(1); } }
      .uh-auth-modal {
        width: 100%; max-width: 620px; max-height: 90vh; overflow-y: auto;
        background: var(--gem-bg-sidebar);
        border: 1px solid var(--gem-border-strong); border-radius: 18px;
        box-shadow: var(--gem-shadow-float);
        color: var(--gem-text); display: flex; flex-direction: column; gap: 14px; padding: 18px 20px;
      }
      .uh-auth-head {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding-bottom: 12px; border-bottom: 1px solid var(--gem-border);
      }
      .uh-auth-title {
        display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 700; color: var(--gem-text);
      }
      .uh-auth-badge {
        font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
        background: var(--gem-primary-container); color: var(--gem-on-primary-container); border: 1px solid var(--gem-border-strong);
      }
      .uh-auth-close {
        background: var(--gem-surface-low); border: 1px solid var(--gem-border);
        color: var(--gem-text-secondary); border-radius: 8px; width: 28px; height: 28px; cursor: pointer; font-size: 14px;
      }
      .uh-auth-close:hover { background: rgba(239, 68, 68, 0.18); color: #ef4444; border-color: rgba(239, 68, 68, 0.35); }
      .uh-auth-note {
        font-size: 12.5px; line-height: 1.55; color: var(--gem-text-secondary);
        background: var(--gem-surface-low); border: 1px solid var(--gem-border);
        border-radius: 10px; padding: 10px 12px;
      }
      .uh-auth-step {
        display: flex; flex-direction: column; gap: 8px;
        background: var(--gem-bg-card-inner); border: 1px solid var(--gem-border);
        border-radius: 12px; padding: 12px 14px;
      }
      .uh-auth-step-label {
        font-size: 11.5px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.4px;
        display: flex; align-items: center; justify-content: space-between;
      }
      .uh-auth-url-row {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      }
      .uh-auth-url-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        padding: 8px 14px; border-radius: 9px; font-size: 13px; font-weight: 600;
        background: linear-gradient(135deg, #4f46e5, #6366f1); color: #fff !important;
        text-decoration: none !important; border: 1px solid rgba(129, 140, 248, 0.5);
        box-shadow: 0 4px 14px rgba(79, 70, 229, 0.35); cursor: pointer; transition: all .15s ease;
      }
      .uh-auth-url-btn:hover { filter: brightness(1.1); transform: translateY(-1px); }
      .uh-auth-url-box {
        width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px; color: #93c5fd; background: rgba(2, 6, 23, 0.7);
        border: 1px solid rgba(59, 130, 246, 0.25); border-radius: 7px; padding: 6px 8px;
        word-break: break-all; max-height: 58px; overflow-y: auto; user-select: all;
      }
      .uh-auth-code-wrap {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.35);
        border-radius: 10px; padding: 10px 14px;
      }
      .uh-auth-code-val {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 22px; font-weight: 800; letter-spacing: 2px; color: #34d399; user-select: all;
      }
      .uh-auth-input-row {
        display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
      }
      .uh-auth-input {
        flex: 1; min-width: 200px; height: 34px; padding: 0 10px; border-radius: 8px;
        background: rgba(2, 6, 23, 0.75); border: 1px solid rgba(148, 163, 184, 0.28);
        color: #f8fafc; font-size: 12.5px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      .uh-auth-input:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.25); }
      .uh-auth-term {
        margin: 0; padding: 10px 12px; border-radius: 8px;
        background: rgba(2, 6, 23, 0.85); border: 1px solid rgba(148, 163, 184, 0.16);
        color: #94a3b8; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px; line-height: 1.45; white-space: pre-wrap; word-break: break-word;
        max-height: 140px; overflow-y: auto;
      }
      .uh-auth-foot {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding-top: 10px; border-top: 1px solid rgba(148, 163, 184, 0.14);
      }
      .uh-auth-status {
        font-size: 12px; font-weight: 600; color: #93c5fd;
      }
      .uh-auth-status.ok { color: #34d399; }
      .uh-auth-status.err { color: #f87171; }
      /* 浅色主题适配：弹窗跟随主题色系，不再硬编码深色 */
      [data-theme="light"] .uh-auth-backdrop { background: rgba(15, 23, 42, 0.38); }
      [data-theme="light"] .uh-auth-modal { background: #ffffff; border-color: var(--gem-border); box-shadow: 0 18px 48px rgba(15, 23, 42, 0.18); color: #0f172a; }
      [data-theme="light"] .uh-auth-title { color: #0f172a; }
      [data-theme="light"] .uh-auth-note { background: #f1f5f9; border-color: rgba(15, 23, 42, 0.1); color: #475569; }
      [data-theme="light"] .uh-auth-step { background: #f8fafc; border-color: rgba(15, 23, 42, 0.08); }
      [data-theme="light"] .uh-auth-step-label { color: #64748b; }
      [data-theme="light"] .uh-auth-url-box { background: #f1f5f9; border-color: rgba(37, 99, 235, 0.25); color: #1d4ed8; }
      [data-theme="light"] .uh-auth-input { background: #ffffff; border-color: rgba(15, 23, 42, 0.16); color: #0f172a; }
      [data-theme="light"] .uh-auth-input::placeholder { color: #94a3b8; }
      [data-theme="light"] .uh-auth-input:focus { border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.18); }
      [data-theme="light"] .uh-auth-term { background: #f8fafc; border-color: rgba(15, 23, 42, 0.08); color: #334155; }
      [data-theme="light"] .uh-auth-code-wrap { background: rgba(16, 185, 129, 0.08); border-color: rgba(16, 185, 129, 0.3); }
      [data-theme="light"] .uh-auth-code-val { color: #059669; }
      [data-theme="light"] .uh-auth-status { color: #2563eb; }
      [data-theme="light"] .uh-auth-status.ok { color: #059669; }
      [data-theme="light"] .uh-auth-status.err { color: #dc2626; }
      [data-theme="light"] .uh-auth-close { background: #f1f5f9; border-color: rgba(15, 23, 42, 0.1); color: #475569; }
      [data-theme="light"] .uh-auth-foot { border-top-color: rgba(15, 23, 42, 0.1); }
      [data-theme="light"] .uh-auth-head { border-bottom-color: rgba(15, 23, 42, 0.08); }
    `;
    document.head.appendChild(st);
  }

  async function copyTextSafe(text, label = '内容') {
    try {
      await navigator.clipboard.writeText(text);
      notify(`已复制${label}`);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      notify(`已复制${label}`);
    }
  }

  // workerAuthState: { isLoggedIn, activeDisplay } 用于在弹窗内提示重复授权风险
  function openOAuthModal(worker, { defaultProfileName = '', workerAuthState = null } = {}) {
    const existing = document.getElementById('uhAuthModalBackdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'uhAuthModalBackdrop';
    backdrop.className = 'uh-auth-backdrop';

    const modal = document.createElement('div');
    modal.className = 'uh-auth-modal';
    modal.onclick = (e) => e.stopPropagation();

    let currentLoginId = null;
    let pollTimer = null;
    let finished = false;
    let submitting = false;
    let customAccountName = defaultProfileName || '';
    let region = 'cn'; // 仅 zcode 使用：cn=智谱 BigModel 国内版 / intl=Z.ai 国际版

    const cleanupModal = async (cancelBackend = false) => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (cancelBackend && currentLoginId && !finished) {
        try { await jpost('/api/auth/cancel', { loginId: currentLoginId }); } catch { /* ignore */ }
      }
      backdrop.remove();
    };

    // Header
    const head = document.createElement('div'); head.className = 'uh-auth-head';
    const titleWrap = document.createElement('div'); titleWrap.className = 'uh-auth-title';
    const titleText = document.createElement('span');
    titleText.textContent = `${worker} 登录 / 添加账号`;
    const badge = document.createElement('span'); badge.className = 'uh-auth-badge';
    badge.textContent = '新登录自动加入账号列表，原账号保留可切回';
    titleWrap.append(titleText, badge);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button'; closeBtn.className = 'uh-auth-close'; closeBtn.textContent = '✕';
    closeBtn.title = '关闭窗口';
    closeBtn.onclick = () => cleanupModal(true);
    head.append(titleWrap, closeBtn);
    modal.appendChild(head);

    // 账号档案名称栏（选填：留空则自动识别邮箱/用户名/UID 并添加到账号列表）
    const sandboxBar = document.createElement('div');
    sandboxBar.className = 'uh-auth-step';
    const sbLabel = document.createElement('div'); sbLabel.className = 'uh-auth-step-label';
    sbLabel.textContent = '账号备注名称（选填 · 留空将自动按登录邮箱 / 用户名添加到账号列表）';
    const sbRow = document.createElement('div'); sbRow.className = 'uh-auth-input-row';
    const sbInput = document.createElement('input'); sbInput.className = 'uh-auth-input';
    sbInput.value = customAccountName;
    sbInput.placeholder = '留空自动识别（如邮箱前缀 user01），也可自定义如 work / backup';
    sbInput.oninput = () => {
      customAccountName = sbInput.value.trim().replace(/[^\p{L}\p{N}._-]/gu, '-');
    };
    sbRow.appendChild(sbInput);
    sandboxBar.append(sbLabel, sbRow);
    modal.appendChild(sandboxBar);

    // CodeBuddy 单会话策略提醒：重新 OAuth 会踢掉同账号网页端会话
    if ((worker === 'codebuddy' || worker === 'codebuddy-cn') && workerAuthState && workerAuthState.isLoggedIn) {
      const warnEl = document.createElement('div');
      warnEl.className = 'uh-auth-note';
      warnEl.style.color = '#fbbf24';
      const who = workerAuthState.activeDisplay ? `「${maskAccount(workerAuthState.activeDisplay)}」` : '当前账号';
      warnEl.textContent = `提示：${worker} 当前已登录 ${who}。官方单会话策略：重新完成 OAuth 会使同账号的网页端 / 其他设备会话下线。若只是恢复使用请直接关闭本窗口；确需更换或添加账号再继续授权。`;
      modal.appendChild(warnEl);
    }

    // ZCode 区域切换（国内 BigModel / 国际 Z.ai）
    if (worker === 'zcode') {
      const regStep = document.createElement('div'); regStep.className = 'uh-auth-step';
      const regLabel = document.createElement('div'); regLabel.className = 'uh-auth-step-label';
      regLabel.textContent = '版本区域（国内与国际账号体系相互独立，请选择要登录的一侧）';
      const regRow = document.createElement('div'); regRow.className = 'uh-auth-input-row';
      const cnBtn = qaBtn('国内版 BigModel', 'qa-primary');
      const intlBtn = qaBtn('国际版 Z.ai');
      const syncRegionBtns = () => {
        cnBtn.className = region === 'cn' ? 'qa-btn qa-primary' : 'qa-btn';
        intlBtn.className = region === 'intl' ? 'qa-btn qa-primary' : 'qa-btn';
      };
      cnBtn.onclick = () => { if (region !== 'cn' && !submitting) { region = 'cn'; syncRegionBtns(); startSession(); } };
      intlBtn.onclick = () => { if (region !== 'intl' && !submitting) { region = 'intl'; syncRegionBtns(); startSession(); } };
      syncRegionBtns();
      regRow.append(cnBtn, intlBtn);
      regStep.append(regLabel, regRow);
      modal.appendChild(regStep);
    }

    // 说明栏
    const noteEl = document.createElement('div'); noteEl.className = 'uh-auth-note';
    noteEl.textContent = '正在初始化官方 OAuth 登录会话（原已登录账号将自动保留在账号列表中）…';
    modal.appendChild(noteEl);

    // Step 1: 授权链接区
    const urlStep = document.createElement('div'); urlStep.className = 'uh-auth-step'; urlStep.hidden = true;
    const urlLabel = document.createElement('div'); urlLabel.className = 'uh-auth-step-label';
    urlLabel.innerHTML = '<span>步骤 1 · 打开官方授权页面</span>';
    const urlBtnRow = document.createElement('div'); urlBtnRow.className = 'uh-auth-url-row';
    const openLinkBtn = document.createElement('a');
    openLinkBtn.className = 'uh-auth-url-btn';
    openLinkBtn.target = '_blank';
    openLinkBtn.rel = 'noopener noreferrer';
    openLinkBtn.textContent = '打开官方授权页面';
    const copyLinkBtn = qaBtn('复制授权链接');
    const secLinkBtn = document.createElement('a');
    secLinkBtn.className = 'qa-btn';
    secLinkBtn.target = '_blank';
    secLinkBtn.rel = 'noopener noreferrer';
    secLinkBtn.style.textDecoration = 'none';
    secLinkBtn.hidden = true;
    const urlBox = document.createElement('div'); urlBox.className = 'uh-auth-url-box';
    urlBtnRow.append(openLinkBtn, copyLinkBtn, secLinkBtn);
    urlStep.append(urlLabel, urlBtnRow, urlBox);
    modal.appendChild(urlStep);

    // Step 2: 设备码区（仅当有 deviceCode 时显示）
    const codeStep = document.createElement('div'); codeStep.className = 'uh-auth-step'; codeStep.hidden = true;
    const codeLabel = document.createElement('div'); codeLabel.className = 'uh-auth-step-label';
    codeLabel.textContent = '步骤 2 · 在授权页输入一次性设备码 (Device Code)';
    const codeWrap = document.createElement('div'); codeWrap.className = 'uh-auth-code-wrap';
    const codeVal = document.createElement('span'); codeVal.className = 'uh-auth-code-val';
    const copyCodeBtn = qaBtn('一键复制设备码', 'qa-primary');
    codeWrap.append(codeVal, copyCodeBtn);
    codeStep.append(codeLabel, codeWrap);
    modal.appendChild(codeStep);

    // Step 3: 回调链接 / 授权码 / API Key 提交区（所有 worker 均可用）
    const cbStep = document.createElement('div'); cbStep.className = 'uh-auth-step';
    const cbLabel = document.createElement('div'); cbLabel.className = 'uh-auth-step-label';
    cbLabel.textContent = worker === 'codearts'
      ? '输入华为云 CodeArts AK / SK 凭据（提交后自动添加至账号列表）'
      : worker === 'opencode'
        ? 'API Key 认证（直接粘贴 Key 即可，不校验格式；自动识别厂商）'
        : worker === 'cline'
          ? 'API Key 认证（直接粘贴 Key 即可，不校验格式；可选 provider|model|api_key|base_url）'
          : '回调链接 / 授权码 Code / API Key 认证（OAuth 授权成功后自动加入账号列表）';
    const cbRow = document.createElement('div'); cbRow.className = 'uh-auth-input-row';

    const cbInput = document.createElement('input');
    cbInput.className = 'uh-auth-input';
    cbInput.placeholder = worker === 'codearts'
      ? 'CODEARTS_CLI_AK'
      : worker === 'opencode'
        ? '直接粘贴 API Key（oc_sk-… / sk-ant-… 自动识别），也可写 provider:api_key'
        : worker === 'cline'
          ? '直接粘贴 API Key，需要指定时写 provider|model|api_key'
          : '粘贴跳转后的回调链接 (http://localhost...)、授权 Code 或 API Key';
    const skInput = document.createElement('input');
    skInput.className = 'uh-auth-input';
    skInput.type = 'password';
    skInput.placeholder = 'CODEARTS_CLI_SK';
    skInput.hidden = worker !== 'codearts';

    const submitCbBtn = qaBtn('提交并完成认证', 'qa-primary');
    cbInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submitCbBtn.click();
      }
    });
    cbRow.append(cbInput, skInput, submitCbBtn);
    cbStep.append(cbLabel, cbRow);
    modal.appendChild(cbStep);

    // Step 4: 实时终端输出区
    const termStep = document.createElement('div'); termStep.className = 'uh-auth-step';
    const termHead = document.createElement('div'); termHead.className = 'uh-auth-step-label';
    const termTitle = document.createElement('span'); termTitle.textContent = '实时登录终端输出 (TUI / OAuth 日志)';
    const sendEnterBtn = qaBtn('↵ 发送回车');
    sendEnterBtn.title = '向后台登录终端发送回车键';
    sendEnterBtn.onclick = async () => {
      if (!currentLoginId) return;
      await jpost('/api/auth/callback', { loginId: currentLoginId, input: '' });
      notify('已向终端发送回车');
    };
    termHead.append(termTitle, sendEnterBtn);
    const termPre = document.createElement('pre'); termPre.className = 'uh-auth-term';
    termPre.textContent = '等待输出…';
    termStep.append(termHead, termPre);
    modal.appendChild(termStep);

    // Footer
    const foot = document.createElement('div'); foot.className = 'uh-auth-foot';
    const statusEl = document.createElement('div'); statusEl.className = 'uh-auth-status';
    statusEl.textContent = '正在等待浏览器授权…';
    const footBtns = document.createElement('div'); footBtns.className = 'qa-rowbtns';
    const finishBtn = qaBtn('我已完成授权', 'qa-primary');
    finishBtn.title = '点击后立即检测授权是否已生效（未检测到会继续等待，不会产生假成功）';
    const cancelBtn = qaBtn('关闭');
    cancelBtn.onclick = () => cleanupModal(true);
    footBtns.append(finishBtn, cancelBtn);
    foot.append(statusEl, footBtns);
    modal.appendChild(foot);

    backdrop.appendChild(modal);
    backdrop.onclick = () => cleanupModal(true);
    document.body.appendChild(backdrop);

    // 统一以「状态检测」收口：只有后端真实检测到新凭据落盘才判定成功，绝不按按钮直接伪造成功
    async function completeSessionSuccess(customMsg, detectedAccountName = '') {
      if (finished) return;
      let accName = detectedAccountName || '';
      let apiKeyOnlyNote = '';

      if (currentLoginId && !detectedAccountName) {
        statusEl.className = 'uh-auth-status';
        statusEl.textContent = '正在检测授权落盘状态…';
        const fr = await jpost('/api/auth/finish', { loginId: currentLoginId, accountName: customAccountName }).catch(() => null);
        if (!fr || fr.ok === false) {
          statusEl.className = 'uh-auth-status err';
          statusEl.textContent = `尚未检测到新登录凭据：${(fr && fr.error) || '请先在浏览器完成授权'}（后台仍在自动检测，完成授权后会自动收口）`;
          notify('尚未检测到新凭据，完成授权后系统会自动识别', true);
          return;
        }
        accName = fr.accountName || customAccountName || '';
        if (fr.apiKeyOnly) apiKeyOnlyNote = fr.note || '';
      }

      finished = true;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      statusEl.className = 'uh-auth-status ok';
      const finalMsg = customMsg || apiKeyOnlyNote || (accName
        ? `${worker} 登录成功！已自动添加并切换至账号「${maskAccount(accName)}」`
        : `${worker} 登录成功，账号已自动添加并刷新配额`);
      statusEl.textContent = finalMsg;
      notify(finalMsg);
      await fetch('/api/quota/refresh').catch(() => {});
      await load();
      setTimeout(() => cleanupModal(false), 800);
    }

    submitCbBtn.onclick = async () => {
      if (!currentLoginId || submitting || finished) return;
      const val = cbInput.value.trim();
      const skVal = skInput.value.trim();
      if (worker === 'codearts' && (!val || !skVal)) {
        notify('请填写完整的 CODEARTS_CLI_AK 与 CODEARTS_CLI_SK', true);
        return;
      }
      if (worker !== 'codearts' && !val) {
        notify('请先粘贴回调链接、授权 Code 或 API Key', true);
        return;
      }
      submitting = true;
      submitCbBtn.disabled = true;
      finishBtn.disabled = true;
      statusEl.className = 'uh-auth-status';
      statusEl.textContent = '正在向官方服务验证凭据并自动添加账号…';
      try {
        const r = await jpost('/api/auth/callback', {
          loginId: currentLoginId,
          input: val,
          accountName: customAccountName,
          ak: worker === 'codearts' ? val : undefined,
          sk: worker === 'codearts' ? skVal : undefined,
        });
        if (!r.ok) {
          statusEl.className = 'uh-auth-status err';
          statusEl.textContent = `认证失败: ${r.error || '?'}`;
          notify(`认证失败: ${r.error || '?'}`, true);
          return;
        }
        await completeSessionSuccess(r.note || '', r.accountName || '');
      } finally {
        submitting = false;
        if (!finished) {
          submitCbBtn.disabled = false;
          finishBtn.disabled = false;
        }
      }
    };

    finishBtn.onclick = async () => {
      if (submitting || finished) return;
      if (cbInput.value.trim()) {
        await submitCbBtn.onclick();
        return;
      }
      // 「我已完成授权」= 触发一次状态检测：由后端核验凭据是否真实落盘，未检测到则继续等待
      finishBtn.disabled = true;
      try { await completeSessionSuccess(); } finally { if (!finished) finishBtn.disabled = false; }
    };

    async function pollOnce() {
      if (!currentLoginId || finished || submitting) return;
      const p = await fetch(`/api/auth/poll?loginId=${encodeURIComponent(currentLoginId)}`).then((x) => x.json()).catch(() => null);
      if (!p || !p.ok || finished || submitting) return;
      if (p.output) {
        termPre.textContent = p.output;
        termPre.scrollTop = termPre.scrollHeight;
      }
      if (p.callbackHint && worker !== 'codearts') {
        cbInput.placeholder = p.callbackHint;
      }
      if (p.url) {
        urlStep.hidden = false;
        openLinkBtn.href = p.url;
        urlBox.textContent = p.url;
        copyLinkBtn.onclick = () => copyTextSafe(p.url, '授权链接');
      }
      if (p.secondaryUrl) {
        secLinkBtn.hidden = false;
        secLinkBtn.href = p.secondaryUrl;
        secLinkBtn.textContent = '打开国际版授权页';
      } else {
        secLinkBtn.hidden = true;
      }
      if (p.deviceCode) {
        codeStep.hidden = false;
        codeVal.textContent = p.deviceCode;
        copyCodeBtn.onclick = () => copyTextSafe(p.deviceCode, `设备码 ${p.deviceCode}`);
      }
      if (p.exited && !finished && !submitting) {
        if (p.exitCode === 0) {
          await completeSessionSuccess('', p.accountName || '');
        } else {
          statusEl.className = 'uh-auth-status err';
          statusEl.textContent = `登录进程已结束 (code=${p.exitCode})，可检查日志或使用下方输入框完成认证`;
        }
      }
    }

    async function startSession() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (currentLoginId && !finished) {
        const prevId = currentLoginId;
        currentLoginId = null;
        jpost('/api/auth/cancel', { loginId: prevId }).catch(() => {});
      }
      finished = false;
      submitting = false;
      statusEl.className = 'uh-auth-status';
      statusEl.textContent = '正在启动官方 OAuth 会话…';
      const payload = { worker, name: customAccountName };
      if (worker === 'zcode') payload.region = region;
      const r = await jpost('/api/auth/login', payload);
      if (!r || !r.ok) {
        noteEl.textContent = r?.note || r?.error || '启动登录会话失败';
        statusEl.className = 'uh-auth-status err';
        statusEl.textContent = `${r?.error || '启动失败'}`;
        return;
      }
      currentLoginId = r.loginId;
      noteEl.textContent = (r.note || `${worker} OAuth 登录已启动`) + '（登录完成后将自动加入账号列表并切换生效）';
      if (r.callbackHint && worker !== 'codearts') cbInput.placeholder = r.callbackHint;
      statusEl.textContent = '正在等待浏览器完成授权（或粘贴回调链接提交）…';
      await pollOnce();
      pollTimer = setInterval(pollOnce, 1500);
    }

    startSession();
  }

  function authRow(worker, q, acc) {
    const wrap = document.createElement('div'); wrap.className = 'qa-section';
    const head = document.createElement('div');
    head.className = 'qa-section-title';
    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.justifyContent = 'space-between';
    const titleSpan = document.createElement('span');
    titleSpan.textContent = '账号与登录';

    const msgText = String((q && q.message) || '');
    const isLoggedOutMsg = ['未登录', '缺失', '不可用', '未配置', '已过期'].some((w) => msgText.includes(w));
    const isLoggedIn = (acc && acc.livePresent && !isLoggedOutMsg) || (q && q.quotas && Object.keys(q.quotas).length > 0);
    const statusPill = document.createElement('span');
    statusPill.className = 'uh-acc-status-pill ' + (isLoggedIn ? 'ok' : 'warn');
    const profiles = (acc && acc.profiles) || [];
    const activeProf = profiles.find((p) => p.active);
    // 状态只表达登录与否；当前账号身份由下方账号胶囊（绿色「当前」）统一展示，不再重复
    statusPill.textContent = isLoggedIn ? '● 已登录' : '○ 未登录';
    if (isLoggedIn && activeProf) statusPill.title = `当前生效账号：${maskAccount(activeProf.display || activeProf.name)}`;
    head.append(titleSpan, statusPill);
    wrap.appendChild(head);

    // 账号切换统一由下方胶囊芯片完成（下拉框与芯片 100% 重复，已移除）
    let chipsWrapRef = null;
    let liveActiveName = (activeProf && activeProf.name) || '';

    function markChipActive(name) {
      if (!chipsWrapRef) return;
      liveActiveName = name;
      for (const chip of chipsWrapRef.querySelectorAll('.uh-acc-chip[data-acc-name]')) {
        const chipName = chip.getAttribute('data-acc-name');
        const on = chipName === name;
        chip.classList.toggle('active', on);
        const prof = profiles.find((x) => x.name === chipName);
        chip.title = on ? `当前激活: ${maskAccount((prof && prof.display) || chipName)}` : `点击立即切换至: ${maskAccount((prof && prof.display) || chipName)}`;
        // 重新绑定：非当前芯片可点击切换，当前芯片不可点（原先激活的芯片没有 onclick，需补绑）
        chip.onclick = on ? null : () => doSwitchAccount(chipName);
        let badge = chip.querySelector('.uh-acc-chip-badge');
        if (on && !badge) {
          badge = document.createElement('span'); badge.className = 'uh-acc-chip-badge'; badge.textContent = '当前';
          chip.insertBefore(badge, chip.querySelector('.uh-acc-chip-del'));
        } else if (!on && badge) {
          badge.remove();
        }
      }
      // 头部账号徽章同步（乐观），后台 load() 会再核对
      const card = wrap.closest('.uh-card');
      const accBadgeEl = card && card.querySelector(`[data-acc-badge-for="${worker}"]`);
      const prof = profiles.find((x) => x.name === name);
      if (accBadgeEl && prof) accBadgeEl.textContent = maskAccount(prof.display || prof.name);
    }

    function doSwitchAccount(targetName) {
      if (!targetName || targetName === liveActiveName) return;
      // 乐观切换：点击立即变绿，后台再跑真实切换与配额刷新
      markChipActive(targetName);
      (async () => {
        const r = await jpost('/api/accounts/switch', { worker, name: targetName }).catch((e) => ({ ok: false, error: e.message }));
        if (!r || r.ok === false) {
          notify(`切换失败: ${(r && r.error) || '?'}`, true);
          load(); // 失败回滚：以服务端真实状态重绘
          return;
        }
        notify(`${worker} 已切换至账号「${maskAccount((profiles.find((x) => x.name === targetName) || {}).display || targetName)}」`);
        load(); // 后台确认刷新（服务端已清该 worker 配额缓存，其余走 60s 缓存，不再全量强刷）
      })();
    }

    // 内联「存别名」抽屉
    const saveDrawer = document.createElement('div'); saveDrawer.className = 'uh-acc-save-drawer';
    const saveInput = document.createElement('input');
    saveInput.className = 'qa-input';
    saveInput.placeholder = `输入 ${worker} 账号自定义名称 (如 main / work)`;
    const saveDrawerBtns = document.createElement('div'); saveDrawerBtns.className = 'qa-rowbtns';
    const confirmSaveBtn = qaBtn('保存名称', 'qa-primary');
    const cancelSaveBtn = qaBtn('取消');
    confirmSaveBtn.onclick = async () => {
      const name = saveInput.value.trim().replace(/[^\p{L}\p{N}._-]/gu, '-');
      if (!name) { notify('请填写账号名称（文字、数字、-、_）', true); return; }
      const r = await jpost('/api/accounts/save', { worker, name });
      notify(r.ok ? `已将 ${worker} 当前凭据保存为账号「${r.name || name}」` : `保存失败: ${r.error || '?'}`, !r.ok);
      if (r.ok) {
        saveDrawer.classList.remove('open');
        saveInput.value = '';
        load();
      }
    };
    cancelSaveBtn.onclick = () => saveDrawer.classList.remove('open');
    saveDrawerBtns.append(confirmSaveBtn, cancelSaveBtn);
    saveDrawer.append(saveInput, saveDrawerBtns);

    function toggleSaveDrawer() {
      saveDrawer.classList.toggle('open');
      if (saveDrawer.classList.contains('open')) {
        if (!saveInput.value) saveInput.value = activeProf ? activeProf.name : `acc-${profiles.length + 1}`;
        setTimeout(() => { saveInput.focus(); saveInput.select(); }, 20);
      }
    }

    if (profiles.length > 0 || isLoggedIn) {
      const chipsWrap = document.createElement('div');
      chipsWrap.className = 'uh-acc-chips-wrap';
      chipsWrapRef = chipsWrap;

      const makeChip = (p, isStale) => {
        const chip = document.createElement('div');
        chip.className = 'uh-acc-chip' + (p.active ? ' active' : '') + (isStale ? ' stale' : '');
        chip.title = p.active ? `当前激活: ${maskAccount(p.display || p.name)}` : `点击立即切换至: ${maskAccount(p.display || p.name)}`;
        chip.setAttribute('data-acc-name', p.name);

        const dot = document.createElement('span'); dot.className = 'uh-acc-chip-dot';
        const label = document.createElement('span'); label.textContent = maskAccount(p.display || p.name);
        chip.append(dot, label);

        if (p.active) {
          const badge = document.createElement('span'); badge.className = 'uh-acc-chip-badge'; badge.textContent = '当前';
          chip.append(badge);
        } else {
          chip.onclick = () => doSwitchAccount(p.name);
        }
        if (isStale) {
          const tag = document.createElement('span'); tag.className = 'uh-acc-chip-stale-tag'; tag.textContent = '历史';
          chip.insertBefore(tag, chip.querySelector('.uh-acc-chip-del'));
        }

        const delBtn = document.createElement('span');
        delBtn.className = 'uh-acc-chip-del';
        delBtn.textContent = '×';
        delBtn.title = `删除已存账号「${maskAccount(p.name)}」`;
        delBtn.onclick = async (e) => {
          e.stopPropagation();
          if (!confirm(`确定删除 ${worker} 的已存账号「${maskAccount(p.name)}」吗？`)) return;
          const res = await jpost('/api/accounts/delete', { worker, name: p.name });
          notify(res.ok ? `已删除账号「${maskAccount(p.name)}」` : `删除失败: ${res.error || '?'}`, !res.ok);
          await load();
        };
        chip.append(delBtn);
        return chip;
      };

      // 只登录了一个号时，别把同一份凭据的历史快照也摆出来当「另一个账号」；
      // 历史快照默认收进「历史 N」胶囊，点开才显示，且仍可切换/删除
      const staleProfiles = profiles.filter((p) => p.stale && !p.active);
      const freshProfiles = profiles.filter((p) => !p.stale || p.active);
      for (const p of freshProfiles) chipsWrap.appendChild(makeChip(p, false));
      if (staleProfiles.length) {
        const toggle = document.createElement('div');
        toggle.className = 'uh-acc-chip uh-acc-chip-save';
        toggle.textContent = `历史 ${staleProfiles.length}`;
        toggle.title = '同一份凭据的旧快照（例如 token 刷新前保存的档案），点开可查看 / 切换 / 删除';
        toggle.onclick = () => {
          toggle.remove();
          for (const p of staleProfiles) chipsWrap.appendChild(makeChip(p, true));
        };
        chipsWrap.appendChild(toggle);
      }
      // 行尾附「存别名」小胶囊，不再独占一行下拉框
      if (isLoggedIn) {
        const saveChip = document.createElement('div');
        saveChip.className = 'uh-acc-chip uh-acc-chip-save';
        saveChip.textContent = '＋ 存别名';
        saveChip.title = '为当前已登录账号自定义一个别名档案';
        saveChip.onclick = toggleSaveDrawer;
        chipsWrap.appendChild(saveChip);
      }
      wrap.appendChild(chipsWrap);
    }
    wrap.appendChild(saveDrawer);

    const rowAuth = document.createElement('div'); rowAuth.className = 'qa-rowbtns qa-even';
    // 统一登录入口：登录与添加账号本是同一流程（沙箱隔离 + 自动归档 + 自动切换），不再并列两个易混淆按钮
    const loginBtn = qaBtn(isLoggedIn ? '登录 / 添加账号' : 'OAuth 登录', 'qa-primary');
    loginBtn.title = '打开官方授权登录窗口：已存账号自动保留，新登录账号自动加入列表并切换生效';
    const logoutBtn = qaBtn('退出');

    loginBtn.onclick = () => openOAuthModal(worker, {
      workerAuthState: { isLoggedIn, activeDisplay: activeProf ? maskAccount(activeProf.display || activeProf.name) : '' },
    });

    logoutBtn.onclick = async () => {
      logoutBtn.disabled = true;
      try {
        const r = await jpost('/api/auth/logout', { worker });
        notify(r.ok ? `${worker} 已退出当前账号（原账号仍保留在下拉列表中可随时切回）` : `退出提示: ${r.error || '?'}`, !r.ok);
        await load();
      } finally {
        logoutBtn.disabled = false;
      }
    };

    rowAuth.append(loginBtn, logoutBtn);
    wrap.appendChild(rowAuth);
    return wrap;
  }

  function hydrateWorkerSlots(card) {
    const worker = card.getAttribute('data-worker');
    if (!worker || (!quotaData && !accountData && !modelsData)) return;
    const q = (quotaData && quotaData.workers && quotaData.workers[worker]) || {};
    const acc = (accountData && accountData.workers && accountData.workers[worker]) || { profiles: [] };

    const activeProf = (acc && acc.profiles && acc.profiles.find((p) => p.active)) || null;
    const accDisp = (activeProf && (activeProf.display || activeProf.name)) || (q && q.account) || '';

    const planEl = card.querySelector(`[data-plan-for="${worker}"]`);
    if (planEl && quotaData) {
      let planText = String(q.plan || '').trim();
      // 套餐徽章不再重复账号身份：先剥尾部括号式账号，再剥含身份 ID 的尾部 "· xxx" 段；
      // 剥离后为空或与 worker 同义则隐藏，彻底消除同信息红框
      if (planText && accDisp) {
        const strippedParen = planText.replace(/\s*[（(][^()（）]*[)）]\s*$/, '').trim();
        if (strippedParen) planText = strippedParen;
        const identity = String((activeProf && activeProf.identity) || '').trim();
        if (identity && planText.includes(identity)) {
          const strippedMid = planText.replace(/\s*[·\-–—]\s*[^·\-–—]*$/, '').trim();
          if (strippedMid && !strippedMid.includes(identity)) planText = strippedMid;
          else planText = planText.replace(identity, '').replace(/\s*[·\-–—]\s*$/, '').trim();
        }
      }
      if (planText && planText.toLowerCase() === worker.toLowerCase()) planText = '';
      planEl.textContent = maskMessageText(planText);
      planEl.hidden = !planText;
    }

    const accBadgeEl = card.querySelector(`[data-acc-badge-for="${worker}"]`);
    if (accBadgeEl) {
      if (accDisp) {
        accBadgeEl.textContent = maskAccount(accDisp);
        accBadgeEl.title = `当前生效账号: ${maskAccount(accDisp)}${activeProf && activeProf.identity ? ' (' + maskAccount(activeProf.identity) + ')' : ''}`;
        accBadgeEl.hidden = false;
      } else {
        accBadgeEl.hidden = true;
      }
    }

    const quotaSlot = card.querySelector(`[data-quota-slot="${worker}"]`);
    if (quotaSlot && quotaData) {
      quotaSlot.textContent = '';
      const msgText = String(q.message || '');
      const badMsg = ['不可达', '未登录', '失败', '过期'].some((w) => msgText.includes(w));
      const quotas = q.quotas && Object.keys(q.quotas).length ? q.quotas : null;
      const head = document.createElement('div');
      head.className = 'qa-section-title';
      head.style.display = 'flex';
      head.style.alignItems = 'center';
      head.style.justifyContent = 'space-between';
      head.style.marginBottom = '6px';
      const titleLeft = document.createElement('span');
      titleLeft.textContent = '配额与通道状态';
      const dot = document.createElement('span');
      dot.className = 'qa-status-dot ' + (quotas || !badMsg ? 'ok' : 'warn');
      dot.title = quotas ? '配额正常' : (badMsg ? '通道异常' : '正常');
      head.append(titleLeft, dot);
      quotaSlot.appendChild(head);
      if (quotas) {
        const qwrap = document.createElement('div'); qwrap.className = 'qa-quotas';
        for (const [name, qq] of Object.entries(quotas)) qwrap.appendChild(bar(name, qq));
        quotaSlot.appendChild(qwrap);
      } else {
        const m = document.createElement('div'); m.className = 'qa-msg';
        m.textContent = maskMessageText(q.message || '暂无配额数据');
        quotaSlot.appendChild(m);
      }
    }

    const modelSlot = card.querySelector(`[data-model-slot="${worker}"]`);
    if (modelSlot && modelsData) {
      modelSlot.textContent = '';
      const modelsWrap = modelRow(worker);
      if (modelsWrap.childNodes.length) modelSlot.appendChild(modelsWrap);
    }

    const authSlot = card.querySelector(`[data-auth-slot="${worker}"]`);
    if (authSlot && (accountData || quotaData)) {
      authSlot.textContent = '';
      authSlot.appendChild(authRow(worker, q, acc));
    }
  }

  function hydrateAllUnifiedCards() {
    const agentsEl = document.getElementById('agents');
    if (!agentsEl) return;
    agentsEl.querySelectorAll('.uh-card[data-worker]').forEach((card) => hydrateWorkerSlots(card));
  }

  window.__ahHydrateUnifiedCards = hydrateAllUnifiedCards;

  async function load() {
    try {
      const fastPromise = Promise.all([
        fetch('/api/accounts').then((r) => r.json()).catch(() => null),
        fetch('/api/models').then((r) => r.json()).catch(() => null),
      ]).then(([a, m]) => {
        if (a) accountData = a;
        if (m) modelsData = m;
        hydrateAllUnifiedCards();
      });
      const quotaPromise = fetch('/api/quota').then((r) => r.json()).then((q) => {
        if (q) quotaData = q;
        hydrateAllUnifiedCards();
        stampUpdated();
      }).catch(() => {});
      await Promise.all([fastPromise, quotaPromise]);
    } catch (e) {
      if (grid) grid.textContent = '配额加载失败: ' + esc(e.message);
    }
  }
  window.__ahReloadQuotas = load;

  const qaUpdated = document.getElementById('qaUpdated');
  const stampUpdated = () => {
    if (!qaUpdated) return;
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    qaUpdated.textContent = `更新于 ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  };
  const refreshBtn = document.getElementById('qaRefreshBtn');
  const agentsGrid = document.getElementById('agents');
  refreshBtn.addEventListener('click', async () => {
    if (refreshBtn.disabled) return;
    refreshBtn.disabled = true;
    const oldLabel = refreshBtn.textContent;
    refreshBtn.textContent = '↻ 刷新中…';
    if (agentsGrid) agentsGrid.classList.add('qa-loading');
    try { await fetch('/api/quota/refresh').then((r) => r.json()); } catch { /* ignore */ }
    try { await load(); } finally {
      if (agentsGrid) agentsGrid.classList.remove('qa-loading');
      refreshBtn.disabled = false;
      refreshBtn.textContent = oldLabel;
    }
  });
  load();
  setInterval(load, 60000);

  // 主题切换：太阳/月亮单按钮，联动当前预设的专属深/浅色模式
  const initPaletteSwitcher = () => {
    const savedTheme = localStorage.getItem('agent_hub_theme') || (localStorage.getItem('agent_hub_palette') === 'light' ? 'light' : 'dark');
    let darkMode = savedTheme !== 'light';
    const btn = document.getElementById('btn-theme-toggle');
    const sunIcon = btn ? btn.querySelector('.theme-icon-sun') : null;
    const moonIcon = btn ? btn.querySelector('.theme-icon-moon') : null;
    const apply = (dark) => {
      darkMode = dark;
      document.documentElement.setAttribute('data-palette', dark ? 'gemini' : 'light');
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
      localStorage.setItem('agent_hub_theme', dark ? 'dark' : 'light');
      localStorage.setItem('agent_hub_palette', dark ? 'gemini' : 'light');
      if (sunIcon) sunIcon.removeAttribute('hidden');
      if (moonIcon) moonIcon.removeAttribute('hidden');
      if (btn) btn.title = dark ? '切换为浅色系' : '切换为深色系';
      if (btn) btn.setAttribute('aria-pressed', dark ? 'false' : 'true');
    };
    apply(darkMode);
    if (btn) btn.addEventListener('click', () => apply(!darkMode));
  };
  initPaletteSwitcher();

  // 点击左上角品牌 Logo 直接返回到对话视图（无论在哪个页面）
  const initBrandLogoClick = () => {
    const brandBox = document.querySelector('.brand-box');
    if (!brandBox) return;
    brandBox.addEventListener('click', () => {
      const chatTab = document.getElementById('tab-chat');
      if (chatTab) {
        if (!chatTab.classList.contains('active')) {
          chatTab.click();
        } else {
          togglePlatformsSidebar(true);
        }
      }
    });
  };
  initBrandLogoClick();

  // 自定义背景与色系预设管理逻辑
  const initCustomBackground = () => {
    const bgLayer = document.getElementById('app-bg-layer');
    if (!bgLayer) return;

    // layer: true 表示该预设带一张渐变底图，由 #app-bg-layer 承载
    // （底图取 CSS 变量 --preset-bg / --preset-bg-size，随深浅主题自动切换）
    const PRESETS = {
      mocha: { layer: false },
      shell: { layer: false },
      aurora: { layer: true },
      dusk: { layer: true },
      grid: { layer: true },
      custom: { layer: true }
    };
    const VALID_PRESETS = Object.keys(PRESETS);

    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem('agent_hub_custom_bg') || '{}');
    } catch { saved = {}; }

    const config = {
      preset: VALID_PRESETS.indexOf(saved?.preset) >= 0 ? saved.preset : 'mocha',
      url: saved?.url || '',
      opacity: typeof saved?.opacity === 'number' ? saved.opacity : 100,
      blur: typeof saved?.blur === 'number' ? saved.blur : 0
    };

    const presetGroup = document.getElementById('bg-preset-group');
    const customControls = document.getElementById('bg-custom-controls');
    const customInput = document.getElementById('custom-bg-input');
    const customFileInput = document.getElementById('custom-bg-file');
    const uploadLocalBtn = document.getElementById('btn-upload-local-bg');
    const applyBgBtn = document.getElementById('btn-apply-bg');
    const opacitySlider = document.getElementById('bg-opacity-slider');
    const opacityVal = document.getElementById('bg-opacity-val');
    const blurSlider = document.getElementById('bg-blur-slider');
    const blurVal = document.getElementById('bg-blur-val');
    const resetBtn = document.getElementById('btn-reset-bg');

    const applyBackground = () => {
      let preset = config.preset || 'mocha';
      if (VALID_PRESETS.indexOf(preset) < 0) preset = 'mocha';
      config.preset = preset;
      document.documentElement.setAttribute('data-preset', preset);

      // 是否需要底图：非 custom 预设看 PRESETS[preset].layer；custom 则要求已填图片
      const useLayer = preset === 'custom'
        ? Boolean(config.url && config.url.trim())
        : !!PRESETS[preset].layer;

      if (useLayer) {
        document.body.classList.add('has-custom-bg');
        bgLayer.style.display = 'block';
        if (preset === 'custom') {
          bgLayer.style.backgroundImage = `url("${config.url}")`;
          bgLayer.style.backgroundSize = 'cover';
          bgLayer.style.backgroundRepeat = 'no-repeat';
          bgLayer.style.backgroundPosition = 'center';
        } else {
          // 渐变底图定义在预设块里（--preset-bg / -size / -repeat / -position），
          // 深浅主题各一份，切换主题时自动跟随
          bgLayer.style.backgroundImage = 'var(--preset-bg)';
          bgLayer.style.backgroundSize = 'var(--preset-bg-size, cover)';
          bgLayer.style.backgroundRepeat = 'var(--preset-bg-repeat, no-repeat)';
          bgLayer.style.backgroundPosition = 'var(--preset-bg-position, center)';
        }
        bgLayer.style.opacity = (config.opacity / 100).toString();
        bgLayer.style.filter = config.blur > 0 ? `blur(${config.blur}px)` : 'none';
      } else {
        document.body.classList.remove('has-custom-bg');
        bgLayer.style.display = 'none';
        bgLayer.style.backgroundImage = 'none';
      }

      // 同步 UI 状态
      if (presetGroup) {
        const buttons = presetGroup.querySelectorAll('.bg-preset-btn');
        buttons.forEach((btn) => {
          if (btn.getAttribute('data-preset') === preset) {
            btn.classList.add('active');
          } else {
            btn.classList.remove('active');
          }
        });
      }

      if (customControls) {
        customControls.hidden = (preset !== 'custom');
      }
      if (customInput && config.preset === 'custom') {
        customInput.value = config.url || '';
      }
      if (opacitySlider) opacitySlider.value = config.opacity;
      if (opacityVal) opacityVal.textContent = `${config.opacity}%`;
      if (blurSlider) blurSlider.value = config.blur;
      if (blurVal) blurVal.textContent = `${config.blur}px`;

      // 持久化存储
      try {
        localStorage.setItem('agent_hub_custom_bg', JSON.stringify(config));
      } catch { /* ignore */ }
    };

    // 预设按钮事件
    if (presetGroup) {
      presetGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('.bg-preset-btn');
        if (!btn) return;
        const targetPreset = btn.getAttribute('data-preset');
        if (!targetPreset) return;
        config.preset = targetPreset;
        applyBackground();
      });
    }

    // 应用自定义 URL
    if (applyBgBtn && customInput) {
      applyBgBtn.addEventListener('click', () => {
        const val = customInput.value.trim();
        config.url = val;
        config.preset = 'custom';
        applyBackground();
      });
      customInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          applyBgBtn.click();
        }
      });
    }

    // 上传本地图片
    if (uploadLocalBtn && customFileInput) {
      uploadLocalBtn.addEventListener('click', () => {
        customFileInput.click();
      });
      customFileInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) {
          alert('图片大小请小于 8MB');
          return;
        }
        const reader = new FileReader();
        reader.onload = (evt) => {
          config.url = evt.target.result;
          config.preset = 'custom';
          applyBackground();
        };
        reader.readAsDataURL(file);
      });
    }

    // 透明度滑块
    if (opacitySlider) {
      opacitySlider.addEventListener('input', (e) => {
        config.opacity = parseInt(e.target.value, 10);
        applyBackground();
      });
    }

    // 模糊度滑块
    if (blurSlider) {
      blurSlider.addEventListener('input', (e) => {
        config.blur = parseInt(e.target.value, 10);
        applyBackground();
      });
    }

    // 恢复默认背景
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        config.preset = 'mocha';
        config.url = '';
        config.opacity = 100;
        config.blur = 0;
        applyBackground();
      });
    }

    applyBackground();
  };
  initCustomBackground();

  // ============================================================================
  // 每日签到与福利中枢 (WorkBuddy · Trae免客户端 · CodeArts码道)
  // ============================================================================
  const initDailyCheckinModule = () => {
    const card = document.getElementById('settings-checkin-card');
    if (!card) return;

    const escapeHtml = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const refreshBtn = document.getElementById('btn-checkin-refresh');
    const checkinAllBtn = document.getElementById('btn-checkin-all');
    const autoCheckbox = document.getElementById('checkin-auto-checkbox');
    const tabBtns = card.querySelectorAll('.checkin-tab-btn');
    const tabContents = {
      grid: document.getElementById('checkin-tab-grid'),
      history: document.getElementById('checkin-tab-history')
    };
    const histCountSpan = document.getElementById('checkin-hist-count');
    const logContainer = document.getElementById('checkin-log-container');
    const overallPill = document.getElementById('checkin-overall-pill');

    let currentCheckinData = null;

    // 格式化状态徽章
    const updateBadge = (elId, status, text) => {
      const el = document.getElementById(elId);
      if (!el) return;
      el.className = 'checkin-status-badge';
      if (status === 'success') {
        el.classList.add('status-success');
        el.textContent = text || '今日已签到';
      } else if (status === 'already') {
        el.classList.add('status-already');
        el.textContent = text || '今日已签';
      } else if (status === 'pending') {
        el.classList.add('status-pending');
        el.textContent = text || '今日待打卡';
      } else if (status === 'failed') {
        el.classList.add('status-failed');
        el.textContent = text || '签到异常';
      } else {
        el.classList.add('status-unconfigured');
        el.textContent = text || '未配置凭据';
      }
    };

    // 凭据来源文案：直接说明「这份凭据来自已安装的 CLI」，WorkBuddy 还会自动续期
    const credentialText = (p) => {
      if (!p || !p.available) return (p && p.source) || '未关联凭据';
      const bits = [p.source || '已检测到凭据'];
      if (p.credentialMode === 'cli' && !bits[0].includes('CLI')) bits.push('CLI 实时');
      if (p.autoRefresh) bits.push('自动续期');
      return bits.join(' · ');
    };

    // 渲染打卡状态数据
    const renderAccountRows = (containerId, accounts) => {
      const box = document.getElementById(containerId);
      if (!box) return;
      const list = Array.isArray(accounts) ? accounts : [];
      if (!list.length) {
        box.innerHTML = '';
        return;
      }
      box.innerHTML = list.map((a) => {
        const st = String(a.status || 'pending');
        const stateText = st === 'success'
          ? (a.credits ? `+${a.credits}` : '已签到')
          : (st === 'already' ? '今日已签' : (st === 'failed' ? (a.message || '失败') : (st === 'expired' ? '凭据失效' : '待打卡')));
        const name = escapeHtml((a.display || a.name || '未知账号')
          + (a.fresh ? '（新增）' : (a.stale ? '（已切走）' : '')));
        const cls = st === 'expired' ? 'failed' : st;
        const tip = [a.message, a.source ? `凭据：${a.source}` : ''].filter(Boolean).join(' · ');
        return `<div class="checkin-acct-row is-${escapeHtml(cls)}" title="${escapeHtml(tip)}">
          <span class="checkin-acct-dot"></span>
          <span class="checkin-acct-name">${name}${a.active ? ' ·当前' : ''}</span>
          <span class="checkin-acct-state">${escapeHtml(stateText)}</span>
        </div>`;
      }).join('');
    };

    const renderOverview = (data) => {
      currentCheckinData = data;
      if (!data || !data.platforms) return;

      if (autoCheckbox) {
        autoCheckbox.checked = data.autoCheckin !== false;
      }

      const p = data.platforms;

      // 1. WorkBuddy
      if (p.workbuddy) {
        const isSigned = p.workbuddy.status === 'success' || p.workbuddy.status === 'already';
        updateBadge('badge-wb', p.workbuddy.status, p.workbuddy.status === 'success' ? '今日已签到' : (p.workbuddy.status === 'already' ? '今日已签' : (p.workbuddy.status === 'pending' ? '今日待打卡' : (p.workbuddy.status === 'failed' ? '签到失败' : '未关联凭据'))));
        const credEl = document.getElementById('cred-wb');
        if (credEl) credEl.textContent = credentialText(p.workbuddy);
        const msgEl = document.getElementById('msg-wb');
        if (msgEl) msgEl.textContent = p.workbuddy.message || '今日尚未执行';
        const rewEl = document.getElementById('reward-wb');
        if (rewEl) rewEl.textContent = p.workbuddy.credits ? `${p.workbuddy.credits}${p.workbuddy.consecutiveDays ? ` (连签${p.workbuddy.consecutiveDays}天)` : ''}` : '-';
        renderAccountRows('accts-wb', p.workbuddy.accounts);
        const btnWb = document.getElementById('btn-run-wb');
        if (btnWb) {
          btnWb.disabled = isSigned;
          btnWb.textContent = isSigned ? '今日已签' : '立即签到';
        }
      }

      // 1.5 CodeBuddy 国际版
      if (p.codebuddy) {
        const isSigned = p.codebuddy.status === 'success' || p.codebuddy.status === 'already';
        updateBadge('badge-cb', p.codebuddy.status, p.codebuddy.status === 'success' ? '今日已签到' : (p.codebuddy.status === 'already' ? '今日已签' : (p.codebuddy.status === 'pending' ? '今日待打卡' : (p.codebuddy.status === 'failed' ? '签到失败' : '未关联凭据'))));
        const credEl = document.getElementById('cred-cb');
        if (credEl) credEl.textContent = credentialText(p.codebuddy);
        const msgEl = document.getElementById('msg-cb');
        if (msgEl) msgEl.textContent = p.codebuddy.message || '今日尚未执行';
        const rewEl = document.getElementById('reward-cb');
        if (rewEl) rewEl.textContent = p.codebuddy.credits ? `${p.codebuddy.credits}${p.codebuddy.consecutiveDays ? ` (连签${p.codebuddy.consecutiveDays}天)` : ''}` : '-';
        renderAccountRows('accts-cb', p.codebuddy.accounts);
        const btnCb = document.getElementById('btn-run-cb');
        if (btnCb) {
          btnCb.disabled = isSigned;
          btnCb.textContent = isSigned ? '今日已签' : '立即签到';
        }
      }

      // 2. Trae (免客户端 / CDP直连)
      if (p.traecode) {
        const isSigned = p.traecode.status === 'success' || p.traecode.status === 'already';
        updateBadge('badge-trae', p.traecode.status, p.traecode.status === 'success' ? '今日已签到' : (p.traecode.status === 'already' ? '今日已签' : (p.traecode.status === 'pending' ? '今日待打卡' : (p.traecode.status === 'failed' ? '凭据过期/异常' : '未关联凭据'))));
        const credEl = document.getElementById('cred-trae');
        if (credEl) credEl.textContent = credentialText(p.traecode);
        const msgEl = document.getElementById('msg-trae');
        if (msgEl) msgEl.textContent = p.traecode.message || '今日尚未执行';
        const rewEl = document.getElementById('reward-trae');
        if (rewEl) rewEl.textContent = p.traecode.credits ? `${p.traecode.credits}${p.traecode.consecutiveDays ? ` (连签${p.traecode.consecutiveDays}天)` : ''}` : '-';
        renderAccountRows('accts-trae', p.traecode.accounts);
        const btnTrae = document.getElementById('btn-run-trae');
        if (btnTrae) {
          btnTrae.disabled = isSigned;
          btnTrae.textContent = isSigned ? '今日已签' : '立即签到';
        }
      }

      // 3. CodeArts
      if (p.codearts) {
        const isSigned = p.codearts.status === 'success' || p.codearts.status === 'already';
        updateBadge('badge-ca', p.codearts.status, p.codearts.status === 'success' ? '今日已签到' : (p.codearts.status === 'already' ? '今日已签' : (p.codearts.status === 'pending' ? '今日待打卡' : (p.codearts.status === 'failed' ? '签到失败' : '未关联凭据'))));
        const credEl = document.getElementById('cred-ca');
        if (credEl) credEl.textContent = credentialText(p.codearts);
        const msgEl = document.getElementById('msg-ca');
        if (msgEl) msgEl.textContent = p.codearts.message || '今日尚未执行';
        const rewEl = document.getElementById('reward-ca');
        if (rewEl) rewEl.textContent = p.codearts.credits ? `${p.codearts.credits}` : '-';
        renderAccountRows('accts-ca', p.codearts.accounts);
        const btnCa = document.getElementById('btn-run-ca');
        if (btnCa) {
          btnCa.disabled = isSigned;
          btnCa.textContent = isSigned ? '今日已签' : '立即签到';
        }
      }

      // 4. Qoder (国际版)
      if (p.qoder) {
        const isSigned = p.qoder.status === 'success' || p.qoder.status === 'already';
        updateBadge('badge-qd', p.qoder.status, p.qoder.status === 'success' ? '今日已领取' : (p.qoder.status === 'already' ? '今日已签' : (p.qoder.status === 'pending' ? '今日待打卡' : (p.qoder.status === 'failed' ? '签到失败' : '未关联凭据'))));
        const credEl = document.getElementById('cred-qd');
        if (credEl) credEl.textContent = credentialText(p.qoder);
        const msgEl = document.getElementById('msg-qd');
        if (msgEl) msgEl.textContent = p.qoder.message || '今日尚未执行';
        const rewEl = document.getElementById('reward-qd');
        if (rewEl) rewEl.textContent = p.qoder.credits ? `${p.qoder.credits} Credits` : '-';
        renderAccountRows('accts-qd', p.qoder.accounts);
        const btnQd = document.getElementById('btn-run-qd');
        if (btnQd) {
          btnQd.disabled = isSigned;
          btnQd.textContent = isSigned ? '今日已签' : '立即签到';
        }
      }

      // 5. Qoder CN (国内版)
      if (p['qoder-cn']) {
        const qdcn = p['qoder-cn'];
        const isSigned = qdcn.status === 'success' || qdcn.status === 'already';
        updateBadge('badge-qdcn', qdcn.status, qdcn.status === 'success' ? '今日已领取' : (qdcn.status === 'already' ? '今日已签' : (qdcn.status === 'pending' ? '今日待打卡' : (qdcn.status === 'failed' ? '签到失败' : '未关联凭据'))));
        const credEl = document.getElementById('cred-qdcn');
        if (credEl) credEl.textContent = credentialText(qdcn);
        const msgEl = document.getElementById('msg-qdcn');
        if (msgEl) msgEl.textContent = qdcn.message || '今日尚未执行';
        const rewEl = document.getElementById('reward-qdcn');
        if (rewEl) rewEl.textContent = qdcn.credits ? `${qdcn.credits} Credits` : '-';
        renderAccountRows('accts-qdcn', qdcn.accounts);
        const btnQdcn = document.getElementById('btn-run-qdcn');
        if (btnQdcn) {
          btnQdcn.disabled = isSigned;
          btnQdcn.textContent = isSigned ? '今日已签' : '立即签到';
        }
      }

      // 6. MiniMax Code（海螺 AI / mcode）
      if (p.minimaxcode) {
        const mm = p.minimaxcode;
        const isSigned = mm.status === 'success' || mm.status === 'already';
        updateBadge('badge-mm', mm.status, mm.status === 'success' ? '今日已领取' : (mm.status === 'already' ? '今日已签' : (mm.status === 'pending' ? '今日待打卡' : (mm.status === 'failed' ? '签到失败' : '未关联凭据'))));
        const credEl = document.getElementById('cred-mm');
        if (credEl) credEl.textContent = credentialText(mm);
        const msgEl = document.getElementById('msg-mm');
        if (msgEl) msgEl.textContent = mm.message || '今日尚未执行';
        const rewEl = document.getElementById('reward-mm');
        if (rewEl) rewEl.textContent = mm.credits ? `${mm.credits} 积分${mm.consecutiveDays ? ` (连签${mm.consecutiveDays}天)` : ''}` : (mm.consecutiveDays ? `连签${mm.consecutiveDays}天` : '-');
        renderAccountRows('accts-mm', mm.accounts);
        const btnMm = document.getElementById('btn-run-mm');
        if (btnMm) {
          btnMm.disabled = isSigned;
          btnMm.textContent = isSigned ? '今日已签' : '立即签到';
        }
      }

      // 7. Meoo（秒悟）
      if (p.meoo) {
        const mo = p.meoo;
        const isSigned = mo.status === 'success' || mo.status === 'already';
        updateBadge('badge-meoo', mo.status, mo.status === 'success' ? '已登录' : (mo.status === 'already' ? '今日已签' : (mo.status === 'failed' ? '签到失败' : '未关联凭据')));
        const credEl = document.getElementById('cred-meoo');
        if (credEl) credEl.textContent = credentialText(mo);
        const msgEl = document.getElementById('msg-meoo');
        if (msgEl) msgEl.textContent = mo.message || '今日尚未执行';
        const rewEl = document.getElementById('reward-meoo');
        if (rewEl) rewEl.textContent = mo.credits ? `${mo.credits} 积分` : '-';
        renderAccountRows('accts-meoo', mo.accounts);
        const btnMo = document.getElementById('btn-run-meoo');
        if (btnMo) {
          btnMo.disabled = isSigned;
          btnMo.textContent = isSigned ? '登录态正常' : '刷新登录态';
        }
      }

      // 账号级补签：worker 侧新加的账号当天也必须能签。
      // 平台级状态是「已签」时旧逻辑会把按钮锁死，于是「上午签完、下午加号」永远补不上。
      // 只要还有账号没签（pendingAccounts > 0），按钮就保持可用，并直接写明待补个数。
      document.querySelectorAll('.btn-do-checkin').forEach((btn) => {
        const key = btn.dataset.platform;
        const info = key ? p[key] : null;
        if (!info) return;
        const settled = info.status === 'success' || info.status === 'already';
        const pending = Number(info.pendingAccounts) || 0;
        if (!settled) { btn.disabled = false; return; }
        if (pending > 0) {
          btn.disabled = false;
          btn.textContent = key === 'meoo' ? `补签 ${pending} 个账号` : `补签新增账号 ${pending}`;
          btn.title = `还有 ${pending} 个账号今天没签（多为在 worker 里新加的），点一下补签`;
        } else {
          btn.disabled = true;
          btn.title = '';
          if (key === 'meoo') btn.textContent = '登录态正常';
        }
      });

      // 顶部统计胶囊
      if (overallPill) {
        const plats = [p.workbuddy, p.codebuddy, p.traecode, p.codearts, p.qoder, p['qoder-cn'], p.minimaxcode].filter(Boolean);   // meoo 只同步登录态，不计入签到数
        const signedCount = plats.filter(x => x.status === 'success' || x.status === 'already').length;
        overallPill.textContent = `${signedCount}/${plats.length} 平台已签到 · ${data.autoCheckin !== false ? '每日自动打卡激活' : '自动打卡已暂停'}`;
      }

      // 历史记录
      const history = data.history || [];
      if (histCountSpan) histCountSpan.textContent = String(history.length);
      if (logContainer) {
        if (history.length === 0) {
          logContainer.innerHTML = '<div class="checkin-log-empty">暂无签到历史记录</div>';
        } else {
          logContainer.innerHTML = history.map(item => {
            const platMeta = {
              workbuddy: ['腾讯 WorkBuddy', '#60a5fa'],
              codebuddy: ['CodeBuddy 国际版', '#38bdf8'],
              traecode: ['ByteDance Trae', '#c084fc'],
              codearts: ['华为云 CodeArts', '#f87171'],
              qoder: ['Qoder', '#2ADB5C'],
              'qoder-cn': ['Qoder CN', '#34d399'],
              minimaxcode: ['MiniMax Code', '#f43f5e'],
              meoo: ['Meoo 秒悟', '#34d399'],
            }[item.platform] || ['其他平台', '#94a3b8'];
            const platName = platMeta[0];
            const platColor = platMeta[1];
            const platBg = `${platColor}26`;
            const isErr = item.status === 'failed';
            return `
              <div class="checkin-log-item">
                <span class="checkin-log-time">${escapeHtml(item.time || '')}</span>
                <span class="checkin-log-plat-badge" style="background:${platBg};color:${platColor};border:1px solid ${platColor}44">${escapeHtml(platName)}</span>
                <span class="checkin-log-msg" style="color:${isErr ? '#f87171' : 'var(--gem-text)'}">${escapeHtml(item.message || '')}</span>
              </div>
            `;
          }).join('');
        }
      }
    };

    // 请求状态
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/checkin/status');
        if (res.ok) {
          const json = await res.json();
          renderOverview(json);
        }
      } catch (err) {
        console.error('[Checkin] 获取签到状态失败:', err);
      }
    };

    // 执行签到
    const executeCheckin = async (platform, btn) => {
      if (btn) {
        btn.disabled = true;
        btn.textContent = '签到中...';
      }
      try {
        const res = await fetch('/api/checkin/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform })
        });
        const json = await res.json();
        if (json.ok && json.overview) {
          renderOverview(json.overview);
        }
      } catch (err) {
        alert('签到请求异常: ' + err.message);
      } finally {
        if (btn) btn.disabled = false;
      }
    };

    // 绑定 Tab 切换
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const target = btn.getAttribute('data-tab');
        Object.entries(tabContents).forEach(([k, el]) => {
          if (el) el.hidden = (k !== target);
        });
      });
    });

    // 横向滑轨：拖动 + 惯性统一走 window.HubRail（script 1 定义），
    // 这里只负责把三个容器挂上去；点击胶囊的 click 不会被吃掉。
    const railDrag = window.HubRail || null;
    if (railDrag) {
      document.querySelectorAll('.checkin-cards-grid, .checkin-platform-tabs, .checkin-nav-tabs').forEach((el) => {
        railDrag.attach(el);
      });
    }

    // 平台胶囊 = 滑轨导航：点哪个，卡片滑轨就平滑滚到那张（不再做筛选）
    // 滑轨本身做无限循环：靠「首尾卡片搬家 + scrollLeft 位置补偿」实现，
    // 不克隆节点（克隆会让 id 重复、renderOverview 更新到假节点）。
    const rail = document.querySelector('.checkin-cards-grid');
    const platTabs = document.querySelectorAll('#checkin-platform-tabs .checkin-plat-tab');
    const railBusyUntil = { t: 0 };
    let railRaf = 0;
    let activeSyncTimer = 0;

    const platOfCard = (el) => String(el?.id || '').replace('card-checkin-', '');
    // 卡片对应的子代理：以卡片内品牌图标的 data-agent 为准（WorkBuddy 卡片的 id 是 workbuddy，
    // 但它的子代理是 codebuddy-cn，主题色要跟着后者）
    const agentOfCard = (card) => card?.querySelector('.checkin-brand-icon[data-agent]')?.getAttribute('data-agent') || platOfCard(card);
    const applyCardAccent = (card) => {
      if (!card) return;
      // AGENT_THEMES 在 script 1 的 IIFE 里，靠 window 导出取；取不到就退回默认色
      const themes = window.AGENT_THEMES || {};
      const theme = themes[agentOfCard(card)] || null;
      if (theme && theme.color) card.style.setProperty('--card-accent', theme.color);
    };
    const railGap = () => {
      if (!rail) return 0;
      const cs = getComputedStyle(rail);
      return parseFloat(cs.columnGap || cs.gap || '0') || 0;
    };
    // 选中态只允许存在一个：胶囊高亮 + 该卡片顶部配色条一起切
    const setActivePlat = (plat) => {
      platTabs.forEach((b) => {
        const on = b.getAttribute('data-plat') === plat;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      if (!rail) return;
      Array.from(rail.children).forEach((card) => {
        card.classList.toggle('is-selected', plat !== 'all' && platOfCard(card) === plat);
      });
    };

    // 让某张卡居中（用相对偏移算，避免 scrollIntoView 顺带滚动整页）
    // 点胶囊 → 把对应卡片对齐到「第二个位置」（第一格留给上一张，形成滑轨感）。
    // 目标卡本来在更左边时，靠搬家补齐前面的空位，所以左右方向都能滑过去。
    const alignCard = (card) => {
      if (!rail || !card) return;
      railBusyUntil.t = Date.now() + 900;
      if (railDrag) {
        railDrag.alignToSlot(rail, card, { slot: 1, loop: true, duration: 480 });
      } else {
        const step = card.offsetWidth + railGap();
        const left = Math.max(0, card.offsetLeft - step);
        try {
          rail.scrollTo({ left, behavior: 'smooth' });
        } catch {
          rail.scrollLeft = left;
        }
      }
    };

    // 循环：始终在轨道两端各留出半张卡的余量，于是可以一直往同一方向滑下去。
    // 每次只搬一张卡（一次 if/else），避免两个 while 互相把 scrollLeft 推回去。
    const rebalanceRail = () => {
      if (!rail || rail.scrollWidth <= rail.clientWidth + 8) return;
      // 拖动过程中不要搬家：drag 的 startLeft 基准会被打乱，手感会跳
      if (rail.classList.contains('dragging')) return;
      if (Date.now() < railBusyUntil.t) return;
      const gap = railGap();
      const first = rail.firstElementChild;
      const last = rail.lastElementChild;
      if (!first || !last || first === last) return;
      const step = first.offsetWidth + gap;
      const max = rail.scrollWidth - rail.clientWidth;
      const margin = Math.max(24, step * 0.5);
      if (rail.scrollLeft < margin) {
        rail.insertBefore(last, first);
        rail.scrollLeft += last.offsetWidth + gap;
      } else if (rail.scrollLeft > max - margin) {
        rail.appendChild(first);
        rail.scrollLeft -= step;
      }
    };

    // 拖动/滚动后把高亮同步到「最靠近轨道中心」的那张卡
    const syncActiveFromScroll = () => {
      if (!rail) return;
      // 程序化滚动（点胶囊）期间不抢主：否则刚点中的气泡会被邻近卡片顶掉，
      // 看起来就像同时亮了两个
      if (Date.now() < railBusyUntil.t) return;
      // 高亮 = 落在「第二个位置」的那张卡（与点击后对齐的规则一致，避免点了 A 亮 B）
      const first = rail.children[0];
      const step = first ? first.offsetWidth + railGap() : 0;
      const anchor = rail.scrollLeft + step;
      let best = null;
      let bestDist = Infinity;
      Array.from(rail.children).forEach((card) => {
        const dist = Math.abs(card.offsetLeft - anchor);
        if (dist < bestDist) { bestDist = dist; best = card; }
      });
      if (best) setActivePlat(platOfCard(best));
    };

    if (rail) {
      // 之前的筛选可能留了 hidden，初始化清掉
      Array.from(rail.children).forEach((c) => { c.hidden = false; applyCardAccent(c); });
      rail.addEventListener('scroll', () => {
        if (railRaf) return;
        railRaf = requestAnimationFrame(() => {
          railRaf = 0;
          rebalanceRail();
          clearTimeout(activeSyncTimer);
          activeSyncTimer = setTimeout(syncActiveFromScroll, 120);
        });
      }, { passive: true });
      // 松手后再补一次循环补偿，保证两端始终有余量
      rail.addEventListener('pointerup', () => setTimeout(rebalanceRail, 0));
      // 首屏保持「全部」高亮，不预先给任何卡片上配色条
      setActivePlat('all');
    }

    platTabs.forEach(btn => {
      btn.addEventListener('click', () => {
        const plat = btn.getAttribute('data-plat') || 'all';
        setActivePlat(plat);
        if (!rail) return;
        const cards = Array.from(rail.children);
        // "全部" = 回到轨道起点（WorkBuddy 那张）
        const target = plat === 'all'
          ? (rail.querySelector('#card-checkin-workbuddy') || cards[0])
          : cards.find((c) => platOfCard(c) === plat);
        if (target) alignCard(target);
      });
    });

    // 刷新按钮：先重读状态，再把「今天还没签成」的平台补签一次。
    // 只重读状态的话，像 Qoder 这种 10:00 才开新一期的平台，早上点了也一直显示已签。
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '刷新中...';
        executeCheckin('due')
          .then(() => fetchStatus())
          .finally(() => {
            refreshBtn.disabled = false;
            refreshBtn.textContent = '↻ 刷新状态';
          });
      });
    }

    // 清空签到日志：只清历史记录，不动各平台今日状态与凭据
    const clearLogBtn = document.getElementById('btn-checkin-log-clear');
    if (clearLogBtn) {
      clearLogBtn.addEventListener('click', async () => {
        const count = (currentCheckinData?.history || []).length;
        if (!count) {
          alert('签到日志已经是空的');
          return;
        }
        if (!confirm(`确定清空全部 ${count} 条签到日志？\n\n只清历史记录，不影响今日签到状态与凭据。`)) return;
        clearLogBtn.disabled = true;
        clearLogBtn.textContent = '清空中...';
        try {
          const res = await fetch('/api/checkin/history/clear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          });
          const json = await res.json();
          if (json.ok && json.overview) {
            renderOverview(json.overview);
            clearLogBtn.textContent = `已清空 ${json.removed || 0} 条`;
            setTimeout(() => { clearLogBtn.textContent = '清空日志'; }, 1800);
            return;
          }
          alert('清空失败：' + (json.error || '未知错误'));
        } catch (err) {
          alert('清空请求异常: ' + err.message);
        } finally {
          clearLogBtn.disabled = false;
          if (clearLogBtn.textContent === '清空中...') clearLogBtn.textContent = '清空日志';
        }
      });
    }

    // 一键全签按钮
    if (checkinAllBtn) {
      checkinAllBtn.addEventListener('click', () => {
        checkinAllBtn.disabled = true;
        checkinAllBtn.textContent = '全签中...';
        executeCheckin('all', checkinAllBtn).finally(() => {
          checkinAllBtn.disabled = false;
          checkinAllBtn.textContent = '一键全签';
        });
      });
    }

    // 单个平台签到按钮
    card.querySelectorAll('.btn-do-checkin').forEach(btn => {
      btn.addEventListener('click', () => {
        const plat = btn.getAttribute('data-platform');
        if (plat) executeCheckin(plat, btn);
      });
    });

    // 配置 Token 按钮
    card.querySelectorAll('.btn-cfg-token').forEach(btn => {
      btn.addEventListener('click', () => {
        const plat = btn.getAttribute('data-platform');
        const promptTips = {
          workbuddy: '请输入 WorkBuddy / CodeBuddy 的 AccessToken 或保持为空自动使用本地凭据：',
          codebuddy: '请输入 CodeBuddy 国际版 AccessToken / JSON（保持为空则自动读取 ~/.codebuddy/）：',
          traecode: '请输入 Trae JWT Token (免客户端请求时使用，或保持为空自动读取 ~/.trae-cn/)：',
          codearts: '请输入华为云 CodeArts Token / Cookie / AK-SK，或保持为空自动读取本地凭据：',
          qoder: '请输入 Qoder 国际版 Bearer Token（保持为空则自动复用 ~/.qoder 的 CLI 凭据）：',
          'qoder-cn': '请输入 Qoder CN Bearer Token（保持为空则自动复用 ~/.qoder-cn 的 CLI 凭据）：',
          minimaxcode: '请输入 MiniMax Code 的 accessToken（保持为空则自动复用 ~/.minimax/auth 下 mcode 的登录态）：'
        };
        const val = prompt(promptTips[plat] || '请输入自定义凭据：', '');
        if (val !== null) {
          const cfg = { customTokens: {} };
          cfg.customTokens[plat] = val.trim();
          fetch('/api/checkin/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cfg)
          }).then(r => r.json()).then(res => {
            if (res.ok && res.overview) renderOverview(res.overview);
            alert('凭据配置已保存并生效！');
          }).catch(e => alert('保存失败: ' + e.message));
        }
      });
    });

    // 自动签到开关
    if (autoCheckbox) {
      autoCheckbox.addEventListener('change', () => {
        fetch('/api/checkin/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ autoCheckin: autoCheckbox.checked })
        }).then(r => r.json()).then(res => {
          if (res.ok && res.overview) renderOverview(res.overview);
        }).catch(e => console.error(e));
      });
    }

    // 首屏加载
    fetchStatus();
  };
  initDailyCheckinModule();
})();
