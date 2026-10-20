// RunPod + ComfyQ helpers shared by the command line (runpod.mjs) and the
// local console (console/server.mjs). Node's own fetch, no dependency.
//
// REST (https://rest.runpod.io/v1) for Pods and network volumes; GraphQL
// (https://api.runpod.io/graphql) only for GPU types, prices and stock, which
// the REST API does not expose.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// The two URL overrides exist for testing against a stand-in RunPod.
export const REST = process.env.RUNPOD_REST_URL || 'https://rest.runpod.io/v1';
export const GRAPHQL = process.env.RUNPOD_GRAPHQL_URL || 'https://api.runpod.io/graphql';
export const DEFAULT_IMAGE = 'ghcr.io/urbandronedesign/comfyq:latest';
export const PORT = 3000;
// The image is built on CUDA 12.8, so the host's driver must support 12.8 or
// later. Without this a Pod can land on a machine whose driver is older and
// fail at the first CUDA call.
export const CUDA_VERSIONS = ['12.8', '12.9', '13.0'];
// What a card keeps free beyond a workflow's measured peak: the CUDA context,
// ComfyUI itself, and the run-to-run spread seen on the rigs (~1.5 GB).
export const HEADROOM_GB = 2;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export class RunPodError extends Error {
    constructor(message, status) { super(message); this.status = status; }
}

export async function rest(apiKey, method, route, body) {
    if (!apiKey) throw new RunPodError('no RunPod API key', 401);
    const res = await fetch(REST + route, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
        const detail = typeof data === 'string' ? data : (data?.error || data?.message || (data ? JSON.stringify(data) : ''));
        const hint = res.status === 401 ? 'the API key is wrong, or has no write access'
            : res.status === 403 ? 'the API key is not allowed to do this' : '';
        throw new RunPodError(`RunPod refused ${method} ${route} (${res.status})${[detail, hint].filter(Boolean).map(x => ': ' + x).join('')}`, res.status);
    }
    return data;
}

