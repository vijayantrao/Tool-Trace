// ToolTrace smart tool station: ESP32 + MFRC522 RFID reader + SSD1306 OLED.
//
// Tap your badge, then tap a tool's tag: the tool is checked out to you.
// Tap a tool you have out: it is returned. Press the red button first to
// report a problem: the tool is returned and quarantined.
//
// The station decides nothing itself. It sends each tap to the ToolTrace API
// as a signed MQTT message and shows the signed answer. Unsigned or stale
// answers are ignored, so a shared broker can't be used to spoof the screen.
//
// Wiring (also in wokwi/diagram.json):
//   MFRC522  SDA->5  SCK->18  MOSI->23  MISO->19  RST->4   3.3V, GND
//   SSD1306  SDA->21 SCL->22  (I2C 0x3C)
//   LEDs     green->25  red->26  amber->27  (each via 220 ohm to GND)
//   Buzzer   32 -> buzzer -> GND
//   Button   33 -> button -> GND  (internal pull-up), "report a problem"

#include <Arduino.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ArduinoJson.h>
#include <MFRC522.h>
#include <PubSubClient.h>
#include <SPI.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <sys/time.h>

#include "mbedtls/md.h"

#include "config.h"
#include "root_ca.h"
#include "station_core.h"

// ------------------------------------------------------------------ pins
static const uint8_t PIN_RFID_SS = 5, PIN_RFID_RST = 4;
static const uint8_t PIN_LED_GREEN = 25, PIN_LED_RED = 26, PIN_LED_AMBER = 27;
static const uint8_t PIN_BUZZER = 32, PIN_PROBLEM_BUTTON = 33;

static const uint32_t REPLY_TIMEOUT_MS = 5000;
static const uint32_t HELLO_EVERY_MS = 60000;
static const uint32_t RESULT_SHOW_MS = 4000;

// --------------------------------------------------------------- objects
MFRC522 rfid(PIN_RFID_SS, PIN_RFID_RST);
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
WiFiClientSecure tlsClient;
WiFiClient plainClient;
PubSubClient mqtt(MQTT_TLS ? static_cast<Client&>(tlsClient) : static_cast<Client&>(plainClient));

uint8_t stationKey[32];
tt::SeqClock seqClock;
tt::TapDebouncer debouncer;
tt::ProblemFlag problem;

String eventsTopic, repliesTopic, stationName = "ToolTrace";
uint64_t pendingSeq = 0;       // the message we're waiting for an answer to
uint32_t pendingSince = 0;
uint32_t resultUntil = 0;      // keep a result on screen until then
uint32_t lastHello = 0;
bool keyOk = false;

// ------------------------------------------------------------ crypto glue
static void mbedHmac(const uint8_t* key, size_t keyLen, const uint8_t* msg, size_t len, uint8_t out[32]) {
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_hmac(info, key, keyLen, msg, len, out);
}

static uint64_t epochMs() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return static_cast<uint64_t>(tv.tv_sec) * 1000ULL + static_cast<uint64_t>(tv.tv_usec / 1000);
}

// ------------------------------------------------------------- feedback
enum Led { LED_OFF, LED_GREEN, LED_RED, LED_AMBER, LED_BLUE };

static void setLed(Led led) {
  digitalWrite(PIN_LED_GREEN, led == LED_GREEN);
  digitalWrite(PIN_LED_RED, led == LED_RED);
  // No blue LED on the board: "blue" (information) shows as green + amber.
  digitalWrite(PIN_LED_AMBER, led == LED_AMBER || led == LED_BLUE);
  if (led == LED_BLUE) digitalWrite(PIN_LED_GREEN, HIGH);
}

static void beep(bool ok) {
  if (ok) {
    tone(PIN_BUZZER, 2200, 80);
  } else {
    tone(PIN_BUZZER, 400, 250);
  }
}

static void show(const String& l1, const String& l2, const String& header = "") {
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  oled.print(header.length() ? header : stationName);
  oled.drawFastHLine(0, 11, 128, SSD1306_WHITE);
  // Big text when it fits (10 chars at size 2), small otherwise.
  oled.setTextSize(l1.length() <= 10 ? 2 : 1);
  oled.setCursor(0, 20);
  oled.print(l1);
  oled.setTextSize(1);
  oled.setCursor(0, 48);
  oled.print(l2);
  oled.display();
}

static void showIdle() {
  setLed(LED_OFF);
  if (problem.active(millis())) {
    show("Problem?", "Tap the tool to return", "Report a problem");
    digitalWrite(PIN_LED_AMBER, HIGH);
  } else {
    show("Tap badge", "then tap a tool");
  }
}

// ----------------------------------------------------------- networking
static void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  show("Wi-Fi...", WIFI_SSID, "Connecting");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) delay(250);
}

static void syncClock() {
  // Signed messages carry a timestamp; the server rejects clocks more than 5 minutes off.
  show("Clock...", "pool.ntp.org", "Connecting");
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  while (epochMs() < 1700000000000ULL) delay(250);
}

