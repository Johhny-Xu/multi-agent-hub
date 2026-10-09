# Windows 实测证据：8 个 worker 的四个开关

2026-10-08 在现有登录状态下做了 78 次独立 CLI 调用，覆盖 62 个不同的四位组合。完整矩阵有 128 格；未实际调用的格子明确标为未覆盖、前置授权/区域/模型阻塞或不支持，未推断为通过。四位顺序为 `thinking / stream / image / file`。

每次使用独立临时目录和随机 nonce。图片像素包含随机两数，文本文件包含另外两数；任务必须读出数值、计算总和，在可写文件的 worker 中生成 `output.json`。最终答案只从 `parse_output` 选出的公开最终正文解析，另行验证落盘文件；用户回显、工具参数、工具结果和思考内容不能证明通过。所有已存调用已经按此判据重新计算，无需重复收费调用。

| Worker / 要求的模型 | 独立调用 / 实跑组合 | 结论 |
|---|---:|---|
| CodeBuddy 国际版 / deepseek-v4.1-flash | 1 次 / 1 格 | 0 通过、1 授权阻塞。官方 CLI 退出 0，但服务端返回 401。解析器现在报登录失败；其余 15 格继承授权阻塞。 |
| CodeBuddy 国内版 / deepseek-v4.1-flash | 21 次 / 16 格 | 修正普通非交互 Read/Write 权限后，16/16 最终计算正确，8/8 文件组合输出文件正确；早期失败仍留在逐次记录。off 的 reasoning 计数为 0；on 的真实正计数及文本事件已观察到。 |
| MiMo / xiaomi/mimo-v2.6-flash | 21 次 / 16 格 | 14 通过、2 失败；`0100`、`1000` 两次退出 0 且无任何输出。8/8 文件组合输出正确。on/off 使用模型 options 的 enabled/disabled，非 `--thinking` 显示开关。 |
| Copilot / auto | 13 次 / 10 格 | off 实跑 8 格：6 通过、2 失败，失败为图片与文本同时输入的 `0011`、`0111` 算术错误。on 实跑 2 格均拒绝 high reasoning 设置；全部 8 个 on 格标不支持，其中 6 格未调用。 |
| MiniMax / MiniMax-M3.1-Flash-Preview | 11 次 / 11 格 | on 实跑 8 格：8/8 输入计算正确；其中无文件 4 格通过，有文件 4 格的原生落盘输出不支持。额外 off 3 格计算正确但思考仍开启，不能算 off 通过；另外 5 个 off 格未调用。 |
| Trae / GLM-5.3-FlashX | 2 次 / 1 格 | 0 通过、1 格失败。正确 exec 参数到达官方 CLI 后，在 Codebase/SSO 授权依赖阶段失败；其余 15 格不重复请求。 |
| Antigravity / gemini-3.8-flash-medium | 2 次 / 1 格 | 0 通过、1 区域阻塞；另外 7 个 on 格继承区域阻塞。官方 effort 参数没有 off/none，8 个 off 格不支持且未调用。 |
| ZCode / GLM-5.3-Flash | 7 次 / 6 格 | 要求型号通过 0 格；全部 16 格 blocked_model。6 格旧入口调用中，3 格当前实际模型计算正确，3 格未验证成功。官方元数据证明当前为 wx/Deepseek-v4-flash，13 项模型表没有 GLM-5.3-Flash。 |

ZCode 在独立目录中用官方默认 headless 权限模式并禁用 Bash、网络与子代理后，普通文件读写成功；图片调用分别在 70/90/100 秒预算结束。这些是当前实际模型的证据，不能算作要求的 GLM 型号通过。`/model`、`/effort` 在此 headless 入口会成为模型提示词；模型自述不能作为型号证明。官方 `app-server` 的 session 元数据和模型表才是本次核验依据。Hub 已拒绝旧无 model 参数通道指定默认型号，模板改用 RPC 型号校验入口；该 driver 的后续验证单独记录。

