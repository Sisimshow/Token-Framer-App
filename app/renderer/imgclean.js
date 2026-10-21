// "Clean image" tool: runs a 1x restoration model (converted with tools/convert-model.py, kept in app/models) over an opaque image, with a before/after view.
// The model sees RGB only, so an image that already has transparency cannot be cleaned and is refused. Inference runs in the main process (onnxruntime-node).
import { fitRect } from './lib/cleanframe.js';

const $ = (s, r = document) => r.querySelector(s);

export function initImageCleaner({ api, openImages, dirOf, sepOf, baseOf }) {
  const root = $('#imgclean');
  const canvas = $('#icPreview');
  const ctx = canvas.getContext('2d');
  const S = canvas.width;
  let models = [], model = '';
  let src = null;                       // { path, name, w, h, rgba, canvas, opaque }
  let cleanedCanvas = null, info = null, showOriginal = false, busy = false, token = 0;
  const view = { z: 1, x: 0, y: 0 };    // zoom and pan of the preview (canvas pixels)

  const setMsg = (text, warn = false) => { const m = $('#icMsg'); m.textContent = text; m.style.color = warn ? 'var(--warn)' : ''; };
  const toCanvas = (rgba, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0); return c; };

  // ---------------------------------------------------------------- drawing
  function redraw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S, S);
    const img = showOriginal ? src?.canvas : cleanedCanvas || src?.canvas;
    if (!img) return;
    const f = fitRect(img.width, img.height, S);
    ctx.setTransform(view.z, 0, 0, view.z, view.x, view.y);
    ctx.imageSmoothingEnabled = view.z < 2; // zoomed in far enough, show real pixels so the cleanup can be judged
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, f.x, f.y, f.w, f.h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    $('#icBadge').textContent = src ? `${showOriginal || !cleanedCanvas ? 'Original' : 'Cleaned'}${view.z > 1 ? ` · ${Math.round(view.z * 100)}%` : ''}` : '';
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

  // ---------------------------------------------------------------- models
  async function refreshModels() {
    models = await api.listModels();
    const sel = $('#icModel');
    sel.textContent = '';
    for (const m of models) { const o = document.createElement('option'); o.value = m.name; o.textContent = m.name; sel.append(o); }
    if (!models.some((m) => m.name === model)) model = models[0]?.name || '';
    sel.value = model;
    if (!models.length) setMsg('No models found. Convert one with tools/convert-model.py (see the README) and put the .onnx file in the app\'s models folder.', true);
  }

  // ---------------------------------------------------------------- loading and cleaning
  async function loadPath(p) {
    try {
      setMsg('Loading…');
      const bytes = await api.readFile(p);
      const bmp = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(bmp, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height);
      bmp.close();
      let opaque = true;
      for (let i = 3; i < d.data.length; i += 4) if (d.data[i] !== 255) { opaque = false; break; }
      src = { path: p, name: baseOf(p), w: c.width, h: c.height, rgba: d.data, canvas: c, opaque };
      cleanedCanvas = null; info = null; resetView();
      const label = $('#icName');
      label.textContent = p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
      label.title = p; label.classList.remove('muted');
      enableSave(false);
      if (!opaque) { setMsg('This image already has transparency. The cleanup model works on RGB only, so it cannot clean images with transparency. Use an opaque image, for example a render on a solid background.', true); return; }
      await run();
    } catch (err) {
      setMsg(`Could not open that image: ${err.message}`, true);
    }
  }
  async function pickImage() {
    const picked = await api.pickImages({ multi: false });
    if (picked?.length) await loadPath(picked[0]);
  }

  async function run() {
    if (!src || !src.opaque || !model || busy) return;
    busy = true;
    const mine = ++token;
    enableSave(false);
    try {
      setMsg('Cleaning…');
      const rgba = new Uint8Array(src.rgba.buffer.slice(src.rgba.byteOffset, src.rgba.byteOffset + src.rgba.byteLength)); // a copy, the original stays for the before view
      const r = await api.cleanImage(model, rgba, src.w, src.h);
      if (mine !== token) return;
      cleanedCanvas = toCanvas(new Uint8ClampedArray(r.rgba.buffer, r.rgba.byteOffset, r.rgba.byteLength), src.w, src.h);
      info = { ms: r.ms, provider: r.provider, w: src.w, h: src.h };
      setMsg(`Cleaned ${src.w}×${src.h} with ${model} in ${(r.ms / 1000).toFixed(2)} s on ${r.provider}. Scroll to zoom, drag to pan, double-click to reset.`);
      enableSave(true);
      redraw();
    } catch (err) {
      setMsg(`Could not clean the image: ${err.message}`, true);
    } finally {
      busy = false;
    }
  }
  api.onModelProgress(({ done, total }) => { if (busy && total > 1) setMsg(`Cleaning… tile ${done} of ${total}`); });

  // ---------------------------------------------------------------- saving
  const enableSave = (on) => { $('#icSave').disabled = $('#icSaveOpen').disabled = !on; };
  async function saveTo(outPath) {
    if (!cleanedCanvas) throw new Error('Clean an image first');
    const blob = await new Promise((res, rej) => cleanedCanvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG encode failed'))), 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await api.writeFile(outPath, bytes);
    return { path: outPath, w: cleanedCanvas.width, h: cleanedCanvas.height, bytes: bytes.length };
  }
  function defaultName() {
    const name = `${src?.name || 'Image'} (clean).png`;
    return src?.path ? `${dirOf(src.path)}${sepOf(src.path)}${name}` : name;
  }
  async function saveClicked(andOpen) {
    if (!cleanedCanvas) return;
    let out = await api.pickSave(defaultName(), 'png');
    if (!out) return;
    if (!/\.png$/i.test(out)) out += '.png';
    enableSave(false);
    try {
      setMsg('Saving…');
      const r = await saveTo(out);
      if (andOpen) { await openImages([out]); close(); }
      else setMsg(`Saved ${r.path} (${r.w}×${r.h})`);
    } catch (err) {
      setMsg(`Could not save: ${err.message}`, true);
    } finally {
      enableSave(!!cleanedCanvas);
    }
  }

  // ---------------------------------------------------------------- open / close / wiring
  const isOpen = () => !root.hidden;
  async function open() {
    root.hidden = false;
    try { await refreshModels(); } catch (err) { setMsg(`Could not list models: ${err.message}`, true); }
    redraw();
  }
  function close() { root.hidden = true; }

  $('#icOpen').onclick = pickImage;
  $('#icClose').onclick = close;
  $('#icSave').onclick = () => saveClicked(false);
  $('#icSaveOpen').onclick = () => saveClicked(true);
  $('#icModel').onchange = (e) => { model = e.target.value; cleanedCanvas = null; run(); };
  $('#icOriginal').onchange = (e) => { showOriginal = e.target.checked; redraw(); };
  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', async (e) => { // not stopped, so the window-level handler still clears the drag highlight
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    const p = f && api.pathForFile(f);
    if (p) await loadPath(p);
  });
  enableSave(false);

  return {
    open, close, isOpen, loadPath, saveTo, refreshModels,
    get info() { return info; },
    get opaque() { return src ? src.opaque : null; },
    get model() { return model; },
    /** For tests: save to a known path, then do what "Save and open as image" does. */
    async saveAndOpen(outPath) { const r = await saveTo(outPath); await openImages([outPath]); close(); return r; },
    get cleaned() { return cleanedCanvas; },
    get original() { return src?.canvas || null; }
  };
}
