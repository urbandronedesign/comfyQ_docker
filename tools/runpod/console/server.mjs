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
    listWorkflows, vramNeeded, rankGpus, volumeBuilds, volumeGroups, podImage, isNoMachine, DEFAULT_IMAGE, RunPodError, probeUrl, studentLinks, PORT as POD_PORT,
} from '../lib.mjs';
import {
    thunderOffers, thunderInstances, thunderCreate, thunderDelete, thunderAddKey, thunderUrl, thunderEnv, remoteScript, setupInstance, thunderHourly,
} from '../thunder.mjs';
import { graphql, downloadNeed, diskNeeded, RESULTS_DISK_GB, acceptedGpuIds } from '../lib.mjs';
import { updateLedger, summarize, emptyLedger, thunderBalanceNow } from '../spend.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.COMFYQ_CONSOLE_PORT || 4777);
const HOST = '127.0.0.1';
const NO_VOLUME = 'none';
const SETTINGS_FILE = path.join(os.homedir(), '.comfyq', 'runpod-console.json');

// ---- attempt log ----------------------------------------------------------------
// Every try at getting a GPU — launches and starts, whatever the outcome — one
// JSON line each, in a file beside the settings. A file rather than memory, so
// a test script running its own copy of the console shows up here too.
const ATTEMPTS_FILE = path.join(os.homedir(), '.comfyq', 'runpod-attempts.jsonl');
const SOURCE = process.env.COMFYQ_CONSOLE_SOURCE || 'console';
// The desktop app (console-app/) starts this server with a fresh random token
// and gives it only to its own window: then any other program on the machine,
// which could otherwise call this port with the fixed header, is refused.
// Started any other way (RunPod-Console.bat, npm run runpod:console) it makes
// its own random token at each start and opens the browser at #t=<token>: the
// page keeps it in this tab's sessionStorage. A fixed value let any program, or
// any other Windows user, on this PC drive the console (audit, 2026-10-20).
const CONSOLE_TOKEN = process.env.COMFYQ_CONSOLE_TOKEN || crypto.randomBytes(24).toString('hex');
const URL_FILE = path.join(os.homedir(), '.comfyq', 'console-url.txt');   // so a second start can open this one
function recordAttempt(entry) {
    try {
        fs.mkdirSync(path.dirname(ATTEMPTS_FILE), { recursive: true });
        fs.appendFileSync(ATTEMPTS_FILE, JSON.stringify({ at: Date.now(), source: SOURCE, ...entry, ...(entry.message ? { message: redact(entry.message) } : {}) }) + '\n');
        // Keep it small: past ~2 MB, keep the newest 3000 lines.
        if (fs.statSync(ATTEMPTS_FILE).size > 2e6) {
            const lines = fs.readFileSync(ATTEMPTS_FILE, 'utf8').trim().split('\n');
            fs.writeFileSync(ATTEMPTS_FILE, lines.slice(-3000).join('\n') + '\n');
        }
    } catch { /* a log must never break a launch */ }
}
function readAttempts(limit = 300) {
    try {
        return fs.readFileSync(ATTEMPTS_FILE, 'utf8').trim().split('\n').slice(-limit)
            .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
    } catch { return []; }
}

// From RunPod's OpenAPI spec (dataCenterIds, checked 2026-10-19).
const DATA_CENTERS = ['EU-RO-1', 'EU-SE-1', 'EU-CZ-1', 'EU-NL-1', 'EU-FR-1', 'EUR-IS-1', 'EUR-IS-2', 'EUR-IS-3', 'EUR-NO-1',
    'CA-MTL-1', 'CA-MTL-2', 'CA-MTL-3', 'US-IL-1', 'US-TX-1', 'US-TX-3', 'US-TX-4', 'US-KS-2', 'US-KS-3', 'US-GA-1', 'US-GA-2',
    'US-WA-1', 'US-CA-2', 'US-NC-1', 'US-DE-1', 'US-MD-1', 'US-MO-1', 'US-MO-2', 'OC-AU-1', 'AP-JP-1', 'AP-IN-1'];

// ---- settings -----------------------------------------------------------------

const SECRET_KEYS = ['runpodApiKey', 'thunderApiKey', 'adminPassword', 'accessPassword', 'hfToken'];
const PLAIN_KEYS = ['image', 'volumeId', 'community', 'diskGb'];

// In the desktop app (COMFYQ_SECRETS=parent) the keys and passwords never touch
// the settings file: the app keeps them encrypted with Windows' protection
// (DPAPI, via Electron's safeStorage), hands them to this process at start, and
// is sent any change to store. Here they live in memory only. Started any
// other way (RunPod-Console.bat), everything is in the file, as before.
const SECRETS_FROM_PARENT = process.env.COMFYQ_SECRETS === 'parent' && typeof process.send === 'function';
let secretCache = {};

