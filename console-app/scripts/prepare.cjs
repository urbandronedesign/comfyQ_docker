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

for (const f of ['lib.mjs', 'thunder.mjs', 'spend.mjs']) copy(`tools/runpod/${f}`);
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
console.log(`prepared ${path.relative(process.cwd(), OUT)}: the console, and ${n} workflows`);
