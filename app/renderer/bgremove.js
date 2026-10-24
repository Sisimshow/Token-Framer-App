// "Remove image background" / "Remove frame background" tool: the cutout tools of the main window (AI remove, remove a colour, magic wand, brush, rectangle) on a screen of
// their own, for one image or frame at a time. The maths is the main window's own (lib/colorremoval.js: buildEditedMask -> applyRemovalMask); this file only holds the
// screen: local state, zoom/pan, pointer tools and saving. Edits belong to this screen and last until another image is opened (or the app is closed); the main window's
// per-image edits are never touched. Saved as a full-size PNG (a transparent cutout cannot be a lossy WebP).
import { DEFAULTS } from './lib/composite.js';
import { applyRemovalMask, buildEditedMask, penAnchor, penPathAdd, penSize, stampPixelStroke, stampStroke } from './lib/colorremoval.js';
import { DEFAULTS as CF_DEFAULTS } from './lib/cleanframe.js';
import { buildControls, el, makeRpc } from './ui-kit.js';

const $ = (s, r = document) => r.querySelector(s);
const KEYS = ['crEnabled', 'crColor', 'crThreshold', 'crEdgesOnly', 'crFeather', 'crGrow', 'crDefringe', 'aiSensitivity', 'aiBlur', 'aiOffset', 'wandTolerance', 'wandContiguous', 'brushSize', 'brushMode'];
const CLEAN_KEYS = Object.keys(CF_DEFAULTS);   // the Clean frame settings (frame mode): refine radius, floor/ceiling, trim, resize
const BACKGROUNDS = { checker: '', black: '#000', white: '#fff', magenta: '#ff00ff', green: '#00b140' };
const TOOL_HINTS = {
  wand: 'Wand: click the background you want cut out (Tolerance and Contiguous are below).',
  brush: 'Brush: drag to erase (or restore, see Brush mode). From 1 to 3 px it paints exact pixels.',
  rect: 'Rectangle: drag a box to erase everything inside it.'
};
const HELP = 'Scroll to zoom, hold Space and drag (or middle mouse) to pan, 0 resets the zoom.';

