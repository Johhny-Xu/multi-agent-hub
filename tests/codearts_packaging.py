"""CodeArts native registration must report conflicts rather than false success."""
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

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

    def register(self, target='cli'):
        return native.register(self.app, self.config, {'argv': [shutil.which('node')]},
                               selected='codearts', homes={'codearts': self.home},
                               overrides={'codearts': sys.executable}, codearts_target=target)

    def test_missing_ide_workspace_is_reported_without_claiming_an_ide_connection(self):
        records = self.register('both')
        self.assertEqual(records[0]['status'], 'registered')
        self.assertEqual(records[0]['targets'], ['cli'])
        self.assertEqual(records[0]['pending_targets'], ['ide'])
        self.assertFalse((self.home / 'mcp/mcp_settings.json').exists())
        self.assertEqual(self.register('ide')[0]['status'], 'failed')

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
