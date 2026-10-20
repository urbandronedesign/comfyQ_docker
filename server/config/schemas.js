const { z } = require('zod');

const ParamType = z.enum([
    'text', 'textarea', 'number', 'select', 'checkbox',
    'image', 'video', 'audio',
    // 'mask' is an image input whose widget lets the user PAINT a mask onto a
    // base image instead of uploading a finished file. The wire value is still
    // a plain image filename (an RGBA PNG with the painted region transparent),
    // so the materializer / upload / recall / calibration paths treat it exactly
    // like 'image'; only the BookingDialog input widget differs (MaskDrawField).
    'mask',
    // 'lora' is a select whose options are populated SERVER-SIDE at booking time
    // by scanning ComfyUI's model dir (default `models/loras`), optionally
    // filtered to a family via `optionsFilter` (a filename prefix, e.g. `krea2_`)
    // so incompatible LoRAs don't show. The wire value is just the `.safetensors`
    // filename fed to a LoraLoader field, so materialize/recall/calibration treat
    // it like a plain string; only the widget (a dynamic dropdown) differs.
    'lora',
    // 'model3d' is a 3D MESH upload (.glb/.gltf/.obj/.stl/.ply/.fbx) feeding a
    // Load3D/Load3DAdvanced `model_file` field. The wire value is the staged
    // filename in ComfyUI/input, exactly like 'image' -- ComfyUI resolves it
    // with get_annotated_filepath, so a flat name in the input dir is enough
    // and the `3d/` subfolder the node's own dropdown lists is not required.
    // Only the BookingDialog widget differs (no resize, no visual preview).
    'model3d',
    // 'camera' is a camera POSITION -- azimuth, elevation and zoom, placed on an
    // orbit widget instead of typed. Its wire value is a small JSON string, and
    // `camera.targets` says how THIS graph spells a position: either raw numbers
    // into a CameraAngle node, or the nearest label from a list the meta
    // supplies (the 2.1 bundle's 12 compass points). One control, two
    // vocabularies -- see server/workers/cameraAngle.js.
    'camera'
]);

