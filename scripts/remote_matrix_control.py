#!/usr/bin/env python3
"""Refresh an isolated Linux deployment and run native/cross-platform task matrices."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time

from remote_platform_probe import ROOT, archive, run, ssh, redacted
from remote_worker_probe import port
sys.path.insert(0, str(ROOT / "hub"))
from command_runtime import atomic_write_json, spawn_owned, terminate_owned


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ssh-alias", required=True)
    parser.add_argument("--deployment", required=True)
    parser.add_argument("--report-prefix", type=Path, required=True)
    parser.add_argument("--run", action="store_true", required=True)
    parser.add_argument("--native-window", action="store_true", help="Wait for private native-hosts-done sentinel before cleanup, at most 900 seconds")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", args.ssh_alias) or not re.fullmatch(r"/tmp/agenthub-platform-[A-Za-z0-9_-]+", args.deployment):
        raise SystemExit("Use an existing alias and a previously created isolated deployment")
    state = Path(tempfile.mkdtemp(prefix="agenthub-matrix-client-"))
    package = state / "source.tar.gz"
    hashes = archive(package)
    run(["scp", "-q", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", str(package), args.ssh_alias + ":" + args.deployment + "/source.tar.gz"])
    remote_state = args.deployment + "-matrix-" + secrets.token_hex(4)
    setup = '''import json,pathlib,tarfile,sys,os,hashlib,copy,secrets
root=pathlib.Path(DEPLOYMENT)
with tarfile.open(root/'source.tar.gz') as package:
 for member in package.getmembers():
  if not member.isfile() or not (root/member.name).resolve().is_relative_to(root):raise RuntimeError('Unsafe archive')
 package.extractall(root,filter='data')
sys.path.insert(0,str(root/'scripts'))
from remote_worker_probe import safe_config,port
from remote_linux_services import start_service,wait_health,endpoint
state=pathlib.Path(__STATE__);state.mkdir(mode=0o700)
source=pathlib.Path.home()/'agent-hub/agents.json'
original=json.loads(source.read_text());original_agents=original.get('agents',original)
config=safe_config(source,state,mimo_model='xiaomi/mimo-v2.6-flash')
for name in ('zcode','traecode'):
 if name in original_agents:config['agents'][name]=copy.deepcopy(original_agents[name])
for name in ('codebuddy','codebuddy-cn'):
 exe=config['agents'][name]['cli'][0]
 config['agents'][name]['cli']=[exe,'{task}','-p','--tools','Read','--allowedTools','Read','--strict-mcp-config','--mcp-config','{}','--no-session-persistence']
 config['agents'][name].setdefault('models',{})['default']='deepseek-v4.1-flash'
config['agents']['github-copilot']['cli'] += ['--deny-tool=shell','--allow-tool=read']
for record in config['agents'].values():record['async_default']=True
path=state/'agents.json';path.write_text(json.dumps(config));path.chmod(0o600)
(state/'workspace').mkdir();token=secrets.token_urlsafe(24);hubport=port()
env=os.environ.copy();env.update(HUB_AGENTS_FILE=str(path),HUB_STATE_DIR=str(state/'state'),HUB_RESULTS_DIR=str(state/'results'),HUB_TOKEN=token,AGENTHUB_URL=endpoint('127.0.0.1',hubport,'/mcp'),PYTHONUTF8='1')
env.pop('HUB_MCP_URL',None)
(state/'env.json').write_text(json.dumps({key:env[key] for key in ('HUB_AGENTS_FILE','HUB_STATE_DIR','HUB_RESULTS_DIR','HUB_TOKEN','AGENTHUB_URL')}));(state/'env.json').chmod(0o600)
(state/'source-before.sha256').write_text(hashlib.sha256(source.read_bytes()).hexdigest())
(root/'.run').mkdir(exist_ok=True);(root/'logs').mkdir(exist_ok=True)
p=start_service(root,'hub',['python3',str(root/'hub/agent_hub.py'),'--http',str(hubport),'--host','127.0.0.1'],env)
wait_health(p,endpoint('127.0.0.1',hubport,'/health'),8,'agent-hub')
hosts={}
import shutil
for name in ('codex','zcode','dsh','deepseek'):
 binary=shutil.which(name);hosts[name]={'entry_on_ssh_path':bool(binary)}
home=pathlib.Path.home()
hosts['codex']['auth_file_exists']=(home/'.codex/auth.json').is_file()
hosts['zcode']['known_config_directory_exists']=(home/'.zcode').is_dir()
hosts['dsh']['known_config_directory_exists']=(home/'.dsh').is_dir() or (home/'.config/dsh').is_dir()
print(json.dumps({'token':token,'port':hubport,'state':str(state),'workspace':str(state/'workspace'),'hosts':hosts}))
'''.replace("DEPLOYMENT", repr(args.deployment)).replace("__STATE__", repr(remote_state))
    connection = json.loads(ssh(args.ssh_alias, setup, 35))
    tunnel = None
    summary = {"kind": "actual-native-linux-and-windows-to-linux-matrices", "source_sha256": hashes,
               "hosts_discovery": connection["hosts"], "windows_credentials_copied": False}
    try:
        local_port = port()
        tunnel = spawn_owned(["ssh", "-N", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no",
                              "-o", "ExitOnForwardFailure=yes", "-L", f"127.0.0.1:{local_port}:127.0.0.1:{connection['port']}", args.ssh_alias],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        private_connection = {"AGENTHUB_URL": f"http://127.0.0.1:{local_port}/mcp", "HUB_TOKEN": connection["token"],
                              "remote_cwd": connection["workspace"], "linux_state": connection["state"], "ssh_alias": args.ssh_alias}
        atomic_write_json(state / "connection.json", private_connection)
        print(json.dumps({"private_connection_file": str(state / "connection.json"), "status": "ready-for-native-host-probe"}), flush=True)
        native = '''import pathlib,json,subprocess,os
root=pathlib.Path(DEPLOYMENT);state=pathlib.Path(__STATE__)
env=os.environ.copy();env.update(json.loads((state/'env.json').read_text()));env.pop('HUB_MCP_URL',None)
p=subprocess.run(['python3',str(root/'scripts/remote_matrix_probe.py'),'--run','--local','--state',str(state/'native-client'),'--report',str(state/'native.json'),'--remote-cwd',str(state/'workspace')],env=env,cwd=root,timeout=850,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
if p.returncode:raise RuntimeError('Matrix harness exited '+str(p.returncode)+' '+p.stderr.decode('utf-8','replace')[-500:])
print((state/'native.json').read_text())
'''.replace("DEPLOYMENT", repr(args.deployment)).replace("__STATE__", repr(remote_state))
        summary["linux_native"] = redacted(json.loads(ssh(args.ssh_alias, native, 880)))
        native_report = args.report_prefix.with_name(args.report_prefix.name + "-linux-native.json")
        atomic_write_json(native_report, summary["linux_native"])
        print(json.dumps({"mode": "linux-native", "report": str(native_report), "counts": summary["linux_native"]["counts"]}), flush=True)
        from remote_matrix_probe import matrix
        env = dict(os.environ, HUB_TOKEN=connection["token"], AGENTHUB_URL=private_connection["AGENTHUB_URL"])
        env.pop("HUB_MCP_URL", None)
        windows_report = args.report_prefix.with_name(args.report_prefix.name + "-windows-to-linux.json")
        cross = matrix(state / "windows-client", windows_report, "windows-client-over-existing-ssh-to-real-linux-workers", env, connection["workspace"])
        references = [cell.get("final", {}).get("ref") for cell in cross["cells"] if cell.get("final", {}).get("ref")]
        evidence = '''import json,pathlib,hashlib
state=pathlib.Path(__STATE__);out={}
for ref in REFERENCES:
 path=state/'results'/(ref+'.json')
 if path.is_file():
  value=json.loads(path.read_text());out[ref]={key:value.get(key) for key in ('usage','exit_code','attachments','thinking','stream','model')}
source=pathlib.Path.home()/'agent-hub/agents.json'
print(json.dumps({'results':out,'old_configuration_unchanged':hashlib.sha256(source.read_bytes()).hexdigest()==(state/'source-before.sha256').read_text()}))
'''.replace("__STATE__", repr(remote_state)).replace("REFERENCES", repr(references))
        values = json.loads(ssh(args.ssh_alias, evidence, 20))
        for cell in cross["cells"]:
            stored = values["results"].get(cell.get("final", {}).get("ref"), {})
            if stored:
                cell.update(runtime_exit_code=stored["exit_code"], usage=stored["usage"], remote_attachments=stored["attachments"])
                reasoning = (stored["usage"] or {}).get("reasoning_tokens")
                cell["thinking_observed"] = (reasoning > 0 if cell["thinking"] == "on" else reasoning == 0) if isinstance(reasoning, (int,float)) else None
        cross["old_configuration_unchanged"] = values["old_configuration_unchanged"]
        atomic_write_json(windows_report, cross)
        summary["windows_to_linux"] = cross
        summary["old_configuration_unchanged"] = values["old_configuration_unchanged"]
        atomic_write_json(args.report_prefix.with_suffix(".json"), summary)
        print(json.dumps({"mode": "windows-to-linux", "report": str(windows_report), "counts": cross["counts"]}), flush=True)
    finally:
        if args.native_window:
            deadline = time.monotonic() + 900
            sentinel = state / "native-hosts-done"
            print(json.dumps({"status": "matrices-finished-waiting-native-hosts", "completion_sentinel": str(sentinel)}), flush=True)
            while not sentinel.exists() and time.monotonic() < deadline:
                time.sleep(.25)
        if tunnel:
            terminate_owned(tunnel)
        cleanup = "import pathlib,sys;root=pathlib.Path(" + repr(args.deployment) + ");sys.path.insert(0,str(root/'scripts'));from remote_linux_services import stop_service;stop_service(root,'hub');print('owned-test-hub-stopped')"
        print(ssh(args.ssh_alias, cleanup, 20).strip(), flush=True)


if __name__ == "__main__":
    main()
