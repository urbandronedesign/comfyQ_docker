const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const multer = require('multer');
const { setAdminPassword, checkAdminPassword, setAccessPassword } = require('../auth/authGate');
const { defaultConfig } = require('../config/configManager');
const { WorkflowMeta } = require('../config/schemas');
const { validateApiWorkflow } = require('../workflows/workflowValidator');
const { parseWorkflow } = require('../workflows/workflowParser');
const { listModelFiles, prettyModelLabel } = require('../workflows/modelOptions');
const { buildModelUsage } = require('../workflows/modelUsage');
const { listInstalledPacks, missingNodePacks, readRequirements } = require('../workflows/nodePacks');
const { renderSweepReport } = require('../benchmark/sweepReport');
const { revealPath } = require('../maintenance/revealPath');
const { podsRoot, listFolders, deleteFolder, zipResults } = require('../cloud/podFolders');
const {
    scoreDeletable, auditRedownload, invalidateReferenceNames,
} = require('../workflows/modelConfidence');
const { invalidatePackCode } = require('../workflows/modelUsage');
const { invalidateModelIndex } = require('../workflows/vramEstimate');
const { KNOWN_DIRS: KNOWN_MODEL_DIRS } = require('../models/modelDestination');
const {
    quarantineRoot, quarantineFile, listQuarantine, restoreFile, emptyBatch,
} = require('../models/modelQuarantine');
const { resolveOutputPath } = require('../executor/outputCollector');
const sm = require('../queue/jobStateMachine');
const { ComfyRestClient } = require('../workers/comfyRestClient');
const { getComboOptions } = require('../workers/nodeSchema');

function sanitizeId(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
}

