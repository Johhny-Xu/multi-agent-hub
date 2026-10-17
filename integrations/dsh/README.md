# multi-agent-hub for DeepSeek Harness (DSH)

本目录提供独立 MCP 桥、11 个 worker 预设与 1 个总线预设、3 个原生工作流脚本，以及直接调用 Hub 的 Node runner。Hub 服务需先启动；worker 的模型、CLI 和认证由 Hub 配置决定。

DSH 包版本为 1.4.0，随 multi-agent-hub 0.9.9 的独立 plugins 安装包分发。客户端与 Hub 可在不同机器；客户端不启动本地 Hub。连接设置统一保存在外部 `client.json`：Windows `%LOCALAPPDATA%/AgentHub/client.json`，Linux `~/.config/agenthub/client.json`（支持 XDG_CONFIG_HOME）。字段为 `url` 和可选 `token`；自定义路径使用 `AGENTHUB_CONFIG`。见[独立安装包](../../packaging/README.md)。

首次连接或 Hub 连接失败时，调用 `mcp__agenthub__hub_discover {}` 只读扫描。扫描通过 UDP 18766 查找候选，并用无凭据 `/health` 确认；不发送 token、不写配置、不静默切换。展示候选地址供用户选择，再用安装目录的 `connect.cmd` 或 `./connect.sh` 完成配对；跨网段或防火墙阻止扫描时，在向导中手动填写地址。保存后重启该 profile 或 MCP 连接。连接文件损坏不会阻止发现，但派发会返回 `SETUP_REQUIRED`，固定文件模式也不会回退到旧环境连接。

回归使用模拟 Hub、工作流 VM 与临时 profile。另在 Windows `0.2.0-rc.2` 的真实 DSH 宿主中安装本包、读取原生注册服务，并复用官方登录运行主模型；未修改用户的个人 DSH 配置。子代理/工作流实际模型派发受官方账户 `402 ACCOUNT_QUOTA` 余额不足阻塞，不能据此认定插件不可用或标记端到端通过，详见 [原生验证报告](../../docs/native-plugins-windows.md)。

## 安装到指定 profile

使用已安装的官方 DSH CLI 安装这个子目录包。将路径与 profile 名换成实际值：

~~~powershell
dsh plugin --profile web add "file:C:/PATH/TO/agenthub/integrations/dsh"
dsh --profile web --dump-config
~~~

官方 CLI 负责安装依赖、链接包和启用 bundle；新 profile 的创建规则也由官方 CLI 决定。确认组合配置里出现 multi-agent-hub layer 后再启动该 profile。仓库根目录网址不能代替这个子目录包。[官方 bundle/profile 安装说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)

bundle 使用 Cordis 的 insert 操作新增桥和预设。桥入口通过包内绝对路径启动 MCP server，并调用官方 MCP client 的命名导出 apply。默认单次 MCP 调用上限为 310 秒，覆盖默认 300 秒的 hub_ask；更长任务适合使用 hub_dispatch 与 hub_fetch。DSH 会过滤部分继承环境，安装器因此显式传递外部连接文件路径；旧版显式 AGENTHUB_URL / HUB_TOKEN 仍可用，没有显式值时不再注入 localhost 或空 token 去覆盖连接文件。[官方 MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)

`web`/`desktop` 默认 profile 已提供原生预设注册服务。实测 `headless` 默认 profile 没有 `agentPresets`，仅安装本包会使 10 个预设等待该服务；需要在所选 profile 的外部覆盖 patch 中加入 `@deepseek-ai/dsh-agent-preset-registry`，config.default 可设为 `agenthub-all`，不要在已有注册服务的 profile 重复添加。官方账户模型路由与 API Key 路由也不同，保留所选 profile 的原有登录与模型设置。

### 可选 profile 配置助手

官方 CLI 安装完成后，可用本目录助手写入 Hub 地址等 profile 覆盖配置：

~~~powershell
python install-dsh.py --profile web --url http://127.0.0.1:8765/mcp
python install-dsh.py --profile web --check
~~~

Windows 可运行 install.bat --profile web；Linux/macOS 可运行 ./install.sh --profile web。两者会从脚本所在目录定位安装器、转发全部参数，并检查 Python 3.8+。若系统 Python 命令不可用，设置 HUB_PYTHON 为实际解释器路径。直接运行 Python 安装器时默认 profile 为 web；启动脚本要求传入参数。

助手只处理选中的既有 profile，找不到时直接失败，不切换到其他 profile。它保留用户 persona 和其他 patch，只管理 multi-agent-hub 标记块及旧版 multi-agent-hub 顶层条目。省略 --url / --token 时保留已有地址、token 和自定义 env；显式空字符串应写成 YAML 引号字符串，空/null 环境值会在写入前报错。更新前备份配置，写入失败时恢复原文件。

--check 只检查配置记录，不能证明宿主已加载或 worker 在线。--uninstall 删除助手管理的配置与 bundle 记录；完整移除包请同时执行：

~~~powershell
dsh plugin --profile web remove dsh-plugin-multi-agent-hub
~~~

助手不下载依赖或启动宿主，不能代替官方 CLI 的包链接步骤。

## MCP 与预设

桥暴露 hub_ask、hub_dispatch、hub_fetch、hub_status、hub_capabilities、hub_login、hub_discover。DSH 中的 MCP 工具名使用 mcp__agenthub__ 前缀。预设覆盖 antigravity、codebuddy、codebuddy-cn、github-copilot、minimaxcode、mimocode、traecode、zcode、codearts，以及 agenthub-all。模型与可用性以 Hub 配置和能力返回为准。CodeArts 默认继承官方配置，认证及思考、流式、附件能力以 Hub 检查为准。

