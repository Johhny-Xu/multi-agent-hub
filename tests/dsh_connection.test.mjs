import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bridgeOptions } from '../integrations/dsh/index.js';
import { loadConnection } from '../mcp/config.mjs';

function ambient(values, action) {
  const keys = ['AGENTHUB_URL', 'HUB_MCP_URL', 'HUB_TOKEN'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
  try { return action(); }
  finally { for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; } }
}

test('explicit endpoint never acquires a token paired with another ambient or configured endpoint', () => {
  ambient({ AGENTHUB_URL: 'http://old.invalid/mcp', HUB_TOKEN: 'SYNTHETIC_OLD_TOKEN' }, () => {
    assert.equal(bridgeOptions({ url: 'http://new.invalid/mcp' }).env.HUB_TOKEN, '');
    assert.equal(bridgeOptions({ env: { AGENTHUB_URL: 'http://new.invalid/mcp' } }).env.HUB_TOKEN, '');
    assert.equal(bridgeOptions({ url: 'http://new.invalid/mcp', env: { AGENTHUB_URL: 'http://old.invalid/mcp', HUB_TOKEN: 'SYNTHETIC_OLD_TOKEN' } }).env.HUB_TOKEN, '');
    assert.equal(bridgeOptions({ url: 'http://new.invalid/mcp', token: 'SYNTHETIC_NEW_TOKEN' }).env.HUB_TOKEN, 'SYNTHETIC_NEW_TOKEN');
    assert.equal(bridgeOptions({ url: 'http://new.invalid/mcp', env: { HUB_TOKEN: 'SYNTHETIC_EXPLICIT_TOKEN' } }).env.HUB_TOKEN, 'SYNTHETIC_EXPLICIT_TOKEN');
  });
});

test('matching endpoint permits its explicit inherited token and legacy paired environment', () => {
  ambient({ AGENTHUB_URL: 'http://same.invalid', HUB_TOKEN: 'SYNTHETIC_SAME_TOKEN' }, () => {
    assert.equal(bridgeOptions({ url: 'http://same.invalid/mcp' }).env.HUB_TOKEN, 'SYNTHETIC_SAME_TOKEN');
    assert.equal(bridgeOptions().env.HUB_TOKEN, 'SYNTHETIC_SAME_TOKEN');
    assert.equal(bridgeOptions({ env: { AGENTHUB_URL: 'http://same.invalid/mcp', HUB_TOKEN: 'SYNTHETIC_CONFIG_TOKEN' } }).env.HUB_TOKEN, 'SYNTHETIC_CONFIG_TOKEN');
  });
  ambient({ AGENTHUB_URL: 'invalid ambient URL', HUB_TOKEN: 'SYNTHETIC_OLD_TOKEN' }, () => {
    assert.equal(bridgeOptions({ url: 'http://new.invalid/mcp' }).env.HUB_TOKEN, '');
  });
});

test('explicit external file wins over stale inherited URL and token without copying credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agenthub-dsh-file-'));
  try {
    const file = join(directory, 'client.json');
    await writeFile(file, JSON.stringify({ url: 'http://new.invalid/mcp', token: 'SYNTHETIC_FILE_TOKEN' }));
    const options = ambient({ AGENTHUB_URL: 'http://old.invalid/mcp', HUB_TOKEN: 'SYNTHETIC_OLD_TOKEN' }, () => bridgeOptions({ env: { AGENTHUB_CONFIG: file, CUSTOM: 'preserved' } }));
    assert.equal(options.env.AGENTHUB_CONNECTION_MODE, 'file');
    assert.equal(options.env.CUSTOM, 'preserved');
    assert.equal(options.env.HUB_TOKEN, undefined);
    const loaded = await loadConnection({ AGENTHUB_URL: 'http://old.invalid/mcp', HUB_TOKEN: 'SYNTHETIC_OLD_TOKEN', ...options.env });
    assert.equal(loaded.url, 'http://new.invalid/mcp');
    assert.equal(loaded.token, 'SYNTHETIC_FILE_TOKEN');
    assert.throws(() => bridgeOptions({ url: 'http://other.invalid/mcp', env: options.env }), /not both/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('stable explicit Node command survives and default does not use Electron executable', () => {
  assert.equal(bridgeOptions().command, 'node');
  assert.equal(bridgeOptions({ command: 'C:/Stable Node/node.exe' }).command, 'C:/Stable Node/node.exe');
  assert.throws(() => bridgeOptions({ token: 'SYNTHETIC\nTOKEN' }), /single-line/);
});
