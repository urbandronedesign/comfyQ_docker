#!/usr/bin/env bash
# Tests for tunnel.sh with a fake cloudflared (never a real tunnel).
#   bash docker/test-tunnel.sh
# Runs anywhere bash does (also git-bash on Windows). Exits non-zero on a failure.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/tunnel.sh"

PASS=0
check() { if eval "$2"; then PASS=$((PASS + 1)); else echo "FAIL: $1"; echo "      ($2)"; exit 1; fi; }
TMP="$(mktemp -d)"
cleanup() { kill $(jobs -p) 2>/dev/null; pkill -f "$TMP/fake-cloudflared" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT
wait_for() { for _ in $(seq 1 50); do eval "$1" && return 0; sleep 0.1; done; return 1; }

# A fake cloudflared: prints what the real one prints (the address inside a box
# of log lines), stays up until $TMP/stop exists, then exits. Each start gets a
# new address, as a real quick tunnel does.
cat > "$TMP/fake-cloudflared" <<'FAKE'
#!/usr/bin/env bash
dir="$(dirname "$0")"
n=$(( $(cat "$dir/starts" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$dir/starts"
echo "$*" > "$dir/args"
echo "2026-10-21T13:00:00Z INF Requesting new quick Tunnel on trycloudflare.com..."
echo "2026-10-21T13:00:01Z INF +--------------------------------------------------------------------------------------------+"
echo "2026-10-21T13:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |"
echo "2026-10-21T13:00:01Z INF |  https://lime-cat-river-$n.trycloudflare.com                                                |"
echo "2026-10-21T13:00:01Z INF +--------------------------------------------------------------------------------------------+"
echo "2026-10-21T13:00:02Z INF Registered tunnel connection connIndex=0 location=cdg01 protocol=quic"
while [[ ! -f "$dir/stop" ]]; do sleep 0.1; done
rm -f "$dir/stop"
FAKE
chmod +x "$TMP/fake-cloudflared"

URL_FILE="$TMP/public-url"
export CLOUDFLARED="$TMP/fake-cloudflared" TUNNEL_LOG="$TMP/cloudflared.log" TUNNEL_RETRY_SEC=0.2

# ---- no cloudflared: says so, writes nothing, does not fail the start ----
out="$(CLOUDFLARED="$TMP/missing" start_quick_tunnel http://127.0.0.1:3000 "$URL_FILE")"
check "without cloudflared it says so" '[[ "$out" == *"not in this image"* ]]'
check "without cloudflared no address file" '[[ ! -f "$URL_FILE" ]]'

# ---- started: the address it prints is written for ComfyQ to report ----
echo stale > "$URL_FILE"
start_quick_tunnel http://127.0.0.1:3000 "$URL_FILE" > "$TMP/out.txt"
check "an address left from a previous start is cleared at once" '[[ ! -f "$URL_FILE" ]] || [[ "$(cat "$URL_FILE")" != stale ]]'
wait_for '[[ -s "$URL_FILE" ]]'
check "the https address is written (got: $(cat "$URL_FILE" 2>/dev/null))" '[[ "$(cat "$URL_FILE")" == "https://lime-cat-river-1.trycloudflare.com" ]]'
check "only the address, nothing else, on one line" '[[ $(wc -l < "$URL_FILE") -eq 1 ]]'
check "cloudflared points at ComfyQ, without auto-update" '[[ "$(cat "$TMP/args")" == "tunnel --no-autoupdate --url http://127.0.0.1:3000" ]]'
check "its output is kept in the log" 'grep -q "Registered tunnel connection" "$TMP/cloudflared.log"'
wait_for 'grep -q "public https address" "$TMP/out.txt"'
check "the address is announced in the container log" 'grep -q "public https address: https://lime-cat-river-1.trycloudflare.com" "$TMP/out.txt"'

# ---- cloudflared stops: the old address goes, a new tunnel comes up ----
touch "$TMP/stop"
wait_for '[[ "$(cat "$TMP/starts" 2>/dev/null)" == 2 ]]'
check "a stopped tunnel is started again" '[[ "$(cat "$TMP/starts")" == 2 ]]'
wait_for '[[ "$(cat "$URL_FILE" 2>/dev/null)" == "https://lime-cat-river-2.trycloudflare.com" ]]'
check "and its new address replaces the old one" '[[ "$(cat "$URL_FILE")" == "https://lime-cat-river-2.trycloudflare.com" ]]'
check "the restart is said, with the warning that the address changes" 'grep -q "the address will change" "$TMP/out.txt"'

echo "tunnel: $PASS checks passed"
