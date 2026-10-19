const vscode = require('vscode');
const http = require('http');
const https = require('https');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Standard worker catalog
const STANDARD_WORKERS = [
  { id: 'antigravity', name: 'Antigravity', defaultModel: 'gemini-3.8-flash-medium', desc: 'Google Antigravity 官方子代理与多模态 (6 款精炼模型)' },
  { id: 'codebuddy', name: 'CodeBuddy 国际版', defaultModel: 'deepseek-v4.1-flash', desc: 'DeepSeek 驱动的标准代码代理 (18 款高可用模型)' },
  { id: 'codebuddy-cn', name: 'CodeBuddy 国内版', defaultModel: 'deepseek-v4.1-flash', desc: '国内高速代码辅助 (13 款模型, 标注 x0.06 ~ x2.00 积分倍率)' },
  { id: 'github-copilot', name: 'GitHub Copilot', defaultModel: 'auto', desc: 'GitHub Copilot CLI 任务适配' },
  { id: 'mimocode', name: 'MiMo', defaultModel: 'xiaomi/mimo-v2.6-flash', desc: 'Xiaomi MiMo 高性价比推理与代码生成 (4 款精选)' },
  { id: 'minimaxcode', name: 'MiniMax', defaultModel: 'MiniMax-M3.1-Flash-Preview', desc: 'MiniMax 当季旗舰图文与代码分析 (M3.1 Flash / M3)' },
  { id: 'traecode', name: 'TraeCode', defaultModel: 'GLM-5.3-FlashX', desc: '字节 TraeCode 任务调度 (20 款官方模型, 0.06x ~ 1.50x 折扣倍率)' },
  { id: 'zcode', name: 'ZCode', defaultModel: 'GLM-5.3-Flash', desc: '智谱 ZCode 编程代理' },
  { id: 'codearts', name: 'CodeArts (码道)', defaultModel: 'GLM-5.2', desc: '华为云码道官方企业级模型 (4 款已验证高可用模型, 0.70x)' },
  { id: 'opencode', name: 'opencode', defaultModel: '', desc: 'opencode run --format json 无头模式 (provider/model 继承本地配置)' },
  { id: 'cline', name: 'Cline', defaultModel: '', desc: 'Cline CLI --json 无头模式 (Cline 登录或自带 Key)' }
];

// Refined model catalog per worker
const WORKER_MODELS = {
  antigravity: [
    'gemini-3.8-flash-medium (默认)',
    'gemini-3.8-flash-high',
    'gemini-3.1-pro-high',
    'claude-sonnet-4-6 (Thinking)',
    'claude-opus-4-6-thinking'
  ],
  codebuddy: [
    'deepseek-v4.1-flash (默认)',
    'deepseek-v4-pro',
    'gpt-5.5',
    'glm-5.3',
    'glm-5.2',
    'kimi-k3',
    'kimi-k2.8-preview',
    'grok-4.7',
    'custom-local:trae'
  ],
  'codebuddy-cn': [
    'deepseek-v4.1-flash (默认 · x0.11)',
    'deepseek-v4-pro (x0.51)',
    'minimax-m3 (x0.25)',
    'glm-5.3 (x0.79)',
    'glm-5.3-flash (x0.06)',
    'glm-5.2 (x0.79)',
    'glm-5.1 (x0.79)',
    'kimi-k3-1 (x1.62)',
    'kimi-k2.8-preview (x0.77)',
    'kimi-k2.7 (x0.57)',
    'hy4-preview (x0.29 · 试用)',
    'hunyuan-chat (x0.10)'
  ],
  'github-copilot': [
    'auto (默认)'
  ],
  mimocode: [
    'xiaomi/mimo-v2.6-flash (默认 · 26f)',
    'mimo-v2.6-pro',
    'mimo-v2.6-pro-ultraspeed',
    '9router/trae (通道)'
  ],
  minimaxcode: [
    'MiniMax-M3.1-Flash-Preview (默认 · 512K/1M)',
    'MiniMax-M3 (1M 上下文)'
  ],
  traecode: [
    'GLM-5.3-FlashX (默认 · 0.31x)',
    'glm-5.3-flash (0.06x)',
    'glm-5.3 (0.78x · 会员 5 折)',
    'glm-5.2 (0.78x · 会员 5 折)',
    'MiMo-V2.6-Flash (0.06x)',
    'MiMo-V2.6-Pro (0.15x)',
    'deepseek-v4.1-flash (0.20x · 限时折扣)',
    'DeepSeek-V4-Flash (0.20x · 限时折扣)',
    'DeepSeek-V4-Pro (0.72x · 限时折扣)',
    'qwen3.8-flash (0.08x)',
    'qwen-3.7-plus (0.25x)',
    'qwen3.8-max (1.50x)',
    'Doubao-Seed-Evolving (0.08x · 限时 1 折)',
    'Doubao-Seed-2.1-Pro (0.08x · 限时 1 折)',
    'Doubao-Seed-2.1-Turbo (0.20x · 专属补贴)',
    'Doubao-Seed-Code (0.06x · 专属补贴)',
    'kimi-k3 (1.50x)',
    'kimi-k2.8-preview (0.60x)',
    'minimax-m3 (0.25x)',
    'step-5-preview (0.50x)'
  ],
  zcode: [
    'GLM-5.3-Flash (默认)'
  ],
  codearts: [
    'GLM-5.2 (默认 · 0.70x)',
    'GLM-5.2-ArkTS-SPARK (0.70x)',
    'OpenPangu-2.0-Pro (0.70x)',
    'OpenPangu-2.0-Flash (0.35x)'
  ],
  opencode: [
    '按 opencode 配置 (provider/model)'
  ],
  cline: [
    '按 cline 配置 (provider/model)'
  ]
};

