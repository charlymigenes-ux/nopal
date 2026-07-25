MANUAL DE USUARIO — Panel de Control NOPAL
Impresoras 3D, Láser y CNC

> **Nota de esta actualización (23 de julio de 2026).** Este documento reemplaza el contenido de `NOPAL_Manual_Usuario.pdf` (generado el 9 de julio de 2026 a partir de capturas reales). Desde esa fecha el proyecto sumó cerca de 70 commits: autenticación multi-usuario, cuatro familias nuevas de impresora (Marlin standalone, Elegoo, FlashForge, Bambu Lab), sistema de plugins instalables, Cotizador, Centro de Ayuda rediseñado, Panel de Control del Sistema, recorrido guiado, 5 idiomas, entre otros.
>
> Esta pasada actualiza **texto y estructura** con base en el código actual (`backend/templates/index.html`, `app.js`, `translations.js`) — **no incluye capturas de pantalla nuevas**. Cada lugar donde hace falta una está marcado con `[CAPTURA PENDIENTE: ...]`. Donde la captura del PDF anterior probablemente sigue sirviendo, se indica `Captura anterior: probablemente vigente`; donde el elemento cambió de forma visible, `Captura anterior: desactualizada`. Antes de volver a exportar el PDF, hay que entrar a NOPAL, tomar las capturas marcadas y reemplazar los placeholders.
>
> Versión de software documentada: `1.2.0-alpha.1` (commit `d738dc9`) · Debian GNU/Linux 13 (trixie) · Documento de contenido generado el 23 de julio de 2026.

---

## Índice

1. Introducción a NOPAL
   1.1 Diagrama de conexión de red
   1.2 Inicio de sesión y primera configuración
2. Panel de Control
   2.1 Estado de las máquinas
   2.2 Máquina en ejecución
   2.3 Vistas de la lista de impresoras
   2.4 Organizar dispositivos y tarjetas
3. Control de Láser y CNC — vista de detalle
   3.1 Conexión, movimiento y consola
   3.2 Configuración GRBL
   3.3 Cortadoras con firmware Marlin
4. G-code y Tarjeta SD
   4.1 Tarjeta SD en láser/CNC (GRBL)
   4.2 Imprimir desde Tarjeta SD en impresoras Marlin
5. Bibliotecas de archivos
   5.1 Biblioteca de Modelos 3D
   5.2 Biblioteca de Archivos G-code
   5.3 Enviar un archivo a imprimir
6. Impresoras 3D — tipos y vista de detalle
   6.1 Impresoras Klipper
   6.2 Impresión activa
   6.3 Impresoras Marlin standalone
   6.4 Impresoras Elegoo
   6.5 Impresoras FlashForge
   6.6 Impresoras Bambu Lab
   6.7 Interfaz en 5 idiomas
7. Consola
8. Historial de trabajos
9. Editor de G-code
10. Galería de Plugins
11. Configuración general
12. Centro de Ayuda
13. Panel de Control del Sistema
14. Recorrido guiado (onboarding)

---

## 1. Introducción a NOPAL

NOPAL es un panel de control autoalojado (self-hosted) que unifica en una sola aplicación web la administración de impresoras 3D y cortadoras láser/CNC de distintas marcas y firmwares, junto con una biblioteca de modelos 3D y archivos G-code. En lugar de usar una aplicación distinta por cada máquina, NOPAL centraliza el monitoreo y control de todo el taller: temperaturas en tiempo real, control del cabezal, cola de impresión, consola de comandos, cotizaciones y almacenamiento de archivos, todo desde el navegador y accesible dentro de la red local.

**Actualizado:** ya no solo habla con Klipper/Moonraker (impresoras) y GRBL/FluidNC (láser/CNC). Ahora también controla impresoras Marlin standalone por USB o WiFi (MKS), impresoras Elegoo (protocolo SDCP), impresoras FlashForge (HTTP) e impresoras Bambu Lab (LAN/MQTT). Además, el acceso ahora requiere iniciar sesión (ver 1.2), y buena parte de las funciones extra (cámaras, accesorios Arduino, Cotizador, creador de formas, herramientas SVG) vive en **plugins instalables** desde una galería dentro de NOPAL (ver Sección 10) en vez de venir todos incluidos de fábrica.

