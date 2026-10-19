# ComfyQ

**ComfyQ turns one GPU into a room full of people making things.**

It is a web-based job scheduler and workflow manager for [ComfyUI](https://github.com/comfyanonymous/ComfyUI), built for classrooms, labs and studios where a dozen people want the same expensive graphics card at once. Students book a slot on a shared timeline, fill in a simple form, and watch their job run. Nobody installs anything; nobody touches ComfyUI.

It currently serves a library of **61 ready-made workflows** — image generation and editing, video generation and editing, 3D, audio, captioning and utilities — each one measured on the rig so the timeline knows how long it really takes.

---

## The two modes — the first thing to understand

A ComfyQ machine is always in exactly one of two modes, and the difference is the whole design.

| | **Admin mode** | **Student mode** |
|---|---|---|
| What it is | The machine is being *set up* | The machine is *serving a class* |
| Who uses it | You, at `/admin` | Everyone, at `/` |
| ComfyUI | Started on demand, for calibration and maintenance | Running, with one workflow's models resident |
| Jobs | Nothing is scheduled | Students book and run jobs |
| Workflow | You pick and prepare any of the 61 | Exactly **one** is served (or several, with lanes) |

You switch by pressing **Activate & serve** on a workflow card (→ student) or **Stop serving** / **Reset to admin** (→ admin).

- **A restart resumes serving.** A crash, a Windows update or a power cut brings the machine back serving the same workflow, because `/activate-workflow` leaves a marker. The deliberate stops clear it.
- **`/admin` is always reachable**, even while serving, so you can fix something mid-class. It is deliberately *not* linked from the student page — but that is tidiness, not security. **The admin password is the boundary.**
- **Students can be locked out too.** An optional *student access password* reserves a machine for one group; without it set, behaviour is exactly as before.

---

## For students (the default view)

Open `http://<machine-ip>:5173` and you get a timeline, a booking form, and a grid of results.

- **Book a slot** — pick a free time, or *as soon as possible* and it queues into the next gap.
- **Fill in the form** — the fields come from whichever workflow is being served. Prompts, dropdowns, sliders, file uploads, and for some workflows a mask painter or a visual prompt composer.
- **Watch it run** — live progress and an ETA from the workflow's measured timing, not a guess.
- **Collect the result** — images, video, audio, 3D models and Gaussian splats each render in their own viewer. Multi-output jobs get a gallery.
- **Re-run it** — *Use these settings* refills the form from a past job; **Download ingredients (.zip)** packages the inputs plus a `settings.json` so a generation can be rebuilt later, even on another machine.
- **See what the rig can do** — the **All jobs** tab, user `examples`, carries one finished example per workflow in the library: the result, the prompt, the parameters and the input files. Clicking *Use these settings* on one is the quickest way to start from something that already works.

Idle tabs park themselves after five minutes to keep a room of thirty laptops from hammering the rig.

---

## For admins — the four tabs

### 1. Workflows
The library, and what is running.

- **Running** — one row per lane: the workflow, its port, whether it is busy, and its resident VRAM.
  ⚠ **Never press *Stop serving* on the main (primary) workflow while jobs are queued or rendering.** On the main workflow that button does not stop just that model: it puts the whole machine back in admin mode and restarts ComfyQ, so **every** lane stops, the job rendering fails (`server-restart`) and the queued jobs wait until the machine serves again. *Close lane* on an extra workflow only closes that one. To drop the main workflow during a class, wait until the queue is empty.
- **Workflow library** — all 61 bundles, searchable, filtered by type (Image generation · Image editing · Video generation · Video editing · 3D · Audio · Description · Utilities). Each card shows the measured duration, a **VRAM chip** judged against *this* machine's card, and whether its models are on disk. Per card: *Activate & serve*, *Open in ComfyUI*, *Calibrate*, *Edit*, *Validate*, *Delete*.
- **Storyboard batch** — submit a whole multi-shot document as one job set.
- **Add workflow** — drop in a new ComfyUI API-format export.

### 2. Manage server
- **Student access** — optional password reserving the machine for one group.
- **Admin password** — gates every destructive action. ⚠ **Set one before a prune session**; without it, anyone on the LAN who knows the URL can reach the admin routes.
- **Network presence** — whether this machine announces itself to ComfyQ Discovery.
- **Cleanup** and **Clear job history**.

### 3. Manage ComfyUI
- **ComfyUI settings** — install paths, Python, output dir, API port, VRAM budget. A **drive-letter swap** repoints every absolute path at once, and **Auto-detect** finds a portable install by itself — both there because this drive is cloned between machines that mount it under different letters.
- **Performance flags** — Sage attention and fp16 accumulation, off by default. Individual workflows can opt out of a flag they produce black images under, and ComfyQ relaunches ComfyUI without it for that workflow.
- **HuggingFace token** — needed only for gated repositories. Write-only; never sent back to the browser.
- **Node packs** — which node classes your bundles need, which are missing, and who provides them. Installing is a `git clone` into `custom_nodes`; ⚠ **pip is a separate, explicit step**, because one Python environment is shared by every workflow on the drive.

### 4. Maintenance
Everything that changes the install. See [Maintaining the install](#maintaining-the-install) below.

---

## Getting models onto the machine

This is the part that most often goes wrong on a fresh rig, so it has its own section.

Every workflow card says whether its models are present, read from **the graph** — what the workflow actually loads — rather than from a hand-written list. A missing model shows red.

Expand the chip and each missing file offers:

- **fetch to rig** — downloads it **onto this machine**, into the folder the workflow will look in, under the name the workflow expects. This is the one you want. It resumes interrupted transfers, checks free space first, and renames the file into place only once the byte count matches, so a half-downloaded file is never mistaken for an installed one. Progress appears under **Maintenance → Model downloads**.
- **to my computer** — a plain browser link to the source. It saves to *the machine you are reading this on*, under the repo's own filename. Useful for a gated repo you must fetch by hand; **not** how you install a model on the rig.

> ⚠ **Why the distinction matters:** the admin panel is routinely open on a laptop, not on the rig. A browser download lands on the laptop with the wrong filename in the wrong folder — which is exactly the failure the server-side downloader exists to prevent.

**Gated repositories** (some FLUX.2 and LTX-2.5 weights) answer 401 until you accept the licence on HuggingFace and paste a read token under *Manage ComfyUI*.

**One known gap:** a model reachable only through a dropdown (an alternative LoRA checkpoint, say) never reports as missing, because the readiness check reads the graph and a dropdown option appears in no graph. "0 models missing" does not promise every dropdown option is present.

---

## Maintaining the install

All of it is admin-only, and the destructive parts sit behind the admin password.

**Updates.** The installed ComfyUI version is always on screen. *Check for updates* reaches the remotes and says in a sentence whether a newer release exists; every node pack that is a real git clone gets its own **Update** button, lists the commits that would land *before* you take them, and is fast-forwarded only.
- ★ A run that changes nothing says so. `--stable` lands on the newest *release*, which may well be the one you already have.
- ★ A pack with uncommitted local changes is not offered — it is a working copy, and a pull must not decide that for you.
- Roughly half of installed packs are copies ComfyUI-Manager unpacked rather than clones, so they have no remote; the card says which.
- ⚠ ComfyUI's own `current_requirements.txt` is a separate, acknowledged step: it asks for bare `torch`, and an install can be deliberately pinned to a build some node packs need.

**Run the whole library.** One button runs every bundle once with sample inputs — about **2½ hours for 61 bundles** on an RTX 5090 — and answers the two questions nothing else can: does each bundle still work, and which model files the library actually opens. Every output is *measured* (size, luminance, spread, frame count) and anything black, flat, empty or single-framed is named for you to open, because a workflow can report success and save black images. **Copy report** gives a plain-text report you can paste to someone: every failure carries its full error, its traceback, and the performance flags ComfyUI was actually running with.

**Download models** — see [the section above](#getting-models-onto-the-machine).

**Prune unused models.** Finds weight files nothing references, scored by confidence with its reasons in plain words. ⚠ Three things to know:
- **A prune MOVES, it does not delete.** Files go to `_model_quarantine\<batch>\` on the same drive — instant and reversible. It does **not** free space until you empty a batch from the **Quarantine** card.
- **A quarantine batch travels in a cloned drive image.** Empty it before imaging a master drive.
- **"Nothing references it" is weaker than it sounds.** Only the confident tier offers bulk selection. A model nobody happened to exercise leaves no trace either.

**Re-apply the custom-node fixes.** A few node packs need a local fix to run on this ComfyUI. The patches live in the repo rather than only on the rig that was fixed, so a cloned machine can be brought up to them with one button. Safe to press twice, and it **refuses loudly** if a pack has changed under its patch instead of guessing.

**Audit and repair.** Rebuild the model audit, verify it, repair the install, make install paths portable. These are ordinary Python in [tools/maintenance](tools/maintenance/), resolving the install from `config.json` so they work under any drive letter.

**Preparing a drive to be cloned.** This drive is duplicated with a physical cloner, so whatever is on it travels — including a term of student pictures and a quarantine batch full of models you meant to delete. [docs/cloning-the-drive.md](docs/cloning-the-drive.md) is the checklist: verify the library, empty the quarantine, keep one example per workflow, clear the residue. Three scripts under [tools/maintenance](tools/maintenance/) do the mechanical parts, each with a `--dry` mode that shows you the damage before you accept it.

---

## ComfyQ Discovery (desktop app)

A small cross-platform app that finds every ComfyQ machine on the network and shows what each is doing: whether it is serving or idle, which workflow, how many people are connected, how long since anything happened, and a **Schedule a job** button that opens that machine's page.

It discovers machines three ways at once — a UDP beacon, a unicast subnet sweep, and manually added IPs — because managed school networks routinely block broadcast.

Windows and Linux builds **auto-update**; macOS needs a manual re-download. Installers come from the repo's GitHub Releases. Full detail, including the platform matrix and how to cut a release, is in [the Discovery section below](#comfyq-discovery--details).

---

## Where to read more

| Document | What it covers |
|---|---|
| [CLAUDE.md](CLAUDE.md) | **The engineering log.** Every decision, every bug and why it was fixed that way. Long, dated, and the first place to look before changing anything. |
| [implementation_plan.md](implementation_plan.md) | The phased plan and what is deferred. |
| [docs/workflow-redundancy.md](docs/workflow-redundancy.md) | Which bundles overlap, with the pros and cons of cutting each. |
| [docs/comfyui-idv2v.md](docs/comfyui-idv2v.md) | The ID-V2V feature and why no patch is needed any more. |
| [docs/storyboard-format.md](docs/storyboard-format.md) | The multi-shot storyboard document format. |
| [docs/cloning-the-drive.md](docs/cloning-the-drive.md) | Preparing this drive to be imaged onto another machine. |
| [tools/maintenance/](tools/maintenance/) | The audit and repair scripts, and the notes that go with them. |
| [tools/model-provenance/](tools/model-provenance/) | Where each model came from, and which are exclusive to a bundle. |
| [tools/api-to-ui/](tools/api-to-ui/) · [tools/ui-to-api/](tools/ui-to-api/) | Converting between ComfyUI's editable graph and the API format ComfyQ runs. |

---

## Prerequisites

- **Node.js 24 LTS ("Krypton")** — the supported version, pinned in [.nvmrc](.nvmrc). Node 22 LTS ("Jod") also works. ComfyQ deliberately tracks an **LTS** line for broad machine compatibility; the odd-numbered "Current" releases (23, 25, …) are not supported and `engines` will warn on them. With [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm), run `nvm use` / `fnm use` in the repo root to pick up `.nvmrc` automatically.
- ComfyUI installed and able to run on the same machine. The lab targets RTX 3090 / 4080 / 4090 / 5090 with portable ComfyUI installs.
- C++ build tools available to npm — only needed as a **fallback** for `better-sqlite3`. On Node 24/22 LTS it ships an N-API prebuilt binary (no compile), so most machines need nothing extra. If a prebuild isn't available for your platform, the install falls back to compiling from source: on Windows that needs Visual Studio Build Tools (C++ workload).

## Install & run

```bash
git clone <repo>           # the default `main` branch is the active line
cd ComfyQ
npm install        # postinstall also installs client + server deps
npm run dev        # concurrently starts server (port 3000) + client (vite :5173, HTTP)
```

Open **`http://localhost:5173`** (or one of the `http://<lan-ip>:5173` URLs printed at boot). Vite serves plain HTTP and proxies the backend, so the page, the API, and the websocket all share a single origin. No certificate, no warning — students just open the URL. On first boot the server starts in **admin mode** (no ComfyUI launched) and redirects to `/admin`.

> Why plain HTTP? A self-signed HTTPS cert can't be trusted across Safari + Chrome + phones in a BYOD workshop without installing a CA root on every device — and Safari won't even extend a click-through to the websocket or to downloads. HTTP removes all of that. The only feature HTTPS would have enabled — in-browser webcam capture (`getUserMedia`) — has been removed; image/video inputs are uploaded as files instead (a phone's file picker still offers "Take Photo").

## First-run setup (admin)

1. **ComfyUI Settings** — set the ComfyUI root path, Python executable, output dir, ComfyUI API port, and VRAM budget for your GPU.

   On a freshly cloned workshop rig, all three paths are **pre-filled** to the standard portable-ComfyUI layout (`D:\ComfyUI_windows_portable_nvidia\ComfyUI_windows_portable\…`). If they don't match your install, edit them or click **Reset to defaults** to repopulate. Click **Check paths** to validate before saving — it verifies the root contains `main.py`, runs `python --version`, and confirms the output directory is writable, listing each result inline.

   **Cloned the drive to a different letter?** Two shortcuts: ComfyQ **auto-detects** ComfyUI on `npm run dev` (it scans local drives for the install whenever the configured root is missing/stale, so a cloned or fresh drive Just Works), and there's an **Auto-detect** button to re-run it on demand. If only the drive letter changed, use the **Drive letter** dropdown to swap it across *every* path at once instead of editing each field.

   The **ComfyUI backend** card below Settings can **Launch / Restart / Stop** ComfyUI on the network and holds the **Expose ComfyUI to the LAN** toggle (so anyone can open its native web UI on this GPU). If ComfyUI was started outside ComfyQ, **Restart** offers to *take it over* — it stops that instance and relaunches one ComfyQ manages, so Restart/Stop and "Open in ComfyUI" work afterward.

   For a Windows portable ComfyUI install, the `root_path` must point at the directory containing `main.py`, **not** the wrapper folder. With a typical install that's `...\ComfyUI_windows_portable\ComfyUI` (and `python_executable: ../python_embeded/python.exe`, or absolute).
2. **Add Workflow** — drag-and-drop an API-format JSON into the upload box. To get one from ComfyUI:
   - Open your workflow.
   - Enable **Settings → Dev mode Options**.
   - Click **Save (API Format)**.

   On upload the server runs the primitive-fallback parser and auto-creates `workflows/<id>/<id>.api.json` + `<id>.meta.json` exposing every detected widget. A modal editor opens immediately so you can:
   - Click **Hide infrastructure** to drop model-path / weight-dtype / device fields.
   - Tweak labels and defaults for the params students should see.
   - Pick a category (`t2i`, `image-edit`, …).

   You can re-open the editor any time via the pencil icon on the workflow card.

   The repo bundles a **Flux2 Klein 9B starter set** (validated on RTX 5090):
   - `workflows/image_flux2_klein_9b_t2i/` — text to image
   - `workflows/image_edit_flux2_klein_9b_image_edit/` — single image edit
   - `workflows/image_edit_flux2_klein_9b_image_edit_ref/` — image edit with reference image

   All three need: `flux-2-klein-base-9b-fp8.safetensors` (UNET), `flux2-vae.safetensors` (VAE), `qwen_3_8b_fp8mixed.safetensors` (CLIP) in the corresponding `<comfy_root>/models/` subfolders.

   It also bundles the rest of the library — **61 workflows** across image generation and editing, video generation and editing, 3D, audio, captioning and utilities. Each needs its own models under `<comfy_root>/models/`. **ComfyQ checks this for you:** every card carries a chip saying how many of the models its graph loads are on disk, and a missing one can be fetched straight onto the machine — see [Getting models onto the machine](#getting-models-onto-the-machine). (A bundle is only marked `unavailable` — and hidden from the library — when its own `meta.json`/`api.json` is missing or invalid, e.g. the "Missing workflow file" case in [Troubleshooting](#troubleshooting).)
3. **Workflow library** — pick one → **Activate & start student mode**. The server restarts into student mode and launches (or attaches to) ComfyUI.
4. **Calibrate** (optional but recommended) — click the gauge icon on a workflow card (works in admin **or** student mode; in admin mode ComfyUI is started on demand). ComfyQ does **one real run** (a fresh seed avoids ComfyUI's result cache) and writes `<id>.runtime.json` with the first-run cost (incl. model load), the recurring generation cost (what the timeline uses), and the GPU. Inputs are supplied automatically from the assets directory (`config.json` → `assets.dir`, default `D:\_assets`) — no upload needed. Image inputs fall back to a built-in reference image if the assets dir has none.
5. **(Optional) Admin password** — required for any cross-user destructive action (deleting / cancelling another student's job, restarting, resetting, cleaning outputs). **Without a password set, cross-user deletes are refused entirely** — you can still manage your own jobs, but you can't interfere with anyone else's. Set one for classroom deployments.

### Operational controls (admin header)

- **Reset to admin** — flips back to admin mode without killing ComfyUI; useful when you want to swap workflows without disturbing the GPU process.
- **Stop & kill all** — emergency stop. Cancels every scheduled job, marks every in-flight job FAILED, REST-interrupts ComfyUI, kills the process if ComfyQ spawned it, and restarts in admin mode. Confirmation modal lists exactly what will happen.
- **Clean all outputs** (in the Admin page Cleanup card) — purges every output file on disk for terminal jobs and clears the `outputs` field in the DB. Job records are kept so prompt history survives. In-flight jobs are skipped so a running collector isn't disrupted.

---

## Workflow folder layout

```
workflows/
└── image_flux2_klein_9b_t2i/
    ├── image_flux2_klein_9b_t2i.api.json         the workflow (API format, REQUIRED)
    ├── image_flux2_klein_9b_t2i.meta.json        the metadata (REQUIRED for v2)
    ├── image_flux2_klein_9b_t2i.config.meta.json (optional, per-deployment overrides — gitignored)
    └── image_flux2_klein_9b_t2i.runtime.json     (optional, written by BenchmarkService — gitignored)
```

The `meta.json` is treated as read-only by the server. The admin UI never writes it; it only writes `config.meta.json` (overrides) and `runtime.json` (calibration). This keeps the original workflow export distinct from class-deployment tweaks.

See [implementation_plan.md](implementation_plan.md#schemas) for the full schema.

---

## Architecture (one-line tour)

```
HTTP/Socket.IO  →  RealtimeBus  →  JobExecutor  →  LocalComfyUIWorker  →  ComfyUI
                       │                                  │
                       ▼                                  ▼
                  JobQueue (sqlite)              ComfyRestClient + ComfyWsClient (auto-reconnect)
                       │
                       ▼
                  WorkflowRegistry  ──── reads ────▶  workflows/<id>/{api,meta,config-meta,runtime}.json
```

See [implementation_plan.md](implementation_plan.md#architecture) for module-by-module responsibilities and the job state machine.


---

---

## ComfyQ Discovery — details

**ComfyQ – Discovery** is a standalone cross-platform desktop app (`desktop/`, Electron — Windows +
macOS) that shows **every ComfyQ machine on the LAN at a glance** — no configuration, no central
server. Open it on an instructor's laptop (or any machine on the same network) to see the whole room.
It matches the ComfyQ web UI's look (same grayscale palette, Inter font, lucide icons) and has its own
**light/dark toggle** (honors your OS preference, remembers your choice).

Each ComfyQ server **sends a small JSON status snapshot every ~5 s** over UDP — to the multicast
group `239.255.42.99:41999` **and** to the subnet broadcast address (belt-and-suspenders, since
consumer Wi-Fi/APs often drop multicast); the app listens and renders one card per machine.
Machines appear and disappear on their own — a card goes dim ~30 s after the last beacon and drops
after ~2 min. It works even for **idle rigs in admin mode with nothing launched**.

Per machine the card shows:
- **Name** and **IP address** (with a **copy button** that copies that rig's admin-panel link,
  `http://<ip>:5173/admin`), plus a **"This machine"** marker on the rig you're running the app from
- **When a workflow is being served**, a prominent banner right under the IP with a **category icon**
  (the same icon the ComfyQ admin library uses — image / video / audio / 3D / text / utility) so you
  can tell at a glance what kind of workflow it is, and the workflow's name
- **Hardware** — GPU model (+ VRAM) and system RAM
- **Plain-language state** (Running a workflow / Ready / On standby) and **usage** — how many users
  are connected and how long since the last activity (shown for every machine, including idle
  admin-mode rigs)
- **When a workflow is being served** — its name, a short **description of what it does** (pulled
  straight from the workflow's `meta.json`, so dropping a new workflow into `workflows/` surfaces its
  blurb automatically), the **queued/running jobs** with times, and a **"Schedule a job ↗"** button
  that opens that rig's booking page (`http://<ip>:5173`) in your default browser
- **Admin-mode machines** hide the workflow/schedule (nothing is being served) and instead show just
  the connected-users + last-activity info

Discovery controls (automatic search on/off, **Search range**, and **Add a machine**) live behind the
**⚙ Settings** button in the top-right to keep the main view uncluttered.

The app is **read-only** (it never commands a remote machine — the only actions are opening a browser
tab and copying a link).

> **Tip:** ComfyQ now starts its **ComfyUI backend by default** (admin mode included, when paths are
> configured and `comfy_ui.autoStart` is on), so a rig shows up "engine on" and ready without anyone
> having to launch it first. Set `comfy_ui.autoStart: false` to opt out.

### Install & auto-update (end users)

Grab the latest installer from the repo's **[Releases](https://github.com/b2renger/ComfyQ/releases)**
page and run it — Windows `.exe`, macOS `.dmg` (Apple Silicon **and** Intel), or Linux `.AppImage`.
Windows + Linux builds are **unsigned**; the macOS app is **ad-hoc code-signed** (so it launches with a
one-time bypass instead of a *"damaged"* dead end — but it is **not notarized**):

- **Windows:** on first run SmartScreen shows *"Windows protected your PC"* → click **More info → Run
  anyway** (one time). Updates afterwards install silently.
- **macOS (Apple Silicon):** Gatekeeper blocks the first launch → **right-click the app → Open → Open**
  (one time); on macOS Sequoia use **System Settings → Privacy & Security → Open Anyway**.
  `xattr -cr '/Applications/ComfyQ Discovery.app'` is the universal fallback.
- **macOS (Intel):** needs **macOS 12 (Monterey) or newer** — on macOS 11 Big Sur the app is flagged
  *"damaged"* and won't open even after the bypass.
- **Linux:** `chmod +x` the `.AppImage`, then run it. On **Linux Mint / Ubuntu** it needs the **FUSE 2**
  runtime — if it does nothing or reports a FUSE error, install it: `sudo apt install libfuse2`
  (Mint 21 / Ubuntu 22.04) or `libfuse2t64` (Mint 22 / Ubuntu 24.04). Still stuck? Run it FUSE-free with
  `./"ComfyQ Discovery-<ver>.AppImage" --appimage-extract-and-run`, or install **AppImageLauncher**
  (`sudo apt install appimagelauncher`) for a menu entry + automatic integration. A SUID-sandbox error on
  launch → add `--no-sandbox`.

**Auto-update is automatic.** On every launch the app checks GitHub for a newer release, downloads it
in the background, and shows *"Update ready — restart to apply"* (it also installs on next quit). The
⚙ **Settings** panel shows the **current version** and a **"Check for updates"** button for an
on-demand check. *(Windows + Linux auto-update end-to-end; macOS auto-update needs code signing — see
"Building & releasing" below — so for now Mac users re-download from Releases to update.)*

### Run from source (development)

```bash
npm run desktop:install   # once — installs Electron in desktop/ (not pulled by the root install)
npm run desktop           # launch the monitor
```

The beacon is **on by default** on every ComfyQ instance (admin and student mode). To opt a machine
out, flip the **Network presence** toggle in the admin panel (**Admin → Network presence** — takes
effect live, no restart) or set `federation.enabled: false` in its `config.json`; behavior is then
identical to a single-instance ComfyQ. The group/port and interval are configurable under `config.federation`
(match them with `COMFYQ_FED_GROUP` / `COMFYQ_FED_PORT` env vars for the app if you change them).
A `GET /federation/self` endpoint returns the same snapshot over HTTP for scripting/debugging.

> **Firewall:** the beacon is UDP. If machines don't appear, allow **Node.js** (and Electron, for
> the app) through Windows Firewall on **Private** networks. Multicast must be permitted on the LAN.

> **Managed / school Wi-Fi (broadcast & multicast blocked)?** Many managed networks enable *client
> isolation* for broadcast/multicast, so the UDP beacons never arrive even though the machines can
> reach each other directly over unicast. For that case the app also **auto-discovers** machines by
> sweeping the local subnet: it probes `http://<ip>:3000/federation/self` across your subnet (the
> same path students already use, so no extra firewall rule), and lists everything that answers. It's
> on by default — toggle **Find machines automatically** or hit **Refresh**. You can set the
> **Search range** (the address range to check, e.g. `10.10` · `16`–`17` · `1`–`254`) to widen or
> narrow the sweep; it defaults to your machine's own subnet. A ~510-address sweep takes ~15 s; found
> machines then refresh every 5 s. For a machine on a *different* network, use **Add a machine** (type
> its IP — it's polled directly and remembered between launches).
>
> **Servers on a different subnet than the clients?** The app scans **every** local subnet it's on, plus
> any seeded extra ranges, so clients can auto-find servers on another network. The "Search range" field
> adds one range in-app; for a fixed deployment set `COMFYQ_FED_SCAN` (comma-separated CIDRs, e.g.
> `10.10.16.0/23`) or a `scanRanges` array in `fleet-config.json`. **This only works if your network
> actually routes to that subnet** (e.g. a sub-router whose WAN is uplinked to the main LAN — verify with
> `curl http://<server-ip>:3000/federation/self`). If the two networks have no route between them, no
> discovery setting can bridge them — put the machines on one LAN instead.

> **"Electron failed to install correctly"?** Electron's binary-download step occasionally gets
> skipped during `npm install`. `npm run desktop:install` runs that step explicitly so this
> shouldn't happen; if it ever does, re-run `npm run desktop:install` (or, directly,
> `node desktop/node_modules/electron/install.js`).

### Building & releasing (maintainers)

The desktop app is packaged with **electron-builder** and updates via **electron-updater**, pulling
releases from this public GitHub repo (no token needed on the client). Cutting a release is one
command, run from `desktop/` on `main`:

```bash
cd desktop
npm run release:patch     # or release:minor / release:major
```

That bumps `desktop/package.json`, commits, tags `vX.Y.Z`, and pushes the tag. A GitHub Actions
workflow ([.github/workflows/release.yml](.github/workflows/release.yml)) then builds installers for
**Windows, macOS, and Linux** in parallel and publishes them — with the `latest*.yml` update
manifests — to a GitHub Release. Installed apps pick the update up on their next launch.

Notes:
- **`npm version`'s git step is unreliable here**, so `release:*` bumps with `--no-git-tag-version`
  and does the commit/tag/push explicitly via [desktop/scripts/release.mjs](desktop/scripts/release.mjs)
  (which also leaves a dirty `config.json` untouched).
- A local `npm run dist` (in `desktop/`) builds an unsigned installer for the host OS only — handy for
  a quick check, though on Windows it needs **Developer Mode** (or an elevated shell) so electron-builder
  can extract its code-signing tools; CI is unaffected.
- **Code signing.** Windows + Linux are **unsigned** (SmartScreen/Gatekeeper warn on first run). macOS is
  **ad-hoc code-signed** in CI ([desktop/scripts/afterPack.cjs](desktop/scripts/afterPack.cjs)) so the app
  launches with a one-time bypass instead of the dead-end *"damaged"* error — but it is **not notarized /
  not Developer-ID**, so **macOS auto-update still won't apply** (Squirrel.Mac needs a stable signature);
  Mac users re-download from Releases to update. Add a real Developer-ID cert + notarization as CI secrets
  to enable macOS auto-update. Windows + Linux auto-update fine.

---

---

## Troubleshooting

### `'better-sqlite3' build failed during install`
On Node 24/22 LTS, `better-sqlite3` (v12+) normally installs a prebuilt N-API binary with no compilation. If you see this error you're either on an **unsupported Node version** (check `node --version` against [.nvmrc](.nvmrc) — run `nvm use`/`fnm use`) or on a platform with no prebuild, which falls back to a source build. For the source build, install the native toolchain: Visual Studio Build Tools with the C++ workload (Windows) or `build-essential` + `python3` (Linux), then `npm install` again.

### `npm WARN EBADENGINE Unsupported engine` (or wrong Node version)
ComfyQ targets an LTS Node line (24 "Krypton", or 22 "Jod"). If you're on an odd-numbered "Current" release like 23 or 25, npm warns and behavior is unsupported. Switch with `nvm use` / `fnm use` (reads [.nvmrc](.nvmrc)), or install Node 24 LTS from [nodejs.org](https://nodejs.org/).

### `Litegraph format detected. ComfyQ v2 requires API format.`
You uploaded a workflow saved with the standard "Save" button. v2 deliberately does not auto-convert. Re-export with **Settings → Dev mode → Save (API Format)** in ComfyUI. (See [implementation_plan.md](implementation_plan.md#why-v2) for why.)

### `Workflow unavailable: Missing workflow file: <id>.api.json`
The folder `workflows/<id>/` has a `meta.json` but no API workflow. Drop your `<id>.api.json` next to the meta and click **Refresh** in the admin Workflow library.

### Server starts in admin mode unexpectedly
v2 archives v1 `config.json` files to `config.json.v1.bak` on first boot. If `comfy_ui.root_path` or `comfy_ui.python_executable` is empty, v2 won't start ComfyUI and falls back to admin mode. Set them in **Admin → ComfyUI Settings**.

### `Python executable not found: ...\python_embeded\python.exe` (or similar)
The portable ComfyUI bundle nests `main.py` inside a `ComfyUI/` subdirectory. Set `root_path` to the inner folder (e.g. `F:\ComfyUI_windows_portable_nvidia\ComfyUI_windows_portable\ComfyUI`), **not** the wrapper. With that root, `python_executable: ../python_embeded/python.exe` resolves correctly.

### Activating a workflow does nothing / server stuck after "Exiting for restart"
Make sure you're running with `npm run dev` (which uses nodemon). v2's `exitForRestart()` bumps the mtime of `server/index.js` so nodemon's watcher picks it up; if you've replaced nodemon with a different supervisor, point it at `server/` and trigger restart on file change.

### Job stuck in `processing` forever
v2 reconciles in-flight jobs to `failed: server-restart` on every server boot. If a job is genuinely stuck during a run, click **Stop & kill all** in admin (cancels every job + kills ComfyUI + restarts in admin mode), or kill ComfyUI manually — the worker emits a failure event and the job moves to `failed: comfyui-process-exited`.

### Sampling is hundreds of times slower when ComfyQ spawns ComfyUI than when you launch it standalone
Symptom: 800+ s/iter on a high-end GPU; nvidia-smi shows the model loaded but no GPU activity. Almost always a Python environment leak: the Node/nodemon parent inherits a conda or venv activation, and the activated env's `site-packages` shadows the portable's torch with a CPU-only or wrong-CUDA build. ComfyQ now strips `PYTHONPATH`, `PYTHONHOME`, `PYTHONSTARTUP`, `VIRTUAL_ENV`, `CONDA_PREFIX`, `CONDA_DEFAULT_ENV`, `CONDA_PROMPT_MODIFIER`, `CONDA_SHLVL`, `CONDA_PYTHON_EXE` before spawn and scrubs any conda-prefix directories from `PATH`. Watch for `[ComfyProcess] Stripped env vars: …` and `[ComfyProcess] Removed N env-prefix entries from PATH` near the spawn line — if anything is listed, that was the culprit. Cleanest long-term fix: launch ComfyQ from a shell with no conda/venv active.

### Sampling stalls / no step progress on a near-VRAM-budget model (LTX-AV, Flux2 9B at high res)
ComfyQ does **not** pass `--highvram` to ComfyUI. On a 24 GB card running a 23.8 GB model, `--highvram` forces full-load mode, which then thrashes against the text encoder (~11 GB) on every step. The default dynamic-VRAM loader (what `run_nvidia_gpu.bat` uses) handles near-budget models far better. If your rig has 48+ GB of VRAM and you specifically want the perf bump from highvram, edit [server/workers/comfyProcess.js](server/workers/comfyProcess.js) and add `'--highvram'` back to `comfyArgs`.

### A ComfyUI browser tab pops open every time the server spawns ComfyUI
ComfyQ passes `--disable-auto-launch`. If you still see the tab, you're either attached to an external ComfyUI instance (start ComfyQ first, then it spawns its own) or your ComfyUI build ignores the flag — verify with the spawn line in the server log.

### How do students get a photo into an image-input workflow?
Image and video parameters render a file-upload widget — click to browse or drag-and-drop. There's no in-app webcam capture (removed 2026-05-19; it needed an HTTPS secure context the plain-HTTP workshop setup can't provide). On a phone the OS file picker offers **Take Photo** directly, so camera input still works; on desktop, drag in any image file.

### `/admin` shows a blank page or 404
The `/admin` path is overloaded — the SPA owns the bare path, the Express API owns every sub-path (`/admin/mode`, `/admin/config`, …). Vite's proxy needs a `bypass` hook to let the bare path fall through to the SPA; we ship one in [client/vite.config.js](client/vite.config.js). If you ever see a 404 here, check that vite.config.js still has the `bypass(req)` handler on the `/admin` proxy entry. The fix only takes effect after a dev-server restart (`Ctrl+C`, then `npm run dev` — HMR doesn't pick up vite.config.js changes).

### Workflow validation: `Invalid image file: <filename>`
ComfyUI couldn't find that filename in its `input/` directory. Two common causes: (1) the workflow's hardcoded default doesn't exist on this rig — re-upload an image via the BookingDialog before submitting, or (2) the file was swept by the input-retention TTL (default 30 min). Re-upload to refresh.

### Calibration uses sample media from an assets directory
Calibration runs the workflow for real, so workflows with image/video/audio inputs need a sample file. ComfyQ resolves one automatically from the **assets directory** (`assets.dir` in `config.json`, default `D:\_assets`) — it picks a file matching each input's type (a typical-sized image, the smallest video, an audio clip), so **no upload and no per-workflow setup is needed**. If a `video`/`audio` input can't be satisfied you'll see `Cannot calibrate: no <type> asset available …` — drop a file of that type into the assets dir (or set `meta.warmupParams` for that key). Image inputs fall back to a built-in reference PNG when the assets dir has no image.

### Calibration can be run from the admin panel (ComfyUI is started on demand)
The per-workflow **gauge** button works in admin mode too: the first calibrate lazily spawns (or attaches to) ComfyUI, and that instance is reused for subsequent calibrations and left running so activating a workflow afterwards attaches instantly. It does **one real run** (with all model VRAM freed first) and splits it at the first sampler step into **model-load** time and **generation** time — reporting a first-run figure (incl. load) and the recurring generation figure the timeline uses. The run gets a fresh random seed so it never returns ComfyUI's cached result (an identical re-submission would finish in ~1s and report a bogus duration). If the ComfyUI paths aren't set yet, you'll get `Configure the ComfyUI paths … before calibrating`. *(In student mode, calibrate while the queue is idle — the live executor and calibration share the one worker.)*

---

## Configuration

`config.json` (v2) is generated automatically and updated through the admin UI. Schema in [implementation_plan.md](implementation_plan.md#v2-configjson). It is per-deployment and not committed (see `.gitignore`).

A previous v1 config is automatically renamed to `config.json.v1.bak` on first boot.

## Development

```
npm run dev          # full stack (server with nodemon + client with vite)
npm run server       # server only
npm run client       # client only
```

Server logs appear in your terminal. ComfyUI stdout/stderr is forwarded with `[ComfyUI]` / `[ComfyUI!]` prefixes when ComfyQ launches it; if you have an external ComfyUI already running on the configured port, ComfyQ attaches to it without spawning its own.

## Acknowledgments

- [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
- [vis-timeline](https://visjs.github.io/vis-timeline/docs/timeline/)
- [Lucide React](https://lucide.dev/)
