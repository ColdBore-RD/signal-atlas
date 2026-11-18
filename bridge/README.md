# Bridge (Phase 2)

Written and unit-tested without a broker. Never run against the real broker.

```
ESP32 / Pi  --MQTT-->  broker  --MQTT (read-only account)-->  bridge  --SSE /live-->  page
                                                                 \--> data/private/samples.live.ndjson
```

## Run

```
cd bridge
npm install
ATLAS_MQTT_URL=mqtt://<broker>:1883 ATLAS_MQTT_USER=<read-only user> ATLAS_MQTT_PASSWORD=<password> node bridge.mjs
```

Then start the page with the feed passed on: `node tools/serve.mjs --live-upstream http://127.0.0.1:8787/live`.
To keep the recorded rows on the next page load, add `"data/private/samples.live.ndjson"` to `paths.samples` in `data/private/config.local.json`.
Give the password through the environment of the service, not on the command line of a shared machine, and not in a file in git.

## Read-only broker account

The bridge never publishes. The broker must enforce that too. Mosquitto example (ACL file):

```
user wifi-atlas-bridge
topic read sensors/wifi-atlas/#
```

Each sensor gets its own account that may only write its own subtree:

```
user wifi-atlas-esp32-a1b2c3
topic write sensors/wifi-atlas/esp32-a1b2c3/#
```

## What it checks

`normalize.mjs` rejects a message when the topic is not `sensors/wifi-atlas/<node-id>/scan|status`, the payload is not a JSON object, a scan row has no valid BSSID, band or RSSI, or a status has no `online`. The node id is taken from the topic, never from the payload. A row without a usable time gets the arrival time. `GET /health` shows the counters and the last reject reason.