| Backend | Frontend |
|---|---|
| Python (FastAPI + Uvicorn) | JavaScript + Three.js (visor 3D / G-code) |

| Licencia | Idiomas |
|---|---|
| GNU GPL v3.0 | Español, Inglés, Portugués (BR), Francés, Alemán |

Ver el diagrama de conexión completo en la Sección 1.1.

**Captura anterior: probablemente vigente** (bloque de datos backend/frontend/licencia/idiomas), salvo actualizar la fila de idiomas a las 5 disponibles.

### 1.1 Diagrama de conexión de red

Ejemplo de instalación típica: el servidor Debian corre NOPAL junto con una instancia de Moonraker por impresora Klipper, y se comunica con el resto de las máquinas según su transporte: láseres/CNC por WiFi (ESP3D/GRBL-ESP) o serial/USB, impresoras Marlin standalone por USB o WiFi (MKS), e impresoras Elegoo/FlashForge/Bambu Lab directamente por red local (WebSocket/HTTP/MQTT según la marca). Cualquier dispositivo en la misma red local puede acceder a NOPAL desde el navegador.

| Puerto/transporte | Qué es |
|---|---|
| 8420 | Interfaz web de NOPAL |
| 7125 / 7126 / 7127 | Moonraker, una instancia por impresora Klipper |
| 80 / 8080 · Serial | Láseres/CNC WiFi (ESP3D/GRBL-ESP) y por USB (`/dev/ttyUSB*`) |
| Serial / WiFi (MKS) | Impresoras Marlin standalone |
| Red local (WS/HTTP/MQTT) | Impresoras Elegoo, FlashForge y Bambu Lab |
| USB-Serial / WiFi | Placas de accesorios Arduino/ESP32 (plugin "Automatización de Taller") |
| 8080 | Crowsnest / plugin de cámaras — streaming de cámaras |

Nota: todos los dispositivos deben estar en la misma red local. Los puertos se pueden cambiar en la configuración si es necesario. Para acceso remoto (fuera de la red local), se recomienda usar una VPN o un reverse proxy (Nginx / Caddy) con HTTPS en lugar de exponer NOPAL directamente a internet.

`[CAPTURA PENDIENTE: diagrama de conexión actualizado — agregar los recuadros de Marlin standalone, Elegoo, FlashForge, Bambu Lab y accesorios Arduino al diagrama existente]`

### 1.2 Inicio de sesión y primera configuración

**Sección nueva.** NOPAL ahora requiere una cuenta para entrar. La primera vez que se abre NOPAL en una instalación nueva (sin usuarios creados), se muestra una pantalla de **configuración inicial** donde la primera persona en entrar define su propio usuario y contraseña de administrador (mínimo 8 caracteres). En instalaciones ya configuradas, se muestra en su lugar la pantalla normal de **inicio de sesión** (usuario y contraseña). Ambas pantallas incluyen su propio selector de idioma.

Una vez dentro, la barra superior ("topbar") agrega:

- **Campana de notificaciones** — avisa de dispositivos sin conexión, trabajos fallidos y actualizaciones disponibles.
- **Botón de control del sistema** (solo administradores) — abre el Panel de Control del Sistema, ver Sección 13.
- **Selector de idioma** (ícono de globo) — mismo selector de 5 idiomas, ahora también disponible desde aquí además de Configuración.
- **Menú de usuario** — nombre, rol (Administrador/Operador) y botón de cerrar sesión.

Los roles son dos: **Administrador** (acceso total, incluye gestión de usuarios, plugins e instalación de dispositivos) y **Operador** (uso diario de las máquinas, sin esas pantallas administrativas). La gestión de usuarios se hace desde Configuración → Usuarios (Sección 11.5).

`[CAPTURA PENDIENTE: pantalla de configuración inicial (primer usuario administrador)]`
`[CAPTURA PENDIENTE: pantalla de inicio de sesión]`
`[CAPTURA PENDIENTE: topbar con campana de notificaciones, selector de idioma y menú de usuario abiertos]`

---

## 2. Panel de Control

