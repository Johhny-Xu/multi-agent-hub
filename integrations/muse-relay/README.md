# OpenMausBot Muse Relay：Muse 侧客户端

把 Meta Muse 个人助理接成 OpenMausBot 引擎（`driverKind=museRelay`）的 Muse 侧实现。OMB 把用户消息放进持久 outbox，Muse 的 hook 主动长轮询认领 turn，生成后通过同一连接回传文本和文件，OMB 写回原 thread。

这不是微信/iLink 通道，不是 Meta Model API，也不是本机 `muse serve`。Meta 没有公开的个人助理消息 API；这里依赖的 hook 运行方式（`$HATCH_HOOK_RUNTIME` 提供 `wake/log/silent`）是私有约定，真实可用性必须先由 Henry 做一次冒烟验证。

## 目录

| 文件 | 作用 |
| --- | --- |
| `omb-watch.sh` | Muse hook 脚本：单实例锁 → 回收陈旧 claim → 有 pending 先 wake → 否则长轮询 → 落盘成功后才 wake |
| `omb_relay.py` | Python 3.10+ 标准库客户端与本地状态机：poll/claim/heartbeat/send-text/send-file/complete/fail/retry-inflight/finish/recover |
| `AGENTS.md` | 给 Muse 自己执行的部署与 worker 操作契约，含 Henry 的一句话入口 |
| `fixtures/fake_omb.py` | 测试用 fake OMB 数据面（本地 HTTP，不连接真实 OMB） |
| `tests/` | fake runtime、fake OMB、临时目录下的单元与端到端测试 |

## 架构

```text
Henry → OMB bot（museRelay 实例）
          │ sendTurn 持久化 outbox
          ▼
   MuseRelayHub（lease / cancel / timeout / event dedupe）
          ▲                         │ turn.started / delta / text / file / completed
          │                         ▼
   现有 webhook ingress          OMB 原 thread
          ▲
   既有 HTTPS 隧道/反代（Henry 提供）
          ▲
   Muse omb-watch.sh ── poll ── 原子落盘 pending ── wake ──► Muse worker
                                                              │ claim（原子 mv）
                                                              │ heartbeat / 生成
                                                              ▼
                                                        events / files
```

每个 turn 自带 `threadId`、当前 `text`、`system` 和 `transcript`。Muse 自己的长期记忆不能当作 OMB 的线程隔离机制；回复只针对当前 turn 的上下文，不能混入其他 thread。

## 前置条件

- Python 3.10+，仅标准库。
- `bash` 和 `flock`（hook 单实例锁）。
- Muse 运行环境能访问 Henry 提供的公网 HTTPS 入口；真实域名、`connectionId` 和 token 由 Henry 提供。
- 真实的 TLS 证书。客户端不提供跳过证书校验的开关；自签证书需要先被系统信任。
- 部署目录不要求固定，但配置文件必须放在源码树外。

## 配置

默认路径：`~/.config/omb-muse-relay/config.json`，权限必须是 `0600`，属主必须是当前用户。可以用 `OMB_RELAY_CONFIG` 指向另一个路径。

```json
{
  "schemaVersion": 1,
  "baseUrl": "https://<Henry 提供的公网地址>",
  "connectionId": "<管理 API 返回的 connectionId>",
  "token": "<管理 API 只返回一次的 token>",
  "stateDir": "/home/<user>/.local/state/omb-muse-relay"
}
```

- `baseUrl` 只写 origin（scheme + host + port），不能带路径、查询、片段或用户信息。
- 真实部署必须是 `https`；`http` 只允许回环地址，供本地 fake 测试使用。
- `basePath` 由客户端按 `connectionId` 拼成 `/hooks/muse-relay/v1/<connectionId>`；配置里如果写了 `basePath`，必须与它完全一致。
- `token` 只从该文件读取。客户端不接受 `--token` 参数，也不会把 token 写进 argv、stdout、stderr、wake payload 或任何状态文件。
- 配置缺失、权限不对、是符号链接、属主不对、JSON 非法或字段不合法时一律 fail closed，不发起网络请求。
- `stateDir` 必须是绝对路径、不能是源码树内部、不能是 `/`；状态目录及其子目录权限为 `0700`。也可以用 `OMB_RELAY_STATE_DIR` 覆盖（用于隔离测试），它同样受这些限制。

## Hook 接线

在 Muse 的 hook runtime 里让 `omb-watch.sh` 每约 5 秒跑一轮。脚本只做四件事：source `$HATCH_HOOK_RUNTIME`、拿单实例锁、调用 `omb_relay.py`、调用 `wake/log/silent`。

