// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPEN_SOURCE_PROJECTS,
  detectCredentials,
  getCheckinOverview,
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
});

test('detectCredentials returns structured results for targets', async () => {
  const creds = await detectCredentials();
  assert.ok('workbuddy' in creds);
  assert.ok('traecode' in creds);
  assert.ok('codearts' in creds);
  assert.equal(typeof creds.traecode.available, 'boolean');
});

test('getCheckinOverview provides state, history and open source references', async () => {
  const overview = await getCheckinOverview();
  assert.equal(overview.ok, true);
  assert.ok(overview.today);
  assert.ok(overview.platforms.workbuddy);
  assert.ok(overview.platforms.traecode);
  assert.ok(overview.platforms.codearts);
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
