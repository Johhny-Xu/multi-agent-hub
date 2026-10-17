// 控制台登录表与账号档案表的覆盖一致性：
// WebUI 会把 hub_status 里的每个 worker 都放进「登录 / 添加账号」下拉，缺任一项 UI 就报「不支持的 worker」。
import assert from 'node:assert/strict';
import test from 'node:test';

const { LOGIN_COMMANDS } = await import('../console/auth.mjs');
const { WORKER_CRED_FILES } = await import('../console/accounts.mjs');

const WORKERS = [
  'antigravity', 'codebuddy', 'codebuddy-cn', 'github-copilot', 'mimocode',
  'minimaxcode', 'traecode', 'zcode', 'codearts', 'opencode', 'cline',
];

test('login table and credential archive cover exactly the same eleven workers', () => {
  assert.deepEqual(Object.keys(LOGIN_COMMANDS).sort(), [...WORKERS].sort());
  assert.deepEqual(Object.keys(WORKER_CRED_FILES).sort(), [...WORKERS].sort());
});

test('every login entry carries a mode and instructions', () => {
  for (const worker of WORKERS) {
    const spec = LOGIN_COMMANDS[worker];
    assert.equal(typeof spec.mode, 'string', worker);
    assert.ok(spec.note && spec.note.length > 10, `${worker} needs a note`);
    assert.ok(Array.isArray(WORKER_CRED_FILES[worker]) && WORKER_CRED_FILES[worker].length > 0, worker);
  }
});

test('opencode and cline use their key-based flows', () => {
  assert.equal(LOGIN_COMMANDS.opencode.mode, 'opencode_key');
  assert.equal(LOGIN_COMMANDS.opencode.needsCallbackInput, true);
  assert.equal(LOGIN_COMMANDS.cline.mode, 'cline_key');
  assert.equal(LOGIN_COMMANDS.cline.needsCallbackInput, true);
  // 凭据文件必须指向官方 CLI 自己的落盘位置
  assert.deepEqual(WORKER_CRED_FILES.opencode, ['.local/share/opencode/auth.json']);
  assert.deepEqual(WORKER_CRED_FILES.cline, ['.cline/data/secrets.json', '.cline/data/settings/providers.json']);
});