- 有 pending：`wake "muse_relay_turn" '{"count":N}'`，不再 poll。
- 没有 pending：`poll --wait-ms 0`（Muse 当前设置）。deliveries 和 cancellations 先原子落盘并 `fsync`，CLI 退出后脚本才 wake；空结果调用 `silent`。
- 非法响应、空响应、网络错误、429/5xx：都算失败，不是“无任务”；脚本按指数退避（5s 起，最多 300s）并只记录脱敏原因（`http_429`、`invalid_response` 等）。
- 脚本每轮先跑 `recover`：回收超过 15 分钟没有心跳的 processing，隔离损坏的 pending/processing/ledger。回收用 `link` + `unlink`，不会覆盖同 turn 的新 pending。
- `wake` payload 只有 `count`，不含 token、消息正文或文件路径。

### 小响应（inputMode=ref）

Muse 沙箱到 OMB 的链路会在约 8–11 KB 处静默截断 HTTP 响应体，所以客户端的 poll 总是带 `"inputMode":"ref"`：

- poll 里的每个 delivery 不带 `input`，改带 `inputBytes`（input 的 UTF-8 JSON 字节数）和 `inputSha256`。不带该字段的旧客户端照旧收到内联 `input`。
- 客户端随后 `POST /turns/<turnId>/input`，body `{"schemaVersion":1,"deliveryId":D,"offset":N,"length":L}`（`L` ≤ 4096 原始字节），返回 `{"schemaVersion":1,"offset":N,"total":T,"data":"<base64>"}`，每个响应 < 6 KB。只有当前、租约未过期的 delivery 能读，否则 409；鉴权与其他 turn 端点相同。
- 每片网络错误/429/5xx/损坏最多重试 5 次（短退避）。拼好后校验长度和 SHA-256，再 `json.loads` 并走与内联 delivery 相同的校验，然后才落盘 pending。任何失败都不落盘（本轮记为可重试错误，如 `input_sha_mismatch`），服务端租约过期后会重投；片请求遇 409 则跳过该 delivery。
- 长回复：`send-text` 的最终 `text` 超过 4096 字节（且该 item 没发过 delta、没指定 `--event-id`）时，客户端按顺序拆成多个 ≤4096 字节的 `text` 事件，itemId 为 `<itemId>`、`<itemId>-p2`、`<itemId>-p3`…，每段在 OMB 里是一个独立气泡。中途失败后用同一命令重跑，会从第一段未确认的地方继续，输出带 `parts=N`。

## CLI

```bash
python3 omb_relay.py state-dir
python3 omb_relay.py pending-count
python3 omb_relay.py claim
python3 omb_relay.py poll --wait-ms 20000 --limit 1
python3 omb_relay.py heartbeat [--turn T --delivery D]
python3 omb_relay.py send-text --turn T --delivery D --text-file reply.txt [--final] [--delta] [--item-id I] [--event-id E]
python3 omb_relay.py send-file --turn T --delivery D --path file.png [--name N] [--mime M] [--event-id E]
python3 omb_relay.py complete --turn T --delivery D [--event-id E]
python3 omb_relay.py fail --turn T --delivery D [--text-file summary.txt] [--event-id E]
python3 omb_relay.py retry-inflight --turn T --delivery D
python3 omb_relay.py finish --turn T --delivery D --reason cancelled|stale|abandoned
python3 omb_relay.py recover --stale-seconds 900
```

`claim` 输出一个 JSON delivery（含 `input`、`nextSeq`，以及崩溃后需要优先重试的 `resume`）。其他命令输出一行 `key=value` 状态，例如 `status=ok duplicate=false eventId=evt-... seq=1`。

退出码：

| 码 | 含义 | worker 动作 |
| --- | --- | --- |
| 0 | 成功 | 继续 |
| 1 | 配置/状态不可用 | 停止并报告，不要重试 |
| 2 | 参数错误 | 修正命令 |
| 3 | `claim` 没有 pending | 安静结束 |
| 4 | 旧租约/409/已过期 | 立即停止，等待新投递；不要换 ID 补发 |
| 5 | 永久拒绝（400/401/403/404/413、文件/文本限制） | 停止；必要时 `fail` 并报告 |
| 6 | 本地幂等/顺序冲突 | 停止并检查 ledger |
| 7 | 网络/408/429/5xx，可重试 | 等 `retry_ms` 后用同一命令重跑 |
| 8 | 已取消 | 停止，`finish --reason cancelled` |

## 本地状态

```text
<stateDir>/
  pending/<turnKey>.json       # poll 落盘的待认领 delivery
  processing/<turnKey>.json    # claim 后的当前投递（含 claimedAtEpoch/heartbeatEpoch）
  ledger/<turnKey>.json        # deliveryId、staleDeliveryId、nextSeq、events、items、inflight、terminal
  locks/<turnKey>.lock         # 同 turn 的 claim/ledger 串行化
  locks/watch-state.lock       # poll 退避状态
  cancelled/<turnKey>.json     # 取消标记（poll/heartbeat 写入）
  done/ stale/ corrupt/        # 已结束、被新投递取代、损坏隔离
  watch.lock                   # hook 单实例锁
  watch.state.json             # 失败次数、nextPollAt、最后原因
```

