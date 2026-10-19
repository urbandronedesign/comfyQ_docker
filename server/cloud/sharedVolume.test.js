// Several Pods on one volume: heartbeats, and one download per model.
// (node server/cloud/sharedVolume.test.js) Two Pods are simulated by two
// instances on one temp folder with a controllable clock.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { podId, Heartbeats, DownloadLocks, LOCK_STALE_MS, PART_QUIET_MS, ALIVE_MS } = require('./sharedVolume');
const { ModelDownloader } = require('../models/modelDownloader');

const ok = [];
const check = (label, cond) => { assert.ok(cond, label); ok.push(label); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfyq-shared-'));
const shared = path.join(dir, 'shared');
const models = path.join(shared, 'models', 'loras');
fs.mkdirSync(models, { recursive: true });

let clock = Date.now();
const now = () => clock;
const ageFile = (file, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(file, t, t); };
const quiet = () => {};

(async () => {
    // ---- pod id --------------------------------------------------------------
    check('the entrypoint POD_ID wins', podId({ POD_ID: 'abc', RUNPOD_POD_ID: 'zzz' }) === 'abc');
    check('then RunPod\'s id', podId({ RUNPOD_POD_ID: 'zzz' }) === 'zzz');
    check('unsafe characters are replaced', podId({ POD_ID: 'a/b c' }) === 'a_b_c');

    // ---- heartbeats -------------------------------------------------------------
    const hbA = new Heartbeats({ sharedDir: shared, id: 'podA', info: () => ({ mode: 'student', serving: ['wf1'] }), now });
    const hbB = new Heartbeats({ sharedDir: shared, id: 'podB', info: () => ({ mode: 'admin' }), now });
    hbA.beat(); hbB.beat();
    check('each Pod sees the other', hbA.others().map(o => o.id).join() === 'podB' && hbB.others().map(o => o.id).join() === 'podA');
    check('...with what it serves', hbB.others()[0].serving?.[0] === 'wf1');
    check('a Pod never counts itself', !hbA.others().some(o => o.id === 'podA'));
    clock += ALIVE_MS + 1000; hbA.beat();
    check('a Pod silent for over 3 minutes is gone', hbA.others().length === 0 && !hbA.isAlive('podB'));
    hbB.beat();
    check('...and back once it beats again', hbA.isAlive('podB'));
    hbB.stop();
    check('a Pod that stops says goodbye at once', hbA.others().length === 0);
    const off = new Heartbeats({ sharedDir: null, id: 'x' });
    off.beat();
    check('off the shared volume: no heartbeat, nobody else', !off.enabled && off.others().length === 0);

    // ---- download lock ----------------------------------------------------------
    clock = Date.now();
    const alive = new Set();
    const locksA = new DownloadLocks({ id: 'podA', isAlive: id => alive.has(id), now, log: quiet });
    const locksB = new DownloadLocks({ id: 'podB', isAlive: id => alive.has(id), now, log: quiet });
    const target = path.join(models, 'big.safetensors');

    const a = locksA.acquire(target);
    check('the first Pod gets the lock', a.ok);
    const b = locksB.acquire(target);
    check('the second Pod does not', !b.ok && b.owner === 'podA');
    a.release();
    check('released, the lock file is gone', !fs.existsSync(`${target}.lock`));
    const b2 = locksB.acquire(target);
    check('then the second Pod gets it', b2.ok);
    b2.release();

    // Own lock left by this Pod's previous container: taken back at once.
    fs.writeFileSync(`${target}.lock`, JSON.stringify({ pod: 'podA' }));
    check('a Pod takes back its own leftover lock', locksA.acquire(target).ok);
    fs.rmSync(`${target}.lock`);

    // ★ A lock is taken from another Pod only when ALL THREE signs agree.
    const stale = () => {
        fs.writeFileSync(`${target}.lock`, JSON.stringify({ pod: 'podDead' }));
        ageFile(`${target}.lock`, LOCK_STALE_MS + 60_000);
        fs.writeFileSync(`${target}.part`, 'x');
        ageFile(`${target}.part`, PART_QUIET_MS + 60_000);
        clock = Date.now();
    };
    stale();
    alive.add('podDead');
    check('not taken while the owner still beats', !locksB.acquire(target).ok);
    alive.delete('podDead');
    ageFile(`${target}.part`, 10_000);
    check('not taken while its .part is still growing', !locksB.acquire(target).ok);
    stale();
    ageFile(`${target}.lock`, 60_000);
    check('not taken while the lock was refreshed recently', !locksB.acquire(target).ok);
    stale();
    const took = locksB.acquire(target);
    check('taken when it is old, its owner gone, and its .part quiet', took.ok);
    check('...and the lock now names the new owner', JSON.parse(fs.readFileSync(`${target}.lock`, 'utf8')).pod === 'podB');
    took.release();
    fs.rmSync(`${target}.part`, { force: true });

    // A release never removes a lock somebody else now holds.
    const mine = locksA.acquire(target);
    fs.writeFileSync(`${target}.lock`, JSON.stringify({ pod: 'podB' }));
    mine.release();
    check('a release leaves a lock that is no longer ours', fs.existsSync(`${target}.lock`));
    fs.rmSync(`${target}.lock`);

    // ---- the downloader with two Pods -------------------------------------------------
    const BODY = Buffer.alloc(64 * 1024, 7);
    let hits = 0;
    const server = http.createServer((req, res) => {
        hits++;
        res.writeHead(200, { 'content-length': String(BODY.length) });
        // Slow enough that the other Pod finds the lock held.
        setTimeout(() => res.end(BODY), 300);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    // The downloader accepts only https links; the fixture serves plain http,
    // so the link says https://fixture.test and fetch is pointed at the fixture.
    const realFetch = global.fetch;
    global.fetch = (u, o) => realFetch(String(u).replace(/^https:\/\/fixture\.test/, `http://127.0.0.1:${server.address().port}`), o);
    const link = 'https://fixture.test/loras/shared.safetensors';

    const comfyRoot = shared;    // models live at shared/models
    const cfgFn = () => ({ comfy_ui: { root_path: comfyRoot } });
    const dlA = new ModelDownloader({ config: cfgFn, locks: locksA, waitPollMs: 150 });
    const dlB = new ModelDownloader({ config: cfgFn, locks: locksB, waitPollMs: 150 });
    const ra = dlA.enqueue({ name: 'shared.safetensors', url: link, type: 'lora' });
    await new Promise(r => setTimeout(r, 60));
    const rb = dlB.enqueue({ name: 'shared.safetensors', url: link, type: 'lora' });
    check('both Pods queue the same missing model', ra.ok && rb.ok);
    await new Promise(r => setTimeout(r, 120));
    check('the second Pod WAITS instead of downloading it too', dlB.list()[0].status === 'waiting' && dlB.list()[0].waitingFor === 'podA');
    const settle = async (dl) => {
        for (let i = 0; i < 100; i++) {
            const j = dl.list()[0];
            if (j && ['done', 'failed', 'cancelled'].includes(j.status)) return j;
            await new Promise(r => setTimeout(r, 50));
        }
        return dl.list()[0];
    };
    const ja = await settle(dlA), jb = await settle(dlB);
    check('the first Pod downloads it', ja.status === 'done' && !ja.installedBy);
    check('the second sees it finished by another Pod', jb.status === 'done' && jb.installedBy === 'another Pod');
    check('the file was fetched exactly once', hits === 1);
    check('and it is whole', fs.statSync(path.join(shared, 'models', 'loras', 'shared.safetensors')).size === BODY.length);
    check('no lock and no .part left behind',
        !fs.existsSync(path.join(shared, 'models', 'loras', 'shared.safetensors.lock'))
        && !fs.existsSync(path.join(shared, 'models', 'loras', 'shared.safetensors.part')));

    // A waiting download can be cancelled, and then forgotten.
    const t2 = path.join(shared, 'models', 'loras', 'other.safetensors');
    const held = locksA.acquire(t2);
    const rc = dlB.enqueue({ name: 'other.safetensors', url: 'https://fixture.test/loras/other.safetensors', type: 'lora' });
    await new Promise(r => setTimeout(r, 60));
    check('a waiting download can be cancelled', dlB.cancel(rc.key).ok && dlB.list().find(j => j.key === rc.key).status === 'cancelled');
    held.release();

    global.fetch = realFetch;
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`sharedVolume: all ${ok.length} checks passed`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
