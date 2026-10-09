import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../scripts/windows-services.ps1', import.meta.url));
const powershell = join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const python = process.env.AGENTHUB_TEST_PYTHON || join(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const available = process.platform === 'win32' && existsSync(python);

async function port() {
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const selected = server.address().port;
  await new Promise(r => server.close(r));
  return selected;
}
async function fixture(extra = '') {
  const root = await mkdtemp(join(tmpdir(), 'agenthub launcher fixture-'));
  await mkdir(join(root, 'hub'));
  await mkdir(join(root, 'console'));
  await writeFile(join(root, 'hub/agents.windows.example.json'), '{"fixture":"WINDOWS_TEMPLATE"}');
  await writeFile(join(root, 'hub/agents.example.json'), '{"fixture":"LINUX_TEMPLATE"}');
  await writeFile(join(root, 'hub/agent_hub.py'), `import argparse, json, os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
p=argparse.ArgumentParser(); p.add_argument('--http',type=int); p.add_argument('--host'); a=p.parse_args()
class H(BaseHTTPRequestHandler):
 def do_GET(self):
  b=json.dumps({'service':'agent-hub','status':'ok'}).encode(); self.send_response(200); self.send_header('Content-Length',str(len(b))); self.end_headers(); self.wfile.write(b)
if os.environ.get('FIXTURE_HUB_FAIL'): sys.exit(23)
ThreadingHTTPServer((a.host,a.http),H).serve_forever()
`);
  await writeFile(join(root, 'console/server.mjs'), `import http from 'node:http';
if(process.env.FIXTURE_CONSOLE_FAIL) process.exit(23);
http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({url:process.env.HUBCONSOLE_SERVER_URL,token:process.env.HUBCONSOLE_SERVER_TOKEN}))}).listen(Number(process.env.HUBCONSOLE_PORT),process.env.HUBCONSOLE_HOST);
`);
  const hubPort = await port(), consolePort = await port();
  await writeFile(join(root, '.env'), `# isolated fake credentials, no vendor requests
HUB_PYTHON="${python}"
AGENTHUB_HOST=127.0.0.1
AGENTHUB_PORT=${hubPort}
HUBCONSOLE_HOST=127.0.0.1
HUBCONSOLE_PORT=${consolePort}
HUB_TOKEN=FAKE_LAUNCHER_TOKEN
HUBCONSOLE_SERVER_URL=
HUBCONSOLE_SERVER_TOKEN=
${extra}`);
  return { root, hubPort, consolePort };
}
async function run(root, action) {
  const env = { ...process.env, USERPROFILE: root, HOME: root };
  for (const key of Object.keys(env)) if (/^(?:AGENTHUB_|HUBCONSOLE_|HUB_|FIXTURE_)/.test(key)) delete env[key];
  return new Promise((resolveResult, reject) => {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-Action', action, '-Root', root, '-HealthTimeoutSeconds', '6'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    const timer = setTimeout(() => { child.kill(); reject(new Error('Launcher exceeded 30 seconds')); }, 30000);
    child.once('error', reject);
    // Windows PowerShell's background children can inherit unused pipe handles.
    // Observe the launcher process exit, then close our capture streams.
    child.once('exit', code => {
      clearTimeout(timer);
      child.stdout.destroy(); child.stderr.destroy();
      resolveResult({ code, output });
    });
  });
}
async function record(root, name) {
  return JSON.parse((await readFile(join(root, `.run/${name}.windows.json`), 'utf8')).replace(/^\uFEFF/, ''));
}
async function cleanup(root) {
  await run(root, 'stop');
  const target = await realpath(root);
  assert.equal(dirname(target).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
  assert.ok(target.startsWith(resolve(tmpdir(), 'agenthub launcher fixture-')));
  await rm(target, { recursive: true, force: true });
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('Windows launcher loads env, quotes paths, chooses Windows template and stops owned services', { skip: !available }, async () => {
  const { root, hubPort, consolePort } = await fixture();
  try {
    const result = await run(root, 'start');
    assert.equal(result.code, 0, result.output);
    const received = await (await fetch(`http://127.0.0.1:${consolePort}/dashboard`)).json();
    assert.deepEqual(received, { url: `http://127.0.0.1:${hubPort}/mcp`, token: 'FAKE_LAUNCHER_TOKEN' });
    assert.equal(JSON.parse(await readFile(join(root, 'hub/agents.json'), 'utf8')).fixture, 'WINDOWS_TEMPLATE');
    const hub = await record(root, 'hub'), consoleRecord = await record(root, 'console');
    assert.ok(alive(hub.Pid) && alive(consoleRecord.Pid));
    assert.equal((await run(root, 'stop')).code, 0);
    assert.ok(!alive(hub.Pid) && !alive(consoleRecord.Pid));
  } finally { await cleanup(root); }
});

test('failed console startup returns failure and reclaims its newly started Hub', { skip: !available }, async () => {
  const { root, hubPort } = await fixture('FIXTURE_CONSOLE_FAIL=1\n');
  try {
    const result = await run(root, 'start');
    assert.notEqual(result.code, 0);
    assert.ok(!existsSync(join(root, '.run/hub.windows.json')));
    await assert.rejects(fetch(`http://127.0.0.1:${hubPort}/health`));
  } finally { await cleanup(root); }
});

test('stop rejects a PID record whose process creation time does not match', { skip: !available }, async () => {
  const { root } = await fixture();
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    await mkdir(join(root, '.run'));
    await writeFile(join(root, '.run/hub.windows.json'), JSON.stringify({ Root: root, Pid: unrelated.pid, StartTicks: '1', Entry: process.execPath }));
    assert.equal((await run(root, 'stop')).code, 0);
    assert.ok(alive(unrelated.pid));
  } finally {
    unrelated.kill();
    await new Promise(r => unrelated.once('close', r));
    await cleanup(root);
  }
});

test('an occupied Hub port cannot pass health checks as the newly launched service', { skip: !available }, async () => {
  const { root, hubPort } = await fixture();
  const existing = createHttpServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"service":"agent-hub","status":"ok"}'); });
  await new Promise(r => existing.listen(hubPort, '127.0.0.1', r));
  try {
    const result = await run(root, 'start');
    assert.notEqual(result.code, 0);
    assert.equal((await fetch(`http://127.0.0.1:${hubPort}/health`)).status, 200);
    assert.ok(!existsSync(join(root, '.run/console.windows.json')));
  } finally {
    await new Promise(r => existing.close(r));
    await cleanup(root);
  }
});
