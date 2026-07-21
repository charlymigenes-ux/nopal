/*
 * NOPAL — Firmware genérico de accesorios
 *
 * Compatible con:
 *   - ESP8266
 *   - ESP32
 *
 * Funciones:
 *   - Relés
 *   - Tira RGB analógica por PWM
 *   - Tira WS2812 / NeoPixel
 *   - Wi-Fi STA con reconexión automática
 *   - Punto de acceso de recuperación si falla el Wi-Fi
 *   - ElegantOTA (actualización de firmware por red) con autenticación
 *   - mDNS (http://<hostname>.local/)
 *
 * Comunicación NOPAL (USB):
 *   Serial a 115200 baudios
 *   Un comando por línea terminado en \n
 *
 * Comandos:
 *   NOPAL:ID?
 *   NOPAL:NET?
 *   NOPAL:R1:ON
 *   NOPAL:R1:OFF
 *   NOPAL:R1?
 *   NOPAL:LED:255,0,0
 *   NOPAL:WS:0,255,0
 *
 * Respuesta de NOPAL:ID? (v1.4):
 *   NOPAL,role=accessory,chip=...,fw=1.4,relays=4,pwm_led=1,ws2812=1,
 *   ws2812_count=30,wifi=1,wifi_connected=...,wifi_mode=...,hostname=...,
 *   ip=...,ota=1,ota_path=/update,uptime_ms=...,free_heap=...
 *
 * Portal web (cuando hay Wi-Fi):
 *   http://IP/             -> redirige a /update
 *   http://IP/api/status   -> estado en JSON
 *   http://IP/update       -> panel de ElegantOTA (usuario/clave de secrets.h)
 *   http://IP/api/relay    -> control de relés por HTTP (nuevo en 1.4,
 *                              GET ?n=1 consulta, POST n=1&on=true/false
 *                              cambia -- requiere las mismas credenciales
 *                              que ElegantOTA)
 *   http://IP/api/led      -> control de color por HTTP (nuevo en 1.4,
 *                              POST mode=pwm|ws2812&r=..&g=..&b=.. --
 *                              misma autenticación)
 *
 * Antes de compilar copia secrets.h.example a secrets.h y pon tus propios
 * datos (ver README.txt de esta carpeta).
 */

#include <Arduino.h>
#include "secrets.h"

#if defined(ESP32)
  #include <WiFi.h>
  #include <WiFiClient.h>
  #include <WebServer.h>
  #include <ESPmDNS.h>
  #include <esp_arduino_version.h>
#elif defined(ESP8266)
  #include <ESP8266WiFi.h>
  #include <WiFiClient.h>
  #include <ESP8266WebServer.h>
  #include <ESP8266mDNS.h>
#else
  #error "Este firmware solamente es compatible con ESP32 o ESP8266."
#endif

#include <ElegantOTA.h>


// ============================================================================
// CONFIGURACIÓN GENERAL
// ============================================================================

#define FW_VERSION "1.4"

// La mayoría de módulos de relés se activan con LOW.
const bool RELAY_ACTIVE_LOW = true;

const uint32_t WIFI_CONNECT_TIMEOUT_MS = 15000;
const uint32_t WIFI_RECONNECT_INTERVAL_MS = 15000;

const uint16_t HTTP_PORT = 80;


// ============================================================================
// CONFIGURACIÓN DE PINES
// ============================================================================
//
// Los ESP32 y ESP8266 no tienen la misma cantidad ni numeración de GPIO.
// Por eso se utiliza una configuración distinta para cada plataforma.
//
// IMPORTANTE:
// Ajusta estos pines según tu placa y tu cableado.
//

#if defined(ESP32)

// --------------------------------------------------------------------------
// ESP32
// --------------------------------------------------------------------------

#define RELAY_COUNT 4

const uint8_t RELAY_PINS[RELAY_COUNT] = {
  16,
  17,
  18,
  19
};

#define PWM_LED_ENABLE true

#define PWM_LED_PIN_R 25
#define PWM_LED_PIN_G 26
#define PWM_LED_PIN_B 27

#define WS2812_ENABLE true
#define WS2812_PIN 4
#define WS2812_COUNT 30

// LED integrado de la placa ("Dev Module" típico) -- indica que el
// firmware está vivo. GPIO2 está libre en este mapeo de pines (no lo usa
// ningún relé/PWM/WS2812), a diferencia de ESP8266 (ver abajo).
#define STATUS_LED_ENABLE true
#define STATUS_LED_PIN 2
#define STATUS_LED_ACTIVE_LOW false