// Build http://<lan-ip>:<port> URLs for every non-internal IPv4 — shown to the
// admin so they can hand the network-bound ComfyUI URL to people on the LAN.
function lanUrls(port) {
    const urls = [];
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
        for (const i of ifs[name] || []) {
            if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${port}`);
        }
    }
    return urls;
}

// Opens the persistent JobQueue on demand for admin-mode operations (where
// the student-mode runtime.queue isn't wired up). Caller is responsible for
// calling _closeAdHoc() when done.
function _openQueueAdHoc(resolvedConfig) {
    try {
        const { JobQueue } = require('../queue/jobQueue');
        const q = new JobQueue(resolvedConfig.queue.dbPath);
        q._closeAdHoc = () => { try { q.db && q.db.close(); } catch { /* ignore */ } };
        return q;
    } catch (e) {
        console.error('[Admin] could not open queue ad-hoc:', e.message);
        return null;
    }
}

function makeRouter({ configManager, registry, adminGate, exitForRestart, runtime }) {
    const router = express.Router();
    const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

    router.get('/mode', (req, res) => {
        const { config } = configManager.load();
        res.json({ mode: config.mode });
    });

    router.get('/config', (req, res) => {
        const { config } = configManager.load();
        // Never leak the password hash.
        const safe = JSON.parse(JSON.stringify(config));
        if (safe.auth) { delete safe.auth.adminPasswordHash; delete safe.auth.accessPasswordHash; }
        // A secret, like the hashes above: the UI only ever needs to know
        // whether one is set.
        const hasHfToken = !!safe.comfy_ui?.hf_token;
        if (safe.comfy_ui) delete safe.comfy_ui.hf_token;
        const hasAdminPassword = !!config.auth.adminPasswordHash;
        const hasAccessPassword = !!config.auth.accessPasswordHash;
        res.json({ config: safe, hasHfToken, hasAdminPassword, hasAccessPassword });
    });

    // First-run / admin: set ComfyUI paths and server settings.
    router.put('/comfy', adminGate, express.json(), (req, res) => {
        try {
            const { root_path, python_executable, output_dir, api_host, api_port, lan_access, autoStart, vramBudgetGb, installation_type, assets_dir, use_sage_attention, fp16_accumulation } = req.body || {};
            configManager.update(c => {
                if (root_path !== undefined) c.comfy_ui.root_path = root_path;
                if (python_executable !== undefined) c.comfy_ui.python_executable = python_executable;
                if (output_dir !== undefined) c.comfy_ui.output_dir = output_dir;
                if (api_host !== undefined) c.comfy_ui.api_host = api_host;
                if (api_port !== undefined) c.comfy_ui.api_port = api_port;
                if (lan_access !== undefined) c.comfy_ui.lan_access = lan_access;
                if (autoStart !== undefined) c.comfy_ui.autoStart = autoStart;
                if (vramBudgetGb !== undefined) c.comfy_ui.vramBudgetGb = vramBudgetGb;
                if (installation_type !== undefined) c.comfy_ui.installation_type = installation_type;
                // Performance flags — take effect on the next ComfyUI (re)start;
                // they're part of the spawn signature, so Restart picks them up.
                if (use_sage_attention !== undefined) c.comfy_ui.use_sage_attention = !!use_sage_attention;
                if (fp16_accumulation !== undefined) c.comfy_ui.fp16_accumulation = !!fp16_accumulation;
                // Calibration media directory lives under config.assets (not comfy_ui).
                // Editable here so admins can repoint it when the drive letter changes.
                if (assets_dir !== undefined) { c.assets = c.assets || {}; c.assets.dir = assets_dir; }
                return c;
            });
            res.json({ ok: true });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // Federation: toggle this machine's presence on the LAN status beacon.
    // Takes effect live (the beacon re-reads enabled state each tick; kick()
    // sends one immediately so enabling shows up right away in the monitor).
    router.put('/federation', adminGate, express.json(), (req, res) => {
        try {
            const { enabled } = req.body || {};
            if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
            configManager.update(c => {
                c.federation = c.federation || {};
                c.federation.enabled = enabled;
                return c;
            });
            try { if (enabled) runtime?.beacon?.kick(); } catch { /* ignore */ }
            res.json({ ok: true, enabled });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // This machine's name in the fleet monitor. An empty/blank name resets to
    // "follow the computer name" (the default), which is what keeps a renamed or
    // re-imaged rig from advertising a stale label; any other value pins a custom
    // label (nameCustom) so it survives future boots.
    //
    // Takes effect live: buildSnapshot() reads config.instance directly, so the
    // next beacon tick — kicked immediately below — already carries the new name.
    router.put('/instance', adminGate, express.json(), (req, res) => {
        try {
            const raw = req.body?.name;
            if (raw !== undefined && typeof raw !== 'string') {
                return res.status(400).json({ error: 'name must be a string' });
            }
            const name = String(raw || '').trim().slice(0, 64);
            const hostname = os.hostname();
            configManager.update(c => {
                c.instance = c.instance || {};
                c.instance.hostname = hostname;
                c.instance.nameCustom = !!name;
                c.instance.name = name || hostname;
                return c;
            });
            try { runtime?.beacon?.kick(); } catch { /* beacon may be disabled */ }
            const inst = configManager.load().config.instance || {};
            res.json({ ok: true, name: inst.name, hostname, nameCustom: !!inst.nameCustom });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // Return the hardcoded workshop-rig path defaults so the admin UI can
    // offer a "Reset to defaults" action without duplicating the constants.
    router.get('/default-paths', (req, res) => {
        const d = defaultConfig().comfy_ui;
        res.json({
            root_path: d.root_path,
            python_executable: d.python_executable,
            output_dir: d.output_dir,
            api_host: d.api_host,
            api_port: d.api_port,
            installation_type: d.installation_type,
            vramBudgetGb: d.vramBudgetGb
        });
    });

    // List mounted drive letters (Windows) so the admin UI can offer a one-click
    // "swap the drive letter on every path" — the common case when a workshop
    // machine cloned the drive to a different letter. Read-only.
    router.get('/drives', (req, res) => {
        const drives = [];
        if (process.platform === 'win32') {
            for (let c = 67; c <= 90; c++) {                 // C..Z
                const letter = String.fromCharCode(c);
                try { if (fs.existsSync(`${letter}:\\`)) drives.push(letter); } catch { /* skip */ }
            }
        }
        res.json({ drives });
    });

    // Every cached view the prune decision rests on, dropped together.
    function invalidateUsageCaches() {
        invalidateModelIndex();
        invalidatePackCode();
        invalidateReferenceNames();
    }

    // ★ Append-only JSON Lines, one record per file, written BEFORE the next
    // file is touched. The previous version rewrote a single JSON array once
    // after the whole loop, so an interruption lost the record of everything
    // already moved — and a truncated file read as "no log yet", which the next
    // prune then overwrote. With JSONL a damaged tail costs one line.
    function appendPruneLog(entry) {
        try {
            const dataDir = path.resolve(__dirname, '..', 'data');
            fs.mkdirSync(dataDir, { recursive: true });
            fs.appendFileSync(path.join(dataDir, 'pruned-models.jsonl'),
                JSON.stringify(entry) + String.fromCharCode(10));
        } catch (e) {
            console.warn('[Prune] could not write the prune log: ' + e.message);
        }
    }

    // ---- Maintenance: which models on disk are actually used -------------
    // Shares its engine with tools/model-provenance/exclusive.cjs on purpose:
    // if the panel and the command line disagreed about what is unused, one of
    // them would be inviting someone to delete a model that is needed.
    function usageReport() {
        const { config } = configManager.load();
        const comfyRoot = config.comfy_ui?.root_path || '';
        const configured = [...(config.maintenance?.workflowScanDirs || [])];
        const extra = [...configured];
        if (comfyRoot) extra.push(path.join(comfyRoot, 'user', 'default', 'workflows'));
        const report = buildModelUsage({
            comfyRoot,
            workflowsDir: registry.dir || path.resolve(__dirname, '../../workflows'),
            extraDirs: extra,
        });
        // Say what the verdict rests on: a folder of workflows nobody told us
        // about makes its models look unused.
        //
        // ★ The resolution and the existence check both live in
        // buildModelUsage, which is the only place both this route and the CLI
        // share. Checking here with fs.existsSync on the raw entry was wrong
        // for a relative one: it resolved against the server's cwd, so a
        // relative folder scanned nothing while reporting itself present.
        report.scanned.missingDirs = report.scanned.configured
            .filter(c => configured.includes(c.entry) && !c.found)
            .map(c => (c.entry === c.resolved ? c.entry : `${c.entry} (looked in ${c.resolved})`));
        report.comfyRoot = comfyRoot;
        report.scanDirs = configured;
        // How sure we are about each "unused" verdict, with the reasons behind
        // it. Scored after the scan because it needs the whole picture: what
        // else is on disk, what a loader wants and cannot find, and which
        // folders the scan was unable to read.
        scoreDeletable(report, {
            comfyRoot,
            repoRoot: path.resolve(__dirname, '../..'),
        });
        return report;
    }

    // The extra workflow folders to count as USING a model.
    //
    // ★ adminGate, unlike the sibling config PUTs, because emptying this list
    // is precisely how a model that is in use becomes "unused": the prune route
    // re-derives usage from this same config, so an ungated write would let a
    // caller widen what the destructive route is willing to delete.
    router.put('/maintenance/scan-dirs', adminGate, express.json(), (req, res) => {
        try {
            const raw = req.body?.workflowScanDirs;
            if (!Array.isArray(raw) || raw.some(d => typeof d !== 'string')) {
                return res.status(400).json({ error: 'workflowScanDirs must be an array of strings' });
            }
            const dirs = raw.map(d => d.trim()).filter(Boolean);
            configManager.update(c => {
                c.maintenance = c.maintenance || {};
                c.maintenance.workflowScanDirs = dirs;
                return c;
            });
            res.json({ ok: true, workflowScanDirs: dirs });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // ---- Maintenance: fetch a model onto THIS machine --------------------
    // Server-side on purpose: the admin panel is routinely open on another
    // computer (there is a Copy-admin-link button for it), so a browser
    // download would land on the wrong machine — and showDirectoryPicker, the
    // only web API that could choose a folder, needs a secure context, which
    // plain HTTP on the LAN is not.
    router.get('/models/downloads', (req, res) => {
        res.json({ downloads: runtime?.downloader ? runtime.downloader.list() : [], available: !!runtime?.downloader });
    });

    // What a Pod started with COMFYQ_SERVE is doing: refused, fetching (with a
    // row per model file), failed with the reason, or done. Ungated like the
    // downloads list above — it carries file names and progress, no secret —
    // because the launcher polls it before anyone has typed a password.
    router.get('/pod-plan', (req, res) => {
        const { readPlan } = require('../cloud/podPlan');
        const plan = readPlan();
        if (!plan) return res.json({ plan: null });
        const files = (plan.files || []).map(({ key, ...f }) => f);
        res.json({ plan: { ...plan, files } });
    });

    router.post('/models/download', adminGate, express.json(), (req, res) => {
        const dl = runtime?.downloader;
        if (!dl) return res.status(503).json({ error: 'the downloader is not available' });
        const { name, url, type, dir } = req.body || {};
        if (!url) return res.status(400).json({ error: 'a url is required' });
        const out = dl.enqueue({ name, url, type, dir });
        if (!out.ok) return res.status(out.needsDir ? 409 : 400).json(out);
        res.json(out);
    });

    router.post('/models/download/cancel', adminGate, express.json(), (req, res) => {
        const dl = runtime?.downloader;
        if (!dl) return res.status(503).json({ error: 'the downloader is not available' });
        const out = dl.cancel(req.body?.key);
        res.status(out.ok ? 200 : 400).json(out);
    });

    router.post('/models/download/forget', adminGate, express.json(), (req, res) => {
        const dl = runtime?.downloader;
        if (!dl) return res.status(503).json({ error: 'the downloader is not available' });
        const out = dl.forget(req.body?.key);
        res.status(out.ok ? 200 : 400).json(out);
    });

    // The folders a download may be placed in, for the one case the link and
    // the declared type cannot decide between them.
    router.get('/models/folders', (req, res) => {
        const { config } = configManager.load();
        const root = config.comfy_ui?.root_path || '';
        let present = [];
        try {
            present = fs.readdirSync(path.join(root, 'models'), { withFileTypes: true })
                .filter(e => e.isDirectory() && KNOWN_MODEL_DIRS.has(e.name.toLowerCase()))
                .map(e => e.name)
                .sort();
        } catch { /* no install configured */ }
        res.json({ folders: present });
    });

    // ---- Node packs -------------------------------------------------------
    // A missing pack is the quietest way a bundle can be unrunnable: the
    // class_type simply does not exist, so ComfyUI rejects the whole prompt
    // and nothing says which pack was wanted. On THIS rig nothing is missing
    // (0 across 61 bundles) -- the case this serves is a fresh machine, or a
    // rig imaged before a pack was added.
    async function packsReport() {
        const { config } = configManager.load();
        const comfyRoot = config.comfy_ui?.root_path || '';
        // Live /object_info is the authority on what classes exist; the audit's
        // cached copy answers when ComfyUI is down, and the report says which
        // one it used so a stale answer is visible rather than assumed.
        let objectInfo = null;
        try {
            const host = config.comfy_ui?.api_host || '127.0.0.1';
            const port = config.comfy_ui?.api_port || 8188;
            const r = await fetch(`http://${host}:${port}/object_info`, { signal: AbortSignal.timeout(8000) });
            if (r.ok) objectInfo = await r.json();
        } catch { /* down, or busy loading a model; the cache covers it */ }

        const bundles = registry.list({ includeUnavailable: false, includeHidden: true })
            .filter(e => e.apiWorkflow)
            .map(e => ({ id: e.id, graph: e.apiWorkflow }));
        const missing = missingNodePacks(bundles, comfyRoot, { objectInfo });
        return {
            installed: listInstalledPacks(comfyRoot).map(p => ({
                ...p,
                requirements: p.hasRequirements
                    ? readRequirements(path.join(comfyRoot, 'custom_nodes', p.name)).risky
                    : [],
            })),
            bundlesChecked: bundles.length,
            ...missing,
        };
    }

    router.get('/nodepacks', async (req, res) => {
        try {
            res.json({ available: true, ...(await packsReport()), jobs: runtime?.packs?.list() || [] });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/nodepacks/plan', (req, res) => {
        const p = runtime?.packs;
        if (!p) return res.status(503).json({ error: 'the installer is not available' });
        res.json(p.plan(req.query.url));
    });

    // ★ git clone into custom_nodes -- ComfyUI's own code is never touched,
    // and this is the pack authors' published instruction. pip is a separate
    // call on purpose: one python_embeded is shared by every lane and every
    // rig imaged from this drive.
    router.post('/nodepacks/install', adminGate, express.json(), async (req, res) => {
        const p = runtime?.packs;
        if (!p) return res.status(503).json({ error: 'the installer is not available' });
        const out = await p.install(req.body?.url);
        res.status(out.ok ? 200 : 400).json(out);
    });

    router.post('/nodepacks/pip', adminGate, express.json(), async (req, res) => {
        const p = runtime?.packs;
        if (!p) return res.status(503).json({ error: 'the installer is not available' });
        const out = await p.pipInstall(req.body?.folder, req.body?.acceptRisky === true);
        res.status(out.ok ? 200 : 400).json(out);
    });

    router.post('/nodepacks/forget', adminGate, express.json(), (req, res) => {
        const p = runtime?.packs;
        if (!p) return res.status(503).json({ error: 'the installer is not available' });
        const out = p.forget(req.body?.folder);
        res.status(out.ok ? 200 : 400).json(out);
    });

    // ---- Updating ComfyUI, and each node pack -----------------------------
    // ★★ Written because an update that changed nothing read exactly like one
    // that worked. The owner ran the portable's stable updater on 2026-10-08,
    // it behaved correctly, and the rig stayed on v0.39.1 -- because that IS
    // the newest release and master had moved on untagged. A day was then
    // planned on the belief that a known failure would be fixed. So every
    // answer here carries the version before and after, and says so when
    // nothing moved.
    router.get('/updates', async (req, res) => {
        const u = runtime?.updater;
        if (!u) return res.json({ available: false });
        // ★ No network AND no git on this path. It is called on every page load,
        // and these rigs are routinely on a LAN that cannot reach github -- but
        // the packs ARE listed, from the filesystem, so the card can show what
        // is installed and which of it is updatable before anyone presses Check.
        // Returning nothing here made the feature invisible by default; doing it
        // with git reads instead made the request take 3.1 s, during which the
        // card still rendered as nothing. Both were the same complaint.
        let packs = null;
        try { packs = u.installedPacks(); } catch { /* listing is best effort */ }
        res.json({
            available: true,
            comfy: u.comfyState(),
            comfyRequirements: u.comfyRequirements(),
            packs,
            scan: u.scan(),
            run: u.status(),
        });
    });

    // Reaches the remotes. adminGate'd and never automatic -- "nothing to
    // update" must not be something the panel concluded from a failed fetch.
    router.post('/updates/check', adminGate, express.json(), (req, res) => {
        const u = runtime?.updater;
        if (!u) return res.status(503).json({ error: 'the updater is not available' });
        const out = u.checkAll();
        res.status(out.ok ? 200 : 409).json(out);
    });

    router.post('/updates/comfyui', adminGate, express.json(), async (req, res) => {
        const u = runtime?.updater;
        if (!u) return res.status(503).json({ error: 'the updater is not available' });
        const out = await u.updateComfy({ acceptStash: req.body?.acceptStash === true });
        res.status(out.ok ? 200 : 400).json(out);
    });

    // ⚠ Its own route and its own acknowledgement, because this is the step
    // that can take the rig out: the portable's pinned list asks for bare
    // torch, and this install is held at 2.8.0+cu128 for Pixal3D and TRELLIS2.
    router.post('/updates/comfyui-deps', adminGate, express.json(), async (req, res) => {
        const u = runtime?.updater;
        if (!u) return res.status(503).json({ error: 'the updater is not available' });
        const out = await u.updateComfyDeps({ acceptRisky: req.body?.acceptRisky === true });
        res.status(out.ok ? 200 : 400).json(out);
    });

    router.post('/updates/pack', adminGate, express.json(), async (req, res) => {
        const u = runtime?.updater;
        if (!u) return res.status(503).json({ error: 'the updater is not available' });
        const out = await u.updatePack(String(req.body?.folder || ''));
        res.status(out.ok ? 200 : 400).json(out);
    });

    router.post('/updates/stop', adminGate, express.json(), (req, res) => {
        const u = runtime?.updater;
        if (!u) return res.status(503).json({ error: 'the updater is not available' });
        const out = u.stop();
        res.status(out.ok ? 200 : 400).json(out);
    });

    router.post('/updates/forget', adminGate, express.json(), (req, res) => {
        const u = runtime?.updater;
        if (!u) return res.status(503).json({ error: 'the updater is not available' });
        const out = u.forget();
        res.status(out.ok ? 200 : 400).json(out);
    });

    // ---- Run the whole library once, and write down what happened ---------
    // The one button that answers "does every workflow still work, and which
    // models does the library actually open". ~2 h for 61 bundles here.
    router.get('/library-sweep', (req, res) => {
        const sw = runtime?.sweep;
        if (!sw) return res.json({ available: false });
        // The full id list too, so the card can offer to run only what a cut-short
        // sweep never reached — which is the normal case at two hours per run.
        const bundles = registry.list({ includeUnavailable: false, includeHidden: true })
            .filter(e => e.apiWorkflow).map(e => e.id);
        res.json({
            available: true, bundles, bundleCount: bundles.length,
            run: sw.status(), last: sw.lastReport(),
        });
    });

    router.post('/library-sweep/run', adminGate, express.json(), async (req, res) => {
        const sw = runtime?.sweep;
        if (!sw) return res.status(503).json({ error: 'the sweep is not available' });
        const out = await sw.start({ ids: Array.isArray(req.body?.ids) ? req.body.ids : undefined });
        res.status(out.ok ? 200 : 409).json(out);
    });

    // Forget every sweep result, in memory and on disk. Wanted because a partial or
    // recovered report reads like a verdict on the library while covering half of it.
    router.post('/library-sweep/clear', adminGate, express.json(), (req, res) => {
        const sw = runtime?.sweep;
        if (!sw) return res.status(503).json({ error: 'the sweep is not available' });
        const out = sw.clear();
        res.status(out.ok ? 200 : 409).json(out);
    });

    // ★ Open a file in the file browser ON THIS MACHINE. A browser cannot follow a
    // file:// link from an http page, so the host has to do it — and the path is
    // refused unless it sits inside a folder ComfyQ already works with.
    router.post('/reveal', adminGate, express.json(), (req, res) => {
        const { config } = configManager.load();
        const out = revealPath(req.body?.path, config);
        res.status(out.ok ? 200 : 400).json(out);
    });

    router.post('/library-sweep/stop', adminGate, express.json(), (req, res) => {
        const sw = runtime?.sweep;
        if (!sw) return res.status(503).json({ error: 'the sweep is not available' });
        const out = sw.stop();
        res.status(out.ok ? 200 : 400).json(out);
    });

    // The sweep as plain text, for pasting back into a chat. Generated here
    // rather than in the browser so it carries the machine context and can
    // cross-reference the prune list — the two things that make it actionable.
    router.get('/library-sweep/report.txt', (req, res) => {
        const sw = runtime?.sweep;
        if (!sw) return res.status(503).type('text/plain').send('the sweep is not available');
        // While a sweep is in flight, render what it has so far — a two-hour run
        // should be readable at bundle 30. Once it has finished, the file on disk is
        // the better answer: it is the MERGE of this run over the previous one, so
        // re-running a single bundle to check a fix corrects one line of the report
        // instead of replacing it with a one-line report.
        const run = sw.status();
        const live = run && (run.state === 'running' || run.state === 'stopping');
        const report = (live && run.results?.length) ? run : (sw.lastReport() || (run?.results?.length ? run : null));
        if (!report) return res.status(404).type('text/plain').send('No sweep has been run on this machine yet.');
        // Cross-reference costs a usage scan; skip it rather than fail the report.
        let unused = null;
        try { unused = usageReport().models.filter(x => x.unused); } catch { /* optional */ }
        const text = renderSweepReport(report, { unused });
        res.type('text/plain; charset=utf-8');
        if (req.query.download) {
            res.setHeader('Content-Disposition', `attachment; filename="comfyq-library-sweep.txt"`);
        }
        res.send(text);
    });

    // ---- Maintenance: the scripts, runnable from here ---------------------
    // They are still ordinary Python in tools/maintenance; this exposes a
    // WHITELIST of named tasks rather than a script path, because taking a path
    // from a browser would turn a convenience button into an arbitrary-code
    // endpoint running ComfyUI's own interpreter against the live install.
    router.get('/maintenance/tasks', (req, res) => {
        const r = runtime?.scripts;
        res.json({ available: !!r, tasks: r ? r.tasks() : [], run: r ? r.status() : null });
    });

    // ★ adminGate on all of them, not only the mutating ones: a rebuild
    // rewrites the audit sheet the prune reasons are read from.
    router.post('/maintenance/run', adminGate, express.json(), async (req, res) => {
        const r = runtime?.scripts;
        if (!r) return res.status(503).json({ error: 'maintenance scripts are not available' });
        const out = await r.start(req.body?.task);
        res.status(out.ok ? 200 : 400).json(out);
    });

    router.post('/maintenance/stop', adminGate, express.json(), (req, res) => {
        const r = runtime?.scripts;
        if (!r) return res.status(503).json({ error: 'maintenance scripts are not available' });
        const out = r.stop();
        res.status(out.ok ? 200 : 400).json(out);
    });

    // What is in quarantine, and the two things you can do with it.
    function qRootNow() {
        const { config } = configManager.load();
        return quarantineRoot({
            comfyRoot: config.comfy_ui?.root_path || '',
            configured: config.maintenance?.quarantineDir,
        });
    }

    router.get('/models/quarantine', (req, res) => {
        res.json(listQuarantine({ root: qRootNow() }));
    });

    // ---- Several Pods on one volume (Phase I4) ----------------------------------
    // The other Pods whose heartbeat says they are alive on this volume. Off a
    // shared volume this is always empty and nothing below ever refuses.
    const otherPods = () => runtime?.heartbeats?.others?.() || [];

    // ★ Moving, restoring or deleting a SHARED model while another Pod is up can
    //   pull a weight from under a job it is running: the usage scan only knows
    //   this Pod's workflows. So those actions wait until this Pod is alone.
    const refuseIfShared = (res, what) => {
        const others = otherPods();
        if (!others.length) return false;
        res.status(409).json({
            error: `${what} is refused while ${others.length} other Pod${others.length > 1 ? 's are' : ' is'} running on this volume `
                + `(${others.map(o => o.id + (o.serving?.length ? ` serving ${o.serving.join(', ')}` : '')).join('; ')}). `
                + 'The models are shared: stop the other Pods first.',
            otherPods: others,
        });
        return true;
    };

    // Who else is on this volume — for the Maintenance tab, and for the RunPod
    // console, which only lets Pods share a volume when each one answers here
    // (an image older than this route has no download lock).
    router.get('/volume-pods', (req, res) => {
        const hb = runtime?.heartbeats;
        res.json({
            sharedReady: true,
            shared: !!hb?.enabled,
            me: hb ? hb.id : null,
            // This Pod's own build, so a console can compare Pods on one volume.
            image: process.env.COMFYQ_IMAGE_SHA || null,
            others: otherPods(),
        });
    });

    // ---- Folders Pods left on the volume (Phase I6) ------------------------------
    // Listed, zipped and deleted on request only. The console decides which
    // folders belong to Pods that no longer exist (it holds the RunPod key);
    // this Pod refuses its own folder and any Pod with a fresh heartbeat.
    const folderCtx = () => ({
        root: podsRoot(),
        me: runtime?.heartbeats?.id || null,
        isAlive: (id) => !!runtime?.heartbeats?.isAlive?.(id),
    });

    router.get('/volume-folders', adminGate, async (req, res) => {
        const ctx = folderCtx();
        if (!ctx.root) return res.status(409).json({ error: 'this Pod is not on a shared volume' });
        res.json({ me: ctx.me, folders: await listFolders(ctx) });
    });

    router.get('/volume-folders/:id/results.zip', adminGate, (req, res) => {
        zipResults({ root: folderCtx().root, id: req.params.id, res, archiver: require('archiver') });
    });

    router.post('/volume-folders/:id/delete', adminGate, express.json(), async (req, res) => {
        // adminGate lets everyone through when no admin password is set; a
        // delete of somebody's results must not be one of those things.
        if (!configManager.load().config.auth.adminPasswordHash) {
            return res.status(403).json({ error: 'set an admin password on this Pod before deleting folders' });
        }
        if (req.body?.confirm !== req.params.id) return res.status(400).json({ error: 'confirm with the folder name' });
        try {
            const out = await deleteFolder({ ...folderCtx(), id: req.params.id });
            res.status(out.ok ? 200 : 409).json(out);
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    router.post('/models/quarantine/restore', adminGate, express.json(), (req, res) => {
        if (refuseIfShared(res, 'Restoring a model from quarantine')) return;
        const { config } = configManager.load();
        const out = restoreFile({
            root: qRootNow(),
            batch: req.body?.batch,
            rel: req.body?.rel,
            comfyRoot: config.comfy_ui?.root_path || '',
        });
        // The file is back under models/, so every cached view is now wrong.
        if (out.ok) invalidateUsageCaches();
        res.status(out.ok ? 200 : 400).json(out);
    });

    // ★ The only irreversible step in the whole mechanism, and the only one
    // that needs no re-derivation — by this point the admin has had every
    // chance to look at what is held.
    router.post('/models/quarantine/empty', adminGate, express.json(), (req, res) => {
        if (refuseIfShared(res, 'Emptying the quarantine')) return;
        const out = emptyBatch({ root: qRootNow(), batch: req.body?.batch });
        res.status(out.ok ? 200 : 400).json(out);
    });

    router.get('/models/usage', (req, res) => {
        try {
            res.json(usageReport());
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Delete model files. Behind the admin password, and it re-derives usage
    // rather than trusting the list the browser sends: the page may have been
    // open while a workflow was added, and a stale "unused" is how you lose a
    // model that something now needs.
    router.post('/models/prune', adminGate, express.json(), (req, res) => {
        if (refuseIfShared(res, 'Pruning models')) return;
        const wanted = Array.isArray(req.body?.files) ? req.body.files : [];
        if (!wanted.length) return res.status(400).json({ error: 'no files given' });
        // ★ A low-confidence row is one where we doubt WHICH file this is — a
        // lookalike of something in use, a generic filename, or a model a
        // loader is asking for under another spelling. Those need the admin to
        // say so deliberately, not a bulk select. Medium is allowed: it means
        // "we know why this is on the disk", not "we are unsure what it is".
        const allowLow = req.body?.allowLow === true;

        // ★ The route's promise is that it re-derives usage rather than
        // trusting the browser. That was only half true: the pack-code scan and
        // the reference-template scan are cached for ten minutes and the file
        // index for thirty seconds, so a node pack installed minutes ago was
        // invisible to the very check meant to catch exactly that. 126 GB here
        // is protected by pack code alone, so the caches go for this request.
        invalidateUsageCaches();

        let report;
        try { report = usageReport(); }
        catch (e) { return res.status(500).json({ error: e.message }); }

        const root = report.comfyRoot;
        if (!root) return res.status(409).json({ error: 'ComfyUI root path is not configured' });
        const modelsRoot = path.resolve(root, 'models');
        const byRel = new Map(report.models.map(m => [m.rel, m]));

        // ★ A blind scan is not a confident one. When a configured folder could
        // not be read the report is wrong about EVERY row, so nothing may go
        // without the same deliberate acknowledgement a suspicious row needs.
        // The scoring capped such a report at "medium", which was ungated.
        const blind = report.scanned?.blind || [];
        if (blind.length && !allowLow) {
            return res.status(409).json({
                error: 'the scan could not see everything it was told about ('
                    + blind.join('; ') + ') — fix that first, or acknowledge the risk deliberately',
                blind,
            });
        }

        const { config: liveCfg } = configManager.load();
        const qRoot = quarantineRoot({
            comfyRoot: root,
            configured: liveCfg.maintenance?.quarantineDir,
        });
        if (!qRoot) return res.status(409).json({ error: 'no quarantine folder could be determined' });
        const stamp = new Date().toISOString();
        const batch = stamp.replace(/[:.]/g, '-');

        // Provenance, so the log records how to get each file back — gathered
        // now, not hoped for later.
        const prov = new Map();
        for (const sum of registry.list()) {
            for (const mm of (sum.models || [])) {
                const key = String(mm.file || '').split(/[\\/]/).pop().toLowerCase();
                if (key && !prov.has(key)) prov.set(key, { url: mm.url || null, source: mm.source || null });
            }
        }
        const audit = auditRedownload(path.resolve(__dirname, '../..'));

        const deleted = [], refused = [];
        let freed = 0;
        for (const rel of wanted) {
            const m = byRel.get(rel);
            if (!m) { refused.push({ rel, why: 'not on this disk' }); continue; }
            if (m.unused && m.confidence === 'low' && !allowLow) {
                const first = (m.confidenceReasons || []).find(r => r.effect === 'lowers');
                refused.push({
                    rel,
                    why: `low confidence — ${first ? first.detail : 'needs a closer look'}`,
                });
                continue;
            }
            if (!m.unused) {
                const who = m.usedBy.length ? `used by ${m.usedBy.join(', ')}`
                    : m.templateOnly.length ? `loaded by the editable template of ${m.templateOnly.join(', ')}`
                        : m.dropdowns.length ? `offered by a dropdown in ${m.dropdowns.join(', ')}`
                            : 'referenced by a workflow outside the bundles';
                refused.push({ rel, why: who });
                continue;
            }
            // Never step outside models/, whatever the client sent.
            const abs = path.resolve(root, rel);
            if (!abs.startsWith(modelsRoot + path.sep)) {
                refused.push({ rel, why: 'outside the models folder' });
                continue;
            }
            // ★ MOVED, not deleted. Every other safeguard reduces the chance of
            // a wrong verdict; only this makes a wrong verdict recoverable, and
            // a rename on the same volume is instant and free.
            const moved = quarantineFile({ abs, rel, root: qRoot, batch });
            if (!moved.ok) { refused.push({ rel, why: moved.error }); continue; }
            freed += moved.bytes;
            deleted.push({
                rel, name: m.name, gb: m.gb, kind: m.kind,
                bytes: moved.bytes,
                quarantinedTo: path.relative(qRoot, moved.to).split(path.sep).join('/'),
                // ★ Everything needed to fetch it again, recorded at the moment
                // it is moved rather than hoped for later. The provenance is
                // already loaded in this very request.
                url: prov.get(m.name.toLowerCase())?.url || null,
                source: prov.get(m.name.toLowerCase())?.source || null,
                redownload: audit.get(m.name.toLowerCase()) || null,
                confidence: m.confidence,
                reasons: (m.confidenceReasons || []).map(r => r.code),
            });
            // ★ Appended per file, before the next one is touched. The old code
            // rewrote one JSON array once after the whole loop, so an
            // interruption lost the record of everything already moved — and a
            // truncated file was indistinguishable from "no log yet", which the
            // next prune would silently overwrite.
            appendPruneLog({ at: stamp, batch, ...deleted[deleted.length - 1] });
        }

        if (deleted.length) {
            console.log(`[Prune] quarantined ${deleted.length} file(s), ${(freed / 1024 ** 3).toFixed(2)} GB -> ${qRoot}`);
            // ★ And again AFTER the move. The caches were dropped before the
            // re-derive so a just-installed pack could protect a file; dropping
            // them again is what makes the panel show the result. Without it the
            // 30 s model index still holds the moved files and the card redraws
            // byte-identical — same rows, same reclaimable total — which reads
            // as "the prune did nothing" and invites a second click.
            invalidateUsageCaches();
        }

        res.json({
            deleted, refused,
            freedGb: +(freed / 1024 ** 3).toFixed(2),
            quarantine: { root: qRoot, batch },
        });
    });


    // Auto-detect a local ComfyUI install and return the paths for the admin
    // UI's "Auto-detect" button to drop into the form. Read-only (doesn't save).
    router.post('/autodetect-paths', adminGate, (req, res) => {
        const detected = configManager.detectComfyPaths();
        if (!detected) return res.json({ found: false });
        res.json({ found: true, ...detected });
    });

    // --- ComfyUI network backend (admin "Launch ComfyUI" button) ---
    // Spawn (or reuse) a ComfyUI bound to 0.0.0.0 so its native web UI is
    // reachable on the LAN. Admin-mode only — in student mode ComfyUI already
    // runs for the active workflow. `runtime.comfyBackend` is the AdminCalibrator.
    router.get('/comfyui/status', (req, res) => {
        const backend = runtime?.comfyBackend;
        if (backend) {
            const s = backend.comfyStatus();
            return res.json({ ...s, available: true, urls: s.running ? lanUrls(s.port) : [] });
        }
        // Student mode: ComfyUI runs as part of the active worker.
        if (runtime?.worker) {
            const st = runtime.worker.getStatus();
            const port = configManager.load().config.comfy_ui.api_port;
            return res.json({ running: st.state !== 'down', external: false, networkBound: null, studentMode: true, available: true, port, urls: lanUrls(port) });
        }
        res.json({ running: false, available: false });
    });

    router.post('/comfyui/launch', adminGate, async (req, res) => {
        const backend = runtime?.comfyBackend;
        if (!backend) {
            return res.status(409).json({ error: 'ComfyUI backend launch is admin-mode only — in student mode ComfyUI already runs for the active workflow.' });
        }
        try {
            const s = await backend.launchBackend();
            res.json({ ok: true, ...s, urls: lanUrls(s.port) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/comfyui/stop', adminGate, async (req, res) => {
        const backend = runtime?.comfyBackend;
        if (!backend) return res.status(409).json({ error: 'No admin-mode ComfyUI backend to stop.' });
        try {
            const s = await backend.stopBackend();
            res.json({ ok: true, ...s });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/comfyui/restart', adminGate, async (req, res) => {
        const backend = runtime?.comfyBackend;
        if (!backend) return res.status(409).json({ error: 'ComfyUI backend restart is admin-mode only — in student mode ComfyUI runs for the active workflow.' });
        try {
            const s = await backend.restartBackend();
            res.json({ ok: true, ...s, urls: s.running ? lanUrls(s.port) : [] });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Validate a draft set of ComfyUI paths *before* the admin saves them.
    // Read-only — runs filesystem checks and tries `python --version` with a
    // 5s timeout. Returns a per-check breakdown so the UI can show exactly
    // which path is wrong.
    router.post('/check-paths', adminGate, express.json(), async (req, res) => {
        const { root_path, python_executable, output_dir, assets_dir } = req.body || {};
        const checks = [];

        let rootOk = false;
        if (!root_path) {
            checks.push({ label: 'ComfyUI root path', ok: false, detail: 'not set' });
        } else if (!fs.existsSync(root_path)) {
            checks.push({ label: 'ComfyUI root path', ok: false, detail: `not found: ${root_path}` });
        } else if (!fs.statSync(root_path).isDirectory()) {
            checks.push({ label: 'ComfyUI root path', ok: false, detail: `not a directory: ${root_path}` });
        } else {
            checks.push({ label: 'ComfyUI root path', ok: true, detail: root_path });
            rootOk = true;
            const mainPy = path.join(root_path, 'main.py');
            if (fs.existsSync(mainPy)) {
                checks.push({ label: 'ComfyUI main.py', ok: true, detail: mainPy });
            } else {
                checks.push({ label: 'ComfyUI main.py', ok: false, detail: `not found at ${mainPy} — is this really a ComfyUI directory?` });
            }
        }

        if (!python_executable) {
            checks.push({ label: 'Python executable', ok: false, detail: 'not set' });
        } else {
            // ComfyProcess uses fs.existsSync(python_executable) directly,
            // which resolves relative paths against the server's cwd. That
            // works when the server is launched from the project root with
            // a path like `../python_embeded/python.exe` next to a portable
            // ComfyUI. As a helpful fallback, also try resolving relative to
            // root_path so the admin gets a clear pass when the layout is
            // standard but the server cwd happens to differ.
            let resolved = python_executable;
            let exists = fs.existsSync(resolved);
            if (!exists && !path.isAbsolute(python_executable) && rootOk) {
                const rel = path.resolve(root_path, python_executable);
                if (fs.existsSync(rel)) { resolved = rel; exists = true; }
            }
            if (!exists) {
                checks.push({ label: 'Python executable', ok: false, detail: `not found: ${python_executable}` });
            } else {
                try {
                    const version = await new Promise((resolve, reject) => {
                        const proc = spawn(resolved, ['--version'], { windowsHide: true });
                        let out = '', err = '';
                        proc.stdout.on('data', d => { out += d.toString(); });
                        proc.stderr.on('data', d => { err += d.toString(); });
                        const timer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } reject(new Error('timed out after 5s')); }, 5000);
                        proc.on('error', e => { clearTimeout(timer); reject(e); });
                        proc.on('exit', (code) => {
                            clearTimeout(timer);
                            if (code === 0) resolve((out || err).trim() || 'ran (no version output)');
                            else reject(new Error(`exited with code ${code}${err ? ': ' + err.trim() : ''}`));
                        });
                    });
                    checks.push({ label: 'Python executable', ok: true, detail: `${resolved} → ${version}` });
                } catch (e) {
                    checks.push({ label: 'Python executable', ok: false, detail: `${resolved}: ${e.message}` });
                }
            }
        }

        if (output_dir) {
            if (!fs.existsSync(output_dir)) {
                checks.push({ label: 'Output directory', ok: false, detail: `does not exist: ${output_dir}` });
            } else if (!fs.statSync(output_dir).isDirectory()) {
                checks.push({ label: 'Output directory', ok: false, detail: `not a directory: ${output_dir}` });
            } else {
                try {
                    fs.accessSync(output_dir, fs.constants.W_OK);
                    checks.push({ label: 'Output directory', ok: true, detail: `${output_dir} (writable)` });
                } catch {
                    checks.push({ label: 'Output directory', ok: false, detail: `${output_dir} is not writable` });
                }
            }
        }

        // Assets directory is optional (blank → calibration falls back to a
        // built-in image; video/audio inputs then can't auto-calibrate). Only
        // validate it when set. Report the media-file count so the admin can
        // confirm they pointed at the right folder after a drive-letter change.
        if (assets_dir) {
            if (!fs.existsSync(assets_dir)) {
                checks.push({ label: 'Assets directory', ok: false, detail: `does not exist: ${assets_dir}` });
            } else if (!fs.statSync(assets_dir).isDirectory()) {
                checks.push({ label: 'Assets directory', ok: false, detail: `not a directory: ${assets_dir}` });
            } else {
                let media = 0;
                try {
                    for (const f of fs.readdirSync(assets_dir)) {
                        if (/\.(png|jpe?g|webp|bmp|gif|mp4|webm|mov|mkv|avi|wav|mp3|flac|ogg|aac|m4a)$/i.test(f)) media++;
                    }
                } catch { /* unreadable — leave media at 0 */ }
                checks.push({
                    label: 'Assets directory',
                    ok: media > 0,
                    detail: media > 0
                        ? `${assets_dir} (${media} media file${media === 1 ? '' : 's'} for calibration)`
                        : `${assets_dir} — no image/video/audio files found; calibration won't find inputs here`
                });
            }
        }

        res.json({ ok: checks.every(c => c.ok), checks });
    });

    // Light-touch endpoint: returns whether the X-Admin-Password header
    // matches the configured password. Used by the admin UI to turn the
    // "Admin password is set" chip green once the operator has typed the
    // correct password — no destructive side effects, no rate-limit risk
    // since the chip only re-checks on input change.
    router.post('/verify-password', (req, res) => {
        const { config } = configManager.load();
        const configured = !!config.auth.adminPasswordHash;
        if (!configured) return res.json({ configured: false, valid: true });
        const provided = req.headers['x-admin-password'];
        const valid = checkAdminPassword(provided, configManager);
        res.json({ configured: true, valid });
    });

    // Set / clear the admin password. Allowed without auth ONLY when no
    // password is currently set (first-run). Otherwise requires the current
    // password via X-Admin-Password header.
    router.put('/admin-password', express.json(), (req, res) => {
        try {
            const { config } = configManager.load();
            const hasExisting = !!config.auth.adminPasswordHash;
            if (hasExisting) {
                const provided = req.headers['x-admin-password'];
                if (!checkAdminPassword(provided, configManager)) {
                    return res.status(401).json({ error: 'admin password required' });
                }
            }
            const { password } = req.body || {};
            setAdminPassword(password || '', configManager);
            res.json({ ok: true });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // Set / clear the STUDENT ACCESS password — the one that decides who may
    // use this machine at all (empty = open to everyone on the LAN, the
    // default). Gated by the admin password when one is configured; on a rig
    // with no admin password the whole admin panel is already open, so this
    // matches the rest of it.
    //
    // Changing it rotates the derived token, so tokens already handed out stop
    // working. Sockets connected under the old token are disconnected right
    // away — otherwise locking a machine mid-session would leave whoever was
    // already on it able to keep booking jobs.
    router.put('/access-password', adminGate, express.json(), (req, res) => {
        try {
            const { password } = req.body || {};
            setAccessPassword(password || '', configManager);
            try { runtime?.bus?.enforceAccess?.(); } catch (e) { /* non-fatal */ }
            res.json({ ok: true, locked: !!(password || '') });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // A HuggingFace access token, so a gated repository can be downloaded.
    //
    // ★ Its own route rather than a field on PUT /admin/comfy, and adminGate'd
    // like the two passwords: it is a credential for someone's HF account, it is
    // write-only (GET /admin/config reports only `hasHfToken`), and an empty
    // string clears it. Eight of this library's model links answer 401 without
    // one — FLUX.2 and LTX-2.5 — and until this existed the downloader's own
    // advice ("set an access token under Manage ComfyUI") pointed at a field
    // that was not there.
    router.put('/hf-token', adminGate, express.json(), (req, res) => {
        try {
            const token = String(req.body?.token ?? '').trim();
            configManager.update(c => {
                c.comfy_ui = c.comfy_ui || {};
                c.comfy_ui.hf_token = token;
                return c;
            });
            res.json({ ok: true, hasHfToken: !!token });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // Activate a workflow and switch to student mode.
    // Compare every bundle's `select` option lists against the nodes actually
    // installed on this ComfyUI.
    //
    // This exists because a meta.json option list can drift from its node and
    // nothing notices until a job picks a non-default value — at which point
    // ComfyUI rejects the whole prompt. That is how seven title cards of a
    // 55-shot storyboard failed. Run it after installing or updating custom
    // nodes, and before committing a long batch.
    router.get('/workflow-options-check', adminGate, async (req, res) => {
        try {
            const cfg = configManager.resolvePaths(configManager.load().config);
            const host = (cfg.comfy_ui.api_host === '0.0.0.0' || cfg.comfy_ui.api_host === '::')
                ? '127.0.0.1' : cfg.comfy_ui.api_host;
            const rest = new ComfyRestClient({ host, port: cfg.comfy_ui.api_port });
            try { await rest.ping(); }
            catch { return res.status(503).json({ error: 'ComfyUI is not responding — start it, then check again.' }); }

            const stale = [];
            const skipped = [];
            let checked = 0;

            for (const summary of registry.summaries({ includeUnavailable: true, includeHidden: true })) {
                const entry = registry.get(summary.id);
                if (!entry || entry.unavailable) continue;
                for (const p of entry.effective?.exposedParameters || []) {
                    if (p.type !== 'select') continue;
                    const node = entry.apiWorkflow?.[p.nodeId];
                    const classType = node?.class_type || null;
                    if (!classType) {
                        skipped.push({ workflowId: entry.id, key: p.key, reason: 'node not in the api.json' });
                        continue;
                    }
                    let live = null;
                    try { live = await getComboOptions(rest, classType, p.field); }
                    catch { live = null; }
                    if (!live) {
                        // NOT the same as "no valid values": a dynamic node like
                        // CustomCombo keeps its choices in the workflow's own
                        // widget values, so there is nothing here to check.
                        skipped.push({
                            workflowId: entry.id, key: p.key, classType,
                            reason: 'this node does not publish a fixed option list'
                        });
                        continue;
                    }
                    checked++;
                    const declared = p.options || [];
                    const bogusOptions = declared.filter(o => !live.includes(o));
                    const missingOptions = live.filter(o => !declared.includes(o));
                    const defaultValid = p.default === undefined || live.includes(p.default);
                    if (bogusOptions.length > 0 || !defaultValid) {
                        stale.push({
                            workflowId: entry.id, key: p.key, nodeId: p.nodeId, classType,
                            field: p.field, bogusOptions, missingOptions,
                            defaultValid, declaredDefault: p.default, liveOptions: live
                        });
                    }
                }
            }
            console.log(`[Admin] workflow-options-check: ${checked} checked, ${stale.length} stale, ${skipped.length} skipped`);
            res.json({ ok: true, checked, stale, skipped });
        } catch (e) {
            console.error('[Admin] workflow-options-check err:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // ★ adminGate'd (2026-10-20): it was open, and on a Pod anyone holding the
    //   URL could switch what the machine serves.
    router.post('/activate-workflow', adminGate, express.json(), (req, res) => {
        try {
            const { workflowId, serveWithoutModels } = req.body || {};
            if (!workflowId) return res.status(400).json({ error: 'workflowId required' });
            const entry = registry.get(workflowId);
            if (!entry || entry.unavailable) {
                return res.status(409).json({ error: entry?.reason || 'workflow unavailable' });
            }
            const prev = configManager.load().config;

            // ★ Missing models are downloaded first, exactly as when a machine is
            //   launched with this workflow (cloud/podPlan.js): a machine started
            //   with no workflow, then given one in this panel, used to serve it
            //   without its models, and every job failed (owner, 2026-10-20).
            //   The plan downloads, then switches to serving by itself; on a
            //   failure it stays in admin mode and says why.
            const plan = require('../cloud/podPlan');
            // While a download is under way nothing else switches: it ends by
            // switching to what it downloaded for, and would undo the other.
            // A plan left "fetching" by a restart mid-download is not running: a
            // live one is rewritten every few seconds (podPlan pollMs).
            const running = plan.readPlan();
            const live = running && Date.now() - Date.parse(running.updatedAt || 0) < 120_000;
            if (running && live && ['pending', 'fetching'].includes(running.status)) {
                return res.status(409).json({ error: `models are being downloaded for ${(running.serve || []).join(', ')}: wait for that to finish` });
            }
            const missing = serveWithoutModels ? [] : plan.missingModels(entry, prev.comfy_ui?.root_path).filter(m => !m.auto);
            if (missing.length) {
                if (!runtime?.downloader) return res.status(503).json({ error: 'the model downloader is not available here' });
                // The lanes open now stay open, so their models are checked too.
                const serve = [workflowId, ...(prev.workflows.extraLaneWorkflowIds || []).filter(x => x !== workflowId)];
                const now = new Date().toISOString();
                plan.writePlan({ serve, fetchModels: true, createdAt: now, updatedAt: now, files: [], error: null, status: 'pending', from: 'admin panel' });
                console.log(`[Admin] activate-workflow: ${workflowId} is missing ${missing.length} model file(s): downloading them first`);
                plan.runPlan({ configManager, registry, downloader: runtime.downloader, exitForRestart })
                    .catch(e => console.error('[pod-plan] failed:', e.message));
                return res.json({ ok: true, fetching: true, workflowId, missing: missing.map(m => m.file) });
            }
            const prevId = prev.workflows.activeWorkflowId;
            const prevMode = prev.mode;
            console.log(`[Admin] activate-workflow: ${prevId || '(none)'} → ${workflowId}  (mode: ${prevMode} → student)`);
            console.log(`[Admin]   name="${entry.summary?.name}"  category=${entry.summary?.category}  exposedParams=${entry.effective?.exposedParameters?.length ?? '?'}`);
            // Warn (don't block) if scheduled jobs exist for the previous workflow.
            if (runtime?.queue && prevId && prevId !== workflowId) {
                try {
                    const sm = require('../queue/jobStateMachine');
                    const stale = runtime.queue.list({ status: sm.STATES.SCHEDULED, limit: 1000 })
                        .filter(j => j.workflowId !== workflowId);
                    if (stale.length > 0) {
                        console.warn(`[Admin]   ${stale.length} scheduled job(s) reference the previous workflow and will run with their original workflow if it is still available on disk`);
                    }
                } catch { /* non-critical */ }
            }
            configManager.update(c => {
                c.workflows.activeWorkflowId = workflowId;
                c.mode = 'student';
                return c;
            });
            console.log(`[Admin] config updated; restarting…`);
            res.json({ ok: true, mode: 'student', workflowId });
            // Drop the one-shot student-boot flag; every other restart → admin.
            if (exitForRestart) setTimeout(() => exitForRestart('student'), 250);
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // Where a workflow's ComfyUI keeps its saved workflows. A workflow being
    // served in its own lane has its own user directory (see LaneManager);
    // everything else uses the install's.
    const laneUserRoot = (workflowId, root) => {
        const lane = runtime?.lanes?.get(workflowId) || null;
        return lane?.comfyConfig?.user_dir || path.join(root, 'user');
    };

    // ---- Lanes -------------------------------------------------------------
    // A lane is a workflow plus the ComfyUI process running it. Several run at
    // once on one GPU, so a second model can be served without switching the
    // machine over — and without the restart that activate-workflow does, which
    // drops every open student tab.

    router.get('/lanes', (req, res) => {
        const lanes = runtime?.lanes;
        if (!lanes) return res.json({ lanes: [], available: false });
        const cardGb = lanes.cardVramGb();
        const usedGb = +lanes.list().reduce((t, l) => t + (l.vramGb || 0), 0).toFixed(2);
        // What each workflow would need, and whether it would fit right now —
        // so the library can say "serve alongside" or explain why it can't.
        const fit = {};
        for (const s of registry.summaries({ includeHidden: false })) {
            if (s.unavailable) continue;
            fit[s.id] = lanes.fit(s.id);
        }
        res.json({ available: true, lanes: lanes.list(), card: { vramGb: cardGb, usedGb }, fit });
    });

    router.post('/lanes', adminGate, express.json(), async (req, res) => {
        const lanes = runtime?.lanes;
        if (!lanes) return res.status(409).json({ error: 'lanes are only available while serving' });
        const { workflowId, force = false } = req.body || {};
        if (!workflowId) return res.status(400).json({ error: 'workflowId required' });
        try {
            const lane = await lanes.open(workflowId, { force: !!force });
            res.json({ ok: true, lane });
        } catch (e) {
            // A refusal carries the numbers so the UI can explain itself, and
            // `force` lets the admin overrule a "can't tell" verdict.
            res.status(e.fit ? 409 : 500).json({ error: e.message, code: e.code || null, fit: e.fit || null });
        }
    });

    router.delete('/lanes/:workflowId', adminGate, async (req, res) => {
        const lanes = runtime?.lanes;
        if (!lanes) return res.status(409).json({ error: 'lanes are only available while serving' });
        const lane = lanes.get(req.params.workflowId);
        if (!lane) return res.status(404).json({ error: 'no such lane' });
        if (lane.primary) {
            return res.status(409).json({ error: 'This is the machine\'s main lane — use "Stop serving" to close it.' });
        }
        await lanes.close(req.params.workflowId);
        res.json({ ok: true });
    });

    // Clean every output file referenced by any completed job, then clear
    // the outputs field on each so the UI no longer offers broken downloads.
    // Job records themselves are preserved (history). Gated by admin password
    // because it deletes everyone's results. Available in both admin and
    // student mode (uses runtime.queue when present, otherwise opens the
    // configured sqlite file directly).
    router.post('/cleanup-outputs', adminGate, (req, res) => {
        try {
            const cfg = configManager.resolvePaths(configManager.load().config);
            const queue = runtime?.queue || _openQueueAdHoc(cfg);
            if (!queue) return res.status(500).json({ error: 'queue unavailable' });
            let filesDeleted = 0;
            let jobsCleared = 0;
            let skippedInFlight = 0;
            const errors = [];
            const jobs = queue.list({ limit: 100000 });
            for (const job of jobs) {
                const outputs = job.outputs || [];
                if (outputs.length === 0) continue;
                // Don't yank files out from under a currently-running job — its
                // output collector is about to need them. Only act on terminal jobs.
                if (sm.isInFlight(job.status)) { skippedInFlight++; continue; }
                for (const o of outputs) {
                    try {
                        const abs = resolveOutputPath(o, cfg.comfy_ui);
                        if (abs && fs.existsSync(abs)) { fs.unlinkSync(abs); filesDeleted++; }
                    } catch (e) {
                        errors.push(`${o.filename}: ${e.message}`);
                    }
                }
                queue.setOutputs(job.id, []);
                jobsCleared++;
            }
            // If we opened our own queue handle, close it.
            if (!runtime?.queue && queue._closeAdHoc) queue._closeAdHoc();
            console.log(`[Admin] cleanup-outputs: ${filesDeleted} file(s) deleted, ${jobsCleared} job(s) cleared, ${skippedInFlight} in-flight skipped, ${errors.length} error(s)`);
            res.json({ ok: true, filesDeleted, jobsCleared, skippedInFlight, errors });
        } catch (e) {
            console.error('[Admin] cleanup-outputs err:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // Permanently delete terminal job records (completed/failed/cancelled) and
    // their event logs, plus any output files those jobs referenced. Scheduled
    // and in-flight jobs are preserved so a running queue isn't corrupted.
    // Gated by admin password because it wipes everyone's history. Available in
    // both admin and student mode (uses runtime.queue when present, otherwise
    // opens the configured sqlite file directly).
    router.post('/clear-history', adminGate, (req, res) => {
        try {
            const cfg = configManager.resolvePaths(configManager.load().config);
            const queue = runtime?.queue || _openQueueAdHoc(cfg);
            if (!queue) return res.status(500).json({ error: 'queue unavailable' });
            const deleted = queue.clearHistory();
            let filesDeleted = 0;
            const errors = [];
            for (const job of deleted) {
                for (const o of job.outputs || []) {
                    try {
                        const abs = resolveOutputPath(o, cfg.comfy_ui);
                        if (abs && fs.existsSync(abs)) { fs.unlinkSync(abs); filesDeleted++; }
                    } catch (e) {
                        errors.push(`${o.filename}: ${e.message}`);
                    }
                }
            }
            if (!runtime?.queue && queue._closeAdHoc) queue._closeAdHoc();
            console.log(`[Admin] clear-history: ${deleted.length} job(s) deleted, ${filesDeleted} file(s) removed, ${errors.length} error(s)`);
            res.json({ ok: true, jobsDeleted: deleted.length, filesDeleted, errors });
        } catch (e) {
            console.error('[Admin] clear-history err:', e);
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/reset-to-admin', adminGate, (req, res) => {
        configManager.update(c => { c.mode = 'admin'; return c; });
        res.json({ ok: true, mode: 'admin' });
        // 'admin' = stop serving on purpose, so later restarts stay in admin.
        if (exitForRestart) setTimeout(() => exitForRestart('admin'), 250);
    });

    router.post('/restart-server', adminGate, (req, res) => {
        res.json({ ok: true });
        // Neutral: a machine that was serving comes back serving. Use
        // "Reset to admin" to actually stop.
        if (exitForRestart) setTimeout(() => exitForRestart(), 250);
    });

    // Emergency stop: cancel every non-terminal job, interrupt + kill the
    // ComfyUI process (only the one we spawned — external attached ComfyUI
    // is left alone), switch to admin mode, and restart the server.
    router.post('/emergency-stop', adminGate, async (req, res) => {
        if (!runtime?.queue || !runtime?.worker) {
            return res.status(409).json({ error: 'emergency-stop is only available in student mode' });
        }
        const result = { cancelledScheduled: 0, failedInFlight: 0, killedComfy: false };
        try {
            // Mark scheduled jobs as cancelled.
            const scheduled = runtime.queue.list({ status: sm.STATES.SCHEDULED, limit: 10000 });
            for (const j of scheduled) {
                try {
                    runtime.queue.transitionStatus(j.id, sm.STATES.CANCELLED);
                    result.cancelledScheduled++;
                } catch { /* may have raced to terminal */ }
            }
            // Mark in-flight jobs as failed BEFORE killing ComfyUI so the
            // worker's 'failed' event lands as a no-op rather than a duplicate.
            const inFlight = [
                sm.STATES.UPLOADING_INPUTS, sm.STATES.SUBMITTED,
                sm.STATES.EXECUTING, sm.STATES.COLLECTING_OUTPUTS
            ];
            for (const status of inFlight) {
                const jobs = runtime.queue.list({ status, limit: 10000 });
                for (const j of jobs) {
                    try {
                        runtime.queue.transitionStatus(j.id, sm.STATES.FAILED, {
                            payload: { errorReason: 'emergency-stop', errorPhase: status }
                        });
                        result.failedInFlight++;
                    } catch { /* ignore */ }
                }
            }
            // Best-effort interrupt, then kill the spawned ComfyUI. If we're
            // attached to an external ComfyUI (process.proc === null) the
            // stop() is a no-op and we leave that process alone.
            try { await runtime.worker.rest.interrupt(); } catch { /* ignore */ }
            try {
                const hadSpawned = !!runtime.worker.process?.proc;
                await runtime.worker.process?.stop();
                result.killedComfy = hadSpawned;
            } catch (e) {
                console.warn('[admin] emergency-stop kill err:', e.message);
            }
            // Flip to admin mode and restart so we don't auto-relaunch ComfyUI.
            configManager.update(c => { c.mode = 'admin'; return c; });
            res.json({ ok: true, ...result, restarting: true });
            // Emergency stop is a deliberate halt — do not resume on the
            // next boot.
            if (exitForRestart) setTimeout(() => exitForRestart('admin'), 250);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message, ...result });
        }
    });

    // Upload an API-format workflow JSON + auto-generate a meta.json scaffold.
    // Saves into <workflowsDir>/<id>/<id>.api.json + <id>.meta.json.
    // Admin can then click "Activate" to start using it.
    router.post('/upload-workflow', adminGate, memUpload.single('workflow'), (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
            const json = JSON.parse(req.file.buffer.toString('utf8'));
            const validation = validateApiWorkflow(json);
            if (!validation.valid) return res.status(400).json({ error: validation.error, format: validation.format });

            const cfg = configManager.load().config;
            const baseName = path.basename(req.file.originalname, '.json');
            const id = sanitizeId(req.body.id || baseName);
            if (!id) return res.status(400).json({ error: 'cannot derive workflow id from filename' });

            const dir = path.resolve(cfg.workflows.dir.startsWith('.')
                ? path.resolve(__dirname, '../..', cfg.workflows.dir)
                : cfg.workflows.dir, id);
            if (fs.existsSync(dir) && !req.body.force) {
                return res.status(409).json({ error: `workflow folder already exists: ${id}`, hint: 'pass force=true to overwrite' });
            }
            fs.mkdirSync(dir, { recursive: true });

            const apiFilename = `${id}.api.json`;
            fs.writeFileSync(path.join(dir, apiFilename), JSON.stringify(json, null, 2), 'utf8');

            const parsed = parseWorkflow(json);
            const meta = WorkflowMeta.parse({
                schemaVersion: 1,
                id,
                name: req.body.name || baseName.replace(/[_-]+/g, ' '),
                description: req.body.description || '',
                category: req.body.category || 'other',
                tags: [],
                author: req.body.author || 'Unknown',
                version: '1.0.0',
                workflowFile: apiFilename,
                apiFormat: true,
                requirements: { minVRAM: 0, models: [] },
                estimatedDurationSec: 60,
                exposedParameters: parsed.parameters,
                warmupParams: {},
                presets: {}
            });
            fs.writeFileSync(path.join(dir, `${id}.meta.json`), JSON.stringify(meta, null, 2), 'utf8');
            registry.discover();
            res.json({ ok: true, id, parameterCount: parsed.parameters.length });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // Edit-data for a workflow: current meta + ALL primitives detected in the
    // api.json (so the editor can re-enable params that were hidden previously).
    router.get('/workflows/:id/edit-data', adminGate, (req, res) => {
        try {
            const id = req.params.id;
            const entry = registry.get(id);
            if (!entry) return res.status(404).json({ error: 'unknown workflow' });
            if (entry.unavailable) return res.status(409).json({ error: entry.reason });
            const detected = parseWorkflow(entry.apiWorkflow).parameters;
            const exposedByKey = new Map();
            for (const p of entry.meta.exposedParameters) {
                exposedByKey.set(`${p.nodeId}:${p.field}`, p);
            }
            const merged = detected.map(d => {
                const found = exposedByKey.get(`${d.nodeId}:${d.field}`);
                if (found) {
                    return {
                        ...d,
                        type: found.type,
                        label: found.label,
                        default: found.default,
                        options: found.options ?? d.options,
                        optionsDir: found.optionsDir,
                        optionsFilter: found.optionsFilter,
                        min: found.min,
                        max: found.max,
                        step: found.step,
                        maxInputEdge: found.maxInputEdge,
                        disabledWhen: found.disabledWhen,
                        linkedValues: found.linkedValues,
                        // whenEmpty/whenEmptySet were missing here: a re-save
                        // silently dropped `unlink`, which turns an unused
                        // reference slot back into a black placeholder the
                        // model actually LOOKS at.
                        whenEmpty: found.whenEmpty,
                        whenEmptySet: found.whenEmptySet,
                        format: found.format,
                        required: found.required ?? d.required,
                        order: found.order ?? d.order,
                        enabled: true
                    };
                }
                return { ...d, enabled: false };
            });
            // Exposed params first, in the order students see them; the rest keep
            // graph order. The editor saves `order` from list position, so without
            // this its preview (and any re-save) followed graph order instead.
            merged.sort((a, b) => (a.enabled === b.enabled)
                ? (a.enabled ? (a.order ?? 0) - (b.order ?? 0) : 0)
                : (a.enabled ? -1 : 1));
            // apiWorkflow lets the editor offer a "Download JSON" (drag it into
            // the ComfyUI canvas to inspect the node graph) without a second route.
            // When the bundle also ships the original UI-format export, hand that
            // over instead so "Open in ComfyUI" loads the full editable graph
            // (subgraphs, groups, notes) rather than the flat API graph.
            let templateWorkflow = null;
            if (entry.hasTemplate) {
                try { templateWorkflow = JSON.parse(fs.readFileSync(entry.templatePath, 'utf8')); }
                catch (e) { console.warn(`[Admin] ${id}: failed to read template: ${e.message}`); }
            }
            res.json({
                meta: entry.meta,
                detectedParameters: merged,
                apiWorkflow: entry.apiWorkflow,
                templateWorkflow,
                hasTemplate: !!templateWorkflow
            });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // List installed model files (default: LoRAs) for the workflow editor's
    // Student Preview, so a `lora`-type param's dropdown shows the same options
    // students see. `filter` is a filename prefix (e.g. `krea2_`); `dir` is the
    // subdir under `models/` (default `loras`). The live student form gets these
    // populated server-side in the realtime broadcast — this route is only so the
    // admin preview can render an accurate dropdown.
    router.get('/loras', adminGate, (req, res) => {
        try {
            const root = configManager.load().config.comfy_ui.root_path;
            const dir = typeof req.query.dir === 'string' && req.query.dir ? req.query.dir : 'loras';
            const filter = typeof req.query.filter === 'string' ? req.query.filter : '';
            const files = listModelFiles(root, dir, filter);
            res.json({ files, labels: files.map(prettyModelLabel) });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // Stage a workflow's original UI-format template into ComfyUI's user
    // workflows folder (`<comfy root>/user/default/workflows/<id>.json`) so it
    // shows up in ComfyUI's Workflows sidebar — one click to open as the full
    // editable graph. This automates what the admin otherwise does by hand.
    // ComfyUI (1.45) has no URL param to auto-open an arbitrary workflow, so the
    // sidebar is the reliable, version-independent handoff. Requires the bundle
    // to ship `<id>_template.json`; the client falls back to download+drag when
    // it doesn't (API-only workflows) or when staging fails (bad/unset path).
    router.post('/workflows/:id/stage-template', adminGate, (req, res) => {
        try {
            const id = req.params.id;
            const entry = registry.get(id);
            if (!entry) return res.status(404).json({ error: 'unknown workflow' });
            if (!entry.hasTemplate) {
                return res.status(409).json({ error: 'no-template', message: 'This workflow has no editable template yet — only the flat API graph is available.' });
            }
            const root = configManager.load().config.comfy_ui.root_path;
            if (!root) return res.status(400).json({ error: 'ComfyUI root path is not configured (Admin → ComfyUI settings).' });
            const openName = `${id}_template`;
            // A workflow served in its own lane has its own ComfyUI with its own
            // user directory; staging into the install's would put the workflow
            // in front of the WRONG ComfyUI, and the lane's canvas would open
            // empty.
            const dir = path.join(laneUserRoot(id, root), 'default', 'workflows');
            fs.mkdirSync(dir, { recursive: true });
            const dest = path.join(dir, `${openName}.json`);
            fs.copyFileSync(entry.templatePath, dest);
            res.json({ ok: true, workflowName: id, openName, path: dest });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Full "Open in ComfyUI" for the admin panel: stage the editable template AND
    // ensure the ComfyQ opener extension is loaded, so the client can open
    // `<comfyui>/?comfyq_open=<id>` and land directly on the editable graph.
    // Launches/restarts ComfyUI as needed (blocks until reachable). Returns
    // `autoOpen:false` when we can't guarantee the opener (e.g. an external
    // ComfyUI we can't restart) so the client falls back to the sidebar handoff.
    router.post('/workflows/:id/open-in-comfyui', adminGate, async (req, res) => {
        const backend = runtime?.comfyBackend;
        try {
            const id = req.params.id;
            const entry = registry.get(id);
            if (!entry) return res.status(404).json({ error: 'unknown workflow' });
            if (!entry.hasTemplate) {
                return res.status(409).json({ error: 'no-template', message: 'This workflow has no editable template yet — only the flat API graph is available.' });
            }
            const cfg = configManager.load().config.comfy_ui;
            if (!cfg.root_path) return res.status(400).json({ error: 'ComfyUI root path is not configured (Admin → ComfyUI settings).' });
            // Stage the UI-format template as a ComfyUI saved workflow — under the
            // `<id>_template` name (the template's own name), NOT `<id>.json`, so we
            // never overwrite an admin's own hand-saved ComfyUI workflow of the
            // same id, and it's clear in the sidebar this is the ComfyQ template.
            const openName = `${id}_template`;
            const lane = runtime?.lanes?.get(id) || null;
            const dir = path.join(laneUserRoot(id, cfg.root_path), 'default', 'workflows');
            fs.mkdirSync(dir, { recursive: true });
            fs.copyFileSync(entry.templatePath, path.join(dir, `${openName}.json`));
            let port = cfg.api_port;
            let autoOpen = false;
            if (lane) {
                // The lane already has a ComfyUI running on its own port, and the
                // opener extension lives in the install's shared custom_nodes, so
                // every lane loads it. Nothing to launch or restart.
                port = lane.port;
                autoOpen = fs.existsSync(path.join(cfg.root_path, 'custom_nodes', 'comfyq_opener'));
            } else if (backend && typeof backend.ensureOpenerLoaded === 'function') {
                // Ensure ComfyUI is up with the opener extension (launch/restart as needed).
                const st = await backend.ensureOpenerLoaded();
                port = st.port || port;
                autoOpen = st.openerLoaded === true;
            }
            res.json({ ok: true, workflowName: id, openName, port, autoOpen });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Delete a workflow folder bundle. Refuses to delete the currently-active
    // workflow — caller must activate another (or reset to admin) first.
    router.delete('/workflows/:id', adminGate, (req, res) => {
        try {
            const id = req.params.id;
            if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
                return res.status(400).json({ error: 'invalid workflow id' });
            }
            const cfg = configManager.load().config;
            if (cfg.workflows.activeWorkflowId === id) {
                return res.status(409).json({
                    error: 'cannot delete the active workflow; activate another first or reset to admin mode'
                });
            }
            const baseDir = cfg.workflows.dir.startsWith('.')
                ? path.resolve(__dirname, '../..', cfg.workflows.dir)
                : cfg.workflows.dir;
            const folder = path.resolve(baseDir, id);
            if (!folder.startsWith(path.resolve(baseDir))) {
                return res.status(400).json({ error: 'path traversal rejected' });
            }
            if (!fs.existsSync(folder)) return res.status(404).json({ error: 'workflow not found' });
            fs.rmSync(folder, { recursive: true, force: true });
            registry.discover();
            res.json({ ok: true, id });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Overwrite meta.json with a validated payload. id, apiFormat, workflowFile
    // are forced to the canonical values regardless of client input.
    router.put('/workflows/:id/meta', adminGate, express.json({ limit: '5mb' }), (req, res) => {
        try {
            const id = req.params.id;
            const cfg = configManager.load().config;
            const baseDir = cfg.workflows.dir.startsWith('.')
                ? path.resolve(__dirname, '../..', cfg.workflows.dir)
                : cfg.workflows.dir;
            const folder = path.resolve(baseDir, id);
            const apiPath = path.join(folder, `${id}.api.json`);
            if (!fs.existsSync(apiPath)) return res.status(404).json({ error: 'workflow not found' });
            const incoming = req.body || {};
            // A client that doesn't know about the experimental flag must not
            // silently validate a workflow by re-saving it: keep the stored value
            // unless the payload sets it explicitly.
            let experimental = incoming.experimental;
            if (typeof experimental !== 'boolean') {
                try {
                    const current = JSON.parse(fs.readFileSync(path.join(folder, `${id}.meta.json`), 'utf8'));
                    experimental = current.experimental === true;
                } catch { experimental = false; }
            }
            const meta = WorkflowMeta.parse({
                ...incoming,
                experimental,
                schemaVersion: 1,
                id,
                apiFormat: true,
                workflowFile: `${id}.api.json`
            });
            fs.writeFileSync(path.join(folder, `${id}.meta.json`), JSON.stringify(meta, null, 2), 'utf8');
            registry.discover();
            res.json({ ok: true, id });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // Mark / unmark a workflow as experimental. Validating (experimental:false)
    // is the admin's sign-off after testing a new bundle by hand. Written into
    // meta.json itself — not the per-deployment config.meta.json — so the
    // decision is committed with the bundle and every rig sees it. Only the one
    // key is touched; the rest of the file is kept as authored.
    router.put('/workflows/:id/experimental', adminGate, express.json(), (req, res) => {
        try {
            const id = req.params.id;
            const { experimental } = req.body || {};
            if (typeof experimental !== 'boolean') {
                return res.status(400).json({ error: 'experimental must be a boolean' });
            }
            const entry = registry.get(id);
            if (!entry) return res.status(404).json({ error: 'unknown workflow' });
            const metaPath = entry.paths.metaPath;
            if (!fs.existsSync(metaPath)) return res.status(404).json({ error: 'meta.json not found' });
            const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            let next;
            if (experimental) {
                // Keep the flag next to the other identity fields for readability.
                next = {};
                for (const [k, v] of Object.entries(raw)) {
                    if (k === 'experimental') continue;
                    next[k] = v;
                    if (k === 'version') next.experimental = true;
                }
                if (next.experimental !== true) next.experimental = true;
            } else {
                // false is the schema default — drop the key so a validated bundle
                // looks exactly like one that was never experimental.
                next = { ...raw };
                delete next.experimental;
            }
            const check = WorkflowMeta.safeParse(next);
            if (!check.success) {
                return res.status(409).json({ error: `meta.json would be invalid: ${check.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
            }
            fs.writeFileSync(metaPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
            registry.discover();
            console.log(`[Admin] workflow ${id}: ${experimental ? 'marked experimental' : 'validated (experimental flag cleared)'}`);
            res.json({ ok: true, id, experimental });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    return router;
}

module.exports = { makeRouter };
