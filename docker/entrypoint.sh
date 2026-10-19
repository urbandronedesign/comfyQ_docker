#!/usr/bin/env bash
# Container start: put everything that must outlive the container on the
# volume ($COMFYQ_DATA, /workspace on RunPod), point config.json at the Linux
# install, then run ComfyQ in a restart loop.
#
# Volume layout v2 (see volume-layout.sh): the models, calibration assets and
# quarantine are SHARED by every Pod on the volume; each Pod keeps its own
# settings, job queue, workflows, uploads and results in pods/<pod id>/. A
# volume in the previous single-machine layout is converted on first start.
#
# ⚠ Pods using one volume AT THE SAME TIME also need the volume-wide download
#   lock and the live-Pod guards (Phase I, stages I3/I4), not built yet.
#   Until then, run one Pod per volume at a time.
set -euo pipefail

DATA="${COMFYQ_DATA:-/workspace}"
APP=/app
COMFY=/opt/ComfyUI
PY=/opt/venv/bin/python

source "$APP/docker/volume-layout.sh"
layout_init        # sets POD_ID, SHARED and MINE

# Replace a path in the image with a link to its home on the volume. What the
# image shipped there is copied across first without overwriting anything, so
# the volume keeps its own files and only gains what is new.
link_to_volume() {
    local inside="$1" outside="$2"
    if [[ -L "$inside" ]]; then return; fi
    if [[ -d "$inside" ]]; then
        rsync -a --ignore-existing "$inside"/ "$outside"/
        rm -rf "$inside"
    fi
    ln -s "$outside" "$inside"
}

# Bundles: a calibration or an admin edit writes into workflows/, so each Pod
# keeps its own copy on the volume. A new image therefore only ADDS bundles;
# set COMFYQ_SYNC_WORKFLOWS=1 to let the image's versions overwrite this Pod's
# copy (local edits to those files are lost — commit them to git first).
if [[ "${COMFYQ_SYNC_WORKFLOWS:-0}" == "1" && ! -L "$APP/workflows" ]]; then
    echo "[entrypoint] COMFYQ_SYNC_WORKFLOWS=1: updating this Pod's bundles from the image"
    rsync -a "$APP/workflows"/ "$MINE/workflows"/
fi
link_to_volume "$APP/workflows"      "$MINE/workflows"
link_to_volume "$APP/server/data"    "$MINE/data"
link_to_volume "$APP/.comfyq-lanes"  "$MINE/lanes"
link_to_volume "$COMFY/models"       "$SHARED/models"
for d in input output user comfyq_ingredients; do
    link_to_volume "$COMFY/$d" "$MINE/comfyui/$d"
done
# config.json is a file, so it is linked rather than seeded.
[[ -L "$APP/config.json" ]] || ln -sf "$MINE/config.json" "$APP/config.json"

# Point the config at this install on every start (the volume may have been
# filled on another machine, or by an older image). Everything else in it —
# passwords, the active workflow, the HF token — is left as the admin set it.
cd "$APP"
node -e '
const cm = require("./server/config/configManager");
const [comfy, py, mine, shared] = process.argv.slice(1);
cm.load();
cm.update(c => {
    c.server = { ...c.server, port: 3000, host: "0.0.0.0" };
    Object.assign(c.comfy_ui, {
        installation_type: "system",
        root_path: comfy,
        python_executable: py,
        output_dir: `${mine}/comfyui/output`,
    });
    c.assets = { ...c.assets, dir: `${shared}/assets` };
    c.maintenance = { ...(c.maintenance || {}), quarantineDir: `${shared}/_model_quarantine` };
    return c;
});
console.log("[entrypoint] config.json points at", comfy);
' "$COMFY" "$PY" "$MINE" "$SHARED"

# Settings passed as environment variables when the Pod was created
# (COMFYQ_SERVE, the passwords, the HuggingFace token): see
# server/cloud/podPlan.js and "Launching a Pod from a script" in docker/README.md.
# Once per container start, not per ComfyQ restart, so a mode switch made in
# the admin panel is not undone by the next restart of the loop below.
node server/cloud/podEnv.js || echo "[entrypoint] could not apply the environment settings — continuing without them"

# ComfyUI's stdout/stderr are pipes into the ComfyQ process that spawned it.
# When ComfyQ exits, ComfyUI survives with both ends gone, and the next
# ComfyQ adopts it as already running — then the first line it prints during a
# job raises "[Errno 32] Broken pipe" and every job fails in under a second.
# So ComfyUI never outlives the ComfyQ that started it: stop every instance
# (each lane runs its own) before the next ComfyQ starts a fresh one.
stop_comfyui() {
    pkill -TERM -f "$COMFY/main.py" 2>/dev/null || return 0
    for _ in $(seq 1 30); do
        pgrep -f "$COMFY/main.py" >/dev/null || return 0
        sleep 1
    done
    echo "[entrypoint] ComfyUI did not stop within 30 s — killing it"
    pkill -KILL -f "$COMFY/main.py" 2>/dev/null || true
    sleep 1
}

# ComfyQ restarts itself by exiting (switching mode, activating a workflow,
# the panel's Restart button). On the rigs nodemon brings it back; here this
# loop does. A crash also comes back, after a pause so a broken config cannot
# spin the CPU.
while true; do
    set +e
    node server/index.js
    code=$?
    set -e
    stop_comfyui
    if [[ $code -eq 0 ]]; then
        echo "[entrypoint] ComfyQ exited for a restart"
        sleep 1
    else
        echo "[entrypoint] ComfyQ exited with code $code — restarting in 5 s"
        sleep 5
    fi
done
