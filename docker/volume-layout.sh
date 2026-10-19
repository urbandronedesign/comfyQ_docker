#!/usr/bin/env bash
# Volume layout v2 (Phase I, stages I1 + I2): one network volume shared by
# several Pods. Sourced by entrypoint.sh; tested by test-volume-layout.sh.
#
#   $DATA/shared/                   every Pod
#       models/                     the weights
#       assets/                     sample media for calibration
#       _model_quarantine/          what the prune tool moved aside
#       pods/                       heartbeats (stage I4)
#       .layout-v2                  marker: this volume uses this layout
#   $DATA/pods/<pod id>/            one Pod only
#       config.json  data/  lanes/  workflows/
#       comfyui/{input,output,user,comfyq_ingredients}/
#
# A volume in the previous layout ($DATA/comfyq/, $DATA/comfyui/models, …) is
# converted once, by MOVING (a rename on the same disk, instant for 40 GB of
# models), never copying. Its ComfyQ state becomes the converting Pod's own
# folder, so the queue, results and settings survive. A link
# $DATA/comfyui/models -> ../shared/models is left so an image from before
# this change still finds the models.

# Who am I? RunPod sets RUNPOD_POD_ID, and a stopped-then-started Pod keeps
# it, so it finds its own folder again. Outside RunPod a single container is
# the normal case, so the fallback is one fixed name rather than the hostname
# (a container's hostname changes with every container, which would strand
# the state on each restart).
layout_pod_id() {
    local id="${COMFYQ_POD_ID:-${RUNPOD_POD_ID:-default}}"
    id="${id//[^A-Za-z0-9_-]/_}"
    echo "${id:0:64}"
}

_log() { echo "[layout] $*"; }

