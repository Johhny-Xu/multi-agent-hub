# AgentHub for DeepSeek Harness (DSH)

本目录提供独立 MCP 桥、8 个 worker 预设与 1 个总线预设、3 个原生工作流脚本，以及直接调用 Hub 的 Node runner。Hub 服务需先启动；worker 的模型、CLI 和认证由 Hub 配置决定。

本次验证使用官方 API 文档、模拟 Hub、工作流 VM 与临时 profile。没有启动真实 DSH 宿主，也没有修改用户的 DSH 配置。

## 安装到指定 profile

使用已安装的官方 DSH CLI 安装这个子目录包。将路径与 profile 名换成实际值：

~~~powershell
dsh plugin --profile web add "file:C:/PATH/TO/agenthub/integrations/dsh"
dsh --profile web --dump-config
~~~

官方 CLI 负责安装依赖、链接包和启用 bundle；新 profile 的创建规则也由官方 CLI 决定。确认组合配置里出现 AgentHub layer 后再启动该 profile。仓库根目录网址不能代替这个子目录包。[官方 bundle/profile 安装说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)

bundle 使用 Cordis 的 insert 操作新增桥和预设。桥入口通过包内绝对路径启动 MCP server，并调用官方 MCP client 的命名导出 apply。默认单次 MCP 调用上限为 310 秒，覆盖默认 300 秒的 hub_ask；更长任务适合使用 hub_dispatch 与 hub_fetch。DSH 会过滤继承环境中的敏感变量，因此 bundle 显式传入 AGENTHUB_URL 与 HUB_TOKEN。[官方 MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)

### 可选 profile 配置助手

官方 CLI 安装完成后，可用本目录助手写入 Hub 地址等 profile 覆盖配置：

~~~powershell
python install-dsh.py --profile web --url http://127.0.0.1:8765/mcp
python install-dsh.py --profile web --check
~~~

Windows 可运行 install.bat --profile web；Linux/macOS 可运行 ./install.sh --profile web。两者会从脚本所在目录定位安装器、转发全部参数，并检查 Python 3.8+。若系统 Python 命令不可用，设置 HUB_PYTHON 为实际解释器路径。直接运行 Python 安装器时默认 profile 为 web；启动脚本要求传入参数。

助手只处理选中的既有 profile，找不到时直接失败，不切换到其他 profile。它保留用户 persona 和其他 patch，只管理 AgentHub 标记块及旧版 AgentHub 顶层条目。省略 --url / --token 时保留已有地址、token 和自定义 env；显式空字符串应写成 YAML 引号字符串，空/null 环境值会在写入前报错。更新前备份配置，写入失败时恢复原文件。

--check 只检查配置记录，不能证明宿主已加载或 worker 在线。--uninstall 删除助手管理的配置与 bundle 记录；完整移除包请同时执行：

~~~powershell
dsh plugin --profile web remove dsh-plugin-multi-agent-hub
~~~

助手不下载依赖或启动宿主，不能代替官方 CLI 的包链接步骤。

## MCP 与预设

桥暴露 hub_ask、hub_dispatch、hub_fetch、hub_status、hub_login。DSH 中的 MCP 工具名使用 mcp__agenthub__ 前缀。预设覆盖 antigravity、codebuddy、codebuddy-cn、github-copilot、minimaxcode、mimocode、traecode、zcode，以及 agenthub-all。模型与可用性以 Hub 配置和状态返回为准。

派发后保留原始 ok、status、ref：

- ok=true 且 status=completed，并有有效答案，才计入工作流成功。
- running 表示任务仍在运行；unknown 表示状态无法确认。
- 有 ref 时继续查同一任务；没有 ref 的 unknown 也不能自动重复派发。
- failed 保留错误结果，工作流停止依赖它的后续阶段。

同一个 worker 的别名在扇出前去重；桥不会因空输出或未知状态自动重做任务。

## 原生工作流

DSH 的 workflow 工具接收 meta、script 和可选 args；script 是带顶层 await、以 return JSON 结束的 JavaScript 脚本体。请将下面文件的完整内容作为 script 提交，不能只提供文件名。官方目前没有保存工作流名称注册机制。[官方工作流 API](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/workflow/README.md)

| 脚本 | args | 行为 |
| --- | --- | --- |
| workflows/hub-fanout.dsh.js | task、workers、timeout_s | 独立 worker 并发，各启动一次子代理 |
| workflows/code-audit.dsh.js | code、timeout_s | CodeBuddy 架构审查成功后启动 Antigravity 安全审查 |
| workflows/competitive-solve.dsh.js | problem、timeout_s | 两个独立解答均成功后启动一次比较 |

workers 可使用数组或逗号分隔字符串，最多 8 项；timeout_s 默认为 300，范围为大于 0 且不超过 86400 秒。模板使用官方 agent(prompt, { schema, label }) 与 parallel()，检查返回对象的状态、worker、ref 和答案类型。null、失败、未知、未完成及无效 JSON 都不会被字符串化后当成成功。

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

测试涵盖独立 MCP 副本一致性、HTTP/MCP 错误、任务超时、单次派发、原生工作流的 null/failed/unknown 结果、runner 的真实本地 mock HTTP，以及临时 profile 的配置保留。真实 DSH 加载、预设 UI 展示和宿主模型执行仍需在目标 profile 完成安装后验证。

## English

Install this directory as a DSH bundle with the official dsh plugin --profile NAME add file:PATH command, then inspect dsh --profile NAME --dump-config. The optional Python helper prepares only the selected existing profile; it preserves user patches and existing Hub env settings, backs up changes, and does not install dependencies or activate a host.

Native workflow files are JavaScript bodies submitted through the workflow tool's meta/script/args contract. Their schema checks reject null, malformed, failed and uncertain child results. Child agents remain model-driven. For program-controlled single dispatch per stage, use node workflows/runner.mjs MODE INPUT.json. Only completed nonempty results produce exit code 0; running/unknown refs are preserved without automatic redispatch.

The regression suite uses mock Hub servers, workflow VM hooks and temporary profiles. Live DSH activation has not been exercised in this validation.
