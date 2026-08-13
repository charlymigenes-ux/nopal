#!/bin/bash
# Desinstalador de NOPAL. Espejo de install.sh: deshace exactamente lo que
# aquél creó (servicio systemd + entorno virtual) y nada más.
#
# Uso:
#   ./uninstall.sh              # quita el servicio y el entorno; CONSERVA tus datos
#   ./uninstall.sh --purgar     # además borra biblioteca, registros y credenciales
#   ./uninstall.sh --dry-run    # solo muestra qué haría, sin tocar nada
#   ./uninstall.sh --si         # sin preguntar (para scripts); exige --purgar aparte
#
# Por qué no es un simple "rm -rf ~/nopal":
# esa carpeta no contiene solo el programa. Contiene uploads/ con tu
# biblioteca de modelos y G-code, los *_registry.json con cada máquina que
# diste de alta, las cotizaciones, los precios y auth_users.json con los
# usuarios. Borrar todo junto es la clase de error que no se deshace, así
# que acá el valor por omisión es conservar los datos y hay que pedir
# explícitamente lo contrario.

set -euo pipefail

SRCDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENVDIR="${SRCDIR}/.venv"
SERVICE_NAME="nopal"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

PURGAR=0
DRY_RUN=0
SIN_PREGUNTAR=0

for arg in "$@"; do
    case "$arg" in
        --purgar|--purge)   PURGAR=1 ;;
        --dry-run|--simular) DRY_RUN=1 ;;
        --si|--yes|-y)      SIN_PREGUNTAR=1 ;;
        -h|--help)
            sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *)
            echo "Opción desconocida: ${arg}. Usa --help." >&2
            exit 1 ;;
    esac
done

# Mismo criterio que install.sh: se corre con el usuario normal, no con
# sudo. El script pide sudo solo para lo que de verdad lo necesita (el
# servicio), y así los archivos del usuario nunca se borran como root.
if [ "$EUID" -eq 0 ]; then
    echo "No corras este script como root/sudo. Ejecútalo con tu usuario normal." >&2
    exit 1
fi

# Salvaguarda contra correrlo desde el lugar equivocado: si esto no parece
# una instalación de NOPAL, mejor no borrar nada.
if [ ! -f "${SRCDIR}/backend/main.py" ] || [ ! -f "${SRCDIR}/install.sh" ]; then
    echo "Esto no parece una instalación de NOPAL (${SRCDIR}). No se hace nada." >&2
    exit 1
fi

ejecutar() {
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "   [simulado] $*"
    else
        "$@"
    fi
}

# --------------------------------------------------------------------------
# Qué hay y qué se va
# --------------------------------------------------------------------------

# Estado por instalación: lo que NO es código y no se puede volver a bajar
# del repositorio. Coincide con lo que .gitignore excluye a propósito.
DATOS=(
    uploads previews backups database logs data plugins camera_captures
    laser_registry.json laser_history.json
    marlin_printer_registry.json elegoo_printer_registry.json
    flashforge_printer_registry.json bambu_printer_registry.json
    camera_registry.json accessory_registry.json arduino_boards_config.json
    temperature_presets.json scheduled_prints.json
    pricing_config.json quotes_registry.json
    spoolman_config.json spoolman_printer_links.json
    spoolman_reservations.json spoolman_usage_log.json
    tunascreen_devices.json auth_users.json
    ai_config.json ai_conversations.json .session_secret
)

tamano_de() {
    du -sh "$1" 2>/dev/null | cut -f1 || echo "?"
}

echo "== Desinstalador de NOPAL =="
echo "   Instalación: ${SRCDIR}"
[ "$DRY_RUN" -eq 1 ] && echo "   MODO SIMULACIÓN: no se va a tocar nada."
echo ""

echo "Se va a QUITAR:"
if [ -f "${UNIT_FILE}" ]; then
    echo "   · el servicio ${SERVICE_NAME}.service (se detiene y se desactiva)"
else
    echo "   · (no hay servicio instalado en ${UNIT_FILE})"
fi
[ -d "${ENVDIR}" ] && echo "   · el entorno virtual .venv ($(tamano_de "${ENVDIR}"))"

presentes=()
for item in "${DATOS[@]}"; do
    [ -e "${SRCDIR}/${item}" ] && presentes+=("${item}")
done

echo ""
if [ "${#presentes[@]}" -eq 0 ]; then
    echo "No se encontraron datos de usuario en esta instalación."
elif [ "$PURGAR" -eq 1 ]; then
    echo "Se va a BORRAR TAMBIÉN (--purgar):"
    for item in "${presentes[@]}"; do
        echo "   · ${item}  ($(tamano_de "${SRCDIR}/${item}"))"
    done
    echo ""
    echo "   Ahí van tu biblioteca de modelos y G-code, las máquinas dadas de alta,"
    echo "   las cotizaciones, los usuarios y las claves de API. Esto NO se deshace."
else
    echo "Se va a CONSERVAR (usa --purgar para borrarlo también):"
    for item in "${presentes[@]}"; do
        echo "   · ${item}  ($(tamano_de "${SRCDIR}/${item}"))"
    done
fi

echo ""
echo "NO se toca: Klipper, Moonraker, crowsnest, ni ningún otro servicio del sistema."
echo ""

# --------------------------------------------------------------------------
# Confirmación
# --------------------------------------------------------------------------
# Se pide escribir una palabra, no un "s/n": la tecla equivocada en un
# prompt de una letra es justo como se borra una biblioteca por accidente.

