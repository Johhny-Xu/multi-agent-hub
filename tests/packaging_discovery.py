"""Isolated HTTP pairing and discovery installation tests; never calls a model."""
import contextlib
import io
import json
import os
import socket
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'packaging'))
import build
import connect
import install

EMPTY = {'candidates': [], 'errors': [], 'manual_required': True}
TOKEN = 'SYNTHETIC_HUB_PAIRING_TOKEN_' + 'x' * 40


@contextlib.contextmanager
def mock_hub(token=TOKEN, mode='ok'):
    state = SimpleNamespace(token=token, mode=mode, auth=[], stopping=threading.Event(), redirect=None)
    class Handler(BaseHTTPRequestHandler):
        def send(self, value, code=200):
            raw = json.dumps(value).encode()
            self.send_response(code); self.send_header('Content-Length', str(len(raw))); self.end_headers()
            self.wfile.write(raw)
        def do_GET(self):
            if state.mode == 'headers':
                for byte in b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}':
                    if state.stopping.wait(.06):
                        break
                    try:
                        self.wfile.write(bytes([byte])); self.wfile.flush()
                    except OSError:
                        break
                return
            if state.mode == 'body_wait':
                self.send_response(200); self.send_header('Content-Length', '100'); self.end_headers()
                self.wfile.write(b'{'); self.wfile.flush(); state.stopping.wait(2); return
            if state.mode == 'redirect':
                self.send_response(302); self.send_header('Location', state.redirect); self.send_header('Content-Length', '0'); self.end_headers(); return
            if state.mode == 'drip':
                raw = b'{"service":"agent-hub","status":"ok"}'
                self.send_response(200); self.send_header('Content-Length', str(len(raw))); self.end_headers()
                for byte in raw:
                    if state.stopping.wait(.06):
                        break
                    try:
                        self.wfile.write(bytes([byte])); self.wfile.flush()
                    except (OSError, BrokenPipeError):
                        break
                return
            self.send({'service': 'other' if state.mode == 'other' else 'agent-hub', 'status': 'ok'})
        def do_POST(self):
            authorization = self.headers.get('Authorization', '')
            state.auth.append(authorization)
            raw = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            request = json.loads(raw)
            if token and authorization != 'Bearer ' + token:
                self.send({'error': 'unauthorized'}, 401); return
            if request.get('method') != 'ping':
                self.send({'error': 'unexpected non-read-only method'}, 400); return
            self.send({'jsonrpc': '2.0', 'id': request['id'], **({'error': {'code': -32601}} if mode == 'no_ping' else {'result': {}})})
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    state.url = 'http://127.0.0.1:' + str(server.server_port) + '/mcp'
    try:
        yield state
    finally:
        state.stopping.set(); server.shutdown(); server.server_close(); thread.join(timeout=2)


class PairingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='agenthub-discovery-installer-')
        cls.lab = Path(cls.temporary.name)
        artifact = build.build(cls.lab / 'release', 'both')
        with zipfile.ZipFile(cls.lab / 'release' / artifact['file']) as archive:
            archive.extractall(cls.lab / 'bundle')
            for info in archive.infolist():
                if info.filename.endswith('.sh'):
                    (cls.lab / 'bundle' / info.filename).chmod(0o755)
        cls.bundle = cls.lab / 'bundle' / ('agenthub-' + build.VERSION + '-both')

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.case = Path(tempfile.mkdtemp(dir=self.lab))
        self.config = self.case / 'private config'
        self.path = self.config / 'client.json'
        self.prefix = self.case / 'installation with spaces'
        self.token_path = self.case / 'hub-token.txt'; self.token_path.write_text(TOKEN)

    def command(self, *args):
        output, error = io.StringIO(), io.StringIO()
        with patch.object(sys, 'argv', ['connect.py', '--config-dir', str(self.config), *map(str, args)]), \
             patch.object(sys, 'stdin', SimpleNamespace(isatty=lambda: False)), \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            code = connect.main()
        return code, output.getvalue(), error.getvalue()

    def installation(self, component='plugins', **overrides):
        args = dict(bundle=self.bundle, component=component, prefix=self.prefix, config_dir=self.config,
                    python=None, node=None, with_console=False, bind=None, port=None, console_port=None,
                    url=None, token_file=None, native_hosts='none', project=None, profile='discovery-test',
                    codex_home=None, zcode_home=None, dsh_home=None, codex_cli=None, zcode_cli=None, dsh_cli=None,
                    no_start=True, systemd_user=False, verify_connection=False)
        args.update(overrides)
        output = io.StringIO()
        with contextlib.redirect_stdout(output), patch.object(sys, 'stdin', SimpleNamespace(isatty=lambda: False)):
            code = install.install(SimpleNamespace(**args))
        return code, json.loads(output.getvalue())

    def test_health_and_authenticated_ping_are_required_without_proxy(self):
        with mock_hub() as hub, patch.dict(os.environ, {'HTTP_PROXY': 'http://127.0.0.1:9', 'HTTPS_PROXY': 'http://127.0.0.1:9', 'ALL_PROXY': 'http://127.0.0.1:9', 'NO_PROXY': ''}):
            status = connect.validate_connection(hub.url, TOKEN)
        self.assertEqual(status['status'], 'connected')
        self.assertEqual(hub.auth, ['Bearer ' + TOKEN])

    def test_wrong_service_auth_and_missing_ping_never_save(self):
        for mode in ('other', 'no_ping', 'ok'):
            with mock_hub(mode=mode) as hub:
                token = TOKEN if mode != 'ok' else 'incorrect token'
                with self.assertRaises(connect.SetupError):
                    connect.validate_connection(hub.url, token)
            self.assertFalse(self.path.exists())

    def test_redirect_is_not_followed_and_does_not_receive_token(self):
        with mock_hub() as destination, mock_hub(mode='redirect') as source:
            source.redirect = destination.url
            with self.assertRaises(connect.SetupError):
                connect.validate_connection(source.url, TOKEN)
        self.assertEqual(destination.auth, [])

    def test_slow_drip_has_absolute_deadline(self):
        for mode in ('drip', 'headers', 'body_wait'):
            with mock_hub(mode=mode) as hub:
                started = time.monotonic()
                with self.assertRaises(connect.SetupError):
                    connect.validate_connection(hub.url, TOKEN, timeout=.35)
                self.assertLess(time.monotonic() - started, 1, mode)

    def test_dns_deadline_cannot_later_send_credentials(self):
        release = threading.Event()
        real_lookup = socket.getaddrinfo
        calls = []
        def lookup(*args, **kwargs):
            calls.append(1)
            if len(calls) == 2:
                release.wait(2)
            return real_lookup(*args, **kwargs)
        with mock_hub() as hub, patch.object(connect.socket, 'getaddrinfo', side_effect=lookup):
            try:
                started = time.monotonic()
                with self.assertRaises(connect.SetupError):
                    connect.validate_connection(hub.url, TOKEN, timeout=.35)
                self.assertLess(time.monotonic() - started, 1)
            finally:
                release.set()
            time.sleep(.05)
            self.assertEqual(hub.auth, [])

    def test_no_candidates_prompts_manual_address_and_hidden_token(self):
        output = io.StringIO()
        with mock_hub() as hub, patch.object(connect, 'scan', return_value=EMPTY):
            answers = iter([hub.url, ''])
            value, status = connect.prepare(interactive=True, input_fn=lambda prompt: next(answers), secret_fn=lambda prompt: TOKEN, output=output)
        self.assertEqual(value, {'url': hub.url, 'token': TOKEN})
        self.assertTrue(status['verified'])
        self.assertNotIn(TOKEN, output.getvalue())
        self.assertIn('host:port', output.getvalue())

    def test_multiple_candidates_require_explicit_choice(self):
        with mock_hub() as hub:
            candidates = {'candidates': [{'url': 'http://127.0.0.1:9/mcp', 'name': 'other', 'auth_required': True},
                                         {'url': hub.url, 'name': 'selected', 'auth_required': True}], 'errors': [], 'manual_required': False}
            with patch.object(connect, 'scan', return_value=candidates):
                answers = iter(['2', str(self.token_path)])
                value, status = connect.prepare(interactive=True, input_fn=lambda prompt: next(answers), output=io.StringIO())
        self.assertEqual(value['url'], hub.url)
        self.assertTrue(status['verified'])

    def test_nontty_never_selects_single_or_multiple_candidates(self):
        for count in (0, 1, 2):
            result = {'candidates': [{'url': 'http://127.0.0.1:9/mcp', 'name': 'fixture'}] * count, 'errors': [], 'manual_required': count == 0}
            with patch.object(connect, 'scan', return_value=result), patch.object(connect, 'validate_connection') as validate:
                value, status = connect.prepare(interactive=False, input_fn=lambda prompt: self.fail('must not block'))
            self.assertIsNone(value)
            self.assertTrue(status['setup_required'])
            self.assertEqual(len(status['candidates']), count)
            validate.assert_not_called()

    def test_console_eof_defers_setup_without_losing_candidates(self):
        found = {'candidates': [{'url': 'http://127.0.0.1:9/mcp', 'name': 'fixture'}], 'errors': [], 'manual_required': False}
        with patch.object(connect, 'scan', return_value=found):
            value, status = connect.prepare(interactive=True, input_fn=lambda prompt: (_ for _ in ()).throw(EOFError()), output=io.StringIO())
        self.assertIsNone(value)
        self.assertEqual(status['candidates'], found['candidates'])

    def test_same_endpoint_retains_token_but_changed_endpoint_never_sends_it(self):
        with mock_hub() as first, mock_hub(token='DIFFERENT_SYNTHETIC_TOKEN_' + 'y' * 40) as second:
            previous = {'url': first.url, 'token': TOKEN}
            value, status = connect.prepare(first.url, existing=previous, interactive=False)
            self.assertEqual(value['token'], TOKEN)
            with self.assertRaises(connect.SetupError):
                connect.prepare(second.url, existing=previous, interactive=False)
            self.assertEqual(second.auth, [''])

    def test_cli_verified_save_backup_restart_guidance_and_failure_preservation(self):
        with mock_hub() as hub:
            code, output, error = self.command('--url', hub.url, '--token-file', self.token_path)
            self.assertEqual(code, 0, error)
            self.assertIn('Restart', json.loads(output)['next_step'])
            self.assertNotIn(TOKEN, output + error)
            before = self.path.read_bytes()
            self.token_path.write_text('INCORRECT_SYNTHETIC_TOKEN_' + 'y' * 40)
            code, output, error = self.command('--url', hub.url, '--token-file', self.token_path)
            self.assertEqual(code, 1)
            self.assertEqual(self.path.read_bytes(), before)
            self.assertFalse((self.config / 'backups').exists())
            self.token_path.write_text(TOKEN)
            self.assertEqual(self.command('--url', hub.url, '--token-file', self.token_path)[0], 0)
        backup = next((self.config / 'backups').glob('client-*.json'))
        self.assertEqual(backup.read_bytes(), before)
        if os.name != 'nt':
            self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600)

    def test_successful_explicit_repair_backs_up_corrupt_raw_configuration(self):
        self.config.mkdir()
        bad = b'{corrupt SYNTHETIC_PRIVATE_OLD_MARKER'
        self.path.write_bytes(bad)
        with mock_hub() as hub:
            code, output, error = self.command('--url', hub.url, '--token-file', self.token_path)
        self.assertEqual(code, 0, error)
        self.assertEqual(next((self.config / 'backups').glob('client-*.json')).read_bytes(), bad)
        self.assertNotIn('SYNTHETIC_PRIVATE_OLD_MARKER', output + error)

    def test_failed_repair_preserves_corrupt_configuration_without_backup(self):
        self.config.mkdir(); self.path.write_bytes(b'{corrupt')
        with mock_hub(mode='other') as hub:
            code, _, _ = self.command('--url', hub.url, '--token-file', self.token_path)
        self.assertEqual(code, 1)
        self.assertEqual(self.path.read_bytes(), b'{corrupt')
        self.assertFalse((self.config / 'backups').exists())

    def test_scan_is_read_only_even_with_corrupt_configuration(self):
        self.config.mkdir(); self.path.write_bytes(b'{corrupt')
        with patch.object(connect, 'scan', return_value=EMPTY), patch.object(connect, 'token_file') as read_token:
            self.assertEqual(self.command('--scan')[0], 0)
            self.assertEqual(self.command('--scan', '--token-file', self.token_path)[0], 1)
        read_token.assert_not_called()
        self.assertEqual(self.path.read_bytes(), b'{corrupt')

    def test_explicit_offline_configuration_is_never_claimed_connected(self):
        with patch.object(connect, 'validate_connection') as verify:
            code, output, error = self.command('--url', 'example.invalid:8765', '--token-file', self.token_path, '--save-offline')
        self.assertEqual(code, 0, error)
        self.assertEqual(json.loads(output)['connection']['status'], 'configured_unverified')
        verify.assert_not_called()

    def test_client_symlink_is_refused_without_modifying_target(self):
        self.config.mkdir(); target = self.case / 'owned-target.json'; target.write_text('synthetic target')
        try:
            self.path.symlink_to(target)
        except OSError:
            with patch.object(type(self.path), 'is_symlink', return_value=True):
                with self.assertRaises(connect.SetupError):
                    connect.existing_client(self.path, allow_invalid=True)
        else:
            with self.assertRaises(connect.SetupError):
                connect.save_connection(self.path, {'url': 'http://localhost/mcp', 'token': TOKEN})
        self.assertEqual(target.read_text(), 'synthetic target')

    def test_initial_nontty_install_reports_candidates_and_writes_no_fake_client(self):
        found = {'candidates': [{'url': 'http://127.0.0.1:9/mcp', 'name': 'fixture'}], 'errors': [], 'manual_required': False}
        with patch.object(connect, 'scan', return_value=found):
            code, result = self.installation()
        self.assertEqual(code, 0)
        self.assertTrue(result['setup_required'])
        self.assertEqual(result['connection']['status'], 'setup_required')
        self.assertEqual(result['connection']['candidates'], found['candidates'])
        self.assertFalse(self.path.exists())
        self.assertTrue((self.prefix / 'connect.cmd').is_file())
        self.assertTrue((self.prefix / 'connect.sh').is_file())

    def test_existing_connection_and_explicit_install_skip_scan(self):
        with patch.object(connect, 'scan') as scan:
            _, result = self.installation(url='example.invalid:8765', token_file=self.token_path)
            self.assertEqual(result['connection']['status'], 'configured_unverified')
            before = self.path.read_bytes()
            _, result = self.installation()
        scan.assert_not_called()
        self.assertFalse(result['setup_required'])
        self.assertEqual(self.path.read_bytes(), before)

    def test_verified_install_auth_failure_happens_before_payload_or_config_changes(self):
        with mock_hub() as hub, patch.object(connect, 'scan') as scan:
            _, result = self.installation(url=hub.url, token_file=self.token_path, verify_connection=True)
            self.assertEqual(result['connection']['status'], 'connected')
            before = self.path.read_bytes()
            self.token_path.write_text('INCORRECT_SYNTHETIC_TOKEN_' + 'y' * 40)
            with self.assertRaises(connect.SetupError):
                self.installation(url=hub.url, token_file=self.token_path, verify_connection=True)
        scan.assert_not_called()
        self.assertEqual(self.path.read_bytes(), before)

    def test_connect_wrapper_performs_real_pairing_from_paths_with_spaces(self):
        with mock_hub() as hub:
            if os.name == 'nt':
                argv = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(self.bundle / 'packaging/bootstrap.ps1'), '-Action', 'connect']
            else:
                argv = [str(self.bundle / 'connect.sh')]
            result = subprocess.run(argv + ['--prefix', str(self.prefix), '--config-dir', str(self.config), '--url', hub.url, '--token-file', str(self.token_path)],
                                    stdin=subprocess.DEVNULL, capture_output=True, encoding='utf-8', errors='replace', timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['connection']['verified'])
        self.assertNotIn(TOKEN, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