// Optional known cluster tokens from external environment only (never hardcode private IPs or tokens)
const KNOWN_TOKENS = {};

let statusBarItem;
let statusProvider;
let workersProvider;
let actionsProvider;
let heartbeatTimer;

function getClientConfigPaths() {
  const paths = [];
  if (process.env.AGENTHUB_CONFIG && process.env.AGENTHUB_CONFIG.trim()) {
    paths.push(path.resolve(process.env.AGENTHUB_CONFIG.trim()));
  }
  if (os.platform() === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    paths.push(path.join(localAppData, 'AgentHub', 'client.json'));
    paths.push(path.join(localAppData, 'AgentHub-CodeArts', 'client.json'));
  } else {
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    paths.push(path.join(xdgConfig, 'agenthub', 'client.json'));
    paths.push(path.join(xdgConfig, 'agenthub-codearts', 'client.json'));
  }
  return paths;
}

function readClientConfig() {
  const paths = getClientConfigPaths();
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf8');
        const data = JSON.parse(content);
        if (data.url) {
          return { path: p, url: data.url, token: data.token || '' };
        }
      }
    } catch (e) {}
  }
  return { path: paths[0], url: '', token: '' };
}

function writeClientConfig(url, token) {
  const paths = getClientConfigPaths();
  const payload = { url, token: token || undefined };
  for (const p of paths) {
    try {
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {}
  }
  return paths[0];
}

function fetchJson(urlStr, token, timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === 'https:';
      const client = isHttps ? https : http;
      const headers = { 'User-Agent': 'multi-agent-hub-vscode/0.9.9' };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const req = client.request(u, { method: 'GET', headers, timeout: timeoutMs }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
          } catch (e) {
            resolve({ ok: false, status: res.statusCode, raw: body, error: 'INVALID_JSON' });
          }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: 'TIMEOUT' });
      });
      req.on('error', (err) => {
        resolve({ ok: false, error: err.message });
      });
      req.end();
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

function postJsonRpc(urlStr, token, method = 'ping', params = {}, timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === 'https:';
      const client = isHttps ? https : http;
      const body = JSON.stringify({ jsonrpc: '2.0', id: 'check-' + Date.now(), method, params });
      const bodyBuf = Buffer.from(body, 'utf-8');
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'multi-agent-hub-vscode/0.9.9',
        'Content-Length': String(bodyBuf.length)
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const req = client.request(u, { method: 'POST', headers, timeout: timeoutMs }, (res) => {
        let resBody = '';
        res.on('data', (chunk) => { resBody += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(resBody);
            resolve({ ok: res.statusCode === 200 && !data.error, status: res.statusCode, data });
          } catch (e) {
            resolve({ ok: false, status: res.statusCode, raw: resBody, error: 'INVALID_JSON' });
          }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: 'TIMEOUT' });
      });
      req.on('error', (err) => {
        resolve({ ok: false, error: err.message });
      });
      req.write(body);
      req.end();
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

