/*
 * NOPAL — Firmware de accesorio AM-036 (T-Call SIM800L IP5306) + Wi-Fi + ElegantOTA
 *
 * Basado en firmware/nopal_accessory/NOPAL_SIM800L_OTA.ino v1.3 de
 * https://github.com/charlymigenes-ux/nopal, adaptado al mapa de pines real
 * de esta placa (T-Call v1.3, SIM800L_IP5306_VERSION_20200811, ver
 * utilities.h) y a sus accesorios físicos (2 relés + tira WS2812).
 *
 * Funciones:
 *   - 2 relés
 *   - Tira WS2812 / NeoPixel
 *   - Wi-Fi STA con reconexión
 *   - Punto de acceso de recuperación si falla el Wi-Fi
 *   - ElegantOTA con autenticación
 *   - mDNS: http://nopal-am036.local/
 *   - SIM800L sobre UART2 del ESP32, en los pines reales del módem (26/27),
 *     con encendido correcto vía MODEM_POWER_ON + boost IP5306 (setupPMU())
 *
 * Comunicación NOPAL:
 *   Serial USB a 115200 baudios
 *   Un comando por línea terminado en \n
 *
 * Comandos:
 *   NOPAL:ID?
 *   NOPAL:NET?
 *   NOPAL:R1:ON / R1:OFF / R1?
 *   NOPAL:R2:ON / R2:OFF / R2?
 *   NOPAL:WS:0,255,0
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

// Selección de variante de placa (ver utilities.h) — confirmada por el
// usuario como T-Call v1.3 / IP5306.
#define SIM800L_IP5306_VERSION_20200811

#include <Arduino.h>
#include "utilities.h"
#include "secrets.h"

#if defined(ESP32)
  #include <WiFi.h>
  #include <WiFiClient.h>
  #include <WebServer.h>
  #include <ESPmDNS.h>
  #include <esp_arduino_version.h>
#else
  #error "Este firmware está adaptado específicamente a la placa T-Call ESP32 SIM800L (AM-036)."
#endif

#include <ElegantOTA.h>


// ============================================================================
// CONFIGURACIÓN GENERAL
// ============================================================================

#define FW_VERSION "1.3-am036"
// "role" tiene que ser el literal "accessory" a secas -- es lo que
// accessory_service.py (probe_wifi_board/_probe_nopal_board_sync) exige
// para reconocer una placa NOPAL, tanto por WiFi (GET /api/status) como
// por USB (identificación por serial). Con "accessory-am036-sim800l" el
// backend descartaba la placa en silencio: contestaba bien, autenticaba
// bien, pero como el role no calzaba exacto se reportaba como "no
// encontrada". La identidad específica de esta variante va en
// DEVICE_BOARD, un campo aparte (mismo patrón que nopal_accessory.ino).
#define DEVICE_ROLE "accessory"
#define DEVICE_BOARD "am036_tcall_sim800l"

const bool RELAY_ACTIVE_LOW = true;

const uint32_t WIFI_CONNECT_TIMEOUT_MS = 15000;
const uint32_t WIFI_RECONNECT_INTERVAL_MS = 15000;

const uint16_t HTTP_PORT = 80;


// ============================================================================
// CONFIGURACIÓN DE PINES Y CAPACIDADES (AM-036 / T-Call v1.3 IP5306)
// ============================================================================

#define RELAY_COUNT 2

const uint8_t RELAY_PINS[RELAY_COUNT] = {
  16,
  17
};

// Esta placa no tiene tira RGB analógica de 3 hilos.
#define PWM_LED_ENABLE 0
#define PWM_LED_PIN_R 25
#define PWM_LED_PIN_G 33
#define PWM_LED_PIN_B 32

#define WS2812_ENABLE 1
#define WS2812_PIN 14
#define WS2812_COUNT 8  // AJUSTA a tu cantidad real de LEDs

// SIM800L por UART2 del ESP32, en los pines reales del módem (utilities.h).
// ESP32 RX recibe del TX del SIM800L.
// ESP32 TX transmite al RX del SIM800L.
#define SIM800L_ENABLE 1
#define SIM800L_RX_PIN MODEM_RX
#define SIM800L_TX_PIN MODEM_TX
#define SIM800L_BAUD 115200

// En este hardware el encendido del módem lo resuelve setupModemPower()
// (MODEM_POWER_ON + boost del IP5306), no un pulso de PWRKEY.
#define SIM800L_PWRKEY_ENABLE 0
#define SIM800L_PWRKEY_PIN MODEM_PWRKEY
#define SIM800L_PWRKEY_ACTIVE_LOW 1


// ============================================================================
// SERVIDOR WEB
// ============================================================================

WebServer server(HTTP_PORT);

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

#if SIM800L_ENABLE

  HardwareSerial sim800Serial(2);

  String lastSimCommand;
  String lastSimResponse;
  uint32_t lastSimActivityMs = 0;

#endif


// ============================================================================
// VARIABLES GENERALES
// ============================================================================

String inputLine;

#if ESP_ARDUINO_VERSION_MAJOR < 3

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

#if SIM800L_ENABLE
// Declaración explícita: el auto-prototipado de Arduino no resuelve bien
// los parámetros con valor por defecto cuando la función se usa dentro de
// un lambda (como en el handler de /api/sim en setupWebServer()).
String transactSim800l(const String& atCommand, uint32_t timeoutMs = 1800);
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


void printChipIdentification() {
  Serial.print(ESP.getChipModel());
}


String chipSuffix() {
  char suffix[9] = {0};

  const uint32_t chipId =
    static_cast<uint32_t>(ESP.getEfuseMac() & 0xFFFFFFULL);

  snprintf(suffix, sizeof(suffix), "%06lX", static_cast<unsigned long>(chipId));

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
// PWM RGB (deshabilitado en esta placa, ver PWM_LED_ENABLE)
// ============================================================================

void setupPwmLed() {

#if PWM_LED_ENABLE

  pinMode(PWM_LED_PIN_R, OUTPUT);
  pinMode(PWM_LED_PIN_G, OUTPUT);
  pinMode(PWM_LED_PIN_B, OUTPUT);

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

#endif
}


void setPwmLedColor(uint8_t red, uint8_t green, uint8_t blue) {

#if PWM_LED_ENABLE

  #if ESP_ARDUINO_VERSION_MAJOR >= 3

    ledcWrite(PWM_LED_PIN_R, red);
    ledcWrite(PWM_LED_PIN_G, green);
    ledcWrite(PWM_LED_PIN_B, blue);

  #else

    ledcWrite(PWM_CHANNEL_R, red);
    ledcWrite(PWM_CHANNEL_G, green);
    ledcWrite(PWM_CHANNEL_B, blue);

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


bool setWs2812Segment(int start, int count, uint8_t red, uint8_t green, uint8_t blue) {

#if WS2812_ENABLE

  if (start < 0 || start >= WS2812_COUNT || count < 1) {
    return false;
  }

  const int lastIndex = min(start + count, static_cast<int>(WS2812_COUNT));

  for (int index = start; index < lastIndex; index++) {
    strip.setPixelColor(index, strip.Color(red, green, blue));
  }

  strip.show();

  return true;

#else

  return false;

#endif
}


// ============================================================================
// WI-FI
// ============================================================================

void setWifiHostname() {
  // Debe llamarse antes de iniciar Wi-Fi.
  WiFi.setHostname(NOPAL_HOSTNAME);
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

  json += "\"board\":\"";
  json += DEVICE_BOARD;
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

  json += "\"relays\":[";

  for (uint8_t index = 0; index < RELAY_COUNT; index++) {
    if (index > 0) {
      json += ",";
    }

    json += "{\"n\":";
    json += String(index + 1);
    json += ",\"name\":\"Rel\\u00e9 ";
    json += String(index + 1);
    json += "\",\"gpio\":";
    json += String(RELAY_PINS[index]);
    json += ",\"on\":";
    json += getRelay(index) ? "true" : "false";
    json += "}";
  }

  json += "],";

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
  json += ",";
  json += "\"ws2812_pin\":";
  json += String(WS2812_ENABLE ? WS2812_PIN : -1);
  json += "},";

  json += "\"sim800l\":{";
  json += "\"enabled\":";
  json += SIM800L_ENABLE ? "true" : "false";
  json += ",";
  json += "\"baud\":";
  json += String(SIM800L_BAUD);

#if SIM800L_ENABLE

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


bool checkApiAuth() {
  if (server.authenticate(NOPAL_OTA_USERNAME, NOPAL_OTA_PASSWORD)) {
    return true;
  }

  server.requestAuthentication();
  return false;
}


// Panel embebido: relés + NeoPixel + SIM800L + estado en vivo, protegido
// con las mismas credenciales que /update. Sin "escenas" ni RGB PWM porque
// esta placa no los tiene (ver PWM_LED_ENABLE arriba).
const char INDEX_HTML[] PROGMEM = R"NOPALHTML(
<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NOPAL · AM-036</title>
<style>
:root{
  color-scheme:dark;
  --bg:#101719;--panel:#182326;--panel2:#1e2c2f;--line:#304246;
  --text:#edf6f1;--muted:#9bb0aa;--green:#65d690;--red:#ff6c6c;
}
*{box-sizing:border-box}
body{
  margin:0;min-height:100vh;
  background:radial-gradient(circle at 20% 0%,rgba(101,214,144,.10),transparent 35%),
    linear-gradient(180deg,#11191b,#0c1214);
  color:var(--text);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
}
main{max-width:1000px;margin:auto;padding:24px}
header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:20px}
.brand{display:flex;align-items:center;gap:13px}
.logo{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;
  background:linear-gradient(145deg,#276340,#173326);border:1px solid #4d8b63;font-size:24px}
h1{font-size:21px;margin:0}.sub{color:var(--muted);font-size:13px}
a{color:var(--green);text-decoration:none}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px}
.card{grid-column:span 6;background:linear-gradient(145deg,var(--panel),var(--panel2));
  border:1px solid var(--line);border-radius:18px;padding:18px;box-shadow:0 14px 35px rgba(0,0,0,.20)}
.card.full{grid-column:span 12}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#c5d8d2;margin:0 0 14px}
.relays{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.relay{display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:12px;border-radius:13px;background:#111b1d;border:1px solid #2d4043}
.badge{font-size:12px;padding:4px 9px;border-radius:999px;background:#253336;color:var(--muted)}
.badge.on{background:rgba(101,214,144,.16);color:var(--green)}
button,.button{border:1px solid #3a5155;background:#243438;color:var(--text);
  padding:9px 12px;border-radius:11px;cursor:pointer;font-weight:650}
button:hover,.button:hover{border-color:#6a8a8f}
button.red{background:#6a2929;border-color:#a64444}
.row{display:flex;flex-wrap:wrap;gap:9px;align-items:center}
input[type=color]{width:55px;height:40px;padding:3px;background:#101719;border:1px solid #3a5155;border-radius:10px}
input[type=number],input[type=text]{background:#101719;color:var(--text);border:1px solid #3a5155;
  border-radius:9px;padding:8px}
input[type=number]{width:72px}
input[type=text]{flex:1;min-width:160px}
.statgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.stat{padding:11px;border-radius:12px;background:#111b1d;border:1px solid #2c3d40}
.stat b{display:block;font-size:17px}.stat span{font-size:11px;color:var(--muted);text-transform:uppercase}
pre{white-space:pre-wrap;word-break:break-word;background:#0c1315;padding:12px;border-radius:12px;
  border:1px solid #26373a;color:#acd4c0}
footer{margin:18px 2px;color:var(--muted);font-size:12px}
@media(max-width:760px){.card,.card.full{grid-column:span 12}.statgrid{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<main>
<header>
  <div class="brand">
    <div class="logo">🌵</div>
    <div><h1>NOPAL · AM-036</h1><div class="sub" id="identity">Cargando estado…</div></div>
  </div>
  <a class="button" href="/update">Actualizar firmware</a>
</header>

<section class="grid">
  <article class="card">
    <h2>Relés</h2>
    <div class="relays" id="relays"></div>
  </article>

  <article class="card">
    <h2>NeoPixel global</h2>
    <div class="row">
      <input id="wsColor" type="color" value="#41d17d">
      <button onclick="sendWsColor()">Aplicar color</button>
      <button class="red" onclick="sendWsOff()">Apagar tira</button>
    </div>
    <p class="sub" id="wsInfo">—</p>
  </article>

  <article class="card">
    <h2>NeoPixel individual</h2>
    <div class="row">
      <label>LED</label>
      <input id="pixel" type="number" min="1" value="1">
      <label>Cant.</label>
      <input id="pixelCount" type="number" min="1" value="1">
      <input id="pixelColor" type="color" value="#ff8c32">
      <button onclick="sendPixel()">Aplicar</button>
    </div>
    <p class="sub">La numeración empieza en 1. "Cant." son LEDs consecutivos a partir de ese número.</p>
  </article>

  <article class="card">
    <h2>SIM800L</h2>
    <div class="row">
      <button onclick="simQuery('CSQ')">Señal (CSQ)</button>
      <button onclick="simQuery('CREG')">Registro</button>
      <button onclick="simQuery('OPERATOR')">Operador</button>
      <button onclick="simQuery('CCID')">CCID</button>
      <button onclick="simQuery('IMEI')">IMEI</button>
    </div>
    <div class="row" style="margin-top:10px">
      <input id="simRaw" type="text" placeholder="AT+CSQ">
      <button onclick="simSendRaw()">Enviar AT</button>
    </div>
    <pre id="simOut">Sin consultas todavía.</pre>
  </article>

  <article class="card full">
    <h2>Estado del dispositivo</h2>
    <div class="statgrid">
      <div class="stat"><b id="wifi">—</b><span>Wi-Fi</span></div>
      <div class="stat"><b id="ip">—</b><span>Dirección IP</span></div>
      <div class="stat"><b id="simState">—</b><span>SIM800L</span></div>
      <div class="stat"><b id="relaysOn">—</b><span>Relés activos</span></div>
    </div>
    <pre id="details">Esperando datos…</pre>
  </article>
</section>

<footer>NOPAL Firmware )NOPALHTML" FW_VERSION R"NOPALHTML( · Accesorio AM-036 (T-Call SIM800L IP5306)</footer>
</main>
<script>
const enc=o=>new URLSearchParams(o);

async function post(path,data){
  const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:enc(data)});
  const t=await r.text();
  if(!r.ok) throw new Error(t);
  setTimeout(refresh,150);
  return t;
}
function rgb(hex){return [parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16)]}

async function relay(n,on){try{await post('/api/relay',{n,on})}catch(e){alert(e.message)}}

async function sendWsColor(){
  const [r,g,b]=rgb(document.getElementById('wsColor').value);
  try{await post('/api/led',{r,g,b})}catch(e){alert(e.message)}
}
async function sendWsOff(){
  try{await post('/api/led',{r:0,g:0,b:0})}catch(e){alert(e.message)}
}
async function sendPixel(){
  const [r,g,b]=rgb(document.getElementById('pixelColor').value);
  const n=parseInt(document.getElementById('pixel').value,10)||1;
  const count=parseInt(document.getElementById('pixelCount').value,10)||1;
  try{await post('/api/led',{start:n-1,count,r,g,b})}catch(e){alert(e.message)}
}

async function simQuery(action){
  const out=document.getElementById('simOut');
  out.textContent='Consultando '+action+'…';
  try{
    const t=await post('/api/sim',{action});
    out.textContent=t;
  }catch(e){out.textContent='ERROR: '+e.message}
}
async function simSendRaw(){
  const raw=document.getElementById('simRaw').value.trim();
  if(!raw){return}
  const out=document.getElementById('simOut');
  out.textContent='Enviando '+raw+'…';
  try{
    const t=await post('/api/sim',{action:'RAW',raw});
    out.textContent=t;
  }catch(e){out.textContent='ERROR: '+e.message}
}

function renderRelays(relays){
  const list=relays||[];
  const box=document.getElementById('relays');
  box.innerHTML='';
  list.forEach(x=>{
    box.innerHTML+=`<div class="relay"><div><b>${x.name}</b><br><span class="sub">GPIO ${x.gpio}</span></div><div class="row"><span class="badge ${x.on?'on':''}">${x.on?'ON':'OFF'}</span><button onclick="relay(${x.n},${x.on?'false':'true'})">Cambiar</button></div></div>`;
  });
  document.getElementById('relaysOn').textContent=list.filter(x=>x.on).length+'/'+list.length;
}

async function refresh(){
  try{
    const r=await fetch('/api/status',{cache:'no-store'});
    const s=await r.json();

    document.getElementById('identity').textContent=
      (s.hostname||'—')+' · FW '+s.firmware;

    document.getElementById('wifi').textContent=
      s.wifi.connected?'Conectado':s.wifi.mode.toUpperCase();
    document.getElementById('ip').textContent=s.wifi.ip;
    document.getElementById('simState').textContent=s.sim800l.enabled?
      (s.sim800l.last_response&&s.sim800l.last_response!=='TIMEOUT'?'Respondiendo':'Sin respuesta'):'Deshabilitado';

    renderRelays(s.relays);

    document.getElementById('wsInfo').textContent=
      s.io.ws2812_count+' LED(s), GPIO '+(s.io.ws2812_pin!==undefined?s.io.ws2812_pin:'—');

    document.getElementById('details').textContent=
      `SSID: ${s.wifi.ssid||'—'}\nRSSI: ${s.wifi.rssi} dBm\n`+
      `AP recuperación: ${s.wifi.recovery_ap?('activo ('+(s.wifi.recovery_ssid||'—')+')'):'inactivo'}\n`+
      `Hostname: ${s.hostname||'—'}\nFirmware: ${s.firmware}\n`+
      `SIM800L: baud ${s.sim800l.baud}, último cmd "${s.sim800l.last_command||'—'}" -> "${s.sim800l.last_response||'—'}"\n`+
      `Heap libre: ${s.free_heap} bytes\nUptime: ${Math.floor(s.uptime_ms/1000)} s`;
  }catch(e){
    document.getElementById('identity').textContent='Sin respuesta del dispositivo';
  }
}
refresh();setInterval(refresh,2500);
</script>
</body>
</html>
)NOPALHTML";


void setupWebServer() {
  server.on("/", HTTP_GET, []() {
    if (!checkApiAuth()) return;

    server.send_P(
      200,
      PSTR("text/html; charset=utf-8"),
      INDEX_HTML
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

  server.on("/api/relay", HTTP_POST, []() {
    if (!checkApiAuth()) return;

    const int relayNumber = server.arg("n").toInt();
    const int relayIndex = relayNumber - 1;

    if (!validRelayIndex(relayIndex)) {
      server.send(400, "text/plain", "ERR:INVALID_RELAY");
      return;
    }

    const bool on = server.arg("on") == "true" || server.arg("on") == "1";
    setRelay(relayIndex, on);

    server.send(200, "text/plain", "OK");
  });

  server.on("/api/led", HTTP_POST, []() {
    if (!checkApiAuth()) return;

#if WS2812_ENABLE

    const uint8_t red = clampColor(server.arg("r").toInt());
    const uint8_t green = clampColor(server.arg("g").toInt());
    const uint8_t blue = clampColor(server.arg("b").toInt());

    if (server.hasArg("start") || server.hasArg("count")) {
      const int start = server.arg("start").toInt();
      const int count = server.hasArg("count") ? server.arg("count").toInt() : 1;

      if (!setWs2812Segment(start, count, red, green, blue)) {
        server.send(400, "text/plain", "ERR:INVALID_SEGMENT");
        return;
      }
    } else {
      setWs2812Color(red, green, blue);
    }

    server.send(200, "text/plain", "OK");

#else

    server.send(501, "text/plain", "ERR:WS2812_DISABLED_ON_THIS_BUILD");

#endif
  });

  server.on("/api/sim", HTTP_POST, []() {
    if (!checkApiAuth()) return;

#if SIM800L_ENABLE

    const String action = server.arg("action");
    String atCommand;

    if (action == "AT") {
      atCommand = "AT";
    } else if (action == "INFO") {
      atCommand = "ATI";
    } else if (action == "CSQ") {
      atCommand = "AT+CSQ";
    } else if (action == "CREG") {
      atCommand = "AT+CREG?";
    } else if (action == "CCID") {
      atCommand = "AT+CCID";
    } else if (action == "IMEI") {
      atCommand = "AT+GSN";
    } else if (action == "OPERATOR") {
      atCommand = "AT+COPS?";
    } else if (action == "RAW") {
      String rawCommand = server.arg("raw");
      rawCommand.trim();

      if (!rawCommand.startsWith("AT") || rawCommand.length() > 100) {
        server.send(400, "text/plain", "ERR:INVALID_AT_COMMAND");
        return;
      }

      atCommand = rawCommand;
    } else {
      server.send(400, "text/plain", "ERR:UNKNOWN_ACTION");
      return;
    }

    server.send(200, "text/plain", transactSim800l(atCommand));

#else

    server.send(501, "text/plain", "ERR:SIM800L_DISABLED_ON_THIS_BUILD");

#endif
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
}


// ============================================================================
// ENCENDIDO DEL MÓDEM (T-Call v1.3 IP5306 — ver utilities.h)
// ============================================================================

#if SIM800L_ENABLE

void setupModemPower() {
#ifdef MODEM_RST
  // Mantener reset en alto (inactivo)
  pinMode(MODEM_RST, OUTPUT);
  digitalWrite(MODEM_RST, HIGH);
#endif

  pinMode(MODEM_PWRKEY, OUTPUT);
  pinMode(MODEM_POWER_ON, OUTPUT);

  // Encender primero la alimentación del módem
  digitalWrite(MODEM_POWER_ON, HIGH);

  pinMode(LED_GPIO, OUTPUT);
  digitalWrite(LED_GPIO, LED_ON);

  // Mantener el boost de 5V del IP5306 encendido; sin esto el SIM800L
  // pierde alimentación bajo carga y deja de responder a comandos AT.
  setupPMU();
}

#endif


// ============================================================================
// SIM800L: TRANSACCIONES AT
// ============================================================================

#if SIM800L_ENABLE

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
  uint32_t timeoutMs
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
  setupModemPower();

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

#if SIM800L_ENABLE

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

#if SIM800L_ENABLE

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
