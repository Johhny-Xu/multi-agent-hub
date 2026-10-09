"""Bounded endpoint discovery. Advertisements never supply URLs or credentials."""
import http.client
import ipaddress
import json
import math
import re
import secrets
import socket
import threading
import time
from urllib.parse import urlsplit

DISCOVERY_PORT = 18766
SERVICE = "agenthub-discovery"
MAX_DATAGRAM = 1024
MAX_PACKETS = 64
MAX_CANDIDATES = 16
MAX_HEALTH_BODY = 4096


def _name(value):
    return re.sub(r"[^A-Za-z0-9_.-]", "", str(value).split(".", 1)[0])[:63] or "Hub"


def _configured_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        return None
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.fragment or parsed.path.rstrip("/") not in {"", "/mcp"}):
            return None
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        host = parsed.hostname
        if not 1 <= port <= 65535 or any(character in host for character in "\r\n\t "):
            return None
        authority = "[" + host + "]" if ":" in host else host
        default = 443 if parsed.scheme == "https" else 80
        return parsed.scheme + "://" + authority + (":" + str(port) if port != default else "") + "/mcp"
    except (ValueError, UnicodeError):
        return None


def _health(url, deadline):
    """One direct GET: no proxy, credential headers, query token, or redirects."""
    budget = min(.35, deadline - time.monotonic())
    if budget <= 0:
        return None
    parsed = urlsplit(url)
    connection_type = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    connection = connection_type(parsed.hostname, parsed.port, timeout=budget)
    finished = threading.Event()
    answer = []

    def request():
        try:
            connection.request("GET", "/health", headers={"Accept": "application/json", "Connection": "close"})
            response = connection.getresponse()
            if response.status != 200:
                return
            data = response.read(MAX_HEALTH_BODY + 1)
            if len(data) > MAX_HEALTH_BODY:
                return
            health = json.loads(data.decode("utf-8"))
            if isinstance(health, dict) and health.get("service") == "agent-hub" and health.get("status") == "ok":
                answer.append(health.get("auth_required") if isinstance(health.get("auth_required"), bool) else True)
        except (OSError, ValueError, UnicodeError, http.client.HTTPException):
            pass
        finally:
            connection.close()
            finished.set()

    thread = threading.Thread(target=request, name="agenthub-discovery-health", daemon=True)
    thread.start()
    if not finished.wait(budget):
        # Interrupt only this probe's socket. DNS resolution, when explicitly
        # configured with a hostname, can finish later in the daemon thread.
        if connection.sock is not None:
            try:
                connection.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        connection.close()
    thread.join(timeout=0)
    return {"auth_required": answer[0]} if answer else None


def discover(timeout=1.5, port=DISCOVERY_PORT, targets=None, known_urls=None):
    result = {"candidates": [], "errors": [], "manual_required": True}
    def error(code):
        if code not in result["errors"]:
            result["errors"].append(code)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 < timeout <= 10:
        error("invalid_timeout")
        return result
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        error("invalid_port")
        return result
    deadline = time.monotonic() + timeout
    pending = {}
    for value in list(known_urls or [])[:MAX_CANDIDATES]:
        url = _configured_url(value)
        if url:
            pending[url] = {"url": url, "name": _name(urlsplit(url).hostname), "source": "configured"}
        else:
            error("invalid_known_url")
    if targets is None:
        # A fixed loopback health probe also finds pre-discovery Hub releases.
        url = "http://127.0.0.1:8765/mcp"
        pending.setdefault(url, {"url": url, "name": "127", "source": "local"})
    nonce = secrets.token_hex(16)
    request = json.dumps({"service": SERVICE, "version": 1, "nonce": nonce}, separators=(",", ":")).encode()
    destinations = list(targets)[:MAX_CANDIDATES] if targets is not None else ["127.0.0.1", "255.255.255.255"]
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            probe.bind(("0.0.0.0", 0))
            for destination in destinations:
                try:
                    ipaddress.IPv4Address(destination)
                    probe.sendto(request, (destination, port))
                except (OSError, ValueError, TypeError):
                    error("discovery_send_failed")
            receive_until = min(deadline, time.monotonic() + min(.4, timeout / 2))
            received = 0
            while received < MAX_PACKETS and len(pending) < MAX_CANDIDATES:
                remaining = receive_until - time.monotonic()
                if remaining <= 0:
                    break
                probe.settimeout(remaining)
                try:
                    packet, source = probe.recvfrom(MAX_DATAGRAM + 1)
                except socket.timeout:
                    break
                except ConnectionResetError:
                    # Windows reports ICMP "port unreachable" for one UDP
                    # destination here. Other LAN replies remain discoverable.
                    continue
                received += 1
                if len(packet) > MAX_DATAGRAM:
                    continue
                try:
                    reply = json.loads(packet.decode("utf-8"))
                    address = ipaddress.IPv4Address(source[0])
                    if (not isinstance(reply, dict) or reply.get("service") != SERVICE
                            or type(reply.get("version")) is not int or reply["version"] != 1
                            or reply.get("nonce") != nonce or reply.get("path") != "/mcp"
                            or type(reply.get("port")) is not int or not 1 <= reply["port"] <= 65535
                            or address.is_multicast or address.is_unspecified or str(address) == "255.255.255.255"):
                        continue
                    url = "http://" + str(address) + ":" + str(reply["port"]) + "/mcp"
                    pending.setdefault(url, {"url": url, "name": _name(reply.get("name", "Hub")), "source": "udp"})
                except (ValueError, UnicodeError):
                    continue
    except OSError:
        error("discovery_unavailable")
    for candidate in pending.values():
        if time.monotonic() >= deadline:
            error("discovery_timeout")
            break
        verified = _health(candidate["url"], deadline)
        if verified is not None:
            result["candidates"].append(dict(candidate, **verified))
        else:
            error("health_validation_failed")
    result["manual_required"] = not result["candidates"]
    return result
