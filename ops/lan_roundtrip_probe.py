"""Opt-in direct-network Windows/Linux probe: two real MiniMax attachment tasks.

Uses an existing SSH alias only for isolated setup and cleanup. MCP task traffic
uses each host's direct IP, never SSH forwarding. Tokens and logs stay outside
the source tree. No firewall or existing deployment settings are changed.
"""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

from remote_platform_probe import ROOT, archive, run, ssh
sys.path.insert(0, str(ROOT / "tests"))
from live_workers_windows import MMX, NODE, fixture
from command_runtime import atomic_write_json, spawn_owned, terminate_owned

MODEL = "MiniMax-M3.1-Flash-Preview"
CLIENT = r'''import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const input=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const {ask}=await import(pathToFileURL(input.bridge));
const started=Date.now(), progress=[];
const result=await ask('minimaxcode',input.task,120,{
  model:input.model,thinking:'on',stream:true,files:input.files,cwd:input.cwd,
  onProgress:async event=>progress.push({characters:event.text.length,seconds:(Date.now()-started)/1000})
});
let answer;try{answer=JSON.parse(result.answer)}catch{answer=null}
const verified=answer?.total===input.expected.total&&answer?.nonce===input.expected.nonce;
console.log(JSON.stringify({status:result.status,ok:result.ok,ref:result.ref,
  answer_verified:verified,public_answer:answer,expected:input.expected,progress,
  passed:result.ok&&result.status==='completed'&&verified,elapsed_s:(Date.now()-started)/1000}));
'''


def free_port():
    with socket.socket() as probe:
        probe.bind(("0.0.0.0", 0))
        return probe.getsockname()[1]