async function checkHubStatus() {
  const cfg = readClientConfig();
  if (!cfg.url) {
    return { connected: false, reason: '未配置 Hub 地址 (请点击此处免密连接)' };
  }
  const base = cfg.url.replace(/\/mcp\/?$/, '');
  const healthUrl = `${base}/health`;
  const t0 = Date.now();
  const res = await fetchJson(healthUrl, cfg.token, 2500);
  const latency = Date.now() - t0;

  if (res.ok && res.data) {
    // If hub requires auth, verify MCP ping as well
    if (res.data.auth_required) {
      const pingRes = await postJsonRpc(cfg.url, cfg.token, 'ping', {}, 2500);
      if (!pingRes.ok) {
        // If 401 and we have a known token for this host, attempt auto-recovery
        try {
          const u = new URL(cfg.url);
          const autoToken = KNOWN_TOKENS[u.hostname];
          if (autoToken && autoToken !== cfg.token) {
            writeClientConfig(cfg.url, autoToken);
            cfg.token = autoToken;
            const retryPing = await postJsonRpc(cfg.url, cfg.token, 'ping', {}, 2500);
            if (retryPing.ok) {
              return {
                connected: true,
                url: cfg.url,
                token: cfg.token,
                version: res.data.version || '0.9.9',
                status: res.data.status || 'ok',
                authRequired: true,
                latency,
                configPath: cfg.path
              };
            }
          }
        } catch (e) {}

        return {
          connected: false,
          url: cfg.url,
          error: pingRes.status === 401 ? '需要鉴权令牌 (401 Unauthorized)' : `MCP 握手失败 (${pingRes.status || pingRes.error})`,
          configPath: cfg.path
        };
      }
    }

    return {
      connected: true,
      url: cfg.url,
      token: cfg.token,
      version: res.data.version || '0.9.9',
      status: res.data.status || 'ok',
      authRequired: res.data.auth_required || false,
      latency,
      configPath: cfg.path
    };
  }

  return {
    connected: false,
    url: cfg.url,
    error: res.error || `HTTP ${res.status}`,
    configPath: cfg.path
  };
}

function updateStatusBar(st) {
  // Dispose old item to completely eliminate stuck warningBackground colors in Theia/CodeArts
  if (statusBarItem) {
    statusBarItem.dispose();
  }

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'multiAgentHub.status';

  if (st && st.connected) {
    statusBarItem.text = `$(radio-tower) Hub: 在线 (${st.latency || 0}ms)`;
    statusBarItem.tooltip = `Multi-Agent Hub 在线 (v${st.version || '0.9.9'})\n端点: ${st.url}\n11 种 Worker 适配器已就绪\n(点击查看状态与快捷菜单)`;
  } else {
    statusBarItem.text = `$(alert) Hub: 离线`;
    const reason = (st && (st.error || st.reason)) ? (st.error || st.reason) : '尚未连接';
    statusBarItem.tooltip = `Multi-Agent Hub 离线: ${reason}\n(点击一键免密发现与连接)`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  statusBarItem.show();
}

async function refreshAllStatus() {
  const st = await checkHubStatus();
  updateStatusBar(st);
  if (statusProvider) statusProvider.refresh(st);
  if (workersProvider) workersProvider.refresh();
  return st;
}

class StatusTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.cachedState = null;
  }
  refresh(st) {
    this.cachedState = st || null;
    this._onDidChangeTreeData.fire();
  }
  async getChildren() {
    const st = this.cachedState || await checkHubStatus();
    updateStatusBar(st);

    const items = [];
    if (st.connected) {
      items.push(new vscode.TreeItem(`状态: 在线 (0.9.9, ${st.latency}ms)`, vscode.TreeItemCollapsibleState.None));
      items.push(new vscode.TreeItem(`端点: ${st.url}`, vscode.TreeItemCollapsibleState.None));
      items.push(new vscode.TreeItem(`鉴权: ${st.authRequired ? '已启用 (免密令牌匹配)' : '免密直连'}`, vscode.TreeItemCollapsibleState.None));
      items.push(new vscode.TreeItem(`配置: ${st.configPath}`, vscode.TreeItemCollapsibleState.None));
    } else {
      items.push(new vscode.TreeItem(`状态: 离线 (${st.error || st.reason})`, vscode.TreeItemCollapsibleState.None));
      if (st.url) {
        items.push(new vscode.TreeItem(`目标: ${st.url}`, vscode.TreeItemCollapsibleState.None));
      }
      items.push(new vscode.TreeItem('提示: 点击下方“免密发现与连接”完成配对', vscode.TreeItemCollapsibleState.None));
    }

    // Workspace sync status
    const ws = vscode.workspace.workspaceFolders;
    if (ws && ws.length > 0) {
      const root = ws[0].uri.fsPath;
      const mcpPath = path.join(root, '.codeartsdoer', 'mcp', 'mcp_settings.json');
      const synced = fs.existsSync(mcpPath);
      items.push(new vscode.TreeItem(`工作区 MCP: ${synced ? '已同步 (.codeartsdoer)' : '待同步'}`, vscode.TreeItemCollapsibleState.None));
    }

    return items;
  }
  getTreeItem(item) {
    return item;
  }
}

class WorkersTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }
  refresh() {
    this._onDidChangeTreeData.fire();
  }
  getChildren(element) {
    if (!element) {
      return STANDARD_WORKERS.map((w) => {
        const models = WORKER_MODELS[w.id] || [];
        const hasChildren = models.length > 0;
        const item = new vscode.TreeItem(
          `${w.name}`,
          hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );
        item.description = `[${w.defaultModel}]`;
        item.tooltip = `${w.name} (${w.id})\n默认模型: ${w.defaultModel}\n支持模型: ${models.length} 款\n说明: ${w.desc}`;
        item.iconPath = new vscode.ThemeIcon('hub');
        item.workerId = w.id;
        return item;
      });
    }
    // Child items (models)
    const models = WORKER_MODELS[element.workerId] || [];
    return models.map((m) => {
      const item = new vscode.TreeItem(m, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('symbol-property');
      return item;
    });
  }
  getTreeItem(item) {
    return item;
  }
}

class ActionsTreeProvider {
  getChildren() {
    const actions = [
      { label: '⚡ 一键免密发现与连接 Hub', command: 'multiAgentHub.discover' },
      { label: '⚙️ 手动设置 Hub 地址', command: 'multiAgentHub.setConnection' },
      { label: '🔄 一键同步当前工作区 CodeArts MCP', command: 'multiAgentHub.syncWorkspace' },
      { label: '🌐 打开 Hub Web 控制台', command: 'multiAgentHub.openConsole' },
      { label: '🔁 刷新所有状态', command: 'multiAgentHub.refresh' }
    ];
    return actions.map((a) => {
      const item = new vscode.TreeItem(a.label, vscode.TreeItemCollapsibleState.None);
      item.command = { command: a.command, title: a.label };
      return item;
    });
  }
  getTreeItem(item) {
    return item;
  }
}

// Automatically sync MCP settings to the active workspace
async function syncWorkspaceMcp(silent = false) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    if (!silent) vscode.window.showWarningMessage('当前未打开任何工作区目录，无法同步 MCP 设置');
    return false;
  }

  const workspaceRoot = folders[0].uri.fsPath;
  const cfg = readClientConfig();
  const clientConfigPath = cfg.path;

  // Extension bundled bridge
  const extPath = path.resolve(__dirname);
  const bundledServer = path.join(extPath, 'mcp', 'server.mjs');

  const mcpDir = path.join(workspaceRoot, '.codeartsdoer', 'mcp');
  if (!fs.existsSync(mcpDir)) {
    fs.mkdirSync(mcpDir, { recursive: true });
  }

  const mcpSettingsPath = path.join(mcpDir, 'mcp_settings.json');
  let existing = { mcpServers: {} };
  if (fs.existsSync(mcpSettingsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(mcpSettingsPath, 'utf8'));
      if (!existing.mcpServers) existing.mcpServers = {};
    } catch (e) {
      existing = { mcpServers: {} };
    }
  }

  const serverConfig = {
    command: 'node',
    args: [bundledServer],
    env: {
      AGENTHUB_CONFIG: clientConfigPath,
      AGENTHUB_CONNECTION_MODE: 'file'
    },
    disabled: false,
    timeout: 600
  };

  // Register canonical multi-agent-hub MCP server and clean up legacy duplicate
  existing.mcpServers['multi-agent-hub'] = serverConfig;
  delete existing.mcpServers['agenthub-hub-bridge'];

  fs.writeFileSync(mcpSettingsPath, JSON.stringify(existing, null, 2), 'utf8');

  // Also ensure client.json exists at AgentHub-CodeArts path
  if (os.platform() === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const caClientDir = path.join(localAppData, 'AgentHub-CodeArts');
    if (!fs.existsSync(caClientDir)) fs.mkdirSync(caClientDir, { recursive: true });
    const caClientPath = path.join(caClientDir, 'client.json');
    try {
      fs.writeFileSync(caClientPath, JSON.stringify({ url: cfg.url, token: cfg.token || undefined }, null, 2), 'utf8');
    } catch (e) {}
  }

  if (!silent) {
    vscode.window.showInformationMessage(
      `已成功为当前工作区注入 CodeArts MCP 配置！\n文件: .codeartsdoer/mcp/mcp_settings.json\n重载窗口后即可在云码道中使用 @hub-* 子代理与命令。`
    );
  }
  return true;
}

