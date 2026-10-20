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
  grow/feather/defringe so single-pixel edits stay exact.
- The cutout only affects the pop-out layer unless `crPopOutOnly` is off. Preview and export share `buildSources` / `compositeFor`,
  so they cannot drift.
- "Edit this image only" (`state.editOnly`) follows the selected image: on when it has any `override`, off otherwise. With 2+ images, changing a
  key in `PER_IMAGE_KEYS` (pop-out enable/arc/rotation/center, AI sensitivity/blur/offset, feather/grow/defringe, Pop-out layer only) or pushing a cutout
  edit writes to the image's override and switches the box on, with a status message (`enableEditOnly`). Colour-removal keys and tool settings stay shared.
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
