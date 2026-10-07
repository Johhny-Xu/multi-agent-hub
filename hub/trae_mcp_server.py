#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""trae-mcp: 把 TraeCode CN Linux 桌面版暴露为 MCP 服务器 (经 TraeClaw 网关驱动)

  python3 trae_mcp_server.py --stdio                     # MCP stdio 传输
  python3 trae_mcp_server.py --http [port]               # Streamable HTTP (默认 8788)

环境变量: TRAE_GATEWAY=http://127.0.0.1:8787  TRAE_MCP_TOKEN=访问令牌
依赖: 仅 Python 标准库; Trae 驱动由 TraeClaw 网关 (8787) 完成。
"""

import json
import os
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

GATEWAY = os.environ.get("TRAE_GATEWAY", "http://127.0.0.1:8787").rstrip("/")
TOKEN = os.environ.get("TRAE_MCP_TOKEN", "").strip()
SERVER_NAME = "trae-mcp"
SERVER_VERSION = "0.1.0"


def gw_post(path: str, payload: dict, timeout: int = 240) -> dict:
    req = urllib.request.Request(
        GATEWAY + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def gw_get(path: str, timeout: int = 15) -> dict:
    with urllib.request.urlopen(GATEWAY + path, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def tool_trae_status(args):
    h = gw_get("/health")
    data = h.get("data", {})
    auto = data.get("automation", {})
    tgt = (auto.get("target") or {}).get("title", "")
    return f"TraeClaw 网关: {data.get('status', '?')} | CDP 自动化: {'就绪' if auto.get('ready') else '未就绪'} | 目标窗口: {tgt}"


def tool_trae_delegate(args):
    content = str(args.get("task") or "").strip()
    if not content:
        raise ValueError("缺少 task")
    session_id = args.get("session_id")
    payload = {"content": content}
    if session_id:
        payload["sessionId"] = session_id
    timeout = int(float(args.get("timeout_s") or 240))
    resp = gw_post("/v1/chat", payload, timeout=max(timeout, 30) + 30)
    data = resp.get("data", {})
    sess = data.get("session", {})
    result = (data.get("result") or {})
    text = result.get("text") or ""
    status = sess.get("status") or result.get("status")
    sid = args.get("session_id") or sess.get("sessionId", "new")
    if not text.strip():
        # 兜底: 网关提取为空时, 经 CDP 直接读取界面上最后一条 agent 回复
        import subprocess
        rd = os.path.expanduser("~/TraeClaw/dom_read.js")
        if os.path.exists(rd):
            try:
                p = subprocess.run(["/usr/bin/node", rd], capture_output=True,
                                   text=True, timeout=30)
                if p.stdout.strip():
                    text = p.stdout.strip()
            except (OSError, subprocess.TimeoutExpired):
                pass
    out = f"[trae/{sid}] status={status}\n{text[:4000] or '(空响应)'}"
    if sess.get("sessionId"):
        out += f"\n(继续对话请带 session_id: {sess['sessionId']})"
    return out


def tool_trae_new_chat(args):
    gw_post("/v1/mode", {"mode": str(args.get("mode") or "chat")}, timeout=15)
    return "已请求切换会话模式/新建会话。"


TOOL_DEFS = [
    ("trae_status", "查看 TraeCode 桌面版(服务器上)的连接与就绪状态", {}, []),
    ("trae_delegate", "把一个任务派给 TraeCode 的 AI 执行(走 Trae 个人账号额度), 返回它的回答。带 session_id 可延续同一会话。",
     {"task": {"type": "string", "description": "要交给 Trae 的任务/提示词"},
      "session_id": {"type": "string", "description": "延续已有会话时传入"},
      "timeout_s": {"type": "number", "default": 240}},
     ["task"]),
    ("trae_new_chat", "请求 Trae 切换/新建会话模式", {"mode": {"type": "string"}}, []),
]

TOOLS_JSON = [{"name": n, "description": d, "inputSchema": {"type": "object", "properties": p,
               "required": r, "additionalProperties": True}} for n, d, p, r in TOOL_DEFS]
HANDLERS = {n: f for n, d, f, r in
            [(t[0], t[1], globals().get("tool_" + t[0]), t[3]) for t in TOOL_DEFS]}


def handle_request(req):
    if isinstance(req, list):
        return [r for r in (handle_request(x) for x in req) if r is not None] or None
    if not isinstance(req, dict) or req.get("jsonrpc") != "2.0":
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}
    method, rid, params = req.get("method"), req.get("id"), req.get("params") or {}
    is_notify = "id" not in req

    def ok(result):
        return {"jsonrpc": "2.0", "id": rid, "result": result} if not is_notify else None

    def err(code, message):
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}} if not is_notify else None

    try:
        if method == "initialize":
            return ok({"protocolVersion": params.get("protocolVersion") or "2024-11-05",
                       "capabilities": {"tools": {}},
                       "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION}})
        if method == "ping":
            return ok({})
        if method.startswith("notifications/"):
            return None
        if method == "tools/list":
            return ok({"tools": TOOLS_JSON})
        if method == "tools/call":
            name = params.get("name")
            fn = HANDLERS.get(name)
            if not fn:
                return err(-32602, f"Unknown tool: {name}")
            try:
                return ok({"content": [{"type": "text", "text": fn(params.get("arguments") or {})}],
                           "isError": False})
            except Exception as e:  # noqa: BLE001
                return ok({"content": [{"type": "text", "text": f"工具执行出错: {e}"}], "isError": True})
        return err(-32601, f"Method not found: {method}")
    except Exception as e:  # noqa: BLE001
        return err(-32603, f"Internal error: {e}")


def run_stdio():
    out = sys.stdout.buffer
    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            resp = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
        else:
            resp = handle_request(req)
        if resp is not None:
            out.write(json.dumps(resp, ensure_ascii=False).encode("utf-8") + b"\n")
            out.flush()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _authorized(self):
        if not TOKEN:
            return True
        auth = self.headers.get("Authorization") or ""
        supplied = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        if not supplied:
            import urllib.parse
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            supplied = (q.get("token") or [""])[0]
        return bool(supplied) and supplied == TOKEN

    def do_GET(self):
        if self.path.startswith("/health"):
            body = json.dumps({"service": SERVER_NAME, "status": "ok"}).encode()
            self.send_response(200)
        else:
            self.send_response(404)
            body = b"{}"
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        import urllib.parse
        path = urllib.parse.urlparse(self.path).path.rstrip("/")
        if path != "/mcp" or not self._authorized():
            self.send_response(401 if not self._authorized() else 404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length)
            try:
                req = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                # Windows 客户端常误发 GBK 编码中文, 兜底解码
                req = json.loads(raw.decode("gbk"))
        except (ValueError, UnicodeDecodeError, OSError):
            self.send_response(400)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        resp = handle_request(req)
        if resp is None:
            self.send_response(202)
        else:
            body = json.dumps(resp, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
        try:
            self.end_headers()
            self.wfile.write(body if resp is not None else b"")
        except OSError:
            pass

    def log_message(self, fmt, *args):
        sys.stderr.write("[trae-mcp] " + (fmt % args) + "\n")


def main():
    argv = sys.argv[1:]
    if "--http" in argv:
        i = argv.index("--http")
        port = int(argv[i + 1]) if i + 1 < len(argv) and argv[i + 1].isdigit() else 8788
        try:
            sys.stderr.reconfigure(line_buffering=True)
        except (AttributeError, OSError):
            pass
        server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
        sys.stderr.write(f"[trae-mcp] HTTP MCP: http://0.0.0.0:{port}/mcp (token={'启用' if TOKEN else '未设'})\n")
        server.serve_forever()
    else:
        run_stdio()


if __name__ == "__main__":
    main()
