# Handoff

State of the project after the AI-cutout / recent-frames / UI-polish sessions (HEAD `ca28f9b`, working tree clean). `.claude/CLAUDE.md` covers how
the code is laid out and the rules; this file covers where things stand, what was decided and why, and what is next.

## Status
Working and used by hand by the author. Features:
- Frame one image, several images, a whole folder, or a pasted image (Ctrl+V); **Save all** writes `<name> Token.webp` next to each source,
  **Save all as ZIP** renders every ticked image into one `.zip` (tiny store-only writer in `renderer/lib/zip.js`, no dependency).
- **Toolbar**: `Image` label (Open Images…, Open Folder…) | `Frame` label (Open Frame…, Recent Frames) + current frame name; Pixel view at the right.
- **Recent frames sidebar**: left sidebar, default frame always pinned first, then up to 24 recent frames with thumbnails (see below).
- **Auto center**: finds the frame's transparent opening (flood fill from the centre) and cover-fits the art to it, top- or centre-anchored, with a
  scale/nudge. Panel row: `[x Auto center] ........ [Pick center point]` (the button stays available when detection fails). Mask shapes: frame shape
  (auto), circle, square, hex, none, custom image.
- Frame, background (color/image), overlay, tint and pop-out layers, ported from the Foundry module.
- **Background removal** (panel groups: view options, AI cutout, By color, Edge cleanup, Touch up by hand): **AI remove (RMBG-2.0)**, color removal
  (threshold, edges only), shared feather/grow/defringe, manual wand, brush (erase/restore, 1-600 image px) and rectangle with undo/redo/reset.
  By default only the pop-out layer is cut out. Tool options only show while that tool is selected.
- Colour controls have a swatch plus a hex text field (the native picker has its own eyedropper).
- **Pixel view** (no smoothing, 2x preview, up to 16x zoom) for single-pixel edits.
- Per-image overrides ("Edit this image only"), skip rules for names containing token/frame, never overwrites an existing token unless told to.
  The top row of the right panel holds "Edit this image only" and "Reset image" (only with 2+ images) and "Reset settings" (always).
- Per-image overrides and manual edits persist between sessions (`edits.json`).

## Decisions and why
- **Electron, not a local server + browser window** (as the author's Ring Generator app does): the folder workflow wants native
  dialogs, drag-and-drop of paths and direct disk writes, and `createImageBitmap` from bytes avoids `file://` canvas taint.
- **Fork of the module's compositing, not a rewrite.** The module's preview and export drew with two copies of the same code;
  here one `compositeImage` serves both.
- **Edits are an ordered list of source-pixel operations** (`override.popEdits`) rather than a painted bitmap: cheap to undo,
  independent of zoom/placement/output size, and carried per image through **Save all**. The AI cutout is just one more op, `{type:'ai'}`.
- **Hand edits skip grow/feather/defringe** (`fixed` mask in `colorremoval.js`). Without that, a 1px brush erased 5px.
- **Cutout is pop-out-only by default** so the art under the frame keeps its background; the checkbox turns that off.
- **Recent frames: clicking a tile restores the frame image only**, not per-frame settings (the author chose this over presets).
- **Own ZIP writer instead of a library**: WebP is already compressed, and the rule is no new dependency without asking.

## AI background removal (RMBG-2.0)
`main.cjs` runs the community FP16 ONNX export of RMBG-2.0 (`yamura4/RMBG-2.0-ONNX`, 512,588,696 bytes, public,
**CC BY-NC 4.0: personal use only; re-check before anything commercial**) through `onnxruntime-node` (approved dependency, about 290 MB in
node_modules; DirectML with CPU fallback). The model downloads on first use to `userData\models` (or pick an existing file if the download
fails). The result is a `{type:'ai'}` entry in `popEdits`, so feather/grow/defringe, brush/wand, undo and per-image persistence all work.
Sensitivity (1), blur (0) and offset (-1) follow the author's SwarmUI RMBG workflow and the maths in `renderer/lib/matte.js` matches the
ComfyUI node (`comfyui-rmbg/py/AILab_RMBG.py`).
- The ONNX input is **fixed at 1024x1024** (the workflow's 2048 process_res is not possible). Output is already 0..1.
- Measured: about 1.2 s per image on DirectML (about 4.8 GB RAM), about 12.6 s on CPU (about 13 GB RAM); first run in the app about 6-8 s
  including model load. Mattes are cached in `userData\mattes` by input hash (1 MB each, never pruned); repeat lookups take about 30 ms.
- Verified end to end under Electron on two real images; unit checks for the matte maths are in `tools/test.mjs`. No automated check
  runs the real model (it would need the 490 MB file). The in-app download and the "pick a model file" fallback were not exercised.
- Not done: soft (partial) alpha (the matte is thresholded at 50 %, then the usual feather/grow apply), refine_foreground, "AI remove all" for a whole folder.

## Recent frames sidebar
Toolbar "Recent Frames" opens a left sidebar. The default frame is always pinned at the top (label "Default", no remove button, never part of the
recent list); below it up to 24 recent frames, newest first, with thumbnails, remembered open/closed state. Clicking a tile loads that frame without
reordering the list. Missing files show as "(missing)" and drop out on click. State: `state.recentFrames` in `settings.json`.

## Known limits and rough edges
- Per-image overrides and manual edits are saved to `edits.json` in userData, keyed by source path (popEdits are dropped if the image size changed).
  Undo history is not saved, and an edit made under 0.5 s before closing the window can be lost. Pasted (path-less) images are not remembered.
- A non-square frame is stretched to a square (same as the module and as the old Python script's final resize).
- Pixel view renders at 2x, so slider drags are slower while it is on.
- `npm install` may skip Electron's binary download in some environments: run `node node_modules\electron\install.js`.
- No packaging or installer.
- `Save all as ZIP` was not clicked end to end (the harness cannot answer the native save dialog); the ZIP writer itself is tested.

## Tests
`node tools/test.mjs` (Node 22+, no dependencies) drives the real app over CDP with a scratch user-data dir and paths containing spaces, `&` and
smart quotes. Golden composites live in `tools/fixtures/` (`--update` rewrites them, only on purpose). All checks pass at HEAD. Earlier
verification against the author's Python tokenizer: mean difference 0.32/255, under 0.2% of pixels differ visibly, only on resampled edges.

## Ideas not started (suggested, none requested yet except as noted)
AI remove for a whole folder (best next step), output folder / format options (e.g. a `Tokens` subfolder, PNG), copy token to clipboard, preview
background toggle (dark/light/map colours), recursive folder scan, per-image frame choice, saved user defaults (author unsure), packaging
(electron-builder; note onnxruntime-node's native files), soft alpha from the matte.
