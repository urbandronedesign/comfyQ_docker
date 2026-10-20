// Copies what the installed app needs from the repo into build/comfyq, which
// electron-builder ships beside the app (resources/comfyq): the console itself
// (tools/runpod: server, page, lib, thunder, spend) and the copy of the
// workflow list the app starts from before it refreshes it from GitHub.
// Only real files: the console server runs as a child process, from disk.
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.resolve(__dirname, '..', 'build', 'comfyq');

fs.rmSync(OUT, { recursive: true, force: true });
const copy = (rel) => {
    const from = path.join(REPO, rel), to = path.join(OUT, rel);
    if (!fs.existsSync(from)) throw new Error(`missing ${rel}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
};

// Every module of tools/runpod (tests and the CI-only stock recorder aside): a
// fixed list left booking.mjs out of 0.1.8 and 0.1.9, and the installed app's
// console could not start ("Error") while the repo copy, which has every file, passed.
for (const f of fs.readdirSync(path.join(REPO, 'tools/runpod'))) {
    if (/\.mjs$/.test(f) && !/\.test\.mjs$/.test(f) && f !== 'stock-recorder.mjs' && f !== 'runpod.mjs') copy(`tools/runpod/${f}`);
}
for (const f of fs.readdirSync(path.join(REPO, 'tools/runpod/console'))) {
    if (/\.(mjs|js|html|css)$/.test(f)) copy(`tools/runpod/console/${f}`);
}
copy('tools/model-provenance/workflow-downloads.json');

let n = 0;
for (const e of fs.readdirSync(path.join(REPO, 'workflows'), { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('_')) continue;
    for (const f of [`${e.name}.meta.json`, `${e.name}.runtime.json`]) {
        if (fs.existsSync(path.join(REPO, 'workflows', e.name, f))) copy(`workflows/${e.name}/${f}`);
    }
    n++;
}
// The console's server imports './lib.mjs' etc. as ES modules: mark the folder
// so nothing upstream decides they are CommonJS.
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify({ private: true, type: 'module' }, null, 2));
// ★ Every relative import of what was copied must be there too, or the build
// fails here instead of shipping an app whose console cannot start.
const missing = [];
const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.(mjs|js)$/.test(e.name)) continue;
        const src = fs.readFileSync(full, 'utf8');
        for (const m of src.matchAll(/(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
            const target = path.resolve(path.dirname(full), m[1]);
            if (!fs.existsSync(target)) missing.push(`${path.relative(OUT, full)} → ${m[1]}`);
        }
    }
};
walk(path.join(OUT, 'tools'));
if (missing.length) { console.error(`the packaged console would not start, missing:\n  ${missing.join('\n  ')}`); process.exit(1); }
// ★ And it must actually start: run the packaged server a few seconds, from the
// build folder, with a throwaway home, and look for its "listening" line.
{
    const os = require('os');
    const { spawnSync } = require('child_process');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-'));
    const r = spawnSync(process.execPath, [path.join(OUT, 'tools/runpod/console/server.mjs'), '--no-open'], {
        timeout: 8000, encoding: 'utf8',
        env: { ...process.env, USERPROFILE: home, HOME: home, COMFYQ_CONSOLE_PORT: String(47000 + Math.floor(Math.random() * 900)), COMFYQ_CONSOLE_TOKEN: 'preparecheck0123456789ab', COMFYQ_SECRETS: '' },
    });
    fs.rmSync(home, { recursive: true, force: true });
    if (!/RunPod console:/.test(r.stdout || '')) {
        console.error(`the packaged console did not start:\n${(r.stderr || r.stdout || String(r.error || '')).slice(0, 1500)}`);
        process.exit(1);
    }
}
console.log(`prepared ${path.relative(process.cwd(), OUT)}: the console, and ${n} workflows (every import present, and it starts)`);
