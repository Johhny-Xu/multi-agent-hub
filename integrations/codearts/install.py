#!/usr/bin/env python3
"""Install native CodeArts assets and merge only the multi-agent-hub MCP entry."""
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
VERSION = '0.9.0'
SERVER_NAME = 'multi-agent-hub'
MCP_FILES = ('server.mjs', 'hub.mjs', 'ask.mjs', 'login.mjs', 'config.mjs', 'discovery.mjs')
WORKERS = ('antigravity', 'codebuddy', 'codebuddy-cn', 'github-copilot',
           'mimocode', 'minimaxcode', 'traecode', 'zcode', 'codearts')


def digest(value):
    return hashlib.sha256(value).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def object_digest(value):
    return digest(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())


def safe_path(value):
    path = Path(os.path.abspath(Path(value).expanduser()))
    for ancestor in (path, *path.parents):
        if ancestor.exists() or ancestor.is_symlink():
            info = ancestor.lstat()
            if ancestor.is_symlink() or getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise ValueError('Refusing a symbolic link or reparse path: ' + str(ancestor))
    return path


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON configuration key; existing configuration was preserved')
        result[key] = value
    return result


def mask_comments(raw):
    """Keep character offsets while masking JSONC comments outside strings."""
    result = list(raw)
    index = 0
    quoted = False
    while index < len(raw):
        char = raw[index]
        if quoted:
            if char == '\\':
                index += 2
                continue
            if char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif raw[index:index + 2] == '//':
            end = raw.find('\n', index)
            end = len(raw) if end < 0 else end
            result[index:end] = ' ' * (end - index)
            index = end
            continue
        elif raw[index:index + 2] == '/*':
            end = raw.find('*/', index + 2)
            if end < 0:
                raise ValueError('Unclosed JSONC comment; existing configuration was preserved')
            end += 2
            for pos in range(index, end):
                if raw[pos] not in '\r\n':
                    result[pos] = ' '
            index = end
            continue
        index += 1
    return ''.join(result)


def parse_jsonc(raw):
    clean = mask_comments(raw)
    # Mask trailing commas without modifying strings or source offsets.
    chars = list(clean)
    quoted = False
    index = 0
    while index < len(clean):
        char = clean[index]
        if quoted:
            if char == '\\':
                index += 2
                continue
            if char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char == ',':
            after = index + 1
            while after < len(clean) and clean[after].isspace():
                after += 1
            if after < len(clean) and clean[after] in '}]':
                chars[index] = ' '
        index += 1
    clean = ''.join(chars)
    try:
        value = json.loads(clean, object_pairs_hook=no_duplicates)
    except json.JSONDecodeError as error:
        raise ValueError('Invalid CodeArts JSON/JSONC configuration at line ' + str(error.lineno)) from None
    if not isinstance(value, dict):
        raise ValueError('CodeArts configuration must be a JSON object')
    return value, clean


def object_members(clean, start):
    """Return object member value spans using the standard JSON decoder."""
    decoder = json.JSONDecoder()
    cursor = start + 1
    members = {}
    while True:
        while cursor < len(clean) and (clean[cursor].isspace() or clean[cursor] == ','):
            cursor += 1
        if clean[cursor] == '}':
            return members, cursor
        key, cursor = decoder.raw_decode(clean, cursor)
        while clean[cursor].isspace():
            cursor += 1
        if clean[cursor] != ':':
            raise ValueError('Invalid JSON object')
        cursor += 1
        while clean[cursor].isspace():
            cursor += 1
        begin = cursor
        _, cursor = decoder.raw_decode(clean, cursor)
        members[key] = (begin, cursor)


def set_member(raw, keys, value):
    """Replace one JSONC value; preserve all unrelated bytes and comments."""
    _, clean = parse_jsonc(raw)
    start = len(clean) - len(clean.lstrip())
    members, end = object_members(clean, start)
    key = keys[0]
    if key in members:
        begin, finish = members[key]
        replacement = (set_member(raw[begin:finish], keys[1:], value) if len(keys) > 1
                       else json.dumps(value, ensure_ascii=False, indent=2))
        return raw[:begin] + replacement + raw[finish:]
    new_value = value
    for nested in reversed(keys[1:]):
        new_value = {nested: new_value}
    addition = '  ' + json.dumps(key) + ': ' + json.dumps(new_value, ensure_ascii=False, indent=2) + '\n'
    if members:
        last_end = list(members.values())[-1][1]
        # Preserve an existing trailing comma and comments. If absent, insert
        # the separator directly after the last value, before its comment.
        if ',' not in mask_comments(raw)[last_end:end]:
            raw = raw[:last_end] + ',' + raw[last_end:]
            end += 1
    return raw[:end] + '\n' + addition + raw[end:]


