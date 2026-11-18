#!/usr/bin/env python3
"""Walk-survey scanner for a Raspberry Pi on a power bank.

    python3 survey.py --sudo-scan [--iface wlan0] [--interval 5] [--dir .] [--port 8765]

It does three things until you stop it:
  1. Every few seconds it starts a scan with `iw` and appends one row per heard
     BSSID (real dBm, 2.4 and 5 GHz) to scans-pi.ndjson in --dir.
  2. It serves one small page for a phone on port 8765. The page has one big button:
     "I stand on the next spot". A press appends a mark to marks-pi.ndjson.
  3. With a keyboard on the Pi: Enter makes a mark too, "u" takes the last mark
     back, "q" stops.

The Pi does not know the floor plan. You place the spots in the page on the laptop
(Survey mode, key S) in the order you will walk them. Mark number 1 is waypoint
number 1, and so on. tools/survey-import.mjs on the laptop joins them. The marks and
the scans carry the clock of the Pi, so that clock does not have to be right.

What it changes on the Pi: it writes two files in --dir, and while it runs it
listens on one port and scans. It installs nothing, starts no service and sets up
nothing for the next boot. Starting a scan needs root. With --sudo-scan the program runs
as a plain user and only `iw dev <iface> scan trigger` goes through `sudo -n` (one sudoers line,
see SURVEY.md); the page and the files then never run as root. Without the flag,
start the whole program with sudo.
A scan takes the Wi-Fi radio off its channel for 2 to 4 seconds. Other programs on
this Pi that use Wi-Fi see a short pause each time.

The page needs the short code that this program prints when it starts (it is part
of the address). Without the code nobody on your Wi-Fi can press its buttons. The
page can only add or remove marks and stop this program.

It needs scan.py from this folder (for the parser of the `iw` text).
See collectors/pi/SURVEY.md for the steps.
"""
import argparse
import json
import os
import secrets
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scan import parse_iw_scan, scan_text  # noqa: E402

