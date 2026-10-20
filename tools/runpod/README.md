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
> its GraphQL API for GPU prices. Used on a real account the same day (single
> Pods, and two Pods sharing a volume). Launching several Pods from the console
> in one go (added later that day) was tested against a stand-in RunPod only so far.

## The console

**One page per provider** — *RunPod* and *Thunder Compute*, in the header (or `http://localhost:4777/#runpod` and `#thunder`). Each page has the same layout, after Thunder's own dashboard: a row of tiles (total, running, other, $ per hour), then a table with a search box and status and GPU filters; click a row to open its details below the table. **+ Create** opens the launch form in a panel on the right (Escape or ✕ closes it). The keys and passwords are behind **Settings** in the header, which opens by itself the first time. The spending tiles sit above both pages.

1. **Settings.** The RunPod API key (with read and write access), the
   admin password you choose (required), a student access password
   (optional: leave it empty and anyone with the link can book jobs), and a
   HuggingFace token if you serve gated models. **Test the key** checks it
   against RunPod. Saved in `<your home folder>/.comfyq/runpod-console.json`;
   the page itself is only told whether each one is set.
2. **+ Create on the RunPod page.** Pick or create a network volume. Tick the workflows (the first
   is the main one). The GPU table then shows every GPU with its VRAM, price
   and stock in the volume's data centre, greys out the ones too small or out
   of stock, and marks the cheapest one that fits as **recommended**. The VRAM
   figure is what each workflow used when it was calibrated, plus 2 GB, or the
   bundle's stated minimum when it was never measured. Tick **fallback** on
   other GPUs to accept them if the first is not available. Then **Launch
   Pod**.

   **Several Pods on one volume.** Set up the first Pod, press **+ Add another
   Pod**, and the form clears for the next one: its own workflows, and a GPU
   recommended for those workflows alone. **Launch N Pods** creates them all,
   with the total $/hour shown beforehand. They share the volume's models;
   a model several of them need is downloaded once, and the others wait for
   it. If RunPod has no machine for one of them, the others are still created
   (and billing), and the refused one stays in the list with the reason:
   **Edit** it to pick another GPU, then **Launch** again.
3. **The Pods table.** Grouped by network volume (a row per volume says how many run on it and what
   they cost together per hour, with **Folders…** and **Stop all**). When two or more
   Pods run on one volume, the console checks which image build each serves
   and warns when they differ: Pods that pulled `latest` at different times
   can, and a newer build may expect a newer layout on the volume. For each
   Pod: its progress (booting, downloading models with a bar per file — or
   *waiting for* another Pod downloading the same one — starting, serving),
   cost per hour, how long it has run, students connected, the queue, its own
   student page, admin panel and ComfyUI links, and Stop / Start / Terminate.
   It keeps refreshing while it is open.

**No network volume — any data centre.** The last choice in the volume list.
A network volume lives in one data centre and its Pods must run there, so
when that data centre has no free GPU, no Pod can start (it happened in
EU-RO-1 for hours on 2026-10-19). With this choice RunPod puts the Pod in any
data centre with the GPU free. The Pod gets a disk of its own at `/workspace`
(80 GB by default) and downloads its models there at its first boot — public
models only take a few minutes, gated ones need the HuggingFace token. That
disk survives Stop and Start but **not Terminate**, which deletes the models
and every result students made: use **Download results** on the Pod (a zip of
its outputs, their settings and uploads) before terminating, and the console
says so when you do.

**Workshop day — so a class never meets "no GPU free":**
1. Launch the Pods well before the class (the evening before, or early that
   morning) and **do not stop them until it is over**: a running Pod keeps its
   GPU, a stopped one gives it back with no promise of getting one again.
   Leaving one running overnight costs a few dollars.
2. Tick several fallback GPUs, including dearer ones, rather than waiting for
   the cheapest.
3. If the volume's data centre has nothing, launch with **No network
   volume** instead.
4. Rehearse at the same hour a few days before: stock depends on the time of day.

**Folders left behind.** Each Pod keeps its queue, settings, results and
uploads in its own folder on the volume (`pods/<pod id>/`), and terminating a
Pod leaves that folder there, costing storage. **Folders…** on a volume in the
Pods table lists every Pod folder with its size and number of result files, read
through a Pod running on that volume (the console itself cannot see inside a
volume, so one Pod must be running). Each folder says whose it is: the reading
Pod's own, a running Pod's, a **stopped** Pod's — kept, it is that Pod's state
for when it starts again — or one whose Pod **no longer exists**. Only the
last can be deleted, after typing its name; **Download results** first gets a
zip of what its jobs produced, their settings and inputs, and the uploads.
Whether the Pod still exists is checked against your account again at the
moment of deleting, and the Pod doing the deleting refuses its own folder, a
folder whose Pod is running, and anything at all if it has no admin password.
Nothing is ever deleted automatically.

