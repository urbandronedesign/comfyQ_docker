// ComfyQ RunPod console — page logic. Talks only to the local server.mjs.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gb = (b) => (Number(b || 0) / 1024 ** 3).toFixed(1);

async function api(method, route, body) {
    const res = await fetch(route, {
        method,
        headers: { 'X-ComfyQ-Console': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
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

function showTab(name) {
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== `tab-${name}`;
    store('rpc.tab', name);
    if (name === 'launch') loadLaunch();
    if (name === 'pods') loadPods();
}
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => showTab(b.dataset.tab);

// ---- credentials ----------------------------------------------------------------

let settings = null;
const SECRETS = ['runpodApiKey', 'adminPassword', 'accessPassword', 'hfToken'];

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
    $('settingsFile').textContent = settings.file;
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
        settings = await api('PUT', '/api/settings', body);
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

// ---- launch ---------------------------------------------------------------------

let workflows = [];
let volumes = [];
let chosen = [];          // workflow ids, in order: first = main lane
let gpuPick = null;       // primary GPU id
let gpuFallback = new Set();
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
    if (!volumes.length) {
        sel.innerHTML = '<option value="">No network volume yet — create one</option>';
        $('newVolume').hidden = false;
        return;
    }
    sel.innerHTML = volumes.map(v => `<option value="${esc(v.id)}">${esc(v.name)} — ${esc(v.size)} GB in ${esc(v.dataCenterId)}</option>`).join('');
    if (settings?.volumeId && volumes.some(v => v.id === settings.volumeId)) sel.value = settings.volumeId;
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
$('volume').onchange = loadGpus;
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

const selectedVolume = () => volumes.find(v => v.id === $('volume').value) || null;

let gpuReq = 0;
async function loadGpus() {
    const my = ++gpuReq;
    const vol = selectedVolume();
    const qs = new URLSearchParams({ workflows: chosen.join(','), community: $('community').checked ? '1' : '0' });
    if (vol) qs.set('dataCenterId', vol.dataCenterId);
    $('gpuRows').innerHTML = '<tr><td colspan="6" class="muted">Loading prices…</td></tr>';
    try {
        const d = await api('GET', `/api/gpus?${qs}`);
        if (my !== gpuReq) return;
        gpuData = d;
        // Keep a pick that still fits; otherwise take the recommendation.
        const still = d.rows.find(g => g.id === gpuPick);
        if (!still || still.fits === false) gpuPick = d.recommended;
        for (const id of [...gpuFallback]) if (!d.rows.find(g => g.id === id && g.fits !== false)) gpuFallback.delete(id);
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
    if (vol && !d.scopedToDataCenter) notes.push(`Stock is RunPod-wide, not for ${esc(vol.dataCenterId)}: RunPod would not answer for one data centre. A GPU shown in stock may be missing there.`);
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
          <td class="stock-${esc(g.stock)}">${esc(g.stock || '—')}</td>
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
            renderGpus();
        };
    }
    for (const cb of $('gpuRows').querySelectorAll('[data-fb]')) {
        cb.onchange = () => { cb.checked ? gpuFallback.add(cb.dataset.fb) : gpuFallback.delete(cb.dataset.fb); updateSummary(); };
    }
    updateSummary();
}

function updateSummary() {
    const g = gpuData?.rows.find(x => x.id === gpuPick);
    const vol = selectedVolume();
    const parts = [];
    if (g) parts.push(`${g.name}${g.pricePerHr != null ? ` at about $${Number(g.pricePerHr).toFixed(2)}/hour` : ''}`);
    if (gpuFallback.size) parts.push(`or ${gpuFallback.size} fallback(s)`);
    if (vol) parts.push(`in ${vol.dataCenterId}`);
    parts.push(chosen.length ? `serving ${chosen.length} workflow(s)` : 'in admin mode');
    $('launchSummary').textContent = parts.join(', ');
    $('launchBtn').disabled = !gpuPick || !vol;
}

$('launchBtn').onclick = async () => {
    const vol = selectedVolume();
    if (!vol || !gpuPick) return;
    const missing = [];
    if (!settings.adminPassword.set) missing.push('admin password');
    if (!settings.accessPassword.set) missing.push('student access password');
    let allowOpen = false;
    if (chosen.length && missing.length) {
        allowOpen = confirm(`No ${missing.join(' or ')} is saved. Anyone with the Pod's URL could use it${!settings.adminPassword.set ? ' and its admin panel' : ''}.\n\nLaunch it open anyway?`);
        if (!allowOpen) { showTab('creds'); return; }
    }
    const b = $('launchBtn');
    b.disabled = true;
    b.textContent = 'Launching…';
    try {
        const { pod } = await api('POST', '/api/launch', {
            volumeId: vol.id,
            gpuTypeIds: [gpuPick, ...gpuFallback],
            serve: chosen,
            name: $('podName').value.trim() || undefined,
            diskGb: Number($('diskGb').value) || 30,
            community: $('community').checked,
            fetchModels: $('fetchModels').checked,
            syncWorkflows: $('syncWorkflows').checked,
            allowOpen,
        });
        toast(`Pod ${pod.id} created — now billing`);
        selectedPod = pod.id;
        showTab('pods');
    } catch (e) {
        toast(e.message, true);
    } finally {
        b.textContent = 'Launch Pod';
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
        pods = (await api('GET', '/api/pods')).pods;
    } catch (e) {
        $('podList').innerHTML = `<p class="muted">${esc(e.message)}</p>`;
        return;
    }
    $('podCount').textContent = pods.filter(p => p.desiredStatus === 'RUNNING').length || '';
    if (selectedPod && !pods.some(p => p.id === selectedPod)) selectedPod = null;
    if (!selectedPod && pods.length) selectedPod = (pods.find(p => p.comfyq) || pods[0]).id;
    renderPodList();
    loadDetail();
    clearInterval(listTimer);
    listTimer = setInterval(() => { if (!$('tab-pods').hidden && !document.hidden) loadPods(); }, 30000);
}

function renderPodList() {
    $('podList').innerHTML = pods.map(p => `
        <div class="pod ${p.id === selectedPod ? 'sel' : ''}" data-pod="${esc(p.id)}">
          <div><span class="dot ${p.desiredStatus === 'RUNNING' ? 'run' : 'stop'}"></span><b>${esc(p.name)}</b></div>
          <div class="muted small">${esc(p.id)} · ${esc(p.gpu?.name || 'no GPU')} · ${esc(String(p.desiredStatus || '').toLowerCase())}${p.costPerHr ? ` · $${Number(p.costPerHr).toFixed(2)}/h` : ''}</div>
        </div>`).join('') || '<p class="muted">No Pods. Launch one from the Launch tab.</p>';
    for (const el of $('podList').querySelectorAll('[data-pod]')) {
        el.onclick = () => { selectedPod = el.dataset.pod; store('rpc.pod', selectedPod); renderPodList(); loadDetail(); };
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
    const box = $('podDetail');
    if (!selectedPod) { box.innerHTML = '<p class="muted">Pick a Pod.</p>'; return; }
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
        return `<div class="file"><div>${esc(f.name)} <span class="muted small">— ${esc(f.status)}${f.total ? ` · ${gb(f.received)} / ${gb(f.total)} GB` : ''}</span></div>
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
      </div>` : ''}
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

    if ($('stopPod')) $('stopPod').onclick = () => podAction('stop');
    if ($('startPod')) $('startPod').onclick = () => podAction('start');
    $('termPod').onclick = async () => {
        const typed = prompt(`Terminate deletes the Pod (the network volume and its models stay).\n\nType the Pod id to confirm:\n${pod.id}`);
        if (typed === null) return;
        try { await api('DELETE', `/api/pods/${pod.id}`, { confirm: typed.trim() }); toast('Pod terminated'); selectedPod = null; loadPods(); }
        catch (e) { toast(e.message, true); }
    };
    if ($('copyStudents')) $('copyStudents').onclick = () => {
        navigator.clipboard.writeText(pod.links.students).then(() => toast('Student link copied'), () => toast(pod.links.students));
    };

    // Poll fast while something is happening, slowly once it is settled.
    const busy = ['booting', 'fetching', 'starting'].includes(st.key);
    detailTimer = setTimeout(() => { if (!$('tab-pods').hidden && !document.hidden) loadDetail(); else detailTimer = setTimeout(loadDetail, 5000); }, busy ? 5000 : 20000);
}

async function podAction(verb) {
    try { await api('POST', `/api/pods/${selectedPod}/${verb}`); toast(verb === 'stop' ? 'Stopping — GPU billing ends once it has stopped' : 'Starting'); setTimeout(loadPods, 1500); }
    catch (e) { toast(e.message, true); }
}
$('refreshPods').onclick = loadPods;

// ---- boot -----------------------------------------------------------------------

(async () => {
    try { await loadSettings(); } catch (e) { toast(e.message, true); return; }
    const first = !settings.runpodApiKey.set ? 'creds' : (store('rpc.tab') || 'launch');
    showTab(first);
})();
