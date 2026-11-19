#!/usr/bin/env python3
"""OpenMausBot Muse Relay client.

Data plane contract: schemaVersion 1 over /hooks/muse-relay/v1/<connectionId>
(poll, heartbeat, text events, raw-byte file upload). The connection token is
read from a 0600 config file outside this source tree and must never reach
argv, stdout, stderr, the wake payload or any state file.
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import http.client
import ipaddress
import json
import mimetypes
import os
import re
import signal
import ssl
import stat
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit
import urllib.request
import base64

SCHEMA_VERSION = 1

MAX_JSON_BODY = 1 << 20
MAX_TEXT = 256 << 10
MAX_POLL_RESPONSE = 16 << 20
MAX_API_RESPONSE = 64 << 10
MAX_TRANSCRIPT_BYTES = 4 << 20
MAX_TRANSCRIPT_ITEMS = 1000
IMAGE_LIMIT = 10 << 20
FILE_LIMIT = 100 << 20
MAX_CONFIG_BYTES = 64 << 10
MAX_STATE_BYTES = 1 << 20
# Some paths to the Muse sandbox cut HTTP response bodies near 8 KB, so the poll asks for deliveries by
# reference and fetches each input in raw slices of at most INPUT_SLICE_BYTES (base64 keeps a response < 6 KB).
INPUT_SLICE_BYTES = 4096
INPUT_SLICE_ATTEMPTS = 5
MAX_INPUT_BYTES = 16 << 20
# Long replies go out as several text events of at most this many UTF-8 bytes each, so no request body is large.
TEXT_PART_BYTES = 4096
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")

DEFAULT_CONFIG = Path.home() / ".config" / "omb-muse-relay" / "config.json"
DEFAULT_STATE = Path.home() / ".local" / "state" / "omb-muse-relay"

EXIT_OK = 0
EXIT_CONFIG = 1
EXIT_USAGE = 2
EXIT_NO_PENDING = 3
EXIT_STALE = 4
EXIT_PERMANENT = 5
EXIT_CONFLICT = 6
EXIT_RETRY = 7
EXIT_CANCELLED = 8
EXIT_TERMINATED = 143

SCRIPT_DIR = Path(__file__).resolve().parent

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
MIME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+-]*/[A-Za-z0-9][A-Za-z0-9.+-]*$")
SAFE_VALUE_RE = re.compile(r"^[A-Za-z0-9_.:+-]*$")

TERMINAL_KINDS = ("completed", "failed")


class RelayError(Exception):
    kind = "internal"


class ConfigError(RelayError):
    kind = "config"


class UsageError(RelayError):
    kind = "usage"


class StateError(RelayError):
    kind = "state"


class ContractError(RelayError):
    kind = "invalid_response"


class AuthError(RelayError):
    def __init__(self, status: int):
        self.status = status
        self.kind = f"http_{status}"
        super().__init__(self.kind)


class StaleDelivery(RelayError):
    kind = "stale"


class StateConflict(RelayError):
    kind = "conflict"


class PermanentError(RelayError):
    def __init__(self, kind: str):
        self.kind = kind
        super().__init__(kind)


class RetriableError(RelayError):
    def __init__(self, kind: str, retry_ms: int = 0):
        self.kind = kind
        self.retry_ms = retry_ms
        super().__init__(kind)


class Cancelled(RelayError):
    kind = "cancelled"


class Terminated(RelayError):
    kind = "terminated"


def _sigterm(_signum, _frame):
    raise Terminated()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def require_id(value, what: str, exc=ContractError) -> str:
    if not isinstance(value, str) or not ID_RE.match(value):
        raise exc(f"invalid {what}")
    return value


def require_name(value) -> str:
    if not isinstance(value, str) or not (1 <= len(value) <= 200):
        raise UsageError("invalid file name")
    if value in (".", "..") or value != value.strip():
        raise UsageError("invalid file name")
    for ch in value:
        if ord(ch) < 0x20 or ord(ch) == 0x7F or ch in ("/", "\\"):
            raise UsageError("invalid file name")
    return value


def require_mime(value) -> str:
    if not isinstance(value, str) or len(value) > 120 or not MIME_RE.match(value):
        raise UsageError("invalid MIME type")
    return value


def turn_key(turn_id: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", turn_id)[:64]
    digest = hashlib.sha256(turn_id.encode("utf-8")).hexdigest()[:10]
    return f"{cleaned}-{digest}"


def fsync_dir(path: Path) -> None:
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _read_regular_file(path: Path, max_bytes: int, what: str) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise ConfigError(f"{what} must not be a symlink") from None
        raise
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise ConfigError(f"{what} must be a regular file")
        if st.st_size > max_bytes:
            raise ConfigError(f"{what} is too large")
        with os.fdopen(fd, "rb") as handle:
            fd = -1
            data = handle.read(max_bytes + 1)
    finally:
        if fd >= 0:
            os.close(fd)
    if len(data) > max_bytes:
        raise ConfigError(f"{what} is too large")
    return data


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def validate_state_dir(raw) -> Path:
    if not isinstance(raw, str) or not raw:
        raise ConfigError("stateDir must be a non-empty string")
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ConfigError("stateDir must be an absolute path")
    resolved = path.resolve(strict=False)
    if resolved == Path("/"):
        raise ConfigError("stateDir must not be the filesystem root")
    if resolved == SCRIPT_DIR or SCRIPT_DIR in resolved.parents:
        raise ConfigError("stateDir must live outside the source tree")
    return resolved


@dataclass(frozen=True)
class Config:
    scheme: str
    host: str
    port: int
    connection_id: str
    token: str
    base_path: str
    state_dir: Path
    config_path: Path


def load_config() -> Config:
    raw_path = os.environ.get("OMB_RELAY_CONFIG") or str(DEFAULT_CONFIG)
    path = Path(raw_path).expanduser()
    try:
        resolved = path.resolve(strict=True)
    except OSError:
        raise ConfigError("config file is missing") from None
    if resolved == SCRIPT_DIR or SCRIPT_DIR in resolved.parents:
        raise ConfigError("config must live outside the source tree")
    try:
        raw = _read_regular_file(path, MAX_CONFIG_BYTES, "config")
    except FileNotFoundError:
        raise ConfigError("config file is missing") from None
    except PermissionError:
        raise ConfigError("config file is not readable") from None
    st = os.stat(path)
    if st.st_uid != os.geteuid():
        raise ConfigError("config file must be owned by the current user")
    if stat.S_IMODE(st.st_mode) & 0o077:
        raise ConfigError("config file permissions must be 0600")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ConfigError("config is not valid JSON") from None
    if not isinstance(data, dict):
        raise ConfigError("config must be a JSON object")
    if data.get("schemaVersion") != SCHEMA_VERSION:
        raise ConfigError("config schemaVersion must be 1")

    base_url = data.get("baseUrl")
    if not isinstance(base_url, str) or not base_url:
        raise ConfigError("config baseUrl is required")
    parts = urlsplit(base_url)
    if parts.scheme not in ("https", "http"):
        raise ConfigError("config baseUrl must be https (http only for loopback)")
    if parts.username or parts.password:
        raise ConfigError("config baseUrl must not contain credentials")
    if parts.query or parts.fragment or parts.path not in ("", "/"):
        raise ConfigError("config baseUrl must be an origin without a path")
    host = parts.hostname
    if not host:
        raise ConfigError("config baseUrl has no host")
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        raise ConfigError("config baseUrl has an invalid port") from None
    if parts.scheme == "http" and not _is_loopback(host):
        raise ConfigError("http is only allowed for loopback test addresses; use https")

    connection_id = data.get("connectionId")
    if not isinstance(connection_id, str) or not ID_RE.match(connection_id):
        raise ConfigError("config connectionId is invalid")

    token = data.get("token")
    if not isinstance(token, str) or not (16 <= len(token) <= 512):
        raise ConfigError("config token is invalid")
    if any(ord(ch) < 0x21 or ord(ch) > 0x7E for ch in token):
        raise ConfigError("config token is invalid")
    if token.lower().startswith("bearer "):
        raise ConfigError("config token must not include the Bearer prefix")

    base_path = f"/hooks/muse-relay/v1/{quote(connection_id, safe='')}"
    declared = data.get("basePath")
    if declared is not None and declared != base_path:
        raise ConfigError("config basePath does not match connectionId")

    declared_state = data.get("stateDir")
    if declared_state is not None:
        validate_state_dir(declared_state)
    state_raw = os.environ.get("OMB_RELAY_STATE_DIR") or declared_state
    state_dir = validate_state_dir(state_raw) if state_raw else validate_state_dir(str(DEFAULT_STATE))

    return Config(
        scheme=parts.scheme,
        host=host,
        port=port,
        connection_id=connection_id,
        token=token,
        base_path=base_path,
        state_dir=state_dir,
        config_path=resolved,
    )


def resolve_state_dir() -> Path:
    env = os.environ.get("OMB_RELAY_STATE_DIR")
    if env:
        return validate_state_dir(env)
    try:
        return load_config().state_dir
    except ConfigError:
        return validate_state_dir(str(DEFAULT_STATE))


class StateStore:
    SUBDIRS = ("pending", "processing", "ledger", "locks", "cancelled", "done", "stale", "corrupt", "tmp")

    def __init__(self, root: Path):
        self.root = Path(root)
        if self.root.is_symlink():
            raise StateError("state directory must not be a symlink")
        try:
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(self.root, 0o700)
            for sub in self.SUBDIRS:
                path = self.root / sub
                path.mkdir(mode=0o700, exist_ok=True)
                os.chmod(path, 0o700)
        except OSError as exc:
            raise StateError(f"state directory is not usable: {exc.strerror or 'error'}") from None

    def path(self, sub: str, turn_id: str, suffix: str = ".json") -> Path:
        return self.root / sub / f"{turn_key(turn_id)}{suffix}"

    def atomic_write(self, path: Path, data: bytes) -> None:
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-")
        try:
            os.fchmod(fd, 0o600)
            handle = os.fdopen(fd, "wb")
            fd = -1
            with handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, path)
            fsync_dir(path.parent)
        finally:
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
            try:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            except OSError:
                pass

    def write_json(self, path: Path, obj: dict) -> None:
        data = json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8") + b"\n"
        self.atomic_write(path, data)

    def read_json(self, path: Path, max_bytes: int = MAX_STATE_BYTES) -> dict:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(path, flags)
        except FileNotFoundError:
            raise StateError("state file disappeared") from None
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise StateError("state file must not be a symlink") from None
            raise
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                raise StateError("state file must be regular")
            if st.st_size > max_bytes:
                raise StateError("state file is too large")
            with os.fdopen(fd, "rb") as handle:
                fd = -1
                raw = handle.read(max_bytes + 1)
        finally:
            if fd >= 0:
                os.close(fd)
        if len(raw) > max_bytes:
            raise StateError("state file is too large")
        try:
            obj = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise StateError("state file is not valid JSON") from None
        if not isinstance(obj, dict):
            raise StateError("state file must be a JSON object")
        return obj

    def remove(self, path: Path) -> None:
        try:
            os.unlink(path)
            fsync_dir(path.parent)
        except FileNotFoundError:
            pass

    def quarantine(self, path: Path, sub: str = "corrupt") -> Path | None:
        dest = self.root / sub / f"{path.name}.{int(time.time())}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
        try:
            os.replace(path, dest)
        except FileNotFoundError:
            return None
        fsync_dir(path.parent)
        fsync_dir(dest.parent)
        return dest

    def _sort_key(self, path: Path) -> float:
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0

    def list_files(self, sub: str) -> list[Path]:
        directory = self.root / sub
        out = []
        try:
            entries = list(os.scandir(directory))
        except FileNotFoundError:
            return out
        for entry in entries:
            if entry.name.startswith(".") or not entry.name.endswith(".json"):
                continue
            try:
                if not entry.is_file(follow_symlinks=False):
                    continue
            except OSError:
                continue
            out.append(Path(entry.path))
        out.sort(key=self._sort_key)
        return out

    def list_artifacts(self, sub: str) -> list[Path]:
        directory = self.root / sub
        out = []
        try:
            entries = list(os.scandir(directory))
        except FileNotFoundError:
            return out
        for entry in entries:
            if entry.name.startswith("."):
                continue
            try:
                if not entry.is_file(follow_symlinks=False):
                    continue
            except OSError:
                continue
            out.append(Path(entry.path))
        out.sort(key=self._sort_key)
        return out

    def list_pending(self) -> list[Path]:
        return self.list_files("pending")

    def list_processing(self) -> list[Path]:
        return self.list_files("processing")

    @contextmanager
    def named_guard(self, name: str):
        path = self.root / "locks" / name
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
        acquired = False
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
            except BlockingIOError:
                acquired = False
            yield acquired
        finally:
            if acquired:
                try:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                except OSError:
                    pass
            os.close(fd)

    @contextmanager
    def turn_guard(self, turn_id: str, blocking: bool = True):
        path = self.root / "locks" / f"{turn_key(turn_id)}.lock"
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
        acquired = False
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
                acquired = True
            except BlockingIOError:
                acquired = False
            yield acquired
        finally:
            if acquired:
                try:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                except OSError:
                    pass
            os.close(fd)

    def new_ledger(self, turn_id: str) -> dict:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "turnId": turn_id,
            "deliveryId": None,
            "staleDeliveryId": None,
            "nextSeq": 1,
            "terminal": None,
            "terminalEventId": None,
            "events": {},
            "items": {},
            "inflight": None,
            "updatedAt": now_iso(),
        }

    def load_ledger(self, turn_id: str) -> dict:
        path = self.path("ledger", turn_id)
        if not path.exists():
            return self.new_ledger(turn_id)
        obj = self.read_json(path)
        if obj.get("schemaVersion") != SCHEMA_VERSION:
            raise StateError("ledger schemaVersion is invalid")
        if obj.get("turnId") != turn_id:
            raise StateError("ledger belongs to another turn")
        if not isinstance(obj.get("nextSeq"), int) or obj["nextSeq"] < 1:
            raise StateError("ledger nextSeq is invalid")
        if not isinstance(obj.get("events"), dict):
            raise StateError("ledger events are invalid")
        if obj.get("items") is not None and not isinstance(obj.get("items"), dict):
            raise StateError("ledger items are invalid")
        if obj.get("terminal") not in (None, "completed", "failed", "cancelled"):
            raise StateError("ledger terminal state is invalid")
        if obj.get("inflight") is not None and not isinstance(obj.get("inflight"), dict):
            raise StateError("ledger inflight state is invalid")
        obj.setdefault("staleDeliveryId", None)
        obj.setdefault("terminalEventId", None)
        obj.setdefault("items", {})
        return obj

    def save_ledger(self, turn_id: str, ledger: dict) -> None:
        ledger["updatedAt"] = now_iso()
        self.write_json(self.path("ledger", turn_id), ledger)

    def read_processing(self, turn_id: str) -> dict | None:
        path = self.path("processing", turn_id)
        if not path.exists():
            return None
        try:
            return self.read_json(path)
        except StateError:
            return None

    def detach_processing(self, turn_id: str, delivery_id: str, sub: str) -> bool:
        path = self.path("processing", turn_id)
        if not path.exists():
            return False
        try:
            rec = self.read_json(path)
        except StateError:
            self.quarantine(path, "corrupt")
            return False
        if rec.get("deliveryId") != delivery_id:
            return False
        dest = self.root / sub / f"{path.name}.{int(time.time())}-{uuid.uuid4().hex[:6]}"
        try:
            os.replace(path, dest)
        except FileNotFoundError:
            return False
        fsync_dir(path.parent)
        fsync_dir(dest.parent)
        return True

    def is_cancelled(self, turn_id: str) -> bool:
        return self.path("cancelled", turn_id).exists()

    def mark_cancelled(self, turn_id: str) -> None:
        marker = self.path("cancelled", turn_id)
        if not marker.exists():
            self.write_json(marker, {"schemaVersion": SCHEMA_VERSION, "turnId": turn_id, "at": now_iso()})
        self.remove(self.path("pending", turn_id))

    def save_delivery(self, delivery: dict) -> str:
        turn_id = delivery["turnId"]
        if self.is_cancelled(turn_id):
            return "cancelled"
        try:
            if self.load_ledger(turn_id).get("terminal"):
                return "terminal"
        except StateError:
            pass
        processing = self.path("processing", turn_id)
        if processing.exists():
            try:
                rec = self.read_json(processing)
                if rec.get("deliveryId") == delivery.get("deliveryId"):
                    return "already_claimed"
            except StateError:
                pass
        self.write_json(self.path("pending", turn_id), delivery)
        return "queued"


class _FileBody:
    def __init__(self, handle, size: int):
        self.handle = handle
        self.size = size
        self.sent = 0

    def read(self, amount: int = -1) -> bytes:
        remaining = self.size - self.sent
        if remaining <= 0:
            return b""
        if amount is None or amount < 0:
            amount = min(65536, remaining)
        else:
            amount = min(amount, remaining)
        chunk = self.handle.read(amount)
        if not chunk:
            raise OSError("file changed while uploading")
        self.sent += len(chunk)
        return chunk


def _https_proxy_for(host: str):
    """Honor https_proxy/HTTPS_PROXY and no_proxy (Muse's sandbox egresses via a proxy).

    Only plain http:// proxies (HTTP CONNECT) are supported. Returns
    (proxy_host, proxy_port, tunnel_headers) or None for a direct connection.
    """
    try:
        if urllib.request.proxy_bypass_environment(host):
            return None
    except Exception:
        pass
    raw = urllib.request.getproxies_environment().get("https")
    if not raw:
        return None
    if "://" not in raw:
        raw = "http://" + raw
    parts = urlsplit(raw)
    if parts.scheme != "http" or not parts.hostname:
        raise ConfigError("unsupported https_proxy scheme (only http:// CONNECT proxies)")
    headers = {}
    if parts.username is not None:
        cred = f"{unquote(parts.username)}:{unquote(parts.password or '')}"
        headers["Proxy-Authorization"] = "Basic " + base64.b64encode(cred.encode("utf-8")).decode("ascii")
    return parts.hostname, parts.port or 1080, headers


def _http_request(
    cfg: Config,
    method: str,
    subpath: str,
    *,
    body=None,
    headers: dict | None = None,
    timeout: float = 30.0,
    max_response: int = MAX_API_RESPONSE,
):
    if cfg.scheme == "https":
        proxy = _https_proxy_for(cfg.host)
        if proxy is not None:
            proxy_host, proxy_port, proxy_headers = proxy
            connection = http.client.HTTPSConnection(
                proxy_host, proxy_port, timeout=timeout, context=ssl.create_default_context()
            )
            connection.set_tunnel(cfg.host, cfg.port, headers=proxy_headers)
        else:
            connection = http.client.HTTPSConnection(
                cfg.host, cfg.port, timeout=timeout, context=ssl.create_default_context()
            )
    else:
        connection = http.client.HTTPConnection(cfg.host, cfg.port, timeout=timeout)
    request_headers = {
        "Authorization": f"Bearer {cfg.token}",
        "Accept": "application/json",
        "User-Agent": "omb-muse-relay/1",
        "Connection": "close",
    }
    if headers:
        request_headers.update(headers)
    path = cfg.base_path + subpath
    try:
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        status = response.status
        raw = response.read(max_response + 1)
        retry_after = response.getheader("Retry-After")
    except (http.client.HTTPException, OSError) as exc:
        raise RetriableError(_network_kind(exc)) from None
    finally:
        connection.close()

    if status in (401, 403):
        raise AuthError(status)
    if status == 409:
        raise StaleDelivery()
    if status in (408, 429):
        raise RetriableError(f"http_{status}", _retry_after_ms(retry_after))
    if 500 <= status <= 599:
        raise RetriableError(f"http_{status}", _retry_after_ms(retry_after))
    if 300 <= status <= 399:
        raise PermanentError("redirect")
    if status in (400, 404, 413):
        raise PermanentError(f"http_{status}")
    if not (200 <= status <= 299):
        raise PermanentError(f"http_{status}")
    if len(raw) > max_response:
        raise ContractError("response is too large")
    if not raw:
        raise ContractError("empty response")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ContractError("response is not valid JSON") from None
    if not isinstance(parsed, dict):
        raise ContractError("response is not a JSON object")
    return parsed


def _network_kind(exc: Exception) -> str:
    import socket

    if isinstance(exc, (socket.timeout, TimeoutError)):
        return "timeout"
    return "network"


def _retry_after_ms(value: str | None) -> int:
    if not value:
        return 0
    try:
        seconds = int(value.strip())
    except ValueError:
        return 0
    return max(0, min(300, seconds)) * 1000


def _post_json(cfg: Config, subpath: str, payload: dict, timeout: float = 30.0, max_response: int = MAX_API_RESPONSE) -> dict:
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(raw) > MAX_JSON_BODY:
        raise PermanentError("too_large")
    return _http_request(
        cfg,
        "POST",
        subpath,
        body=raw,
        headers={"Content-Type": "application/json"},
        timeout=timeout,
        max_response=max_response,
    )


def _sleep(seconds: float) -> None:
    time.sleep(seconds)


def _validate_delivery_ref(delivery: dict) -> dict:
    """A poll delivery sent with inputMode=ref: the envelope plus inputBytes/inputSha256, no input."""
    if not isinstance(delivery, dict):
        raise ContractError("delivery is not an object")
    turn_id = require_id(delivery.get("turnId"), "delivery turnId")
    delivery_id = require_id(delivery.get("deliveryId"), "deliveryId")
    attempt = delivery.get("attempt")
    if not isinstance(attempt, int) or isinstance(attempt, bool) or not (1 <= attempt <= 10000):
        raise ContractError("delivery attempt is invalid")
    for field in ("leaseUntil", "createdAt"):
        value = delivery.get(field)
        if not isinstance(value, str) or len(value) > 64:
            raise ContractError(f"delivery {field} is invalid")
    size = delivery.get("inputBytes")
    if not isinstance(size, int) or isinstance(size, bool) or not (2 <= size <= MAX_INPUT_BYTES):
        raise ContractError("delivery inputBytes is invalid")
    digest = delivery.get("inputSha256")
    if not isinstance(digest, str) or not SHA256_RE.match(digest):
        raise ContractError("delivery inputSha256 is invalid")
    return {
        "turnId": turn_id,
        "deliveryId": delivery_id,
        "attempt": attempt,
        "leaseUntil": delivery["leaseUntil"],
        "createdAt": delivery["createdAt"],
        "inputBytes": size,
        "inputSha256": digest,
    }


def _input_subpath(turn_id: str) -> str:
    return f"/turns/{quote(turn_id, safe='')}/input"


def _fetch_input_slice(cfg: Config, ref: dict, offset: int) -> bytes:
    """One slice, retried on network trouble or a damaged answer; a 409 (StaleDelivery) is not retried."""
    total = ref["inputBytes"]
    want = min(INPUT_SLICE_BYTES, total - offset)
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "deliveryId": ref["deliveryId"],
        "offset": offset,
        "length": want,
    }
    last = RetriableError("input_slice")
    for attempt in range(INPUT_SLICE_ATTEMPTS):
        try:
            response = _post_json(cfg, _input_subpath(ref["turnId"]), payload, timeout=20.0)
            if response.get("schemaVersion") != SCHEMA_VERSION:
                raise ContractError("input slice schemaVersion is invalid")
            if response.get("offset") != offset or response.get("total") != total:
                raise ContractError("input slice does not match the delivery")
            data = response.get("data")
            if not isinstance(data, str):
                raise ContractError("input slice data is invalid")
            try:
                chunk = base64.b64decode(data.encode("ascii"), validate=True)
            except (ValueError, UnicodeEncodeError):
                raise ContractError("input slice data is not base64") from None
            if len(chunk) != want:
                raise ContractError("input slice has the wrong length")
            return chunk
        except RetriableError as exc:
            last = exc
        except ContractError:
            last = RetriableError("input_slice_invalid")
        if attempt + 1 < INPUT_SLICE_ATTEMPTS:
            _sleep(min(2.0, 0.25 * (2 ** attempt)))
    raise RetriableError(last.kind, last.retry_ms)


def fetch_delivery_input(cfg: Config, ref: dict) -> dict:
    """Reassembles a ref delivery's input, checks its length and SHA-256, and returns the full checked delivery.

    Any failure raises before anything is written, so the poll persists nothing for this round and the server's
    lease expiry redelivers the turn.
    """
    total = ref["inputBytes"]
    buffer = bytearray()
    while len(buffer) < total:
        buffer += _fetch_input_slice(cfg, ref, len(buffer))
    raw = bytes(buffer)
    if len(raw) != total or hashlib.sha256(raw).hexdigest() != ref["inputSha256"]:
        raise RetriableError("input_sha_mismatch")
    try:
        source = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise RetriableError("input_invalid") from None
    delivery = {key: ref[key] for key in ("turnId", "deliveryId", "attempt", "leaseUntil", "createdAt")}
    delivery["input"] = source
    return _validate_delivery(delivery)


def validate_poll(data: dict, limit: int) -> dict:
    if data.get("schemaVersion") != SCHEMA_VERSION:
        raise ContractError("poll schemaVersion is invalid")
    deliveries = data.get("deliveries")
    cancellations = data.get("cancellations", [])
    server_time = data.get("serverTime")
    if not isinstance(deliveries, list) or len(deliveries) > limit:
        raise ContractError("poll deliveries are invalid")
    if not isinstance(cancellations, list) or len(cancellations) > 100:
        raise ContractError("poll cancellations are invalid")
    if not isinstance(server_time, str) or len(server_time) > 64:
        raise ContractError("poll serverTime is invalid")
    checked = []
    seen = set()
    for delivery in deliveries:
        if isinstance(delivery, dict) and "input" not in delivery and "inputBytes" in delivery:
            clean = _validate_delivery_ref(delivery)
        else:
            clean = _validate_delivery(delivery)
        if clean["turnId"] in seen:
            raise ContractError("poll repeats a turn")
        seen.add(clean["turnId"])
        checked.append(clean)
    turns = []
    for turn_id in cancellations:
        turns.append(require_id(turn_id, "cancellation turnId"))
    return {"deliveries": checked, "cancellations": turns, "serverTime": server_time}


def _validate_delivery(delivery: dict) -> dict:
    if not isinstance(delivery, dict):
        raise ContractError("delivery is not an object")
    turn_id = require_id(delivery.get("turnId"), "delivery turnId")
    delivery_id = require_id(delivery.get("deliveryId"), "deliveryId")
    attempt = delivery.get("attempt")
    if not isinstance(attempt, int) or not (1 <= attempt <= 10000):
        raise ContractError("delivery attempt is invalid")
    for field in ("leaseUntil", "createdAt"):
        value = delivery.get(field)
        if not isinstance(value, str) or len(value) > 64:
            raise ContractError(f"delivery {field} is invalid")
    source = delivery.get("input")
    if not isinstance(source, dict):
        raise ContractError("delivery input is invalid")
    thread_id = require_id(source.get("threadId"), "input threadId")
    text = source.get("text")
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_JSON_BODY:
        raise ContractError("input text is invalid")
    system = source.get("system", "")
    if not isinstance(system, str) or len(system.encode("utf-8")) > MAX_TEXT:
        raise ContractError("input system is invalid")
    transcript = source.get("transcript", [])
    if not isinstance(transcript, list) or len(transcript) > MAX_TRANSCRIPT_ITEMS:
        raise ContractError("input transcript is invalid")
    total = 0
    clean_transcript = []
    for entry in transcript:
        if not isinstance(entry, dict):
            raise ContractError("transcript entry is invalid")
        role = entry.get("role")
        if role not in ("user", "assistant"):
            raise ContractError("transcript role is invalid")
        entry_text = entry.get("text")
        if not isinstance(entry_text, str):
            raise ContractError("transcript text is invalid")
        size = len(entry_text.encode("utf-8"))
        total += size
        if total > MAX_TRANSCRIPT_BYTES:
            raise ContractError("transcript is too large")
        clean_transcript.append({"role": role, "text": entry_text})
    return {
        "turnId": turn_id,
        "deliveryId": delivery_id,
        "attempt": attempt,
        "leaseUntil": delivery["leaseUntil"],
        "createdAt": delivery["createdAt"],
        "input": {
            "threadId": thread_id,
            "text": text,
            "system": system,
            "transcript": clean_transcript,
        },
    }


def validate_event_response(data: dict, event_id: str, seq: int) -> dict:
    if data.get("accepted") is not True:
        raise ContractError("event was not accepted")
    if data.get("eventId") != event_id:
        raise ContractError("event response eventId mismatch")
    if data.get("seq") != seq:
        raise ContractError("event response seq mismatch")
    duplicate = data.get("duplicate", False)
    if not isinstance(duplicate, bool):
        raise ContractError("event response duplicate is invalid")
    upload_id = data.get("uploadId")
    if upload_id is not None and (not isinstance(upload_id, str) or len(upload_id) > 128):
        raise ContractError("event response uploadId is invalid")
    return {"duplicate": duplicate, "uploadId": upload_id}


def validate_heartbeat(data: dict) -> dict:
    if data.get("ok") is not True:
        raise ContractError("heartbeat was not ok")
    cancelled = data.get("cancelled")
    if not isinstance(cancelled, bool):
        raise ContractError("heartbeat cancelled is invalid")
    lease = data.get("leaseUntil")
    if lease is not None and (not isinstance(lease, str) or len(lease) > 64):
        raise ContractError("heartbeat leaseUntil is invalid")
    return {"cancelled": cancelled, "leaseUntil": lease}


def load_watch_state(store: StateStore) -> dict:
    path = store.root / "watch.state.json"
    default = {"failures": 0, "nextPollAt": 0.0, "lastReason": "", "lastSuccessAt": 0.0}
    if not path.exists():
        return default
    try:
        obj = store.read_json(path, 64 << 10)
    except StateError:
        store.quarantine(path)
        return default
    if not isinstance(obj.get("failures"), int) or obj["failures"] < 0:
        return default
    next_at = obj.get("nextPollAt")
    if not isinstance(next_at, (int, float)) or next_at < 0:
        next_at = 0.0
    reason = obj.get("lastReason")
    if not isinstance(reason, str) or not re.fullmatch(r"[a-z0-9_]{0,40}", reason):
        reason = ""
    return {
        "failures": obj["failures"],
        "nextPollAt": float(next_at),
        "lastReason": reason,
        "lastSuccessAt": float(obj.get("lastSuccessAt") or 0.0),
    }


def save_watch_state(store: StateStore, state: dict) -> None:
    with store.named_guard("watch-state.lock"):
        store.write_json(store.root / "watch.state.json", state)


def emit(**fields) -> None:
    parts = []
    for key, value in fields.items():
        if value is None:
            text = "-"
        elif isinstance(value, bool):
            text = "true" if value else "false"
        else:
            text = str(value)
        if not SAFE_VALUE_RE.match(text):
            text = "invalid"
        parts.append(f"{key}={text}")
    print(" ".join(parts))


def cmd_poll(args) -> int:
    try:
        store = StateStore(resolve_state_dir())
    except (ConfigError, StateError) as exc:
        print(f"ERROR config: {exc}", file=sys.stderr)
        return EXIT_CONFIG

    state = load_watch_state(store)
    now = time.time()
    if now < state["nextPollAt"]:
        emit(
            status="backoff",
            retry_ms=int((state["nextPollAt"] - now) * 1000),
            notify=0,
            reason=state["lastReason"] or "backoff",
        )
        return EXIT_OK

    try:
        cfg = load_config()
        payload = {"schemaVersion": SCHEMA_VERSION, "waitMs": args.wait_ms, "limit": args.limit, "inputMode": "ref"}
        response = _post_json(
            cfg,
            "/poll",
            payload,
            timeout=args.wait_ms / 1000.0 + 20.0,
            max_response=MAX_POLL_RESPONSE,
        )
        checked = validate_poll(response, args.limit)
        for turn_id in checked["cancellations"]:
            store.mark_cancelled(turn_id)
        # Fetch every referenced input before saving anything, so a failure leaves no half-saved delivery.
        complete = []
        for delivery in checked["deliveries"]:
            if "input" in delivery:
                complete.append(delivery)
                continue
            if store.is_cancelled(delivery["turnId"]):
                continue
            try:
                complete.append(fetch_delivery_input(cfg, delivery))
            except StaleDelivery:
                # Superseded, lapsed or finished on the server: nothing to keep for this delivery.
                continue
        queued = 0
        for delivery in complete:
            record = dict(delivery)
            record["schemaVersion"] = SCHEMA_VERSION
            record["receivedAt"] = now_iso()
            if store.save_delivery(record) == "queued":
                queued += 1
        recovered = state["failures"] > 0
        save_watch_state(
            store,
            {"failures": 0, "nextPollAt": 0.0, "lastReason": "", "lastSuccessAt": time.time()},
        )
        if queued:
            emit(status="deliveries", count=queued, notify=1 if recovered else 0)
        else:
            emit(status="empty", notify=1 if recovered else 0)
        return EXIT_OK
    except (RelayError, Exception) as exc:
        if isinstance(exc, Terminated):
            raise
        reason = _error_reason(exc)
        failures = state["failures"] + 1
        delay = min(300.0, 5.0 * (2 ** min(failures - 1, 6)))
        notify = failures == 1 or failures % 5 == 0
        save_watch_state(
            store,
            {
                "failures": failures,
                "nextPollAt": time.time() + delay,
                "lastReason": reason,
                "lastSuccessAt": state["lastSuccessAt"],
            },
        )
        emit(status="error", retry_ms=int(delay * 1000), notify=1 if notify else 0, reason=reason)
        return EXIT_OK


def _error_reason(exc: Exception) -> str:
    if isinstance(exc, RetriableError):
        return exc.kind
    if isinstance(exc, AuthError):
        return exc.kind
    if isinstance(exc, ConfigError):
        return "config"
    if isinstance(exc, StateError):
        return "state"
    if isinstance(exc, ContractError):
        return "invalid_response"
    if isinstance(exc, PermanentError):
        return exc.kind
    if isinstance(exc, StaleDelivery):
        return "http_409"
    return "internal"


def _do_heartbeat(cfg: Config, store: StateStore, turn_id: str | None, delivery_id: str | None) -> dict:
    payload = {"schemaVersion": SCHEMA_VERSION}
    if turn_id:
        payload["turnId"] = turn_id
        payload["deliveryId"] = delivery_id
    response = _post_json(cfg, "/heartbeat", payload, timeout=20.0)
    result = validate_heartbeat(response)
    if result["cancelled"] and turn_id:
        store.mark_cancelled(turn_id)
    if turn_id and delivery_id and not result["cancelled"]:
        with store.turn_guard(turn_id, blocking=False) as acquired:
            if acquired:
                processing = store.path("processing", turn_id)
                if processing.exists():
                    try:
                        record = store.read_json(processing)
                    except StateError:
                        record = None
                    if record and record.get("deliveryId") == delivery_id:
                        record["workerHeartbeatAt"] = now_iso()
                        record["heartbeatEpoch"] = time.time()
                        store.write_json(processing, record)
    return result


def cmd_pending_count(args) -> int:
    store = StateStore(resolve_state_dir())
    print(len(store.list_pending()))
    return EXIT_OK


def cmd_claim(args) -> int:
    store = StateStore(resolve_state_dir())
    for pending in store.list_pending():
        try:
            record = store.read_json(pending)
            turn_id = require_id(record.get("turnId"), "pending turnId")
            delivery_id = require_id(record.get("deliveryId"), "pending deliveryId")
        except (StateError, ContractError):
            store.quarantine(pending)
            continue
        if store.is_cancelled(turn_id):
            store.remove(pending)
            continue
        with store.turn_guard(turn_id, blocking=False) as acquired:
            if not acquired:
                continue
            processing = store.path("processing", turn_id)
            if processing.exists():
                try:
                    current = store.read_json(processing)
                except StateError:
                    current = None
                if current and current.get("deliveryId") == delivery_id:
                    store.remove(pending)
                continue
            try:
                ledger = store.load_ledger(turn_id)
            except StateError:
                store.quarantine(store.path("ledger", turn_id))
                ledger = store.new_ledger(turn_id)
            if ledger.get("terminal"):
                store.remove(pending)
                continue
            try:
                os.replace(pending, processing)
            except FileNotFoundError:
                continue
            fsync_dir(pending.parent)
            fsync_dir(processing.parent)
            try:
                record = store.read_json(processing)
                checked = _validate_delivery(record)
            except (StateError, ContractError):
                store.quarantine(processing)
                continue
            record.update(checked)
            record["claimedAt"] = now_iso()
            record["claimedAtEpoch"] = time.time()
            store.write_json(processing, record)
            ledger["deliveryId"] = checked["deliveryId"]
            if ledger.get("staleDeliveryId") == checked["deliveryId"]:
                ledger["staleDeliveryId"] = None
            store.save_ledger(turn_id, ledger)
            output = {
                "schemaVersion": SCHEMA_VERSION,
                "turnId": checked["turnId"],
                "deliveryId": checked["deliveryId"],
                "attempt": checked["attempt"],
                "leaseUntil": checked["leaseUntil"],
                "createdAt": checked["createdAt"],
                "input": checked["input"],
                "nextSeq": ledger["nextSeq"],
                "resume": None,
            }
            inflight = ledger.get("inflight")
            if inflight:
                output["resume"] = {
                    "eventId": inflight.get("eventId"),
                    "seq": inflight.get("seq"),
                    "type": inflight.get("type"),
                }
            print(json.dumps(output, ensure_ascii=False, indent=2))
            return EXIT_OK
    emit(status="no_pending")
    return EXIT_NO_PENDING


def cmd_heartbeat(args, cfg: Config, store: StateStore) -> int:
    if args.delivery and not args.turn:
        raise UsageError("--delivery requires --turn")
    if args.turn and not args.delivery:
        raise UsageError("--turn requires --delivery")
    turn_id = require_id(args.turn, "turnId", UsageError) if args.turn else None
    delivery_id = require_id(args.delivery, "deliveryId", UsageError) if args.delivery else None
    result = _do_heartbeat(cfg, store, turn_id, delivery_id)
    emit(status="ok", cancelled=result["cancelled"])
    return EXIT_OK


def _read_text(path: str) -> str:
    if path == "-":
        raw = sys.stdin.buffer.read(MAX_TEXT + 1)
    else:
        try:
            st = os.lstat(path)
        except OSError:
            raise PermanentError("text_file_missing") from None
        if stat.S_ISLNK(st.st_mode):
            raise PermanentError("text_file_symlink")
        if not stat.S_ISREG(st.st_mode):
            raise PermanentError("text_file_not_regular")
        if st.st_size > MAX_TEXT:
            raise PermanentError("too_large")
        with open(path, "rb") as handle:
            raw = handle.read(MAX_TEXT + 1)
    if len(raw) > MAX_TEXT:
        raise PermanentError("too_large")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        raise PermanentError("text_not_utf8") from None


def _inspect_file(path: str, name: str, mime: str) -> tuple[int, str]:
    try:
        st = os.lstat(path)
    except OSError:
        raise PermanentError("file_missing") from None
    if stat.S_ISLNK(st.st_mode):
        raise PermanentError("file_symlink")
    if not stat.S_ISREG(st.st_mode):
        raise PermanentError("file_not_regular")
    limit = IMAGE_LIMIT if mime.startswith("image/") else FILE_LIMIT
    if st.st_size > limit:
        raise PermanentError("too_large")
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1 << 20)
            if not chunk:
                break
            digest.update(chunk)
    try:
        after = os.stat(path)
    except OSError:
        raise PermanentError("file_missing") from None
    if after.st_size != st.st_size or after.st_mtime_ns != st.st_mtime_ns:
        raise PermanentError("file_changed")
    return st.st_size, digest.hexdigest()


def _event_subpath(turn_id: str) -> str:
    return f"/turns/{quote(turn_id, safe='')}/events"


def _file_subpath(turn_id: str, delivery_id: str, event_id: str, seq: int, name: str) -> str:
    return (
        f"/turns/{quote(turn_id, safe='')}/files"
        f"?deliveryId={quote(delivery_id, safe='')}"
        f"&eventId={quote(event_id, safe='')}"
        f"&seq={seq}"
        f"&name={quote(name, safe='')}"
    )


def _allocate(ledger: dict, kind: str, content_hash: str, event_id: str | None, extra: dict) -> tuple[str, int, str]:
    events = ledger["events"]
    if event_id:
        require_id(event_id, "eventId", UsageError)
        if event_id in events:
            known = events[event_id]
            if known.get("type") == kind and known.get("sha256") == content_hash:
                return event_id, known["seq"], "confirmed"
            raise StateConflict("eventId was already used with different content")
        inflight = ledger.get("inflight")
        if inflight:
            if inflight.get("eventId") != event_id:
                raise StateConflict("another event is in flight")
            if inflight.get("type") != kind or inflight.get("sha256") != content_hash:
                raise StateConflict("in-flight event differs")
            return event_id, inflight["seq"], "new"
    else:
        inflight = ledger.get("inflight")
        if inflight:
            if inflight.get("type") == kind and inflight.get("sha256") == content_hash:
                return inflight["eventId"], inflight["seq"], "new"
            raise StateConflict("another event is in flight")
        event_id = f"evt-{uuid.uuid4().hex}"
    seq = int(ledger["nextSeq"])
    ledger["inflight"] = {
        "eventId": event_id,
        "seq": seq,
        "type": kind,
        "sha256": content_hash,
        "attempts": 0,
        "lastError": "",
        **extra,
    }
    return event_id, seq, "new"


def _mark_stale(store: StateStore, turn_id: str, delivery_id: str) -> None:
    with store.turn_guard(turn_id, blocking=True) as acquired:
        if not acquired:
            return
        try:
            ledger = store.load_ledger(turn_id)
        except StateError:
            return
        ledger["inflight"] = None
        ledger["staleDeliveryId"] = delivery_id
        store.save_ledger(turn_id, ledger)
        store.detach_processing(turn_id, delivery_id, "stale")


def _run_event(
    cfg: Config,
    store: StateStore,
    turn_id: str,
    delivery_id: str,
    kind: str,
    content_hash: str,
    extra: dict,
    request,
    event_id: str | None = None,
    final: bool = False,
    validate=None,
) -> dict:
    if final:
        try:
            heartbeat = _do_heartbeat(cfg, store, turn_id, delivery_id)
        except StaleDelivery:
            _mark_stale(store, turn_id, delivery_id)
            raise
        if heartbeat["cancelled"]:
            raise Cancelled()
    with store.turn_guard(turn_id, blocking=True) as acquired:
        if not acquired:
            raise StateError("turn is locked by another process")
        ledger = store.load_ledger(turn_id)
        if ledger.get("staleDeliveryId") == delivery_id:
            raise StaleDelivery()
        if ledger.get("deliveryId") and ledger["deliveryId"] != delivery_id:
            raise StaleDelivery()
        processing = store.read_processing(turn_id)
        if processing and processing.get("deliveryId") != delivery_id:
            raise StaleDelivery()
        if store.is_cancelled(turn_id):
            raise Cancelled()
        terminal = ledger.get("terminal")
        if terminal:
            if terminal == kind and kind in TERMINAL_KINDS:
                known = ledger["events"].get(ledger.get("terminalEventId") or "", {})
                return {
                    "duplicate": True,
                    "eventId": ledger.get("terminalEventId"),
                    "seq": known.get("seq"),
                }
            raise StateConflict("turn is already terminal")
        if kind == "completed" and not any(item.get("type") == "text" for item in ledger["events"].values()):
            raise PermanentError("completed_requires_text")
        if validate is not None:
            validate(ledger)
        event_id, seq, state = _allocate(ledger, kind, content_hash, event_id, extra)
        store.save_ledger(turn_id, ledger)
        if state == "confirmed":
            return {"duplicate": True, "eventId": event_id, "seq": seq}
        try:
            response = request(event_id, seq)
            checked = validate_event_response(response, event_id, seq)
        except RetriableError as exc:
            inflight = ledger.get("inflight") or {}
            attempts = int(inflight.get("attempts", 0)) + 1
            inflight["attempts"] = attempts
            inflight["lastError"] = exc.kind
            ledger["inflight"] = inflight
            store.save_ledger(turn_id, ledger)
            delay = exc.retry_ms or min(60000, 1000 * (2 ** min(attempts, 6)))
            raise RetriableError(exc.kind, delay) from None
        except StaleDelivery:
            ledger["inflight"] = None
            ledger["staleDeliveryId"] = delivery_id
            store.save_ledger(turn_id, ledger)
            store.detach_processing(turn_id, delivery_id, "stale")
            raise
        except (PermanentError, AuthError, ContractError, StateConflict):
            ledger["inflight"] = None
            store.save_ledger(turn_id, ledger)
            raise

        record = {"seq": seq, "type": kind, "sha256": content_hash}
        for key in ("itemId", "name", "mime", "fileKind"):
            if extra.get(key) is not None:
                record[key] = extra[key]
        if kind == "file":
            record["uploadId"] = checked["uploadId"]
        ledger["events"][event_id] = record
        ledger["nextSeq"] = max(int(ledger["nextSeq"]), seq + 1)
        ledger["inflight"] = None
        if kind == "delta":
            item = ledger["items"].setdefault(extra["itemId"], {"deltas": []})
            item.setdefault("deltas", []).append(extra["text"])
        elif kind == "text":
            ledger["items"].pop(extra.get("itemId"), None)
        if kind in TERMINAL_KINDS:
            ledger["terminal"] = kind
            ledger["terminalEventId"] = event_id
        store.save_ledger(turn_id, ledger)
        if kind in TERMINAL_KINDS:
            store.detach_processing(turn_id, delivery_id, "done")
        return {"duplicate": checked["duplicate"], "eventId": event_id, "seq": seq}


def cmd_send_text(args, cfg: Config, store: StateStore) -> int:
    turn_id = require_id(args.turn, "turnId", UsageError)
    delivery_id = require_id(args.delivery, "deliveryId", UsageError)
    if args.delta and args.final:
        raise UsageError("--delta and --final are mutually exclusive")
    kind = "delta" if args.delta else "text"
    text = _read_text(args.text_file)
    if len(text.encode("utf-8")) > MAX_TEXT:
        raise PermanentError("too_large")
    item_id = require_id(args.item_id or f"{turn_id}-main", "itemId", UsageError)
    if (
        kind == "text"
        and not args.event_id
        and len(text.encode("utf-8")) > TEXT_PART_BYTES
        and not _item_has_deltas(store, turn_id, item_id)
    ):
        return _send_text_parts(args, cfg, store, turn_id, delivery_id, item_id, text)
    content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    extra = {"itemId": item_id, "text": text}

    def validate(ledger):
        if kind != "text":
            return
        deltas = (ledger.get("items", {}).get(item_id) or {}).get("deltas") or []
        if deltas and text != "".join(deltas):
            raise PermanentError("delta_mismatch")

    def request(event_id: str, seq: int) -> dict:
        payload = {
            "schemaVersion": SCHEMA_VERSION,
            "deliveryId": delivery_id,
            "eventId": event_id,
            "seq": seq,
            "type": kind,
            "itemId": item_id,
            "text": text,
        }
        return _post_json(cfg, _event_subpath(turn_id), payload, timeout=30.0)

    result = _run_event(
        cfg,
        store,
        turn_id,
        delivery_id,
        kind,
        content_hash,
        extra,
        request,
        event_id=args.event_id,
        final=args.final,
        validate=validate,
    )
    emit(status="ok", duplicate=result["duplicate"], eventId=result["eventId"], seq=result["seq"])
    return EXIT_OK


def _json_cost(ch: str) -> int:
    """Bytes one character takes inside a JSON string as _post_json writes it (ensure_ascii=False)."""
    if ch in '"\\\n\r\t\b\f':
        return 2
    if ord(ch) < 0x20:
        return 6
    return len(ch.encode("utf-8"))


def split_text(text: str, limit: int = TEXT_PART_BYTES) -> list[str]:
    """Splits text into ordered parts whose JSON-escaped UTF-8 size is at most `limit`, never inside a character.

    A part ends after the last newline in its window when that keeps at least half the window, otherwise after
    the last space on the same terms, otherwise at the limit; it never separates a CR from its LF. Joining the
    parts gives back the text exactly.
    """
    parts: list[str] = []
    start = 0
    size = 0
    last_nl = -1
    last_sp = -1
    i = 0
    n = len(text)
    while i < n:
        cost = _json_cost(text[i])
        if size + cost > limit and i > start:
            half = (i - start) // 2
            cut = i
            if last_nl >= start and last_nl + 1 - start >= half:
                cut = last_nl + 1
            elif last_sp >= start and last_sp + 1 - start >= half:
                cut = last_sp + 1
            if cut - 1 > start and text[cut - 1] == "\r" and cut < n and text[cut] == "\n":
                cut -= 1
            parts.append(text[start:cut])
            start = cut
            size = sum(_json_cost(ch) for ch in text[start:i])
            continue
        size += cost
        if text[i] == "\n":
            last_nl = i
        elif text[i] == " ":
            last_sp = i
        i += 1
    if start < n or not parts:
        parts.append(text[start:])
    return parts


def _item_has_deltas(store: StateStore, turn_id: str, item_id: str) -> bool:
    """An item that already streamed deltas must get its final text in one event equal to them, so it is not split."""
    try:
        ledger = store.load_ledger(turn_id)
    except StateError:
        return False
    return bool((ledger.get("items", {}).get(item_id) or {}).get("deltas"))


def _part_item_id(item_id: str, index: int) -> str:
    if index == 0:
        return item_id
    suffix = f"-p{index + 1}"
    return require_id(item_id[: 128 - len(suffix)] + suffix, "itemId", UsageError)


def _send_text_parts(args, cfg: Config, store: StateStore, turn_id: str, delivery_id: str, item_id: str, text: str) -> int:
    """A long final text goes out as several text events, one item each, in order.

    The server and OMB accept any number of text items per turn; each part becomes its own reply bubble.
    Rerunning the same command resumes after the last part the ledger already confirmed.
    """
    ledger = store.load_ledger(turn_id)
    parts = split_text(text)
    duplicate = True
    last = {"eventId": None, "seq": None}
    for index, part in enumerate(parts):
        part_item = _part_item_id(item_id, index)
        part_hash = hashlib.sha256(part.encode("utf-8")).hexdigest()
        known = next(
            (
                (event_id, record)
                for event_id, record in ledger["events"].items()
                if record.get("type") == "text" and record.get("itemId") == part_item and record.get("sha256") == part_hash
            ),
            None,
        )
        if known is not None:
            last = {"eventId": known[0], "seq": known[1].get("seq")}
            continue

        def request(event_id: str, seq: int, part=part, part_item=part_item) -> dict:
            payload = {
                "schemaVersion": SCHEMA_VERSION,
                "deliveryId": delivery_id,
                "eventId": event_id,
                "seq": seq,
                "type": "text",
                "itemId": part_item,
                "text": part,
            }
            return _post_json(cfg, _event_subpath(turn_id), payload, timeout=30.0)

        result = _run_event(
            cfg,
            store,
            turn_id,
            delivery_id,
            "text",
            part_hash,
            {"itemId": part_item, "text": part},
            request,
            final=args.final and index == 0,
        )
        duplicate = duplicate and result["duplicate"]
        last = result
        ledger = store.load_ledger(turn_id)
    emit(status="ok", duplicate=duplicate, eventId=last["eventId"], seq=last["seq"], parts=len(parts))
    return EXIT_OK


def cmd_send_file(args, cfg: Config, store: StateStore) -> int:
    turn_id = require_id(args.turn, "turnId", UsageError)
    delivery_id = require_id(args.delivery, "deliveryId", UsageError)
    name = require_name(args.name or Path(args.path).name)
    mime = require_mime(args.mime or mimetypes.guess_type(name)[0] or "application/octet-stream")
    size, digest = _inspect_file(args.path, name, mime)
    file_kind = "image" if mime.startswith("image/") else "file"
    extra = {"name": name, "mime": mime, "fileKind": file_kind, "path": args.path, "size": size}

    def request(event_id: str, seq: int) -> dict:
        with open(args.path, "rb") as handle:
            body = _FileBody(handle, size)
            return _http_request(
                cfg,
                "POST",
                _file_subpath(turn_id, delivery_id, event_id, seq, name),
                body=body,
                headers={"Content-Type": mime, "Content-Length": str(size)},
                timeout=120.0,
            )

    result = _run_event(
        cfg,
        store,
        turn_id,
        delivery_id,
        "file",
        digest,
        extra,
        request,
        event_id=args.event_id,
        final=False,
    )
    emit(status="ok", duplicate=result["duplicate"], eventId=result["eventId"], seq=result["seq"])
    return EXIT_OK


def cmd_complete(args, cfg: Config, store: StateStore) -> int:
    turn_id = require_id(args.turn, "turnId", UsageError)
    delivery_id = require_id(args.delivery, "deliveryId", UsageError)
    content_hash = hashlib.sha256(b"completed").hexdigest()

    def request(event_id: str, seq: int) -> dict:
        payload = {
            "schemaVersion": SCHEMA_VERSION,
            "deliveryId": delivery_id,
            "eventId": event_id,
            "seq": seq,
            "type": "completed",
        }
        return _post_json(cfg, _event_subpath(turn_id), payload, timeout=30.0)

    result = _run_event(
        cfg,
        store,
        turn_id,
        delivery_id,
        "completed",
        content_hash,
        {},
        request,
        event_id=args.event_id,
        final=True,
    )
    emit(status="ok", duplicate=result["duplicate"], eventId=result["eventId"], seq=result["seq"])
    return EXIT_OK


def cmd_fail(args, cfg: Config, store: StateStore) -> int:
    turn_id = require_id(args.turn, "turnId", UsageError)
    delivery_id = require_id(args.delivery, "deliveryId", UsageError)
    text = _read_text(args.text_file) if args.text_file else ""
    if len(text.encode("utf-8")) > MAX_TEXT:
        raise PermanentError("too_large")
    content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    extra = {"text": text} if text else {}

    def request(event_id: str, seq: int) -> dict:
        payload = {
            "schemaVersion": SCHEMA_VERSION,
            "deliveryId": delivery_id,
            "eventId": event_id,
            "seq": seq,
            "type": "failed",
        }
        if text:
            payload["text"] = text
        return _post_json(cfg, _event_subpath(turn_id), payload, timeout=30.0)

    result = _run_event(
        cfg,
        store,
        turn_id,
        delivery_id,
        "failed",
        content_hash,
        extra,
        request,
        event_id=args.event_id,
        final=True,
    )
    emit(status="ok", duplicate=result["duplicate"], eventId=result["eventId"], seq=result["seq"])
    return EXIT_OK


def cmd_retry_inflight(args, cfg: Config, store: StateStore) -> int:
    turn_id = require_id(args.turn, "turnId", UsageError)
    delivery_id = require_id(args.delivery, "deliveryId", UsageError)
    with store.turn_guard(turn_id, blocking=True) as acquired:
        if not acquired:
            raise StateError("turn is locked by another process")
        ledger = store.load_ledger(turn_id)
        if ledger.get("deliveryId") and ledger["deliveryId"] != delivery_id:
            raise StaleDelivery()
        if store.is_cancelled(turn_id):
            raise Cancelled()
        inflight = ledger.get("inflight")
        if not inflight:
            emit(status="none")
            return EXIT_OK
        kind = inflight["type"]
        event_id = inflight["eventId"]
        seq = inflight["seq"]
        try:
            if kind == "file":
                name = require_name(inflight.get("name"))
                mime = require_mime(inflight.get("mime"))
                path = inflight.get("path")
                size, digest = _inspect_file(path, name, mime)
                if digest != inflight.get("sha256"):
                    raise StateConflict("in-flight file changed")
                with open(path, "rb") as handle:
                    response = _http_request(
                        cfg,
                        "POST",
                        _file_subpath(turn_id, delivery_id, event_id, seq, name),
                        body=_FileBody(handle, size),
                        headers={"Content-Type": mime, "Content-Length": str(size)},
                        timeout=120.0,
                    )
            else:
                payload = {
                    "schemaVersion": SCHEMA_VERSION,
                    "deliveryId": delivery_id,
                    "eventId": event_id,
                    "seq": seq,
                    "type": kind,
                }
                if inflight.get("itemId"):
                    payload["itemId"] = inflight["itemId"]
                if "text" in inflight:
                    payload["text"] = inflight["text"]
                response = _post_json(cfg, _event_subpath(turn_id), payload, timeout=30.0)
            checked = validate_event_response(response, event_id, seq)
        except RetriableError as exc:
            inflight["attempts"] = int(inflight.get("attempts", 0)) + 1
            inflight["lastError"] = exc.kind
            ledger["inflight"] = inflight
            store.save_ledger(turn_id, ledger)
            delay = exc.retry_ms or min(60000, 1000 * (2 ** min(inflight["attempts"], 6)))
            raise RetriableError(exc.kind, delay) from None
        except StaleDelivery:
            ledger["inflight"] = None
            ledger["staleDeliveryId"] = delivery_id
            store.save_ledger(turn_id, ledger)
            store.detach_processing(turn_id, delivery_id, "stale")
            raise
        except (PermanentError, AuthError, ContractError, StateConflict):
            ledger["inflight"] = None
            store.save_ledger(turn_id, ledger)
            raise
        record = {"seq": seq, "type": kind, "sha256": inflight.get("sha256")}
        for key in ("itemId", "name", "mime", "fileKind"):
            if inflight.get(key) is not None:
                record[key] = inflight[key]
        if kind == "file":
            record["uploadId"] = checked["uploadId"]
        ledger["events"][event_id] = record
        ledger["nextSeq"] = max(int(ledger["nextSeq"]), seq + 1)
        ledger["inflight"] = None
        if kind == "delta":
            item = ledger["items"].setdefault(inflight["itemId"], {"deltas": []})
            item.setdefault("deltas", []).append(inflight.get("text", ""))
        elif kind == "text":
            ledger["items"].pop(inflight.get("itemId"), None)
        if kind in TERMINAL_KINDS:
            ledger["terminal"] = kind
            ledger["terminalEventId"] = event_id
        store.save_ledger(turn_id, ledger)
        if kind in TERMINAL_KINDS:
            store.detach_processing(turn_id, delivery_id, "done")
    emit(status="ok", duplicate=checked["duplicate"], eventId=event_id, seq=seq)
    return EXIT_OK


def cmd_finish(args, cfg: Config, store: StateStore) -> int:
    turn_id = require_id(args.turn, "turnId", UsageError)
    delivery_id = require_id(args.delivery, "deliveryId", UsageError)
    with store.turn_guard(turn_id, blocking=True) as acquired:
        if not acquired:
            raise StateError("turn is locked by another process")
        ledger = store.load_ledger(turn_id)
        processing = store.read_processing(turn_id)
        if processing and processing.get("deliveryId") != delivery_id:
            raise StaleDelivery()
        if args.reason == "cancelled":
            ledger["terminal"] = "cancelled"
            ledger["terminalEventId"] = None
            store.save_ledger(turn_id, ledger)
        sub = {"cancelled": "cancelled", "stale": "stale", "abandoned": "stale"}[args.reason]
        store.detach_processing(turn_id, delivery_id, sub)
    emit(status="ok")
    return EXIT_OK


def cmd_recover(args, cfg: Config, store: StateStore) -> int:
    recovered = quarantined = pruned = 0
    now = time.time()

    for pending in store.list_pending():
        try:
            record = store.read_json(pending)
            require_id(record.get("turnId"), "pending turnId")
            require_id(record.get("deliveryId"), "pending deliveryId")
        except (StateError, ContractError):
            if store.quarantine(pending):
                quarantined += 1

    for processing in store.list_processing():
        try:
            record = store.read_json(processing)
            turn_id = require_id(record.get("turnId"), "processing turnId")
            require_id(record.get("deliveryId"), "processing deliveryId")
        except (StateError, ContractError):
            if store.quarantine(processing):
                quarantined += 1
            continue
        with store.turn_guard(turn_id, blocking=False) as acquired:
            if not acquired or not processing.exists():
                continue
            try:
                record = store.read_json(processing)
            except StateError:
                continue
            claimed = _float_or_zero(record.get("claimedAtEpoch"))
            heartbeat = _float_or_zero(record.get("heartbeatEpoch"))
            try:
                mtime = processing.stat().st_mtime
            except OSError:
                continue
            last = max(claimed, heartbeat, mtime)
            if now - last < args.stale_seconds:
                continue
            pending = store.path("pending", turn_id)
            if pending.exists():
                if store.quarantine(processing, "stale"):
                    recovered += 1
            else:
                try:
                    os.link(processing, pending)
                except FileExistsError:
                    if store.quarantine(processing, "stale"):
                        recovered += 1
                    continue
                except OSError:
                    continue
                try:
                    os.unlink(processing)
                except FileNotFoundError:
                    pass
                fsync_dir(processing.parent)
                fsync_dir(pending.parent)
                recovered += 1

    for ledger_path in store.list_files("ledger"):
        try:
            store.read_json(ledger_path)
        except StateError:
            if store.quarantine(ledger_path):
                quarantined += 1

    cutoff = now - 7 * 24 * 3600
    for sub in ("done", "stale", "corrupt", "cancelled"):
        for path in store.list_artifacts(sub):
            try:
                if path.stat().st_mtime < cutoff:
                    store.remove(path)
                    pruned += 1
            except OSError:
                continue
    for ledger_path in store.list_files("ledger"):
        try:
            if ledger_path.stat().st_mtime < cutoff:
                obj = store.read_json(ledger_path)
                if obj.get("terminal"):
                    store.remove(ledger_path)
                    pruned += 1
        except (OSError, StateError):
            continue

    emit(recovered=recovered, quarantined=quarantined, pruned=pruned)
    return EXIT_OK


def _float_or_zero(value) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="omb_relay.py", description="OpenMausBot Muse Relay data-plane client")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("state-dir", help="print the resolved state directory")
    sub.add_parser("pending-count", help="print the number of pending turns")
    sub.add_parser("claim", help="atomically claim one pending turn")

    poll = sub.add_parser("poll", help="run one long poll and persist the result")
    poll.add_argument("--wait-ms", type=int, default=20000)
    poll.add_argument("--limit", type=int, default=1)

    heartbeat = sub.add_parser("heartbeat", help="renew the lease or report online")
    heartbeat.add_argument("--turn")
    heartbeat.add_argument("--delivery")

    text = sub.add_parser("send-text", help="send a delta or final text event")
    text.add_argument("--turn", required=True)
    text.add_argument("--delivery", required=True)
    text.add_argument("--text-file", default="-")
    text.add_argument("--item-id")
    text.add_argument("--delta", action="store_true")
    text.add_argument("--final", action="store_true")
    text.add_argument("--event-id")

    upload = sub.add_parser("send-file", help="upload one file as raw bytes")
    upload.add_argument("--turn", required=True)
    upload.add_argument("--delivery", required=True)
    upload.add_argument("--path", required=True)
    upload.add_argument("--name")
    upload.add_argument("--mime")
    upload.add_argument("--event-id")

    complete = sub.add_parser("complete", help="send the completed terminal event")
    complete.add_argument("--turn", required=True)
    complete.add_argument("--delivery", required=True)
    complete.add_argument("--event-id")

    failed = sub.add_parser("fail", help="send the failed terminal event")
    failed.add_argument("--turn", required=True)
    failed.add_argument("--delivery", required=True)
    failed.add_argument("--text-file")
    failed.add_argument("--event-id")

    retry = sub.add_parser("retry-inflight", help="retry the unconfirmed event with its original ID")
    retry.add_argument("--turn", required=True)
    retry.add_argument("--delivery", required=True)

    finish = sub.add_parser("finish", help="clean up a processing turn")
    finish.add_argument("--turn", required=True)
    finish.add_argument("--delivery", required=True)
    finish.add_argument("--reason", required=True, choices=("cancelled", "stale", "abandoned"))

    recover = sub.add_parser("recover", help="recycle stale claims and quarantine corrupt state")
    recover.add_argument("--stale-seconds", type=int, default=900)

    return parser


def main(argv=None) -> int:
    signal.signal(signal.SIGTERM, _sigterm)
    args = build_parser().parse_args(argv)
    if args.command == "poll":
        if not (0 <= args.wait_ms <= 25000):
            print("ERROR usage: --wait-ms must be 0..25000", file=sys.stderr)
            return EXIT_USAGE
        if not (1 <= args.limit <= 4):
            print("ERROR usage: --limit must be 1..4", file=sys.stderr)
            return EXIT_USAGE
    if args.command == "recover" and not (60 <= args.stale_seconds <= 86400):
        print("ERROR usage: --stale-seconds must be 60..86400", file=sys.stderr)
        return EXIT_USAGE
    try:
        if args.command == "state-dir":
            print(resolve_state_dir())
            return EXIT_OK
        if args.command == "pending-count":
            return cmd_pending_count(args)
        if args.command == "claim":
            return cmd_claim(args)
        if args.command == "poll":
            return cmd_poll(args)
        cfg = load_config()
        store = StateStore(cfg.state_dir)
        if args.command == "heartbeat":
            return cmd_heartbeat(args, cfg, store)
        if args.command == "send-text":
            return cmd_send_text(args, cfg, store)
        if args.command == "send-file":
            return cmd_send_file(args, cfg, store)
        if args.command == "complete":
            return cmd_complete(args, cfg, store)
        if args.command == "fail":
            return cmd_fail(args, cfg, store)
        if args.command == "retry-inflight":
            return cmd_retry_inflight(args, cfg, store)
        if args.command == "finish":
            return cmd_finish(args, cfg, store)
        if args.command == "recover":
            return cmd_recover(args, cfg, store)
        raise UsageError("unknown command")
    except Terminated:
        return EXIT_TERMINATED
    except ConfigError as exc:
        print(f"ERROR config: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    except UsageError as exc:
        print(f"ERROR usage: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except StateError as exc:
        print(f"ERROR state: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    except StaleDelivery:
        emit(status="stale")
        return EXIT_STALE
    except Cancelled:
        emit(status="cancelled")
        return EXIT_CANCELLED
    except StateConflict as exc:
        print(f"ERROR conflict: {exc}", file=sys.stderr)
        return EXIT_CONFLICT
    except AuthError as exc:
        emit(status="rejected", reason=exc.kind)
        return EXIT_PERMANENT
    except PermanentError as exc:
        emit(status="rejected", reason=exc.kind)
        return EXIT_PERMANENT
    except RetriableError as exc:
        emit(status="retry", reason=exc.kind, retry_ms=exc.retry_ms)
        return EXIT_RETRY
    except ContractError:
        emit(status="rejected", reason="invalid_response")
        return EXIT_PERMANENT
    except KeyboardInterrupt:
        return 130
    except Exception:
        print("ERROR internal: unexpected failure", file=sys.stderr)
        return EXIT_CONFIG


if __name__ == "__main__":
    sys.exit(main())
