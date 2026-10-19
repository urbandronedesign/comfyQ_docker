#!/usr/bin/env node
// ComfyQ RunPod console: a page on THIS machine for entering the RunPod and
// ComfyQ credentials, picking workflows and a GPU, launching a Pod, and
// watching it until students can book.
//
//   node tools/runpod/console/server.mjs        (or npm run runpod:console)
//
// ★ It holds a RunPod API key, which can spend money, so it is reachable from
//   this machine only:
//   - it listens on 127.0.0.1, never on the network;
//   - it refuses a request whose Host is not 127.0.0.1/localhost, which stops
//     a web page from reaching it by pointing a hostname at 127.0.0.1;
//   - every /api call must carry an X-ComfyQ-Console header. A page on another
//     site cannot add one without a CORS preflight, and this server answers
//     no preflight, so another tab in the same browser cannot call it.
//   The credentials are kept in <home>/.comfyq/runpod-console.json and never
//   sent back to the page; it is only told which ones are set.

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import {
    rest, gpuTypes, podProbe, podBody, proxyUrl, missingSecrets, runningOnVolume, oneAtATime,
    listWorkflows, vramNeeded, rankGpus, DEFAULT_IMAGE, RunPodError,
} from '../lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.COMFYQ_CONSOLE_PORT || 4777);
const HOST = '127.0.0.1';
const SETTINGS_FILE = path.join(os.homedir(), '.comfyq', 'runpod-console.json');

// From RunPod's OpenAPI spec (dataCenterIds, checked 2026-10-19).
const DATA_CENTERS = ['EU-RO-1', 'EU-SE-1', 'EU-CZ-1', 'EU-NL-1', 'EU-FR-1', 'EUR-IS-1', 'EUR-IS-2', 'EUR-IS-3', 'EUR-NO-1',
    'CA-MTL-1', 'CA-MTL-2', 'CA-MTL-3', 'US-IL-1', 'US-TX-1', 'US-TX-3', 'US-TX-4', 'US-KS-2', 'US-KS-3', 'US-GA-1', 'US-GA-2',
    'US-WA-1', 'US-CA-2', 'US-NC-1', 'US-DE-1', 'US-MD-1', 'US-MO-1', 'US-MO-2', 'OC-AU-1', 'AP-JP-1', 'AP-IN-1'];

// ---- settings -----------------------------------------------------------------

const SECRET_KEYS = ['runpodApiKey', 'adminPassword', 'accessPassword', 'hfToken'];
const PLAIN_KEYS = ['image', 'volumeId', 'community', 'diskGb'];

function loadSettings() {
    try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
    catch { return {}; }
}

function saveSettings(s) {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    const tmp = SETTINGS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, SETTINGS_FILE);
}

// What the page may see: whether each secret is set, and for the two long
// tokens their last 4 characters, so two keys can be told apart. Never for a
// password: the last 4 characters of a short one are most of it.
const HINTED = new Set(['runpodApiKey', 'hfToken']);
function publicSettings(s = loadSettings()) {
    const out = { file: SETTINGS_FILE, defaultImage: DEFAULT_IMAGE };
    for (const k of SECRET_KEYS) {
        const v = String(s[k] || '');
        out[k] = !v ? { set: false }
            : { set: true, hint: HINTED.has(k) && v.length >= 16 ? `…${v.slice(-4)}` : null };
    }
    for (const k of PLAIN_KEYS) out[k] = s[k] ?? null;
    return out;
}

const secretsOf = (s) => ({ adminPassword: s.adminPassword, accessPassword: s.accessPassword, hfToken: s.hfToken });

function apiKey() {
    const k = loadSettings().runpodApiKey || process.env.RUNPOD_API_KEY;
    if (!k) throw new RunPodError('enter your RunPod API key under Credentials first', 400);
    return k;
}

