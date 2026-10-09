# 0.7.0：失败根因修复、拆分安装与验收

日期：2026-10-08。本轮在此前完整兼容性矩阵基础上修复和复测，不将历史失败改写为成功。源码按独立 v0.7.0 标签于 2026-10-09 发布；安装包仍为本机构建产物，未上传远程 Release 附件。

## 本轮改动

插件与 Hub 拆成 `plugins`、`hub`、`both` 三个 ZIP。Windows 和 Linux 使用相同源码、不同启动包装；安装器检测运行时和官方 CLI，连接和账户信息留在机器外部配置目录。Hub 默认单进程服务，网页控制台可选；只安装插件时由宿主启动桥接进程，不启动本地 Hub。升级备份应用并保留配置。

MCP、Codex、ZCode、DSH 共用外部 `client.json` 连接读取逻辑，支持标准 Windows/XDG 路径、显式路径及旧 Codex PLUGIN_DATA 配置。更换服务器时不复用其他服务器保存的 token。安装后的原生插件使用 `AGENTHUB_CONNECTION_MODE=file` 绑定指定连接文件，防止父进程的旧 URL/token 覆盖它；未设置该模式的源码入口保留环境优先规则。三个原生插件的账户、模型和编排功能仍由各官方宿主决定。

控制台按 Hub 平台、worker 和选中型号决定是否开放思考开关、正文流式、图片和文件。Auto 与手动 HTTP/MCP 派发都先验证能力；原来只是改提示词的 effort/context 档位已移除。未知能力不会自动视作支持。最近失败按型号暂存公开错误代码，不保存凭据或原始厂商错误正文。

## 失败项如何处理

| 原失败或限制 | 根因与处理 | 当前结论 |
| --- | --- | --- |
| Linux CodeBuddy 不读文件、输出 DSML | 官方 CLI 继承 lastUsed 代理模式，文件工具没有执行；显式 standard 代理、Read 工具授权，文本输入走已适配通道 | 新 Hub 的图片内容、隐藏文件 nonce、任务标记全部实测通过 |
| MiMo 偶发 exit=0 空输出/超时 | 厂商进程没有输出最终文本，部分只到工具/步骤事件；没有可恢复的答案 | 明确失败/超时，保留 ref；不自动重派，也不把偶发失败伪装成永久能力限制 |
| MiniMax 关闭思考 | 所选 M3.1 型号始终思考 | 禁用 off；图文读取可用，本地文件编辑不支持 |
| Copilot auto 显式思考 | auto 可能选择不同型号，不能保证统一开关语义 | 以当前型号能力返回为准，未证实的开关不开放 |
| ZCode 目标 GLM 不在账号目录 | 指定型号无法创建 | 驱动在发任务前校验并拒绝；不替换成其他型号来算通过 |
| ZCode 正文流式/显式思考切换 | 未验证实时正文片段或切换语义 | 对应功能禁用，使用支持的默认/缓冲方式 |
| CodeBuddy 国际版、Antigravity、部分 MiMo/Linux、Trae | 既有实测包含认证、区域限制或 SSO/网关错误 | 软件不能补足厂商授权；本机实际错误形成可刷新的不可用提示 |
| DSH 原生子代理/工作流 | 先前官方账户返回 402 ACCOUNT_QUOTA，未进入 Hub 派发 | 保留插件/预设注册证据，仍不宣称付费端到端通过 |

能力刷新清除有期限的最近失败提示，不自动调用模型，不承诺登录或余额已恢复。修复和具体证据见 [根因报告](root-cause-2026-10-08.md)、[CodeBuddy 新 Hub 实测](root-cause-codebuddy-hub-linux.json) 与 [任务契约](task-options.md)。

## 网络验证

| 路径 | 执行方式 | 结果 |
| --- | --- | --- |
| Windows 插件 → Linux Hub → MiniMax | 两台机器直接网络连接，插件传图片与文本文件字节 | 正确答案与隐藏 nonce 通过；[原始结构化结果](release-0.7-lan.json) |
| Linux 插件 → Windows Hub，直接连接 | 先测试 Windows 测试端口可达性 | 端口不可达，没有发送付费模型任务；不能标为直连通过 |
| Linux 插件 → Windows Hub → MiniMax | 通过现有 SSH 的临时反向转发，再传图片和文件 | 正确答案与隐藏 nonce 通过；[结构化结果](release-0.7-reverse-ssh.json) |

使用既有官方登录，未把 Windows 厂商凭据复制到 Linux；未修改防火墙和旧部署。两个方向使用自有临时 Hub 和私有连接文件，执行后停止自有 Hub/转发进程。SSH 仅为反向测试提供通道，报告明确标注，不算直接 LAN 成功。流式 progress 计数只证明桥可见正文进度，不证明宿主 UI 逐字展示。

## 验收记录

