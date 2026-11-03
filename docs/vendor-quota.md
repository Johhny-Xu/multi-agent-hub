# 账号实时配额是怎么查出来的

控制台「子代理卡片 → 额度胶囊 / 配额浮层」里的数字全部来自各厂商官方接口，
不估算、不缓存落盘（进程内 60s 缓存）。本文件记录每个渠道的端点、鉴权方式与
解析口径，便于厂商改版时定位。

实现位置：

- `console/vendor-quota.mjs` —— 大部分渠道 + 统一缓存/单飞/归一化
- `console/quota-deep.mjs`  —— 需要解密凭据或设备指纹的三家（qoder / qoder-cn / traecode）
- `console/client/quota-view.js` —— 数据 → UI 的归一化与摘要（浏览器与单测共用）

统一输出契约：

```jsonc
// GET /api/quotas  →  { "<worker>": { worker, account, plan, quotas: Quota[], message?, fetchedAt } }
// Quota = { name, displayName, used, total, remaining, remainingPercentage,
//           resetAt, unlimited, isCreditBalance?, primary?, unit? }
```

> `quotas` **恒为数组**。历史实现里有对象 map 形态，`normalizeQuotas()` 会在出口统一转换。

---

## Qoder / Qoder CN

| 项 | 值 |
|---|---|
| 端点 | `GET https://openapi.qoder.sh/api/v2/quota/usage`（国际）<br>`GET https://openapi.qoder.com.cn/api/v2/quota/usage`（国内） |
| 凭据 | `~/.qoder/.auth/user` / `~/.qoder-cn/.auth/user`（AES 加密，key 由 `machine_id` scrypt 派生） |
| 鉴权 | `Authorization: Bearer <dt->` + **完整设备指纹** |
| 实测响应 | 见下 |

设备头三件套（缺了会被 401/403）：

```
Cosy-Version, Cosy-MachineOS, Cosy-MachineId, Cosy-MachineHostname
Cosy-MachineToken, Cosy-MachineCode, Cosy-MachineType   ← 由 UMID 组件派生
```

响应：

```jsonc
{
  "userType": "personal_standard",
  "usageType": "credits",
  "totalUsagePercentage": 0.13,       // 注意：是「已用」占比，0.13 = 用了 13%
  "isQuotaExceeded": false,
  "expiresAt": 253402214400000,       // 年 9999，UI 里当「无重置日」丢弃
  "userQuota": { "total": 0, "used": 0, "remaining": 0, "percentage": 0, "unit": "credits" },
  "addOnQuota": { "total": 1600, "used": 200, "remaining": 1400, "percentage": 0.13, "unit": "credits" },
  "dedicatedResourcePackages": [],
  "orgResourcePackage": { "remaining": 0 }
}
```

- 全零的池（如免费号的 `userQuota`）不展示；`addOnQuota` 就是面板上的「加油包」。
- 令牌过期时用 `deviceToken/refresh` 就地续期；**不写回磁盘**——配额是只读展示，
  写权留给签到，避免两边抢 refresh token 轮换。

## Trae CN

| 项 | 值 |
|---|---|
| 端点 | `POST https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list`<br>`POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status` |
| 凭据 | `~/.trae-cn/storage.json`（AES-CBC 解密）→ `accessToken` / `refreshToken` |
| 令牌来源 | **必须先合并 `~/.agenthub/trae-token-cache.json`**：桌面端那份常已过期 |
| 鉴权 | `Authorization: Cloud-IDE-JWT <jwt>` + 小写 `x-device-id`（真实注册过的十进制设备号） |

解析：

1. 优先 `data.usage_summary` 的 `total_amount` / `consumed_amount`。
2. 缺失时按 `user_entitlement_pack_list[].entitlement_base_info.quota.credits_limit`
   求和（只算 `limit > 0` 的包，`product_type=0` 是功能开关包，没有额度）。
3. 业务码 `1001/1002/401/403` 视为令牌失效 → 用 refreshToken 续期一次再试；
   续期也失败就明确报「需让 Trae 客户端重新登录」。

