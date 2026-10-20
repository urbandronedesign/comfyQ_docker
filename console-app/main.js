// ComfyQ Console — the desktop app around tools/runpod/console.
//
// The console stays what it is: a small local server (server.mjs) and its page.
// This process starts that server as a child on a random port of this machine
// only, with a fresh random token that only this app's window is given, then
// shows the page in a window. Another program on the machine can no longer call
// the console (and spend with its keys) by sending the browser's fixed header.
'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage, Tray, Menu, Notification, nativeImage } = require('electron');
const fs = require('fs');
const watch = require('./watch');
const { fork, spawnSync } = require('child_process');
const secretsStore = require('./secrets');
const workflowsCache = require('./workflows');
const crypto = require('crypto');
const net = require('net');
const path = require('path');

// Where the console's code lives: beside this folder when run from the repo;
// inside the installed app's resources once packaged (see electron-builder.yml).
const CONSOLE_DIR = app.isPackaged
    ? path.join(process.resourcesPath, 'comfyq', 'tools', 'runpod', 'console')
    : path.join(__dirname, '..', 'tools', 'runpod', 'console');

// Run from the repo, the console reads the repo's own workflows; installed, a
// copy kept up to date from GitHub (or forced with COMFYQ_APP_GITHUB_WORKFLOWS=1).
const REPO_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'comfyq') : path.join(__dirname, '..');
const USE_WORKFLOW_CACHE = app.isPackaged || process.env.COMFYQ_APP_GITHUB_WORKFLOWS === '1';

const TOKEN = crypto.randomBytes(24).toString('hex');
let server = null;       // the console server child process
let port = null;
let win = null;
let quitting = false;      // a quit is under way (confirmed, or nothing billed)
let tray = null;
let lastSpend = null;      // the last GET /api/spend, for the tray and the quit question
let watchState = null;
let toldTray = false;      // said once that closing keeps the app in the tray
const ICON = path.join(__dirname, 'assets', 'icon.png');

// Test hook: what the app announces, one JSON line each (console-app/test).
function record(ev) {
    if (!process.env.COMFYQ_APP_EVENTS_FILE) return;
    try { fs.appendFileSync(process.env.COMFYQ_APP_EVENTS_FILE, JSON.stringify({ at: Date.now(), ...ev }) + '\n'); } catch { /* test only */ }
}

function showWindow() {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
}

function notify(title, body) {
    record({ type: 'notification', title, body });
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: ICON, silent: false });
    n.on('click', showWindow);
    n.show();
}

// One app at a time: a second launch brings the first window forward.
if (!app.requestSingleInstanceLock()) { app.quit(); return; }
app.on('second-instance', () => showWindow());
if (process.platform === 'win32') app.setAppUserModelId('com.comfyq.console');

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}

// Start server.mjs with this app's Node (Electron run as Node), and wait for it
// to say it is listening.
// Thunder's setup runs over ssh: without OpenSSH an instance would be created,
// and bill, and never start ComfyQ. The page warns before a launch.
function sshMissing() {
    const r = spawnSync('ssh', ['-V'], { windowsHide: true, timeout: 5000 });
    return !!r.error;
}

