import { DEFAULTS, compositeImage, resolvePlacement, baseRect } from './lib/composite.js';
import { buildEditedMask, applyRemovalMask, stampStroke } from './lib/colorremoval.js';
import { detectHole, holeMaskCanvas } from './lib/holedetect.js';

const api = window.api;
const $ = (s, r = document) => r.querySelector(s);
const PREVIEW = 800;
const IMG_EXT = /\.(webp|png|jpe?g|bmp|gif|tiff?|avif)$/i;
const OUT_DEFAULTS = { size: 1000, quality: 0.95, overwrite: false };

const state = {
  shared: { ...DEFAULTS },
  out: { ...OUT_DEFAULTS },
  ui: { popOutPreview: false, showCutout: false },
  frame: null,          // {path, name, bitmap, hole, holeCache}
  items: [], cur: -1, skipped: 0, editOnly: false, gen: 0,
  assets: new Map(),    // path -> ImageBitmap | null
  base: null,           // {path, bitmap} for the previewed item
  cut: null,            // cutout cache {key, canvas, ctx, raw, orig}
  tool: null,           // null | 'wand' | 'brush' | 'rect'
  stroke: null,         // brush stroke in progress
  space: false,
  pickSeed: false,
  view: { z: 1, x: 0, y: 0 }
};

const curItem = () => state.items[state.cur] || null;
const eff = () => ({ ...state.shared, ...(curItem()?.override || {}) });
const holeValid = () => !!state.frame?.hole?.valid;
const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));
const sepOf = (p) => (p.includes('\\') ? '\\' : '/');
const baseOf = (p) => p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1).replace(/\.[^.]+$/, '');

// ---------------------------------------------------------------- settings
let persistTimer = 0;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    api.setSettings({ shared: state.shared, out: state.out, framePath: state.frame?.path || '', lastDir: state.lastDir || '' });
  }, 500);
}

// ---------------------------------------------------------------- control schema
const fit = (c) => c.fitEnabled && holeValid();
const num = (k, label, min, max, step, show, extra = {}) => ({ k, t: 'range', label, min, max, step, show, ...extra });
const offs = (p, label, show, r = 256) => [
  num(p + 'X', label + ' X', -r, r, 1, show),
  num(p + 'Y', label + ' Y', -r, r, 1, show)
];

const SECTIONS = [
  { title: 'Art placement', open: true, controls: [
    { k: 'fitEnabled', t: 'check', label: 'Auto center', show: () => holeValid() },
    { k: 'fitAnchor', t: 'select', label: 'Vertical anchor', show: fit, opts: [['top', 'Top (keeps faces)'], ['center', 'Center']] },
    num('fitScale', 'Scale ×', 0.5, 2, 0.01, fit),
    ...offs('fitOffset', 'Nudge', fit, 200),
    num('baseScale', 'Scale', 0.2, 2.5, 0.01, (c) => !fit(c)),
    ...offs('baseOffset', 'Offset', (c) => !fit(c)),
    { k: 'baseOverFrame', t: 'check', label: 'Art over frame' }
  ] },
  { title: 'Mask', open: true, controls: [
    { k: 'maskShape', t: 'select', label: 'Shape', opts: [['hole', 'Frame shape (auto)'], ['circle', 'Circle'], ['square', 'Square'], ['hexagon', 'Hexagon'], ['none', 'None']] },
    num('holeDilate', 'Edge grow (px)', 0, 40, 1, (c) => c.maskShape === 'hole' && !c.maskImage),
    num('maskRadius', 'Size', 0.3, 1.2, 0.01, (c) => !c.maskImage && c.maskShape !== 'hole' && c.maskShape !== 'none'),
    ...offs('maskOffset', 'Offset', (c) => !c.maskImage && c.maskShape !== 'hole' && c.maskShape !== 'none'),
    { k: 'maskImage', t: 'file', label: 'Custom mask' },
    num('maskScale', 'Mask scale', 0.5, 1.5, 0.01, (c) => !!c.maskImage),
    ...offs('maskOffset', 'Mask offset', (c) => !!c.maskImage)
  ] },
  { title: 'Frame', controls: [
    num('frameScale', 'Scale', 0.5, 1.5, 0.01),
    ...offs('frameOffset', 'Offset'),
    num('frameOpacity', 'Opacity', 0, 1, 0.01),
    { k: 'frameTintOn', k2: 'frameTintColor', t: 'tint', label: 'Tint' }
  ] },
  { title: 'Background', controls: [
    { k: 'bgEnabled', k2: 'bgColor', t: 'tint', label: 'Color' },
    { k: 'bgImage', t: 'file', label: 'Image' },
    num('bgImageScale', 'Image scale', 0.5, 1.5, 0.01),
    ...offs('bgImageOffset', 'Image offset')
  ] },
  { title: 'Overlay', controls: [
    { k: 'overlayImage', t: 'file', label: 'Image' },
    num('overlayScale', 'Scale', 0.5, 1.5, 0.01),
    ...offs('overlayOffset', 'Offset'),
    num('overlayOpacity', 'Opacity', 0, 1, 0.01),
    { k: 'overlayTintOn', k2: 'overlayTintColor', t: 'tint', label: 'Tint' }
  ] },
  { title: 'Pop-out', controls: [
    { k: 'popOutEnabled', t: 'check', label: 'Enable' },
    num('popOutDegrees', 'Arc (°)', 1, 360, 1),
    num('popOutRotation', 'Rotation (°)', -180, 180, 1),
    ...offs('popOutOffset', 'Center'),
    { k: 'popOutPreview', t: 'check', label: 'Highlight', scope: 'ui' }
  ] },
  { title: 'Background removal', controls: [
    { k: 'crPopOutOnly', t: 'check', label: 'Pop-out layer only' },
    { t: 'hint', show: (c) => hasCutout(c) && c.crPopOutOnly && !c.popOutEnabled, text: 'The cutout only shows on the pop-out layer. Enable Pop-out, or untick "Pop-out layer only".' },
    { k: 'crEnabled', k2: 'crColor', t: 'tint', label: 'Remove color', eyedrop: true },
    num('crThreshold', 'Threshold', 0, 100, 1),
    { k: 'crEdgesOnly', t: 'check', label: 'Edges only' },
    num('crFeather', 'Feather', 0, 10, 1),
    num('crGrow', 'Grow', 0, 10, 1),
    num('crDefringe', 'Defringe', 0, 100, 1),
    { t: 'cutouttools', label: 'Manual tools' },
    num('wandTolerance', 'Wand tolerance', 0, 100, 1),
    { k: 'wandContiguous', t: 'check', label: 'Wand contiguous' },
    num('brushSize', 'Brush (image px)', 1, 600, 1),
    { k: 'brushMode', t: 'select', label: 'Brush mode', opts: [['erase', 'Erase'], ['restore', 'Restore']] },
    { k: 'showCutout', t: 'check', label: 'Show cutout only', scope: 'ui' }
  ] },
  { title: 'Output', scope: 'out', controls: [
    { k: 'size', t: 'num', label: 'Size (px)', min: 128, max: 4096 },
    num('quality', 'WebP quality', 0.5, 1, 0.01),
    { k: 'overwrite', t: 'check', label: 'Overwrite existing' }
  ] }
];
const ctls = [];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const srcOf = (c, cfg) => (c.scope === 'out' ? state.out : c.scope === 'ui' ? state.ui : cfg);

