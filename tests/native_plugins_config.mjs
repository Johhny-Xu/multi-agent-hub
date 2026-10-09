import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
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
    const discoveryOnly = await pluginEnvironment({ PLUGIN_DATA: directory });
    assert.deepEqual(discoveryOnly, { PLUGIN_DATA: directory });
    assert.equal(await readFile(file, 'utf8'), '{"token":"synthetic-private-fixture",');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing, damaged or incomplete explicit connection keeps file binding and never falls back', async () => {
  const directory = await mkdtemp(join(os.tmpdir(), 'agenthub-native-discovery-settings-'));
  try {
    const file = join(directory, 'client.json');
    for (const content of [null, '{"token":"synthetic-private-fixture",', '{}', '{"token":"synthetic-private-fixture"}']) {
      if (content !== null) await writeFile(file, content);
      const env = await pluginEnvironment({ AGENTHUB_CONFIG: file, AGENTHUB_CONNECTION_MODE: 'file',
        AGENTHUB_URL: 'http://old.invalid/mcp', HUB_MCP_URL: 'http://other.invalid/mcp', HUB_TOKEN: 'SYNTHETIC_STALE_TOKEN' });
      assert.deepEqual(env, { AGENTHUB_CONFIG: file, AGENTHUB_CONNECTION_MODE: 'file' });
      if (content !== null) assert.equal(await readFile(file, 'utf8'), content);
      else await assert.rejects(readFile(file), { code: 'ENOENT' });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('actual Codex launcher exposes discovery with invalid file and rejects dispatch before network', async () => {
  const directory = await mkdtemp(join(os.tmpdir(), 'agenthub-native-discovery-stdio-'));
  try {
    const file = join(directory, 'client.json');
    for (const content of [null, '{"token":"SYNTHETIC_PRIVATE_CONFIG",', '{}', '{"token":"SYNTHETIC_PRIVATE_CONFIG"}']) {
      if (content !== null) await writeFile(file, content);
      const child = spawn(process.execPath, [fileURLToPath(new URL('../integrations/codex/scripts/start.mjs', import.meta.url))], {
        env: { ...process.env, AGENTHUB_CONFIG: file, AGENTHUB_CONNECTION_MODE: 'file',
          AGENTHUB_URL: 'http://stale.invalid/mcp', HUB_TOKEN: 'SYNTHETIC_STALE_TOKEN' },
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
      const lines = createInterface({ input: child.stdout });
      const pending = new Map();
      lines.on('line', raw => { const reply = JSON.parse(raw); const settle = pending.get(reply.id); if (settle) { pending.delete(reply.id); settle(reply); } });
      let id = 0;
      async function call(method, params = {}) {
        const requestId = ++id;
        const reply = new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Launcher fixture timed out')); }, 5000);
          pending.set(requestId, value => { clearTimeout(timer); resolve(value); });
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
        return reply;
      }
      try {
        assert.ok((await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })).result);
        const list = await call('tools/list');
        assert.equal(list.result.tools.length, 7);
        assert.ok(list.result.tools.some(tool => tool.name === 'hub_discover'));
        const refused = await call('tools/call', { name: 'hub_dispatch', arguments: { worker: 'mimo', task: 'invalid-connection fixture must not dispatch' } });
        const result = JSON.parse(refused.result.content[0].text);
        assert.equal(result.status, 'failed');
        assert.equal(result.ref, '');
        assert.match(result.answer, /SETUP_REQUIRED/);
        assert.ok(!JSON.stringify(refused).includes('SYNTHETIC_PRIVATE_CONFIG'));
        assert.ok(!stderr.includes('SYNTHETIC_PRIVATE_CONFIG'));
      } finally {
        lines.close(); child.stdin.end(); child.kill();
        await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
      }
      if (content !== null) assert.equal(await readFile(file, 'utf8'), content);
      else await assert.rejects(readFile(file), { code: 'ENOENT' });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
