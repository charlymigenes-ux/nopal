NOPAL — Firmware para LOLIN NodeMCU V3 / ESP8266
================================================

ARCHIVOS
--------
NOPAL_NodeMCU_V3_ESP8266.ino
secrets.h
secrets.h.example

PLACA EN ARDUINO IDE
--------------------
Selecciona:

  Herramientas > Placa:
    NodeMCU 1.0 (ESP-12E Module)

Ajustes recomendados:

  CPU Frequency: 80 MHz
  Flash Size: 4MB (FS:2MB OTA:~1019KB)
  Flash Mode: DIO
  Upload Speed: 115200

Si la carga funciona bien puedes aumentar Upload Speed posteriormente.

BIBLIOTECAS
------------
Instala desde el Administrador de bibliotecas:

  ElegantOTA
  Adafruit NeoPixel

También instala el paquete:
  ESP8266 by ESP8266 Community

CONEXIONES
----------
Relé 1:
  NodeMCU D1 / GPIO5  -> IN1

Relé 2:
  NodeMCU D2 / GPIO4  -> IN2

Relé 3:
  NodeMCU D5 / GPIO14 -> IN3

Relé 4:
  NodeMCU D6 / GPIO12 -> IN4

NeoPixel:
  NodeMCU D7 / GPIO13 -> DIN de la tira
  Fuente 5 V          -> +5V de la tira
  GND común           -> GND de la tira y GND del NodeMCU

LED de estado:
  D4 / GPIO2, integrado en la placa.
  No requiere conexión externa.

Entrada analógica:
  A0 -> sensor analógico.
  El firmware reporta solamente el valor RAW 0-1023.
  Verifica el rango eléctrico de A0 de tu placa antes de conectar un sensor.

ALIMENTACIÓN
------------
No alimentes una tira NeoPixel ni varios relés desde el pin 3V3 del ESP8266.

Usa una fuente de 5 V adecuada para relés y tira LED. Une GND de esa fuente
con GND del NodeMCU.

Para NeoPixel se recomienda:
  - Resistencia de 330 a 470 ohmios en serie con DATA.
  - Capacitor de aproximadamente 1000 uF entre +5 V y GND al inicio de la tira.
  - Conversor de nivel lógico 3.3 V -> 5 V para instalaciones largas o ruidosas.

Los módulos de relé deben aceptar una señal lógica de 3.3 V. No conectes la
bobina de un relé desnudo directamente al ESP8266.

PINES QUE NO DEBES CAMBIAR SIN REVISAR EL ARRANQUE
---------------------------------------------------
D3 / GPIO0 y D8 / GPIO15 participan en la selección del modo de arranque.
El firmware los deja libres.

D4 / GPIO2 también participa en el arranque, pero aquí únicamente controla
el LED integrado de la placa y no se conecta a un relé.

PRIMER ARRANQUE
---------------
1. Abre secrets.h.
2. Coloca el nombre y contraseña de tu Wi-Fi.
3. Cambia la contraseña OTA.
4. Ajusta NOPAL_WS2812_COUNT.
5. Compila y carga por USB.
6. Abre el monitor serial a 115200.

Si no hay credenciales o no conecta:
  SSID: NOPAL-NODEMCU-XXXXXX
  IP:   192.168.4.1

PANEL Y OTA
-----------
Panel:
  http://IP/
  http://nopal-nodemcu.local/

Estado JSON:
  http://IP/api/status

ElegantOTA:
  http://IP/update

El panel, la API de control y ElegantOTA usan el usuario y contraseña de
secrets.h.

COMANDOS NOPAL
--------------
NOPAL:ID?
NOPAL:NET?
NOPAL:STATUS?

NOPAL:R1:ON
NOPAL:R1:OFF
NOPAL:R1:TOGGLE
NOPAL:R1?

NOPAL:WS:255,0,0
NOPAL:WS:PIXEL:1,255,0,0
NOPAL:WS:RANGE:1,4,255,80,0
NOPAL:WS:BRIGHTNESS:96
NOPAL:WS:EFFECT:SOLID
NOPAL:WS:EFFECT:BLINK
NOPAL:WS:EFFECT:BREATHE
NOPAL:WS:EFFECT:CHASE

NOPAL:SCENE:READY
NOPAL:SCENE:WORKING
NOPAL:SCENE:WAITING
NOPAL:SCENE:ALARM
NOPAL:SCENE:MAINTENANCE
NOPAL:SCENE:DISCONNECTED
NOPAL:SCENE:OFF

NOPAL:A0?
NOPAL:HELP?
NOPAL:REBOOT

ESTADOS DEL LED INTEGRADO
-------------------------
Encendido fijo:
  Wi-Fi conectado.

Parpadeo lento:
  Sin Wi-Fi, reconectando o AP de recuperación activo.

Parpadeo rápido:
  Actualización OTA en curso.

SEGURIDAD DE LOS RELÉS
----------------------
Los cuatro relés arrancan apagados y el firmware no restaura estados anteriores.
Esto evita que una máquina, extractor o contacto se active automáticamente
después de un corte eléctrico o reinicio.
