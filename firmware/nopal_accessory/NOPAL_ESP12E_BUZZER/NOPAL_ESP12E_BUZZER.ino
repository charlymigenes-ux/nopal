/*
 * ============================================================================
 * NOPAL — Firmware de accesorios con buzzer para ESP-12E / ESP8266
 * ============================================================================
 *
 * Hardware objetivo:
 *   - ESP-12E Development Board (formato NodeMCU)
 *   - NodeMCU 1.0 (ESP-12E / ESP-12F)
 *   - ESP8266 con 4 MB de flash
 *
 * Funciones:
 *   - 4 relés directos, activos en LOW por defecto
 *   - Tira WS2812 / NeoPixel
 *   - Control individual, por rango y global de los píxeles
 *   - Escenas NOPAL: READY, WORKING, WAITING, ALARM, MAINTENANCE,
 *     DISCONNECTED y OFF
 *   - Buzzer activo con patrones no bloqueantes
 *   - Entrada analógica A0 con telemetría RAW 0-1023
 *   - Wi-Fi STA con reconexión automática
 *   - Punto de acceso de recuperación
 *   - Panel web NOPAL
 *   - API HTTP autenticada
 *   - ElegantOTA autenticado
 *   - mDNS: http://<hostname>.local/
 *   - Protocolo NOPAL por USB Serial a 115200 baudios
 *
 * Mapa de pines:
 *   Relé 1  -> D1 / GPIO5
 *   Relé 2  -> D2 / GPIO4
 *   Relé 3  -> D5 / GPIO14
 *   Relé 4  -> D6 / GPIO12
 *   WS2812  -> D7 / GPIO13
 *   LED azul integrado -> D4 / GPIO2, activo en LOW
 *   Buzzer activo -> D0 / GPIO16 (salida segura disponible)
 *   A0      -> entrada analógica
 *
 * Pines que este firmware evita para no comprometer el arranque:
 *   D3 / GPIO0
 *   D8 / GPIO15
 *   GPIO6-GPIO11: bus de la memoria flash. GPIO10 es SD3 y NO es libre.
 *
 * Comandos Serial principales:
 *   NOPAL:ID?
 *   NOPAL:NET?
 *   NOPAL:STATUS?
 *   NOPAL:R1:ON
 *   NOPAL:R1:OFF
 *   NOPAL:R1:TOGGLE
 *   NOPAL:R1?
 *   NOPAL:WS:255,0,0
 *   NOPAL:WS:ALL:255,0,0
 *   NOPAL:WS:PIXEL:1,255,0,0
 *   NOPAL:WS:RANGE:1,8,255,80,0
 *   NOPAL:WS:BRIGHTNESS:96
 *   NOPAL:WS:EFFECT:SOLID
 *   NOPAL:WS:EFFECT:BLINK
 *   NOPAL:WS:EFFECT:BREATHE
 *   NOPAL:WS:EFFECT:CHASE
 *   NOPAL:SCENE:READY
 *   NOPAL:SCENE:WORKING
 *   NOPAL:SCENE:WAITING
 *   NOPAL:SCENE:ALARM
 *   NOPAL:SCENE:MAINTENANCE
 *   NOPAL:SCENE:DISCONNECTED
 *   NOPAL:SCENE:OFF
 *   NOPAL:BUZZER?
 *   NOPAL:BUZZER:BEEP
 *   NOPAL:BUZZER:DOUBLE
 *   NOPAL:BUZZER:ON
 *   NOPAL:BUZZER:OFF
 *   NOPAL:BUZZER:ALARM
 *   NOPAL:A0?
 *   NOPAL:HELP?
 *   NOPAL:REBOOT
 *
 * Seguridad:
 *   - Los relés arrancan siempre apagados.
 *   - El panel web y todos los endpoints que modifican salidas requieren
 *     las mismas credenciales que ElegantOTA.
 *   - /api/status y /health son únicamente de lectura.
 *
 * Bibliotecas necesarias:
 *   - ESP8266 by ESP8266 Community
 *   - ElegantOTA
 *   - Adafruit NeoPixel
 * ============================================================================
 */

#include <Arduino.h>

#if !defined(ESP8266)
  #error "Selecciona 'NodeMCU 1.0 (ESP-12E Module)'. Este firmware es exclusivo para ESP8266."
#endif

#include "secrets.h"

#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <ESP8266mDNS.h>
#include <ElegantOTA.h>
#include <Adafruit_NeoPixel.h>


// ============================================================================
// VALORES POR DEFECTO PARA SECRETS.H ANTIGUOS O INCOMPLETOS
// ============================================================================

#ifndef NOPAL_DEVICE_NAME
  #define NOPAL_DEVICE_NAME "NOPAL ESP-12E"
#endif

#ifndef NOPAL_HOSTNAME
  #define NOPAL_HOSTNAME "nopal-esp12e"
#endif

#ifndef NOPAL_WIFI_SSID
  #define NOPAL_WIFI_SSID "TU_RED_WIFI"
#endif

#ifndef NOPAL_WIFI_PASSWORD
  #define NOPAL_WIFI_PASSWORD ""
#endif

#ifndef NOPAL_AP_PASSWORD
  #define NOPAL_AP_PASSWORD "nopal8266"
#endif

#ifndef NOPAL_OTA_USERNAME
  #define NOPAL_OTA_USERNAME "admin"
#endif

#ifndef NOPAL_OTA_PASSWORD
  #define NOPAL_OTA_PASSWORD "nopalota"
#endif

#ifndef NOPAL_WS2812_COUNT
  #define NOPAL_WS2812_COUNT 7
#endif

#ifndef NOPAL_WS2812_BRIGHTNESS
  #define NOPAL_WS2812_BRIGHTNESS 96
#endif

#ifndef NOPAL_RELAY_ACTIVE_LOW
  #define NOPAL_RELAY_ACTIVE_LOW 1
#endif

#ifndef NOPAL_BUZZER_PIN
  #define NOPAL_BUZZER_PIN 16
#endif

#ifndef NOPAL_BUZZER_ACTIVE_HIGH
  #define NOPAL_BUZZER_ACTIVE_HIGH 1
#endif

#ifndef NOPAL_BUZZER_SCENE_SOUNDS
  #define NOPAL_BUZZER_SCENE_SOUNDS 1
#endif

#ifndef NOPAL_KEEP_RECOVERY_AP
  #define NOPAL_KEEP_RECOVERY_AP 0
#endif

#ifndef NOPAL_RELAY1_NAME
  #define NOPAL_RELAY1_NAME "Relé 1"
#endif

#ifndef NOPAL_RELAY2_NAME
  #define NOPAL_RELAY2_NAME "Relé 2"
#endif

#ifndef NOPAL_RELAY3_NAME
  #define NOPAL_RELAY3_NAME "Relé 3"
#endif

#ifndef NOPAL_RELAY4_NAME
  #define NOPAL_RELAY4_NAME "Relé 4"
#endif


// ============================================================================
// IDENTIFICACIÓN Y TIEMPOS
// ============================================================================

#define FW_VERSION "2.1.0"
#define NOPAL_PROTOCOL_VERSION 2

constexpr uint16_t HTTP_PORT = 80;
constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 15000UL;
constexpr uint32_t WIFI_RECONNECT_INTERVAL_MS = 15000UL;
constexpr uint32_t RECOVERY_AP_SHUTDOWN_DELAY_MS = 30000UL;
constexpr uint32_t STATUS_LED_SLOW_BLINK_MS = 350UL;
constexpr uint32_t STATUS_LED_FAST_BLINK_MS = 100UL;
constexpr uint32_t SERIAL_MAX_LINE_LENGTH = 191UL;
constexpr uint32_t DEFAULT_EFFECT_PERIOD_MS = 1200UL;

static_assert(NOPAL_WS2812_COUNT > 0, "NOPAL_WS2812_COUNT debe ser mayor que cero.");
static_assert(NOPAL_WS2812_COUNT <= 300, "Limita NOPAL_WS2812_COUNT a 300 píxeles o menos.");

#if NOPAL_BUZZER_PIN == 10
  #error "GPIO10/SD3 pertenece al bus de la memoria flash del ESP8266. Usa D0/GPIO16 para el buzzer."
#endif


// ============================================================================
// MAPA DE PINES — ESP-12E DEVELOPMENT BOARD
// ============================================================================
//
// Se usan números GPIO reales para que no haya confusión entre D1, D2, etc.
//

constexpr uint8_t RELAY_COUNT = 4;
constexpr uint8_t RELAY_PINS[RELAY_COUNT] = {
  5,   // D1
  4,   // D2
  14,  // D5
  12   // D6
};

const char* const RELAY_NAMES[RELAY_COUNT] = {
  NOPAL_RELAY1_NAME,
  NOPAL_RELAY2_NAME,
  NOPAL_RELAY3_NAME,
  NOPAL_RELAY4_NAME
};

constexpr uint8_t WS2812_PIN = 13;      // D7
constexpr uint8_t STATUS_LED_PIN = 2;   // D4, LED integrado activo en LOW
constexpr bool STATUS_LED_ACTIVE_LOW = true;
constexpr uint8_t BUZZER_PIN = NOPAL_BUZZER_PIN; // D0 / GPIO16
constexpr bool BUZZER_ACTIVE_HIGH = NOPAL_BUZZER_ACTIVE_HIGH != 0;


// ============================================================================
// OBJETOS PRINCIPALES
// ============================================================================

ESP8266WebServer server(HTTP_PORT);

Adafruit_NeoPixel strip(
  NOPAL_WS2812_COUNT,
  WS2812_PIN,
  NEO_GRB + NEO_KHZ800
);


// ============================================================================
// ESTADO GLOBAL
// ============================================================================

String serialInputLine;
String recoveryApSsid;

bool webServerStarted = false;
bool mdnsStarted = false;
bool recoveryApActive = false;
bool wifiWasConnected = false;
bool otaInProgress = false;

