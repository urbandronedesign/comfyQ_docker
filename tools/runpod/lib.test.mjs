// GPU choice and Pod body for the RunPod launcher. (node tools/runpod/lib.test.mjs)
import assert from 'assert';
import http from 'http';
import { studentLinks, vramNeeded, rankGpus, podBody, missingSecrets, listWorkflows, runningOnVolume, shareBlockers, volumeGroups, buildsOf, podImage, isNoMachine, HEADROOM_GB } from './lib.mjs';

const ok = [];
const check = (label, cond) => { assert.ok(cond, label); ok.push(label); };

// ---- student links ---------------------------------------------------------
const sl = studentLinks('https://x', ['a', 'b c']);
check('one student page per workflow, on /user (the bare / drops ?workflow on its way to /user)',
    sl.length === 2 && sl[0].url === 'https://x/user?workflow=a' && sl[0].main && !sl[1].main && sl[1].url.endsWith('workflow=b%20c'));

// ---- VRAM needed ------------------------------------------------------------
check('one workflow: its figure plus headroom', vramNeeded([{ id: 'a', vramGb: 17.5 }]).gb === 17.5 + HEADROOM_GB);
check('several: the figures add up (they are resident together)', vramNeeded([{ id: 'a', vramGb: 10 }, { id: 'b', vramGb: 8 }]).gb === 18 + HEADROOM_GB);
const unk = vramNeeded([{ id: 'a', vramGb: 10 }, { id: 'b', vramGb: null }]);
check('a workflow with no figure is named, not counted as zero silently', unk.unknown.includes('b') && unk.gb === 10 + HEADROOM_GB);
check('nothing known: no figure at all, never 0', vramNeeded([{ id: 'x', vramGb: null }]).gb === null);

// ---- ranking ----------------------------------------------------------------
const gpus = [
    { id: 'big-cheap-out', vramGb: 48, pricePerHr: 0.3, stock: 'None', secureCloud: true, communityCloud: true },
    { id: 'small', vramGb: 16, pricePerHr: 0.2, stock: 'High', secureCloud: true, communityCloud: true },
    { id: 'mid', vramGb: 24, pricePerHr: 0.7, stock: 'Low', secureCloud: true, communityCloud: true },
    { id: 'mid-cheaper', vramGb: 24, pricePerHr: 0.4, stock: 'High', secureCloud: true, communityCloud: false },
    { id: 'noprice', vramGb: 80, pricePerHr: null, stock: 'High', secureCloud: true, communityCloud: true },
];
const r = rankGpus(gpus, 20);
check('the cheapest card that fits and is in stock is recommended', r.recommended === 'mid-cheaper');
check('a card too small is marked and sorted after the ones that fit', r.rows.find(g => g.id === 'small').fits === false
    && r.rows.findIndex(g => g.id === 'small') > r.rows.findIndex(g => g.id === 'mid'));
check('a card out of stock is never recommended, however cheap', r.rows.find(g => g.id === 'big-cheap-out').available === false);
check('a card with no price is not recommended', r.recommended !== 'noprice');
check('Community Cloud drops cards it does not offer', !rankGpus(gpus, 20, { community: true }).rows.some(g => g.id === 'mid-cheaper'));
check('a card out of stock in the data centre is never recommended, even the cheapest',
    rankGpus([{ id: 'cheap', vramGb: 16, pricePerHr: 0.2, stock: 'None', secureCloud: true }, { id: 'ok', vramGb: 20, pricePerHr: 0.25, stock: 'Low', secureCloud: true }], 10).recommended === 'ok');
check('with no VRAM figure nothing is ruled out on size', rankGpus(gpus, null).rows.every(g => g.fits === null));

// ---- Pod body ---------------------------------------------------------------
const body = podBody({
    volume: { id: 'v1', dataCenterId: 'EU-RO-1' }, gpuTypeIds: ['NVIDIA GeForce RTX 4090'],
    serve: ['a', 'b'], secrets: { adminPassword: 'x', accessPassword: 'y', hfToken: 'hf' },
});
check('the GPU is pinned to the volume\'s data centre', JSON.stringify(body.dataCenterIds) === '["EU-RO-1"]');
check('the volume is mounted where the image expects it', body.networkVolumeId === 'v1' && body.volumeMountPath === '/workspace');
check('the host must support the image\'s CUDA 12.8', body.allowedCudaVersions.includes('12.8') && !body.allowedCudaVersions.includes('12.4'));
check('ComfyQ\'s port and ComfyUI\'s are exposed', body.ports.includes('3000/http') && body.ports.includes('8188/http'));
check('the workflows and secrets travel as the env the image reads',
    body.env.COMFYQ_SERVE === 'a,b' && body.env.COMFYQ_ADMIN_PASSWORD === 'x' && body.env.COMFYQ_ACCESS_PASSWORD === 'y' && body.env.COMFYQ_HF_TOKEN === 'hf');
