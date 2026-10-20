import React, { useEffect, useState, useMemo, useRef } from 'react';
import { Save, X, Eye, EyeOff, AlertTriangle, RefreshCw, CheckCircle2, Filter, ArrowUp, ArrowDown, Search, ExternalLink, Download, Monitor, FlaskConical } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { SERVER_URL } from '../../utils/api';
import DynamicParamFields, { isSeedParam, randomSeed } from '../DynamicParamFields';
import { useComfyOpener } from '../../hooks/useComfyOpener';

const CATEGORIES = [
    { value: 't2i', label: 'Text to Image' },
    { value: 'image-edit', label: 'Image Editing' },
    { value: 'i2v', label: 'Image to Video' },
    { value: 'video-edit', label: 'Video Editing' },
    { value: 'i2i', label: 'Image to Image' },
    { value: 'audio', label: 'Audio Generation' },
    { value: '3d', label: '3D Generation' },
    { value: 'preprocessor', label: 'Preprocessor' },
    { value: 'description', label: 'Description (image/video → text)' },
    { value: 'other', label: 'Other' }
];

const PARAM_TYPES = ['text', 'textarea', 'number', 'select', 'checkbox', 'image', 'video', 'audio', 'mask', 'model3d', 'lora', 'camera'];

// Field names that are usually infrastructure, not student-facing.
const INFRASTRUCTURE_FIELDS = new Set([
    'unet_name', 'vae_name', 'clip_name', 'clip_name1', 'clip_name2',
    'weight_dtype', 'device', 'type', 'upscale_method', 'resolution_steps',
    'megapixels', 'batch_size'
]);

const isInfrastructureParam = (p) => INFRASTRUCTURE_FIELDS.has(p.field);

