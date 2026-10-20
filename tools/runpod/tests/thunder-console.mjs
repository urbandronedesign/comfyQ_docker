#!/usr/bin/env node
// The console's Thunder tab end to end, against stand-ins: a fake Thunder API,
// a fake ssh and a fake ComfyQ. Nothing real is called and nothing is spent.
//
//   node tools/runpod/tests/thunder-console.mjs
//   node tools/runpod/tests/thunder-console.mjs --browser "<path to chrome.exe>" [--shot out.png]
//     also opens the Thunder tab in headless Chrome and fails on any page error.
//
// The console runs with its home folder pointed at a temporary directory, so
// the real ~/.comfyq settings are never read or written.

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thunder-console-'));
fs.mkdirSync(path.join(tmp, '.comfyq'));
fs.writeFileSync(path.join(tmp, '.comfyq', 'runpod-console.json'), JSON.stringify({ thunderApiKey: 'tk_test', adminPassword: 'admin-pw' }));

const ok = [];
const check = (label, cond) => { assert.ok(cond, label); ok.push(label); };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; };

// ---- fake Thunder -------------------------------------------------------------
const instances = {};
const seen = [];
const thunderSrv = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    seen.push(`${req.method} ${url}`);
    if (url === '/v2/specs') return json(res, 200, { specs: { l40_x1: { displayName: 'NVIDIA L40', vramGB: 48, gpuCount: 1, vcpuOptions: [6, 8, 12], storageGB: { min: 100, max: 500 } } } });
    if (url === '/v2/pricing') return json(res, 200, { pricing: { l40_x1: 0.79, additional_vcpus: 0.04, disk_gb: 0.0003 } });
    if (url === '/v2/status') return json(res, 200, { gpu_type: { l40: { 1: 'available' } }, specs: { l40_x1: 'available' } });
    if (req.headers.authorization !== 'Bearer tk_test') return json(res, 401, { message: 'bad token' });
    if (url === '/v1/instances/list') {
        for (const i of Object.values(instances)) if (i.status !== 'RUNNING' && Date.now() - i.t0 > 1500) { i.status = 'RUNNING'; i.ip = '127.0.0.1'; }
        return json(res, 200, Object.fromEntries(Object.entries(instances).map(([k, v]) => [k, { uuid: v.uuid, status: v.status, ip: v.ip, port: 22, httpPorts: v.httpPorts, gpuType: 'l40' }])));
    }
    if (url === '/v1/instances/create' && req.method === 'POST') {
        const b = await readBody(req);
        instances['0'] = { uuid: 'aaaabbbb-cccc', status: 'QUEUED', ip: null, httpPorts: [], t0: Date.now(), body: b };
        return json(res, 201, { identifier: 0, uuid: 'aaaabbbb-cccc', key: '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----' });
    }
    let m;
    if ((m = url.match(/^\/v1\/instances\/(\d+)\/ports$/)) && req.method === 'PATCH') {
        const b = await readBody(req);
        instances[m[1]].httpPorts = [...new Set([...instances[m[1]].httpPorts, ...b.add_ports])];
        return json(res, 200, { identifier: m[1], instance_name: 'x', http_ports: instances[m[1]].httpPorts });
    }
    if ((m = url.match(/^\/v1\/instances\/(\d+)\/delete$/)) && req.method === 'POST') { delete instances[m[1]]; return json(res, 200, { message: 'Success' }); }
    json(res, 404, { message: 'no route' });
});

// ---- fake ComfyQ on the instance ---------------------------------------------
const comfySrv = http.createServer((req, res) => {
    if (req.url === '/federation/self') return json(res, 200, { mode: 'student', servedWorkflows: [{ id: 'image_sdxl_smoke_test', name: 'SDXL' }], jobs: { running: null, scheduled: [] }, usage: { usersConnected: 2 } });
    if (req.url === '/admin/pod-plan') return json(res, 200, { plan: { status: 'done' } });
    if (req.url.startsWith('/admin/volume-folders/') && req.url.endsWith('/results.zip')) {
        res.writeHead(req.headers['x-admin-password'] === 'admin-pw' ? 200 : 401, { 'Content-Type': 'application/zip' });
        return res.end('PK-fake-zip ' + req.url);
    }
    json(res, 404, {});
});

// ---- fake ssh -------------------------------------------------------------------
const sshLog = path.join(tmp, 'ssh-input.txt');
const fakeSsh = path.join(tmp, 'fake-ssh.mjs');
fs.writeFileSync(fakeSsh, `
import fs from 'fs';
const args = process.argv.slice(2);
const target = args[args.length - 2];
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
    fs.appendFileSync(${JSON.stringify(sshLog)}, JSON.stringify({ target, keyFile: args[args.indexOf('-i') + 1], input }) + '\\n');
    if (!target.startsWith('ubuntu@')) process.exit(255);
    if (input.trim() === 'true') process.exit(0);
    console.log('[comfyq] pulling'); console.log('[comfyq] started'); process.exit(0);
});
`);

