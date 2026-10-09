#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""异步 worker: 后台执行 Trae/ZCode/CLI 派活并落盘结果, 执行期间回传界面进度快照

用法: python3 async_worker.py <mode: trae|zcode|cmd> <ref> <task文件路径> [session_id]

任务文件兼容两种格式 (历史原因, 两种都真实存在):
  1. JSON 对象: {"task": "...", "cmd": [...], "callback_url": "..."}   <- hub_dispatch_cli 异步派发
  2. 纯文本:    直接就是任务描述文本                                    <- trae_delegate / zcode_delegate
旧版只按格式 1 解析, 遇到格式 2 会在 json.load 抛 JSONDecodeError 且未被捕获,
导致 worker 进程直接崩溃、结果永远停留在 running (实测卡死 9~18 小时)。
此处统一由 load_task_meta() 容错解析。

结果文件: HUB_RESULTS_DIR/<ref>.json，默认 state/results/<ref>.json
  {status: running|completed|error, text, progress, session_id, exit_code}

资源回收约定 (避免空闲吊起进程持续占 CPU/内存):
  - 进度轮询线程是 daemon, 受 stop_event 控制, 任务结束立即退出;
  - 子进程以独立进程组启动, 退出/异常时整组回收;
  - 任务文件 .task / .out 在结束后清理。
