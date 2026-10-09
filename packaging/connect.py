#!/usr/bin/env python3
"""Discover, explicitly pair, and privately save a native client's Hub endpoint."""
import argparse
import getpass
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import sys
import time
import threading
import uuid
import warnings
from urllib.parse import urlsplit, urlunsplit
from runtime import SetupError, atomic_json, defaults, read_json


def endpoint(value):
    if not isinstance(value, str) or not value.strip():
        raise SetupError('Hub address must be HTTP(S) or host:port')
    parsed = urlsplit(value.strip() if '://' in value else 'http://' + value.strip())
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise SetupError('Hub address requires HTTP(S), without embedded credentials or query parameters')
    try:
        port = parsed.port
        if port is not None and not 1 <= port <= 65535:
            raise ValueError()
    except ValueError:
        raise SetupError('Invalid Hub endpoint port')
    host = parsed.hostname.lower()
    authority = ('[' + host + ']' if ':' in host else host) + (':' + str(port) if port else '')
    return urlunsplit((parsed.scheme, authority, parsed.path.rstrip('/') or '/mcp', '', ''))


def token_file(path):
    path = Path(path).expanduser()
    if path.is_symlink():
        raise SetupError('Refusing an indirect Hub token file')
    try:
        token = path.read_text(encoding='utf-8-sig').strip()
    except (OSError, UnicodeError):
        raise SetupError('Hub token file cannot be read')
    if len(token) < 32 or '\n' in token or '\r' in token:
        raise SetupError('Hub token file must contain one line with at least 32 characters')
    return token