#elif defined(ESP8266)

// --------------------------------------------------------------------------
// ESP8266 / NodeMCU / Wemos D1 Mini
// --------------------------------------------------------------------------
//
// Correspondencias habituales:
//
// D1 = GPIO5
// D2 = GPIO4
// D5 = GPIO14
// D6 = GPIO12
// D7 = GPIO13
// D8 = GPIO15
// D0 = GPIO16
// D4 = GPIO2
//
// No uses los nombres D1, D2, etc. si deseas compatibilidad con placas
// genéricas. Los GPIO numéricos son más universales.
//

#define RELAY_COUNT 4

const uint8_t RELAY_PINS[RELAY_COUNT] = {
  5,   // D1
  4,   // D2
  14,  // D5
  12   // D6
};

#define PWM_LED_ENABLE true

#define PWM_LED_PIN_R 13  // D7
#define PWM_LED_PIN_G 15  // D8
#define PWM_LED_PIN_B 16  // D0

#define WS2812_ENABLE true
#define WS2812_PIN 2      // D4
#define WS2812_COUNT 30

// GPIO2 (D4), el LED integrado habitual de las NodeMCU/Wemos, ya lo usa
// WS2812_PIN en este mapeo -- no queda un pin libre y seguro para un LED
// de estado dedicado sin arriesgar un conflicto con la tira WS2812. Sin
// LED de estado en ESP8266 por ahora (ver STATUS_LED_ENABLE en ESP32).
#define STATUS_LED_ENABLE false

#endif


// ============================================================================
// CONFIGURACIÓN WS2812
// ============================================================================

#if WS2812_ENABLE

#include <Adafruit_NeoPixel.h>

Adafruit_NeoPixel strip(
  WS2812_COUNT,
  WS2812_PIN,
  NEO_GRB + NEO_KHZ800
);

#endif


// ============================================================================
// SERVIDOR WEB / OTA
// ============================================================================

#if defined(ESP32)
  WebServer server(HTTP_PORT);
#elif defined(ESP8266)
  ESP8266WebServer server(HTTP_PORT);
#endif

bool webServerStarted = false;
bool mdnsStarted = false;
bool recoveryApActive = false;
bool wifiWasConnected = false;

uint32_t lastWifiReconnectAttemptMs = 0;

String recoveryApSsid;


// ============================================================================
// VARIABLES
// ============================================================================

String inputLine;


// En ESP32 Core 2.x, ledcWrite() utiliza el canal.
// En ESP32 Core 3.x, ledcWrite() utiliza directamente el pin.

#if defined(ESP32) && ESP_ARDUINO_VERSION_MAJOR < 3

const uint8_t PWM_CHANNEL_R = 0;
const uint8_t PWM_CHANNEL_G = 1;
const uint8_t PWM_CHANNEL_B = 2;

#endif


// ============================================================================
// FUNCIONES AUXILIARES
// ============================================================================

uint8_t clampColor(int value) {
  if (value < 0) {
    return 0;
  }

  if (value > 255) {
    return 255;
  }

  return static_cast<uint8_t>(value);
}


bool validRelayIndex(int index) {
  return index >= 0 && index < RELAY_COUNT;
}


// ============================================================================
// LED DE ESTADO
// ============================================================================
//
// Fijo encendido en cuanto la placa termina de arrancar (USB, WiFi o
// ambos) -- indica "el firmware está vivo", nunca se apaga en operación
// normal. Parpadea solo mientras hay wifi configurado y NO está
// conectado (reconectando/AP de recuperación tras perder la red) -- ver
// serviceStatusLed(), llamada en cada vuelta de serviceNetwork().

#if STATUS_LED_ENABLE

void setStatusLed(bool on) {
  digitalWrite(
    STATUS_LED_PIN,
    (on != STATUS_LED_ACTIVE_LOW) ? HIGH : LOW
  );
}

void serviceStatusLed() {
  static uint32_t lastToggleMs = 0;
  static bool ledOn = true;

  const bool steady =
    WiFi.status() == WL_CONNECTED ||
    !wifiCredentialsConfigured();

  if (steady) {
    if (!ledOn) {
      ledOn = true;
      setStatusLed(true);
    }
    return;
  }

  const uint32_t now = millis();

  if (now - lastToggleMs >= 300) {
    lastToggleMs = now;
    ledOn = !ledOn;
    setStatusLed(ledOn);
  }
}

#endif


