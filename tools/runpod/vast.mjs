// Vast.ai: a marketplace of GPU machines. An on-demand rental is kept until the
// offer's end date (set by its host, shown before renting); there is no queue
// and no booking for a later date, and stopping a machine releases its GPU.
// So the console rents, keeps the machine running, and destroys it.
//
// Calls copied from Vast's own CLI (github.com/vast-ai/vast-cli, vastai/api):
//   POST /api/v0/bundles/          search offers   (body = the query)
//   PUT  /api/v0/asks/{id}/        rent one offer  (answers { new_contract })
//   GET  /api/v1/instances/        my rentals      (v0 answers 410 since 2026-10)
//   DELETE /api/v0/instances/{id}/ destroy
//   GET  /api/v0/users/current/    account, credit
// The container runs our image's own entrypoint (runtype "args" with no args);
// `-p 3000:3000` in env asks for the port, which Vast maps to a random public one.

import { PORT, RunPodError } from './lib.mjs';
import { thunderEnv } from './thunder.mjs';

export const VAST_API = process.env.VAST_API_URL || 'https://console.vast.ai/api';
export const VAST_PREFIX = 'comfyq-vast-';

export async function vast(apiKey, method, route, body) {
    if (!apiKey) throw new RunPodError('enter your Vast.ai API key in Settings (top right) first', 400);
    const r = await fetch(`${VAST_API}${route}`, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (r.status === 401 || r.status === 403) throw new RunPodError('Vast.ai refused the key: check it on cloud.vast.ai → Account → Keys', 400);
    if (!r.ok || data?.success === false) {
        const msg = data?.msg || data?.error || text.slice(0, 300) || `HTTP ${r.status}`;
        throw new RunPodError(`Vast.ai answered ${r.status}: ${msg}`, r.status === 402 ? 402 : r.ok ? 409 : 502);
    }
    return data;
}

// Europe and North Africa, by the country code at the end of Vast's "geolocation".
const NEAR = new Set(['FR', 'ES', 'PT', 'DE', 'NL', 'BE', 'LU', 'IT', 'GB', 'UK', 'IE', 'PL', 'CZ', 'SK', 'AT', 'CH', 'SE', 'FI', 'NO', 'DK',
    'IS', 'EE', 'LV', 'LT', 'RO', 'BG', 'HU', 'SI', 'HR', 'RS', 'GR', 'MT', 'CY', 'MA', 'TN', 'DZ']);
export const countryOf = (geo) => (String(geo || '').match(/,\s*([A-Z]{2})\s*$/) || [])[1] || null;
export const isNear = (geo) => NEAR.has(countryOf(geo));

/**
 * The search Vast is asked: one GPU, the VRAM, the price cap, CUDA 12.8+ (our
 * image), a reliable host, a fast enough link to pull a 10 GB image and the
 * models, an open port, a disk big enough, and an end date after `minDays`.
 */
export function offerQuery({ minVramGb = 24, maxPricePerHr = 1, minDays = 1, diskGb = 80, secureOnly = false, minReliability = 0.98 } = {}) {
    const q = {
        verified: { eq: true }, rentable: { eq: true }, rented: { eq: false }, num_gpus: { eq: 1 },
        gpu_ram: { gte: Math.round(minVramGb * 1000) }, cuda_max_good: { gte: 12.8 },
        // Ampere or newer: older cards (Turing: Titan RTX, Quadro RTX 6000) have no
        // bf16, which most of our models are stored in.
        compute_cap: { gte: 800 },
        reliability2: { gte: minReliability }, dph_total: { lte: maxPricePerHr },
        disk_space: { gte: diskGb }, inet_down: { gte: 300 }, direct_port_count: { gte: 1 },
        duration: { gte: Math.round(minDays * 86400) },
        type: 'on-demand', order: [['dph_total', 'asc']], allocated_storage: diskGb, limit: 200,
    };
    if (secureOnly) q.hosting_type = { eq: 1 };
    return q;
}

/** One offer as the page shows it. */
export function normalizeOffer(o) {
    const endAt = o.end_date ? Math.round(o.end_date * 1000) : (o.duration ? Date.now() + o.duration * 1000 : null);
    return {
        id: o.id, gpu: o.gpu_name, vramGb: Math.round((o.gpu_ram || 0) / 1024), pricePerHr: Number(o.dph_total) || null,
        where: o.geolocation || null, country: countryOf(o.geolocation), near: isNear(o.geolocation),
        datacenter: o.hosting_type === 1, reliability: Number(o.reliability2 ?? o.reliability) || null,
        cuda: o.cuda_max_good ?? null, driver: o.driver_version || null,
        downMbps: Math.round(o.inet_down || 0), upMbps: Math.round(o.inet_up || 0),
        diskGb: Math.round(o.disk_space || 0), cpuCores: Math.round(o.cpu_cores_effective || o.cpu_cores || 0), ramGb: Math.round((o.cpu_ram || 0) / 1024),
        endAt, days: endAt ? +((endAt - Date.now()) / 86400_000).toFixed(1) : null,
        downloadPerTb: o.inet_down_cost != null ? +(o.inet_down_cost * 1024).toFixed(2) : null,
        hostId: o.host_id ?? null, machineId: o.machine_id ?? null,
    };
}

export async function vastOffers(apiKey, filters, { near = false } = {}) {
    const data = await vast(apiKey, 'POST', '/v0/bundles/', offerQuery(filters));
    // CMP cards are mining cards (cut-down PCIe and compute): never for a class.
    let offers = (data?.offers || []).map(normalizeOffer).filter(o => !/^CMP\b/i.test(o.gpu || ''));
    if (near) offers = offers.filter(o => o.near);
    return offers;
}

/** What the container is given: our passwords and plan, and the one port. */
export function vastEnv({ podId, serve = [], secrets = {}, fetchModels = true }) {
    const env = thunderEnv({ podId, serve, secrets, fetchModels });
    for (const [k, v] of Object.entries(env)) {
        // Vast passes these to docker as given: refuse what would break the line.
        if (/[\r\n]/.test(String(v))) throw new RunPodError(`${k} cannot contain a line break`, 400);
    }
    return { ...env, [`-p ${PORT}:${PORT}`]: '1' };
}

export function createBody({ image, env, diskGb, label }) {
    return {
        client_id: 'me', image, env, disk: diskGb, label, runtype: 'args',
        price: null, onstart: null, image_login: null, python_utf8: false, lang_utf8: false,
        use_jupyter_lab: false, jupyter_dir: null, force: false, cancel_unavail: true,
    };
}

export async function vastCreate(apiKey, offerId, body) {
    const r = await vast(apiKey, 'PUT', `/v0/asks/${encodeURIComponent(offerId)}/`, body);
    const id = r?.new_contract;
    if (!id) throw new RunPodError('Vast.ai accepted the rental but returned no instance id: check cloud.vast.ai and destroy it there if it exists', 502);
    return { id: String(id) };
}

/** Where ComfyQ answers on a rental: its public IP and the port Vast mapped to 3000. */
export function vastUrl(inst) {
    const ip = String(inst.public_ipaddr || '').trim();
    const map = inst.ports?.[`${PORT}/tcp`];
    const port = Array.isArray(map) ? map.find(m => m.HostPort)?.HostPort : null;
    if (!ip || !port) return null;   // no address until Vast has mapped the port
    if (process.env.COMFYQ_VAST_PROXY) return process.env.COMFYQ_VAST_PROXY.replace('{id}', String(inst.id));
    return `http://${ip}:${port}`;
}

export function normalizeInstance(i) {
    return {
        id: String(i.id), label: String(i.label || '').trim() || null,
        status: String(i.actual_status || i.cur_state || 'unknown').trim(), intended: String(i.intended_status || '').trim() || null,
        message: String(i.status_msg || '').trim() || null,
        gpu: String(i.gpu_name || '').trim() || null, vramGb: i.gpu_ram ? Math.round(i.gpu_ram / 1024) : null,
        pricePerHr: Number(i.dph_total) || null, where: String(i.geolocation || '').trim() || null,
        ip: String(i.public_ipaddr || '').trim() || null, url: vastUrl(i),
        startedAt: i.start_date ? Math.round(i.start_date * 1000) : null, endAt: i.end_date ? Math.round(i.end_date * 1000) : null,
        image: String(i.image_uuid || '').trim() || null, diskGb: i.disk_space ? Math.round(i.disk_space) : null,
    };
}

export async function vastInstances(apiKey) {
    const out = [];
    let after = null;
    for (let page = 0; page < 20; page++) {
        const params = new URLSearchParams({ select_filters: '{}', order_by: JSON.stringify([{ col: 'id', dir: 'asc' }]), limit: '25' });
        if (after) params.set('after_token', after);
        const d = await vast(apiKey, 'GET', `/v1/instances/?${params}`);
        out.push(...(d?.instances || []).map(normalizeInstance));
        after = d?.next_token;
        if (!after) break;
    }
    return out;
}

export const vastDestroy = (apiKey, id) => vast(apiKey, 'DELETE', `/v0/instances/${encodeURIComponent(id)}/`, {});
export async function vastCredit(apiKey) {
    const me = await vast(apiKey, 'GET', '/v0/users/current/');
    return Number(me?.credit ?? 0);
}