export async function graphql(apiKey, query) {
    if (!apiKey) throw new RunPodError('no RunPod API key', 401);
    const res = await fetch(`${GRAPHQL}?api_key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.errors?.length) {
        const why = data?.errors?.map(e => e.message).join('; ') || (res.status === 401 ? 'the API key is wrong' : `HTTP ${res.status}`);
        throw new RunPodError(`RunPod GPU list: ${why}`, res.ok ? 502 : res.status);
    }
    return data.data;
}

/**
 * GPU types with VRAM, price and stock. Asks for stock in one data centre when
 * given one (the one the network volume is in), and degrades step by step if
 * the API rejects a field, so a schema change costs detail, not the list.
 */
export async function gpuTypes(apiKey, { dataCenterId, secureCloud = true } = {}) {
    const lp = (dc) => `lowestPrice(input: { gpuCount: 1, secureCloud: ${secureCloud}${dc ? `, dataCenterId: "${dc}"` : ''} }) { uninterruptablePrice stockStatus }`;
    const attempts = [
        { q: `id displayName memoryInGb secureCloud communityCloud securePrice communityPrice ${lp(dataCenterId)}`, scoped: !!dataCenterId },
        { q: `id displayName memoryInGb secureCloud communityCloud ${lp(null)}`, scoped: false },
        { q: 'id displayName memoryInGb', scoped: false },
    ];
    let lastErr;
    for (const a of attempts) {
        try {
            const d = await graphql(apiKey, `query { gpuTypes { ${a.q} } }`);
            return {
                scopedToDataCenter: a.scoped,
                // The image is built on NVIDIA CUDA, so an AMD card cannot run it.
                gpus: (d.gpuTypes || []).filter(g => !/^AMD /i.test(g.id || '')).map(g => ({
                    id: g.id,
                    name: g.displayName || g.id,
                    vramGb: g.memoryInGb || 0,
                    secureCloud: g.secureCloud !== false,
                    communityCloud: g.communityCloud !== false,
                    pricePerHr: g.lowestPrice?.uninterruptablePrice
                        ?? (secureCloud ? g.securePrice : g.communityPrice) ?? null,
                    // ★ Asked about ONE data centre, RunPod gives no stockStatus
                    //   at all for a GPU it has none of there. Read as "unknown",
                    //   that recommended a GPU the data centre did not have, and
                    //   the Pod was refused ("could not find any pods with
                    //   required specifications"). Scoped, no answer means none.
                    stock: g.lowestPrice?.stockStatus ?? (a.scoped ? 'None' : null),
                })),
            };
        } catch (e) { lastErr = e; }
    }
    throw lastErr;
}

/**
 * Is this RunPod error "no free machine matches right now" (worth retrying, or
 * picking more GPUs) rather than a real fault? RunPod words it at least three
 * ways, all seen on 2026-10-19 in EU-RO-1.
 */
export const isNoMachine = (message) =>
    /required specifications|requested specifications|instances available|does not have the resources|try a different machine|no.*available|insufficient/i.test(String(message || ''));

/**
 * One student page per workflow served. A tab books only the workflow its
 * address names (?workflow=<id>); without it, the first one. So with two or
 * more, each needs its own link or the others cannot be reached.
 */
export const studentLinks = (base, ids = []) =>
    ids.map((id, i) => ({ id, main: i === 0, url: `${base}/user?workflow=${encodeURIComponent(id)}` }));

export const proxyUrl = (podId, port = PORT) => process.env.COMFYQ_POD_PROXY
    ? process.env.COMFYQ_POD_PROXY.replace('{id}', podId).replace('{port}', port)
    : `https://${podId}-${port}.proxy.runpod.net`;

/** GET a JSON route on ComfyQ at `base` (a Pod's proxy or another host); null while it is not answering. */
export async function urlGet(base, route) {
    try {
        const res = await fetch(base + route, { signal: AbortSignal.timeout(12000) });
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

/** GET a JSON route on a Pod through RunPod's proxy; null while it is not answering. */
export const podGet = (podId, route) => urlGet(proxyUrl(podId), route);

/** What ComfyQ at `base` is doing: its snapshot and the boot plan, either may be null. */
export async function probeUrl(base) {
    const [self, planRes] = await Promise.all([urlGet(base, '/federation/self'), urlGet(base, '/admin/pod-plan')]);
    return {
        answering: !!self,
        mode: self?.mode || null,
        gpu: self?.gpu || null,
        served: (self?.servedWorkflows || []).map(w => ({ id: w.id, name: w.name, busy: !!w.busy })),
        jobs: self?.jobs || null,
        usage: self?.usage || null,
        plan: planRes?.plan || null,
    };
}

/** What ComfyQ on a Pod is doing. */
export const podProbe = (podId) => probeUrl(proxyUrl(podId));

export async function findVolume(apiKey, ref) {
    const vols = await rest(apiKey, 'GET', '/networkvolumes');
    const byId = vols.find(v => v.id === ref);
    if (byId) return byId;
    const named = vols.filter(v => v.name === ref);
    if (named.length === 1) return named[0];
    if (named.length > 1) throw new RunPodError(`${named.length} network volumes are called "${ref}" — use its id`);
    throw new RunPodError(`no network volume "${ref}". Yours: ${vols.map(v => `${v.name} (${v.id}, ${v.dataCenterId})`).join(', ') || 'none'}`);
}

/**
 * The body for POST /pods. `secrets` holds the passwords and token, which go
 * into the Pod's environment for the image to apply at boot.
 */
export function podBody({ volume, gpuTypeIds, serve = [], secrets = {}, name, image, diskGb = 30, podVolumeGb = 80, community = false, fetchModels = true, syncWorkflows = false, allowOpen = false }) {
    const env = {};
    if (secrets.adminPassword) env.COMFYQ_ADMIN_PASSWORD = secrets.adminPassword;
    if (secrets.accessPassword) env.COMFYQ_ACCESS_PASSWORD = secrets.accessPassword;
    if (secrets.hfToken) env.COMFYQ_HF_TOKEN = secrets.hfToken;
    if (serve.length) env.COMFYQ_SERVE = serve.join(',');
    if (!fetchModels) env.COMFYQ_FETCH_MODELS = '0';
    if (syncWorkflows) env.COMFYQ_SYNC_WORKFLOWS = '1';
    if (allowOpen) env.COMFYQ_ALLOW_OPEN = '1';
    return {
        name: (name || `comfyq-${serve[0] || 'admin'}`).slice(0, 191),
        imageName: image || DEFAULT_IMAGE,
        gpuTypeIds,
        gpuCount: 1,
        cloudType: community ? 'COMMUNITY' : 'SECURE',
        volumeMountPath: '/workspace',
        ...(volume ? {
            networkVolumeId: volume.id,
            // The volume lives in one data centre, so the GPU has to be there too.
            dataCenterIds: [volume.dataCenterId],
        } : {
            // ★ No network volume: RunPod may place the Pod in ANY data centre
            //   with the GPU free — the fallback when the volume's own data
            //   centre has none. /workspace is then the Pod's own volume: it
            //   survives Stop/Start but not Terminate, and the models are
            //   downloaded onto it at the first boot.
            volumeInGb: Number(podVolumeGb) || 80,
        }),
        allowedCudaVersions: CUDA_VERSIONS,
        containerDiskInGb: Number(diskGb) || 30,
        ports: [`${PORT}/http`, '8188/http'],
        env,
    };
}

/**
 * The passwords a Pod needs before it will serve; empty when none is missing.
 * Only the admin one: without the student access password anyone with the
 * link can book jobs, which is allowed — without the admin one they could
 * also run the admin panel.
 */
export function missingSecrets(secrets) {
    return secrets.adminPassword ? [] : ['admin password'];
}

/**
 * The image a Pod runs. ★ RunPod's REST API calls it `imageName` (as in the
 * create body), not `image` — reading `image` found nothing on a real account,
 * which a stand-in RunPod using `image` could not reveal.
 */
export const podImage = (p) => p?.imageName || p?.image || null;

/** The Pods RUNNING on a network volume, other than `exceptId`. (RunPod reports a Pod's volume as `networkVolumeId`.) */
export function runningOnVolume(pods, volumeId, exceptId = null) {
    return (pods || []).filter(p => p.desiredStatus === 'RUNNING'
        && (p.networkVolumeId || p.networkVolume?.id) === volumeId && p.id !== exceptId);
}

/**
 * May another Pod join the ones running on this volume?
 *
 * ★ Only if every one of them answers /admin/volume-pods. That route came with
 *   the volume-wide download lock and the prune guards (Phase I, I3/I4); a Pod
 *   on an older image has neither, so two Pods missing the same model would
 *   write the same file. A Pod still booting cannot answer yet either: wait —
 *   unless it boots the SAME image as the one joining (`image`). Then both
 *   carry the same code, and if that code shares safely, so do they. That is
 *   what lets several Pods be launched or started together on purpose instead
 *   of one at a time. A Pod that answers but lacks the route still blocks,
 *   whatever its tag says: the tag `latest` may have been pulled weeks ago.
 *   Returns the Pods that block, each with the reason.
 */
export async function shareBlockers(busy, { image = null } = {}) {
    const out = [];
    for (const p of busy) {
        const r = await podGet(p.id, '/admin/volume-pods');
        if (r?.sharedReady) continue;
        // No answer on that route: an older image answers its other routes,
        // a Pod still starting answers none. They need different advice —
        // waiting never fixes the first.
        const alive = r || await podGet(p.id, '/federation/self');
        if (!alive && image && podImage(p) === image) continue;
        out.push({ pod: p, why: alive
            ? 'runs an image too old to share a volume — stop it, or restart it to get the new image'
            : 'is not answering yet (still starting?) — wait until it is up, or start it together with this one on the same image' });
    }
    return out;
}

// ---- several Pods on one volume -------------------------------------------------

/**
 * Pods grouped by the network volume they use, each group with how many run
 * and what they cost together per hour. Pods take the shape the console sends
 * the page (`networkVolume: {id, name}`). Groups by name; Pods with no volume last.
 */
export function volumeGroups(pods) {
    const groups = new Map();
    for (const p of pods || []) {
        const v = p.networkVolume || null;
        const key = v?.id || '';
        if (!groups.has(key)) groups.set(key, { volume: v, pods: [], running: 0, costPerHr: 0 });
        const g = groups.get(key);
        g.pods.push(p);
        if (p.desiredStatus === 'RUNNING') {
            g.running++;
            g.costPerHr += Number(p.costPerHr) || 0;
        }
    }
    return [...groups.values()]
        .map(g => ({ ...g, costPerHr: +g.costPerHr.toFixed(3) }))
        .sort((a, b) => (!a.volume) - (!b.volume) || String(a.volume?.name).localeCompare(String(b.volume?.name)));
}

/**
 * Which build each Pod on a volume runs, from their /admin/volume-pods answers.
 * A Pod states its own build (`image`, images after 2026-10-19) and lists the
 * others' from their heartbeats, so even a Pod too old to state its own is
 * known through a neighbour. `answers` is [{ podId, r }]; returns
 * { builds: {podId: sha|null}, distinct: [sha…] }.
 */
export function buildsOf(answers) {
    const builds = {};
    for (const { podId, r } of answers) {
        if (!(podId in builds)) builds[podId] = null;
        if (r?.image) builds[podId] = r.image;
        for (const o of r?.others || []) if (o?.id && o.image) builds[o.id] = o.image;
    }
    // A heartbeat may name a Pod RunPod no longer lists as running: drop it.
    const ids = new Set(answers.map(a => a.podId));
    for (const id of Object.keys(builds)) if (!ids.has(id)) delete builds[id];
    const distinct = [...new Set(Object.values(builds).filter(Boolean))];
    return { builds, distinct };
}

export async function volumeBuilds(podIds) {
    const answers = await Promise.all(podIds.map(async podId => ({ podId, r: await podGet(podId, '/admin/volume-pods') })));
    return buildsOf(answers);
}

export const cannotShare = (blockers, volumeName) =>
    `Another Pod cannot join the volume "${volumeName}" yet: `
    + blockers.map(b => `"${b.pod.name}" (${b.pod.id}) ${b.why}`).join('; ') + '.';

// ---- workflows ----------------------------------------------------------------

/**
 * The workflow bundles in this checkout, with what they need from a GPU.
 * Read straight from the folders (no server modules), so the console runs
 * without `npm install`. The image serves the bundles it was built from, so a
 * bundle added here after the last image build will not be on the Pod.
 */
// The desktop app points these at its copy (fetched from GitHub, or the one it
// ships with); run from the repo they are the repo's own files.
const WORKFLOWS_DIR = process.env.COMFYQ_WORKFLOWS_DIR || path.join(REPO, 'workflows');
const DOWNLOADS_FILE = process.env.COMFYQ_DOWNLOADS_FILE || path.join(REPO, 'tools', 'model-provenance', 'workflow-downloads.json');

export function listWorkflows(dir = WORKFLOWS_DIR) {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of names) {
        if (!e.isDirectory() || e.name.startsWith('_')) continue;
        const id = e.name;
        const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, id, f), 'utf8')); } catch { return null; } };
        const meta = read(`${id}.meta.json`);
        if (!meta) continue;
        const runtime = read(`${id}.runtime.json`);
        const measured = Number(runtime?.vramPeakGb) || null;
        const minVram = Number(meta.requirements?.minVRAM) || null;
        out.push({
            id,
            name: meta.name || id,
            category: meta.category || null,
            description: String(meta.description || '').split('\n')[0].slice(0, 220),
            experimental: meta.experimental === true,
            // Measured on a card during calibration beats the hand-written
            // minimum, which is a floor somebody guessed.
            vramGb: measured || minVram,
            vramSource: measured ? 'measured' : (minVram ? 'stated minimum' : 'unknown'),
            warmSec: Number(runtime?.estimatedDurationSec || meta.estimatedDurationSec) || null,
            models: (meta.requirements?.models || []).length,
            gated: (meta.requirements?.models || []).some(m => /black-forest-labs|Lightricks\/LTX-2\.5/i.test(String(m?.url || m?.source || ''))),
        });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * VRAM the chosen workflows need together. One lane: its peak. Several: they
 * are resident at once, so the peaks add up.
 */
