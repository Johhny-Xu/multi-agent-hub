# 0.8.0：先自动发现，再手动连接

日期：2026-10-08。本次增加连接发现与配对，不改变 worker 的模型能力或厂商登录状态。旧 0.7.0 安装包保留；源码按独立 v0.8.0 标签于 2026-10-09 发布，新 ZIP 为本地构建，未上传远程 Release 附件。

## 用户流程

首次安装 plugins 包，没有已有连接也没有显式地址时，安装器先扫描本机及局域网。交互终端展示可达 Hub，由用户选择；没有结果时提示手动填写地址。随后读取私有 token 文件或使用隐藏输入，健康与鉴权检查通过才保存外部 client.json。非交互安装不等输入，返回 setup_required 和后续配置入口，不静默选中服务器。

已有连接会保留，both 包继续配对自己的本地 Hub。安装目录的 connect.cmd / connect.sh 可重新扫描或手动切换；--scan 只列出候选。显式离线配置标为 configured_unverified，不算连接成功。更换连接前先查询原 Hub 未完成任务，完成保存后重启宿主 MCP 进程。

三个原生宿主均提供只读 hub_discover；ZCode 另有 /hub-discover 命令。MCP 或 Codex 启动器遇到缺失、损坏的连接文件时，仍可列工具和扫描；派发拒绝为 SETUP_REQUIRED。工具注册本身不会让 ZCode 自动执行扫描，首次自动扫描由安装器执行。

只有 token 或空对象的私有配置也属于未配置，不能回退 localhost 后携带该 token。仅从宿主市场安装、没有独立 connect 向导时，扫描结果提供私有配置路径及安装独立插件包的指引，不把 token 放进聊天。

## 协议与限制

- UDP IPv4 18766 查询只包含协议标识、版本和随机 nonce；Hub 返回 HTTP 端口、主机显示名、鉴权要求与固定 MCP 路径。地址由回复来源 IP 构造，广播不含 token、worker 配置或文件路径。
- 客户端先验证 nonce、类型和端口，再执行有时间与大小上限的无凭据 HTTP 健康检查；不跟随重定向。扫描只读，不能证明服务身份或账号可用，不会付费调用模型。
- 新 Hub 的发现响应跟随 HTTP 监听范围，回环服务不会对局域网开放；设置 AGENTHUB_DISCOVERY=0 可关闭发现响应。UDP 不可用或端口被占用时，HTTP 服务照常运行。
- 广播通常局限于当前局域网；旧 Hub、跨子网、VPN 或过滤 UDP 的网络可能需要手动地址。安装器不会修改防火墙。无需为自动发现复制厂商账号信息。
- 连接向导在发送凭据前由用户指定目标，不复用另一端点的 token；校验失败保留旧配置，成功后先私有备份再原子替换。token 不进入扫描结果、聊天输出或分发 ZIP。

## 验证

验证包括真实 UDP/HTTP、本机跨语言协议、Windows/Linux 安装、非交互退路、错误服务/重定向/超时、凭据隔离，以及原生桥在未配置时的只读发现和派发拒绝。广播不可达和直接指定 IP 的测试分别记录，不能互相替代。

- 最终完整回归：[Windows 21/21 组](release-0.8-windows.json)、[Linux 19/19 组](release-0.8-linux.json) 通过；验证期间源码未变化，验证后逐文件核对哈希仍一致。连接向导 20 项回归包含真实 HTTP 配对、坏 token、空结果/多结果、非交互、代理/重定向、慢响应头和正文、DNS 超时后不发请求、原配置保留与修复。
- [真实网络发现](release-0.8-discovery-lan.json)：Windows 和 Linux 的 Python/Node 两种客户端，默认扫描与显式 IP 共 8/8 项通过。Windows 默认扫描实际自动找到 Linux Hub，无 SSH 转发或防火墙修改。发现层独立回归两平台各 17/17。
- 首轮 Windows Python 默认扫描曾失败：向没有 Hub 的本机 UDP 端口发包后，系统返回 ConnectionResetError / 10054，旧逻辑提前结束整个扫描。修复为只忽略本次不可达、继续等其他回复；首轮失败与原生系统错误证据保留在上述报告中。
- [原生桥验证](release-0.8-native.json)：Codex 实际隔离启动器在缺文件、坏 JSON、空对象、只有 token 四种情况下都能列出 7 个工具，并在派发前拒绝。该报告的 ZCode/DSH 项为契约与文档验证，不声称新的宿主模型端到端调用。
- [发布包审计](release-0.8-packages.json)：三个 ZIP 各 14 项检查通过，包括源文件一致、组件分离、所有包内哈希、执行权限与密钥模式检查。
- [正式 ZIP 在 Linux 安装与配对](release-0.8-package-linux.json)：54/54 检查通过。Windows 构建的三个包经 SCP 哈希核对和 BusyBox unzip 原样解压，脚本权限/换行无需修补。Hub 启动健康，plugins 首次非交互安装返回待配置且没有写 client.json，安装后的 connect.sh 成功完成真实鉴权配对；安装副本的 Codex/DSH/ZCode 三份 MCP 都能列出 7 工具并发现已配置的 Hub。本项关闭临时 Hub UDP 响应以隔离并行验收，默认广播另由网络报告验证。所有自有服务已停止，未操作个人宿主配置。

首轮完整回归期间，将测试里的一个虚拟 token 名称改成明确的 SYNTHETIC_ 前缀，消除规则扫描的误报；首轮报告保留为 release-0.8-*-before-fixture.json。生产源码未因该改名变化，最终回归使用冻结后的测试文件重新执行。

### 本地发布文件

目录：<USER_HOME>/Desktop/agenthub-releases。旧 0.7.0 文件未覆盖。

| 文件 | 字节 | SHA256 |
| --- | ---: | --- |
| agenthub-0.8.0-hub.zip | 281653 | `12be1bbd1a9b066b895494b45bf24c91583ecb8680735ffb3b83bc2761df1eb9` |
| agenthub-0.8.0-plugins.zip | 405014 | `2b860a73f7fcb81598d014d5625fb19d5670aaf9897a31593e8d9d595e7ef2dd` |
| agenthub-0.8.0-both.zip | 646147 | `f2de47f24bfd85cc16e11cc7957b762a4292980fca15f26ecc00cad3c202d285` |

本轮没有再次消耗厂商模型额度；已有模型、原生宿主与双向任务边界继续见 [0.7 验收](release-0.7.md)。

源码与 Git 历史的最终密钥规则扫描见 [审计结果](release-0.8-security.json)。阶段备份保存在仓库外的 agenthub-backups；分发包仅包含白名单源码，连接与登录信息不入包。
