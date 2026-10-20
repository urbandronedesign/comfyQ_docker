const fs = require('fs');
const { Server } = require('socket.io');
const sm = require('../queue/jobStateMachine');
const { isAuthorizedForJob, isAccessLocked, verifyAccessToken } = require('../auth/authGate');
const { resolveOutputPath } = require('../executor/outputCollector');
const ingredientsStore = require('../storage/ingredientsStore');
const { listModelFiles, prettyModelLabel } = require('../workflows/modelOptions');

const HEARTBEAT_MS = 5000;
// Progress arrives once per sampler step — or per tile / frame on some nodes —
// and every tick used to push the whole job list to every client. Changes are
// now merged into at most one broadcast per interval.
const BROADCAST_MIN_INTERVAL_MS = 250;
// Jobs carried in a full snapshot: the most recent ones.
const BROADCAST_JOB_LIMIT = 500;
// A progress tick changes ONE job, but the snapshot holding it grows with the
// day's history (a few hundred KB after a workshop) and lands every ~250 ms on
// every open tab — which is what made several tabs lag and the fleet feel slow.
// So a change is normally sent as a patch (`state_patch`) carrying only the
// jobs that differ. A full `state_update` is still sent on connect, on request,
// when most of the list changed, and every FULL_RESYNC_MS as a self-heal.
const FULL_RESYNC_MS = 60000;
// Past this many changed jobs the patch stops being a saving; send the snapshot.
const PATCH_MAX_JOBS = 60;

// RealtimeBus — broadcasts state to clients and translates socket events into
// queue / executor actions. Wire format kept compatible with the v1 client:
//
// emit('state_update', {
//   system_status: 'starting' | 'idle' | 'busy' | 'down' | 'ready',
//   benchmark_ms,                              // active workflow's estimatedDurationSec * 1000
//   connected_users: [{ socketId, userId }],
//   jobs: [{ id, user_id, status, phase, time_slot, started_at, finished_at,
//            prompt, params, result_filename, outputs,
//            progress: { value, max } | null,
//            current_node, workflow_id, error_reason }],
//   workflow: { parameter_map },               // for active workflow
//   workflow_info: { id, name, description, category, promptGuides,
//                    samplesPerSec, estimatedDurationSec },  // for ETA + ProgressViz
//   seq                                        // sequence of this send
// })
//
// and the incremental form, which is what a running job actually produces:
//
// emit('state_patch', {
//   seq,                                       // must be the previous seq + 1
//   jobs: [ ...only the jobs that changed ],   // absent when none did
//   removed_jobs: [ ...ids no longer sent ],   // absent when none went
//   ...any changed top-level field (system_status, connected_users, workflow, …)
// })
//
// Inbound events:
//   register_user(name)
//   request_state()              resend the full snapshot to this socket
//   book_job({ scheduledTime, prompt, params, user_id, workflow_id?, admin_password? })
//   delete_job(jobId)            with optional admin_password
//   reorder_job({ jobId, newTimeSlot })
//   cancel_job(jobId)            with optional admin_password
class RealtimeBus {
    constructor({ httpServer, queue, executor, registry, configManager, worker, lanes = null, comfyConfig, activity }) {
        this.queue = queue;
        this.executor = executor;
        this.registry = registry;
        this.configManager = configManager;
        this.worker = worker;
        // Every workflow this machine is serving right now. `workflow` and
        // `workflow_info` below stay pointed at the first lane, so a client
        // that knows nothing about lanes keeps working unchanged.
        this.lanes = lanes;
        this.comfyConfig = comfyConfig;
        // Shared activity tracker (see server/index.js) — bumped on real user
        // interactions so the fleet monitor's "last activity" reflects bookings /
        // running jobs, not just HTTP traffic.
        this.activity = activity || { lastTs: Date.now(), clients: new Map() };
        this.connectedUsers = new Map();
        this._broadcastTimer = null;
        this._lastBroadcastAt = 0;
        // What everyone has already been sent, so a broadcast can carry just the
        // difference (and send nothing at all when there is none).
        this._sentJobs = new Map();   // job id -> its serialized wire form
        this._sentHead = {};          // top-level field -> its serialized value
        this._seq = 0;                // bumped per send; clients detect a gap
        this._lastFullAt = 0;

        this.io = new Server(httpServer, {
            cors: { origin: '*', methods: ['GET', 'POST'] }
        });
        this._wireAccessGate();
        this._wireEvents();

        // Broadcast on queue / worker change. A queue change (job booked,
        // progressing, finishing) counts as server activity.
        queue.onChange(() => { this._bumpActivity(); this.broadcast(); });
        worker.on('status', () => this.broadcast());
        executor.onChange(() => this.broadcast());
        setInterval(() => this.broadcast(), HEARTBEAT_MS);
    }

