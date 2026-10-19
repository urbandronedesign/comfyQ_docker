# Launching ComfyQ Pods on RunPod

Two ways to do the same thing, both needing only Node 22 or later (no
`npm install`):

- **The console**: a page on this machine for the credentials, the workflows,
  the GPU, launching and monitoring. Start it by double-clicking
  **`RunPod-Console.bat`** at the root of the repo, or with
  `npm run runpod:console`. It opens `http://localhost:4777`.
- **The command line**: `runpod.mjs`, described further down, for scripts.

> **Status:** written 2026-10-19 against RunPod's REST API
> (`https://rest.runpod.io/v1`, checked against its OpenAPI spec that day) and
> its GraphQL API for GPU prices. Both were tested end to end against a
> stand-in RunPod, **not yet against a real account**: try a cheap GPU before
> a class.

## The console

1. **Credentials.** The RunPod API key (with read and write access), the
   admin password you choose (required), a student access password
   (optional: leave it empty and anyone with the link can book jobs), and a
   HuggingFace token if you serve gated models. **Test the key** checks it
   against RunPod. Saved in `<your home folder>/.comfyq/runpod-console.json`;
   the page itself is only told whether each one is set.
2. **Launch.** Pick or create a network volume. Tick the workflows (the first
   is the main one). The GPU table then shows every GPU with its VRAM, price
   and stock in the volume's data centre, greys out the ones too small or out
   of stock, and marks the cheapest one that fits as **recommended**. The VRAM
   figure is what each workflow used when it was calibrated, plus 2 GB, or the
   bundle's stated minimum when it was never measured. Tick **fallback** on
   other GPUs to accept them if the first is not available. Then **Launch
   Pod**.
3. **Pods.** Each Pod's progress (booting, downloading models with a bar per
   file, starting, serving), its cost per hour, how long it has run, students
   connected, the queue, links to the student page, admin panel and ComfyUI,
   and Stop / Start / Terminate. It keeps refreshing while it is open.

**Safety.** The console holds a key that can spend money, so it only answers
on `127.0.0.1` and refuses requests from other websites open in the same
browser. Closing the console window stops the page, **not the Pods**: a Pod
bills until it is stopped, from the console or from the RunPod website.

The workflow list comes from this checkout's `workflows/` folder. The Pod
serves the workflows its image was built with, so a workflow added here after
the last image build is not on the Pod yet.

## The command line

### Once: what you need

1. **A RunPod API key**: RunPod → *Settings* → *API Keys*.
2. **A network volume**, created once in the RunPod console (*Storage* →
   *Network Volumes*). The models live on it, so they are downloaded only the
   first time. It sits in one data centre, and every Pod using it is started
   there.
3. **An admin password.** A Pod is on the public internet, so the launcher
   refuses to serve without one: otherwise anyone with the link could run
   the admin panel. The student access password is optional; without it
   anyone with the link can book jobs.

On Windows (PowerShell):

```powershell
$env:RUNPOD_API_KEY = "rpa_..."
$env:COMFYQ_ADMIN_PASSWORD = "..."
$env:COMFYQ_ACCESS_PASSWORD = "..."   # optional: what students type to get in
$env:HF_TOKEN = "hf_..."              # only for gated models (FLUX.2, some LTX)
```

On macOS / Linux, `export RUNPOD_API_KEY=...` and so on.

**Keeping the secrets out of the Pod's settings page.** Whatever these
variables hold is copied into the Pod's environment, which RunPod shows on
the Pod's page. To avoid that, store each value as a RunPod secret
(*Settings* → *Secrets*) and set the variable to a reference instead, for
example `$env:COMFYQ_ACCESS_PASSWORD = "{{ RUNPOD_SECRET_comfyq_access }}"`.
RunPod substitutes the real value inside the Pod.

### Launching

```powershell
node tools/runpod/runpod.mjs volumes
node tools/runpod/runpod.mjs launch --volume comfyq-models --gpu "NVIDIA GeForce RTX 5090" --serve image_flux2_klein_9b_t2i
```

What happens:

1. The Pod is created in the volume's data centre, from
   `ghcr.io/urbandronedesign/comfyq:latest`, with ports 3000 and 8188.
2. At boot the image stores the passwords and the token, then downloads every
   model the named workflows are missing, into the right folder under the
   right name, onto the volume.
3. Once every model is there it serves the workflows. The first one is the
   main one; any others open beside it as parallel lanes.
4. The launcher prints progress as it goes, and then the links:

```
students  https://<pod-id>-3000.proxy.runpod.net
admin     https://<pod-id>-3000.proxy.runpod.net/admin
```

The first launch on an empty volume takes as long as the downloads (a large
bundle can take tens of minutes). Later launches skip the downloads.

Several workflows: `--serve image_flux2_klein_9b_t2i,utility_seedvr2_4k_upscale`.
The extra lanes are opened the way a restart reopens them, **without** the
VRAM check the admin panel applies, so choose workflows whose measured VRAM
(shown on each admin card) adds up to less than the GPU's.

| Option | Meaning |
|---|---|
| `--gpu` | RunPod GPU type ids, comma-separated in order of preference, e.g. `"NVIDIA GeForce RTX 5090,NVIDIA RTX A6000"` |
| `--serve` | workflow ids (the folder names under `workflows/`). Leave it out to start in admin mode |
| `--name` | Pod name (default `comfyq-<first workflow>`) |
| `--image` | another image tag, e.g. `ghcr.io/urbandronedesign/comfyq:sha-fdd2867` |
| `--disk` | container disk in GB (default 30) |
| `--community` | Community Cloud instead of Secure Cloud (cheaper, less reliable) |
| `--no-fetch` | serve without downloading missing models |
| `--sync-workflows` | let the image's workflow bundles overwrite the volume's |
| `--allow-open` | serve with no passwords, on purpose |
| `--no-wait` | create the Pod and return |
| `--timeout` | minutes to follow it (default 120) |

### Afterwards

```powershell
node tools/runpod/runpod.mjs status <podId>     # mode, served workflows, model fetch
node tools/runpod/runpod.mjs list
node tools/runpod/runpod.mjs stop <podId>       # stops the GPU billing; restart with start
node tools/runpod/runpod.mjs start <podId>
node tools/runpod/runpod.mjs terminate <podId> --yes   # deletes the Pod; the volume stays
```

A stopped Pod restarts with the same settings and serves again by itself. A
stopped Pod can come back without a GPU if the data centre has none free; in
that case terminate it and launch a new one, which reuses the volume.

## When it does not serve

The launcher stops following the Pod and prints the reason. The GPU is still
billing, so either fix the cause or stop the Pod. Common reasons:

- **`not serving: no COMFYQ_ADMIN_PASSWORD…`**: set the admin password.
- **`unknown or unavailable workflow`**: the id is wrong, or the workflow is
  not in this image (`--sync-workflows` if it is new).
- **`could not be fetched: … 401`**: a gated model. Accept its licence on
  HuggingFace and set `HF_TOKEN`.
- **`no direct link — get it from …`**: the model has no direct download.
  Put it on the volume by hand under `/workspace/comfyui/models/`.

The Pod's status is also readable directly at
`https://<pod-id>-3000.proxy.runpod.net/admin/pod-plan`.
