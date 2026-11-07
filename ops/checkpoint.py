"""Create and verify a source checkpoint outside the repository (no runtime credentials)."""
import argparse
import datetime
import hashlib
import json
import subprocess
import zipfile
from pathlib import Path
from audit_secrets import scan

ROOT = Path(__file__).resolve().parents[1]


def checkpoint(destination, label):
    destination = Path(destination).expanduser().resolve()
    if destination == ROOT or ROOT in destination.parents:
        raise ValueError("Checkpoints must be outside the source repository")
    if not label or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in label):
        raise ValueError("Invalid checkpoint label")
    if not scan()["passed"]:
        raise ValueError("Source secret audit failed; inspect scripts/audit_secrets.py diagnostics before checkpointing")
    destination.mkdir(parents=True, exist_ok=True)
    names = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=ROOT).decode("utf-8").split("\0")
    stamp = datetime.datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    path = destination / ("agenthub-" + label + "-" + stamp + ".zip")
    hashes = {}
    with zipfile.ZipFile(path, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(set(names)):
            source = ROOT / name
            if not name or not source.is_file() or source.is_symlink():
                continue
            if source.name in {"agents.json", "auth.json", ".auth.json", "ModuleAnalysisCache"} or source.name.lstrip(".").startswith("credentials"):
                continue
            if source.name.startswith(".env") and source.name != ".env.example" or source.suffix.lower() in {".pem", ".key"}:
                continue
            if any(part in {".git", "node_modules", ".run", "state", "results", "__pycache__"} for part in source.relative_to(ROOT).parts):
                continue
            data = source.read_bytes()
            archive.writestr(name, data)
            hashes[name] = hashlib.sha256(data).hexdigest()
        archive.writestr("BACKUP-MANIFEST.json", json.dumps({"created_at": stamp, "source_sha256": hashes}, indent=2))
    with zipfile.ZipFile(path) as archive:
        if archive.testzip() is not None or any(hashlib.sha256(archive.read(name)).hexdigest() != digest for name, digest in hashes.items()):
            raise RuntimeError("Checkpoint verification failed")
    return {"archive": str(path), "verified_files": len(hashes), "archive_sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--label", required=True)
    args = parser.parse_args()
    print(json.dumps(checkpoint(args.destination, args.label), indent=2))
