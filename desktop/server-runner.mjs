import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 1. 解析运行参数与环境变量
const port = parseInt(process.env.HUBCONSOLE_PORT || process.env.PORT || process.argv[2] || '8890', 10);
const host = process.env.HUBCONSOLE_HOST || '127.0.0.1';
const dataDir = process.env.HUBCONSOLE_DATA_DIR || process.argv[3] || path.join(process.cwd(), 'data');
const explicitConsoleDir = process.env.HUBCONSOLE_CONSOLE_DIR || process.argv[4];

// 2. 确定 console 目录与 server.mjs 真实物理路径
function resolveConsoleDir() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicitConsoleDir,
    path.join(currentDir, 'console'),
    path.join(currentDir, '..', 'console'),
    path.join(process.cwd(), 'console'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'server.mjs'))) {
      return candidate;
    }
  }
  throw new Error(`无法找到有效的 console 目录，已检查路径: ${candidates.join(', ')}`);
}

const consoleDir = resolveConsoleDir();
const serverMjsPath = path.join(consoleDir, 'server.mjs');
console.log(`[server-runner] 正在加载后端模块: ${serverMjsPath}`);
console.log(`[server-runner] 监听端口: ${port}, 主机: ${host}, 数据目录: ${dataDir}`);

// 3. 动态载入并启动后端服务
// 注意：console/server.mjs 的 /health 只存在于子代理端口（默认 8790），主端口返回 404；
// 主端口就绪信号用 /dashboard（源码 2294 行同时服务 '/' 与 '/dashboard'）。所以这里不需要
// 对 http.createServer 做任何注入，探活交给主进程轮询 /dashboard。
let disposeBackend = null;
const abortController = new AbortController();

async function run() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });

    const serverModule = await import(pathToFileURL(serverMjsPath).href);
    if (typeof serverModule.start !== 'function') {
      throw new Error(`模块 ${serverMjsPath} 未导出 start 函数`);
    }

    const pluginRoot = path.dirname(consoleDir);

    const context = {
      pluginRoot,
      dataDir,
      listen: {
        host,
        port,
      },
      logger: {
        info: (...args) => console.log('[server:info]', ...args),
        warn: (...args) => console.warn('[server:warn]', ...args),
        debug: (...args) => {
          if (process.env.HUBCONSOLE_DEBUG) console.log('[server:debug]', ...args);
        },
        error: (...args) => console.error('[server:error]', ...args),
      },
      signal: abortController.signal,
    };

    const result = await serverModule.start(context);
    if (result && typeof result.dispose === 'function') {
      disposeBackend = result.dispose;
    }

    console.log(`[server-runner] 后端服务成功启动并就绪: http://${host}:${port}/dashboard`);

    // 通知 Electron 主进程服务就绪（若在 utilityProcess 环境下）
    if (process.parentPort && typeof process.parentPort.postMessage === 'function') {
      process.parentPort.postMessage({ type: 'ready', port });
    }
  } catch (err) {
    console.error('[server-runner] 启动后端服务失败:', err);
    process.exit(1);
  }
}

// 5. 优雅退出生命周期管理
async function handleShutdown() {
  console.log('[server-runner] 收到退出信号，正在关闭服务...');
  abortController.abort();
  if (disposeBackend) {
    try {
      await disposeBackend();
    } catch (err) {
      console.error('[server-runner] 关闭服务时出错:', err);
    }
  }
  process.exit(0);
}

if (process.parentPort) {
  process.parentPort.on('message', (event) => {
    const data = event && event.data ? event.data : event;
    if (data === 'shutdown' || (typeof data === 'object' && data?.type === 'shutdown')) {
      void handleShutdown();
    }
  });
}

process.on('message', (msg) => {
  if (msg === 'shutdown' || (typeof msg === 'object' && msg?.type === 'shutdown')) {
    void handleShutdown();
  }
});

process.on('SIGINT', () => void handleShutdown());
process.on('SIGTERM', () => void handleShutdown());

void run();
