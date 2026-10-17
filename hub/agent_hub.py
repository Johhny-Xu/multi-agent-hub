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
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from command_runtime import atomic_write_json, positive_timeout, prepare_command, spawn_owned, terminate_owned
from state_store import StateFileLock, safe_component
from result_store import read_result, update_result
from task_contract import OPTIONS_SCHEMA, apply_environment, capabilities, cleanup_attachments, merge_cli_arguments, prepare_task, platform_name, public_model_capabilities, resolve_model
from availability_store import local_availability, record_outcome, refresh as refresh_availability, signature as profile_signature
from output_parser import parse_output

SERVER_NAME = "agent-hub"
SERVER_VERSION = "1.0.1"
PROTOCOL_VERSION_DEFAULT = "2024-11-05"
ONLINE_WINDOW_SEC = 600
MAX_OUTPUT_CHARS = 20000
LOCK_TIMEOUT_SEC = 10
# 结果长期停留在 running 的判定阈值 (秒), 超过即视为 worker 异常退出
STALE_RUNNING_SEC = positive_timeout(os.environ.get("HUB_STALE_RUNNING_SEC", "1800"), 1800)
# 终态: 命中即停止轮询
TERMINAL_STATUSES = ("completed", "error", "timeout")

# HTTP 传输的访问令牌 (环境变量 HUB_TOKEN, 为空则不鉴权, 仅建议本机回环使用)
HUB_TOKEN = os.environ.get("HUB_TOKEN", "").strip()

HERE = Path(__file__).resolve().parent
STATE = Path(os.path.expandvars(os.path.expanduser(os.environ.get("HUB_STATE_DIR") or str(HERE / "state")))).resolve()
AGENTS_JSON = Path(os.path.expandvars(os.path.expanduser(os.environ.get("HUB_AGENTS_FILE") or str(HERE / "agents.json")))).resolve()
DRIVERS_DIR = HERE.parent / "drivers"

# 结果目录：优先读取环境变量 HUB_RESULTS_DIR，缺省自包含在 state/results
RESULTS_DIR = str(Path(os.path.expandvars(os.path.expanduser(
    os.environ.get("HUB_RESULTS_DIR", "").strip()
    or str(STATE / "results")
))).resolve())
# 异步任务 worker 脚本：优先使用本仓库自带的 async_worker.py
ASYNC_WORKER_SCRIPT = (
    os.environ.get("HUB_ASYNC_WORKER", "").strip()
    or (str(HERE / "async_worker.py") if (HERE / "async_worker.py").exists() else os.path.expanduser("~/agent-hub/async_worker.py"))
)
# Node 可执行文件解析
NODE_BIN = shutil.which("node") or "node"
# Trae 与 ZCode 桌面端辅助驱动脚本
TRAE_DOM_READ = (
    os.environ.get("TRAE_DOM_READ", "").strip()
    or (str(DRIVERS_DIR / "dom_read.js") if (DRIVERS_DIR / "dom_read.js").exists() else os.path.expanduser("~/TraeClaw/dom_read.js"))
)
ZCODE_DOM_DRIVER = (
    os.environ.get("ZCODE_DOM_DRIVER", "").strip()
    or (str(DRIVERS_DIR / "zcode_dom.js") if (DRIVERS_DIR / "zcode_dom.js").exists() else os.path.expanduser("~/TraeClaw/zcode_dom.js"))
)

def _state_path(name: str) -> Path:
    STATE.mkdir(parents=True, exist_ok=True)
    return STATE / name


class _LockCtx(StateFileLock):
    """Process-owned locks are bounded and released even after a crash."""
    def __init__(self, name: str):
        super().__init__(_state_path(safe_component(name) + ".lock"), LOCK_TIMEOUT_SEC)


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return default


def _write_json_atomic(path: Path, data):
    atomic_write_json(path, data)


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


def _positive_seconds(value, default):
    return positive_timeout(value, default)


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
    return update_result(RESULTS_DIR, ref,
                         {"status": "timeout", "progress": None,
                          "text": f"任务超时: 已 {age / 60:.0f} 分钟无任何进展, 判定 worker 已异常退出。请检查 async_worker 日志。"},
                         only_if_running=True, expected_updated_at=d.get("updated_at"))


def _load_agents() -> dict:
    data = _read_json(AGENTS_JSON, {})
    agents = data.get("agents", {}) if isinstance(data, dict) else {}
    if not isinstance(agents, dict):
        return {}
    return {name: profile for name, profile in agents.items() if isinstance(profile, dict)}

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
    "ca": "codearts",
    "huawei-codearts": "codearts",
    "oc": "opencode",
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
    for known in agents:
        if known.lower() == low:
            return known
    return low


# ---------------------------------------------------------------- tools

def tool_hub_heartbeat(args):
    agent = _resolve_agent(str(args.get("agent") or ""))
    if not agent:
        raise ValueError("缺少 agent 名称")
    agent = safe_component(agent)
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
        cfg = known.get(name) or {}
        cli = cfg.get("cli")
        online = _now() - e.get("last_seen", 0) < ONLINE_WINDOW_SEC if e else False
        is_ready = bool(cli or name in ("traecode", "trae") or cfg.get("gateway") or cfg) and cfg.get("disabled") is not True
        if cfg.get("disabled") is True:
            status_label = "已禁用"
        elif online:
            status_label = "在线"
        elif is_ready:
            status_label = "就绪"
        else:
            status_label = "离线"
        lines.append(
            f"- {name} [{status_label}] "
            f"角色: {e.get('role') or cfg.get('role') or '未知'}"
            + (f" | 调度通道: TraeClaw 网关" if name in ("traecode", "trae") and not cli else (f" | CLI: {' '.join(cli)}" if cli else " | CLI: 未配置"))
        )
    return "已注册代理:\n" + ("\n".join(lines) if lines else "(暂无, 各端调用 hub_heartbeat 注册)")