Es la pantalla principal al entrar a NOPAL. Muestra de un vistazo el estado del servidor (host), las tarjetas resumen de la biblioteca y el estado de cada impresora o láser conectado a la red, ahora incluyendo las cuatro familias de impresora nuevas (Marlin, Elegoo, FlashForge, Bambu Lab) mezcladas con las Klipper en una sola grilla ordenada por estado.

**Captura anterior: probablemente vigente** para la vista general (host + tarjetas resumen); conviene retomarla igual para reflejar el topbar nuevo (Sección 1.2) y, si hay a la mano, alguna máquina Marlin/Elegoo/FlashForge/Bambu en la lista.

### 2.1 Estado de las máquinas

Sin cambios de fondo. Cada tarjeta indica el nombre de la máquina y su estado mediante un punto de color:

- **Idle / Inactivo** — la máquina está encendida y conectada, sin trabajo en curso.
- **Run** — la máquina tiene un trabajo en curso (impresión o corte activo).
- **Error** — la máquina reporta una falla; requiere revisión antes de operarla.
- **Sin conexión** — NOPAL no puede comunicarse con el controlador (revisar red/USB).

**Captura anterior: probablemente vigente.**

### 2.2 Máquina en ejecución

Sin cambios. Mientras una máquina tiene un trabajo activo, su fila en la Lista de Impresoras se expande para mostrar posición y avance/potencia en vivo, sin necesidad de entrar a su vista de detalle.

**Captura anterior: probablemente vigente.**

### 2.3 Vistas de la lista de impresoras

Sin cambios. Los iconos de la esquina superior derecha de "Lista de Impresoras" cambian cómo se muestran las máquinas: en tarjetas (grid), en filas (lista) o en modo de solo lectura.

**Captura anterior: probablemente vigente.**

### 2.4 Organizar dispositivos y tarjetas

**Subsección nueva.** La barra de herramientas de "Dispositivos" en el Panel de Control incluye dos personalizadores propios (arrastrar y soltar) y un modo de agrupado:

- **"Organizar dispositivos"** — reordena o muestra/oculta las columnas por tipo de máquina (Impresoras 3D, Láser, CNC) que se ven en el Panel de Control.
- **"Organizar tarjeta de impresora"** — reordena (sin poder ocultarlas) las cuatro secciones dentro de cada tarjeta de impresora: encabezado, estado, miniatura y temperaturas.
- **"Modo grupo"** — agrupa los dispositivos por tipo en vez de mostrarlos en una lista plana.

`[CAPTURA PENDIENTE: modal "Organizar dispositivos"]`
`[CAPTURA PENDIENTE: modal "Organizar tarjeta de impresora"]`

---

## 3. Control de Láser y CNC — vista de detalle

Al seleccionar un láser o CNC (GRBL/FluidNC) desde el Panel de Control se abre esta vista con tres bloques principales: conexión y datos del controlador, movimiento del cabezal, y la consola de comandos en tiempo real. Sin cambios de fondo respecto al manual anterior.

**Captura anterior: probablemente vigente.**

### 3.1 Conexión, movimiento y consola

| Conexión | Movimiento del cabezal |
|---|---|
| Estado (Conectado/Idle), IP, señal WiFi, chip y versión de firmware. | Flechas de jog, tamaño de paso (0.1–100 mm), botón de home y encendido de láser/aire asistido. |

| Potencia | Consola |
|---|---|
| Ajuste de potencia del láser en porcentaje antes de operar. | Log en vivo de comandos para diagnóstico. |

### 3.2 Configuración GRBL

Sin cambios. Desde el ícono de engranaje se abre la ventana con los parámetros `$$` de la placa controladora GRBL, con descripción en español de cada uno.

> Precaución: modificar estos parámetros sin conocer su función puede afectar la precisión de corte o dañar el motor. Se recomienda anotar los valores originales antes de cambiar cualquier parámetro `$$`.

**Captura anterior: probablemente vigente.**

### 3.3 Cortadoras con firmware Marlin

