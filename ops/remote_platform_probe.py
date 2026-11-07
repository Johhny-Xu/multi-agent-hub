#!/usr/bin/env python3
"""Deploy source without credentials to a new Linux SSH test directory and run suites."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
from command_runtime import spawn_owned, terminate_owned, atomic_write_json
FOLDERS = ("hub", "mcp", "console", "drivers", "plugins/agenthub-workers", "integrations/codex", "integrations/dsh", "tests", "scripts", "packaging")
EXCLUDE = {".git", "node_modules", "__pycache__", "state", "results", "logs", ".run", "data", "dist", "build"}


def redacted(value):
    text = json.dumps(value, ensure_ascii=True)
    text = re.sub(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])", "<redacted-ip>", text)
    text = re.sub(r"(?i)(?:https?://)[^\s\"<>]+", "<redacted-url>", text)
    text = re.sub(r"(?i)(token|api[_-]?key|authorization|password)([=: ]+)[^\s\"\\]+", r"\1\2<redacted>", text)
    return json.loads(text)


def run(argv, input_data=None, timeout=45):
    proc = spawn_owned(argv, stdin=subprocess.PIPE if input_data else subprocess.DEVNULL,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        out, err = proc.communicate(input_data, timeout=timeout)
        if proc.returncode:
            raise RuntimeError(json.dumps(redacted({"exit": proc.returncode, "stderr": err.decode("utf-8", "replace")[-1500:]})))
        return out.decode("utf-8", "replace")
    finally:
        terminate_owned(proc)
        if proc.stdin:
            proc.stdin.close()
        proc.stdout.close(); proc.stderr.close()


def ssh(alias, source, timeout=45):
    return run(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8", "-o", "ForwardAgent=no",
                alias, "python3 -"], source.encode("utf-8"), timeout)


def archive(destination):
    files = [ROOT / name for name in ("start.sh", "stop.sh", ".env.example", "LICENSE", "README.md")]
    for folder in FOLDERS:
        files.extend(path for path in (ROOT / folder).rglob("*") if path.is_file() and not path.is_symlink()
                     and not set(path.relative_to(ROOT).parts) & EXCLUDE
                     and path.name not in {"agents.json", "config.json", ".env", "hub.env"}
                     and path.suffix not in {".pyc", ".log", ".out", ".task"})
    hashes = {}
    with tarfile.open(destination, "w:gz") as package:
        for source in sorted(set(files)):
            relative = source.relative_to(ROOT).as_posix()
            package.add(source, arcname=relative, recursive=False)
            hashes[relative] = hashlib.sha256(source.read_bytes()).hexdigest()
    return hashes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ssh-alias", required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--deployment", help="Existing isolated /tmp/agenthub-platform-* source directory")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", args.ssh_alias):
        raise SystemExit("Use an existing SSH alias, not a URL or credential")
    report = {"kind": "real-linux-over-existing-ssh", "ssh_alias": args.ssh_alias,
              "tested_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "windows_credentials_copied": False,
              "old_deployment_modified": False}
    if args.deployment:
        deployment = args.deployment
        if not re.fullmatch(r"/tmp/agenthub-platform-[A-Za-z0-9_-]+", deployment):
            raise SystemExit("Deployment must be a previously created isolated /tmp directory")
    else:
        deployment = json.loads(ssh(args.ssh_alias, "import tempfile,json;print(json.dumps(tempfile.mkdtemp(prefix='agenthub-platform-')))"))
    report["isolated_deployment"] = deployment
    base = Path(tempfile.mkdtemp(prefix="agenthub-remote-source-"))
    source = base / "source.tar.gz"
    report["source_sha256"] = archive(source)
    run(["scp", "-q", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8", str(source), args.ssh_alias + ":" + deployment + "/source.tar.gz"])
    remote = '''import pathlib,tarfile,json,subprocess,os,sys,platform,time
root=pathlib.Path(DEPLOYMENT)
with tarfile.open(root/'source.tar.gz') as package:
 for member in package.getmembers():
  target=(root/member.name).resolve()
  if not target.is_relative_to(root) or not member.isfile():raise RuntimeError('Unsafe source archive')
 package.extractall(root,filter='data')
state=root.parent/(root.name+'-private-state');state.mkdir(exist_ok=True,mode=0o700)
env=os.environ.copy();env.update(HUB_STATE_DIR=str(state/'state'),HUB_RESULTS_DIR=str(state/'results'),HUB_AGENTS_FILE=str(state/'agents.json'),PYTHONUTF8='1')
env.pop('CODEX_TEST_BINARY',None)
out=[]
commands=[('linux_launcher',['python3','tests/platform_linux_smoke.py']),('isolated_cross_platform',['python3','tests/run_regressions.py','--report',str(state/'regressions.json')])]
for name,command in commands:
 p=subprocess.Popen(command,cwd=root,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
 try:
  stdout,_=p.communicate(timeout=300);text=stdout.decode('utf-8','replace');entry={'suite':name,'exit':p.returncode,'passed':p.returncode==0,'output_tail':text[-5500:]}
 except subprocess.TimeoutExpired:entry={'suite':name,'passed':False,'status':'timeout'}
 finally:
  import signal
  try:os.killpg(p.pid,signal.SIGKILL)
  except ProcessLookupError:pass
  p.wait();p.stdout.close()
 out.append(entry)
result={'system':platform.system(),'python':platform.python_version(),'suites':out,'existing_suite_report':json.loads((state/'regressions.json').read_text()) if (state/'regressions.json').is_file() else None}
print(json.dumps(result))
'''.replace("DEPLOYMENT", repr(deployment))
    report["linux"] = redacted(json.loads(ssh(args.ssh_alias, remote, timeout=360)))
    atomic_write_json(args.report, report)
    print(json.dumps({"report": str(args.report), "deployment": deployment,
                      "suites": [{k: item[k] for k in ("suite", "passed")} for item in report["linux"]["suites"]]}))
    return int(any(not item["passed"] for item in report["linux"]["suites"]))


if __name__ == "__main__":
    raise SystemExit(main())
