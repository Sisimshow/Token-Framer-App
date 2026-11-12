# Token Framer App

Standalone Electron desktop app that frames token art with a token frame, one image or a whole folder, with
manual cutout tools for pop-out tokens. No Foundry VTT dependency. Compositing logic was ported from the author's
Token Framer Foundry module (MIT); the module is a separate project and is not touched from here.

Detailed design notes live in `app/docs/` (read the relevant one before changing that area):
- `app/docs/tools.md`: every tool screen (Clean frame, Solve background, Clean/Upscale models, Remove background,
  Extend edges + Patch fill, Send to tool) and the deferred strip-based model engine plan.
- `app/docs/pen-and-preview.md`: the 1-3 px pixel pen, main preview buffer, zoom/pan, exact pen view, pen feedback.

## Run and test
The repo root holds only the launcher `.bat`, README, the VS Code workspace and `.claude`; everything else lives in `app/`
(source, `package.json`, `node_modules`, `tools`, `docs`, `LICENSE`). Run npm/node commands from `app/`; paths below are relative to it.
- `npm install` once (if `node_modules\electron\dist` is missing afterwards: `node node_modules\electron\install.js`).
- Launch: `Token Framer App.bat`, `npm start`, or the "Electron: Main" launch config in VS Code.
- **Gotcha:** if `ELECTRON_RUN_AS_NODE` is set in the shell, Electron runs as plain Node and `app` is undefined. Unset it (the `.bat` does).
- **Gotcha:** the folder path contains `&`; npm's `.cmd` shims break on it. Start `node_modules\electron\dist\electron.exe` directly.
- UI testing without a human: start Electron with `--remote-debugging-port=9333 --user-data-dir=<scratch dir>` (keeps saved
  settings from leaking between runs), then drive it over CDP (`Runtime.evaluate`, `Input.dispatchMouseEvent`,
  `Page.captureScreenshot`). `window.__tf` exposes the app state and a few functions for this.
- Regression harness: `node tools/test.mjs` (Node 22+, no deps) runs the app over CDP and checks golden composites,
  cutout tools, edit persistence and folder rules. `--update` rewrites `tools/fixtures/golden-*.png`; only do that on purpose.
