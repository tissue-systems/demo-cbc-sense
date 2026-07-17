// Wemos D1 Mini (ESP8266) + DHT22 → tissue Sense
//
// Onboarding + reporting firmware. On first boot the board brings up a Wi-Fi
// access point + captive portal so the user can enter their home Wi-Fi. It then
// links itself to the user's tissue account, stores its reporting credentials in
// flash, and publishes DHT22 temperature + humidity to tissue Sense over MQTTS.
// See ONBOARDING.md for the user-facing walkthrough.
//
// What the user sees:
//   1. Power on the board.
//   2. Join the Wi-Fi network "tissue-sense-XXXX"; the setup page opens.
//   3. Pick home Wi-Fi + password.
//   4. The board links to the account you set up on the setup page, then starts
//      reporting. Serial prints live temperature/humidity.
//
// Hold the FLASH button at boot to factory-reset (forget Wi-Fi + account link)
// so the board can be handed to someone else.
//
// Wiring (full diagrams in README.md). The sensor's DATA line goes to DHT_PIN
// (config.h — D4/GPIO2, the pin silk-printed "2"):
//   - 3-pin DHT22 breakout board:  + -> 3V3   out -> D4   - -> G
//     (the required pull-up resistor is already on the breakout)
//   - bare 4-pin DHT22: pin1 VCC -> 3V3, pin2 DATA -> D4, pin4 GND -> G,
//     plus a 10k pull-up resistor between pin1 (VCC) and pin2 (DATA).
//   GPIO2 also drives the onboard LED, so the LED is disabled in this wiring
//   and the serial log is the status channel.

#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <WiFiManager.h>          // tzapu/WiFiManager — SoftAP + DNS captive portal
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <DHT.h>
#include <time.h>

#include "config.h"

#if DEVICE_TLS_INSECURE == 0
#include "certs.h"                // provide ISRG_ROOT_X1 (see README) to pin the CA
#endif

// Onboard LED is GPIO2 (D4), active-low. When the DHT shares that pin the LED
// stays hands-off (no-op) so it can't corrupt the one-wire signal.
static const bool LED_AVAILABLE = (DHT_PIN != LED_BUILTIN);
#define LED_ON()   do { if (LED_AVAILABLE) digitalWrite(LED_BUILTIN, LOW);  } while (0)
#define LED_OFF()  do { if (LED_AVAILABLE) digitalWrite(LED_BUILTIN, HIGH); } while (0)

#define RESET_BTN_PIN  0          // FLASH button — hold at boot to factory-reset

DHT dht(DHT_PIN, DHT22);
BearSSL::WiFiClientSecure net;
PubSubClient mqtt(net);

// Reporting credentials, obtained at link time and persisted to flash.
static String deviceId, token, accountId;
static String ingestHost = INGEST_HOST;
static String topicPrefix;               // tissue/<account>/<device>/
static unsigned long lastReport = 0;

// ── LED ─────────────────────────────────────────────────────────────────────
static void blink(int times, int onMs, int offMs) {
  if (!LED_AVAILABLE) return;
  for (int i = 0; i < times; i++) { LED_ON(); delay(onMs); LED_OFF(); delay(offMs); }
}

// ── TLS / time ────────────────────────────────────────────────────────────────
static void applyTls(BearSSL::WiFiClientSecure &c) {
#if DEVICE_TLS_INSECURE
  c.setInsecure();               // encrypted but unvalidated — bring-up only
#else
  static BearSSL::X509List trust(ISRG_ROOT_X1);
  c.setTrustAnchors(&trust);
#endif
  c.setBufferSizes(512, 512);    // keep the handshake within ESP8266 heap
}

static void syncClock() {        // TLS cert validation needs a real clock
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  Serial.print("[time] syncing");
  time_t now = time(nullptr);
  while (now < 8 * 3600 * 2) { delay(300); Serial.print("."); now = time(nullptr); }
  Serial.println(" ok");
}

// ── credential storage (LittleFS) ─────────────────────────────────────────────
static bool loadCreds() {
  if (!LittleFS.exists("/creds.json")) return false;
  File f = LittleFS.open("/creds.json", "r");
  if (!f) return false;
  JsonDocument doc;
  DeserializationError e = deserializeJson(doc, f);
  f.close();
  if (e) return false;
  deviceId  = String((const char *)(doc["device_id"]  | ""));
  token     = String((const char *)(doc["token"]      | ""));
  accountId = String((const char *)(doc["account_id"] | ""));
  if (doc["ingest_host"].is<const char *>()) ingestHost = String((const char *)doc["ingest_host"]);
  return deviceId.length() > 0 && token.length() > 0;
}

static void saveCreds() {
  JsonDocument doc;
  doc["device_id"]   = deviceId;
  doc["token"]       = token;
  doc["account_id"]  = accountId;
  doc["ingest_host"] = ingestHost;
  File f = LittleFS.open("/creds.json", "w");
  if (!f) { Serial.println("[creds] save failed"); return; }
  serializeJson(doc, f);
  f.close();
}

