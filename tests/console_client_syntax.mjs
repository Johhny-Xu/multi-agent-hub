// 控制台是单文件前端：任何一个内联 <script> 的语法错误都会让整页 JS 失效（白屏 / 全部交互失灵）。
// 这里把每个内联脚本块交给 V8 编译一遍，把这类错误挡在提交之前。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(ROOT, 'console', 'client', 'index.html'), 'utf-8');

function inlineScripts(html) {
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (/type\s*=\s*["'](?!text\/javascript|module|application\/javascript)/i.test(attrs)) continue;
    blocks.push(m[2]);
  }
  return blocks;
}

const blocks = inlineScripts(HTML);

test('console client ships at least one inline script', () => {
  assert.ok(blocks.length > 0, 'no inline script found');
});

test('every inline script compiles', () => {
  blocks.forEach((code, index) => {
    assert.doesNotThrow(() => {
      // 只编译不执行：抛出语法错误即代表页面上线后会整体失效
      new vm.Script(code, { filename: `console/client/index.html#script-${index}` });
    }, `inline script #${index} has a syntax error`);
  });
});

test('new workers appear in the brand avatar and theme tables', () => {
  assert.match(HTML, /'opencode':\s*'<svg/, 'opencode brand icon missing');
  assert.match(HTML, /'cline':\s*'<svg/, 'cline brand icon missing');
  assert.match(HTML, /'opencode':\s*\{\s*color:/, 'opencode theme missing');
  assert.match(HTML, /'cline':\s*\{\s*color:/, 'cline theme missing');
});

// 单色 currentColor 图标在浅色模式下会继承深色主题的白色，必须有浅色专用的徽章底色
test('mono-icon workers ship a light-mode avatar badge', () => {
  for (const agent of ['opencode', 'cline']) {
    assert.match(
      HTML,
      new RegExp(`\\[data-theme="light"\\]\\s*\\.platform-avatar\\[data-agent="${agent}"\\]`),
      `${agent} has no light-mode avatar badge`,
    );
  }
});
