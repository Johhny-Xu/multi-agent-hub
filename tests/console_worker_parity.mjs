// 控制台登录表与账号档案表的覆盖一致性：
// WebUI 会把 hub_status 里的每个 worker 都放进「登录 / 添加账号」下拉，缺任一项 UI 就报「不支持的 worker」。
import assert from 'node:assert/strict';
import test from 'node:test';

const { LOGIN_COMMANDS, parseClineAuthInput } = await import('../console/auth.mjs');
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

// 用户在 WebUI 里最常见的行为就是直接粘一把 Key；这条路径不允许报「格式错误」
test('cline accepts a bare api key and infers the provider', () => {
  const anthropic = parseClineAuthInput('sk-ant-api03-abcdefghijklmn');
  assert.equal(anthropic.ok, true);
  assert.equal(anthropic.provider, 'anthropic');
  assert.equal(anthropic.inferred, true);

  const openrouter = parseClineAuthInput('sk-or-v1-0123456789abcdef');
  assert.equal(openrouter.provider, 'openrouter');

  const compat = parseClineAuthInput('sk-0123456789abcdef');
  assert.equal(compat.ok, true);
  assert.equal(compat.provider, 'openai');
});

test('cline still honours explicit provider forms', () => {
  assert.deepEqual(
    (({ provider, model, apiKey, baseUrl, inferred }) => ({ provider, model, apiKey, baseUrl, inferred }))(
      parseClineAuthInput('anthropic|sk-ant-1234567890'),
    ),
    { provider: 'anthropic', model: '', apiKey: 'sk-ant-1234567890', baseUrl: '', inferred: false },
  );
  const full = parseClineAuthInput('siliconflow|deepseek-ai/DeepSeek-V3.2-Exp|sk-1234567890|https://api.siliconflow.cn/v1');
  assert.equal(full.provider, 'siliconflow');
  assert.equal(full.model, 'deepseek-ai/DeepSeek-V3.2-Exp');
  assert.equal(full.baseUrl, 'https://api.siliconflow.cn/v1');
  // 冒号形式不能被 sk- 开头的 Key 误判成 provider
  assert.equal(parseClineAuthInput('anthropic:sk-ant-1234567890').provider, 'anthropic');
  assert.equal(parseClineAuthInput('openai sk-1234567890').provider, 'openai');
});

test('cline rejects an unidentifiable or truncated key with a usable message', () => {
  const unknown = parseClineAuthInput('zzz-not-a-key');
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /provider/);
  const short = parseClineAuthInput('sk-1');
  assert.equal(short.ok, false);
  assert.match(short.error, /不完整/);
});

test('cline falls back to a documented default model per provider', async () => {
  const { clineDefaultModel } = await import('../console/auth.mjs');
  assert.equal(clineDefaultModel('anthropic'), 'claude-sonnet-4-6');
  assert.equal(clineDefaultModel('OpenAI'), 'gpt-5');
  assert.equal(clineDefaultModel('siliconflow'), '');
});