check('nothing is switched on that was not asked for', !('COMFYQ_ALLOW_OPEN' in body.env) && !('COMFYQ_FETCH_MODELS' in body.env));
check('only the admin password is required', missingSecrets({ adminPassword: 'x' }).length === 0
    && missingSecrets({ accessPassword: 'y' }).join() === 'admin password');

// ---- no network volume: any data centre --------------------------------------------
const free = podBody({ volume: null, gpuTypeIds: ['g'], serve: ['a'], secrets: { adminPassword: 'x' }, podVolumeGb: 60 });
check('with no volume the Pod is not pinned to a data centre', !('dataCenterIds' in free) && !('networkVolumeId' in free));
check('it gets a disk of its own at /workspace, where the image keeps everything', free.volumeInGb === 60 && free.volumeMountPath === '/workspace');
check('and still downloads its models at boot (nothing turns that off)', !('COMFYQ_FETCH_MODELS' in free.env) && free.env.COMFYQ_SERVE === 'a');
check('a volume Pod gets no disk of its own', !('volumeInGb' in body));

// ---- one running Pod per volume ------------------------------------------------
const pods = [
    { id: 'p1', name: 'one', desiredStatus: 'RUNNING', networkVolumeId: 'v1' },
    { id: 'p2', name: 'two', desiredStatus: 'EXITED', networkVolumeId: 'v1' },
    { id: 'p3', name: 'three', desiredStatus: 'RUNNING', networkVolumeId: 'v2' },
];
check('a running Pod on the volume blocks another', runningOnVolume(pods, 'v1').map(p => p.id).join() === 'p1');
check('a stopped Pod does not', !runningOnVolume(pods, 'v1').some(p => p.id === 'p2'));
check('a Pod on another volume does not', runningOnVolume(pods, 'v2').map(p => p.id).join() === 'p3');
check('a Pod does not block itself (restarting it)', runningOnVolume(pods, 'v1', 'p1').length === 0);

// ---- may another Pod join? ---------------------------------------------------------
// Stand-in Pods behind a fake proxy: one on the new image (answers
// /admin/volume-pods), one on an old image (404), one not up yet (no answer).
const proxy = http.createServer((req, res) => {
    if (req.url === '/new/admin/volume-pods') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"sharedReady":true}'); }
    if (req.url === '/old/federation/self') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"mode":"student"}'); }
    if (req.url.startsWith('/old/')) { res.writeHead(404); return res.end(); }
    req.socket.destroy();
});
await new Promise(r => proxy.listen(0, '127.0.0.1', r));
process.env.COMFYQ_POD_PROXY = `http://127.0.0.1:${proxy.address().port}/{id}`;
const pod = (id) => ({ id, name: id, desiredStatus: 'RUNNING' });
check('a Pod with the download lock lets another join', (await shareBlockers([pod('new')])).length === 0);
const old = await shareBlockers([pod('new'), pod('old')]);
check('a Pod on an older image blocks it, saying so', old.length === 1 && old[0].pod.id === 'old' && /too old/.test(old[0].why));
const booting = await shareBlockers([pod('down')]);
check('a Pod not answering yet blocks it until it is up', booting.length === 1 && /not answering/.test(booting[0].why));
check('an empty volume blocks nothing', (await shareBlockers([])).length === 0);
const img = 'ghcr.io/x/comfyq:latest';
check('the Pod image is read from imageName, the field the real RunPod API returns', podImage({ imageName: img }) === img);
check('a Pod still booting the SAME image is a partner launched together, not a blocker',
    (await shareBlockers([{ ...pod('down'), imageName: img }], { image: img })).length === 0);
check('one booting a different image still blocks',
    (await shareBlockers([{ ...pod('down'), imageName: 'ghcr.io/x/comfyq:sha-old' }], { image: img })).length === 1);
check('an answering Pod without the route blocks even on the same tag (latest may be weeks old)',
    (await shareBlockers([{ ...pod('old'), imageName: img }], { image: img })).length === 1);
proxy.close();
delete process.env.COMFYQ_POD_PROXY;