**Subsección nueva.** Además de GRBL/FluidNC, una placa de láser o CNC puede configurarse para operar con firmware **Marlin** en vez de GRBL — se controla desde el mismo flujo de alta/edición de dispositivo (Sección 11.6), eligiendo el firmware de la placa. La vista de detalle y la consola funcionan igual; la diferencia está por debajo: el jog, el homing y la lectura de posición usan comandos Marlin (`G28`, `M114`, etc.) en vez de GRBL (`$H`, `$J=`).

Limitación conocida de esta primera versión: la ventana de "Configuración GRBL" (Sección 3.2, parámetros `$$`) es exclusiva de placas GRBL — las placas Marlin no tienen todavía una pantalla equivalente de ajustes avanzados.

`[CAPTURA PENDIENTE: selector de firmware (GRBL/Marlin) en el alta o edición de un láser/CNC]`

---

## 4. G-code y Tarjeta SD

### 4.1 Tarjeta SD en láser/CNC (GRBL)

Sin cambios respecto al manual anterior. Cada máquina con almacenamiento propio (como la tarjeta SD de un láser GRBL) puede recibir archivos G-code directamente desde la biblioteca de NOPAL, sin necesidad de sacar la tarjeta físicamente.

| Raíz | Enviar a la SD |
|---|---|
| Selecciona qué archivo de la biblioteca de NOPAL enviar a la tarjeta. | Transfiere el G-code elegido directamente a la placa, sin cables ni retirar la tarjeta. |

| Explorador de archivos | Espacio disponible |
|---|---|
| Lista de carpetas y archivos `.gc` ya presentes en la SD, con su tamaño individual. | Se muestra en la esquina superior derecha del bloque (usado / total). |

**Captura anterior: probablemente vigente.**

### 4.2 Imprimir desde Tarjeta SD en impresoras Marlin

**Subsección nueva (feature del 23 de julio de 2026).** Las impresoras Marlin standalone (Sección 6.3) también pueden recibir e imprimir archivos desde su propia tarjeta SD, sin depender de una conexión USB continua durante toda la impresión. Esta opción solo aparece si la placa confirma tener SD instalada (comando `M21`).

Flujo: desde el selector "Enviar a impresora" (Sección 5.3) aparece la opción **"Enviar a Tarjeta SD"** para impresoras Marlin. NOPAL sube el archivo a la SD reutilizando el mismo streaming ok-por-línea que ya usa para imprimir por USB (`M28`/`M29`), precalienta la impresora a la temperatura que el propio G-code declara, y arranca la impresión desde la SD (`M23`/`M24`) una vez alcanzada esa temperatura.

`[CAPTURA PENDIENTE: opción "Enviar a Tarjeta SD" en el selector de envío a impresora Marlin]`

---

## 5. Bibliotecas de archivos

Las bibliotecas de Modelos 3D y de Archivos G-code se rediseñaron como exploradores de archivos completos, con navegación por carpetas y varias herramientas nuevas.

**Captura anterior: desactualizada** — el diseño cambió de una tabla simple a un explorador con migas de pan.

### 5.1 Biblioteca de Modelos 3D

Explora los modelos 3D (STL, 3MF) con navegación por carpetas (migas de pan, atrás/adelante/subir/inicio), indicador de espacio libre en disco, controles de orden/filtro, alternador de vista en grid/lista, barra de selección múltiple (mover/eliminar/cancelar selección) y favoritos. Al elegir un archivo se abre un panel de **Vista previa** persistente a la derecha, con miniatura 3D, metadatos, estrella de favorito y acciones: Enviar a impresora, Descargar, Renombrar, Mover, Eliminar e "Ir a la impresora" (si el archivo ya se envió a alguna). También admite **arrastrar y soltar archivos desde el sistema operativo** directamente para subirlos.

`[CAPTURA PENDIENTE: Biblioteca de Modelos 3D — vista de explorador con migas de pan y panel de vista previa]`

### 5.2 Biblioteca de Archivos G-code

**Subsección nueva.** Mismo rediseño de explorador de archivos que la biblioteca de Modelos 3D (migas de pan, favoritos, selección múltiple, arrastrar y soltar), aplicado a los archivos G-code ya generados. Los archivos de láser/CNC ahora muestran una **miniatura real** generada a partir de los movimientos X/Y del propio G-code (un trazo 2D), en vez de un ícono genérico — útil para identificar de un vistazo qué diseño es cada archivo antes de enviarlo a cortar.