void printChipIdentification() {

#if defined(ESP32)

  Serial.print(ESP.getChipModel());

#elif defined(ESP8266)

  Serial.print("ESP8266-");
  Serial.print(ESP.getChipId(), HEX);

#endif
}


String chipSuffix() {
  char suffix[9] = {0};

#if defined(ESP32)

  const uint32_t chipId =
    static_cast<uint32_t>(ESP.getEfuseMac() & 0xFFFFFFULL);

  snprintf(suffix, sizeof(suffix), "%06lX", static_cast<unsigned long>(chipId));

#elif defined(ESP8266)

  snprintf(
    suffix,
    sizeof(suffix),
    "%06lX",
    static_cast<unsigned long>(ESP.getChipId())
  );

#endif

  return String(suffix);
}


bool wifiCredentialsConfigured() {
  const String ssid = String(NOPAL_WIFI_SSID);

  // "TU_RED_WIFI" es el valor de ejemplo en secrets.h.example: si nadie lo
  // cambió, no tiene caso intentar conectarse, mejor ir directo al punto de
  // acceso de recuperación.
  return ssid.length() > 0 &&
         ssid != "TU_RED_WIFI";
}


String activeIpAddress() {
  if (WiFi.status() == WL_CONNECTED) {
    return WiFi.localIP().toString();
  }

  if (recoveryApActive) {
    return WiFi.softAPIP().toString();
  }

  return "0.0.0.0";
}


String wifiModeText() {
  if (WiFi.status() == WL_CONNECTED && recoveryApActive) {
    return "sta+ap";
  }

  if (WiFi.status() == WL_CONNECTED) {
    return "sta";
  }

  if (recoveryApActive) {
    return "ap";
  }

  return "offline";
}


String jsonEscape(const String& input) {
  String output;
  output.reserve(input.length() + 16);

  for (size_t index = 0; index < input.length(); index++) {
    const char character = input.charAt(index);

    switch (character) {
      case '\\':
        output += "\\\\";
        break;

      case '"':
        output += "\\\"";
        break;

      case '\n':
        output += "\\n";
        break;

      case '\r':
        output += "\\r";
        break;

      case '\t':
        output += "\\t";
        break;

      default:
        output += character;
        break;
    }
  }

  return output;
}


// ============================================================================
// RELÉS
// ============================================================================

void setRelay(uint8_t index, bool on) {
  if (index >= RELAY_COUNT) {
    return;
  }

  const bool outputLevel = RELAY_ACTIVE_LOW ? !on : on;

  digitalWrite(
    RELAY_PINS[index],
    outputLevel ? HIGH : LOW
  );
}


bool getRelay(uint8_t index) {
  if (index >= RELAY_COUNT) {
    return false;
  }

  const bool pinIsHigh =
    digitalRead(RELAY_PINS[index]) == HIGH;

  return RELAY_ACTIVE_LOW
    ? !pinIsHigh
    : pinIsHigh;
}


// ============================================================================
// PWM RGB
// ============================================================================

void setupPwmLed() {

#if PWM_LED_ENABLE

  pinMode(PWM_LED_PIN_R, OUTPUT);
  pinMode(PWM_LED_PIN_G, OUTPUT);
  pinMode(PWM_LED_PIN_B, OUTPUT);

  #if defined(ESP32)

    #if ESP_ARDUINO_VERSION_MAJOR >= 3

      // Arduino-ESP32 Core 3.x
      ledcAttach(PWM_LED_PIN_R, 5000, 8);
      ledcAttach(PWM_LED_PIN_G, 5000, 8);
      ledcAttach(PWM_LED_PIN_B, 5000, 8);

    #else

      // Arduino-ESP32 Core 2.x
      ledcSetup(PWM_CHANNEL_R, 5000, 8);
      ledcSetup(PWM_CHANNEL_G, 5000, 8);
      ledcSetup(PWM_CHANNEL_B, 5000, 8);

      ledcAttachPin(PWM_LED_PIN_R, PWM_CHANNEL_R);
      ledcAttachPin(PWM_LED_PIN_G, PWM_CHANNEL_G);
      ledcAttachPin(PWM_LED_PIN_B, PWM_CHANNEL_B);

    #endif

  #elif defined(ESP8266)

    // El ESP8266 utiliza PWM por software.
    analogWriteRange(255);
    analogWriteFreq(5000);

  #endif

#endif
}


