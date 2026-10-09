"""Read-only public model/effort contract of the installed ZCode headless CLI."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
from live_workers_windows import ROOT, HOME, NODE, ZCODE, sanitize
from command_runtime import spawn_owned, terminate_owned
from output_parser import parse_output


def main():
    directory = Path(tempfile.mkdtemp(prefix="agenthub-zcode-contract-"))
    environment = dict(os.environ)
    paths = list((HOME / ".zcode/v2/runtime/provider/windows-x86_64/3.14.4").glob("*/zcode-builtin.json"))
    if paths:
        environment["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"] = str(paths[0])
    records = []
    for command in ("/model", "/effort"):
        argv = [str(NODE), str(ZCODE), "--cwd", str(directory), "--json", "--disallowed-tools", "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,Agent", "--prompt", command]
        proc = spawn_owned(argv, cwd=str(directory), env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            stdout, stderr = proc.communicate(timeout=30)
            public = parse_output(stdout.decode("utf-8", errors="replace"))
            records.append({"command": command, "argv": argv, "exit_code": proc.returncode, "public_response": sanitize(public["text"]), "error": sanitize(public["error"]) if public["error"] else None})
        except subprocess.TimeoutExpired:
            records.append({"command": command, "argv": argv, "status": "timeout"})
        finally:
            terminate_owned(proc)
    (ROOT / "docs/live-workers-zcode-contract.json").write_text(json.dumps({"read_only": True, "no_credentials_read": True, "records": records}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(records, ensure_ascii=True))


if __name__ == "__main__":
    main()
