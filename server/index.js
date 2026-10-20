// ComfyQ v2 — main bootstrap.
// Composition root for the v2 architecture.
//
//   Admin mode: minimal HTTP only — admin can configure ComfyUI paths,
//                upload workflows, pick one to activate.
//   Student mode: full stack — workflow registry + sqlite queue + local
//                ComfyUI worker + job executor + realtime bus + media store.

const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Returns every non-internal IPv4 the server is reachable on (e.g.
// ['192.168.1.10', '10.0.0.5']). Used at boot to print URLs the admin
// can hand to students on the same LAN.
function lanAddresses() {
    const out = [];
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
        for (const i of ifs[name] || []) {
            if (i.family === 'IPv4' && !i.internal) out.push(i.address);
        }
    }
    return out;
}

const configManager = require('./config/configManager');
const { WorkflowRegistry } = require('./workflows/workflowRegistry');
const { JobQueue } = require('./queue/jobQueue');
const { effectiveComfyConfig, disabledPerfFlags, PERF_FLAG_LABELS } = require('./workers/perfFlags');
const { LaneManager } = require('./lanes/laneManager');
const { BenchmarkService } = require('./benchmark/benchmarkService');
const { AdminCalibrator } = require('./benchmark/adminCalibrator');
const { RealtimeBus } = require('./realtime/realtimeBus');
const { adminGate, accessGate } = require('./auth/authGate');
const adminRoutes = require('./routes/admin');
const accessRoutes = require('./routes/access');
const workflowRoutes = require('./routes/workflows');
const jobRoutes = require('./routes/jobs');
const uploadRoutes = require('./routes/uploads');
const storyboardRoutes = require('./routes/storyboard');
const mediaStore = require('./media/mediaStore');
const federationRoutes = require('./routes/federation');
const { detectSystemInfo } = require('./federation/systemInfo');
const { StatusBeacon } = require('./federation/beacon');
const { ModelDownloader } = require('./models/modelDownloader');
const { ScriptRunner } = require('./maintenance/scriptRunner');
const { Updater } = require('./maintenance/updater');
const { NodePackInstaller } = require('./models/nodePackInstaller');
const { LibrarySweep } = require('./benchmark/librarySweep');

// Prints the URLs students should use from another machine on the LAN.
// They open Vite (5173) in their browser; Vite serves plain HTTP and
// proxies every backend route to this Express server on localhost.
// No certificate, no "unsafe site" warning — works identically on
// Safari, Chrome, and mobile. (Live in-browser webcam preview is the
// one thing plain HTTP can't do off-localhost; the camera button falls
// back to the phone's native camera app via a file picker.)
// Set during student bootstrap when comfy_ui.lan_access is on, holding the
// ComfyUI port. When non-null, logLanUrls() also advertises the raw ComfyUI
// web UI per LAN IP so the banner (and its milestone reprints) shows the
// direct-compute URL the admin asked for. Null → not advertised.
let comfyLanPort = null;

function logLanUrls(serverPort) {
    const ips = lanAddresses();
    if (ips.length === 0) {
        console.log('[ComfyQ] no external network interfaces detected — LAN access unavailable.');
        return;
    }
    console.log('[ComfyQ] LAN access — share one of these URLs with students:');
    for (const ip of ips) {
        console.log(`[ComfyQ]   http://${ip}:5173   (Vite dev server; proxies API + websocket to localhost:${serverPort})`);
    }
    if (comfyLanPort != null) {
        console.log('[ComfyQ] ComfyUI direct access (run classic workflows on this machine\'s GPU):');
        for (const ip of ips) {
            console.log(`[ComfyQ]   http://${ip}:${comfyLanPort}   (native ComfyUI web UI — remote compute)`);
        }
    }
    const fwApps = comfyLanPort != null ? 'Node.js and ComfyUI\'s python.exe' : 'Node.js';
    console.log(`[ComfyQ] If a student gets a connection error, allow ${fwApps} through Windows Firewall for "Private" networks.`);
}