"""

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

from command_runtime import positive_timeout, spawn_owned, terminate_owned
from result_store import read_result as stored_result, update_result
from task_contract import cleanup_attachments
from output_parser import parse_output, parse_usage
from availability_store import record_outcome

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DRIVERS_DIR = ROOT / "drivers"
STATE_DIR = Path(os.path.expandvars(os.path.expanduser(os.environ.get("HUB_STATE_DIR") or str(HERE / "state")))).resolve()

RESULTS = str(Path(os.path.expandvars(os.path.expanduser(
    os.environ.get("HUB_RESULTS_DIR", "").strip()
    or str(STATE_DIR / "results")
))).resolve())
GATEWAY = os.environ.get("TRAE_GATEWAY", "http://127.0.0.1:8787").rstrip("/")
NODE = shutil.which("node") or "node"
DOM_READ_TRAE = (
    os.environ.get("TRAE_DOM_READ", "").strip()
    or (str(DRIVERS_DIR / "dom_read.js") if (DRIVERS_DIR / "dom_read.js").exists() else os.path.expanduser("~/TraeClaw/dom_read.js"))
)
DOM_READ_ZCODE = (
    os.environ.get("ZCODE_READER", "").strip()
    or (str(DRIVERS_DIR / "zcode_read.js") if (DRIVERS_DIR / "zcode_read.js").exists() else os.path.expanduser("~/TraeClaw/zcode_read.js"))
)
DOM_DRIVER_ZCODE = (
    os.environ.get("ZCODE_DOM_DRIVER", "").strip()
    or (str(DRIVERS_DIR / "zcode_dom.js") if (DRIVERS_DIR / "zcode_dom.js").exists() else os.path.expanduser("~/TraeClaw/zcode_dom.js"))
)

# 单个任务的最长执行时间 (秒), 超过即判定超时并回收, 防止进程无限吊起
TRAE_TIMEOUT = 900
ZCODE_TIMEOUT = 1000
PROGRESS_INTERVAL = 6


def save(ref, only_if_running=False, **kv):
    return update_result(RESULTS, ref, kv, only_if_running=only_if_running)


def read_result(ref):
    return stored_result(RESULTS, ref)


def load_task_meta(path):
    """容错读取任务文件, 统一返回 dict(task, cmd, callback_url)。

    兼容纯文本任务 (trae/zcode delegate 直接写入) 与 JSON 对象 (hub 异步派发)。
    """
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read()
    except (OSError, UnicodeError) as e:
        raise RuntimeError(f"读取任务文件失败: {e}")
    try:
        d = json.loads(raw)
    except ValueError:
        return {"task": raw, "cmd": None, "callback_url": None, "new_chat": False,
                "cwd": None, "timeout_s": None, "env": None}
    if isinstance(d, dict):
        return {
            "task": d.get("task"),
            "cmd": d.get("cmd"),
            "callback_url": d.get("callback_url"),
            "new_chat": d.get("new_chat") is True,
            "cwd": d.get("cwd") or None,
            "timeout_s": d.get("timeout_s"),
            "env": d.get("env"),
            "attachment_dir": d.get("attachment_dir"),
            "attachment_parent": d.get("attachment_parent"),
            "input_file": d.get("input_file"),
            "availability_state": d.get("availability_state"),
            "profile_signature": d.get("profile_signature"),
            "public_options": d.get("public_options") or {},
        }
    # JSON 标量/数组: 当作任务文本使用
    text = d if isinstance(d, str) else json.dumps(d, ensure_ascii=False)
    return {"task": text, "cmd": None, "callback_url": None, "new_chat": False,
            "cwd": None, "timeout_s": None, "env": None}


class CommandTimeout(RuntimeError):
    pass


class CommandCancelled(RuntimeError):
    pass


def subprocess_run(cmd_argv, timeout=25, stop_event=None, input_data=None):
    timeout = positive_timeout(timeout, 25)
    proc = None
    try:
        proc = spawn_owned(cmd_argv, stdin=subprocess.PIPE if input_data is not None else subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
        deadline = time.monotonic() + timeout
        while True:
            if stop_event is not None and stop_event.is_set():
                raise CommandCancelled("进度读取已停止")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CommandTimeout(f"子进程执行超时 (>{timeout}s)")
            try:
                out, err = proc.communicate(input=input_data, timeout=min(.1, remaining) if stop_event is not None else remaining)
                break
            except subprocess.TimeoutExpired:
                input_data = None
        if proc.returncode:
            diagnostic = (err or out or "无诊断输出").strip()[-1200:]
            raise RuntimeError(f"子进程失败 (exit={proc.returncode}): {diagnostic}")
        return out or ""
    finally:
        terminate_owned(proc)


def kill_process_group(proc):
    """兼容旧调用名; Windows Job Object 回收整棵自有子进程树。"""
    terminate_owned(proc)


def progress_poller(ref, reader_argv, stop_event):
    """每 PROGRESS_INTERVAL 秒读一次受控端界面快照, 写入 progress 字段。

    必须运行在独立线程中: 旧版在主线程同步调用本函数, 而 stop_event 只在
    线程 join 之后才 set, 导致死循环、worker 永不返回。
    """
    last = ""
    while not stop_event.is_set():
        try:
            prog = (subprocess_run(reader_argv, stop_event=stop_event) or "").strip()
            if not stop_event.is_set() and prog and prog != last:
                last = prog
                save(ref, only_if_running=True, progress=prog[:800])
        except Exception:  # noqa: BLE001 - 轮询失败不应影响主任务
            pass
        stop_event.wait(PROGRESS_INTERVAL)


def start_progress_poller(ref, reader_script, stop_event):
    if not reader_script or not os.path.exists(reader_script):
        return None
    th = threading.Thread(target=progress_poller,
                          args=(ref, [NODE, reader_script], stop_event),
                          daemon=True)
    th.start()
    return th


_HTTP_REQUEST = """import json, sys, urllib.request
payload = sys.stdin.buffer.read()
request = urllib.request.Request(sys.argv[1], data=payload,
    headers={"Content-Type": "application/json; charset=utf-8"}, method="POST")
with urllib.request.urlopen(request, timeout=float(sys.argv[2])) as response:
    sys.stdout.buffer.write(response.read())
