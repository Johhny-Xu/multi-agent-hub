#!/usr/bin/env node
// Read-only Qoder CN reconciliation: compare the console's stored state with the
// actual CLAIM_BENEFIT row returned by upstream. Never claims, never prints tokens.
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const NODE_DIR = process.env.QODER_NODE_DIR || '/home/johhny/agent-hub-console/miniapp/node';
const { readQoderCredentialAt, listQoderCampaigns } = await import(pathToFileURL(join(NODE_DIR, 'qoder.mjs')).href);
const { resolveQoderDevice } = await import(pathToFileURL(join(NODE_DIR, 'qoder-device.mjs')).href);

const HOME = process.env.AGENTHUB_HOME || homedir();
const STATE_FILE = process.env.AGENTHUB_CHECKIN_STATE || join(HOME, '.agenthub', 'checkin-state.json');
const ACCOUNT_ROOT = process.env.QODER_CN_ACCOUNT_ROOT || join(HOME, '.agenthub', 'accounts', 'qoder-cn');
const nowSec = Math.floor(Date.now() / 1000);

const epoch = (value) => {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  const p = Date.parse(String(value));
  return Number.isFinite(p) ? Math.floor(p / 1000) : 0;
};

const state = JSON.parse(await readFile(STATE_FILE, 'utf-8')).platforms?.['qoder-cn'] || {};
const stateRows = Array.isArray(state.accounts) ? state.accounts : [];

const targets = [{ name: 'live', dir: join(HOME, '.qoder-cn') }];
try {
  for (const entry of await readdir(ACCOUNT_ROOT, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      targets.push({ name: entry.name, dir: join(ACCOUNT_ROOT, entry.name) });
    }
  }
} catch { /* no archive */ }

const byIdentity = new Map();
for (const target of targets) {
  const cred = await readQoderCredentialAt(target.dir, 'qoder-cn');
  if (!cred.ok || !cred.primary) continue;
  const identity = String(cred.primary.identity || target.name);
  if (!byIdentity.has(identity) || target.name === 'live') {
    byIdentity.set(identity, { ...target, entry: cred.primary });
  }
}

const accounts = [];
for (const [identity, target] of byIdentity) {
  const entry = target.entry;
  const uid = String(entry.user?.id || entry.user?.uid || entry.user?.userId || '');
  let device = null;
  try { device = await resolveQoderDevice('qoder-cn', { home: HOME, uid }); } catch { /* keep null */ }
  const res = await listQoderCampaigns('qoder-cn', entry.token, device);
  const rows = Array.isArray(res?.json?.data) ? res.json.data
    : Array.isArray(res?.json?.campaigns) ? res.json.campaigns : [];
  const benefits = rows.filter((row) => String(row?.actionType || row?.action_type || '').toUpperCase() === 'CLAIM_BENEFIT');
  const inWindow = benefits.find((row) => {
    const start = epoch(row?.startAt ?? row?.start_at);
    const end = epoch(row?.endAt ?? row?.end_at);
    return start <= nowSec && nowSec < end;
  });
  const row = inWindow || benefits.sort((a, b) => epoch(b?.endAt ?? b?.end_at) - epoch(a?.endAt ?? a?.end_at))[0] || null;
  const actual = String(row?.claimStatus || row?.claim_status || '').toUpperCase();
  const stored = stateRows.find((item) => item.identity === identity)
    || stateRows.find((item) => item.name === target.name)
    || stateRows.find((item) => item.name === entry.display)
    || null;
  const storedStatus = String(stored?.status || '');
  const mismatch = Boolean(row) && ['success', 'already'].includes(storedStatus)
    && !['CLAIMED', 'GRANTED'].includes(actual);
  accounts.push({
    name: stored?.name || target.name,
    identity,
    storedStatus,
    storedCredits: stored?.credits ?? 0,
    actualClaimStatus: actual,
    campaignKey: row?.campaignKey || row?.campaign_key || '',
    startsAt: row ? new Date(epoch(row?.startAt ?? row?.start_at) * 1000).toISOString() : '',
    endsAt: row ? new Date(epoch(row?.endAt ?? row?.end_at) * 1000).toISOString() : '',
    mismatch,
  });
}

const mismatches = accounts.filter((item) => item.mismatch);
console.log(JSON.stringify({
  ok: true,
  checkedAt: new Date(nowSec * 1000).toISOString(),
  platform: {
    lastDate: state.lastDate || '',
    lastTime: state.lastTime || '',
    status: state.status || '',
    message: state.message || '',
    credits: state.credits ?? 0,
  },
  accounts,
  mismatches,
}, null, 2));