function buildPanel() {
  const panel = $('#panel');
  for (const sec of SECTIONS) {
    const d = el('details');
    d.open = !!sec.open;
    // collapsing the section that holds the tools switches the active tool off
    if (sec.title === 'Background removal') d.addEventListener('toggle', () => { if (!d.open && state.tool) setTool(state.tool); });
    d.append(el('summary', null, sec.title));
    const body = el('div', 'sec');
    for (const c of sec.controls) {
      if (sec.scope && !c.scope) c.scope = sec.scope;
      const row = el('div', 'row');
      row.append(el('label', null, c.label || ''));
      const ctl = el('div', 'ctl');
      row.append(ctl);
      buildControl(c, ctl);
      c.row = row;
      ctls.push(c);
      body.append(row);
    }
    d.append(body);
    panel.append(d);
  }
}

function buildControl(c, ctl) {
  const set = (k, v) => setKey(c, k, v);
  if (c.t === 'range') {
    const r = el('input'); r.type = 'range'; r.min = c.min; r.max = c.max; r.step = c.step;
    const n = el('input'); n.type = 'number'; n.min = c.min; n.max = c.max; n.step = c.step;
    r.addEventListener('input', () => { n.value = r.value; set(c.k, +r.value); });
    n.addEventListener('input', () => { if (n.value !== '' && !isNaN(+n.value)) { r.value = n.value; set(c.k, +n.value); } });
    ctl.append(r, n);
    c.sync = (cfg) => {
      const v = srcOf(c, cfg)[c.k];
      r.value = v;
      if (document.activeElement !== n) n.value = Math.round(v * 1000) / 1000;
    };
  } else if (c.t === 'num') {
    const n = el('input'); n.type = 'number'; n.min = c.min; n.max = c.max;
    n.addEventListener('input', () => { if (n.value !== '' && !isNaN(+n.value)) set(c.k, +n.value); });
    ctl.append(n);
    c.sync = (cfg) => { if (document.activeElement !== n) n.value = srcOf(c, cfg)[c.k]; };
  } else if (c.t === 'check') {
    const b = el('input'); b.type = 'checkbox';
    b.addEventListener('change', () => set(c.k, b.checked));
    ctl.append(b);
    c.sync = (cfg) => { b.checked = !!srcOf(c, cfg)[c.k]; };
  } else if (c.t === 'select') {
    const s = el('select');
    for (const [v, t] of c.opts) { const o = el('option', null, t); o.value = v; s.append(o); }
    s.addEventListener('change', () => set(c.k, s.value));
    ctl.append(s);
    c.sync = (cfg) => { s.value = srcOf(c, cfg)[c.k]; };
  } else if (c.t === 'tint') {
    const b = el('input'); b.type = 'checkbox';
    const col = el('input'); col.type = 'color';
    b.addEventListener('change', () => set(c.k, b.checked));
    col.addEventListener('input', () => set(c.k2, col.value));
    ctl.append(b, col);
    if (c.eyedrop && 'EyeDropper' in window) {
      const eb = el('button', null, 'Eyedrop');
      eb.addEventListener('click', async () => {
        try { const r = await new window.EyeDropper().open(); col.value = r.sRGBHex; set(c.k2, r.sRGBHex); set(c.k, true); } catch { /* cancelled */ }
      });
      ctl.append(eb);
    }
    c.sync = (cfg) => { b.checked = !!cfg[c.k]; col.value = cfg[c.k2]; };
  } else if (c.t === 'file') {
    const p = el('span', 'path', 'none');
    const br = el('button', null, 'Browse');
    const cl = el('button', null, '✕');
    br.addEventListener('click', async () => {
      const r = await api.pickImages({ multi: false, defaultPath: state.lastDir });
      if (r[0]) set(c.k, r[0]);
    });
    cl.addEventListener('click', () => set(c.k, ''));
    ctl.append(p, br, cl);
    c.sync = (cfg) => { const v = cfg[c.k]; p.textContent = v ? baseOf(v) : 'none'; p.title = v || ''; };
  } else if (c.t === 'hint') {
    ctl.append(el('span', 'hint', c.text));
    c.sync = () => {};
  } else if (c.t === 'cutouttools') {
    ctl.classList.add('wrap');
    const btn = (id, text, fn) => { const b = el('button', null, text); b.dataset.id = id; b.addEventListener('click', fn); ctl.append(b); return b; };
    btn('wand', 'Wand', () => setTool('wand'));
    btn('brush', 'Brush', () => setTool('brush'));
    btn('rect', 'Rectangle', () => setTool('rect'));
    btn('undo', 'Undo', undo);
    btn('redo', 'Redo', redo);
    btn('reset', 'Reset edits', resetEdits);
    const count = el('span', 'hint'); ctl.append(count);
    c.sync = () => {
      const it = curItem();
      const n = it?.override.popEdits?.length || 0;
      ctl.querySelectorAll('button').forEach((b) => {
        const id = b.dataset.id;
        b.classList.toggle('active', id === state.tool);
        if (id === 'undo') b.disabled = !n;
        if (id === 'redo') b.disabled = !it?.redo?.length;
        if (id === 'reset') b.disabled = !n;
        if (['wand', 'brush', 'rect'].includes(id)) b.disabled = !state.base;
      });
      count.textContent = n ? `${n} edit${n === 1 ? '' : 's'}` : 'no edits';
    };
  }
}

