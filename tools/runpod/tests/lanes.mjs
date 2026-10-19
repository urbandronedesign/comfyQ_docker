// Several workflows on ONE big card, on the shared volume, driven through the
// RunPod console's own API.
//
//   node tools/runpod/tests/lanes.mjs --volume <volume id> --workflows <id>,<id> --gpus "<type>,<type>" [--wait-min 60] [--out <dir>]
//
// Waits for one of the given GPU types in the volume's data centre, launches
// ONE Pod serving all the workflows (the first as the main lane, the others
// beside it), follows the model downloads, checks every workflow is served,
// renders on all of them at the same time, saves the Pod's results as a zip,
// and STOPS the Pod at the end, whatever happens.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { proxyUrl } from '../lib.mjs';
import { loadTest } from './load.mjs';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const VOLUME = arg('volume');
const WFS = String(arg('workflows') || '').split(',').filter(Boolean);
const GPUS = String(arg('gpus') || '').split(',').map(s => s.trim()).filter(Boolean);
const WAIT_MIN = Number(arg('wait-min') || 60);
// How often to ask RunPod for the card. RunPod has no queue: a card freed
// goes to whoever asks first, so ask often (each try is one quick request).
// --volume none: Plan B, no network volume. RunPod may pick any data centre;
// the Pod downloads its models onto its own disk (--pod-disk GB) and is
// TERMINATED at the end, after its results are saved: a stopped one keeps
// billing for that disk.
const NO_VOLUME = VOLUME === 'none';
const POD_DISK = Number(arg('pod-disk') || 120);
const onOurVolume = (p) => NO_VOLUME ? !p.networkVolume : p.networkVolume?.id === VOLUME;
const RETRY_SEC = Math.max(3, Number(arg('retry-sec') || 30));
const OUT = arg('out') || os.tmpdir();
if (!VOLUME || !WFS.length || !GPUS.length) { console.log('usage: node lanes.mjs --volume <id> --workflows <id>,<id> --gpus "<type>,<type>"'); process.exit(1); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
// --students N: once every workflow has rendered once, N simulated students
// book a job each within a minute, and every job is followed to the end
// (load.mjs). Skipped if a first render failed: a broken Pod is not load-tested.
const STUDENTS = Number(arg('students') || 0);
const s = JSON.parse(fs.readFileSync(`${os.homedir()}/.comfyq/runpod-console.json`, 'utf8'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s`, ...a);

const PORT = 4792;
const consoleProc = spawn(process.execPath, [path.join(HERE, '..', 'console', 'server.mjs'), '--no-open'], {
    env: { ...process.env, COMFYQ_CONSOLE_PORT: String(PORT), COMFYQ_CONSOLE_SOURCE: 'lanes test' }, stdio: 'ignore',
});
async function api(method, route, body, timeoutMs = 900_000) {
    const r = await fetch(`http://localhost:${PORT}${route}`, {
        method, headers: { 'X-ComfyQ-Console': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return data;
}

let pod = null;
let saved = false;
async function saveResults() {
    const { url } = await api('POST', `/api/pods/${pod.id}/download`);
    const r = await fetch(`http://localhost:${PORT}${url}`, { signal: AbortSignal.timeout(600_000) });
    if (!r.ok) throw new Error(`results download ${r.status}`);
    const file = path.join(OUT, `lanes-${pod.id}-results.zip`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    saved = true;
    log(`results saved: ${file}`);
}
let tries = 0;
let seenBefore = new Set();   // Pods that existed before this run: never adopted
try {
    for (let i = 0; i < 20; i++) { try { await api('GET', '/api/settings'); break; } catch { await sleep(300); } }
    const { pods } = await api('GET', '/api/pods');
    seenBefore = new Set(pods.map(p => p.id));
    if (!NO_VOLUME && pods.some(p => p.desiredStatus === 'RUNNING' && onOurVolume(p))) throw new Error('a Pod is already running on this volume — stop it first');

    // ---- wait for the card ---------------------------------------------------------
    for (const end = Date.now() + WAIT_MIN * 60_000; !pod;) {
        try {
            // A try that hangs must not stall the hunt: give up on it after a minute.
            const r = await api('POST', '/api/launch', { volumeId: VOLUME, pods: [{ serve: WFS, gpuTypeIds: GPUS, name: 'comfyq-lanes' }], diskGb: 40, podVolumeGb: POD_DISK }, 60_000);
            pod = r.pod;
            log(`Pod ${pod.id} created on ${pod.gpu?.name || GPUS[0]} at $${pod.costPerHr}/h, serving ${WFS.join(' + ')}`);
        } catch (e) {
            // A try we gave up on may still have created the Pod on RunPod's
            // side: adopt it rather than create a second one billing too.
            const late = (await api('GET', '/api/pods').catch(() => ({ pods: [] }))).pods
                .find(p => p.name?.startsWith('comfyq-lanes') && p.desiredStatus === 'RUNNING' && onOurVolume(p) && !seenBefore.has(p.id));
            if (late) { pod = late; log(`Pod ${pod.id} turned up after a try timed out — using it ($${pod.costPerHr}/h)`); break; }
            if (Date.now() > end || !(e.status === 409 || e.status >= 500 || e.name === 'TimeoutError')) throw e;
            tries = (tries || 0) + 1;
            if (tries === 1 || tries % Math.max(1, Math.round(60 / RETRY_SEC)) === 0) {
                log(`no ${GPUS.length > 1 ? 'card of these types' : 'card'} free yet — asking every ${RETRY_SEC} s (${tries} tries, ${Math.round((end - Date.now()) / 60000)} min left)`);
            }
            await sleep(RETRY_SEC * 1000);
        }
    }

    // ---- downloads, then serving -------------------------------------------------------
    let last = '';
    let served = [];
    for (const end = Date.now() + 60 * 60_000; Date.now() < end; await sleep(8000)) {
        const d = await api('GET', `/api/pods/${pod.id}`).catch(() => null);
        const pr = d?.probe;
        const f = pr?.plan?.files?.find(x => !['done', 'present'].includes(x.status));
        const line = !pr?.answering ? 'booting' : `${pr.mode}, plan ${pr.plan?.status || '-'}${f ? `, ${f.name}: ${f.status}${f.total ? ` ${(f.received / 1e9).toFixed(1)}/${(f.total / 1e9).toFixed(1)} GB` : ''}` : ''}${pr.served?.length ? `, serving ${pr.served.map(w => w.id).join(' + ')}` : ''}`;
        if (line !== last) { log(line); last = line; }
        if (pr?.plan?.status === 'failed' || pr?.plan?.status === 'refused') throw new Error(pr.plan.error);
        served = (pr?.served || []).map(w => w.id);
        if (pr?.mode === 'student' && WFS.every(id => served.includes(id))) break;
    }
    if (!WFS.every(id => served.includes(id))) throw new Error(`not every workflow is served (serving: ${served.join(', ') || 'nothing'})`);
    log(`ALL ${WFS.length} WORKFLOWS SERVED on one card`);
    const self = await fetch(`${proxyUrl(pod.id)}/federation/self`).then(r => r.json()).catch(() => null);
    if (self) log(`GPU ${self.gpu} ${self.vramGb} GB; lanes: ${JSON.stringify((self.servedWorkflows || []).map(w => ({ id: w.id, busy: w.busy })))}`);

    // ---- render on every workflow at once ----------------------------------------------
    log('rendering on every workflow at the same time…');
    const firstOk = {};
    const runs = await Promise.all(WFS.map(async (id) => {
        const t = Date.now();
        try {
            const r = await fetch(`${proxyUrl(pod.id)}/workflows/${id}/calibrate`, { method: 'POST', headers: { 'X-Admin-Password': s.adminPassword || '' }, signal: AbortSignal.timeout(900_000) });
            const j = await r.json().catch(() => ({}));
            firstOk[id] = r.ok;
            return `${id}: ${r.status} in ${Math.round((Date.now() - t) / 1000)} s — cold ${j.runtime?.coldDurationSec} s, model load ${j.runtime?.modelLoadSec} s, generate ${j.runtime?.estimatedDurationSec} s, VRAM peak ${j.runtime?.vramPeakGb} GB${j.error ? ' — ' + j.error : ''}`;
        } catch (e) { return `${id}: ${e.message}`; }
    }));
    for (const l of runs) log(l);

    // ---- a class at once -----------------------------------------------------------------
    if (STUDENTS > 0) {
        if (WFS.every(id => firstOk[id])) {
            const summary = await loadTest({ podId: pod.id, workflows: WFS, students: STUDENTS, log });
            fs.writeFileSync(path.join(OUT, `lanes-${pod.id}-load.json`), JSON.stringify(summary, null, 2));
        } else log(`LOAD SKIPPED: a first render failed (${WFS.filter(id => !firstOk[id]).join(', ')})`);
    }

    // ---- keep the results -------------------------------------------------------------
    await saveResults();
} catch (e) {
    log('TEST STOPPED:', e.message.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 300));
    process.exitCode = 1;
} finally {
    // Plan B: terminating deletes the Pod's disk, so save what it made first,
    // even when the test broke halfway.
    if (pod && NO_VOLUME && !saved) {
        try { await saveResults(); } catch (e) { log(`results NOT saved before terminating: ${e.message}`); }
    }
    if (pod) {
        try {
            if (NO_VOLUME) { await api('DELETE', `/api/pods/${pod.id}`, { confirm: pod.id }); log(`terminated ${pod.id} (no volume: a stopped one would keep billing for its disk)`); }
            else { await api('POST', `/api/pods/${pod.id}/stop`); log(`stopped ${pod.id}`); }
        }
        catch (e) { log(`COULD NOT STOP ${pod.id}: ${e.message} — stop it on runpod.io`); }
    }
    consoleProc.kill();
}
