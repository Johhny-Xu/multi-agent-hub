// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = await mkdtemp(join(tmpdir(), 'agenthub-cb-checkin-'));
process.env.AGENTHUB_HOME = tempHome;
process.env.AGENTHUB_CHECKIN_STATE = join(tempHome, 'checkin-state.json');

const { checkinCodeBuddy, runCheckin, getCheckinOverview, listCheckinAccounts } = await import('../console/checkin.mjs');

test('checkinCodeBuddy returns unconfigured when no credential exists', async () => {
  const res = await checkinCodeBuddy();
  assert.equal(res.ok, false);
  assert.equal(res.status, 'unconfigured');
  assert.ok(res.message.includes('未检测到 CodeBuddy 国际版登录凭据'));
});

test('checkinCodeBuddy succeeds when model call succeeds (mock hook)', async () => {
  // 配置一个临时 ~/.codebuddy/auth.info
  const cbDir = join(tempHome, '.codebuddy');
  await mkdir(cbDir, { recursive: true });
  await writeFile(join(cbDir, 'auth.info'), JSON.stringify({
    auth: {
      accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyMTIzIiwibmlja25hbWUiOiJUZXN0VXNlciIsImV4cCI6OTk5OTk5OTk5OX0.abc',
      refreshToken: 'fake_refresh_token',
      domain: 'www.codebuddy.ai'
    }
  }));

  // 启用测试钩子模拟调用模型发你好成功
  process.env.CODEBUDDY_CHECKIN_MOCK_SUCCESS = '1';
  try {
    const res = await checkinCodeBuddy();
    assert.equal(res.ok, true);
    assert.equal(res.status, 'success');
    assert.ok(res.message.includes('已调用模型发你好'));
    assert.equal(res.accounts.length, 1);
    assert.equal(res.accounts[0].status, 'success');
  } finally {
    delete process.env.CODEBUDDY_CHECKIN_MOCK_SUCCESS;
  }
});

test('runCheckin("codebuddy") integrates with overview and history', async () => {
  process.env.CODEBUDDY_CHECKIN_MOCK_SUCCESS = '1';
  try {
    const res = await runCheckin('codebuddy');
    assert.equal(res.ok, true);
    assert.ok(res.results.codebuddy);
    assert.equal(res.results.codebuddy.status, 'success');

    const overview = await getCheckinOverview();
    assert.ok(overview.platforms.codebuddy);
    assert.equal(overview.platforms.codebuddy.available, true);
    assert.equal(overview.platforms.codebuddy.status, 'success');
    assert.ok(overview.history.some((h) => h.platform === 'codebuddy' && h.status === 'success'));
  } finally {
    delete process.env.CODEBUDDY_CHECKIN_MOCK_SUCCESS;
  }
});
