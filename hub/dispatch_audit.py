"""Append-only, redacted dispatch audit events for the Hub.

The audit log answers "what was attempted, accepted, and observed" without
storing task bodies, attachment contents, base64, credentials, absolute local
paths or full worker answers. Events are whitelisted field by field.
"""
import hashlib
import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from state_store import StateFileLock

ATTACHMENT_FIELDS = ("count", "total_bytes", "content_types", "names", "validation_result")
REDACTED_PATH = re.compile(r"^(?:[A-Za-z]:[\\/]|/)")


class AuditWriteError(RuntimeError):
    """The audit log could not be persisted; callers must apply the fail policy."""


def logical_task_summary(worker, task, attachments=()):
    """Correlation summary for one process only; never a global dedupe key."""
    digest = hashlib.sha256()
    digest.update(str(worker or "").encode("utf-8", "replace"))
    digest.update(bytes([0]))
    digest.update(str(task or "").encode("utf-8", "replace"))
    for item in attachments or ():
        digest.update(bytes([0]))
        digest.update(str(item.get("name") or "").encode("utf-8", "replace"))
        digest.update(str(item.get("bytes") or 0).encode("ascii"))
    return "sha256:" + digest.hexdigest()[:32]


def public_attachment_summary(attachments=()):
    values = list(attachments or ())
    return {
        "count": len(values),
        "total_bytes": sum(int(item.get("bytes") or 0) for item in values),
        "content_types": sorted({str(item.get("mime") or item.get("kind") or "")
                                 for item in values if item.get("mime") or item.get("kind")}),
        "validation_result": "passed" if values else "not_applicable",
    }


def _text(value, limit=200):
    if value is None:
        return None
    text = str(value).strip().replace("\x00", "")
    if REDACTED_PATH.match(text):
        text = "<path>"
    return text[:limit]


