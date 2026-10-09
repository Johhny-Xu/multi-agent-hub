"""CodeArts native registration must report conflicts rather than false success."""
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'packaging'))
import native


@unittest.skipUnless(shutil.which('node'), 'Node.js is required')
class CodeArtsRegistrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='agenthub-codearts-registration-')
        self.base = Path(self.temporary.name)
        self.app = self.base / 'app'
        self.home = self.base / 'private-codearts-home'
        self.config = self.base / 'private-hub-config'
        self.config.mkdir()
        (self.config / 'client.json').write_text('{"url":"http://127.0.0.1:8765/mcp"}')
        shutil.copytree(ROOT / 'integrations/codearts', self.app / 'integrations/codearts',
                        ignore=shutil.ignore_patterns('__pycache__'))

    def tearDown(self):
        self.temporary.cleanup()

    def register(self, target='cli', **kwargs):
        return native.register(self.app, self.config, {'argv': [shutil.which('node')]},
                               selected='codearts', homes={'codearts': self.home},
                               overrides={'codearts': sys.executable}, codearts_target=target, **kwargs)

    def test_official_windows_exe_is_discovered_when_path_has_only_cmd_wrapper(self):
        fake_home = self.base / 'discovery-home'
        executable = fake_home / '.codeartsdoer/installers/bin/codearts.exe'
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b'Fixture only; must never be executed.')
        wrapper = executable.with_suffix('.cmd')
        wrapper.write_bytes(b'@echo off\r\n')
        with patch.object(native.Path, 'home', return_value=fake_home), \
                patch.dict(native.os.environ, {'LOCALAPPDATA': str(fake_home / 'local'),
                                              'ProgramFiles': str(fake_home / 'programs')}, clear=True), \
                patch.object(native.shutil, 'which', side_effect=lambda name: str(wrapper) if name == 'codearts' else None), \
                patch.object(native, 'run', side_effect=AssertionError('Discovery must not launch the host')):
            found = native.discover({'argv': ['node']})
        self.assertEqual(found['codearts'], [str(executable.resolve())])

    def test_missing_ide_workspace_is_reported_without_claiming_an_ide_connection(self):
        records = self.register('both')
        self.assertEqual(records[0]['status'], 'registered')
        self.assertEqual(records[0]['targets'], ['cli'])
        self.assertEqual(records[0]['pending_targets'], ['ide'])
        self.assertFalse(records[0]['host_loaded_verified'])
        self.assertEqual([item['target'] for item in records[0]['registrations']], ['cli'])
        self.assertIn('IDE registration is pending', records[0]['next_step'])
        self.assertFalse((self.home / 'mcp/mcp_settings.json').exists())
        self.assertEqual(self.register('ide')[0]['status'], 'failed')

    def test_workspace_registration_reports_current_settings_without_claiming_host_loading(self):
        old_project, new_project = self.base / 'old-project', self.base / 'new-project'
        old_settings = old_project / '.codeartsdoer/mcp/mcp_settings.json'
        new_settings = new_project / '.codeartsdoer/mcp/mcp_settings.json'
        first = self.register('ide', project=old_project)[0]
        old_content = old_settings.read_bytes()
        self.assertFalse(new_settings.exists(), 'A previous workspace registration must not cover a new workspace')
        record = self.register('ide', project=new_project)[0]
        self.assertEqual(record['status'], 'registered')
        self.assertEqual(record['version'], json.loads((self.app / 'integrations/codearts/package.json').read_text())['version'])
        self.assertEqual(Path(record['plugin_directory']), self.app / 'integrations/codearts')
        self.assertEqual(record['registrations'], [
            {'target': 'ide', 'path': str(new_settings), 'key': 'mcpServers.multi-agent-hub'}])
        self.assertNotEqual(first['registrations'], record['registrations'])
        self.assertEqual(old_settings.read_bytes(), old_content)
        self.assertEqual(record['targets'], ['ide'])
        self.assertEqual(record['pending_targets'], [])
        self.assertFalse(record['host_loaded_verified'])
        self.assertIn('recorded workspace MCP settings', record['next_step'])
        self.assertIn('does not confirm host loading', record['next_step'])
        self.assertNotIn('Restart CodeArts CLI', record['next_step'])

    def test_cli_only_report_identifies_cli_settings_without_ide_guidance(self):
        record = self.register('cli')[0]
        self.assertEqual(record['registrations'], [
            {'target': 'cli', 'path': str(self.home / 'codearts_cli.jsonc'), 'key': 'mcp.multi-agent-hub'}])
        self.assertEqual(record['pending_targets'], [])
        self.assertFalse(record['host_loaded_verified'])
        self.assertIn('Restart CodeArts CLI', record['next_step'])
        self.assertNotIn('IDE', record['next_step'])
        self.assertNotIn('--project', record['next_step'])

    def test_conflicting_native_agent_is_preserved_and_registration_fails(self):
        target = self.home / 'agents/hub-codearts.md'
        target.parent.mkdir(parents=True)
        target.write_bytes(b'User-owned agent, not this package.\n')
        records = self.register()
        self.assertEqual(records[0]['status'], 'failed')
        self.assertEqual(target.read_bytes(), b'User-owned agent, not this package.\n')
        self.assertFalse((self.home / 'codearts_cli.jsonc').exists())

    def test_native_registration_merges_only_owned_mcp_and_is_repeatable(self):
        self.home.mkdir()
        settings = self.home / 'codearts_cli.jsonc'
        settings.write_text('// keep comment\n{"model":"existing/provider","mcp":{"other":{"enabled":false}}}\n')
        for _ in range(2):
            records = self.register()
            self.assertEqual(records[0]['status'], 'registered', records)
        self.assertIn('// keep comment', settings.read_text())
        data = json.loads(settings.read_text().split('\n', 1)[1])
        self.assertEqual(data['model'], 'existing/provider')
        self.assertEqual(data['mcp']['other'], {'enabled': False})
        bridge = data['mcp']['multi-agent-hub']
        self.assertEqual(bridge['environment']['AGENTHUB_CONFIG'], str(self.config / 'client.json'))
        self.assertNotIn('HUB_TOKEN', bridge['environment'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