function setKey(c, k, v) {
  const scope = c.scope || 'cfg';
  if (scope === 'out') state.out[k] = v;
  else if (scope === 'ui') state.ui[k] = v;
  else if (state.editOnly && curItem()) curItem().override[k] = v;
  else {
    state.shared[k] = v;
    if (curItem()) delete curItem().override[k];
  }
  if (k === 'overwrite') {
    for (const it of state.items) if (it.exists) it.selected = v;
    refreshGrid();
  }
  syncControls();
  if (scope === 'cfg') schedulePreview(k.startsWith('cr') ? 250 : 30);
  else if (scope === 'ui') schedulePreview(0);
  persist();
  updateTile(state.cur);
}

function syncControls() {
  const cfg = eff();
  const ov = curItem()?.override || {};
  for (const c of ctls) {
    c.sync(cfg);
    c.row.style.display = c.show && !c.show(cfg) ? 'none' : '';
    c.row.classList.toggle('ovr', (c.scope || 'cfg') === 'cfg' && (c.k in ov || (c.k2 && c.k2 in ov)));
  }
  $('#editOnlyRow').hidden = state.items.length < 2;
}

// ---------------------------------------------------------------- images
async function bitmapFromPath(p) {
  const bytes = await api.readFile(p);
  return createImageBitmap(new Blob([bytes]));
}

async function ensureAssets(cfg) {
  for (const p of [cfg.maskImage, cfg.bgImage, cfg.overlayImage]) {
    if (p && !state.assets.has(p)) {
      try { state.assets.set(p, await bitmapFromPath(p)); } catch { state.assets.set(p, null); }
    }
  }
}

function holeCanvasFor(cfg) {
  const hole = state.frame?.hole;
  if (!hole?.valid) return null;
  const native = Math.round((cfg.holeDilate * hole.w) / (1000 * cfg.frameScale));
  if (state.frame.holeCache?.key !== native || state.frame.holeCache?.hole !== hole) {
    state.frame.holeCache = { key: native, hole, canvas: holeMaskCanvas(hole, native) };
  }
  return state.frame.holeCache.canvas;
}

// ---------------------------------------------------------------- cutout (background removal + manual edits)
const hasCutout = (cfg) => !!cfg.crEnabled || (cfg.popEdits?.length || 0) > 0;

/** Full recompute: color mask + ordered edits, then grow/feather/defringe once. */
function buildCut(bitmap, cfg) {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { mask, color, fixed } = buildEditedMask(id, cfg, cfg.popEdits || []);
  const raw = mask.slice(); // pre-grow copy, patched live while brushing
  applyRemovalMask(id, mask, color, cfg.crFeather, cfg.crGrow, cfg.crDefringe, fixed);
  ctx.putImageData(id, 0, 0);
  return { canvas, ctx, raw, orig: null };
}

const cutKey = (cfg) => JSON.stringify([state.base?.path, cfg.crEnabled, cfg.crColor, cfg.crThreshold, cfg.crEdgesOnly, cfg.crFeather, cfg.crGrow, cfg.crDefringe, curItem()?.editVer || 0]);

function previewCut(cfg) {
  const key = cutKey(cfg);
  if (state.cut?.key !== key) state.cut = { key, ...buildCut(state.base.bitmap, cfg) };
  return state.cut;
}