def mmx_profile(command):
    return {"agents": {"minimaxcode": {"cli": command + ["--quiet", "text", "chat", "--message", "{task}",
        "--output", "json", "--max-tokens", "2048", "--timeout", "90", "--non-interactive", "--no-color"],
        "model_arg": "--model", "models": {"default": MODEL}, "async_default": True}}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ssh-alias", required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--run", action="store_true", required=True)
    parser.add_argument("--directions", choices=("both", "windows_to_linux", "linux_to_windows"), default="both")
    parser.add_argument("--reverse-ssh-fallback", action="store_true", help="Opt in to a temporary SSH reverse forward if Linux cannot reach Windows directly")
    options = parser.parse_args()
    if os.name != "nt" or not re.fullmatch(r"[A-Za-z0-9_.-]+", options.ssh_alias):
        raise SystemExit("Run on Windows with an existing SSH alias")
    local = Path(tempfile.mkdtemp(prefix="agenthub-lan-client-"))
    inventory = json.loads(ssh(options.ssh_alias, "import os,json,tempfile,shutil,pathlib;entry=pathlib.Path.home()/'.npm-global/lib/node_modules/mmx-cli/dist/mmx.mjs';print(json.dumps({'connection':os.environ['SSH_CONNECTION'].split(),'root':tempfile.mkdtemp(prefix='agenthub-lan-'),'mmx':[shutil.which('node'),str(entry)] if entry.is_file() else [shutil.which('mmx')],'node':shutil.which('node')}))"))
    remote = inventory["root"]
    windows_ip, linux_ip = inventory["connection"][0], inventory["connection"][2]
    for address in (windows_ip, linux_ip):
        ipaddress.ip_address(address)
    if not all(inventory["mmx"]) or not inventory["node"] or not MMX.is_file():
        raise SystemExit("Official MiniMax/Node executable unavailable")
    package = local / "source.tar.gz"
    hashes = archive(package)
    run(["scp", "-q", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", str(package), options.ssh_alias + ":" + remote + "/source.tar.gz"])
    token = secrets.token_urlsafe(32)
    port = free_port()
    (local / "work").mkdir()
    atomic_write_json(local / "agents.json", mmx_profile([str(NODE), str(MMX)]))
    env = dict(os.environ, HUB_AGENTS_FILE=str(local / "agents.json"), HUB_STATE_DIR=str(local / "state"),
               HUB_RESULTS_DIR=str(local / "results"), HUB_TOKEN=token)
    hub = tunnel = None
    reverse_endpoint = None
    report = {"kind": "direct-network-two-way-real-model-tasks", "tested_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "ssh_forwarding_used": False, "firewall_changed": False, "official_auth_copied": False,
        "private_network_addresses": all(ipaddress.ip_address(a).is_private for a in (windows_ip, linux_ip)),
        "worker": "minimaxcode", "model": MODEL, "thinking": "on", "stream": True,
        "attachments": ["image", "utf8_text"], "source_sha256": hashes, "directions": {}}
    setup = '''import pathlib,tarfile,json,subprocess,os,socket
root=pathlib.Path(ROOT);state=root/'private';state.mkdir(mode=0o700)
with tarfile.open(root/'source.tar.gz') as bundle:
 for item in bundle.getmembers():
  if not item.isfile() or not (root/item.name).resolve().is_relative_to(root):raise RuntimeError('Unsafe archive')
 bundle.extractall(root,filter='data')
(state/'work').mkdir()
(state/'agents.json').write_text(json.dumps(PROFILE));(state/'agents.json').chmod(0o600)
s=socket.socket();s.bind(('0.0.0.0',0));port=s.getsockname()[1];s.close()
env=os.environ.copy();env.update(HUB_AGENTS_FILE=str(state/'agents.json'),HUB_STATE_DIR=str(state/'state'),HUB_RESULTS_DIR=str(state/'results'),HUB_TOKEN=__TOKEN__)
with (state/'hub.log').open('wb') as log:
 p=subprocess.Popen(['python3',str(root/'hub/agent_hub.py'),'--http',str(port),'--host','0.0.0.0'],env=env,cwd=state,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
(state/'pid').write_text(str(p.pid));print(json.dumps({'port':port}))
'''.replace("ROOT", repr(remote)).replace("PROFILE", repr(mmx_profile(inventory["mmx"]))).replace("__TOKEN__", repr(token))
    try:
        linux = json.loads(ssh(options.ssh_alias, setup))
        with (local / "hub.log").open("wb") as log:
            hub = spawn_owned([sys.executable, str(ROOT / "hub/agent_hub.py"), "--http", str(port), "--host", "0.0.0.0"],
                env=env, cwd=str(local), stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        for _ in range(40):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1).close()
                break
            except OSError:
                time.sleep(.15)
        # Reachability before spending any inference. A blocked direction is
        # evidence, not permission to modify a host's firewall.
        for direction, address, endpoint_port in (("windows_to_linux", linux_ip, linux["port"]), ("linux_to_windows", windows_ip, port)):
            if options.directions not in ("both", direction):
                continue
            try:
                if direction == "windows_to_linux":
                    with socket.create_connection((address, endpoint_port), timeout=8):
                        pass
                else:
                    ssh(options.ssh_alias, "import socket\nwith socket.create_connection(" + repr((address, endpoint_port)) + ",timeout=8):pass", 15)
                report["directions"][direction] = {"reachable": True}
            except Exception:
                report["directions"][direction] = {"reachable": False, "passed": False, "status": "direct_network_unreachable", "vendor_inference_performed": False}
        reverse = report["directions"].get("linux_to_windows")
        if options.reverse_ssh_fallback and reverse and not reverse["reachable"]:
            remote_port = json.loads(ssh(options.ssh_alias, "import socket,json;s=socket.socket();s.bind(('127.0.0.1',0));print(json.dumps(s.getsockname()[1]));s.close()"))
            tunnel = spawn_owned(["ssh", "-N", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ExitOnForwardFailure=yes",
                "-R", f"127.0.0.1:{remote_port}:127.0.0.1:{port}", options.ssh_alias], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(20):
                if tunnel.poll() is not None:
                    raise RuntimeError("Owned SSH reverse forward could not start")
                try:
                    ssh(options.ssh_alias, "import socket\nwith socket.create_connection(('127.0.0.1'," + str(remote_port) + "),timeout=1):pass", 5)
                    reverse_endpoint = f"http://127.0.0.1:{remote_port}/mcp"
                    reverse.update(direct_network_reachable=False, reachable=True, transport="temporary_ssh_reverse_forward")
                    report["ssh_forwarding_used"] = True
                    break
                except RuntimeError:
                    time.sleep(.2)
        for direction in ("windows_to_linux", "linux_to_windows"):
            if direction not in report["directions"]:
                continue
            if not report["directions"][direction]["reachable"]:
                continue
            source = local / direction
            task, expected, nonce = fixture(source, True, True)
            task = "\n".join(line for line in task.splitlines() if not line.startswith("Write output.json"))
            (source / "client.mjs").write_text(CLIENT, encoding="utf-8")
            if direction == "windows_to_linux":
                connection = {"url": f"http://{linux_ip}:{linux['port']}/mcp", "token": token}
                request = {"bridge": str(ROOT / "integrations/codex/mcp/hub.mjs"), "task": task, "model": MODEL,
                    "files": [str(source / "image.png"), str(source / "input.txt")], "cwd": remote + "/private/work",
                    "expected": {"total": expected, "nonce": nonce}}
                atomic_write_json(source / "client.json", connection)
                atomic_write_json(source / "request.json", request)
                client_env = dict(os.environ, AGENTHUB_CONFIG=str(source / "client.json"))
                for name in ("AGENTHUB_URL", "HUB_MCP_URL", "HUB_TOKEN", "PLUGIN_DATA"):
                    client_env.pop(name, None)
                process = spawn_owned([str(NODE), str(source / "client.mjs"), str(source / "request.json")], env=client_env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    out, err = process.communicate(timeout=135)
                    (source / "client.stderr.log").write_bytes(err)
                    if process.returncode:
                        raise RuntimeError("Local client failed; inspect private log")
                    result = json.loads(out)
                finally:
                    terminate_owned(process)
            else:
                upload = remote + "/private"
                for name in ("image.png", "input.txt", "client.mjs"):
                    run(["scp", "-q", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", str(source / name), options.ssh_alias + ":" + upload + "/" + name])
                request = {"bridge": remote + "/plugins/agenthub-workers/mcp/hub.mjs", "task": task, "model": MODEL,
                    "files": [upload + "/image.png", upload + "/input.txt"], "cwd": str(local / "work"),
                    "expected": {"total": expected, "nonce": nonce}}
                execute = '''import pathlib,json,subprocess,os
state=pathlib.Path(STATE);settings=state/'client.json';settings.write_text(json.dumps(CONNECTION));settings.chmod(0o600)
(state/'request.json').write_text(json.dumps(REQUEST))
env=os.environ.copy();env['AGENTHUB_CONFIG']=str(settings)
for name in ('AGENTHUB_URL','HUB_MCP_URL','HUB_TOKEN','PLUGIN_DATA'):env.pop(name,None)
p=subprocess.run([NODE,str(state/'client.mjs'),str(state/'request.json')],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=135)
(state/'client.stderr.log').write_bytes(p.stderr)
if p.returncode:raise RuntimeError('Remote client failed; inspect private log')
print(p.stdout.decode())
'''.replace("STATE", repr(upload)).replace("CONNECTION", repr({"url": reverse_endpoint or f"http://{windows_ip}:{port}/mcp", "token": token})).replace("REQUEST", repr(request)).replace("NODE", repr(inventory["node"]))
                result = json.loads(ssh(options.ssh_alias, execute, 145))
            report["directions"][direction].update(result, vendor_inference_performed=True)
            atomic_write_json(options.report, report)
            print(json.dumps({"direction": direction, "passed": result["passed"], "status": result["status"]}), flush=True)
    finally:
        terminate_owned(tunnel)
        terminate_owned(hub)
        cleanup = '''import pathlib,os,signal
root=pathlib.Path(ROOT);record=root/'private/pid'
if record.is_file():
 pid=int(record.read_text());cmd=pathlib.Path('/proc')/str(pid)/'cmdline'
 if cmd.exists() and str(root/'hub/agent_hub.py').encode() in cmd.read_bytes().split(b'\\0'):
  try:os.killpg(pid,signal.SIGTERM)
  except ProcessLookupError:pass
'''.replace("ROOT", repr(remote))
        ssh(options.ssh_alias, cleanup)
        report["owned_hub_processes_stopped"] = True
        atomic_write_json(options.report, report)
    print(json.dumps({"report": str(options.report), "passed": all(item.get("passed") for item in report["directions"].values())}))
    return int(not report["directions"] or not all(item.get("passed") for item in report["directions"].values()))


if __name__ == "__main__":
    raise SystemExit(main())
