// node console-app/test/app-smoke.mjs — starts the real app and checks it.
//
// Phase 1: the window loads the console page with no script error, the page's
// own calls work (token through the preload), another program calling the same
// port is refused, and quitting stops the console server.
// Phase 2: keys in a plain settings file move into Windows protected storage and
// leave the file; a key saved from the page lands only in protected storage and
// is still there after a restart; the workflow list is refreshed from GitHub.
//
// Runs with a throwaway data folder for the console (COMFYQ_APP_SERVER_HOME),
// so no real key is read or written. The GitHub part needs the internet.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let n = 0, bad = 0;
const check = (name, ok) => { n++; if (!ok) { bad++; console.log(`  FAIL ${name}`); } else console.log(`  ok   ${name}`); };

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'comfyq-app-'));
const dataDir = path.join(home, '.comfyq');
const settingsFile = path.join(dataDir, 'runpod-console.json');
const secretsFile = path.join(dataDir, 'console-secrets.bin');
const eventsFile = path.join(home, 'app-events.jsonl');
const events = () => { try { return fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
// A plain settings file as the browser version leaves it. No API key: those
// would make the console call RunPod and Thunder.
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify({ adminPassword: 'admin-pw-plain-1234', hfToken: 'hf_testtoken_abcdefghijklmnop', diskGb: 30 }));

let debugPort = 9345;
// The installed app ignores every COMFYQ_APP_* test hook (it would use the real
// ~/.comfyq and its keys), so it cannot be checked here: refuse rather than touch them.
if (process.env.COMFYQ_APP_EXE) {
    console.log('  COMFYQ_APP_EXE: a packaged app ignores the test hooks and would use your real keys and data. Not run.');
    process.exit(1);
}

async function launch(extraEnv = {}) {
    const env = { ...process.env, COMFYQ_APP_SERVER_HOME: home, COMFYQ_APP_GITHUB_WORKFLOWS: '1', COMFYQ_APP_EVENTS_FILE: eventsFile, COMFYQ_APP_WATCH_MS: '2000', ...extraEnv };
    delete env.ELECTRON_RUN_AS_NODE;   // set in some shells: it would run Electron as plain Node
    const port = debugPort++;
    // COMFYQ_APP_EXE=<path to "ComfyQ Console.exe"> checks the packaged app
    // (npm run dist → dist/win-unpacked) instead of the repo's copy.
    const child = process.env.COMFYQ_APP_EXE
        ? spawn(process.env.COMFYQ_APP_EXE, [`--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
        // Its own data folder: the installed app holds the single-instance lock of
        // the real one, and the test copy would just exit while it runs.
        : spawn(ELECTRON, [APP, `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(home, 'electron-data')}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = [];
    child.stdout.on('data', d => log.push(String(d)));
    child.stderr.on('data', d => log.push(String(d)));
    let target;
    for (let i = 0; i < 100 && !target; i++) {
        try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url)); } catch { /* not up yet */ }
        if (!target) await sleep(300);
    }
    if (!target) { child.kill(); throw new Error(`no window\n${log.join('').slice(-1500)}`); }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const pending = new Map(); const errors = [];
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
        if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    };
    const cdp = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (e) => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
    await cdp('Runtime.enable');
    await cdp('Page.reload');
    await sleep(4000);
    const call = (method, route, body) => evalJs(`(async () => { const r = await fetch(${JSON.stringify(route)}, { method: ${JSON.stringify(method)},
        headers: { 'X-ComfyQ-Console': window.comfyqConsole.token, 'Content-Type': 'application/json' }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ''} });
        return { status: r.status, data: await r.json().catch(() => null) }; })()`);
    const quit = async () => {
        ws.close(); child.kill();
        for (let i = 0; i < 30; i++) { await sleep(300); try { await fetch(`${new URL(target.url).origin}/`); } catch { return true; } }
        return false;
    };
    const shot = async (file) => { const png = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(png.data, 'base64')); };
    return { origin: new URL(target.url).origin, port: Number(new URL(target.url).port), evalJs, call, errors, quit, log, shot };
}