/** {base, popBase} drawables for a config. `cut` is a prebuilt cutout (preview cache) or null to build one. */
function buildSources(cfg, bitmap, cut = null) {
  if (!hasCutout(cfg) && !cut) return { base: bitmap, popBase: null };
  const c = cut || buildCut(bitmap, cfg);
  return cfg.crPopOutOnly ? { base: bitmap, popBase: c.canvas } : { base: c.canvas, popBase: c.canvas };
}

/** Config with placement resolved (Auto center), tints flattened: what compositeImage consumes. */
function resolveCfg(cfg, base) {
  return {
    ...cfg, ...resolvePlacement(cfg, base, state.frame?.hole),
    frameTintColor: cfg.frameTintOn ? cfg.frameTintColor : '',
    overlayTintColor: cfg.overlayTintOn ? cfg.overlayTintColor : ''
  };
}

function compositeFor(cfg, sources, size, opts) {
  const c = resolveCfg(cfg, sources.base);
  return compositeImage({
    ...sources, frame: state.frame.bitmap,
    mask: (cfg.maskImage && state.assets.get(cfg.maskImage)) || null,
    bg: (cfg.bgImage && state.assets.get(cfg.bgImage)) || null,
    overlay: (cfg.overlayImage && state.assets.get(cfg.overlayImage)) || null,
    holeMask: c.maskShape === 'hole' ? holeCanvasFor(cfg) : null
  }, c, size, opts);
}

// ---------------------------------------------------------------- preview
let renderTimer = 0, renderTok = 0;
function schedulePreview(delay = 30) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderPreview, delay);
}

async function renderPreview() {
  const tok = ++renderTok;
  const cv = $('#preview');
  const ctx = cv.getContext('2d');
  if (!state.frame || !state.base) {
    ctx.clearRect(0, 0, PREVIEW, PREVIEW);
    ctx.fillStyle = '#9097a5';
    ctx.font = '22px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(state.frame ? 'Open an image or folder' : state.base ? 'Choose a frame' : 'Choose a frame, then open images', PREVIEW / 2, PREVIEW / 2);
    return;
  }
  const cfg = eff();
  await ensureAssets(cfg);
  if (tok !== renderTok) return;
  const cut = hasCutout(cfg) || state.stroke ? previewCut(cfg) : null;
  // pixel view renders at 2x so each source pixel is a visible block when zoomed, drawn without smoothing
  const crisp = !!state.ui.pixelView;
  const size = crisp ? PREVIEW * 2 : PREVIEW;
  if (cv.width !== size) { cv.width = size; cv.height = size; }
  ctx.clearRect(0, 0, size, size);
  if (state.ui.showCutout) {
    // the cutout alone, same placement as in the token, over the checkerboard
    const bitmap = state.base.bitmap;
    const r = baseRect(resolveCfg(cfg, bitmap), bitmap, size);
    ctx.imageSmoothingEnabled = !crisp;
    ctx.drawImage(cut ? cut.canvas : bitmap, r.x, r.y, r.w, r.h);
    return;
  }
  ctx.drawImage(compositeFor(cfg, buildSources(cfg, state.base.bitmap, cut), size, { highlightPopOut: state.ui.popOutPreview, crisp }), 0, 0);
}

// zoom / pan (CSS transform on the preview canvas, like the module's dialog)
function applyView() {
  const v = state.view;
  const size = $('#view').clientWidth;
  const min = -(v.z - 1) * size;
  v.x = Math.min(0, Math.max(min, v.x));
  v.y = Math.min(0, Math.max(min, v.y));
  $('#preview').style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
  const b = $('#zoomBadge');
  b.hidden = v.z === 1;
  b.textContent = `${v.z.toFixed(1)}×`;
}

function setupView() {
  const view = $('#view');
  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    const v = state.view;
    const r = view.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const nz = Math.min(16, Math.max(1, v.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    v.x = mx - (mx - v.x) * (nz / v.z);
    v.y = my - (my - v.y) * (nz / v.z);
    v.z = nz;
    applyView();
  }, { passive: false });
  view.addEventListener('dblclick', () => { state.view = { z: 1, x: 0, y: 0 }; applyView(); });
  let drag = null;
  view.addEventListener('pointerdown', (e) => {
    if (state.tool && e.button === 0 && !state.space) { // tools draw; middle mouse / Space pan
      view.setPointerCapture(e.pointerId);
      toolDown(e);
      return;
    }
    drag = { sx: e.clientX, sy: e.clientY, ox: state.view.x, oy: state.view.y, moved: false };
    view.setPointerCapture(e.pointerId);
  });
  view.addEventListener('pointermove', (e) => {
    if (state.tool) toolMove(e);
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; view.classList.add('drag'); }
    if (drag.moved && state.view.z > 1) {
      state.view.x = drag.ox + dx;
      state.view.y = drag.oy + dy;
      applyView();
    }
  });
  view.addEventListener('pointerleave', () => { $('#brushRing').hidden = true; });
  view.addEventListener('pointerup', (e) => {
    if (toolUp(e)) return;
    const wasClick = drag && !drag.moved;
    drag = null;
    view.classList.remove('drag');
    if (wasClick && state.pickSeed) pickSeedAt(e);
  });
  new ResizeObserver(applyView).observe(view);
}