async function startServer() {
    port = await freePort();

    // Keys: Windows protection when it is available, the plain file otherwise.
    let secrets = null, store = null;
    const extraEnv = {};
    try {
        store = secretsStore.create(safeStorage);
        if (store.available) {
            const r = store.load();
            secrets = r.secrets;
            extraEnv.COMFYQ_SECRETS = 'parent';
            if (r.migrated.length) console.log(`[console-app] moved ${r.migrated.join(', ')} into Windows protected storage`);
        }
    } catch (e) {
        dialog.showErrorBox('ComfyQ Console', `Your keys could not be read from Windows protected storage, so this start keeps them in the plain settings file.\n\n${e.message}`);
        store = null;
    }

    if (USE_WORKFLOW_CACHE) {
        const where = workflowsCache.prepare({
            workflows: path.join(REPO_ROOT, 'workflows'),
            downloads: path.join(REPO_ROOT, 'tools', 'model-provenance', 'workflow-downloads.json'),
        });
        extraEnv.COMFYQ_WORKFLOWS_DIR = where.workflowsDir;
        extraEnv.COMFYQ_DOWNLOADS_FILE = where.downloadsFile;
        // In the background: the server reads these files on each request.
        workflowsCache.refresh().then(r => console.log('[console-app] workflows from GitHub:', JSON.stringify(r)));
    }
    if (sshMissing()) extraEnv.COMFYQ_SSH_MISSING = '1';
    server = fork(path.join(CONSOLE_DIR, 'server.mjs'), ['--no-open'], {
        env: {
            ...process.env,
            // Test hook: the console's data folder (~/.comfyq) for the server
            // alone. Electron itself crashes on a made-up Windows profile.
            ...(process.env.COMFYQ_APP_SERVER_HOME ? { USERPROFILE: process.env.COMFYQ_APP_SERVER_HOME, HOME: process.env.COMFYQ_APP_SERVER_HOME } : {}),
            ...extraEnv,
            ELECTRON_RUN_AS_NODE: '1',
            COMFYQ_CONSOLE_PORT: String(port),
            COMFYQ_CONSOLE_TOKEN: TOKEN,
            COMFYQ_CONSOLE_SOURCE: 'app',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
    });
    const log = [];
    const keep = (chunk) => { log.push(String(chunk)); if (log.length > 50) log.shift(); };
    // The server asks for the keys once, and sends any change to keep.
    server.on('message', (m) => {
        if (m?.type === 'want-secrets') server.send({ type: 'secrets-init', secrets: secrets || {} });
        if (m?.type === 'secrets' && store?.available) {
            try { secrets = store.save(m.secrets); }
            catch (e) { dialog.showErrorBox('ComfyQ Console', `The new keys could not be saved in Windows protected storage: ${e.message}`); }
        }
    });
    server.stdout.on('data', keep);
    server.stderr.on('data', keep);
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`the console server did not start in 30 s\n${log.join('')}`)), 30000);
        server.on('message', (m) => { if (m?.ready) { clearTimeout(t); resolve(); } });
        server.on('exit', (code) => { clearTimeout(t); reject(new Error(`the console server stopped (exit ${code})\n${log.join('')}`)); });
    });
    server.removeAllListeners('exit');
    server.on('exit', (code) => {
        if (quitting) return;
        dialog.showErrorBox('ComfyQ Console', `The console server stopped (exit ${code}). The app will close; start it again.\n\n${log.join('').slice(-2000)}`);
        app.quit();
    });
}

function createWindow() {
    const origin = `http://127.0.0.1:${port}`;
    win = new BrowserWindow({
        width: 1440, height: 940, minWidth: 900, minHeight: 600,
        backgroundColor: '#050506',
        title: 'ComfyQ Console',
        icon: path.join(__dirname, 'assets', 'icon.png'),
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    // The window shows the console and nothing else: other links open in the
    // default browser (student pages, admin panels, RunPod, HuggingFace).
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith(origin + '/')) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
    });
    // Closing the window keeps the app (and its billing alerts) in the tray.
    win.on('close', (e) => {
        if (quitting) return;
        e.preventDefault();
        win.hide();
        record({ type: 'hidden' });
        if (!toldTray) {
            toldTray = true;
            notify('ComfyQ Console is still running', 'It keeps watching what you spend from the tray. Right-click its icon to quit.');
        }
    });
    win.loadURL(`${origin}/`);
}

// ---- the console's own figures, read like the page reads them ----
async function consoleGet(route) {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { 'X-ComfyQ-Console': TOKEN }, signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error(`${route}: HTTP ${r.status}`);
    return r.json();
}

