NOPAL — Firmware de accesorios (relés / RGB / WS2812 + Wi-Fi + ElegantOTA)
===========================================================================

ARCHIVOS
--------
- nopal_accessory.ino     -> sketch principal, el que usa el backend de NOPAL.
- secrets.h.example       -> plantilla de credenciales, sí se sube al repo.
- secrets.h               -> tus credenciales reales (NO se sube, ver abajo).
- builds/                 -> binarios .bin ya compilados, listos para
                              flashear desde el panel de NOPAL (ver sección
                              "FLASHEO DESDE NOPAL" más abajo).

PLATAFORMAS SOPORTADAS
-----------------------
- ESP32 (cualquier variante "Dev Module" típica).
- ESP8266 (NodeMCU, Wemos D1 Mini, genéricos).

FUNCIONES
---------
- Hasta 4 relés (NOPAL:R1..R4).
- Tira RGB analógica por PWM (NOPAL:LED:r,g,b).
- Tira WS2812 / NeoPixel (NOPAL:WS:r,g,b).
- Wi-Fi en modo estación con reconexión automática.
- Punto de acceso de recuperación (NOPAL-XXXXXX) si no hay credenciales
  configuradas o si falla la conexión al Wi-Fi de casa/taller.
- ElegantOTA: actualizar el firmware por red sin desconectar la placa,
  protegido con usuario/contraseña.
- Panel web NOPAL embebido en http://IP/ (relés con nombre y GPIO, NeoPixel
  global/individual, RGB PWM y estado del dispositivo) -- misma pinta que
  el panel de NOPAL_ESP12E.ino, adaptado a las rutas reales de este .ino.
- mDNS: http://<hostname>.local/
- NOPAL:ID? incluye ahora datos de red (wifi, ip, hostname, ota) además de
  los relés/PWM/WS2812 y la telemetría (uptime_ms, free_heap) que ya
  reportaba.
- Comando nuevo: NOPAL:NET? (estado detallado de la conexión).

LIBRERÍAS PARA ARDUINO IDE
---------------------------
1. ElegantOTA         (Ayush Sharma — ayushsharma82/ElegantOTA)
2. Adafruit NeoPixel
3. NimBLE-Arduino     (h2zero/NimBLE-Arduino -- solo hace falta si vas a
                        usar la pantalla LED BLE, ver más abajo. La BLE
                        integrada del core (Bluedroid) NO se usa a
                        propósito: agrega ~500-700KB al binario y no entra
                        en el esquema de particiones por defecto -- NimBLE
                        ocupa más o menos la mitad)

Wi-Fi, WebServer/ESP8266WebServer y mDNS ya vienen incluidas con los cores
de ESP32 / ESP8266 — no hace falta instalarlas aparte.

CONFIGURACIÓN
--------------
1. Copia secrets.h.example a secrets.h (mismo directorio).
2. Abre secrets.h y cambia:
   - NOPAL_WIFI_SSID
   - NOPAL_WIFI_PASSWORD
   - NOPAL_HOSTNAME       (opcional)
   - NOPAL_OTA_USERNAME
   - NOPAL_OTA_PASSWORD
   - NOPAL_AP_PASSWORD
3. Ajusta los pines de RELAY_PINS / PWM_LED_PIN_* / WS2812_PIN dentro de
   nopal_accessory.ino según tu cableado real.
4. Carga la primera versión por USB (Sketch -> Subir).

Si algún día quieres actualizar el firmware SIN cable, usa ElegantOTA (ver
abajo) o el flasheo por USB desde el panel de NOPAL (ver "FLASHEO DESDE
NOPAL").

USO DE ELEGANTOTA (actualización por red)
-------------------------------------------
Después del arranque revisa el monitor Serial para conocer la IP asignada
(o el comando NOPAL:NET? por USB).

Panel:
- http://IP/           -> panel web NOPAL (relés, NeoPixel, PWM RGB y
                            estado del dispositivo) -- pide usuario/clave,
                            trae un botón adentro para ir a /update
- http://IP/update      -> panel de ElegantOTA (pide usuario/clave)
- http://IP/api/status  -> estado en JSON (wifi/ota/io/relays), sin auth
- http://<hostname>.local/  (si tu red soporta mDNS)

