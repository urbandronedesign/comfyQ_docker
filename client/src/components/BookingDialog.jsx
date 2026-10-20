import React, { useState, useEffect, useRef } from 'react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import { Sparkles, Layers, Maximize, Clock, AlertTriangle, ChevronLeft, ChevronRight, Upload, X, Image as ImageIcon, Video as VideoIcon, Info } from 'lucide-react';
import { useSocket } from '../context/SocketContext';
import { SERVER_URL, getInputUrl } from '../utils/api';
import { accessHeaders } from '../utils/access';
import DynamicParamFields, { isSeedParam, randomSeed, isMediaNeeded } from './DynamicParamFields';
import PromptGuideLinks from './PromptGuideLinks';
import { acquireIdleHold } from '../utils/idleHold';

// Param types whose value is an uploaded file (handled via mediaFiles + /upload
// + recall), as opposed to a plain form value. 'mask' is an image the user
// paints in-browser (MaskDrawField) but is otherwise an image upload.
const MEDIA_TYPES = ['image', 'video', 'audio', 'mask', 'model3d'];

/**
 * Booking Dialog Component
 * 
 * A modal form for users to schedule new jobs.
 * 
 * Features:
 * - Dynamic form generation based on workflow configuration
 * - Drag-and-drop media uploads (images, videos)
 * - Time slot selection with collision detection
 * - Client-side validation
 * 
 * @param {Object} props
 * @param {boolean} props.isOpen - Visibility state
 * @param {Function} props.onClose - Close handler
 * @param {number} props.initialTime - Default start time for the job
 * @param {Function} props.onConfirm - Submit handler ({ prompt, params, time })
 */
// Pick the user-visible "headline" prompt out of the submitted form values.
// Workflows expose their text inputs under different keys (`prompt`,
// `positive_prompt`, `text`, etc.) — we look for the most prompt-like
// textarea-typed param and return its current value, falling back to a
// looser match if no parameterMap is available.
function pickHeadlinePrompt(finalParams, parameterMap = {}) {
    // 1. Literal `prompt` key wins if filled — old behavior, preserved.
    if (typeof finalParams.prompt === 'string' && finalParams.prompt.trim()) {
        return finalParams.prompt;
    }
    // 2. Prefer textarea-typed params, skipping anything that smells negative.
    const score = (k) => (/positive/i.test(k) ? 0 : /prompt/i.test(k) ? 1 : 2);
    const textareaKeys = Object.entries(parameterMap || {})
        .filter(([, p]) => p?.type === 'textarea')
        .map(([k]) => k)
        .filter(k => !/negative|neg/i.test(k))
        .sort((a, b) => score(a) - score(b));
    for (const k of textareaKeys) {
        const v = finalParams[k];
        if (typeof v === 'string' && v.trim()) return v;
    }
    // 3. Fallback — no parameterMap or no textarea typed param matched.
    //    Scan finalParams for anything prompt-shaped.
    for (const [k, v] of Object.entries(finalParams)) {
        if (typeof v === 'string' && v.trim() && /prompt|^text$/i.test(k) && !/negative|neg/i.test(k)) {
            return v;
        }
    }
    return '';
}

// isSeedParam / randomSeed / prettyInputName now live in DynamicParamFields.jsx
// (the shared field renderer). isSeedParam + randomSeed are imported above for
// the form-init effect; the field rendering itself uses the shared component.

// A recalled (or default) dropdown value the workflow no longer offers would
// display as the first option while submitting something else, so snap it to a
// value that is actually in the list.
const normalizeChoice = (value, config) => {
    const opts = config?.options;
    if (!Array.isArray(opts) || opts.length === 0) return value;
    if (opts.includes(value)) return value;
    if (opts.includes(config.default)) return config.default;
    return opts[0];
};