def tool_hub_post_task(args):
    from_agent = _resolve_agent(str(args.get("from_agent") or ""))
    title = str(args.get("title") or "").strip()
    if not from_agent or not title:
        raise ValueError("缺少 from_agent 或 title")
    from_agent = safe_component(from_agent)
    to_agent = safe_component(_resolve_agent(str(args["to_agent"]))) if args.get("to_agent") else None
    with _LockCtx("tasks"):
        data = _read_json(_state_path("tasks.json"), {"seq": 0, "tasks": []})
        data["seq"] = data.get("seq", 0) + 1
        task = {
            "id": _tid() + f"-{data['seq']}",
            "title": title,
            "detail": str(args.get("detail") or ""),
            "from_agent": from_agent,
            "to_agent": to_agent,
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
    agent = _resolve_agent(str(args["agent"])) if args.get("agent") else None
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
    agent = _resolve_agent(str(args.get("agent") or ""))
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
    agent = _resolve_agent(str(args.get("agent") or ""))
    result = str(args.get("result") or "")
    success = _as_bool(args.get("success"), True)
    if not task_id or not agent:
        raise ValueError("缺少 task_id 或 agent")
    with _LockCtx("tasks"):
        data = _read_json(_state_path("tasks.json"), {"tasks": []})
        for t in data.get("tasks", []):
            if t["id"] == task_id:
                if t.get("status") != "in_progress" or t.get("claimed_by") != agent:
                    return f"任务 {task_id} 必须由已认领的代理完成，当前操作未写入。"
                t["status"] = "done" if success else "failed"
                t["result"] = _truncate(result)
                t["done_ts"] = _now()
                _write_json_atomic(_state_path("tasks.json"), data)
                _mail_push(t["from_agent"], agent,
                           f"任务 {task_id}「{t['title']}」已{'完成' if success else '失败'}。结果: {t['result']}")
                return f"任务 {task_id} 已标记{'完成' if success else '失败'}, 结果已回传给 {t['from_agent']}。"
    return f"未找到任务 {task_id}。"


def _mail_push(to_agent: str, from_agent: str, text: str):
    to_agent = safe_component(to_agent)
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
    agent = _resolve_agent(str(args.get("agent") or ""))
    if not agent:
        raise ValueError("缺少 agent")
    agent = safe_component(agent)
    box = _state_path(f"mailbox-{agent}.json")
    mark = _as_bool(args.get("mark_read"), True)
    with _LockCtx(f"mailbox-{agent}"):
        msgs = _read_json(box, [])
        unread = [m for m in msgs if not m.get("read")]
        delivered = unread[:50]
        if mark and unread:
            for m in delivered:
                m["read"] = True
            _write_json_atomic(box, msgs)
    if not unread:
        return f"{agent} 没有未读消息。"
    lines = [f"- [{time.strftime('%m-%d %H:%M', time.localtime(m['ts']))}] {m['from']}: {m['text']}"
             for m in delivered]
    return f"{agent} 有 {len(unread)} 条未读，本次返回 {len(delivered)} 条:\n" + "\n".join(lines)


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
    if not isinstance(args.get("task"), str):
        raise ValueError("task 必须是字符串")
    task = args["task"].strip()
    prof = _load_agents().get(agent) or {}
    cli = prof.get("cli")
    if not agent:
        raise ValueError("缺少 agent")
    if not task:
        raise ValueError("缺少 task")
    if not cli:
        return (f"{agent} 未配置 CLI (agents.json 中 cli 为 null)。"
                f"确认该工具的无头调用命令后, 填入 agents.json 的 cli 字段即可。")
    model = resolve_model(prof, args.get("model"))
    available = local_availability(agent, prof, model, STATE)
    if not available["enabled"]:
        raise ValueError("UNAVAILABLE: " + available["code"] + ": " + available["reason"])
    plan = prepare_task(agent, prof, dict(args, task=task), STATE / "attachments")
    try:
        return _dispatch_prepared_cli(args, agent, prof, plan)
    finally:
        if not plan.get("async_started"):
            cleanup_attachments(plan["staging"], STATE / "attachments")


def _record_cli_outcome(agent, profile, model, status, text=""):
    try:
        record_outcome(STATE, agent, model, status, text, profile_signature(profile))
    except (OSError, ValueError, TimeoutError):
        # Failure hints are optional; a state-cache problem must not erase an
        # already executed task's real answer or encourage duplicate execution.
        pass


def _dispatch_prepared_cli(args, agent, prof, plan):
    cli, task = prof["cli"], plan["task"]
    aliases = prof.get("models") or {}
    requested = str(args.get("model") or "").strip()
    if requested in ("", "default", "默认"):
        requested = str(aliases.get("default") or "")
    model = aliases.get(requested, requested)
    if agent == "zcode" and model and not prof.get("model_arg"):
        raise ValueError("UNSUPPORTED: ZCode 旧通道不能验证配置模型；请使用 drivers/zcode_rpc.mjs 与 --model，避免静默调用账号当前模型")
    cwd = args.get("cwd") or prof.get("cwd") or None
    timeout = _positive_seconds(args.get("timeout_s"), 600)
    if not isinstance(cli, list) or not cli:
        raise ValueError("agents.json 的 cli 必须是非空参数数组")
    has_placeholder = any("{task}" in str(c) for c in cli)
    cmd = [str(c) for c in cli]
    if not has_placeholder:
        prompt_flags = {"codebuddy": ("-p", "--print"), "codebuddy-cn": ("-p", "--print"),
                        "antigravity": ("-p", "--prompt"), "github-copilot": ("-p", "--prompt"),
                        "minimaxcode": ("--message",), "zcode": ("--prompt",)}.get(agent, ())
        prompt_at = next((index for index, item in enumerate(cmd) if item in prompt_flags), None)
        if prompt_at is None:
            cmd.append("{task}")
        elif prompt_at + 1 == len(cmd) or cmd[prompt_at + 1].startswith("-"):
            # Variadic flags such as --allowedTools can otherwise swallow a
            # prompt blindly appended to the end of an older profile.
            cmd.insert(prompt_at + 1, "{task}")
        else:
            raise ValueError("CLI 已含固定提示词；请用 {task} 显式标出任务参数位置")
    if plan.get("message_file"):
        if "--message" not in cmd:
            raise ValueError("messages_file 附件要求 CLI 以 --message {task} 配置文本输入")
        prompt_at = cmd.index("--message")
        if cmd[prompt_at + 1:prompt_at + 2] != ["{task}"]:
            raise ValueError("messages_file 附件的 --message 后必须是 {task}")
        del cmd[prompt_at:prompt_at + 2]
    if plan.get("input_file"):
        prompt_at = next((i for i, item in enumerate(cmd) if item == "{task}"), None)
        if prompt_at is None or prompt_at == 0 or cmd[prompt_at - 1] not in ("-p", "--print"):
            raise ValueError("stdin_json 输入要求 CLI 以 -p/--print {task} 配置")
        del cmd[prompt_at]
    prompt_tail = None
    if prof.get("options_before_prompt") and not plan.get("input_file"):
        if len(cmd) < 2 or cmd[-1] != "{task}" or not cmd[-2].startswith("-"):
            raise ValueError("options_before_prompt 要求 CLI 以提示词参数和 {task} 结尾")
        prompt_tail = cmd[-2:]
        cmd = cmd[:-2]
    if not prof.get("model_arg") and model and model != aliases.get("default"):
        raise ValueError("UNSUPPORTED: 此 CLI 通道没有配置模型切换参数")
    if prof.get("model_arg") and model:
        cmd = merge_cli_arguments(cmd, [str(prof["model_arg"]), str(model)])
    if prof.get("timeout_arg"):
        cmd = merge_cli_arguments(cmd, [str(prof["timeout_arg"]), str(timeout)])
    cmd = [item for item in cmd if item not in plan.get("remove_args", [])]
    cmd = merge_cli_arguments(cmd, plan["extra_args"])
    if agent in ("codebuddy", "codebuddy-cn") and plan["staging"] and any(item["kind"] == "image" for item in plan["metadata"].get("attachments", [])):
        cmd.extend(["--add-dir", plan["staging"]])
    extra_args = args.get("extra_args")
    if extra_args:
        if isinstance(extra_args, (list, tuple)):
            for a in extra_args:
                if a is not None:
                    cmd.append(str(a))
        else:
            cmd.append(str(extra_args))
    # Apply these to both synchronous and asynchronous runs. In particular,
    # CN/intl account directories must match the official login flow.
    via = prof.get("workdir_via")
    if via and args.get("cwd"):
        cmd += [str(via), str(args["cwd"])]
        cwd = prof.get("cwd") or cwd
    if prompt_tail is not None:
        cmd.extend(prompt_tail)
    cmd = [item.replace("{task}", task) for item in cmd]
    if cwd:
        cwd = os.path.expandvars(os.path.expanduser(str(cwd)))
    process_env = os.environ.copy()
    for key, value in (prof.get("env") or {}).items():
        process_env[str(key)] = os.path.expandvars(os.path.expanduser(str(value)))
    if agent in ("codebuddy", "codebuddy-cn"):
        from login_manager import worker_env
        process_env = worker_env(prof, agent)
    process_env = apply_environment(process_env, plan["env"])
    # Only Hub-launched workers carry this identity. Set it after every profile
    # and capability override so a stale/inherited value cannot make the native
    # MCP bridge dispatch the worker back to itself. Ordinary host clients keep
    # their own environment and can still select any worker.
    process_env["AGENTHUB_WORKER_ID"] = agent
    try:
        cmd = prepare_command(cmd, env=process_env)
    except (OSError, ValueError) as exc:
        return f"{agent} CLI 启动失败: {exc}"
    # async_default: 该 worker 任务耗时长(CDP GUI 驱动/CLI 长生成), 强制异步受理
    # 立即返回受理号, 后台经 async_worker 执行, 调度方用 hub_result/ref 轮询
    # (置于函数体顶层: 占位符 {task} 模式与无 model_arg 的 worker 同样走异步,
    #  否则掉进同步分支; 且不可在函数内 import subprocess —— 模块级已导入,
    #  函数内导入会让 subprocess 变成局部变量, 同步分支触发 UnboundLocalError)
    if _as_bool(prof.get("async_default"), False) or plan["metadata"]["stream"]:
        cb = args.get("callback_url")
        try:
            ref = _start_async(agent, "cmd", task,
                               {"cmd": cmd, "callback_url": cb, "cwd": cwd, "timeout_s": timeout,
                                "attachment_dir": plan["staging"], "attachment_parent": str((STATE / "attachments").resolve()),
                                "input_file": plan.get("input_file"), "availability_state": str(STATE), "profile_signature": profile_signature(prof),
                                "public_options": dict(plan["metadata"], model=model)},
                               env=process_env)
        except (OSError, RuntimeError) as exc:
            return f"{agent} CLI 启动失败: {exc}"
        plan["async_started"] = True
        cb_note = f"\n完成后将回调: {cb}" if cb else ""
        return (f"[{agent}/{ref}] 任务已异步受理 (此类任务耗时长, 不阻塞等待)。{cb_note}\n"
                f"查询结果: hub_result(ref=\"{ref}\")\n"
                f"轮询至 status=completed 即可取回回答 (running 时附受控端进度快照)。请勿因超时重复派发同一任务。")
    # workdir_via: 某些 CLI 的登录态绑定特定目录 (如 codebuddy-cn 绑 home),
    # 用 --add-dir 把真实目标目录挂进工作区, 而进程本身固定在 prof.cwd 下运行
    proc = None
    input_stream = None
    try:
        if plan.get("input_file"):
            input_stream = open(plan["input_file"], "rb")
        proc = spawn_owned(cmd, cwd=cwd, env=process_env, stdin=input_stream or subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           text=True, encoding="utf-8", errors="replace")
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _record_cli_outcome(agent, prof, model, "timeout")
        return f"{agent} CLI 执行超时 (> {timeout}s)。"
    except OSError as e:
        return f"{agent} CLI 启动失败: {e}"
    finally:
        terminate_owned(proc)
        if input_stream:
            input_stream.close()
    parsed = parse_output(stdout or "", stderr=stderr or "")
    out = parsed["error"] or parsed["text"] or stderr or ""
    code = proc.returncode or (1 if parsed["error"] else 0)
    if code == 0 and not parsed["text"].strip():
        code = 1
        out = parsed["error"] or "CLI 已退出但没有可验证的回答；请检查原任务，不要自动重复派发。"
    _record_cli_outcome(agent, prof, model, "completed" if code == 0 else "error", out)
    tag = f"{agent}/{model}" if model else agent
    return _truncate(f"[{tag}] exit={code}\n{out or '(无输出)'}")


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


def tool_hub_login(args):
    from login_manager import MANAGER
    worker = _resolve_agent(str(args.get("agent") or ""))
    action = str(args.get("action") or "status")
    reply = MANAGER.handle(worker, action, _load_agents().get(worker) or {})
    return json.dumps(reply, ensure_ascii=False)


# ---------------- hub_capabilities 进程内缓存（阶段四加固） ----------------
# 阶段三压测: hub_capabilities P50 ~2.2s（每次全量扫描 9 worker 的本地 CLI/进程状态）。
# 缓存契约: 非 refresh 调用且缓存 ≤5s 且 AGENTS_JSON / availability.json 的 mtime_ns
# 未变化时直接返回缓存 JSON 串（按 agent 过滤键区分）；refresh=True 或
# tool_hub_set_agent_status 写 agents.json 后立即失效 —— 文件改动秒级感知，回归契约 100% 保持。
_CAPS_CACHE_TTL = 5.0
_caps_cache = {}
_caps_lock = threading.Lock()


def _file_mtime_ns(path):
    try:
        return os.stat(path).st_mtime_ns
    except OSError:
        return None


def _caps_fingerprint():
    return (str(AGENTS_JSON), str(STATE), _file_mtime_ns(AGENTS_JSON), _file_mtime_ns(STATE / "availability.json"))


def tool_hub_capabilities(args):
    if not isinstance(args.get("refresh", False), bool):
        raise ValueError("refresh must be a boolean")
    wanted = _resolve_agent(str(args.get("agent") or args.get("worker") or ""))
    is_refresh = args.get("refresh", False) is True
    selected = str(args.get("model") or "").strip()
    cache_key = (wanted, selected)
    if not is_refresh:
        fp = _caps_fingerprint()
        now = time.monotonic()
        with _caps_lock:
            entry = _caps_cache.get(cache_key)
            if entry and (now - entry["at"]) < _CAPS_CACHE_TTL and entry["fp"] == fp:
                return entry["text"]
    text = _tool_hub_capabilities_impl(args)
    if not is_refresh:
        with _caps_lock:
            _caps_cache[cache_key] = {"text": text, "at": time.monotonic(), "fp": _caps_fingerprint()}
    return text


def _tool_hub_capabilities_impl(args):
    wanted = _resolve_agent(str(args.get("agent") or args.get("worker") or ""))
    if not isinstance(args.get("refresh", False), bool):
        raise ValueError("refresh must be a boolean")
    selected = str(args.get("model") or "").strip()
    profiles = _load_agents()
    if args.get("refresh"):
        if wanted and selected:
            refresh_availability(STATE, wanted, resolve_model(profiles.get(wanted) or {}, selected))
        else:
            refresh_availability(STATE, wanted or None)
    workers = {}
    for agent, profile in profiles.items():
        if wanted and agent != wanted:
            continue
        aliases = profile.get("models") or {}
        default_model = aliases.get("default")
        identifiers = list(dict.fromkeys(str(item) for item in aliases.values() if item))
        # An explicit empty default delegates selection to the official CLI.
        # Keep a capability row so clients do not invent a provider/model ID.
        if default_model == "" and "default" in aliases:
            identifiers.insert(0, "")
        if selected:
            identifiers = [resolve_model(profile, selected)]
        models = []
        for model in identifiers:
            item = {"id": model, "aliases": [key for key, value in aliases.items() if value == model],
                    "availability": local_availability(agent, profile, model, STATE),
                    **public_model_capabilities(agent, profile, model)}
            if model not in aliases.values() and profile.get("allow_unlisted_models") is not True:
                item["availability"] = {"enabled": False, "code": "model_not_configured", "reason": "所选模型未在本机 worker 配置中声明。", "refreshable": False}
            models.append(item)
        defaults = public_model_capabilities(agent, profile, default_model or "")
        is_configured = bool(profile.get("cli")) or agent in ("traecode", "trae") or bool(profile.get("gateway"))
        workers[agent] = {"configured": is_configured, "default_model": default_model,
                          "model_selection": bool(profile.get("model_arg")),
                          "availability": local_availability(agent, profile, None), "models": models,
                          "thinking": defaults["thinking"]["allowed"],
                          "stream": "stdout_progress" if profile.get("cli") else "gui_snapshot",
                          "attachments": {kind: item.get("mode") for kind, item in defaults["attachments"].items() if item["supported"]}}
    return json.dumps({"schema_version": 2, "platform": platform_name(), "workers": workers, "attachment_limit_bytes": 1024 * 1024,
                       "scope": "configured_capabilities_not_a_login_or_generation_check"}, ensure_ascii=False)


# ---------------- Trae 桥接 (经 TraeClaw 网关驱动 TraeCode CN 桌面) ----------------
TRAE_GATEWAY = os.environ.get("TRAE_GATEWAY", "http://127.0.0.1:8787").rstrip("/")


def _loopback_urlopen(request, timeout):
    """urlopen that never sends loopback traffic through an env proxy."""
    import urllib.parse
    import urllib.request
    url = request.full_url if isinstance(request, urllib.request.Request) else request
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    if host in {"127.0.0.1", "localhost", "::1"} or host.startswith("127."):
        return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=timeout)
    return urllib.request.urlopen(request, timeout=timeout)