if [ "$DRY_RUN" -eq 0 ] && [ "$SIN_PREGUNTAR" -eq 0 ]; then
    if [ "$PURGAR" -eq 1 ]; then
        PALABRA="PURGAR"
    else
        PALABRA="DESINSTALAR"
    fi
    read -r -p "Escribe ${PALABRA} para continuar (cualquier otra cosa cancela): " respuesta
    if [ "${respuesta}" != "${PALABRA}" ]; then
        echo "Cancelado. No se tocó nada."
        exit 0
    fi
fi

# --------------------------------------------------------------------------
# Respaldo antes de purgar
# --------------------------------------------------------------------------
# Aunque lo haya confirmado escribiendo la palabra, un respaldo automático
# fuera de la carpeta que se va a borrar convierte un error irreversible en
# uno molesto. Solo la configuración, no la biblioteca: uploads/ puede pesar
# gigas y hacer un tar de eso a ciegas llenaría el disco.

if [ "$PURGAR" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
    RESPALDO="${HOME}/nopal-config-$(date +%Y%m%d-%H%M%S).tar.gz"
    configs=()
    for item in "${DATOS[@]}"; do
        case "${item}" in
            # Pesados y recuperables: la biblioteca y los respaldos se
            # copian con rsync si hacen falta, y plugins/ son repos de git
            # que la galería vuelve a clonar. Lo que sí va es data/, que es
            # chico y guarda qué plugins estaban instalados y habilitados.
            uploads|previews|backups|database|logs|camera_captures|plugins) continue ;;
        esac
        [ -e "${SRCDIR}/${item}" ] && configs+=("${item}")
    done
    if [ "${#configs[@]}" -gt 0 ]; then
        echo "-- Respaldando configuración en ${RESPALDO}"
        tar -czf "${RESPALDO}" -C "${SRCDIR}" "${configs[@]}" 2>/dev/null || \
            echo "   (no se pudo crear el respaldo; se continúa igual)"
        # Contiene hashes de contraseña y la clave de API de la IA.
        chmod 600 "${RESPALDO}" 2>/dev/null || true
    fi
fi

# --------------------------------------------------------------------------
# Servicio systemd
# --------------------------------------------------------------------------

# Cada paso puede fallar por su cuenta -- típicamente porque sudo pide una
# contraseña que nadie escribe, o porque no hay sudo. Que eso aborte el
# script entero (set -e) dejaría la desinstalación a medias: servicio
# detenido pero entorno virtual intacto, y sin decir por qué. Así que acá
# los fallos se anotan y se sigue; el resumen final los reporta.
FALLOS_SERVICIO=()

paso_servicio() {
    if ! ejecutar "$@"; then
        FALLOS_SERVICIO+=("$*")
    fi
}

if [ -f "${UNIT_FILE}" ]; then
    echo "-- Deteniendo y desactivando ${SERVICE_NAME}.service"
    paso_servicio sudo systemctl disable --now "${SERVICE_NAME}.service"
    paso_servicio sudo rm -f "${UNIT_FILE}"
    # Los overrides de systemctl edit viven aparte y sobrevivirían al
    # borrado del .service, dejando basura que confunde en la próxima
    # instalación (por ejemplo un Environment= con puertos viejos).
    if [ -d "${UNIT_FILE}.d" ]; then
        paso_servicio sudo rm -rf "${UNIT_FILE}.d"
    fi
    paso_servicio sudo systemctl daemon-reload
    # reset-failed falla si la unidad no estaba en estado fallido, que es lo
    # normal: no es un problema y no se reporta como tal.
    ejecutar sudo systemctl reset-failed "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
else
    echo "-- Sin servicio que quitar"
fi

# --------------------------------------------------------------------------
# Entorno virtual
# --------------------------------------------------------------------------

if [ -d "${ENVDIR}" ]; then
    echo "-- Borrando entorno virtual ${ENVDIR}"
    ejecutar rm -rf "${ENVDIR}"
fi

# --------------------------------------------------------------------------
# Datos de usuario
# --------------------------------------------------------------------------

if [ "$PURGAR" -eq 1 ] && [ "${#presentes[@]}" -gt 0 ]; then
    echo "-- Borrando datos de usuario"
    for item in "${presentes[@]}"; do
        ejecutar rm -rf "${SRCDIR:?}/${item}"
    done
fi

# --------------------------------------------------------------------------
# Resumen
# --------------------------------------------------------------------------

echo ""
if [ "$DRY_RUN" -eq 1 ]; then
    echo "== Simulación terminada: no se tocó nada =="
    exit 0
fi

if [ "${#FALLOS_SERVICIO[@]}" -gt 0 ]; then
    echo "== NOPAL desinstalado, PERO quedaron pasos pendientes =="
    echo ""
    echo "Estos comandos no se pudieron completar (lo normal es que falte sudo):"
    for fallo in "${FALLOS_SERVICIO[@]}"; do
        echo "   ${fallo}"
    done
    echo ""
    echo "Córrelos a mano para terminar de quitar el servicio."
    echo ""
else
    echo "== NOPAL desinstalado =="
    echo ""
fi
if [ "$PURGAR" -eq 1 ]; then
    [ -n "${RESPALDO:-}" ] && [ -f "${RESPALDO:-}" ] && \
        echo "Tu configuración quedó respaldada en: ${RESPALDO}"
    echo "Para terminar de borrar el programa:"
else
    echo "Tus datos siguen en ${SRCDIR} (biblioteca, máquinas, usuarios, ajustes)."
    echo "Si vuelves a instalar en la misma carpeta, los vas a encontrar tal cual."
    echo ""
    echo "Si además quieres borrarlo TODO:"
fi
echo "   rm -rf ${SRCDIR}"
echo ""
echo "Klipper, Moonraker y el resto de tus servicios siguen intactos."
