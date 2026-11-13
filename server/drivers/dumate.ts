// 百度搭子 DuMate（FEAT-dumate）：OMB 原生聊天驱动，模型走 DuMate 云端网关（OpenAI 兼容）。
//
// 凭据链：日常页扫码登录存下的百度 cookie（server/checkin/dumate.mjs，~/.agenthub/dumate-accounts.json）
//   → GET www.dumate.cn/api/dumate/app/token/get 换网关 token（有效期由上游 expired_at 给出，提前 5 分钟换新）
//   → POST https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions，Authorization: Bearer <token>。
// 消耗的是账号自己的 DuMate 积分。没有 CLI、没有 BYOK：模型只经 OMB 这一处注入（铁律）。
// 网关没有 /models（实测 401/404），模型表是 dumate2api 2026-11-06 个人版真机实测通过的云端路由名。
import { z } from "zod";

import type { ModelCatalog, ProviderDriver, ProviderSnapshot } from "../contracts.ts";
import {
  balanceText, forgetDumateToken, gatewayToken, GATEWAY_URL, loadStore, markDumateExpired, maskName, quotaOverview,
  RELOGIN_HINT, type DumateAccount,
} from "../checkin/dumate.mjs";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

const DRIVER_KIND = "dumate";
/** 占位 key：真正的 Bearer 每次请求由 dumateFetch 换上；它只用来让通用运行时认为「已配置」。 */
const PLACEHOLDER_KEY = "dumate-gateway-token";
const SNAPSHOT_TTL_MS = 5 * 60_000;

export const DUMATE_MODELS: ModelCatalog = {
  default: "model-text",
  options: [
    { id: "model-text", label: "DuMate 智能路由（model-text）", contextWindow: 192_000 },
    { id: "kimi-k31", label: "Kimi K3.1", contextWindow: 256_000 },
    { id: "glm-53", label: "GLM-5.3", contextWindow: 200_000 },
    { id: "glm-53-flash", label: "GLM-5.3 Flash", contextWindow: 200_000 },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", contextWindow: 128_000 },
    { id: "deepseek-v41-flash", label: "DeepSeek V4.1 Flash", contextWindow: 128_000 },
    { id: "qwen38-flash", label: "Qwen 3.8 Flash", contextWindow: 128_000 },
  ],
};

export const NOT_SIGNED_IN = "还没登录百度搭子：到「设置 → 日常」的百度搭子卡片点「扫码登录」，用百度 App 扫码。";

const configSchema = z.object({
  /** 用哪个已登录的 DuMate 账号（dumate-accounts.json 的 id）；不填用第一个没掉线的。 */
  account: z.string().trim().min(1).max(64).optional(),
  tools: z.boolean().optional(),
}).passthrough();
export type DumateConfig = { account?: string; tools?: boolean };

export function decodeDumateConfig(raw: unknown): DumateConfig {
  const parsed = configSchema.parse(raw ?? {});
  return { ...(parsed.account ? { account: parsed.account } : {}), ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}) };
}

/** 上游的「积分不足」各种说法（中文文案、402、英文 insufficient）。 */
const POINTS_SHORT = /(积分|余额|额度|点数)[^\n]{0,8}(不足|耗尽|用完|已用尽)|insufficient[^\n]{0,20}(credit|balance|quota|points)/i;

export function pointsShort(status: number, body: string): boolean {
  return status === 402 || POINTS_SHORT.test(body);
}

const errorBody = (message: string) => JSON.stringify({ error: { message, type: "dumate_error" } });
const synthetic = (status: number, message: string) =>
  new Response(errorBody(message), { status, headers: { "content-type": "application/json" } });

/** 账号顺序：配置指定的在前，其余没掉线的按存储顺序；积分不足时依次换下一个。 */
export function accountOrder(accounts: DumateAccount[], preferred?: string): DumateAccount[] {
  const live = accounts.filter((a) => a.expired !== true);
  const first = preferred ? accounts.find((a) => a.id === preferred) : undefined;
  return first ? [first, ...live.filter((a) => a.id !== first.id)] : live;
}

export interface DumateDeps {
  loadStore: typeof loadStore;
  gatewayToken: typeof gatewayToken;
  forgetToken: typeof forgetDumateToken;
  markExpired: typeof markDumateExpired;
  quotaOverview: typeof quotaOverview;
  fetch: typeof fetch;
  now: () => number;
}

const defaultDeps = (): DumateDeps => ({
  loadStore, gatewayToken, forgetToken: forgetDumateToken, markExpired: markDumateExpired, quotaOverview,
  fetch: (url, init) => fetch(url, init), now: () => Date.now(),
});

