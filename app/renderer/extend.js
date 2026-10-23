// "Extend edges" tool: pads an image with more canvas and fills the new border from the picture itself (mirror or edge smear, softened with distance),
// instead of a flat colour. Unlike the model tools it accepts images with transparency. The maths is lib/extendedges.js, run by lib/extendedges.worker.js.
// The preview is live: a result up to PREVIEW_MAX px on its longest side is the real thing; a bigger one is previewed at reduced size and the full image
// is built when Process is pressed (it asks first when very large). Saving needs the full image.
import { fitRect } from './lib/cleanframe.js';
import { EXTEND_DEFAULTS, MAX_EXTEND_PIXELS, PREVIEW_MAX, squarePadding } from './lib/extendedges.js';
import { buildControls, confirmHeavy, el, makeRpc } from './ui-kit.js';

const $ = (s, r = document) => r.querySelector(s);
const SIDES = ['top', 'right', 'bottom', 'left'];

const specFor = (onSquare) => [
  { t: 'subhead', label: 'Padding' },
  ...SIDES.map((k) => ({ k, label: k[0].toUpperCase() + k.slice(1) + ' (px)', min: 0, max: 2000, step: 1, tip: `New pixels added along the ${k} edge.` })),
  { k: 'link', label: 'Link sides', t: 'check', tip: 'Changing one side changes all four.' },
  { t: 'custom', full: true, build(ctl) { const b = el('button', null, 'Pad to square'); b.title = 'Pad the short side so the result is square, centred (handy for tokens)'; b.onclick = onSquare; ctl.append(b); } },
  { t: 'subhead', label: 'Fill' },
  { k: 'mode', label: 'Fill with', t: 'select', opts: [['mirror', 'Mirror the picture'], ['smear', 'Smear the edge'], ['transparent', 'Transparent']], tip: 'Mirror reflects the picture outward (no doubled line at the seam). Smear repeats the edge pixels. Transparent just adds empty canvas.' },
  { k: 'blur', label: 'Soften with distance', min: 0, max: 1, step: 0.01, show: (p) => p.mode !== 'transparent', tip: 'Blur that grows the farther a pixel is from the picture, so the far edge is a calm wash instead of a hard echo. 0 = none.' },
  { t: 'subhead', label: 'View' },
  { k: 'showBounds', label: 'Outline the original', t: 'check', tip: 'Draws a thin line around where the original picture sits (preview only, never saved).' }
];

