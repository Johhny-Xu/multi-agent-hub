const vscode = require('vscode');
const http = require('http');
const https = require('https');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Standard worker catalog
const STANDARD_WORKERS = [
  { id: 'antigravity', name: 'Antigravity', defaultModel: 'gemini-3.8-flash-medium', desc: 'Google Antigravity 官方子代理与多模态' },
  { id: 'codebuddy', name: 'CodeBuddy 国际版', defaultModel: 'deepseek-v4.1-flash', desc: 'DeepSeek 驱动的标准代码代理' },
  { id: 'codebuddy-cn', name: 'CodeBuddy 国内版', defaultModel: 'deepseek-v4.1-flash', desc: '国内高速代码辅助' },
  { id: 'github-copilot', name: 'GitHub Copilot', defaultModel: 'auto', desc: 'GitHub Copilot CLI 任务适配' },
  { id: 'mimocode', name: 'MiMo', defaultModel: 'xiaomi/mimo-v2.6-flash (26f)', desc: 'Xiaomi MiMo 高性价比推理与代码生成' },
  { id: 'minimaxcode', name: 'MiniMax', defaultModel: 'MiniMax-M3.1-Flash-Preview', desc: 'MiniMax 图文与代码分析' },
  { id: 'traecode', name: 'TraeCode', defaultModel: 'GLM-5.3-FlashX', desc: '字节 TraeCode 任务调度' },
  { id: 'zcode', name: 'ZCode', defaultModel: 'GLM-5.3-Flash', desc: '智谱 ZCode 编程代理' },
  { id: 'codearts', name: 'CodeArts (码道)', defaultModel: 'huaweicloud-maas/GLM-5.2', desc: '华为云码道 CLI / IDE 官方内核' }
];

let statusBarItem;
let statusProvider;
let workersProvider;
let actionsProvider;

function getClientConfigPath() {
  if (process.env.AGENTHUB_CONFIG && process.env.AGENTHUB_CONFIG.trim()) {
    return path.resolve(process.env.AGENTHUB_CONFIG.trim());
  }
  if (os.platform() === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const cand1 = path.join(localAppData, 'AgentHub-CodeArts', 'client.json');
    if (fs.existsSync(cand1)) return cand1;
    return path.join(localAppData, 'AgentHub', 'client.json');
  } else {
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    const cand1 = path.join(xdgConfig, 'agenthub-codearts', 'client.json');
    if (fs.existsSync(cand1)) return cand1;
    return path.join(xdgConfig, 'agenthub', 'client.json');
  }
}

function readClientConfig() {
  const p = getClientConfigPath();
  try {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8');
      const data = JSON.parse(content);
      return { path: p, url: data.url || '', token: data.token || '' };
    }
  } catch (err) {
    // Ignore parse error
  }
  return { path: p, url: '', token: '' };
}