void setPwmLedColor(uint8_t red, uint8_t green, uint8_t blue) {

#if PWM_LED_ENABLE

  #if defined(ESP32)

    #if ESP_ARDUINO_VERSION_MAJOR >= 3

      ledcWrite(PWM_LED_PIN_R, red);
      ledcWrite(PWM_LED_PIN_G, green);
      ledcWrite(PWM_LED_PIN_B, blue);

    #else

      ledcWrite(PWM_CHANNEL_R, red);
      ledcWrite(PWM_CHANNEL_G, green);
      ledcWrite(PWM_CHANNEL_B, blue);

    #endif

  #elif defined(ESP8266)

    analogWrite(PWM_LED_PIN_R, red);
    analogWrite(PWM_LED_PIN_G, green);
    analogWrite(PWM_LED_PIN_B, blue);

  #endif

#endif
}


// ============================================================================
// WS2812
// ============================================================================

void setWs2812Color(uint8_t red, uint8_t green, uint8_t blue) {

#if WS2812_ENABLE

  strip.fill(
    strip.Color(red, green, blue)
  );

  strip.show();

#endif
}


// ============================================================================
// WI-FI
// ============================================================================

void setWifiHostname() {

#if defined(ESP32)

  // Debe llamarse antes de iniciar Wi-Fi.
  WiFi.setHostname(NOPAL_HOSTNAME);

#elif defined(ESP8266)

  WiFi.hostname(NOPAL_HOSTNAME);

#endif
}


void startRecoveryAccessPoint() {
  if (recoveryApActive) {
    return;
  }

  recoveryApSsid = String("NOPAL-") + chipSuffix();

  WiFi.mode(WIFI_AP_STA);

  const size_t passwordLength = strlen(NOPAL_AP_PASSWORD);

  bool started = false;

  if (passwordLength >= 8) {
    started = WiFi.softAP(
      recoveryApSsid.c_str(),
      NOPAL_AP_PASSWORD
    );
  } else {
    Serial.println("WARN:AP_PASSWORD_TOO_SHORT_STARTING_OPEN_AP");
    started = WiFi.softAP(recoveryApSsid.c_str());
  }

  recoveryApActive = started;

  if (started) {
    Serial.print("NOPAL:AP_READY,ssid=");
    Serial.print(recoveryApSsid);
    Serial.print(",ip=");
    Serial.println(WiFi.softAPIP());
  } else {
    Serial.println("ERR:AP_START_FAILED");
  }
}


void startMdnsIfPossible() {
  if (mdnsStarted || WiFi.status() != WL_CONNECTED) {
    return;
  }

  if (MDNS.begin(NOPAL_HOSTNAME)) {
    MDNS.addService("http", "tcp", HTTP_PORT);
    mdnsStarted = true;

    Serial.print("NOPAL:MDNS_READY,http://");
    Serial.print(NOPAL_HOSTNAME);
    Serial.println(".local/");
  } else {
    Serial.println("WARN:MDNS_START_FAILED");
  }
}


void setupWifi() {
  setWifiHostname();

  if (!wifiCredentialsConfigured()) {
    Serial.println("WARN:WIFI_CREDENTIALS_NOT_CONFIGURED");
    startRecoveryAccessPoint();
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);

  Serial.print("NOPAL:WIFI_CONNECTING,ssid=");
  Serial.println(NOPAL_WIFI_SSID);

  WiFi.begin(
    NOPAL_WIFI_SSID,
    NOPAL_WIFI_PASSWORD
  );

  const uint32_t startedAt = millis();

  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - startedAt < WIFI_CONNECT_TIMEOUT_MS
  ) {
    delay(100);

#if defined(ESP8266)
    yield();
#endif
  }

  if (WiFi.status() == WL_CONNECTED) {
    wifiWasConnected = true;

    Serial.print("NOPAL:WIFI_READY,ssid=");
    Serial.print(WiFi.SSID());
    Serial.print(",ip=");
    Serial.print(WiFi.localIP());
    Serial.print(",rssi=");
    Serial.println(WiFi.RSSI());

    startMdnsIfPossible();
    return;
  }

  Serial.println("WARN:WIFI_CONNECTION_TIMEOUT");
  startRecoveryAccessPoint();
}


