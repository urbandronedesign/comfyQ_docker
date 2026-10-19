// Phase I6: listing, zipping and deleting the folders Pods leave on a shared
// volume. Real folders under the OS temp dir. (node server/cloud/podFolders.test.js)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { podsRoot, listFolders, refuseDelete, deleteFolder, resolveFolder, zipResults } = require('./podFolders');

const ok = [];
const check = (label, cond) => { assert.ok(cond, label); ok.push(label); };

(async () => {
    const vol = fs.mkdtempSync(path.join(os.tmpdir(), 'comfyq-podfolders-'));
    const root = path.join(vol, 'pods');
    const shared = path.join(vol, 'shared', 'models');
    const write = (rel, bytes) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(bytes)); };
    write('me1/data/comfyq.sqlite', 100);
    write('live2/comfyui/output/a.png', 50);
    write('gone3/comfyui/output/a.png', 1000);
    write('gone3/comfyui/output/sub/b.mp4', 2000);
    write('gone3/comfyui/input/up.jpg', 300);
    write('gone3/data/comfyq.sqlite', 400);
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'model.safetensors'), Buffer.alloc(5000));
    // A link inside a folder pointing at the shared models: must never be
    // counted, zipped through, or deleted through.
    let linked = true;
    try { fs.symlinkSync(shared, path.join(root, 'gone3', 'models-link'), 'junction'); } catch { linked = false; }
    fs.writeFileSync(path.join(root, 'stray.txt'), 'x');

    check('the pods folder is found beside this Pod\'s own', podsRoot({ MINE: path.join(root, 'me1') }) === root);
    check('off the shared layout there is none', podsRoot({}) === null);

    const isAlive = (id) => id === 'live2';
    const list = await listFolders({ root, me: 'me1', isAlive });
    const byId = Object.fromEntries(list.map(f => [f.id, f]));
    check('every Pod folder is listed, files beside them are not', Object.keys(byId).sort().join() === 'gone3,live2,me1');
    check('a folder\'s size is everything in it', byId.gone3.bytes === 3700 && byId.gone3.files === 4);
    check('results are counted on their own', byId.gone3.outputs === 2);
    if (linked) check('a link to the shared models is not counted as the folder\'s size', byId.gone3.bytes === 3700);
    check('this Pod\'s own folder is marked', byId.me1.isMe && !byId.me1.alive);
    check('a Pod with a fresh heartbeat is marked alive', byId.live2.alive);

    check('this Pod refuses to delete its own folder', /own folder/.test(refuseDelete({ id: 'me1', me: 'me1', isAlive })));
    check('or a running Pod\'s', /running/.test(refuseDelete({ id: 'live2', me: 'me1', isAlive })));
    check('a name that is not a Pod folder is refused', !!resolveFolder(root, '../shared').error && !!resolveFolder(root, 'a/b').error);
    check('so is a file', !!resolveFolder(root, 'stray.txt').error);
    let r = await deleteFolder({ root, id: 'live2', me: 'me1', isAlive });
    check('deleting a running Pod\'s folder does nothing', !r.ok && fs.existsSync(path.join(root, 'live2')));
    r = await deleteFolder({ root, id: '..', me: 'me1', isAlive });
    check('".." is refused', !r.ok && fs.existsSync(root));

    // Zip the results, into memory.
    const archiver = require('archiver');
    const chunks = [];
    const headers = {};
    const res = new PassThrough();
    Object.assign(res, { setHeader: (k, v) => { headers[k] = v; }, status: () => res, json: () => res });
    res.on('data', c => chunks.push(c));
    const done = new Promise(r2 => res.on('end', r2));
    zipResults({ root, id: 'gone3', res, archiver });
    await done;
    const zip = Buffer.concat(chunks);
    const names = zip.toString('latin1');
    check('the results zip is a zip', zip.slice(0, 2).toString() === 'PK' && /comfyq-pod-gone3-results\.zip/.test(headers['Content-Disposition']));
    check('it holds the outputs, in folders kept as they were', names.includes('output/a.png') && names.includes('output/sub/b.mp4'));
    check('and the uploads', names.includes('uploads/up.jpg'));
    check('but not the queue database or the shared models', !names.includes('comfyq.sqlite') && !names.includes('model.safetensors'));

    r = await deleteFolder({ root, id: 'gone3', me: 'me1', isAlive });
    check('a folder of a Pod that is gone is deleted when asked', r.ok && r.bytes === 3700 && !fs.existsSync(path.join(root, 'gone3')));
    check('nothing is left half-deleted', !fs.readdirSync(root).some(n => n.startsWith('.deleting-')));
    check('the shared models the link pointed at are untouched', fs.existsSync(path.join(shared, 'model.safetensors')));
    check('the other folders are untouched', fs.existsSync(path.join(root, 'me1/data/comfyq.sqlite')) && fs.existsSync(path.join(root, 'live2/comfyui/output/a.png')));

    // A delete interrupted after the rename is listed and can be finished.
    write('.deleting-old4-123/data/x', 10);
    const again = await listFolders({ root, me: 'me1', isAlive });
    const half = again.find(f => f.id === '.deleting-old4-123');
    check('a delete left unfinished is listed, not hidden', half && half.unfinishedDelete && half.bytes === 10);
    r = await deleteFolder({ root, id: '.deleting-old4-123', me: 'me1', isAlive });
    check('and can be finished', r.ok && !fs.existsSync(path.join(root, '.deleting-old4-123')));

    fs.rmSync(vol, { recursive: true, force: true });
    console.log(`podFolders: all ${ok.length} checks passed`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