export function initExtendEdges({ api, openImages, dirOf, sepOf, baseOf }) {
  const root = $('#extend');
  const canvas = $('#exPreview');
  const ctx = canvas.getContext('2d');
  const S = canvas.width;
  const params = { ...EXTEND_DEFAULTS };
  const rpc = makeRpc('lib/extendedges.worker.js', (m) => setMsg(`The fill worker stopped: ${m}`, true));
  let src = null;                       // { path, name, w, h, canvas }
  let result = null;                    // { canvas, key, w, h }
  let busy = false, timer = 0, runReq = 0, loadReq = 0, ui = null;
  const view = { z: 1, x: 0, y: 0 };

  const setMsg = (text, warn = false) => { const m = $('#exMsg'); m.textContent = text; m.style.color = warn ? 'var(--warn)' : ''; };
  const toCanvas = (rgba, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0); return c; };
  const pad = () => Object.fromEntries(SIDES.map((k) => [k, Math.max(0, Math.round(+params[k] || 0))]));
  const outSize = () => { const p = pad(); return src ? { w: src.w + p.left + p.right, h: src.h + p.top + p.bottom } : { w: 0, h: 0 }; };
  const hasPad = () => { const p = pad(); return SIDES.some((k) => p[k] > 0); };
  const keyOf = () => JSON.stringify([pad(), params.mode, params.mode === 'transparent' ? 0 : params.blur]);
  const fresh = () => !!result && result.key === keyOf();
  /** The result is current AND full size (a reduced preview is not enough to save). */
  const saveable = () => fresh() && result.full;
  /** How much smaller than full size the live preview is made (1 = the real image). */
  const previewScale = () => { const s = outSize(); return Math.min(1, PREVIEW_MAX / Math.max(s.w, s.h, 1)); };

  // ---------------------------------------------------------------- drawing
  function redraw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S, S);
    const img = (hasPad() && result?.canvas) || src?.canvas;
    if (!img) { $('#exBadge').textContent = ''; return; }
    const f = fitRect(img.width, img.height, S);
    ctx.setTransform(view.z, 0, 0, view.z, view.x, view.y);
    ctx.imageSmoothingEnabled = view.z < 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, f.x, f.y, f.w, f.h);
    if (params.showBounds && img === result?.canvas) {
      const b = result.inner, k = f.w / img.width;
      ctx.lineWidth = 1.5 / view.z;
      ctx.strokeStyle = '#ffffff'; ctx.strokeRect(f.x + b.x * k, f.y + b.y * k, b.w * k, b.h * k);
      ctx.strokeStyle = '#000000'; ctx.setLineDash([4 / view.z, 4 / view.z]); ctx.strokeRect(f.x + b.x * k, f.y + b.y * k, b.w * k, b.h * k); ctx.setLineDash([]);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const shown = img === result?.canvas && !result.full ? ' · preview' : '';
    $('#exBadge').textContent = `${img.width}×${img.height}${shown}${busy ? ' · working…' : ''}${view.z > 1 ? ` · ${Math.round(view.z * 100)}%` : ''}`;
  }
  const resetView = () => { view.z = 1; view.x = 0; view.y = 0; redraw(); };
  const toCanvasPoint = (e) => { const r = canvas.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * S, y: ((e.clientY - r.top) / r.height) * S }; };
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = toCanvasPoint(e), z = Math.min(32, Math.max(1, view.z * Math.pow(1.15, -e.deltaY / 100)));
    view.x = p.x - (p.x - view.x) * (z / view.z); view.y = p.y - (p.y - view.y) * (z / view.z); view.z = z;
    if (z === 1) { view.x = 0; view.y = 0; }
    redraw();
  }, { passive: false });
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { if (view.z > 1) { drag = { px: e.clientX, py: e.clientY, x: view.x, y: view.y }; canvas.setPointerCapture(e.pointerId); } });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = canvas.getBoundingClientRect();
    view.x = drag.x + ((e.clientX - drag.px) / r.width) * S; view.y = drag.y + ((e.clientY - drag.py) / r.height) * S;
    redraw();
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('dblclick', resetView);

  // ---------------------------------------------------------------- loading
  async function loadPath(p) {
    const req = ++loadReq;
    try {
      setMsg('Loading…');
      const bytes = await api.readFile(p);
      const bmp = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(bmp, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height);
      bmp.close();
      if (req !== loadReq) return;
      const buf = d.data.buffer.slice(0);
      await rpc.ask({ type: 'load', rgba: buf, w: c.width, h: c.height }, [buf]);
      if (req !== loadReq) return;
      src = { path: p, name: baseOf(p), w: c.width, h: c.height, canvas: c };
      result = null; runReq++; resetView();
      const label = $('#exName');
      label.textContent = p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
      label.title = p; label.classList.remove('muted');
      refreshButtons();
      await refresh();
    } catch (err) {
      setMsg(`Could not open that image: ${err.message}`, true);
    }
  }
  async function pickImage() {
    const picked = await api.pickImages({ multi: false });
    if (picked?.length) await loadPath(picked[0]);
  }

  // ---------------------------------------------------------------- filling
  function refreshButtons() {
    $('#exProcess').disabled = busy || !src || !hasPad() || saveable();
    $('#exSave').disabled = $('#exSaveOpen').disabled = busy || !src || !hasPad() || !saveable();
  }
  /**
   * The padded picture for the current controls. The live preview (manual = false) is the real image when it is small, otherwise a reduced copy;
   * Process (manual = true) always builds the full image. The worker answers requests in order; a superseded answer is dropped.
   */
  async function run(manual = false) {
    const job = src;
    clearTimeout(timer); timer = 0;
    if (!job || !hasPad()) { result = null; runReq++; busy = false; refreshButtons(); redraw(); return; }
    const { w, h } = outSize(), key = keyOf(), p = pad();
    if (w * h > MAX_EXTEND_PIXELS) { setMsg(`That would be ${w}×${h} (${(w * h / 1e6).toFixed(0)} megapixels), more than the ${MAX_EXTEND_PIXELS / 1e6} megapixel limit.`, true); return; }
    if (manual && !confirmHeavy(w, h, 'Extending the edges')) { setMsg('Cancelled.'); return; }
    const scale = manual ? 1 : previewScale();
    const req = ++runReq;
    busy = true; refreshButtons(); redraw();
    try {
      setMsg(scale < 1 ? 'Updating the preview…' : 'Filling…');
      const out = await rpc.ask({ type: 'extend', params: { ...params, ...p }, scale });
      if (job !== src || req !== runReq) return;
      result = { canvas: toCanvas(out.rgba, out.w, out.h), key, w, h, full: out.scale === 1, inner: out.inner };
      setMsg(result.full ? `${job.w}×${job.h} → ${w}×${h}. Scroll to zoom, drag to pan, double-click to reset.` : `Preview at reduced size (${out.w}×${out.h}). Press Process to build the full ${w}×${h} image, then save.`);
    } catch (err) {
      if (req === runReq) setMsg(`Could not extend the image: ${err.message}`, true);
    } finally {
      if (req === runReq) busy = false;
      refreshButtons(); redraw();
    }
  }
  /** After any change: update the (possibly reduced-size) live preview shortly. */
  function schedule() {
    clearTimeout(timer); timer = 0;
    refreshButtons(); redraw();
    if (!src) return;
    if (!hasPad()) { setMsg(`${src.w}×${src.h}. Set how much to add on each side, or use Pad to square.`); return; }
    timer = setTimeout(run, 150);
  }
  const refresh = async () => { schedule(); if (timer) { clearTimeout(timer); timer = 0; await run(); } };

  function changed(k) {
    if (params.link && SIDES.includes(k)) for (const s of SIDES) params[s] = params[k];
    ui.sync();
    if (k === 'showBounds') { redraw(); return; }
    schedule();
  }
  function padToSquare() {
    if (!src) return;
    Object.assign(params, squarePadding(src.w, src.h));
    params.link = false;
    ui.sync(); schedule();
  }
  ui = buildControls($('#exControls'), specFor(padToSquare), params, changed);

  // ---------------------------------------------------------------- saving
  async function saveTo(outPath) {
    if (!saveable() || !hasPad()) throw new Error('Press Process to build the full-size image first');
    const blob = await new Promise((res, rej) => result.canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG encode failed'))), 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await api.writeFile(outPath, bytes);
    return { path: outPath, w: result.w, h: result.h, bytes: bytes.length };
  }
  function defaultName() {
    const name = `${src?.name || 'Image'} (extended).png`; // no "Token"/"Frame" in it, so folder mode does not skip the result
    return src?.path ? `${dirOf(src.path)}${sepOf(src.path)}${name}` : name;
  }
  async function saveClicked(andOpen) {
    if (!saveable()) return;
    let out = await api.pickSave(defaultName(), 'png');
    if (!out) return;
    if (!/\.png$/i.test(out)) out += '.png';
    $('#exSave').disabled = $('#exSaveOpen').disabled = true;
    try {
      setMsg('Saving…');
      const r = await saveTo(out);
      if (andOpen) { await openImages([out]); close(); }
      else setMsg(`Saved ${r.path} (${r.w}×${r.h})`);
    } catch (err) {
      setMsg(`Could not save: ${err.message}`, true);
    } finally {
      refreshButtons();
    }
  }

  // ---------------------------------------------------------------- open / close / wiring
  const isOpen = () => !root.hidden;
  function open() { root.hidden = false; refreshButtons(); redraw(); }
  function close() { root.hidden = true; }
  function reset() { Object.assign(params, EXTEND_DEFAULTS); ui.sync(); schedule(); }

  $('#exOpen').onclick = pickImage;
  $('#exClose').onclick = close;
  $('#exReset').onclick = reset;
  $('#exProcess').onclick = () => run(true);
  $('#exSave').onclick = () => saveClicked(false);
  $('#exSaveOpen').onclick = () => saveClicked(true);
  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', async (e) => { // not stopped, so the window-level handler still clears the drag highlight
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    const p = f && api.pathForFile(f);
    if (p) await loadPath(p);
  });
  refreshButtons();

  return {
    open, close, isOpen, loadPath, saveTo,
    /** For tests: set controls (as the UI would), then wait for the fill to finish. */
    async setParams(p) { Object.assign(params, p); if (params.link && SIDES.some((k) => k in p)) { const k = SIDES.find((s) => s in p); for (const s of SIDES) params[s] = params[k]; } ui.sync(); clearTimeout(timer); await run(); },
    padToSquare,
    process: () => run(true),
    get params() { return { ...params }; },
    get result() { return result?.canvas || null; },
    get source() { return src?.canvas || null; },
    get fresh() { return fresh(); },
    get full() { return !!result?.full; },
    get busy() { return busy; },
    /** For tests: save to a known path, then do what "Save and open as image" does. */
    async saveAndOpen(outPath) { const r = await saveTo(outPath); await openImages([outPath]); close(); return r; }
  };
}