static bool publishEvent(const char* type, const String& uid, bool problemFlag) {
  uint64_t seq = seqClock.next(epochMs());
  std::string json = tt::eventJson(mbedHmac, stationKey, sizeof stationKey, STATION_ID, seq, type, uid.c_str(),
                                   problemFlag ? "problem" : "ok");
  if (json.empty() || !mqtt.publish(eventsTopic.c_str(), json.c_str())) return false;
  pendingSeq = seq;
  pendingSince = millis();
  return true;
}

static void onReply(char* topic, uint8_t* payload, unsigned int length) {
  (void)topic;
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) return;

  tt::Reply r;
  r.seq = doc["seq"].as<uint64_t>();
  r.ok = doc["ok"].as<bool>();
  r.led = doc["led"] | "";
  r.l1 = doc["l1"] | "";
  r.l2 = doc["l2"] | "";
  r.sig = doc["sig"] | "";

  // Trust nothing that isn't signed with our key and doesn't answer our last message.
  if (pendingSeq == 0 || !tt::verifyReply(mbedHmac, stationKey, sizeof stationKey, STATION_ID, pendingSeq, r)) return;
  pendingSeq = 0;

  if (r.l1 == "Ready") {  // answer to hello
    stationName = r.l2.c_str();
    showIdle();
    return;
  }
  Led led = r.led == "green" ? LED_GREEN : r.led == "red" ? LED_RED : r.led == "amber" ? LED_AMBER : LED_BLUE;
  setLed(led);
  beep(r.ok);
  show(r.l1.c_str(), r.l2.c_str());
  resultUntil = millis() + RESULT_SHOW_MS;
}

static void connectMqtt() {
  if (mqtt.connected()) return;
  show("Server...", MQTT_HOST, "Connecting");
  String clientId = String("tt-station-") + String(STATION_ID).substring(0, 8);
  while (!mqtt.connected()) {
    bool ok = strlen(MQTT_USERNAME) ? mqtt.connect(clientId.c_str(), MQTT_USERNAME, MQTT_PASSWORD)
                                    : mqtt.connect(clientId.c_str());
    if (!ok) {
      show("No server", "Retrying...", "Connecting");
      delay(2000);
    }
  }
  mqtt.subscribe(repliesTopic.c_str(), 1);
  publishEvent("hello", "", false);
  lastHello = millis();
}

// ----------------------------------------------------------------- setup
void setup() {
  Serial.begin(115200);
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_LED_AMBER, OUTPUT);
  pinMode(PIN_PROBLEM_BUTTON, INPUT_PULLUP);

  Wire.begin(21, 22);
  oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  SPI.begin();
  rfid.PCD_Init();

  keyOk = tt::fromHex(STATION_KEY_HEX, stationKey, sizeof stationKey);
  if (!keyOk) {
    show("Bad key", "Check config.h", "Setup needed");
    setLed(LED_RED);
    return;
  }
  eventsTopic = String(MQTT_TOPIC_PREFIX) + "/stations/" + STATION_ID + "/events";
  repliesTopic = String(MQTT_TOPIC_PREFIX) + "/stations/" + STATION_ID + "/replies";

  connectWifi();
  syncClock();
  if (MQTT_TLS) tlsClient.setCACert(ROOT_CA_PEM);
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(512);
  mqtt.setCallback(onReply);
  connectMqtt();
}

// ------------------------------------------------------------------ loop
void loop() {
  if (!keyOk) return;
  connectWifi();
  connectMqtt();
  mqtt.loop();
  uint32_t now = millis();

  if (pendingSeq && now - pendingSince > REPLY_TIMEOUT_MS) {
    pendingSeq = 0;
    setLed(LED_RED);
    beep(false);
    show("No answer", "Check the board", "Server");
    resultUntil = now + RESULT_SHOW_MS;
  }
  if (resultUntil && static_cast<int32_t>(now - resultUntil) >= 0) {
    resultUntil = 0;
    showIdle();
  }
  if (now - lastHello > HELLO_EVERY_MS && !pendingSeq) {
    publishEvent("hello", "", false);  // heartbeat: shows the station as online
    lastHello = now;
  }

  static bool lastButton = HIGH;
  bool button = digitalRead(PIN_PROBLEM_BUTTON);
  if (lastButton == HIGH && button == LOW) {
    problem.arm(now);
    tone(PIN_BUZZER, 1200, 60);
    resultUntil = 0;
    showIdle();
  }
  lastButton = button;

  if (pendingSeq) return;  // one tap at a time
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;
  String uid = tt::uidHex(rfid.uid.uidByte, rfid.uid.size).c_str();
  rfid.PICC_HaltA();
  if (!debouncer.accept(uid.c_str(), now)) return;

  bool flagged = problem.active(now);
  if (flagged) problem.clear();
  setLed(LED_OFF);
  show("...", uid);
  if (!publishEvent("tap", uid, flagged)) {
    setLed(LED_RED);
    show("Not sent", "Try again");
    resultUntil = now + RESULT_SHOW_MS;
  }
}
