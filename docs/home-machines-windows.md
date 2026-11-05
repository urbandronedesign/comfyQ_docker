# Home machines on Windows (portable disk + Cloudflare quick tunnel)

Two owned machines in France serve ComfyQ to students anywhere — including
from the school network in Morocco — as a backup to the rented cloud machines.

| Machine | GPU | RAM |
|---|---|---|
| 1 | RTX 4090 24 GB | 128 GB |
| 2 | RTX 3090 24 GB | 128 GB |

Each runs **Windows as it is**, with **its own portable disk** (ComfyUI
portable + models + ComfyQ). Nothing is installed in ComfyUI.

**Nothing opens on the Livebox and no account is needed.** Students reach the
machine at `https://<random words>.trycloudflare.com`, a tunnel the machine
opens *outward*. The school's network lets `trycloudflare.com` through (seen on
2026-10-21). The owner manages the machine with **Parsec**.

⚠ **The address is not fixed.** It stays the same while the tunnel runs, and
ComfyQ restarting does not change it. It **changes when the tunnel restarts**:
after a reboot, a power cut, or a long internet outage. Students then need the
new link. Quick tunnels also have no uptime guarantee, so check the link before
each class.

Limits of a quick tunnel: about 100 MB per upload, and up to 200 requests in
flight (20 students were fine on a rented machine).

## What fits on 24 GB

One workflow per machine — two of these models do not fit side by side, so do
not use *Serve alongside*. Comfortable: Qwen Image 2.1 t2i / edit / multiple
angles / relight, Krea 2, FLUX.2 Klein, FLUX.3 Klein distilled, SDXL. Tight
(a little slower): Krea 2 style reference, Qwen 2.1 canny/depth ControlNet.
Video (LTX 2.5, MiniMax H3) and Qwen 2511 angles run, streamed from RAM, but
slowly — keep them on rented 48 GB cards. Put the most-used workflow on the
4090 (the faster card).

## 1 · On site, once per machine (about 1 hour)

1. **Disk.** Plug the portable disk into a fast port (USB 3.2 10 Gb/s or
   USB4). In Disk Management, give it a **fixed drive letter** (`S:` here): the
   startup tasks of step 8 use that path.
2. **Add this version of ComfyQ beside the existing one.** The `ComfyQ` folder
   on the workshop disks comes from `b2renger/ComfyQ`: `git pull` there only
   fetches his code, which has neither these launchers nor the page served on
   port 3000. Leave that folder as it is and clone this repo next to it:

   ```
   cd /d S:\
   git clone https://github.com/urbandronedesign/comfyQ_docker ComfyQ-serve
   ```

   Nothing is copied or downloaded for the models: both folders share the same
   ComfyUI, and the new one finds it at first start (check under *Manage
   ComfyUI*). Only one can run at a time, past jobs stay in the old folder, and
   deleting `ComfyQ-serve` undoes everything. Every path below means this
   folder. To update it later, `git pull` inside `ComfyQ-serve`.
3. **NVIDIA driver** 570 or newer (GeForce / Studio driver from nvidia.com).
4. **Node.js LTS:** `winget install --id OpenJS.NodeJS.LTS --exact`.
5. **cloudflared:** `winget install --id Cloudflare.cloudflared --exact`.
   (Or put `cloudflared.exe` beside `Tunnel-ComfyQ.bat` on the disk.)
6. **First check:** in `ComfyQ-serve`, double-click `Start-ComfyQ.bat`, open
   `http://localhost:5173/admin`, *Activate & serve* `image_sdxl_smoke_test`
   (or a workflow whose models are on the disk), book one picture, check it.
   Close the window.
7. **Parsec:** install it **for all users** (the shared option), so it also
   reaches the Windows sign-in screen. Without a screen attached, plug in an
   HDMI dummy plug, or Parsec may show a black picture. Check a connection from
   another PC before leaving.
8. **Coming back alone after a power cut:**
   - BIOS: *Restore on AC power loss* = **On**.
   - Windows: sleep = **Never** (Settings → System → Power).
   - Automatic sign-in for the Windows account (Sysinternals *Autologon*).
     Anyone at the machine can then use it, so use a dedicated account.
   - Task Scheduler → *Create Task*, **twice**, both with trigger **At log on**
     and *Run only when user is logged on* (ComfyUI needs the user's session
     for the GPU):
     - action `cmd.exe /c "S:\ComfyQ-serve\Serve-ComfyQ.bat"`
     - action `cmd.exe /c "S:\ComfyQ-serve\Tunnel-ComfyQ.bat"`

   ComfyQ remembers what it was serving and resumes serving it at restart. The
   tunnel comes back too, at a **new address**.

## 2 · Going live, through Parsec

9. Start `Serve-ComfyQ.bat` (or sign out and in to fire the tasks). It builds
   the page, then serves page + API on **port 3000** and starts ComfyQ again
   whenever it stops (*Activate & serve* needs that).
