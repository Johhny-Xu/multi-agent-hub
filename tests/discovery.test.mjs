import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { discoverHubs, probeHealth, hubDiscover } from '../mcp/discovery.mjs';

async function httpFixture(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/mcp`, port: server.address().port,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
async function udpFixture(handler) {
  const socket = createSocket('udp4');
  socket.on('message', (message, peer) => handler(JSON.parse(message), reply => socket.send(Buffer.from(JSON.stringify(reply)), peer.port, peer.address)));
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  return { port: socket.address().port, close: () => new Promise(resolve => socket.close(resolve)) };
}

test('UDP discovery validates nonce and health, deduplicates, ignores advertised URL and sends no credentials', async () => {
  const received = [];
  const web = await httpFixture((req, res) => { received.push({ path: req.url, auth: req.headers.authorization }); res.end(JSON.stringify({ service: 'agent-hub', status: 'ok', auth_required: true })); });
  const udp = await udpFixture((request, send) => {
    assert.deepEqual(Object.keys(request).sort(), ['nonce', 'service', 'version']);
    const reply = { ...request, port: web.port, path: '/mcp', name: 'Fixture\n<injected>', url: 'http://untrusted.invalid/mcp', token: 'SYNTHETIC_ADVERTISED_SECRET' };
    send({ ...reply, nonce: 'wrong' }); send({ ...reply, service: 'other' }); send({ ...reply, path: '/unsafe' });
    send(reply); send(reply);
  });
  try {
    const result = await discoverHubs({ targets: ['127.0.0.1'], port: udp.port, timeoutMs: 150 });
    assert.equal(result.candidates.length, 1);
    assert.deepEqual(result.candidates[0], { url: web.url, auth_required: true, name: 'Fixtureinjected', source: 'discovery' });
    assert.equal(result.manual_required, false);
    assert.deepEqual(received, [{ path: '/health', auth: undefined }]);
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_'));
  } finally { await udp.close(); await web.close(); }
});

test('wrong health identity, redirects, oversized and stalled bodies are rejected within budget', async () => {
  let mode = 'other', targetHits = 0;
  const target = await httpFixture((req, res) => { targetHits++; res.end('{}'); });
  const web = await httpFixture((req, res) => {
    if (mode === 'redirect') { res.writeHead(302, { Location: target.url }); res.end(); }
    else if (mode === 'large') res.end('x'.repeat(10000));
    else if (mode === 'stall') res.write('{');
    else res.end(JSON.stringify({ service: 'other', status: 'ok' }));
  });
  try {
    for (mode of ['other', 'redirect', 'large', 'stall']) assert.equal(await probeHealth(web.url, 100), null, mode);
    assert.equal(targetHits, 0);
  } finally { await web.close(); await target.close(); }
});

test('configured legacy endpoint query credentials are stripped and unknown auth stays required', async () => {
  const requests = [];
  const web = await httpFixture((req, res) => { requests.push({ path: req.url, auth: req.headers.authorization }); res.end(JSON.stringify({ service: 'agent-hub', status: 'ok' })); });
  try {
    const result = await discoverHubs({ targets: [], timeoutMs: 50, knownUrls: [web.url + '?token=SYNTHETIC_QUERY_TOKEN'] });
    assert.deepEqual(result.candidates, [{ url: web.url, auth_required: true, name: '', source: 'configured' }]);
    assert.deepEqual(requests, [{ path: '/health', auth: undefined }]);
  } finally { await web.close(); }
});

test('no responders returns manual entry guidance without writing or exposing saved token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agenthub-discover-node-'));
  const file = join(dir, 'client.json');
  const saved = JSON.stringify({ url: 'http://127.0.0.1:1/mcp', token: 'SYNTHETIC_SAVED_TOKEN' });
  const old = { ...process.env };
  try {
    await writeFile(file, saved);
    process.env.AGENTHUB_CONFIG = file; process.env.AGENTHUB_CONNECTION_MODE = 'file';
    const result = await hubDiscover({ targets: [], timeoutMs: 50 });
    assert.equal(result.manual_required, true); assert.equal(result.changed_connection, false);
    assert.equal(result.credentials_sent, false); assert.match(result.next_step, /手动/);
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_'));
    assert.equal(await readFile(file, 'utf8'), saved);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old); await rm(dir, { recursive: true, force: true });
  }
});

test('all native bridges list and run discovery with missing, malformed or incomplete configuration; dispatch stays rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agenthub-discover-mcp-'));
  try {
    for (const [index, folder] of ['mcp', 'integrations/codex/mcp', 'integrations/dsh/mcp', 'plugins/agenthub-workers/mcp'].entries()) {
      const file = join(dir, 'config-' + index + '.json');
      if (index === 1) await writeFile(file, '{"token":"SYNTHETIC_MALFORMED_TOKEN",');
      if (index === 2) await writeFile(file, '{}');
      if (index === 3) await writeFile(file, '{"token":"SYNTHETIC_TOKEN_WITHOUT_ENDPOINT"}');
      const env = { ...process.env, AGENTHUB_CONNECTION_MODE: 'file', AGENTHUB_CONFIG: file };
      const child = spawn(process.execPath, [fileURLToPath(new URL('../' + folder + '/server.mjs', import.meta.url))], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const waiters = new Map(); let nextId = 0, stderr = '';
      child.stderr.on('data', chunk => stderr += chunk);
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => { const reply = JSON.parse(line); waiters.get(reply.id)?.(reply); });
      const request = (method, params) => new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => reject(new Error('MCP timed out: ' + stderr)), 5000);
        waiters.set(id, reply => { clearTimeout(timer); waiters.delete(id); resolve(reply); });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
      try {
        const listed = await request('tools/list', {});
        assert.ok(listed.result.tools.some(tool => tool.name === 'hub_discover'));
        const reply = await request('tools/call', { name: 'hub_discover', arguments: {} });
        assert.equal(reply.result.isError, undefined);
        const result = JSON.parse(reply.result.content[0].text);
        assert.equal(result.configuration_error, true); assert.equal(result.changed_connection, false);
        assert.ok(!JSON.stringify(reply).includes('SYNTHETIC_'));
        const dispatched = await request('tools/call', { name: 'hub_dispatch', arguments: { worker: 'mimo', task: 'DO NOT RUN', timeout_s: 1 } });
        assert.equal(dispatched.result.isError, true);
        const outcome = JSON.parse(dispatched.result.content[0].text);
        assert.equal(outcome.status, 'failed'); assert.equal(outcome.ref, ''); assert.match(outcome.answer, /SETUP_REQUIRED/);
      } finally { lines.close(); child.stdin.end(); child.kill(); await new Promise(resolve => child.exitCode === null ? child.once('exit', resolve) : resolve()); }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
