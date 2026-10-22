// "Remove image background" / "Remove frame background" tool: the cutout tools of the main window (AI remove, remove a colour, magic wand, brush, rectangle) on a screen of
// their own, for one image or frame at a time. The maths is the main window's own (lib/colorremoval.js: buildEditedMask -> applyRemovalMask); this file only holds the
// screen: local state, zoom/pan, pointer tools and saving. Edits belong to this screen and last until another image is opened (or the app is closed); the main window's
// per-image edits are never touched. Saved as a full-size PNG (a transparent cutout cannot be a lossy WebP).
import { DEFAULTS } from './lib/composite.js';
import { applyRemovalMask, buildEditedMask, stampStroke } from './lib/colorremoval.js';
import { fitRect } from './lib/cleanframe.js';
import { buildControls, el } from './ui-kit.js';

const $ = (s, r = document) => r.querySelector(s);
const KEYS = ['crEnabled', 'crColor', 'crThreshold', 'crEdgesOnly', 'crFeather', 'crGrow', 'crDefringe', 'aiSensitivity', 'aiBlur', 'aiOffset', 'wandTolerance', 'wandContiguous', 'brushSize', 'brushMode'];
const BACKGROUNDS = { checker: '', black: '#000', white: '#fff', magenta: '#ff00ff', green: '#00b140' };
const TOOL_HINTS = {
  wand: 'Wand: click the background you want cut out (Tolerance and Contiguous are below).',
  brush: 'Brush: drag to erase (or restore, see Brush mode).',
  rect: 'Rectangle: drag a box to erase everything inside it.'
};
const HELP = 'Scroll to zoom, hold Space and drag (or middle mouse) to pan, 0 resets the zoom.';

