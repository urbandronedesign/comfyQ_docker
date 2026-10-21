# Cloudflare quick tunnel to ComfyQ (sourced by entrypoint.sh; tested by
# test-tunnel.sh). For providers that only give a raw ip:port (Vast.ai): school
# firewalls often block a random high port and plain http, so the container
# opens https://<random>.trycloudflare.com on port 443 instead. No Cloudflare
# account and no domain: Cloudflare's "quick tunnel" (testing grade, no uptime
# guarantee, up to 200 requests in flight).
#
# start_quick_tunnel <local url> <file>
#   Runs in the background; keeps cloudflared up (restarting it after 5 s if it
#   stops) and writes the https address it prints into <file>, which ComfyQ
#   reports as publicUrl in /federation/self. The address changes only when the
#   tunnel itself restarts. CLOUDFLARED (default: cloudflared) is the binary.

start_quick_tunnel() {
    local target="$1" url_file="$2" bin="${CLOUDFLARED:-cloudflared}"
    rm -f "$url_file"
    if ! command -v "$bin" >/dev/null 2>&1; then
        echo "[tunnel] COMFYQ_TUNNEL=quick but cloudflared is not in this image — no https address"
        return 0
    fi
    (
        set +e
        while true; do
            rm -f "$url_file"
            "$bin" tunnel --no-autoupdate --url "$target" 2>&1 | while IFS= read -r line; do
                echo "$line" >> "${TUNNEL_LOG:-/tmp/cloudflared.log}"
                if [[ $line =~ (https://[a-z0-9-]+\.trycloudflare\.com) ]]; then
                    echo "${BASH_REMATCH[1]}" > "$url_file"
                    echo "[tunnel] public https address: ${BASH_REMATCH[1]}"
                fi
            done
            rm -f "$url_file"
            echo "[tunnel] cloudflared stopped — restarting it in ${TUNNEL_RETRY_SEC:-5} s (the address will change)"
            sleep "${TUNNEL_RETRY_SEC:-5}"
        done
    ) &
}
