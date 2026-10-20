// ComfyQ RunPod console — page logic. Talks only to the local server.mjs.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gb = (b) => (Number(b || 0) / 1024 ** 3).toFixed(1);

// The local server accepts only its per-start token. The desktop app's window
// gets it from the preload; in a browser, RunPod-Console.bat opens the page at
// #t=<token>, which this tab keeps (sessionStorage) and removes from the address.
const CONSOLE_TOKEN = (() => {
    if (window.comfyqConsole?.token) return window.comfyqConsole.token;
    const m = location.hash.match(/(?:^#|&)t=([A-Za-z0-9]{16,})/);
    if (m) {
        try { sessionStorage.setItem('rpc.token', m[1]); } catch { /* private window: this load only */ }
        history.replaceState(null, '', location.pathname);
        return m[1];
    }
    try { return sessionStorage.getItem('rpc.token') || '1'; } catch { return '1'; }
})();

async function api(method, route, body) {
    const res = await fetch(route, {
        method,
        headers: { 'X-ComfyQ-Console': CONSOLE_TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && data.error === 'missing console header') {
        throw new Error('This tab has no access to the console: start it again with RunPod-Console.bat (it opens the right link), or open the ComfyQ Console app.');
    }
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    return data;
}

// Ask for a code to be typed back before something is deleted. Resolves to
// the code when it was typed exactly, or null. Replaces window.prompt(), which
// Electron does not support (the desktop app's Delete did nothing).
function askCode({ title, text, code, button = 'Delete' }) {
    return new Promise((resolve) => {
        $('askTitle').textContent = title;
        $('askText').textContent = text;
        $('askCodeShow').textContent = code;
        $('askOk').textContent = button;
        $('askInput').value = '';
        $('askOk').disabled = true;
        $('ask').hidden = false; $('askScrim').hidden = false;
        setTimeout(() => $('askInput').focus(), 0);
        const done = (v) => {
            $('ask').hidden = true; $('askScrim').hidden = true;
            $('askInput').oninput = $('askInput').onkeydown = $('askOk').onclick = $('askCancel').onclick = $('askScrim').onclick = null;
            resolve(v);
        };
        $('askInput').oninput = () => { $('askOk').disabled = $('askInput').value.trim() !== code; };
        $('askInput').onkeydown = (e) => {
            if (e.key === 'Enter' && $('askInput').value.trim() === code) done(code);
            if (e.key === 'Escape') { e.stopPropagation(); done(null); }
        };
        $('askOk').onclick = () => done(code);
        $('askCancel').onclick = () => done(null);
        $('askScrim').onclick = () => done(null);
    });
}

let toastTimer;
function toast(msg, bad = false) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (bad ? ' bad' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 9000 : 4000);
}

// ---- theme + tabs -----------------------------------------------------------------

function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } }
(function theme() {
    const saved = store('rpc.theme');
    if (saved) document.documentElement.dataset.theme = saved;
    $('themeBtn').onclick = () => {
        const cur = document.documentElement.dataset.theme
            || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
        const next = cur === 'light' ? 'dark' : 'light';
        document.documentElement.dataset.theme = next;
        store('rpc.theme', next);
    };
})();

// One page per provider. Launching and the keys open in a panel from the right.
const pageOpen = (name) => !$(`page-${name}`).hidden;
function showPage(name) {
    if (!['runpod', 'thunder'].includes(name)) name = 'runpod';
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.page === name));
    for (const s of document.querySelectorAll('.page')) s.hidden = s.id !== `page-${name}`;
    store('rpc.page', name);
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
    if (name === 'runpod') { loadPods(); if ($('attemptsFold').open) loadAttempts(); }
    if (name === 'thunder') { loadThunderInstances(); loadAttempts(); }
}
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => showPage(b.dataset.page);
window.addEventListener('hashchange', () => { const n = location.hash.slice(1); if (['runpod', 'thunder'].includes(n) && !pageOpen(n)) showPage(n); });

function openDrawer(name) {
    for (const d of document.querySelectorAll('.drawer')) d.hidden = d.id !== `drawer-${name}`;
    $('scrim').hidden = false;
    if (name === 'createPod') loadLaunch();
    if (name === 'createThunder') loadThunder();
    if (name === 'booking') loadBookingForm();
}
function closeDrawers() {
    for (const d of document.querySelectorAll('.drawer')) d.hidden = true;
    $('scrim').hidden = true;
}
$('scrim').onclick = closeDrawers;
for (const b of document.querySelectorAll('[data-close]')) b.onclick = closeDrawers;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('scrim').hidden) closeDrawers(); });
$('settingsBtn').onclick = () => openDrawer('settings');
$('openCreatePod').onclick = () => openDrawer('createPod');
$('openCreateThunder').onclick = () => openDrawer('createThunder');
$('openBooking').onclick = () => openDrawer('booking');
$('stockFold').ontoggle = () => { if ($('stockFold').open) loadStock(); };
$('attemptsFold').ontoggle = () => { if ($('attemptsFold').open) loadAttempts(); };

// The old tab names, for the calls that still use them.
function showTab(name) {
    if (name === 'creds') return openDrawer('settings');
    if (name === 'launch') { showPage('runpod'); return openDrawer('createPod'); }
    if (name === 'thunder') return showPage('thunder');
    if (name === 'stock') { showPage('runpod'); $('stockFold').open = true; return; }
    if (name === 'attempts') { showPage('runpod'); $('attemptsFold').open = true; return; }
    showPage('runpod');
}

// ---- credentials ----------------------------------------------------------------

let settings = null;
const SECRETS = ['runpodApiKey', 'thunderApiKey', 'adminPassword', 'accessPassword', 'hfToken'];

// `cleared` names the inputs whose value was just saved; anything else typed
// but not yet saved stays in its box.
function renderSettings(cleared = SECRETS) {
    for (const k of SECRETS) {
        const st = settings[k];
        const el = $(`${k}State`);
        el.textContent = st.set ? (st.hint ? `saved (${st.hint})` : 'saved') : 'not set';
        el.className = 'state ' + (st.set ? 'set' : 'unset');
        if (cleared.includes(k)) $(k).value = '';
        $(k).placeholder = st.set ? 'saved — type to replace' : $(k).dataset.ph || $(k).placeholder;
    }
    $('image').placeholder = settings.defaultImage;
    $('image').value = settings.image || '';
    $('settingsFile').textContent = settings.secretsProtected ? `${settings.file} (keys: Windows protected storage)` : settings.file;
    $('sshNote').hidden = !settings.sshMissing;
}

async function loadSettings() {
    settings = await api('GET', '/api/settings');
    for (const k of SECRETS) $(k).dataset.ph = $(k).dataset.ph || $(k).placeholder;
    renderSettings();
}

$('saveCreds').onclick = async () => {
    const body = {};
    for (const k of SECRETS) if ($(k).value.trim()) body[k] = $(k).value.trim();
    body.image = $('image').value.trim();
    try {
        try { settings = await api('PUT', '/api/settings', body); }
        catch (e) {
            // Not ComfyQ's image: say what it means, and only then save it.
            if (e.status !== 409 || !confirm(`${e.message}

Use ${body.image} anyway?`)) throw e;
            settings = await api('PUT', '/api/settings', { ...body, allowCustomImage: true });
        }
        renderSettings();
        toast('Saved');
    } catch (e) { toast(e.message, true); }
};

$('testKey').onclick = async () => {
    const out = $('testKeyOut');
    // Test what was just typed, without making anyone press Save first.
    if ($('runpodApiKey').value.trim()) {
        settings = await api('PUT', '/api/settings', { runpodApiKey: $('runpodApiKey').value.trim() });
        renderSettings(['runpodApiKey']);
    }
    out.textContent = 'checking…';
    try {
        const r = await api('POST', '/api/test-key');
        out.textContent = `works: ${r.pods} Pod(s), ${r.volumes} volume(s)` + (r.gpuTypes ? `, ${r.gpuTypes} GPU types priced` : ', but GPU prices are not readable');
        out.className = '';
    } catch (e) { out.textContent = e.message; out.className = 'muted'; }
};

