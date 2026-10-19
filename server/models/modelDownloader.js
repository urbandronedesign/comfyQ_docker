const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { resolveDestination } = require('./modelDestination');
const { DownloadLocks } = require('../cloud/sharedVolume');

// Fetch a model onto THIS machine.
//
// ★ Server-side, not browser-side, and that is not a preference. The admin
// panel is routinely opened from another computer — there is a "Copy admin
// link" button for exactly that — so a browser download lands on whoever's
// laptop is open, not on the rig that needs the weights. And the only web API
// that could choose a folder, showDirectoryPicker(), needs a secure context,
// which plain HTTP on the LAN is not (a standing constraint: HTTPS was tried
// and reverted because self-signed certs cannot be trusted across BYOD
// devices).
//
// What makes this worth having rather than a link:
//   - it resumes, because these are 1–40 GB files on a workshop LAN
//   - it checks free space first, because filling the drive that holds the
//     queue database is a worse outcome than a failed download
//   - it writes to <name>.part and renames only on success, so an interrupted
//     download can never be mistaken for an installed model — which matters
//     doubly here, since a half-file would read as INSTALLED to the prune tool
//   - it carries a HuggingFace token, because 8 of this library's links are
//     gated (FLUX.2, LTX-2.5) and answer 401 without one

const PART_SUFFIX = '.part';
// How often a download waiting on another Pod's lock looks again.
const WAIT_POLL_MS = 15_000;
// A transfer that delivers nothing for this long is abandoned (the .part is
// kept, so a retry resumes). Without it a server that goes quiet mid-file
// leaves the download "downloading" for ever — and, on a shared volume, its
// lock refreshed for ever, so every other Pod would wait on it too.
const STALL_MS = 2 * 60_000;
const HEADROOM_BYTES = 2 * 1024 ** 3;   // never fill the disk to the last byte

/**
 * Is this URL really HuggingFace?
 *
 * ★ Parsed, never grepped. The access token is a credential for someone's HF
 * account, and a substring test on the whole URL would hand it to any host whose
 * path happened to contain "huggingface.co" — a mirror, a caching proxy, or a
 * link an admin pasted from a third party.
 */
function isHuggingFace(url) {
    let h;
    try { h = new URL(String(url)).hostname.toLowerCase(); } catch { return false; }
    return h === 'huggingface.co' || h.endsWith('.huggingface.co');
}

class ModelDownloader {
    /**
     * @param {object} opts
     * @param {() => object} opts.config     reads config fresh, like AdminCalibrator
     * @param {(jobs:Array) => void} [opts.onChange]  called whenever state moves
     */
    constructor({ config, onChange, locks, waitPollMs = WAIT_POLL_MS, stallMs = STALL_MS } = {}) {
        this._config = config;
        // One download per model file across every Pod on a shared volume
        // (Phase I3). Harmless on a single machine.
        this._locks = locks || new DownloadLocks();
        this._waitPollMs = waitPollMs;
        this._stallMs = stallMs;
        this._onChange = onChange || (() => {});
        this._jobs = new Map();      // key -> job
        this._running = null;        // key of the one in flight
        this._aborts = new Map();    // key -> AbortController
    }

    list() {
        return [...this._jobs.values()].map(j => ({ ...j, abs: undefined, dest: j.dest }));
    }

    _emit() {
        try { this._onChange(this.list()); } catch { /* a listener must not break a download */ }
    }

    _set(key, patch) {
        const prev = this._jobs.get(key) || {};
        this._jobs.set(key, { ...prev, ...patch });
        this._emit();
    }

