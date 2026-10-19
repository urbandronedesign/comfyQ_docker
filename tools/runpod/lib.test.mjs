// GPU choice and Pod body for the RunPod launcher. (node tools/runpod/lib.test.mjs)
import assert from 'assert';
import { vramNeeded, rankGpus, podBody, missingSecrets, listWorkflows, HEADROOM_GB } from './lib.mjs';

const ok = [];
const check = (label, cond) => { assert.ok(cond, label); ok.push(label); };

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

// ---- the real library ---------------------------------------------------------
const wfs = listWorkflows();
check('the checkout\'s workflows are listed', wfs.length > 10);
check('helper folders (_candidate_workflows) are not', !wfs.some(w => w.id.startsWith('_')));
check('most workflows carry a measured VRAM figure', wfs.filter(w => w.vramSource === 'measured').length > wfs.length / 2);

console.log(`runpod lib: ${ok.length} checks passed`);
