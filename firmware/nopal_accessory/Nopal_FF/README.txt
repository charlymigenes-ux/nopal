NOPAL — Nopal_FF: accesorio ESP32/ESP8266 con relés, PWM RGB, WS2812 y buzzer
==============================================================================

Este sketch nace de fusionar dos firmwares NOPAL que ya existían por
separado en este repositorio:

  - ../nopal_accessory.ino        (protocolo 4, fw 4.1.0)
  - ../NOPAL_ESP12E_BUZZER.ino    (protocolo 2, fw 2.1.0)

Nopal_FF.ino = nopal_accessory.ino completo (relés, PWM RGB, WS2812 con
color global/individual/segmento, Wi-Fi, ElegantOTA, panel web) más el
subsistema de buzzer activo portado de NOPAL_ESP12E_BUZZER.ino (patrones
no bloqueantes, comandos BUZZER, endpoint HTTP y tarjeta en el panel).

Ninguno de esos dos archivos originales se modificó para hacer este sketch
-- viven intactos en la carpeta de arriba, este es un archivo nuevo.

ARCHIVOS
--------
Nopal_FF.ino          -> sketch, el que se flashea.
secrets.h.example      -> plantilla de credenciales, sí se sube al repo.
secrets.h              -> tus credenciales reales (NO se sube, ver abajo).

PLATAFORMAS SOPORTADAS
-----------------------
- ESP32 (cualquier variante "Dev Module" típica).
- ESP8266 (NodeMCU, Wemos D1 Mini, genéricos).

FUNCIONES
---------
- Animación breve (barrido en verde NOPAL, ~0.6 s) en la tira WS2812 al
  arrancar la placa -- corre una sola vez en setup(), no demora Wi-Fi/HTTP
  y no interfiere con el color real que le pidas a la tira después.
- Hasta 4 relés (NOPAL:R1..R4).
- Tira RGB analógica por PWM (NOPAL:LED:r,g,b).
- Tira WS2812/NeoPixel: color global (NOPAL:WS:r,g,b) y por segmento
  (NOPAL:WSSEG:inicio,cantidad,r,g,b).
- Buzzer activo con patrones no bloqueantes (NOPAL:BUZZER?/BUZZER:<patrón>).
- Wi-Fi en modo estación con reconexión automática.
- Punto de acceso de recuperación (NOPAL-XXXXXX) si no hay credenciales
  configuradas o falla la conexión al Wi-Fi de casa/taller.
- ElegantOTA protegido con usuario/contraseña.
- Panel web NOPAL embebido en http://IP/ con tarjetas de relés, escenas
  rápidas, NeoPixel global/individual, PWM RGB y buzzer.
- mDNS: http://<hostname>.local/

MAPA DE PINES
-------------

ESP32 (Dev Module típico):
  Relé 1..4    -> GPIO16, 17, 18, 19
  PWM RGB      -> GPIO25 (R), GPIO26 (G), GPIO27 (B)
  WS2812       -> GPIO23
  LED de estado (integrado) -> GPIO2, activo en HIGH
  Buzzer       -> GPIO4

  GPIO4 no lo usa ningún relé/PWM/WS2812/LED de estado en este mapeo, y no
  es uno de los pines de strapping del ESP32 (GPIO0, GPIO2, GPIO5, GPIO12,
  GPIO15) -- salida digital simple y segura.

ESP8266 (NodeMCU / Wemos D1 Mini):
  Relé 1  -> D1 / GPIO5
  Relé 2  -> D2 / GPIO4
  Relé 3  -> D5 / GPIO14
  Relé 4  -> D6 / GPIO12
  PWM RGB -> D7/GPIO13 (R), D8/GPIO15 (G), D3/GPIO0 (B, sin cablear)
  WS2812  -> D4 / GPIO2
  Buzzer  -> D0 / GPIO16

  Confirmado en hardware real: con el buzzer en D3/GPIO0 (participa en la
  selección del modo de arranque del ESP8266) la placa arrancaba
  intermitente. Se reubicó a GPIO16/D0, que no tiene rol en el arranque,
  intercambiándolo con el canal B del PWM RGB (sin cablear en esta placa,
  solo se usa la tira WS2812) -- si nada físico tira del GPIO0 en el
  reset, se queda en su pull-up interno y arranca normal. Si en algún
  momento cableas un LED RGB analógico de verdad, cambiá PWM_LED_PIN_B a
  otro GPIO antes de conectarlo (ver el comentario junto a BUZZER_PIN en
  la sección "CONFIGURACIÓN DE PINES" del .ino).

  Sin LED de estado integrado en ESP8266: GPIO2/D4 ya lo usa WS2812.

  No uses A0 para el buzzer: es una entrada analógica, no puede manejar
  una salida digital.

