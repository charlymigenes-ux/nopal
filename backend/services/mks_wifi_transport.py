"""Transporte de red para los módulos Makerbase MKS WiFi.

El firmware oficial expone dos contratos LAN: descubrimiento UDP en 8989
(`mkswifi:<module_id>,<ip>`) y un puente de G-code por TCP en 8080.  Este
módulo se limita a esos contratos públicos; la subida rápida propietaria a
la SD queda fuera hasta poder validarla con una placa real.
"""

import ipaddress
import socket
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlsplit


DEFAULT_TCP_PORT = 8080
DISCOVERY_PORT = 8989
DISCOVERY_QUERY = b"mkswifi"


def make_endpoint(host: str, port: int = DEFAULT_TCP_PORT) -> str:
    host = host.strip()
    if not host or any(char in host for char in "/?#@") or any(char.isspace() for char in host):
        raise ValueError("Host MKS WiFi inválido")
    if not 1 <= int(port) <= 65535:
        raise ValueError("Puerto MKS WiFi inválido")
    # Los corchetes hacen que IPv6 siga siendo parseable, sin cambiar la
    # representación habitual de IPv4/nombres DNS.
    rendered_host = f"[{host}]" if ":" in host and not host.startswith("[") else host
    return f"tcp://{rendered_host}:{int(port)}"


def parse_endpoint(endpoint: str) -> Tuple[str, int]:
    parsed = urlsplit(endpoint)
    if parsed.scheme != "tcp" or not parsed.hostname or parsed.path not in ("", "/"):
        raise ValueError("Endpoint MKS WiFi inválido; se esperaba tcp://host:puerto")
    try:
        port = parsed.port or DEFAULT_TCP_PORT
    except ValueError as exc:
        raise ValueError("Puerto MKS WiFi inválido") from exc
    if not 1 <= port <= 65535 or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Endpoint MKS WiFi inválido")
    return parsed.hostname, port


def parse_discovery_reply(payload: bytes, sender_ip: str = "") -> Optional[Dict[str, Any]]:
    text = payload.decode("utf-8", errors="ignore").strip("\x00\r\n ")
    if not text.lower().startswith("mkswifi:"):
        return None
    body = text[len("mkswifi:"):]
    if "," not in body:
        return None
    module_id, reported_ip = (part.strip() for part in body.split(",", 1))
    try:
        ipaddress.ip_address(reported_ip)
    except ValueError:
        return None
    if not module_id:
        return None
    return {
        "module_id": module_id,
        "ip": reported_ip,
        "sender_ip": sender_ip or reported_ip,
        "port": DEFAULT_TCP_PORT,
        "device": make_endpoint(reported_ip),
        "transport": "mks_wifi",
    }


def discover_mks_wifi(
    timeout: float = 1.0,
    broadcast_addresses: Iterable[str] = ("255.255.255.255",),
) -> List[Dict[str, Any]]:
    """Busca módulos MKS en la LAN y deduplica respuestas por id/IP."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.settimeout(min(max(timeout, 0.05), 5.0))
    try:
        for address in broadcast_addresses:
            try:
                sock.sendto(DISCOVERY_QUERY, (address, DISCOVERY_PORT))
            except OSError:
                continue
        deadline = time.monotonic() + timeout
        found: Dict[Tuple[str, str], Dict[str, Any]] = {}
        while time.monotonic() < deadline:
            sock.settimeout(max(0.01, deadline - time.monotonic()))
            try:
                payload, sender = sock.recvfrom(512)
            except socket.timeout:
                break
            item = parse_discovery_reply(payload, sender[0])
            if item:
                found[(item["module_id"], item["ip"])] = item
        return sorted(found.values(), key=lambda item: (item["ip"], item["module_id"]))
    finally:
        sock.close()


class TcpLineConnection:
    """Adaptador mínimo con la misma interfaz usada del objeto Serial."""

    def __init__(self, endpoint: str, timeout: float = 0.5):
        host, port = parse_endpoint(endpoint)
        self.socket = socket.create_connection((host, port), timeout=timeout)
        self.socket.settimeout(timeout)
        self._buffer = bytearray()
        self.closed = False

    def readline(self) -> bytes:
        while True:
            newline = self._buffer.find(b"\n")
            if newline >= 0:
                line = bytes(self._buffer[:newline + 1])
                del self._buffer[:newline + 1]
                return line
            try:
                chunk = self.socket.recv(4096)
            except socket.timeout:
                return b""
            if not chunk:
                self.closed = True
                if self._buffer:
                    line = bytes(self._buffer)
                    self._buffer.clear()
                    return line
                return b""
            self._buffer.extend(chunk)

    def write(self, data: bytes) -> int:
        self.socket.sendall(data)
        return len(data)

    def close(self) -> None:
        self.socket.close()


def query_lines(endpoint: str, command: str, timeout: float = 3.0) -> List[str]:
    """Ejecuta un probe autocontenido sin dejar conexiones abiertas."""
    connection = TcpLineConnection(endpoint, timeout=min(timeout, 0.5))
    lines: List[str] = []
    idle_deadline: Optional[float] = None
    try:
        connection.write((command.rstrip("\r\n") + "\n").encode("utf-8"))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            raw = connection.readline()
            if not raw:
                if connection.closed or (idle_deadline is not None and time.monotonic() >= idle_deadline):
                    break
                continue
            text = raw.decode("utf-8", errors="ignore").strip()
            if text:
                lines.append(text)
                idle_deadline = time.monotonic() + 0.2
        return lines
    finally:
        connection.close()


def is_reachable(endpoint: str, timeout: float = 0.25) -> bool:
    try:
        connection = TcpLineConnection(endpoint, timeout=timeout)
    except (OSError, ValueError):
        return False
    connection.close()
    return True