"""


def trae_run(task, session_id, ref, new_chat=False, timeout=TRAE_TIMEOUT, *, gateway=None, dom_read=None, node=None):
    timeout = positive_timeout(timeout, TRAE_TIMEOUT)
    deadline = time.monotonic() + timeout
    gateway = GATEWAY if gateway is None else str(gateway).rstrip("/")
    dom_read = DOM_READ_TRAE if dom_read is None else dom_read
    node = NODE if node is None else node
    payload = {"content": task, "sessionMetadata": {"client": "async"}}
    if session_id:
        payload["sessionId"] = session_id
    # 默认延续当前对话; 仅显式 new_chat=true 才新开对话
    if new_chat:
        payload["newChat"] = True
    stop = threading.Event()
    poller = start_progress_poller(ref, dom_read, stop) if ref else None
    try:
        # Own the HTTP client process so the absolute deadline also bounds a
        # stalled response body and cannot leave a late DOM read behind.
        raw = subprocess_run([sys.executable, "-c", _HTTP_REQUEST, gateway + "/v1/chat", str(timeout)],
                             timeout=timeout, input_data=json.dumps(payload, ensure_ascii=False))
        d = json.loads(raw)
        if not isinstance(d, dict):
            raise RuntimeError("Trae 网关返回了无效响应")
        if d.get("error") or d.get("success") is False:
            raise RuntimeError(str(d.get("error") or "Trae 网关执行失败")[:300])
        data = d.get("data") or {}
        if not isinstance(data, dict):
            raise RuntimeError("Trae 网关返回了无效结果格式")
        sess = data.get("session") or {}
        result = data.get("result") or {}
        if not all(isinstance(item, dict) for item in (data, sess, result)):
            raise RuntimeError("Trae 网关返回了无效结果格式")
        statuses = [str(item).strip().lower() for item in (sess.get("status"), result.get("status")) if item is not None]
        if "timeout" in statuses:
            raise CommandTimeout("Trae 网关任务超时")
        if any(status in {"error", "failed"} for status in statuses):
            raise RuntimeError("Trae 网关任务失败: " + str(result.get("error") or sess.get("status") or result.get("status"))[:300])
        text = result.get("text") or ""
        if not isinstance(text, str):
            raise RuntimeError("Trae 网关返回了无效回答格式")
        # Legacy blocking /v1/chat returned a final nonempty result.text with no
        # status. Explicit running/unknown states can never override that rule.
        if (statuses and any(status not in {"completed", "done", "finished"} for status in statuses)) or (not statuses and not text.strip()):
            raise RuntimeError("Trae 网关状态不确定，继续查询原任务；请勿重新派发: " + ",".join(statuses or ["missing"]))
        sid = sess.get("sessionId") or session_id or ""
        if not text.strip() and os.path.exists(dom_read):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CommandTimeout(f"trae 任务超时 (>{timeout}s)")
            text = subprocess_run([node, dom_read], timeout=min(120, remaining)).strip()
        return text, sid
    finally:
        stop.set()
        if poller:
            poller.join(timeout=2)


def zcode_run(task, session_id, ref, timeout=ZCODE_TIMEOUT):
    timeout = positive_timeout(timeout, ZCODE_TIMEOUT)
    driver = DOM_DRIVER_ZCODE
    reader = DOM_READ_ZCODE
    if not os.path.exists(driver):
        raise RuntimeError(f"ZCode 驱动不存在: {driver}。请确保 drivers/ 目录已包含 zcode_dom.js")
    stop = threading.Event()
    poller = start_progress_poller(ref, reader, stop)
    try:
        return subprocess_run([NODE, driver, task], timeout=timeout).strip()
    finally:
        stop.set()
        if poller:
            poller.join(timeout=2)


def _read_cli_output(path, final=False, stderr=""):
    limit = 2 * 1024 * 1024 if final else 256 * 1024
    with open(path, "rb") as stream:
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        stream.seek(max(0, size - limit))
        raw = stream.read(limit).decode("utf-8", errors="replace")
    if size > limit:
        raw = raw.partition("\n")[2]
    if not final and raw and not raw.endswith("\n"):
        fragment = raw.rsplit("\n", 1)[-1]
        if fragment.lstrip().startswith(("{", "[")):
            try:
                json.loads(fragment)
            except ValueError:
                raw = raw.rpartition("\n")[0]
    return dict(parse_output(raw, stderr=stderr), usage=parse_usage(raw))


def _read_cli_stderr(path):
    """Scan exact terminal diagnostics without retaining unbounded stderr."""
    tail, error, line_start = b"", None, True
    with open(path, "rb") as stream:
        while True:
            chunk = stream.readline(4096)
            if not chunk:
                break
            tail = (tail + chunk)[-12000:]
            # The known diagnostic is a short complete line. A long log line
            # must not manufacture a new line boundary at a chunk split.
            if line_start and (chunk.endswith(b"\n") or len(chunk) < 4096):
                error = error or parse_output("", stderr=chunk.decode("utf-8", errors="replace"))["error"]
            line_start = chunk.endswith(b"\n")
    return tail.decode("utf-8", errors="replace").strip(), error


def run_cmd_mode(cmd_list, taskfile, ref, cwd=None, timeout_s=600, env=None, input_file=None, watch_result=False):
    """执行 CLI 命令并回传输出尾部作为进度; 结束后整组回收子进程。"""
    tmpout = taskfile + ".out"
    tmperr = taskfile + ".err"
    proc = None
    input_stream = None
    child_env = os.environ.copy()
    child_env["PYTHONIOENCODING"] = "utf-8"
    child_env["PYTHONUTF8"] = "1"
    if env:
        child_env.update({str(key): str(value) for key, value in env.items()})
    timeout_s = positive_timeout(timeout_s, 600)
    try:
        with open(tmpout, "w", encoding="utf-8") as fo, open(tmperr, "w", encoding="utf-8") as fe:
            if input_file:
                input_stream = open(input_file, "rb")
            proc = spawn_owned(cmd_list, cwd=cwd, env=child_env, stdin=input_stream or subprocess.DEVNULL,
                               stdout=fo, stderr=fe)
            deadline = time.monotonic() + timeout_s
            last = ""
            while proc.poll() is None:
                if watch_result:
                    current = read_result(ref)
                    if current and current.get("status") != "running":
                        raise CommandCancelled("任务已有终态，已停止其剩余子进程；保留原 ref。")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise CommandTimeout(f"CLI 任务超时 (>{timeout_s}s), 已回收子进程树")
                try:
                    proc.wait(timeout=min(0.1, remaining))
                except subprocess.TimeoutExpired:
                    pass
                try:
                    tail = _read_cli_output(tmpout)["text"][-20000:]
                    if tail and tail != last:
                        last = tail
                        save(ref, only_if_running=True, progress=tail, exit_code=None)
                except OSError:
                    pass
        diagnostic, terminal_error = _read_cli_stderr(tmperr)
        parsed = _read_cli_output(tmpout, final=True)
        if terminal_error:
            parsed.update(text="", error=terminal_error)
        if parsed["usage"]:
            save(ref, only_if_running=True, usage=parsed["usage"])
        text = parsed["error"] or parsed["text"]
        if proc.returncode and not parsed["error"]:
            # CLI spinners/status messages on stderr are not model answers.
            # Keep diagnostics only for failed executions, bounded in memory.
            if diagnostic:
                text = (text + "\n" if text else "") + diagnostic
        if not text.strip() and proc.returncode == 0:
            return "CLI 已退出但没有可验证的回答；请检查原任务，不要自动重复派发。", 1
        if len(text) > 20000:
            text = text[:20000] + "\n[输出超过 20000 字符，已截断]"
        return text or "(无输出)", proc.returncode or (1 if parsed["error"] else 0)
    finally:
        kill_process_group(proc)
        if input_stream:
            input_stream.close()
        for path in (tmpout, tmperr):
            try:
                os.unlink(path)
            except OSError:
                pass


def push_callback(callback_url, payload):
    if not callback_url:
        return
    try:
        req = urllib.request.Request(
            callback_url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST")
        with urllib.request.urlopen(req, timeout=15):
            pass
        print("[async] callback 已推送")
    except Exception as e:  # noqa: BLE001
        print("[async] callback 推送失败:", type(e).__name__)


def cleanup_taskfile(taskfile):
    try:
        os.unlink(taskfile)
    except OSError:
        pass


def main():
    if len(sys.argv) < 4:
        sys.stderr.write("用法: async_worker.py <mode: trae|zcode|cmd> <ref> <taskfile> [session_id]\n")
        return 2
    mode, ref, taskfile = sys.argv[1], sys.argv[2], sys.argv[3]
    if mode not in {"cmd", "trae", "zcode"}:
        sys.stderr.write("无效 worker mode\n")
        return 2
    session_id = sys.argv[4] if len(sys.argv) > 4 else ""

    try:
        meta = load_task_meta(taskfile)
    except RuntimeError as e:
        current = read_result(ref) or {}
        save(ref, only_if_running=bool(current), agent=current.get("agent") or mode, status="error", text=str(e)[:500], progress=None)
        cleanup_taskfile(taskfile)
        return 1

    task = meta["task"]
    cmd = meta["cmd"]
    callback_url = meta["callback_url"]
    if mode == "cmd" and cmd is not None:
        task = json.dumps(cmd, ensure_ascii=False)
    elif task is None:
        task = ""

    outcome = 0
    try:
        current = read_result(ref) or {}
        if current.get("status") and current["status"] != "running":
            return 1
        initial = {"agent": current.get("agent") or mode, "status": "running"}
        if mode != "cmd":
            initial["task"] = task
        current = save(ref, only_if_running=bool(current), **initial)
        if current.get("status") != "running":
            return 1
        if mode == "trae":
            text, sid = trae_run(task, session_id, ref, new_chat=meta.get("new_chat", False),
                                 timeout=positive_timeout(meta.get("timeout_s"), TRAE_TIMEOUT))
            save(ref, only_if_running=True, status="completed", text=text, session_id=sid or None,
                 progress=None)
        elif mode == "cmd":
            cmd_list = cmd if isinstance(cmd, list) else json.loads(task)
            text, code = run_cmd_mode(cmd_list, taskfile, ref, cwd=meta.get("cwd"),
                                      timeout_s=meta.get("timeout_s", 600), env=meta.get("env"), input_file=meta.get("input_file"), watch_result=True)
            save(ref, only_if_running=True, status="completed" if code == 0 else "error", text=text or "(无输出)",
                 exit_code=code, progress=None)
            outcome = 0 if code == 0 else 1
        else:
            text = zcode_run(task, session_id, ref, timeout=positive_timeout(meta.get("timeout_s"), ZCODE_TIMEOUT))
            save(ref, only_if_running=True, status="completed", text=text, session_id=session_id or None,
                 progress=None)
        push_callback(callback_url, read_result(ref))
    except CommandCancelled:
        outcome = 1
        push_callback(callback_url, read_result(ref))
    except CommandTimeout as e:
        outcome = 1
        save(ref, only_if_running=True, status="timeout", text=str(e), progress=None)
        push_callback(callback_url, read_result(ref))
    except Exception as e:  # noqa: BLE001 - 任何异常都必须落盘, 否则调用方会永久轮询
        outcome = 1
        save(ref, only_if_running=True, status="error", text=f"执行出错: {e}"[:500], progress=None)
        push_callback(callback_url, read_result(ref))
    finally:
        if meta.get("availability_state"):
            current = read_result(ref) or {}
            options = meta.get("public_options") or {}
            try:
                record_outcome(meta["availability_state"], current.get("agent") or mode, options.get("model"),
                               current.get("status"), current.get("text", ""), meta.get("profile_signature"))
            except (OSError, ValueError, TimeoutError):
                # Optional availability hints must never hide a task result.
                pass
        if meta.get("attachment_dir") and meta.get("attachment_parent"):
            try:
                cleanup_attachments(meta["attachment_dir"], meta["attachment_parent"])
            except (OSError, ValueError):
                pass
        cleanup_taskfile(taskfile)
    return outcome


if __name__ == "__main__":
    sys.exit(main())