Si el Wi-Fi falla, la placa levanta su propia red:
- SSID: NOPAL-XXXXXX
- Contraseña: la definida en NOPAL_AP_PASSWORD
- IP habitual del punto de acceso: 192.168.4.1

FLASHEO DESDE NOPAL (backend)
-------------------------------
NOPAL nunca compila el sketch (no hay arduino-cli/platformio instalado en
el servidor). Lo que sí puede hacer es escribir un binario YA COMPILADO:

1. En Arduino IDE: Sketch -> Export Compiled Binary. Esto genera un .bin
   FUSIONADO (bootloader + partición + app en un solo archivo), pensado
   para flashearse completo en el offset 0x0.
2. Sube ese .bin desde el panel de accesorios de NOPAL (se guarda en
   builds/, junto a este README).
3. Desde ahí puedes flashear:
   - Por USB (esptool, offset 0x0) — la placa tiene que estar conectada
     al mismo equipo donde corre NOPAL.
   - Por OTA (ElegantOTA) — si la placa ya tiene una versión anterior de
     este firmware corriendo con Wi-Fi conectado.

COMANDOS NOPAL (USB, 115200 baud)
------------------------------------
NOPAL:ID?
NOPAL:NET?
NOPAL:R1:ON
NOPAL:R1:OFF
NOPAL:R1?
NOPAL:LED:255,0,0
NOPAL:WS:0,255,0
NOPAL:BLE:STATUS?   (solo ESP32, ver sección "PANTALLA LED BLE" abajo)

PANTALLA LED BLE (relay, solo ESP32)
--------------------------------------
Este .ino puede hacer de puente entre NOPAL y una pantalla LED tipo
"iPixel Color" / iDotMatrix que se controla por Bluetooth Low Energy. La
placa NO entiende el protocolo de la pantalla (fuentes, bitmaps, CRC32) --
eso lo arma NOPAL en Python con la librería pypixelcolor y se lo manda ya
listo por HTTP; la placa solo reenvía esos bytes por BLE y confirma si el
dispositivo los recibió.

Requisitos:
- Placa ESP32 (el ESP8266 no tiene Bluetooth, esta función queda
  desactivada sola en esa plataforma).
- Librería NimBLE-Arduino instalada (ver "LIBRERÍAS PARA ARDUINO IDE" más
  arriba) -- si al compilar da "text section exceeds available space in
  board" / "Sketch too big", falta esta librería o el sketch está usando
  la BLE integrada del core por error.
- La MAC de la pantalla, configurada en secrets.h como
  NOPAL_BLE_SCREEN_MAC. Se obtiene con la app iPixel Color o con un
  escáner BLE genérico (nRF Connect, LightBlue, etc.) -- este firmware
  deliberadamente NO escanea por BLE, solo se conecta directo a una MAC ya
  conocida (la API de escaneo cambia de forma incompatible entre versiones
  del core de ESP32, así que se evitó a propósito).

Endpoints nuevos:
- GET  /api/ble/status  -> {"configured":bool,"connected":bool}, sin auth.
- POST /api/ble/window  -> mismas credenciales que /api/relay. Cuerpo:
  texto hexadecimal con los bytes de una "ventana" del protocolo de la
  pantalla (se manda en hex, no binario, para no arriesgar que un byte
  0x00 corte el cuerpo del POST). Responde "OK" si la pantalla confirmó
  por BLE, o un ERR:* si no.

Comando Serial nuevo: NOPAL:BLE:STATUS?

Wi-Fi y BLE conviven en el mismo ESP32 sin configuración extra (el propio
chip intercala el uso de la radio 2.4GHz entre ambos), pero con contención
esperable si se usan las dos funciones muy intensamente al mismo tiempo --
no es un problema para mandar mensajes de texto cortos ocasionales.

VARIANTE EXPERIMENTAL: SIM800L
--------------------------------
Existe un sketch aparte, NOPAL_SIM800L_OTA.ino, que agrega un puente de
comandos AT para un módem celular SIM800L (útil si quieres un accesorio
con conectividad celular en vez de Wi-Fi/USB). Es una variante experimental
que el usuario armó por su cuenta: NO es lo que usa el backend de NOPAL, no
se instala ni se documenta acá más allá de esta nota. Si te interesa, el
archivo trae su propio encabezado con el detalle de pines y comandos
NOPAL:SIM:*.
