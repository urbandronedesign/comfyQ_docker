const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const sm = require('./jobStateMachine');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    workflow_version TEXT,
    status TEXT NOT NULL,
    scheduled_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    prompt_id TEXT,
    prompt TEXT,
    param_values TEXT NOT NULL,
    input_files TEXT NOT NULL,
    outputs TEXT NOT NULL,
    progress TEXT NOT NULL,
    current_node TEXT,
    error_reason TEXT,
    error_phase TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled_at ON jobs(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);

CREATE TABLE IF NOT EXISTS job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_job ON job_events(job_id);

-- Job → job input chaining (storyboard batches). One row per media parameter
-- that is filled from an EARLIER job's output instead of an upload: the
-- dependent job stays unrunnable until its source completes, and the executor
-- then copies that output into ComfyUI/input and injects the filename.
-- Empty for every normally-booked job, so this table is inert unless a
-- storyboard is queued.
CREATE TABLE IF NOT EXISTS job_deps (
    job_id TEXT NOT NULL,
    param_key TEXT NOT NULL,
    source_job_id TEXT NOT NULL,
    output_index INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'image',
    PRIMARY KEY (job_id, param_key)
);
CREATE INDEX IF NOT EXISTS idx_deps_job ON job_deps(job_id);
CREATE INDEX IF NOT EXISTS idx_deps_source ON job_deps(source_job_id);
`;

// Columns added after the original schema shipped. `CREATE TABLE IF NOT EXISTS`
// never alters an existing table, so an already-populated queue.db needs them
// added explicitly — additive and nullable, so an older ComfyQ reading the same
// file is unaffected.
const ADDED_COLUMNS = [
    // Groups the jobs created from one storyboard upload so the whole batch can
    // be listed or cancelled together.
    { table: 'jobs', name: 'batch_id', ddl: 'ALTER TABLE jobs ADD COLUMN batch_id TEXT' },
    { table: 'jobs', name: 'batch_label', ddl: 'ALTER TABLE jobs ADD COLUMN batch_label TEXT' },
    // Overrides the auto-generated ComfyUI filename_prefix, so a storyboard's
    // results land in a named folder under readable names instead of
    // `anon_20260903_141233_a1b2c3d4`.
    { table: 'jobs', name: 'output_prefix', ddl: 'ALTER TABLE jobs ADD COLUMN output_prefix TEXT' }
];

function rowToJob(r) {
    if (!r) return null;
    return {
        id: r.id,
        userId: r.user_id,
        workflowId: r.workflow_id,
        workflowVersion: r.workflow_version || null,
        status: r.status,
        scheduledAt: r.scheduled_at,
        startedAt: r.started_at || null,
        finishedAt: r.finished_at || null,
        promptId: r.prompt_id || null,
        prompt: r.prompt || '',
        paramValues: JSON.parse(r.param_values || '{}'),
        inputFiles: JSON.parse(r.input_files || '[]'),
        outputs: JSON.parse(r.outputs || '[]'),
        progress: JSON.parse(r.progress || '{}'),
        currentNode: r.current_node || null,
        errorReason: r.error_reason || null,
        errorPhase: r.error_phase || null,
        createdBy: r.created_by || null,
        createdAt: r.created_at,
        batchId: r.batch_id || null,
        batchLabel: r.batch_label || null,
        outputPrefix: r.output_prefix || null
    };
}

class JobQueue {
    constructor(dbPath) {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.db.exec(SCHEMA);
        this._migrate();
        this._listeners = new Set();
    }

    // Add columns introduced after a queue.db was first created. Idempotent:
    // the pragma tells us which are already there, so a fresh DB (where SCHEMA
    // already includes them via the ALTERs below) and an old one converge.
    _migrate() {
        for (const col of ADDED_COLUMNS) {
            const cols = this.db.prepare(`PRAGMA table_info(${col.table})`).all().map(c => c.name);
            if (cols.includes(col.name)) continue;
            try { this.db.exec(col.ddl); }
            catch (e) { console.warn(`[Queue] could not add ${col.table}.${col.name}:`, e.message); }
        }
    }

    onChange(cb) { this._listeners.add(cb); return () => this._listeners.delete(cb); }
    _emit() { for (const cb of this._listeners) try { cb(); } catch (e) { console.error('[Queue] listener err:', e); } }

    // Move any in-flight job (pre-restart) to FAILED with reason 'server-restart'.
    reconcileOnBoot() {
        const inflight = [
            sm.STATES.UPLOADING_INPUTS,
            sm.STATES.SUBMITTED,
            sm.STATES.EXECUTING,
            sm.STATES.COLLECTING_OUTPUTS
        ];
        const placeholders = inflight.map(() => '?').join(',');
        const rows = this.db.prepare(`SELECT id, status FROM jobs WHERE status IN (${placeholders})`).all(...inflight);
        const tx = this.db.transaction(() => {
            for (const r of rows) {
                this.db.prepare(
                    `UPDATE jobs SET status=?, finished_at=?, error_reason=?, error_phase=? WHERE id=?`
                ).run(sm.STATES.FAILED, Date.now(), 'server-restart', r.status, r.id);
                this.db.prepare(
                    `INSERT INTO job_events (job_id, ts, from_status, to_status, payload) VALUES (?,?,?,?,?)`
                ).run(r.id, Date.now(), r.status, sm.STATES.FAILED, JSON.stringify({ reason: 'server-restart' }));
            }
        });
        tx();
        if (rows.length > 0) {
            console.log(`[Queue] Reconciled ${rows.length} in-flight job(s) → failed: server-restart`);
            this._emit();
        }
        return rows.length;
    }

    insert({ userId, workflowId, workflowVersion, scheduledAt, prompt = '', paramValues = {},
             createdBy = null, batchId = null, batchLabel = null, outputPrefix = null,
             deps = [], id = uuidv4() }) {
        const now = Date.now();
        const tx = this.db.transaction(() => {
            this.db.prepare(`
                INSERT INTO jobs (id, user_id, workflow_id, workflow_version, status, scheduled_at,
                                  prompt, param_values, input_files, outputs, progress, created_by, created_at,
                                  batch_id, batch_label, output_prefix)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            `).run(
                id, userId, workflowId, workflowVersion || null,
                sm.STATES.SCHEDULED, scheduledAt,
                prompt, JSON.stringify(paramValues), '[]', '[]', '{}',
                createdBy, now,
                batchId, batchLabel, outputPrefix
            );
            this.db.prepare(
                `INSERT INTO job_events (job_id, ts, from_status, to_status, payload) VALUES (?,?,?,?,?)`
            ).run(id, now, null, sm.STATES.SCHEDULED, null);
            for (const d of deps || []) {
                this.db.prepare(
                    `INSERT OR REPLACE INTO job_deps (job_id, param_key, source_job_id, output_index, kind)
                     VALUES (?,?,?,?,?)`
                ).run(id, d.paramKey, d.sourceJobId, d.outputIndex ?? 0, d.kind || 'image');
            }
        });
        tx();
        this._emit();
        return this.get(id);
    }

    // The chained inputs a job is waiting on (empty for a normally-booked job).
    depsFor(jobId) {
        return this.db.prepare(
            `SELECT param_key AS paramKey, source_job_id AS sourceJobId,
                    output_index AS outputIndex, kind
             FROM job_deps WHERE job_id = ?`
        ).all(jobId);
    }

    // Jobs that consume this one's output.
    dependentsOf(jobId) {
        return this.db.prepare(`SELECT DISTINCT job_id AS jobId FROM job_deps WHERE source_job_id = ?`)
            .all(jobId).map(r => r.jobId);
    }

    get(jobId) {
        const r = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);
        return rowToJob(r);
    }

    list({ since, until, userId, status, limit = 1000 } = {}) {
        const conds = [];
        const args = [];
        if (since != null) { conds.push('scheduled_at >= ?'); args.push(since); }
        if (until != null) { conds.push('scheduled_at <= ?'); args.push(until); }
        if (userId)        { conds.push('user_id = ?');       args.push(userId); }
        if (status)        { conds.push('status = ?');        args.push(status); }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
        const rows = this.db.prepare(`SELECT * FROM jobs ${where} ORDER BY scheduled_at ASC LIMIT ?`).all(...args, limit);
        return rows.map(rowToJob);
    }

    // Every job that hasn't finished (scheduled + in flight), oldest first.
    // Unbounded on purpose: the count is naturally small, and a LIMIT here
    // would hide the running job once a workshop's history grows.
    listActive() {
        const terminal = [...sm.TERMINAL_STATES];
        const rows = this.db.prepare(
            `SELECT * FROM jobs WHERE status NOT IN (${terminal.map(() => '?').join(',')})
             ORDER BY scheduled_at ASC, created_at ASC`
        ).all(...terminal);
        return rows.map(rowToJob);
    }

    // The `limit` most recent jobs, oldest first. list() with a limit keeps the
    // OLDEST rows, so once a workshop passes the limit it would silently drop
    // every new booking — the live broadcast uses this instead.
    listRecent(limit = 500) {
        const rows = this.db.prepare(
            `SELECT * FROM (SELECT * FROM jobs ORDER BY scheduled_at DESC, created_at DESC LIMIT ?)
             ORDER BY scheduled_at ASC, created_at ASC`
        ).all(limit);
        return rows.map(rowToJob);
    }

    // The next job the executor may actually run. A job whose chained inputs
    // (job_deps) are not all COMPLETED is skipped rather than returned, so a
    // storyboard video waiting on its still-unrendered frame never blocks the
    // jobs queued behind it. With no deps this is the original query.
    // `workflowIds` restricts the search to the workflows one lane serves, so
    // several lanes can run side by side without stealing each other's work.
    // Lanes never share a workflow (see LaneManager), which is what makes the
    // find-then-claim below safe without a lease.
    findReady(now = Date.now(), workflowIds = null) {
        const ids = Array.isArray(workflowIds) ? workflowIds.filter(Boolean) : null;
        if (ids && ids.length === 0) return null;
        const laneFilter = ids ? `AND j.workflow_id IN (${ids.map(() => '?').join(',')})` : '';
        const r = this.db.prepare(`
            SELECT j.* FROM jobs j
            WHERE j.status = ? AND j.scheduled_at <= ?
              ${laneFilter}
              AND NOT EXISTS (
                  SELECT 1 FROM job_deps d
                  LEFT JOIN jobs s ON s.id = d.source_job_id
                  WHERE d.job_id = j.id AND (s.id IS NULL OR s.status != ?)
              )
            ORDER BY j.scheduled_at ASC, j.created_at ASC LIMIT 1
        `).get(sm.STATES.SCHEDULED, now, ...(ids || []), sm.STATES.COMPLETED);
        return rowToJob(r);
    }

    // Fail any scheduled job whose chained input can never arrive — its source
    // failed, was cancelled, or was deleted outright. Without this a storyboard
    // video would sit SCHEDULED forever after its frame job failed. Runs to a
    // fixed point so a whole chain collapses in one call, and returns the
    // affected job ids so the caller can log/notify.
    failBlockedJobs(now = Date.now()) {
        const failed = [];
        const MAX_PASSES = 1000;     // one chain level per pass
        let pass = 0;
        for (; pass < MAX_PASSES; pass++) {
            // Grouped by job, NOT by (job, source): a job with two dead inputs
            // must fail once, or the event log records a second
            // scheduled -> failed transition for a job that is already failed.
            const rows = this.db.prepare(`
                SELECT d.job_id AS jobId, MIN(d.source_job_id) AS sourceJobId
                FROM job_deps d
                JOIN jobs j ON j.id = d.job_id
                LEFT JOIN jobs s ON s.id = d.source_job_id
                WHERE j.status = ?
                  AND (s.id IS NULL OR s.status IN ('failed', 'cancelled'))
                GROUP BY d.job_id
            `).all(sm.STATES.SCHEDULED);
            if (rows.length === 0) break;
            for (const r of rows) {
                const res = this.db.prepare(
                    `UPDATE jobs SET status=?, finished_at=?, error_reason=?, error_phase=? WHERE id=? AND status=?`
                ).run(sm.STATES.FAILED, now, 'dependency-failed', 'pre-submit', r.jobId, sm.STATES.SCHEDULED);
                if (res.changes === 0) continue;         // raced to terminal
                this.db.prepare(
                    `INSERT INTO job_events (job_id, ts, from_status, to_status, payload) VALUES (?,?,?,?,?)`
                ).run(r.jobId, now, sm.STATES.SCHEDULED, sm.STATES.FAILED,
                    JSON.stringify({ reason: 'dependency-failed', sourceJobId: r.sourceJobId }));
                failed.push(r.jobId);
            }
        }
        if (pass >= MAX_PASSES) {
            console.warn(`[Queue] dependency collapse hit ${MAX_PASSES} passes; the rest follows next tick.`);
        }
        if (failed.length) this._emit();
        return failed;
    }

    // Overwrite a job's parameter values. Used by the executor once a chained
    // input has been resolved to a real filename, so the stored job (and the
    // ingredients snapshot / "Use these settings" recall built from it) records
    // what actually ran, not the unresolved placeholder.
    setParamValues(jobId, paramValues) {
        this.db.prepare(`UPDATE jobs SET param_values = ? WHERE id = ?`)
            .run(JSON.stringify(paramValues || {}), jobId);
        this._emit();
        return this.get(jobId);
    }

    // Ids of the not-yet-finished jobs that consume this job's output. A
    // completed job with a non-empty list must not be deleted: its file is the
    // input those jobs are waiting for.
    neededBy(jobId) {
        const terminal = [...sm.TERMINAL_STATES];
        const placeholders = terminal.map(() => '?').join(',');
        return this.db.prepare(
            `SELECT DISTINCT d.job_id AS jobId FROM job_deps d
             JOIN jobs w ON w.id = d.job_id
             WHERE d.source_job_id = ? AND w.status NOT IN (${placeholders})`
        ).all(jobId, ...terminal).map(r => r.jobId);
    }

    // Latest start time on the timeline across everything not yet finished.
    // 0 when the queue is idle.
    latestActiveStart() {
        const r = this.db.prepare(
            `SELECT MAX(scheduled_at) AS t FROM jobs
             WHERE status NOT IN ('failed', 'cancelled', 'completed')`
        ).get();
        return r?.t || 0;
    }

    // Put a job back in the queue after a failure the server has since fixed
    // (today: ComfyUI restarted without an incompatible acceleration flag).
    //
    // This deliberately bypasses the state machine, which treats FAILED as
    // terminal. Retrying in place rather than inserting a clone is what keeps
    // the batch intact: every job_deps row still points at this id, so the
    // shots waiting on it stay valid instead of collapsing. The event log
    // records the round trip.
    requeue(jobId, reason = 'retry') {
        const job = this.get(jobId);
        if (!job) return null;
        const now = Date.now();
        this.db.prepare(
            `UPDATE jobs SET status=?, started_at=NULL, finished_at=NULL,
                             error_reason=NULL, error_phase=NULL, prompt_id=NULL, progress='{}'
             WHERE id=?`
        ).run(sm.STATES.SCHEDULED, jobId);
        this.db.prepare(
            `INSERT INTO job_events (job_id, ts, from_status, to_status, payload) VALUES (?,?,?,?,?)`
        ).run(jobId, now, job.status, sm.STATES.SCHEDULED, JSON.stringify({ reason }));
        this._emit();
        return this.get(jobId);
    }

    listBatch(batchId) {
        return this.db.prepare(
            `SELECT * FROM jobs WHERE batch_id = ? ORDER BY scheduled_at ASC, created_at ASC`
        ).all(batchId).map(rowToJob);
    }

    // Every storyboard batch in the queue, newest first, with a status tally.
    listBatches() {
        // Grouped by id alone — grouping by (id, label) too would split one
        // batch into several rows the moment a label differed, and report a
        // total smaller than the batch really is.
        return this.db.prepare(`
            SELECT batch_id AS batchId, MAX(batch_label) AS batchLabel,
                   COUNT(*) AS total, MIN(created_at) AS createdAt,
                   SUM(status = 'completed') AS completed,
                   SUM(status IN ('failed', 'cancelled')) AS failed,
                   SUM(status = 'scheduled') AS pending,
                   SUM(status NOT IN ('completed', 'failed', 'cancelled', 'scheduled')) AS running
            FROM jobs WHERE batch_id IS NOT NULL
            GROUP BY batch_id
            ORDER BY createdAt DESC
        `).all();
    }

    // Earliest time >= `from` at which a job of `durationMs` doesn't overlap any
    // active (scheduled / in-flight) job — used for "ASAP" bookings where the
    // user picked no slot. Greedy: active jobs are walked in start order and `t`
    // is pushed past any it collides with (mirrors findCollisions' single-
    // duration model). The executor still serializes execution; this just keeps
    // the timeline non-overlapping and the job queued right after what's pending.
    //
    // ★ `workflowId` narrows the timeline to that workflow's jobs. Each lane
    //   (one served workflow) runs its own queue on its own ComfyUI, and its
    //   executor only claims a job once its slot has come — so one timeline for
    //   the whole machine made a second lane wait idle behind the first lane's
    //   bookings, and two workflows on one card took turns instead of running
    //   side by side. Without it, every job counts (the single-lane case).
    nextFreeSlot(from = Date.now(), durationMs = 0, workflowId = null) {
        const rows = this.db.prepare(`
            SELECT scheduled_at FROM jobs
            WHERE status NOT IN ('failed', 'cancelled', 'completed')
              ${workflowId ? 'AND workflow_id = ?' : ''}
            ORDER BY scheduled_at ASC
        `).all(...(workflowId ? [workflowId] : []));
        let t = from;
        for (const r of rows) {
            const start = r.scheduled_at;
            const end = start + durationMs;
            if (t < end && (t + durationMs) > start) t = end;
        }
        return t;
    }

    // Approximate: same fixed duration on both sides. Caller should pass the expected duration.
    // We can't store per-job duration without joining; for v2 collision detection we treat
    // each in-flight/scheduled job as occupying [scheduled_at, scheduled_at + durationMs).
    // `workflowId`: only that workflow's jobs collide (see nextFreeSlot).
    findCollisions(scheduledAt, durationMs, excludeJobId = null, workflowId = null) {
        const endAt = scheduledAt + durationMs;
        const args = [endAt, durationMs, scheduledAt];
        if (excludeJobId) args.push(excludeJobId);
        if (workflowId) args.push(workflowId);
        const rows = this.db.prepare(`
            SELECT id, scheduled_at FROM jobs
            WHERE status NOT IN ('failed', 'cancelled', 'completed')
              AND scheduled_at < ?
              AND (scheduled_at + ?) > ?
              ${excludeJobId ? 'AND id != ?' : ''}
              ${workflowId ? 'AND workflow_id = ?' : ''}
        `).all(...args);
        return rows.map(r => r.id);
    }

    transitionStatus(jobId, toStatus, { payload = null, now = Date.now() } = {}) {
        const job = this.get(jobId);
        if (!job) throw new Error(`Job not found: ${jobId}`);
        if (!sm.canTransition(job.status, toStatus)) {
            throw new Error(`Illegal transition ${job.status} → ${toStatus} for job ${jobId}`);
        }
        const updates = ['status = ?'];
        const args = [toStatus];
        if (toStatus === sm.STATES.UPLOADING_INPUTS && !job.startedAt) {
            updates.push('started_at = ?'); args.push(now);
        }
        if (sm.isTerminal(toStatus)) {
            updates.push('finished_at = ?'); args.push(now);
        }
        if (payload?.errorReason !== undefined) { updates.push('error_reason = ?'); args.push(payload.errorReason); }
        if (payload?.errorPhase  !== undefined) { updates.push('error_phase = ?');  args.push(payload.errorPhase); }
        if (payload?.promptId    !== undefined) { updates.push('prompt_id = ?');    args.push(payload.promptId); }
        if (payload?.inputFiles  !== undefined) { updates.push('input_files = ?');  args.push(JSON.stringify(payload.inputFiles)); }
        if (payload?.outputs     !== undefined) { updates.push('outputs = ?');      args.push(JSON.stringify(payload.outputs)); }
        args.push(jobId);
        this.db.prepare(`UPDATE jobs SET ${updates.join(', ')} WHERE id = ?`).run(...args);
        this.db.prepare(
            `INSERT INTO job_events (job_id, ts, from_status, to_status, payload) VALUES (?,?,?,?,?)`
        ).run(jobId, now, job.status, toStatus, payload ? JSON.stringify(payload) : null);
        this._emit();
        return this.get(jobId);
    }

    updateProgress(jobId, { stepsDone, stepsTotal, currentNode, currentNodeTitle } = {}) {
        const job = this.get(jobId);
        if (!job) return null;
        const progress = { ...job.progress };
        if (stepsDone   != null) progress.stepsDone   = stepsDone;
        if (stepsTotal  != null) progress.stepsTotal  = stepsTotal;
        if (currentNodeTitle != null) progress.currentNodeTitle = currentNodeTitle;
        const node = currentNode != null ? currentNode : job.currentNode;
        this.db.prepare(`UPDATE jobs SET progress = ?, current_node = ? WHERE id = ?`)
            .run(JSON.stringify(progress), node, jobId);
        this._emit();
        return this.get(jobId);
    }

    setOutputs(jobId, outputs) {
        this.db.prepare(`UPDATE jobs SET outputs = ? WHERE id = ?`)
            .run(JSON.stringify(outputs || []), jobId);
        this._emit();
        return this.get(jobId);
    }

    reorder(jobId, newScheduledAt) {
        const job = this.get(jobId);
        if (!job) throw new Error(`Job not found: ${jobId}`);
        if (job.status !== sm.STATES.SCHEDULED) throw new Error(`Cannot move job in status "${job.status}"`);
        this.db.prepare(`UPDATE jobs SET scheduled_at = ? WHERE id = ?`).run(newScheduledAt, jobId);
        this._emit();
        return this.get(jobId);
    }

    delete(jobId) {
        this.db.prepare(`DELETE FROM job_events WHERE job_id = ?`).run(jobId);
        // Only this job's OWN dependency rows go. Rows naming it as a *source*
        // are left in place so failBlockedJobs still sees that the input can
        // never arrive and fails the jobs waiting on it; they are removed when
        // those jobs are themselves deleted.
        this.db.prepare(`DELETE FROM job_deps WHERE job_id = ?`).run(jobId);
        this.db.prepare(`DELETE FROM jobs WHERE id = ?`).run(jobId);
        this._emit();
    }

    // Delete terminal job records (completed/failed/cancelled) and their event
    // logs. Scheduled and in-flight jobs are preserved so a running queue isn't
    // corrupted out from under the worker. Returns the deleted jobs (id +
    // outputs) so the caller can also remove their files from disk.
    clearHistory() {
        const terminal = [...sm.TERMINAL_STATES];
        const placeholders = terminal.map(() => '?').join(',');
        // A storyboard's images complete FIRST and are exactly what its still
        // pending videos consume. Clearing the gallery mid-batch would delete
        // those frames and collapse the rest of the batch on the next tick, so
        // a completed job another job is still waiting on is kept.
        const rows = this.db.prepare(
            `SELECT id, outputs FROM jobs
             WHERE status IN (${placeholders})
               AND id NOT IN (SELECT d.source_job_id FROM job_deps d
                              JOIN jobs w ON w.id = d.job_id
                              WHERE w.status NOT IN (${placeholders}))`
        ).all(...terminal, ...terminal);
        const deleted = rows.map(r => ({ id: r.id, outputs: JSON.parse(r.outputs || '[]') }));
        const tx = this.db.transaction(() => {
            for (const { id } of deleted) {
                this.db.prepare(`DELETE FROM job_events WHERE job_id = ?`).run(id);
                this.db.prepare(`DELETE FROM job_deps WHERE job_id = ?`).run(id);
                this.db.prepare(`DELETE FROM jobs WHERE id = ?`).run(id);
            }
        });
        tx();
        if (deleted.length > 0) this._emit();
        return deleted;
    }

    eventsFor(jobId) {
        return this.db.prepare(`SELECT * FROM job_events WHERE job_id = ? ORDER BY id ASC`).all(jobId);
    }

    close() { this.db.close(); }
}

module.exports = { JobQueue };