void maintainWifiConnection() {
  const bool connected = WiFi.status() == WL_CONNECTED;

  if (connected) {
    if (!wifiWasConnected) {
      wifiWasConnected = true;

      Serial.print("NOPAL:WIFI_RECONNECTED,ip=");
      Serial.println(WiFi.localIP());
    }

    startMdnsIfPossible();
    return;
  }

  if (wifiWasConnected) {
    wifiWasConnected = false;
    Serial.println("WARN:WIFI_DISCONNECTED");
  }

  if (!wifiCredentialsConfigured()) {
    if (!recoveryApActive) {
      startRecoveryAccessPoint();
    }

    return;
  }

  const uint32_t now = millis();

  if (
    now - lastWifiReconnectAttemptMs <
    WIFI_RECONNECT_INTERVAL_MS
  ) {
    return;
  }

  lastWifiReconnectAttemptMs = now;

  if (!recoveryApActive) {
    startRecoveryAccessPoint();
  }

  Serial.println("NOPAL:WIFI_RECONNECTING");

  WiFi.begin(
    NOPAL_WIFI_SSID,
    NOPAL_WIFI_PASSWORD
  );
}


// ============================================================================
// SERVIDOR WEB Y ELEGANTOTA
// ============================================================================

String buildStatusJson() {
  String json;
  json.reserve(512);

  json += "{";
  json += "\"role\":\"accessory\",";

  json += "\"firmware\":\"";
  json += FW_VERSION;
  json += "\",";

  json += "\"hostname\":\"";
  json += jsonEscape(String(NOPAL_HOSTNAME));
  json += "\",";

  json += "\"uptime_ms\":";
  json += String(millis());
  json += ",";

  json += "\"free_heap\":";
  json += String(ESP.getFreeHeap());
  json += ",";

  json += "\"wifi\":{";
  json += "\"connected\":";
  json += WiFi.status() == WL_CONNECTED ? "true" : "false";
  json += ",";

  json += "\"mode\":\"";
  json += wifiModeText();
  json += "\",";

  json += "\"ssid\":\"";
  json += WiFi.status() == WL_CONNECTED
    ? jsonEscape(WiFi.SSID())
    : "";
  json += "\",";

  json += "\"ip\":\"";
  json += activeIpAddress();
  json += "\",";

  json += "\"rssi\":";
  json += WiFi.status() == WL_CONNECTED
    ? String(WiFi.RSSI())
    : String(0);
  json += ",";

  json += "\"recovery_ap\":";
  json += recoveryApActive ? "true" : "false";
  json += ",";

  json += "\"recovery_ssid\":\"";
  json += recoveryApActive
    ? jsonEscape(recoveryApSsid)
    : "";
  json += "\"";
  json += "},";

  json += "\"ota\":{";
  json += "\"enabled\":true,";
  json += "\"path\":\"/update\"";
  json += "},";

  json += "\"io\":{";
  json += "\"relays\":";
  json += String(RELAY_COUNT);
  json += ",";
  json += "\"pwm_led\":";
  json += PWM_LED_ENABLE ? "true" : "false";
  json += ",";
  json += "\"ws2812\":";
  json += WS2812_ENABLE ? "true" : "false";
  json += ",";
  json += "\"ws2812_count\":";
  json += String(WS2812_ENABLE ? WS2812_COUNT : 0);
  json += "}";

  json += "}";

  return json;
}


// Protege los endpoints de control (relé/LED) con las mismas credenciales
// que ya usa ElegantOTA (NOPAL_OTA_USERNAME/PASSWORD) -- son las que el
// usuario ya tiene que configurar en secrets.h y las mismas que NOPAL le
// pide al registrar un accesorio por WiFi, no hace falta una credencial
// nueva. /api/status y /health quedan sin auth a propósito (mismo
// criterio que ya tenían: son de solo lectura, no cambian nada de la
// placa).
// Declaración explícita: el auto-prototipado de Arduino (que normalmente
// permite llamar una función definida más abajo en el mismo .ino sin
// declararla antes) no resuelve bien un parámetro de puntero a función
// como el de parseAndSetColor -- confirmado compilando de verdad (PlatformIO):
// sin esto, "parseAndSetColor" no se declaró en este ámbito" adentro de
// los lambda de setupWebServer(). handleRelayCommand() no necesita esto
// porque su firma es más simple y el auto-prototipado sí la resuelve.
bool parseAndSetColor(
  const String& command,
  uint8_t prefixLength,
  void (*setColor)(uint8_t, uint8_t, uint8_t),
  String& response
);


bool checkApiAuth() {
  if (server.authenticate(NOPAL_OTA_USERNAME, NOPAL_OTA_PASSWORD)) {
    return true;
  }

  server.requestAuthentication();
  return false;
}


