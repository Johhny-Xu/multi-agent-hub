# 在 Linux 上运行（交付说明）

本压缩包是 **multi-agent-hub v1.0.0 的完整源码**，解压后可在 Linux 上运行。

## 环境要求

- **Python 3.8+**（Codex 相关功能需 3.11+）
- **Node.js 20+**（MCP 桥接与 Web 控制台）
- 各 Worker 需自行安装对应厂商的官方 CLI 并完成登录；安装器只做环境探测与指令调用，
  不含账号注册与自动登录

## 跑起来

```bash
cd multi-agent-hub
./install.sh                    # 一键安装：Hub 服务 + WebUI + 已安装宿主的原生插件
./install.sh --with-console     # 额外启动 Web 控制台（默认 :8890）
```

## 如果报 Permission denied

包内 15 个 `.sh` 在归档里已记录 `0755`（`create_system=3, mode=0755`）。`tar -xzf` 与 Linux 下的
`unzip` 都会保留权限位，可直接 `./install.sh`。

但**部分解压工具会丢掉 Unix 权限位** —— Python 的 `zipfile.extractall()` 会解出 `0664`，
Windows 资源管理器、部分 JS 解压库同样如此。为了不依赖权限位，根目录与 `packaging/` 下的
启动包装脚本统一改成了 `exec sh .../launch.sh`，因此**即使权限位丢了，`sh install.sh` 也能直接跑通**：

```bash
sh install.sh                  # 权限位丢了也能用
sh install.sh --with-console   # 额外启动 Web 控制台（默认 :8890）
```

注意 `./install.sh`（不带 `sh`）仍然需要执行位；想恢复它，补一次即可：

```bash
chmod +x install.sh connect.sh start.sh stop.sh packaging/*.sh \
         hub/*.sh console/run.sh integrations/dsh/install.sh
```

## 从源码目录直接安装

`install.py` 只接受带 `manifest.json` 的发行包。源码目录没有该文件，旧版会直接报
`Invalid or unreadable configuration: manifest.json`。现在两条入口都能处理源码目录：`install.sh`
会在临时目录构建 `both` 包再交给安装器；直接调用 `python packaging/install.py --bundle .` 时，
`install.py` 自己也会先构建一份（构建出的临时目录在安装结束后自动删除，其中的 `.sh` 会补回 `0755`）。

## 代理环境（http_proxy / https_proxy）

Hub 与控制台的健康检查、Trae 网关、回调都走 127.0.0.1。旧版在设置了代理但未设 `NO_PROXY` 的机器上，
这些本机请求会被发给代理并拿回 404，导致安装报 `Health timeout`。现已对回环地址强制直连。

## 目录速览

| 目录 | 内容 |
|---|---|
| `hub/` | Python 任务总线（MCP Server，默认 :8765） |
| `console/` | Node Web 控制台（默认 :8890） |
| `mcp/` | MCP 桥接器 |
| `drivers/` | 各厂商 CLI 驱动 |
| `integrations/` | 6 大宿主原生插件（CodeArts / Codex / DSH / VS Code / Antigravity） |
| `plugins/` | agenthub-workers 通用插件包 |
| `packaging/` | 安装器与构建脚本 |
| `tests/` | 离线回归测试 |
| `docs/` | 架构图、路线图与测试证据 |

## 自检

```bash
python3 tests/run_regressions.py --report /tmp/regr.json
```

可选：装上下面两个测试依赖后，原本被跳过的真实 SDK / CLI 用例也会执行：

```bash
pip install google-antigravity==0.1.21
npm i -g @openai/codex && export CODEX_TEST_BINARY=$(command -v codex)
```

## 备注

- 本文件随源码包一起分发，同时由仓库跟踪维护；打包时保持与仓库版本一致即可。
- 版本 `1.0.0`，开源协议 Apache-2.0，详见 `LICENSE` 与 `README.md`。
