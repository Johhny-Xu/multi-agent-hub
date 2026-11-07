#!/usr/bin/env python3
"""Linux service launcher; records never contain credentials or full argv."""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request


def environment(root):
    env = os.environ.copy()
    source = root / ".env"
    if not source.is_file():
        source = root / "hub/.env"
    if source.is_file():
        for line in source.read_text(encoding="utf-8-sig").splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            match = re.fullmatch(r"\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)", line)
            if not match:
                raise ValueError("Invalid .env assignment")
            key, value = match[1], match[2].strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            else:
                value = re.sub(r"\s+#.*$", "", value).rstrip()
            env[key] = value
    for key, value in {"AGENTHUB_HOST": "127.0.0.1", "AGENTHUB_PORT": "8765", "HUBCONSOLE_HOST": "127.0.0.1", "HUBCONSOLE_PORT": "8890"}.items():
        if not env.get(key):
            env[key] = value
    for key in ("AGENTHUB_PORT", "HUBCONSOLE_PORT"):
        if not re.fullmatch(r"\d+", env[key]) or not 1 <= int(env[key]) <= 65535:
            raise ValueError("Ports must be integers between 1 and 65535")
    env.setdefault("HUBCONSOLE_SUB_HOST", "127.0.0.1")
    if not env.get("HUBCONSOLE_SERVER_URL"):
        env["HUBCONSOLE_SERVER_URL"] = endpoint(env["AGENTHUB_HOST"], env["AGENTHUB_PORT"], "/mcp")
    if not env.get("HUBCONSOLE_SERVER_TOKEN"):
        env["HUBCONSOLE_SERVER_TOKEN"] = env.get("HUB_TOKEN", "")
    return env


def endpoint(host, port, path):
    host = {"0.0.0.0": "127.0.0.1", "::": "::1"}.get(host, host)
    if ":" in host:
        host = "[" + host.strip("[]") + "]"
    return "http://" + host + ":" + str(port) + path


def process_identity(pid):
    try:
        fields = Path("/proc", str(pid), "stat").read_text().rsplit(") ", 1)[1].split()
        if fields[0] == "Z":
            return None
        args = Path("/proc", str(pid), "cmdline").read_bytes().split(b"\0")
        return fields[19], [os.fsdecode(part) for part in args if part]
    except (OSError, IndexError):
        return None


def owns_listener(pid, port):
    inodes = set()
    try:
        for fd in Path("/proc", str(pid), "fd").iterdir():
            try:
                match = re.fullmatch(r"socket:\[(\d+)\]", os.readlink(fd))
                if match:
                    inodes.add(match[1])
            except OSError:
                pass
        for filename in ("tcp", "tcp6"):
            for line in Path("/proc", str(pid), "net", filename).read_text().splitlines()[1:]:
                fields = line.split()
                if fields[3] == "0A" and int(fields[1].rsplit(":", 1)[1], 16) == port and fields[9] in inodes:
                    return True
    except (OSError, IndexError, ValueError):
        pass
    return False


def record_path(root, name):
    return root / ".run" / (name + ".linux.json")


def stop_service(root, name):
    path = record_path(root, name)
    entry = str(root / ("hub/agent_hub.py" if name == "hub" else "console/server.mjs"))
    if not path.is_file():
        return
    try:
        record = json.loads(path.read_text())
        pid = record["pid"]
        if type(pid) is not int or pid <= 1 or record.get("root") != str(root) or record.get("entry") != entry:
            raise ValueError("Invalid service record")
        identity = process_identity(pid)
        if identity and identity[0] == record.get("start_ticks") and entry in identity[1]:
            group = os.getpgid(pid) == pid and record.get("own_group") is True
            send = (lambda sig: os.killpg(pid, sig)) if group else (lambda sig: os.kill(pid, sig))
            try:
                send(signal.SIGTERM)
                deadline = time.monotonic() + 3
                while process_identity(pid) and time.monotonic() < deadline:
                    time.sleep(.05)
                if group or process_identity(pid):
                    send(signal.SIGKILL)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 2
            while process_identity(pid) and time.monotonic() < deadline:
                time.sleep(.05)
            if process_identity(pid):
                raise RuntimeError("Owned service did not stop")
        path.unlink()
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise RuntimeError("Could not validate/stop owned " + name + ": " + type(error).__name__)


