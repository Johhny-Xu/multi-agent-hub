# AGENTS.md — 把 Muse 接成 OpenMausBot 的个人助理引擎

你是 Muse（Meta 的个人助理）。Henry 让你按这份指南把你自己接成 OpenMausBot（OMB）的一个引擎：用户在 OMB 里给这个 bot 发消息，消息进入 OMB 的持久 outbox；你的 hook 主动长轮询认领 turn，生成回复后通过同一条 HTTPS 连接回传，OMB 把回复写回原来的 thread。

这是一份**操作契约**，不是 Meta 的公开 API 文档。它依赖的 hook 运行方式（`$HATCH_HOOK_RUNTIME` 提供 `wake/log/silent`）是私有约定；如果实际环境不具备，停下来告诉 Henry，不要用浏览器自动化或其他方式假装成功。

## Henry 的一句话入口

把下面这句话原样交给 Henry（把 `<指南地址>` 换成这份文档的实际地址）：

> 帮我按这份 OpenMausBot Muse Relay 指南，把你自己接成我的个人助理引擎：<指南地址>；公网地址、connectionId 和独立 token 由我提供，遇到登录或需要我确认的步骤停下来等我。

## 0. 你必须停下来等 Henry 的事

以下任何一项不满足，都停下来用一句话说明缺什么，不要猜、不要绕过、不要伪造：

- 没有可用的 `$HATCH_HOOK_RUNTIME`，或它不提供 `wake`/`log`/`silent`。
- 你的运行环境不能向 Henry 提供的公网 HTTPS 地址发起出站请求，或请求被代理/白名单拦截。
- TLS 证书校验失败（客户端不支持跳过校验；自签证书需要先被系统信任）。
- 配置完成后 `poll` 仍返回 `401`/`403`，或公网地址重定向到登录页/其他站点。
- 需要登录 Meta、读取 Meta 会话、Cookie、设备身份，或需要 Henry 在 Meta 侧确认任何步骤。
- 需要新建/修改隧道、反代、防火墙、端口，或需要把主 UI/API 暴露到公网。

公网地址、`connectionId` 和 token 由 Henry 提供。token 是这条连接独有的，不能复用 Bot API、webhook、Muse 或其他任何凭证。不要要求 Henry 在聊天里贴 token；如果他已经给了，直接写进 0600 配置文件，不要回显、不要复述、不要写进命令、日志、回复或报告。

## 1. 前置检查

```bash
python3 --version        # 需要 3.10+
command -v bash flock    # hook 需要
```

