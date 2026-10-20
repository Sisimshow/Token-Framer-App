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
  (non-recursive) whose name has no "Token"/"Frame"; `X Token.webp` already present = unchecked unless "Overwrite existing".
- Click a thumbnail to preview it. Tick **Edit this image only** to store changes for that image alone (purple dot);
  otherwise changes are shared by the whole batch.
  The box follows the image, and it switches on by itself when you change the cutout settings (AI, feather/grow/defringe, edits)
  or any pop-out setting (enable, arc, rotation, center), since those belong to one image.
- **Save all** (appears with 2+ images) writes `<name> Token.webp` next to each source. **Save token** / **Save as…** do the current image.
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
- Settings persist in the Electron user-data folder. F12 opens DevTools.

## License
MIT, see `app/LICENSE`.
