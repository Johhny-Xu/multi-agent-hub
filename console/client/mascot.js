/* ============================================================================
   看板娘（Console Mascot）— 2026-10-20
   一段 10s / 24fps 的循环动画（VP9 + alpha 的 WebM）趴在输入框上沿。
   独立 IIFE，不依赖其它脚本的作用域；只用 window.AGENT_THEMES 取子代理显示名。

   职责：
     1) 跟随输入框高度把 --composer-h 写到 #chat-col，让她始终趴在输入框上沿
     2) 视频解码出首帧后淡入；解不出来（旧浏览器 / 不支持 alpha）就留在静态封面
     3) 点她：跳到随机一个「表情段落」+ 随机一段 CSS 动画 + 说一句话
     4) 消息压到她身上时降透明度；不在视口里 / 面板切走时暂停解码省 CPU
   对外：window.HubMascot = { say, playAnim, react, seek, pause, resume, onDispatch, show, hide, isVisible }
   ========================================================================== */
(function () {
  'use strict';

  var KEY_HIDDEN = 'agenthub.mascot.hidden';
  var KEY_SIZE = 'agenthub.mascot.size';

  var dock = document.getElementById('mascot-dock');
  if (!dock) return;
  var figure = document.getElementById('mascot-figure');
  var frame = dock.querySelector('.mascot-frame');
  var video = document.getElementById('mascot-video');
  var bubble = document.getElementById('mascot-bubble');
  var bubbleText = document.getElementById('mascot-bubble-text');
  var chatCol = document.getElementById('chat-col');
  var composer = document.getElementById('chat-composer');
  var msgs = document.getElementById('chat-msgs');
  var enableBox = document.getElementById('mascot-enable');
  var sizeGroup = document.getElementById('mascot-size-group');
  var sayBtn = document.getElementById('mascot-say-btn');

  // 动画里的表情段落（秒）：挥手 / 说话 / 眨眼吐舌 / 鼓脸 / 生气冒烟 / 惊讶
  // 时间点按 30fps / 8s 的成片换算（240 帧 ÷ 30fps；原 24fps 的秒数 × 0.8）
  var REACTIONS = [
    { t: 1.44, anim: 'bounce' },
    { t: 2.88, anim: 'wiggle' },
    { t: 4.0, anim: 'pop' },
    { t: 5.12, anim: 'squish' },
    { t: 6.08, anim: 'tilt' },
    { t: 7.04, anim: 'bounce' }
  ];
  var WAVE_AT = 1.44;  // 派发成功时跳到这里挥手（30fps 成片里的挥手段落）
  var ANIM_CLASSES = ['anim-bounce', 'anim-wiggle', 'anim-squish', 'anim-tilt', 'anim-pop'];
  var lastReaction = -1;

  // 闲聊池：都是这个控制台里真实会发生的事，别写成通用客服话术
  var IDLE_LINES = [
    '今天几个平台的签到都领了吗？我盯着呢～',
    '13 个子代理都在待命，想派谁就派谁。',
    '派发的时候写清楚 cwd，能少踩一半的坑。',
    '额度快见底的时候记得换号，别跑到一半没米。',
    '有结果我第一时间叫你，你先忙别的。',
    '队列空了，喝口水吧。',
    '想加新 Worker 的话，先看 capabilities.json 再动手。',
    '长会话记得归档，不然列表会越来越长。',
    '我就趴在这儿，不打扰你。'
  ];
  var GREET_LINES = [
    '在的在的，有什么要办的？',
    '嗯？需要我帮你盯任务吗？',
    '点我一下，我今天心情很好～',
    '别急，活儿一件一件来。',
    '要不要先签个到再开工？',
    '我趴这儿半天了，你终于点我了。',
    '再点我一下，我换个表情给你看。'
  ];

  var bubbleTimer = 0;
  var hoverTimer = 0;
  var animTimer = 0;
  var lastSaidAt = 0;
  var inView = true;

  function readPref(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }
  function writePref(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }
  function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  // ---------- 位置：底部裁切线压在输入框上沿 ----------
  var measureQueued = false;
  function syncComposerHeight() {
    measureQueued = false;
    if (!chatCol || !composer) return;
    var colRect = chatCol.getBoundingClientRect();
    var boxRect = composer.getBoundingClientRect();
    if (!colRect.height || !boxRect.height) return; // 面板隐藏时 rect 全是 0，跳过
    var h = Math.round(colRect.bottom - boxRect.top);
    if (h > 0) chatCol.style.setProperty('--composer-h', h + 'px');
  }
  function queueMeasure() {
    if (measureQueued) return;
    measureQueued = true;
    (window.requestAnimationFrame || window.setTimeout)(syncComposerHeight, 16);
  }

  // ---------- 消息压到她身上时降透明度 ----------
  var overlapQueued = false;
  function checkOverlap() {
    overlapQueued = false;
    if (!msgs || dock.hidden) return;
    var d = dock.getBoundingClientRect();
    if (!d.width || !d.height) return;
    var kids = msgs.children;
    var overlapped = false;
    // 从最后一条往前找：一旦某条完全在她上方，更早的也不可能压到她
    for (var i = kids.length - 1; i >= 0; i--) {
      var r = kids[i].getBoundingClientRect();
      if (!r.height) continue;
      if (r.bottom < d.top + 18) break;
      if (r.right > d.left + 12 && r.left < d.right) { overlapped = true; break; }
    }
    dock.classList.toggle('is-overlapped', overlapped);
  }
  function queueOverlap() {
    if (overlapQueued) return;
    overlapQueued = true;
    (window.requestAnimationFrame || window.setTimeout)(checkOverlap, 16);
  }

  // ---------- 视频：解码 / 播放 / 暂停 ----------
  function playVideo() {
    if (!video || !inView || dock.hidden) return;
    var p = video.play();
    if (p && p.catch) p.catch(function () {});
  }
  function pauseVideo() {
    if (!video) return;
    try { video.pause(); } catch (e) {}
  }
  function seek(t) {
    if (!video) return;
    if (video.readyState < 1) {
      // 元数据还没到，等能播了再跳
      video.addEventListener('loadedmetadata', function once() {
        video.removeEventListener('loadedmetadata', once);
        try { video.currentTime = t; } catch (e) {}
      });
      return;
    }
    try { video.currentTime = t; } catch (e) {}
  }

  if (video) {
    var markReady = function () {
      video.classList.add('is-ready');
      var poster = document.getElementById('mascot-poster');
      if (!poster) return;
      // 个别显卡/驱动下 VP9 alpha 会「解码成功但整帧透明」，看起来就是她不见了。
      // 先画一帧到 canvas 验一下真的画出东西了，再藏封面；画不出来就一直留着封面。
      setTimeout(function () {
        var ok = false;
        try {
          var c = document.createElement('canvas');
          c.width = 48;
          c.height = 48;
          var ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(video, 0, 0, 48, 48);
          var data = ctx.getImageData(0, 0, 48, 48).data;
          for (var i = 3; i < data.length; i += 4) {
            if (data[i] > 16) { ok = true; break; }
          }
        } catch (e) {
          ok = true; // 读不到像素就别误判，按正常处理
        }
        if (ok) poster.classList.add('is-hidden');
        else video.style.display = 'none';
      }, 400);
    };
    if (video.readyState >= 2) markReady();
    video.addEventListener('loadeddata', markReady);
    video.addEventListener('error', function () {
      // 解码失败就退回静态封面，别让她整块消失
      video.style.display = 'none';
      var poster = document.getElementById('mascot-poster');
      if (poster) poster.classList.remove('is-hidden');
    });
    playVideo();
  }

  // ---------- 说话 / 播动画 ----------
  function say(text, opts) {
    if (!text) return;
    opts = opts || {};
    bubbleText.textContent = text;
    bubble.classList.add('is-on');
    lastSaidAt = Date.now();
    clearTimeout(bubbleTimer);
    var ms = opts.duration || Math.max(2600, Math.min(8000, text.length * 200));
    bubbleTimer = setTimeout(function () {
      bubble.classList.remove('is-on');
    }, ms);
  }

  function playAnim(name) {
    if (!frame || !name) return;
    for (var i = 0; i < ANIM_CLASSES.length; i++) frame.classList.remove(ANIM_CLASSES[i]);
    void frame.offsetWidth; // 强制重排，同一段动画能连续触发
    frame.classList.add('anim-' + name);
    clearTimeout(animTimer);
    animTimer = setTimeout(function () {
      frame.classList.remove('anim-' + name);
    }, 900);
  }

  // 点一下：跳到随机表情段落 + 随机动画 + 一句话
  function react(forceLine) {
    var idx = Math.floor(Math.random() * REACTIONS.length);
    if (REACTIONS.length > 1 && idx === lastReaction) idx = (idx + 1) % REACTIONS.length;
    lastReaction = idx;
    var r = REACTIONS[idx];
    seek(r.t);
    playVideo();
    playAnim(r.anim);
    say(forceLine || pick(GREET_LINES));
    return r;
  }

  // ---------- 拎起来 → 挣扎 → 松手坠落 → 落地擦汗 ----------
  var air = document.getElementById('mascot-air');
  var airHang = document.getElementById('air-hang');
  var airFall = document.getElementById('air-fall');
  var airWipe = document.getElementById('air-wipe');
  var AIRS = { hang: airHang, fall: airFall, wipe: airWipe };
  var airX = 0, airY = 0, restX = 0, restY = 0, airH = 0;
  var phase = 'idle';            // idle | hold | fall | wipe
  var holding = false, dragging = false;
  var grabDX = 0, grabDY = 0, downX = 0, downY = 0;
  var rafId = 0, wipeTimer = 0, lastDropAt = 0;

  function applyAir() {
    air.style.transform = 'translate3d(' + Math.round(airX) + 'px,' + Math.round(airY) + 'px,0)';
  }

  // 归位坐标：让空中层的底边和输入框上沿那条线对齐（跟常态层同一个落点）
  function syncAirRest() {
    var d = dock.getBoundingClientRect();
    if (!d.width) return;
    airH = air.offsetHeight || d.width * 1.091;
    restX = d.left;
    restY = d.bottom - airH;
    if (phase === 'idle') { airX = restX; airY = restY; applyAir(); }
  }

  function showAir(which) {
    Object.keys(AIRS).forEach(function (k) {
      var v = AIRS[k];
      if (!v) return;
      var on = k === which;
      v.classList.toggle('is-on', on);
      if (on) {
        try { v.currentTime = 0; } catch (e) {}
        var pr = v.play();
        if (pr && pr.catch) pr.catch(function () {});
      } else {
        try { v.pause(); } catch (e) {}
      }
    });
  }

  function enterHold() {
    if (phase !== 'idle' || !mascotOnScreen()) return false;
    syncAirRest();
    phase = 'hold';
    airX = restX; airY = restY; applyAir();
    air.classList.add('is-on');
    dock.classList.add('is-holding');
    showAir('hang');
    return true;
  }

  function leaveHold() {
    air.classList.remove('is-on');
    dock.classList.remove('is-holding');
    showAir(null);
    phase = 'idle';
  }

  // 空中层是 position:fixed 的独立图层，所在面板 hidden 了它也不会跟着消失。
  // 切到设置页时如果她正在挣扎/坠落/擦汗，必须主动收尾，否则动画会继续盖在设置页上；
  // rAF 与擦汗定时器也要一起取消，不然 step() 还会把坐标写回去。
  function abortAir() {
    if (phase === 'idle' && !air.classList.contains('is-on')) return;
    cancelAnimationFrame(rafId);
    clearTimeout(wipeTimer);
    rafId = 0;
    wipeTimer = 0;
    holding = false;
    dragging = false;
    phase = 'idle';
    air.classList.remove('is-on');
    dock.classList.remove('is-holding');
    showAir(null);
  }

  // style.left 是相对 offsetParent（#chat-col）的，落点算的是视口坐标，必须换算
  function dockLeftFromViewportX(viewportX) {
    var op = dock.offsetParent;
    var ox = op ? op.getBoundingClientRect().left : 0;
    return viewportX - ox;
  }

  function setDockViewportX(viewportX) {
    dock.style.right = 'auto';
    dock.style.left = Math.round(dockLeftFromViewportX(viewportX)) + 'px';
  }

  // 落点 = 松手那个鼠标点的正下方（素材里她大致在容器宽度的 50% 处）
  function landXFor(pointerX, w) {
    var c = composer ? composer.getBoundingClientRect() : null;
    var left = pointerX - w * 0.5;
    if (!c || !c.width) return left;
    // 只夹在「输入框上方」这个范围里，别跑到框外面去
    var min = c.left - w * 0.5;
    var max = c.right - w * 0.5;
    if (max < min) return min;
    return Math.max(min, Math.min(max, left));
  }

  function startFall(pointerX) {
    phase = 'fall';
    showAir('fall');
    var fromX = airX, fromY = airY;
    var w = dock.getBoundingClientRect().width || air.offsetWidth || 240;
    // 没传指针坐标（自动彩蛋）就用她当前的中心
    var cx = typeof pointerX === 'number' && isFinite(pointerX) ? pointerX : airX + w * 0.5;
    var toX = landXFor(cx, w);
    var dist = Math.max(80, restY - fromY);
    // 慢一点：按距离给时长，最短 1.1s、最长 2.4s
    var dur = Math.min(2400, Math.max(1100, dist * 2.2));
    var t0 = (window.performance || Date).now();
    cancelAnimationFrame(rafId);
    function step(now) {
      // 坠落途中被切到设置页：立刻停住，别把 fixed 定位的俯冲动画留在设置页上。
      if (!mascotOnScreen()) { abortAir(); return; }
      var p = Math.min(1, (now - t0) / dur);
      var e = p * p;                       // 加速下落
      airY = fromY + (restY - fromY) * e;
      airX = fromX + (toX - fromX) * p;    // 只做小幅水平微调
      applyAir();
      if (p < 1) rafId = requestAnimationFrame(step);
      else land(toX);
    }
    rafId = requestAnimationFrame(step);
  }

  function land(toX) {
    phase = 'wipe';
    // 常态层跟着挪到落点：擦完汗她就留在这个位置，不回最右边
    setDockViewportX(toX);
    try { localStorage.removeItem('agenthub.mascot.x'); } catch (e) {}   // 老版本存过，清掉
    syncAirRest();
    airX = restX; airY = restY; applyAir();
    showAir('wipe');
    playAnim('squish');
    var d = isFinite(airWipe.duration) && airWipe.duration > 0 ? airWipe.duration * 1000 : 1400;
    clearTimeout(wipeTimer);
    wipeTimer = setTimeout(leaveHold, d + 60);
  }

  // 自动彩蛋：没人碰她时，自己先被拎起来一下，再掉回来
  // 她到底在不在屏幕上：切到设置页时 #panel-chat 是 hidden，dock 的 rect 会变成 0，
  // 但 dock.hidden 还是 false —— 不加这个判断，设置页里也会莫名其妙触发一次掉落。
  function mascotOnScreen() {
    if (dock.hidden) return false;
    var r = dock.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // 面板切走（对话 → 设置/任务/笔记）时立刻收掉空中层。
  // IntersectionObserver 只负责暂停常态层视频，管不到 fixed 定位的坠落层；
  // 而 hold / wipe 两个阶段没有 rAF 兜底，必须在这里收尾。
  (function watchPanelSwitch() {
    var panelChat = document.getElementById('panel-chat');
    if (!panelChat || !window.MutationObserver) return;
    new MutationObserver(function () {
      if (phase !== 'idle' && !mascotOnScreen()) abortAir();
    }).observe(panelChat, { attributes: true, attributeFilter: ['hidden', 'class'] });
  })();

  function drop() {
    if (phase !== 'idle' || !mascotOnScreen()) return;
    lastDropAt = Date.now();
    if (!enterHold()) return;
    setTimeout(function () {
      if (phase !== 'hold') return;
      airY = restY - 70;
      applyAir();
      startFall();
    }, 700);
  }

  figure.addEventListener('pointerdown', function (e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (!enterHold()) return;
    e.preventDefault();
    holding = true;
    dragging = false;
    downX = e.clientX;
    downY = e.clientY;
    grabDX = e.clientX - airX;
    grabDY = e.clientY - airY;
    try { figure.setPointerCapture(e.pointerId); } catch (err) {}
  });

  figure.addEventListener('pointermove', function (e) {
    if (!holding) return;
    if (!dragging && Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 5) dragging = true;
    if (!dragging) return;
    airX = e.clientX - grabDX;
    airY = e.clientY - grabDY;
    var w = air.offsetWidth || 240;
    airX = Math.max(-w * 0.3, Math.min(window.innerWidth - w * 0.7, airX));
    airY = Math.max(-airH * 0.45, Math.min(window.innerHeight - 40, airY));
    applyAir();
  });

  function endHold(e) {
    if (!holding) return;
    holding = false;
    try { figure.releasePointerCapture(e.pointerId); } catch (err) {}
    if (!dragging) {           // 只是点了一下：放回去，走「换个表情」
      leaveHold();
      react();
      return;
    }
    var px = e && typeof e.clientX === 'number' && isFinite(e.clientX) && e.clientX > 0 ? e.clientX : null;
    startFall(px);             // 松手 → 落到鼠标点的正下方（拿不到坐标就用她自己当前的中心）
  }
  figure.addEventListener('pointerup', endHold);
  figure.addEventListener('pointercancel', endHold);

  // ---------- 显隐 ----------
  function applyVisible(visible, animate) {
    if (enableBox) enableBox.checked = !!visible;
    if (visible) {
      dock.hidden = false;
      if (animate) {
        dock.classList.remove('is-entering');
        void dock.offsetWidth;
        dock.classList.add('is-entering');
        setTimeout(function () { dock.classList.remove('is-entering'); }, 700);
      }
      syncComposerHeight();
      checkOverlap();
      playVideo();
      return;
    }
    bubble.classList.remove('is-on');
    pauseVideo();
    abortAir();
    if (!animate) {
      dock.hidden = true;
      return;
    }
    dock.classList.add('is-leaving');
    setTimeout(function () {
      dock.hidden = true;
      dock.classList.remove('is-leaving');
    }, 260);
  }

  function show(persist) {
    applyVisible(true, true);
    if (persist) writePref(KEY_HIDDEN, '0');
    say(pick(GREET_LINES));
  }

  function hide(persist) {
    applyVisible(false, true);
    if (persist) writePref(KEY_HIDDEN, '1');
  }

  // ---------- 交互 ----------
  figure.addEventListener('mouseenter', function () {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(function () {
      // 刚说过话就别追着说，避免悬停即刷屏
      if (Date.now() - lastSaidAt < 2200) return;
      if (dock.hidden) return;
      say(pick(IDLE_LINES));
    }, 340);
  });
  figure.addEventListener('mouseleave', function () {
    clearTimeout(hoverTimer);
  });

  bubble.addEventListener('click', function () {
    bubble.classList.remove('is-on');
    clearTimeout(bubbleTimer);
  });

  // ---------- 设置页 ----------
  function applySize(size) {
    var allowed = { s: 1, m: 1, l: 1 };
    var next = allowed[size] ? size : 'm';
    document.documentElement.setAttribute('data-mascot-size', next);
    if (sizeGroup) {
      var btns = sizeGroup.querySelectorAll('[data-size]');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', btns[i].getAttribute('data-size') === next);
      }
    }
    return next;
  }

  if (enableBox) {
    enableBox.addEventListener('change', function () {
      if (enableBox.checked) show(true);
      else hide(true);
    });
  }
  if (sizeGroup) {
    sizeGroup.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-size]') : null;
      if (!btn) return;
      var size = applySize(btn.getAttribute('data-size'));
      writePref(KEY_SIZE, size);
      syncComposerHeight();
      checkOverlap();
    });
  }
  if (sayBtn) {
    sayBtn.addEventListener('click', function () {
      if (dock.hidden) {
        show(true);
        return;
      }
      react();
    });
  }

  // ---------- 派发联动 ----------
  function onDispatch(agent) {
    if (dock.hidden) return;
    var themes = window.AGENT_THEMES || {};
    var label = (themes[agent] && themes[agent].label) || agent || '子代理';
    seek(WAVE_AT);
    playVideo();
    playAnim('bounce');
    say('收到！已经派给 ' + label + ' 啦，我帮你盯着～', { duration: 5200 });
  }

  window.HubMascot = {
    say: say,
    playAnim: playAnim,
    react: react,
    seek: seek,
    pause: pauseVideo,
    resume: playVideo,
    onDispatch: onDispatch,
    drop: drop,
    show: function () { show(true); },
    hide: function () { hide(true); },
    isVisible: function () { return !dock.hidden; }
  };

  // ---------- 初始化 ----------
  // 恢复上次的落点（她可以被丢在输入框上方任意位置）
  // ?mascot=1 强制唤回（清掉「已收起」的偏好）—— 万一哪天被收起又找不到开关，加这个参数就行
  if (/(?:^|[?&])mascot=1(?:&|$)/.test(location.search)) writePref(KEY_HIDDEN, '0');
  applySize(readPref(KEY_SIZE, 'm'));
  applyVisible(readPref(KEY_HIDDEN, '0') !== '1', false);

  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function () { queueMeasure(); queueOverlap(); });
    if (composer) ro.observe(composer);
    if (chatCol) ro.observe(chatCol);
  }
  window.addEventListener('resize', function () {
    queueMeasure();
    queueOverlap();
    if (dock.style.left) {
      var dr = dock.getBoundingClientRect();
      setDockViewportX(landXFor(dr.left + dr.width * 0.5, dr.width || 240));
    }
    syncAirRest();
  });
  if (msgs) {
    msgs.addEventListener('scroll', queueOverlap, { passive: true });
    if (window.MutationObserver) {
      new MutationObserver(function () { queueOverlap(); }).observe(msgs, { childList: true, subtree: true });
    }
  }

  // 不在视口里（切到设置页 / 她被收起）就别解码，弱机上省一大截 CPU
  if (window.IntersectionObserver) {
    new IntersectionObserver(function (entries) {
      inView = entries[0].isIntersecting;
      if (inView) playVideo(); else pauseVideo();
    }, { threshold: 0.01 }).observe(dock);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') playVideo();
    else pauseVideo();
  });

  // 每隔 45~75 秒自己「被拎起来掉一次」
  (function loopDrop() {
    var wait = 45000 + Math.random() * 30000;
    setTimeout(function () {
      if (document.visibilityState === 'visible' && mascotOnScreen() && !dock.classList.contains('is-overlapped')) drop();
      loopDrop();
    }, wait);
  })();

  // 空闲时偶尔自己嘀咕一句（45s 一次，只在页面可见且没在说话时）
  setInterval(function () {
    if (document.visibilityState !== 'visible') return;
    if (dock.hidden || dock.classList.contains('is-overlapped')) return;
    if (bubble.classList.contains('is-on')) return;
    if (Date.now() - lastSaidAt < 45000) return;
    say(pick(IDLE_LINES));
  }, 45000);

  // 输入框高度会随字体加载 / 模型选择器渲染变化，多补量几次，避免她没跟上位置被框盖住
  queueMeasure();
  queueOverlap();
  window.addEventListener('load', function () { queueMeasure(); queueOverlap(); });
  setTimeout(function () { queueMeasure(); queueOverlap(); }, 300);
  setTimeout(function () { queueMeasure(); queueOverlap(); }, 1200);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { queueMeasure(); queueOverlap(); });
  }
})();