// Wraps logLanUrls() in a visually distinct banner so reprints (after
// ComfyUI's noisy startup) stand out in the terminal. `label` says WHY
// the banner is showing — students don't see this, but the workshop
// admin uses it to confirm each boot milestone has passed.
function printConnectionBanner(label, serverPort) {
    console.log('');
    console.log('==============================================================');
    console.log(`[ComfyQ] ${label}`);
    console.log('==============================================================');
    logLanUrls(serverPort);
    console.log('==============================================================');
    console.log('');
}

// The two boot markers (.boot-student one-shot, .serving standing intent) and
// the boot-mode decision live in one small module so they can be tested
// without starting a server — see servingFlags.js for what each one means.
const {
    markNextBootStudent, consumeStudentBootFlag,
    setServingIntent, isServingIntended, resolveBootMode,
} = require('./config/servingFlags');
const { runPlan } = require('./cloud/podPlan');
const { Heartbeats, DownloadLocks } = require('./cloud/sharedVolume');

// nextMode: 'student' = serve after the restart (and keep serving through
// later ones); 'admin' = stop serving on purpose; omitted = a neutral restart
// that leaves the machine doing whatever it was doing.
function exitForRestart(nextMode) {
    if (nextMode === 'student') { markNextBootStudent(); setServingIntent(true); }
    else if (nextMode === 'admin') setServingIntent(false);
    const willServe = nextMode === 'student' || (nextMode !== 'admin' && isServingIntended());
    console.log(`[ComfyQ] Exiting for restart → ${willServe ? 'student' : 'admin'} mode`);
    // nodemon does NOT auto-restart on a clean exit — it only restarts on a
    // watched-file change. Bumping the mtime of this file makes nodemon's
    // watcher pick up the "change" and re-spawn us. No content edit.
    try {
        const now = new Date();
        fs.utimesSync(__filename, now, now);
    } catch (e) {
        console.warn('[ComfyQ] could not touch index.js to trigger nodemon restart:', e.message);
    }
    setTimeout(() => process.exit(0), 250);
}

