/**
 * Every bundle ships BOTH formats: the `<id>.api.json` ComfyQ executes and the
 * `<id>_template.json` a human opens in ComfyUI.
 *
 * Why this is a test rather than a note in a doc: the two ControlNet bundles
 * shipped 2026-09-25 with an api.json only, and nothing complained. The
 * registry treats a missing template as merely a degraded feature — "Open in
 * ComfyUI" quietly falls back to download-and-drag — so the gap survives a
 * green test run, a clean build and a calibration. It surfaces only when an
 * admin tries to open the graph and cannot.
 *
 * Generate a missing one with `node tools/api-to-ui/convert.mjs <bundle-id>`
 * (needs ComfyUI running with the bundle's node packs); it round-trips the
 * result back through Export (API) and refuses to write a template that does
 * not reproduce its own api.json.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const WORKFLOWS = path.resolve(__dirname, '../../workflows');

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ok   ${name}`); }
    catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

// Bundle folders only: `_`-prefixed ones are staging areas (_candidate_workflows).
function bundles() {
    if (!fs.existsSync(WORKFLOWS)) return [];
    return fs.readdirSync(WORKFLOWS, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('_'))
        .map(d => d.name)
        .filter(id => fs.existsSync(path.join(WORKFLOWS, id, `${id}.api.json`)));
}

console.log('bundle completeness — api.json + template.json');

const ids = bundles();

test('there are bundles to check', () => {
    assert.ok(ids.length > 0, `no bundles found under ${WORKFLOWS}`);
});

test('every bundle ships a human-readable template beside its api.json', () => {
    // The registry tolerates filename variance (any `*template.json`), so match
    // the same way rather than insisting on the canonical name here — the name
    // is checked separately below so the two failures read differently.
    const missing = ids.filter(id => {
        const dir = path.join(WORKFLOWS, id);
        return !fs.readdirSync(dir).some(f => /template\.json$/i.test(f));
    });
    assert.deepStrictEqual(missing, [],
        `${missing.length} bundle(s) have no ComfyUI template — run ` +
        `"node tools/api-to-ui/convert.mjs ${missing.join(' ')}"`);
});

test('templates use the canonical <id>_template.json name', () => {
    const odd = ids.filter(id => {
        const dir = path.join(WORKFLOWS, id);
        const files = fs.readdirSync(dir).filter(f => /template\.json$/i.test(f));
        return files.length > 0 && !files.includes(`${id}_template.json`);
    });
    assert.deepStrictEqual(odd, [], `non-canonical template filename in: ${odd.join(', ')}`);
});

test('templates are UI/litegraph format, not a second copy of the api.json', () => {
    // A template is a litegraph serialization: a `nodes` ARRAY. An api.json is
    // an object keyed by node id. Copying the api.json to the template name
    // would satisfy the check above and still be useless in the editor — it
    // loads as an empty graph.
    const bad = [];
    for (const id of ids) {
        const p = path.join(WORKFLOWS, id, `${id}_template.json`);
        if (!fs.existsSync(p)) continue;
        let g;
        try { g = JSON.parse(fs.readFileSync(p, 'utf8')); }
        catch (e) { bad.push(`${id} (unparseable: ${e.message})`); continue; }
        if (!Array.isArray(g.nodes)) bad.push(`${id} (no nodes array — API format?)`);
        else if (g.nodes.length === 0) bad.push(`${id} (empty graph)`);
    }
    assert.deepStrictEqual(bad, [], `not a usable UI graph: ${bad.join(', ')}`);
});

test('every api.json node class appears in its template', () => {
    // Catches a template that has drifted from the graph that actually runs —
    // the failure mode behind "Open in ComfyUI hands over a graph without the
    // feature" (the FastVideo i2v template still lacked the last-frame loader
    // after the api.json gained it).
    //
    // Class composition, not node ids: a template legitimately keeps subgraphs
    // and notes that the flattened api.json does not have, so this is a
    // one-way check — everything that EXECUTES must be present to edit.
    const drifted = [];
    for (const id of ids) {
        const tp = path.join(WORKFLOWS, id, `${id}_template.json`);
        if (!fs.existsSync(tp)) continue;
        const api = JSON.parse(fs.readFileSync(path.join(WORKFLOWS, id, `${id}.api.json`), 'utf8'));
        const tpl = JSON.parse(fs.readFileSync(tp, 'utf8'));

        const inTemplate = new Set();
        const walk = (nodes) => {
            for (const n of nodes || []) {
                if (n.type) inTemplate.add(n.type);
                if (Array.isArray(n.nodes)) walk(n.nodes);       // nested definitions
            }
        };
        walk(tpl.nodes);
        // Subgraph definitions live outside `nodes`; a template built from
        // ComfyUI's own export keeps the real classes in there.
        for (const d of tpl.definitions?.subgraphs || []) walk(d.nodes);

        const needed = new Set(Object.values(api).map(n => n.class_type));
        const absent = [...needed].filter(c => !inTemplate.has(c));
        // A template made of subgraphs exposes none of its inner classes at the
        // top level; only flag one that shares NO class with its api.json,
        // which is the real "wrong file" case.
        if (absent.length === needed.size && needed.size > 0) {
            drifted.push(`${id} (template shares no node class with its api.json)`);
        }
    }
    assert.deepStrictEqual(drifted, [], drifted.join(', '));
});

// ★ Every model a bundle declares must say where it comes from, or a rig that
// does not have it can only be told "missing" with nowhere to go. The links are
// harvested from the workflows' own notes by tools/model-provenance, so a new
// bundle normally gets this for free — this check is what makes sure nobody
// ships one that quietly has no source.
//
// The exceptions are named, not a count: these are community files whose origin
// genuinely is not recorded anywhere, and a guessed URL would be worse than the
// gap (it would download the wrong weights). Shrink this list, never grow it
// without knowing why.
// Empty since 2026-10-20: the last two (the Krea 2 character-sheet LoRAs) were
// found online and SHA-256-checked against the rig's own copies.
const UNSOURCED_OK = new Set([]);

test('every declared model says where it comes from', () => {
    const base = (v) => String(v || '').split('\\').join('/').split('/').pop();
    const gaps = [];
    for (const id of ids) {
        const mp = path.join(WORKFLOWS, id, `${id}.meta.json`);
        if (!fs.existsSync(mp)) continue;
        const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
        for (const m of (meta.requirements?.models || [])) {
            // `auto` means a node pack fetches it: declared and excused.
            if (m.auto || m.url || m.source) continue;
            if (UNSOURCED_OK.has(base(m.file))) continue;
            gaps.push(`${id} -> ${m.file}`);
        }
    }
    assert.deepStrictEqual(gaps, [],
        `no url/source for:\n       ${gaps.join('\n       ')}\n`
        + '       Add it to tools/model-provenance/known-sources.json, then run\n'
        + '       node tools/model-provenance/harvest.cjs --write');
});

console.log(`\n${passed} checks passed over ${ids.length} bundles`);
if (process.exitCode) process.exit(process.exitCode);
