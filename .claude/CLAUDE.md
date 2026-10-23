# Token Framer App

Standalone Electron desktop app that frames token art with a token frame, one image or a whole folder, with
manual cutout tools for pop-out tokens. No Foundry VTT dependency. Compositing logic was ported from the author's
Token Framer Foundry module (MIT); the module is a separate project and is not touched from here.

## Run and test
The repo root holds only the launcher `.bat`, README, the VS Code workspace and `.claude`; everything else lives in `app/`
(source, `package.json`, `node_modules`, `tools`, `LICENSE`). Run npm/node commands from `app/`; paths below are relative to it.
- `npm install` once (if `node_modules\electron\dist` is missing afterwards: `node node_modules\electron\install.js`).
- Launch: `Token Framer App.bat`, `npm start`, or the "Electron: Main" launch config in VS Code.
- **Gotcha:** if `ELECTRON_RUN_AS_NODE` is set in the shell, Electron runs as plain Node and `app` is undefined. Unset it
  (the `.bat` does).
- **Gotcha:** the folder path contains `&`; npm's `.cmd` shims break on it. Start `node_modules\electron\dist\electron.exe` directly.
- UI testing without a human: start Electron with `--remote-debugging-port=9333 --user-data-dir=<scratch dir>` (a scratch
  user-data dir keeps saved settings from leaking between runs), then drive it over the Chrome DevTools Protocol
  (`Runtime.evaluate`, `Input.dispatchMouseEvent`, `Page.captureScreenshot`). `window.__tf` exposes the app state and a few
  functions for this.

- Regression harness: `node tools/test.mjs` (Node 22+, no deps) runs the app over CDP and checks golden composites,
  cutout tools, edit persistence and folder rules. `--update` rewrites `tools/fixtures/golden-*.png`; only do that on purpose.

## Layout
- `main.cjs`: window, native dialogs, file IPC (`fs:*`), settings JSON in `userData`. `preload.cjs`: the `window.api` bridge.
  `contextIsolation` is on; add new file or OS access as an IPC handler, not by loosening that.
- AI cutout: `main.cjs` runs RMBG-2.0 (community FP16 ONNX, `yamura4/RMBG-2.0-ONNX`, CC BY-NC 4.0, personal use) through
  `onnxruntime-node` (DirectML, CPU fallback); model downloads on first use to `userData\models`, mattes are cached in
  `userData\mattes` by input hash. The ONNX input is fixed at 1024x1024. `renderer/lib/matte.js` holds the sensitivity/blur/offset
  maths (copied from the ComfyUI RMBG node); the `{type:'ai'}` edit in `colorremoval.js` turns the matte into a removal mask.
