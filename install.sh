#!/bin/bash
# Instalador de NOPAL para sistemas basados en Klipper (Raspberry Pi OS / Debian / Ubuntu).
#
# Uso:
#   git clone <url-del-repo> ~/nopal
#   cd ~/nopal
#   ./install.sh

set -e

SRCDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENVDIR="${SRCDIR}/.venv"
SERVICE_NAME="nopal"
NOPAL_USER="$(whoami)"
NOPAL_PORT="${NOPAL_PORT:-8420}"

echo "== Instalando NOPAL en ${SRCDIR} =="

if [ "$EUID" -eq 0 ]; then
    echo "No corras este script como root/sudo. Ejecútalo con tu usuario normal (el mismo que corre Klipper/Moonraker)."
    exit 1
fi

echo "-- Verificando dependencias del sistema (python3-venv, python3-pip)"
sudo apt-get update -qq
sudo apt-get install -y python3-venv python3-pip

echo "-- Creando entorno virtual en ${ENVDIR}"
if [ ! -d "${ENVDIR}" ]; then
    python3 -m venv "${ENVDIR}"
fi

echo "-- Instalando dependencias de Python"
"${ENVDIR}/bin/pip" install --upgrade pip
"${ENVDIR}/bin/pip" install -r "${SRCDIR}/requirements.txt"

echo "-- Creando carpetas de datos (uploads/, previews/)"
mkdir -p "${SRCDIR}/uploads" "${SRCDIR}/previews"

echo "-- Configurando servicio systemd (${SERVICE_NAME}.service)"
sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null <<EOF
[Unit]
Description=NOPAL - Panel de control de impresión 3D
After=network-online.target moonraker.service

[Service]
Type=simple
User=${NOPAL_USER}
WorkingDirectory=${SRCDIR}
ExecStart=${ENVDIR}/bin/uvicorn backend.main:app --host 0.0.0.0 --port ${NOPAL_PORT}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}.service"
sudo systemctl restart "${SERVICE_NAME}.service"

IP_ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"

echo ""
echo "== Instalación completa =="
echo "NOPAL está corriendo como servicio (${SERVICE_NAME}.service) en el puerto ${NOPAL_PORT}."
echo "Accede desde el navegador en: http://${IP_ADDR:-<ip-de-tu-maquina>}:${NOPAL_PORT}"
echo ""
echo "Comandos útiles:"
echo "  sudo systemctl status ${SERVICE_NAME}    # ver estado"
echo "  sudo systemctl restart ${SERVICE_NAME}   # reiniciar"
echo "  journalctl -u ${SERVICE_NAME} -f         # ver logs en vivo"
