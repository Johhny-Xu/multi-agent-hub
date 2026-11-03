"""Persist and renew MiniMax Code (mcode) OAuth credentials.

This module intentionally implements only the credential lifecycle: refresh the
one-hour access token with the rotated refresh token, write it back atomically to
mcode's own auth store, and repeat on a timer. It does not proxy upstream API
requests.

Reference behavior (not code) was cross-checked against Zhengyuuuui/minimax2api:
the refresh grant is form-encoded with client_id + grant_type + refresh_token;
the response rotates the refresh token, so both tokens and the expiry must be
persisted. See docs/minimax-persistent-login.md.
"""
from __future__ import annotations

import argparse
import json
import os
from contextlib import contextmanager
from pathlib import Path
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

CLIENT_ID = "mcode-public"
ACCOUNT_ORIGINS = {
    "cn": "https://account.minimax.cn",
    "en": "https://account.minimax.io",
    "global": "https://account.minimax.io",
}
DEFAULT_MARGIN_SEC = 1200
DEFAULT_INTERVAL_SEC = 600
DEFAULT_TOKEN_TTL_SEC = 3600
_VALIDATION_GRACE_SEC = 60

_keepalive_thread: threading.Thread | None = None
_keepalive_stop: threading.Event | None = None
_last_log: dict[str, str] = {}


def auth_root() -> Path:
    value = os.environ.get("MCODE_AUTH_DIR") or "~/.minimax/auth"
    return Path(os.path.expandvars(os.path.expanduser(value)))


