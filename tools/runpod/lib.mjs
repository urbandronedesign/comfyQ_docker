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
                gpus: (d.gpuTypes || []).map(g => ({
                    id: g.id,
                    name: g.displayName || g.id,
                    vramGb: g.memoryInGb || 0,
                    secureCloud: g.secureCloud !== false,
                    communityCloud: g.communityCloud !== false,
                    pricePerHr: g.lowestPrice?.uninterruptablePrice
                        ?? (secureCloud ? g.securePrice : g.communityPrice) ?? null,
                    stock: g.lowestPrice?.stockStatus ?? null,
                })),
            };
        } catch (e) { lastErr = e; }
    }
    throw lastErr;
}

export const proxyUrl = (podId, port = PORT) => process.env.COMFYQ_POD_PROXY
    ? process.env.COMFYQ_POD_PROXY.replace('{id}', podId).replace('{port}', port)
    : `https://${podId}-${port}.proxy.runpod.net`;

/** GET a JSON route on a Pod through RunPod's proxy; null while it is not answering. */
export async function podGet(podId, route) {
    try {
        const res = await fetch(proxyUrl(podId) + route, { signal: AbortSignal.timeout(12000) });
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

/** What ComfyQ on a Pod is doing: its snapshot and the boot plan, either may be null. */
export async function podProbe(podId) {
    const [self, planRes] = await Promise.all([podGet(podId, '/federation/self'), podGet(podId, '/admin/pod-plan')]);
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
export function podBody({ volume, gpuTypeIds, serve = [], secrets = {}, name, image, diskGb = 30, community = false, fetchModels = true, syncWorkflows = false, allowOpen = false }) {
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
        networkVolumeId: volume.id,
        volumeMountPath: '/workspace',
        // The volume lives in one data centre, so the GPU has to be there too.
        dataCenterIds: [volume.dataCenterId],
        allowedCudaVersions: CUDA_VERSIONS,
        containerDiskInGb: Number(diskGb) || 30,
        ports: [`${PORT}/http`, '8188/http'],
        env,
    };
}

/** The passwords a Pod needs before it will serve; empty when none is missing. */
export function missingSecrets(secrets) {
    const out = [];
    if (!secrets.adminPassword) out.push('admin password');
    if (!secrets.accessPassword) out.push('student access password');
    return out;
}

// ---- workflows ----------------------------------------------------------------

/**
 * The workflow bundles in this checkout, with what they need from a GPU.
 * Read straight from the folders (no server modules), so the console runs
 * without `npm install`. The image serves the bundles it was built from, so a
 * bundle added here after the last image build will not be on the Pod.
 */
export function listWorkflows(dir = path.join(REPO, 'workflows')) {
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
export function rankGpus(gpus, needGb, { community = false } = {}) {
    const rows = gpus
        .filter(g => (community ? g.communityCloud : g.secureCloud))
        .map(g => ({
            ...g,
            fits: needGb == null ? null : g.vramGb >= needGb,
            available: g.stock == null ? null : g.stock !== 'None',
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