// ---- Pods grouped by volume ----------------------------------------------------
const slim = [
    { id: 'a', desiredStatus: 'RUNNING', costPerHr: 0.25, networkVolume: { id: 'v1', name: 'models' } },
    { id: 'b', desiredStatus: 'RUNNING', costPerHr: 0.59, networkVolume: { id: 'v1', name: 'models' } },
    { id: 'c', desiredStatus: 'EXITED', costPerHr: 0.4, networkVolume: { id: 'v1', name: 'models' } },
    { id: 'd', desiredStatus: 'RUNNING', costPerHr: 0.3, networkVolume: null },
    { id: 'e', desiredStatus: 'EXITED', costPerHr: 0.3, networkVolume: { id: 'v2', name: 'archive' } },
];
const vg = volumeGroups(slim);
check('Pods are grouped by volume, named groups first and no volume last',
    vg.map(g => g.volume?.id || '-').join() === 'v2,v1,-');
const v1 = vg.find(g => g.volume?.id === 'v1');
check('a group counts its running Pods and adds up only their $/hour', v1.running === 2 && v1.costPerHr === 0.84 && v1.pods.length === 3);
check('a group with nothing running costs nothing', vg.find(g => g.volume?.id === 'v2').costPerHr === 0);

// ---- which build each Pod runs ------------------------------------------------------
const same = buildsOf([
    { podId: 'a', r: { image: 'sha1', others: [{ id: 'b', image: 'sha1' }] } },
    { podId: 'b', r: { image: 'sha1', others: [{ id: 'a', image: 'sha1' }] } },
]);
check('two Pods on one build: one distinct build', same.distinct.join() === 'sha1');
const mixed = buildsOf([
    { podId: 'a', r: { image: 'sha2', others: [{ id: 'b', image: 'sha1' }] } },
    { podId: 'b', r: { sharedReady: true, others: [{ id: 'a', image: 'sha2' }] } },
]);
check('a Pod too old to state its own build is known through a neighbour heartbeat',
    mixed.builds.b === 'sha1' && mixed.distinct.length === 2);
const gone = buildsOf([{ podId: 'a', r: { image: 'sha1', others: [{ id: 'ghost', image: 'sha0' }] } }, { podId: 'b', r: null }]);
check('a heartbeat from a Pod no longer running does not count', !('ghost' in gone.builds) && gone.distinct.join() === 'sha1');
check('a Pod not answering yet is unknown, never guessed', gone.builds.b === null);

// ---- "no machine free" in all its wordings ------------------------------------------
check('every wording RunPod uses for "no machine free" is recognised', [
    'create pod: could not find any pods with required specifications',
    'There are no longer any instances available with the requested specifications',
    'create pod: This machine does not have the resources to deploy your pod. Please try a different machine',
].every(isNoMachine));
check('a real fault is not mistaken for it', !isNoMachine('RunPod refused POST /pods (401): the API key is wrong'));

// ---- the real library ---------------------------------------------------------
const wfs = listWorkflows();
check('the checkout\'s workflows are listed', wfs.length > 10);
check('helper folders (_candidate_workflows) are not', !wfs.some(w => w.id.startsWith('_')));
check('most workflows carry a measured VRAM figure', wfs.filter(w => w.vramSource === 'measured').length > wfs.length / 2);

// ---- RunPod's create call refuses some listed cards (2026-10-20) ----
{
    const { acceptedGpuIds } = await import('./lib.mjs');
    const err = `RunPod refused POST /pods (400): [{"error":"x","problems":["At /pods/properties/gpuTypeIds/items/enum: value must be one of 'NVIDIA A40', 'NVIDIA L4', 'NVIDIA RTX A5000'","At ..."]}]`;
    const ids = acceptedGpuIds(err);
    check('the accepted card ids are read out of the refusal from RunPod', JSON.stringify(ids) === JSON.stringify(['NVIDIA A40', 'NVIDIA L4', 'NVIDIA RTX A5000']));
    check('any other error gives no list', acceptedGpuIds('There are no longer any instances available') === null);
    const r = rankGpus([{ id: 'NVIDIA A40', secureCloud: true, vramGb: 48, pricePerHr: 0.59, stock: 'High' },
        { id: 'NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb', secureCloud: true, vramGb: 24, pricePerHr: 0.4, stock: 'High' }], null, { accepted: ids });
    check('a card the create call refuses is not launchable, nor recommended, even with stock', r.recommended === 'NVIDIA A40' && r.rows.find(x => /MIG/.test(x.id)).available === false);
}

console.log(`runpod lib: ${ok.length} checks passed`);
