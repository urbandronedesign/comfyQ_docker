const fs = require('fs');
const os = require('os');
const path = require('path');

// Several Pods on one network volume (Phase I, stages I3 + I4).
//
//   heartbeats — each Pod rewrites shared/pods/<id>.json every 30 s, so the
//                others know it is alive and what it serves (I4).
//   download lock — a model is downloaded by ONE Pod; any other that needs it
//                waits for the file instead of writing the same .part (I3).
//
// Off the volume (a Windows rig, `npm run dev`) there is no SHARED folder:
// heartbeats are off and nobody is ever "another Pod", but the download lock
// still works and costs nothing.
//
// Stage 0 (two real Pods on one RunPod volume, 2026-10-19) is what this rests
// on: an exclusive create had exactly one winner in 400 races, a file one Pod
// wrote was visible to the other within ~15 ms, and renames were atomic.

const HEARTBEAT_MS = 30_000;
const ALIVE_MS = 3 * 60_000;            // a heartbeat older than this: that Pod is gone
const LOCK_REFRESH_MS = 30_000;
const LOCK_STALE_MS = 10 * 60_000;      // owner decision 3 (2026-10-19)
const PART_QUIET_MS = 2 * 60_000;

function podId(env = process.env) {
    const raw = env.POD_ID || env.COMFYQ_POD_ID || env.RUNPOD_POD_ID || os.hostname() || 'local';
    return String(raw).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

// ---- heartbeats (I4) ------------------------------------------------------------

class Heartbeats {
    /**
     * @param {object} o
     * @param {string|null} o.sharedDir   $SHARED from the entrypoint; null = not on a shared volume
     * @param {string} o.id               this Pod
     * @param {() => object} o.info       what to publish (mode, workflows served, image)
     */
    constructor({ sharedDir, id = podId(), info = () => ({}), now = () => Date.now() }) {
        this.dir = sharedDir ? path.join(sharedDir, 'pods') : null;
        this.id = id;
        this._info = info;
        this._now = now;
        this._timer = null;
        this.startedAt = now();
    }

    get enabled() { return !!this.dir; }

    beat() {
        if (!this.dir) return;
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const file = path.join(this.dir, `${this.id}.json`);
            const tmp = `${file}.${process.pid}.tmp`;
            let info = {};
            try { info = this._info() || {}; } catch { /* publish what we can */ }
            fs.writeFileSync(tmp, JSON.stringify({ id: this.id, startedAt: this.startedAt, lastSeen: this._now(), ...info }));
            fs.renameSync(tmp, file);
        } catch (e) {
            console.warn('[shared-volume] heartbeat failed:', e.message);
        }
    }

    start() {
        if (!this.dir || this._timer) return this;
        this.beat();
        this._timer = setInterval(() => this.beat(), HEARTBEAT_MS);
        this._timer.unref?.();
        return this;
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;
        // Say goodbye, so the others do not wait three minutes to notice.
        if (this.dir) { try { fs.unlinkSync(path.join(this.dir, `${this.id}.json`)); } catch { /* gone */ } }
    }

    /** Every Pod with a fresh heartbeat, this one excluded. */
    others() {
        if (!this.dir) return [];
        let names = [];
        try { names = fs.readdirSync(this.dir); } catch { return []; }
        const out = [];
        for (const n of names) {
            if (!n.endsWith('.json')) continue;
            try {
                const hb = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8'));
                if (hb.id === this.id) continue;
                const age = this._now() - Number(hb.lastSeen || 0);
                if (age >= 0 && age < ALIVE_MS) out.push({ ...hb, ageSec: Math.round(age / 1000) });
            } catch { /* half-written or not ours */ }
        }
        return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    }

    isAlive(id) {
        if (id === this.id) return true;
        return this.others().some(o => o.id === id);
    }
}

// ---- download lock (I3) -----------------------------------------------------------

function _readLock(file) {
    try {
        const st = fs.statSync(file);
        let owner = null;
        try { owner = JSON.parse(fs.readFileSync(file, 'utf8')).pod || null; } catch { /* written in parts */ }
        return { owner, mtimeMs: st.mtimeMs };
    } catch { return null; }
}

