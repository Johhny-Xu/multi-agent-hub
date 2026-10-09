"""Native Antigravity installation integrity, upgrades and rollback behavior."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'integrations' / 'antigravity'
SPEC = importlib.util.spec_from_file_location('antigravity_native', SOURCE / 'native.py')
native = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(native)


class NativeInstall(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='agenthub-agy-native-')
        self.root = Path(self.temp.name)
        self.home = self.root / 'user/.gemini/config'
        self.target = self.home / 'plugins/multi-agent-hub'
        self.source = self.root / 'release/integrations/antigravity'
        self.source.mkdir(parents=True)
        # Native installer tests run independently of packaging's bridge sync.
        for name in ('plugin.json', 'mcp_config.json', 'native.py', 'README.md'):
            shutil.copy2(SOURCE / name, self.source / name)
        for name in ('agents', 'skills', 'assets'):
            shutil.copytree(SOURCE / name, self.source / name)
        (self.source / 'mcp').mkdir()
        for name in native.MCP_FILES:
            shutil.copy2(ROOT / 'mcp' / name, self.source / 'mcp' / name)
        self.config = self.root / 'private/client.json'
        self.config.parent.mkdir()
        self.config.write_text('{"token":"TEST-SECRET-DO-NOT-COPY","url":"http://127.0.0.1:8765/mcp"}')
        self.node = patch.object(native, 'node_runtime', return_value=str(self.root / 'runtime/node'))
        self.node.start()
        self.addCleanup(self.node.stop)

    def tearDown(self):
        self.temp.cleanup()

    def install(self, **kwargs):
        return native.install(self.home, self.source, self.config, **kwargs)

    def tree(self, path):
        return {p.relative_to(path).as_posix(): p.read_bytes() for p in path.rglob('*') if p.is_file()}

    def test_dry_run_and_idempotent_install_with_absolute_registration(self):
        planned = self.install()
        self.assertTrue(planned['ok'])
        self.assertFalse(planned['applied'])
        self.assertFalse(self.home.exists())
        result = self.install(apply=True)
        self.assertTrue(result['applied'])
        self.assertTrue(result['restart_required'])
        self.assertFalse(result['loaded'])
        mcp = json.loads((self.target / 'mcp_config.json').read_text())['mcpServers']['multi-agent-hub']
        self.assertEqual(mcp['args'], [str(self.target / 'mcp/server.mjs')])
        self.assertEqual(mcp['env'], {'AGENTHUB_CONFIG': str(self.config), 'AGENTHUB_CONNECTION_MODE': 'file'})
        self.assertTrue(Path(mcp['command']).is_absolute())
        for content in self.tree(self.target).values():
            self.assertNotIn(b'TEST-SECRET-DO-NOT-COPY', content)
        before = self.tree(self.target)
        second = self.install(apply=True)
        self.assertTrue(second['ok'])
        self.assertFalse(second['applied'])
        self.assertFalse(second['restart_required'])
        self.assertEqual(before, self.tree(self.target))
        self.assertIsNone(second['backup_directory'])
        inventory = native.inspect(self.home)
        self.assertTrue(inventory['installed'])
        self.assertTrue(inventory['owned'])
        self.assertEqual(inventory['agents'], 9)
        self.assertEqual(inventory['skills'], 4)
        self.assertEqual(inventory['modified'], [])

    def test_host_preferences_and_other_plugins_stay_byte_identical(self):
        self.home.mkdir(parents=True)
        host = self.home / 'config.json'
        text = '{"plugins":{"multi-agent-hub":{"enabled":false}},"userSettings":{"keep":true}}\n'
        host.write_text(text)
        other = self.home / 'plugins/other/plugin.json'
        other.parent.mkdir(parents=True)
        other.write_text('{"name":"other"}')
        self.install(apply=True)
        self.assertEqual(host.read_text(), text)
        self.assertEqual(other.read_text(), '{"name":"other"}')

    def test_unknown_user_asset_conflict_causes_no_writes(self):
        file = self.target / 'agents/hub-mimocode.md'
        file.parent.mkdir(parents=True)
        file.write_text('my user agent')
        before = self.tree(self.home)
        result = self.install(apply=True)
        self.assertFalse(result['ok'])
        self.assertIn(str(file), result['conflicts'])
        self.assertEqual(before, self.tree(self.home))

    def test_user_edit_blocks_upgrade_and_reports_modified_inventory(self):
        self.install(apply=True)
        file = self.target / 'skills/hub-status/SKILL.md'
        file.write_text(file.read_text() + '\nuser notes\n')
        before = self.tree(self.target)
        result = self.install(apply=True)
        self.assertFalse(result['ok'])
        self.assertEqual(before, self.tree(self.target))
        self.assertEqual(native.inspect(self.home)['modified'], ['skills/hub-status/SKILL.md'])

    def test_managed_upgrade_backs_up_previous_bytes(self):
        self.install(apply=True)
        path = self.source / 'skills/hub-status/SKILL.md'
        original = path.read_bytes()
        path.write_bytes(original + b'\nNew upstream instructions.\n')
        result = self.install(apply=True)
        self.assertTrue(result['ok'])
        self.assertEqual((self.target / 'skills/hub-status/SKILL.md').read_bytes(), path.read_bytes())
        manifest = json.loads((Path(result['backup_directory']) / 'manifest.json').read_text())
        record = next(r for r in manifest['files'] if r['path'] == str(self.target / 'skills/hub-status/SKILL.md'))
        self.assertEqual(Path(record['backup']).read_bytes(), original)

    def test_missing_external_connection_is_allowed_but_relative_directory_and_bundled_paths_fail(self):
        missing = self.root / 'new-client/client.json'
        result = native.install(self.home, self.source, missing)
        self.assertTrue(result['ok'])
        for bad in (Path('relative.json'), self.config.parent, self.source / 'client.json',
                    self.source.parent.parent / 'client.json', self.target / 'client.json'):
            with self.subTest(path=str(bad)), self.assertRaises(ValueError):
                native.install(self.home, self.source, bad, apply=True)
        self.assertFalse(self.home.exists())

    def test_installer_never_reads_connection_contents_or_copies_sdk_environment(self):
        (self.source / 'sdk-venv').mkdir()
        (self.source / 'sdk-venv/private.json').write_text('private runtime')
        original = Path.read_bytes
        def checked(path, *args, **kwargs):
            if path == self.config:
                raise AssertionError('Installer read private client.json')
            return original(path, *args, **kwargs)
        with patch.object(Path, 'read_bytes', checked):
            result = self.install(apply=True)
        self.assertTrue(result['ok'])
        self.assertFalse((self.target / 'sdk-venv').exists())

    def test_empty_or_foreign_ownership_manifest_is_rejected(self):
        self.target.mkdir(parents=True)
        state = self.target / native.STATE_NAME
        for value in ({}, {'owner': 'other', 'format': 1}, {'owner': native.NAME, 'format': 1, 'files': []}):
            state.write_text(json.dumps(value))
            with self.assertRaises(ValueError):
                self.install(apply=True)
            self.assertEqual(self.tree(self.target), {native.STATE_NAME: state.read_bytes()})

    def test_symbolic_source_asset_is_rejected_before_write(self):
        path = self.source / 'assets/icon.svg'
        path.unlink()
        try:
            path.symlink_to(self.config)
        except OSError:
            self.skipTest('Creating symbolic links requires privileges on this platform')
        with self.assertRaisesRegex(ValueError, 'symbolic link'):
            self.install(apply=True)
        self.assertFalse(self.home.exists())

    def test_partial_write_failure_rolls_back_managed_changes(self):
        self.install(apply=True)
        before = self.tree(self.target)
        for name in ('plugin.json', 'README.md'):
            file = self.source / name
            file.write_bytes(file.read_bytes() + b'\n')
        real = native.atomic_write
        def fail_second(path, content):
            if path == self.target / 'README.md' and content != before['README.md']:
                raise OSError('injected failure')
            return real(path, content)
        with patch.object(native, 'atomic_write', side_effect=fail_second), self.assertRaisesRegex(OSError, 'injected'):
            self.install(apply=True)
        self.assertEqual(self.tree(self.target), before)

    def test_concurrent_editor_bytes_are_preserved(self):
        self.install(apply=True)
        first = self.source / 'plugin.json'
        first.write_bytes(first.read_bytes() + b'\n')
        next_file = self.source / 'README.md'
        next_file.write_bytes(next_file.read_bytes() + b'\n')
        real = native.atomic_write
        changed = self.target / 'README.md'
        original_manifest = (self.target / 'plugin.json').read_bytes()
        def edit_concurrently(path, content):
            result = real(path, content)
            if path == self.target / 'plugin.json':
                changed.write_bytes(b'concurrent human edit')
            return result
        with patch.object(native, 'atomic_write', side_effect=edit_concurrently), self.assertRaisesRegex(ValueError, 'concurrent edits'):
            self.install(apply=True)
        self.assertEqual(changed.read_bytes(), b'concurrent human edit')
        self.assertEqual((self.target / 'plugin.json').read_bytes(), original_manifest)

    def test_cli_conflict_exits_nonzero(self):
        self.target.mkdir(parents=True)
        (self.target / 'plugin.json').write_text('{"name":"user-managed"}')
        with contextlib.redirect_stdout(io.StringIO()):
            status = native.main(['--home', str(self.home), '--source', str(self.source),
                                  '--config', str(self.config), '--apply'])
        self.assertEqual(status, 1)

    def test_install_does_not_require_python39_path_containment_method(self):
        # Expose only the containment API available in Python 3.8. Patching
        # pathlib itself is unsuitable: Python 3.12's relative_to internally
        # calls is_relative_to, unlike the Python 3.8 implementation.
        class Python38Path:
            def __init__(self, value):
                self.path = Path(value)

            def relative_to(self, parent):
                return self.path.relative_to(parent)

        self.assertTrue(native.is_within(Python38Path(self.target / 'client.json'), self.target))
        self.assertTrue(native.is_within(Python38Path(self.target), self.target))
        self.assertFalse(native.is_within(Python38Path(self.target.with_name('multi-agent-hub-other')), self.target))


if __name__ == '__main__':
    unittest.main(verbosity=2)