- Recent frames sidebar (`#frames`, toggled by the toolbar "Recent Frames" button; the default frame is always pinned first): `state.recentFrames` (max 24, saved in `settings.json`) is fed by
  `loadFrame`; clicking a tile loads that frame only (`keepOrder` so the list doesn't jump). Thumbnails are generated lazily, memory-only.
- Clean frame tool (Tools > Clean frame…): a full-window overlay (`#cleaner`, `renderer/cleaner.js`) over the main UI. The maths is `renderer/lib/cleanframe.js`
  (pure, a port of the author's ComfyUI "Token Cleaner" workflow: guided-filter alpha refine -> floor/solidify/ceiling -> colour bleed -> crop -> resize), run in
  `lib/cleanframe.worker.js` (module worker; stage caches: guided filter by radius+smoothing, colour by radius). The export resize is a Pillow-exact Lanczos3
  (premultiplied 8-bit, 22-bit fixed point); the preview skips it. Saves PNG only (lossy WebP would damage the alpha edges), default name always contains
  "Frame" so folder mode never treats it as art. While the overlay is open `onKey`, paste and drop on the main window are ignored. Deliberately not ported:
  the node's decontaminate option (hard-coded off in the workflow). Fit+pad is the default resize; "Stretch" matches ComfyUI's behaviour.
- Solve frame background / Solve image background (Tools > Solve frame background… and Image tools > Solve image background…, ONE screen `renderer/solver.js`, `open('frame'|'image')`;
  per-mode settings in `paramSets`, controls rebuilt on a mode change). Image mode = the Image Background Solver V2: same maths, `crop:false`, resize 'none', no cut-out middle, and "Save and
  open as image" (`openImages`) instead of `loadFrame`. Frame mode: same screen layout as Clean frame (`.toolscreen` classes, shared helpers in
  `renderer/ui-kit.js`: control builder, worker RPC that survives a worker crash, square preview drawing). Port of the ComfyUI "Token Background Solver V2": maths in
  `lib/solveframe.js` (triangulation matting from a white and a black render -> floor/ceiling -> colour -> `solidify` passes (the workflow's two Porter-Duff self-composites)
  -> shared crop/resize from `cleanframe.js` -> "clear the middle": `assets/middle-mask.png`, a fixed 1000x1000 circle subtracted from alpha, Lanczos-scaled to other sizes),
  run in `lib/solveframe.worker.js`. Order differs from Clean frame on purpose (floor/ceiling before solidify; do not reuse `shapeAlpha`). NOT ported: the workflow's 1x_PureVision
  pre-clean is now the optional `preClean` step (see the image cleanup models note below). Parity is only claimed for PNG inputs without it; with it the JPEG-noise step matches the workflow.
- Image cleanup and upscale models: ESRGAN-type (1x cleanup, 4x upscale) and DAT `.pth` files (e.g. 1x_PureVision, 4x-UltraMix_Smooth, 4x-UltraSharpV2) are converted once with `tools/convert-model.py` (ComfyUI's python; ComfyUI need not run) into
  `app/models/<name>.onnx` (gitignored: large, licence unchecked) plus a `<name>.json` (scale and size rules the converter writes; tracked, tiny; an .onnx without one is taken as 1x, multiples of 4,
  and `withSpandrelPadding` throws if the output size does not match, so a 4x model missing its .json errors instead of producing garbage). Timings (RTX 3090 Ti, DirectML), 1000x700 -> 4000x2800: 4x-UltraSharp (since removed) 3.4 s, 4x-UltraSharpV2 (DAT) 10.7 s. Upscale defaults to 4x-UltraMix_Smooth. `modelrun.cjs` (pure CJS, no electron) is the engine: spandrel-style padding (right/bottom to the model's multiple/minimum,
  reflect then replicate) + comfy `tiled_scale` (512 tiles, 32 overlap, feather = 32 * scale), unit-tested with fake models (incl. a nearest-neighbour 2x/4x upscaler) and checked once
  against ComfyUI itself on the real models (1x PureVision at 1001x777, 4x-UltraSharp, DAT 4x-UltraSharpV2: max 1 LSB). `main.cjs` exposes `models:list` / `models:clean` (onnxruntime-node, DirectML then CPU, sessions cached; only files really in `models/` can be named). RGB only:
  the Clean image / Upscale image screen (Tools > Clean image… and Upscale image…, one screen `renderer/imgclean.js`, `open('clean'|'upscale')` filters the models by scale) REFUSES images that
  have transparency. Nothing runs on load: a **Process** button starts the model (`run()` in imgclean.js; the models can take seconds), and Save stays off until there is a result. Upscale mode has an "Upscale by" factor (2/3/4, default 4): the model's output is kept in `raw`, and a smaller factor is `resizeLanczos` of it in `lib/resize.worker.js` (changing the factor needs no second model run; changing the model or image does). A model run whose output exceeds 25 Mpx (`HEAVY_PIXELS` in `ui-kit.js`, `confirmHeavy`) asks the user to confirm first (imgclean Process, solver Process); `main.cjs` stops at 100 Mpx and retries with smaller tiles (256, 128) on a memory error. The solver's "Clean noise first" option (the preview stays real-time on the raw renders; the **Process** button runs the model on both renders, `cleanedNow()` gates using the cleaned copies, and Save is disabled until then)
  (default on when a model exists; the workflow's 1x_PureVision step) cleans each render once, when Process is pressed, via `models:clean` (request ids keep progress events per screen), hands the
  cleaned copy to the worker, and the matte uses cleaned copies only when BOTH exist. A packaged build would need `models/` unpacked from asar.
- Remove image background / Remove frame background (Tools menu, one screen `renderer/bgremove.js`, `open('image'|'frame')`; mode only changes the title, the default name (frames keep "Frame" in it) and
  the second save button: `openImages` vs `loadFrame`): the main window's cutout tools (AI remove, remove colour, wand, brush, rectangle, edge cleanup, undo/redo) on a screen of their own for one image. It
  reuses the pure maths unchanged (`buildEditedMask` -> `applyRemovalMask` in `lib/colorremoval.js`, same as `buildCut` in app.js; a test compares the bytes) and takes `computeMatte` / `ensureAiModel` from app.js
  (`ensureAiModel` is the "download RMBG first?" step lifted out of `runAi`). State is local (`edits`, `redoStack`, `matte`) and lasts until another image is opened: it never touches `item.override`/`edits.json`.
  Own zoom/pan, pointer mapping (`srcPoint`) and live brush. Precision rules: the canvas backing store is sized to the device pixels it is shown at (`sizeCanvas`, no browser resampling), from 1 device px per image px the zoom is a whole number on whole device pixels (nearest neighbour, exact k x k blocks), and ONE layout (`origin()`) serves drawing, pointer mapping and the brush ring; pointer maths uses the content box (not the 1 px border). A test drives it with real mouse input over CDP; its keyboard handler is a capture-phase `keydown` on window so Esc puts a tool down instead of closing the screen (the main `onKey` is
  disabled while a tool screen is open). Frame mode adds a "Clean frame" section (`cleanEnabled`, default ON, plus the Clean frame settings from `cleanframe.js` DEFAULTS in the same `params`): the cutout is handed to a `cleanframe.worker.js` instance (`setImage` message) and the Show select has a "Cleaned frame" view (trimmed; editing only works on the Cutout view); Save then exports through the worker (trim, refine, resize), or the plain full-size cutout when it is switched off. Image mode always saves the plain cutout. `ui-kit.buildControls` gained `t:'tint'` (tick + colour) and `t:'custom'` (`build(ctl)` returns a sync function) for it.
- Extend edges (Image tools > Extend edges…, `renderer/extend.js`; maths `lib/extendedges.js` run by `lib/extendedges.worker.js`: `load` once, then `extend` per settings): pads an image (top/right/bottom/left, "link sides", "Pad to square" via
  `squarePadding`) and fills the border. Modes: `mirror` (periodic NON-duplicating reflect, `reflectIndex`: distance d reads source pixel d, so no doubled line at the seam, and padding wider than the picture bounces),
  `smear` (clamp) and `transparent`. A blur whose sigma = `blur` x distance from the picture is applied by blending Gaussian levels (sigma 0,1,2,4...; each level blurs the previous one further) on PREMULTIPLIED values, so alpha
  images get no dark/coloured fringes; the original is copied back byte for byte. Accepts transparency (unlike the model tools). Live preview while the result is <= `HEAVY_PIXELS` (25 Mpx), otherwise the Process button (with `confirmHeavy`);
  hard cap `MAX_EXTEND_PIXELS` 100 Mpx. Saves PNG as `<name> (extended).png`. Cost: about 3 s for a 3.4 Mpx result. Planned next (not built): a PatchMatch "Patch fill" mode (see the plan file notes: full resolution, source band near the
  edge, seeded RNG), possibly a LaMa/MI-GAN ONNX mode later.
- `renderer/lib/zip.js`: tiny store-only ZIP writer for "Save all as ZIP" (no dependency).
- `renderer/app.js`: UI, state, tools, saving. `renderer/lib/composite.js`: layer compositing and placement.
  `renderer/lib/colorremoval.js`: background removal masks. `renderer/lib/holedetect.js`: frame-opening detection.
- Plain ES modules, no bundler, no framework. The CSP in `index.html` is strict (`script-src 'self'`).
- `assets/default.webp`: default frame, loaded when no frame was saved.

## Design facts worth knowing
- Images load as bytes -> `createImageBitmap(Blob)`, never as `file://` URLs (avoids canvas taint and non-ASCII path trouble).
- Offsets are authored in a 512 px space and scaled by `size / 512`. `baseRect()` is the one place art placement is computed;
  click-to-pixel mapping and compositing both use it.
- Per-image state lives in `item.override` (anything there beats the shared settings). Manual cutout edits are `override.popEdits`,
  in source-image pixels, applied in order on top of the automatic color mask; hand edits (brush, rectangle) are exempt from
  grow/feather/defringe so single-pixel edits stay exact. A brush of 1 to 3 px is a pixel pen (`penSize`/`penAnchor`/`stampPixelStroke` in `colorremoval.js`; edit `{type:'brush', px: 1|2|3, pts: integer anchor pixels}`; size 3 is centred on the pixel under the pointer, 2 on the nearest corner):
  whole pixels under the pointer joined by a Bresenham line, the ring becomes a pixel square. The 1 px pen is pixel-perfect (`penPathAdd`, as in Aseprite): L-shaped corner pixels
  that a hand-drawn diagonal picks up are dropped live (`livePenPath` puts them back as they were) and the edit's `pts` is the finished pixel path. A sharp 90° turn loses its corner pixel, by design. Older disc-based brush edits (no `px`) are replayed as before (they rounded the pointer to the nearest pixel centre, half a pixel off).
- The main window's preview: the composite is rendered into an off-screen buffer (`state.prevBuf`, 800 px, 1600 in pixel view, up to 4096 while zoomed: `previewSize()`; a 4096 px
  composite takes about 50 ms) and `blitPreview()` draws the visible part into `#preview`, which is sized to whole device pixels. Zoom (max 20x) and pan are applied there, NOT as a CSS
  transform: Chromium drew a CSS-zoomed canvas up to ~4 px away from its own getBoundingClientRect at 20x, so the pixel seen under the pointer was not the one erased. All pointer maths
  goes through `compRect()` (where the whole composite is on screen). With the pen in hand and the art magnified (`penCrisp()`) the art is drawn nearest neighbour and the pen maps the
  pointer through exactly that drawing (`penAnchorAt`, `penBlockRect`). A pen click ignores the first 4 CSS px of movement (`PEN_DEAD_ZONE`), so a shaky click stays one pixel.
- The cutout only affects the pop-out layer unless `crPopOutOnly` is off. Preview and export share `buildSources` / `compositeFor`,
  so they cannot drift.
- "Edit this image only" (`state.editOnly`) follows the selected image: on when it has any `override`, off otherwise. With 2+ images, changing a
  key in `PER_IMAGE_KEYS` (pop-out enable/arc/rotation/center, AI sensitivity/blur/offset, feather/grow/defringe, Pop-out layer only) or pushing a cutout
  edit writes to the image's override and switches the box on, with a status message (`enableEditOnly`). Colour-removal keys and tool settings stay shared. `PER_IMAGE_KEYS` always write to the image's override (even a lone image), are stripped from `settings.json` on save and reset to defaults on load, so pop-out etc. can never become a shared default.
  Reset settings also clears a lone image's override; Reset image clears one image's.
- Output: Format (WebP default, PNG) re-points every item's `outPath` and re-checks existence (`refreshOutPaths`). The WebP quality slider's 100% is sent
  to the encoder as 0.99 (best lossy, like Photoshop); the Lossless box sends a real 1.0, which Chromium encodes as lossless WebP. A saved 0.95 (the old
  default) is upgraded to 1 on load.
- Window bounds live in `window.json` (main process, ignored if off-screen); panel section open/closed state is in `settings.json` (`sections`).
- Shortcuts: W/B/R tools, Left/Right image, Ctrl+S save, Ctrl+Z/Y undo/redo, Esc leaves a tool. The status line under the preview is always shown ("Ready" placeholder).
- Folder mode skips files with "token" or "frame" in the name (case-insensitive substring), never overwrites an existing
  `<name> Token.<ext>` (webp by default, png optional) unless "Overwrite existing" is on, and writes next to the source.

## Rules
- No new npm dependency without asking first (stating the trade-off). The only runtime dependency is `onnxruntime-node` (approved for AI cutout).
- After changing compositing or mask code, re-run a parity check against the previous output rather than trusting it looks right.
- Windows paths with spaces, `&` and smart quotes are normal here; test with them.
