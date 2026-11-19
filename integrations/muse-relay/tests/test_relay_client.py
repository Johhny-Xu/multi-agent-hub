import os
import unittest
from pathlib import Path

import support
from support import FakeOMB, ROOT, Sandbox


class RelayClientTest(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.cleanup)
        self.fake = FakeOMB(self.box.token).start()
        self.addCleanup(self.fake.close)
        self.box.write_config(self.fake.base_url)

    def test_poll_empty_updates_heartbeat(self):
        result = self.box.run("poll", "--wait-ms", "0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("status=empty", result.stdout)
        requests = self.fake.requests_snapshot()
        self.assertEqual(len(requests), 1)
        self.assertTrue(requests[0]["auth_ok"])

    def test_missing_config_fails_closed(self):
        self.box.config.unlink()
        result = self.box.run("poll", "--wait-ms", "0")
        self.assertEqual(result.returncode, 0)
        self.assertIn("status=error", result.stdout)
        self.assertIn("reason=config", result.stdout)
        self.assertEqual(self.fake.request_count(), 0)

    def test_config_permissions_must_be_0600(self):
        os.chmod(self.box.config, 0o644)
        result = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("reason=config", result.stdout)
        self.assertEqual(self.fake.request_count(), 0)

    def test_config_symlink_rejected(self):
        real = self.box.dir / "real-config.json"
        os.replace(self.box.config, real)
        os.symlink(real, self.box.config)
        result = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("reason=config", result.stdout)
        self.assertEqual(self.fake.request_count(), 0)

    def test_plain_http_non_loopback_rejected(self):
        self.box.write_config("http://192.0.2.1:9")
        result = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("reason=config", result.stdout)
        self.assertEqual(self.fake.request_count(), 0)

    def test_base_url_path_rejected(self):
        self.box.write_config("https://example.test/api")
        result = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("reason=config", result.stdout)

    def test_state_dir_inside_source_rejected(self):
        self.box.write_config(self.fake.base_url, state_dir=ROOT / "state-should-not-exist")
        result = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("reason=config", result.stdout)
        self.assertFalse((ROOT / "state-should-not-exist").exists())

    def test_redirect_is_not_followed(self):
        self.fake.script_poll(302, {"Location": "http://evil.test/steal"})
        result = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("reason=redirect", result.stdout)
        self.assertEqual(self.fake.request_count("poll"), 1)

    def test_401_reports_auth_without_token(self):
        self.box.write_config(self.fake.base_url, token="wrong-token-0123456789")
        result = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("reason=http_401", result.stdout)
        self.assertNotIn("wrong-token", result.stdout + result.stderr)
        self.box.assert_no_token(self, result.stdout, result.stderr)

    def test_invalid_poll_body_is_an_error(self):
        self.fake.script_poll_body({"schemaVersion": 1, "deliveries": "nope", "cancellations": [], "serverTime": "x"})
        result = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("reason=invalid_response", result.stdout)
        self.assertEqual(self.box.pending_files(), [])

    def test_empty_object_is_not_no_task(self):
        self.fake.script_poll_body({})
        result = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("reason=invalid_response", result.stdout)
        self.assertEqual(self.box.pending_files(), [])

    def test_wrong_connection_id_is_404(self):
        self.box.write_config(self.fake.base_url, connection_id="other")
        result = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("reason=http_404", result.stdout)

    def test_state_dir_command(self):
        result = self.box.run("state-dir")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), str(self.box.state))

    def test_poll_backoff_skips_network(self):
        self.box.write_config(self.fake.base_url)
        import json
        import time

        state = {
            "failures": 2,
            "nextPollAt": time.time() + 60,
            "lastReason": "http_503",
            "lastSuccessAt": 0,
        }
        (self.box.state / "watch.state.json").write_text(json.dumps(state))
        result = self.box.run("poll", "--wait-ms", "0")
        self.assertIn("status=backoff", result.stdout)
        self.assertIn("reason=http_503", result.stdout)
        self.assertEqual(self.fake.request_count(), 0)


if __name__ == "__main__":
    unittest.main()
