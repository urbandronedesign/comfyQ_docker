#!/usr/bin/env bash
# Tests for volume-layout.sh on throwaway folders (never a real volume).
#   bash docker/test-volume-layout.sh
# Needs Linux semantics (real symlinks, inode numbers): run it in the image,
# on a Pod, or any Linux box. Exits non-zero on the first failed check.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/volume-layout.sh"
LAYOUT_QUIET_POLL=1   # do not wait a minute between "is the old Pod quiet?" checks

PASS=0
check() { if eval "$2"; then PASS=$((PASS + 1)); else echo "FAIL: $1"; echo "      ($2)"; exit 1; fi; }
inode() { stat -c %i "$1"; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A volume as the previous image left it.
make_old_volume() {
    local v="$1"
    mkdir -p "$v"/comfyq/{data,lanes/l1,workflows/wf} "$v"/comfyui/{models/checkpoints,input,output,user/default,comfyq_ingredients/j1} \
             "$v"/assets "$v"/_model_quarantine/batch1
    echo '{"auth":{}}' > "$v/comfyq/config.json"
    echo db > "$v/comfyq/data/comfyq.sqlite"
    echo wf > "$v/comfyq/workflows/wf/wf.meta.json"
    echo w > "$v/comfyui/models/checkpoints/big.safetensors"
    echo i > "$v/comfyui/input/in.png"
    echo o > "$v/comfyui/output/out.png"
    echo a > "$v/assets/a.png"
    echo q > "$v/_model_quarantine/batch1/q.safetensors"
    find "$v" -exec touch -d '20 minutes ago' {} +
}

run_init() { ( DATA="$1"; COMFYQ_POD_ID="$2"; unset RUNPOD_POD_ID; layout_init ) ; }

# ---- pod id -------------------------------------------------------------------
check 'the RunPod id is used'               '[[ "$(unset COMFYQ_POD_ID; RUNPOD_POD_ID=abc123 layout_pod_id)" == abc123 ]]'
check 'outside RunPod it is one fixed name' '[[ "$(unset COMFYQ_POD_ID RUNPOD_POD_ID; layout_pod_id)" == default ]]'
check 'unsafe characters are replaced'      '[[ "$(COMFYQ_POD_ID="a/b c.." layout_pod_id)" == a_b_c__ ]]'

# ---- a fresh volume -------------------------------------------------------------
V="$TMP/fresh"; mkdir -p "$V"
run_init "$V" p1 > "$TMP/fresh.log"
check 'fresh: the shared folders exist'       '[[ -d $V/shared/models && -d $V/shared/assets && -d $V/shared/_model_quarantine && -d $V/shared/pods ]]'
check 'fresh: the Pod has its own folders'    '[[ -d $V/pods/p1/data && -d $V/pods/p1/workflows && -d $V/pods/p1/comfyui/output ]]'
check 'fresh: marked as layout v2, no conversion' '[[ -f $V/shared/.layout-v2 ]] && grep -q fresh $V/shared/.layout-v2 && ! ls $V/shared/migration-*.log >/dev/null 2>&1'

# ---- converting an old volume -----------------------------------------------------
V="$TMP/old"; make_old_volume "$V"
I_MODEL=$(inode "$V/comfyui/models/checkpoints/big.safetensors")
I_DB=$(inode "$V/comfyq/data/comfyq.sqlite")
run_init "$V" podA > "$TMP/old.log"
check 'old: the models moved to shared/models'      '[[ -f $V/shared/models/checkpoints/big.safetensors ]]'
check 'old: MOVED, not copied (same inode)'         '[[ $(inode $V/shared/models/checkpoints/big.safetensors) == $I_MODEL ]]'
check 'old: assets and quarantine are shared'       '[[ -f $V/shared/assets/a.png && -f $V/shared/_model_quarantine/batch1/q.safetensors ]]'
check 'old: the queue became this Pod'"'"'s'        '[[ -f $V/pods/podA/data/comfyq.sqlite && $(inode $V/pods/podA/data/comfyq.sqlite) == $I_DB ]]'
check 'old: config, workflows, lanes went with it'  '[[ -f $V/pods/podA/config.json && -f $V/pods/podA/workflows/wf/wf.meta.json && -d $V/pods/podA/lanes/l1 ]]'
check 'old: uploads, results, ComfyUI user dir'     '[[ -f $V/pods/podA/comfyui/input/in.png && -f $V/pods/podA/comfyui/output/out.png && -d $V/pods/podA/comfyui/user/default && -d $V/pods/podA/comfyui/comfyq_ingredients/j1 ]]'
check 'old: the old folders are gone'               '[[ ! -e $V/comfyq && ! -e $V/assets && ! -e $V/_model_quarantine && ! -e $V/comfyui/input ]]'
check 'old: a link keeps the old models path working' '[[ -L $V/comfyui/models && -f $V/comfyui/models/checkpoints/big.safetensors ]]'
check 'old: the marker names the converting Pod'    'grep -q podA $V/shared/.layout-v2'
check 'old: a log lists what moved'                 '[[ $(cat $V/shared/migration-*.log | grep -c ^moved) -ge 10 ]]'
check 'old: no lock left behind'                    '[[ ! -e $V/.layout-migration.lock ]]'

# ---- a second Pod on the converted volume ------------------------------------------
run_init "$V" podB > "$TMP/second.log"
check 'second Pod: no second conversion'        '[[ $(ls $V/shared/migration-*.log | wc -l) == 1 ]]'
check 'second Pod: gets its own empty folder'   '[[ -d $V/pods/podB/data && -z "$(ls -A $V/pods/podB/data)" ]]'
check 'second Pod: the first Pod is untouched'  '[[ -f $V/pods/podA/data/comfyq.sqlite ]]'
check 'second Pod: sees the shared models'      '[[ -f $V/shared/models/checkpoints/big.safetensors ]]'
run_init "$V" podA > /dev/null
check 'restart: the first Pod finds its queue again' '[[ -f $V/pods/podA/data/comfyq.sqlite ]]'

# ---- a half-finished earlier conversion never overwrites --------------------------------
V="$TMP/partial"; make_old_volume "$V"
mkdir -p "$V/shared/models/checkpoints"; echo NEWER > "$V/shared/models/checkpoints/big.safetensors"
run_init "$V" podA > "$TMP/partial.log"
check 'partial: the newer copy is kept'      'grep -q NEWER $V/shared/models/checkpoints/big.safetensors'
check 'partial: the other one is left, not deleted' '[[ -f $V/comfyui/models/checkpoints/big.safetensors ]]'
check 'partial: and it says so'              'grep -q KEPT $TMP/partial.log'

# ---- two Pods starting at the same moment on an old volume ---------------------------------
V="$TMP/race"; make_old_volume "$V"
run_init "$V" podX > "$TMP/race-x.log" & run_init "$V" podY > "$TMP/race-y.log" & wait
check 'race: exactly one conversion'               '[[ $(ls $V/shared/migration-*.log | wc -l) == 1 ]]'
check 'race: the old state went to exactly one Pod' '[[ $( (ls $V/pods/podX/data/comfyq.sqlite $V/pods/podY/data/comfyq.sqlite 2>/dev/null) | wc -l) == 1 ]]'
check 'race: both Pods have their folders'         '[[ -d $V/pods/podX/data && -d $V/pods/podY/data ]]'

# ---- a Pod still running the old image: wait, do not convert --------------------------------
V="$TMP/busy"; make_old_volume "$V"
touch "$V/comfyq/data/comfyq.sqlite"   # written just now
( DATA="$V"; COMFYQ_POD_ID=podN; timeout 4 bash -c "source $HERE/volume-layout.sh; LAYOUT_QUIET_POLL=1; DATA=$V; COMFYQ_POD_ID=podN; layout_init" ) > "$TMP/busy.log" 2>&1
check 'busy: nothing converted while the old Pod writes' '[[ -f $V/comfyq/data/comfyq.sqlite && ! -f $V/shared/.layout-v2 ]]'
check 'busy: it says why it waits'                       'grep -q "still be using this volume" $TMP/busy.log'
touch -d '20 minutes ago' "$V/comfyq/data/comfyq.sqlite"
run_init "$V" podN > "$TMP/busy2.log"   # the same Pod restarting, its lock still there
check 'busy: converts once the old Pod has gone quiet'   '[[ -f $V/shared/.layout-v2 && -f $V/pods/podN/data/comfyq.sqlite ]]'
check 'busy: its own lock from the interrupted start is taken back' 'grep -q "taking back" $TMP/busy2.log'

# ---- a conversion lock left by a Pod that died ----------------------------------------------
V="$TMP/stale"; make_old_volume "$V"
echo "deadpod $(( $(date +%s) - 2000 ))" > "$V/.layout-migration.lock"
run_init "$V" podS > "$TMP/stale.log"
check 'stale lock: taken over and the conversion completes' '[[ -f $V/shared/.layout-v2 && -f $V/pods/podS/data/comfyq.sqlite ]]'
check 'stale lock: and it says so'                          'grep -q "taking it over" $TMP/stale.log'

echo "volume layout: $PASS checks passed"
