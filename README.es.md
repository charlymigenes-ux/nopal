# NOPAL

<table>
  <tr>
    <td><img width="630" alt="Dashboard de NOPAL" src="https://github.com/user-attachments/assets/600beacf-157c-4bd1-a5c0-9307415da5d6" /></td>
    <td><img width="630" alt="Captura de NOPAL" src="https://github.com/user-attachments/assets/6e6f3622-f5bb-4b16-9e23-166a8d663b4f" /></td>
    <td><img width="630" alt="Captura de NOPAL" src="https://github.com/user-attachments/assets/5463fedf-8814-4b6b-9ec6-96d551ad5b13" /></td>
  </tr>
  <tr>
    <td><img width="630" alt="Captura de NOPAL" src="https://github.com/user-attachments/assets/b8ac4145-4832-4090-a647-2408e987b2f2" /></td>
    <td><img width="630" alt="Captura de NOPAL" src="https://github.com/user-attachments/assets/a84b8abf-4958-4f74-a369-c1d8fcaeeaaa" /></td>
    <td><img width="630" alt="Captura de NOPAL" src="https://github.com/user-attachments/assets/3b90870f-a46d-4b62-8aec-c0ad5387e812" /></td>
  </tr>
  <tr>
    <td><img width="630" alt="Captura de NOPAL" src="https://github.com/user-attachments/assets/9c682844-5b96-4828-b52c-0bded137b954" /></td>
    <td><img width="630" alt="Captura de NOPAL" src="https://github.com/user-attachments/assets/a058caab-656c-47b9-91bb-5a50cbe8c393" /></td>
    <td><img width="630" alt="Captura de NOPAL" src="https://github.com/user-attachments/assets/1d1f7ee0-c43a-425a-beaf-339e33201df7" /></td>
  </tr>
</table>

**Leer en otros idiomas:** [English](README.md)

**NOPAL** es un panel de control autoalojado (self-hosted), 100% desde el navegador, que unifica el **manejo de impresoras 3D (Klipper/Moonraker)** y el **control de cortadoras/grabadoras láser GRBL** en un solo dashboard, sobre una biblioteca completa de **modelos 3D y G-code**. Está pensado para makers, pequeñas granjas de impresión, y cualquiera que tenga un taller mixto de impresión 3D + láser y esté cansado de andar saltando entre pestañas de Mainsail/Fluidd, ventanas de LightBurn/LaserGRBL y un explorador de archivos aparte.

---

## Índice