// mode 0o600 means nothing on Windows: there, take the file away from everyone
// but this account (the profile's default also lets Administrators and SYSTEM in).
function restrictToUser(file) {
    if (process.platform !== 'win32' || !process.env.USERNAME) return;
    try { spawn('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], { stdio: 'ignore', windowsHide: true }); } catch { /* best effort */ }
}

// Secret values never leave in an error message or a log line.
function redact(text) {
    let out = String(text ?? '');
    let s = {};
    try { s = loadSettings(); } catch { /* none */ }
    for (const k of SECRET_KEYS) {
        const v = String(s[k] || '');
        if (v.length >= 4) out = out.split(v).join('***');
    }
    return out;
}

function readSettingsFile() {
    try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
    catch { return {}; }
}

function loadSettings() {
    const file = readSettingsFile();
    if (!SECRETS_FROM_PARENT) return file;
    for (const k of SECRET_KEYS) delete file[k];
    return { ...file, ...secretCache };
}

function saveSettings(s) {
    const out = { ...s };
    if (SECRETS_FROM_PARENT) {
        const secrets = {};
        for (const k of SECRET_KEYS) { if (out[k]) secrets[k] = out[k]; delete out[k]; }
        const changed = SECRET_KEYS.some(k => (secrets[k] || '') !== (secretCache[k] || ''));
        secretCache = secrets;
        if (changed) process.send({ type: 'secrets', secrets });
    }
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    const tmp = SETTINGS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, SETTINGS_FILE);
    restrictToUser(SETTINGS_FILE);
}

// What the page may see: whether each secret is set, and for the two long
// tokens their last 4 characters, so two keys can be told apart. Never for a
// password: the last 4 characters of a short one are most of it.
const HINTED = new Set(['runpodApiKey', 'thunderApiKey', 'hfToken']);
function publicSettings(s = loadSettings()) {
    const out = { file: SETTINGS_FILE, defaultImage: DEFAULT_IMAGE, secretsProtected: SECRETS_FROM_PARENT, sshMissing: process.env.COMFYQ_SSH_MISSING === '1' };
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
    if (!k) throw new RunPodError('enter your RunPod API key in Settings (top right) first', 400);
    return k;
}

// ---- routes -------------------------------------------------------------------

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern}$`), fn });

route('GET', '/api/settings', () => publicSettings());

// A launch hands the image the admin and student passwords and the HuggingFace
// token: anything but ComfyQ's own image has to be asked for explicitly.
const OWN_IMAGE = /^ghcr\.io\/urbandronedesign\/comfyq([:@][A-Za-z0-9._:-]+)?$/;

route('PUT', '/api/settings', ({ body }) => {
    if (typeof body.image === 'string' && body.image.trim() && !OWN_IMAGE.test(body.image.trim()) && body.allowCustomImage !== true) {
        throw new RunPodError(`${body.image.trim()} is not ComfyQ's image (ghcr.io/urbandronedesign/comfyq): a launch gives it your passwords and HuggingFace token. Confirm to use it anyway.`, 409);
    }
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

// Thunder Compute, the backup provider. The key is checked by listing the
// account's instances (read only); prices and stock need no key.
function thunderKey() {
    const k = loadSettings().thunderApiKey || process.env.THUNDER_API_KEY;
    if (!k) throw new RunPodError('enter your Thunder Compute API key in Settings (top right) first', 400);
    return k;
}

route('POST', '/api/thunder/test-key', async () => {
    const instances = await thunderInstances(thunderKey());
    let offers = null;
    try { offers = await thunderOffers(); } catch { /* prices are optional */ }
    return { ok: true, instances: instances.length, offers };
});

route('GET', '/api/thunder/offers', async () => ({ offers: await thunderOffers() }));

