import React, { useState, useEffect } from 'react';
import {
    Image, Video, Wand2, Music, Box, LayoutGrid, List,
    RefreshCw, ChevronRight, Sparkles, Clock, Tag,
    Pencil, Trash2, Gauge, Cpu, FileText, Wrench, Search, X,
    ExternalLink, Power, Radio, Square, Brush, Film, FlaskConical, ShieldCheck, MemoryStick
, PackageX } from 'lucide-react';
import Card from './ui/Card';
import Badge from './ui/Badge';
import { SERVER_URL } from '../utils/api';
import { accessHeaders } from '../utils/access';
import PromptGuideLinks from './PromptGuideLinks';
import ModelReadiness from './admin/ModelReadiness';

// "Type of workflow" buckets shown as filter chips in the admin library. Each
// fine-grained meta category maps to exactly one group; this is the user-facing
// taxonomy. Generation and editing are separate groups: creating a new image /
// video is distinct from modifying an existing one (i2v is generation — a video
// grown from an image — not an edit).
const GROUPS = [
    { key: '3d', label: '3D', icon: Box },
    { key: 'audio', label: 'Audio', icon: Music },
    { key: 'description', label: 'Description', icon: FileText },
    { key: 'image', label: 'Image generation', icon: Wand2 },
    { key: 'image-edit', label: 'Image editing', icon: Brush },
    { key: 'video', label: 'Video generation', icon: Video },
    { key: 'video-edit', label: 'Video editing', icon: Film },
    { key: 'utility', label: 'Utilities', icon: Wrench },
    { key: 'other', label: 'Other', icon: LayoutGrid },
];
const CATEGORY_GROUP = {
    '3d': '3d',
    'audio': 'audio',
    'description': 'description',
    // Generation vs editing kept apart. t2i/i2v make new media; image-edit /
    // video-edit modify media the user supplies.
    't2i': 'image', 'image-edit': 'image-edit',
    'i2v': 'video', 'video-edit': 'video-edit',
    // Image-to-image (upscalers) and preprocessors (segmentation, frame
    // interpolation, depth) are all "utilities" in the user-facing taxonomy.
    'i2i': 'utility', 'preprocessor': 'utility',
    'other': 'other',
};
const groupOf = (cat) => CATEGORY_GROUP[cat] || 'other';
// Mirrors server/workers/perfFlags.js — the global ComfyUI speed-ups a bundle can opt out of.
const PERF_FLAG_LABELS = { use_sage_attention: 'Sage attention', fp16_accumulation: 'fp16 accumulation' };

/**
 * What this workflow's models weigh, measured against this machine's card.
 *
 * The number is the sum of the model files on the graph's active path (see
 * server/workflows/vramEstimate.js) — an upper bound on resident weights, and
 * the figure to use when deciding whether a second workflow can be served
 * beside this one. A bundle whose models are resolved inside its nodes reports
 * nothing rather than pretending to be free.
 */
