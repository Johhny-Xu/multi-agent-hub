#!/usr/bin/env python3
"""Install only selected components; all machine configuration stays external."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import secrets
import shutil
import subprocess
import sys
import time
from urllib.parse import urlsplit, urlunsplit
from runtime import SetupError, atomic_json, atomic_text, defaults, is_loopback, read_json, replace_file, run, runtime
import native
import service
import connect


def endpoint(value):
    value = value.strip()
    parsed = urlsplit(value if '://' in value else 'http://' + value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise SetupError('--url must be HTTP(S) or host:port without embedded credentials')
    try:
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError()
    except ValueError:
        raise SetupError('Invalid endpoint port')
    path = parsed.path.rstrip('/') or '/mcp'
    return urlunsplit((parsed.scheme, parsed.netloc, path, '', ''))


def verify_bundle(bundle):
    manifest = read_json(bundle / 'manifest.json')
    if manifest.get('component') not in ('hub', 'plugins', 'both') or not isinstance(manifest.get('files'), dict):
        raise SetupError('Invalid distribution manifest')
    for name, expected in manifest['files'].items():
        relative = Path(name)
        windows = PureWindowsPath(name)
        if relative.is_absolute() or relative.drive or relative.root or windows.drive or windows.root or '..' in relative.parts or '..' in windows.parts:
            raise SetupError('Unsafe path in distribution manifest')
        source = bundle / relative
        try:
            source.resolve().relative_to(bundle.resolve())
        except ValueError:
            raise SetupError('Distribution source escapes its bundle: ' + name)
        if source.is_symlink() or not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != expected:
            raise SetupError('Distribution checksum mismatch: ' + name)
    return manifest


def first_file(candidates):
    return next((Path(path).resolve() for path in candidates if path and Path(path).is_file() and Path(path).suffix.lower() not in ('.cmd', '.bat')), None)


def worker_config(app, node):
    """Discover executable filenames only; authentication/config contents stay untouched."""
    if not node:
        node_args = None
    else:
        node_args = node['argv']
    home = Path.home()
    modules = [Path(os.environ.get('APPDATA') or home / 'AppData/Roaming') / 'npm/node_modules',
               home / '.npm-global/lib/node_modules', Path('/usr/local/lib/node_modules'), Path('/usr/lib/node_modules')]
    def module_file(relative):
        return first_file([directory / relative for directory in modules])
    cb = module_file('@tencent-ai/codebuddy-code/bin/codebuddy')
    mimo = module_file('@mimo-ai/cli/bin/mimo')
    mmx = module_file('mmx-cli/dist/mmx.mjs')
    workers = {}
    if cb and node_args:
        for name, profile, extra in [('codebuddy', '.codebuddy', {}), ('codebuddy-cn', '.codebuddy-cn', {'CODEBUDDY_INTERNET_ENVIRONMENT': 'internal'})]:
            workers[name] = {'role': 'CodeBuddy official CLI, explicit standard agent',
                'cli': node_args + [str(cb), '--agent', 'standard', '--tools', 'Read', '--allowedTools', 'Read', '--permission-mode', 'acceptEdits', '-p', '{task}'],
                'model_arg': '--model', 'models': {'default': 'deepseek-v4.1-flash'}, 'async_default': True,
                'env': dict(CODEBUDDY_CONFIG_DIR=str(home / profile), DISABLE_AUTOUPDATER='1', **extra)}
    if mimo and node_args:
        workers['mimocode'] = {'role': 'MiMo official CLI', 'cli': node_args + [str(mimo), 'run', '--pure', '{task}'], 'model_arg': '--model',
            'models': {'default': 'xiaomi/mimo-v2.6-flash', '26f': 'xiaomi/mimo-v2.6-flash', 'v2.6f': 'xiaomi/mimo-v2.6-flash'}, 'async_default': True}
    if mmx and node_args:
        workers['minimaxcode'] = {'role': 'MiniMax official text CLI', 'cli': node_args + [str(mmx), 'text', 'chat', '--message', '{task}', '--output', 'text'],
            'model_arg': '--model', 'models': {'default': 'MiniMax-M3.1-Flash-Preview'}, 'async_default': True}
    for name, commands, args, model in [('github-copilot', ('copilot.exe', 'copilot'), ['--silent', '-p', '{task}'], 'auto'),
                                       ('antigravity', ('agy.exe', 'agy'), ['--print-timeout', '60s', '-p', '{task}'], 'gemini-3.8-flash-medium')]:
        cli = first_file([shutil.which(command) for command in commands])
        if cli:
            workers[name] = {'role': 'Official installed CLI', 'cli': [str(cli)] + args, 'model_arg': '--model', 'models': {'default': model}, 'async_default': True}
            if name == 'antigravity':
                workers[name]['options_before_prompt'] = True
    zcode = native.discover(node)['zcode']
    if zcode and node_args:
        cli_path = zcode[-1] if zcode[-1].endswith('.cjs') else None
        if cli_path:
            provider = os.environ.get('ZCODE_BUILTIN_PROVIDER_CONFIG_FILE')
            workers['zcode'] = {'role': 'Official model-checked app-server adapter (read/Q&A)',
                'cli': node_args + [str(app / 'drivers/zcode_rpc.mjs'), '--cli', cli_path, '--task', '{task}'],
                'model_arg': '--model', 'timeout_arg': '--timeout', 'models': {'default': 'GLM-5.3-Flash'}, 'async_default': True,
                **({'env': {'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE': provider}} if provider else {})}
    return {'_comment': 'Detected stable local official entries only. Authentication/model permissions are not verified by installation. No auth files were read or copied.', 'agents': workers}


def configure_payload(app, node, client_path):
    # The distributed plugin is generic. Only this installed copy gets machine
    # paths; native caches therefore contain stable installation paths.
    codex = app / 'integrations/codex/.mcp.json'
    if codex.is_file():
        data = read_json(codex)
        bridge = data['mcpServers']['agenthub']
        bridge['command'] = node['argv'][0]
        bridge['env'] = {'AGENTHUB_CONFIG': str(client_path), 'AGENTHUB_CONNECTION_MODE': 'file'}
        atomic_json(codex, data)
    zcode = app / 'plugins/agenthub-workers/.zcode-plugin/plugin.json'
    if zcode.is_file():
        data = read_json(zcode)
        for bridge in data.get('mcpServers', {}).values():
            bridge['command'] = node['argv'][0]
            bridge['env'] = {'AGENTHUB_CONFIG': str(client_path), 'AGENTHUB_CONNECTION_MODE': 'file'}
        atomic_json(zcode, data)
    marketplace = app / '.zcode-plugin/marketplace.json'
    if marketplace.is_file():
        data = read_json(marketplace)
        for plugin in data.get('plugins', []):
            if plugin.get('name') == 'agenthub-workers':
                # ZCode resolves file-marketplace relative entries against its
                # current cwd. Installed copies must point at the owned payload.
                plugin['source'] = {'source': 'directory', 'path': str(app / 'plugins/agenthub-workers')}
        atomic_json(marketplace, data)


def systemd_unit(prefix, config_dir, python):
    if os.name == 'nt':
        raise SetupError('--systemd-user is available on Linux only')
    def quote(value):
        if '\n' in str(value) or '\r' in str(value):
            raise SetupError('User service paths cannot contain line breaks')
        return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$') + '"'
    command_line = ' '.join(quote(arg) for arg in python['argv'] + [str(prefix / 'packaging/service.py'), 'foreground', '--prefix', str(prefix)])
    return '# AgentHub-managed prefix: ' + str(prefix.resolve()) + '\n[Unit]\nDescription=multi-agent-hub user service\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=' + command_line + '\nRestart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n'


def install(args):
    bundle = Path(args.bundle).resolve()
    manifest = verify_bundle(bundle)
    component = args.component or manifest['component']
    if component != manifest['component'] and manifest['component'] != 'both':
        raise SetupError('This ZIP does not contain the selected component; use the both ZIP')
    if component == 'plugins' and any((args.bind is not None, args.port is not None, args.with_console, args.console_port is not None, args.systemd_user)):
        raise SetupError('Hub bind/port/console/systemd options require --component hub or both; plugins never reconfigure or start a Hub')
    if args.systemd_user and os.name == 'nt':
        raise SetupError('--systemd-user is available on Linux only')
    for port in (args.port, args.console_port):
        if port is not None and not 1 <= port <= 65535:
            raise SetupError('Ports must be between 1 and 65535')
    default_prefix, default_config = defaults()
    prefix = Path(args.prefix or default_prefix).expanduser().resolve()
    prior_path = prefix / 'install.json'
    prior = read_json(prior_path) if prior_path.exists() else None
    config_dir = Path(args.config_dir or (prior.get('config_dir') if prior else None) or default_config).expanduser().resolve()
    app = prefix / 'app'
    if prefix == Path.home().resolve() or app == bundle / 'payload' or prefix == bundle or config_dir == app or app in config_dir.parents:
        raise SetupError('Choose a dedicated installation prefix and external configuration directory')
    if app.exists() and (not prior or prior.get('name') != 'AgentHub'):
        raise SetupError('An unowned app directory exists; choose another --prefix')
    python = runtime('python', args.python)
    if not python:
        raise SetupError('Python 3.8+ is required to install/run Hub: https://www.python.org/downloads/')
    node = runtime('node', args.node)
    if (component in ('plugins', 'both') or args.with_console) and not node:
        raise SetupError('Node.js 20+ is required for plugins/optional console: https://nodejs.org/en/download')
    client_path = config_dir / 'client.json'
    hub_path = config_dir / 'hub.json'
    client = connect.existing_client(client_path)
    hub = read_json(hub_path) if hub_path.exists() else None
    if hub and (not isinstance(hub.get('token'), str) or len(hub['token']) < 32 or '\n' in hub['token'] or '\r' in hub['token']):
        raise SetupError('Existing Hub token must be a single line with at least 32 characters; configuration was preserved')
    if component in ('hub', 'both') and not hub:
        hub = {'bind': args.bind or '127.0.0.1', 'port': args.port if args.port is not None else 8765, 'token': secrets.token_urlsafe(32), 'python': python, 'node': node,
               'with_console': args.with_console, 'console_bind': '127.0.0.1', 'console_port': args.console_port if args.console_port is not None else 8890}
    if hub:
        hub = dict(hub)
        if args.bind:
            hub['bind'] = args.bind
        if args.port:
            hub['port'] = args.port
        if args.with_console:
            hub.update(with_console=True, node=node)
        if args.console_port:
            hub['console_port'] = args.console_port
        if args.python:
            hub['python'] = python
        if not isinstance(hub.get('port'), int) or not 1 <= hub['port'] <= 65535 or not isinstance(hub.get('bind'), str) or not hub['bind'].strip():
            raise SetupError('Invalid Hub bind/port configuration')
    systemd = (prior or {}).get('systemd')
    if args.systemd_user:
        unit_dir = Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config') / 'systemd/user'
        name = 'agenthub-' + hashlib.sha256(str(prefix).encode()).hexdigest()[:12] + '.service'
        systemd = {'name': name, 'path': str(unit_dir / name)}
    if systemd and component in ('hub', 'both'):
        if hub and hub.get('with_console'):
            raise SetupError('--systemd-user supports Hub-only; optional console requires direct process management')
        unit_path = Path(systemd['path'])
        if unit_path.exists():
            service.managed_unit({'systemd': systemd}, prefix)
        if not shutil.which('systemctl'):
            raise SetupError('User systemd is unavailable; no service was installed')
    if component == 'plugins' and not args.url and client is None:
        new_client, connection = connect.prepare(token_path=args.token_file,
            timeout=getattr(args, 'discovery_timeout', 1.5), port=getattr(args, 'discovery_port', 18766))
        url = new_client['url'] if new_client else None
        token = new_client['token'] if new_client else None
    else:
        url = endpoint(args.url) if args.url else (client or {}).get('url') or service.local_url(hub['bind'], hub['port'], '/mcp')
        url = endpoint(url)
        token = None
        if args.token_file:
            token = connect.token_file(args.token_file)
        elif client and endpoint(client.get('url', '')) == url and client.get('token'):
            token = client.get('token', '')
        elif hub and url == service.local_url(hub['bind'], hub['port'], '/mcp'):
            token = hub['token']
        elif client and endpoint(client.get('url', '')) == url:
            token = client.get('token', '')
        elif not is_loopback(urlsplit(url).hostname):
            raise SetupError('Remote/LAN client requires --token-file; an old endpoint token is never reused')
        new_client = {'url': url, 'token': token or ''}
        connection = {'status': 'configured_unverified', 'setup_required': False, 'verified': False, 'url': url}
        if getattr(args, 'verify_connection', False):
            connection = connect.validate_connection(url, new_client['token'])
    pair_local_client = bool(client and not client.get('token') and hub and component in ('hub', 'both') and
                             url == service.local_url(hub['bind'], hub['port'], '/mcp') and token == hub['token'])
    # Validate dependencies/configuration before changing payload or stopping owned services.
    if prior and hub_path.is_file() and component in ('hub', 'both'):
        service.stop(prefix)
    config_dir.mkdir(parents=True, exist_ok=True)
    if os.name != 'nt':
        os.chmod(config_dir, 0o700)
    prefix.mkdir(parents=True, exist_ok=True)
    stamp = str(time.time_ns())
    backup_dir = prefix / 'backups' / stamp
    stage = prefix / ('.app-' + stamp)
    stage.mkdir()
    managed = set(prior.get('payload_files', [])) if prior else set()
    try:
        for relative in managed:
            path = Path(relative)
            windows = PureWindowsPath(relative)
            if path.is_absolute() or path.drive or path.root or windows.drive or windows.root or '..' in path.parts or '..' in windows.parts:
                raise SetupError('Unsafe previous installation manifest')
            source = app / path
            if source.is_file() and not source.is_symlink():
                target = stage / path; target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(source, target)
        selected_files = []
        for name in manifest['files']:
            if not name.startswith('payload/'):
                continue
            relative = name[len('payload/'):]
            is_hub = relative.startswith(('hub/', 'drivers/', 'console/'))
            if component == 'plugins' and is_hub or component == 'hub' and not is_hub:
                continue
            target = stage / relative; target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(bundle / name, target)
            selected_files.append(relative)
        if app.exists():
            # Update selected managed files atomically. Renaming the whole app
            # would fail on Windows when a co-located Hub holds that cwd, and
            # would unnecessarily disturb live components during client updates.
            for relative in selected_files:
                target = app / relative
                if os.path.commonpath([str(target.resolve()), str(app.resolve())]) != str(app.resolve()):
                    raise SetupError('Installed payload path escapes its owned app directory')
            for relative in selected_files:
                target = app / relative
                if target.is_file() and not target.is_symlink():
                    previous = backup_dir / 'app' / relative
                    previous.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(target, previous)
                replace_file(stage / relative, target)
        else:
            stage.rename(app)
        for name in manifest['files']:
            if name.startswith('payload/') or name == 'LICENSE':
                continue
            target = prefix / name; target.parent.mkdir(parents=True, exist_ok=True)
            if target.is_file() and not target.is_symlink():
                previous = backup_dir / 'launchers' / name
                previous.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, previous)
            replace_file(bundle / name, target)
        if new_client is not None and (client is None or args.url or args.token_file or pair_local_client):
            if client_path.exists():
                backup_dir.mkdir(parents=True, exist_ok=True); shutil.copy2(client_path, backup_dir / 'client.json'); os.chmod(backup_dir / 'client.json', 0o600)
            atomic_json(client_path, new_client)
        if component in ('hub', 'both') and hub and (not hub_path.exists() or args.bind or args.port or args.with_console or args.console_port or args.python):
            if hub_path.exists():
                backup_dir.mkdir(parents=True, exist_ok=True); shutil.copy2(hub_path, backup_dir / 'hub.json'); os.chmod(backup_dir / 'hub.json', 0o600)
            atomic_json(hub_path, hub)
        if component in ('hub', 'both') and hub and not (config_dir / 'hub-token.txt').exists():
            atomic_text(config_dir / 'hub-token.txt', hub['token'] + '\n')
        agents = config_dir / 'agents.json'
        if component in ('hub', 'both') and not agents.exists():
            atomic_json(agents, worker_config(app, node))
        if component in ('plugins', 'both'):
            configure_payload(app, node, client_path)
        installed = {'name': 'AgentHub', 'version': manifest['version'], 'prefix': str(prefix), 'config_dir': str(config_dir),
                     'components': sorted(set(prior.get('components', []) if prior else []) | ({'hub', 'plugins'} if component == 'both' else {component})),
                     'payload_files': sorted(managed | set(selected_files)), 'installed_at': time.time(),
                     'management_mode': 'systemd-user' if systemd else 'direct', **({'systemd': systemd} if systemd else {})}
        atomic_json(prior_path, installed)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    registrations = native.register(app, config_dir, node, args.native_hosts, args.project, args.profile,
                                    {'codex': args.codex_home, 'zcode': args.zcode_home, 'dsh': args.dsh_home},
                                    {'codex': args.codex_cli, 'zcode': args.zcode_cli, 'dsh': args.dsh_cli}) if component in ('plugins', 'both') else []
    started = None
    if systemd and component in ('hub', 'both'):
        unit = Path(systemd['path']); unit.parent.mkdir(parents=True, exist_ok=True)
        if unit.exists():
            backup_dir.mkdir(parents=True, exist_ok=True); shutil.copy2(unit, backup_dir / unit.name)
        unit.write_text(systemd_unit(prefix, config_dir, hub['python']), encoding='utf-8')
        if run(['systemctl', '--user', 'daemon-reload']).returncode:
            raise SetupError('User systemd session is unavailable; owned unit saved, no service was started')
        if args.systemd_user and not args.no_start:
            service.systemctl('enable', systemd['name'])
    if component in ('hub', 'both') and not args.no_start:
        started = service.start(prefix)
        if new_client and endpoint(new_client['url']) == endpoint(started['hub_url']) and new_client['token'] == hub['token']:
            connection = connect.validate_connection(new_client['url'], new_client['token'])
    result = {'ok': not any(item['status'] == 'failed' for item in registrations), 'version': manifest['version'], 'component': component,
              'prefix': str(prefix), 'config_dir': str(config_dir), 'client_url': new_client['url'] if new_client else None, 'token_values_printed': False,
              'connection': connection, 'setup_required': connection['setup_required'],
              'native_hosts': registrations, 'started': started, 'backup_created': backup_dir.exists()}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['ok'] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--component', choices=('hub', 'plugins', 'both'))
    for name in ('prefix', 'config-dir', 'token-file', 'project', 'codex-home', 'zcode-home', 'dsh-home'):
        parser.add_argument('--' + name, type=Path)
    for name in ('url', 'bind', 'python', 'node', 'codex-cli', 'zcode-cli', 'dsh-cli'):
        parser.add_argument('--' + name)
    parser.add_argument('--port', type=int)
    parser.add_argument('--console-port', type=int)
    parser.add_argument('--with-console', action='store_true')
    parser.add_argument('--systemd-user', action='store_true')
    parser.add_argument('--no-start', action='store_true')
    parser.add_argument('--verify-connection', action='store_true', help='Verify health and authenticated MCP ping before saving an explicit connection')
    parser.add_argument('--discovery-timeout', type=float, default=1.5)
    parser.add_argument('--discovery-port', type=int, default=18766)
    parser.add_argument('--native-hosts', default='auto')
    parser.add_argument('--profile', default='agenthub-client')
    args = parser.parse_args()
    try:
        return install(args)
    except (SetupError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