route('GET', '/api/workflows', () => ({
    // Each with what a new machine downloads for it, so the page can say so.
    workflows: listWorkflows().map(w => { const d = downloadNeed([w.id]); return { ...w, downloadGb: d.gb, cannotFetch: d.failing.length > 0 }; }),
}));

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
// The cards RunPod's create call accepts, learnt from its own refusal and kept.
const GPU_ENUM_FILE = path.join(os.homedir(), '.comfyq', 'runpod-gpu-ids.json');
function knownAcceptedGpus() { try { return JSON.parse(fs.readFileSync(GPU_ENUM_FILE, 'utf8')).ids || null; } catch { return null; } }
function rememberAcceptedGpus(ids) {
    try { fs.mkdirSync(path.dirname(GPU_ENUM_FILE), { recursive: true }); fs.writeFileSync(GPU_ENUM_FILE, JSON.stringify({ at: new Date().toISOString(), ids }, null, 1)); } catch { /* only a cache */ }
}

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
    const ranked = rankGpus(gpus, need.gb, { community, accepted: knownAcceptedGpus() });
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
        throw new RunPodError('set the admin password in Settings (top right) first: a Pod is reachable by anyone who has its URL, admin panel included', 400);
    }
    // volumeId "none": no network volume, so RunPod may use any data centre
    // with the GPU free (the fallback when the volume's own has none).
    const noVolume = body.volumeId === NO_VOLUME;
    const vols = noVolume ? [] : await rest(key, 'GET', '/networkvolumes');
    const volume = noVolume ? null : vols.find(v => v.id === body.volumeId);
    if (!noVolume && !volume) throw new RunPodError('pick a network volume', 400);
    const where = volume ? volume.dataCenterId : 'any data centre';
    // Refuse what certainly cannot fit, before a Pod bills. The image lives on
    // the container disk; the models go to the volume (some may already be on
    // it, so only a total above its whole size is certain) or, with no volume,
    // to the Pod's own disk.
    if (body.fetchModels !== false) {
        for (const p of plans) {
            const dl = downloadNeed(p.serve);
            if (dl.failing.length) throw new RunPodError(`${dl.failing.join(', ')} cannot fetch all of its models on a new machine (see tools/model-provenance/fresh-machine.cjs): leave it out`, 400);
            if (dl.gb == null) continue;
            const room = volume ? Number(volume.size) : Number(body.podVolumeGb) || 80;
            const need = Math.ceil(dl.gb * 1.05 + (volume ? 2 : RESULTS_DISK_GB));
            if (room && need > room) throw new RunPodError(`${p.serve.join(' + ')} download${p.serve.length > 1 ? '' : 's'} ${dl.gb} GB of models: ${volume ? `the volume "${volume.name}" is only ${room} GB` : `a ${room} GB Pod disk is too small — set at least ${need} GB`}`, 400);
        }
    }
    // Pods already on the volume must be able to share it. The ones created
    // here boot the same image as each other, so they never block each other.
    const existing = await rest(key, 'GET', '/pods');
    const blockers = volume ? await shareBlockers(runningOnVolume(existing, volume.id), { image }) : [];
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

    await balanceCheck('runpod', Number(body.expectedPerHr) || 0);

    const created = [];
    const failed = [];
    const results = [];          // one per Pod asked for, in order
    for (const p of plans) {
        try {
            // Cards RunPod's create call is known to refuse are left out before asking.
            const known = knownAcceptedGpus();
            if (known) p.gpuTypeIds = p.gpuTypeIds.filter(id => known.includes(id));
            if (!p.gpuTypeIds.length) throw new RunPodError('none of the GPUs picked can be launched through RunPod\'s API (MIG slices and some Server Editions cannot): pick another', 400);
            const create = () => rest(key, 'POST', '/pods', podBody({
                volume, gpuTypeIds: p.gpuTypeIds, serve: p.serve, secrets: secretsOf(s),
                name: p.name, image: s.image, diskGb: body.diskGb || s.diskGb, podVolumeGb: body.podVolumeGb,
                community: !!body.community, fetchModels: body.fetchModels !== false,
                syncWorkflows: !!body.syncWorkflows, allowOpen: !!body.allowOpen && missing.length > 0,
            }));
            let pod;
            try { pod = await create(); }
            catch (e) {
                // RunPod refused a card id it does not accept: learn the list, drop them, try once more.
                const accepted = acceptedGpuIds(e.message);
                if (!accepted) throw e;
                rememberAcceptedGpus(accepted);
                const dropped = p.gpuTypeIds.filter(id => !accepted.includes(id));
                p.gpuTypeIds = p.gpuTypeIds.filter(id => accepted.includes(id));
                if (!p.gpuTypeIds.length) throw new RunPodError(`RunPod's API cannot launch ${dropped.join(', ')}: pick another GPU`, 400);
                pod = await create();
            }
            created.push(slimPod(pod, vols));
            results.push({ ok: true, pod: created.at(-1) });
            recordAttempt({ action: 'launch', name: p.name, gpus: p.gpuTypeIds, where, result: 'created', podId: pod.id, costPerHr: pod.costPerHr ?? null });
        } catch (e) {
            // RunPod's wording for "no free machine matches": say what to change.
            const error = isNoMachine(e.message)
                ? `RunPod has no free machine right now with ${p.gpuTypeIds.length > 1 ? 'any of these GPUs' : 'this GPU'} in ${where} `
                  + `(on ${body.community ? 'Community' : 'Secure'} Cloud, with a CUDA 12.8 driver). Pick a GPU showing stock, tick a few more as fallbacks, `
                  + `or try again in a few minutes — stock in one data centre changes often.`
                : e.message;
            failed.push({ name: p.name, serve: p.serve, error, status: e.status || 500 });
            results.push({ ok: false, error });
            recordAttempt({ action: 'launch', name: p.name, gpus: p.gpuTypeIds, where, result: isNoMachine(e.message) ? 'no machine' : 'error', message: e.message.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 300) });
        }
    }
    // Remember the choices for next time (never the secrets — those are
    // already stored separately).
    if (created.length) saveSettings({ ...s, volumeId: noVolume ? NO_VOLUME : volume.id, community: !!body.community, diskGb: body.diskGb || s.diskGb || 30 });
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
    // A Pod with no network volume keeps everything on its own volume: lost on Terminate.
    podVolumeGb: p.volumeInGb || null,
    comfyq: /comfyq/i.test(podImage(p) || ''),
    links: {
        students: proxyUrl(p.id), admin: `${proxyUrl(p.id)}/admin`, comfyui: proxyUrl(p.id, 8188),
        byWorkflow: studentLinks(proxyUrl(p.id), String(p.env?.COMFYQ_SERVE || '').split(',').filter(Boolean)),
    },
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