async function main() {
    console.log('[ComfyQ] starting…');
    const { config: rawConfig } = configManager.load();

    // Auto-detect ComfyUI on boot when the configured root isn't a real ComfyUI
    // dir (e.g. the workshop drive was cloned to a different letter, or it's a
    // fresh clone). Only runs when the path is missing/invalid, so it never
    // overrides a working config — keeps `npm run dev` working with no manual
    // reconfiguration.
    try {
        const root = rawConfig.comfy_ui?.root_path;
        const rootOk = root && fs.existsSync(path.join(root, 'main.py'));
        if (!rootOk) {
            const detected = configManager.detectComfyPaths();
            if (detected) {
                console.log(`[ComfyQ] Auto-detected ComfyUI at ${detected.root_path}`);
                rawConfig.comfy_ui.root_path = detected.root_path;
                rawConfig.comfy_ui.python_executable = detected.python_executable;
                rawConfig.comfy_ui.output_dir = detected.output_dir;
                rawConfig.comfy_ui.installation_type = detected.installation_type;
                if (detected.assets_dir) { rawConfig.assets = rawConfig.assets || {}; rawConfig.assets.dir = detected.assets_dir; }
                // The scan folders have to follow the drive as well; see
                // configManager.followDriveLetter for why this one is worth care.
                if (Array.isArray(rawConfig.maintenance?.workflowScanDirs)) {
                    rawConfig.maintenance.workflowScanDirs = configManager.followDriveLetter(
                        rawConfig.maintenance.workflowScanDirs, detected.root_path,
                        (m) => console.log(`[ComfyQ] scan folder followed the drive: ${m}`));
                }
                configManager.save(rawConfig);
            } else if (root) {
                console.log(`[ComfyQ] configured ComfyUI root has no main.py (${root}) and none was auto-detected — set it in the admin UI.`);
            }
        }
    } catch (e) {
        console.warn('[ComfyQ] ComfyUI auto-detect failed:', e.message);
    }
    // config.mode persists the *running* mode (so the admin UI reports reality)
    // but never decides the boot. Student mode is entered by /activate-workflow
    // (the one-shot flag) and KEPT across later restarts by the standing
    // serving intent, so a rig that crashes or reboots mid-class comes back
    // serving instead of dropping out of it. Stopping on purpose clears it.
    const oneShotStudent = consumeStudentBootFlag();
    const resumeServing = !oneShotStudent && isServingIntended();
    if (resumeServing) console.log('[ComfyQ] this machine was serving when it last stopped — resuming student mode');
    const bootMode = resolveBootMode(oneShotStudent, resumeServing);
    if (rawConfig.mode !== bootMode) {
        try { configManager.setMode(bootMode); }
        catch (e) { console.warn('[ComfyQ] could not persist boot mode:', e.message); }
        rawConfig.mode = bootMode;
    }
    const config = configManager.resolvePaths(rawConfig);
    console.log(`[ComfyQ] mode=${config.mode}`);

    // Federation (Phase F): detect this machine's identity + hardware once at
    // boot (persisted to config.instance) so the LAN status beacon can report it
    // even when ComfyUI isn't running. Resolved object is shared with the beacon
    // and GET /federation/self via the getSysInfo closure below.
    let sysInfo = null;
    try {
        sysInfo = await detectSystemInfo(configManager);
        console.log(`[ComfyQ] this machine: "${sysInfo.name}"  ${sysInfo.gpu}${sysInfo.vramGb ? ` (${sysInfo.vramGb}GB VRAM)` : ''}  ${sysInfo.ramGb}GB RAM`);
    } catch (e) {
        console.warn('[ComfyQ] system-info detection failed:', e.message);
    }

    const registry = new WorkflowRegistry(config.workflows.dir);
    registry.discover();
    console.log(`[ComfyQ] registry: ${registry.summaries({ includeUnavailable: false }).length} usable workflow(s)`);

    // ★ A cloud machine (RunPod Pod or Thunder instance) about to serve
    //   workflows whose models are not on its disk fetches them first, then
    //   serves: the same plan as a launch with COMFYQ_SERVE. Found 2026-10-20:
    //   a machine whose workflow was activated by an older image (no download
    //   then) kept serving it without its model, every job failing. Not on a
    //   workshop rig: a model with no link would hold it out of serving.
    if (config.mode === 'student' && (process.env.COMFYQ_POD_ID || process.env.RUNPOD_POD_ID)) {
        try {
            const podPlan = require('./cloud/podPlan');
            const serve = [config.workflows.activeWorkflowId, ...(config.workflows.extraLaneWorkflowIds || [])]
                .filter((id, i, all) => id && all.indexOf(id) === i);
            const short = serve.filter(id => {
                const e = registry.get(id);
                return e && !e.unavailable && podPlan.missingModels(e, config.comfy_ui.root_path).some(m => !m.auto);
            });
            if (short.length) {
                const now = new Date().toISOString();
                podPlan.writePlan({ serve, fetchModels: true, createdAt: now, updatedAt: now, files: [], error: null, status: 'pending', from: 'start: models missing' });
                configManager.setMode('admin');
                rawConfig.mode = 'admin';
                config.mode = 'admin';
                console.log(`[ComfyQ] ${short.join(', ')} ${short.length > 1 ? 'are' : 'is'} missing model files on this machine: downloading them before serving`);
            }
        } catch (e) {
            console.warn('[ComfyQ] could not check the models before serving:', e.message);
        }
    }

    const app = express();
    app.use(cors());
    app.use(express.json({ limit: '20mb' }));
    const server = http.createServer(app);

    // Serve the built client when there is one (the Docker image; `npm run dev`
    // has no client/dist and keeps using Vite on :5173). Only the SPA's own
    // page paths fall back to index.html — never a prefix — because `/admin/*`
    // and every other API path belong to Express, and a download link is a
    // browser navigation too (Accept: text/html), so content negotiation
    // cannot tell them apart. Mirrors the bypass in client/vite.config.js.
    const clientDist = path.resolve(__dirname, '../client/dist');
    const clientIndex = path.join(clientDist, 'index.html');
    const servesClient = fs.existsSync(clientIndex);
    if (servesClient) {
        const SPA_PAGES = new Set(['/admin', '/admin/', '/user', '/user/', '/user/dashboard']);
        app.use(express.static(clientDist, { index: 'index.html' }));
        app.get([...SPA_PAGES], (req, res) => res.sendFile(clientIndex));
        console.log(`[ComfyQ] serving the built client from ${clientDist}`);
    }

    const gate = adminGate(configManager);
    // Optional student access password ("who may use this machine at all").
    // No-op unless config.auth.accessPasswordHash is set — see auth/authGate.js.
    const access = accessGate(configManager);

    // Mutable runtime container — populated in student mode below. Lets the
    // admin router expose student-only routes (emergency-stop) without a
    // second router mount.
    const runtime = {};

    // Activity tracker (for the fleet monitor's "users connected" + "last
    // activity" in both modes). Updated on real requests; the federation
    // snapshot polling and the socket.io transport are excluded so passive
    // monitoring / idle connections don't masquerade as activity.
    runtime.activity = { lastTs: Date.now(), clients: new Map() };

    // Model downloads, available in BOTH modes: a rig that is missing a weight
    // needs to fetch it whether or not it is currently serving, and the admin
    // panel stays reachable while serving. Config is read fresh on every use
    // (the same reason AdminCalibrator does), so a path edited in the panel is
    // honoured without a restart.
    // Several Pods on one volume (Phase I): each announces itself in
    // shared/pods/ (the entrypoint exports SHARED; off the volume it is unset
    // and this is a no-op), and a model is downloaded by one Pod while any
    // other that needs it waits for the file.
    runtime.heartbeats = new Heartbeats({
        sharedDir: process.env.SHARED || null,
        info: () => {
            const c = configManager.load().config;
            const lanes = runtime.lanes?.list?.() || [];
            return {
                mode: c.mode,
                serving: lanes.length ? lanes.map(l => l.workflowId) : (c.mode === 'student' && c.workflows.activeWorkflowId ? [c.workflows.activeWorkflowId] : []),
                image: process.env.COMFYQ_IMAGE_SHA || null,
            };
        },
    }).start();
    runtime.downloader = new ModelDownloader({
        config: () => configManager.load().config,
        locks: new DownloadLocks({ isAlive: (id) => runtime.heartbeats.isAlive(id) }),
    });

    // The maintenance scripts (tools/maintenance), runnable from the panel
    // instead of a console.
    runtime.scripts = new ScriptRunner({
        config: () => configManager.load().config,
    });

    // Node packs, installed from here by git clone rather than through
    // ComfyUI-Manager's own interface.
    runtime.packs = new NodePackInstaller({
        config: () => configManager.load().config,
    });

    // Updating ComfyUI and each node pack. Reads the mode lazily, because an
    // update needs a ComfyUI restart to take effect and must refuse while the
    // rig is serving a class.
    runtime.updater = new Updater({
        config: () => configManager.load().config,
        mode: () => configManager.load().config.mode,
    });

    // Run every workflow once and record what each produced, plus which
    // weights ComfyUI actually opened. Reads the calibrator and the mode
    // lazily: the backend is created later in admin boot, and the mode can
    // change under it, and the sweep must refuse while the rig is serving.
    runtime.sweep = new LibrarySweep({
        registry,
        calibrator: () => runtime.comfyBackend || null,
        config: () => configManager.load().config,
        mode: () => configManager.load().config.mode,
    });
    app.use((req, res, next) => {
        const p = req.path || '';
        if (!p.startsWith('/federation') && !p.startsWith('/socket.io')) {
            runtime.activity.lastTs = Date.now();
            const ip = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
            if (ip) runtime.activity.clients.set(ip, Date.now());
        }
        next();
    });

    // Routes available in both modes.
    // Ungated on purpose: this is how a client finds out whether it needs a
    // password, and where it exchanges that password for a token.
    app.use('/access', accessRoutes.makeRouter({ configManager }));
    app.use('/admin', adminRoutes.makeRouter({
        configManager, registry, adminGate: gate, exitForRestart, runtime
    }));
    // Federation status (read-only; same snapshot the beacon multicasts).
    app.use('/federation', federationRoutes.makeRouter({
        configManager, registry, runtime, getSysInfo: () => sysInfo
    }));
    // Storyboard batches — upload one markdown document, queue every generation
    // it describes (images, then the videos that consume them, then audio).
    // Mounted in BOTH modes: the document names its own workflows, so in admin
    // mode it writes the batch straight to the queue file and then switches the
    // machine to student mode serving the batch's first workflow, which is what
    // starts the executor draining it. `runtime` is shared by reference, so in
    // student mode it picks up the live queue/executor instead.
    app.use('/storyboard', access, storyboardRoutes.makeRouter({
        configManager, registry, runtime, adminGate: gate, exitForRestart
    }));
    // ★ Media serving in BOTH modes. It used to be mounted only in the student
    // block, so /images 404'd in admin mode — which is precisely the mode you are
    // in while reading a library sweep, so the sweep card could describe a result
    // it could not show. It is read-only, scoped to the output and temp dirs by
    // _resolveSafe, and deliberately ungated already (an <img> cannot send a
    // header, and these URLs are only discoverable through the gated socket).
    app.use(mediaStore.makeRouter(config.comfy_ui));

    if (config.mode === 'admin') {
        // Calibration from the admin panel works by lazily spawning (or
        // attaching to) ComfyUI on the first calibrate request — no need to
        // flip to student mode first. The worker is reused across calibrations
        // and left running on shutdown so a later activate attaches to it.
        const adminCalibrator = new AdminCalibrator({
            configManager,
            registry,
            onMilestone: (label) => printConnectionBanner(label, config.server.port)
        });
        // Expose the calibrator's ComfyUI manager to the (already-mounted) admin
        // router so the "Launch ComfyUI backend" button can spawn a network-bound
        // instance. The router closure shares this `runtime` object by reference.
        runtime.comfyBackend = adminCalibrator;
        app.use('/workflows', workflowRoutes.makeRouter({
            registry, configManager, benchmarkService: adminCalibrator, adminGate: gate
        }));
        // LAN status beacon — runs in admin mode too so idle rigs (nothing
        // launched) still appear in the fleet monitor.
        const beacon = new StatusBeacon({ configManager, registry, runtime, sysInfo });
        beacon.start();
        runtime.beacon = beacon;     // so the admin toggle can kick an immediate beacon

        // Start the ComfyUI backend by default (network-bound) so an idle rig is
        // already "engine on" and ready — and shows as such in the fleet monitor.
        // Non-blocking: the admin UI is reachable immediately while ComfyUI warms
        // up. Reuses/attaches to an existing instance if one is already running.
        if (config.comfy_ui.autoStart !== false && config.comfy_ui.root_path && config.comfy_ui.python_executable) {
            adminCalibrator.launchBackend()
                .then(() => console.log('[ComfyQ] ComfyUI backend started (admin default)'))
                .catch(e => console.warn('[ComfyQ] could not auto-start ComfyUI backend:', e.message));
        }
        const port = config.server.port;
        const host = config.server.host;
        server.listen(port, host, () => {
            console.log(`[ComfyQ] admin mode — API on http://${host}:${port}  •  open the UI at http://localhost:${servesClient ? port : 5173}`);
            logLanUrls(port);
            console.log('[ComfyQ] open the admin UI to configure ComfyUI and pick a workflow.');
            // A Pod started with COMFYQ_SERVE: fetch the models, then serve.
            // Runs with the API already up so GET /admin/pod-plan can report
            // progress. A no-op unless the entrypoint wrote a pending plan.
            runPlan({ configManager, registry, downloader: runtime.downloader, exitForRestart })
                .catch(e => console.error('[pod-plan] failed:', e.message));
        });
        process.on('SIGINT', async () => {
            console.log('[ComfyQ] shutting down (admin mode)…');
            try { beacon.stop(); } catch { /* ignore */ }
            try { await adminCalibrator.shutdown(); } catch { /* ignore */ }
            process.exit(0);
        });
        return;
    }

    // ---- Student mode ----
    console.log('[ComfyQ] === student-mode bootstrap ===');
    console.log(`[ComfyQ]   active workflow: ${config.workflows.activeWorkflowId || '(none)'}`);
    console.log(`[ComfyQ]   ComfyUI root:    ${config.comfy_ui.root_path}`);
    console.log(`[ComfyQ]   ComfyUI api:     http://${config.comfy_ui.api_host}:${config.comfy_ui.api_port}`);
    console.log(`[ComfyQ]   ComfyUI LAN:     ${config.comfy_ui.lan_access ? `bound to 0.0.0.0 — reachable on the network at :${config.comfy_ui.api_port}` : 'loopback only (lan_access off)'}`);
    console.log(`[ComfyQ]   Python:          ${config.comfy_ui.python_executable}`);
    console.log(`[ComfyQ]   VRAM budget:     ${config.comfy_ui.vramBudgetGb} GB`);

    // Advertise the raw ComfyUI web UI in the LAN-URL banner(s) when enabled.
    if (config.comfy_ui.lan_access) comfyLanPort = config.comfy_ui.api_port;

    if (!config.comfy_ui.root_path || !config.comfy_ui.python_executable) {
        console.error('[ComfyQ] ComfyUI paths are not configured. Switching to admin mode.');
        configManager.update(c => { c.mode = 'admin'; return c; });
        // 'admin' clears the serving intent: a machine that cannot serve must
        // settle in admin, not restart into student mode over and over.
        return exitForRestart('admin');
    }

    console.log('[ComfyQ] opening sqlite job queue…');
    const queue = new JobQueue(config.queue.dbPath);
    const reconciled = queue.reconcileOnBoot();
    if (reconciled > 0) console.log(`[ComfyQ] reconciled ${reconciled} stale job(s) → failed: server-restart`);
    else console.log('[ComfyQ] no stale jobs to reconcile');

    console.log('[ComfyQ] starting ComfyUI worker…');
    // Reprints the LAN-URL banner at key boot milestones (WS connect,
    // comfyregistry fetch complete) so the URLs aren't buried in
    // ComfyUI's startup output. Resolved with config.server.port so the
    // banner shows the same backend port the boot-time banner did.
    const onMilestone = (label) => printConnectionBanner(label, config.server.port);
    // Serve the active workflow with the ComfyUI flags it can actually run with:
    // a bundle that lists `requirements.disabledPerfFlags` (e.g. Qwen-Image-Edit
    // under Sage attention) would otherwise save black images.
    const activeMeta = config.workflows.activeWorkflowId
        ? registry.get(config.workflows.activeWorkflowId)?.meta : null;
    if (effectiveComfyConfig(config.comfy_ui, activeMeta) !== config.comfy_ui) {
        const off = disabledPerfFlags(activeMeta).filter(k => config.comfy_ui[k]).map(k => PERF_FLAG_LABELS[k]);
        console.log(`[ComfyQ]   perf flags:      ${off.join(' + ')} OFF for this workflow (it can't run with ${off.length > 1 ? 'them' : 'it'})`);
    }
    // Lanes. A lane is a workflow + the ComfyUI running it + the executor
    // feeding it; several can run at once on one GPU so a class can use two
    // models in parallel instead of the machine being switched over. The first
    // lane uses the configured port and the install's own directories, so a
    // single-lane machine behaves exactly as it always has.
    const lanes = new LaneManager({
        queue, registry, configManager,
        onMilestone,
        onChange: () => { try { runtime.bus?.broadcast(); } catch { /* bus not up yet */ } },
        // Sage attention is an opt-in global speed-up that only supports certain
        // attention head dimensions. One incompatible model would otherwise take
        // down every remaining job that uses it, so the flag is turned off for
        // good, ComfyUI comes back without it, and the job is retried.
        onSageIncompatible: async (laneWorker) => {
            const ok = await laneWorker.restartWithoutSageAttention();
            if (!ok) return false;
            try {
                configManager.update(c => { c.comfy_ui.use_sage_attention = false; return c; });
                console.log('[ComfyQ] "Use Sage attention" turned OFF — a model in this queue cannot run with it.');
                console.log('[ComfyQ]   Re-enable it under Admin → ComfyUI backend → Performance if you want it back.');
            } catch (e) {
                console.warn('[ComfyQ] could not persist the sage-attention change:', e.message);
            }
            try { runtime.bus?.broadcast(); } catch { /* bus not up yet */ }
            return true;
        },
    });
    runtime.lanes = lanes;

    // A restart mid-class (nodemon, an admin relaunch, a Windows update) can
    // land while the previous ComfyUI is still dying or still loading: the port
    // is taken, so our spawn can't bind and the API never answers. Dropping to
    // admin mode there takes the machine OUT OF SERVICE silently — every open
    // student tab keeps reconnecting to a server that no longer schedules — so
    // LaneManager retries before giving up. Only a repeated failure (bad paths,
    // broken install) flips the mode.
    try {
        await lanes.open(config.workflows.activeWorkflowId, { primary: true });
    } catch (e) {
        console.error('[ComfyQ] ComfyUI would not start after several attempts — reverting to admin mode:', e.message);
        configManager.update(c => { c.mode = 'admin'; return c; });
        return exitForRestart('admin');   // stop resuming — see above
    }
    // Bring back any extra lanes this machine was serving before it restarted,
    // so a nodemon reload or a crash doesn't quietly drop a class to one model.
    // Done after the primary lane so the first workflow is servable as early as
    // possible; failures are logged and forgotten rather than fatal.
    lanes.restoreRemembered().catch(e => console.warn('[ComfyQ] lane restore failed:', e.message));

    const primaryLane = lanes.get(config.workflows.activeWorkflowId);
    // The primary lane's worker/executor stand in wherever the rest of the
    // server still expects exactly one of each (calibration, emergency stop,
    // the fleet snapshot).
    const worker = primaryLane.worker;
    const executor = primaryLane.executor;
    console.log('[ComfyQ] executor loop started');

    const benchmarkService = new BenchmarkService({ worker, registry, comfyConfig: config.comfy_ui, assetsDir: config.assets?.dir || '', lanes });

    const bus = new RealtimeBus({ httpServer: server, queue, executor, registry, configManager, worker, lanes, comfyConfig: config.comfy_ui, activity: runtime.activity });
    runtime.bus = bus;     // fleet snapshot reads connected-user count from here

    // Expose student-mode runtime to the admin router (emergency-stop) and the
    // federation snapshot (queue + worker liveness).
    runtime.queue = queue;
    runtime.executor = executor;
    runtime.worker = worker;

    // LAN status beacon — now that the queue/worker are live, snapshots include
    // the active workflow + planned/running jobs.
    const beacon = new StatusBeacon({ configManager, registry, runtime, sysInfo });
    beacon.start();
    runtime.beacon = beacon;     // so the admin toggle can kick an immediate beacon

    // Mount remaining routes.
    app.use('/workflows', workflowRoutes.makeRouter({
        registry, configManager, benchmarkService, adminGate: gate
    }));
    // `access` is a no-op on an open machine. On a locked one it blocks the
    // routes that let someone *use* the rig — staging inputs and reading the
    // job list — alongside the socket handshake gate in the realtime bus.
    // Media serving (/images, /download) stays open: those URLs are only
    // discoverable through the gated socket, and gating them would break
    // <img>/<video> tags, which can't send an auth header.
    app.use('/jobs', access, jobRoutes.makeRouter({ queue, comfyConfig: config.comfy_ui, registry }));
    app.use(access, uploadRoutes.makeRouter({ comfyConfig: config.comfy_ui }));
    // (media serving is mounted earlier, for both modes — see the note there)

    // Periodic input dir sweep.
    setInterval(() => worker.uploader.sweepStale(), 60_000);

    const port = config.server.port;
    const host = config.server.host;
    server.listen(port, host, () => {
        console.log(`[ComfyQ] student mode — API on http://${host}:${port}  •  open the UI at http://localhost:${servesClient ? port : 5173}`);
        logLanUrls(port);
        const active = config.workflows.activeWorkflowId;
        if (!active) {
            console.warn('[ComfyQ] no active workflow set; clients will see an empty parameter map.');
        } else {
            const entry = registry.get(active);
            if (entry && !entry.unavailable) {
                const exposed = entry.effective?.exposedParameters?.length ?? 0;
                const dur = entry.summary?.estimatedDurationSec ?? '?';
                const cal = entry.summary?.hasCalibration ? 'calibrated' : 'uncalibrated';
                console.log(`[ComfyQ] active workflow: ${active}  "${entry.summary?.name}"  (${exposed} params, ~${dur}s ${cal})`);
            } else {
                console.warn(`[ComfyQ] active workflow "${active}" is unavailable: ${entry?.reason || 'unknown'}`);
            }
        }
        console.log('[ComfyQ] === ready ===');
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
        console.log('[ComfyQ] shutting down…');
        try { beacon.stop(); } catch { /* ignore */ }
        executor.stop();
        await worker.shutdown();
        queue.close();
        process.exit(0);
    });
}

main().catch(e => {
    console.error('[ComfyQ] fatal:', e);
    process.exit(1);
});