Nota técnica: en archivos de trama/foto-grabado muy grandes, la miniatura puede mostrarse parcial (se procesa hasta un límite de líneas) — es una limitación conocida y aceptada, no un error; los archivos vectoriales de corte/grabado (el caso común) siempre se ven completos.

`[CAPTURA PENDIENTE: Biblioteca de Archivos G-code — explorador con miniaturas de trazo 2D en archivos de láser/CNC]`

### 5.3 Enviar un archivo a imprimir

Desde la Vista previa, el botón "Enviar a impresora" abre el selector para elegir la máquina de destino. Sigue ofreciendo **Impresión inmediata**, **Agregar a la cola** y **Programar impresión** (fecha y hora), y ahora la lista de máquinas de destino incluye también impresoras Marlin, Elegoo, FlashForge y Bambu Lab, no solo Klipper. Para impresoras Marlin con SD, se suma la opción de la Sección 4.2.

**Captura anterior: desactualizada** — falta reflejar las máquinas nuevas en la lista de destino y la opción de SD.

`[CAPTURA PENDIENTE: selector "Enviar a Impresora" mostrando máquinas de varias marcas]`

---

## 6. Impresoras 3D — tipos y vista de detalle

El Panel de Control unifica en una sola grilla las impresoras Klipper, Marlin, Elegoo, FlashForge y Bambu Lab, pero cada familia conserva su propia sección dedicada en el menú lateral (dentro de la categoría "Dispositivos") para su alta y administración, y difiere en cuánto control expone.

### 6.1 Impresoras Klipper

Sin cambios de fondo respecto al manual anterior: al seleccionar una impresora Klipper se abre la vista de detalle con los bloques **Toolhead** (posición X/Y/Z, home por eje o "Todo", Z-Offset, factor de velocidad) y **Temperaturas** (estado, valor actual/objetivo, botones "Enfriar"/"Preestab.").

**Novedad:** el ícono de engranaje en la esquina superior de este modal abre **"Personalizar Módulos"** — un editor de arrastrar y soltar (estilo Mainsail) para reordenar y mostrar/ocultar los módulos Toolhead, Temperaturas y Cola dentro del modal, con una fila fija "Estado" que representa la barra superior. El acomodo se guarda por separado para 4 tamaños de pantalla (celular/tableta/escritorio/pantalla ancha) e incluye un botón de reset. Es exclusivo de la vista Klipper — las demás familias de impresora no tienen este personalizador todavía.

**Captura anterior: probablemente vigente** para Toolhead/Temperaturas.
`[CAPTURA PENDIENTE: modal "Personalizar Módulos" con el gear icon señalado]`

### 6.2 Impresión activa

Sin cambios. Mientras una impresora Klipper tiene un trabajo en curso, la vista de detalle muestra la tarjeta de progreso en tiempo real (miniatura, capa, filamento, tiempo estimado, círculo de progreso, controles Resume/Stop/Cancel/Mute y "Open Fullscreen").

**Captura anterior: probablemente vigente.**

### 6.3 Impresoras Marlin standalone

**Subsección nueva.** Impresoras que corren Marlin de fábrica y se controlan directo por USB o por red (placas MKS con WiFi), sin pasar por Klipper/Moonraker. El alta se hace desde Configuración → Dispositivos, eligiendo el puerto USB detectado (NOPAL prueba la velocidad de conexión automáticamente y sugiere el nombre leyendo `M115`) o agregando la placa por IP si es una MKS WiFi.

La vista de detalle tiene su propio modal de 3 columnas fijas — Toolhead, Temperaturas e Impresión/Consola — sin el personalizador de módulos de la Sección 6.1. Permite jog X/Y/Z, home, control de temperaturas, consola en vivo, pausar/reanudar/cancelar, y ahora también imprimir desde tarjeta SD (Sección 4.2).

`[CAPTURA PENDIENTE: alta de impresora Marlin por puerto USB]`
`[CAPTURA PENDIENTE: modal de detalle de impresora Marlin]`

### 6.4 Impresoras Elegoo

