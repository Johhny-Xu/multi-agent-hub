# Linux 与 Windows 控制 Linux 实测

稳定机器入口为 [platform-matrix-final.json](platform-matrix-final.json)。它按测试拓扑汇总最新有效证据，不把失败、未知状态或不支持的选项算成生成成功。完整网格为每个 worker 的 thinking on/off × stream on/off × 图像有/无 × UTF-8 文件有/无，共 16 格；纯 Linux 和 Windows→Linux 各 128 格。此处不包含另行执行的 Windows 本机矩阵。

实测服务器是已有 SSH alias 对应的 Ubuntu 24.04.4 x86_64，Python 3.12.3、Node 22.23.1。源码、运行状态与测试账户配置都放在新建的 `/tmp/agenthub-platform-*` 目录。Windows 客户端通过自己的 SSH 本机转发连接私有 Linux Hub；附件在 Windows 本机读取、编码上传，并在 Linux 私有 staging 内使用。没有把 Windows 登录文件迁到 Linux，也没有修改旧 `~/agent-hub` 配置。

初轮测试配置把 CodeBuddy 可变长度的 `--allowedTools` 放在提示词之前，导致提示词被吞为工具名。初轮失败报告原样保留，不能用来归因模型能力。修正配置后每格使用新随机码；随后 MiniMax 新增图像输入的四格在两个拓扑分别重测，最终入口只覆盖对应四格，保留之前“不支持”的历史证据。

| 结果 | 纯 Linux | Windows→Linux |
| --- | ---: | ---: |
| 答案与附件内容已验证 | 20 | 20 |
| completed 但任务成果未验证 | 12 | 12 |
| 执行失败 | 2 | 2 |
| 认证拒绝后未继续执行 | 30 | 30 |
| 明确不支持、启动前拒绝 | 64 | 64 |
| 网格总数 | 128 | 128 |

每个拓扑向 MCP 提交 98 格，得到 34 个实际 Hub 执行 ref。只在原 ref 上查询，不因空输出、running 或 unknown 自动重派。流式统计记录真实 MCP `notifications/progress` 数量；stream=false 的任务没有这些通知。Linux 的非流式 JSON 计数提供了部分实际推理证据：纯 Linux CodeBuddy 国际版和 Windows→Linux 国内版各 8 格有 reasoning_tokens（off 为 0、on 为正数）；MiniMax 两个拓扑各 4 格有正数。流式文本模式及 Copilot 缺少这些计数，不能把它们的请求参数或能力声明当成实际推理开关计数证据。

CodeBuddy 国内/国际旧 Linux 入口是用户已有 shell wrapper，它们会把各自 profile 的 auth 文件复制到同一个原生扩展账户位置，使用同一凭据锁，并在锁超时后继续。两账号的并发隔离没有得到验证，认证结果也随拓扑发生差异。私有安装官方 `@tencent-ai/codebuddy-code@2.162.0`、直接启动并复用原 Linux 登录文件后，无附件任务可生成答案；文本/图像任务仍声称缺少 Read 工具或输出未执行的 DSML 调用，故停止追加试探，没有把 completed 当成附件任务通过。未读取或复制凭据内容，也未猜测原账户来恢复共享账户文件。

MiMo 官方 `xiaomi/mimo-v2.6-flash` 在 Linux 返回 Invalid API Key。旧 `9router/trae` 路由的生成成功保留为旧路由证据，不能算原生 MiMo26。Antigravity 官方 `agy.bin` 正确命令达到 60 秒超时；其 thinking on/off 组合未声明支持。旧 Linux Trae profile 默认 `glm-5.3-flash` 与指定 `GLM-5.3-FlashX` 不同，而且没有执行默认模型生成，不能算默认验证。

纯 Linux 宿主中，Codex 没有可执行入口或已知 auth 文件，DSH 没有可执行入口；存在 profile 目录不能证明已登录。ZCode 安装内官方 CLI 0.16.9 已在临时项目和独立 `ZCODE_STORAGE_DIR` 下加载、验证插件。原生 Agent metadata 指向本插件的 minimaxcode 定义，记录一次工具调用；真实 MiniMax 返回蓝色图片与隐藏文件随机码，完整宿主→插件→Hub→worker 链路通过。已有桌面会话与配置没有改动。

Linux 启动脚本已改为 LF，使用 Python stdlib launcher 解析字面 `.env`、检查实际监听进程、保存 PID 出生时间、回收自己启动的进程组，并在启动失败时回滚。原生 Linux launcher 的 7 项测试通过；报告结构与附件证据的 8 项检查通过。普通回归基线 14 组全部通过，随后最终冻结的 ZCode RPC 驱动专项 22 项通过；其它已记录源码的 SHA 与基线一致。驱动与测试 harness 的后续变更单独记录，没有把旧整组结果冒充为新源码整组重跑。详情见总入口中的 `final_linux_regressions`。

已结束测试 Hub、SSH 转发和自有子进程，扫描新部署与私有状态对应的存活进程为零，running 结果为零。旧 `agents.json` 和 `hub.env` 与项目外阶段备份的 SHA 校验一致。此校验范围不包含上述既有 wrapper 会切换的共享认证文件；临时证据目录保留。

复现入口：

```text
python scripts/remote_platform_probe.py --ssh-alias <已有alias> --report docs/platform-final-regressions.json
python scripts/remote_matrix_control.py --ssh-alias <已有alias> --deployment /tmp/agenthub-platform-<已建目录> --report-prefix docs/platform-matrix-fixed --run
python tests/platform_matrix_evidence.py
python scripts/remote_platform_summary.py
```

`--run` 会实际调用已有账户；不要把新连接指针或登录配置写进仓库。无需真实模型的 Linux launcher 检查可在 Linux 执行 `python3 tests/platform_linux_smoke.py`。
