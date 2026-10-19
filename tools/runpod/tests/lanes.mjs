// Workflows served on RunPod, driven through the RunPod console's own API:
// either all of them on ONE card (the default), or one Pod per workflow
// (--split). Then optionally a class of simulated students.
//
//   node tools/runpod/tests/lanes.mjs --volume <volume id|none> --workflows <id>,<id> --gpus "<type>,<type>"
//        [--split] [--students 20] [--wait-min 60] [--retry-sec 5] [--pod-disk 120] [--out <dir>]
//
// Waits for the GPUs (asking every --retry-sec), launches the Pods, follows
// the model downloads, checks every workflow is served, renders on all of them
// at the same time, runs the students (load.mjs), saves each Pod's results as
// a zip, and at the end STOPS each Pod — or TERMINATES it with --volume none,
// where a stopped Pod keeps billing for its own disk — whatever happens.
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
// How often to ask RunPod for the cards. RunPod has no queue: a card freed
// goes to whoever asks first, so ask often (each try is one quick request).
const RETRY_SEC = Math.max(3, Number(arg('retry-sec') || 30));
// --volume none: Plan B, no network volume. RunPod may pick any data centre;
// each Pod downloads its models onto its own disk (--pod-disk GB).
const NO_VOLUME = VOLUME === 'none';
const POD_DISK = Number(arg('pod-disk') || 120);
const SPLIT = process.argv.includes('--split');
// --students N: once every workflow has rendered once, N simulated students
// book a job each within a minute (load.mjs). Skipped if a first render failed.
const STUDENTS = Number(arg('students') || 0);
const OUT = arg('out') || os.tmpdir();
if (!VOLUME || !WFS.length || !GPUS.length) { console.log('usage: node lanes.mjs --volume <id|none> --workflows <id>,<id> --gpus "<type>,<type>" [--split]'); process.exit(1); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const s = JSON.parse(fs.readFileSync(`${os.homedir()}/.comfyq/runpod-console.json`, 'utf8'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s`, ...a);
const onOurVolume = (p) => NO_VOLUME ? !p.networkVolume : p.networkVolume?.id === VOLUME;

const PORT = 4792;
const consoleProc = spawn(process.execPath, [path.join(HERE, '..', 'console', 'server.mjs'), '--no-open'], {
    env: { ...process.env, COMFYQ_CONSOLE_PORT: String(PORT), COMFYQ_CONSOLE_SOURCE: SPLIT ? 'split test' : 'lanes test' }, stdio: 'ignore',
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

// One unit = one Pod and the workflows it serves.
const units = (SPLIT ? WFS.map(w => [w]) : [WFS]).map((serve, i) => ({
    name: SPLIT ? `comfyq-split-${i + 1}` : 'comfyq-lanes', serve, pod: null, serving: false, saved: false,
}));
const label = (u) => `${u.name} (${u.serve.join(' + ')})`;

async function saveResults(u) {
    const { url } = await api('POST', `/api/pods/${u.pod.id}/download`);
    const r = await fetch(`http://localhost:${PORT}${url}`, { signal: AbortSignal.timeout(600_000) });
    if (!r.ok) throw new Error(`results download ${r.status}`);
    const file = path.join(OUT, `${u.name}-${u.pod.id}-results.zip`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    u.saved = true;
    log(`${u.name}: results saved: ${file}`);
}

let tries = 0;
let seenBefore = new Set();   // Pods that existed before this run: never adopted
try {
    for (let i = 0; i < 20; i++) { try { await api('GET', '/api/settings'); break; } catch { await sleep(300); } }
    const { pods } = await api('GET', '/api/pods');
    seenBefore = new Set(pods.map(p => p.id));
    if (!NO_VOLUME && pods.some(p => p.desiredStatus === 'RUNNING' && onOurVolume(p))) throw new Error('a Pod is already running on this volume — stop it first');

    // ---- wait for the cards ------------------------------------------------------------
    // All missing Pods are asked for in one request; those created start booting
    // while the rest are asked for again.
    for (const end = Date.now() + WAIT_MIN * 60_000; units.some(u => !u.pod);) {
        const want = units.filter(u => !u.pod);
        try {
            // A try that hangs must not stall the hunt: give up on it after a minute.
            const r = await api('POST', '/api/launch', {
                volumeId: VOLUME, pods: want.map(u => ({ serve: u.serve, gpuTypeIds: GPUS, name: u.name })), diskGb: 40, podVolumeGb: POD_DISK,
            }, 60_000);
            r.results.forEach((x, i) => {
                if (!x.ok) return;
                want[i].pod = x.pod;
                log(`${label(want[i])}: Pod ${x.pod.id} created at $${x.pod.costPerHr}/h`);
            });
        } catch (e) {
            if (Date.now() > end || !(e.status === 409 || e.status >= 500 || e.name === 'TimeoutError')) throw e;
        }
        // A try we gave up on may still have created a Pod on RunPod's side:
        // adopt it rather than create a second one billing too.
        const now = (await api('GET', '/api/pods').catch(() => ({ pods: [] }))).pods;
        for (const u of units.filter(x => !x.pod)) {
            const late = now.find(p => p.name?.startsWith(u.name) && p.desiredStatus === 'RUNNING' && onOurVolume(p) && !seenBefore.has(p.id) && !units.some(o => o.pod?.id === p.id));
            if (late) { u.pod = late; log(`${label(u)}: Pod ${late.id} turned up after a try timed out — using it`); }
        }
        if (units.every(u => u.pod)) break;
        if (Date.now() > end) throw new Error(`no card for ${units.filter(u => !u.pod).map(label).join(', ')} within ${WAIT_MIN} min`);
        tries++;
        if (tries === 1 || tries % Math.max(1, Math.round(60 / RETRY_SEC)) === 0) {
            log(`still missing ${units.filter(u => !u.pod).length} of ${units.length} Pod(s) — asking every ${RETRY_SEC} s (${tries} tries, ${Math.round((end - Date.now()) / 60000)} min left)`);
        }
        await sleep(RETRY_SEC * 1000);
    }

    // ---- downloads, then serving -------------------------------------------------------
    const last = {};
    for (const end = Date.now() + 60 * 60_000; Date.now() < end && !units.every(u => u.serving); await sleep(8000)) {
        for (const u of units.filter(x => !x.serving)) {
            const pr = (await api('GET', `/api/pods/${u.pod.id}`).catch(() => null))?.probe;
            const f = pr?.plan?.files?.find(x => !['done', 'present'].includes(x.status));
            const line = !pr?.answering ? 'booting' : `${pr.mode}, plan ${pr.plan?.status || '-'}${f ? `, ${f.name}: ${f.status}${f.total ? ` ${(f.received / 1e9).toFixed(1)}/${(f.total / 1e9).toFixed(1)} GB` : ''}` : ''}${pr.served?.length ? `, serving ${pr.served.map(w => w.id).join(' + ')}` : ''}`;
            if (line !== last[u.name]) { log(`${u.name}: ${line}`); last[u.name] = line; }
            if (pr?.plan?.status === 'failed' || pr?.plan?.status === 'refused') throw new Error(`${u.name}: ${pr.plan.error}`);
            const served = (pr?.served || []).map(w => w.id);
            if (pr?.mode === 'student' && u.serve.every(id => served.includes(id))) { u.serving = true; log(`${label(u)}: SERVING`); }
        }
    }
    if (!units.every(u => u.serving)) throw new Error(`not served within an hour: ${units.filter(u => !u.serving).map(label).join(', ')}`);
    log(`ALL ${WFS.length} WORKFLOWS SERVED on ${units.length} Pod(s)`);
    for (const u of units) {
        const self = await fetch(`${proxyUrl(u.pod.id)}/federation/self`).then(r => r.json()).catch(() => null);
        if (self) log(`${u.name}: GPU ${self.gpu} ${self.vramGb} GB`);
    }

    // ---- render on every workflow at once ----------------------------------------------
    log('rendering on every workflow at the same time…');
    const targets = units.flatMap(u => u.serve.map(workflow => ({ podId: u.pod.id, workflow })));
    const firstOk = {};
    const runs = await Promise.all(targets.map(async ({ podId, workflow: id }) => {
        const t = Date.now();
        try {
            const r = await fetch(`${proxyUrl(podId)}/workflows/${id}/calibrate`, { method: 'POST', headers: { 'X-Admin-Password': s.adminPassword || '' }, signal: AbortSignal.timeout(900_000) });
            const j = await r.json().catch(() => ({}));
            firstOk[id] = r.ok;
            return `${id}: ${r.status} in ${Math.round((Date.now() - t) / 1000)} s — cold ${j.runtime?.coldDurationSec} s, model load ${j.runtime?.modelLoadSec} s, generate ${j.runtime?.estimatedDurationSec} s, VRAM peak ${j.runtime?.vramPeakGb} GB${j.error ? ' — ' + j.error : ''}`;
        } catch (e) { return `${id}: ${e.message}`; }
    }));
    for (const l of runs) log(l);

    // ---- a class at once -----------------------------------------------------------------
    if (STUDENTS > 0) {
        if (WFS.every(id => firstOk[id])) {
            const summary = await loadTest({ targets, students: STUDENTS, log });
            fs.writeFileSync(path.join(OUT, `${units[0].name}-load.json`), JSON.stringify(summary, null, 2));
        } else log(`LOAD SKIPPED: a first render failed (${WFS.filter(id => !firstOk[id]).join(', ')})`);
    }

    // ---- keep the results -------------------------------------------------------------
    for (const u of units) await saveResults(u).catch(e => log(`${u.name}: results NOT saved: ${e.message}`));
} catch (e) {
    log('TEST STOPPED:', e.message.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 300));
    process.exitCode = 1;
} finally {
    for (const u of units.filter(x => x.pod)) {
        // Plan B: terminating deletes the Pod's disk, so save what it made
        // first, even when the test broke halfway.
        if (NO_VOLUME && !u.saved) {
            try { await saveResults(u); } catch (e) { log(`${u.name}: results NOT saved before terminating: ${e.message}`); }
        }
        try {
            if (NO_VOLUME) { await api('DELETE', `/api/pods/${u.pod.id}`, { confirm: u.pod.id }); log(`${u.name}: terminated ${u.pod.id} (no volume: a stopped one would keep billing for its disk)`); }
            else { await api('POST', `/api/pods/${u.pod.id}/stop`); log(`${u.name}: stopped ${u.pod.id}`); }
        } catch (e) { log(`COULD NOT STOP ${u.pod.id}: ${e.message} — stop it on runpod.io`); }
    }
    consoleProc.kill();
}