const ExposedParameter = z.object({
    key: z.string().min(1),
    nodeId: z.string().min(1),
    field: z.string().min(1),
    type: ParamType,
    label: z.string().min(1),
    default: z.any().optional(),
    options: z.array(z.string()).optional(),
    // For `lora`-type params: the model subdir to scan (relative to
    // `<comfy root>/models/`, default `loras`) and a case-insensitive filename
    // PREFIX to keep (e.g. `krea2_` → only Krea-compatible LoRAs). The options
    // list is built at booking time by the server, never stored in the meta.
    optionsDir: z.string().optional(),
    optionsFilter: z.string().optional(),
    // For `camera` params: the axes the widget offers and how this graph is
    // told about them. A target without `sectors`/`terms` gets the number.
    camera: z.object({
        axes: z.record(z.object({
            min: z.number().optional(), max: z.number().optional(), step: z.number().optional(),
            default: z.number().optional(), wrap: z.boolean().optional()
        })).optional(),
        targets: z.array(z.object({ nodeId: z.string().optional(), field: z.string(),
            axis: z.string(),
            sectors: z.array(z.string()).optional(),
            terms: z.array(z.string()).optional(),
            thresholds: z.array(z.number()).optional(),
            suffixWhen: z.object({ nodeId: z.string().optional(), field: z.string(), axis: z.string(), min: z.number(), suffix: z.string() }).optional()
        })).optional(),
        phrase: z.array(z.object({
            axis: z.string(),
            sectors: z.array(z.string()).optional(),
            terms: z.array(z.string()).optional(),
            thresholds: z.array(z.number()).optional(),
            suffixWhen: z.object({ axis: z.string(), min: z.number(), suffix: z.string() }).optional()
        })).optional()
    }).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    // For image/video params: longest-edge pixel cap the client applies
    // before upload. Resizing client-side saves LAN bandwidth and matches
    // the workflow's expected working resolution (most diffusion / i2v
    // workflows degrade past 1280–2048 anyway). Undefined → client uses
    // its built-in defaults (1024 for image, 1280 for video).
    maxInputEdge: z.number().int().positive().optional(),
    // Conditional gray-out: this field renders disabled when another exposed
    // param's current value equals `equals`. Used for either/or fields gated by
    // a toggle (e.g. a raw-prompt box vs an LLM-prompt box selected by an
    // "Enhance" checkbox). The disabled field still submits its value — harmless
    // when the workflow's switch ignores the unselected branch.
    disabledWhen: z.object({ param: z.string().min(1), equals: z.any() }).optional(),
    // Other node fields this param's value also sets — e.g. a LoRA dropdown that
    // writes the matching trigger word. `map` is keyed by the chosen value; a
    // value missing from the map writes `fallback` (omit it to leave the graph
    // literal alone). Applied before the exposed params, so an exposed param on
    // the same field still wins.
    linkedValues: z.array(z.object({
        nodeId: z.string().min(1),
        field: z.string().min(1),
        map: z.record(z.string(), z.any()),
        fallback: z.any().optional()
    })).optional(),
    // What kind of text a textarea holds, when that matters to ComfyQ.
    //   ideogram4-caption — Ideogram 4's structured JSON prompt: the booking form
    //   adds the visual composer and a format check, and the worker sends valid
    //   JSON to the model compacted (measured on the rig: the same caption
    //   pretty-printed came back "Image blocked by safety filter").
    format: z.enum(['ideogram4-caption']).optional(),
    // What to do when an optional media param is left empty. The default fills a
    // neutral placeholder, which the graph must hide behind a switch; 'unlink'
    // removes the loader and every link to it, which is what an AUTOGROW
    // reference slot (Qwen 2.1's images.image_N) needs — a placeholder there
    // would be used as a reference picture and change the result.
    whenEmpty: z.enum(['placeholder', 'unlink']).optional(),
    // Node fields to set when this param is left EMPTY, so the graph can take
    // its other branch by itself instead of making the student flip a toggle
    // whose effect they cannot see. Measured case: the Qwen 2.1 edit with no
    // reference pictures must switch its latent from "follow image 1" to an
    // empty latent at the chosen size — otherwise TextEncodeQwenImage21 returns
    // a fixed 1024x1024 (`latent_w = latent_h = resolution or 1024`) and the
    // aspect-ratio field silently does nothing. Applied after `unlink` and
    // before the exposed params, so an exposed param on the same field wins.
    whenEmptySet: z.array(z.object({
        nodeId: z.string().min(1),
        field: z.string().min(1),
        value: z.any()
    })).optional(),
    required: z.boolean().default(false),
    order: z.number().int().default(0)
});

const WorkflowMeta = z.object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().default(''),
    category: z.enum([
        't2i', 'image-edit', 'i2v', 'video-edit', 'i2i',
        'audio', '3d', 'preprocessor', 'description', 'other'
    ]).default('other'),
    tags: z.array(z.string()).default([]),
    // Official prompting guides for the model family, shown to students above
    // the booking form. `tip` is an optional one-line summary of the style.
    promptGuides: z.array(z.object({
        label: z.string().min(1),
        url: z.string().url(),
        tip: z.string().optional()
    })).default([]),
    thumbnail: z.string().nullable().default(null),
    author: z.string().default('Unknown'),
    version: z.string().default('1.0.0'),
    // A bundle that was built but not yet tested by hand. The admin library
    // badges it and offers a one-click "Validate" that clears the flag (written
    // back into meta.json so the decision travels with the bundle). It is purely
    // a label — an experimental workflow can still be calibrated and served.
    experimental: z.boolean().default(false),
    workflowFile: z.string().min(1),
    apiFormat: z.literal(true),
    requirements: z.object({
        minVRAM: z.number().nonnegative().default(0),
        models: z.array(z.object({
            // 'controlnet' added 2026-09-25 for the Qwen 2.1 Fun ControlNet bundles.
            // Adding an enum value is backwards compatible; every existing meta
            // still validates.
            type: z.enum(['unet', 'vae', 'clip', 'lora', 'checkpoint', 'controlnet', 'other']),
            file: z.string(),
            // Where this weight comes from, harvested by tools/model-provenance
            // from the download links the workflows' own notes already carry.
            // `url` is a DIRECT, fetchable file (so a download can be offered);
            // `source` is a page for a human, for when only the repo is known.
            // The distinction is the whole point: a wrong direct link downloads
            // the wrong weights silently.
            url: z.string().url().optional(),
            source: z.string().url().optional(),
            // true when a node pack or pipeline fetches this itself. Such an
            // entry is not a file to look for under models/, so it must never
            // be reported missing and nothing should offer to download it.
            auto: z.boolean().optional(),
            // The models/ subfolder, when neither the link nor `type` says it
            // (a file at a repo's root with type 'other'). Without it a fresh
            // Pod cannot place the file and the whole plan fails.
            dir: z.string().optional(),
            note: z.string().optional()
        })).default([]),
        // Global ComfyUI performance flags this workflow cannot run with (it
        // doesn't crash — it saves black images). The ComfyUI that serves or
        // calibrates it is launched without them; see workers/perfFlags.js.
        disabledPerfFlags: z.array(z.enum(['use_sage_attention', 'fp16_accumulation'])).default([])
    }).default({ minVRAM: 0, models: [], disabledPerfFlags: [] }),
    estimatedDurationSec: z.number().positive().default(60),
    exposedParameters: z.array(ExposedParameter).default([]),
    warmupParams: z.record(z.any()).default({}),
    presets: z.record(z.object({
        label: z.string().optional(),
        description: z.string().optional(),
        values: z.record(z.any()).default({})
    })).default({})
});