**Subsección nueva.** Impresoras Elegoo (Centauri Carbon, Neptune 4, etc.) controladas por su protocolo nativo **SDCP** vía WebSocket, descubiertas por la red. El alta pide IP y el identificador de la placa (`mainboard_id`), detectados por escaneo de red. A diferencia de Klipper/Marlin, SDCP no expone jog ni homing, así que no hay un modal de detalle propio: los controles de pausar, reanudar y cancelar viven directamente en la tarjeta del Panel de Control.

`[CAPTURA PENDIENTE: alta de impresora Elegoo por escaneo de red]`
`[CAPTURA PENDIENTE: tarjeta de impresora Elegoo con controles de pausa/reanudar/cancelar]`

### 6.5 Impresoras FlashForge

**Subsección nueva.** Impresoras FlashForge de la línea moderna (Adventurer 5M/5M Pro/AD5X, Creator 5), controladas por HTTP. El alta pide IP, número de serie y el "check code" que se lee en la pantalla de la propia impresora. Mismo patrón que Elegoo: control de pausar/reanudar/cancelar desde la tarjeta, sin modal de detalle ni jog.

`[CAPTURA PENDIENTE: alta de impresora FlashForge (IP + número de serie + check code)]`

### 6.6 Impresoras Bambu Lab

**Subsección nueva.** Impresoras Bambu Lab en modo LAN (X1 Carbon, X1, X1E, P1P, P1S, A1, A1 mini). El alta pide IP, número de serie, código de acceso y modelo, y hace una verificación real por MQTT antes de confirmar el alta. Mismo patrón de control que Elegoo/FlashForge: pausar/reanudar/cancelar desde la tarjeta, sin modal de detalle.

`[CAPTURA PENDIENTE: alta de impresora Bambu Lab]`

### 6.7 Interfaz en 5 idiomas

**Actualizado.** NOPAL ya no alterna solo entre español e inglés: ahora hay **5 idiomas** — Español, Inglés, Portugués (Brasil), Francés y Alemán — seleccionables desde la pantalla de inicio de sesión, la barra superior o Configuración → General.

**Captura anterior: desactualizada** — mostraba solo el alternador ES/EN.

`[CAPTURA PENDIENTE: selector de idioma con las 5 opciones]`

---

## 7. Consola

Sin cambios de fondo. Envía comandos directamente a cualquier máquina y observa la respuesta en tiempo real, con pestañas por máquina, controles de tamaño de texto, botón para limpiar el historial y caja de comando.

**Captura anterior: probablemente vigente.**

---

## 8. Historial de trabajos

Sin cambios de fondo respecto al manual anterior (secciones "Historial de impresión 3D" e "Historial del láser"): registro de todos los trabajos enviados, agrupado por máquina, con miniatura, estado, nombre de archivo, fecha y duración.

**Captura anterior: probablemente vigente.**

---

## 9. Editor de G-code

**Sección nueva.** Editor de texto en el navegador para archivos G-code, con análisis automático del contenido (útil para revisar o ajustar un archivo sin salir de NOPAL antes de enviarlo a una máquina).

`[CAPTURA PENDIENTE: Editor de G-code]`

---

## 10. Galería de Plugins

**Sección nueva.** Varias funciones que antes venían incluidas en NOPAL ahora son **plugins instalables** desde esta galería (visible solo para administradores). Instalar un plugin hace un `git clone` real del repositorio del plugin; desinstalar borra esa copia; actualizar hace un `git pull` — si el cambio es solo de frontend, la interfaz se recarga sola; si toca el backend, pide reiniciar NOPAL completo (los plugins de backend solo se cargan al arrancar).

Catálogo actual:

| Plugin | Estado | Qué hace |
|---|---|---|
| Cámaras | Disponible | Video en vivo por MJPEG/ONVIF o webcam USB, por máquina |
| Automatización de Taller | Disponible | Placas Arduino/ESP32 con relevadores/LEDs — mapeo de pines y escenas automatizadas para impresora/láser/CNC |
| Cotizador | Disponible | Cálculo de costos y cotizaciones para trabajos 3D/láser/CNC, con exportación a PDF/WhatsApp |
| Creador de formas | Disponible | Rectángulos/círculos/polígonos paramétricos para láser/CNC |
| Herramientas SVG | Disponible | Limpiar, unir y simplificar trazos SVG antes de producción |
| Optimizador G-Code | Próximamente | Optimización de trayectorias |
| Biblioteca de tipografías | Próximamente | Exploración de fuentes y texto a trazo |
| Biblioteca de materiales | Próximamente | Perfiles de material compartidos |

