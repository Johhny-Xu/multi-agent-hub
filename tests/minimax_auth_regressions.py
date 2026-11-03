"""MiniMax mcode OAuth persistence and keepalive regressions."""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
import minimax_auth  # noqa: E402

RECORD = "com.minimax.mcode.oauth.prod.cn\u0000fixture"


class FakeResponse:
    status = 200

    def __init__(self, payload):
        self.payload = payload

    def read(self):
        return json.dumps(self.payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class MiniMaxAuthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agenthub-minimax-auth-")
        self.root = Path(self.temp.name)
        self.auth_dir = self.root / "prod" / "cn" / "mcode-public"
        self.auth_dir.mkdir(parents=True)
        self.auth_file = self.auth_dir / "auth.json"
        self.state_file = self.auth_dir / "auth-state.json"

    def tearDown(self):
        self.temp.cleanup()

    def write_auth(self, *, expires_ms, access="old-access", refresh="old-refresh", status="authenticated"):
        self.auth_file.write_text(json.dumps({
            "schemaVersion": 1,
            "records": {
                RECORD: {
                    "accessToken": access,
                    "refreshToken": refresh,
                    "expiresAtMs": expires_ms,
                    "clientId": "mcode-public",
                    "generation": 7,
                    "loginEpoch": 3,
                },
            },
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        self.state_file.write_text(json.dumps({
            "schemaVersion": 2,
            "status": status,
            "storeKind": "file",
            "clientId": "mcode-public",
            "region": "cn",
            "generation": 7,
            "expiresAtMs": expires_ms,
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def test_token_outside_margin_is_not_refreshed(self):
        now = int(time.time() * 1000)
        self.write_auth(expires_ms=now + 3600_000)
        with patch.object(minimax_auth.urllib.request, "urlopen", side_effect=AssertionError("must not refresh")):
            result = minimax_auth.ensure_auth_file(self.auth_file, now_ms=now, margin_sec=1200)
        self.assertEqual(result["status"], "valid")
        self.assertNotIn("access_token", result)

    def test_expired_token_refreshes_rotates_and_persists(self):
        now = int(time.time() * 1000)
        self.write_auth(expires_ms=now - 60_000)
        seen = {}

        def fake_urlopen(request, timeout=0):
            seen["url"] = request.full_url
            seen["body"] = urllib.parse.parse_qs(request.data.decode("utf-8"))
            return FakeResponse({
                "access_token": "new-access",
                "refresh_token": "new-refresh",
                "expires_in": 3600,
                "token_type": "Bearer",
            })

        with patch.object(minimax_auth.urllib.request, "urlopen", side_effect=fake_urlopen):
            result = minimax_auth.ensure_auth_file(self.auth_file, now_ms=now, margin_sec=1200)

        self.assertEqual(result["status"], "refreshed")
        self.assertTrue(result["refresh_rotated"])
        self.assertEqual(seen["url"], "https://account.minimax.cn/oauth2/token")
        self.assertEqual(seen["body"]["client_id"], ["mcode-public"])
        self.assertEqual(seen["body"]["grant_type"], ["refresh_token"])
        self.assertEqual(seen["body"]["refresh_token"], ["old-refresh"])
        self.assertNotIn("app_id", seen["body"])
        self.assertNotIn("scope", seen["body"])

        auth = json.loads(self.auth_file.read_text(encoding="utf-8"))
        record = auth["records"][RECORD]
        self.assertEqual(record["accessToken"], "new-access")
        self.assertEqual(record["refreshToken"], "new-refresh")
        self.assertEqual(record["generation"], 8)
        self.assertGreater(record["expiresAtMs"], now)
        state = json.loads(self.state_file.read_text(encoding="utf-8"))
        self.assertEqual(state["status"], "authenticated")
        self.assertEqual(state["generation"], 8)
        self.assertEqual(state["expiresAtMs"], record["expiresAtMs"])
        self.assertEqual(list(self.auth_dir.glob(".auth.json.tmp-*")), [])

    def test_refused_refresh_preserves_old_tokens(self):
        now = int(time.time() * 1000)
        self.write_auth(expires_ms=now - 60_000)
        before = self.auth_file.read_text(encoding="utf-8")
        error = urllib.error.HTTPError(
            "https://account.minimax.cn/oauth2/token",
            400,
            "Bad Request",
            {},
            io.BytesIO(b'{"error":"invalid_grant","error_description":"start a new authorization"}'),
        )
        with patch.object(minimax_auth.urllib.request, "urlopen", side_effect=error):
            result = minimax_auth.ensure_auth_file(self.auth_file, now_ms=now)
        self.assertEqual(result["status"], "refresh_failed")
        self.assertIn("invalid_grant", result["error"])
        self.assertEqual(self.auth_file.read_text(encoding="utf-8"), before)
        self.assertNotIn("old-access", json.dumps(result))
        self.assertNotIn("old-refresh", json.dumps(result))

    def test_signed_out_state_never_refreshes(self):
        now = int(time.time() * 1000)
        self.write_auth(expires_ms=now - 60_000, status="signed-out")
        with patch.object(minimax_auth.urllib.request, "urlopen", side_effect=AssertionError("must not refresh")):
            result = minimax_auth.ensure_auth_file(self.auth_file, now_ms=now)
        self.assertEqual(result["status"], "not_authenticated")

    def test_auth_status_requires_unexpired_access_token(self):
        now = int(time.time() * 1000)
        self.write_auth(expires_ms=now - 1000)
        self.assertFalse(minimax_auth.has_valid_login(root=self.root, now_ms=now))
        self.assertEqual(minimax_auth.auth_status(root=self.root, now_ms=now)["reason"], "expired")
        self.write_auth(expires_ms=now + 3600_000)
        self.assertTrue(minimax_auth.has_valid_login(root=self.root, now_ms=now))

    def test_ensure_all_scans_region_directories(self):
        now = int(time.time() * 1000)
        self.write_auth(expires_ms=now - 60_000)
        with patch.object(minimax_auth.urllib.request, "urlopen", return_value=FakeResponse({
            "access_token": "scan-access",
            "refresh_token": "scan-refresh",
            "expires_in": 3600,
        })):
            results = minimax_auth.ensure_all(root=self.root, now_ms=now)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["status"], "refreshed")
        self.assertEqual(results[0]["region"], "cn")

    def test_safe_result_never_contains_token_material(self):
        now = int(time.time() * 1000)
        self.write_auth(expires_ms=now - 60_000)
        with patch.object(minimax_auth.urllib.request, "urlopen", return_value=FakeResponse({
            "access_token": "secret-access",
            "refresh_token": "secret-refresh",
            "expires_in": 3600,
        })):
            result = minimax_auth.ensure_auth_file(self.auth_file, now_ms=now)
        text = json.dumps(result)
        self.assertNotIn("secret-access", text)
        self.assertNotIn("secret-refresh", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
