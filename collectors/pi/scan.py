#!/usr/bin/env python3
"""Signal Atlas collector for a Raspberry Pi (tested design target: Pi 500, Raspberry Pi OS).

What it does, in a loop:
  1. `iw dev <iface> scan trigger`, then `scan dump`: one row per BSSID heard in this
     scan (RSSI, channel, band, SSID).
  2. `iw dev <iface> link` and `iw dev <iface> survey dump`: which BSSID the Pi is
     attached to, and the noise floor of the channel in use.
  3. ping, and optionally iperf3, to each wired reference: one probe row per target.
Every row is appended to an NDJSON file and published to MQTT as flat JSON on
    sensors/wifi-atlas/<node-id>/scan
A retained status message is kept on
    sensors/wifi-atlas/<node-id>/status      (the broker sets it to offline if the Pi dies)
Row format: docs/data-contract.md.

It only listens and probes. It changes no network setting.
Starting a scan needs root; reading its results does not. For a user without root,
set ATLAS_SCAN_SUDO=1 and allow that user exactly the one command
`iw dev <iface> scan trigger` in sudoers (collectors/pi/SURVEY.md, "Once").

Configuration comes from environment variables (never from this file):
  ATLAS_NODE_ID            default "pi-500"
  ATLAS_IFACE              default "wlan0"
  ATLAS_SCAN_INTERVAL_S    default 10
  ATLAS_SCAN_SUDO          "1" to start the scan through `sudo -n`; default off
  ATLAS_OUT                NDJSON file to append to, default "./samples.pi.ndjson"; "-" for none
  ATLAS_MQTT_HOST          no default; without it nothing is published
  ATLAS_MQTT_PORT          default 1883
  ATLAS_MQTT_USER          publisher account for this node
  ATLAS_MQTT_PASSWORD      its password (keep it in the service's environment file, not in git)
  ATLAS_PROBE_TARGETS      "name=host,name=host", for example "home-server=192.0.2.10,nas=192.0.2.11"
  ATLAS_PROBE_INTERVAL_S   default 60
  ATLAS_PING_COUNT         default 10
  ATLAS_IPERF3             "1" to run iperf3 (each target must run `iperf3 -s`); default off
  ATLAS_IPERF_INTERVAL_S   default 900
  ATLAS_IPERF_SECONDS      default 5

Other ways to run it:
  python3 scan.py --once             one cycle, print the rows, publish nothing
  python3 scan.py --parse FILE       parse saved `iw scan` output and print the rows (no radio needed)
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

TOPIC_ROOT = "sensors/wifi-atlas"


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def band_of(freq_mhz):
    if 2400 <= freq_mhz < 2500:
        return "2.4"
    if 4900 <= freq_mhz < 5900:
        return "5"
    return None  # 6 GHz and others are not part of this project


def channel_of(freq_mhz):
    if freq_mhz == 2484:
        return 14
    if 2400 <= freq_mhz < 2500:
        return (freq_mhz - 2407) // 5
    if 5000 <= freq_mhz < 5900:
        return (freq_mhz - 5000) // 5
    return None


def parse_iw_scan(text, node_id, when=None, max_age_ms=None):
    """Rows from the output of `iw dev <iface> scan` or `scan dump`. Pure function: no I/O.
    The kernel keeps a radio in its list for about 30 s after it was last heard. With
    max_age_ms, radios last heard longer ago are left out, so a row is a measurement of
    this scan and not of the place where the Pi was half a minute ago."""
    when = when or now_iso()
    rows, cur = [], None

    def flush():
        if cur and cur.get("rssi_dbm") is not None and cur.get("band"):
            age = cur.pop("_age_ms", None)
            if max_age_ms is None or age is None or age <= max_age_ms:
                rows.append(cur)

    for line in text.splitlines():
        m = re.match(r"^BSS ([0-9a-fA-F:]{17})(\(on [^)]+\))?(.*)$", line)
        if m:
            flush()
            cur = {"time": when, "node_id": node_id, "kind": "scan", "bssid": m.group(1).lower(), "ssid": "",
                   "band": None, "channel": None, "rssi_dbm": None}
            if "associated" in m.group(3):
                cur["associated"] = True
            continue
        if cur is None:
            continue
        s = line.strip()
        if s.startswith("freq:"):
            freq = int(float(s.split(":", 1)[1].strip()))
            cur["band"] = band_of(freq)
            cur["channel"] = channel_of(freq)
        elif s.startswith("signal:"):
            m2 = re.search(r"(-?\d+(\.\d+)?)\s*dBm", s)
            if m2:
                cur["rssi_dbm"] = float(m2.group(1))
        elif s.startswith("last seen:") and s.endswith("ms ago"):
            cur["_age_ms"] = int(s.split()[2])
        elif s.startswith("SSID:"):
            ssid = s[5:].strip()
            if "\\x00" not in ssid:
                cur["ssid"] = ssid
        elif s.startswith("DS Parameter set: channel"):
            cur["channel"] = int(s.rsplit(" ", 1)[1])
        elif s.startswith("* primary channel:"):
            cur["channel"] = int(s.rsplit(" ", 1)[1])
    flush()
    return rows


def parse_iw_link(text):
    """The BSSID the interface is attached to, or None."""
    m = re.search(r"Connected to ([0-9a-fA-F:]{17})", text)
    return m.group(1).lower() if m else None


def parse_survey_noise(text):
    """Noise floor in dBm of the channel in use, from `iw dev <iface> survey dump`, or None."""
    blocks = re.split(r"\n(?=Survey data from)", text)
    for block in blocks:
        if "[in use]" in block:
            m = re.search(r"noise:\s*(-?\d+)\s*dBm", block)
            if m:
                return float(m.group(1))
    return None


def parse_ping(text):
    """latency (average), jitter (mean deviation) and loss from ping output."""
    out = {}
    m = re.search(r"(\d+(\.\d+)?)% packet loss", text)
    if m:
        out["loss_pct"] = float(m.group(1))
    m = re.search(r"= ([\d.]+)/([\d.]+)/([\d.]+)/([\d.]+) ms", text)
    if m:
        out["latency_ms"] = float(m.group(2))
        out["jitter_ms"] = float(m.group(4))
    return out


def parse_iperf3(text):
    """Received throughput in Mbit/s from `iperf3 -J`, or None."""
    try:
        data = json.loads(text)
        return round(data["end"]["sum_received"]["bits_per_second"] / 1e6, 1)
    except (ValueError, KeyError, TypeError):
        return None


def run(cmd, timeout):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


IW_PATH = "/usr/sbin:/sbin"   # where `iw` lives; a plain user does not have these on PATH


def iw_binary():
    return shutil.which("iw") or shutil.which("iw", path=IW_PATH) or "iw"


SCAN_WAIT_S = 4.5   # one scan of both bands takes 4.0 to 4.1 s on the Pi 4 (measured)


def trigger_command(iface, with_sudo=False):
    """The command that starts a scan: the only step that needs root. with_sudo runs this
    one command through `sudo -n`, which never asks for a password: it works only when
    sudoers allows the user exactly this command, and fails at once otherwise."""
    cmd = [iw_binary(), "dev", iface, "scan", "trigger"]
    return ["sudo", "-n"] + cmd if with_sudo else cmd


def scan_text(iface, with_sudo=False, wait_s=SCAN_WAIT_S):
    """One scan in two steps: start it (root), wait, read the list (no root).
    Returns (text of `scan dump`, error text of the start, age limit in ms for the rows).

    Plain `iw dev <iface> scan` does both steps and waits for the end by itself. On the
    Pi 4 (iw 6.9) about one such call in twenty never returned and kept one core busy,
    as root when started through sudo. The start alone returns at once, so nothing can hang.
    May raise FileNotFoundError (no `iw`) or subprocess.TimeoutExpired."""
    started = time.monotonic()
    start = subprocess.run(trigger_command(iface, with_sudo), capture_output=True, text=True, timeout=10, check=False)
    problem = (start.stderr or "").strip()
    if start.returncode and "busy" not in problem.lower():    # busy = a scan of someone else is running: read that one
        return "", problem, 0
    text = ""
    for extra in (wait_s, 1.0, 1.0, 1.0):     # a slower radio gets up to 3 s more
        time.sleep(extra)
        text = subprocess.run([iw_binary(), "dev", iface, "scan", "dump"], capture_output=True, text=True, timeout=10, check=False).stdout
        limit_ms = int((time.monotonic() - started) * 1000) + 500
        if parse_iw_scan(text, "", "", limit_ms):
            break
    return text, problem, limit_ms


def scan_cycle(iface, node_id, with_sudo=False):
    when = now_iso()
    try:
        text, _, limit_ms = scan_text(iface, with_sudo)
    except (OSError, subprocess.TimeoutExpired):
        text, limit_ms = "", None
    rows = parse_iw_scan(text, node_id, when, limit_ms)
    linked = parse_iw_link(run([iw_binary(), "dev", iface, "link"], 5))
    noise = parse_survey_noise(run([iw_binary(), "dev", iface, "survey", "dump"], 5))
    for row in rows:
        row.pop("associated", None)
        if linked and row["bssid"] == linked:
            row["associated"] = True
            if noise is not None:
                row["noise_dbm"] = noise      # known only for the channel in use
    return rows, linked


def probe_cycle(targets, node_id, linked, ping_count, with_iperf, iperf_seconds):
    rows = []
    for name, host in targets:
        row = {"time": now_iso(), "node_id": node_id, "kind": "probe", "target": name}
        if linked:
            row["bssid"] = linked
        row.update(parse_ping(run(["ping", "-n", "-q", "-c", str(ping_count), "-i", "0.2", "-W", "1", host], ping_count + 10)))
        if with_iperf:
            mbps = parse_iperf3(run(["iperf3", "-c", host, "-J", "-t", str(iperf_seconds), "-R"], iperf_seconds + 15))
            if mbps is not None:
                row["throughput_mbps"] = mbps
        if len(row) > 4:
            rows.append(row)
    return rows


def parse_targets(spec):
    out = []
    for part in filter(None, (p.strip() for p in (spec or "").split(","))):
        name, _, host = part.partition("=")
        if name and host:
            out.append((name.strip(), host.strip()))
    return out


class Publisher:
    """MQTT output. Optional: without a host or without paho-mqtt it does nothing."""

    def __init__(self, node_id, env):
        self.client = None
        self.node_id = node_id
        host = env.get("ATLAS_MQTT_HOST")
        if not host:
            return
        try:
            import paho.mqtt.client as mqtt  # pip install paho-mqtt
        except ImportError:
            print("paho-mqtt is not installed: rows go to the file only", file=sys.stderr)
            return
        self.status_topic = f"{TOPIC_ROOT}/{node_id}/status"
        try:
            self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"wifi-atlas-{node_id}")
        except AttributeError:  # paho-mqtt 1.x
            self.client = mqtt.Client(client_id=f"wifi-atlas-{node_id}")
        if env.get("ATLAS_MQTT_USER"):
            self.client.username_pw_set(env["ATLAS_MQTT_USER"], env.get("ATLAS_MQTT_PASSWORD"))
        self.client.will_set(self.status_topic, json.dumps({"node_id": node_id, "kind": "status", "online": False}), qos=1, retain=True)
        self.client.connect_async(host, int(env.get("ATLAS_MQTT_PORT", "1883")), keepalive=60)
        self.client.on_connect = lambda c, *_: c.publish(self.status_topic, json.dumps(
            {"time": now_iso(), "node_id": node_id, "kind": "status", "online": True}), qos=1, retain=True)
        self.client.loop_start()

    def publish(self, rows):
        if not self.client:
            return
        for row in rows:
            self.client.publish(f"{TOPIC_ROOT}/{self.node_id}/scan", json.dumps(row, separators=(",", ":")), qos=0, retain=False)

    def close(self):
        if self.client:
            self.client.publish(self.status_topic, json.dumps({"time": now_iso(), "node_id": self.node_id, "kind": "status", "online": False}), qos=1, retain=True)
            self.client.loop_stop()
            self.client.disconnect()


def main(argv, env):
    node_id = env.get("ATLAS_NODE_ID", "pi-500")
    iface = env.get("ATLAS_IFACE", "wlan0")
    if len(argv) >= 3 and argv[1] == "--parse":
        with open(argv[2], encoding="utf-8", errors="replace") as fh:
            for row in parse_iw_scan(fh.read(), node_id):
                print(json.dumps(row))
        return 0
    once = "--once" in argv
    out_path = env.get("ATLAS_OUT", "./samples.pi.ndjson")
    scan_every = float(env.get("ATLAS_SCAN_INTERVAL_S", "10"))
    probe_every = float(env.get("ATLAS_PROBE_INTERVAL_S", "60"))
    iperf_every = float(env.get("ATLAS_IPERF_INTERVAL_S", "900"))
    targets = parse_targets(env.get("ATLAS_PROBE_TARGETS"))
    publisher = None if once else Publisher(node_id, env)
    last_probe = last_iperf = 0.0
    try:
        while True:
            started = time.monotonic()
            rows, linked = scan_cycle(iface, node_id, env.get("ATLAS_SCAN_SUDO") == "1")
            if targets and started - last_probe >= probe_every:
                with_iperf = env.get("ATLAS_IPERF3") == "1" and started - last_iperf >= iperf_every
                rows += probe_cycle(targets, node_id, linked, int(env.get("ATLAS_PING_COUNT", "10")), with_iperf, int(env.get("ATLAS_IPERF_SECONDS", "5")))
                last_probe = started
                if with_iperf:
                    last_iperf = started
            if once:
                for row in rows:
                    print(json.dumps(row))
                return 0
            if out_path != "-" and rows:
                with open(out_path, "a", encoding="utf-8") as fh:
                    fh.write("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in rows))
            publisher.publish(rows)
            time.sleep(max(1.0, scan_every - (time.monotonic() - started)))
    except KeyboardInterrupt:
        return 0
    finally:
        if publisher:
            publisher.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv, os.environ))
