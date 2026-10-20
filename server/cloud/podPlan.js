const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { setAdminPassword, setAccessPassword } = require('../auth/authGate');
const { estimateWorkflowVram, invalidateModelIndex } = require('../workflows/vramEstimate');

// A Pod configured by its environment, so creating it is the only step.
//
// The container's entrypoint runs applyEnv() once per container start, before
// ComfyQ itself. It stores the passwords and the HuggingFace token, and — when
// COMFYQ_SERVE names workflows — writes a PLAN and clears the serving markers,
// so ComfyQ boots in admin mode. Admin boot then runs runPlan(): fetch the
// models those workflows are missing, and only then serve them.
//
// ★ Why the fetch happens inside the running server rather than in the
//   entrypoint: a first fetch can take tens of minutes, and a server that is
//   not listening yet cannot say what it is doing. In admin mode the HTTP API
//   is up, so GET /admin/pod-plan reports progress file by file and the
//   launcher (tools/runpod) can show it instead of looking hung.
//
// Environment (every one optional):
//   COMFYQ_SERVE           workflow ids, comma-separated. The first is the
//                          primary lane, the rest open as parallel lanes.
//   COMFYQ_FETCH_MODELS    0 to skip the model fetch (default: fetch).
//   COMFYQ_ADMIN_PASSWORD  admin password.
//   COMFYQ_ACCESS_PASSWORD student access password.
//   COMFYQ_HF_TOKEN / HF_TOKEN  HuggingFace token for gated models.
//   COMFYQ_ALLOW_OPEN      1 to serve with no admin password (see below).
//
// The student access password is optional, as it is on a LAN rig: without it
// anyone who has the Pod's URL can book jobs, which is the owner's call.

// COMFYQ_POD_PLAN_FILE: tests only, so they never write into server/data.
const PLAN_FILE = process.env.COMFYQ_POD_PLAN_FILE || path.join(__dirname, '..', 'data', 'pod-plan.json');

function readPlan(file = PLAN_FILE) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return null; }
}

function writePlan(plan, file = PLAN_FILE) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(plan, null, 2));
    fs.renameSync(tmp, file);
}

function updatePlan(patch, file = PLAN_FILE) {
    const plan = { ...(readPlan(file) || {}), ...patch, updatedAt: new Date().toISOString() };
    writePlan(plan, file);
    return plan;
}

const parseIds = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const isOn = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
const isOff = (v) => /^(0|false|no|off)$/i.test(String(v || '').trim());

/**
 * Store a password only when it differs from the one already set.
 *
 * ★ bcrypt salts every hash, so re-hashing the same password on each container
 *   start would still rotate the stored hash — and the student access token is
 *   derived from that hash, so every restart would log every student out.
 */
function _setIfChanged(plaintext, currentHash, setter, configManager) {
    if (currentHash && bcrypt.compareSync(plaintext, currentHash)) return false;
    setter(plaintext, configManager);
    return true;
}

/**
 * Apply the environment to config and, when asked to serve, write the plan.
 * Returns a summary for the entrypoint's log. Never prints a secret.
 */
function applyEnv({ env = process.env, configManager, registry, servingFlags, planFile = PLAN_FILE, now = () => new Date() }) {
    const out = { changed: [], plan: null };
    const cfg = () => configManager.load().config;

    if (env.COMFYQ_ADMIN_PASSWORD) {
        if (_setIfChanged(env.COMFYQ_ADMIN_PASSWORD, cfg().auth?.adminPasswordHash, setAdminPassword, configManager)) {
            out.changed.push('admin password');
        }
    }
    if (env.COMFYQ_ACCESS_PASSWORD) {
        if (_setIfChanged(env.COMFYQ_ACCESS_PASSWORD, cfg().auth?.accessPasswordHash, setAccessPassword, configManager)) {
            out.changed.push('student access password');
        }
    }
    const token = String(env.COMFYQ_HF_TOKEN || env.HF_TOKEN || '').trim();
    if (token && token !== cfg().comfy_ui?.hf_token) {
        configManager.update(c => { c.comfy_ui = c.comfy_ui || {}; c.comfy_ui.hf_token = token; return c; });
        out.changed.push('HuggingFace token');
    }

    const serve = parseIds(env.COMFYQ_SERVE);
    if (!serve.length) {
        // No plan asked for: a plan left from an earlier container start must
        // not run again on its own.
        try { fs.unlinkSync(planFile); } catch { /* none */ }
        return out;
    }

    const base = {
        serve,
        fetchModels: !isOff(env.COMFYQ_FETCH_MODELS),
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
        files: [],
        error: null,
    };

    // ★ A Pod is on the public internet: anyone holding its URL can reach it.
    //   With no admin password the whole admin panel is open to them —
    //   switching workflows, deleting jobs, emptying the model quarantine — so
    //   serving like that has to be asked for in so many words. (No STUDENT
    //   password only means anyone can book jobs; that is allowed.)
    const c = cfg();
    if (!c.auth?.adminPasswordHash && !isOn(env.COMFYQ_ALLOW_OPEN)) {
        out.plan = { ...base, status: 'refused',
            error: 'not serving: no COMFYQ_ADMIN_PASSWORD set, and this Pod is reachable by anyone with its URL, admin panel included. Set it, or COMFYQ_ALLOW_OPEN=1 to serve it open on purpose.' };
        writePlan(out.plan, planFile);
        servingFlags.setServingIntent(false);
        return out;
    }

    const unknown = serve.filter(id => { const e = registry.get(id); return !e || e.unavailable; });
    if (unknown.length) {
        out.plan = { ...base, status: 'failed',
            error: `unknown or unavailable workflow${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}` };
        writePlan(out.plan, planFile);
        servingFlags.setServingIntent(false);
        return out;
    }

    // Boot in admin mode, so the plan runs with the HTTP API up. The plan
    // switches to student mode itself once the models are in place.
    servingFlags.setServingIntent(false);
    servingFlags.consumeStudentBootFlag();
    out.plan = { ...base, status: 'pending' };
    writePlan(out.plan, planFile);
    return out;
}

