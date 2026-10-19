import { DEFAULTS, compositeImage, resolvePlacement, baseRect } from './lib/composite.js';
import { buildEditedMask, applyRemovalMask, stampStroke } from './lib/colorremoval.js';
import { detectHole, holeMaskCanvas } from './lib/holedetect.js';
import { makeZip } from './lib/zip.js';
import { MATTE_RES } from './lib/matte.js';

const api = window.api;
const $ = (s, r = document) => r.querySelector(s);
const PREVIEW = 800;
const IMG_EXT = /\.(webp|png|jpe?g|bmp|gif|tiff?|avif)$/i;
const RECENT_MAX = 24;
const OUT_DEFAULTS = { size: 1000, quality: 0.95, overwrite: false };

const state = {
  shared: { ...DEFAULTS },
  out: { ...OUT_DEFAULTS },
  ui: { popOutPreview: false, showCutout: false },
  editsStore: {},       // path key -> {override, w, h}, mirrors edits.json
  frame: null,          // {path, name, bitmap, hole, holeCache}
  defaultFrame: '',     // path of assets/default.webp, always pinned at the top of the frames sidebar
  recentFrames: [],   // frame image paths, most recently used first (max RECENT_MAX)
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
    api.setSettings({ shared: state.shared, out: state.out, framePath: state.frame?.path || '', lastDir: state.lastDir || '', recentFrames: state.recentFrames, framesOpen: !!state.ui.framesOpen });
  }, 500);
}

