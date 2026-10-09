"""Bounded, process-safe file locks for Hub state (standard library only)."""
import os
import threading
import time
import weakref
from pathlib import Path

_guard = threading.Lock()
_locks = weakref.WeakValueDictionary()


def safe_component(value):
    """Keep external identifiers within one portable filename component."""
    name = str(value or "")
    if (not name or name in {".", ".."} or len(name) > 160
            or name[-1] in ". " or any(ord(char) < 32 or char in '/\\:<>"|?*' for char in name)):
        raise ValueError("标识符不能包含路径分隔符、控制字符或非法文件名字符")
    if name.split(".", 1)[0].upper() in {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)], *[f"LPT{i}" for i in range(1, 10)]}:
        raise ValueError("标识符不能使用系统保留文件名")
    return name


class StateFileLock:
    """Lock a persistent file; OS ownership is released on process exit.

    Never remove a live process's lock based on elapsed time. Persistent lock
    files avoid the unlink/recreate inode race between concurrent processes.
    """
    def __init__(self, path, timeout_s=10):
        self.path = Path(path)
        self.timeout_s = float(timeout_s)
        self.file = None
        self.acquired = False
        key = os.path.normcase(str(self.path.resolve()))
        with _guard:
            self.thread_lock = _locks.get(key)
            if self.thread_lock is None:
                self.thread_lock = threading.RLock()
                _locks[key] = self.thread_lock

    def __enter__(self):
        deadline = time.monotonic() + self.timeout_s
        if not self.thread_lock.acquire(timeout=max(0, self.timeout_s)):
            raise TimeoutError(f"等待状态锁超时: {self.path.name}")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.file = open(self.path, "a+b", buffering=0)
            if self.file.seek(0, os.SEEK_END) == 0:
                self.file.write(b"\0")
            while True:
                try:
                    self.file.seek(0)
                    if os.name == "nt":
                        import msvcrt
                        msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.acquired = True
                    return self
                except (BlockingIOError, PermissionError):
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError(f"等待状态锁超时: {self.path.name}")
                    time.sleep(min(0.02, remaining))
        except BaseException:
            if self.file:
                self.file.close()
                self.file = None
            self.thread_lock.release()
            raise

    def __exit__(self, *exc):
        try:
            if self.acquired:
                self.file.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.file.fileno(), fcntl.LOCK_UN)
        finally:
            self.acquired = False
            if self.file:
                self.file.close()
                self.file = None
            self.thread_lock.release()
        return False
