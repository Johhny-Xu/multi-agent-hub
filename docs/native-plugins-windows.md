# Windows 原生插件验证（2026-10-08）

本报告区分真实宿主、真实原生代理、真实外部 worker 与隔离回归。原始日志、公开测试附件与临时配置保留在项目外 native-lab；仓库中的 [JSON 记录](native-plugins-windows.json) 仅包含脱敏命令、环境变量名称、结果与边界，不包含登录凭据、Hub token 或个人 IP。

| 宿主 | 版本 | 原生加载/发现 | 真实派发结果 |
| --- | --- | --- | --- |
| Codex | 0.162.0-alpha.2 | 本地 marketplace 安装成功，plugin MCP 启动；项目原生代理模板实际被调用 | agenthub_codebuddy_cn → Windows Hub → 官方 CN 算术成功；thinking=off 的文本+图片读取成功 |
| ZCode | 0.16.9 | validate 无诊断，list 发现插件/技能/命令；Agent 实际加载 mimocode 类型 | 原生 Agent → 插件 MCP → Windows Hub → 官方 MiMo 算术及文本+图片读取成功 |
| DeepSeek Harness | 0.2.0-rc.2 | 真实 profile 安装 bundle；实际 registry 发现 9 个预设、6 个插件 MCP 工具和 workflow 工具 | 官方主模型成功返回标记；原生子代理/工作流生成受 402 ACCOUNT_QUOTA 阻塞，未计通过 |

本报告未运行三个宿主的 GUI。Linux 本机原生 ZCode 的追加验证及 Codex/DSH 缺失情况见[平台报告](platform-compatibility.md)。本机原生测试不代表所有宿主 × 八个 worker × 全部选项组合都已实测。DSH 的离线 VM 回归不能替代原生模型执行。

## Windows → Windows 真实结果

Codex 的原生 `agenthub_codebuddy_cn` 在 read-only 宿主中实际调用插件 hub_dispatch/hub_fetch。thinking=on、stream=true 算术任务返回 `HUB_NATIVE_CONFIG_OK 301`，ref `codebuddy-cn-6270af7e60`。thinking=off 的两个附件经桥传送到 Hub 暂存，读出的 nonce、文本和图片算术分别为 `NATIVE_CX_82164`、43、67，ref `codebuddy-cn-1c78554d67`。CN worker 加了前置解释，未遵守“只输出一行”的格式，但附件内容验证正确；保留此限制，不重做已完成任务。

ZCode 原生 Agent 的 `agenthub-workers:mimocode` 通过插件 hub_ask 返回 `HUB_NATIVE_DISPATCH_OK 377`，ref `mimocode-dd045eb9ce`。文本+PNG、thinking=off、stream=true 的任务返回精确 `HUB_NATIVE_ATTACH_OK nonce=NATIVE_ZC_74628 text=26 image=51`，ref `mimocode-576acdfbbc`。实际 worker usage.reasoning_tokens 为 0。

附件输入位于客户端的独立目录，与 worker cwd 不同。文本有独立 nonce，PNG 中可见另一组算术，宿主父代理禁止读取输入或自行计算，真实 Hub 结果保存附件种类/字节数和模型选项。CN 附件任务的 worker 工具全集限定 Read，同时使用官方非交互权限模式；不开放 Bash/Write/Edit。

ZCode 返回 `delivery=buffered_no_progress_token`。客户端没有 progressToken，故只证明请求了流式生成、最终答案正确，并未证明 UI 实时流式展示。Codex dispatch/fetch 返回未携带该字段，也不作展示结论。

## Windows → Linux 原生传送

两个原生宿主已分别派发独立 txt+PNG/off/stream=true 任务到 Linux Hub，原始 ref 为 `codebuddy-cn-0c4aa60589`、`codebuddy-cn-52ac8218d9`。初轮 Linux worker 退出而未产生可验证答案，均记录 failed，未自动重派。

Linux 私有测试 profile 的 variadic `--allowedTools Read` 吞掉了 Hub 后追加的裸 prompt，造成零 token 空结果。诊断属于测试配置；接收任务的 plumbing 已证明，初轮附件阅读未证明。只有修复 profile 为显式 `{task}` 后的新 nonce 新任务才能计入完整跨系统通过。

修复配置后两个新 nonce 任务的原 ref `codebuddy-cn-9a816b0a36`、`codebuddy-cn-c7578806b1` 已续查到 completed，未重派。Linux CodeBuddy 2.161 最终只输出规划文字与原始 DSML Bash 调用，未返回 nonce 或算术结果。附件 names/bytes 在远端正确落地，但完整附件阅读仍未验证，不能将 CLI 退出 0 或 Hub completed 当作通过。对齐官方 2.162 后 Linux 代理的独立诊断仍未解决文件工具行为，因此停止追加 native 宿主复验。

