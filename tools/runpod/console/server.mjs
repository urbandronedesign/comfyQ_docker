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
import crypto from 'crypto';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import {
    rest, gpuTypes, podProbe, podBody, proxyUrl, missingSecrets, runningOnVolume, shareBlockers, cannotShare,
    listWorkflows, vramNeeded, rankGpus, volumeBuilds, volumeGroups, podImage, DEFAULT_IMAGE, RunPodError,
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

// Launch one Pod or several on one volume. The body is either one Pod's
// fields ({serve, gpuTypeIds, name}) or `pods: [{…}, …]`; the volume and
// options are shared. Pods are created one after the other; one RunPod has no
// machine for does not undo the others, which are already billing, so the
// answer lists both what was created and what failed.
route('POST', '/api/launch', async ({ body }) => {
    const s = loadSettings();
    const key = apiKey();
    const image = s.image || DEFAULT_IMAGE;
    const plans = (Array.isArray(body.pods) ? body.pods : [body]).map(p => ({
        serve: Array.isArray(p.serve) ? p.serve.filter(Boolean) : [],
        gpuTypeIds: Array.isArray(p.gpuTypeIds) ? p.gpuTypeIds.filter(Boolean) : [],
        name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : null,
    }));
    if (!plans.length) throw new RunPodError('nothing to launch', 400);
    if (plans.length > 8) throw new RunPodError('at most 8 Pods in one launch', 400);
    if (plans.some(p => !p.gpuTypeIds.length)) throw new RunPodError('pick a GPU for every Pod', 400);
    const missing = missingSecrets(secretsOf(s));
    if (plans.some(p => p.serve.length) && missing.length && !body.allowOpen) {
        throw new RunPodError('set the admin password under Credentials first: a Pod is reachable by anyone who has its URL, admin panel included', 400);
    }
    const vols = await rest(key, 'GET', '/networkvolumes');
    const volume = vols.find(v => v.id === body.volumeId);
    if (!volume) throw new RunPodError('pick a network volume', 400);
    // Pods already on the volume must be able to share it. The ones created
    // here boot the same image as each other, so they never block each other.
    const existing = await rest(key, 'GET', '/pods');
    const blockers = await shareBlockers(runningOnVolume(existing, volume.id), { image });
    if (blockers.length) throw new RunPodError(cannotShare(blockers, volume.name), 409);

    // Two Pods serving the same workflow would get the same default name, in
    // this launch or beside one launched earlier: keep names unique.
    const names = new Set(existing.map(p => p.name));
    for (const p of plans) {
        const base = (p.name || `comfyq-${p.serve[0] || 'admin'}`).slice(0, 180);
        let n = base;
        for (let i = 2; names.has(n); i++) n = `${base}-${i}`;
        names.add(n);
        p.name = n;
    }

    const created = [];
    const failed = [];
    const results = [];          // one per Pod asked for, in order
    for (const p of plans) {
        try {
            const pod = await rest(key, 'POST', '/pods', podBody({
                volume, gpuTypeIds: p.gpuTypeIds, serve: p.serve, secrets: secretsOf(s),
                name: p.name, image: s.image, diskGb: body.diskGb || s.diskGb,
                community: !!body.community, fetchModels: body.fetchModels !== false,
                syncWorkflows: !!body.syncWorkflows, allowOpen: !!body.allowOpen && missing.length > 0,
            }));
            created.push(slimPod(pod, [volume]));
            results.push({ ok: true, pod: created.at(-1) });
        } catch (e) {
            // RunPod's wording for "no free machine matches": say what to change.
            const error = /required specifications|requested specifications|instances available|no.*available|insufficient/i.test(e.message)
                ? `RunPod has no free machine right now with ${p.gpuTypeIds.length > 1 ? 'any of these GPUs' : 'this GPU'} in ${volume.dataCenterId} `
                  + `(on ${body.community ? 'Community' : 'Secure'} Cloud, with a CUDA 12.8 driver). Pick a GPU showing stock, tick a few more as fallbacks, `
                  + `or try again in a few minutes — stock in one data centre changes often.`
                : e.message;
            failed.push({ name: p.name, serve: p.serve, error, status: e.status || 500 });
            results.push({ ok: false, error });
        }
    }
    // Remember the choices for next time (never the secrets — those are
    // already stored separately).
    if (created.length) saveSettings({ ...s, volumeId: volume.id, community: !!body.community, diskGb: body.diskGb || s.diskGb || 30 });
    // Nothing created: an error, as a single launch always was.
    if (!created.length) throw new RunPodError(plans.length === 1 ? failed[0].error : failed.map(f => `${f.name}: ${f.error}`).join(' — '),
        failed.every(f => /no free machine/.test(f.error)) ? 409 : failed[0].status);
    return { pod: created[0], created, failed, results };
});

// The Pod object minus its environment, which holds the passwords. RunPod
// gives only the volume's id, so its name comes from the volume list.
const slimPod = (p, volumes = []) => p && ({
    id: p.id, name: p.name, image: podImage(p), desiredStatus: p.desiredStatus,
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
    comfyq: /comfyq/i.test(podImage(p) || ''),
    links: { students: proxyUrl(p.id), admin: `${proxyUrl(p.id)}/admin`, comfyui: proxyUrl(p.id, 8188) },
});

route('GET', '/api/pods', async () => {
    const key = apiKey();
    const [pods, volumes] = await Promise.all([rest(key, 'GET', '/pods'), rest(key, 'GET', '/networkvolumes')]);
    const slim = pods.map(p => slimPod(p, volumes));
    return { pods: slim, groups: volumeGroups(slim).map(g => ({ ...g, pods: g.pods.map(p => p.id) })) };
});

route('GET', '/api/pods/([A-Za-z0-9]+)', async ({ match }) => {
    const key = apiKey();
    const [pod, volumes] = await Promise.all([rest(key, 'GET', `/pods/${match[1]}`), rest(key, 'GET', '/networkvolumes')]);
    const probe = pod.desiredStatus === 'RUNNING' ? await podProbe(pod.id) : null;
    return { pod: slimPod(pod, volumes), probe };
});

// Which build each running Pod on a volume serves. Pods that pulled `latest`
// at different times can differ, and a newer image may expect a newer layout.
route('GET', '/api/volumes/([A-Za-z0-9]+)/builds', async ({ match }) => {
    const running = runningOnVolume(await rest(apiKey(), 'GET', '/pods'), match[1]);
    return volumeBuilds(running.map(p => p.id));
});

// ---- folders Pods left on a volume (Phase I6) -----------------------------------
//
// The console cannot see inside a volume, so a running Pod on it lists the
// pods/<id> folders. ★ Only the console knows which Pods still exist in the
// account: a STOPPED Pod has no heartbeat, and its folder is its queue,
// settings and results. So a folder is offered for deletion only when no Pod
// with its id exists, and that is checked again at the moment of deleting.

async function podCall(podId, route, { method = 'GET', body, timeout = 120000 } = {}) {
    const res = await fetch(proxyUrl(podId) + route, {
        method,
        headers: { 'X-Admin-Password': loadSettings().adminPassword || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
    });
    return res;
}

// A running Pod on the volume that can list its folders.
async function folderPod(key, volumeId) {
    const running = runningOnVolume(await rest(key, 'GET', '/pods'), volumeId);
    if (!running.length) throw new RunPodError('no Pod is running on this volume: start one to look inside it (a Pod reads the volume for the console)', 409);
    let tooOld = null;
    for (const p of running) {
        let r;
        try { r = await podCall(p.id, '/admin/volume-folders', { timeout: 60000 }); } catch { continue; }
        if (r.status === 401) throw new RunPodError(`Pod "${p.name}" refused the admin password saved here: save the one that Pod was launched with`, 401);
        if (r.status === 404) { tooOld = p; continue; }
        if (r.ok) return { pod: p, data: await r.json() };
    }
    if (tooOld) throw new RunPodError(`Pod "${tooOld.name}" runs an image without folder cleanup — stop and start it to get the new image`, 409);
    throw new RunPodError('the Pods on this volume are not answering yet — wait until one is up', 409);
}

route('GET', '/api/volumes/([A-Za-z0-9]+)/folders', async ({ match }) => {
    const key = apiKey();
    const { pod: via, data } = await folderPod(key, match[1]);
    const account = await rest(key, 'GET', '/pods');
    const folders = data.folders.map(f => {
        const owner = account.find(p => p.id === f.id) || null;
        const kind = f.unfinishedDelete ? 'unfinished'
            : f.isMe ? 'reader'
            : owner?.desiredStatus === 'RUNNING' || f.alive ? 'running'
            : owner ? 'stopped'
            : 'orphan';
        return { ...f, kind, pod: owner ? { id: owner.id, name: owner.name, desiredStatus: owner.desiredStatus } : null };
    });
    return { via: { id: via.id, name: via.name }, folders };
});

// A download is a browser navigation, which cannot carry the console header,
// so the page first asks (with the header) for a one-use link valid a minute.
const downloads = new Map();
route('POST', '/api/volumes/([A-Za-z0-9]+)/folders/([A-Za-z0-9_-]+)/download', async ({ match }) => {
    const token = crypto.randomBytes(18).toString('hex');
    downloads.set(token, { volumeId: match[1], folderId: match[2], until: Date.now() + 60000 });
    return { url: `/download/${token}` };
});

async function serveDownload(token, res) {
    const d = downloads.get(token);
    downloads.delete(token);
    if (!d || d.until < Date.now()) { res.writeHead(410); return res.end('This download link has expired: ask for it again in the console.'); }
    try {
        const { pod } = await folderPod(apiKey(), d.volumeId);
        const r = await podCall(pod.id, `/admin/volume-folders/${encodeURIComponent(d.folderId)}/results.zip`, { timeout: 6 * 3600_000 });
        if (!r.ok) { res.writeHead(r.status); return res.end(await r.text()); }
        res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': r.headers.get('content-disposition') || `attachment; filename="comfyq-pod-${d.folderId}-results.zip"`,
        });
        Readable.fromWeb(r.body).pipe(res);
    } catch (e) {
        res.writeHead(e.status || 502);
        res.end(e.message);
    }
}

