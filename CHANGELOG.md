# 更新日志 / Changelog

本项目的所有重要更改都将记录在此文件中。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

版本日期为 Git 发布日期；实现、测试和构建记录保留各自实际日期。源码标签与安装包附件分开管理，是否上传附件以各版交付记录为准。检查点来源见 [版本记录](docs/version-history.md)。

## [0.9.9.2] - 2026-10-12

### 登录链路全量重构：状态检测收口、CodeBuddy 共享会话存储对齐、Trae PKCE 修复、ZCode 双区切换 (`console`)

- **统一登录入口与「状态检测式」授权收口 ([`console/client/index.html`](console/client/index.html) / [`console/auth.mjs`](console/auth.mjs))**：
  - 卡片上并列的「🔐 OAuth 登录」与「+添加新账号」合并为单一「🔐 登录 / 添加账号」入口（后端本就同走沙箱隔离流程，并列按钮纯属逻辑冲突）；
  - 「✓ 我已完成授权」从"按按钮即报成功"改为**真实状态检测**：核验凭据落盘，未检测到明确报错并继续自动轮询，彻底杜绝假成功；所有回调提交分支在账号归档失败时如实返回错误；
  - 修复 CodeBuddy 粘贴 `/started` 完成页链接被误当 accessToken 反复写入、并杀死进行中登录进程导致"卡死"的缺陷：网页 URL 一律拒绝充当凭据，started 链接自动提取 `state` 走官方协议完成兑换。
- **CodeBuddy（国际版/国内版）登录修复与官方协议对齐 ([`console/auth.mjs`](console/auth.mjs) / [`console/accounts.mjs`](console/accounts.mjs))**：
  - 实证新版 CLI（≥2.164）会话真实落盘位置为 XDG 共享存储 `~/.local/share/CodeBuddyExtension/Data/Public/auth/<authentication-id>.info`（随 HOME 而非 `CODEBUDDY_CONFIG_DIR`，且 CN/国际版共用同一文件）：ACP 成功回包后同时轮询 legacy 路径与共享存储并自动镜像归档，修复"授权成功但检测不到凭据"；
  - 补齐官方 `GET /v2/plugin/auth/token?state=` 与 `GET /v2/plugin/account` 兑换链路（国际 `www.codebuddy.ai` / 国内 `copilot.tencent.com`，prefixPath `/plugin`），授权链接到达即启动后台看门狗并行轮询，CLI 自身轮询卡死时由 Hub 直接完成落盘；
  - 账户身份识别覆盖 `account` / `accounts[0]` / `allAccounts[0]` 三份副本与 JWT payload（CN 版 email 恒为空，按 uid/uin/手机号识别；ACP 结果自带 userinfo 作兜底）；未完成授权的半成品（accessToken 为 started 跳转 URL）一律判为未登录，不再被误归档；
  - 切换账号时同步写入官方共享会话存储，真实 CLI 与其本地网页端即时跟随 hub 的账号切换；登录弹窗对 CodeBuddy 明示"重复授权会使同账号网页端会话下线"的单会话策略提醒，并提供不影响网页端的凭据导入通道。
- **Trae 官方 OAuth 修复（授权页报错"链接有误"）**：与 Trae IDE `loginUrlBuilder` 逐参数对齐——补齐强制 PKCE（`code_challenge` + `code_challenge_method=S256`）、回调路径改用官方 `/authorize`、登录主机改由 `GetLoginGuidance` 动态探测（国内/国际双区）；回调解析新增 `userJwt` 直通与 `authCodeInfo→AuthCode+CodeVerifier` 走 IDE 原生 `/trae/api/v3/oauth/ExchangeToken` 兑换。
- **ZCode 国际/国内切换**：登录弹窗新增区域选择（国内版 BigModel / 国际版 Z.ai），后端按区域走官方 `provider: bigmodel|zai` 初始化、轮询与 `enc:v1:` 加密落盘，初始化失败按区域回退对应 API Key 获取页。
- **MiMo API Key 不再误当账号**：粘贴 `sk-` Key 直接合并进线上 `auth.json` 立即生效、不入账号列表；仅 API Key 的凭据（无小米 OAuth uid 且无其他通道）永不自动归档为账号。
- **MiniMax 账户名识别**：实证官方 CLI 不落盘账户名且无 userinfo API；登录/导入时把用户备注名注入官方保留字段 `oauth.account`（与 `mmx auth status` 的 Account 行同源），账号列表、卡片头标与配额信息同步展示。
- **账号区切换入口去重（全 9 卡片生效）**：移除与账号胶囊芯片完全重复的"已存账号下拉框 + 切换按钮"，「存别名」收为芯片行尾的虚线小胶囊；套餐徽章剥离规则升级为同时识别括号式与 `· UID:xxx` 分隔式账号片段（修复 mimocode 等卡片头部 UID 重复显示），9 张卡片的套餐徽章现在只展示纯套餐/档位信息。
- **手机端对话页修复 ([`console/client/index.html`](console/client/index.html))**：修复窄屏（≤640px）下工作台因 auto 模式"有产物即自动展开"而全宽覆盖对话区、导致手机上永远看不到对话的问题——窄屏时 auto 不再自动弹出，产物通过边缘把手徽标提示、手动展开；底部「对话 / 代理」导航栏与代理页在 390px 视口实测可正常进入与渲染。
- **账号显示去重与可读性修复 ([`console/client/index.html`](console/client/index.html) / [`console/accounts.mjs`](console/accounts.mjs))**：
  - 账号档案名清洗 `cleanProfileLabel` 改为保留 Unicode 字母与数字（含中文），修复 CJK 账号名（如 Z.ai 的「旅行者****」）被吞成纯数字「7072」导致"登录成功却看不出新增了账号"的问题；
  - 卡片头部移除与"点头像"重复的「头像」按钮，启停开关独占右侧；套餐徽章不再重复括号内的账号身份（与 worker 同名时彻底隐藏），徽章文字不再截断；
  - 「账号与登录」状态徽章只表达"已登录/未登录"，当前账号统一由绿色高亮胶囊展示，消除同一账号信息在同一卡片上三处重复的问题；角色描述行改为完整换行显示。
- **MiniMax 上下文档位选择器 ([`console/client/index.html`](console/client/index.html) / [`console/auth.mjs`](console/auth.mjs))**：minimaxcode 卡片新增「上下文 512K | 1M」分段胶囊——实证 mmx CLI 的上下文窗口由模型内置表决定（`text chat` 无上下文参数），512K=`MiniMax-M3.1-Flash-Preview`（524288）、1M=`MiniMax-M3`（1e6），点击档位即切换默认模型，Hub 每次派发实时读取无需重启；同时将 M3.1 原先含糊的 `512K/1M` 标签修正为真实的 `512K 上下文`。
- **模型别名可删除 ([`console/auth.mjs`](console/auth.mjs) / [`console/client/index.html`](console/client/index.html))**：内置模型行暴露 agents.json 中的别名徽章并可单个删除（修复"指向内置模型 id 的自定义别名永远无法删除"），删除当前 default 别名时自动回退内置默认模型。
- **版本号统一**：console 服务与 WebUI 此前分叉停在 0.9.4（落后于主线 0.9.9.1），本版将 Hub 核心、console/WebUI、插件市场与全部集成/插件清单一律对齐到 **0.9.9.2**，结束双线并存。

---

## [0.9.4] - 2026-10-12

### 全接口高并发压测、大负载加固、原生配额/多账号面板重塑与跨平台兼容 (`hub` / `console` / `drivers` / `mcp`)

