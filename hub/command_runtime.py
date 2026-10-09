"""Portable command launch, child ownership, and atomic JSON writes.

Windows commands remain argument lists: recognizable npm shims are bypassed
with their actual Node entrypoint instead of enabling a shell for user prompts.
"""
import json
import math
import os
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from pathlib import Path


def prepare_command(argv, env=None):
    if isinstance(argv, (str, bytes)) or not argv:
        raise ValueError("command must be a nonempty argument list")
    command = [str(item) for item in argv]
    path_env = env.get("PATH", os.defpath) if env is not None else None
    executable = shutil.which(command[0], path=path_env) or command[0]
    command[0] = executable
    if os.name != "nt":
        return command
    path = Path(executable)
    if path.suffix.lower() == ".cmd":
        try:
            text = path.read_text(encoding="utf-8", errors="replace")[:32768]
        except OSError:
            text = ""
        # npm's generated Windows wrapper ends with node + a %dp0%-relative
        # node_modules entrypoint + %*. Do not reinterpret arbitrary scripts.
        match = re.search(r'"%dp0%[\\/]*([^"\r\n]*node_modules[\\/][^"\r\n]+)"\s+%\*', text, re.I)
        if match and re.search(r"\bnode(?:\.exe)?\b", text, re.I):
            script = path.parent / match.group(1).replace("/", "\\")
            if script.is_file():
                local_node = path.parent / "node.exe"
                node = str(local_node) if local_node.is_file() else shutil.which("node", path=path_env)
                if not node:
                    raise FileNotFoundError("Node.js is required for this npm command")
                return [node, str(script.resolve()), *command[1:]]
    if path.suffix.lower() == ".ps1":
        powershell = shutil.which("pwsh", path=path_env) or shutil.which("powershell", path=path_env)
        if not powershell:
            raise FileNotFoundError("PowerShell is required for a .ps1 command")
        return [powershell, "-NoProfile", "-NonInteractive", "-File", executable, *command[1:]]
    return command


def positive_timeout(value, default):
    timeout = float(default if value is None else value)
    if isinstance(value, bool) or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("timeout_s 必须为大于 0 的有限数值")
    return timeout