const VramChip = ({ vram, gpu, fit, servedHere, measured }) => {
    if (!vram && !measured) return null;
    // A measured peak from calibration beats the static estimate — and it is
    // the only figure for a pipeline whose models aren't named as files in the
    // graph (the 3D bundles load a HuggingFace repo and stage through it).
    if (measured) {
        const tone = servedHere ? 'text-success' : fit ? (fit.ok ? 'text-success' : 'text-danger') : '';
        return (
            <span className={`flex items-center gap-1 ${tone}`}
                title={`Measured on this GPU during calibration: ${measured} GB at peak.`
                    + (vram?.known ? ` The models on disk add up to ${vram.weightsGb} GB — the run never holds all of it at once.` : '')}>
                <MemoryStick size={12} />{measured} GB measured
            </span>
        );
    }
    if (!vram.known) {
        return (
            <span className="flex items-center gap-1" title="This workflow's nodes resolve their models internally, so the size can't be read from the graph. Calibrate it and the real figure is measured on the card.">
                <MemoryStick size={12} />VRAM unknown — calibrate to measure
            </span>
        );
    }
    const card = gpu?.vramGb || null;
    const overCard = card ? vram.weightsGb > card : false;
    const parts = vram.components.slice(0, 6).map(c => `${c.gb} GB ${c.kind}`).join(' + ');
    const missing = vram.unresolved.length ? `\n${vram.unresolved.length} model(s) not found on this machine: ${vram.unresolved.join(', ')}` : '';
    const pruned = vram.prunedGb ? `\n${vram.prunedGb} GB on unused switch branches is not counted.` : '';

    // Once the machine is serving something, this says at a glance whether this
    // workflow could run beside it: green it fits, red it does not.
    let tone = overCard ? 'text-warning' : '';
    let verdict = '';
    if (servedHere) { tone = 'text-success'; verdict = '\nBeing served right now.'; }
    else if (fit) {
        tone = fit.ok ? 'text-success' : 'text-danger';
        verdict = fit.ok
            ? `\nFits alongside what is already running — ${fit.freeGb} GB free.`
            : fit.reason === 'not-enough-vram'
                ? `\nWon't fit alongside what is running: needs ${fit.needGb} GB, ${fit.freeGb} GB free.`
                : fit.reason === 'size-unknown'
                    ? '\nIts size cannot be read, so it cannot be placed automatically.'
                    : '\nCannot be added right now.';
    }
    return (
        <span
            className={`flex items-center gap-1 ${tone}`}
            title={`Models on the active path: ${parts}.${pruned}${missing}\n${overCard
                ? `More than this card holds (${card} GB) — ComfyUI streams the weights from RAM, and nothing else will fit beside it.`
                : card ? `This card has ${card} GB.` : ''}${verdict}`}
        >
            <MemoryStick size={12} />{vram.weightsGb} GB{overCard ? ' — over this card' : ''}
        </span>
    );
};

/**
 * WorkflowSelector
 * Lists workflows from /workflows and lets the admin pick one.
 * Calls onSelect(workflowDetails) when a workflow is chosen.
 * Calls onPresetSelect(name, values) when a preset chip is clicked.
 */
// A node pack this machine does not have. Louder than a missing model on
// purpose: ComfyUI rejects the whole prompt for an unknown class_type, so the
// student gets a failure that names nothing, and no amount of retrying helps.
const MissingPackChip = ({ classes, packs }) => {
    if (!classes?.length) return null;
    const named = (packs || []).filter(p => p.classes.some(c => classes.includes(c)));
    const where = named.length
        ? named.map(p => p.title).join(', ')
        : 'no pack database knows it';
    return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px]
            font-medium border bg-danger/10 text-danger border-danger/20"
            title={`This machine has no node for ${classes.join(', ')}.\nFrom: ${where}.\n\n`
                + 'ComfyUI refuses the whole graph for an unknown class, so this bundle cannot run '
                + 'here. Install it under Manage ComfyUI → Node packs, then restart ComfyUI.'}>
            <PackageX size={12} />node pack missing
        </span>
    );
};

