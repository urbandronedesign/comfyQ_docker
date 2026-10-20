// Thunder Compute, the backup GPU provider: its REST API, used by the console.
// (node tools/runpod/thunder.test.mjs)
//
// Thunder rents RTX A6000 / L40 / A100 / H100 instances in North America and
// gives each forwarded port an HTTPS address, like RunPod's proxy. Its API
// lives at https://api.thundercompute.com:8443 (docs: thundercompute.com/docs).
// Prices, specs and availability need no key; instances do.

import { spawn } from 'child_process';
import { RunPodError, PORT } from './lib.mjs';

// Read on every call, so a test can point it at a local stand-in.
const base = () => (process.env.THUNDER_API_URL || 'https://api.thundercompute.com:8443').replace(/\/$/, '');

export async function thunder(apiKey, method, route, body) {
    if (apiKey === '') throw new RunPodError('no Thunder Compute API key', 401);
    const res = await fetch(base() + route, {
        method,
        headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
        const detail = typeof data === 'string' ? data : (data?.message || data?.error || (data ? JSON.stringify(data) : ''));
        const hint = res.status === 401 ? 'the API key is wrong or has been revoked' : '';
        throw new RunPodError(`Thunder Compute refused ${method} ${route} (${res.status})${[detail, hint].filter(Boolean).map(x => ': ' + x).join('')}`, res.status);
    }
    return data;
}

// One row per single-GPU configuration, cheapest first.
//
// ★ Thunder publishes availability twice and the two can disagree: on
//   2026-10-20 `specs.a6000_x1` said "unavailable" while `gpu_type.a6000["1"]`
//   said "available". Neither is documented as the authority, so a row where
//   they disagree reads as unclear rather than picking the hopeful one.
export function normalizeOffers({ specs = {}, pricing = {}, status = {} }) {
    const rows = [];
    for (const [key, s] of Object.entries(specs)) {
        if (s?.gpuCount !== 1) continue;
        const type = key.replace(/_x\d+$/, '');
        const bySpec = status.specs?.[key];
        const byType = status.gpu_type?.[type]?.['1'];
        const known = [bySpec, byType].filter(v => v === 'available' || v === 'unavailable');
        const availability = !known.length ? 'unknown'
            : known.every(v => v === 'available') ? 'available'
            : known.every(v => v === 'unavailable') ? 'unavailable' : 'unclear';
        const price = pricing[key] ?? pricing[type];
        rows.push({
            id: key,
            name: s.displayName || type,
            vramGb: s.vramGB ?? null,
            // The GPU alone. What an instance really costs adds vCPUs above the
            // included ones and disk above 100 GB: thunderHourly() below.
            pricePerHr: typeof price === 'number' ? price : null,
            availability,
            vcpuOptions: s.vcpuOptions || [],
            includedVcpus: (s.vcpuOptions || [])[0] || 4,
            extraVcpuPerHr: typeof pricing.additional_vcpus === 'number' ? pricing.additional_vcpus : null,
            diskGbPerHr: typeof pricing.disk_gb === 'number' ? pricing.disk_gb : null,
            diskGb: s.storageGB || null,
        });
    }
    return rows.sort((a, b) => (a.pricePerHr ?? Infinity) - (b.pricePerHr ?? Infinity));
}

/**
 * What an instance of this offer costs per hour, by Thunder's own formula
 * (thunder-cli utils/pricing.go CalculateHourlyPrice): the GPU, plus each vCPU
 * above the smallest option, plus each GB of disk above the 100 included.
 * An L40 with 8 vCPU and 200 GB is $0.90/h, not the $0.79 of the GPU alone.
 */
export function thunderHourly(offer, vcpus, diskGb) {
    if (!offer || offer.pricePerHr == null) return null;
    const extraV = Math.max(0, (Number(vcpus) || 0) - (offer.includedVcpus || 4));
    const extraD = Math.max(0, (Number(diskGb) || 0) - 100);
    return +(offer.pricePerHr + extraV * (offer.extraVcpuPerHr || 0) + extraD * (offer.diskGbPerHr || 0)).toFixed(4);
}

export async function thunderOffers() {
    const [specs, pricing, status] = await Promise.all([
        thunder(null, 'GET', '/v2/specs'), thunder(null, 'GET', '/v2/pricing'), thunder(null, 'GET', '/v2/status'),
    ]);
    return normalizeOffers({ specs: specs?.specs, pricing: pricing?.pricing, status });
}

// The instance list comes back as an object keyed by id; the id is only in the key.
// `updateIps` asks Thunder to refresh the addresses, as its CLI does before connecting.
export async function thunderInstances(apiKey, { updateIps = false } = {}) {
    const data = await thunder(apiKey, 'GET', '/v1/instances/list' + (updateIps ? '?update_ips=true' : ''));
    return Object.entries(data || {}).map(([id, v]) => ({ ...v, id: v?.id || id }));
}

// ---- instances ----------------------------------------------------------------
// The calls below are the ones Thunder's own CLI makes (github.com/
// Thunder-Compute/thunder-cli, api/client.go). An instance is addressed by its
// small numeric id (the key in the list), its public address by its uuid.

export const thunderUrl = (uuid, port = PORT) => process.env.COMFYQ_THUNDER_PROXY
    ? process.env.COMFYQ_THUNDER_PROXY.replace('{uuid}', uuid).replace('{port}', port)
    : `https://${uuid}-${port}.thundercompute.net`;

// ★ No public_key is sent: Thunder then makes a key pair and returns the
//   private half once, in `key`, which is what its CLI does too.
export const thunderCreate = (apiKey, { gpuType, vcpus, diskGb }) => thunder(apiKey, 'POST', '/v1/instances/create', {
    cpu_cores: Number(vcpus), template: 'base', gpu_type: gpuType, num_gpus: 1, disk_size_gb: Number(diskGb),
});
export const thunderDelete = (apiKey, id) => thunder(apiKey, 'POST', `/v1/instances/${encodeURIComponent(id)}/delete`);
export const thunderForward = (apiKey, id, ports) => thunder(apiKey, 'PATCH', `/v1/instances/${encodeURIComponent(id)}/ports`, { add_ports: ports });
// A fresh private key for an instance whose key was lost.
export const thunderAddKey = (apiKey, id) => thunder(apiKey, 'POST', `/v1/instances/${encodeURIComponent(id)}/add_key`);

// ---- what runs on the instance ------------------------------------------------

/** The image's environment for one instance (see docker/README.md). */
export function thunderEnv({ podId, serve = [], secrets = {}, fetchModels = true }) {
    const env = { COMFYQ_POD_ID: podId };
    if (secrets.adminPassword) env.COMFYQ_ADMIN_PASSWORD = secrets.adminPassword;
    if (secrets.accessPassword) env.COMFYQ_ACCESS_PASSWORD = secrets.accessPassword;
    if (secrets.hfToken) env.COMFYQ_HF_TOKEN = secrets.hfToken;
    if (serve.length) env.COMFYQ_SERVE = serve.join(',');
    if (!fetchModels) env.COMFYQ_FETCH_MODELS = '0';
    return env;
}

const SAFE_IMAGE = /^[a-z0-9][a-z0-9._/:@-]{2,200}$/i;
const ENV_EOF = 'COMFYQ_ENV_EOF';

/**
 * The bash script the console runs on the instance over SSH (sent on stdin,
 * so the secrets never appear on a command line). Running it twice is safe:
 * it replaces the container and keeps /workspace.
 *
 * ★ Thunder instances are themselves containers with a modified dockerd:
 *   the GPU is passed with `--device nvidia.com/gpu=all` (`--gpus` is not
 *   supported), and a process can outlive its container, so a leftover
 *   ComfyUI is stopped before the new one starts.
 */
export function remoteScript({ image, env }) {
    if (!SAFE_IMAGE.test(image)) throw new RunPodError(`not an image name: ${image}`, 400);
    for (const [k, v] of Object.entries(env)) {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new RunPodError(`bad variable name ${k}`, 400);
        // A docker env-file is one KEY=value per line, taken literally.
        if (/[\r\n]/.test(String(v))) throw new RunPodError(`${k} cannot contain a line break`, 400);
    }
    const envLines = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
    return [
        'set -eu',
        'say() { echo "[comfyq] $*"; }',
        'if docker info >/dev/null 2>&1; then D="docker"; S=""',
        'elif sudo -n docker info >/dev/null 2>&1; then D="sudo -n docker"; S="sudo -n"',
        'else say "Docker does not answer on this instance"; exit 20; fi',
        'WS="$HOME/comfyq-workspace"; ENVF="$HOME/.comfyq.env"',
        'mkdir -p "$WS"',
        `( umask 077; cat > "$ENVF" <<'${ENV_EOF}'`,
        envLines,
        ENV_EOF,
        ')',
        `say "pulling ${image} (several GB the first time)"`,
        `$D pull -q ${image}`,
        '$D rm -f comfyq >/dev/null 2>&1 || true',
        '$S pkill -f /opt/ComfyUI/main.py >/dev/null 2>&1 || true',
        `if $D run --rm --device nvidia.com/gpu=all --entrypoint nvidia-smi ${image} -L; then :`,
        'else say "warning: nvidia-smi inside the container did not list a GPU"; fi',
        `start() { $D run -d --name comfyq --restart unless-stopped --device nvidia.com/gpu=all "$@" -p 3000:3000 -v "$WS:/workspace" --env-file "$ENVF" ${image}; }`,
        'if ! start --shm-size 16g; then',
        '    say "the run with --shm-size failed; trying without it"',
        '    $D rm -f comfyq >/dev/null 2>&1 || true',
        '    start',
        'fi',
        // A container that restarts in a loop still "started": wait, then look.
        'sleep 20',
        `ST="$($D ps -a --filter name=comfyq --format '{{.Status}}')"`,
        'say "container: $ST"',
        'case "$ST" in Up*) ;; *)',
        '    say "the container is not staying up; its last lines:"',
        '    $D logs --tail 40 comfyq 2>&1 | grep -v "failed to set permissions" | tail -8',
        '    exit 21;;',
        'esac',
        'say "started"',
        '',
    ].join('\n');
}

// ---- ssh ----------------------------------------------------------------------

/**
 * Run `bash -s` on the instance with `input` on stdin; resolves with the exit
 * code. COMFYQ_THUNDER_SSH names a stand-in for ssh in tests.
 */
export function runSsh({ ip, port, user, keyFile, knownHosts, input = '', onLine = () => {}, timeoutMs = 60000 }) {
    return new Promise((resolve) => {
        const args = ['-i', keyFile, '-p', String(port || 22),
            '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=30',
            // A new instance has a new host key and may reuse an old IP.
            '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'LogLevel=ERROR',
            `${user}@${ip}`, 'bash -s'];
        const stand = process.env.COMFYQ_THUNDER_SSH;
        const child = stand && /\.m?js$/.test(stand)
            ? spawn(process.execPath, [stand, ...args], { windowsHide: true })
            : spawn(stand || 'ssh', args, { windowsHide: true });
        let buf = '';
        const feed = (chunk) => {
            buf += chunk;
            const lines = buf.split(/\r?\n|\r/);
            buf = lines.pop();
            for (const l of lines) if (l.trim()) onLine(l);
        };
        child.stdout.on('data', feed);
        child.stderr.on('data', feed);
        const timer = setTimeout(() => { onLine('timed out'); child.kill(); }, timeoutMs);
        child.on('error', (e) => { clearTimeout(timer); onLine(`cannot run ssh: ${e.message}`); resolve(-1); });
        child.on('close', (code) => { clearTimeout(timer); if (buf.trim()) onLine(buf); resolve(code ?? -1); });
        child.stdin.on('error', () => {});
        child.stdin.end(input);
    });
}

// ---- setting an instance up -----------------------------------------------------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BOOTING = new Set(['PROVISIONING', 'QUEUED', 'PENDING', 'STARTING', 'RESTORING', 'MODIFYING', 'UNKNOWN']);

/**
 * From a created instance to ComfyQ starting on it: wait until Thunder says
 * RUNNING, log in, run the script, forward port 3000. Progress goes through
 * `step(state, message)`. Throws with a plain message.
 */
export async function setupInstance({ apiKey, id, uuid, keyFile, knownHosts, script, step = () => {},
    list = thunderInstances, ssh = runSsh, forward = thunderForward, wait = sleep,
    bootMs = 20 * 60_000, loginMs = 6 * 60_000, scriptMs = 75 * 60_000, pollMs = 10_000 }) {
    // 1. Thunder brings the instance up.
    step('booting', 'waiting for Thunder to start the instance');
    let inst = null, last = null;
    for (const t0 = Date.now(); ;) {
        inst = (await list(apiKey, { updateIps: true })).find(i => i.uuid === uuid || String(i.id) === String(id));
        if (!inst) throw new RunPodError('the instance is no longer in the account (deleted?)', 404);
        if (inst.status !== last) { step('booting', `Thunder: ${inst.status}`); last = inst.status; }
        if (inst.status === 'RUNNING' && inst.ip) break;
        if (!BOOTING.has(inst.status) && inst.status !== 'RUNNING') throw new RunPodError(`the instance went ${inst.status} instead of RUNNING`, 409);
        if (Date.now() - t0 > bootMs) throw new RunPodError(`the instance was still ${inst.status} after ${Math.round(bootMs / 60000)} min`, 504);
        await wait(pollMs);
    }

    // 2. Log in. Thunder's CLI uses "ubuntu"; root is tried as well.
    step('connecting', `logging in to ${inst.ip}:${inst.port || 22}`);
    let user = null;
    let lastLines = [];
    for (const t0 = Date.now(); !user;) {
        for (const u of ['ubuntu', 'root']) {
            lastLines = [];
            const code = await ssh({ ip: inst.ip, port: inst.port, user: u, keyFile, knownHosts, input: 'true\n', timeoutMs: 45000, onLine: l => lastLines.push(l) });
            if (code === 0) { user = u; break; }
        }
        if (user) break;
        if (Date.now() - t0 > loginMs) throw new RunPodError(`could not log in to the instance: ${lastLines.slice(-2).join(' / ') || 'no answer'}`, 504);
        await wait(pollMs);
    }

    // 3. Start ComfyQ.
    step('installing', `logged in as ${user}; starting ComfyQ (the image pull takes a few minutes)`);
    const out = [];
    const code = await ssh({ ip: inst.ip, port: inst.port, user, keyFile, knownHosts, input: script, timeoutMs: scriptMs,
        onLine: l => { out.push(l); step('installing', l); } });
    if (code !== 0) {
        const why = code === 20 ? 'Docker does not answer on the instance'
            : code === 21 ? `ComfyQ's container keeps stopping: ${out.slice(-4).join(' / ')}`
            : out.slice(-3).join(' / ') || `exit code ${code}`;
        throw new RunPodError(`starting ComfyQ failed: ${why}`, 502);
    }

    // 4. The student address.
    let fwdErr = null;
    for (let i = 0; i < 3; i++) {
        try { await forward(apiKey, inst.id, [PORT]); fwdErr = null; break; }
        catch (e) { fwdErr = e; await wait(5000); }
    }
    if (fwdErr) throw new RunPodError(`ComfyQ started, but port ${PORT} could not be opened: ${fwdErr.message}`, 502);
    step('ready', `ComfyQ is starting at ${thunderUrl(uuid)}`);
    return { user, ip: inst.ip, port: inst.port };
}