const podCall = (podId, route, opts) => baseCall(proxyUrl(podId), route, opts);
async function baseCall(base, route, { method = 'GET', body, timeout = 120000 } = {}) {
    const res = await fetch(base + route, {
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

// A Pod's own results, read by that Pod — the way out for a Pod with no
// network volume, whose results go when it is terminated.
route('POST', '/api/pods/([A-Za-z0-9]+)/download', async ({ match }) => {
    // The admin password goes with the request for the results: only to a Pod of this account.
    await rest(apiKey(), 'GET', `/pods/${match[1]}`);
    const token = crypto.randomBytes(18).toString('hex');
    downloads.set(token, { podId: match[1], folderId: match[1], until: Date.now() + 60000 });
    return { url: `/download/${token}` };
});

async function serveDownload(token, res) {
    const d = downloads.get(token);
    downloads.delete(token);
    if (!d || d.until < Date.now()) return sendText(res, 410, 'This download link has expired: ask for it again in the console.');
    try {
        const zip = `/admin/volume-folders/${encodeURIComponent(d.folderId)}/results.zip`;
        let r;
        if (d.base) r = await baseCall(d.base, zip, { timeout: 6 * 3600_000 });
        else {
            const { pod } = d.podId ? { pod: { id: d.podId } } : await folderPod(apiKey(), d.volumeId);
            r = await podCall(pod.id, zip, { timeout: 6 * 3600_000 });
        }
        // Never the machine's own answer: it is somebody else's HTML at this origin.
        if (!r.ok) return sendText(res, r.status >= 400 && r.status < 600 ? r.status : 502, `The machine answered HTTP ${r.status} when asked for its results. Try again in a minute.`);
        res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': r.headers.get('content-disposition') || `attachment; filename="comfyq-pod-${d.folderId}-results.zip"`,
        });
        Readable.fromWeb(r.body).pipe(res);
    } catch (e) {
        sendText(res, e.status >= 400 && e.status < 600 ? e.status : 502, redact(e.message));
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
    try { await rest(key, 'POST', `/pods/${match[1]}/${match[2]}`); }
    catch (e) {
        if (match[2] === 'start') recordAttempt({ action: 'start', podId: match[1], result: isNoMachine(e.message) || /unavailable|sold out|capacity/i.test(e.message) ? 'no machine' : 'error', message: e.message.slice(0, 300) });
        throw e;
    }
    if (match[2] === 'start') recordAttempt({ action: 'start', podId: match[1], result: 'started' });
    return { ok: true };
});

// RunPod stock readings, recorded every 15 minutes by a GitHub Actions job
// (.github/workflows/runpod-stock.yml) onto the repo's runpod-stock branch.
// The page turns them into "how often was this card free, by weekday and hour".
const STOCK_URL = process.env.COMFYQ_STOCK_URL
    || 'https://raw.githubusercontent.com/urbandronedesign/comfyQ_docker/runpod-stock/stock/';
route('GET', '/api/stock', async ({ query }) => {
    const months = Math.min(6, Math.max(1, Number(query.get('months')) || 2));
    const names = [];
    const d = new Date();
    for (let i = 0; i < months; i++) {
        const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
        names.push(`${m.toISOString().slice(0, 7)}.jsonl`);
    }
    const readings = [];
    let found = 0;
    for (const n of names) {
        try {
            const r = await fetch(STOCK_URL + n, { signal: AbortSignal.timeout(20000), headers: { 'Cache-Control': 'no-cache' } });
            if (!r.ok) continue;
            found++;
            for (const line of (await r.text()).split('\n')) {
                if (!line.trim()) continue;
                try { readings.push(JSON.parse(line)); } catch { /* a torn line */ }
            }
        } catch { /* offline, or not recorded yet */ }
    }
    readings.sort((x, y) => x.at.localeCompare(y.at));
    return { source: STOCK_URL, files: found, readings };
});

route('GET', '/api/attempts', ({ query }) => {
    const all = readAttempts(Math.min(3000, Number(query.get('limit')) || 300));
    const hour = all.filter(a => a.at > Date.now() - 3600_000);
    return {
        file: ATTEMPTS_FILE,
        attempts: all,
        lastHour: { tries: hour.length, created: hour.filter(a => a.result === 'created' || a.result === 'started').length, noMachine: hour.filter(a => a.result === 'no machine').length },
    };
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

// ---- Thunder Compute: launching and following instances ----------------------------
//
// Thunder's API creates an instance but cannot run anything in it, so the
// console logs in over SSH (with the private key Thunder returns at creation)
// and starts the image there; then it opens port 3000. What each instance is
// for and how far its setup got is kept in thunder-instances.json beside the
// settings; the keys in thunder-keys/. Billing runs from Create to Delete.

const THUNDER_FILE = path.join(os.homedir(), '.comfyq', 'thunder-instances.json');
const THUNDER_KEYS = path.join(os.homedir(), '.comfyq', 'thunder-keys');
const knownHostsOf = (uuid) => path.join(THUNDER_KEYS, `${String(uuid).replace(/[^A-Za-z0-9-]/g, '')}.known_hosts`);
const thunderTasks = new Map();   // uuid -> setup promise

function loadThunder() {
    try { return JSON.parse(fs.readFileSync(THUNDER_FILE, 'utf8')); } catch { return {}; }
}
function saveThunder(all) {
    fs.mkdirSync(path.dirname(THUNDER_FILE), { recursive: true });
    fs.writeFileSync(THUNDER_FILE + '.tmp', JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(THUNDER_FILE + '.tmp', THUNDER_FILE);
}
function patchThunder(uuid, fn) {
    const all = loadThunder();
    if (!all[uuid]) return null;
    fn(all[uuid]);
    saveThunder(all);
    return all[uuid];
}
function stepThunder(uuid, state, msg) {
    patchThunder(uuid, r => {
        r.state = state;
        r.steps = [...(r.steps || []), { at: Date.now(), msg: String(msg).slice(0, 400) }].slice(-200);
    });
}
const keyFileOf = (uuid) => path.join(THUNDER_KEYS, `${uuid.replace(/[^A-Za-z0-9-]/g, '')}.pem`);
function writeKey(uuid, key) {
    fs.mkdirSync(THUNDER_KEYS, { recursive: true });
    fs.writeFileSync(keyFileOf(uuid), key.endsWith('\n') ? key : key + '\n', { mode: 0o600 });
    restrictToUser(keyFileOf(uuid));
}
function forgetThunder(uuid) {
    const all = loadThunder();
    delete all[uuid];
    saveThunder(all);
    try { fs.unlinkSync(keyFileOf(uuid)); } catch { /* already gone */ }
    try { fs.unlinkSync(knownHostsOf(uuid)); } catch { /* never logged in */ }
}

// A setup cut short by closing the console is not still running.
{
    const all = loadThunder();
    let changed = false;
    for (const r of Object.values(all)) {
        if (!['ready', 'failed', 'interrupted'].includes(r.state)) {
            r.state = 'interrupted';
            r.steps = [...(r.steps || []), { at: Date.now(), msg: 'the console was closed during the setup: press Retry setup' }];
            changed = true;
        }
    }
    if (changed) saveThunder(all);
}

function startThunderSetup(uuid) {
    if (thunderTasks.has(uuid)) return;
    const task = (async () => {
        const rec = loadThunder()[uuid];
        const key = thunderKey();
        if (!fs.existsSync(keyFileOf(uuid))) {
            stepThunder(uuid, 'booting', 'no login key saved for this instance: asking Thunder for a new one');
            const r = await thunderAddKey(key, rec.id);
            if (!r?.key) throw new RunPodError('Thunder returned no login key for this instance', 502);
            writeKey(uuid, r.key);
        }
        const script = remoteScript({
            image: rec.image,
            env: thunderEnv({ podId: rec.podId, serve: rec.serve, secrets: secretsOf(loadSettings()), fetchModels: rec.fetchModels }),
        });
        const r = await setupInstance({
            apiKey: key, id: rec.id, uuid, keyFile: keyFileOf(uuid), knownHosts: knownHostsOf(uuid), script,
            step: (state, msg) => stepThunder(uuid, state, msg),
        });
        patchThunder(uuid, x => { x.user = r.user; x.error = null; });
    })().catch(e => {
        stepThunder(uuid, 'failed', e.message);
        patchThunder(uuid, x => { x.error = e.message; });
    }).finally(() => thunderTasks.delete(uuid));
    thunderTasks.set(uuid, task);
}

// Which card for these workflows: the cheapest one that fits and is in stock.
async function thunderPlan(ids) {
    const all = listWorkflows();
    const picked = ids.map(id => all.find(w => w.id === id)).filter(Boolean);
    const need = vramNeeded(picked);
    const offers = (await thunderOffers()).map(o => ({ ...o, fits: need.gb == null || o.vramGb == null ? null : o.vramGb >= need.gb }));
    const usable = (want) => offers.find(o => o.fits !== false && o.pricePerHr != null && o.availability === want);
    const downloads = downloadNeed(ids);
    downloads.minDiskGb = diskNeeded(downloads.gb);
    return { need, picked, offers, downloads, recommended: (usable('available') || usable('unclear'))?.id || null };
}

route('GET', '/api/thunder/plan', async ({ query }) => {
    const ids = String(query.get('workflows') || '').split(',').filter(Boolean);
    const { need, offers, recommended, downloads } = await thunderPlan(ids);
    return { need, offers, recommended, downloads };
});

route('POST', '/api/thunder/launch', async ({ body }) => {
    const key = thunderKey();
    const s = loadSettings();
    const secrets = secretsOf(s);
    const miss = missingSecrets(secrets);
    if (miss.length) throw new RunPodError(`save the ${miss.join(' and ')} in Settings (top right) first`, 400);
    const ids = Array.isArray(body.workflows) ? body.workflows.map(String) : [];
    const { need, picked, offers, downloads } = await thunderPlan(ids);
    // No workflow ticked: the instance starts in admin mode, as a RunPod Pod can
    // (pick a workflow in its admin panel later). Nothing is downloaded then.
    // ★ Refused before anything bills: a workflow the fresh-machine audit knows
    // cannot fetch its models would fail the whole setup after paying for it.
    if (downloads.failing.length) throw new RunPodError(`${downloads.failing.join(', ')} cannot fetch all of its models on a new machine (see tools/model-provenance/fresh-machine.cjs): untick it`, 400);
    if (picked.length !== ids.length) throw new RunPodError('a ticked workflow is not in this repo any more: reload the page', 400);
    const offer = offers.find(o => o.id === body.gpu);
    if (!offer) throw new RunPodError('pick a card', 400);
    if (offer.fits === false) throw new RunPodError(`${offer.name} has ${offer.vramGb} GB; these workflows need about ${need.gb} GB together`, 400);
    const vcpus = offer.vcpuOptions.includes(Number(body.vcpus)) ? Number(body.vcpus) : offer.vcpuOptions[0];
    const lim = offer.diskGb || { min: 100, max: 500 };
    const diskGb = Math.min(lim.max, Math.max(lim.min, Number(body.diskGb) || 200));
    if (body.fetchModels !== false && downloads.gb != null && diskGb < downloads.minDiskGb) {
        throw new RunPodError(`${diskGb} GB is too small: the image and ${downloads.gb} GB of models need at least ${downloads.minDiskGb} GB`, 400);
    }
    const image = s.image || DEFAULT_IMAGE;
    const serve = picked.map(w => w.id);
    const fetchModels = body.fetchModels !== false;
    // Refuse a password that cannot go into the env file before paying for anything.
    remoteScript({ image, env: thunderEnv({ podId: 'thunder-check', serve, secrets, fetchModels }) });

    const gpuType = offer.id.replace(/_x\d+$/, '');
    // The whole bill, not the GPU alone: extra vCPUs and disk above 100 GB cost too.
    const hourly = thunderHourly(offer, vcpus, diskGb) ?? offer.pricePerHr;
    await balanceCheck('thunder', hourly);
    let created;
    try {
        created = await thunderCreate(key, { gpuType, vcpus, diskGb });
    } catch (e) {
        recordAttempt({ action: 'launch', provider: 'thunder', name: `thunder ${serve[0]}`, gpus: [offer.name], where: 'Thunder (N. America)', result: isNoMachine(e.message) ? 'no machine' : 'error', message: e.message.slice(0, 300) });
        throw e;
    }
    const uuid = String(created?.uuid || '');
    if (!uuid) throw new RunPodError('Thunder created something but returned no uuid: check its console and delete it there if it exists', 502);
    recordAttempt({ action: 'launch', provider: 'thunder', name: `thunder ${serve[0]}`, gpus: [offer.name], where: 'Thunder (N. America)', result: 'created', podId: uuid.slice(0, 8), costPerHr: hourly });
    if (created.key) writeKey(uuid, created.key);
    const all = loadThunder();
    all[uuid] = {
        id: String(created.identifier ?? ''), uuid, podId: `thunder-${uuid.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`,
        gpu: offer.id, gpuName: offer.name, pricePerHr: hourly, vcpus, diskGb, serve, image, fetchModels,
        createdAt: Date.now(), state: 'created', steps: [{ at: Date.now(), msg: `created: ${offer.name}, ${vcpus} vCPU, ${diskGb} GB` }], error: null,
    };
    saveThunder(all);
    startThunderSetup(uuid);
    return { instance: all[uuid] };
});

route('GET', '/api/thunder/instances', async () => {
    const key = thunderKey();
    const live = await thunderInstances(key);
    const recs = loadThunder();
    // A record whose instance is gone (deleted elsewhere) is forgotten, key included;
    // a just-created one may not be listed yet.
    for (const [uuid, r] of Object.entries(recs)) {
        if (!live.some(i => i.uuid === uuid) && !thunderTasks.has(uuid) && Date.now() - (r.createdAt || 0) > 180_000) forgetThunder(uuid);
    }
    const instances = await Promise.all(live.map(async (i) => {
        const r = recs[i.uuid] || null;
        const forwarded = (i.httpPorts || []).map(Number).includes(POD_PORT);
        const base = thunderUrl(i.uuid);
        const probe = i.status === 'RUNNING' && forwarded ? await probeUrl(base) : null;
        return {
            id: i.id, uuid: i.uuid, name: i.name, status: i.status, gpuType: i.gpuType, ip: i.ip || null, createdAt: i.createdAt || null,
            forwarded, links: forwarded ? { students: base, admin: `${base}/admin`, byWorkflow: studentLinks(base, r?.serve || probe?.served?.map(w => w.id) || []) } : null,
            ours: !!r, setupRunning: thunderTasks.has(i.uuid), probe,
            rec: r && { state: r.state, error: r.error, serve: r.serve, gpuName: r.gpuName, pricePerHr: r.pricePerHr, diskGb: r.diskGb, podId: r.podId, createdAt: r.createdAt, steps: (r.steps || []).slice(-60) },
        };
    }));
    return { instances };
});

route('POST', '/api/thunder/instances/([A-Za-z0-9-]+)/setup', ({ match }) => {
    const uuid = match[1];
    if (!loadThunder()[uuid]) throw new RunPodError('this instance was not launched from this console, so it does not know what to start on it', 409);
    if (thunderTasks.has(uuid)) throw new RunPodError('its setup is already running', 409);
    patchThunder(uuid, r => { r.error = null; });
    startThunderSetup(uuid);
    return { ok: true };
});

route('POST', '/api/thunder/instances/([A-Za-z0-9-]+)/download', ({ match }) => {
    const r = loadThunder()[match[1]];
    if (!r) throw new RunPodError('this instance was not launched from this console', 409);
    const token = crypto.randomBytes(18).toString('hex');
    downloads.set(token, { base: thunderUrl(r.uuid), folderId: r.podId, until: Date.now() + 60000 });
    return { url: `/download/${token}` };
});

route('DELETE', '/api/thunder/instances/([A-Za-z0-9-]+)', async ({ match, body }) => {
    const uuid = match[1];
    if (String(body.confirm || '').trim() !== uuid.slice(0, 8)) throw new RunPodError(`type ${uuid.slice(0, 8)} to confirm`, 400);
    const key = thunderKey();
    const inst = (await thunderInstances(key)).find(i => i.uuid === uuid);
    if (inst) await thunderDelete(key, inst.id);
    forgetThunder(uuid);
    return { ok: true, deleted: !!inst };
});

// ---- spending -------------------------------------------------------------------
// See tools/runpod/spend.mjs for what each figure means and where it comes from.
const SPEND_FILE = path.join(os.homedir(), '.comfyq', 'spend-ledger.json');
function loadLedger() { try { return JSON.parse(fs.readFileSync(SPEND_FILE, 'utf8')); } catch { return emptyLedger(); } }
function saveLedger(l) {
    fs.mkdirSync(path.dirname(SPEND_FILE), { recursive: true });
    fs.writeFileSync(SPEND_FILE + '.tmp', JSON.stringify(l, null, 2));
    fs.renameSync(SPEND_FILE + '.tmp', SPEND_FILE);
}
let offersCache = { at: 0, offers: null };
async function cachedOffers() {
    if (!offersCache.offers || Date.now() - offersCache.at > 10 * 60_000) offersCache = { at: Date.now(), offers: await thunderOffers() };
    return offersCache.offers;
}
// Price any listed instance, including one started on Thunder's website.
function thunderRateOf(inst, rec, offers) {
    const key = rec?.gpu || `${String(inst.gpuType || '').toLowerCase().replace(/\s+/g, '')}_x${Number(inst.numGpus) || 1}`;
    const offer = offers?.find(o => o.id === key) || offers?.find(o => o.name === inst.gpuType);
    const rate = offer && thunderHourly(offer, rec?.vcpus ?? Number(inst.cpuCores), rec?.diskGb ?? Number(inst.storage));
    return rate ?? rec?.pricePerHr ?? null;
}

route('GET', '/api/spend', async () => {
    const s = loadSettings();
    const now = Date.now();
    const errors = [];
    let thunderLive = null, runpodBalance = null, runpodRate = null, runpodMachines = [];
    if (s.thunderApiKey) {
        try {
            const [live, offers] = await Promise.all([thunderInstances(s.thunderApiKey), cachedOffers().catch(() => null)]);
            const recs = loadThunder();
            thunderLive = live.map(i => ({
                uuid: i.uuid, name: recs[i.uuid]?.serve?.join(' + ') || i.name || i.uuid,
                gpu: i.gpuType || null, ratePerHr: thunderRateOf(i, recs[i.uuid], offers),
                start: Date.parse(i.createdAt) || recs[i.uuid]?.createdAt || now,
            }));
        } catch (e) { errors.push(`Thunder: ${e.message}`); }
    }
    if (s.runpodApiKey) {
        try {
            const [me, pods] = await Promise.all([
                graphql(s.runpodApiKey, 'query { myself { clientBalance currentSpendPerHr } }'),
                rest(s.runpodApiKey, 'GET', '/pods'),
            ]);
            runpodBalance = Number(me?.myself?.clientBalance);
            runpodRate = Number(me?.myself?.currentSpendPerHr);
            runpodMachines = (pods || []).filter(p => p.desiredStatus === 'RUNNING').map(p => ({
                id: p.id, name: p.name, gpu: p.gpu?.displayName || p.machine?.gpuTypeId || null,
                ratePerHr: Number(p.costPerHr ?? p.adjustedCostPerHr) || null,
                since: Date.parse(p.lastStartedAt) || null,
            }));
        } catch (e) { errors.push(`RunPod: ${e.message}`); }
    }
    const ledger = updateLedger(loadLedger(), { now, thunderLive, runpodBalance: Number.isFinite(runpodBalance) ? runpodBalance : null });
    saveLedger(ledger);
    const budget = Number(s.dailyBudget) > 0 ? Number(s.dailyBudget) : null;
    return { ...summarize(ledger, { now, runpodRatePerHr: Number.isFinite(runpodRate) ? runpodRate : null, runpodBalance: Number.isFinite(runpodBalance) ? runpodBalance : null, runpodMachines, budgetPerDay: budget, thunderBalance: s.thunderBalance || null }), errors };
});

// Thunder serves its balance only to its website (the billing calls answer 403
// to an API key), so the owner types in what its billing page shows; the console
// subtracts what ran on Thunder since. Empty clears it.
route('PUT', '/api/spend/thunder-balance', ({ body }) => {
    const v = body.amount === '' || body.amount == null ? null : Number(body.amount);
    if (v != null && !(v >= 0 && v < 1e6)) throw new RunPodError('enter the balance in dollars, as Thunder\'s billing page shows it', 400);
    const all = loadSettings();
    all.thunderBalance = v == null ? null : { amount: v, at: Date.now() };
    saveSettings(all);
    return { ok: true, thunderBalance: all.thunderBalance };
});

// ★ Checked before anything is created: a launch the balance cannot pay for one
// hour is refused. RunPod stops a Pod when its balance reaches zero, which in a
// class means every render running is lost.
async function balanceCheck(provider, perHr) {
    if (!(perHr > 0)) return null;
    const s = loadSettings();
    let balance = null;
    if (provider === 'runpod' && s.runpodApiKey) {
        try { balance = Number((await graphql(s.runpodApiKey, 'query { myself { clientBalance } }'))?.myself?.clientBalance); } catch { balance = null; }
    }
    if (provider === 'thunder') balance = thunderBalanceNow(loadLedger(), s.thunderBalance, Date.now())?.balance ?? null;
    if (balance == null || !Number.isFinite(balance)) return null;
    const hours = balance / perHr;
    const name = provider === 'runpod' ? 'RunPod' : 'Thunder';
    if (hours < 1) {
        throw new RunPodError(`your ${name} balance is about $${balance.toFixed(2)}: not even one hour at $${perHr.toFixed(2)}/h. Top it up first${provider === 'thunder' ? ', then type the new balance in the spending bar' : ''}.`, 402);
    }
    return { balance, hours };
}

route('PUT', '/api/spend/budget', ({ body }) => {
    const v = body.dailyBudget === '' || body.dailyBudget == null ? null : Number(body.dailyBudget);
    if (v != null && !(v >= 0 && v < 100000)) throw new RunPodError('enter a daily budget in dollars, or leave it empty', 400);
    const all = loadSettings();
    all.dailyBudget = v;
    saveSettings(all);
    return { ok: true, dailyBudget: v };
});

// Anything that is not one of the console's own files: plain text the browser
// will not run, even if it looks like HTML.
const SAFE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'no-store' };
function sendText(res, status, text) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...SAFE_HEADERS });
    res.end(String(text));
}

