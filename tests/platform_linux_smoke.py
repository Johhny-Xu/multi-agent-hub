"""Real Linux launcher/process checks; fixture responses are explicitly synthetic."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
from command_runtime import spawn_owned, terminate_owned
SPEC = importlib.util.spec_from_file_location("linux_services", ROOT / "scripts/remote_linux_services.py")
if sys.platform == "linux":
    services = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(services)


def port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def command(argv, cwd=None, env=None, timeout=15):
    proc = spawn_owned(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        output, _ = proc.communicate(timeout=timeout)
        return proc.returncode, output.decode("utf-8", "replace")
    finally:
        terminate_owned(proc)
        proc.stdout.close()


@unittest.skipUnless(sys.platform == "linux", "Requires a real Linux kernel with /proc")
class LinuxPlatformTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="agenthub-linux-platform-"))
        self.root = self.base / "workspace with spaces"
        for folder in ("hub", "console", "scripts"):
            (self.root / folder).mkdir(parents=True, exist_ok=True)
        for name in ("start.sh", "stop.sh", "console/run.sh", "scripts/remote_linux_services.py"):
            shutil.copy2(ROOT / name, self.root / name)
        self.hub_port, self.console_port = port(), port()
        (self.root / "hub/agents.example.json").write_text('{"agents":{}}')
        (self.root / "hub/agent_hub.py").write_text('''import argparse,json,os,time
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
p=argparse.ArgumentParser();p.add_argument('--http',type=int);p.add_argument('--host');a=p.parse_args()
class H(BaseHTTPRequestHandler):
 def do_GET(self):
  b=json.dumps({'service':'agent-hub','status':'SYNTHETIC_LOCAL_FIXTURE'}).encode();self.send_response(200);self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
 def log_message(self,*args):pass
if os.environ.get('FIXTURE_SLEEP'):time.sleep(30)
ThreadingHTTPServer((a.host,a.http),H).serve_forever()
''')
        (self.root / "console/server.mjs").write_text('''import http from 'node:http';
if(process.env.FIXTURE_FAIL)process.exit(23);
http.createServer((q,r)=>{r.end(JSON.stringify({url:process.env.HUBCONSOLE_SERVER_URL,token:process.env.HUBCONSOLE_SERVER_TOKEN}))}).listen(Number(process.env.HUBCONSOLE_PORT),process.env.HUBCONSOLE_HOST);
''')
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("HUB_", "HUBCONSOLE_", "AGENTHUB_", "FIXTURE_"))}
        self.env.update(HUB_RESULTS_DIR=str(self.base / "results"), HUB_STATE_DIR=str(self.base / "state"))
        self.settings = ("AGENTHUB_HOST=127.0.0.1\nAGENTHUB_PORT=" + str(self.hub_port)
                         + "\nHUBCONSOLE_HOST=127.0.0.1\nHUBCONSOLE_PORT=" + str(self.console_port)
                         + '\nHUB_TOKEN="FAKE_TOKEN $literal # quoted"\n')
        (self.root / ".env").write_text(self.settings)

    def tearDown(self):
        code, output = self.launch("stop")
        self.assertEqual(code, 0, output)

    def launch(self, action):
        return command(["bash", str(self.root / (action + ".sh")), "--health-timeout", "2"],
                       env=self.env, timeout=12)

    def test_owned_start_stop_loads_literal_env_and_preserves_created_template(self):
        code, output = self.launch("start")
        self.assertEqual(code, 0, output)
        from urllib.request import ProxyHandler, build_opener
        urlopen = build_opener(ProxyHandler({})).open  # bypass env proxies for loopback
        with urlopen("http://127.0.0.1:" + str(self.console_port), timeout=2) as response:
            received = json.load(response)
        self.assertEqual(received, {"url": "http://127.0.0.1:" + str(self.hub_port) + "/mcp",
                                    "token": "FAKE_TOKEN $literal # quoted"})
        records = [json.loads((self.root / (".run/" + name + ".linux.json")).read_text()) for name in ("hub", "console")]
        self.assertEqual(self.launch("stop")[0], 0)
        for record in records:
            self.assertIsNone(services.process_identity(record["pid"]))
        self.assertEqual(json.loads((self.root / "hub/agents.json").read_text()), {"agents": {}})

    def test_failed_console_rolls_back_its_new_hub(self):
        (self.root / ".env").write_text(self.settings + "FIXTURE_FAIL=1\n")
        code, output = self.launch("start")
        self.assertNotEqual(code, 0)
        self.assertIn("exited", output.lower())
        self.assertFalse((self.root / ".run/hub.linux.json").exists())
        self.assertFalse((self.root / ".run/console.linux.json").exists())
        with socket.socket() as client:
            self.assertNotEqual(client.connect_ex(("127.0.0.1", self.hub_port)), 0)

    def test_live_unrelated_listener_is_not_accepted_as_our_hub(self):
        from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
        import threading
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = b'{"service":"agent-hub"}'
                self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", self.hub_port), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            (self.root / ".env").write_text(self.settings + "FIXTURE_SLEEP=1\n")
            code, output = self.launch("start")
            self.assertNotEqual(code, 0)
            self.assertIn("health check timed out", output)
            self.assertFalse((self.root / ".run/hub.linux.json").exists())
            self.assertFalse((self.root / ".run/console.linux.json").exists())
        finally:
            server.shutdown(); server.server_close(); thread.join(2)

    def test_mismatched_creation_time_preserves_unrelated_process(self):
        unrelated = spawn_owned([sys.executable, "-c", "import time;time.sleep(30)"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            (self.root / ".run").mkdir()
            (self.root / ".run/hub.linux.json").write_text(json.dumps({"root": str(self.root), "pid": unrelated.pid,
                "start_ticks": "1", "entry": str(self.root / "hub/agent_hub.py"), "own_group": True}))
            self.assertEqual(self.launch("stop")[0], 0)
            self.assertIsNone(unrelated.poll())
        finally:
            terminate_owned(unrelated)

    def test_node_minimum_version_and_env_are_checked_before_spawn(self):
        fake = self.base / "bin"
        fake.mkdir()
        node = fake / "node"
        node.write_text('#!/bin/sh\necho v18.20.0\n')
        node.chmod(0o700)
        with self.assertRaisesRegex(ValueError, "20"):
            services.node_runtime({"PATH": str(fake)})
        (self.root / ".env").write_text(self.settings + 'CUSTOM="$(touch injected)"\n')
        parsed = services.environment(self.root)
        self.assertEqual(parsed["CUSTOM"], "$(touch injected)")
        self.assertFalse((self.root / "injected").exists())

    def test_native_posix_owned_group_reclaims_descendant_after_root_exit(self):
        child_file = self.base / "descendant.json"
        script = "import os,subprocess,sys,json; p=subprocess.Popen([sys.executable,'-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(30)']);open(sys.argv[1],'w').write(json.dumps(p.pid))"
        proc = spawn_owned([sys.executable, "-c", script, str(child_file)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        child = None
        try:
            proc.wait(timeout=3)
            child = json.loads(child_file.read_text())
            self.assertIsNotNone(services.process_identity(child))
            terminate_owned(proc)
            deadline = time.monotonic() + 3
            while services.process_identity(child) and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertIsNone(services.process_identity(child))
        finally:
            terminate_owned(proc)
            if child and services.process_identity(child):
                os.kill(child, signal.SIGKILL)

    def test_linux_shell_sources_have_lf_endings(self):
        for name in ("start.sh", "stop.sh", "console/run.sh"):
            self.assertNotIn(b"\r", (ROOT / name).read_bytes(), name)


if __name__ == "__main__":
    unittest.main(verbosity=2)
