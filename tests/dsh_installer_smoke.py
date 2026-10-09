import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "integrations/dsh/install-dsh.py"
spec = importlib.util.spec_from_file_location("dsh_installer", SOURCE)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="agenthub-dsh-tests-")
        self.home = Path(self.temporary.name).resolve()
        self.assertEqual(self.home.parent, Path(tempfile.gettempdir()).resolve())
        self.profile = self.home / "profiles" / "web"
        self.profile.mkdir(parents=True)
        self.package = self.profile / "package.json"
        self.package.write_text(json.dumps({"name": "user-profile", "custom": {"keep": True}, "dependencies": {"user-plugin": "1.2.3"}, "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "user-bundle"]}}}), encoding="utf-8")
        self.patch = self.profile / "cordis.patch.yml"
        self.persona = "# user comment\n- id: user-group\n  config:\n    plugins:\n      - id: persona\n        name: user-persona\n        config:\n          text: Keep me\n"
        self.patch.write_bytes(self.persona.encode("utf-8"))

    def tearDown(self):
        self.temporary.cleanup()

    def test_no_profile_fallback_or_traversal(self):
        original = self.patch.read_bytes()
        self.assertEqual(installer.find_target_patch_file(self.home, "missing"), self.home / "profiles/missing/cordis.patch.yml")
        with self.assertRaises(ValueError):
            installer.prepare_profile(self.home, "missing")
        for name in ("../web", "C:/outside", "..", "/outside"):
            with self.assertRaises(ValueError):
                installer.find_target_patch_file(self.home, name)
        self.assertEqual(self.patch.read_bytes(), original)

    def test_persona_and_unrelated_manifest_survive_install_update_uninstall(self):
        installer.prepare_profile(self.home, "web", "http://127.0.0.1:9900/mcp", "FAKE_TOKEN")
        installer.prepare_profile(self.home, "web")
        content = self.patch.read_text(encoding="utf-8")
        self.assertTrue(content.startswith(self.persona))
        self.assertEqual(content.count(installer.BLOCK_BEGIN), 1)
        self.assertIn("9900/mcp", content)
        self.assertIn("FAKE_TOKEN", content)
        package = json.loads(self.package.read_text(encoding="utf-8"))
        self.assertEqual(package["custom"], {"keep": True})
        self.assertEqual(package["dependencies"]["user-plugin"], "1.2.3")
        self.assertEqual(package["dsh"]["profile"]["bundles"].count(installer.BUNDLE_NAME), 1)
        installer.prepare_profile(self.home, "web", uninstall=True)
        self.assertEqual(self.patch.read_text(encoding="utf-8"), self.persona)

    def test_legacy_custom_environment_and_js_are_preserved(self):
        legacy = "- id: mcp-agenthub\n  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    transport: stdio\n    env:\n      AGENTHUB_URL: 'http://host.test:8765/mcp?token=FAKE_URL_TOKEN'\n      HUB_TOKEN: !!js process.env.CUSTOM_HUB_TOKEN\n      CUSTOM: 'keep me'\n    toolCallTimeoutMs: 420000\n"
        self.patch.write_text(self.persona + legacy, encoding="utf-8")
        installer.prepare_profile(self.home, "web")
        content = self.patch.read_text(encoding="utf-8")
        self.assertTrue(content.startswith(self.persona))
        for value in ("FAKE_URL_TOKEN", "!!js process.env.CUSTOM_HUB_TOKEN", "CUSTOM: 'keep me'", "420000"):
            self.assertIn(value, content)
        installer.prepare_profile(self.home, "web", url="http://new.test/mcp")
        content = self.patch.read_text(encoding="utf-8")
        self.assertIn("http://new.test/mcp", content)
        self.assertIn("!!js process.env.CUSTOM_HUB_TOKEN", content)
        self.assertNotIn("host.test", content)

    def test_invalid_json_or_managed_markers_do_not_mutate_profile(self):
        self.package.write_text("bad json", encoding="utf-8")
        original = self.patch.read_bytes()
        with self.assertRaises(json.JSONDecodeError):
            installer.prepare_profile(self.home, "web")
        self.assertEqual(self.package.read_text(), "bad json")
        self.assertEqual(self.patch.read_bytes(), original)
        with self.assertRaises(ValueError):
            installer.strip_managed_content(self.persona + installer.BLOCK_BEGIN + "\n")

    def test_null_environment_is_rejected_without_any_profile_mutation(self):
        self.patch.write_text(self.persona + "- id: mcp-agenthub\n  config:\n    env:\n      HUB_TOKEN:\n", encoding="utf-8")
        before = (self.patch.read_bytes(), self.package.read_bytes())
        with self.assertRaisesRegex(ValueError, "empty/null YAML value: HUB_TOKEN"):
            installer.prepare_profile(self.home, "web")
        self.assertEqual((self.patch.read_bytes(), self.package.read_bytes()), before)
        self.assertEqual(list(self.profile.glob("*.bak-*")), [])

    def test_literal_environment_preserves_comments_and_blank_lines(self):
        scalar = "      CUSTOM: |+\n        first line\n\n        # literal comment\n        last line\n\n"
        self.patch.write_bytes((self.persona + "- id: mcp-agenthub\n  config:\n    env:\n" + scalar).encode("utf-8"))
        installer.prepare_profile(self.home, "web")
        self.assertIn(scalar, self.patch.read_bytes().decode("utf-8"))

    def test_second_file_write_failure_restores_both_original_files(self):
        before = (self.patch.read_bytes(), self.package.read_bytes())
        actual_write = installer._atomic_write
        def write_then_fail(path, content):
            if path == self.patch:
                raise OSError("simulated patch write failure")
            return actual_write(path, content)
        with patch.object(installer, "_atomic_write", write_then_fail):
            with self.assertRaisesRegex(OSError, "simulated"):
                installer.prepare_profile(self.home, "web")
        self.assertEqual((self.patch.read_bytes(), self.package.read_bytes()), before)

    @unittest.skipUnless(os.name == "nt", "Windows launcher")
    def test_windows_launcher_requires_arguments_and_uses_configured_python(self):
        launcher = SOURCE.with_name("install.bat")
        env = {**os.environ, "HUB_PYTHON": sys.executable, "DSH_HOME": str(self.home)}
        before = (self.patch.read_bytes(), self.package.read_bytes())
        command = [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", str(launcher)]
        empty = subprocess.run(command, cwd=self.home, env=env, capture_output=True, timeout=10)
        self.assertEqual(empty.returncode, 2)
        checked = subprocess.run(command + ["--profile", "web", "--check"], cwd=self.home, env=env, capture_output=True, timeout=10)
        self.assertEqual(checked.returncode, 0, checked.stderr.decode(errors="replace"))
        self.assertIn(b"does not launch", checked.stdout)
        self.assertEqual((self.patch.read_bytes(), self.package.read_bytes()), before)
        env["HUB_PYTHON"] = str(self.home / "missing-python.exe")
        missing = subprocess.run(command + ["--check"], cwd=self.home, env=env, capture_output=True, timeout=10)
        self.assertEqual(missing.returncode, 1)

    def test_template_uses_actual_bundle_insert_and_no_unresolved_script_placeholder(self):
        bundle = SOURCE.with_name("cordis.patch.yml").read_text(encoding="utf-8")
        self.assertIn("\n- insert:\n", bundle)
        self.assertNotIn("${MCP_SERVER_SCRIPT}", bundle)
        self.assertIn('name: "dsh-plugin-multi-agent-hub"', bundle)
        for preset in installer.PRESET_IDS:
            self.assertEqual(bundle.count("id: " + preset + "\n"), 1)
        generated = installer.load_template_yaml("http://localhost/mcp", "FAKE_TOKEN")
        self.assertIn("AGENTHUB_URL", generated)
        self.assertIn("HUB_TOKEN", generated)
        self.assertNotIn("insert:", generated)

if __name__ == "__main__":
    unittest.main()
