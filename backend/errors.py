from fastapi import HTTPException

# Códigos alcanzables de forma confiable con sockets/HTTP puro al validar una
# impresora de red -- deliberadamente no hay categorías más finas tipo
# "puerto bloqueado" vs "dispositivo apagado": ambas producen el mismo
# timeout/OSError a nivel de socket y no se pueden distinguir sin inventar
# una señal que el protocolo no da. El frontend redacta el mensaje según el
# código, no al revés.
PRINTER_ERROR_CODES = (
    "IP_INVALID",
    "CREDENTIAL_REJECTED",
    "SERVICE_REFUSED",
    "CONNECTION_FAILED",
    "PROTOCOL_INVALID",
    "UNKNOWN",
)


class PrinterRegistrationError(HTTPException):
    """HTTPException(400) con un `error_code` estructurado además del
    `detail` humano -- `detail` sigue siendo string puro a propósito (las
    modales de registro ya existentes en app.js hacen
    `new Error(data.detail || ...)`, y no deben romperse); `error_code` es
    un campo hermano nuevo que solo lee el asistente guiado."""

    def __init__(self, error_code: str, message: str):
        if error_code not in PRINTER_ERROR_CODES:
            error_code = "UNKNOWN"
        self.error_code = error_code
        super().__init__(status_code=400, detail=message)