    _bumpActivity() { if (this.activity) this.activity.lastTs = Date.now(); }

    // Access gate — when the admin has set a student access password, a socket
    // must present the token issued by POST /access/login (client stores it and
    // replays it in the handshake). An open machine accepts everyone, exactly
    // as before. Rejected handshakes get a recognisable message so the client
    // can drop its stale token and re-prompt instead of retrying forever.
    _wireAccessGate() {
        this.io.use((socket, next) => {
            if (!isAccessLocked(this.configManager)) return next();
            const token = socket.handshake?.auth?.accessToken
                || socket.handshake?.query?.access_token
                || '';
            if (!verifyAccessToken(token, this.configManager)) {
                const err = new Error('access password required');
                err.data = { accessRequired: true };
                return next(err);
            }
            socket.data.accessToken = token;   // re-checked if the password changes
            next();
        });
    }

    // Re-verify every live socket against the CURRENT access password and kick
    // the ones that no longer pass. Called after the admin sets or changes the
    // password so locking a machine takes effect immediately.
    enforceAccess() {
        if (!isAccessLocked(this.configManager)) return 0;
        let dropped = 0;
        for (const socket of this.io.sockets.sockets.values()) {
            if (verifyAccessToken(socket.data?.accessToken, this.configManager)) continue;
            socket.emit('access_revoked', { message: 'This machine now requires an access password.' });
            socket.disconnect(true);
            dropped++;
        }
        if (dropped) console.log(`[Bus] access password changed — disconnected ${dropped} socket(s)`);
        return dropped;
    }

