#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Process liveness helpers for async worker status.

The Hub must not treat "no stdout for N seconds" as "worker is dead".
This module answers the cheaper, more direct question first: is the worker
process (or any of its children) still alive, and how much CPU has the tree
consumed so far?

Linux uses /proc directly (no external dependencies). Other platforms fall
back to a best-effort os.kill(pid, 0) liveness check without CPU accounting.
"""

from __future__ import annotations

import os
from pathlib import Path

PROC = Path("/proc")


def _clock_ticks():
    try:
        return float(os.sysconf("SC_CLK_TCK")) or 100.0
    except (AttributeError, OSError, ValueError):
        return 100.0


def _read_proc_table():
    """Return {pid: {ppid, state, ticks}} for every visible Linux process."""
    table = {}
    if not PROC.is_dir():
        return table
    for entry in PROC.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            raw = (entry / "stat").read_text(encoding="utf-8", errors="replace")
            # comm may contain spaces and parentheses; split after the last ')'.
            tail = raw.rsplit(")", 1)[1].strip().split()
            table[int(entry.name)] = {
                "ppid": int(tail[1]),
                "state": tail[0],
                "ticks": int(tail[11]) + int(tail[12]),
            }
        except (OSError, ValueError, IndexError):
            continue
    return table


def _fallback_alive(pid):
    if os.name == "nt":
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(0x1000, False, int(pid))  # QUERY_LIMITED_INFORMATION
            if not handle:
                # Access denied still means the PID exists; only ERROR_INVALID_PARAMETER
                # (87) / not found means it is gone for our own child processes.
                return kernel32.GetLastError() == 5
            try:
                code = ctypes.c_ulong()
                if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                    return True
                return code.value == 259  # STILL_ACTIVE
            finally:
                kernel32.CloseHandle(handle)
        except Exception:  # noqa: BLE001 - best effort only
            return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (OSError, ValueError):
        return False


def probe_process_tree(pid):
    """Probe one process and its descendants.

    Returns a dict with alive, zombie, cpu_seconds, process_count, children.
    `alive` is False when the root process is gone or is only a zombie.
    """
    try:
        root = int(pid)
    except (TypeError, ValueError):
        return {"alive": None, "cpu_seconds": None, "process_count": 0, "children": 0, "source": "none"}
    if root <= 0:
        return {"alive": None, "cpu_seconds": None, "process_count": 0, "children": 0, "source": "none"}

    table = _read_proc_table()
    if not table:
        alive = _fallback_alive(root)
        return {"alive": alive, "cpu_seconds": None,
                "process_count": 1 if alive else 0,
                "children": 0, "source": "fallback"}

    if root not in table:
        return {"alive": False, "cpu_seconds": None, "process_count": 0,
                "children": 0, "source": "proc"}

    tree = {root}
    changed = True
    while changed:
        changed = False
        for child_pid, info in table.items():
            if child_pid not in tree and info["ppid"] in tree:
                tree.add(child_pid)
                changed = True

    state = table[root]["state"]
    ticks = sum(table[item]["ticks"] for item in tree)
    return {
        "alive": state != "Z",
        "zombie": state == "Z",
        "cpu_seconds": round(ticks / _clock_ticks(), 3),
        "process_count": len(tree),
        "children": max(0, len(tree) - 1),
        "source": "proc",
    }
