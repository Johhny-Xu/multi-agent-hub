#!/usr/bin/env python3
"""Start/stop only services owned by this external AgentHub installation."""
import argparse
import json
import os
from pathlib import Path
import signal
import re
import socket
import subprocess
import sys
import time
from urllib.request import urlopen
from runtime import SetupError, atomic_json, read_json, run


def identity(pid):
    if os.name == 'nt':
        result = run(['powershell.exe', '-NoProfile', '-Command',
                      '$p=Get-Process -Id ' + str(int(pid)) + ' -ErrorAction SilentlyContinue; if($p){$p.StartTime.ToUniversalTime().Ticks.ToString()}'], timeout=5)
        value = result.stdout.strip()
        return value if value.isdigit() else None
    try:
        text = Path('/proc/' + str(int(pid)) + '/stat').read_text()
        fields = text[text.rfind(')') + 2:].split()
        return fields[19] if fields[0] != 'Z' else None
    except (OSError, IndexError, ValueError):
        return None


def command_matches(pid, entry):
    if os.name == 'nt':
        try:
            result = run(['powershell.exe', '-NoProfile', '-Command',
                          '(Get-CimInstance Win32_Process -Filter "ProcessId = ' + str(int(pid)) + '").CommandLine'], timeout=5)
            return str(entry).lower() in result.stdout.lower()
        except (OSError, subprocess.TimeoutExpired):
            return False
    try:
        return os.fsencode(str(entry)) in Path('/proc/' + str(int(pid)) + '/cmdline').read_bytes().split(b'\0')
    except OSError:
        return False


def owns_listener(pid, port):
    if os.name == 'nt':
        try:
            result = run(['powershell.exe', '-NoProfile', '-Command',
                          'Get-NetTCPConnection -State Listen -LocalPort ' + str(int(port)) + ' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess'], timeout=5)
            return str(pid) in result.stdout.split()
        except (OSError, subprocess.TimeoutExpired):
            return False
    try:
        inodes = set()
        for name in ('tcp', 'tcp6'):
            for row in Path('/proc/net/' + name).read_text().splitlines()[1:]:
                columns = row.split()
                if columns[3] == '0A' and int(columns[1].split(':')[1], 16) == port:
                    inodes.add(columns[9])
        for fd in Path('/proc/' + str(pid) + '/fd').iterdir():
            try:
                link = os.readlink(fd)
                if link.startswith('socket:[') and link[8:-1] in inodes:
                    return True
            except OSError:
                pass
    except (OSError, ValueError, IndexError):
        pass
    return False


def load(prefix):
    install = read_json(Path(prefix) / 'install.json')
    config_dir = Path(install['config_dir']).resolve()
    settings = read_json(config_dir / 'hub.json')
    return install, config_dir, settings


def valid_record(path, prefix):
    if not path.is_file():
        return None
    record = read_json(path)
    if record.get('prefix') != str(Path(prefix).resolve()) or not isinstance(record.get('pid'), int) or not record.get('identity'):
        raise SetupError('Invalid owned process record; refusing to stop another process')
    return record


def running(record):
    return bool(record and identity(record['pid']) == record['identity'] and command_matches(record['pid'], record['entry']))


def stop_record(path, prefix):
    record = valid_record(path, prefix)
    if not record:
        return
    if running(record):
        if os.name == 'nt':
            run(['taskkill.exe', '/PID', str(record['pid']), '/T', '/F'], timeout=10)
        else:
            try:
                (os.killpg if os.getpgid(record['pid']) == record['pid'] else os.kill)(record['pid'], signal.SIGTERM)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 3
            while identity(record['pid']) == record['identity'] and time.monotonic() < deadline:
                time.sleep(.05)
            if identity(record['pid']) == record['identity']:
                try:
                    (os.killpg if os.getpgid(record['pid']) == record['pid'] else os.kill)(record['pid'], signal.SIGKILL)
                except ProcessLookupError:
                    pass
    path.unlink(missing_ok=True) if sys.version_info >= (3, 8) else path.unlink()