    _wireEvents() {
        this.io.on('connection', (socket) => {
            const guestId = `Guest-${socket.id.substring(0, 4)}`;
            this.connectedUsers.set(socket.id, { socketId: socket.id, userId: guestId });
            this._bumpActivity();
            // The newcomer gets the full state right away; everyone else only
            // needs the new user count, which the merged broadcast carries.
            try { this._emitFull(socket); }
            catch (e) { console.error('[RealtimeBus] initial state err:', e); }
            this.broadcast();

            // A client that sees a gap in the patch sequence (only possible
            // across a reconnect) asks for the whole state rather than showing a
            // list with holes in it.
            // Throttled: building the snapshot costs a query over the whole
            // history, and a client only ever needs one per gap.
            let lastResync = 0;
            socket.on('request_state', () => {
                if (Date.now() - lastResync < 2000) return;
                lastResync = Date.now();
                try { this._emitFull(socket); }
                catch (e) { console.error('[RealtimeBus] resync err:', e); }
            });

            socket.on('register_user', (name) => {
                if (!name) return;
                const u = this.connectedUsers.get(socket.id);
                if (u) { u.userId = String(name); this.connectedUsers.set(socket.id, u); }
                this.broadcast();
            });

            socket.on('book_job', (payload, ack) => {
                try {
                    const { scheduledTime, prompt, params = {}, user_id, workflow_id } = payload || {};
                    const me = this.connectedUsers.get(socket.id);
                    const userId = user_id || me?.userId || 'anon';
                    const cfg = this.configManager.load().config;
                    const wfId = workflow_id || cfg.workflows.activeWorkflowId;
                    if (!wfId) throw new Error('No active workflow configured');
                    const entry = this.registry.get(wfId);
                    if (!entry || entry.unavailable) throw new Error(`Workflow unavailable: ${entry?.reason || wfId}`);
                    // Each lane's executor only claims its own workflow's jobs,
                    // so booking one nobody serves would leave the job waiting
                    // for ever. Refuse it while the student can still see why.
                    const served = this.lanes?.servedWorkflowIds?.() || [];
                    if (served.length && !served.includes(wfId)) {
                        throw new Error(`“${entry.summary?.name || wfId}” is not being served on this machine right now.`);
                    }

                    const duration = (entry.summary?.estimatedDurationSec || entry.meta.estimatedDurationSec) * 1000;
                    // No slot picked (or a stale/past time) → run ASAP: drop the
                    // job into the earliest free slot after whatever's pending,
                    // instead of rejecting it on a collision. An explicit future
                    // slot still gets the normal collision guard.
                    let scheduledAt = scheduledTime;
                    if (!scheduledAt || scheduledAt < Date.now()) {
                        scheduledAt = this.queue.nextFreeSlot(Date.now(), duration, wfId);
                    } else {
                        const collisions = this.queue.findCollisions(scheduledAt, duration, null, wfId);
                        if (collisions.length > 0) throw new Error('Time slot collision detected');
                    }

                    // Stitch prompt into paramValues so the worker materializer
                    // doesn't have to special-case it. If a parameter exists
                    // with type 'textarea' and the workflow's first prompt
                    // node, set its value; otherwise put 'prompt' in params.
                    const paramValues = { ...params };
                    if (prompt && !paramValues.prompt) paramValues.prompt = prompt;
                    // Map paramValues['prompt'] to the first textarea-type
                    // exposed parameter if no key matches a textarea param.
                    const textParam = entry.effective.exposedParameters
                        .find(p => p.type === 'textarea' && (p.field === 'text' || p.field.includes('prompt')));
                    if (prompt && textParam && paramValues[textParam.key] == null) {
                        paramValues[textParam.key] = prompt;
                    }

                    const job = this.queue.insert({
                        userId,
                        workflowId: wfId,
                        workflowVersion: entry.meta.version,
                        scheduledAt,
                        prompt: prompt || '',
                        paramValues,
                        createdBy: socket.id
                    });
                    if (typeof ack === 'function') ack({ ok: true, jobId: job.id });
                } catch (e) {
                    // A client that asked for an ack shows the refusal in its
                    // booking form; the error event is for older clients.
                    if (typeof ack === 'function') ack({ ok: false, error: e.message });
                    else socket.emit('error', { message: e.message });
                }
            });

            socket.on('delete_job', (payload) => {
                try {
                    const jobId = typeof payload === 'string' ? payload : payload?.jobId;
                    const adminPassword = typeof payload === 'object' ? payload?.admin_password : null;
                    const job = this.queue.get(jobId);
                    if (!job) return;
                    const me = this.connectedUsers.get(socket.id);
                    const auth = isAuthorizedForJob({
                        socketUserId: me?.userId, providedPassword: adminPassword,
                        job, configManager: this.configManager
                    });
                    if (!auth.allowed) return socket.emit('error', { message: auth.reason });
                    // Refuse to delete a finished job whose output another
                    // queued job is still waiting to consume — that is a
                    // storyboard's frame, and removing it would collapse the
                    // rest of the batch.
                    const needed = this.queue.neededBy(jobId);
                    if (needed.length > 0) {
                        return socket.emit('error', {
                            message: `${needed.length} queued job(s) still need this result as their input. ` +
                                'Cancel those first, or remove the whole batch.'
                        });
                    }
                    if (sm.isInFlight(job.status) || job.status === sm.STATES.SCHEDULED) {
                        // Try cancelling first if executing; otherwise just remove.
                        if (sm.isInFlight(job.status)) this.executor.cancelJob(jobId);
                        else this.queue.transitionStatus(jobId, sm.STATES.CANCELLED);
                    }
                    this._deleteOutputFiles(job);
                    this.queue.delete(jobId);
                } catch (e) {
                    socket.emit('error', { message: e.message });
                }
            });

            socket.on('cancel_job', (payload) => {
                try {
                    const jobId = typeof payload === 'string' ? payload : payload?.jobId;
                    const adminPassword = typeof payload === 'object' ? payload?.admin_password : null;
                    const job = this.queue.get(jobId);
                    if (!job) return;
                    const me = this.connectedUsers.get(socket.id);
                    const auth = isAuthorizedForJob({
                        socketUserId: me?.userId, providedPassword: adminPassword,
                        job, configManager: this.configManager
                    });
                    if (!auth.allowed) return socket.emit('error', { message: auth.reason });
                    this.executor.cancelJob(jobId);
                } catch (e) {
                    socket.emit('error', { message: e.message });
                }
            });

            socket.on('reorder_job', (payload) => {
                try {
                    const { jobId, newTimeSlot, admin_password } = payload || {};
                    const job = this.queue.get(jobId);
                    if (!job) return;
                    const me = this.connectedUsers.get(socket.id);
                    const auth = isAuthorizedForJob({
                        socketUserId: me?.userId, providedPassword: admin_password,
                        job, configManager: this.configManager
                    });
                    if (!auth.allowed) return socket.emit('error', { message: auth.reason });
                    const cfg = this.configManager.load().config;
                    const entry = this.registry.get(job.workflowId);
                    const duration = ((entry?.summary?.estimatedDurationSec) || 60) * 1000;
                    const collisions = this.queue.findCollisions(newTimeSlot, duration, jobId, job.workflowId);
                    if (collisions.length > 0) return socket.emit('error', { message: 'Time slot collision' });
                    this.queue.reorder(jobId, newTimeSlot);
                } catch (e) {
                    socket.emit('error', { message: e.message });
                }
            });

            socket.on('disconnect', () => {
                this.connectedUsers.delete(socket.id);
                this.broadcast();
            });
        });
    }