def _attachment_summary(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("attachment_summary must be an object")
    unknown = set(value) - set(ATTACHMENT_FIELDS)
    if unknown:
        raise ValueError("attachment_summary has unsupported fields")
    result = {}
    for key in ("count", "total_bytes"):
        item = value.get(key)
        if item is not None:
            if not isinstance(item, int) or isinstance(item, bool) or item < 0:
                raise ValueError("invalid attachment summary count")
            result[key] = item
    for key in ("validation_result",):
        item = _text(value.get(key))
        if item:
            result[key] = item
    types = value.get("content_types")
    if types is not None:
        if not isinstance(types, list) or any(not isinstance(item, str) for item in types):
            raise ValueError("invalid attachment content types")
        result["content_types"] = sorted({_text(item, 80) for item in types if _text(item, 80)})
    names = value.get("names")
    if names is not None:
        if not isinstance(names, list) or any(not isinstance(item, str) for item in names):
            raise ValueError("invalid attachment names")
        result["names"] = [_text(Path(item).name, 100) for item in names][:8]
    return result


@dataclass(frozen=True)
class DispatchAuditEvent:
    event: str
    stage: str
    status: str
    dispatch_count: int
    logical_task_summary: str
    worker: str
    ref: Optional[str] = None
    failure_code: Optional[str] = None
    attachment_summary: Optional[dict] = None
    host_id: Optional[str] = None
    occurred_at: float = field(default_factory=time.time)

    @classmethod
    def rejected(cls, *, worker, logical_task_summary, stage="validation", status="failed",
                 failure_code=None, attachment_summary=None, host_id=None):
        return cls("rejected", stage, status, 0, logical_task_summary, worker,
                   failure_code=failure_code, attachment_summary=attachment_summary, host_id=host_id)

    @classmethod
    def intended(cls, *, worker, logical_task_summary, stage="dispatch_acceptance",
                 attachment_summary=None, host_id=None):
        return cls("dispatch_intent", stage, "pending", 1, logical_task_summary, worker,
                   attachment_summary=attachment_summary, host_id=host_id)

    @classmethod
    def accepted(cls, *, worker, logical_task_summary, ref, status="running", stage="dispatch_acceptance",
                 failure_code=None, attachment_summary=None, host_id=None):
        return cls("dispatch_accepted", stage, status, 1, logical_task_summary, worker, ref=ref,
                   failure_code=failure_code, attachment_summary=attachment_summary, host_id=host_id)

    @classmethod
    def status_changed(cls, *, worker, logical_task_summary, ref, status, stage="result_collection",
                       failure_code=None, dispatch_count=1, attachment_summary=None, host_id=None):
        return cls("status_change", stage, status, dispatch_count, logical_task_summary, worker,
                   ref=ref, failure_code=failure_code, attachment_summary=attachment_summary, host_id=host_id)

    @classmethod
    def verification(cls, *, worker, logical_task_summary, ref, verdict, stage="verification",
                     error_code=None, attachment_summary=None, host_id=None):
        return cls("verification", stage, verdict, 1, logical_task_summary, worker, ref=ref,
                   failure_code=error_code, attachment_summary=attachment_summary, host_id=host_id)

    def record(self):
        if not isinstance(self.dispatch_count, int) or isinstance(self.dispatch_count, bool) or self.dispatch_count not in (0, 1):
            raise ValueError("dispatch_count must be 0 or 1")
        record = {
            "event": _text(self.event, 40),
            "stage": _text(self.stage, 40),
            "status": _text(self.status, 40),
            "dispatch_count": self.dispatch_count,
            "logical_task_summary": _text(self.logical_task_summary, 80),
            "worker": _text(self.worker, 60),
            "ref_status": "present" if self.ref else "absent",
            "occurred_at": round(float(self.occurred_at), 3),
        }
        if self.ref:
            record["ref"] = _text(self.ref, 120)
        if self.failure_code:
            record["failure_code"] = _text(self.failure_code, 80)
        if self.attachment_summary is not None:
            record["attachment_summary"] = _attachment_summary(self.attachment_summary)
        if self.host_id:
            record["host_id"] = _text(self.host_id, 40)
        return record


class DispatchAuditStore:
    """Append-only JSONL store under the user-level Hub state directory."""

    def __init__(self, directory):
        self.directory = Path(directory)
        self.path = self.directory / "dispatch-events.jsonl"

    def host_id(self):
        return "hub:" + hashlib.sha256(str(self.directory.parent).encode("utf-8")).hexdigest()[:10]

    def append(self, event):
        if not isinstance(event, DispatchAuditEvent):
            raise ValueError("event must be a DispatchAuditEvent")
        record = event.record()
        if not record.get("host_id"):
            record["host_id"] = self.host_id()
        try:
            created = not self.directory.exists()
            self.directory.mkdir(parents=True, exist_ok=True)
            if created:
                try:
                    os.chmod(self.directory, 0o700)
                except OSError:
                    pass
            with StateFileLock(self.path.with_suffix(".jsonl.lock")):
                descriptor = os.open(str(self.path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                with os.fdopen(descriptor, "a", encoding="utf-8") as stream:
                    stream.write(json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")
                    stream.flush()
                    os.fsync(stream.fileno())
        except (OSError, ValueError, TimeoutError) as exc:
            raise AuditWriteError("dispatch audit is unavailable: " + type(exc).__name__) from exc
        return {"ok": True, "event": record}

    def events(self, *, ref=None, logical_task_summary=None, limit=100):
        if ref is not None and (not isinstance(ref, str) or not ref):
            raise ValueError("ref must be a non-empty string")
        if logical_task_summary is not None and not isinstance(logical_task_summary, str):
            raise ValueError("logical_task_summary must be a string")
        if not isinstance(limit, int) or isinstance(limit, bool) or limit <= 0:
            raise ValueError("limit must be a positive integer")
        try:
            raw = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return []
        except OSError as exc:
            raise AuditWriteError("dispatch audit is unavailable: " + type(exc).__name__) from exc
        events = []
        for line in raw.splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            if ref is not None and event.get("ref") != ref:
                continue
            if logical_task_summary is not None and event.get("logical_task_summary") != logical_task_summary:
                continue
            events.append(event)
        return events[-limit:]
