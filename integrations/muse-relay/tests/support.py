"""Shared helpers for the Muse relay tests."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "omb_relay.py"
WATCH = ROOT / "omb-watch.sh"
FIXTURES = ROOT / "fixtures"

sys.path.insert(0, str(FIXTURES))
sys.path.insert(0, str(ROOT))

from fake_omb import FakeOMB  # noqa: E402
import omb_relay  # noqa: E402

RUNTIME_STUB = """log() { printf 'LOG %s\\n' "$*" >> "$TRACE_CALLS"; }
silent() { printf 'SILENT %s\\n' "$*" >> "$TRACE_CALLS"; }
wake() {
  if ls "$OMB_RELAY_STATE_DIR"/pending/*.json >/dev/null 2>&1; then
    printf 'WAKE_AFTER_PERSIST %s %s\\n' "$1" "$2" >> "$TRACE_CALLS"
  else
    printf 'WAKE %s %s\\n' "$1" "$2" >> "$TRACE_CALLS"
  fi
}
"""


class Sandbox:
    def __init__(self, token: str = "test-token-0123456789abcdef"):
        self.dir = Path(tempfile.mkdtemp(prefix="muse-relay-"))
        self.state = self.dir / "state"
        self.work = self.dir / "work"
        self.state.mkdir()
        self.work.mkdir()
        self.token = token
        self.config = self.dir / "config.json"
        self.runtime = self.dir / "runtime.sh"
        self.trace = self.dir / "calls.log"
        self.runtime.write_text(RUNTIME_STUB)
        self.trace.write_text("")

    def cleanup(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def write_config(
        self,
        base_url: str,
        token: str | None = None,
        connection_id: str = "conn-test",
        state_dir: Path | None = None,
        mode: int = 0o600,
        extra: dict | None = None,
    ) -> Path:
        payload = {
            "schemaVersion": 1,
            "baseUrl": base_url,
            "connectionId": connection_id,
            "token": token or self.token,
            "stateDir": str(state_dir or self.state),
        }
        if extra:
            payload.update(extra)
        self.config.write_text(json.dumps(payload))
        os.chmod(self.config, mode)
        return self.config

    def env(self, **extra) -> dict:
        env = dict(os.environ)
        env["OMB_RELAY_CONFIG"] = str(self.config)
        env["OMB_RELAY_PYTHON"] = sys.executable
        env["OMB_RELAY_STATE_DIR"] = str(self.state)
        env["HATCH_HOOK_RUNTIME"] = str(self.runtime)
        env["TRACE_CALLS"] = str(self.trace)
        for key, value in extra.items():
            env[key] = str(value)
        return env

    def run(self, *args, input_text: str | None = None, timeout: float = 60, env: dict | None = None):
        return subprocess.run(
            [sys.executable, str(CLI), *args],
            env=env or self.env(),
            input=input_text,
            capture_output=True,
            text=True,
            timeout=timeout,
        )

    def run_watch(self, timeout: float = 60):
        return subprocess.run(
            ["bash", str(WATCH)],
            env=self.env(),
            capture_output=True,
            text=True,
            timeout=timeout,
        )

    def read_trace(self) -> str:
        return self.trace.read_text()

    def pending_files(self) -> list[Path]:
        return sorted(p for p in (self.state / "pending").glob("*.json") if not p.name.startswith("."))

    def processing_files(self) -> list[Path]:
        return sorted(p for p in (self.state / "processing").glob("*.json") if not p.name.startswith("."))

    def write_pending(
        self,
        turn_id: str,
        delivery_id: str = "del-manual",
        text: str = "hello",
        attempt: int = 1,
    ) -> Path:
        now = omb_relay.now_iso()
        record = {
            "schemaVersion": 1,
            "turnId": turn_id,
            "deliveryId": delivery_id,
            "attempt": attempt,
            "leaseUntil": now,
            "createdAt": now,
            "receivedAt": now,
            "input": {"threadId": "thread-1", "text": text, "system": "", "transcript": []},
        }
        path = self.state / "pending" / f"{omb_relay.turn_key(turn_id)}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record))
        return path

    def read_json(self, path: Path) -> dict:
        return json.loads(path.read_text())

    def ledger(self, turn_id: str) -> dict:
        return self.read_json(self.state / "ledger" / f"{omb_relay.turn_key(turn_id)}.json")

    def write_ledger(self, turn_id: str, ledger: dict) -> None:
        path = self.state / "ledger" / f"{omb_relay.turn_key(turn_id)}.json"
        path.write_text(json.dumps(ledger))

    def assert_no_token(self, testcase, *extra_texts: str) -> None:
        needle = self.token.encode()
        for text in extra_texts:
            testcase.assertNotIn(self.token, text)
        for path in self.dir.rglob("*"):
            if not path.is_file() or path == self.config:
                continue
            testcase.assertNotIn(needle, path.read_bytes(), f"token leaked into {path}")


def poll_and_claim(box: Sandbox, fake: FakeOMB, text: str = "hello") -> tuple[str, dict]:
    turn_id = fake.add_turn(text=text)
    polled = box.run("poll", "--wait-ms", "0")
    if "status=deliveries" not in polled.stdout:
        raise AssertionError(f"poll failed: {polled.stdout!r} {polled.stderr!r}")
    claimed = box.run("claim")
    if claimed.returncode != 0:
        raise AssertionError(f"claim failed: {claimed.stdout!r} {claimed.stderr!r}")
    return turn_id, json.loads(claimed.stdout)


def write_text_file(box: Sandbox, name: str, text: str) -> Path:
    path = box.work / name
    path.write_text(text, encoding="utf-8")
    return path


def wait_until(predicate, timeout: float = 5.0, interval: float = 0.02) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def age_processing(box: Sandbox, seconds: float = 3600) -> None:
    path = box.processing_files()[0]
    record = box.read_json(path)
    record["claimedAtEpoch"] = time.time() - seconds
    record["heartbeatEpoch"] = 0
    path.write_text(json.dumps(record))
    old = time.time() - seconds
    os.utime(path, (old, old))