def _trae_gw_post(path, payload, timeout=270):
    import urllib.request
    import urllib.error
    req = urllib.request.Request(
        TRAE_GATEWAY + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with _loopback_urlopen(req, timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.URLError as e:
        return {"error": f"无法连接 Trae 网关 ({TRAE_GATEWAY}{path}): {e}。请确认 TraeCode 桌面端及网关已就绪，或检查 TRAE_GATEWAY 配置。"}
    except Exception as e:
        return {"error": f"Trae 网关请求异常: {e}"}


def _trae_gw_get(path, timeout=15):
    import urllib.request
    import urllib.error
    try:
        with _loopback_urlopen(TRAE_GATEWAY + path, timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.URLError as e:
        return {"error": f"无法连接 Trae 网关 ({TRAE_GATEWAY}): {e}。请确认 TraeCode 桌面端及网关已就绪，或检查 TRAE_GATEWAY 配置。"}
    except Exception as e:
        return {"error": f"Trae 网关请求异常: {e}"}


def tool_hub_wait_result(args):
    """服务端阻塞等待: 内部按前置密集+递进回查 (0/3/6/12/25/45/70/95秒),
    快任务秒级命中, 长任务预算尽返回进度快照。单次预算上限 115s。"""
    ref = str(args.get("ref") or "").strip()
    if not ref:
        raise ValueError("缺少 ref")
    budget = min(_positive_seconds(args.get("wait_s"), 110), 115)
    start = time.monotonic()
    idx = 0
    last_progress = ""
    schedule = WAIT_CHECK_SCHEDULE
    while True:
        target = schedule[idx] if idx < len(schedule) else (schedule[-1] + 300 * (idx - len(schedule) + 1))
        remaining = budget - (time.monotonic() - start)
        if remaining <= 0:
            break
        wait = min(max(target - (time.monotonic() - start), 0), remaining)
        if wait > 0:
            time.sleep(wait)
        d = _reap_result(_read_result(ref))
        if not d:
            return f"[{ref}] status=unknown\n未找到任务结果，请核对 ref。"
        if d.get("status") in TERMINAL_STATUSES:
            return _format_result(d)
        if d and d.get("progress") and d["progress"] != last_progress:
            last_progress = d["progress"]
        idx += 1
        if time.monotonic() - start >= budget:
            break
    d = _reap_result(_read_result(ref))
    if d and d.get("status") in TERMINAL_STATUSES:
        return _format_result(d)
    if not d:
        return f"[{ref}] status=unknown\n未找到任务结果，请核对 ref。"
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
        return f"[{ref}] status=unknown\n未找到任务结果，请核对 ref。"
    return _format_result(d)


def tool_hub_result_json(args):
    ref = safe_component(str(args.get("ref") or "").strip())
    data = _reap_result(_read_result(ref))
    if not data:
        return json.dumps({"ref": ref, "status": "unknown", "text": "未找到任务结果，请核对 ref。"}, ensure_ascii=False)
    keys = ("ref", "agent", "status", "text", "progress", "exit_code", "updated_at", "model", "thinking", "stream", "attachments", "usage")
    return json.dumps({key: data[key] for key in keys if key in data}, ensure_ascii=False)


def tool_trae_status(args):
    h = _trae_gw_get("/health")
    if "error" in h:
        return f"TraeClaw 网关: 未连接 ({h['error']})"
    data = h.get("data", {})
    auto = data.get("automation", {})
    tgt = (auto.get("target") or {}).get("title", "")
    return f"TraeClaw 网关: {data.get('status', '?')} | CDP 自动化: {'就绪' if auto.get('ready') else '未就绪'} | 目标窗口: {tgt}"


# 服务端阻塞等待的内部回查时刻表 (秒, 累计): 0秒先查一次(快任务/旧ref秒回),
# 之后 3/6/12/25/45/70/95 秒递进 — 快任务几秒命中, 长任务 110s 预算尽返回进度
WAIT_CHECK_SCHEDULE = [0, 3, 6, 12, 25, 45, 70, 95]


def _save_result(ref, **kv):
    return update_result(RESULTS_DIR, ref, kv)


def _read_result(ref):
    return read_result(RESULTS_DIR, ref)


def _start_async(agent, mode, task, metadata, session_id="", env=None):
    """Persist one task and launch one worker with identical runtime paths."""
    import uuid
    ref = safe_component(agent) + "-" + uuid.uuid4().hex[:10]
    task_path = Path(RESULTS_DIR) / (ref + ".task")
    process_env = dict(os.environ if env is None else env)
    process_env.update(HUB_RESULTS_DIR=str(RESULTS_DIR), TRAE_GATEWAY=TRAE_GATEWAY,
                       HUB_STATE_DIR=str(STATE), TRAE_DOM_READ=TRAE_DOM_READ, ZCODE_DOM_DRIVER=ZCODE_DOM_DRIVER)
    _save_result(ref, agent=agent, status="running", task=task, **metadata.get("public_options", {}))
    try:
        atomic_write_json(task_path, metadata)
        kwargs = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL,
                  "stderr": subprocess.DEVNULL, "env": process_env}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        else:
            kwargs["start_new_session"] = True
        worker = subprocess.Popen([sys.executable, ASYNC_WORKER_SCRIPT, mode, ref, str(task_path), session_id], **kwargs)
        # Keep the handle alive until exit and reap finished workers even when
        # no later dispatch occurs. Workers still run independently of a client.
        threading.Thread(target=worker.wait, name="hub-worker-" + ref, daemon=True).start()
    except OSError as exc:
        _save_result(ref, status="error", text=f"异步执行器启动失败: {exc}")
        task_path.unlink(missing_ok=True)
        raise RuntimeError(f"异步执行器启动失败 (ref={ref}): {exc}") from exc
    return ref


def _check_gui_options(args, agent):
    prof = _load_agents().get(agent) or {}
    model = resolve_model(prof, args.get("model"))
    available = local_availability(agent, prof, model, STATE)
    if not available["enabled"] and available["code"] != "cli_not_configured":
        raise ValueError("UNAVAILABLE: " + available["code"] + ": " + available["reason"])
    if args.get("thinking", "default") != "default" or args.get("attachments"):
        raise ValueError("UNSUPPORTED: GUI 通道尚未验证思考开关或附件输入；请使用对应官方 CLI")
    if "stream" in args and not isinstance(args["stream"], bool):
        raise ValueError("stream 必须是布尔值")
    if args.get("cwd"):
        raise ValueError("UNSUPPORTED: GUI 通道无法保证指定工作目录")
    default = ((prof.get("models") or {}).get("default"))
    if model and model not in ("default", "默认", default):
        raise ValueError("UNSUPPORTED: GUI 通道无法切换请求的模型")


def tool_trae_delegate(args):
    _check_gui_options(args, "traecode")
    content = str(args.get("task") or "").strip()
    if not content:
        raise ValueError("缺少 task")
    wait = _as_bool(args.get("wait"), True)
    sid = args.get("session_id")
    timeout = _positive_seconds(args.get("timeout_s"), 240)
    if not wait:
        ref = _start_async("traecode", "trae", content,
                           {"task": content, "new_chat": _as_bool(args.get("new_chat"), False), "timeout_s": timeout},
                           session_id=sid or "")
        return (f"[traecode/{ref}] 已异步受理, status=running。\n"
                f"查询结果: trae_result(ref=\"{ref}\")")
    from async_worker import trae_run, CommandTimeout
    try:
        text, returned_sid = trae_run(content, sid or "", "", timeout=timeout,
                                      new_chat=_as_bool(args.get("new_chat"), False),
                                      gateway=TRAE_GATEWAY, dom_read=TRAE_DOM_READ, node=NODE_BIN)
        status = "completed"
    except CommandTimeout as exc:
        text, returned_sid, status = str(exc), sid or "", "timeout"
    except (RuntimeError, OSError, ValueError) as exc:
        text, returned_sid, status = str(exc), sid or "", "error"
    _save_result("trae-last", agent="trae", status=status, text=text, session_id=returned_sid)
    out = f"[trae/{returned_sid or 'new'}] status={status}\n{_truncate(str(text)) or '(空响应)'}"
    if returned_sid:
        out += f"\n(继续对话请带 session_id: {returned_sid})"
    return out


def _format_result(d):
    ref = d.get("ref", "?")
    text = d.get("text") or ""
    out = f"[{ref}] agent={d.get('agent')} status={d.get('status')}"
    if d.get("status") == "running" and d.get("progress"):
        out += f"\n[执行中·受控端界面快照] {str(d['progress'])[:600]}"
    out += f"\n{_truncate(str(text)) or '(尚无文本)'}"
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
    _check_gui_options(args, "zcode")
    content = str(args.get("task") or "").strip()
    if not content:
        raise ValueError("缺少 task")
    wait = _as_bool(args.get("wait"), True)
    timeout = _positive_seconds(args.get("timeout_s"), 300)
    if not wait:
        ref = _start_async("zcode", "zcode", content, {"task": content, "timeout_s": timeout})
        return (f"[zcode/{ref}] 已异步受理, status=running。\n"
                f"查询结果: zcode_result(ref=\"{ref}\")")
    driver = ZCODE_DOM_DRIVER
    if not os.path.exists(driver):
        return f"[zcode] 驱动脚本不存在: {driver}。请确认 drivers/ 目录已包含 zcode_dom.js 脚本。"
    proc = None
    try:
        proc = spawn_owned([NODE_BIN, driver, content], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
        stdout, stderr = proc.communicate(timeout=timeout)
        text = (stdout or "").strip()[-MAX_OUTPUT_CHARS:]
        if proc.returncode:
            text = (stderr or stdout or "驱动没有返回诊断输出").strip()[-MAX_OUTPUT_CHARS:]
        status = "completed" if proc.returncode == 0 else "error"
        _save_result("zcode-last", agent="zcode", status=status, text=text, exit_code=proc.returncode)
        return f"[zcode] status={status} exit={proc.returncode}\n{text or '(空响应)'}"
    except subprocess.TimeoutExpired:
        _save_result("zcode-last", agent="zcode", status="timeout", text=f"驱动执行超时 (>{timeout}s)")
        return f"[zcode] status=timeout\n驱动执行超时 (>{timeout}s)"
    finally:
        terminate_owned(proc)


def tool_zcode_result(args):
    ref = str(args.get("ref") or "").strip()
    if not ref:
        raise ValueError("缺少 ref")
    d = _reap_result(_read_result(ref))
    if not d:
        return f"未找到 {ref} 的结果 (可能尚未落盘, 稍后再查)。"
    return _format_result(d)


def tool_trae_new_chat(args):
    response = _trae_gw_post("/v1/mode", {"mode": str(args.get("mode") or "chat")}, timeout=15)
    if response.get("error"):
        raise RuntimeError(response["error"])
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
            current = _reap_result(d)
            if current.get("status") == "timeout":
                reaped.append((ref, age))
            elif current.get("status") == "running":
                still_running.append((ref, age))
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


def tool_hub_set_agent_status(args):
    agent = _resolve_agent(str(args.get("agent") or args.get("worker") or ""))
    if not agent:
        raise ValueError("缺少 agent 或 worker 参数")
    enabled = args.get("enabled")
    if enabled is None and "disabled" in args:
        enabled = not _as_bool(args.get("disabled"), False)
    elif enabled is not None:
        enabled = _as_bool(enabled, True)
    else:
        raise ValueError("缺少 enabled 或 disabled 参数")

    with _LockCtx("agents_config"):
        data = _read_json(AGENTS_JSON, {})
        if not isinstance(data, dict):
            data = {"agents": {}}
        agents = data.setdefault("agents", {})
        if agent not in agents:
            reg = _read_json(_state_path("registry.json"), {})
            if agent in reg:
                agents[agent] = {"role": reg[agent].get("role", "worker")}
            else:
                raise ValueError(f"未知 agent: {agent}")
        if enabled:
            agents[agent].pop("disabled", None)
        else:
            agents[agent]["disabled"] = True
        _write_json_atomic(AGENTS_JSON, data)
        with _caps_lock:
            _caps_cache.clear()

    try:
        refresh_availability(STATE, agent)
    except Exception:
        pass

    state_str = "已激活" if enabled else "已禁用"
    return json.dumps({
        "ok": True,
        "agent": agent,
        "enabled": enabled,
        "message": f"子代理 {agent} {state_str}，全端（WebUI 及各插件）已同步生效。"
    }, ensure_ascii=False)


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
    ("hub_dispatch_cli", "无头派发任务；模型、思考、流式与附件能力按 worker 配置校验，不支持的组合在执行前拒绝。",
     {"agent": {"type": "string"}, "task": {"type": "string"},
      "model": {"type": "string", "description": "模型别名或模型ID, 见 hub_list_models"},
      "extra_args": {"type": "array", "items": {"type": "string"}, "description": "追加到命令尾部的额外参数列表"},
      "cwd": {"type": "string"}, "timeout_s": {"type": "number"}, **OPTIONS_SCHEMA}, ["agent", "task"]),
    ("hub_capabilities", "查询 worker 已配置的模型与思考、流式、附件能力；不返回运行环境或凭据。",
     {"agent": {"type": "string"}, "worker": {"type": "string"}, "model": {"type": "string"},
      "refresh": {"type": "boolean", "description": "只清除本机最近失败状态；不登录、不执行推理"}}, []),
    ("hub_list_models", "查看各 worker 可用的模型别名表和模型参数名。",
     {"agent": {"type": "string", "description": "只看某个 worker"}}, []),
    ("hub_login", "获取官方 worker CLI 登录链接、查看登录状态或取消本次等待；凭据由官方 CLI 保存到 Hub 主机，不回传密码、Token 或 API Key。",
     {"agent": {"type": "string"},
      "action": {"type": "string", "enum": ["start", "status", "cancel"], "default": "status"}}, ["agent"]),
    ("hub_result", "查询异步受理任务的结果 (zcode 等长任务 worker 派活时自动返回 ref)。即时返回, 不等待。",
     {"ref": {"type": "string"}}, ["ref"]),
    ("hub_result_json", "查询结构化任务状态和增量进度，不包含私有执行参数。",
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
      "timeout_s": {"type": "number", "default": 300}},
     ["task"]),
    ("zcode_result", "查询异步 ZCode 任务的结果 (配合 zcode_delegate wait=false)。",
     {"ref": {"type": "string"}}, ["ref"]),
    ("hub_set_agent_status", "设置指定子代理的激活/禁用状态（写入 agents.json 并全端同步）。",
     {"agent": {"type": "string", "description": "子代理名称 (如 zcode, codebuddy, antigravity 等)"},
      "enabled": {"type": "boolean", "description": "是否激活 (true 为激活，false 为禁用)"}},
     ["agent", "enabled"]),
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
    ("hub_login", tool_hub_login), ("hub_capabilities", tool_hub_capabilities),
    ("hub_set_agent_status", tool_hub_set_agent_status),
    ("trae_status", tool_trae_status), ("trae_delegate", tool_trae_delegate),
    ("trae_result", tool_trae_result),
    ("trae_new_chat", tool_trae_new_chat),
    ("zcode_delegate", tool_zcode_delegate), ("zcode_result", tool_zcode_result),
    ("hub_result", tool_hub_result), ("hub_result_json", tool_hub_result_json), ("hub_wait_result", tool_hub_wait_result),
    ("hub_reap", tool_hub_reap)]}


