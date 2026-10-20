#!/usr/bin/env node
/**
 * Would every workflow fetch its models on a FRESH machine (a new Pod, a
 * Thunder instance)? Runs the server's own code — the Pod plan's
 * missingModels() and the downloader's resolveDestination() — against an empty
 * ComfyUI folder, so this check cannot disagree with what a Pod will do.
 *
 * For each workflow it checks that every model the graph loads:
 *   1. has a direct url, or is fetched by its node pack (auto);
 *   2. has a destination folder the downloader can decide;
 *   3. once a file sits at that destination, is FOUND by the graph check
 *      (proves the folder and the name are the ones the loader reads);
 *   4. answers on HuggingFace with the token the console holds (--online):
 *      a gated repo whose licence was not accepted fails here, not on a Pod.
 * and reports the download size per workflow, so a disk too small shows up too.
 *
 *   node tools/model-provenance/fresh-machine.cjs            # offline checks
 *   node tools/model-provenance/fresh-machine.cjs --online   # + HEAD every link
 *   node tools/model-provenance/fresh-machine.cjs --json out.json
 *   node tools/model-provenance/fresh-machine.cjs --online --write-sizes
 *       also writes workflow-downloads.json (what each workflow downloads and how
 *       big each file is), which the console reads to size a machine's disk.
 *
 * The token is read from ~/.comfyq/runpod-console.json (hfToken) or HF_TOKEN,
 * and is only ever sent to huggingface.co. Exit code 1 when anything fails.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const { missingModels } = require(path.join(REPO, 'server/cloud/podPlan.js'));
const { resolveDestination } = require(path.join(REPO, 'server/models/modelDestination.js'));
const { invalidateModelIndex } = require(path.join(REPO, 'server/workflows/vramEstimate.js'));
const { WorkflowRegistry } = require(path.join(REPO, 'server/workflows/workflowRegistry.js'));

const args = process.argv.slice(2);
const ONLINE = args.includes('--online');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const WRITE_SIZES = args.includes('--write-sizes');
if (WRITE_SIZES && !ONLINE) { console.error('--write-sizes needs --online (the sizes come from the HEAD requests)'); process.exit(2); }
const SKIP = new Set((process.env.COMFYQ_AUDIT_SKIP || '').split(',').filter(Boolean));
// --allow a,b: bundles KNOWN to fail, reported but not failing the run. For the
// test suite, so a NEW failure stands out. Keep it short and say why in the caller.
const ALLOW = new Set(args.includes('--allow') ? args[args.indexOf('--allow') + 1].split(',').filter(Boolean) : []);

function hfToken() {
    if (process.env.HF_TOKEN) return process.env.HF_TOKEN;
    try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.comfyq', 'runpod-console.json'), 'utf8')).hfToken || null; }
    catch { return null; }
}

async function head(url, token) {
    const host = new URL(url).hostname;
    const headers = token && /(^|\.)huggingface\.co$/.test(host) ? { Authorization: `Bearer ${token}` } : {};
    for (let i = 0; i < 3; i++) {
        try {
            const r = await fetch(url, { method: 'HEAD', redirect: 'manual', headers, signal: AbortSignal.timeout(20000) });
            const size = Number(r.headers.get('x-linked-size') || r.headers.get('content-length')) || null;
            return { status: r.status, size };
        } catch (e) { if (i === 2) return { status: 0, size: null, error: e.message }; }
    }
}

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfyq-fresh-'));
    fs.mkdirSync(path.join(root, 'models'), { recursive: true });
    fs.mkdirSync(path.join(root, 'custom_nodes'), { recursive: true });
    const registry = new WorkflowRegistry(path.join(REPO, 'workflows'));
    if (registry.load) registry.load();
    const ids = registry.list({ includeHidden: true }).map(e => e.id || e.summary?.id).filter(Boolean).sort();

    const token = ONLINE ? hfToken() : null;
    if (ONLINE && !token) console.log('note: no HuggingFace token found — gated links will read 401');
    const headCache = new Map();
    const report = [];

    for (const id of ids) {
        const entry = registry.get(id);
        const row = { id, experimental: !!entry.summary?.experimental, problems: [], files: [], bytes: 0, unknownSize: 0 };
        if (SKIP.has(id)) { row.skipped = true; report.push(row); continue; }
        // ★ A bundle the registry could not load has no graph, so it would read as
        // "0 models, ok" — the silent pass this audit exists to prevent.
        if (entry.unavailable || !entry.apiWorkflow || !Object.keys(entry.apiWorkflow).length) {
            row.problems.push(`the registry cannot load this bundle: ${entry.reason || 'no graph'}`);
            report.push(row); continue;
        }
        invalidateModelIndex();
        const missing = missingModels(entry, root);
        for (const m of missing) {
            const f = { name: m.file, auto: m.auto, url: m.url, dest: null };
            row.files.push(f);
            if (m.auto) continue;
            if (!m.url) { row.problems.push(`${m.file}: no direct link${m.source ? ` (only ${m.source})` : ''}`); continue; }
            const t = resolveDestination({ comfyRoot: root, url: m.url, type: m.type, file: m.file, dir: m.dir || undefined });
            if (!t.dir) { row.problems.push(`${m.file}: downloader cannot decide its folder (${t.why})`); continue; }
            f.dest = `models/${t.dir}/${t.name}`;
            if (ONLINE) {
                if (!headCache.has(m.url)) headCache.set(m.url, await head(m.url, token));
                const h = headCache.get(m.url);
                f.http = h.status; f.size = h.size;
                if (h.status === 401 || h.status === 403) row.problems.push(`${m.file}: HTTP ${h.status} — gated; accept the licence on ${m.url.split('/resolve/')[0]} with the console's HF account`);
                else if (!(h.status >= 200 && h.status < 400)) row.problems.push(`${m.file}: HTTP ${h.status || h.error} on ${m.url}`);
                if (h.size) row.bytes += h.size; else row.unknownSize++;
            }
        }
        // Place an (empty) file at every resolved destination and ask the graph
        // check again: anything still missing would be downloaded to a folder or
        // under a name the loader does not read.
        const placed = [];
        for (const f of row.files) {
            if (!f.dest) continue;
            const abs = path.join(root, f.dest);
            if (!fs.existsSync(abs)) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, ''); placed.push(abs); }
        }
        invalidateModelIndex();
        const still = missingModels(entry, root).filter(m => !m.auto);
        for (const m of still) {
            const f = row.files.find(x => x.name === m.file);
            if (f?.dest) row.problems.push(`${m.file}: downloaded to ${f.dest}, but the workflow still cannot find it there`);
        }
        for (const abs of placed) fs.rmSync(abs, { force: true });
        report.push(row);
    }
    fs.rmSync(root, { recursive: true, force: true });

    const gb = (b) => (b / 1e9).toFixed(1);
    const bad = report.filter(r => r.problems.length);
    console.log(`${report.length} workflows checked against an empty ComfyUI${ONLINE ? ', every link HEAD-checked' : ''}\n`);
    for (const r of report) {
        if (r.skipped) { console.log(`  SKIP  ${r.id}`); continue; }
        const size = ONLINE ? ` ${gb(r.bytes)} GB${r.unknownSize ? ` (+${r.unknownSize} unknown)` : ''}` : '';
        const autos = r.files.filter(f => f.auto).length;
        console.log(`  ${r.problems.length ? 'FAIL' : ' ok '}  ${r.id}  — ${r.files.length} model(s)${autos ? `, ${autos} by its node pack` : ''}${size}`);
        for (const p of r.problems) console.log(`          ✗ ${p}`);
    }
    console.log(`\n${report.length - bad.length - report.filter(r => r.skipped).length} ok, ${bad.length} with problems, ${report.filter(r => r.skipped).length} skipped`);
    if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
    if (WRITE_SIZES) {
        const out = { _README: 'Generated by fresh-machine.cjs --online --write-sizes. What each workflow downloads on a fresh machine, and the size of each file in bytes. Read by the RunPod/Thunder console to size a disk. Regenerate after adding a workflow or changing a model.', generatedAt: new Date().toISOString(), workflows: {}, sizes: {} };
        for (const r of report) {
            if (r.skipped) continue;
            out.workflows[r.id] = { files: r.files.filter(f => !f.auto && f.url).map(f => f.name), byNodePack: r.files.filter(f => f.auto).map(f => f.name), problems: r.problems.length };
            for (const f of r.files) if (f.size) out.sizes[f.name] = f.size;
        }
        const file = path.join(__dirname, 'workflow-downloads.json');
        fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
        console.log(`wrote ${path.relative(REPO, file)}`);
    }
    const unexpected = bad.filter(r => !ALLOW.has(r.id));
    for (const id of ALLOW) if (!bad.some(r => r.id === id)) console.log(`note: ${id} is on --allow but passes now — take it off the list`);
    if (ALLOW.size) console.log(unexpected.length ? `${unexpected.length} NEW failure(s): ${unexpected.map(r => r.id).join(', ')}` : `fresh-machine: no new failures (${bad.length} known, allowed)`);
    process.exit(unexpected.length ? 1 : 0);
})().catch(e => { console.error('AUDIT BROKEN:', e.stack || e.message); process.exit(2); });