确认你能访问 Henry 给的公网地址（只做一次普通 HTTPS 请求，不要带 token，不要把地址写进日志）：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://<公网地址>/ 
```

返回任何 HTTP 状态都说明网络可达；连接失败、超时、证书错误就停下来找 Henry。不要用这个请求判断 token 或 OMB 状态。

## 2. 安装文件

把 `integrations/muse-relay/` 整个目录复制到一个稳定位置，例如 `~/omb-muse-relay/`，不要依赖 OMB 源码树长期存在：

```bash
mkdir -p ~/omb-muse-relay
cp -R integrations/muse-relay/. ~/omb-muse-relay/
chmod 700 ~/omb-muse-relay
```

目录里必须有 `omb-watch.sh`、`omb_relay.py`、`AGENTS.md`、`README.md`。不要修改 `omb_relay.py` 的协议逻辑；如果发现 bug，停下来报告，不要就地改协议。

## 3. 写配置

配置文件必须在源码树外，权限 `0600`，属主是你自己。默认路径 `~/.config/omb-muse-relay/config.json`；也可以放到别处并用 `OMB_RELAY_CONFIG` 指向它。

```bash
mkdir -p ~/.config/omb-muse-relay
chmod 700 ~/.config/omb-muse-relay
```

用你的文件写入工具创建 `~/.config/omb-muse-relay/config.json`：

```json
{
  "schemaVersion": 1,
  "baseUrl": "https://<Henry 提供的公网地址>",
  "connectionId": "<Henry 提供的 connectionId>",
  "token": "<Henry 提供的 token>",
  "stateDir": "/home/<你的用户>/.local/state/omb-muse-relay"
}
```

然后：

```bash
chmod 600 ~/.config/omb-muse-relay/config.json
```

检查（不要打印 token）：

```bash
python3 ~/omb-muse-relay/omb_relay.py state-dir
python3 ~/omb-muse-relay/omb_relay.py poll --wait-ms 0
```

期望 `poll` 输出 `status=empty`，或 `status=deliveries count=N`（说明 OMB 已经有排队 turn）。`status=error reason=config` 表示配置有问题；`reason=http_401` 表示 token 不对或被轮换；`reason=network`/`timeout` 表示出网或地址有问题。先修好这些，不要接 hook。

配置字段约束：

- `baseUrl` 只写 origin，不能带路径、查询、片段、用户名或密码；真实部署必须是 `https`。
- `connectionId` 只含安全可见字符；`basePath` 由客户端拼成 `/hooks/muse-relay/v1/<connectionId>`。
- `stateDir` 必须是绝对路径、不能是源码树内部、不能是 `/`；客户端会把状态目录和子目录设为 `0700`。
- 不要把 token 放进环境变量、命令行参数、shell 历史或任何会被日志记录的地方。

## 4. 接 hook

在 Muse 的 hook runtime 里，让下面这个脚本每约 5 秒运行一轮：

```bash
bash ~/omb-muse-relay/omb-watch.sh
```

脚本自己会 source `$HATCH_HOOK_RUNTIME`。它做这些事：

1. 拿 `$stateDir/watch.lock` 的单实例锁；拿不到就安静退出。
2. 跑 `recover`，回收超过 15 分钟没有心跳的 claim，隔离损坏的状态文件。
3. 有 pending：`wake "muse_relay_turn" '{"count":N}'`，不再 poll。
4. 没有 pending：长轮询 25 秒；deliveries/cancellations 先原子落盘并 `fsync`，CLI 退出后才 wake；空结果 `silent`。
5. 非法/空响应、网络错误、429/5xx 都按失败处理并退避，不会当成“没有任务”。

如果 hook runtime 的约定不是“每 5 秒跑一次脚本”，先停下来确认它到底怎么调度、`wake` 会不会把 payload 传给一个 agent turn。不要假设。

## 5. 被 wake 之后的 worker 契约

每次被 `muse_relay_turn` 唤醒，按下面的顺序做。所有命令都在 `~/omb-muse-relay/` 下执行，配置从默认路径或 `OMB_RELAY_CONFIG` 读取。

### 5.1 认领

```bash
python3 omb_relay.py claim
```

- 退出码 `3`（`status=no_pending`）：没有可做的 turn，安静结束。
- 退出码 `0`：stdout 是一个 JSON delivery。读它：
  - `turnId`、`deliveryId`：后续所有命令都要带。
  - `input.text`：用户当前这条消息，是本次任务。
  - `input.system`、`input.transcript`：只属于这个 OMB turn 的上下文。不要把其他 thread、其他 turn 或你主聊天的内容混进回复。
  - `nextSeq`：下一个序号；客户端会自动分配，你不需要手动传 `seq`。
  - `resume`：如果不为 null，说明上一次发送的结果未知（崩溃或丢响应）。先做 5.2。

处理完一个 turn 后可以再 `claim` 下一个；没有 pending 就结束。不要并行处理同一个 turn。

### 5.2 先解决未确认的事件

如果 `resume` 不为 null：

```bash
python3 omb_relay.py retry-inflight --turn <turnId> --delivery <deliveryId>
```

- `status=ok duplicate=true` 且 `resume.type` 是 `text`：那段完整文本已经在 OMB 里了。**不要再生成一条新的完整回复**，直接去 5.5 `complete`。如果还想补充，只能作为新的 item（新 `itemId`）发送。
- `status=ok duplicate=false`：这次才真正送达；同上，不要重复生成。
- `resume.type` 是 `delta`：继续正常生成即可。
- 退出码 `7`：等 `retry_ms` 后用完全相同的命令重试。
- 退出码 `4`/`8`：停止，按 5.6 清理。
- 退出码 `5`：无法恢复，按 5.7 `fail`。

### 5.3 生成

根据 `input.text` 生成回复。需要读文件、查资料、跑命令都可以，但：

- 只针对当前 turn；不要声称创建了 Meta 原生会话或 OMB 线程。
- 需要 Henry 在主聊天确认的高风险操作，停下来，用一条简短回复说明需要他确认；不要把 OMB 的审批模式、工具白名单或 MCP 说成已经传给你。
- 长任务期间每约 60 秒续租：

```bash
python3 omb_relay.py heartbeat --turn <turnId> --delivery <deliveryId>
```

输出 `cancelled=true` 表示 OMB 已取消这个 turn：立即停止生成，按 5.6 清理，不要发送迟到的结果。

### 5.4 发送文本

把回复写到文件（例如 `~/omb-muse-relay-work/reply.txt`），不要用命令行参数传长文本：

```bash
python3 omb_relay.py send-text \
  --turn <turnId> --delivery <deliveryId> \
  --text-file ~/omb-muse-relay-work/reply.txt --final
```

- 最终必须至少有一个完整 `text` 事件，然后才能 `complete`。
- `delta` 可选。除非你能保证同一 `itemId` 的所有 delta 拼接起来**正好等于**最终 text，否则不要发 delta；客户端会拒绝不匹配的最终 text（`reason=delta_mismatch`，退出码 5）。
- 不要用 `--event-id`，除非你在重试一个已知事件；正常发送让客户端生成并持久化 ID。
- 退出码 `7`：等 `retry_ms` 后重跑**同一条命令、同一个文本文件**。客户端会用原 eventId/seq 重试，不会产生第二条消息。
- 退出码 `4`：旧租约，立即停止；不要用旧 deliveryId 补发，等 OMB 的新投递。
- 退出码 `5`：文本/协议被永久拒绝；按 5.7 处理。
- 退出码 `8`：已取消；按 5.6 清理。

### 5.5 发送文件（仅当用户明确要）

只上传用户明确希望带回的文件。不要上传凭证、Muse 配置、状态文件、日志、任意主机路径或你从系统里翻出来的东西。

```bash
python3 omb_relay.py send-file \
  --turn <turnId> --delivery <deliveryId> \
  --path ~/omb-muse-relay-work/result.pdf
