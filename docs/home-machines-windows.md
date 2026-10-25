# Home machines on Windows (portable disk + Tailscale Funnel)

Two owned machines in France serve ComfyQ to students anywhere — including
from the school network in Morocco — as a backup to the rented cloud machines.

| Machine | GPU | RAM | Funnel name |
|---|---|---|---|
| 1 | RTX 4090 24 GB | 128 GB | `atelier-4090` |
| 2 | RTX 3090 24 GB | 128 GB | `atelier-3090` |

Each runs **Windows as it is**, with **its own portable disk** (ComfyUI
portable + models + ComfyQ). Nothing is installed in ComfyUI.

**Nothing opens on the Livebox.** Students reach the machine through
**Tailscale Funnel**, a fixed https address on port 443 that the machine opens
*outward*; the owner reaches it through Tailscale (Remote Desktop).

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
   USB4). Bring its ComfyQ up to date: in the ComfyQ folder on the disk,
   `git pull`. (`Serve-ComfyQ.bat` must be there.)
2. **NVIDIA driver** 570 or newer (GeForce / Studio driver from nvidia.com).
3. **Node.js LTS:** `winget install --id OpenJS.NodeJS.LTS --exact`.
4. **First check:** double-click `Start-ComfyQ.bat`, open
   `http://localhost:5173/admin`, *Activate & serve* `image_sdxl_smoke_test`
   (or a workflow whose models are on the disk), book one picture, check it.
   Close the window.
5. **Tailscale:** install it, sign in with the owner's account. In the
   Tailscale admin console rename the machine `atelier-4090` / `atelier-3090`.
6. **Remote access for the owner:** Settings → System → Remote Desktop → On
   (Windows Pro). Connect only through Tailscale (`mstsc` →
   `atelier-4090`). On Windows Home, use RustDesk instead.
7. **Coming back alone after a power cut:**
   - BIOS: *Restore on AC power loss* = **On**.
   - Windows: sleep = **Never** (Settings → System → Power).
   - Automatic sign-in for the Windows account (Sysinternals *Autologon*).
   - Task Scheduler → *Create Task*: trigger **At log on**, action
     `cmd.exe /c "<disk>:\<ComfyQ folder>\Serve-ComfyQ.bat"`, *Run only when
     user is logged on* (ComfyUI needs the user's session for the GPU).

   ComfyQ remembers what it was serving and resumes serving it at restart.

## 2 · From anywhere, through Tailscale

8. Start the machine's `Serve-ComfyQ.bat` (or sign out/in to fire the task).
   It builds the page, then serves page + API on **port 3000** and starts
   ComfyQ again whenever it stops (*Activate & serve* needs that).
9. **Set the admin password first** — `http://atelier-4090:3000/admin` →
   Admin password. ⚠ Without one the admin panel is open to anyone, and the
   Funnel puts it on the internet.
10. **Tailscale admin console** (once for the account): DNS → MagicDNS **on**
    and *HTTPS Certificates* **on**; Access controls → allow Funnel for the
    two machines (the console offers the snippet).
11. **Open the Funnel** — on the machine, in an *administrator* terminal:

    ```
    tailscale funnel --bg 3000
    tailscale funnel status
    ```

    `--bg` keeps it across reboots. Only port 3000 goes public; ComfyUI
    (8188) stays private — keep *Expose ComfyUI to the LAN* off.
12. **Serve** the workshop's workflow from the admin panel. Student link:
    `https://atelier-4090.<tailnet>.ts.net/user?workflow=<workflow id>`.

## 3 · Test before relying on it

- **From the school network in Morocco**, open the student link. `ts.net` has
  not been checked there yet (`trycloudflare.com` has).
- **20 students** through the link, with the same simulated-class test as the
  Vast machines ([tools/runpod/tests/load.mjs](../tools/runpod/tests/load.mjs),
  `COMFYQ_POD_PROXY` = the Funnel address) — pages, bookings, connection
  drops, download times.
- **Restart** the machine (`shutdown /r /t 0` over Remote Desktop): it must come
  back serving, at the same address.

**If `ts.net` is blocked at school:** run a Cloudflare quick tunnel on the
same machine instead — `cloudflared tunnel --url http://localhost:3000` — which
the school lets through. Its address changes every time it restarts.

## Workshop weeks

- **Pause Windows Update** for the week — it restarts machines by itself.
- Do not `git pull` during the week; update between workshops.
- Leave the `Serve-ComfyQ.bat` window open. Closing it stops ComfyQ.
- Development on the machine still uses `Start-ComfyQ.bat` (port 5173). The
  two cannot run together; the second one refuses to start.
