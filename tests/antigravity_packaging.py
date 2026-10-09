"""Antigravity directory registration and optional SDK distribution contract."""
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'packaging'))
import build
import native


@unittest.skipUnless(shutil.which('node'), 'Node.js is required')
class AntigravityPackagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='agenthub-agy-package-')
        self.base = Path(self.temporary.name)
        self.home = self.base / 'customization with spaces'
        self.config = self.base / 'private-config'
        self.config.mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def register(self, **kwargs):
        with patch.object(native, 'command', side_effect=AssertionError('No CLI registration permitted')):
            return native.register(ROOT, self.config, {'argv': [shutil.which('node')]},
                                   selected='antigravity', homes={'antigravity': self.home}, **kwargs)

    def test_directory_registration_is_repeatable_and_missing_pairing_is_not_host_loading(self):
        for _ in range(2):
            result = self.register()[0]
            self.assertEqual(result['status'], 'registered', result)
            self.assertTrue(result['reload_required'])
            self.assertEqual(result['registration'], 'native_plugin_directory')
        target = self.home / 'plugins/multi-agent-hub'
        self.assertTrue((target / 'plugin.json').is_file())
        self.assertFalse(self.config.joinpath('client.json').exists())
        config = json.loads((target / 'mcp_config.json').read_text(encoding='utf-8'))
        bridge = config['mcpServers']['multi-agent-hub']
        self.assertEqual(bridge['env']['AGENTHUB_CONNECTION_MODE'], 'file')
        self.assertEqual(bridge['env']['AGENTHUB_CONFIG'], str(self.config / 'client.json'))
        self.assertNotIn('HUB_TOKEN', bridge['env'])
        self.assertTrue(Path(bridge['args'][0]).is_file())

    def test_existing_unowned_bundle_is_preserved(self):
        target = self.home / 'plugins/multi-agent-hub'
        target.mkdir(parents=True)
        sentinel = target / 'plugin.json'
        sentinel.write_text('{"name":"user-owned"}', encoding='utf-8')
        before = sentinel.read_bytes()
        self.assertEqual(self.register()[0]['status'], 'failed')
        self.assertEqual(sentinel.read_bytes(), before)

    def test_explicit_missing_application_marker_is_failure_even_with_custom_home(self):
        result = self.register(overrides={'antigravity': str(self.base / 'missing.exe')})
        self.assertEqual(result[0]['status'], 'failed')
        self.assertFalse(self.home.exists())

    def test_payload_includes_native_assets_and_optional_sdk_without_adding_to_hub(self):
        plugins = build.package_files('plugins')
        hub = build.package_files('hub')
        for relative in ('plugin.json', 'native.py', 'mcp_config.json', 'assets/icon.svg',
                         'mcp/server.mjs', 'sdk/requirements.txt', 'sdk/agenthub_antigravity.py'):
            key = 'payload/integrations/antigravity/' + relative
            self.assertIn(key, plugins)
            self.assertNotIn(key, hub)
        self.assertFalse(any('/site-packages/' in name or '/.venv/' in name for name in plugins))

    def test_sdk_virtual_environments_cannot_enter_a_distribution(self):
        source = self.base / 'source'
        shutil.copytree(ROOT, source, ignore=shutil.ignore_patterns('.git', '__pycache__', 'node_modules'))
        for directory in ('.venv', 'venv', 'site-packages', 'dist-packages'):
            sentinel = source / 'integrations/antigravity/sdk' / directory / 'dependency.py'
            sentinel.parent.mkdir(parents=True, exist_ok=True)
            sentinel.write_text('private_runtime_marker = True', encoding='utf-8')
        with patch.object(build, 'ROOT', source):
            names = build.package_files('plugins')
        self.assertFalse(any(name.endswith('/dependency.py') for name in names))


if __name__ == '__main__':
    unittest.main(verbosity=2)