def start_service(root, name, command, env):
    entry = str(root / ("hub/agent_hub.py" if name == "hub" else "console/server.mjs"))
    with (root / "logs" / (name + ".log")).open("wb") as log:
        proc = subprocess.Popen(command, cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                start_new_session=True, close_fds=True)
    try:
        identity = process_identity(proc.pid)
        if not identity:
            raise RuntimeError("Service exited before its process record was created")
        record = {"root": str(root), "pid": proc.pid, "start_ticks": identity[0], "entry": entry, "own_group": True}
        fd, temporary = tempfile.mkstemp(prefix=name + "-", suffix=".tmp", dir=root / ".run")
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(record, stream)
        os.replace(temporary, record_path(root, name))
        return proc
    except Exception:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait(timeout=3)
        raise


def wait_health(proc, url, timeout, service=None):
    deadline = time.monotonic() + timeout
    port = urllib.parse.urlsplit(url).port
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("Service exited during startup; inspect logs")
        try:
            with opener.open(url, timeout=min(.5, max(.05, deadline - time.monotonic()))) as response:
                healthy = response.status == 200 and (not service or json.loads(response.read(10000)).get("service") == service)
            if healthy and owns_listener(proc.pid, port) and proc.poll() is None:
                return
        except (OSError, ValueError):
            pass
        time.sleep(.05)
    raise RuntimeError("Owned service health check timed out; inspect logs")


def node_runtime(env):
    node = shutil.which("node", path=env.get("PATH"))
    if not node:
        raise ValueError("Node.js 20+ is required")
    proc = subprocess.run([node, "--version"], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5, env=env)
    match = re.fullmatch(r"v(\d+)\.\d+\.\d+\s*", proc.stdout)
    if proc.returncode or not match or int(match[1]) < 20:
        raise ValueError("Node.js 20+ is required")
    return node


@contextlib.contextmanager
def operation_lock(root):
    with (root / ".run/launcher.lock").open("a") as lock:
        deadline = time.monotonic() + 10
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("Another launcher operation is still active")
                time.sleep(.05)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("start", "stop", "console"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--silent", action="store_true")
    parser.add_argument("--health-timeout", type=float, default=12)
    args = parser.parse_args()
    root = args.root.resolve()
    if sys.platform != "linux" or sys.version_info < (3, 8):
        raise SystemExit("This launcher needs Linux and Python 3.8+")
    try:
        if not root.is_dir() or not 0 < args.health_timeout <= 60:
            raise ValueError("Invalid workspace or health timeout")
        env = environment(root) if args.action != "stop" else None
        if args.action == "console":
            node = node_runtime(env)
            os.chdir(root)
            os.execve(node, [node, str(root / "console/server.mjs")], env)
        (root / ".run").mkdir(exist_ok=True)
        with operation_lock(root):
            if args.action == "stop":
                for name in ("console", "hub"):
                    stop_service(root, name)
            else:
                node = node_runtime(env)
                python = env.get("HUB_PYTHON") or sys.executable
                (root / "logs").mkdir(exist_ok=True)
                agents = Path(env.get("HUB_AGENTS_FILE") or root / "hub/agents.json")
                env["HUB_AGENTS_FILE"] = str(agents)
                env.setdefault("HUB_RESULTS_DIR", str(Path(env.get("HUB_STATE_DIR") or root / "hub/state") / "results"))
                if not agents.exists():
                    agents.parent.mkdir(parents=True, exist_ok=True)
                    with agents.open("xb") as dest:
                        dest.write((root / "hub/agents.example.json").read_bytes())
                for name in ("console", "hub"):
                    stop_service(root, name)
                started = []
                try:
                    hub = start_service(root, "hub", [python, str(root / "hub/agent_hub.py"), "--http", env["AGENTHUB_PORT"], "--host", env["AGENTHUB_HOST"]], env)
                    started.append("hub")
                    wait_health(hub, endpoint(env["AGENTHUB_HOST"], env["AGENTHUB_PORT"], "/health"), args.health_timeout, "agent-hub")
                    console = start_service(root, "console", [node, str(root / "console/server.mjs")], env)
                    started.append("console")
                    wait_health(console, endpoint(env["HUBCONSOLE_HOST"], env["HUBCONSOLE_PORT"], "/dashboard"), args.health_timeout)
                except BaseException:
                    for name in reversed(started):
                        stop_service(root, name)
                    raise
                if not args.silent:
                    print("Hub and console passed owned HTTP health checks")
        if not args.silent and args.action == "stop":
            print("Stopped matching services recorded by this checkout")
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print("Launcher error: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
