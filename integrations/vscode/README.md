# Multi-Agent Hub Extension for CodeArts IDE & VS Code

![Multi-Agent Hub](resources/icon.png)

**Multi-Agent Hub 桌面扩展**为华为云 **CodeArts IDE** 以及标准 **Visual Studio Code** 提供一键式多智能体调度与 Hub 管理支持。

同时分发为 `.vsix` 与 `.carts` 格式，支持直接在 IDE 中通过“从 VSIX/CARTS 安装...”一键导入。

---

## ✨ 核心特性

1. **一键直连与局域网发现 (Discover)**
   - 自动扫描本机与局域网内的活跃 Multi-Agent Hub 候选；
   - 点击即可配对与切换连接，自动生成/更新外部私有 `client.json`。
2. **CodeArts 智能助手工作区自动同步 (Workspace Sync)**
   - 彻底免去命令行脚本安装步骤！
   - 插件随 IDE 启动自动检测当前项目工作区，静默为当前项目写入/更新 `.codeartsdoer/mcp/mcp_settings.json`；
   - 重载窗口后，即可在云码道中直接呼出 `@hub-mimocode` 等 9 种原生子代理与 `/hub-status`、`/hub-discover` 命令。
3. **9 种 Worker 状态监控大盘 (Workers Matrix)**
   - 侧边栏专属面板直观展示 Antigravity、CodeBuddy、Copilot、MiMo、MiniMax、TraeCode、ZCode、CodeArts 等 9 种 Worker 适配器。
4. **底部状态栏实时指示灯 (Status Bar)**
   - 实时检测 Hub 连通性与网络延时，点击状态栏快速调出配置与诊断面板。

---

## 📦 安装方法

### 在华为 CodeArts IDE 中安装
1. 打开 CodeArts IDE；
2. 点击左侧活动栏的 **“扩展” (Extensions)** 图标（或快捷键 `Ctrl+Shift+X`）；
3. 点击扩展面板右上角的 **“...” (更多操作)** 菜单；
4. 选择 **“从 VSIX 安装...”** (Install from VSIX...)；
5. 在弹出的文件窗口中，选中 `multi-agent-hub-0.9.9.carts` 或 `multi-agent-hub-0.9.9.vsix`；
6. 安装完成后，重载 IDE 窗口即可生效。

### 在 Visual Studio Code 中安装
1. 打开 VS Code；
2. 打开“扩展”视图，点击右上角菜单选择 **“从 VSIX 安装...”**；
3. 选中 `multi-agent-hub-0.9.9.vsix` 安装。

---

## 🛠️ 支持的命令

- `Multi-Agent Hub: 刷新状态` (`multiAgentHub.refresh`)
- `Multi-Agent Hub: 扫描与发现 Hub` (`multiAgentHub.discover`)
- `Multi-Agent Hub: 同步当前工作区 CodeArts MCP 设置` (`multiAgentHub.syncWorkspace`)
- `Multi-Agent Hub: 配置 Hub 连接 (URL 与 Token)` (`multiAgentHub.setConnection`)
- `Multi-Agent Hub: 打开 Web 控制台` (`multiAgentHub.openConsole`)