class _WindowsJob:
    def __init__(self):
        import ctypes

        class Basic(ctypes.Structure):
            _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                        ("flags", ctypes.c_uint32), ("min_ws", ctypes.c_size_t),
                        ("max_ws", ctypes.c_size_t), ("active", ctypes.c_uint32),
                        ("affinity", ctypes.c_size_t), ("priority", ctypes.c_uint32),
                        ("scheduling", ctypes.c_uint32)]

        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in
                        ("reads", "writes", "others", "read_bytes", "write_bytes", "other_bytes")]

        class Extended(ctypes.Structure):
            _fields_ = [("basic", Basic), ("io", IO), ("process_mem", ctypes.c_size_t),
                        ("job_mem", ctypes.c_size_t), ("peak_process", ctypes.c_size_t),
                        ("peak_job", ctypes.c_size_t)]

        class ThreadEntry(ctypes.Structure):
            _fields_ = [("size", ctypes.c_uint32), ("usage", ctypes.c_uint32),
                        ("thread_id", ctypes.c_uint32), ("process_id", ctypes.c_uint32),
                        ("base_priority", ctypes.c_long), ("delta_priority", ctypes.c_long),
                        ("flags", ctypes.c_uint32)]

        self.ctypes, self.ThreadEntry = ctypes, ThreadEntry
        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        definitions = {
            "CreateJobObjectW": ([ctypes.c_void_p, ctypes.c_wchar_p], ctypes.c_void_p),
            "SetInformationJobObject": ([ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32], ctypes.c_int),
            "AssignProcessToJobObject": ([ctypes.c_void_p, ctypes.c_void_p], ctypes.c_int),
            "CloseHandle": ([ctypes.c_void_p], ctypes.c_int),
            "CreateToolhelp32Snapshot": ([ctypes.c_uint32, ctypes.c_uint32], ctypes.c_void_p),
            "Thread32First": ([ctypes.c_void_p, ctypes.POINTER(ThreadEntry)], ctypes.c_int),
            "Thread32Next": ([ctypes.c_void_p, ctypes.POINTER(ThreadEntry)], ctypes.c_int),
            "OpenThread": ([ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32], ctypes.c_void_p),
            "ResumeThread": ([ctypes.c_void_p], ctypes.c_uint32),
        }
        for name, (args, result) in definitions.items():
            function = getattr(self.api, name)
            function.argtypes, function.restype = args, result
        self.handle = self.api.CreateJobObjectW(None, None)
        info = Extended()
        info.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.handle or not self.api.SetInformationJobObject(self.handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
            error = ctypes.get_last_error()
            self.close()
            raise ctypes.WinError(error)

    def attach_and_resume(self, proc):
        ctypes = self.ctypes
        if not self.api.AssignProcessToJobObject(self.handle, ctypes.c_void_p(int(proc._handle))):
            raise ctypes.WinError(ctypes.get_last_error())
        snapshot = self.api.CreateToolhelp32Snapshot(4, 0)  # TH32CS_SNAPTHREAD
        if snapshot == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            entry = self.ThreadEntry()
            entry.size = ctypes.sizeof(entry)
            available = self.api.Thread32First(snapshot, ctypes.byref(entry))
            while available:
                if entry.process_id == proc.pid:
                    thread = self.api.OpenThread(0x0002, False, entry.thread_id)  # THREAD_SUSPEND_RESUME
                    if not thread:
                        raise ctypes.WinError(ctypes.get_last_error())
                    try:
                        if self.api.ResumeThread(thread) == 0xFFFFFFFF:
                            raise ctypes.WinError(ctypes.get_last_error())
                    finally:
                        self.api.CloseHandle(thread)
                    return
                available = self.api.Thread32Next(snapshot, ctypes.byref(entry))
            raise RuntimeError("Cannot find the newly created process's suspended thread")
        finally:
            self.api.CloseHandle(snapshot)

    def close(self):
        if getattr(self, "handle", None):
            self.api.CloseHandle(self.handle)
            self.handle = None


def spawn_owned(argv, **kwargs):
    """Start an owned process group/job, without touching existing processes."""
    command = prepare_command(argv, env=kwargs.get("env"))
    if os.name == "nt":
        job = _WindowsJob()
        proc = None
        try:
            # Attach before any child code runs, closing the orphan-spawn race.
            kwargs["creationflags"] = kwargs.get("creationflags", 0) | subprocess.CREATE_NEW_PROCESS_GROUP | 0x00000004
            proc = subprocess.Popen(command, **kwargs)  # CREATE_SUSPENDED
            proc._agenthub_job = job
            job.attach_and_resume(proc)
            return proc
        except BaseException:
            job.close()
            if proc is not None:
                if proc.poll() is None:
                    proc.kill()
                proc.wait(timeout=5)
            raise
    kwargs.setdefault("start_new_session", True)
    proc = subprocess.Popen(command, **kwargs)
    proc._agenthub_pgid = proc.pid if kwargs.get("start_new_session") else None
    return proc


def terminate_owned(proc):
    """Reclaim owned descendants even when the root process has already exited."""
    if proc is None:
        return
    lock = proc.__dict__.setdefault("_agenthub_stop_lock", threading.RLock())
    with lock:
        _terminate_owned_locked(proc)


def _terminate_owned_locked(proc):
    job = getattr(proc, "_agenthub_job", None)
    if job is not None:
        job.close()
        proc._agenthub_job = None
    pgid = getattr(proc, "_agenthub_pgid", None)
    if pgid is not None:
        # Clear ownership once, preventing later calls from signaling a reused ID.
        proc._agenthub_pgid = None
        try:
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        # The root may have exited while a descendant ignored SIGTERM. Root's
        # wait result cannot prove that its process group has gone away.
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait(timeout=5)
        return
    if proc.poll() is None:
        proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def replace_with_retry(source, destination, timeout_s=1.0):
    deadline = time.monotonic() + max(0.0, float(timeout_s))
    while True:
        try:
            os.replace(source, destination)
            return
        except PermissionError:
            remaining = deadline - time.monotonic()
            if os.name != "nt" or remaining <= 0:
                raise
            time.sleep(min(0.02, remaining))


def atomic_write_json(path, data, timeout_s=1.0):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False)
        replace_with_retry(temporary, path, timeout_s=timeout_s)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
