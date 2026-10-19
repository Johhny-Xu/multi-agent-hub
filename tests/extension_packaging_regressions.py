#!/usr/bin/env python3
"""Regression tests for VSIX and CARTS extension packages."""

import json
import unittest
import zipfile
from pathlib import Path

class TestExtensionPackaging(unittest.TestCase):
    _created_dist = False

    @classmethod
    def setUpClass(cls):
        cls.repo_root = Path(__file__).resolve().parent.parent
        cls.dist_dir = cls.repo_root / "integrations" / "vscode" / "dist"
        # 版本号从 integrations/vscode/package.json 派生，避免每次发版都要来这里改文件名
        cls.version = json.loads(
            (cls.repo_root / "integrations" / "vscode" / "package.json").read_text(encoding="utf-8")
        )["version"]
        if not (cls.dist_dir / f"multi-agent-hub-{cls.version}.vsix").exists():
            import subprocess, sys
            cls._created_dist = not cls.dist_dir.exists()
            subprocess.run([sys.executable, str(cls.repo_root / "packaging" / "package_extensions.py")], check=True)

    @classmethod
    def tearDownClass(cls):
        if cls._created_dist and cls.dist_dir.exists():
            import shutil
            shutil.rmtree(cls.dist_dir, ignore_errors=True)

    def setUp(self):
        v = self.version
        self.vsix = self.dist_dir / f"multi-agent-hub-{v}.vsix"
        self.carts = self.dist_dir / f"multi-agent-hub-{v}.carts"
        self.cloudide = self.dist_dir / f"multi-agent-hub-{v}.cloudide"

    def test_artifacts_exist(self):
        self.assertTrue(self.vsix.exists(), "VSIX artifact missing")
        self.assertTrue(self.carts.exists(), "CARTS artifact missing")
        self.assertTrue(self.cloudide.exists(), "CloudIDE artifact missing")

    def test_vsix_structure(self):
        for pkg in (self.vsix, self.carts, self.cloudide):
            with zipfile.ZipFile(pkg, "r") as zf:
                names = zf.namelist()
                self.assertIn("[Content_Types].xml", names)
                self.assertIn("extension.vsixmanifest", names)
                self.assertIn("extension/package.json", names)
                self.assertIn("extension/extension.js", names)
                self.assertIn("extension/resources/icon.png", names)
                self.assertIn("extension/mcp/server.mjs", names)

                # Validate package.json inside zip
                with zf.open("extension/package.json") as f:
                    pkg_data = json.load(f)
                    self.assertEqual(pkg_data["name"], "multi-agent-hub")
                    self.assertEqual(pkg_data["version"], self.version)
                    self.assertEqual(pkg_data["publisher"], "agenthub")

                # Validate [Content_Types].xml
                with zf.open("[Content_Types].xml") as f:
                    xml_content = f.read().decode("utf-8")
                    self.assertIn("vsixmanifest", xml_content)
                    self.assertIn("application/json", xml_content)

                # Validate extension.vsixmanifest
                with zf.open("extension.vsixmanifest") as f:
                    manifest_content = f.read().decode("utf-8")
                    self.assertIn('Identity Id="multi-agent-hub"', manifest_content)
                    self.assertIn('Publisher="agenthub"', manifest_content)

if __name__ == "__main__":
    unittest.main()
