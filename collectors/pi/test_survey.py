"""Offline tests for the Pi walk-survey scanner. No radio and no network are used,
except one request to the page on 127.0.0.1.
Run:  python3 -m unittest collectors/pi/test_survey.py
"""
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(__file__))
import scan  # noqa: E402
import survey  # noqa: E402


class MarksTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "marks-pi.ndjson")

    def tearDown(self):
        self.dir.cleanup()

    def test_marks_count_up_and_keep_their_time(self):
        self.assertEqual(survey.read_marks(self.path), [])
        first = survey.add_mark(self.path, "2026-11-20T19:00:00.000Z", "key")
        second = survey.add_mark(self.path)
        self.assertEqual((first["seq"], first["time"], first["kind"], first["source"]), (1, "2026-11-20T19:00:00.000Z", "mark", "key"))
        self.assertEqual(second["seq"], 2)
        self.assertRegex(second["time"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
        self.assertEqual([m["seq"] for m in survey.read_marks(self.path)], [1, 2])

    def test_undo_removes_only_the_last_mark(self):
        for _ in range(3):
            survey.add_mark(self.path)
        self.assertEqual(survey.undo_mark(self.path)["seq"], 3)
        self.assertEqual([m["seq"] for m in survey.read_marks(self.path)], [1, 2])
        self.assertEqual(survey.add_mark(self.path)["seq"], 3)       # the number is used again
        for _ in range(3):
            survey.undo_mark(self.path)
        self.assertIsNone(survey.undo_mark(self.path))

    def test_a_broken_line_is_skipped(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write('{"kind":"mark","seq":1,"time":"x"}\nnot json\n{"kind":"meta"}\n')
        self.assertEqual(len(survey.read_marks(self.path)), 1)


class PageTest(unittest.TestCase):
    def test_the_phone_page_marks_undoes_and_stops(self):
        with tempfile.TemporaryDirectory() as folder:
            s = survey.Survey(folder, "wlan0", 5)
            code = survey.new_code()
            server = ThreadingHTTPServer(("127.0.0.1", 0), survey.make_handler(s, 12, code))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            base = f"http://127.0.0.1:{server.server_address[1]}"

            def call(path, method="GET", headers=None):
                req = urllib.request.Request(base + path, method=method, headers={"X-Atlas-Code": code} if headers is None else headers)
                with urllib.request.urlopen(req, timeout=5) as r:
                    return r.read().decode("utf-8")

            def refused(path, method="GET", headers=None):
                try:
                    call(path, method, headers or {})
                except urllib.error.HTTPError as e:
                    return e.code == 403
                return False
            try:
                # without the code, with a wrong code, or from a page of another site: refused
                self.assertTrue(refused("/"))
                self.assertTrue(refused("/?k=wrong1"))
                self.assertTrue(refused("/mark", "POST"))
                self.assertTrue(refused("/state", "GET", {"X-Atlas-Code": "wrong1"}))
                self.assertTrue(refused("/mark", "POST", {"X-Atlas-Code": code, "Origin": "http://evil.example"}))
                self.assertEqual(survey.read_marks(s.marks_path), [])
                self.assertRegex(code, r"^[a-z2-9]{6}$")
                page = call(f"/?k={code}")
                self.assertIn("I stand on the next spot", page)
                self.assertNotIn("http://", page.replace(base, ""))          # the page loads nothing from anywhere else
                self.assertNotIn("https://", page)
                self.assertEqual(json.loads(call("/mark", "POST"))["marks"], 1)
                self.assertEqual(json.loads(call("/mark", "POST"))["marks"], 2)
                self.assertEqual(json.loads(call("/undo", "POST"))["marks"], 1)
                self.assertEqual(json.loads(call("/state"))["scans"], 0)
                self.assertFalse(s.stop.is_set())
                call("/stop", "POST")
                self.assertTrue(s.stop.is_set())
            finally:
                server.shutdown()
                server.server_close()


class ScanTest(unittest.TestCase):
    def test_a_machine_without_iw_gives_a_sentence_not_a_crash(self):
        old, old_iw = os.environ.get("PATH", ""), scan.IW_PATH
        os.environ["PATH"], scan.IW_PATH = "", ""
        try:
            rows, problem = survey.scan_once("wlan0")
        finally:
            os.environ["PATH"], scan.IW_PATH = old, old_iw
        self.assertEqual(rows, [])
        self.assertIn("iw", problem)

    def test_sudo_goes_in_front_of_the_start_of_a_scan_only(self):
        plain = scan.trigger_command("wlan0")
        self.assertEqual(plain[1:], ["dev", "wlan0", "scan", "trigger"])
        self.assertEqual(scan.trigger_command("wlan0", with_sudo=True), ["sudo", "-n"] + plain)

    def _with_fake_iw(self, answers, call):
        """Run call() while subprocess.run answers from `answers` (by the last word of the command)."""
        seen = []

        def fake(cmd, **_kw):
            seen.append(cmd)
            code, out, err = answers[cmd[-1]]
            return type("Done", (), {"returncode": code, "stdout": out, "stderr": err})()
        old_run, old_sleep = scan.subprocess.run, scan.time.sleep
        scan.subprocess.run, scan.time.sleep = fake, lambda _s: None
        try:
            return call(), seen
        finally:
            scan.subprocess.run, scan.time.sleep = old_run, old_sleep

    def test_a_refusal_of_sudo_is_named_and_nothing_is_read(self):
        (rows, problem), seen = self._with_fake_iw(
            {"trigger": (1, "", "sudo: a password is required\n")},
            lambda: survey.scan_once("wlan0", with_sudo=True))
        self.assertEqual(rows, [])
        self.assertIn("sudoers", problem)
        self.assertEqual(len(seen), 1)

    def test_a_scan_is_started_with_sudo_and_read_without(self):
        dump = ("BSS 02:00:00:00:00:01(on wlan0)\n\tfreq: 2412\n\tsignal: -50.00 dBm\n\tlast seen: 300 ms ago\n\tSSID: Fresh\n"
                "BSS 02:00:00:00:00:02(on wlan0)\n\tfreq: 5180\n\tsignal: -70.00 dBm\n\tlast seen: 25000 ms ago\n\tSSID: Old\n")
        (rows, problem), seen = self._with_fake_iw(
            {"trigger": (0, "", ""), "dump": (0, dump, "")},
            lambda: survey.scan_once("wlan0", with_sudo=True))
        self.assertIsNone(problem)
        self.assertEqual([r["ssid"] for r in rows], ["Fresh"], "a radio heard 25 s ago is not part of this scan")
        self.assertNotIn("_age_ms", rows[0])
        self.assertEqual(seen[0][:2], ["sudo", "-n"])
        self.assertNotIn("sudo", seen[1])


if __name__ == "__main__":
    unittest.main()
