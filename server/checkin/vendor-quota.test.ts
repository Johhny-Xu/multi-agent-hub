// E66: /hub/quota 在没有外部控制台（8890 已关）时兜底 import server/checkin/vendor-quota.mjs 取 getAllQuotas。
// 0146 没有仓库顶层 checkin/，这份必须是完整版（含 getAllQuotas），否则 8801 回 502 console_unreachable。
// 全部走临时 HOME、fetch 打桩、代理指向必拒端口：不读真凭据、不发外网请求。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, proxy: process.env.AGENTHUB_QUOTA_PROXY };
let home = '';

async function freshModule() {
  home = await mkdtemp(join(tmpdir(), 'vendor-quota-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.AGENTHUB_QUOTA_PROXY = 'http://127.0.0.1:9';
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline (test)'); }));
  vi.resetModules();
  return import('./vendor-quota.mjs');
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const [k, v] of [['HOME', saved.HOME], ['USERPROFILE', saved.USERPROFILE], ['AGENTHUB_QUOTA_PROXY', saved.proxy]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (home) await rm(home, { recursive: true, force: true });
  home = '';
});

describe('server/checkin/vendor-quota.mjs (E66)', () => {
  it('exports the quota API the /hub/quota fallback needs, plus the two helpers check-in uses', async () => {
    const vq = await freshModule();
    expect(typeof vq.getAllQuotas).toBe('function');
    expect(typeof vq.getQuota).toBe('function');
    expect(typeof vq.fetchJsonSmart).toBe('function');
    expect(typeof vq.hwsSdkSignedHeaders).toBe('function');
    expect(vq.QUOTA_WORKERS).toEqual(expect.arrayContaining(['zcode', 'codebuddy', 'codebuddy-cn', 'qoder', 'qoder-cn', 'antigravity']));
  });

  it('carries quota-deep.mjs alongside, so qoder / qoder-cn / traecode quotas load in a tree without checkin/', async () => {
    vi.resetModules();
    const deep = await import('./quota-deep.mjs');
    expect(typeof deep.getDeepQuota).toBe('function');
    expect(deep.isDeepQuotaWorker('qoder')).toBe(true);
    expect(deep.isDeepQuotaWorker('traecode')).toBe(true);
  });

  it('getAllQuotas answers one entry per worker with no credentials and no network, instead of throwing', async () => {
    const vq = await freshModule();
    const data = await vq.getAllQuotas({ force: true });
    expect(typeof data.updatedAt).toBe('string');
    expect(Object.keys(data.workers).sort()).toEqual([...vq.QUOTA_WORKERS].sort());
    for (const w of vq.QUOTA_WORKERS) expect(data.workers[w]).toBeTruthy();
  }, 60_000);

  it('normalizeQuotas turns a legacy object map into the array the quota page renders', async () => {
    const vq = await freshModule();
    const out = vq.normalizeQuotas({ daily: { used: 1, total: 10, remaining: 9 } });
    expect(Array.isArray(out)).toBe(true);
    expect(out[0]).toMatchObject({ name: 'daily', remaining: 9 });
  });
});
