// node server/routes/activateFetch.test.js
//
// "Activate & serve" in the admin panel downloads a workflow's missing models
// first — the same plan a machine launched with that workflow runs — then
// switches to serving. Before 2026-10-20 it switched at once, and a machine
// started with no workflow then served one without its models. Also: the route
// (and the other settings routes) needed no admin password.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'activate-fetch-'));
process.env.COMFYQ_POD_PLAN_FILE = path.join(tmp, 'pod-plan.json');   // never server/data
const sizesFile = path.join(tmp, 'sizes.json');
process.env.COMFYQ_DOWNLOADS_FILE = sizesFile;
const setSizes = (sizes) => fs.writeFileSync(sizesFile, JSON.stringify({ sizes }));
setSizes({});

const { makeRouter } = require('./admin');
const { adminGate } = require('../auth/authGate');
const { invalidateModelIndex } = require('../workflows/vramEstimate');

let n = 0, bad = 0;
const check = (name, ok) => { n++; if (!ok) { bad++; console.log(`  FAIL ${name}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A ComfyUI folder with one model, and one missing.
const root = path.join(tmp, 'ComfyUI');
fs.mkdirSync(path.join(root, 'models', 'checkpoints'), { recursive: true });
fs.writeFileSync(path.join(root, 'main.py'), '');
fs.writeFileSync(path.join(root, 'models', 'checkpoints', 'have.safetensors'), 'x');

const graph = (file) => ({ 1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: file } } });
const entries = {
    needs_model: { id: 'needs_model', apiWorkflow: graph('missing.safetensors'), summary: { name: 'Needs a model', models: [{ type: 'checkpoint', file: 'missing.safetensors', url: 'https://huggingface.co/x/y/resolve/main/checkpoints/missing.safetensors' }] }, effective: { exposedParameters: [] } },
    has_model: { id: 'has_model', apiWorkflow: graph('have.safetensors'), summary: { name: 'Has its model', models: [{ type: 'checkpoint', file: 'have.safetensors', url: 'https://huggingface.co/x/y/resolve/main/checkpoints/have.safetensors' }] }, effective: { exposedParameters: [] } },
};
const registry = { get: (id) => entries[id] || null, list: () => Object.values(entries) };

let config = {
    mode: 'admin',
    auth: { adminPasswordHash: bcrypt.hashSync('admin-pw', 4) },
    workflows: { activeWorkflowId: null, extraLaneWorkflowIds: [] },
    comfy_ui: { root_path: root },
};
const configManager = { load: () => ({ config }), update: (fn) => { config = fn(JSON.parse(JSON.stringify(config))) || config; return config; } };

// A downloader that "downloads" by writing the file, slowly enough to be seen.
let downloadDelay = 300;
const jobs = new Map();
const downloader = {
    enqueue({ name, url }) {
        const key = `k${jobs.size}`;
        const dest = path.join(root, 'models', 'checkpoints', name);
        jobs.set(key, { key, status: 'downloading', received: 0, total: 100 });
        setTimeout(() => { fs.writeFileSync(dest, 'weights'); jobs.set(key, { key, status: 'done', received: 100, total: 100 }); }, downloadDelay);
        return { ok: true, key, dest: `models/checkpoints/${name}` };
    },
    list: () => [...jobs.values()],
};
const restarts = [];
const opened = [];
const lanes = { open: async (id) => { opened.push(id); return { workflowId: id, name: id, port: 8189 }; }, get: () => null };
const app = express();
app.use('/admin', makeRouter({ configManager, registry, adminGate: adminGate(configManager), exitForRestart: (m) => restarts.push(m), runtime: { downloader, lanes } }));

(async () => {
    const srv = app.listen(0);
    const base = `http://127.0.0.1:${srv.address().port}/admin`;
    const post = (route, body, pw = 'admin-pw') => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(pw ? { 'X-Admin-Password': pw } : {}) }, body: JSON.stringify(body) });
    try {
        // ---- the password ----
        check('activate without the admin password is refused', (await post('/activate-workflow', { workflowId: 'has_model' }, null)).status === 401);
        const put = await fetch(base + '/comfy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ python_executable: '/tmp/evil' }) });
        check('changing the ComfyUI paths (its Python) without the password is refused', put.status === 401 && config.comfy_ui.python_executable === undefined);
        check('check-paths without the password is refused', (await post('/check-paths', { python_executable: '/tmp/evil' }, null)).status === 401);

        // ---- models that do not fit on the disk: refused before any download ----
        invalidateModelIndex();
        setSizes({ 'missing.safetensors': 1e15 });   // a petabyte
        const big = await post('/activate-workflow', { workflowId: 'needs_model' });
        const bigBody = await big.json();
        check(`models bigger than the free disk are refused up front (${big.status} ${bigBody.error})`, big.status === 507 && /GB free/.test(bigBody.error || ''));
        check('and nothing was downloaded or switched', jobs.size === 0 && config.mode === 'admin' && restarts.length === 0);
        setSizes({ 'missing.safetensors': 1000 });

        // ---- a workflow with a model missing: download, then serve ----
        const r1 = await post('/activate-workflow', { workflowId: 'needs_model' });
        const d1 = await r1.json();
        check(`missing models are downloaded first (${JSON.stringify(d1)})`, r1.status === 200 && d1.fetching === true && d1.missing.includes('missing.safetensors'));
        check('nothing switched yet', config.mode === 'admin' && restarts.length === 0);
        const again = await post('/activate-workflow', { workflowId: 'has_model' });
        check(`a second activation while downloading is refused (${again.status})`, again.status === 409);
        let plan = null;
        for (let i = 0; i < 40; i++) {
            plan = (await (await fetch(base + '/pod-plan')).json()).plan;
            if (plan?.status === 'done' || plan?.status === 'failed') break;
            await sleep(100);
        }
        check(`the plan finishes (${plan?.status} ${plan?.error || ''})`, plan?.status === 'done');
        check('the model is on disk', fs.existsSync(path.join(root, 'models', 'checkpoints', 'missing.safetensors')));
        check('then the machine serves it', config.workflows.activeWorkflowId === 'needs_model' && config.mode === 'student' && restarts.includes('student'));

        // ---- a download cut short by a restart does not block for ever ----
        fs.writeFileSync(process.env.COMFYQ_POD_PLAN_FILE, JSON.stringify({ serve: ['needs_model'], status: 'fetching', updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(), files: [] }));
        restarts.length = 0; config.mode = 'admin';
        const stale = await post('/activate-workflow', { workflowId: 'has_model' });
        await sleep(400);
        check(`a plan left "fetching" by a restart does not block activation (${stale.status})`, stale.status === 200 && restarts.includes('student'));

        // ---- a workflow with all its models: at once, as before ----
        restarts.length = 0; config.mode = 'admin';
        const r2 = await (await post('/activate-workflow', { workflowId: 'has_model' })).json();
        await sleep(400);
        check(`a workflow with its models switches at once (${JSON.stringify(r2)})`, r2.ok && !r2.fetching && config.workflows.activeWorkflowId === 'has_model' && restarts.includes('student'));

        // ---- Serve alongside: download, then open the lane, no restart ----
        fs.rmSync(path.join(root, 'models', 'checkpoints', 'missing.safetensors'));
        invalidateModelIndex();
        restarts.length = 0; config.mode = 'student';
        const l1 = await post('/lanes', { workflowId: 'needs_model' });
        const ld = await l1.json();
        check(`Serve alongside downloads a lane's missing models first (${JSON.stringify(ld)})`, l1.status === 200 && ld.fetching === true && opened.length === 0);
        let lp = null;
        for (let i = 0; i < 40; i++) {
            lp = (await (await fetch(base + '/pod-plan')).json()).plan;
            if (lp?.status === 'done' || lp?.status === 'failed') break;
            await sleep(100);
        }
        check(`then opens that lane (${lp?.status} ${lp?.error || ''})`, lp?.status === 'done' && opened.includes('needs_model'));
        check('and the machine neither restarts nor changes what it serves', restarts.length === 0 && config.mode === 'student' && config.workflows.activeWorkflowId === 'has_model');
        const l2 = await (await post('/lanes', { workflowId: 'has_model' })).json();
        check('a lane whose models are here opens at once', l2.ok && !l2.fetching && opened.includes('has_model'));
        const { runPlan, writePlan } = require('../cloud/podPlan');
        writePlan({ serve: ['needs_model'], lane: true, status: 'pending', files: [], fetchModels: true });
        const cut = await runPlan({ configManager, registry, downloader, exitForRestart: (m) => restarts.push(m) });
        check(`a lane's plan found at boot does not take over the machine (${cut?.status})`, cut?.status === 'failed' && restarts.length === 0);
        fs.writeFileSync(path.join(root, 'models', 'checkpoints', 'missing.safetensors'), 'x');

        // ---- "Serve anyway" after a failed download ----
        fs.rmSync(path.join(root, 'models', 'checkpoints', 'missing.safetensors'));
        invalidateModelIndex();
        restarts.length = 0; config.mode = 'admin';
        const r3 = await (await post('/activate-workflow', { workflowId: 'needs_model', serveWithoutModels: true })).json();
        await sleep(400);
        check('Serve anyway skips the download', r3.ok && !r3.fetching && config.workflows.activeWorkflowId === 'needs_model' && restarts.includes('student'));
    } catch (e) {
        console.log('  BROKEN', e.stack); bad++;
    } finally {
        srv.close();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* held */ }
    }
    console.log(`activate fetch: ${n - bad}/${n} checks passed`);
    process.exit(bad ? 1 : 0);
})();
