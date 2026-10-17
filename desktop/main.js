const { app, BrowserWindow, ipcMain, shell, dialog, utilityProcess } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

// ============================================================================
// 1. 单实例锁机制 (Single Instance Lock)
// 确保同一时间只有一个客户端主程序在运行，防止多开导致数据目录冲突和资源争抢
// ============================================================================
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.warn('[main] 检测到已有实例正在运行，本实例将自动退出。');
  app.quit();
  process.exit(0);
}

// ============================================================================
// 全局状态与配置
// ============================================================================
let mainWindow = null;
let backendProcess = null;
let currentBackendPort = 8890;
let crashRestartCount = 0;
const MAX_CRASH_RESTARTS = 1; // 崩溃自动重启至多 1 次
let isAppQuitting = false;
let cleanupDone = false;

// ============================================================================
// 0. 日志落盘
// 打包后 stdout 看不见（GUI 子系统进程不接控制台），用户报障时没有任何凭据。
// 主进程与后端的输出统一追加到 <userData>/logs/main-YYYYMMDD.log，按天自然滚动。
// ============================================================================
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
function appendLog(level, line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    fs.appendFileSync(path.join(LOG_DIR, `main-${ymd}.log`), `${d.toISOString()} [${level}] ${line}\n`);
  } catch { /* 日志失败不能影响主流程 */ }
}
const _log = console.log.bind(console);
const _err = console.error.bind(console);
const _fmt = (a) => a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ');
console.log = (...a) => { const l = _fmt(a); _log(l); appendLog('info', l); };
console.error = (...a) => { const l = _fmt(a); _err(l); appendLog('error', l); };

// ============================================================================
// 2. 运行时路径解析
// 打包状态 (app.isPackaged == true):
//   - 主进程代码位于 resources/app.asar 中
//   - console 目录通过 extraResources 打包，位于 process.resourcesPath/console
// 开发状态 (app.isPackaged == false):
//   - 优先读取本地 ./console 或上级 ../console
// ============================================================================
function getConsolePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'console');
  }

  const devCandidates = [
    path.join(__dirname, 'console'),
    path.join(__dirname, '..', 'console'),
    path.resolve(__dirname, '..', 'src', 'multi-agent-hub', 'console'),
  ];

  for (const candidate of devCandidates) {
    if (fs.existsSync(path.join(candidate, 'server.mjs'))) {
      return candidate;
    }
  }

  // 兜底回退
  return path.join(process.resourcesPath, 'console');
}

function getRunnerPath() {
  const runnerFile = 'server-runner.mjs';
  const runnerPath = path.join(__dirname, runnerFile);
  if (fs.existsSync(runnerPath)) {
    return runnerPath;
  }
  return path.join(process.resourcesPath, runnerFile);
}

