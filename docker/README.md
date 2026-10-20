# ComfyQ in Docker (RunPod and other GPU clouds)

One image holds ComfyQ, ComfyUI and the node packs. Everything that has to
outlive a container (models, results, the job queue, settings) lives on a
volume mounted at `/workspace`.

> **Status:** verified on a real RunPod Pod on 2026-10-13: the SDXL smoke test
> rendered a picture end to end. On a new Pod, still check the logs and run
> the smoke test before downloading the big models.

## What is in the image

| Piece | Version / source |
|---|---|
| CUDA runtime | 12.8 (Ubuntu 24.04), so Blackwell cards (RTX 5090) work |
| Python | 3.12, in `/opt/venv` |
| torch | 2.8.0+cu128, the same build as the Windows rigs |
| ComfyUI | `v0.42.1` by default (`COMFYUI_VERSION` build argument), in `/opt/ComfyUI` |
| Node packs | the list in [custom-nodes.txt](custom-nodes.txt) |
| ComfyQ | this repo, in `/app`, with the client prebuilt and served on port 3000 |

No model weights are in the image. They go on the volume (see below).

## Building a new image

You need a new image whenever the code, the node-pack list or the ComfyUI
version changes. Models, workflows you calibrate on the Pod, and settings do
**not** need one: those live on the volume.

**On GitHub (normal way).** The workflow
[.github/workflows/docker.yml](../.github/workflows/docker.yml) builds and
pushes `ghcr.io/<github-account>/comfyq`. Start it either way:

- **By hand:** GitHub → *Actions* → *Build Docker image* → *Run workflow*. You
  can change the ComfyUI version in the form.
- **With a version tag:**
  ```
  git tag docker-v1.0.0
  git push origin docker-v1.0.0
  ```

The first build takes a long time (torch, ComfyUI and every pack's Python
dependencies). Later builds reuse those layers from the registry cache, so a
change to ComfyQ's own code rebuilds in a few minutes.

Each build is tagged `sha-<commit>`. A build of `main` or of a `docker-v*` tag
is also tagged `latest`, and a `docker-v*` tag adds its own version (`1.0.0`).

**On your own machine**, if Docker is installed:
```
docker build -f docker/Dockerfile -t comfyq .
docker build -f docker/Dockerfile --build-arg COMFYUI_VERSION=v0.39.1 -t comfyq .
```

### Changing the node packs

Edit [custom-nodes.txt](custom-nodes.txt): one git URL per line, optionally
pinned with `@<commit>` or `@<tag>`. Then rebuild. The image keeps a record of
what it installed in `/opt/ComfyUI/custom_nodes/.comfyq-packs.txt`
(name, URL, commit).

A pack installed from the admin panel on a running Pod sits on the container's
own disk and **disappears when the Pod restarts**. Add it to the list instead.

## Image visibility

The package `ghcr.io/urbandronedesign/comfyq` is **public**: it inherited the
public repository's visibility, so RunPod pulls it with no login.

A fork built from a **private** repository gets a private package. In that
case, either make it public (GitHub → your profile → *Packages* → `comfyq` →
*Package settings* → *Change visibility*), or give RunPod a login: RunPod →
*Settings* → *Container Registry Auth*, with your GitHub username and a
personal access token that has the `read:packages` scope.

## Running it on RunPod

Create a **template** (RunPod → *Templates* → *New template*):