void setupWebServer() {
  server.on("/", HTTP_GET, []() {
    server.sendHeader("Location", "/update");
    server.send(302, "text/plain", "");
  });

  server.on("/api/status", HTTP_GET, []() {
    server.send(
      200,
      "application/json; charset=utf-8",
      buildStatusJson()
    );
  });

  server.on("/health", HTTP_GET, []() {
    server.send(200, "text/plain", "OK");
  });


  // ------------------------------------------------------------------------
  // Control por red -- mismo protocolo de texto que ya habla Serial,
  // reusando los mismos handlers (handleRelayCommand/parseAndSetColor) para
  // que la placa se comporte exactamente igual sin importar por dónde
  // llegó el comando.
  // ------------------------------------------------------------------------

  server.on("/api/relay", HTTP_GET, []() {
    if (!checkApiAuth()) return;

    const String command = String("R") + server.arg("n") + "?";
    // Default por si handleRelayCommand() ni siquiera reconoce la forma
    // del comando (ej. falta "n" -> "R?", que sí matchea el formato de
    // consulta y da ERR:INVALID_RELAY -- pero por las dudas, nunca dejar
    // `response` vacío, o el llamante HTTP recibiría un 200 engañoso con
    // cuerpo vacío en vez de un error).
    String response = "ERR:INVALID_RELAY";
    handleRelayCommand(command, response);

    server.send(
      response.startsWith("ERR") ? 400 : 200,
      "text/plain",
      response
    );
  });

  server.on("/api/relay", HTTP_POST, []() {
    if (!checkApiAuth()) return;

    const bool on = server.arg("on") == "true" || server.arg("on") == "1";
    const String command = String("R") + server.arg("n") + ":" + (on ? "ON" : "OFF");
    // Mismo motivo que en el GET de arriba: si falta "n" el comando queda
    // como "R:ON"/"R:OFF" (sin dígitos entre "R" y ":"), una forma que
    // handleRelayCommand() ni reconoce como comando de relé (devuelve
    // false y no toca `response`) -- sin este default se mandaría un 200
    // con el cuerpo vacío en vez de avisar el error.
    String response = "ERR:INVALID_RELAY";
    handleRelayCommand(command, response);

    server.send(
      response.startsWith("ERR") ? 400 : 200,
      "text/plain",
      response
    );
  });

  server.on("/api/led", HTTP_POST, []() {
    if (!checkApiAuth()) return;

    const String mode = server.arg("mode");
    String response = "ERR:UNSUPPORTED";

#if PWM_LED_ENABLE
    if (mode == "pwm") {
      const String command =
        String("LED:") + server.arg("r") + "," + server.arg("g") + "," + server.arg("b");
      parseAndSetColor(command, 4, setPwmLedColor, response);
    }
#endif

#if WS2812_ENABLE
    if (mode == "ws2812") {
      const String command =
        String("WS:") + server.arg("r") + "," + server.arg("g") + "," + server.arg("b");
      parseAndSetColor(command, 3, setWs2812Color, response);
    }
#endif

    server.send(
      response.startsWith("ERR") ? 400 : 200,
      "text/plain",
      response
    );
  });


  server.onNotFound([]() {
    server.send(
      404,
      "application/json; charset=utf-8",
      "{\"error\":\"not_found\"}"
    );
  });

  // IMPORTANTE: las credenciales van como argumentos de begin(), no en un
  // setAuth() previo -- ElegantOTAClass::begin(server, username="",
  // password="") llama a setAuth(username, password) internamente, así que
  // un setAuth() hecho ANTES de begin() queda pisado por los valores por
  // default (vacíos) de begin() y el panel /update queda sin protección
  // real, aunque el código "parezca" configurarla. Confirmado en vivo: con
  // el bug, http://IP/update respondía 200 sin ninguna credencial.
  ElegantOTA.begin(&server, NOPAL_OTA_USERNAME, NOPAL_OTA_PASSWORD);

  server.begin();
  webServerStarted = true;

  Serial.print("NOPAL:HTTP_READY,port=");
  Serial.print(HTTP_PORT);
  Serial.print(",ota=/update,ip=");
  Serial.println(activeIpAddress());
}


void serviceNetwork() {
  maintainWifiConnection();

#if STATUS_LED_ENABLE
  serviceStatusLed();
#endif

  if (webServerStarted) {
    server.handleClient();
    ElegantOTA.loop();
  }

#if defined(ESP8266)

  if (mdnsStarted) {
    MDNS.update();
  }

  yield();

#endif
}


// ============================================================================
// IDENTIFICACIÓN PARA NOPAL
// ============================================================================

