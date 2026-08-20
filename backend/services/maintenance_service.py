"""Sugerencia de mantenimiento del taller, generada por NOPAL Intelligence.

NOPAL no guarda horas de uso ni un historial real de fallas por máquina
todavía -- así que esto NO es un diagnóstico basado en telemetría de
mantenimiento (eso no existe). Lo que hace es juntar las señales reales
que el dashboard ya tiene (alertas activas, trabajos en curso, cuántos
dispositivos están conectados) y pedirle a la IA configurada que diga, en
una frase, si alguna máquina es candidata a revisión -- con instrucciones
explícitas de no inventar datos que no están en el resumen.

Depende por completo de que NOPAL Intelligence esté activada
(ai_config_service.get_config()["enabled"]) -- con la IA apagada, esta
ficha del dashboard directamente no tiene nada que mostrar (ver
dashboard_service.py, que la deja en None en ese caso).

Cacheado en memoria por MAINTENANCE_CACHE_TTL_SECONDS: se llama en cada
`/api/dashboard/summary` (que el panel sondea cada pocos segundos), y no
tiene sentido gastar una llamada a la IA esa seguido. El refresco corre en
segundo plano (asyncio.create_task) para no demorar la respuesta del
resumen mientras se espera al modelo -- el summary siempre devuelve el
último valor cacheado (o None si todavía no se calculó ninguno).
"""

import asyncio
import logging
import time
from typing import Any, Dict, List, Optional

from backend.services import ai_config_service
from backend.services.ai_provider import AIProviderError, get_provider

logger = logging.getLogger(__name__)

MAINTENANCE_CACHE_TTL_SECONDS = 6 * 3600

_cache: Dict[str, Any] = {"result": None, "computed_at": None}
_refresh_in_progress = False

_NO_SIGNAL_ANSWER = "sin datos suficientes"


def _build_summary_text(alert_items: List[Dict[str, Any]], jobs: List[Dict[str, Any]], devices_online: int, devices_total: int) -> str:
    if alert_items:
        alerts_text = "\n".join(
            f"- [{item.get('severity', 'info')}] {item.get('message', '')}"
            for item in alert_items
        )
    else:
        alerts_text = "Sin alertas activas."

    if jobs:
        jobs_text = "\n".join(
            f"- {job.get('name', '—')} ({job.get('machine_type', '—')}): {job.get('state', '—')}"
            for job in jobs
        )
    else:
        jobs_text = "Ningún trabajo activo."

    return (
        f"Alertas activas en el taller:\n{alerts_text}\n\n"
        f"Trabajos en curso:\n{jobs_text}\n\n"
        f"Dispositivos conectados: {devices_online} de {devices_total}."
    )


async def _ask_ai_for_candidate(alert_items: List[Dict[str, Any]], jobs: List[Dict[str, Any]], devices_online: int, devices_total: int) -> Optional[str]:
    config = ai_config_service.get_config()
    summary_text = _build_summary_text(alert_items, jobs, devices_online, devices_total)
    messages = [
        {
            "role": "system",
            "content": (
                "Sos un asistente de un taller de fabricación digital (impresoras 3D, "
                "láser/CNC). Tu única tarea es decidir, con los datos reales que te "
                "pasan a continuación, si alguna máquina es candidata a mantenimiento. "
                "NUNCA inventes horas de uso, fechas de mantenimiento ni fallas que no "
                "estén en los datos. Si no hay señal suficiente para una recomendación "
                "real, respondé exactamente: 'Sin datos suficientes.'"
            ),
        },
        {
            "role": "user",
            "content": (
                f"{summary_text}\n\n¿Hay alguna máquina candidata a mantenimiento? "
                "Respondé en UNA sola oración en español, nombrando la máquina y el "
                "motivo concreto (basado solo en los datos de arriba)."
            ),
        },
    ]

    provider = get_provider(config)
    response = await provider.chat(messages)
    text = (response.get("content") or "").strip()

    if not text or text.strip(".").lower() == _NO_SIGNAL_ANSWER:
        return None

    # Tope defensivo: la ficha del dashboard es chica, y el prompt le pide
    # una sola oración pero no todos los modelos la respetan al pie de la
    # letra.
    return text if len(text) <= 240 else text[:237] + "…"


async def _refresh_cache(alert_items: List[Dict[str, Any]], jobs: List[Dict[str, Any]], devices_online: int, devices_total: int) -> None:
    global _refresh_in_progress
    try:
        result = await _ask_ai_for_candidate(alert_items, jobs, devices_online, devices_total)
        _cache["result"] = result
        _cache["computed_at"] = time.monotonic()
    except AIProviderError as exc:
        logger.info(f"[mantenimiento] la IA no respondió, se conserva la sugerencia anterior: {exc}")
    except Exception:
        logger.exception("[mantenimiento] fallo inesperado calculando la sugerencia de la IA")
    finally:
        _refresh_in_progress = False


async def maybe_refresh(alert_items: List[Dict[str, Any]], jobs: List[Dict[str, Any]], devices_online: int, devices_total: int) -> None:
    """Dispara un recálculo en segundo plano si la IA está activada y el
    caché ya venció -- no espera el resultado, get_dashboard_summary()
    sigue usando el valor cacheado (viejo o None) de esta misma vuelta."""
    global _refresh_in_progress

    if not ai_config_service.get_config().get("enabled"):
        return
    if _refresh_in_progress:
        return
    # computed_at es None hasta el primer cálculo real -- comparar
    # directo contra time.monotonic() (que NO arranca en 0, arranca desde
    # que bootea el sistema/arranca el intérprete) haría que un caché
    # "nunca calculado" pareciera más fresco que el TTL en cualquier
    # máquina con horas de uptime.
    if _cache["computed_at"] is not None and time.monotonic() - _cache["computed_at"] < MAINTENANCE_CACHE_TTL_SECONDS:
        return

    _refresh_in_progress = True
    asyncio.create_task(_refresh_cache(alert_items, jobs, devices_online, devices_total))


def get_cached_suggestion() -> Optional[str]:
    if not ai_config_service.get_config().get("enabled"):
        return None
    return _cache["result"]