def _read_json(path: Path):
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def _atomic_json(path: Path, value) -> None:
    payload = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.tmp-{os.getpid()}-{time.time_ns()}")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(payload)
    try:
        os.replace(temp, path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except Exception:
        try:
            temp.unlink()
        except OSError:
            pass
        raise


@contextmanager
def _exclusive(path: Path):
    """Serialize renewals across processes when the platform supports it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+", encoding="utf-8")
    try:
        try:
            import fcntl  # POSIX only
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        except (ImportError, OSError):
            pass
        yield
    finally:
        try:
            import fcntl  # POSIX only
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except (ImportError, OSError):
            pass
        handle.close()


def _record_entry(store):
    records = (store or {}).get("records")
    if not isinstance(records, dict):
        return "", None
    candidates = []
    for key, value in records.items():
        if isinstance(value, dict) and str(value.get("accessToken") or "").strip():
            candidates.append((float(value.get("expiresAtMs") or 0), key, value))
    if not candidates:
        return "", None
    _, key, value = max(candidates, key=lambda item: item[0])
    return key, value


def _region_for(auth_file: Path, state) -> str:
    region = str((state or {}).get("region") or "").strip().lower()
    if region in ACCOUNT_ORIGINS:
        return region
    folder = auth_file.parents[1].name.lower()
    if folder == "cn":
        return "cn"
    if folder in {"en", "global", "intl"}:
        return "global"
    return "cn"


def _origin(region: str) -> str:
    return ACCOUNT_ORIGINS.get(region, ACCOUNT_ORIGINS["cn"])


def refresh_with_token(refresh_token: str, region: str, client_id: str = CLIENT_ID, opener=None):
    """Exchange a refresh token for a new access/refresh token pair."""
    if not refresh_token:
        return {"ok": False, "error": "no refresh token"}
    body = urllib.parse.urlencode({
        "client_id": client_id or CLIENT_ID,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }).encode("utf-8")
    request = urllib.request.Request(
        _origin(region) + "/oauth2/token",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "User-Agent": "MiniMaxAgent/3.1.0",
        },
    )
    try:
        with (opener or urllib.request.urlopen)(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            raw = error.read().decode("utf-8", "replace")
            parsed = json.loads(raw)
            code = str(parsed.get("error") or "").strip()
            description = str(parsed.get("error_description") or "").strip()
            detail = f"{code}: {description}" if code and description else (code or description or raw)
        except Exception:
            detail = str(error)
        return {"ok": False, "error": detail[:240], "status": error.code}
    except Exception as error:
        return {"ok": False, "error": f"{type(error).__name__}: {error}"[:240]}
    token = str((payload or {}).get("access_token") or "").strip()
    if not token:
        return {"ok": False, "error": "refresh response contained no access_token"}
    try:
        ttl = float(payload.get("expires_in") or DEFAULT_TOKEN_TTL_SEC)
    except (TypeError, ValueError):
        ttl = DEFAULT_TOKEN_TTL_SEC
    return {
        "ok": True,
        "access_token": token,
        "refresh_token": str(payload.get("refresh_token") or ""),
        "expires_at_ms": int(time.time() * 1000 + ttl * 1000),
    }


def ensure_auth_file(auth_file, *, now_ms=None, margin_sec=DEFAULT_MARGIN_SEC, opener=None):
    """Refresh one mcode auth.json if it is inside the expiry margin.

    The return value is safe to log: it never contains token material.
    """
    auth_file = Path(auth_file)
    state_file = auth_file.with_name("auth-state.json")
    now_ms = int(now_ms if now_ms is not None else time.time() * 1000)
    store = _read_json(auth_file)
    state = _read_json(state_file) or {}
    if not isinstance(store, dict):
        return {"status": "no_auth", "auth_file": str(auth_file)}
    if str(state.get("status") or "").strip().lower() != "authenticated":
        return {"status": "not_authenticated", "auth_file": str(auth_file)}
    key, record = _record_entry(store)
    if not record:
        return {"status": "no_record", "auth_file": str(auth_file)}
    expires_at = int(float(record.get("expiresAtMs") or 0))
    if expires_at > now_ms + int(margin_sec * 1000):
        return {"status": "valid", "expires_at_ms": expires_at, "auth_file": str(auth_file)}
    refresh_token = str(record.get("refreshToken") or "").strip()
    if not refresh_token:
        return {"status": "no_refresh_token", "expires_at_ms": expires_at, "auth_file": str(auth_file)}

    region = _region_for(auth_file, state)
    lock_path = auth_file.with_name(".agenthub-keepalive.lock")
    with _exclusive(lock_path):
        # Re-read inside the lock; another process may have renewed or the user
        # may have completed a new login while we waited.
        store = _read_json(auth_file)
        state = _read_json(state_file) or state
        if not isinstance(store, dict):
            return {"status": "no_auth", "auth_file": str(auth_file)}
        current_key, current = _record_entry(store)
        if not current:
            return {"status": "no_record", "auth_file": str(auth_file)}
        current_expiry = int(float(current.get("expiresAtMs") or 0))
        if current_expiry > now_ms + int(margin_sec * 1000):
            return {"status": "valid", "expires_at_ms": current_expiry, "auth_file": str(auth_file)}
        current_refresh = str(current.get("refreshToken") or "").strip()
        if current_key != key or str(current.get("accessToken") or "") != str(record.get("accessToken") or ""):
            # A fresh login replaced the record; do not overwrite it with our
            # older refresh result.
            return {"status": "skipped_newer_login", "auth_file": str(auth_file)}
        if not current_refresh:
            return {"status": "no_refresh_token", "auth_file": str(auth_file)}

        result = refresh_with_token(
            current_refresh,
            region,
            str(current.get("clientId") or CLIENT_ID),
            opener=opener,
        )
        if not result.get("ok"):
            return {"status": "refresh_failed", "error": result.get("error", ""), "auth_file": str(auth_file)}

        latest_store = _read_json(auth_file)
        records = (latest_store or {}).get("records") if isinstance(latest_store, dict) else None
        target = records.get(current_key) if isinstance(records, dict) else None
        if not isinstance(target, dict) or str(target.get("accessToken") or "") != str(current.get("accessToken") or ""):
            return {"status": "skipped_newer_login", "auth_file": str(auth_file)}

        new_expiry = int(result["expires_at_ms"])
        target["accessToken"] = result["access_token"]
        if result.get("refresh_token"):
            target["refreshToken"] = result["refresh_token"]
        target["expiresAtMs"] = new_expiry
        target["generation"] = int(target.get("generation") or 0) + 1
        _atomic_json(auth_file, latest_store)

        latest_state = _read_json(state_file)
        if isinstance(latest_state, dict):
            latest_state["status"] = "authenticated"
            latest_state["expiresAtMs"] = new_expiry
            latest_state["generation"] = int(latest_state.get("generation") or 0) + 1
            _atomic_json(state_file, latest_state)

        return {
            "status": "refreshed",
            "region": region,
            "expires_at_ms": new_expiry,
            "refresh_rotated": bool(result.get("refresh_token")),
            "auth_file": str(auth_file),
        }


def ensure_all(*, root=None, now_ms=None, margin_sec=DEFAULT_MARGIN_SEC, opener=None):
    root = Path(root) if root is not None else auth_root()
    results = []
    try:
        files = sorted(root.glob("*/*/mcode-public/auth.json"))
    except OSError:
        return results
    for auth_file in files:
        try:
            results.append(ensure_auth_file(
                auth_file, now_ms=now_ms, margin_sec=margin_sec, opener=opener
            ))
        except Exception as error:
            results.append({"status": "error", "error": f"{type(error).__name__}: {error}"[:240], "auth_file": str(auth_file)})
    return results


def auth_status(*, root=None, now_ms=None):
    """Read-only login status; does not refresh or return tokens."""
    root = Path(root) if root is not None else auth_root()
    now_ms = int(now_ms if now_ms is not None else time.time() * 1000)
    try:
        files = sorted(root.glob("*/*/mcode-public/auth.json"))
    except OSError:
        return {"authenticated": False, "reason": "auth_root_unreadable"}
    reasons = []
    for auth_file in files:
        state = _read_json(auth_file.with_name("auth-state.json")) or {}
        if str(state.get("status") or "").strip().lower() != "authenticated":
            reasons.append("not_authenticated")
            continue
        _, record = _record_entry(_read_json(auth_file))
        if not record:
            reasons.append("no_record")
            continue
        expires_at = int(float(record.get("expiresAtMs") or 0))
        if expires_at <= now_ms + _VALIDATION_GRACE_SEC * 1000:
            reasons.append("expired")
            continue
        return {
            "authenticated": True,
            "expires_at_ms": expires_at,
            "region": str(state.get("region") or ""),
            "auth_file": str(auth_file),
        }
    return {"authenticated": False, "reason": reasons[0] if reasons else "no_auth"}


def has_valid_login(*, root=None, now_ms=None) -> bool:
    return bool(auth_status(root=root, now_ms=now_ms).get("authenticated"))


def _log_result(result):
    status = str(result.get("status") or "")
    key = str(result.get("auth_file") or "")
    signature = f"{status}:{result.get('error', '')}"
    if _last_log.get(key) == signature:
        return
    _last_log[key] = signature
    if status in {"valid", "skipped_newer_login"}:
        return
    detail = f" error={result.get('error')}" if result.get("error") else ""
    expires = result.get("expires_at_ms")
    when = ""
    if expires:
        try:
            when = " expires_at=" + time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(int(expires) / 1000))
        except (ValueError, OSError):
            pass
    sys.stderr.write(f"[minimax-keepalive] {status}{when}{detail}\n")
    sys.stderr.flush()


def start_keepalive(*, interval_sec=None, margin_sec=None, root=None) -> threading.Thread | None:
    """Start the idempotent background renewal thread."""
    global _keepalive_thread, _keepalive_stop
    if str(os.environ.get("AGENTHUB_MINIMAX_KEEPALIVE") or "1").lower() in {"0", "false", "off", "no"}:
        return None
    if _keepalive_thread is not None and _keepalive_thread.is_alive():
        return _keepalive_thread
    interval = int(interval_sec or os.environ.get("AGENTHUB_MINIMAX_KEEPALIVE_INTERVAL") or DEFAULT_INTERVAL_SEC)
    margin = int(margin_sec or os.environ.get("AGENTHUB_MINIMAX_REFRESH_MARGIN") or DEFAULT_MARGIN_SEC)
    interval = max(60, interval)
    margin = max(60, margin)
    stop = threading.Event()
    _keepalive_stop = stop

    def loop():
        sys.stderr.write(f"[minimax-keepalive] started interval={interval}s margin={margin}s\n")
        sys.stderr.flush()
        while not stop.is_set():
            try:
                for item in ensure_all(root=root, margin_sec=margin):
                    _log_result(item)
            except Exception as error:  # noqa: BLE001 - the loop must survive one bad sweep
                sys.stderr.write(f"[minimax-keepalive] sweep error: {type(error).__name__}: {error}\n")
                sys.stderr.flush()
            stop.wait(interval)

    thread = threading.Thread(target=loop, name="minimax-keepalive", daemon=True)
    _keepalive_thread = thread
    thread.start()
    return thread


def stop_keepalive(timeout=0.2) -> None:
    global _keepalive_thread, _keepalive_stop
    if _keepalive_stop is not None:
        _keepalive_stop.set()
    if _keepalive_thread is not None:
        _keepalive_thread.join(timeout=timeout)
    _keepalive_thread = None
    _keepalive_stop = None


def main(argv=None):
    parser = argparse.ArgumentParser(description="Renew MiniMax Code (mcode) OAuth tokens without proxying traffic.")
    parser.add_argument("--root", help="auth root, default ~/.minimax/auth")
    parser.add_argument("--margin", type=int, default=DEFAULT_MARGIN_SEC)
    parser.add_argument("--interval", type=int, default=DEFAULT_INTERVAL_SEC)
    parser.add_argument("--loop", action="store_true", help="run continuously instead of one sweep")
    parser.add_argument("--once", action="store_true", help="run one sweep (the default)")
    parser.add_argument("--json", action="store_true", help="print safe status as JSON")
    args = parser.parse_args(argv)
    if args.loop and args.once:
        parser.error("--loop and --once are mutually exclusive")
    if args.loop:
        start_keepalive(interval_sec=args.interval, margin_sec=args.margin, root=args.root)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            stop_keepalive()
        return 0
    results = ensure_all(root=args.root, margin_sec=args.margin)
    statuses = [{key: value for key, value in item.items() if key != "auth_file"} for item in results]
    if args.json:
        print(json.dumps(statuses, ensure_ascii=False))
    else:
        print(json.dumps(statuses, ensure_ascii=False, indent=2))
    return 0 if all(item.get("status") in {"valid", "refreshed", "skipped_newer_login"} for item in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
