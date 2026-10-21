// "Solve frame background" tool: a transparent frame from the same render on a white and on a black background (triangulation matting).
// Maths in lib/solveframe.js, run by lib/solveframe.worker.js. Same screen layout as Clean frame (see cleaner.js).
import { fitRect } from './lib/cleanframe.js';
import { SOLVE_DEFAULTS } from './lib/solveframe.js';
import { buildControls, drawInSquare, makeRpc } from './ui-kit.js';

const $ = (s, r = document) => r.querySelector(s);

const SPEC = [
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

export function initSolver({ api, loadFrame, dirOf, sepOf, baseOf }) {
  const root = $('#solver');
  const canvas = $('#svPreview');
  const ctx = canvas.getContext('2d');
  const S = canvas.width;
  const params = { ...SOLVE_DEFAULTS };
  const rpc = makeRpc('lib/solveframe.worker.js', (m) => setMsg(`The solver worker stopped: ${m}`, true));
  const ask = rpc.ask;
  const slots = { white: null, black: null }; // { path, name, w, h, canvas }
  let result = null, resultCanvas = null, maskAlpha = null, maskReady = null;
  let busy = false, dirty = false, timer = 0, ui = null, view = 'result';

  const setMsg = (text, warn = false) => { const m = $('#svMsg'); m.textContent = text; m.style.color = warn ? 'var(--warn)' : ''; };
  const toCanvas = (rgba, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0); return c; };

  function changed(k) {
    ui.sync();
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
        const r = await ask({ type: 'preview', params: { ...params } });
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
    setMsg(`Trimmed to ${result.w}×${result.h} (from ${slots.white.w}×${slots.white.h}), output ${out}${ms != null ? `, ${ms} ms` : ''}`);
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
    if (view === 'white' || view === 'black') { drawInSquare(ctx, S, slots[view]?.canvas, 'fit', fitRect); return; }
    const f = drawInSquare(ctx, S, resultCanvas, params.resize, fitRect);
    if (f && params.clearMiddle && maskAlpha) { // preview the cut: the mask covers the whole output square (or the image itself when it is not resized)
      const r = params.resize === 'none' ? f : { x: 0, y: 0, w: S, h: S };
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(maskAlpha, r.x, r.y, r.w, r.h);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // ---------------------------------------------------------------- files
  async function loadSlot(slot, p) {
    try {
      setMsg('Loading…');
      const bytes = await api.readFile(p);
      const buf = bytes.slice().buffer;
      const r = await ask({ type: 'load', slot, bytes: buf }, [buf]);
      slots[slot] = { path: p, name: baseOf(p), w: r.w, h: r.h, canvas: toCanvas(r.rgba, r.w, r.h) };
      const label = $(slot === 'white' ? '#svWhiteName' : '#svBlackName');
      label.textContent = p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
      label.title = p;
      label.classList.remove('muted');
      enableSave(!!(slots.white && slots.black));
      await ensureMask();
      redraw();
      if (slots.white && slots.black) await run();
      else setMsg(`Now open the ${slot === 'white' ? 'black' : 'white'} render.`);
    } catch (err) {
      setMsg(`Could not open that image: ${err.message}`, true);
    }
  }
  async function pickSlot(slot) {
    const picked = await api.pickImages({ multi: false });
    if (picked?.length) await loadSlot(slot, picked[0]);
  }
  function enableSave(on) { $('#svSave').disabled = $('#svSaveLoad').disabled = !on; }

  async function saveTo(outPath) {
    if (!slots.white || !slots.black) throw new Error('Open both renders first');
    await ensureMask();
    const r = await ask({ type: 'export', params: { ...params } });
    await api.writeFile(outPath, r.png);
    return { path: outPath, w: r.w, h: r.h, bytes: r.png.length };
  }
  function defaultName() {
    const white = slots.white;
    const base = (white?.name || '').replace(/[\s_-]*white[\s_-]*/gi, ' ').trim() || 'Token';
    const name = /frame/i.test(base) ? `${base} (solved).png` : `${base} Frame (solved).png`; // "frame" in the name keeps folder mode from treating it as art
    return white ? `${dirOf(white.path)}${sepOf(white.path)}${name}` : name;
  }
  async function saveClicked(andLoad) {
    if (!slots.white || !slots.black) return;
    let out = await api.pickSave(defaultName(), 'png');
    if (!out) return;
    if (!/\.png$/i.test(out)) out += '.png';
    enableSave(false);
    try {
      setMsg('Saving…');
      const r = await saveTo(out);
      if (andLoad) { await loadFrame(out); close(); }
      else setMsg(`Saved ${r.path} (${r.w}×${r.h})`);
    } catch (err) {
      setMsg(`Could not save: ${err.message}`, true);
    } finally {
      enableSave(true);
    }
  }

  // ---------------------------------------------------------------- open / close / wiring
  const isOpen = () => !root.hidden;
  function open() {
    root.hidden = false;
    if (!ui) ui = buildControls($('#svControls'), SPEC, params, changed);
    ensureMask().catch((err) => setMsg(`Could not load the middle mask: ${err.message}`, true));
    redraw();
  }
  function close() { root.hidden = true; }

  $('#svOpenWhite').onclick = () => pickSlot('white');
  $('#svOpenBlack').onclick = () => pickSlot('black');
  $('#svClose').onclick = close;
  $('#svSave').onclick = () => saveClicked(false);
  $('#svSaveLoad').onclick = () => saveClicked(true);
  $('#svReset').onclick = () => { Object.assign(params, SOLVE_DEFAULTS); ui?.sync(); updateInfo(); redraw(); schedule(); };
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
  enableSave(false);

  return {
    open, close, isOpen, loadSlot, saveTo,
    params,
    setParams(p) { Object.assign(params, p); ui?.sync(); updateInfo(); redraw(); return run(); },
    get result() { return result; },
    async saveAndLoad(outPath) { const r = await saveTo(outPath); await loadFrame(outPath); close(); return r; }
  };
}