class DownloadLocks {
    /**
     * @param {object} o
     * @param {string} o.id                     this Pod
     * @param {(id:string) => boolean} o.isAlive  from Heartbeats
     */
    constructor({ id = podId(), isAlive = () => false, now = () => Date.now(), log = (m) => console.log(m) } = {}) {
        this.id = id;
        this._isAlive = isAlive;
        this._now = now;
        this._log = log;
    }

    /**
     * Take the lock for one model file. Returns { ok: true, release } or
     * { ok: false, owner } when another Pod is downloading it.
     */
    acquire(abs) {
        const file = `${abs}.lock`;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const fd = fs.openSync(file, 'wx');
                fs.writeSync(fd, JSON.stringify({ pod: this.id, at: new Date(this._now()).toISOString() }));
                fs.closeSync(fd);
                return { ok: true, release: this._holder(file) };
            } catch (e) {
                if (e.code !== 'EEXIST') throw e;
            }
            const held = _readLock(file);
            if (!held) continue;                       // released between our two calls
            if (this._takeOver(file, abs, held)) continue;
            return { ok: false, owner: held.owner || 'another Pod' };
        }
        const held = _readLock(file);
        return { ok: false, owner: held?.owner || 'another Pod' };
    }

    /**
     * May this lock be taken from its holder?
     *
     * ★ The two mistakes are not equal. Wrongly deciding a Pod is dead lets two
     *   Pods write one file and can corrupt a model; wrongly deciding it is
     *   alive only makes this Pod wait. So a lock is taken only on our OWN id
     *   (left by this Pod's previous container), or when ALL THREE signs agree:
     *   not refreshed for 10 minutes, the owner's heartbeat gone, and the .part
     *   not grown for 2 minutes.
     */
    _takeOver(file, abs, held) {
        let why = null;
        if (held.owner === this.id) why = "this Pod's own lock from before a restart";
        else {
            const lockAge = this._now() - held.mtimeMs;
            if (lockAge < LOCK_STALE_MS) return false;
            if (held.owner && this._isAlive(held.owner)) return false;
            let partAge = Infinity;
            try { partAge = this._now() - fs.statSync(`${abs}.part`).mtimeMs; } catch { /* no .part yet */ }
            if (partAge < PART_QUIET_MS) return false;
            why = `abandoned by ${held.owner || 'an unknown Pod'} (${Math.round(lockAge / 60000)} min without a refresh)`;
        }
        // Move it aside rather than delete it: a rename succeeds for exactly one
        // Pod, and what was moved can be checked. If it is not the lock judged
        // above (its owner replaced it meanwhile), it is put back untouched.
        const aside = `${file}.taken-${this.id}-${process.pid}`;
        try { fs.renameSync(file, aside); } catch { return false; }
        const moved = _readLock(aside);
        if (!moved || moved.owner !== held.owner || moved.mtimeMs !== held.mtimeMs) {
            try { fs.linkSync(aside, file); } catch { /* someone holds a new lock now; ours is void */ }
            try { fs.unlinkSync(aside); } catch { /* fine */ }
            return false;
        }
        try { fs.unlinkSync(aside); } catch { /* fine */ }
        this._log(`[shared-volume] took over the download lock on ${path.basename(abs)}: ${why}`);
        return true;
    }

    // Refresh the lock while held; release it only if it is still ours.
    _holder(file) {
        const timer = setInterval(() => {
            const t = new Date(this._now());
            try { fs.utimesSync(file, t, t); } catch { /* checked at release */ }
        }, LOCK_REFRESH_MS);
        timer.unref?.();
        let done = false;
        return () => {
            if (done) return;
            done = true;
            clearInterval(timer);
            const held = _readLock(file);
            if (held && held.owner === this.id) { try { fs.unlinkSync(file); } catch { /* gone */ } }
        };
    }
}

module.exports = {
    podId, Heartbeats, DownloadLocks,
    HEARTBEAT_MS, ALIVE_MS, LOCK_REFRESH_MS, LOCK_STALE_MS, PART_QUIET_MS,
};
