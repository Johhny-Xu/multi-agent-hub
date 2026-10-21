// Real Python Hub capability export -> console adapter, synthetic profiles only.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { normalizeCapabilities, taskCapability } from '../console/server.mjs';

test('real Hub v2 schema distinguishes model failure and preserves known UTF-8 attachment limits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agenthub-console-core-'));
  try {
    const source = `import sys,json
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import agent_hub as hub
from availability_store import record_outcome,signature
profile={"cli":[sys.executable,"-c","pass"],"model_arg":"--model","models":{"default":"synthetic","alias":"alternate"},"env":{"TOKEN":"SYNTHETIC_NOT_PUBLIC"},"capabilities":{"thinking":{"on":{"args":[]}},"stream":{"on":{"args":[]}},"attachments":{"file":{"mode":"inline_text"},"image":{"mode":"prompt_path"}}}}
hub.STATE=Path(sys.argv[2])
hub._load_agents=lambda:{"probe":profile}
record_outcome(hub.STATE,"probe","synthetic","error","model not found",signature(profile))
record_outcome(hub.STATE,"probe","undeclared","error","400 model [undeclared] is not allowed for user type [free]",signature(profile))
print(hub.tool_hub_capabilities({}))
`;
    const executable = process.env.HUB_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const { stdout } = await promisify(execFile)(executable, ['-c', source, resolve('hub'), directory], { timeout: 15000, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    const document = normalizeCapabilities(JSON.parse(stdout));
    assert.equal(document.platform, process.platform === 'win32' ? 'windows' : process.platform);
    assert.equal(document.workers.probe.availability.enabled, true, 'default model failure is not a worker-wide failure');
    assert.equal(taskCapability(document, 'probe', 'synthetic').allowed, false);
    assert.equal(taskCapability(document, 'probe', 'alias', { thinking: 'on', stream: true, attachments: [{ mime_type: 'text/plain' }] }).allowed, true);
    assert.equal(taskCapability(document, 'probe', 'alias', { thinking: 'off' }).allowed, false);
    assert.deepEqual(document.workers.probe.models[1].attachments.file.content_types, ['text/plain; charset=utf-8']);
    // 别名表之外的模型不会出现在 models 里，但失败记录必须透到控制台，否则无法置灰
    assert.ok(!document.workers.probe.models.some((model) => model.id === 'undeclared'));
    assert.equal(document.workers.probe.failures.undeclared.blocking, true);
    assert.match(document.workers.probe.failures.undeclared.reason, /套餐/);
    assert.equal(taskCapability(document, 'probe', 'undeclared').allowed, false);
    assert.ok(!JSON.stringify(document).includes('SYNTHETIC_NOT_PUBLIC'));
  } finally {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('agenthub-console-core-'));
    await rm(target, { recursive: true, force: true });
  }
});

test('qd / qdcn aliases resolve to the Qoder workers and dfmodel is the default', () => {
  const worker = {
    configured: true,
    default_model: 'dfmodel',
    availability: { enabled: true },
    models: [{
      id: 'dfmodel',
      availability: { enabled: true },
      thinking: { allowed: ['on', 'off'] },
      permission: { allowed: ['readonly', 'edit', 'full'] },
      stream: { supported: true, semantics: 'answer_snapshots' },
      attachments: { file: { supported: true, mode: 'cli' }, image: { supported: true, mode: 'cli' } },
    }],
  };
  const document = normalizeCapabilities({
    schema_version: 2,
    platform: 'linux',
    workers: { qoder: worker, 'qoder-cn': worker },
  });
  for (const alias of ['qd', 'qdcn']) {
    assert.equal(taskCapability(document, alias).allowed, true, `${alias} default model`);
    assert.equal(taskCapability(document, alias).model, 'dfmodel');
    assert.equal(taskCapability(document, alias, 'dfmodel', { thinking: 'on', stream: true, permission: 'readonly', attachments: [{ mime_type: 'image/png' }] }).allowed, true);
  }
});
