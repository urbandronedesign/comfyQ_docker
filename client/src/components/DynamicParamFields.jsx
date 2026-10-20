import React from 'react';
import { Dices } from 'lucide-react';
import MediaCaptureField from './capture/MediaCaptureField';
import MaskDrawField from './capture/MaskDrawField';
import CameraAngleField from './capture/CameraAngleField';
import { IdeogramPromptTools } from './capture/IdeogramComposer';

// A param qualifies as a "seed" if its key or field looks like one. Catches
// both KSampler.seed (Flux1) and RandomNoise.noise_seed (Flux2), plus any
// custom node that exposes a *_seed field.
export const isSeedParam = (key, config) => {
    const k = String(key || '').toLowerCase();
    const f = String(config?.field || '').toLowerCase();
    return k === 'seed' || k.endsWith('_seed')
        || f === 'seed' || f.endsWith('_seed');
};
export const randomSeed = () => Math.floor(Math.random() * 4294967295);

// Strip the upload prefix from a comfy input filename to show the user's
// original name (comfyq_session__<ts>_<rand>__photo.png → photo.png).
export const prettyInputName = (fn) => String(fn || '')
    .replace(/^comfyq_session__\d+_\d+__/, '')
    .replace(/^comfyq__[a-f0-9]+__/i, '');

// DynamicParamFields — the student-facing parameter form, rendered from a
// `parameter_map`. This is the SINGLE source of truth for how exposed parameters
// look to students: the real BookingDialog renders it with live booking state,
// and the admin workflow editor renders it (with throwaway state) as a live
// preview — so the preview can never drift from what students actually see.
//
// Props:
//   paramMap            { [key]: { type, label, default, options, min, max, step,
//                                  disabledWhen, required, order, field } }
//   values              { [key]: currentValue }
//   onValueChange       (key, value) => void
//   mediaPreviews       { [key]: dataURL|serverURL }  (image/video/audio/mask previews)
//   recalledMedia       { [key]: comfyFilename }      (reused-from-a-prior-job badge)
//   mediaChangeHandler  (key) => (file: File) => void
//   mediaRemoveHandler  (key) => () => void
// Snap a number to the bounds its meta declares. Applied on BLUR, never on
// each keystroke — clamping while typing makes a value like 1088 impossible to
// enter (the leading "1" would jump straight to `min`). The server re-applies
// the same rules in _materializeWorkflow; this is the friendly half, not the
// authoritative one.
export const clampToBounds = (raw, config = {}) => {
    const { min, max, step } = config;
    let v = typeof raw === 'number' ? raw : parseFloat(raw);
    if (!Number.isFinite(v)) v = Number.isFinite(config.default) ? config.default : (Number.isFinite(min) ? min : 0);
    // Snap to the step grid before clamping, so a stepped param can only ever
    // hold a value the workflow can actually render (LTX, for one, floors
    // anything off-grid and silently gives you a different resolution).
    if (Number.isFinite(step) && step > 0) {
        const base = Number.isFinite(min) ? min : 0;
        v = base + Math.round((v - base) / step) * step;
        // Kill FP drift from the multiply (0.1-style steps).
        v = Math.round(v * 1e6) / 1e6;
    }
    if (Number.isFinite(min) && v < min) v = min;
    if (Number.isFinite(max) && v > max) v = max;
    return v;
};

// A field is greyed out while its `disabledWhen` toggle holds the given value.
export const isParamDisabled = (config, values = {}) => {
    const dw = config?.disabledWhen;
    return !!dw && values[dw.param] === dw.equals;
};

// Does the booking need an upload for this media param? Media is mandatory
// unless the meta says `required: false`. An optional upload gated by
// `disabledWhen` is needed only while its toggle switches it on (a gate whose
// toggle isn't in the form counts as off) — same rule as the server's
// optionalMedia.js, which stages a placeholder for the ones left empty.
export const isMediaNeeded = (config, values = {}, paramMap = {}) => {
    if (isParamDisabled(config, values)) return false;
    if (config?.required !== false) return true;
    const dw = config.disabledWhen;
    return !!dw && Object.prototype.hasOwnProperty.call(paramMap, dw.param);
};

