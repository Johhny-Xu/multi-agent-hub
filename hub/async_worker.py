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

结果文件: ~/agent-hub/results/<ref>.json
  {status: running|completed|error, text, progress, session_id, exit_code}

资源回收约定 (避免空闲吊起进程持续占 CPU/内存):
  - 进度轮询线程是 daemon, 受 stop_event 控制, 任务结束立即退出;
  - 子进程以独立进程组启动, 退出/异常时整组回收;
  - 任务文件 .task / .out 在结束后清理。
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DRIVERS_DIR = ROOT / "drivers"
STATE_DIR = HERE / "state"

RESULTS = (
    os.environ.get("HUB_RESULTS_DIR", "").strip()
    or (os.path.expanduser("~/agent-hub/results") if os.path.isdir(os.path.expanduser("~/agent-hub/results")) else str(STATE_DIR / "results"))
)
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


def save(ref, **kv):
    """原子写结果文件, 保证不出现半截 JSON。"""
    os.makedirs(RESULTS, exist_ok=True)
    p = os.path.join(RESULTS, ref + ".json")
    d = {}
    if os.path.exists(p):
        try:
            with open(p, encoding="utf-8") as f:
                d = json.load(f)
        except (OSError, ValueError):
            d = {}
    d.update(kv)
    d["ref"] = ref
    d["updated_at"] = time.time()
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, p)


def read_result(ref):
    p = os.path.join(RESULTS, ref + ".json")
    if not os.path.exists(p):
        return None
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def load_task_meta(path):
    """容错读取任务文件, 统一返回 dict(task, cmd, callback_url)。

    兼容纯文本任务 (trae/zcode delegate 直接写入) 与 JSON 对象 (hub 异步派发)。
    """
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read()
    except OSError as e:
        raise RuntimeError(f"读取任务文件失败: {e}")
    try:
        d = json.loads(raw)
    except ValueError:
        return {"task": raw, "cmd": None, "callback_url": None, "new_chat": False}
    if isinstance(d, dict):
        return {
            "task": d.get("task"),
            "cmd": d.get("cmd"),
            "callback_url": d.get("callback_url"),
            "new_chat": d.get("new_chat") is True,
        }
    # JSON 标量/数组: 当作任务文本使用
    text = d if isinstance(d, str) else json.dumps(d, ensure_ascii=False)
    return {"task": text, "cmd": None, "callback_url": None, "new_chat": False}


def subprocess_run(cmd_argv, timeout=25):
    try:
        p = subprocess.run(cmd_argv, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout)
        return p.stdout or ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def kill_process_group(proc):
    """整组回收子进程, 先 SIGTERM 后 SIGKILL, 避免留下孤儿进程空转。

    进程组操作是 Unix 专有 API (os.getpgid/os.killpg); 在无该 API 的平台上
    自动回退到单进程 terminate/kill。
    """
    if proc is None or proc.poll() is not None:
        return
    can_group = hasattr(os, "getpgid") and hasattr(os, "killpg")
    pgid = None
    if can_group:
        try:
            pgid = os.getpgid(proc.pid)
        except OSError:
            pgid = None
    try:
        if pgid is not None:
            os.killpg(pgid, signal.SIGTERM)
        else:
            proc.terminate()
    except OSError:
        pass
    try:
        proc.wait(timeout=10)
        return
    except Exception:  # noqa: BLE001 - 兜底升级为强杀
        pass
    try:
        if pgid is not None:
            os.killpg(pgid, signal.SIGKILL)
        else:
            proc.kill()
    except OSError:
        pass


def progress_poller(ref, reader_argv, stop_event):
    """每 PROGRESS_INTERVAL 秒读一次受控端界面快照, 写入 progress 字段。

    必须运行在独立线程中: 旧版在主线程同步调用本函数, 而 stop_event 只在
    线程 join 之后才 set, 导致死循环、worker 永不返回。
    """
    last = ""
    while not stop_event.is_set():
        try:
            prog = (subprocess_run(reader_argv) or "").strip()
            if prog and prog != last:
                last = prog
                save(ref, status="running", progress=prog[:800])
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


def trae_run(task, session_id, ref, new_chat=False, timeout=TRAE_TIMEOUT):
    payload = {"content": task, "sessionMetadata": {"client": "async"}}
    if session_id:
        payload["sessionId"] = session_id
    # 默认延续当前对话; 仅显式 new_chat=true 才新开对话
    if new_chat:
        payload["newChat"] = True
    box = {}

    def worker():
        try:
            payload_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            req = urllib.request.Request(
                GATEWAY + "/v1/chat", data=payload_bytes,
                headers={"Content-Type": "application/json; charset=utf-8"},
                method="POST")
            with urllib.request.urlopen(req, timeout=600) as r:
                d = json.loads(r.read().decode("utf-8"))
            data = d.get("data", {})
            sess = data.get("session", {})
            box["text"] = (data.get("result") or {}).get("text") or ""
            box["sid"] = sess.get("sessionId") or session_id or ""
            if not box["text"].strip() and os.path.exists(DOM_READ_TRAE):
                box["text"] = subprocess_run([NODE, DOM_READ_TRAE], timeout=120).strip()
        except Exception as e:  # noqa: BLE001
            box["error"] = str(e)[:300]

    th = threading.Thread(target=worker, daemon=True)
    th.start()
    stop = threading.Event()
    poller = start_progress_poller(ref, DOM_READ_TRAE, stop)
    th.join(timeout=timeout)
    stop.set()
    if poller:
        poller.join(timeout=15)
    if th.is_alive():
        raise RuntimeError(f"trae 任务超时 (>{timeout}s), 已回收轮询线程")
    if "error" in box:
        raise RuntimeError(box["error"])
    return box.get("text", ""), box.get("sid", "")


