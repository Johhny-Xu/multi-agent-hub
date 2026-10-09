# 任务选项与跨系统附件

`hub_ask` 与 `hub_dispatch` 使用同一份任务契约。Codex、ZCode、DSH 的插件内置桥接副本保持一致。`hub_capabilities(worker, model?, refresh?)` 返回 **Hub 所在平台、当前配置和具体型号** 的能力。查询不会登录或付费调用模型；最近明确的认证、区域、额度或型号错误会暂时反映在可用性中。

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
| `stream: true` | 仅对声明支持的通道查询运行中正文；MCP 客户端提供 `_meta.progressToken` 时发出 `notifications/progress` |
| `stream: false` | 等待并返回最终正文；MiMo 本身仍可能使用流式网络传输，由桥接缓冲 |
| `model` | 解析 Hub profile 的别名；未在本机配置声明的型号默认拒绝，不把静态 UI 列表当成账号可用模型 |
| `files` | 传输附件字节，按 worker 能力转换为文件参数、Read 路径或厂商消息文件 |

流式通知不等于宿主 UI 一定逐字显示。CodeBuddy、Copilot、MiniMax 的原生流与 MiMo 的完成文本片段有区别；后者通常在一个文本片段结束后才产生 Hub 进度。某些短任务可能在第一次轮询前完成，因此没有中间通知。协议、正文进度和宿主 UI 展示分别验证。

`stream.semantics` 区分 `answer_deltas`（CLI 回答增量）、`answer_snapshots`（回答片段/快照）、`terminal_only`（仅终态）和 `unverified`。`stream.supported` 表示能否请求 `true`；`false` 总可用于等待最终回答，不意味着厂商网络层停止流式传输。ZCode 官方 RPC 的实测任务有最终答案但 `chunks=0`，因此当前默认禁用 `stream:true`，公开语义为 `terminal_only`。

## 能力查询 v2

返回结构保留旧 worker 字段，并增加型号数组。下例省略其他型号与附件限制：

```json
{
  "schema_version": 2,
  "platform": "linux",
  "workers": {
    "codebuddy-cn": {
      "configured": true,
      "default_model": "deepseek-v4.1-flash",
      "availability": {"enabled": true, "code": "ready", "reason": "已配置；此查询不验证登录或执行推理。", "refreshable": false},
      "models": [{
        "id": "deepseek-v4.1-flash",
        "aliases": ["default", "v41f"],
        "availability": {"enabled": true, "code": "ready", "refreshable": false},
        "thinking": {"allowed": ["default", "on", "off"], "default": "default", "reasons": {}},
        "stream": {"supported": true, "semantics": "answer_deltas"},
        "attachments": {
          "file": {"supported": true, "mode": "stdin_json", "content_types": ["text/plain; charset=utf-8"], "platforms": ["linux"]},
          "image": {"supported": true, "mode": "prompt_path", "content_types": ["image/png", "image/jpeg", "image/gif", "image/webp"], "platforms": ["linux"]}
        }
      }]
    }
  }
}
```

`worker.availability` 只描述本机进程和配置条件，例如缺少 CLI、配置禁用或会改写共享认证的 wrapper；某个默认型号失败不会封禁其他型号。具体型号的 `models[].availability` 才包含最近调用结果：认证、区域、额度和型号错误暂时禁用该型号；空答、超时或未执行的工具协议只显示诊断，不据此宣称型号永久不支持。状态只保存安全错误码和时间，位于 `HUB_STATE_DIR/availability.json`，不保存厂商错误原文、密钥或 URL。默认有效期为一小时；换 CLI/模型配置后旧状态不会套用到新配置。

完成官方登录、修正本机模型配置或处理额度后，调用 `hub_capabilities(worker="...", model="...", refresh=true)` 清除该型号近期失败状态。省略型号会清除该 worker 的近期失败，省略 worker 会清除全部近期失败。**刷新只清除记录并重读本机能力，不启动登录或付费探测。** 显示为可用仍不是登录和生成成功的证明。没有匹配型号或查询失败时，客户端应禁用相应选项；后端仍执行同一套校验。