// ---------------------------------------------------------------- manual cutout tools
// Edits live in the current image's override as popEdits (source-image pixel coordinates), see colorremoval.js.
const TOOL_HINTS = {
  wand: 'Wand: click the background you want cut out (Tolerance and Contiguous are below).',
  brush: 'Brush: drag to erase (or restore, see Brush mode). Space+drag or middle mouse pans.',
  rect: 'Rectangle: drag a box to erase everything inside it. Space+drag or middle mouse pans.'
};

function setTool(t) {
  state.tool = state.tool === t ? null : t;
  state.pickSeed = false;
  const view = $('#view');
  view.classList.remove('seed');
  view.classList.toggle('tool', !!state.tool);
  $('#brushRing').hidden = true;
  $('#rubber').hidden = true;
  setStatus(state.tool ? TOOL_HINTS[state.tool] : '');
  syncControls();
}

/** Pointer event -> source-image pixel coordinates (handles zoom/pan via the canvas' bounding rect). */
function srcPoint(e) {
  if (!state.base) return null;
  const bm = state.base.bitmap;
  const cfg = eff();
  const br = baseRect(resolveCfg(cfg, bm), bm, PREVIEW);
  const r = $('#preview').getBoundingClientRect();
  const px = ((e.clientX - r.left) / r.width) * PREVIEW;
  const py = ((e.clientY - r.top) / r.height) * PREVIEW;
  return { x: ((px - br.x) * bm.width) / br.w, y: ((py - br.y) * bm.height) / br.h, scale: bm.width / br.w, w: bm.width, h: bm.height, cfg };
}
const insideImage = (p) => p.x >= 0 && p.y >= 0 && p.x < p.w && p.y < p.h;

function afterEdit() {
  const it = curItem();
  if (!it) return;
  it.editVer++;
  state.cut = null;
  syncControls();
  updateTile(state.cur);
  schedulePreview(0);
}

function pushEdit(op) {
  const it = curItem();
  if (!it) return;
  it.override.popEdits = [...(it.override.popEdits || []), op];
  it.redo = [];
  afterEdit();
}

function undo() {
  const it = curItem();
  const edits = it?.override.popEdits;
  if (!edits?.length) return;
  const next = edits.slice();
  it.redo.push(next.pop());
  if (next.length) it.override.popEdits = next; else delete it.override.popEdits;
  afterEdit();
}

function redo() {
  const it = curItem();
  if (!it?.redo.length) return;
  it.override.popEdits = [...(it.override.popEdits || []), it.redo.pop()];
  afterEdit();
}

function resetEdits() {
  const it = curItem();
  if (!it?.override.popEdits?.length) return;
  if (!confirm('Remove all wand, brush and rectangle edits on this image?')) return;
  delete it.override.popEdits;
  it.redo = [];
  afterEdit();
}

/** Live brush feedback: stamp the new segment into the cached cutout (hard edge only; full refinement on release). */
function liveBrush(seg) {
  const cut = state.cut, s = state.stroke;
  const bm = state.base.bitmap, w = bm.width, h = bm.height;
  if (!cut.orig) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bm, 0, 0);
    cut.orig = cx.getImageData(0, 0, w, h);
  }
  if (!s.touched) s.touched = new Uint8Array(w * h);
  stampStroke(cut.raw, w, h, seg, s.r, s.mode === 'restore' ? 0 : 1);
  stampStroke(s.touched, w, h, seg, s.r, 1);
  const xs = seg.map((p) => p[0]), ys = seg.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - s.r - 1)), x1 = Math.min(w - 1, Math.ceil(Math.max(...xs) + s.r + 1));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - s.r - 1)), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys) + s.r + 1));
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const id = cut.ctx.getImageData(x0, y0, bw, bh);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const gi = y * w + x;
      if (!s.touched[gi]) continue;
      const li = ((y - y0) * bw + (x - x0)) * 4;
      if (s.mode === 'restore') {
        for (let k = 0; k < 4; k++) id.data[li + k] = cut.orig.data[gi * 4 + k];
      } else id.data[li + 3] = 0;
    }
  }
  cut.ctx.putImageData(id, x0, y0);
  schedulePreview(0);
}

function toolDown(e) {
  const p = srcPoint(e);
  if (!p) return;
  state.tdown = true;
  if (state.tool === 'wand') {
    if (insideImage(p)) pushEdit({ type: 'wand', x: Math.round(p.x), y: Math.round(p.y), tol: p.cfg.wandTolerance, contiguous: !!p.cfg.wandContiguous });
  } else if (state.tool === 'brush') {
    state.stroke = { r: Math.max(0.5, p.cfg.brushSize / 2), mode: p.cfg.brushMode, pts: [[p.x, p.y]], touched: null };
    previewCut(p.cfg);
    liveBrush([[p.x, p.y]]);
  } else if (state.tool === 'rect') {
    state.tdrag = { x0: p.x, y0: p.y, vx: e.clientX, vy: e.clientY };
  }
}

