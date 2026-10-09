"""Shared MCP JSON-RPC handling for the Hub and its scoped Trae server."""
import math


def handle_request(req, *, tools, handlers, name, version, protocol="2024-11-05"):
    def dispatch(item):
        return handle_request(item, tools=tools, handlers=handlers, name=name,
                              version=version, protocol=protocol)

    if isinstance(req, list) and req:
        return [reply for reply in map(dispatch, req) if reply is not None] or None
    rid = req.get("id") if isinstance(req, dict) else None
    valid_id = (not isinstance(rid, bool) and isinstance(rid, (str, int, float, type(None)))
                and (not isinstance(rid, float) or math.isfinite(rid)))
    if (not isinstance(req, dict) or req.get("jsonrpc") != "2.0"
            or not isinstance(req.get("method"), str) or not valid_id):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}
    # A notification must never execute a tool with side effects.
    if "id" not in req:
        return None

    def ok(result):
        return {"jsonrpc": "2.0", "id": rid, "result": result}

    def error(code, message):
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}

    params = req.get("params", {})
    if not isinstance(params, dict):
        return error(-32602, "params must be an object")
    method = req["method"]
    if method == "initialize":
        return ok({"protocolVersion": params.get("protocolVersion") or protocol,
                   "capabilities": {"tools": {}}, "serverInfo": {"name": name, "version": version}})
    if method == "ping":
        return ok({})
    if method == "tools/list":
        return ok({"tools": tools})
    if method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments", {})
        if not isinstance(tool_name, str) or not isinstance(arguments, dict):
            return error(-32602, "tool name must be a string and arguments must be an object")
        fn = handlers.get(tool_name)
        if not fn:
            return error(-32602, f"Unknown tool: {tool_name}")
        try:
            return ok({"content": [{"type": "text", "text": str(fn(arguments))}], "isError": False})
        except Exception as exc:
            return ok({"content": [{"type": "text", "text": f"工具执行出错: {exc}"}], "isError": True})
    return error(-32601, f"Method not found: {method}")