// 数据目录：%APPDATA%/MultiAgentHub/data (Windows 规范)
function getDataDir() {
  const userDataDir = app.getPath('userData');
  const dataDir = process.env.HUBCONSOLE_DATA_DIR || path.join(userDataDir, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

// ============================================================================
// 3. 端口自适应分配 (Port Adaptation)
// 检测端口是否被占用，自 8890 起自动寻找可用端口，避免与其他程序冲突
// ============================================================================
function isPortAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function findAvailablePort(startPort = 8890, maxScan = 100, host = '127.0.0.1') {
  for (let port = startPort; port < startPort + maxScan; port++) {
    const available = await isPortAvailable(port, host);
    if (available) {
      return port;
    }
  }
  throw new Error(`在范围 ${startPort} - ${startPort + maxScan} 内未找到可用端口`);
}

// ============================================================================
// 4. 后端就绪轮询 (Readiness Probe)
// 注意：console/server.mjs 的 /health 只在子代理端口（8790）存在，主端口是 404，
// 所以这里探 /dashboard（源码同时服务 '/' 与 '/dashboard'），200 即视为就绪。
// ============================================================================
async function waitForHealth(port, maxWaitMs = 25000, intervalMs = 200) {
  const startTime = Date.now();
  const healthUrl = `http://127.0.0.1:${port}/dashboard`;
  console.log(`[main] 开始轮询后端就绪状态: ${healthUrl}`);

  while (Date.now() - startTime < maxWaitMs) {
    if (isAppQuitting) return false;
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        console.log(`[main] 后端服务已就绪 (耗时 ${Date.now() - startTime}ms)`);
        return true;
      }
    } catch (err) {
      // 端口未监听或连接被拒绝，继续等待
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`后端服务未能就绪 (超时 ${maxWaitMs}ms, URL: ${healthUrl})`);
}

// ============================================================================
// 5. 启动与管理后端子进程
// 方案选型理由（utilityProcess.fork VS child_process.spawn）：
//   【选型】：选用 Electron 提供的 utilityProcess.fork！
//   【理由】：
//     1. 零环境依赖：Windows 最终用户机器上不需要安装 Node.js。utilityProcess 直接使用
//        Electron 自带的 Node.js 运行时，彻底规避目标机器缺少 Node 或 Node 版本过低的问题。
//     2. 内存与通信隔离：运行在独立的子进程中，具备天然的进程隔离与崩溃隔离机制，
//        不会占用主进程事件循环，且原生提供父子 IPC 通信 channel。
//     3. 完善的生命周期管理：原生挂载 exit / spawn 事件，能精准捕获崩溃退出并触发重试。
// ============================================================================
async function startBackend() {
  const port = await findAvailablePort(8890);
  currentBackendPort = port;
  const consoleDir = getConsolePath();
  const runnerPath = getRunnerPath();
  const dataDir = getDataDir();

  console.log('[main] 启动后端服务...');
  console.log(`[main] - consoleDir: ${consoleDir}`);
  console.log(`[main] - runnerPath: ${runnerPath}`);
  console.log(`[main] - dataDir:    ${dataDir}`);
  console.log(`[main] - port:       ${port}`);

  if (!fs.existsSync(consoleDir)) {
    throw new Error(`找不到 console 资源目录: ${consoleDir}`);
  }
  if (!fs.existsSync(runnerPath)) {
    throw new Error(`找不到后端启动引导脚本: ${runnerPath}`);
  }

  backendProcess = utilityProcess.fork(runnerPath, [String(port), dataDir, consoleDir], {
    env: {
      ...process.env,
      PORT: String(port),
      HUBCONSOLE_PORT: String(port),
      HUBCONSOLE_HOST: '127.0.0.1',
      HUBCONSOLE_DATA_DIR: dataDir,
      HUBCONSOLE_CONSOLE_DIR: consoleDir,
    },
    stdio: 'pipe',
  });

  backendProcess.stdout?.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.log(`[Backend] ${text}`);
  });

  backendProcess.stderr?.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.error(`[Backend Error] ${text}`);
  });

  backendProcess.on('exit', (code) => {
    console.warn(`[main] 后端子进程退出，退出码: ${code}`);
    backendProcess = null;

    if (!isAppQuitting) {
      if (crashRestartCount < MAX_CRASH_RESTARTS) {
        crashRestartCount++;
        console.warn(`[main] 后端异常崩溃，准备自动重启 (${crashRestartCount}/${MAX_CRASH_RESTARTS})...`);
        setTimeout(async () => {
          try {
            await startBackend();
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.loadURL(`http://127.0.0.1:${currentBackendPort}/dashboard`);
            }
          } catch (err) {
            console.error('[main] 重启后端失败:', err);
            dialog.showErrorBox(
              '服务异常',
              `后端服务崩溃且重启失败：\n${err.message}\n应用即将退出。`
            );
            app.quit();
          }
        }, 1200);
      } else {
        console.error('[main] 后端连续崩溃已达上限，终止重启。');
        dialog.showErrorBox(
          '服务不可用',
          'Multi-Agent Hub 后端进程发生不可恢复的错误已停止运行，请检查日志。应用即将退出。'
        );
        app.quit();
      }
    }
  });

  // 等待 /health 探针就绪
  await waitForHealth(port);
  return port;
}

// 退出时彻底终结后端子进程
function stopBackend() {
  if (backendProcess) {
    console.log('[main] 正在终止后端子进程...');
    try {
      backendProcess.postMessage({ type: 'shutdown' });
    } catch (e) {
      /* ignore */
    }

    const procToKill = backendProcess;
    backendProcess = null;

    setTimeout(() => {
      try {
        procToKill.kill();
      } catch (e) {
        /* ignore */
      }
    }, 600);
  }
}

