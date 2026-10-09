"""Shared atomic result updates used by the Hub and background workers."""
import json
import time
from pathlib import Path
from command_runtime import atomic_write_json
from state_store import StateFileLock, safe_component


def result_path(directory, ref):
    return Path(directory) / (safe_component(ref) + ".json")


def read_result(directory, ref):
    path = result_path(directory, ref)
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
        return result if isinstance(result, dict) else None
    except (OSError, ValueError):
        return None


def update_result(directory, ref, fields, *, only_if_running=False, expected_updated_at=None):
    path = result_path(directory, ref)
    with StateFileLock(path.with_suffix(".json.lock")):
        current = read_result(directory, ref) or {}
        if only_if_running and current.get("status") != "running":
            return current
        if expected_updated_at is not None and current.get("updated_at") != expected_updated_at:
            return current
        current.update(fields)
        current["ref"] = ref
        current["updated_at"] = time.time()
        atomic_write_json(path, current)
        return current
