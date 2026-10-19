# Handoff

State of the project as of the initial commit (v0.1.0). `.claude/CLAUDE.md` covers how the code is laid out and the rules;
this file covers where things stand, what was decided and why, and what is next.

## Status
Working and used by hand by the author. Features:
- Frame one image, several images, or a whole folder; **Save all** writes `<name> Token.webp` next to each source.
- **Auto center**: finds the frame's transparent opening (flood fill from the centre, "Pick center point" if that fails) and
  cover-fits the art to it, top- or centre-anchored, with a scale/nudge. Mask shapes: frame shape (auto), circle, square, hex, none, custom image.
- Frame, background (color/image), overlay, tint and pop-out layers, ported from the Foundry module.
- **Background removal for pop-outs**: color removal (threshold, edges only, feather, grow, defringe) plus manual wand, brush
  (erase/restore, 1-600 image px) and rectangle, with undo/redo/reset. By default only the pop-out layer is cut out.
- **Pixel view** (no smoothing, 2x preview, up to 16x zoom) for single-pixel edits.
- Per-image overrides ("Edit this image only"), skip rules for names containing token/frame, never overwrites an existing token unless told to.

## Decisions and why
- **Electron, not a local server + browser window** (as the author's Ring Generator app does): the folder workflow wants native
  dialogs, drag-and-drop of paths and direct disk writes, and `createImageBitmap` from bytes avoids `file://` canvas taint.
- **Fork of the module's compositing, not a rewrite.** The module's preview and export drew with two copies of the same code;
  here one `compositeImage` serves both.
- **Edits are an ordered list of source-pixel operations** (`override.popEdits`) rather than a painted bitmap: cheap to undo,
  independent of zoom/placement/output size, and carried per image through **Save all**.
- **Hand edits skip grow/feather/defringe** (`fixed` mask in `colorremoval.js`). Without that, a 1px brush erased 5px.
- **Cutout is pop-out-only by default** so the art under the frame keeps its background; the checkbox turns that off.

## Deferred: AI background removal
Agreed to do later, needs the owner's go-ahead on the dependency first (the author's rule: no new dependency without asking).
Sketch: `onnxruntime-node` in `main.cjs` (official package, Electron 28+, about 218 MB unpacked, DirectML on Windows x64), model
downloaded on first use to `userData\models`, IPC `ai:matte` (image bytes in, matte out), and an "AI remove" button whose matte
becomes one more op feeding the same mask so feather/grow/undo/brush all still work. Owner said use is **personal tabletop only**,
so BRIA's RMBG-1.4 / 2.0 (non-commercial licenses) are acceptable; BiRefNet ONNX exports are MIT but large. Model file sizes and
inference speed were not verified. Re-check the licenses before shipping anything commercial.

## Known limits and rough edges
- Manual edits (`popEdits`) and per-image overrides are not saved between sessions.
- Opening a folder auto-loads the first `Frame*` file, which also matches names like `Framed Knight`.
- No "restore default frame" button; browse to `assets\default.webp`.
- A non-square frame is stretched to a square (same as the module and as the old Python script's final resize).
- Pixel view renders at 2x, so slider drags are slower while it is on.
- `npm install` may skip Electron's binary download in some environments: run `node node_modules\electron\install.js`.
- No packaging or installer. Tests: `node tools/test.mjs` (see .claude/CLAUDE.md).

## How it was verified (not committed; recreate if needed)
Driven over the Chrome DevTools Protocol against a scratch `--user-data-dir`, with synthetic test art (flat background, a donut with an enclosed
background pocket, a small square) and the default frame:
- Output vs the author's earlier Python tokenizer on the same art/frame: mean difference 0.32/255, under 0.2% of pixels differ visibly, only on resampled edges.
- Refactored color removal is byte-identical to the module's original on random images and several parameter sets.
- Wand (contiguous keeps the pocket, global removes it), brush erase/restore, rectangle, undo/redo/reset, layer split, click-to-pixel mapping
  (0.000 px error with zoom/pan and Auto center), real mouse and Ctrl+Z/Y input, batch isolation of per-image edits, a 4000x4000 image
  (40 live brush moves about 1.2 s, full refinement about 0.5 s), 1px brush = exactly 1 pixel.
A worthwhile next step is committing a small version of that harness as `tools/` plus a parity fixture.

## Ideas not started
Persist edits per file, recursive folder scan, per-image frame choice, packaging (electron-builder), committed regression tests.
