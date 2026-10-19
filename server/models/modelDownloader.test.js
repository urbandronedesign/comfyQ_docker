// Fetching a model onto this machine: placement, resume, and every refusal.
// (node server/models/modelDownloader.test.js)
//
// The transfer is exercised against a real local HTTP server rather than a
// stubbed fetch, because the things that go wrong here are protocol things —
// a server that ignores Range, a 416, a truncated body, a gated 401 — and a
// stub would only prove the stub agrees with itself.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { destinationFor, resolveDestination } = require('./modelDestination');
const { ModelDownloader } = require('./modelDownloader');

const ok = [];
const check = (label, cond) => { assert.ok(cond, label); ok.push(label); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfyq-dl-'));
const comfy = path.join(root, 'ComfyUI');
fs.mkdirSync(path.join(comfy, 'models'), { recursive: true });

// ---------------------------------------------------------------- placement
// ★ A file in the wrong folder is invisible to ComfyUI AND reads as unused on
// the next prune, so placement is the part that must not guess.
check('the folder is read off the download link',
    destinationFor({ url: 'https://huggingface.co/o/r/resolve/main/vae/x.safetensors' }).dir === 'vae');
check('a nested repo path still finds it',
    destinationFor({ url: 'https://huggingface.co/o/r/resolve/main/split_files/text_encoders/x.safetensors' }).dir
    === 'text_encoders');
check('unet in the link is redirected to diffusion_models, where this install keeps them',
    destinationFor({ url: 'https://huggingface.co/o/r/resolve/main/unet/x.safetensors' }).dir === 'diffusion_models');
check('with no folder in the link, the declared type decides',
    destinationFor({ url: 'https://huggingface.co/o/r/resolve/main/x.safetensors', type: 'lora' }).dir === 'loras');
check('and when neither says, it REFUSES rather than guessing',
    destinationFor({ url: 'https://huggingface.co/o/r/resolve/main/x.safetensors', type: 'other' }).dir === null);
check('a declared type is never allowed to override the link',
    destinationFor({ url: 'https://huggingface.co/o/r/resolve/main/vae/x.safetensors', type: 'lora' }).dir === 'vae');

// Untrusted input: a filename comes off a URL, so it must not be able to steer
// the write anywhere but into a model folder.
check('a traversal in the filename is reduced to a basename',
    resolveDestination({ comfyRoot: comfy, type: 'lora', file: '../../../../evil.safetensors', url: 'https://x/a.safetensors' })
        .abs === path.resolve(comfy, 'models', 'loras', 'evil.safetensors'));
check('an explicit folder must be one this layout uses',
    resolveDestination({ comfyRoot: comfy, url: 'https://x/a.safetensors', dir: '../../etc' }).abs === null);
check('...and a real one is honoured',
    resolveDestination({ comfyRoot: comfy, url: 'https://x/a.safetensors', dir: 'latent_upscale_models' }).dir
    === 'latent_upscale_models');

// ---------------------------------------------------------------- transfer
const BODY = Buffer.alloc(64 * 1024, 7);
const stalledResponses = [];
let mode = 'normal';
const server = http.createServer((req, res) => {
    if (mode === 'gated') { res.writeHead(401); return res.end(); }
    if (mode === 'notfound') { res.writeHead(404); return res.end(); }
    const range = req.headers.range;
    if (mode === 'ignore-range') {            // a server that restarts regardless
        res.writeHead(200, { 'content-length': String(BODY.length) });
        return res.end(BODY);
    }
    if (mode === 'truncate') {                // promises more, sends some, hangs up
        res.writeHead(200, { 'content-length': String(BODY.length) });
        res.write(BODY.subarray(0, 1024));
        return setTimeout(() => res.destroy(), 20);
    }
    if (mode === 'stall') {                   // promises more, sends some, goes quiet
        res.writeHead(200, { 'content-length': String(BODY.length) });
        res.write(BODY.subarray(0, 1024));
        stalledResponses.push(res);
        return;
    }
    if (range) {
        const from = Number(/bytes=(\d+)-/.exec(range)?.[1] || 0);
        if (from >= BODY.length) { res.writeHead(416); return res.end(); }
        const slice = BODY.subarray(from);
        res.writeHead(206, { 'content-length': String(slice.length) });
        return res.end(slice);
    }
    res.writeHead(200, { 'content-length': String(BODY.length) });
    res.end(BODY);
});

const settle = async (dl, key, tries = 200) => {
    for (let i = 0; i < tries; i++) {
        const j = dl.list().find(x => x.key === key);
        if (j && !['queued', 'downloading'].includes(j.status)) return j;
        await new Promise(r => setTimeout(r, 25));
    }
    return dl.list().find(x => x.key === key);
};

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const cfg = () => ({ comfy_ui: { root_path: comfy, hf_token: 'tok' } });
    const dl = new ModelDownloader({ config: cfg, stallMs: 400 });

    // https-only is checked before anything else, so point the test at the
    // local server through the internal API rather than the public guard.
    const httpsOnly = dl.enqueue({ name: 'x.safetensors', url: `${base}/x.safetensors`, type: 'lora' });
    check('plain http is refused', httpsOnly.ok === false && /https/.test(httpsOnly.error));

    // Bypass only that one guard for the transfer tests.
    const realEnqueue = dl.enqueue.bind(dl);
    dl.enqueue = (o) => realEnqueue({ ...o, url: o.url.replace(/^http:/, 'https:') });
    const origFetch = global.fetch;
    global.fetch = (u, init) => origFetch(String(u).replace(/^https:/, 'http:'), init);

    // 1. the happy path, and the .part discipline
    let r = dl.enqueue({ name: 'good.safetensors', url: `${base}/good.safetensors`, type: 'lora' });
    check('a download is accepted and placed by type', r.ok && r.dest === 'models/loras/good.safetensors');
    let j = await settle(dl, r.key);
    const dest = path.join(comfy, 'models', 'loras', 'good.safetensors');
    check('it completes', j.status === 'done');
    check('the file is there, whole', fs.statSync(dest).size === BODY.length);
    check('★ and no .part is left behind — a half file would read as INSTALLED',
        !fs.existsSync(dest + '.part'));

    // 2. never overwrite something already installed
    r = dl.enqueue({ name: 'good.safetensors', url: `${base}/good.safetensors`, type: 'lora' });
    check('an already-installed model is not re-downloaded over', r.ok === false && /already installed/.test(r.error));

    // 3. ★ resume: a partial .part is continued, not restarted
    const partDest = path.join(comfy, 'models', 'loras', 'half.safetensors');
    fs.writeFileSync(partDest + '.part', BODY.subarray(0, 20 * 1024));
    r = dl.enqueue({ name: 'half.safetensors', url: `${base}/half.safetensors`, type: 'lora' });
    j = await settle(dl, r.key);
    check('a partial download resumes to the right size', j.status === 'done'
        && fs.statSync(partDest).size === BODY.length);
    check('...and the bytes are correct, not doubled up',
        Buffer.compare(fs.readFileSync(partDest), BODY) === 0);

    // 4. ★ a server that ignores Range must restart, not append
    const ignDest = path.join(comfy, 'models', 'loras', 'ignored.safetensors');
    fs.writeFileSync(ignDest + '.part', BODY.subarray(0, 20 * 1024));
    mode = 'ignore-range';
    r = dl.enqueue({ name: 'ignored.safetensors', url: `${base}/ignored.safetensors`, type: 'lora' });
    j = await settle(dl, r.key);
    check('a server that ignores Range does not corrupt the file',
        j.status === 'done' && fs.statSync(ignDest).size === BODY.length
        && Buffer.compare(fs.readFileSync(ignDest), BODY) === 0);

    // 5. a .part that is already complete (416)
    const fullDest = path.join(comfy, 'models', 'loras', 'allthere.safetensors');
    fs.writeFileSync(fullDest + '.part', BODY);
    mode = 'normal';
    r = dl.enqueue({ name: 'allthere.safetensors', url: `${base}/allthere.safetensors`, type: 'lora' });
    j = await settle(dl, r.key);
    check('a complete .part is just renamed (416 handled)',
        j.status === 'done' && fs.existsSync(fullDest) && !fs.existsSync(fullDest + '.part'));

    // 6. ★ a truncated body must NOT become a model
    mode = 'truncate';
    r = dl.enqueue({ name: 'short.safetensors', url: `${base}/short.safetensors`, type: 'lora' });
    j = await settle(dl, r.key);
    const shortDest = path.join(comfy, 'models', 'loras', 'short.safetensors');
    check('a truncated transfer fails rather than installing a stub', j.status === 'failed');
    check('...the model file is NOT created', !fs.existsSync(shortDest));
    check('...the .part is kept so it can be resumed', fs.existsSync(shortDest + '.part'));

    // 6b. ★ a server that goes quiet mid-file. Under Node 24 the connection
    // simply stays open, so without a stall timeout this download would read
    // "downloading" for ever — and on a shared volume hold its lock for ever.
    mode = 'stall';
    fs.rmSync(shortDest + '.part', { force: true });
    r = dl.enqueue({ name: 'short.safetensors', url: `${base}/short.safetensors`, type: 'lora' });
    j = await settle(dl, r.key);
    check('a stalled transfer fails instead of hanging', j.status === 'failed' && /stalled/.test(j.error || ''));
    check('...without creating the model file', !fs.existsSync(shortDest));
    check('...keeping the .part to resume', fs.existsSync(shortDest + '.part'));
    for (const sr of stalledResponses.splice(0)) sr.destroy();

    // 7. a gated repo says what to do about it
    mode = 'gated';
    r = dl.enqueue({ name: 'gated.safetensors', url: `${base}/gated.safetensors`, type: 'lora' });
    j = await settle(dl, r.key);
    check('a gated repo fails with advice, not a status code',
        j.status === 'failed' && /gated/.test(j.error) && /token/.test(j.error));

    mode = 'notfound';
    r = dl.enqueue({ name: 'missing.safetensors', url: `${base}/missing.safetensors`, type: 'lora' });
    j = await settle(dl, r.key);
    check('a 404 is reported as such', j.status === 'failed' && /404/.test(j.error));

    // 8. an undecidable destination is refused, and says it needs a folder
    const und = dl.enqueue({ name: 'where.safetensors', url: `${base}/where.safetensors`, type: 'other' });
    check('a file with nowhere to go is refused', und.ok === false);
    check('...and asks for a folder rather than guessing', und.needsDir === true);

    // 9. one at a time, and a finished row can be forgotten
    mode = 'normal';
    const a = dl.enqueue({ name: 'q1.safetensors', url: `${base}/q1.safetensors`, type: 'loras' ? 'lora' : 'lora' });
    const b = dl.enqueue({ name: 'q2.safetensors', url: `${base}/q2.safetensors`, type: 'lora' });
    check('a second download queues behind the first',
        dl.list().filter(x => ['queued', 'downloading'].includes(x.status)).length === 2
        && dl.list().filter(x => x.status === 'downloading').length <= 1);
    await settle(dl, a.key); await settle(dl, b.key);
    check('both finish', dl.list().filter(x => [a.key, b.key].includes(x.key))
        .every(x => x.status === 'done'));
    check('a finished row can be forgotten', dl.forget(a.key).ok === true
        && !dl.list().some(x => x.key === a.key));

    global.fetch = origFetch;
    await new Promise(r => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
    console.log(`modelDownloader: all ${ok.length} checks passed`);
})().catch(e => {
    console.error('FAILED:', e.message);
    try { server.close(); fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(1);
});
