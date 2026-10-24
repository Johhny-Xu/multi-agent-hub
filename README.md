# multi-agent-hub

[English](README.en.md) · **简体中文**

**multi-agent-hub** 是一个本地多 AI Agent 调度 Hub，把电脑上散落的 14 种 AI 编码 CLI（被调度的执行端，统称 **Worker**）连通为一个共享任务池。当你同时使用 CodeBuddy、Copilot、Antigravity、TraeCode 等多家工具时，无需在单个账号额度见底后手动切工具或重述需求——当前客户端可直接把任务派给另一个 AI 接力完成。

![multi-agent-hub 结构图：任意 MCP 客户端接入、6 款原生深度宿主与零客户端 WebUI 独立管理，14 种 Worker 统一调度](docs/architecture.svg)

**当前版本：v1.0.18** · 协议：[Apache-2.0](LICENSE) · 更新日志：[CHANGELOG.md](CHANGELOG.md)

| 接入形态 | 适用场景 | 你需要做的操作 |
| --- | --- | --- |
| **任意 MCP 客户端直连** | Cursor、Claude Desktop、Windsurf、Cline / Roo Code、Continue 等支持 MCP（Model Context Protocol，模型上下文协议）的客户端 | 填一个 MCP URL（`http://127.0.0.1:8790/mcp`） |
| **6 款原生宿主插件** | Codex、ZCode、MiniMax Code（含 Claude Code / Agent Plugins 1.0）、DeepSeek Harness (DSH)、华为 CodeArts、Antigravity 等发起任务的宿主（Host） | 运行安装脚本，自动注册专属子代理 `hub-*.md`（在独立上下文中替主对话跑任务的分身）、技能与斜杠命令 |
| **零客户端独立使用** | 机器上没装 IDE 或 AI 客户端 | 打开内置三栏式 WebUI（`http://localhost:8890`），直接对话、派发与监控 |

**核心亮点**

- 🤖 **一套契约调度 14 种 Worker**：覆盖 Antigravity、CodeBuddy（国际版 / 国内版）、**Qoder（国际版 / 国内版）**、GitHub Copilot、MiMo、MiniMax、TraeCode、ZCode、CodeArts、opencode、Cline 与 **Meoo（秒悟）**，任务各自消耗对应账号额度，共享同一任务队列、邮箱与协作笔记。
- 🔌 **6 款原生宿主免手配参数**：安装器自动写入原生子代理、斜杠命令与工作流，子代理上下文与主会话自动隔离。
- 🔐 **WebUI 内完成全部 14 个 Worker 登录与切号**：同时支持 9 家 OAuth、Cline 设备码授权、opencode API Key 三条路径；免 SSH 登录、登出、多账号保存与秒切，仅凭落盘真实凭据判定登录态，杜绝假成功。
- ⚡ **一键启停 Worker，全端立即生效**：在控制台关闭某个 Worker 后，所有客户端的派发请求在执行前即被拦截（返回 `profile_disabled`），不白扣额度。
- 🛡️ **严格终态判定，拒绝半截结果**：自动拦截空回答、已知异常退出和超时后的残缺回答；全程保留原任务 `ref`（任务追踪编号），且禁止 Worker 给自己递归派活。
- 🔄 **支持单机与跨机混合部署**：支持纯 Windows、纯 Linux、Windows ↔ Linux（局域网直连或 SSH 反向通道）；配置与凭据存放在源码目录外，升级版本不丢历史。
- 🔍 **局域网自动发现与断线重连**：客户端可通过 UDP 广播自动扫描局域网内的 Hub；配置恢复后 MCP 桥自动重连。
- 🖥️ **单文件离线预览**：双击仓库根目录的 `demo.html` 即可在浏览器体验完整三栏控制台，无需启动后端。

---

## 目录

