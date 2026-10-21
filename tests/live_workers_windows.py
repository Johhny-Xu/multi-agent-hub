"""Opt-in real Windows CLI probes; never run as part of offline regression tests.

Raw output stays in a new system temp directory. Reports contain public results,
event counters and sanitized diagnostics only. Existing auth remains in place.
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import itertools
import json
import os
from pathlib import Path
import random
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
from command_runtime import spawn_owned, terminate_owned
from output_parser import parse_output, parse_usage

HOME = Path.home()
TEMP = Path(tempfile.gettempdir())


def entry(variable, command, stable=(), portable_globs=()):
    """Explicit override, installed location/PATH, then this machine's retained probes.

    No installation or profile change is performed. npm package entry scripts
    deliberately use Node rather than a shell shim.
    """
    explicit = os.environ.get(variable)
    if explicit:
        path = Path(os.path.expandvars(os.path.expanduser(explicit)))
        if not path.is_file():
            raise FileNotFoundError(variable + " does not point to an existing official CLI entry")
        return path
    found = shutil.which(command) if command else None
    candidates = list(stable) + ([Path(found)] if found and Path(found).suffix.lower() not in (".cmd", ".bat", ".ps1") else [])
    for path in candidates:
        if path.is_file():
            return path
    for pattern in portable_globs:
        candidates = sorted(TEMP.glob(pattern), key=lambda path: path.stat().st_mtime, reverse=True)
        for path in candidates:
            if path.is_file():
                return path
    # Importing this module should not fail just because another worker is not
    # installed. The chosen live probe will report a bounded launch failure.
    return Path(command or variable)


NPM = Path(os.environ.get("APPDATA", str(HOME / "AppData/Roaming"))) / "npm/node_modules"
NODE = entry("HUB_PROBE_NODE", "node", [Path("C:/Program Files/nodejs/node.exe")])
CB = entry("HUB_PROBE_CODEBUDDY", None, [NPM / "@tencent-ai/codebuddy-code/bin/codebuddy"], ["agenthub-windows-codebuddy*/package/bin/codebuddy"])
MMX = entry("HUB_PROBE_MINIMAX", None, [NPM / "mmx-cli/dist/mmx.mjs"], ["hub-windows-root-*/mmx/node_modules/mmx-cli/dist/mmx.mjs"])
MIMO = entry("HUB_PROBE_MIMO", None, [NPM / "@mimo-ai/cli/bin/mimo"])
COPILOT = entry("HUB_PROBE_COPILOT", "copilot", [HOME / ".local/bin/copilot.exe"], ["agenthub-windows-copilot-mimo-*/copilot-portable/copilot.exe"])
TRAE = entry("HUB_PROBE_TRAE", "traecli", [HOME / ".local/bin/traecli.exe"], ["hub-windows-root-*/traecli.exe"])
ZCODE = entry("HUB_PROBE_ZCODE", None, [Path("C:/Program Files/ZCode/resources/glm/zcode.cjs")])
AGY = entry("HUB_PROBE_ANTIGRAVITY", "agy", [HOME / ".local/bin/agy.exe", HOME / ".antigravity/bin/agy.exe"], ["agenthub-probe-antigravity-*/agy.exe"])
MODELS = {"codebuddy": "deepseek-v4.1-flash", "codebuddy-cn": "deepseek-v4.1-flash", "github-copilot": "auto", "mimocode": "xiaomi/mimo-v2.6-flash", "minimaxcode": "MiniMax-M3.1-Flash", "traecode": "GLM-5.3-FlashX", "zcode": "GLM-5.3-Flash", "antigravity": "gemini-3.8-flash-medium"}

def sanitize(text):
    text = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", str(text))
    text = re.sub(r"(?i)\bBearer\s+[^\s\"',}]+", "Bearer [REDACTED]", text)
    text = re.sub(r"(?i)((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|password|secret|token)[\"']?\s*[:=]\s*[\"']?)[^\s\"',}]+", r"\1[REDACTED]", text)
    text = re.sub(r"\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,})", "[REDACTED]", text)
    return text

def fixture(directory, image, file):
    directory.mkdir(parents=True, exist_ok=True)
    rng = random.Random(hashlib.sha256(str(directory).encode()).digest())
    a, b, c, d = [rng.randrange(11, 49) for _ in range(4)]
    nonce = "CHECK_" + hashlib.sha256(str(directory).encode()).hexdigest()[:10]
    expected = (a + b if image else 0) + (c + d if file else 0)
    if not image and not file:
        expected = 78
    if file:
        (directory / "input.txt").write_text(f"value_a={c}\nvalue_b={d}\nnonce={nonce}\n", encoding="utf-8")
    if image:
        from PIL import Image, ImageDraw, ImageFont
        picture = Image.new("RGB", (360, 160), "white")
        font_path = Path("C:/Windows/Fonts/arial.ttf")
        font = ImageFont.truetype(str(font_path), 48) if font_path.exists() else ImageFont.load_default()
        ImageDraw.Draw(picture).text((30, 45), f"{a} + {b}", fill="black", font=font)
        picture.save(directory / "image.png")
    instructions = ["This is an isolated capability test. Do not browse, use network tools, read credentials or inspect paths outside the current test directory."]
    if image:
        instructions.append("Inspect image.png (or the attached image) and calculate the sum of the two numbers displayed in its pixels. Do not infer values from filenames.")
    if file:
        instructions.append("Read input.txt (or its attached contents), add value_a and value_b, and use its nonce exactly.")
    else:
        instructions.append("Use nonce=" + nonce + ".")
    if image and file:
        instructions.append("Add the image sum and the input.txt sum to obtain one total.")
    if not image and not file:
        instructions.append("Compute 31+47 without tools.")
    if file:
        instructions.append('Write output.json in this current test directory with {"total": the computed total, "nonce": the exact nonce}.')
    instructions.append('The final answer must be only JSON {"total": the computed total, "nonce": the exact nonce}.')
    return "\n".join(instructions), expected, nonce

def argv_for(worker, prompt, cwd, thinking, stream, image, file):
    env = dict(os.environ)
    stdin = None
    if worker.startswith("codebuddy"):
        env.update({"CODEBUDDY_CONFIG_DIR": str(HOME / (".codebuddy-cn" if worker.endswith("-cn") else ".codebuddy")), "DISABLE_AUTOUPDATER": "1", "MAX_THINKING_TOKENS": "4096" if thinking else "0", "CODEBUDDY_MAX_RETRIES": "0"})
        if worker.endswith("-cn"):
            env["CODEBUDDY_INTERNET_ENVIRONMENT"] = "internal"
        else:
            env.pop("CODEBUDDY_INTERNET_ENVIRONMENT", None)
        argv = [str(NODE), str(CB), "-p", prompt, "--model", MODELS[worker], "--output-format", "stream-json" if stream else "json", "--tools", "Read,Write" if image or file else "", "--allowedTools", "Read", "Write", "--permission-mode", "acceptEdits", "--max-turns", "5", "--setting-sources", "user"]
        argv += ["--settings", json.dumps({"alwaysThinkingEnabled": bool(thinking)}, separators=(",", ":"))]
        if stream:
            argv += ["--include-partial-messages"]
    elif worker == "github-copilot":
        argv = [str(COPILOT), "-p", prompt, "--model", "auto", "--reasoning-effort", "high" if thinking else "none", "--stream", "on" if stream else "off", "--output-format", "json", "--silent", "--no-custom-instructions", "--disable-builtin-mcps", "--no-auto-update", "--no-color", "--log-dir", str(cwd / "cli-logs"), "--deny-tool=shell", "--allow-tool=read,write"]
        if image:
            argv += ["--attachment", str(cwd / "image.png")]
        # Copilot's native document attachment rejects .txt; ordinary files are
        # read through view in the isolated cwd, while PNG uses --attachment.
    elif worker == "mimocode":
        env["MIMOCODE_CONFIG_CONTENT"] = json.dumps({"provider": {"xiaomi": {"models": {"mimo-v2.6-flash": {"options": {"thinking": {"type": "enabled" if thinking else "disabled"}}}}}}, "permission": {"read": "allow", "edit": "allow", "bash": "deny", "webfetch": "deny", "websearch": "deny", "external_directory": "deny"}})
        argv = [str(NODE), str(MIMO), "run", "--pure", "--model", MODELS[worker], "--format", "json", "--thinking", prompt]
        if image:
            argv += ["--file", str(cwd / "image.png")]
        if file:
            argv += ["--file", str(cwd / "input.txt")]
    elif worker == "minimaxcode":
        content = [{"type": "text", "text": prompt}]
        if file:
            content.append({"type": "text", "text": "input.txt contents:\n" + (cwd / "input.txt").read_text(encoding="utf-8")})
        if image:
            content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64.b64encode((cwd / "image.png").read_bytes()).decode()}})
        message_file = cwd / "messages.json"
        message_file.write_text(json.dumps([{"role": "user", "content": content}]), encoding="utf-8")
        argv = [str(NODE), str(MMX), "text", "chat", "--model", MODELS[worker], "--messages-file", str(message_file), "--output", "text" if stream else "json", "--max-tokens", "4096", "--timeout", "90", "--non-interactive", "--no-color"]
        if stream:
            argv.append("--stream")
    elif worker == "zcode":
        candidates = list((HOME / ".zcode/v2/runtime/provider/windows-x86_64/3.14.4").glob("*/zcode-builtin.json"))
        if candidates:
            env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"] = str(candidates[0])
        argv = [str(NODE), str(ZCODE), "--cwd", str(cwd), "--mode", os.environ.get("ZCODE_PROBE_MODE") or ("build" if file else "plan"), "--disallowed-tools", "Bash,WebSearch,WebFetch,Task,Agent", "--json", "--prompt", prompt]
        if image:
            argv += ["--attach", str(cwd / "image.png")]
        if file:
            argv += ["--attach", str(cwd / "input.txt")]
    elif worker == "traecode":
        argv = [str(TRAE), "--ask-for-approval", "never", "exec", "--model", MODELS[worker], "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write", "--json", "--config", 'model_reasoning_effort="high"' if thinking else 'model_reasoning_effort="none"', "--output-last-message", str(cwd / "last-message.txt")]
        if image:
            argv += ["--image", str(cwd / "image.png")]
        argv.append(prompt)
    elif worker == "antigravity":
        argv = [str(AGY), "--model", MODELS[worker], "--mode", "accept-edits" if file else "plan", "--sandbox", "--disable-slash-commands", "--print-timeout", "50s", "--log-file", str(cwd / "agy.log"), "--output-format", "stream-json" if stream else "json"]
        if thinking:
            argv += ["--effort", "medium"]
        argv += ["-p", prompt]
    else:
        raise ValueError("Unknown worker")
    return argv, env, stdin

def extract_public(stdout):
    events = []
    text_answers = []
    usage = []
    def visit(value):
        if isinstance(value, dict):
            typ = value.get("type")
            if isinstance(typ, str):
                events.append(typ)
            for key in ("result", "response", "text", "deltaContent", "content"):
                if isinstance(value.get(key), str) and typ not in ("reasoning", "thinking", "reasoning-delta", "assistant.reasoning", "assistant.reasoning_delta"):
                    text_answers.append(value[key])
            for key in ("usage", "tokens"):
                if isinstance(value.get(key), dict):
                    usage.append(value[key])
            for child in value.values():
                if isinstance(child, (dict, list)):
                    visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    try:
        visit(json.loads(stdout))
    except ValueError:
        for line in stdout.splitlines():
            try:
                visit(json.loads(line))
            except ValueError:
                pass
    return events, text_answers, usage


def verify_final(text, expected, nonce):
    """Validate only a parser-selected public answer, never CLI raw events."""
    candidates = []
    strict = False
    try:
        candidates.append(json.loads(text.strip()))
        strict = True
    except ValueError:
        decoder = json.JSONDecoder()
        for match in re.finditer(r"\{", text):
            try:
                value, _ = decoder.raw_decode(text[match.start():])
                if isinstance(value, dict) and "total" in value and "nonce" in value:
                    candidates.append(value)
            except ValueError:
                pass
    expected_value = {"total": expected, "nonce": nonce}
    verified = bool(candidates) and all(value == expected_value for value in candidates)
    return verified, strict and verified, candidates[-1] if candidates else None

def probe(worker, bits, output_root, timeout):
    thinking, stream, image, file = bits
    case = f"{worker}-t{int(thinking)}s{int(stream)}i{int(image)}f{int(file)}"
    cwd = output_root / case
    prompt, expected, nonce = fixture(cwd, image, file)
    argv, env, stdin = argv_for(worker, prompt, cwd, *bits)
    started = time.monotonic()
    proc = spawn_owned(argv, cwd=str(cwd), env=env, stdin=subprocess.PIPE if stdin else subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    chunks = {"stdout": [], "stderr": []}
    timing = {"stdout": [], "stderr": []}
    def consume(channel):
        handle = getattr(proc, channel)
        while True:
            data = handle.read1(4096)
            if not data:
                break
            chunks[channel].append(data)
            timing[channel].append(round(time.monotonic() - started, 3))
    threads = [threading.Thread(target=consume, args=(name,), daemon=True) for name in chunks]
    for thread in threads:
        thread.start()
    timed_out = False
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
    finally:
        terminate_owned(proc)
        for thread in threads:
            thread.join(timeout=5)
    raw = {name: b"".join(data).decode("utf-8", errors="replace") for name, data in chunks.items()}
    for name, data in raw.items():
        (cwd / (name + ".raw.log")).write_text(data, encoding="utf-8")
    events, answers, usage = extract_public(raw["stdout"])
    parsed = parse_output(raw["stdout"])
    matched, strict_json, final_json = verify_final(parsed["text"], expected, nonce)
    matched = matched and parsed["error"] is None
    answer_strings = [json.dumps(final_json)] if matched else []
    artifact = None
    if (cwd / "output.json").is_file():
        try:
            artifact = json.loads((cwd / "output.json").read_text(encoding="utf-8-sig"))
        except ValueError:
            artifact = "invalid JSON"
    file_verified = not file or artifact == {"total": expected, "nonce": nonce}
    status = "passed" if proc.returncode == 0 and matched and file_verified and not timed_out else "timeout" if timed_out else "failed"
    diagnostic = sanitize(raw["stderr"] + "\n" + (parsed["error"] or ""))
    if status != "passed" and re.search(r"Authentication required|No credentials found|not logged in|login required|failed to fetch.*token|SSO|Codebase.*authentication failed|sso/i", diagnostic, re.I):
        status = "blocked_auth"
    elif status != "passed" and re.search(r"location is not supported|region.*not supported", diagnostic, re.I):
        status = "blocked_region"
    result = {"worker": worker, "requested_model": MODELS[worker], "thinking": thinking, "stream": stream, "image": image, "file": file, "case": case, "argv": argv, "cwd": str(cwd), "status": status, "exit_code": proc.returncode, "timed_out": timed_out, "elapsed_seconds": round(time.monotonic()-started,3), "expected": {"total": expected, "nonce": nonce}, "answer_verified": matched, "written_artifact_verified": file_verified, "artifact": artifact, "stdout_chunks": len(timing["stdout"]), "stdout_timing": timing["stdout"], "event_types": sorted(set(events)), "delta_events": sum(typ in ("stream_event", "text_delta", "text-delta", "assistant.message_delta", "content_block_delta") for typ in events), "usage": usage[-6:], "answer_evidence": answer_strings[-1:]}
    result["public_usage"] = parse_usage(raw["stdout"])
    result["strict_json_answer"] = strict_json
    result["verification_source"] = "parse_output-selected public final text only; never raw event/tool/reasoning content"
    if worker == "minimaxcode" and file and matched and not file_verified:
        result["status"] = "unsupported_native_file_write"
        result["file_input_mode"] = "host reads fixture and supplies its contents in text blocks; CLI has no local filesystem tools"
    if status != "passed":
        # Keep only bounded error-shaped diagnostics, never reasoning bodies or account data.
        result["diagnostic"] = sanitize(raw["stderr"])[-2000:]
        result["output_tail"] = "Raw output retained outside repository; only public error diagnostics, event types and usage are reported."
    (cwd / "public-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"case":case,"status":result["status"],"answer_verified":matched,"written_artifact_verified":file_verified,"seconds":result["elapsed_seconds"]}), flush=True)
    return result

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", default=",".join(MODELS))
    parser.add_argument("--cases", default="0000,1111", help="thinking/stream/image/file bits")
    parser.add_argument("--timeout", type=float, default=100)
    parser.add_argument("--parallel", type=int, default=3)
    parser.add_argument("--output", default="docs/live-workers-windows.json")
    args = parser.parse_args()
    workers = args.workers.split(",")
    if any(worker not in MODELS for worker in workers):
        raise ValueError("Unknown worker")
    cases = [tuple(char == "1" for char in case) for case in args.cases.split(",")]
    if any(len(case) != 4 or re.fullmatch("[01]{4}", case) is None for case in args.cases.split(",")):
        raise ValueError("Invalid case bits")
    output_root = Path(tempfile.mkdtemp(prefix="agenthub-live-workers-"))
    results = []
    report = {"platform":"Windows", "real_calls":True, "raw_log_root":str(output_root), "scope":"CLI computation, real fixture image/file input, output artifact; bit requests are not claims of supported thinking/transport", "results":results}
    with ThreadPoolExecutor(max_workers=args.parallel) as pool:
        future_map = {pool.submit(probe,worker,bits,output_root,args.timeout):worker for worker,bits in itertools.product(workers,cases)}
        for future in as_completed(future_map):
            try:
                results.append(future.result())
            except Exception as error:
                results.append({"worker":future_map[future],"status":"probe_error","error":sanitize(error)})
            Path(args.output).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
