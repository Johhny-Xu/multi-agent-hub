// `mcp/*.test.mjs` is outside the vitest `include` list in vite.config.ts, so this file uses node:test:
// `node --test mcp/answer.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";

import { cleanText, normalizeAnswer, unusableAnswer } from "./answer.mjs";

test("every placeholder answer is unusable, whatever its spacing or case", () => {
  for (const placeholder of ["(无输出)", "(尚无文本)", "(no output)", "(empty)", "task received", "已收到任务", "任务已收到"]) {
    assert.equal(unusableAnswer(placeholder), true, placeholder);
    assert.equal(unusableAnswer(` ${placeholder}\n`), true, placeholder);
    assert.equal(unusableAnswer(placeholder.toUpperCase()), true, placeholder);
  }
  assert.equal(unusableAnswer("(no output)"), true);
  assert.equal(unusableAnswer("( No   Output )"), true);
  assert.equal(unusableAnswer("TASK RECEIVED"), true);
});

test("no text at all is unusable", () => {
  assert.equal(unusableAnswer(""), true);
  assert.equal(unusableAnswer("   \n\t "), true);
  assert.equal(unusableAnswer(cleanText("\u001b[31m\u001b[0m")), true);
});

test("a real answer stays usable, short ones included", () => {
  for (const answer of [
    "Done: the file now has the two lines you asked for.",
    "Yes.",
    "已按方案修改 `server/hub.mjs`，测试通过。",
    "I could not reach the machine, so nothing was changed.",
  ]) {
    assert.equal(unusableAnswer(answer), false, answer);
  }
});

test("the marker rule keeps its length window", () => {
  assert.equal(unusableAnswer("thinking"), true);
  assert.equal(unusableAnswer("思考中"), true);
  assert.equal(unusableAnswer("thinking about the request and reading files"), false);
});

test("normalizeAnswer removes escapes, whitespace and case", () => {
  assert.equal(normalizeAnswer("\u001b[32m ( No   Output ) \u001b[0m"), "(nooutput)");
  assert.equal(normalizeAnswer("Task   Received"), "taskreceived");
});