/** 每个请求换上该账号当前的网关 token；token 被拒强刷一次；积分不足换下一个账号；掉线标 expired 并给出重登提示。 */
export function createDumateFetch(config: DumateConfig, deps: DumateDeps) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    const { accounts } = await deps.loadStore();
    if (!accounts.length) return synthetic(401, NOT_SIGNED_IN);
    const order = accountOrder(accounts, config.account);
    if (!order.length) return synthetic(401, RELOGIN_HINT);
    let lastShort = "";
    for (const account of order) {
      const send = (token: string) => {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${token}`);
        headers.set("x-dumate-client-type", "web");
        headers.set("x-dumate-account-id", "global");
        return deps.fetch(url, { ...init, headers });
      };
      let token = await deps.gatewayToken(account);
      if (!token.ok) {
        if (token.expired) { if (order.length === 1) return synthetic(401, RELOGIN_HINT); continue; }
        return synthetic(502, `DuMate 换网关 token 失败：${token.error}`);
      }
      let response = await send(token.token);
      if (response.status === 401) {
        // 本地还没到 expired_at，服务端先作废了（同号别处登录会顶掉旧票）：强刷一次再试
        await response.body?.cancel().catch(() => {});
        deps.forgetToken(account.id);
        token = await deps.gatewayToken(account, { force: true });
        if (!token.ok) { if (token.expired && order.length > 1) continue; return synthetic(401, token.expired ? RELOGIN_HINT : `DuMate 换网关 token 失败：${token.error}`); }
        response = await send(token.token);
      }
      if (response.ok) return response;
      const body = await response.text().catch(() => "");
      if (pointsShort(response.status, body)) {
        lastShort = `${maskName(account.name || account.uid || account.id)}：${body.replace(/\s+/g, " ").slice(0, 200)}`;
        continue;
      }
      return new Response(body, { status: response.status, headers: response.headers });
    }
    if (lastShort) return synthetic(402, `DuMate 积分不足（insufficient credits）——明天签到可领每日积分。${lastShort}`);
    return synthetic(401, RELOGIN_HINT);
  };
}

export function createDumateDriver(overrides: Partial<DumateDeps> = {}): ProviderDriver<DumateConfig> {
  return {
    driverKind: DRIVER_KIND,
    metadata: { displayName: "百度搭子 DuMate", supportsMultipleInstances: true, access: "subscription" },
    install: {
      docsUrl: "https://cloud.baidu.com/doc/Dumate/index.html",
      signInCommand: "到「设置 → 日常」的百度搭子卡片点「扫码登录」，用百度 App 扫码（登录在共享浏览器里完成）。",
    },
    decodeConfig: decodeDumateConfig,
    defaultConfig: () => decodeDumateConfig({}),
    models: DUMATE_MODELS,
    async create(input) {
      const deps: DumateDeps = { ...defaultDeps(), ...overrides };
      const config = input.config;
      const runtime = createOpenAIChatRuntime({
        input, driverKind: DRIVER_KIND, apiKey: PLACEHOLDER_KEY, apiUrl: GATEWAY_URL,
        tools: config.tools, models: () => DUMATE_MODELS,
        requestBody: (model, messages, stream) => ({
          model, messages, stream, ...(stream ? { stream_options: { include_usage: true } } : {}),
        }),
        fetch: createDumateFetch(config, deps),
        httpErrorLabel: "DuMate",
        missingKeyError: NOT_SIGNED_IN,
        unavailableReason: NOT_SIGNED_IN,
        timeoutMs: 180_000, reasoning: true, includeUsageInCompleted: true,
        // E104: the gateway can stream a whole draft as reasoning, no content, and end with [DONE] but no finish_reason.
        reasoningAsReply: false, requireFinishReason: true,
        // E105: work in the bot's folder on this computer like other chat engines; the gateway's image support is unknown.
        computerUse: true, workdirTools: true, imageInput: () => false,
        noBodyError: "DuMate 网关没有返回内容",
        nativeLog: {
          source: "dumate.chat.completions",
          outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
          incoming: ({ text, reasoning, usage }) => ({ textLength: text.length, reasoningLength: reasoning.length, usage }),
        },
      });
      let cached: { at: number; snapshot: ProviderSnapshot } | undefined;
      // 登录态与余额：换掉通用运行时只看「有没有 key」的快照（这里的 key 是占位符，永远「有」）。
      runtime.snapshot = async (): Promise<ProviderSnapshot> => {
        const now = deps.now();
        if (cached && now - cached.at < SNAPSHOT_TTL_MS) return cached.snapshot;
        const { accounts } = await deps.loadStore();
        let snapshot: ProviderSnapshot;
        const account = accountOrder(accounts, config.account)[0];
        if (!accounts.length) snapshot = { state: "unavailable", authenticated: false, reason: NOT_SIGNED_IN };
        else if (!account) snapshot = { state: "unavailable", authenticated: false, reason: RELOGIN_HINT };
        else {
          const q = await deps.quotaOverview(account.cookie).catch(() => null);
          if (q && !q.ok && q.expired) {
            await deps.markExpired(account.id, true).catch(() => {});
            snapshot = { state: "unavailable", authenticated: false, reason: RELOGIN_HINT };
          } else {
            const balance = q && q.ok ? balanceText(q) : "";
            snapshot = {
              state: "available", authenticated: true, version: null, billing: "subscription",
              account: { email: account.name || maskName(account.uid || account.id), ...(balance ? { organization: balance } : {}), method: "login" },
            };
          }
        }
        // 未登录时不缓存：扫完码立刻能用
        if (snapshot.state === "available") cached = { at: now, snapshot };
        else cached = undefined;
        return snapshot;
      };
      return runtime;
    },
  };
}

export const DumateDriver = createDumateDriver();
