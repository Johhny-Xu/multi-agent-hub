#!/usr/bin/env python3
"""Install the native Antigravity plugin without changing host preferences."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid

SOURCE = Path(__file__).resolve().parent
NAME = 'multi-agent-hub'
STATE_NAME = '.multi-agent-hub-install.json'
MCP_FILES = ('server.mjs', 'hub.mjs', 'ask.mjs', 'login.mjs', 'config.mjs', 'discovery.mjs')
WORKERS = ('antigravity', 'codebuddy', 'codebuddy-cn', 'github-copilot',
           'mimocode', 'minimaxcode', 'traecode', 'zcode', 'codearts',
           'opencode', 'cline')
SKILLS = ('hub-dispatch', 'hub-status', 'hub-discover', 'hub-login')


def digest(content):
    return hashlib.sha256(content).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def no_duplicates(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('Duplicate JSON key in plugin metadata')
        value[key] = item
    return value


def read_object(path):
    try:
        data = json.loads(path.read_text(encoding='utf-8-sig'), object_pairs_hook=no_duplicates)
    except json.JSONDecodeError:
        raise ValueError('Invalid JSON in plugin metadata: ' + path.name) from None
    if not isinstance(data, dict):
        raise ValueError('Plugin metadata must be a JSON object: ' + path.name)
    return data


def safe_path(value):
    """Check every existing component before resolving it, including Windows junctions."""
    path = Path(os.path.abspath(Path(value).expanduser()))
    for ancestor in (path, *path.parents):
        if ancestor.exists() or ancestor.is_symlink():
            info = ancestor.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400):
                raise ValueError('Refusing a symbolic link or reparse path: ' + str(ancestor))
    return path


def is_within(path, parent):
    """Containment without Path.is_relative_to (introduced in Python 3.9)."""
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def node_runtime(command):
    resolved = shutil.which(str(command)) or str(command)
    path = Path(resolved).expanduser()
    if not path.is_file() or path.suffix.lower() in ('.cmd', '.bat', '.ps1'):
        raise ValueError('Node.js 20 or newer is required; supply --node with the executable')
    process = subprocess.run([str(path), '--version'], capture_output=True, text=True,
                             stdin=subprocess.DEVNULL, timeout=10)
    match = re.fullmatch(r'v(\d+)\.\d+\.\d+\s*', process.stdout)
    if process.returncode or not match or int(match[1]) < 20:
        raise ValueError('Node.js 20 or newer is required')
    return str(path.resolve())


def package_files(source):
    """Use a distribution allowlist: SDK environments and private settings are excluded."""
    required = ('plugin.json', 'mcp_config.json', 'native.py', 'README.md', 'assets/icon.svg')
    required += tuple('mcp/' + name for name in MCP_FILES)
    required += tuple('agents/hub-' + name + '.md' for name in WORKERS)
    required += tuple('skills/' + name + '/SKILL.md' for name in SKILLS)
    files = {}
    for name in required:
        path = safe_path(source / name)
        if not path.is_file():
            raise ValueError('The Antigravity plugin bundle is incomplete: ' + name)
        files[name] = path.read_bytes()
    manifest = read_object(source / 'plugin.json')
    if manifest.get('name') != NAME or not isinstance(manifest.get('version'), str):
        raise ValueError('Unexpected Antigravity plugin identity')
    return files, manifest


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.' + path.name + '.', delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(content)
    try:
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def install(home, source, config_file, *, node='node', backup_dir=None, apply=False):
    """Plan/apply a native plugin at ``home/plugins/multi-agent-hub``.

    ``home`` is Antigravity's customization root (normally ~/.gemini/config).
    ``config_file`` is an absolute external client.json path; its contents are
    never read. The caller owns creation of that connection file. No model call,
    login, host process, preference change, SDK installation or reload occurs.
    """
    if not Path(config_file).expanduser().is_absolute():
        raise ValueError('Hub configuration must be an absolute external path')
    home = safe_path(home)
    source = safe_path(source)
    target = safe_path(home / 'plugins' / NAME)
    config = safe_path(config_file)
    if home == home.parent or home == Path.home().absolute():
        raise ValueError('Choose a dedicated Antigravity customization root')
    if target == source or is_within(target, source) or is_within(source, target):
        raise ValueError('The source bundle and installed plugin must be separate directories')
    distribution_root = source.parent.parent if source.parent.name == 'integrations' else source
    if is_within(config, distribution_root) or is_within(config, target):
        raise ValueError('Hub credentials must stay outside the source and installed plugin bundles')
    if config.exists() and not config.is_file():
        raise ValueError('Hub configuration must be a file path')
    for path in (home, source, target):
        if path.exists() and not path.is_dir():
            raise ValueError('Expected a directory: ' + str(path))
    node = node_runtime(node)
    contents, manifest = package_files(source)
    # Absolute launch paths work in both Windows and Linux and do not depend on
    # the client version's environment interpolation or working directory.
    contents['mcp_config.json'] = json_bytes({'mcpServers': {NAME: {
        'command': node,
        'args': [str(target / 'mcp' / 'server.mjs')],
        'env': {'AGENTHUB_CONFIG': str(config), 'AGENTHUB_CONNECTION_MODE': 'file'},
    }}})
    state_path = safe_path(target / STATE_NAME)
    has_state = state_path.exists()
    previous = read_object(state_path) if has_state else {}
    if has_state and (previous.get('owner') != NAME or previous.get('format') != 1):
        raise ValueError('Invalid multi-agent-hub ownership manifest')
    old_files = previous.get('files', {})
    if not isinstance(old_files, dict) or any(not isinstance(name, str) or not isinstance(value, str)
            or not re.fullmatch(r'[0-9a-f]{64}', value) for name, value in old_files.items()):
        raise ValueError('Invalid file hashes in ownership manifest')
    writes = {}
    conflicts = []
    for name, content in contents.items():
        path = safe_path(target / name)
        if path.exists():
            if not path.is_file():
                conflicts.append(str(path))
                continue
            current = path.read_bytes()
            if current != content and old_files.get(name) != digest(current):
                conflicts.append(str(path))
        writes[path] = content
    state = {'format': 1, 'owner': NAME, 'version': manifest['version'],
             'files': {name: digest(content) for name, content in contents.items()}}
    writes[state_path] = json_bytes(state)
    before = {path: path.read_bytes() if path.exists() else None for path in writes}
    changes = [{'path': str(path), 'action': 'unchanged' if before[path] == content else
                'create' if before[path] is None else 'update'} for path, content in writes.items()]
    changed = [path for path in writes if before[path] != writes[path]]
    report = {'ok': not conflicts, 'mode': 'apply' if apply else 'dry-run', 'applied': False,
              'version': manifest['version'], 'target': str(target), 'plugin_directory': str(target),
              'home': str(home), 'agents': len(WORKERS), 'skills': len(SKILLS), 'mcp_servers': 1,
              'changes': changes, 'files': changes, 'conflicts': conflicts,
              'backup_directory': None, 'restart_required': bool(changed),
              'loaded': False,
              'verification': 'Restart Antigravity and inspect Customizations; confirm CLI discovery with an actual plugin tool or subagent call. CLI plugin list only lists imported plugins.'}
    if not apply or conflicts or not changed:
        return report
    backup_root = safe_path(backup_dir or home / '.multi-agent-hub-backups')
    if is_within(backup_root, target) or is_within(backup_root, source):
        raise ValueError('Backups must stay outside the source and installed plugin bundles')
    backup = backup_root / (str(time.time_ns()) + '-' + uuid.uuid4().hex[:8])
    backup.mkdir(parents=True, exist_ok=False)
    os.chmod(backup, 0o700)
    records = []
    for index, path in enumerate(changed):
        record = {'path': str(path), 'existed': before[path] is not None}
        if before[path] is not None:
            saved = backup / (str(index) + '-' + path.name)
            atomic_write(saved, before[path])
            record.update(backup=str(saved), sha256=digest(before[path]))
        records.append(record)
    atomic_write(backup / 'manifest.json', json_bytes({'owner': NAME, 'files': records}))
    installed = []
    try:
        for path in changed:
            safe_path(path)
            current = path.read_bytes() if path.exists() else None
            if current != before[path]:
                raise ValueError('Files changed during installation; concurrent edits were preserved')
            atomic_write(path, writes[path])
            installed.append(path)
    except (OSError, ValueError):
        # Restore only our own writes. A concurrent editor's new bytes are kept.
        for path in reversed(installed):
            safe_path(path)
            if path.is_file() and path.read_bytes() == writes[path]:
                if before[path] is None:
                    path.unlink()
                else:
                    atomic_write(path, before[path])
        raise
    report.update(applied=True, backup_directory=str(backup))
    return report


def inspect(home):
    """Report installed files and ownership integrity; this does not prove host loading."""
    target = safe_path(safe_path(home) / 'plugins' / NAME)
    manifest_path = safe_path(target / 'plugin.json')
    if not manifest_path.is_file():
        return {'installed': False, 'target': str(target), 'loaded': False}
    manifest = read_object(manifest_path)
    state_path = safe_path(target / STATE_NAME)
    state = read_object(state_path) if state_path.exists() else {}
    tracked = state.get('files', {})
    modified = []
    if state.get('owner') == NAME and isinstance(tracked, dict):
        for name, expected in tracked.items():
            if not isinstance(name, str) or '\\' in name or ':' in name or name.startswith('/') or '..' in Path(name).parts:
                raise ValueError('Invalid relative path in ownership manifest')
            path = safe_path(target / name)
            if not path.is_file() or digest(path.read_bytes()) != expected:
                modified.append(name)
    return {'installed': manifest.get('name') == NAME, 'target': str(target),
            'version': manifest.get('version'), 'owned': state.get('owner') == NAME,
            'agents': len(list((target / 'agents').glob('*.md'))),
            'skills': len(list((target / 'skills').glob('*/SKILL.md'))),
            'modified': modified, 'loaded': False,
            'verification': 'Disk inventory only; confirm loaded components in Antigravity.'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path.home() / '.gemini' / 'config')
    parser.add_argument('--source', type=Path, default=SOURCE)
    parser.add_argument('--config', type=Path, help='Absolute path to the external Hub client.json')
    parser.add_argument('--node', default='node')
    parser.add_argument('--backup-dir', type=Path)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--dry-run', action='store_true')
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--inspect', action='store_true')
    options = parser.parse_args(argv)
    if not options.inspect and options.config is None:
        parser.error('--config is required with --dry-run or --apply')
    try:
        result = inspect(options.home) if options.inspect else install(
            options.home, options.source, options.config, node=options.node,
            backup_dir=options.backup_dir, apply=options.apply)
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return 0 if result.get('ok', result.get('installed', False)) else 1
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=True), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
