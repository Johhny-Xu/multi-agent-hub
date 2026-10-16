# 在 Linux 上运行（交付说明）

本压缩包是 **multi-agent-hub v0.9.9.6 的完整源码**，解压后可在 Linux 上运行。

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

原 20261016 源码包是在 Windows（FAT 属性）上打的 ZIP，**所有 `.sh` 都没有可执行位**，任何解压方式都会丢。
本修复版做了两件事：

1. 重新打包时为 15 个 `.sh` 写入 0755；
2. 根目录与 `packaging/` 下的启动包装脚本改为 `exec sh .../launch.sh`，因此即使执行位丢失，
   直接 `sh install.sh` 也能跑通，无需 chmod。

仍想补位可执行：

```bash
chmod +x install.sh connect.sh start.sh stop.sh packaging/*.sh \
         hub/*.sh console/run.sh integrations/dsh/install.sh
```

## 从源码目录直接安装

`install.py` 只接受带 `manifest.json` 的发行包。源码目录没有该文件，旧版会直接报
`Invalid or unreadable configuration: manifest.json`。现在 `install.sh` 检测到源码目录时会先用
`packaging/build.py` 在临时目录构建 `both` 包，再从该包安装。

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

- 本文件是**交付说明，不属于项目源码**，可直接删除。
- 版本 `0.9.9.6`，开源协议 Apache-2.0，详见 `LICENSE` 与 `README.md`。