// Discover candidate Hubs on localhost and LAN
async function discoverHubs() {
  const candidates = [];
  const ports = [8765, 18765];

  // 1. Probe localhost
  for (const port of ports) {
    const url = `http://127.0.0.1:${port}/health`;
    const res = await fetchJson(url, null, 800);
    if (res.ok && res.data) {
      candidates.push({
        label: `$(vm) 本机 Hub (127.0.0.1:${port})`,
        description: `v${res.data.version || '1.0.15'} · 免密可用`,
        detail: `端点: http://127.0.0.1:${port}/mcp`,
        url: `http://127.0.0.1:${port}/mcp`,
        host: '127.0.0.1',
        authRequired: res.data.auth_required
      });
    }
  }

  // 2. Configured LAN hosts probe (from environment if provided)
  const knownIps = (process.env.AGENTHUB_KNOWN_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const ip of knownIps) {
    const url = `http://${ip}:8765/health`;
    const res = await fetchJson(url, null, 800);
    if (res.ok && res.data && !candidates.some((c) => c.url.includes(ip))) {
      candidates.push({
        label: `$(server) 局域网 Hub (${ip}:8765)`,
        description: `v${res.data.version || '1.0.15'} · 自动免密配对`,
        detail: `端点: http://${ip}:8765/mcp`,
        url: `http://${ip}:8765/mcp`,
        host: ip,
        authRequired: res.data.auth_required
      });
    }
  }

  // 3. UDP LAN discovery
  await new Promise((resolve) => {
    let socket;
    try {
      socket = dgram.createSocket('udp4');
      socket.on('message', (msg, rinfo) => {
        try {
          const text = msg.toString('utf8');
          if (text.startsWith('AGENTHUB') || text.includes('port:')) {
            const m = text.match(/port:(\d+)/);
            const port = m ? m[1] : '8765';
            const lanUrl = `http://${rinfo.address}:${port}/mcp`;
            if (!candidates.some((c) => c.url === lanUrl)) {
              candidates.push({
                label: `$(server) 局域网 Hub (${rinfo.address}:${port})`,
                description: `来自 UDP 广播响应 · 自动免密配对`,
                detail: `端点: ${lanUrl}`,
                url: lanUrl,
                host: rinfo.address,
                authRequired: true
              });
            }
          }
        } catch (e) {}
      });
      socket.bind(0, () => {
        try {
          socket.setBroadcast(true);
          const probe = Buffer.from('DISCOVER agenthub 0.8.0+');
          socket.send(probe, 0, probe.length, 18766, '255.255.255.255', () => {});
        } catch (e) {}
      });
    } catch (e) {}

    setTimeout(() => {
      if (socket) {
        try { socket.close(); } catch (e) {}
      }
      resolve();
    }, 1200);
  });

  return candidates;
}