const base = (v) => String(v || '').split('\\').join('/').split('/').pop().toLowerCase();

/**
 * The models a workflow names in its graph that are not on disk, joined to
 * where the meta says each comes from. Includes the ones reachable only
 * through a switch the defaults leave the other way: a student can flip it.
 */
// Sizes of every downloadable model, measured by
// tools/model-provenance/fresh-machine.cjs --write-sizes (in the image too).
const SIZES_FILE = process.env.COMFYQ_DOWNLOADS_FILE || path.join(__dirname, '..', '..', 'tools', 'model-provenance', 'workflow-downloads.json');
const HEADROOM = 2 * 1024 ** 3;
const gbOf = (b) => (b / 1024 ** 3).toFixed(1);

/**
 * Do these missing files fit on the disk the models go to?
 * ★ Checked BEFORE the first byte (2026-10-20): a machine launched with no
 *   workflow gets its disk before anyone chooses one, and the downloader only
 *   noticed per file, partway through: paying for a download that could never
 *   finish. A file of unknown size counts as 0 and is named in `unknown`.
 */
function diskCheck(files, comfyRoot, { freeBytes } = {}) {
    let sizes = {};
    try { sizes = JSON.parse(fs.readFileSync(SIZES_FILE, 'utf8')).sizes || {}; } catch { /* none known */ }
    const byBase = new Map(Object.entries(sizes).map(([k, v]) => [base(k), Number(v) || 0]));
    let need = 0; const unknown = [];
    for (const m of files) {
        if (m.auto || !m.url) continue;
        const b = byBase.get(base(m.file));
        if (b == null) unknown.push(m.file); else need += b;
    }
    const dir = comfyRoot ? path.join(comfyRoot, 'models') : null;
    let free = null;
    if (freeBytes) free = freeBytes(dir);
    else if (dir) { try { const st = fs.statfsSync(dir); free = st.bavail * st.bsize; } catch { free = null; } }
    const ok = free == null || need + HEADROOM <= free;
    return { ok, need, free, unknown,
        message: ok ? null : `these models need ${gbOf(need)} GB and this machine has ${gbOf(free)} GB free (keeping ${gbOf(HEADROOM)} GB spare). Nothing was downloaded. Pick a lighter workflow, or delete this machine and launch one with a bigger disk.` };
}

function missingModels(entry, comfyRoot) {
    const est = estimateWorkflowVram(entry.apiWorkflow || {}, comfyRoot);
    const names = [...new Set([...(est.unresolved || []), ...(est.unresolvedInactive || [])])];
    const declared = new Map();
    for (const m of entry.summary?.models || []) if (m?.file) declared.set(base(m.file), m);
    return names.map(name => {
        const m = declared.get(base(name));
        return {
            name,
            file: m?.file || name,
            url: m?.url || null,
            source: m?.source || null,
            type: m?.type || null,
            dir: m?.dir || null,
            auto: m?.auto === true,
        };
    });
}

/**
 * Fetch what the planned workflows are missing, then serve them.
 * Runs in admin boot. Resolves once it has either handed over to student mode
 * (by calling exitForRestart) or recorded why it could not.
 */
/**
 * `onReady`, when given, replaces the last step (switch the machine to serving
 * plan.serve and restart): "Serve alongside" downloads a lane's models with this
 * same plan, then opens that one lane, and the machine keeps serving the others.
 */
