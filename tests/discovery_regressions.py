"""Real local UDP/HTTP discovery and hostile input; no vendor/model calls."""
from contextlib import contextmanager
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import threading
import time
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
import agent_hub as hub
import discovery as responder

spec = importlib.util.spec_from_file_location("packaging_discovery_client", ROOT / "packaging/discovery.py")
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


@contextmanager
def health_server(*, service="agent-hub", auth=True, status=200, delay=0, body=None, location=None):
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append({"path": self.path, "authorization": self.headers.get("Authorization"), "cookie": self.headers.get("Cookie")})
            if delay:
                time.sleep(delay)
            payload = body if body is not None else json.dumps({"service": service, "status": "ok", "auth_required": auth}).encode()
            try:
                self.send_response(status)
                if location:
                    self.send_header("Location", location)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except OSError:
                pass
        def log_message(self, *args):
            pass
    class Server(ThreadingHTTPServer):
        daemon_threads = True
    server = Server(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.01), daemon=True)
    thread.start()
    try:
        yield server.server_address[1], requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=1)


@contextmanager
def advertisements(make_packets):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", 0))
    sock.settimeout(.05)
    done = threading.Event()
    def serve():
        while not done.is_set():
            try:
                packet, address = sock.recvfrom(2048)
                request = json.loads(packet)
                for response in make_packets(request):
                    payload = json.dumps(response).encode() if isinstance(response, dict) else response
                    sock.sendto(payload, address)
            except socket.timeout:
                continue
            except OSError:
                break
    thread = threading.Thread(target=serve, name="test-discovery-udp", daemon=True)
    thread.start()
    try:
        yield sock.getsockname()[1]
    finally:
        done.set()
        sock.close()
        thread.join(timeout=1)


def reply(request, http_port, **extra):
    result = {"service": "agenthub-discovery", "version": 1, "nonce": request["nonce"],
              "port": http_port, "path": "/mcp", "name": "fixture", "auth_required": False}
    result.update(extra)
    return result