await new Promise(r => thunderSrv.listen(0, '127.0.0.1', r));
await new Promise(r => comfySrv.listen(0, '127.0.0.1', r));
const PORT = 4791;
const consoleProc = spawn(process.execPath, [path.join(HERE, '..', 'console', 'server.mjs'), '--no-open'], {
    env: {
        ...process.env, USERPROFILE: tmp, HOME: tmp, COMFYQ_CONSOLE_PORT: String(PORT),
        THUNDER_API_URL: `http://127.0.0.1:${thunderSrv.address().port}`,
        COMFYQ_THUNDER_PROXY: `http://127.0.0.1:${comfySrv.address().port}`,
        COMFYQ_THUNDER_SSH: fakeSsh, COMFYQ_CONSOLE_SOURCE: 'thunder-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let consoleOut = '';
consoleProc.stdout.on('data', c => consoleOut += c);
consoleProc.stderr.on('data', c => consoleOut += c);
const api = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { 'X-ComfyQ-Console': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null), res };
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- optional: the page itself, in headless Chrome --------------------------------
async function browserCheck(chrome, shot) {
    const prof = path.join(tmp, 'chrome');
    const p = spawn(chrome, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9333', `--user-data-dir=${prof}`, '--window-size=1280,1600', 'about:blank'], { stdio: 'ignore' });
    try {
        let targets = null;
        for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch('http://127.0.0.1:9333/json')).json(); } catch { await sleep(200); } }
        const page = targets.find(t => t.type === 'page');
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise(r => ws.addEventListener('open', r, { once: true }));
        let n = 0; const pending = new Map(); const errors = [];
        ws.addEventListener('message', (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
            if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
            if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
        });
        const cdp = (method, params = {}) => new Promise(r => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
        const evalJs = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
        await cdp('Runtime.enable'); await cdp('Page.enable');
        await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
        await sleep(2500);
        // One page per provider; launching opens a panel from the right.
        await evalJs("document.querySelector('.tabs [data-page=thunder]').click(); 1");
        await sleep(4000);
        await evalJs("document.querySelector('#tList [data-tsel]')?.click(); 1");
        await sleep(500);
        await evalJs("document.getElementById('openCreateThunder').click(); 1");
        await sleep(3000);
        await evalJs("document.querySelector('[data-twf=\"image_sdxl_smoke_test\"]').click(); 1");
        await sleep(2500);
        const view = await evalJs(`({ hidden: document.getElementById('page-thunder').hidden,
            drawer: !document.getElementById('drawer-createThunder').hidden,
            tiles: document.getElementById('tTotal').innerText + '/' + document.getElementById('tRunning').innerText,
            list: document.getElementById('tList').innerText, detail: document.getElementById('tDetail').innerText, gpus: document.getElementById('tGpuRows').innerText,
            need: document.getElementById('tNeed').innerText, summary: document.getElementById('tSummary').innerText,
            spendRate: document.getElementById('spRate').innerText, spendMachines: document.getElementById('spMachines').innerText })`);
        if (shot) {
            const png = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
            fs.writeFileSync(shot, Buffer.from(png.data, 'base64'));
        }
        ws.close();
        return { view, errors };
    } finally { p.kill(); }
}

try {
    for (let i = 0; i < 50; i++) { try { await api('GET', '/api/settings'); break; } catch { await sleep(200); } }

    const plan = await api('GET', '/api/thunder/plan?workflows=image_sdxl_smoke_test');
    check('plan: the L40 is recommended for the smoke test', plan.data.recommended === 'l40_x1' && plan.data.offers[0].fits === true);

    const refused = await api('POST', '/api/thunder/launch', { workflows: [], gpu: 'l40_x1' });
    check('launch with no workflow is refused before anything is created', refused.status === 400 && !seen.includes('POST /v1/instances/create'));

    // A balance that cannot pay one hour stops the launch before Thunder is asked.
    await api('PUT', '/api/spend/thunder-balance', { amount: 0.5 });
    const broke = await api('POST', '/api/thunder/launch', { workflows: ['image_sdxl_smoke_test'], gpu: 'l40_x1', vcpus: 8, diskGb: 9999 });
    check(`a launch the Thunder balance cannot pay for an hour is refused, nothing created (${broke.status})`,
        broke.status === 402 && /balance/.test(broke.data.error || '') && !seen.includes('POST /v1/instances/create'));
    await api('PUT', '/api/spend/thunder-balance', { amount: 100 });

    const launched = await api('POST', '/api/thunder/launch', { workflows: ['image_sdxl_smoke_test'], gpu: 'l40_x1', vcpus: 8, diskGb: 9999 });
    check('launch creates the instance', launched.status === 200 && launched.data.instance.uuid === 'aaaabbbb-cccc');
    const body = instances['0'].body;
    check('create body: l40, 1 GPU, base template, vCPUs as asked, disk clamped to the card maximum',
        body.gpu_type === 'l40' && body.num_gpus === 1 && body.template === 'base' && body.cpu_cores === 8 && body.disk_size_gb === 500);
    const keyFile = path.join(tmp, '.comfyq', 'thunder-keys', 'aaaabbbb-cccc.pem');
    check('the private key Thunder returned is saved for ssh', fs.existsSync(keyFile) && fs.readFileSync(keyFile, 'utf8').includes('fake'));

    let list;
    for (let i = 0; i < 60; i++) {
        list = await api('GET', '/api/thunder/instances');
        const it = list.data.instances[0];
        if (it?.rec?.state === 'ready' || it?.rec?.state === 'failed') break;
        await sleep(1000);
    }
    const it = list.data.instances[0];
    check('setup reaches ready', it.rec.state === 'ready');
    check('port 3000 was forwarded and the links point at the instance', it.forwarded && it.links.students.startsWith('http://127.0.0.1:'));
    check('the probe sees ComfyQ serving', it.probe?.answering && it.probe.mode === 'student' && it.probe.served[0].id === 'image_sdxl_smoke_test');
    const sshCalls = fs.readFileSync(sshLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const run = sshCalls.at(-1);
    check('ssh logs in as ubuntu with the saved key, and the script carries the env', run.target === 'ubuntu@127.0.0.1' && run.keyFile === keyFile
        && run.input.includes('COMFYQ_SERVE=image_sdxl_smoke_test') && run.input.includes('COMFYQ_ADMIN_PASSWORD=admin-pw') && run.input.includes('COMFYQ_POD_ID=thunder-aaaabbbbcccc'));
    check('no secret reaches the page', !JSON.stringify(list.data).includes('admin-pw') && !JSON.stringify(list.data).includes('tk_test'));

    const bi = process.argv.indexOf('--browser');
    if (bi > 0) {
        const si = process.argv.indexOf('--shot');
        const { view, errors } = await browserCheck(process.argv[bi + 1], si > 0 ? process.argv[si + 1] : null);
        check(`the page shows no error (${errors.join(' | ')})`, errors.length === 0);
        check(`the Thunder page lists the serving instance in its table, tiles counted (${view.tiles})`, !view.hidden && /Serving/.test(view.list) && /image_sdxl_smoke_test/.test(view.list) && view.tiles === '1/1');
        check('clicking its row opens its details with the student links', /Student page/.test(view.detail) && /Download results/.test(view.detail));
        check('+ Create opens the launch panel', view.drawer);
        check('the card table and summary follow the ticked workflow', /NVIDIA L40/.test(view.gpus) && /recommended/.test(view.gpus) && /L40/.test(view.summary));
        check(`the spending bar shows the running instance at its full price (${view.spendRate} | ${view.spendMachines})`,
            view.spendRate === '$0.99/h' && /Thunder/.test(view.spendMachines) && /so far/.test(view.spendMachines));
    }

    // 8 vCPU (6 included) and 500 GB (100 included): 0.79 + 2×0.04 + 400×0.0003.
    const spendOn = (await api('GET', '/api/spend')).data;
    check(`spend: the instance bills at the GPU + vCPU + disk price (${spendOn.ratePerHr})`,
        Math.abs(spendOn.ratePerHr - 0.99) < 1e-9 && spendOn.machines.length === 1 && spendOn.machines[0].provider === 'thunder');
    check(`spend: the Thunder balance typed in goes down as the instance runs (${spendOn.thunder.balance})`,
        spendOn.thunder.balance < 100 && spendOn.thunder.balance > 99 && spendOn.thunder.hoursLeft > 99);

    const dl = await api('POST', '/api/thunder/instances/aaaabbbb-cccc/download');
    const zip = await fetch(`http://127.0.0.1:${PORT}${dl.data.url}`);
    const zipText = await zip.text();
    check('download results asks the instance for its own folder, with the admin password', zip.status === 200 && zipText.includes('/admin/volume-folders/thunder-aaaabbbbcccc/results.zip'));

    const wrong = await api('DELETE', '/api/thunder/instances/aaaabbbb-cccc', { confirm: 'nope' });
    check('delete needs the code typed back', wrong.status === 400 && instances['0']);
    const del = await api('DELETE', '/api/thunder/instances/aaaabbbb-cccc', { confirm: 'aaaabbbb' });
    check('delete removes the instance and forgets its key', del.status === 200 && !instances['0'] && !fs.existsSync(keyFile));
    const spendOff = (await api('GET', '/api/spend')).data;
    check('spend: once deleted it stops billing but today keeps what it cost',
        spendOff.ratePerHr === 0 && spendOff.machines.length === 0 && spendOff.today > 0 && spendOff.thunder.today > 0);

    const attempts = await api('GET', '/api/attempts');
    check('the launch is in the Attempts log', JSON.stringify(attempts.data).includes('thunder'));
    console.log(`thunder-console: ${ok.length} checks passed`);
} catch (e) {
    console.error(consoleOut.slice(-2000));
    console.error(e);
    process.exitCode = 1;
} finally {
    consoleProc.kill();
    thunderSrv.close();
    comfySrv.close();
    await sleep(500);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* Chrome may still hold its profile */ }
}
