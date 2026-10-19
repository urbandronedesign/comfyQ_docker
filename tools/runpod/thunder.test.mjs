// Thunder Compute client, against a local stand-in. (node tools/runpod/thunder.test.mjs)
import assert from 'assert';
import http from 'http';
import { normalizeOffers, thunderOffers, thunderInstances, remoteScript, thunderEnv, setupInstance, thunderUrl } from './thunder.mjs';

const ok = [];
const check = (label, cond) => { assert.ok(cond, label); ok.push(label); };

// The shapes below are what the live API returned on 2026-10-20.
const specs = {
    a6000_x1: { displayName: 'RTX A6000', vramGB: 48, gpuCount: 1, vcpuOptions: [6, 8], storageGB: { min: 100, max: 500 } },
    l40_x1: { displayName: 'NVIDIA L40', vramGB: 48, gpuCount: 1, vcpuOptions: [6, 8, 12], storageGB: { min: 100, max: 500 } },
    l40_x2: { displayName: 'NVIDIA L40', vramGB: 48, gpuCount: 2 },
    h100_x1: { displayName: 'NVIDIA H100', vramGB: 80, gpuCount: 1 },
    a100xl_x1: { displayName: 'NVIDIA A100 (80GB)', vramGB: 80, gpuCount: 1 },
};
const pricing = { a6000_x1: 0.35, l40_x1: 0.79, l40_x2: 1.58, h100_x1: 3.2, a100xl: 1.09 };
const status = {
    gpu_type: { a6000: { 1: 'available' }, h100: { 1: 'unavailable' }, a100xl: { 1: 'available' } },
    specs: { a6000_x1: 'unavailable', l40_x1: 'available', h100_x1: 'unavailable', a100xl_x1: 'available' },
};

const rows = normalizeOffers({ specs, pricing, status });
const by = Object.fromEntries(rows.map(r => [r.id, r]));
check('only single-GPU configurations are listed', !by.l40_x2 && rows.length === 4);
check('cheapest first', rows[0].id === 'a6000_x1' && rows.at(-1).id === 'h100_x1');
check('the two availability signals agreeing: available', by.l40_x1.availability === 'available' && by.a100xl_x1.availability === 'available');
check('both saying none free: unavailable', by.h100_x1.availability === 'unavailable');
check('signals disagreeing read as unclear, never as available', by.a6000_x1.availability === 'unclear');
check('a price missing for the config falls back to the type price', by.a100xl_x1.pricePerHr === 1.09);
check('no status at all: unknown, not available', normalizeOffers({ specs, pricing }).every(r => r.availability === 'unknown'));

// ---- the script run on the instance -------------------------------------------
const env = thunderEnv({ podId: 'thunder-abc', serve: ['wf_a', 'wf_b'], secrets: { adminPassword: 'p$w "x', hfToken: 'hf_123' }, fetchModels: false });
check('env: pod folder, serve list, secrets, no-fetch flag', env.COMFYQ_POD_ID === 'thunder-abc' && env.COMFYQ_SERVE === 'wf_a,wf_b'
    && env.COMFYQ_ADMIN_PASSWORD === 'p$w "x' && env.COMFYQ_HF_TOKEN === 'hf_123' && env.COMFYQ_FETCH_MODELS === '0' && !('COMFYQ_ACCESS_PASSWORD' in env));
const script = remoteScript({ image: 'ghcr.io/urbandronedesign/comfyq:latest', env });
check('the GPU goes in the only way Thunder supports', script.includes('--device nvidia.com/gpu=all') && !/--gpus/.test(script));
check('the secrets go through a quoted heredoc into an env file, never a command line',
    script.includes("<<'COMFYQ_ENV_EOF'") && script.includes('COMFYQ_ADMIN_PASSWORD=p$w "x') && script.includes('--env-file "$ENVF"') && !/ -e COMFYQ_/.test(script));
check('port 3000 is published and /workspace is the instance disk', script.includes('-p 3000:3000') && script.includes('-v "$WS:/workspace"'));
check('a leftover ComfyUI is stopped before starting again', script.indexOf('pkill -f /opt/ComfyUI/main.py') < script.indexOf('start --shm-size'));
let bad = null;
try { remoteScript({ image: 'x:y', env: { COMFYQ_ADMIN_PASSWORD: 'a\nCOMFYQ_ENV_EOF\nrm -rf /' } }); } catch (e) { bad = e; }
check('a value with a line break is refused (it would end the env file)', bad?.status === 400);
bad = null;
try { remoteScript({ image: 'img; rm -rf /', env: {} }); } catch (e) { bad = e; }
check('an image name with shell characters is refused', bad?.status === 400);
check('the public address is built from the uuid', thunderUrl('u-1') === 'https://u-1-3000.thundercompute.net');