const WorkflowMetaEditor = ({ workflowId, adminPassword, onClose, onSaved }) => {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [meta, setMeta] = useState(null);
    const [params, setParams] = useState([]);
    const [apiWorkflow, setApiWorkflow] = useState(null);
    // Original UI-format export (subgraphs/groups/notes), when the bundle ships one.
    // Preferred over apiWorkflow for "Open in ComfyUI" — it loads as a fully
    // editable graph rather than the flat API graph.
    const [templateWorkflow, setTemplateWorkflow] = useState(null);
    const [filter, setFilter] = useState('all'); // all | enabled | disabled
    const [paramQuery, setParamQuery] = useState('');
    const [comfyMsg, setComfyMsg] = useState('');
    const [showPreview, setShowPreview] = useState(false);

    const headers = useMemo(() => {
        const h = { 'Content-Type': 'application/json' };
        if (adminPassword) h['X-Admin-Password'] = adminPassword;
        return h;
    }, [adminPassword]);

    // Shared "Open in ComfyUI" flow (stage template → Workflows sidebar; drag
    // fallback). notify pipes progress/result into the inline toolbar message.
    const { openingId, openInComfy } = useComfyOpener({ adminPassword, notify: (msg) => setComfyMsg(msg) });
    const comfyBusy = openingId === workflowId;

    useEffect(() => {
        if (!workflowId) return;
        let cancelled = false;
        (async () => {
            setLoading(true); setError(null);
            try {
                const res = await fetch(`${SERVER_URL}/admin/workflows/${workflowId}/edit-data`, { headers });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to load workflow');
                if (cancelled) return;
                setMeta(data.meta);
                setParams(data.detectedParameters);
                setApiWorkflow(data.apiWorkflow || null);
                setTemplateWorkflow(data.templateWorkflow || null);
            } catch (e) {
                if (!cancelled) setError(e.message);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [workflowId, headers]);

    const updateMeta = (patch) => setMeta(m => ({ ...m, ...patch }));

    const updateParam = (idx, patch) => {
        setParams(prev => prev.map((p, i) => i === idx ? { ...p, ...patch } : p));
    };

    const setAllEnabled = (enabled) => {
        setParams(prev => prev.map(p => ({ ...p, enabled })));
    };

    // Reorder a parameter relative to the *visible* list. "up" / "down"
    // swap with the previous / next param in the same filtered view, but
    // we mutate the underlying `params` array directly so the persisted
    // `order` field (set at save time from the array index) matches the
    // admin's intended ordering. Disabled (hidden) items keep their
    // relative positions and are not skipped over here — that mirrors what
    // students will see when the filter is "all".
    const moveParam = (visibleIdx, direction) => {
        const current = visibleParams[visibleIdx];
        const swapWith = visibleParams[visibleIdx + (direction === 'up' ? -1 : 1)];
        if (!current || !swapWith) return;
        const a = params.indexOf(current);
        const b = params.indexOf(swapWith);
        if (a < 0 || b < 0) return;
        setParams(prev => {
            const next = prev.slice();
            [next[a], next[b]] = [next[b], next[a]];
            return next;
        });
    };

    const hideInfrastructure = () => {
        setParams(prev => prev.map(p => isInfrastructureParam(p) ? { ...p, enabled: false } : p));
    };

    const visibleParams = useMemo(() => {
        let list = params;
        if (filter === 'enabled') list = list.filter(p => p.enabled);
        else if (filter === 'disabled') list = list.filter(p => !p.enabled);
        // Keyword search over the param's display name, key, field, node id,
        // node title (the ComfyUI _meta.title), class type, and type. Multi-term
        // AND match, so "load video" or "117:54" both narrow the list.
        const terms = paramQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (terms.length) {
            list = list.filter(p => {
                const hay = [p.label, p.key, p.field, p.nodeId, p.nodeTitle, p.classType, p.type]
                    .filter(Boolean).join(' ').toLowerCase();
                return terms.every(t => hay.includes(t));
            });
        }
        return list;
    }, [params, filter, paramQuery]);

    const enabledCount = params.filter(p => p.enabled).length;

    // Download the workflow so the admin can drag it onto the ComfyUI canvas.
    // Prefer the original UI-format export (`<id>.json`) when the bundle ships one
    // — ComfyUI loads it as the full editable graph (subgraphs, groups, notes).
    // Fall back to the flat API graph (`<id>.api.json`) otherwise.
    const downloadJson = () => {
        const useTemplate = !!templateWorkflow;
        const data = useTemplate ? templateWorkflow : apiWorkflow;
        if (!data) return;
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = useTemplate ? `${workflowId}.json` : `${workflowId}.api.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    };

    const save = async () => {
        if (!meta) return;
        setSaving(true); setError(null);
        try {
            const exposedParameters = params
                .filter(p => p.enabled)
                .map((p, i) => ({
                    key: p.key,
                    nodeId: p.nodeId,
                    field: p.field,
                    type: p.type,
                    label: p.label,
                    default: coerceDefault(p),
                    options: p.options && p.options.length > 0 ? p.options : undefined,
                    // `lora`-type options are populated server-side from these
                    // (a model subdir + filename-prefix filter); preserve them
                    // through a re-save or the dropdown loses its filter.
                    optionsDir: p.type === 'lora' ? (p.optionsDir || undefined) : undefined,
                    optionsFilter: p.type === 'lora' ? (p.optionsFilter || undefined) : undefined,
                    // A `camera` param's axes + targets say how THIS graph is
                    // told a camera position. Dropping them on a re-save would
                    // leave a widget that writes nothing.
                    camera: p.type === 'camera' ? (p.camera || undefined) : undefined,
                    min: p.min,
                    max: p.max,
                    step: p.step,
                    // Only persisted when set on image/video params. Stored as
                    // an int; the schema rejects 0/negatives.
                    maxInputEdge: (p.type === 'image' || p.type === 'video' || p.type === 'mask') && p.maxInputEdge
                        ? Math.max(1, parseInt(p.maxInputEdge, 10))
                        : undefined,
                    // Preserved through edit/save (there's no UI to edit it yet, but a
                    // re-save must not drop a workflow's existing field gating).
                    disabledWhen: p.disabledWhen,
                    // Preserved like disabledWhen (no UI to edit it).
                    linkedValues: p.linkedValues,
                    // Likewise — and load-bearing: dropping `whenEmpty: unlink`
                    // does not break the job, it feeds the model a black
                    // placeholder as a reference picture and changes the result.
                    whenEmpty: p.whenEmpty,
                    whenEmptySet: p.whenEmptySet,
                    format: p.format,
                    required: p.required ?? false,
                    order: i
                }));
            const payload = {
                ...meta,
                // Sent explicitly: the server keeps the stored flag when a payload
                // omits it, so this checkbox is the only way the editor changes it.
                experimental: !!meta.experimental,
                // Rows left without a URL are dropped rather than failing the save.
                promptGuides: (meta.promptGuides || [])
                    .filter(g => g && typeof g.url === 'string' && g.url.trim())
                    .map(g => ({ label: (g.label || '').trim() || 'Prompt guide', url: g.url.trim(), ...(g.tip && g.tip.trim() ? { tip: g.tip.trim() } : {}) })),
                exposedParameters
            };
            const res = await fetch(`${SERVER_URL}/admin/workflows/${workflowId}/meta`, {
                method: 'PUT', headers, body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Save failed');
            await fetch(`${SERVER_URL}/workflows/refresh`, { method: 'POST' });
            if (onSaved) onSaved(workflowId);
            onClose();
        } catch (e) {
            setError(e.message);
        } finally {
            setSaving(false);
        }
    };

    if (!workflowId) return null;

    return (
        <Modal isOpen={!!workflowId} onClose={onClose} title={`Edit workflow: ${workflowId}`} maxWidth={showPreview ? 'max-w-7xl' : 'max-w-5xl'}>
            {loading && (
                <div className="flex items-center justify-center py-12 text-muted">
                    <RefreshCw className="w-5 h-5 animate-spin mr-2" />
                    Loading workflow…
                </div>
            )}

            {!loading && error && (
                <div className="p-4 bg-danger/10 border border-danger/30 rounded-lg flex items-center gap-2 text-danger">
                    <AlertTriangle size={16} /> {error}
                </div>
            )}

            {!loading && meta && (
                <div className="space-y-6">
                    {/* Visualize-in-ComfyUI toolbar */}
                    <div className="flex items-start justify-between gap-3 flex-wrap pb-3 border-b border-border">
                        <p className="text-[11px] text-muted max-w-md leading-snug">
                            Edit the node graph: <strong className="text-foreground font-medium">Open in ComfyUI</strong> starts
                            ComfyUI if needed and opens its editor.
                            {templateWorkflow
                                ? ' The original workflow is bundled, so it’s added to ComfyUI’s Workflows menu — open it there for a fully editable graph (subgraphs, groups, notes).'
                                : ' No original workflow is bundled, so it downloads the flat API graph — drop it on the canvas (view-only structure).'}
                        </p>
                        <div className="flex items-center gap-2 shrink-0">
                            <button onClick={downloadJson} disabled={!apiWorkflow && !templateWorkflow}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-surface border border-border hover:border-primary/40 text-muted hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                title={templateWorkflow ? 'Download the original editable workflow (.json)' : "Download this workflow's API JSON"}>
                                <Download size={14} /> {templateWorkflow ? 'Download workflow' : 'Download JSON'}
                            </button>
                            <button onClick={() => openInComfy(workflowId)} disabled={comfyBusy}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-primary/15 border border-primary/40 text-primary hover:bg-primary/25 transition-colors disabled:opacity-60 disabled:cursor-wait"
                                title="Start ComfyUI (if needed) and open its node editor in a new tab">
                                {comfyBusy ? <RefreshCw size={14} className="animate-spin" /> : <ExternalLink size={14} />}
                                {comfyBusy ? 'Starting ComfyUI…' : 'Open in ComfyUI'}
                            </button>
                        </div>
                        {comfyMsg && (
                            <p className="w-full text-[11px] text-amber-400 leading-snug">{comfyMsg}</p>
                        )}
                    </div>

                    {/* Basic info */}
                    <section className="space-y-3">
                        <h4 className="text-sm font-semibold uppercase tracking-wider text-muted">Basic info</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <Field label="Name" value={meta.name} onChange={v => updateMeta({ name: v })} />
                            <Field label="Category" type="select" value={meta.category}
                                onChange={v => updateMeta({ category: v })}
                                options={CATEGORIES} />
                            <Field label="Author" value={meta.author} onChange={v => updateMeta({ author: v })} />
                            <Field label="Version" value={meta.version} onChange={v => updateMeta({ version: v })} />
                            <Field label="Estimated duration (s)" type="number"
                                value={meta.estimatedDurationSec}
                                onChange={v => updateMeta({ estimatedDurationSec: parseFloat(v) || 60 })} />
                            <div className="space-y-1.5">
                                <label className="text-xs uppercase tracking-wider text-muted font-semibold">Status</label>
                                <label className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors ${meta.experimental ? 'border-warning/40 bg-warning/10' : 'border-border bg-background'}`}>
                                    <input type="checkbox" checked={!!meta.experimental}
                                        onChange={e => updateMeta({ experimental: e.target.checked })}
                                        className="accent-amber-500" />
                                    <FlaskConical size={14} className={meta.experimental ? 'text-warning' : 'text-muted'} />
                                    <span className={`text-sm ${meta.experimental ? 'text-warning' : 'text-muted'}`}>
                                        {meta.experimental ? 'Experimental — not yet validated' : 'Validated'}
                                    </span>
                                </label>
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-xs uppercase tracking-wider text-muted font-semibold">Description</label>
                            <textarea
                                value={meta.description || ''}
                                onChange={(e) => updateMeta({ description: e.target.value })}
                                className="w-full bg-background border border-border rounded-lg p-2.5 text-white text-sm min-h-[60px]"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-xs uppercase tracking-wider text-muted font-semibold">
                                Prompt guides <span className="normal-case tracking-normal font-normal">— shown to students above the booking form</span>
                            </label>
                            {(meta.promptGuides || []).map((g, gi) => {
                                const setGuide = (patch) => updateMeta({
                                    promptGuides: (meta.promptGuides || []).map((x, xi) => xi === gi ? { ...x, ...patch } : x)
                                });
                                return (
                                    <div key={gi} className="grid grid-cols-1 md:grid-cols-[1fr_2fr_auto] gap-2 items-start p-2 rounded-lg border border-border bg-background">
                                        <input value={g.label || ''} placeholder="Label"
                                            onChange={e => setGuide({ label: e.target.value })}
                                            className="bg-background border border-border rounded-md p-2 text-sm text-white" />
                                        <input value={g.url || ''} placeholder="https://…"
                                            onChange={e => setGuide({ url: e.target.value })}
                                            className="bg-background border border-border rounded-md p-2 text-sm text-white" />
                                        <button type="button" title="Remove this guide"
                                            onClick={() => updateMeta({ promptGuides: (meta.promptGuides || []).filter((_, xi) => xi !== gi) })}
                                            className="p-2 text-muted hover:text-danger">
                                            <X size={14} />
                                        </button>
                                        <input value={g.tip || ''} placeholder="One-line tip shown under the link (optional)"
                                            onChange={e => setGuide({ tip: e.target.value || undefined })}
                                            className="md:col-span-3 bg-background border border-border rounded-md p-2 text-xs text-white" />
                                    </div>
                                );
                            })}
                            <button type="button"
                                onClick={() => updateMeta({ promptGuides: [...(meta.promptGuides || []), { label: 'Official prompt guide', url: '' }] })}
                                className="text-xs font-semibold text-primary hover:underline">
                                + Add a prompt guide link
                            </button>
                        </div>
                    </section>

                    {/* Parameters */}
                    <section className="space-y-3">
                        <div className="flex items-center justify-between flex-wrap gap-2">
                            <div className="flex items-center gap-3">
                                <h4 className="text-sm font-semibold uppercase tracking-wider text-muted">
                                    Parameters
                                </h4>
                                <span className="text-xs text-muted">
                                    {enabledCount} of {params.length} exposed
                                    {paramQuery.trim() && ` · ${visibleParams.length} shown`}
                                </span>
                            </div>
                            <div className="flex items-center gap-2 text-xs">
                                <button onClick={() => setShowPreview(v => !v)}
                                    className={`px-2 py-1 rounded border inline-flex items-center gap-1 transition-colors ${showPreview ? 'bg-primary/15 border-primary/40 text-primary' : 'bg-surface border-border text-muted hover:border-primary/40 hover:text-white'}`}
                                    title="Show a live preview of the booking form students will see">
                                    <Monitor size={12} />
                                    {showPreview ? 'Hide preview' : 'Student preview'}
                                </button>
                                <button onClick={hideInfrastructure}
                                    className="px-2 py-1 rounded bg-surface border border-border hover:border-primary/40 text-muted hover:text-white">
                                    <Filter size={12} className="inline -mt-0.5 mr-1" />
                                    Hide infrastructure
                                </button>
                                <button onClick={() => setAllEnabled(true)}
                                    className="px-2 py-1 rounded bg-surface border border-border hover:border-primary/40 text-muted hover:text-white">
                                    Enable all
                                </button>
                                <button onClick={() => setAllEnabled(false)}
                                    className="px-2 py-1 rounded bg-surface border border-border hover:border-primary/40 text-muted hover:text-white">
                                    Disable all
                                </button>
                                <select value={filter} onChange={e => setFilter(e.target.value)}
                                    className="bg-surface border border-border rounded px-2 py-1 text-muted">
                                    <option value="all">Show all</option>
                                    <option value="enabled">Only enabled</option>
                                    <option value="disabled">Only disabled</option>
                                </select>
                            </div>
                        </div>

                        <div className="relative">
                            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
                            <input
                                type="text"
                                value={paramQuery}
                                onChange={e => setParamQuery(e.target.value)}
                                placeholder="Search parameters by name, node, title, field, or type…"
                                className="w-full bg-background border border-border rounded px-2 py-1.5 pl-8 pr-8 text-sm text-white placeholder:text-muted focus:border-primary outline-none"
                            />
                            {paramQuery && (
                                <button type="button" onClick={() => setParamQuery('')}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted hover:text-white"
                                    title="Clear search">
                                    <X size={12} />
                                </button>
                            )}
                        </div>

                        <p className="text-[10px] text-muted">
                            Drag-equivalent: use the ▲/▼ buttons to reorder. The order set here is exactly the order students see in the booking dialog.
                        </p>
                        <div className={showPreview ? 'grid grid-cols-1 lg:grid-cols-2 gap-5 items-start' : ''}>
                        <div className="space-y-2 max-h-[60vh] overflow-y-auto custom-scrollbar pr-2 min-w-0">
                            {visibleParams.map((p, visibleIdx) => {
                                const idx = params.indexOf(p);
                                const isFirst = visibleIdx === 0;
                                const isLast = visibleIdx === visibleParams.length - 1;
                                return (
                                    <div key={p.key}
                                        className={`p-3 rounded-lg border transition-colors ${p.enabled ? 'bg-surface border-primary/30' : 'bg-surface/40 border-border opacity-70'}`}>
                                        <div className="flex items-start gap-3">
                                            <div className="flex flex-col items-center gap-1 shrink-0">
                                                <button onClick={() => updateParam(idx, { enabled: !p.enabled })}
                                                    className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${p.enabled ? 'bg-primary border-primary text-white' : 'border-slate-500 hover:border-slate-300'}`}
                                                    title={p.enabled ? 'Hide from students' : 'Show to students'}>
                                                    {p.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
                                                </button>
                                                <button onClick={() => moveParam(visibleIdx, 'up')}
                                                    disabled={isFirst}
                                                    className="w-5 h-5 rounded border border-border text-muted hover:text-white hover:border-primary/40 disabled:opacity-30 disabled:hover:text-muted disabled:hover:border-border flex items-center justify-center transition-colors"
                                                    title="Move up">
                                                    <ArrowUp size={12} />
                                                </button>
                                                <button onClick={() => moveParam(visibleIdx, 'down')}
                                                    disabled={isLast}
                                                    className="w-5 h-5 rounded border border-border text-muted hover:text-white hover:border-primary/40 disabled:opacity-30 disabled:hover:text-muted disabled:hover:border-border flex items-center justify-center transition-colors"
                                                    title="Move down">
                                                    <ArrowDown size={12} />
                                                </button>
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 text-[10px] text-muted mb-2 font-mono">
                                                    <span className="bg-black/30 px-1.5 py-0.5 rounded">#{visibleIdx + 1}</span>
                                                    <span>·</span>
                                                    <span className="bg-black/30 px-1.5 py-0.5 rounded">node {p.nodeId}</span>
                                                    {p.nodeTitle && (
                                                        <>
                                                            <span>·</span>
                                                            <span className="opacity-90 truncate" title={p.classType ? `${p.nodeTitle} (${p.classType})` : p.nodeTitle}>{p.nodeTitle}</span>
                                                        </>
                                                    )}
                                                    <span>·</span>
                                                    <span className="opacity-70 truncate">{p.field}</span>
                                                </div>
                                                <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-start">
                                                    <div className="md:col-span-5 space-y-1">
                                                        <label className="text-[10px] uppercase tracking-wider text-muted font-semibold">Display name (shown to students)</label>
                                                        <input type="text" value={p.label || ''}
                                                            disabled={!p.enabled}
                                                            onChange={e => updateParam(idx, { label: e.target.value })}
                                                            className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-white disabled:opacity-50" />
                                                    </div>
                                                    <div className="md:col-span-3 space-y-1">
                                                        <label className="text-[10px] uppercase tracking-wider text-muted font-semibold">Type</label>
                                                        <select value={p.type}
                                                            disabled={!p.enabled}
                                                            onChange={e => updateParam(idx, { type: e.target.value })}
                                                            className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-white disabled:opacity-50">
                                                            {PARAM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                                                        </select>
                                                    </div>
                                                    <div className="md:col-span-4 space-y-1">
                                                        <label className="text-[10px] uppercase tracking-wider text-muted font-semibold">Default</label>
                                                        {p.type === 'textarea' ? (
                                                            <textarea value={p.default ?? ''}
                                                                disabled={!p.enabled}
                                                                onChange={e => updateParam(idx, { default: e.target.value })}
                                                                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-white disabled:opacity-50 min-h-[34px] resize-y" />
                                                        ) : p.type === 'checkbox' ? (
                                                            <select value={String(!!p.default)}
                                                                disabled={!p.enabled}
                                                                onChange={e => updateParam(idx, { default: e.target.value === 'true' })}
                                                                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-white disabled:opacity-50">
                                                                <option value="false">false</option>
                                                                <option value="true">true</option>
                                                            </select>
                                                        ) : (
                                                            <input type={p.type === 'number' ? 'number' : 'text'}
                                                                value={p.default ?? ''}
                                                                disabled={!p.enabled}
                                                                onChange={e => updateParam(idx, {
                                                                    default: p.type === 'number'
                                                                        ? (e.target.value === '' ? '' : parseFloat(e.target.value))
                                                                        : e.target.value
                                                                })}
                                                                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-white disabled:opacity-50" />
                                                        )}
                                                    </div>
                                                    {p.type === 'select' && p.enabled && (
                                                        <div className="md:col-span-12 space-y-1">
                                                            <label className="text-[10px] uppercase tracking-wider text-muted font-semibold">Options (comma-separated)</label>
                                                            <input type="text"
                                                                value={(p.options || []).join(', ')}
                                                                onChange={e => updateParam(idx, {
                                                                    options: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                                                                })}
                                                                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-white" />
                                                        </div>
                                                    )}
                                                    {p.type === 'number' && p.enabled && (
                                                        <div className="md:col-span-12 grid grid-cols-3 gap-2">
                                                            <NumField label="min" value={p.min} onChange={v => updateParam(idx, { min: v })} />
                                                            <NumField label="max" value={p.max} onChange={v => updateParam(idx, { max: v })} />
                                                            <NumField label="step" value={p.step} onChange={v => updateParam(idx, { step: v })} />
                                                        </div>
                                                    )}
                                                    {(p.type === 'image' || p.type === 'video' || p.type === 'mask') && p.enabled && (
                                                        <div className="md:col-span-12 space-y-1">
                                                            <label className="text-[10px] uppercase tracking-wider text-muted font-semibold">
                                                                Max input edge (px)
                                                            </label>
                                                            <input type="number" min="64" step="64"
                                                                placeholder={p.type === 'video' ? '1280 (default)' : '1024 (default)'}
                                                                value={p.maxInputEdge ?? ''}
                                                                onChange={e => updateParam(idx, {
                                                                    maxInputEdge: e.target.value === '' ? undefined : parseInt(e.target.value, 10)
                                                                })}
                                                                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-white" />
                                                            <p className="text-[10px] text-muted leading-snug">
                                                                Client downsizes the longer edge to this many pixels before upload — saves LAN bandwidth and matches the workflow's working resolution. Leave blank to use the {p.type === 'video' ? '1280' : '1024'}px default. Aspect ratio is preserved; never upscales.
                                                            </p>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                            {visibleParams.length === 0 && (
                                <p className="text-sm text-muted text-center py-8">No parameters match the filter.</p>
                            )}
                        </div>
                        {showPreview && (
                            <div className="lg:sticky lg:top-2 self-start min-w-0">
                                <StudentPreview params={params} headers={headers} />
                            </div>
                        )}
                        </div>
                    </section>

                    <div className="flex justify-end gap-2 pt-2 border-t border-border">
                        <Button variant="ghost" onClick={onClose} icon={X}>Cancel</Button>
                        <Button variant="primary" onClick={save} icon={saving ? RefreshCw : Save}
                            disabled={saving}>
                            {saving ? 'Saving…' : 'Save metadata'}
                        </Button>
                    </div>
                </div>
            )}
        </Modal>
    );
};

// Live preview of the student booking form, rendered through the SAME
// DynamicParamFields the real BookingDialog uses — so it can't drift. Builds a
// parameter_map from the editor's current (unsaved) params (enabled only, in
// the admin's order) and drives it with throwaway local state.
const StudentPreview = ({ params, headers }) => {
    // `lora`-type dropdowns are filled server-side for the real form; fetch the
    // same installed-LoRA list here (keyed by dir|filter) so the preview matches.
    const [loraOpts, setLoraOpts] = useState({});
    const loraKeys = params
        .filter(p => p.enabled && p.type === 'lora')
        .map(p => `${p.optionsDir || 'loras'}|${p.optionsFilter || ''}`);
    const loraSig = JSON.stringify([...new Set(loraKeys)].sort());
    useEffect(() => {
        let cancelled = false;
        const keys = JSON.parse(loraSig);
        Promise.all(keys.map(async (k) => {
            const [dir, filter] = k.split('|');
            try {
                const res = await fetch(`${SERVER_URL}/admin/loras?dir=${encodeURIComponent(dir)}&filter=${encodeURIComponent(filter)}`, { headers });
                const data = await res.json();
                return [k, { files: data.files || [], labels: data.labels || [] }];
            } catch { return [k, { files: [], labels: [] }]; }
        })).then(pairs => { if (!cancelled) setLoraOpts(Object.fromEntries(pairs)); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loraSig]);

    // Editor param shape → wire `parameter_map` shape DynamicParamFields expects.
    const paramMap = useMemo(() => {
        const map = {};
        params.filter(p => p.enabled).forEach((p, i) => {
            let options = p.options;
            let optionLabels;
            if (p.type === 'lora') {
                const got = loraOpts[`${p.optionsDir || 'loras'}|${p.optionsFilter || ''}`];
                let files = got?.files || [];
                let labels = got?.labels || [];
                if (!files.length && p.default) { files = [p.default]; labels = [p.default]; }
                else if (p.default && !files.includes(p.default)) { files = [p.default, ...files]; labels = [p.default, ...labels]; }
                options = files;
                optionLabels = labels;
            }
            map[p.key] = {
                type: p.type,
                label: p.label,
                default: p.default,
                options,
                optionLabels,
                min: p.min,
                max: p.max,
                step: p.step,
                maxInputEdge: p.maxInputEdge,
                disabledWhen: p.disabledWhen,
                format: p.format,
                required: p.required,
                field: p.field,        // needed for seed detection
                order: i,
                enabled: true,
            };
        });
        return map;
    }, [params, loraOpts]);

    // Re-seed the form values when the *structure* changes (keys / types /
    // options / defaults) — NOT on label/order edits, so reordering or renaming
    // doesn't reset the preview. Seeds keep their value across re-seeds (no
    // flicker); media previews for still-present keys are kept.
    const sig = useMemo(
        () => JSON.stringify(Object.entries(paramMap).map(([k, c]) => [k, c.type, c.default, c.options])),
        [paramMap]
    );
    const [values, setValues] = useState({});
    const [previews, setPreviews] = useState({});
    const filesRef = useRef({});
    useEffect(() => {
        setValues(prev => {
            const next = {};
            for (const [k, c] of Object.entries(paramMap)) {
                next[k] = isSeedParam(k, c) ? (k in prev ? prev[k] : randomSeed()) : (c.default ?? '');
            }
            return next;
        });
        setPreviews(prev => {
            const next = {};
            for (const k of Object.keys(paramMap)) if (k in prev) next[k] = prev[k];
            return next;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sig]);

    const onValueChange = (k, v) => setValues(prev => ({ ...prev, [k]: v }));
    const mediaChangeHandler = (k) => (file) => {
        if (!file) return;
        filesRef.current[k] = file;
        const reader = new FileReader();
        reader.onloadend = () => setPreviews(prev => ({ ...prev, [k]: reader.result }));
        reader.readAsDataURL(file);
    };
    const mediaRemoveHandler = (k) => () => {
        delete filesRef.current[k];
        setPreviews(prev => { const n = { ...prev }; delete n[k]; return n; });
    };

    const count = Object.keys(paramMap).length;
    return (
        <div className="rounded-xl border border-border bg-background/60 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface/60">
                <Monitor size={14} className="text-primary" />
                <span className="text-xs font-semibold text-foreground">Student preview</span>
                <span className="text-[10px] text-muted">— the booking form, live as you edit</span>
            </div>
            <div className="p-4 max-w-md mx-auto">
                {count === 0 ? (
                    <p className="text-sm text-muted text-center py-8">No exposed parameters — students would see an empty form.</p>
                ) : (
                    <DynamicParamFields
                        paramMap={paramMap}
                        values={values}
                        onValueChange={onValueChange}
                        mediaPreviews={previews}
                        recalledMedia={{}}
                        mediaChangeHandler={mediaChangeHandler}
                        mediaRemoveHandler={mediaRemoveHandler}
                    />
                )}
            </div>
        </div>
    );
};

const Field = ({ label, value, onChange, type = 'text', options }) => (
    <div className="space-y-1.5">
        <label className="text-xs uppercase tracking-wider text-muted font-semibold">{label}</label>
        {type === 'select' ? (
            <select value={value || ''} onChange={(e) => onChange(e.target.value)}
                className="w-full bg-background border border-border rounded-lg p-2 text-white text-sm">
                {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
        ) : (
            <input type={type} value={value ?? ''} onChange={(e) => onChange(e.target.value)}
                className="w-full bg-background border border-border rounded-lg p-2 text-white text-sm" />
        )}
    </div>
);

const NumField = ({ label, value, onChange }) => (
    <div className="space-y-1">
        <label className="text-[10px] uppercase tracking-wider text-muted font-semibold">{label}</label>
        <input type="number"
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value === '' ? undefined : parseFloat(e.target.value))}
            className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-white" />
    </div>
);

function coerceDefault(p) {
    if (p.type === 'number') {
        if (p.default === '' || p.default == null) return 0;
        const n = parseFloat(p.default);
        return isNaN(n) ? 0 : n;
    }
    if (p.type === 'checkbox') return !!p.default;
    return p.default ?? '';
}

export default WorkflowMetaEditor;