- **原生 9 厂商配额监控、全 WebUI OAuth 登录/登出、多账号切换与「配额与账号」面板重塑 (`console`)**：
  - 新增纯标准库零依赖模块 [`console/vendor-quota.mjs`](console/vendor-quota.mjs)（9 Worker 原生配额实时抓取与 60s TTL 缓存，内置 ZCode `enc:v1:` AES-256-GCM 凭据加解密与 GNOME Keyring 读写）、[`console/accounts.mjs`](console/accounts.mjs)（9 Worker 全覆盖的多账号档案保存、一键切换、隔离沙盒添加与删除）与 [`console/auth.mjs`](console/auth.mjs)（9 Worker 原生 OAuth 授权链接生成、TUI 设备码/ACP 协议流提取、远程回调 URL / 授权码交换与一键退出登录），彻底移除外部 9router 依赖及 `server.mjs` 中 336 行残留 `token_monitor` 死代码。
  - **9 Worker 全量 WebUI OAuth 免终端登录与账号切换 ([`console/auth.mjs`](console/auth.mjs) / [`console/secret-get.py`](console/secret-get.py))**：彻底告别丑陋的 `about:blank` 空白弹窗与 `window.prompt` 阻塞对话框，升级为页内暗色毛玻璃 **OAuth 授权与账号切换模态窗 (`#uhAuthModalBackdrop`)**，逐一打通全部 9 个 Worker 的官方 OAuth 链路：
    - `minimaxcode`：通过 Python PTY 驱动 `mmx auth login --recommend --region=cn`，自动提取 OAuth 授权链接（`https://platform.minimaxi.com/oauth-authorize?user_code=...`）与设备码并后台自动轮询落盘，同时支持直接粘贴 `sk-...` API Key；
    - `codebuddy` / `codebuddy-cn`：通过官方 `codebuddy --acp`（`external` / `internal`）JSON-RPC `initialize` + `authenticate` 协议流，1 秒内捕获 `_codebuddy.ai/authUrl` 官方登录链接并在浏览器授权完成后自动写入 `auth.info`；
    - `github-copilot`：通过 Python PTY 驱动 `copilot login --device-code` 提取 `https://github.com/login/device` 与 8 位设备码，扩展 [`console/secret-get.py`](console/secret-get.py) 支持 `--set` / `--delete` 同步读写 GNOME Keyring 与 `.config/github-copilot/copilot-token` 镜像，支持 WebUI 一键登出与多账号切换；
    - `antigravity`：内置官方 Google OAuth 2.0 授权流（`1071006060591-tmhssin2h21lcre235vtolojh4g403ep`）+ 本地 `127.0.0.1:20128/oauth-callback` 监听，支持跨机远程浏览器登录并粘贴 `http://localhost:20128/oauth-callback?code=...` 回调 URL（自动经本地代理交换 `access_token` / `refresh_token` 写入 `antigravity-oauth-token`）；
    - `mimocode`：内置官方小米 MiMo X25519 + AES-256-GCM 端到端加密 OAuth 授权流（`https://platform.xiaomimimo.com/authorize?pk=...`），支持在 WebUI 粘贴授权回调 Code 自动解密落盘至 `.local/share/mimocode/auth.json`；
    - `traecode`：内置官方 Trae 双区（国内 `trae.cn` / 国际 `trae.ai`）OAuth 授权链接生成与 `/cloudide/api/v3/trae/oauth/ExchangeToken` Token 交换，支持粘贴回调 URL 或 JWT Token；
    - `zcode`：内置官方 ZCode CLI 轮询式 OAuth（`POST /api/v1/oauth/cli/init` → `bigmodel.cn/login` + 3s 节流轮询 `/api/v1/oauth/cli/poll/<flow_id>`），获取 API Key 后自动以 `enc:v1:` AES-256-GCM 加密写入 `.zcode/v2/credentials.json`；
    - `codearts`：提供华为云 IAM 访问密钥控制台直达链接与页内 AK/SK 双字段安全落盘（`.config/agenthub-codearts/codearts-auth.env`，权限 `0600`）。
  - **对话输入栏与三态合一模型配置面板重塑 ([`console/client/index.html`](console/client/index.html))**：将原先分离的输入框与底栏整合为一体化暗色毛玻璃 `.chat-composer-shell`；重构模型选择器为无原生下拉框的精致 Popover 面板，按厂商真实能力自适应展示模型卡片、深度思考两段式分段胶囊（`默认 / 开启 / 关闭`）与流式输出实时开关，彻底移除不可点击的灰置废项。
  - 重构 [`console/client/index.html`](console/client/index.html) 配额与账号面板布局：`.qa-grid` 采用自适应网格 `repeat(auto-fill, minmax(310px, 1fr))` 配合 `.qa-card { min-width: 0; overflow: hidden }`，根治多列卡片下 `<select>` 与按钮跨卡溢出重叠；每张卡片实时展示 `● 已登录` / `○ 未登录` 状态徽章、内联「存当前」档案抽屉、一键「🔐 OAuth 登录 / 换号」、「+添加账号」隔离沙盒授权与「退出」按钮；消除手动刷新时的整页坍缩闪烁，并用控制台原生 Toast（`window.__ahToast`）全面替代阻塞弹窗。
- **高强度阶梯压力测试与并发锁加固（阶段三 ~ 阶段五，累计 >4,500 次压测请求 0 报错）**：
  - **Singleflight 配额请求合并 ([`console/vendor-quota.mjs`](console/vendor-quota.mjs))**：引入 `inFlightAll` 与 `inFlightWorker` Promise 复用锁，60 并发刷新风暴下外部厂商 API 调用从 **540 次降至 9 次**，`/api/quotas` P95 延迟从 **12,041ms 降至 850.5ms（快 14.1 倍）**，`/api/quota` P95 从 **10,593ms 降至 1,612.5ms（快 6.5 倍）**（详见 [`docs/stage3-stress-report.json`](docs/stage3-stress-report.json)）。
  - **配置文件写互斥锁与备份自动轮转 ([`console/auth.mjs`](console/auth.mjs) / [`console/accounts.mjs`](console/accounts.mjs))**：引入进程内 `withLock` 串行队列锁，修复并发修改 `agents.json` / `accounts.json` 的 Read-Modify-Write 竞态，10 路并发 `POST /api/models/custom` 落盘成功率从 **1/10（丢失 9 个）提升至 10/10（0 丢失）**，并自动轮转 `.bak-model-*` 仅保留最新 5 份。
  - **Hub 360 并发洪峰与 `hub_capabilities` 缓存加固 ([`hub/agent_hub.py`](hub/agent_hub.py))**：将 `HubHTTPServer.request_queue_size` 从 Python 默认 `5` 提升至 `256`（消除高并发 SYN 队列溢出导致的 28.5s 尾延迟），并为 `tool_hub_capabilities` 增加路径与 `mtime_ns` 感知的 5s 内存缓存（文件变更或启停子代理秒级失效）；360 同波瞬时并发 × 3 波（1,080 请求）100% 成功，`GET /health` P95 从 **28,525ms 降至 1,252ms（快 22.8 倍）**，稳态 `hub_capabilities` 从 **170ms 降至 15ms（快 11.3 倍）**（详见 [`docs/stage4-5-load-report.json`](docs/stage4-5-load-report.json)）。
  - **大任务负载、上传安全边界与 30 并发状态机验证**：100KB 任务提示词 + 18KB 结果全链路 **91ms** 字节级 100% 精确落盘；收紧 `console/server.mjs` `saveUpload` 单文件上限至 `1 MiB` 并将 `client.json` / `agents.json` / `accounts.json` 纳入凭据上传拦截名单；30 路并发状态机读写（10 任务 + 10 消息 + 10 笔记）验证 `StateFileLock` 零损坏、零丢失。
- **ZCode 桌面驱动参数解析修复与跨平台 UTF-8 BOM 兼容加固（阶段六 & 七）**：
  - 修复 [`drivers/zcode_dom.js`](drivers/zcode_dom.js) `process.argv` 解析器未识别 `--stream` 值参数导致 `--stream off` 的 `"off"` 覆盖真实提示词的阻塞性缺陷，将轮询上限提升至 `1800s`，并在新建会话（New Chat）点击完成后再采集 DOM 基线快照。
  - 全链路 UTF-8 BOM（`\uFEFF`）容错加固：[`hub/agent_hub.py`](hub/agent_hub.py) `_read_json` 统一切换为 `encoding="utf-8-sig"`，Node 侧 `auth.mjs` / `accounts.mjs` / `server.mjs` / `vendor-quota.mjs` 统一剥离 `^\uFEFF`，兼容 Windows PowerShell / 记事本生成的带 BOM JSON 配置（详见 [`docs/stage6-compat-report.json`](docs/stage6-compat-report.json)）。
  - 字节级同步全部 7 处 MCP 桥接副本（统一暴露 8 个 MCP 工具，含 `hub_set_status`），全量跑通 [`tests/run_regressions.py`](tests/run_regressions.py) **32/32 组回归测试套件**并重新构建全套分发 ZIP 与 IDE 扩展包。

### WebUI 控制台全景交互架构与会话管理升级 (`console`)

- **CodeBuddy 风格三栏式交互布局**：
  - 栏 1（48px 极窄活动栏）：沉浸式对话、代理监控、任务队列、共享笔记一键切换，移动端自适应下沉底部导航栏；
  - 栏 2（260px 平台会话树）：支持各 Worker 展开独立多会话树、会话快速切换与搜索、一键新建会话、折叠展开；
  - 栏 3（中央交互工作区）：单平台沉浸式对话、输入框下沉式状态条（模型/状态/耗时实时监控与自定义勾选项）、右侧可折叠扩展工作台。
- **智能时段问候语与跨平台全局头像定制**：
  - 7 大精细时段（清晨 05:00-09:00、上午 09:00-12:00、中午 12:00-14:00、下午 14:00-17:00、傍晚收工 17:00-20:00、晚上 20:00-23:00、深夜 23:00-05:00），共 35 句暖心关怀问候语，每次进入或切换平台即时随机构造与刷新；
  - 支持点击头像选择本地图片自定义头像，全局多视图（侧边栏、对话头、气泡等）实时响应并持久化至服务端配置。
