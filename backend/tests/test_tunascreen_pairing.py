"""Emparejamiento de TUNA-Screen endurecido (D3-Q6): código temporal, de un
solo uso, con vencimiento, límite de intentos, invalidado tras el canje y no
reutilizable. El reloj se controla con un módulo `time` falso (sin esperas
reales)."""

import logging
import threading

import pytest

import backend.services.tunascreen_service as tunascreen_service

GENERIC_ERROR = "Código inválido o vencido"
LIMIT = tunascreen_service.PAIRING_MAX_FAILED_ATTEMPTS


class FakeClock:
    def __init__(self):
        self.now = 1_000.0

    def monotonic(self):
        return self.now

    def time(self):
        return 1_700_000_000.0 + self.now

    def advance(self, seconds):
        self.now += seconds


@pytest.fixture(autouse=True)
def clean_pairing_state(monkeypatch):
    """Estado de emparejamiento limpio en cada test (es global del proceso)."""
    monkeypatch.setattr(tunascreen_service, "_pending_codes", {})
    monkeypatch.setattr(tunascreen_service, "_pairing_failed_attempts", 0)


@pytest.fixture
def clock(monkeypatch):
    fake = FakeClock()
    monkeypatch.setattr(tunascreen_service, "time", fake)
    return fake


def _devices():
    return tunascreen_service.list_paired_devices()


def _wrong_code(code):
    return f"{(int(code) + 1) % 1_000_000:06d}"


class TestPairingRules:
    def test_valid_code_returns_token_and_registers_device(self, clock):
        code = tunascreen_service.generate_pairing_code()["code"]

        result = tunascreen_service.confirm_pairing(code, "Tablet")

        assert set(result) == {"device_id", "token"}
        assert tunascreen_service.resolve_device(result["token"])["device_id"] == result["device_id"]
        assert len(_devices()) == 1
        assert code not in tunascreen_service._pending_codes

    def test_expired_code_denied_invalidated_and_no_token(self, clock):
        code = tunascreen_service.generate_pairing_code()["code"]
        clock.advance(tunascreen_service.PAIRING_CODE_TTL_SECONDS + 1)

        with pytest.raises(ValueError, match=GENERIC_ERROR):
            tunascreen_service.confirm_pairing(code, "Tablet")

        assert _devices() == []
        assert code not in tunascreen_service._pending_codes

    def test_code_still_valid_just_before_expiry(self, clock):
        code = tunascreen_service.generate_pairing_code()["code"]
        clock.advance(tunascreen_service.PAIRING_CODE_TTL_SECONDS - 1)

        assert tunascreen_service.confirm_pairing(code, "Tablet")["token"]

    def test_wrong_code_denied(self, clock):
        code = tunascreen_service.generate_pairing_code()["code"]

        with pytest.raises(ValueError, match=GENERIC_ERROR):
            tunascreen_service.confirm_pairing(_wrong_code(code), "Tablet")
        assert _devices() == []

    def test_code_cannot_be_reused(self, clock):
        code = tunascreen_service.generate_pairing_code()["code"]
        tunascreen_service.confirm_pairing(code, "Tablet 1")

        with pytest.raises(ValueError, match=GENERIC_ERROR):
            tunascreen_service.confirm_pairing(code, "Tablet 2")
        assert len(_devices()) == 1

    def test_attempt_limit_invalidates_code(self, clock):
        code = tunascreen_service.generate_pairing_code()["code"]
        for _ in range(LIMIT):
            with pytest.raises(ValueError, match=GENERIC_ERROR):
                tunascreen_service.confirm_pairing(_wrong_code(code), "Atacante")

        assert tunascreen_service._pending_codes == {}
        with pytest.raises(ValueError, match=GENERIC_ERROR):
            tunascreen_service.confirm_pairing(code, "Tablet")  # incluso el correcto
        assert _devices() == []

    def test_below_limit_the_correct_code_still_works(self, clock):
        code = tunascreen_service.generate_pairing_code()["code"]
        for _ in range(LIMIT - 1):
            with pytest.raises(ValueError):
                tunascreen_service.confirm_pairing(_wrong_code(code), "Atacante")

        assert tunascreen_service.confirm_pairing(code, "Tablet")["token"]

    def test_errors_do_not_reveal_remaining_attempts(self, clock):
        code = tunascreen_service.generate_pairing_code()["code"]
        messages = set()
        for _ in range(LIMIT + 2):
            with pytest.raises(ValueError) as excinfo:
                tunascreen_service.confirm_pairing(_wrong_code(code), "Atacante")
            messages.add(str(excinfo.value))
        assert messages == {GENERIC_ERROR}

    def test_new_code_opens_a_new_window(self, clock):
        first = tunascreen_service.generate_pairing_code()["code"]
        for _ in range(LIMIT - 1):
            with pytest.raises(ValueError):
                tunascreen_service.confirm_pairing(_wrong_code(first), "Atacante")

        second = tunascreen_service.generate_pairing_code()["code"]
        for _ in range(LIMIT - 1):
            with pytest.raises(ValueError):
                tunascreen_service.confirm_pairing(f"{(int(second) + 7) % 1_000_000:06d}", "Atacante")
        assert tunascreen_service.confirm_pairing(second, "Tablet")["token"]


