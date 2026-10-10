#!/usr/bin/env python3
"""Build source-only, credential-free Hub/client ZIPs from an explicit allowlist."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
VERSION = '0.9.4'
COMMON = ['README.md', 'install.cmd', 'install.sh', 'start.cmd', 'start.sh', 'stop.cmd', 'stop.sh', 'status.cmd', 'status.sh', 'connect.cmd', 'connect.sh',
          'packaging/install.py', 'packaging/runtime.py', 'packaging/service.py', 'packaging/native.py',
          'packaging/bootstrap.ps1', 'packaging/launch.sh', 'packaging/README.md', 'packaging/connect.py', 'packaging/discovery.py']
DENIED = {'agents.json', '.env', 'auth.json', 'credentials.json', 'client.json', 'hub.json', 'install.json'}


def package_files(component):
    wrappers = {name for name in COMMON if '/' not in name}
    files = {name: ROOT / 'packaging' / name if name in wrappers else ROOT / name for name in COMMON}
    files['LICENSE'] = ROOT / 'LICENSE'
    if component in ('hub', 'both'):
        for source in (ROOT / 'hub').iterdir():
            if source.suffix == '.py' or source.name in ('capabilities.json', 'agents.example.json', 'agents.windows.example.json', 'agents.minimal.example.json'):
                files['payload/hub/' + source.name] = source
        files['payload/drivers/zcode_rpc.mjs'] = ROOT / 'drivers/zcode_rpc.mjs'
        files['payload/drivers/codearts_cli.py'] = ROOT / 'drivers/codearts_cli.py'
        files['payload/console/server.mjs'] = ROOT / 'console/server.mjs'
        for source in (ROOT / 'console/client').rglob('*'):
            if source.is_file() and source.suffix.lower() in ('.html', '.mjs', '.js', '.css', '.png', '.ico', '.svg'):
                files['payload/console/client/' + source.relative_to(ROOT / 'console/client').as_posix()] = source
    if component in ('plugins', 'both'):
        files['payload/packaging/README.md'] = ROOT / 'packaging/README.md'
        files['payload/LICENSE'] = ROOT / 'LICENSE'
        for directory in ('integrations/codex', 'integrations/dsh', 'integrations/codearts', 'integrations/antigravity', 'plugins/agenthub-workers'):
            for source in (ROOT / directory).rglob('*'):
                if source.is_file() and (source.suffix.lower() in ('.json', '.mjs', '.js', '.toml', '.md', '.yml', '.yaml', '.py', '.sh', '.bat', '.png', '.svg') or source.name == 'requirements.txt'):
                    if any(part in ('node_modules', '__pycache__', 'cache', 'data', 'sessions', '.venv', 'venv', 'site-packages', 'dist-packages') for part in source.relative_to(ROOT).parts):
                        continue
                    files['payload/' + source.relative_to(ROOT).as_posix()] = source
    for name, source in files.items():
        try:
            source.resolve().relative_to(ROOT.resolve())
        except ValueError:
            raise ValueError('Package source escapes the repository: ' + name)
        if not source.is_file() or source.is_symlink() or source.name in DENIED or source.suffix in ('.log', '.jsonl'):
            raise ValueError('Unsafe or missing package source: ' + name)
    return files


def build(output, component):
    output = Path(output).resolve()
    if output == ROOT or ROOT in output.parents:
        raise ValueError('Release output must be outside the repository')
    output.mkdir(parents=True, exist_ok=True)
    files = package_files(component)
    entries = {name: source.read_bytes() for name, source in files.items()}
    # Separate native marketplaces avoid confusing the hosts' different schemas.
    if component in ('plugins', 'both'):
        entries['payload/.agents/plugins/marketplace.json'] = (json.dumps({
            'name': 'agenthub-local', 'plugins': [{'name': 'agenthub-workers', 'source': {'source': 'local', 'path': './integrations/codex'},
            'policy': {'installation': 'AVAILABLE', 'authentication': 'ON_INSTALL'}, 'category': 'Developer Tools'}]}, indent=2) + '\n').encode()
        entries['payload/.zcode-plugin/marketplace.json'] = (json.dumps({
            'name': 'agenthub-local', 'plugins': [{'name': 'agenthub-workers', 'version': VERSION, 'source': './plugins/agenthub-workers'}]}, indent=2) + '\n').encode()
    manifest = {'name': 'AgentHub', 'version': VERSION, 'component': component,
                'files': {name: hashlib.sha256(content).hexdigest() for name, content in sorted(entries.items())}}
    entries['manifest.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    entries['SHA256SUMS'] = ''.join(hashlib.sha256(content).hexdigest() + '  ' + name + '\n' for name, content in sorted(entries.items())).encode()
    prefix = 'agenthub-' + VERSION + '-' + component + '/'
    target = output / ('agenthub-' + VERSION + '-' + component + '.zip')
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in sorted(entries.items()):
            info = zipfile.ZipInfo(prefix + name, date_time=(2026, 10, 8, 0, 0, 0))
            # Windows-built ZIPs must retain executable Linux entry points.
            info.create_system = 3
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o755 if name.endswith('.sh') else 0o644) << 16
            archive.writestr(info, content)
    return {'file': target.name, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
            'bytes': target.stat().st_size, 'source_files': len(files), 'component': component}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--component', choices=('hub', 'plugins', 'both', 'all'), default='all')
    args = parser.parse_args()
    records = [build(args.output, component) for component in (('hub', 'plugins', 'both') if args.component == 'all' else (args.component,))]
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / 'SHA256SUMS').write_text(''.join(item['sha256'] + '  ' + item['file'] + '\n' for item in records), encoding='utf-8')
    print(json.dumps({'version': VERSION, 'artifacts': records}, indent=2))


if __name__ == '__main__':
    main()