class DiscoveryTests(unittest.TestCase):
    def test_real_udp_http_roundtrip_deduplicates_and_uses_health_auth(self):
        with health_server(auth=True) as (http_port, requests):
            server = responder.DiscoveryResponder("127.0.0.1", http_port, False, port=0, name="fixture.example")
            try:
                result = client.discover(timeout=.5, port=server.address[1], targets=["127.0.0.1", "127.0.0.1"])
                self.assertEqual(result["candidates"], [{"url": f"http://127.0.0.1:{http_port}/mcp", "name": "fixture", "auth_required": True, "source": "udp"}])
                self.assertFalse(result["manual_required"])
                self.assertEqual(len(requests), 1)
            finally:
                server.close()
            self.assertFalse(server.thread.is_alive())
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as released:
                released.bind(server.address)

    def test_responder_reply_has_only_public_protocol_fields(self):
        server = responder.DiscoveryResponder("localhost", 8765, True, port=0, name="fixture.example")
        try:
            nonce = "a" * 32
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                probe.settimeout(.5)
                probe.sendto(json.dumps({"service": "agenthub-discovery", "version": 1, "nonce": nonce, "token": "SYNTHETIC_NOT_ADVERTISED"}).encode(), server.address)
                response = json.loads(probe.recvfrom(2048)[0])
            self.assertEqual(set(response), {"service", "version", "nonce", "port", "path", "name", "auth_required"})
            self.assertEqual(response["nonce"], nonce)
            self.assertTrue(response["auth_required"])
            self.assertEqual(server.address[0], "127.0.0.1")
            self.assertNotIn("SYNTHETIC_NOT_ADVERTISED", json.dumps(response))
        finally:
            server.close()

    def test_responder_rejects_invalid_request_and_packet_size(self):
        server = responder.DiscoveryResponder("127.0.0.1", 8765, False, port=0)
        try:
            good = {"service": "agenthub-discovery", "version": 1, "nonce": "0" * 32}
            for request in ({**good, "version": True}, {**good, "service": "other"}, {**good, "nonce": "short"}, [], {**good, "padding": "x" * 1200}):
                self.assertIsNone(server._reply(json.dumps(request).encode()))
            self.assertIsNone(server._reply(b"invalid-json"))
            self.assertIsNotNone(server._reply(json.dumps(good).encode()))
        finally:
            server.close()

    def test_advertised_urls_and_secrets_are_ignored(self):
        with health_server(auth=True) as (http_port, requests), health_server() as (evil_port, evil_requests):
            with advertisements(lambda request: [reply(request, http_port, url=f"http://127.0.0.1:{evil_port}/mcp?token=SYNTHETIC_SECRET", token="SYNTHETIC_SECRET", path="/mcp", name="fixture; RUN /evil")]) as udp_port:
                result = client.discover(timeout=.5, port=udp_port, targets=["127.0.0.1"])
            self.assertEqual(result["candidates"][0]["url"], f"http://127.0.0.1:{http_port}/mcp")
            self.assertTrue(result["candidates"][0]["auth_required"])
            self.assertEqual(evil_requests, [])
            self.assertNotIn("SYNTHETIC_SECRET", json.dumps(result))
            self.assertNotIn(";", result["candidates"][0]["name"])
            self.assertTrue(all(request["authorization"] is None and request["cookie"] is None for request in requests))

    def test_wrong_nonce_and_malformed_responses_never_trigger_http(self):
        with health_server() as (http_port, requests):
            def packets(request):
                return [reply(request, http_port, nonce="f" * 32), reply(request, http_port, version=True),
                        reply(request, True), reply(request, http_port, path="/unsafe"), b"{" + b"x" * 1500, b"not json"]
            with advertisements(packets) as udp_port:
                result = client.discover(timeout=.25, port=udp_port, targets=["127.0.0.1"])
            self.assertEqual(result["candidates"], [])
            self.assertTrue(result["manual_required"])
            self.assertEqual(requests, [])

    def test_fake_trae_health_is_rejected(self):
        with health_server(service="trae-mcp") as (http_port, _), advertisements(lambda request: [reply(request, http_port)]) as udp_port:
            result = client.discover(timeout=.5, port=udp_port, targets=["127.0.0.1"])
        self.assertEqual(result["candidates"], [])
        self.assertIn("health_validation_failed", result["errors"])

    def test_redirect_is_not_followed(self):
        with health_server() as (destination, requests):
            with health_server(status=302, location=f"http://127.0.0.1:{destination}/health") as (redirect_port, _):
                result = client.discover(timeout=.5, targets=[], known_urls=[f"http://127.0.0.1:{redirect_port}/mcp"])
        self.assertTrue(result["manual_required"])
        self.assertEqual(requests, [])

    def test_known_endpoint_strips_query_never_uses_proxy_and_rejects_userinfo(self):
        with health_server() as (http_port, requests), health_server() as (proxy_port, proxy_requests):
            endpoint = f"http://127.0.0.1:{http_port}/mcp?token=SYNTHETIC_SECRET"
            with patch.dict(os.environ, {"http_proxy": f"http://127.0.0.1:{proxy_port}", "HTTP_PROXY": f"http://127.0.0.1:{proxy_port}"}):
                result = client.discover(timeout=.5, targets=[], known_urls=[endpoint, f"http://user:SYNTHETIC_SECRET@127.0.0.1:{http_port}/mcp"])
        self.assertEqual(result["candidates"], [{"url": f"http://127.0.0.1:{http_port}/mcp", "name": "127", "auth_required": True, "source": "configured"}])
        self.assertEqual(requests, [{"path": "/health", "authorization": None, "cookie": None}])
        self.assertEqual(proxy_requests, [])
        self.assertIn("invalid_known_url", result["errors"])
        self.assertNotIn("SYNTHETIC_SECRET", json.dumps(result))

    def test_old_health_auth_is_conservatively_required(self):
        with health_server(body=b'{"service":"agent-hub","status":"ok"}') as (http_port, _):
            result = client.discover(timeout=.3, targets=[], known_urls=[f"http://127.0.0.1:{http_port}/mcp"])
        self.assertTrue(result["candidates"][0]["auth_required"])

    def test_non_ok_health_is_rejected_and_default_legacy_probe_is_uncredentialed(self):
        with health_server(body=b'{"service":"agent-hub","status":"error"}') as (http_port, _):
            result = client.discover(timeout=.3, targets=[], known_urls=[f"http://127.0.0.1:{http_port}/mcp"])
        self.assertTrue(result["manual_required"])
        with patch.object(client, "_health", return_value=None) as verify:
            client.discover(timeout=.05)
        self.assertIn("http://127.0.0.1:8765/mcp", [call.args[0] for call in verify.call_args_list])

    def test_http_timeout_is_bounded_and_thread_exits(self):
        with health_server(delay=.5) as (http_port, _):
            began = time.monotonic()
            result = client.discover(timeout=.2, targets=[], known_urls=[f"http://127.0.0.1:{http_port}/mcp"])
            self.assertLess(time.monotonic() - began, .45)
            self.assertTrue(result["manual_required"])
            deadline = time.monotonic() + .4
            while any(thread.name == "agenthub-discovery-health" for thread in threading.enumerate()) and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertFalse(any(thread.name == "agenthub-discovery-health" for thread in threading.enumerate()))

    def test_response_body_size_and_error_output_are_bounded(self):
        with health_server(body=b"SYNTHETIC_SECRET" + b"x" * 5000) as (http_port, _):
            result = client.discover(timeout=.3, targets=[], known_urls=[f"http://127.0.0.1:{http_port}/mcp"])
        self.assertEqual(result["candidates"], [])
        self.assertNotIn("SYNTHETIC_SECRET", json.dumps(result))

    def test_udp_packet_limit_and_no_service_timeout(self):
        with advertisements(lambda request: [b"malformed"] * 100) as udp_port:
            began = time.monotonic()
            result = client.discover(timeout=.2, port=udp_port, targets=["127.0.0.1"])
            self.assertLess(time.monotonic() - began, .4)
            self.assertTrue(result["manual_required"])
        self.assertTrue(client.discover(timeout=.05, targets=[])["manual_required"])

    def test_udp_icmp_reset_does_not_abort_other_responses(self):
        original_socket = socket.socket
        class ResetOnce:
            def __init__(self, *args, **kwargs):
                self.actual = original_socket(*args, **kwargs)
                self.reset = False
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.actual.close()
            def __getattr__(self, name):
                return getattr(self.actual, name)
            def recvfrom(self, *args):
                if not self.reset:
                    self.reset = True
                    raise ConnectionResetError(10054, "synthetic UDP ICMP reset")
                return self.actual.recvfrom(*args)
        with health_server() as (http_port, _), advertisements(lambda request: [reply(request, http_port)]) as udp_port:
            with patch.object(client.socket, "socket", side_effect=ResetOnce):
                result = client.discover(timeout=.5, port=udp_port, targets=["127.0.0.1"])
        self.assertFalse(result["manual_required"])
        self.assertEqual(len(result["candidates"]), 1)

    def test_udp_conflict_and_disable_do_not_raise(self):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as occupied:
            occupied.bind(("127.0.0.1", 0))
            self.assertIsNone(responder.start_discovery("127.0.0.1", 8765, False, port=occupied.getsockname()[1]))
        with patch.dict(os.environ, {"AGENTHUB_DISCOVERY": "0"}):
            self.assertIsNone(responder.start_discovery("127.0.0.1", 8765, False, port=0))

    def test_invalid_arguments_fail_closed(self):
        for kwargs in ({"timeout": True}, {"timeout": float("inf")}, {"timeout": 0}, {"port": True}, {"port": 0}):
            result = client.discover(**kwargs)
            self.assertEqual(result["candidates"], [])
            self.assertTrue(result["manual_required"])
            self.assertTrue(result["errors"])

    def test_real_hub_start_health_authenticated_ping_notification_and_cleanup(self):
        http_servers, udp_servers = [], []
        original_http, original_udp = hub.HubHTTPServer, responder.start_discovery
        ready = threading.Event()
        def http_factory(*args):
            server = original_http(*args)
            http_servers.append(server)
            return server
        def udp_factory(host, port, auth):
            value = original_udp(host, port, auth, port=0)
            udp_servers.append(value)
            ready.set()
            return value
        fake_manager = types.SimpleNamespace(MANAGER=types.SimpleNamespace(close=lambda: None))
        with patch.object(hub, "HubHTTPServer", side_effect=http_factory), patch.object(responder, "start_discovery", side_effect=udp_factory), patch.object(hub, "HUB_TOKEN", "SYNTHETIC_LOCAL_TEST_TOKEN"), patch.dict(sys.modules, {"login_manager": fake_manager}), patch.dict(os.environ, {"AGENTHUB_DISCOVERY": "1"}):
            thread = threading.Thread(target=hub.run_http, args=(0, "127.0.0.1"), daemon=True)
            thread.start()
            try:
                self.assertTrue(ready.wait(1))
                port = http_servers[0].server_address[1]
                result = client.discover(timeout=.5, port=udp_servers[0].address[1], targets=["127.0.0.1"])
                self.assertEqual(result["candidates"][0]["url"], f"http://127.0.0.1:{port}/mcp")
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                connection.request("GET", "/health")
                health = json.loads(connection.getresponse().read())
                self.assertEqual(health["version"], "1.0.0")
                self.assertTrue(health["auth_required"])
                for request, expected_status in (({"jsonrpc": "2.0", "id": 7, "method": "ping"}, 200), ({"jsonrpc": "2.0", "method": "ping"}, 202)):
                    connection.request("POST", "/mcp", json.dumps(request), {"Authorization": "Bearer SYNTHETIC_LOCAL_TEST_TOKEN", "Content-Type": "application/json"})
                    response = connection.getresponse()
                    self.assertEqual(response.status, expected_status)
                    body = response.read()
                    self.assertEqual(json.loads(body) if body else None, {"jsonrpc": "2.0", "id": 7, "result": {}} if expected_status == 200 else None)
                connection.close()
            finally:
                if http_servers:
                    http_servers[0].shutdown()
                thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertFalse(udp_servers[0].thread.is_alive())


if __name__ == "__main__":
    unittest.main(verbosity=2)