// ============================================================================
// 6. 创建主应用窗口
// ============================================================================
function createMainWindow(port) {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    show: false, // 等待页面加载完毕再显示，防止白屏闪烁
    backgroundColor: '#0f172a',
    title: 'Multi-Agent Hub 控制台',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 只 require('electron')，不开 Node 集成也能跑，开沙箱更安全
      sandbox: true,
      webSecurity: true,
    },
  });

  // 隐藏顶部默认原生菜单栏（如需按 Alt 可临时呼出）
  mainWindow.setMenuBarVisibility(false);

  // 加载本地后端控制台页面
  const targetUrl = `http://127.0.0.1:${port}/dashboard`;
  console.log(`[main] 窗口加载 URL: ${targetUrl}`);
  mainWindow.loadURL(targetUrl);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // 首屏加载失败不能只停在 show:false——用户会看到一个"没反应"的进程。
  // 常见诱因：后端刚就绪窗口就 loadURL，或后端崩溃重启换了端口。重试 3 次后强制亮窗。
  let loadRetries = 0;
  mainWindow.webContents.on('did-fail-load', (event, code, desc, url, isMain) => {
    if (!isMain || isAppQuitting) return;
    if (loadRetries < 3) {
      loadRetries++;
      console.warn(`[main] 页面加载失败(${code} ${desc})，1.5s 后重试 ${loadRetries}/3: ${url}`);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) void mainWindow.loadURL(targetUrl);
      }, 1500);
    } else {
      console.error('[main] 页面连续加载失败，强制显示窗口');
      if (!mainWindow.isVisible()) mainWindow.show();
    }
  });

  // 拦截外链点击，统一使用系统默认浏览器打开，保障客户端安全
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ============================================================================
// 7. IPC 安全通信通道注册
// ============================================================================
function registerIpcHandlers() {
  ipcMain.handle('shell:openExternal', async (event, url) => {
    if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  ipcMain.on('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize();
    }
  });

  ipcMain.on('window:maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });

  ipcMain.on('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });

  ipcMain.handle('window:isMaximized', () => {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow.isMaximized() : false;
  });
}

// ============================================================================
// 8. 应用程序生命周期事件
// ============================================================================
app.on('second-instance', () => {
  // 当第二个实例尝试启动时，激活并聚焦当前主窗口
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// GPU 兜底：部分环境（虚拟机、远程桌面、无独立显卡的服务器会话、部分驱动）会让
// GPU 进程反复崩溃，Electron 随后以 "GPU process isn't usable. Goodbye." 直接退出。
// 这个界面是纯 CSS 渲染，软件光栅足够用，所以默认关掉硬件加速换稳定性。
// 需要硬件加速时设 HUBCONSOLE_GPU=1 即可恢复。
if (process.env.HUBCONSOLE_GPU !== '1') {
  app.disableHardwareAcceleration();
  // disableHardwareAcceleration 只是"不启用"，某些环境仍会拉起 GPU 进程并崩溃
  // （0xC0000005），再显式关掉 GPU 进程与 GPU 合成，彻底走软件光栅。
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

app.whenReady().then(async () => {
  registerIpcHandlers();

  try {
    const port = await startBackend();
    createMainWindow(port);
  } catch (err) {
    console.error('[main] 应用初始化失败:', err);
    dialog.showErrorBox(
      '启动失败',
      `Multi-Agent Hub 启动遇到严重错误：\n${err.message}\n请检查本地端口或日志。`
    );
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(currentBackendPort);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    isAppQuitting = true;
    app.quit();
  }
});

// before-quit / will-quit / exit 会连着触发三次，cleanup 只做一次；
// stopBackend 自身也有 null 守卫，这里再加闸门避免重复 postMessage / kill。
const cleanupAndExit = () => {
  if (cleanupDone) return;
  cleanupDone = true;
  isAppQuitting = true;
  appendLog('info', 'app cleanup: stopping backend');
  stopBackend();
};

app.on('before-quit', cleanupAndExit);
app.on('will-quit', cleanupAndExit);
process.on('SIGINT', () => { cleanupAndExit(); process.exit(0); });
process.on('SIGTERM', () => { cleanupAndExit(); process.exit(0); });