def _response(url, deadline, body=None, headers=None):
    """Direct HTTP only: never use environment proxies or follow redirects."""
    parsed = urlsplit(url)
    port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    resolved, ready = {}, threading.Event()
    def resolve_address():
        try:
            resolved['addresses'] = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
        except OSError:
            resolved['addresses'] = []
        finally:
            ready.set()
    # System DNS cannot be cancelled portably. Its daemon does DNS only; it
    # cannot open a socket or send credentials after the caller's deadline.
    threading.Thread(target=resolve_address, daemon=True).start()
    remaining = deadline - time.monotonic()
    if remaining <= 0 or not ready.wait(remaining):
        raise SetupError('Hub verification deadline exceeded during address lookup')
    connection = http.client.HTTPConnection(parsed.hostname, port)
    owned_socket = {'value': None}
    expired = threading.Event()
    def cancel():
        expired.set()
        sock = owned_socket['value']
        if sock:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()
    timer = threading.Timer(max(0, deadline - time.monotonic()), cancel)
    timer.daemon = True
    timer.start()
    try:
        for family, kind, protocol, _, address in resolved.get('addresses', []):
            remaining = deadline - time.monotonic()
            if remaining <= 0 or expired.is_set():
                raise SetupError('Hub verification deadline exceeded')
            connection.sock = socket.socket(family, kind, protocol)
            owned_socket['value'] = connection.sock
            connection.sock.settimeout(remaining)
            try:
                connection.sock.connect(address)
                break
            except OSError:
                connection.sock.close(); connection.sock = None
        if connection.sock is None:
            raise SetupError('Hub address could not be reached')
        if parsed.scheme == 'https':
            connection.sock = ssl.create_default_context().wrap_socket(connection.sock, server_hostname=parsed.hostname, do_handshake_on_connect=False)
            owned_socket['value'] = connection.sock
            connection.sock.do_handshake()
        if expired.is_set() or time.monotonic() >= deadline:
            raise SetupError('Hub verification deadline exceeded')
        connection.request('POST' if body is not None else 'GET', parsed.path or '/', body=body, headers=headers or {})
        with connection.getresponse() as response:
            if expired.is_set() or time.monotonic() >= deadline:
                raise SetupError('Hub verification deadline exceeded')
            if response.status in (401, 403):
                raise SetupError('Hub authentication failed; provide its private token file')
            if response.status != 200:
                raise SetupError('Hub verification failed (HTTP ' + str(response.status) + '); configuration was preserved')
            chunks, size = [], 0
            while size <= 65536:
                if response.isclosed():
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise SetupError('Hub verification deadline exceeded')
                if owned_socket['value']:
                    owned_socket['value'].settimeout(remaining)
                chunk = response.read1(min(4096, 65537 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
            raw = b''.join(chunks)
        if len(raw) > 65536:
            raise SetupError('Hub verification response is too large')
        value = json.loads(raw.decode('utf-8'))
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (http.client.HTTPException, OSError, ValueError):
        raise SetupError('Hub verification failed; check its address, network and server status')
    finally:
        timer.cancel()
        connection.close()
        timer.join(timeout=.1)


def validate_connection(url, token='', timeout=3):
    url = endpoint(url)
    if not isinstance(token, str) or '\n' in token or '\r' in token:
        raise SetupError('Hub token must be a single-line string')
    if not isinstance(timeout, (int, float)) or not .1 <= timeout <= 30:
        raise SetupError('Verification timeout must be between 0.1 and 30 seconds')
    parsed = urlsplit(url)
    health_path = parsed.path.rsplit('/', 1)[0] + '/health'
    deadline = time.monotonic() + timeout
    health = _response(urlunsplit((parsed.scheme, parsed.netloc, health_path, '', '')), deadline)
    if health.get('service') != 'agent-hub' or health.get('status') != 'ok':
        raise SetupError('Address is not a healthy multi-agent-hub server')
    request_id = 'connect-' + uuid.uuid4().hex
    body = json.dumps({'jsonrpc': '2.0', 'id': request_id, 'method': 'ping', 'params': {}}).encode('utf-8')
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    result = _response(url, deadline, body, headers)
    if result.get('jsonrpc') != '2.0' or result.get('id') != request_id or not isinstance(result.get('result'), dict) or 'error' in result:
        raise SetupError('Authenticated MCP ping was not confirmed; configuration was preserved')
    return {'status': 'connected', 'setup_required': False, 'url': url, 'verified': True}


def scan(timeout=1.5, port=18766, known_urls=None):
    from discovery import discover
    result = discover(timeout=timeout, port=port, known_urls=known_urls)
    candidates = []
    seen = set()
    for item in result.get('candidates', []):
        try:
            url = endpoint(item.get('url'))
        except (SetupError, AttributeError, ValueError):
            continue
        if url in seen:
            continue
        seen.add(url)
        def label(value):
            return ''.join(char for char in str(value) if char.isprintable())[:120]
        candidates.append({'url': url, 'name': label(item.get('name', 'multi-agent-hub')),
                           'auth_required': bool(item.get('auth_required', True)), 'source': label(item.get('source', 'discovery'))})
    return {'candidates': candidates, 'errors': result.get('errors', []), 'manual_required': not bool(candidates)}


def existing_client(path, allow_invalid=False):
    path = Path(path)
    if path.is_symlink():
        raise SetupError('Refusing an indirect client configuration symlink')
    if not path.exists():
        return None
    try:
        value = read_json(path)
        endpoint(value.get('url'))
        if not isinstance(value.get('token', ''), str) or '\n' in value.get('token', '') or '\r' in value.get('token', ''):
            raise SetupError('Client token must be a single-line string')
        return value
    except SetupError:
        if allow_invalid:
            return None
        raise


def setup_required(result=None):
    result = result or {'candidates': [], 'errors': [], 'manual_required': True}
    return {'status': 'setup_required', 'setup_required': True, 'verified': False,
            'candidates': result['candidates'], 'discovery_errors': result.get('errors', []),
            'manual_required': result.get('manual_required', True),
            'next_step': 'Run connect.cmd or ./connect.sh, or pass --url HOST:PORT --token-file FILE'}


class DeferredSetup(Exception):
    def __init__(self, status):
        self.status = status


def _prepare(url=None, token_path=None, existing=None, interactive=None, timeout=1.5, port=18766,
            save_offline=False, input_fn=None, secret_fn=None, output=None):
    """Return a candidate connection without writing it; never select a LAN Hub implicitly."""
    interactive = sys.stdin.isatty() if interactive is None else interactive
    read_input = input_fn or input
    pending = setup_required()
    def input_fn(prompt):
        try:
            return read_input(prompt)
        except EOFError:
            raise DeferredSetup(pending)
    output = output or sys.stderr
    chosen = None
    if not url:
        result = scan(timeout, port, [existing['url']] if existing and existing.get('url') else None)
        pending = setup_required(result)
        if not interactive:
            return None, setup_required(result)
        if result['candidates']:
            print('发现可用 Hub，请选择：', file=output)
            for index, item in enumerate(result['candidates'], 1):
                print(str(index) + '. ' + item['name'] + '  ' + item['url'], file=output)
            print('0. 手动输入地址', file=output)
            selection = input_fn('选择编号：').strip()
            if not selection.isdigit() or int(selection) > len(result['candidates']):
                raise SetupError('Invalid Hub selection; configuration was preserved')
            if int(selection):
                chosen = result['candidates'][int(selection) - 1]
                url = chosen['url']
        else:
            print('未发现 Hub，请手动输入地址（可使用 host:port）。', file=output)
        if not url:
            url = input_fn('Hub 地址：').strip()
    url = endpoint(url)
    same_endpoint = bool(existing and existing.get('url') and endpoint(existing['url']) == url)
    token = token_file(token_path) if token_path else existing.get('token', '') if same_endpoint else ''
    if not isinstance(token, str) or '\n' in token or '\r' in token:
        raise SetupError('Existing Hub token is invalid; configuration was preserved')
    if interactive and not token and not token_path and (chosen is None or chosen['auth_required']):
        path = input_fn('私有 Hub 令牌文件路径（留空使用隐藏输入）：').strip()
        if path:
            token = token_file(path)
        else:
            with warnings.catch_warnings():
                warnings.simplefilter('error', getpass.GetPassWarning)
                try:
                    token = (secret_fn or getpass.getpass)('Hub 令牌（未鉴权时留空）：')
                except getpass.GetPassWarning:
                    raise SetupError('Hidden input is unavailable; use --token-file instead')
                except EOFError:
                    raise DeferredSetup(pending)
            if '\n' in token or '\r' in token:
                raise SetupError('Hub token must be a single line')
    if save_offline:
        if not token and urlsplit(url).hostname not in ('127.0.0.1', 'localhost', '::1'):
            raise SetupError('Offline remote configuration requires --token-file')
        status = {'status': 'configured_unverified', 'setup_required': False, 'verified': False, 'url': url}
    else:
        status = validate_connection(url, token)
    return {'url': url, 'token': token}, status


def prepare(*args, **kwargs):
    try:
        return _prepare(*args, **kwargs)
    except DeferredSetup as deferred:
        return None, deferred.status


def save_connection(path, connection):
    path = Path(path)
    previous = existing_client(path, allow_invalid=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    if os.name != 'nt':
        os.chmod(path.parent, 0o700)
    backup = None
    if path.exists():
        directory = path.parent / 'backups'
        try:
            directory.resolve().relative_to(path.parent.resolve())
        except ValueError:
            raise SetupError('Client backup path escapes its private configuration directory')
        directory.mkdir(exist_ok=True)
        if os.name != 'nt':
            os.chmod(directory, 0o700)
        backup = directory / ('client-' + str(time.time_ns()) + '.json')
        shutil.copy2(path, backup)
        os.chmod(backup, 0o600)
    value = dict(previous or {}, **connection)
    value.pop('setup_required', None)
    atomic_json(path, value)
    return bool(backup)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prefix', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--config-dir', type=Path)
    parser.add_argument('--url')
    parser.add_argument('--token-file', type=Path)
    parser.add_argument('--scan', action='store_true')
    parser.add_argument('--save-offline', action='store_true')
    parser.add_argument('--timeout', type=float, default=1.5)
    parser.add_argument('--discovery-port', type=int, default=18766)
    args = parser.parse_args()
    try:
        if args.scan and (args.url or args.token_file or args.save_offline):
            raise SetupError('--scan only lists candidates; do not combine it with connection credentials')
        if args.save_offline and not args.url:
            raise SetupError('--save-offline requires an explicit --url')
        if args.config_dir:
            config_dir = args.config_dir.expanduser().resolve()
        elif (args.prefix / 'install.json').is_file():
            config_dir = Path(read_json(args.prefix / 'install.json')['config_dir'])
        else:
            _, config_dir = defaults()
        path = config_dir / 'client.json'
        if args.scan:
            result = scan(args.timeout, args.discovery_port)
            print(json.dumps(dict(ok=True, **result), ensure_ascii=False))
            return 0
        previous = existing_client(path, allow_invalid=bool(args.url) or sys.stdin.isatty())
        connection, status = prepare(args.url, args.token_file, previous, timeout=args.timeout,
                                     port=args.discovery_port, save_offline=args.save_offline)
        if connection is None:
            print(json.dumps({'ok': False, 'connection': status, 'token_values_printed': False}, ensure_ascii=False))
            return 2
        backup = save_connection(path, connection)
        print(json.dumps({'ok': True, 'connection': status, 'backup_created': backup, 'token_values_printed': False,
                          'next_step': 'Restart the native host or its MCP connection to load the saved Hub'}, ensure_ascii=False))
        return 0
    except (SetupError, OSError, ValueError, EOFError, KeyboardInterrupt) as error:
        message = 'Connection setup cancelled; configuration was preserved' if isinstance(error, (EOFError, KeyboardInterrupt)) else str(error)
        print(json.dumps({'ok': False, 'error': message, 'token_values_printed': False}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