export function vramNeeded(workflows) {
    const known = workflows.filter(w => w.vramGb);
    const unknown = workflows.filter(w => !w.vramGb).map(w => w.id);
    const sum = known.reduce((s, w) => s + w.vramGb, 0);
    return { gb: known.length ? +(sum + HEADROOM_GB).toFixed(1) : null, unknown };
}

/**
 * Rank GPUs for a VRAM need: enough memory, in stock, cheapest first. The
 * first fitting, available one is the recommendation.
 */
// RunPod's GPU list (GraphQL) names cards its Pod-create call (REST) refuses —
// MIG slices, some "Server Edition"s. One of them among the fallbacks made the
// whole create fail with a schema error (2026-10-20). RunPod's refusal lists the
// ids it accepts; read them out of it.
export function acceptedGpuIds(errorText) {
    const m = String(errorText || '').match(/gpuTypeIds\/items\/enum: value must be one of ([^"\]]+)/);
    if (!m) return null;
    const ids = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
    return ids.length ? ids : null;
}

export function rankGpus(gpus, needGb, { community = false, accepted = null } = {}) {
    const ok = accepted ? new Set(accepted) : null;
    const rows = gpus
        .filter(g => (community ? g.communityCloud : g.secureCloud))
        .map(g => ({
            ...g,
            fits: needGb == null ? null : g.vramGb >= needGb,
            // A card the create call refuses cannot be launched, whatever its stock.
            launchable: ok ? ok.has(g.id) : null,
            available: ok && !ok.has(g.id) ? false : g.stock == null ? null : g.stock !== 'None',
        }));
    const score = (g) => [
        g.fits === false ? 1 : 0,
        g.available === false ? 1 : 0,
        g.pricePerHr == null ? 1 : 0,
        g.pricePerHr ?? 0,
        g.vramGb,
    ];
    rows.sort((a, b) => {
        const x = score(a), y = score(b);
        for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
        return 0;
    });
    const rec = rows.find(g => g.fits !== false && g.available !== false && g.pricePerHr != null);
    return { rows, recommended: rec ? rec.id : null };
}

// ---- disk for a fresh machine ---------------------------------------------------
// What the chosen workflows download on a machine that has nothing yet, from
// tools/model-provenance/workflow-downloads.json (written by fresh-machine.cjs
// --online --write-sizes, from real HEAD requests). A file two workflows share
// is counted once.
//
// The disk also holds the Docker image: 10 GB compressed, so about 35 GB while it
// is pulled and unpacked. Plus room for results and the downloader's 2 GB margin.
export const IMAGE_DISK_GB = 40;
export const RESULTS_DISK_GB = 15;

export function downloadNeed(ids, file = DOWNLOADS_FILE) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { gb: null, files: 0, unknown: [...ids], failing: [], byNodePack: [], generatedAt: null }; }
    const names = new Set(), unknown = [], failing = [], byNodePack = new Set();
    for (const id of ids) {
        const w = data.workflows?.[id];
        if (!w) { unknown.push(id); continue; }
        if (w.problems) failing.push(id);
        for (const f of w.files || []) names.add(f);
        for (const f of w.byNodePack || []) byNodePack.add(f);
    }
    let bytes = 0, unsized = 0;
    for (const n of names) { const b = data.sizes?.[n]; if (b) bytes += b; else unsized++; }
    return { gb: +(bytes / 1e9).toFixed(1), files: names.size, unsized, unknown, failing, byNodePack: [...byNodePack], generatedAt: data.generatedAt || null };
}

/** The smallest disk (GB) that holds the image, these downloads and some results. */
export function diskNeeded(downloadGb) {
    return Math.ceil(IMAGE_DISK_GB + (downloadGb || 0) * 1.05 + RESULTS_DISK_GB);
}
