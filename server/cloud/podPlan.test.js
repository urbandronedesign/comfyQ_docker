// A Pod configured by its environment: does it store the secrets without
// rotating them, refuse to serve open, fetch what is missing, and only then
// serve? (node server/cloud/podPlan.test.js)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');

const { applyEnv, runPlan, missingModels, readPlan } = require('./podPlan');

const ok = [];
const check = (label, cond) => { assert.ok(cond, label); ok.push(label); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfyq-podplan-'));
const comfyRoot = path.join(dir, 'ComfyUI');
fs.mkdirSync(path.join(comfyRoot, 'models', 'checkpoints'), { recursive: true });
fs.writeFileSync(path.join(comfyRoot, 'main.py'), '');
fs.writeFileSync(path.join(comfyRoot, 'models', 'checkpoints', 'have.safetensors'), 'x');
const planFile = path.join(dir, 'pod-plan.json');

// In-memory config with the same load/update shape as configManager.
const makeConfig = () => {
    let c = { mode: 'admin', auth: { adminPasswordHash: '', accessPasswordHash: '' },
        comfy_ui: { root_path: comfyRoot, hf_token: '' },
        workflows: { activeWorkflowId: null, extraLaneWorkflowIds: ['old'] } };
    return { load: () => ({ config: c }), update: (fn) => { c = fn(JSON.parse(JSON.stringify(c))); return c; } };
};
const makeFlags = () => {
    const f = { serving: true, oneShot: true };
    return { f, setServingIntent: (on) => { f.serving = on; }, consumeStudentBootFlag: () => { const was = f.oneShot; f.oneShot = false; return was; } };
};

const graph = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'have.safetensors' } },
    2: { class_type: 'LoraLoader', inputs: { lora_name: 'need.safetensors' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: 'nolink.safetensors' } },
};
const entry = (models) => ({ apiWorkflow: graph, summary: { models } });
const linked = [
    { file: 'need.safetensors', url: 'https://huggingface.co/x/y/resolve/main/loras/need.safetensors', type: 'lora' },
    { file: 'nolink.safetensors', source: 'https://example.com/page', type: 'vae' },
];
const registryOf = (map) => ({ get: (id) => map[id] || null });

const env = (extra = {}) => ({ COMFYQ_ADMIN_PASSWORD: 'Zq7-admin-secret', COMFYQ_ACCESS_PASSWORD: 'stu', ...extra });