NODE_ID = "survey-pi"

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signal Atlas survey</title>
<style>
  body { margin: 0; font: 18px/1.4 system-ui, sans-serif; background: #05070b; color: #e6edf7; padding: 18px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { margin: 6px 0; color: #a9b6c9; }
  #mark { display: block; width: 100%; padding: 46px 10px; margin: 18px 0; font-size: 26px; font-weight: 600; border: 0; border-radius: 14px; background: #9fd8ff; color: #05070b; }
  #mark:active { background: #fff; }
  .row { display: flex; gap: 12px; }
  .row button { flex: 1; padding: 16px; font-size: 17px; border-radius: 10px; border: 1px solid #4a5a70; background: #0a0e15; color: #e6edf7; }
  #n { font-size: 54px; font-weight: 700; color: #fff; }
  #wait { color: #ffc876; min-height: 1.5em; }
</style></head><body>
<h1>Signal Atlas survey</h1>
<p>Stand on the next spot of your route, press the button, and stay there until the count-down ends.</p>
<div>Marks so far: <span id="n">0</span></div>
<button id="mark">I stand on the next spot</button>
<p id="wait"></p>
<p id="scan"></p>
<div class="row"><button id="undo">Take the last mark back</button><button id="stop">Stop the scanner</button></div>
<script>
  const el = (id) => document.getElementById(id);
  let timer = null;
  const code = new URLSearchParams(location.search).get('k') || '';
  // the code travels in a header: a page of another site cannot send that header without being let in
  async function call(path, method) { const r = await fetch(path, { method, headers: { 'X-Atlas-Code': code } }); if (!r.ok) throw new Error('refused'); return r.json(); }
  function show(s) {
    el('n').textContent = s.marks;
    el('scan').textContent = s.last ? `Last scan ${s.last.age_s} s ago: ${s.last.count} radios, strongest ${s.last.strongest} dBm. Scans so far: ${s.scans}.` : 'No scan yet.';
  }
  el('mark').onclick = async () => {
    show(await call('/mark', 'POST'));
    let left = %(hold)d;
    clearInterval(timer);
    el('wait').textContent = `Stay here: ${left} s`;
    timer = setInterval(() => { left--; el('wait').textContent = left > 0 ? `Stay here: ${left} s` : 'Done. Walk to the next spot.'; if (left <= 0) clearInterval(timer); }, 1000);
  };
  el('undo').onclick = async () => show(await call('/undo', 'POST'));
  el('stop').onclick = async () => { if (confirm('Stop the scanner on the Pi?')) { await call('/stop', 'POST'); el('wait').textContent = 'The scanner has stopped.'; } };
  setInterval(async () => { try { show(await call('/state', 'GET')); } catch (e) { el('scan').textContent = 'The Pi does not answer.'; } }, 3000);
  call('/state', 'GET').then(show);
</script></body></html>
"""


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def read_marks(path):
    """The marks in the file, oldest first. A missing file has none."""
    marks = []
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row.get("kind") == "mark":
                    marks.append(row)
    except OSError:
        pass
    return marks


def append_line(path, row):
    """Append one row and push it to the card, so that pulling the power loses nothing."""
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, separators=(",", ":")) + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def add_mark(path, when=None, source="phone"):
    """Append the next mark. Returns it."""
    seq = max([m.get("seq", 0) for m in read_marks(path)] or [0]) + 1
    row = {"time": when or now_iso(), "kind": "mark", "seq": seq, "source": source}
    append_line(path, row)
    return row


def undo_mark(path):
    """Remove the last mark. Returns it, or None when there was none."""
    marks = read_marks(path)
    if not marks:
        return None
    last = marks.pop()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("".join(json.dumps(m, separators=(",", ":")) + "\n" for m in marks))
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    return last


def scan_once(iface, with_sudo=False):
    """One scan: only the radios heard in it. Returns (rows, problem). problem is a sentence when the scan did not work."""
    try:
        text, err, limit_ms = scan_text(iface, with_sudo)
    except FileNotFoundError:
        return [], "`iw` is not installed on this machine."
    except subprocess.TimeoutExpired:
        return [], "`iw` did not answer within 10 s."
    rows = parse_iw_scan(text, NODE_ID, now_iso(), limit_ms)
    if rows:
        return rows, None
    if with_sudo and err.startswith("sudo:"):
        return [], "sudo refused to start the scan. The sudoers line of SURVEY.md is missing or names another command."
    if "not permitted" in err.lower() or "permission" in err.lower():
        return [], "starting a scan needs root. Start this program with --sudo-scan, or all of it with sudo."
    if "busy" in err.lower():
        return [], None   # another scan is running: try again next time
    return [], err or "the scan found no network."


class Survey:
    def __init__(self, folder, iface, interval, sudo_scan=False):
        self.scans_path = os.path.join(folder, "scans-pi.ndjson")
        self.marks_path = os.path.join(folder, "marks-pi.ndjson")
        self.iface, self.interval, self.sudo_scan = iface, interval, sudo_scan
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.scans = 0
        self.last = None
        self.problem = None

    def state(self):
        with self.lock:
            last = None
            if self.last:
                last = dict(self.last, age_s=int(time.time() - self.last["at"]))
                last.pop("at")
            return {"marks": len(read_marks(self.marks_path)), "scans": self.scans, "last": last, "problem": self.problem}

    def scan_loop(self):
        while not self.stop.is_set():
            started = time.monotonic()
            rows, problem = scan_once(self.iface, self.sudo_scan)
            with self.lock:
                self.problem = problem
                if rows:
                    with open(self.scans_path, "a", encoding="utf-8") as fh:
                        fh.write("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in rows))
                        fh.flush()
                        os.fsync(fh.fileno())
                    self.scans += 1
                    self.last = {"at": time.time(), "count": len(rows), "strongest": max(r["rssi_dbm"] for r in rows)}
            if problem:
                print(f"scan problem: {problem}", file=sys.stderr, flush=True)
            self.stop.wait(max(0.5, self.interval - (time.monotonic() - started)))

    def mark(self, source):
        with self.lock:
            return add_mark(self.marks_path, source=source)

    def undo(self):
        with self.lock:
            return undo_mark(self.marks_path)


CODE_LETTERS = "abcdefghjkmnpqrstuvwxyz23456789"   # no letters that look alike on a phone


def new_code(length=6):
    return "".join(secrets.choice(CODE_LETTERS) for _ in range(length))


def make_handler(survey, hold_seconds, code=""):
    """The phone page. With a code, every request must carry it: in the address for the page
    itself (?k=code), in the X-Atlas-Code header for everything else. A request that names
    another site as its origin is refused."""
    class Handler(BaseHTTPRequestHandler):
        def _allowed(self, in_address):
            origin = self.headers.get("Origin")
            if origin and origin.split("//", 1)[-1] != self.headers.get("Host", ""):
                return False
            if not code:
                return True
            given = self.path.partition("?k=")[2] if in_address else self.headers.get("X-Atlas-Code", "")
            return secrets.compare_digest(given.encode(), code.encode())

        def _send(self, code, body, kind="application/json"):
            data = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", kind + "; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):  # noqa: N802
            page = self.path == "/" or self.path.startswith("/?")
            if not self._allowed(in_address=page):
                return self._send(403, json.dumps({"error": "the code is missing or wrong"}))
            if page:
                self._send(200, PAGE.replace("%(hold)d", str(int(hold_seconds))), "text/html")
            elif self.path == "/state":
                self._send(200, json.dumps(survey.state()))
            else:
                self._send(404, json.dumps({"error": "not found"}))

        def do_POST(self):  # noqa: N802
            if not self._allowed(in_address=False):
                return self._send(403, json.dumps({"error": "the code is missing or wrong"}))
            if self.path == "/mark":
                survey.mark("phone")
            elif self.path == "/undo":
                survey.undo()
            elif self.path == "/stop":
                survey.stop.set()
            else:
                return self._send(404, json.dumps({"error": "not found"}))
            self._send(200, json.dumps(survey.state()))

        def log_message(self, *_args):
            pass
    return Handler


def key_loop(survey):
    """Marks from a keyboard on the Pi. Does nothing when there is no terminal (nohup)."""
    if not sys.stdin or not sys.stdin.isatty():
        return
    print('Keys: Enter = I stand on the next spot, "u" + Enter = take the last mark back, "q" + Enter = stop.', flush=True)
    while not survey.stop.is_set():
        line = sys.stdin.readline()
        if not line:
            return
        word = line.strip().lower()
        if word == "q":
            survey.stop.set()
        elif word == "u":
            gone = survey.undo()
            print(f'mark {gone["seq"]} taken back' if gone else "there is no mark", flush=True)
        else:
            print(f'mark {survey.mark("key")["seq"]}', flush=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Walk-survey scanner with a mark button for a phone.")
    ap.add_argument("--iface", default="wlan0")
    ap.add_argument("--interval", type=float, default=5.0, help="seconds between scans")
    ap.add_argument("--dir", default=".", help="folder for scans-pi.ndjson and marks-pi.ndjson")
    ap.add_argument("--port", type=int, default=8765, help="port of the phone page; 0 = no page")
    ap.add_argument("--bind", default="0.0.0.0", help="address the phone page listens on; 127.0.0.1 = this Pi only")
    ap.add_argument("--hold", type=int, default=12, help="seconds the page asks you to stay on a spot")
    ap.add_argument("--max-minutes", type=float, default=180.0)
    ap.add_argument("--sudo-scan", action="store_true", help="start each scan through `sudo -n` (needs the sudoers line of SURVEY.md)")
    args = ap.parse_args(argv)
    os.makedirs(args.dir, exist_ok=True)
    survey = Survey(args.dir, args.iface, args.interval, args.sudo_scan)
    if not os.path.exists(survey.scans_path):
        append_line(survey.scans_path, {"kind": "meta", "source": "pi", "node_id": NODE_ID, "started": now_iso(), "rssi": "dBm from iw"})
    threading.Thread(target=survey.scan_loop, daemon=True).start()
    server = None
    if args.port:
        code = new_code()
        server = ThreadingHTTPServer((args.bind, args.port), make_handler(survey, args.hold, code))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(f"Phone page: http://<this Pi>:{args.port}/?k={code}   (the code {code} is part of the address)   Files: {os.path.abspath(args.dir)}", flush=True)
    threading.Thread(target=key_loop, args=(survey,), daemon=True).start()
    try:
        survey.stop.wait(args.max_minutes * 60)
    except KeyboardInterrupt:
        pass
    survey.stop.set()
    if server:
        server.shutdown()
    state = survey.state()
    print(f'Stopped. {state["scans"]} scans and {state["marks"]} marks in {os.path.abspath(args.dir)}.', flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
