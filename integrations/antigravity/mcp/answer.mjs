// Whether a worker's reply is real text, kept apart from hub.mjs so a test can import it without the
// connection side effects of loading the bridge.

export function cleanText(text) {
  // Strips ANSI colour escapes from CLI output; the ESC control character is the point.
  // oxlint-disable-next-line no-control-regex
  return String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
}

/** The shape the placeholder set is matched in: no escapes, no whitespace, lower case. */
export function normalizeAnswer(text) {
  return cleanText(text).replace(/\s+/g, "").toLowerCase();
}

// Built through the same normalizer, so no entry is spelled in a form the comparison can never reach.
const PLACEHOLDER_ANSWERS = new Set(
  ["(无输出)", "(尚无文本)", "(no output)", "(empty)", "task received", "已收到任务", "任务已收到"]
    .map(normalizeAnswer),
);

export function unusableAnswer(text) {
  const value = normalizeAnswer(text);
  if (!value) return true;
  if (PLACEHOLDER_ANSWERS.has(value)) return true;
  return value.length <= 24 && ["思考中", "生成中", "thinking", "receivedthetask"].some((marker) => value.includes(marker));
}