export function initBgRemover({ api, openImages, loadFrame, dirOf, sepOf, baseOf, computeMatte, ensureAiModel }) {
  const root = $('#bgremove');
  const canvas = $('#brPreview');
  const ctx = canvas.getContext('2d');
  const S = canvas.width;
  const stage = canvas.parentElement;           // .tsView, the positioning parent of the brush ring and the rubber band
  const params = Object.fromEntries(KEYS.map((k) => [k, DEFAULTS[k]]));
  let mode = 'image';                           // 'image' or 'frame': only the title, the default name and the second save button differ
  let src = null;                               // { path, name, w, h, canvas (the original), id (its ImageData, never changed) }
  let matte = null;                             // RMBG matte of `src`, once AI remove has run
  let edits = [], redoStack = [];               // {type:'ai'} | {type:'wand'|'rect'|'brush'}, see colorremoval.js
  let out = null, outCtx = null;                // the cutout (full size), what is shown and saved
  let tool = null, showOriginal = false, busy = false, space = false, ui = null;
  let stroke = null, rect = null, pan = null, rebuildTimer = 0;
  const view = { z: 1, x: 0, y: 0 };            // zoom and pan of the preview, in canvas pixels

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
    redraw();
    syncUi();
  }
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
  function redraw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S, S);
    const img = showOriginal ? src?.canvas : out;
    if (!img) return;
    const f = fitRect(img.width, img.height, S);
    ctx.setTransform(view.z, 0, 0, view.z, view.x, view.y);
    ctx.imageSmoothingEnabled = view.z < 2;   // zoomed in far enough, show real pixels so single-pixel edits can be judged
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, f.x, f.y, f.w, f.h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    $('#brBadge').textContent = src ? `${showOriginal ? 'Original' : 'Cutout'}${view.z > 1 ? ` · ${Math.round(view.z * 100)}%` : ''}` : '';
  }
  const resetView = () => { view.z = 1; view.x = 0; view.y = 0; redraw(); };
  const canvasPoint = (e) => { const r = canvas.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * S, y: ((e.clientY - r.top) / r.height) * S }; };
  /** Pointer -> source-image pixel: undo the zoom/pan, then the fit into the square. */
  function srcPoint(e) {
    if (!src) return null;
    const c = canvasPoint(e), f = fitRect(src.w, src.h, S);
    const qx = (c.x - view.x) / view.z, qy = (c.y - view.y) / view.z;
    return { x: ((qx - f.x) * src.w) / f.w, y: ((qy - f.y) * src.h) / f.h };
  }
  const insideImage = (p) => p.x >= 0 && p.y >= 0 && p.x < src.w && p.y < src.h;

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = canvasPoint(e), z = Math.min(32, Math.max(1, view.z * Math.pow(1.15, -e.deltaY / 100)));
    view.x = p.x - (p.x - view.x) * (z / view.z); view.y = p.y - (p.y - view.y) * (z / view.z); view.z = z;
    if (z === 1) { view.x = 0; view.y = 0; }
    redraw();
  }, { passive: false });

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
    stampStroke(s.touched, w, h, seg, s.r, 1);
    const xs = seg.map((p) => p[0]), ys = seg.map((p) => p[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - s.r - 1)), x1 = Math.min(w - 1, Math.ceil(Math.max(...xs) + s.r + 1));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) - s.r - 1)), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys) + s.r + 1));
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

  const panning = (e) => space || e.button === 1;
  canvas.addEventListener('pointerdown', (e) => {
    if (!src) return;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* a synthetic event has no real pointer */ }
    if (panning(e) || !tool) { if (view.z > 1) pan = { px: e.clientX, py: e.clientY, x: view.x, y: view.y }; return; }
    if (e.button !== 0) return;
    const p = srcPoint(e);
    if (tool === 'wand') {
      if (insideImage(p)) pushEdit({ type: 'wand', x: Math.round(p.x), y: Math.round(p.y), tol: params.wandTolerance, contiguous: !!params.wandContiguous });
    } else if (tool === 'brush') {
      stroke = { r: Math.max(0.5, params.brushSize / 2), mode: params.brushMode, pts: [[p.x, p.y]], touched: null };
      liveBrush([[p.x, p.y]]);
    } else if (tool === 'rect') {
      rect = { x0: p.x, y0: p.y, vx: e.clientX, vy: e.clientY };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const sr = stage.getBoundingClientRect();
    if (pan) {
      const r = canvas.getBoundingClientRect();
      view.x = pan.x + ((e.clientX - pan.px) / r.width) * S; view.y = pan.y + ((e.clientY - pan.py) / r.height) * S;
      redraw();
      return;
    }
    if (tool === 'brush' && src && !space) {
      const r = canvas.getBoundingClientRect(), f = fitRect(src.w, src.h, S);
      const d = Math.max(3, params.brushSize * (f.w / src.w) * view.z * (r.width / S));   // brush size is in source pixels
      ring.style.width = ring.style.height = `${d}px`;
      ring.style.left = `${e.clientX - sr.left}px`; ring.style.top = `${e.clientY - sr.top}px`;
      ring.hidden = false;
    } else ring.hidden = true;
    if (stroke) {
      const p = srcPoint(e), last = stroke.pts[stroke.pts.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) >= Math.max(1, stroke.r / 4)) { stroke.pts.push([p.x, p.y]); liveBrush([last, [p.x, p.y]]); }
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
      const s = stroke; stroke = null;
      const r1 = (v) => Math.round(v * 10) / 10;
      pushEdit({ type: 'brush', mode: s.mode, r: r1(s.r), pts: s.pts.map(([x, y]) => [r1(x), r1(y)]) });
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
    { k: 'brushMode', label: 'Brush mode', t: 'select', opts: [['erase', 'Erase'], ['restore', 'Restore']], show: () => tool === 'brush' }
  ];
  function onParam(k) {
    if (k === 'brushSize' || k === 'brushMode' || k === 'wandTolerance' || k === 'wandContiguous') return; // only used by the next stroke or click
    schedule();
  }
  function syncUi() {
    ui?.sync();
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
    Object.assign(params, Object.fromEntries(KEYS.map((k) => [k, DEFAULTS[k]])));
    edits = []; redoStack = [];
    rebuild();
  };
  $('#brOriginal').onchange = (e) => { showOriginal = e.target.checked; redraw(); };
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
    get original() { return src?.canvas || null; },
    get matte() { return matte; },
    /** For tests: pointer position of a source pixel, in client coordinates. */
    clientOf(x, y) {
      const r = canvas.getBoundingClientRect(), f = fitRect(src.w, src.h, S);
      const cx = (f.x + (x / src.w) * f.w) * view.z + view.x, cy = (f.y + (y / src.h) * f.h) * view.z + view.y;
      return { x: r.left + (cx / S) * r.width, y: r.top + (cy / S) * r.height };
    },
    async saveAndUse(outPath) { const r = await saveTo(outPath); await useSaved(outPath); close(); return r; }
  };
}
