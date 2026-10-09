"""Dependency discovery and safe file helpers shared by distributable installers."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


class SetupError(Exception):
    pass


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.agenthub-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as output:
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.write('\n')
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path):
    if Path(path).is_symlink():
        raise SetupError('Refusing an indirect configuration/manifest symlink: ' + Path(path).name)
    try:
        with Path(path).open(encoding='utf-8-sig') as stream:
            value = json.load(stream)
    except (OSError, ValueError):
        raise SetupError('Invalid or unreadable configuration: ' + Path(path).name)
    if not isinstance(value, dict):
        raise SetupError('Configuration must be a JSON object: ' + Path(path).name)
    return value


def replace_file(source, target):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.agenthub-', dir=str(target.parent))
    os.close(fd)
    try:
        shutil.copy2(source, temporary)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def atomic_text(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.agenthub-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as output:
            output.write(value)
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def run(argv, env=None, timeout=30):
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0
    return subprocess.run([str(item) for item in argv], stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          encoding='utf-8', errors='replace', env=env,
                          timeout=timeout, creationflags=flags)


def runtime(kind, override=None):
    candidates = [[override]] if override else []
    if kind == 'python' and not override:
        candidates += [[sys.executable]]
    for name in ([] if override else ['node'] if kind == 'node' else ['python3', 'python', 'py']):
        found = shutil.which(name)
        if found and 'WindowsApps' not in found:
            candidates.append([found] + (['-3'] if Path(found).stem.lower() == 'py' else []))
    for argv in candidates:
        try:
            argv[0] = str(Path(shutil.which(argv[0]) or argv[0]).resolve())
            check = run(argv + (['--version'] if kind == 'node' else ['-c', 'import sys; print(".".join(map(str,sys.version_info[:3])))']), timeout=5)
            match = re.fullmatch(r'v?(\d+)\.(\d+)\.\d+\s*', check.stdout)
            required = (20, 0) if kind == 'node' else (3, 8)
            if check.returncode == 0 and match and tuple(map(int, match.groups())) >= required:
                return {'argv': argv, 'version': check.stdout.strip()}
        except (OSError, subprocess.TimeoutExpired):
            continue
    if override:
        raise SetupError('Configured ' + kind + ' runtime is not working or is too old')
    return None


def defaults():
    home = Path.home()
    if os.name == 'nt':
        config = Path(os.environ.get('LOCALAPPDATA') or home / 'AppData/Local') / 'AgentHub'
        prefix = config
    else:
        config = Path(os.environ.get('XDG_CONFIG_HOME') or home / '.config') / 'agenthub'
        prefix = Path(os.environ.get('XDG_DATA_HOME') or home / '.local/share') / 'agenthub'
    return prefix.resolve(), config.resolve()


def is_loopback(host):
    return host.lower() in ('127.0.0.1', 'localhost', '::1')
