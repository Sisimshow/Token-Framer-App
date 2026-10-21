// "Clean image" / "Upscale image" tool: runs a 1x restoration model or an Nx upscaler (converted with tools/convert-model.py, kept in app/models) over an opaque image,
// with a before/after view. One screen, two modes: the mode only decides which models are offered and how things are named.
// The models see RGB only, so an image that already has transparency cannot be processed and is refused. Inference runs in the main process (onnxruntime-node).
import { fitRect } from './lib/cleanframe.js';

const $ = (s, r = document) => r.querySelector(s);

export function initImageCleaner({ api, openImages, dirOf, sepOf, baseOf }) {
  const root = $('#imgclean');
  const canvas = $('#icPreview');
  const ctx = canvas.getContext('2d');
  const S = canvas.width;
  let models = [], model = '', mode = 'clean';   // mode: 'clean' (1x models) or 'upscale' (Nx models)
  const modeModels = () => models.filter((m) => (mode === 'upscale' ? m.scale > 1 : m.scale === 1));
  let src = null;                       // { path, name, w, h, rgba, canvas, opaque }
  let cleanedCanvas = null, info = null, showOriginal = false, busy = false, dirty = false, currentJob = '';
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
    const list = modeModels(), sel = $('#icModel');
    sel.textContent = '';
    for (const m of list) { const o = document.createElement('option'); o.value = m.name; o.textContent = m.scale > 1 ? `${m.name} (${m.scale}×)` : m.name; sel.append(o); }
    if (!list.some((m) => m.name === model)) model = (mode === 'upscale' && list.find((m) => m.name === '4x-UltraSharpV2')?.name) || list[0]?.name || ''; // the Upscale (Basic) workflow's default
    sel.value = model;
    if (!list.length) setMsg(`No ${mode === 'upscale' ? 'upscaling' : 'cleanup'} models found. Convert one with tools/convert-model.py (see the README) and put the .onnx file in the models folder.`, true);
  }

  // ---------------------------------------------------------------- loading and cleaning
  let loadReq = 0;
  async function loadPath(p) {
    const req = ++loadReq; // the most recently requested image wins, whichever finishes decoding last
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

  /** Cleans the current image with the current model. If another image or model is chosen while a job runs, that job's result is thrown away and the newest request runs next. */
  async function run() {
    if (busy) { dirty = true; return; }
    busy = true;
    try {
      do {
        dirty = false;
        const job = src, name = model;
        if (!job || !job.opaque || !name) break;
        enableSave(false);
        setMsg('Cleaning…');
        let r;
        try {
          const rgba = new Uint8Array(job.rgba.buffer.slice(job.rgba.byteOffset, job.rgba.byteOffset + job.rgba.byteLength)); // a copy, the original stays for the before view
          currentJob = `ic-${crypto.randomUUID()}`;
          r = await api.cleanImage(name, rgba, job.w, job.h, currentJob);
        } catch (err) {
          if (job === src && name === model) setMsg(`Could not clean the image: ${err.message}`, true);
          continue;
        }
        if (job !== src || name !== model) { dirty = true; continue; } // superseded while it ran: never show it
        cleanedCanvas = toCanvas(new Uint8ClampedArray(r.rgba.buffer, r.rgba.byteOffset, r.rgba.byteLength), r.w, r.h);
        info = { ms: r.ms, provider: r.provider, w: r.w, h: r.h, scale: r.scale };
        setMsg(`${r.scale > 1 ? `Upscaled ${job.w}×${job.h} to ${r.w}×${r.h}` : `Cleaned ${job.w}×${job.h}`} with ${name} in ${(r.ms / 1000).toFixed(2)} s on ${r.provider}. Scroll to zoom, drag to pan, double-click to reset.`);
        enableSave(true);
        redraw();
      } while (dirty);
    } finally {
      busy = false;
    }
  }
  api.onModelProgress(({ done, total, id }) => { if (busy && id === currentJob && total > 1) setMsg(`Cleaning… tile ${done} of ${total}`); });

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
    const scale = models.find((m) => m.name === model)?.scale || 1;
    const name = `${src?.name || 'Image'} (${scale > 1 ? `${scale}x` : 'clean'}).png`;
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
  /** mode 'clean' offers the 1x models, 'upscale' the Nx ones; switching mode drops the loaded image's result. */
  async function open(nextMode = mode) {
    root.hidden = false;
    if (nextMode !== mode) { mode = nextMode; cleanedCanvas = null; info = null; model = ''; enableSave(false); }
    $('#icTitle').textContent = mode === 'upscale' ? 'Upscale image' : 'Clean image';
    $('#icHint').textContent = mode === 'upscale'
      ? 'An upscaler enlarges an opaque image 2× or 4× and adds detail. The models work on RGB only, so they cannot process an image that already has transparency. Saved as a PNG.'
      : 'The model works on RGB only: it cleans opaque images (for example a render on a solid background) and cannot clean an image that already has transparency. Saved as a PNG.';
    try { await refreshModels(); } catch (err) { setMsg(`Could not list models: ${err.message}`, true); }
    redraw();
    if (src && src.opaque && !cleanedCanvas) run(); // an image already loaded in the other mode is processed with this mode's model
  }
  function close() { root.hidden = true; }

  $('#icOpen').onclick = pickImage;
  $('#icClose').onclick = close;
  $('#icSave').onclick = () => saveClicked(false);
  $('#icSaveOpen').onclick = () => saveClicked(true);
  $('#icModel').onchange = (e) => { model = e.target.value; cleanedCanvas = null; enableSave(false); run(); };
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
    get mode() { return mode; },
    /** For tests: save to a known path, then do what "Save and open as image" does. */
    async saveAndOpen(outPath) { const r = await saveTo(outPath); await openImages([outPath]); close(); return r; },
    get cleaned() { return cleanedCanvas; },
    get original() { return src?.canvas || null; }
  };
}
