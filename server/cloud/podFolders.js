// Phase I6: the folders Pods leave on a shared network volume.
//
// Each Pod keeps its state in <volume>/pods/<pod id>/ (queue, settings,
// results, uploads). Terminating a Pod does not touch the volume, so that
// folder stays and keeps costing storage. A Pod on the volume can list them
// all, zip one's results for download, and delete one when the admin asks.
//
// ★ This Pod cannot know which Pods still exist in the RunPod account — a
//   STOPPED Pod has no heartbeat and its folder is its whole state. That check
//   belongs to the console, which holds the RunPod key. Here the guards are
//   what this Pod can see: never its own folder, never a folder whose Pod has
//   a fresh heartbeat. Nothing is ever deleted without being asked.

const fs = require('fs');
const path = require('path');

const ID_RX = /^[A-Za-z0-9_-]{1,64}$/;
// A folder being deleted is first renamed to this, so it leaves the list at
// once and a half-deleted folder can never be mistaken for a Pod's state.
// One left behind (the Pod stopped mid-delete) is listed so it can be finished.
const DELETING_RX = /^\.deleting-[A-Za-z0-9_-]{1,64}-\d+$/;

/** <volume>/pods, from the MINE the entrypoint exports; null off the shared layout. */
function podsRoot(env = process.env) {
    return env.MINE ? path.dirname(env.MINE) : null;
}

/** Size, file count, results count and newest change of one folder. Links are counted, never followed. */
async function folderStats(dir) {
    const out = { bytes: 0, files: 0, outputs: 0, lastModified: 0 };
    const outputDir = path.join(dir, 'comfyui', 'output') + path.sep;
    async function walk(d) {
        let entries;
        try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = path.join(d, e.name);
            let st;
            try { st = await fs.promises.lstat(p); } catch { continue; }
            out.lastModified = Math.max(out.lastModified, st.mtimeMs);
            if (st.isSymbolicLink()) continue;
            if (st.isDirectory()) { await walk(p); continue; }
            out.bytes += st.size;
            out.files++;
            if (p.startsWith(outputDir)) out.outputs++;
        }
    }
    await walk(dir);
    return out;
}

/** The folder for `id`, or an error message: a plain child directory of root, never a link. */
function resolveFolder(root, id) {
    if (!root) return { error: 'this Pod is not on a shared volume' };
    if (!ID_RX.test(String(id)) && !DELETING_RX.test(String(id))) return { error: 'not a Pod folder name' };
    const abs = path.join(root, id);
    let st;
    try { st = fs.lstatSync(abs); } catch { return { error: `no folder ${id} on this volume` }; }
    if (st.isSymbolicLink() || !st.isDirectory()) return { error: `${id} is not a plain folder` };
    return { abs };
}

async function listFolders({ root, me, isAlive = () => false }) {
    if (!root) return [];
    let entries = [];
    try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const e of entries) {
        const unfinished = DELETING_RX.test(e.name);
        if (!e.isDirectory() || (!ID_RX.test(e.name) && !unfinished)) continue;
        const stats = await folderStats(path.join(root, e.name));
        out.push({
            id: e.name,
            ...stats,
            isMe: e.name === me,
            alive: !unfinished && e.name !== me && !!isAlive(e.name),
            unfinishedDelete: unfinished,
        });
    }
    return out.sort((a, b) => b.lastModified - a.lastModified);
}

/** Why `id` may not be deleted by this Pod, or null. */
function refuseDelete({ id, me, isAlive = () => false }) {
    if (id === me) return 'that is this Pod\'s own folder';
    if (isAlive(id)) return 'that Pod is running on this volume (its heartbeat is fresh)';
    return null;
}

async function deleteFolder({ root, id, me, isAlive, now = Date.now }) {
    const r = resolveFolder(root, id);
    if (r.error) return { ok: false, error: r.error };
    const why = refuseDelete({ id, me, isAlive });
    if (why) return { ok: false, error: why };
    let target = r.abs;
    if (!DELETING_RX.test(id)) {
        target = path.join(root, `.deleting-${id}-${now()}`);
        fs.renameSync(r.abs, target);
    }
    const { bytes, files } = await folderStats(target);
    // rm with recursive removes a link inside the folder, never what it points to.
    await fs.promises.rm(target, { recursive: true, force: true });
    return { ok: true, id, bytes, files };
}

// What "the results" of a folder are: what students made and uploaded.
const RESULT_PARTS = [
    ['comfyui/output', 'output'],
    ['comfyui/comfyq_ingredients', 'ingredients'],
    ['comfyui/input', 'uploads'],
];

/** Stream a zip of one folder's results; `archiver` is passed in to keep this module testable. */
function zipResults({ root, id, res, archiver }) {
    const r = resolveFolder(root, id);
    if (r.error) return res.status(404).json({ error: r.error });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="comfyq-pod-${id}-results.zip"`);
    const archive = archiver('zip', { zlib: { level: 1 } });   // outputs are already compressed media
    archive.on('error', (e) => { console.warn('[pod-folders] zip failed:', e.message); res.destroy(e); });
    archive.pipe(res);
    for (const [rel, name] of RESULT_PARTS) {
        const p = path.join(r.abs, rel);
        try { if (fs.lstatSync(p).isDirectory()) archive.directory(p, name); } catch { /* absent */ }
    }
    archive.append(`Results of Pod ${id}, from its folder on the shared volume.\n`
        + 'output/ — what the jobs produced; ingredients/ — the settings and inputs of each job; uploads/ — files students uploaded.\n',
    { name: 'README.txt' });
    archive.finalize();
}

module.exports = { podsRoot, folderStats, resolveFolder, listFolders, refuseDelete, deleteFolder, zipResults, ID_RX };
