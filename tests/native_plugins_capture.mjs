// Optional real-host probe helper. It does not run vendor models on import.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function sanitize(text) {
  return String(text).replace(/(Bearer\s+)[\w.\-]+/gi, '$1[redacted]')
    .replace(/([?&](?:token|api_key|code)=)[^&\s"<>]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]');
}

export async function captureNative({ name, exe, args = [], cwd, env = {}, outputRoot, timeoutMs = 120000 }) {
  if (!/^[\w-]+$/.test(name)) throw new Error('Invalid probe name');
  const root = resolve(outputRoot);
  await mkdir(root, { recursive: true });
  const began = Date.now();
  const child = spawn(exe, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', (part) => { stdout += part; });
  child.stderr.on('data', (part) => { stderr += part; });
  const timer = setTimeout(() => {
    timedOut = true;
    // The PID came from our own live ChildProcess, never from process discovery.
    if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGTERM');
  }, timeoutMs);
  const result = await new Promise((done) => {
    child.once('error', (error) => done({ exitCode: null, error: sanitize(error.message) }));
    child.once('close', (exitCode, signal) => done({ exitCode, signal }));
  });
  clearTimeout(timer);
  stdout = sanitize(stdout); stderr = sanitize(stderr);
  await Promise.all([writeFile(join(root, `${name}.stdout.log`), stdout), writeFile(join(root, `${name}.stderr.log`), stderr)]);
  const report = { name, executable: exe, argv: args, cwd, environmentNames: Object.keys(env), pid: child.pid,
    startedUtc: new Date(began).toISOString(), elapsedMs: Date.now() - began, timedOut, ...result,
    stdoutPath: join(root, `${name}.stdout.log`), stderrPath: join(root, `${name}.stderr.log`),
    stdoutTail: stdout.slice(-12000), stderrTail: stderr.slice(-8000) };
  await writeFile(join(root, `${name}.json`), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const job = JSON.parse(await readFile(process.argv[2], 'utf8'));
  console.log(JSON.stringify(await captureNative(job), null, 2));
}
