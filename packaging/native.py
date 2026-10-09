"""Register stable client payloads through official host plugin commands."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from runtime import SetupError, atomic_json, atomic_text, read_json, run


def executable(path, node):
    if not path:
        return None
    path = Path(path).expanduser().resolve()
    if not path.is_file() or path.suffix.lower() in ('.cmd', '.bat'):
        return None
    if path.suffix.lower() in ('.js', '.mjs', '.cjs'):
        return node['argv'] + [str(path)] if node else None
    return [str(path)]


def discover(node, overrides=None):
    overrides = overrides or {}
    home = Path.home()
    local = Path(os.environ.get('LOCALAPPDATA') or home / 'AppData/Local')
    candidates = {
        'codex': [shutil.which('codex.exe'), shutil.which('codex')],
        'zcode': [os.environ.get('ZCODE_CLI'), '/opt/ZCode/resources/glm/zcode.cjs', str(home / 'zcode-app/opt/ZCode/resources/glm/zcode.cjs'),
                  'C:/Program Files/ZCode/resources/glm/zcode.cjs', shutil.which('zcode')],
        'dsh': [shutil.which('dsh')],
    }
    candidates['codex'] += [str(path) for path in sorted((local / 'OpenAI/Codex/bin').glob('*/codex.exe'), key=lambda p: p.stat().st_mtime, reverse=True)]
    found = {}
    for name, paths in candidates.items():
        if overrides.get(name):
            paths = [overrides[name]]
        found[name] = next((entry for entry in (executable(path, node) for path in paths) if entry), None)
    if not found['dsh'] and not overrides.get('dsh'):
        exe = local / 'Programs/DeepSeek Harness/DeepSeek Harness.exe'
        if exe.is_file() and (exe.parent / 'resources/app.asar').is_file():
            found['dsh'] = [str(exe), '--expose-internals', str(exe.parent / 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')]
    return found


def backup_files(paths, directory):
    # Only named host configuration files; auth files and entire profiles are
    # deliberately excluded. Backups stay private and outside distributed app.
    directory = Path(directory)
    backups = []
    for index, source in enumerate(paths):
        source = Path(source)
        if source.is_file() and not source.is_symlink():
            directory.mkdir(parents=True, exist_ok=True)
            target = directory / (str(index) + '-' + source.name)
            shutil.copy2(source, target)
            os.chmod(target, 0o600)
            backups.append({'source': str(source), 'backup': str(target)})
    return backups


def command(argv, env, required=True):
    try:
        response = run(argv, env=env, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        if required:
            raise SetupError('Official native registration command failed or timed out; no raw vendor/private output was printed')
        return None
    if response.returncode and required:
        raise SetupError('Official native registration rejected the command (exit ' + str(response.returncode) + '); inspect host installation/version')
    return response


def contains_plugin(value):
    if isinstance(value, dict):
        if value.get('name') == 'agenthub-workers' or value.get('id') == 'agenthub-workers':
            return True
        return any(contains_plugin(child) for child in value.values())
    return isinstance(value, list) and any(contains_plugin(child) for child in value)


def install_codex_agents(module, workspace, plugin, node, config_dir, backup):
    """Update only routing files whose last installed bytes are still owned."""
    writes, changes = module.plan(workspace, plugin, node, separate_plugin=True)
    changes = [change for change in changes if '/agents/' in Path(change['path']).as_posix()
               or change['path'].endswith('agenthub.config.fragment.toml')]
    state_path = Path(config_dir) / 'native-projects.json'
    state = read_json(state_path) if state_path.exists() else {'projects': {}}
    projects = state.get('projects')
    if not isinstance(projects, dict):
        raise SetupError('Invalid native routing ownership manifest; project files were preserved')
    key = str(Path(workspace).resolve())
    project_state = projects.get(key, {})
    if not isinstance(project_state, dict):
        raise SetupError('Invalid native routing ownership manifest; project files were preserved')
    prior = project_state.get('files', {})
    if not isinstance(prior, dict):
        raise SetupError('Invalid native routing ownership manifest; project files were preserved')
    updates = []
    for change in changes:
        if change['action'] != 'conflict':
            continue
        target = Path(change['path'])
        if target.is_symlink() or not target.is_file() or prior.get(str(target)) != hashlib.sha256(target.read_bytes()).hexdigest():
            raise SetupError('A user-modified routing file was preserved: ' + target.name)
        updates.append(target)
    # All conflicting files are checked before any mutation. Existing host/user
    # agent definitions have no ownership digest and can never be overwritten.
    backup_files(updates, Path(backup) / 'project')
    module.apply(writes, [change for change in changes if change['action'] != 'conflict'])
    for target in updates:
        if prior.get(str(target)) != hashlib.sha256(target.read_bytes()).hexdigest():
            raise SetupError('A routing file changed during installation and was preserved: ' + target.name)
        atomic_text(target, writes[target].decode('utf-8'))
    projects[key] = {'files': {change['path']: hashlib.sha256(writes[Path(change['path'])]).hexdigest() for change in changes}}
    atomic_json(state_path, state)
    return len(updates)


def install_zcode_plugin(argv, env, app, backup):
    """Refresh only this installation's plugin through the official CLI."""
    identifier = 'agenthub-workers@agenthub-local'
    manifest = Path(app) / '.zcode-plugin/marketplace.json'
    listing = json.loads(command(argv + ['plugins', 'list', '--json'], env).stdout)
    marketplaces = json.loads(command(argv + ['plugins', 'marketplace', 'list', '--json'], env).stdout)
    if not isinstance(listing, list) or not isinstance(marketplaces, list):
        raise SetupError('Unexpected ZCode registration response; existing plugins were preserved')
    existing = next((item for item in listing if isinstance(item, dict) and item.get('id') == identifier), None)
    if existing:
        market = next((item for item in marketplaces if isinstance(item, dict) and item.get('id') == 'agenthub-local'), None)
        source = market.get('source', {}) if market else {}
        if not isinstance(source, dict):
            raise SetupError('Unexpected ZCode marketplace source; existing plugin was preserved')
        expected = manifest if source.get('source') == 'file' else Path(app) if source.get('source') == 'directory' else None
        if expected is None or not isinstance(source.get('path'), str) or Path(source['path']).resolve() != expected.resolve():
            raise SetupError('Existing multi-agent-hub marketplace belongs to another installation; plugin was preserved')
        atomic_json(Path(backup) / 'agenthub-registration.json', {
            'plugin': {key: existing.get(key) for key in ('id', 'name', 'version', 'enabled', 'rootPath', 'manifestPath')},
            'marketplace': {'id': market['id'], 'source': source},
        })
    # ZCode's directory resolver does not discover .zcode-plugin marketplaces.
    command(argv + ['plugins', 'marketplace', 'add', str(manifest)], env)
    if existing:
        # install/update otherwise reuses stale code at the same version. The
        # public CLI keeps persistent plugin data with this explicit option.
        command(argv + ['plugins', 'uninstall', identifier, '--force', '--keep-data'], env)
    command(argv + ['plugins', 'install', identifier], env)
    if existing and existing.get('enabled') is False:
        command(argv + ['plugins', 'disable', identifier], env)
    listing = command(argv + ['plugins', 'list', '--json'], env)
    if not contains_plugin(json.loads(listing.stdout)):
        raise SetupError('ZCode did not report the installed multi-agent-hub plugin')


