# Token Framer App: instructions for coding agents

Standalone Electron desktop app that frames token art with a token frame (one image or a whole folder), with manual cutout tools for
pop-out tokens, AI background removal, and image tools (clean, upscale, extend edges, solve background). No Foundry VTT dependency.
Plain ES modules, no bundler, no framework.

The full, detailed project notes live in [.claude/CLAUDE.md](.claude/CLAUDE.md). Read the section for the area you are touching
before changing it; this file is the short version. If the two disagree, `.claude/CLAUDE.md` wins.

## Layout
The repo root holds only the launcher `.bat`, README, VS Code workspace and agent config. Everything else is in `app/`
(source, `package.json`, `node_modules`, `tools`, `LICENSE`). **Run npm/node commands from `app/`.**

- `app/main.cjs`: window, native dialogs, file IPC (`fs:*`), settings JSON in `userData`, AI cutout (RMBG-2.0 via `onnxruntime-node`), model IPC (`models:*`).
- `app/preload.cjs`: the `window.api` bridge. `contextIsolation` is on: add new file or OS access as an IPC handler, never by loosening that.
- `app/modelrun.cjs`: pure CJS ONNX tiling engine for the cleanup/upscale models.
- `app/renderer/app.js`: UI, state, tools, saving. `renderer/lib/composite.js`: layer compositing and placement. `renderer/lib/colorremoval.js`: background-removal masks.
- Tool screens: `cleaner.js` (Clean frame), `solver.js` (Solve frame/image background), `bgremove.js` (Remove background), `imgclean.js` (Clean/Upscale image), `extend.js` (Extend edges). Shared helpers in `renderer/ui-kit.js`. Heavy maths runs in `renderer/lib/*.worker.js`.
- `app/assets/default.webp`: default frame.

## Run and test
- `npm install` once. If `node_modules\electron\dist` is missing afterwards: `node node_modules\electron\install.js`.
- Launch: `Token Framer App.bat`, `npm start`, or start `node_modules\electron\dist\electron.exe` directly.
- **Gotcha:** if `ELECTRON_RUN_AS_NODE` is set in the shell, Electron runs as plain Node and `app` is undefined. Unset it.
- **Gotcha:** the folder path contains `&` (`Dungeons & Dragons`); npm's `.cmd` shims break on it. Quote every path, and start `electron.exe` directly when `npm start` fails.
- **Regression harness:** `node tools/test.mjs` (Node 22+, no deps) runs the app over Chrome DevTools Protocol and checks golden composites, cutout tools,
  edit persistence and folder rules. `--update` rewrites `tools/fixtures/golden-*.png`; **never run `--update` unless asked to.**
- Manual UI driving: start Electron with `--remote-debugging-port=9333 --user-data-dir=<scratch dir>` (scratch dir keeps saved settings from leaking), then use CDP.
  `window.__tf` exposes app state and a few functions.
- Shell is Windows (PowerShell/Git Bash). Paths with spaces, `&` and smart quotes are normal here; test with them.

## Rules
- **No new npm dependency without asking first** (state the trade-off). The only runtime dependency is `onnxruntime-node`.
- After changing compositing or mask code, re-run a parity check against the previous output (`node tools/test.mjs`) instead of trusting that it looks right.
- Keep the strict CSP in `index.html` (`script-src 'self'`). No inline scripts, no remote scripts.
- Images load as bytes -> `createImageBitmap(Blob)`, never as `file://` URLs.
- Match the surrounding code's style, naming and comment density. No bundler, no framework, no TypeScript.
- Do not touch the author's separate Token Framer Foundry module; it is a different project.
- `app/models/*.onnx` and downloaded models are gitignored (large, licences unchecked). Do not commit them.
- Do not commit, push, or rewrite git history unless asked.

## Design facts that are easy to break
- Offsets are authored in a 512 px space and scaled by `size / 512`. `baseRect()` is the one place art placement is computed; click-to-pixel mapping and compositing both use it.
- Per-image state lives in `item.override` (beats shared settings). Manual cutout edits are `override.popEdits`, in source-image pixels, applied in order on top of the automatic colour mask.
  Hand edits (brush, rectangle) are exempt from grow/feather/defringe so single-pixel edits stay exact.
- Preview and export share `buildSources` / `compositeFor`, so they cannot drift. Keep them shared.
- The main preview is drawn into an off-screen buffer and blitted; zoom/pan is applied in the blit, NOT as a CSS transform. All pointer maths goes through `compRect()`.
- `PER_IMAGE_KEYS` always write to the image's override and are stripped from `settings.json`, so pop-out etc. never become shared defaults.
- Folder mode skips files with "token" or "frame" in the name (case-insensitive), never overwrites an existing `<name> Token.<ext>` unless "Overwrite existing" is on, and writes next to the source.
- Image-cleanup/upscale models need a `<name>.json` beside the `.onnx` (scale and size rules); a 4x model without one errors on purpose.
- The model-based tools (Clean/Upscale image, Patch fill) refuse images with transparency; Extend edges mirror/smear/transparent accept it.

## Reviewing changes
When asked to review a diff, check in particular: preview/export drift, pointer-to-pixel mapping, IPC surface changes (anything that weakens `contextIsolation`),
non-ASCII or `&` in paths, worker crash/cancel handling, and memory/time on large images (the 25 Mpx confirm and 100 Mpx caps).
