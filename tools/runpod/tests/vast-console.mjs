#!/usr/bin/env node
// The console's Vast.ai page end to end, against stand-ins: a fake Vast.ai API
// and a fake ComfyQ on the rented machine. Nothing real is called or spent.
//
//   node tools/runpod/tests/vast-console.mjs
//   node tools/runpod/tests/vast-console.mjs --browser "<path to chrome.exe>"
//     also drives the page in headless Chrome: search, pick, rent, list, destroy.
//
// The console's home folder is a temporary directory: ~/.comfyq is never touched.

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-console-'));
fs.mkdirSync(path.join(tmp, '.comfyq'));
const KEY = 'vastkey0123456789abcdef';
fs.writeFileSync(path.join(tmp, '.comfyq', 'runpod-console.json'), JSON.stringify({ vastApiKey: KEY, adminPassword: 'admin-pw', hfToken: 'hf_secret_token_123' }));

let n = 0, bad = 0;
const check = (name, ok) => { n++; if (!ok) { bad++; console.log(`  FAIL ${name}`); } };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- fake Vast.ai -----------------------------------------------------------------
const now = Date.now() / 1000;
const offer = (id, gpu, vramMb, price, geo, extra = {}) => ({
    id, gpu_name: gpu, gpu_ram: vramMb, dph_total: price, geolocation: geo, hosting_type: 0, reliability2: 0.995,
    cuda_max_good: 12.8, driver_version: '570.211', inet_down: 900, inet_up: 700, disk_space: 400, cpu_cores_effective: 8, cpu_ram: 32768,
    end_date: now + 14 * 86400, inet_down_cost: 0.0039, host_id: 1, machine_id: id + 1000, ...extra,
});
const OFFERS = [
    offer(101, 'RTX A5000', 24564, 0.23, 'Romania, RO', { hosting_type: 1 }),
    offer(102, 'A40', 46068, 0.54, 'United Kingdom, GB'),
    offer(103, 'RTX 4090', 24564, 0.40, 'Texas, US'),
    offer(104, 'CMP 170HX', 65536, 0.39, 'Hungary, HU'),
];
const queries = [], creates = [], destroyed = [];
const instances = new Map();
let gone102 = false;
let tunnelUp = false;
let filterOn = false;   // a school web filter in front of the raw ip:port
const vastSrv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/logs/')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('[tunnel] public https address: https://old-gone-tunnel.trycloudflare.com\n[ComfyQ] student mode\n[tunnel] public https address: https://blue-owl-harbor.trycloudflare.com\n');
    }
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(res, 401, { error: 'bad key' });
    if (url.pathname === '/api/v0/users/current/') return json(res, 200, { credit: 9.5, balance: 0 });
    if (url.pathname === '/api/v0/instances/' && req.method === 'GET') return json(res, 410, { success: false, error: 'deprecated_endpoint' });
    if (url.pathname === '/api/v0/bundles/' && req.method === 'POST') { const q = await readBody(req); queries.push(q); return json(res, 200, { offers: OFFERS.filter(o => o.dph_total <= q.dph_total.lte && o.gpu_ram >= q.gpu_ram.gte) }); }
    let m;
    if ((m = url.pathname.match(/^\/api\/v0\/asks\/(\d+)\/$/)) && req.method === 'PUT') {
        const b = await readBody(req);
        if (m[1] === '102' && gone102) return json(res, 400, { success: false, error: 'no_such_ask', msg: 'Instance type no longer available' });
        creates.push({ offer: m[1], ...b });
        const id = 9000 + creates.length;
        const o = OFFERS.find(x => String(x.id) === m[1]);
        instances.set(String(id), { id, label: b.label, actual_status: 'loading', intended_status: 'running', status_msg: 'pulling image', gpu_name: o.gpu_name, gpu_ram: o.gpu_ram, dph_total: o.dph_total, geolocation: o.geolocation, public_ipaddr: '203.0.113.7\n', ports: {}, start_date: now, end_date: o.end_date, t0: Date.now() });
        return json(res, 200, { success: true, new_contract: id });
    }
    if (url.pathname === '/api/v1/instances/' && req.method === 'GET') {
        for (const i of instances.values()) if (i.actual_status === 'loading' && Date.now() - i.t0 > 1200) { i.actual_status = 'running'; i.ports = { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '41234' }] }; }
        return json(res, 200, { success: true, total_instances: instances.size, instances: [...instances.values()], next_token: null });
    }
    if ((m = url.pathname.match(/^\/api\/v0\/instances\/request_logs\/(\d+)\/$/)) && req.method === 'PUT') { logAsks++; return json(res, 200, { success: true, result_url: `http://127.0.0.1:${vastSrv.address().port}/logs/${m[1]}` }); }
    if ((m = url.pathname.match(/^\/api\/v0\/instances\/(\d+)\/$/)) && req.method === 'DELETE') { destroyed.push(m[1]); instances.delete(m[1]); return json(res, 200, { success: true }); }
    json(res, 404, { error: 'no route' });
});

