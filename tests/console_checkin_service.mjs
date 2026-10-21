// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPEN_SOURCE_PROJECTS,
  detectCredentials,
  getCheckinOverview,
  listCheckinAccounts,
  runCheckin,
  updateCheckinConfig
} from '../console/checkin.mjs';

test('checkin open source projects catalog covers all three platforms', () => {
  assert.ok(OPEN_SOURCE_PROJECTS.workbuddy.length >= 2, 'WorkBuddy has open source projects');
  assert.ok(OPEN_SOURCE_PROJECTS.traecode.length >= 2, 'Trae has open source projects');
  assert.ok(OPEN_SOURCE_PROJECTS.codearts.length >= 2, 'CodeArts has open source projects');

  // Verify key projects exist
  const wbNames = OPEN_SOURCE_PROJECTS.workbuddy.map(p => p.name);
  assert.ok(wbNames.some(n => n.includes('workbuddy')), 'Contains workbuddy checkin project');

  const traeNames = OPEN_SOURCE_PROJECTS.traecode.map(p => p.name);
  assert.ok(traeNames.some(n => n.includes('TraeTools') || n.includes('trae-daily-checkin')), 'Contains Trae checkin tool');

  const caNames = OPEN_SOURCE_PROJECTS.codearts.map(p => p.name);
  assert.ok(caNames.some(n => n.includes('CodeArts2API') || n.includes('codearts')), 'Contains CodeArts checkin project');

  assert.ok(Array.isArray(OPEN_SOURCE_PROJECTS.qoder) && OPEN_SOURCE_PROJECTS.qoder.length >= 2, 'Qoder has open source projects');
  const qdNames = OPEN_SOURCE_PROJECTS.qoder.map(p => p.name);
  assert.ok(qdNames.some(n => n.includes('qoder')), 'Contains Qoder checkin project');
});

test('detectCredentials returns structured results for targets', async () => {
  const creds = await detectCredentials();
  assert.ok('workbuddy' in creds);
  assert.ok('traecode' in creds);
  assert.ok('codearts' in creds);
  assert.ok('qoder' in creds);
  assert.ok('qoder-cn' in creds);
  assert.equal(typeof creds.traecode.available, 'boolean');
});

test('getCheckinOverview provides state, history and open source references', async () => {
  const overview = await getCheckinOverview();
  assert.equal(overview.ok, true);
  assert.ok(overview.today);
  assert.ok(overview.platforms.workbuddy);
  assert.ok(overview.platforms.traecode);
  assert.ok(overview.platforms.codearts);
  assert.ok(overview.platforms.qoder);
  assert.ok(overview.platforms['qoder-cn']);
  assert.ok(Array.isArray(overview.history));
  assert.ok(overview.openSourceProjects);
});

test('updateCheckinConfig updates auto-checkin settings', async () => {
  const res = await updateCheckinConfig({ autoCheckin: true });
  assert.equal(res.ok, true);
  assert.equal(res.overview.autoCheckin, true);
});

test('runCheckin handles platform calls without throwing fatal crashes', async () => {
  // Test executing single platform (even if token expired/missing, returns graceful error object)
  const res = await runCheckin('traecode');
  assert.equal(res.ok, true);
  assert.ok(res.results.traecode);
  assert.equal(typeof res.results.traecode.ok, 'boolean');
});

test('every platform can enumerate its check-in accounts', async () => {
  for (const platform of ['workbuddy', 'traecode', 'codearts', 'qoder', 'qoder-cn']) {
    const list = await listCheckinAccounts(platform);
    assert.ok(Array.isArray(list), `${platform} returns an array`);
    for (const acct of list) {
      assert.equal(typeof acct.name, 'string', `${platform} account name`);
      assert.ok(acct.display, `${platform} account display`);
      assert.equal(typeof acct.active, 'boolean', `${platform} active flag`);
    }
    // 同一身份不能因为有多份历史快照就被算成两个账号
    const ids = list.filter((a) => a.identity).map((a) => a.identity);
    assert.equal(new Set(ids).size, ids.length, `${platform} accounts are de-duplicated by identity`);
  }
});

test('overview surfaces per-account rows so the UI can list multiple accounts', async () => {
  const overview = await getCheckinOverview();
  for (const platform of ['workbuddy', 'traecode', 'codearts', 'qoder', 'qoder-cn']) {
    assert.ok(Array.isArray(overview.platforms[platform].accounts), `${platform} has an accounts array`);
    for (const row of overview.platforms[platform].accounts) {
      assert.equal(typeof row.display, 'string');
      assert.ok(['success', 'already', 'failed', 'expired', 'pending'].includes(row.status), `${platform} row status: ${row.status}`);
    }
  }
});
