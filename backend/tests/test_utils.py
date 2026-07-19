import pytest
from fastapi import HTTPException

from backend.utils import sanitize_device_name, validate_printer_ip


class TestValidatePrinterIp:
    @pytest.mark.parametrize("value", [
        "192.168.1.42",
        "10.0.0.1",
        "::1",
        "fe80::1",
        "bambu-a1.local",
        "printer1",
        "my-printer-2",
    ])
    def test_accepts_valid_ip_or_hostname(self, value):
        assert validate_printer_ip(value) == value

    @pytest.mark.parametrize("value", [
        "",
        "   ",
        "999.999.999.999",
        "192.168.1.42; rm -rf /",
        "../../etc/passwd",
        "http://192.168.1.42",
        "192 168 1 42",
        "-leading-dash",
        "a" * 300,
        "192.168.1.42\ninjected",
        "printer\x00name",
    ])
    def test_rejects_invalid_values(self, value):
        with pytest.raises(HTTPException) as exc_info:
            validate_printer_ip(value)
        assert exc_info.value.status_code == 400


class TestSanitizeDeviceName:
    def test_accepts_normal_name(self):
        assert sanitize_device_name("Impresora Taller") == "Impresora Taller"

    def test_strips_surrounding_whitespace(self):
        assert sanitize_device_name("  P2S Taller  ") == "P2S Taller"

    def test_accepts_unicode(self):
        assert sanitize_device_name("Impresora Ñoño 3D") == "Impresora Ñoño 3D"

    def test_rejects_empty(self):
        with pytest.raises(HTTPException) as exc_info:
            sanitize_device_name("")
        assert exc_info.value.status_code == 400

    def test_rejects_only_whitespace(self):
        with pytest.raises(HTTPException):
            sanitize_device_name("   ")

    @pytest.mark.parametrize("value", [
        "printer\x00name",
        "printer\nname",
        "printer\tname",
        "printer\x1bname",
    ])
    def test_rejects_control_characters(self, value):
        with pytest.raises(HTTPException) as exc_info:
            sanitize_device_name(value)
        assert exc_info.value.status_code == 400

    def test_rejects_too_long(self):
        with pytest.raises(HTTPException) as exc_info:
            sanitize_device_name("x" * 200)
        assert exc_info.value.status_code == 400

    def test_does_not_execute_or_transform_script_tags(self):
        # No se espera que sanitize_device_name escape HTML (eso lo hace
        # escapeHtml() en el frontend al renderizar) -- solo que no lo
        # rechace ni lo corrompa de forma insegura como string plano.
        value = "<script>alert(1)</script>"
        assert sanitize_device_name(value) == value