(async () => {
    // ---- secrets -----------------------------------------------------------
    {
        const cm = makeConfig();
        const out = applyEnv({ env: { ...env(), HF_TOKEN: 'hf_abc' }, configManager: cm, registry: registryOf({}), servingFlags: makeFlags(), planFile });
        const c = cm.load().config;
        check('the admin password is stored hashed', bcrypt.compareSync('Zq7-admin-secret', c.auth.adminPasswordHash));
        check('the access password is stored hashed', bcrypt.compareSync('stu', c.auth.accessPasswordHash));
        check('HF_TOKEN is accepted for the HuggingFace token', c.comfy_ui.hf_token === 'hf_abc');
        check('the summary names what changed, never a value', out.changed.length === 3 && !JSON.stringify(out).includes('Zq7-admin-secret') && !JSON.stringify(out).includes('hf_abc'));

        const hash = c.auth.accessPasswordHash;
        const again = applyEnv({ env: env(), configManager: cm, registry: registryOf({}), servingFlags: makeFlags(), planFile });
        check('the same password on the next start does not rotate the hash (students stay logged in)',
            cm.load().config.auth.accessPasswordHash === hash && again.changed.length === 0);
        check('no COMFYQ_SERVE writes no plan', !fs.existsSync(planFile));
    }

    // ---- refusing to serve open --------------------------------------------
    {
        const flags = makeFlags();
        const out = applyEnv({ env: { COMFYQ_SERVE: 'wf' }, configManager: makeConfig(), registry: registryOf({ wf: entry(linked) }), servingFlags: flags, planFile });
        check('serving with no admin password is refused', out.plan.status === 'refused');
        check('...naming the missing variable', /COMFYQ_ADMIN_PASSWORD/.test(out.plan.error));
        check('...and the machine is not left serving', flags.f.serving === false);
        const open = applyEnv({ env: { COMFYQ_SERVE: 'wf', COMFYQ_ALLOW_OPEN: '1' }, configManager: makeConfig(), registry: registryOf({ wf: entry(linked) }), servingFlags: makeFlags(), planFile });
        check('COMFYQ_ALLOW_OPEN=1 serves open on purpose', open.plan.status === 'pending');
        const noStudent = applyEnv({ env: { COMFYQ_SERVE: 'wf', COMFYQ_ADMIN_PASSWORD: 'Zq7-admin-secret' }, configManager: makeConfig(), registry: registryOf({ wf: entry(linked) }), servingFlags: makeFlags(), planFile });
        check('no student password is fine: anyone with the link may book', noStudent.plan.status === 'pending');
    }

    // ---- unknown workflow --------------------------------------------------
    {
        const out = applyEnv({ env: env({ COMFYQ_SERVE: 'wf,nope' }), configManager: makeConfig(), registry: registryOf({ wf: entry(linked) }), servingFlags: makeFlags(), planFile });
        check('an unknown workflow id fails the plan by name', out.plan.status === 'failed' && /nope/.test(out.plan.error));
    }

    // ---- missingModels -----------------------------------------------------
    {
        const miss = missingModels(entry(linked), comfyRoot);
        check('an installed model is not reported missing', !miss.some(m => m.name === 'have.safetensors'));
        check('a missing model carries its direct link', miss.find(m => m.name === 'need.safetensors')?.url);
        check('a missing model with only a page carries no url', miss.find(m => m.name === 'nolink.safetensors')?.url === null);
    }

    // ---- runPlan: a file with no direct link fails, and nothing is served ---
    {
        const cm = makeConfig();
        const flags = makeFlags();
        applyEnv({ env: env({ COMFYQ_SERVE: 'wf' }), configManager: cm, registry: registryOf({ wf: entry(linked) }), servingFlags: flags, planFile });
        check('a valid request boots admin first (serving markers cleared)', flags.f.serving === false && flags.f.oneShot === false);
        const downloader = fakeDownloader();
        let restarted = null;
        const plan = await runPlan({ configManager: cm, registry: registryOf({ wf: entry(linked) }), downloader, exitForRestart: (m) => { restarted = m; }, planFile, pollMs: 5, log: () => {} });
        check('a model with no direct link fails the plan', plan.status === 'failed' && /nolink\.safetensors/.test(plan.error));
        check('...pointing at where to get it', /example\.com\/page/.test(plan.error));
        check('...and the machine does not switch to serving', restarted === null && cm.load().config.mode === 'admin');
        fs.rmSync(path.join(comfyRoot, 'models', 'loras'), { recursive: true, force: true });
    }

    // ---- runPlan: everything fetchable -> fetched, then served -------------
    {
        const models = [linked[0], { file: 'nolink.safetensors', url: 'https://huggingface.co/x/y/resolve/main/vae/nolink.safetensors', type: 'vae' }];
        const reg = registryOf({ wf: entry(models), wf2: entry(models) });
        const cm = makeConfig();
        applyEnv({ env: env({ COMFYQ_SERVE: 'wf, wf2' }), configManager: cm, registry: reg, servingFlags: makeFlags(), planFile });
        const downloader = fakeDownloader();
        let restarted = null;
        const plan = await runPlan({ configManager: cm, registry: reg, downloader, exitForRestart: (m) => { restarted = m; }, planFile, pollMs: 5, log: () => {} });
        check('two workflows sharing a model fetch it once', downloader.enqueued.length === 2);
        check('the declared filename is what gets saved', downloader.enqueued.every(e => e.name.endsWith('.safetensors')));
        check('the files land on disk', fs.existsSync(path.join(comfyRoot, 'models', 'loras', 'need.safetensors')));
        check('the plan ends done', plan.status === 'done');
        const c = cm.load().config;
        check('the first workflow is the primary lane', c.workflows.activeWorkflowId === 'wf');
        check('the rest replace the remembered extra lanes', JSON.stringify(c.workflows.extraLaneWorkflowIds) === '["wf2"]');
        check('it restarts into student mode', restarted === 'student');
        const second = await runPlan({ configManager: cm, registry: reg, downloader, exitForRestart: () => { throw new Error('ran twice'); }, planFile, pollMs: 5, log: () => {} });
        check('a finished plan does not run again', second.status === 'done');
    }

    // ---- COMFYQ_FETCH_MODELS=0 --------------------------------------------
    {
        const cm = makeConfig();
        const reg = registryOf({ wf: entry(linked) });
        applyEnv({ env: env({ COMFYQ_SERVE: 'wf', COMFYQ_FETCH_MODELS: '0' }), configManager: cm, registry: reg, servingFlags: makeFlags(), planFile });
        let restarted = null;
        const downloader = fakeDownloader();
        await runPlan({ configManager: cm, registry: reg, downloader, exitForRestart: (m) => { restarted = m; }, planFile, pollMs: 5, log: () => {} });
        check('COMFYQ_FETCH_MODELS=0 serves without fetching', restarted === 'student' && downloader.enqueued.length === 0);
    }

    // ---- no COMFYQ_SERVE clears an old plan ---------------------------------
    {
        applyEnv({ env: {}, configManager: makeConfig(), registry: registryOf({}), servingFlags: makeFlags(), planFile });
        check('a start without COMFYQ_SERVE removes the old plan', !fs.existsSync(planFile));
    }

    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`podPlan: ${ok.length} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });

// Writes the file into models/<folder from the link> straight away, as a
// finished download would.
function fakeDownloader() {
    const jobs = new Map();
    const enqueued = [];
    return {
        enqueued,
        enqueue({ name, url }) {
            const folder = url.split('/resolve/main/')[1].split('/')[0];
            const abs = path.join(comfyRoot, 'models', folder, path.basename(name));
            if (fs.existsSync(abs)) return { ok: false, error: `${name} is already installed` };
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, 'w');
            enqueued.push({ name, url });
            const key = abs.toLowerCase();
            jobs.set(key, { key, status: 'done', received: 1, total: 1 });
            return { ok: true, key, dest: `models/${folder}/${name}` };
        },
        list: () => [...jobs.values()],
    };
}