今日签到单独作为一条 0/1 状态位，**不参与**「账号还剩多少」的主口径判定。

## CodeArts Doer（华为云码道）

| 项 | 值 |
|---|---|
| 端点 | `GET https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/statistics/plugin` |
| 凭据 | `~/.config/agenthub-codearts/codearts-auth.env` 里的 `CODEARTS_CLI_AK/SK` |
| 鉴权 | `SDK-HMAC-SHA256`（`hwsSdkSignedHeaders`），额外头 `Agent-Type: PromptCenter` |

`metrics[]` 里按名字取：

| metric | 含义 |
|---|---|
| `usageTotalPackageCredit` | 积分总包：`package_credit_amount / _used / _remain` |
| `usageBasicPackageCredit` | 基础包（总包的子集） |
| `usageBonusPackageCredit` | 赠送包 |
| `usageOnDemandPackageCredit` | 按需包（一般为 0） |

`package.package_name_cn` 给套餐名，`end_date` 给本期到期日。

> ⚠️ `usageTokenChatMessages.package_token_amount` 只有一个「1」，没有可用的
> 月度 tokens 上限——不要拿它推算总量，只展示积分口径。

## CodeBuddy（`codebuddy` / `codebuddy-cn`）

`POST {base}/v2/billing/meter/get-user-resource`，`data.Response.Data` 双层包裹。
两类积分不可合并：基础体验包（`Cycle*`，周期性刷新）与活动赠送包（`Capacity*`，
一次性到期作废）。接口只给 `used/total`，`remaining` 由前端 `quotaItemsOf()` 兜底算。

> 国际版 `www.codebuddy.ai` 与国内版 `copilot.tencent.com` 是**两条独立凭据**，
> 分别对应 `codebuddy` / `codebuddy-cn` 两个 worker，不能共用一个键。

## Antigravity

`POST https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`，
先 `loadCodeAssist` 取 `projectId` 与 tier 名。每模型
`quotaInfo.remainingFraction` × 100 作为剩余百分比。直连不可达，走
`AGENTHUB_QUOTA_PROXY`（默认 `http://127.0.0.1:7890`）CONNECT 隧道。

## MiniMax Code

`GET /minimax-cloud/api/v1/signin/status`（签到面板）。Code 产品线没有「额度条」，
可量化余额就是签到积分，取 `today.points + today.bonus_points` 作为今日额度。
`/coding_plan/remains` 与 `/token_plan/remains` 也会尝试，但 mcode 的 token 是
`audience=agent-backend`，打开放平台通常 401。

## 暂无可读配额的渠道

| worker | 情况 |
|---|---|
| `mimocode` | 小米 MiMo，官方无公开配额端点 |
| `zcode` | GLM Coding Plan；端点 `/api/monitor/usage/quota/limit` 存在，但当前账号不返回数据 |
| `github-copilot` | 仅 `premium_interactions` 有真实额度；令牌在系统 keyring，暂不直读 |
| `meoo` / `workbuddy` | 未接入 |

这些渠道不会显示假数字：胶囊退化成「已接入」占位，真实原因（凭据状态 / 上游
未返回）写在 tooltip 与配额浮层里。

---

## 排查清单

```bash
cd ~/agent-hub-console

# 全量（会真实打上游，注意限速）
curl -s "http://127.0.0.1:8890/api/quotas?force=1" | python3 -m json.tool

# 单个 worker 的原始返回（绕开 60s 缓存）
node -e "import('./miniapp/node/vendor-quota.mjs').then(async m => console.log(JSON.stringify(await m.getQuota('qoder', { force: true }), null, 2)))"
```

- 数字为 0 / `remaining: undefined` → 上游只给了 `used/total`，属正常兜底路径。
- `plan` 有值但 `quotas` 缺失 → 凭据在线、上游未给额度明细，看 `message`。
- `HTTP 401` → 令牌问题；Qoder 看 UMID 组件是否缺失（`~/.qoder*/` 下），
  Trae 看 token-cache 是否被轮换掉。
