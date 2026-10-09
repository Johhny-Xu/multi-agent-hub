"""Real Windows venv redirector ownership, foreign-port rejection and tree cleanup."""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen
import venv
from unittest.mock import patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'packaging'))
import service
from runtime import atomic_json


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def listener_pid(port):
    result = subprocess.run(['powershell.exe', '-NoProfile', '-Command',
                             'Get-NetTCPConnection -State Listen -LocalPort ' + str(port) +
                             ' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess'],
                            capture_output=True, text=True, timeout=8,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    value = result.stdout.strip()
    return int(value) if value.isdigit() else None


@unittest.skipUnless(os.name == 'nt', 'Windows venv redirector regression')
class WindowsVenvService(unittest.TestCase):
    def test_stop_snapshot_excludes_older_stale_ppid_children(self):
        fixture = r'''
$created = [DateTime]::UtcNow
$rows = @(
 [pscustomobject]@{ProcessId=10; ParentProcessId=1; CreationDate=$created},
 [pscustomobject]@{ProcessId=11; ParentProcessId=10; CreationDate=$created.AddSeconds(1)},
 [pscustomobject]@{ProcessId=12; ParentProcessId=11; CreationDate=$created.AddSeconds(2)},
 [pscustomobject]@{ProcessId=20; ParentProcessId=10; CreationDate=$created.AddSeconds(-1)},
 [pscustomobject]@{ProcessId=21; ParentProcessId=20; CreationDate=$created.AddSeconds(3)}
)
@(Get-OwnedProcessRows $rows 10 | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress
'''
        launcher = str(ROOT / 'scripts/windows-services.ps1').replace("'", "''")
        # Load the actual function AST without running the launcher's main body.
        launcher_function = r'''
$tokens=$null; $parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('__PATH__',[ref]$tokens,[ref]$parseErrors)
$definition=$ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-OwnedProcessRows'},$true)[0]
Invoke-Expression $definition.Extent.Text
'''.replace('__PATH__', launcher)
        for source in (service.WINDOWS_PROCESS_TREE, launcher_function):
            with self.subTest(source='packaging' if source == service.WINDOWS_PROCESS_TREE else 'launcher'):
                result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', source + fixture],
                                        capture_output=True, text=True, timeout=8,
                                        creationflags=subprocess.CREATE_NO_WINDOW)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), [12, 11, 10])

    def test_failed_stop_preserves_process_record_and_reports_failure(self):
        with tempfile.TemporaryDirectory(prefix='agenthub-venv-stop-failure-') as temporary:
            lab = Path(temporary)
            record = lab / 'hub.json'
            atomic_json(record, {'prefix': str(lab.resolve()), 'pid': 12345,
                                 'identity': '123456', 'entry': str(lab / 'hub.py')})
            before = record.read_bytes()
            with patch.object(service, 'running', return_value=True), \
                    patch.object(service, 'run', return_value=SimpleNamespace(returncode=1)):
                with self.assertRaisesRegex(service.SetupError, 'record was preserved'):
                    service.stop_record(record, lab)
            self.assertEqual(record.read_bytes(), before)

    def test_real_venv_hub_descendant_listener_is_owned_and_fully_stopped(self):
        with tempfile.TemporaryDirectory(prefix='agenthub-venv-service-') as temporary:
            lab = Path(temporary)
            venv.EnvBuilder(with_pip=False).create(lab / 'venv')
            python = lab / 'venv/Scripts/python.exe'
            entry = ROOT / 'hub/agent_hub.py'
            (lab / 'agents.json').write_text('{}')
            env = dict(os.environ, HUB_TOKEN=secrets.token_hex(24),
                       HUB_AGENTS_FILE=str(lab / 'agents.json'), HUB_STATE_DIR=str(lab / 'state'),
                       HUB_RESULTS_DIR=str(lab / 'results'))
            port = free_port()
            url = 'http://127.0.0.1:' + str(port) + '/health'
            process = None
            record = lab / 'run/hub.json'
            foreign = None
            foreign_thread = None
            owner = None
            try:
                with (lab / 'out.log').open('wb') as output, (lab / 'err.log').open('wb') as error:
                    process = subprocess.Popen([str(python), str(entry), '--http', str(port), '--host', '127.0.0.1'],
                                               env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=error,
                                               creationflags=subprocess.CREATE_NO_WINDOW)
                stamp = service.identity(process.pid)
                self.assertIsNotNone(stamp)
                atomic_json(record, {'prefix': str(lab.resolve()), 'pid': process.pid,
                                     'identity': stamp, 'entry': str(entry)})
                service.wait_health(process, port, url, 'agent-hub', timeout=15, entry=entry, stamp=stamp)
                with urlopen(url, timeout=2) as response:
                    self.assertEqual(json.loads(response.read())['service'], 'agent-hub')
                owner = listener_pid(port)
                self.assertIsNotNone(owner)
                self.assertNotEqual(owner, process.pid, 'Fixture must exercise the actual Windows venv redirector')
                owner_stamp = service.identity(owner)
                self.assertFalse(service.owns_listener(process.pid, port, entry, '1'), 'A recycled root identity cannot own the listener')
                self.assertFalse(service.owns_listener(process.pid, port, lab / 'wrong-entry.py', stamp))

                class HealthyForeign(BaseHTTPRequestHandler):
                    def do_GET(self):
                        body = b'{"service":"agent-hub","status":"ok"}'
                        self.send_response(200)
                        self.send_header('Content-Length', str(len(body)))
                        self.end_headers()
                        self.wfile.write(body)

                    def log_message(self, *_args):
                        pass

                foreign = ThreadingHTTPServer(('127.0.0.1', 0), HealthyForeign)
                foreign_thread = threading.Thread(target=foreign.serve_forever, daemon=True)
                foreign_thread.start()
                self.assertFalse(service.owns_listener(process.pid, foreign.server_port, entry, stamp),
                                 'A healthy foreign Hub must not be adopted')
                service.stop_record(record, lab)
                process.wait(timeout=5)
                self.assertFalse(record.exists())
                deadline = time.monotonic() + 5
                while service.identity(owner) == owner_stamp and time.monotonic() < deadline:
                    time.sleep(.1)
                self.assertNotEqual(service.identity(owner), owner_stamp, 'Owned venv child survived stop')
                self.assertIsNone(listener_pid(port), 'Owned port remains listening after stop')
                with self.assertRaises(OSError):
                    urlopen(url, timeout=1)
                with urlopen('http://127.0.0.1:' + str(foreign.server_port), timeout=1) as response:
                    self.assertEqual(response.status, 200, 'Stopping our tree must not affect the foreign server')
            finally:
                if foreign is not None:
                    foreign.shutdown()
                    foreign.server_close()
                    foreign_thread.join(timeout=3)
                # The retained Popen handle identifies this test's live launch
                # root. Never kill another process by executable name or port.
                if process is not None and process.poll() is None:
                    subprocess.run(['taskkill.exe', '/PID', str(process.pid), '/T', '/F'],
                                   capture_output=True, timeout=10,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
                    process.wait(timeout=5)


if __name__ == '__main__':
    unittest.main(verbosity=2)
