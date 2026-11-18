// Signal Atlas sensor node for ESP32 boards.
//
// Every SCAN_INTERVAL_MS it scans all 2.4 GHz channels and publishes one flat JSON
// message per visible BSSID to
//     sensors/wifi-atlas/<node-id>/scan        (not retained)
// and keeps a retained status message on
//     sensors/wifi-atlas/<node-id>/status      (the broker's last-will sets it to offline)
// Row format: docs/data-contract.md.
//
// The node only listens to beacons. It changes nothing on any network.
// A classic ESP32 hears 2.4 GHz only, so its rows always have band "2.4".
//
// Build and flash with arduino-cli from this folder:
//     cp secrets.h.example secrets.h        (then edit secrets.h; it is git-ignored)
//     arduino-cli compile --profile esp32
//     arduino-cli upload  --profile esp32 -p COMx
//
// The node id is "esp32-" plus the last three bytes of the board's MAC address, so
// every board is unique without editing the sketch. Set NODE_ID in secrets.h to
// choose a name instead.

#include <WiFi.h>
#include <PubSubClient.h>
#include <time.h>
#include "secrets.h"

#ifndef SCAN_INTERVAL_MS
#define SCAN_INTERVAL_MS 5000UL
#endif
#ifndef MQTT_PORT
#define MQTT_PORT 1883
#endif
#ifndef NTP_SERVER
#define NTP_SERVER "pool.ntp.org"
#endif

static const char *TOPIC_ROOT = "sensors/wifi-atlas";

WiFiClient net;
PubSubClient mqtt(net);
char nodeId[24];
char scanTopic[64];
char statusTopic[64];
unsigned long lastScanStart = 0;
unsigned long lastReconnect = 0;
uint32_t seq = 0;
bool scanning = false;

static void makeNodeId() {
#ifdef NODE_ID
  snprintf(nodeId, sizeof(nodeId), "%s", NODE_ID);
#else
  uint8_t mac[6];
  WiFi.macAddress(mac);
  snprintf(nodeId, sizeof(nodeId), "esp32-%02x%02x%02x", mac[3], mac[4], mac[5]);
#endif
  snprintf(scanTopic, sizeof(scanTopic), "%s/%s/scan", TOPIC_ROOT, nodeId);
  snprintf(statusTopic, sizeof(statusTopic), "%s/%s/status", TOPIC_ROOT, nodeId);
}

// ISO 8601 UTC time, or an empty string while the clock is not set.
// The bridge stamps rows that arrive without a time.
static void isoTime(char *out, size_t len) {
  time_t now = time(nullptr);
  if (now < 1700000000) { out[0] = '\0'; return; }
  struct tm t;
  gmtime_r(&now, &t);
  strftime(out, len, "%Y-%m-%dT%H:%M:%SZ", &t);
}

// Copy an SSID into a JSON string: escape quotes and backslashes, drop control characters.
static void jsonEscape(const String &in, char *out, size_t len) {
  size_t o = 0;
  for (size_t i = 0; i < in.length() && o + 3 < len; i++) {
    char c = in[i];
    if (c == '"' || c == '\\') { out[o++] = '\\'; out[o++] = c; }
    else if ((uint8_t)c >= 0x20) out[o++] = c;
  }
  out[o] = '\0';
}

static void publishStatus(bool online) {
  char when[24], msg[160];
  isoTime(when, sizeof(when));
  if (when[0]) snprintf(msg, sizeof(msg), "{\"time\":\"%s\",\"node_id\":\"%s\",\"kind\":\"status\",\"online\":%s,\"uptime_s\":%lu}", when, nodeId, online ? "true" : "false", millis() / 1000UL);
  else snprintf(msg, sizeof(msg), "{\"node_id\":\"%s\",\"kind\":\"status\",\"online\":%s,\"uptime_s\":%lu}", nodeId, online ? "true" : "false", millis() / 1000UL);
  mqtt.publish(statusTopic, msg, true);   // retained
}

static bool connectMqtt() {
  char will[96];
  snprintf(will, sizeof(will), "{\"node_id\":\"%s\",\"kind\":\"status\",\"online\":false}", nodeId);
  char clientId[40];
  snprintf(clientId, sizeof(clientId), "wifi-atlas-%s", nodeId);
  // last will: retained, QoS 1, on the status topic
  if (!mqtt.connect(clientId, MQTT_USER, MQTT_PASSWORD, statusTopic, 1, true, will)) return false;
  publishStatus(true);
  return true;
}

static void publishScan(int count) {
  char when[24], ssid[72], msg[320];
  isoTime(when, sizeof(when));
  uint8_t *mine = WiFi.BSSID();
  for (int i = 0; i < count; i++) {
    uint8_t *b = WiFi.BSSID(i);
    if (!b) continue;
    bool associated = mine && memcmp(mine, b, 6) == 0;
    jsonEscape(WiFi.SSID(i), ssid, sizeof(ssid));
    int n = snprintf(msg, sizeof(msg), "{");
    if (when[0]) n += snprintf(msg + n, sizeof(msg) - n, "\"time\":\"%s\",", when);
    n += snprintf(msg + n, sizeof(msg) - n,
                  "\"node_id\":\"%s\",\"kind\":\"scan\",\"bssid\":\"%02x:%02x:%02x:%02x:%02x:%02x\",\"ssid\":\"%s\",\"band\":\"2.4\",\"channel\":%d,\"rssi_dbm\":%d,\"seq\":%lu%s}",
                  nodeId, b[0], b[1], b[2], b[3], b[4], b[5], ssid, (int)WiFi.channel(i), (int)WiFi.RSSI(i), (unsigned long)seq,
                  associated ? ",\"associated\":true" : "");
    if (n > 0 && n < (int)sizeof(msg)) mqtt.publish(scanTopic, msg, false);   // not retained
    mqtt.loop();
  }
  seq++;
}

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  makeNodeId();
  Serial.printf("\nSignal Atlas node %s\n", nodeId);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  configTime(0, 0, NTP_SERVER);            // UTC
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(512);
  mqtt.setKeepAlive(30);
}

void loop() {
  unsigned long now = millis();
  if (WiFi.status() == WL_CONNECTED) {
    if (!mqtt.connected() && now - lastReconnect > 5000UL) {
      lastReconnect = now;
      if (connectMqtt()) Serial.println("MQTT connected");
    }
    mqtt.loop();
  }
  // asynchronous scan: the loop keeps serving MQTT while the radio visits the channels
  if (!scanning && now - lastScanStart >= SCAN_INTERVAL_MS) {
    lastScanStart = now;
    // async, include hidden networks, active scan, 110 ms per channel
    if (WiFi.scanNetworks(true, true, false, 110) == WIFI_SCAN_RUNNING) scanning = true;
  }
  if (scanning) {
    int n = WiFi.scanComplete();
    if (n >= 0) {
      if (mqtt.connected()) publishScan(n);
      WiFi.scanDelete();
      scanning = false;
    } else if (n == WIFI_SCAN_FAILED) {
      scanning = false;
    }
  }
  delay(10);
}
