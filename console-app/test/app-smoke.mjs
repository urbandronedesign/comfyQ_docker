// node console-app/test/app-smoke.mjs — starts the real app and checks it.
//
//  - the window loads the console page, with no script error;
//  - the page's own calls work (it got the token through the preload);
//  - another program calling the same port is refused, with the browser's old
//    fixed header and with a wrong token;
//  - quitting the app stops the console server.
// Runs with a throwaway home folder, so no saved key is read or written.
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
const env = { ...process.env, COMFYQ_APP_SERVER_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;   // set in some shells: it would run Electron as plain Node
const DEBUG = 9345;
const child = spawn(ELECTRON, [APP, `--remote-debugging-port=${DEBUG}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const appLog = [];
child.stdout.on('data', d => appLog.push(String(d)));
child.stderr.on('data', d => appLog.push(String(d)));

try {
    // Find the console window.
    let target;
    for (let i = 0; i < 100 && !target; i++) {
        try { target = (await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json()).find(t => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url)); } catch { /* not up yet */ }
        if (!target) await sleep(300);
    }
    check('the app opens a window on the local console server', !!target);
    if (!target) throw new Error('no window');
    const origin = new URL(target.url).origin;
    const port = Number(new URL(target.url).port);
    check(`the server is on a random port, not 4777 (${port})`, port !== 4777);

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

    const preload = await evalJs('typeof window.comfyqConsole');
    check(`the preload ran (window.comfyqConsole is ${preload})`, preload === 'object');
    const page = await evalJs(`(async () => ({
        token: typeof window.comfyqConsole?.token === 'string' && window.comfyqConsole.token.length >= 32,
        node: typeof require !== 'undefined' || typeof process !== 'undefined',
        settingsOpen: !document.getElementById('drawer-settings').hidden,
        call: await fetch('/api/settings', { headers: { 'X-ComfyQ-Console': window.comfyqConsole.token } }).then(r => r.status),
        spend: document.getElementById('spRate').innerText,
    }))()`) || {};
    check('the page was given a long random token', page.token);
    check('the page has no Node or Electron access', page.node === false);
    check(`the page's own calls work (${page.call})`, page.call === 200);
    check('first run (no key): Settings opens by itself', page.settingsOpen);
    check(`the spending tiles load (${page.spend})`, /\$/.test(page.spend));
    check(`no script error (${errors.join(' | ')})`, errors.length === 0);

    const outside = async (header) => (await fetch(`${origin}/api/settings`, { headers: header ? { 'X-ComfyQ-Console': header } : {} })).status;
    check('another program with the old fixed header is refused', await outside('1') === 403);
    check('a wrong token is refused', await outside('0'.repeat(48)) === 403);
    check('no header is refused', await outside(null) === 403);
    ws.close();

    // Quit: the server must go with the app.
    child.kill();
    let down = false;
    for (let i = 0; i < 30 && !down; i++) { await sleep(300); try { await fetch(`${origin}/`); } catch { down = true; } }
    check('quitting the app stops the console server', down);
} catch (e) {
    console.log(`  BROKEN ${e.message}
${appLog.join('').slice(-1500)}`); bad++;
} finally {
    try { child.kill(); } catch { /* gone */ }
    await sleep(500);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* Chrome may still hold a file */ }
}
console.log(`app smoke: ${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