export function initBgRemover({ api, openImages, loadFrame, dirOf, sepOf, baseOf, computeMatte, ensureAiModel }) {
  const root = $('#bgremove');
  const canvas = $('#brPreview');
  const ctx = canvas.getContext('2d');
  let S = canvas.width;                         // the canvas' backing size in device pixels; kept equal to what is shown (see sizeCanvas), so nothing is ever resampled by the browser
  const stage = canvas.parentElement;           // .tsView, the positioning parent of the brush ring and the rubber band
  const defaults = () => ({ ...Object.fromEntries(KEYS.map((k) => [k, DEFAULTS[k]])), ...CF_DEFAULTS, cleanEnabled: true });
  const params = defaults();
  const rpc = makeRpc('lib/cleanframe.worker.js', (m) => setMsg(`The cleanup worker stopped: ${m}`, true));
  let cleanCanvas = null, cleanInfo = null, cleanStale = true, cleaning = false, cleanAgain = false, cleanTimer = 0;   // the cleaned frame (frame mode): the cutout run through lib/cleanframe.js in a worker
  let mode = 'image';                           // 'image' or 'frame': only the title, the default name and the second save button differ
  let src = null;                               // { path, name, w, h, canvas (the original), id (its ImageData, never changed) }
  let matte = null;                             // RMBG matte of `src`, once AI remove has run
  let edits = [], redoStack = [];               // {type:'ai'} | {type:'wand'|'rect'|'brush'}, see colorremoval.js
  let out = null, outCtx = null;                // the cutout (full size), what is shown and saved
  let tool = null, viewMode = 'cutout', busy = false, space = false, ui = null;
  let stroke = null, rect = null, pan = null, rebuildTimer = 0;
  const view = { a: 1, ox: 0, oy: 0, fitted: true }; // a: device pixels per image pixel; ox/oy: where the image's top-left corner is, in device pixels; fitted: showing the whole image

  const setMsg = (text, warn = false) => { const m = $('#brMsg'); m.textContent = text; m.style.color = warn ? 'var(--warn)' : ''; };
  const hasAi = () => edits.some((e) => e.type === 'ai');
  const hasCut = () => params.crEnabled || edits.length > 0;
  const ring = el('div', 'brRing'), band = el('div', 'brBand');
  ring.hidden = band.hidden = true;
  stage.append(ring, band);

  // ---------------------------------------------------------------- the cutout
  /** Full recompute, exactly the main window's buildCut: colour mask + ordered edits, then grow / feather / defringe once. */
  function rebuild() {
    if (!src) return;
    if (!out) { out = document.createElement('canvas'); out.width = src.w; out.height = src.h; outCtx = out.getContext('2d', { willReadFrequently: true }); }
    const id = new ImageData(new Uint8ClampedArray(src.id.data), src.w, src.h);
    if (hasCut()) {
      const { mask, color, fixed } = buildEditedMask(id, params, edits, matte);
      applyRemovalMask(id, mask, color, params.crFeather, params.crGrow, params.crDefringe, fixed);
    }
    outCtx.putImageData(id, 0, 0);
    cleanStale = true;
    scheduleClean();
    redraw();
    syncUi();
  }

  // ---------------------------------------------------------------- frame cleaning (frame mode only, can be switched off)
  const wantClean = () => mode === 'frame' && params.cleanEnabled && !!out;
  const outBytes = () => { const d = outCtx.getImageData(0, 0, out.width, out.height).data; return d.buffer; };
  /** Hands the current cutout to the worker (once per change, not once per slider move). */
  async function feedClean() {
    if (!cleanStale) return;
    cleanStale = false;
    const buf = outBytes();
    const r = await rpc.ask({ type: 'setImage', rgba: buf, w: out.width, h: out.height }, [buf]);
    cleanInfo = { hasAlpha: r.hasAlpha };
  }
  function scheduleClean() { clearTimeout(cleanTimer); cleanTimer = setTimeout(cleanRun, 80); }
  async function cleanRun() {
    if (cleaning) { cleanAgain = true; return; }
    if (!wantClean()) { cleanCanvas = null; return; }
    cleaning = true;
    try {
      do {
        cleanAgain = false;
        await feedClean();
        const r = await rpc.ask({ type: 'preview', params: { ...params } });
        cleanInfo = { hasAlpha: r.hasAlpha, w: r.w, h: r.h, ms: r.ms };
        const c = document.createElement('canvas'); c.width = r.w; c.height = r.h;
        c.getContext('2d').putImageData(new ImageData(r.rgba, r.w, r.h), 0, 0);
        cleanCanvas = c;
        if (!tool && viewMode === 'cleaned') setMsg(cleanMsg());
        redraw();
      } while (cleanAgain || cleanStale);
    } catch (err) {
      setMsg(`Could not clean the frame: ${err.message}`, true);
    } finally {
      cleaning = false;
    }
  }
  const cleanOut = () => (params.resize === 'none' ? `${cleanInfo?.w}×${cleanInfo?.h}` : `${params.size}×${params.size}`);
  const cleanMsg = () => (cleanInfo?.hasAlpha === false
    ? 'There is no transparency yet, so there is nothing to refine or trim. Cut the background out first.'
    : `Cleaned frame: trimmed to ${cleanInfo?.w}×${cleanInfo?.h} (from ${src.w}×${src.h}), output ${cleanOut()}. Save writes this.`);
  /** A slider can fire many times a second: rebuild once things settle. */
  function schedule() { clearTimeout(rebuildTimer); rebuildTimer = setTimeout(rebuild, 30); }
  function pushEdit(op) {
    edits = [...edits, op]; redoStack = [];
    rebuild();
  }
  function undo() { if (!edits.length) return; redoStack.push(edits[edits.length - 1]); edits = edits.slice(0, -1); rebuild(); }
  function redo() { if (!redoStack.length) return; edits = [...edits, redoStack.pop()]; rebuild(); }
  function resetEdits(ask = true) {
    if (!edits.length) return;
    if (ask && !confirm('Remove all AI, wand, brush and rectangle edits on this image?')) return;
    edits = []; redoStack = [];
    rebuild();
  }

  async function runAi() {
    if (!src) return setMsg('Open an image first.', true);
    const job = src;
    try {
      if (!(await ensureAiModel())) return;
      setMsg('Running RMBG-2.0…');
      const m = await computeMatte(src.canvas);
      if (job !== src) return;                  // another image was opened meanwhile
      matte = m;
      if (hasAi()) rebuild(); else pushEdit({ type: 'ai' });
      const st = await api.getAiStatus();
      setMsg(`AI cutout done on ${st.provider}. Tweak sensitivity, blur and offset, or fix details with the brush. ${HELP}`);
    } catch (err) {
      setMsg(`AI remove failed: ${err.message}`, true);
    } finally {
      $('#brProg').hidden = true;
    }
  }
  api.onAiProgress(({ got, total }) => {
    if (root.hidden) return;
    const p = $('#brProg');
    p.hidden = false; p.max = total; p.value = got;
    setMsg(`Downloading the RMBG-2.0 model: ${Math.round(got / 1e6)} of ${Math.round(total / 1e6)} MB`);
  });

  // ---------------------------------------------------------------- drawing and the view
  // Precision matters here: a pixel pen is only as good as what is drawn. The canvas is exactly as many device pixels as it is shown at, and from 1 device pixel per image
  // pixel upwards the zoom is a whole number and the image sits on whole device pixels, so every image pixel is an exact k x k block (nearest neighbour, no dashes). Below
  // that the image is smoothed. ONE layout (origin()) serves the drawing, the pointer mapping and the brush ring, so they cannot drift apart.
  const MAX_A = 64;
  const shownImage = () => (viewMode === 'original' ? src?.canvas : viewMode === 'cleaned' && wantClean() ? cleanCanvas : out);
  const fitA = (w, h) => { const b = S / Math.max(w, h); return b >= 1 ? Math.floor(b) : b; };   // the whole image, at a whole zoom when it is smaller than the canvas
  function fitView(w, h) { view.a = fitA(w, h); view.ox = (S - w * view.a) / 2; view.oy = (S - h * view.a) / 2; view.fitted = true; }
  /** The layout in use: zoom and image origin, snapped to whole device pixels when the image is enlarged. */
  function origin() {
    if (view.a < 1) return { a: view.a, ox: view.ox, oy: view.oy };
    return { a: Math.max(1, Math.round(view.a)), ox: Math.round(view.ox), oy: Math.round(view.oy) };
  }
  function redraw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S, S);
    const showClean = viewMode === 'cleaned' && wantClean();
    const img = shownImage();
    if (!img) return;
    ctx.imageSmoothingQuality = 'high';
    if (showClean && params.resize === 'stretch') { ctx.imageSmoothingEnabled = true; ctx.drawImage(img, 0, 0, S, S); } // squeezed to the square, as the export does
    else {
      if (view.fitted) fitView(img.width, img.height);
      const { a, ox, oy } = origin();
      if (a >= 1) { // enlarged: real pixels, drawn only where they are visible
        ctx.imageSmoothingEnabled = false;
        const x0 = Math.max(0, Math.floor(-ox / a)), x1 = Math.min(img.width, Math.ceil((S - ox) / a)), y0 = Math.max(0, Math.floor(-oy / a)), y1 = Math.min(img.height, Math.ceil((S - oy) / a));
        if (x1 > x0 && y1 > y0) ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0, ox + x0 * a, oy + y0 * a, (x1 - x0) * a, (y1 - y0) * a);
      } else { ctx.imageSmoothingEnabled = true; ctx.drawImage(img, ox, oy, img.width * a, img.height * a); }
    }
    const a = origin().a;
    $('#brBadge').textContent = src ? `${viewMode === 'original' ? 'Original' : showClean ? 'Cleaned frame' : 'Cutout'}${view.fitted ? '' : ` · ${Math.round((a / (window.devicePixelRatio || 1)) * 100)}%`}` : '';
  }
  const resetView = () => { const img = shownImage(); if (img) fitView(img.width, img.height); else view.fitted = true; redraw(); };

  /** The canvas' content box in client coordinates (getBoundingClientRect includes the border, which is not part of the drawing). */
  function box() {
    const r = canvas.getBoundingClientRect(), bl = canvas.clientLeft, bt = canvas.clientTop;
    return { l: r.left + bl, t: r.top + bt, w: r.width - 2 * bl, h: r.height - 2 * bt };
  }
  const devPoint = (e) => { const b = box(); return { x: ((e.clientX - b.l) / b.w) * S, y: ((e.clientY - b.t) / b.h) * S }; };
  /** Pointer -> image coordinates, where pixel i spans [i, i + 1) (so the pixel under the pointer is floor). */
  function srcPoint(e) {
    if (!src) return null;
    const d = devPoint(e), { a, ox, oy } = origin();
    return { x: (d.x - ox) / a, y: (d.y - oy) / a };
  }
  /** Image coordinates -> client coordinates: the inverse of srcPoint. */
  function clientOf(x, y) {
    const b = box(), { a, ox, oy } = origin();
    return { x: b.l + ((ox + x * a) / S) * b.w, y: b.t + ((oy + y * a) / S) * b.h };
  }
  const cssPerPx = () => (origin().a / S) * box().w;   // on-screen (CSS) pixels per image pixel
  const insideImage = (p) => p.x >= 0 && p.y >= 0 && p.x < src.w && p.y < src.h;

  /** Zoom to `aNew` keeping the image point under `p` (device pixels) where it is. */
  function setScale(aNew, p) {
    const img = shownImage(); if (!img) return;
    const o = origin(), lo = fitA(img.width, img.height);
    aNew = Math.min(MAX_A, Math.max(lo, aNew));
    if (aNew <= lo) { fitView(img.width, img.height); return redraw(); }
    const sx = (p.x - o.ox) / o.a, sy = (p.y - o.oy) / o.a;
    view.a = aNew; view.ox = p.x - sx * aNew; view.oy = p.y - sy * aNew; view.fitted = false;
    redraw();
  }
  const stepIn = (a) => (a < 1 ? Math.min(1, a * 1.25) : Math.floor(a + 1e-9) + 1);
  const stepOut = (a, lo) => Math.max(lo, a > 1 ? Math.ceil(a - 1e-9) - 1 : a / 1.25);
  let wheelAcc = 0;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const img = shownImage(); if (!img) return;
    wheelAcc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    const steps = Math.trunc(wheelAcc / 100);
    if (!steps) return;
    wheelAcc -= steps * 100;
    let a = origin().a;
    const lo = fitA(img.width, img.height);
    for (let i = 0; i < Math.abs(steps); i++) a = steps < 0 ? stepIn(a) : stepOut(a, lo);
    setScale(a, devPoint(e));
  }, { passive: false });

  /** Keep the canvas exactly as large as it is shown, in whole device pixels. Runs whenever the room for it changes. */
  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = canvas.style.height = '';                        // measure the size the layout gives it
    const nat = canvas.getBoundingClientRect().width, bw = canvas.clientLeft;
    if (!(nat > 8)) return;                                               // hidden
    const n = Math.max(64, Math.floor((nat - 2 * bw) * dpr));
    canvas.style.width = canvas.style.height = `${n / dpr + 2 * bw}px`;
    // and on whole device pixels: centred in its column it can sit at a fraction of a pixel, which the browser rounds away when it draws it
    canvas.style.position = 'relative'; canvas.style.left = canvas.style.top = '0px';
    const rb = canvas.getBoundingClientRect(), cl = rb.left + bw, ct = rb.top + canvas.clientTop;
    canvas.style.left = `${Math.round(cl * dpr) / dpr - cl}px`; canvas.style.top = `${Math.round(ct * dpr) / dpr - ct}px`;
    if (n === S && canvas.width === n) return;
    const o = origin(), img = shownImage();
    const cx = (S / 2 - o.ox) / o.a, cy = (S / 2 - o.oy) / o.a;           // the image point at the middle, to keep it there
    S = canvas.width = canvas.height = n;
    if (!img || view.fitted) { view.fitted = true; return redraw(); }
    const a = Math.min(MAX_A, Math.max(fitA(img.width, img.height), view.a >= 1 ? Math.max(1, Math.round(view.a)) : view.a));
    view.a = a; view.ox = S / 2 - cx * a; view.oy = S / 2 - cy * a;
    redraw();
  }
  new ResizeObserver(sizeCanvas).observe(stage);

  // ---------------------------------------------------------------- tools
  function setTool(t) {
    tool = tool === t ? null : t;
    stroke = null; rect = null; ring.hidden = band.hidden = true;
    canvas.classList.toggle('tool', !!tool);
    if (tool) setMsg(`${TOOL_HINTS[tool]} ${HELP}`); else if (src) setMsg(HELP);
    syncUi();
  }

  /** Live brush feedback: stamp the new segment into the shown cutout (hard edge only; the full refinement runs on release). */
  function liveBrush(seg) {
    const s = stroke, w = src.w, h = src.h;
    if (!s.touched) s.touched = new Uint8Array(w * h);
    const reach = s.pen ? s.pen : s.r + 1;                 // how far the stamp reaches from a point: a pen block grows right and down from its anchor
    if (s.pen) stampPixelStroke(s.touched, w, h, seg, s.pen, 1); else stampStroke(s.touched, w, h, seg, s.r, 1);
    const xs = seg.map((p) => p[0]), ys = seg.map((p) => p[1]), lo = s.pen ? 0 : reach;
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - lo)), x1 = Math.min(w - 1, Math.ceil(Math.max(...xs) + reach));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) - lo)), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys) + reach));
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const id = outCtx.getImageData(x0, y0, bw, bh);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const gi = y * w + x;
        if (!s.touched[gi]) continue;
        const li = ((y - y0) * bw + (x - x0)) * 4;
        if (s.mode === 'restore') for (let k = 0; k < 4; k++) id.data[li + k] = src.id.data[gi * 4 + k];
        else id.data[li + 3] = 0;
      }
    }
    outCtx.putImageData(id, x0, y0);
    redraw();
  }
  /** The 1 px pen's pixel-perfect path (penPathAdd): paint the new pixels, put a dropped corner pixel back as it was before the stroke. */
  function livePenPath(to) {
    const s = stroke, w = src.w;
    const before = s.path.length ? s.path[s.path.length - 1] : null;
    const { added, removed } = penPathAdd(s.path, to);
    for (const [x, y] of added) {
      const k = y * w + x, n = s.uses.get(k) || 0;
      if (!n && !s.prior.has(k) && x >= 0 && y >= 0 && x < w && y < src.h) s.prior.set(k, outCtx.getImageData(x, y, 1, 1));
      s.uses.set(k, n + 1);
    }
    liveBrush(before ? [before, ...added] : added);
    for (const [x, y] of removed) {
      const k = y * w + x, n = (s.uses.get(k) || 1) - 1;
      s.uses.set(k, n);
      const pr = n ? null : s.prior.get(k);
      if (pr) { outCtx.putImageData(pr, x, y); if (s.touched) s.touched[k] = 0; }
    }
    if (removed.length) redraw();
  }

  let penHinted = false;
  /** Said once while the pen is used zoomed so far out that a screen pixel covers several image pixels: the mouse physically cannot reach every pixel then. */
  function penZoomHint(devPerPx) {
    if (devPerPx >= 1) { penHinted = false; return; }
    if (penHinted) return;
    penHinted = true;
    setMsg(`Zoomed out: one screen pixel covers about ${Math.ceil(1 / devPerPx)} image pixels, so the pen cannot hit each one. Scroll to zoom in until a pixel is at least a screen pixel wide.`);
  }
  /** One pointer sample of a brush stroke (a pen sample goes through the click dead zone and the pixel-perfect path). Fast drags deliver several samples per event: the caller feeds them all. */
  function strokeStep(e) {
    const s = stroke;
    if (!s) return;
    const p = srcPoint(e), last = s.pts[s.pts.length - 1];
    if (s.pen) {
      if (!s.moved && Math.hypot(e.clientX - s.downX, e.clientY - s.downY) < 4) return; // a click is one pixel even if the hand shakes a little while pressing
      s.moved = true;
      const a = penAnchor(p.x, p.y, s.pen);
      if (a[0] !== last[0] || a[1] !== last[1]) { s.pts.push(a); if (s.path) livePenPath(a); else liveBrush([last, a]); }
    } else if (Math.hypot(p.x - last[0], p.y - last[1]) >= Math.max(1, s.r / 4)) { s.pts.push([p.x, p.y]); liveBrush([last, [p.x, p.y]]); }
  }

  const panning = (e) => space || e.button === 1;
  canvas.addEventListener('pointerdown', (e) => {
    if (!src) return;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* a synthetic event has no real pointer */ }
    if (panning(e) || !tool || viewMode !== 'cutout') { if (!view.fitted) pan = { px: e.clientX, py: e.clientY, x: view.ox, y: view.oy }; return; }
    if (e.button !== 0) return;
    const p = srcPoint(e);
    if (tool === 'wand') {
      if (insideImage(p)) pushEdit({ type: 'wand', x: Math.round(p.x), y: Math.round(p.y), tol: params.wandTolerance, contiguous: !!params.wandContiguous });
    } else if (tool === 'brush') {
      const pen = penSize(params.brushSize);
      stroke = { r: Math.max(0.5, params.brushSize / 2), pen, mode: params.brushMode, pts: [pen ? penAnchor(p.x, p.y, pen) : [p.x, p.y]], touched: null, downX: e.clientX, downY: e.clientY, moved: false };
      if (pen === 1) { Object.assign(stroke, { path: [], uses: new Map(), prior: new Map() }); livePenPath(stroke.pts[0]); }
      else liveBrush(stroke.pts);
    } else if (tool === 'rect') {
      rect = { x0: p.x, y0: p.y, vx: e.clientX, vy: e.clientY };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const sr = stage.getBoundingClientRect();
    if (pan) {
      const b = box();
      view.ox = pan.x + ((e.clientX - pan.px) / b.w) * S; view.oy = pan.y + ((e.clientY - pan.py) / b.h) * S;
      redraw();
      return;
    }
    if (tool === 'brush' && src && !space) {
      const pen = penSize(params.brushSize), perPx = cssPerPx();   // on-screen px per source pixel
      const d = Math.max(3, params.brushSize * perPx);                // brush size is in source pixels
      ring.classList.toggle('pen', !!pen);
      if (pen) { // the pen paints whole pixels: show the exact block that the next click will hit, snapped to the pixel grid, at its TRUE size
        // while a click is still inside its dead zone the stroke is stuck on its first pixel, so the square stays there too
        const stuck = stroke?.pen && !stroke.moved && Math.hypot(e.clientX - stroke.downX, e.clientY - stroke.downY) < 4;
        const q = srcPoint(e), a = stuck ? stroke.pts[0] : penAnchor(q.x, q.y, pen), lt = clientOf(a[0], a[1]), rb = clientOf(a[0] + pen, a[1] + pen);   // the block's own corners: the square IS those pixels
        ring.style.width = `${rb.x - lt.x}px`; ring.style.height = `${rb.y - lt.y}px`;
        ring.style.left = `${lt.x - sr.left}px`; ring.style.top = `${lt.y - sr.top}px`;
        penZoomHint(perPx * devicePixelRatio);
      } else {
        ring.style.width = ring.style.height = `${d}px`;
        ring.style.left = `${e.clientX - sr.left}px`; ring.style.top = `${e.clientY - sr.top}px`;
      }
      ring.hidden = false;
    } else ring.hidden = true;
    if (stroke) {
      const samples = e.getCoalescedEvents?.();
      for (const ev of samples?.length ? samples : [e]) strokeStep(ev);   // every sample the mouse gave, not just the last one per frame
    } else if (rect) {
      band.hidden = false;
      band.style.left = `${Math.min(rect.vx, e.clientX) - sr.left}px`; band.style.top = `${Math.min(rect.vy, e.clientY) - sr.top}px`;
      band.style.width = `${Math.abs(e.clientX - rect.vx)}px`; band.style.height = `${Math.abs(e.clientY - rect.vy)}px`;
    }
  });
  canvas.addEventListener('pointerleave', () => { ring.hidden = true; });
  const pointerEnd = (e) => {
    pan = null;
    if (stroke) {
      if (stroke.pen) strokeStep(e);   // where the button was let go counts, even if no move event reported it
      const s = stroke; stroke = null;
      const r1 = (v) => Math.round(v * 10) / 10;
      if (s.pen) pushEdit({ type: 'brush', mode: s.mode, r: s.pen / 2, px: s.pen, pts: s.path || s.pts });   // pen: integer pixels, kept exactly (1 px: the pixel-perfect path)
      else pushEdit({ type: 'brush', mode: s.mode, r: r1(s.r), pts: s.pts.map(([x, y]) => [r1(x), r1(y)]) });
    } else if (rect) {
      const d = rect; rect = null; band.hidden = true;
      const p = srcPoint(e);
      if (Math.abs(e.clientX - d.vx) + Math.abs(e.clientY - d.vy) > 3) pushEdit({ type: 'rect', x0: d.x0, y0: d.y0, x1: p.x, y1: p.y });
    }
  };
  canvas.addEventListener('pointerup', pointerEnd);
  canvas.addEventListener('pointercancel', () => { pan = null; stroke = null; rect = null; band.hidden = true; rebuild(); });

  // Keyboard: the main window ignores keys while a tool screen is open, so this screen handles its own. The listener is in the capture phase so that Esc
  // can put a tool down without the main handler closing the whole screen (and with it every edit).
  window.addEventListener('keydown', (e) => {
    if (root.hidden) return;
    const t = e.target;
    const typing = t && ((t.tagName === 'INPUT' && !['range', 'checkbox', 'color'].includes(t.type)) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    if (e.code === 'Space' && !typing && t?.tagName !== 'BUTTON') { space = true; canvas.classList.add('panmode'); ring.hidden = true; e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (typing) return;
    const k = e.key.toLowerCase();
    if (k === 'escape' && tool) { setTool(tool); e.stopImmediatePropagation(); return; }
    if (e.ctrlKey && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (e.ctrlKey && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (!e.ctrlKey && !e.altKey && !e.metaKey && { w: 'wand', b: 'brush', r: 'rect' }[k] && src) setTool({ w: 'wand', b: 'brush', r: 'rect' }[k]);
    else if (!e.ctrlKey && !e.altKey && k === '0') resetView();
  }, true);
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') { space = false; canvas.classList.remove('panmode'); } }, true);

  // ---------------------------------------------------------------- controls
  const SPEC = [
    { t: 'subhead', label: 'AI cutout' },
    { t: 'custom', full: true, build(ctl) {
      ctl.classList.add('wrap');
      const b = el('button', null, 'AI remove (RMBG-2.0)');
      b.addEventListener('click', runAi);
      ctl.append(b, el('span', 'hint', 'Needs a one-time model download'));
      return () => { b.disabled = !src; };
    } },
    { k: 'aiSensitivity', label: 'Sensitivity', min: 0, max: 1, step: 0.01, tip: 'How much of the AI matte counts as background. Lower keeps more.' },
    { k: 'aiBlur', label: 'Mask blur', min: 0, max: 64, step: 1, tip: 'Softens the edge of the AI mask.' },
    { k: 'aiOffset', label: 'Mask offset', min: -64, max: 64, step: 1, tip: 'Shrinks (negative) or grows (positive) the AI mask in pixels.' },
    { t: 'subhead', label: 'By color' },
    { t: 'tint', k: 'crEnabled', k2: 'crColor', label: 'Remove color' },
    { k: 'crThreshold', label: 'Threshold', min: 0, max: 100, step: 1, show: (p) => p.crEnabled },
    { k: 'crEdgesOnly', label: 'Edges only', t: 'check', show: (p) => p.crEnabled, tip: 'Only remove the colour where it touches the border of the image.' },
    { t: 'subhead', label: 'Edge cleanup' },
    { k: 'crFeather', label: 'Feather', min: 0, max: 10, step: 1, tip: 'Applies to the cutout above and to wand edits.' },
    { k: 'crGrow', label: 'Grow', min: 0, max: 10, step: 1 },
    { k: 'crDefringe', label: 'Defringe', min: 0, max: 100, step: 1 },
    { t: 'subhead', label: 'Touch up by hand' },
    { t: 'custom', full: true, build(ctl) {
      ctl.classList.add('toolgrid');
      const btn = (id, text, fn, tip) => { const b = el('button', null, text); b.dataset.id = id; b.title = tip; b.addEventListener('click', fn); ctl.append(b); return b; };
      btn('wand', 'Wand', () => setTool('wand'), 'Shortcut: W');
      btn('brush', 'Brush', () => setTool('brush'), 'Shortcut: B');
      btn('rect', 'Rectangle', () => setTool('rect'), 'Shortcut: R');
      btn('undo', 'Undo', undo, 'Shortcut: Ctrl+Z');
      btn('redo', 'Redo', redo, 'Shortcut: Ctrl+Y');
      btn('reset', 'Reset edit', () => resetEdits(), 'Remove every AI, wand, brush and rectangle edit');
      const count = el('span', 'hint'); ctl.append(count);
      return () => {
        ctl.querySelectorAll('button').forEach((b) => {
          const id = b.dataset.id;
          b.classList.toggle('active', id === tool);
          if (id === 'undo' || id === 'reset') b.disabled = !edits.length;
          if (id === 'redo') b.disabled = !redoStack.length;
          if (id === 'wand' || id === 'brush' || id === 'rect') b.disabled = !src;
        });
        count.textContent = edits.length ? `${edits.length} edit${edits.length === 1 ? '' : 's'}` : '';
      };
    } },
    { k: 'wandTolerance', label: 'Wand tolerance', min: 0, max: 100, step: 1, show: () => tool === 'wand' },
    { k: 'wandContiguous', label: 'Wand contiguous', t: 'check', show: () => tool === 'wand' },
    { k: 'brushSize', label: 'Brush (image px)', min: 1, max: 600, step: 1, show: () => tool === 'brush' },
    { k: 'brushMode', label: 'Brush mode', t: 'select', opts: [['erase', 'Erase'], ['restore', 'Restore']], show: () => tool === 'brush' },
    { t: 'subhead', label: 'Clean frame', show: () => mode === 'frame' },
    { k: 'cleanEnabled', label: 'Clean the frame', t: 'check', show: () => mode === 'frame', tip: 'Run the finished cutout through the Clean frame steps when saving: refine the edges, trim the empty border, resize. Turn it off to save the cutout as it is.' },
    ...[
      { k: 'radius', label: 'Refine radius', min: 0, max: 10, step: 1, tip: 'Radius in pixels of the original image for the alpha refinement. Bigger smooths more noise but softens fine detail. 0 skips the refinement.' },
      { k: 'smoothing', label: 'Smoothing', min: 0.0001, nmin: 0.000001, max: 0.1, step: 0.0001, tip: 'How strongly the refinement follows the image colours (the filter\'s regulariser). Very small values can look noisy.' },
      { k: 'floor', label: 'Alpha floor', min: 0, max: 1, step: 0.01, tip: 'After refining, alpha below this becomes fully transparent. 0 turns it off.' },
      { k: 'solidify', label: 'Solidify', min: 0, max: 4, step: 1, tip: 'Firms up semi-transparent pixels, like stacking the image on itself. Each step roughly doubles the effect.' },
      { k: 'ceiling', label: 'Alpha ceiling', min: 0, max: 1, step: 0.01, tip: 'After solidifying, alpha above this becomes fully opaque. 1 turns it off.' },
      { k: 'threshold', label: 'Crop threshold', min: 0, max: 1, step: 0.001, tip: 'Pixels with alpha above this count as part of the frame when trimming the empty border.' },
      { k: 'padding', label: 'Padding (px)', min: 0, max: 500, step: 1, tip: 'Extra pixels kept around the trimmed frame (never beyond the original image).' },
      { k: 'resize', label: 'Resize', t: 'select', opts: [['fit', 'Fit, pad to a square'], ['stretch', 'Stretch to a square'], ['none', 'Keep trimmed size']], tip: 'Fit keeps the aspect ratio and centres the frame on a transparent square. Stretch squeezes it to fill (what the ComfyUI workflow does).' },
      { k: 'size', label: 'Size (px)', min: 128, max: 8192, step: 1, numberOnly: true, show: (p) => p.resize !== 'none' }
    ].map((c) => ({ ...c, show: (p) => mode === 'frame' && p.cleanEnabled && (c.show ? c.show(p) : true) }))
  ];
  function onParam(k) {
    if (CLEAN_KEYS.includes(k) || k === 'cleanEnabled') {
      if (k === 'cleanEnabled' && !params.cleanEnabled) cleanCanvas = null;
      if (k === 'resize' || k === 'size') redraw(); else scheduleClean();   // the preview shows the trimmed frame, only the export is resized
      syncUi(); redraw();
      return;
    }
    if (k === 'brushSize' || k === 'brushMode' || k === 'wandTolerance' || k === 'wandContiguous') return; // only used by the next stroke or click
    schedule();
  }
  function syncUi() {
    ui?.sync();
    const viewSel = $('#brView'), cleanedOpt = viewSel.querySelector('option[value="cleaned"]');
    cleanedOpt.hidden = cleanedOpt.disabled = !(mode === 'frame' && params.cleanEnabled);
    if (viewMode === 'cleaned' && cleanedOpt.disabled) { viewMode = 'cutout'; redraw(); }
    viewSel.value = viewMode;
    const on = !!out;
    $('#brSave').disabled = $('#brSaveUse').disabled = !on || busy;
  }

  // ---------------------------------------------------------------- loading and saving
  let loadReq = 0;
  async function loadPath(p) {
    const req = ++loadReq;                      // the most recently chosen image wins, whichever finishes decoding last
    try {
      setMsg('Loading…');
      const bytes = await api.readFile(p);
      const bmp = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(bmp, 0, 0);
      bmp.close();
      if (req !== loadReq) return;
      src = { path: p, name: baseOf(p), w: c.width, h: c.height, canvas: c, id: x.getImageData(0, 0, c.width, c.height) };
      matte = null; edits = []; redoStack = []; out = null; tool = null; stroke = null; rect = null; canvas.classList.remove('tool');
      resetView();
      const label = $('#brName');
      label.textContent = p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
      label.title = p; label.classList.remove('muted');
      rebuild();
      setMsg(`${src.w}×${src.h} loaded. Remove the background with AI, a colour, or the wand, brush and rectangle. ${HELP}`);
    } catch (err) {
      setMsg(`Could not open that image: ${err.message}`, true);
    }
  }
  async function pickImage() {
    const picked = await api.pickImages({ multi: false });
    if (picked?.length) await loadPath(picked[0]);
  }

  async function saveTo(outPath) {
    if (!out) throw new Error('Open an image first');
    if (wantClean()) { // the finished cutout through the Clean frame steps, encoded by the worker
      clearTimeout(cleanTimer);
      await feedClean();
      const r = await rpc.ask({ type: 'export', params: { ...params } });
      await api.writeFile(outPath, r.png);
      return { path: outPath, w: r.w, h: r.h, bytes: r.png.length };
    }
    const blob = await new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('PNG encode failed'))), 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await api.writeFile(outPath, bytes);
    return { path: outPath, w: out.width, h: out.height, bytes: bytes.length };
  }
  function defaultName() {
    let base = src?.name || 'Image';
    if (mode === 'frame' && !/frame/i.test(base)) base += ' Frame'; // a frame's name keeps "frame" so folder mode never treats it as art
    const name = `${base} (cutout).png`;
    return src?.path ? `${dirOf(src.path)}${sepOf(src.path)}${name}` : name;
  }
  const useSaved = (p) => (mode === 'frame' ? loadFrame(p) : openImages([p]));
  async function saveClicked(andUse) {
    if (!out) return;
    let file = await api.pickSave(defaultName(), 'png');
    if (!file) return;
    if (!/\.png$/i.test(file)) file += '.png';
    busy = true; syncUi();
    try {
      setMsg('Saving…');
      const r = await saveTo(file);
      if (andUse) { await useSaved(file); close(); }
      else setMsg(`Saved ${r.path} (${r.w}×${r.h})`);
    } catch (err) {
      setMsg(`Could not save: ${err.message}`, true);
    } finally {
      busy = false; syncUi();
    }
  }

  // ---------------------------------------------------------------- open / close / wiring
  const isOpen = () => !root.hidden;
  /** mode 'image' or 'frame'. The loaded image and its edits stay when the screen is reopened from the other menu entry. */
  function open(nextMode = mode) {
    mode = nextMode;
    root.hidden = false;
    $('#brTitle').textContent = mode === 'frame' ? 'Remove frame background' : 'Remove image background';
    $('#brSaveUse').textContent = mode === 'frame' ? 'Save and use as frame' : 'Save and open as image';
    cleanCanvas = null; cleanStale = true; if (wantClean()) scheduleClean();
    $('#brSaveUse').title = mode === 'frame' ? 'Save the cutout as a PNG, then use it as the frame in Token Framer' : 'Save the cutout as a PNG, then open it in Token Framer as the art image';
    if (!ui) ui = buildControls($('#brControls'), SPEC, params, onParam);
    syncUi();
  }
  function close() { root.hidden = true; ring.hidden = band.hidden = true; }

  $('#brOpen').onclick = pickImage;
  $('#brClose').onclick = close;
  $('#brSave').onclick = () => saveClicked(false);
  $('#brSaveUse').onclick = () => saveClicked(true);
  $('#brReset').onclick = () => {
    if (src && (edits.length || params.crEnabled) && !confirm('Put every control back to its default and remove all edits?')) return;
    Object.assign(params, defaults());
    edits = []; redoStack = [];
    rebuild();
  };
  $('#brView').onchange = (e) => {
    viewMode = e.target.value; stroke = null; rect = null; ring.hidden = band.hidden = true; resetView();
    if (viewMode === 'cleaned') { if (cleanCanvas) setMsg(cleanMsg()); else scheduleClean(); }
  };
  $('#brBg').onchange = (e) => { canvas.style.background = BACKGROUNDS[e.target.value] || ''; };
  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', async (e) => { // not stopped, so the window-level handler still clears the drag highlight
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    const p = f && api.pathForFile(f);
    if (p) await loadPath(p);
  });

  return {
    open, close, isOpen, loadPath, saveTo, pushEdit, undo, redo, resetEdits, setTool, runAi,
    setParams(p) { Object.assign(params, p); clearTimeout(rebuildTimer); rebuild(); },
    get params() { return params; },
    get edits() { return edits; },
    get redoCount() { return redoStack.length; },
    get tool() { return tool; },
    get mode() { return mode; },
    get result() { return out; },
    get cleaned() { return wantClean() ? cleanCanvas : null; },
    get original() { return src?.canvas || null; },
    get matte() { return matte; },
    clientOf,   // (x, y) in image coordinates -> client coordinates (tests)
    async saveAndUse(outPath) { const r = await saveTo(outPath); await useSaved(outPath); close(); return r; }
  };
}
