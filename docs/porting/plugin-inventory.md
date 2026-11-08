# multi-agent-hub 项目全量插件与功能改动清单（Plugin Inventory）

> **文档定位**：供上游（OpenMausBot）版本同步（如 `v0.1.142` → `v0.1.146` 及后续版本）时核对移植完整度、定位注册点与冲突规避方案。  
> **最终目标**：把 `multi-agent-hub` 完整拆解并无缝融入 OpenMausBot 工作台：统一账号切换、自动签到、派发与实时状态回报、全套国产 CLI 驱动与集中密钥、工作台调试与日常运维面板，确保每个 Bot 与力工均可稳定可用。

---

## 目录
1. [账号切换（Account Switching）](#1-账号切换account-switching)
2. [自动签到（Automatic Check-in）](#2-自动签到automatic-check-in)
3. [派发与实时状态回报（Dispatch & Real-time Status Reporting）](#3-派发与实时状态回报dispatch--real-time-status-reporting)
4. [CLI 驱动与模型（CLI Drivers & Models）](#4-cli-驱动与模型cli-drivers--models)
5. [工作台 UI（Workbench UI）](#5-工作台-uiworkbench-ui)
6. [尚未融进工作台的部分与建议落点](#6-尚未融进工作台的部分与建议落点)

---

## 1. 账号切换（Account Switching）

### 1.1 服务账号快照与多账号快速切换（Service Accounts）

| 维度 | 说明 |
| :--- | :--- |
| **功能定位** | 为每个引擎/服务保存多套 CLI 登录快照（凭据目录与配置备份），支持在设置页一键无缝切号；切号后回收空闲 CLI 进程，后续新任务直接应用新账号，避免旧凭据滞留。 |
| **入口文件** | • 后端核心服务：`server/service-accounts.ts`<br>• HTTP 路由：`server/routes/service-accounts.ts`<br>• 前后端共享协议契约：`shared/service-accounts.ts`<br>• 前端交互组件：`src/components/ServiceAccounts.tsx` |
| **注册点** | • **路由挂载**：`server/index.ts`（挂载 `createServiceAccountRoutes`，端点 `/api/instances/:id/service-accounts`，支持 GET 获取账号列表、POST 保存/切换账号、DELETE 删除快照）<br>• **设置页注册**：`src/components/EnginesSettings.tsx`（在已就绪引擎实例卡片中挂载 `<ServiceAccounts instance={instance} />`）<br>• **i18n key**：`src/locales/*.json` 中的 `serviceAccounts.*`（含 `title`、`none`、`hint`、`add`、`addHint`、`nameLabel`、`namePlaceholder`、`saveCurrent`、`active`、`switch`、`remove`、`switched`、`drifted`、`note.sharedGh` 等） |
| **依赖的上游 API** | • `InstanceConfig` 与 `server/config.ts` 的配置存取<br>• `server/harness/registry.ts` 的实例与驱动注册表（`registry.instances()`、`registry.forgetSnapshots()` 驱动重探测）<br>• `server/index.ts` 中的 `threadBusy`（任务繁忙状态检查，避免在任务执行中切号）<br>• 操作系统文件系统权限控制（0600 凭据存储规范）与 CLI 凭据默认目录探测机制 |
| **与上游易冲突点** | • `server/index.ts`：路由挂载队列 `ROUTES.push(...)` 的顺序与闭包参数传递<br>• `src/components/EnginesSettings.tsx`：上游频繁微调引擎卡片内布局与按钮组件，合并时需保留 `<ServiceAccounts>` 挂载点 |
| **定向测试文件** | • `server/service-accounts.test.ts`<br>• `server/routes/service-accounts.test.ts`<br>• `src/components/ServiceAccounts.test.ts` |

---

## 2. 自动签到（Automatic Check-in）

### 2.1 每日活跃与厂商签到核心服务（Check-in Engine）

| 维度 | 说明 |
| :--- | :--- |
| **功能定位** | 整合各国产与主流模型平台（Qoder、Qoder CN、WorkBuddy/CodeBuddy、MiniMax、Trae 等）的自动化签到、会话保活、设备指纹生成与额度配额同步。 |
| **入口文件** | • 签到总调度入口：`checkin/checkin.mjs`<br>• 厂商适配实现：`checkin/qoder.mjs`、`checkin/qoder-device.mjs`、`checkin/minimax-checkin.mjs`、`checkin/trae-checkin.mjs`、`checkin/vendor-quota.mjs`、`checkin/quota-deep.mjs`<br>• 账号与认证层：`checkin/accounts.mjs`、`checkin/auth.mjs` |
| **注册点** | • **路由挂载**：通过 `server/hub-bridge.ts` 代理到控制台/调度器服务，对外暴露 `/hub/checkin/*` 接口<br>• **构建/排除规范**：`checkin/*.mjs` 为纯 ESM 模块，不打入 om 工作树（保持独立解耦由 bridge 桥接） |
| **依赖的上游 API** | • Node 原生 `crypto`、`fs/promises`、标准 `fetch`<br>• 各平台官方 OpenAPI / Web 签到端点与安全认证协议 |
| **与上游易冲突点** | • 该部分作为独立业务模块存放于 `checkin/` 目录，移植到 `openmausbot` 工作树时严格配置排除，避免污染上游核心运行时 |
| **定向测试文件** | • `server/checkin.test.ts`<br>• `tests/console_checkin_service.mjs`<br>• `tests/console_checkin_credentials.mjs`<br>• `tests/console_checkin_account_sync.mjs`<br>• `tests/console_qoder_daily.mjs`<br>• `tests/console_minimax_daily.mjs`<br>• `tests/console_trae_daily.mjs`<br>• `tests/console_codebuddy_checkin.mjs` |

### 2.2 工作台日常签到与配额面板（Daily Section）

| 维度 | 说明 |
| :--- | :--- |
| **功能定位** | 在工作台全局设置中提供“日常”页，集中展示各厂商平台的今日签到状态、最近签到时间、自动签到计划，以及各 Worker 的剩余配额/积分与重置倒计时。 |
| **入口文件** | • 前端页面组件：`src/components/DailySection.tsx` |
| **注册点** | • **设置页侧栏注册**：`src/components/SettingsModal.tsx`（注册 `case "daily": return <DailySection />;`，导航标签 `settings.daily.title`）<br>• **i18n key**：`src/locales/*.json` 中的 `settings.daily.*`（`checkin`、`checkinHelp`、`run`、`running`、`runFailed`、`today`、`autoAt`、`statusSuccess`、`statusPending`、`statusFailed`、`lastCheckin`、`credits`、`quota`、`quotaHelp`、`used`、`unlimited`、`reset`、`unreachable` 等） |
| **依赖的上游 API** | • 8801 的内部 REST/bridge 接口（`/hub/checkin/status`、`/hub/quota`）<br>• 工作台通用 UI 体系（`Card`、`Button`、`Badge`、Tailwind 样式系统） |
| **与上游易冲突点** | • `src/components/SettingsModal.tsx` 的 Section 枚举定义和侧栏导航列表追加（上游发版时常有增删设置选项卡） |
| **定向测试文件** | • 前端组件轻量测试或由宿主 build 检查集成 |

---

## 3. 派发与实时状态回报（Dispatch & Real-time Status Reporting）

### 3.1 旧 AgentHub 契约兼容服务（hub-compat）

| 维度 | 说明 |
| :--- | :--- |
| **功能定位** | 独立运行于 8765 端口的 MCP/JSON-RPC 适配层，承接旧架构工具调用，将 `hub_dispatch_cli`、`hub_wait_result`、`hub_task_status`、`trae_delegate`、`zcode_delegate` 映射到 OpenMausBot 8801 内部 Bot 线程，提供长任务异步受理、界面快照解析、防超时心跳续期与自动回收。 |
| **入口文件** | • 守护进程入口：`server/hub-compat/main.ts`<br>• 工具派发与状态机调度：`server/hub-compat/dispatch.ts`<br>• 结果持久化存储：`server/hub-compat/store.ts`<br>• 契约定义：`server/hub-compat/contract.json` |
| **注册点** | • **独立网络服务**：监听 `127.0.0.1:8765`（支持 `/mcp` HTTP/SSE 与 `/tools/*` 协议）<br>• **工作台对接**：调用 8801 内部接口 `POST /api/threads/:id/messages`、`GET /api/threads/:id`、`GET /api/bots` |
| **依赖的上游 API** | • OpenMausBot RESTful API：Threads（会话与回合读取）、Bots（机器人元数据）、Instances（模型修补）<br>• 工作区数据目录：`~/.multi-agent-hub/hub-state/results/` |
| **与上游易冲突点** | • 上游消息格式变更时 `dispatch.ts` 的 `ThreadView` 解析提取逻辑需同步对齐；移植到 om 仓时排除 `server/hub-compat/` 目录 |
| **定向测试文件** | • `server/hub-compat/dispatch.test.ts`<br>• `server/hub-compat/main.test.ts`<br>• `server/hub-compat/store.test.ts` |

### 3.2 控制台反向代理桥接器（hub-bridge）

| 维度 | 说明 |
| :--- | :--- |
| **功能定位** | 在 8801 主服务中挂载 `/hub/*` 反向代理路由，安全桥接本机控制台 `:8890` 与调度器 `:8790`，实施严格的 loopback 固定上游白名单与防 SSRF 保护，设置 3 秒超时熔断。 |
| **入口文件** | • 路由与代理实现：`server/hub-bridge.ts` |
| **注册点** | • **路由挂载**：`server/index.ts`（`ROUTES.push(createHubBridgeRoutes())`）<br>• **前端页面集成**：`src/components/HubSection.tsx`（通过 iframe 嵌入安全控制台）<br>• **设置页注册**：`src/components/SettingsModal.tsx`（`case "hub": return <HubSection />;`）<br>• **i18n key**：`settings.hub.*` |
| **依赖的上游 API** | • 8801 HTTP 路由器（`ROUTES` 注册表与请求分发）、Node `http` 转发模块 |
| **与上游易冲突点** | • `server/index.ts` 路由表挂载位置（需位于静态文件分发与通配路由之前） |
| **定向测试文件** | • `server/hub-compat/dispatch.test.ts`（覆盖桥接通信） |

---

## 4. CLI 驱动与模型（CLI Drivers & Models）

### 4.1 国产八大 CLI 驱动与 ACP 适配器

| 维度 | 说明 |
| :--- | :--- |
| **功能定位** | 全面适配国内主流 AI 编程 CLI 工具，提供统一的标准 ACP（Agent Control Protocol）驱动抽象、环境隔离、思考流式控制与错误恢复。 |
| **入口文件** | • CodeBuddy 国际与 CN 驱动：`server/drivers/acp/codebuddy.ts`<br>• Qoder 国际与 CN 驱动：`server/drivers/acp/qoder.ts`<br>• CodeArts Agent 驱动：`server/drivers/acp/codearts.ts`<br>• MiniMax mcode 驱动：`server/drivers/acp/mcode.ts`<br>• Meoo 驱动：`server/drivers/acp/meoo.ts`<br>• ZCode 驱动：`server/drivers/acp/zcode.ts`<br>• ZCode app-server 桥接：`server/drivers/zcode-acp.ts`<br>• 独立进程 ACP 适配：`server/drivers/codearts-acp.ts`、`server/drivers/mcode-acp.ts`、`server/drivers/meoo-acp.ts`<br>• 测试替身：`server/testing/fake-zcode-app-server.mjs` |
| **注册点** | • **驱动注册**：`server/drivers/builtIn.ts`（在 `BUILT_IN_DRIVERS` 数组中追加 `CodeBuddyDriver`、`CodeBuddyCnDriver`、`QoderDriver`、`QoderCnDriver`、`CodeArtsAgentDriver`、`McodeAgentDriver`、`MeooAgentDriver`、`ZcodeAgentDriver`）<br>• **Fleet 映射**：`server/instance-fleets.ts`（`DEFAULT_FLEET` 与 `PRODUCT_FLEET_ADDITIONS`）<br>• **进程策略**：`server/engine-memory.ts`（`ENGINE_PROCESS_KINDS` 集合）<br>• **工具范围支持**：`shared/tool-scope-support.ts`（注册驱动支持的 tool scopes）<br>• **版本钉策略**：`server/engine-versions.ts`（加入 `{ target: LATEST, minimum: "0.0.0" }`，满足 `engine-updates.test.ts` 断言）<br>• **厂商库注册**：`src/components/EngineLibrary.tsx`（注册展示名称、描述与官网链接）<br>• **i18n key**：`src/locales/*.json` 中的 `engines.*` 与 `providers.*` |
| **依赖的上游 API** | • `server/drivers/acp/core.ts`（`AcpAgentDriver` 基类、`childEnv` 生成与进程生命周期）<br>• `server/contracts.ts`（`ProviderDriver` 接口定义、`InstanceConfig`、`AgentMessage`） |
| **与上游易冲突点** | • `server/drivers/builtIn.ts` 数组末尾易与上游新增驱动产生冲突（如 0.1.146 新增 `commandCodeAgent`）<br>• `shared/tool-scope-support.ts` 与 `server/instance-fleets.ts` 单行键值对合并需取并集 |
| **定向测试文件** | • `server/drivers/acp/acp.test.ts`<br>• `server/drivers/zcode-acp.test.ts`<br>• `server/drivers/zcode-acp-bridge.test.ts`<br>• `server/drivers/acp/codebuddy-effort.test.ts`<br>• `server/drivers/acp/central-keys.test.ts` |

### 4.2 集中 Key 部署与环境注入（Central CLI Keys）

| 维度 | 说明 |
| :--- | :--- |
| **功能定位** | 集中管理用户部署的统一 API Key（OpenAI 兼容、Anthropic、Gemini、智谱 Zhipu/BigModel、TypeSafe 等），以 0600 权限存入 `config.json`；在启动 CLI 子进程时，仅针对声明了该凭据的驱动安全注入环境变量；ZCode 支持套餐额度与注入 Key 双模式共存；Key 全程不进日志、不进回执、前端只回显末四位。 |
| **入口文件** | • 密钥映射与注入核心：`server/cli-keys.ts` |
| **注册点** | • **凭据环境白名单**：`server/credential-env.ts`（`PROVIDER_CREDENTIAL_ENV` 注册 `ZHIPU_API_KEY`、`BIGMODEL_API_KEY` 等敏感变量防护）<br>• **配置 Schema**：`server/config.ts`（新增 `gemini { key, url }`、`zhipu { key, url, models }` schema 并参与持久化合并）<br>• **注入挂载点**：`server/drivers/acp/core.ts`（在 `childEnv()` 的非声明凭据过滤后调用 `applyCentralCliKeys`）<br>• **前端 Key 目录**：`src/components/keys/key-catalog.ts`（在 AI Providers 分区中新增 Gemini 与 Zhipu 行）<br>• **安全脱敏状态**：`server/index.ts`（在 `configStatus()` 中通过 `keyStatus()` 仅暴露末四位与配置状态）<br>• **i18n key**：`keys.label.gemini`、`keys.label.zhipu` 等 |
| **依赖的上游 API** | • `server/config.ts`（`saveConfig`、`readConfig`、`Config` 类型定义）<br>• `server/drivers/acp/core.ts` 的子进程环境变量注入流 |
| **与上游易冲突点** | • `server/config.ts` 的 schema 定义列表合并；`server/credential-env.ts` 常量数组追加 |
| **定向测试文件** | • `server/cli-keys.test.ts`<br>• `server/drivers/acp/central-keys.test.ts`<br>• `server/config.test.ts` |

### 4.3 驱动源码指纹与模型目录缓存失效机制（Driver Fingerprint）

| 维度 | 说明 |
| :--- | :--- |
| **功能定位** | 对 `server/drivers` 目录下所有驱动源码进行 SHA-256 哈希计算得到 `driverFingerprint`，并注入到 `~/.openmausbot/providers/engine-models/<instanceId>.json` 模型缓存文件中。当驱动代码改动（如增删模型支持）时，缓存自动失效并触发重探测，无需人工删除缓存或重启，探测失败自动优雅回退旧缓存。 |
| **入口文件** | • 模型目录管理：`server/startup-model-catalog.ts` |
| **注册点** | • **缓存文件元数据**：`StartupModelCacheEntry` 扩展 `fingerprint: string | null` 字段<br>• **失效判定链**：`openStartupModelCatalog` 中除校验 `buildStamp` 和超时外，增加 `entry.fingerprint === currentFingerprint` 校验 |
| **依赖的上游 API** | • `server/environment.ts`（`buildStamp()`、`SERVER_ROOT` 路径定位）<br>• Node 原生 `crypto`（`createHash("sha256")`）、`fs` 递归扫描 |
| **与上游易冲突点** | • `server/startup-model-catalog.ts` 是上游 0.1.143 新增模块，同步时需保持指纹生成函数 `driverFingerprint` 与缓存校验逻辑 |
| **定向测试文件** | • `server/startup-model-catalog.test.ts` |

### 4.4 Worker 禁用与模型隐藏开关（Disabled & Hidden Models）

| 维度 | 说明 |
| :--- | :--- |
| **功能定位** | 支持对指定引擎实例进行停用（`disabled: true`），以及针对特定高耗额度或不可用模型进行前端隐藏（`hiddenModels: string[]`）；选择器自动隐藏不可选模型，但已绑定的会话仍可正常加载。 |
| **入口文件** | • 服务端配置：`server/config.ts`<br>• 实例更新路由：`server/routes/instances.ts`<br>• 前端模型选择与可见性过滤：`src/lib/model-choices.ts`、`src/lib/engine-rail.ts`、`src/components/EnginesSettings.tsx` |
| **注册点** | • **配置 Schema**：`server/config.ts` 与 `server/claude-accounts.ts` 扩展 `disabled` 和 `hiddenModels`<br>• **路由端点**：`server/routes/instances.ts`（`PATCH /api/instances/:id` 写入/清空配置）<br>• **运行时透出**：`server/index.ts`（`describeInstances` 中为各模型注入 `hidden: true`，为实例注入 `disabled`）<br>• **UI 设置组件**：`src/components/EnginesSettings.tsx` 中的 `ModelVisibility` 开关列表 |
| **依赖的上游 API** | • `InstanceConfig` 结构体、`modelChoices` 过滤管线 |
| **与上游易冲突点** | • `server/index.ts` 中 `describeInstances` 的对象展开表达式合并 |
| **定向测试文件** | • `server/instance-settings.test.ts`<br>• `src/components/EnginesSettings.models.test.ts` |

---

## 5. 工作台 UI（Workbench UI）

### 5.1 调试区全域隔离（Debug Zone）

| 维度 | 说明 |
| :--- | :--- |
| **功能定位** | 防止自动化测试、压测、hub 派单调试创建的海量临时 Bot（前缀 `hub·`、`debug: true`、`source === "hub"`）干扰用户正常工作流。在常规视图下，侧边栏、命令面板（`Ctrl+K`）、全文搜索结果、收件箱列表全量隐藏调试机器人及相关线程；仅在开启“高级模式”（Advanced Mode）时在侧栏独立折叠分区及各搜索入口展示。 |
| **入口文件** | • 判定核心库：`src/lib/debug-zone.ts`（提供 `isDebugBot`、`isDebugSearchHit`、`isAdvancedModeEnabled` 等函数）<br>• 侧栏专属分区组件：`src/components/SidebarDebugSection.tsx`<br>• 过滤拦截组件：`src/components/Sidebar.tsx`、`src/components/CommandPalette.tsx`、`src/components/SearchResults.tsx`、`src/components/inbox/inbox-view.ts` |
| **注册点** | • **侧栏挂载**：`src/components/Sidebar.tsx`（在常规 Bot 列表之后渲染 `<SidebarDebugSection>`）<br>• **快捷面板过滤**：`src/components/CommandPalette.tsx`（过滤 Bot 及会话搜索结果）<br>• **全文检索过滤**：`src/components/SearchResults.tsx`（搜索结果根据 `isDebugSearchHit` 排除）<br>• **收件箱过滤**：`src/components/inbox/inbox-view.ts`（收件箱分组隐藏调试线程）<br>• **i18n key**：`src/locales/*.json` 中的 `sidebar.section.debug`（“调试区”） |
| **依赖的上游 API** | • `src/lib/interface-mode.ts`（`useAdvancedMode` Hook）<br>• `src/state/store.tsx`（响应式 Bot 与会话状态） |
| **与上游易冲突点** | • `src/components/Sidebar.tsx`：上游每次发版均重度改动侧栏渲染管线（如 `everydayBots` 分组逻辑），移植时需确保调试 Bot 过滤条件与 `SidebarDebugSection` 正确插回 |
| **定向测试文件** | • `src/lib/debug-zone.test.ts`<br>• `src/components/Sidebar.debug-zone.test.ts`<br>• `src/components/SidebarDebugSection.test.ts`<br>• `src/components/CommandPalette.debug-zone.test.ts`<br>• `src/components/SearchResults.debug-zone.test.ts`<br>• `src/components/inbox/inbox-view.test.ts` |

### 5.2 Jev 决策代理设置（Decider / Jev Proxy）

| 维度 | 说明 |
| :--- | :--- |
| **功能定位** | 为 Jev 决策模型（群聊发言者判定、关键内容提取等）提供专属代理网络通道。实现优先级：`cfg.decider.proxyUrl` > `JEV_PROXY` 环境变量 > 直连；通过 `undici.ProxyAgent` 注入专有 fetch，支持 http、https 与 socks（socks5/socks5h/socks4）协议；提供带掩码脱敏的安全回显与保存，绝不记录明文密码日志。 |
| **入口文件** | • 网络代理与掩码层：`server/decider/proxy.ts`<br>• 配置验证 Schema：`server/decider/config.ts`<br>• 决策路由端点：`server/routes/decider.ts`<br>• 前端设置界面：`src/components/DecisionModelSettings.tsx` |
| **注册点** | • **路由端点**：`server/routes/decider.ts`（挂载 `GET /api/decider/proxy` 获取脱敏 URL，`PUT/POST/PATCH /api/decider/proxy` 更新代理配置）<br>• **设置页 UI**：`src/components/DecisionModelSettings.tsx`（在 Jev 设置卡片中提供代理输入框、占位符、脱敏回显及保存按钮）<br>• **状态结构**：`src/state/config-status.ts`（`ConfigStatus.decider` 增加 `proxyUrl` 字段）<br>• **i18n key**：`decider.jev.proxy.title`（“Jev 代理设置”）、`decider.jev.proxy.help`（“留空则使用环境变量或直连。”） |
| **依赖的上游 API** | • `npm:undici` 的 `ProxyAgent` 与 `fetch`<br>• `server/decider/index.ts`（决策服务初始化与重载） |
| **与上游易冲突点** | • `src/components/DecisionModelSettings.tsx` 前端卡片布局结构 |
| **定向测试文件** | • `server/decider/jev-proxy.test.ts`<br>• `server/routes/decider.test.ts` |

### 5.3 厂商与模型提供商图标体系（Provider Icons）

| 维度 | 说明 |
| :--- | :--- |
| **功能定位** | 扩充 OpenMausBot 原生图标库，补齐国内主要编程 CLI 厂商的矢量与品牌图标。 |
| **入口文件** | • 图标定义与分发：`src/components/ProviderIcons.tsx` |
| **注册点** | • **组件导出**：`CodeBuddyMark`、`QoderMark`、`MiniMaxCodeMark`、`CodeArtsMark`、`MeooMark`、`ClineMark`、`ZCodeMark`<br>• **统一选择器**：`ProviderMark` 中按 `driverKind` 匹配渲染对应图标<br>• **厂商库展示**：`src/components/EngineLibrary.tsx` 卡片渲染 |
| **依赖的上游 API** | • React SVG 组件机制、Tailwind 色调类系统 |
| **与上游易冲突点** | • 上游发版常在 `ProviderIcons.tsx` 中增加新图标（例如 0.1.146 新增 `CommandCodeMark`），三方合并时需保留本项目全部国产厂商图标分支 |
| **定向测试文件** | • `src/components/ProviderIcons.engines.test.ts` |

---

## 6. 尚未融进工作台的部分与建议落点

为达成“将 multi-agent-hub 整个拆开，融进 OpenMausBot 工作台”的最终目标，以下能力目前仍留在独立脚本或仅处于单向展示状态，需后续逐步落地为原生工作台交互：

| 尚未融入的部分 | 当前现状分析 | 建议落点与实现方式 |
| :--- | :--- | :--- |
| **1. 自动签到无前端触发入口与定时巡检器** | 签到逻辑完备（`checkin/*.mjs`），`DailySection.tsx` 仅支持静态查看上报状态，用户无法在工作台内手动触发即时签到，亦未接入系统后台定时调度。 | **建议落点**：在 `src/components/DailySection.tsx` 操作栏增加「立即全部签到」按钮，通过 `server/routes/checkin.ts` 路由触发并发签到任务；同时在 8801 后台注册 Routine 任务（每天固定时段自动巡检签到并弹窗/通知回报）。 |
| **2. 派发长任务缺乏发令方会话内的实时动态进度气泡** | 通过 `hub_dispatch_cli` 派发给 ZCode / Trae 等长任务 Worker 后，虽然服务端维护了状态快照，但发令方（主控 Bot）的消息流中只有一次性回执，无法动态感知进度。 | **建议落点**：利用 OpenMausBot 的 `WidgetMessage`（动态交互卡片）或 `RichMessageRow`，在发令方对话流中渲染 Worker 实时任务进度卡片（含步骤条、受控端快照折叠框、取消按钮），由 `hub-compat` 经内部事件总线推送实时状态。 |
| **3. 服务账号多凭据切换尚未支持 Bot 级绑定与桌面 GUI 联动** | 当前切号属于引擎全局行为（切换磁盘凭据并回收 CLI 进程），无法为不同 Bot 独立指定不同账号；此外桌面版客户端（ZCode Linux、Trae GUI）切号后无法自动驱动桌面重登。 | **建议落点**：在机器人专属设置面板（`src/components/bot-settings/AccessSection.tsx`）中增加「关联服务账号」选择项；对桌面 GUI 驱动扩展注销/重启拉起桥接协议。 |
| **4. Jev 决策代理缺乏针对国内/国外服务的分流规则** | 当前 Jev 代理为全局单一 `proxyUrl`，若配置代理，国内极速接口与国外 TypeSafe/BrowserUse 会同时走该代理，增加国内链路延迟。 | **建议落点**：在 `server/decider/proxy.ts` 引入基于域名白名单的分流 Dispatcher，并在 `src/components/DecisionModelSettings.tsx` 增加「仅代理境外服务」开关。 |
| **5. 调试区 Bot 在移动端与受限视图下的过滤未全量贯穿** | 目前已在侧栏、命令面板、全局搜索和收件箱做了过滤，但在移动端触屏抽屉或紧凑模式的部分子视图仍可能露出。 | **建议落点**：将 `isDebugBot` 过滤判定提升至服务端 `describeBots` 或统一的客户端 Store selector 层（`useFilteredBots`），保证全端一致性。 |

---

## 7. 每次上游同步后的核对清单

- [ ] `server/drivers/builtIn.ts` 的 `BUILT_IN_DRIVERS` 里 8 个国产驱动仍在，import 没被上游覆盖；
- [ ] `server/instance-fleets.ts` 的 `DEFAULT_FLEET` / `PRODUCT_FLEET_ADDITIONS` 两组映射都在；
- [ ] `server/engine-memory.ts` 的 `ENGINE_PROCESS_KINDS`、`shared/tool-scope-support.ts`、
      `src/components/EngineLibrary.tsx` 的并集没丢条目；
- [ ] `server/index.ts` 仍有 `createHubBridgeRoutes`、`createServiceAccountRoutes` 两个 `ROUTES.push`；
- [ ] `PATCH /api/instances/:id` 仍处理 `disabled` / `hiddenModels`；
- [ ] `src/components/SettingsModal.tsx` 仍有 `hub` / `daily` 两个 section；
- [ ] `src/components/EnginesSettings.tsx` 仍挂载 `ServiceAccounts` 与 `ModelVisibility`；
- [ ] `src/components/Sidebar.tsx` 仍有调试区分组（`SidebarDebugSection`）；
- [ ] `server/cli-keys.ts`、`server/decider/proxy.ts`、`server/startup-model-catalog.ts`
      的指纹/代理代码仍在；
- [ ] `src/locales/*.json` 的 `i18n:check` 通过；
- [ ] `server/engine-versions.ts` 覆盖所有会安装的驱动（含本项目新增的 CodeBuddy）。