// ---- fake ComfyQ on the rented machine ---------------------------------------------
let logAsks = 0;
const comfySrv = http.createServer((req, res) => {
    // /tun/… is the https tunnel (COMFYQ_TUNNEL_PROXY); anything else is the raw ip:port.
    if (req.url.startsWith('/tun/')) req.url = req.url.slice(4);
    else if (filterOn) { const body = Buffer.alloc(35000, 'x'); res.writeHead(403, { 'Content-Type': 'text/html', 'Content-Length': body.length, Connection: 'close' }); return res.end(body); }
    if (req.url === '/federation/self') return json(res, 200, { mode: 'student', servedWorkflows: [{ id: 'image_sdxl_smoke_test', name: 'SDXL' }], jobs: { running: null, scheduled: [] }, usage: { usersConnected: 1 }, publicUrl: tunnelUp ? 'https://lime-cat-river.trycloudflare.com' : null });
    if (req.url.startsWith('/jobs')) return json(res, 200, { jobs: [{ id: 'j1', user_id: 'zaki', workflow_id: 'image_sdxl_smoke_test', status: 'completed', prompt: 'a riad', params: {}, outputs: [{ filename: 'zaki_1.png' }] }] });
    if (req.url.startsWith('/images/')) { const body = Buffer.from('PNG'); res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length }); return res.end(body); }
    if (req.url === '/admin/pod-plan') return json(res, 200, { plan: { status: 'done' } });
    json(res, 404, {});
});

