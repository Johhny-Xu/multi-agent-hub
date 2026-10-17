"""Official worker CLI login flows; credentials remain owned by the vendor CLI.

Public replies contain only login URLs, optional device user codes, and status.
Raw CLI output, account objects, access tokens, and refresh tokens are never
returned or persisted. Caller input chooses a configured worker, never a command.
"""
import atexit
import json
import os
import re
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, parse_qsl, urlencode, urlunsplit
from command_runtime import prepare_command, spawn_owned, terminate_owned

WORKERS = {"codebuddy", "codebuddy-cn", "minimaxcode", "github-copilot",
           "antigravity", "mimocode", "zcode", "traecode", "codearts",
           "opencode", "cline"}
COMMANDS = {"codebuddy": "codebuddy", "codebuddy-cn": "codebuddy",
            "minimaxcode": "mmx", "github-copilot": "copilot",
            "antigravity": "agy", "mimocode": "mimo", "zcode": "zcode",
            "traecode": "traecli", "codearts": "codearts",
            "opencode": "opencode", "cline": "cline"}
HOSTS = {"codebuddy": ("codebuddy.ai", "copilot.tencent.com"),
         "codebuddy-cn": ("codebuddy.ai", "copilot.tencent.com"),
         "minimaxcode": ("minimax.io", "minimaxi.com", "minimax.cn"),
         "github-copilot": ("github.com",), "zcode": ("z.ai", "bigmodel.cn"),
         "mimocode": ("xiaomimimo.com",),
         "opencode": ("opencode.ai",),
         "cline": ("cline.bot",),
         "traecode": ("trae.cn", "trae.ai", "trae.com.cn", "trae.com")}
ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
ACTIVE = {"preparing", "awaiting_user"}


def safe_url(value, worker):
    """Accept vendor HTTPS links; reject embedded credentials/tokens/other sites."""
    if not isinstance(value, str) or len(value) > 4096:
        return None
    try:
        url = urlsplit(value.strip().rstrip(".,);"))
        host = (url.hostname or "").lower()
        if url.scheme != "https" or url.username or url.password or url.fragment:
            return None
        if not any(host == item or host.endswith("." + item) for item in HOSTS.get(worker, ())):
            return None
        if any(re.sub(r"[^a-z]", "", key.lower()) in {"accesstoken", "refreshtoken", "idtoken", "apikey", "token", "password", "secret", "authorization"}
               for key, _ in parse_qsl(url.query)):
            return None
        return url.geturl()
    except ValueError:
        return None


def command_prefix(profile, worker):
    command = profile.get("cli") or [COMMANDS[worker]]
    if not isinstance(command, (list, tuple)) or not command:
        raise ValueError("CLI command must be a nonempty argument list")
    base = Path(os.path.expandvars(os.path.expanduser(str(profile.get("cwd") or os.getcwd())))).resolve()
    first = os.path.expandvars(os.path.expanduser(str(command[0])))
    if Path(first).parent != Path("."):
        first = str((base / first).resolve())
    prefix = [first]
    if Path(first).stem.lower() in {"node", "nodejs", "bun", "python", "python3", "python3.12"} and len(command) > 1:
        script = os.path.expandvars(os.path.expanduser(str(command[1])))
        prefix.append(script if script.startswith("-") else str((base / script).resolve()))
    prefix = prepare_command(prefix, env=worker_env(profile, worker))
    if os.name == "nt" and Path(prefix[0]).suffix.lower() in {".cmd", ".bat"}:
        raise ValueError("Windows wrapper requires a direct [node, script] CLI configuration")
    if not Path(prefix[0]).is_file() and not shutil.which(prefix[0]):
        raise FileNotFoundError(COMMANDS[worker])
    return prefix


def worker_env(profile, worker):
    env = os.environ.copy()
    for key, value in (profile.get("env") or {}).items():
        env[str(key)] = os.path.expandvars(os.path.expanduser(str(value)))
    if worker in {"codebuddy", "codebuddy-cn"}:
        env["CODEBUDDY_CONFIG_DIR"] = os.path.expandvars(os.path.expanduser(str((profile.get("env") or {}).get("CODEBUDDY_CONFIG_DIR") or (Path.home() / (".codebuddy-cn" if worker.endswith("-cn") else ".codebuddy")))))
        env["CODEBUDDY_INTERNET_ENVIRONMENT"] = "internal" if worker.endswith("-cn") else "external"
    env["NO_COLOR"] = "1"
    return env