El sistema de plugins de pago (licencias vía servidor propio) está contemplado pero **no implementado todavía** — cualquier plugin marcado como de pago se rechaza al intentar instalarlo.

`[CAPTURA PENDIENTE: Galería de Plugins con el catálogo completo]`
`[CAPTURA PENDIENTE: botón "Actualizar" sobre un plugin con nueva versión disponible]`

---

## 11. Configuración general

**Reestructurado.** Configuración ahora se organiza en 7 tarjetas fijas (antes eran ajustes sueltos numerados 9.1–9.9), más un personalizador propio de la página. Un administrador puede reordenarlas en grupos propios (ver 11.8).

### 11.1 General

Idioma, calidad de vista previa, tamaño de interfaz (100/95/90/85%), modo del panel CNC (Simple/Avanzado), aviso "Confirmar antes de Home", actualización automática, mostrar máquinas sin conexión, alertas de sonido, y el interruptor del **recorrido guiado** (Sección 14).

**Captura anterior: probablemente vigente** para la mayoría de estos campos; falta agregar el modo CNC y el interruptor de recorrido guiado.

### 11.2 Apariencia y UI/UX

Agrupa lo que antes eran varias secciones sueltas (9.3–9.6 del manual anterior): selector de temas y editor de tema personalizado, orden del menú lateral, forma/color del marcador de posición del láser, y el autoocultado de la barra superior.

**Temas disponibles hoy: Light, Dark, "NOPAL Style" (verde, con 3 fondos a elegir) y Red — más un tema Custom que el propio usuario puede crear.** Esto corrige una inconsistencia del manual anterior, que en una sección mencionaba solo 3 temas base (Light/Dark/NOPAL Style) y en otra mostraba 4 (NOPAL/Blanco/Negro/Rojo): son 4 temas predefinidos, más el personalizado.

**Captura anterior: probablemente vigente** para el selector de temas y el editor de tema personalizado (Sección 9.4/9.5 del PDF anterior); confirmar que sigan apareciendo los 4 presets correctos.

### 11.3 Actualizaciones

Sin cambios de fondo: versión instalada, estado, rama/commit actual, botón de revisar/aplicar actualización y bitácora de cambios.

**Captura anterior: probablemente vigente.**

### 11.4 Logs del sistema

**Subsección nueva.** Botón "Ver logs" para consultar el archivo de log de NOPAL (`logs/nopal.log`) sin salir del panel.

`[CAPTURA PENDIENTE: tarjeta "Logs del sistema"]`

### 11.5 Usuarios

**Subsección nueva** (visible solo para administradores). Lista y alta de usuarios, con rol (Operador/Administrador) y reinicio de contraseña.

`[CAPTURA PENDIENTE: tarjeta "Usuarios"]`

### 11.6 Dispositivos

Agrupa la detección de puertos USB, redes WiFi/dispositivos de red, el mapeo de control físico (joystick/gamepad — mismo contenido que la Sección 9.2 del manual anterior), el listado de "Todos los dispositivos", y ahora también las listas de descubrimiento y alta específicas de cada familia nueva: Marlin (puertos USB + descubrimiento MKS WiFi + alta por IP), Elegoo, FlashForge y Bambu Lab (todas por escaneo de red).

**Captura anterior: probablemente vigente** para USB/WiFi/joystick (Secciones 9.2/9.7/9.8 del PDF anterior); falta capturar las listas de alta de Marlin/Elegoo/FlashForge/Bambu.

`[CAPTURA PENDIENTE: tarjeta "Dispositivos" mostrando las listas de alta por marca]`

### 11.7 Accesorios

**Subsección nueva.** Detección y alta de placas Arduino/ESP32 de relevadores/LEDs — alimenta el plugin "Automatización de Taller" (Sección 10). Incluye el flujo de actualización de firmware de la placa (USB o vía OTA), que vive dentro de este mismo plugin.