// ── account link ──────────────────────────────────────────────────────────────
// POST our MAC to the setup endpoint. 200 → we're linked (creds returned once).
// Returns the HTTP status (or a negative transport error).
static int linkOnce() {
  BearSSL::WiFiClientSecure client;
  applyTls(client);
  HTTPClient https;
  if (!https.begin(client, CLAIM_URL)) return -1;
  https.addHeader("content-type", "application/json");
  String body = String("{\"mac\":\"") + WiFi.macAddress() + "\"}";
  int code = https.POST(body);
  if (code == 200) {
    JsonDocument doc;
    DeserializationError e = deserializeJson(doc, https.getString());
    https.end();
    if (e) return -2;
    deviceId  = String((const char *)(doc["device_id"]  | ""));
    token     = String((const char *)(doc["token"]      | ""));
    accountId = String((const char *)(doc["account_id"] | ""));
    if (doc["ingest_host"].is<const char *>()) ingestHost = String((const char *)doc["ingest_host"]);
    if (deviceId.length() && token.length()) { saveCreds(); return 200; }
    return -3;
  }
  https.end();
  return code;
}

static void linkLoop() {
  Serial.println("[link] linking this device to your account...");
  for (;;) {
    int code = linkOnce();
    if (code == 200) { Serial.printf("[link] linked. device=%s\n", deviceId.c_str()); return; }
    if (code == 202)      Serial.println("[link] waiting — finish signup on the setup page from your QR sticker");
    else if (code == 404) Serial.println("[link] not recognized yet — make sure you scanned this device's QR");
    else if (code == 409) Serial.println("[link] this device was already linked; factory-reset (hold FLASH at boot) to re-link");
    else                  Serial.printf("[link] retrying (status %d)\n", code);
    delay(CLAIM_POLL_MS);
  }
}

// ── MQTTS reporting ────────────────────────────────────────────────────────────
static void connectMqtt() {
  mqtt.setServer(ingestHost.c_str(), INGEST_PORT);
  mqtt.setBufferSize(512);
  while (!mqtt.connected()) {
    Serial.printf("[mqtt] connecting to %s:%d ... ", ingestHost.c_str(), INGEST_PORT);
    if (mqtt.connect(deviceId.c_str(), deviceId.c_str(), token.c_str())) {
      Serial.println("connected");
    } else {
      char err[80];
      net.getLastSSLError(err, sizeof(err));
      Serial.printf("failed rc=%d %s (retry 5s)\n", mqtt.state(), err[0] ? err : "");
      delay(5000);
    }
  }
}

static void publishMetric(const char *metric, float value, const char *unit) {
  JsonDocument doc;
  doc["value"] = round(value * 10.0) / 10.0;
  doc["unit"]  = unit;
  char bodyBuf[64];
  size_t n = serializeJson(doc, bodyBuf, sizeof(bodyBuf));
  String topic = topicPrefix + METRIC_PREFIX + "/" + metric;
  bool ok = mqtt.publish(topic.c_str(), (const uint8_t *)bodyBuf, n, false);
  Serial.printf("[pub] %s %s %s\n", topic.c_str(), bodyBuf, ok ? "ok" : "FAIL");
}

static void reportOnce() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (isnan(t) || isnan(h)) {
    Serial.println("[dht] read failed (NaN) — check wiring + 10k pull-up");
    return;
  }
  Serial.printf("[dht] %.1f C  %.1f %%RH\n", t, h);
  publishMetric("temperature", t, "C");
  publishMetric("humidity",    h, "%RH");
}

