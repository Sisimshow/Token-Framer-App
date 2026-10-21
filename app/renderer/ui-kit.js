// Small stateless helpers shared by the full-window tool screens (Clean frame, Solve frame background).

export const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/**
 * Request/response wrapper around a module worker. `ask(msg, transfer)` resolves with the worker's reply (matched by id) or rejects with its error.
 * If the worker itself dies, every pending request is rejected and the next `ask` starts a fresh worker, so a crash never leaves a tool stuck.
 */
export function makeRpc(url, onFatal = () => {}) {
  let worker = null, nextId = 0;
  const waiting = new Map();
  const fail = (message) => {
    for (const w of waiting.values()) w.reject(new Error(message));
    waiting.clear();
    try { worker?.terminate(); } catch { /* already gone */ }
    worker = null;
    onFatal(message);
  };
  const ensure = () => {
    if (worker) return worker;
    worker = new Worker(url, { type: 'module' });
    worker.onmessage = ({ data }) => {
      const w = waiting.get(data.id);
      if (!w) return;
      waiting.delete(data.id);
      data.type === 'error' ? w.reject(new Error(data.message)) : w.resolve(data);
    };
    worker.onerror = (e) => fail(e.message || 'the worker stopped');
    return worker;
  };
  return {
    ask: (msg, transfer = []) => new Promise((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      ensure().postMessage({ ...msg, id }, transfer);
    })
  };
}

/**
 * Builds label + control rows from a spec into `host`. `params` is mutated in place; `onChange(key)` fires after every edit.
 * Spec entries: {t:'subhead', label}, {t:'select', k, label, opts:[[value, text]]}, {t:'check', k, label}, or a number {k, label, min, max, step}
 * (range + number box). `show(params)` hides a row, `tip` is its tooltip. Returns {sync()} to refresh every control from `params`.
 */
export function buildControls(host, spec, params, onChange) {
  const rows = [];
  for (const c of spec) {
    if (c.t === 'subhead') { host.append(el('div', 'row subhead', c.label)); continue; }
    const row = el('div', 'row');
    if (c.tip) row.title = c.tip;
    const ctl = el('div', 'ctl');
    if (c.t === 'select') {
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