## 原生入口与配置事实

Codex 可执行入口为 `%LOCALAPPDATA%/OpenAI/Codex/bin/9691020b546a15b2/codex.exe`。测试使用隔离 CODEX_HOME、本地 marketplace 与临时项目 `.codex/agents`，现有官方登录仅通过项目外文件符号链接引用，未读取或复制认证内容。测试的插件安装路径为 `<native-lab>/codex-home/plugins/cache/agenthub-native-probe/agenthub-workers/0.6.0`。

Codex 原生插件会过滤继承环境。AGENTHUB_URL 未到达插件子进程；mcp.json 的 `${env.AGENTHUB_URL}` 也不会展开。这导致早期派发指向默认端口并返回 unknown。修复后的启动器读取宿主提供的 `PLUGIN_DATA/agenthub.json`，真实任务随后完成。项目直接 MCP fragment 的 env_vars 路线仍有效。`--ephemeral` 在此 alpha 版本的原生子代理触发 rollout 缺失，真实验证使用隔离持久会话。测试只在临时插件配置中批准该 MCP 工具，没有更改个人配置或代理模板的模型/权限。

ZCode 入口为 `node C:/Program Files/ZCode/resources/glm/zcode.cjs`。测试项目的 zcode.json 指向仓库真实插件目录，ZCODE_STORAGE_DIR 隔离缓存与会话；CLI 引用现有桌面生成的 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 路径，未读取内容。完全隔离 HOME 的 profile 没有官方账号关联，模型创建失败。headless build 模式缺少 MCP permission client；原生任务使用显式 yolo，并禁用 Bash/Read/Write/Edit/Glob/Grep 本地工具，仍能调用原生 Agent 与所需插件工具。

DSH CLI 由桌面 Electron 可执行文件的 Node 模式运行 `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`，等同安装自带的 runtime/cli/bin/dsh.cmd；ELECTRON_RUN_AS_NODE=1、DSH_HOME 使用隔离目录。官方 CLI 在该 profile 安装真实 integrations/dsh 包。本包 MCP 使用官方 dsh-mcp-client，实际工具注册并非 mock。

DSH 默认 headless 缺少 agentPresets，单装 bundle 会使 9 个预设等待服务。测试的外部 overlay 加入官方 agent-preset-registry 后，原生 registry.list() 返回全部 9 个 AgentHub 预设，tools.schemas() 返回六个 mcp__agenthub__ 工具及 workflow。发现 observer 仅观察真实注册服务，没有替换工具或模型；CLI 没有任务时退出，不计生成成功。web/desktop 默认 profile 已含该注册服务，不能重复添加。

DSH 官方账户使用 deepseek-account 路由，deepseek-official 是 API Key 路由。隔离 profile 引用了原账户凭据路径而没有读/复制内容，主模型 `deepseek-flash` 成功返回 `HUB_NATIVE_HOST_OK`。后续原生派发请求在任何 Hub 工具调用前返回 402 ACCOUNT_QUOTA Insufficient Balance，故不重试，不推断预设不可用。原生 workflow 工具可发现，但三份脚本尚未经真实宿主模型执行；它们是 meta/script/args 配方，不自动注册命名全局工作流。

## 修复与回归

- Codex 增加外部 PLUGIN_DATA 设置读取，安装器包含新启动模块；不将 endpoint/token 嵌入插件源码。
- 三宿主路由说明统一六工具及 model/thinking/stream/files/cwd；ZCode 移除固定个人服务器路径和额外 SSH/MCP 依赖。
- DSH 三份 VM 脚本与 deterministic runner 校验、传递任务选项，异常选项在任何子代理/派发前拒绝。
- `node --test tests/native_plugins_config.mjs tests/native_plugins_contract.mjs tests/dsh_workflows.test.mjs`：11/11 通过。
- `python tests/codex_adapter_smoke.py`：10 通过、2 个可选 native CLI 测试未启用；已有真实宿主证据另外记录。
- ZCode 官方 `plugins validate`：ok=true、diagnostics=[]。

本轮 Windows 临时 Hub 已按自身 PID 和创建时间验证后停止。原账号配置、原插件与用户会话未修改；已有认证文件没有读取或复制。跨系统临时 Hub/转发由负责 Linux 的代理管理，最终状态另记。

官方依据：[Codex 插件](https://developers.openai.com/plugins/build/plugins)、[Codex 原生代理](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)、[ZCode 插件](https://zcode.z.ai/en/docs/plugin)、[ZCode CLI](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/README.md)、[DSH bundle/profile](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)、[DSH workflow](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/workflow/README.md)。