    /**
     * Queue a download. Returns { ok, key } or { ok:false, error }.
     * `dir` is optional and only needed when the link and the declared type
     * together cannot say where the file belongs.
     */
    enqueue({ name, url, type, dir }) {
        const cfg = this._config() || {};
        const comfyRoot = cfg.comfy_ui?.root_path || '';
        if (!comfyRoot) return { ok: false, error: 'ComfyUI root path is not configured' };
        if (!/^https:\/\//i.test(String(url || ''))) {
            return { ok: false, error: 'only https downloads are accepted' };
        }

        const target = resolveDestination({ comfyRoot, url, type, file: name, dir });
        if (!target.abs) {
            return { ok: false, error: `cannot place this file: ${target.why}`, needsDir: !target.dir };
        }

        const key = target.abs.toLowerCase();
        const existing = this._jobs.get(key);
        if (existing && ['queued', 'downloading', 'waiting'].includes(existing.status)) {
            return { ok: false, error: 'that download is already in progress' };
        }
        // ★ Never overwrite a model that is already there. A download is a
        // repair for something missing; silently replacing a working file is
        // how a rig ends up with weights nobody chose.
        if (fs.existsSync(target.abs)) {
            return { ok: false, error: `${path.basename(target.abs)} is already installed at models/${target.dir}` };
        }

        this._set(key, {
            key,
            name: target.name,
            url,
            dir: target.dir,
            dest: `models/${target.dir}/${target.name}`,
            abs: target.abs,
            placedBy: target.from,
            placedWhy: target.why,
            status: 'queued',
            received: 0,
            total: null,
            error: null,
        });
        this._pump();
        return { ok: true, key, dest: `models/${target.dir}/${target.name}` };
    }

    cancel(key) {
        const k = String(key || '').toLowerCase();
        const job = this._jobs.get(k);
        if (!job) return { ok: false, error: 'no such download' };
        const ctl = this._aborts.get(k);
        if (ctl) ctl.abort();
        if (job.status === 'queued' || job.status === 'waiting') this._set(k, { status: 'cancelled' });
        return { ok: true };
    }

    /** Forget a finished row, so the list does not grow for ever. */
    forget(key) {
        const k = String(key || '').toLowerCase();
        const job = this._jobs.get(k);
        if (job && ['queued', 'downloading', 'waiting'].includes(job.status)) {
            return { ok: false, error: 'that download is still running' };
        }
        this._jobs.delete(k);
        this._emit();
        return { ok: true };
    }

    _pump() {
        if (this._running) return;
        const next = [...this._jobs.values()].find(j => j.status === 'queued');
        if (!next) return;
        this._running = next.key;
        this._run(next.key)
            .catch(e => this._set(next.key, { status: 'failed', error: e.message }))
            .finally(() => { this._running = null; this._pump(); });
    }

    async _run(key) {
        const job = this._jobs.get(key);
        if (!job || job.status === 'cancelled') return;
        fs.mkdirSync(path.dirname(job.abs), { recursive: true });

        // ★ On a volume shared by several Pods, another one may be fetching the
        //   very same file. Two writers on one .part corrupt it, so the second
        //   Pod WAITS for the finished file rather than downloading it too.
        const lock = this._locks.acquire(job.abs);
        if (!lock.ok) {
            if (fs.existsSync(job.abs)) return this._doneElsewhere(key, job);
            this._set(key, { status: 'waiting', waitingFor: lock.owner, error: null });
            this._recheck(key);
            return;
        }
        try {
            // Taking the lock is the moment to look again: the other Pod may
            // have finished it just before releasing.
            if (fs.existsSync(job.abs)) return this._doneElsewhere(key, job);
            this._set(key, { waitingFor: null });
            await this._download(key, job);
        } finally {
            lock.release();
        }
    }

    _doneElsewhere(key, job) {
        let size = null;
        try { size = fs.statSync(job.abs).size; } catch { /* reported anyway */ }
        this._set(key, { status: 'done', received: size, total: size, waitingFor: null, installedBy: 'another Pod' });
    }

    // A waiting download looks again later, and in the meantime the queue moves
    // on to other files rather than sitting behind it.
    _recheck(key) {
        const t = setTimeout(() => {
            const job = this._jobs.get(key);
            if (!job || job.status !== 'waiting') return;
            if (fs.existsSync(job.abs)) { this._doneElsewhere(key, job); return; }
            this._set(key, { status: 'queued' });
            this._pump();
        }, this._waitPollMs);
        t.unref?.();
    }

