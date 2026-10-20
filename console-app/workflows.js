// What the console needs to know about the workflows — each one's meta.json
// and runtime.json, and the download sizes (workflow-downloads.json) — kept in
// ~/.comfyq/app-cache and refreshed from the repo on GitHub, so an installed app
// lists what the `latest` image (built from main) serves, not what it shipped with.
//
// First start: the copy shipped inside the app goes into the cache, so the
// console works at once and offline. Then the GitHub tree is read once and only
// files whose sha changed are downloaded. A failed refresh keeps the last copy.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = 'urbandronedesign/comfyQ_docker';
const BRANCH = 'main';
const DOWNLOADS = 'tools/model-provenance/workflow-downloads.json';

function cacheDir() {
    return path.join(process.env.COMFYQ_APP_SERVER_HOME || os.homedir(), '.comfyq', 'app-cache');
}

// The files the console reads, out of every path in the repo.
function wanted(p) {
    if (p === DOWNLOADS) return true;
    const m = p.match(/^workflows\/([^/]+)\/([^/]+)$/);
    return !!m && !m[1].startsWith('_') && (m[2] === `${m[1]}.meta.json` || m[2] === `${m[1]}.runtime.json`);
}
const localPath = (root, p) => path.join(root, p === DOWNLOADS ? 'workflow-downloads.json' : p);

// Only the files the console reads, out of a workflows folder.
function copyWorkflows(from, to) {
    for (const e of fs.existsSync(from) ? fs.readdirSync(from, { withFileTypes: true }) : []) {
        if (!e.isDirectory() || e.name.startsWith('_')) continue;
        for (const f of [`${e.name}.meta.json`, `${e.name}.runtime.json`]) {
            const a = path.join(from, e.name, f);
            if (!fs.existsSync(a)) continue;
            fs.mkdirSync(path.join(to, e.name), { recursive: true });
            fs.copyFileSync(a, path.join(to, e.name, f));
        }
    }
}

/**
 * Make sure the cache exists (from the shipped copy), and say where the server
 * should read from.
 * @param {{ workflows: string, downloads: string }} shipped  the copy inside the app
 */
function prepare(shipped) {
    const root = cacheDir();
    if (!fs.existsSync(path.join(root, 'index.json'))) {
        copyWorkflows(shipped.workflows, path.join(root, 'workflows'));
        if (fs.existsSync(shipped.downloads)) fs.copyFileSync(shipped.downloads, path.join(root, 'workflow-downloads.json'));
        fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ source: 'shipped', at: Date.now(), sha: {} }));
    }
    return { workflowsDir: path.join(root, 'workflows'), downloadsFile: path.join(root, 'workflow-downloads.json') };
}

/** Bring the cache up to date with GitHub. Resolves to what changed; never throws. */
async function refresh({ fetchImpl = fetch, timeoutMs = 20000 } = {}) {
    const root = cacheDir();
    let index;
    try { index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8')); } catch { index = { sha: {} }; }
    try {
        const tree = await (await fetchImpl(`https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`, {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'comfyq-console-app' }, signal: AbortSignal.timeout(timeoutMs),
        })).json();
        if (!Array.isArray(tree.tree)) throw new Error(tree.message || 'no tree in the answer');
        const files = tree.tree.filter(t => t.type === 'blob' && wanted(t.path));
        if (!files.some(f => f.path === DOWNLOADS) || files.length < 10) throw new Error(`the repo tree looks wrong (${files.length} files)`);
        let changed = 0;
        for (const f of files) {
            if (index.sha?.[f.path] === f.sha && fs.existsSync(localPath(root, f.path))) continue;
            const r = await fetchImpl(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/${f.path}`, { signal: AbortSignal.timeout(timeoutMs) });
            if (!r.ok) throw new Error(`${f.path}: HTTP ${r.status}`);
            const body = Buffer.from(await r.arrayBuffer());
            JSON.parse(body.toString('utf8'));   // a broken file must not replace a good one
            const dest = localPath(root, f.path);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest + '.tmp', body);
            fs.renameSync(dest + '.tmp', dest);
            index.sha = { ...index.sha, [f.path]: f.sha };
            changed++;
        }
        // A workflow removed from the repo goes from the list too.
        const keep = new Set(files.filter(f => f.path.startsWith('workflows/')).map(f => f.path.split('/')[1]));
        let removed = 0;
        const wfDir = path.join(root, 'workflows');
        for (const e of fs.existsSync(wfDir) ? fs.readdirSync(wfDir, { withFileTypes: true }) : []) {
            if (e.isDirectory() && !keep.has(e.name)) { fs.rmSync(path.join(wfDir, e.name), { recursive: true, force: true }); removed++; }
        }
        for (const p of Object.keys(index.sha || {})) if (!files.some(f => f.path === p)) delete index.sha[p];
        fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ source: 'github', at: Date.now(), commit: tree.sha, sha: index.sha }));
        return { ok: true, changed, removed, workflows: keep.size };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

module.exports = { prepare, refresh, cacheDir, wanted };