uint32_t lastWifiReconnectAttemptMs = 0;
uint32_t wifiConnectedSinceMs = 0;
uint32_t scheduledRebootAtMs = 0;


// ============================================================================
// ESTADO DEL BUZZER ACTIVO
// ============================================================================

struct BuzzerStep {
  bool on;
  uint16_t durationMs;
};

enum class BuzzerPattern : uint8_t {
  OFF,
  CONTINUOUS,
  BEEP,
  DOUBLE_BEEP,
  READY,
  WORKING,
  WAITING,
  ALARM,
  MAINTENANCE,
  DISCONNECTED
};

const BuzzerStep BUZZER_PATTERN_CONTINUOUS[] = {
  {true, 1000}
};

const BuzzerStep BUZZER_PATTERN_BEEP[] = {
  {true, 120}, {false, 1}
};

const BuzzerStep BUZZER_PATTERN_DOUBLE[] = {
  {true, 100}, {false, 100}, {true, 100}, {false, 1}
};

const BuzzerStep BUZZER_PATTERN_READY[] = {
  {true, 80}, {false, 80}, {true, 180}, {false, 1}
};

const BuzzerStep BUZZER_PATTERN_WORKING[] = {
  {true, 60}, {false, 1}
};

const BuzzerStep BUZZER_PATTERN_WAITING[] = {
  {true, 100}, {false, 900}
};

const BuzzerStep BUZZER_PATTERN_ALARM[] = {
  {true, 220}, {false, 150}
};

const BuzzerStep BUZZER_PATTERN_MAINTENANCE[] = {
  {true, 80}, {false, 80}, {true, 80}, {false, 80}, {true, 80}, {false, 1}
};

const BuzzerStep BUZZER_PATTERN_DISCONNECTED[] = {
  {true, 450}, {false, 550}
};

BuzzerPattern buzzerPattern = BuzzerPattern::OFF;
const BuzzerStep* activeBuzzerSteps = nullptr;
uint8_t activeBuzzerStepCount = 0;
uint8_t activeBuzzerStepIndex = 0;
bool buzzerPatternRepeats = false;
bool buzzerOutputOn = false;
uint32_t buzzerNextStepAtMs = 0;

// ============================================================================
// ESTADO DE LOS NEOPIXEL
// ============================================================================

enum class StripEffect : uint8_t {
  OFF,
  SOLID,
  BLINK,
  BREATHE,
  CHASE,
  CUSTOM
};

StripEffect stripEffect = StripEffect::OFF;

uint8_t stripBaseRed = 0;
uint8_t stripBaseGreen = 0;
uint8_t stripBaseBlue = 0;
uint8_t stripBrightness = NOPAL_WS2812_BRIGHTNESS;

uint32_t stripEffectPeriodMs = DEFAULT_EFFECT_PERIOD_MS;
uint32_t lastStripFrameMs = 0;
bool stripDirty = true;

String activeScene = "OFF";

uint32_t customPixelColors[NOPAL_WS2812_COUNT];


// ============================================================================
// PANEL WEB NOPAL
// ============================================================================