**When may another Pod join a volume?** When every Pod already running on it
answers that it can share (images from 2026-10-19 on, `sha-bca559f` or later).
A Pod still booting cannot answer yet, so it blocks a new one — unless both use
the **same image**, which is what launching or starting several together does.
A Pod on an older image is refused outright: it has no download lock, so two
Pods could write the same model file. Pinning an image older than `sha-bca559f`
under *Advanced* and launching several Pods on it is therefore not safe.

**Safety.** The console holds a key that can spend money, so it only answers
on `127.0.0.1` and refuses requests from other websites open in the same
browser. Closing the console window stops the page, **not the Pods**: a Pod
bills until it is stopped, from the console or from the RunPod website.

The workflow list comes from this checkout's `workflows/` folder. The Pod
serves the workflows its image was built with, so a workflow added here after
the last image build is not on the Pod yet.

## Security

The console holds keys that spend money, so it is locked down (audit, 2026-10-20):
- It listens on this machine only, checks the `Host` header, and every API call needs a token made at each start: `RunPod-Console.bat` opens the page at `#t=<token>` (kept in that tab only); the desktop app hands it to its own window. A tab opened without it gets "no access": start the console again.
- Anything that is not the console's own page is answered as plain text the browser will not run; a machine's own error page is never passed through.
- The admin password is sent only to Pods and instances of your account. A Docker image other than ComfyQ's must be confirmed in Settings, because a launch gives it your passwords and HuggingFace token.
- Thunder: the instance's SSH host key is pinned at the first login, before any secret is sent.
- Key and settings files are readable by your Windows account only. The desktop app keeps the keys in Windows protected storage and ignores every test setting.
- `node tools/runpod/tests/console-security.mjs` checks all of this (it runs in `npm run test:storyboard`).

## Spending, above both pages

The tiles above both pages show what you are spending. It refreshes every 15 seconds and ticks every second in between:

- **Spending now**: dollars per hour across RunPod and Thunder together. "storage only" means no GPU is running (the RunPod volume costs about $0.01/h).
- **Today** and **This month**, plus what today reaches by midnight if everything is left on.
- **RunPod balance**, and how long it lasts at the current rate.
- **Thunder balance**: Thunder shows it only on its website (console.thundercompute.com → Settings → Billing); an API key gets 403 on every billing call. Type it into the box once; the console subtracts what runs on Thunder from then on. Type it again after a top-up.
- **Before every launch** the confirmation says what the balance covers at that price (⚠ under 4 hours), and a launch the balance cannot pay for one hour is refused. On RunPod that matters most: a Pod is stopped when the balance reaches zero, and every render running is lost.
- **Daily budget** (optional): the meter turns amber at 80 % and red above it, and the bar warns when leaving machines on would go over.
- One line per running machine: how long it has been on and what it has cost so far. A machine on for more than 3 hours shows in red.

Where the figures come from:
- **RunPod reports money.** Today is the balance at the first reading of the day minus the balance now. A top-up does not count as spending.
- **Thunder has no balance or usage API**, so its figures are computed: each instance's hourly price times how long it has existed. The ledger in `~/.comfyq/spend-ledger.json` keeps them after the instance is deleted. If an instance is deleted while the console is closed, the next reading records it as closed, so the figure can read slightly high, never low.
- **Thunder charges more than the card price.** It adds $0.04/h for each vCPU above the smallest option and $0.0003/h for each GB of disk above 100 GB (its own formula, from its CLI). An L40 with 8 vCPU and 200 GB costs **$0.90/h**, not $0.79. The Thunder tab and the launch confirmation show the full price.
- The ledger starts the first time the console runs with this feature. Until a full day or month has passed, "counted from …" shows when counting started.

## Disk and models: refused before anything bills

A new machine downloads every model its workflows need. The console reads how much from `tools/model-provenance/workflow-downloads.json` (one entry per workflow, with sizes read from HuggingFace). It then:
- on **Thunder**, raises the disk field to what the image (about 40 GB once pulled), the models and room for results need, and refuses a launch with less;
- on **RunPod**, refuses a launch whose models are bigger than the whole volume, or bigger than the Pod's own disk in Plan B;
- refuses any workflow that **cannot fetch all its models on a new machine**. Today that means the two Krea 2 character-sheet workflows, whose files have no known source.

