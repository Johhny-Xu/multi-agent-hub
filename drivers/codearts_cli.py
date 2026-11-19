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

# 不再有固定时长上限（原来 900s 无进展 + 3600s 总时长，长时间只思考不输出的任务会被误判超时）。
# 现在每 ~30s 做一次状态查询：进程树是否还在、CPU 时间是否增长、是否有读写字节（/proc/<pid>/io）、
# 是否有到模型的网络连接、是否有新输出。只有在「卡住窗口」内上述全都没有，才判定卡住（CODEARTS_STUCK）。
# 卡住窗口默认 30 分钟：AGENTHUB_CODEARTS_STUCK_SEC（秒）或 OMB_TURN_STUCK_MS（毫秒）可改，0 = 永不判定。
# --timeout 参数现在就是这个卡住窗口（秒）。
def _env_seconds(names, fallback):
    for name in names:
        raw = (os.environ.get(name) or "").strip()
        if not raw:
            continue
        try:
            value = float(raw)
        except ValueError:
            continue
        if not math.isfinite(value):
            continue
        if value <= 0:
            return 0.0
        return value / 1000.0 if name.endswith("_MS") else value
    return fallback


DEFAULT_STUCK_SEC = _env_seconds(("AGENTHUB_CODEARTS_STUCK_SEC", "OMB_CODEARTS_STUCK_MS", "OMB_TURN_STUCK_MS"), 1800.0)
# 兼容旧名字：--timeout 的默认值。
DEFAULT_TIMEOUT_SEC = DEFAULT_STUCK_SEC
# 总时长上限默认关闭；只有显式设置 AGENTHUB_CODEARTS_MAX_SEC（或 OMB_TURN_MAX_MS）才启用。
MAX_TOTAL_SEC = _env_seconds(("AGENTHUB_CODEARTS_MAX_SEC", "OMB_TURN_MAX_MS"), 0.0)
# 模型目录查询（`codearts models`）是一次性的列表请求，不是任务，仍然用普通超时。
MODEL_QUERY_TIMEOUT_SEC = 300.0
# 状态查询间隔（秒）；窗口很短时（测试）按窗口的 1/4 查询。
LIVENESS_TICK_SEC = 30.0
# CPU 增量低于「单核 1%」视为运行时空转（定时器），不算干活。
CPU_ACTIVE_SHARE = 0.01
CPU_ACTIVE_FLOOR_SEC = 0.1

# 工具调用审批模式。
#   --pure 是无交互 headless，没有任何人可以批权限：CLI 会把每次 write/edit/bash
#   都打成 `permission requested: …; auto-rejecting`，于是「写个网页」这类任务
#   必然失败（归类 CODEARTS_PERMISSION_REQUIRED）。
#   CLI 的 `--auto`（always_allow）能让工具调用不再逐次申请，但那是把审批门整个
#   拿掉，所以必须显式开启，默认保持关闭。
AUTO_PERMISSION_ENV = "AGENTHUB_CODEARTS_AUTO"
_AUTO_TRUTHY = {"1", "true", "yes", "on", "auto", "always_allow", "always-allow"}
_AUTO_FALSY = {"0", "false", "no", "off", "ask"}

# 为什么只有 bash 能用：`codearts run`（headless）的事件循环里，
# **任何** permission.asked 都被硬编码成 `reply: "reject"`，`--auto` 只是把 bash
# 设成 always_allow（源码里就是 setBashModeWithoutPersist("always_allow")）。
# write/edit 没有对应的放行开关，所以模型必须先知道「落盘走 shell」，否则它会在
# write 上吃一次拒绝、然后放弃并向用户反问（实测 2026-11-03）。
SHELL_ONLY_NOTE = (
    "[运行环境] 本通道只有 bash 被放行；write/edit 工具会被自动拒绝。"
    "创建或修改文件请直接用 bash（如 cat > 文件 <<'EOF' … EOF / tee），"
    "不要因为这个权限限制停下来向用户确认。"
)



class AdapterError(Exception):
    def __init__(self, code: str, status: str = "failed", **detail):
        super().__init__(code)
        self.code, self.status = code, status
        self.detail = {key: value for key, value in detail.items() if value is not None}


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
    candidates.extend((home / ".local/bin/codearts", home / ".codeartsdoer/installers/bin/codearts.exe",
                       home / ".codeartsdoer/installers/codearts", home / ".codeartsdoer/installers/bin/codearts"))
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


