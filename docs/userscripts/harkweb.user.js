// ==UserScript==
// @name         OpenMausBot HarkWeb Bridge
// @namespace    https://openmausbot.org/
// @version      1.1.0
// @description  Tampermonkey bridge for Hark Web Chat native browser automation
// @match        https://hark.com/*
// @match        https://*.hark.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_WS_URL = "ws://127.0.0.1:8801/api/web-chat/ws";

  function getStoredValue(key, fallback) {
    if (typeof GM_getValue === "function") {
      try {
        return GM_getValue(key, fallback);
      } catch {}
    }
    return fallback;
  }

  function setStoredValue(key, val) {
    if (typeof GM_setValue === "function") {
      try {
        GM_setValue(key, val);
      } catch {}
    }
  }

  const configuredUrl = getStoredValue("omb_ws_url", DEFAULT_WS_URL);
  const configuredToken = getStoredValue("omb_ws_token", "");

  if (typeof GM_registerMenuCommand === "function") {
    try {
      GM_registerMenuCommand("设置服务地址 (Set Service URL)", () => {
        const current = getStoredValue("omb_ws_url", DEFAULT_WS_URL);
        const input = prompt("请输入 OpenMausBot 服务 WebSocket 地址：", current);
        if (input !== null) {
          setStoredValue("omb_ws_url", input.trim());
          location.reload();
        }
      });

      GM_registerMenuCommand("设置连接 Token (Set Auth Token)", () => {
        const current = getStoredValue("omb_ws_token", "");
        const input = prompt("请输入 OpenMausBot 鉴权 Token：", current);
        if (input !== null) {
          setStoredValue("omb_ws_token", input.trim());
          location.reload();
        }
      });
    } catch {}
  }

  const rawBase = configuredUrl || DEFAULT_WS_URL;
  const token = configuredToken || "";
  const wsUrl = rawBase + (token ? (rawBase.includes("?") ? "&" : "?") + `token=${encodeURIComponent(token)}` : "");

  const tabId = "tab-" + Math.random().toString(36).slice(2, 10);

  let ws = null;
  let activeTurnId = null;
  let activeSelectors = null;
  let activeObserver = null;
  let stabilityTimer = null;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function log(...args) {
    console.log("[OMB HarkWeb Bridge]", ...args);
  }

  function connect() {
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      log("WebSocket connection failed, retrying in 3s...", err);
      setTimeout(connect, 3000);
      return;
    }

    ws.onopen = () => {
      log("Connected to OpenMausBot web-chat bridge. Tab ID:", tabId);
      ws.send(JSON.stringify({
        type: "register",
        tabId,
        url: window.location.href,
        title: document.title,
      }));
    };

    ws.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "prompt") {
        await handlePrompt(msg);
      } else if (msg.type === "cancel") {
        handleCancel(msg);
      }
    };

    ws.onclose = () => {
      log("WebSocket closed, reconnecting in 3s...");
      cleanupActiveTurn();
      setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      try { ws.close(); } catch {}
    };
  }

  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "heartbeat", tabId }));
    }
  }, 15000);

  function cleanupActiveTurn() {
    if (activeObserver) {
      activeObserver.disconnect();
      activeObserver = null;
    }
    if (stabilityTimer) {
      clearTimeout(stabilityTimer);
      stabilityTimer = null;
    }
    activeTurnId = null;
    activeSelectors = null;
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function queryFirstVisible(selector) {
    const parts = selector.split(',').map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      try {
        const els = document.querySelectorAll(part);
        for (const el of els) {
          if (isVisible(el)) return el;
        }
      } catch {}
    }
    return null;
  }

  async function handlePrompt(msg) {
    const { turnId, text, selectors, minDelayMs = 1000, maxDelayMs = 3000 } = msg;
    cleanupActiveTurn();
    activeTurnId = turnId;
    activeSelectors = selectors;

    // 1-3 seconds random delay
    const delay = Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1)) + minDelayMs;
    log(`Prompt received for turn ${turnId}. Waiting ${delay}ms before interaction...`);
    await sleep(delay);

    if (activeTurnId !== turnId) return;

    // Check logged out selector
    if (selectors.loggedOutSelector) {
      const loggedOutEl = queryFirstVisible(selectors.loggedOutSelector);
      if (loggedOutEl) {
        ws.send(JSON.stringify({
          type: "error",
          turnId,
          error: "未在浏览器中登录 Hark。请先在页面上完成登录。",
        }));
        cleanupActiveTurn();
        return;
      }
    }

    const inputEl = queryFirstVisible(selectors.input);
    if (!inputEl) {
      ws.send(JSON.stringify({
        type: "error",
        turnId,
        error: `Input element (${selectors.input}) not found on page.`,
      }));
      cleanupActiveTurn();
      return;
    }

    // Set input value natively
    inputEl.focus();
    if (inputEl.isContentEditable) {
      inputEl.textContent = text;
      inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } else {
      inputEl.value = text;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    await sleep(300);
    if (activeTurnId !== turnId) return;

    // Click submit button
    const submitBtn = selectors.submitButton ? queryFirstVisible(selectors.submitButton) : null;
    if (submitBtn) {
      submitBtn.click();
    } else {
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }

    let lastSentText = "";
    let stableSince = Date.now();
    const stabilityMs = 1500;

    function getAssistantText() {
      const parts = selectors.assistantMessage.split(',').map((s) => s.trim()).filter(Boolean);
      for (const part of parts) {
        try {
          const els = document.querySelectorAll(part);
          if (els.length > 0) {
            const last = els[els.length - 1];
            return (last.innerText || last.textContent || "").trim();
          }
        } catch {}
      }
      return "";
    }

    function isStopButtonVisible() {
      if (!selectors.stopButton) return false;
      return Boolean(queryFirstVisible(selectors.stopButton));
    }

    // Start observing DOM changes for incremental response
    activeObserver = new MutationObserver(() => {
      const currentText = getAssistantText();
      if (currentText && currentText !== lastSentText) {
        lastSentText = currentText;
        stableSince = Date.now();
        ws.send(JSON.stringify({
          type: "text_delta",
          turnId,
          text: currentText,
        }));
      }
    });

    activeObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Check completion in polling loop
    const pollInterval = setInterval(() => {
      if (activeTurnId !== turnId) {
        clearInterval(pollInterval);
        return;
      }

      const generating = isStopButtonVisible();
      const currentText = getAssistantText();
      if (currentText && currentText !== lastSentText) {
        lastSentText = currentText;
        stableSince = Date.now();
        ws.send(JSON.stringify({
          type: "text_delta",
          turnId,
          text: currentText,
        }));
      }

      if (!generating && currentText && (Date.now() - stableSince >= stabilityMs)) {
        clearInterval(pollInterval);
        log(`Turn ${turnId} completed. Text length: ${currentText.length}`);
        ws.send(JSON.stringify({
          type: "done",
          turnId,
          text: currentText,
        }));
        cleanupActiveTurn();
      }
    }, 200);
  }

  function handleCancel(msg) {
    if (activeTurnId === msg.turnId) {
      log(`Cancelling turn ${msg.turnId}...`);
      if (activeSelectors?.stopButton) {
        const stopBtn = queryFirstVisible(activeSelectors.stopButton);
        if (stopBtn) {
          try {
            stopBtn.click();
            log("Clicked stop button to cancel generation");
          } catch (e) {
            log("Failed to click stop button:", e);
          }
        }
      }
      cleanupActiveTurn();
    }
  }

  connect();
})();