const BookingDialog = ({ isOpen, onClose, initialTime, onConfirm, initialParams }) => {
    // While this form is open it may hold an upload, a painted mask or a long
    // prompt nobody has sent yet: the tab must not park itself or reload
    // because the machine switched workflow.
    useEffect(() => {
        if (!isOpen) return undefined;
        return acquireIdleHold();
    }, [isOpen]);

    const { state } = useSocket();
    // This machine may be serving several workflows in parallel, each in its
    // own lane, but a tab books exactly ONE of them — whichever its URL names
    // (?workflow=…, how the fleet monitor opens it), else the primary lane.
    // The model is chosen before the tab opens, not inside the form.
    const lanes = state.lanes || [];
    const { scopedWorkflowId } = useSocket();
    const activeWorkflowId = state.workflow_info?.id || null;
    const selectedLane = lanes.find(l => l.workflow_id === scopedWorkflowId)
        || lanes.find(l => l.workflow_id === activeWorkflowId)
        || (lanes.length === 1 ? lanes[0] : null);
    const paramMap = (selectedLane ? selectedLane.parameter_map : state.workflow?.parameter_map) || null;
    const workflowId = selectedLane ? selectedLane.workflow_id : activeWorkflowId;
    // Name / description / guides for whichever lane is selected.
    const wfInfo = selectedLane
        ? {
            id: selectedLane.workflow_id, name: selectedLane.name,
            description: selectedLane.description, category: selectedLane.category,
            promptGuides: selectedLane.promptGuides,
        }
        : state.workflow_info;
    const [scheduledTime, setScheduledTime] = useState(initialTime);
    const [isCollision, setIsCollision] = useState(false);
    const [formParams, setFormParams] = useState({});
    const [mediaFiles, setMediaFiles] = useState({}); // { paramKey: File }
    const [mediaPreviews, setMediaPreviews] = useState({}); // { paramKey: blob/server URL }
    const [recalledMedia, setRecalledMedia] = useState({}); // { paramKey: comfyFilename } reused from a prior job
    const [isUploading, setIsUploading] = useState(false);
    const [uploadError, setUploadError] = useState(''); // server-side upload rejection (too big / HEIC)
    const [recallNote, setRecallNote] = useState('');   // a reused file that is no longer on the machine
    const submitting = useRef(false);                   // one booking per click

    // Preview URLs we created, revoked when replaced / on close, so a recalled
    // 200 MB video isn't held in memory for the rest of the session.
    const objectUrls = useRef(new Set());
    const revokePreviews = () => {
        for (const u of objectUrls.current) URL.revokeObjectURL(u);
        objectUrls.current.clear();
    };
    useEffect(() => revokePreviews, []);

    // Which workflow the form has been filled in for, during this opening.
    // Cleared on close so the next opening fills again.
    const filledFor = useRef(null);
    const initialTimeRef = useRef(initialTime);
    useEffect(() => { initialTimeRef.current = initialTime; }, [initialTime]);

    // Fill the form: on opening, and again if the parameter_map only arrives
    // afterwards (dialog opened before the first broadcast — the form used to
    // stay empty) or the admin switches the served workflow while it is open.
    // Re-running on an unchanged map can't happen: mergeState keeps its
    // identity across broadcasts, and `filledFor` guards the rest, so nothing
    // the user typed gets wiped.
    useEffect(() => {
        if (!isOpen) { filledFor.current = null; return; }
        if (!paramMap) return;
        if (filledFor.current === workflowId) return;
        // Refilled while open because the machine switched workflow: say so,
        // otherwise the form appears to reset itself for no reason.
        const switched = filledFor.current !== null && filledFor.current !== workflowId;
        filledFor.current = workflowId;

        const next = {};
        const recalledM = {};
        Object.entries(paramMap).forEach(([key, config]) => {
            const recalled = initialParams?.[key];
            const isMedia = MEDIA_TYPES.includes(config.type);
            if (isMedia) {
                // Recall path for media: reuse the asset the recalled job used.
                // Its uploaded filename is still in ComfyUI/input (session uploads
                // aren't TTL-swept), so the new job can reference it directly —
                // no re-upload needed. The user can still Replace it.
                if (typeof recalled === 'string' && recalled) recalledM[key] = recalled;
            } else if (recalled !== undefined) {
                next[key] = normalizeChoice(recalled, config);
            } else if (isSeedParam(key, config)) {
                next[key] = randomSeed();
            } else {
                next[key] = normalizeChoice(config.default !== undefined ? config.default : '', config);
            }
        });
        // Show the reused asset right away: its file is still served from
        // ComfyUI/input, so we point the preview at it (image renders, video/
        // audio play) instead of leaving the field empty.
        const recalledPreviews = {};
        Object.entries(recalledM).forEach(([k, fn]) => { recalledPreviews[k] = getInputUrl(fn); });
        revokePreviews();
        setFormParams(next);
        setRecalledMedia(recalledM);
        setMediaFiles({});
        setMediaPreviews(recalledPreviews);
        setUploadError('');
        setRecallNote(switched
            ? `This machine switched to “${state.workflow_info?.name || workflowId}” — the form was rebuilt with its settings.`
            : '');
        setScheduledTime(initialTimeRef.current);

        // A reused file can be gone (a storyboard's chained frame is swept after
        // a day, or the input folder was cleared). Drop those fields and say so,
        // instead of booking a job that fails in ComfyUI.
        const reused = Object.entries(recalledM);
        if (reused.length === 0) return;
        const ac = new AbortController();
        (async () => {
            const missing = [];
            await Promise.all(reused.map(async ([key, fn]) => {
                try {
                    const r = await fetch(getInputUrl(fn), { method: 'HEAD', signal: ac.signal, headers: accessHeaders() });
                    if (!r.ok) missing.push(key);
                } catch { /* aborted or offline — leave it; submit-time check still guards */ }
            }));
            if (ac.signal.aborted || missing.length === 0) return;
            const drop = (obj) => {
                const n = { ...obj };
                for (const k of missing) delete n[k];
                return n;
            };
            setRecalledMedia(drop);
            setMediaPreviews(drop);
            setRecallNote(`${missing.map(k => paramMap[k]?.label || k).join(' · ')}: the file used before is no longer on this machine — please add it again.`);
        })();
        return () => ac.abort();
    }, [isOpen, initialParams, paramMap, workflowId]);

    useEffect(() => {
        setScheduledTime(initialTime);
    }, [initialTime]);

    /**
     * Collision Detection Effect
     * 
     * Checks if the selected time slot overlaps with any existing jobs.
     * Uses the global job state and benchmark duration to calculate start/end times.
     */
    useEffect(() => {
        // ASAP mode (no slot picked) can't collide — the server queues it next.
        if (!scheduledTime) { setIsCollision(false); return; }

        const duration = state.benchmark_ms || 30000;
        const endTime = scheduledTime + duration;

        // Only this lane's jobs can be in the way: another lane runs its own
        // workflow on its own ComfyUI, beside this one (the server applies the
        // same rule when it books).
        const collision = state.jobs.some(job => {
            if (workflowId && job.workflow_id && job.workflow_id !== workflowId) return false;
            const jobStart = job.time_slot;
            const jobEnd = jobStart + duration;
            // Check for overlap: (StartA < EndB) and (EndA > StartB)
            return (scheduledTime < jobEnd) && (endTime > jobStart);
        });

        setIsCollision(collision);
    }, [scheduledTime, state.jobs, state.benchmark_ms, workflowId]);

    const resolutions = [
        { label: 'Square (1024x1024)', value: '1024x1024' },
        { label: 'Portrait (832x1216)', value: '832x1216' },
        { label: 'Landscape (1216x832)', value: '1216x832' },
        { label: 'Smartphone (768x1344)', value: '768x1344' },
        { label: 'Cinematic (1408x768)', value: '1408x768' },
    ];

    const handleSubmit = async (e) => {
        e.preventDefault();

        if (isCollision || isUploading || submitting.current) return;
        submitting.current = true;
        try {
            await submitBooking();
        } finally {
            submitting.current = false;
        }
    };

    const submitBooking = async () => {

        // Check for the media uploads this booking needs (optional ones only
        // while their toggle switches them on) and say which are missing —
        // returning silently leaves the Start button looking broken.
        const map = paramMap || {};
        const missingMedia = Object.entries(map)
            .filter(([, v]) => MEDIA_TYPES.includes(v.type) && isMediaNeeded(v, formParams, map))
            .filter(([key]) => !mediaFiles[key] && !recalledMedia[key]);
        if (missingMedia.length > 0) {
            setUploadError(`Please add: ${missingMedia.map(([key, v]) => v.label || key).join(' · ')}`);
            return;
        }

        setIsUploading(true);
        setUploadError('');
        const uploadedFilenames = {};

        // Upload all media files
        for (const [key, file] of Object.entries(mediaFiles)) {
            const formData = new FormData();
            formData.append('file', file); // Use 'file' as per updated server route
            const fieldLabel = paramMap?.[key]?.label || key;

            try {
                const response = await fetch(`${SERVER_URL}/upload`, {
                    method: 'POST',
                    headers: accessHeaders(),   // no-op unless the machine is locked
                    body: formData,
                });
                // The server caps image size/dimensions and rejects HEIC; surface
                // its message instead of submitting a job with a missing input.
                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    setUploadError(`${fieldLabel}: ${data.error || 'upload was rejected by the server.'}`);
                    setIsUploading(false);
                    return;
                }
                const data = await response.json();
                uploadedFilenames[key] = data.filename;
            } catch (error) {
                console.error(`Upload failed for ${key}:`, error);
                setUploadError(`${fieldLabel}: upload failed — check your connection and try again.`);
                setIsUploading(false);
                return;
            }
        }

        // Prepare final params. recalledMedia carries comfy filenames reused
        // from a prior job (no re-upload); a freshly uploaded file for the same
        // key overrides it.
        const finalParams = { ...formParams, ...recalledMedia, ...uploadedFilenames };

        // Pick the user-visible "headline" prompt. Workflows expose textarea
        // inputs under different keys — `prompt` for Flux, `positive_prompt`
        // for LTX i2v, `text` for some primitive-fallback parses. The server
        // stores ONE field for the cards / lightbox / search, so surface the
        // value the user actually typed regardless of its key.
        const headlinePrompt = pickHeadlinePrompt(finalParams, paramMap);

        // Wait for the server to confirm. On a refusal (slot taken, connection
        // lost…) the dialog stays open with everything the student entered.
        const result = await onConfirm({
            prompt: headlinePrompt,
            params: finalParams,
            time: scheduledTime,
            // Which lane runs it. The server falls back to the active
            // workflow when this is absent (single-lane machines).
            workflowId: workflowId || undefined,
        });
        setIsUploading(false);
        if (result && result.ok === false) {
            setUploadError(result.error || 'The booking did not go through. Please try again.');
            // Files already uploaded are reused on retry instead of sent twice.
            setRecalledMedia(prev => ({ ...prev, ...uploadedFilenames }));
            setMediaFiles({});
            return;
        }
        onClose();
        setMediaFiles({});
        revokePreviews();
        setMediaPreviews({});
    };

    // Release a preview URL we created for this field (server URLs aren't ours).
    const dropPreviewUrl = (url) => {
        if (url && objectUrls.current.has(url)) {
            URL.revokeObjectURL(url);
            objectUrls.current.delete(url);
        }
    };

    const handleMediaRemove = (paramKey) => () => {
        setMediaFiles(prev => {
            const newFiles = { ...prev };
            delete newFiles[paramKey];
            return newFiles;
        });
        setMediaPreviews(prev => {
            const newPreviews = { ...prev };
            dropPreviewUrl(newPreviews[paramKey]);
            delete newPreviews[paramKey];
            return newPreviews;
        });
        setRecalledMedia(prev => {
            const n = { ...prev };
            delete n[paramKey];
            return n;
        });
    };

    // Called by MediaCaptureField with a (possibly already-resized) File.
    // The component handles the input event + EXIF-aware resize; we just
    // stash the file and generate a preview thumbnail. Resizing means the
    // preview reflects what'll actually be uploaded, not the raw camera shot.
    const handleMediaChange = (paramKey) => (file) => {
        if (!file) return;
        setUploadError('');
        setRecallNote('');
        setMediaFiles(prev => ({ ...prev, [paramKey]: file }));
        // A fresh upload supersedes any recalled (reused) asset for this key.
        setRecalledMedia(prev => {
            const n = { ...prev };
            delete n[paramKey];
            return n;
        });
        // An object URL, not a base64 data URL: reading a phone video into a
        // data URL blocks the tab and keeps ~1.4× the file size in memory.
        const url = URL.createObjectURL(file);
        objectUrls.current.add(url);
        setMediaPreviews(prev => {
            dropPreviewUrl(prev[paramKey]);
            return { ...prev, [paramKey]: url };
        });
    };

    const adjustTime = (minutes) => {
        setScheduledTime(prev => prev + minutes * 60000);
    };

    /**
     * Renders the student-facing parameter form via the shared
     * DynamicParamFields component — the admin editor's live preview renders the
     * same component, so what the admin previews can't drift from what students see.
     */
    const renderDynamicFields = () => (
        <DynamicParamFields
            paramMap={paramMap}
            values={formParams}
            onValueChange={(key, value) => setFormParams(prev => ({ ...prev, [key]: value }))}
            mediaPreviews={mediaPreviews}
            recalledMedia={recalledMedia}
            mediaChangeHandler={handleMediaChange}
            mediaRemoveHandler={handleMediaRemove}
        />
    );

    const handleTimeChange = (e) => {
        const [hours, minutes] = e.target.value.split(':').map(Number);
        const newDate = new Date(scheduledTime);
        newDate.setHours(hours);
        newDate.setMinutes(minutes);
        newDate.setSeconds(0);
        newDate.setMilliseconds(0);
        setScheduledTime(newDate.getTime());
    };

    const timeValue = scheduledTime
        ? new Date(scheduledTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
        : '';

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Book Generation Slot" maxWidth="max-w-2xl">
            <form onSubmit={handleSubmit} className="space-y-6">
                {wfInfo?.id && (wfInfo.description || wfInfo.name) && (
                    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
                        <div className="flex items-center gap-2">
                            <Info size={14} className="text-primary shrink-0" />
                            <span className="text-[10px] uppercase tracking-widest font-bold text-muted">Active workflow</span>
                            <span className="text-sm font-semibold text-foreground">{wfInfo.name}</span>
                            {wfInfo.category && wfInfo.category !== 'other' && (
                                <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                                    {wfInfo.category}
                                </span>
                            )}
                        </div>
                        <PromptGuideLinks guides={wfInfo.promptGuides} />
                        {wfInfo.description && (
                            <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">
                                {wfInfo.description}
                            </p>
                        )}
                    </div>
                )}
                <div className="space-y-4 border-b border-border pb-6">
                    <div className="flex flex-col space-y-3">
                        <label className="text-sm font-medium text-slate-300 flex items-center gap-2">
                            <Clock size={14} className="text-primary" />
                            When to run
                        </label>
                        {/* Segmented toggle — ASAP (no slot) vs a specific time. */}
                        <div className="grid grid-cols-2 gap-1 bg-surface border border-border rounded-lg p-1">
                            <button
                                type="button"
                                onClick={() => setScheduledTime(null)}
                                className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold transition-colors ${!scheduledTime ? 'bg-primary text-on-primary shadow' : 'text-muted hover:text-foreground'}`}
                            >
                                <Sparkles size={13} /> As soon as possible
                            </button>
                            <button
                                type="button"
                                onClick={() => { if (!scheduledTime) setScheduledTime(Date.now()); }}
                                className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold transition-colors ${scheduledTime ? 'bg-primary text-on-primary shadow' : 'text-muted hover:text-foreground'}`}
                            >
                                <Clock size={13} /> Pick a time
                            </button>
                        </div>
                        {scheduledTime ? (
                            <>
                                <div className="flex items-center space-x-2">
                                    <button
                                        type="button"
                                        onClick={() => adjustTime(-1)}
                                        className="p-2 rounded-lg bg-surface border border-border hover:bg-white/5 transition-colors text-muted hover:text-white"
                                    >
                                        <ChevronLeft size={20} />
                                    </button>
                                    <div className="relative flex-1">
                                        <input
                                            type="time"
                                            value={timeValue}
                                            onChange={handleTimeChange}
                                            className="w-full bg-background border border-border rounded-lg p-2.5 text-white font-mono text-center focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                                        />
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => adjustTime(1)}
                                        className="p-2 rounded-lg bg-surface border border-border hover:bg-white/5 transition-colors text-muted hover:text-white"
                                    >
                                        <ChevronRight size={20} />
                                    </button>
                                </div>

                                {isCollision ? (
                                    <div className="flex items-center gap-2 text-danger text-xs font-medium bg-danger/10 p-2.5 rounded-lg border border-danger/20 animate-in fade-in slide-in-from-top-1">
                                        <AlertTriangle size={14} />
                                        This time slot is already taken. Please choose another one.
                                    </div>
                                ) : (
                                    <p className="text-[10px] text-muted uppercase tracking-wider font-semibold ml-1">
                                        Slot is available
                                    </p>
                                )}
                            </>
                        ) : (
                            <p className="text-[11px] text-muted ml-1">
                                Runs as soon as the queue is free — the next open spot.
                            </p>
                        )}
                    </div>
                </div>

                {/* Dynamic Fields Rendering */}
                {/* Dynamic Fields Rendering */}
                {renderDynamicFields()}

                {recallNote && (
                    <div className="flex items-start gap-2 text-amber-500 text-xs font-medium bg-amber-500/10 p-2.5 rounded-lg border border-amber-500/20">
                        <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                        <span>{recallNote}</span>
                    </div>
                )}

                {uploadError && (
                    <div className="flex items-start gap-2 text-danger text-xs font-medium bg-danger/10 p-2.5 rounded-lg border border-danger/20">
                        <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                        <span>{uploadError}</span>
                    </div>
                )}

                <div className="pt-2 flex justify-end space-x-3">
                    <Button variant="ghost" onClick={onClose} type="button">
                        Cancel
                    </Button>
                    <Button
                        variant="primary"
                        type="submit"
                        icon={Sparkles}
                        disabled={isCollision || isUploading}
                    >
                        {isUploading ? 'Booking…' : scheduledTime ? 'Book Slot' : 'Start ASAP'}
                    </Button>
                </div>
            </form>
        </Modal>
    );
};

export default BookingDialog;