def environment(config_dir, settings):
    env = dict(os.environ)
    # Imported shell variables must not redirect this installation's own state.
    env.update(HUB_TOKEN=settings['token'], HUB_AGENTS_FILE=str(config_dir / 'agents.json'),
               HUB_STATE_DIR=str(config_dir / 'state'), HUB_RESULTS_DIR=str(config_dir / 'state/results'),
               AGENTHUB_CONFIG=str(config_dir / 'client.json'),
               HUBCONSOLE_HOST=settings.get('console_bind', '127.0.0.1'),
               HUBCONSOLE_PORT=str(settings.get('console_port', 8890)),
               HUBCONSOLE_DATA_DIR=str(config_dir / 'console-state'),
               HUBCONSOLE_SERVER_URL=local_url(settings['bind'], settings['port'], '/mcp'),
               HUBCONSOLE_SERVER_TOKEN=settings['token'])
    return env


def managed_unit(install, prefix):
    unit = install.get('systemd')
    if not unit:
        return None
    if os.name == 'nt' or not isinstance(unit, dict) or not re.fullmatch(r'agenthub-[a-f0-9]{12}\.service', unit.get('name', '')):
        raise SetupError('Invalid systemd management record')
    path = Path(unit.get('path', ''))
    marker = '# AgentHub-managed prefix: ' + str(Path(prefix).resolve()) + '\n'
    if path.is_symlink() or path.name != unit['name'] or not path.is_file() or not path.read_text(encoding='utf-8').startswith(marker):
        raise SetupError('User service unit is not owned by this installation; refusing to manage it')
    return unit['name']


def systemctl(action, unit):
    if run(['systemctl', '--user', action, unit], timeout=20).returncode:
        raise SetupError('User systemd command failed; no system service/firewall was changed')


def stop(prefix):
    install = read_json(Path(prefix) / 'install.json')
    unit = managed_unit(install, prefix)
    if unit:
        systemctl('stop', unit)
    for name in ('console', 'hub'):
        stop_record(Path(install['config_dir']) / 'run' / (name + '.json'), prefix)
    return {'ok': True, 'stopped_owned_services': True}


def start_systemd(prefix, install, config_dir, settings, with_console):
    unit = managed_unit(install, prefix)
    if with_console or settings.get('with_console'):
        raise SetupError('This user systemd mode supports Hub-only; use direct mode for the optional console')
    systemctl('start', unit)
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            record = valid_record(config_dir / 'run/hub.json', prefix)
            if running(record) and owns_listener(record['pid'], settings['port']):
                try:
                    with urlopen(local_url(settings['bind'], settings['port'], '/health'), timeout=1) as response:
                        if response.status == 200 and json.loads(response.read()).get('service') == 'agent-hub':
                            return {'ok': True, 'hub_url': local_url(settings['bind'], settings['port'], '/mcp'), 'systemd_user_unit': unit, 'console': False}
                except (OSError, ValueError):
                    pass
            time.sleep(.1)
        raise SetupError('Owned user service did not become healthy; inspect its user journal')
    except Exception:
        systemctl('stop', unit)
        raise


def local_url(host, port, suffix):
    host = '127.0.0.1' if host == '0.0.0.0' else '::1' if host == '::' else host
    if ':' in host:
        host = '[' + host + ']'
    return 'http://' + host + ':' + str(port) + suffix


def wait_health(process, port, url, expected_service=None, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise SetupError('Service exited before health was confirmed; inspect external logs')
        try:
            with urlopen(url, timeout=1) as response:
                good = response.status == 200
                if expected_service:
                    good = good and json.loads(response.read()).get('service') == expected_service
            if good and process.poll() is None and owns_listener(process.pid, port):
                return
        except (OSError, ValueError):
            pass
        time.sleep(.1)
    raise SetupError('Health timeout; the installation did not take ownership of the listening port')


def check_port(bind, port):
    # Windows permits SO_REUSEADDR listeners to share a port. An exclusive
    # preflight prevents an existing healthy foreign Hub from being reused.
    family = socket.AF_INET6 if ':' in bind else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_STREAM) as probe:
            if os.name == 'nt' and hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            probe.bind((bind, port))
    except OSError:
        raise SetupError('Port ' + str(port) + ' is already in use or the bind address is unavailable; no foreign process was stopped')