void sendIdentification() {
  Serial.print("NOPAL,role=accessory,chip=");

  printChipIdentification();

  Serial.print(",fw=");
  Serial.print(FW_VERSION);

  Serial.print(",relays=");
  Serial.print(RELAY_COUNT);

  Serial.print(",pwm_led=");
  Serial.print(PWM_LED_ENABLE ? 1 : 0);

  Serial.print(",ws2812=");
  Serial.print(WS2812_ENABLE ? 1 : 0);

  Serial.print(",ws2812_count=");
  Serial.print(
    WS2812_ENABLE
      ? WS2812_COUNT
      : 0
  );

  // Campos opcionales agregados en 1.3: un backend viejo simplemente no los
  // conoce y los ignora, mismo criterio que el resto de campos "extra" de
  // esta línea.
  Serial.print(",wifi=1");

  Serial.print(",wifi_connected=");
  Serial.print(WiFi.status() == WL_CONNECTED ? 1 : 0);

  Serial.print(",wifi_mode=");
  Serial.print(wifiModeText());

  Serial.print(",hostname=");
  Serial.print(NOPAL_HOSTNAME);

  Serial.print(",ip=");
  Serial.print(activeIpAddress());

  Serial.print(",ota=1");
  Serial.print(",ota_path=/update");

  // Telemetría real disponible en ambas plataformas sin sensores extra
  // (no hay forma de medir voltaje/corriente/temperatura en este firmware
  // genérico sin hardware adicional, así que no se reporta). Presente
  // desde la 1.2.
  Serial.print(",uptime_ms=");
  Serial.print(millis());

  Serial.print(",free_heap=");
  Serial.println(ESP.getFreeHeap());
}


void sendNetworkIdentification() {
  Serial.print("NET,connected=");
  Serial.print(WiFi.status() == WL_CONNECTED ? 1 : 0);

  Serial.print(",mode=");
  Serial.print(wifiModeText());

  Serial.print(",hostname=");
  Serial.print(NOPAL_HOSTNAME);

  Serial.print(",ssid=");

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(WiFi.SSID());
  }

  Serial.print(",ip=");
  Serial.print(activeIpAddress());

  Serial.print(",rssi=");
  Serial.print(
    WiFi.status() == WL_CONNECTED
      ? WiFi.RSSI()
      : 0
  );

  Serial.print(",recovery_ap=");
  Serial.print(recoveryApActive ? 1 : 0);

  Serial.print(",recovery_ssid=");

  if (recoveryApActive) {
    Serial.print(recoveryApSsid);
  }

  Serial.print(",ota_url=http://");
  Serial.print(activeIpAddress());
  Serial.println("/update");
}


// ============================================================================
// PROCESAMIENTO DE RELÉS
// ============================================================================

// Devuelve la respuesta en `response` en vez de imprimirla directo (así la
// puede reusar tanto handleCommand(), que la manda por Serial, como los
// endpoints HTTP nuevos, que la mandan como cuerpo de la respuesta) -- el
// `bool` de retorno conserva su significado original: "reconocí esto como
// un comando de relé" (true incluso en error de formato/índice/acción),
// false si ni siquiera tiene forma de comando de relé (deja que
// handleCommand() siga probando otros handlers).
bool handleRelayCommand(const String& command, String& response) {

  if (
    command.length() < 2 ||
    command.charAt(0) != 'R'
  ) {
    return false;
  }

  // ------------------------------------------------------------------------
  // Consulta:
  // R1?
  // ------------------------------------------------------------------------

  if (command.endsWith("?")) {

    const String relayNumberText =
      command.substring(1, command.length() - 1);

    const int relayNumber =
      relayNumberText.toInt();

    const int relayIndex =
      relayNumber - 1;

    if (!validRelayIndex(relayIndex)) {
      response = "ERR:INVALID_RELAY";
      return true;
    }

    response =
      getRelay(relayIndex)
        ? "ON"
        : "OFF";

    return true;
  }


  // ------------------------------------------------------------------------
  // Acción:
  // R1:ON
  // R1:OFF
  // ------------------------------------------------------------------------

  const int colonPosition =
    command.indexOf(':');

  if (colonPosition <= 1) {
    return false;
  }

  const String relayNumberText =
    command.substring(1, colonPosition);

  const int relayNumber =
    relayNumberText.toInt();

  const int relayIndex =
    relayNumber - 1;

  if (!validRelayIndex(relayIndex)) {
    response = "ERR:INVALID_RELAY";
    return true;
  }

  String action =
    command.substring(colonPosition + 1);

  action.trim();
  action.toUpperCase();

  if (action == "ON") {
    setRelay(relayIndex, true);
    response = "OK";
    return true;
  }

  if (action == "OFF") {
    setRelay(relayIndex, false);
    response = "OK";
    return true;
  }

  response = "ERR:INVALID_ACTION";

  return true;
}


