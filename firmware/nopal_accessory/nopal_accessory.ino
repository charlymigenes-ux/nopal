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
 *
 * Comunicación:
 *   Serial a 115200 baudios
 *   Un comando por línea terminado en \n
 *
 * Comandos:
 *   NOPAL:ID?
 *   NOPAL:R1:ON
 *   NOPAL:R1:OFF
 *   NOPAL:R1?
 *   NOPAL:LED:255,0,0
 *   NOPAL:WS:0,255,0
 */

#include <Arduino.h>

#if defined(ESP32)
  #include <esp_arduino_version.h>
#elif defined(ESP8266)
  #include <ESP8266WiFi.h>
#else
  #error "Este firmware solamente es compatible con ESP32 o ESP8266."
#endif


// ============================================================================
// CONFIGURACIÓN GENERAL
// ============================================================================

#define FW_VERSION "1.1"

// La mayoría de módulos de relés se activan con LOW.
const bool RELAY_ACTIVE_LOW = true;


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


void printChipIdentification() {

#if defined(ESP32)

  Serial.print(ESP.getChipModel());

#elif defined(ESP8266)

  Serial.print("ESP8266-");
  Serial.print(ESP.getChipId(), HEX);

#endif
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
  Serial.println(
    WS2812_ENABLE
      ? WS2812_COUNT
      : 0
  );
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
    Serial.println("ERR:INVALID_RELAY");
    return true;
  }

  String action =
    command.substring(colonPosition + 1);

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
// PROCESAMIENTO DE COMANDOS
// ============================================================================

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


  // ------------------------------------------------------------------------
  // Relés
  // ------------------------------------------------------------------------

  if (handleRelayCommand(command)) {
    return;
  }


  // ------------------------------------------------------------------------
  // RGB PWM
  // ------------------------------------------------------------------------

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


  // ------------------------------------------------------------------------
  // WS2812
  // ------------------------------------------------------------------------

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

  inputLine.reserve(128);

  // Configuración segura de relés.
  for (uint8_t index = 0; index < RELAY_COUNT; index++) {
    pinMode(RELAY_PINS[index], OUTPUT);
    setRelay(index, false);
  }

  setupPwmLed();

  // Apagar RGB al iniciar.
  setPwmLedColor(0, 0, 0);

#if WS2812_ENABLE

  strip.begin();
  strip.clear();
  strip.show();

#endif

  delay(100);

  Serial.println("NOPAL:READY");
}


// ============================================================================
// LOOP
// ============================================================================

void loop() {

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