// Per-image overrides (incl. manual cutout edits) survive restarts: edits.json in userData, keyed by source path.
// popEdits are in source pixels, so each entry also records the image size and is dropped if the file changed shape.
const editKey = (p) => p.toLowerCase();
let editsTimer = 0;
function flushEdits() {
  clearTimeout(editsTimer);
  for (const it of state.items) {
    if (!it.path) continue; // pasted image, nothing to key the edits to
    const k = editKey(it.path);
    if (Object.keys(it.override).length) state.editsStore[k] = { override: it.override, w: it.dims?.w ?? state.editsStore[k]?.w, h: it.dims?.h ?? state.editsStore[k]?.h };
    else delete state.editsStore[k];
  }
  return api.setEdits(state.editsStore);
}
function persistEdits() {
  clearTimeout(editsTimer);
  editsTimer = setTimeout(flushEdits, 500);
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
    { k: 'fitEnabled', t: 'autocenter', label: '' },
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
    { k: 'showCutout', t: 'check', label: 'Show cutout only', scope: 'ui' },
    { t: 'hint', show: (c) => hasCutout(c) && c.crPopOutOnly && !c.popOutEnabled, text: 'The cutout only shows on the pop-out layer. Enable Pop-out, or untick "Pop-out layer only".' },
    { t: 'subhead', label: 'AI cutout', note: 'one click, best for most art' },
    { t: 'aitool', label: '' },
    num('aiSensitivity', 'Sensitivity', 0, 1, 0.01, (c) => hasAi(c)),
    num('aiBlur', 'Mask blur', 0, 64, 1, (c) => hasAi(c)),
    num('aiOffset', 'Mask offset', -64, 64, 1, (c) => hasAi(c)),
    { t: 'subhead', label: 'By color', note: 'flat backgrounds' },
    { k: 'crEnabled', k2: 'crColor', t: 'tint', label: 'Remove color' },
    num('crThreshold', 'Threshold', 0, 100, 1, (c) => c.crEnabled),
    { k: 'crEdgesOnly', t: 'check', label: 'Edges only', show: (c) => c.crEnabled },
    { t: 'subhead', label: 'Edge cleanup', note: 'applies to the cutout above and to wand edits', show: (c) => hasCutout(c) },
    num('crFeather', 'Feather', 0, 10, 1, (c) => hasCutout(c)),
    num('crGrow', 'Grow', 0, 10, 1, (c) => hasCutout(c)),
    num('crDefringe', 'Defringe', 0, 100, 1, (c) => hasCutout(c)),
    { t: 'subhead', label: 'Touch up by hand' },
    { t: 'cutouttools', label: '' },
    num('wandTolerance', 'Wand tolerance', 0, 100, 1, () => state.tool === 'wand'),
    { k: 'wandContiguous', t: 'check', label: 'Wand contiguous', show: () => state.tool === 'wand' },
    num('brushSize', 'Brush (image px)', 1, 600, 1, () => state.tool === 'brush'),
    { k: 'brushMode', t: 'select', label: 'Brush mode', opts: [['erase', 'Erase'], ['restore', 'Restore']], show: () => state.tool === 'brush' }
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
      if (c.t === 'subhead') { // heading inside a section, no control
        const h = el('div', 'row subhead');
        h.append(el('span', null, c.label));
        if (c.note) h.append(el('span', 'hint', c.note));
        c.row = h;
        c.sync = () => {};
        ctls.push(c);
        body.append(h);
        continue;
      }
      const row = el('div', c.label ? 'row' : 'row full'); // no label: the control spans the whole row
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
    const col = el('input'); col.type = 'color'; // the native picker has its own eyedropper
    const hex = el('input'); hex.type = 'text'; hex.maxLength = 7; hex.size = 7; hex.spellcheck = false; hex.placeholder = '#rrggbb';
    b.addEventListener('change', () => set(c.k, b.checked));
    col.addEventListener('input', () => set(c.k2, col.value));
    hex.addEventListener('input', () => {
      let v = hex.value.trim();
      if (/^[0-9a-f]{6}$/i.test(v)) v = '#' + v;
      if (/^#[0-9a-f]{6}$/i.test(v)) set(c.k2, v.toLowerCase());
    });
    hex.addEventListener('blur', () => { hex.value = col.value; });
    ctl.append(b, col, hex);
    c.sync = (cfg) => { b.checked = !!cfg[c.k]; col.value = cfg[c.k2]; if (document.activeElement !== hex) hex.value = cfg[c.k2]; };
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
  } else if (c.t === 'autocenter') {
    // [x Auto center] [Pick center point]: the button stays available even when detection failed (the checkbox only shows once a hole is found)
    const pick = el('button', null, 'Pick center point');
    pick.title = 'Click the middle of the frame in the preview so Auto center can find it';
    pick.addEventListener('click', toggleSeedPick);
    const wrap = el('label', 'check');
    const b = el('input'); b.type = 'checkbox';
    b.addEventListener('change', () => set(c.k, b.checked));
    wrap.append(b, ' Auto center');
    ctl.append(wrap, pick);
    c.sync = (cfg) => { b.checked = !!cfg[c.k]; wrap.style.display = holeValid() ? '' : 'none'; pick.classList.toggle('active', state.pickSeed); };
  } else if (c.t === 'aitool') {
    ctl.classList.add('wrap');
    const b = el('button', null, 'AI remove (RMBG-2.0)');
    b.addEventListener('click', runAi);
    ctl.append(b, el('span', 'hint', 'Needs a one-time model download'));
    c.sync = () => { b.disabled = !state.base; };
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
  persistEdits();
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

/** Bitmap for a list item: a file on disk, or the bytes of a pasted image. */
const itemBytes = (it) => (it.bytes ? Promise.resolve(it.bytes) : api.readFile(it.path));
async function itemBitmap(it) {
  return createImageBitmap(new Blob([await itemBytes(it)]));
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
const hasAi = (cfg) => (cfg.popEdits || []).some((e) => e.type === 'ai');

// AI cutout: the 1024x1024 RMBG-2.0 matte lives on the item (it.matte); main.cjs caches it on disk by input hash,
// so asking again for a known image is instant and doesn't run the model.
async function computeMatte(bitmap) {
  const c = document.createElement('canvas');
  c.width = c.height = MATTE_RES;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.drawImage(bitmap, 0, 0, MATTE_RES, MATTE_RES);
  const px = x.getImageData(0, 0, MATTE_RES, MATTE_RES).data;
  const rgb = new Uint8Array(MATTE_RES * MATTE_RES * 3);
  for (let i = 0, j = 0; i < px.length; i += 4) { rgb[j++] = px[i]; rgb[j++] = px[i + 1]; rgb[j++] = px[i + 2]; }
  return api.aiMatte(rgb);
}

/** Make sure an item that carries an AI edit has its matte (restored sessions, Save all, ZIP). */
async function ensureMatte(it, bitmap) {
  if (it.matte || !hasAi(it.override)) return;
  it.matte = await computeMatte(bitmap);
  it.matteVer = (it.matteVer || 0) + 1;
}

async function downloadModel() {
  try {
    await api.downloadAiModel();
  } catch (err) {
    if (!confirm(`The model download failed (${err.message}).\n\nPick a model_fp16.onnx file you already have instead?`)) throw err;
    if (!(await api.chooseAiModel())) throw new Error('No model file chosen.');
  } finally {
    $('#prog').hidden = true;
  }
}

async function runAi() {
  const it = curItem();
  if (!it || !state.base) return setStatus('Open an image first.', true);
  try {
    let st = await api.getAiStatus();
    if (!st.ready) {
      if (!confirm(`AI remove needs the RMBG-2.0 model: about ${st.sizeMB} MB, downloaded once from Hugging Face.\nLicence CC BY-NC 4.0 (personal, non-commercial use).\n\nDownload it now?`)) return;
      await downloadModel();
    }
    setStatus('Running RMBG-2.0…');
    const matte = await computeMatte(state.base.bitmap);
    if (curItem() !== it) return; // moved to another image meanwhile
    it.matte = matte;
    it.matteVer = (it.matteVer || 0) + 1;
    if (hasAi(it.override)) afterEdit(); else pushEdit({ type: 'ai' });
    st = await api.getAiStatus();
    setStatus(`AI cutout done on ${st.provider}. Tweak sensitivity, blur and offset, or fix details with the brush.`);
  } catch (err) {
    setStatus(`AI remove failed: ${err.message}`, true);
  }
}

/** Full recompute: color mask + ordered edits, then grow/feather/defringe once. */
function buildCut(bitmap, cfg, matte = null) {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { mask, color, fixed } = buildEditedMask(id, cfg, cfg.popEdits || [], matte);
  const raw = mask.slice(); // pre-grow copy, patched live while brushing
  applyRemovalMask(id, mask, color, cfg.crFeather, cfg.crGrow, cfg.crDefringe, fixed);
  ctx.putImageData(id, 0, 0);
  return { canvas, ctx, raw, orig: null };
}

const cutKey = (cfg) => JSON.stringify([state.base?.path, cfg.crEnabled, cfg.crColor, cfg.crThreshold, cfg.crEdgesOnly, cfg.crFeather, cfg.crGrow, cfg.crDefringe, cfg.aiSensitivity, cfg.aiBlur, cfg.aiOffset, curItem()?.matteVer || 0, curItem()?.editVer || 0]);

function previewCut(cfg) {
  const key = cutKey(cfg);
  if (state.cut?.key !== key) state.cut = { key, ...buildCut(state.base.bitmap, cfg, curItem()?.matte) };
  return state.cut;
}

/** {base, popBase} drawables for a config. `cut` is a prebuilt cutout (preview cache) or null to build one. */
function buildSources(cfg, bitmap, cut = null, matte = null) {
  if (!hasCutout(cfg) && !cut) return { base: bitmap, popBase: null };
  const c = cut || buildCut(bitmap, cfg, matte);
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
  persistEdits();
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

// ---------------------------------------------------------------- recent frames sidebar
const sameFile = (a, b) => a.toLowerCase() === b.toLowerCase();
const frameThumbs = new Map(); // lower-case path -> canvas | 'missing' (memory only)

/** Put a frame at the top of the recent list (or, with keepOrder, only make sure it is in it). */
function rememberFrame(p, keepOrder = false) {
  if (state.defaultFrame && sameFile(p, state.defaultFrame)) return; // pinned, not part of the recent list
  const has = state.recentFrames.some((x) => sameFile(x, p));
  if (keepOrder && has) return;
  state.recentFrames = [p, ...state.recentFrames.filter((x) => !sameFile(x, p))].slice(0, RECENT_MAX);
}

function forgetFrame(p) {
  state.recentFrames = state.recentFrames.filter((x) => !sameFile(x, p));
  frameThumbs.delete(p.toLowerCase());
  renderFrameList();
  persist();
}

async function frameThumb(p) {
  const key = p.toLowerCase();
  if (frameThumbs.has(key)) return frameThumbs.get(key);
  let out = 'missing';
  try {
    const bm = await bitmapFromPath(p);
    const c = document.createElement('canvas');
    c.width = c.height = 192;
    const s = Math.min(192 / bm.width, 192 / bm.height);
    c.getContext('2d').drawImage(bm, (192 - bm.width * s) / 2, (192 - bm.height * s) / 2, bm.width * s, bm.height * s);
    bm.close();
    out = c;
  } catch { /* file gone or unreadable */ }
  frameThumbs.set(key, out);
  return out;
}

function renderFrameList() {
  const list = $('#frameList');
  if (!state.ui.framesOpen) return;
  list.innerHTML = '';
  for (const p of [state.defaultFrame, ...state.recentFrames].filter(Boolean)) {
    const pinned = sameFile(p, state.defaultFrame);
    const t = el('div', pinned ? 'ftile pinned' : 'ftile');
    t.title = p;
    if (state.frame && sameFile(state.frame.path, p)) t.classList.add('cur');
    const cv = el('canvas');
    cv.width = cv.height = 192;
    t.append(cv, el('div', 'nm', pinned ? 'Default' : baseOf(p)));
    if (!pinned) {
      const x = el('button', 'x', '✕');
      x.title = 'Remove from this list';
      x.addEventListener('click', (e) => { e.stopPropagation(); forgetFrame(p); });
      t.append(x);
    }
    t.addEventListener('click', async () => {
      if (t.classList.contains('missing')) { forgetFrame(p); setStatus(`Removed ${baseOf(p)} from the list (file not found).`, true); return; }
      if (state.frame && sameFile(state.frame.path, p)) return;
      await loadFrame(p, { keepOrder: true });
    });
    list.append(t);
    frameThumb(p).then((c) => {
      if (c === 'missing') { t.classList.add('missing'); $('.nm', t).textContent = `${baseOf(p)} (missing)`; }
      else cv.getContext('2d').drawImage(c, 0, 0);
    });
  }
}

function applyFramesOpen() {
  $('#frames').hidden = !state.ui.framesOpen;
  $('#btnFrames').classList.toggle('active', !!state.ui.framesOpen);
  renderFrameList();
}

async function loadFrame(p, { keepOrder = false } = {}) {
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
    rememberFrame(p, keepOrder);
    renderFrameList();
    persist();
    return true;
  } catch (err) {
    setStatus(`Could not load frame: ${err.message}`, true);
    return false;
  }
}

function toggleSeedPick() {
  if (!state.frame) return setStatus('Choose a frame first.', true);
  const on = !state.pickSeed;
  if (state.tool) setTool(state.tool);
  state.pickSeed = on;
  $('#view').classList.toggle('seed', state.pickSeed);
  if (state.pickSeed) setStatus('Click the middle of the frame in the preview.');
  syncControls();
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
  const saved = state.editsStore[editKey(f.path)];
  return { name: f.name, base: f.base, path: f.path, outPath, exists, selected: !exists || state.out.overwrite, override: saved ? structuredClone(saved.override) : {}, dims: saved?.w ? { w: saved.w, h: saved.h } : null, redo: [], editVer: 0, tag: '', thumb: null };
}

async function setItems(items, skipped = 0) {
  flushEdits(); // the outgoing items' pending edits
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
  $('#btnZip').hidden = !multi;
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
  const frames = all.filter((f) => /^frame(?![a-z])/i.test(f.base));
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
    const bitmap = await itemBitmap(it);
    if (curItem() !== it) { bitmap.close(); return; }
    if (it.dims && (it.dims.w !== bitmap.width || it.dims.h !== bitmap.height)) {
      delete it.override.popEdits; // saved for a different-size file: pixel coordinates no longer line up
      it.editVer++;
      updateTile(i);
    }
    it.dims = { w: bitmap.width, h: bitmap.height };
    persistEdits();
    state.base?.bitmap.close?.();
    state.base = { path: it.path, bitmap };
    state.cut = null;
    syncControls();
    schedulePreview(0);
    if (hasAi(it.override) && !it.matte) { // restored from a previous session: rebuild the matte (cached on disk, fast)
      ensureMatte(it, bitmap).then(() => { if (curItem() === it) { state.cut = null; schedulePreview(0); } })
        .catch((err) => setStatus(`AI cutout unavailable: ${err.message}`, true));
    }
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
  $('#btnZip').textContent = `Save all as ZIP (${n})`;
  $('#btnZip').disabled = n === 0;
}

async function loadThumbs(gen) {
  for (const it of state.items) {
    if (gen !== state.gen) return;
    if (it.thumb) continue;
    try {
      const bytes = await itemBytes(it);
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
  const bmp = await itemBitmap(it);
  try {
    const cfg = { ...state.shared, ...it.override };
    await ensureAssets(cfg);
    await ensureMatte(it, bmp);
    const canvas = compositeFor(cfg, buildSources(cfg, bmp, null, it.matte), state.out.size, {});
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
  if (asNew || !it.path) { // a pasted image has no home folder yet
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

/** Render every ticked image into one .zip (existing tokens on disk don't matter: nothing is written next to the sources). */
async function zipAll() {
  if (!needFrame()) return;
  const todo = state.items.filter((i) => i.selected);
  if (!todo.length) { setStatus('Nothing selected.', true); return; }
  const first = todo.find((i) => i.path);
  const dir = first ? dirOf(first.path) : state.lastDir || '';
  const out = await api.pickSave(dir ? `${dir}${sepOf(dir)}Tokens.zip` : 'Tokens.zip', 'zip');
  if (!out) return;
  const prog = $('#prog');
  prog.hidden = false;
  prog.max = todo.length;
  $('#btnZip').disabled = $('#btnFrameAll').disabled = true;
  const files = [];
  const used = new Set();
  let fail = 0;
  for (let n = 0; n < todo.length; n++) {
    const it = todo[n];
    prog.value = n;
    setStatus(`Rendering ${n + 1}/${todo.length}: ${it.base}`);
    try {
      const blob = await renderItemBlob(it);
      let name = `${it.base} Token.webp`;
      for (let k = 2; used.has(name.toLowerCase()); k++) name = `${it.base} Token (${k}).webp`;
      used.add(name.toLowerCase());
      files.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
    } catch (err) {
      it.tag = `error: ${err.message}`;
      fail++;
      updateTile(state.items.indexOf(it));
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  prog.hidden = true;
  try {
    if (files.length) {
      await api.writeFile(out, makeZip(files));
      state.lastOut = out;
      $('#btnShow').hidden = false;
    }
    setStatus(files.length ? `Saved ${files.length} token${files.length === 1 ? '' : 's'} to ${out}${fail ? ` (${fail} failed)` : ''}` : 'Nothing could be rendered.', fail > 0 || !files.length);
  } catch (err) {
    setStatus(`Could not write the zip: ${err.message}`, true);
  }
  updateBatchBar();
}

/** Ctrl+V: a copied image file opens like a dropped one; raw clipboard pixels become an unsaved item. */
async function handlePaste(e) {
  const t = e.target;
  if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type === 'text'))) return;
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  const paths = files.map((f) => api.pathForFile(f)).filter(Boolean);
  if (paths.length) { await openImages(paths); return; }
  const f = files[0];
  const bytes = new Uint8Array(await f.arrayBuffer());
  const base = 'Pasted image';
  const dir = state.lastDir || '';
  const it = {
    name: base, base, path: '', bytes, outPath: dir ? `${dir}${sepOf(dir)}${base} Token.webp` : `${base} Token.webp`,
    exists: false, selected: true, override: {}, redo: [], editVer: 0, tag: '', thumb: null
  };
  await setItems([it]);
  setStatus('Pasted image: Save token will ask where to put it. Edits to pasted images are not remembered between sessions.');
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
  $('#btnFrames').onclick = () => { state.ui.framesOpen = !state.ui.framesOpen; applyFramesOpen(); persist(); };
  $('#btnAll').onclick = () => { state.items.forEach((i) => (i.selected = true)); refreshGrid(); };
  $('#btnNone').onclick = () => { state.items.forEach((i) => (i.selected = false)); refreshGrid(); };
  $('#btnFrameAll').onclick = frameAll;
  $('#btnZip').onclick = zipAll;
  $('#btnSave').onclick = () => saveCurrent(false);
  $('#btnSaveAs').onclick = () => saveCurrent(true);
  $('#btnShow').onclick = () => state.lastOut && api.showInFolder(state.lastOut);
  $('#editOnly').onchange = (e) => { state.editOnly = e.target.checked; };
  $('#btnResetImg').onclick = () => { const it = curItem(); if (it) { it.override = {}; it.redo = []; it.editVer++; state.cut = null; syncControls(); schedulePreview(0); updateTile(state.cur); persistEdits(); } };
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
  window.addEventListener('paste', handlePaste);
  api.onAiProgress(({ got, total }) => {
    const p = $('#prog');
    p.hidden = false;
    p.max = total;
    p.value = got;
    setStatus(`Downloading the RMBG-2.0 model: ${Math.round(got / 1e6)} of ${Math.round(total / 1e6)} MB`);
  });
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
  state.defaultFrame = await api.defaultFramePath();
  state.recentFrames = (Array.isArray(s.recentFrames) ? s.recentFrames : []).filter((x) => typeof x === 'string' && !sameFile(x, state.defaultFrame)).slice(0, RECENT_MAX);
  state.ui.framesOpen = !!s.framesOpen;
  applyFramesOpen();
  state.editsStore = await api.getEdits();
  syncControls();
  const def = await api.defaultFramePath();
  if (s.framePath && (await api.exists(s.framePath))) await loadFrame(s.framePath, { keepOrder: true });
  else if (await api.exists(def)) await loadFrame(def, { keepOrder: true });
  schedulePreview(0);
}
init();
window.__tf = Object.assign(state, { openFolder, openImages, loadFrame, frameAll, saveCurrent, selectItem, renderPreview, pushEdit, undo, redo, resetEdits, setTool, srcPoint, buildCut, buildSources, flushEdits, rememberFrame, renderFrameList, runAi, computeMatte, eff, compositeFor, resolveCfg }); // DevTools / tests