```

- 原始字节上传；`Content-Type` 自动按文件名推断，也可以用 `--mime` 指定。
- 普通文件上限 100 MiB，图片 10 MiB；符号链接、目录和非常规文件会被拒绝。
- 文件名不能含 `/`、`\`、控制字符，不能是 `.`/`..`。
- 发送成功后再 `complete`；如果文件是唯一内容，也要先发一条简短 `text`（例如“文件在下面”），因为 `complete` 要求至少一个 text。

### 5.6 完成或取消

```bash
python3 omb_relay.py complete --turn <turnId> --delivery <deliveryId>
```

- `complete` 是最后一个事件；成功后 processing 会被移到 `done/`。
- 退出码 `7`：等 `retry_ms` 重跑同一条命令；`completed` 是幂等的。
- 退出码 `4`：停止，不要重发。
- 取消时：

```bash
python3 omb_relay.py finish --turn <turnId> --delivery <deliveryId> --reason cancelled
```

### 5.7 失败

如果无法完成这个 turn，发一个失败终态（可选一段简短、安全的说明，不要放堆栈、凭证、内部路径或用户隐私）：

```bash
python3 omb_relay.py fail --turn <turnId> --delivery <deliveryId> \
  --text-file ~/omb-muse-relay-work/failure.txt
```

失败后不要再发 `completed`。如果 `fail` 也失败（4/7/8），按对应退出码停止；OMB 会在 turn 超时后收尾。

### 5.8 绝对不要做

- 不要把 token 写进 prompt、回复、日志、命令、环境变量、报告或任何状态文件。
- 不要用旧 `deliveryId` 或旧 `eventId` 去“补发”到新租约。
- 不要手工编辑 `pending/`、`processing/`、`ledger/` 里的文件来绕过冲突；需要恢复时用 `recover`。
- 不要删除 `stateDir` 或 `watch.lock` 来“解决”卡住；先看 `recover` 的输出和 `watch.state.json` 的 `lastReason`。
- 不要为了测试去连接真实 OMB 的生产数据；本地验证只用 `fixtures/fake_omb.py`。
- 不要声称已经完成真实部署或真实 Muse 验证，除非下面的验收项真的跑过。

## 6. Henry 的真实验收清单

在 Henry 配置好公网入口、`connectionId` 和 token，并且你完成第 1–4 步之后，按顺序做：

1. `poll --wait-ms 0` 返回 `status=empty`，没有 401/TLS/网络错误。
2. Henry 在 OMB 里给这个 bot 发一句话；5 秒内 hook 应 wake，回复出现在**原 thread**，不是新会话。
3. 发一条需要较长生成的请求；期间 `heartbeat` 持续续租，最终只有一条完整回复，没有重复。
4. 让 Muse 返回一个小文件；文件作为附件落一次，大小和内容正确，没有 base64 或公网路径泄漏。
5. 在 OMB 里中断一个 turn；Muse 的 `heartbeat` 看到 `cancelled=true` 后停止，迟到的发送被 409 拒绝。
6. 在发送过程中断网或杀掉 worker；恢复后用原 eventId 重试，OMB 只落一条消息。
7. 在 OMB 里轮换 token；旧 token 立刻 401，更新配置后 polling 恢复。旧 token 不应出现在任何日志里。
8. 重启 OMB；旧的非终态 turn 由 OMB 标记 `server_restarted`，不会被自动重放；Muse 侧收到 409 时停止，不把旧结果写进新回合。
9. 检查状态目录和 hook 日志：没有 token、没有 Authorization、没有完整消息正文的意外副本。

任何一项失败，停下来报告具体现象和 `status=...`/退出码，不要用“可能”“应该”掩盖。

## 7. 首版限制

- 输入只有文本；不支持 OMB 图片输入、MCP、审批卡、steer、effort、`guestTurns:"confined"` 或 resumeCursor。
- 不创建 Meta 原生会话；`sessionId` 为 null，每个 turn 自包含。
- 取消是尽力通知；Meta 侧是否真正停止生成不可保证。
- delta 是预览，不是逐 token 流；建议首版完全不发 delta。
- OMB 的审批、工具白名单、MCP 和 guest confinement 没有映射到 Muse；Muse 自己的工具策略仍需 Henry 评估。
- 公网地址、隧道、反代、防火墙、真实登录和凭证都由 Henry 负责；本包不部署、不改这些。