LIBRERÍAS PARA ARDUINO IDE
---------------------------
1. ElegantOTA         (Ayush Sharma — ayushsharma82/ElegantOTA)
2. Adafruit NeoPixel

Wi-Fi, WebServer/ESP8266WebServer y mDNS ya vienen incluidas con los cores
de ESP32 / ESP8266 -- no hace falta instalarlas aparte.

CONFIGURACIÓN
--------------
1. Copia secrets.h.example a secrets.h (mismo directorio).
2. Abre secrets.h y cambia:
   - NOPAL_WIFI_SSID / NOPAL_WIFI_PASSWORD
   - NOPAL_HOSTNAME
   - NOPAL_OTA_USERNAME / NOPAL_OTA_PASSWORD
   - NOPAL_AP_PASSWORD
   - (opcional) NOPAL_RELAY1_NAME..NOPAL_RELAY4_NAME
   - (opcional) NOPAL_RELAY_ACTIVE_LOW
   - (opcional) NOPAL_BUZZER_ACTIVE_HIGH, NOPAL_BUZZER_SCENE_SOUNDS
3. Si tu buzzer es pasivo o se activa en LOW en vez de en HIGH, ajusta
   NOPAL_BUZZER_ACTIVE_HIGH=0 en secrets.h.
3b. Si al prender un relé desde NOPAL el estado físico real queda al
    revés del que reporta el panel/`/api/status` (pasa con algunos
    módulos de relé pensados para ESP32/NodeMCU, que se activan con
    HIGH en vez de LOW), ajusta NOPAL_RELAY_ACTIVE_LOW=0 en secrets.h.
    Por defecto vale 1 (se activa con LOW), lo más común.
4. Revisa/ajusta los pines de RELAY_PINS / PWM_LED_PIN_* / WS2812_PIN /
   BUZZER_PIN dentro de Nopal_FF.ino según tu cableado real.
5. Carga la primera versión por USB (Sketch -> Subir).

Después puedes actualizar por ElegantOTA (ver abajo) o por USB desde el
panel de NOPAL.

USO DE ELEGANTOTA (actualización por red)
-------------------------------------------
Panel:
- http://IP/           -> panel web NOPAL (relés, escenas, NeoPixel, PWM
                            RGB y buzzer) -- pide usuario/clave, trae un
                            botón adentro para ir a /update
- http://IP/update      -> panel de ElegantOTA (pide usuario/clave)
- http://IP/api/status  -> estado en JSON (wifi/ota/io/relays/buzzer), sin auth
- http://<hostname>.local/  (si tu red soporta mDNS)

Si el Wi-Fi falla, la placa levanta su propia red:
- SSID: NOPAL-XXXXXX
- Contraseña: la definida en NOPAL_AP_PASSWORD
- IP habitual del punto de acceso: 192.168.4.1

COMANDOS NOPAL (USB, 115200 baud)
------------------------------------
NOPAL:ID?
NOPAL:NET?
NOPAL:R1:ON
NOPAL:R1:OFF
NOPAL:R1?
NOPAL:LED:255,0,0
NOPAL:WS:0,255,0
NOPAL:WSSEG:0,4,255,80,0
NOPAL:BUZZER?
NOPAL:BUZZER:BEEP
NOPAL:BUZZER:DOUBLE
NOPAL:BUZZER:ON
NOPAL:BUZZER:OFF
NOPAL:BUZZER:ALARM
NOPAL:BUZZER:READY
NOPAL:BUZZER:WORKING
NOPAL:BUZZER:WAITING
NOPAL:BUZZER:MAINTENANCE
NOPAL:BUZZER:DISCONNECTED

ESCENAS RÁPIDAS Y BUZZER
-------------------------
Las "Escenas rápidas" del panel web (Listo/Trabajando/En espera/
Alarma/Mantenimiento/Desconectado/Apagar) siguen aplicando un color fijo
a la tira WS2812 -- este firmware no trae el motor de efectos animados
(parpadeo/respirar/carrera) de NOPAL_ESP12E_BUZZER.ino, eso NO se portó a
propósito.

Lo que SÍ se conserva es que elegir una escena también hace sonar el
patrón de buzzer que le corresponde (mismo comportamiento que
applyScene() tenía en NOPAL_ESP12E_BUZZER.ino), salvo que definas
NOPAL_BUZZER_SCENE_SOUNDS 0 en secrets.h para desactivar ese
acompañamiento sonoro.

SEGURIDAD
---------
Los cuatro relés y el buzzer arrancan siempre apagados; el firmware no
restaura estados anteriores. Todos los endpoints que cambian algo de la
placa (/api/relay, /api/led, /api/buzzer, /update) piden el usuario y
contraseña de secrets.h. /api/status y /health son de solo lectura y no
piden autenticación.
