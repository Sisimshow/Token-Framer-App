# Pixel pen and main preview (design notes)

Detail moved out of .claude/CLAUDE.md. Read before touching the brush/pen, zoom, pan or preview buffer.

- A brush of 1 to 3 px is a pixel pen (`penSize`/`penAnchor`/`stampPixelStroke` in `colorremoval.js`; edit `{type:'brush', px: 1|2|3, pts: integer anchor pixels}`; size 3 is centred on the pixel under the pointer, 2 on the nearest corner):
  whole pixels under the pointer joined by a Bresenham line, the ring becomes a pixel square. The 1 px pen is pixel-perfect (`penPathAdd`, as in Aseprite): L-shaped corner pixels
  that a hand-drawn diagonal picks up are dropped live (`livePenPath` puts them back as they were) and the edit's `pts` is the finished pixel path. A sharp 90° turn loses its corner pixel, by design. Older disc-based brush edits (no `px`) are replayed as before (they rounded the pointer to the nearest pixel centre, half a pixel off).
- The main window's preview: the composite is rendered into an off-screen buffer (`state.prevBuf`, 800 px, 1600 in pixel view, up to 4096 while zoomed: `previewSize()`; a 4096 px
  composite takes about 50 ms) and `blitPreview()` draws the visible part into `#preview`, which is sized to whole device pixels. Zoom (max 20x) and pan are applied there, NOT as a CSS
  transform: Chromium drew a CSS-zoomed canvas up to ~4 px away from its own getBoundingClientRect at 20x, so the pixel seen under the pointer was not the one erased. All pointer maths
  goes through `compRect()` (where the whole composite is on screen). With the pen in hand and the art magnified (`penCrisp()`) the art is drawn nearest neighbour and the pen maps the
  pointer through exactly that drawing (`penAnchorAt`, `penBlockRect`). A pen click ignores the first 4 CSS px of movement (`PEN_DEAD_ZONE`), so a shaky click stays one pixel.
  **Exact pen view** (with a 1-3 px pen in hand): the whole-composite buffer made art pixels 1 or 2 buffer pixels wide (2048 art in a 4096 buffer) and zoom only enlarged that, so the
  main window now (a) snaps the zoom to whole device pixels per source pixel (`penUnit`, `snapPenZoom`, the wheel steps k by at least 1 per notch, max just under 20x; triggers: pen picked
  up, brush size, image change, resize; an art-scale slider mid-zoom is NOT followed, the preview falls back until the next zoom step) and (b) while `penExactK()` is a whole k, composites
  ONLY the visible window at device resolution (`compositeImage(..., size = D*z, { view: {x, y, w: D, h: D}, snapArt, crisp })`: every layer canvas window-sized and shifted, clipped to the
  composite's square; a test proves a window equals the crop of the full composite) with the art on whole pixels, so every source pixel is an identical k x k block (a test measures the runs
  in `#preview`, also at 125% scaling). `state.exact` {S, k, bx, by} drives `penAnchorAt`/`penBlockRect`; `state.prevBufRect` says which part of the composite the buffer holds (blitPreview
  draws a stale window shifted/scaled until the re-render); `state.prevFor` + `bufferFits()` decide re-renders. A zoom/pan in (or out of) this view re-renders synchronously in `applyView` (only microtasks before the paint), not via `schedulePreview`: a timer render showed the shrunk old window's empty edges (checkerboard) for one frame. Exports never pass `view`/`snapArt` and are unchanged.
  Pen feedback (found with a Codex review): the square is drawn at its TRUE size (it used to be forced to 3 px, so at fit zoom a 1 px pen looked like 8 pixels; a magenta 'tiny' dot style was tried and dropped: the user found it distracting) and the native cursor is hidden while it shows
  (CSS `:has()` on the square`s own state, not a class, so it cannot go stale); during the click dead zone the square stays on the pixel that will be painted; a stroke is fed every `getCoalescedEvents()` sample and the pointer-up position (`strokeStep` in `app.js` and `bgremove.js`); and a status/message line says so
  when one screen pixel covers more than one image pixel (`penZoomHint`): zoomed out like that the mouse cannot reach every pixel, which no code can fix.