// ============================================================================
// PROCESAMIENTO DE COMANDOS
// ============================================================================

// Mismo criterio que handleRelayCommand(): devuelve la respuesta en vez de
// imprimirla, para reusarse desde Serial (handleCommand) y desde los
// endpoints HTTP nuevos. `setColor` es setPwmLedColor o setWs2812Color
// (misma firma en ambas), `prefixLength` es cuánto saltar del comando
// antes de los 3 números ("LED:" = 4, "WS:" = 3).
bool parseAndSetColor(
  const String& command,
  uint8_t prefixLength,
  void (*setColor)(uint8_t, uint8_t, uint8_t),
  String& response
) {
  int red;
  int green;
  int blue;

  const int parsedValues = sscanf(
    command.c_str() + prefixLength,
    "%d,%d,%d",
    &red,
    &green,
    &blue
  );

  if (parsedValues != 3) {
    response = "ERR:INVALID_RGB";
    return true;
  }

  setColor(
    clampColor(red),
    clampColor(green),
    clampColor(blue)
  );

  response = "OK";
  return true;
}


void handleCommand(String line) {

  line.trim();

  if (!line.startsWith("NOPAL:")) {
    return;
  }

  String command =
    line.substring(6);

  command.trim();


  // ------------------------------------------------------------------------
  // Identificación
  // ------------------------------------------------------------------------

  if (command == "ID?") {
    sendIdentification();
    return;
  }

  if (command == "NET?") {
    sendNetworkIdentification();
    return;
  }


  // ------------------------------------------------------------------------
  // Relés
  // ------------------------------------------------------------------------

  {
    String response;

    if (handleRelayCommand(command, response)) {
      Serial.println(response);
      return;
    }
  }


  // ------------------------------------------------------------------------
  // RGB PWM
  // ------------------------------------------------------------------------

#if PWM_LED_ENABLE

  if (command.startsWith("LED:")) {
    String response;
    parseAndSetColor(command, 4, setPwmLedColor, response);
    Serial.println(response);
    return;
  }

#endif


  // ------------------------------------------------------------------------
  // WS2812
  // ------------------------------------------------------------------------

#if WS2812_ENABLE

  if (command.startsWith("WS:")) {
    String response;
    parseAndSetColor(command, 3, setWs2812Color, response);
    Serial.println(response);
    return;
  }

#endif

  Serial.println("ERR:UNKNOWN_COMMAND");
}


// ============================================================================
// SETUP
// ============================================================================

void setup() {
  Serial.begin(115200);

  inputLine.reserve(128);

  // Configuración segura de relés.
  for (uint8_t index = 0; index < RELAY_COUNT; index++) {
    pinMode(RELAY_PINS[index], OUTPUT);
    setRelay(index, false);
  }

#if STATUS_LED_ENABLE
  // Encendido apenas la placa está mínimamente viva -- antes de setupWifi()
  // a propósito, para que el LED ya esté prendido durante el margen de
  // conexión (varios segundos) en vez de parecer una placa muerta hasta
  // que termine.
  pinMode(STATUS_LED_PIN, OUTPUT);
  setStatusLed(true);
#endif

  setupPwmLed();

  // Apagar RGB al iniciar.
  setPwmLedColor(0, 0, 0);

#if WS2812_ENABLE

  strip.begin();
  strip.clear();
  strip.show();

#endif

  setupWifi();
  setupWebServer();

  delay(100);

  Serial.println("NOPAL:READY");
}


// ============================================================================
// LOOP
// ============================================================================

void loop() {

  serviceNetwork();

  while (Serial.available() > 0) {

    const char receivedCharacter =
      static_cast<char>(Serial.read());

    if (receivedCharacter == '\n') {

      inputLine.trim();

      if (!inputLine.isEmpty()) {
        handleCommand(inputLine);
      }

      inputLine = "";

    } else if (receivedCharacter != '\r') {

      // Evita que una entrada defectuosa consuma toda la memoria.
      if (inputLine.length() < 127) {
        inputLine += receivedCharacter;
      } else {
        inputLine = "";
        Serial.println("ERR:LINE_TOO_LONG");
      }
    }
  }

#if defined(ESP8266)

  // Permite que el ESP8266 atienda sus tareas internas.
  yield();

#endif
}
