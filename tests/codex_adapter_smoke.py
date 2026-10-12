"""Codex package/install/stdio integration checks in isolated local fixtures."""
import importlib.util
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PACKAGE = REPO / "integrations" / "codex"
sys.path.insert(0, str(REPO / "hub"))
from command_runtime import spawn_owned, terminate_owned

spec = importlib.util.spec_from_file_location("codex_adapter_installer", PACKAGE / "install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
NODE = shutil.which("node")
CODEX = os.environ.get("CODEX_TEST_BINARY")


def isolated_codex_env(home):
    env = os.environ.copy()
    for key in list(env):
        if any(word in key.upper() for word in ("TOKEN", "SECRET", "API_KEY", "PASSWORD", "CREDENTIAL")):
            env.pop(key)
    env.update(CODEX_HOME=str(home / ".codex"), HOME=str(home), USERPROFILE=str(home),
               APPDATA=str(home / "appdata"), LOCALAPPDATA=str(home / "localappdata"))
    return env


class Rpc:
    def __init__(self, command, cwd, env):
        self.proc = spawn_owned(command, cwd=cwd, env=env, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.messages = queue.Queue()
        self.id = 0
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def read(self):
        for line in iter(self.proc.stdout.readline, b""):
            try:
                self.messages.put(json.loads(line))
            except ValueError:
                self.messages.put({"invalid_stdout": line.decode("utf-8", "replace")[:200]})

    def call(self, method, params=None):
        self.id += 1
        data = {"jsonrpc": "2.0", "id": self.id, "method": method}
        if params is not None:
            data["params"] = params
        self.proc.stdin.write((json.dumps(data) + "\n").encode())
        self.proc.stdin.flush()
        reply = self.messages.get(timeout=4)
        if reply.get("id") != self.id:
            raise AssertionError("Invalid stdio MCP response: " + str(reply))
        return reply

    def tool(self, name, arguments):
        reply = self.call("tools/call", {"name": name, "arguments": arguments})
        return reply["result"], json.loads(reply["result"]["content"][0]["text"])

    def close(self):
        terminate_owned(self.proc)
        self.reader.join(2)
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            stream.close()
        if self.reader.is_alive():
            raise AssertionError("Owned MCP reader did not exit")


@unittest.skipUnless(NODE, "Node.js 20+ required")
class CodexAdapterTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="agenthub-codex-adapter-"))
        self.project = self.base / "project"
        self.project.mkdir()

    def cli(self, mode, *extra):
        proc = subprocess.run([sys.executable, str(PACKAGE / "install.py"), "--project", str(self.project), mode, *extra],
                              stdin=subprocess.DEVNULL, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=8)
        return proc

    def install(self):
        result = self.cli("--apply")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        return Path(json.loads(result.stdout)["plugin_directory"])

    def codex_call(self, arguments, cwd, env):
        proc = spawn_owned([CODEX, *arguments], cwd=cwd, env=env,
                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            stdout, stderr = proc.communicate(timeout=9)
            self.assertEqual(proc.returncode, 0, stderr.decode("utf-8", "replace"))
            return json.loads(stdout)
        finally:
            terminate_owned(proc)
            proc.stdout.close()
            proc.stderr.close()

    def test_portable_and_compat_manifests_use_supported_layout(self):
        portable = json.loads((PACKAGE / "plugin.json").read_text(encoding="utf-8"))
        compat = json.loads((PACKAGE / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(portable["$schema"], "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json")
        self.assertEqual(portable["name"], compat["name"])
        self.assertRegex(portable["name"], r"^[a-z][a-z0-9-]*$")
        self.assertEqual(portable["version"], compat["version"])
        self.assertNotIn("skills", portable)  # Portable components use fixed paths.
        self.assertNotIn("mcpServers", portable)
        self.assertEqual(compat["skills"], "./skills/")
        self.assertEqual(compat["mcpServers"], "./.mcp.json")
        self.assertEqual(portable["extensions"]["com.openai"]["interface"], compat["interface"])
        for filename in ("mcp.json", ".mcp.json"):
            document = json.loads((PACKAGE / filename).read_text(encoding="utf-8"))
            server = document["mcpServers"]["agenthub"]
            self.assertEqual(server["type"], "stdio")
            self.assertEqual(server["command"], "node")
            if filename == "mcp.json":
                self.assertEqual(server["args"], ["${PLUGIN_ROOT}/scripts/start.mjs"])
            else:
                # The legacy loader resolves cwd, but does not expand either
                # PLUGIN_ROOT or CLAUDE_PLUGIN_ROOT inside stdio arguments.
                self.assertEqual(server["args"], ["./scripts/start.mjs"])
                self.assertEqual(server["cwd"], "./")
            self.assertNotIn("env", server, "Package must not embed credentials")
        self.assertEqual(json.loads((PACKAGE / "package.json").read_text())["engines"]["node"], ">=20")

    def test_native_agents_parse_and_inherit_models_and_permissions(self):
        files = list((PACKAGE / "templates" / ".codex" / "agents").glob("*.toml"))
        self.assertEqual(len(files), 9)
        names = set()
        for path in files:
            agent = tomllib.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(set(agent), {"name", "description", "developer_instructions"})
            self.assertEqual(agent["name"], path.stem)
            self.assertTrue(agent["description"])
            self.assertTrue(agent["developer_instructions"])
            names.add(agent["name"])
        self.assertEqual(len(names), 9)

    def test_bundled_bridge_is_byte_identical_to_canonical_mcp(self):
        for name in installer.MCP_FILES:
            self.assertEqual((PACKAGE / "mcp" / name).read_bytes(), (REPO / "mcp" / name).read_bytes(), name)

    def test_skills_have_valid_frontmatter_and_no_missing_local_references(self):
        files = list((PACKAGE / "skills").glob("*/SKILL.md"))
        self.assertEqual(len(files), 3)
        for path in files:
            text = path.read_text(encoding="utf-8")
            header = re.match(r"---\nname: ([a-z0-9-]+)\ndescription: ([^\n]+)\n---\n", text)
            self.assertIsNotNone(header, path)
            self.assertEqual(header[1], path.parent.name)
            self.assertLessEqual(len(header[2]), 1024)
            for reference in re.findall(r"\]\(([^)]+)\)", text):
                if "://" not in reference:
                    self.assertTrue((path.parent / reference).is_file(), reference)

    def test_dry_run_is_read_only_and_missing_apply_mode_is_rejected(self):
        result = self.cli("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertFalse(report["config_modified"])
        self.assertTrue(all(item["action"] == "create" for item in report["files"]))
        self.assertEqual(list(self.project.iterdir()), [])
        rejected = subprocess.run([sys.executable, str(PACKAGE / "install.py"), "--project", str(self.project)],
                                  capture_output=True, timeout=5)
        self.assertEqual(rejected.returncode, 2)
        self.assertEqual(list(self.project.iterdir()), [])

    def test_apply_preserves_config_and_is_idempotent(self):
        codex = self.project / ".codex"
        codex.mkdir()
        existing = b'sandbox_mode = "read-only"\n[mcp_servers.unrelated]\ncommand = "existing"\n'
        (codex / "config.toml").write_bytes(existing)
        plugin = self.install()
        self.assertEqual((codex / "config.toml").read_bytes(), existing)
        self.assertEqual(len(list((codex / "agents").glob("*.toml"))), 9)
        fragment = tomllib.loads((codex / "agenthub.config.fragment.toml").read_text(encoding="utf-8"))
        self.assertEqual(fragment["agents"]["max_concurrent_threads_per_session"], 8)
        self.assertEqual(fragment["mcp_servers"]["agenthub"]["env_vars"], list(installer.FORWARDED_ENV))
        self.assertEqual(Path(fragment["mcp_servers"]["agenthub"]["args"][0]), plugin / "scripts" / "start.mjs")
        result = self.cli("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all(item["action"] == "unchanged" for item in json.loads(result.stdout)["files"]))

    def test_conflicting_file_blocks_all_writes_before_preflight(self):
        agents = self.project / ".codex" / "agents"
        agents.mkdir(parents=True)
        existing = agents / "agenthub_codebuddy.toml"
        content = b'name="agenthub_codebuddy"\ndescription="Existing custom behavior"\ndeveloper_instructions="Preserve me"\n'
        existing.write_bytes(content)
        result = self.cli("--apply")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(existing.read_bytes(), content)
        self.assertFalse((self.project / ".codex" / "plugins").exists())
        self.assertEqual(list(agents.glob("*.toml")), [existing])

    def test_same_agent_name_under_another_filename_is_preserved(self):
        agents = self.project / ".codex" / "agents"
        agents.mkdir(parents=True)
        existing = agents / "personal-router.toml"
        content = b'name="agenthub_codebuddy"\ndescription="Existing custom behavior"\ndeveloper_instructions="Preserve me"\n'
        existing.write_bytes(content)
        result = self.cli("--apply")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(existing.read_bytes(), content)
        self.assertFalse((self.project / ".codex" / "plugins").exists())

    def test_dedicated_plugin_target_can_be_outside_project(self):
        separate = self.base / "separate-plugin"
        result = self.cli("--apply", "--plugin-dir", str(separate))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((separate / "plugin.json").is_file())
        self.assertFalse((self.project / ".codex" / "plugins").exists())

    def test_copied_stdio_mcp_dispatches_once_and_preserves_unknown_and_empty_results(self):
        plugin = self.install()
        tasks, calls = {}, []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                params = request["params"]
                name, arguments = params["name"], params.get("arguments", {})
                calls.append((name, arguments))
                if name == "hub_dispatch_cli":
                    ref = "minimaxcode-" + format(len(tasks) + 1, "04x")
                    tasks[ref] = arguments["task"]
                    text = f"[minimaxcode/{ref}] status=running\nSYNTHETIC_LOCAL_TEST_ONLY"
                elif name in {"hub_result", "hub_wait_result"}:
                    ref = arguments["ref"]
                    mode = tasks[ref]
                    state = "unknown" if mode == "UNKNOWN" else "error" if mode == "FAIL" else "completed"
                    answer = "" if mode == "EMPTY" else "SYNTHETIC_ANSWER"
                    text = f"[{ref}] status={state}\n{answer}"
                elif name == "hub_login":
                    text = json.dumps({"worker": "minimaxcode", "status": "manual_required", "ok": False, "instructions": "SYNTHETIC fixture; no authentication", "token": "PRIVATE_SYNTHETIC_FIELD"})
                else:
                    text = "SYNTHETIC_REGISTERED_WORKERS"
                body = json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": {"content": [{"type": "text", "text": text}]}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .02}, daemon=True)
        thread.start()
        env = os.environ.copy()
        env.update(AGENTHUB_URL=f"http://127.0.0.1:{server.server_port}/mcp", HUB_MCP_URL="", HUB_TOKEN="SYNTHETIC_LOCAL_FIXTURE")
        rpc = None
        try:
            rpc = Rpc([NODE, str(plugin / "scripts" / "start.mjs")], self.project, env)
            initialized = rpc.call("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "isolated-codex-adapter-test", "version": "1"}})
            self.assertEqual(initialized["result"]["protocolVersion"], "2025-11-25")
            tools = rpc.call("tools/list")["result"]["tools"]
            self.assertEqual({tool["name"] for tool in tools}, {"hub_ask", "hub_dispatch", "hub_fetch", "hub_status", "hub_login", "hub_capabilities", "hub_discover", "hub_set_status"})
            _, dispatched = rpc.tool("hub_dispatch", {"worker": "mmx", "task": "SUCCESS", "timeout_s": 2})
            self.assertEqual(dispatched["status"], "running")
            self.assertTrue(dispatched["ref"])
            _, fetched = rpc.tool("hub_fetch", {"ref": dispatched["ref"]})
            self.assertEqual(fetched, {"status": "completed", "answer": "SYNTHETIC_ANSWER"})
            _, unknown_dispatch = rpc.tool("hub_dispatch", {"worker": "mmx", "task": "UNKNOWN", "timeout_s": 2})
            raw, unknown = rpc.tool("hub_fetch", {"ref": unknown_dispatch["ref"]})
            self.assertEqual(unknown["status"], "unknown")
            self.assertTrue(raw["isError"])
            raw, empty = rpc.tool("hub_ask", {"worker": "mmx", "task": "EMPTY", "timeout_s": 2})
            self.assertEqual(empty["status"], "completed")
            self.assertEqual(empty["answer"], "")
            _, failed = rpc.tool("hub_ask", {"worker": "mmx", "task": "FAIL", "timeout_s": 2})
            self.assertFalse(failed["ok"])
            self.assertEqual(failed["status"], "failed")
            _, public_login = rpc.tool("hub_login", {"worker": "mmx", "action": "status"})
            self.assertNotIn("PRIVATE_SYNTHETIC_FIELD", json.dumps(public_login))
            self.assertEqual(sum(name == "hub_dispatch_cli" for name, _ in calls), 4, "No empty/unknown redispatch")
        finally:
            if rpc:
                rpc.close()
            server.shutdown()
            server.server_close()
            thread.join(2)
            self.assertFalse(thread.is_alive())

    @unittest.skipUnless(CODEX, "Set CODEX_TEST_BINARY for optional isolated native parser check")
    def test_native_codex_cli_parses_reviewed_fragment_without_real_config_or_auth(self):
        self.install()
        home = self.base / "isolated-home"
        codex_home = home / ".codex"
        codex_home.mkdir(parents=True)
        fragment = (self.project / ".codex" / "agenthub.config.fragment.toml").read_bytes()
        (codex_home / "config.toml").write_bytes(fragment)
        servers = self.codex_call(["mcp", "list", "--json"], self.project, isolated_codex_env(home))
        self.assertTrue(any(server.get("name") == "agenthub" for server in servers), servers)

    @unittest.skipUnless(CODEX, "Set CODEX_TEST_BINARY for optional isolated native plugin checks")
    def test_native_codex_cli_loads_portable_and_compat_plugins_and_starts_their_mcp(self):
        for variant in ("portable", "compat"):
            with self.subTest(variant=variant):
                project = self.base / variant / "project"
                home = self.base / variant / "home"
                codex_home = home / ".codex"
                project.mkdir(parents=True)
                codex_home.mkdir(parents=True)
                plugin = project / "plugins" / "agenthub-workers"
                for source in installer.package_files():
                    relative = source.relative_to(PACKAGE)
                    if variant == "compat" and relative.as_posix() in {"plugin.json", "mcp.json"}:
                        continue  # Construct a legacy package without deleting files.
                    target = plugin / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(source.read_bytes())
                marketplace = project / ".agents" / "plugins" / "marketplace.json"
                marketplace.parent.mkdir(parents=True)
                marketplace.write_text(json.dumps({"name": "agenthub-test-fixture", "plugins": [{
                    "name": "agenthub-workers", "source": {"source": "local", "path": "./plugins/agenthub-workers"},
                    "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
                    "category": "Developer Tools"}]}), encoding="utf-8")
                (codex_home / "config.toml").write_text(
                    '[marketplaces.agenthub-test-fixture]\nsource_type = "local"\nsource = '
                    + installer.toml_string(project) + '\n[plugins."agenthub-workers@agenthub-test-fixture"]\nenabled = true\n',
                    encoding="utf-8")
                env = isolated_codex_env(home)
                installed = self.codex_call(["plugin", "add", "agenthub-workers@agenthub-test-fixture", "--json"], project, env)
                installed_path = Path(installed["installedPath"]).resolve()
                self.assertTrue(installed_path.is_relative_to(codex_home.resolve()))
                servers = self.codex_call(["mcp", "list", "--json"], project, env)
                transport = next(server["transport"] for server in servers if server["name"] == "agenthub")
                self.assertEqual(transport["type"], "stdio")
                command, arguments = transport["command"], transport["args"]
                self.assertNotIn("${", " ".join(arguments))
                cwd = Path(transport["cwd"]).resolve()
                self.assertEqual(cwd, installed_path)
                self.assertEqual((cwd / arguments[0]).resolve(), installed_path / "scripts" / "start.mjs")
                child_env = env | (transport.get("env") or {})
                child_env.update(AGENTHUB_URL="http://127.0.0.1:1/mcp", HUB_MCP_URL="", HUB_TOKEN="")
                rpc = Rpc([command, *arguments], cwd, child_env)
                try:
                    initialized = rpc.call("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                                                          "clientInfo": {"name": "native-plugin-fixture", "version": "1"}})
                    self.assertEqual(initialized["result"]["protocolVersion"], "2025-11-25")
                    self.assertEqual(len(rpc.call("tools/list")["result"]["tools"]), 7)
                finally:
                    rpc.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