def zcode_run(task, session_id, ref, timeout=ZCODE_TIMEOUT):
    driver = DOM_DRIVER_ZCODE
    reader = DOM_READ_ZCODE
    if not os.path.exists(driver):
        raise RuntimeError(f"ZCode 驱动不存在: {driver}。请确保 drivers/ 目录已包含 zcode_dom.js")
    box = {}

    def worker():
        try:
            box["text"] = subprocess_run([NODE, driver, task], timeout=timeout).strip()
        except Exception as e:  # noqa: BLE001
            box["error"] = str(e)[:300]

    th = threading.Thread(target=worker, daemon=True)
    th.start()
    stop = threading.Event()
    poller = start_progress_poller(ref, reader, stop)
    th.join(timeout=timeout + 60)
    stop.set()
    if poller:
        poller.join(timeout=15)
    if th.is_alive():
        raise RuntimeError(f"zcode 任务超时 (>{timeout}s), 已回收轮询线程")
    if "error" in box:
        raise RuntimeError(box["error"])
    return box.get("text", "")


def run_cmd_mode(cmd_list, taskfile, ref):
    """执行 CLI 命令并回传输出尾部作为进度; 结束后整组回收子进程。"""
    tmpout = taskfile + ".out"
    proc = None
    try:
        with open(tmpout, "w", encoding="utf-8") as fo:
            popen_kwargs = {"stdout": fo, "stderr": subprocess.STDOUT}
            if os.name == "nt":
                popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            else:
                popen_kwargs["start_new_session"] = True
            proc = subprocess.Popen(cmd_list, **popen_kwargs)
            last = ""
            while proc.poll() is None:
                time.sleep(5)
                try:
                    with open(tmpout, encoding="utf-8", errors="replace") as f:
                        tail = f.read()[-600:].strip()
                    if tail and tail != last:
                        last = tail
                        save(ref, status="running", progress=tail, exit_code=None)
                except OSError:
                    pass
        with open(tmpout, encoding="utf-8", errors="replace") as f:
            text = f.read().strip()[-4000:]
        return text or "(无输出)", proc.returncode
    finally:
        kill_process_group(proc)
        try:
            os.unlink(tmpout)
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
        urllib.request.urlopen(req, timeout=15)
        print("[async] callback 已推送:", callback_url)
    except Exception as e:  # noqa: BLE001
        print("[async] callback 推送失败:", str(e)[:200])


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
    session_id = sys.argv[4] if len(sys.argv) > 4 else ""

    try:
        meta = load_task_meta(taskfile)
    except RuntimeError as e:
        save(ref, agent=mode, status="error", text=str(e)[:500], progress=None)
        return 1

    task = meta["task"]
    cmd = meta["cmd"]
    callback_url = meta["callback_url"]
    if mode == "cmd" and cmd is not None:
        task = json.dumps(cmd, ensure_ascii=False)
    elif task is None:
        task = ""

    save(ref, agent=mode, status="running", task=task, callback_url=callback_url)
    try:
        if mode == "trae":
            text, sid = trae_run(task, session_id, ref, new_chat=meta.get("new_chat", False))
            save(ref, status="completed", text=text, session_id=sid or None,
                 progress=None)
        elif mode == "cmd":
            cmd_list = cmd if isinstance(cmd, list) else json.loads(task)
            text, code = run_cmd_mode(cmd_list, taskfile, ref)
            save(ref, status="completed", text=text or "(无输出)",
                 exit_code=code, progress=None)
        else:
            text = zcode_run(task, session_id, ref)
            save(ref, status="completed", text=text, session_id=session_id or None,
                 progress=None)
        push_callback(callback_url, read_result(ref))
    except Exception as e:  # noqa: BLE001 - 任何异常都必须落盘, 否则调用方会永久轮询
        save(ref, status="error", text=f"执行出错: {e}"[:500], progress=None)
        push_callback(callback_url, {"ref": ref, "status": "error",
                                     "text": f"执行出错: {e}"[:300]})
    finally:
        cleanup_taskfile(taskfile)
    return 0


if __name__ == "__main__":
    sys.exit(main())
