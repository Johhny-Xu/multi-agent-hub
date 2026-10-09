"""Independent offline packaging regressions; temporary profiles, no models."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'packaging'))
import build
import install
import native
import runtime
import connect


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dsh = load('audit_dsh_installer', ROOT / 'integrations/dsh/install-dsh.py')
codex = load('audit_codex_installer', ROOT / 'integrations/codex/install.py')


class PackagingAuditTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='agenthub-packaging-audit-')
        cls.lab = Path(cls.temporary.name)
        artifact = build.build(cls.lab / 'release', 'both')
        with zipfile.ZipFile(cls.lab / 'release' / artifact['file']) as archive:
            archive.extractall(cls.lab / 'bundle')
        cls.bundle = cls.lab / ('bundle/agenthub-' + build.VERSION + '-both')

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.case = Path(tempfile.mkdtemp(prefix='case-', dir=self.lab))
        self.prefix = self.case / 'installation with spaces'
        self.config = self.case / 'private config'

    def invoke(self, component, **overrides):
        args = dict(bundle=self.bundle, component=component, prefix=self.prefix, config_dir=self.config,
                    python=None, node=None, with_console=False, bind=None, port=None, console_port=None,
                    url=None, token_file=None, native_hosts='none', project=None, profile='audit',
                    codex_home=None, zcode_home=None, dsh_home=None, codex_cli=None, zcode_cli=None, dsh_cli=None,
                    no_start=True, systemd_user=False)
        args.update(overrides)
        with contextlib.redirect_stdout(io.StringIO()), patch.object(connect, 'scan', return_value={'candidates': [], 'errors': [], 'manual_required': True}), \
             patch.object(sys, 'stdin', SimpleNamespace(isatty=lambda: False)):
            return install.install(SimpleNamespace(**args))

    def test_invalid_explicit_runtime_never_falls_back(self):
        for kind in ('python', 'node'):
            with self.assertRaises(runtime.SetupError):
                runtime.runtime(kind, str(self.case / 'missing-runtime.exe'))

    def test_plugins_then_hub_pairs_existing_empty_local_client(self):
        self.invoke('plugins')
        self.assertFalse((self.config / 'client.json').exists())
        self.invoke('hub')
        client = json.loads((self.config / 'client.json').read_text())
        hub = json.loads((self.config / 'hub.json').read_text())
        self.assertEqual(client['url'], install.service.local_url(hub['bind'], hub['port'], '/mcp'))
        self.assertEqual(client['token'], hub['token'])
        self.assertGreaterEqual(len(client['token']), 32)

    def test_plugins_upgrade_does_not_stop_owned_hub(self):
        self.invoke('hub')
        with patch.object(install.service, 'stop_record') as stop:
            self.invoke('plugins')
        stop.assert_not_called()

    def test_explicit_connection_file_replaces_only_owned_connection_overrides(self):
        home = self.case / 'dsh'
        profile = home / 'profiles/audit'
        profile.mkdir(parents=True)
        package = profile / 'package.json'
        package.write_text(json.dumps({'custom': 'preserved', 'dependencies': {}, 'dsh': {'profile': {'bundles': []}}}))
        persona = '- id: user-persona\n  config:\n    text: keep me\n'
        settings = {'url': 'http://old.invalid/mcp', 'token': 'SYNTHETIC_OLD_TOKEN',
                    'env': {'AGENTHUB_URL': 'http://old.invalid/mcp', 'HUB_MCP_URL': 'http://old2.invalid/mcp',
                            'HUB_TOKEN': 'SYNTHETIC_OLD_TOKEN', 'AGENTHUB_CONFIG_FILE': '/old/client.json', 'CUSTOM': 'preserved'}}
        (profile / 'cordis.patch.yml').write_text(persona + dsh.BLOCK_BEGIN + '\n' + dsh.load_template_yaml(settings=settings) + dsh.BLOCK_END + '\n')
        client_path = self.case / 'new-client.json'
        dsh.prepare_profile(home, 'audit', config_file=client_path, command='C:/Stable Node/node.exe')
        content = (profile / 'cordis.patch.yml').read_text()
        self.assertTrue(content.startswith(persona))
        parsed = dsh.existing_settings(content)
        self.assertNotIn('url', parsed)
        self.assertNotIn('token', parsed)
        for key in ('AGENTHUB_URL', 'HUB_MCP_URL', 'HUB_TOKEN', 'AGENTHUB_CONFIG_FILE'):
            self.assertNotIn(key, parsed['env'])
        self.assertIn('file', parsed['env']['AGENTHUB_CONNECTION_MODE'].text)
        self.assertIn('preserved', parsed['env']['CUSTOM'].text)
        self.assertIn('Stable Node', parsed['command'].text)
        self.assertEqual(json.loads(package.read_text())['custom'], 'preserved')

    def test_file_and_explicit_connection_conflict_fails_before_profile_mutation(self):
        home = self.case / 'dsh'; profile = home / 'profiles/audit'; profile.mkdir(parents=True)
        package = profile / 'package.json'
        package.write_text('{"dependencies":{},"dsh":{"profile":{"bundles":[]}}}')
        before = package.read_bytes()
        with self.assertRaisesRegex(ValueError, 'not both'):
            dsh.prepare_profile(home, 'audit', config_file=self.case / 'client.json', url='http://new.invalid/mcp')
        self.assertEqual(package.read_bytes(), before)
        self.assertFalse((profile / 'cordis.patch.yml').exists())

    def test_owned_codex_agents_upgrade_with_backup_but_user_changes_survive(self):
        workspace = self.case / 'project'; workspace.mkdir()
        plugin = self.case / 'plugin'
        backup = self.case / 'backups'
        native.install_codex_agents(codex, workspace, plugin, 'node', self.config, backup)
        original_plan = codex.plan
        selected = next((workspace / '.codex/agents').glob('*.toml')).resolve()
        before = selected.read_bytes()
        def changed_plan(*args, **kwargs):
            writes, changes = original_plan(*args, **kwargs)
            writes[selected] += b'\n# new owned revision\n'
            for change in changes:
                if Path(change['path']) == selected:
                    change['action'] = 'conflict' if selected.read_bytes() != writes[selected] else 'unchanged'
            return writes, changes
        with patch.object(codex, 'plan', changed_plan):
            self.assertEqual(native.install_codex_agents(codex, workspace, plugin, 'node', self.config, backup), 1)
        self.assertNotEqual(selected.read_bytes(), before)
        self.assertTrue(any(path.read_bytes() == before for path in (backup / 'project').glob('*')))
        selected.write_bytes(selected.read_bytes() + b'\n# user customization\n')
        customized = selected.read_bytes()
        with self.assertRaisesRegex(runtime.SetupError, 'user-modified'):
            native.install_codex_agents(codex, workspace, plugin, 'node', self.config, backup)
        self.assertEqual(selected.read_bytes(), customized)

    def test_explicit_missing_native_entry_is_failed_not_not_installed(self):
        records = native.register(self.case / 'app', self.config, {'argv': ['node']}, selected='codex',
                                  overrides={'codex': str(self.case / 'absent.exe')})
        self.assertEqual(records[0]['status'], 'failed')

    def test_zcode_refresh_uses_only_owned_plugin_and_keeps_data_and_disabled_state(self):
        app = self.case / 'app'
        existing = {'id': 'agenthub-workers@agenthub-local', 'name': 'agenthub-workers', 'enabled': False}
        market = {'id': 'agenthub-local', 'source': {'source': 'file', 'path': str(app / '.zcode-plugin/marketplace.json')}}
        calls = []
        def command(argv, env, required=True):
            calls.append(argv)
            value = [market] if argv[1:3] == ['marketplace', 'list'] else [existing]
            return SimpleNamespace(stdout=json.dumps(value), returncode=0)
        with patch.object(native, 'command', command):
            native.install_zcode_plugin([], {}, app, self.case / 'private backup')
        self.assertIn(['plugins', 'uninstall', existing['id'], '--force', '--keep-data'], calls)
        self.assertIn(['plugins', 'disable', existing['id']], calls)
        self.assertIn(['plugins', 'marketplace', 'add', str(app / '.zcode-plugin/marketplace.json')], calls)
        self.assertTrue((self.case / 'private backup/agenthub-registration.json').is_file())

    def test_zcode_marketplace_owned_by_another_install_is_preserved(self):
        app = self.case / 'app'
        existing = {'id': 'agenthub-workers@agenthub-local', 'name': 'agenthub-workers'}
        market = {'id': 'agenthub-local', 'source': {'source': 'file', 'path': str(self.case / 'other/marketplace.json')}}
        calls = []
        def command(argv, env, required=True):
            calls.append(argv)
            return SimpleNamespace(stdout=json.dumps([market] if argv[1:3] == ['marketplace', 'list'] else [existing]), returncode=0)
        with patch.object(native, 'command', command):
            with self.assertRaisesRegex(runtime.SetupError, 'another installation'):
                native.install_zcode_plugin([], {}, app, self.case / 'private backup')
        self.assertTrue(all('uninstall' not in argv and 'add' not in argv and 'install' not in argv for argv in calls))


if __name__ == '__main__':
    unittest.main(verbosity=2)