- **全量会话归档管理与快速复原/删除**：
  - 会话树项归档交互双模优化：单击弹窗二次确认防误触，双击秒速直接归档；
  - 全部归档会话多维弹窗：支持跨所有 Worker 集中聚合查看、多平台筛选、关键词实时搜索、多维度排序；
  - 已归档会话支持**一键复原**（自动恢复至活跃会话列表并跳转打开）、单条彻底删除，以及右上角**【一键删除】与防误触内联二次确认**；
  - 子代理接入端点新增**【复制本文（发给Agent配置）】**，并实现全局剪贴板原生降级回退（无缝适配局域网 HTTP 非安全上下文与 HTTPS）。
- **状态感知右移与自动探活替代独立心跳**：
  - 移除顶部独立的心跳检测按钮，操作区自然贴紧右侧；
  - “刷新”按钮升级为快照获取与在线子代理并发深度探活，Toast 即时反馈网络延迟与各 Worker 在线状态。
- **轻量页脚与社区互动彩蛋**：
  - 底部增加优雅轻量页脚栏，右下角展示版本号 `v0.9.4`；
  - 左侧提供【捐献】按钮，点击弹出“好好吃饭更重要哦”，选择【仍要捐献】触发温馨感谢爱心彩蛋；
  - 中间展示 GitHub 图标与仓库给 Star 标语，点击直达项目官方仓库。

### WebUI 子代理激活开关与全端双向同步机制 (`console` / `hub` / `mcp`)

- **WebUI 控制台一键启用/禁用子代理**：
  - 在 Web 管理大盘（端口 `8890`）的 Worker 卡片增加原生 Toggle Switch 切换开关，支持按需激活或临时禁用任意 Worker（如无额度账户、调试中子代理）。
  - 新增 REST 控制端点 `POST /api/agents/toggle`（接收 `{ agent_id, disabled: boolean }`），权威状态持久化落盘至 `agents.json` 的 `disabled` 属性，并即时触发 `availability_store` 内存缓存热刷新。
  - 新增 Hub 管理 MCP 工具 `hub_set_agent_status`，支持客户端及脚本编排程序远程启停子代理状态。
- **全端权威状态双向感知与前置熔断**：
  - 调度器与客户端同步状态联动：`hub_status` / `hub_list_agents` 将被禁用的 Worker 显式标注为 `[已禁用]`（并输出原因，如 `由管理员在控制台或 API 禁用`）；`hub_capabilities` 接口返回 `enabled: false, code: "disabled"`。
  - 任务调度零延迟保护：`hub_dispatch` 针对被禁用的 Worker 触发秒级前置拦截，直接返回 `UNAVAILABLE: profile_disabled`，绝不启动真实驱动进程，杜绝频繁调用空额度子代理造成的计算与 API 资源浪费。
- **MiniMax Code / MiniMax Plugin V1 与多规范插件一包四吃适配 (`plugins/agenthub-workers` / `packaging/build.py`)**：
  - 严格对照《MiniMax Plugin 开发与上架指南（MiniMax Plugin V1）》补齐 `.minimax-plugin/plugin.json`（`schemaVersion: 1`、分类 `Code`、零外泄凭据）与独立 `hub-bridge.mcp.json`（标准 `stdio` 解释器命令 `node` + 包内相对参数 `./mcp/server.mjs`）；
  - 同步补齐 `.claude-plugin/plugin.json`（兼容 MiniMax Code CLI `mcode 0.4.0+` 与 Claude Code）及根目录 `plugin.json`（兼容 Agent Plugins Specification v1.0.0），与原有 `.zcode-plugin/plugin.json` 零冲突共存；
  - `packaging/build.py` 新增 `--component minimax` 构建能力，自动生成符合官方上架与导入规范、根目录直接包含 `.minimax-plugin/plugin.json`（无外层包裹目录）的独立插件包 `agenthub-workers-0.9.4-minimax-plugin.zip`。