- Release: bump `version` in `package.json` (and `package-lock.json`), `node tools/make-release.mjs` builds
  `dist/Token-Framer-App-<version>-win-x64.zip` (gitignored; same layout as the source: `.bat` + README.txt on top, `app/` with
  only the runtime node_modules and the `.onnx` models from `app/models`), then `gh release create v<version> <zip>`. No exe of
  our own (the user dropped the renamed/rcedit'd exe: Defender warnings). EPERM while Defender scans is retried by the script.

## Layout
- `main.cjs`: window, native dialogs, file IPC (`fs:*`), settings JSON in `userData`, AI cutout and model runs.
  `preload.cjs`: the `window.api` bridge. `contextIsolation` is on; add new file or OS access as an IPC handler, not by loosening that.
- `renderer/app.js`: UI, state, tools, saving. `renderer/lib/composite.js`: layer compositing and placement.
  `renderer/lib/colorremoval.js`: background removal masks. `renderer/lib/holedetect.js`: frame-opening detection.
  `renderer/lib/zip.js`: store-only ZIP writer for "Save all as ZIP". `renderer/ui-kit.js`: shared tool-screen helpers
  (control builder, worker RPC `makeRpc`, `confirmHeavy` above 25 Mpx).
- AI cutout: RMBG-2.0 (community FP16 ONNX, `yamura4/RMBG-2.0-ONNX`, CC BY-NC 4.0, personal use) via `onnxruntime-node`
  (DirectML, CPU fallback), fixed 1024x1024 input; downloads on first use to `userData\models`, mattes cached in `userData\mattes`
  by input hash. `renderer/lib/matte.js` = sensitivity/blur/offset maths (from the ComfyUI RMBG node); the `{type:'ai'}` edit in
  `colorremoval.js` turns the matte into a removal mask.
- Clean/upscale models: `.pth` converted once with `tools/convert-model.py` into `app/models/<name>.onnx` (gitignored) + `<name>.json`
  (tracked; scale/size rules). `modelrun.cjs` is the engine (pure CJS). Details in `app/docs/tools.md`.
- Tool screens (each a full-window overlay; the main `onKey`, paste and drop are ignored while one is open): Clean frame
  (`cleaner.js`), Solve frame/image background (`solver.js`), Clean/Upscale image (`imgclean.js`), Remove image/frame background
  (`bgremove.js`), Extend edges (`extend.js`). Maths in `renderer/lib/*.js`, run in module workers. See `app/docs/tools.md`.
- Recent frames sidebar (`#frames`, toolbar "Recent Frames"; default frame always pinned first): `state.recentFrames` (max 24,
  in `settings.json`) fed by `loadFrame`; a tile click loads that frame only (`keepOrder`). Thumbnails lazy, memory-only.
- Plain ES modules, no bundler, no framework. The CSP in `index.html` is strict (`script-src 'self'`).
- `assets/default.webp`: default frame, loaded when no frame was saved.

## Design facts worth knowing
- Images load as bytes -> `createImageBitmap(Blob)`, never as `file://` URLs (avoids canvas taint and non-ASCII path trouble).
- Offsets are authored in a 512 px space and scaled by `size / 512`. `baseRect()` is the one place art placement is computed;
  click-to-pixel mapping and compositing both use it.
- Per-image state lives in `item.override` (anything there beats the shared settings). Manual cutout edits are `override.popEdits`,
  in source-image pixels, applied in order on top of the automatic color mask; hand edits (brush, rectangle) are exempt from
  grow/feather/defringe so single-pixel edits stay exact. Brush 1-3 px is a pixel pen: see `app/docs/pen-and-preview.md`.
- Main preview: composite rendered into an off-screen buffer and blitted into `#preview`; zoom/pan are NOT CSS transforms; all
  pointer maths goes through `compRect()`. Exports never pass `view`/`snapArt`. Details in `app/docs/pen-and-preview.md`.
- The cutout only affects the pop-out layer unless `crPopOutOnly` is off. Preview and export share `buildSources` / `compositeFor`,
  so they cannot drift.
- "Edit this image only" (`state.editOnly`) follows the selected image: on when it has any `override`, off otherwise. With 2+ images, changing a
  key in `PER_IMAGE_KEYS` (pop-out enable/arc/rotation/center, AI sensitivity/blur/offset, feather/grow/defringe, Pop-out layer only) or pushing a cutout
  edit writes to the image's override and switches the box on, with a status message (`enableEditOnly`). Colour-removal keys and tool settings stay shared.
  `PER_IMAGE_KEYS` always write to the image's override (even a lone image), are stripped from `settings.json` on save and reset to defaults on load.
  Reset settings also clears a lone image's override; Reset image clears one image's.
- Output: Format (WebP default, PNG) re-points every item's `outPath` and re-checks existence (`refreshOutPaths`). WebP quality 100% is sent
  as 0.99 (best lossy); the Lossless box sends a real 1.0 (Chromium lossless WebP). A saved 0.95 (old default) is upgraded to 1 on load.
- Window bounds live in `window.json` (main process, ignored if off-screen); the panel is an accordion (`<details name="panel">`), Image open on launch, nothing remembered.
- Shortcuts: W/B/R tools, Left/Right image, Ctrl+S save, Ctrl+Z/Y undo/redo, Esc leaves a tool. The status line under the preview is always shown ("Ready" placeholder).
- Folder mode skips files with "token" or "frame" in the name (case-insensitive substring), never overwrites an existing
  `<name> Token.<ext>` unless "Overwrite existing" is on, and writes next to the source. Tools that save frames keep "Frame" in the default name for this reason.

## Robustness rules (from the Codex reviews; keep them)
- IPC: every `ipcMain.handle` goes through `handle()` in `main.cjs`, which refuses any sender but the app window. `fs:read` only reads image files (`IMG_EXT`), `fs:write`
  only writes PNG/WebP/JPEG/ZIP (`WRITE_EXT`): a new file type needs adding there on purpose.
- `settings.json`, `edits.json`, `window.json` are written with `writeFileAtomic` (temp file + fsync + rename, retried on Windows locks, never a direct rewrite); a file that
  does not parse is renamed `<name>.corrupt-<time>`, not overwritten. Pending changes (the 500 ms debounces) are written synchronously on `beforeunload` (`app:flushSync`).
- RMBG-2.0 download: pinned revision `MODEL_REV` and `MODEL_SHA256` (checked while streaming, and for a hand-picked file); one download at a time (`downloading`).
- Model runs (`models:clean`) run one at a time (`cleanQueue`), sessions are cached as promises, and a run needing more than half the RAM is refused
  (the deferred strip-based fix is in `app/docs/tools.md`; only if the refusal is ever hit).
- `state.base.item` is the item the bitmap belongs to: tools and AI remove refuse to act until it is the selected item. `setItems` takes the new items' overrides from
  the store after flushing the outgoing ones.
- Saves (`saveCurrent`, `frameAll`, `zipAll`) work from `exportSnapshot()` (shared settings, per-item overrides, size, format, quality, frame, output paths) taken when
  they start; `loadFrame` defers closing a frame bitmap while `state.saving`. Save all flags two ticked images that would write the same file.
- Tool screens: the newest load wins (renderer counters and a `loadSeq` in the cleanframe/solveframe workers); a failed or crashed worker clears the screen
  (`forget`/`forgetAll`) instead of keeping half its state; `makeRpc().crash()` exists for tests. Clean frame asks (`confirmHeavy`) before an image over 25 Mpx.

## Rules
- No new npm dependency without asking first (stating the trade-off). The only runtime dependency is `onnxruntime-node` (approved for AI cutout).
- After changing compositing or mask code, re-run a parity check against the previous output rather than trusting it looks right.
- Windows paths with spaces, `&` and smart quotes are normal here; test with them.
- When adding or changing a tool screen or the pen/preview, update the matching `app/docs/` file, not this one.