let a;
try {
    // ---- first start ----
    a = await launch();
    check('the app opens a window on the local console server', true);
    check(`the server is on a random port, not 4777 (${a.port})`, a.port !== 4777);
    const preload = await a.evalJs('typeof window.comfyqConsole');
    check(`the preload ran (window.comfyqConsole is ${preload})`, preload === 'object');
    const page = await a.evalJs(`({
        token: typeof window.comfyqConsole?.token === 'string' && window.comfyqConsole.token.length >= 32,
        node: typeof require !== 'undefined' || typeof process !== 'undefined',
        settingsOpen: !document.getElementById('drawer-settings').hidden,
        spend: document.getElementById('spRate').innerText,
    })`) || {};
    check('the page was given a long random token', page.token);
    check('the page has no Node or Electron access', page.node === false);
    check('first run (no API key): Settings opens by itself', page.settingsOpen);
    check(`the spending tiles load (${page.spend})`, /\$/.test(page.spend || ''));
    // Delete's typed confirmation inside the app, where window.prompt() is not supported.
    const typed = await a.evalJs(`(async () => {
        const p = askCode({ title: 't', text: 'x', code: 'abc12345' });
        const input = document.getElementById('askInput');
        input.value = 'abc12345'; input.dispatchEvent(new Event('input'));
        document.getElementById('askOk').click();
        return await p;
    })()`);
    check(`the typed confirmation for Delete works in the app (${typed})`, typed === 'abc12345');

    const outside = async (header) => (await fetch(`${a.origin}/api/settings`, { headers: header ? { 'X-ComfyQ-Console': header } : {} })).status;
    check('another program with the old fixed header is refused', await outside('1') === 403);
    check('a wrong token is refused', await outside('0'.repeat(48)) === 403);
    check('no header is refused', await outside(null) === 403);

    // Phase 2: the keys moved.
    const s1 = await a.call('GET', '/api/settings');
    check(`the page's own calls work (${s1.status})`, s1.status === 200);
    check('the keys from the plain file are still known to the console', s1.data?.adminPassword?.set && s1.data?.hfToken?.set && s1.data.hfToken.hint === '…mnop');
    check('the console says the keys are in protected storage', s1.data?.secretsProtected === true);
    const plainAfter = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    check('they are gone from the plain settings file', !plainAfter.adminPassword && !plainAfter.hfToken && plainAfter.diskGb === 30);
    const bin = fs.existsSync(secretsFile) ? fs.readFileSync(secretsFile) : Buffer.alloc(0);
    check('they are in the encrypted file, and not readable there', bin.length > 0 && !bin.includes('admin-pw-plain') && !bin.includes('hf_testtoken'));

    // A key saved from the page lands only in protected storage.
    const before = bin.toString('base64');
    const put = await a.call('PUT', '/api/settings', { accessPassword: 'student-pw-5678' });
    check(`saving a password from the page works (${put.status})`, put.status === 200 && put.data?.accessPassword?.set);
    await sleep(500);
    const plain2 = fs.readFileSync(settingsFile, 'utf8');
    const bin2 = fs.readFileSync(secretsFile);
    check('it is not written to the plain file', !plain2.includes('student-pw'));
    check('the encrypted file was rewritten, still unreadable', bin2.toString('base64') !== before && !bin2.includes('student-pw'));

    // Workflows: refreshed from GitHub into the app's own copy.
    let idx = null;
    for (let i = 0; i < 60; i++) {
        try { idx = JSON.parse(fs.readFileSync(path.join(dataDir, 'app-cache', 'index.json'), 'utf8')); } catch { idx = null; }
        if (idx?.source === 'github') break;
        await sleep(1000);
    }
    check(`the workflow list was refreshed from GitHub (${idx?.source}, commit ${String(idx?.commit || '').slice(0, 7)})`, idx?.source === 'github');
    const wfs = await a.call('GET', '/api/workflows');
    check(`the console lists the workflows from that copy (${wfs.data?.workflows?.length})`, (wfs.data?.workflows?.length || 0) >= 50);
    // Phase 3: the tray, and closing the window.
    let trayEv = null;
    for (let i = 0; i < 20 && !trayEv; i++) { trayEv = events().filter(e => e.type === 'tray' && /\$/.test(e.tooltip)).pop(); if (!trayEv) await sleep(500); }
    check(`the tray shows what is spent (${trayEv?.tooltip})`, /^ComfyQ Console — \$0\.00\/h · nothing running · today \$0\.00$/.test(trayEv?.tooltip || ''));
    check(`no script error (${a.errors.join(' | ')})`, a.errors.length === 0);
    await a.evalJs('window.comfyqConsole.testCloseWindow(), 1');
    await sleep(1500);
    check('closing the window hides it, the app stays', events().some(e => e.type === 'hidden'));
    check('the console still answers with the window closed', (await fetch(`${a.origin}/`)).status === 200);
    const told = events().filter(e => e.type === 'notification' && /still running/.test(e.title));
    check('the first close says the app is still running in the tray, once', told.length === 1);
    check('nothing else was announced on an account with nothing running', events().filter(e => e.type === 'notification').length === 1);
    check('quitting the app stops the console server', await a.quit());
    a = null;

    // ---- second start: the keys come back from protected storage ----
    a = await launch();
    const s2 = await a.call('GET', '/api/settings');
    check('after a restart all three keys are still known', s2.data?.adminPassword?.set && s2.data?.hfToken?.set && s2.data?.accessPassword?.set);
    check('and still not in the plain file', !fs.readFileSync(settingsFile, 'utf8').match(/admin-pw|hf_testtoken|student-pw/));
    check('quitting stops it again', await a.quit());
    a = null;

    // ---- third start: an update, shown as it happens (a pretend updater) ----
    fs.writeFileSync(eventsFile, '');
    a = await launch({ COMFYQ_APP_FAKE_UPDATE: '9.9.9', COMFYQ_APP_FIRST_CHECK_MS: '6000' });
    const seen = [];
    let shotTaken = false;
    for (let i = 0; i < 60; i++) {
        const v = await a.evalJs(`({ shown: !document.getElementById('updBar').hidden, title: document.getElementById('updTitle').innerText,
            sub: document.getElementById('updSub').innerText, width: document.getElementById('updProgress').firstElementChild.style.width,
            install: !document.getElementById('updInstall').hidden })`);
        if (v.shown) seen.push(v);
        if (!shotTaken && /Downloading/.test(v.title) && parseInt(v.width) >= 40 && process.env.COMFYQ_APP_SHOT) { await a.shot(process.env.COMFYQ_APP_SHOT.replace('.png', '-downloading.png')); shotTaken = true; }
        if (v.install) break;
        await sleep(100);
    }
    const dl = seen.find(v => /^Downloading version 9\.9\.9 — \d+%$/.test(v.title) && /MB\/s/.test(v.sub));
    check(`the bar shows the download as it happens (${dl?.title} | ${dl?.sub})`, !!dl && /of 105\.8 MB · 12\.5 MB\/s · about \d+ s left · you are on/.test(dl.sub));
    const pcts = [...new Set(seen.map(v => parseInt(v.width)).filter(n => !isNaN(n)))];
    check(`the progress bar moves (${pcts.join(', ')}%)`, pcts.length >= 3);
    const ready = seen.find(v => v.install);
    check(`then: ready, with Restart and install now (${ready?.title})`, ready?.title === 'Version 9.9.9 is ready to install');
    const ev = events().filter(e => e.type === 'update').map(e => e.state);
    check(`the app went through every stage (${[...new Set(ev)].join(' → ')})`, ['checking', 'downloading', 'downloaded'].every(x => ev.includes(x)));
    const notes = await a.evalJs(`(document.getElementById('updNotesBtn').click(), document.getElementById('updNotes').hidden ? '' : document.getElementById('updNotes').innerText)`);
    check(`What's new shows the release notes (${notes.split('\n')[0]})`, /Delete asks for the code/.test(notes));
    const about = await a.evalJs(`document.getElementById('aboutBody').innerText`);
    check(`Settings → About & updates says it too (${about.replace(/\s+/g, ' ').slice(0, 90)})`, /downloaded: installs when you quit/.test(about) && /This version\s+0\.1\./.test(about));
    if (process.env.COMFYQ_APP_SHOT) await a.shot(process.env.COMFYQ_APP_SHOT);
    await a.evalJs(`document.getElementById('updInstall').click(), 1`);
    await sleep(500);
    check('Restart and install now asks the app to install', events().some(e => e.type === 'update-install'));
    check(`and the bar says it is installing (${await a.evalJs("document.getElementById('updTitle').innerText")})`, /Installing version 9\.9\.9/.test(await a.evalJs("document.getElementById('updTitle').innerText")));
    check(`no script error (${a.errors.join(' | ')})`, a.errors.length === 0);
    check('quitting stops it', await a.quit());
    a = null;
} catch (e) {
    console.log(`  BROKEN ${e.message}`); bad++;
} finally {
    if (a) await a.quit().catch(() => {});
    await sleep(500);
    if (process.env.COMFYQ_APP_KEEP_HOME) console.log('  kept', home); else try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* a file may still be held */ }
}
console.log(`app smoke: ${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
