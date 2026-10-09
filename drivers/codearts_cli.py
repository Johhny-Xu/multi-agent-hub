#!/usr/bin/env python3
"""Strict adapter for the installed Huawei CodeArts CLI / IDE AgentKernel.

Only public CLI operations are used. Credentials stay in CodeArts' own store.
Each invocation has a separate SQLite session database and never resumes an IDE
session. The CLI emits completed text parts, not token deltas; streaming and
reasoning switches are deliberately unavailable on this transport.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time
from typing import Callable


MODEL_ID = re.compile(r"[A-Za-z0-9_.:-]+/[A-Za-z0-9_.:/-]+\Z")
TEXT_SUFFIXES = {".txt", ".md", ".rst", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".csv", ".tsv", ".xml", ".html", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".sh", ".ps1", ".sql", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".log"}
MAX_OUTPUT = 16 * 1024 * 1024


class AdapterError(Exception):
    def __init__(self, code: str, status: str = "failed"):
        super().__init__(code)
        self.code, self.status = code, status


def discover_cli(*, home: Path | str | None = None, env=None) -> str | None:
    """Find CodeArts itself, never an unrelated `opencode` installation."""
    env = os.environ if env is None else env
    home = Path(home or Path.home())
    explicit = env.get("AGENTHUB_CODEARTS_CLI")
    if explicit:
        path = Path(explicit).expanduser()
        return str(path.resolve()) if path.is_file() else None
    candidates = []
    on_path = shutil.which("codearts", path=env.get("PATH", ""))
    if on_path:
        candidates.append(Path(on_path))
    candidates.extend((home / ".local/bin/codearts", home / ".codeartsdoer/installers/codearts", home / ".codeartsdoer/installers/bin/codearts"))
    # The IDE copies its official kernel here. Pick the most recently installed
    # kernel, avoiding assumptions about vendor version-number widths.
    kernel_dir = home / ".codeartsdoer/CodeArts_Agent"
    if kernel_dir.is_dir():
        candidates.extend(sorted((p for p in kernel_dir.glob("AgentKernel_*") if p.is_file()), key=lambda p: p.stat().st_mtime, reverse=True))
    for path in candidates:
        if path.is_file() and path.suffix.lower() not in {".cmd", ".bat", ".ps1"}:
            return str(path.absolute())
    return None


def describe_runtime(cli: str | None = None, **discovery) -> dict:
    path = cli or discover_cli(**discovery)
    return {"installed": bool(path and Path(path).is_file()), "cli": path,
            "transport": "official-cli", "stream": False, "thinking": False,
            "images": False, "files": "utf8-text", "authentication": "official-cli-required",
            "ide_login_implies_cli_login": False}


def envelope(status="failed", text="", code=None, model="", session_id=None):
    ok = status == "completed"
    value = {"type": "result", "is_error": not ok, "status": status,
             "subtype": "success" if ok else "error_" + (code or status).lower(),
             "result": text if ok else "", "model": model}
    if session_id:
        value["session_id"] = session_id
    if not ok:
        value["error"] = {"code": code or status, "message": code or status}
    return value


def diagnostic_error(text: str) -> AdapterError | None:
    """Classify vendor diagnostics without forwarding private log contents."""
    if re.search(r"认证失败|CODEARTS_CLI_AK|CODEARTS_CLI_SK|authentication (?:required|failed)|unauthorized|not logged in|invalid (?:api[ _-]?key|credential)", text, re.I):
        return AdapterError("CODEARTS_AUTH_REQUIRED", "blocked_auth")
    if re.search(r"no providers found|provider[^\r\n]{0,80}(?:not found|unavailable)", text, re.I):
        return AdapterError("CODEARTS_PROVIDER_UNAVAILABLE", "blocked_auth")
    if re.search(r"(?:model[^\r\n]{0,80}(?:not found|unavailable)|ProviderModelNotFoundError)", text, re.I):
        return AdapterError("CODEARTS_MODEL_UNAVAILABLE", "blocked_model")
    if re.search(r"permission requested:[^\r\n]*auto-rejecting|permission[^\r\n]{0,80}(?:denied|rejected)", text, re.I):
        return AdapterError("CODEARTS_PERMISSION_REQUIRED", "blocked_permission")
    return None


def parse_model_catalog(stdout: str) -> set[str]:
    """Read single IDs or the official CLI's model_id/model_name tables.

    A table row is accepted only after its exact header and ruler. Splitting
    arbitrary diagnostic lines on whitespace would mistake model mentions for
    an available model.
    """
    catalog, column, pending = set(), None, None
    for line in stdout.splitlines():
        if MODEL_ID.fullmatch(line.strip()):
            catalog.add(line.strip())
            continue
        if re.fullmatch(r"model_id +model_name", line):
            pending, column = line.index("model_name"), None
            continue
        if line == "model_idmodel_name":
            # padEnd does not truncate the header for provider IDs as short as
            # p/m. The official ruler still carries the actual column width.
            pending, column = -1, None
            continue
        if pending is not None:
            if pending == -1:
                column = len(line) - 10 if re.fullmatch(r"-{15,18}", line) else None
            else:
                column = pending if line == "-" * (pending + 10) else None
            pending = None
            continue
        if column is not None:
            identifier = line[:column].rstrip(" ")
            if (MODEL_ID.fullmatch(identifier) and len(identifier) <= column - 2
                    and line[len(identifier):column] == " " * (column - len(identifier))
                    and not any(ord(char) < 32 or ord(char) == 127 for char in line)):
                catalog.add(identifier)
                continue
        column = None
    return catalog


def parse_events(stdout: str, stderr: str, returncode: int, model="") -> dict:
    """Accept one fresh session with an explicit completed final model step."""
    records, diagnostics = [], [stderr]
    for line in stdout.splitlines():
        try:
            record = json.loads(line)
        except (ValueError, TypeError):
            diagnostics.append(line)
            continue
        if isinstance(record, dict):
            records.append(record)
    error = diagnostic_error("\n".join(diagnostics))
    if error:
        return envelope(error.status, code=error.code, model=model)
    session, parts, completed, protocol_error = None, {}, False, False
    for record in records:
        typ = record.get("type")
        if typ not in {"text", "reasoning", "tool_use", "step_start", "step_finish", "error"}:
            continue
        current = record.get("sessionID")
        if not isinstance(current, str) or not current:
            protocol_error = True
            continue
        if session is not None and current != session:
            return envelope(code="CODEARTS_MULTIPLE_SESSIONS", model=model)
        session = current
        part = record.get("part", {})
        if typ == "error":
            error = diagnostic_error(json.dumps(record.get("error", {}), ensure_ascii=False))
            return envelope(error.status if error else "failed", code=error.code if error else "CODEARTS_PROVIDER_ERROR", model=model, session_id=session)
        if not isinstance(part, dict):
            protocol_error = True
            continue
        if part.get("sessionID", current) != current:
            protocol_error = True
            continue
        if typ == "step_start":
            completed = False
        elif typ == "step_finish":
            completed = part.get("reason") == "stop"
        elif typ == "text":
            if not isinstance(part.get("text"), str) or not isinstance(part.get("id"), str):
                protocol_error = True
                continue
            parts[part["id"]] = part["text"]
        elif typ == "tool_use":
            state = part.get("state", {})
            if isinstance(state, dict) and state.get("status") == "error":
                denied = diagnostic_error(str(state.get("error", "")))
                if denied and denied.status == "blocked_permission":
                    return envelope(denied.status, code=denied.code, model=model, session_id=session)
    if returncode != 0:
        return envelope(code="CODEARTS_PROCESS_FAILED", model=model, session_id=session)
    if protocol_error:
        return envelope(code="CODEARTS_INVALID_EVENTS", model=model, session_id=session)
    text = "".join(parts.values())
    if not text.strip():
        return envelope(code="CODEARTS_EMPTY_RESPONSE", model=model, session_id=session)
    if not completed:
        return envelope("unknown", code="CODEARTS_COMPLETION_NOT_CONFIRMED", model=model, session_id=session)
    return envelope("completed", text=text, model=model, session_id=session)


def runtime_environment(cli: Path, runtime: Path, *, env=None, home=None) -> dict:
    result = dict(os.environ if env is None else env)
    home = Path(home or Path.home())
    if cli.name.startswith("AgentKernel_"):
        config = home / ".codeartsdoer"
        data = config / "codearts-data"
        result.update(SCENARIO="codeartsdoer", PLUGIN_ENV="hc", IS_PROD="true",
                      KERNEL_CONFIG_DIR=str(config), KERNEL_DATA_DIR=str(data),
                      OPENCODE_CONFIG=str(data / "codearts.json"), OPENCODE_CONFIG_FILE="codearts.json")
    # Prevent accidentally opening or migrating a different installed OpenCode
    # database. Official credentials are neither read nor copied by this code.
    result.update(OPENCODE_DB=str(runtime / "session.db"), KERNEL_LOG_DIR=str(runtime / "log"),
                  OPENCODE_STORAGE_DIR=str(runtime / "storage"), OPENCODE_DISABLE_SHARE="true",
                  OPENCODE_DISABLE_AUTO_SHARE="true", OPENCODE_DISABLE_AUTOUPDATE="true",
                  CODEARTS_DISABLE_AUTO_UPDATE="true", AGENTHUB_WORKER_ID="codearts", NO_COLOR="1")
    result.pop("OPENCODE_AUTO_SHARE", None)
    return result


def _terminate_owned(child: subprocess.Popen):
    if child.poll() is not None:
        return
    if os.name == "nt":
        # Only the fresh child still owned by this Popen is eligible.
        subprocess.run(["taskkill.exe", "/PID", str(child.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, creationflags=subprocess.CREATE_NO_WINDOW, check=False)
    else:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if child.poll() is None:
        child.kill()
    child.wait(timeout=5)


def _capture(command, *, cwd, env, timeout, stdin=""):
    # Disk-backed private capture bounds memory and prevents raw vendor logs or
    # credentials from reaching the Hub output stream.
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        child = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE,
                                 stdout=out, stderr=err, shell=False,
                                 start_new_session=os.name != "nt",
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        try:
            child.communicate(stdin.encode("utf-8"), timeout=timeout)
        except subprocess.TimeoutExpired:
            _terminate_owned(child)
            raise AdapterError("CODEARTS_TIMEOUT", "timeout") from None
        except BaseException:
            _terminate_owned(child)
            raise
        if out.tell() + err.tell() > MAX_OUTPUT:
            raise AdapterError("CODEARTS_OUTPUT_LIMIT")
        out.seek(0)
        err.seek(0)
        return out.read().decode("utf-8", errors="replace"), err.read().decode("utf-8", errors="replace"), child.returncode


def _validate_files(attachments):
    if len(attachments) > 8:
        raise AdapterError("CODEARTS_TOO_MANY_ATTACHMENTS")
    paths = []
    for value in attachments:
        path = Path(value)
        if not path.is_absolute() or not path.is_file():
            raise AdapterError("CODEARTS_INVALID_ATTACHMENT")
        if path.suffix.lower() not in TEXT_SUFFIXES:
            raise AdapterError("CODEARTS_UNSUPPORTED_ATTACHMENT")
        if re.fullmatch(r"(?:auth|credentials|tokens?)\.(?:json|ya?ml)", path.name, re.I) or path.name.startswith(".env"):
            raise AdapterError("CODEARTS_CREDENTIAL_ATTACHMENT_DENIED")
        if path.stat().st_size > 10 * 1024 * 1024:
            raise AdapterError("CODEARTS_ATTACHMENT_TOO_LARGE")
        try:
            text = path.read_bytes().decode("utf-8-sig")
        except UnicodeError:
            raise AdapterError("CODEARTS_ATTACHMENT_NOT_UTF8") from None
        if "\0" in text:
            raise AdapterError("CODEARTS_UNSUPPORTED_ATTACHMENT")
        paths.append(str(path.resolve()))
    return paths


def run_task(*, task, cli=None, model="", timeout=300, stream="off", thinking="default", attachments=(), cwd=None, capture: Callable | None = None, env=None):
    capture = capture or _capture
    try:
        if not isinstance(task, str) or not task.strip():
            raise AdapterError("CODEARTS_TASK_REQUIRED")
        if thinking != "default":
            raise AdapterError("CODEARTS_UNSUPPORTED_THINKING")
        if stream != "off":
            raise AdapterError("CODEARTS_UNSUPPORTED_STREAM")
        if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not math.isfinite(timeout) or timeout <= 0:
            raise AdapterError("CODEARTS_INVALID_TIMEOUT")
        if model and not MODEL_ID.fullmatch(model):
            raise AdapterError("CODEARTS_MODEL_MUST_INCLUDE_PROVIDER", "blocked_model")
        path = cli or discover_cli(env=env)
        if not path or not Path(path).is_absolute() or not Path(path).is_file():
            raise AdapterError("CODEARTS_CLI_NOT_FOUND", "blocked_install")
        path = Path(path)
        if path.suffix.lower() in {".cmd", ".bat", ".ps1"}:
            raise AdapterError("CODEARTS_UNSUPPORTED_SHELL_LAUNCHER", "blocked_install")
        workdir = Path(cwd or os.getcwd()).resolve()
        if not workdir.is_dir():
            raise AdapterError("CODEARTS_INVALID_WORKDIR")
        files = _validate_files(attachments)
        deadline = time.monotonic() + timeout
        with tempfile.TemporaryDirectory(prefix="agenthub-codearts-task-") as temp:
            runtime = Path(temp)
            child_env = runtime_environment(path, runtime, env=env)
            if model:
                stdout, stderr, code = capture([str(path), "models", "--pure"], cwd=str(workdir), env=child_env, timeout=max(0.001, deadline - time.monotonic()))
                error = diagnostic_error(stdout + "\n" + stderr)
                if error:
                    raise error
                catalog = parse_model_catalog(stdout)
                if code or model not in catalog:
                    raise AdapterError("CODEARTS_MODEL_UNAVAILABLE", "blocked_model")
            # Linux 26.9.12 lacks --dir; setting the child process cwd works on
            # both official runtimes without relying on that newer option.
            command = [str(path), "run", "--pure", "--format", "json", "--title", "multi-agent-hub task"]
            if model:
                command.extend(("--model", model))
            for file in files:
                command.extend(("--file", file))
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AdapterError("CODEARTS_TIMEOUT", "timeout")
            stdout, stderr, code = capture(command, cwd=str(workdir), env=child_env, timeout=remaining, stdin=task)
            return parse_events(stdout, stderr, code, model)
    except AdapterError as error:
        return envelope(error.status, code=error.code, model=model)
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        return envelope(code="CODEARTS_ADAPTER_FAILED", model=model)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task")
    parser.add_argument("--cli")
    parser.add_argument("--model", default="")
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument("--stream", choices=("on", "off"), default="off")
    parser.add_argument("--thinking", choices=("default", "on", "off"), default="default")
    parser.add_argument("--attach", action="append", default=[])
    parser.add_argument("--cwd")
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args(argv)
    if args.probe:
        print(json.dumps(describe_runtime(args.cli), ensure_ascii=False))
        return 0
    result = run_task(task=args.task, cli=args.cli, model=args.model, timeout=args.timeout,
                      stream=args.stream, thinking=args.thinking, attachments=args.attach, cwd=args.cwd)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 1 if result["is_error"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
