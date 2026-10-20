// Camera placement, client side.
//
// ⚠ This mirrors server/workers/cameraAngle.js. The DATA it works from — the
// axis ranges, the sector lists, the thresholds — is declared once in the
// bundle's meta and arrives on the wire, so only the bucket arithmetic is
// duplicated. Both copies are pinned to the SAME fixture generated from
// ComfyUI's own `describe_camera_angle` (cameraAngle.test.mjs here,
// cameraAngle.test.js on the server), so neither can drift from the node that
// actually runs without a test going red.

export const AXES = ['horizontal', 'vertical', 'zoom'];

export const DEFAULT_AXES = {
    horizontal: { min: 0, max: 360, step: 1, default: 0, wrap: true },
    vertical: { min: -30, max: 60, step: 1, default: 0 },
    zoom: { min: 0, max: 10, step: 0.1, default: 5 },
};

export function axisSpec(spec, axis) {
    return { ...DEFAULT_AXES[axis], ...((spec && spec.axes && spec.axes[axis]) || {}) };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function parseCamera(value, spec) {
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
            const span = a.max - a.min;
            v = span > 0 ? a.min + (((v - a.min) % span) + span) % span : a.min;
        } else {
            v = Math.min(a.max, Math.max(a.min, v));
        }
        out[axis] = v;
    }
    return out;
}

export function formatCamera(cam) {
    return JSON.stringify({
        horizontal: Math.round(cam.horizontal),
        vertical: Math.round(cam.vertical),
        zoom: Math.round(cam.zoom * 10) / 10,
    });
}

export function sectorIndex(angle, n) {
    if (!n) return 0;
    const a = ((angle % 360) + 360) % 360;
    return Math.round(a / (360 / n)) % n;
}

export function thresholdIndex(value, thresholds) {
    const t = Array.isArray(thresholds) ? thresholds : [];
    for (let i = 0; i < t.length; i++) if (value < t[i]) return i;
    return t.length;
}

export function labelFor(part, cam) {
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
    const s = part.suffixWhen;
    if (s && typeof s.suffix === 'string' && cam[s.axis] !== undefined && cam[s.axis] >= s.min) label += s.suffix;
    return label;
}

/** The parts of the sentence the graph will build, for the readout. */
export function describeParts(spec, cam) {
    const parts = (spec && spec.phrase) || (spec && spec.targets) || [];
    return parts.map(p => labelFor(p, cam)).filter(Boolean);
}

export function describe(spec, cam) {
    return describeParts(spec, cam).join(' ');
}

// The scene CameraAngle itself describes: a unit subject at the origin, the
// camera on a sphere of radius 6 with a 35° lens. Mirrored so the preview puts
// the gizmo exactly where the node's camera_info would.
export const SUBJECT_DISTANCE = 6;
export const CAMERA_FOV = 35;

export function cameraPosition(cam, distance = SUBJECT_DISTANCE) {
    const yaw = (cam.horizontal * Math.PI) / 180;
    const pitch = (cam.vertical * Math.PI) / 180;
    return {
        x: distance * Math.cos(pitch) * Math.sin(yaw),
        y: distance * Math.sin(pitch),
        z: distance * Math.cos(pitch) * Math.cos(yaw),
    };
}
