#!/usr/bin/env python3
"""Validate provenance and conservative classification of actual platform reports.

This does not turn an unsupported or failed vendor request into a passing task.
It verifies the evidence structure independently from whether vendors succeeded.
"""
import argparse
import hashlib
import itertools
import json
from pathlib import Path
import struct
import sys
import unittest
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from remote_matrix_probe import png_blue, WORKERS


class EvidenceTests(unittest.TestCase):
    reports = []

    def test_fixture_is_entirely_blue_and_valid_png(self):
        data = png_blue()
        self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
        offset, compressed = 8, b""
        while offset < len(data):
            size = struct.unpack(">I", data[offset:offset+4])[0]
            kind, payload = data[offset+4:offset+8], data[offset+8:offset+8+size]
            crc = struct.unpack(">I", data[offset+8+size:offset+12+size])[0]
            self.assertEqual(crc, zlib.crc32(kind + payload))
            if kind == b"IHDR":
                self.assertEqual(struct.unpack(">IIBBBBB", payload), (64, 64, 8, 2, 0, 0, 0))
            if kind == b"IDAT":
                compressed += payload
            offset += 12 + size
        self.assertEqual(zlib.decompress(compressed), (b"\0" + b"\0\0\xff" * 64) * 64)

    def test_exact_sixteen_cells_each_worker_each_platform(self):
        expected = set(itertools.product(("off", "on"), (False, True), (False, True), (False, True)))
        for report in self.reports:
            self.assertEqual(len(report["cells"]), 128)
            for worker in WORKERS:
                cells = [cell for cell in report["cells"] if cell["worker"] == worker]
                self.assertEqual(len(cells), 16)
                self.assertEqual({(c["thinking"], c["stream"], c["image"], c["file"]) for c in cells}, expected)

    def test_failed_unsupported_blocked_are_never_generation_success(self):
        for report in self.reports:
            for cell in report["cells"]:
                if cell["outcome"] != "verified":
                    self.assertFalse(cell["generation_verified"])
                if cell["generation_verified"]:
                    self.assertEqual(cell["final"]["status"], "completed")
                    self.assertTrue(cell["final"]["answer"].strip())

    def test_cells_are_submitted_at_most_once_and_references_are_unique(self):
        for report in self.reports:
            refs = []
            for cell in report["cells"]:
                self.assertIn(cell["dispatch_count"], (0, 1))
                if cell["outcome"].startswith("not_executed"):
                    self.assertEqual(cell["dispatch_count"], 0)
                if cell.get("final", {}).get("ref"):
                    refs.append(cell["final"]["ref"])
            self.assertEqual(len(refs), len(set(refs)))

    def test_stream_off_has_no_progress_notifications(self):
        for report in self.reports:
            for cell in report["cells"]:
                if not cell["stream"] and cell["dispatch_count"]:
                    self.assertEqual(cell.get("progress_notifications", 0), 0)
                if cell.get("stream_observed"):
                    self.assertGreater(cell["progress_notifications"], 0)
                    self.assertIsNotNone(cell["first_progress_s"])

    def test_uploaded_windows_attachment_sizes_equal_local_fixtures(self):
        cross = self.reports[1]
        seen = 0
        for cell in cross["cells"]:
            uploaded = cell.get("remote_attachments")
            if uploaded:
                local = cell["fixture_metadata"]
                self.assertEqual([(f["name"], f["bytes"]) for f in local], [(f["name"], f["bytes"]) for f in uploaded])
                seen += 1
        self.assertGreater(seen, 0, "Need actual Windows attachments accepted by real Linux Hub")

    def test_image_hashes_match_verified_blue_fixture(self):
        expected = hashlib.sha256(png_blue()).hexdigest()
        for report in self.reports:
            for cell in report["cells"]:
                for fixture in cell.get("fixture_metadata", []):
                    if fixture["name"].endswith(".png"):
                        self.assertEqual(fixture["sha256"], expected)

    def test_counters_and_old_configuration_preservation(self):
        for report in self.reports:
            actual = {key: sum(cell["outcome"] == key for cell in report["cells"]) for key in report["counts"]}
            self.assertEqual(actual, report["counts"])
            self.assertFalse(report["windows_credentials_copied"])
            self.assertFalse(report["old_deployment_modified"])
        self.assertTrue(self.reports[1]["old_configuration_unchanged"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", default="docs/platform-matrix-fixed")
    args = parser.parse_args()
    EvidenceTests.reports = [json.loads((ROOT / (args.prefix + suffix)).read_text(encoding="utf-8"))
                             for suffix in ("-linux-native.json", "-windows-to-linux.json")]
    unittest.main(argv=[sys.argv[0]], verbosity=2)
