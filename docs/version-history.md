# Git 版本与检查点

Git 发布日期：2026-10-09。0.5–0.8 按下表顺序独立提交、打标签并逐次推送；提交日期没有回填成备份日期。这四个检查点之外的修改仅限发布说明、更新日志和测试报告中个人局域网代理地址脱敏，运行源码保持一致。

| 标签 | 备份 | 文件数 | 备份 SHA256 |
| --- | --- | ---: | --- |
| v0.5.0 | agenthub-stage01-before-20261008-175905.zip | 133 | `5f59cbde7113747d41797b58853c014d7fe37cb006c4755afc3e7a1b2ef79474` |
| v0.6.0 | agenthub-stage06-final-verified-20261008-192350.zip | 222 | `6e5cead3ad48d89b7dff6d1985686d0739394e94d386f43db2592d62cf1ed233` |
| v0.7.0 | agenthub-stage10-final-release-20261008-202551.zip | 272 | `cffd002dabe9ff05ebc22d9021c176f68422c2946f974f855b58931b251f8a57` |
| v0.8.0 | agenthub-stage14-before-version-push-20261009-081155.zip | 298 | `67b85a0d69b30de0b9327ee62dce777a198603a6465a2a0937711b1b4b423157` |

0.5.0 使用最早保存的 stage01：其中 ZCode/MCP 为 0.5.0，但已包含标为 0.6.0 的 Codex 初稿。该标签如实保存这一混合阶段，不改写组件版本，也不称为历史正式安装包。

0.6.0 和后续版本使用各阶段完成验收后的快照。

0.8.0 的 stage14 与 stage13 的源码一致，仅多两份 2026-10-09 测试 CLI 卸载记录。

所有备份均核对 ZIP CRC 与每个文件的 SHA256；各版推送前扫描源码和 Git 历史中的密钥模式。模式扫描存在覆盖边界，不代表对所有秘密形式的绝对保证。

安装包仍为本机产物，未上传 GitHub Release 附件。标签可用于获取对应源码；测试报告记载的模型、账号、网络和宿主限制继续有效。

## 后续版本

