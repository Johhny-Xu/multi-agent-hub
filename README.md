# multi-agent-hub

[English](README.en.md) · **简体中文**

**v1.3 是这个仓库的一次重构**：主干换成 [OpenMausBot](https://github.com/milind-soni/OpenMausBot) 的多引擎工作台，hub 原有的 MCP 任务池、签到与厂商配额作为附属模块保留下来。旧的 agenthub WebUI 已弃用，完整副本存放在标签 [`webui-final-20261107`](https://github.com/Johhny-Xu/multi-agent-hub/tree/webui-final-20261107)。

**当前版本：v1.3.0** · 协议 [Apache-2.0](LICENSE) · 更新日志 [CHANGELOG.md](CHANGELOG.md)

由 [@Johhny-Xu](https://github.com/Johhny-Xu) 单人维护。

---

## 这个版本包含什么

| 组成 | 来源 | 说明 |
| --- | --- | --- |
| **Bot 工作台** | OpenMausBot 0.1.145 | 多引擎对话前端与服务端。一个 bot 一个独立进程，可并行跑不同引擎 |
| **引擎层** | OpenMausBot + 本地扩展 | 三十余种 AI 编码 CLI，其中 **5 个国产 CLI 是本地扩展**：CodeBuddy（国际/国内）、Qoder（国际/国内）、CodeArts、MiniMax Code、Meoo |
| **MCP 任务池** | hub（原 `hub/` + `mcp/`） | 共享队列、信箱、笔记。任意 MCP 客户端连 `http://127.0.0.1:8765/mcp` 即可派发与回收 |
| **签到与配额** | hub（原 `console/`） | 从被弃用的 WebUI 里拆出来的纯 ESM 模块，见 `checkin/` |

### 国产 CLI 的接入方式

CodeBuddy、Qoder、CodeArts、MiniMax Code、Meoo 这五家里，有三家不原生提供 ACP server，因此各自带一个 stdio 桥（`server/drivers/codearts-acp.ts`、`mcode-acp.ts`、`meoo-acp.ts`）。

**Meoo 最特殊**：它不是交互式 CLI，是 Meoo 平台 Agent Run 接口外面套的壳。桥的做法是每次 prompt 驱动一次 Agent Run，再把结果按 ACP 事件回放——从 ACP 客户端看，它和别的 CLI 没有区别。

### Antigravity 不需要再下载官方运行时

上游只认 Google 的 `agy_acp_server.par` 加 `localharness_external` 两个文件。这里额外接受**本地安装的 agy CLI**：`agy 1.5+` 自带 `acp` 子命令，本身就是 ACP server，而且会复用你在 `~/.gemini/antigravity-cli` 里已有的 Google 登录态，不必二次登录。

## 构建与运行

```bash
pnpm install          # Node >= 24，pnpm 10.33
pnpm build            # tsc -b && tsc -p tsconfig.server.json && vite build
node --experimental-strip-types server/openmausbot.ts serve --port 8801
```

hub 的 MCP 池是独立进程：

```bash
python3 hub/agent_hub.py --http 8765 --host 127.0.0.1
```

## 目录

```
server/     服务端（含全部引擎驱动，drivers/acp/ 下是 ACP 系列）
src/        React 前端
shared/     前后端共享类型
hub/        MCP 任务池服务端（Python，零依赖）
mcp/        MCP stdio 桥（Node，零依赖）
checkin/    签到与厂商配额（纯 ESM，无第三方依赖）
drivers/    Trae / ZCode 的 DOM 驱动
integrations/ 6 款宿主插件的适配层
plugins/    ZCode 子代理桥插件
ops/        旧 WebUI 时代的运维脚本（保留参考，多数已不适用）
```

## 已知状态

- **旧 WebUI 已弃用**：`console/`、`desktop/`、`demo/` 从 v1.3 起不在主干。需要时从标签 `webui-final-20261107` 取。
- **签到模块需要新宿主**：原先自动签到由 WebUI 服务端每 30 分钟触发，WebUI 弃用后这层触发没有了。模块本身可用（`checkin/checkin.mjs` 是纯 ESM），接入方式待定。
- **`ops/` 里的脚本指向已删除的 `console/`**：`ops/remote_linux_services.py` 仍在尝试拉起 `console/server.mjs`，仅作历史参考。

## 许可

Apache-2.0。`NOTICE` 里保留了 Antigravity ACP 整合取自 T3 Code（MIT）的归属声明，这部分必须随代码一起分发。
