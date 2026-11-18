# Collectors (Phase 2)

Written, not yet run against any network or board. Row format: `docs/data-contract.md`.

| Part | What it does | Status |
|---|---|---|
| `pi/scan.py` | `iw` scan, ping and optional iperf3 probes; NDJSON file and MQTT | Parsers tested offline (`python3 -m unittest collectors/pi/test_scan.py`). Never run on a Pi. |
| `pi/survey.py` | Walk-survey scanner for a Pi on a power bank: `iw` scan loop, a phone page with a "mark" button, local NDJSON only | Tested offline (`python3 -m unittest collectors/pi/test_survey.py`). Never run on a Pi. Steps: `pi/SURVEY.md`. |
| `esp32/wifi_atlas_node/` | Arduino sketch: scans every 5 s, one MQTT message per BSSID, last-will status | Never compiled or flashed. |

Topics (flat JSON, only `status` is retained):

```
sensors/wifi-atlas/<node-id>/scan      one message per BSSID per scan; the Pi also sends its probe rows here
sensors/wifi-atlas/<node-id>/status    {"node_id": ..., "kind": "status", "online": true|false}
```

## Before the first run

1. Broker accounts: one publisher account per node, limited to `sensors/wifi-atlas/<node-id>/#`, and one read-only account for the bridge. Passwords live in the password manager.
2. Check that the broker can be reached from the Wi-Fi side of the network. The Wi-Fi clients and the wired servers are on different subnets.
3. ESP32: `cp secrets.h.example secrets.h`, fill it in, then `arduino-cli compile --profile esp32` and `arduino-cli upload --profile esp32 -p COMx`.
4. Pi: `pip install paho-mqtt`, copy `pi/scan.env.example` to `/etc/wifi-atlas/scan.env`, install the service from `pi/wifi-atlas-scan.service.example`. Try `python3 scan.py --once` first: it prints one cycle and publishes nothing.
5. Add each sensor to the node file (`data/private/nodes.json`) with its level and x, y in metres, or it is listed as a roaming device.

## Known limits

- A classic ESP32 hears 2.4 GHz only. 5 GHz readings come from the Pi and from the walk test.
- An ESP32 leaves its channel for about 1.5 s per scan. Its own link is briefly deaf during that time.
- The ESP32 reports no noise floor. The Pi reports it for the channel in use only.
