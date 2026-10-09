AgentHub 0.8.0 将服务器与原生客户端分开安装：`hub` 包提供 Python HTTP Hub 和可选控制台，`plugins` 包只提供 Codex、ZCode、DSH 客户端，`both` 包可安装任一组件或同机共存。

解压后，Windows 双击 `install.cmd`，Linux 运行 `./install.sh`。默认组件跟随包名；Hub 安装后自动启动在 `127.0.0.1:8765`，控制台默认关闭。`--no-start` 可只安装。插件安装不会启动或停止已有 Hub；检测到的官方宿主通过各自原生 CLI 注册，缺少的宿主会显示 `not_installed`，注册失败返回非零退出码。

首次只装插件且没有已有连接或 `--url` 时，安装器自动扫描本机/局域网 Hub（UDP 默认端口 18766）。交互终端会显示候选，必须由用户选择，也可以手动输入 `host:port`；没有结果时直接提示输入地址。随后使用私有令牌文件或隐藏输入完成配对。非交互安装不会等待输入或自动选中服务器，而会返回 `connection.status=setup_required`、候选列表和 `connect` 指引，不写入假定的本机连接。已有连接与显式地址跳过自动扫描。同机 Hub/both 仍自动配对本地 Hub。

Windows 无参数双击安装器或连接向导时，会在成功/失败后保留提示，按回车关闭；带参数运行和重定向输入的非交互调用不会暂停。

依赖：安装器和 Hub 需要 Python 3.8+；Codex 项目代理安装助手需要 Python 3.11+；插件桥及可选控制台需要 Node.js 20+。插件运行时使用 Node 和原生宿主，Python 只在安装阶段使用。安装器不会自动下载运行时。缺依赖时会给出 [Python](https://www.python.org/downloads/) 或 [Node.js](https://nodejs.org/en/download) 官方入口。可用 `--python EXE`、`--node EXE` 指定入口；Windows 启动器也支持 `AGENTHUB_PYTHON`。显式无效路径会报错，不会悄悄换用其他入口。

局域网服务器与远程客户端示例（Linux 将 `install.cmd` 换成 `./install.sh`）：

```text
install.cmd --component hub --bind 0.0.0.0 --port 8765
install.cmd --component plugins --url SERVER:8765 --token-file C:\private\hub-token.txt
install.cmd --component both --with-console
connect.cmd --url SERVER:8765 --token-file C:\private\hub-token.txt
connect.cmd --scan
```

Hub 自动生成强随机令牌，保存到外部配置目录的 `hub.json` 和 `hub-token.txt`，不会输出到终端。只将这个 Hub 连接令牌通过私密渠道提供给客户端；客户端的 `--token-file` 必须指向至少 32 字符的单行令牌。服务器与 Windows 均可作为客户端或 worker 宿主，不要求 Hub 之间联邦转发。默认只监听本机；对外监听需要显式 `--bind`，安装器不修改防火墙或公网端口转发。

安装目录的 `connect.cmd` / `connect.sh` 可重新扫描、选择或切换 Hub。`--scan` 只列出候选，不读取令牌、不改配置。默认连接流程必须先通过无凭据 `/health` 和带令牌的只读 MCP `ping`，成功才私有备份旧文件并原子保存；验证失败保留原配置。同一端点可以保留旧令牌，切换端点必须提供新令牌。保存后请重启原生宿主或重新连接 MCP。损坏的 `client.json` 可通过显式 `connect --url ...` 或交互向导修复，旧原文也会先私有备份。

连接验证直接访问目标，不使用环境代理或跟随 HTTP 重定向，并为响应头和正文设置总时间预算。系统 DNS 解析无法在所有平台强制取消，但超时后的解析线程不会发送请求或令牌。`--timeout` 调整发现等待时间，`--discovery-port` 调整发现端口。

保留离线部署途径：安装时显式 `--url` 默认只保存配置，返回 `configured_unverified`，并不表示连接成功；加 `--verify-connection` 可要求保存前验证。独立连接命令默认验证，只有显式 `--save-offline --url ...` 才跳过验证，也会明确标为 `configured_unverified`。

Windows 默认安装和配置目录为 `%LOCALAPPDATA%\AgentHub`；Linux 安装到 `$XDG_DATA_HOME/agenthub`（默认 `~/.local/share/agenthub`），配置放在 `$XDG_CONFIG_HOME/agenthub`（默认 `~/.config/agenthub`）。程序在 `PREFIX/app`，连接、worker、状态、日志和进程记录放在外部配置目录。可用 `--prefix PATH`、`--config-dir PATH` 自定义。

原生桥使用 `AGENTHUB_CONNECTION_MODE=file` 和绝对 `AGENTHUB_CONFIG` 路径读取私有 `client.json`，其中只有 `{url, token}`。此模式忽略宿主继承的旧 URL/令牌，避免连接远程服务器时误用本地令牌。切换端点使用 `--url HOST:PORT|HTTP(S)URL --token-file FILE`；其他端点的令牌不会自动复用。

安装到相同 prefix 即可升级，配置默认保留；需要改变连接或监听设置时显式传参数。被替换的受管理文件先备份到 `PREFIX/backups`，用户修改过的 Codex 项目代理会保留并报告冲突。安装器拒绝覆盖无归属的现有程序目录。不会读取或复制任何厂商登录文件。

已安装目录中的 `start.cmd` / `start.sh`、`stop.cmd` / `stop.sh`、`status.cmd` / `status.sh` 管理本安装的服务，并校验 PID、创建时间及程序入口。可选控制台通过 `--with-console` 安装启动，默认本机端口 8890，状态也放在外部配置目录。

Linux 可显式使用 `--systemd-user`，需要可工作的用户 systemd 会话。每个 prefix 使用独立、带归属标记的用户 unit；启动、停止和升级都通过 `systemctl --user`，不修改系统服务、linger 或防火墙。此模式仅支持 Hub，和 `--with-console` 组合会提前报错。与 `--no-start` 组合时只写入 unit 并刷新用户管理器，不 enable 或启动；安装结果记录管理模式，之后 `start.sh` 可启动该 unit。

worker 配置只发现稳定的官方 CLI 路径，不证明账号或模型权限。仅发现的入口写入外部 `agents.json`；任意临时目录的便携程序不会自动加入。CodeBuddy 使用 standard 代理、Read 工具及 acceptEdits 预授权；MiMo 提供 default、26f、v2.6f 别名；ZCode 请求的 GLM 型号不存在时会在发送前拒绝，不换用其他模型。

原生选项：`--native-hosts auto|none|codex,zcode,dsh`、`--project PATH`、`--profile NAME`、`--codex-home PATH`、`--zcode-home PATH`、`--dsh-home PATH`，以及对应 `--codex-cli` / `--zcode-cli` / `--dsh-cli`。Codex 项目代理默认放在稳定的 `PREFIX/workspace`，或指定项目；打开该项目即可发现代理。

每个 ZIP 根目录包含 `manifest.json` 和 `SHA256SUMS`。发布目录也有各 ZIP 的校验清单；安装器按 manifest 验证分发源码。包内不含机器配置、日志、备份、个人会话或登录信息。
