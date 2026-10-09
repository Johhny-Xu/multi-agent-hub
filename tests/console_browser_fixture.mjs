// Opt-in browser fixture: serves the real client against a synthetic Hub only.
import http from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'agenthub-console-browser-'));
process.env.HOME = process.env.USERPROFILE = join(directory, 'home');
await mkdir(process.env.HOME, { recursive: true });
const model = (id, allowed, { enabled = true, image = true, file = true, stream = true, reason = '' } = {}) => ({
  id, aliases: [], availability: { enabled, reason }, thinking: { allowed, default: 'default', reasons: { on: '此模型不支持思考开启', off: '此模型始终思考，不能关闭' } },
  stream: { supported: stream, semantics: 'answer_deltas', reason: '此模型未验证流式输出' }, attachments: { image: { supported: image, reason: '此模型不支持图片附件' }, file: { supported: file, reason: '此模型不支持文件附件' } },
});
const worker = (entry, reason = '') => ({ configured: true, default_model: entry.id, availability: { enabled: !reason, reason }, models: [entry] });
const workers = {
  'codebuddy-cn': worker(model('deepseek-v4.1-flash', ['default','on','off'])),
  'github-copilot': worker(model('auto', ['default','off'])),
  minimaxcode: worker(model('MiniMax-M3.1-Flash-Preview', ['default','on'])),
  mimocode: worker(model('xiaomi/mimo-v2.6-flash', ['default','on','off'])),
  zcode: worker(model('GLM-5.3-Flash', ['default'], { enabled: false, reason: '当前官方模型目录缺少 GLM-5.3-Flash' }), '当前官方模型目录缺少 GLM-5.3-Flash'),
  codebuddy: worker(model('deepseek-v4.1-flash', ['default','on','off']), '当前账户登录失效，需要重新登录'),
  antigravity: worker(model('gemini-3.8-flash-medium', ['default']), '供应商不支持当前区域'),
  traecode: worker(model('GLM-5.3-FlashX', ['default']), '官方 SSO 授权依赖失败'),
};
workers['codebuddy-cn'].models.push(model('limited-fixture', ['default'], { image: false, stream: false }));
const document = { schema_version: 2, platform: 'windows', workers, attachment_limit_bytes: 1024 * 1024 };
let dispatches = 0;
const mock = http.createServer(async (request, response) => {
  if (request.method === 'GET') { response.end(JSON.stringify({ synthetic: true, dispatches })); return; }
  let body = '';
  for await (const part of request) body += part;
  const rpc = JSON.parse(body);
  const tool = rpc.params?.name;
  let text = 'synthetic ok';
  if (tool === 'hub_capabilities') text = JSON.stringify(document);
  if (tool === 'hub_list_agents') text = '已注册代理:\n' + Object.keys(workers).map((name) => `- ${name} [在线] 角色: synthetic | CLI: synthetic.exe`).join('\n');
  if (tool === 'hub_list_models') text = '各 worker 可选模型:\n' + Object.entries(workers).map(([name, entry]) => `- ${name}: model_arg=--model | 默认→${entry.default_model}`).join('\n');
  if (tool === 'hub_list_tasks') text = '没有匹配的任务。';
  if (tool === 'hub_note_get') text = '全部笔记: (空)';
  if (tool === 'hub_read_messages') text = 'console 没有未读消息。';
  if (tool === 'hub_dispatch_cli' || tool === 'trae_delegate') { dispatches++; text = '[synthetic] exit=0\nMOCK_ONLY'; }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: rpc.method === 'initialize' ? { serverInfo: { name: 'synthetic-ui-hub' } } : { content: [{ type: 'text', text }] } }));
});
await new Promise((done) => mock.listen(0, '127.0.0.1', done));
process.env.HUBCONSOLE_SERVER_URL = `http://127.0.0.1:${mock.address().port}/mcp`;
process.env.HUBCONSOLE_SERVER_TOKEN = '';
const probe = http.createServer();
await new Promise((done) => probe.listen(0, '127.0.0.1', done));
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const { start } = await import(pathToFileURL(resolve('console/server.mjs')));
const runtime = await start({ dataDir: join(directory, 'data'), pluginRoot: directory, listen: { host: '127.0.0.1', port },
  signal: new AbortController().signal, logger: { info() {}, warn() {}, debug() {} } });
console.log(JSON.stringify({ synthetic: true, url: `http://127.0.0.1:${port}`, statusUrl: `http://127.0.0.1:${mock.address().port}/__fixture/status`, pid: process.pid }));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await runtime.dispose();
  await new Promise((done) => mock.close(done));
  const target = resolve(directory), parent = resolve(tmpdir());
  if (!target.startsWith(parent + sep) || !basename(target).startsWith('agenthub-console-browser-')) throw new Error('Unexpected fixture cleanup path');
  await rm(target, { recursive: true, force: true });
  process.exit(0);
}
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
setTimeout(() => void close(), 10 * 60 * 1000);