def node_runtime(command):
    path = shutil.which(str(command)) or str(command)
    if not Path(path).is_file():
        raise ValueError('Node.js 20 or newer is required; supply --node')
    result = subprocess.run([path, '--version'], capture_output=True, text=True,
                            stdin=subprocess.DEVNULL, timeout=10)
    match = re.fullmatch(r'v(\d+)\.\d+\.\d+\s*', result.stdout)
    if result.returncode or not match or int(match[1]) < 20:
        raise ValueError('Node.js 20 or newer is required')
    return str(Path(path).resolve())


def package_files():
    files = [SOURCE / name for name in ('package.json', 'plugin.js', 'install.py', 'README.md')]
    files += [SOURCE / 'mcp' / name for name in MCP_FILES]
    files += sorted((SOURCE / 'agents').glob('*.md'))
    files += sorted((SOURCE / 'commands').glob('*.md'))
    files += sorted((SOURCE / 'skills').rglob('SKILL.md'))
    if any(not item.is_file() for item in files) or len(list((SOURCE / 'agents').glob('*.md'))) != len(WORKERS):
        raise ValueError('The CodeArts plugin bundle is incomplete')
    return files


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.' + path.name + '.', delete=False) as stream:
        temp = Path(stream.name)
        stream.write(content)
    try:
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def install(home, plugin_dir, config_file, *, node='node', targets=('ide', 'cli'),
            ide_settings=None, cli_settings=None, backup_dir=None, apply=False):
    """Return a safe plan, or install it. No model calls or host restarts occur.

    home is the selected .codeartsdoer directory, NOT the user's home directory.
    plugin_dir is the stable bundle destination. config_file stays external and
    is referenced by path only; its contents are never read by this installer.
    """
    home = safe_path(home)
    plugin = safe_path(plugin_dir)
    config = safe_path(config_file)
    if home == Path.home().resolve() or home == home.parent:
        raise ValueError('Select a dedicated .codeartsdoer directory, not a home or filesystem root')
    if config.is_relative_to(plugin) or config.is_relative_to(SOURCE):
        raise ValueError('Hub credentials must stay outside the distributed plugin bundle')
    if not config.is_absolute():
        raise ValueError('Hub configuration must be an absolute external path')
    targets = tuple(targets)
    if not targets or any(item not in ('ide', 'cli') for item in targets):
        raise ValueError('targets must contain ide, cli, or both')
    node = node_runtime(node)
    state_path = safe_path(home / '.multi-agent-hub-install.json')
    has_state = state_path.exists()
    previous = json.loads(state_path.read_text(encoding='utf-8')) if has_state else {}
    if not isinstance(previous, dict) or (has_state and previous.get('owner') != SERVER_NAME):
        raise ValueError('Invalid multi-agent-hub ownership manifest')
    old_files = previous.get('files', {})
    old_entries = previous.get('mcp_entries', {})
    if not isinstance(old_files, dict) or not isinstance(old_entries, dict):
        raise ValueError('Invalid multi-agent-hub ownership manifest')
    files = package_files()
    writes = {}
    owned_files = dict(old_files)
    entries = dict(old_entries)
    conflicts = []

    def add_file(target, content):
        target = safe_path(target)
        if not (target.is_relative_to(home) or target.is_relative_to(plugin)):
            raise ValueError('Native asset escapes its selected installation directory')
        if target.exists() and (not target.is_file() or (target.read_bytes() != content and
                old_files.get(str(target)) != digest(target.read_bytes()))):
            conflicts.append(str(target))
        writes[target] = content
        owned_files[str(target)] = digest(content)

    # Record ownership even when invoked from an already staged stable bundle;
    # later upgrades from a new source directory can then verify those bytes.
    for source in files:
        add_file(plugin / source.relative_to(SOURCE), source.read_bytes())
    # A tiny native entry delegates to the stable bundle. It is loaded by both
    # CodeArts IDE and CLI through their official .codeartsdoer/plugin mechanism.
    add_file(home / 'plugins' / 'multi-agent-hub.js',
             ('export { MultiAgentHubPlugin } from ' + json.dumps((plugin / 'plugin.js').as_uri()) + ';\n').encode())
    for category in ('agents', 'commands', 'skills'):
        for source in (SOURCE / category).rglob('*'):
            if source.is_file():
                add_file(home / category / source.relative_to(SOURCE / category), source.read_bytes())

    environment = {'AGENTHUB_CONFIG': str(config), 'AGENTHUB_CONNECTION_MODE': 'file'}
    registrations = []
    for kind in dict.fromkeys(targets):
        if kind == 'cli':
            path = safe_path(cli_settings or (home / ('codearts_cli.jsonc' if (home / 'codearts_cli.jsonc').exists()
                                 or not (home / 'codearts_cli.json').exists() else 'codearts_cli.json')))
            top = 'mcp'
            entry = {'type': 'local', 'command': [node, str(plugin / 'mcp/server.mjs')],
                     'environment': environment, 'enabled': True, 'timeout': 600000}
        else:
            path = safe_path(ide_settings or home / 'mcp/mcp_settings.json')
            top = 'mcpServers'
            entry = {'command': node, 'args': [str(plugin / 'mcp/server.mjs')],
                     'env': environment, 'disabled': False, 'timeout': 600}
        if path == config or path.is_relative_to(plugin) or path.is_relative_to(SOURCE):
            raise ValueError('Host MCP settings must be separate from the plugin bundle and Hub credentials')
        raw = path.read_text(encoding='utf-8-sig') if path.exists() else '{}\n'
        data, _ = parse_jsonc(raw)
        registry = data.get(top, {})
        if not isinstance(registry, dict):
            raise ValueError('Expected object for CodeArts ' + top + '; configuration was preserved')
        prior = registry.get(SERVER_NAME)
        entry_key = str(path) + '#' + top + '/' + SERVER_NAME
        if SERVER_NAME in registry and prior != entry and old_entries.get(entry_key) != object_digest(prior):
            conflicts.append(str(path) + ' [' + SERVER_NAME + ']')
        if prior == entry:
            content = path.read_bytes()
        else:
            content = set_member(raw, (top, SERVER_NAME), entry).encode('utf-8')
            parsed, _ = parse_jsonc(content.decode())
            expected = dict(data)
            expected[top] = dict(registry, **{SERVER_NAME: entry})
            if parsed != expected:
                raise ValueError('MCP merge validation failed; configuration was preserved')
        writes[path] = content
        entries[entry_key] = object_digest(entry)
        registrations.append({'target': kind, 'path': str(path), 'key': top + '.' + SERVER_NAME})

    state = {'owner': SERVER_NAME, 'version': VERSION, 'plugin_directory': str(plugin),
             'files': owned_files, 'mcp_entries': entries}
    writes[state_path] = json_bytes(state)
    snapshot = {path: path.read_bytes() if path.exists() else None for path in writes}
    changes = [{'path': str(path), 'action': 'unchanged' if snapshot[path] == content else
                'create' if snapshot[path] is None else 'update'} for path, content in writes.items()]
    report = {'ok': not conflicts, 'mode': 'apply' if apply else 'dry-run', 'version': VERSION,
              'plugin_directory': str(plugin), 'home': str(home), 'registrations': registrations,
              'agents': len(WORKERS), 'commands': 3, 'skills': 1, 'native_hooks': 1,
              'files': changes, 'conflicts': conflicts, 'backup_directory': None,
              'requires_reload': bool(any(item['action'] != 'unchanged' for item in changes))}
    if not apply or conflicts:
        return report
    changed = [path for path in writes if snapshot[path] != writes[path]]
    if not changed:
        return report
    backup_root = safe_path(backup_dir or home / '.multi-agent-hub-backups')
    if backup_root.is_relative_to(plugin) or backup_root.is_relative_to(SOURCE):
        raise ValueError('Configuration backups must stay outside the distributed plugin bundle')
    backup = backup_root / (str(time.time_ns()) + '-' + uuid.uuid4().hex[:8])
    backup.mkdir(parents=True, exist_ok=False)
    os.chmod(backup, 0o700)
    backup_records = []
    for index, path in enumerate(changed):
        before = snapshot[path]
        if before is not None:
            target = backup / (str(index) + '-' + path.name)
            atomic_write(target, before)
            backup_records.append({'source': str(path), 'backup': str(target), 'sha256': digest(before)})
    atomic_write(backup / 'manifest.json', json_bytes({'files': backup_records}))
    installed = []
    try:
        for path in changed:
            safe_path(path)
            now = path.read_bytes() if path.exists() else None
            if now != snapshot[path]:
                raise ValueError('Configuration changed during installation; concurrent edits were preserved')
            atomic_write(path, writes[path])
            installed.append(path)
    except (OSError, ValueError):
        for path in reversed(installed):
            if path.is_file() and path.read_bytes() == writes[path]:
                if snapshot[path] is None:
                    path.unlink()
                else:
                    atomic_write(path, snapshot[path])
        raise
    report['backup_directory'] = str(backup)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, required=True, help='Selected user/project .codeartsdoer directory')
    parser.add_argument('--plugin-dir', type=Path, default=SOURCE)
    parser.add_argument('--config', type=Path, required=True, help='External multi-agent-hub client.json path')
    parser.add_argument('--target', choices=('ide', 'cli', 'both'), default='both')
    parser.add_argument('--ide-settings', type=Path)
    parser.add_argument('--cli-settings', type=Path)
    parser.add_argument('--backup-dir', type=Path)
    parser.add_argument('--node', default='node')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--dry-run', action='store_true')
    mode.add_argument('--apply', action='store_true')
    options = parser.parse_args(argv)
    try:
        result = install(options.home, options.plugin_dir, options.config, node=options.node,
                         targets=('ide', 'cli') if options.target == 'both' else (options.target,),
                         ide_settings=options.ide_settings, cli_settings=options.cli_settings,
                         backup_dir=options.backup_dir, apply=options.apply)
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return 0 if result['ok'] else 1
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=True), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