- `v0.9.0`：华为 CodeArts 双向接入与第九种 Worker 适配；四种客户端共用任务与结果协议。
- `v0.9.1`：包含 CodeArts 双向接入与 README / SVG 更新，统一项目名称与多端规范。
- `v0.9.9`：增加 Antigravity 原生插件及可选 SDK，完成五种原生客户端与九种 Worker 的生产发布与验收。（原 changelog 误记为 0.9.2，已更正）
- `v0.9.9.1`：CodeArts 官方凭据自动加载、TraeCode 网关终态校验与倍率对齐、子代理模型目录当季精简去重；修复 IDE 扩展四段版本号导致的扫描崩溃并恢复附件按钮。（原 changelog 误记为 0.9.3，已更正）
- `v0.9.4`（console/WebUI 线里程碑，编号保留）：WebUI 控制台升级为 CodeBuddy 三栏式布局，支持时段问候语、全局头像定制、全量会话聚合归档与二次确认一键删除、一键复制 Agent 接入配置及全环境剪贴板兼容；完成 MiniMaxCode 双向适配（Worker + MiniMax Plugin V1 / Claude Code / Agent Plugins 1.0 一包四吃）；切换为 Apache License 2.0 开源协议。
- `v0.9.9.2`：9 Worker 登录链路状态检测化重构（杜绝假成功）、CodeBuddy 新版 XDG 共享会话存储对齐与官方 state 兑换看门狗、Trae PKCE 授权链接修复、ZCode 国际/国内双区切换、MiMo API Key 通道与账号分离、MiniMax 账户名注入识别、模型别名逐个可删；全场组件版本统一，后续版本自 0.9.9.2 递增。
- `v0.9.9.3`：UI/UX 体验专项升级与零依赖交互 Demo 发布。底栏模型弹窗左右贴靠自适应、精简思考档位标签（`模型名 · 思考档位`）、极简纯图标回到底部悬浮键、全局 Squircle R 角与 Logo 标准统一（消除 ZCode 插件图标缺失）、卡片去框化与信息冗余净化、会话折叠平滑 CSS 渐变过渡动画、气泡操作重塑为底角独立复制图标并附带反馈动效、彻底消除顶栏头像纵向拉伸；推出包含内存虚拟驱动引擎的单文件纯前端交互 Demo 打包体系（`build_demo.py` + `demo_engine.js`），支持脱机运行与全功能免后端体验。
- `v0.9.9.4`：色系调色板矩阵重构与侧栏智能悬浮收展引擎。彻底清理老旧预设背景，全面聚焦于 Mocha 与 Shell 两大色系；重构主题配色体系，基于每种预设量身定制专属的深色与浅色模式（Mocha Dark `#1e1e2e` / Latte Light `#eff1f5`，Shell Dark `#0f0f11` / Paper Light `#f8f9fa`），使背景、侧栏、卡片、输入框与消息气泡全面浑然一体，消除色彩脱节；研发智能侧栏悬浮收展引擎，剔除机械点击强制收起的生硬感，引入现代 IDE 级别的非对称延迟与光标存在感知（Cursor Presence Detection）机制：光标移入左侧任务栏区域 180ms 意图识别防误触后自动平滑滑出展开，光标移出侧栏后提供 650ms 舒适防抖缓冲再自动平滑收缩，若中途回移侧栏立即取消收起，搜索输入时焦点常驻保护；更新测试套件与三端独立交互 Demo。
- `v0.9.9.5`：自定义壁纸全局毛玻璃通透体系、会话框透明适配与顶栏下拉菜单层叠上下文修复。针对用户自定义背景（Custom Preset）在应用真实壁纸图片与无图片状态下的视觉呈现进行深度优化。当未上传自定义图片时，会话框与画布默认采用纯净白极简底色（或深色预设底色）；一旦用户上传/应用本地图片或网络壁纸，会话框核心交互区（包括底栏悬浮 Composer 输入台、用户消息气泡、顶栏 Navigation、会话顶部标题栏、右侧 Antigravity 工作台及左侧侧边栏）全面自适应切换为半透明毛玻璃态（Glassmorphism，`backdrop-filter: blur(20px~24px) saturate(180%~190%)` 与微发光柔边框），消除突兀的不透明白色/深色块遮挡，让壁纸画面自然通透贯穿整个主视觉界面；彻底修复层叠上下文（Stacking Context）遮挡缺陷，为 `header.top`（`z-index: 100`）与 `.chat-head`（`z-index: 50`）赋予独立高层级相对定位，根治「会话选择下拉菜单被消息区代码块/引用块截断遮挡」与「服务器端点下拉菜单被右侧工作台与卡片截断遮挡」的问题，确保全站下拉菜单纯净浮于最顶层；支持深浅双模自适应，无 Emoji，全面同步测试与桌面交互 Demo。
- `v0.9.9.6`：品牌锚点常驻与顶栏/活动栏智能收展引擎、自定义背景色号统一、子代理主题色贯通。
  - **品牌锚点常驻**：新增左上角 `.brand-logo-pin` 常驻 Logo（`top:10px/left:18px/32×32/z-index:120`），对 `body.has-custom-bg` 适配毛玻璃；原 Logo 占位符转为 `visibility: hidden` 间距占位。
  - **顶栏/活动栏智能收展**：`header.top` 与 `.cb-activity-bar` 增加 `transition: margin-* / transform / opacity`，`.collapsed-row` / `.collapsed-col` 状态下平滑收起进入专注模式；边缘探测（光标 Y ≤ 38px 展开顶栏、X ≤ 42px 展开活动栏）触发展开，离开后 650ms 舒适防抖收起，下拉菜单打开或输入焦点期间禁止误收，点击 Logo 切换常驻/自动收展并持久化；双收起时自动追加安全边距避让，杜绝悬浮 Logo 与标题/展开按钮重叠。
  - **自定义背景平滑迁移**：修复上传自定义壁纸后 localStorage 遗留 `preset: "default"` 导致背景未自动激活的问题，按 `validPresets = ['mocha','shell','custom']` 平滑兼容升级至 `preset: "custom"` 并激活 `body.has-custom-bg`。
  - **自定义背景色号统一**：在 `body.has-custom-bg` 作用域内把自定义壁纸下的**基础中性灰面**色号整体并入「卡片」色号 `--gem-bg-card`（即顶栏「主题切换 / 服务器端点」按钮组的白底）：`--gem-bg-canvas`、`--gem-bg-sidebar`、`--gem-bg-card-inner`、`--gem-surface-low`、`--gem-surface-highest`，以及它们在预设主题块里写成 `var(--gem-*)` 别名的 `--mcode-bg` / `--mcode-bg-primary` / `--mcode-bg-secondary` / `--mcode-surface` / `--mcode-surface-muted` / `--mcode-surface-raised` / `--mcode-code-bg` / `--studio-*` 全族。注意这些别名在 `<html>` 上就完成了变量替换并逐层继承，因此必须在 `body` 上显式重映射，只改 `--gem-*` 不生效。实测：设置页（子代理与配额中枢）残留灰面元素从 96 个降至 0。**`--gem-surface-high`（及别名 `--mcode-surface-hover`）刻意保持原样不动** —— 这一层灰是交互态 / 配额进度条轨道 / 列表选中行底色的载体，用户明确要求「灰色的地方不变」；改成纯白会让进度条轨道与 hover 反馈在白底上消失。
  - **子代理主题色贯通**：新增 `getAgentAccent()` / `applyAgentAccent()`，把当前所选子代理主题色（`AGENT_THEMES.color`，如 CodeArts 华为红 `#ef4444`、TRAE `#34d399`、Copilot `#c084fc`）写入 `<html>` 的 `--agent-accent` / `--agent-accent-glow` 变量；**发送按钮背景**（`color-mix` 生成的深色渐变，保持白字可读）与**上下文进度条内条**两处跟随子代理色，切换即时联动；未知代理按名称哈希生成稳定色，取不到时回落主题原生色。原上下文进度条 70%/85% 的蓝-黄-红阈值配色按需求统一为子代理色。**模型名文字不参与着色**：输入框下方模型胶囊（`mimocode/MiMo-V2.6-Flash (26f) · max`）与状态栏模型名统一取「对话窗问候语」的字体色 `var(--gem-text)`（与 `.chat-empty-state .empty-slogan` 完全一致，浅色 `#4c4f69` / 深色 `#cdd6f4`），所有子代理一律相同，不再随子代理变色。
  - **对话区二级菜单强调色跟随子代理**：把 `#panel-chat`（会话列表、会话头下拉、消息区、输入台、状态栏及其全部弹出面板）作用域内的主题强调色令牌整体改指向 `--agent-accent`——`--gem-primary` / `--gem-primary-container` / `--mcode-accent` / `--mcode-accent-gradient` / `--mcode-primary-action-bg` / `--mcode-accent-glow` / `--mcode-focus-ring`。于是「模型与运行参数」弹窗（子代理徽标、选中行描边与左侧色条、勾选图标、搜索框聚焦、思考档位激活态、完成按钮）、「状态栏显示项」弹窗（全选/重置文字、勾选框）、会话头二级菜单（`⋯` 更多 / 切换子代理 / 切换对话 / 会话筛选的图标）、以及输入台聚焦描边、引用块左边线、行内代码、空状态卡片 hover 全部一次性跟随发送按钮的子代理主题色。其中承载白字的实心块（Max 档位、完成、`button.primary`）统一改用 `--mcode-accent-gradient`（深色→子代理色渐变），与发送按钮同一套色；文字/边框/图标则用「可读强调色」`color-mix(in srgb, var(--agent-accent) 72%, var(--gem-text))`，避免 Antigravity `#8ab4f8` 这类亮色在浅底上看不清。**列表行的灰色底刻意不改**（仍取 `--mcode-surface-hover`），只改左侧色条、描边与勾选图标；弹窗里写死的靛蓝 `rgba(99,102,241,*)` 与天蓝 `rgba(59,130,246,*)` 一并改为子代理色（`.mp-agent-badge` / `.sb-config-btn-text:hover` / `.btn-head-workbench.active` / `.pill.acc` / `.mp-param-flag` / `.wb-artifact-btn.primary`）。四个预设主题块补上 `--agent-accent` / `--agent-accent-glow` 默认值（与主题主色同值），保证 JS 写入前也不会出现无着色状态。
  - **品牌锚点常驻 + 顶栏/活动栏自动收展（落地实现）**：上一版只写了 CSS，DOM 锚点与收展引擎未落地，因此左上角 Logo 一直不显示、顶栏与活动栏也不会自动隐藏。本版补齐：`<body>` 开头注入 `#brand-logo-pin`（`position: fixed; top:10px; left:18px; 32×32; z-index:120`），JS 复用顶栏内那张 Logo（`cloneNode`）挂载，避免在 HTML 里重复一份 base64；顶栏原 `.brand-logo` 转为 `visibility: hidden` 的 32px 间距占位，锚点正好落位。新增 `setupChromeAutoHideEngine()`：光标 Y ≤ 38px 展开顶栏、X ≤ 42px 展开活动栏（90ms 命中延时防过路误触），离开后 650ms 舒适防抖收起；悬浮 Logo 同时展开两者；下拉菜单 / `<dialog>` 弹窗打开、或顶栏内有输入焦点时禁止收起；**Logo 锚点永不隐藏**（固定定位 + `pointer-events` 独立，顶栏 `collapsed-row` 的 `pointer-events:none` 不影响它）；点击 Logo 切换「自动收展 / 常驻」并持久化到 `localStorage.agent_hub_chrome_autohide`，常驻态加主题色描边提示；手机端（≤859px）不做自动收展。配套新增 `body.header-collapsed .cb-activity-bar { padding-top: 50px }`（含过渡），顶栏收起时活动栏首项下移，避免与 Logo 锚点重叠。
  - **侧栏展开触发范围改为「红色框」**：原 `setupSidebarHoverEngine` 在侧栏收起时只在 `actBar.right + 14px` 内才触发展开（鼠标必须贴到最左侧活动栏那一条窄带），而展开后的保持范围却是 `actBar.right + 280px`，两者不对称、手感割裂。现改为统一按「活动栏 + 侧边栏自身展开宽度」计算触发范围（新增 `getSidebarRevealWidth()` / `isPointerInRevealZone()`，宽度实时量取并缓存、收起时回退到 268px），即光标进入侧栏将要出现的那整块占位区域就展开、离开才收起；展开与收起的防抖定时器在触发前都会用 `lastPointer` 重新核对一次实际光标位置，避免 `mouseleave` 早于最后一次 `mousemove` 导致的误收起。
  - **配套**：`console/server.mjs` 新增 `/api/chat/agent-summary` 读写端点；测试套件、单文件交互 Demo（`demo/index.html`、`demo.html`、桌面 `multi-agent-hub-demo.html`）同步更新。


