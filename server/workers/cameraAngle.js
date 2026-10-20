// A camera POSITION, written into whatever fields a workflow uses to say it.
//
// Two bundles describe the same thing in different vocabularies. ComfyUI's own
// `CameraAngle` node takes three numbers (azimuth / elevation / zoom) and turns
// them into a plain-English shot description itself. The Qwen-Image-2.1 angles
// bundle instead has two string dropdowns — 12 compass positions and 4 heights
// with a close-up variant — and no numbers anywhere.
//
// ★ So the student-facing control is the same in both (place the camera), and
// what differs is only HOW the placement is spelled for that graph. That
// spelling is DECLARED IN THE META, not hardcoded here: a target either writes
// the raw number, or buckets it into a list of labels the meta supplies. The
// booking widget reads those same declared buckets off the wire, so the phrase
// it shows a student and the value the graph receives come from one source.
//
// ⚠ Where the graph does its OWN bucketing (CameraAngle), the meta's `phrase`
// block is a MIRROR of comfy_extras/nodes_camera_angle.py, kept so the widget
// can show what the node will say. It is a preview, not the authority — if
// ComfyUI rewords a term, the preview is stale and the render is still right.

const AXES = ['horizontal', 'vertical', 'zoom'];

// The widget's own limits when a bundle does not narrow them. These are
// CameraAngle's: azimuth all the way round, elevation from a little below eye
// level to steeply above, zoom 0 (wide) .. 10 (close-up).
const DEFAULT_AXES = {
    horizontal: { min: 0, max: 360, step: 1, default: 0, wrap: true },
    vertical: { min: -30, max: 60, step: 1, default: 0 },
    zoom: { min: 0, max: 10, step: 0.1, default: 5 },
};

function axisSpec(spec, axis) {
    return { ...DEFAULT_AXES[axis], ...((spec && spec.axes && spec.axes[axis]) || {}) };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Read a camera value off the wire. Tolerant on purpose: the value survives a
 * database round trip, a "Use these settings" recall and a hand-edited meta, and
 * a camera that cannot be parsed must fall back to the bundle's own default
 * rather than fail a booking.
 */
function parseCamera(value, spec) {
    let raw = value;
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch { raw = null; }
    }
    const out = {};
    for (const axis of AXES) {
        const a = axisSpec(spec, axis);
        let v = raw && typeof raw === 'object' ? num(raw[axis]) : undefined;
        if (v === undefined) v = a.default;
        if (a.wrap) {
            // Azimuth is a circle: 370 is 10, -10 is 350. Clamping instead would
            // make a drag past the front stick at the seam.
            const span = a.max - a.min;
            v = span > 0 ? a.min + (((v - a.min) % span) + span) % span : a.min;
        } else {
            v = Math.min(a.max, Math.max(a.min, v));
        }
        out[axis] = v;
    }
    return out;
}

function formatCamera(cam) {
    return JSON.stringify({
        horizontal: Math.round(cam.horizontal),
        vertical: Math.round(cam.vertical),
        zoom: Math.round(cam.zoom * 10) / 10,
    });
}

// Equal sectors around the circle, each CENTRED on its label — so "front view"
// covers the angles either side of 0 rather than starting at it. Matches
// CameraAngle's own `int(((angle % 360) + 22.5) // 45) % 8` for 8 sectors.
function sectorIndex(angle, n) {
    if (!n) return 0;
    const a = ((angle % 360) + 360) % 360;
    return Math.round(a / (360 / n)) % n;
}

// value < thresholds[0] -> 0, < thresholds[1] -> 1, … else the last term.
function thresholdIndex(value, thresholds) {
    const t = Array.isArray(thresholds) ? thresholds : [];
    for (let i = 0; i < t.length; i++) if (value < t[i]) return i;
    return t.length;
}

/**
 * The label one bucketed target (or one phrase part) produces for this camera.
 * Returns undefined for a numeric target, which has no label.
 */
function labelFor(part, cam) {
    if (!part) return undefined;
    const v = cam[part.axis];
    if (v === undefined) return undefined;
    let label;
    if (Array.isArray(part.sectors) && part.sectors.length) {
        label = part.sectors[sectorIndex(v, part.sectors.length)];
    } else if (Array.isArray(part.terms) && part.terms.length) {
        label = part.terms[Math.min(part.terms.length - 1, thresholdIndex(v, part.thresholds))];
    } else {
        return undefined;
    }
    // "elevated shot" + " close-up": the 2.1 bundle's list is 4 heights times a
    // close-up variant, which is a second axis folded into one dropdown.
    const s = part.suffixWhen;
    if (s && typeof s.suffix === 'string' && cam[s.axis] !== undefined && cam[s.axis] >= s.min) label += s.suffix;
    return label;
}

/**
 * What this camera writes into the graph: one entry per declared target.
 * A target with `sectors`/`terms` writes its label; one without writes the
 * number, rounded the way its field expects (ints for angles).
 */
function resolveTargets(spec, cam, defaultNodeId) {
    const out = [];
    for (const t of (spec && spec.targets) || []) {
        if (!t || !t.field) continue;
        const nodeId = t.nodeId || defaultNodeId;
        if (!nodeId) continue;
        const label = labelFor(t, cam);
        let value;
        if (label !== undefined) {
            value = label;
        } else {
            const v = cam[t.axis];
            if (v === undefined) continue;
            const step = axisSpec(spec, t.axis).step;
            value = step >= 1 ? Math.round(v) : Math.round(v * 10) / 10;
        }
        out.push({ nodeId, field: t.field, value });
    }
    return out;
}

/** The sentence the graph will build from this camera, for the widget to show. */
function describe(spec, cam) {
    const parts = (spec && spec.phrase) || (spec && spec.targets) || [];
    return parts.map(p => labelFor(p, cam)).filter(Boolean).join(' ');
}

/** Write a camera param into a materialized graph. Returns how many fields it set. */
function applyCamera(wf, param, value) {
    const spec = param && param.camera;
    if (!spec) return 0;
    const cam = parseCamera(value === undefined || value === null || value === '' ? param.default : value, spec);
    let set = 0;
    for (const t of resolveTargets(spec, cam, param.nodeId)) {
        const node = wf[t.nodeId];
        if (!node) continue;
        node.inputs = node.inputs || {};
        node.inputs[t.field] = t.value;
        set++;
    }
    return set;
}

module.exports = {
    AXES, DEFAULT_AXES, axisSpec,
    parseCamera, formatCamera, sectorIndex, thresholdIndex,
    labelFor, resolveTargets, describe, applyCamera,
};
