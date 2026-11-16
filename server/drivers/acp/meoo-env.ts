// Reading the Meoo CLI's env-style files. The CLI and people hand-edit them, so the forms it must
// accept are the common dotenv ones: `export` prefixes, quoted values, and trailing comments. The
// same parser decides both "is a key configured" and the value used for a run, so a file cannot
// look configured to one check and empty to the other.
import { readFileSync } from "node:fs";

/** A double-quoted value's common escapes; anything else keeps the character that followed the backslash. */
function escaped(code: string): string {
  switch (code) {
    case "n": return "\n";
    case "r": return "\r";
    case "t": return "\t";
    default: return code;
  }
}

function valueOf(raw: string): string {
  const text = raw.trimStart();
  const quote = text[0];
  if (quote === "'" || quote === "\"") {
    let value = "";
    for (let index = 1; index < text.length; index++) {
      const char = text[index]!;
      if (quote === "\"" && char === "\\" && index + 1 < text.length) {
        value += escaped(text[index + 1]!);
        index += 1;
        continue;
      }
      if (char === quote) return value;
      value += char;
    }
    // An unclosed quote is a half-written file, not a credential.
    return "";
  }
  // An unquoted value ends at whitespace followed by `#`; a `#` inside the value is kept.
  const cut = text.search(/\s+#/);
  const value = (cut < 0 ? text : text.slice(0, cut)).trim();
  return value.startsWith("#") ? "" : value;
}

/** One exact key's value from a dotenv-style file; an empty string means "not configured". */
export function readMeooEnvValue(path: string, key: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return "";
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const assignment = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const eq = assignment.indexOf("=");
    if (eq <= 0) continue;
    if (assignment.slice(0, eq).trim() !== key) continue;
    return valueOf(assignment.slice(eq + 1));
  }
  return "";
}