- `pending`/`processing`/`ledger` 按 turn 分文件；`turnKey` 是清洗后的 turnId 加短哈希，避免路径穿越和文件名冲突。
- 所有 JSON 都是先写同目录临时文件、`fsync`、`rename`，再 `fsync` 目录；崩溃不会留下半个文件。
- `claim` 在 `locks/<turnKey>.lock` 内把 pending 原子 `mv` 到 processing；多个 wake 只有一个能认领。
- ledger 的 `nextSeq` 是 turn 内下一个连续序号；`events` 记录每个 eventId 的 seq/type/内容哈希（文件另有 `uploadId`）；`inflight` 在发请求前持久化，丢响应后用原 eventId/seq 重试。
- `staleDeliveryId` 记录收到 409 的投递；该投递后续发送直接本地返回 4，不发网络请求。新投递 claim 后清除。
- 同 turn 的新投递不会覆盖尚未处理的 pending；`recover` 发现 processing 已陈旧且有新 pending 时，把旧 processing 移到 `stale/`，保留新 pending。
- `completed`/`failed` 成功后才把 processing 移到 `done/`；取消用 `finish --reason cancelled` 写入终态。

## 回复语义

- `seq` 从 1 开始连续递增，跨重投保持连续；客户端负责分配，worker 不需要计算。
- `delta` 可选；同一气泡的 delta 必须用同一个 `itemId`。客户端会记录 delta 文本，最终 `text` 必须等于这些 delta 的拼接，否则返回 `delta_mismatch`（5）。不想处理这个约束就完全不要发 delta。
- 最终必须至少发一个完整 `text`，再发 `completed`；`complete` 在没有 text 事件时返回 5。
- `completed` 是最后事件；`failed` 是失败终态，`text` 是可选的简短安全摘要，不能放堆栈、凭证或内部路径。
- 文件用原始字节上传，`Content-Type` 是 MIME，`Content-Length` 必填；普通文件上限 100 MiB，图片 10 MiB。文件名不能含 `/`、`\`、控制字符，不能是 `.`/`..`；符号链接和非常规文件拒绝上传。
- 网络错误、408、429、5xx 用原 eventId/seq 退避重试；429 的 `Retry-After` 会转成 `retry_ms`。其他 4xx 不换 ID 绕过。
- `heartbeat` 无 turn 时只报在线；带 turn 时续租并返回 `cancelled`。最终 text 和 completed 发送前客户端会先 heartbeat 检查取消。
- `SIGTERM` 走正常清理路径，退出码 143；已经落盘的 inflight 保留，下一次用原 ID 重试。

## 安全边界

- token 只在 0600 配置里；不打印、不进 argv、不进 wake payload、不进状态文件、不进报告。
- 只接受 HTTPS（回环测试地址除外）；不跟随重定向，避免把 Authorization 发到另一个主机。
- 状态目录 0700；配置/状态文件用 `O_NOFOLLOW` 打开，拒绝符号链接。
- 错误只输出固定安全摘要，不回显响应正文、URL、路径、凭证或堆栈。
- 不读取 Meta 会话、Cookie、设备身份或 iLink 登录态；本包不包含微信登录、iLink session 或 owner 绑定逻辑。
- worker 只上传用户明确要带回的文件；不上传凭证、Muse 配置、状态文件或任意主机路径。

## 测试

全部使用 fake runtime、fake OMB 和临时目录，不登录真实 Muse、不访问线上 OMB。

```bash
python3 -m py_compile integrations/muse-relay/omb_relay.py \
  integrations/muse-relay/fixtures/fake_omb.py integrations/muse-relay/tests/*.py
python3 -m unittest discover -s integrations/muse-relay/tests -p 'test_relay_client.py' -v
python3 -m unittest discover -s integrations/muse-relay/tests -p 'test_state.py' -v
python3 -m unittest discover -s integrations/muse-relay/tests -p 'test_watch.py' -v
python3 -m unittest discover -s integrations/muse-relay/tests -p 'test_worker.py' -v
```

`test_watch.py` 需要 `bash` 和 `flock`，缺少时会 skip。测试覆盖：先落盘后 wake、重复 wake 只有一个 claim、崩溃恢复不覆盖 pending、丢响应原 ID 重试、旧租约 409 停止、429/5xx 退避、取消、SIGTERM、文件幂等与限制、token 不出现在日志/状态/输出。

## 首版限制

- 输入只有文本；不支持 OMB 图片输入、MCP、审批卡、steer、effort、`guestTurns:"confined"` 或 resumeCursor。
- 不声称创建 Meta 原生会话；`sessionId` 为 null，每个 turn 自包含。
- 取消是尽力通知；Meta 侧是否真正停止生成不可保证，OMB 侧以收到取消为准立即终态化。
- delta 是预览，不是逐 token 流；首版可以完全不发 delta。
- 公网入口、真实登录、凭证和隧道映射由 Henry 完成；本包不部署、不重启服务、不改防火墙。

真实部署与验收步骤见 [`AGENTS.md`](AGENTS.md)。