- **架构图/路线图 SVG、一键安装链路与 Apache-2.0 开源协议升级 (`docs/*.svg` / `README.md` / `LICENSE`)**：
  - 重构 `docs/architecture.svg` 与 `docs/roadmap.svg`：清晰呈现“①任意 MCP 客户端直连即用、②6 款原生深度宿主（Codex / ZCode / MiniMaxCode / DSH / CodeArts / Antigravity）、③零客户端 WebUI 独立管理”三层架构与 v0.9.4 攻坚成果；
  - 在仓库根目录补齐 `install.cmd`、`install.sh`、`connect.cmd`、`connect.sh` 快捷入口，重构 `README.md` 四大场景化安装指南，并增加对 [LobeHub / Lobe Icons](https://github.com/lobehub/lobe-icons) 品牌矢量头像来源的致谢；
  - 将项目开源协议切换为 **Apache License 2.0 (`Apache-2.0`)**，更新根目录 `LICENSE` 及各插件包清单，明确保留原作者版权声明、专利授权与修改说明要求。
- **Web 控制台服务化与局域网访问加固**：
  - 将控制台服务默认绑定监听地址由回环 `127.0.0.1` 调整为 `0.0.0.0:8890`，并补充 HTTP `HEAD` 预检方法处理，确保局域网多设备浏览器平滑访问。
  - 在 Linux 服务器上创建并启用标准 systemd 用户服务 `agent-hub-console.service`，实现断线守护自愈。

### CodeArts 宿主 MCP 强制调用路径规范与去重机制 (`codearts` / `mcp`)

- **强制单一调用路径（Single Invocation Path）**：
  - 针对 CodeArts 宿主在启用 MCP 工具时偶发的重复派发与标签直出问题，严格确立 `tool_search → tool_describe → tool_call` 单一规范调用路径。
  - 严禁在 Markdown 或纯文本推理中混用、直出 `<tool_call>` 等底层 XML 标记，杜绝被宿主调用解析引擎双重触发执行。
- **规约多层深度固化**：
  - **MCP Server 层**：在 `mcp/server.mjs` 的 `initialize` 握手响应 `instructions` 及 `hub_dispatch` / `hub_ask` 工具的 `description` 中显式固化调用路径约束与单次派发准则。
  - **IDE 扩展层**：在 `extension.js` 中自动为工作区注入 `.codeartsdoer/rule/multi-agent-hub.md` 强制规则；在 `SKILL.md` 与 9 个子代理 prompt（`agents/*.md`）中全面补充“单任务仅派发一次、凭 ref 安全异步轮询”规范。
- **TraeCode 网关回执解析与回填保底**：
  - 优化 `hub_dispatch` 对 TraeCode 异步受理结果的结构化解析，确保无论网关返回原生 ref 还是回执文本，均能精准提取并回填顶层 `ref` 与 `running` 状态，消除调用方因 ref 为空而重派任务的隐患。

### Antigravity 宿主插件连接与 MCP 桥接故障动态恢复修复 (`antigravity` / `mcp`)

- **MCP 桥接动态连接加载与自愈**：
  - 彻底解决 `mcp/hub.mjs` 模块顶层静态求值 `try { CONNECTION = await loadConnection(); }` 导致在配置文件缺失或未就绪时永久锁定 `SETUP_REQUIRED` 状态的缺陷。
  - 新增 `refreshConnection()` 与 `getConnection()` 动态重试机制：当连接配置在 MCP 进程启动后被创建或修正时，后续任意工具调用（`hub_status`、`hub_capabilities`、`hub_ask` 等）均能自动重新加载配置并与 Hub 恢复连接，无需重启 IDE 或杀死后台进程。
  - 将修复同步至全部集成目标（`mcp/`、`plugins/agenthub-workers/mcp/`、`integrations/dsh/mcp/`、`integrations/codex/mcp/`、`integrations/codearts/mcp/`、`integrations/antigravity/mcp/`、`integrations/vscode/mcp/`）。
- **Windows Antigravity 客户端配置就绪**：
  - 修复 `%LOCALAPPDATA%\AgentHub-Antigravity\client.json` 配置路径缺失问题，配置标准文件模式连接至局域网 Hub 节点（`http://<LAN_HUB_IP>:8765/mcp`）与凭据。
  - 实时热重载 Antigravity 宿主插件进程，实测通过原生 `call_mcp_tool` 执行 `hub_status` 与 `hub_capabilities`，成功返回远程 9 家 Worker 在线状态及 TraeCode 等通道能力。
- **单元测试与全量回归**：
  - 在 `tests/mcp_bridge.test.mjs` 中新增 `bridge recovers dynamically when connection configuration is restored` 单元测试，并将 `integrations/vscode/mcp` 纳入跨端桥接一致性自动化检验（117 项测试全量通过）。
  - 全量运行 `tests/run_regressions.py`，31 组回归套件全部通过（100% PASS）。


### TraeCode 网关状态与能力识别修复 (`traecode` / `hub`)

- **修复 Trae 网关终态校验误报**：解决 Trae 网关返回 `session.status="completed"` 与 `result.status="ok"` 时，因白名单缺少 `ok` / `success` 被误判定为“网关状态不确定”并抛出 `RuntimeError: Trae 网关状态不确定，继续查询原任务；请勿重新派发: completed,ok` 的根本问题。将 `ok` 和 `success` 纳入正常完成终态集合，确保任务结果顺利落盘并标记为 `completed`。
- **TraeCode 网关通道能力识别加固**：
  - `availability_store.py` 识别 `traecode`（及声明了 `gateway` 的 Worker）为专用网关/桌面通道，不再将其误判为 `cli_not_configured`（“此 worker 未配置无头 CLI”），正确置为 `enabled: true, code: "ready"`。
  - `agent_hub.py` 中 `hub_capabilities` 将 TraeCode 的 `configured` 字段正确置为 `true`。
  - `hub_status`（`hub_list_agents`）输出明确显示 `| 调度通道: TraeClaw 网关`，彻底消除模型在推理前误判该 Worker 无法使用的歧义。
- **回归测试覆盖**：在 `tests/runtime_regressions.py` 中新增 `test_gateway_accepts_completed_and_ok_status` 测试用例，在 `tests/capability_availability_regressions.py` 中增加 TraeCode 网关免 CLI 就绪断言。
- **远程服务热重载验证**：修改已同步并部署至远程 Linux 节点，经 `ask.mjs trae` 真实调用验证顺利通过。


### 子代理模型目录精简与去重 (Model Catalog Optimization)

- **不可用生图模型清理**：移除 `codebuddy-cn` 中无法用于代码/文本生成的非文本生图/图生图模型（`hunyuan-image-alpha`、`hunyuan-image-alpha-edit`）。
- **重复与冗余模型去重**：
  - `codebuddy-cn`：清理 `hy4-preview-x`、`hy3-x`、`deepseek-v4-flash` 等重复档位与别名。
  - `antigravity`：去除 `gemini-3.8-flash`、`gemini-3.1-pro` 冗余未分级项，统一保留 High/Medium 精确档位。
  - `mimocode`：清理未命名前缀的重复项 `mimo-v2.6-flash`，统一定位为官方 `xiaomi/mimo-v2.6-flash`。
  - `traecode`：去除大小写重复项 `glm-5.3-flashx`，剔除与平台主项重叠的 `DeepSeek-V4-Flash-Official`、`DeepSeek-V4-Pro-Official` 及 `Doubao-Seed-2.0-Code`。
- **清理 2026 年 6 月前旧代模型**：
  - `codebuddy-cn`：移除 `deepseek-v3-2-volc`、`minimax-m2.5/m2.7`、`glm-4.6/4.7` 全系列、`glm-5.0` 系列、`kimi-k2.5/k2.6/thinking`、`hy3`、`space-bunny`。
  - `codebuddy`：移除旧代及下线模型 `hy3`、`gpt-5.4`、`gemini-3.5-flash`、`kimi-k2.6`。
  - `antigravity`：移除官方标记即将下线的旧代 `gemini-3.6-flash` 与 `gemini-3.7-flash`。
  - `mimocode`：移除 `mimo-auto` 及老旧 `mimo-v2.5` 全系列。
  - `minimaxcode`：移除旧代 `MiniMax-M2.5`、`MiniMax-M2.7` 全系列，聚焦当季旗舰 `MiniMax-M3.1-Flash-Preview` 与 `MiniMax-M3`。
  - `traecode`：移除旧版本 `glm-5`、`glm-5.1`、`kimi-k2.7-code`。
- **华为 CodeArts 规则保留**：遵照用户要求保持 `codearts` 完整不变，维持 4 个已验证企业级官方模型（`GLM-5.2`、`GLM-5.2-ArkTS-SPARK`、`OpenPangu-2.0-Pro`、`OpenPangu-2.0-Flash`）。
- **测试与环境同步**：同步更新 `tests/console_smoke.mjs` 中的模型目录数量断言（全量 26 项 smoke + 5 项 DOM 测试 100% 通过），并同步部署至服务器热重载生效。

### CodeArts IDE & VS Code 桌面扩展升级 (`integrations/vscode`)

- **Workers 侧边栏支持展开模型树**：各 Worker 节点支持展开直接查看当季精选模型、官方积分倍率（如 CodeBuddy-CN `x0.06 ~ x2.00`、TraeCode `0.06x ~ 1.50x`）与官方营销福利标签（`[会员 5 折]`、`[限时 1 折]`、`[专属补贴]`）。
- **华为 CodeArts 官方模型对齐**：扩展内默认模型更新为 `GLM-5.2`（`0.70x`），对齐收敛后的 4 款企业级官方高可用模型。
- **Web 控制台直达修复**：修复 `multiAgentHub.openConsole` 命令地址，精准打开端口 `8890` 的 Web 控制台大盘，避免跳转至底层的 MCP 端口 `8765`。
- **安装包重构与本地就地更新**：重新打包生成 `.vsix`、`.carts`、`.cloudide` 三种发行格式并自动更新本地 CodeArts IDE 扩展实例。


## [0.9.9.1] - 2026-10-10

### 华为 CodeArts 官方模型与凭据自动加载修复 (`codearts`)

- **凭据环境自动载入**：底层驱动 `drivers/codearts_cli.py` 新增自动加载 `~/.config/agenthub-codearts/codearts-auth.env`（或 `CODEARTS_AUTH_ENV` 指定文件）中的 `CODEARTS_CLI_AK` 与 `CODEARTS_CLI_SK`，彻底解决无头模式下因缺少凭据被判定为 `CODEARTS_AUTH_REQUIRED` 或模型列表解析为空的根因。
- **Linux 官方 CLI 路径与 Profile 匹配**：适配 Linux 环境下名为 `codearts` 的官方可执行文件，建立与 Windows `codearts.exe` 一致的 TUI/配置隔离与目录加载规则。
- **模型可用性与目录收敛**：深入华为 MaaS 与 IDE 网关机制，理清无头 CLI（MaaS 官方 AK/SK 鉴权）与 IDE 桌面（临时云端 IAM 网关鉴权）的能力边界；在控制台与 `agents.json` 中将 CLI 真实支持的模型收敛为 4 款已完全验证可用的官方企业级模型（`GLM-5.2` 默认/`0.70x`、`GLM-5.2-ArkTS-SPARK`/`0.70x`、`OpenPangu-2.0-Pro`/`0.70x`、`OpenPangu-2.0-Flash`/`0.35x`）；清理 `availability.json` 中的误报阻断记录，彻底修复选择模型时弹出“找不到所选模型”报错的问题。
- **状态存储兼容 UTF-8 BOM**：`hub/availability_store.py` 读取 `availability.json` 改用 `utf-8-sig` 解码，彻底防止跨平台（如 PowerShell 输出）引入 BOM 字符导致 `capabilities` 接口崩溃并清空全量子代理模型目录的问题。
- **全链路异步调度验证**：实测并通过 Linux Hub 进程至 CodeArts CLI 的全链路任务派发与回答确认（`GLM-5.2`、`GLM-5.2-ArkTS-SPARK` 均秒级返回且状态置为 `completed`）。

### TraeCode 模型倍率与营销折扣对齐 (`traecode`)

- **官方倍率精准对齐**：根据 TraeCode 桌面版官方模型清单，全量更新 27 个可用模型的倍率与营销标签：
  - `GLM-5.3-FlashX`（`0.31x`，默认）、`GLM-5.3-Flash`（`0.06x`）。
  - GLM 智谱系列（`GLM-5.3` / `GLM-5.2` / `GLM-5.1` / `GLM-5`）：`0.78x`，带有浅绿 `[会员 5 折]` 标识。
  - 豆包 Seed 系列：`Seed-Evolving` / `Seed-2.1-Pro`（`0.08x`，`[限时 1 折]`）；`Seed-2.1-Turbo`（`0.20x`，`[专属补贴]`）；`Seed-Code` / `Seed-2.0-Code`（`0.06x`，`[专属补贴]`）。
  - MiMo 系列：新增 `MiMo-V2.6-Flash`（`0.06x`）、`MiMo-V2.6-Pro`（`0.15x`）内置选型。
  - DeepSeek 系列：`DeepSeek-V4-Flash` / `Flash-Official` / `deepseek-v4.1-flash`（`0.20x`，`[限时折扣]`）；`DeepSeek-V4-Pro` / `Pro-Official`（`0.72x`，`[限时折扣]`）。
  - 通义千问系列：`Qwen3.8-Flash`（`0.08x`）、`Qwen-3.7-Plus`（`0.25x`）、`Qwen3.8-Max`（`1.50x`）。

### Web 控制台 (Console & WebUI) 交互与样式优化

- **指标自定义勾选与记忆**：底部状态栏新增自定义指标开关面板，可实时勾选/取消勾选具体监控项（子代理、模型、速度、TPS、会话Token、平台配额等），并自动适配 `·` 分隔符，配置保存在本地存储。
- **状态栏与抽屉联动**：修复点击状态栏模型标签时误触发外部点击关闭面板的事件冲突，点击模型即可平滑呼出参数面板。
- **专属标签样式**：新增 `.mp-tag-promo`（紫色福利标）和 `.mp-tag-discount`（浅绿折扣标），与官方 UI 视觉无缝融合。
- **思考控制优化**：将子代理运行参数由单一开关优化为平滑的思考强度（`low / medium / high / max`）选项，取消阻断式校验，保证各 worker 下对话流程通畅。
- **MiniMax 积分配额展示**：支持解析 9router 通道返回的 MiniMax 剩余积分并统一渲染到额度条与悬浮提示。

### CodeArts / VS Code 扩展规范与安装包修复

- **SemVer 2.0.0 规范兼容**：修正 IDE 扩展 `package.json` 中的版本号为标准的语义化版本 `0.9.9`，解决 CodeArts IDE 核心扩展扫描器在遇到四段版本号（`0.9.9.1`）时抛出 `ScanningExtension: 无法从 ... 读取扩展` 的崩溃报错。
- **本地扩展热更新**：直接就地更新本地已安装的扩展脚本，并重新打包发布 `multi-agent-hub-0.9.9.carts`、`.vsix` 和 `.cloudide`。
- **回归测试验证**：全量 31 项回归测试组（包含控制台 DOM 测试、CodeArts 驱动、打包检查与 Windows/Linux 契约）全部 100% 通过。

### CodeArts IDE & VS Code 扩展包 (.carts / .vsix)

- 新增 CodeArts IDE 与 Visual Studio Code 通用桌面扩展 (`integrations/vscode`)，支持通过 IDE 图形界面“从 VSIX/CARTS 安装...”一键导入，免除命令行脚本配置。
- 提供侧边栏专属视图（Hub 连接与健康状态、9 种 Worker 适配大盘、快捷发现与管理）以及底部状态栏实时指示灯（在线/延时提示）。
- 插件随 IDE 启动自动检测当前工作区，无感为云码道（CodeArts Agent）注入/更新 `.codeartsdoer/mcp/mcp_settings.json`，彻底解决切换项目需手动登记的痛点。
- 新增 `packaging/package_extensions.py` 打包脚本，遵循 VSIX OPC 规范，一键构建并校验 `multi-agent-hub-0.9.9.vsix`、`multi-agent-hub-0.9.9.carts` 和 `multi-agent-hub-0.9.9.cloudide`，输出至 `integrations/vscode/dist/` 与桌面发布目录。

### CodeArts IDE 接入体验

- 修复 Windows 官方 CLI 的发现：驱动和一键安装器识别 `installers/bin/codearts.exe`，避免只发现 `.cmd` 后误选 IDE AgentKernel。直接运行官方 exe 时使用 CLI 专用配置及 `cli-data` 环境，保留外部认证和独立任务数据库，不关闭 TLS 校验。
- 安装结果展示稳定插件目录、版本及每个 MCP 配置路径；明确当前工作区登记、宿主重载与真实工具调用的区别。独立安装器使用默认 IDE 路径时提示尚未核实当前工作区，CLI-only 安装不会提示配置 IDE。
- 补充新工作区复用既有 Hub 连接的步骤，并将官方“文件夹未被信任”诊断识别为权限受阻，保留脱敏错误且不修改信任设置。
- CodeArts 原生代理明确区分直接注册与懒加载 MCP 的调用方式，等待原 ref 的终态并核对真实答案；权限拒绝后停止该动作，不再改工具名或重复请求。
- 修复 Linux CodeArts 驱动另建进程组导致外层取消无法回收后代的问题：仅在确认 Hub 进程组归属时继承外层组，独立运行仍隔离并清理自己的组。真实进程夹具覆盖取消、超时、父进程先退出和无关进程保护。
- 修复 Windows 服务归属查询失败被误判为停止的问题：元数据查询最多重试两次，持续失败报错并保留进程记录；身份不匹配仍拒绝接管或停止。新增服务身份确认失败时清理已持有的直接子进程。
- Windows 已登录 IDE 真实查询 Hub，并以 DeepSeek v4.1 Flash 原生子代理派发 MiMo；远端答案 `45`，IDE 后续结果查询受宿主权限限制。Linux CodeArts 显式 GLM-5.2 返回 `51`；部署修复后新单次任务返回 `52`，核验组归属与进程回收。此前超时保留为失败。详情见 [IDE 优先适配与实测](docs/codearts-ide-followup.md)。
- 最终 Windows 32/32 组、Linux 29/29 组回归通过，两端真实 SDK 0.1.21 协议验证通过。Linux 已同步 27 个源码文件和 CodeArts 原生组件；6 份受保护配置与 355 个旧任务结果逐字节校验未变。
- 本轮修改属于 v0.9.9 发布后的跟进，既有标签和安装包保持原版本内容。

## [0.9.9] - 2026-10-09

Hub、安装包、共享 MCP 和 Codex / ZCode / CodeArts / Antigravity 插件统一为 0.9.9；DSH 独立包为 1.4.0。Windows 32/32 组、Linux 29/29 组全量回归通过，后续修复通过对应增量验证并同步 Linux Hub；原生客户端实测及账号限制见 [0.9.9 交付记录](docs/release-0.9.9.md)。

### Antigravity 原生客户端与 SDK 子代理

- 新增第五种原生客户端 Antigravity：按桌面 2.21.1 的插件规范提供 manifest、SVG、九个 `agents/*.md` 路由子代理、四个 slash workflow skills 与独立 MCP 桥。沿用现有九种 worker，插件可连接独立的 Windows/Linux Hub。
- 新增原生目录安装器及一键安装包入口，支持自动发现、外部连接文件、幂等升级、归属哈希、冲突保留、备份及失败回滚；新目录需要重启宿主发现，文件安装不冒充宿主已加载。SDK 运行环境不会进入插件包。
- 增加可选 `google-antigravity==0.1.21` 适配，使用官方 `LocalAgentConfig`、`SubagentConfig`、MCP 与 Hooks，由 Python 有界编排 SDK 子代理。官方 Windows 轮子实测不含仓库示例中的 `beta.run_workflow`，按实际已发布能力实现；SDK 认证与桌面登录分开。
- Hub 为同步及异步 CLI 任务传入真实 worker 身份，六份 MCP 桥统一阻止 worker 派发给自身，同时保留普通客户端、跨 worker 派发和原 ref 查询。
- 修复 Windows venv Python 启动 Hub 时监听 PID 位于子解释器而被误判启动失败的问题；健康检查验证真实后代归属，停止按创建时间与固定进程实例筛选，不误停旧 PPID 外来进程，停止失败保留记录并返回失败。Linux 发现测试隔离已有 Hub，避免把正常发现的生产服务当成失败。
- 修复 Linux agy CLI 1.3.1 的 print 超时被误报成功：即使退出码为 0、JSON 为 `SUCCESS` 且已有部分文字，检测到官方明确的未完成诊断仍返回失败并保留原 ref。同步与异步均覆盖，异步有界扫描完整 stderr，避免后续长日志掩盖诊断；两端各 83 项增量检查通过，修复已同步 Linux 服务。
- Antigravity 接入阶段先保留当时的 README，独立说明和验收边界写入 `integrations/antigravity` 与 `docs/antigravity-compatibility.md`。0.9.9 的 README 更新和 Linux 原生验收另行记录，不改写这一阶段的报告。
- 接入阶段最终 Windows 32 组、Linux 29 组回归全部通过，两端测试源码哈希一致；保留初始失败及修复记录。Windows 原生组件已安装，新增桥跨机器真实 MiMo 默认任务返回 42；宿主模型自主调用和缺少独立 API 认证的 SDK 推理未验收。基础版本 0.9.0 的三种 ZIP 是未发布预览包；0.9.9 的回归与包校验使用新的独立报告。

### 发布与部署

- 安装包提供五种客户端与现有九种 worker；客户端、Hub 与可选 SDK 保持独立组件。SDK 源码随插件包分发，虚拟环境、认证文件、私有连接和模型会话不进入包。
- Windows Codex、ZCode 与 Linux ZCode、Antigravity 的真实原生子代理派发通过，宿主工具记录与 Hub 回执匹配。Windows DSH 受 402 额度限制，Linux 未安装 Codex / DSH，Windows Antigravity 桌面重启后的自主调用待验证，各项单独记录。
- Linux 生产 Hub 0.9.9 的 24 工具、9 worker、鉴权和历史结果检查通过，既有私有配置逐字节保持，每次切换前提供回滚备份。README 和两张 SVG 由 Linux agy 实际修改后核对事实与排版。
- 修复 CodeArts 官方两列模型列表及短模型 ID 的解析，两端各 22 项回归通过。9router 鉴权有效，但不能替代 CodeArts 独立身份及模型权限初始化；真实模型仍受认证阻止，尝试后的三份私有配置已恢复，未计为模型验收成功。

---

## [0.9.1] - 2026-10-09

### 文档与架构规范 / Documentation & Architecture

- **更新两张 README SVG 至 0.9**：结构图置于页面最前，完整展示多客户端、九种 worker、插件与 Hub 独立部署及跨机连接。进度图突出“优化体验”，展示已有能力、后续优化和真实验收边界。
- **统一项目正式展示名称为 `multi-agent-hub`**：README、两张 SVG、控制台标题、原生插件展示信息与相关说明保持一致。既有安装目录、连接配置位置及插件 ID 保留兼容。
- **历史路线补齐与说明规范**：更新 0.5–0.8 路线 SVG，清晰标注各阶段验收范围。

---

## [0.9.0] - 2026-10-09

### 华为 CodeArts 双向接入与第九种 Worker 适配 (`codearts`)

- **增加华为 CodeArts 第九种 worker**：支持 Windows IDE 内置 AgentKernel 与 Linux 官方 CLI 的自动发现、独立任务、模型目录校验和严格结果判定。
- **原生插件体系构建**：增加 CodeArts 原生 Hooks 插件、九个子代理、三个命令、调度技能与独立 MCP；分别适配 IDE `mcpServers` 和 CLI `mcp` 配置。
- **多端路由打通**：Codex、ZCode、DSH 增加 CodeArts 路由；四种客户端共用任务和结果协议，可连接另一台 Windows/Linux Hub。
- **全链路回归验证**：Windows 全量 26 组回归通过，Linux 六组增量和同步后的驱动测试通过。

---

## [0.8.0] - 2026-10-09

### 自动发现与连接选择

- 首次插件安装先扫描本机和局域网 Hub，展示候选让用户选择；没找到时提示手动地址。保留已有连接，非交互安装不会等待输入或静默选择服务器。
- 新增 connect.cmd / connect.sh，支持重新扫描、手动地址和切换；交互配对使用 token 文件或隐藏输入，健康检查与鉴权通过后原子保存外部连接文件。旧配置先私有备份，切换端点不复用另一端 token。
- 新增只读 hub_discover MCP 工具与 ZCode /hub-discover 命令；未配置或连接文件损坏时仍能加载发现工具，任务派发明确拒绝并提示设置连接。
- 修复配置只有 token、没有 URL 时可能回退本机的问题；读取私有配置必须有明确端点，空对象和 token-only 均拒绝派发。
- 实机发现并修复 Windows UDP 10054：本机没有响应导致的单个端口不可达不再结束整次扫描，仍接收其他机器的回复。Windows 两种客户端已通过默认广播自动找到 Linux Hub。
- Hub 新增有界 UDP 发现响应与公开健康元数据；扫描只发送随机查询标识，地址取自回复来源并验证 HTTP 健康，不发送凭据、不跟随重定向、不自动修改防火墙。不支持广播的网络与旧 Hub 保留手动连接。
- Codex/ZCode/MCP 和安装包升至 0.8.0，DSH 包升至 1.2.0；保留原 0.7.0 发布包与分阶段源码备份。
- 最终 Windows 21/21 组、Linux 19/19 组回归通过，测试期间与测试后源码哈希一致；真实默认广播及显式 IP 验证 8/8 通过，详细范围与安装包哈希见 docs/release-0.8.md。
- 正式三个 ZIP 在真实 Linux 安装与配对 54/54 项通过，覆盖非交互待配置、安装后 connect.sh 鉴权配对、三份原生 MCP 副本的 7 工具与只读发现；无新增模型调用。

### 交付记录

- 按 0.5 → 0.6 → 0.7 → 0.8 的独立源码检查点逐版提交与打标签；日期采用实际 Git 发布日，测试记录保留原日期。
- 记录测试 CLI 清理结果：Linux 临时 CodeBuddy 副本已卸载；Windows 8 个临时目标被自动审批拒绝，仍保留，不记作卸载成功。原有客户端和登录配置保持不变。

---

## [0.7.0] - 2026-10-09

### 能力约束与独立部署

- 分开提供 hub / plugins / both 三种可安装 ZIP，Windows / Linux 自动检测运行时与官方 CLI；应用、私有连接配置和运行数据分离。Hub 默认单独运行，控制台可选，客户端不会启动本地 Hub；重复安装保留配置并备份旧应用。
- 四份 MCP 桥统一读取外部 client.json；支持标准 Windows/XDG 路径和显式配置路径，保留 Codex PLUGIN_DATA 兼容。切换 Hub 端点不复用其他端点 token；DSH 不再以默认 localhost/空 token 覆盖配置文件。Codex/ZCode/MCP 版本 0.7.0，DSH 包从 1.0.0 升至 1.1.0。
- 能力查询升级到按 Hub 系统、worker、型号返回可用性。控制台删除没有对应官方参数的伪思考强度/上下文档位；动态禁用不支持的思考、流式和附件，Auto 与各派发入口使用相同服务端预检。
- 最近认证、区域、额度和型号错误使用有期限的结构化状态；手动清除状态不自动调用模型，偶发超时/空答不永久封禁 worker。
- 修复 worker 只存在于 profile 自定义 PATH 时预检误报缺失的问题；预检和派发统一继承环境与变量展开，Windows/Linux 真实临时入口均有回归覆盖。
- 修复 CodeBuddy 继承 lastUsed 代理模式后缺少 Read、只返回未执行 DSML 的根因；使用标准代理和明确的文件工具授权，Linux 图文任务已重新验证。思考与附件能力继续受所选型号限制。
- Windows Hub/Trae HTTP 使用独占端口绑定，避免同端口多个进程共监听导致健康检查误判；Linux 保留正常的地址复用行为。
- 修复原生安装的实际路径与缓存问题：创建隔离 Codex home，ZCode 使用安装副本的绝对目录 source，并通过官方保留数据重装刷新自有插件缓存；DSH 固定 Node 入口与外部连接文件。保留既有插件数据、禁用状态和其他插件。
- Linux 用户服务按安装目录派生独立 unit 并验证归属，启停与升级统一经过 systemctl；不支持的 systemd + console 组合提前拒绝。实机生命周期 18/18 检查通过。
- 支持插件跨 Windows/Linux 连接远端 Hub。新增实际双向网络探针：Windows→Linux 直连图文任务通过；当前 Linux→Windows 直连端口不可达，显式 SSH 反向转发后的图文任务通过。报告区分两种通道，没有把转发结果计成直连成功。
- 重写 README 的安装、服务端/客户端分工与数据流说明：请求和附件仍可能发送到模型服务商，自托管不等于模型离线或保证不泄露。详见 docs/release-0.7.md。
- 最终完整回归 Windows 19/19 组、Linux 17/17 组通过，期间源码哈希未变；正式三 ZIP 在真实 Linux 解压安装验收 43/43 通过。产物清单、SHA256、组件隔离和凭据模式审计均通过；账号授权、余额、区域、模型目录与直接网络不可达等外部限制保留为未通过。

---

## [0.6.0] - 2026-10-09

### 新增 / Added

- Codex 本地插件适配：共享 MCP 桥、8 个项目子代理 TOML 模板、并行调研/实施审查/多模型会诊技能，以及隔离安装预览。
- DSH 子代理与工作流适配：Cordis bundle、三个原生 `agent`/`parallel` 工作流和直接调用 Hub 的确定性 Node runner。
- 任务状态、文件锁、MCP、控制台、安装器与工作流的回归用例；测试采用隔离配置与 mock Hub，不重复消耗厂商模型额度。

### 修复 / Fixed

- MCP 桥正确识别同步 `exit=0` 成功和非零退出；空输出不再自动重复派发。派发断网返回 `unknown`，查询断网保留 ref，等待预算覆盖派发过程。
- 合并 MCP 多个文本块，检查 HTTP/JSON-RPC/tool `isError`，验证请求、参数及返回 ID；通知不触发工具执行。
- 任务仅允许认领者完成；统一 worker 别名并正确解析字符串 `false`。邮箱每次仅标记实际返回的 50 条消息，保留剩余未读。
- 状态锁改为有界的操作系统文件锁；Hub 与 worker 共享原子结果更新，避免并发丢失字段、旧快照回收新进度及进度覆盖终态。外部 ref/邮箱名称限制在状态目录内。
- Windows npm shim 使用子进程 PATH 并解析官方入口；相对脚本路径在切换工作目录前固定。进程组/Job Object、ConPTY、读流和登录取消统一回收。
- 异步 CLI 结果保留真正的 worker 名称与任务上下文；后台等待线程及时回收已结束的执行器。
- Trae HTTP 请求使用可终止的独立进程，GUI 与 CLI 使用有效的执行超时；ZCode 非零退出返回错误。Trae 非终态响应不再伪装为完成。
- Trae 独立 MCP 复用总线运行时与 HTTP 修复，通知返回明确空正文长度，支持异步 ref 查询及 Authorization 预检。
- 控制台预先占用正在发送的会话，拒绝无效显式会话 ID，按任务 ID 归属回信；重启后继续查询 pending ref，静态目录定位到实际 console/client。
- 控制台检查 Hub 返回的 JSON-RPC 与工具结果格式，仅从有效受理回执提取 ref；MCP 通知不执行工具，避免正文中的 ref 示例及无 ID 请求触发错误任务状态或派发。
- DSH patch 使用官方 `insert` 格式，避免 bundle/profile 双注册；安装器严格选择 profile，保留用户 persona、环境、URL 与 token。原生工作流校验结构化终态，子代理失败不再算成功。
- 控制台独立启动脚本改为当前仓库路径与环境配置；文档修正桌面驱动原生 WebSocket 需要 Node.js 22+（MCP 桥仍为 20+）。
- Windows 启停器加载 .env、使用 Windows worker 模板、检测可用 Python 和真实服务健康，只停止本目录记录且创建时间匹配的进程。Unix 停止脚本移除全局 pkill，改为核对本目录进程记录。

### 第二轮跨平台重构 / Cross-platform refactor (0.6.0)

- 统一任务契约：`model`、`thinking`、`stream`、附件；新增 `hub_capabilities` 和结构化 `hub_result_json`，四份 MCP 桥同步到 0.6.0。
- Windows 到 Linux 的附件按字节传输，Hub 在任务专属目录暂存并清理；最多 8 个文件、合计 1 MiB。拒绝路径穿越、无效 base64、凭据文件和不支持的组合。
- CodeBuddy / MiMo 使用实际 provider 思考开关；默认 Copilot auto 拒绝显式高思考，MiniMax M3.1 总是思考，明确区分不支持与成功。流式通过 MCP progress token 发送正文进度，非流式缓冲结果。
- 修复重复 `--format` 等标量参数使 MiMo 回退文本、思考混入答案的问题；保留已有 settings 权限字段，并支持 Antigravity 将选项放在提示词之前。
- 统一官方 CLI 输出解析，过滤推理与工具内容；识别 exit=0 的官方错误、401 登录失败和空回答，保留长答案和安全用量计数。失败不自动重派。
- 默认模型按指定表更新；MiMo 改为 `xiaomi/mimo-v2.6-flash`（`26f` / `v2.6f`）。控制台优先采用 Hub 配置默认值，修复旧目录将 9router/MiniMax M3 显示为默认及仅有模型目录就被自动派发的问题。
- Linux 启停器使用 `/proc` 进程身份和监听归属检查、原子记录和失败回收；修复 CRLF、旧 PID/端口误判及 `.env` 被当 shell 执行的问题。保留已有部署和账号配置。
- Hub 支持外部 `HUB_AGENTS_FILE` / `HUB_STATE_DIR` / `HUB_RESULTS_DIR`，Windows 启动器正确使用外部 worker 配置。移除结果目录自动串入历史部署的回退。
- 修复 Codex 原生插件环境过滤导致 Hub URL 丢失，支持外部 `PLUGIN_DATA/agenthub.json`；原生代理模板与 DSH 工作流传递思考、流式及附件选项。
- MiniMax 图片和文本文件转换为官方消息文件，替换原文本参数，避免重复发送；思考关闭与本地文件编辑仍明确不支持。
- Windows 结果读取对短暂共享冲突重试；损坏结果不能被当作不存在而覆盖，保护任务身份和上下文。
- 异步 CLI 分离 stdout / stderr，修复 MiniMax 流式答案和进度混入 spinner、`Response:` 状态提示；仅失败时附有界诊断。
- ZCode 新增官方 app-server 适配器，校验模型目录和会话实际型号后只发送一次任务；缺少指定 GLM 时拒绝，不静默回退。旧的无模型切换通道不能再用配置默认值伪装实际模型；隔离会话、正文流与超时回收有协议回归。
- 修复 Windows HTTP 拒绝请求后立即关闭未读正文造成 TCP 重置、客户端收不到 401 的竞态；先刷新错误响应，再有界丢弃请求体，不执行未授权工具。
- 控制台上传使用唯一文件名并读取实际上传字节；修复真实邮箱分页标题解析。消息/队列不再静默吞掉附件和思考选项。
- 新增源码阶段备份与 SHA-256 校验、当前树和 Git 历史密钥模式扫描。备份位于仓库外，排除运行数据和凭据文件；实际 Hub HTTP 请求使用 Authorization 头。

### 验证边界 / Validation scope

- Windows 隔离回归、真实 Ubuntu Linux 回归、Windows 控制 Linux 的实际任务，以及 Codex/ZCode/DSH 原生加载分别记录。详细结果见 `docs/compatibility-2026-10-08.md`，机器报告保留每次调用的实际通过、失败和前置阻塞。
- Codex、ZCode 已经由原生子代理派发真实任务，包含图片与文本附件。DSH 原生 MCP/预设被发现，实际子代理调用受官方账号余额限制；宿主退出码不代替 worker 结果验证。
- CodeBuddy 国内版和 MiMo 完成 Windows 16 组合实跑；MiMo 出现退出 0 空回答的失败，不能宣称全通过。国际版后续认证失败、Antigravity 地区限制、Trae SSO/网关、Linux MiMo26 凭据无效等均保留为明确限制。
- 未安装/未授权的 Linux 原生宿主、缺乏可验证模型开关的通道不记作通过。macOS 未实测，当前服务启动器只支持 Windows/Linux。
- 源码来自已验证的 stage06 检查点；验证没有替换用户日常客户端配置，源码不携带个人密钥。

---

## [0.5.0] - 2026-10-09

本标签恢复 2026-10-08 的 stage01 源码检查点。该备份已包含标为 0.6.0 的 Codex 适配初稿；保留原始代码与组件版本，不声称它是当时单独打包的正式 0.5.0 安装版。

### 新增 / Added

- `hub_login` 和 `/hub-login` 获取官方 CLI 授权链接、查询登录状态或取消等待；凭据由官方 CLI 留在 Hub 宿主机。
- Windows worker 配置模板及 8 worker 兼容性实测记录。CodeBuddy 国际/国内版账号目录隔离；MiniMax 使用实测模型，MiMo 默认 `xiaomi/mimo-v2.6-flash`（`v2.6f`）。
- Windows ConPTY 登录与 Job Object 子进程管理；MiMo 自动获取官方链接，未验证链接登录的通道返回人工操作指引。

### 此检查点包含的后续适配初稿


### 新增 / Added

- Codex 本地插件适配：共享 MCP 桥、8 个项目子代理 TOML 模板、并行调研/实施审查/多模型会诊技能，以及隔离安装预览。
- DSH 子代理与工作流适配：Cordis bundle、三个原生 `agent`/`parallel` 工作流和直接调用 Hub 的确定性 Node runner。
- 任务状态、文件锁、MCP、控制台、安装器与工作流的回归用例；测试采用隔离配置与 mock Hub，不重复消耗厂商模型额度。

### 修复 / Fixed

- MCP 桥正确识别同步 `exit=0` 成功和非零退出；空输出不再自动重复派发。派发断网返回 `unknown`，查询断网保留 ref，等待预算覆盖派发过程。
- 合并 MCP 多个文本块，检查 HTTP/JSON-RPC/tool `isError`，验证请求、参数及返回 ID；通知不触发工具执行。
- 任务仅允许认领者完成；统一 worker 别名并正确解析字符串 `false`。邮箱每次仅标记实际返回的 50 条消息，保留剩余未读。
- 状态锁改为有界的操作系统文件锁；Hub 与 worker 共享原子结果更新，避免并发丢失字段、旧快照回收新进度及进度覆盖终态。外部 ref/邮箱名称限制在状态目录内。
- Windows npm shim 使用子进程 PATH 并解析官方入口；相对脚本路径在切换工作目录前固定。进程组/Job Object、ConPTY、读流和登录取消统一回收。
- 异步 CLI 结果保留真正的 worker 名称与任务上下文；后台等待线程及时回收已结束的执行器。
- Trae HTTP 请求使用可终止的独立进程，GUI 与 CLI 使用有效的执行超时；ZCode 非零退出返回错误。Trae 非终态响应不再伪装为完成。
- Trae 独立 MCP 复用总线运行时与 HTTP 修复，通知返回明确空正文长度，支持异步 ref 查询及 Authorization 预检。
- 控制台预先占用正在发送的会话，拒绝无效显式会话 ID，按任务 ID 归属回信；重启后继续查询 pending ref，静态目录定位到实际 console/client。
- 控制台检查 Hub 返回的 JSON-RPC 与工具结果格式，仅从有效受理回执提取 ref；MCP 通知不执行工具，避免正文中的 ref 示例及无 ID 请求触发错误任务状态或派发。
- DSH patch 使用官方 `insert` 格式，避免 bundle/profile 双注册；安装器严格选择 profile，保留用户 persona、环境、URL 与 token。原生工作流校验结构化终态，子代理失败不再算成功。
- 控制台独立启动脚本改为当前仓库路径与环境配置；文档修正桌面驱动原生 WebSocket 需要 Node.js 22+（MCP 桥仍为 20+）。
- Windows 启停器加载 .env、使用 Windows worker 模板、检测可用 Python 和真实服务健康，只停止本目录记录且创建时间匹配的进程。Unix 停止脚本移除全局 pkill，改为核对本目录进程记录。

### 验证边界 / Validation scope

- Windows 隔离回归共 11 组通过，结果与源码 SHA-256 保存于 `docs/refactor-validation.json`；Codex 两种插件入口已用本机 CLI 在临时目录验证加载与 MCP 初始化。
- 本轮验证源码与隔离运行行为；Codex/DSH 适配尚未装入用户正在使用的客户端，未验证宿主内真实模型工作流。
- Windows 厂商兼容性结果保留于 `docs/windows-compatibility.md`：6 个 CLI 完成真实调用；Antigravity 受地区限制，Trae 桌面网关未就绪。此次未重新调用厂商模型。
- Unix 行为采用契约测试/语法检查，未作为 Linux 或 macOS 实机验证。

---

## [0.4.0] - 2026-10-07

### 发展路线图与生态规划 / Roadmap & Ecosystem
- **更新官方发展路线图矢量图 (`docs/roadmap.svg`)**：
  - 清晰标注系统演进 6 大阶段（Phase 1~3 已就绪、Phase 4 积极适配中、Phase 5 暂缓搁置·排在 DSH 后推进、Phase 6 规划中）；
  - 核心明确：优先做好 Windows 本地开箱即用体验（Windows-First），全力攻坚 DeepSeek Harness (DSH) 原生生态；Linux 复杂服务化启动暂时搁置，排在 DSH 适配之后、Codex 适配之前集中重构。
- **开源跨平台解耦与极简按需配置支持 / Cross-Platform Decoupling & Minimal Setup**：
  - 彻底清除历史硬编码路径与特定系统解释器路径（`/usr/bin/python3`、`/usr/bin/node`、`~/agent-hub`、`~/TraeClaw`），全面切换为动态自包含解析与 `sys.executable`；
  - 优化 Windows 与 Unix 跨平台异步进程组生命周期管理，避免僵尸进程；
  - 增强 TraeClaw 网关异常捕获与友好降级提示，杜绝未启动网关时崩溃抛错；
  - 提供 `hub/agents.minimal.example.json` 极简模板，支持仅配置 MiniMax 与 Trae 等任意 1~2 个 Agent 的轻量环境，未安装的 Agent 完全零干扰。
- **深度完善 ZCode 官方插件与工作流集成 (`agenthub-workers`)**：
  - 完善 8 大子智能体原生注册与自然语言缩写自动路由映射；
  - 借助 `hub-bridge` MCP（`hub_ask`、`hub_dispatch`、`hub_fetch`）彻底破除工作流 30 秒超时上限；
  - 坚决保障所有交付物免服务器单文件直接双击运行。
- **DeepSeek Harness (DSH) 原生生态积极适配推进中 / DSH Active Adaptation**：
  - 在 `integrations/dsh/` 提供 Cordis 微内核架构原生子代理预设（Presets）与工作流（Workflows）工程化源码；
  - 当前全面开展 Cordis 多 Profile 环境隔离与平滑注入测试。
- **规划 Codex 生态打通 (Phase 5 / Planned)**：
  - 规划跨平台双向智能体总线与流式上下文集成。

### 重构与升级 / Major Refactor & Upgrade
- **项目正式升级为 Multi-Agent Hub（`multi-agent-hub`）**：
  - 品牌与架构由分散组件全面进化为“一站式多智能体调度与协作总线”。
  - 提供根目录一键启动与停止工具（`start.sh` / `stop.sh`、`start.bat` / `stop.bat`），单命令并发拉起任务总线、Web 控制台并完成健康检查。
  - 统一根目录 `.env.example` 配置中心，集中管理总线端口、Web 控制台及认证 Token，告别多级子目录割裂配置。
  - Web 控制台全面更名与视觉升格为 `Multi-Agent Hub`。
  - 手机端竖屏排版重构：解决超窄屏下顶部 Header 与工具栏按钮被截断问题，全部操作项 100% 完整可见。

---

## [0.3.2] - 2026-10-07

### 新增 / Added
- **手机浏览器竖屏全响应式支持 / Mobile Vertical Responsive Layout**：
  - 活动栏自适应下沉为原生移动端底部导航栏（Bottom Navigation Bar），带大触控热区与全面屏安全区适配。
  - 顶部栏紧凑收纳（48px 单行），去除冗余副标题，防止小屏挤爆高度。
  - 对话视窗全面中置（860px 舒适阅读柱状区），己方对话右侧锚定、长度由右向左自适应收缩，最大宽度控制在 540px。
- **思维链自动折叠 / Auto-collapsible Reasoning & Thinking**：
  - 自动识别 `<think>` 标签、````thought```` 代码块及后端 `reasoning` 字段。
  - 默认暗调卡片折叠展示，支持一键展开/收起；无思考过程的消息不展示任何多余折叠按钮。
- **工作流 MCP 桥接（hub-bridge）/ Workflow MCP Bridge**：
  - 提供 `hub_ask`（阻塞式单调用出结果）、`hub_dispatch`（秒回 ref）和 `hub_fetch`（状态轮询），彻底解决工作流子代理 30s 框架调用上限问题。
  - 提供配套独立 CLI 脚本 `mcp/ask.mjs`，方便脚本与自动化管线直接调用。

### 修复 / Fixed
- **MiMoCode 非 AVX2 崩溃兼容 / MiMoCode Non-AVX2 Core Dump Fix**：
  - 自动回退至 baseline 版二进制，解决 Intel N5095（Jasper Lake）等老旧 x86 架构无 AVX2 指令集导致 SIGILL 静默无输出的问题。
  - 增加 `--pure` 选项解除外部插件循环递归，配合 9Router 解决上游 SSE 空轮次截断问题。
- **SVG 图标命名空间隔离 / SVG Unique ID Scoping**：
  - 为动态插入的品牌 SVG 注入实例唯一 ID 后缀（uid），根治多个相同 SVG 重复定义导致 `mask` / `linearGradient` 引用失效的渲染黑块问题。
- **界面排版去杂 / UI Clutter Cleanup**：
  - 子代理页面隐藏底层开发调试参数（CLI 路径、model_arg、心跳提示等），移除顶部冗余 KPI 空白卡片。
  - 右侧边栏多余的 `«` 浮动把手彻底移除，统一由常驻“工作台”按钮控制展开与收起。
  - 模态框增加“恢复默认”快捷按钮，方便一键重置自定义头像。

---

## [0.3.0] - 2026-10-06

### 新增 / Added
- **多通道并发调度工作流 / Multi-agent Fanout Workflow**：
  - 推出全局工作流 `hub-fanout`，支持跨多代理并发分发、结果阻塞汇总与统一报表输出。
- **无头模式防封体系 / Ban-free Headless Architecture**：
  - 采用各家官方 CLI 的无头参数（`-p` / `text chat`）与本地 CDP 桌面驱动，杜绝逆向反代与非官方 API 封号风险。

---

## [0.2.0] - 2026-10-06

### 变更 / Changed
- **8 大代理规范化命名体系 / Standardized 8-Agent Registry**：
  - 统一收敛为标准规范名：`zcode`、`antigravity`、`codebuddy`、`codebuddy-cn`、`mimocode`、`github-copilot`、`minimaxcode`、`traecode`。
  - 枢纽内置双向别名自动归一（支持 agy, cb, cbcn, mimo, gcp, mmx, trae 简写）。

---

## [0.1.0] - 2026-10-05

### 新增 / Added
- 初始版本发布：
  - `hub/agent_hub.py`：基于 JSON-RPC MCP over HTTP 的任务总线。
  - `console/server.mjs`：CodeBuddy 风格三栏 Web 控制台。
  - `drivers/*.js`：基于 CDP 驱动 VNC 桌面 AI（ZCode, TraeCode）执行管线。