MiMo 的 JSON CLI 输出是工具/完成文本事件，未发现原生 HTTP stream-off 参数。这里的 stream-off 表示 Hub 收齐后返回，stream-on 表示真实 CLI stdout 进度投影，不能解释为关闭供应商底层流。CodeBuddy 的 `stream-json --include-partial-messages` 无需 `--verbose`，已经收到真实 `text_delta`。

新版 JavaScript bridge → HTTP Hub → CLI 的附件联测把客户端输入目录与 worker 输出目录分开。CodeBuddy 国内版 4/4 成功；MiMo 修复重复 format 参数后 2/4 成功，另外两次预算结束仍 running，随后 worker 超时，保留失败。stream 成功用例有真实进度回调。MiniMax 的新版图片/文本附件 nonstream 已通过；stream 最初正文被 CLI stderr 状态动画污染，`--quiet` 也未解决。Hub 修复 stdout/stderr 分离后，用新 nonce 再测 `1111`：严格 JSON 答案正确，收到 1 次真实进度回调。MiniMax 此联测只要求读图/文件和计算，不要求文本 CLI 写文件。暂存附件已清理，报告中的 `owned_processes_cleaned` 在 finally 清理成功后才写为 true。

机器可读证据：

- [128 格矩阵及逐次调用索引](live-workers-windows-capabilities.json)：每格 `actually_run`、限制、历史失败/修正后结果和安全 usage。
- [bridge 与 Hub 联测](live-workers-hub-integration.json)、[MiniMax 修复后联测](live-workers-hub-minimax-final.json)，保留[首次联测](live-workers-hub-minimax.json)与 [quiet 联测](live-workers-hub-minimax-quiet.json)的失败证据。
- [ZCode 官方 RPC 元数据](live-workers-zcode-rpc.json)：当前型号、精确 model ref、read/events/subscribe/close 参数；不含账号或凭据。

官方能力说明与本机官方已发布源码是参数依据：[CodeBuddy CLI](https://www.codebuddy.ai/docs/cli/cli-reference)、[CodeBuddy 环境变量](https://www.codebuddy.ai/docs/cli/env-vars)、[Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)、[MiMo 深度思考](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/other/deep-thinking)、[MiMo v2.6 Flash](https://mimo.mi.com/models/zh-CN/mimo-v2.6-flash)、[MiniMax Messages API](https://platform.minimax.io/docs/api-reference/text-anthropic-api)、[Antigravity 无头模式](https://antigravity.google/docs/cli/headless/)。实际通过、失败和未覆盖结论来自上述调用证据。

离线验证不会调用模型：

```powershell
python tests/worker_output_regressions.py
python tests/live_workers_probe_regressions.py
node --check tests/live_workers_hub.mjs
```

仅明确需要重新实测时运行下面的 opt-in 入口，现有账号身份和配置目录不变：

```powershell
python tests/live_workers_windows.py --workers codebuddy-cn,mimocode --cases 0000,1111 --timeout 90
python tests/live_workers_hub.py --workers minimaxcode --cases 1011,1111 --output docs/live-workers-hub-minimax-new.json
python tests/live_workers_zcode_rpc.py
python tests/live_workers_report.py
```

CLI 入口先读取 `HUB_PROBE_NODE`、`HUB_PROBE_CODEBUDDY`、`HUB_PROBE_COPILOT`、`HUB_PROBE_MIMO`、`HUB_PROBE_MINIMAX`、`HUB_PROBE_TRAE`、`HUB_PROBE_ZCODE`、`HUB_PROBE_ANTIGRAVITY`，再查稳定安装位置/PATH；本机保留的官方临时包仅是最后 fallback。不会自动安装、改认证或更换账户。图片 fixture 需要 Pillow。原始日志留在各报告列出的项目外临时目录；提交的报告只含最终答案、统计和脱敏诊断。