def start(prefix, with_console=False):
    install, config_dir, settings = load(prefix)
    app = Path(prefix).resolve() / 'app'
    if not (app / 'hub/agent_hub.py').is_file():
        raise SetupError('Hub component is not installed; a plugins-only installation never starts a Hub')
    if install.get('systemd'):
        return start_systemd(prefix, install, config_dir, settings, with_console)
    records = config_dir / 'run'
    logs = config_dir / 'logs'
    records.mkdir(parents=True, exist_ok=True)
    logs.mkdir(parents=True, exist_ok=True)
    env = environment(config_dir, settings)
    services = [('hub', settings['python']['argv'] + [str(app / 'hub/agent_hub.py'), '--http', str(settings['port']), '--host', settings['bind']],
                 app / 'hub/agent_hub.py', settings['port'], local_url(settings['bind'], settings['port'], '/health'), 'agent-hub')]
    if with_console or settings.get('with_console'):
        if not settings.get('node'):
            raise SetupError('Console needs Node.js 20+: https://nodejs.org/en/download')
        services.append(('console', settings['node']['argv'] + [str(app / 'console/server.mjs')], app / 'console/server.mjs',
                         settings.get('console_port', 8890), local_url(settings.get('console_bind', '127.0.0.1'), settings.get('console_port', 8890), '/dashboard'), None))
    started = []
    try:
        for name, argv, entry, port, url, expected in services:
            record_path = records / (name + '.json')
            existing = valid_record(record_path, prefix)
            if running(existing):
                continue
            host = settings['bind'] if name == 'hub' else settings.get('console_bind', '127.0.0.1')
            check_port(host, port)
            if record_path.exists():
                record_path.unlink()
            output = (logs / (name + '.out.log')).open('ab')
            error = (logs / (name + '.err.log')).open('ab')
            try:
                process = subprocess.Popen(argv, cwd=str(app), env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=error,
                                           start_new_session=os.name != 'nt', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0)
            finally:
                output.close(); error.close()
            stamp = identity(process.pid)
            if not stamp:
                process.terminate(); process.wait(timeout=5)
                raise SetupError('Could not identify the newly started service')
            atomic_json(record_path, {'prefix': str(Path(prefix).resolve()), 'pid': process.pid, 'identity': stamp, 'entry': str(entry)})
            started.append(record_path)
            wait_health(process, port, url, expected)
        return {'ok': True, 'hub_url': local_url(settings['bind'], settings['port'], '/mcp'), 'console': len(services) == 2}
    except Exception:
        for path in reversed(started):
            stop_record(path, prefix)
        raise


def status(prefix):
    install = read_json(Path(prefix) / 'install.json')
    config_dir = Path(install['config_dir'])
    return {name: running(valid_record(config_dir / 'run' / (name + '.json'), prefix)) for name in ('hub', 'console')}


def foreground(prefix):
    _, config_dir, settings = load(prefix)
    entry = Path(prefix).resolve() / 'app/hub/agent_hub.py'
    atomic_json(config_dir / 'run/hub.json', {'prefix': str(Path(prefix).resolve()), 'pid': os.getpid(), 'identity': identity(os.getpid()), 'entry': str(entry)})
    argv = settings['python']['argv'] + [str(entry), '--http', str(settings['port']), '--host', settings['bind']]
    os.execve(argv[0], argv, environment(config_dir, settings))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('start', 'stop', 'status', 'foreground'))
    parser.add_argument('--prefix', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--with-console', action='store_true')
    args = parser.parse_args()
    try:
        if args.action == 'start':
            result = start(args.prefix, args.with_console)
        elif args.action == 'stop':
            result = stop(args.prefix)
        elif args.action == 'foreground':
            foreground(args.prefix)
            return 1
        else:
            result = status(args.prefix)
        print(json.dumps(result))
        return 0
    except (SetupError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
