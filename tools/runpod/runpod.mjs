#!/usr/bin/env node
// Launch, watch and stop ComfyQ Pods on RunPod from a terminal.
//
//   node tools/runpod/runpod.mjs launch --volume <id|name> --gpu "NVIDIA GeForce RTX 5090" --serve <workflow>[,<workflow>…]
//   node tools/runpod/runpod.mjs status <podId>
//   node tools/runpod/runpod.mjs list | volumes
//   node tools/runpod/runpod.mjs stop <podId> | start <podId> | terminate <podId> --yes
//
// Needs RUNPOD_API_KEY. The Pod's own settings come from the environment too —
// COMFYQ_ADMIN_PASSWORD, COMFYQ_ACCESS_PASSWORD and HF_TOKEN — and are passed
// to the Pod as environment variables, which the image applies at boot (see
// server/cloud/podPlan.js). See tools/runpod/README.md.
//
// Uses RunPod's REST API (https://rest.runpod.io/v1) and Node's own fetch: no
// dependency to install.

import {
    rest, findVolume, podBody, podGet, proxyUrl, missingSecrets, runningOnVolume, shareBlockers, cannotShare,
} from './lib.mjs';

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) { args._.push(a); continue; }
        const [k, inline] = a.slice(2).split('=', 2);
        if (inline !== undefined) args[k] = inline;
        else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[k] = argv[++i];
        else args[k] = true;
    }
    return args;
}

function die(msg) { console.error(`error: ${msg}`); process.exit(1); }

function apiKey() {
    const k = process.env.RUNPOD_API_KEY;
    if (!k) die('set RUNPOD_API_KEY (RunPod → Settings → API Keys)');
    return k;
}

const api = (method, route, body) => rest(apiKey(), method, route, body);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);
const gb = (b) => (Number(b || 0) / 1024 ** 3).toFixed(1);

// ---- commands ---------------------------------------------------------------

async function launch(args) {
    if (!args.volume) die('--volume <id|name> is required: models live on a network volume');
    if (!args.gpu) die('--gpu is required, e.g. --gpu "NVIDIA GeForce RTX 5090" (several: comma-separated, in order of preference)');
    const serve = String(args.serve || '').split(',').map(s => s.trim()).filter(Boolean);

    const secrets = {
        adminPassword: process.env.COMFYQ_ADMIN_PASSWORD,
        accessPassword: process.env.COMFYQ_ACCESS_PASSWORD,
        hfToken: process.env.HF_TOKEN || process.env.COMFYQ_HF_TOKEN,
    };
    // The Pod refuses to serve open as well; refusing here saves paying for a
    // GPU that would then sit in admin mode.
    const missing = missingSecrets(secrets);
    if (serve.length && missing.length && !args['allow-open']) {
        die('set COMFYQ_ADMIN_PASSWORD first: a Pod is reachable by anyone who has its URL, admin panel included. (--allow-open serves it open on purpose.)');
    }

    const volume = await findVolume(apiKey(), args.volume);
    const blockers = await shareBlockers(runningOnVolume(await api('GET', '/pods'), volume.id));
    if (blockers.length) die(cannotShare(blockers, volume.name));
    const body = podBody({
        volume,
        gpuTypeIds: String(args.gpu).split(',').map(s => s.trim()).filter(Boolean),
        serve, secrets,
        name: args.name, image: args.image, diskGb: args.disk,
        community: !!args.community,
        fetchModels: !args['no-fetch'],
        syncWorkflows: !!args['sync-workflows'],
        allowOpen: !!args['allow-open'] && missing.length > 0,
    });
    const env = body.env;
    console.log(`Creating a Pod on ${body.gpuTypeIds.join(' / ')} in ${volume.dataCenterId}, volume "${volume.name}" (${volume.size} GB)`);
    console.log(`  image   ${body.imageName}`);
    console.log(`  serve   ${serve.join(', ') || '(nothing — the Pod starts in admin mode)'}`);
    console.log(`  env     ${Object.keys(env).join(', ') || '(none)'}`);
    const created = await api('POST', '/pods', body);
    console.log(`Pod ${created.id} created${created.costPerHr ? ` — ${created.costPerHr} credits/hour` : ''}`);
    console.log(`  admin   ${proxyUrl(created.id)}/admin`);
    if (args['no-wait']) return;
    await watch(created.id, { serve, timeoutMin: Number(args.timeout || 120) });
}

/**
 * Follow a Pod from creation to serving: wait for ComfyQ to answer, follow
 * the model fetch, then wait for student mode with the workflows open.
 */
