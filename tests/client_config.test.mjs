import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { defaultClientConfig, connectionUrl, loadConnection } from '../mcp/config.mjs';

test('connection locations distinguish server-free client settings on Windows and Linux', () => {
  assert.equal(defaultClientConfig({ LOCALAPPDATA: '/fixture/local' }, 'win32', '/home'), join('/fixture/local', 'AgentHub/client.json'));
  assert.equal(defaultClientConfig({ XDG_CONFIG_HOME: '/fixture/xdg' }, 'linux', '/home'), join('/fixture/xdg', 'agenthub/client.json'));
  assert.equal(defaultClientConfig({ HOME: '/fixture/home' }, 'linux', '/home'), join('/fixture/home', '.config/agenthub/client.json'));
  assert.equal(connectionUrl('server.example:8765'), 'http://server.example:8765/mcp');
  assert.equal(connectionUrl('https://server.example/custom/mcp'), 'https://server.example/custom/mcp');
  for (const invalid of ['file:///tmp/x', 'http://name:password@server/mcp', 'http://server/mcp?token=private']) assert.throws(() => connectionUrl(invalid));
});

test('external config, Codex plugin data and explicit environment have isolated precedence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agenthub-client-config-'));
  try {
    await mkdir(join(dir, 'agenthub')); await mkdir(join(dir, 'plugin'));
    await writeFile(join(dir, 'agenthub/client.json'), '\uFEFF' + JSON.stringify({ url: 'host.example:8765', token: 'SYNTHETIC_CONFIG_TOKEN' }));
    const defaults = { XDG_CONFIG_HOME: dir };
    const options = { platform: 'linux', home: dir };
    assert.equal((await loadConnection(defaults, options)).url, 'http://host.example:8765/mcp');
    const switched = await loadConnection({ ...defaults, AGENTHUB_URL: 'other.example:8765' }, options);
    assert.equal(switched.token, '', 'A token for one machine must not follow a changed endpoint');
    assert.equal((await loadConnection({ ...defaults, AGENTHUB_URL: 'host.example:8765' }, options)).token, 'SYNTHETIC_CONFIG_TOKEN');
    await writeFile(join(dir, 'plugin/agenthub.json'), JSON.stringify({ url: 'plugin.example:8765', token: 'SYNTHETIC_PLUGIN_TOKEN' }));
    assert.equal((await loadConnection({ ...defaults, PLUGIN_DATA: join(dir, 'plugin') }, options)).token, 'SYNTHETIC_PLUGIN_TOKEN');
    const explicit = join(dir, 'explicit.json');
    await writeFile(explicit, JSON.stringify({ url: 'explicit.example:8765', token: 'SYNTHETIC_EXPLICIT_TOKEN' }));
    const locked = await loadConnection({ AGENTHUB_CONNECTION_MODE: 'file', AGENTHUB_CONFIG: explicit, AGENTHUB_URL: 'stale.example:8765', HUB_TOKEN: 'SYNTHETIC_STALE_TOKEN' }, options);
    assert.equal(locked.url, 'http://explicit.example:8765/mcp');
    assert.equal(locked.token, 'SYNTHETIC_EXPLICIT_TOKEN');
    await assert.rejects(loadConnection({ AGENTHUB_CONNECTION_MODE: 'file' }, options), /explicit configuration/);
    await assert.rejects(loadConnection({ AGENTHUB_CONNECTION_MODE: 'typo' }, options), /Invalid AgentHub connection mode/);
    assert.equal((await loadConnection({ ...defaults, PLUGIN_DATA: join(dir, 'plugin'), AGENTHUB_CONFIG_FILE: explicit }, options)).token, 'SYNTHETIC_EXPLICIT_TOKEN');
    await writeFile(explicit, '{"token":"SYNTHETIC_PRIVATE_VALUE",');
    await assert.rejects(loadConnection({ AGENTHUB_CONFIG: explicit }, options), error => !error.message.includes('SYNTHETIC_PRIVATE_VALUE'));
    for (const incomplete of [{}, { token: 'SYNTHETIC_TOKEN_WITHOUT_ENDPOINT' }]) {
      await writeFile(explicit, JSON.stringify(incomplete));
      await assert.rejects(loadConnection({ AGENTHUB_CONFIG: explicit, AGENTHUB_CONNECTION_MODE: 'file' }, options), /explicit Hub URL/);
    }
    assert.equal((await loadConnection({ AGENTHUB_CONFIG: explicit, AGENTHUB_URL: 'env.example:8765', HUB_TOKEN: '' }, options)).token, '');
    await assert.rejects(loadConnection({ AGENTHUB_CONFIG: join(dir, 'missing.json') }, options), /cannot be read/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('all four independent plugin packages use an external connection without a local Hub', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agenthub-client-only-'));
  const received = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const rpc = JSON.parse(raw); received.push({ auth: request.headers.authorization, path: request.url, args: rpc.params.arguments });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ schema_version: 2, workers: {} }) }] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = join(dir, 'client.json');
    await writeFile(config, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token: 'SYNTHETIC_REMOTE_TOKEN' }));
    for (const folder of ['../mcp/', '../integrations/codex/mcp/', '../integrations/dsh/mcp/', '../plugins/agenthub-workers/mcp/']) {
      const env = { ...process.env, AGENTHUB_CONFIG: config, AGENTHUB_CONNECTION_MODE: 'file', AGENTHUB_URL: 'http://127.0.0.1:1/mcp', HUB_TOKEN: 'SYNTHETIC_STALE_TOKEN' };
      for (const key of ['HUB_MCP_URL', 'AGENTHUB_CONFIG_FILE', 'PLUGIN_DATA']) delete env[key];
      const child = spawn(process.execPath, [fileURLToPath(new URL(folder + 'server.mjs', import.meta.url))], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
      try {
        const output = new Promise((resolve, reject) => {
          const lines = createInterface({ input: child.stdout });
          const timer = setTimeout(() => { lines.close(); reject(new Error('Plugin request timed out')); }, 5000);
          lines.once('line', line => { clearTimeout(timer); lines.close(); resolve(JSON.parse(line)); });
          child.once('error', error => { clearTimeout(timer); reject(error); });
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hub_capabilities', arguments: { worker: 'mimo', model: '26f', refresh: true } } }) + '\n');
        const reply = await output;
        assert.equal(reply.result.isError, undefined, stderr);
        assert.equal(JSON.parse(reply.result.content[0].text).schema_version, 2);
        assert.deepEqual(received.at(-1), { auth: 'Bearer SYNTHETIC_REMOTE_TOKEN', path: '/mcp', args: { agent: 'mimocode', model: '26f', refresh: true } });
      } finally { child.stdin.end(); child.kill(); await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); }); }
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});
