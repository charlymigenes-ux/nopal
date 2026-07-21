import socket
import threading

import pytest

from backend.services import marlin_printer_service, mks_wifi_transport


class FakeMksWifi:
    """Emulador mínimo del puente TCP 8080 usado por el firmware oficial."""

    def __init__(self):
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen()
        self.host, self.port = self.server.getsockname()
        self.commands = []
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self._serve, daemon=True)

    @property
    def endpoint(self):
        return mks_wifi_transport.make_endpoint(self.host, self.port)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stopped.set()
        self.server.close()
        self.thread.join(timeout=1)

    def _serve(self):
        while not self.stopped.is_set():
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            with client:
                command = client.recv(1024).decode("utf-8", errors="ignore").strip()
                self.commands.append(command)
                if command == "M105":
                    client.sendall(b"ok T0:205.0 /210.0 T1:198.0 /200.0 B:60.0 /60.0\r\n")
                elif command == "M115":
                    # El firmware MKS puede mandar ok antes de su línea de
                    # identificación; el probe debe conservar ambas.
                    client.sendall(b"ok\r\nFIRMWARE_NAME:Robin MACHINE_TYPE:Hellbot EXTRUDER_COUNT:2\r\n")


def test_endpoint_round_trip_and_validation():
    endpoint = mks_wifi_transport.make_endpoint("192.168.1.44", 8080)
    assert endpoint == "tcp://192.168.1.44:8080"
    assert mks_wifi_transport.parse_endpoint(endpoint) == ("192.168.1.44", 8080)
    with pytest.raises(ValueError):
        mks_wifi_transport.parse_endpoint("http://192.168.1.44:8080")
    with pytest.raises(ValueError):
        mks_wifi_transport.make_endpoint("bad/host", 8080)


def test_parses_official_udp_discovery_reply():
    item = mks_wifi_transport.parse_discovery_reply(
        b"mkswifi:ABCDEF123456,192.168.1.44\n", "192.168.1.44"
    )
    assert item == {
        "module_id": "ABCDEF123456",
        "ip": "192.168.1.44",
        "sender_ip": "192.168.1.44",
        "port": 8080,
        "device": "tcp://192.168.1.44:8080",
        "transport": "mks_wifi",
    }
    assert mks_wifi_transport.parse_discovery_reply(b"otro:mensaje") is None
    assert mks_wifi_transport.parse_discovery_reply(b"mkswifi:id,no-es-ip") is None


def test_tcp_emulator_supports_marlin_probe_and_m115():
    with FakeMksWifi() as emulator:
        assert marlin_printer_service._probe_marlin_sync(emulator.endpoint, timeout=0.15)
        info = marlin_printer_service._probe_marlin_firmware_info_sync(
            emulator.endpoint, 0, timeout=0.15
        )
    assert emulator.commands == ["M105", "M115"]
    assert info["FIRMWARE_NAME"] == "Robin"
    assert info["MACHINE_TYPE"] == "Hellbot"
    assert info["EXTRUDER_COUNT"] == "2"


def test_registers_mks_wifi_without_usb_location(monkeypatch, tmp_path):
    monkeypatch.setattr(
        marlin_printer_service, "REGISTRY_PATH", str(tmp_path / "marlin_registry.json")
    )
    monkeypatch.setattr(
        "backend.services.laser_service._location_for_device",
        lambda device: pytest.fail("No debe consultar ubicación USB para TCP"),
    )
    entry = marlin_printer_service.register_printer(
        "tcp://192.168.1.44:8080",
        "Hellbot WiFi",
        baud=0,
        verified_marlin=True,
        transport="mks_wifi",
    )
    assert entry["transport"] == "mks_wifi"
    assert entry["location"] is None
    assert entry["device"] == "tcp://192.168.1.44:8080"


def test_registry_status_uses_tcp_reachability(monkeypatch, tmp_path):
    monkeypatch.setattr(
        marlin_printer_service, "REGISTRY_PATH", str(tmp_path / "marlin_registry.json")
    )
    marlin_printer_service._save_registry([
        {"device": "tcp://192.168.1.44:8080", "transport": "mks_wifi"}
    ])
    monkeypatch.setattr(mks_wifi_transport, "is_reachable", lambda endpoint: True)
    assert marlin_printer_service.get_registered_printers_with_status()[0]["online"] is True
