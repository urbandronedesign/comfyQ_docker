#!/usr/bin/env node
// Phase I, stage 0: put two Pods on one network volume, run stage0.py on
// both, print what the volume did, and terminate both Pods.
//
//   node tools/runpod/stage0/run.mjs --volume <id|name> [--ref <git commit>] [--keep]
//
// The Pods run a small public Python image (no GPU work, no ComfyQ), the
// cheapest GPU in stock in the volume's data centre, and fetch stage0.py from
// GitHub at a pinned commit — so that commit must be pushed. Everything they
// write lives under /workspace/_stage0/<run id>/; the big test files are
// deleted at the end. Read-only towards the models: the throughput test reads
// the largest model on the volume and writes nothing near it.
//
// Uses RUNPOD_API_KEY, or the key saved by the RunPod console.

import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { rest, gpuTypes, rankGpus, findVolume, proxyUrl } from '../lib.mjs';

const REPO = 'urbandronedesign/comfyQ_docker';
const IMAGE = 'python:3.12-slim';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return acc;
}, []));

const die = (m) => { console.error(`error: ${m}`); process.exit(1); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);

function apiKey() {
    if (process.env.RUNPOD_API_KEY) return process.env.RUNPOD_API_KEY;
    try { return JSON.parse(fs.readFileSync(`${os.homedir()}/.comfyq/runpod-console.json`, 'utf8')).runpodApiKey; }
    catch { return null; }
}

const key = apiKey() || die('no RunPod API key: set RUNPOD_API_KEY or save one in the RunPod console');
if (!args.volume) die('--volume <id|name> is required');

const ref = args.ref || execSync('git rev-parse HEAD').toString().trim();
const scriptUrl = `https://raw.githubusercontent.com/${REPO}/${ref}/tools/runpod/stage0/stage0.py`;
const head = await fetch(scriptUrl, { method: 'HEAD' });
if (!head.ok) die(`stage0.py is not at ${scriptUrl} (${head.status}). Push the commit first, or pass --ref.`);

const volume = await findVolume(key, args.volume);
const { gpus, scopedToDataCenter } = await gpuTypes(key, { dataCenterId: volume.dataCenterId });
const ranked = rankGpus(gpus, 1);
const choice = ranked.rows.filter(g => g.available !== false && g.pricePerHr != null).slice(0, 5);
if (!choice.length) die(`no GPU in stock in ${volume.dataCenterId} right now`);
if (!scopedToDataCenter) console.log('note: stock is RunPod-wide, not for the volume\'s data centre');

const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}`;
const bootstrap = `import urllib.request;exec(compile(urllib.request.urlopen(${JSON.stringify(scriptUrl)}).read(),'stage0.py','exec'))`;
const body = (role) => ({
    name: `comfyq-stage0-${role}`,
    imageName: IMAGE,
    gpuTypeIds: choice.map(g => g.id),
    gpuCount: 1,
    cloudType: 'SECURE',
    networkVolumeId: volume.id,
    volumeMountPath: '/workspace',
    dataCenterIds: [volume.dataCenterId],
    containerDiskInGb: 10,
    ports: ['3000/http'],
    dockerEntrypoint: ['python', '-u', '-c', bootstrap],
    dockerStartCmd: [],
    env: { ROLE: role, RUN_ID: runId },
});

console.log(`Stage 0 on volume "${volume.name}" (${volume.dataCenterId}), run ${runId}`);
console.log(`GPUs accepted, cheapest first: ${choice.map(g => `${g.name} $${g.pricePerHr}`).join(', ')}`);

const pods = [];
let finished = false;
async function terminateAll(reason) {
    if (args.keep) { console.log(`--keep: Pods left running: ${pods.map(p => p.id).join(', ')}`); return; }
    for (const p of pods) {
        try { await rest(key, 'DELETE', `/pods/${p.id}`); console.log(`terminated ${p.id} (${reason})`); }
        catch (e) { console.log(`COULD NOT TERMINATE ${p.id}: ${e.message} — delete it on runpod.io, it is billing`); }
    }
}
process.on('SIGINT', async () => { console.log('\ninterrupted'); await terminateAll('interrupted'); process.exit(130); });

const fetchJson = async (podId, file) => {
    try {
        const r = await fetch(`${proxyUrl(podId)}/${file}`, { signal: AbortSignal.timeout(10000) });
        return r.ok ? await r.json() : null;
    } catch { return null; }
};

try {
    for (const role of ['A', 'B']) {
        const p = await rest(key, 'POST', '/pods', body(role));
        pods.push(p);
        console.log(`Pod ${role}: ${p.id} on ${p.gpu?.displayName || '?'} — $${p.costPerHr ?? '?'}/h`);
    }
    const deadline = Date.now() + Number(args.timeout || 45) * 60_000;
    let last = '';
    while (Date.now() < deadline) {
        await sleep(10_000);
        const [sa, sb] = await Promise.all(pods.map((p, i) => fetchJson(p.id, `status-${'AB'[i]}.json`)));
        const line = `A: ${sa?.phase || 'booting'} | B: ${sb?.phase || 'booting'}`;
        if (line !== last) { console.log(`[${stamp()}] ${line}`); last = line; }
        for (const s of [sa, sb]) if (s?.error) throw new Error(`Pod ${s.role} failed: ${s.error}\n${s.trace || ''}`);
        if (sa?.phase === 'done') {
            const summary = await fetchJson(pods[0].id, 'summary.json');
            if (summary) { report(summary); finished = true; break; }
        }
    }
    if (!finished) throw new Error(`no result after ${args.timeout || 45} minutes`);
} catch (e) {
    console.log(`\nStage 0 did not finish: ${e.message}`);
    process.exitCode = 1;
} finally {
    await terminateAll(finished ? 'finished' : 'stopped');
}

function report(r) {
    const ok = (b) => (b ? 'PASS' : 'FAIL');
    const v = r.visibility, x = r.exclusive, n = r.rename, t = r.throughput;
    console.log('\n=== Stage 0 results ===');
    console.log(`mount       ${ok(r.mount?.ok)}  (A waited ${r.mount?.waitedForOtherSec}s for B to boot)`);
    console.log(`visibility  one-way median ${v?.oneWayMedianMs} ms, worst ${v?.oneWayWorstMs} ms over ${v?.rounds} rounds`);
    console.log(`exclusive   ${ok(x?.ok)}  ${x?.attempts} races: A won ${x?.winsA}, B won ${x?.winsB}, both won ${x?.bothWon}, nobody ${x?.nobodyWon}, wrong owner ${x?.ownerMismatch}${x?.errors?.length ? `, errors: ${x.errors.join('; ')}` : ''}`);
    console.log(`rename      ${ok(n?.ok)}  ${n?.newFilesRead} new files read, ${n?.partialOrCorruptNew} partial; ${n?.replacedReads} reads of a replaced file, ${n?.mixedOrPartialReplaced} mixed`);
    if (t) {
        console.log(`throughput  write A ${t.writeMBps} MB/s, B ${t.B?.writeMBps} MB/s`);
        console.log(`            one Pod reading alone: ${t.readAlone?.MBps} MB/s (${t.readAlone?.gb} GB)`);
        const ra = t.readTogether, rb = t.B?.readTogether;
        console.log(ra?.skipped ? `            both reading: skipped (${ra.skipped})`
            : `            both reading ${ra?.file} at once: A ${ra?.MBps} MB/s, B ${rb?.MBps} MB/s`);
    }
    console.log('\nFull results are on the volume under /workspace/_stage0/' + runId + '/');
}