// ---- setup sequence -------------------------------------------------------------
{
    const states = ['QUEUED', 'STARTING', 'RUNNING'];
    let polls = 0;
    const list = async () => [{ id: '4', uuid: 'U', status: states[Math.min(polls++, 2)], ip: polls > 2 ? '1.2.3.4' : null, port: 2222 }];
    const calls = [];
    const ssh = async (o) => { calls.push(o); if (o.user === 'ubuntu') return 255; if (o.input === 'true\n') return 0; o.onLine('[comfyq] started'); return 0; };
    const fwd = [];
    const steps = [];
    const r = await setupInstance({ apiKey: 'k', id: '4', uuid: 'U', keyFile: 'kf', knownHosts: 'kh', script: 'SCRIPT', list, ssh,
        forward: async (k, id, ports) => fwd.push([id, ports]), wait: async () => {}, step: (s, m) => steps.push(s) });
    check('setup waits through QUEUED/STARTING until RUNNING with an address', polls >= 3 && r.ip === '1.2.3.4');
    check('ubuntu refused: root is tried, and the script runs as the user that worked', r.user === 'root' && calls.at(-1).input === 'SCRIPT' && calls.at(-1).user === 'root' && calls.at(-1).port === 2222);
    check('port 3000 is forwarded on the instance id', fwd.length === 1 && fwd[0][0] === '4' && fwd[0][1][0] === 3000);
    check('it reports booting, connecting, installing, ready in that order', ['booting', 'connecting', 'installing', 'ready'].every((s, i, a) => steps.indexOf(s) >= 0 && (i === 0 || steps.indexOf(s) > steps.indexOf(a[i - 1]))));
}
{
    let err = null;
    try {
        await setupInstance({ apiKey: 'k', id: '1', uuid: 'U', keyFile: 'kf', knownHosts: 'kh', script: 'S', wait: async () => {},
            list: async () => [{ id: '1', uuid: 'U', status: 'RUNNING', ip: '1.1.1.1', port: 22 }],
            ssh: async (o) => o.input === 'S' ? 20 : 0, forward: async () => { throw new Error('must not open the port'); } });
    } catch (e) { err = e; }
    check('Docker not answering is reported in words, and the port is not opened', /Docker does not answer/.test(err?.message || ''));
}
{
    let err = null;
    try {
        await setupInstance({ apiKey: 'k', id: '1', uuid: 'U', keyFile: 'kf', knownHosts: 'kh', script: 'S', wait: async () => {},
            list: async () => [], ssh: async () => 0, forward: async () => {} });
    } catch (e) { err = e; }
    check('an instance deleted during setup stops it with a plain message', err?.status === 404);
}

// ---- over HTTP --------------------------------------------------------------
let lastAuth = null;
const srv = http.createServer((req, res) => {
    lastAuth = req.headers.authorization || null;
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/v2/specs') return send(200, { specs });
    if (req.url === '/v2/pricing') return send(200, { pricing });
    if (req.url === '/v2/status') return send(200, status);
    if (req.url.split('?')[0] === '/v1/instances/list') {
        if (req.headers.authorization !== 'Bearer good') return send(401, { code: 401, error: 'unauthorized', message: 'invalid token' });
        return send(200, { 0: { uuid: 'u-0', status: 'RUNNING', gpuType: 'a6000' }, 7: { id: '7', uuid: 'u-7' } });
    }
    send(404, {});
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
process.env.THUNDER_API_URL = `http://127.0.0.1:${srv.address().port}`;

const live = await thunderOffers();
check('offers are read from the three public endpoints', live.length === 4);
check('public endpoints are called without a key', lastAuth === null);
const inst = await thunderInstances('good');
check('instances: the id comes from the map key when the item lacks one', inst.map(i => i.id).sort().join() === '0,7');
let err = null;
try { await thunderInstances('bad'); } catch (e) { err = e; }
check('a wrong key is a 401 with a plain hint', err?.status === 401 && /wrong or has been revoked/.test(err.message));
let none = null;
try { await thunderInstances(''); } catch (e) { none = e; }
check('an empty key is refused before any request', none?.status === 401);

srv.close();
console.log(`thunder.test: ${ok.length} checks passed`);
