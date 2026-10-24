// Small stateless helpers shared by the full-window tool screens (Clean frame, Solve frame background).

/** A model run whose output has more pixels than this asks first (about 5000 x 5000): it can take long, use a lot of memory and slow the whole computer down. */
export const HEAVY_PIXELS = 25e6;
/** Asks before a heavy model run. `w` x `h` is the size the model itself will output. Returns true to go ahead. */
export function confirmHeavy(w, h, what = 'This') {
  if (w * h <= HEAVY_PIXELS) return true;
  return confirm(`${what} will work on a ${w}×${h} image (${(w * h / 1e6).toFixed(0)} megapixels).

That is very demanding: it can take a long time, use a lot of memory and make your computer sluggish while it runs.

Continue?`);
}

export const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/**
 * Request/response wrapper around a module worker. `ask(msg, transfer, onProgress)` resolves with the worker's reply (matched by id) or rejects with its error.
 * If the worker itself dies, every pending request is rejected and the next `ask` starts a fresh worker, so a crash never leaves a tool stuck.
 * `cancel()` does the same on purpose, quietly (a worker holding state, such as a loaded image, has to be given it again afterwards).
 */
export function makeRpc(url, onFatal = () => {}) {
  let worker = null, nextId = 0;
  const waiting = new Map();
  const stop = (message, cancelled) => {
    for (const w of waiting.values()) { const e = new Error(message); e.cancelled = cancelled; w.reject(e); }
    waiting.clear();
    try { worker?.terminate(); } catch { /* already gone */ }
    worker = null;
  };
  const fail = (message) => { stop(message, false); onFatal(message); };
  const ensure = () => {
    if (worker) return worker;
    worker = new Worker(url, { type: 'module' });
    worker.onmessage = ({ data }) => {
      const w = waiting.get(data.id);
      if (!w) return;
      if (data.type === 'progress') { w.onProgress?.(data); return; }
      waiting.delete(data.id);
      data.type === 'error' ? w.reject(new Error(data.message)) : w.resolve(data);
    };
    worker.onerror = (e) => fail(e.message || 'the worker stopped');
    return worker;
  };
  return {
    /** `onProgress(data)` (optional) receives the worker's {type:'progress'} messages for this request. */
    ask: (msg, transfer = [], onProgress) => new Promise((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, { resolve, reject, onProgress });
      ensure().postMessage({ ...msg, id }, transfer);
    }),
    /** Stops the worker (its work is lost, along with anything it was holding) and rejects every pending request with an error whose `cancelled` is true. onFatal is NOT called. */
    cancel: () => stop('Cancelled', true),
    /** For tests: what a worker crash does (onFatal is called). */
    crash: () => fail('the worker was stopped')
  };
}

/**
 * Builds label + control rows from a spec into `host`. `params` is mutated in place; `onChange(key)` fires after every edit.
 * Spec entries: {t:'subhead', label}, {t:'select', k, label, opts:[[value, text]]}, {t:'check', k, label}, or a number {k, label, min, max, step}
 * (range + number box), {t:'tint', k, k2, label} (tick box `k` + colour `k2`, as a #rrggbb string), or {t:'custom', full?, build(ctl)} where `build` fills the
 * control cell and returns a function that refreshes it (full = no label, the cell spans the row). `show(params)` hides a row, `tip` is its tooltip.
 * Returns {sync()} to refresh every control from `params`.
 */
export function buildControls(host, spec, params, onChange) {
  const rows = [];
  for (const c of spec) {
    if (c.t === 'subhead') { c.row = el('div', 'row subhead', c.label); c.sync = () => {}; host.append(c.row); rows.push(c); continue; } // `show` works on headings too
    const row = el('div', c.full ? 'row full' : 'row');
    if (c.tip) row.title = c.tip;
    const ctl = el('div', 'ctl');
    if (c.t === 'custom') {
      c.sync = c.build(ctl) || (() => {});
    } else if (c.t === 'tint') {
      const b = el('input'); b.type = 'checkbox';
      const col = el('input'); col.type = 'color'; // the native picker has its own eyedropper
      const hex = el('input'); hex.type = 'text'; hex.maxLength = 7; hex.size = 7; hex.spellcheck = false; hex.placeholder = '#rrggbb';
      b.addEventListener('change', () => { params[c.k] = b.checked; onChange(c.k); });
      col.addEventListener('input', () => { params[c.k2] = col.value; onChange(c.k2); });
      hex.addEventListener('input', () => {
        let v = hex.value.trim();
        if (/^[0-9a-f]{6}$/i.test(v)) v = '#' + v;
        if (/^#[0-9a-f]{6}$/i.test(v)) { params[c.k2] = v.toLowerCase(); onChange(c.k2); }
      });
      hex.addEventListener('blur', () => { hex.value = col.value; });
      ctl.append(b, col, hex);
      c.sync = () => { b.checked = !!params[c.k]; col.value = params[c.k2]; if (document.activeElement !== hex) hex.value = params[c.k2]; };
    } else if (c.t === 'select') {
      const s = el('select');
      for (const [v, t] of c.opts) { const o = el('option', null, t); o.value = v; s.append(o); }
      s.addEventListener('change', () => { params[c.k] = s.value; onChange(c.k); });
      ctl.append(s);
      c.sync = () => { s.value = params[c.k]; };
    } else if (c.t === 'check') {
      const b = el('input'); b.type = 'checkbox';
      b.addEventListener('change', () => { params[c.k] = b.checked; onChange(c.k); });
      ctl.append(b);
      c.sync = () => { b.checked = !!params[c.k]; };
    } else {
      const r = el('input'); r.type = 'range'; r.min = c.min; r.max = c.max; r.step = c.step;
      const n = el('input'); n.type = 'number'; n.min = c.nmin ?? c.min; n.max = c.max; n.step = c.step;
      r.addEventListener('input', () => { n.value = r.value; params[c.k] = +r.value; onChange(c.k); });
      n.addEventListener('input', () => { if (n.value !== '' && !isNaN(+n.value)) { r.value = n.value; params[c.k] = +n.value; onChange(c.k); } });
      if (c.numberOnly) r.hidden = true; // a big pixel count is easier to type than to drag
      ctl.append(r, n);
      c.sync = () => { r.value = n.value = params[c.k]; };
    }
    row.append(el('label', null, c.label), ctl);
    c.row = row;
    host.append(row);
    rows.push(c);
  }
  const sync = () => { for (const c of rows) { c.sync(); c.row.style.display = c.show && !c.show(params) ? 'none' : ''; } };
  sync();
  return { sync };
}

/** Draws `img` (canvas/bitmap) into the square preview context: 'stretch' fills it, anything else keeps the aspect ratio and centres it. */
export function drawInSquare(ctx, S, img, mode, fitRect) {
  ctx.clearRect(0, 0, S, S);
  if (!img) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (mode === 'stretch') { ctx.drawImage(img, 0, 0, S, S); return { x: 0, y: 0, w: S, h: S }; }
  const f = fitRect(img.width, img.height, S);
  ctx.drawImage(img, f.x, f.y, f.w, f.h);
  return f;
}
