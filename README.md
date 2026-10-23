# Token Framer App

Standalone Electron app that frames token art with a pog-style frame, one image or a whole folder, with automatic
centering on the frame's opening and manual cutout tools for pop-out tokens. The compositing code is ported from the
[Token Framer](https://github.com/Sisimshow/Token-Framer) Foundry VTT module. No Foundry needed.

Personal-use project, largely AI-written.

## Run
1. `npm install` once in the `app` folder. If `node_modules\electron\dist` is missing afterwards, run `node node_modules\electron\install.js` (also from `app`).
2. Double-click `Token Framer App.bat`.

## Use
- **Frame…** picks the frame. Opening a folder auto-loads a `Frame*` image found in it.
- **Open Images…** / drag files in: frame just those. **Open Folder…** / drag a folder in: lists every image
  (non-recursive) whose name has no "Token"/"Frame"; `X Token.webp` (or `.png`, per Output > Format) already present = unchecked unless "Overwrite existing".
- Click a thumbnail to preview it. Tick **Edit this image only** to store changes for that image alone (purple dot);
  otherwise changes are shared by the whole batch.
  The box follows the image, and it switches on by itself when you change the cutout settings (AI, feather/grow/defringe, edits)
  or any pop-out setting (enable, arc, rotation, center), since those belong to one image.
- **Save all** (appears with 2+ images) writes `<name> Token.webp` (or `.png`, see Output > Format) next to each source. **Save token** / **Save as…** do the current image.
- Auto center needs a closed frame with a transparent middle; if it can't find it, use **Pick center point**.
- **Background removal** (for pop-out tokens). With **Pop-out layer only** on (off by default), the cutout only affects the
  pop-out layer above the frame; the art under the frame stays intact. Leave it off to cut out both layers.
  - Remove color (+ Threshold / Edges only / Feather / Grow / Defringe) works automatically on every image, including in **Save all**.
  - Manual tools, for the current image only: **Wand** (click a background; Tolerance and Contiguous below),
    **Brush** (Erase or Restore mode, Brush size), **Rectangle** (erases the box). Each stroke/click is one edit:
    **Undo** / **Redo** (Ctrl+Z, Ctrl+Y) step through them, **Reset edit** clears them all. Esc leaves a tool. **W** / **B** / **R** pick Wand / Brush / Rectangle, **Left** / **Right** switch image, **Ctrl+S** saves the current token.
  - While a tool is active, drag draws; pan with Space+drag or the middle mouse button, zoom with the wheel.
  - **Show cutout only** previews the cutout alone, since with Pop-out layer only the effect is hard to see.
  - Manual edits belong to one image and are not saved between sessions, so **Save all** applies each image's own edits
    and uses color removal for everything else.
- **Output > WebP quality:** 100% is the best lossy setting (sent to the encoder as 99%, like Photoshop's 100). Tick **Lossless** for a true lossless WebP, which is much larger.
- **Tools > Clean frame…** opens a separate screen for tidying a frame image: refine its transparent edges (radius, smoothing, alpha floor / ceiling, solidify),
  trim the empty border (threshold, padding) and resize it. **Save as…** writes a PNG; **Save and use as frame** also loads it as the frame in Token Framer.
  Based on the author's ComfyUI "Token Cleaner" workflow; the resize matches the Pillow Lanczos that workflow uses.
- **Tools > Solve frame background…** makes a transparent frame from the same frame image rendered on a white background and on a black one (triangulation matting: the
  transparency is measured, not guessed). Controls: channel mode, alpha floor / ceiling, white and black levels, which render supplies the colours, solidify, trim, resize
  and **Clear the middle** (a fixed circle about half the image width). It warns when the two renders look swapped or do not line up. Same two save buttons as Clean frame.
  Like the workflow, it can run both renders through the image-cleanup model (**Clean noise first**, on by default when `app/models` has a model; untick it to skip). The preview stays real-time and uses the renders as they are; press **Process** to run the model, and saving waits for it. Based on the author's ComfyUI "Token Background Solver V2" workflow.
- **Tools > Clean image…** removes compression noise and artifacts from an *opaque* image with a converted restoration model (1x_PureVision), with a zoomable before/after view. Nothing runs when you open an image: press **Process** when you are ready (the models can take a while).
  The model works on RGB only, so it cannot clean an image that already has transparency. Saved as a PNG; **Save and open as image** also opens it in Token Framer.
- **Tools > Remove image background… / Remove frame background…** is the main window's cutout toolbox (AI remove, remove a colour, magic wand, brush, rectangle, feather/grow/defringe, undo/redo) on a screen of
  its own, for one image or frame at a time: pick a file, cut the background out, then **Save as…** (a full-size transparent PNG) or **Save and open as image / use as frame**. In frame mode a **Clean frame** section (on by default, can be switched off) trims, refines and resizes the cutout when
  you save, with a "Cleaned frame" view to check it. Its edits are separate from the
  main window's and last until you open another image. Space+drag pans, scroll zooms, Esc puts the tool down.
- **Tools > Upscale image…** enlarges an *opaque* image 2×, 3× or 4× (default 4×; the models always make 4×, so 2× and 3× shrink the result afterwards) with an upscaling model (4x-UltraMix_Smooth by default, or the 4x-UltraSharpV2 DAT model) on the same
  screen as Clean image; saved as a PNG.
- **Tools > Extend edges…** adds canvas around an image (any side, or **Pad to square**) and fills the new border from the picture itself instead of a flat colour: *Mirror* reflects the picture outward
  (no doubled line at the seam), *Smear* repeats the edge pixels, *Transparent* adds empty canvas. A blur that grows with the distance from the picture keeps the far edge a calm wash rather than a hard
  echo. Images with transparency work. The preview follows the controls live; a very large result waits for **Process**. Saved as a PNG (`<name> (extended).png`).
- **Converted image models** (used by Clean image, Upscale image and the solvers' pre-clean) live in `app/models/`: three at the moment, 1x_PureVision,
  4x-UltraMix_Smooth and 4x-UltraSharpV2. The large `.onnx` files are not tracked by git; each comes with a small `<name>.json` (scale and size rules) that is tracked and must stay
  next to its `.onnx`. Recreate one with ComfyUI's Python (ComfyUI need not be running):
  `E:\SwarmUI\dlbackend\comfy\python_embeded\python.exe app\tools\convert-model.py "<path>\4x-UltraMix_Smooth.pth" app\models\4x-UltraMix_Smooth.onnx`.
- **Tools > Solve image background…** is the same white-and-black solver for ordinary art: it keeps the whole picture (no trim, resize or cut-out middle) and **Save and open as image** opens
  the result as the art image. Based on the author's "Image Background Solver V2" workflow.
- Settings persist in the Electron user-data folder. F12 opens DevTools.

## License
MIT, see `app/LICENSE`.
