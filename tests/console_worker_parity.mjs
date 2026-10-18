// 控制台登录表与账号档案表的覆盖一致性：
// WebUI 会把 hub_status 里的每个 worker 都放进「登录 / 添加账号」下拉，缺任一项 UI 就报「不支持的 worker」。
import assert from 'node:assert/strict';
import test from 'node:test';

const { LOGIN_COMMANDS, parseClineAuthInput, parseOpencodeAuthInput } = await import('../console/auth.mjs');
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
  // cline 走官方 TUI 的设备码授权（链接+验证码直接进面板），API Key 作为同一会话的备选输入
  assert.equal(LOGIN_COMMANDS.cline.mode, 'pty_device');
  assert.equal(LOGIN_COMMANDS.cline.ptyAutoEnter, true);
  assert.ok(Array.isArray(LOGIN_COMMANDS.cline.cmd) && LOGIN_COMMANDS.cline.cmd.includes('auth'));
  assert.equal(LOGIN_COMMANDS.cline.needsCallbackInput, true);
  // 凭据文件必须指向官方 CLI 自己的落盘位置
  assert.deepEqual(WORKER_CRED_FILES.opencode, ['.local/share/opencode/auth.json']);
  assert.deepEqual(WORKER_CRED_FILES.cline, ['.cline/data/secrets.json', '.cline/data/settings/providers.json']);
});

// 用户在 WebUI 里最常见的行为就是直接粘一把 Key；这条路径不允许报「格式错误」
// 夹具故意分段拼接：合成串不该被 scripts/audit_secrets.py 的 provider_key 规则当成真实凭据。
test('cline accepts a bare api key and infers the provider', () => {
  const anthropic = parseClineAuthInput('sk-ant-' + 'api03-abcdefghijklmn');
  assert.equal(anthropic.ok, true);
  assert.equal(anthropic.provider, 'anthropic');
  assert.equal(anthropic.inferred, true);

  const openrouter = parseClineAuthInput('sk-or-' + 'v1-0123456789abcdef');
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

// 用户明确要求：API Key 登录不许再做格式校验把人挡在外面，
// 猜不中厂商就落默认值 + 提示，真正的对错交给官方 CLI 返回。
test('cline never blocks on key format', () => {
  const unknown = parseClineAuthInput('zzz-not-a-key');
  assert.equal(unknown.ok, true);
  assert.equal(unknown.provider, 'openai');
  assert.match(unknown.note, /厂商|openai/);

  const shortKey = parseClineAuthInput('sk-1');
  assert.equal(shortKey.ok, true);
  assert.equal(shortKey.apiKey, 'sk-1');

  // 复制时被换行打断的 Key 拼回一个整体，不会把前半段当成 provider
  const wrapped = parseClineAuthInput('sk-ant-' + 'abc\n  defgh');
  assert.equal(wrapped.provider, 'anthropic');
  assert.equal(wrapped.apiKey, 'sk-ant-abcdefgh');

  // 真的什么都没填才报错
  assert.equal(parseClineAuthInput('   ').ok, false);
});

test('opencode accepts a bare api key and infers the provider', () => {
  const zen = parseOpencodeAuthInput('oc_sk_' + 'abcdef0123456789');
  assert.equal(zen.ok, true);
  assert.equal(zen.provider, 'opencode');
  assert.equal(zen.apiKey, 'oc_sk_abcdef0123456789');

  assert.equal(parseOpencodeAuthInput('sk-ant-' + 'api03-abcdefghijklmn').provider, 'anthropic');
  assert.equal(parseOpencodeAuthInput('sk-or-' + 'v1-0123456789abcdef').provider, 'openrouter');
  assert.equal(parseOpencodeAuthInput('gsk_' + '0123456789abcdef').provider, 'groq');
});

test('opencode never blocks: unknown prefix falls back with a notice', () => {
  const unknown = parseOpencodeAuthInput('zzz-not-a-key');
  assert.equal(unknown.ok, true);
  assert.equal(unknown.provider, 'opencode');
  assert.match(unknown.note, /默认 provider/);

  // sk- 属通用前缀，不硬猜，提示可改成 siliconflow 重贴
  const skKey = parseOpencodeAuthInput('sk-' + '0123456789abcdef');
  assert.equal(skKey.ok, true);
  assert.match(skKey.note, /siliconflow/);

  // provider:key 原样采用
  assert.deepEqual(
    (({ provider, apiKey }) => ({ provider, apiKey }))(parseOpencodeAuthInput('siliconflow:sk-1234567890')),
    { provider: 'siliconflow', apiKey: 'sk-1234567890' },
  );
  // provider key 空格形式
  assert.equal(parseOpencodeAuthInput('anthropic sk-ant-1234567890').provider, 'anthropic');
  // 被换行打断的同一个 Key 不被误判成 provider + key
  const wrapped = parseOpencodeAuthInput('oc_sk_' + 'abcdef\n  0123456789');
  assert.equal(wrapped.provider, 'opencode');
  assert.equal(wrapped.apiKey, 'oc_sk_abcdef0123456789');

  // 空输入、回调链接才拦（写进 auth.json 只会得到无效凭据）
  assert.equal(parseOpencodeAuthInput('').ok, false);
  const url = parseOpencodeAuthInput('https://opencode.ai/auth/callback?code=abc123');
  assert.equal(url.ok, false);
  assert.match(url.error, /providers login/);
});

test('cline falls back to a documented default model per provider', async () => {
  const { clineDefaultModel } = await import('../console/auth.mjs');
  assert.equal(clineDefaultModel('anthropic'), 'claude-sonnet-4-6');
  assert.equal(clineDefaultModel('OpenAI'), 'gpt-5');
  assert.equal(clineDefaultModel('siliconflow'), '');
});

test('provider-set display names never bake in a bogus count', async () => {
  const { formatProvidersDisplay, isMutableIdentity } = await import('../console/accounts.mjs');
  // 单提供方不带任何后缀：旧实现会写成「opencode (1 个提供方)」，读起来自相矛盾
  assert.equal(formatProvidersDisplay(['opencode']), 'opencode');
  assert.equal(formatProvidersDisplay(['siliconflow']), 'siliconflow');
  // opencode 优先当主名，其余并列展开；多个 provider 时补「几把 Key」避免用户以为丢了一个
  assert.equal(formatProvidersDisplay(['siliconflow', 'opencode']), 'opencode + siliconflow（2 把 Key）');
  assert.equal(formatProvidersDisplay(['a', 'opencode', 'b']), 'opencode + a + b（3 把 Key）');
  assert.equal(formatProvidersDisplay(['a', 'opencode', 'b', 'c']), 'opencode 等 4 个 provider（4 把 Key）');
  assert.equal(formatProvidersDisplay([]), 'provider');

  // 可变异身份 = 描述的是「这份凭据文件」而不是独立账号，只用来判定历史快照
  assert.equal(isMutableIdentity('providers:opencode'), true);
  assert.equal(isMutableIdentity('mmx:cn'), true);
  assert.equal(isMutableIdentity('5cc0eb9e0749'), true);
  // 稳定身份不一致代表真的是另一个账号，绝不能被当成快照收起
  assert.equal(isMutableIdentity('someone@example.com'), false);
  assert.equal(isMutableIdentity('uid-123456'), false);
  assert.equal(isMutableIdentity(''), false);
});
