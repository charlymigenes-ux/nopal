"""Descubrir, escanear la LAN y probar puertos son de admin.

Son el paso previo a dar de alta una máquina (que ya era admin): un operador
no tiene por qué barrer la red ni abrir puertos serie, y probar un puerto
puede interferir con una máquina trabajando. El 403 llega antes del handler,
así que ningún test abre red ni puertos.
"""

import pytest

ROUTES = [
    ("post", "/api/bambu/printers/discover", None),
    ("post", "/api/elegoo/printers/discover", None),
    ("post", "/api/flashforge/printers/discover", None),
    ("get", "/api/laser/scan", None),
    ("get", "/api/laser/scan-ip?ip=192.168.0.61", None),
    ("post", "/api/laser/usb-ports/test", {"port": "/dev/ttyUSB0"}),
    ("get", "/api/marlin-printers/discover", None),
    ("get", "/api/marlin-printers/mks-wifi/discover", None),
    ("post", "/api/marlin-printers/mks-wifi/test", {"host": "192.168.0.50"}),
    ("post", "/api/marlin-printers/usb-ports/test", {"port": "/dev/ttyUSB0"}),
]
IDS = [f"{m.upper()} {u}" for m, u, _ in ROUTES]


def _call(client, method, url, data):
    return client.get(url) if method == "get" else client.post(url, data=data or {})


@pytest.mark.parametrize("method, url, data", ROUTES, ids=IDS)
def test_operator_is_forbidden(client, as_operator, method, url, data):
    assert _call(client, method, url, data).status_code == 403


@pytest.mark.parametrize("method, url, data", ROUTES, ids=IDS)
def test_anonymous_is_unauthorized(client, method, url, data):
    assert _call(client, method, url, data).status_code == 401


def test_usb_port_list_stays_readable_for_operator(client, as_operator, monkeypatch):
    """Listar puertos es solo lectura: sigue abierto para el operador."""
    import backend.api.laser as laser_api

    monkeypatch.setattr(laser_api, "list_usb_laser_ports", lambda: [])
    response = client.get("/api/laser/usb-ports")
    assert response.status_code == 200 and response.json() == {"ports": []}