// ---- routes -------------------------------------------------------------------

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern}$`), fn });

route('GET', '/api/settings', () => publicSettings());

route('PUT', '/api/settings', ({ body }) => {
    const s = loadSettings();
    // A key present in the body is set (or cleared when empty); a key left out
    // is kept. So the page sends only the fields someone typed into.
    for (const k of [...SECRET_KEYS, ...PLAIN_KEYS]) {
        if (!(k in body)) continue;
        const v = body[k];
        if (v === '' || v === null) delete s[k];
        else s[k] = typeof v === 'string' ? v.trim() : v;
    }
    saveSettings(s);
    return publicSettings(s);
});

// Does the key work, and can it create Pods? Listing proves read access; write
// access only shows when something is created, so that is said plainly.
route('POST', '/api/test-key', async () => {
    const key = apiKey();
    const pods = await rest(key, 'GET', '/pods');
    const vols = await rest(key, 'GET', '/networkvolumes');
    let gpus = null;
    try { gpus = (await gpuTypes(key)).gpus.length; } catch { /* prices are optional */ }
    return { ok: true, pods: pods.length, volumes: vols.length, gpuTypes: gpus };
});

route('GET', '/api/workflows', () => ({ workflows: listWorkflows() }));

route('GET', '/api/volumes', async () => ({ volumes: await rest(apiKey(), 'GET', '/networkvolumes') }));

route('GET', '/api/datacenters', () => ({ dataCenters: DATA_CENTERS }));

route('POST', '/api/volumes', async ({ body }) => {
    const name = String(body.name || '').trim();
    const size = Number(body.size);
    if (!name) throw new RunPodError('give the volume a name', 400);
    if (!(size >= 10 && size <= 4000)) throw new RunPodError('size must be between 10 and 4000 GB', 400);
    if (!DATA_CENTERS.includes(body.dataCenterId)) throw new RunPodError('pick a data centre', 400);
    return { volume: await rest(apiKey(), 'POST', '/networkvolumes', { name, size, dataCenterId: body.dataCenterId }) };
});

// GPUs ranked for the chosen workflows, priced and stocked in the volume's
// data centre when RunPod will say.
route('GET', '/api/gpus', async ({ query }) => {
    const all = listWorkflows();
    const chosen = String(query.get('workflows') || '').split(',').filter(Boolean)
        .map(id => all.find(w => w.id === id)).filter(Boolean);
    const need = vramNeeded(chosen);
    const community = query.get('community') === '1';
    const { gpus, scopedToDataCenter } = await gpuTypes(apiKey(), {
        dataCenterId: query.get('dataCenterId') || undefined,
        secureCloud: !community,
    });
    const ranked = rankGpus(gpus, need.gb, { community });
    return { need, scopedToDataCenter, ...ranked };
});

route('POST', '/api/launch', async ({ body }) => {
    const s = loadSettings();
    const key = apiKey();
    const serve = Array.isArray(body.serve) ? body.serve.filter(Boolean) : [];
    const gpuTypeIds = Array.isArray(body.gpuTypeIds) ? body.gpuTypeIds.filter(Boolean) : [];
    if (!gpuTypeIds.length) throw new RunPodError('pick a GPU', 400);
    const missing = missingSecrets(secretsOf(s));
    if (serve.length && missing.length && !body.allowOpen) {
        throw new RunPodError('set the admin password under Credentials first: a Pod is reachable by anyone who has its URL, admin panel included', 400);
    }
    const vols = await rest(key, 'GET', '/networkvolumes');
    const volume = vols.find(v => v.id === body.volumeId);
    if (!volume) throw new RunPodError('pick a network volume', 400);
    const busy = runningOnVolume(await rest(key, 'GET', '/pods'), volume.id);
    if (busy.length) throw new RunPodError(oneAtATime(busy, volume.name), 409);

    const create = () => rest(key, 'POST', '/pods', podBody({
        volume, gpuTypeIds, serve, secrets: secretsOf(s),
        name: body.name, image: s.image, diskGb: body.diskGb || s.diskGb,
        community: !!body.community, fetchModels: body.fetchModels !== false,
        syncWorkflows: !!body.syncWorkflows, allowOpen: !!body.allowOpen && missing.length > 0,
    }));
    let pod;
    try { pod = await create(); }
    catch (e) {
        // RunPod's wording for "no free machine matches": say what to change.
        if (/required specifications|no.*available|insufficient/i.test(e.message)) {
            throw new RunPodError(`RunPod has no free machine right now with ${gpuTypeIds.length > 1 ? 'any of these GPUs' : 'this GPU'} in ${volume.dataCenterId} `
                + `(on ${body.community ? 'Community' : 'Secure'} Cloud, with a CUDA 12.8 driver). Pick a GPU showing stock, tick a few more as fallbacks, `
                + `or try again in a few minutes — stock in one data centre changes often.`, 409);
        }
        throw e;
    }
    // Remember the choices for next time (never the secrets — those are
    // already stored separately).
    saveSettings({ ...s, volumeId: volume.id, community: !!body.community, diskGb: body.diskGb || s.diskGb || 30 });
    return { pod: slimPod(pod, [volume]) };
});

// The Pod object minus its environment, which holds the passwords. RunPod
// gives only the volume's id, so its name comes from the volume list.
const slimPod = (p, volumes = []) => p && ({
    id: p.id, name: p.name, image: p.image, desiredStatus: p.desiredStatus,
    gpu: p.gpu ? { id: p.gpu.id, name: p.gpu.displayName, count: p.gpu.count } : null,
    costPerHr: p.costPerHr ?? p.adjustedCostPerHr ?? null,
    lastStartedAt: p.lastStartedAt || null, lastStatusChange: p.lastStatusChange || null,
    networkVolume: (() => {
        const id = p.networkVolumeId || p.networkVolume?.id;
        if (!id) return null;
        const v = volumes.find(x => x.id === id) || p.networkVolume || {};
        return { id, name: v.name || id, dataCenterId: v.dataCenterId || null };
    })(),
    serve: String(p.env?.COMFYQ_SERVE || '').split(',').filter(Boolean),
    comfyq: /comfyq/i.test(p.image || ''),
    links: { students: proxyUrl(p.id), admin: `${proxyUrl(p.id)}/admin`, comfyui: proxyUrl(p.id, 8188) },
});

route('GET', '/api/pods', async () => {
    const key = apiKey();
    const [pods, volumes] = await Promise.all([rest(key, 'GET', '/pods'), rest(key, 'GET', '/networkvolumes')]);
    return { pods: pods.map(p => slimPod(p, volumes)) };
});

route('GET', '/api/pods/([A-Za-z0-9]+)', async ({ match }) => {
    const key = apiKey();
    const [pod, volumes] = await Promise.all([rest(key, 'GET', `/pods/${match[1]}`), rest(key, 'GET', '/networkvolumes')]);
    const probe = pod.desiredStatus === 'RUNNING' ? await podProbe(pod.id) : null;
    return { pod: slimPod(pod, volumes), probe };
});

route('POST', '/api/pods/([A-Za-z0-9]+)/(stop|start)', async ({ match }) => {
    const key = apiKey();
    if (match[2] === 'start') {
        const pod = await rest(key, 'GET', `/pods/${match[1]}`);
        const vid = pod.networkVolumeId || pod.networkVolume?.id;
        const busy = vid ? runningOnVolume(await rest(key, 'GET', '/pods'), vid, pod.id) : [];
        if (busy.length) {
            const vols = await rest(key, 'GET', '/networkvolumes');
            throw new RunPodError(oneAtATime(busy, vols.find(v => v.id === vid)?.name || vid), 409);
        }
    }
    await rest(key, 'POST', `/pods/${match[1]}/${match[2]}`);
    return { ok: true };
});

route('DELETE', '/api/pods/([A-Za-z0-9]+)', async ({ match, body }) => {
    // The page asks for the Pod id to be typed back, and the server checks it,
    // so a stray click or a stale request cannot delete the wrong Pod.
    if (body.confirm !== match[1]) throw new RunPodError('type the Pod id to confirm', 400);
    await rest(apiKey(), 'DELETE', `/pods/${match[1]}`);
    return { ok: true };
});

// ---- server -------------------------------------------------------------------

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function send(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
}

async function readBody(req) {
    let raw = '';
    for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 1e6) throw new RunPodError('request too large', 413);
    }
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { throw new RunPodError('the body is not JSON', 400); }
}

const server = http.createServer(async (req, res) => {
    if (!ALLOWED_HOSTS.has(req.headers.host)) { res.writeHead(403); return res.end('forbidden'); }
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (!url.pathname.startsWith('/api/')) {
        const file = STATIC[url.pathname];
        if (req.method !== 'GET' || !file) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(file)],
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:",
            'X-Frame-Options': 'DENY',
        });
        return fs.createReadStream(path.join(HERE, file)).pipe(res);
    }

    if (req.headers['x-comfyq-console'] !== '1') return send(res, 403, { error: 'missing console header' });
    const hit = routes.map(r => ({ r, m: r.method === req.method && url.pathname.match(r.re) })).find(x => x.m);
    if (!hit) return send(res, 404, { error: 'no such route' });
    try {
        const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
        send(res, 200, await hit.r.fn({ body, query: url.searchParams, match: hit.m }));
    } catch (e) {
        const status = e instanceof RunPodError && e.status >= 400 && e.status < 600 ? e.status : 500;
        send(res, status, { error: e.message });
    }
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.log(`Port ${PORT} is in use — the console is probably already running: http://localhost:${PORT}`);
        openBrowser(`http://localhost:${PORT}`);
        process.exit(0);
    }
    throw e;
});

function openBrowser(url) {
    if (process.argv.includes('--no-open')) return;
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref(); } catch { /* print the URL instead */ }
}

server.listen(PORT, HOST, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`ComfyQ RunPod console: ${url}  (this machine only; Ctrl+C to stop)`);
    console.log(`Credentials are kept in ${SETTINGS_FILE}`);
    openBrowser(url);
});
