# MiniMax Code 登录持久化与保活

## 解决什么

MiniMax Code CLI（`mcode`）的 OAuth access token 只有 1 小时；refresh grant
会同时轮换 refresh token。`mcode` 会把登录态写入自己的 `auth.json`，但**不会在
access token 过期前自动续期**。结果是：

- `auth-state.json` 仍写着 `authenticated`，Hub 误判为已登录；
- 实际 `mcode exec` 返回 `Sign in to MiniMax`；
- 登录文件还在，但 access token 已过期。

本功能只做登录凭据生命周期管理：**刷新 token、原子回写、定时保活**。不启动
反向代理，不转发任何模型或 API 请求，不改变 mcode 的上游地址。

参考实现的行为来自 [Zhengyuuuui/minimax2api](https://github.com/Zhengyuuuui/minimax2api)
的 keepalive / device_login 逻辑；本项目按其刷新协议独立实现。

## 刷新协议

```
POST https://account.minimax.cn/oauth2/token
Content-Type: application/x-www-form-urlencoded

client_id=mcode-public
grant_type=refresh_token
refresh_token=<stored refresh token>
```

国际版使用 `https://account.minimax.io`。不要在 token 请求里带 `app_id`、
`scope` 或 `audience`；按参考实现，只传上面三个字段。响应会返回新的
`access_token`、`refresh_token` 和 `expires_in`，三者都要落盘。

## 落盘文件

```
~/.minimax/auth/prod/cn/mcode-public/auth.json
~/.minimax/auth/prod/cn/mcode-public/auth-state.json
```

- `auth.json`：保留原 record key，只更新 `accessToken` / `refreshToken` /
  `expiresAtMs`，并递增 `generation`。
- `auth-state.json`：同步 `expiresAtMs` / `generation`，保持
  `status=authenticated`。
- 写临时文件后 `os.replace`，权限 `0600`；不会覆盖刷新期间刚完成的新登录。
- 跨进程使用 `.agenthub-keepalive.lock` 串行化刷新，避免两个进程使用同一个
  即将轮换的 refresh token。

## Hub 集成

`hub/agent_hub.py` 在 `--http` 启动时启动守护线程：

- 首次启动立刻扫描一轮；
- 之后每 `AGENTHUB_MINIMAX_KEEPALIVE_INTERVAL` 秒扫描一次；
- 距离过期不足 `AGENTHUB_MINIMAX_REFRESH_MARGIN` 秒就刷新。

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENTHUB_MINIMAX_KEEPALIVE` | `1` | `0/false/off` 关闭 |
| `AGENTHUB_MINIMAX_KEEPALIVE_INTERVAL` | `600` | 扫描间隔秒，最小 60 |
| `AGENTHUB_MINIMAX_REFRESH_MARGIN` | `1200` | 过期前多少秒开始刷新，最小 60 |
| `MCODE_AUTH_DIR` | `~/.minimax/auth` | mcode 登录根目录 |

日志只输出状态、过期时间和错误，不输出 access/refresh token：

```
[minimax-keepalive] started interval=600s margin=1200s
[minimax-keepalive] refreshed expires_at=2026-11-02 15:30:00
```

`hub_login(action="status")` 现在同时检查 `status=authenticated` **和 access token
未过期**，不会再对着过期 token 报“已登录”。

## 手动运行

```bash
python3 hub/minimax_auth.py --once --json
python3 hub/minimax_auth.py --loop
```

`--once` 适合 cron/timer；Hub 已自带常驻线程，一般不需要额外 systemd unit。

## 限制

- refresh token 本身被上游拒绝（`invalid_grant`）时无法自动恢复，必须重新
  `hub_login` 完成一次官方设备授权；之后保活会继续接管。
- 不保存账号密码，不做密码登录兜底，不做任何反代。
- 国际版/国内版按 `auth-state.json` 的 region 或目录 `cn` / `en` 自动选择账号域。
