NOPAL SIM800L + Wi-Fi + ElegantOTA
=================================

ARCHIVOS
--------
- NOPAL_SIM800L_OTA.ino
- secrets.h

PLATAFORMA RECOMENDADA
----------------------
ESP32 Dev Module.

En ESP32 quedan habilitadas todas las funciones y el SIM800L usa Serial2:
- SIM800L TX -> ESP32 GPIO32 (RX2)
- SIM800L RX -> ESP32 GPIO33 (TX2)
- GND SIM800L -> GND ESP32

IMPORTANTE: alimenta el SIM800L con una fuente independiente adecuada para el
módulo; no lo alimentes directamente desde el pin 3.3 V del ESP32.

LIBRERÍAS PARA ARDUINO IDE
--------------------------
1. ElegantOTA
2. Adafruit NeoPixel

Las bibliotecas WiFi, WebServer/ESP8266WebServer y mDNS vienen con los cores de
ESP32 o ESP8266.

CONFIGURACIÓN
-------------
1. Abre secrets.h.
2. Cambia:
   - NOPAL_WIFI_SSID
   - NOPAL_WIFI_PASSWORD
   - NOPAL_OTA_USERNAME
   - NOPAL_OTA_PASSWORD
   - NOPAL_AP_PASSWORD
3. En Arduino IDE selecciona una partición que permita OTA.
4. Carga la primera versión por USB.

USO DE ELEGANTOTA
-----------------
Después del arranque revisa el monitor Serial para conocer la IP.

Panel:
- http://IP/
- http://IP/update
- http://nopal-sim800l.local/update

Si el Wi-Fi falla, la placa crea una red:
- SSID: NOPAL-XXXXXX
- Contraseña: la definida en NOPAL_AP_PASSWORD
- IP habitual del AP: 192.168.4.1

COMANDOS NOPAL NUEVOS
---------------------
NOPAL:NET?
NOPAL:SIM:AT
NOPAL:SIM:INFO?
NOPAL:SIM:CSQ?
NOPAL:SIM:CREG?
NOPAL:SIM:CCID?
NOPAL:SIM:IMEI?
NOPAL:SIM:OPERATOR?
NOPAL:SIM:RAW:AT+CPIN?

NOTAS SOBRE ESP8266
-------------------
El firmware sigue compilando para ESP8266 con Wi-Fi, ElegantOTA, relés, PWM y
WS2812, pero SIM800L está desactivado porque el mapa de pines original utiliza
prácticamente todos los GPIO y el puerto Serial principal.