def stop_owned(proc):
    if proc is None:
        return
    lock = proc.__dict__.setdefault("_agenthub_stop_lock", threading.RLock())
    with lock:
        if hasattr(proc, "close"):
            proc.close()
        else:
            terminate_owned(proc)


def run_status(command, env, timeout):
    """Capture status privately and always reclaim this command's descendants."""
    proc = None
    try:
        proc = spawn_owned(command, env=env, stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
        out, err = proc.communicate(timeout=timeout)
        return subprocess.CompletedProcess(command, proc.returncode, out, err)
    finally:
        stop_owned(proc)


class LoginManager:
    def __init__(self):
        self.sessions = {}
        self.lock = threading.RLock()
        self._closed = False
        atexit.register(self.close)

    def close(self):
        with self.lock:
            self._closed = True
            processes = []
            for session in self.sessions.values():
                if session["status"] in ACTIVE:
                    session["status"] = "cancelled"
                processes.append(session.get("process"))
        for proc in processes:
            stop_owned(proc)

    def _reply(self, session, action):
        with self.lock:
            fields = {key: session[key] for key in ("worker", "status", "login_url", "user_code", "expires_at", "instructions", "error") if key in session}
            # Expired/cancelled links must not be offered again.
            if fields["status"] not in {"awaiting_user", "preparing"}:
                fields.pop("login_url", None)
                fields.pop("user_code", None)
            fields.update(ok=fields["status"] in ACTIVE | {"authenticated", "cancelled"}, action=action)
            return fields

    def handle(self, worker, action, profile):
        if worker not in WORKERS or action not in {"start", "status", "cancel"}:
            return {"ok": False, "worker": worker, "action": action, "status": "unavailable", "error": "Unknown worker or login action"}
        with self.lock:
            if self._closed:
                return {"ok": False, "worker": worker, "action": action, "status": "unavailable", "error": "Login manager is closed"}
            old = self.sessions.get(worker)
            if old and old["status"] in ACTIVE and old["deadline"] <= time.monotonic():
                old["status"] = "expired"
                stop_owned(old.get("process"))
            if action == "cancel":
                if old:
                    old["status"] = "cancelled"
                    stop_owned(old.get("process"))
                return self._reply(old or {"worker": worker, "status": "cancelled"}, action)
            if old and old["status"] in ACTIVE:
                return self._reply(old, action)
        if worker == "codearts":
            return {"ok": False, "worker": worker, "action": action, "status": "manual_required",
                    "instructions": "在 Hub 主机使用 CodeArts 官方登录与模型配置。当前 CLI 非交互模式可能要求 CODEARTS_CLI_AK/CODEARTS_CLI_SK；IDE 登录不能证明 CLI 已认证。凭据只在本机官方环境中配置，不要发到聊天或写入项目。配置后刷新 hub_capabilities 并执行真实任务验证。",
                    "login_url": "https://support.huaweicloud.com/usermanual-cli/codeartsagent_cli_0034.html"}
        if worker == "antigravity":
            return {"ok": False, "worker": worker, "action": action, "status": "manual_required",
                    "instructions": f"Run {COMMANDS[worker]} in a local terminal and use its official account/provider login. This CLI has no verified noninteractive login-link/status interface."}
        try:
            prefix = command_prefix(profile, worker)
            env = worker_env(profile, worker)
        except (OSError, ValueError):
            return {"ok": False, "worker": worker, "action": action, "status": "unavailable",
                    "instructions": f"Install the official {COMMANDS[worker]} CLI on the Hub host, then configure agents.json cli with its executable (or [node, script])."}
        if worker == "minimaxcode":
            try:
                check = run_status(prefix + ["auth", "status", "--output", "json"], env, 8)
                if check.returncode == 0:
                    return {"ok": True, "worker": worker, "action": action, "status": "authenticated"}
                if action == "status":
                    return {"ok": False, "worker": worker, "action": action, "status": "unknown", "instructions": "Call hub_login with action=start to obtain an official MiniMax OAuth link."}
            except (OSError, subprocess.TimeoutExpired):
                return {"ok": False, "worker": worker, "action": action, "status": "unavailable", "error": "MiniMax authentication status command failed or timed out"}
        elif worker == "github-copilot":
            if action == "status":
                if old and old["status"] == "authenticated":
                    return self._reply(old, action)
                return {"ok": False, "worker": worker, "action": action, "status": "unknown", "instructions": "Copilot has no verified standalone login-status command. Start its official device login, then verify a real task."}
        elif worker == "mimocode" and action == "status":
            check_proc = None
            try:
                check_proc = spawn_owned(prefix + ["auth", "whoami", "--pure"], env=env, stdin=subprocess.DEVNULL,
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
                stdout, stderr = check_proc.communicate(timeout=15)
                output = ANSI.sub("", (stdout + stderr).decode("utf-8", "replace"))
                logged_in = check_proc.returncode == 0 and "Not logged in" not in output and re.search(r"\bProvider:\s*MiMo\b", output)
                if logged_in:
                    return {"ok": True, "worker": worker, "action": action, "status": "authenticated"}
                return {"ok": False, "worker": worker, "action": action, "status": "unknown", "instructions": "Call hub_login with action=start for official MiMo browser authorization."}
            except (OSError, subprocess.TimeoutExpired):
                return {"ok": False, "worker": worker, "action": action, "status": "unavailable", "error": "MiMo authentication status command failed or timed out"}
            finally:
                stop_owned(check_proc)
        elif worker == "mimocode":
            if os.name != "nt":
                return {"ok": False, "worker": worker, "action": action, "status": "manual_required", "instructions": "Run mimo auth login --provider xiaomi --pure in a local terminal. Automatic loopback link capture is currently verified on Windows."}
        elif worker not in {"codebuddy", "codebuddy-cn"}:
            # Other official CLIs are handled only when explicitly configured;
            # do not infer login from a model probe or reuse the desktop account.
            login = profile.get("login") or {}
            if not login.get("command"):
                return {"ok": False, "worker": worker, "action": action, "status": "manual_required",
                        "instructions": f"Use the official {COMMANDS[worker]} login flow. Configure login.command and login.status_command only after verifying this CLI version's device-link interface."}
            if action == "status":
                status_command = login.get("status_command")
                if not status_command:
                    return {"ok": False, "worker": worker, "action": action, "status": "unknown", "instructions": "This worker has no configured login.status_command."}
                try:
                    check = run_status(status_command, env, 8)
                    return {"ok": check.returncode == 0, "worker": worker, "action": action,
                            "status": "authenticated" if check.returncode == 0 else "unknown"}
                except (OSError, subprocess.TimeoutExpired):
                    return {"ok": False, "worker": worker, "action": action, "status": "unavailable", "error": "Login status command failed or timed out"}
        # Serialize creation: two clients asking simultaneously get one flow.
        with self.lock:
            if self._closed:
                return {"ok": False, "worker": worker, "action": action, "status": "unavailable", "error": "Login manager is closed"}
            current = self.sessions.get(worker)
            if current and current["status"] in ACTIVE:
                return self._reply(current, action)
            duration = 300 if worker in {"codebuddy", "codebuddy-cn", "mimocode"} else 600
            session = {"worker": worker, "status": "preparing", "deadline": time.monotonic() + duration,
                       "expires_at": datetime.fromtimestamp(time.time() + duration, timezone.utc).isoformat(),
                       "instructions": "Open the official link in your browser. Do not send passwords or API keys to the Hub. Credentials are saved by the official CLI on the Hub host."}
            self.sessions[worker] = session
            threading.Thread(target=self._run, args=(session, prefix, env, profile, action), daemon=True).start()
        # Link preparation is bounded; later status calls retrieve slow responses.
        until = time.monotonic() + 2
        while session["status"] == "preparing" and time.monotonic() < until:
            time.sleep(0.04)
        return self._reply(session, action)

    def _send(self, proc, data):
        proc.stdin.write((json.dumps(data) + "\n").encode("utf-8"))
        proc.stdin.flush()

    def _transition(self, session, **fields):
        with self.lock:
            if self._closed or session["status"] not in ACTIVE:
                return False
            session.update(fields)
            return True

    def _run(self, session, prefix, env, profile, action):
        worker = session["worker"]
        proc = None
        timer = None
        try:
            if worker in {"codebuddy", "codebuddy-cn"}:
                cmd = prefix + ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
                proc = spawn_owned(cmd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, **({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}))
            elif worker in {"minimaxcode", "mimocode"}:
                # Authorization is global to the vendor CLI. An empty cwd
                # avoids loading unrelated project config from the home tree.
                auth_cwd = Path.home() / ".cache" / "agenthub" / "login-workspace"
                auth_cwd.mkdir(parents=True, exist_ok=True)
                if worker == "minimaxcode":
                    cmd = prefix + ["auth", "login", "--recommend", "--region=" + str((profile.get("login") or {}).get("region", "cn"))]
                    env.pop("CI", None)
                else:
                    cmd = prefix + ["auth", "login", "--provider", "xiaomi", "--pure"]
                    env["CI"] = "1"
                if os.name == "nt":
                    from windows_pty import WindowsPty
                    proc = WindowsPty(cmd, auth_cwd, env)
                else:
                    import pty
                    master, slave = pty.openpty()
                    try:
                        proc = spawn_owned(cmd, cwd=auth_cwd, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
                    except BaseException:
                        os.close(master)
                        raise
                    finally:
                        os.close(slave)
                    proc.stdout = os.fdopen(master, "rb", buffering=0)
            else:
                command = prefix + ["login", "--device-code"] if worker == "github-copilot" else (profile["login"])["command"]
                proc = spawn_owned(command, env=env, stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                        **({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}))
            with self.lock:
                if self._closed or session["status"] not in ACTIVE:
                    stop_owned(proc)
                    return
                session["process"] = proc
            def expire():
                with self.lock:
                    if session["status"] in ACTIVE:
                        session["status"] = "expired"
                stop_owned(session.get("process"))
            timer = threading.Timer(max(0.01, session["deadline"] - time.monotonic()), expire)
            timer.daemon = True
            timer.start()
            if worker in {"codebuddy", "codebuddy-cn"}:
                environment = "internal" if worker.endswith("-cn") else "external"
                self._send(proc, {"type": "control_request", "request_id": "hub-login-init", "request": {"subtype": "initialize", "hasPrompt": False, "environment": environment}})
            for raw in iter(proc.stdout.readline, b""):
                if session["status"] not in ACTIVE:
                    break
                text = ANSI.sub("", raw.decode("utf-8", "replace")).strip()
                if worker in {"codebuddy", "codebuddy-cn"}:
                    try:
                        message = json.loads(text)
                    except ValueError:
                        continue
                    if not isinstance(message, dict):
                        continue
                    request = message.get("request") or {}
                    response = message.get("response") or {}
                    if not isinstance(request, dict) or not isinstance(response, dict):
                        raise ValueError("Invalid official CLI protocol")
                    if message.get("type") == "control_response" and response.get("request_id") == "hub-login-init":
                        data = response.get("response") or {}
                        if not isinstance(data, dict):
                            raise ValueError("Invalid official CLI initialization")
                        if response.get("subtype") == "error":
                            self._transition(session, status="failed", error="Official CodeBuddy CLI initialization failed")
                            break
                        if data.get("account"):
                            self._transition(session, status="authenticated")
                            break
                        if action == "status":
                            self._transition(session, status="unknown", instructions="Not logged in. Call hub_login with action=start.")
                            break
                        # ACP's official authenticate method waits for browser
                        # completion without the stream protocol's 60s timeout.
                        stop_owned(proc)
                        self._codebuddy_acp(session, prefix, env)
                        break
                    elif message.get("type") == "control_request":
                        subtype = request.get("subtype")
                        if subtype == "auth_url_callback":
                            state = request.get("authState") or {}
                            if not isinstance(state, dict):
                                raise ValueError("Invalid official CLI authorization")
                            url = safe_url(state.get("authUrl"), worker)
                            if url:
                                self._transition(session, status="awaiting_user", login_url=url)
                        elif subtype == "auth_result_callback":
                            self._transition(session, status="authenticated" if request.get("success") is True else "failed",
                                             **({"error": "Official CodeBuddy login failed or expired; start a new link"} if request.get("success") is not True else {}))
                        self._send(proc, {"type": "control_response", "response": {"subtype": "success", "request_id": message.get("request_id"), "response": {}}})
                    elif response.get("request_id") == "hub-login-auth" and response.get("subtype") == "error":
                        self._transition(session, status="expired", error="Official CodeBuddy authentication request expired; start a new link")
                else:
                    for candidate in re.findall(r"https://[^\s<>\"']+", text):
                        url = safe_url(candidate, worker)
                        if url:
                            if worker == "mimocode":
                                url = self._mimo_callback_url(url, proc)
                                if not url:
                                    self._transition(session, status="manual_required", instructions="This MiMo version did not expose one verifiable local callback listener. Run mimo auth login --provider xiaomi --pure in a local terminal.")
                                    break
                            self._transition(session, status="awaiting_user", login_url=url)
                    code = re.search(r"(?:Code|user.code)\s*[:=]\s*([A-Za-z0-9-]{4,32})", text, re.I)
                    if code:
                        self._transition(session, user_code=code.group(1))
                    if worker == "minimaxcode" and "Logged in successfully" in text:
                        self._transition(session, status="authenticated")
                        break
                    if worker == "mimocode" and "Login successful" in text:
                        self._transition(session, status="authenticated")
                        break
                    if worker == "mimocode" and "Login failed" in text:
                        self._transition(session, status="failed", error="Official MiMo login failed or expired; start a new link")
                        break
            code = proc.poll()
            if session["status"] in ACTIVE:
                if code is None:
                    proc.wait(timeout=3)
                    code = proc.poll()
                if worker == "github-copilot" and code == 0:
                    self._transition(session, status="authenticated")
                elif worker == "minimaxcode" and code == 0:
                    check = run_status(prefix + ["auth", "status", "--output", "json"], env, 8)
                    self._transition(session, status="authenticated" if check.returncode == 0 else "failed")
                elif code == 0 and (profile.get("login") or {}).get("status_command"):
                    check = run_status(profile["login"]["status_command"], env, 8)
                    self._transition(session, status="authenticated" if check.returncode == 0 else "failed")
                else:
                    self._transition(session, status="failed", error="Official CLI login ended without verified authentication")
        except Exception:
            if session["status"] in ACTIVE:
                self._transition(session, status="failed", error="Official CLI login could not start or timed out; check its installation on the Hub host")
        finally:
            if timer:
                timer.cancel()
            stop_owned(proc)
            with self.lock:
                session.pop("process", None)

    def _codebuddy_acp(self, session, prefix, env):
        proc = spawn_owned(prefix + ["--acp"], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL,
                                **({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}))
        with self.lock:
            if self._closed or session["status"] not in ACTIVE:
                stop_owned(proc)
                return
            session["process"] = proc
        try:
            self._send(proc, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1, "clientCapabilities": {}, "clientInfo": {"name": "agenthub-login", "version": "0.1"}}})
            for raw in iter(proc.stdout.readline, b""):
                if session["status"] not in ACTIVE:
                    break
                try:
                    message = json.loads(raw.decode("utf-8", "replace"))
                except ValueError:
                    continue
                if not isinstance(message, dict):
                    continue
                if message.get("id") == 1:
                    if "error" in message:
                        self._transition(session, status="failed", error="Official CodeBuddy ACP initialization failed")
                        break
                    method_id = "internal" if session["worker"].endswith("-cn") else "external"
                    self._send(proc, {"jsonrpc": "2.0", "id": 2, "method": "authenticate", "params": {"methodId": method_id}})
                elif message.get("method") == "_codebuddy.ai/authUrl":
                    params = message.get("params") or {}
                    if not isinstance(params, dict):
                        raise ValueError("Invalid official CLI authorization")
                    url = safe_url(params.get("authUrl"), session["worker"])
                    if url:
                        self._transition(session, status="awaiting_user", login_url=url)
                elif message.get("id") == 2:
                    # Deliberately discard all _meta/userinfo returned by ACP.
                    self._transition(session, status="failed" if "error" in message else "authenticated",
                                     **({"error": "Official CodeBuddy login failed; start a new link"} if "error" in message else {}))
                    break
            if session["status"] in ACTIVE:
                self._transition(session, status="failed", error="Official CodeBuddy ACP login ended without authentication")
        finally:
            stop_owned(proc)

    @staticmethod
    def _mimo_callback_url(url, proc):
        # MiMo prints the manual-code URL but starts a real loopback listener.
        # Rebuild its official browser URL with metadata from our own job only.
        # The CLI alone receives/decrypts the callback and stores credentials.
        if os.name != "nt":
            return None
        from windows_pty import owned_listener_port
        port = owned_listener_port(proc)
        if not port:
            return None
        parsed = urlsplit(url)
        parameters = dict(parse_qsl(parsed.query))
        if parsed.path != "/authorize" or not parameters.get("pk") or parameters.get("kn") != "mimocode":
            return None
        parameters["redirect_uri"] = f"http://localhost:{port}/"
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(parameters), ""))


MANAGER = LoginManager()