def envelope(status="failed", text="", code=None, model="", session_id=None, detail=None):
    ok = status == "completed"
    value = {"type": "result", "is_error": not ok, "status": status,
             "subtype": "success" if ok else "error_" + (code or status).lower(),
             "result": text if ok else "", "model": model}
    if session_id:
        value["session_id"] = session_id
    if not ok:
        value["error"] = {"code": code or status, "message": code or status, **(detail or {})}
    return value


def diagnostic_error(text: str) -> AdapterError | None:
    """Classify vendor diagnostics without forwarding private log contents."""
    if re.search(r"认证失败|CODEARTS_CLI_AK|CODEARTS_CLI_SK|authentication (?:required|failed)|unauthorized|not logged in|invalid (?:api[ _-]?key|credential)", text, re.I):
        return AdapterError("CODEARTS_AUTH_REQUIRED", "blocked_auth")
    if re.search(r"no providers found|provider[^\r\n]{0,80}(?:not found|unavailable)", text, re.I):
        return AdapterError("CODEARTS_PROVIDER_UNAVAILABLE", "blocked_auth")
    if re.search(r"(?:model[^\r\n]{0,80}(?:not found|unavailable)|ProviderModelNotFoundError)", text, re.I):
        return AdapterError("CODEARTS_MODEL_UNAVAILABLE", "blocked_model")
    if re.search(r"文件夹未被信任|permission requested:[^\r\n]*auto-rejecting|permission[^\r\n]{0,80}(?:denied|rejected)|the user rejected permission", text, re.I):
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


def parse_events(stdout: str, stderr: str, returncode: int, model="", *, permission_is_fatal: bool = True) -> dict:
    """Accept one fresh session with an explicit completed final model step.

    `permission_is_fatal=False` 只在 `--auto`（always_allow）下使用：
    那种模式里偶发一次 `permission requested … auto-rejecting` 是**可恢复的**
    （CLI 会自己重试并最终完成），若仍按致命处理，明明写成功的任务会被报成
    CODEARTS_PERMISSION_REQUIRED。关闭时不改语义：权限被拒就是任务失败。
    """
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
    permission_seen = bool(error and error.status == "blocked_permission")
    if error and not (permission_seen and not permission_is_fatal):
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
                    permission_seen = True
                    if permission_is_fatal:
                        return envelope(denied.status, code=denied.code, model=model, session_id=session)
    if returncode != 0:
        return envelope(code="CODEARTS_PROCESS_FAILED", model=model, session_id=session)
    if protocol_error:
        return envelope(code="CODEARTS_INVALID_EVENTS", model=model, session_id=session)
    text = "".join(parts.values())
    if not text.strip():
        # 没有正文时，权限被拒才是真因（否则会被误报成「空回复」）
        if permission_seen:
            return envelope("blocked_permission", code="CODEARTS_PERMISSION_REQUIRED", model=model, session_id=session)
        return envelope(code="CODEARTS_EMPTY_RESPONSE", model=model, session_id=session)
    if not completed:
        if permission_seen and not permission_is_fatal:
            return envelope("blocked_permission", code="CODEARTS_PERMISSION_REQUIRED", model=model, session_id=session)
        return envelope("unknown", code="CODEARTS_COMPLETION_NOT_CONFIRMED", model=model, session_id=session)
    return envelope("completed", text=text, model=model, session_id=session)


def auth_env_path(env=None, home=None) -> Path:
    env = os.environ if env is None else env
    override = env.get("CODEARTS_AUTH_ENV")
    if override:
        return Path(override)
    return Path(home or Path.home()) / ".config" / "agenthub-codearts" / "codearts-auth.env"


def _auth_env_flag(name: str, env=None, home=None) -> str:
    """Read one key from the deployment's auth env file (never exported anywhere)."""
    try:
        for line in auth_env_path(env, home).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key.strip() == name:
                return value.strip()
    except OSError:
        pass
    return ""


def auto_permission(env=None, home=None) -> bool:
    """Whether to pass `--auto` (always_allow) so tool calls stop asking for approval.

    Order: process env, then `<auth env file>` (so a deployment can opt in without
    touching the service supervisor). Anything unrecognised keeps the safe default.
    """
    env = os.environ if env is None else env
    raw = str(env.get(AUTO_PERMISSION_ENV, "") or "").strip().lower()
    if not raw:
        raw = _auth_env_flag(AUTO_PERMISSION_ENV, env, home).lower()
    if raw in _AUTO_FALSY:
        return False
    return raw in _AUTO_TRUTHY