class TestExpiryAndAttemptsAreIndependent:
    def test_expiry_denies_with_zero_failed_attempts(self, clock):
        code = tunascreen_service.generate_pairing_code()["code"]
        clock.advance(tunascreen_service.PAIRING_CODE_TTL_SECONDS + 5)

        with pytest.raises(ValueError):
            tunascreen_service.confirm_pairing(code, "Tablet")

    def test_attempt_limit_denies_before_expiry(self, clock):
        code = tunascreen_service.generate_pairing_code()["code"]
        clock.advance(10)  # lejos de vencer
        for _ in range(LIMIT):
            with pytest.raises(ValueError):
                tunascreen_service.confirm_pairing(_wrong_code(code), "Atacante")

        with pytest.raises(ValueError):
            tunascreen_service.confirm_pairing(code, "Tablet")


class TestConcurrency:
    def test_same_code_redeemed_concurrently_only_once(self, clock):
        code = tunascreen_service.generate_pairing_code()["code"]
        barrier = threading.Barrier(8)
        results, errors = [], []

        def redeem(i):
            barrier.wait()
            try:
                results.append(tunascreen_service.confirm_pairing(code, f"Tablet {i}"))
            except ValueError:
                errors.append(i)

        threads = [threading.Thread(target=redeem, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(results) == 1
        assert len(errors) == 7
        assert len(_devices()) == 1
        assert tunascreen_service.resolve_device(results[0]["token"]) is not None


class TestEndpointsAndCompatibility:
    def test_info_does_not_reveal_open_pairing(self, client, as_admin):
        client.post("/api/tunascreen/pair/start")

        info = client.get("/api/tunascreen/info").json()

        assert "pairing_open" not in info
        assert {"name", "server_version", "api_version", "websocket_path"} <= set(info)

    def test_confirm_endpoint_success_shape_unchanged(self, client):
        code = tunascreen_service.generate_pairing_code()["code"]

        response = client.post("/api/tunascreen/pair/confirm", json={"code": code, "device_name": "Tablet"})

        assert response.status_code == 200
        assert set(response.json()) == {"device_id", "token"}

    def test_confirm_endpoint_reuse_and_lockout_are_generic_400(self, client):
        code = tunascreen_service.generate_pairing_code()["code"]
        assert client.post("/api/tunascreen/pair/confirm", json={"code": code}).status_code == 200

        reused = client.post("/api/tunascreen/pair/confirm", json={"code": code})
        assert reused.status_code == 400 and reused.json() == {"detail": GENERIC_ERROR}

    def test_existing_device_token_survives_lockout(self, clock):
        code = tunascreen_service.generate_pairing_code()["code"]
        token = tunascreen_service.confirm_pairing(code, "Tablet")["token"]

        tunascreen_service.generate_pairing_code()
        for _ in range(LIMIT):
            with pytest.raises(ValueError):
                tunascreen_service.confirm_pairing("000000" if code != "000000" else "111111", "Atacante")

        assert tunascreen_service.resolve_device(token) is not None

    def test_logs_never_contain_code_or_token(self, clock, caplog):
        caplog.set_level(logging.DEBUG)
        code = tunascreen_service.generate_pairing_code()["code"]
        token = tunascreen_service.confirm_pairing(code, "Tablet")["token"]
        second = tunascreen_service.generate_pairing_code()["code"]
        for _ in range(LIMIT):
            with pytest.raises(ValueError):
                tunascreen_service.confirm_pairing(_wrong_code(second), "Atacante")

        text = caplog.text
        assert code not in text and second not in text and token not in text
        assert "códigos invalidados" in text
