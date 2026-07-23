/*
 * ============================================================================
 * NOPAL — Firmware de accesorios ESP32 / ESP8266 con buzzer (Nopal_FF)
 * ============================================================================
 *
 * Este sketch nace de fusionar dos firmwares NOPAL que ya existían por
 * separado en este repositorio:
 *
 *   - nopal_accessory.ino (protocolo 4, fw 4.1.0): ESP32 + ESP8266, relés,
 *     tira RGB analógica por PWM, tira WS2812/NeoPixel completa (color
 *     global, por píxel individual y por segmento con WSSEG), Wi-Fi con
 *     recuperación por AP, ElegantOTA y el panel web NOPAL embebido.
 *     NO tenía buzzer.
 *
 *   - NOPAL_ESP12E_BUZZER.ino (protocolo 2, fw 2.1.0): exclusivo ESP8266,
 *     con buzzer activo de patrones no bloqueantes (beep, doble beep,
 *     encendido continuo y un patrón por cada escena del taller), motor
 *     de efectos de tira (parpadeo/respirar/carrera) y comando SCENE:.
 *     NO tenía PWM RGB, NO tenía soporte ESP32 y NO tenía el comando
 *     WSSEG de segmentos.
 *
 * Nopal_FF.ino toma la base de nopal_accessory.ino (el protocolo 4 se
 * mantiene sin cambios -- todo lo que trae el buzzer son campos aditivos
 * en el JSON/identificación; un backend que no los conoce simplemente los
 * ignora, mismo criterio que ya usaba ese archivo con sus propios campos
 * "extra") y le agrega el subsistema completo de buzzer activo portado de
 * NOPAL_ESP12E_BUZZER.ino: patrones no bloqueantes, comandos
 * NOPAL:BUZZER? / NOPAL:BUZZER:<patrón>, endpoint HTTP /api/buzzer y su
 * propia tarjeta en el panel web.
 *
 * Lo que sigue SIN portarse a propósito (no es un olvido):
 *   - El motor de efectos de tira (StripEffect: parpadeo/respirar/carrera)
 *     y el comando SCENE: con estado en el servidor de
 *     NOPAL_ESP12E_BUZZER.ino. Nopal_FF.ino conserva el mismo criterio
 *     que ya tenía nopal_accessory.ino: las "Escenas rápidas" del panel
 *     aplican un color fijo, sin animación.
 *   - Sin embargo, en NOPAL_ESP12E_BUZZER.ino elegir una escena del
 *     taller también hacía sonar un patrón de buzzer, a través de
 *     applyScene() -> playSceneBuzzer(). Esa relación (color + sonido
 *     juntos) SÍ se conserva acá, pero implementada donde vive la lógica
 *     de escenas en este firmware: en el panel web (JavaScript), que
 *     ahora manda un segundo POST a /api/buzzer con el mismo nombre de
 *     escena justo después de aplicar el color. El firmware puede apagar
 *     ese acompañamiento sonoro sin recompilar el panel -- ver
 *     NOPAL_BUZZER_SCENE_SOUNDS más abajo, que el panel lee de
 *     /api/status (buzzer.scene_sounds).
 *
 * Versión propia: 4.2.0-ff. Protocolo 4 (compatible con nopal_accessory.ino
 * -- el buzzer solo agrega campos, no cambia ni quita ninguno existente).
 * "board" se reporta como esp32_generic_ff / esp8266_generic_ff para
 * distinguir esta variante con buzzer de un nopal_accessory.ino común.
 *
 * Compatible con:
 *   - ESP8266
 *   - ESP32
 *
 * Funciones:
 *   - Relés
 *   - Tira RGB analógica por PWM
 *   - Tira WS2812 / NeoPixel (color global, individual y por segmento)
 *   - Buzzer activo con patrones no bloqueantes
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
 *   NOPAL:WSSEG:0,4,255,80,0
 *   NOPAL:BUZZER?
 *   NOPAL:BUZZER:BEEP
 *   NOPAL:BUZZER:DOUBLE
 *   NOPAL:BUZZER:ON
 *   NOPAL:BUZZER:OFF
 *   NOPAL:BUZZER:ALARM
 *   NOPAL:BUZZER:READY | WORKING | WAITING | MAINTENANCE | DISCONNECTED
 *
 * Respuesta de NOPAL:ID? (protocolo 4):
 *   NOPAL,role=accessory,chip=...,fw=4.2.0-ff,protocol=4,relays=4,pwm_led=1,
 *   ws2812=1,ws2812_count=8,buzzer=1,buzzer_pin=...,buzzer_pattern=...,
 *   wifi=1,wifi_connected=...,wifi_mode=...,hostname=...,ip=...,ota=1,
 *   ota_path=/update,uptime_ms=...,free_heap=...
 *
 * Portal web (cuando hay Wi-Fi):
 *   http://IP/             -> panel NOPAL embebido (relés, NeoPixel, PWM
 *                              RGB, buzzer y estado del dispositivo) --
 *                              misma autenticación que ElegantOTA, con un
 *                              botón adentro para ir directo a /update
 *   http://IP/api/status   -> estado en JSON (de solo lectura, sin auth)
 *   http://IP/update       -> panel de ElegantOTA (usuario/clave de secrets.h)
 *   http://IP/api/relay    -> control de relés por HTTP (GET ?n=1 consulta,
 *                              POST n=1&on=true/false cambia -- requiere
 *                              las mismas credenciales que ElegantOTA)
 *   http://IP/api/led      -> control completo o por segmento:
 *                              POST mode=ws2812&start=0&count=4&r=..&g=..&b=..
 *                              (misma autenticación)
 *   http://IP/api/buzzer   -> GET consulta el patrón activo, POST
 *                              action=BEEP|DOUBLE|ON|OFF|ALARM|READY|...
 *                              dispara un patrón (misma autenticación)
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
  #include <esp_system.h>
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

#define FW_VERSION "4.2.0-ff"
#define NOPAL_PROTOCOL 4

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
#define WS2812_PIN 23
#define WS2812_COUNT 20

// LED integrado de la placa ("Dev Module" típico) -- indica que el
// firmware está vivo. GPIO2 está libre en este mapeo de pines (no lo usa
// ningún relé/PWM/WS2812), a diferencia de ESP8266 (ver abajo).
#define STATUS_LED_ENABLE true
#define STATUS_LED_PIN 2
#define STATUS_LED_ACTIVE_LOW false

// Buzzer activo. GPIO4 no lo usa ningún relé (16-19), el PWM RGB
// (25-27), la tira WS2812 (23) ni el LED de estado (2) en este mapeo -- y
// no es uno de los pines de strapping del ESP32 (esos son GPIO0, GPIO2,
// GPIO5, GPIO12 y GPIO15), así que sirve como salida digital simple y
// segura para un buzzer activo.
#define BUZZER_ENABLE true
#define BUZZER_PIN 4


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
// GPIO0/D3 en vez de GPIO16 a propósito: en esta placa el PWM RGB no está
// cableado (solo se usa la tira WS2812), así que es el candidato ideal
// para heredar el pin de arranque conflictivo -- si nada physically tira
// de él, GPIO0 se queda en su pull-up interno y arranca normal. Si en
// algún momento SÍ cableas un LED RGB analógico acá, cambia este pin por
// otro libre antes de conectarlo.
#define PWM_LED_PIN_B 0   // D3

#define WS2812_ENABLE true
#define WS2812_PIN 2      // D4
#define WS2812_COUNT 20

// GPIO2 (D4), el LED integrado habitual de las NodeMCU/Wemos, ya lo usa
// WS2812_PIN en este mapeo -- no queda un pin libre y seguro para un LED
// de estado dedicado sin arriesgar un conflicto con la tira WS2812. Sin
// LED de estado en ESP8266 por ahora (ver STATUS_LED_ENABLE en ESP32).
#define STATUS_LED_ENABLE false

// Buzzer activo. GPIO16/D0 en vez de GPIO0/D3: no participa en la
// selección de modo de arranque del ESP8266 (a diferencia de GPIO0/2/15),
// así que un buzzer cableado ahí no puede impedir que la placa arranque.
// Antes vivía en GPIO0/D3 -- confirmado en hardware real que eso causaba
// arranques intermitentes con el buzzer conectado. GPIO16 queda libre
// porque PWM_LED_PIN_B se movió arriba a GPIO0 (sin cablear en esta placa).
#define BUZZER_ENABLE true
#define BUZZER_PIN 16  // D0

#endif


// ============================================================================
// NOMBRES DE RELÉS (opcionales, solo para el panel web)
// ============================================================================
//
// RELAY_COUNT vale 4 en ambas plataformas de arriba, así que este bloque
// vive fuera del #if ESP32/ESP8266. Igual que en NOPAL_ESP12E.ino: si
// secrets.h no define estos macros (lo normal, secrets.h.example no los
// trae por defecto) se usa "Relé N" -- un secrets.h viejo o incompleto
// sigue compilando sin tocarlo.
//

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

const char* const RELAY_NAMES[RELAY_COUNT] = {
  NOPAL_RELAY1_NAME,
  NOPAL_RELAY2_NAME,
  NOPAL_RELAY3_NAME,
  NOPAL_RELAY4_NAME
};


// ============================================================================
// PARÁMETROS DEL BUZZER (opcionales, con valor por defecto)
// ============================================================================
//
// Mismo criterio que los nombres de relé de arriba: si secrets.h no los
// define (lo normal, secrets.h.example los trae comentados), se usan
// estos valores por defecto -- un secrets.h viejo o incompleto sigue
// compilando sin tocarlo. El PIN del buzzer NO se configura acá: depende
// de la placa (ESP32 usa GPIO4, ESP8266 usa GPIO0/D3) y ya quedó fijado
// arriba, junto con BUZZER_ENABLE, en "CONFIGURACIÓN DE PINES".
//

#ifndef NOPAL_BUZZER_ACTIVE_HIGH
  #define NOPAL_BUZZER_ACTIVE_HIGH 1
#endif

// Si vale 1 (por defecto), el panel web hace sonar un patrón de buzzer
// acorde cada vez que se aplica una escena rápida (Listo/Trabajando/En
// espera/Alarma/Mantenimiento/Desconectado/Apagar), igual que hacía
// NOPAL_ESP12E_BUZZER.ino con applyScene(). En 0, las escenas solo
// cambian el color de la tira, sin sonido. El panel lee este valor desde
// /api/status (buzzer.scene_sounds) para decidir si manda ese segundo
// POST a /api/buzzer.
#ifndef NOPAL_BUZZER_SCENE_SOUNDS
  #define NOPAL_BUZZER_SCENE_SOUNDS 1
#endif

const bool BUZZER_ACTIVE_HIGH = NOPAL_BUZZER_ACTIVE_HIGH != 0;


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
// PANEL WEB NOPAL
// ============================================================================
//
// Mismo panel que nopal_accessory.ino (misma paleta/CSS, calcada a
// propósito), con una tarjeta nueva de "Buzzer activo" (beep, doble beep,
// patrones de escena y silenciar) portada de NOPAL_ESP12E_BUZZER.ino. Las
// "Escenas rápidas" ahora también disparan el patrón de buzzer que le
// corresponde a cada escena (si NOPAL_BUZZER_SCENE_SOUNDS está activo) --
// mismo acompañamiento sonoro que applyScene() hacía en
// NOPAL_ESP12E_BUZZER.ino, implementado acá en el propio panel (dos POST:
// uno a /api/led para el color, otro a /api/buzzer para el sonido) en vez
// de un comando SCENE: del lado del firmware, porque este sketch no trae
// el motor de escenas con estado en el servidor de esa firmware (ver la
// nota grande al principio del archivo).
//
// Diferencias reales frente al panel de NOPAL_ESP12E_BUZZER.ino (no son
// bugs, son decisiones de alcance explicadas arriba):
//   - Sin "Escenas del taller" animadas (parpadeo/respirar/carrera): este
//     firmware no tiene el motor de efectos StripEffect, así que las
//     "Escenas rápidas" de acá aplican un color fijo con la misma
//     paleta, sin animación -- se avisa en el propio panel.
//   - Sin brillo de NeoPixel ajustable ni entrada analógica (A0): igual
//     que en nopal_accessory.ino, esta placa no reserva pines para eso.
//   - Con tira RGB analógica por PWM (mode=pwm) y con el comando WSSEG de
//     segmentos: NOPAL_ESP12E_BUZZER.ino no los tenía, nopal_accessory.ino
//     sí, y acá se conservan.
//   - Con buzzer: la novedad de este sketch frente a nopal_accessory.ino.
//
const char INDEX_HTML[] PROGMEM = R"NOPALHTML(
<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NOPAL · Accesorio + Buzzer</title>
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
input[type=number]{width:72px}
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
    <div><h1>NOPAL · Accesorio + Buzzer</h1><div class="sub" id="identity">Cargando estado…</div></div>
  </div>
  <a class="button" href="/update">Actualizar firmware</a>
</header>

<section class="grid">
  <article class="card">
    <h2>Relés</h2>
    <div class="relays" id="relays"></div>
  </article>

  <article class="card" id="cardScenes">
    <h2>Escenas rápidas (NeoPixel)</h2>
    <p class="sub">Color fijo para toda la tira -- este firmware genérico no
      tiene parpadeo ni animaciones como el panel del ESP-12E. Si el
      buzzer está activo, cada escena también dispara su patrón de
      sonido.</p>
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

  <article class="card" id="cardWs">
    <h2>NeoPixel global</h2>
    <div class="row">
      <input id="wsColor" type="color" value="#41d17d">
      <button onclick="sendWsColor()">Aplicar color</button>
      <button class="red" onclick="sendWsOff()">Apagar tira</button>
    </div>
    <p class="sub" id="wsInfo">—</p>
  </article>

  <article class="card" id="cardWsPixel">
    <h2>NeoPixel individual</h2>
    <div class="row">
      <label>LED</label>
      <input id="pixel" type="number" min="1" value="1">
      <label>Cant.</label>
      <input id="pixelCount" type="number" min="1" value="1">
      <input id="pixelColor" type="color" value="#ff8c32">
      <button onclick="sendPixel()">Aplicar</button>
    </div>
    <p class="sub">La numeración empieza en 1. "Cant." son LEDs consecutivos
      a partir de ese número.</p>
  </article>

  <article class="card" id="cardPwm">
    <h2>Tira RGB analógica (PWM)</h2>
    <div class="row">
      <input id="pwmColor" type="color" value="#41d17d">
      <button onclick="sendPwmColor()">Aplicar color</button>
      <button class="red" onclick="sendPwmOff()">Apagar</button>
    </div>
  </article>

  <article class="card" id="cardBuzzer">
    <h2>Buzzer activo</h2>
    <div class="row">
      <button onclick="buzzer('BEEP')">Beep</button>
      <button onclick="buzzer('DOUBLE')">Doble beep</button>
      <button class="green" onclick="buzzer('READY')">Listo</button>
      <button class="amber" onclick="buzzer('WAITING')">Espera</button>
      <button class="red" onclick="buzzer('ALARM')">Alarma</button>
      <button onclick="buzzer('OFF')">Silenciar</button>
    </div>
    <p class="sub" id="buzzerInfo">—</p>
  </article>

  <article class="card full">
    <h2>Estado del dispositivo</h2>
    <div class="statgrid">
      <div class="stat"><b id="wifi">—</b><span>Wi-Fi</span></div>
      <div class="stat"><b id="ip">—</b><span>Dirección IP</span></div>
      <div class="stat"><b id="scene">—</b><span>Escena</span></div>
      <div class="stat"><b id="relaysOn">—</b><span>Relés activos</span></div>
      <div class="stat"><b id="buzzerState">—</b><span>Buzzer</span></div>
    </div>
    <pre id="details">Esperando datos…</pre>
  </article>
</section>

<footer>NOPAL Firmware 4.2-ff · Accesorio genérico ESP32 / ESP8266 con buzzer · Protocolo 4</footer>
</main>
<script>
const enc=o=>new URLSearchParams(o);
let lastScene='—';
let buzzerSceneSounds=false;

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
  try{await post('/api/led',{mode:'ws2812',r,g,b})}catch(e){alert(e.message)}
}
async function sendWsOff(){
  try{await post('/api/led',{mode:'ws2812',r:0,g:0,b:0})}catch(e){alert(e.message)}
}
async function sendPixel(){
  const [r,g,b]=rgb(document.getElementById('pixelColor').value);
  const n=parseInt(document.getElementById('pixel').value,10)||1;
  const count=parseInt(document.getElementById('pixelCount').value,10)||1;
  try{await post('/api/led',{mode:'ws2812',start:n-1,count,r,g,b})}catch(e){alert(e.message)}
}
async function sendPwmColor(){
  const [r,g,b]=rgb(document.getElementById('pwmColor').value);
  try{await post('/api/led',{mode:'pwm',r,g,b})}catch(e){alert(e.message)}
}
async function sendPwmOff(){
  try{await post('/api/led',{mode:'pwm',r:0,g:0,b:0})}catch(e){alert(e.message)}
}

async function buzzer(action){try{await post('/api/buzzer',{action})}catch(e){alert(e.message)}}

const SCENE_COLORS={
  READY:[25,220,95],WORKING:[20,175,255],WAITING:[255,145,20],
  ALARM:[255,0,0],MAINTENANCE:[175,45,255],DISCONNECTED:[105,120,125],OFF:[0,0,0]
};
async function scene(name){
  const c=SCENE_COLORS[name]||[0,0,0];
  try{
    await post('/api/led',{mode:'ws2812',r:c[0],g:c[1],b:c[2]});
    lastScene=name;
    document.getElementById('scene').textContent=name;
  }catch(e){alert(e.message)}
  if(buzzerSceneSounds){
    // Best-effort: si el buzzer falla no tapamos con otro alert() el
    // resultado del color, que ya se aplicó arriba.
    try{await post('/api/buzzer',{action:name})}catch(e){/* silencioso a propósito */}
  }
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
      (s.hostname||'—')+' · '+(s.chip||s.board||'—')+' · FW '+s.firmware;

    document.getElementById('wifi').textContent=
      s.wifi.connected?'Conectado':s.wifi.mode.toUpperCase();
    document.getElementById('ip').textContent=s.wifi.ip;
    document.getElementById('scene').textContent=lastScene;

    renderRelays(s.relays);

    const hasWs=!!(s.io&&s.io.ws2812);
    const hasPwm=!!(s.io&&s.io.pwm_led);
    const hasBuzzer=!!(s.io&&s.io.buzzer);
    document.getElementById('cardWs').style.display=hasWs?'':'none';
    document.getElementById('cardWsPixel').style.display=hasWs?'':'none';
    document.getElementById('cardScenes').style.display=hasWs?'':'none';
    document.getElementById('cardPwm').style.display=hasPwm?'':'none';
    document.getElementById('cardBuzzer').style.display=hasBuzzer?'':'none';

    if(hasWs){
      document.getElementById('pixel').max=s.io.ws2812_count;
      document.getElementById('wsInfo').textContent=
        s.io.ws2812_count+' LED(s), GPIO '+(s.io.ws2812_pin!==undefined?s.io.ws2812_pin:'—');
    }

    buzzerSceneSounds=hasBuzzer&&!!(s.buzzer&&s.buzzer.scene_sounds);

    if(hasBuzzer){
      document.getElementById('buzzerState').textContent=s.buzzer.pattern;
      document.getElementById('buzzerInfo').textContent=
        'GPIO '+s.buzzer.gpio+' · patrón '+s.buzzer.pattern+' · '+(s.buzzer.on?'sonando':'apagado')+
        (buzzerSceneSounds?' · suena con las escenas':' · silencioso con las escenas');
    }

    document.getElementById('details').textContent=
      `SSID: ${s.wifi.ssid||'—'}\nRSSI: ${s.wifi.rssi} dBm\n`+
      `AP recuperación: ${s.wifi.recovery_ap?('activo ('+(s.wifi.recovery_ssid||'—')+')'):'inactivo'}\n`+
      `Hostname: ${s.hostname||'—'}\nChip: ${s.chip||'—'}\n`+
      `Firmware: ${s.firmware} (protocolo ${s.protocol})\n`+
      (hasWs?`NeoPixel: ${s.io.ws2812_count} LED(s), GPIO ${s.io.ws2812_pin}\n`:``)+
      (hasPwm&&s.io.pwm_pins?`PWM RGB: GPIO ${s.io.pwm_pins.join('/')}\n`:``)+
      (hasBuzzer?`Buzzer: GPIO ${s.buzzer.gpio}, patrón ${s.buzzer.pattern}, salida ${s.buzzer.on?'ON':'OFF'}\n`:``)+
      `Heap libre: ${s.free_heap} bytes\nUptime: ${Math.floor(s.uptime_ms/1000)} s\n`+
      `Reset: ${s.reset_reason||'—'}`;
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
// ESTADO DEL BUZZER ACTIVO
// ============================================================================
//
// Estructuras y patrones portados tal cual de NOPAL_ESP12E_BUZZER.ino:
// cada patrón es una lista de pasos ON/OFF con su duración en ms, que
// serviceBuzzer() va recorriendo sin bloquear (ver la sección "BUZZER
// ACTIVO — PATRONES NO BLOQUEANTES" más abajo).
//

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


