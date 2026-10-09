// Opt-in real integration probe. The Python launcher owns its Hub and all files.
import fs from 'node:fs/promises';
import path from 'node:path';
import { ask } from '../mcp/hub.mjs';

const manifest = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const results = [];
for (const item of manifest.cases) {
  const started = Date.now();
  const progress = [];
  const result = await ask(item.worker, item.task, 100, {
    model: item.model, thinking: item.thinking ? 'on' : 'off',
    stream: item.stream, files: item.files, cwd: item.cwd,
    onProgress: async value => progress.push({ seconds: (Date.now() - started) / 1000,
      status: value.status, characters: value.text.length }),
  });
  let answer;
  try { answer = JSON.parse(result.answer); } catch { answer = null; }
  let artifact;
  try { artifact = JSON.parse(await fs.readFile(path.join(item.cwd, 'output.json'), 'utf8')); } catch { artifact = null; }
  const answerVerified = answer?.total === item.expected.total && answer?.nonce === item.expected.nonce;
  const artifactVerified = !item.require_write || artifact?.total === item.expected.total && artifact?.nonce === item.expected.nonce;
  results.push({ case: item.case, worker: item.worker, model: item.model,
    thinking: item.thinking, stream: item.stream, image: item.image, file: item.file,
    require_write: item.require_write,
    status: result.status, ok: result.ok, ref: result.ref,
    answer_verified: answerVerified, written_artifact_verified: artifactVerified,
    expected: item.expected, public_answer: answer,
    progress, elapsed_seconds: (Date.now() - started) / 1000,
    passed: result.ok && answerVerified && artifactVerified });
  console.log(JSON.stringify({ case: item.case, status: result.status,
    answerVerified, artifactVerified, progressEvents: progress.length }));
  await fs.writeFile(manifest.output, JSON.stringify({ ...manifest.report, results }, null, 2));
}
