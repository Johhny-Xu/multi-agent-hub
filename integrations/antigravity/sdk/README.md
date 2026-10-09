# Antigravity Python SDK 控制器（可选）

使用真实 `google-antigravity==0.1.21` 的 `Agent`、`LocalAgentConfig`、九个
`SubagentConfig` 和 `McpStdioServer`，让 SDK 子代理把任务交给现有 Hub worker。
这不是新增第十个 worker。IDE 原生插件、slash 工作流不要求安装 Python SDK。

## 安装和认证

在项目外创建独立 Python 3.10+ 虚拟环境，再安装本目录 `requirements.txt`。
例如：

```powershell
python -m venv "$env:LOCALAPPDATA\AgentHub-SDK"
& "$env:LOCALAPPDATA\AgentHub-SDK\Scripts\python.exe" -m pip install -r integrations/antigravity/sdk/requirements.txt
```

Linux 使用 `python3 -m venv ~/.local/share/AgentHub-SDK`，随后调用该环境的
`bin/python -m pip install -r integrations/antigravity/sdk/requirements.txt`。
还需要可用的 Node.js 和**项目外的 Hub client.json 绝对路径**。

SDK 默认通过 `GEMINI_API_KEY` 使用 Gemini API；Antigravity IDE 的账号登录
不会自动成为 SDK API 认证。缺少密钥时 `run` 返回 `blocked_auth`，不调用模型。
在 [Google AI Studio](https://aistudio.google.com/app/api-keys) 创建密钥，并通过
本机私有环境配置提供。不要把密钥、实际 client.json 或 SDK 配置转储提交到仓库。

SDK 模型默认留空，继承官方 SDK 默认模型；每个 Hub worker 继续采用服务端配置
的默认模型。仅当明确指定时才传 `--model`，该参数影响 SDK 调度模型，不改变
worker 模型；SDK 不自动替换失败型号。

## 离线验证和执行

以下 `python` 指虚拟环境里的解释器；Windows 可替换成其完整绝对路径。

```text
python integrations/antigravity/sdk/agenthub_antigravity.py doctor --client /absolute/private/client.json
python integrations/antigravity/sdk/agenthub_antigravity.py validate --client /absolute/private/client.json --workers mimocode codearts
python integrations/antigravity/sdk/agenthub_antigravity.py run --client /absolute/private/client.json --workers mimocode zcode --task "计算 17+25，只返回结果" --mode parallel
```

`doctor` 检查依赖、文件存在及环境认证是否设置，**不读取连接文件内容、连接 Hub
或调用模型**；key 存在不代表认证通过。`validate` 构建实际 SDK 类型并校验配置，
也不调用模型。`run` 才启动 SDK 调度与远程任务。

`--mode parallel` 由 Python 并发调度各 worker 的独立 SDK 会话，默认最大并发 3；
`--mode sequential` 按指定顺序运行相同的原始任务。顺序模式不会把前一步输出当
成下一步输入。每个会话启用 SDK 原生 `start_subagent`，只能委派给本次指定的
worker 叶子子代理；叶子不允许再派生子代理。所有节点均不开放本机 shell、文件
修改或网络搜索工具。

**版本边界：**实际验证的 PyPI 0.1.21 wheel 不提供 `BuiltinTools.RUN_WORKFLOW`、
`Agent.beta.run_workflow` 或 `beta.workflows`。本实现采用 Python 编排 SDK 原生
子代理，不声称使用上述不存在的 API。官方 GitHub 同版本 tag 的示例与发布 wheel
存在差异，运行能力以安装包检查结果为准。IDE 原生 slash 工作流是插件的另一层。

## 派发、权限与结果

- MCP 连接固定使用 `AGENTHUB_CONNECTION_MODE=file` 和绝对 `AGENTHUB_CONFIG`，
  凭据由既有桥接器读取。继承存在的 `AGENTHUB_WORKER_ID` 防止 worker 递归派发自身；
  普通宿主不凭空设置该标记。
- 桥接器仍有七个标准工具。SDK 白名单开放 `hub_dispatch`、`hub_fetch`、`hub_status`、
  `hub_capabilities`、`hub_discover`；先派发取得 ref，再查询结果，减少 SDK 等待
  超时前拿不到 ref 的情况。不开放另一提交入口 `hub_ask` 和登录写操作 `hub_login`，
  不允许工作流清除认证失败缓存。
- 一次运行中，每个计划 worker 只能提交一次，任务文本必须与固定计划一致。
  预提交即保留派发名额；错误、超时或响应丢失都不会重新提交。已有 ref 可继续查询。
  这是本次 SDK 运行内的保护，不是跨进程或跨运行的分布式幂等保证。
- 返回的 `results` 只使用 post-tool hook 观察到的 Hub 回执。SDK 模型说“成功”
  不会被视为 worker 成功；缺少回执标记 `not_dispatched` 或 `unknown`。
- 默认每会话最多 12 次模型调用、20 次工具调用；总 token 上限 120000，按所选
  worker 数量均分到会话。可通过预算参数降低上限。总体超时默认 300 秒。
- 超时/取消时调用 SDK `ChatResponse.cancel()`，停止当前 SDK 推理与子代理；
  已经交给远程 Hub 的任务可能继续执行。保留结果中的 ref，禁止通过重启 SDK
  来重试同一个未知任务。
- 默认仅支持文本任务、worker 默认思考设置和缓冲结果。不会输出模型内部思考、
  SDK 原始配置、异常详情或密钥。

代码入口为 `build_config()`、`run_workflow()`；接口集成方也可调用它们。
回归测试 `tests/antigravity_sdk.test.py` 在不安装可选 SDK 时仍运行派发保护测试；
安装 SDK 后额外验证真实类型、权限、并发、取消及结果真实性。编排测试模拟
模型响应，因此不代表已完成真实 Gemini API 推理验收。