配置可以通过 `capabilities.platforms.linux/windows/darwin` 和 `capabilities.models.<实际型号>` 声明实际验证过的覆盖。覆盖使用与 catalog 相同的内部参数结构；公开接口只投影能力布尔值、模式和原因，不回传参数数组或环境变量。`effort`、`contextTier`、`autoTier` 不是本契约已验证的 CLI 控制，不能作为思考开关，后端拒绝这些字段。

`extra_args` 不能覆盖已校验的型号、代理模式、思考、流式、附件输入或工具授权参数；这些设置应使用任务选项或在本机 profile 中明确声明，避免元数据写着 off 却由尾部原始参数改回 on。

`hub_result_json` 提供 `model`（请求型号）、`thinking`、`stream`、附件名称/大小，以及可用时的 `usage`。`usage.model` 来自厂商输出；计数是已观察到的官方事件，不保证跨多轮工具调用累计。公开结果过滤推理正文和工具参数，不把它们当最终回答。HTTP Hub 的私有结果目录仍属于本机运行数据。

以下是默认模型的适配约束，实际通过/失败记录见[兼容性实测](compatibility-2026-10-08.md)：

- CodeBuddy 国内/国际版：`deepseek-v4.1-flash` 的思考开关；UTF-8 文本通过官方 stdin JSON 直接传入，图片通过官方 Read。任务显式使用 `standard` 代理，避免继承上次 PTC/REPL 工具模式而失去 Read。图片通道要求 profile 明确配置 `--tools Read --allowedTools Read --permission-mode acceptEdits`（也可保留已授权的其他工具）；未预授权时能力查询和派发均拒绝图像。不会调用会 `cp auth.info` 覆盖共享认证的 Linux wrapper。[根因与新任务证据](root-cause-2026-10-08.md)。
- MiMo：`xiaomi/mimo-v2.6-flash`，别名 `26f` / `v2.6f`；provider 思考开关、`--file` 附件。`--thinking` 只控制显示，不用于判定关思考。
- Copilot：默认 `auto` 只声明 `default` 思考行为；接受 `--reasoning-effort none` 不能证明路由到任意型号时严格关闭思考。固定型号完成验证后可按型号声明控制。`--attachment` 用于图片，普通文件通过 Read 路径。单次数学错误属于任务成果验证失败，不是禁用整个模型的依据。
- MiniMax：`MiniMax-M3.1-Flash-Preview` 总是启用思考，明确拒绝 `off`；通过 `--messages-file` 接受 UTF-8 文件与 PNG/JPEG/GIF/WebP 图片；可以看图计算，但没有本地文件编辑工具，不能声称完成写文件。
- ZCode：新模板通过官方 `app-server` 校验本机账号模型目录和会话实际型号，缺少指定模型时明确失败；不把上轮某台机器缺模型硬编码成所有用户永久禁用。旧无型号控制通道的可用性公开为 `model_selection_unverified`。当前未证明思考开关，`on/off` 拒绝；实时回答流未观察到，`stream:true` 拒绝。请求 plan 但官方实测可能返回 build，因此显式禁止 Write/Edit/Bash，仅用于读取与问答。
- 未适配的思考/附件模式返回 `UNSUPPORTED`，不会用提示词假装实现。

控制台的自动派发/直通派发使用上述附件传输。消息和任务队列没有这个执行契约，显式附件/思考/流式选项会被拒绝，避免只附上本地路径却声称已发送文件。

## 配置与运行数据

可设置 `HUB_AGENTS_FILE`、`HUB_STATE_DIR`、`HUB_RESULTS_DIR` 将机器配置和任务数据保存在仓库之外。路径建议使用绝对路径。官方 worker 登录仍留在各自官方账号目录；模板只保存入口和路径，不携带账号数据。

Codex 原生插件可能过滤普通环境变量，使用其外部 `PLUGIN_DATA/agenthub.json` 设置连接，见 [Codex 适配说明](../integrations/codex/README.md)。鉴权由 `Authorization: Bearer` 发送，桥接不会把 token 留在实际请求 URL。

任务收到 `ref` 后只查询这个 ref。`running`、`unknown`、空回答、格式不符都不是成功证据，也不能据此自动重复执行可能有副作用的任务。