10. **Set the admin password first** — on the machine, open
    `http://localhost:3000/admin` → Admin password. ⚠ Without one the admin
    panel is open to anyone, and the tunnel puts it on the internet.
    Then enter the HuggingFace token under *Manage ComfyUI*. The new folder does
    not inherit either of them from the old one. Use a strong password.
11. **Serve** the workshop's workflow from the admin panel.
12. **Open the tunnel:** start `Tunnel-ComfyQ.bat` and leave its window open.
    The address appears in that window. To read it again:

    ```
    findstr trycloudflare S:\ComfyQ-serve\tunnel.log
    ```

    Only port 3000 goes public; ComfyUI (8188) stays private — keep *Expose
    ComfyUI to the LAN* off.
13. **Student link:**
    `https://<random words>.trycloudflare.com/user?workflow=<workflow id>`.
14. **Add it to the ComfyQ Console** (on the owner's PC): *My machines* →
    *+ Add a machine*, the name and the address. The console then shows whether
    it answers, what it serves, the student links per workflow, and *Download
    results*; the desktop app notifies when it goes offline. Details:
    [tools/runpod/README.md](../tools/runpod/README.md#my-machines-your-own-pcs-watched-and-linked).

**When the address changes:** connect with Parsec, read the new address
(step 12), send students the new link, and in *My machines* remove the machine
and add it again with the new address. The desktop app's *offline* notification
is the signal.

## Console or Parsec

The console **watches** the machines; **Parsec operates** them.

| Task | Console | Parsec |
|---|---|---|
| See online / serving / offline, GPU, workflows, students, queue | Yes | |
| Get the student links and the admin panel link | Yes | |
| Download results | Yes | |
| Notification when a machine goes offline or comes back | Yes (desktop app) | |
| Change workflow or settings | Through the admin panel link, with the password | Yes |
| Start or restart ComfyQ or the tunnel | No | Yes |
| Read a new tunnel address | No | Yes |
| Restart the machine | No | Yes |

The console reaches a machine only through its tunnel address, added by hand.
If the tunnel restarts, the machine shows offline even if it is working: read
the new address with Parsec, then remove and add the machine in *My machines*.
*My machines* has not yet been tried against a real machine; step 14 is that
test.

## If the machine stays on

With the machine on and `Tunnel-ComfyQ.bat` running, the same link should keep
working between classes. This is expected, not measured: the longest test so
far is 27 minutes with 20 connected students and no drops, on a rented machine.
A full day or several days has not been tried.

| What happens | Link | Effect |
|---|---|---|
| Workflow switch or ComfyQ restart | Same | Students reconnect by themselves. A job rendering at that moment fails. |
| Short internet drop | Probably the same | `cloudflared` normally reconnects by itself (not tested here). |
| Long internet outage | May change | If `cloudflared` gives up, the script opens a new tunnel at a new address. |
| Cloudflare ends the tunnel | Changes or stops | No uptime guarantee; it can happen without warning. |
| Windows Update, reboot, power cut | **Changes** | Everything restarts by itself once step 8 is set up; send the new link. |
| The tunnel window is closed | **Stops** | Offline until the tunnel is started again, at a new address. |

**Before each class:** about 30 minutes ahead, open the student link yourself.
If it works, send it to the students. If not, connect with Parsec and read the
new address (step 12).

## 3 · Test before relying on it

- **From the school network in Morocco**, open the student link.
- **20 students** through the link, with the same simulated-class test as the
  Vast machines ([tools/runpod/tests/load.mjs](../tools/runpod/tests/load.mjs),
  `COMFYQ_POD_PROXY` = the tunnel address) — pages, bookings, connection drops,
  download times.
- **Restart** the machine (`shutdown /r /t 0` through Parsec): Parsec must
  reconnect, ComfyQ must come back serving, and `tunnel.log` must hold a new
  address.
- **24 hours:** leave the machine serving with *My machines* watching it. Any
  drop shows how far the link can be trusted before a real workshop.

## If you want a fixed address later

A **Cloudflare named tunnel** keeps its address and can run as a Windows
service, but needs a domain with its DNS on Cloudflare (a separate cheap domain
avoids touching `urbandrone.xyz`). See "Plan B" in
[tools/runpod/README.md](../tools/runpod/README.md). The tunnel is the only part
that changes; everything else above stays the same.

## Workshop weeks

- **Pause Windows Update** for the week — it restarts machines by itself, and a
  restart changes the address.
- Do not `git pull` during the week; update between workshops.
- Leave the `Serve-ComfyQ.bat` and `Tunnel-ComfyQ.bat` windows open. Closing the
  first stops ComfyQ; closing the second takes the machine off the internet.
- Development on the machine still uses `Start-ComfyQ.bat` (port 5173). It and
  `Serve-ComfyQ.bat` cannot run together; the second one refuses to start.
