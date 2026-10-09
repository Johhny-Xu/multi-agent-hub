"""Native installation, upgrade ownership and JSONC-preservation regression tests."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('codearts_native_installer', ROOT / 'integrations/codearts/install.py')
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class NativeInstall(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='agenthub-codearts-native-')
        self.root = Path(self.temp.name)
        self.home = self.root / 'user/.codeartsdoer'
        self.plugin = self.root / 'installed/codearts'
        self.config = self.root / 'private/client.json'
        self.config.parent.mkdir()
        self.config.write_text('{"token":"TEST-PRIVATE-NOT-FOR-PLUGIN","url":"http://127.0.0.1:8765/mcp"}')
        self.settings = self.root / 'project/.codeartsdoer/mcp/mcp_settings.json'

    def tearDown(self):
        self.temp.cleanup()

    def run_install(self, **kwargs):
        return installer.install(self.home, self.plugin, self.config,
                                 ide_settings=self.settings, **kwargs)

    def test_dry_run_no_mutation_then_idempotent_install(self):
        report = self.run_install(apply=False)
        self.assertTrue(report['ok'])
        self.assertFalse(self.home.exists())
        self.assertFalse(self.plugin.exists())
        report = self.run_install(apply=True)
        self.assertTrue(report['ok'])
        self.assertEqual(len(list((self.home / 'agents').glob('*.md'))), 9)
        self.assertEqual(len(list((self.home / 'commands').glob('*.md'))), 3)
        ide = json.loads(self.settings.read_text())['mcpServers']['multi-agent-hub']
        cli = json.loads((self.home / 'codearts_cli.jsonc').read_text())['mcp']['multi-agent-hub']
        self.assertIsInstance(ide['command'], str)
        self.assertIsInstance(cli['command'], list)
        self.assertEqual(cli['type'], 'local')
        self.assertEqual(ide['env'], cli['environment'])
        self.assertEqual(set(ide['env']), {'AGENTHUB_CONFIG', 'AGENTHUB_CONNECTION_MODE'})
        for path in self.plugin.rglob('*'):
            if path.is_file():
                self.assertNotIn(b'TEST-PRIVATE-NOT-FOR-PLUGIN', path.read_bytes())
        again = self.run_install(apply=True)
        self.assertTrue(all(item['action'] == 'unchanged' for item in again['files']))
        self.assertIsNone(again['backup_directory'])

    def test_default_ide_path_keeps_behavior_but_warns_workspace_is_unverified(self):
        report = installer.install(self.home, self.plugin, self.config, targets=('ide',), apply=True)
        expected = self.home / 'mcp/mcp_settings.json'
        self.assertTrue(report['ok'])
        self.assertTrue(expected.is_file())
        self.assertEqual(report['registrations'], [
            {'target': 'ide', 'path': str(expected), 'key': 'mcpServers.multi-agent-hub'}])
        self.assertIn('workspace has not been verified', ' '.join(report['warnings']))
        self.assertIn('--ide-settings PATH', report['next_step'])
        self.assertIn('does not confirm host loading', report['next_step'])
        self.assertFalse(self.settings.exists())

    def test_explicit_workspace_path_does_not_report_fallback_warning(self):
        report = self.run_install(targets=('ide',), apply=True)
        self.assertTrue(report['ok'])
        self.assertTrue(self.settings.exists())
        self.assertNotIn('warnings', report)
        self.assertFalse((self.home / 'mcp/mcp_settings.json').exists())

    def test_cli_only_without_ide_settings_does_not_warn_about_ide(self):
        report = installer.install(self.home, self.plugin, self.config, targets=('cli',), apply=True)
        self.assertTrue(report['ok'])
        self.assertEqual([item['target'] for item in report['registrations']], ['cli'])
        self.assertNotIn('warnings', report)
        self.assertNotIn('next_step', report)
        self.assertFalse((self.home / 'mcp/mcp_settings.json').exists())

    def test_preserves_comments_other_servers_and_private_backup(self):
        self.home.mkdir(parents=True)
        cli_path = self.home / 'codearts_cli.jsonc'
        raw = '// user heading\n{\n "provider": {"custom":"private"},\n "mcp": { "other": {"command": ["x"],}, /*keep*/ },\n}\n'
        cli_path.write_text(raw)
        report = self.run_install(apply=True)
        after = cli_path.read_text()
        self.assertIn('// user heading', after)
        self.assertIn('/*keep*/', after)
        self.assertIn('"provider": {"custom":"private"}', after)
        data, _ = installer.parse_jsonc(after)
        self.assertEqual(data['mcp']['other'], {'command': ['x']})
        saved = list(Path(report['backup_directory']).glob('*-codearts_cli.jsonc'))
        self.assertEqual(saved[0].read_text(), raw)

    def test_conflicting_user_agent_leaves_all_targets_unchanged(self):
        agent = self.home / 'agents/hub-mimocode.md'
        agent.parent.mkdir(parents=True)
        agent.write_text('user-owned')
        report = self.run_install(apply=True)
        self.assertFalse(report['ok'])
        self.assertEqual(agent.read_text(), 'user-owned')
        self.assertFalse(self.plugin.exists())
        self.assertFalse(self.settings.exists())

    def test_unknown_existing_mcp_entry_is_not_overwritten(self):
        self.settings.parent.mkdir(parents=True)
        raw = '{"mcpServers":{"multi-agent-hub":{"command":"user-owned"},"other":{}}}'
        self.settings.write_text(raw)
        report = self.run_install(apply=True)
        self.assertFalse(report['ok'])
        self.assertEqual(self.settings.read_text(), raw)
        self.assertFalse(self.home.exists())

    def test_upgrade_updates_only_owned_entry_preserves_user_change(self):
        self.run_install(apply=True)
        ide = json.loads(self.settings.read_text())
        ide['mcpServers']['other'] = {'command': 'daily-client'}
        self.settings.write_text(json.dumps(ide))
        alternative = self.root / 'private/other.json'
        report = installer.install(self.home, self.plugin, alternative, ide_settings=self.settings, apply=True)
        self.assertTrue(report['ok'])
        ide = json.loads(self.settings.read_text())
        self.assertEqual(ide['mcpServers']['other']['command'], 'daily-client')
        self.assertEqual(ide['mcpServers']['multi-agent-hub']['env']['AGENTHUB_CONFIG'], str(alternative))
        agent = self.home / 'agents/hub-mimocode.md'
        agent.write_text('custom user changes')
        report = self.run_install(apply=True)
        self.assertFalse(report['ok'])
        self.assertEqual(agent.read_text(), 'custom user changes')

    def test_invalid_duplicate_config_and_embedded_secret_path_rejected(self):
        self.home.mkdir(parents=True)
        (self.home / 'codearts_cli.jsonc').write_text('{"mcp":{},"mcp":{}}')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            self.run_install(apply=True)
        self.assertFalse(self.plugin.exists())
        with self.assertRaisesRegex(ValueError, 'outside'):
            installer.install(self.home, self.plugin, self.plugin / 'client.json', apply=False)

    def test_unowned_manifest_preserved(self):
        self.home.mkdir(parents=True)
        state = self.home / '.multi-agent-hub-install.json'
        state.write_text('{"unrelated":"preserve"}')
        with self.assertRaisesRegex(ValueError, 'ownership'):
            self.run_install(apply=True)
        self.assertEqual(state.read_text(), '{"unrelated":"preserve"}')
        self.assertFalse(self.plugin.exists())

    def test_reparse_target_rejected_where_supported(self):
        target = self.root / 'outside'
        target.mkdir()
        link = self.root / 'link'
        try:
            link.symlink_to(target, target_is_directory=True)
        except OSError:
            self.skipTest('Symlink creation unavailable')
        with self.assertRaisesRegex(ValueError, 'symbolic link'):
            installer.install(link / '.codeartsdoer', self.plugin, self.config, apply=True)

    def test_transaction_rolls_back_on_midwrite_error(self):
        original = installer.atomic_write
        count = 0
        def fail_once(path, content):
            nonlocal count
            if path.is_relative_to(self.plugin):
                count += 1
                if count == 3:
                    raise OSError('simulated disk failure')
            return original(path, content)
        with patch.object(installer, 'atomic_write', fail_once):
            with self.assertRaisesRegex(OSError, 'simulated'):
                self.run_install(apply=True)
        self.assertFalse((self.home / '.multi-agent-hub-install.json').exists())
        self.assertEqual([item for item in self.plugin.rglob('*') if item.is_file()], [])


if __name__ == '__main__':
    unittest.main()