function send(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...SAFE_HEADERS });
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
    if (!ALLOWED_HOSTS.has(req.headers.host)) return sendText(res, 403, 'forbidden');
    const url = new URL(req.url, `http://${req.headers.host}`);

    const dl = req.method === 'GET' && url.pathname.match(/^\/download\/([a-f0-9]{36})$/);
    if (dl) return serveDownload(dl[1], res);

    if (!url.pathname.startsWith('/api/')) {
        const file = STATIC[url.pathname];
        if (req.method !== 'GET' || !file) return sendText(res, 404, 'not found');
        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(file)],
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:",
            'X-Frame-Options': 'DENY',
            'X-Content-Type-Options': 'nosniff',
        });
        return fs.createReadStream(path.join(HERE, file)).pipe(res);
    }

    if (req.headers['x-comfyq-console'] !== CONSOLE_TOKEN) return send(res, 403, { error: 'missing console header' });
    const hit = routes.map(r => ({ r, m: r.method === req.method && url.pathname.match(r.re) })).find(x => x.m);
    if (!hit) return send(res, 404, { error: 'no such route' });
    try {
        const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
        send(res, 200, await hit.r.fn({ body, query: url.searchParams, match: hit.m }));
    } catch (e) {
        const status = e instanceof RunPodError && e.status >= 400 && e.status < 600 ? e.status : 500;
        send(res, status, { error: redact(e.message) });
    }
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        let url = `http://localhost:${PORT}`;
        try { url = fs.readFileSync(URL_FILE, 'utf8').trim() || url; } catch { /* started by the app, or an old console */ }
        console.log(`Port ${PORT} is in use — the console is probably already running; opening it.`);
        openBrowser(url);
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

