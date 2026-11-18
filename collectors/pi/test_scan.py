"""Offline tests for the Pi collector's parsers. No radio and no network are used.
Run:  python3 -m unittest collectors/pi/test_scan.py
The sample text below is made up in the format that `iw`, `ping` and `iperf3` print.
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import scan  # noqa: E402

IW_SCAN = """BSS 02:5a:01:00:00:24(on wlan0) -- associated
\tlast seen: 1234.567s [boottime]
\tTSF: 0 usec (0d, 00:00:00)
\tfreq: 2412
\tbeacon interval: 100 TUs
\tcapability: ESS Privacy ShortSlotTime (0x0411)
\tsignal: -47.00 dBm
\tlast seen: 120 ms ago
\tSSID: Example-Net
\tDS Parameter set: channel 1
BSS 02:5a:02:00:01:50(on wlan0)
\tfreq: 5745
\tsignal: -61.00 dBm
\tSSID: Example Mesh
\tHT operation:
\t\t * primary channel: 149
BSS 02:aa:bb:cc:dd:ee(on wlan0)
\tfreq: 5955
\tsignal: -70.00 dBm
\tSSID: SixGig
BSS 02:11:22:33:44:55(on wlan0)
\tfreq: 2462
\tsignal: -88.00 dBm
\tSSID: \\x00\\x00\\x00\\x00
"""

PING = """PING 192.0.2.10 (192.0.2.10) 56(84) bytes of data.

--- 192.0.2.10 ping statistics ---
10 packets transmitted, 9 received, 10% packet loss, time 1810ms
rtt min/avg/max/mdev = 1.901/2.633/4.502/0.781 ms
"""

SURVEY = """Survey data from wlan0
\tfrequency:\t\t\t2437 MHz
\tnoise:\t\t\t\t-90 dBm
Survey data from wlan0
\tfrequency:\t\t\t2412 MHz [in use]
\tnoise:\t\t\t\t-94 dBm
\tchannel active time:\t\t100 ms
"""


class ParserTests(unittest.TestCase):
    def test_iw_scan(self):
        rows = scan.parse_iw_scan(IW_SCAN, "pi-test", "2026-01-01T00:00:00Z")
        self.assertEqual(len(rows), 3, "the 6 GHz network is dropped")
        first = rows[0]
        self.assertEqual(first["bssid"], "02:5a:01:00:00:24")
        self.assertEqual((first["band"], first["channel"], first["rssi_dbm"], first["ssid"]), ("2.4", 1, -47.0, "Example-Net"))
        self.assertTrue(first["associated"])
        self.assertEqual((rows[1]["band"], rows[1]["channel"]), ("5", 149))
        self.assertEqual(rows[2]["ssid"], "", "a hidden network has an empty name")
        for row in rows:
            self.assertEqual(row["kind"], "scan")
            json.dumps(row)

    def test_link_and_noise(self):
        self.assertEqual(scan.parse_iw_link("Connected to 02:5A:01:00:00:24 (on wlan0)\n\tSSID: x\n"), "02:5a:01:00:00:24")
        self.assertIsNone(scan.parse_iw_link("Not connected.\n"))
        self.assertEqual(scan.parse_survey_noise(SURVEY), -94.0)
        self.assertIsNone(scan.parse_survey_noise("Survey data from wlan0\n\tfrequency: 2412 MHz\n"))

    def test_ping_and_iperf(self):
        self.assertEqual(scan.parse_ping(PING), {"loss_pct": 10.0, "latency_ms": 2.633, "jitter_ms": 0.781})
        self.assertEqual(scan.parse_ping("garbage"), {})
        self.assertEqual(scan.parse_iperf3(json.dumps({"end": {"sum_received": {"bits_per_second": 187654321}}})), 187.7)
        self.assertIsNone(scan.parse_iperf3("not json"))

    def test_helpers(self):
        self.assertEqual(scan.channel_of(2437), 6)
        self.assertEqual(scan.channel_of(5180), 36)
        self.assertEqual(scan.band_of(5955), None)
        self.assertEqual(scan.parse_targets("home-server=192.0.2.10, nas=192.0.2.11,,bad"), [("home-server", "192.0.2.10"), ("nas", "192.0.2.11")])


if __name__ == "__main__":
    unittest.main()