    // Best-effort deletion of any output files this job produced. Missing files
    // are ignored so a partially-cleaned-up job can still be removed.
    _deleteOutputFiles(job) {
        const outputs = job?.outputs || [];
        for (const o of outputs) {
            try {
                const abs = resolveOutputPath(o, this.comfyConfig);
                if (abs && fs.existsSync(abs)) fs.unlinkSync(abs);
            } catch (e) {
                console.warn(`[RealtimeBus] Could not delete output ${o.filename}:`, e.message);
            }
        }
    }

    _toWireJob(job) {
        const progress = (job.progress?.stepsDone != null && job.progress?.stepsTotal != null)
            ? { value: job.progress.stepsDone, max: job.progress.stepsTotal }
            : null;
        // Thumbnail filename for grid/sidebar cards. Prefer an image, then a
        // GLB mesh (renders in the inline ModelViewer), then anything. The GLB
        // preference is extension-based (not kind === 'model3d') so a splat
        // `.ply` never becomes the thumbnail — the client has no inline .ply/.spz
        // renderer; splats are viewed in the lightbox gallery only.
        const firstImage = job.outputs?.find(o => o.kind === 'image');
        const firstGlb = job.outputs?.find(o => /\.(glb|gltf)$/i.test(o.filename || ''));
        const firstAny = job.outputs?.[0];
        const resultFilename = (firstImage || firstGlb || firstAny)?.filename || null;
        return {
            id: job.id,
            user_id: job.userId,
            status: sm.toWireStatus(job.status),
            phase: job.status,
            time_slot: job.scheduledAt,
            // Actual run timing: started_at = executor pickup (uploading-inputs),
            // finished_at = terminal state. The client shows finished−started as
            // the real generation time on every job card, for any workflow type.
            started_at: job.startedAt,
            finished_at: job.finishedAt,
            prompt: job.prompt,
            params: job.paramValues,
            input_files: ingredientsStore.mediaRefs(job).map(m => ({ param: m.param, name: m.original })),
            result_filename: resultFilename,
            outputs: job.outputs || [],
            progress,
            current_node: job.currentNode,
            batch_id: job.batchId,
            batch_label: job.batchLabel,
            workflow_id: job.workflowId,
            error_reason: job.errorReason
        };
    }

    // Ask for a state_update. Calls in a burst (a status transition, then the
    // executor's notify, then a progress tick) collapse into one send, spaced
    // at least BROADCAST_MIN_INTERVAL_MS apart.
    broadcast() {
        if (this._broadcastTimer) return;
        const wait = Math.max(0, this._lastBroadcastAt + BROADCAST_MIN_INTERVAL_MS - Date.now());
        this._broadcastTimer = setTimeout(() => {
            this._broadcastTimer = null;
            this._lastBroadcastAt = Date.now();
            this._emitState();
        }, wait);
    }

    // Send what changed since the last broadcast — nothing at all when the state
    // is identical (so the 5 s heartbeat costs an idle client nothing), a patch
    // when a few jobs moved (the progress-tick case), a full snapshot when most
    // of the list changed or the periodic resync is due.
    _emitState() {
        try {
            const state = this._buildState();
            const { jobs, ...head } = state;
            const jobsJson = new Map();
            for (const j of jobs) jobsJson.set(j.id, JSON.stringify(j));

            // Per-field, so a student connecting doesn't re-send the whole
            // parameter_map to every tab along with the new user count.
            const headJson = {};
            const changedHead = {};
            for (const [k, v] of Object.entries(head)) {
                headJson[k] = JSON.stringify(v);
                if (headJson[k] !== this._sentHead[k]) changedHead[k] = v;
            }
            const changed = jobs.filter(j => jobsJson.get(j.id) !== this._sentJobs.get(j.id));
            const removed = [];
            for (const id of this._sentJobs.keys()) if (!jobsJson.has(id)) removed.push(id);
            const headKeys = Object.keys(changedHead);
            if (!headKeys.length && !changed.length && !removed.length) return;

            this._sentHead = headJson;
            this._sentJobs = jobsJson;
            this._seq++;

            if (changed.length > PATCH_MAX_JOBS || Date.now() - this._lastFullAt > FULL_RESYNC_MS) {
                this._emitFull(this.io, state);
                return;
            }
            const patch = { seq: this._seq, ...changedHead };
            if (changed.length) patch.jobs = changed;
            if (removed.length) patch.removed_jobs = removed;
            this.io.emit('state_patch', patch);
        } catch (e) {
            console.error('[RealtimeBus] broadcast err:', e);
        }
    }

