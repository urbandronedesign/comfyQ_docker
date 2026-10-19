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
    const b = $('launchBtn');
    b.disabled = true;
    b.textContent = plans.length > 1 ? `Launching ${plans.length} Pods…` : 'Launching…';
    try {
        const r = await api('POST', '/api/launch', {
            volumeId: vol.id,
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
            showTab('pods');
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
    if (!selectedPod && pods.length) selectedPod = (pods.find(p => p.comfyq) || pods[0]).id;
    renderPodList();
    loadDetail();
    loadBuilds();
    clearInterval(listTimer);
    listTimer = setInterval(() => { if (!$('tab-pods').hidden && !document.hidden) loadPods(); }, 30000);
}

// Pods grouped by network volume: Pods on one volume share its models, so
// they are watched, priced and stopped together.
let groups = [];
const builds = {};       // volume id -> { key, builds, distinct } once read

const shortSha = (sha) => String(sha).slice(0, 7);

function podRow(p) {
    const running = p.desiredStatus === 'RUNNING';
    return `<div class="pod ${p.id === selectedPod ? 'sel' : ''}" data-pod="${esc(p.id)}">
          <div><span class="dot ${running ? 'run' : 'stop'}"></span><b>${esc(p.name)}</b>
            ${running ? `<a class="small podlink" href="${esc(p.links.students)}" target="_blank" rel="noreferrer" title="This Pod's student page">students ↗</a>` : ''}</div>
          <div class="muted small">${esc(p.id)} · ${esc(p.gpu?.name || 'no GPU')} · ${esc(String(p.desiredStatus || '').toLowerCase())}${p.costPerHr ? ` · $${Number(p.costPerHr).toFixed(2)}/h` : ''}</div>
          ${p.serve?.length ? `<div class="muted small">${esc(p.serve.join(', '))}</div>` : ''}
        </div>`;
}

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
    $('podList').innerHTML = groups.map(g => {
        const members = g.pods.map(id => pods.find(p => p.id === id)).filter(Boolean);
        const vname = g.volume ? esc(g.volume.name) : 'No network volume';
        return `<div class="vgroup">
          <div class="vhead">
            <div><b>${vname}</b>${g.volume?.dataCenterId ? ` <span class="muted small">${esc(g.volume.dataCenterId)}</span>` : ''}</div>
            <div class="muted small">${g.running ? `${g.running} running · <b>$${g.costPerHr.toFixed(2)}/h</b>${g.running > 1 ? ' together' : ''}` : 'nothing running'}</div>
            ${g.volume ? `<button class="ghost small" data-folders="${esc(g.volume.id)}" ${g.running ? '' : 'disabled title="Start a Pod on this volume to look inside it"'}>Folders…</button>` : ''}
            ${g.running > 1 ? `<button class="ghost small" data-stopall="${esc(g.volume?.id || '')}">Stop all ${g.running}</button>` : ''}
          </div>
          ${buildLine(g)}
          ${members.map(podRow).join('')}
        </div>`;
    }).join('') || '<p class="muted">No Pods. Launch one from the Launch tab.</p>';
    for (const el of $('podList').querySelectorAll('[data-pod]')) {
        el.onclick = (ev) => {
            if (ev.target.closest('a')) return;
            selectedPod = el.dataset.pod; store('rpc.pod', selectedPod); folderView = null; renderPodList(); loadDetail();
        };
    }
    for (const b of $('podList').querySelectorAll('[data-folders]')) {
        b.onclick = () => { folderView = b.dataset.folders; loadFolders(); };
    }
    for (const b of $('podList').querySelectorAll('[data-stopall]')) {
        b.onclick = async () => {
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
        const typed = prompt(pod.networkVolume
            ? `Terminate deletes the Pod (the network volume and its models stay).\n\nType the Pod id to confirm:\n${pod.id}`
            : `This Pod has NO network volume: terminating it deletes its models AND every result students made on it. Download its results first (Download results, while it runs).\n\nType the Pod id to confirm:\n${pod.id}`);
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
    detailTimer = setTimeout(() => { if (!$('tab-pods').hidden && !document.hidden) loadDetail(); else detailTimer = setTimeout(loadDetail, 5000); }, busy ? 5000 : 20000);
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
            const typed = prompt(`Delete the folder ${f.id} from the volume?\n\n${size(f.bytes)}, ${f.outputs} result file(s) and the job queue of a Pod that no longer exists. `
                + `This cannot be undone${f.outputs ? ' — download the results first if anyone needs them' : ''}.\n\nType the folder name to confirm:\n${f.id}`);
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