// One student page per workflow served: a tab books only the workflow its
// address names, so each workflow needs its own link.
function studentLinksHtml(links, names = {}) {
    const rows = links?.byWorkflow || [];
    if (rows.length < 2) return '';
    return `<div class="small muted" style="margin-top:8px">One student page per workflow (a page books only the workflow its link names):</div>
      <div class="links">${rows.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noreferrer">${esc(names[l.id] || l.id)}${l.main ? ' (main)' : ''} ↗</a>
        <button class="ghost small" data-copylink="${esc(l.url)}">Copy</button>`).join('')}</div>`;
}
function wireCopyLinks(root) {
    for (const b of root.querySelectorAll('[data-copylink]')) b.onclick = (ev) => {
        ev.stopPropagation();
        navigator.clipboard.writeText(b.dataset.copylink).then(() => toast('Student link copied'), () => toast(b.dataset.copylink));
    };
}

const AVAIL_LABEL = { available: 'in stock', unavailable: 'none free', unclear: 'unclear (Thunder disagrees with itself)', unknown: 'unknown' };
function renderThunderOffers(offers) {
    const t = $('thunderOffers');
    if (!offers?.length) { t.hidden = true; return; }
    t.innerHTML = '<thead><tr><th>Card</th><th>VRAM</th><th>$/hour</th><th>Right now</th></tr></thead><tbody>'
        + offers.map(o => `<tr><td>${esc(o.name)}</td><td>${o.vramGb ?? '?'} GB</td>`
            + `<td>${o.pricePerHr != null ? '$' + o.pricePerHr.toFixed(2) : '?'}</td>`
            + `<td>${esc(AVAIL_LABEL[o.availability] || o.availability)}</td></tr>`).join('')
        + '</tbody>';
    t.hidden = false;
}

$('testThunderKey').onclick = async () => {
    const out = $('testThunderKeyOut');
    if ($('thunderApiKey').value.trim()) {
        settings = await api('PUT', '/api/settings', { thunderApiKey: $('thunderApiKey').value.trim() });
        renderSettings(['thunderApiKey']);
    }
    out.textContent = 'checking…';
    try {
        const r = await api('POST', '/api/thunder/test-key');
        out.textContent = `works: ${r.instances} instance(s) on the account` + (r.offers ? '' : ', but prices are not readable');
        out.className = '';
        renderThunderOffers(r.offers);
    } catch (e) { out.textContent = e.message; out.className = 'muted'; }
};

// ---- Thunder Compute ------------------------------------------------------------
// The backup provider: its own launch form and instance list, kept apart from
// the RunPod ones (no volume, no data centre, one card per instance).

let tWorkflows = null;
let tChosen = [];
let tPlan = null;
let tPick = null;
let tPickTouched = false;
let tTimer = null;

const T_STATE = {
    created: 'Created', booting: 'Thunder is starting the instance', connecting: 'Logging in',
    installing: 'Starting ComfyQ', ready: 'ComfyQ started', failed: 'Setup failed', interrupted: 'Setup interrupted',
};

async function loadThunder() {
    if (!settings?.thunderApiKey?.set) {
        $('tList').innerHTML = '<p class="muted pad">Save your Thunder Compute API key in Settings (top right) first.</p>';
    }
    if (!tWorkflows) {
        try { tWorkflows = (await api('GET', '/api/workflows')).workflows; } catch (e) { toast(e.message, true); tWorkflows = []; }
        renderThunderWorkflows();
    }
    loadThunderPlan();
    if (settings?.thunderApiKey?.set) loadThunderInstances();
}

function renderThunderWorkflows() {
    const q = $('tWfSearch').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hideExp = $('tWfHideExp').checked;
    const rows = (tWorkflows || []).filter(w => {
        if (hideExp && w.experimental && !tChosen.includes(w.id)) return false;
        const hay = `${w.name} ${w.id} ${w.category} ${w.description}`.toLowerCase();
        return q.every(t => hay.includes(t));
    });
    $('tWfList').innerHTML = rows.map(w => `
        <label class="wf">
          <input type="checkbox" data-twf="${esc(w.id)}" ${tChosen.includes(w.id) ? 'checked' : ''}>
          <div>
            <div class="name">${esc(w.name)}${w.experimental ? '<span class="badge exp">experimental</span>' : ''}${w.gated ? '<span class="badge">needs HF token</span>' : ''}</div>
            <div class="desc">${esc(w.id)}${w.description ? ' — ' + esc(w.description) : ''}</div>
          </div>
          <div class="vram">${w.vramGb ? `${w.vramGb} GB` : '?'}<div class="muted small">${esc(w.vramSource)}</div></div>
        </label>`).join('') || '<p class="muted" style="padding:12px">No workflow matches.</p>';
    for (const cb of $('tWfList').querySelectorAll('input[data-twf]')) {
        cb.onchange = () => {
            const id = cb.dataset.twf;
            tChosen = cb.checked ? [...tChosen, id] : tChosen.filter(x => x !== id);
            renderThunderWorkflows();
            loadThunderPlan();
        };
    }
    $('tWfChosen').innerHTML = tChosen.map((id, i) => `<span class="chip">${i === 0 ? '<b>main</b> ' : ''}${esc(id)} <button data-trm="${esc(id)}" title="Remove">×</button></span>`).join('');
    for (const b of $('tWfChosen').querySelectorAll('[data-trm]')) {
        b.onclick = () => { tChosen = tChosen.filter(x => x !== b.dataset.trm); renderThunderWorkflows(); loadThunderPlan(); };
    }
}
$('tWfSearch').oninput = renderThunderWorkflows;
$('tWfHideExp').onchange = renderThunderWorkflows;

async function loadThunderPlan() {
    try { tPlan = await api('GET', `/api/thunder/plan?workflows=${encodeURIComponent(tChosen.join(','))}`); }
    catch (e) { $('tNeed').textContent = e.message; return; }
    if (!tPickTouched || !tPlan.offers.some(o => o.id === tPick)) tPick = tPlan.recommended || tPick;
    renderThunderPlan();
}
$('tRefreshOffers').onclick = loadThunderPlan;

// Thunder's own formula (thunder-cli utils/pricing.go): the GPU, plus each vCPU
// above the smallest option, plus each GB of disk above the 100 included.
function thunderHourly(o, vcpus, diskGb) {
    if (!o || o.pricePerHr == null) return null;
    return o.pricePerHr + Math.max(0, (Number(vcpus) || 0) - (o.includedVcpus || 4)) * (o.extraVcpuPerHr || 0)
        + Math.max(0, (Number(diskGb) || 0) - 100) * (o.diskGbPerHr || 0);
}

// Admin mode: the workflow is picked later in the instance's admin panel, which
// downloads its models then. The disk is fixed at launch, so say what it holds.
function adminDiskHint() {
    const rows = tPlan?.diskByWorkflow || [];
    const disk = Number($('tDisk').value) || 0;
    const tooBig = rows.filter(w => w.minDiskGb > disk).sort((a, b) => b.minDiskGb - a.minDiskGb);
    let t = 'No workflow ticked: the instance starts in admin mode. Set the admin password, then pick a workflow in its admin panel: its models download then, and it serves.';
    if (rows.length) {
        t += tooBig.length
            ? ` With ${disk} GB of disk, ${rows.length - tooBig.length} of ${rows.length} workflows fit; too big: ${tooBig.slice(0, 6).map(w => `${w.id} (${w.minDiskGb} GB)`).join(', ')}${tooBig.length > 6 ? `, and ${tooBig.length - 6} more` : ''}.`
            : ` With ${disk} GB of disk, any one of the ${rows.length} workflows fits.`;
        t += ' Pick the disk for the workflow you will serve: the disk cannot grow later, and a workflow that does not fit is refused before downloading.';
    }
    return t;
}

function renderThunderPlan() {
    const n = tPlan.need;
    $('tNeed').textContent = !tChosen.length ? adminDiskHint()
        : n.gb == null ? 'No VRAM figure for these workflows: pick a card with room to spare.'
        : `These workflows need about ${n.gb} GB of VRAM together${n.unknown.length ? ` (no figure for ${n.unknown.join(', ')})` : ''}.`;
    const dl = tPlan.downloads;
    if (tChosen.length && dl) {
        $('tNeed').textContent += dl.gb != null
            ? ` A new instance downloads ${dl.gb} GB of models (${dl.files} files)${dl.byNodePack.length ? `, plus ${dl.byNodePack.length} its node packs fetch on first use` : ''}: the disk needs at least ${dl.minDiskGb} GB with the image.`
            : ' No download size is known for these workflows: keep the disk generous.';
        if (dl.failing.length) $('tNeed').textContent += ` ✗ ${dl.failing.join(', ')} cannot fetch all its models on a new machine — untick it.`;
    }
    $('tGpuRows').innerHTML = tPlan.offers.map(o => `
        <tr class="${o.fits === false ? 'off' : ''} ${o.id === tPick ? 'picked' : ''}" data-toffer="${esc(o.id)}">
          <td><input type="radio" name="tgpu" ${o.id === tPick ? 'checked' : ''} ${o.fits === false ? 'disabled' : ''}></td>
          <td>${esc(o.name)}</td><td>${o.vramGb ?? '?'} GB</td>
          <td>${o.pricePerHr != null ? '$' + o.pricePerHr.toFixed(2) : '?'}</td>
          <td class="${o.availability === 'available' ? 'stock-High' : o.availability === 'unavailable' ? 'stock-None' : 'muted'}">${esc(AVAIL_LABEL[o.availability] || o.availability)}</td>
          <td class="muted small">${o.id === tPlan.recommended ? 'recommended' : o.fits === false ? 'too small' : ''}</td>
        </tr>`).join('');
    for (const tr of $('tGpuRows').querySelectorAll('tr[data-toffer]')) {
        tr.onclick = () => {
            const o = tPlan.offers.find(x => x.id === tr.dataset.toffer);
            if (!o || o.fits === false) return;
            tPick = o.id; tPickTouched = true; renderThunderPlan();
        };
    }
    const o = tPlan.offers.find(x => x.id === tPick);
    const prev = $('tVcpus').value;
    $('tVcpus').innerHTML = (o?.vcpuOptions || []).map(v => `<option ${String(v) === prev ? 'selected' : ''}>${v}</option>`).join('');
    if (o?.diskGb) {
        // Never smaller than what the image and the downloads need: running out of
        // disk mid-download fails the setup on a machine that is already billing.
        const floor = Math.max(o.diskGb.min, dl?.minDiskGb || 0);
        $('tDisk').min = floor; $('tDisk').max = o.diskGb.max;
        if (Number($('tDisk').value) < floor) $('tDisk').value = Math.min(floor, o.diskGb.max);
    }
    $('tLaunch').disabled = !!dl?.failing?.length;
    $('tSummary').textContent = o
        ? `${o.name} · $${(thunderHourly(o, $('tVcpus').value, $('tDisk').value) ?? 0).toFixed(2)}/hour with ${$('tVcpus').value} vCPU and ${$('tDisk').value} GB (the card alone is $${(o.pricePerHr ?? 0).toFixed(2)}) · ${tChosen.length ? `serves ${tChosen.length} workflow${tChosen.length > 1 ? 's' : ''}` : 'admin mode'}`
        : '';
}

// The price line follows the vCPU and disk fields: both change the hourly bill.
$('tVcpus').onchange = () => tPlan && renderThunderPlan();
$('tDisk').oninput = () => tPlan && renderThunderPlan();

$('tLaunch').onclick = async () => {
    const o = tPlan?.offers.find(x => x.id === tPick);
    if (!o) return toast('Pick a card', true);
    const warn = o.availability === 'available' ? '' : `\n\nThunder does not clearly say this card is free right now (${AVAIL_LABEL[o.availability]}): the launch may be refused.`;
    const perHr = thunderHourly(o, $('tVcpus').value, $('tDisk').value) ?? 0;
    await loadSpend();
    if (!confirm(`Launch a ${o.name} on Thunder Compute at $${perHr.toFixed(2)}/hour (${$('tVcpus').value} vCPU, ${$('tDisk').value} GB)?\n\nIt bills until you delete it. ${tChosen.length ? `It will serve: ${tChosen.join(', ')}.` : 'It starts in admin mode: pick the workflow in its admin panel; its models download then.'}${warn}${coverage(spend?.thunder?.balance ?? null, perHr, 'Thunder')}`)) return;
    $('tLaunch').disabled = true;
    try {
        await api('POST', '/api/thunder/launch', { workflows: tChosen, gpu: o.id, vcpus: Number($('tVcpus').value), diskGb: Number($('tDisk').value), fetchModels: $('tFetch').checked });
        toast('Instance created: its setup is followed in the list');
        closeDrawers();
        loadThunderInstances();
    } catch (e) { toast(e.message, true); }
    finally { $('tLaunch').disabled = false; }
};

function thunderStage(i) {
    const r = i.rec;
    const plan = i.probe?.plan;
    if (i.probe?.answering && i.probe.mode === 'student') return { cls: 'good', text: `Serving ${i.probe.served.map(w => w.id).join(', ')}` };
    if (r?.state === 'failed') return { cls: 'bad', text: `${T_STATE.failed}: ${r.error || ''}` };
    if (r?.state === 'interrupted') return { cls: 'bad', text: T_STATE.interrupted };
    if (i.probe?.answering) {
        if (plan?.status === 'failed' || plan?.status === 'refused') return { cls: 'bad', text: `ComfyQ could not prepare the workflows: ${plan.error || ''}` };
        if (i.probe.mode === 'admin' && r && !(r.serve || []).length) return { cls: 'good', text: 'Up in admin mode — pick a workflow in its admin panel' };
        return { cls: '', text: plan?.status === 'fetching' ? 'Downloading models' : 'ComfyQ is up, switching to serving mode' };
    }
    if (r?.state === 'ready' && i.probe?.plan?.status === 'done') return { cls: '', text: 'Restarting into serving mode…' };
    if (r?.state === 'ready') return { cls: '', text: 'ComfyQ is booting (first start takes a few minutes)' };
    if (r) return { cls: '', text: T_STATE[r.state] || r.state };
    return { cls: '', text: `Thunder: ${i.status} (not launched from this console)` };
}

let tInstances = [];
let tSelected = null;

function thunderDetailHtml(i) {
    const r = i.rec;
    const st = thunderStage(i);
    const files = (i.probe?.plan?.files || []).filter(f => f.status !== 'done').map(f => {
        const pct = f.total ? Math.round(100 * f.received / f.total) : 0;
        return `<div class="file"><div>${esc(f.name)} <span class="muted small">— ${esc(f.status)}${f.total ? ` · ${gb(f.received)} / ${gb(f.total)} GB` : ''}</span></div>
            ${f.error ? `<div class="small" style="color:var(--bad)">${esc(f.error)}</div>` : ''}
            ${f.status === 'downloading' ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}</div>`;
    }).join('');
    const log = (r?.steps || []).slice(-12).map(s => `<div class="small"><span class="muted">${new Date(s.at).toLocaleTimeString()}</span> ${esc(s.msg)}</div>`).join('');
    return `<div class="row"><h2>${esc(r?.gpuName || i.gpuType || '')} <span class="muted mono">${esc(i.uuid.slice(0, 8))}</span></h2>
        ${r && !i.setupRunning && ['failed', 'interrupted'].includes(r.state) ? `<button class="secondary" data-tretry="${esc(i.uuid)}">Retry setup</button>` : ''}
        ${r && i.links ? `<button class="secondary" data-tdl="${esc(i.uuid)}">Download results</button>` : ''}
        <button class="danger" data-tdel="${esc(i.uuid)}">Delete…</button>
        <button class="ghost icon" data-tclose title="Close">✕</button>
      </div>
      <div class="note ${st.cls}">${esc(st.text)}${st.cls === 'bad' ? '<br><b>The instance is still billing.</b> Retry the setup or delete it.' : ''}</div>
      ${i.links ? `<div class="links">
        <a href="${esc(i.links.students)}" target="_blank" rel="noreferrer">Student page ↗</a>
        <a href="${esc(i.links.admin)}" target="_blank" rel="noreferrer">Admin panel ↗</a>
        <button class="ghost small" data-tcopy="${esc(i.links.students)}">Copy student link</button>
      </div>${studentLinksHtml(i.links, Object.fromEntries((i.probe?.served || []).map(w => [w.id, w.name])))}` : ''}
      <dl class="kv">
        <dt>Thunder status</dt><dd>${esc(i.status)}${i.ip ? ` <span class="muted">(${esc(i.ip)})</span>` : ''}</dd>
        ${r ? `<dt>Cost</dt><dd>${r.pricePerHr != null ? `$${Number(r.pricePerHr).toFixed(2)} / hour` : '—'}, running for ${since(new Date(r.createdAt).toISOString())}</dd>
        <dt>Asked to serve</dt><dd>${esc((r.serve || []).join(', '))}</dd>` : ''}
        ${i.probe?.usage ? `<dt>Students</dt><dd>${esc(i.probe.usage.usersConnected ?? 0)} connected</dd>` : ''}
        ${i.probe?.jobs ? `<dt>Queue</dt><dd>${i.probe.jobs.running ? '1 running' : 'nothing running'}, ${(i.probe.jobs.scheduled || []).length} waiting</dd>` : ''}
      </dl>
      ${files ? `<h3>Models</h3><div class="files">${files}</div>` : ''}
      ${log ? `<details ${i.setupRunning || r?.state === 'failed' ? 'open' : ''}><summary class="muted small">Setup log</summary>${log}</details>` : ''}`;
}

function tMatches(i) {
    const q = $('tSearch').value.trim().toLowerCase();
    if ($('tStatus').value && i.status !== $('tStatus').value) return false;
    if ($('tGpuFilter').value && (i.gpuType || '') !== $('tGpuFilter').value) return false;
    if (!q) return true;
    const hay = [i.uuid, i.status, i.gpuType, i.ip, i.rec?.gpuName, ...(i.rec?.serve || []), thunderStage(i).text].join(' ').toLowerCase();
    return q.split(/\s+/).every(t => hay.includes(t));
}
for (const id of ['tSearch', 'tStatus', 'tGpuFilter']) $(id).oninput = () => renderThunderInstances();

function renderThunderInstances() {
    const list = tInstances;
    const running = list.filter(i => i.status === 'RUNNING');
    $('thunderCount').textContent = list.length || '';
    $('tTotal').textContent = list.length;
    $('tRunning').textContent = running.length;
    $('tOther').textContent = list.length - running.length;
    $('tRate').textContent = `$${list.reduce((a, i) => a + (Number(i.rec?.pricePerHr) || 0), 0).toFixed(2)}`;
    for (const [id, vals, all] of [['tStatus', list.map(i => i.status), 'All statuses'], ['tGpuFilter', list.map(i => i.gpuType), 'All GPU types']]) {
        const keep = $(id).value;
        $(id).innerHTML = `<option value="">${all}</option>` + [...new Set(vals.filter(Boolean))].sort().map(v => `<option ${v === keep ? 'selected' : ''}>${esc(v)}</option>`).join('');
    }
    const shown = list.filter(tMatches);
    $('tList').innerHTML = shown.length
        ? `<table><thead><tr><th>ID</th><th>Status</th><th>GPU</th><th>Serving</th><th>IP Address</th><th class="num">Cost</th><th class="num">Up for</th><th></th></tr></thead><tbody>${shown.map(i => {
            const st = thunderStage(i);
            const dot = st.cls === 'good' ? 'run' : st.cls === 'bad' ? 'bad' : i.status === 'RUNNING' ? 'warn' : 'stop';
            return `<tr class="${i.uuid === tSelected ? 'sel' : ''}" data-tsel="${esc(i.uuid)}">
              <td class="mono">${esc(i.uuid.slice(0, 8))}</td>
              <td><span class="status" title="${esc(st.text)}"><span class="dot ${dot}"></span>${esc(st.cls === 'good' ? 'Serving' : st.cls === 'bad' ? 'Needs attention' : i.status === 'RUNNING' ? 'Setting up' : i.status)}</span></td>
              <td>${esc(i.rec?.gpuName || i.gpuType || '')}</td>
              <td class="small">${esc((i.rec?.serve || i.probe?.served?.map(w => w.id) || []).join(', ') || '—')}</td>
              <td class="mono">${esc(i.ip || '—')}</td>
              <td class="num">${i.rec?.pricePerHr != null ? `$${Number(i.rec.pricePerHr).toFixed(2)}/h` : '—'}</td>
              <td class="num">${i.rec ? since(new Date(i.rec.createdAt).toISOString()) : i.createdAt ? since(i.createdAt) : '—'}</td>
              <td>${i.links ? `<a class="small" href="${esc(i.links.students)}" target="_blank" rel="noreferrer">students ↗</a>` : ''}</td>
            </tr>`;
        }).join('')}</tbody></table>`
        : list.length
            ? '<div class="empty"><p>No instance matches.</p></div>'
            : `<div class="empty"><div class="ico">▤</div><p><b>No instances found</b></p><p class="muted">Create an instance to get started</p><p><button class="cta" data-create="thunder">+ Create an instance</button></p></div>`;
    for (const b of $('tList').querySelectorAll('[data-create]')) b.onclick = () => openDrawer('createThunder');
    for (const tr of $('tList').querySelectorAll('[data-tsel]')) tr.onclick = (ev) => {
        if (ev.target.closest('a')) return;
        tSelected = tSelected === tr.dataset.tsel ? null : tr.dataset.tsel;
        renderThunderInstances();
        if (tSelected) $('tDetail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };

    const box = $('tDetail');
    const sel = list.find(i => i.uuid === tSelected);
    box.hidden = !sel;
    if (!sel) return;
    box.innerHTML = thunderDetailHtml(sel);
    box.querySelector('[data-tclose]').onclick = () => { tSelected = null; renderThunderInstances(); };
    for (const b of box.querySelectorAll('[data-tretry]')) b.onclick = async () => {
        try { await api('POST', `/api/thunder/instances/${b.dataset.tretry}/setup`); toast('Setup restarted'); loadThunderInstances(); }
        catch (e) { toast(e.message, true); }
    };
    for (const b of box.querySelectorAll('[data-tdl]')) b.onclick = async () => {
        // Saved file by file into a folder on this PC (Thunder's proxy cuts a long zip), shown as it goes.
        const uuid = b.dataset.tdl;
        try {
            let st = await api('POST', `/api/thunder/instances/${uuid}/download`);
            b.disabled = true;
            while (!['done', 'failed'].includes(st.state)) {
                b.textContent = st.total ? `Saving ${st.saved}/${st.total}…` : 'Listing the results…';
                await new Promise(r => setTimeout(r, 1500));
                st = await api('GET', `/api/thunder/instances/${uuid}/download`);
            }
            if (st.state === 'failed') throw new Error(st.error || 'the download failed');
            toast(`Saved ${st.saved} of ${st.total} results (${(st.bytes / 1e6).toFixed(0)} MB) to ${st.folder}${st.failed.length ? ` — ${st.failed.length} could not be fetched` : ''}`, !!st.failed.length);
        } catch (e) { toast(e.message, true); }
        finally { b.disabled = false; b.textContent = 'Download results'; }
    };
    wireCopyLinks(box);
    for (const b of box.querySelectorAll('[data-tcopy]')) b.onclick = () => {
        navigator.clipboard.writeText(b.dataset.tcopy).then(() => toast('Student link copied'), () => toast(b.dataset.tcopy));
    };
    for (const b of box.querySelectorAll('[data-tdel]')) b.onclick = async () => {
        const code = b.dataset.tdel.slice(0, 8);
        const typed = await askCode({ title: 'Delete this Thunder instance?', code, button: 'Delete instance',
            text: 'Its disk goes with it: the models AND every result students made on it. Download the results first.\n\nBilling stops once it is deleted.' });
        if (typed === null) return;
        try { await api('DELETE', `/api/thunder/instances/${b.dataset.tdel}`, { confirm: typed.trim() }); toast('Instance deleted: billing stops'); tSelected = null; loadThunderInstances(); loadSpend(); }
        catch (e) { toast(e.message, true); }
    };
}

async function loadThunderInstances() {
    clearTimeout(tTimer);
    let d;
    try { d = await api('GET', '/api/thunder/instances'); }
    catch (e) { $('tList').innerHTML = `<p class="muted pad">${esc(e.message)}</p>`; return; }
    tInstances = d.instances;
    if (tSelected && !tInstances.some(i => i.uuid === tSelected)) tSelected = null;
    // An instance still setting up, or one that failed, opens its panel by itself.
    if (!tSelected) tSelected = tInstances.find(i => i.setupRunning || ['failed', 'interrupted'].includes(i.rec?.state))?.uuid || null;
    // Keep an open setup log open across refreshes.
    const logOpen = $('tDetail').querySelector('details')?.open;
    renderThunderInstances();
    if (logOpen) { const dd = $('tDetail').querySelector('details'); if (dd) dd.open = true; }

    // Follow while the page is open.
    if (pageOpen('thunder')) tTimer = setTimeout(loadThunderInstances, d.instances.length ? 8000 : 30000);
}
$('tRefresh').onclick = loadThunderInstances;

// ---- launch ---------------------------------------------------------------------

let workflows = [];
let volumes = [];
let chosen = [];          // workflow ids, in order: first = main lane
let gpuPick = null;       // primary GPU id
let gpuFallback = new Set();
// Until someone ticks or unticks a fallback by hand, the next few cheapest
// GPUs that fit and are in stock are offered as fallbacks: stock in one data
// centre moves within seconds, and with a single choice RunPod refuses the
// Pod outright when that one card has just gone.
let fallbackTouched = false;
const AUTO_FALLBACKS = 3;
let gpuData = null;
let launchLoaded = false;

async function loadLaunch(force = false) {
    if (launchLoaded && !force) return;
    launchLoaded = true;
    try { await Promise.all([loadVolumes(), loadWorkflows(), loadDataCenters()]); }
    catch (e) { toast(e.message, true); }
    $('diskGb').value = settings?.diskGb || 30;
    $('community').checked = !!settings?.community;
    loadGpus();
}

async function loadVolumes() {
    const sel = $('volume');
    try {
        volumes = (await api('GET', '/api/volumes')).volumes;
    } catch (e) {
        sel.innerHTML = `<option value="">${esc(e.message)}</option>`;
        throw e;
    }
    // Always offered, last: the fallback when the volume's data centre has no GPU.
    const none = `<option value="${NO_VOLUME}">No network volume — any data centre, models downloaded at boot</option>`;
    if (!volumes.length) {
        sel.innerHTML = '<option value="">No network volume yet — create one</option>' + none;
        $('newVolume').hidden = false;
        noVolumeUi();
        return;
    }
    sel.innerHTML = volumes.map(v => `<option value="${esc(v.id)}">${esc(v.name)} — ${esc(v.size)} GB in ${esc(v.dataCenterId)}</option>`).join('') + none;
    if (settings?.volumeId && (settings.volumeId === NO_VOLUME || volumes.some(v => v.id === settings.volumeId))) sel.value = settings.volumeId;
    noVolumeUi();
}

// Show the Pod-disk field and the explanation only for a no-volume launch.
function noVolumeUi() {
    const none = $('volume').value === NO_VOLUME;
    $('podVolumeField').hidden = !none;
    $('noVolumeNote').hidden = !none;
}

async function loadDataCenters() {
    const { dataCenters } = await api('GET', '/api/datacenters');
    $('nvDc').innerHTML = '<option value="">pick…</option>' + dataCenters.map(d => `<option>${esc(d)}</option>`).join('');
}

async function loadWorkflows() {
    workflows = (await api('GET', '/api/workflows')).workflows;
    renderWorkflows();
}

function renderWorkflows() {
    const q = $('wfSearch').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hideExp = $('wfHideExp').checked;
    const rows = workflows.filter(w => {
        if (hideExp && w.experimental && !chosen.includes(w.id)) return false;
        const hay = `${w.name} ${w.id} ${w.category} ${w.description}`.toLowerCase();
        return q.every(t => hay.includes(t));
    });
    $('wfList').innerHTML = rows.map(w => `
        <label class="wf">
          <input type="checkbox" data-wf="${esc(w.id)}" ${chosen.includes(w.id) ? 'checked' : ''}>
          <div>
            <div class="name">${esc(w.name)}${w.experimental ? '<span class="badge exp">experimental</span>' : ''}${w.gated ? '<span class="badge">needs HF token</span>' : ''}</div>
            <div class="desc">${esc(w.id)}${w.description ? ' — ' + esc(w.description) : ''}</div>
          </div>
          <div class="vram">${w.vramGb ? `${w.vramGb} GB` : '?'}<div class="muted small">${esc(w.vramSource)}</div></div>
        </label>`).join('') || '<p class="muted" style="padding:12px">No workflow matches.</p>';
    for (const cb of $('wfList').querySelectorAll('input[data-wf]')) {
        cb.onchange = () => {
            const id = cb.dataset.wf;
            chosen = cb.checked ? [...chosen, id] : chosen.filter(x => x !== id);
            renderChosen();
            loadGpus();
        };
    }
    renderChosen();
}

function renderChosen() {
    $('wfChosen').innerHTML = chosen.map((id, i) => {
        const w = workflows.find(x => x.id === id);
        return `<span class="chip">${i === 0 ? '<b>main</b>' : 'lane'} ${esc(w?.name || id)} <button data-rm="${esc(id)}" title="Remove">✕</button></span>`;
    }).join('') || '<span class="muted small">Nothing ticked: the Pod starts in admin mode and you pick a workflow in its panel.</span>';
    for (const b of $('wfChosen').querySelectorAll('[data-rm]')) {
        b.onclick = () => { chosen = chosen.filter(x => x !== b.dataset.rm); renderWorkflows(); loadGpus(); };
    }
    updateSummary();
}

$('wfSearch').oninput = renderWorkflows;
$('wfHideExp').onchange = renderWorkflows;
$('refreshVolumes').onclick = () => loadVolumes().then(loadGpus).catch(e => toast(e.message, true));
$('newVolumeBtn').onclick = () => { $('newVolume').hidden = !$('newVolume').hidden; };
$('volume').onchange = () => { noVolumeUi(); loadGpus(); };
$('community').onchange = loadGpus;
$('refreshGpus').onclick = loadGpus;

$('createVolume').onclick = async () => {
    const b = $('createVolume');
    b.disabled = true;
    try {
        const { volume } = await api('POST', '/api/volumes', { name: $('nvName').value, size: Number($('nvSize').value), dataCenterId: $('nvDc').value });
        toast(`Volume "${volume.name}" created in ${volume.dataCenterId}`);
        settings.volumeId = volume.id;
        $('newVolume').hidden = true;
        await loadVolumes();
        loadGpus();
    } catch (e) { toast(e.message, true); }
    finally { b.disabled = false; }
};

const NO_VOLUME = 'none';
// The "no volume" choice behaves as a volume everywhere a volume is needed:
// it has no data centre of its own, so RunPod may use any.
const selectedVolume = () => $('volume').value === NO_VOLUME
    ? { id: NO_VOLUME, name: 'no network volume', dataCenterId: 'any data centre', none: true }
    : volumes.find(v => v.id === $('volume').value) || null;

let gpuReq = 0;
async function loadGpus() {
    const my = ++gpuReq;
    const vol = selectedVolume();
    const qs = new URLSearchParams({ workflows: chosen.join(','), community: $('community').checked ? '1' : '0' });
    if (vol && !vol.none) qs.set('dataCenterId', vol.dataCenterId);
    $('gpuRows').innerHTML = '<tr><td colspan="6" class="muted">Loading prices…</td></tr>';
    try {
        const d = await api('GET', `/api/gpus?${qs}`);
        if (my !== gpuReq) return;
        gpuData = d;
        // Keep a pick that still fits; otherwise take the recommendation.
        const still = d.rows.find(g => g.id === gpuPick);
        if (!still || still.fits === false) gpuPick = d.recommended;
        for (const id of [...gpuFallback]) if (!d.rows.find(g => g.id === id && g.fits !== false)) gpuFallback.delete(id);
        if (!fallbackTouched) {
            gpuFallback = new Set(d.rows
                .filter(g => g.id !== gpuPick && g.fits !== false && g.available !== false && g.pricePerHr != null)
                .slice(0, AUTO_FALLBACKS).map(g => g.id));
        }
        renderGpus();
    } catch (e) {
        if (my !== gpuReq) return;
        $('gpuRows').innerHTML = `<tr><td colspan="6" class="muted">${esc(e.message)}</td></tr>`;
    }
}

function renderGpus() {
    const d = gpuData;
    const vol = selectedVolume();
    const need = d.need;
    $('needLine').innerHTML = !chosen.length
        ? 'Tick workflows to see which GPUs fit them.'
        : need.gb
            ? `${chosen.length > 1 ? 'These workflows need' : 'This workflow needs'} about <b>${need.gb} GB</b> of VRAM${chosen.length > 1 ? ' together' : ''} (its figure${chosen.length > 1 ? 's added up' : ''}, + 2 GB headroom)`
              + (need.unknown.length ? `; no figure for ${esc(need.unknown.join(', '))}` : '') + '.'
            : 'No VRAM figure for these workflows — pick a GPU with room to spare.';
    const notes = [];
    if (vol?.none) notes.push('No network volume: stock is RunPod-wide, and RunPod puts the Pod in whichever data centre has the GPU free.');
    else if (vol && !d.scopedToDataCenter) notes.push(`Stock is RunPod-wide, not for ${esc(vol.dataCenterId)}: RunPod would not answer for one data centre. A GPU shown in stock may be missing there.`);
    if (!vol) notes.push('No volume selected: stock is RunPod-wide.');
    $('gpuNote').hidden = !notes.length;
    $('gpuNote').innerHTML = notes.join('<br>');

    $('gpuRows').innerHTML = d.rows.map(g => {
        const off = g.fits === false || g.available === false;
        const rec = g.id === d.recommended;
        return `<tr class="${off ? 'off' : ''} ${g.id === gpuPick ? 'picked' : ''}" data-gpu="${esc(g.id)}">
          <td><input type="radio" name="gpu" ${g.id === gpuPick ? 'checked' : ''} ${g.fits === false ? 'disabled' : ''}></td>
          <td>${esc(g.name)}${rec ? '<span class="badge rec">recommended</span>' : ''}${g.fits === false ? '<span class="badge">too small</span>' : ''}</td>
          <td>${g.vramGb} GB</td>
          <td>${g.pricePerHr != null ? '$' + Number(g.pricePerHr).toFixed(2) : '—'}</td>
          <td class="stock-${esc(g.stock)}">${g.stock === 'None' && d.scopedToDataCenter ? 'none here' : esc(g.stock || '—')}</td>
          <td title="Also accept this GPU if the first choice is not available"><label class="check small"><input type="checkbox" data-fb="${esc(g.id)}" ${gpuFallback.has(g.id) ? 'checked' : ''} ${g.fits === false || g.id === gpuPick ? 'disabled' : ''}> fallback</label></td>
        </tr>`;
    }).join('');
    for (const tr of $('gpuRows').querySelectorAll('tr[data-gpu]')) {
        tr.onclick = (ev) => {
            if (ev.target.matches('[data-fb]') || ev.target.closest('label')) return;
            const g = d.rows.find(x => x.id === tr.dataset.gpu);
            if (g.fits === false) return;
            gpuPick = g.id;
            gpuFallback.delete(g.id);
            fallbackTouched = true;
            renderGpus();
        };
    }
    for (const cb of $('gpuRows').querySelectorAll('[data-fb]')) {
        cb.onchange = () => { fallbackTouched = true; cb.checked ? gpuFallback.add(cb.dataset.fb) : gpuFallback.delete(cb.dataset.fb); updateSummary(); };
    }
    updateSummary();
}

// ---- several Pods in one launch -----------------------------------------------------

// Pods set up earlier in this launch. The form above always describes one
// more Pod; "+ Add another Pod" files it here and clears the form.
let batch = [];

// The Pod the form describes, or null without a GPU that fits.
function currentPlan() {
    const g = gpuData?.rows.find(x => x.id === gpuPick);
    if (!g) return null;
    return {
        serve: [...chosen],
        gpuTypeIds: [gpuPick, ...gpuFallback],
        gpuName: g.name,
        price: g.pricePerHr,
        needGb: gpuData.need?.gb ?? null,
        name: $('podName').value.trim() || null,
    };
}

// What the Launch button creates. With Pods already listed, an empty form
// (no workflow ticked) adds nothing: it is just the form being reset.
function plansToLaunch() {
    const cur = currentPlan();
    const formCounts = !batch.length || chosen.length > 0;
    return { plans: [...batch, ...(cur && formCounts ? [cur] : [])], formCounts, cur };
}

const wfName = (id) => workflows.find(w => w.id === id)?.name || id;

function renderBatch() {
    $('batchCard').hidden = !batch.length;
    $('batchPodLabel').hidden = !batch.length;
    $('batchPodLabel').textContent = `Pod ${batch.length + 1}`;
    $('batchList').innerHTML = batch.map((p, i) => `
        <div class="bpod ${p.error ? 'bad' : ''}">
          <div class="bnum">Pod ${i + 1}</div>
          <div class="bbody">
            <div><b>${esc(p.serve.map(wfName).join(' + ') || 'admin mode')}</b>${p.name ? ` <span class="muted small">— ${esc(p.name)}</span>` : ''}</div>
            <div class="muted small">${esc(p.gpuName)}${p.price != null ? ` · $${Number(p.price).toFixed(2)}/h` : ''}${p.gpuTypeIds.length > 1 ? ` · ${p.gpuTypeIds.length - 1} fallback(s)` : ''}${p.needGb ? ` · needs ${p.needGb} GB` : ''}</div>
            ${p.error ? `<div class="small" style="color:var(--bad)">Not created: ${esc(p.error)}</div>` : ''}
          </div>
          <button class="ghost" data-bedit="${i}" title="Move it back into the form above">Edit</button>
          <button class="ghost" data-brm="${i}" title="Remove from this launch">✕</button>
        </div>`).join('');
    for (const b of $('batchList').querySelectorAll('[data-brm]')) {
        b.onclick = () => { batch.splice(Number(b.dataset.brm), 1); renderBatch(); updateSummary(); };
    }
    for (const b of $('batchList').querySelectorAll('[data-bedit]')) {
        b.onclick = () => {
            const [p] = batch.splice(Number(b.dataset.bedit), 1);
            // What the form held goes into the list rather than being lost.
            const cur = currentPlan();
            if (cur && chosen.length) batch.push(cur);
            chosen = [...p.serve];
            $('podName').value = p.name || '';
            gpuPick = p.gpuTypeIds[0];
            gpuFallback = new Set(p.gpuTypeIds.slice(1));
            fallbackTouched = true;
            renderBatch();
            renderWorkflows();
            loadGpus();
            $('wfSearch').scrollIntoView({ behavior: 'smooth', block: 'center' });
        };
    }
}

function resetForm() {
    chosen = [];
    $('podName').value = '';
    gpuPick = null;
    gpuFallback = new Set();
    fallbackTouched = false;
    renderWorkflows();
    loadGpus();
}

$('addToBatch').onclick = () => {
    const cur = currentPlan();
    if (!chosen.length) return toast('Tick the workflows this Pod serves first.', true);
    if (!cur) return toast('Pick a GPU for this Pod first.', true);
    if (batch.length >= 7) return toast('At most 8 Pods in one launch.', true);
    batch.push(cur);
    renderBatch();
    resetForm();
    toast(`Pod ${batch.length} kept. Now tick the workflows for Pod ${batch.length + 1}, or launch.`);
    $('wfSearch').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

function updateSummary() {
    const vol = selectedVolume();
    const { plans, formCounts, cur } = plansToLaunch();
    const b = $('launchBtn');
    b.textContent = plans.length > 1 ? `Launch ${plans.length} Pods` : 'Launch Pod';
    // A form with workflows but no GPU that fits would be dropped silently.
    const formStuck = formCounts && !cur;
    b.disabled = !vol || !plans.length || formStuck;
    const parts = [];
    // With Pods listed, describe what will be created, not the form.
    if (batch.length) {
        const priced = plans.filter(p => p.price != null);
        parts.push(plans.length > 1 ? `${plans.length} Pods` : '1 Pod (listed above)');
        if (priced.length) parts.push(`about $${priced.reduce((s, p) => s + Number(p.price), 0).toFixed(2)}/hour${plans.length > 1 ? ' together' : ''}`);
        if (vol) parts.push(`in ${vol.dataCenterId}`);
        if (formStuck) parts.push('— pick a GPU for the Pod in the form, or untick its workflows');
    } else {
        const g = gpuData?.rows.find(x => x.id === gpuPick);
        if (g) parts.push(`${g.name}${g.pricePerHr != null ? ` at about $${Number(g.pricePerHr).toFixed(2)}/hour` : ''}`);
        if (gpuFallback.size) parts.push(`or ${gpuFallback.size} fallback(s)`);
        if (vol) parts.push(`in ${vol.dataCenterId}`);
        parts.push(chosen.length ? `serving ${chosen.length} workflow(s)` : 'in admin mode');
        const ws = chosen.map(id => workflows.find(w => w.id === id)).filter(Boolean);
        const dl = ws.reduce((a, w) => a + (w.downloadGb || 0), 0);
        if (dl) parts.push(`downloads up to ${dl.toFixed(0)} GB of models the ${vol ? 'volume' : 'Pod disk'} does not have yet`);
        const bad = ws.filter(w => w.cannotFetch);
        if (bad.length) { parts.push(`✗ ${bad.map(w => w.id).join(', ')} cannot fetch all its models on a new machine — untick it`); b.disabled = true; }
    }
    $('launchSummary').textContent = parts.join(', ');
}

$('launchBtn').onclick = async () => {
    const vol = selectedVolume();
    const { plans, formCounts, cur } = plansToLaunch();
    if (!vol || !plans.length) return;
    // Only the admin password is required. No student password just means
    // anyone with the link can book jobs, which is a fine choice to make.
    let allowOpen = false;
    if (plans.some(p => p.serve.length) && !settings.adminPassword.set) {
        allowOpen = confirm("No admin password is saved. Anyone with the Pod's URL could use its admin panel: switch workflows, delete jobs, empty the model quarantine.\n\nLaunch it open anyway?");
        if (!allowOpen) { showTab('creds'); return; }
    }
    // The cost, and what the balance covers, before RunPod is asked for anything.
    const perHr = plans.reduce((a, p) => a + (Number(p.price) || 0), 0);
    await loadSpend();
    if (!confirm(`Launch ${plans.length > 1 ? `${plans.length} Pods` : 'a Pod'} on RunPod at about $${perHr.toFixed(2)}/hour${plans.length > 1 ? ' together' : ''}?\n\nA running Pod bills until you stop it (a stopped one still pays for its disk).${coverage(spend?.runpod?.balance ?? null, perHr, 'RunPod')}`)) return;
    const b = $('launchBtn');
    b.disabled = true;
    b.textContent = plans.length > 1 ? `Launching ${plans.length} Pods…` : 'Launching…';
    try {
        const r = await api('POST', '/api/launch', {
            volumeId: vol.id,
            expectedPerHr: perHr,
            pods: plans.map(p => ({ serve: p.serve, gpuTypeIds: p.gpuTypeIds, name: p.name || undefined })),
            diskGb: Number($('diskGb').value) || 30,
            podVolumeGb: Number($('podVolumeGb').value) || 80,
            community: $('community').checked,
            fetchModels: $('fetchModels').checked,
            syncWorkflows: $('syncWorkflows').checked,
            allowOpen,
        });
        // Keep only the Pods RunPod refused, each with its reason, so pressing
        // Launch again retries just those.
        batch = plans.map((p, i) => ({ ...p, error: r.results[i].ok ? null : r.results[i].error })).filter(p => p.error);
        if (cur && formCounts) resetForm();
        renderBatch();
        const n = r.created.length;
        if (!batch.length) {
            toast(n > 1 ? `${n} Pods created — now billing` : `Pod ${r.pod.id} created — now billing`);
            selectedPod = r.pod.id;
            closeDrawers(); showPage('runpod');
        } else {
            toast(`${n} Pod(s) created and billing; ${batch.length} could not be created — kept below. Press Launch to try them again.`, true);
        }
    } catch (e) {
        toast(e.message, true);
    } finally {
        updateSummary();
    }
};

// ---- pods -----------------------------------------------------------------------

let pods = [];
let selectedPod = store('rpc.pod') || null;
let detailTimer = null;
let listTimer = null;

async function loadPods() {
    try {
        ({ pods, groups } = await api('GET', '/api/pods'));
    } catch (e) {
        $('podList').innerHTML = `<p class="muted">${esc(e.message)}</p>`;
        return;
    }
    $('podCount').textContent = pods.filter(p => p.desiredStatus === 'RUNNING').length || '';
    if (selectedPod && !pods.some(p => p.id === selectedPod)) selectedPod = null;
    if (!selectedPod && pods.length) selectedPod = (pods.find(p => p.desiredStatus === 'RUNNING') || null)?.id || null;
    renderPodList();
    loadDetail();
    loadBuilds();
    loadBookings();
    clearInterval(listTimer);
    listTimer = setInterval(() => { if (pageOpen('runpod') && !document.hidden) loadPods(); }, 30000);
}

// Pods grouped by network volume: Pods on one volume share its models, so
// they are watched, priced and stopped together.
let groups = [];
const builds = {};       // volume id -> { key, builds, distinct } once read

const shortSha = (sha) => String(sha).slice(0, 7);

const POD_STATUS = { RUNNING: ['run', 'Running'], EXITED: ['stop', 'Stopped'], TERMINATED: ['stop', 'Terminated'] };
function podRow(p) {
    const running = p.desiredStatus === 'RUNNING';
    const [dot, label] = POD_STATUS[p.desiredStatus] || ['warn', String(p.desiredStatus || '?').toLowerCase()];
    return `<tr class="${p.id === selectedPod ? 'sel' : ''}" data-pod="${esc(p.id)}">
          <td><b>${esc(p.name)}</b><div class="muted small mono">${esc(p.id)}</div></td>
          <td><span class="status"><span class="dot ${dot}"></span>${esc(label)}</span></td>
          <td>${esc(p.gpu?.name || '—')}</td>
          <td class="small">${esc((p.serve || []).join(', ') || 'admin mode')}</td>
          <td class="num">${p.costPerHr && running ? `$${Number(p.costPerHr).toFixed(2)}/h` : '—'}</td>
          <td class="num">${running ? since(p.lastStartedAt) : '—'}</td>
          <td>${running ? `<a class="small" href="${esc(p.links.students)}" target="_blank" rel="noreferrer" title="This Pod's student page">students ↗</a>` : ''}</td>
        </tr>`;
}

// What the toolbar asks for: text, status and GPU.
function podMatches(p) {
    const q = $('podSearch').value.trim().toLowerCase();
    if ($('podStatus').value && p.desiredStatus !== $('podStatus').value) return false;
    if ($('podGpu').value && (p.gpu?.name || '') !== $('podGpu').value) return false;
    if (!q) return true;
    const hay = [p.name, p.id, p.desiredStatus, p.gpu?.name, ...(p.serve || []), p.networkVolume?.name].join(' ').toLowerCase();
    return q.split(/\s+/).every(t => hay.includes(t));
}
for (const id of ['podSearch', 'podStatus', 'podGpu']) $(id).oninput = () => renderPodList();

function buildLine(g) {
    const b = builds[g.volume?.id];
    const key = runningKey(g);
    if (!g.volume || g.running < 2) return '';
    if (!b || b.key !== key) return '<div class="vbuild muted small">Checking which build each Pod runs…</div>';
    const byId = (id) => pods.find(p => p.id === id)?.name || id;
    if (b.distinct.length > 1) {
        return `<div class="vbuild note bad small"><b>These Pods run different builds</b>: ${Object.entries(b.builds)
            .map(([id, sha]) => `${esc(byId(id))} ${sha ? esc(shortSha(sha)) : 'unknown'}`).join(', ')}.
            A newer image may expect a newer layout on the volume. Stop the older Pod(s) and start them again so they all pull the same image.</div>`;
    }
    const unknown = Object.entries(b.builds).filter(([, sha]) => !sha).map(([id]) => byId(id));
    if (b.distinct.length === 1) {
        return `<div class="vbuild muted small">All on build ${esc(shortSha(b.distinct[0]))}${unknown.length ? `; not known yet for ${esc(unknown.join(', '))} (still starting?)` : ''}.</div>`;
    }
    return '<div class="vbuild muted small">Build not known yet (Pods still starting, or on an image older than the shared volume).</div>';
}

const runningKey = (g) => g.pods.map(id => pods.find(p => p.id === id)).filter(p => p?.desiredStatus === 'RUNNING').map(p => p.id).sort().join(',');

async function loadBuilds() {
    for (const g of groups) {
        if (!g.volume || g.running < 2) continue;
        const key = runningKey(g);
        // A complete answer is kept a minute; one with a Pod still unknown
        // (booting) is asked again at every refresh.
        const prev = builds[g.volume.id];
        if (prev?.key === key && Date.now() - prev.at < 60000 && Object.values(prev.builds).every(Boolean)) continue;
        try {
            const r = await api('GET', `/api/volumes/${encodeURIComponent(g.volume.id)}/builds`);
            builds[g.volume.id] = { key, at: Date.now(), ...r };
        } catch { /* leave it as "checking" */ }
    }
    renderPodList();
}

function renderPodList() {
    // Tiles, and the GPU filter's options, from every Pod (not just the shown ones).
    const runningPods = pods.filter(p => p.desiredStatus === 'RUNNING');
    $('rpTotal').textContent = pods.length;
    $('rpRunning').textContent = runningPods.length;
    $('rpOther').textContent = pods.length - runningPods.length;
    $('rpRate').textContent = `$${runningPods.reduce((a, p) => a + (Number(p.costPerHr) || 0), 0).toFixed(2)}`;
    const gpuSel = $('podGpu'), keep = gpuSel.value;
    const gpus = [...new Set(pods.map(p => p.gpu?.name).filter(Boolean))].sort();
    gpuSel.innerHTML = '<option value="">All GPU types</option>' + gpus.map(g => `<option ${g === keep ? 'selected' : ''}>${esc(g)}</option>`).join('');

    const body = groups.map(g => {
        const members = g.pods.map(id => pods.find(p => p.id === id)).filter(Boolean).filter(podMatches);
        if (!members.length) return '';
        const vname = g.volume ? esc(g.volume.name) : 'No network volume';
        return `<tr class="group"><td colspan="7"><div class="row wrap">
            <span><b>${vname}</b>${g.volume?.dataCenterId ? ` <span class="muted">${esc(g.volume.dataCenterId)}</span>` : ''}
            <span class="muted"> · ${g.running ? `${g.running} running · <b>$${g.costPerHr.toFixed(2)}/h</b>${g.running > 1 ? ' together' : ''}` : 'nothing running'}</span></span>
            <span style="flex:1"></span>
            ${g.volume ? `<button class="ghost small" data-folders="${esc(g.volume.id)}" ${g.running ? '' : 'disabled title="Start a Pod on this volume to look inside it"'}>Folders…</button>` : ''}
            ${g.running > 1 ? `<button class="ghost small" data-stopall="${esc(g.volume?.id || '')}">Stop all ${g.running}</button>` : ''}
          </div>${buildLine(g)}</td></tr>
          ${members.map(podRow).join('')}`;
    }).join('');
    $('podList').innerHTML = body
        ? `<table><thead><tr><th>Pod</th><th>Status</th><th>GPU</th><th>Serving</th><th class="num">Cost</th><th class="num">Up for</th><th></th></tr></thead><tbody>${body}</tbody></table>`
        : pods.length
            ? '<div class="empty"><p>No Pod matches.</p></div>'
            : `<div class="empty"><div class="ico">▤</div><p><b>No Pods found</b></p><p class="muted">Create a Pod to get started</p><p><button class="cta" data-create="pod">+ Create a Pod</button></p></div>`;
    for (const b of $('podList').querySelectorAll('[data-create]')) b.onclick = () => openDrawer('createPod');
    for (const el of $('podList').querySelectorAll('[data-pod]')) {
        el.onclick = (ev) => {
            if (ev.target.closest('a')) return;
            selectedPod = selectedPod === el.dataset.pod && !folderView ? null : el.dataset.pod;
            store('rpc.pod', selectedPod || ''); folderView = null; renderPodList(); loadDetail();
            $('podDetail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        };
    }
    for (const b of $('podList').querySelectorAll('[data-folders]')) {
        b.onclick = (ev) => { ev.stopPropagation(); folderView = b.dataset.folders; $('podDetail').hidden = false; loadFolders(); $('podDetail').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
    }
    for (const b of $('podList').querySelectorAll('[data-stopall]')) {
        b.onclick = async (ev) => {
            ev.stopPropagation();
            const g = groups.find(x => (x.volume?.id || '') === b.dataset.stopall);
            const running = g.pods.map(id => pods.find(p => p.id === id)).filter(p => p?.desiredStatus === 'RUNNING');
            if (!confirm(`Stop ${running.length} Pods on "${g.volume?.name || 'no volume'}"?\n\n${running.map(p => p.name).join('\n')}\n\nGPU billing ends once each has stopped. Their queues and results stay on the volume.`)) return;
            b.disabled = true;
            const errors = [];
            for (const p of running) {
                try { await api('POST', `/api/pods/${p.id}/stop`); } catch (e) { errors.push(`${p.name}: ${e.message}`); }
            }
            errors.length ? toast(`Could not stop: ${errors.join('; ')}`, true) : toast(`Stopping ${running.length} Pods`);
            setTimeout(loadPods, 1500);
        };
    }
}

function since(iso) {
    if (!iso) return '—';
    const t = Date.parse(String(iso).replace(' ', 'T').replace(/ \+0000 UTC$/, 'Z'));
    if (!t) return esc(iso);
    const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

// Where a Pod is on its way from created to serving.
function stageOf(pod, probe) {
    const serve = pod.serve || [];
    if (pod.desiredStatus === 'EXITED') return { key: 'stopped', label: 'Stopped — not billing for the GPU' };
    if (pod.desiredStatus === 'TERMINATED') return { key: 'stopped', label: 'Terminated' };
    if (!probe?.answering) {
        if (probe?.plan?.status === 'done') return { key: 'starting', label: 'Restarting into serving mode…' };
        return { key: 'booting', label: 'Starting — pulling the image and booting (a few minutes the first time)' };
    }
    const plan = probe.plan;
    if (plan?.status === 'refused' || plan?.status === 'failed') return { key: 'failed', label: plan.error };
    if (plan?.status === 'fetching') return { key: 'fetching', label: 'Downloading models onto the volume' };
    if (plan?.status === 'pending') return { key: 'fetching', label: 'Preparing' };
    const served = probe.served.map(w => w.id);
    if (probe.mode === 'student' && serve.every(id => served.includes(id))) return { key: 'serving', label: `Serving ${served.length} workflow(s)` };
    if (probe.mode === 'student') return { key: 'starting', label: 'Starting ComfyUI and opening the workflows…' };
    if (serve.length) return { key: 'starting', label: 'Switching to serving mode…' };
    return { key: 'admin', label: 'Up in admin mode — pick a workflow in its admin panel' };
}

const STAGES = [['booting', 'Booting'], ['fetching', 'Models'], ['starting', 'Starting'], ['serving', 'Serving']];

async function loadDetail() {
    clearTimeout(detailTimer);
    if (folderView) return;
    const box = $('podDetail');
    box.hidden = !selectedPod;
    if (!selectedPod) return;
    let d;
    try { d = await api('GET', `/api/pods/${encodeURIComponent(selectedPod)}`); }
    catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
    const { pod, probe } = d;
    const st = stageOf(pod, probe);
    const order = STAGES.map(s => s[0]);
    const at = order.indexOf(st.key);
    const stages = st.key === 'failed'
        ? `<span class="stage bad">Did not start serving</span>`
        : (st.key === 'stopped' || st.key === 'admin') ? ''
        : STAGES.map(([k, l], i) => `<span class="stage ${i < at ? 'done' : i === at ? (k === 'serving' ? 'done' : 'now') : ''}">${l}</span>`).join('');

    const plan = probe?.plan;
    const files = (plan?.files || []).map(f => {
        const pct = f.total ? Math.round(100 * f.received / f.total) : (f.status === 'done' ? 100 : 0);
        const what = f.status === 'waiting' ? `waiting for Pod ${f.waitingFor || '?'} to finish downloading it`
            : f.status === 'done' && f.installedBy ? 'done (downloaded by another Pod)' : f.status;
        return `<div class="file"><div>${esc(f.name)} <span class="muted small">— ${esc(what)}${f.total && f.status !== 'waiting' ? ` · ${gb(f.received)} / ${gb(f.total)} GB` : ''}</span></div>
            ${f.error ? `<div class="small" style="color:var(--bad)">${esc(f.error)}</div>` : ''}
            ${f.status === 'downloading' ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}</div>`;
    }).join('');

    const running = pod.desiredStatus === 'RUNNING';
    const usage = probe?.usage;
    box.innerHTML = `
      <div class="row"><h2>${esc(pod.name)}</h2>
        ${running ? '<button id="stopPod" class="secondary">Stop</button>' : '<button id="startPod" class="secondary">Start</button>'}
        <button id="termPod" class="danger">Terminate…</button>
      </div>
      <div class="note ${st.key === 'failed' ? 'bad' : st.key === 'serving' ? 'good' : ''}">${esc(st.label)}${st.key === 'failed' ? '<br><b>The GPU is still billing.</b> Fix the cause and restart the Pod, or stop it.' : ''}</div>
      <div class="stages">${stages}</div>
      ${running ? `<div class="links">
        <a href="${esc(pod.links.students)}" target="_blank" rel="noreferrer">Student page ↗</a>
        <a href="${esc(pod.links.admin)}" target="_blank" rel="noreferrer">Admin panel ↗</a>
        <a href="${esc(pod.links.comfyui)}" target="_blank" rel="noreferrer">ComfyUI ↗</a>
        <button class="ghost small" id="copyStudents">Copy student link</button>
        ${!pod.networkVolume ? '<button class="secondary small" id="podResults">Download results</button>' : ''}
      </div>${studentLinksHtml(pod.links, Object.fromEntries((probe?.served || []).map(w => [w.id, w.name])))}` : ''}
      <dl class="kv">
        <dt>Pod id</dt><dd>${esc(pod.id)}</dd>
        <dt>GPU</dt><dd>${esc(pod.gpu?.name || '—')}${probe?.gpu ? ` <span class="muted">(${esc(probe.gpu)})</span>` : ''}</dd>
        <dt>Cost</dt><dd>${pod.costPerHr ? `$${Number(pod.costPerHr).toFixed(2)} / hour` : '—'}</dd>
        <dt>Running for</dt><dd>${running ? since(pod.lastStartedAt) : '—'}</dd>
        <dt>Volume</dt><dd>${esc(pod.networkVolume?.name || '—')} ${pod.networkVolume ? `<span class="muted">(${esc(pod.networkVolume.dataCenterId)})</span>` : ''}</dd>
        <dt>Image</dt><dd>${esc(pod.image || '—')}</dd>
        <dt>Asked to serve</dt><dd>${esc(pod.serve.join(', ') || '— (admin mode)')}</dd>
        <dt>ComfyQ</dt><dd>${probe?.answering ? `${esc(probe.mode)} mode${probe.served.length ? ', serving ' + esc(probe.served.map(w => w.id + (w.busy ? ' (busy)' : '')).join(', ')) : ''}` : 'not answering yet'}</dd>
        ${usage ? `<dt>Students</dt><dd>${esc(usage.usersConnected ?? 0)} connected</dd>` : ''}
        ${probe?.jobs ? `<dt>Queue</dt><dd>${probe.jobs.running ? '1 running' : 'nothing running'}, ${(probe.jobs.scheduled || []).length} waiting</dd>` : ''}
      </dl>
      ${files ? `<h2>Models</h2><div class="files">${files}</div>` : ''}`;

    wireCopyLinks(box);
    if ($('stopPod')) $('stopPod').onclick = () => podAction('stop');
    if ($('startPod')) $('startPod').onclick = () => podAction('start');
    $('termPod').onclick = async () => {
        const typed = await askCode({ title: `Terminate ${pod.name}?`, code: pod.id, button: 'Terminate Pod',
            text: pod.networkVolume
                ? 'Terminate deletes the Pod. The network volume and its models stay.'
                : 'This Pod has NO network volume: terminating it deletes its models AND every result students made on it. Download its results first (Download results, while it runs).' });
        if (typed === null) return;
        try { await api('DELETE', `/api/pods/${pod.id}`, { confirm: typed.trim() }); toast('Pod terminated'); selectedPod = null; loadPods(); }
        catch (e) { toast(e.message, true); }
    };
    if ($('podResults')) $('podResults').onclick = async () => {
        try { const { url } = await api('POST', `/api/pods/${pod.id}/download`); location.href = url; toast('The download starts once the Pod has begun zipping the results'); }
        catch (e) { toast(e.message, true); }
    };
    if ($('copyStudents')) $('copyStudents').onclick = () => {
        navigator.clipboard.writeText(pod.links.students).then(() => toast('Student link copied'), () => toast(pod.links.students));
    };

    // Poll fast while something is happening, slowly once it is settled.
    const busy = ['booting', 'fetching', 'starting'].includes(st.key);
    detailTimer = setTimeout(() => { if (pageOpen('runpod') && !document.hidden) loadDetail(); else detailTimer = setTimeout(loadDetail, 5000); }, busy ? 5000 : 20000);
}

// ---- folders Pods left on a volume (I6) -------------------------------------------

let folderView = null;   // volume id whose folders the detail panel shows

const size = (b) => b >= 1024 ** 3 ? `${gb(b)} GB` : `${(Number(b || 0) / 1024 ** 2).toFixed(1)} MB`;
const KIND = {
    reader: (f, via) => `this is the folder of ${esc(via.name)}, the Pod reading the volume`,
    running: (f) => `Pod ${esc(f.pod?.name || f.id)} is running`,
    stopped: (f) => `Pod ${esc(f.pod?.name || f.id)} is stopped — this is its queue and results, kept for when it starts again`,
    orphan: () => '<b>no Pod with this id exists any more</b> — left behind',
    unfinished: () => 'a delete that did not finish',
};

async function loadFolders() {
    clearTimeout(detailTimer);
    const box = $('podDetail');
    const vol = groups.find(g => g.volume?.id === folderView)?.volume;
    box.innerHTML = `<h2>Folders on ${esc(vol?.name || folderView)}</h2><p class="muted">Reading the volume through a running Pod… (sizing large folders takes a moment)</p>`;
    let d;
    try { d = await api('GET', `/api/volumes/${encodeURIComponent(folderView)}/folders`); }
    catch (e) { box.innerHTML = `<h2>Folders on ${esc(vol?.name || folderView)}</h2><div class="note bad">${esc(e.message)}</div>`; return; }
    if (!folderView) return;
    const left = d.folders.filter(f => f.kind === 'orphan' || f.kind === 'unfinished');
    const leftBytes = left.reduce((s, f) => s + f.bytes, 0);
    box.innerHTML = `
      <div class="row"><h2>Folders on ${esc(vol?.name || folderView)}</h2><button id="refreshFolders" class="ghost">Refresh</button></div>
      <p class="muted">Each Pod keeps its queue, settings, results and uploads in its own folder. Terminating a Pod leaves its folder behind. Read through Pod ${esc(d.via.name)}. The models are shared and not listed here.</p>
      <div class="note ${left.length ? '' : 'good'}">${left.length
          ? `${left.length} folder${left.length > 1 ? 's' : ''} left behind by Pods that no longer exist: <b>${size(leftBytes)}</b>. Download their results if you need them, then delete them. Nothing is deleted unless you ask.`
          : 'No folder left behind: every folder belongs to a Pod that still exists.'}</div>
      <div class="folders">${d.folders.map(f => `
        <div class="folder ${f.kind}">
          <div class="fmain">
            <div><b>${esc(f.id)}</b> <span class="muted small">${size(f.bytes)} · ${f.outputs} result file${f.outputs === 1 ? '' : 's'} · ${f.files} files · changed ${since(f.lastModified ? new Date(f.lastModified).toISOString() : null)} ago</span></div>
            <div class="small ${f.kind === 'orphan' ? '' : 'muted'}">${KIND[f.kind](f, d.via)}</div>
          </div>
          ${f.kind === 'orphan' && f.outputs ? `<button class="secondary small" data-dl="${esc(f.id)}">Download results</button>` : ''}
          ${f.kind === 'orphan' || f.kind === 'unfinished' ? `<button class="danger small" data-del="${esc(f.id)}">Delete…</button>` : ''}
        </div>`).join('')}</div>`;
    $('refreshFolders').onclick = loadFolders;
    for (const b of box.querySelectorAll('[data-dl]')) {
        b.onclick = async () => {
            try {
                const { url } = await api('POST', `/api/volumes/${encodeURIComponent(folderView)}/folders/${encodeURIComponent(b.dataset.dl)}/download`);
                location.href = url;
                toast('The download starts once the Pod has begun zipping the results');
            } catch (e) { toast(e.message, true); }
        };
    }
    for (const b of box.querySelectorAll('[data-del]')) {
        b.onclick = async () => {
            const f = d.folders.find(x => x.id === b.dataset.del);
            const typed = await askCode({ title: `Delete the folder ${f.id} from the volume?`, code: f.id, button: 'Delete folder',
                text: `${size(f.bytes)}, ${f.outputs} result file(s) and the job queue of a Pod that no longer exists. This cannot be undone${f.outputs ? ' — download the results first if anyone needs them' : ''}.` });
            if (typed === null) return;
            b.disabled = true;
            try {
                const r = await api('DELETE', `/api/volumes/${encodeURIComponent(folderView)}/folders/${encodeURIComponent(f.id)}`, { confirm: typed.trim() });
                toast(`Deleted ${f.id}: ${size(r.bytes)} freed`);
                loadFolders();
            } catch (e) { toast(e.message, true); b.disabled = false; }
        };
    }
}

// ---- attempts ----------------------------------------------------------------------

let attemptsTimer = null;
const shortGpu = (id) => String(id).replace(/^NVIDIA /, '').replace(/ Blackwell/, '').replace(/ Edition$/, '');
async function loadAttempts() {
    clearTimeout(attemptsTimer);
    try {
        const d = await api('GET', '/api/attempts?limit=300');
        $('attemptsFile').textContent = d.file;
        const h = d.lastHour;
        const last = d.attempts[0];
        $('attemptsSummary').innerHTML = `Last hour: <b>${h.tries}</b> tries, <b>${h.created}</b> got a GPU, ${h.noMachine} found no machine free.`
            + (last ? ` Latest: ${new Date(last.at).toLocaleTimeString()} — ${esc(last.result)}.` : ' Nothing tried yet.');
        $('attemptsSummary').className = 'note ' + (h.created ? 'good' : '');
        // Each provider's page shows its own attempts.
        const rp = d.attempts.filter(a => a.provider !== 'thunder');
        const th = d.attempts.filter(a => a.provider === 'thunder');
        const lastRp = rp[0];
        $('attemptsSummaryShort').textContent = lastRp ? `latest ${new Date(lastRp.at).toLocaleTimeString()} — ${lastRp.result}` : 'nothing tried yet';
        $('tAttemptsSummary').textContent = th.length ? `${th.length} launch${th.length > 1 ? 'es' : ''}, latest ${new Date(th[0].at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} — ${th[0].result}` : 'none yet';
        $('tAttemptRows').innerHTML = th.map(a => {
            const good = a.result === 'created';
            return `<tr class="${good ? 'picked' : ''}">
              <td>${new Date(a.at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
              <td>${esc(a.source)}</td>
              <td class="small">${esc(a.name || '')}${a.podId ? ` <span class="muted mono">${esc(a.podId)}</span>` : ''}</td>
              <td>${esc((a.gpus || []).join(', '))}</td>
              <td class="${good ? 'stock-High' : a.result === 'no machine' ? 'muted' : 'stock-None'}" title="${esc(a.message || '')}">${esc(a.result)}${good && a.costPerHr ? ` · $${Number(a.costPerHr).toFixed(2)}/h` : ''}${a.result === 'error' ? ` — ${esc(String(a.message || '').slice(0, 90))}` : ''}</td>
            </tr>`;
        }).join('') || '<tr><td colspan="5" class="muted">No launch on Thunder recorded yet.</td></tr>';
        $('attemptRows').innerHTML = rp.map(a => {
            const good = a.result === 'created' || a.result === 'started';
            return `<tr class="${good ? 'picked' : ''}">
              <td>${new Date(a.at).toLocaleTimeString()}</td>
              <td>${esc(a.source)}</td>
              <td>${esc(a.name || a.podId || '')}</td>
              <td class="small">${esc((a.gpus || []).map(shortGpu).join(', ') || (a.action === 'start' ? '(its own)' : ''))}</td>
              <td>${esc(a.where || '')}</td>
              <td class="${good ? 'stock-High' : a.result === 'no machine' ? 'muted' : 'stock-None'}" title="${esc(a.message || '')}">${esc(a.result)}${good && a.podId ? ` · ${esc(a.podId)}` : ''}${good && a.costPerHr ? ` · $${Number(a.costPerHr).toFixed(2)}/h` : ''}${a.result === 'error' ? ` — ${esc(String(a.message || '').slice(0, 90))}` : ''}</td>
            </tr>`;
        }).join('') || '<tr><td colspan="6" class="muted">No attempt recorded yet.</td></tr>';
    } catch (e) { $('attemptsSummary').textContent = e.message; }
    attemptsTimer = setTimeout(() => { if (($('attemptsFold').open && pageOpen('runpod') || $('tAttemptsFold').open && pageOpen('thunder')) && !document.hidden) loadAttempts(); }, 5000);
}
$('refreshAttempts').onclick = loadAttempts;

// ---- stock history -----------------------------------------------------------------
//
// Readings taken every 15 minutes by a GitHub Actions job. Three views of the
// same question — "how often was this card free?" — for the chosen period:
// per data centre (bars), over time (one strip per data centre), and by
// weekday × hour for one data centre. Times are this computer's local time.

let stock = null;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const RANGES = [['24h', '24 hours', 864e5], ['7d', '7 days', 7 * 864e5], ['30d', '30 days', 30 * 864e5]];
const stockSel = { gpu: store('rpc.stockGpu') || '*', range: store('rpc.stockRange') || '7d', dc: store('rpc.stockDc') || null };
// Five steps of one blue, from "rarely free" to "almost always": a share of
// 0 shows the empty cell itself, so "never free" and "free 5%" never look alike.
const seqStep = (p) => p <= 0 ? 0 : 1 + Math.min(4, Math.floor(p * 5));

async function loadStock() {
    $('stockNote').textContent = 'Reading the history from GitHub…';
    try { stock = await api('GET', '/api/stock?months=2'); }
    catch (e) { $('stockNote').textContent = e.message; return; }
    renderStock();
}

const tip = () => $('chartTip');
function showTip(ev, html) {
    const t = tip();
    t.innerHTML = html;
    t.hidden = false;
    const pad = 14, w = t.offsetWidth, h = t.offsetHeight;
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + w > innerWidth - 8) x = ev.clientX - w - pad;
    if (y + h > innerHeight - 8) y = ev.clientY - h - pad;
    t.style.left = `${x}px`; t.style.top = `${y}px`;
}
const hideTip = () => { tip().hidden = true; };

function renderStock() {
    const all = stock?.readings || [];
    if (!all.length) {
        $('stockNote').innerHTML = `No reading yet. The GitHub job writes one every 15 minutes to the <code>runpod-stock</code> branch (see <code>tools/runpod/README.md</code>). Looked in ${esc(stock?.source || '')}.`;
        for (const id of ['stockBars', 'stockStrips', 'stockHeat', 'stockTable', 'stockGpuChips']) $(id).innerHTML = '';
        return;
    }
    // ---- filters --------------------------------------------------------------------
    const gpus = [...new Set(all.flatMap(x => Object.values(x.dc).flatMap(l => l.map(g => g[0]))))].sort();
    if (stockSel.gpu !== '*' && !gpus.includes(stockSel.gpu)) stockSel.gpu = '*';
    $('stockGpuChips').innerHTML = [['*', 'Any card of 24 GB+'], ...gpus.map(g => [g, shortGpu(g)])]
        .map(([v, l]) => `<button class="chip-btn ${v === stockSel.gpu ? 'on' : ''}" data-gpu="${esc(v)}">${esc(l)}</button>`).join('');
    $('stockRangeChips').innerHTML = RANGES
        .map(([v, l]) => `<button class="chip-btn ${v === stockSel.range ? 'on' : ''}" data-range="${v}">${l}</button>`).join('');

    const span = RANGES.find(r => r[0] === stockSel.range)[2];
    const since = Date.now() - span;
    const rows = all.filter(x => Date.parse(x.at) >= since);
    const wanted = (g) => stockSel.gpu === '*' || g[0] === stockSel.gpu;
    // A data centre that could not be read is left out of that reading, never
    // counted as "none free".
    const dcs = [...new Set(rows.flatMap(x => Object.keys(x.dc)))];
    const per = dcs.map(dc => {
        const seen = rows.filter(x => x.dc[dc] !== undefined);
        const freeRows = seen.filter(x => x.dc[dc].some(wanted));
        const prices = freeRows.flatMap(x => x.dc[dc].filter(wanted).map(g => g[2])).filter(p => p != null);
        return { dc, n: seen.length, free: freeRows.length, share: seen.length ? freeRows.length / seen.length : 0, cheapest: prices.length ? Math.min(...prices) : null };
    }).sort((a, b) => b.share - a.share || a.dc.localeCompare(b.dc));
    const volDc = selectedVolume()?.dataCenterId;
    // Unless one was clicked: the volume's data centre (EU-RO-1 when the Launch
    // tab has not loaded the volumes yet), else the one with the most stock.
    if (!stockSel.dc || !per.some(p => p.dc === stockSel.dc)) stockSel.dc = per.find(p => p.dc === (volDc || 'EU-RO-1'))?.dc || per[0]?.dc;

    const label = stockSel.gpu === '*' ? 'a card of 24 GB or more' : shortGpu(stockSel.gpu);
    const last = rows.at(-1);
    const sel = per.find(p => p.dc === stockSel.dc);
    const nowFree = last?.dc[stockSel.dc]?.some(wanted);
    $('stockNote').innerHTML = `<b>${rows.length}</b> readings in the last ${RANGES.find(r => r[0] === stockSel.range)[1]}`
        + (rows[0] ? ` (since ${new Date(rows[0].at).toLocaleString()})` : '') + `. ${esc(stockSel.dc)}: ${esc(label)} free in <b>${sel ? Math.round(100 * sel.share) : 0}%</b> of them`
        + (sel?.cheapest != null ? `, from $${sel.cheapest.toFixed(2)}/h` : '') + '. '
        + (last ? `Latest reading (${new Date(last.at).toLocaleTimeString()}): <b>${nowFree ? 'free' : 'none free'}</b>.` : '');
    $('stockNote').className = 'note ' + (nowFree ? 'good' : '');

    // ---- 1. bars: share of readings free, per data centre ----------------------------------
    $('stockBarsTitle').textContent = `How often ${label} was free, by data centre`;
    $('stockBars').innerHTML = per.map((p, i) => `
        <div class="bar-row ${p.dc === stockSel.dc ? 'sel' : ''}" data-dc="${esc(p.dc)}" data-i="${i}">
          <span class="bar-label">${esc(p.dc)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${(100 * p.share).toFixed(1)}%"></span></span>
          <span class="bar-value">${p.free ? `${Math.round(100 * p.share)}%` : 'never'}</span>
        </div>`).join('');

    // ---- 2. strips: over time, per data centre, by the hour ----------------------------------
    const hour = 36e5;
    const start = Math.floor((rows[0] ? Date.parse(rows[0].at) : since) / hour) * hour;
    const nCols = Math.max(1, Math.ceil((Date.now() - start) / hour));
    // Only the data centres that had it at least once, plus the chosen one.
    const stripDcs = per.filter(p => p.free > 0 || p.dc === stockSel.dc).map(p => p.dc);
    const cells = {};
    for (const x of rows) {
        const c = Math.floor((Date.parse(x.at) - start) / hour);
        for (const dc of stripDcs) {
            if (x.dc[dc] === undefined) continue;
            const k = `${dc}|${c}`;
            const cell = cells[k] || (cells[k] = { n: 0, free: 0, cards: new Map() });
            cell.n++;
            const hit = x.dc[dc].filter(wanted);
            if (hit.length) cell.free++;
            for (const g of hit) cell.cards.set(g[0], g[2]);
        }
    }
    stockCells = { cells, start, hour };
    const tickEvery = nCols > 48 ? 24 : 6;
    const ticks = Array.from({ length: nCols }, (_, c) => {
        const t = new Date(start + c * hour);
        return t.getHours() % tickEvery === 0 ? `<span style="grid-column:${c + 1}">${tickEvery === 24 ? `${DAYS[(t.getDay() + 6) % 7]} ${t.getDate()}` : `${t.getHours()}:00`}</span>` : '';
    }).join('');
    $('stockStrips').innerHTML = stripDcs.map(dc => `
        <div class="strip-row ${dc === stockSel.dc ? 'sel' : ''}" data-dc="${esc(dc)}">
          <span class="bar-label">${esc(dc)}</span>
          <span class="strip" style="grid-template-columns:repeat(${nCols},1fr)">${Array.from({ length: nCols }, (_, c) => {
              const cell = cells[`${dc}|${c}`];
              const cls = !cell ? 'gap' : `s${seqStep(cell.free / cell.n)}`;
              return `<i class="${cls}" data-k="${esc(dc)}|${c}"></i>`;
          }).join('')}</span>
        </div>`).join('')
        + `<div class="strip-row axis"><span class="bar-label"></span><span class="strip ticks" style="grid-template-columns:repeat(${nCols},1fr)">${ticks}</span></div>`
        + (stripDcs.length ? '' : `<p class="muted">${esc(label)} was not free anywhere in this period.</p>`);

    // ---- 3. heatmap: by weekday and hour, chosen data centre ----------------------------------
    const total = Array.from({ length: 7 }, () => Array(24).fill(0));
    const hits = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const x of rows) {
        if (x.dc[stockSel.dc] === undefined) continue;
        const t = new Date(x.at);
        const d = (t.getDay() + 6) % 7, h = t.getHours();
        total[d][h]++;
        if (x.dc[stockSel.dc].some(wanted)) hits[d][h]++;
    }
    stockHeat = { total, hits };
    $('stockHeatTitle').textContent = `${stockSel.dc}: by weekday and hour (your local time)`;
    $('stockHeat').innerHTML = `<thead><tr><th></th>${Array.from({ length: 24 }, (_, h) => `<th>${h % 3 === 0 ? h : ''}</th>`).join('')}</tr></thead><tbody>`
        + DAYS.map((d, i) => `<tr><th>${d}</th>${Array.from({ length: 24 }, (_, h) =>
            `<td class="hm ${total[i][h] ? `s${seqStep(hits[i][h] / total[i][h])}` : 'gap'}" data-d="${i}" data-h="${h}"></td>`).join('')}</tr>`).join('') + '</tbody>';

    // ---- table view: the same figures as text ----------------------------------------------
    $('stockTable').innerHTML = `<thead><tr><th>Data centre</th><th>Readings</th><th>Free in</th><th>Cheapest</th></tr></thead><tbody>`
        + per.map(p => `<tr><td>${esc(p.dc)}</td><td>${p.n}</td><td>${p.free} (${Math.round(100 * p.share)}%)</td><td>${p.cheapest != null ? `$${p.cheapest.toFixed(2)}/h` : '—'}</td></tr>`).join('') + '</tbody>';
    stockPer = per;
}

let stockCells = null, stockHeat = null, stockPer = [];
const pct = (a, b) => b ? Math.round(100 * a / b) : 0;

// One set of listeners on the stable containers (the contents are redrawn).
$('stockGpuChips').onclick = (e) => { const b = e.target.closest('[data-gpu]'); if (!b) return; stockSel.gpu = b.dataset.gpu; store('rpc.stockGpu', stockSel.gpu); renderStock(); };
$('stockRangeChips').onclick = (e) => { const b = e.target.closest('[data-range]'); if (!b) return; stockSel.range = b.dataset.range; store('rpc.stockRange', stockSel.range); renderStock(); };
for (const id of ['stockBars', 'stockStrips']) {
    $(id).onclick = (e) => { const r = e.target.closest('[data-dc]'); if (!r) return; stockSel.dc = r.dataset.dc; store('rpc.stockDc', stockSel.dc); renderStock(); };
}
$('stockBars').onmousemove = (e) => {
    const r = e.target.closest('[data-i]'); if (!r) return hideTip();
    const p = stockPer[Number(r.dataset.i)];
    showTip(e, `<b>${esc(p.dc)}</b><br>free in ${p.free} of ${p.n} readings (${pct(p.free, p.n)}%)${p.cheapest != null ? `<br>from $${p.cheapest.toFixed(2)}/h` : ''}<br><span class="muted">click to see it below</span>`);
};
$('stockStrips').onmousemove = (e) => {
    const i = e.target.closest('[data-k]'); if (!i) return hideTip();
    const [dc, c] = i.dataset.k.split('|');
    const cell = stockCells.cells[i.dataset.k];
    const t = new Date(stockCells.start + Number(c) * stockCells.hour);
    const when = `${DAYS[(t.getDay() + 6) % 7]} ${t.toLocaleDateString()} ${t.getHours()}:00–${t.getHours() + 1}:00`;
    if (!cell) return showTip(e, `<b>${esc(dc)}</b> · ${when}<br>no reading`);
    showTip(e, `<b>${esc(dc)}</b> · ${when}<br>free in ${cell.free} of ${cell.n} readings`
        + (cell.cards.size ? '<br>' + [...cell.cards].map(([g, p]) => `${esc(shortGpu(g))}${p != null ? ` $${p.toFixed(2)}/h` : ''}`).join('<br>') : ''));
};
$('stockHeat').onmousemove = (e) => {
    const td = e.target.closest('td[data-d]'); if (!td) return hideTip();
    const d = Number(td.dataset.d), h = Number(td.dataset.h);
    const n = stockHeat.total[d][h], f = stockHeat.hits[d][h];
    showTip(e, `<b>${DAYS[d]} ${h}:00–${h + 1}:00</b><br>${n ? `free in ${f} of ${n} readings (${pct(f, n)}%)` : 'no reading yet'}`);
};
for (const id of ['stockBars', 'stockStrips', 'stockHeat']) $(id).onmouseleave = hideTip;
$('refreshStock').onclick = loadStock;

async function podAction(verb) {
    try { await api('POST', `/api/pods/${selectedPod}/${verb}`); toast(verb === 'stop' ? 'Stopping — GPU billing ends once it has stopped' : 'Starting'); setTimeout(loadPods, 1500); }
    catch (e) { toast(e.message, true); }
}
$('refreshPods').onclick = loadPods;

// ---- spending (every tab) ---------------------------------------------------------

let spend = null, spendAt = 0;
const money = (v) => v == null ? "—" : `$${v < 1000 ? v.toFixed(2) : Math.round(v)}`;
function dur(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
async function loadSpend() {
    try { spend = await api('GET', '/api/spend'); spendAt = Date.now(); renderSpend(); }
    catch (e) { $('spNote').textContent = `Spending could not be read: ${e.message}`; }
}
function renderSpend() {
    if (!spend) return;
    // Between two readings, everything running keeps adding up at its rate.
    const extra = spend.ratePerHr * (Date.now() - spendAt) / 3600000;
    const today = spend.today + extra;
    $('spRate').textContent = `${money(spend.ratePerHr)}/h`;
    $('spRate').parentElement.classList.toggle('billing', spend.ratePerHr >= 0.05);
    const nGpu = spend.machines.length;
    $('spRateSub').textContent = nGpu ? `${nGpu} machine${nGpu > 1 ? 's' : ''} running` : spend.ratePerHr > 0 ? 'storage only' : 'nothing running';
    $('spToday').textContent = money(today);
    // The ledger only knows what it has seen: say so the first day it runs.
    const startedLate = (since, from) => since && since - from > 5 * 60000 ? new Date(since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
    const dayFrom = new Date(); dayFrom.setHours(0, 0, 0, 0);
    const lateToday = startedLate(spend.runpod.countingSince?.today, dayFrom.getTime());
    $('spProj').textContent = spend.ratePerHr >= 0.05 ? `≈ ${money(spend.projectedToday)} by midnight if left on`
        : lateToday ? `counted from ${lateToday}` : '';
    $('spMonth').textContent = money(spend.month + extra);
    const monthFrom = new Date(dayFrom); monthFrom.setDate(1);
    const lateMonth = spend.runpod.countingSince?.month && spend.runpod.countingSince.month - monthFrom.getTime() > 5 * 60000
        ? new Date(spend.runpod.countingSince.month).toLocaleDateString([], { day: 'numeric', month: 'short' }) : null;
    $('spMonthSub').textContent = `Thunder ${money(spend.thunder.month)} · RunPod ${money(spend.runpod.month)}${lateMonth ? ` · counted from ${lateMonth}` : ''}`;
    $('spBal').textContent = money(spend.runpod.balance);
    $('spLeft').textContent = spend.runpod.hoursLeft != null
        ? (spend.runpod.hoursLeft > 72 ? `≈ ${Math.round(spend.runpod.hoursLeft / 24)} days at this rate` : `≈ ${spend.runpod.hoursLeft} h at this rate`) : '';
    const tb = spend.thunder;
    $('spTBal').textContent = tb.balance != null ? `≈ ${money(tb.balance)}` : 'not set';
    $('spTLeft').textContent = tb.balance == null ? 'type it from Thunder\'s billing page'
        : `${tb.hoursLeft != null ? `≈ ${tb.hoursLeft} h at this rate · ` : ''}set ${new Date(tb.balanceEnteredAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}, ${money(tb.spentSinceEntered)} used since`;
    $('spTBal').parentElement.classList.toggle('low', tb.balance != null && tb.balance < 2);
    // Once a balance is saved, show it and keep the box out of the way: an empty
    // box under a saved balance reads as if the balance were lost.
    if (!tBalEditing) { $('spTBalForm').hidden = tb.balance != null; $('spTBalEdit').hidden = tb.balance == null; }
    $('spBal').parentElement.classList.toggle('low', spend.runpod.balance != null && spend.runpod.balance < 2);
    const b = spend.budgetPerDay;
    if (document.activeElement !== $('spBudget')) $('spBudget').value = b ?? '';
    const ratio = b ? today / b : 0;
    $('spMeter').style.width = `${Math.min(100, Math.round(ratio * 100))}%`;
    $('spMeter').className = ratio >= 1 ? 'bad' : ratio >= 0.8 ? 'warn' : '';
    $('spToday').parentElement.classList.toggle('over', !!b && ratio >= 1);
    $('spMachines').innerHTML = spend.machines.map(m => {
        const ms = Date.now() - (m.since || Date.now());
        const cost = m.ratePerHr != null && m.since ? m.ratePerHr * ms / 3600000 : m.costSoFar;
        return `<li><span class="dot"></span><b>${m.provider === 'thunder' ? 'Thunder' : 'RunPod'}</b>
            <span>${esc(m.gpu || '')}</span><span class="muted">${esc(m.name || m.id)}</span>
            <span class="${ms > 3 * 3600000 ? 'long' : ''}">on for ${dur(ms)}</span>
            <span class="cost">${money(cost)} so far</span><span class="muted">${money(m.ratePerHr)}/h</span></li>`;
    }).join('');
    const notes = [];
    if (spend.errors?.length) notes.push(spend.errors.join(' · '));
    if (b && ratio >= 1) notes.push(`Today is over the ${money(b)} budget.`);
    else if (b && spend.projectedToday > b && spend.ratePerHr >= 0.05) notes.push(`Left running, today reaches ${money(spend.projectedToday)} — over the ${money(b)} budget.`);
    if (spend.machines.some(m => Date.now() - (m.since || Date.now()) > 3 * 3600000)) notes.push('A machine has been on for more than 3 hours: delete or stop it if the class is over.');
    notes.push('RunPod figures come from its balance; Thunder ones are computed from each instance\'s price and running time (its API has no balance).');
    $('spNote').textContent = notes.join(' ');
}
let tBalEditing = false;
$('spTBalEdit').onclick = () => {
    tBalEditing = true;
    $('spTBalForm').hidden = false; $('spTBalEdit').hidden = true;
    $('spTBalIn').value = spend?.thunder?.balance != null ? spend.thunder.balance.toFixed(2) : '';
    $('spTBalIn').focus(); $('spTBalIn').select();
};
$('spTBalBtn').onclick = async () => {
    if ($('spTBalIn').value === '') return toast('Type the balance Thunder\'s billing page shows', true);
    try {
        await api('PUT', '/api/spend/thunder-balance', { amount: $('spTBalIn').value });
        tBalEditing = false; $('spTBalIn').value = '';
        toast('Thunder balance saved'); loadSpend();
    } catch (e) { toast(e.message, true); }
};
$('spTBalIn').onkeydown = (e) => { if (e.key === 'Enter') $('spTBalBtn').click(); if (e.key === 'Escape') { tBalEditing = false; renderSpend(); } };
// What a balance covers at a given hourly cost, for the launch confirmations.
function coverage(balance, perHr, name) {
    if (balance == null) return `\n\n${name} balance unknown${name === 'Thunder' ? ' — type it in the spending bar to have it checked' : ''}.`;
    const h = perHr > 0 ? balance / perHr : Infinity;
    return `\n\n${name} balance ≈ $${balance.toFixed(2)}: covers about ${h === Infinity ? 'any time' : `${h.toFixed(1)} hours`} at this price.${h < 4 ? ' ⚠ Less than 4 hours — top it up before a class.' : ''}`;
}
$('spBudget').onchange = async () => {
    try { await api('PUT', '/api/spend/budget', { dailyBudget: $('spBudget').value }); toast('Daily budget saved'); loadSpend(); }
    catch (e) { toast(e.message, true); }
};
loadSpend();
setInterval(() => { if (!document.hidden) loadSpend(); }, 15000);
setInterval(() => { if (!document.hidden) renderSpend(); }, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadSpend(); });

// ---- updates (desktop app only) ------------------------------------------------------
//
// The app's updater tells this page what it is doing (console-app/main.js): found,
// downloading with progress, ready, or failed. Shown in a bar at the top, and in
// Settings → About & updates. In a browser there is no updater: the bar stays hidden.

const UPD = window.comfyqConsole?.updates || null;
let updLaterFor = null;            // the version "Later" was pressed for
let updDoneTimer = null;
const mbs = (b) => `${(Number(b || 0) / 1e6).toFixed(1)} MB`;
const secs = (s) => s < 60 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`;

function renderUpdate(u) {
    if (!u) return;
    const bar = $('updBar');
    const show = (ids) => { for (const id of ['updNotesBtn', 'updRetry', 'updLater', 'updInstall', 'updClose']) $(id).hidden = !ids.includes(id); };
    clearTimeout(updDoneTimer);
    bar.className = 'updbar';
    $('updProgress').hidden = true;
    let visible = true;
    if (u.state === 'downloading') {
        bar.classList.add('busy');
        const pct = Math.round(u.percent || 0);
        const left = u.bytesPerSecond > 0 && u.total ? (u.total - u.transferred) / u.bytesPerSecond : null;
        $('updTitle').textContent = `Downloading version ${u.version} — ${pct}%`;
        $('updSub').textContent = `${mbs(u.transferred)} of ${mbs(u.total)}${u.bytesPerSecond ? ` · ${mbs(u.bytesPerSecond)}/s` : ''}${left != null ? ` · about ${secs(left)} left` : ''} · you are on ${u.current}`;
        $('updProgress').hidden = false;
        $('updProgress').firstElementChild.style.width = `${pct}%`;
        show(u.notes ? ['updNotesBtn'] : []);
    } else if (u.state === 'downloaded' || u.state === 'installing') {
        bar.classList.add('ready');
        $('updTitle').textContent = u.state === 'installing' ? `Installing version ${u.version}…` : `Version ${u.version} is ready to install`;
        $('updSub').textContent = u.state === 'installing' ? 'The app closes, installs and opens again.' : `You are on ${u.current}. Install now (the app restarts in a few seconds; machines keep running), or later: it installs when you quit.`;
        show(u.state === 'installing' ? [] : [...(u.notes ? ['updNotesBtn'] : []), 'updLater', 'updInstall']);
        visible = updLaterFor !== u.version || u.state === 'installing';
    } else if (u.state === 'checking') {
        bar.classList.add('busy');
        $('updTitle').textContent = 'Checking for updates…';
        $('updSub').textContent = `You are on ${u.current}.`;
        show([]);
        visible = !!u.manual;
    } else if (u.state === 'uptodate') {
        $('updTitle').textContent = `You have the latest version (${u.current})`;
        $('updSub').textContent = `Checked ${new Date(u.lastCheck || Date.now()).toLocaleTimeString()}.`;
        show(['updClose']);
        visible = !!u.manual;
        if (visible) updDoneTimer = setTimeout(() => { $('updBar').hidden = true; }, 6000);
    } else if (u.state === 'error') {
        bar.classList.add('bad');
        $('updTitle').textContent = 'The update did not work';
        $('updSub').textContent = `${u.error || 'unknown error'} — details in ~/.comfyq/console-app.log`;
        show(['updRetry', 'updClose']);
    } else visible = false;
    $('updNotes').textContent = u.notes || '';
    if (!u.notes) $('updNotes').hidden = true;
    bar.hidden = !visible;
    renderAbout(u);
}

function renderAbout(u) {
    $('aboutActions').hidden = !u.available;
    const state = {
        idle: 'not checked yet', checking: 'checking…', uptodate: 'up to date',
        downloading: `downloading version ${u.version} (${Math.round(u.percent || 0)}%)`,
        downloaded: `version ${u.version} downloaded: installs when you quit`, installing: `installing version ${u.version}`,
        error: `failed: ${u.error || ''}`,
    }[u.state] || u.state;
    $('aboutBody').innerHTML = `<dl class="aboutgrid">
        <dt>This version</dt><dd>${esc(u.current)}</dd>
        <dt>Updates</dt><dd>${u.available ? esc(state) : 'not in a copy run from the repo (git pull instead)'}</dd>
        ${u.lastCheck ? `<dt>Last check</dt><dd>${esc(new Date(u.lastCheck).toLocaleString())}</dd>` : ''}
        <dt>How</dt><dd>Checked at start, every 30 minutes and when the window opens; downloaded in the background.</dd>
      </dl>`;
    $('aboutCheck').disabled = ['checking', 'downloading', 'installing'].includes(u.state);
}

if (UPD) {
    $('updNotesBtn').onclick = () => { $('updNotes').hidden = !$('updNotes').hidden; };
    $('updInstall').onclick = () => { $('updInstall').disabled = true; UPD.install(); };
    $('updLater').onclick = async () => { const u = await UPD.get(); updLaterFor = u.version; $('updBar').hidden = true; toast(`Version ${u.version} installs when you quit the app`); };
    $('updRetry').onclick = () => UPD.check();
    $('updClose').onclick = () => { $('updBar').hidden = true; };
    $('aboutCheck').onclick = () => UPD.check();
    UPD.onStatus(renderUpdate);
    UPD.get().then((u) => {
        renderUpdate(u);
        // The first start after an update says so, once.
        let before = null;
        try { before = localStorage.getItem('rpc.appVersion'); localStorage.setItem('rpc.appVersion', u.current); } catch { /* private storage */ }
        if (before && before !== u.current) {
            $('updBar').className = 'updbar ready';
            $('updTitle').textContent = `Updated to version ${u.current}`;
            $('updSub').innerHTML = `From ${esc(before)}. <a href="https://github.com/urbandronedesign/comfyQ_docker/releases/tag/console-v${encodeURIComponent(u.current)}" target="_blank" rel="noreferrer">What changed ↗</a>`;
            for (const id of ['updNotesBtn', 'updRetry', 'updLater', 'updInstall']) $(id).hidden = true;
            $('updClose').hidden = false;
            $('updBar').hidden = false;
        }
    });
}

// ---- boot -----------------------------------------------------------------------

(async () => {
    try { await loadSettings(); } catch (e) { toast(e.message, true); return; }
    // #runpod / #thunder in the address opens that page (bookmarks, links).
    const saved = ['#runpod', '#thunder'].includes(location.hash) ? location.hash.slice(1) : store('rpc.page');
    showPage(saved || (settings.runpodApiKey.set || !settings.thunderApiKey.set ? 'runpod' : 'thunder'));
    // First run: nothing works without a key, so start with the keys.
    if (!settings.runpodApiKey.set && !settings.thunderApiKey.set) openDrawer('settings');
})();


// ---- workshop bookings ----------------------------------------------------------
// The server hunts (tools/runpod/booking.mjs); this page books, shows and stops.
let bWorkflows = null, bChosen = [], bGpuCache = {};
const localInput = (t) => { const d = new Date(t - new Date(t).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
const fromLocal = (v) => v ? new Date(v).toISOString() : null;

let bVolumes = null;
async function loadBookingForm() {
    if (!bWorkflows) {
        try { bWorkflows = (await api('GET', '/api/workflows')).workflows; } catch (e) { toast(e.message, true); bWorkflows = []; }
    }
    if (!bVolumes) {
        try { bVolumes = (await api('GET', '/api/volumes')).volumes || []; } catch { bVolumes = []; }
        $('bVolume').innerHTML = '<option value="none">None: each machine downloads its own models</option>'
            + bVolumes.map(v => `<option value="${esc(v.id)}">${esc(v.name)} · ${esc(v.dataCenterId)} · ${v.size} GB</option>`).join('');
        // The usual choice when there is one: every machine shares the models.
        if (bVolumes.length === 1) $('bVolume').value = bVolumes[0].id;
        bookingVolumeChanged();
    }
    if (!$('bStart').value) $('bStart').value = localInput(Date.now());
    renderBookingWorkflows();
    bookingCards();
}

function renderBookingWorkflows() {
    const q = $('bWfSearch').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = (bWorkflows || []).filter(w => q.every(t => `${w.name} ${w.id} ${w.category}`.toLowerCase().includes(t)));
    $('bWfList').innerHTML = rows.map(w => `
        <label class="wf">
          <input type="checkbox" data-bwf="${esc(w.id)}" ${bChosen.includes(w.id) ? 'checked' : ''} ${w.cannotFetch ? 'disabled' : ''}>
          <div>
            <div class="name">${esc(w.name)}${w.experimental ? '<span class="badge exp">experimental</span>' : ''}${w.cannotFetch ? '<span class="badge">cannot download its models</span>' : ''}</div>
            <div class="desc">${esc(w.id)} · ${w.downloadGb != null ? `${w.downloadGb} GB of models` : 'size unknown'}</div>
          </div>
          <div class="vram">${w.vramGb ? `${w.vramGb} GB` : '?'}<div class="muted small">VRAM</div></div>
        </label>`).join('') || '<p class="muted" style="padding:12px">No workflow matches.</p>';
    for (const cb of $('bWfList').querySelectorAll('input[data-bwf]')) cb.onchange = () => {
        bChosen = cb.checked ? [...bChosen, cb.dataset.bwf] : bChosen.filter(x => x !== cb.dataset.bwf);
        renderBookingWorkflows(); bookingCards();
    };
    $('bWfChosen').innerHTML = bChosen.map((id, i) => `<span class="chip">${i === 0 ? '<b>main</b> ' : ''}${esc(id)} <button data-brm="${esc(id)}" title="Remove">×</button></span>`).join('')
        || '<span class="muted small">None ticked: each machine starts in admin mode, and you pick its workflow in its admin panel.</span>';
    for (const b of $('bWfChosen').querySelectorAll('[data-brm]')) b.onclick = () => { bChosen = bChosen.filter(x => x !== b.dataset.brm); renderBookingWorkflows(); bookingCards(); };
}
$('bWfSearch').oninput = renderBookingWorkflows;

// A network volume exists only on Secure Cloud, and pins its machines to its data centre.
function bookingVolumeChanged() {
    const v = (bVolumes || []).find(x => x.id === $('bVolume').value);
    $('bCloud').disabled = !!v;
    if (v) $('bCloud').value = 'secure';
    $('bVolumeNote').hidden = !v;
    if (v) $('bVolumeNote').innerHTML = `Every machine mounts <b>${esc(v.name)}</b>: the models are downloaded once and shared by all of them (and kept for the next booking). A network volume is on <b>Secure Cloud</b> only, and every machine has to be in its data centre, <b>${esc(v.dataCenterId)}</b>.`;
    bookingCards();
}
$('bVolume').onchange = bookingVolumeChanged;

// Which cards qualify right now, and what the day costs at most.
async function bookingCards() {
    const vol = (bVolumes || []).find(x => x.id === $('bVolume').value) || null;
    const cloud = vol ? 'secure' : $('bCloud').value;
    const minVram = Number($('bVram').value), cap = Number($('bPrice').value), count = Number($('bCount').value) || 1;
    const need = (bWorkflows || []).filter(w => bChosen.includes(w.id)).reduce((a, w) => a + (Number(w.vramGb) || 0), 0);
    const clouds = cloud === 'secure' ? ['0'] : cloud === 'community-secure' ? ['1', '0'] : ['1'];
    const lines = [];
    for (const c of clouds) {
        const key = `${c}|${vol?.dataCenterId || ''}|${bChosen.join(',')}`;
        try {
            if (!bGpuCache[key] || Date.now() - bGpuCache[key].at > 120000) bGpuCache[key] = { at: Date.now(), data: await api('GET', `/api/gpus?community=${c}${vol ? `&dataCenterId=${encodeURIComponent(vol.dataCenterId)}` : ''}&workflows=${encodeURIComponent(bChosen.join(','))}`) };
            const ok = bGpuCache[key].data.rows.filter(r => r.launchable !== false && r.pricePerHr != null && r.vramGb >= Math.max(minVram, need) && r.pricePerHr <= cap)
                .sort((a, b) => a.pricePerHr - b.pricePerHr);
            lines.push(`${c === '1' ? 'Community' : `Secure${vol ? ` in ${esc(vol.dataCenterId)}` : ''}`}: ${ok.length ? ok.slice(0, 8).map(r => `${esc(r.name)} ${r.vramGb} GB $${r.pricePerHr.toFixed(2)}${r.stock ? ` (stock ${esc(r.stock)})` : ''}`).join(' · ') : '<b>no card meets this size and price</b>'}`);
        } catch (e) { lines.push(`${c === '1' ? 'Community' : 'Secure'}: ${esc(e.message)}`); }
    }
    $('bCards').innerHTML = `Cards that qualify${need > minVram ? ` (the workflows need about ${need} GB, more than the size set)` : ''}: ${lines.join('<br>')}<br>Whether one is free is only known by asking: RunPod's stock figures leave out the CUDA 12.8 driver ComfyQ needs.`;
    const end = fromLocal($('bEnd').value), start = fromLocal($('bStart').value) || new Date().toISOString();
    const hours = end ? Math.max(0, (Date.parse(end) - Date.parse(start)) / 3600000) : null;
    $('bSummary').textContent = `At most ${count} × $${cap.toFixed(2)}/h = $${(count * cap).toFixed(2)}/h`
        + (hours ? `, about $${(count * cap * hours).toFixed(2)} for the ${hours.toFixed(1)} h until the shut-down` : ' — no shut-down time: they run until you terminate them');
}
for (const id of ['bCloud', 'bVram', 'bPrice', 'bCount', 'bStart', 'bEnd']) $(id).onchange = bookingCards;

$('bBook').onclick = async () => {
    const body = {
        name: $('bName').value, count: Number($('bCount').value), minVramGb: Number($('bVram').value), maxPricePerHr: Number($('bPrice').value),
        cloud: $('bCloud').value, volumeId: $('bVolume').value, serve: bChosen, startAt: fromLocal($('bStart').value), readyBy: fromLocal($('bReady').value),
        endAt: fromLocal($('bEnd').value), keepHunting: $('bKeep').checked,
    };
    const end = body.endAt ? new Date(body.endAt).toLocaleString() : 'until you terminate them';
    if (!confirm(`Book ${body.count} machine(s), at least ${body.minVramGb} GB, at most $${body.maxPricePerHr.toFixed(2)}/h each?\n\nHunting starts ${new Date(body.startAt || Date.now()).toLocaleString()}. Each machine found BILLS from then on, ${end}.${bChosen.length ? `\nThey serve: ${bChosen.join(', ')}.` : '\nThey start in admin mode.'}`)) return;
    try { await api('POST', '/api/bookings', body); toast('Booked: hunting runs while this app runs'); closeDrawers(); loadBookings(); }
    catch (e) { toast(e.message, true); }
};

async function loadBookings() {
    let list;
    try { ({ bookings: list } = await api('GET', '/api/bookings')); } catch (e) { $('bookingList').innerHTML = `<p class="muted pad small">${esc(e.message)}</p>`; return; }
    if (!list.length) { $('bookingList').innerHTML = '<p class="muted pad small">No booking yet.</p>'; return; }
    const when = (t) => t ? new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
    $('bookingList').innerHTML = list.map(b => {
        const active = !['stopped', 'ended'].includes(b.state);
        const last = (b.events || []).slice(-1)[0];
        return `<div class="booking ${active ? '' : 'muted'}">
          <div class="row wrap">
            <b>${esc(b.status)}</b>
            <span class="muted small">≥ ${b.minVramGb} GB · ≤ $${b.maxPricePerHr.toFixed(2)}/h · ${b.volumeId ? `Secure, shared storage ${esc(b.volumeId)}` : esc(b.cloud)} · ${b.serve.length ? esc(b.serve.join(', ')) : 'admin mode'}</span>
            <span class="muted small">from ${when(b.startAt)}${b.readyBy ? ` · ready by ${when(b.readyBy)}` : ''}${b.endAt ? ` · shut down ${when(b.endAt)}` : ''}${b.lastTry ? ` · last try ${new Date(b.lastTry).toLocaleTimeString()}` : ''}</span>
            <span style="flex:1"></span>
            ${active ? `<button class="secondary small" data-bstop="${esc(b.id)}" title="Stop hunting; the machines found keep running">Stop hunting</button>` : ''}
            ${b.live.length ? `<button class="danger small" data-bend="${esc(b.id)}" title="Save the results, then terminate its machines">Shut down now…</button>` : ''}
            ${!active ? `<button class="ghost small" data-bdel="${esc(b.id)}">Remove</button>` : ''}
          </div>
          ${b.blocked ? `<div class="note bad small">${esc(b.blocked)}</div>` : ''}
          ${b.live.map(p => `<div class="small">• ${esc(p.gpu || p.id)}${p.costPerHr != null ? ` $${Number(p.costPerHr).toFixed(2)}/h` : ''} — ${(p.links?.byWorkflow || []).map(l => `<a href="${esc(l.url)}" target="_blank" rel="noreferrer">${esc(l.id)} ↗</a>`).join(' ')} <a href="${esc(p.links?.admin || '')}" target="_blank" rel="noreferrer">admin ↗</a></div>`).join('')}
          ${last ? `<div class="muted small">${new Date(last.at).toLocaleTimeString()} — ${esc(last.title)}${last.body ? `: ${esc(last.body)}` : ''}</div>` : ''}
        </div>`;
    }).join('');
    for (const x of $('bookingList').querySelectorAll('[data-bstop]')) x.onclick = async () => {
        try { await api('POST', `/api/bookings/${x.dataset.bstop}/stop`); toast('Hunting stopped: the machines found keep running'); loadBookings(); } catch (e) { toast(e.message, true); }
    };
    for (const x of $('bookingList').querySelectorAll('[data-bend]')) x.onclick = async () => {
        const id = x.dataset.bend;
        const typed = await askCode({ title: 'Shut this booking down now?', text: `Every result of its machines is saved to Desktop\ComfyQ results, then they are terminated (billing stops). Type ${id} to confirm.`, code: id, button: 'Shut down' });
        if (typed == null) return;
        try { await api('POST', `/api/bookings/${id}/end`, { confirm: typed.trim() }); toast('Shutting down: results first, then terminate'); loadBookings(); loadPods(); } catch (e) { toast(e.message, true); }
    };
    for (const x of $('bookingList').querySelectorAll('[data-bdel]')) x.onclick = async () => {
        try { await api('DELETE', `/api/bookings/${x.dataset.bdel}`); loadBookings(); } catch (e) { toast(e.message, true); }
    };
}
setInterval(() => { if (pageOpen('runpod') && !document.hidden) loadBookings(); }, 20000);