    async _download(key, job) {
        const part = job.abs + PART_SUFFIX;

        // Resume whatever a previous attempt managed.
        let from = 0;
        try { from = fs.statSync(part).size; } catch { /* nothing yet */ }

        const headers = {};
        const token = this._config()?.comfy_ui?.hf_token;
        // ★ Match the HOST, not the URL string. A substring test sent the token to
        // anything whose URL merely contained "huggingface.co" — a mirror or a
        // caching proxy at hf-cache.example.net/huggingface.co/… would have been
        // handed someone's HF credential. Parsed, so only huggingface.co and its
        // subdomains get it.
        if (token && isHuggingFace(job.url)) headers.Authorization = `Bearer ${token}`;
        if (from > 0) headers.Range = `bytes=${from}-`;

        const ctl = new AbortController();
        this._aborts.set(key, ctl);
        this._set(key, { status: 'downloading', received: from, error: null });

        let res;
        try {
            res = await fetch(job.url, { headers, redirect: 'follow', signal: ctl.signal });
        } catch (e) {
            this._aborts.delete(key);
            if (ctl.signal.aborted) { this._set(key, { status: 'cancelled' }); return; }
            throw new Error(`could not reach the server: ${e.message}`);
        }

        if (res.status === 401 || res.status === 403) {
            this._aborts.delete(key);
            this._set(key, {
                status: 'failed',
                error: 'this repository is gated — accept its licence on HuggingFace and set an access token'
                    + ' under Manage ComfyUI, then try again',
            });
            return;
        }
        if (res.status === 416) {
            // The range is past the end: the .part is already the whole file.
            this._aborts.delete(key);
            fs.renameSync(part, job.abs);
            this._set(key, { status: 'done', received: from, total: from });
            return;
        }
        if (!res.ok) {
            this._aborts.delete(key);
            this._set(key, { status: 'failed', error: `the server answered ${res.status}` });
            return;
        }
        // A server that ignores Range restarts the file; do not append to it.
        const resuming = from > 0 && res.status === 206;
        if (from > 0 && !resuming) from = 0;

        const len = Number(res.headers.get('content-length') || 0);
        const total = len ? len + from : null;
        this._set(key, { total, received: from });

        // ★ Check the space BEFORE writing. Filling this volume takes out the
        // sqlite queue and the serving ComfyUI with it.
        if (total) {
            const free = freeBytes(path.dirname(job.abs));
            if (free != null && total - from + HEADROOM_BYTES > free) {
                this._aborts.delete(key);
                this._set(key, {
                    status: 'failed',
                    error: `not enough room: needs ${gb(total - from)} GB, ${gb(free)} GB free`
                        + ` (keeping ${gb(HEADROOM_BYTES)} GB spare)`,
                });
                return;
            }
        }

        const out = fs.createWriteStream(part, { flags: resuming ? 'a' : 'w' });
        let received = from, lastEmit = 0, lastData = Date.now(), stalled = false;
        const watchdog = setInterval(() => {
            if (Date.now() - lastData > this._stallMs) { stalled = true; ctl.abort(); }
        }, Math.min(5000, Math.max(50, this._stallMs / 4)));
        watchdog.unref?.();
        const body = Readable.fromWeb(res.body);
        body.on('data', (chunk) => {
            lastData = Date.now();
            received += chunk.length;
            // Four updates a second at most: the realtime bus coalesces, but
            // there is no sense generating work for it.
            const now = Date.now();
            if (now - lastEmit > 250) { lastEmit = now; this._set(key, { received }); }
        });

        try {
            await pipeline(body, out);
        } catch (e) {
            this._aborts.delete(key);
            if (stalled) {
                this._set(key, {
                    status: 'failed', received,
                    error: `the transfer stalled: no data for ${Math.round(this._stallMs / 1000)} s after ${gb(received)} GB — press retry to resume`,
                });
                return;
            }
            if (ctl.signal.aborted) {
                // The .part stays, so cancelling and resuming later is free.
                this._set(key, { status: 'cancelled', received });
                return;
            }
            throw new Error(`the transfer broke after ${gb(received)} GB: ${e.message}`);
        } finally {
            clearInterval(watchdog);
        }
        this._aborts.delete(key);

        // ★ Only now does it become a model. A .part renamed too early would
        // read as an installed file to everything else, including the prune
        // tool, which would then call it unused and offer to delete it.
        const onDisk = fs.statSync(part).size;
        if (total && onDisk !== total) {
            this._set(key, {
                status: 'failed', received: onDisk,
                error: `incomplete: got ${gb(onDisk)} GB of ${gb(total)} GB — press retry to resume`,
            });
            return;
        }
        fs.renameSync(part, job.abs);
        this._set(key, { status: 'done', received: onDisk, total: onDisk });
    }
}

const gb = (b) => (Number(b || 0) / 1024 ** 3).toFixed(2);

function freeBytes(dir) {
    try { return fs.statfsSync(dir).bavail * fs.statfsSync(dir).bsize; }
    catch { return null; }
}

module.exports = {
    isHuggingFace, ModelDownloader, freeBytes };
