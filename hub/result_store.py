"""Shared atomic result updates used by the Hub and background workers."""
import json
import time
from pathlib import Path
from command_runtime import atomic_write_json
from state_store import StateFileLock, safe_component


def result_path(directory, ref):
    return Path(directory) / (safe_component(ref) + ".json")


def status_history(result):
    """Return the recorded status changes; legacy records have none."""
    value = (result or {}).get("status_history")
    return value if isinstance(value, list) else []


def dispatch_count(result):
    """Return the recorded dispatch count, or None when it predates the field."""
    value = (result or {}).get("dispatch_count")
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def read_result(directory, ref):
    path = result_path(directory, ref)
    deadline = time.monotonic() + 1.0
    while True:
        try:
            result = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(result, dict):
                raise ValueError("Result is not an object")
            return result
        except FileNotFoundError:
            return None
        except PermissionError as error:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("Task result is temporarily inaccessible; preserve its ref") from error
            time.sleep(min(0.02, remaining))
        except ValueError as error:
            # A corrupt existing result must never be treated as a fresh empty
            # task by update_result, which would silently lose its metadata.
            raise RuntimeError("Task result is invalid; preserve its ref") from error


def update_result(directory, ref, fields, *, only_if_running=False, expected_updated_at=None):
    path = result_path(directory, ref)
    with StateFileLock(path.with_suffix(".json.lock")):
        current = read_result(directory, ref) or {}
        if only_if_running and current.get("status") != "running":
            return current
        if expected_updated_at is not None and current.get("updated_at") != expected_updated_at:
            return current
        fields = dict(fields)
        status = fields.get("status")
        if status is not None and current.get("status") != status:
            history = current.get("status_history")
            history = list(history) if isinstance(history, list) else []
            history.append({"from": current.get("status"), "to": status,
                            "error_code": fields.get("error_code"),
                            "failure_stage": fields.get("failure_stage"),
                            "at": time.time()})
            fields["status_history"] = history
            fields["last_confirmed_status"] = status
        current.update(fields)
        current["ref"] = ref
        if status is not None:
            current["last_confirmed_status"] = status
        current["updated_at"] = time.time()
        atomic_write_json(path, current)
        return current