// Where each machine is, for "serving" and "setup failed".
async function machineStages() {
    const out = [];
    try {
        const { instances } = await consoleGet('/api/thunder/instances');
        for (const i of instances) {
            const r = i.rec;
            const stage = i.probe?.answering && i.probe.mode === 'student' ? 'serving'
                : r && ['failed', 'interrupted'].includes(r.state) ? 'failed'
                : r ? 'setting-up' : 'other';
            out.push({ provider: 'thunder', id: i.uuid, name: (r?.serve || []).join(' + ') || i.uuid.slice(0, 8), stage, detail: r?.error || null });
        }
    } catch { /* no Thunder key, or Thunder unreachable */ }
    try {
        const { pods } = await consoleGet('/api/pods');
        for (const p of pods.filter(x => x.desiredStatus === 'RUNNING')) {
            let stage = 'setting-up', detail = null;
            try {
                const { probe } = await consoleGet(`/api/pods/${encodeURIComponent(p.id)}`);
                if (['failed', 'refused'].includes(probe?.plan?.status)) { stage = 'failed'; detail = probe.plan.error; }
                else if (probe?.answering && probe.mode === 'student') stage = 'serving';
            } catch { /* keep "setting up" */ }
            out.push({ provider: 'runpod', id: p.id, name: p.name, stage, detail });
        }
    } catch { /* no RunPod key, or RunPod unreachable */ }
    return out;
}

function updateTray() {
    if (!tray) return;
    const line = watch.trayLine(lastSpend);
    tray.setToolTip(trayUpdateLine() ? `${line}
${trayUpdateLine()}` : line);
    const ms = lastSpend?.machines || [];
    const money = (v) => `$${Number(v || 0).toFixed(2)}`;
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open ComfyQ Console', click: showWindow },
        { type: 'separator' },
        { label: lastSpend ? `Now ${money(lastSpend.ratePerHr)}/h · today ${money(lastSpend.today)}` : 'Reading what you spend…', enabled: false },
        ...ms.map(m => ({ label: `${m.provider === 'thunder' ? 'Thunder' : 'RunPod'} · ${m.name || m.id} · ${money(m.ratePerHr)}/h`, enabled: false })),
        { type: 'separator' },
        { label: `Version ${app.getVersion()}${app.isPackaged ? '' : ' (from the repo)'}`, enabled: false },
        ...(trayUpdateLine() ? [{ label: trayUpdateLine(), enabled: false }] : []),
        ...(update.state === 'downloaded' ? [{ label: `Restart and install version ${update.version}`, click: installNow }] : []),
        ...(updater ? [{ label: 'Check for updates', click: () => { showWindow(); checkForUpdates(true); } }] : []),
        { label: 'Quit', click: () => app.quit() },
    ]));
    record({ type: 'tray', tooltip: line });
}

async function tick() {
    try { lastSpend = await consoleGet('/api/spend'); } catch { /* keep the last figures */ }
    updateTray();
    if (!lastSpend) return;
    const machines = await machineStages();
    const r = watch.decide(watchState, { spend: lastSpend, machines }, Date.now());
    watchState = r.state;
    for (const ev of r.events) notify(ev.title, ev.body);
}

// ---- updates (installed app only) ----
// New versions come from this repo's GitHub Releases (tags console-v*). Shown as
// they happen, in the window (a bar at the top, and Settings → About & updates),
// in the tray, and in ~/.comfyq/console-app.log: found (with the release notes),
// downloading (percent, MB, speed, time left), ready (Restart and install now /
// Later — it installs on quit), or what went wrong.
let updater = null;
let lastCheck = 0;
let manualCheck = false;
let lastProgressPush = 0;
const update = {           // everything the page and the tray show
    current: app.getVersion(),
    available: false,      // false in a copy run from the repo: no updater there
    state: 'idle',         // idle | checking | uptodate | available | downloading | downloaded | error
    version: null, notes: null, releaseDate: null,
    percent: 0, transferred: 0, total: 0, bytesPerSecond: 0,
    error: null, lastCheck: null, manual: false,
};

