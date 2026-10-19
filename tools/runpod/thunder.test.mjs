// Thunder Compute client, against a local stand-in. (node tools/runpod/thunder.test.mjs)
import assert from 'assert';
import http from 'http';
import { normalizeOffers, thunderOffers, thunderInstances } from './thunder.mjs';

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

// ---- over HTTP --------------------------------------------------------------
let lastAuth = null;
const srv = http.createServer((req, res) => {
    lastAuth = req.headers.authorization || null;
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/v2/specs') return send(200, { specs });
    if (req.url === '/v2/pricing') return send(200, { pricing });
    if (req.url === '/v2/status') return send(200, status);
    if (req.url === '/v1/instances/list') {
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
