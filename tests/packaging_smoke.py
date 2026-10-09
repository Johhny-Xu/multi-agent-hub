"""Offline isolated distribution/install/service regressions. Never calls a model."""
import hashlib
import importlib.util
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from urllib.request import urlopen
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'packaging'))
import build
import install
import service


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def call(argv, env=None):
    return subprocess.run([str(arg) for arg in argv], capture_output=True, encoding='utf-8', errors='replace', env=env,
                          timeout=60, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0)


class DistributionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='agenthub-packaging-tests-')
        cls.lab = Path(cls.temporary.name)
        cls.bundles = {}
        for component in ('hub', 'plugins', 'both'):
            artifact = build.build(cls.lab / 'releases', component)
            with zipfile.ZipFile(cls.lab / 'releases' / artifact['file']) as archive:
                archive.extractall(cls.lab / 'unpacked')
                for info in archive.infolist():
                    if info.filename.endswith('.sh'):
                        (cls.lab / 'unpacked' / info.filename).chmod(0o755)
            cls.bundles[component] = cls.lab / 'unpacked' / ('agenthub-0.7.0-' + component)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.case = Path(tempfile.mkdtemp(prefix='case-', dir=self.lab))
        self.prefix = self.case / 'installation with spaces'
        self.config = self.case / 'private-config'

    def installer(self, component, *args, env=None):
        return call([sys.executable, self.bundles[component] / 'packaging/install.py', '--prefix', self.prefix,
                     '--config-dir', self.config, '--native-hosts', 'none', *args], env)

    def service(self, action, *args):
        return call([sys.executable, self.prefix / 'packaging/service.py', action, '--prefix', self.prefix, *args])

    def invoke(self, component, **overrides):
        args = dict(bundle=self.bundles[component], component=component, prefix=self.prefix, config_dir=self.config,
                    python=None, node=None, with_console=False, bind=None, port=None, console_port=None,
                    url=None, token_file=None, native_hosts='none', project=None, profile='isolated-test',
                    codex_home=None, zcode_home=None, dsh_home=None, codex_cli=None, zcode_cli=None, dsh_cli=None,
                    no_start=True, systemd_user=False)
        args.update(overrides)
        with contextlib.redirect_stdout(io.StringIO()):
            return install.install(SimpleNamespace(**args))

    def tearDown(self):
        if (self.prefix / 'install.json').is_file():
            self.service('stop')

    def test_three_components_install_only_selected_payload_and_have_no_resident_client_server(self):
        for component in ('hub', 'plugins', 'both'):
            self.prefix = self.case / component
            self.config = self.case / (component + '-config')
            result = self.installer(component, '--no-start')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((self.prefix / 'app/hub/agent_hub.py').is_file(), component != 'plugins')
            self.assertEqual((self.prefix / 'app/integrations/codex/.codex-plugin/plugin.json').is_file(), component != 'hub')
            self.assertEqual((self.config / 'hub.json').is_file(), component != 'plugins')
            self.assertEqual(json.loads(self.service('status').stdout), {'hub': False, 'console': False})
            if component == 'plugins':
                self.assertNotEqual(self.service('start').returncode, 0)

    def test_source_only_zip_manifest_and_root_wrappers_do_not_import_user_configuration(self):
        for component, bundle in self.bundles.items():
            manifest = install.verify_bundle(bundle)
            self.assertTrue((bundle / 'README.md').is_file())
            self.assertEqual((bundle / 'start.sh').read_bytes(), (ROOT / 'packaging/start.sh').read_bytes())
            self.assertNotEqual((bundle / 'start.sh').read_bytes(), (ROOT / 'start.sh').read_bytes())
            with zipfile.ZipFile(self.lab / 'releases' / ('agenthub-0.7.0-' + component + '.zip')) as archive:
                shell = archive.getinfo('agenthub-0.7.0-' + component + '/install.sh')
                self.assertEqual(shell.create_system, 3)
                self.assertEqual(shell.external_attr >> 16 & 0o777, 0o755)
            for relative in manifest['files']:
                self.assertNotIn(Path(relative).name, build.DENIED)
                self.assertNotIn('node_modules', Path(relative).parts)
                self.assertNotIn('sessions', Path(relative).parts)

    def test_repeat_install_backs_up_owned_app_and_preserves_exact_configuration(self):
        self.assertEqual(self.installer('both', '--no-start').returncode, 0)
        settings = json.loads((self.config / 'hub.json').read_text())
        settings['user_setting'] = 'preserve this'
        (self.config / 'hub.json').write_text(json.dumps(settings))
        (self.config / 'agents.json').write_text('{"agents":{},"private_custom_marker":"preserve"}')
        snapshots = {name: (self.config / name).read_bytes() for name in ('hub.json', 'client.json', 'agents.json', 'hub-token.txt')}
        self.assertEqual(self.installer('plugins', '--no-start').returncode, 0)
        self.assertTrue((self.prefix / 'app/hub/agent_hub.py').exists())
        self.assertTrue(list((self.prefix / 'backups').glob('*/app')))
        for name, before in snapshots.items():
            self.assertEqual((self.config / name).read_bytes(), before)

    def test_new_hub_token_is_strong_private_and_never_printed(self):
        response = self.installer('hub', '--no-start', '--bind', '0.0.0.0')
        self.assertEqual(response.returncode, 0, response.stderr)
        token = json.loads((self.config / 'hub.json').read_text())['token']
        self.assertGreaterEqual(len(token), 32)
        self.assertEqual((self.config / 'hub-token.txt').read_text().strip(), token)
        self.assertNotIn(token, response.stdout + response.stderr)
        if os.name != 'nt':
            self.assertEqual((self.config / 'client.json').stat().st_mode & 0o777, 0o600)

    def test_remote_host_port_requires_pairing_token_and_does_not_reuse_another_endpoint_secret(self):
        self.assertEqual(self.installer('plugins', '--no-start').returncode, 0)
        old = (self.config / 'client.json').read_bytes()
        rejected = self.installer('plugins', '--url', 'example.invalid:9999', '--no-start')
        self.assertNotEqual(rejected.returncode, 0)
        self.assertEqual((self.config / 'client.json').read_bytes(), old)
        token_file = self.case / 'pairing-token.txt'; token_file.write_text('SYNTHETIC_PAIRING_TOKEN_' + 'x' * 40)
        response = self.installer('plugins', '--url', 'example.invalid:9999', '--token-file', token_file, '--no-start')
        self.assertEqual(response.returncode, 0, response.stderr)
        client = json.loads((self.config / 'client.json').read_text())
        self.assertEqual(client['url'], 'http://example.invalid:9999/mcp')
        self.assertNotIn(client['token'], response.stdout + response.stderr)
        before = (self.config / 'client.json').read_bytes()
        token_file.write_text('SYNTHETIC_PAIRING_TOKEN_' + 'x' * 40 + '\nsecond-line')
        rejected = self.installer('plugins', '--url', 'example.invalid:9999', '--token-file', token_file, '--no-start')
        self.assertNotEqual(rejected.returncode, 0)
        self.assertEqual((self.config / 'client.json').read_bytes(), before)

    def test_manifest_tamper_and_unowned_prefix_fail_before_overwriting_files(self):
        bundle = self.case / 'tampered'; shutil.copytree(self.bundles['hub'], bundle)
        (bundle / 'payload/hub/agent_hub.py').write_text('tampered')
        result = call([sys.executable, bundle / 'packaging/install.py', '--prefix', self.prefix, '--config-dir', self.config, '--no-start'])
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.prefix.exists())
        (self.prefix / 'app').mkdir(parents=True)
        sentinel = self.prefix / 'app/user.txt'; sentinel.write_text('user content')
        self.assertNotEqual(self.installer('hub', '--no-start').returncode, 0)
        self.assertEqual(sentinel.read_text(), 'user content')

    def test_hub_only_without_node_and_bad_explicit_dependency_diagnosis(self):
        env = dict(os.environ, PATH=str(self.case / 'empty-path'))
        response = self.installer('hub', '--no-start', env=env)
        self.assertEqual(response.returncode, 0, response.stderr)
        plugin_prefix = self.case / 'plugins-without-node'
        response = call([sys.executable, self.bundles['plugins'] / 'packaging/install.py', '--prefix', plugin_prefix,
                         '--config-dir', self.case / 'other-config', '--no-start', '--native-hosts', 'none'], env)
        self.assertNotEqual(response.returncode, 0)
        self.assertIn('Node.js 20+', response.stderr)
        self.assertFalse(plugin_prefix.exists())

    def test_actual_hub_start_health_status_and_owned_stop(self):
        port = free_port()
        response = self.installer('hub', '--port', port)
        self.assertEqual(response.returncode, 0, response.stderr)
        with urlopen('http://127.0.0.1:' + str(port) + '/health', timeout=3) as result:
            self.assertEqual(json.loads(result.read())['service'], 'agent-hub')
        self.assertEqual(json.loads(self.service('status').stdout), {'hub': True, 'console': False})
        self.assertEqual(self.service('stop').returncode, 0)
        self.assertEqual(json.loads(self.service('status').stdout), {'hub': False, 'console': False})

    def test_plugins_upgrade_does_not_stop_or_restart_running_colocated_hub(self):
        response = self.installer('hub', '--port', free_port())
        self.assertEqual(response.returncode, 0, response.stderr)
        previous = (self.config / 'run/hub.json').read_bytes()
        response = self.installer('plugins', '--no-start')
        self.assertEqual(response.returncode, 0, response.stderr)
        self.assertEqual((self.config / 'run/hub.json').read_bytes(), previous)
        self.assertEqual(json.loads(self.service('status').stdout), {'hub': True, 'console': False})

    def test_plugins_then_hub_pairs_the_owned_empty_local_connection_token(self):
        port = free_port()
        response = self.installer('plugins', '--url', '127.0.0.1:' + str(port), '--no-start')
        self.assertEqual(response.returncode, 0, response.stderr)
        self.assertEqual(json.loads((self.config / 'client.json').read_text())['token'], '')
        self.assertEqual(self.installer('hub', '--port', port, '--no-start').returncode, 0)
        self.assertEqual(json.loads((self.config / 'client.json').read_text())['token'], json.loads((self.config / 'hub.json').read_text())['token'])

    def test_optional_console_is_explicit_and_uses_external_state(self):
        response = self.installer('both', '--port', free_port(), '--with-console', '--console-port', free_port())
        self.assertEqual(response.returncode, 0, response.stderr)
        self.assertEqual(json.loads(self.service('status').stdout), {'hub': True, 'console': True})
        self.assertTrue((self.config / 'console-state').is_dir())
        self.assertFalse((self.prefix / 'app/console/conversations.json').exists())

    def test_foreign_health_server_does_not_make_failed_new_hub_a_success(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200); self.end_headers(); self.wfile.write(b'{"service":"agent-hub"}')
            def log_message(self, *args):
                pass
        foreign = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=foreign.serve_forever, daemon=True); thread.start()
        try:
            response = self.installer('hub', '--port', foreign.server_port)
            self.assertNotEqual(response.returncode, 0)
            self.assertEqual(urlopen('http://127.0.0.1:' + str(foreign.server_port), timeout=2).status, 200)
            self.assertEqual(json.loads(self.service('status').stdout), {'hub': False, 'console': False})
        finally:
            foreign.shutdown(); foreign.server_close(); thread.join(timeout=3)

    def test_reused_pid_record_cannot_stop_unowned_process(self):
        self.assertEqual(self.installer('hub', '--no-start').returncode, 0)
        records = self.config / 'run'; records.mkdir()
        (records / 'hub.json').write_text(json.dumps({'prefix': str(self.prefix.resolve()), 'pid': os.getpid(), 'identity': 'deliberately-wrong', 'entry': str(ROOT / 'hub/agent_hub.py')}))
        self.assertEqual(self.service('stop').returncode, 0)
        self.assertIsNotNone(service.identity(os.getpid()))

    def test_wrapper_installs_from_paths_with_spaces(self):
        bundle = self.bundles['plugins']
        if os.name == 'nt':
            argv = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bundle / 'packaging/bootstrap.ps1', '-Action', 'install']
        else:
            argv = ['sh', bundle / 'install.sh']
        response = call(argv + ['--prefix', self.prefix, '--config-dir', self.config, '--native-hosts', 'none', '--no-start'])
        self.assertEqual(response.returncode, 0, response.stderr)
        self.assertTrue((self.prefix / 'app/integrations/codex/.mcp.json').is_file())

    def test_systemd_user_unit_does_not_embed_token_or_system_wide_changes(self):
        with patch.object(install.os, 'name', 'posix'):
            unit = install.systemd_unit(self.prefix, self.config, {'argv': [sys.executable]})
        self.assertIn('foreground', unit)
        self.assertIn('WantedBy=default.target', unit)
        self.assertNotIn('HUB_TOKEN=', unit)
        self.assertNotIn('User=root', unit)

    def test_systemd_unit_ownership_and_manager_lifecycle(self):
        self.assertEqual(self.installer('hub', '--no-start').returncode, 0)
        unit_path = self.case / 'agenthub-123456abcdef.service'
        with patch.object(install.os, 'name', 'posix'):
            unit_path.write_text(install.systemd_unit(self.prefix, self.config, {'argv': [sys.executable]}))
        record = json.loads((self.prefix / 'install.json').read_text())
        record['management_mode'] = 'systemd-user'
        record['systemd'] = {'name': unit_path.name, 'path': str(unit_path)}
        (self.prefix / 'install.json').write_text(json.dumps(record))
        # Replacing the module's platform view keeps pathlib on the real test OS.
        with patch.object(service, 'os', SimpleNamespace(name='posix')):
            self.assertEqual(service.managed_unit(record, self.prefix), unit_path.name)
            with self.assertRaisesRegex(service.SetupError, 'not owned'):
                service.managed_unit(record, self.case / 'another-prefix')
            events = []
            with patch.object(service, 'systemctl', side_effect=lambda action, name: events.append((action, name))), \
                 patch.object(service, 'stop_record', side_effect=lambda path, prefix: events.append(('record', path.name))):
                service.stop(self.prefix)
            self.assertEqual(events, [('stop', unit_path.name), ('record', 'console.json'), ('record', 'hub.json')])
            with patch.object(service, 'start_systemd', return_value={'ok': True}) as managed, \
                 patch.object(service.subprocess, 'Popen') as direct:
                self.assertEqual(service.start(self.prefix), {'ok': True})
            managed.assert_called_once()
            direct.assert_not_called()
        unit_path.write_text('[Service]\nExecStart=/unrelated\n')
        with patch.object(service, 'os', SimpleNamespace(name='posix')), \
             patch.object(service, 'systemctl') as manager:
            with self.assertRaisesRegex(service.SetupError, 'not owned'):
                service.stop(self.prefix)
            manager.assert_not_called()

    def test_systemd_install_persists_owner_and_upgrade_stops_manager(self):
        class LinuxView:
            name = 'posix'
            def __getattr__(self, key):
                return getattr(os, key)
        actual_which = shutil.which
        def discovery(command):
            return '/isolated/systemctl' if command == 'systemctl' else actual_which(command)
        with patch.object(install, 'os', LinuxView()), \
             patch.dict(os.environ, {'XDG_CONFIG_HOME': str(self.case / 'xdg')}), \
             patch.object(install.shutil, 'which', side_effect=discovery), \
             patch.object(install, 'run', return_value=SimpleNamespace(returncode=0)) as command, \
             patch.object(service, 'stop') as stop:
            self.assertEqual(self.invoke('hub', systemd_user=True), 0)
            metadata = json.loads((self.prefix / 'install.json').read_text())
            self.assertEqual(metadata['management_mode'], 'systemd-user')
            self.assertRegex(metadata['systemd']['name'], r'^agenthub-[a-f0-9]{12}\.service$')
            self.assertTrue(Path(metadata['systemd']['path']).read_text().startswith('# AgentHub-managed prefix: ' + str(self.prefix.resolve()) + '\n'))
            self.assertEqual(command.call_args.args[0], ['systemctl', '--user', 'daemon-reload'])
            before = (self.config / 'hub.json').read_bytes()
            with self.assertRaisesRegex(install.SetupError, 'Hub-only'):
                self.invoke('hub', with_console=True)
            self.assertEqual((self.config / 'hub.json').read_bytes(), before)
            stop.assert_not_called()
            with patch.object(service, 'os', SimpleNamespace(name='posix')):
                self.assertEqual(self.invoke('hub'), 0)
            stop.assert_called_once_with(self.prefix.resolve())
            self.assertEqual(json.loads((self.prefix / 'install.json').read_text())['systemd'], metadata['systemd'])

    def test_installed_bridges_use_authoritative_file_connection_and_mimo_aliases(self):
        self.assertEqual(self.installer('plugins', '--no-start').returncode, 0)
        codex = json.loads((self.prefix / 'app/integrations/codex/.mcp.json').read_text(encoding='utf-8'))['mcpServers']['agenthub']
        zcode = json.loads((self.prefix / 'app/plugins/agenthub-workers/.zcode-plugin/plugin.json').read_text(encoding='utf-8'))['mcpServers']
        for bridge in [codex, *zcode.values()]:
            self.assertEqual(bridge['env'], {'AGENTHUB_CONFIG': str(self.config / 'client.json'), 'AGENTHUB_CONNECTION_MODE': 'file'})
        marketplace = json.loads((self.prefix / 'app/.zcode-plugin/marketplace.json').read_text(encoding='utf-8'))
        plugin = next(item for item in marketplace['plugins'] if item['name'] == 'agenthub-workers')
        self.assertEqual(plugin['source'], {'source': 'directory', 'path': str(self.prefix / 'app/plugins/agenthub-workers')})
        modules = self.case / 'roaming/npm/node_modules/@mimo-ai/cli/bin'
        modules.mkdir(parents=True)
        (modules / 'mimo').write_text('public fixture; not executed')
        with patch.dict(os.environ, {'APPDATA': str(self.case / 'roaming')}), patch.object(install.native, 'discover', return_value={'zcode': None}):
            profile = install.worker_config(self.prefix / 'app', {'argv': ['node']})['agents']['mimocode']
        self.assertEqual(profile['models'], {'default': 'xiaomi/mimo-v2.6-flash', '26f': 'xiaomi/mimo-v2.6-flash', 'v2.6f': 'xiaomi/mimo-v2.6-flash'})

    def test_manifest_and_build_reject_drive_relative_and_parent_link_escape(self):
        bundle = self.case / 'bundle'; bundle.mkdir()
        for name in ('C:source.py', '\\source.py', '..\\source.py'):
            (bundle / 'manifest.json').write_text(json.dumps({'component': 'hub', 'files': {name: '0' * 64}}))
            with self.assertRaisesRegex(install.SetupError, 'Unsafe path'):
                install.verify_bundle(bundle)
        outside = self.case / 'outside'; outside.mkdir()
        fixture = outside / 'public.py'; fixture.write_text('public fixture')
        link = bundle / 'linked'
        if os.name == 'nt':
            command = "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path '" + str(link).replace("'", "''") + "' -Target '" + str(outside).replace("'", "''") + "' | Out-Null"
            response = call(['powershell.exe', '-NoProfile', '-Command', command])
            self.assertEqual(response.returncode, 0, response.stderr)
        else:
            link.symlink_to(outside, target_is_directory=True)
        digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
        (bundle / 'manifest.json').write_text(json.dumps({'component': 'hub', 'files': {'linked/public.py': digest}}))
        with self.assertRaisesRegex(install.SetupError, 'escapes'):
            install.verify_bundle(bundle)
        fake = self.case / 'fake-repository'; fake.mkdir()
        for directory in ('drivers', 'console/client'):
            (fake / directory).mkdir(parents=True)
        (fake / 'LICENSE').write_text('fixture')
        (fake / 'drivers/zcode_rpc.mjs').write_text('fixture')
        (fake / 'console/server.mjs').write_text('fixture')
        hub_link = fake / 'hub'
        if os.name == 'nt':
            command = "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path '" + str(hub_link).replace("'", "''") + "' -Target '" + str(outside).replace("'", "''") + "' | Out-Null"
            response = call(['powershell.exe', '-NoProfile', '-Command', command])
            self.assertEqual(response.returncode, 0, response.stderr)
        else:
            hub_link.symlink_to(outside, target_is_directory=True)
        with patch.object(build, 'ROOT', fake), patch.object(build, 'COMMON', []):
            with self.assertRaisesRegex(ValueError, 'escapes'):
                build.package_files('hub')


if __name__ == '__main__':
    unittest.main(verbosity=2)
