#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""agent-hub: 四工具联动枢纽 MCP Server (ZCode / WorkBuddy / Trae / QwenWork)

零依赖, 仅用 Python 标准库。双传输:
  python agent_hub.py --stdio        # 换行分隔 JSON-RPC (ZCode 接入)
  python agent_hub.py --http [port]  # Streamable HTTP, 默认 127.0.0.1:8765/mcp (WorkBuddy 等)

能力: 共享任务队列 + 代理邮箱 + 共享笔记 + 心跳注册表 + 通用 CLI 派活。
状态存放在脚本目录下 state/, 多个 hub 进程通过文件共享状态。
"""

import json
import os
import random
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SERVER_NAME = "agent-hub"
SERVER_VERSION = "0.2.0"
PROTOCOL_VERSION_DEFAULT = "2024-11-05"
ONLINE_WINDOW_SEC = 600
MAX_OUTPUT_CHARS = 20000
LOCK_TIMEOUT_SEC = 10
# 结果长期停留在 running 的判定阈值 (秒), 超过即视为 worker 异常退出
STALE_RUNNING_SEC = float(os.environ.get("HUB_STALE_RUNNING_SEC", "1800"))
# 终态: 命中即停止轮询
TERMINAL_STATUSES = ("completed", "error", "timeout")

# HTTP 传输的访问令牌 (环境变量 HUB_TOKEN, 为空则不鉴权, 仅建议本机回环使用)
HUB_TOKEN = os.environ.get("HUB_TOKEN", "").strip()

HERE = Path(__file__).resolve().parent
STATE = HERE / "state"
AGENTS_JSON = HERE / "agents.json"

_locks_guard = threading.Lock()
_locks = {}


def _state_path(name: str) -> Path:
    STATE.mkdir(parents=True, exist_ok=True)
    return STATE / name


class _LockCtx:
    """跨进程简单锁: O_EXCL 建锁文件 + 超时, 进程内再加线程锁。"""

    def __init__(self, name: str):
        self.path = _state_path(name + ".lock")

    def __enter__(self):
        with _locks_guard:
            tlock = _locks.setdefault(str(self.path), threading.Lock())
        tlock.acquire()
        deadline = time.time() + LOCK_TIMEOUT_SEC
        while True:
            try:
                fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode())
                os.close(fd)
                return self
            except FileExistsError:
                if time.time() > deadline:
                    # 锁文件残留(如进程被杀)时强行接管, 避免永久卡死
                    try:
                        self.path.unlink()
                    except OSError:
                        pass
                    deadline = time.time() + LOCK_TIMEOUT_SEC
                time.sleep(0.03)

    def __exit__(self, *exc):
        try:
            self.path.unlink()
        except OSError:
            pass
        _locks[str(self.path)].release()
        return False


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _write_json_atomic(path: Path, data):
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, str(path))
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _now() -> float:
    return time.time()


def _tid() -> str:
    return "t-" + time.strftime("%m%d%H%M%S") + "-" + str(random.randint(1000, 9999))


def _truncate(text: str) -> str:
    if len(text) > MAX_OUTPUT_CHARS:
        return text[:MAX_OUTPUT_CHARS] + f"\n...[输出已截断, 共 {len(text)} 字符]"
    return text


def _as_bool(value, default=False) -> bool:
    """宽容解析布尔参数。

    bool("false") 是 True, 字符串 "false"/"0"/"no" 必须按 False 处理,
    否则调用方传字符串会导致异步/同步分支走错。
    """
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() not in ("", "0", "false", "no", "off")


def _reap_result(d):
    """把长期停留在 running 的记录判定为 timeout。

    worker 若异常退出(如解析任务文件失败), 结果文件会永远停在 running,
    调用方于是无限轮询、白白消耗 token。这里按 updated_at 判定陈旧并落盘。
    """
    if not d or d.get("status") != "running":
        return d
    age = _now() - float(d.get("updated_at") or 0)
    if age < STALE_RUNNING_SEC:
        return d
    ref = d.get("ref")
    if not ref:
        return d
    _save_result(ref, status="timeout", progress=None,
                 text=(f"任务超时: 已 {age / 60:.0f} 分钟无任何进展, 判定 worker 已异常退出。"
                       f"请重新派发 (若反复出现, 检查 async_worker 日志)。"))
    return _read_result(ref)


def _load_agents() -> dict:
    data = _read_json(AGENTS_JSON, {})
    return data.get("agents", {})

# ---------------------------------------------------------------- 别名自动识别 (2026-10-06)
# 用户口中的简称统一映射到 agents.json 规范名; 未命中别名时再做一次大小写无关兜底
AGENT_ALIASES = {
    "agy": "antigravity",
    "cb": "codebuddy",
    "cbcn": "codebuddy-cn",
    "mimo": "mimocode",
    "gcp": "github-copilot",
    "mmx": "minimaxcode",
    "trae": "traecode",
}


def _resolve_agent(name: str) -> str:
    n = (name or "").strip()
    low = n.lower()
    if low in AGENT_ALIASES:
        return AGENT_ALIASES[low]
    agents = _load_agents()
    if n in agents:
        return n
    if low in agents:
        return low
    return n


# ---------------------------------------------------------------- tools

def tool_hub_heartbeat(args):
    agent = str(args.get("agent") or "").strip()
    if not agent:
        raise ValueError("缺少 agent 名称")
    with _LockCtx("registry"):
        reg = _read_json(_state_path("registry.json"), {})
        entry = reg.get(agent, {})
        entry.update({
            "role": args.get("role") or entry.get("role") or "",
            "capabilities": args.get("capabilities") or entry.get("capabilities") or [],
            "last_seen": _now(),
        })
        reg[agent] = entry
        _write_json_atomic(_state_path("registry.json"), reg)
    online = [a for a, e in reg.items() if _now() - e.get("last_seen", 0) < ONLINE_WINDOW_SEC]
    return f"{agent} 心跳已登记。当前 10 分钟内在线: {', '.join(sorted(online)) or '仅自己'}"


def tool_hub_list_agents(args):
    reg = _read_json(_state_path("registry.json"), {})
    known = _load_agents()
    names = sorted(set(reg) | set(known))
    lines = []
    for name in names:
        e = reg.get(name, {})
        cli = (known.get(name) or {}).get("cli")
        online = _now() - e.get("last_seen", 0) < ONLINE_WINDOW_SEC if e else False
        lines.append(
            f"- {name} [{'在线' if online else '离线'}] "
            f"角色: {e.get('role') or (known.get(name) or {}).get('role') or '未知'}"
            + (f" | CLI: {' '.join(cli)}" if cli else " | CLI: 未配置")
        )
    return "已注册代理:\n" + ("\n".join(lines) if lines else "(暂无, 各端调用 hub_heartbeat 注册)")


def tool_hub_post_task(args):
    from_agent = str(args.get("from_agent") or "").strip()
    title = str(args.get("title") or "").strip()
    if not from_agent or not title:
        raise ValueError("缺少 from_agent 或 title")
    with _LockCtx("tasks"):
        data = _read_json(_state_path("tasks.json"), {"seq": 0, "tasks": []})
        data["seq"] = data.get("seq", 0) + 1
        task = {
            "id": _tid() + f"-{data['seq']}",
            "title": title,
            "detail": str(args.get("detail") or ""),
            "from_agent": from_agent,
            "to_agent": (_resolve_agent(args.get("to_agent")) if args.get("to_agent") else None),
            "priority": args.get("priority") or "normal",
            "cwd": args.get("cwd") or None,
            "status": "open",
            "claimed_by": None,
            "result": None,
            "created_ts": _now(),
            "done_ts": None,
        }
        data["tasks"].append(task)
        _write_json_atomic(_state_path("tasks.json"), data)
    if task["to_agent"]:
        _mail_push(task["to_agent"], from_agent,
                   f"新任务 {task['id']}: {title} (用 hub_claim_task 认领)")
    return f"任务已入队: {task['id']} 「{title}」 -> {task['to_agent'] or '任意代理认领'}"


def tool_hub_list_tasks(args):
    data = _read_json(_state_path("tasks.json"), {"tasks": []})
    status = args.get("status")
    agent = args.get("agent")
    out = []
    for t in data.get("tasks", []):
        if status and t["status"] != status:
            continue
        if agent and agent not in (t["from_agent"], t["to_agent"], t.get("claimed_by")):
            continue
        out.append(t)
    if not out:
        return "没有匹配的任务。"
    lines = [(
        f"- {t['id']} [{t['status']}] {t['title']}"
        f" | 发起: {t['from_agent']} -> 指派: {t['to_agent'] or '无'}"
        f" | 执行: {t.get('claimed_by') or '-'}"
        f" | 优先级: {t['priority']}"
    ) for t in out[-50:]]
    return f"共 {len(out)} 条(最多显示50):\n" + "\n".join(lines)


def tool_hub_claim_task(args):
    task_id = str(args.get("task_id") or "").strip()
    agent = str(args.get("agent") or "").strip()
    if not task_id or not agent:
        raise ValueError("缺少 task_id 或 agent")
    with _LockCtx("tasks"):
        data = _read_json(_state_path("tasks.json"), {"tasks": []})
        for t in data.get("tasks", []):
            if t["id"] == task_id:
                if t["status"] != "open":
                    return f"任务 {task_id} 当前状态为 {t['status']}, 认领失败。"
                if t["to_agent"] and t["to_agent"] != agent:
                    return f"任务 {task_id} 指定给 {t['to_agent']}, {agent} 无权认领。"
                t["status"] = "in_progress"
                t["claimed_by"] = agent
                t["claimed_ts"] = _now()
                _write_json_atomic(_state_path("tasks.json"), data)
                _mail_push(t["from_agent"], agent,
                           f"{agent} 已认领任务 {task_id}「{t['title']}」")
                return f"已认领 {task_id}「{t['title']}」。详情: {t['detail'] or '(无)'}"
    return f"未找到任务 {task_id}。"


def tool_hub_complete_task(args):
    task_id = str(args.get("task_id") or "").strip()
    agent = str(args.get("agent") or "").strip()
    result = str(args.get("result") or "")
    success = bool(args.get("success", True))
    if not task_id or not agent:
        raise ValueError("缺少 task_id 或 agent")
    with _LockCtx("tasks"):
        data = _read_json(_state_path("tasks.json"), {"tasks": []})
        for t in data.get("tasks", []):
            if t["id"] == task_id:
                t["status"] = "done" if success else "failed"
                t["result"] = _truncate(result)
                t["done_ts"] = _now()
                _write_json_atomic(_state_path("tasks.json"), data)
                _mail_push(t["from_agent"], agent,
                           f"任务 {task_id}「{t['title']}」已{'完成' if success else '失败'}。结果: {t['result']}")
                return f"任务 {task_id} 已标记{'完成' if success else '失败'}, 结果已回传给 {t['from_agent']}。"
    return f"未找到任务 {task_id}。"


def _mail_push(to_agent: str, from_agent: str, text: str):
    box = _state_path(f"mailbox-{to_agent}.json")
    with _LockCtx(f"mailbox-{to_agent}"):
        msgs = _read_json(box, [])
        msgs.append({"ts": _now(), "from": from_agent, "text": text, "read": False})
        _write_json_atomic(box, msgs[-500:])


def tool_hub_send_message(args):
    to_agent = _resolve_agent(str(args.get("to_agent") or ""))
    from_agent = str(args.get("from_agent") or "").strip()
    text = str(args.get("text") or "")
    if not to_agent or not from_agent or not text:
        raise ValueError("缺少 to_agent / from_agent / text")
    _mail_push(to_agent, from_agent, _truncate(text))
    return f"消息已投递到 {to_agent} 的收件箱。"


def tool_hub_read_messages(args):
    agent = str(args.get("agent") or "").strip()
    if not agent:
        raise ValueError("缺少 agent")
    box = _state_path(f"mailbox-{agent}.json")
    mark = bool(args.get("mark_read", True))
    with _LockCtx(f"mailbox-{agent}"):
        msgs = _read_json(box, [])
        unread = [m for m in msgs if not m.get("read")]
        if mark and unread:
            for m in msgs:
                m["read"] = True
            _write_json_atomic(box, msgs)
    if not unread:
        return f"{agent} 没有未读消息。"
    lines = [f"- [{time.strftime('%m-%d %H:%M', time.localtime(m['ts']))}] {m['from']}: {m['text']}"
             for m in unread[-50:]]
    return f"{agent} 有 {len(unread)} 条未读:\n" + "\n".join(lines)


def tool_hub_note_set(args):
    key = str(args.get("key") or "").strip()
    agent = str(args.get("agent") or "unknown").strip()
    if not key:
        raise ValueError("缺少 key")
    with _LockCtx("notes"):
        notes = _read_json(_state_path("notes.json"), {})
        notes[key] = {"value": str(args.get("value") or ""), "agent": agent, "ts": _now()}
        _write_json_atomic(_state_path("notes.json"), notes)
    return f"笔记「{key}」已保存。"


def tool_hub_note_get(args):
    key = str(args.get("key") or "").strip()
    notes = _read_json(_state_path("notes.json"), {})
    if key:
        n = notes.get(key)
        return f"{key} = {n['value']} (by {n['agent']})" if n else f"没有笔记「{key}」。"
    return "全部笔记: " + (", ".join(sorted(notes)) if notes else "(空)")


def tool_hub_dispatch_cli(args):
    agent = _resolve_agent(str(args.get("agent") or ""))
    task = str(args.get("task") or "").strip()
    model = str(args.get("model") or "").strip()
    prof = _load_agents().get(agent) or {}
    # 调用方未指定模型时, 用 agents.json 中该 worker 的默认模型, 而不是任由 CLI 自身默认值兜底
    # (各 worker 的默认模型统一在 agents.json 的 models.default 维护, 此处不再写死)
    if not model:
        model = str((prof.get("models") or {}).get("default") or "").strip()
    cli = prof.get("cli")
    if not agent:
        raise ValueError("缺少 agent")
    if not task:
        raise ValueError("缺少 task")
    if not cli:
        return (f"{agent} 未配置 CLI (agents.json 中 cli 为 null)。"
                f"确认该工具的无头调用命令后, 填入 agents.json 的 cli 字段即可。")
    cwd = args.get("cwd") or None
    timeout = float(args.get("timeout_s") or 600)
    has_placeholder = any("{task}" in str(c) for c in cli)
    cmd = [str(c).replace("{task}", task) if "{task}" in str(c) else str(c) for c in cli]
    if not has_placeholder:
        cmd.append(task)
    if prof.get("model_arg"):
        # 规范化: 前端可能把"默认"当别名发来 -> 视为未指定, 走注入分支
        if model in ("默认", "default"):
            model = ""
        # 未显式指定模型时, 注入 agents.json models.default (显示与实跑一致)
        eff = model or (prof.get("models") or {}).get("default")
        if eff:
            flag = prof.get("model_arg")
            resolved = (prof.get("models") or {}).get(eff, eff)  # 别名命中则替换, 否则原样透传
            if resolved in ("v41f", "deepseek", "v4") and "deepseekv41f" in (prof.get("models") or {}):
                resolved = prof["models"]["deepseekv41f"]
            # 模型参数追加在任务之后: commander 风格 CLI 支持尾部选项,
            # 且避免 -p 这类"取下一参数为值"的 flag 把 --model 吃成提示词
            cmd += [str(flag), resolved]
    extra_args = args.get("extra_args")
    if extra_args:
        if isinstance(extra_args, (list, tuple)):
            for a in extra_args:
                if a is not None:
                    cmd.append(str(a))
        else:
            cmd.append(str(extra_args))
    # async_default: 该 worker 任务耗时长(CDP GUI 驱动/CLI 长生成), 强制异步受理
    # 立即返回受理号, 后台经 async_worker 执行, 调度方用 hub_result/ref 轮询
    # (置于函数体顶层: 占位符 {task} 模式与无 model_arg 的 worker 同样走异步,
    #  否则掉进同步分支; 且不可在函数内 import subprocess —— 模块级已导入,
    #  函数内导入会让 subprocess 变成局部变量, 同步分支触发 UnboundLocalError)
    if prof.get("async_default"):
        import uuid
        ref = agent + "-" + uuid.uuid4().hex[:10]
        cb = args.get("callback_url")
        _save_result(ref, agent=agent, status="running", task=task, cmd=cmd,
                     callback_url=cb)
        tf = os.path.join(RESULTS_DIR, ref + ".task")
        with open(tf, "w", encoding="utf-8") as f:
            json.dump({"cmd": cmd, "callback_url": cb}, f, ensure_ascii=False)
        subprocess.Popen(
            ["/usr/bin/python3", TRAE_ASYNC_WORKER, "cmd", ref, tf, ""],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, start_new_session=True)
        cb_note = f"\n完成后将回调: {cb}" if cb else ""
        return (f"[{agent}/{ref}] 任务已异步受理 (此类任务耗时长, 不阻塞等待)。{cb_note}\n"
                f"查询结果: hub_result(ref=\"{ref}\")\n"
                f"轮询至 status=completed 即可取回回答 (running 时附受控端进度快照)。请勿因超时重复派发同一任务。")
    # workdir_via: 某些 CLI 的登录态绑定特定目录 (如 codebuddy-cn 绑 home),
    # 用 --add-dir 把真实目标目录挂进工作区, 而进程本身固定在 prof.cwd 下运行
    via = prof.get("workdir_via")
    if via and cwd:
        cmd += [str(via), cwd]
        cwd = prof.get("cwd") or cwd
    exe = shutil.which(cmd[0]) or cmd[0]
    try:
        proc = subprocess.run([exe] + cmd[1:], cwd=cwd, capture_output=True,
                              timeout=timeout, text=True, encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return f"{agent} CLI 执行超时 (> {timeout}s)。"
    except OSError as e:
        return f"{agent} CLI 启动失败: {e}"
    out = (proc.stdout or "") + (("\n[stderr]\n" + proc.stderr) if proc.stderr else "")
    tag = f"{agent}/{model}" if model else agent
    return _truncate(f"[{tag}] exit={proc.returncode}\n{out or '(无输出)'}")


def tool_hub_list_models(args):
    wanted = args.get("agent")
    lines = []
    for name, prof in sorted(_load_agents().items()):
        if wanted and name != wanted:
            continue
        models = prof.get("models") or {}
        if not prof.get("cli") and not models:
            continue
        seg = f"- {name}: model_arg={prof.get('model_arg') or '未配置'}"
        if models:
            parts = [f"{k}→{v}" for k, v in models.items() if k != "default"]
            if "default" in models:
                parts.append(f"默认→{models['default']}")
            seg += " | " + ", ".join(parts)
        else:
            seg += " | 未配别名表 (model 参数将原样传给 CLI)"
        lines.append(seg)
    return "各 worker 可选模型:\n" + ("\n".join(lines) if lines else "(还没有配置 CLI 的 worker)")


# ---------------- Trae 桥接 (经 TraeClaw 网关驱动 TraeCode CN 桌面) ----------------
TRAE_GATEWAY = os.environ.get("TRAE_GATEWAY", "http://127.0.0.1:8787").rstrip("/")
TRAE_DOM_READ = os.path.expanduser("~/TraeClaw/dom_read.js")


def _trae_gw_post(path, payload, timeout=270):
    import urllib.request
    req = urllib.request.Request(
        TRAE_GATEWAY + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _trae_gw_get(path, timeout=15):
    import urllib.request
    with urllib.request.urlopen(TRAE_GATEWAY + path, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def tool_hub_wait_result(args):
    """服务端阻塞等待: 内部按前置密集+递进回查 (0/3/6/12/25/45/70/95秒),
    快任务秒级命中, 长任务预算尽返回进度快照。单次预算上限 115s。"""
    ref = str(args.get("ref") or "").strip()
    if not ref:
        raise ValueError("缺少 ref")
    budget = min(float(args.get("wait_s") or 110), 115)
    start = time.time()
    idx = 0
    last_progress = ""
    schedule = WAIT_CHECK_SCHEDULE
    while True:
        target = schedule[idx] if idx < len(schedule) else (schedule[-1] + 300 * (idx - len(schedule) + 1))
        remaining = budget - (time.time() - start)
        if remaining <= 0:
            break
        wait = min(max(target - (time.time() - start), 0), remaining)
        if wait > 0:
            time.sleep(wait)
        d = _reap_result(_read_result(ref))
        if d and d.get("status") in TERMINAL_STATUSES:
            return _format_result(d)
        if d and d.get("progress") and d["progress"] != last_progress:
            last_progress = d["progress"]
        idx += 1
        if time.time() - start >= budget:
            break
    d = _reap_result(_read_result(ref))
    if d and d.get("status") in TERMINAL_STATUSES:
        return _format_result(d)
    out = (f"[{ref}] status=running (等待预算用尽, 任务仍在执行)\n"
           f"[受控端界面快照] {last_progress[:500] or '(暂无)'}\n"
           f"建议: 再次调用本工具 (wait_s=110) 继续等待, 或按 1分钟→2分钟→3分钟→5分钟 节奏轮询。")
    return out


def tool_hub_result(args):
    ref = str(args.get("ref") or "").strip()
    if not ref:
        raise ValueError("缺少 ref")
    d = _reap_result(_read_result(ref))
    if not d:
        return f"未找到 {ref} 的结果 (可能尚未落盘, 稍后再查; running 状态请继续轮询)。"
    return _format_result(d)


def tool_trae_status(args):
    h = _trae_gw_get("/health")
    data = h.get("data", {})
    auto = data.get("automation", {})
    tgt = (auto.get("target") or {}).get("title", "")
    return f"TraeClaw 网关: {data.get('status', '?')} | CDP 自动化: {'就绪' if auto.get('ready') else '未就绪'} | 目标窗口: {tgt}"


RESULTS_DIR = os.path.expanduser("~/agent-hub/results")
TRAE_ASYNC_WORKER = os.path.expanduser("~/agent-hub/async_worker.py")
# 服务端阻塞等待的内部回查时刻表 (秒, 累计): 0秒先查一次(快任务/旧ref秒回),
# 之后 3/6/12/25/45/70/95 秒递进 — 快任务几秒命中, 长任务 110s 预算尽返回进度
WAIT_CHECK_SCHEDULE = [0, 3, 6, 12, 25, 45, 70, 95]


def _save_result(ref, **kv):
    os.makedirs(RESULTS_DIR, exist_ok=True)
    p = os.path.join(RESULTS_DIR, ref + ".json")
    d = {}
    if os.path.exists(p):
        try:
            with open(p, encoding="utf-8") as f:
                d = json.load(f)
        except Exception:
            d = {}
    d.update(kv)
    d["ref"] = ref
    d["updated_at"] = time.time()
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, p)


def _read_result(ref):
    p = os.path.join(RESULTS_DIR, ref + ".json")
    if not os.path.exists(p):
        return None
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def tool_trae_delegate(args):
    content = str(args.get("task") or "").strip()
    if not content:
        raise ValueError("缺少 task")
    wait = _as_bool(args.get("wait"), True)
    sid = args.get("session_id")
    timeout = int(float(args.get("timeout_s") or 240))
    if not wait:
        import uuid
        ref = "trae-" + uuid.uuid4().hex[:10]
        _save_result(ref, agent="trae", status="running", task=content)
        tf = os.path.join(RESULTS_DIR, ref + ".task")
        # 必须写成 JSON: async_worker 按 JSON 解析任务文件,
        # 旧版直接写纯文本会导致 worker 解析崩溃、结果永久卡 running。
        with open(tf, "w", encoding="utf-8") as f:
            json.dump({"task": content,
                       "new_chat": _as_bool(args.get("new_chat"), False)},
                      f, ensure_ascii=False)
        import subprocess
        subprocess.Popen(
            ["/usr/bin/python3", TRAE_ASYNC_WORKER, "trae", ref, tf, sid or ""],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, start_new_session=True)
        return (f"[trae/{ref}] 已异步受理, status=running。\n"
                f"查询结果: trae_result(ref=\"{ref}\")")
    payload = {"content": content}
    if sid:
        payload["sessionId"] = sid
    # 默认延续当前对话; 仅当显式传 new_chat=true 才让驱动新开一个对话
    if _as_bool(args.get("new_chat"), False):
        payload["newChat"] = True
    resp = _trae_gw_post("/v1/chat", payload, timeout=max(timeout, 30) + 30)
    data = resp.get("data", {})
    sess = data.get("session", {})
    result = data.get("result") or {}
    text = result.get("text") or ""
    status = sess.get("status") or result.get("status")
    sid = sid or sess.get("sessionId", "new")
    if not text.strip() and os.path.exists(TRAE_DOM_READ):
        import subprocess
        try:
            p = subprocess.run(["/usr/bin/node", TRAE_DOM_READ], capture_output=True,
                               text=True, timeout=100)
            if p.stdout.strip():
                text = p.stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            pass
    _save_result("trae-last", agent="trae", status=status, text=text,
                 session_id=sess.get("sessionId"))
    out = f"[trae/{sid}] status={status}\n{text[:4000] or '(空响应)'}"
    if sess.get("sessionId"):
        out += f"\n(继续对话请带 session_id: {sess['sessionId']})"
    return out


def _format_result(d):
    ref = d.get("ref", "?")
    text = d.get("text") or ""
    out = f"[{ref}] agent={d.get('agent')} status={d.get('status')}"
    if d.get("status") == "running" and d.get("progress"):
        out += f"\n[执行中·受控端界面快照] {str(d['progress'])[:600]}"
    out += f"\n{text[:4000] or '(尚无文本)'}"
    if d.get("session_id"):
        out += f"\n(继续对话 session_id: {d['session_id']})"
    if d.get("exit_code") is not None:
        out += f"\n(exit={d['exit_code']})"
    return out


def tool_trae_result(args):
    ref = str(args.get("ref") or "").strip()
    if not ref:
        raise ValueError("缺少 ref")
    d = _reap_result(_read_result(ref))
    if not d:
        return f"未找到 {ref} 的结果 (可能尚未落盘, 稍后再查)。"
    return _format_result(d)


def tool_zcode_delegate(args):
    content = str(args.get("task") or "").strip()
    if not content:
        raise ValueError("缺少 task")
    wait = _as_bool(args.get("wait"), True)
    if not wait:
        import uuid
        ref = "zcode-" + uuid.uuid4().hex[:10]
        _save_result(ref, agent="zcode", status="running", task=content)
        tf = os.path.join(RESULTS_DIR, ref + ".task")
        # 同 trae_delegate: 任务文件必须是 JSON, 否则 async_worker 解析崩溃
        with open(tf, "w", encoding="utf-8") as f:
            json.dump({"task": content}, f, ensure_ascii=False)
        import subprocess
        subprocess.Popen(
            ["/usr/bin/python3", TRAE_ASYNC_WORKER, "zcode", ref, tf, ""],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, start_new_session=True)
        return (f"[zcode/{ref}] 已异步受理, status=running。\n"
                f"查询结果: zcode_result(ref=\"{ref}\")")
    import subprocess
    driver = os.path.expanduser("~/TraeClaw/zcode_dom.js")
    if not os.path.exists(driver):
        raise ValueError("ZCode 驱动不存在: " + driver)
    p = subprocess.run(["/usr/bin/node", driver, content], capture_output=True,
                       text=True, encoding="utf-8", errors="replace", timeout=300)
    text = (p.stdout or "").strip()[-2500:]
    _save_result("zcode-last", agent="zcode", status="completed", text=text)
    return f"[zcode] exit={p.returncode}\n{text or '(空响应)'}"


def tool_zcode_result(args):
    ref = str(args.get("ref") or "").strip()
    if not ref:
        raise ValueError("缺少 ref")
    d = _reap_result(_read_result(ref))
    if not d:
        return f"未找到 {ref} 的结果 (可能尚未落盘, 稍后再查)。"
    return _format_result(d)


def tool_trae_new_chat(args):
    _trae_gw_post("/v1/mode", {"mode": str(args.get("mode") or "chat")}, timeout=15)
    return "已请求 Trae 切换/新建会话。"


def tool_hub_reap(args):
    """扫描结果目录: 把陈旧的 running 记录判定为 timeout, 并汇报仍在运行的任务。

    用于任务卡死后的手动回收, 避免调用方对着永不完成的 ref 反复轮询。
    """
    if not os.path.isdir(RESULTS_DIR):
        return "结果目录不存在, 暂无历史任务。"
    reaped, still_running = [], []
    for name in sorted(os.listdir(RESULTS_DIR)):
        if not name.endswith(".json"):
            continue
        ref = name[:-5]
        d = _read_result(ref)
        if not d or d.get("status") != "running":
            continue
        age = _now() - float(d.get("updated_at") or 0)
        if age >= STALE_RUNNING_SEC:
            _reap_result(d)
            reaped.append((ref, age))
        else:
            still_running.append((ref, age))
    lines = []
    if reaped:
        lines.append(f"已判定超时并回收 {len(reaped)} 条:")
        lines += [f"  - {r} (停滞 {a / 60:.0f} 分钟)" for r, a in reaped]
    else:
        lines.append("没有需要回收的陈旧任务。")
    if still_running:
        lines.append(f"仍在正常运行 {len(still_running)} 条:")
        lines += [f"  - {r} (已 {a / 60:.0f} 分钟)" for r, a in still_running]
    return "\n".join(lines)


TOOL_DEFS = [
    ("hub_heartbeat", "代理上线时登记心跳, 声明自己的角色和能力。定期调用可保持'在线'状态。",
     {"agent": {"type": "string", "description": "代理名, 如 workbuddy/zcode/trae/qwen-work"},
      "role": {"type": "string", "description": "角色描述, 如 总控/编程"},
      "capabilities": {"type": "array", "items": {"type": "string"}, "description": "能力列表"}},
     ["agent"]),
    ("hub_list_agents", "查看已注册代理及在线状态。", {}, []),
    ("hub_post_task", "发布任务到共享队列。不指定 to_agent 则任意代理可认领。",
     {"from_agent": {"type": "string"}, "title": {"type": "string", "description": "一句话任务标题"},
      "detail": {"type": "string", "description": "完整任务说明/上下文"},
      "to_agent": {"type": "string", "description": "指派给某代理, 留空则公开认领"},
      "priority": {"type": "string", "enum": ["low", "normal", "high"]},
      "cwd": {"type": "string", "description": "建议工作目录"}},
     ["from_agent", "title"]),
    ("hub_list_tasks", "查看任务队列, 可按状态/代理过滤。",
     {"status": {"type": "string", "enum": ["open", "in_progress", "done", "failed"]},
      "agent": {"type": "string", "description": "只看与自己相关的任务"}}, []),
    ("hub_claim_task", "认领一个 open 状态的任务, 认领后状态变为 in_progress。",
     {"task_id": {"type": "string"}, "agent": {"type": "string"}}, ["task_id", "agent"]),
    ("hub_complete_task", "完成任务并回传结果, 结果会自动发到发起方的收件箱。",
     {"task_id": {"type": "string"}, "agent": {"type": "string"},
      "result": {"type": "string"}, "success": {"type": "boolean", "default": True}},
     ["task_id", "agent"]),
    ("hub_send_message", "给另一个代理的发件箱投递消息(异步, 对方下次调用 hub_read_messages 时读到)。",
     {"from_agent": {"type": "string"}, "to_agent": {"type": "string"}, "text": {"type": "string"}},
     ["from_agent", "to_agent", "text"]),
    ("hub_read_messages", "读取自己的收件箱未读消息(默认读后标记已读)。建议每次会话开始时调用。",
     {"agent": {"type": "string"}, "mark_read": {"type": "boolean", "default": True}}, ["agent"]),
    ("hub_note_set", "写共享笔记(跨代理共享记忆), 如项目约定、进度、账号上下文。",
     {"key": {"type": "string"}, "value": {"type": "string"}, "agent": {"type": "string"}},
     ["key", "value"]),
    ("hub_note_get", "读共享笔记。key 留空则列出全部键名。",
     {"key": {"type": "string"}}, []),
    ("hub_dispatch_cli", "按 agents.json 中配置的 CLI 命令无头调用某代理执行任务; 可用 model 参数指定模型(如 gemini/gpt 或具体模型ID), 也可只传 model 不传 task 来探测。",
     {"agent": {"type": "string"}, "task": {"type": "string"},
      "model": {"type": "string", "description": "模型别名或模型ID, 见 hub_list_models"},
      "extra_args": {"type": "array", "items": {"type": "string"}, "description": "追加到命令尾部的额外参数列表"},
      "cwd": {"type": "string"}, "timeout_s": {"type": "number"}}, ["agent", "task"]),
    ("hub_list_models", "查看各 worker 可用的模型别名表和模型参数名。",
     {"agent": {"type": "string", "description": "只看某个 worker"}}, []),
    ("hub_result", "查询异步受理任务的结果 (zcode 等长任务 worker 派活时自动返回 ref)。即时返回, 不等待。",
     {"ref": {"type": "string"}}, ["ref"]),
    ("hub_wait_result", "阻塞等待异步任务完成 (服务端按 0/3/6/12/25/45/70/95秒 前置密集+递进回查)。快任务几秒命中秒回; 长任务预算尽返回进度快照。推荐代替反复 hub_result, 减少模型输入。",
     {"ref": {"type": "string"},
      "wait_s": {"type": "number", "default": 110, "description": "本次阻塞等待预算(秒), 上限 115"}}, ["ref"]),
    ("hub_reap", "扫描并回收陈旧任务: 把长期停留在 running 的记录判定为 timeout (默认 30 分钟无进展), 避免对着已死任务无限轮询。同时汇报仍在运行的任务。",
     {}, []),
    ("trae_status", "查看 TraeCode 桌面版(服务器上, 个人 Trae 账号)的连接与就绪状态。", {}, []),
    ("trae_delegate", "把任务派给 TraeCode 的 AI 执行(走 Trae 个人账号额度), 返回它的回答。默认延续当前对话; 传 new_chat=true 才新开对话。带 session_id 可延续同一会话。长任务建议 wait=false 异步派发后用 trae_result 轮询, 避免阻塞。",
     {"task": {"type": "string", "description": "要交给 Trae 的任务/提示词"},
      "session_id": {"type": "string", "description": "延续已有会话时传入"},
      "wait": {"type": "boolean", "default": True, "description": "false=异步受理立即返回"},
      "new_chat": {"type": "boolean", "default": False, "description": "true=新开一个对话; 默认 false 延续当前对话"},
      "timeout_s": {"type": "number", "default": 240}},
     ["task"]),
    ("trae_result", "查询异步 Trae 任务的结果 (配合 trae_delegate wait=false)。",
     {"ref": {"type": "string"}}, ["ref"]),
    ("trae_new_chat", "请求 Trae 切换/新建会话模式。", {"mode": {"type": "string"}}, []),
    ("zcode_delegate", "把任务派给 ZCode Linux 桌面版 (GLM-5.3-Flash, 体验套餐额度)。wait=false 异步受理。",
     {"task": {"type": "string"},
      "wait": {"type": "boolean", "default": True},
      "timeout_s": {"type": "number", "default": 240}},
     ["task"]),
    ("zcode_result", "查询异步 ZCode 任务的结果 (配合 zcode_delegate wait=false)。",
     {"ref": {"type": "string"}}, ["ref"]),
]

TOOLS_JSON = [{"name": n, "description": d, "inputSchema":
               {"type": "object", "properties": p,
                "required": r, "additionalProperties": True}}
              for n, d, p, r in TOOL_DEFS]

HANDLERS = {n: (f, ) for n, f in [
    ("hub_heartbeat", tool_hub_heartbeat), ("hub_list_agents", tool_hub_list_agents),
    ("hub_post_task", tool_hub_post_task), ("hub_list_tasks", tool_hub_list_tasks),
    ("hub_claim_task", tool_hub_claim_task), ("hub_complete_task", tool_hub_complete_task),
    ("hub_send_message", tool_hub_send_message), ("hub_read_messages", tool_hub_read_messages),
    ("hub_note_set", tool_hub_note_set), ("hub_note_get", tool_hub_note_get),
    ("hub_dispatch_cli", tool_hub_dispatch_cli), ("hub_list_models", tool_hub_list_models),
    ("trae_status", tool_trae_status), ("trae_delegate", tool_trae_delegate),
    ("trae_result", tool_trae_result),
    ("trae_new_chat", tool_trae_new_chat),
    ("zcode_delegate", tool_zcode_delegate), ("zcode_result", tool_zcode_result),
    ("hub_result", tool_hub_result), ("hub_wait_result", tool_hub_wait_result),
    ("hub_reap", tool_hub_reap)]}


# ---------------------------------------------------------------- json-rpc

def handle_request(req):
    if isinstance(req, list):  # 兼容批量请求
        return [r for r in (handle_request(x) for x in req) if r is not None] or None
    if not isinstance(req, dict) or req.get("jsonrpc") != "2.0":
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}
    method, rid, params = req.get("method"), req.get("id"), req.get("params") or {}
    is_notification = "id" not in req

    def ok(result):
        return {"jsonrpc": "2.0", "id": rid, "result": result} if not is_notification else None

    def err(code, message):
        if is_notification:
            return None
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}

    try:
        if method == "initialize":
            pv = (params or {}).get("protocolVersion") or PROTOCOL_VERSION_DEFAULT
            return ok({"protocolVersion": pv,
                       "capabilities": {"tools": {}},
                       "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION}})
        if method == "ping":
            return ok({})
        if method.startswith("notifications/"):
            return None
        if method == "tools/list":
            return ok({"tools": TOOLS_JSON})
        if method == "tools/call":
            name = params.get("name")
            entry = HANDLERS.get(name)
            if not entry:
                return err(-32602, f"Unknown tool: {name}")
            try:
                text = entry[0](params.get("arguments") or {})
                return ok({"content": [{"type": "text", "text": text}], "isError": False})
            except Exception as e:  # noqa: BLE001 - 作为工具错误返回给调用方
                return ok({"content": [{"type": "text", "text": f"工具执行出错: {e}"}],
                           "isError": True})
        return err(-32601, f"Method not found: {method}")
    except Exception as e:  # noqa: BLE001 - 兜底, 保证 hub 不崩
        return err(-32603, f"Internal error: {e}")


# ---------------------------------------------------------------- transports

def run_stdio():
    out = sys.stdout.buffer
    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            resp = {"jsonrpc": "2.0", "id": None,
                    "error": {"code": -32700, "message": "Parse error"}}
        else:
            resp = handle_request(req)
        if resp is not None:
            out.write(json.dumps(resp, ensure_ascii=False).encode("utf-8") + b"\n")
            out.flush()


class _HTTPHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type, Accept, Mcp-Session-Id")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self.send_response(405)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _authorized(self) -> bool:
        if not HUB_TOKEN:
            return True
        auth = self.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            supplied = auth[7:].strip()
        else:
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            supplied = (q.get("token") or [""])[0]
        return bool(supplied) and secrets.compare_digest(supplied, HUB_TOKEN)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path.rstrip("/")
        if path != "/mcp":
            self.send_error(404, "Only /mcp is served")
            return
        if not self._authorized():
            sys.stderr.write("[agent-hub.http] 401 unauthorized from %s\n" % self.client_address[0])
            body = b'{"error":"unauthorized"}'
            self.send_response(401)
            self._cors()
            self.send_header("WWW-Authenticate", 'Bearer realm="agent-hub"')
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length)
            try:
                req = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                # Windows 客户端常误发 GBK 编码中文, 兜底解码
                req = json.loads(raw.decode("gbk"))
        except (ValueError, UnicodeDecodeError, OSError):
            self.send_response(400)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        resp = handle_request(req)
        if resp is None:
            self.send_response(202)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = json.dumps(resp, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("[agent-hub.http] %s\n" % (fmt % args))


def run_http(port: int, host: str = "127.0.0.1"):
    try:
        sys.stderr.reconfigure(line_buffering=True)  # 保证强杀进程后日志已落盘
    except (AttributeError, OSError):
        pass
    if host not in ("127.0.0.1", "localhost", "::1") and not HUB_TOKEN:
        raise SystemExit("拒绝启动: 非回环监听必须设置 HUB_TOKEN 环境变量 (防裸奔)")
    server = ThreadingHTTPServer((host, port), _HTTPHandler)
    auth = "已启用 token 鉴权" if HUB_TOKEN else "未鉴权 (仅限本机回环!)"
    sys.stderr.write("[agent-hub] HTTP MCP 端点: http://%s:%d/mcp (%s)\n" % (host, port, auth))
    sys.stderr.write("[agent-hub] 状态目录: %s\n" % STATE)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


def main():
    argv = sys.argv[1:]
    if "--http" in argv:
        i = argv.index("--http")
        port = int(argv[i + 1]) if i + 1 < len(argv) and argv[i + 1].isdigit() else int(os.environ.get("AGENTHUB_PORT", "8765"))
        host = argv[argv.index("--host") + 1] if "--host" in argv else os.environ.get("AGENTHUB_HOST", "127.0.0.1")
        run_http(port, host)
    else:
        run_stdio()


if __name__ == "__main__":
    main()