# ---------------------------------------------------------------- json-rpc

def handle_request(req):
    from rpc_protocol import handle_request as dispatch
    return dispatch(req, tools=TOOLS_JSON, handlers={key: entry[0] for key, entry in HANDLERS.items()},
                    name=SERVER_NAME, version=SERVER_VERSION, protocol=PROTOCOL_VERSION_DEFAULT)


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

    def dispatch_request(self, req):
        return handle_request(req)

    def access_token(self):
        return HUB_TOKEN

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type, Accept, Authorization, Mcp-Session-Id")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def _drain_rejected_body(self):
        """Let clients receive a rejection before Windows closes the socket.

        Closing with unread request bytes can reset TCP and discard the 401.
        Flush the response first; discard only a bounded amount for 250 ms at
        most. Rejected bodies are never parsed or passed to tool handlers.
        """
        self.wfile.flush()
        try:
            remaining = min(2 * 1024 * 1024, max(0, int(self.headers.get("Content-Length") or 0)))
        except ValueError:
            return
        previous = self.connection.gettimeout()
        deadline = time.monotonic() + .25
        try:
            while remaining and time.monotonic() < deadline:
                self.connection.settimeout(max(.001, deadline - time.monotonic()))
                chunk = self.rfile.read1(min(8192, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
        except OSError:
            pass
        finally:
            self.connection.settimeout(previous)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if urllib.parse.urlparse(self.path).path == "/health":
            body = json.dumps({"service": SERVER_NAME, "status": "ok", "version": SERVER_VERSION,
                               "auth_required": bool(self.access_token())}).encode("utf-8")
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(405)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _authorized(self) -> bool:
        token = self.access_token()
        if not token:
            return True
        auth = self.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            supplied = auth[7:].strip()
        else:
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            supplied = (q.get("token") or [""])[0]
        return bool(supplied) and secrets.compare_digest(supplied.encode("utf-8"), token.encode("utf-8"))

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
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.close_connection = True
            self._drain_rejected_body()
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length < 0 or length > 2 * 1024 * 1024:
                self.send_response(413)
                self._cors()
                self.send_header("Content-Length", "0")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                self._drain_rejected_body()
                return
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
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            return
        resp = self.dispatch_request(req)
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
        safe_args = tuple(str(item).split("?", 1)[0] + " [query omitted]" if "?" in str(item) else item for item in args)
        sys.stderr.write("[agent-hub.http] %s\n" % (fmt % safe_args))


class HubHTTPServer(ThreadingHTTPServer):
    """One listener owns a Windows port; retain normal POSIX restart reuse."""
    allow_reuse_address = os.name != "nt"
    allow_reuse_port = False
    # 阶段四加固: Python 默认 request_queue_size=5, 360 并发同波会打爆 SYN 队列 (阶段三压测实证)
    request_queue_size = 256

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def run_http(port: int, host: str = "127.0.0.1"):
    try:
        sys.stderr.reconfigure(line_buffering=True)  # 保证强杀进程后日志已落盘
    except (AttributeError, OSError):
        pass
    if host not in ("127.0.0.1", "localhost", "::1") and not HUB_TOKEN:
        raise SystemExit("拒绝启动: 非回环监听必须设置 HUB_TOKEN 环境变量 (防裸奔)")
    server = HubHTTPServer((host, port), _HTTPHandler)
    from discovery import start_discovery
    discovery = start_discovery(host, server.server_address[1], bool(HUB_TOKEN))
    auth = "已启用 token 鉴权" if HUB_TOKEN else "未鉴权 (仅限本机回环!)"
    sys.stderr.write("[agent-hub] HTTP MCP 端点: http://%s:%d/mcp (%s)\n" % (host, server.server_address[1], auth))
    sys.stderr.write("[agent-hub] 状态目录: %s\n" % STATE)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if discovery is not None:
            discovery.close()
        from login_manager import MANAGER
        MANAGER.close()
        server.server_close()


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
