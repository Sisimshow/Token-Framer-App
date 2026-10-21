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
- **Background removal** (for pop-out tokens). With **Pop-out layer only** on (default), the cutout only affects the
  pop-out layer above the frame; the art under the frame stays intact. Untick it to cut out both layers.
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
  Based on the author's ComfyUI "Token Background Solver V2" workflow, without its optional image-cleanup model step.
- **Converted image models** (for the optional PureVision pre-clean) live in `app/models/*.onnx` and are not tracked by git. Recreate one with ComfyUI's Python (ComfyUI need not be running): 
  `E:\SwarmUI\dlbackend\comfy\python_embeded\python.exe app	ools\convert-model.py "<path>x_PureVision.pth" app\modelsx_PureVision.onnx`.
- Settings persist in the Electron user-data folder. F12 opens DevTools.

## License
MIT, see `app/LICENSE`.