// Prompt boxes open tall enough for a long prompt and can be dragged taller or
// shorter (vertical resize handle). The height a student drags to is remembered
// in this browser, separately for main and negative prompts, so the next
// booking opens at the same size.
const PROMPT_BOX_HEIGHT = { prompt: 208, negative: 104 };
const promptBoxKey = (kind) => `comfyq.promptBoxHeight.${kind}`;
const readPromptBoxHeight = (kind) => {
    try {
        const h = parseInt(localStorage.getItem(promptBoxKey(kind)), 10);
        if (Number.isFinite(h) && h >= 72 && h <= 2000) return h;
    } catch { /* storage unavailable: use the default */ }
    return PROMPT_BOX_HEIGHT[kind];
};

const PromptTextarea = ({ kind, disabled, value, onChange, placeholder }) => {
    const ref = React.useRef(null);
    const [height] = React.useState(() => readPromptBoxHeight(kind));
    // The resize handle has no event of its own: compare the height when the
    // pointer goes down on the box with the height when it is released.
    const watchResize = () => {
        const before = ref.current?.offsetHeight;
        window.addEventListener('pointerup', () => {
            const after = ref.current?.offsetHeight;
            if (!after || after === before) return;
            try { localStorage.setItem(promptBoxKey(kind), String(after)); } catch { /* per-browser convenience only */ }
        }, { once: true });
    };
    return (
        <textarea
            ref={ref}
            style={{ height }}
            onPointerDown={watchResize}
            disabled={disabled}
            className={`block w-full bg-background border border-border rounded-lg p-3 text-white leading-relaxed focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-colors placeholder:text-muted/50 min-h-[4.5rem] max-h-[70vh] resize-y ${disabled ? 'cursor-not-allowed' : ''}`}
            value={value}
            onChange={onChange}
            placeholder={placeholder}
        />
    );
};

