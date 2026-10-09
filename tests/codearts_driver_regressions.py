"""CodeArts CLI boundary regressions; fixtures are not live-provider evidence."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("codearts_cli", ROOT / "drivers/codearts_cli.py")
driver = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(driver)


def event(kind, part=None, **extra):
    return {"type": kind, "sessionID": "session-test", **({"part": part} if part is not None else {}), **extra}


def success(text="answer"):
    return "\n".join(json.dumps(record) for record in [
        event("step_start", {"type": "step-start"}),
        event("text", {"id": "part-test", "type": "text", "text": text, "time": {"end": 1}}),
        event("step_finish", {"type": "step-finish", "reason": "stop"}),
    ])


def containment_fixture(role, case, directory):
    """Private Linux sleep processes only; a separate supervisor reaps orphans."""
    directory = Path(directory)

    def identity(pid):
        try:
            value = (Path('/proc') / str(pid) / 'stat').read_text()
            fields = value[value.rfind(')') + 2:].split()
            return dict(pid=pid, state=fields[0], pgid=int(fields[2]), sid=int(fields[3]),
                        start=int(fields[19]))
        except (OSError, ValueError, IndexError):
            return None

    def alive(row):
        current = identity(row['pid'])
        return bool(current and current['start'] == row['start'] and current['state'] != 'Z')

    def save(name, value):
        temporary = directory / (name + '.tmp')
        temporary.write_text(json.dumps(value))
        temporary.replace(directory / name)

    def await_file(name):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if (directory / name).exists():
                return json.loads((directory / name).read_text())
            time.sleep(0.01)
        raise AssertionError('Fixture readiness timeout: ' + name)

    def command(next_role):
        return [sys.executable, str(Path(__file__).resolve()), '--containment-fixture',
                next_role, case, str(directory)]

    if role != 'supervisor':
        save(role + '.pid.json', identity(os.getpid()))
        if role == 'runner':
            try:
                driver._capture(command('child'), cwd=str(directory), env=dict(os.environ),
                                timeout=1 if 'timeout' in case else 15)
                result = 'returned'
            except driver.AdapterError as exc:
                result = exc.code
            save('result.json', result)
        elif role == 'child':
            subprocess.Popen(command('grandchild'))
            await_file('grandchild.pid.json')
            if 'root_exit' not in case and case != 'forged_marker':
                time.sleep(30)
        else:
            time.sleep(30)
        return

    # Scope subreaper behavior to this test supervisor, never the unittest host.
    import ctypes
    assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0
    sys.path.insert(0, str(ROOT / 'hub'))
    import command_runtime as runtime
    inherited = case.startswith('outer_') or case.startswith('inherited_')
    env = dict(os.environ)
    env.pop('AGENTHUB_OWNED_POSIX_GROUP', None)
    if case == 'forged_marker':
        env['AGENTHUB_OWNED_POSIX_GROUP'] = '1'
    runner = bystander = None
    try:
        bystander = subprocess.Popen(command('bystander'), env=env, start_new_session=True)
        await_file('bystander.pid.json')
        if inherited:
            runner = runtime.spawn_owned(command('runner'), env=env)
        else:
            runner = subprocess.Popen(command('runner'), env=env,
                                      start_new_session=case != 'forged_marker')
        grandchild = await_file('grandchild.pid.json')
        child = await_file('child.pid.json')
        root = await_file('runner.pid.json')
        if case.startswith('outer_'):
            os.killpg(runner.pid, signal.SIGTERM if case == 'outer_term' else signal.SIGKILL)
        runner.wait(timeout=6)
        if inherited:
            runtime.terminate_owned(runner)
        deadline = time.monotonic() + 3
        while any(alive(row) for row in (child, grandchild)) and time.monotonic() < deadline:
            time.sleep(0.01)
        result_path = directory / 'result.json'
        report = dict(case=case, runner=root, child=child, grandchild=grandchild,
                      children_stopped=all(not alive(row) for row in (child, grandchild)),
                      bystander_untouched=bystander.poll() is None,
                      result=json.loads(result_path.read_text()) if result_path.exists() else None)
    finally:
        # This also cleans the old broken implementation when a regression fails.
        rows = [json.loads(path.read_text()) for path in directory.glob('*.pid.json')]
        for row in rows:
            if not alive(row):
                continue
            if hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'):
                try:
                    handle = os.pidfd_open(row['pid'])
                except ProcessLookupError:
                    continue
                try:
                    if alive(row):
                        signal.pidfd_send_signal(handle, signal.SIGKILL)
                finally:
                    os.close(handle)
            elif alive(row):
                os.kill(row['pid'], signal.SIGKILL)
        for process in (runner, bystander):
            if process is not None:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=5)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if not pid:
                    time.sleep(0.01)
            except ChildProcessError:
                break
        assert all(not alive(row) for row in rows), 'Fixture cleanup incomplete'
    report['fixture_cleanup_complete'] = True
    print(json.dumps(report))


class CodeArtsDriver(unittest.TestCase):
    def test_exit_zero_auth_error_is_not_success(self):
        result = driver.parse_events("认证失败，没有设置环境变量CODEARTS_CLI_AK/CODEARTS_CLI_SK", "", 0)
        self.assertEqual(result["status"], "blocked_auth")
        self.assertEqual(result["error"]["code"], "CODEARTS_AUTH_REQUIRED")
        self.assertEqual(result["result"], "")

    def test_exit_zero_ide_without_provider_is_blocked(self):
        result = driver.parse_events("", "error: no providers found\nprivate-secret", 0)
        self.assertEqual(result["error"]["code"], "CODEARTS_PROVIDER_UNAVAILABLE")
        self.assertNotIn("private-secret", json.dumps(result))

    def test_success_requires_terminal_stop(self):
        self.assertFalse(driver.parse_events(success(), "", 0)["is_error"])
        pending = success().replace('"stop"', '"tool-calls"')
        self.assertEqual(driver.parse_events(pending, "", 0)["status"], "unknown")
        self.assertTrue(driver.parse_events("", "", 0)["is_error"])
        self.assertTrue(driver.parse_events(success(), "", 1)["is_error"])

    def test_untrusted_folder_is_permission_block_without_private_diagnostics(self):
        result = driver.parse_events("", "文件夹未被信任: private-workspace", 1)
        self.assertEqual(result["status"], "blocked_permission")
        self.assertEqual(result["error"]["code"], "CODEARTS_PERMISSION_REQUIRED")
        self.assertNotIn("private-workspace", json.dumps(result))
        answer = driver.parse_events(success("文件夹未被信任 is a permission diagnostic."), "", 0)
        self.assertFalse(answer["is_error"])

    def test_only_public_text_not_reasoning_tools_or_plaintext(self):
        extra = [event("reasoning", {"text": "private thought"}), event("tool_use", {"state": {"output": "private tool"}})]
        result = driver.parse_events("debug-private\n" + "\n".join(map(json.dumps, extra)) + "\n" + success(), "", 0)
        self.assertEqual(result["result"], "answer")
        self.assertNotIn("private", json.dumps(result))

    def test_provider_errors_are_sanitized(self):
        error = json.dumps(event("error", error={"name": "APIError", "data": {"message": "sensitive-header-value"}}))
        result = driver.parse_events(success() + "\n" + error, "", 0)
        self.assertTrue(result["is_error"])
        self.assertNotIn("sensitive-header", json.dumps(result))

    def test_real_answer_can_discuss_authentication_errors(self):
        result = driver.parse_events(success("Authentication required is an error; CODEARTS_CLI_AK is an environment name."), "", 0)
        self.assertFalse(result["is_error"])

    def test_multiple_sessions_fail_closed(self):
        record = event("text", {"id": "other", "text": "other"}, sessionID="different")
        self.assertEqual(driver.parse_events(success() + "\n" + json.dumps(record), "", 0)["error"]["code"], "CODEARTS_MULTIPLE_SESSIONS")

    def test_duplicate_parts_are_not_duplicated(self):
        record = event("text", {"id": "part-test", "text": "answer"})
        self.assertEqual(driver.parse_events(success() + "\n" + json.dumps(record), "", 0)["result"], "answer")

    def test_new_unfinished_step_invalidates_old_completion(self):
        record = event("step_start", {"type": "step-start"})
        self.assertTrue(driver.parse_events(success() + "\n" + json.dumps(record), "", 0)["is_error"])

    def test_unknown_model_is_not_sent_or_fallback(self):
        calls = []
        def fake(command, **kwargs):
            calls.append(command)
            return "provider/available\n", "", 0
        result = driver.run_task(task="secret task", cli=sys.executable, model="provider/missing", capture=fake)
        self.assertEqual(result["status"], "blocked_model")
        self.assertEqual(len(calls), 1)
        self.assertIn("models", calls[0])

    def test_model_match_and_task_stdin_no_resume_or_auto_permission(self):
        calls = []
        def fake(command, **kwargs):
            calls.append((command, kwargs))
            return ("provider/chosen\n", "", 0) if "models" in command else (success(), "", 0)
        task = 'do work & echo "credential"'
        result = driver.run_task(task=task, cli=sys.executable, model="provider/chosen", capture=fake)
        self.assertFalse(result["is_error"])
        command, kwargs = calls[-1]
        self.assertNotIn(task, command)
        self.assertEqual(kwargs["stdin"], task)
        self.assertIn("--pure", command)
        for argument in ("--continue", "--session", "--auto", "--share"):
            self.assertNotIn(argument, command)
        self.assertNotIn("--dir", command)
        self.assertTrue(Path(kwargs["cwd"]).is_dir())
        self.assertEqual(kwargs["env"]["OPENCODE_DISABLE_SHARE"], "true")
        self.assertTrue(Path(kwargs["env"]["OPENCODE_DB"]).is_absolute())

    def test_default_model_is_not_invented(self):
        calls = []
        def fake(command, **kwargs):
            calls.append(command)
            return success(), "", 0
        result = driver.run_task(task="hi", cli=sys.executable, capture=fake)
        self.assertFalse(result["is_error"])
        self.assertEqual(len(calls), 1)
        self.assertNotIn("--model", calls[0])

    def test_official_two_column_catalog_allows_the_selected_model(self):
        # CLI 26.9.12 pads model_id to the longest provider/model plus two
        # spaces, followed by model_name; each provider has its own header.
        def table(rows):
            width = max(len(identifier) for identifier, _ in rows) + 2
            return "\r\n".join([
                "model_id".ljust(width) + "model_name", "-" * (width + 10),
                *(identifier.ljust(width) + name for identifier, name in rows),
            ])
        catalog = table([("other/model", "Other Model")]) + "\r\n" + table([
            ("provider/chosen", "Chosen Model"), ("provider/longer-name", "Longer Model"),
        ])
        calls = []
        def fake(command, **kwargs):
            calls.append(command)
            return (catalog, "", 0) if "models" in command else (success("46"), "", 0)
        result = driver.run_task(task="17+29. Only the number.", cli=sys.executable, model="provider/chosen", capture=fake)
        self.assertEqual(result["result"], "46")
        self.assertEqual(len(calls), 2)

    def test_official_short_ids_have_a_collapsed_header(self):
        for identifier in ("p/m", "ab/mod", "abc/mod"):
            width = len(identifier) + 2
            catalog = ("model_id".ljust(width) + "model_name\n"
                       + "-" * (width + 10) + "\n" + identifier.ljust(width) + "Short Model\n")
            self.assertEqual(driver.parse_model_catalog(catalog), {identifier})

    def test_catalog_rejects_banner_mentions_and_malformed_table_rows(self):
        invalid = [
            "provider/chosen  was mentioned in a diagnostic",  # no table header
            "model_id         model_name\nprovider/chosen  Chosen",  # no ruler
            "model_id         model_name\n---------------------------\nprovider/chosen Chosen",  # only one gap
            "model_id         model_name\n---------------------------\n!provider/chosen Chosen",
            "model_id         model_name\n---------------------------\nwarning: unavailable\nprovider/chosen  Chosen",
        ]
        for catalog in invalid:
            with self.subTest(catalog=catalog):
                calls = []
                def fake(command, **kwargs):
                    calls.append(command)
                    return catalog, "", 0
                result = driver.run_task(task="hi", cli=sys.executable, model="provider/chosen", capture=fake)
                self.assertEqual(result["status"], "blocked_model")
                self.assertEqual(len(calls), 1)

    def test_unsupported_controls_do_not_launch(self):
        def never(*args, **kwargs):
            self.fail("must not start process")
        for control in ({"stream": "on"}, {"thinking": "on"}, {"thinking": "off"}):
            self.assertTrue(driver.run_task(task="hi", cli=sys.executable, capture=never, **control)["is_error"])

    def test_text_attachments_validate_and_images_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            text = root / "input.md"
            text.write_text("你好", encoding="utf-8")
            self.assertEqual(driver._validate_files([str(text)]), [str(text.resolve())])
            for name, data in [("picture.png", b"png"), ("auth.json", b"{}"), ("binary.txt", b"a\x00b"), ("not-utf8.txt", b"\xff\xfe")]:
                file = root / name
                file.write_bytes(data)
                with self.assertRaises(driver.AdapterError):
                    driver._validate_files([str(file)])

    def test_discovery_uses_codearts_not_opencode(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            kernel = root / ".codeartsdoer/CodeArts_Agent/AgentKernel_test.exe"
            kernel.parent.mkdir(parents=True)
            kernel.write_bytes(b"fixture")
            self.assertEqual(driver.discover_cli(home=root, env={"PATH": ""}), str(kernel))
            self.assertIsNone(driver.discover_cli(home=root, env={"PATH": "", "AGENTHUB_CODEARTS_CLI": str(root / "missing")}))

    def test_official_windows_cli_exe_is_preferred_to_ide_kernel(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            exe = root / ".codeartsdoer/installers/bin/codearts.exe"
            exe.parent.mkdir(parents=True)
            exe.write_bytes(b"official-cli-fixture")
            kernel = root / ".codeartsdoer/CodeArts_Agent/AgentKernel_test.exe"
            kernel.parent.mkdir(parents=True)
            kernel.write_bytes(b"ide-fixture")
            self.assertEqual(driver.discover_cli(home=root, env={"PATH": ""}), str(exe))

    def test_official_windows_exe_uses_cli_profile_without_relaxing_tls(self):
        home, runtime = Path("/home/test"), Path("/isolated")
        result = driver.runtime_environment(
            home / ".codeartsdoer/installers/bin/codearts.exe", runtime, home=home,
            env={"CODEARTS_CLI_AK": "fixture-external", "NODE_TLS_REJECT_UNAUTHORIZED": "1"})
        self.assertEqual(result["SCENARIO"], "codeartsdoer")
        self.assertEqual(result["PLUGIN_ENV"], "hc")
        self.assertEqual(Path(result["KERNEL_DATA_DIR"]), home / ".codeartsdoer/cli-data")
        self.assertEqual(Path(result["KERNEL_CONFIG_DIR"]), home / ".codeartsdoer")
        self.assertEqual(Path(result["OPENCODE_CONFIG"]), home / ".codeartsdoer/codearts_cli.json")
        self.assertEqual(result["OPENCODE_CONFIG_FILE"], "codearts_cli.json,codearts_cli.jsonc")
        self.assertEqual(result["OPENCODE_MODE"], "tui")
        self.assertEqual(result["OPENCODE_DISABLE_MODELS_FETCH"], "1")
        self.assertEqual(result["CODEARTS_CLI_AK"], "fixture-external")
        self.assertEqual(result["NODE_TLS_REJECT_UNAUTHORIZED"], "1")
        self.assertEqual(Path(result["OPENCODE_DB"]), runtime / "session.db")
        self.assertEqual(Path(result["KERNEL_LOG_DIR"]), runtime / "log")
        self.assertEqual(result["AGENTHUB_WORKER_ID"], "codearts")
        fresh = driver.runtime_environment(Path("codearts.exe"), runtime, home=home, env={})
        self.assertNotIn("NODE_TLS_REJECT_UNAUTHORIZED", fresh)

    def test_kernel_env_keeps_credentials_external_and_isolates_database(self):
        result = driver.runtime_environment(Path("AgentKernel_test.exe"), Path("/runtime"), home=Path("/home/test"), env={"CODEARTS_CLI_AK": "fixture-external", "OPENCODE_AUTO_SHARE": "true"})
        self.assertEqual(result["SCENARIO"], "codeartsdoer")
        self.assertEqual(result["CODEARTS_CLI_AK"], "fixture-external")
        self.assertNotIn("OPENCODE_AUTO_SHARE", result)
        self.assertEqual(Path(result["OPENCODE_DB"]).name, "session.db")

    def test_worker_identity_is_set_for_both_launchers(self):
        for filename in ("codearts", "AgentKernel_test.exe"):
            result = driver.runtime_environment(Path(filename), Path("/runtime"), env={"AGENTHUB_WORKER_ID": "something-else"})
            self.assertEqual(result["AGENTHUB_WORKER_ID"], "codearts")

    def test_timeout_kills_only_owned_process(self):
        with self.assertRaises(driver.AdapterError) as raised:
            driver._capture([sys.executable, "-c", "import time;time.sleep(30)"], cwd=str(ROOT), env=dict(driver.os.environ), timeout=0.1)
        self.assertEqual(raised.exception.code, "CODEARTS_TIMEOUT")

    def test_posix_group_ownership_is_consumed_once_even_after_leader_exits(self):
        child = SimpleNamespace(_agenthub_pgid=234567, poll=lambda: 0, wait=lambda timeout=None: 0)
        with patch.object(driver.os, 'name', 'posix'), \
                patch.object(driver.os, 'killpg', create=True) as killpg, \
                patch.object(signal, 'SIGKILL', 9, create=True):
            driver._terminate_owned(child)
            driver._terminate_owned(child)
        killpg.assert_called_once_with(234567, signal.SIGKILL if os.name != 'nt' else 9)

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux real process-group fixtures')
    def test_linux_owned_capture_tree_cleanup(self):
        for case in ('outer_term', 'outer_kill', 'inherited_timeout', 'inherited_root_exit',
                     'standalone_timeout', 'standalone_root_exit', 'forged_marker'):
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix='agenthub-codearts-tree-') as temp:
                completed = subprocess.run(
                    [sys.executable, str(Path(__file__).resolve()), '--containment-fixture',
                     'supervisor', case, temp], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    text=True, start_new_session=True, timeout=25)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                report = json.loads(completed.stdout)
                self.assertTrue(report['fixture_cleanup_complete'])
                self.assertTrue(report['bystander_untouched'])
                self.assertTrue(report['children_stopped'], report)
                inherited = case.startswith('outer_') or case.startswith('inherited_')
                if inherited:
                    self.assertEqual(report['runner']['pgid'], report['child']['pgid'])
                    self.assertEqual(report['runner']['sid'], report['child']['sid'])
                else:
                    self.assertNotEqual(report['runner']['pgid'], report['child']['pgid'])
                if 'timeout' in case:
                    self.assertEqual(report['result'], 'CODEARTS_TIMEOUT')
                elif not case.startswith('outer_'):
                    self.assertEqual(report['result'], 'returned')

    def test_hub_parser_understands_envelope(self):
        sys.path.insert(0, str(ROOT / "hub"))
        from output_parser import parse_output
        parsed = parse_output(json.dumps(driver.envelope("blocked_auth", code="CODEARTS_AUTH_REQUIRED")))
        self.assertEqual(parsed["text"], "")
        self.assertEqual(parsed["error"], "CODEARTS_AUTH_REQUIRED")
        self.assertEqual(parse_output(json.dumps(driver.parse_events(success(), "", 0)))["text"], "answer")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == '--containment-fixture':
        containment_fixture(*sys.argv[2:])
    else:
        unittest.main(verbosity=2)