const char INDEX_HTML[] PROGMEM = R"NOPALHTML(
<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NOPAL ESP-12E</title>
<style>
:root{
  color-scheme:dark;
  --bg:#101719;
  --panel:#182326;
  --panel2:#1e2c2f;
  --line:#304246;
  --text:#edf6f1;
  --muted:#9bb0aa;
  --green:#65d690;
  --amber:#f4b55f;
  --red:#ff6c6c;
  --cyan:#62c7dc;
}
*{box-sizing:border-box}
body{
  margin:0;
  min-height:100vh;
  background:
    radial-gradient(circle at 20% 0%,rgba(101,214,144,.10),transparent 35%),
    linear-gradient(180deg,#11191b,#0c1214);
  color:var(--text);
  font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
}
main{max-width:1080px;margin:auto;padding:24px}
header{
  display:flex;justify-content:space-between;align-items:center;
  gap:16px;margin-bottom:20px
}
.brand{display:flex;align-items:center;gap:13px}
.logo{
  width:44px;height:44px;border-radius:14px;display:grid;place-items:center;
  background:linear-gradient(145deg,#276340,#173326);
  border:1px solid #4d8b63;font-size:24px
}
h1{font-size:21px;margin:0}.sub{color:var(--muted);font-size:13px}
a{color:var(--green);text-decoration:none}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px}
.card{
  grid-column:span 6;background:linear-gradient(145deg,var(--panel),var(--panel2));
  border:1px solid var(--line);border-radius:18px;padding:18px;
  box-shadow:0 14px 35px rgba(0,0,0,.20)
}
.card.full{grid-column:span 12}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#c5d8d2;margin:0 0 14px}
.relays{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.relay{
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:12px;border-radius:13px;background:#111b1d;border:1px solid #2d4043
}
.badge{font-size:12px;padding:4px 9px;border-radius:999px;background:#253336;color:var(--muted)}
.badge.on{background:rgba(101,214,144,.16);color:var(--green)}
button,.button{
  border:1px solid #3a5155;background:#243438;color:var(--text);
  padding:9px 12px;border-radius:11px;cursor:pointer;font-weight:650
}
button:hover,.button:hover{border-color:#6a8a8f}
button.green{background:#205d3a;border-color:#39875a}
button.red{background:#6a2929;border-color:#a64444}
button.amber{background:#68491e;border-color:#9b7132}
.row{display:flex;flex-wrap:wrap;gap:9px;align-items:center}
.scenes{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
input[type=color]{width:55px;height:40px;padding:3px;background:#101719;border:1px solid #3a5155;border-radius:10px}
input[type=number]{width:82px}
input[type=number],input[type=range]{
  background:#101719;color:var(--text);border:1px solid #3a5155;
  border-radius:9px;padding:8px
}
.statgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.stat{padding:11px;border-radius:12px;background:#111b1d;border:1px solid #2c3d40}
.stat b{display:block;font-size:17px}.stat span{font-size:11px;color:var(--muted);text-transform:uppercase}
pre{
  white-space:pre-wrap;word-break:break-word;background:#0c1315;
  padding:12px;border-radius:12px;border:1px solid #26373a;color:#acd4c0
}
footer{margin:18px 2px;color:var(--muted);font-size:12px}
@media(max-width:760px){
  .card,.card.full{grid-column:span 12}
  .scenes{grid-template-columns:repeat(2,1fr)}
  .statgrid{grid-template-columns:repeat(2,1fr)}
}
</style>
</head>
<body>
<main>
<header>
  <div class="brand">
    <div class="logo">🌵</div>
    <div><h1>NOPAL · ESP-12E</h1><div class="sub" id="identity">Cargando estado…</div></div>
  </div>
  <a class="button" href="/update">Actualizar firmware</a>
</header>

<section class="grid">
  <article class="card">
    <h2>Relés</h2>
    <div class="relays" id="relays"></div>
  </article>

  <article class="card">
    <h2>Escenas del taller</h2>
    <div class="scenes">
      <button class="green" onclick="scene('READY')">Listo</button>
      <button onclick="scene('WORKING')">Trabajando</button>
      <button class="amber" onclick="scene('WAITING')">En espera</button>
      <button class="red" onclick="scene('ALARM')">Alarma</button>
      <button onclick="scene('MAINTENANCE')">Mantenimiento</button>
      <button onclick="scene('DISCONNECTED')">Desconectado</button>
      <button onclick="scene('OFF')">Apagar LEDs</button>
    </div>
  </article>

  <article class="card">
    <h2>NeoPixel global</h2>
    <div class="row">
      <input id="color" type="color" value="#41d17d">
      <button onclick="sendColor()">Aplicar color</button>
      <button onclick="effect('BLINK')">Parpadeo</button>
      <button onclick="effect('BREATHE')">Respirar</button>
      <button onclick="effect('CHASE')">Carrera</button>
    </div>
    <div class="row" style="margin-top:14px">
      <label>Brillo</label>
      <input id="brightness" type="range" min="0" max="255" value="96"
             oninput="document.getElementById('bval').textContent=this.value">
      <b id="bval">96</b>
      <button onclick="setBrightness()">Guardar</button>
    </div>
  </article>

  <article class="card">
    <h2>NeoPixel individual</h2>
    <div class="row">
      <label>LED</label>
      <input id="pixel" type="number" min="1" value="1">
      <input id="pixelColor" type="color" value="#ff8c32">
      <button onclick="sendPixel()">Aplicar</button>
    </div>
    <p class="sub">La numeración empieza en 1.</p>
  </article>

  <article class="card">
    <h2>Buzzer activo</h2>
    <div class="row">
      <button onclick="buzzer('BEEP')">Beep</button>
      <button onclick="buzzer('DOUBLE')">Doble beep</button>
      <button class="green" onclick="buzzer('READY')">Listo</button>
      <button class="amber" onclick="buzzer('WAITING')">Espera</button>
      <button class="red" onclick="buzzer('ALARM')">Alarma</button>
      <button onclick="buzzer('OFF')">Silenciar</button>
    </div>
    <p class="sub">Buzzer activo en D0 / GPIO16. Los patrones no bloquean Wi-Fi, OTA ni el panel.</p>
  </article>

  <article class="card full">
    <h2>Estado del dispositivo</h2>
    <div class="statgrid">
      <div class="stat"><b id="wifi">—</b><span>Wi-Fi</span></div>
      <div class="stat"><b id="ip">—</b><span>Dirección IP</span></div>
      <div class="stat"><b id="scene">—</b><span>Escena</span></div>
      <div class="stat"><b id="a0">—</b><span>Entrada A0</span></div>
      <div class="stat"><b id="buzzerState">—</b><span>Buzzer</span></div>
    </div>
    <pre id="details">Esperando datos…</pre>
  </article>
</section>

<footer>NOPAL Firmware 2.1 · ESP-12E Development Board / ESP8266</footer>
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
async function relay(n,action){try{await post('/api/relay',{n,action})}catch(e){alert(e.message)}}
async function scene(name){try{await post('/api/scene',{name})}catch(e){alert(e.message)}}
async function effect(name){try{await post('/api/ws',{effect:name})}catch(e){alert(e.message)}}
async function buzzer(action){try{await post('/api/buzzer',{action})}catch(e){alert(e.message)}}
async function sendColor(){
  const [r,g,b]=rgb(document.getElementById('color').value);
  try{await post('/api/ws',{r,g,b,effect:'SOLID'})}catch(e){alert(e.message)}
}
async function sendPixel(){
  const [r,g,b]=rgb(document.getElementById('pixelColor').value);
  const n=document.getElementById('pixel').value;
  try{await post('/api/ws/pixel',{n,r,g,b})}catch(e){alert(e.message)}
}
async function setBrightness(){
  try{await post('/api/ws',{brightness:document.getElementById('brightness').value})}catch(e){alert(e.message)}
}
async function refresh(){
  try{
    const r=await fetch('/api/status',{cache:'no-store'});
    const s=await r.json();
    document.getElementById('identity').textContent=s.device+' · '+s.board+' · FW '+s.firmware;
    document.getElementById('wifi').textContent=s.wifi.connected?'Conectado':s.wifi.mode.toUpperCase();
    document.getElementById('ip').textContent=s.wifi.ip;
    document.getElementById('scene').textContent=s.led.scene;
    document.getElementById('a0').textContent=s.inputs.a0_raw;
    document.getElementById('buzzerState').textContent=s.buzzer.pattern;
    document.getElementById('brightness').value=s.led.brightness;
    document.getElementById('bval').textContent=s.led.brightness;
    const box=document.getElementById('relays');
    box.innerHTML='';
    s.relays.forEach((x,i)=>{
      box.innerHTML+=`<div class="relay"><div><b>${x.name}</b><br><span class="sub">D${[1,2,5,6][i]} · GPIO ${x.gpio}</span></div><div class="row"><span class="badge ${x.on?'on':''}">${x.on?'ON':'OFF'}</span><button onclick="relay(${i+1},'toggle')">Cambiar</button></div></div>`;
    });
    document.getElementById('details').textContent=
      `SSID: ${s.wifi.ssid||'—'}\nRSSI: ${s.wifi.rssi} dBm\nAP recuperación: ${s.wifi.recovery_ap?'activo':'inactivo'}\n`+
      `NeoPixel: ${s.led.count} LED(s), GPIO ${s.led.gpio}, efecto ${s.led.effect}\n`+
      `Buzzer: GPIO ${s.buzzer.gpio}, patrón ${s.buzzer.pattern}, salida ${s.buzzer.on?'ON':'OFF'}\n`+
      `Heap libre: ${s.system.free_heap} bytes\nUptime: ${Math.floor(s.system.uptime_ms/1000)} s\nReset: ${s.system.reset_reason}`;
  }catch(e){
    document.getElementById('identity').textContent='Sin respuesta del dispositivo';
  }
}
refresh();setInterval(refresh,2500);
</script>
</body>
</html>
)NOPALHTML";


// ============================================================================
// PROTOTIPOS
// ============================================================================

bool wifiCredentialsConfigured();
void serviceStatusLed();
void startMdnsIfPossible();
void renderStripNow();
void applyScene(const String& requestedScene);
void serviceBuzzer();
bool startBuzzerFromText(String patternText);
String buzzerPatternName(BuzzerPattern pattern);
String buildStatusJson();
void scheduleReboot(uint32_t delayMs);


// ============================================================================
// UTILIDADES
// ============================================================================

uint8_t clampByte(int value) {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return static_cast<uint8_t>(value);
}


uint32_t maxU32(uint32_t first, uint32_t second) {
  return first > second ? first : second;
}


bool isUnsignedNumber(const String& text) {
  if (text.length() == 0) return false;

  for (size_t index = 0; index < text.length(); index++) {
    if (!isDigit(text.charAt(index))) return false;
  }

  return true;
}


String jsonEscape(const String& input) {
  String output;
  output.reserve(input.length() + 16);

  for (size_t index = 0; index < input.length(); index++) {
    const char character = input.charAt(index);

    switch (character) {
      case '\\': output += F("\\\\"); break;
      case '"':  output += F("\\\""); break;
      case '\n': output += F("\\n"); break;
      case '\r': output += F("\\r"); break;
      case '\t': output += F("\\t"); break;
      default:   output += character; break;
    }
  }

  return output;
}


String chipSuffix() {
  char suffix[9] = {0};

  snprintf(
    suffix,
    sizeof(suffix),
    "%06lX",
    static_cast<unsigned long>(ESP.getChipId())
  );

  return String(suffix);
}


String effectName(StripEffect effect) {
  switch (effect) {
    case StripEffect::OFF:     return F("OFF");
    case StripEffect::SOLID:   return F("SOLID");
    case StripEffect::BLINK:   return F("BLINK");
    case StripEffect::BREATHE: return F("BREATHE");
    case StripEffect::CHASE:   return F("CHASE");
    case StripEffect::CUSTOM:  return F("CUSTOM");
  }

  return F("UNKNOWN");
}


bool parseRgbCsv(
  const String& text,
  uint8_t& red,
  uint8_t& green,
  uint8_t& blue
) {
  int parsedRed = 0;
  int parsedGreen = 0;
  int parsedBlue = 0;
  char trailing = '\0';

  const int parsedValues = sscanf(
    text.c_str(),
    "%d,%d,%d%c",
    &parsedRed,
    &parsedGreen,
    &parsedBlue,
    &trailing
  );

  if (parsedValues != 3) return false;

  red = clampByte(parsedRed);
  green = clampByte(parsedGreen);
  blue = clampByte(parsedBlue);

  return true;
}


uint8_t scaledComponent(
  uint8_t component,
  uint8_t animationLevel
) {
  const uint32_t scaled =
    static_cast<uint32_t>(component) *
    static_cast<uint32_t>(stripBrightness) *
    static_cast<uint32_t>(animationLevel);

  return static_cast<uint8_t>((scaled + 32512UL) / 65025UL);
}


uint32_t makeRawColor(uint8_t red, uint8_t green, uint8_t blue) {
  return
    (static_cast<uint32_t>(red) << 16) |
    (static_cast<uint32_t>(green) << 8) |
    static_cast<uint32_t>(blue);
}


void unpackRawColor(
  uint32_t color,
  uint8_t& red,
  uint8_t& green,
  uint8_t& blue
) {
  red = static_cast<uint8_t>((color >> 16) & 0xFF);
  green = static_cast<uint8_t>((color >> 8) & 0xFF);
  blue = static_cast<uint8_t>(color & 0xFF);
}


// ============================================================================
// RELÉS
// ============================================================================

bool validRelayIndex(int index) {
  return index >= 0 && index < RELAY_COUNT;
}


void setRelay(uint8_t index, bool on) {
  if (index >= RELAY_COUNT) return;

  const bool activeLow = NOPAL_RELAY_ACTIVE_LOW != 0;
  const uint8_t outputLevel =
    activeLow
      ? (on ? LOW : HIGH)
      : (on ? HIGH : LOW);

  digitalWrite(RELAY_PINS[index], outputLevel);
}


bool getRelay(uint8_t index) {
  if (index >= RELAY_COUNT) return false;

  const bool pinHigh = digitalRead(RELAY_PINS[index]) == HIGH;
  const bool activeLow = NOPAL_RELAY_ACTIVE_LOW != 0;

  return activeLow ? !pinHigh : pinHigh;
}


void initializeRelaysSafely() {
  const bool activeLow = NOPAL_RELAY_ACTIVE_LOW != 0;
  const uint8_t offLevel = activeLow ? HIGH : LOW;

  for (uint8_t index = 0; index < RELAY_COUNT; index++) {
    // Precarga el nivel apagado antes de cambiar a OUTPUT para reducir
    // al mínimo cualquier pulso accidental durante setup().
    digitalWrite(RELAY_PINS[index], offLevel);
    pinMode(RELAY_PINS[index], OUTPUT);
    setRelay(index, false);
  }
}


// ============================================================================
// LED DE ESTADO INTEGRADO
// ============================================================================

void setStatusLed(bool on) {
  const uint8_t level =
    STATUS_LED_ACTIVE_LOW
      ? (on ? LOW : HIGH)
      : (on ? HIGH : LOW);

  digitalWrite(STATUS_LED_PIN, level);
}


void serviceStatusLed() {
  static uint32_t lastToggleMs = 0;
  static bool ledOn = false;

  const uint32_t now = millis();

  if (otaInProgress) {
    if (now - lastToggleMs >= STATUS_LED_FAST_BLINK_MS) {
      lastToggleMs = now;
      ledOn = !ledOn;
      setStatusLed(ledOn);
    }
    return;
  }

  if (WiFi.status() == WL_CONNECTED) {
    if (!ledOn) {
      ledOn = true;
      setStatusLed(true);
    }
    return;
  }

  if (now - lastToggleMs >= STATUS_LED_SLOW_BLINK_MS) {
    lastToggleMs = now;
    ledOn = !ledOn;
    setStatusLed(ledOn);
  }
}


// ============================================================================
// BUZZER ACTIVO — PATRONES NO BLOQUEANTES
// ============================================================================

void setBuzzerOutput(bool on) {
  buzzerOutputOn = on;

  const uint8_t level =
    BUZZER_ACTIVE_HIGH
      ? (on ? HIGH : LOW)
      : (on ? LOW : HIGH);

  digitalWrite(BUZZER_PIN, level);
}


void initializeBuzzerSafely() {
  const uint8_t offLevel = BUZZER_ACTIVE_HIGH ? LOW : HIGH;

  digitalWrite(BUZZER_PIN, offLevel);
  pinMode(BUZZER_PIN, OUTPUT);
  setBuzzerOutput(false);
}


String buzzerPatternName(BuzzerPattern pattern) {
  switch (pattern) {
    case BuzzerPattern::OFF:          return F("OFF");
    case BuzzerPattern::CONTINUOUS:   return F("ON");
    case BuzzerPattern::BEEP:         return F("BEEP");
    case BuzzerPattern::DOUBLE_BEEP:  return F("DOUBLE");
    case BuzzerPattern::READY:        return F("READY");
    case BuzzerPattern::WORKING:      return F("WORKING");
    case BuzzerPattern::WAITING:      return F("WAITING");
    case BuzzerPattern::ALARM:        return F("ALARM");
    case BuzzerPattern::MAINTENANCE:  return F("MAINTENANCE");
    case BuzzerPattern::DISCONNECTED: return F("DISCONNECTED");
  }

  return F("UNKNOWN");
}


void stopBuzzer() {
  buzzerPattern = BuzzerPattern::OFF;
  activeBuzzerSteps = nullptr;
  activeBuzzerStepCount = 0;
  activeBuzzerStepIndex = 0;
  buzzerPatternRepeats = false;
  buzzerNextStepAtMs = 0;
  setBuzzerOutput(false);
}


void startBuzzerPattern(
  BuzzerPattern pattern,
  const BuzzerStep* steps,
  uint8_t stepCount,
  bool repeats
) {
  if (pattern == BuzzerPattern::OFF || steps == nullptr || stepCount == 0) {
    stopBuzzer();
    return;
  }

  buzzerPattern = pattern;
  activeBuzzerSteps = steps;
  activeBuzzerStepCount = stepCount;
  activeBuzzerStepIndex = 0;
  buzzerPatternRepeats = repeats;

  setBuzzerOutput(activeBuzzerSteps[0].on);
  buzzerNextStepAtMs = millis() + maxU32(1UL, activeBuzzerSteps[0].durationMs);
}


bool startBuzzerFromText(String patternText) {
  patternText.trim();
  patternText.toUpperCase();

  if (patternText == F("OFF") || patternText == F("STOP")) {
    stopBuzzer();
    return true;
  }

  if (patternText == F("ON") || patternText == F("CONTINUOUS")) {
    startBuzzerPattern(
      BuzzerPattern::CONTINUOUS,
      BUZZER_PATTERN_CONTINUOUS,
      sizeof(BUZZER_PATTERN_CONTINUOUS) / sizeof(BUZZER_PATTERN_CONTINUOUS[0]),
      true
    );
    return true;
  }

  if (patternText == F("BEEP")) {
    startBuzzerPattern(
      BuzzerPattern::BEEP,
      BUZZER_PATTERN_BEEP,
      sizeof(BUZZER_PATTERN_BEEP) / sizeof(BUZZER_PATTERN_BEEP[0]),
      false
    );
    return true;
  }

  if (patternText == F("DOUBLE") || patternText == F("DOUBLE_BEEP")) {
    startBuzzerPattern(
      BuzzerPattern::DOUBLE_BEEP,
      BUZZER_PATTERN_DOUBLE,
      sizeof(BUZZER_PATTERN_DOUBLE) / sizeof(BUZZER_PATTERN_DOUBLE[0]),
      false
    );
    return true;
  }

  if (patternText == F("READY")) {
    startBuzzerPattern(
      BuzzerPattern::READY,
      BUZZER_PATTERN_READY,
      sizeof(BUZZER_PATTERN_READY) / sizeof(BUZZER_PATTERN_READY[0]),
      false
    );
    return true;
  }

  if (patternText == F("WORKING")) {
    startBuzzerPattern(
      BuzzerPattern::WORKING,
      BUZZER_PATTERN_WORKING,
      sizeof(BUZZER_PATTERN_WORKING) / sizeof(BUZZER_PATTERN_WORKING[0]),
      false
    );
    return true;
  }

  if (patternText == F("WAITING")) {
    startBuzzerPattern(
      BuzzerPattern::WAITING,
      BUZZER_PATTERN_WAITING,
      sizeof(BUZZER_PATTERN_WAITING) / sizeof(BUZZER_PATTERN_WAITING[0]),
      false
    );
    return true;
  }

  if (patternText == F("ALARM")) {
    startBuzzerPattern(
      BuzzerPattern::ALARM,
      BUZZER_PATTERN_ALARM,
      sizeof(BUZZER_PATTERN_ALARM) / sizeof(BUZZER_PATTERN_ALARM[0]),
      true
    );
    return true;
  }

  if (patternText == F("MAINTENANCE")) {
    startBuzzerPattern(
      BuzzerPattern::MAINTENANCE,
      BUZZER_PATTERN_MAINTENANCE,
      sizeof(BUZZER_PATTERN_MAINTENANCE) / sizeof(BUZZER_PATTERN_MAINTENANCE[0]),
      false
    );
    return true;
  }

  if (patternText == F("DISCONNECTED")) {
    startBuzzerPattern(
      BuzzerPattern::DISCONNECTED,
      BUZZER_PATTERN_DISCONNECTED,
      sizeof(BUZZER_PATTERN_DISCONNECTED) / sizeof(BUZZER_PATTERN_DISCONNECTED[0]),
      true
    );
    return true;
  }

  return false;
}


void serviceBuzzer() {
  if (
    buzzerPattern == BuzzerPattern::OFF ||
    activeBuzzerSteps == nullptr ||
    activeBuzzerStepCount == 0
  ) {
    return;
  }

  if (static_cast<int32_t>(millis() - buzzerNextStepAtMs) < 0) {
    return;
  }

  activeBuzzerStepIndex++;

  if (activeBuzzerStepIndex >= activeBuzzerStepCount) {
    if (!buzzerPatternRepeats) {
      stopBuzzer();
      return;
    }

    activeBuzzerStepIndex = 0;
  }

  const BuzzerStep& step = activeBuzzerSteps[activeBuzzerStepIndex];
  setBuzzerOutput(step.on);
  buzzerNextStepAtMs = millis() + maxU32(1UL, step.durationMs);
}


void playSceneBuzzer(const String& scene) {
#if NOPAL_BUZZER_SCENE_SOUNDS == 1
  startBuzzerFromText(scene);
#else
  (void) scene;
#endif
}

// ============================================================================
// WS2812 / NEOPIXEL
// ============================================================================

void setStripBaseColor(
  uint8_t red,
  uint8_t green,
  uint8_t blue,
  StripEffect effect
) {
  stripBaseRed = red;
  stripBaseGreen = green;
  stripBaseBlue = blue;
  stripEffect = effect;
  stripDirty = true;
}


void setStripBrightness(uint8_t brightness) {
  stripBrightness = brightness;
  stripDirty = true;
}


void setCustomAll(uint8_t red, uint8_t green, uint8_t blue) {
  const uint32_t color = makeRawColor(red, green, blue);

  for (uint16_t index = 0; index < NOPAL_WS2812_COUNT; index++) {
    customPixelColors[index] = color;
  }

  stripEffect = StripEffect::CUSTOM;
  activeScene = F("CUSTOM");
  stripDirty = true;
}


bool setCustomPixel(
  uint16_t oneBasedPixel,
  uint8_t red,
  uint8_t green,
  uint8_t blue
) {
  if (
    oneBasedPixel < 1 ||
    oneBasedPixel > NOPAL_WS2812_COUNT
  ) {
    return false;
  }

  customPixelColors[oneBasedPixel - 1] =
    makeRawColor(red, green, blue);

  stripEffect = StripEffect::CUSTOM;
  activeScene = F("CUSTOM");
  stripDirty = true;

  return true;
}


bool setCustomRange(
  uint16_t oneBasedStart,
  uint16_t oneBasedEnd,
  uint8_t red,
  uint8_t green,
  uint8_t blue
) {
  if (
    oneBasedStart < 1 ||
    oneBasedEnd < 1 ||
    oneBasedStart > oneBasedEnd ||
    oneBasedEnd > NOPAL_WS2812_COUNT
  ) {
    return false;
  }

  const uint32_t color = makeRawColor(red, green, blue);

  for (
    uint16_t pixel = oneBasedStart;
    pixel <= oneBasedEnd;
    pixel++
  ) {
    customPixelColors[pixel - 1] = color;
  }

  stripEffect = StripEffect::CUSTOM;
  activeScene = F("CUSTOM");
  stripDirty = true;

  return true;
}


void renderSolidFrame(uint8_t animationLevel) {
  const uint8_t red =
    scaledComponent(stripBaseRed, animationLevel);
  const uint8_t green =
    scaledComponent(stripBaseGreen, animationLevel);
  const uint8_t blue =
    scaledComponent(stripBaseBlue, animationLevel);

  strip.fill(strip.Color(red, green, blue));
  strip.show();
}


void renderCustomFrame() {
  for (uint16_t index = 0; index < NOPAL_WS2812_COUNT; index++) {
    uint8_t red;
    uint8_t green;
    uint8_t blue;

    unpackRawColor(
      customPixelColors[index],
      red,
      green,
      blue
    );

    strip.setPixelColor(
      index,
      strip.Color(
        scaledComponent(red, 255),
        scaledComponent(green, 255),
        scaledComponent(blue, 255)
      )
    );
  }

  strip.show();
}


void renderChaseFrame(uint32_t now) {
  const uint32_t stepDuration =
    maxU32(
      40UL,
      stripEffectPeriodMs /
        static_cast<uint32_t>(NOPAL_WS2812_COUNT)
    );

  const uint16_t activePixel =
    static_cast<uint16_t>(
      (now / stepDuration) % NOPAL_WS2812_COUNT
    );

  for (uint16_t index = 0; index < NOPAL_WS2812_COUNT; index++) {
    uint8_t level = 25;

    if (index == activePixel) {
      level = 255;
    } else if (
      index ==
      ((activePixel + NOPAL_WS2812_COUNT - 1) % NOPAL_WS2812_COUNT)
    ) {
      level = 90;
    }

    strip.setPixelColor(
      index,
      strip.Color(
        scaledComponent(stripBaseRed, level),
        scaledComponent(stripBaseGreen, level),
        scaledComponent(stripBaseBlue, level)
      )
    );
  }

  strip.show();
}


void renderStripNow() {
  const uint32_t now = millis();

  switch (stripEffect) {
    case StripEffect::OFF:
      strip.clear();
      strip.show();
      break;

    case StripEffect::SOLID:
      renderSolidFrame(255);
      break;

    case StripEffect::BLINK: {
      const uint32_t halfPeriod =
        max(100UL, stripEffectPeriodMs / 2UL);

      const bool visible =
        ((now / halfPeriod) % 2UL) == 0UL;

      renderSolidFrame(visible ? 255 : 0);
      break;
    }

    case StripEffect::BREATHE: {
      const uint32_t period =
        maxU32(400UL, stripEffectPeriodMs);

      const uint32_t position = now % period;
      const uint32_t half = period / 2UL;

      uint8_t level = 0;

      if (position <= half) {
        level = static_cast<uint8_t>(
          (position * 255UL) / maxU32(1UL, half)
        );
      } else {
        level = static_cast<uint8_t>(
          ((period - position) * 255UL) /
          maxU32(1UL, period - half)
        );
      }

      // Evita que la respiración quede completamente invisible.
      level = static_cast<uint8_t>(20 + ((level * 235UL) / 255UL));

      renderSolidFrame(level);
      break;
    }

    case StripEffect::CHASE:
      renderChaseFrame(now);
      break;

    case StripEffect::CUSTOM:
      renderCustomFrame();
      break;
  }

  stripDirty = false;
}


void serviceStrip() {
  const uint32_t now = millis();

  const bool animated =
    stripEffect == StripEffect::BLINK ||
    stripEffect == StripEffect::BREATHE ||
    stripEffect == StripEffect::CHASE;

  if (!stripDirty && !animated) return;

  if (animated && now - lastStripFrameMs < 25UL) return;

  lastStripFrameMs = now;
  renderStripNow();
}


bool setEffectFromText(String effectText) {
  effectText.trim();
  effectText.toUpperCase();

  if (effectText == F("OFF")) {
    stripEffect = StripEffect::OFF;
  } else if (effectText == F("SOLID")) {
    stripEffect = StripEffect::SOLID;
  } else if (effectText == F("BLINK")) {
    stripEffect = StripEffect::BLINK;
  } else if (effectText == F("BREATHE")) {
    stripEffect = StripEffect::BREATHE;
  } else if (effectText == F("CHASE")) {
    stripEffect = StripEffect::CHASE;
  } else {
    return false;
  }

  activeScene = F("MANUAL");
  stripDirty = true;
  return true;
}


void applyScene(const String& requestedScene) {
  String scene = requestedScene;
  scene.trim();
  scene.toUpperCase();

  if (scene == F("READY")) {
    activeScene = F("READY");
    stripEffectPeriodMs = 1200UL;
    setStripBaseColor(25, 220, 95, StripEffect::SOLID);
    playSceneBuzzer(scene);
    return;
  }

  if (scene == F("WORKING")) {
    activeScene = F("WORKING");
    stripEffectPeriodMs = 1100UL;
    setStripBaseColor(20, 175, 255, StripEffect::CHASE);
    playSceneBuzzer(scene);
    return;
  }

  if (scene == F("WAITING")) {
    activeScene = F("WAITING");
    stripEffectPeriodMs = 1700UL;
    setStripBaseColor(255, 145, 20, StripEffect::BREATHE);
    playSceneBuzzer(scene);
    return;
  }

  if (scene == F("ALARM")) {
    activeScene = F("ALARM");
    stripEffectPeriodMs = 500UL;
    setStripBaseColor(255, 0, 0, StripEffect::BLINK);
    playSceneBuzzer(scene);
    return;
  }

  if (scene == F("MAINTENANCE")) {
    activeScene = F("MAINTENANCE");
    stripEffectPeriodMs = 1900UL;
    setStripBaseColor(175, 45, 255, StripEffect::BREATHE);
    playSceneBuzzer(scene);
    return;
  }

  if (scene == F("DISCONNECTED")) {
    activeScene = F("DISCONNECTED");
    stripEffectPeriodMs = 1300UL;
    setStripBaseColor(105, 120, 125, StripEffect::BLINK);
    playSceneBuzzer(scene);
    return;
  }

  activeScene = F("OFF");
  setStripBaseColor(0, 0, 0, StripEffect::OFF);
  stopBuzzer();
}


// ============================================================================
// WI-FI Y PUNTO DE ACCESO DE RECUPERACIÓN
// ============================================================================

bool wifiCredentialsConfigured() {
  const String ssid = String(NOPAL_WIFI_SSID);

  return
    ssid.length() > 0 &&
    ssid != F("TU_RED_WIFI");
}


String activeIpAddress() {
  if (WiFi.status() == WL_CONNECTED) {
    return WiFi.localIP().toString();
  }

  if (recoveryApActive) {
    return WiFi.softAPIP().toString();
  }

  return F("0.0.0.0");
}


String wifiModeText() {
  if (
    WiFi.status() == WL_CONNECTED &&
    recoveryApActive
  ) {
    return F("sta+ap");
  }

  if (WiFi.status() == WL_CONNECTED) {
    return F("sta");
  }

  if (recoveryApActive) {
    return F("ap");
  }

  return F("offline");
}


void startRecoveryAccessPoint() {
  if (recoveryApActive) return;

  recoveryApSsid =
    String(F("NOPAL-NODEMCU-")) + chipSuffix();

  WiFi.mode(WIFI_AP_STA);

  WiFi.softAPConfig(
    IPAddress(192, 168, 4, 1),
    IPAddress(192, 168, 4, 1),
    IPAddress(255, 255, 255, 0)
  );

  bool started = false;

  if (strlen(NOPAL_AP_PASSWORD) >= 8) {
    started = WiFi.softAP(
      recoveryApSsid.c_str(),
      NOPAL_AP_PASSWORD
    );
  } else {
    Serial.println(
      F("WARN:AP_PASSWORD_TOO_SHORT_STARTING_OPEN_AP")
    );

    started = WiFi.softAP(
      recoveryApSsid.c_str()
    );
  }

  recoveryApActive = started;

  if (started) {
    Serial.print(F("NOPAL:AP_READY,ssid="));
    Serial.print(recoveryApSsid);
    Serial.print(F(",ip="));
    Serial.println(WiFi.softAPIP());
  } else {
    Serial.println(F("ERR:AP_START_FAILED"));
  }
}


void stopRecoveryAccessPoint() {
  if (!recoveryApActive) return;

  WiFi.softAPdisconnect(true);
  recoveryApActive = false;

  if (WiFi.status() == WL_CONNECTED) {
    WiFi.mode(WIFI_STA);
  }

  Serial.println(F("NOPAL:AP_STOPPED"));
}


void startMdnsIfPossible() {
  if (
    mdnsStarted ||
    WiFi.status() != WL_CONNECTED
  ) {
    return;
  }

  if (MDNS.begin(NOPAL_HOSTNAME)) {
    MDNS.addService(
      "http",
      "tcp",
      HTTP_PORT
    );

    mdnsStarted = true;

    Serial.print(F("NOPAL:MDNS_READY,url=http://"));
    Serial.print(NOPAL_HOSTNAME);
    Serial.println(F(".local/"));
  } else {
    Serial.println(F("WARN:MDNS_START_FAILED"));
  }
}


void setupWifi() {
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.hostname(NOPAL_HOSTNAME);

  if (!wifiCredentialsConfigured()) {
    Serial.println(
      F("WARN:WIFI_CREDENTIALS_NOT_CONFIGURED")
    );

    startRecoveryAccessPoint();
    return;
  }

  WiFi.mode(WIFI_STA);

  Serial.print(F("NOPAL:WIFI_CONNECTING,ssid="));
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
    serviceStatusLed();
    delay(50);
    yield();
  }

  if (WiFi.status() == WL_CONNECTED) {
    wifiWasConnected = true;
    wifiConnectedSinceMs = millis();

    Serial.print(F("NOPAL:WIFI_READY,ssid="));
    Serial.print(WiFi.SSID());
    Serial.print(F(",ip="));
    Serial.print(WiFi.localIP());
    Serial.print(F(",rssi="));
    Serial.println(WiFi.RSSI());

    startMdnsIfPossible();
    return;
  }

  Serial.println(
    F("WARN:WIFI_CONNECTION_TIMEOUT")
  );

  startRecoveryAccessPoint();
}


void maintainWifiConnection() {
  const bool connected =
    WiFi.status() == WL_CONNECTED;

  if (connected) {
    if (!wifiWasConnected) {
      wifiWasConnected = true;
      wifiConnectedSinceMs = millis();

      Serial.print(
        F("NOPAL:WIFI_RECONNECTED,ip=")
      );
      Serial.println(WiFi.localIP());
    }

    startMdnsIfPossible();

#if NOPAL_KEEP_RECOVERY_AP == 0
    if (
      recoveryApActive &&
      millis() - wifiConnectedSinceMs >=
        RECOVERY_AP_SHUTDOWN_DELAY_MS
    ) {
      stopRecoveryAccessPoint();
    }
#endif

    return;
  }

  if (wifiWasConnected) {
    wifiWasConnected = false;
    wifiConnectedSinceMs = 0;

    Serial.println(
      F("WARN:WIFI_DISCONNECTED")
    );
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

  Serial.println(F("NOPAL:WIFI_RECONNECTING"));

  WiFi.begin(
    NOPAL_WIFI_SSID,
    NOPAL_WIFI_PASSWORD
  );
}


// ============================================================================
// JSON Y TELEMETRÍA
// ============================================================================

String buildStatusJson() {
  String json;
  json.reserve(1950);

  json += F("{");

  json += F("\"device\":\"");
  json += jsonEscape(String(NOPAL_DEVICE_NAME));
  json += F("\",");

  json += F("\"role\":\"accessory\",");
  json += F("\"board\":\"esp12e_development_board\",");
  json += F("\"chip\":\"ESP8266\",");
  json += F("\"firmware\":\"");
  json += FW_VERSION;
  json += F("\",");
  json += F("\"protocol\":");
  json += String(NOPAL_PROTOCOL_VERSION);
  json += F(",");

  json += F("\"wifi\":{");
  json += F("\"connected\":");
  json +=
    WiFi.status() == WL_CONNECTED
      ? F("true")
      : F("false");
  json += F(",\"mode\":\"");
  json += wifiModeText();
  json += F("\",\"hostname\":\"");
  json += jsonEscape(String(NOPAL_HOSTNAME));
  json += F("\",\"ssid\":\"");

  if (WiFi.status() == WL_CONNECTED) {
    json += jsonEscape(WiFi.SSID());
  }

  json += F("\",\"ip\":\"");
  json += activeIpAddress();
  json += F("\",\"rssi\":");
  json += String(
    WiFi.status() == WL_CONNECTED
      ? WiFi.RSSI()
      : 0
  );
  json += F(",\"recovery_ap\":");
  json += recoveryApActive ? F("true") : F("false");
  json += F(",\"recovery_ssid\":\"");

  if (recoveryApActive) {
    json += jsonEscape(recoveryApSsid);
  }

  json += F("\"},");

  json += F("\"relays\":[");

  for (uint8_t index = 0; index < RELAY_COUNT; index++) {
    if (index > 0) json += F(",");

    json += F("{\"n\":");
    json += String(index + 1);
    json += F(",\"name\":\"");
    json += jsonEscape(String(RELAY_NAMES[index]));
    json += F("\",\"gpio\":");
    json += String(RELAY_PINS[index]);
    json += F(",\"on\":");
    json += getRelay(index) ? F("true") : F("false");
    json += F("}");
  }

  json += F("],");

  json += F("\"led\":{");
  json += F("\"type\":\"ws2812\",");
  json += F("\"gpio\":");
  json += String(WS2812_PIN);
  json += F(",\"count\":");
  json += String(NOPAL_WS2812_COUNT);
  json += F(",\"brightness\":");
  json += String(stripBrightness);
  json += F(",\"effect\":\"");
  json += effectName(stripEffect);
  json += F("\",\"scene\":\"");
  json += jsonEscape(activeScene);
  json += F("\",\"base_rgb\":[");
  json += String(stripBaseRed);
  json += F(",");
  json += String(stripBaseGreen);
  json += F(",");
  json += String(stripBaseBlue);
  json += F("]},");

  json += F("\"buzzer\":{");
  json += F("\"type\":\"active\",");
  json += F("\"gpio\":");
  json += String(BUZZER_PIN);
  json += F(",\"active_high\":");
  json += BUZZER_ACTIVE_HIGH ? F("true") : F("false");
  json += F(",\"on\":");
  json += buzzerOutputOn ? F("true") : F("false");
  json += F(",\"pattern\":\"");
  json += buzzerPatternName(buzzerPattern);
  json += F("\",\"repeating\":");
  json += buzzerPatternRepeats ? F("true") : F("false");
  json += F("},");

  json += F("\"inputs\":{");
  json += F("\"a0_raw\":");
  json += String(analogRead(A0));
  json += F(",\"a0_percent\":");
  json += String(
    (static_cast<uint32_t>(analogRead(A0)) * 100UL) /
    1023UL
  );
  json += F("},");

  json += F("\"ota\":{");
  json += F("\"enabled\":true,");
  json += F("\"path\":\"/update\",");
  json += F("\"in_progress\":");
  json += otaInProgress ? F("true") : F("false");
  json += F("},");

  json += F("\"system\":{");
  json += F("\"chip_id\":\"");
  json += chipSuffix();
  json += F("\",\"uptime_ms\":");
  json += String(millis());
  json += F(",\"free_heap\":");
  json += String(ESP.getFreeHeap());
  json += F(",\"flash_real_size\":");
  json += String(ESP.getFlashChipRealSize());
  json += F(",\"reset_reason\":\"");
  json += jsonEscape(ESP.getResetReason());
  json += F("\"}");

  json += F("}");

  return json;
}


// ============================================================================
// AUTENTICACIÓN Y RESPUESTAS HTTP
// ============================================================================

bool checkApiAuth() {
  if (
    server.authenticate(
      NOPAL_OTA_USERNAME,
      NOPAL_OTA_PASSWORD
    )
  ) {
    return true;
  }

  server.requestAuthentication();
  return false;
}


void sendJsonMessage(
  int statusCode,
  const String& message
) {
  String body;
  body.reserve(message.length() + 40);
  body += F("{\"message\":\"");
  body += jsonEscape(message);
  body += F("\"}");

  server.send(
    statusCode,
    F("application/json; charset=utf-8"),
    body
  );
}


bool httpRequiredInt(
  const char* name,
  int& output
) {
  if (!server.hasArg(name)) {
    sendJsonMessage(
      400,
      String(F("missing_argument:")) + name
    );
    return false;
  }

  const String value = server.arg(name);

  if (!isUnsignedNumber(value)) {
    sendJsonMessage(
      400,
      String(F("invalid_argument:")) + name
    );
    return false;
  }

  output = value.toInt();
  return true;
}


// ============================================================================
// SERVIDOR WEB Y API
// ============================================================================

void setupWebServer() {
  server.on("/", HTTP_GET, []() {
    if (!checkApiAuth()) return;

    server.send_P(
      200,
      PSTR("text/html; charset=utf-8"),
      INDEX_HTML
    );
  });

  server.on("/health", HTTP_GET, []() {
    server.send(
      200,
      F("text/plain; charset=utf-8"),
      F("OK")
    );
  });

  server.on("/api/status", HTTP_GET, []() {
    server.send(
      200,
      F("application/json; charset=utf-8"),
      buildStatusJson()
    );
  });

  server.on("/api/analog", HTTP_GET, []() {
    String json;
    json.reserve(70);

    const int raw = analogRead(A0);

    json += F("{\"a0_raw\":");
    json += String(raw);
    json += F(",\"a0_percent\":");
    json += String(
      (static_cast<uint32_t>(raw) * 100UL) /
      1023UL
    );
    json += F("}");

    server.send(
      200,
      F("application/json; charset=utf-8"),
      json
    );
  });

  server.on("/api/relay", HTTP_GET, []() {
    if (!checkApiAuth()) return;

    int relayNumber = 0;

    if (!httpRequiredInt("n", relayNumber)) {
      return;
    }

    const int relayIndex = relayNumber - 1;

    if (!validRelayIndex(relayIndex)) {
      sendJsonMessage(400, F("invalid_relay"));
      return;
    }

    String response;
    response.reserve(100);

    response += F("{\"n\":");
    response += String(relayNumber);
    response += F(",\"name\":\"");
    response += jsonEscape(
      String(RELAY_NAMES[relayIndex])
    );
    response += F("\",\"on\":");
    response +=
      getRelay(relayIndex)
        ? F("true")
        : F("false");
    response += F("}");

    server.send(
      200,
      F("application/json; charset=utf-8"),
      response
    );
  });

  server.on("/api/relay", HTTP_POST, []() {
    if (!checkApiAuth()) return;

    int relayNumber = 0;

    if (!httpRequiredInt("n", relayNumber)) {
      return;
    }

    const int relayIndex = relayNumber - 1;

    if (!validRelayIndex(relayIndex)) {
      sendJsonMessage(400, F("invalid_relay"));
      return;
    }

    String action = server.arg("action");
    action.trim();
    action.toUpperCase();

    if (action.length() == 0 && server.hasArg("on")) {
      const String onText = server.arg("on");

      action =
        onText == F("1") ||
        onText == F("true") ||
        onText == F("TRUE")
          ? F("ON")
          : F("OFF");
    }

    if (action == F("ON")) {
      setRelay(relayIndex, true);
    } else if (action == F("OFF")) {
      setRelay(relayIndex, false);
    } else if (action == F("TOGGLE")) {
      setRelay(
        relayIndex,
        !getRelay(relayIndex)
      );
    } else {
      sendJsonMessage(
        400,
        F("invalid_action")
      );
      return;
    }

    sendJsonMessage(
      200,
      getRelay(relayIndex)
        ? F("ON")
        : F("OFF")
    );
  });

  server.on("/api/ws", HTTP_POST, []() {
    if (!checkApiAuth()) return;

    bool changed = false;

    if (server.hasArg("brightness")) {
      const int brightness =
        server.arg("brightness").toInt();

      setStripBrightness(
        clampByte(brightness)
      );

      changed = true;
    }

    if (
      server.hasArg("r") &&
      server.hasArg("g") &&
      server.hasArg("b")
    ) {
      stripBaseRed =
        clampByte(server.arg("r").toInt());
      stripBaseGreen =
        clampByte(server.arg("g").toInt());
      stripBaseBlue =
        clampByte(server.arg("b").toInt());

      stripEffect = StripEffect::SOLID;
      activeScene = F("MANUAL");
      stripDirty = true;
      changed = true;
    }

    if (server.hasArg("effect")) {
      if (
        !setEffectFromText(
          server.arg("effect")
        )
      ) {
        sendJsonMessage(
          400,
          F("invalid_effect")
        );
        return;
      }

      changed = true;
    }

    if (!changed) {
      sendJsonMessage(
        400,
        F("no_changes")
      );
      return;
    }

    sendJsonMessage(200, F("OK"));
  });

  server.on("/api/ws/pixel", HTTP_POST, []() {
    if (!checkApiAuth()) return;

    int pixel = 0;

    if (!httpRequiredInt("n", pixel)) {
      return;
    }

    if (
      !server.hasArg("r") ||
      !server.hasArg("g") ||
      !server.hasArg("b")
    ) {
      sendJsonMessage(
        400,
        F("missing_rgb")
      );
      return;
    }

    if (
      !setCustomPixel(
        static_cast<uint16_t>(pixel),
        clampByte(server.arg("r").toInt()),
        clampByte(server.arg("g").toInt()),
        clampByte(server.arg("b").toInt())
      )
    ) {
      sendJsonMessage(
        400,
        F("invalid_pixel")
      );
      return;
    }

    sendJsonMessage(200, F("OK"));
  });

  server.on("/api/ws/range", HTTP_POST, []() {
    if (!checkApiAuth()) return;

    int startPixel = 0;
    int endPixel = 0;

    if (
      !httpRequiredInt("from", startPixel) ||
      !httpRequiredInt("to", endPixel)
    ) {
      return;
    }

    if (
      !server.hasArg("r") ||
      !server.hasArg("g") ||
      !server.hasArg("b")
    ) {
      sendJsonMessage(
        400,
        F("missing_rgb")
      );
      return;
    }

    if (
      !setCustomRange(
        static_cast<uint16_t>(startPixel),
        static_cast<uint16_t>(endPixel),
        clampByte(server.arg("r").toInt()),
        clampByte(server.arg("g").toInt()),
        clampByte(server.arg("b").toInt())
      )
    ) {
      sendJsonMessage(
        400,
        F("invalid_range")
      );
      return;
    }

    sendJsonMessage(200, F("OK"));
  });

  server.on("/api/buzzer", HTTP_GET, []() {
    String json;
    json.reserve(130);

    json += F("{\"gpio\":");
    json += String(BUZZER_PIN);
    json += F(",\"type\":\"active\",\"on\":");
    json += buzzerOutputOn ? F("true") : F("false");
    json += F(",\"pattern\":\"");
    json += buzzerPatternName(buzzerPattern);
    json += F("\",\"repeating\":");
    json += buzzerPatternRepeats ? F("true") : F("false");
    json += F("}");

    server.send(
      200,
      F("application/json; charset=utf-8"),
      json
    );
  });

  server.on("/api/buzzer", HTTP_POST, []() {
    if (!checkApiAuth()) return;

    if (!server.hasArg("action")) {
      sendJsonMessage(400, F("missing_action"));
      return;
    }

    if (!startBuzzerFromText(server.arg("action"))) {
      sendJsonMessage(400, F("invalid_buzzer_pattern"));
      return;
    }

    sendJsonMessage(200, buzzerPatternName(buzzerPattern));
  });

  server.on("/api/scene", HTTP_POST, []() {
    if (!checkApiAuth()) return;

    if (!server.hasArg("name")) {
      sendJsonMessage(
        400,
        F("missing_scene")
      );
      return;
    }

    String scene = server.arg("name");
    scene.trim();
    scene.toUpperCase();

    const bool valid =
      scene == F("READY") ||
      scene == F("WORKING") ||
      scene == F("WAITING") ||
      scene == F("ALARM") ||
      scene == F("MAINTENANCE") ||
      scene == F("DISCONNECTED") ||
      scene == F("OFF");

    if (!valid) {
      sendJsonMessage(
        400,
        F("invalid_scene")
      );
      return;
    }

    applyScene(scene);
    sendJsonMessage(200, scene);
  });

  server.on("/api/reboot", HTTP_POST, []() {
    if (!checkApiAuth()) return;

    sendJsonMessage(
      200,
      F("reboot_scheduled")
    );

    scheduleReboot(700UL);
  });

  server.onNotFound([]() {
    server.send(
      404,
      F("application/json; charset=utf-8"),
      F("{\"error\":\"not_found\"}")
    );
  });

  ElegantOTA.onStart([]() {
    otaInProgress = true;
    Serial.println(F("NOPAL:OTA_START"));
  });

  ElegantOTA.onProgress(
    [](size_t current, size_t total) {
      static uint8_t lastPercent = 255;

      if (total == 0) return;

      const uint8_t percent =
        static_cast<uint8_t>(
          (current * 100UL) / total
        );

      if (
        percent != lastPercent &&
        (
          percent == 100 ||
          percent % 10 == 0
        )
      ) {
        lastPercent = percent;

        Serial.print(F("NOPAL:OTA_PROGRESS,"));
        Serial.println(percent);
      }
    }
  );

  ElegantOTA.onEnd([](bool success) {
    otaInProgress = false;

    Serial.println(
      success
        ? F("NOPAL:OTA_OK")
        : F("ERR:OTA_FAILED")
    );
  });

  // Las credenciales deben pasarse aquí. ElegantOTA las aplica durante begin().
  ElegantOTA.begin(
    &server,
    NOPAL_OTA_USERNAME,
    NOPAL_OTA_PASSWORD
  );

  server.begin();
  webServerStarted = true;

  Serial.print(F("NOPAL:HTTP_READY,ip="));
  Serial.print(activeIpAddress());
  Serial.print(F(",port="));
  Serial.print(HTTP_PORT);
  Serial.println(F(",ota=/update"));
}


// ============================================================================
// IDENTIFICACIÓN NOPAL
// ============================================================================

void sendIdentification() {
  Serial.print(
    F("NOPAL,role=accessory")
  );

  Serial.print(F(",board=esp12e_development_board"));
  Serial.print(F(",chip=ESP8266-"));
  Serial.print(chipSuffix());

  Serial.print(F(",fw="));
  Serial.print(FW_VERSION);

  Serial.print(F(",protocol="));
  Serial.print(NOPAL_PROTOCOL_VERSION);

  Serial.print(F(",relays="));
  Serial.print(RELAY_COUNT);

  Serial.print(F(",relay_active_low="));
  Serial.print(
    NOPAL_RELAY_ACTIVE_LOW ? 1 : 0
  );

  Serial.print(F(",pwm_led=0"));
  Serial.print(F(",ws2812=1"));
  Serial.print(F(",ws2812_pin="));
  Serial.print(WS2812_PIN);
  Serial.print(F(",ws2812_count="));
  Serial.print(NOPAL_WS2812_COUNT);

  Serial.print(F(",buzzer=1"));
  Serial.print(F(",buzzer_pin="));
  Serial.print(BUZZER_PIN);
  Serial.print(F(",buzzer_type=active"));
  Serial.print(F(",buzzer_pattern="));
  Serial.print(buzzerPatternName(buzzerPattern));

  Serial.print(F(",analog_inputs=1"));
  Serial.print(F(",a0_raw="));
  Serial.print(analogRead(A0));

  Serial.print(F(",wifi=1"));
  Serial.print(F(",wifi_connected="));
  Serial.print(
    WiFi.status() == WL_CONNECTED
      ? 1
      : 0
  );

  Serial.print(F(",wifi_mode="));
  Serial.print(wifiModeText());

  Serial.print(F(",hostname="));
  Serial.print(NOPAL_HOSTNAME);

  Serial.print(F(",ip="));
  Serial.print(activeIpAddress());

  Serial.print(F(",ota=1"));
  Serial.print(F(",ota_path=/update"));

  Serial.print(F(",scene="));
  Serial.print(activeScene);

  Serial.print(F(",uptime_ms="));
  Serial.print(millis());

  Serial.print(F(",free_heap="));
  Serial.println(ESP.getFreeHeap());
}


void sendNetworkIdentification() {
  Serial.print(F("NET,connected="));
  Serial.print(
    WiFi.status() == WL_CONNECTED
      ? 1
      : 0
  );

  Serial.print(F(",mode="));
  Serial.print(wifiModeText());

  Serial.print(F(",hostname="));
  Serial.print(NOPAL_HOSTNAME);

  Serial.print(F(",ssid="));

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(WiFi.SSID());
  }

  Serial.print(F(",ip="));
  Serial.print(activeIpAddress());

  Serial.print(F(",rssi="));
  Serial.print(
    WiFi.status() == WL_CONNECTED
      ? WiFi.RSSI()
      : 0
  );

  Serial.print(F(",recovery_ap="));
  Serial.print(
    recoveryApActive ? 1 : 0
  );

  Serial.print(F(",recovery_ssid="));

  if (recoveryApActive) {
    Serial.print(recoveryApSsid);
  }

  Serial.print(F(",ota_url=http://"));
  Serial.print(activeIpAddress());
  Serial.println(F("/update"));
}


// ============================================================================
// COMANDOS DE RELÉ
// ============================================================================

bool handleRelayCommand(
  const String& command,
  String& response
) {
  if (
    command.length() < 2 ||
    command.charAt(0) != 'R'
  ) {
    return false;
  }

  if (command.endsWith(F("?"))) {
    const String numberText =
      command.substring(
        1,
        command.length() - 1
      );

    if (!isUnsignedNumber(numberText)) {
      response = F("ERR:INVALID_RELAY");
      return true;
    }

    const int relayIndex =
      numberText.toInt() - 1;

    if (!validRelayIndex(relayIndex)) {
      response = F("ERR:INVALID_RELAY");
      return true;
    }

    response =
      getRelay(relayIndex)
        ? F("ON")
        : F("OFF");

    return true;
  }

  const int colonPosition =
    command.indexOf(':');

  if (colonPosition <= 1) {
    return false;
  }

  const String numberText =
    command.substring(
      1,
      colonPosition
    );

  if (!isUnsignedNumber(numberText)) {
    response = F("ERR:INVALID_RELAY");
    return true;
  }

  const int relayIndex =
    numberText.toInt() - 1;

  if (!validRelayIndex(relayIndex)) {
    response = F("ERR:INVALID_RELAY");
    return true;
  }

  String action =
    command.substring(
      colonPosition + 1
    );

  action.trim();
  action.toUpperCase();

  if (action == F("ON")) {
    setRelay(relayIndex, true);
  } else if (action == F("OFF")) {
    setRelay(relayIndex, false);
  } else if (action == F("TOGGLE")) {
    setRelay(
      relayIndex,
      !getRelay(relayIndex)
    );
  } else {
    response = F("ERR:INVALID_ACTION");
    return true;
  }

  response =
    getRelay(relayIndex)
      ? F("ON")
      : F("OFF");

  return true;
}


// ============================================================================
// COMANDOS WS2812
// ============================================================================

bool handleWsCommand(
  const String& command,
  String& response
) {
  if (!command.startsWith(F("WS:"))) {
    return false;
  }

  String payload = command.substring(3);
  payload.trim();

  if (payload == F("?")) {
    response =
      String(F("WS,count=")) +
      NOPAL_WS2812_COUNT +
      F(",pin=") +
      WS2812_PIN +
      F(",brightness=") +
      stripBrightness +
      F(",effect=") +
      effectName(stripEffect) +
      F(",scene=") +
      activeScene;

    return true;
  }

  if (payload.startsWith(F("BRIGHTNESS:"))) {
    const String valueText =
      payload.substring(11);

    if (!isUnsignedNumber(valueText)) {
      response =
        F("ERR:INVALID_BRIGHTNESS");
      return true;
    }

    setStripBrightness(
      clampByte(valueText.toInt())
    );

    response = F("OK");
    return true;
  }

  if (payload.startsWith(F("EFFECT:"))) {
    if (
      !setEffectFromText(
        payload.substring(7)
      )
    ) {
      response = F("ERR:INVALID_EFFECT");
      return true;
    }

    response = F("OK");
    return true;
  }

  if (payload.startsWith(F("PIXEL:"))) {
    int pixel = 0;
    int red = 0;
    int green = 0;
    int blue = 0;
    char trailing = '\0';

    const int parsed = sscanf(
      payload.c_str() + 6,
      "%d,%d,%d,%d%c",
      &pixel,
      &red,
      &green,
      &blue,
      &trailing
    );

    if (parsed != 4) {
      response = F("ERR:INVALID_PIXEL");
      return true;
    }

    if (
      !setCustomPixel(
        static_cast<uint16_t>(pixel),
        clampByte(red),
        clampByte(green),
        clampByte(blue)
      )
    ) {
      response = F("ERR:INVALID_PIXEL");
      return true;
    }

    response = F("OK");
    return true;
  }

  if (payload.startsWith(F("RANGE:"))) {
    int startPixel = 0;
    int endPixel = 0;
    int red = 0;
    int green = 0;
    int blue = 0;
    char trailing = '\0';

    const int parsed = sscanf(
      payload.c_str() + 6,
      "%d,%d,%d,%d,%d%c",
      &startPixel,
      &endPixel,
      &red,
      &green,
      &blue,
      &trailing
    );

    if (parsed != 5) {
      response = F("ERR:INVALID_RANGE");
      return true;
    }

    if (
      !setCustomRange(
        static_cast<uint16_t>(startPixel),
        static_cast<uint16_t>(endPixel),
        clampByte(red),
        clampByte(green),
        clampByte(blue)
      )
    ) {
      response = F("ERR:INVALID_RANGE");
      return true;
    }

    response = F("OK");
    return true;
  }

  if (payload.startsWith(F("ALL:"))) {
    payload = payload.substring(4);
  }

  uint8_t red;
  uint8_t green;
  uint8_t blue;

  if (!parseRgbCsv(payload, red, green, blue)) {
    response = F("ERR:INVALID_RGB");
    return true;
  }

  setCustomAll(red, green, blue);
  response = F("OK");

  return true;
}


// ============================================================================
// COMANDOS DEL BUZZER
// ============================================================================

bool handleBuzzerCommand(
  const String& command,
  String& response
) {
  if (command == F("BUZZER?")) {
    response =
      String(F("BUZZER,gpio=")) +
      BUZZER_PIN +
      F(",type=active,on=") +
      (buzzerOutputOn ? F("1") : F("0")) +
      F(",pattern=") +
      buzzerPatternName(buzzerPattern) +
      F(",repeating=") +
      (buzzerPatternRepeats ? F("1") : F("0"));

    return true;
  }

  if (!command.startsWith(F("BUZZER:"))) {
    return false;
  }

  const String action = command.substring(7);

  if (!startBuzzerFromText(action)) {
    response = F("ERR:INVALID_BUZZER_PATTERN");
    return true;
  }

  response = String(F("OK:")) + buzzerPatternName(buzzerPattern);
  return true;
}

// ============================================================================
// PROCESAMIENTO GENERAL DE COMANDOS
// ============================================================================

void printHelp() {
  Serial.println(
    F("NOPAL:HELP,ID?|NET?|STATUS?|R1:ON|R1:OFF|R1:TOGGLE|R1?|WS:r,g,b|WS:PIXEL:n,r,g,b|WS:RANGE:a,b,r,g,b|WS:BRIGHTNESS:n|WS:EFFECT:name|BUZZER?|BUZZER:BEEP|BUZZER:DOUBLE|BUZZER:ON|BUZZER:OFF|BUZZER:ALARM|SCENE:name|A0?|REBOOT")
  );
}


void scheduleReboot(uint32_t delayMs) {
  scheduledRebootAtMs =
    millis() + maxU32(200UL, delayMs);
}


void handleCommand(String line) {
  line.trim();

  if (!line.startsWith(F("NOPAL:"))) {
    return;
  }

  String command = line.substring(6);
  command.trim();

  if (command == F("ID?")) {
    sendIdentification();
    return;
  }

  if (command == F("NET?")) {
    sendNetworkIdentification();
    return;
  }

  if (
    command == F("STATUS?") ||
    command == F("IO?")
  ) {
    Serial.println(buildStatusJson());
    return;
  }

  if (
    command == F("HELP?") ||
    command == F("HELP")
  ) {
    printHelp();
    return;
  }

  if (command == F("A0?")) {
    Serial.print(F("A0,raw="));
    Serial.print(analogRead(A0));
    Serial.print(F(",percent="));
    Serial.println(
      (
        static_cast<uint32_t>(
          analogRead(A0)
        ) * 100UL
      ) / 1023UL
    );
    return;
  }

  if (command == F("SCENE?")) {
    Serial.print(F("SCENE,"));
    Serial.println(activeScene);
    return;
  }

  if (command.startsWith(F("SCENE:"))) {
    String scene = command.substring(6);
    scene.trim();
    scene.toUpperCase();

    const bool valid =
      scene == F("READY") ||
      scene == F("WORKING") ||
      scene == F("WAITING") ||
      scene == F("ALARM") ||
      scene == F("MAINTENANCE") ||
      scene == F("DISCONNECTED") ||
      scene == F("OFF");

    if (!valid) {
      Serial.println(F("ERR:INVALID_SCENE"));
      return;
    }

    applyScene(scene);
    Serial.println(F("OK"));
    return;
  }

  if (command == F("REBOOT")) {
    Serial.println(F("OK:REBOOTING"));
    scheduleReboot(500UL);
    return;
  }

  {
    String response;

    if (
      handleBuzzerCommand(
        command,
        response
      )
    ) {
      Serial.println(response);
      return;
    }
  }

  {
    String response;

    if (
      handleRelayCommand(
        command,
        response
      )
    ) {
      Serial.println(response);
      return;
    }
  }

  {
    String response;

    if (
      handleWsCommand(
        command,
        response
      )
    ) {
      Serial.println(response);
      return;
    }
  }

  Serial.println(F("ERR:UNKNOWN_COMMAND"));
}


// ============================================================================
// SERVICIOS DEL LOOP
// ============================================================================

void serviceSerial() {
  while (Serial.available() > 0) {
    const char received =
      static_cast<char>(Serial.read());

    if (received == '\n') {
      serialInputLine.trim();

      if (serialInputLine.length() > 0) {
        handleCommand(serialInputLine);
      }

      serialInputLine = "";
      continue;
    }

    if (received == '\r') {
      continue;
    }

    if (
      serialInputLine.length() <
      SERIAL_MAX_LINE_LENGTH
    ) {
      serialInputLine += received;
    } else {
      serialInputLine = "";
      Serial.println(F("ERR:LINE_TOO_LONG"));
    }
  }
}


void serviceNetwork() {
  maintainWifiConnection();
  serviceStatusLed();

  if (webServerStarted) {
    server.handleClient();
    ElegantOTA.loop();
  }

  if (mdnsStarted) {
    MDNS.update();
  }
}


void serviceScheduledReboot() {
  if (scheduledRebootAtMs == 0) return;

  if (
    static_cast<int32_t>(
      millis() - scheduledRebootAtMs
    ) >= 0
  ) {
    scheduledRebootAtMs = 0;
    ESP.restart();
  }
}


// ============================================================================
// SETUP
// ============================================================================

void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(false);
  delay(50);

  serialInputLine.reserve(
    SERIAL_MAX_LINE_LENGTH + 1
  );

  pinMode(STATUS_LED_PIN, OUTPUT);
  setStatusLed(false);

  initializeRelaysSafely();
  initializeBuzzerSafely();

  strip.begin();
  strip.clear();
  strip.show();

  for (uint16_t index = 0; index < NOPAL_WS2812_COUNT; index++) {
    customPixelColors[index] = 0;
  }

  applyScene(F("OFF"));

  Serial.println();
  Serial.println(F("NOPAL:BOOT"));
  Serial.print(F("NOPAL:BOARD,esp12e_development_board,chip_id="));
  Serial.println(chipSuffix());

  setupWifi();
  setupWebServer();

  Serial.print(F("NOPAL:READY,ip="));
  Serial.print(activeIpAddress());
  Serial.print(F(",panel=http://"));
  Serial.print(activeIpAddress());
  Serial.print(F("/,ota=http://"));
  Serial.print(activeIpAddress());
  Serial.println(F("/update"));
}


// ============================================================================
// LOOP
// ============================================================================

void loop() {
  serviceSerial();
  serviceNetwork();
  serviceStrip();
  serviceBuzzer();
  serviceScheduledReboot();

  yield();
}
