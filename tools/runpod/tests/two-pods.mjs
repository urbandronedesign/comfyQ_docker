// Phase I on real Pods (stage I7): two Pods start together on one network
// volume, serving the same workflow. Reports what each saw for the models
// (downloaded / waited for another Pod / already installed), checks that each
// lists the other in /admin/volume-pods and that pruning is refused on both,
// then runs the workflow on both at once. Both Pods are STOPPED at the end
// (not deleted). Costs two GPUs for 10–20 minutes.
//
//   node tools/runpod/tests/two-pods.mjs --volume <name> --workflow <id> --image <image>
//
// Uses the key and passwords saved by the RunPod console. Run 2026-10-19 with
// describe_gemma4_image_description (9.1 GB model) on comfyq-models.
import fs from 'fs';
import os from 'os';
import { rest, gpuTypes, rankGpus, findVolume, podBody, podProbe, podGet, proxyUrl, runningOnVolume } from '../lib.mjs';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const WF = arg('workflow'), IMAGE = arg('image'), VOLUME = arg('volume');
if (!WF || !IMAGE || !VOLUME) { console.log('usage: node two-pods.mjs --volume <name> --workflow <id> --image <image>'); process.exit(1); }
const s = JSON.parse(fs.readFileSync(`${os.homedir()}/.comfyq/runpod-console.json`, 'utf8'));
const key = s.runpodApiKey;
const secrets = { adminPassword: s.adminPassword, accessPassword: s.accessPassword, hfToken: s.hfToken };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s`, ...a);

const volume = await findVolume(key, VOLUME);
if (runningOnVolume(await rest(key, 'GET', '/pods'), volume.id).length) { log('a Pod is running on the volume — stop it first'); process.exit(1); }

async function create(label) {
    const end = Date.now() + 10 * 60_000;
    for (let i = 1; ; i++) {
        const { gpus } = await gpuTypes(key, { dataCenterId: volume.dataCenterId });
        const ids = rankGpus(gpus, 12).rows.filter(g => g.fits !== false && g.available !== false && g.pricePerHr != null).map(g => g.id);
        try {
            if (!ids.length) throw new Error('no GPU in stock');
            const pod = await rest(key, 'POST', '/pods', podBody({ volume, gpuTypeIds: ids, serve: [WF], secrets, name: `comfyq-race-${label}`, image: IMAGE }));
            log(`Pod ${label}: ${pod.id} ($${pod.costPerHr}/h)`);
            return pod;
        } catch (e) {
            if (Date.now() > end) throw e;
            if (i === 1 || i % 5 === 0) log(`${label}: no machine free yet — retrying`);
            await sleep(15_000);
        }
    }
}

const pods = {};
const seen = { A: new Set(), B: new Set() };
try {
    const [A, B] = await Promise.all([create('A'), create('B')]);
    pods.A = A; pods.B = B;

    const end = Date.now() + 35 * 60_000;
    const last = {};
    let serving = {};
    while (Date.now() < end && !(serving.A && serving.B)) {
        for (const label of ['A', 'B']) {
            if (serving[label]) continue;
            const p = await podProbe(pods[label].id);
            const f = p.plan?.files?.[0];
            if (f) seen[label].add(f.status + (f.installedBy ? '(by another Pod)' : '') + (f.waitingFor ? `(waiting for ${f.waitingFor})` : ''));
            const line = !p.answering ? 'booting' : `${p.mode}, plan ${p.plan?.status || '-'}${f ? `, ${f.name}: ${f.status}${f.waitingFor ? ' for ' + f.waitingFor : ''}${f.installedBy ? ' by another Pod' : ''}${f.total && f.status === 'downloading' ? ` ${(f.received / 1e9).toFixed(1)}/${(f.total / 1e9).toFixed(1)} GB` : ''}` : ''}`;
            if (line !== last[label]) { log(`${label}: ${line}`); last[label] = line; }
            if (p.plan?.status === 'failed' || p.plan?.status === 'refused') throw new Error(`${label}: ${p.plan.error}`);
            if (p.mode === 'student' && p.served.some(w => w.id === WF)) serving[label] = true;
        }
        await sleep(4000);
    }
    if (!(serving.A && serving.B)) throw new Error('both Pods were not serving within 35 minutes');

    log('what each Pod saw for the model:', JSON.stringify({ A: [...seen.A], B: [...seen.B] }));
    const [va, vb] = await Promise.all([podGet(A.id, '/admin/volume-pods'), podGet(B.id, '/admin/volume-pods')]);
    log('A sees on the volume:', JSON.stringify(va?.others?.map(o => ({ id: o.id, serving: o.serving, image: o.image }))));
    log('B sees on the volume:', JSON.stringify(vb?.others?.map(o => o.id)));

    for (const [label, pod] of [['A', A], ['B', B]]) {
        const r = await fetch(`${proxyUrl(pod.id)}/admin/models/prune`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Password': secrets.adminPassword || '' },
            body: JSON.stringify({ files: ['loras/nothing.safetensors'] }),
        });
        log(`${label} prune while the other runs: ${r.status} ${(await r.json().catch(() => ({}))).error?.slice(0, 140)}`);
    }

    log('captioning on both at once…');
    const cal = async (label, pod) => {
        const t = Date.now();
        try {
            const r = await fetch(`${proxyUrl(pod.id)}/workflows/${WF}/calibrate`, { method: 'POST', headers: { 'X-Admin-Password': secrets.adminPassword || '' }, signal: AbortSignal.timeout(170_000) });
            const j = await r.json().catch(() => ({}));
            return `${label}: ${r.status} in ${Math.round((Date.now() - t) / 1000)} s, cold ${j.runtime?.coldDurationSec} s, load ${j.runtime?.modelLoadSec} s${j.error ? ' — ' + j.error : ''}`;
        } catch (e) { return `${label}: ${e.message}`; }
    };
    for (const line of await Promise.all([cal('A', A), cal('B', B)])) log(line);
} catch (e) {
    log('TEST STOPPED:', e.message);
    process.exitCode = 1;
} finally {
    for (const [label, p] of Object.entries(pods)) {
        try { await rest(key, 'POST', `/pods/${p.id}/stop`); log(`stopped ${label} ${p.id}`); }
        catch (e) { log(`COULD NOT STOP ${p.id}: ${e.message}`); }
    }
}
