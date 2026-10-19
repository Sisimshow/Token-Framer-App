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

## AI background removal (RMBG-2.0)
Done. "AI remove (RMBG-2.0)" in the Background removal section. `main.cjs` runs the community FP16 ONNX export of RMBG-2.0
(`yamura4/RMBG-2.0-ONNX`, 512,588,696 bytes, public, **CC BY-NC 4.0: personal use only; re-check before anything commercial**) through
`onnxruntime-node` (approved dependency, about 290 MB in node_modules; DirectML with CPU fallback). The model downloads on first
use to `userData\models` (or pick an existing file if the download fails). The result is a `{type:'ai'}` entry in `popEdits`, so
feather/grow/defringe, brush/wand, undo and per-image persistence all work. Sensitivity (1), blur (0) and offset (-1) follow the
author's SwarmUI RMBG workflow and the maths in `renderer/lib/matte.js` matches the ComfyUI node.
- The ONNX input is **fixed at 1024x1024** (the workflow's 2048 process_res is not possible). Output is already 0..1.
- Measured: about 1.2 s per image on DirectML (about 4.8 GB RAM), about 12.6 s on CPU (about 13 GB RAM); first run in the app about 6-8 s
  including model load. Mattes are cached in `userData\mattes` by input hash (1 MB each, never pruned); repeat lookups take about 30 ms.
- Verified end to end under Electron on two real images; unit checks for the matte maths are in `tools/test.mjs`. No automated check
  runs the real model (it would need the 490 MB file).
- Not done: soft (partial) alpha (the matte is thresholded at 50 %, then the usual feather/grow apply), refine_foreground, "AI remove all" for a whole folder.

## Recent frames sidebar
Toolbar "Recent" opens a left sidebar of recently used frames (max 24, newest first, thumbnails, open/closed state remembered). Clicking a
frame restores the frame image only, not per-frame settings (deliberate choice). Missing files show as "(missing)" and drop out on click.

## Known limits and rough edges
- Per-image overrides and manual edits are saved to `edits.json` in userData, keyed by source path (popEdits are dropped if the image size changed). Undo history is not saved, and an edit made under 0.5 s before closing the window can be lost.
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
Recursive folder scan, per-image frame choice, packaging (electron-builder; note onnxruntime-node's native files), AI remove for a whole folder, saved user defaults.