async function waitForSecrets() {
    if (!SECRETS_FROM_PARENT) return;
    await new Promise((resolve) => {
        const t = setTimeout(resolve, 10000);   // start without keys rather than never
        process.on('message', function onMsg(m) {
            if (m?.type !== 'secrets-init') return;
            secretCache = m.secrets || {};
            clearTimeout(t); process.off('message', onMsg); resolve();
        });
        process.send({ type: 'want-secrets' });
    });
}
await waitForSecrets();

server.listen(PORT, HOST, () => {
    // In the browser version the page learns the token from the address, once.
    const url = process.env.COMFYQ_CONSOLE_TOKEN ? `http://localhost:${PORT}` : `http://localhost:${PORT}/#t=${CONSOLE_TOKEN}`;
    if (!process.env.COMFYQ_CONSOLE_TOKEN) {
        try { fs.mkdirSync(path.dirname(URL_FILE), { recursive: true }); fs.writeFileSync(URL_FILE, url, { mode: 0o600 }); restrictToUser(URL_FILE); } catch { /* the printed link still works */ }
    }
    console.log(`ComfyQ RunPod console: ${url}  (this machine only; Ctrl+C to stop)`);
    if (process.send) process.send({ ready: true, port: PORT });
    console.log(`Credentials are kept in ${SETTINGS_FILE}`);
    openBrowser(url);
});