function toolMove(e) {
  const view = $('#view');
  const vr = view.getBoundingClientRect();
  const ring = $('#brushRing');
  const pp = state.tool === 'brush' ? srcPoint(e) : null;
  if (pp) {
    // brush size is in source-image pixels: convert to on-screen px (preview px per source px = 1/scale)
    const d = Math.max(3, (eff().brushSize / pp.scale) * (vr.width / PREVIEW) * state.view.z);
    ring.style.width = ring.style.height = `${d}px`;
    ring.style.left = `${e.clientX - vr.left}px`;
    ring.style.top = `${e.clientY - vr.top}px`;
    ring.hidden = false;
  } else ring.hidden = true;
  if (state.stroke) {
    const p = srcPoint(e);
    const s = state.stroke;
    const last = s.pts[s.pts.length - 1];
    if (p && Math.hypot(p.x - last[0], p.y - last[1]) >= Math.max(1, s.r / 4)) {
      s.pts.push([p.x, p.y]);
      liveBrush([last, [p.x, p.y]]);
    }
  } else if (state.tdrag) {
    const d = state.tdrag, rb = $('#rubber');
    rb.hidden = false;
    rb.style.left = `${Math.min(d.vx, e.clientX) - vr.left}px`;
    rb.style.top = `${Math.min(d.vy, e.clientY) - vr.top}px`;
    rb.style.width = `${Math.abs(e.clientX - d.vx)}px`;
    rb.style.height = `${Math.abs(e.clientY - d.vy)}px`;
  }
}

/** Returns true when the pointer-up belonged to a tool gesture. */
function toolUp(e) {
  if (!state.tdown) return false;
  state.tdown = false;
  if (state.stroke) {
    const s = state.stroke;
    state.stroke = null;
    pushEdit({ type: 'brush', mode: s.mode, r: Math.round(s.r * 10) / 10, pts: s.pts.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]) });
  } else if (state.tdrag) {
    const d = state.tdrag;
    state.tdrag = null;
    $('#rubber').hidden = true;
    const p = srcPoint(e);
    if (p && Math.abs(e.clientX - d.vx) + Math.abs(e.clientY - d.vy) > 3) pushEdit({ type: 'rect', x0: d.x0, y0: d.y0, x1: p.x, y1: p.y });
  }
  return true;
}

function onKey(e, down) {
  const t = e.target;
  const typing = t && ((t.tagName === 'INPUT' && !['range', 'checkbox', 'color'].includes(t.type)) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
  if (e.code === 'Space' && state.tool && !typing) {
    state.space = down;
    $('#view').classList.toggle('panmode', down);
    e.preventDefault();
    return;
  }
  if (!down || typing) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (e.ctrlKey && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  else if (k === 'escape' && state.tool) setTool(state.tool);
}

// ---------------------------------------------------------------- frame / hole
function showHoleStatus() {
  const n = $('#holeStatus');
  const f = state.frame;
  if (!f) { n.hidden = true; return; }
  const h = f.hole;
  n.hidden = h.valid;
  if (h.valid) return;
  if (h.seedAlpha !== 0) n.textContent = 'Auto center can\'t find the middle of this frame. Use "Pick center point" and click inside the frame\'s middle, or pick a preset mask shape.';
  else n.textContent = 'The frame\'s middle runs out to its outer edge (the frame is not closed). Use "Pick center point", or pick a preset mask shape.';
}

async function loadFrame(p) {
  try {
    const bitmap = await bitmapFromPath(p);
    state.frame?.bitmap.close?.();
    state.frame = { path: p, name: baseOf(p), bitmap, hole: detectHole(bitmap), holeCache: null };
    $('#frameName').textContent = state.frame.name;
    $('#frameName').title = p;
    $('#frameName').classList.remove('muted');
    state.pickSeed = false;
    $('#view').classList.remove('seed');
    showHoleStatus();
    syncControls();
    schedulePreview(0);
    persist();
    return true;
  } catch (err) {
    setStatus(`Could not load frame: ${err.message}`, true);
    return false;
  }
}

function pickSeedAt(e) {
  state.pickSeed = false;
  $('#view').classList.remove('seed');
  if (!state.frame) return;
  const r = $('#preview').getBoundingClientRect();
  const cfg = eff();
  const k = PREVIEW / 512;
  const px = ((e.clientX - r.left) / r.width) * PREVIEW;
  const py = ((e.clientY - r.top) / r.height) * PREVIEW;
  const fs = PREVIEW * cfg.frameScale;
  const x0 = PREVIEW / 2 - fs / 2 + cfg.frameOffsetX * k;
  const y0 = PREVIEW / 2 - fs / 2 + cfg.frameOffsetY * k;
  const hole = detectHole(state.frame.bitmap, { x: ((px - x0) / fs) * state.frame.bitmap.width, y: ((py - y0) / fs) * state.frame.bitmap.height });
  state.frame.hole = hole;
  state.frame.holeCache = null;
  showHoleStatus();
  syncControls();
  schedulePreview(0);
}

// ---------------------------------------------------------------- items
function mkItem(f, names) {
  const dir = dirOf(f.path);
  const outPath = `${dir}${sepOf(f.path)}${f.base} Token.webp`;
  const exists = names ? names.has(`${f.base} token.webp`.toLowerCase()) : false;
  return { name: f.name, base: f.base, path: f.path, outPath, exists, selected: !exists || state.out.overwrite, override: {}, redo: [], editVer: 0, tag: '', thumb: null };
}

async function setItems(items, skipped = 0) {
  state.gen++;
  state.items = items;
  state.skipped = skipped;
  state.cur = -1;
  state.base = null;
  state.cut = null;
  $('#btnShow').hidden = true;
  const multi = items.length > 1;
  $('#grid').hidden = !multi;
  $('#batchBar').hidden = !multi;
  $('#btnFrameAll').hidden = !multi;
  refreshGrid();
  syncControls();
  if (items.length) await selectItem(0);
  else schedulePreview(0);
  loadThumbs(state.gen);
}

async function openFolder(dir) {
  const r = await api.listImages(dir);
  state.lastDir = dir;
  const names = new Set(r.names);
  const all = r.files;
  const items = all.filter((f) => !/token|frame/i.test(f.base)).map((f) => mkItem(f, names));
  const frames = all.filter((f) => /^frame/i.test(f.base));
  if (frames.length) {
    await loadFrame(frames[0].path);
    setStatus(`Frame from folder: ${frames[0].name}${frames.length > 1 ? ` (+${frames.length - 1} more Frame files, browse to switch)` : ''}`);
  }
  await setItems(items, all.length - items.length);
  if (!items.length) setStatus('No images without "Token" or "Frame" in the name were found in that folder.', true);
}

async function openImages(paths) {
  if (!paths.length) return;
  state.lastDir = dirOf(paths[0]);
  const items = [];
  for (const p of paths) {
    const it = mkItem({ path: p, name: p.slice(p.lastIndexOf(sepOf(p)) + 1), base: baseOf(p) }, null);
    it.exists = await api.exists(it.outPath);
    it.selected = !it.exists || state.out.overwrite;
    items.push(it);
  }
  await setItems(items);
}

async function selectItem(i) {
  state.cur = i;
  const it = curItem();
  document.querySelectorAll('.tile').forEach((t, n) => t.classList.toggle('cur', n === i));
  syncControls();
  if (!it) return;
  try {
    const bitmap = await bitmapFromPath(it.path);
    if (curItem() !== it) { bitmap.close(); return; }
    state.base?.bitmap.close?.();
    state.base = { path: it.path, bitmap };
    state.cut = null;
    syncControls();
    schedulePreview(0);
  } catch (err) {
    setStatus(`Could not load ${it.name}: ${err.message}`, true);
  }
}

function refreshGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';
  state.items.forEach((it, i) => {
    const t = el('div', 'tile');
    const cb = el('input', 'cb'); cb.type = 'checkbox'; cb.checked = it.selected;
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => { it.selected = cb.checked; updateTile(i); updateBatchBar(); });
    const cv = el('canvas'); cv.width = 192; cv.height = 144;
    t.append(cb, cv, el('div', 'nm', it.base), el('div', 'tag'));
    t.addEventListener('click', () => selectItem(i));
    it.tile = t;
    if (it.thumb) cv.getContext('2d').drawImage(it.thumb, 0, 0);
    grid.append(t);
    updateTile(i);
  });
  updateBatchBar();
}

