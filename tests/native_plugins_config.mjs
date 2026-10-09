import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { pluginEnvironment } from '../integrations/codex/scripts/config.mjs';

test('native Codex plugin settings configure a filtered MCP environment', async () => {
  const directory = await mkdtemp(join(os.tmpdir(), 'agenthub-native-settings-'));
  try {
    const file = join(directory, 'agenthub.json');
    await writeFile(file, JSON.stringify({ url: 'http://127.0.0.1:18443/mcp', token: 'synthetic-fixture' }));
    const env = await pluginEnvironment({ PLUGIN_DATA: directory });
    assert.equal(env.AGENTHUB_URL, 'http://127.0.0.1:18443/mcp');
    assert.equal(env.HUB_TOKEN, 'synthetic-fixture');
    const explicit = await pluginEnvironment({ PLUGIN_DATA: directory, HUB_MCP_URL: 'http://127.0.0.1:18444/mcp', HUB_TOKEN: '' });
    assert.equal(explicit.AGENTHUB_URL, undefined);
    assert.equal(explicit.HUB_TOKEN, '');
    await writeFile(file, '{"token":"synthetic-private-fixture",');
    await assert.rejects(pluginEnvironment({ PLUGIN_DATA: directory }), (error) => !error.message.includes('synthetic-private-fixture'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