// ── portal ─────────────────────────────────────────────────────────────────────
// tissue-branded captive portal. The circle-cell logo (inline SVG data URI,
// canonical mark: app/brand/mark-circles.svg) and the device identity footer
// ride on every page via CSS on .wrap; the root menu page additionally gets a
// device-info card through WiFiManager's "custom" menu token. `{id}` / `{mac}`
// are substituted at runtime — WiFiManager stores raw pointers to the final
// strings, so the built copies live in function-statics (see setup()).
static const char PORTAL_HEAD_TPL[] PROGMEM = R"~(<style>
body{background:#f6faf8;color:#15251d;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
.wrap::before{content:'';display:block;width:64px;height:64px;margin:12px auto 0;background:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='22' cy='22' r='22' fill='%237cd1f7'/><circle cx='78' cy='22' r='22' fill='%23addcb9'/><circle cx='22' cy='78' r='22' fill='%23addcb9'/><circle cx='78' cy='78' r='20' fill='none' stroke='%2300b57e' stroke-width='4'/></svg>") center/contain no-repeat}
.wrap::after{content:'device {id} \00b7 mac {mac}';display:block;margin-top:20px;padding-top:10px;border-top:1px solid #dcebe2;color:#66796f;font-size:.78em;text-align:center}
h1{font-size:1.5em;margin:.2em 0 0;text-align:center}
h3{color:#66796f;font-weight:400;font-size:.95em;margin:.2em 0 1em;text-align:center}
button,input[type='button'],input[type='submit']{background-color:#00b57e}
input[type='file']{border-color:#00b57e}
a:hover{color:#00b57e}
input,select{border:1px solid #c4d9cd;border-radius:.3rem}
.msg{border-color:#dcebe2;border-left-color:#7cd1f7;background:#fff}
.tcard{background:#fff;border:1px solid #dcebe2;border-radius:.4rem;padding:4px 14px 12px;margin:6px 0 14px;font-size:.92em}
.tcard p{margin:.7em 0 0;color:#41544a}
.trow{display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid #eef5f0;padding:6px 0}
.trow span{color:#66796f}
.tcard code{font-family:Menlo,Consolas,monospace;font-size:1em}
@media(prefers-color-scheme:dark){
body{background:#0d1512;color:#e7f2ec}
.wrap::after{border-top-color:#22332b;color:#8ba295}
h3,.trow span{color:#8ba295}
.tcard,.msg{background:#131f19;border-color:#22332b;color:#e7f2ec}
.tcard p{color:#b7c9c0}
.trow{border-bottom-color:#1a2921}
input,select{background:#0d1512;color:#e7f2ec;border-color:#2c4237}
a{color:#e7f2ec}
}
</style>)~";

static const char PORTAL_MENU_TPL[] PROGMEM = R"~(<div class='tcard'>
<div class='trow'><span>Device ID</span><code>{id}</code></div>
<div class='trow'><span>MAC address</span><code>{mac}</code></div>
{linked}<p>This device is pre-linked to your tissue account. Connect it to your
Wi-Fi below and readings appear on your dashboard automatically.</p>
</div>)~";

static void onPortalStart(WiFiManager *wm) {
  Serial.printf("[portal] setup Wi-Fi up: %s\n", wm->getConfigPortalSSID().c_str());
  Serial.printf("[portal] join it, then follow: %s\n", WORKSHOP_URL);
  LED_ON();
}

static String apName() {
  char suffix[8];
  snprintf(suffix, sizeof(suffix), "%04X", ESP.getChipId() & 0xFFFF);
  return String(AP_NAME_PREFIX) + "-" + suffix;
}

// ── arduino entry points ─────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[boot] tissue Sense — D1 Mini + DHT22");

  // Print the station MAC at boot (no Wi-Fi needed) — useful for setup and support.
  WiFi.mode(WIFI_STA);
  Serial.printf("[boot] mac=%s\n", WiFi.macAddress().c_str());

  if (LED_AVAILABLE) { pinMode(LED_BUILTIN, OUTPUT); LED_OFF(); }
  else Serial.println("[boot] onboard LED disabled — its pin (GPIO2) is the DHT data line");
  pinMode(RESET_BTN_PIN, INPUT_PULLUP);

  LittleFS.begin();
  dht.begin();

  WiFiManager wm;
  wm.setConfigPortalTimeout(PORTAL_TIMEOUT_S);
  wm.setAPCallback(onPortalStart);

  // Hold FLASH at boot → full factory reset: forget Wi-Fi AND the account link.
  if (digitalRead(RESET_BTN_PIN) == LOW) {
    Serial.println("[boot] FLASH held — factory reset (Wi-Fi + account link)");
    wm.resetSettings();
    LittleFS.remove("/creds.json");
  }

  String ap = apName();

  // Load reporting creds before the portal so an already-linked device can show
  // its real device id on the setup pages.
  bool linked = loadCreds();

  // Portal branding — WiFiManager keeps pointers, so the strings are static.
  static String portalHead, portalMenu;
  portalHead = FPSTR(PORTAL_HEAD_TPL);
  portalHead.replace("{id}", ap);
  portalHead.replace("{mac}", WiFi.macAddress());
  portalMenu = FPSTR(PORTAL_MENU_TPL);
  portalMenu.replace("{id}", ap);
  portalMenu.replace("{mac}", WiFi.macAddress());
  portalMenu.replace("{linked}", linked
      ? "<div class='trow'><span>Linked as</span><code>" + deviceId + "</code></div>\n"
      : "");
  wm.setTitle("tissue Sense");
  wm.setCustomHeadElement(portalHead.c_str());
  wm.setCustomMenuHTML(portalMenu.c_str());
  std::vector<const char*> menu = {"custom", "wifi", "info"};
  wm.setMenu(menu);

  if (!wm.autoConnect(ap.c_str())) {
    Serial.println("[wifi] setup timed out — restarting");
    delay(500);
    ESP.restart();
  }
  Serial.printf("[wifi] connected: ssid=%s ip=%s\n",
                WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());

  syncClock();

  // Link to the account (once): reuse stored creds, else poll until provisioned.
  if (!linked) linkLoop();
  topicPrefix = String("tissue/") + accountId + "/" + deviceId + "/";
  Serial.printf("[link] reporting as %s\n", deviceId.c_str());

  applyTls(net);
  connectMqtt();
  blink(6, 80, 80);            // no-op when LED shares the sensor pin
  reportOnce();
  lastReport = millis();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) { delay(500); return; }
  if (!mqtt.connected()) connectMqtt();
  mqtt.loop();
  if (millis() - lastReport >= REPORT_INTERVAL_MS) {
    reportOnce();
    lastReport = millis();
  }
}
