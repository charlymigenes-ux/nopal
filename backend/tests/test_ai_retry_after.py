"""Lectura del "reintenta en N segundos" que manda el proveedor de IA.

Cuando se agota la cuota (429), el proveedor dice cuánto falta para poder
volver a preguntar. Ese dato alimenta el cronómetro de la interfaz, así que
lo que importa es que se extraiga del mismo modo sin importar dónde lo
ponga cada proveedor: cabecera estándar, cabeceras de rate limit, o el
propio texto del error.
"""

import time

import pytest

from backend.services.ai_provider import (
    MAX_RETRY_AFTER_SECONDS,
    AIProviderError,
    _parse_duration,
    _retry_after_seconds,
)


class RespuestaFalsa:
    """Lo mínimo que mira `_retry_after_seconds` de una respuesta httpx."""

    def __init__(self, headers=None, body=None):
        self.headers = headers or {}
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("sin cuerpo JSON")
        return self._body


@pytest.mark.parametrize(
    "texto, esperado",
    [
        ("5", 5.0),
        ("4.5225s", 4.5225),
        ("1m20s", 80.0),
        ("2m59.56s", 179.56),
        ("1h", 3600.0),
        ("300ms", 0.3),
        ("", None),
        ("mañana", None),
    ],
)
def test_parse_duration(texto, esperado):
    assert _parse_duration(texto) == esperado


def test_lee_retry_after_en_segundos():
    respuesta = RespuestaFalsa(headers={"Retry-After": "12"})
    assert _retry_after_seconds(respuesta) == 12


def test_lee_retry_after_como_fecha_http():
    """La otra forma válida de Retry-After es una fecha, no un número."""
    dentro_de_un_minuto = time.strftime(
        "%a, %d %b %Y %H:%M:%S GMT", time.gmtime(time.time() + 60)
    )
    segundos = _retry_after_seconds(RespuestaFalsa(headers={"Retry-After": dentro_de_un_minuto}))
    assert 50 <= segundos <= 61


def test_toma_la_cuota_que_mas_tarda_en_reponerse():
    """Reintentar cuando se liberó la cuota de tokens pero no la de
    peticiones da otro 429 de inmediato: gana la espera más larga."""
    respuesta = RespuestaFalsa(
        headers={
            "x-ratelimit-reset-tokens": "4.5s",
            "x-ratelimit-reset-requests": "1m10s",
        }
    )
    assert _retry_after_seconds(respuesta) == 70.0


def test_ultimo_recurso_el_texto_del_error():
    """Groq manda la espera real dentro del mensaje aunque las cabeceras
    traigan el reset de otra cuota. Es el caso que se vio en el taller."""
    detalle = (
        "Rate limit reached for model `openai/gpt-oss-120b` in organization "
        "`org_01k` service tier `on_demand` on tokens per minute (TPM): "
        "Limit 8000, Used 5951, Requested 2652. Please try again in 4.5225s."
    )
    assert _retry_after_seconds(RespuestaFalsa(), detalle) == 4.52


def test_sin_datos_no_se_inventa_una_espera():
    assert _retry_after_seconds(RespuestaFalsa(), "algo salió mal") is None


def test_espera_ya_vencida_se_descarta():
    """Un Retry-After de 0 (o una fecha pasada) no debe bloquear la interfaz
    con un cronómetro que arranca ya terminado."""
    assert _retry_after_seconds(RespuestaFalsa(headers={"Retry-After": "0"})) is None


def test_se_acota_una_espera_absurda():
    """Cuota diaria agotada: mostrar 24 h de cronómetro no ayuda a nadie y
    dejaría el botón de preguntar bloqueado el resto del día."""
    espera = _retry_after_seconds(RespuestaFalsa(headers={"Retry-After": "86400"}))
    assert espera == MAX_RETRY_AFTER_SECONDS


def test_el_endpoint_entrega_la_espera_junto_al_mensaje(client, as_admin, monkeypatch):
    """De punta a punta: lo que el proveedor dijo tiene que llegarle a la
    interfaz. `detail` sigue siendo el string de siempre (nada de lo que ya
    mostraba el chat cambia) y `retry_after` viaja al lado."""
    from backend.services import ai_agent

    async def falla(*args, **kwargs):
        raise AIProviderError("El servidor de IA respondió 429: sin cuota", retry_after=4.52)

    monkeypatch.setattr(ai_agent, "ask", falla)
    respuesta = client.post("/api/ai/ask", json={"question": "¿cómo está el taller?"})

    assert respuesta.status_code == 502
    assert respuesta.json() == {
        "detail": "El servidor de IA respondió 429: sin cuota",
        "retry_after": 4.52,
    }


def test_el_endpoint_no_inventa_espera_en_otras_fallas(client, as_admin, monkeypatch):
    """Una falla de red no debe encender el cronómetro: no hay nada que
    esperar, el usuario puede reintentar cuando quiera."""
    from backend.services import ai_agent

    async def falla(*args, **kwargs):
        raise AIProviderError("No se pudo contactar al servidor de IA")

    monkeypatch.setattr(ai_agent, "ask", falla)
    assert client.post("/api/ai/ask", json={"question": "hola"}).json()["retry_after"] is None


def test_el_error_carga_la_espera_y_sigue_siendo_texto():
    """El mensaje mostrable no cambia de forma: `retry_after` es un dato
    aparte, no algo que haya que sacar del string."""
    error = AIProviderError("El servidor de IA respondió 429: sin cuota", retry_after=4.52)
    assert str(error) == "El servidor de IA respondió 429: sin cuota"
    assert error.retry_after == 4.52
    assert AIProviderError("falla de red").retry_after is None
