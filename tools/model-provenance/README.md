# model-provenance — where every model comes from

Fills `requirements.models[].url` / `.source` across every bundle, so a rig that
is missing a weight can be told **where to get it** rather than just that it is
missing.

```bash
# see what would change
node tools/model-provenance/harvest.cjs
# write it
node tools/model-provenance/harvest.cjs --write
# with the model audit's hand-curated column as an extra source
MODEL_AUDIT_CSV=<...>/_maintenance/model-audit/model-audit.csv \
  node tools/model-provenance/harvest.cjs --write

# check every link still resolves, and drop the dead ones
node tools/model-provenance/verify.cjs
node tools/model-provenance/verify.cjs --fix
```

Run `harvest.cjs` after adding a bundle. `test:storyboard` fails when a bundle
declares a model with no `url`, `source` or `auto`, so this is not optional.

## Where the links come from

**The workflows already carried them.** ComfyUI's own templates document their
models in `Note` / `MarkdownNote` nodes, and most of those links are
`/resolve/main/<subfolder>/<file>` — a direct download *with* its destination
folder.

★ **The index is pooled across all bundles, keyed by filename.** Per bundle the
notes cover about 68% of declared models; pooled it is **86%**, because a shared
weight like `flux-2-klein-9b-fp8` only needs *one* bundle to document it.
Harvesting per bundle leaves a sixth of the library unsourced for no reason.

Order of preference: a note's link → the audit CSV's `redownload` column →
`known-sources.json` → an `override` in that file, which wins over everything.

## The two fields, and why they are not one

| field | meaning |
|---|---|
| `url` | a **direct, fetchable file**. A download can be offered. |
| `source` | a **page for a human**, when only the repo is known. |
| `auto` | a node pack or pipeline fetches this itself. Never report it missing; never offer to download it. |
| `note` | why it is like that, in a sentence someone can act on. |

**Never invent a `url`.** A wrong direct link downloads the wrong weights
silently. One constructed-by-analogy link in the first pass 404'd and was caught
only by `verify.cjs`; it is now `source`-only with a note saying so.

## What verification can and cannot tell you

`verify.cjs` HEAD-checks every link. The classification is the useful part:

- **ok** — the file is there.
- **gated (401/403)** — the *repo* exists and needs an accepted licence plus a
  token. ★ It does **not** confirm the path: HuggingFace answers 401 for *any*
  path inside a gated repo, so a wrong filename there looks exactly like a right
  one. 8 links are in this state (black-forest-labs FLUX.2, Lightricks LTX-2.5).
- **missing (404)** — wrong. `--fix` drops it and records it in
  `dead-links.json`, which `harvest.cjs` then refuses to re-add — otherwise the
  two tools fight, verify dropping a link and harvest restoring it from the same
  bad note.
- **limited (429)** — HuggingFace rate-limits partway through ~140 requests. The
  run backs off 30 s and retries those; still-limited links change nothing.
- **error** — concludes nothing, so nothing is changed.

★ **A note can be wrong, and a gated repo hides it.** The LTX deblur template
points its pixel-spatial-upscaler adapter at `LTX-2.3-22b-IC-LoRA-Deblur`, which
does not hold it — and because that repo is gated the bad link answers 401 and
reads as healthy. That is what `override` in `known-sources.json` is for;
verification alone cannot catch it.

## fresh-machine.cjs: would every workflow download its models on a new Pod?

It runs the server's own code (the Pod plan's `missingModels()` and the downloader's `resolveDestination()`) against an **empty** ComfyUI folder, so it cannot disagree with what a Pod or Thunder instance will do. For every workflow it checks that each model the graph loads:
1. has a direct `url`, or is fetched by its node pack (`auto`);
2. has a folder the downloader can decide, from the link, the `type` or an explicit `dir`;
3. is **found** by the graph check once a file sits in that folder, which proves the name and folder are the ones the loader reads;
4. answers on HuggingFace with the console's token (with `--online`). A gated repo whose licence was not accepted fails here instead of on a paid machine.

A workflow the registry cannot load (a broken meta) also fails, instead of reading as "0 models, ok".

```bash
node tools/model-provenance/fresh-machine.cjs                         # offline; runs in npm run test:storyboard
node tools/model-provenance/fresh-machine.cjs --online                # also HEAD-checks every link with the token
node tools/model-provenance/fresh-machine.cjs --online --write-sizes  # also writes workflow-downloads.json for the console
```

`--allow a,b` lists workflows known to fail, so that a NEW failure stands out. The test suite allows only the two Krea 2 character-sheet workflows: the owner does not use Krea, and their files have no known source. A meta entry can carry `"dir": "<models subfolder>"` when neither its link nor its `type` says where the file goes, for example a file at a repo's root with type `other`.

## known-sources.json

Hand-curated gap-filling, read after the notes and the audit. `_`-prefixed keys
are documentation. Files whose origin genuinely is not recorded are **left out
on purpose** so the harvest keeps reporting them, and they are named in
`bundleCompleteness.test.js` so the gap is visible rather than forgotten.

## exclusive.cjs — what can be deleted

Two questions, one engine (`server/workflows/modelUsage.js`, shared with the
admin panel's **Maintenance → Prune unused models** card, so the command line and
the UI can never disagree about what is unused):

```bash
# what would deleting these bundles release, and what is shared with ones that stay?
node tools/model-provenance/exclusive.cjs <bundle-id> [<bundle-id>…]

# what does nothing on this disk reference at all?
node tools/model-provenance/exclusive.cjs --unused
```

★ **Never read a bundle's `requirements.models` as "its own" models.** Marigold
declared the 19 GB Qwen-Image-Edit UNET because it is *built on* it, and that file
serves a production bundle. Taken literally, "remove the models for Marigold and
Viggle" would have deleted 35 GB that four live bundles need.

A file counts as **used** when any of these holds, and each class has caught a
real near-miss:

| class | why it protects |
|---|---|
| a bundle's `api.json` | the obvious case |
| a bundle's `_template.json` | "Open in ComfyUI" hands the **template** to an admin, so a weight only it loads is still in use — this is what protects a 42.98 GB checkpoint here |
| a `lora` dropdown's `optionsFilter` | the dropdown offers **every** file matching the prefix, so those appear in no graph at all (14 `krea2_*` LoRAs) |
| a candidate / demo / ComfyUI-user workflow | not something ComfyQ serves, but somebody's work |

★ **A filename-shaped string is not a load.** The LTX 2.5 templates mention
`ltx-2.3-22b-dev.safetensors` eighteen times, every one of them a cloud-API model
name typed into a `GemmaAPITextEncode` widget. Such a file is **kept** — the safe
direction — but reported separately as *worth a look*. The classifier uses a
**named list** of such node classes, not a heuristic: guessing "a loader has
Loader in its name" wrongly flagged `DWPreprocessor`, `RIFE VFI` and
`ASASRApplyConditioning`, all of which really do take a model through a dropdown.

**Scanning less makes models look deletable.** Folders outside the bundles come
from `maintenance.workflowScanDirs` in `config.json`; the prune card names every
folder it checked and warns about any it could not read. Deleting runs through
`POST /admin/models/prune`, which re-derives usage server-side and refuses
anything it does not independently judge unused — a page left open while a
workflow was added cannot talk it into removing something now needed. What goes
is logged to `server/data/pruned-models.json`.
