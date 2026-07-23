/*
 * NOPAL — Firmware genérico de accesorios + SIM800L + Wi-Fi + ElegantOTA
 *
 * Versión: 1.3
 *
 * Compatible con:
 *   - ESP32: todas las funciones, incluido SIM800L mediante Serial2.
 *   - ESP8266: relés, RGB, WS2812, Wi-Fi y ElegantOTA.
 *              SIM800L queda desactivado por defecto porque el mapa actual
 *              utiliza prácticamente todos los GPIO y el puerto Serial.
 *
 * Funciones:
 *   - Relés
 *   - Tira RGB analógica por PWM
 *   - Tira WS2812 / NeoPixel
 *   - Wi-Fi STA con reconexión
 *   - Punto de acceso de recuperación si falla el Wi-Fi
 *   - ElegantOTA con autenticación
 *   - mDNS: http://nopal-sim800l.local/
 *   - Base SIM800L con comandos AT sobre UART2 en ESP32
 *
 * Comunicación NOPAL:
 *   Serial USB a 115200 baudios
 *   Un comando por línea terminado en \n
 *
 * Comandos existentes:
 *   NOPAL:ID?
 *   NOPAL:R1:ON
 *   NOPAL:R1:OFF
 *   NOPAL:R1?
 *   NOPAL:LED:255,0,0
 *   NOPAL:WS:0,255,0
 *
 * Comandos nuevos:
 *   NOPAL:NET?
 *   NOPAL:SIM:AT
 *   NOPAL:SIM:INFO?
 *   NOPAL:SIM:CSQ?
 *   NOPAL:SIM:CREG?
 *   NOPAL:SIM:CCID?
 *   NOPAL:SIM:IMEI?
 *   NOPAL:SIM:OPERATOR?
 *   NOPAL:SIM:RAW:AT+CPIN?
 *
 * Portal web:
 *   http://IP/
 *   http://IP/api/status
 *   http://IP/update
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

#define FW_VERSION "1.3"
#define DEVICE_ROLE "accessory-sim800l"

const bool RELAY_ACTIVE_LOW = true;

const uint32_t WIFI_CONNECT_TIMEOUT_MS = 15000;
const uint32_t WIFI_RECONNECT_INTERVAL_MS = 15000;

const uint16_t HTTP_PORT = 80;


// ============================================================================
// CONFIGURACIÓN DE PINES Y CAPACIDADES
// ============================================================================

#if defined(ESP32)

  #define RELAY_COUNT 4

  const uint8_t RELAY_PINS[RELAY_COUNT] = {
    16,
    17,
    18,
    19
  };

  #define PWM_LED_ENABLE 1
  #define PWM_LED_PIN_R 25
  #define PWM_LED_PIN_G 26
  #define PWM_LED_PIN_B 27

  #define WS2812_ENABLE 1
  #define WS2812_PIN 4
  #define WS2812_COUNT 30

  // SIM800L por UART2 del ESP32.
  // ESP32 RX recibe del TX del SIM800L.
  // ESP32 TX transmite al RX del SIM800L.
  #define SIM800L_ENABLE 1
  #define SIM800L_RX_PIN 32
  #define SIM800L_TX_PIN 33
  #define SIM800L_BAUD 9600

  // Algunos módulos SIM800L arrancan al recibir alimentación.
  // Si tu placa necesita PWRKEY, cambia a 1 y configura el pin.
  #define SIM800L_PWRKEY_ENABLE 0
  #define SIM800L_PWRKEY_PIN 23
  #define SIM800L_PWRKEY_ACTIVE_LOW 1

#elif defined(ESP8266)

  #define RELAY_COUNT 4

  const uint8_t RELAY_PINS[RELAY_COUNT] = {
    5,   // D1
    4,   // D2
    14,  // D5
    12   // D6
  };

  #define PWM_LED_ENABLE 1
  #define PWM_LED_PIN_R 13  // D7
  #define PWM_LED_PIN_G 15  // D8
  #define PWM_LED_PIN_B 16  // D0

  #define WS2812_ENABLE 1
  #define WS2812_PIN 2      // D4
  #define WS2812_COUNT 30

  // Desactivado porque el mapa de pines actual y Serial USB no dejan
  // una UART limpia y confiable para el módem.
  #define SIM800L_ENABLE 0
  #define SIM800L_BAUD 9600

#endif


// ============================================================================
// SERVIDOR WEB
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
// WS2812
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
// SIM800L
// ============================================================================

#if defined(ESP32) && SIM800L_ENABLE

  HardwareSerial sim800Serial(2);

  String lastSimCommand;
  String lastSimResponse;
  uint32_t lastSimActivityMs = 0;

#endif


// ============================================================================
// VARIABLES GENERALES
// ============================================================================

String inputLine;

#if defined(ESP32) && ESP_ARDUINO_VERSION_MAJOR < 3

  const uint8_t PWM_CHANNEL_R = 0;
  const uint8_t PWM_CHANNEL_G = 1;
  const uint8_t PWM_CHANNEL_B = 2;

#endif


// ============================================================================
// PROTOTIPOS
// ============================================================================

void serviceNetwork();
void maintainWifiConnection();
void handleCommand(String line);


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

      ledcAttach(PWM_LED_PIN_R, 5000, 8);
      ledcAttach(PWM_LED_PIN_G, 5000, 8);
      ledcAttach(PWM_LED_PIN_B, 5000, 8);

    #else

      ledcSetup(PWM_CHANNEL_R, 5000, 8);
      ledcSetup(PWM_CHANNEL_G, 5000, 8);
      ledcSetup(PWM_CHANNEL_B, 5000, 8);

      ledcAttachPin(PWM_LED_PIN_R, PWM_CHANNEL_R);
      ledcAttachPin(PWM_LED_PIN_G, PWM_CHANNEL_G);
      ledcAttachPin(PWM_LED_PIN_B, PWM_CHANNEL_B);

    #endif

  #elif defined(ESP8266)

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

#if defined(ESP32)
  WiFi.setAutoReconnect(true);
#elif defined(ESP8266)
  WiFi.setAutoReconnect(true);
#endif

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
  json.reserve(640);

  json += "{";
  json += "\"role\":\"";
  json += DEVICE_ROLE;
  json += "\",";

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
  json += "},";

  json += "\"sim800l\":{";
  json += "\"enabled\":";
  json += SIM800L_ENABLE ? "true" : "false";
  json += ",";
  json += "\"baud\":";
  json += String(SIM800L_BAUD);

#if defined(ESP32) && SIM800L_ENABLE

  json += ",";
  json += "\"last_command\":\"";
  json += jsonEscape(lastSimCommand);
  json += "\",";
  json += "\"last_response\":\"";
  json += jsonEscape(lastSimResponse);
  json += "\",";
  json += "\"last_activity_ms\":";
  json += String(lastSimActivityMs);

#endif

  json += "}";
  json += "}";

  return json;
}


String buildHomePage() {
  String html;
  html.reserve(3500);

  html += F("<!doctype html><html lang='es'><head>");
  html += F("<meta charset='utf-8'>");
  html += F("<meta name='viewport' content='width=device-width,initial-scale=1'>");
  html += F("<title>NOPAL SIM800L</title>");
  html += F("<style>");
  html += F("body{margin:0;background:#101512;color:#eef6ef;font-family:Arial,sans-serif}");
  html += F("main{max-width:760px;margin:0 auto;padding:28px}");
  html += F("h1{margin:0 0 6px;color:#77d477}small{color:#9aa89d}");
  html += F(".card{margin-top:20px;padding:18px;border:1px solid #304238;border-radius:16px;background:#172019}");
  html += F(".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}");
  html += F(".item{padding:12px;border-radius:12px;background:#202c23}");
  html += F(".label{font-size:12px;color:#9eb1a2;text-transform:uppercase}.value{margin-top:5px;font-weight:bold;word-break:break-word}");
  html += F("a{display:inline-block;margin-top:16px;padding:12px 16px;border-radius:10px;background:#2f8f46;color:white;text-decoration:none;font-weight:bold}");
  html += F("code{color:#a6e7ac}");
  html += F("</style></head><body><main>");
  html += F("<h1>NOPAL · SIM800L</h1>");
  html += F("<small>Firmware de accesorios con Wi-Fi y ElegantOTA</small>");
  html += F("<section class='card'><div class='grid'>");

  html += F("<div class='item'><div class='label'>Firmware</div><div class='value'>");
  html += FW_VERSION;
  html += F("</div></div>");

  html += F("<div class='item'><div class='label'>Hostname</div><div class='value'>");
  html += NOPAL_HOSTNAME;
  html += F("</div></div>");

  html += F("<div class='item'><div class='label'>Modo de red</div><div class='value'>");
  html += wifiModeText();
  html += F("</div></div>");

  html += F("<div class='item'><div class='label'>IP activa</div><div class='value'>");
  html += activeIpAddress();
  html += F("</div></div>");

  html += F("<div class='item'><div class='label'>Wi-Fi</div><div class='value'>");
  html += WiFi.status() == WL_CONNECTED
    ? "Conectado"
    : "Sin conexión STA";
  html += F("</div></div>");

  html += F("<div class='item'><div class='label'>SIM800L</div><div class='value'>");
  html += SIM800L_ENABLE
    ? "Habilitado"
    : "Deshabilitado";
  html += F("</div></div>");

  html += F("</div>");
  html += F("<a href='/update'>Actualizar firmware</a>");
  html += F(" <a href='/api/status'>Ver estado JSON</a>");
  html += F("</section>");

  html += F("<section class='card'><div class='label'>Acceso OTA</div>");
  html += F("<p>Abre <code>/update</code> e ingresa las credenciales configuradas en <code>secrets.h</code>.</p>");

  if (recoveryApActive) {
    html += F("<p>Red de recuperación: <code>");
    html += recoveryApSsid;
    html += F("</code> · IP: <code>");
    html += WiFi.softAPIP().toString();
    html += F("</code></p>");
  }

  html += F("</section></main></body></html>");

  return html;
}


void setupWebServer() {
  server.on("/", HTTP_GET, []() {
    server.send(
      200,
      "text/html; charset=utf-8",
      buildHomePage()
    );
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

  server.onNotFound([]() {
    server.send(
      404,
      "application/json; charset=utf-8",
      "{\"error\":\"not_found\"}"
    );
  });

  ElegantOTA.setAuth(
    NOPAL_OTA_USERNAME,
    NOPAL_OTA_PASSWORD
  );

  ElegantOTA.begin(&server);

  server.begin();
  webServerStarted = true;

  Serial.print("NOPAL:HTTP_READY,port=");
  Serial.print(HTTP_PORT);
  Serial.print(",ota=/update,ip=");
  Serial.println(activeIpAddress());
}


void serviceNetwork() {
  maintainWifiConnection();

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
// SIM800L: TRANSACCIONES AT
// ============================================================================

#if defined(ESP32) && SIM800L_ENABLE

void pulseSim800lPowerKey() {

#if SIM800L_PWRKEY_ENABLE

  pinMode(SIM800L_PWRKEY_PIN, OUTPUT);

  const uint8_t activeLevel =
    SIM800L_PWRKEY_ACTIVE_LOW ? LOW : HIGH;

  const uint8_t idleLevel =
    SIM800L_PWRKEY_ACTIVE_LOW ? HIGH : LOW;

  digitalWrite(SIM800L_PWRKEY_PIN, idleLevel);
  delay(100);

  digitalWrite(SIM800L_PWRKEY_PIN, activeLevel);
  delay(1200);

  digitalWrite(SIM800L_PWRKEY_PIN, idleLevel);
  delay(3000);

#endif
}


String sanitizeSimResponse(String response) {
  response.replace("\r", "");
  response.trim();
  response.replace("\n", "|");
  response.replace(",", ";");

  while (response.indexOf("||") >= 0) {
    response.replace("||", "|");
  }

  return response;
}


String transactSim800l(
  const String& atCommand,
  uint32_t timeoutMs = 1800
) {
  while (sim800Serial.available() > 0) {
    sim800Serial.read();
  }

  sim800Serial.print(atCommand);
  sim800Serial.print("\r\n");

  String response;
  response.reserve(256);

  const uint32_t startedAt = millis();
  uint32_t lastByteAt = startedAt;
  bool receivedAnyByte = false;

  while (millis() - startedAt < timeoutMs) {
    while (sim800Serial.available() > 0) {
      const char character =
        static_cast<char>(sim800Serial.read());

      if (response.length() < 511) {
        response += character;
      }

      receivedAnyByte = true;
      lastByteAt = millis();
    }

    const bool finalResponseSeen =
      response.indexOf("\r\nOK\r\n") >= 0 ||
      response.indexOf("\r\nERROR\r\n") >= 0 ||
      response.indexOf("+CME ERROR:") >= 0 ||
      response.indexOf("+CMS ERROR:") >= 0;

    if (
      receivedAnyByte &&
      finalResponseSeen &&
      millis() - lastByteAt > 80
    ) {
      break;
    }

    serviceNetwork();
    delay(1);
  }

  lastSimCommand = atCommand;
  lastSimResponse = sanitizeSimResponse(response);
  lastSimActivityMs = millis();

  if (lastSimResponse.length() == 0) {
    lastSimResponse = "TIMEOUT";
  }

  return lastSimResponse;
}


void printSimTransaction(const String& atCommand) {
  const String response = transactSim800l(atCommand);

  Serial.print("SIM800L,cmd=");
  Serial.print(atCommand);
  Serial.print(",response=");
  Serial.println(response);
}


void setupSim800l() {
  pulseSim800lPowerKey();

  sim800Serial.begin(
    SIM800L_BAUD,
    SERIAL_8N1,
    SIM800L_RX_PIN,
    SIM800L_TX_PIN
  );

  delay(500);

  Serial.print("NOPAL:SIM800L_UART_READY,baud=");
  Serial.print(SIM800L_BAUD);
  Serial.print(",rx=");
  Serial.print(SIM800L_RX_PIN);
  Serial.print(",tx=");
  Serial.println(SIM800L_TX_PIN);

  const String atResponse = transactSim800l("AT", 1200);

  if (atResponse.indexOf("OK") >= 0) {
    Serial.println("NOPAL:SIM800L_READY");

    transactSim800l("ATE0", 1200);
    transactSim800l("AT+CMEE=2", 1200);
  } else {
    Serial.print("WARN:SIM800L_NO_RESPONSE,response=");
    Serial.println(atResponse);
  }
}

#endif


// ============================================================================
// IDENTIFICACIÓN PARA NOPAL
// ============================================================================

void sendIdentification() {
  Serial.print("NOPAL,role=");
  Serial.print(DEVICE_ROLE);

  Serial.print(",chip=");
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
  Serial.print(WS2812_ENABLE ? WS2812_COUNT : 0);

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

  Serial.print(",sim800l=");
  Serial.print(SIM800L_ENABLE ? 1 : 0);

  Serial.print(",sim_baud=");
  Serial.print(SIM800L_BAUD);

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

bool handleRelayCommand(const String& command) {
  if (
    command.length() < 2 ||
    command.charAt(0) != 'R'
  ) {
    return false;
  }

  if (command.endsWith("?")) {
    const String relayNumberText =
      command.substring(1, command.length() - 1);

    const int relayNumber = relayNumberText.toInt();
    const int relayIndex = relayNumber - 1;

    if (!validRelayIndex(relayIndex)) {
      Serial.println("ERR:INVALID_RELAY");
      return true;
    }

    Serial.println(
      getRelay(relayIndex)
        ? "ON"
        : "OFF"
    );

    return true;
  }

  const int colonPosition = command.indexOf(':');

  if (colonPosition <= 1) {
    return false;
  }

  const String relayNumberText =
    command.substring(1, colonPosition);

  const int relayNumber = relayNumberText.toInt();
  const int relayIndex = relayNumber - 1;

  if (!validRelayIndex(relayIndex)) {
    Serial.println("ERR:INVALID_RELAY");
    return true;
  }

  String action = command.substring(colonPosition + 1);
  action.trim();
  action.toUpperCase();

  if (action == "ON") {
    setRelay(relayIndex, true);
    Serial.println("OK");
    return true;
  }

  if (action == "OFF") {
    setRelay(relayIndex, false);
    Serial.println("OK");
    return true;
  }

  Serial.println("ERR:INVALID_ACTION");

  return true;
}


// ============================================================================
// PROCESAMIENTO DE SIM800L
// ============================================================================

bool handleSim800lCommand(const String& command) {
  if (!command.startsWith("SIM:")) {
    return false;
  }

#if defined(ESP32) && SIM800L_ENABLE

  if (command == "SIM:AT") {
    printSimTransaction("AT");
    return true;
  }

  if (command == "SIM:INFO?") {
    printSimTransaction("ATI");
    return true;
  }

  if (command == "SIM:CSQ?") {
    printSimTransaction("AT+CSQ");
    return true;
  }

  if (command == "SIM:CREG?") {
    printSimTransaction("AT+CREG?");
    return true;
  }

  if (command == "SIM:CCID?") {
    printSimTransaction("AT+CCID");
    return true;
  }

  if (command == "SIM:IMEI?") {
    printSimTransaction("AT+GSN");
    return true;
  }

  if (command == "SIM:OPERATOR?") {
    printSimTransaction("AT+COPS?");
    return true;
  }

  if (command.startsWith("SIM:RAW:")) {
    String rawCommand = command.substring(8);
    rawCommand.trim();

    if (
      !rawCommand.startsWith("AT") ||
      rawCommand.length() > 100
    ) {
      Serial.println("ERR:INVALID_AT_COMMAND");
      return true;
    }

    printSimTransaction(rawCommand);
    return true;
  }

  Serial.println("ERR:UNKNOWN_SIM_COMMAND");
  return true;

#else

  Serial.println("ERR:SIM800L_DISABLED_ON_THIS_BUILD");
  return true;

#endif
}


// ============================================================================
// PROCESAMIENTO DE COMANDOS NOPAL
// ============================================================================

void handleCommand(String line) {
  line.trim();

  if (!line.startsWith("NOPAL:")) {
    return;
  }

  String command = line.substring(6);
  command.trim();

  if (command == "ID?") {
    sendIdentification();
    return;
  }

  if (command == "NET?") {
    sendNetworkIdentification();
    return;
  }

  if (handleRelayCommand(command)) {
    return;
  }

  if (handleSim800lCommand(command)) {
    return;
  }

#if PWM_LED_ENABLE

  if (command.startsWith("LED:")) {
    int red;
    int green;
    int blue;

    const int parsedValues = sscanf(
      command.c_str() + 4,
      "%d,%d,%d",
      &red,
      &green,
      &blue
    );

    if (parsedValues != 3) {
      Serial.println("ERR:INVALID_RGB");
      return;
    }

    setPwmLedColor(
      clampColor(red),
      clampColor(green),
      clampColor(blue)
    );

    Serial.println("OK");
    return;
  }

#endif

#if WS2812_ENABLE

  if (command.startsWith("WS:")) {
    int red;
    int green;
    int blue;

    const int parsedValues = sscanf(
      command.c_str() + 3,
      "%d,%d,%d",
      &red,
      &green,
      &blue
    );

    if (parsedValues != 3) {
      Serial.println("ERR:INVALID_RGB");
      return;
    }

    setWs2812Color(
      clampColor(red),
      clampColor(green),
      clampColor(blue)
    );

    Serial.println("OK");
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
  inputLine.reserve(160);

  for (uint8_t index = 0; index < RELAY_COUNT; index++) {
    pinMode(RELAY_PINS[index], OUTPUT);
    setRelay(index, false);
  }

  setupPwmLed();
  setPwmLedColor(0, 0, 0);

#if WS2812_ENABLE

  strip.begin();
  strip.clear();
  strip.show();

#endif

#if defined(ESP32) && SIM800L_ENABLE

  setupSim800l();

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

      if (inputLine.length() > 0) {
        handleCommand(inputLine);
      }

      inputLine = "";

    } else if (receivedCharacter != '\r') {

      if (inputLine.length() < 159) {
        inputLine += receivedCharacter;
      } else {
        inputLine = "";
        Serial.println("ERR:LINE_TOO_LONG");
      }
    }
  }
}