// Every check, with its outcome, goes to ~/.comfyq/console-app.log: an update
// that does not arrive can then be explained.
function updateLog(msg) {
    try {
        const file = path.join(process.env.COMFYQ_APP_SERVER_HOME || require('os').homedir(), '.comfyq', 'console-app.log');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${new Date().toISOString()} [update] ${msg}\n`);
    } catch { /* logging must never break the app */ }
}

const mb = (b) => `${(Number(b || 0) / 1e6).toFixed(1)} MB`;
function trayUpdateLine() {
    if (update.state === 'downloading') return `Downloading version ${update.version}: ${Math.round(update.percent)}% (${mb(update.transferred)} of ${mb(update.total)})`;
    if (update.state === 'downloaded') return `Version ${update.version} ready: installs when you quit`;
    if (update.state === 'available') return `Version ${update.version} found`;
    if (update.state === 'checking') return 'Checking for updates…';
    if (update.state === 'error') return 'Update failed: see the window';
    return '';
}

// Send the state to the window and the tray.
function pushUpdate(patch = {}) {
    Object.assign(update, patch);
    record({ type: 'update', state: update.state, version: update.version, percent: Math.round(update.percent) });
    try { win?.webContents.send('update-status', update); } catch { /* window going away */ }
    updateTray();
}

function checkForUpdates(manual = false) {
    if (!updater) return;
    if (['downloading', 'downloaded'].includes(update.state)) { if (manual) showWindow(); return; }
    manualCheck = manual;
    lastCheck = Date.now();
    updateLog(`checking (version ${app.getVersion()}${manual ? ', asked by you' : ''})`);
    pushUpdate({ state: 'checking', error: null, manual, lastCheck: new Date().toISOString() });
    updater.checkForUpdates().catch((e) => {
        updateLog(`check failed: ${e.message}`);
        pushUpdate({ state: 'error', error: `Could not check for updates: ${String(e.message).split('\n')[0]}` });
    });
}

function installNow() {
    if (update.state !== 'downloaded') return;
    updateLog(`installing version ${update.version} now (asked by you)`);
    record({ type: 'update-install' });
    if (updater.fake) { pushUpdate({ state: 'installing' }); return; }
    // A restart for an update is quick, and the machines keep billing either way:
    // no quit question here.
    quitting = true;
    setImmediate(() => updater.quitAndInstall(false, true));
}

function wireUpdater(u) {
    updater = u;
    u.autoDownload = true;
    u.autoInstallOnAppQuit = true;
    u.on('checking-for-update', () => pushUpdate({ state: 'checking' }));
    u.on('update-available', (i) => {
        updateLog(`version ${i.version} found, downloading`);
        const notes = Array.isArray(i.releaseNotes) ? i.releaseNotes.map(n => n.note).join('\n\n') : i.releaseNotes;
        pushUpdate({ state: 'downloading', version: i.version, notes: String(notes || '').replace(/<[^>]+>/g, '').trim() || null, releaseDate: i.releaseDate || null, percent: 0, transferred: 0, total: i.files?.[0]?.size || 0, bytesPerSecond: 0 });
        if (!win?.isVisible()) notify('ComfyQ Console', `Version ${i.version} found: downloading it.`);
    });
    u.on('download-progress', (p) => {
        Object.assign(update, { state: 'downloading', percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond });
        // A few times a second at most.
        if (Date.now() - lastProgressPush > 250 || p.percent >= 100) { lastProgressPush = Date.now(); pushUpdate(); }
    });
    u.on('update-not-available', () => {
        updateLog('up to date');
        pushUpdate({ state: 'uptodate', version: null });
    });
    u.on('error', (e) => {
        const msg = String(e?.message || e).split('\n')[0];
        updateLog(`error: ${msg}`);
        pushUpdate({ state: 'error', error: msg });
    });
    u.on('update-downloaded', (i) => {
        updateLog(`version ${i.version} downloaded, installs on quit unless installed now`);
        pushUpdate({ state: 'downloaded', version: i.version, percent: 100 });
        if (!win?.isVisible()) notify('ComfyQ Console update ready', `Version ${i.version} is downloaded. Open the app to install it now, or it installs when you quit.`);
    });
}

// Test hook (COMFYQ_APP_FAKE_UPDATE=<version>): a pretend updater that goes
// through every stage without the network, so the window's update display is
// tested in a copy run from the repo.
function fakeUpdater(version) {
    const { EventEmitter } = require('events');
    const u = new EventEmitter();
    u.fake = true;
    u.checkForUpdates = async () => {
        u.emit('checking-for-update');
        await new Promise(r => setTimeout(r, 300));
        const total = 105_791_273;
        u.emit('update-available', { version, releaseNotes: 'Delete asks for the code in the window.\nUpdates show their progress.', files: [{ size: total }] });
        for (let pct = 10; pct <= 100; pct += 10) {
            await new Promise(r => setTimeout(r, 150));
            u.emit('download-progress', { percent: pct, transferred: total * pct / 100, total, bytesPerSecond: 12_500_000 });
        }
        u.emit('update-downloaded', { version });
    };
    return u;
}

function setupUpdates() {
    if (process.env.COMFYQ_APP_FAKE_UPDATE) wireUpdater(fakeUpdater(process.env.COMFYQ_APP_FAKE_UPDATE));
    else if (app.isPackaged) wireUpdater(require('electron-updater').autoUpdater);   // here, not at the top: it reads app details on load
    update.available = !!updater;
    pushUpdate();
    if (!updater) return;
    // Soon after start, every 30 minutes, and when the window is opened (at most
    // every 5 minutes): one check at start and then every 6 hours missed a release
    // published while the app was already running.
    setTimeout(() => checkForUpdates(), Number(process.env.COMFYQ_APP_FIRST_CHECK_MS) || 10_000);
    setInterval(() => checkForUpdates(), 30 * 60_000);
    win?.on('show', () => { if (Date.now() - lastCheck > 5 * 60_000) checkForUpdates(); });
}

// The page asks, and acts, through the preload.
ipcMain.handle('update-get', () => update);
ipcMain.on('update-check', () => checkForUpdates(true));
ipcMain.on('update-install', () => installNow());

function startWatching() {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.on('click', showWindow);
    updateTray();
    tick();
    setInterval(tick, Number(process.env.COMFYQ_APP_WATCH_MS) || 30000);
}

// Test hook: the page cannot close its own top-level window (Chromium refuses
// window.close()), so the test asks the app to, as the ✕ button would.
if (process.env.COMFYQ_APP_EVENTS_FILE) ipcMain.on('test-close-window', () => win?.close());

// The token goes only to this app's own page.
ipcMain.on('console-token', (e) => {
    e.returnValue = e.senderFrame && e.senderFrame.url.startsWith(`http://127.0.0.1:${port}/`) ? TOKEN : null;
});

app.whenReady().then(async () => {
    try { await startServer(); }
    catch (e) { dialog.showErrorBox('ComfyQ Console', e.message); app.quit(); return; }
    createWindow();
    startWatching();
    setupUpdates();
});

// Quitting while a machine bills asks first: the machines keep billing after
// the app quits, and nothing warns about them any more.
app.on('before-quit', (e) => {
    if (quitting) return;
    const q = watch.quitQuestion(lastSpend);
    if (!q) { quitting = true; return; }
    e.preventDefault();
    showWindow();
    dialog.showMessageBox(win, {
        type: 'warning', title: 'ComfyQ Console', message: q.title, detail: q.detail,
        buttons: ['Keep the app running', 'Quit anyway'], defaultId: 0, cancelId: 0, noLink: true,
    }).then(({ response }) => {
        record({ type: 'quit-question', answer: response });
        if (response === 1) { quitting = true; app.quit(); }
    });
});
// The tray keeps the app alive with no window open.
app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('quit', () => { try { server?.kill(); } catch { /* already gone */ } });
