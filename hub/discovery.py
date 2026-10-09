"""Small, unauthenticated endpoint advertisements; never advertise secrets."""
import ipaddress
import json
import os
import re
import socket
import sys
import threading
import time

DISCOVERY_PORT = 18766
SERVICE = "agenthub-discovery"
VERSION = 1
MAX_DATAGRAM = 1024
_NONCE = re.compile(r"[0-9a-fA-F]{32}\Z")


def _name(value):
    return re.sub(r"[^A-Za-z0-9_.-]", "", str(value).split(".", 1)[0])[:63] or "Hub"


class DiscoveryResponder:
    def __init__(self, http_host, http_port, auth_required, *, port=DISCOVERY_PORT, name=None):
        if isinstance(http_port, bool) or not 1 <= int(http_port) <= 65535:
            raise ValueError("Invalid HTTP port")
        address = socket.gethostbyname(http_host)
        self.loopback = ipaddress.IPv4Address(address).is_loopback
        self.http_port = int(http_port)
        self.auth_required = bool(auth_required)
        self.name = _name(name or socket.gethostname())
        self._stop = threading.Event()
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            if os.name == "nt":
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            self.socket.bind((address, port))
            self.socket.settimeout(.1)
        except Exception:
            self.socket.close()
            raise
        self.address = self.socket.getsockname()
        self.thread = threading.Thread(target=self._serve, name="agenthub-discovery", daemon=True)
        self.thread.start()

    def _reply(self, packet):
        if len(packet) > MAX_DATAGRAM:
            return None
        try:
            request = json.loads(packet.decode("utf-8"))
        except (ValueError, UnicodeError):
            return None
        if (not isinstance(request, dict) or request.get("service") != SERVICE
                or type(request.get("version")) is not int or request["version"] != VERSION
                or not isinstance(request.get("nonce"), str) or not _NONCE.fullmatch(request["nonce"])):
            return None
        return json.dumps({"service": SERVICE, "version": VERSION, "nonce": request["nonce"],
            "port": self.http_port, "path": "/mcp", "name": self.name,
            "auth_required": self.auth_required}, separators=(",", ":")).encode("utf-8")

    def _serve(self):
        window, count = time.monotonic(), 0
        while not self._stop.is_set():
            try:
                packet, source = self.socket.recvfrom(MAX_DATAGRAM + 1)
            except socket.timeout:
                continue
            except OSError:
                break
            now = time.monotonic()
            if now - window >= 1:
                window, count = now, 0
            count += 1
            if count > 64:
                self._stop.wait(.01)
                continue
            if self.loopback and not ipaddress.IPv4Address(source[0]).is_loopback:
                continue
            reply = self._reply(packet)
            if reply is not None:
                try:
                    self.socket.sendto(reply, source)
                except OSError:
                    pass

    def close(self):
        self._stop.set()
        self.socket.close()
        if threading.current_thread() is not self.thread:
            self.thread.join(timeout=1)


def start_discovery(http_host, http_port, auth_required, *, port=DISCOVERY_PORT, name=None):
    """UDP failure is optional and must never prevent the HTTP service starting."""
    if os.environ.get("AGENTHUB_DISCOVERY", "1").strip().lower() in {"0", "false", "off"}:
        return None
    try:
        return DiscoveryResponder(http_host, http_port, auth_required, port=port, name=name)
    except (OSError, ValueError):
        sys.stderr.write("[agent-hub.discovery] UDP discovery unavailable; HTTP remains enabled.\n")
        return None
