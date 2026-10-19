// Phase I7 on real Pods, driven through the RunPod console's own API (so the
// console's several-Pods launch, I5, and folder cleanup, I6, run for real).
//
//   node tools/runpod/tests/i7.mjs --volume <volume id> --workflow <id> [--delete <folder>,<folder>] [--max-price 1] [--single]
//
// 1. Two Pods launched in ONE console request, both needing the same missing
//    models: one downloads, the other waits for it (the lock's waiting path).
// 2. The downloading Pod is STOPPED mid-download: the waiting one must take
//    the download over and finish it intact.
// 3. Prune: refused while the other Pod is alive, allowed once it is alone.
// 4. The stopped Pod is started again: its folder came back, it serves.
// 5. Both cold-load the model at once (calibrate on both).
// 6. Builds: the console sees the same build on both.
// 7. Folders: Pods that no longer exist are listed as left behind; their
//    results are downloaded and deleted — only the folders named in --delete,
//    never whatever happens to look orphaned.
// Every Pod it created is STOPPED at the end, whatever happens.
//
// Uses the key and passwords saved by the console (~/.comfyq/runpod-console.json).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { proxyUrl } from '../lib.mjs';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const VOLUME = arg('volume'), WF = arg('workflow');
// A test does not need a $2/hour card: wait for a cheap one instead.
const MAX_PRICE = Number(arg('max-price') || 1);
// --single: one Pod only, when the data centre has too few GPUs for two.
// Checks what one Pod can: serving, prune allowed alone, a render, its folder
// and results surviving a stop and start, the folder view and cleanup.
const SINGLE = process.argv.includes('--single');
const DELETE = new Set(String(arg('delete') || '').split(',').filter(Boolean));
if (!VOLUME || !WF) { console.log('usage: node i7.mjs --volume <volume id> --workflow <id> [--delete <folder>,<folder>]'); process.exit(1); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = arg('out') || os.tmpdir();
const s = JSON.parse(fs.readFileSync(`${os.homedir()}/.comfyq/runpod-console.json`, 'utf8'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s`, ...a);
const results = {};

// The console, on a port of its own.
const PORT = 4791;
const consoleProc = spawn(process.execPath, [path.join(HERE, '..', 'console', 'server.mjs'), '--no-open'], {
    env: { ...process.env, COMFYQ_CONSOLE_PORT: String(PORT), COMFYQ_CONSOLE_SOURCE: 'I7 test' }, stdio: 'ignore',
});
async function api(method, route, body) {
    const r = await fetch(`http://localhost:${PORT}${route}`, {
        method, headers: { 'X-ComfyQ-Console': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(900_000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return data;
}
const podFetch = (id, route, opts = {}) => fetch(proxyUrl(id) + route, {
    ...opts, headers: { 'X-Admin-Password': s.adminPassword || '', 'Content-Type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout || 170_000),
});
const prune = async (id) => {
    const r = await podFetch(id, '/admin/models/prune', { method: 'POST', body: JSON.stringify({ files: ['loras/i7-nothing.safetensors'] }) });
    return `${r.status} ${((await r.json().catch(() => ({}))).error || '').slice(0, 110)}`;
};

const created = {};
try {
    for (let i = 0; i < 20; i++) { try { await api('GET', '/api/settings'); break; } catch { await sleep(300); } }
    const { pods } = await api('GET', '/api/pods');
    if (pods.some(p => p.desiredStatus === 'RUNNING' && p.networkVolume?.id === VOLUME)) throw new Error('a Pod is already running on this volume — stop it first');

    // ---- 1. two Pods in one launch ------------------------------------------------
    const plan = async () => {
        const g = await api('GET', `/api/gpus?workflows=${WF}&dataCenterId=${encodeURIComponent((await api('GET', '/api/volumes')).volumes.find(v => v.id === VOLUME).dataCenterId)}`);
        const ok = g.rows.filter(x => x.fits !== false && x.available !== false && x.pricePerHr != null && x.pricePerHr <= MAX_PRICE).map(x => x.id);
        if (!ok.length) throw Object.assign(new Error('no GPU in stock'), { status: 409 });
        return ok;
    };
    let want = SINGLE ? ['A'] : ['A', 'B'];
    for (const end = Date.now() + 15 * 60_000; want.length;) {
        try {
            const ids = await plan();
            const r = await api('POST', '/api/launch', { volumeId: VOLUME, pods: want.map(l => ({ serve: [WF], gpuTypeIds: ids, name: `comfyq-i7-${l}` })) });
            r.results.forEach((x, i) => { if (x.ok) { created[want[i]] = x.pod; log(`Pod ${want[i]}: ${x.pod.id} on ${x.pod.gpu?.name || '?'} ($${x.pod.costPerHr}/h)`); } });
            want = want.filter(l => !created[l]);
            if (want.length) log(`no machine yet for ${want.join(', ')} — retrying (the others are booting: same image, so allowed to join)`);
        } catch (e) {
            // 409: no machine / no stock. 5xx: RunPod's own API hiccuped (a Cloudflare
            // 502 page was seen). Both pass; anything else is a real fault.
            if (Date.now() > end || !(e.status === 409 || e.status >= 500)) throw e;
            log(`launch: ${e.message.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 90)} — retrying`);
        }
        if (want.length) await sleep(15_000);
    }
    const { A, B } = created;

    // ---- 1+2. watch the download; stop the downloader once the other waits -------
    const seen = { A: new Set(), B: new Set() };
    const last = {};
    let stopped = null, stoppedAt = 0, overlap = false;
    const serving = {};
    for (const end = Date.now() + 45 * 60_000; Date.now() < end;) {
        for (const [L, p] of Object.entries(created)) {
            if (serving[L] || stopped === L) continue;
            let d;
            try { d = await api('GET', `/api/pods/${p.id}`); } catch { continue; }
            const pr = d.probe;
            const f = pr?.plan?.files?.find(x => !['done', 'present'].includes(x.status)) || null;
            const files = pr?.plan?.files || [];
            for (const x of files) seen[L].add(`${x.name}:${x.status}${x.installedBy ? '(by another Pod)' : ''}`);
            const line = !pr?.answering ? 'booting' : `${pr.mode}, plan ${pr.plan?.status || '-'}${f ? `, ${f.name}: ${f.status}${f.waitingFor ? ' for ' + f.waitingFor : ''}${f.total && f.status === 'downloading' ? ` ${(f.received / 1e9).toFixed(1)}/${(f.total / 1e9).toFixed(1)} GB` : ''}` : ''}`;
            if (line !== last[L]) { log(`${L}: ${line}`); last[L] = line; }
            if (pr?.plan?.status === 'failed' || pr?.plan?.status === 'refused') throw new Error(`${L}: ${pr.plan.error}`);
            if (pr?.mode === 'student' && pr.served.some(w => w.id === WF)) { serving[L] = true; log(`${L}: SERVING`); }
        }
        // Overlap: one downloading (past 1 GB, so the stop lands mid-file) while the other waits.
        if (!stopped) {
            const st = {};
            for (const [L, p] of Object.entries(created)) {
                const pr = (await api('GET', `/api/pods/${p.id}`).catch(() => ({}))).probe;
                st[L] = pr?.plan?.files || [];
            }
            const dl = Object.keys(st).find(L => st[L].some(x => x.status === 'downloading' && x.received > 1e9 && x.total - x.received > 1e9));
            const other = dl && Object.keys(st).find(L => L !== dl && st[L].some(x => x.status === 'waiting'));
            if (dl && other) {
                overlap = true;
                const file = st[dl].find(x => x.status === 'downloading');
                log(`OVERLAP: ${dl} downloading ${file.name} (${(file.received / 1e9).toFixed(1)}/${(file.total / 1e9).toFixed(1)} GB) while ${other} waits for it — stopping ${dl} now`);
                await api('POST', `/api/pods/${created[dl].id}/stop`);
                stopped = dl; stoppedAt = Date.now();
                results.killedMidDownload = { pod: dl, file: file.name, atGb: +(file.received / 1e9).toFixed(1) };
            }
        }
        const live = Object.keys(created).filter(L => L !== stopped);
        if (live.every(L => serving[L])) break;
        await sleep(5000);
    }
    // No download to interrupt (the models were already there): stop B on
    // purpose, so prune-when-alone and stop/start still get tested.
    if (!SINGLE && !stopped && Object.keys(created).every(L => serving[L])) {
        log('no download overlap (models already on the volume) — stopping B on purpose');
        await api('POST', `/api/pods/${created.B.id}/stop`);
        stopped = 'B'; stoppedAt = Date.now();
    }
    results.overlapSeen = overlap;
    results.seen = Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, [...v]]));
    log('what each Pod saw:', JSON.stringify(results.seen));
    const survivor = Object.keys(created).find(L => L !== stopped);
    if (!serving[survivor]) throw new Error(`${survivor} did not reach serving`);
    if (stopped && overlap) results.takeoverMinutes = +((Date.now() - stoppedAt) / 60000).toFixed(1);

    // ---- 3. prune refused while another is alive, allowed when alone -----------------
    const S = created[survivor];
    if (stopped) {
        // The stopped Pod's heartbeat counts as alive for 3 minutes.
        const wait = stoppedAt + 3.5 * 60_000 - Date.now();
        if (wait > 0) { log(`waiting ${Math.round(wait / 1000)} s for ${stopped}'s heartbeat to expire`); await sleep(wait); }
        results.pruneAlone = await prune(S.id);
        log(`${survivor} prune alone: ${results.pruneAlone}`);

        // ---- 4. start the stopped Pod again ------------------------------------------
        const before = (await api('GET', `/api/volumes/${VOLUME}/folders`)).folders.find(f => f.id === created[stopped].id);
        log(`${stopped}'s folder while stopped: ${before ? `${before.kind}, ${before.files} files` : 'MISSING'}`);
        results.folderKeptWhileStopped = !!before && before.kind === 'stopped';
        await api('POST', `/api/pods/${created[stopped].id}/start`);
        log(`${stopped}: start requested`);
        for (const end = Date.now() + 25 * 60_000; Date.now() < end && !serving[stopped]; await sleep(6000)) {
            const pr = (await api('GET', `/api/pods/${created[stopped].id}`).catch(() => ({}))).probe;
            for (const x of pr?.plan?.files || []) seen[stopped].add(`after restart ${x.name}:${x.status}${x.installedBy ? '(by another Pod)' : ''}`);
            if (pr?.mode === 'student' && pr.served.some(w => w.id === WF)) { serving[stopped] = true; log(`${stopped}: SERVING again`); }
        }
        results.restartedServes = !!serving[stopped];
        results.afterRestart = [...seen[stopped]].filter(x => x.startsWith('after restart'));
    }

    if (Object.keys(created).every(L => serving[L])) {
        const ids = Object.values(created).map(p => p.id);
        // ---- 3b. prune refused with both up --------------------------------------------
        results[SINGLE ? 'pruneAlone' : 'pruneBoth'] = await Promise.all(ids.map(prune));
        log(SINGLE ? 'prune alone (should be allowed):' : 'prune with both up:', JSON.stringify(results[SINGLE ? 'pruneAlone' : 'pruneBoth']));
        // ---- 6. builds ------------------------------------------------------------------
        results.builds = await api('GET', `/api/volumes/${VOLUME}/builds`);
        log('builds:', JSON.stringify(results.builds));
        // ---- 5. both cold-load at once ----------------------------------------------------
        log('calibrating on both at once…');
        results.calibrate = await Promise.all(Object.entries(created).map(async ([L, p]) => {
            const t = Date.now();
            try {
                const r = await podFetch(p.id, `/workflows/${WF}/calibrate`, { method: 'POST', timeout: 600_000 });
                const j = await r.json().catch(() => ({}));
                return `${L}: ${r.status} in ${Math.round((Date.now() - t) / 1000)} s, cold ${j.runtime?.coldDurationSec} s, load ${j.runtime?.modelLoadSec} s, warm ${j.runtime?.estimatedDurationSec} s${j.error ? ' — ' + j.error : ''}`;
            } catch (e) { return `${L}: ${e.message}`; }
        }));
        for (const l of results.calibrate) log(l);
        // Keep what each Pod rendered, to look at: its own folder's results.
        for (const [L, p] of Object.entries(created)) {
            try {
                const { url } = await api('POST', `/api/volumes/${VOLUME}/folders/${p.id}/download`);
                const r = await fetch(`http://localhost:${PORT}${url}`);
                const file = path.join(OUT, `i7-${L}-${p.id}-results.zip`);
                fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
                log(`${L}'s render saved: ${file}`);
            } catch (e) { log(`${L}'s render not saved: ${e.message}`); }
        }
    }

    // ---- single Pod: its folder survives a stop and a start ---------------------------
    if (SINGLE && serving.A) {
        const mine = async () => (await api('GET', `/api/volumes/${VOLUME}/folders`)).folders.find(f => f.id === created.A.id);
        const before = await mine();
        log(`A's folder before stop: ${before?.files} files, ${before?.outputs} results`);
        await api('POST', `/api/pods/${created.A.id}/stop`);
        log('A: stopped; waiting for RunPod to report it stopped');
        for (let i = 0; i < 40; i++) { if ((await api('GET', `/api/pods/${created.A.id}`)).pod.desiredStatus === 'EXITED') break; await sleep(3000); }
        serving.A = false;
        let started = false;
        for (const end = Date.now() + 10 * 60_000; !started && Date.now() < end;) {
            try { await api('POST', `/api/pods/${created.A.id}/start`); started = true; log('A: start requested'); }
            catch (e) { log(`A start: ${e.message.slice(0, 100)} — retrying`); await sleep(20_000); }
        }
        for (const end = Date.now() + 20 * 60_000; started && Date.now() < end && !serving.A; await sleep(6000)) {
            const pr = (await api('GET', `/api/pods/${created.A.id}`).catch(() => ({}))).probe;
            if (pr?.mode === 'student' && pr.served.some(w => w.id === WF)) { serving.A = true; log('A: SERVING again'); }
        }
        const after = serving.A ? await mine() : null;
        log(`A's folder after restart: ${after ? `${after.files} files, ${after.outputs} results` : 'not readable'}`);
        results.restart = { started, servesAgain: !!serving.A, outputsBefore: before?.outputs, outputsAfter: after?.outputs,
            kept: !!after && after.outputs >= (before?.outputs || 0) };
    }

    // ---- 7. folders left behind ------------------------------------------------------
    const folders = (await api('GET', `/api/volumes/${VOLUME}/folders`)).folders;
    results.folders = folders.map(f => `${f.id} ${f.kind} ${(f.bytes / 1e6).toFixed(1)} MB ${f.outputs} results`);
    log('folders:', JSON.stringify(results.folders, null, 1));
    {
        for (const f of folders.filter(x => x.kind === 'orphan' && DELETE.has(x.id))) {
            if (f.outputs) {
                const { url } = await api('POST', `/api/volumes/${VOLUME}/folders/${f.id}/download`);
                const r = await fetch(`http://localhost:${PORT}${url}`);
                const buf = Buffer.from(await r.arrayBuffer());
                const file = path.join(OUT, `comfyq-pod-${f.id}-results.zip`);
                fs.writeFileSync(file, buf);
                log(`downloaded ${f.id}'s results: ${r.status}, ${(buf.length / 1e6).toFixed(1)} MB → ${file}`);
            }
            const d = await api('DELETE', `/api/volumes/${VOLUME}/folders/${f.id}`, { confirm: f.id }).catch(e => ({ error: e.message }));
            log(`delete ${f.id}: ${d.ok ? `ok, ${(d.bytes / 1e6).toFixed(1)} MB freed` : d.error}`);
        }
        // ★ Deliberately NOT tested here: deleting a stopped Pod's folder. On a
        //   real volume that folder is somebody's queue and results, and a test
        //   that deletes it if the guard fails is not worth running. The
        //   refusal is proven against a stand-in Pod (see the README).
    }
} catch (e) {
    log('TEST STOPPED:', e.message);
    process.exitCode = 1;
} finally {
    for (const [L, p] of Object.entries(created)) {
        try { await api('POST', `/api/pods/${p.id}/stop`); log(`stopped ${L} ${p.id}`); }
        catch (e) { log(`COULD NOT STOP ${p.id}: ${e.message} — stop it on runpod.io`); }
    }
    log('RESULTS', JSON.stringify(results, null, 1));
    consoleProc.kill();
}