def runtime_environment(cli: Path, runtime: Path, *, env=None, home=None) -> dict:
    result = dict(os.environ if env is None else env)
    home = Path(home or Path.home())
    auth_env = auth_env_path(result, home)
    if auth_env.is_file():
        try:
            for line in auth_env.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip()
                    if k and k not in result:
                        result[k] = v
        except OSError:
            pass
    if cli.name.startswith("AgentKernel_"):
        config = home / ".codeartsdoer"
        data = config / "codearts-data"
        result.update(SCENARIO="codeartsdoer", PLUGIN_ENV="hc", IS_PROD="true",
                      KERNEL_CONFIG_DIR=str(config), KERNEL_DATA_DIR=str(data),
                      OPENCODE_CONFIG=str(data / "codearts.json"), OPENCODE_CONFIG_FILE="codearts.json")
    elif cli.name.lower() in ("codearts.exe", "codearts"):
        # The official Windows installer exposes a .cmd wrapper, but this
        # adapter executes only the executable with shell=False. Mirror the
        # wrapper's CLI profile selection without disabling TLS verification.
        # The IDE kernel is a separate GUI build; pointing it at cli-data does
        # not turn it into the official CLI or initialize CLI authentication.
        config = home / ".codeartsdoer"
        result.update(SCENARIO="codeartsdoer", PLUGIN_ENV="hc", OPENCODE_MODE="tui",
                      KERNEL_CONFIG_DIR=str(config), KERNEL_DATA_DIR=str(config / "cli-data"),
                      OPENCODE_CONFIG=str(config / "codearts_cli.json"),
                      OPENCODE_CONFIG_FILE="codearts_cli.json,codearts_cli.jsonc",
                      OPENCODE_CHANNEL="latest", OPENCODE_DISABLE_MODELS_FETCH="1",
                      OPENCODE_ALWAYS_NOTIFY_UPDATE="false", KERNEL_ACP="",
                      CODEAGENT_USE_MESSAGE_FEEDBACK="false", OMO_SEND_ANONYMOUS_TELEMETRY="0")
    # Prevent accidentally opening or migrating a different installed OpenCode
    # database. Official credentials are neither read nor copied by this code.
    result.update(OPENCODE_DB=str(runtime / "session.db"), KERNEL_LOG_DIR=str(runtime / "log"),
                  OPENCODE_STORAGE_DIR=str(runtime / "storage"), OPENCODE_DISABLE_SHARE="true",
                  OPENCODE_DISABLE_AUTO_SHARE="true", OPENCODE_DISABLE_AUTOUPDATE="true",
                  CODEARTS_DISABLE_AUTO_UPDATE="true", AGENTHUB_WORKER_ID="codearts", NO_COLOR="1")
    result.pop("OPENCODE_AUTO_SHARE", None)
    return result


def _inherits_hub_group():
    # Standalone/library callers retain a private child group. The marker alone
    # is insufficient: only the session/group leader launched by spawn_owned
    # may keep its CLI in the enclosing Hub-owned group.
    if os.name == "nt" or os.environ.get("AGENTHUB_OWNED_POSIX_GROUP") != "1":
        return False
    pid = os.getpid()
    return os.getpgrp() == pid and os.getsid(0) == pid