Regenerate the sizes after adding a workflow: `node tools/model-provenance/fresh-machine.cjs --online --write-sizes`.

## Stock history: when are cards free?

RunPod only says what is in stock **now** and keeps no history. A GitHub
Actions job, [runpod-stock.yml](../../.github/workflows/runpod-stock.yml),
takes a reading every 15 minutes with
[stock-recorder.mjs](stock-recorder.mjs): which cards of 24 GB or more are
free, at what price, in each of RunPod's data centres. It saves the readings on
the repository's **`runpod-stock` branch** (one file per month, never on
`main`). The RunPod page's **When are cards free?** section reads them and shows, for a data centre
and a card, in what share of the readings it was free, by weekday and hour,
in your local time. Use it to choose when to launch before a class. No
machine has to stay on.

**Setting it up, once:**
1. On RunPod: *Settings → API Keys → Create API Key*, with **read-only**
   permission. A read-only key cannot create Pods or spend money, which is
   why it is the one to give GitHub.
2. On GitHub, in this repository: *Settings → Secrets and variables →
   Actions → New repository secret*, named `RUNPOD_API_KEY_READONLY`, with that
   key as the value.
3. *Actions → RunPod stock → Run workflow* takes a first reading at once; the
   schedule does the rest.

Good to know: GitHub's schedule is best-effort — a new one starts late, and
triggers are delayed or dropped at busy hours (the first three 15-minute slots
never fired here). So the workflow does not rely on it every 15 minutes: one
run stays up for ~5h45m and takes its own readings at :07, :22, :37 and :52,
and when it ends it starts the next run itself, so readings continue even if
the hourly trigger never fires (it did not, for hours, on 2026-10-19). A newer
run waits for the current one, and a reading under 10 minutes old is not
repeated. In the Actions tab you will therefore see one long run at a time,
not one per reading. **To stop the readings: Actions → RunPod stock → ⋯ →
Disable workflow** (cancelling a run also stops the chain). GitHub also pauses
scheduled jobs in a repository with no activity for 60 days: re-enable it from
the Actions tab. And a reading says
what RunPod listed at that moment; a card listed as free can still be taken a
second later.

## Thunder Compute: the backup when RunPod has no card

The console's **Thunder Compute** page launches ComfyQ on [Thunder Compute](https://www.thundercompute.com)
instead: RTX A6000 / L40 (48 GB) or A100 (80 GB), billed per minute, in North America.
Put the API token in *Settings → Thunder Compute* (Thunder's console → *Settings → API Tokens*)
and press *Test the key*: it lists your instances and shows live prices and stock.

Then tick the workflows, pick a card (the cheapest that fits and is in stock is
recommended) and press *Launch on Thunder*. The console:

1. creates the instance (the `base` template) and saves the login key Thunder returns once,
   in `~/.comfyq/thunder-keys/`;
2. waits until Thunder says it is running, then logs in over SSH (as `ubuntu`, else `root`)
   and starts our image with Docker, passing the passwords, the HF token and the workflows in an
   env file (never on a command line);
3. opens port 3000. Students use `https://<uuid>-3000.thundercompute.net`, the admin panel is at `/admin`.

The setup log and the model downloads show in the instance's details (they open by themselves while it sets up) until it serves. If a step fails,
**the instance keeps billing**: press *Retry setup* (it is safe to run twice) or *Delete…*.

- **No network volume.** The instance's own disk holds the models (downloaded at the first boot)
  and the students' results. **Delete removes both**: press *Download results* first.
- **No stop.** Thunder has no stop button that keeps the machine; it is running or deleted.
  Launch early on the day and delete at the end.
- **Docker on Thunder is "experimental":** the GPU goes in with `--device nvidia.com/gpu=all`
  (`--gpus` is not supported), and a process can outlive its container, so the script stops a
  leftover ComfyUI before starting again.
- Thunder publishes stock twice and the two can disagree; the console then says *unclear*
  rather than *in stock*.
- Needs `ssh` on this machine (built into Windows 10/11, macOS and Linux).

Tested against stand-ins (no account, nothing spent):
`node tools/runpod/thunder.test.mjs` and `node tools/runpod/tests/thunder-console.mjs`
(add `--browser "<path to chrome.exe>"` to also check the page in headless Chrome).
Test hooks: `THUNDER_API_URL`, `COMFYQ_THUNDER_PROXY` (`{uuid}`, `{port}`), `COMFYQ_THUNDER_SSH`.

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
