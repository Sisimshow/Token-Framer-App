// "Clean image" / "Upscale image" tool: runs a 1x restoration model or an Nx upscaler (converted with tools/convert-model.py, kept in app/models) over an opaque image,
// with a before/after view. One screen, two modes: the mode only decides which models are offered and how things are named.
// The models see RGB only, so an image that already has transparency cannot be processed and is refused. Inference runs in the main process (onnxruntime-node).
import { fitRect } from './lib/cleanframe.js';
import { confirmHeavy, makeRpc } from './ui-kit.js';

const $ = (s, r = document) => r.querySelector(s);

export function initImageCleaner({ api, openImages, dirOf, sepOf, baseOf }) {
  const root = $('#imgclean');
  const canvas = $('#icPreview');
  const ctx = canvas.getContext('2d');
  const S = canvas.width;
  let models = [], model = '', mode = 'clean';   // mode: 'clean' (1x models) or 'upscale' (Nx models)
  const modeModels = () => models.filter((m) => (mode === 'upscale' ? m.scale > 1 : m.scale === 1));
  let src = null;                       // { path, name, w, h, rgba, canvas, opaque }
  let cleanedCanvas = null, info = null, showOriginal = false, busy = false, currentJob = '';
  let scale = 4, raw = null, applyReq = 0;   // scale: the chosen upscale factor; raw: the model's own output ({rgba,w,h,scale,ms,provider,job,name}), kept so a smaller factor needs no second model run
  const resizer = makeRpc('lib/resize.worker.js', (m) => setMsg(`The resize worker stopped: ${m}`, true));
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
    $('#icBadge').textContent = src ? `${showOriginal || !cleanedCanvas ? 'Original' : mode === 'upscale' ? 'Upscaled' : 'Cleaned'}${view.z > 1 ? ` · ${Math.round(view.z * 100)}%` : ''}` : '';
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
    if (!list.some((m) => m.name === model)) model = (mode === 'upscale' && list.find((m) => m.name === '4x-UltraMix_Smooth')?.name) || list[0]?.name || ''; // the Upscale (Basic) workflow's default
    sel.value = model;
    refreshScales();
    if (!list.length) setMsg(`No ${mode === 'upscale' ? 'upscaling' : 'cleanup'} models found. Convert one with tools/convert-model.py (see the README) and put the .onnx file in the models folder.`, true);
  }

  /** The factors offered for the chosen model: 2, 3 and 4 up to the model's own scale (a smaller factor is made by shrinking the model's output). Only shown in upscale mode. */
  function refreshScales() {
    const ms = models.find((m) => m.name === model)?.scale || 1;
    const opts = [2, 3, 4].filter((n) => n <= ms);
    if (ms > 4) opts.push(ms);
    $('#icScaleRow').hidden = mode !== 'upscale' || !opts.length;
    const sel = $('#icScale');
    sel.textContent = '';
    for (const n of opts) { const o = document.createElement('option'); o.value = n; o.textContent = `${n}×`; sel.append(o); }
    if (!opts.includes(scale)) scale = opts.includes(4) ? 4 : opts[opts.length - 1] || ms;
    sel.value = scale;
  }
  const readyMsg = () => (src?.opaque && model ? `Press Process to ${mode === 'upscale' ? 'upscale' : 'clean'} the image with ${model}${mode === 'upscale' ? ` (${scale}×)` : ''}.` : '');
  /** Process is available once there is an opaque image and a model; saving once there is a result. Both wait while a job runs. */
  const refreshButtons = () => { $('#icProcess').disabled = busy || !(src && src.opaque && model); $('#icSave').disabled = $('#icSaveOpen').disabled = busy || !cleanedCanvas; };

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
      cleanedCanvas = null; info = null; raw = null; applyReq++; resetView();   // the old result (and a resize of it still running) belongs to the previous image
      const label = $('#icName');
      label.textContent = p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
      label.title = p; label.classList.remove('muted');
      refreshButtons();
      if (!opaque) { setMsg('This image already has transparency. The cleanup model works on RGB only, so it cannot clean images with transparency. Use an opaque image, for example a render on a solid background.', true); return; }
      setMsg(`${src.w}×${src.h} loaded. ${readyMsg()}`);
    } catch (err) {
      setMsg(`Could not open that image: ${err.message}`, true);
    }
  }
  async function pickImage() {
    const picked = await api.pickImages({ multi: false });
    if (picked?.length) await loadPath(picked[0]);
  }

  /** Runs the chosen model over the current image (only when Process is pressed: the models can take a while). If another image or model is chosen meanwhile, the result is thrown away. */
  async function run() {
    const job = src, name = model;
    if (busy || !job || !job.opaque || !name) return;
    const ms = models.find((m) => m.name === name)?.scale || 1;
    if (!confirmHeavy(job.w * ms, job.h * ms, ms > 1 ? `The ${ms}× model` : 'The model')) { setMsg(`Cancelled. ${readyMsg()}`); return; }
    busy = true;
    cleanedCanvas = null; info = null; raw = null;
    refreshButtons(); redraw();
    try {
      setMsg('Processing…');
      const rgba = new Uint8Array(job.rgba.buffer.slice(job.rgba.byteOffset, job.rgba.byteOffset + job.rgba.byteLength)); // a copy, the original stays for the before view
      currentJob = `ic-${crypto.randomUUID()}`;
      const r = await api.cleanImage(name, rgba, job.w, job.h, currentJob);
      if (job !== src || name !== model) { setMsg(`The image or model changed while processing. ${readyMsg()}`); return; } // superseded: never show it
      raw = { rgba: new Uint8ClampedArray(r.rgba.buffer, r.rgba.byteOffset, r.rgba.byteLength), w: r.w, h: r.h, scale: r.scale, ms: r.ms, provider: r.provider, job, name };
      await applyScale();
    } catch (err) {
      if (job === src && name === model) setMsg(`Could not process the image: ${err.message}`, true);
    } finally {
      busy = false;
      refreshButtons();
    }
  }
  /** Turns the model's raw output into the shown result at the chosen factor: as is, or shrunk (Lanczos, in a worker) when a smaller factor than the model's is wanted. */
  async function applyScale() {
    const r = raw, req = ++applyReq;
    if (!r || r.job !== src || r.name !== model) return;
    const target = mode === 'upscale' ? Math.min(scale, r.scale) : r.scale;
    let rgba = r.rgba, w = r.w, h = r.h;
    if (target !== r.scale) {
      setMsg(`Scaling the ${r.scale}× result to ${target}×…`);
      const buf = r.rgba.slice().buffer; // a copy goes to the worker, the full-size result stays for other factors
      const out = await resizer.ask({ type: 'resize', rgba: buf, sw: r.w, sh: r.h, dw: r.job.w * target, dh: r.job.h * target }, [buf]);
      if (req !== applyReq || r !== raw) return; // a newer factor or image took over
      rgba = out.rgba; w = out.w; h = out.h;
    }
    cleanedCanvas = toCanvas(rgba, w, h);
    info = { ms: r.ms, provider: r.provider, w, h, scale: target };
    setMsg(`${target > 1 ? `Upscaled ${r.job.w}×${r.job.h} to ${w}×${h}` : `Cleaned ${r.job.w}×${r.job.h}`} with ${r.name} in ${(r.ms / 1000).toFixed(2)} s on ${r.provider}. Scroll to zoom, drag to pan, double-click to reset.`);
    refreshButtons();
    redraw();
  }
  api.onModelProgress(({ done, total, id }) => { if (busy && id === currentJob && total > 1) setMsg(`Processing… tile ${done} of ${total}`); });

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
    const factor = info?.scale || 1;
    const name = `${src?.name || 'Image'} (${factor > 1 ? `${factor}x` : 'clean'}).png`;
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
    if (nextMode !== mode) { mode = nextMode; cleanedCanvas = null; info = null; raw = null; model = ''; }
    $('#icTitle').textContent = mode === 'upscale' ? 'Upscale image' : 'Clean image';
    $('#icHint').textContent = mode === 'upscale'
      ? 'An upscaler enlarges an opaque image 2× or 4× and adds detail. The models work on RGB only, so they cannot process an image that already has transparency. Saved as a PNG.'
      : 'The model works on RGB only: it cleans opaque images (for example a render on a solid background) and cannot clean an image that already has transparency. Saved as a PNG.';
    try { await refreshModels(); } catch (err) { setMsg(`Could not list models: ${err.message}`, true); }
    refreshButtons();
    redraw();
    if (src?.opaque && !cleanedCanvas && !busy) setMsg(readyMsg()); // an image already loaded in the other mode waits for Process with this mode's model
  }
  function close() { root.hidden = true; }

  $('#icOpen').onclick = pickImage;
  $('#icClose').onclick = close;
  $('#icSave').onclick = () => saveClicked(false);
  $('#icSaveOpen').onclick = () => saveClicked(true);
  $('#icProcess').onclick = run;
  $('#icModel').onchange = (e) => { model = e.target.value; cleanedCanvas = null; info = null; raw = null; refreshScales(); refreshButtons(); redraw(); if (src?.opaque) setMsg(readyMsg()); };
  $('#icScale').onchange = async (e) => { // a result from the same model is resized on the spot; otherwise the new factor waits for Process
    scale = +e.target.value;
    if (raw && raw.job === src && raw.name === model) { try { await applyScale(); } catch (err) { setMsg(`Could not scale the result: ${err.message}`, true); } }
    else if (src?.opaque) setMsg(readyMsg());
  };
  $('#icOriginal').onchange = (e) => { showOriginal = e.target.checked; redraw(); };
  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', async (e) => { // not stopped, so the window-level handler still clears the drag highlight
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    const p = f && api.pathForFile(f);
    if (p) await loadPath(p);
  });
  refreshButtons();

  return {
    open, close, isOpen, loadPath, saveTo, refreshModels,
    /** For tests: what the Process button does (resolves when the job is done). */
    process: run,
    get scale() { return scale; },
    setScale(n) { const sel = $('#icScale'); sel.value = n; return sel.onchange({ target: sel }); },
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
