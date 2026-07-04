# NOPAL

Panel de control para bibliotecas de modelos 3D e impresoras Klipper. Organiza tus archivos STL/3MF/G-code, visualízalos en 3D desde el navegador y monitorea en tiempo real el estado de tus impresoras (temperaturas, progreso, historial de trabajos) vía Moonraker.

## Características

- Biblioteca de modelos 3D (STL, 3MF, STEP, G-code) con vista previa en el navegador (Three.js).
- Detección automática de instancias Moonraker locales y monitoreo de temperatura/estado por impresora.
- Historial de los últimos archivos impresos por cada impresora, con miniatura incluida.
- Estadísticas de almacenamiento y modelos.
- Interfaz en español/inglés, con tema claro, oscuro y verde.

## Requisitos

- Linux con Python 3.9 o superior (pensado para Raspberry Pi OS / Debian / Ubuntu, el mismo entorno donde corre Klipper).
- [Moonraker](https://moonraker.readthedocs.io/) corriendo en la misma máquina (opcional, solo se necesita para ver el estado de impresoras).

## Instalación

```bash
git clone https://github.com/<tu-usuario>/nopal.git ~/nopal
cd ~/nopal
./install.sh
```

El script `install.sh`:

1. Instala las dependencias del sistema necesarias (`python3-venv`, `python3-pip`).
2. Crea un entorno virtual e instala las dependencias de Python (`requirements.txt`).
3. Registra y arranca un servicio `systemd` (`nopal.service`) para que NOPAL inicie automáticamente con el sistema.

Al terminar, la aplicación queda disponible en `http://<ip-de-tu-maquina>:8420`.

### Actualizar

```bash
cd ~/nopal
git pull
./install.sh
sudo systemctl restart nopal
```

### Desinstalar

```bash
sudo systemctl disable --now nopal
sudo rm /etc/systemd/system/nopal.service
sudo systemctl daemon-reload
rm -rf ~/nopal
```

## Desarrollo local

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8420
```

## Licencia

Este proyecto está licenciado bajo la [GNU General Public License v3.0](LICENSE).
