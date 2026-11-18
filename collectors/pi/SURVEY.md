# Walk survey with the Raspberry Pi 4 (real dBm)

The laptop scanner gives approximate numbers. The Pi gives real dBm on 2.4 and 5 GHz.
In the commands below, `<pi>` is an ssh host for an admin login on the Pi and `<pi-agent>` an ssh host (with its own key) for an unprivileged account called `agent`. Put both in `~/.ssh/config`.
The scanner runs as the unprivileged user `agent`, in `/home/agent/workspace/signal-atlas-survey`.
No step needs a password in a file.

## What this does to the Pi

- It uses one folder: `~/workspace/signal-atlas-survey` of the user `agent` (two scripts, two logs).
- While `survey.py` runs, it scans with `iw`, writes two files in that folder, and listens on port 8765 for the phone page.
- It installs nothing. It starts no service. It sets up nothing for the next boot. After `q`, Ctrl+C or the Stop button, nothing of it is left running.
- **Root is used for one command only:** `iw dev wlan0 scan trigger`, which starts a scan and returns at once, through the sudoers line below. The results are read without root. The page and the files never run as root.
- **Side effect while it runs:** each scan takes the Wi-Fi radio off its channel for about 4 seconds, every 5 seconds. Other programs on this Pi that use Wi-Fi (and your SSH session to it) see short pauses.
- The phone page is plain HTTP on the house Wi-Fi. It needs a short code that the script prints when it starts; the code is part of the address. Without it nobody on your Wi-Fi can use the page. The page can only add or remove marks and stop the scanner. `--bind 127.0.0.1` switches the page off for other devices.

## Once (as the admin user)

Starting a scan needs root, and `agent` has no sudo. This line lets `agent` run exactly one command as root, with exactly these words, and nothing else. On the Pi (`ssh <pi>`):

    printf 'agent ALL=(root) NOPASSWD: /usr/sbin/iw dev wlan0 scan trigger\n' > /tmp/agent-wifi-scan
    sudo visudo -cf /tmp/agent-wifi-scan && sudo install -o root -g root -m 0440 /tmp/agent-wifi-scan /etc/sudoers.d/agent-wifi-scan
    rm /tmp/agent-wifi-scan; sudo -l -U agent

The last command must list that one command and no other. Undo: `sudo rm /etc/sudoers.d/agent-wifi-scan`.

On the laptop, the key of `agent` must be in the Windows ssh-agent for commands without a prompt: `ssh-add "$HOME\.ssh\<pi-agent-key>"`. Windows keeps it there over reboots; `ssh-add -d "$HOME\.ssh\<pi-agent-key>"` takes it out.

## Steps

Run the commands in PowerShell on the laptop, from the repository folder.

1. Copy the two scripts to the Pi (again after every change to them):

       ssh <pi-agent> "mkdir -p ~/workspace/signal-atlas-survey"
       scp collectors\pi\scan.py collectors\pi\survey.py <pi-agent>:workspace/signal-atlas-survey/

2. Check that a scan works. It prints one line per radio the Pi hears (these are private: do not paste them anywhere):

       ssh <pi-agent> "cd ~/workspace/signal-atlas-survey && ATLAS_SCAN_SUDO=1 ATLAS_NODE_ID=survey-pi python3 scan.py --once | head -n 5"

3. On the laptop, open the page (`node tools/serve.mjs`), press `S`, choose **2D plan** and one floor, and click every spot of your route **in the order you will walk it**. A numbered marker appears for each click. This is the route; the click times do not matter for the Pi.

4. Start the scanner on the Pi. It keeps running when the terminal closes or the Wi-Fi drops for a moment:

       ssh <pi-agent> "cd ~/workspace/signal-atlas-survey && (setsid nohup python3 survey.py --sudo-scan > survey.log 2>&1 < /dev/null &); sleep 3; head -n 3 survey.log"

5. The output shows the address of the phone page with its code, for example `http://<this Pi>:8765/?k=ab3k9x`. Put the Pi on the power bank and carry it. On the phone, open that address with `<pi>.local` (or the IP address of the Pi) in place of `<this Pi>`.

6. Walk the route. On each spot: stand still, press **I stand on the next spot**, and wait for the count-down (12 seconds). The page shows the number of marks; it must equal the number of the waypoint you stand on. A wrong press: **Take the last mark back**.

7. When you are done, press **Stop the scanner** on the page. Without the phone: `ssh <pi-agent> "pkill -u agent -f survey.py"`. It also stops by itself after 180 minutes.

8. Copy the two logs to the laptop and join them with the waypoints:

       scp "<pi-agent>:workspace/signal-atlas-survey/*-pi.ndjson" data\private\
       node tools\survey-import.mjs

9. Reload the page and press `S`. Each waypoint shows measured against predicted.

10. Clean up the Pi when you no longer need the logs there:

        ssh <pi-agent> "rm -r ~/workspace/signal-atlas-survey"

## Without a power bank (one spot at a time on a wall socket)

The Pi loses power on every move, and nothing starts at boot, so the scanner is started again on every spot. The logs stay on the card and the marks keep counting.

1. Click the spots in the page first, as in step 3, where the Pi will really sit.
2. Shut the Pi down before you pull the plug: `ssh -t <pi> "sudo poweroff"`. Wait for the green light to stop blinking.
3. Plug it in on the next spot and wait about a minute. The Pi has no clock battery: start nothing before `ssh <pi-agent> "timedatectl show -p NTPSynchronized"` says `yes`, or the clock jumps during the scan.
4. Start the scanner (step 4), open the phone page with the new code, press **I stand on the next spot**, wait 30 seconds, press **Stop the scanner**.
5. Next spot: again from 2. After the last spot: steps 8 to 10.

## Good to know

- The marks and the scans both carry the clock of the Pi, so the clock of the Pi does not have to be right. Do not change the clock of the Pi during a walk.
- A second walk on another day: move or delete the old `scans-pi.ndjson` and `marks-pi.ndjson` on the Pi first, and click a new route. Marks count from 1 again only when `marks-pi.ndjson` is gone.
- "scan problem: sudo refused to start the scan" in `survey.log` or on the page: the sudoers line is missing, or `iw` is not at `/usr/sbin/iw`, or the interface is not `wlan0`.
- Why `scan trigger` and not plain `iw dev wlan0 scan`: on this Pi (iw 6.9) about one plain scan in twenty never returned and kept one core busy as root, which `agent` cannot stop (measured 2026-11-17). If one is ever left over: `sudo pkill -x iw` as `admin`.
- A row is written only for a radio heard in that scan. The kernel keeps radios in its list for about 30 s; without this rule a row could carry the level of the spot before.
- The Wi-Fi chip of the Pi 4 (CYW43455) has no monitor mode with the stock driver. The scanner does not need it: it reads the beacons and probe answers that a normal scan collects.
- Another Pi without the `agent` user: start the whole program with `sudo python3 survey.py` in place of `--sudo-scan`. Then the page runs as root too, so prefer the sudoers line.
- Starting it at boot is **not** set up.
- Tests without a Pi: `python3 -m unittest collectors/pi/test_survey.py`.
