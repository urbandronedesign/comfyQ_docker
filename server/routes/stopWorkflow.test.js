// node server/routes/stopWorkflow.test.js
//
// "Stop serving" on one workflow keeps the others (owner, 2026-10-21: on a
// machine serving SDXL + FLUX.3, stopping SDXL — the primary lane — took FLUX.3
// down with it and left nothing served). POST /admin/stop-workflow: an extra
// lane closes; the primary going while others serve promotes the next one and
// restarts into serving; the last one going puts the machine in admin mode.
'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { makeRouter } = require('./admin');
const { adminGate } = require('../auth/authGate');

let n = 0, bad = 0;
const check = (name, ok) => { n++; if (!ok) { bad++; console.log(`  FAIL ${name}`); } };

const entries = Object.fromEntries(['sdxl', 'flux3', 'ltx'].map(id => [id, { id, summary: { name: id }, effective: { exposedParameters: [] } }]));
const registry = { get: (id) => entries[id] || null, list: () => Object.values(entries) };

let config, live, restarts, closed;
const configManager = { load: () => ({ config }), update: (fn) => { config = fn(JSON.parse(JSON.stringify(config))) || config; return config; } };
// The lane manager as the route sees it; close() forgets an extra lane in config, like the real one.
const lanes = {
    list: () => live.map(l => ({ ...l })),
    get: (id) => live.find(l => l.workflowId === id) || null,
    close: async (id) => {
        const l = live.find(x => x.workflowId === id);
        live = live.filter(x => x.workflowId !== id);
        closed.push(id);
        if (l && !l.primary) config.workflows.extraLaneWorkflowIds = config.workflows.extraLaneWorkflowIds.filter(x => x !== id);
        return true;
    },
};
function serving(primary, ...extra) {
    config = { mode: 'student', auth: { adminPasswordHash: bcrypt.hashSync('admin-pw', 4) }, workflows: { activeWorkflowId: primary, extraLaneWorkflowIds: [...extra] } };
    live = [{ workflowId: primary, name: primary, primary: true }, ...extra.map(id => ({ workflowId: id, name: id, primary: false }))];
    restarts = []; closed = [];
}

const app = express();
app.use('/admin', makeRouter({ configManager, registry, adminGate: adminGate(configManager), exitForRestart: (m) => restarts.push(m), runtime: { lanes } }));

(async () => {
    const srv = app.listen(0);
    const base = `http://127.0.0.1:${srv.address().port}/admin`;
    const stop = async (workflowId, pw = 'admin-pw') => {
        const r = await fetch(base + '/stop-workflow', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(pw ? { 'X-Admin-Password': pw } : {}) }, body: JSON.stringify({ workflowId }) });
        await new Promise(res => setTimeout(res, 300));   // the restart is scheduled after the answer
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    try {
        serving('sdxl', 'flux3');
        check('without the admin password it is refused', (await stop('sdxl', null)).status === 401 && config.mode === 'student');

        // ---- the owner's case: stop the primary, the other keeps serving ----
        serving('sdxl', 'flux3');
        let r = await stop('sdxl');
        check(`stopping the primary while FLUX.3 serves promotes FLUX.3 (${JSON.stringify(r.body)})`, r.status === 200 && r.body.action === 'promoted' && r.body.primary === 'flux3');
        check(`the config now serves FLUX.3 as primary, nothing extra, still in student mode (${JSON.stringify(config.workflows)})`,
            config.workflows.activeWorkflowId === 'flux3' && config.workflows.extraLaneWorkflowIds.length === 0 && config.mode === 'student');
        check(`it restarts into serving, not into admin mode (${restarts})`, restarts.join() === 'student');
        check(`the promoted lane's own ComfyUI is stopped first, so it cannot linger holding VRAM (${closed})`, closed.join() === 'flux3');

        // ---- three served: the next becomes primary, the third stays extra ----
        serving('sdxl', 'flux3', 'ltx');
        r = await stop('sdxl');
        check(`with three, the next is primary and the third stays (${JSON.stringify(config.workflows)})`,
            r.body.action === 'promoted' && config.workflows.activeWorkflowId === 'flux3' && config.workflows.extraLaneWorkflowIds.join() === 'ltx' && r.body.serving.join() === 'flux3,ltx');

        // ---- an extra lane: it just closes, no restart ----
        serving('sdxl', 'flux3');
        r = await stop('flux3');
        check(`stopping an extra lane closes it only (${JSON.stringify(r.body)})`, r.body.action === 'closed' && closed.join() === 'flux3' && config.workflows.activeWorkflowId === 'sdxl');
        check('and nothing restarts', restarts.length === 0 && config.mode === 'student');

        // ---- the last one: admin mode, as before ----
        serving('sdxl');
        r = await stop('sdxl');
        check(`stopping the only workflow puts the machine in admin mode (${JSON.stringify(r.body)})`, r.body.action === 'admin' && config.mode === 'admin' && restarts.join() === 'admin');

        // ---- a lane whose workflow is gone from the library is not promoted ----
        serving('sdxl', 'gone');
        r = await stop('sdxl');
        check(`a workflow no longer in the library is not promoted: admin mode (${r.body?.action})`, r.body.action === 'admin' && config.mode === 'admin');

        // ---- after a restart with no lanes listed yet, the config is enough ----
        serving('sdxl', 'flux3'); live = [];
        r = await stop('sdxl');
        check(`with no live lane list, the remembered extra lanes are kept (${JSON.stringify(config.workflows)})`, r.body.action === 'promoted' && config.workflows.activeWorkflowId === 'flux3');

        // ---- refusals ----
        serving('sdxl', 'flux3');
        r = await stop('ltx');
        check(`a workflow not served is refused, nothing changes (${r.status})`, r.status === 409 && config.workflows.activeWorkflowId === 'sdxl' && restarts.length === 0);
        config.mode = 'admin'; live = [];
        r = await stop('sdxl');
        check(`in admin mode there is nothing to stop (${r.status})`, r.status === 409 && restarts.length === 0);
    } finally { srv.close(); }
    console.log(`stop workflow: ${n - bad}/${n} checks passed`);
    process.exit(bad ? 1 : 0);
})();
