#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Scoped Trae MCP adapter, sharing the Hub runtime and transport fixes.

python trae_mcp_server.py --stdio
python trae_mcp_server.py --http 8788 --host 127.0.0.1
Environment: TRAE_GATEWAY, TRAE_MCP_TOKEN (HUB_TOKEN fallback).
"""
import json
import os
import sys
import urllib.parse
from http.server import ThreadingHTTPServer
import agent_hub as hub
from rpc_protocol import handle_request as dispatch

TOKEN = os.environ.get("TRAE_MCP_TOKEN", os.environ.get("HUB_TOKEN", "")).strip()
SERVER_NAME = "trae-mcp"
SERVER_VERSION = "0.2.0"
_NAMES = {"trae_status", "trae_delegate", "trae_result", "trae_new_chat", "hub_wait_result"}
TOOLS_JSON = [tool for tool in hub.TOOLS_JSON if tool["name"] in _NAMES]
HANDLERS = {key: entry[0] for key, entry in hub.HANDLERS.items() if key in _NAMES}


def handle_request(req):
    return dispatch(req, tools=TOOLS_JSON, handlers=HANDLERS, name=SERVER_NAME, version=SERVER_VERSION)


def run_stdio():
    for raw in sys.stdin.buffer:
        if not raw.strip():
            continue
        try:
            req = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeError):
            reply = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
        else:
            reply = handle_request(req)
        if reply is not None:
            sys.stdout.buffer.write(json.dumps(reply, ensure_ascii=False).encode("utf-8") + b"\n")
            sys.stdout.buffer.flush()


class Handler(hub._HTTPHandler):
    def access_token(self):
        return TOKEN

    def dispatch_request(self, req):
        return handle_request(req)

    def do_GET(self):
        if urllib.parse.urlparse(self.path).path != "/health":
            return super().do_GET()
        body = json.dumps({"service": SERVER_NAME, "status": "ok"}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    argv = sys.argv[1:]
    if "--http" not in argv:
        return run_stdio()
    index = argv.index("--http")
    port = int(argv[index + 1]) if index + 1 < len(argv) and argv[index + 1].isdigit() else 8788
    host = argv[argv.index("--host") + 1] if "--host" in argv else os.environ.get("TRAE_MCP_HOST", "127.0.0.1")
    if host not in ("127.0.0.1", "localhost", "::1") and not TOKEN:
        raise SystemExit("非回环监听必须设置 TRAE_MCP_TOKEN 或 HUB_TOKEN")
    server = ThreadingHTTPServer((host, port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
