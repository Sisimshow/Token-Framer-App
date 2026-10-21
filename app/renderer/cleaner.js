// "Clean frame" tool: a full-window overlay with the image preview on the left and the cleanup controls on the right.
// The maths lives in lib/cleanframe.js and runs in lib/cleanframe.worker.js so the sliders stay responsive.
import { DEFAULTS, fitRect } from './lib/cleanframe.js';
import { buildControls, drawInSquare, makeRpc } from './ui-kit.js';

const $ = (s, r = document) => r.querySelector(s);

const SPEC = [
  { k: 'radius', label: 'Refine radius', min: 0, max: 10, step: 1, tip: 'Radius in pixels of the original image for the alpha refinement. Bigger smooths more noise but softens fine detail. 0 skips the refinement.' },
  { k: 'smoothing', label: 'Smoothing', min: 0.0001, nmin: 0.000001, max: 0.1, step: 0.0001, tip: 'How strongly the refinement follows the image colours (the filter\'s regulariser). Very small values can look noisy.' },
  { k: 'floor', label: 'Alpha floor', min: 0, max: 1, step: 0.01, tip: 'After refining, alpha below this becomes fully transparent. 0 turns it off.' },
  { k: 'solidify', label: 'Solidify', min: 0, max: 4, step: 1, tip: 'Firms up semi-transparent pixels, like stacking the image on itself. Each step roughly doubles the effect.' },
  { k: 'ceiling', label: 'Alpha ceiling', min: 0, max: 1, step: 0.01, tip: 'After solidifying, alpha above this becomes fully opaque. 1 turns it off.' },
  { t: 'subhead', label: 'Trim' },
  { k: 'threshold', label: 'Crop threshold', min: 0, max: 1, step: 0.001, tip: 'Pixels with alpha above this count as part of the frame when trimming the empty border.' },
  { k: 'padding', label: 'Padding (px)', min: 0, max: 500, step: 1, tip: 'Extra pixels kept around the trimmed frame (never beyond the original image).' },
  { t: 'subhead', label: 'Output size' },
  { k: 'resize', label: 'Resize', t: 'select', opts: [['fit', 'Fit, pad to a square'], ['stretch', 'Stretch to a square'], ['none', 'Keep trimmed size']], tip: 'Fit keeps the aspect ratio and centres the frame on a transparent square. Stretch squeezes it to fill (what the ComfyUI workflow does).' },
  { k: 'size', label: 'Size (px)', min: 128, max: 8192, step: 1, numberOnly: true, show: (p) => p.resize !== 'none' }
];