const WorkflowSelector = ({ headers = {}, nodePackGaps = null, selectedWorkflowId, activeWorkflowId, onSelect, onPresetSelect, onEdit, onDelete, onCalibrate, calibratingIds = new Set(), onOpenInComfy, openingComfyId = null, onActivate, activatingId = null, canActivate = true, onDeactivate, deactivating = false, serving = false, onValidate, validatingId = null,
    lanes = [], laneFit = {}, onServeAlongside = null, serveAlongsideId = null, onCloseLane = null, closingLaneId = null }) => {
    const [workflows, setWorkflows] = useState([]);
    // This machine's card, so "17.3 GB" can be judged against what it has —
    // the same workflow is comfortable on a 96 GB card and impossible on 24.
    const [gpu, setGpu] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [viewMode, setViewMode] = useState('grid');
    const [selectedGroup, setSelectedGroup] = useState('all');
    // Status filter, independent of the type group: narrow the library to the
    // experimental (built but not yet hand-tested) bundles.
    const [onlyExperimental, setOnlyExperimental] = useState(false);
    const [query, setQuery] = useState('');
    const [selectedWorkflow, setSelectedWorkflow] = useState(null);

    const categoryIcons = {
        't2i': Wand2, 'image-edit': Image, 'i2v': Video, 'i2i': Image,
        'audio': Music, '3d': Box, 'preprocessor': Box,
        'description': FileText, 'other': LayoutGrid
    };

    const fetchWorkflows = async () => {
        setLoading(true); setError(null);
        try {
            const res = await fetch(`${SERVER_URL}/workflows`, { headers: accessHeaders() });
            if (!res.ok) throw new Error('Failed to fetch workflows');
            const data = await res.json();
            setWorkflows(data.workflows || []);
            setGpu(data.gpu || null);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { fetchWorkflows(); }, []);

    useEffect(() => {
        if (selectedWorkflowId && (!selectedWorkflow || selectedWorkflow.id !== selectedWorkflowId)) {
            fetchDetails(selectedWorkflowId);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedWorkflowId]);

    const fetchDetails = async (id) => {
        try {
            const res = await fetch(`${SERVER_URL}/workflows/${id}`, { headers: accessHeaders() });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || 'Failed to fetch workflow details');
            }
            const data = await res.json();
            setSelectedWorkflow(data);
            if (onSelect) onSelect(data);
        } catch (err) {
            console.error('[WorkflowSelector]', err);
        }
    };

    const handleClick = (w) => fetchDetails(w.id);

    const handlePreset = async (name) => {
        if (!selectedWorkflow) return;
        try {
            const res = await fetch(`${SERVER_URL}/workflows/${selectedWorkflow.id}/presets/${name}`, { headers: accessHeaders() });
            if (!res.ok) throw new Error('Failed to apply preset');
            const data = await res.json();
            if (onPresetSelect) onPresetSelect(name, data.values);
        } catch (err) {
            console.error('[WorkflowSelector]', err);
        }
    };

    // Alphabetical by display name (case-insensitive, natural-number order) so the
    // library reads predictably; group filter + search derive from this order.
    const usable = workflows
        .filter(w => !w.unavailable)
        .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, undefined, { sensitivity: 'base', numeric: true }));
    // Keyword search: every whitespace-separated term must appear somewhere in
    // the name / description / tags / category / id (AND match). Runs before the
    // group filter so the chip counts reflect the current search.
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matchesQuery = (w) => {
        if (terms.length === 0) return true;
        const hay = [w.name, w.description, w.category, w.id, ...(w.tags || [])]
            .filter(Boolean).join(' ').toLowerCase();
        return terms.every(t => hay.includes(t));
    };
    const searchedAll = usable.filter(matchesQuery);
    const experimentalCount = searchedAll.filter(w => w.experimental).length;
    // The experimental toggle applies before the group chips so their counts
    // describe what's actually listed.
    const searched = onlyExperimental ? searchedAll.filter(w => w.experimental) : searchedAll;
    const filtered = selectedGroup === 'all' ? searched : searched.filter(w => groupOf(w.category) === selectedGroup);
    // Only show chips for groups that have a match under the current search, with counts.
    const availableGroups = GROUPS
        .map(g => ({ ...g, count: searched.filter(w => groupOf(w.category) === g.key).length }))
        .filter(g => g.count > 0);

    if (loading) {
        return (
            <div className="flex items-center justify-center py-12">
                <RefreshCw className="w-6 h-6 text-primary animate-spin" />
                <span className="ml-3 text-muted">Loading workflows...</span>
            </div>
        );
    }

    if (error) {
        return (
            <div className="text-center py-8">
                <p className="text-danger mb-4">Error: {error}</p>
                <button onClick={fetchWorkflows} className="px-4 py-2 bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors">
                    Retry
                </button>
            </div>
        );
    }

    if (workflows.length === 0) {
        return (
            <div className="text-center py-12 text-muted">
                <LayoutGrid className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p className="mb-2">No workflows found</p>
                <p className="text-sm">Add a folder under <code className="bg-surface px-2 py-1 rounded">workflows/</code> with <code>{'<id>.api.json'}</code> + <code>{'<id>.meta.json'}</code></p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-primary" />
                    <h3 className="font-semibold">Select Workflow</h3>
                    <Badge variant="default" className="ml-2">{usable.length}</Badge>
                </div>
                <div className="flex items-center gap-2">
                    <div className="flex bg-surface border border-border rounded-lg p-0.5">
                        <button onClick={() => setViewMode('grid')} className={`p-1.5 rounded ${viewMode === 'grid' ? 'bg-primary/20 text-primary' : 'text-muted hover:text-white'}`}>
                            <LayoutGrid size={16} />
                        </button>
                        <button onClick={() => setViewMode('list')} className={`p-1.5 rounded ${viewMode === 'list' ? 'bg-primary/20 text-primary' : 'text-muted hover:text-white'}`}>
                            <List size={16} />
                        </button>
                    </div>
                    <button onClick={fetchWorkflows} className="p-1.5 text-muted hover:text-white" title="Refresh">
                        <RefreshCw size={16} />
                    </button>
                </div>
            </div>

            {/* Keyword search */}
            <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
                <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search workflows by name, tag, or description…"
                    className="w-full bg-surface border border-border rounded-lg pl-9 pr-9 py-2 text-sm text-foreground placeholder:text-muted focus:ring-2 focus:ring-primary/40 focus:border-primary outline-none transition-all"
                />
                {query && (
                    <button
                        type="button"
                        onClick={() => setQuery('')}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded text-muted hover:text-foreground transition-colors"
                        title="Clear search"
                    >
                        <X size={14} />
                    </button>
                )}
            </div>

            {/* Filter by type of workflow */}
            <div className="flex flex-wrap items-center gap-2">
                {[{ key: 'all', label: 'All', icon: Sparkles, count: searched.length }, ...availableGroups].map(g => {
                    const Icon = g.icon;
                    const active = selectedGroup === g.key;
                    return (
                        <button
                            key={g.key}
                            type="button"
                            onClick={() => setSelectedGroup(g.key)}
                            className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors
                                ${active ? 'border-primary bg-primary/15 text-primary' : 'border-border bg-surface text-muted hover:text-white hover:border-primary/40'}`}
                            title={`Show ${g.label} workflows`}
                        >
                            <Icon size={14} />
                            <span>{g.label}</span>
                            <span className={active ? 'text-primary/70' : 'text-muted/60'}>{g.count}</span>
                        </button>
                    );
                })}
                {(experimentalCount > 0 || onlyExperimental) && (
                    <button
                        type="button"
                        onClick={() => setOnlyExperimental(v => !v)}
                        className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors sm:ml-auto
                            ${onlyExperimental ? 'border-warning bg-warning/15 text-warning' : 'border-warning/30 bg-surface text-warning/80 hover:border-warning/60'}`}
                        title={onlyExperimental ? 'Show every workflow again' : 'Show only experimental workflows (built but not yet validated by hand)'}
                    >
                        <FlaskConical size={14} />
                        <span>Experimental</span>
                        <span className={onlyExperimental ? 'text-warning/70' : 'text-warning/50'}>{experimentalCount}</span>
                    </button>
                )}
            </div>

            {filtered.length === 0 ? (
                <div className="text-center py-10 text-muted">
                    <Search className="w-8 h-8 mx-auto mb-3 opacity-50" />
                    <p className="text-sm">
                        No workflows match{query ? <> “<span className="text-foreground">{query.trim()}</span>”</> : ''}
                        {selectedGroup !== 'all' ? ' in this category' : ''}{onlyExperimental ? ' among experimental workflows' : ''}.
                    </p>
                    {(query || selectedGroup !== 'all' || onlyExperimental) && (
                        <button
                            onClick={() => { setQuery(''); setSelectedGroup('all'); setOnlyExperimental(false); }}
                            className="mt-3 text-primary text-sm hover:underline"
                        >
                            Clear filters
                        </button>
                    )}
                </div>
            ) : (
            <div className={viewMode === 'grid'
                ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4'
                : 'space-y-2'}>
                {filtered.map((w) => {
                    const IconComponent = categoryIcons[w.category] || LayoutGrid;
                    const isSelected = selectedWorkflow?.id === w.id;
                    const isActive = activeWorkflowId === w.id;
                    // "Serving" is only true when the server is actually in student
                    // mode serving this workflow; in admin mode nothing is served.
                    const isServing = isActive && serving;
                    // Lanes: this machine can serve several workflows at once,
                    // each with its own ComfyUI. A card is either one of them,
                    // or a candidate that fits (or doesn't) beside them.
                    const lane = lanes.find(l => l.workflowId === w.id) || null;
                    const anyLaneRunning = lanes.length > 0;
                    const fit = lane ? null : (laneFit[w.id] || null);
                    const isCalibrating = calibratingIds.has(w.id);
                    return (
                        <div
                            key={w.id}
                            onClick={() => handleClick(w)}
                            className={`group relative cursor-pointer rounded-xl border transition-all duration-200
                                ${isSelected ? 'border-primary bg-primary/10 ring-2 ring-primary/30' : 'border-border bg-surface hover:border-primary/50 hover:bg-surface/80'}
                                ${viewMode === 'grid' ? 'p-4' : 'p-3 flex items-center gap-4'}`}
                        >
                            {/* Per-card action buttons (visible on hover; always visible if selected) */}
                            {(onEdit || onDelete || onCalibrate) && (
                                <div className={`absolute top-2 right-2 flex items-center gap-1 transition-opacity ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                                    {onCalibrate && (
                                        <button
                                            type="button"
                                            disabled={isCalibrating}
                                            onClick={(e) => { e.stopPropagation(); onCalibrate(w.id); }}
                                            className="p-1.5 rounded-md bg-background/90 border border-border hover:border-primary/50 text-muted hover:text-primary transition-colors disabled:opacity-50 disabled:cursor-wait"
                                            title={isCalibrating ? 'Calibrating…' : 'Calibrate (measure generation time)'}
                                        >
                                            {isCalibrating ? <RefreshCw size={12} className="animate-spin" /> : <Gauge size={12} />}
                                        </button>
                                    )}
                                    {onEdit && (
                                        <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); onEdit(w.id); }}
                                            className="p-1.5 rounded-md bg-background/90 border border-border hover:border-primary/50 text-muted hover:text-primary transition-colors"
                                            title="Edit metadata & parameters"
                                        >
                                            <Pencil size={12} />
                                        </button>
                                    )}
                                    {onDelete && (
                                        <button
                                            type="button"
                                            disabled={isActive}
                                            onClick={(e) => { e.stopPropagation(); onDelete(w.id); }}
                                            className="p-1.5 rounded-md bg-background/90 border border-border hover:border-danger/50 text-muted hover:text-danger transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                            title={isActive ? 'Cannot delete the active workflow' : 'Delete workflow'}
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    )}
                                </div>
                            )}

                            <div className={`rounded-lg bg-background flex items-center justify-center
                                ${viewMode === 'grid' ? 'w-12 h-12 mb-3' : 'w-10 h-10 flex-shrink-0'}`}>
                                <IconComponent size={viewMode === 'grid' ? 24 : 20}
                                    className={isSelected ? 'text-primary' : 'text-muted'} />
                            </div>
                            <div className={viewMode === 'list' ? 'flex-1 min-w-0' : ''}>
                                <div className="flex items-start justify-between gap-2">
                                    <h4 className={`font-medium truncate ${isSelected ? 'text-primary' : 'text-foreground'}`}>{w.name}</h4>
                                    {isSelected && <ChevronRight size={16} className="text-primary flex-shrink-0" />}
                                </div>
                                {w.experimental && (
                                    <span
                                        className="inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-warning/10 text-warning border border-warning/30"
                                        title="Built and calibrated, but not yet tested by hand. Validate it once you've checked the results."
                                    >
                                        <FlaskConical size={11} /> Experimental
                                    </span>
                                )}
                                <p className="text-sm text-muted mt-1 line-clamp-2">{w.description}</p>
                                <PromptGuideLinks guides={w.promptGuides} compact />
                                <div className="flex items-center gap-3 mt-2 text-xs text-muted flex-wrap">
                                    <span className="flex items-center gap-1" title={w.hasCalibration && w.calibration?.calibratedAt
                                        ? `Calibrated ${new Date(w.calibration.calibratedAt).toLocaleString()}${w.calibration.coldDurationSec ? ` · cold run ${w.calibration.coldDurationSec}s (model load ${w.calibration.modelLoadSec}s)` : ''}`
                                        : 'Not yet calibrated — estimate from meta.json'}>
                                        <Clock size={12} />~{w.estimatedDurationSec}s {w.hasCalibration ? '' : '(uncalibrated)'}
                                    </span>
                                    <VramChip vram={w.vram} gpu={gpu} fit={anyLaneRunning ? fit : null} servedHere={!!lane} measured={w.calibration?.vramPeakGb || null} />
                                    <MissingPackChip
                                        classes={nodePackGaps?.missingByBundle?.[w.id]}
                                        packs={nodePackGaps?.packs} />
                                    <ModelReadiness vram={w.vram} models={w.models} headers={headers} />
                                    {w.hasCalibration && w.calibration?.gpu && (
                                        <span className="flex items-center gap-1 text-success/80"
                                            title={`Time measured on this GPU. Move to a different GPU and re-calibrate for an accurate estimate.`}>
                                            <Cpu size={12} />{w.calibration.gpu}
                                        </span>
                                    )}
                                    {w.disabledPerfFlags?.length > 0 && (
                                        <span className="flex items-center gap-1"
                                            title="This workflow produces black images with these ComfyUI speed-ups, so ComfyUI is restarted without them while it is served or calibrated. Other workflows keep them.">
                                            <Gauge size={12} />without {w.disabledPerfFlags.map(f => PERF_FLAG_LABELS[f] || f).join(' + ')}
                                        </span>
                                    )}
                                    {w.presets?.length > 0 && (
                                        <span className="flex items-center gap-1">
                                            <Tag size={12} />{w.presets.length} presets
                                        </span>
                                    )}
                                </div>
                            </div>
                            {/* Primary per-card actions: open the editable graph in
                                ComfyUI, and activate/serve the API version (what
                                ComfyQ Discovery shows being served). */}
                            {(onOpenInComfy || onActivate || (onValidate && w.experimental)) && (
                                <div className={`flex items-center gap-2 flex-wrap ${viewMode === 'grid' ? 'mt-3 pt-3 border-t border-border/60' : 'flex-shrink-0'}`}>
                                    {onOpenInComfy && (
                                        <button
                                            type="button"
                                            disabled={openingComfyId === w.id}
                                            onClick={(e) => { e.stopPropagation(); onOpenInComfy(w.id); }}
                                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-background border border-border hover:border-primary/50 text-muted hover:text-primary transition-colors disabled:opacity-60 disabled:cursor-wait"
                                            title="Open this workflow's editable graph in ComfyUI"
                                        >
                                            {openingComfyId === w.id ? <RefreshCw size={13} className="animate-spin" /> : <ExternalLink size={13} />}
                                            <span>Open in ComfyUI</span>
                                        </button>
                                    )}
                                    {onValidate && w.experimental && (
                                        <button
                                            type="button"
                                            disabled={validatingId === w.id}
                                            onClick={(e) => { e.stopPropagation(); onValidate(w.id); }}
                                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-background border border-warning/40 hover:border-success/60 text-warning hover:text-success transition-colors disabled:opacity-60 disabled:cursor-wait"
                                            title="I've tested this workflow — remove the Experimental tag"
                                        >
                                            {validatingId === w.id ? <RefreshCw size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
                                            <span>Validate</span>
                                        </button>
                                    )}
                                    {/* A lane this machine is already running, but not the
                                        main one: it can be closed without stopping the machine. */}
                                    {lane && !lane.primary && (
                                        <div className="inline-flex items-center gap-1.5 ml-auto">
                                            <span
                                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-success/15 border border-success/40 text-success"
                                                title={`Running in parallel on port ${lane.port}${lane.busy ? ' — currently generating' : ''}`}
                                            >
                                                <Radio size={13} /> Lane :{lane.port}
                                            </span>
                                            {onCloseLane && (
                                                <button
                                                    type="button"
                                                    disabled={closingLaneId === w.id}
                                                    onClick={(e) => { e.stopPropagation(); onCloseLane(w.id); }}
                                                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-background border border-border hover:border-danger/50 text-muted hover:text-danger transition-colors disabled:opacity-60 disabled:cursor-wait"
                                                    title="Stop this lane and give its VRAM back. The machine keeps serving the others."
                                                >
                                                    {closingLaneId === w.id ? <RefreshCw size={13} className="animate-spin" /> : <Square size={13} />}
                                                    <span>{closingLaneId === w.id ? 'Closing…' : 'Close lane'}</span>
                                                </button>
                                            )}
                                        </div>
                                    )}
                                    {/* The machine is already serving something else: offer this
                                        one as a second lane, greyed out when it will not fit. */}
                                    {!lane && anyLaneRunning && onServeAlongside && (
                                        <button
                                            type="button"
                                            disabled={!fit?.ok || serveAlongsideId !== null}
                                            onClick={(e) => { e.stopPropagation(); onServeAlongside(w.id); }}
                                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-primary/15 border border-primary/40 text-primary hover:bg-primary/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ml-auto"
                                            title={fit?.ok
                                                ? `Serve this as well, in parallel on its own ComfyUI — ${fit.needGb} GB of ${fit.freeGb} GB free.`
                                                : fit?.reason === 'not-enough-vram'
                                                    ? `Not enough VRAM: needs ${fit.needGb} GB, only ${fit.freeGb} GB free of the ${fit.cardGb} GB card (${fit.usedGb} GB already in use).`
                                                    : fit?.reason === 'size-unknown'
                                                        ? 'How much VRAM this needs cannot be read from its graph, so it cannot be placed automatically.'
                                                        : fit?.reason === 'card-unknown'
                                                            ? 'This machine’s VRAM could not be detected.'
                                                            : 'Cannot be served alongside right now.'}
                                        >
                                            {serveAlongsideId === w.id ? <RefreshCw size={13} className="animate-spin" /> : <Power size={13} />}
                                            <span>{serveAlongsideId === w.id ? 'Starting…' : 'Serve alongside'}</span>
                                        </button>
                                    )}
                                    {onActivate && (!lane || lane.primary) && (!anyLaneRunning || lane?.primary) && (
                                        isServing ? (
                                            <div className="inline-flex items-center gap-1.5 ml-auto">
                                                <span
                                                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-success/15 border border-success/40 text-success"
                                                    title="Active workflow — served to students in student mode"
                                                >
                                                    <Radio size={13} /> Serving
                                                </span>
                                                {onDeactivate && (
                                                    <button
                                                        type="button"
                                                        disabled={deactivating}
                                                        onClick={(e) => { e.stopPropagation(); onDeactivate(w.id); }}
                                                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-background border border-border hover:border-danger/50 text-muted hover:text-danger transition-colors disabled:opacity-60 disabled:cursor-wait"
                                                        title={(lanes || []).length > 1 ? 'Stop serving this workflow — the others keep serving' : 'Stop serving — switch the server back to admin mode'}
                                                    >
                                                        {deactivating ? <RefreshCw size={13} className="animate-spin" /> : <Square size={13} />}
                                                        <span>{deactivating ? 'Stopping…' : 'Stop serving'}</span>
                                                    </button>
                                                )}
                                            </div>
                                        ) : (
                                            <button
                                                type="button"
                                                disabled={!canActivate || activatingId !== null}
                                                onClick={(e) => { e.stopPropagation(); onActivate(w.id); }}
                                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-primary/15 border border-primary/40 text-primary hover:bg-primary/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ml-auto"
                                                title={!canActivate
                                                    ? 'Configure ComfyUI paths first (Admin → ComfyUI settings)'
                                                    : w.experimental
                                                        ? 'Activate & serve this workflow (switches to student mode) — it is still experimental, so test it before a class relies on it'
                                                        : 'Activate & serve this workflow (switches to student mode)'}
                                            >
                                                {activatingId === w.id ? <RefreshCw size={13} className="animate-spin" /> : <Power size={13} />}
                                                <span>{activatingId === w.id ? 'Activating…' : 'Activate & serve'}</span>
                                            </button>
                                        )
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
            )}

            {selectedWorkflow && selectedWorkflow.metadata?.presets && Object.keys(selectedWorkflow.metadata.presets).length > 0 && (
                <Card className="mt-4 border-primary/30">
                    <div className="flex items-center gap-2 mb-3">
                        <Sparkles size={16} className="text-primary" />
                        <span className="font-medium text-sm">Quick Presets</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {Object.entries(selectedWorkflow.metadata.presets).map(([name, preset]) => (
                            <button
                                key={name}
                                onClick={() => handlePreset(name)}
                                className="px-3 py-1.5 bg-background hover:bg-primary/10 border border-border hover:border-primary/50 rounded-lg text-sm transition-colors"
                                title={preset.description || `Apply ${name} preset`}
                            >
                                {preset.label || name}
                            </button>
                        ))}
                    </div>
                </Card>
            )}
        </div>
    );
};

export default WorkflowSelector;