def register(app, config_dir, node, selected='auto', project=None, profile='agenthub-client', homes=None, overrides=None):
    app = Path(app); config_dir = Path(config_dir); homes = homes or {}
    hosts = discover(node, overrides)
    requested = list(hosts) if selected == 'auto' else [] if selected == 'none' else selected.split(',')
    if any(name not in hosts for name in requested):
        raise SetupError('--native-hosts must be auto, none, or a comma-separated codex,zcode,dsh list')
    records = []
    for name in requested:
        argv = hosts[name]
        if not argv:
            explicit = bool((overrides or {}).get(name))
            records.append({'host': name, 'status': 'failed' if explicit else 'not_installed',
                            **({'error': 'Configured native CLI was not found or is not an executable entry'} if explicit else {})})
            continue
        env = dict(os.environ, AGENTHUB_CONFIG=str(config_dir / 'client.json'), AGENTHUB_CONNECTION_MODE='file')
        home = Path(homes.get(name) or env.get({'codex': 'CODEX_HOME', 'zcode': 'ZCODE_STORAGE_DIR', 'dsh': 'DSH_HOME'}[name]) or Path.home() / ('.zcode' if name == 'zcode' else '.' + name)).resolve()
        home.mkdir(parents=True, exist_ok=True)
        env[{'codex': 'CODEX_HOME', 'zcode': 'ZCODE_STORAGE_DIR', 'dsh': 'DSH_HOME'}[name]] = str(home)
        backup = config_dir / 'native-backups' / (str(time.time_ns()) + '-' + name)
        paths = [home / 'config.toml', home / 'plugins/marketplaces.json', home / 'plugins/installed_plugins.json'] if name == 'codex' else [home / 'cli/plugins/known_marketplaces.json', home / 'cli/plugins/installed_plugins.json'] if name == 'zcode' else [home / 'profiles' / profile / 'package.json', home / 'profiles' / profile / 'cordis.patch.yml']
        backups = backup_files(paths, backup)
        try:
            if name == 'codex':
                if sys.version_info < (3, 11):
                    raise SetupError('Codex native agent installation requires Python 3.11+: https://www.python.org/downloads/')
                # A plugin marketplace owns its own stable source directory.
                command(argv + ['plugin', 'marketplace', 'add', str(app), '--json'], env, required=False)
                command(argv + ['plugin', 'add', 'agenthub-workers@agenthub-local', '--json'], env)
                listing = command(argv + ['plugin', 'list', '--json'], env)
                if not contains_plugin(json.loads(listing.stdout)):
                    raise SetupError('Codex did not report the installed multi-agent-hub plugin')
                workspace = Path(project).resolve() if project else app.parent / 'workspace'
                workspace.mkdir(parents=True, exist_ok=True)
                installer_path = app / 'integrations/codex/install.py'
                spec = importlib.util.spec_from_file_location('agenthub_codex_installer', installer_path)
                module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
                install_codex_agents(module, workspace, app / 'integrations/codex', node['argv'][0], config_dir, backup)
            elif name == 'zcode':
                install_zcode_plugin(argv, env, app, backup)
            else:
                env['ELECTRON_RUN_AS_NODE'] = '1'
                package = home / 'profiles' / profile / 'package.json'
                if not package.exists():
                    command(argv + ['--profile', profile, '--from-default-profile', 'web', '--dump-config'], env)
                command(argv + ['plugin', '--profile', profile, 'add', 'file:' + (app / 'integrations/dsh').as_posix(), '--ignore-scripts'], env)
                spec = importlib.util.spec_from_file_location('agenthub_dsh_installer', app / 'integrations/dsh/install-dsh.py')
                module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
                module.prepare_profile(home, profile, config_file=config_dir / 'client.json', command=node['argv'][0])
                if not package.is_file() or 'dsh-plugin-multi-agent-hub' not in json.loads(package.read_text(encoding='utf-8')).get('dependencies', {}):
                    raise SetupError('DSH did not link the multi-agent-hub bundle')
            records.append({'host': name, 'status': 'registered', 'configuration_backups': len(backups),
                            'project': str(workspace) if name == 'codex' else None, 'profile': profile if name == 'dsh' else None})
        except (SetupError, OSError, ValueError, ImportError) as error:
            records.append({'host': name, 'status': 'failed', 'error': str(error), 'configuration_backups': len(backups)})
    return records