// Usada por el motor de patrones del buzzer (serviceBuzzer() /
// startBuzzerPattern()) para no programar duraciones de 0 ms -- portada
// de NOPAL_ESP12E_BUZZER.ino.
uint32_t maxU32(uint32_t first, uint32_t second) {
  return first > second ? first : second;
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


// Devuelve el mismo texto que antes imprimía printChipIdentification()
// directo por Serial -- factorizado en 4.1 para poder reusarlo también en
// buildStatusJson() (campo "chip") sin duplicar el #if ESP32/ESP8266.
String chipModelText() {

#if defined(ESP32)

  return String(ESP.getChipModel());

#elif defined(ESP8266)

  return String("ESP8266-") + String(ESP.getChipId(), HEX);

#endif
}


void printChipIdentification() {
  Serial.print(chipModelText());
}


// Texto legible de la razón del último reinicio -- útil para diagnosticar
// reinicios inesperados (brownout, watchdog, panic) desde el panel web sin
// tener que estar mirando el monitor Serial en el momento en que pasan.
String resetReasonText() {

#if defined(ESP32)

  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:   return "Encendido";
    case ESP_RST_EXT:       return "Pin de reset externo";
    case ESP_RST_SW:        return "Software (reinicio pedido por el firmware)";
    case ESP_RST_PANIC:     return "Pánico / excepción";
    case ESP_RST_INT_WDT:   return "Watchdog de interrupción";
    case ESP_RST_TASK_WDT:  return "Watchdog de tarea";
    case ESP_RST_WDT:       return "Watchdog";
    case ESP_RST_DEEPSLEEP: return "Salida de deep sleep";
    case ESP_RST_BROWNOUT:  return "Brownout (caída de voltaje)";
    case ESP_RST_SDIO:      return "SDIO";
    default:                return "Desconocido";
  }

#elif defined(ESP8266)

  return ESP.getResetReason();

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


bool setWs2812Segment(
  int start,
  int count,
  uint8_t red,
  uint8_t green,
  uint8_t blue,
  String& response
) {
#if WS2812_ENABLE
  if (start < 0 || count < 1 || start + count > WS2812_COUNT) {
    response = "ERR:INVALID_SEGMENT";
    return true;
  }
  const uint32_t color = strip.Color(red, green, blue);
  for (int pixel = start; pixel < start + count; pixel++) {
    strip.setPixelColor(pixel, color);
  }
  strip.show();
  response = "OK";
#else
  response = "ERR:UNSUPPORTED";
#endif
  return true;
}


// ============================================================================
// BUZZER ACTIVO — PATRONES NO BLOQUEANTES
// ============================================================================
//
// Motor de patrones portado tal cual de NOPAL_ESP12E_BUZZER.ino: cada
// patrón es una lista de pasos ON/OFF con su duración, y serviceBuzzer()
// los va avanzando sin bloquear -- se llama en cada vuelta de loop(),
// igual que serviceNetwork(), así que Wi-Fi, OTA, el panel web y el
// resto de comandos siguen respondiendo mientras el buzzer está sonando.
//

void setBuzzerOutput(bool on) {

#if BUZZER_ENABLE

  buzzerOutputOn = on;

  const uint8_t level =
    BUZZER_ACTIVE_HIGH
      ? (on ? HIGH : LOW)
      : (on ? LOW : HIGH);

  digitalWrite(BUZZER_PIN, level);

#endif
}


void initializeBuzzerSafely() {

#if BUZZER_ENABLE

  const uint8_t offLevel = BUZZER_ACTIVE_HIGH ? LOW : HIGH;

  // Precarga el nivel apagado antes de cambiar a OUTPUT, igual que ya
  // hacen los relés en setup(), para reducir al mínimo cualquier pulso
  // accidental durante el arranque.
  digitalWrite(BUZZER_PIN, offLevel);
  pinMode(BUZZER_PIN, OUTPUT);
  setBuzzerOutput(false);

#endif
}


String buzzerPatternName(BuzzerPattern pattern) {
  switch (pattern) {
    case BuzzerPattern::OFF:          return "OFF";
    case BuzzerPattern::CONTINUOUS:   return "ON";
    case BuzzerPattern::BEEP:         return "BEEP";
    case BuzzerPattern::DOUBLE_BEEP:  return "DOUBLE";
    case BuzzerPattern::READY:        return "READY";
    case BuzzerPattern::WORKING:      return "WORKING";
    case BuzzerPattern::WAITING:      return "WAITING";
    case BuzzerPattern::ALARM:        return "ALARM";
    case BuzzerPattern::MAINTENANCE:  return "MAINTENANCE";
    case BuzzerPattern::DISCONNECTED: return "DISCONNECTED";
  }

  return "UNKNOWN";
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

  if (patternText == "OFF" || patternText == "STOP") {
    stopBuzzer();
    return true;
  }

  if (patternText == "ON" || patternText == "CONTINUOUS") {
    startBuzzerPattern(
      BuzzerPattern::CONTINUOUS,
      BUZZER_PATTERN_CONTINUOUS,
      sizeof(BUZZER_PATTERN_CONTINUOUS) / sizeof(BUZZER_PATTERN_CONTINUOUS[0]),
      true
    );
    return true;
  }

  if (patternText == "BEEP") {
    startBuzzerPattern(
      BuzzerPattern::BEEP,
      BUZZER_PATTERN_BEEP,
      sizeof(BUZZER_PATTERN_BEEP) / sizeof(BUZZER_PATTERN_BEEP[0]),
      false
    );
    return true;
  }

  if (patternText == "DOUBLE" || patternText == "DOUBLE_BEEP") {
    startBuzzerPattern(
      BuzzerPattern::DOUBLE_BEEP,
      BUZZER_PATTERN_DOUBLE,
      sizeof(BUZZER_PATTERN_DOUBLE) / sizeof(BUZZER_PATTERN_DOUBLE[0]),
      false
    );
    return true;
  }

  if (patternText == "READY") {
    startBuzzerPattern(
      BuzzerPattern::READY,
      BUZZER_PATTERN_READY,
      sizeof(BUZZER_PATTERN_READY) / sizeof(BUZZER_PATTERN_READY[0]),
      false
    );
    return true;
  }

  if (patternText == "WORKING") {
    startBuzzerPattern(
      BuzzerPattern::WORKING,
      BUZZER_PATTERN_WORKING,
      sizeof(BUZZER_PATTERN_WORKING) / sizeof(BUZZER_PATTERN_WORKING[0]),
      false
    );
    return true;
  }

  if (patternText == "WAITING") {
    startBuzzerPattern(
      BuzzerPattern::WAITING,
      BUZZER_PATTERN_WAITING,
      sizeof(BUZZER_PATTERN_WAITING) / sizeof(BUZZER_PATTERN_WAITING[0]),
      false
    );
    return true;
  }

  if (patternText == "ALARM") {
    startBuzzerPattern(
      BuzzerPattern::ALARM,
      BUZZER_PATTERN_ALARM,
      sizeof(BUZZER_PATTERN_ALARM) / sizeof(BUZZER_PATTERN_ALARM[0]),
      true
    );
    return true;
  }

  if (patternText == "MAINTENANCE") {
    startBuzzerPattern(
      BuzzerPattern::MAINTENANCE,
      BUZZER_PATTERN_MAINTENANCE,
      sizeof(BUZZER_PATTERN_MAINTENANCE) / sizeof(BUZZER_PATTERN_MAINTENANCE[0]),
      false
    );
    return true;
  }

  if (patternText == "DISCONNECTED") {
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

#if BUZZER_ENABLE

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
  // 1536 alcanzaba en nopal_accessory.ino 4.1 -- Nopal_FF suma el objeto
  // "buzzer" completo (gpio/patrón/repetición/scene_sounds) más el campo
  // "buzzer"/"buzzer_pin" dentro de "io", así que se reserva más para
  // evitar reallocations a mitad de armado.
  json.reserve(1792);

  json += "{";
  json += "\"role\":\"accessory\",";

  json += "\"board\":\"";

#if defined(ESP32)
  json += "esp32_generic_ff";
#elif defined(ESP8266)
  json += "esp8266_generic_ff";
#endif

  json += "\",";

  json += "\"chip\":\"";
  json += jsonEscape(chipModelText());
  json += "\",";

  json += "\"firmware\":\"";
  json += FW_VERSION;
  json += "\",";

  json += "\"protocol\":";
  json += String(NOPAL_PROTOCOL);
  json += ",";

  json += "\"hostname\":\"";
  json += jsonEscape(String(NOPAL_HOSTNAME));
  json += "\",";

  json += "\"uptime_ms\":";
  json += String(millis());
  json += ",";

  json += "\"free_heap\":";
  json += String(ESP.getFreeHeap());
  json += ",";

  json += "\"reset_reason\":\"";
  json += jsonEscape(resetReasonText());
  json += "\",";

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

  // Estado individual de cada relé -- agregado en 4.1 para que el panel
  // web nuevo (INDEX_HTML) pueda pintar el badge ON/OFF de cada uno sin
  // tener que pegarle a /api/relay una vez por relé. Mismo shape que ya
  // usaba NOPAL_ESP12E.ino y que probe_wifi_board() en accessory_service.py
  // ya intenta leer con data.get("relays", []) -- backend viejo que no
  // conocía este campo simplemente seguía usando io.relays (el conteo).
  json += "\"relays\":[";

  for (uint8_t index = 0; index < RELAY_COUNT; index++) {
    if (index > 0) {
      json += ",";
    }

    json += "{\"n\":";
    json += String(index + 1);
    json += ",\"name\":\"";
    json += jsonEscape(String(RELAY_NAMES[index]));
    json += "\",\"gpio\":";
    json += String(RELAY_PINS[index]);
    json += ",\"on\":";
    json += getRelay(index) ? "true" : "false";
    json += "}";
  }

  json += "],";

  // Estado del buzzer -- no existía en nopal_accessory.ino, lo agrega
  // Nopal_FF. Mismo criterio que "relays": un backend viejo que no
  // conoce este campo simplemente lo ignora.
  json += "\"buzzer\":{";
  json += "\"enabled\":";
  json += BUZZER_ENABLE ? "true" : "false";
  json += ",\"gpio\":";
  json += String(BUZZER_PIN);
  json += ",\"active_high\":";
  json += BUZZER_ACTIVE_HIGH ? "true" : "false";
  json += ",\"on\":";
  json += buzzerOutputOn ? "true" : "false";
  json += ",\"pattern\":\"";
  json += buzzerPatternName(buzzerPattern);
  json += "\",\"repeating\":";
  json += buzzerPatternRepeats ? "true" : "false";
  json += ",\"scene_sounds\":";
  json += (NOPAL_BUZZER_SCENE_SOUNDS != 0) ? "true" : "false";
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

#if PWM_LED_ENABLE
  json += ",\"pwm_pins\":[";
  json += String(PWM_LED_PIN_R);
  json += ",";
  json += String(PWM_LED_PIN_G);
  json += ",";
  json += String(PWM_LED_PIN_B);
  json += "]";
#endif

  json += ",";
  json += "\"ws2812\":";
  json += WS2812_ENABLE ? "true" : "false";
  json += ",";
  json += "\"ws2812_count\":";
  json += String(WS2812_ENABLE ? WS2812_COUNT : 0);

#if WS2812_ENABLE
  json += ",\"ws2812_pin\":";
  json += String(WS2812_PIN);
#endif

  json += ",\"buzzer\":";
  json += BUZZER_ENABLE ? "true" : "false";

#if BUZZER_ENABLE
  json += ",\"buzzer_pin\":";
  json += String(BUZZER_PIN);
#endif

  json += "}";

  json += "}";

  return json;
}


// Protege los endpoints de control (relé/LED/buzzer) con las mismas
// credenciales que ya usa ElegantOTA (NOPAL_OTA_USERNAME/PASSWORD) -- son
// las que el usuario ya tiene que configurar en secrets.h y las mismas
// que NOPAL le pide al registrar un accesorio por WiFi, no hace falta una
// credencial nueva. /api/status y /health quedan sin auth a propósito
// (mismo criterio que ya tenían: son de solo lectura, no cambian nada de
// la placa).
// Declaración explícita: el auto-prototipado de Arduino (que normalmente
// permite llamar una función definida más abajo en el mismo .ino sin
// declararla antes) no resuelve bien un parámetro de puntero a función
// como el de parseAndSetColor -- confirmado compilando de verdad (PlatformIO):
// sin esto, "parseAndSetColor" no se declaró en este ámbito" adentro de
// los lambda de setupWebServer(). handleRelayCommand() y
// handleBuzzerCommand() no necesitan esto porque su firma es más simple
// y el auto-prototipado sí la resuelve.
bool parseAndSetColor(
  const String& command,
  uint8_t prefixLength,
  void (*setColor)(uint8_t, uint8_t, uint8_t),
  String& response
);
bool parseAndSetSegment(const String& command, uint8_t prefixLength, String& response);


bool checkApiAuth() {
  if (server.authenticate(NOPAL_OTA_USERNAME, NOPAL_OTA_PASSWORD)) {
    return true;
  }

  server.requestAuthentication();
  return false;
}


void setupWebServer() {
  // Desde 4.1 sirve el panel NOPAL embebido (INDEX_HTML) en vez de
  // redirigir directo a /update -- mismo criterio que NOPAL_ESP12E.ino:
  // protegido con las mismas credenciales que ElegantOTA, y con un botón
  // adentro del panel para quien de verdad quiera ir a /update.
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
      if (server.hasArg("start") || server.hasArg("count")) {
        const String command = String("WSSEG:") + server.arg("start") + "," + server.arg("count") + "," +
          server.arg("r") + "," + server.arg("g") + "," + server.arg("b");
        parseAndSetSegment(command, 6, response);
      } else {
        const String command =
          String("WS:") + server.arg("r") + "," + server.arg("g") + "," + server.arg("b");
        parseAndSetColor(command, 3, setWs2812Color, response);
      }
    }
#endif

    server.send(
      response.startsWith("ERR") ? 400 : 200,
      "text/plain",
      response
    );
  });


  // ------------------------------------------------------------------------
  // Buzzer por red -- mismo criterio que /api/relay y /api/led: traduce
  // los argumentos HTTP a un comando de texto y reusa handleBuzzerCommand()
  // para que la placa se comporte igual sin importar si el comando llegó
  // por Serial o por HTTP. Tanto el GET (consulta) como el POST (acción)
  // quedan atrás de checkApiAuth(), igual que /api/relay -- acá no hay
  // ninguna ruta de buzzer sin autenticar.
  // ------------------------------------------------------------------------

  server.on("/api/buzzer", HTTP_GET, []() {
    if (!checkApiAuth()) return;

    String response = "ERR:UNKNOWN_COMMAND";
    handleBuzzerCommand("BUZZER?", response);

    server.send(
      response.startsWith("ERR") ? 400 : 200,
      "text/plain",
      response
    );
  });

  server.on("/api/buzzer", HTTP_POST, []() {
    if (!checkApiAuth()) return;

    const String command = String("BUZZER:") + server.arg("action");
    String response = "ERR:INVALID_BUZZER_PATTERN";
    handleBuzzerCommand(command, response);

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

  Serial.print(",protocol=");
  Serial.print(NOPAL_PROTOCOL);

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

  // Campos del buzzer -- no existían en nopal_accessory.ino, los agrega
  // Nopal_FF. Mismo criterio que el resto de campos "extra" de esta
  // línea: un backend viejo que no los conoce simplemente los ignora.
  Serial.print(",buzzer=");
  Serial.print(BUZZER_ENABLE ? 1 : 0);

  Serial.print(",buzzer_pin=");
  Serial.print(BUZZER_PIN);

  Serial.print(",buzzer_pattern=");
  Serial.print(buzzerPatternName(buzzerPattern));

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


bool parseAndSetSegment(const String& command, uint8_t prefixLength, String& response) {
  int start;
  int count;
  int red;
  int green;
  int blue;
  const int parsedValues = sscanf(
    command.c_str() + prefixLength,
    "%d,%d,%d,%d,%d",
    &start,
    &count,
    &red,
    &green,
    &blue
  );
  if (parsedValues != 5) {
    response = "ERR:INVALID_SEGMENT";
    return true;
  }
  return setWs2812Segment(
    start,
    count,
    clampColor(red),
    clampColor(green),
    clampColor(blue),
    response
  );
}


// ============================================================================
// COMANDOS DEL BUZZER
// ============================================================================
//
// Mismo criterio que handleRelayCommand(): devuelve la respuesta por
// referencia en vez de imprimirla directo, para reusarse tanto desde
// handleCommand() (Serial) como desde /api/buzzer (HTTP) sin duplicar la
// lógica de los patrones. Lógica portada de
// handleBuzzerCommand()/BUZZER? en NOPAL_ESP12E_BUZZER.ino.
bool handleBuzzerCommand(const String& command, String& response) {

  if (command == "BUZZER?") {
    response =
      String("BUZZER,gpio=") + BUZZER_PIN +
      ",type=active,on=" + (buzzerOutputOn ? "1" : "0") +
      ",pattern=" + buzzerPatternName(buzzerPattern) +
      ",repeating=" + (buzzerPatternRepeats ? "1" : "0");

    return true;
  }

  if (!command.startsWith("BUZZER:")) {
    return false;
  }

  const String action = command.substring(7);

  if (!startBuzzerFromText(action)) {
    response = "ERR:INVALID_BUZZER_PATTERN";
    return true;
  }

  response = String("OK:") + buzzerPatternName(buzzerPattern);
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
  // Buzzer
  // ------------------------------------------------------------------------

  {
    String response;

    if (handleBuzzerCommand(command, response)) {
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

  if (command.startsWith("WSSEG:")) {
    String response;
    parseAndSetSegment(command, 6, response);
    Serial.println(response);
    return;
  }

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

  // Buzzer apagado desde el arranque, antes de que Wi-Fi/HTTP puedan
  // recibir ningún comando -- mismo criterio que los relés de arriba.
  initializeBuzzerSafely();

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

  // El buzzer se atiende siempre, sin importar el estado de la red --
  // igual que en NOPAL_ESP12E_BUZZER.ino, así un patrón en curso (ej.
  // ALARM repitiendo) no se corta ni se retrasa por Wi-Fi/OTA/Serial.
  serviceBuzzer();

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