function updateTile(i) {
  const it = state.items[i];
  if (!it?.tile) return;
  const t = it.tile;
  t.classList.toggle('cur', i === state.cur);
  t.classList.toggle('skip', !it.selected);
  t.title = it.path;
  const tag = $('.tag', t);
  tag.className = 'tag' + (it.tag === 'saved' ? ' done' : it.tag.startsWith('error') ? ' err' : '');
  tag.textContent = it.tag || (it.exists && !it.selected ? 'token exists' : '');
  $('.cb', t).checked = it.selected;
  let dot = $('.ovrdot', t);
  const has = Object.keys(it.override).length > 0;
  if (has && !dot) t.append(el('span', 'ovrdot'));
  else if (!has && dot) dot.remove();
}

function updateBatchBar() {
  const n = state.items.filter((i) => i.selected).length;
  $('#batchCount').textContent = `${n} of ${state.items.length} selected` + (state.skipped ? ` · ${state.skipped} skipped (Token/Frame in name)` : '');
  $('#btnFrameAll').textContent = `Save all (${n})`;
  $('#btnFrameAll').disabled = n === 0;
}

async function loadThumbs(gen) {
  for (const it of state.items) {
    if (gen !== state.gen) return;
    if (it.thumb) continue;
    try {
      const bytes = await api.readFile(it.path);
      const bmp = await createImageBitmap(new Blob([bytes]), { resizeWidth: 192, resizeQuality: 'medium' });
      const c = document.createElement('canvas');
      c.width = 192; c.height = 144;
      const s = Math.min(192 / bmp.width, 144 / bmp.height);
      c.getContext('2d').drawImage(bmp, (192 - bmp.width * s) / 2, (144 - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
      bmp.close();
      it.thumb = c;
      if (it.tile) $('canvas', it.tile).getContext('2d').drawImage(c, 0, 0);
    } catch { /* leave blank */ }
  }
}

// ---------------------------------------------------------------- saving
function setStatus(text, warn = false) {
  const s = $('#status');
  s.textContent = text;
  s.style.color = warn ? 'var(--warn)' : '';
}

async function renderItemBlob(it) {
  const bmp = await bitmapFromPath(it.path);
  try {
    const cfg = { ...state.shared, ...it.override };
    await ensureAssets(cfg);
    const canvas = compositeFor(cfg, buildSources(cfg, bmp), state.out.size, {});
    return await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/webp', state.out.quality));
  } finally {
    bmp.close();
  }
}

async function writeItem(it, outPath) {
  const blob = await renderItemBlob(it);
  await api.writeFile(outPath, new Uint8Array(await blob.arrayBuffer()));
  it.tag = 'saved';
  if (outPath === it.outPath) it.exists = true;
  state.lastOut = outPath;
  $('#btnShow').hidden = false;
}

function needFrame() {
  if (state.frame) return true;
  setStatus('Choose a frame first.', true);
  return false;
}

async function saveCurrent(asNew) {
  const it = curItem();
  if (!it || !needFrame()) return;
  let out = it.outPath;
  if (asNew) {
    out = await api.pickSave(it.outPath);
    if (!out) return;
  } else if (it.exists && !state.out.overwrite && !confirm(`${it.base} Token.webp already exists. Overwrite it?`)) return;
  try {
    setStatus(`Saving ${baseOf(out)}…`);
    await writeItem(it, out);
    setStatus(`Saved ${out}`);
  } catch (err) {
    it.tag = `error: ${err.message}`;
    setStatus(`Failed: ${err.message}`, true);
  }
  updateTile(state.cur);
}

async function frameAll() {
  if (!needFrame()) return;
  const todo = state.items.filter((i) => i.selected && (!i.exists || state.out.overwrite));
  if (!todo.length) { setStatus('Nothing selected.', true); return; }
  const prog = $('#prog');
  prog.hidden = false;
  prog.max = todo.length;
  $('#btnFrameAll').disabled = true;
  let ok = 0, fail = 0;
  for (let n = 0; n < todo.length; n++) {
    const it = todo[n];
    prog.value = n;
    setStatus(`Framing ${n + 1}/${todo.length}: ${it.base}`);
    try {
      await writeItem(it, it.outPath);
      ok++;
    } catch (err) {
      it.tag = `error: ${err.message}`;
      fail++;
    }
    updateTile(state.items.indexOf(it));
    await new Promise((r) => setTimeout(r, 0));
  }
  prog.hidden = true;
  setStatus(`Done: ${ok} saved${fail ? `, ${fail} failed` : ''}, ${state.items.length - todo.length} skipped.`, fail > 0);
  updateBatchBar();
}

// ---------------------------------------------------------------- wiring
async function handleDrop(e) {
  const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  for (const p of paths) {
    if (await api.isDirectory(p)) { await openFolder(p); return; }
  }
  await openImages(paths.filter((p) => IMG_EXT.test(p)));
}

function setup() {
  buildPanel();
  setupView();
  $('#btnImages').onclick = async () => openImages(await api.pickImages({ multi: true, defaultPath: state.lastDir }));
  $('#btnFolder').onclick = async () => { const d = await api.pickFolder(state.lastDir); if (d) openFolder(d); };
  $('#btnFrame').onclick = async () => { const r = await api.pickImages({ multi: false, defaultPath: state.frame ? dirOf(state.frame.path) : state.lastDir }); if (r[0]) loadFrame(r[0]); };
  $('#btnSeed').onclick = () => {
    if (!state.frame) return setStatus('Choose a frame first.', true);
    const on = !state.pickSeed;
    if (state.tool) setTool(state.tool);
    state.pickSeed = on;
    $('#view').classList.toggle('seed', state.pickSeed);
    if (state.pickSeed) setStatus('Click the middle of the frame in the preview.');
  };
  $('#btnAll').onclick = () => { state.items.forEach((i) => (i.selected = true)); refreshGrid(); };
  $('#btnNone').onclick = () => { state.items.forEach((i) => (i.selected = false)); refreshGrid(); };
  $('#btnFrameAll').onclick = frameAll;
  $('#btnSave').onclick = () => saveCurrent(false);
  $('#btnSaveAs').onclick = () => saveCurrent(true);
  $('#btnShow').onclick = () => state.lastOut && api.showInFolder(state.lastOut);
  $('#editOnly').onchange = (e) => { state.editOnly = e.target.checked; };
  $('#btnResetImg').onclick = () => { const it = curItem(); if (it) { it.override = {}; syncControls(); schedulePreview(0); updateTile(state.cur); } };
  $('#btnDefaults').onclick = () => {
    if (!confirm('Reset all shared settings to their defaults?')) return;
    state.shared = { ...DEFAULTS };
    state.out = { ...OUT_DEFAULTS };
    syncControls(); schedulePreview(0); persist();
  };
  $('#pixelView').onchange = (e) => {
    state.ui.pixelView = e.target.checked;
    $('#view').classList.toggle('pixel', e.target.checked);
    schedulePreview(0);
  };
  window.addEventListener('keydown', (e) => onKey(e, true));
  window.addEventListener('keyup', (e) => onKey(e, false));
  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); depth = 0; document.body.classList.remove('dragging'); handleDrop(e); });
}

async function init() {
  setup();
  const s = await api.getSettings();
  state.shared = { ...DEFAULTS, ...(s.shared || {}) };
  state.out = { ...OUT_DEFAULTS, ...(s.out || {}) };
  state.lastDir = s.lastDir || '';
  syncControls();
  const def = await api.defaultFramePath();
  if (s.framePath && (await api.exists(s.framePath))) await loadFrame(s.framePath);
  else if (await api.exists(def)) await loadFrame(def);
  schedulePreview(0);
}
init();
window.__tf = Object.assign(state, { openFolder, openImages, loadFrame, frameAll, saveCurrent, selectItem, renderPreview, pushEdit, undo, redo, resetEdits, setTool, srcPoint, buildCut, buildSources, eff, compositeFor, resolveCfg }); // DevTools / tests
