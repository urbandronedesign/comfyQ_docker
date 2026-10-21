// N simulated students against one Pod, to see whether it holds a class.
//
// Each student does what a browser does: loads the student page, opens the
// live socket.io connection, uploads a picture when its workflow needs one,
// and books one job ("as soon as possible"). The bookings are spread over the
// given workflows and over the first minute. One watcher then follows every
// job to the end through GET /jobs, and the socket connections stay open the
// whole time, as a class's tabs would, receiving every broadcast.
//
// The GPU work all happens on the Pod: this only sends what students' browsers
// would send. Used by lanes.mjs (--students N).
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { proxyUrl } from '../lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// The browser's own socket.io client, from the client's dependencies.
const { io } = createRequire(path.join(REPO, 'client', 'package.json'))('socket.io-client');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A 768x512 PNG drawn here (a sky gradient, a sun, a horizon), so the test
// needs no picture of its own.
function testPicture() {
    const W = 768, H = 512;
    const raw = Buffer.alloc((W * 3 + 1) * H);
    for (let y = 0; y < H; y++) {
        raw[y * (W * 3 + 1)] = 0;
        for (let x = 0; x < W; x++) {
            const o = y * (W * 3 + 1) + 1 + x * 3;
            const sky = y < H * 0.62;
            const sun = (x - 520) ** 2 + (y - 210) ** 2 < 60 ** 2;
            const [r, g, b] = sun ? [255, 200, 90] : sky ? [40 + y / 3, 90 + y / 4, 200 - y / 6] : [30 + x / 20, 90 + (y - H * 0.62) / 3, 60];
            raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
        }
    }
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (buf) => { let c = 0xffffffff; for (const v of buf) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type), data]);
        const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
        return Buffer.concat([len, td, c]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// From the bundle's meta: which field takes the prompt, which the picture.
function fieldsOf(workflowId) {
    const meta = JSON.parse(fs.readFileSync(path.join(REPO, 'workflows', workflowId, `${workflowId}.meta.json`), 'utf8'));
    const params = meta.exposedParameters || meta.parameters || [];
    const prompt = params.find(p => p.type === 'textarea' && !/negative/i.test(p.key + ' ' + (p.label || '')));
    const image = params.find(p => p.type === 'image' && p.required !== false);
    return { name: meta.name || workflowId, promptKey: prompt?.key || null, imageKey: image?.key || null };
}

const PROMPTS = [
    'a lighthouse on a cliff at dusk, waves breaking below',
    'a red bicycle leaning against a brick wall in the rain',
    'a fox walking through fresh snow in a pine forest',
    'a ceramic teapot on a wooden table, morning light',
    'an old tram crossing a bridge over a river at sunset',
];

const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const secs = (ms) => ms == null ? '—' : `${Math.round(ms / 1000)} s`;

/**
 * Run the load test. Returns a summary object and logs as it goes.
 * @param {object} o  { targets: [{ podId, workflow }…] — or podId + workflows: [id…] for one Pod — students, log, timeoutMin,
 *   prompts: [string…], pictures: [{ name, data: Buffer }…] (student i uploads picture i; default: one drawn here) }
 *   Each student books the workflow of target i % n on that target's Pod.
 */
export { testPicture, fieldsOf };

export async function loadTest({ targets, podId, workflows, students = 20, prompts = null, pictures = null, log = console.log, timeoutMin = 45 }) {
    targets = targets || workflows.map(workflow => ({ podId, workflow }));
    workflows = [...new Set(targets.map(t => t.workflow))];
    const podIds = [...new Set(targets.map(t => t.podId))];
    const picture = testPicture();
    const fields = Object.fromEntries(workflows.map(id => [id, fieldsOf(id)]));
    const runId = Date.now().toString(36);
    const t0 = Date.now();
    log(`LOAD: ${students} students, ${workflows.map(id => fields[id].name).join(' / ')} on ${podIds.length} Pod(s), booking within the first minute`);

    // 1. the student page, all at once
    const pageTimes = await Promise.all(Array.from({ length: students }, async (_, i) => {
        const t = Date.now();
        try { const r = await fetch(proxyUrl(targets[i % targets.length].podId) + '/', { signal: AbortSignal.timeout(60000) }); await r.arrayBuffer(); return r.ok ? Date.now() - t : null; }
        catch { return null; }
    }));
    const pagesOk = pageTimes.filter(x => x != null);
    log(`LOAD: student page loaded ${pagesOk.length}/${students} times, median ${secs(pct(pagesOk, 0.5))}, slowest ${secs(Math.max(...pagesOk, 0))}`);

    // 2. connect, upload, book — each student at a random moment in the first minute
    const sockets = [];
    let disconnects = 0, closing = false;
    let broadcasts = 0;
    const bookings = await Promise.all(Array.from({ length: students }, async (_, i) => {
        const { podId: pid, workflow: wf } = targets[i % targets.length];
        const base = proxyUrl(pid);
        const f = fields[wf];
        const user = `load-${runId}-${String(i + 1).padStart(2, '0')}`;
        await sleep(Math.random() * 60000);
        const out = { user, wf, ok: false };
        try {
            const socket = io(base, { transports: ['websocket', 'polling'], reconnection: true, timeout: 30000 });
            sockets.push(socket);
            // Closing them at the end is not a drop.
            socket.on('disconnect', () => { if (!closing) disconnects++; });
            socket.on('state_patch', () => { broadcasts++; });
            socket.on('state_update', () => { broadcasts++; });
            const tc = Date.now();
            await new Promise((res, rej) => { socket.once('connect', res); socket.once('connect_error', rej); });
            out.connectMs = Date.now() - tc;
            socket.emit('register_user', user);

            const params = {};
            // `prompts`: one list for a themed run; student i gets prompt i.
            const list = prompts?.length ? prompts : PROMPTS;
            const prompt = list[i % list.length];
            if (f.promptKey) params[f.promptKey] = prompt;
            if (f.imageKey) {
                const tu = Date.now();
                const form = new FormData();
                const mine = pictures?.length ? pictures[i % pictures.length] : null;
                form.append('file', new Blob([mine ? mine.data : picture], { type: 'image/png' }), mine ? mine.name : `student-${i + 1}.png`);
                const r = await fetch(base + '/upload', { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
                if (!r.ok) throw new Error(`upload ${r.status} ${(await r.text()).slice(0, 120)}`);
                params[f.imageKey] = (await r.json()).filename;
                out.uploadMs = Date.now() - tu;
            }
            const tb = Date.now();
            const ack = await new Promise((res) => socket.emit('book_job', { prompt, params, user_id: user, workflow_id: wf }, res));
            out.bookMs = Date.now() - tb;
            if (!ack?.ok) throw new Error(ack?.error || 'refused');
            out.ok = true;
            out.jobId = ack.jobId;
            out.bookedAt = Date.now();
        } catch (e) { out.error = e.message; }
        return out;
    }));
    const booked = bookings.filter(b => b.ok);
    log(`LOAD: ${booked.length}/${students} bookings accepted` + (booked.length < students ? ` — refused: ${bookings.filter(b => !b.ok).map(b => `${b.user}: ${b.error}`).join('; ')}` : '')
        + `; connect median ${secs(pct(booked.map(b => b.connectMs), 0.5))}, booking median ${secs(pct(booked.map(b => b.bookMs), 0.5))}`
        + (booked.some(b => b.uploadMs) ? `, upload median ${secs(pct(booked.filter(b => b.uploadMs).map(b => b.uploadMs), 0.5))}` : ''));

    // 3. follow every job to the end
    const ids = new Set(booked.map(b => b.jobId));
    let jobs = [];
    let maxRunning = 0;
    let bothAtOnce = 0, polls = 0;
    const end = Date.now() + timeoutMin * 60000;
    let lastLine = '';
    while (Date.now() < end) {
        try {
            const lists = await Promise.all(podIds.map(id => fetch(proxyUrl(id) + '/jobs?limit=500', { signal: AbortSignal.timeout(30000) }).then(r => r.json())));
            jobs = lists.flatMap(l => l.jobs).filter(j => ids.has(j.id));
        } catch { await sleep(5000); continue; }
        const running = jobs.filter(j => j.status === 'processing');
        maxRunning = Math.max(maxRunning, running.length);
        polls++;
        if (new Set(running.map(j => j.workflow_id)).size > 1) bothAtOnce++;
        const done = jobs.filter(j => ['completed', 'failed', 'cancelled'].includes(j.status));
        const line = `${done.length}/${ids.size} finished, ${running.length} running (${[...new Set(running.map(j => fields[j.workflow_id]?.name || j.workflow_id))].join(' + ') || '—'})`;
        if (line !== lastLine) { log(`LOAD: ${line}`); lastLine = line; }
        if (done.length === ids.size) break;
        await sleep(5000);
    }
    closing = true;
    for (const s of sockets) s.close();

    // 4. the summary
    const per = {};
    for (const id of workflows) {
        const mine = jobs.filter(j => j.workflow_id === id);
        const b = Object.fromEntries(booked.filter(x => x.wf === id).map(x => [x.jobId, x.bookedAt]));
        const waits = mine.filter(j => j.started_at).map(j => j.started_at - b[j.id]);
        const runs = mine.filter(j => j.finished_at && j.started_at).map(j => j.finished_at - j.started_at);
        const totals = mine.filter(j => j.finished_at).map(j => j.finished_at - b[j.id]);
        per[id] = {
            name: fields[id].name, booked: Object.keys(b).length,
            completed: mine.filter(j => j.status === 'completed').length,
            failed: mine.filter(j => j.status === 'failed').map(j => j.error_reason || 'failed'),
            waitMedian: pct(waits, 0.5), waitMax: waits.length ? Math.max(...waits) : null,
            runMedian: pct(runs, 0.5), runMax: runs.length ? Math.max(...runs) : null,
            totalMax: totals.length ? Math.max(...totals) : null,
        };
    }
    const summary = {
        students, bookingsAccepted: booked.length, refused: bookings.filter(b => !b.ok).map(b => b.error),
        pageMedianMs: pct(pagesOk, 0.5), pageMaxMs: pagesOk.length ? Math.max(...pagesOk) : null,
        maxJobsRunningAtOnce: maxRunning,
        shareOfTimeBothWorkflowsRan: polls ? +(bothAtOnce / polls).toFixed(2) : 0,
        socketDisconnects: disconnects, broadcastsReceived: broadcasts,
        minutes: +((Date.now() - t0) / 60000).toFixed(1),
        perWorkflow: per,
    };
    for (const p of Object.values(per)) {
        log(`LOAD: ${p.name}: ${p.completed}/${p.booked} done${p.failed.length ? `, ${p.failed.length} FAILED (${[...new Set(p.failed)].join('; ').slice(0, 200)})` : ''} — wait median ${secs(p.waitMedian)}, longest ${secs(p.waitMax)}; render median ${secs(p.runMedian)}, longest ${secs(p.runMax)}; last student waited ${secs(p.totalMax)} from booking to result`);
    }
    log(`LOAD: at most ${summary.maxJobsRunningAtOnce} jobs ran at once; both workflows were rendering together ${Math.round(summary.shareOfTimeBothWorkflowsRan * 100)}% of the time; ${summary.socketDisconnects} connection drops; ${summary.minutes} min in all`);
    return summary;
}
