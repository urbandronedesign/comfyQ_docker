#!/usr/bin/env bash
# Clone every node pack listed in custom-nodes.txt into ComfyUI/custom_nodes and
# install its Python requirements. Runs at image build time.
#
#   install-nodes.sh <list> <custom_nodes dir> <python>
#
# Every pip call goes through constraints.txt so a pack cannot replace the
# pinned torch build, and onnxruntime is forced back to the GPU wheel at the
# end: a pack that pulls the CPU wheel silently moves DWPose onto the CPU.
set -euo pipefail

LIST="$1"; DEST="$2"; PY="$3"
CONSTRAINTS="$(dirname "$0")/constraints.txt"
MANIFEST="$DEST/.comfyq-packs.txt"
mkdir -p "$DEST"; : > "$MANIFEST"

grep -vE '^\s*(#|$)' "$LIST" | while read -r entry; do
    url="${entry%@*}"; ref=""
    [[ "$entry" == *@* ]] && ref="${entry##*@}"
    name="$(basename "$url" .git)"
    echo "==> $name ${ref:+@ $ref}"
    git clone --quiet "$url" "$DEST/$name"
    if [[ -n "$ref" ]]; then
        git -C "$DEST/$name" fetch --quiet --depth 1 origin "$ref" || true
        git -C "$DEST/$name" checkout --quiet "$ref"
    fi
    if [[ -f "$DEST/$name/requirements.txt" ]]; then
        "$PY" -m pip install --no-cache-dir -c "$CONSTRAINTS" -r "$DEST/$name/requirements.txt"
    fi
    echo "$name $url $(git -C "$DEST/$name" rev-parse --short HEAD)" >> "$MANIFEST"
done

"$PY" -m pip uninstall -y onnxruntime >/dev/null 2>&1 || true
# The two wheels share one onnxruntime/ directory, so removing the CPU one
# deletes files the GPU one needs: reinstall it in place, then let pip fill in
# any dependency the CPU wheel had been providing.
"$PY" -m pip install --no-cache-dir -c "$CONSTRAINTS" --force-reinstall --no-deps onnxruntime-gpu
"$PY" -m pip install --no-cache-dir -c "$CONSTRAINTS" onnxruntime-gpu

echo "Installed packs (name url commit):"; cat "$MANIFEST"
