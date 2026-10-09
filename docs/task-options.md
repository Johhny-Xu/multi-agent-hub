# 任务选项与跨系统附件

`hub_ask` 与 `hub_dispatch` 使用同一份任务契约。Codex、ZCode、DSH 的插件内置桥接副本保持一致。`hub_capabilities(worker)` 返回当前 Hub 配置允许的选项；它不检查账号登录、余额、区域限制或模型回答质量。

```json
{
  "worker": "mimo",
  "task": "读取附件中的数值，计算总和并给出结果。",
  "model": "26f",
  "thinking": "off",
  "stream": true,
  "files": ["C:/example/input.txt", "C:/example/chart.png"],
  "timeout_s": 180
}
```

`files` 是 **MCP 桥接进程所在机器** 上的文件路径。Windows 原生插件控制 Linux Hub 时，桥接读取文件字节，经鉴权的 HTTP 请求上传；Hub 创建仅供该任务使用的 Linux 临时文件，执行结束后清理。不会把 Windows 盘符路径交给 Linux CLI。每次最多 8 个附件，合计 1 MiB；附件内容只存运行目录，不应写入源码仓库。

`cwd` 是 **worker 所在机器** 的目录，与 `files` 所在机器可能不同。不要向 Linux worker 传 Windows `cwd`。worker 仍须具备官方工具权限，例如 CodeBuddy 非交互任务需要明确允许 Read 才能读取附件；有可写输出要求时还需 Write。插件不自动提升这些权限。

| 选项 | 行为 |
| --- | --- |
| `thinking: "default"` | 使用厂商默认设置，不代表思考关闭 |
| `thinking: "on" / "off"` | 使用已适配的官方参数或 provider 配置；不支持时在派发前拒绝 |
| `stream: true` | 查询运行中的正文快照；MCP 客户端提供 `_meta.progressToken` 时发出 `notifications/progress` |
| `stream: false` | 等待并返回最终正文；MiMo 本身仍可能使用流式网络传输，由桥接缓冲 |
| `model` | 解析 Hub profile 的别名；不能切换模型的通道会拒绝非默认型号 |
| `files` | 传输附件字节，按 worker 能力转换为文件参数、Read 路径或厂商消息文件 |

流式通知不等于宿主 UI 一定逐字显示。CodeBuddy、Copilot、MiniMax 的原生流与 MiMo 的完成文本片段有区别；后者通常在一个文本片段结束后才产生 Hub 进度。某些短任务可能在第一次轮询前完成，因此没有中间通知。协议、正文进度和宿主 UI 展示分别验证。

`hub_result_json` 提供 `model`（请求型号）、`thinking`、`stream`、附件名称/大小，以及可用时的 `usage`。`usage.model` 来自厂商输出；计数是已观察到的官方事件，不保证跨多轮工具调用累计。公开结果过滤推理正文和工具参数，不把它们当最终回答。HTTP Hub 的私有结果目录仍属于本机运行数据。

以下是默认模型的适配约束，实际通过/失败记录见[兼容性实测](compatibility-2026-10-08.md)：

- CodeBuddy 国内/国际版：`deepseek-v4.1-flash` 的思考开关；文件和图片通过官方 Read 工具。
- MiMo：`xiaomi/mimo-v2.6-flash`，别名 `26f` / `v2.6f`；provider 思考开关、`--file` 附件。`--thinking` 只控制显示，不用于判定关思考。
- Copilot：默认 `auto` 拒绝显式高思考设置；当前只声明 `off`。`--attachment` 用于图片，普通文件通过 Read 路径。
- MiniMax：`MiniMax-M3.1-Flash-Preview` 总是启用思考，明确拒绝 `off`；通过 `--messages-file` 接受 UTF-8 文件与 PNG/JPEG/GIF/WebP 图片；可以看图计算，但没有本地文件编辑工具，不能声称完成写文件。
- ZCode：新模板通过官方 `app-server` 校验模型目录和会话实际型号，缺少指定模型时派发前拒绝；不改全局默认模型。当前未证明思考开关，`on/off` 拒绝。请求 plan 但官方实测可能返回 build，因此显式禁止 Write/Edit/Bash，仅用于读取与问答；流式正文严格排除推理与工具内容。
- 未适配的思考/附件模式返回 `UNSUPPORTED`，不会用提示词假装实现。

控制台的自动派发/直通派发使用上述附件传输。消息和任务队列没有这个执行契约，显式附件/思考/流式选项会被拒绝，避免只附上本地路径却声称已发送文件。

## 配置与运行数据

可设置 `HUB_AGENTS_FILE`、`HUB_STATE_DIR`、`HUB_RESULTS_DIR` 将机器配置和任务数据保存在仓库之外。路径建议使用绝对路径。官方 worker 登录仍留在各自官方账号目录；模板只保存入口和路径，不携带账号数据。

Codex 原生插件可能过滤普通环境变量，使用其外部 `PLUGIN_DATA/agenthub.json` 设置连接，见 [Codex 适配说明](../integrations/codex/README.md)。鉴权由 `Authorization: Bearer` 发送，桥接不会把 token 留在实际请求 URL。

任务收到 `ref` 后只查询这个 ref。`running`、`unknown`、空回答、格式不符都不是成功证据，也不能据此自动重复执行可能有副作用的任务。