const DynamicParamFields = ({
    paramMap,
    values = {},
    onValueChange,
    mediaPreviews = {},
    recalledMedia = {},
    mediaChangeHandler,
    mediaRemoveHandler,
}) => {
    if (!paramMap) return null;
    const setVal = (key, value) => onValueChange && onValueChange(key, value);
    const noop = () => () => {};
    const onMedia = mediaChangeHandler || noop;
    const onMediaRemove = mediaRemoveHandler || noop;

    const sortedParams = Object.entries(paramMap)
        .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0));

    // A camera widget shows the subject it is orbiting, which is whatever
    // picture this form uploaded — there is exactly one on these bundles.
    const subjectPreview = sortedParams
        .filter(([k, c]) => (c.type === 'image' || c.type === 'mask') && mediaPreviews[k])
        .map(([k]) => mediaPreviews[k])[0] || null;

    return (
        <div className="space-y-4">
            {sortedParams.map(([key, config]) => {
                const label = config.label || key.charAt(0).toUpperCase() + key.slice(1);
                const type = config.type || 'text';

                // Conditional gray-out: a field can declare `disabledWhen`
                // ({ param, equals }) to render disabled while another param
                // (a toggle) holds a given value — e.g. either/or prompt
                // boxes gated by an "Enhance" checkbox.
                const dw = config.disabledWhen;
                const disabled = isParamDisabled(config, values);
                const ctrlLabel = dw && (paramMap[dw.param]?.label || 'the toggle above');
                const disabledNote = disabled && (
                    <span className="text-[10px] font-normal text-muted normal-case">
                        — not used; change “{ctrlLabel}” to use it
                    </span>
                );

                // Mask input — the user paints a region on an uploaded image;
                // MaskDrawField composites it into an RGBA PNG and hands that
                // File up the SAME path as a normal upload.
                if (type === 'mask') {
                    return (
                        <MaskDrawField
                            key={key}
                            paramKey={key}
                            label={label}
                            maxInputEdge={config.maxInputEdge}
                            preview={mediaPreviews[key]}
                            recalledName={recalledMedia[key] ? prettyInputName(recalledMedia[key]) : null}
                            onChange={onMedia(key)}
                            onRemove={onMediaRemove(key)}
                        />
                    );
                }

                // Image / video / audio input — delegated to MediaCaptureField,
                // which renders the file-upload widget (click + drag-and-drop),
                // then applies maxInputEdge resizing for images.
                if (type === 'image' || type === 'video' || type === 'audio' || type === 'model3d') {
                    const field = (
                        <MediaCaptureField
                            key={key}
                            paramKey={key}
                            label={label}
                            type={type}
                            maxInputEdge={config.maxInputEdge}
                            preview={mediaPreviews[key]}
                            recalledName={recalledMedia[key] ? prettyInputName(recalledMedia[key]) : null}
                            onChange={onMedia(key)}
                            onRemove={onMediaRemove(key)}
                        />
                    );
                    if (!disabled) return field;
                    return (
                        <div key={key} className="space-y-1">
                            <div className="opacity-50 pointer-events-none" aria-disabled="true">{field}</div>
                            <p className="text-[11px] text-muted italic ml-1">
                                Not used right now — change “{ctrlLabel}” to add one
                            </p>
                        </div>
                    );
                }

                // Camera position — one control writing several graph fields
                // (three numbers on a CameraAngle node, or the nearest label in
                // this bundle's own angle dropdowns). See utils/cameraAngle.js.
                if (type === 'camera') {
                    return (
                        <CameraAngleField
                            key={key}
                            paramKey={key}
                            label={label}
                            config={config}
                            value={values[key]}
                            previewUrl={subjectPreview}
                            disabled={disabled}
                            onChange={(v) => setVal(key, v)}
                        />
                    );
                }

                // Select / LoRA-picker Input. A `lora` param is a select whose
                // options are populated server-side (installed LoRAs, filtered to
                // the compatible family) with optional prettified `optionLabels`.
                if ((type === 'select' || type === 'lora') && config.options) {
                    const opts = config.options;
                    const labels = config.optionLabels || [];
                    const empty = opts.length === 0;
                    return (
                        <div key={key} className={`space-y-1.5 ${disabled ? 'opacity-50' : ''}`}>
                            <label className="text-sm font-medium text-slate-300 flex items-center gap-2 flex-wrap">{label}{disabledNote}</label>
                            <select
                                disabled={empty || disabled}
                                className="w-full bg-background border border-border rounded-lg p-2.5 text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all appearance-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                                value={values[key] || ''}
                                onChange={(e) => setVal(key, e.target.value)}
                            >
                                {empty && <option value="">{type === 'lora' ? 'No compatible LoRAs found' : '—'}</option>}
                                {opts.map((opt, i) => (
                                    <option key={opt} value={opt}>{labels[i] || opt}</option>
                                ))}
                            </select>
                        </div>
                    );
                }

                // Checkbox / toggle Input
                if (type === 'checkbox') {
                    const checked = !!values[key];
                    return (
                        <label key={key} className={`flex items-center gap-3 select-none py-1 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={checked}
                                disabled={disabled}
                                onClick={() => setVal(key, !checked)}
                                className={`relative w-10 h-6 rounded-full transition-colors shrink-0 disabled:cursor-not-allowed ${checked ? 'bg-primary' : 'bg-surface border border-border'}`}
                            >
                                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-on-primary shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
                            </button>
                            <span className="text-sm font-medium text-slate-300 flex items-center gap-2 flex-wrap">{label}{disabledNote}</span>
                        </label>
                    );
                }

                // Textarea Input. A prompt whose meta declares
                // `format: "ideogram4-caption"` also gets the visual composer and
                // a live check of Ideogram's JSON format underneath.
                if (type === 'textarea' || key === 'prompt') {
                    const ideogram = config.format === 'ideogram4-caption';
                    const aspectKey = ideogram
                        ? Object.keys(paramMap).find(k => paramMap[k]?.field === 'aspect_ratio')
                        : null;
                    return (
                        <div key={key} className={`space-y-1.5 ${disabled ? 'opacity-50' : ''}`}>
                            <label className="text-sm font-medium text-slate-300 flex items-center gap-2 flex-wrap">
                                {label}
                                {disabled && (
                                    <span className="text-[10px] font-normal text-muted normal-case">
                                        — disabled; change “{ctrlLabel}” to edit
                                    </span>
                                )}
                            </label>
                            <PromptTextarea
                                kind={/negative/i.test(`${key} ${label}`) ? 'negative' : 'prompt'}
                                disabled={disabled}
                                value={values[key] || ''}
                                onChange={(e) => setVal(key, e.target.value)}
                                placeholder={`Enter ${label}...`}
                            />
                            {ideogram && (
                                <IdeogramPromptTools
                                    value={values[key] || ''}
                                    onChange={(v) => setVal(key, v)}
                                    disabled={disabled}
                                    label={label}
                                    aspectOption={aspectKey ? (values[aspectKey] ?? paramMap[aspectKey]?.default) : null}
                                />
                            )}
                        </div>
                    );
                }

                // Seed Input — auto-randomized; re-roll button; user can type a specific value
                if (isSeedParam(key, config)) {
                    return (
                        <div key={key} className="space-y-1.5">
                            <label className="text-sm font-medium text-slate-300">{label}</label>
                            <div className="flex items-center gap-2">
                                <input
                                    type="number"
                                    className="flex-1 bg-background border border-border rounded-lg p-2.5 text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                                    value={values[key] ?? ''}
                                    onChange={(e) => {
                                        const v = e.target.value;
                                        setVal(key, v === '' ? '' : parseInt(v, 10) || 0);
                                    }}
                                />
                                <button
                                    type="button"
                                    onClick={() => setVal(key, randomSeed())}
                                    className="p-2.5 rounded-lg bg-surface border border-border hover:bg-white/5 text-muted hover:text-primary transition-colors"
                                    title="Randomize seed"
                                >
                                    <Dices size={18} />
                                </button>
                            </div>
                            <p className="text-[10px] text-muted ml-1">Auto-randomized each time. Click the dice to re-roll, or type a specific value.</p>
                        </div>
                    );
                }

                // Default Input (Text/Number)
                return (
                    <div key={key} className={`space-y-1.5 ${disabled ? 'opacity-50' : ''}`}>
                        <label className="text-sm font-medium text-slate-300 flex items-center gap-2 flex-wrap">{label}{disabledNote}</label>
                        <input
                            type={type === 'number' ? 'number' : 'text'}
                            disabled={disabled}
                            min={type === 'number' && Number.isFinite(config.min) ? config.min : undefined}
                            max={type === 'number' && Number.isFinite(config.max) ? config.max : undefined}
                            step={type === 'number' && Number.isFinite(config.step) ? config.step : undefined}
                            className="w-full bg-background border border-border rounded-lg p-2.5 text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all disabled:cursor-not-allowed"
                            value={values[key] ?? ''}
                            onChange={(e) => {
                                if (type !== 'number') return setVal(key, e.target.value);
                                // Keep the raw number while typing; bounds are
                                // applied on blur (see clampToBounds).
                                const raw = e.target.value;
                                const n = parseFloat(raw);
                                setVal(key, raw === '' || !Number.isFinite(n) ? '' : n);
                            }}
                            onBlur={() => { if (type === 'number') setVal(key, clampToBounds(values[key], config)); }}
                        />
                        {type === 'number' && (Number.isFinite(config.min) || Number.isFinite(config.max) || Number.isFinite(config.step)) && (
                            <p className="text-[10px] text-muted ml-1">
                                {[
                                    Number.isFinite(config.min) && Number.isFinite(config.max) ? `${config.min}–${config.max}` : null,
                                    Number.isFinite(config.min) && !Number.isFinite(config.max) ? `min ${config.min}` : null,
                                    !Number.isFinite(config.min) && Number.isFinite(config.max) ? `max ${config.max}` : null,
                                    Number.isFinite(config.step) && config.step !== 1 ? `steps of ${config.step}` : null,
                                ].filter(Boolean).join(' · ')}
                            </p>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

export default DynamicParamFields;