    // A full snapshot, stamped with the current sequence so the receiver knows
    // which patch comes next. `target` is io (everyone) or one socket.
    _emitFull(target, state = null) {
        const full = state || this._buildState();
        if (target === this.io) this._lastFullAt = Date.now();
        target.emit('state_update', { ...full, seq: this._seq });
    }

    _buildState() {
        const cfg = this.configManager.load().config;
        const activeId = cfg.workflows.activeWorkflowId;
        const entry = activeId ? this.registry.get(activeId) : null;
        const parameter_map = entry && !entry.unavailable
            ? this._buildParameterMap(entry.effective.exposedParameters, cfg.comfy_ui?.root_path)
            : {};
        const workflow_info = entry && !entry.unavailable ? {
            id: entry.id,
            name: entry.summary.name,
            description: entry.summary.description,
            category: entry.summary.category,
            promptGuides: entry.summary.promptGuides || [],
            samplesPerSec: entry.summary.samplesPerSec,
            estimatedDurationSec: entry.summary.estimatedDurationSec
        } : { id: null, name: 'No workflow configured', description: '', category: 'other', promptGuides: [], samplesPerSec: null, estimatedDurationSec: null };
        const benchmarkMs = entry && !entry.unavailable
            ? (entry.summary.estimatedDurationSec * 1000) : 60000;
        const workerStatus = this.worker.getStatus();
        const systemStatus = workerStatus.state === 'idle' || workerStatus.state === 'busy' ? 'ready' : workerStatus.state;
        const jobs = this.queue.listRecent(BROADCAST_JOB_LIMIT).map(j => this._toWireJob(j));
        // One entry per workflow the machine is serving in parallel. Each
        // carries everything a booking form needs, so a student can choose
        // which model to book without the machine switching over.
        const lanes = (this.lanes?.list() || []).map(l => {
            const entry = this.registry.get(l.workflowId);
            const usable = entry && !entry.unavailable;
            return {
                workflow_id: l.workflowId,
                name: l.name,
                port: l.port,
                primary: l.primary,
                state: l.state,
                busy: l.busy,
                vram_gb: l.vramGb,
                description: usable ? entry.summary.description : '',
                category: usable ? entry.summary.category : 'other',
                promptGuides: usable ? (entry.summary.promptGuides || []) : [],
                estimatedDurationSec: usable ? entry.summary.estimatedDurationSec : null,
                samplesPerSec: usable ? entry.summary.samplesPerSec : null,
                parameter_map: usable
                    ? this._buildParameterMap(entry.effective.exposedParameters, cfg.comfy_ui?.root_path)
                    : {},
            };
        });
        return {
            system_status: systemStatus,
            benchmark_ms: benchmarkMs,
            connected_users: Array.from(this.connectedUsers.values()),
            jobs,
            workflow: { parameter_map },
            workflow_info,
            lanes
        };
    }

    _buildParameterMap(exposed, comfyRoot) {
        const out = {};
        for (const p of exposed) {
            if (p.enabled === false) continue;
            const entry = {
                node_id: p.nodeId,
                field: p.field,
                type: p.type,
                label: p.label,
                default: p.default,
                enabled: true,
                order: p.order,
                options: p.options,
                min: p.min,
                max: p.max,
                step: p.step,
                maxInputEdge: p.maxInputEdge,
                disabledWhen: p.disabledWhen,
                format: p.format,
                camera: p.camera,
                required: p.required
            };
            // A `lora` param's dropdown is filled at broadcast time by scanning
            // ComfyUI's model dir, filtered to a family by `optionsFilter`. We
            // also send prettified labels (extension stripped). If the scan
            // finds nothing (dir missing off-rig), keep the default selectable
            // so the field never renders empty.
            if (p.type === 'lora') {
                let files = listModelFiles(comfyRoot, p.optionsDir || 'loras', p.optionsFilter || '');
                if (!files.length && p.default) files = [p.default];
                else if (p.default && !files.includes(p.default)) files = [p.default, ...files];
                entry.options = files;
                // Show a linked trigger word next to the LoRA it belongs to.
                const hints = (p.linkedValues || []).find(l => l.map && Object.values(l.map).some(v => typeof v === 'string' && v));
                entry.optionLabels = files.map(f => {
                    const hint = hints && typeof hints.map[f] === 'string' && hints.map[f] ? ` — ${hints.map[f]}` : '';
                    return prettyModelLabel(f) + hint;
                });
            }
            out[p.key] = entry;
        }
        return out;
    }
}

module.exports = { RealtimeBus };
