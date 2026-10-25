#!/usr/bin/env node
// The console's "My machines" page end to end, against stand-ins: two fake
// ComfyQ machines (one serving two workflows, one that can be switched off).
// Nothing real is called.
//
//   node tools/runpod/tests/home-console.mjs
//   node tools/runpod/tests/home-console.mjs --browser "<path to chrome.exe>"
//     also drives the page in headless Chrome: add a machine, list, details.
//
// The console's home folder is a temporary directory: ~/.comfyq is never touched.

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'home-console-'));
fs.mkdirSync(path.join(tmp, '.comfyq'));
fs.mkdirSync(path.join(tmp, 'Desktop'));

let n = 0, bad = 0;
const check = (name, ok) => { n++; if (!ok) { bad++; console.log(`  FAIL ${name}`); } };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- two fake machines -------------------------------------------------------------
let upA = true;
const machine = (self, gate = () => true) => http.createServer((req, res) => {
    if (!gate()) { req.socket.destroy(); return; }   // switched off: the connection just dies
    if (req.url === '/federation/self') return json(res, 200, self());
    if (req.url === '/admin/pod-plan') return json(res, 404, {});
    if (req.url.startsWith('/jobs')) return json(res, 200, { jobs: [{ id: 'j1', user_id: 'zaki', workflow_id: 'image_flux3', status: 'completed', prompt: 'a riad', params: {}, outputs: [{ filename: 'zaki_1.png' }] }] });
    if (req.url.startsWith('/images/')) { const body = Buffer.from('PNG'); res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length }); return res.end(body); }
    json(res, 404, {});
});
const srvA = machine(() => ({ mode: 'student', gpu: 'NVIDIA GeForce RTX 4090', vramGb: 24,
    servedWorkflows: [{ id: 'image_flux3', name: 'FLUX.3 edit' }, { id: 'image_qwen', name: 'Qwen edit' }],
    jobs: { running: { id: 'j2' }, scheduled: [{ id: 'j3' }] }, usage: { usersConnected: 7 } }), () => upA);
const srvB = machine(() => ({ mode: 'admin', gpu: 'NVIDIA GeForce RTX 3090', vramGb: 24, servedWorkflows: [], jobs: { running: null, scheduled: [] }, usage: { usersConnected: 0 } }));
await new Promise(r => srvA.listen(0, '127.0.0.1', r));
await new Promise(r => srvB.listen(0, '127.0.0.1', r));
const A = `http://127.0.0.1:${srvA.address().port}`;
const B = `http://127.0.0.1:${srvB.address().port}`;
// A port nothing listens on: a machine that is switched off.
const dead = http.createServer(); await new Promise(r => dead.listen(0, '127.0.0.1', r));
const OFF = `http://127.0.0.1:${dead.address().port}`; dead.close();

