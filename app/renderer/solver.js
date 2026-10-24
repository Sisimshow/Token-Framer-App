// "Solve frame background" / "Solve image background" tool: a transparent frame (or any image) from the same render on a white and on a black background (triangulation matting).
// One screen, two modes: 'frame' trims, resizes and can clear the middle (Token Background Solver V2), 'image' keeps the whole picture (Image Background Solver V2).
// Maths in lib/solveframe.js, run by lib/solveframe.worker.js. Same screen layout as Clean frame (see cleaner.js).
import { fitRect } from './lib/cleanframe.js';
import { SOLVE_DEFAULTS } from './lib/solveframe.js';
import { buildControls, confirmHeavy, drawInSquare, makeRpc } from './ui-kit.js';

const $ = (s, r = document) => r.querySelector(s);

/** The control rows for a mode. Image mode stops before the Trim section: it keeps the whole picture, with no resize and no cut-out middle. */
const specFor = (models, mode) => {
  const spec = [
  { t: 'subhead', label: 'Pre-clean', show: () => models.length > 0 },
  { k: 'preClean', label: 'Clean noise first', t: 'check', show: () => models.length > 0, tip: 'Runs both renders through a restoration model first (the ComfyUI workflow does this with 1x_PureVision). It removes compression noise that would otherwise show up in the transparency. The model works on RGB only, which is fine because the renders are opaque.' },
  { k: 'preCleanModel', label: 'Model', t: 'select', opts: models.map((m) => [m, m]), show: (p) => models.length > 0 && p.preClean, tip: 'The model used for the pre-clean (the .onnx files in the models folder).' },
  { t: 'subhead', label: 'Matte' },
  { k: 'channelMode', label: 'Channel mode', t: 'select', opts: [['min', 'Min'], ['max', 'Max'], ['mean', 'Mean']], tip: 'The three colour channels each give an alpha estimate; this picks how they are combined. They should agree.' },
  { k: 'floor', label: 'Alpha floor', min: 0, max: 1, step: 0.001, tip: 'Alpha below this becomes fully transparent, which removes background noise.' },
  { k: 'ceiling', label: 'Alpha ceiling', min: 0, max: 1, step: 0.001, tip: 'Alpha above this becomes fully opaque, which keeps solid areas solid.' },
  { k: 'whiteLevel', label: 'White level', min: 0, max: 1, step: 0.001, tip: 'The real brightness of the light background if it is not pure white (see "White background measures" below).' },
  { k: 'blackLevel', label: 'Black level', min: 0, max: 1, step: 0.001, tip: 'The real brightness of the dark background if it is not pure black (see "Black background measures" below).' },
  { k: 'colorSource', label: 'Colour from', t: 'select', opts: [['white', 'White render'], ['black', 'Black render']], tip: 'Which render the colours come from. The alpha always uses both. Use the one with the better detail, usually the original generation.' },
  { t: 'subhead', label: 'Firm up' },
  { k: 'solidify', label: 'Solidify', min: 0, max: 4, step: 1, tip: 'Stacks the result on itself this many times, which reduces unwanted transparency in the ring. The ComfyUI workflow does it twice.' },
  { t: 'subhead', label: 'Trim' },
  { k: 'threshold', label: 'Crop threshold', min: 0, max: 1, step: 0.001, tip: 'Pixels with alpha above this count as part of the frame when trimming the empty border.' },
  { k: 'padding', label: 'Padding (px)', min: 0, max: 500, step: 1, tip: 'Extra pixels kept around the trimmed frame (never beyond the original image).' },
  { t: 'subhead', label: 'Output' },
  { k: 'resize', label: 'Resize', t: 'select', opts: [['fit', 'Fit, pad to a square'], ['stretch', 'Stretch to a square'], ['none', 'Keep trimmed size']], tip: 'Fit keeps the aspect ratio and centres the frame on a transparent square. Stretch squeezes it to fill (what the ComfyUI workflow does).' },
  { k: 'size', label: 'Size (px)', min: 128, max: 8192, step: 1, numberOnly: true, show: (p) => p.resize !== 'none' },
  { k: 'clearMiddle', label: 'Clear the middle', t: 'check', tip: 'Makes the middle of the output transparent with a fixed circle about half the width of the image. Turn it off if your frame\'s opening is smaller than that.' }
  ];
  if (mode === 'image') return spec.slice(0, spec.findIndex((c) => c.t === 'subhead' && c.label === 'Trim'));
  return spec;
};