async function runPlan({ configManager, registry, downloader, exitForRestart, onReady = null, planFile = PLAN_FILE, pollMs = 3000, log = console.log }) {
    const plan = readPlan(planFile);
    if (!plan || plan.status !== 'pending') return plan;
    const fail = (error) => { log(`[pod-plan] ${error}`); return updatePlan({ status: 'failed', error }, planFile); };
    // A lane's plan found by the admin boot (a restart cut it short) must not
    // make that lane the machine's only workflow.
    if (plan.lane && !onReady) return fail(`the download for ${plan.serve.join(', ')} was cut short by a restart: press Serve alongside again`);

    const comfyRoot = configManager.load().config.comfy_ui?.root_path;
    if (plan.fetchModels) {
        updatePlan({ status: 'fetching' }, planFile);
        invalidateModelIndex();

        // Gather every missing file across the planned workflows, once each.
        const wanted = new Map();
        for (const id of plan.serve) {
            const entry = registry.get(id);
            if (!entry) return fail(`workflow ${id} is no longer in the library`);
            for (const m of missingModels(entry, comfyRoot)) {
                const k = base(m.file);
                if (!wanted.has(k)) wanted.set(k, { ...m, for: [id] });
                else wanted.get(k).for.push(id);
            }
        }

        const room = diskCheck([...wanted.values()], comfyRoot);
        if (!room.ok) return fail(room.message);

        const files = [];
        for (const m of wanted.values()) {
            const row = { name: m.file, for: m.for, status: 'queued', dest: null, received: 0, total: null, error: null, key: null };
            if (m.auto) { row.status = 'skipped'; row.error = 'fetched by its node pack on first use'; }
            else if (!m.url) {
                row.status = 'failed';
                row.error = m.source ? `no direct link — get it from ${m.source}` : 'no known source';
            } else {
                const r = downloader.enqueue({ name: m.file, url: m.url, type: m.type, dir: m.dir || undefined });
                if (r.ok) { row.key = r.key; row.dest = r.dest; }
                else if (/already installed/.test(r.error || '')) row.status = 'done';
                else { row.status = 'failed'; row.error = r.error; }
            }
            files.push(row);
        }
        log(`[pod-plan] ${files.length} model file(s) missing for ${plan.serve.join(', ')}`);
        updatePlan({ files }, planFile);

        // Wait for the downloader, copying its progress into the plan.
        for (;;) {
            const live = new Map(downloader.list().map(j => [j.key, j]));
            let pending = false;
            for (const row of files) {
                const j = row.key && live.get(row.key);
                if (!j) continue;
                Object.assign(row, {
                    status: j.status, received: j.received, total: j.total, error: j.error || null,
                    // Another Pod on this volume is fetching the same file: wait for it.
                    waitingFor: j.status === 'waiting' ? j.waitingFor || 'another Pod' : null,
                    installedBy: j.installedBy || null,
                });
                if (['queued', 'downloading', 'waiting'].includes(j.status)) pending = true;
            }
            updatePlan({ files }, planFile);
            if (!pending) break;
            await new Promise(r => setTimeout(r, pollMs));
        }

        const bad = files.filter(f => !['done', 'skipped'].includes(f.status));
        if (bad.length) {
            return fail(`${bad.length} model file(s) could not be fetched: `
                + bad.map(f => `${f.name} (${f.error || f.status})`).join('; '));
        }

        // Check again from the disk rather than trusting the download rows.
        invalidateModelIndex();
        for (const id of plan.serve) {
            const still = missingModels(registry.get(id), comfyRoot).filter(m => !m.auto);
            if (still.length) return fail(`${id} is still missing ${still.map(m => m.name).join(', ')}`);
        }
    }

    if (onReady) {
        try { await onReady(plan); }
        catch (e) { return fail(`the models are in, but ${plan.serve.join(', ')} could not be started: ${e.message}`); }
        updatePlan({ status: 'done', servedAt: new Date().toISOString() }, planFile);
        log(`[pod-plan] serving ${plan.serve.join(', ')} alongside`);
        return readPlan(planFile);
    }

    const [primary, ...extras] = plan.serve;
    configManager.update(c => {
        c.workflows.activeWorkflowId = primary;
        c.workflows.extraLaneWorkflowIds = extras;
        c.mode = 'student';
        return c;
    });
    updatePlan({ status: 'done', servedAt: new Date().toISOString() }, planFile);
    log(`[pod-plan] serving ${plan.serve.join(', ')}`);
    exitForRestart('student');
    return readPlan(planFile);
}

module.exports = { PLAN_FILE, applyEnv, runPlan, missingModels, diskCheck, readPlan, writePlan };