def _terminate_owned(child: subprocess.Popen):
    if os.name == "nt":
        if child.poll() is not None:
            return
        # Only the fresh child still owned by this Popen is eligible.
        subprocess.run(["taskkill.exe", "/PID", str(child.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, creationflags=subprocess.CREATE_NO_WINDOW, check=False)
    else:
        pgid = getattr(child, "_agenthub_pgid", None)
        if pgid is not None:
            # Reclaim grandchildren even after the leader exits; consume the
            # private group once so repeated cleanup cannot signal a reused ID.
            child._agenthub_pgid = None
            try:
                os.killpg(pgid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        # In the inherited case only this direct child belongs to this Popen.
        # The Hub owns the enclosing group and reclaims it after driver exit,
        # including when the Hub cancels us before this finally block can run.
    if child.poll() is None:
        child.kill()
    child.wait(timeout=5)


def _read(path):
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        return handle.read()


def _loopback_peer(hexaddr: str) -> bool:
    addr = hexaddr.split(":")[0]
    if len(addr) == 8:
        return addr[6:8].upper() == "7F"
    if len(addr) == 32:
        upper = addr.upper()
        if upper == "00000000000000000000000001000000":
            return True
        if upper.startswith("0000000000000000FFFF0000"):
            return upper[30:32] == "7F"
    return False


def sample_tree(root: int, read=_read, listdir=os.listdir, readlink=os.readlink) -> dict:
    """Status query for one task's processes (Linux /proc): the tree under `root` plus `root`'s process group.

    Returns alive, cpu (s), io (bytes read+written), connections and external (non-loopback) connections; a value that
    cannot be read is None, never 0. Other platforms only learn whether the root is alive.
    """
    unknown = {"alive": None, "cpu": None, "io": None, "connections": None, "external": None}
    if not os.path.isdir("/proc") and listdir is os.listdir:
        try:
            os.kill(root, 0)
            unknown["alive"] = True
        except ProcessLookupError:
            unknown["alive"] = False
        except OSError:
            unknown["alive"] = True
        return unknown
    try:
        names = listdir("/proc")
    except OSError:
        return unknown
    rows = {}
    for name in names:
        if not name.isdigit():
            continue
        try:
            stat = read(f"/proc/{name}/stat")
        except OSError:
            continue
        fields = stat[stat.rfind(")") + 2:].split()
        try:
            rows[int(name)] = dict(ppid=int(fields[1]), pgrp=int(fields[2]), zombie=fields[0] == "Z",
                                   cpu=(int(fields[11]) + int(fields[12])) / 100.0)
        except (IndexError, ValueError):
            continue
    kids = {}
    for pid, row in rows.items():
        kids.setdefault(row["ppid"], []).append(pid)
    queue = [root] + [pid for pid, row in rows.items() if row["pgrp"] == root]
    members = set()
    while queue and len(members) < 1024:
        pid = queue.pop(0)
        if pid in members or pid not in rows:
            continue
        members.add(pid)
        queue.extend(kids.get(pid, ()))
    live = [pid for pid in members if not rows[pid]["zombie"]]
    if not live:
        return dict(unknown, alive=False)
    cpu = sum(rows[pid]["cpu"] for pid in members)
    io = 0
    sockets, namespaces = set(), {}
    for pid in live:
        if io is not None:
            try:
                text = read(f"/proc/{pid}/io")
                values = dict(line.split(":", 1) for line in text.splitlines() if ":" in line)
                io += int(values.get("rchar", 0)) + int(values.get("wchar", 0))
            except (OSError, ValueError):
                io = None
        try:
            namespaces.setdefault(readlink(f"/proc/{pid}/ns/net"), pid)
        except OSError:
            pass
        try:
            fds = listdir(f"/proc/{pid}/fd")
        except OSError:
            continue
        for fd in fds:
            try:
                target = readlink(f"/proc/{pid}/fd/{fd}")
            except OSError:
                continue
            if target.startswith("socket:["):
                sockets.add(target[8:-1])
    connections = external = 0
    readable, seen = False, set()
    for pid in (namespaces.values() or [root]):
        for table in ("tcp", "tcp6"):
            try:
                text = read(f"/proc/{pid}/net/{table}")
            except OSError:
                continue
            readable = True
            for line in text.splitlines()[1:]:
                cols = line.split()
                if len(cols) < 10 or cols[3] != "01" or cols[9] not in sockets or cols[9] in seen:
                    continue
                seen.add(cols[9])
                connections += 1
                if not _loopback_peer(cols[2]):
                    external += 1
    return {"alive": True, "cpu": cpu, "io": io,
            "connections": connections if readable else None, "external": external if readable else None}


def activity(previous: dict | None, sample: dict, span: float) -> list:
    """What moved between two status queries: cpu, io, network."""
    active = []
    if previous and sample.get("cpu") is not None and previous.get("cpu") is not None \
            and sample["cpu"] - previous["cpu"] >= max(CPU_ACTIVE_FLOOR_SEC, span * CPU_ACTIVE_SHARE):
        active.append("cpu")
    if previous and sample.get("io") is not None and previous.get("io") is not None and sample["io"] != previous["io"]:
        active.append("io")
    # A remote peer is a model request in flight; through a local proxy only moving bytes show it.
    if (sample.get("external") or 0) > 0 or (sample.get("io") is None and sample.get("external") is None
                                            and (sample.get("connections") or 0) > 0):
        active.append("network")
    return active


def _capture(command, *, cwd, env, timeout, stdin="", on_line: Callable | None = None, max_total: float | None = None,
             sampler: Callable | None = None, tick: float | None = None, clock: Callable = time.monotonic):
    """Run the CLI with disk-backed capture.

    `timeout` is the stuck window, not a time limit: every `tick` seconds the task's processes are queried (alive, CPU
    time, bytes read/written, model connections) and a new stdout line also counts; only a task that showed none of
    that for `timeout` seconds is stopped, as CODEARTS_STUCK. `timeout` 0/None = never. `max_total` is an opt-in
    absolute cap (CODEARTS_TIMEOUT). `on_line` sees each stdout line as it arrives so the caller can report progress.
    """
    import threading
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        private_group = os.name != "nt" and not _inherits_hub_group()
        child = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=err, shell=False,
                                 start_new_session=private_group,
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        child._agenthub_pgid = child.pid if private_group else None
        last = [clock()]
        size = [0]
        query = sampler or sample_tree
        window = float(timeout or 0)
        every = tick if tick is not None else max(0.05, min(LIVENESS_TICK_SEC, window / 4 if window > 0 else LIVENESS_TICK_SEC))

        def pump():
            for raw in iter(child.stdout.readline, b""):
                last[0] = clock()
                size[0] += len(raw)
                if size[0] <= MAX_OUTPUT:
                    out.write(raw)
                if on_line is not None:
                    try:
                        on_line(raw.decode("utf-8", errors="replace"))
                    except Exception:
                        pass

        reader = threading.Thread(target=pump, daemon=True)
        reader.start()
        started = clock()
        previous, checked_at = None, started
        try:
            try:
                if stdin:
                    child.stdin.write(stdin.encode("utf-8"))
                child.stdin.close()
            except (BrokenPipeError, OSError):
                pass
            while child.poll() is None:
                now = clock()
                if max_total and now - started > max_total:
                    raise AdapterError("CODEARTS_TIMEOUT", "timeout", max_s=round(max_total))
                if now - checked_at >= every:
                    try:
                        sample = query(child.pid)
                    except Exception:
                        sample = {}
                    if activity(previous, sample, now - checked_at):
                        last[0] = max(last[0], now)
                    previous, checked_at = sample, now
                    if window > 0 and now - last[0] >= window:
                        raise AdapterError("CODEARTS_STUCK", "timeout", quiet_s=round(now - last[0], 1),
                                           reason="no CPU, output or network activity")
                time.sleep(0.05)
            # A grandchild may still hold stdout after the CLI exits; never wait on it for long.
            reader.join(timeout=1)
        finally:
            _terminate_owned(child)
            reader.join(timeout=0.5)
        if size[0] + err.tell() > MAX_OUTPUT:
            raise AdapterError("CODEARTS_OUTPUT_LIMIT")
        out.seek(0)
        err.seek(0)
        return out.read().decode("utf-8", errors="replace"), err.read().decode("utf-8", errors="replace"), child.returncode


def progress_from_line(line: str) -> dict | None:
    """Turn one CLI event into a sanitized progress record (E116).

    Only the tool's name, its one-line title and status, and the model's own
    text parts are reported; tool input/output and vendor logs never are.
    """
    try:
        record = json.loads(line)
    except (ValueError, TypeError):
        return None
    if not isinstance(record, dict):
        return None
    part = record.get("part")
    if not isinstance(part, dict):
        return None
    typ = record.get("type")
    if typ == "tool_use":
        state = part.get("state") if isinstance(part.get("state"), dict) else {}
        status = state.get("status")
        metadata = state.get("metadata") if isinstance(state.get("metadata"), dict) else {}
        title = state.get("title") or metadata.get("description")
        tool = part.get("tool") if isinstance(part.get("tool"), str) else "tool"
        return {"type": "progress", "event": "tool", "id": str(part.get("callID") or part.get("id") or ""),
                "tool": tool, "title": str(title or tool)[:200],
                "status": status if status in {"pending", "running", "completed", "error"} else "running"}
    if typ == "text" and isinstance(part.get("text"), str) and part["text"].strip():
        return {"type": "progress", "event": "text", "id": str(part.get("id") or ""), "text": part["text"][:8000]}
    if typ == "step_start":
        return {"type": "progress", "event": "step"}
    return None


def _print_progress(line: str):
    value = progress_from_line(line)
    if value is not None:
        print(json.dumps(value, ensure_ascii=False), flush=True)


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


def run_task(*, task, cli=None, model="", timeout=DEFAULT_TIMEOUT_SEC, stream="off", thinking="default", attachments=(), cwd=None, capture: Callable | None = None, env=None, progress: bool = False):
    live = capture is None
    capture = capture or _capture
    try:
        if not isinstance(task, str) or not task.strip():
            raise AdapterError("CODEARTS_TASK_REQUIRED")
        if thinking != "default":
            raise AdapterError("CODEARTS_UNSUPPORTED_THINKING")
        if stream != "off":
            raise AdapterError("CODEARTS_UNSUPPORTED_STREAM")
        # timeout = the stuck window in seconds; 0 = never judge the task stuck.
        if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not math.isfinite(timeout) or timeout < 0:
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
        permission_auto = auto_permission(env)
        # 放开审批时补一句环境说明：write/edit 一定被拒，落盘只能走 bash。
        prompt = f"{task}\n\n{SHELL_ONLY_NOTE}" if permission_auto else task
        # 模型目录查询用普通超时；正式任务的 timeout 是卡住窗口，总时长上限默认关闭。
        query_timeout = MODEL_QUERY_TIMEOUT_SEC if live else (timeout or MODEL_QUERY_TIMEOUT_SEC)
        with tempfile.TemporaryDirectory(prefix="agenthub-codearts-task-") as temp:
            runtime = Path(temp)
            child_env = runtime_environment(path, runtime, env=env)
            if model:
                stdout, stderr, code = capture([str(path), "models", "--pure"], cwd=str(workdir), env=child_env, timeout=query_timeout)
                error = diagnostic_error(stdout + "\n" + stderr)
                if error:
                    raise error
                catalog = parse_model_catalog(stdout)
                if code or model not in catalog:
                    raise AdapterError("CODEARTS_MODEL_UNAVAILABLE", "blocked_model")
            # Linux 26.9.12 lacks --dir; setting the child process cwd works on
            # both official runtimes without relying on that newer option.
            command = [str(path), "run", "--pure", "--format", "json", "--title", "multi-agent-hub task"]
            if permission_auto:
                # always_allow：headless 下没人能批权限，不放开就只能读不能写。
                # 默认关闭，由 AGENTHUB_CODEARTS_AUTO（环境变量或 auth env 文件）显式开启。
                command.append("--auto")
            if model:
                command.extend(("--model", model))
            for file in files:
                command.extend(("--file", file))
            if live:
                stdout, stderr, code = capture(command, cwd=str(workdir), env=child_env, timeout=timeout, stdin=prompt,
                                               on_line=_print_progress if progress else None, max_total=MAX_TOTAL_SEC or None)
            else:
                stdout, stderr, code = capture(command, cwd=str(workdir), env=child_env, timeout=timeout, stdin=prompt)
            return parse_events(stdout, stderr, code, model, permission_is_fatal=not permission_auto)
    except AdapterError as error:
        return envelope(error.status, code=error.code, model=model, detail=error.detail)
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        return envelope(code="CODEARTS_ADAPTER_FAILED", model=model)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task")
    parser.add_argument("--cli")
    parser.add_argument("--model", default="")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SEC)
    parser.add_argument("--stream", choices=("on", "off"), default="off")
    parser.add_argument("--thinking", choices=("default", "on", "off"), default="default")
    parser.add_argument("--attach", action="append", default=[])
    parser.add_argument("--cwd")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--progress", action="store_true", help="print sanitized progress lines before the result envelope (E116)")
    args = parser.parse_args(argv)
    if args.probe:
        print(json.dumps(describe_runtime(args.cli), ensure_ascii=False))
        return 0
    result = run_task(task=args.task, cli=args.cli, model=args.model, timeout=args.timeout,
                      stream=args.stream, thinking=args.thinking, attachments=args.attach, cwd=args.cwd, progress=args.progress)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 1 if result["is_error"] else 0


def _install_signal_cleanup():
    if os.name == "nt":
        return

    def _raise_exit(signum, _frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, _raise_exit)
    signal.signal(signal.SIGINT, _raise_exit)


if __name__ == "__main__":
    _install_signal_cleanup()
    raise SystemExit(main())
