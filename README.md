# NOPAL
<img width="1895" height="1028" alt="image" src="https://github.com/user-attachments/assets/600beacf-157c-4bd1-a5c0-9307415da5d6" />


Panel de control para bibliotecas de modelos 3D e impresoras Klipper. Organiza tus archivos STL/3MF/G-code, visualízalos en 3D desde el navegador y monitorea en tiempo real el estado de tus impresoras (temperaturas, progreso, historial de trabajos) vía Moonraker.

## Características

- Biblioteca de modelos 3D (STL, 3MF, STEP, G-code) con vista previa en el navegador (Three.js).
- Detección automática de instancias Moonraker locales y monitoreo de temperatura/estado por impresora.
- Historial de los últimos archivos impresos por cada impresora, con miniatura incluida.
- Estadísticas de almacenamiento y modelos.
- Interfaz en español/inglés, con tema claro, oscuro y verde.


<img width="1918" height="1030" alt="image" src="https://github.com/user-attachments/assets/6e6f3622-f5bb-4b16-9e23-166a8d663b4f" />

<img width="1893" height="1032" alt="image" src="https://github.com/user-attachments/assets/5463fedf-8814-4b6b-9ec6-96d551ad5b13" />

<img width="1918" height="1036" alt="image" src="https://github.com/user-attachments/assets/b8ac4145-4832-4090-a647-2408e987b2f2" />

<img width="1892" height="1032" alt="image" src="https://github.com/user-attachments/assets/a84b8abf-4958-4f74-a369-c1d8fcaeeaaa" />

<img width="1913" height="1033" alt="image" src="https://github.com/user-attachments/assets/3b90870f-a46d-4b62-8aec-c0ad5387e812" />

<img width="1895" height="1032" alt="image" src="https://github.com/user-attachments/assets/9c682844-5b96-4828-b52c-0bded137b954" />

<img width="1898" height="1032" alt="image" src="https://github.com/user-attachments/assets/a058caab-656c-47b9-91bb-5a50cbe8c393" />


## Requisitos

- Linux con Python 3.9 o superior (pensado para Raspberry Pi OS / Debian / Ubuntu, el mismo entorno donde corre Klipper).
- [Moonraker](https://moonraker.readthedocs.io/) corriendo en la misma máquina (opcional, solo se necesita para ver el estado de impresoras).

<img width="1913" height="1032" alt="image" src="https://github.com/user-attachments/assets/1d1f7ee0-c43a-425a-beaf-339e33201df7" />


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
