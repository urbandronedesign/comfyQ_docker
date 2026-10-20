// Primitive-fallback workflow parser. Walks every node in an API-format
// workflow and surfaces every primitive (string/number/boolean) input field
// as a candidate exposed parameter. No class_type whitelist — this lets new
// node types (Flux2, LTX, depth preprocessors, audio loaders, custom LoRAs)
// be configured without code changes.

const PROMPT_FIELD_HINTS = ['text', 'prompt', 'positive', 'negative', 'caption'];
const SAMPLER_FIELD = 'sampler_name';
const SCHEDULER_FIELD = 'scheduler';

const COMMON_OPTIONS = {
    sampler_name: [
        'euler', 'euler_ancestral', 'heun', 'dpm_2', 'dpm_2_ancestral',
        'lms', 'dpm_fast', 'dpm_adaptive', 'dpmpp_2s_ancestral', 'dpmpp_sde',
        'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_3m_sde', 'ddim', 'uni_pc', 'uni_pc_bh2'
    ],
    scheduler: [
        'normal', 'karras', 'exponential', 'sgm_uniform', 'simple',
        'ddim_uniform', 'beta'
    ]
};

function isPrimitive(v) {
    return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function inferType(field, value) {
    const f = field.toLowerCase();
    // Exact match, not `f.includes('model')`: half the loaders in the library
    // have a `model`-ish field naming a WEIGHT file, which is infrastructure.
    // `model_file` is the Load3D / Load3DAdvanced mesh input and nothing else.
    if (field === 'model_file') return 'model3d';
    if (f.includes('mask')) return 'mask';
    if (f.includes('image')) return 'image';
    if (f.includes('video')) return 'video';
    if (f.includes('audio')) return 'audio';
    if (field === SAMPLER_FIELD || field === SCHEDULER_FIELD) return 'select';
    if (typeof value === 'boolean') return 'checkbox';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'string') {
        if (PROMPT_FIELD_HINTS.some(h => f.includes(h)) || value.length > 60) return 'textarea';
        return 'text';
    }
    return 'text';
}

function humanizeLabel(field, nodeTitle) {
    const pretty = field
        .replace(/[_\-]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim();
    return nodeTitle ? `${pretty} (${nodeTitle})` : pretty;
}

function makeKey(nodeType, field, nodeId) {
    return `${nodeType}_${field}_${nodeId}`
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_');
}

// Returns { parameters: ExposedParameter[], nodeCount, primitiveCount }
function parseWorkflow(apiWorkflow) {
    const parameters = [];
    let order = 0;
    let primitiveCount = 0;

    for (const [nodeId, node] of Object.entries(apiWorkflow)) {
        if (!node || typeof node !== 'object') continue;
        const nodeType = node.class_type || 'Unknown';
        const nodeTitle = node._meta?.title || nodeType;
        const inputs = node.inputs || {};

        for (const [field, value] of Object.entries(inputs)) {
            if (!isPrimitive(value)) continue;
            primitiveCount++;
            const type = inferType(field, value);
            parameters.push({
                key: makeKey(nodeType, field, nodeId),
                nodeId,
                field,
                type,
                label: humanizeLabel(field, nodeTitle),
                // Node identity, surfaced to the admin editor for display + search
                // (lets you cross-reference a param against the ComfyUI graph by
                // the node's title / class). Not persisted into exposedParameters.
                nodeTitle,
                classType: nodeType,
                default: value,
                options: COMMON_OPTIONS[field],
                required: ['image', 'video', 'audio', 'mask', 'model3d'].includes(type),
                order: order++
            });
        }
    }

    return {
        parameters,
        nodeCount: Object.keys(apiWorkflow).length,
        primitiveCount
    };
}

// Convert ExposedParameter[] into the wire-compat parameter_map shape that
// BookingDialog already understands: { [key]: { node_id, field, type, label,
// default, enabled, order, options? } }. Only `enabled: true` parameters
// appear in the final map.
function toParameterMap(exposedParameters) {
    const out = {};
    for (const p of exposedParameters) {
        out[p.key] = {
            node_id: p.nodeId,
            field: p.field,
            type: p.type,
            label: p.label,
            default: p.default,
            enabled: true,
            order: p.order,
            options: p.options,
            min: p.min,
            max: p.max,
            step: p.step,
            disabledWhen: p.disabledWhen,
            required: p.required
        };
    }
    return out;
}

module.exports = { parseWorkflow, toParameterMap, COMMON_OPTIONS, inferType };