const PORT = 4788;
const TOKEN = 'hometesttoken0123456789';
const proc = spawn(process.execPath, [path.join(HERE, '..', 'console', 'server.mjs'), '--no-open'], {
    env: { ...process.env, USERPROFILE: tmp, HOME: tmp, COMFYQ_NO_EXPLORER: '1', COMFYQ_CONSOLE_PORT: String(PORT), COMFYQ_CONSOLE_TOKEN: TOKEN, COMFYQ_CONSOLE_SOURCE: 'home-test' },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let out = ''; proc.stdout.on('data', c => out += c); proc.stderr.on('data', c => out += c);
const api = async (method, route, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { 'X-ComfyQ-Console': TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
};
for (let i = 0; i < 50 && !/RunPod console:/.test(out); i++) await sleep(200);

try {
    const empty = await api('GET', '/api/home/machines');
    check(`no machine listed at first (${JSON.stringify(empty.data)})`, empty.status === 200 && empty.data.machines.length === 0);
    const noHeader = await fetch(`http://127.0.0.1:${PORT}/api/home/machines`);
    check(`the list needs the console's token like every route (${noHeader.status})`, noHeader.status === 403);

    // ---- adding ----
    const bad1 = await api('POST', '/api/home/machines', { name: 'atelier-4090', url: `${A}/admin` });
    check(`an address with a page is refused with the reason (${bad1.status} ${bad1.data?.error})`, bad1.status === 400 && /without a page/.test(bad1.data.error));
    const bad2 = await api('POST', '/api/home/machines', { name: '', url: A });
    check(`a missing name is refused (${bad2.status})`, bad2.status === 400 && /name/.test(bad2.data.error));
    const bad3 = await api('POST', '/api/home/machines', { name: 'x', url: 'javascript:alert(1)' });
    check(`a javascript: address is refused (${bad3.status})`, bad3.status === 400);
    const addA = await api('POST', '/api/home/machines', { name: 'atelier-4090', url: `${A}/` });
    const ma = addA.data?.machine;
    check(`adding a serving machine reads it at once (${JSON.stringify(ma?.stage)})`, addA.status === 200 && ma.id === 'atelier-4090' && ma.url === A && ma.stage.key === 'serving' && /FLUX\.3 edit, Qwen edit/.test(ma.stage.text));
    check(`it gives the admin page and one student link per workflow (${JSON.stringify(ma?.links)})`,
        ma.links.admin === `${A}/admin` && ma.links.byWorkflow.map(l => l.url).join() === `${A}/user?workflow=image_flux3,${A}/user?workflow=image_qwen`);
    check(`GPU, students and queue come from the machine (${JSON.stringify(ma?.probe?.gpu)})`, ma.probe.gpu === 'NVIDIA GeForce RTX 4090' && ma.probe.vramGb === 24 && ma.probe.usage.usersConnected === 7 && ma.probe.jobs.scheduled.length === 1);
    const dup = await api('POST', '/api/home/machines', { name: 'again', url: A });
    check(`the same address twice is refused, naming the first (${dup.status} ${dup.data?.error})`, dup.status === 409 && /atelier-4090/.test(dup.data.error));
    const addB = await api('POST', '/api/home/machines', { name: 'atelier-3090', url: B });
    check(`a machine in admin mode reads as such (${addB.data?.machine?.stage?.key})`, addB.data?.machine?.stage?.key === 'admin');
    const addOff = await api('POST', '/api/home/machines', { name: 'atelier 4090', url: OFF });
    check(`a switched-off machine is added anyway, offline, with a free id (${JSON.stringify(addOff.data?.machine && { id: addOff.data.machine.id, st: addOff.data.machine.stage })})`,
        addOff.status === 200 && addOff.data.machine.id === 'atelier-4090-2' && addOff.data.machine.stage.key === 'offline' && /does not answer/.test(addOff.data.machine.stage.text));
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, '.comfyq', 'home-machines.json'), 'utf8'));
    check(`the list is kept in ~/.comfyq/home-machines.json (${Object.keys(saved)})`, Object.keys(saved).sort().join() === 'atelier-3090,atelier-4090,atelier-4090-2');

    // ---- going offline and back ----
    let list = (await api('GET', '/api/home/machines')).data.machines;
    check(`the list is sorted by name (${list.map(m => m.name)})`, list.map(m => m.name).join() === 'atelier 4090,atelier-3090,atelier-4090');
    upA = false;
    list = (await api('GET', '/api/home/machines')).data.machines;
    const a1 = list.find(m => m.id === 'atelier-4090');
    check(`one missed answer: still online, "checking" (${a1?.stage?.key})`, a1.stage.key === 'checking' && a1.health.online);
    list = (await api('GET', '/api/home/machines')).data.machines;
    const a2 = list.find(m => m.id === 'atelier-4090');
    check(`two missed answers: offline, last answer kept (${a2?.stage?.key})`, a2.stage.key === 'offline' && /stopped answering/.test(a2.stage.text) && a2.health.lastSeen > 0);
    const dlOff = await api('POST', '/api/home/machines/atelier-4090/download');
    check(`results cannot be fetched from a machine that does not answer (${dlOff.status})`, dlOff.status === 409);
    upA = true;
    list = (await api('GET', '/api/home/machines')).data.machines;
    check('back: serving again', list.find(m => m.id === 'atelier-4090').stage.key === 'serving');

    // ---- results ----
    let st = (await api('POST', '/api/home/machines/atelier-4090/download')).data;
    for (let k = 0; k < 30 && !['done', 'failed'].includes(st?.state); k++) { await sleep(200); st = (await api('GET', '/api/home/machines/atelier-4090/download')).data; }
    check(`Download results saves each file into Desktop\\ComfyQ results (${st?.state} ${st?.saved}/${st?.total} ${st?.folder})`,
        st?.state === 'done' && st.saved === 1 && st.folder.startsWith(path.join(tmp, 'Desktop', 'ComfyQ results', 'home-atelier-4090-')) && fs.existsSync(path.join(st.folder, 'zaki_1.png')) && fs.existsSync(path.join(st.folder, 'jobs.json')));

    // ---- removing ----
    const del = await api('DELETE', '/api/home/machines/atelier-4090-2');
    const after = (await api('GET', '/api/home/machines')).data.machines.map(m => m.id);
    check(`Remove only forgets it (${after})`, del.status === 200 && after.join() === 'atelier-3090,atelier-4090');
    const delAgain = await api('DELETE', '/api/home/machines/atelier-4090-2');
    check(`removing one that is not listed says so (${delAgain.status})`, delAgain.status === 404);
    const traversal = await api('DELETE', '/api/home/machines/..%2F..%2Fsecrets');
    check(`an id that is not a plain name is not a route (${traversal.status})`, traversal.status === 404);
    check('nothing alarming in the console output', !/ERR_|Unhandled|TypeError/.test(out));

    // ---- the page, in headless Chrome ----
    const bi = process.argv.indexOf('--browser');
    if (bi > 0) {
        const r = await browser(process.argv[bi + 1]);
        check(`the tab counts the machines before it is opened (${r.countBefore})`, r.countBefore === '2');
        check(`the My machines tab opens its page (${JSON.stringify(r.page)})`, r.page.shown && r.page.hash === '#home');
        check(`the tiles add up (${JSON.stringify(r.tiles)})`, r.tiles.total === '2' && r.tiles.online === '2' && r.tiles.serving === '1' && r.tiles.users === '7');
        check(`a bad address is refused inside the panel (${r.addErr})`, /without a page/.test(r.addErr) && !r.closedOnBad);
        check(`adding from the page closes the panel and lists it (${r.list.slice(0, 120)})`, r.closed && /atelier-new/.test(r.list));
        check(`its details show the links and say nothing is billed (${r.detail.slice(0, 160)})`, /Student page/.test(r.detail) && /Admin panel/.test(r.detail) && /none counted/.test(r.detail));
        check(`no script error on the page (${r.errors.join(' | ')})`, r.errors.length === 0);
    }
} finally {
    proc.kill(); srvA.close(); srvB.close();
}
console.log(`home console: ${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);

async function browser(chrome) {
    const prof = path.join(tmp, 'chrome');
    const p = spawn(chrome, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9336', `--user-data-dir=${prof}`, '--window-size=1400,1600', 'about:blank'], { stdio: 'ignore' });
    try {
        let targets = null;
        for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch('http://127.0.0.1:9336/json')).json(); } catch { await sleep(200); } }
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
        await sleep(3000);
        const countBefore = await evalJs("document.getElementById('homeCount').textContent");
        await evalJs("document.querySelector('.tabs [data-page=home]').click(); 1");
        await sleep(2000);
        const pg = await evalJs("({ shown: !document.getElementById('page-home').hidden, hash: location.hash })");
        const tiles = await evalJs("({ total: hTotal.textContent, online: hOnline.textContent, serving: hServing.textContent, users: hUsers.textContent })");
        await evalJs("document.getElementById('openAddHome').click(); 1");
        await sleep(300);
        await evalJs(`hName.value = 'atelier-new'; hUrl.value = '${B}/admin'; hAdd.click(); 1`);
        await sleep(1000);
        const addErr = await evalJs("hAddOut.textContent");
        const closedOnBad = await evalJs("document.getElementById('drawer-addHome').hidden");
        // B is already listed: give the new one a different address for the same machine.
        await evalJs(`hUrl.value = '${B.replace('127.0.0.1', 'localhost')}'; hAdd.click(); 1`);
        await sleep(2500);
        const closed = await evalJs("document.getElementById('drawer-addHome').hidden");
        const list = await evalJs("hList.innerText");
        const detail = await evalJs("hDetail.hidden ? '' : hDetail.innerText");
        return { countBefore, page: pg, tiles, addErr, closedOnBad, closed, list, detail, errors };
    } finally { p.kill(); }
}