function activate(context) {
  // 1. Initial Status Bar Item creation
  updateStatusBar({ connected: false, reason: '检测中...' });

  // 2. Tree Data Providers
  statusProvider = new StatusTreeProvider();
  workersProvider = new WorkersTreeProvider();
  actionsProvider = new ActionsTreeProvider();

  vscode.window.registerTreeDataProvider('multiAgentHub.statusView', statusProvider);
  vscode.window.registerTreeDataProvider('multiAgentHub.workersView', workersProvider);
  vscode.window.registerTreeDataProvider('multiAgentHub.actionsView', actionsProvider);

  // 3. Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('multiAgentHub.refresh', async () => {
      await refreshAllStatus();
    }),

    vscode.commands.registerCommand('multiAgentHub.status', async () => {
      const st = await refreshAllStatus();
      if (st.connected) {
        vscode.window.showInformationMessage(
          `Multi-Agent Hub 连接正常！\n版本: ${st.version} | 延时: ${st.latency}ms\n地址: ${st.url}\n已准备 11 种 Worker 适配。`
        );
      } else {
        const pick = await vscode.window.showErrorMessage(
          `Multi-Agent Hub 离线: ${st.error || st.reason}`,
          '⚡ 一键免密发现与连接',
          '手动输入地址'
        );
        if (pick === '⚡ 一键免密发现与连接') {
          vscode.commands.executeCommand('multiAgentHub.discover');
        } else if (pick === '手动输入地址') {
          vscode.commands.executeCommand('multiAgentHub.setConnection');
        }
      }
    }),

    vscode.commands.registerCommand('multiAgentHub.discover', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '正在扫描本机与局域网 Multi-Agent Hub...' },
        async () => {
          const candidates = await discoverHubs();
          if (candidates.length === 0) {
            const manual = await vscode.window.showWarningMessage(
              '未在局域网或本机发现活跃 Hub，是否手动输入连接地址？',
              '手动输入',
              '取消'
            );
            if (manual === '手动输入') {
              vscode.commands.executeCommand('multiAgentHub.setConnection');
            }
            return;
          }

          const selected = await vscode.window.showQuickPick(candidates, {
            placeHolder: '选择要连接的 Multi-Agent Hub 目标 (免密直连)'
          });

          if (selected) {
            // Automatic passwordless pairing:
            // 1. Check if token already exists in current config
            const curr = readClientConfig();
            let token = curr.token || '';

            // 2. Check known cluster tokens
            if (!token && KNOWN_TOKENS[selected.host]) {
              token = KNOWN_TOKENS[selected.host];
            }

            // Save immediately without prompting for password!
            writeClientConfig(selected.url, token);
            await syncWorkspaceMcp(true);
            const st = await refreshAllStatus();

            if (st.connected) {
              vscode.window.showInformationMessage(`已完成免密配对并连接至 Hub: ${selected.url}！工作区 MCP 已自动同步。`);
            } else {
              vscode.window.showWarningMessage(`已连接至 ${selected.url}，但状态检查返回: ${st.error || '未响应'}`);
            }
          }
        }
      );
    }),

    vscode.commands.registerCommand('multiAgentHub.setConnection', async () => {
      const curr = readClientConfig();
      const url = await vscode.window.showInputBox({
        prompt: '请输入 Multi-Agent Hub 地址 (免密直接保存，无需运行 connect.cmd)',
        value: curr.url || 'http://127.0.0.1:8765/mcp'
      });
      if (!url) return;

      const trimmedUrl = url.trim();
      let token = curr.token || '';
      try {
        const u = new URL(trimmedUrl);
        if (!token && KNOWN_TOKENS[u.hostname]) {
          token = KNOWN_TOKENS[u.hostname];
        }
      } catch (e) {}

      // Save directly without modal prompt
      writeClientConfig(trimmedUrl, token);
      await syncWorkspaceMcp(true);
      const st = await refreshAllStatus();

      if (st.connected) {
        vscode.window.showInformationMessage(`Hub 连接已免密更新并生效！工作区 MCP 配置已自动同步。`);
      } else {
        vscode.window.showInformationMessage(`Hub 连接设置已更新至: ${trimmedUrl} (状态: ${st.error || '检查中'})`);
      }
    }),

    vscode.commands.registerCommand('multiAgentHub.syncWorkspace', async () => {
      await syncWorkspaceMcp(false);
      await refreshAllStatus();
    }),

    vscode.commands.registerCommand('multiAgentHub.openConsole', () => {
      const cfg = readClientConfig();
      let consoleUrl = 'http://127.0.0.1:8890';
      if (cfg.url) {
        try {
          const u = new URL(cfg.url);
          consoleUrl = `${u.protocol}//${u.hostname}:8890`;
        } catch (e) {}
      }
      vscode.env.openExternal(vscode.Uri.parse(consoleUrl));
    })
  );

  // Initial check & auto-sync
  refreshAllStatus();
  syncWorkspaceMcp(true);

  // Background heartbeat every 8 seconds to keep bottom-left status bar live
  heartbeatTimer = setInterval(() => {
    refreshAllStatus();
  }, 8000);
}

function deactivate() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (statusBarItem) statusBarItem.dispose();
}

module.exports = { activate, deactivate };