1. [30 秒上手](#30-秒上手)
2. [三种接入方式怎么选](#三种接入方式怎么选)
3. [原生宿主插件安装](#原生宿主插件安装)
4. [支持的 Worker 与默认模型](#支持的-worker-与默认模型)
5. [MCP 工具与任务契约](#mcp-工具与任务契约)
6. [Web 控制台能看什么](#web-控制台能看什么)
7. [实测状态与边界](#实测状态与边界)
8. [数据流向与安全](#数据流向与安全)
9. [预打包文件与开发测试](#预打包文件与开发测试)
10. [版本演进、文档导航与协议](#版本演进文档导航与协议)

---

## 30 秒上手

三步命令即可在本地同时拉起 Hub 调度服务、Web 控制台，并自动为本机已有的宿主装好插件。

### 环境要求

- **Python 3.8+**（若需安装 Codex 原生插件需 **3.11+**）
- **Node.js 20+**（用于运行本地 MCP 桥接与 Web 控制台）
- 各 Worker 对应的**厂商官方 CLI 及其登录态**（如 `agy`、`cb`、`trae`、`codearts`）。安装器负责探测环境与调用命令，不会替你注册账号。

### 启动命令

**Linux / macOS**

```bash
git clone https://github.com/Johhny-Xu/multi-agent-hub.git
cd multi-agent-hub
sh install.sh --with-console
```

**Windows (PowerShell / CMD)**

```powershell
git clone https://github.com/Johhny-Xu/multi-agent-hub.git
cd multi-agent-hub
.\install.cmd --with-console
```

**安装成功后你能看到什么**

- 浏览器打开 `http://localhost:8890`，即可看到三栏式 Web 控制台（左侧活动栏与会话树、中间对话区、右侧工作台与 14 张 Worker 状态卡片）。
- 也可以从 [Releases](https://github.com/Johhny-Xu/multi-agent-hub/releases) 下载 `agenthub-1.0.18-both.zip` 解压后执行同一条安装命令；在源码目录直接运行时，安装器会先在临时目录打包再安装，无需手动构建。
- 日常启停：`sh start.sh` / `sh stop.sh`（Windows：`start.bat` / `stop.bat`）。
- 只想先看界面：直接用浏览器打开仓库里的 `demo.html`。

> 💡 Linux 下请用 `sh install.sh` 而非 `./install.sh`，可避免解压工具丢失可执行权限导致的 `Permission denied`。详见 [RUN_ON_LINUX.md](RUN_ON_LINUX.md)。

### 三个默认端口对照

| 端口 | 服务名称 | 用途与接入方 |
| --- | --- | --- |
| `8765` | **Hub 核心服务**（`http://<host>:8765/mcp`） | 需携带 Token（鉴权令牌）访问；供 6 款原生宿主插件及跨机客户端连接 |
| `8890` | **Web 控制台**（需加 `--with-console`） | 浏览器打开 `http://localhost:8890`，用于管理账号、额度、Worker 开关与直接对话 |
| `8790` | **控制台内置子代理 MCP 端点**（`http://127.0.0.1:8790/mcp`） | 随控制台一同启动；供 Cursor、Windsurf 等通用 MCP 客户端免插件直连 |

---

## 三种接入方式怎么选

你可以把安装命令直接交给正在使用的 AI 助手自动执行，也可以按单机、免插件或跨机场景手动配置。

### 方案零：复制一句话交给 AI 自动安装（推荐）

把下面对应场景的一段话发给你正在使用的 AI 客户端，它会自动完成克隆、安装与连通性验证。

<details>
<summary><b>原生宿主通用版</b>（Antigravity / CodeArts / ZCode / Codex / DSH / MiniMax Code）</summary>

```text
请帮我克隆 https://github.com/Johhny-Xu/multi-agent-hub.git 到本地，阅读其中的 README.md，根据我当前所在的客户端环境执行对应的 install.cmd（Windows）或 sh install.sh（Linux/macOS）完成 Multi-Agent Hub 服务与当前客户端原生深度插件（子代理、Skills 与 MCP 桥）的安装配置，并调用 hub_status 验证连接状态。
```

</details>

<details>
<summary><b>分客户端精准版</b>（需要将 <code>&lt;当前项目路径&gt;</code> 替换为你的实际工作区目录）</summary>

- **Google Antigravity**
  ```text
  请帮我克隆 https://github.com/Johhny-Xu/multi-agent-hub.git，运行 install.cmd（Linux 用 sh install.sh）并指定 --native-hosts antigravity，把 Multi-Agent Hub 原生插件与 11 个 hub-* 子代理安装到 ~/.gemini/config/plugins/multi-agent-hub 并启动 Hub 服务。
  ```
- **华为 CodeArts（IDE / CLI）**
  ```text
  请帮我克隆 https://github.com/Johhny-Xu/multi-agent-hub.git，为当前工作区执行 install.cmd --native-hosts codearts --project <当前项目路径>（Linux 用 sh install.sh），完成 Multi-Agent Hub 服务与当前工作区 .codeartsdoer/mcp/mcp_settings.json 及专属子代理的自动注册。
  ```
- **MiniMax Code（`mcode`）/ Claude Code**
  ```text
  请帮我克隆 https://github.com/Johhny-Xu/multi-agent-hub.git，启动其中的 Multi-Agent Hub 服务，并将仓库内的 plugins/agenthub-workers 目录作为原生插件（含 .minimax-plugin/plugin.json、.claude-plugin/plugin.json、hub-bridge.mcp.json 与 dispatch-hub 技能）加载配置到当前客户端中。
  ```
- **ZCode（IDE / CLI）**
  ```text
  请帮我克隆 https://github.com/Johhny-Xu/multi-agent-hub.git，运行 install.cmd --native-hosts zcode（Linux 用 sh install.sh），将 plugins/agenthub-workers 原生插件（含 11 个外部 Worker 子代理与 MCP 桥）注册到我的 ZCode 环境中并启动 Hub。
  ```
- **OpenAI Codex**
  ```text
  请帮我克隆 https://github.com/Johhny-Xu/multi-agent-hub.git，针对当前项目工作区运行 install.cmd --native-hosts codex --project <当前项目路径>（Linux 用 sh install.sh），自动配置 Codex 原生插件市场与 .codex/agents/ 路由规则。
  ```
- **DeepSeek Harness（DSH）**
  ```text
  请帮我克隆 https://github.com/Johhny-Xu/multi-agent-hub.git，运行 install.cmd --native-hosts dsh（Linux 用 sh install.sh）或通过 dsh plugin add file:./integrations/dsh 挂载原生预设与工作流插件。
  ```

</details>

<details>
<summary><b>通用 MCP 客户端版</b>（Cursor / Windsurf / Claude Desktop / Cline / Roo Code / Continue）</summary>

已有运行中的 Hub 与控制台：

```text
请帮我在当前客户端的 MCP 配置文件中添加名为 "multi-agent-hub" 的 Streamable HTTP MCP 服务，URL 为 http://127.0.0.1:8790/mcp（若为局域网服务器请替换为对应 IP），配置完成后调用 subagent_agents 工具查看当前可用的外部子代理列表。
```

从零开始安装并接入：

```text
请帮我克隆 https://github.com/Johhny-Xu/multi-agent-hub.git，执行里面的 install.cmd --with-console（Linux 用 sh install.sh --with-console）启动 Multi-Agent Hub 与 Web 控制台服务（:8890 / :8790），然后把 http://127.0.0.1:8790/mcp 自动写入我当前客户端的 MCP 配置文件中。
```

</details>

### 方案一：本机一键全量安装

适合在一台电脑上写代码，希望一次配齐 Hub、控制台和本机所有已装 IDE 的原生插件。直接执行 [30 秒上手](#30-秒上手) 中的命令即可，安装器会自动探测并注册本机的 Codex、ZCode、DSH、CodeArts、Antigravity 插件与子代理。

### 方案二：任意 MCP 客户端免插件直连

适合 Cursor、Claude Desktop、Windsurf、Cline / Roo Code、Continue 等客户端。先用 `--with-console` 启动控制台，再任选一种方式配置：

1. 在 `http://localhost:8890` 控制台的「子代理接入端点」卡片点击 **【复制本文（发给Agent配置）】**，把提示词粘贴给你的 AI 自动写配置；
2. 或手动在客户端 MCP 配置文件中加入：

```json
{
  "mcpServers": {
    "multi-agent-hub": { "url": "http://127.0.0.1:8790/mcp" }
  }
}
```

接入后可调用 4 个工具：`subagent_run`（服务端等待结果，大体积产物自动落盘并只回传摘要，不挤占主对话上下文）、`subagent_result`、`subagent_artifact`、`subagent_agents`。

### 方案三：跨机分离部署（服务器跑 Worker + 个人电脑写代码）

适合把 Hub 和各家 CLI 集中装在家庭服务器、NAS 或云主机上，在主力笔记本上写代码。需要将 `<SERVER_IP>` 替换为服务器 IP，将 `<TOKEN_FILE_PATH>` 替换为保存 `hub-token.txt` 的本地路径。

```bash
# 1. 服务端（Linux）：监听局域网并开启控制台，外部配置目录会自动生成随机令牌文件 hub-token.txt
sh install.sh --component hub --bind 0.0.0.0 --port 8765 --with-console
```

```powershell
# 2. 客户端（Windows）：指定服务器地址与拷贝过来的令牌文件完成配对
.\install.cmd --component plugins --url http://<SERVER_IP>:8765/mcp --token-file <TOKEN_FILE_PATH>
```

- **局域网自动发现**：客户端不传 `--url` 时，会通过 UDP 广播扫描局域网内的 Hub 并提供列表供交互选择。
- **随时切换连接的 Hub**：运行 `connect.cmd`（Linux：`sh connect.sh`）。
- **跨公网 / 异地连接**：通过 SSH 反向通道转发，例如 `ssh -N -R 127.0.0.1:18765:127.0.0.1:8765 <USER>@<SERVER_IP>`.
- **Linux 后台常驻**：安装服务端时追加 `--systemd-user` 可注册为用户级 systemd 服务（该模式仅托管 Hub 核心服务，不含 Web 控制台）。

---

## 原生宿主插件安装

如果你只想给某一款宿主单独安装插件，可按宿主的插件机制导入预打包扩展或执行定向命令（命令中的 `<工作区路径>` 需替换为你的项目目录，Linux 下将 `.\install.cmd` 换为 `sh install.sh`）。

| 原生宿主 | 安装方式 | 详细文档 |
| --- | --- | --- |
| **华为 CodeArts / VS Code** | 在 IDE 扩展面板选择「从 VSIX/CARTS 安装」导入 `multi-agent-hub-1.0.18.carts` / `.vsix` / `.cloudide`；或执行 `.\install.cmd --component plugins --native-hosts codearts --project <工作区路径>` | [codearts](integrations/codearts/README.md) · [vscode](integrations/vscode/README.md) |
| **MiniMax Code / Claude Code** | 桌面端或云端导入 `agenthub-workers-1.0.18-minimax-plugin.zip`；CLI 启动：`mcode --plugin-dir ./plugins/agenthub-workers` | [agenthub-workers](plugins/agenthub-workers/README.md) |
| **ZCode IDE / CLI** | 执行 `.\install.cmd --component plugins --native-hosts zcode`；或在 `zcode.json` 中配置 `{"plugins":{"enabled":true,"dirs":[".../plugins/agenthub-workers"]}}` | [agenthub-workers](plugins/agenthub-workers/README.md) |
| **OpenAI Codex** | 执行 `.\install.cmd --component plugins --native-hosts codex --project <工作区路径>`，自动注册本地插件市场并将 11 个子代理写入 `.codex/agents/` | [codex](integrations/codex/README.md) |
| **DeepSeek Harness (DSH)** | 执行 `.\install.cmd --component plugins --native-hosts dsh --profile agenthub-client`；或运行 `dsh plugin --profile <PROFILE> add file:./integrations/dsh --ignore-scripts` | [dsh](integrations/dsh/README.md) |
| **Google Antigravity** | 执行 `.\install.cmd --component plugins --native-hosts antigravity`，自动安装到 `~/.gemini/config/plugins/multi-agent-hub`，重启客户端生效 | [antigravity](integrations/antigravity/README.md) |

<details>
<summary><b>Antigravity 原生插件与可选 SDK 说明</b></summary>

- 原生插件包含 `plugin.json`、11 个子代理（`agents/*.md`）、4 个技能（`skills/*/SKILL.md`）以及内置 8 个桥接工具的 `mcp_config.json`。
- 可选 Python SDK 锁定版本 `google-antigravity==0.1.21`，提供强类型 `SubagentConfig` 与串并行编排能力。注意：当前已发布的官方 wheel 包不含 `beta.run_workflow`，且 SDK 的 API 鉴权与 IDE/CLI 登录态相互独立。

</details>

<details>
<summary><b>CodeArts 双向集成与换工作区说明</b></summary>

CodeArts 原生包内含 11 个子代理、3 个斜杠命令、1 个调度技能、1 个 Hooks 插件和 8 个 MCP 工具。它既能作为宿主调度其他 AI，也能作为 Worker 被调度（`worker="codearts"`，别名 `ca`、`huawei-codearts`）。

- **单一调用路径**：严格按 `tool_search → tool_describe → tool_call` 执行；禁止在正文中直接输出 XML 标签，防止双重派发；每个任务只派发一次，后续通过轮询获取结果。
- **权限拦截与终态判定**：遇到宿主权限拒绝时立即返回 `blocked_permission` 与原始 `ref`，不会换工具名盲目重试；仅将非空的真实 Worker 回复判定为 `completed`。
- **Windows CLI 独立识别**：精准定位官方 `installers/bin/codearts.exe`，使用独立的 `cli-data` 目录与会话数据库，不与 IDE 混用；遇到“文件夹未被信任”时明确归类为 `CODEARTS_PERMISSION_REQUIRED`。
- **Linux 进程树回收**：驱动与 Hub 使用统一进程组，任务取消或超时时彻底回收所有子孙进程。

仅安装 CodeArts 插件并连接远端 Hub（替换 `<工作区路径>`、`<SERVER_IP>` 和 `<TOKEN_FILE_PATH>`）：

```powershell
.\install.cmd --component plugins --native-hosts codearts --project <工作区路径> --url http://<SERVER_IP>:8765/mcp --token-file <TOKEN_FILE_PATH>
```

```bash
sh install.sh --component plugins --native-hosts codearts --codearts-target cli --url http://<SERVER_IP>:8765/mcp --token-file <TOKEN_FILE_PATH>
```

`--project` 必须指向 IDE 实际打开的工作区目录，也可通过 `--codearts-ide-settings` 直接指定 MCP 配置文件路径；安装后请重载 IDE 窗口或重启 CLI。

**切换工作区后快速重连**（直接复用外部 `client.json`，无需重填 Token，将 `<新工作区路径>` 替换为新项目路径）：

```powershell
python integrations/codearts/install.py --config "$env:LOCALAPPDATA/AgentHub/client.json" --ide-settings "<新工作区路径>/.codeartsdoer/mcp/mcp_settings.json" --target ide --apply
```

随后在 IDE 中执行“开发人员：重新加载窗口”，输入 `/hub-status` 验证。详见 [CodeArts 原生包文档](integrations/codearts/README.md#换工作区后连接-hub)。

</details>

---

## 支持的 Worker 与默认模型

Hub 统一管理以下 14 种 Worker；表中所列为**全新安装**时的默认模型，升级已有服务器会保留你原有的模型配置。

| Worker | 默认模型 | 规格与鉴权要点 |
| --- | --- | --- |
| **Antigravity** | `gemini-3.8-flash-medium` | 内置 3.8 Flash (High/Medium)、3.1 Pro High、Claude 4.6 (Sonnet/Opus) 等 6 款模型；支持多模态输入 |
| **CodeBuddy**（国内版） | `deepseek-v4.1-flash` (x0.11) | 覆盖 13 款代码模型，标注官方积分倍率 x0.06 ~ x2.00；对齐 XDG 共享会话存储 |
| **CodeBuddy**（国际版） | `deepseek-v4.1-flash` | 覆盖 18 款主流模型；调用文件读写工具时需具备对应目录实际权限 |
| **GitHub Copilot** | `auto` | 沿用官方选型策略；支持 WebUI 设备码登录与 Linux GNOME Keyring 凭据读取 |
| **MiMo** | `xiaomi/mimo-v2.6-flash` (26f) | 提供 4 款 V2.6 模型；API Key 鉴权与小米 OAuth 账号身份相互独立 |
| **MiniMax** | `MiniMax-M3` | 支持在 M3（1M 上下文）与 M3.1-Flash-Preview（512K 上下文）之间一键切换 |
| **TraeCode** | `GLM-5.3-FlashX` (0.31x) | 覆盖 20 款官方模型，积分倍率 0.06x ~ 1.50x；支持国内 / 国际双区 PKCE OAuth 与 TraeClaw 网关 |
| **ZCode** | `GLM-5.3-Flash` | 支持国内（BigModel）与国际（Z.ai）双区；凭据采用 `enc:v1:` AES-256-GCM 加密落盘 |
| **CodeArts** | `GLM-5.2` (0.70x) | 覆盖 4 款企业模型（GLM-5.2、GLM-5.2-ArkTS-SPARK、OpenPangu-2.0-Pro/Flash）；Linux CLI 自动加载 AK/SK |
| **opencode** | 官方 CLI 默认模型 | 支持在 WebUI 内直接配置 API Key 鉴权、解析 NDJSON 事件流与专属主题色 |
| **Cline** | 官方 CLI 默认模型 | 支持在 WebUI 内通过设备码完成授权、解析 NDJSON 事件流与专属主题色 |
| **Qoder**（国际版） | `dfmodel` (DeepSeek-Flash) | 23 款官方模型（DeepSeek / GLM / Kimi / MiniMax 等）；每天 10:00（UTC+8）可领 100 Credits；支持 CLI 账号档案与多账号快切 |
| **Qoder**（国内版） | `dfmodel` (DeepSeek-Flash) | 同一套模型目录，走 `openapi.qoder.com.cn`；设备指纹取自本机 UMID 组件（`runtime-info`） |
| **Meoo**（秒悟） | `auto` | 走 **Agent OpenAPI**（不是 CLI），可选 `qwen3.8-flash` / `deepseek-v4.1-flash-1017` / `kimi-k3` / `glm-5.3-flash`；每日登录赠送 2000 积分 |

---

## MCP 工具与任务契约

所有原生宿主插件均通过本地 MCP 桥暴露相同的 **8 个标准工具**，并遵循统一的附件与目录契约。

| 工具名 | 用途 |
| --- | --- |
| `hub_ask` | 派发任务并阻塞等待最终回答 |
| `hub_dispatch` | 异步派发任务，立即返回持久化任务编号 `ref` |
| `hub_fetch` | 凭 `ref` 轮询任务状态或取回最终结果 |
| `hub_status` | 查看全部 14 种 Worker 的在线状态与启停开关 |
| `hub_capabilities` | 查询各 Worker 支持的模型、思考档位、流式与附件能力 |
| `hub_login` | 查询登录态或发起指定 Worker 的登录流程 |
| `hub_discover` | 只读扫描局域网与本机可用的 Hub 实例 |
| `hub_set_status` | 启用或禁用指定 Worker（写入配置并全端同步） |

**任务契约三原则**

1. **附件上限**：`files` 单次最多附带 8 个文件，总大小不超过 1 MiB，发送后在 Hub 端暂存。
2. **工作目录归属**：`cwd` 指 **Hub 所在服务器**上的目录路径，不会自动映射客户端本机路径。
3. **结果跟踪与验收**：任务受理后返回持久化 `ref`，请用 `hub_fetch` 轮询，切勿重复派发；状态为 `completed` 仅代表进程正常返回非空回答，代码与逻辑是否正确仍由调用方验收。完整参数见 [任务选项说明](docs/task-options.md)。

---

## Web 控制台能看什么

启动时加上 `--with-console` 即可通过 `http://localhost:8890` 访问内置控制台，在一个页面里完成对话派活、切号、查额度与看产物。

| 模块 | 你能直接做的操作 |
| --- | --- |
| **三栏工作台与文件预览** | 左侧切换平台会话树、中间沉浸式对话、右侧折叠工作台；工作台直连会话中提到的本地文件，支持产物、图片、附件在线预览与单条删除 |
| **14 个 Worker 登录与秒切** | 直接在网页里完成 9 家 OAuth、Cline 设备码与 opencode API Key 登录、登出、保存多账号并一键切换，无需 SSH 进服务器敲命令 |
| **实时额度监控与启停开关** | 查看各账号剩余额度（60 秒缓存 + 并发请求合并）；拨动卡片开关即可启用或禁用 Worker（落盘 `agents.json` 全端生效），卡片支持拖拽排序 |
| **智能收展与品牌锚点** | 顶栏、活动栏、会话侧栏随光标靠近自动展开、移开自动收起；点击左上角品牌图标可一键切换“自动收展 / 常驻固定”并记住偏好 |
| **12 套主题与毛玻璃壁纸** | 内置 Mocha、Shell、Aurora、Dusk、Cyber、Grid 6 套配色（各含深色 / 浅色，全部通过 WCAG AA 对比度校准）；上传自定义壁纸后全局自动切换为半透明毛玻璃视图 |
| **Worker 品牌色联动** | 发送按钮、上下文进度条与二级菜单自动跟随当前选中 Worker 的品牌主题色（含 opencode 与 Cline 专属配色） |
| **跨平台会话归档** | 聚合搜索、按平台筛选历史会话，支持一键复原归档会话，删除前强制二次确认 |
| **子代理 MCP 端点卡片** | 一键复制 `:8790/mcp` 接入地址或“发给 Agent 的自动配置提示词”；在非 HTTPS 的局域网 IP 访问时剪贴板自动降级，保证复制按钮始终可用 |

<details>
<summary><b>前端布局与交互实现细节</b></summary>

- 品牌锚点 `#brand-logo-pin`（`z-index: 120`）始终保持可见。顶栏触发区为 `Y ≤ 38px`，活动栏触发区为 `X ≤ 42px`；设 90ms 防误触展开与 650ms 防抖收起。弹窗打开、输入框聚焦或侧栏展开时保持常驻，顶栏与浮层按钮右缘严格对齐。
- 侧栏触发区覆盖完整占位宽度（`1440px` 视口下 `X ≤ 324px`）；会话卡片单行化展示，按需挂载 `/api/chat/agent-summary` 摘要。
- 顶栏 `z-index: 100`、会话头 `z-index: 50` 独立层叠上下文，下拉菜单不会被代码块或右侧工作台截断。
- 毛玻璃模式：`body.has-custom-bg` 下启用 `backdrop-filter: blur(20px~24px) saturate(180%~190%)`；中性灰面统一收敛为 `--gem-bg-card`，`--gem-surface-high` 仅用于悬浮交互态与进度条轨道。
- Worker 主题色 `--agent-accent` 贯通发送按钮、上下文进度条与 `#panel-chat` 二级菜单；模型名称保持正文色 `--gem-text`。
- 底部状态栏整条可点击，弹出显示项配置（模型、延时、TPS、Token、额度）；模型抽屉内置思考档位与流式输出开关；页脚右侧显示版本号 `v1.0.18`（可被后端 `snap.version` 动态覆盖）。
- 离线 Demo 构建：运行 `scripts/build_demo.py`（配合 `scripts/demo_engine.js`）可同步生成 `demo.html` 与 `demo/index.html`。

</details>

---

## 实测状态与边界

> **重要声明：回归测试通过 ≠ 所有商业模型均已完成付费实测。** 下表中的自动化回归与压测证明调度框架、协议桥接与进程管理逻辑正确，不代表每个第三方厂商、模型或宿主都在你的账号环境下跑通了付费任务。

| 验证项目 | 实测结论 | 可核对事实与报告路径 |
| --- | --- | --- |
| Windows 自动化回归 & DOM 断言 | ✅ 32 组回归 + 7 项 DOM 通过 | 报告见 `docs/refactor-validation.json`、测试脚本 `tests/console_layout_theme_dom.mjs` |
| Linux 自动化回归 & 并发压测 | ✅ 29 组回归 + 4,500+ 次压测通过 | 360 并发 0 报错；报告见 `docs/stage3-stress-report.json` |
| Linux 生产环境 Hub 升级 | ✅ 通过 | 完整加载 24 个 Hub 工具、11 种 Worker；外部配置、任务历史与鉴权平滑保留 |
| Linux Antigravity CLI 1.3.1 | ✅ 真实调用通过 | 通过原生子代理 `hub-mimocode` 派发并拿回真实模型回答 |
| Linux ZCode CLI 0.16.9 | ✅ 真实调用通过 | 凭原任务 `ref` 续查并拿回正确回答 |
| Windows Codex / ZCode 原生插件 | ✅ 真实调用通过 | 两种原生子代理均成功派发并返回结果 |
| Windows Antigravity 原生插件 | ✅ 真实调用通过 | `hub_status` 与 `hub_capabilities` 正常返回全部 11 种 Worker 状态 |
| CodeArts 原生组件与跨机通道 | ✅ 通过 | Windows ↔ Linux 局域网直连与 SSH 反向通道均连通 |
| Linux CodeArts 自身模型调用 | ✅ 真实调用通过 | GLM-5.2 系列秒级返回，取消或完成后子进程全部干净退出 |
| Windows DSH 宿主调用 | ⚠️ 受阻于测试账号余额 | 插件注册通过；发起模型调用时远端返回 `402 ACCOUNT_QUOTA` |
| Windows CodeArts IDE 宿主 | ⚠️ 部分通过 | 首次派发成功，但 IDE 宿主随后拒绝了 `hub_fetch` 轮询权限 |
| Windows 独立 CodeArts CLI | ⚠️ 未通过模型验收 | 受限于 Windows 端工作区文件夹信任弹窗拦截 |
| Linux Codex & DSH CLI | ❌ 未安装 | 测试机未安装对应二进制文件，未执行实测，不做通过宣称 |

**使用边界说明**

1. **Antigravity 原生插件 vs 可选 SDK**：原生插件已跑通真实派发；可选 Python SDK 属于外部编排库，当前官方 wheel 不含 `beta.run_workflow`，且鉴权与宿主登录态隔离。
2. **CodeArts 鉴权隔离**：在 CodeArts IDE 内登录不等于独立 CLI 自动获得调用权限；其他厂商的登录态也不能替代华为账号的 AK/SK 或 OAuth 权限；当前仅开放默认思考档位与非流式文本。
3. **非跨 Hub 联邦**：一个客户端同一时间指向一个选定的 Hub，并非多 Hub 联邦网络。

完整验收回执、源码哈希与失败日志见 [0.9.9 验收记录](docs/release-0.9.9.md) 及 [CodeArts IDE 跟进记录](docs/codearts-ide-followup.md)。

---

## 数据流向与安全

Hub 仅在本地或你的私有服务器内做协议转换与进程调度，所有凭据均与代码仓库物理隔离。

- **完整数据链路**：`宿主客户端 → 本地 MCP 桥 → Hub 服务 → 厂商官方 CLI / 内核 → 对应模型服务商 API`。
- **不是离线大模型**：Hub 本身不推理，你的提示词与附件最终会通过你所选 Worker 的官方 CLI 发往对应模型厂商。
- **凭据物理隔离**：Hub 访问 Token、各厂商 API Key、OAuth 凭据与会话历史全部存放在源码目录外的系统配置目录中，绝不写入 Git 仓库。
- **公网传输建议**：Bearer Token 仅用于接口鉴权，不加密报文；若跨公网部署，请务必配合 HTTPS 反向代理、VPN 或 SSH 隧道使用。
- 发现安全漏洞请按 [SECURITY.md](SECURITY.md) 中的流程私密报告。

---

## 预打包文件与开发测试

### 预打包发行文件

所有发行包均附带 `SHA256SUMS` 校验文件，可直接从 Releases 下载或自行构建：

| 文件名 | 适用场景 |
| --- | --- |
| `agenthub-1.0.18-both.zip` | 客户端与 Hub 装在同一台电脑（最常用） |
| `agenthub-1.0.18-plugins.zip` | 仅在个人电脑上安装各宿主客户端插件 |
| `agenthub-1.0.18-hub.zip` | 仅在服务器上部署 Hub 与 Worker 调度端 |
| `agenthub-workers-1.0.18-minimax-plugin.zip` | 导入 MiniMax Code 桌面端或云端（符合 Plugin V1 规范） |
| `multi-agent-hub-1.0.18.vsix` / `.carts` / `.cloudide` | 导入华为 CodeArts IDE、VS Code 及兼容云端 / 桌面编辑器 |

### 常用开发与测试命令

在仓库根目录下可执行以下自检与打包命令（将 `<仓库外输出目录>` 替换为实际路径，如 `../agenthub-releases`）：

```bash
# 1. 运行全量隔离回归测试（纯本地沙箱，不消耗任何模型额度）
python tests/run_regressions.py --report docs/local-validation.json

# 2. 运行 Web 控制台 DOM 结构、主题对比度与收展交互断言
node --test tests/console_layout_theme_dom.mjs

# 3. 扫描工作区源码与全部 Git 历史，确保无凭据泄漏
python scripts/audit_secrets.py --history

# 4. 修改 console/client/index.html 后重新生成单文件离线 Demo
python scripts/build_demo.py

# 5. 构建全套分发包（必须输出到仓库外目录）
python packaging/build.py --output <仓库外输出目录> --component all
```

如需运行默认跳过的真实 SDK / CLI 集成用例，可额外安装：

```bash
pip install google-antigravity==0.1.21
npm i -g @openai/codex && export CODEX_TEST_BINARY=$(command -v codex)
```

提交代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)，打包参数详见 [packaging/README.md](packaging/README.md)。

---

## 版本演进、文档导航与协议

### 近期版本演进

| 版本 | 核心变更 |
| --- | --- |
| **1.0.18** | 长任务超时改为无进展预算 + 6 小时硬上限，不再 600s 一刀切断，超时保留最后输出（partial_text）；看板娘下坠/挣扎时切到设置页立刻收起；CodeArts CLI 升级到 26.10.9，补齐 7 个内置模型，默认改为 DeepSeek-V4.1-Flash（v41f） |
| **1.0.17** | Qoder 的「今日已领」改为按 UTC+8 窗口日判定（上游每天 10:00 开新一期，0:00–10:00 不再把昨天那期谎报成已签，未开窗显示待打卡并到点自动补签）；WebUI 收起 GUI 通道的模型选择（traecode 改由客户端决定，不再报 UNSUPPORTED）；Meoo 回答不再重复；控制台重启从 90s 降到 9s |
| **1.0.16** | CodeArts 签到恢复（福利 Token 通道下线时降级为积分签到）、Qoder 国际版换环境重试、签到日志空白修复、看板娘可拖拽；Meoo（秒悟）作为第 14 种 Worker 接入 |
| **1.0.15** | 签到凭据直接复用已安装 CLI 的本地凭据：每次打卡实时读取 CLI 自身凭据文件，按 JWT 有效期与文件更新时间择优并按身份去重；WorkBuddy 支持 refreshToken 自动续期并写回 CLI 的 `auth.info`（两端共用一份，互不影响登录态）；签到日志支持一键清除；彻底避免误用国际版 `~/.codebuddy` 凭据 |
| **1.0.14** | 84 个模型逐个实跑一遍：CLI 退码 0 却空答时保留 stderr 真实诊断、新增 `plan_blocked` 区分「套餐无权」与「模型不存在」、别名表外的模型也能置灰；纠正三处模型目录错项；收口移动端四处布局缺陷（设置卡片标题竖排、数字被劈行、320px 下发送按钮换行、签到开关挤成窄柱） |
| **1.0.13** | 签到从「看起来成功」变成「真的成功」：WorkBuddy 逐账号补签、CodeArts 改为 SDK-HMAC-SHA256 真实签名调用、Trae 先查状态再领取；账号档案修掉多 Key 覆盖、身份裂档与显示名固化；新增按 Worker 适配的文件编辑权限开关；华为模型列表按 id 归并去重 |
| **1.0.12** | 右侧工作台直连会话提及的本地文件（支持产物 / 图片 / 附件预览与单条删除）；Worker 卡片支持拖拽排序并补齐 opencode / Cline 品牌色；对齐顶栏与浮层按钮右缘；Linux 配置模板补齐可用 GitHub Copilot Worker |
| **1.0.1** | 新增 opencode 与 Cline 两种 Worker（总计 11 种），补齐配置模板、能力声明、NDJSON 事件流解析与原生子代理；重绘中英架构图与路线图，放大字号并提升对比度 |
| **1.0.0** | 首个公开正式版：完成全仓凭据审计清理、致谢 TraeClaw、交接文档脱敏、补充贡献者公约与发布线审校修复 |
| **0.9.9.7 ~ 0.9.9.9** | 修复 Linux 源码安装执行位丢失与回环代理劫持；兼容 Node 20 WebSocket；补齐英文 README、安全政策、贡献指南与新版 SVG 图表 |
| **0.9.9.3 ~ 0.9.9.6** | 重构 Worker 登录态落盘判定逻辑；完成 WebUI 三栏架构、6 套深浅主题、毛玻璃壁纸与智能收展交互 |

![multi-agent-hub 进度图](docs/roadmap.svg)

完整变更记录见 [CHANGELOG.md](CHANGELOG.md) 与 [版本历史](docs/version-history.md)。

### 文档导航

- **部署与参数**：[Linux 运行说明](RUN_ON_LINUX.md) · [安装包构建与完整参数](packaging/README.md) · [统一任务选项](docs/task-options.md)
- **宿主插件指南**：[Codex](integrations/codex/README.md) · [ZCode / MiniMax Code](plugins/agenthub-workers/README.md) · [DSH](integrations/dsh/README.md) · [Antigravity](integrations/antigravity/README.md) · [CodeArts 原生插件](integrations/codearts/README.md) · [CodeArts IDE & VS Code 扩展](integrations/vscode/README.md)
- **CodeArts 专题**：[双向接入与认证边界](docs/codearts-compatibility.md) · [CodeArts IDE 跟进记录](docs/codearts-ide-followup.md) · [接入已有模型路由](docs/codearts-custom-provider.md)
- **验收与交接**：[0.9.9 验收记录](docs/release-0.9.9.md) · [网络自动发现验收（v0.8）](docs/release-0.8.md) · [开发交接记录](docs/HANDOVER_20261016.md) · [v1.0.18 交接记录](docs/HANDOVER_20261023.md) · [10-24 交接（WebUI 拆分 / 美化 / 贡献图）](docs/HANDOVER_20261024.md)

### 致谢

- [LobeHub / Lobe Icons](https://github.com/lobehub/lobe-icons)：提供控制台与 Worker 头像使用的品牌 SVG 图标。
- [TraeClaw](https://github.com/firerlAGI/TraeClaw)：提供 `trae_delegate` 通道依赖的本地桥接与 CDP/DOM 自动化方案。
- [L0NE-6/Qoder-Daily](https://github.com/L0NE-6/Qoder-Daily)：Qoder / Qoder CN 每日签到的实现参考。`forceRefresh` 实时活动列表、`CLAIM_BENEFIT` 定向活动筛选与领取语义、token 续期链路，以及用本机 UMID 组件（`runtime-info`）生成 `Cosy-MachineToken / Cosy-MachineCode / Cosy-MachineType` 设备风控头的方案，均移植自该项目——国际版的每日积分活动只对带这些头的请求下发。感谢作者的无私分享。
- [L0NE-6/Trae-AutoCheckin](https://github.com/L0NE-6/Trae-AutoCheckin)：Trae 每日签到的实现参考。`req_source` 请求体、必须使用客户端真实注册设备号（`iCubeAuthInfo://icube-dc:`）、状态 → 领取 → 同设备号回查确认的判定链、9095/9074/1001 的语义、以及用 refreshToken + 设备证明（ECDSA P-256）走新版 `ExchangeToken` 续期的方案，均移植自该项目。感谢作者的无私分享。
- [@user_3a370331/totorosir-minimax-checkin](https://skillhub.cn/skills/user_3a370331/totorosir-minimax-checkin)（作者 龙猫科技说 longmaoit）：MiniMax Code（海螺 AI）每日签到的实现参考。`signin/status` → `signin/claim` 的两步链路、`x-signature` / `yy` 两套签名与固定参数键序、日状态与 `claim_result` 的语义、以及用 refresh_token 续期并把新凭证回写客户端登录态的做法，均移植自该技能。感谢作者的无私分享。
- Huawei CodeArts、Google Antigravity、Tencent CodeBuddy、GitHub Copilot、Xiaomi MiMo、MiniMax、ByteDance Trae、Z.ai、opencode、Cline 等官方 CLI 与开放生态，以及所有提交反馈的开发者。

### 开源协议

本项目基于 [Apache License 2.0](LICENSE) 开源：允许自由使用、修改与分发；衍生作品须保留原始版权声明、许可证文本及修改说明。