export function initCleaner({ api, loadFrame, dirOf, sepOf, baseOf }) {
  const root = $('#cleaner');
  const canvas = $('#cfPreview');
  const ctx = canvas.getContext('2d');
  const S = canvas.width; // internal preview resolution (square)
  const params = { ...DEFAULTS };
  const rpc = makeRpc('lib/cleanframe.worker.js', (m) => setMsg(`The cleanup worker stopped: ${m}`, true));
  const ask = rpc.ask;
  let src = null;          // { path, name, w, h, hasAlpha }
  let origCanvas = null, resultCanvas = null, result = null;
  let busy = false, dirty = false, timer = 0, showOriginal = false, ui = null;

  const setMsg = (text, warn = false) => { const m = $('#cfMsg'); m.textContent = text; m.style.color = warn ? 'var(--warn)' : ''; };

  function changed(k) {
    ui.sync();
    if (k === 'resize' || k === 'size') { updateInfo(); redraw(); return; } // only the export is affected, the cleaned preview stays as it is
    schedule();
  }

  // ---------------------------------------------------------------- processing
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(run, 60);
  }
  async function run() {
    if (!src) return;
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
        redraw();
      } while (dirty);
    } catch (err) {
      setMsg(`Could not process: ${err.message}`, true);
    } finally {
      busy = false;
    }
  }
  function toCanvas(rgba, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
    return c;
  }
  function updateInfo(ms) {
    if (!result) return;
    const out = params.resize === 'none' ? `${result.w}×${result.h}` : `${params.size}×${params.size}`;
    if (!result.hasAlpha) { setMsg('This image has no transparency, so there is nothing to refine or trim. Use a PNG or WebP with a transparent background.', true); return; }
    setMsg(`Trimmed to ${result.w}×${result.h} (from ${src.w}×${src.h}), output ${out}${ms != null ? `, ${ms} ms` : ''}`);
  }
  function redraw() {
    drawInSquare(ctx, S, showOriginal ? origCanvas : resultCanvas, showOriginal ? 'fit' : params.resize, fitRect);
  }

  // ---------------------------------------------------------------- files
  async function loadPath(p) {
    try {
      setMsg('Loading…');
      const bytes = await api.readFile(p);
      const buf = bytes.slice().buffer;
      const r = await ask({ type: 'load', bytes: buf }, [buf]);
      src = { path: p, name: baseOf(p), w: r.w, h: r.h, hasAlpha: r.hasAlpha };
      origCanvas = toCanvas(r.rgba, r.w, r.h);
      result = null; resultCanvas = null;
      $('#cfName').textContent = p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
      $('#cfName').title = p;
      $('#cfName').classList.remove('muted');
      enableSave(true);
      redraw();
      await run();
    } catch (err) {
      setMsg(`Could not open that image: ${err.message}`, true);
    }
  }
  async function pickImage() {
    const picked = await api.pickImages({ multi: false });
    if (picked?.length) await loadPath(picked[0]);
  }
  function enableSave(on) { $('#cfSave').disabled = $('#cfSaveLoad').disabled = !on; }

  /** Renders the final image and writes it as a PNG to `outPath`. */
  async function saveTo(outPath) {
    if (!src) throw new Error('Open an image first');
    const r = await ask({ type: 'export', params: { ...params } });
    await api.writeFile(outPath, r.png);
    return { path: outPath, w: r.w, h: r.h, bytes: r.png.length };
  }
  function defaultName() {
    const base = src?.name || 'Frame';
    const name = /frame/i.test(base) ? `${base} (clean).png` : `${base} Frame (clean).png`; // keeps "frame" in the name so folder mode never treats it as art
    return src?.path ? `${dirOf(src.path)}${sepOf(src.path)}${name}` : name;
  }
  async function saveClicked(andLoad) {
    if (!src) return;
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

  // ---------------------------------------------------------------- open / close
  const isOpen = () => !root.hidden;
  function open() {
    root.hidden = false;
    if (!ui) ui = buildControls($('#cfControls'), SPEC, params, changed);
    redraw();
  }
  function close() { root.hidden = true; }

  $('#cfOpen').onclick = pickImage;
  $('#cfClose').onclick = close;
  $('#cfSave').onclick = () => saveClicked(false);
  $('#cfSaveLoad').onclick = () => saveClicked(true);
  $('#cfReset').onclick = () => { Object.assign(params, DEFAULTS); ui?.sync(); updateInfo(); redraw(); schedule(); };
  $('#cfOriginal').onchange = (e) => { showOriginal = e.target.checked; redraw(); };
  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', async (e) => { // not stopped: the window-level handler must still clear the drag highlight (main-window handleDrop ignores it while we are open)
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    const p = f && api.pathForFile(f);
    if (p) await loadPath(p);
  });
  enableSave(false);

  return {
    open, close, isOpen, loadPath, saveTo, pickImage,
    params,
    setParams(p) { Object.assign(params, p); ui?.sync(); updateInfo(); redraw(); return run(); },
    get result() { return result; },
    /** For tests: save to a known path, then do what "Save and use as frame" does. */
    async saveAndLoad(outPath) { const r = await saveTo(outPath); await loadFrame(outPath); close(); return r; }
  };
}
