// "Clean frame" tool: a full-window overlay with the image preview on the left and the cleanup controls on the right.
// The maths lives in lib/cleanframe.js and runs in lib/cleanframe.worker.js so the sliders stay responsive.
import { DEFAULTS, fitRect } from './lib/cleanframe.js';

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const SPEC = [
  { k: 'radius', label: 'Refine radius', min: 0, max: 10, step: 1, tip: 'Radius in pixels of the original image for the alpha refinement. Bigger smooths more noise but softens fine detail. 0 skips the refinement.' },
  { k: 'smoothing', label: 'Smoothing', min: 0.0001, max: 0.1, step: 0.0001, tip: 'How strongly the refinement follows the image colours (the filter\'s regulariser). Very small values can look noisy.' },
  { k: 'floor', label: 'Alpha floor', min: 0, max: 1, step: 0.01, tip: 'After refining, alpha below this becomes fully transparent. 0 turns it off.' },
  { k: 'solidify', label: 'Solidify', min: 0, max: 4, step: 1, tip: 'Firms up semi-transparent pixels, like stacking the image on itself. Each step roughly doubles the effect.' },
  { k: 'ceiling', label: 'Alpha ceiling', min: 0, max: 1, step: 0.01, tip: 'After solidifying, alpha above this becomes fully opaque. 1 turns it off.' },
  { t: 'subhead', label: 'Trim' },
  { k: 'threshold', label: 'Crop threshold', min: 0, max: 1, step: 0.001, tip: 'Pixels with alpha above this count as part of the frame when trimming the empty border.' },
  { k: 'padding', label: 'Padding (px)', min: 0, max: 500, step: 1, tip: 'Extra pixels kept around the trimmed frame (never beyond the original image).' },
  { t: 'subhead', label: 'Output size' },
  { k: 'resize', label: 'Resize', t: 'select', opts: [['fit', 'Fit, pad to a square'], ['stretch', 'Stretch to a square'], ['none', 'Keep trimmed size']], tip: 'Fit keeps the aspect ratio and centres the frame on a transparent square. Stretch squeezes it to fill (what the ComfyUI workflow does).' },
  { k: 'size', label: 'Size (px)', min: 128, max: 8192, step: 1, show: (p) => p.resize !== 'none' }
];

export function initCleaner({ api, loadFrame, dirOf, sepOf, baseOf }) {
  const root = $('#cleaner');
  const canvas = $('#cfPreview');
  const ctx = canvas.getContext('2d');
  const S = canvas.width; // internal preview resolution (square)
  let worker = null, nextId = 0;
  const waiting = new Map();
  let params = { ...DEFAULTS };
  let src = null;          // { path, name, w, h, hasAlpha }
  let origCanvas = null, resultCanvas = null, result = null;
  let busy = false, dirty = false, timer = 0, showOriginal = false;
  const rows = [];

  const setMsg = (text, warn = false) => { const m = $('#cfMsg'); m.textContent = text; m.style.color = warn ? 'var(--warn)' : ''; };

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker('lib/cleanframe.worker.js', { type: 'module' });
    worker.onmessage = ({ data }) => { const w = waiting.get(data.id); if (w) { waiting.delete(data.id); data.type === 'error' ? w.reject(new Error(data.message)) : w.resolve(data); } };
    worker.onerror = (e) => setMsg(`The cleanup worker failed: ${e.message || 'could not start'}`, true);
    return worker;
  }
  const ask = (msg, transfer = []) => new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    ensureWorker().postMessage({ ...msg, id }, transfer);
  });

  // ---------------------------------------------------------------- controls
  function buildControls() {
    const host = $('#cfControls');
    for (const c of SPEC) {
      if (c.t === 'subhead') { host.append(el('div', 'row subhead', c.label)); continue; }
      const row = el('div', 'row');
      const lab = el('label', null, c.label);
      if (c.tip) row.title = c.tip;
      const ctl = el('div', 'ctl');
      if (c.t === 'select') {
        const s = el('select');
        for (const [v, t] of c.opts) { const o = el('option', null, t); o.value = v; s.append(o); }
        s.addEventListener('change', () => { params[c.k] = s.value; changed(c.k); });
        ctl.append(s);
        c.sync = () => { s.value = params[c.k]; };
      } else {
        const r = el('input'); r.type = 'range'; r.min = c.min; r.max = c.max; r.step = c.step;
        const n = el('input'); n.type = 'number'; n.min = c.k === 'smoothing' ? 0.000001 : c.min; n.max = c.max; n.step = c.step;
        r.addEventListener('input', () => { n.value = r.value; params[c.k] = +r.value; changed(c.k); });
        n.addEventListener('input', () => { if (n.value !== '' && !isNaN(+n.value)) { r.value = n.value; params[c.k] = +n.value; changed(c.k); } });
        if (c.k === 'size') r.hidden = true; // a big pixel count is easier to type than to drag
        ctl.append(r, n);
        c.sync = () => { r.value = n.value = params[c.k]; };
      }
      row.append(lab, ctl);
      c.row = row;
      host.append(row);
      rows.push(c);
    }
    syncControls();
  }
  function syncControls() {
    for (const c of rows) { c.sync(); c.row.style.display = c.show && !c.show(params) ? 'none' : ''; }
  }
  function changed(k) {
    syncControls();
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
    ctx.clearRect(0, 0, S, S);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const img = showOriginal ? origCanvas : resultCanvas;
    if (!img) return;
    if (!showOriginal && params.resize === 'stretch') { ctx.drawImage(img, 0, 0, S, S); return; }
    const f = fitRect(img.width, img.height, S); // 'fit' (and 'none' / the original) keep the aspect ratio
    ctx.drawImage(img, f.x, f.y, f.w, f.h);
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
    document.body.classList.add('cleaning');
    if (!rows.length) buildControls();
    redraw();
  }
  function close() {
    root.hidden = true;
    document.body.classList.remove('cleaning');
  }

  $('#cfOpen').onclick = pickImage;
  $('#cfClose').onclick = close;
  $('#cfSave').onclick = () => saveClicked(false);
  $('#cfSaveLoad').onclick = () => saveClicked(true);
  $('#cfReset').onclick = () => { params = { ...DEFAULTS }; syncControls(); updateInfo(); redraw(); schedule(); };
  $('#cfOriginal').onchange = (e) => { showOriginal = e.target.checked; redraw(); };
  root.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
  root.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation();
    const f = e.dataTransfer.files[0];
    const p = f && api.pathForFile(f);
    if (p) await loadPath(p);
  });
  enableSave(false);

  return {
    open, close, isOpen, loadPath, saveTo, pickImage,
    get params() { return params; },
    setParams(p) { params = { ...params, ...p }; syncControls(); updateInfo(); redraw(); return run(); },
    get result() { return result; },
    /** For tests: save to a known path, then do what "Save and load" does. */
    async saveAndLoad(outPath) { const r = await saveTo(outPath); await loadFrame(outPath); close(); return r; }
  };
}