await new Promise(r => vastSrv.listen(0, '127.0.0.1', r));
await new Promise(r => comfySrv.listen(0, '127.0.0.1', r));
const PORT = 4793;
const TOKEN = 'vasttesttoken0123456789';
const proc = spawn(process.execPath, [path.join(HERE, '..', 'console', 'server.mjs'), '--no-open'], {
    env: { ...process.env, USERPROFILE: tmp, HOME: tmp, COMFYQ_NO_EXPLORER: '1', COMFYQ_CONSOLE_PORT: String(PORT), COMFYQ_CONSOLE_TOKEN: TOKEN,
        VAST_API_URL: `http://127.0.0.1:${vastSrv.address().port}/api`, COMFYQ_VAST_PROXY: `http://127.0.0.1:${comfySrv.address().port}`, COMFYQ_TUNNEL_PROXY: `http://127.0.0.1:${comfySrv.address().port}/tun`, COMFYQ_CONSOLE_SOURCE: 'vast-test' },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let out = ''; proc.stdout.on('data', c => out += c); proc.stderr.on('data', c => out += c);
const api = async (method, route, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { 'X-ComfyQ-Console': TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
};
for (let i = 0; i < 50 && !/RunPod console:/.test(out); i++) await sleep(200);

try {
    // ---- the key ----
    const tk = await api('POST', '/api/vast/test-key');
    check(`the key test reads the credit and the rentals through v1 (${JSON.stringify(tk.data)})`, tk.status === 200 && tk.data.credit === 9.5 && tk.data.instances === 0);

    // ---- searching ----
    const s1 = await api('GET', '/api/vast/offers?workflows=&minVram=24&maxPrice=1&minDays=7&near=1');
    const q = queries.at(-1);
    check(`the search asks for CUDA 12.8+, Ampere+, one verified on-demand GPU, an open port and 7 days (${JSON.stringify({ cuda: q?.cuda_max_good, cc: q?.compute_cap, d: q?.duration, t: q?.type })})`,
        q?.cuda_max_good?.gte === 12.8 && q?.compute_cap?.gte === 800 && q?.num_gpus?.eq === 1 && q?.verified?.eq === true && q?.type === 'on-demand' && q?.direct_port_count?.gte === 1 && q?.duration?.gte === 7 * 86400);
    const ids = (s1.data?.offers || []).map(o => o.id);
    check(`Europe only keeps Romania and the UK, drops the US card and the mining card (${ids})`, ids.join() === '101,102');
    const a5 = s1.data.offers[0];
    check(`an offer reads as the page needs it (${JSON.stringify(a5)})`, a5.gpu === 'RTX A5000' && a5.vramGb === 24 && a5.pricePerHr === 0.23 && a5.datacenter && a5.country === 'RO' && a5.days >= 13.9 && a5.downloadPerTb === 3.99);
    const s2 = await api('GET', '/api/vast/offers?workflows=image_sdxl_smoke_test&minVram=24&maxPrice=1&minDays=1&near=0');
    check(`with a workflow, the disk asked for holds its models (${s2.data?.diskGb} GB, needs ${s2.data?.downloads?.minDiskGb})`, s2.data?.diskGb >= s2.data?.downloads?.minDiskGb && queries.at(-1).disk_space.gte === s2.data.diskGb);
    const sec = await api('GET', '/api/vast/offers?minVram=24&maxPrice=1&secure=1');
    check('Secure Cloud only asks Vast for data-centre hosts', sec.status === 200 && queries.at(-1).hosting_type?.eq === 1);

    // ---- renting ----
    const tooSmall = await api('POST', '/api/vast/launch', { offerId: 101, workflows: ['image_sdxl_smoke_test'], diskGb: 60, expectedPerHr: 0.23 });
    check(`a disk too small for the models is refused before renting (${tooSmall.status})`, tooSmall.status === 400 && /too small/.test(JSON.stringify(tooSmall.data)) && creates.length === 0);
    const r1 = await api('POST', '/api/vast/launch', { offerId: 101, workflows: ['image_sdxl_smoke_test'], diskGb: 120, expectedPerHr: 0.23, gpu: 'RTX A5000', where: 'Romania, RO' });
    const c = creates.at(-1);
    check(`renting sends our image, its own entrypoint (args), the disk and a comfyq-vast label (${JSON.stringify({ image: c?.image, runtype: c?.runtype, disk: c?.disk, label: c?.label })})`,
        r1.status === 200 && c?.image === 'ghcr.io/urbandronedesign/comfyq:latest' && c.runtype === 'args' && !('args' in c) && c.disk === 120 && /^comfyq-vast-[0-9a-f]{6}$/.test(c.label) && c.price === null);
    check('it opens port 3000 and passes the serving plan and the passwords in env',
        c?.env?.['-p 3000:3000'] === '1' && c.env.COMFYQ_SERVE === 'image_sdxl_smoke_test' && c.env.COMFYQ_ADMIN_PASSWORD === 'admin-pw' && c.env.COMFYQ_HF_TOKEN === 'hf_secret_token_123' && /^vast-[0-9a-f]{6}$/.test(c.env.COMFYQ_POD_ID));
    check('it asks the machine for an https tunnel (school firewalls block a raw ip:port)', c?.env?.COMFYQ_TUNNEL === 'quick');
    check('the launch answer carries no secret', !JSON.stringify(r1.data).includes('admin-pw') && !JSON.stringify(r1.data).includes('hf_secret'));
    gone102 = true;
    const r2 = await api('POST', '/api/vast/launch', { offerId: 102, workflows: [], diskGb: 120, expectedPerHr: 0.54 });
    check(`a machine rented by someone else a moment ago says so (${r2.status})`, r2.status === 409 && /someone rented/.test(JSON.stringify(r2.data)));
    const poor = await api('POST', '/api/vast/launch', { offerId: 101, workflows: [], diskGb: 120, expectedPerHr: 12 });
    check(`a rental the credit cannot pay one hour of is refused (${poor.status})`, poor.status === 402 && creates.length === 1);

    // ---- the list ----
    const l0 = await api('GET', '/api/vast/instances');
    const i0 = l0.data?.instances?.[0];
    check(`while it pulls the image there is no link yet (${i0?.status})`, i0?.status === 'loading' && !i0.links && i0.ours && i0.rec?.serve?.[0] === 'image_sdxl_smoke_test');
    await sleep(1500);
    const l1 = await api('GET', '/api/vast/instances');
    const i1 = l1.data?.instances?.[0];
    check(`once running: its address, students served, links per workflow (${JSON.stringify(i1?.links)})`,
        i1?.status === 'running' && i1.ip === '203.0.113.7' && i1.probe?.answering && i1.probe.mode === 'student' && i1.links?.byWorkflow?.[0]?.url.endsWith('/user?workflow=image_sdxl_smoke_test'));

    check(`before the tunnel is up the links are the raw address, marked not secure (${i1?.links?.students})`, !i1.secure && i1.links.students === i1.direct);
    tunnelUp = true;
    const i2 = (await api('GET', '/api/vast/instances')).data?.instances?.[0];
    check(`once the tunnel is up every student link is https on it (${JSON.stringify(i2?.links)})`,
        i2?.secure && i2.links.students === 'https://lime-cat-river.trycloudflare.com' && i2.links.admin === 'https://lime-cat-river.trycloudflare.com/admin'
        && i2.links.byWorkflow[0].url === 'https://lime-cat-river.trycloudflare.com/user?workflow=image_sdxl_smoke_test' && i2.direct !== i2.links.students);

    // ---- a network that blocks the raw ip:port (a school's web filter, 2026-10-22) ----
    filterOn = true; tunnelUp = false;
    const i3 = (await api('GET', '/api/vast/instances')).data?.instances?.[0];
    check(`behind a filter that blocks the raw address, the https link comes from the machine's log, the last one printed (${i3?.links?.students})`,
        i3?.reachedVia === 'log' && i3.secure && i3.probe?.answering && i3.links.students === 'https://blue-owl-harbor.trycloudflare.com');
    const again = await api('GET', '/api/vast/instances');
    check(`the filter's 403 page did not crash the console, and Vast is asked for the log once a minute at most (${logAsks})`,
        again.status === 200 && again.data.instances[0].reachedVia === 'log' && logAsks === 1 && !/ERR_ASSERTION/.test(out));

    // ---- spending ----
    const sp = await api('GET', '/api/spend');
    check(`the spending bar counts it: credit, $/h, the machine (${JSON.stringify(sp.data?.vast)})`, sp.data?.vast?.balance === 9.5 && sp.data.vast.ratePerHr === 0.23 && sp.data.machines.some(m => m.provider === 'vast' && m.gpu === 'RTX A5000'));

    // ---- results, then destroy ----
    let st = (await api('POST', `/api/vast/instances/${i1.id}/download`)).data;
    for (let k = 0; k < 30 && !['done', 'failed'].includes(st?.state); k++) { await sleep(200); st = (await api('GET', `/api/vast/instances/${i1.id}/download`)).data; }
    check(`Download results saves each file into a folder (${st?.state} ${st?.saved}/${st?.total})`, st?.state === 'done' && st.saved === 1 && fs.existsSync(path.join(st.folder, 'zaki_1.png')) && fs.existsSync(path.join(st.folder, 'jobs.json')));
    const wrong = await api('DELETE', `/api/vast/instances/${i1.id}`, { confirm: '123' });
    check(`destroy wants the id typed back (${wrong.status})`, wrong.status === 400 && destroyed.length === 0);
    const del = await api('DELETE', `/api/vast/instances/${i1.id}`, { confirm: i1.id });
    check(`destroy ends the rental (${JSON.stringify(del.data)})`, del.status === 200 && del.data.destroyed && destroyed[0] === i1.id);
    const att = (await api('GET', '/api/attempts?limit=20')).data;
    check(`each try is in the attempts log, provider vast (${(att?.attempts || []).filter(a => a.provider === 'vast').map(a => a.result)})`,
        (att?.attempts || []).filter(a => a.provider === 'vast').map(a => a.result).sort().join() === 'created,no machine');
    check('nothing secret in the console output', !out.includes('admin-pw') && !out.includes('hf_secret') && !out.includes(KEY));

    // ---- the page, in headless Chrome ----
    const bi = process.argv.indexOf('--browser');
    if (bi > 0) {
        gone102 = false;
        const r = await browser(process.argv[bi + 1]);
        check(`the Vast.ai tab opens its page (${JSON.stringify(r.page)})`, r.page.shown && r.page.hash === '#vast');
        check(`the panel lists the offers found (${r.rows})`, r.rows === 2);
        check(`renting from the page rents the picked machine (${JSON.stringify(creates.at(-1)?.offer)})`, creates.at(-1)?.offer === '102' && r.closed);
        check(`the new rental is in the list (${r.list.slice(0, 80)})`, /A40/.test(r.list));
        check(`no script error on the page (${r.errors.join(' | ')})`, r.errors.length === 0);
    }
} finally {
    proc.kill(); vastSrv.close(); comfySrv.close();
}
console.log(`vast console: ${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);

async function browser(chrome) {
    const prof = path.join(tmp, 'chrome');
    const p = spawn(chrome, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9334', `--user-data-dir=${prof}`, '--window-size=1400,1600', 'about:blank'], { stdio: 'ignore' });
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
        await cdp('Page.navigate', { url: `http://localhost:${PORT}/#t=${TOKEN}` });
        await sleep(2500);
        await evalJs("document.querySelector('.tabs [data-page=vast]').click(); 1");
        await sleep(1500);
        const pg = await evalJs("({ shown: !document.getElementById('page-vast').hidden, hash: location.hash })");
        await evalJs("document.getElementById('openCreateVast').click(); 1");
        await sleep(2500);
        const rows = await evalJs("document.querySelectorAll('#vOfferRows tr[data-voffer]').length");
        await evalJs("document.querySelector('#vOfferRows tr[data-voffer=\"102\"]').click(); 1");
        await sleep(300);
        await evalJs("window.confirm = () => true; document.getElementById('vLaunch').click(); 1");
        await sleep(3000);
        const closed = await evalJs("document.getElementById('drawer-createVast').hidden");
        await sleep(1500);
        const list = await evalJs("document.getElementById('vList').innerText");
        return { page: pg, rows, closed, list, errors };
    } finally { p.kill(); }
}