| Field | Value |
|---|---|
| Container image | `ghcr.io/<github-account>/comfyq:latest` |
| Container disk | 30 GB (the image and temporary files) |
| Volume mount path | `/workspace` |
| HTTP ports | `3000` (ComfyQ), `8188` (ComfyUI's editor) |

Then:

1. Create a **network volume** large enough for the models you want to serve,
   in the same data centre as the GPUs you will rent. The models are the
   expensive part of storage: the full Windows rig holds about 1.3 TB, but you
   only need the bundles you serve.
2. Start a Pod from the template with that volume attached. Pick a GPU with at
   least the VRAM of your largest bundle (most need 16–24 GB; the
   calibrations were measured on a 32 GB RTX 5090).
3. Open `https://<pod-id>-3000.proxy.runpod.net/admin`. The first start sets
   up the volume and points the settings at the Linux install by itself.
4. **Check the Pod works before downloading anything big.** Activate
   *SDXL — smoke test*: its one model (6.9 GB, public, no token) downloads from
   its card, it uses only ComfyUI's built-in nodes, and it renders in a few
   seconds once loaded (about 30 s the first time, on an RTX 5090). If that
   produces a picture, the image, the GPU and the volume all work.
5. Fill in the models. On the workflow cards, the panel lists missing models
   and can download them onto the Pod. Gated models (FLUX.2, some LTX) need a
   HuggingFace token, set under *Manage ComfyUI*.
6. Pick a workflow and *Activate & serve*. Students use
   `https://<pod-id>-3000.proxy.runpod.net`.

### Launching a Pod from a script

Steps 2 to 6 can be done without the RunPod website. Double-click
`RunPod-Console.bat` for a page on your own machine that takes the
credentials, recommends a GPU, launches the Pod and monitors it; or use
[tools/runpod/runpod.mjs](../tools/runpod/README.md) from a terminal. Both
create the Pod through RunPod's API and follow it until students can book. It works because the
image reads these environment variables at boot
([server/cloud/podPlan.js](../server/cloud/podPlan.js)); you can also set
them by hand in a RunPod template.

| Variable | Effect |
|---|---|
| `COMFYQ_SERVE` | workflow ids, comma-separated: fetch their missing models, then serve them (the first as the main lane, the rest as parallel lanes) |
| `COMFYQ_FETCH_MODELS` | `0` to serve without fetching |
| `COMFYQ_ADMIN_PASSWORD` | admin password |
| `COMFYQ_ACCESS_PASSWORD` | student access password (optional: without it anyone with the link can book jobs) |
| `COMFYQ_HF_TOKEN` or `HF_TOKEN` | HuggingFace token for gated models |
| `COMFYQ_ALLOW_OPEN` | `1` to serve with no admin password. Without it, `COMFYQ_SERVE` is refused unless the admin password is set |

They are applied once per container start. A password that has not changed
is left alone, so restarting a Pod does not log students out. Progress and
any failure are at `/admin/pod-plan`.

### What lives where on the volume

The models and calibration samples are **shared** by every Pod on the volume;
each Pod keeps **its own** settings, job queue, workflows, uploads and results
in a folder named after its RunPod Pod id:

```
/workspace/
  shared/
    models/                 model weights, used by every Pod
    assets/                 sample pictures/videos for calibration
    _model_quarantine/      models the prune tool moved aside
    .layout-v2              marks the volume as using this layout
    migration-*.log         what was moved, if the volume was converted
  pods/<pod id>/
    config.json             settings: passwords, active workflow, HF token
    data/                   job queue (sqlite), serving state, start-up plan
    workflows/              this Pod's copy of the workflow bundles
    lanes/                  extra ComfyUI instances' working folders
    comfyui/input/ output/  uploads and results
    comfyui/user/           ComfyUI's own settings and saved graphs
  comfyui/models -> ../shared/models   (only on a converted volume, for older images)
```

A **stopped and restarted** Pod keeps its id, so it finds its own queue and
results again. A **terminated** Pod's folder stays on the volume (results
included) until you delete it — from the RunPod console's **Folders…** button,
which lists the folders of Pods that no longer exist and lets you download their
results first ([tools/runpod/README.md](../tools/runpod/README.md)). Outside RunPod the folder is `pods/default`, or
the name in `COMFYQ_POD_ID`.

**Several Pods can run on one volume at the same time.** Each Pod announces
itself every 30 seconds in `shared/pods/`. When two Pods need the same missing
model, one downloads it and the other waits for the file (its start-up shows
*"waiting for Pod … to finish downloading it"*). While another Pod is up,
**pruning models and restoring or emptying the quarantine are refused**: the
models are shared, and a model unused by this Pod may be in use by the other.
The Maintenance tab says which other Pods are on the volume. The console and
the command line only let a Pod join a volume when every Pod already on it
runs an image with these protections; an older one has to be stopped or
restarted first.

**A volume from an older image is converted on first start.** The models move
to `shared/models` and the old settings, queue and results become the first
Pod's own folder. It is a move, not a copy, so it takes seconds and needs no
extra space. Nothing is overwritten: if a file already exists at the
destination, the old one is left where it was and the log says so. **Stop every
other Pod on the volume first.** The conversion waits while files in the old
queue folder are still changing, but an idle old Pod would not show up that way.

**Workflows.** Each Pod's bundles are copied from the image on its first start,
so calibrations and admin edits survive restarts. A newer image only *adds*
bundles the Pod does not have yet. To replace them with the image's, start the
Pod once with the environment variable `COMFYQ_SYNC_WORKFLOWS=1`. That
overwrites them, so commit any edit you want to keep to git first.

## Known limits

- **RunPod cuts any request after 100 seconds.** A few admin actions wait for
  ComfyUI to start (up to about 90 s from cold) and may show an error even
  though the start then completes; reload the page. Booking and running jobs
  are not affected. The live connection should fall back to polling if needed;
  to be checked on the first Pod.
- **"Open in ComfyUI"** builds its link as `<this address>:8188`, which is not
  how RunPod names ports. Open `https://<pod-id>-8188.proxy.runpod.net` by hand
  until that is fixed.
- **"Update ComfyUI" in the Maintenance tab does not apply**: it only knows the
  Windows portable layout. Rebuild the image with a new `COMFYUI_VERSION`
  instead. Updating a single node pack from the panel works until the next
  restart.
- **Fleet discovery** (the ComfyQ Discovery app) cannot see a cloud Pod: it
  relies on the local network.
- **Windows-only tools** (drive-letter swap, the `.bat`/`.ps1` maintenance
  scripts) do nothing here.
