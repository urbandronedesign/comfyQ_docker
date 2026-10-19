// Thunder Compute, the backup GPU provider: its REST API, used by the console.
// (node tools/runpod/thunder.test.mjs)
//
// Thunder rents RTX A6000 / L40 / A100 / H100 instances in North America and
// gives each forwarded port an HTTPS address, like RunPod's proxy. Its API
// lives at https://api.thundercompute.com:8443 (docs: thundercompute.com/docs).
// Prices, specs and availability need no key; instances do.

import { RunPodError } from './lib.mjs';

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
            pricePerHr: typeof price === 'number' ? price : null,
            availability,
            vcpuOptions: s.vcpuOptions || [],
            diskGb: s.storageGB || null,
        });
    }
    return rows.sort((a, b) => (a.pricePerHr ?? Infinity) - (b.pricePerHr ?? Infinity));
}

export async function thunderOffers() {
    const [specs, pricing, status] = await Promise.all([
        thunder(null, 'GET', '/v2/specs'), thunder(null, 'GET', '/v2/pricing'), thunder(null, 'GET', '/v2/status'),
    ]);
    return normalizeOffers({ specs: specs?.specs, pricing: pricing?.pricing, status });
}

// The instance list comes back as an object keyed by id; the id is only in the key.
export async function thunderInstances(apiKey) {
    const data = await thunder(apiKey, 'GET', '/v1/instances/list');
    return Object.entries(data || {}).map(([id, v]) => ({ ...v, id: v?.id || id }));
}