route('DELETE', '/api/volumes/([A-Za-z0-9]+)/folders/([A-Za-z0-9._-]+)', async ({ match, body }) => {
    const key = apiKey();
    const [vid, fid] = [match[1], match[2]];
    if (body.confirm !== fid) throw new RunPodError('type the folder name to confirm', 400);
    // Checked again now, not trusted from the list the page showed.
    const owner = (await rest(key, 'GET', '/pods')).find(p => p.id === fid);
    if (owner) {
        throw new RunPodError(`Pod "${owner.name}" (${fid}) still exists (${String(owner.desiredStatus).toLowerCase()}): this folder is its queue, settings and results. `
            + 'Terminate the Pod first if you really want them gone.', 409);
    }
    const { pod } = await folderPod(key, vid);
    const r = await podCall(pod.id, `/admin/volume-folders/${encodeURIComponent(fid)}/delete`, { method: 'POST', body: { confirm: fid }, timeout: 600000 });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) throw new RunPodError(`Pod "${pod.name}" did not delete it: ${out.error || `HTTP ${r.status}`}`, r.status >= 400 ? r.status : 502);
    return out;
});

route('POST', '/api/pods/([A-Za-z0-9]+)/(stop|start)', async ({ match }) => {
    const key = apiKey();
    if (match[2] === 'start') {
        const pod = await rest(key, 'GET', `/pods/${match[1]}`);
        const vid = pod.networkVolumeId || pod.networkVolume?.id;
        // Starting several stopped Pods on one volume together is fine when
        // they boot the same image, so a booting neighbour on it is no blocker.
        const blockers = vid ? await shareBlockers(runningOnVolume(await rest(key, 'GET', '/pods'), vid, pod.id), { image: podImage(pod) }) : [];
        if (blockers.length) {
            const vols = await rest(key, 'GET', '/networkvolumes');
            throw new RunPodError(cannotShare(blockers, vols.find(v => v.id === vid)?.name || vid), 409);
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

    const dl = req.method === 'GET' && url.pathname.match(/^\/download\/([a-f0-9]{36})$/);
    if (dl) return serveDownload(dl[1], res);

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