最终完整回归通过：[Windows 19/19 组](release-0.7-windows.json)、[Linux 17/17 组](release-0.7-linux.json)，两个报告均记录验证期间源码未变化。Windows 总线另外记录 [13 项实际进程/HTTP 检查](release-0.7-windows-windows-bus.json)。控制台验证包含真实 Python Hub 能力到 JS 的接口联测、HTTP/MCP 预检与执行真实前端函数的模拟 DOM；当前工具环境没有可连接浏览器，因此没有 GUI 浏览器通过结论。

- [原生安装实测](packaging-native-validation.json)：Windows 官方 Codex/ZCode/DSH 隔离注册与重复安装成功。ZCode 新连接设置进入实际缓存，原插件数据、启用状态与其他插件状态保持；DSH 真正加载 9 个预设、6 个 MCP 工具和 workflow。本项没有付费模型调用，不覆盖此前 DSH 额度不足的端到端限制。
- [Linux 用户服务实测](packaging-systemd-linux.json)：18/18 检查通过，包含安装启动、健康、停止、重新启动、同目录升级及配置保留。纯 Hub 没有常驻 Node；自有 unit 已停止、禁用并精确清理，旧服务未操作。systemd 模式只支持 Hub，不能与可选控制台组合。
- [正式 ZIP 的 Linux 安装实测](packaging-release-linux.json)：43/43 检查通过。将 Windows 构建的三个正式 ZIP 传到真实 Linux 后使用 BusyBox unzip 解压，校验传输哈希、脚本执行权限与 LF 换行，无 chmod 修包。Hub 默认安装后自动启动，健康检查、状态与停止成功；plugins/both 在独立目录使用 --no-start 安装，组件完整、没有自有运行进程。未调用模型或注册个人原生宿主。
- [发布包审计](release-0.7-packages.json)：三个包分别通过 14 项检查，包括 ZIP 完整性、包内清单及全部 SHA256、组件分离、与最终源码逐文件一致、运行配置与凭据排除、文本密钥模式扫描。审计时最终 Windows 回归记录的源码哈希仍全部一致。
- 首轮 Windows 回归保留在 [修正前结果](release-0.7-windows-before-final.json)：一个用例在 worker 写完运行元数据前清理临时目录，另一个旧用例仍期待缺失 CLI 先受理。已分别改为等待本任务执行器退出、验证同步拒绝，并保留受理后启动失败的独立用例。没有把这些首轮失败从证据中删除。

独立连接测试对四份桥分别启动子进程，只给外部连接文件即可访问模拟远端 Hub；覆盖 token 隔离、环境优先级、无本地 Hub 依赖与能力刷新参数。普通回归不调用付费厂商模型。

最终还修复了 worker 仅在 profile 自定义 PATH 中时的错误 cli_missing：预检与实际派发使用相同的继承环境和变量展开。Windows .cmd 与 Linux 可执行文件的临时真实入口均有回归覆盖。

### 正式本地产物

文件位于 `<USER_HOME>/Desktop/agenthub-releases`。这三个 ZIP 的字节已经完成上述 Linux 安装验收；暂未上传远程 release。`SHA256SUMS` 同时放在发布目录和每个包内。

| 文件 | 字节 | SHA256 |
| --- | ---: | --- |
| agenthub-0.7.0-hub.zip | 268771 | `8b9ed04d8053b82d8a3079bdaaad1d4d4771a1af5e3252a8e006ede8a082d4b3` |
| agenthub-0.7.0-plugins.zip | 374155 | `3ea65c5bcc00e1020911cbc26904a4a7ad6d43ed7e8788432ecaaac3235bd747` |
| agenthub-0.7.0-both.zip | 613563 | `d76b0d9549186068c1ea105af62f3bf1254b6107842841ff65e3421b54c89365` |

本轮备份位于源码仓库之外的 `agenthub-backups`，打包产物位于 `agenthub-releases`。源码与 Git 历史的规则扫描结果见 [密钥审计](release-0.7-security.json)；这类扫描用于排查常见凭据形式，不替代对实际运行数据的管理。

自动审批曾阻止删除一个隔离浏览器测试临时目录（返回 `blocked by policy`，未给更细理由），未重复绕过；测试进程已停止，保留的目录不进入发布包。

## 复现

```bash
python tests/run_regressions.py --report docs/local-validation.json
python scripts/audit_secrets.py --history
python packaging/build.py --output /path/outside/repository/releases
```

实际网络/模型探针必须显式运行，并会消耗对应账号额度；Windows 侧示例：

```powershell
python scripts/lan_roundtrip_probe.py --ssh-alias EXISTING_ALIAS --report docs/lan-local.json --run
python scripts/lan_roundtrip_probe.py --ssh-alias EXISTING_ALIAS --directions linux_to_windows --reverse-ssh-fallback --report docs/reverse-local.json --run
```

详细安装参数见 [安装说明](../packaging/README.md)。此前 8 worker、平台和原生宿主的验证范围见 [历史矩阵](compatibility-2026-10-08.md)。