const WorkflowConfigMeta = z.object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    parameterOverrides: z.record(z.object({
        label: z.string().optional(),
        default: z.any().optional(),
        enabled: z.boolean().optional(),
        order: z.number().int().optional()
    })).default({}),
    warmupPromptOverride: z.string().optional(),
    hidden: z.boolean().default(false)
});

const AppConfig = z.object({
    schemaVersion: z.literal(2),
    mode: z.enum(['admin', 'student']),
    server: z.object({
        port: z.number().int().positive().default(3000),
        host: z.string().default('0.0.0.0')
    }),
    comfy_ui: z.object({
        installation_type: z.enum(['portable', 'system']).default('system'),
        root_path: z.string().default(''),
        python_executable: z.string().default(''),
        output_dir: z.string().default('output'),
        api_host: z.string().default('127.0.0.1'),
        api_port: z.number().int().positive().default(8188),
        // When true, ComfyUI is bound to 0.0.0.0 (all interfaces) so people
        // on the LAN can open ComfyUI's own web UI directly and run classic
        // workflows on this machine's GPU. ComfyQ itself still talks to it
        // over localhost regardless. Default off — don't expose the raw
        // ComfyUI interface to the network unless an admin opts in.
        lan_access: z.boolean().default(false),
        autoStart: z.boolean().default(true),
        vramBudgetGb: z.number().positive().default(24),
        // Optional ComfyUI performance flags, off by default so an existing rig
        // keeps its exact current behavior. Both are global (they affect every
        // workflow), which is why they're opt-in toggles rather than hardcoded
        // spawn args — flip them back off and restart to rule them out.
        //   use_sage_attention -> --use-sage-attention (needs the sageattention
        //     package + triton; a big win on video models, no-op if unsupported)
        //   fp16_accumulation  -> --fast fp16_accumulation (ComfyUI labels the
        //     --fast family "untested and potentially quality deteriorating",
        //     so we pass ONLY this one feature, never bare --fast)
        use_sage_attention: z.boolean().default(false),
        fp16_accumulation: z.boolean().default(false),
        // ★ A HuggingFace access token, for the gated repos. Eight of this
        // library's download links answer 401 without one (FLUX.2, LTX-2.5),
        // and a token is per-account, so it belongs in the machine's config
        // rather than in a committed meta. Treated as a secret: GET
        // /admin/config strips it the way it strips the password hashes.
        hf_token: z.string().default('')
    }),
    // Two independent passwords, both optional:
    //   adminPasswordHash  — gates destructive/admin actions (see auth/authGate.js).
    //   accessPasswordHash — gates *using* the machine at all. When set, a student
    //                        must enter it before the client can connect (socket
    //                        handshake, uploads, job listing). Empty = open access,
    //                        which is the default and today's behavior.
    auth: z.object({
        adminPasswordHash: z.string().default(''),
        accessPasswordHash: z.string().default('')
    }).default({ adminPasswordHash: '', accessPasswordHash: '' }),
    queue: z.object({
        dbPath: z.string().default('./server/data/comfyq.sqlite'),
        inputRetentionMinutes: z.number().int().nonnegative().default(30),
        outputRetentionDays: z.number().int().nonnegative().default(30)
    }).default({}),
    workflows: z.object({
        dir: z.string().default('./workflows'),
        activeWorkflowId: z.string().nullable().default(null),
        // Extra workflows served in parallel beside the active one, each in its
        // own lane with its own ComfyUI. Remembered so a restart — nodemon, a
        // crash, a reboot — brings the machine back serving everything it was,
        // instead of silently dropping to one model mid-class.
        extraLaneWorkflowIds: z.array(z.string()).default([])
    }).default({ dir: './workflows', activeWorkflowId: null, extraLaneWorkflowIds: [] }),
    // Directory of sample media (images / videos / audio) used to auto-calibrate
    // workflows without any admin upload: the BenchmarkService picks a file
    // matching each exposed input's type and feeds it through a real cold+warm
    // run. Empty → image inputs fall back to a built-in reference PNG and
    // video/audio inputs can't be calibrated without meta.warmupParams.
    assets: z.object({
        dir: z.string().default('')
    }).default({ dir: '' }),
    // Routine upkeep of this machine (the admin panel's Maintenance tab).
    maintenance: z.object({
        // ★ Extra folders of workflow JSON to count as USING a model when
        // deciding what is unused. ComfyQ always scans its own bundles, their
        // templates, workflows/_candidate_workflows and ComfyUI's own
        // user/default/workflows — this is for anything else on the machine,
        // such as a folder of demo graphs. A folder left out here makes its
        // models look unused, so the prune list names every folder it scanned
        // and the admin can see what the verdict rests on.
        workflowScanDirs: z.array(z.string()).default([]),
        // Where a pruned model is MOVED to. Empty means <drive>\_model_quarantine
        // beside the install, which is also where _maintenance/prune-models.ps1
        // puts its own — so the two agree. Must be on the same volume as the
        // models, or a 40 GB prune becomes a 40 GB copy.
        quarantineDir: z.string().default('')
    }).default({ workflowScanDirs: [] }),
    // Federation (Phase F) — persistent identity for this machine, captured at
    // boot (see server/federation/systemInfo.js) and broadcast on the LAN status
    // beacon. All optional/defaulted so an existing config.json validates
    // unchanged; load() re-saves with these filled in on first boot.
    instance: z.object({
        id: z.string().default(''),          // uuid v4, regenerated if this config lands on another machine
        name: z.string().default(''),        // label shown in the fleet monitor; tracks the hostname unless nameCustom
        // OS hostname captured when `id` was minted. A mismatch at boot means
        // this config.json is now running on a DIFFERENT machine (the workshop
        // rigs are cloned from one drive image) or the machine was renamed, so
        // the identity is re-derived instead of reporting the old machine's
        // name/uuid — two clones sharing one uuid collapse into a single card
        // in the fleet monitor, which is what made names look "cached".
        hostname: z.string().default(''),
        // true once an admin typed a name in the admin panel; that name is then
        // kept as-is and no longer follows the hostname.
        nameCustom: z.boolean().default(false),
        gpu: z.string().default(''),         // cached last-known GPU model
        vramGb: z.number().nonnegative().default(0),
        ramGb: z.number().nonnegative().default(0)
    }).default({ id: '', name: '', hostname: '', nameCustom: false, gpu: '', vramGb: 0, ramGb: 0 }),
    // LAN status beacon — each instance multicasts a JSON status snapshot every
    // `intervalSec` so a standalone fleet-monitor app (desktop/) can list every
    // machine on the network. On by default (workshop goal: machines "just
    // appear"); set enabled:false to opt a machine out (then it behaves exactly
    // like today's single-instance ComfyQ).
    federation: z.object({
        enabled: z.boolean().default(true),
        group: z.string().default('239.255.42.99'),
        port: z.number().int().positive().default(41999),
        intervalSec: z.number().int().positive().default(5)
    }).default({ enabled: true, group: '239.255.42.99', port: 41999, intervalSec: 5 })
});

module.exports = {
    AppConfig,
    WorkflowMeta,
    WorkflowConfigMeta,
    ExposedParameter,
    ParamType
};