派发后保留原始 ok、status、ref：

- ok=true 且 status=completed，并有有效答案，才计入工作流成功。
- running 表示任务仍在运行；unknown 表示状态无法确认。
- 有 ref 时继续查同一任务；没有 ref 的 unknown 也不能自动重复派发。
- failed 保留错误结果，工作流停止依赖它的后续阶段。

同一个 worker 的别名在扇出前去重；桥不会因空输出或未知状态自动重做任务。

桥提供 `hub_ask`、`hub_dispatch`、`hub_fetch`、`hub_status`、`hub_capabilities`、`hub_login`、`hub_discover` 七个工具。派发和三份工作流脚本/Node runner 都接受 `model`、`thinking`（default/on/off）、`stream`（布尔值）、`files`（DSH 插件机器绝对路径数组）与 `cwd`（Hub 主机目录）。最多 8 个附件、合计 1 MiB，由桥编码内容并在 Hub 暂存，支持跨系统传送。先用 `hub_capabilities` 确认可用能力，未支持的选项在派发前拒绝。模型对提示中的选项与派发次数仍可能不遵守；runner 直接传递选项并确保单次派发。

`stream=true` 请求流式生成；客户端有 MCP progressToken 才能获得进度通知，无 token 时 `delivery=buffered_no_progress_token`。本次未验证 DSH UI 的实时流式展示。

## 原生工作流

运行工作流或 runner 前先完成目标 Hub 的选择与配对。发现工具只列候选，不会替工作流改连接；已有 ref 只能在原 Hub 续查。

DSH 的 workflow 工具接收 meta、script 和可选 args；script 是带顶层 await、以 return JSON 结束的 JavaScript 脚本体。请将下面文件的完整内容作为 script 提交，不能只提供文件名。官方目前没有保存工作流名称注册机制。[官方工作流 API](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/workflow/README.md)

| 脚本 | args | 行为 |
| --- | --- | --- |
| workflows/hub-fanout.dsh.js | task、workers、timeout_s | 独立 worker 并发，各启动一次子代理 |
| workflows/code-audit.dsh.js | code、timeout_s | CodeBuddy 架构审查成功后启动 Antigravity 安全审查 |
| workflows/competitive-solve.dsh.js | problem、timeout_s | 两个独立解答均成功后启动一次比较 |

workers 可使用数组或逗号分隔字符串，最多 11 项；timeout_s 默认为 300，范围为大于 0 且不超过 86400 秒。模板使用官方 agent(prompt, { schema, label }) 与 parallel()，检查返回对象的状态、worker、ref 和答案类型。null、失败、未知、未完成及无效 JSON 都不会被字符串化后当成成功。

原生子代理由模型执行工具调用，模板通过提示要求只调用一次，并校验结果；它不能保证模型必然遵守工具调用次数。官方普通子代理失败会返回 null，基础设施或脚本错误可能使整次 workflow 失败。[官方引擎实现](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/workflow-ptc/src/runtime.ts)

## 确定性 Node runner

需要由程序确保每个阶段仅调用一次 Hub 时，直接运行包内 runner。它使用相同桥接代码，无中间编排模型，不依赖工作流 VM 的文件或命令执行 API。

例如 input.json：

~~~json
{"task":"审查一个给定设计","workers":["cb","cbcn"],"timeout_s":60}
~~~

~~~powershell
node workflows/runner.mjs hub-fanout input.json
node workflows/runner.mjs code-audit audit-input.json
node workflows/runner.mjs competitive-solve problem-input.json
~~~

第二个参数也可为 -，从标准输入读取 JSON。输出为 JSON；只有全部必要阶段成功时退出码为 0，其他情况为 1。code-audit 使用 code 字段，competitive-solve 使用 problem 字段。失败或不确定结果会保留原 ref，runner 不自动重派。

## 离线验证

在仓库根目录运行：

~~~text
node --test tests/mcp_bridge.test.mjs plugins/agenthub-workers/scripts/test-login.mjs tests/dsh_workflows.test.mjs
python tests/dsh_installer_smoke.py
~~~

测试涵盖独立 MCP 副本一致性、HTTP/MCP 错误、任务超时、单次派发、原生工作流的 null/failed/unknown 结果、runner 的真实本地 mock HTTP，以及临时 profile 的配置保留。此前 Windows 原生插件加载、当时的 9 个注册预设和官方主模型已另外实测；该轮预设 UI 展示和额度恢复后的子代理/工作流实际任务未验收。0.9.9 的 Linux 原生实测与新增 CodeArts 预设范围见 [本轮交付记录](../../docs/release-0.9.9.md)。

## English

Install this directory as a DSH bundle with the official dsh plugin --profile NAME add file:PATH command, then inspect dsh --profile NAME --dump-config. The optional Python helper prepares only the selected existing profile; it preserves user patches and existing Hub env settings, backs up changes, and does not install dependencies or activate a host.

Native workflow files are JavaScript bodies submitted through the workflow tool's meta/script/args contract. Their schema checks reject null, malformed, failed and uncertain child results. Child agents remain model-driven. For program-controlled single dispatch per stage, use node workflows/runner.mjs MODE INPUT.json. Only completed nonempty results produce exit code 0; running/unknown refs are preserved without automatic redispatch.

The regression suite uses mock Hub servers, workflow VM hooks and temporary profiles. A separate Windows native-host probe loaded all nine presets and called the official host model. Native delegated generation is blocked by an official 402 quota response; it is not reported as an end-to-end pass. See the native verification report.
