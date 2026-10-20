// ComfyQ Console — the desktop app around tools/runpod/console.
//
// The console stays what it is: a small local server (server.mjs) and its page.
// This process starts that server as a child on a random port of this machine
// only, with a fresh random token that only this app's window is given, then
// shows the page in a window. Another program on the machine can no longer call
// the console (and spend with its keys) by sending the browser's fixed header.
'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } = require('electron');
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
let quitting = false;

// One app at a time: a second launch brings the first window forward.
if (!app.requestSingleInstanceLock()) { app.quit(); return; }
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

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
    win.loadURL(`${origin}/`);
}

// The token goes only to this app's own page.
ipcMain.on('console-token', (e) => {
    e.returnValue = e.senderFrame && e.senderFrame.url.startsWith(`http://127.0.0.1:${port}/`) ? TOKEN : null;
});

app.whenReady().then(async () => {
    try { await startServer(); }
    catch (e) { dialog.showErrorBox('ComfyQ Console', e.message); app.quit(); return; }
    createWindow();
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());
app.on('quit', () => { try { server?.kill(); } catch { /* already gone */ } });