function writeClientConfig(url, token) {
  const p = getClientConfigPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const payload = { url, token: token || undefined };
  fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8');
  return p;
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

async function checkHubStatus() {
  const cfg = readClientConfig();
  if (!cfg.url) {
    return { connected: false, reason: '未配置 Hub 地址 (client.json 未就绪)' };
  }
  const base = cfg.url.replace(/\/mcp\/?$/, '');
  const healthUrl = `${base}/health`;
  const t0 = Date.now();
  const res = await fetchJson(healthUrl, cfg.token, 3000);
  const latency = Date.now() - t0;
  if (res.ok && res.data) {
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

class StatusTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.lastState = null;
  }
  refresh() {
    this._onDidChangeTreeData.fire();
  }
  async getChildren() {
    const st = await checkHubStatus();
    this.lastState = st;
    updateStatusBar(st);

    const items = [];
    if (st.connected) {
      items.push(new vscode.TreeItem(`状态: 在线 (0.9.9, ${st.latency}ms)`, vscode.TreeItemCollapsibleState.None));
      items.push(new vscode.TreeItem(`端点: ${st.url}`, vscode.TreeItemCollapsibleState.None));
      items.push(new vscode.TreeItem(`鉴权: ${st.authRequired ? '已启用 (Token 匹配)' : '关闭'}`, vscode.TreeItemCollapsibleState.None));
      items.push(new vscode.TreeItem(`配置: ${st.configPath}`, vscode.TreeItemCollapsibleState.None));
    } else {
      items.push(new vscode.TreeItem(`状态: 离线 (${st.error || st.reason})`, vscode.TreeItemCollapsibleState.None));
      if (st.url) {
        items.push(new vscode.TreeItem(`目标: ${st.url}`, vscode.TreeItemCollapsibleState.None));
      }
      items.push(new vscode.TreeItem('提示: 点击下方“扫描与发现 Hub”连接', vscode.TreeItemCollapsibleState.None));
    }

    // Workspace sync status
    const ws = vscode.workspace.workspaceFolders;
    if (ws && ws.length > 0) {
      const root = ws[0].uri.fsPath;
      const mcpPath = path.join(root, '.codeartsdoer', 'mcp', 'mcp_settings.json');
      const synced = fs.existsSync(mcpPath);
      items.push(new vscode.TreeItem(`工作区 MCP: ${synced ? '已配置 (.codeartsdoer)' : '待同步'}`, vscode.TreeItemCollapsibleState.None));
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
  getChildren() {
    return STANDARD_WORKERS.map((w) => {
      const item = new vscode.TreeItem(`${w.name}`, vscode.TreeItemCollapsibleState.None);
      item.description = `[${w.defaultModel}]`;
      item.tooltip = `${w.name} (${w.id})\n默认模型: ${w.defaultModel}\n说明: ${w.desc}`;
      item.iconPath = new vscode.ThemeIcon('hub');
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
      { label: '🔍 扫描与发现 Hub (Discover)', command: 'multiAgentHub.discover' },
      { label: '⚙️ 手动设置 Hub 地址与 Token', command: 'multiAgentHub.setConnection' },
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

function updateStatusBar(st) {
  if (!statusBarItem) return;
  if (st.connected) {
    statusBarItem.text = `$(radio-tower) Hub: 在线 (${st.latency}ms)`;
    statusBarItem.tooltip = `Multi-Agent Hub 在线 (v${st.version})\n端点: ${st.url}\n9 个 Worker 已就绪`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = `$(alert) Hub: 离线`;
    statusBarItem.tooltip = `Multi-Agent Hub 尚未连接\n原因: ${st.error || st.reason}\n点击配置连接`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  statusBarItem.show();
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

  existing.mcpServers['agenthub-hub-bridge'] = {
    command: 'node',
    args: [bundledServer],
    env: {
      AGENTHUB_CONFIG: clientConfigPath,
      AGENTHUB_CONNECTION_MODE: 'file'
    }
  };

  fs.writeFileSync(mcpSettingsPath, JSON.stringify(existing, null, 2), 'utf8');

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
        description: `v${res.data.version || '0.9.9'} · 运行正常`,
        detail: `端点: http://127.0.0.1:${port}/mcp`,
        url: `http://127.0.0.1:${port}/mcp`,
        authRequired: res.data.auth_required
      });
    }
  }

  // 2. UDP LAN discovery
  await new Promise((resolve) => {
    let finished = false;
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
                description: `来自 UDP 广播响应`,
                detail: `端点: ${lanUrl}`,
                url: lanUrl,
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
  // 1. Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'multiAgentHub.status';
  statusBarItem.text = '$(radio-tower) Hub: 检测中...';
  context.subscriptions.push(statusBarItem);

  // 2. Tree Data Providers
  statusProvider = new StatusTreeProvider();
  workersProvider = new WorkersTreeProvider();
  actionsProvider = new ActionsTreeProvider();

  vscode.window.registerTreeDataProvider('multiAgentHub.statusView', statusProvider);
  vscode.window.registerTreeDataProvider('multiAgentHub.workersView', workersProvider);
  vscode.window.registerTreeDataProvider('multiAgentHub.actionsView', actionsProvider);

  // 3. Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('multiAgentHub.refresh', () => {
      statusProvider.refresh();
      workersProvider.refresh();
    }),

    vscode.commands.registerCommand('multiAgentHub.status', async () => {
      const st = await checkHubStatus();
      if (st.connected) {
        vscode.window.showInformationMessage(
          `Multi-Agent Hub 连接正常！\n版本: ${st.version} | 延时: ${st.latency}ms\n地址: ${st.url}\n已准备 9 种 Worker 适配。`
        );
      } else {
        const pick = await vscode.window.showErrorMessage(
          `Multi-Agent Hub 离线: ${st.error || st.reason}`,
          '立即扫描发现',
          '手动输入地址'
        );
        if (pick === '立即扫描发现') {
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
            placeHolder: '选择要连接的 Multi-Agent Hub 目标'
          });

          if (selected) {
            let token = '';
            const inputToken = await vscode.window.showInputBox({
              prompt: '请输入 Hub 的认证 Token (若 Hub 开启了鉴权，位于其 hub-token.txt)',
              password: true
            });
            token = inputToken || '';

            writeClientConfig(selected.url, token);
            await syncWorkspaceMcp(true);
            statusProvider.refresh();
            vscode.window.showInformationMessage(`已成功连接至 Hub: ${selected.url}，工作区 MCP 配置已同步！`);
          }
        }
      );
    }),

    vscode.commands.registerCommand('multiAgentHub.setConnection', async () => {
      const curr = readClientConfig();
      const url = await vscode.window.showInputBox({
        prompt: '请输入 Multi-Agent Hub 地址 (例如 http://127.0.0.1:8765/mcp)',
        value: curr.url || 'http://127.0.0.1:8765/mcp'
      });
      if (!url) return;

      const token = await vscode.window.showInputBox({
        prompt: '请输入 Hub 鉴权 Token (可选，若无密码可直接回车)',
        value: curr.token || '',
        password: true
      });

      writeClientConfig(url.trim(), token ? token.trim() : '');
      await syncWorkspaceMcp(true);
      statusProvider.refresh();
      vscode.window.showInformationMessage(`Hub 连接设置已更新！工作区 MCP 配置已自动同步。`);
    }),

    vscode.commands.registerCommand('multiAgentHub.syncWorkspace', async () => {
      await syncWorkspaceMcp(false);
      statusProvider.refresh();
    }),

    vscode.commands.registerCommand('multiAgentHub.openConsole', () => {
      const cfg = readClientConfig();
      const base = (cfg.url || 'http://127.0.0.1:8765/mcp').replace(/\/mcp\/?$/, '');
      vscode.env.openExternal(vscode.Uri.parse(base));
    })
  );

  // Initial status check & workspace auto-sync
  checkHubStatus().then((st) => {
    updateStatusBar(st);
  });
  syncWorkspaceMcp(true);
}

function deactivate() {
  if (statusBarItem) statusBarItem.dispose();
}

module.exports = { activate, deactivate };