# Move every entry of $1 into $2. An entry already present in $2 is left where
# it was and reported, never overwritten: a half-finished earlier conversion
# must not be able to replace newer files with older ones.
_merge_move() {
    local src="$1" dst="$2" e name kept=0
    [[ -e "$src" || -L "$src" ]] || return 0
    if [[ -L "$src" ]]; then _log "skip $src (already a link)"; return 0; fi
    if [[ ! -d "$src" ]]; then
        if [[ -e "$dst" ]]; then _log "KEPT $src: $dst already exists"; return 0; fi
        mkdir -p "$(dirname "$dst")"
        mv "$src" "$dst" && echo "moved $src -> $dst" >> "$_MIGRATION_LOG"
        return 0
    fi
    mkdir -p "$dst"
    shopt -s dotglob nullglob
    for e in "$src"/*; do
        name="$(basename "$e")"
        if [[ -e "$dst/$name" || -L "$dst/$name" ]]; then
            if [[ -d "$e" && ! -L "$e" && -d "$dst/$name" ]]; then
                _merge_move "$e" "$dst/$name"
            else
                _log "KEPT $e: $dst/$name already exists"
                kept=1
            fi
        else
            mv "$e" "$dst/$name" && echo "moved $e -> $dst/$name" >> "$_MIGRATION_LOG"
        fi
    done
    shopt -u dotglob nullglob
    rmdir "$src" 2>/dev/null || { [[ $kept -eq 1 ]] || _log "left $src (not empty)"; }
}

# True when the volume still holds the previous layout.
_has_old_layout() {
    [[ -d "$DATA/comfyq" ]] \
        || { [[ -d "$DATA/comfyui/models" ]] && [[ ! -L "$DATA/comfyui/models" ]]; } \
        || [[ -d "$DATA/assets" ]] || [[ -d "$DATA/_model_quarantine" ]]
}

# Take a file lock with an exclusive create (bash noclobber is O_EXCL, which
# stage 0 showed gives exactly one winner across Pods on a RunPod volume).
_try_lock() { ( set -o noclobber; echo "$1 $(date +%s)" > "$2" ) 2>/dev/null; }

layout_migrate() {
    local shared="$DATA/shared" mine="$1" mark="$DATA/shared/.layout-v2"
    local lock="$DATA/.layout-migration.lock" waited=0 owner age recent
    [[ -f "$mark" ]] && return 0
    if ! _has_old_layout; then
        _try_lock "$POD_ID fresh" "$mark" || true
        return 0
    fi

    # One Pod converts; any other one starting at the same moment waits for
    # the marker. A lock older than 15 minutes belongs to a Pod that died
    # mid-conversion (moving is renames: it takes seconds).
    until _try_lock "$POD_ID" "$lock"; do
        [[ -f "$mark" ]] && return 0
        read -r owner age < "$lock" 2>/dev/null || true
        # Our own id on the lock: left by this Pod's previous container, which
        # was stopped mid-wait or mid-conversion. A Pod never runs two
        # containers at once, so nobody else holds it.
        if [[ "${owner:-}" == "$POD_ID" ]]; then
            _log "taking back this Pod's own conversion lock from its previous start"
            rm -f "$lock"
            continue
        fi
        if [[ -n "${age:-}" ]] && (( $(date +%s) - age > 900 )); then
            _log "the conversion lock from $owner is over 15 minutes old — taking it over"
            rm -f "$lock"
            continue
        fi
        (( waited % 30 == 0 )) && _log "another Pod ($owner) is converting this volume — waiting"
        sleep 5; waited=$((waited + 5))
    done
    if [[ -f "$mark" ]]; then rm -f "$lock"; return 0; fi

    # A Pod still running the previous image writes into $DATA/comfyq/data;
    # converting under it would pull its files away. Wait for it to be quiet.
    # This only catches an ACTIVE one — the console also refuses to start a
    # second Pod on a volume another Pod is using.
    while recent="$(find "$DATA/comfyq/data" -type f -mmin -5 -print -quit 2>/dev/null)" && [[ -n "$recent" ]]; do
        _log "$recent changed in the last 5 minutes: another Pod may still be using this volume. Waiting for it to stop."
        echo "$POD_ID $(date +%s)" > "$lock"     # keep our lock fresh while waiting
        sleep "${LAYOUT_QUIET_POLL:-60}"
    done

    _MIGRATION_LOG="$shared/migration-$(date +%Y%m%d-%H%M%S).log"
    mkdir -p "$shared"
    echo "converted to layout v2 by Pod $POD_ID on $(date -u +%FT%TZ)" > "$_MIGRATION_LOG"
    _log "converting this volume to the shared layout; this Pod ($POD_ID) keeps its queue, results and settings"

    # Shared: models, assets, quarantine.
    _merge_move "$DATA/comfyui/models"     "$shared/models"
    _merge_move "$DATA/assets"             "$shared/assets"
    _merge_move "$DATA/_model_quarantine"  "$shared/_model_quarantine"
    # This Pod: everything that was one machine's state.
    _merge_move "$DATA/comfyq/config.json" "$mine/config.json"
    _merge_move "$DATA/comfyq/data"        "$mine/data"
    _merge_move "$DATA/comfyq/lanes"       "$mine/lanes"
    _merge_move "$DATA/comfyq/workflows"   "$mine/workflows"
    for d in input output user comfyq_ingredients; do
        _merge_move "$DATA/comfyui/$d" "$mine/comfyui/$d"
    done
    rmdir "$DATA/comfyq" 2>/dev/null || _log "left $DATA/comfyq (holds files the conversion did not expect — see the migration log)"

    # Old images look for $DATA/comfyui/models.
    mkdir -p "$DATA/comfyui"
    if [[ ! -e "$DATA/comfyui/models" ]]; then ln -s ../shared/models "$DATA/comfyui/models"; fi

    echo "$POD_ID $(date -u +%FT%TZ) converted from the previous layout; its state is in pods/$POD_ID" > "$mark"
    rm -f "$lock"
    _log "done — $(grep -c '^moved' "$_MIGRATION_LOG") item(s) moved, log in $_MIGRATION_LOG"
}

# Create the layout (converting an old volume first) and export where things
# live: SHARED and MINE.
layout_init() {
    POD_ID="$(layout_pod_id)"
    SHARED="$DATA/shared"
    MINE="$DATA/pods/$POD_ID"
    mkdir -p "$SHARED"/{models,assets,_model_quarantine,pods} "$DATA/pods"
    layout_migrate "$MINE"
    mkdir -p "$MINE"/{data,lanes,workflows} "$MINE"/comfyui/{input,output,user,comfyq_ingredients}
    export POD_ID SHARED MINE
    _log "Pod $POD_ID: shared files in $SHARED, its own in $MINE"
}
