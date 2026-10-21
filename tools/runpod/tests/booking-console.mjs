// node tools/runpod/tests/booking-console.mjs [--browser "<path to chrome.exe>"]
//
// Workshop bookings end to end, against a stand-in RunPod (REST + GraphQL + a
// Pod proxy): nothing is spent. The console's server runs the real booking
// loop, one tick every 400 ms instead of a minute.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-'));
let n = 0, bad = 0;
const check = (name, ok) => { n++; if (!ok) { bad++; console.log(`  FAIL ${name}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- stand-in RunPod ----
const pods = new Map();          // id -> pod
const creates = [];              // every create body
let refuseNext = 2;              // "no free machine" for the first creates
let balance = 50;
let seq = 0;
const GPUS = [
    { id: 'NVIDIA RTX A5000', displayName: 'RTX A5000', memoryInGb: 24, price: 0.16 },
    { id: 'NVIDIA GeForce RTX 3090', displayName: 'RTX 3090', memoryInGb: 24, price: 0.22 },
    { id: 'NVIDIA GeForce RTX 4080', displayName: 'RTX 4080', memoryInGb: 16, price: 0.12 },   // too small
    { id: 'NVIDIA RTX A6000', displayName: 'RTX A6000', memoryInGb: 48, price: 0.33 },
    { id: 'NVIDIA GeForce RTX 4090', displayName: 'RTX 4090', memoryInGb: 24, price: 0.69 },   // over the cap
];
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const fake = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/graphql') {
        const q = JSON.parse(raw || '{}').query || '';
        if (/myself/.test(q)) return json(res, 200, { data: { myself: { clientBalance: balance, currentSpendPerHr: 0 } } });
        if (/gpuTypes/.test(q)) return json(res, 200, { data: { gpuTypes: GPUS.map(g => ({ id: g.id, displayName: g.displayName, memoryInGb: g.memoryInGb, secureCloud: true, communityCloud: true, securePrice: g.price + 0.1, communityPrice: g.price, lowestPrice: { uninterruptablePrice: /secureCloud: false/.test(q) ? g.price : g.price + 0.1, stockStatus: null } })) } });
        return json(res, 200, { data: {} });
    }
    if (url.pathname === '/v1/pods' && req.method === 'GET') return json(res, 200, [...pods.values()]);
    if (url.pathname === '/v1/pods' && req.method === 'POST') {
        const body = JSON.parse(raw);
        creates.push(body);
        if (refuseNext > 0) { refuseNext--; return json(res, 500, { error: 'There are no longer any instances available with the requested specifications. Please refresh and try again.' }); }
        const id = `pod${++seq}`;
        const gpu = GPUS.find(g => g.id === body.gpuTypeIds[0]);
        const pod = { id, name: body.name, desiredStatus: 'RUNNING', imageName: body.imageName, env: body.env, gpu: { id: gpu.id, displayName: gpu.displayName, count: 1 }, costPerHr: gpu.price, volumeInGb: body.volumeInGb };
        pods.set(id, pod);
        return json(res, 200, pod);
    }
    let m;
    if ((m = url.pathname.match(/^\/v1\/pods\/([^/]+)$/))) {
        if (req.method === 'DELETE') { pods.delete(m[1]); return json(res, 200, {}); }
        return pods.has(m[1]) ? json(res, 200, pods.get(m[1])) : json(res, 404, { error: 'not found' });
    }
    if (url.pathname.startsWith('/vast/')) {
        if (req.headers.authorization !== 'Bearer vastkey0123456789abcdef') return json(res, 401, { error: 'bad key' });
        if (url.pathname === '/vast/users/current/') return json(res, 200, { credit: 9.5 });
        if (url.pathname === '/vast/instances/') return json(res, 200, { instances: [] });
    }
    if (url.pathname === '/v1/networkvolumes') return json(res, 200, [{ id: 'vol1', name: 'comfyq-models', dataCenterId: 'EU-RO-1', size: 100 }]);
    // ---- the Pods themselves, through the proxy: /pod/<id>/... ----
    if ((m = url.pathname.match(/^\/pod\/([^/]+)(\/.*)$/))) {
        const [, id, rest] = m;
        if (rest === '/federation/self') return json(res, 200, { mode: 'student', servedWorkflows: [{ id: 'image_sdxl_smoke_test', name: 'SDXL' }], jobs: { running: null, scheduled: [] } });
        if (rest.startsWith('/jobs')) return json(res, 200, { jobs: [{ id: 'j1', user_id: 'zaki', workflow_id: 'image_sdxl_smoke_test', status: 'completed', prompt: 'x', params: {}, outputs: [{ filename: `${id}_pic.png` }] }] });
        if (rest.startsWith('/images/')) { const b = Buffer.from(`PNG of ${id}`); res.writeHead(200, { 'Content-Length': b.length }); return res.end(b); }
        return json(res, 200, {});
    }
    json(res, 404, { error: 'no route' });
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const F = `http://127.0.0.1:${fake.address().port}`;

// ---- the console ----
fs.mkdirSync(path.join(tmp, '.comfyq'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'Desktop'));
fs.writeFileSync(path.join(tmp, '.comfyq', 'runpod-console.json'), JSON.stringify({ runpodApiKey: 'rk', adminPassword: 'admin-pw' }));
const PORT = 4793;
const TOKEN = 'bookingtesttoken0123456789';   // the page takes 16+ letters and digits
const srv = spawn(process.execPath, [path.join(ROOT, 'tools/runpod/console/server.mjs'), '--no-open'], {
    env: { ...process.env, USERPROFILE: tmp, HOME: tmp, COMFYQ_NO_EXPLORER: '1', COMFYQ_CONSOLE_PORT: String(PORT), COMFYQ_CONSOLE_TOKEN: TOKEN,
        RUNPOD_REST_URL: `${F}/v1`, RUNPOD_GRAPHQL_URL: `${F}/graphql`, COMFYQ_POD_PROXY: `${F}/pod/{id}`, COMFYQ_BOOKING_TICK_MS: '400', VAST_API_URL: `${F}/vast` },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; srv.stdout.on('data', c => log += c); srv.stderr.on('data', c => log += c);
for (let i = 0; i < 50 && !/RunPod console/.test(log); i++) await sleep(200);
const api = async (method, route, body) => {
    const r = await fetch(`http://localhost:${PORT}${route}`, { method, headers: { 'X-ComfyQ-Console': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => ({})) };
};
const booking = async (id) => (await api('GET', '/api/bookings')).data.bookings.find(b => b.id === id);
const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(200); } return false; };

try {
    // ---- refusals before anything is booked ----
    const noCap = await api('POST', '/api/bookings', { count: 2, minVramGb: 24, serve: ['image_sdxl_smoke_test'] });
    check(`a booking without a price cap is refused (${noCap.status})`, noCap.status === 400 && /price cap/.test(noCap.data.error));
    const unknown = await api('POST', '/api/bookings', { count: 1, minVramGb: 24, maxPricePerHr: 0.35, serve: ['nope'] });
    check('a workflow that does not exist is refused', unknown.status === 400 && /not in the library/.test(unknown.data.error));

    // ---- hunt for 2 machines, ≥ 24 GB, ≤ $0.35/h, Community, ending in 12 s ----
    const endAt = new Date(Date.now() + 12000).toISOString();
    const made = await api('POST', '/api/bookings', { name: 'Test workshop', count: 2, minVramGb: 24, maxPricePerHr: 0.35, cloud: 'community', serve: ['image_sdxl_smoke_test'], endAt });
    check(`a booking is created and hunting starts at once (${made.status})`, made.status === 200 && made.data.booking.state === 'active');
    const id = made.data.booking.id;
    check('it finds 2 machines, after RunPod refused the first tries', await until(async () => [...pods.values()].length === 2));
    const first = creates[0];
    check(`only the cards at ≥ 24 GB and ≤ $0.35, cheapest first (${first.gpuTypeIds})`, first.gpuTypeIds.join() === 'NVIDIA RTX A5000,NVIDIA GeForce RTX 3090,NVIDIA RTX A6000');
    check(`on Community Cloud, with no network volume, serving the workflow (${first.cloudType})`, first.cloudType === 'COMMUNITY' && !first.networkVolumeId && first.env.COMFYQ_SERVE === 'image_sdxl_smoke_test' && first.volumeInGb >= 40);
    check('named after the booking', [...pods.values()].every(p => p.name.startsWith(`comfyq-bk-${id}-`)));
    await sleep(1500);
    check(`never more machines than asked for (${pods.size})`, pods.size === 2);
    const b1 = await booking(id);
    check(`the booking says 2 of 2 and lists their student links (${b1.status})`, /2 of 2 ready/.test(b1.status) && b1.live.length === 2 && /workflow=image_sdxl_smoke_test/.test(b1.live[0].links.byWorkflow[0].url));
    check('it told about each machine found', b1.events.filter(e => e.kind === 'found').length === 2);

    // ---- a machine is lost: replaced ----
    pods.delete([...pods.keys()][0]);
    check('a lost machine is replaced', await until(async () => pods.size === 2 && [...pods.keys()].includes('pod3')));
    check('and the loss was told', (await booking(id)).events.some(e => e.kind === 'lost'));

    // ---- the end time: results saved, then terminated ----
    check('at the end time every machine is terminated', await until(async () => pods.size === 0, 20000));
    check('and the booking ends', await until(async () => (await booking(id))?.state === 'ended'));
    const saved = fs.readdirSync(path.join(tmp, 'Desktop', 'ComfyQ results'));
    check(`their results were saved first (${saved.join(', ')})`, saved.length === 2 && saved.every(d => fs.readdirSync(path.join(tmp, 'Desktop', 'ComfyQ results', d)).includes('jobs.json')));

    // ---- balance too low: no hunt ----
    balance = 1;
    const poor = await api('POST', '/api/bookings', { name: 'Poor', count: 2, minVramGb: 24, maxPricePerHr: 0.35, serve: ['image_sdxl_smoke_test'] });
    const created0 = creates.length;
    await sleep(1500);
    const pb = await booking(poor.data.booking.id);
    check(`a balance that cannot pay the day stops the hunt, and says so (${pb.blocked})`, creates.length === created0 && /balance/.test(pb.blocked || '') && pb.events.some(e => e.kind === 'blocked'));
    const stop = await api('POST', `/api/bookings/${pb.id}/stop`);
    check('a booking can be stopped', stop.data.booking.state === 'stopped');
    const del = await api('DELETE', `/api/bookings/${pb.id}`);
    check('a stopped booking can be deleted', del.status === 200 && !(await booking(pb.id)));

    // ---- no card fits: says so ----
    balance = 50;
    const none = await api('POST', '/api/bookings', { name: 'Huge', count: 1, minVramGb: 80, maxPricePerHr: 0.35, serve: [] });
    await sleep(1500);
    const nb = await booking(none.data.booking.id);
    check(`no card at 80 GB under $0.35: it says so instead of trying (${nb.blocked})`, /no card has at least 80 GB/.test(nb.blocked || '') && !creates.some(c => c.name.startsWith(`comfyq-bk-${nb.id}`)));
    await api('POST', `/api/bookings/${nb.id}/stop`);

    // ---- the Vast.ai key: saved like the others, shown only by its last 4, tested read-only ----
    const noVast = await api('POST', '/api/vast/test-key');
    check(`no Vast.ai key: says where to enter it (${noVast.status})`, noVast.status === 400 && /Settings/.test(JSON.stringify(noVast.data)));
    const vSaved = await api('PUT', '/api/settings', { vastApiKey: 'vastkey0123456789abcdef' });
    check(`the Vast.ai key is saved and shown only as …cdef (${JSON.stringify(vSaved.data.vastApiKey)})`, vSaved.data.vastApiKey?.set && vSaved.data.vastApiKey.hint === '…cdef' && !JSON.stringify(vSaved.data).includes('vastkey0123'));
    const vt = await api('POST', '/api/vast/test-key');
    check(`the Vast.ai key test reads credit and rentals (${JSON.stringify(vt.data)})`, vt.status === 200 && vt.data.credit === 9.5 && vt.data.instances === 0);
    await api('PUT', '/api/settings', { vastApiKey: 'wrongwrongwrongwrong' });
    const bad = await api('POST', '/api/vast/test-key');
    check(`a refused Vast.ai key says so, without echoing it (${bad.status})`, bad.status === 400 && /refused the key/.test(JSON.stringify(bad.data)) && !JSON.stringify(bad.data).includes('wrongwrong'));

    // ---- on shared storage: Secure, in the volume's data centre, mounting it ----
    const onVol = await api('POST', '/api/bookings', { name: 'Shared', count: 1, minVramGb: 24, maxPricePerHr: 0.5, cloud: 'community', volumeId: 'vol1', serve: ['image_sdxl_smoke_test'] });
    check(`a booking on shared storage is Secure (${onVol.data.booking?.cloud})`, onVol.status === 200 && onVol.data.booking.cloud === 'secure');
    check('its machine is found', await until(async () => [...pods.values()].some(p => p.name.startsWith(`comfyq-bk-${onVol.data.booking.id}-`))));
    const vc = creates.filter(c => c.name.startsWith(`comfyq-bk-${onVol.data.booking.id}-`)).at(-1);
    check(`it mounts the volume, on Secure Cloud, in its data centre (${vc?.cloudType} ${vc?.networkVolumeId} ${vc?.dataCenterIds})`, vc?.networkVolumeId === 'vol1' && vc.cloudType === 'SECURE' && vc.dataCenterIds?.join() === 'EU-RO-1' && !vc.volumeInGb);
    await api('POST', `/api/bookings/${onVol.data.booking.id}/stop`);

    // ---- a scheduled booking waits for its start ----
    const later = await api('POST', '/api/bookings', { name: 'Tomorrow', count: 1, minVramGb: 24, maxPricePerHr: 0.35, serve: [], startAt: new Date(Date.now() + 3600_000).toISOString() });
    await sleep(1000);
    const lb = await booking(later.data.booking.id);
    check(`a booking for later waits (${lb.status})`, lb.state === 'scheduled' && /hunting from/.test(lb.status) && !creates.some(c => c.name.startsWith(`comfyq-bk-${lb.id}`)));

    // ---- the page, in headless Chrome (optional) ----
    const bi = process.argv.indexOf('--browser');
    if (bi > 0) {
        const r = await browserCheck(process.argv[bi + 1]);
        check(`with one network volume the form picks it: Secure, in its data centre (${r.volume})`, r.volume === 'vol1' && r.cloudLocked && /Secure in EU-RO-1/.test(r.cards));
        check(`the form lists only qualifying cards, cheapest first (${r.cards})`, /RTX A5000.*RTX 3090/s.test(r.cards) && !/4090|4080|A6000/.test(r.cards));
        check(`the form says what the day costs at most (${r.summary})`, /2 × \$0\.35\/h = \$0\.70\/h/.test(r.summary));
        check(`booking from the page works and it shows in the list (${r.list.slice(0, 80)})`, r.booked && /Page booking/.test(r.list) && /hunting|ready/.test(r.list));
        check(`stock history and logs are a page of their own, not on the RunPod page (${JSON.stringify(r.logs)})`, r.logs.shown && r.logs.stock && r.logs.attempts && r.logs.thunder && !r.logs.onRunpod && r.logs.hash === '#logs');
        check(`no script error on the page (${r.errors.join(' | ')})`, r.errors.length === 0);
    }
} catch (e) {
    console.log('  BROKEN', e.stack); bad++;
} finally {
    srv.kill(); fake.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* held */ }
}
console.log(`booking console: ${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);

async function browserCheck(chrome) {
    const prof = path.join(tmp, 'chrome');
    const p = spawn(chrome, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9334', `--user-data-dir=${prof}`, '--window-size=1280,1600', 'about:blank'], { stdio: 'ignore' });
    try {
        let targets = null;
        for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch('http://127.0.0.1:9334/json')).json(); } catch { await sleep(200); } }
        const page = targets.find(t => t.type === 'page');
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise(r => ws.addEventListener('open', r, { once: true }));
        let k = 0; const pending = new Map(); const errors = [];
        ws.addEventListener('message', (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
            if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
        });
        const cdp = (method, params = {}) => new Promise(r => { const id = ++k; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
        const evalJs = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
        await cdp('Runtime.enable'); await cdp('Page.enable');
        // The browser version reads its token from the address.
        await cdp('Page.navigate', { url: `http://localhost:${PORT}/#t=${TOKEN}` });
        await sleep(2500);
        await evalJs("document.querySelector('.tabs [data-page=runpod]').click(); 1");
        await sleep(1500);
        await evalJs("document.getElementById('openBooking').click(); 1");
        await sleep(2000);
        await evalJs(`(() => { document.querySelector('[data-bwf="image_sdxl_smoke_test"]').click();
            document.getElementById('bName').value = 'Page booking';
            const c = document.getElementById('bCount'); c.value = '2'; c.dispatchEvent(new Event('change')); return 1; })()`);
        await sleep(2500);
        const cards = await evalJs("document.getElementById('bCards').innerText");
        const volume = await evalJs("document.getElementById('bVolume').value");
        const cloudLocked = await evalJs("document.getElementById('bCloud').disabled");
        const summary = await evalJs("document.getElementById('bSummary').innerText");
        await evalJs("window.confirm = () => true; document.getElementById('bBook').click(); 1");
        await sleep(2500);
        const booked = await evalJs("document.getElementById('drawer-booking').hidden");
        const list = await evalJs("document.getElementById('bookingList').innerText");
        await evalJs("document.querySelector('.tabs [data-page=logs]').click(); 1");
        await sleep(2000);
        const logs = await evalJs(`(() => { const pg = document.getElementById('page-logs');
            return { shown: !pg.hidden && document.getElementById('page-runpod').hidden, hash: location.hash,
                stock: pg.contains(document.getElementById('stockFold')) && document.getElementById('stockFold').open,
                attempts: pg.contains(document.getElementById('attemptRows')), thunder: pg.contains(document.getElementById('tAttemptRows')),
                onRunpod: !!document.querySelector('#page-runpod #stockFold, #page-runpod #attemptsFold, #page-thunder #tAttemptsFold') }; })()`);
        return { cards, summary, booked, list, errors, volume, cloudLocked, logs };
    } finally { p.kill(); }
}
process.exit(bad ? 1 : 0);