// Settings per mode, so switching between the two screens keeps each one's values. The image set has the frame-only options switched off.
const IMAGE_OVERRIDES = { crop: false, resize: 'none', clearMiddle: false };

export function initSolver({ api, loadFrame, openImages, dirOf, sepOf, baseOf }) {
  const root = $('#solver');
  const canvas = $('#svPreview');
  const ctx = canvas.getContext('2d');
  const S = canvas.width;
  const paramSets = { frame: { ...SOLVE_DEFAULTS }, image: { ...SOLVE_DEFAULTS, ...IMAGE_OVERRIDES } };
  let mode = 'frame', params = paramSets.frame;   // `params` is the active mode's set (the controls are rebuilt on a mode change, so they follow it)
  // a crash loses the renders, their cleaned copies AND the "clear the middle" mask the worker held: the screen is cleared rather than left exporting without the mask
  const rpc = makeRpc('lib/solveframe.worker.js', (m) => { forgetAll(); setMsg(`The solver worker stopped (${m}). Open the white and black renders again.`, true); });
  const ask = rpc.ask;
  const slots = { white: null, black: null }; // { path, name, w, h, canvas }
  let result = null, resultCanvas = null, maskAlpha = null, maskReady = null;
  let busy = false, dirty = false, timer = 0, ui = null, view = 'result', models = [], builtFor = null;
  const jobs = new Map(); // model request id -> slot, so progress events go to the right message

  const setMsg = (text, warn = false) => { const m = $('#svMsg'); m.textContent = text; m.style.color = warn ? 'var(--warn)' : ''; };
  const toCanvas = (rgba, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0); return c; };

  /** The pre-clean is wanted: a model exists, the box is ticked and a model is chosen. */
  const usePre = () => models.length > 0 && !!params.preClean && !!params.preCleanModel;
  /** The pre-clean has been run (Process) on both renders with the chosen model, so the preview and the export use the cleaned copies. Until then they use the renders as they are. */
  const cleanedNow = () => usePre() && !!slots.white && !!slots.black && slots.white.cleanKey === params.preCleanModel && slots.black.cleanKey === params.preCleanModel;
  let cleaning = false, saving = false;
  /** Process is for the pre-clean only; saving waits for it when the pre-clean is wanted, so what is saved is what Process produced. */
  function refreshButtons() {
    const both = !!(slots.white && slots.black);
    $('#svProcess').disabled = !both || !usePre() || cleanedNow() || cleaning;
    $('#svSave').disabled = $('#svSaveLoad').disabled = !both || saving || cleaning || (usePre() && !cleanedNow());
  }
  /** The "Process" button: runs the pre-clean model over both renders, then re-solves with the cleaned copies. */
  async function processClicked() {
    if (cleaning || !usePre()) return;
    if (!confirmHeavy(Math.max(slots.white.w, slots.black.w), Math.max(slots.white.h, slots.black.h), 'The pre-clean')) return;
    cleaning = true; refreshButtons();
    try {
      await ensureCleanBoth();
      if (!cleanedNow()) setMsg('The renders or the model changed while processing. Press Process again.', true);
    } catch (err) {
      setMsg(`Could not process the renders: ${err.message}`, true);
    } finally {
      cleaning = false; refreshButtons();
    }
    if (cleanedNow()) await run();
  }
  const preferredModel = () => (models.includes('1x_PureVision') ? '1x_PureVision' : models[0] || '');

  /**
   * Makes sure `slot` has a cleaned copy from the chosen model (computed in the main process, then handed to the worker). Safe against the render being
   * replaced or the model changed while it runs: such a result is dropped. Resolves quietly when there is nothing to do.
   */
  async function ensureClean(slot) {
    const s = slots[slot], name = params.preCleanModel;
    if (!s || !usePre() || s.cleanKey === name) return;
    const jobId = `sv-${crypto.randomUUID()}`;
    jobs.set(jobId, slot);
    try {
      setMsg(`Processing the ${slot} render…`);
      const r = await api.cleanImage(name, new Uint8Array(s.rgba), s.w, s.h, jobId);
      if (slots[slot] !== s || params.preCleanModel !== name) return;     // replaced meanwhile
      s.cleanCanvas = toCanvas(new Uint8ClampedArray(r.rgba.buffer, r.rgba.byteOffset, r.rgba.byteLength), s.w, s.h);
      const buf = r.rgba.buffer.slice(r.rgba.byteOffset, r.rgba.byteOffset + r.rgba.byteLength);
      await ask({ type: 'setClean', slot, rgba: buf }, [buf]);
      if (slots[slot] !== s) return;
      s.cleanKey = name; s.cleanMs = r.ms; s.provider = r.provider;
    } finally {
      jobs.delete(jobId);
    }
  }
  const ensureCleanBoth = async () => { await ensureClean('white'); await ensureClean('black'); };

  function changed(k) {
    ui.sync();
    refreshButtons();
    if (k === 'resize' || k === 'size' || k === 'clearMiddle') { updateInfo(); redraw(); return; } // only the export (and the middle overlay) is affected
    schedule();
  }

  // ---------------------------------------------------------------- the "clear the middle" mask
  /** Loads the mask once: the worker gets it for the export, and the preview gets an alpha-only copy to cut the middle out of the drawing. */
  function ensureMask() {
    if (maskReady) return maskReady;
    maskReady = (async () => {
      const def = await api.defaultFramePath();
      const bytes = await api.readFile(`${dirOf(def)}${sepOf(def)}middle-mask.png`);
      const buf = bytes.slice().buffer;
      await ask({ type: 'mask', bytes: buf }, [buf]);
      const bmp = await createImageBitmap(new Blob([bytes]));
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(bmp, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < d.data.length; i += 4) { d.data[i + 3] = d.data[i]; d.data[i] = d.data[i + 1] = d.data[i + 2] = 255; } // white, alpha = the mask
      x.putImageData(d, 0, 0);
      maskAlpha = c;
    })();
    maskReady.catch(() => { maskReady = null; });
    return maskReady;
  }

  // ---------------------------------------------------------------- processing
  function schedule() { clearTimeout(timer); timer = setTimeout(run, 40); }
  async function run() {
    if (!slots.white || !slots.black) return;
    if (busy) { dirty = true; return; }
    busy = true;
    try {
      do {
        dirty = false;
        setMsg('Processing…');
        const r = await ask({ type: 'preview', params: { ...params, preClean: cleanedNow() } }); // real time: the model is not run here, only after Process
        result = r;
        resultCanvas = toCanvas(r.rgba, r.w, r.h);
        updateInfo(r.ms);
        showReport(r.report);
        redraw();
      } while (dirty);
    } catch (err) {
      result = null; resultCanvas = null;
      showReport(null);
      setMsg(err.message, true);
      redraw();
    } finally {
      busy = false;
    }
  }
  function updateInfo(ms) {
    if (!result) return;
    const out = params.resize === 'none' ? `${result.w}×${result.h}` : `${params.size}×${params.size}`;
    const pre = result.usedClean ? `, pre-cleaned with ${params.preCleanModel}` : '';
    const wait = usePre() && !cleanedNow() ? ' Press Process to clean the noise first: this preview uses the renders as they are.' : '';
    setMsg(`${mode === 'image' ? `Solved ${result.w}×${result.h}` : `Trimmed to ${result.w}×${result.h} (from ${slots.white.w}×${slots.white.h}), output ${out}`}${pre}${ms != null ? `, ${ms} ms` : ''}.${wait}`, false);
  }
  function showReport(r) {
    const box = $('#svReport');
    box.textContent = '';
    if (!r) return;
    const line = (text, warn) => { const d = document.createElement('div'); d.textContent = text; if (warn) d.className = 'warn'; box.append(d); };
    line(`White background measures ${r.whiteBg.toFixed(3)}, black ${r.blackBg.toFixed(3)}`);
    if (r.blackBg > r.whiteBg) line('The "white" render is darker than the "black" one at the border. Are they swapped?', true);
    if (Math.abs(r.whiteBg - params.whiteLevel) > 0.03) line(`The white background is not ${params.whiteLevel}: try White level ${r.whiteBg.toFixed(3)}.`, true);
    if (Math.abs(r.blackBg - params.blackLevel) > 0.03) line(`The black background is not ${params.blackLevel}: try Black level ${r.blackBg.toFixed(3)}.`, true);
    if (r.disagreement > 0.02) line(`The colour channels disagree (${r.disagreement.toFixed(3)}): the renders may not line up pixel for pixel, or the edit changed the subject. The alpha will be unreliable.`, true);
    if (r.blown > 0.01) line(`${(r.blown * 100).toFixed(1)}% of pixels are pure white in both renders; those cannot be separated from the background.`, true);
  }
  function redraw() {
    if (view === 'white' || view === 'black') { const s = slots[view]; drawInSquare(ctx, S, s && cleanedNow() && s.cleanCanvas ? s.cleanCanvas : s?.canvas, 'fit', fitRect); return; }
    const f = drawInSquare(ctx, S, resultCanvas, params.resize, fitRect);
    if (f && params.clearMiddle && maskAlpha) { // preview the cut: the mask covers the whole output square (or the image itself when it is not resized)
      const r = params.resize === 'none' ? f : { x: 0, y: 0, w: S, h: S };
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(maskAlpha, r.x, r.y, r.w, r.h);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // ---------------------------------------------------------------- files
  const loadReq = { white: 0, black: 0 };
  function forgetAll() {
    slots.white = slots.black = null; maskReady = null; result = null; resultCanvas = null;
    for (const id of ['#svWhiteName', '#svBlackName']) { const l = $(id); l.textContent = 'none'; l.title = ''; l.classList.add('muted'); }
    refreshButtons(); redraw();
  }
  async function loadSlot(slot, p) {
    const req = ++loadReq[slot]; // the most recently asked-for render per slot wins, whichever finishes last
    try {
      setMsg('Loading…');
      const bytes = await api.readFile(p);
      if (req !== loadReq[slot]) return;
      const buf = bytes.slice().buffer;
      const r = await ask({ type: 'load', slot, bytes: buf }, [buf]);
      if (req !== loadReq[slot]) return;
      slots[slot] = { path: p, name: baseOf(p), w: r.w, h: r.h, rgba: r.rgba, canvas: toCanvas(r.rgba, r.w, r.h), cleanKey: null, cleanCanvas: null };
      const label = $(slot === 'white' ? '#svWhiteName' : '#svBlackName');
      label.textContent = p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
      label.title = p;
      label.classList.remove('muted');
      refreshButtons();
      await ensureMask();
      redraw();
      if (slots.white && slots.black) await run();
      else setMsg(`Now open the ${slot === 'white' ? 'black' : 'white'} render.`);
    } catch (err) {
      if (req === loadReq[slot]) { // an earlier load may already have changed the worker's render for this slot: show none rather than the wrong one
        slots[slot] = null; result = null; resultCanvas = null;
        const l = $(slot === 'white' ? '#svWhiteName' : '#svBlackName'); l.textContent = 'none'; l.title = ''; l.classList.add('muted');
        refreshButtons(); redraw();
        setMsg(`Could not open that image: ${err.message}`, true);
      }
    }
  }
  async function pickSlot(slot) {
    const picked = await api.pickImages({ multi: false });
    if (picked?.length) await loadSlot(slot, picked[0]);
  }

  async function saveTo(outPath) {
    if (!slots.white || !slots.black) throw new Error('Open both renders first');
    await ensureMask();
    try { await ensureCleanBoth(); } catch { /* the export then uses the raw renders, as the preview does */ }
    const r = await ask({ type: 'export', params: { ...params, preClean: cleanedNow() } });
    await api.writeFile(outPath, r.png);
    return { path: outPath, w: r.w, h: r.h, bytes: r.png.length };
  }
  function defaultName() {
    const white = slots.white;
    const base = (white?.name || '').replace(/[\s_-]*white[\s_-]*/gi, ' ').trim() || 'Token';
    const name = mode === 'image' || /frame/i.test(base) ? `${base} (solved).png` : `${base} Frame (solved).png`; // a frame's name keeps "frame" so folder mode never treats it as art
    return white ? `${dirOf(white.path)}${sepOf(white.path)}${name}` : name;
  }
  /** What "Save and use…" does with the saved file: frame mode loads it as the frame, image mode opens it as the art image. */
  const useSaved = (out) => (mode === 'image' ? openImages([out]) : loadFrame(out));
  async function saveClicked(andLoad) {
    if (!slots.white || !slots.black) return;
    let out = await api.pickSave(defaultName(), 'png');
    if (!out) return;
    if (!/\.png$/i.test(out)) out += '.png';
    saving = true; refreshButtons();
    try {
      setMsg('Saving…');
      const r = await saveTo(out);
      if (andLoad) { await useSaved(out); close(); }
      else setMsg(`Saved ${r.path} (${r.w}×${r.h})`);
    } catch (err) {
      setMsg(`Could not save: ${err.message}`, true);
    } finally {
      saving = false; refreshButtons();
    }
  }

  // ---------------------------------------------------------------- open / close / wiring
  const isOpen = () => !root.hidden;
  /** mode 'frame' (trim, resize, clear the middle) or 'image' (keep everything). Switching mode swaps in that mode's settings and re-solves the loaded pair. */
  async function open(nextMode = mode) {
    root.hidden = false;
    const switched = nextMode !== mode;
    mode = nextMode; params = paramSets[mode];
    $('#svTitle').textContent = mode === 'image' ? 'Solve image background' : 'Solve frame background';
    $('#svSaveLoad').textContent = mode === 'image' ? 'Save and open as image' : 'Save and use as frame';
    $('#svSaveLoad').title = mode === 'image' ? 'Save the image as a PNG, then open it in Token Framer as the art image' : 'Save the frame as a PNG, then use it as the frame in Token Framer';
    try { models = (await api.listModels()).filter((m) => m.scale === 1).map((m) => m.name); } catch { models = []; } // only same-size cleanup models make sense for the renders
    if (!models.includes(params.preCleanModel)) params.preCleanModel = preferredModel();
    const key = `${mode}|${models.join('|')}`;
    if (!ui || key !== builtFor) { // first open, the models folder changed, or the mode changed
      $('#svControls').textContent = '';
      ui = buildControls($('#svControls'), specFor(models, mode), params, changed);
      builtFor = key;
    }
    ui.sync();
    refreshButtons();
    ensureMask().catch((err) => setMsg(`Could not load the middle mask: ${err.message}`, true));
    redraw();
    if (switched && slots.white && slots.black) schedule(); // the same pair, solved the other way
  }
  function close() { root.hidden = true; }

  $('#svOpenWhite').onclick = () => pickSlot('white');
  $('#svOpenBlack').onclick = () => pickSlot('black');
  $('#svClose').onclick = close;
  $('#svSave').onclick = () => saveClicked(false);
  $('#svSaveLoad').onclick = () => saveClicked(true);
  $('#svReset').onclick = () => { Object.assign(params, SOLVE_DEFAULTS, mode === 'image' ? IMAGE_OVERRIDES : {}); params.preCleanModel = preferredModel(); ui?.sync(); refreshButtons(); updateInfo(); redraw(); schedule(); };
  $('#svProcess').onclick = processClicked;
  $('#svView').onchange = (e) => { view = e.target.value; redraw(); };
  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', async (e) => { // not stopped: the window-level handler must still clear the drag highlight
    e.preventDefault();
    const files = [...e.dataTransfer.files].slice(0, 2);
    const free = ['white', 'black'];
    for (const f of files) {
      const p = api.pathForFile(f);
      if (!p) continue;
      let slot = /white/i.test(f.name) ? 'white' : /black/i.test(f.name) ? 'black' : free.find((s) => !slots[s]) || free[0];
      if (files.length === 1 && !/white|black/i.test(f.name)) slot = e.clientX < window.innerWidth / 2 - 190 ? 'white' : 'black'; // a single unnamed file: left half = white, right half = black
      if (free.includes(slot)) free.splice(free.indexOf(slot), 1);
      await loadSlot(slot, p);
    }
  });
  api.onModelProgress(({ done, total, id }) => { const slot = jobs.get(id); if (slot && total > 1) setMsg(`Processing the ${slot} render… tile ${done} of ${total}`); });
  refreshButtons();

  return {
    open, close, isOpen, loadSlot, saveTo,
    /** For tests: what a worker crash does. */
    crashWorker: () => rpc.crash(),
    get slotSizes() { return { white: slots.white && [slots.white.w, slots.white.h], black: slots.black && [slots.black.w, slots.black.h] }; },
    get params() { return params; },
    setParams(p) { Object.assign(params, p); ui?.sync(); refreshButtons(); updateInfo(); redraw(); return run(); },
    /** For tests: what the Process button does (resolves when the pre-clean and the re-solve are done). */
    process: processClicked,
    get buttons() { return { process: !$('#svProcess').disabled, save: !$('#svSave').disabled }; },
    get result() { return result; },
    get mode() { return mode; },
    get cleanState() { return { white: slots.white?.cleanKey || null, black: slots.black?.cleanKey || null, used: result?.usedClean ?? null, models: [...models] }; },
    async saveAndLoad(outPath) { const r = await saveTo(outPath); await useSaved(outPath); close(); return r; }
  };
}
