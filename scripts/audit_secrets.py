"""Scan source and optional Git history; diagnostics never contain matched credentials."""
import argparse
import datetime
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RULES = {
    "private_key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "provider_key": re.compile(r"\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16})\b"),
    "jwt": re.compile(r"\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b"),
    "literal_credential": re.compile(r"(?i)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|HUB_TOKEN)[\"']?\s*[:=]\s*[\"']([A-Za-z0-9_./+=-]{20,})[\"']"),
    "local_user_path": re.compile(r"(?i)(?:[Cc]:[/\\]+Users[/\\]+Joh" + r"hny|/home/joh" + r"hny)\b"),
    "private_lan_ip": re.compile(r"\b192\.168\." + r"2\.29\b"),
    "legacy_hub_token": re.compile(r"sbl4LvbZ4DcvlgSN-" + r"JpNLBQmvkHlYqie"),
}


def matches(text, active_rules=RULES):
    for rule, pattern in active_rules.items():
        for found in pattern.finditer(text):
            value = found.group(1) if found.lastindex else found.group()
            if value.startswith(("SYNTHETIC_", "EXAMPLE_", "REPLACE_WITH_")):
                continue
            yield {"line": text.count("\n", 0, found.start()) + 1, "rule": rule}


def scan(history=False):
    findings, count = [], 0
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.is_symlink() or any(part in {".git", "node_modules", "__pycache__"} for part in path.relative_to(ROOT).parts):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        count += 1
        findings.extend({"file": path.relative_to(ROOT).as_posix(), **item} for item in matches(text, RULES))
    historical = []
    if history:
        diff = subprocess.check_output(["git", "log", "--all", "--no-ext-diff", "--format=COMMIT:%H", "-p", "--"], cwd=ROOT, timeout=60).decode("utf-8", errors="replace")
        commit, name = "", ""
        for line in diff.splitlines():
            if line.startswith("COMMIT:"):
                commit = line[7:]
            elif line.startswith("+++ b/"):
                name = line[6:]
            elif line.startswith("+") and not line.startswith("+++"):
                historical.extend({"commit": commit, "file": name, "rule": item["rule"]} for item in matches(line[1:]))
    return {"tested_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"), "engine": "agenthub-secret-pattern-audit-v1",
            "files_scanned": count, "history_scanned": history, "findings": findings, "history_findings": historical,
            "passed": not findings and not historical, "matched_values_recorded": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history", action="store_true")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    result = scan(args.history)
    if args.report:
        args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result["passed"] else 1)