async function watch(podId, { serve, timeoutMin }) {
    const deadline = Date.now() + timeoutMin * 60_000;
    let last = '';
    const say = (line) => { if (line !== last) { console.log(`[${stamp()}] ${line}`); last = line; } };

    say('waiting for the Pod to answer (pulling the image takes a few minutes the first time)…');
    while (Date.now() < deadline) {
        const self = await podGet(podId, '/federation/self');
        const planRes = await podGet(podId, '/admin/pod-plan');
        const plan = planRes?.plan;

        if (!self) { await sleep(10_000); continue; }

        if (plan?.status === 'refused' || plan?.status === 'failed') {
            say(`the Pod did not start serving: ${plan.error}`);
            console.log(`  admin   ${proxyUrl(podId)}/admin`);
            console.log('  The GPU is still running and billing. Fix the cause, or stop the Pod:');
            console.log(`  node tools/runpod/runpod.mjs stop ${podId}`);
            process.exitCode = 1;
            return;
        }
        if (plan?.status === 'fetching') {
            const files = plan.files || [];
            const done = files.filter(f => f.status === 'done' || f.status === 'skipped').length;
            const cur = files.find(f => f.status === 'downloading');
            say(`fetching models: ${done}/${files.length} done`
                + (cur ? ` — ${cur.name} ${gb(cur.received)}${cur.total ? `/${gb(cur.total)}` : ''} GB` : ''));
            await sleep(10_000);
            continue;
        }

        const served = (self.servedWorkflows || []).map(w => w.id);
        if (self.mode === 'student' && serve.every(id => served.includes(id))) {
            say(`serving ${served.join(', ')} on ${self.gpu || 'the GPU'}`);
            console.log(`\n  students  ${proxyUrl(podId)}`);
            console.log(`  admin     ${proxyUrl(podId)}/admin`);
            console.log(`  stop      node tools/runpod/runpod.mjs stop ${podId}`);
            return;
        }
        if (!serve.length) {
            say(`ComfyQ is up in ${self.mode} mode`);
            console.log(`\n  admin     ${proxyUrl(podId)}/admin`);
            return;
        }
        say(self.mode === 'student'
            ? `student mode, opening the lanes (${served.join(', ') || 'none yet'})…`
            : `ComfyQ is up in ${self.mode} mode${plan ? ` — plan ${plan.status}` : ''}…`);
        await sleep(10_000);
    }
    console.log(`Gave up waiting after ${timeoutMin} minutes. The Pod is still running: check ${proxyUrl(podId)}/admin`);
    process.exitCode = 1;
}

async function status(args) {
    const id = args._[1] || die('usage: status <podId>');
    const p = await api('GET', `/pods/${id}`);
    console.log(`${p.id}  ${p.name}  ${p.desiredStatus}  ${p.gpu?.displayName || ''}  ${p.costPerHr ?? '?'} credits/hour`);
    const self = await podGet(id, '/federation/self');
    if (!self) { console.log('ComfyQ: not answering'); return; }
    console.log(`ComfyQ: ${self.mode} mode, serving ${(self.servedWorkflows || []).map(w => w.id).join(', ') || 'nothing'}`);
    const plan = (await podGet(id, '/admin/pod-plan'))?.plan;
    if (plan) {
        console.log(`plan: ${plan.status} (${plan.serve.join(', ')})${plan.error ? ` — ${plan.error}` : ''}`);
        for (const f of plan.files || []) console.log(`  ${f.status.padEnd(11)} ${f.name}${f.error ? ` — ${f.error}` : ''}`);
    }
    console.log(`admin: ${proxyUrl(id)}/admin`);
}

async function list() {
    const pods = await api('GET', '/pods');
    if (!pods.length) return console.log('no Pods');
    for (const p of pods) console.log(`${p.id}  ${p.desiredStatus.padEnd(10)} ${(p.gpu?.displayName || '').padEnd(24)} ${p.name}`);
}

async function volumes() {
    const vols = await api('GET', '/networkvolumes');
    if (!vols.length) return console.log('no network volumes');
    for (const v of vols) console.log(`${v.id}  ${String(v.size).padStart(5)} GB  ${v.dataCenterId.padEnd(10)} ${v.name}`);
}

async function simple(args, verb) {
    const id = args._[1] || die(`usage: ${verb} <podId>`);
    if (verb === 'terminate') {
        if (!args.yes) die('terminate deletes the Pod (the network volume and its models stay). Add --yes to confirm.');
        await api('DELETE', `/pods/${id}`);
        console.log(`Pod ${id} terminated`);
        return;
    }
    if (verb === 'start') {
        const p = await api('GET', `/pods/${id}`);
        const vid = p.networkVolumeId || p.networkVolume?.id;
        const blockers = vid ? await shareBlockers(runningOnVolume(await api('GET', '/pods'), vid, id)) : [];
        if (blockers.length) die(cannotShare(blockers, vid));
    }
    await api('POST', `/pods/${id}/${verb}`);
    console.log(`Pod ${id}: ${verb} requested`);
}

const HELP = `ComfyQ on RunPod

  launch --volume <id|name> --gpu "<gpu type>" [--serve <id>[,<id>…]]
         [--name <name>] [--image <image>] [--disk <GB>] [--community]
         [--no-fetch] [--sync-workflows] [--allow-open] [--no-wait] [--timeout <min>]
  status <podId>
  list
  volumes
  stop <podId>     start <podId>     terminate <podId> --yes

Environment: RUNPOD_API_KEY (required), COMFYQ_ADMIN_PASSWORD,
COMFYQ_ACCESS_PASSWORD, HF_TOKEN. See tools/runpod/README.md.`;

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const run = {
    launch: () => launch(args),
    status: () => status(args),
    list,
    volumes,
    stop: () => simple(args, 'stop'),
    start: () => simple(args, 'start'),
    terminate: () => simple(args, 'terminate'),
}[cmd];
if (!run) { console.log(HELP); process.exit(cmd && cmd !== 'help' ? 1 : 0); }
run().catch(e => die(e.message));
