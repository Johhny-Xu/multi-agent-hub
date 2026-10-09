"""Opt-in official ZCode stdio protocol probe; never copies authentication."""
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time
from live_workers_windows import ROOT, HOME, NODE, ZCODE, sanitize
from command_runtime import spawn_owned, terminate_owned


class Rpc:
    def __init__(self, directory):
        environment = dict(os.environ)
        providers = list((HOME / ".zcode/v2/runtime/provider/windows-x86_64/3.14.4").glob("*/zcode-builtin.json"))
        if providers:
            environment["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"] = str(providers[0])
        self.argv = [str(NODE), str(ZCODE), "app-server", "--cwd", str(directory)]
        self.process = spawn_owned(self.argv, cwd=str(directory), env=environment, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
        self.messages = queue.Queue()
        self.notifications = []
        self.next_id = 0
        self.stderr = []
        def read_stdout():
            for line in self.process.stdout:
                try:
                    self.messages.put(json.loads(line))
                except ValueError:
                    pass
        def read_stderr():
            for line in self.process.stderr:
                self.stderr.append(line)
        threading.Thread(target=read_stdout, daemon=True).start()
        threading.Thread(target=read_stderr, daemon=True).start()

    def call(self, method, params, timeout=30):
        self.next_id += 1
        identifier = "probe-" + str(self.next_id)
        self.process.stdin.write(json.dumps({"id": identifier, "method": method, "params": params}) + "\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                message = self.messages.get(timeout=min(0.2, deadline - time.monotonic()))
            except queue.Empty:
                continue
            if message.get("id") == identifier and ("result" in message or "error" in message):
                return message
            if isinstance(message.get("id"), str) and message.get("method") == "session/requestRuntimePreferences":
                self.process.stdin.write(json.dumps({"id": message["id"], "result": {
                    "nativeSearchEnhancementsEnabled": False, "memoryEnabled": False,
                    "askUserQuestionAutoResolutionEnabled": False, "modelContextBudgetStrategy": "preflight-v1"}}) + "\n")
                self.process.stdin.flush()
                continue
            self.notifications.append(message)
        raise TimeoutError(method + " response timeout")


def public_shape(value):
    if isinstance(value, dict):
        allowed = {"id", "result", "error", "code", "message", "reasonCode", "protocolVersion", "version", "methods", "capabilities", "models", "model", "modelId", "providerId", "name", "label", "thoughtLevel", "thoughtLevels", "effortOptions", "options", "reasoningLevel", "reasoningLevels", "sessionId", "stateRevision", "mode", "status", "workspace", "workspaceKey", "workspacePath", "mainModel", "availableModels", "modelOptions", "modelPickerOptions", "modelSelection", "currentModelSelection", "configuredModelSelection", "effectiveModelSelection", "providerRevision", "selectionIssue", "accepted", "closed", "session", "projection", "runtime", "settings", "available", "current", "enabled", "value", "ref", "events", "seq", "type", "payload", "eventId", "eventSeq", "snapshot"}
        result = {key: public_shape(child) for key, child in value.items() if key in allowed}
        omitted = [key for key in value if key not in allowed]
        if omitted:
            result["omitted_field_names"] = omitted[:64]
        return result
    if isinstance(value, list):
        return [public_shape(child) for child in value[:64]]
    return sanitize(value) if isinstance(value, str) else value


def main():
    directory = Path(tempfile.mkdtemp(prefix="agenthub-zcode-rpc-"))
    rpc = Rpc(directory)
    report = {"platform": "Windows", "official_installed_version": "0.16.9", "argv": rpc.argv,
        "isolated_workspace": str(directory), "records": []}
    try:
        for method, params in (("runtime/capabilities", {}), ("workspace/readPresentation", {"workspace": {"workspacePath": str(directory), "workspaceKey": str(directory)}})):
            try:
                result = rpc.call(method, params)
                report["records"].append({"method": method, "public_response": public_shape(result)})
            except Exception as error:
                report["records"].append({"method": method, "error": sanitize(error)})
        created = rpc.call("session/create", {"workspace": {"workspacePath": str(directory), "workspaceKey": str(directory)},
            "mode": "plan", "persistence": "deferred", "mcpServers": [],
            "toolDenylist": ["Bash", "WebFetch", "WebSearch", "Task", "Agent"]})
        report["records"].append({"method": "session/create", "public_response": public_shape(created)})
        snapshot = created.get("result", {})
        session = snapshot.get("session", {}) if isinstance(snapshot, dict) else {}
        session_id = snapshot.get("sessionId") or session.get("sessionId") or session.get("id")
        if isinstance(session_id, str):
            report["requested_model"] = "GLM-5.3-Flash"
            catalog = snapshot.get("settings", {}).get("model", {}).get("available", [])
            report["requested_model_in_catalog"] = any(entry.get("ref", {}).get("modelId", "").lower() == "glm-5.3-flash" for entry in catalog if isinstance(entry, dict))
            for method, params in (("session/read", {"sessionId": session_id, "messageLimit": 1}),
                ("session/events", {"sessionId": session_id, "afterSeq": 0, "limit": 4}),
                ("session/subscribe", {"sessionId": session_id, "deliveryKind": "desktop-continuous", "afterSeq": 0, "includeSnapshot": False})):
                response = rpc.call(method, params)
                report["records"].append({"method": method, "params": params, "public_response": public_shape(response)})
            closed = rpc.call("session/close", {"sessionId": session_id, "expectedPersistence": "deferred"})
            report["records"].append({"method": "session/close", "public_response": public_shape(closed)})
    finally:
        terminate_owned(rpc.process)
    (ROOT / "docs/live-workers-zcode-rpc.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