`[CAPTURA PENDIENTE: tarjeta "Accesorios"]`

### 11.8 Personalizar Página de Configuración

**Subsección nueva.** Botón que abre un editor de arrastrar y soltar para crear grupos propios y reordenar las 7 tarjetas de Configuración entre ellos, con acomodo independiente por tamaño de pantalla y botón de reset. Es un personalizador propio, separado del de "Personalizar Módulos" del modal de impresora (Sección 6.1) y del de Ayuda (Sección 12, que ya no tiene este editor).

`[CAPTURA PENDIENTE: modal "Personalizar Página de Configuración"]`

---

## 12. Centro de Ayuda

**Sección nueva.** Rediseñado como un panel fijo con barra lateral, buscador y contenido por categoría (ya no tiene su propio personalizador de arrastrar y soltar — se probó y se descartó a propósito). Categorías: Inicio/Acerca de, Impresoras 3D, Láser/CNC, Biblioteca (disponibles), y Dispositivos/Red/Automatización/Mantenimiento/Solución de problemas/Preguntas frecuentes (marcadas "Próximamente").

Incluye:
- **Insignia de versión** y enlace al repositorio de GitHub.
- **"Repetir recorrido guiado"** — vuelve a mostrar el tour de bienvenida (Sección 14).
- Para administradores, un botón para **"Agregar impresora (asistente guiado)"** que abre un asistente paso a paso para dar de alta una impresora.
- Un recuadro "¿Necesitas más ayuda?" con enlace al canal de YouTube de NOPAL México.

`[CAPTURA PENDIENTE: Centro de Ayuda — vista general con categorías]`
`[CAPTURA PENDIENTE: asistente guiado para agregar impresora]`

---

## 13. Panel de Control del Sistema

**Sección nueva** (solo administradores, botón en la barra superior). Tres bloques:

- **Control de servicios** — iniciar/detener/reiniciar servicios systemd relacionados (Klipper, Moonraker, Crowsnest), detectados automáticamente.
- **Panel NOPAL** — reiniciar el propio servicio de NOPAL.
- **Control del host** — reiniciar o apagar el servidor completo (el apagado se marca como acción de riesgo).

`[CAPTURA PENDIENTE: modal "Panel de Control del Sistema"]`

---

## 14. Recorrido guiado (onboarding)

**Sección nueva.** Tour guiado tipo "spotlight" que resalta un elemento a la vez con siguiente/anterior/saltar y contador de pasos, disponible en las secciones principales (Panel de Control, Modelos, G-code, Consola, Láser, CNC, Marlin, Historial, Cotizador, Configuración). Se activa solo la primera vez que se entra a cada sección, se puede desactivar por completo desde Configuración → General (Sección 11.1), y se puede volver a ver en cualquier momento desde el Centro de Ayuda (Sección 12).

`[CAPTURA PENDIENTE: paso del recorrido guiado con el spotlight activo]`

---

## Fin del manual

Este manual cubre las catorce secciones actuales de NOPAL: Introducción, Panel de Control, Láser/CNC, G-code y Tarjeta SD, Bibliotecas de archivos, Impresoras 3D, Consola, Historial de trabajos, Editor de G-code, Galería de Plugins, Configuración general, Centro de Ayuda, Panel de Control del Sistema y Recorrido guiado. Sirve como referencia rápida para operar el taller día a día y como guía de resolución de problemas ante errores o desconexiones.

| Última actualización de texto | Versión de NOPAL documentada |
|---|---|
| 23 de julio de 2026 | 1.2.0-alpha.1 (commit d738dc9) |

Si NOPAL se actualiza o cambia el equipo del taller (nuevas impresoras/láseres), conviene volver a capturar las pantallas afectadas para mantener este manual al día. **Pendiente para cerrar esta actualización:** tomar todas las capturas marcadas `[CAPTURA PENDIENTE]` arriba, revisar contra la app real las notas marcadas `[VERIFICAR]` (ninguna en esta pasada, pero revisar si algo cambió entre el 23 de julio y la fecha de captura), y volver a imprimir este documento a PDF para reemplazar `NOPAL_Manual_Usuario.pdf`.