* [Resumen](#resumen)
* [Características](#características)
* [Arquitectura](#arquitectura)
* [Requisitos](#requisitos)
* [Instalación](#instalación)
* [Configuración](#configuración)
* [Uso](#uso)
* [Desarrollo](#desarrollo)
* [Actualizar](#actualizar)
* [Desinstalar](#desinstalar)
* [Roadmap](#roadmap)
* [Licencia](#licencia)

---

## Resumen

NOPAL está pensado para resolver tres problemas que suelen aparecer juntos en un taller casero o pequeño de fabricación:

1. **Organizar grandes colecciones de archivos** imprimibles y cortables (STL, 3MF, STEP, G-code) repartidos en carpetas y formatos distintos.
2. **Monitorear y controlar varias impresoras 3D a la vez**, sin andar cambiando entre instancias separadas de Mainsail/Fluidd.
3. **Controlar cortadoras/grabadoras láser GRBL** — por WiFi (placas estilo ESP3D) o directo por USB — desde el mismo lugar, incluyendo varios láseres al mismo tiempo.

NOPAL junta las tres cosas en una sola aplicación web: una biblioteca de modelos/G-code, un dashboard en vivo con cada impresora y láser que detecta, y paneles de control por máquina (temperaturas, movimiento del cabezal, controles de jog/disparo, colas de trabajo) — todo desde un único servicio autoalojado.

---

## Características

### Biblioteca de modelos 3D y G-code

* Explora y organiza tus archivos imprimibles/cortables: **STL**, **3MF**, **STEP**, **G-code**.
* Carpetas, renombrar/mover/eliminar, subida desde el navegador.
* **Vista previa en 3D** dentro del navegador (Three.js) para modelos y trayectorias de G-code.
* Genera G-code desde un modelo o envía un archivo directo a una impresora o a la cola del láser.

### Dashboard unificado

* Detecta automáticamente las instancias locales de **Moonraker** y los **láseres GRBL** registrados (red + USB) y los muestra juntos, ordenados por conexión/estado (imprimiendo/grabando primero, después inactivas, después sin conexión).
* Colores por tipo de máquina y por estado, con un botón para ocultar rápido las que están sin conexión.
* Vista en mosaico o en lista.
* Acciones rápidas directo en la ficha: enfriar / precalentar una impresora sin abrir su panel de detalle.

### Control de impresoras 3D (Klipper/Moonraker)

* Temperaturas en vivo (cama/extrusor) con escala de color tipo mapa de calor (azul → blanco → amarillo → naranja → rojo).
* Precalentado y enfriado con un clic, con presets editables.
* **Panel Toolhead**: posición en vivo, jog X/Y/Z, home (total o por eje), motores apagados, ajuste fino de Z-offset, factor de velocidad.
* **Cola de impresión activa real**: archivo actual, progreso en vivo y tiempo restante estimado, sacados directo de Moonraker — no es un dato de relleno.
* Historial de impresión por impresora, con miniatura cuando está disponible.
* **Macros**: lista lo que tengas configurado en `printer.cfg` y los ejecuta con un toque.

### Control de láser GRBL (red + USB)

* Funciona con **placas de red** (controladoras WiFi estilo ESP3D, como las placas láser basadas en DLC32) y con **placas USB/serie** (CH340, CP210x, ESP32 nativo) — detecta automáticamente controladoras láser conectadas por USB al servidor.
* Maneja **varios láseres al mismo tiempo**, cada uno con su propio trabajo, conexión y configuración independientes.
* Controles de jog manual, home, editor de parámetros GRBL ($$).
* Control de disparo con un patrón de seguridad deliberado (doble clic para armar), más un interruptor de aire asistido.
* Explorador de tarjeta SD (en placas con almacenamiento propio): navegar, subir, borrar.
* Streaming de G-code confiable con un protocolo real de buffer por conteo de caracteres (mantiene lleno el planificador de movimiento de GRBL en vez de cortarse entre líneas).
* Consola GRBL en vivo.
* Cola de trabajos con enmarcado (recorrer el contorno del trabajo antes de disparar) y envío de varias copias.

### Interfaz

* Cuatro temas: claro, oscuro, **NOPAL Style** (verde, con su propio fondo) y un **tema personalizado** completo (elige tus propios colores de acento/superficie/texto y sube tu propia imagen de fondo).
* Tamaño de texto de la interfaz ajustable.
* Interfaz bilingüe (español/inglés).
* Sección de **Ayuda** dentro de la app con una guía rápida de cada parte y un enlace a este repositorio.

### Despliegue autoalojado

* Pensado para los entornos Linux donde normalmente corre Klipper.
* Se instala y corre como **servicio systemd**.
* Compatible con **Raspberry Pi OS**, **Debian**, **Ubuntu** y distribuciones similares.

---

## Arquitectura

NOPAL es una aplicación web autoalojada y liviana, sin necesidad de base de datos externa.

### Componentes principales

* **Backend**: Python (FastAPI) servido con **Uvicorn**.
* **Frontend**: HTML renderizado por el servidor + JS sin frameworks, sin paso de build; vista previa 3D/G-code con Three.js.
* **Integración con Moonraker**: llamadas REST a cada instancia local de Moonraker detectada, para estado de impresora, temperaturas, trabajos y comandos G-code.
* **Integración GRBL**: HTTP + WebSocket para placas de red (estilo ESP3D), serie directo (pyserial) para placas USB — con estado de conexión y trabajo por host, así varias máquinas corren de forma realmente independiente al mismo tiempo.

### Flujo general

1. NOPAL escanea e indexa los archivos de modelo/G-code soportados de la biblioteca local.
2. La interfaz web expone esos archivos para explorarlos, previsualizarlos y enviarlos a una máquina.
3. NOPAL descubre las instancias locales de Moonraker y los láseres GRBL registrados, y abre una conexión persistente con cada uno.
4. El dashboard junta el estado de modelos, impresoras y láseres en una sola interfaz, actualizada casi en tiempo real.

---

## Requisitos

### Sistema operativo

* Linux
* Recomendado: Debian, Ubuntu o Raspberry Pi OS

### Entorno de ejecución

* **Python 3.9 o superior**

### Opcional pero recomendado

* Una instalación funcional de **Klipper + Moonraker** en la misma máquina (o accesible por red) para las funciones de impresora 3D.
* Una **controladora láser basada en GRBL** (de red/estilo ESP3D o USB/serie) para las funciones de láser.

Ni Moonraker ni una controladora láser son obligatorios para correr NOPAL — la biblioteca de modelos y la interfaz funcionan solas; cada integración se activa sola según lo que encuentre.

---

## Instalación

Clona el repositorio y corre el instalador:

```bash
git clone https://github.com/charlymigenes-ux/nopal.git ~/nopal
cd ~/nopal
./install.sh
```

### Qué hace el instalador

1. Instala las dependencias del sistema necesarias (`python3-venv`, `python3-pip`).
2. Crea un entorno virtual de Python.
3. Instala las dependencias de Python desde `requirements.txt`.
4. Registra y arranca un servicio `systemd` (`nopal.service`) para que NOPAL inicie solo con el sistema.

Al terminar, NOPAL queda disponible en:

```text
http://<ip-de-tu-maquina>:8420
```

---

## Configuración

NOPAL está pensado para funcionar de entrada en un entorno Klipper/GRBL local y autoalojado — no hay un archivo de configuración que editar a mano para el uso básico:

* La biblioteca de modelos vive dentro de la carpeta `uploads/` de la app.
* Las instancias de Moonraker se descubren solas en el host local.
* Los láseres GRBL se encuentran escaneando la red local (placas de red) y los puertos serie del sistema (placas USB), y luego se registran desde la interfaz.
* Las preferencias de interfaz (tema, idioma, tamaño) se guardan por navegador.

Si planeas exponer NOPAL más allá de tu red local, ponlo detrás de un proxy inverso como **Nginx** o **Caddy** y agrega autenticación en esa capa — NOPAL todavía no trae autenticación propia (ver [Roadmap](#roadmap)).

---

## Uso

Con el servicio corriendo, abre la interfaz de NOPAL desde un navegador en tu red local.

### Flujo típico

1. Abre el dashboard y revisa de un vistazo el estado de cada impresora y láser.
2. Explora tu biblioteca de modelos, previsualiza uno en 3D y genera o elige su G-code.
3. Envía el trabajo a una impresora, o agrégalo a la cola del láser y mándalo al láser que quieras.
4. Observa en vivo las temperaturas, la posición del cabezal, o la posición/avance del láser mientras corre el trabajo.
5. Revisa los trabajos recientes y el historial de impresión por máquina.

### Casos de uso típicos

* Manejar una biblioteca compartida de archivos imprimibles y listos para láser.
* Monitorear y controlar varias impresoras Klipper desde un solo dashboard.
* Correr una cortadora/grabadora láser junto con impresoras 3D sin necesitar otra app.
* Cambiar entre dos o tres láseres registrados (red + USB) sin desconectar nada.
* Armar un panel de control pequeño y autoalojado para un taller casero o una pequeña granja de impresión.

---

## Desarrollo

Para correr NOPAL localmente en modo desarrollo:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8420
```

Luego abre:

```text
http://localhost:8420
```

### Flujo de trabajo sugerido

* Usa un entorno virtual de Python para trabajar localmente.
* Mantén Moonraker y/o una placa GRBL accesibles localmente si estás probando la integración de impresoras o láser.
* Corre con `--reload` durante el desarrollo para iterar más rápido.

---

## Actualizar

Para actualizar una instalación existente:

```bash
cd ~/nopal
git pull
./install.sh
sudo systemctl restart nopal
```

---

## Desinstalar

Para quitar NOPAL del sistema:

```bash
sudo systemctl disable --now nopal
sudo rm /etc/systemd/system/nopal.service
sudo systemctl daemon-reload
rm -rf ~/nopal
```

---

## Roadmap

Posibles áreas futuras para NOPAL:

* metadatos más ricos para la biblioteca de modelos — tags, colecciones y filtros de búsqueda
* mejores analíticas e historial de trabajos de impresión/láser
* autenticación y control de acceso multiusuario
* integración con almacenamiento externo
* identificar el comando correcto de ejecución desde SD para más variantes de firmware GRBL/estilo DLC32 (correr directo desde la SD, en vez de streaming)

---

## Licencia

Este proyecto está licenciado bajo la [GNU General Public License v3.0](LICENSE).
