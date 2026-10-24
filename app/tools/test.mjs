// Regression harness: drives the real app over the Chrome DevTools Protocol (see .claude/CLAUDE.md).
//   node tools/test.mjs            run all checks
//   node tools/test.mjs --update   rewrite tools/fixtures/golden-*.png from the current output (review the diff first!)
// Needs Node 22+ (global WebSocket). No dependencies. Uses a scratch --user-data-dir and a scratch folder whose name
// contains spaces, "&" and a smart quote, because those are normal here.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'tools', 'fixtures');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const UPDATE = process.argv.includes('--update');
const PORT = 9333;
const SIZE = 256; // composite size for golden comparisons

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tf test & it’s '));
const userData = path.join(scratch, 'userdata');
const work = path.join(scratch, 'Art & Tokens ’work’');
fs.mkdirSync(work, { recursive: true });

// ---------------------------------------------------------------- tiny CDP client
class App {
  async launch() {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // TF_TEST_SCALE=1.25 runs the app as on a Windows display scaled to 125% (the pen view counts device pixels)
    const scaleArg = process.env.TF_TEST_SCALE ? [`--force-device-scale-factor=${process.env.TF_TEST_SCALE}`] : [];
    this.proc = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, ...scaleArg], { cwd: root, env, stdio: 'ignore' });
    let target;
    for (let i = 0; i < 100 && !target; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
    }
    if (!target) throw new Error('Electron did not start');
    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && this.pending.has(d.id)) { this.pending.get(d.id)(d); this.pending.delete(d.id); }
    };
    for (let i = 0; ; i++) { // the page may still be loading (its context is replaced once), so a destroyed context is retried
      try { await this.ev('new Promise((r) => { const t = setInterval(() => { if (window.__tf && __tf.frame) { clearInterval(t); r(); } }, 50); })'); break; }
      catch (err) { if (i >= 40 || !/context was destroyed|Cannot find context/i.test(String(err.message))) throw err; await new Promise((r) => setTimeout(r, 250)); }
    }
  }
  /** Evaluate an expression in the page (awaits promises) and return its JSON-able value. */
  async ev(expr) {
    const id = ++this.id;
    const reply = new Promise((r) => this.pending.set(id, r));
    this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    const d = await reply;
    if (d.error || d.result?.exceptionDetails) throw new Error(JSON.stringify(d.error || d.result.exceptionDetails.exception?.description || d.result.exceptionDetails));
    return d.result.result.value;
  }
  /** A raw DevTools command (used for real mouse input). */
  send(method, params = {}) {
    const id = ++this.id;
    const reply = new Promise((r) => this.pending.set(id, r));
    this.ws.send(JSON.stringify({ id, method, params }));
    return reply;
  }
  close() {
    try { this.ws.close(); } catch { /* already gone */ }
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* exited */ } }
    else this.proc.kill();
  }
}

// ---------------------------------------------------------------- reporting
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- page-side helpers
const PAGE = `(() => {
  const T = window.__tf;
  const h = {};
  // synthetic art 400x300: flat green background, a red donut with an enclosed background pocket, a small blue square
  h.makeArt = () => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 300;
    const x = c.getContext('2d');
    x.fillStyle = '#20a040'; x.fillRect(0, 0, 400, 300);
    x.fillStyle = '#d02020'; x.beginPath(); x.arc(200, 150, 100, 0, 7); x.fill();
    x.fillStyle = '#20a040'; x.beginPath(); x.arc(200, 150, 50, 0, 7); x.fill();
    x.fillStyle = '#2030e0'; x.fillRect(330, 40, 20, 20);
    return c.toDataURL('image/png');
  };
  h.alphaAt = (cut, px, py) => cut.ctx.getImageData(px, py, 1, 1).data[3];
  h.cut = (override) => T.buildCut(T.base.bitmap, { ...T.eff(), ...override });
  h.alphaCount = (cut, x0, y0, x1, y1) => { // number of transparent pixels in a box
    const d = cut.ctx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1).data; let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] === 0) n++;
    return n;
  };
  h.render = (override) => {
    const it = T.items[T.cur]; const saved = it.override; it.override = override;
    const cfg = T.eff();
    const canvas = T.compositeFor(cfg, T.buildSources(cfg, T.base.bitmap), ${SIZE}, {});
    it.override = saved;
    return canvas;
  };
  h.png = (canvas) => canvas.toDataURL('image/png');
  h.diff = async (canvas, goldPath) => {
    const bm = await createImageBitmap(new Blob([await window.api.readFile(goldPath)]));
    const g = document.createElement('canvas'); g.width = bm.width; g.height = bm.height;
    const gx = g.getContext('2d', { willReadFrequently: true }); gx.drawImage(bm, 0, 0);
    if (bm.width !== canvas.width) return { size: false };
    const a = gx.getImageData(0, 0, g.width, g.height).data;
    const b = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, g.width, g.height).data;
    let sum = 0, bad = 0;
    for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); sum += d; if (d > 8) bad++; }
    return { size: true, mean: sum / a.length, badFrac: bad / a.length };
  };
  return h;
})()`;

const WAIT_BASE = 'new Promise((r) => { const t = setInterval(() => { if (__tf.base) { clearInterval(t); r(); } }, 50); })';

// Override sets rendered and compared with golden PNGs.
const VARIANTS = {
  basic: {},
  circle_scaled: { maskShape: 'circle', baseScale: 0.8, fitEnabled: false, bgEnabled: true, bgColor: '#303060' },
  popout_color: { crPopOutOnly: true, popOutEnabled: true, crEnabled: true, crColor: '#20a040', popOutDegrees: 200 },
  popout_edits: {
    crPopOutOnly: true, popOutEnabled: true, popOutDegrees: 200,
    popEdits: [
      { type: 'wand', x: 5, y: 5, tol: 20, contiguous: true },
      { type: 'brush', mode: 'erase', r: 12, pts: [[200, 60], [230, 80], [260, 110]] },
      { type: 'rect', x0: 330, y0: 40, x1: 350, y1: 60 }
    ]
  }
};

// ---------------------------------------------------------------- tests
async function main() {
  const artFile = path.join(fixtures, 'art.png');
  const frameFile = path.join(root, 'assets', 'default.webp');
  const app = new App();
  await app.launch();
  await app.ev(`window.__h = ${PAGE}, 1`);
  const H = (expr) => app.ev(`(async () => { const h = window.__h; return ${expr}; })()`);

  if (!fs.existsSync(artFile)) {
    fs.mkdirSync(fixtures, { recursive: true });
    fs.writeFileSync(artFile, Buffer.from((await H('h.makeArt()')).split(',')[1], 'base64'));
    console.log('wrote tools/fixtures/art.png');
  }
  const art = path.join(work, 'Test Knight.png');
  fs.copyFileSync(artFile, art);

  await app.ev(`__tf.openImages([${J(art)}])`);
  await app.ev(WAIT_BASE);
  check('default frame has a valid hole', await app.ev('__tf.frame.hole.valid'));

  // -- composite parity against golden output
  for (const [name, ov] of Object.entries(VARIANTS)) {
    const gold = path.join(fixtures, `golden-${name}.png`);
    const canvasExpr = `h.render(${J(ov)})`;
    if (UPDATE || !fs.existsSync(gold)) {
      fs.writeFileSync(gold, Buffer.from((await H(`h.png(${canvasExpr})`)).split(',')[1], 'base64'));
      console.log(`wrote ${path.relative(root, gold)}`);
      continue;
    }
    const d = await H(`h.diff(${canvasExpr}, ${J(gold)})`);
    check(`composite parity: ${name}`, d.size && d.mean < 0.5 && d.badFrac < 0.002, d.size ? `mean ${d.mean.toFixed(3)}/255, ${(d.badFrac * 100).toFixed(3)}% differ` : 'size mismatch');
  }

  // -- the saved file matches what the preview composites
  await app.ev(`(__tf.out.size = ${SIZE}, 1)`);
  await app.ev('__tf.saveCurrent(false)');
  const outPath = path.join(work, 'Test Knight Token.webp');
  check('Save token wrote <name> Token.webp next to the source', fs.existsSync(outPath));
  const exp = await H(`(async () => { const bm = await createImageBitmap(new Blob([await window.api.readFile(${J(outPath)})]));
    const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height; c.getContext('2d').drawImage(bm, 0, 0);
    const live = h.render({}); const a = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, b = live.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return { w: bm.width, mean: s / a.length }; })()`);
  check('export matches preview compositing (webp q95)', exp.w === SIZE && exp.mean < 2, `mean ${exp.mean.toFixed(3)}/255`);

  // -- Clean frame overlay: opens from Tools, cleans the default frame in the worker, saves a PNG, and "save and use as frame" loads it
  {
    const frameWebp = path.join(root, 'assets', 'default.webp');
    const outPng = path.join(work, 'Default Frame (clean).png');
    fs.rmSync(outPng, { force: true });
    const ui = await app.ev(`(async () => {
      const q = (x) => document.querySelector(x); const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      q('#btnTools').click(); await wait(80); q('#btnCleanFrame').click(); await wait(80);
      const o = { open: !q('#cleaner').hidden, menuClosed: q('#toolsMenu').hidden, rows: document.querySelectorAll('#cfControls .row').length };
      await __tf.cleaner.loadPath(${J(frameWebp)});
      const r = __tf.cleaner.result;
      o.loaded = !!r && r.w > 0 && r.h > 0 && r.w <= 1500; o.cropped = r ? [r.w, r.h] : null;
      // global shortcuts must not reach the main window while the overlay is open
      const toolBefore = __tf.tool; window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' })); await wait(100);
      o.keysIgnored = __tf.tool === toolBefore;
      await __tf.cleaner.setParams({ radius: 2, solidify: 1, size: 256 });
      o.params = __tf.cleaner.params.size;
      return o;
    })()`);
    check('Clean frame: opens from Tools, builds its controls, cleans an image in the worker', ui.open && ui.menuClosed && ui.rows >= 10 && ui.loaded && ui.keysIgnored && ui.params === 256, J(ui));
    const drop = await app.ev(`(async () => {
      __tf.cleaner.open();
      const before = __tf.items.length;
      window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true }));
      const during = document.body.classList.contains('dragging');
      document.querySelector('#cleaner').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
      await new Promise((r) => setTimeout(r, 100));
      return { during, after: document.body.classList.contains('dragging'), items: __tf.items.length === before };
    })()`);
    check('Clean frame: a drop on the overlay clears the drag highlight and leaves the batch alone', drop.during && !drop.after && drop.items, J(drop));
    const frameBefore = await app.ev('__tf.frame.path');
    const saved = await app.ev(`__tf.cleaner.saveAndLoad(${J(outPng)})`);
    const magic = fs.existsSync(outPng) ? fs.readFileSync(outPng).subarray(0, 4).toString('hex') : '';
    const after = await app.ev(`({ frame: __tf.frame.path, closed: document.querySelector('#cleaner').hidden, name: __tf.frame.name })`);
    check('Clean frame: Save and use as frame writes a PNG at the chosen size and loads it as the frame', magic === '89504e47' && saved.w === 256 && saved.h === 256 && after.frame === outPng && after.frame !== frameBefore && after.closed, J({ magic, saved, after }));
    await app.ev(`__tf.loadFrame(${J(frameWebp)}, { keepOrder: true })`);
  }

  // -- Solve frame background screen: opens from Tools, solves a generated white/black pair in the worker, saves a PNG and uses it as the frame
  {
    const whiteP = path.join(work, 'Ring white.png'), blackP = path.join(work, 'Ring black.png'), outP = path.join(work, 'Ring Frame (solved).png');
    fs.rmSync(outP, { force: true });
    const ui = await app.ev(`(async () => {
      const q = (x) => document.querySelector(x); const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const N = 400, F = [200, 90, 40];
      const mk = (bg) => { const c = document.createElement('canvas'); c.width = c.height = N; const x = c.getContext('2d'); const d = x.createImageData(N, N);
        for (let y = 0; y < N; y++) for (let xx = 0; xx < N; xx++) { const r = Math.hypot(xx - 199.5, y - 199.5); const a = r > 120 && r < 176 ? 1 : r > 104 && r <= 120 ? (r - 104) / 16 : r >= 176 && r < 184 ? (184 - r) / 8 : 0; const i = (y * N + xx) * 4;
          for (let k = 0; k < 3; k++) d.data[i + k] = Math.round(F[k] * a + bg * (1 - a)); d.data[i + 3] = 255; }
        x.putImageData(d, 0, 0); return c; };
      const save = async (c, p) => window.api.writeFile(p, new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer()));
      await save(mk(255), ${J(whiteP)}); await save(mk(0), ${J(blackP)});
      q('#btnTools').click(); await wait(80); q('#btnSolveFrame').click(); await wait(80);
      const o = { open: !q('#solver').hidden, menuClosed: q('#toolsMenu').hidden, rows: document.querySelectorAll('#svControls .row').length, saveOff: q('#svSave').disabled };
      await __tf.solver.loadSlot('white', ${J(whiteP)}); await __tf.solver.loadSlot('black', ${J(blackP)});
      const r = __tf.solver.result;
      o.solved = !!r && r.w < N && r.w > 300; o.cropped = r ? [r.w, r.h] : null; o.report = r?.report ? { w: +r.report.whiteBg.toFixed(2), b: +r.report.blackBg.toFixed(2) } : null;
      const toolBefore = __tf.tool; window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' })); await wait(80); o.keysIgnored = __tf.tool === toolBefore;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(80); o.escCloses = q('#solver').hidden; __tf.solver.open();
      await __tf.solver.setParams({ resize: 'stretch', size: 256 });
      await __tf.solver.process();                                  // with a cleanup model installed, saving waits for Process
      o.saveOn = !q('#svSave').disabled;
      return o;
    })()`);
    check('Solve frame: opens from Tools, solves a white/black pair in the worker, Esc closes it, shortcuts are ignored while open', ui.open && ui.menuClosed && ui.rows >= 12 && ui.saveOff && ui.solved && ui.report?.w === 1 && ui.report?.b === 0 && ui.keysIgnored && ui.escCloses && ui.saveOn, J(ui));
    const saved = await app.ev(`__tf.solver.saveAndLoad(${J(outP)})`);
    const magic = fs.existsSync(outP) ? fs.readFileSync(outP).subarray(0, 4).toString('hex') : '';
    const px = await app.ev(`(async () => { const bm = await createImageBitmap(new Blob([await window.api.readFile(${J(outP)})])); const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height; const x = c.getContext('2d'); x.drawImage(bm, 0, 0);
      const a = (px, py) => x.getImageData(px, py, 1, 1).data[3]; return { w: bm.width, centre: a(128, 128), ring: a(128 + 100, 128), corner: a(2, 2), frame: __tf.frame.path, closed: document.querySelector('#solver').hidden }; })()`);
    check('Solve frame: Save and use as frame writes a PNG with the middle cleared, ring kept and corners transparent, and loads it as the frame', magic === '89504e47' && saved.w === 256 && px.w === 256 && px.centre === 0 && px.ring > 200 && px.corner === 0 && px.frame === outP && px.closed, J({ magic, saved: saved.w, px }));
    // pre-clean with the real model (on by default): both renders get a cleaned copy, the result changes with the option and goes back when it is switched off
    if (!fs.existsSync(path.join(root, 'models', '1x_PureVision.onnx'))) {
      console.log('SKIP  Solve frame pre-clean: models/1x_PureVision.onnx not found');
    } else {
      const nw = path.join(work, 'Noisy ring white.png'), nb = path.join(work, 'Noisy ring black.png');
      const pre = await app.ev(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const N = 240, F = [200, 90, 40];
        const mk = (bg) => { const c = document.createElement('canvas'); c.width = c.height = N; const x = c.getContext('2d'); const d = x.createImageData(N, N); let s = bg + 3;
          for (let y = 0; y < N; y++) for (let xx = 0; xx < N; xx++) { const r = Math.hypot(xx - 119.5, y - 119.5); const a = r > 70 && r < 105 ? 1 : r > 62 && r <= 70 ? (r - 62) / 8 : r >= 105 && r < 110 ? (110 - r) / 5 : 0; const i = (y * N + xx) * 4; s = (s * 1664525 + 1013904223) >>> 0;
            const noise = ((xx >> 3) + (y >> 3)) % 2 ? 5 : -5;
            for (let k = 0; k < 3; k++) d.data[i + k] = Math.max(0, Math.min(255, Math.round(F[k] * a + bg * (1 - a) + noise + (s / 4294967296 - 0.5) * 8))); d.data[i + 3] = 255; }
          x.putImageData(d, 0, 0); return c; };
        const save = async (c, p) => window.api.writeFile(p, new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer()));
        await save(mk(255), ${J(nw)}); await save(mk(0), ${J(nb)});
        const sv = __tf.solver; await sv.open(); await wait(300);
        const o = { checkbox: !!document.querySelector('#svControls input[type=checkbox]'), defaultOn: sv.params.preClean === true, model: sv.params.preCleanModel };
        await sv.loadSlot('white', ${J(nw)}); await sv.loadSlot('black', ${J(nb)});
        o.before = { state: sv.cleanState, buttons: sv.buttons, msg: document.querySelector('#svMsg').textContent.includes('Press Process') }; const rawPx = Array.from(sv.result.rgba);   // real-time preview: the model has not run yet
        await sv.process();
        o.on = sv.cleanState; o.after = sv.buttons; const a = Array.from(sv.result.rgba);
        await sv.setParams({ preClean: false }); o.off = sv.cleanState; o.offButtons = sv.buttons; const b = Array.from(sv.result.rgba);
        await sv.setParams({ preClean: true }); o.again = sv.cleanState;
        o.differs = a.length === b.length ? a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0) : -1;
        o.rawIsOff = rawPx.length === b.length && rawPx.every((v, i) => v === b[i]);
        sv.close();
        return o;
      })()`);
      check('Solve frame pre-clean: on by default with the model, both renders cleaned, the result changes with the option and is restored when it is turned back on', pre.checkbox && pre.defaultOn && pre.model === '1x_PureVision' && pre.on.white === '1x_PureVision' && pre.on.black === '1x_PureVision' && pre.on.used === true && pre.off.used === false && pre.again.used === true && pre.differs !== 0, J(pre));
      check('Solve frame pre-clean: loading only previews the raw renders (no model run, Save waits); Process cleans both, enables Save, and the preview then changes', pre.before.state.white === null && pre.before.state.black === null && pre.before.state.used === false && pre.before.buttons.process && !pre.before.buttons.save && pre.before.msg && pre.rawIsOff && pre.after.save && !pre.after.process && pre.offButtons.save && !pre.offButtons.process, J({ before: pre.before, after: pre.after, off: pre.offButtons, rawIsOff: pre.rawIsOff }));
    }
    await app.ev(`__tf.loadFrame(${J(path.join(root, 'assets', 'default.webp'))}, { keepOrder: true })`);
  }

  // -- Solve image background mode: same screen and maths as the frame solver, but the whole picture is kept (no trim, no resize, no cut-out middle)
  {
    const whiteP = path.join(work, 'Ring white.png'), blackP = path.join(work, 'Ring black.png'), outP = path.join(work, 'Ring (solved).png');
    fs.rmSync(outP, { force: true });
    const im = await app.ev(`(async () => {
      const q = (x) => document.querySelector(x); const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const pure = await import('./lib/solveframe.js');
      const s = pure.createSolver(); const px = (v) => { const a = new Uint8ClampedArray(6 * 6 * 4).fill(v); for (let i = 3; i < a.length; i += 4) a[i] = 255; return a; };
      s.setImage('white', px(255), 6, 6); s.setImage('black', px(0), 6, 6);   // nothing but background: fully transparent everywhere
      const pureOut = { cropped: s.preview({ crop: true }).w, kept: s.preview({ crop: false }).w, keptH: s.preview({ crop: false }).h };
      q('#btnTools').click(); await wait(80); q('#btnSolveImage').click(); await wait(400);
      const o = { pure: pureOut, open: !q('#solver').hidden, mode: __tf.solver.mode, title: q('#svTitle').textContent, button: q('#svSaveLoad').textContent,
        labels: [...document.querySelectorAll('#svControls .row label')].map((l) => l.textContent), subheads: [...document.querySelectorAll('#svControls .subhead')].map((l) => l.textContent.trim()) };
      await __tf.solver.loadSlot('white', ${J(whiteP)}); await __tf.solver.loadSlot('black', ${J(blackP)});
      for (let i = 0; i < 100 && !__tf.solver.result; i++) await wait(100);
      o.whole = [__tf.solver.result?.w, __tf.solver.result?.h];
      __tf.solver.open('frame'); await wait(600);                // back to frame mode: the same pair is trimmed again
      for (let i = 0; i < 50 && !(__tf.solver.result && __tf.solver.result.w < 400); i++) await wait(100);   // (a busy machine can take longer than that)
      o.frame = { mode: __tf.solver.mode, title: q('#svTitle').textContent, button: q('#svSaveLoad').textContent, w: __tf.solver.result?.w, labels: [...document.querySelectorAll('#svControls .row label')].map((l) => l.textContent) };
      __tf.solver.open('image'); await wait(600);
      return o;
    })()`);
    check('Solve image background: image mode hides the trim/resize/middle controls and keeps the whole picture; frame mode still trims it', im.pure.cropped === 6 && im.pure.kept === 6 && im.pure.keptH === 6 && im.open && im.mode === 'image' && im.title === 'Solve image background' && im.button === 'Save and open as image' && !im.labels.includes('Crop threshold') && !im.labels.includes('Resize') && !im.labels.includes('Clear the middle') && im.labels.includes('Channel mode') && im.whole[0] === 400 && im.whole[1] === 400 && im.frame.mode === 'frame' && im.frame.w < 400 && im.frame.button === 'Save and use as frame' && im.frame.labels.includes('Crop threshold'), J(im));
    const saved = await app.ev(`__tf.solver.saveAndLoad(${J(outP)})`);
    const magic = fs.existsSync(outP) ? fs.readFileSync(outP).subarray(0, 4).toString('hex') : '';
    const after = await app.ev(`(async () => { const bm = await createImageBitmap(new Blob([await window.api.readFile(${J(outP)})])); const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height; const x = c.getContext('2d'); x.drawImage(bm, 0, 0);
      const a = (px, py) => x.getImageData(px, py, 1, 1).data[3]; return { w: bm.width, h: bm.height, ring: a(199, 60), corner: a(2, 2), items: __tf.items.length, path: __tf.items[0]?.path, frameUnchanged: !/solved/.test(__tf.frame.path), closed: document.querySelector('#solver').hidden }; })()`);
    check('Solve image background: Save and open as image writes the full-size PNG and opens it as the art image (the frame is left alone)', magic === '89504e47' && saved.w === 400 && after.w === 400 && after.h === 400 && after.ring > 200 && after.corner === 0 && after.items === 1 && after.path === outP && after.frameUnchanged && after.closed, J({ magic, saved: saved.w, after }));
    await app.ev(`__tf.openImages([${J(art)}])`); await sleep(600); // put the shared test art back for the checks that follow
  }

  // -- Extend edges: the padding maths (mirror / smear / transparent) and the screen
  {
    const exP = path.join(work, 'Art (extended).png');
    fs.rmSync(exP, { force: true });
    const m = await app.ev(`(async () => {
      const ee = await import('./lib/extendedges.js'); const o = {};
      const mk = (w, h, alpha = 255) => { const a = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { a[i * 4] = (i % w) * 20 + 5; a[i * 4 + 1] = Math.floor(i / w) * 30 + 7; a[i * 4 + 2] = 90; a[i * 4 + 3] = alpha; } return a; };
      const px = (r, x, y) => [...r.rgba.slice((y * r.w + x) * 4, (y * r.w + x) * 4 + 4)];
      const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
      const src = mk(5, 3), at = (x, y) => [...src.slice((y * 5 + x) * 4, (y * 5 + x) * 4 + 4)];
      o.reflect = [0, 1, 4, -1, -2, 5, 6, 7, 8, -5, 11].map((i) => ee.reflectIndex(i, 5)).join();
      o.square = [ee.squarePadding(1000, 300), ee.squarePadding(300, 1001), ee.squarePadding(40, 40), ee.squarePadding(1500, 300, ee.MAX_PAD), ee.squarePadding(300, 1001, 512)];
      // mirror, no softening: distance d outside reads the picture's pixel d (no doubled line), and the padding may be wider than the picture
      const a = ee.extendEdges(src, 5, 3, { left: 12, right: 7, top: 4, bottom: 9, mode: 'mirror', blur: 0 });
      o.size = [a.w, a.h];
      o.centre = (() => { for (let y = 0; y < 3; y++) for (let x = 0; x < 5; x++) if (!eq(px(a, x + 12, y + 4), at(x, y))) return false; return true; })();
      o.mirrorL = eq(px(a, 11, 4), at(1, 0)) && eq(px(a, 10, 4), at(2, 0)) && eq(px(a, 8, 4), at(4, 0)) && eq(px(a, 7, 4), at(3, 0)) && eq(px(a, 0, 4), at(ee.reflectIndex(-12, 5), 0));
      o.mirrorT = eq(px(a, 12, 3), at(0, 1)) && eq(px(a, 12, 2), at(0, 2)) && eq(px(a, 12, 1), at(0, 1)) && eq(px(a, 12, 0), at(0, 0));
      o.corner = eq(px(a, 11, 3), at(1, 1)) && eq(px(a, 0, 0), at(ee.reflectIndex(-12, 5), ee.reflectIndex(-4, 3)));
      // smear: the edge pixels repeat, corners take the corner pixel
      const s = ee.extendEdges(src, 5, 3, { left: 6, right: 6, top: 6, bottom: 6, mode: 'smear', blur: 0 });
      o.smearEdge = eq(px(s, 0, 7), at(0, 1)) && eq(px(s, 16, 8), at(4, 2)) && eq(px(s, 3, 0), at(0, 0)) && eq(px(s, 0, 0), at(0, 0)) && eq(px(s, 16, 14), at(4, 2)) && eq(px(s, 9, 14), at(3, 2));
      // transparent: empty border, picture intact
      const t = ee.extendEdges(src, 5, 3, { left: 2, right: 2, top: 2, bottom: 2, mode: 'transparent' });
      o.transparent = t.w === 9 && t.h === 7 && px(t, 0, 0)[3] === 0 && px(t, 8, 6)[3] === 0 && eq(px(t, 2, 2), at(0, 0));
      // softening keeps the picture byte-identical and does not darken a half-transparent picture (blur runs on premultiplied values)
      const red = new Uint8ClampedArray(6 * 6 * 4); for (let i = 0; i < 36; i++) { red[i * 4] = 250; red[i * 4 + 1] = 10; red[i * 4 + 2] = 10; red[i * 4 + 3] = i % 6 < 3 ? 255 : 90; }
      const b = ee.extendEdges(red, 6, 6, { left: 20, right: 20, top: 20, bottom: 20, mode: 'mirror', blur: 0.6 });
      let fringe = 0, visible = 0; for (let i = 0; i < b.w * b.h; i++) if (b.rgba[i * 4 + 3] > 20) { visible++; if (b.rgba[i * 4] < 240 || b.rgba[i * 4 + 1] > 20) fringe++; }
      o.alphaBlur = { visible, fringe, centre: (() => { for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) { const p = px(b, x + 20, y + 20); for (let c = 0; c < 4; c++) if (p[c] !== red[(y * 6 + x) * 4 + c]) return false; } return true; })() };
      // softening grows with distance: next to the picture the fill is sharp, far away it is smoother
      const stripes = new Uint8ClampedArray(40 * 8 * 4); for (let i = 0; i < 40 * 8; i++) { const v = (((i % 40) >> 2) % 2) * 255; stripes[i * 4] = stripes[i * 4 + 1] = stripes[i * 4 + 2] = v; stripes[i * 4 + 3] = 255; }
      const d = ee.extendEdges(stripes, 40, 8, { top: 60, mode: 'mirror', blur: 0.5 });
      const spread = (y) => { let lo = 255, hi = 0; for (let x = 5; x < 35; x++) { const v = d.rgba[(y * d.w + x) * 4]; lo = Math.min(lo, v); hi = Math.max(hi, v); } return hi - lo; };
      o.soft = { near: spread(59), far: spread(2) };
      try { ee.extendEdges(src, 5, 3, { left: 20000, right: 20000, top: 20000 }); o.limit = false; } catch (e) { o.limit = /megapixel/.test(e.message); }
      return o;
    })()`);
    check('Extend edges maths: reflect indices bounce without repeating the edge, "pad to square" is centred', m.reflect === '0,1,4,1,2,3,2,1,0,3,3' && J(m.square[0]) === J({ top: 350, bottom: 350, left: 0, right: 0 }) && J(m.square[1]) === J({ left: 350, right: 351, top: 0, bottom: 0 }) && J(m.square[2]) === J({ top: 0, right: 0, bottom: 0, left: 0 }) && J(m.square[3]) === J({ top: 512, bottom: 512, left: 0, right: 0 }) && J(m.square[4]) === J({ left: 350, right: 351, top: 0, bottom: 0 }), J({ reflect: m.reflect, square: m.square }));
    check('Extend edges maths: mirror keeps the picture byte for byte, reads source pixel d at distance d (no doubled line), copes with padding wider than the picture, mirrors corners on both axes', J(m.size) === J([24, 16]) && m.centre && m.mirrorL && m.mirrorT && m.corner, J(m));
    check('Extend edges maths: smear repeats the edge pixels; transparent adds empty canvas', m.smearEdge && m.transparent, J({ smearEdge: m.smearEdge, transparent: m.transparent }));
    check('Extend edges maths: softening leaves the picture untouched, adds no dark/coloured fringe to a half-transparent picture, is sharper near the picture than far from it, and refuses a result over the pixel limit', m.alphaBlur.centre && m.alphaBlur.visible > 100 && m.alphaBlur.fringe === 0 && m.soft.near > 200 && m.soft.far < m.soft.near / 2 && m.limit, J({ alphaBlur: m.alphaBlur, soft: m.soft, limit: m.limit }));

    const r = await app.ev(`(async () => {
      const q = (x) => document.querySelector(x); const wait = (ms) => new Promise((res) => setTimeout(res, ms)); const o = {};
      q('#btnTools').click(); await wait(80); q('#btnExtendImage').click(); await wait(300);
      o.open = !q('#extend').hidden; o.menuClosed = q('#toolsMenu').hidden;
      await __tf.extend.loadPath(${J(art)}); await wait(200);
      await __tf.extend.setParams({ mode: 'mirror' });   // (Patch fill is the default; these checks are about the instant modes)
      o.start = { saveOff: q('#exSave').disabled, processOff: q('#exProcess').disabled, bounds: __tf.extend.source && [__tf.extend.source.width, __tf.extend.source.height] };
      [...document.querySelectorAll('#exControls button')].find((b) => b.textContent === 'Pad to square').click();
      for (let i = 0; i < 100 && !__tf.extend.fresh; i++) await wait(100);
      const rc = __tf.extend.result, src = __tf.extend.source;
      o.square = { w: rc?.width, h: rc?.height, saveOn: !q('#exSave').disabled, params: __tf.extend.params };
      if (rc) { const a = src.getContext('2d').getImageData(0, 0, src.width, src.height).data, b = rc.getContext('2d').getImageData(0, 0, rc.width, rc.height).data; let same = true;
        for (let y = 0; y < src.height && same; y++) for (let x = 0; x < src.width; x++) { const i = (y * src.width + x) * 4, j = ((y + __tf.extend.params.top) * rc.width + x + __tf.extend.params.left) * 4; if (a[i] !== b[j] || a[i + 1] !== b[j + 1] || a[i + 2] !== b[j + 2] || a[i + 3] !== b[j + 3]) { same = false; break; } }
        o.square.same = same; }
      await __tf.extend.setParams({ top: 0, bottom: 0, left: 0, right: 0 }); o.zero = { result: !!__tf.extend.result, saveOff: q('#exSave').disabled };
      await __tf.extend.setParams({ link: true, left: 13 });
      o.link = { params: __tf.extend.params, w: __tf.extend.result?.width, h: __tf.extend.result?.height };
      await __tf.extend.setParams({ link: false, top: 900, left: -5 }); o.capped = { top: __tf.extend.params.top, left: __tf.extend.params.left, max: q('#exControls input[type=range]').max };   // a typed number past the limit is pulled back
      await __tf.extend.setParams({ link: true, left: 13 });
      await __tf.extend.setParams({ mode: 'transparent' });
      const tc = __tf.extend.result; o.transparent = tc && tc.getContext('2d').getImageData(0, 0, 1, 1).data[3];
      await __tf.extend.setParams({ mode: 'mirror', blur: 0.25, link: false, top: 20, bottom: 20, left: 20, right: 20 });
      return o;
    })()`);
    check('Extend edges: opens from Tools, nothing to save until there is a padded result', r.open && r.menuClosed && r.start.saveOff && r.start.processOff && J(r.start.bounds) === J([400, 300]), J(r.start));
    check('Extend edges: "Pad to square" makes a square result with the original untouched in the middle, and enables saving', r.square.w === 400 && r.square.h === 400 && r.square.same && r.square.saveOn, J(r.square));
    check('Extend edges: zero padding has no result to save; linked sides change together; transparent mode leaves an empty border', !r.zero.result && r.zero.saveOff && r.link.params.top === 13 && r.link.params.right === 13 && r.link.params.bottom === 13 && r.link.w === 426 && r.link.h === 326 && r.transparent === 0 && r.capped.top === 512 && r.capped.left === 0 && r.capped.max === '512', J({ zero: r.zero, link: r.link, transparent: r.transparent, capped: r.capped }));
    const saved = await app.ev(`__tf.extend.saveAndOpen(${J(exP)})`);
    const magic = fs.existsSync(exP) ? fs.readFileSync(exP).subarray(0, 4).toString('hex') : '';
    const after = await app.ev(`({ items: __tf.items.length, path: __tf.items[0]?.path, closed: document.querySelector('#extend').hidden })`);
    check('Extend edges: Save and open as image writes a PNG of the padded size and opens it in the main window', magic === '89504e47' && saved.w === 440 && saved.h === 340 && after.items === 1 && after.path === exP && after.closed, J({ magic, saved, after }));
    // Patch fill: the content-aware maths (pure), then the screen (placeholder until Process, progress/cancel, opaque images only)
    const pm = await app.ev(`(async () => {
      const pf = await import('./lib/patchfill.js'), ee = await import('./lib/extendedges.js'); const o = {};
      const g = (x, y, c) => 128 + 90 * Math.sin(2 * Math.PI * (x + 2 * y) / 10 + c * 2);
      const mk = (w, h, ox = 0, oy = 0) => { const a = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; for (let c = 0; c < 3; c++) a[i + c] = g(x + ox, y + oy, c); a[i + 3] = 255; } return a; };
      const W0 = 80, H0 = 80, P = 24, tex = mk(W0, H0);
      const init = ee.extendEdges(tex, W0, H0, { left: P, right: P, top: P, bottom: P, mode: 'smear', blur: 0 });
      const run = () => pf.patchFill(init.rgba, init.w, init.h, { x: P, y: P, w: W0, h: H0 }, { patch: 7, iterations: 4, band: 0.5, seed: 1 });
      const out = run(), again = run(), ref = mk(init.w, init.h, -P, -P);
      let err = 0, base = 0, n = 0, centre = true, opaque = true;
      for (let y = 0; y < init.h; y++) for (let x = 0; x < init.w; x++) {
        const i = (y * init.w + x) * 4; if (out[i + 3] !== 255) opaque = false;
        if (x >= P && x < P + W0 && y >= P && y < P + H0) { for (let c = 0; c < 4; c++) if (out[i + c] !== tex[((y - P) * W0 + x - P) * 4 + c]) centre = false; continue; }
        for (let c = 0; c < 3; c++) { err += Math.abs(out[i + c] - ref[i + c]); base += Math.abs(init.rgba[i + c] - ref[i + c]); n++; }
      }
      o.texture = { err: +(err / n).toFixed(2), smearErr: +(base / n).toFixed(2), centre, opaque, deterministic: out.every((v, i) => v === again[i]) };
      // a marker deep inside the picture (outside the source band) never turns up in the border
      const w = 100, h = 100, a = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { a[i * 4] = 60 + (i % w); a[i * 4 + 1] = 90 + ((i / w) | 0); a[i * 4 + 2] = 120; a[i * 4 + 3] = 255; }
      for (let y = 45; y < 55; y++) for (let x = 45; x < 55; x++) { const i = (y * w + x) * 4; a[i] = 255; a[i + 1] = 0; a[i + 2] = 255; }
      const ini = ee.extendEdges(a, w, h, { left: 30, right: 30, top: 30, bottom: 30, mode: 'smear', blur: 0 });
      const o3 = pf.patchFill(ini.rgba, ini.w, ini.h, { x: 30, y: 30, w, h }, { patch: 7, iterations: 3, band: 0.15, seed: 2 });
      let mag = 0; for (let y = 0; y < ini.h; y++) for (let x = 0; x < ini.w; x++) { if (x >= 30 && x < 130 && y >= 30 && y < 130) continue; const i = (y * ini.w + x) * 4; if (o3[i] > 150 && o3[i + 1] < 100 && o3[i + 2] > 150) mag++; }
      o.marker = mag;
      try { const s = new Uint8ClampedArray(8 * 8 * 4).fill(255); const si = ee.extendEdges(s, 8, 8, { left: 5, right: 5, top: 5, bottom: 5, mode: 'smear', blur: 0 }); pf.patchFill(si.rgba, si.w, si.h, { x: 5, y: 5, w: 8, h: 8 }, { patch: 15 }); o.small = 'no error'; } catch (e) { o.small = e.message; }
      return o;
    })()`);
    check('Patch fill maths: continues a periodic texture into the border far better than a smear, leaves the picture byte for byte, is opaque and deterministic, never copies a marker from deep inside, and refuses an image too small for the patch', pm.texture.err < 30 && pm.texture.err < pm.texture.smearErr / 2 && pm.texture.centre && pm.texture.opaque && pm.texture.deterministic && pm.marker === 0 && /too small/.test(pm.small), J(pm));

    const pxP = path.join(work, 'Patch see-through.png');
    const pu = await app.ev(`(async () => {
      const q = (x) => document.querySelector(x); const wait = (ms) => new Promise((res) => setTimeout(res, ms)); const o = {};
      q('#btnTools').click(); await wait(80); q('#btnExtendImage').click(); await wait(300);
      await __tf.extend.loadPath(${J(art)});
      await __tf.extend.setParams({ mode: 'patch', link: false, top: 40, bottom: 40, left: 40, right: 40, seed: 1 });
      o.rows = [...document.querySelectorAll('#exControls .row')].filter((r) => r.style.display !== 'none').map((r) => (r.querySelector('label') || r).textContent);
      o.placeholder = { placeholder: __tf.extend.placeholder, full: __tf.extend.full, saveOff: q('#exSave').disabled, processOn: !q('#exProcess').disabled, w: __tf.extend.result?.width, h: __tf.extend.result?.height };
      const job = __tf.extend.process(); await wait(60);
      o.running = { patching: __tf.extend.patching, cancelShown: !q('#exCancel').hidden, progShown: !q('#exProg').hidden, processOff: q('#exProcess').disabled, saveOff: q('#exSave').disabled };
      await job;
      o.done = { patched: __tf.extend.patched, full: __tf.extend.full, saveOn: !q('#exSave').disabled, w: __tf.extend.result?.width, h: __tf.extend.result?.height, cancelHidden: q('#exCancel').hidden, processOff: q('#exProcess').disabled };
      const rc = __tf.extend.result, src = __tf.extend.source;
      { const a = src.getContext('2d').getImageData(0, 0, src.width, src.height).data, b = rc.getContext('2d').getImageData(0, 0, rc.width, rc.height).data; let same = true, opq = true;
        for (let y = 0; y < rc.height; y++) for (let x = 0; x < rc.width; x++) { const j = (y * rc.width + x) * 4; if (b[j + 3] !== 255) opq = false; const sx = x - 40, sy = y - 40; if (sx >= 0 && sy >= 0 && sx < src.width && sy < src.height) { const i = (sy * src.width + sx) * 4; if (a[i] !== b[j] || a[i + 1] !== b[j + 1] || a[i + 2] !== b[j + 2]) same = false; } }
        o.done.same = same; o.done.opaque = opq; }
      await __tf.extend.setParams({ seed: 2 });                      // another Variation: the old fill is gone, a placeholder is shown again
      o.changed = { patched: __tf.extend.patched, placeholder: __tf.extend.placeholder, saveOff: q('#exSave').disabled };
      const job2 = __tf.extend.process(); await wait(80); __tf.extend.cancel(); await job2;
      o.cancelled = { patching: __tf.extend.patching, patched: __tf.extend.patched, saveOff: q('#exSave').disabled, processOn: !q('#exProcess').disabled, msg: q('#exMsg').textContent, cancelHidden: q('#exCancel').hidden };
      await __tf.extend.process();                                    // the worker was restarted: it gets the picture again
      o.again = { patched: __tf.extend.patched, w: __tf.extend.result?.width };
      const job3 = __tf.extend.setParams({ seed: 3 }); await job3;    // changing a setting while it runs (after a restart) must not leave it stuck
      const job4 = __tf.extend.process(); await wait(80); const job5 = __tf.extend.setParams({ seed: 4 }); await Promise.all([job4, job5]);
      o.interrupted = { patching: __tf.extend.patching, patched: __tf.extend.patched, placeholder: __tf.extend.placeholder, processOn: !q('#exProcess').disabled };
      // the REAL controls while a fill runs: toggling the outline leaves it alone, Pad to square (a new setting) stops it and the placeholder arrives promptly
      await __tf.extend.setParams({ seed: 5, link: false, top: 100, bottom: 100, left: 100, right: 100 });
      const outline = [...document.querySelectorAll('#exControls .row')].find((r) => r.textContent.includes('Outline the original')).querySelector('input[type=checkbox]');
      const jobA = __tf.extend.process(); await wait(80);
      outline.click(); await wait(30);
      o.outlineMid = { patching: __tf.extend.patching, bounds: __tf.extend.params.showBounds };
      await jobA;
      o.outlineDone = { patched: __tf.extend.patched, saveOn: !q('#exSave').disabled };
      outline.click();
      await __tf.extend.setParams({ seed: 6 });
      const jobB = __tf.extend.process(); await wait(80);
      const t1 = performance.now();
      [...document.querySelectorAll('#exControls button')].find((b) => b.textContent === 'Pad to square').click();
      for (let i = 0; i < 100 && !(__tf.extend.placeholder && __tf.extend.result?.width === 400 && !__tf.extend.busy); i++) await wait(50);
      o.padMid = { ms: Math.round(performance.now() - t1), patching: __tf.extend.patching, cancelHidden: q('#exCancel').hidden, progHidden: q('#exProg').hidden, placeholder: __tf.extend.placeholder, w: __tf.extend.result?.width, h: __tf.extend.result?.height };
      await jobB;
      const jobC = __tf.extend.setParams({ top: 100, bottom: 100, left: 100, right: 100, seed: 7 }); await jobC;
      const jobD = __tf.extend.process(); await wait(80);
      q('#exReset').click();
      for (let i = 0; i < 100 && !(__tf.extend.params.top === 0 && !__tf.extend.busy); i++) await wait(50);
      o.resetMid = { patching: __tf.extend.patching, cancelHidden: q('#exCancel').hidden, mode: __tf.extend.params.mode, top: __tf.extend.params.top };
      await jobD;
      await __tf.extend.setParams({ mode: 'patch', link: false, top: 40, bottom: 40, left: 40, right: 40, seed: 1 });
      // an image with transparency: Patch fill refuses it, Mirror still works
      const c = document.createElement('canvas'); c.width = 120; c.height = 90; const x = c.getContext('2d'); x.fillStyle = '#3a7'; x.fillRect(0, 0, 120, 90); x.clearRect(0, 0, 30, 30);
      await window.api.writeFile(${J(pxP)}, new Uint8Array(await (await new Promise((res) => c.toBlob(res, 'image/png'))).arrayBuffer()));
      await __tf.extend.loadPath(${J(pxP)}); await wait(300);
      o.alpha = { processOff: q('#exProcess').disabled, msg: q('#exMsg').textContent.slice(0, 60), result: !!__tf.extend.result };
      await __tf.extend.setParams({ mode: 'mirror', blur: 0.25, seed: 1 });
      o.alphaMirror = { w: __tf.extend.result?.width, full: __tf.extend.full };
      __tf.extend.close();
      return o;
    })()`);
    check('Extend edges: Patch fill shows a placeholder (Save off, Process on) until Process; Process shows progress and Cancel, then gives a full opaque result with the picture untouched', pu.rows.includes('Patch size') && pu.rows.includes('Source band') && !pu.rows.includes('Soften with distance') && pu.placeholder.placeholder && !pu.placeholder.full && pu.placeholder.saveOff && pu.placeholder.processOn && pu.placeholder.w === 480 && pu.running.patching && pu.running.cancelShown && pu.running.progShown && pu.running.processOff && pu.running.saveOff && pu.done.patched && pu.done.full && pu.done.saveOn && pu.done.w === 480 && pu.done.h === 380 && pu.done.cancelHidden && pu.done.processOff && pu.done.same && pu.done.opaque, J(pu));
    check('Extend edges: changing Variation drops the fill; Cancel stops a running fill (nothing saved, nothing stuck) and Process works again; changing a setting mid-run does not leave it busy', !pu.changed.patched && pu.changed.placeholder && pu.changed.saveOff && !pu.cancelled.patching && !pu.cancelled.patched && pu.cancelled.saveOff && pu.cancelled.processOn && /Cancelled/.test(pu.cancelled.msg) && pu.cancelled.cancelHidden && pu.again.patched && pu.again.w === 480 && !pu.interrupted.patching && !pu.interrupted.patched && pu.interrupted.placeholder && pu.interrupted.processOn, J({ changed: pu.changed, cancelled: pu.cancelled, again: pu.again, interrupted: pu.interrupted }));
    check('Extend edges: toggling the outline mid-run leaves a Patch fill running to completion; Pad to square or Reset mid-run stops it cleanly (no stuck Cancel/progress) and the placeholder arrives promptly', pu.outlineMid.patching && pu.outlineDone.patched && pu.outlineDone.saveOn && !pu.padMid.patching && pu.padMid.cancelHidden && pu.padMid.progHidden && pu.padMid.placeholder && pu.padMid.ms < 4000 && pu.padMid.w === 400 && pu.padMid.h === 400 && !pu.resetMid.patching && pu.resetMid.cancelHidden && pu.resetMid.mode === 'patch' && pu.resetMid.top === 0, J({ outlineMid: pu.outlineMid, outlineDone: pu.outlineDone, padMid: pu.padMid, resetMid: pu.resetMid }));
    check('Extend edges: Patch fill refuses an image with transparency (Process off, says why) while Mirror still extends it', pu.alpha.processOff && /opaque/.test(pu.alpha.msg) && !pu.alpha.result && pu.alphaMirror.w === 200 && pu.alphaMirror.full, J({ alpha: pu.alpha, mirror: pu.alphaMirror }));

    // a big result is previewed at reduced size and only Process builds (and lets you save) the full image
    const bigP = path.join(work, 'Big.png'), bigOut = path.join(work, 'Big (extended).png');
    fs.rmSync(bigOut, { force: true });
    const bg = await app.ev(`(async () => {
      const q = (x) => document.querySelector(x); const wait = (ms) => new Promise((res) => setTimeout(res, ms)); const o = {};
      const c = document.createElement('canvas'); c.width = 2400; c.height = 1800; const x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, 2400, 1800); g.addColorStop(0, '#cc3333'); g.addColorStop(1, '#3366cc'); x.fillStyle = g; x.fillRect(0, 0, 2400, 1800);
      await window.api.writeFile(${J(bigP)}, new Uint8Array(await (await new Promise((res) => c.toBlob(res, 'image/png'))).arrayBuffer()));
      q('#btnTools').click(); await wait(80); q('#btnExtendImage').click(); await wait(300);
      await __tf.extend.loadPath(${J(bigP)});
      __tf.extend.padToSquare();
      const t0 = performance.now();
      for (let i = 0; i < 100 && !(__tf.extend.fresh && !__tf.extend.busy); i++) await wait(100);
      const rc = __tf.extend.result;
      o.preview = { w: rc?.width, h: rc?.height, full: __tf.extend.full, saveOff: q('#exSave').disabled, processOn: !q('#exProcess').disabled, ms: Math.round(performance.now() - t0), msg: q('#exMsg').textContent.slice(0, 40) };
      await __tf.extend.process();
      const fc = __tf.extend.result;
      o.full = { w: fc?.width, h: fc?.height, full: __tf.extend.full, saveOn: !q('#exSave').disabled, processOff: q('#exProcess').disabled };
      await __tf.extend.setParams({ top: 310 });
      o.edited = { full: __tf.extend.full, saveOff: q('#exSave').disabled, processOn: !q('#exProcess').disabled };
      await __tf.extend.setParams({ top: 300 }); await __tf.extend.process();
      return o;
    })()`);
    check('Extend edges: a big result is previewed at reduced size (Save off, Process on); Process builds the full image and enables saving; changing a control goes back to the preview', bg.preview.w === 1200 && bg.preview.h === 1200 && !bg.preview.full && bg.preview.saveOff && bg.preview.processOn && bg.full.w === 2400 && bg.full.h === 2400 && bg.full.full && bg.full.saveOn && bg.full.processOff && !bg.edited.full && bg.edited.saveOff && bg.edited.processOn, J(bg));
    const bigSaved = await app.ev(`__tf.extend.saveTo(${J(bigOut)})`);
    check('Extend edges: saving after Process writes the full-size PNG', bigSaved.w === 2400 && bigSaved.h === 2400 && fs.existsSync(bigOut), J(bigSaved));
    await app.ev(`(__tf.extend.close(), __tf.openImages([${J(art)}]))`); await sleep(600); // put the shared test art back for the checks that follow
  }

  // -- Clean image screen: the real model through the main process (skipped when app/models/1x_PureVision.onnx is not there, e.g. a fresh clone)
  if (!fs.existsSync(path.join(root, 'models', '1x_PureVision.onnx'))) {
    console.log('SKIP  Clean image: models/1x_PureVision.onnx not found (convert it with tools/convert-model.py to run these checks)');
  } else {
    const noisyP = path.join(work, 'Noisy.png'), seeThroughP = path.join(work, 'See through.png'), smallP = path.join(work, 'Small.png'), cleanP = path.join(work, 'Noisy (clean).png');
    fs.rmSync(cleanP, { force: true });
    const r = await app.ev(`(async () => {
      const q = (x) => document.querySelector(x); const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const mk = (transparent) => { const W = 330, H = 222, c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d'); const d = x.createImageData(W, H); let s = 99;
        for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) { const i = (y * W + xx) * 4; s = (s * 1664525 + 1013904223) >>> 0; const b = 120 + 70 * Math.sin(xx / 21) + (((xx >> 3) + (y >> 3)) % 2 ? 7 : -7) + (s / 4294967296 - 0.5) * 22;
          d.data[i] = b; d.data[i + 1] = b * 0.9; d.data[i + 2] = b * 0.7; d.data[i + 3] = transparent && xx < 40 ? 0 : 255; }
        x.putImageData(d, 0, 0); return c; };
      const save = async (c, p) => window.api.writeFile(p, new Uint8Array(await (await new Promise((res) => c.toBlob(res, 'image/png'))).arrayBuffer()));
      await save(mk(false), ${J(noisyP)}); await save(mk(true), ${J(seeThroughP)});
      q('#btnTools').click(); await wait(80); q('#btnCleanImage').click(); await wait(300);
      const o = { open: !q('#imgclean').hidden, menuClosed: q('#toolsMenu').hidden, models: [...q('#icModel').options].map((x) => x.value), saveOff: q('#icSave').disabled };
      await __tf.imgclean.loadPath(${J(seeThroughP)}); await wait(200);
      o.refused = { opaque: __tf.imgclean.opaque, cleaned: !!__tf.imgclean.cleaned, saveOff: q('#icSave').disabled, msg: q('#icMsg').textContent.slice(0, 60) };
      await __tf.imgclean.loadPath(${J(noisyP)}); await wait(300);
      o.waiting = { cleaned: !!__tf.imgclean.cleaned, processOn: !q('#icProcess').disabled, saveOff: q('#icSave').disabled, msg: q('#icMsg').textContent.includes('Press Process'), scaleRow: !q('#icScaleRow').hidden };   // nothing runs until Process is pressed
      await __tf.imgclean.process();
      const a = __tf.imgclean.original, b = __tf.imgclean.cleaned;
      if (b) { const da = a.getContext('2d').getImageData(0, 0, a.width, a.height).data, db = b.getContext('2d').getImageData(0, 0, b.width, b.height).data; let sum = 0, alpha = true; for (let i = 0; i < da.length; i += 4) { for (let c = 0; c < 3; c++) sum += Math.abs(da[i + c] - db[i + c]); if (db[i + 3] !== 255) alpha = false; }
        o.clean = { w: b.width, h: b.height, meanChange: +(sum / (da.length / 4 * 3)).toFixed(2), alphaKept: alpha, provider: __tf.imgclean.info.provider, ms: __tf.imgclean.info.ms }; }
      o.saveOn = !q('#icSave').disabled;
      return o;
    })()`);
    check('Clean image: a loaded image waits for the Process button (no model run, no scale row), then Process cleans it', r.waiting.cleaned === false && r.waiting.processOn && r.waiting.saveOff && r.waiting.msg && !r.waiting.scaleRow && !!r.clean, J(r.waiting));
    check('Clean image: opens from Tools, lists the model, refuses an image with transparency', r.open && r.menuClosed && r.models.includes('1x_PureVision') && r.saveOff && r.refused.opaque === false && !r.refused.cleaned && r.refused.saveOff && /transparency/.test(r.refused.msg), J({ open: r.open, models: r.models, refused: r.refused }));
    check('Clean image: the real model cleans an opaque image at the same size and the picture changes', r.clean && r.clean.w === 330 && r.clean.h === 222 && r.clean.meanChange > 0.5 && r.clean.alphaKept && r.saveOn, J(r.clean));
    const saved = await app.ev(`__tf.imgclean.saveAndOpen(${J(cleanP)})`);
    const magic = fs.existsSync(cleanP) ? fs.readFileSync(cleanP).subarray(0, 4).toString('hex') : '';
    const after = await app.ev(`({ items: __tf.items.length, path: __tf.items[0]?.path, closed: document.querySelector('#imgclean').hidden })`);
    check('Clean image: Save and open as image writes a PNG and opens it in the main window', magic === '89504e47' && saved.w === 330 && after.items === 1 && after.path === cleanP && after.closed, J({ magic, saved: saved.w, after }));
    // a second image chosen while the first is still being cleaned must never receive the first one's result (different size, then transparent)
    const race = await app.ev(`(async () => {
      const q = (x) => document.querySelector(x); const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const mk = (W, H, transparent) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d'); const d = x.createImageData(W, H); let s = 5;
        for (let i = 0; i < W * H; i++) { s = (s * 1664525 + 1013904223) >>> 0; d.data[i * 4] = 100 + (s % 60); d.data[i * 4 + 1] = 90; d.data[i * 4 + 2] = 80; d.data[i * 4 + 3] = transparent && i % 7 === 0 ? 0 : 255; }
        x.putImageData(d, 0, 0); return c; };
      const save = async (c, p) => window.api.writeFile(p, new Uint8Array(await (await new Promise((res) => c.toBlob(res, 'image/png'))).arrayBuffer()));
      await save(mk(330, 222, false), ${J(noisyP)}); await save(mk(200, 120, false), ${J(smallP)}); await save(mk(64, 64, true), ${J(seeThroughP)});
      const o = {};
      await __tf.imgclean.open(); await wait(200);
      await __tf.imgclean.loadPath(${J(noisyP)});
      const job = __tf.imgclean.process();                         // not awaited: still processing when the next image arrives
      await wait(50);
      await __tf.imgclean.loadPath(${J(smallP)});
      await job; await wait(1200);                                 // let the stale job finish and be (wrongly) shown
      o.stale = { cleaned: !!__tf.imgclean.cleaned, saveOff: q('#icSave').disabled, processOn: !q('#icProcess').disabled };
      await __tf.imgclean.process();
      o.size = { w: __tf.imgclean.cleaned?.width, h: __tf.imgclean.cleaned?.height, infoW: __tf.imgclean.info?.w, saveOn: !q('#icSave').disabled };
      __tf.imgclean.loadPath(${J(smallP)});
      await __tf.imgclean.loadPath(${J(seeThroughP)});
      await wait(2000);
      o.transparent = { cleaned: !!__tf.imgclean.cleaned, saveOff: q('#icSave').disabled, opaque: __tf.imgclean.opaque };
      __tf.imgclean.close();
      return o;
    })()`);
    check('Clean image: a result never lands on a different image chosen while it was cleaning', race.stale.cleaned === false && race.stale.saveOff && race.stale.processOn && race.size.w === 200 && race.size.h === 120 && race.size.infoW === 200 && race.size.saveOn && race.transparent.cleaned === false && race.transparent.saveOff && race.transparent.opaque === false, J(race));
    await app.ev(`__tf.openImages([${J(art)}])`); await sleep(600); // put the shared test art back for the checks that follow
  }

  // -- Upscale image mode: the same screen offers only the Nx models, a 4x model really makes the picture 4x larger, transparency is refused, output is a PNG
  if (!fs.existsSync(path.join(root, 'models', '4x-UltraMix_Smooth.onnx'))) {
    console.log('SKIP  Upscale image: models/4x-UltraMix_Smooth.onnx not found (convert it with tools/convert-model.py to run these checks)');
  } else {
    const smallP = path.join(work, 'Tiny.png'), glassP = path.join(work, 'Tiny glass.png'), upP = path.join(work, 'Tiny (4x).png');
    fs.rmSync(upP, { force: true });
    const u = await app.ev(`(async () => {
      const q = (x) => document.querySelector(x); const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const mk = (transparent) => { const W = 120, H = 80, c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d'); const d = x.createImageData(W, H);
        for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) { const i = (y * W + xx) * 4; const b = 90 + 80 * (Math.hypot(xx - 60, y - 40) < 25 ? 1 : 0) + (xx % 9) * 2; d.data[i] = b; d.data[i + 1] = b * 0.8; d.data[i + 2] = b * 0.6; d.data[i + 3] = transparent && xx < 10 ? 0 : 255; }
        x.putImageData(d, 0, 0); return c; };
      const save = async (c, p) => window.api.writeFile(p, new Uint8Array(await (await new Promise((res) => c.toBlob(res, 'image/png'))).arrayBuffer()));
      await save(mk(false), ${J(smallP)}); await save(mk(true), ${J(glassP)});
      q('#btnTools').click(); await wait(80); q('#btnUpscaleImage').click(); await wait(300);
      const o = { open: !q('#imgclean').hidden, mode: __tf.imgclean.mode, title: q('#icTitle').textContent, models: [...q('#icModel').options].map((x) => x.value) };
      await __tf.imgclean.loadPath(${J(smallP)}); await wait(300);
      o.waiting = { cleaned: !!__tf.imgclean.cleaned, processOn: !q('#icProcess').disabled, saveOff: q('#icSave').disabled, scale: __tf.imgclean.scale, model: __tf.imgclean.model, row: !q('#icScaleRow').hidden, opts: [...q('#icScale').options].map((x) => x.value) };
      await __tf.imgclean.process();
      const c = __tf.imgclean.cleaned; o.out = c ? [c.width, c.height] : null; o.info = __tf.imgclean.info; o.saveOn = !q('#icSave').disabled;
      await __tf.imgclean.loadPath(${J(glassP)}); await wait(300);
      o.refused = { opaque: __tf.imgclean.opaque, cleaned: !!__tf.imgclean.cleaned, saveOff: q('#icSave').disabled };
      await __tf.imgclean.loadPath(${J(smallP)}); await __tf.imgclean.process();
      return o;
    })()`);
    check('Upscale image: a loaded image waits for Process; the factor defaults to 4x and offers 2x, 3x, 4x', u.waiting.cleaned === false && u.waiting.processOn && u.waiting.saveOff && u.waiting.scale === 4 && u.waiting.model === '4x-UltraMix_Smooth' && u.waiting.row && J(u.waiting.opts) === J(['2', '3', '4']), J(u.waiting));
    check('Upscale image: opens in upscale mode with only the Nx models, a 4x model makes the picture 4x larger, transparency is refused', u.open && u.mode === 'upscale' && u.title === 'Upscale image' && u.models.length >= 2 && u.models.every((m) => /^4x/.test(m)) && !u.models.includes('1x_PureVision') && u.out && u.out[0] === 480 && u.out[1] === 320 && u.info.scale === 4 && u.saveOn && u.refused.opaque === false && !u.refused.cleaned && u.refused.saveOff, J(u));
    const saved = await app.ev(`__tf.imgclean.saveTo(${J(upP)})`);
    const magic = fs.existsSync(upP) ? fs.readFileSync(upP).subarray(0, 4).toString('hex') : '';
    const back = await app.ev(`(async () => { const bm = await createImageBitmap(new Blob([await window.api.readFile(${J(upP)})])); return [bm.width, bm.height]; })()`);
    check('Upscale image: the saved file is a 480x320 PNG named with the scale', magic === '89504e47' && saved.w === 480 && J(back) === J([480, 320]) && /Tiny \(4x\)\.png$/.test(saved.path), J({ magic, saved: saved.w, back }));
    // the factor: 2x and 3x shrink the model's 4x result (exactly the Lanczos resize of it, no second model run), and 4x comes straight back
    const sc = await app.ev(`(async () => {
      const { resizeLanczos } = await import('./lib/cleanframe.js'); const ic = __tf.imgclean; const o = {}; const q = (x) => document.querySelector(x);
      const px = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const four = px(ic.cleaned), t0 = ic.info.ms;
      await ic.setScale(2); o.two = [ic.cleaned.width, ic.cleaned.height, ic.info.scale, ic.info.ms === t0];
      const want = resizeLanczos(four, 480, 320, 240, 160), got = px(ic.cleaned); o.maxDiff = 0; for (let i = 0; i < want.length; i++) o.maxDiff = Math.max(o.maxDiff, Math.abs(want[i] - got[i]));
      await ic.setScale(3); o.three = [ic.cleaned.width, ic.cleaned.height, ic.info.scale];
      o.saveOn = !q('#icSave').disabled;
      o.threeSaved = await ic.saveTo(${J(path.join(work, 'Tiny (3x).png'))});
      await ic.setScale(4); o.four = [ic.cleaned.width, ic.cleaned.height, ic.info.scale];
      const m = q('#icModel'); m.selectedIndex = (m.selectedIndex + 1) % m.options.length; m.onchange({ target: m });
      o.afterModel = { cleaned: !!ic.cleaned, saveOff: q('#icSave').disabled, processOn: !q('#icProcess').disabled };
      return o;
    })()`);
    check('Upscale image: 2x and 3x shrink the 4x result (identical to the Lanczos resize of it, same model run), 4x restores it, and changing the model asks for Process again', J(sc.two) === J([240, 160, 2, true]) && sc.maxDiff === 0 && J(sc.three) === J([360, 240, 3]) && sc.saveOn && sc.threeSaved.w === 360 && J(sc.four) === J([480, 320, 4]) && sc.afterModel.cleaned === false && sc.afterModel.saveOff && sc.afterModel.processOn, J(sc));
    // a very large run asks first (declining leaves everything untouched); a normal one never asks
    const heavy = await app.ev(`(async () => {
      const kit = await import('./ui-kit.js'); const ic = __tf.imgclean; const o = {}; const asked = []; const real = window.confirm;
      window.confirm = (m) => { asked.push(m); return false; };
      o.small = kit.confirmHeavy(1000, 1000) === true; o.smallAsked = asked.length;
      o.big = kit.confirmHeavy(6000, 5000, 'The 4× model') === false; o.msg = asked[0] || '';
      const c = document.createElement('canvas'); c.width = c.height = 1600; c.getContext('2d').fillRect(0, 0, 1600, 1600);
      await window.api.writeFile(${J(path.join(work, 'Big.png'))}, new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer()));
      await ic.loadPath(${J(path.join(work, 'Big.png'))}); await ic.process();   // 1600 x 1600 x 16 = 41 megapixels from a 4x model
      o.declined = { asked: asked.length, cleaned: !!ic.cleaned, processOn: !document.querySelector('#icProcess').disabled, msg: document.querySelector('#icMsg').textContent.slice(0, 9) };
      window.confirm = real; return o;
    })()`);
    check('Upscale image: a run over 25 megapixels asks for confirmation first (declining does nothing), a normal one does not', heavy.small && heavy.smallAsked === 0 && heavy.big && /6000×5000/.test(heavy.msg) && /demanding/.test(heavy.msg) && heavy.declined.asked === 2 && !heavy.declined.cleaned && heavy.declined.processOn && heavy.declined.msg === 'Cancelled', J(heavy));
    const switched = await app.ev(`(async () => { await __tf.imgclean.open('clean'); const o = { mode: __tf.imgclean.mode, rowHidden: document.querySelector('#icScaleRow').hidden, models: [...document.querySelector('#icModel').options].map((x) => x.value) }; __tf.imgclean.close(); return o; })()`);
    check('Clean image mode after upscale lists only the 1x models and has no factor row', switched.mode === 'clean' && switched.rowHidden && switched.models.includes('1x_PureVision') && switched.models.every((m) => /^1x/.test(m)), J(switched));
  }

  // -- Remove background screen: the main window's cutout tools on a screen of their own (AI skipped without the RMBG model)
  {
    const srcP = path.join(work, 'Cutout me.png'), outP = path.join(work, 'Cutout me (cutout).png'), frameOutP = path.join(work, 'Cutout frame (cutout).png');
    fs.rmSync(outP, { force: true }); fs.rmSync(frameOutP, { force: true });
    const before = await app.ev(`JSON.stringify(__tf.items.map((i) => i.override))`);
    const r = await app.ev(`(async () => {
      const q = (x) => document.querySelector(x); const wait = (ms) => new Promise((res) => setTimeout(res, ms)); const bm = __tf.bgremove;
      const W = 200, H = 160, c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d'); const d = x.createImageData(W, H);
      for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) { const i = (y * W + xx) * 4; const disc = Math.hypot(xx - 100, y - 80) < 40; d.data[i] = disc ? 200 : 255; d.data[i + 1] = disc ? 40 : 255; d.data[i + 2] = disc ? 40 : 255; d.data[i + 3] = 255; }
      const k = (100 * 1 + 80 * W) * 4; d.data[k + 3] = 128;                       // one pixel that already is half transparent
      x.putImageData(d, 0, 0);
      await window.api.writeFile(${J(srcP)}, new Uint8Array(await (await new Promise((res) => c.toBlob(res, 'image/png'))).arrayBuffer()));
      const o = {};
      q('#btnTools').click(); await wait(80); q('#btnRemoveImage').click(); await wait(200);
      o.image = { open: !q('#bgremove').hidden, menuClosed: q('#toolsMenu').hidden, mode: bm.mode, title: q('#brTitle').textContent, button: q('#brSaveUse').textContent, saveOff: q('#brSave').disabled };
      await bm.loadPath(${J(srcP)}); await wait(200);
      const px = (cv, xx, y) => cv.getContext('2d').getImageData(xx, y, 1, 1).data;
      o.start = { alphaCorner: px(bm.result, 3, 3)[3], alphaKept: px(bm.result, 100, 80)[3], sameAsOriginal: JSON.stringify([...px(bm.result, 150, 20)]) === JSON.stringify([...px(bm.original, 150, 20)]), saveOn: !q('#brSave').disabled };
      bm.pushEdit({ type: 'wand', x: 2, y: 2, tol: 30, contiguous: true });
      o.wand = { corner: px(bm.result, 3, 3)[3], disc: px(bm.result, 70, 80)[3], kept: px(bm.result, 100, 80)[3], edits: bm.edits.length };
      // the same maths as the main window: buildEditedMask + applyRemovalMask on the original pixels with the same parameters
      const cr = await import('./lib/colorremoval.js'); const oc = bm.original, id = oc.getContext('2d').getImageData(0, 0, oc.width, oc.height);
      const { mask, color, fixed } = cr.buildEditedMask(id, bm.params, bm.edits, null); cr.applyRemovalMask(id, mask, color, bm.params.crFeather, bm.params.crGrow, bm.params.crDefringe, fixed);
      const t = document.createElement('canvas'); t.width = oc.width; t.height = oc.height; t.getContext('2d').putImageData(id, 0, 0);
      const want = t.getContext('2d').getImageData(0, 0, t.width, t.height).data, got = bm.result.getContext('2d').getImageData(0, 0, t.width, t.height).data;
      let diff = 0; for (let i = 0; i < want.length; i++) if (want[i] !== got[i]) diff++;
      o.sameMaths = diff;
      bm.undo(); o.undone = { corner: px(bm.result, 3, 3)[3], edits: bm.edits.length, redo: bm.redoCount };
      bm.redo(); o.redone = { corner: px(bm.result, 3, 3)[3], edits: bm.edits.length };
      bm.pushEdit({ type: 'rect', x0: 90, y0: 70, x1: 110, y1: 90 }); o.rect = { centre: px(bm.result, 100, 80)[3], edits: bm.edits.length };
      bm.pushEdit({ type: 'brush', mode: 'restore', r: 6, pts: [[100, 80], [105, 85]] }); o.restore = { centre: px(bm.result, 100, 80)[3] };
      // a real brush stroke through pointer events: erase a patch of the disc
      bm.setTool('brush'); bm.setParams({ brushSize: 20 });
      const a = bm.clientOf(60, 80), b = bm.clientOf(70, 80), cv = q('#brPreview');
      const ev = (type, p) => cv.dispatchEvent(new PointerEvent(type, { clientX: p.x, clientY: p.y, button: 0, pointerId: 7, bubbles: true }));
      ev('pointerdown', a); ev('pointermove', b); ev('pointerup', b);
      o.brush = { tool: bm.tool, hit: px(bm.result, 65, 80)[3], far: px(bm.result, 100, 105)[3], last: bm.edits[bm.edits.length - 1].type };
      // Esc with a tool in hand only puts the tool down; with none it closes the screen. W picks the wand
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(60);
      o.esc1 = { open: !q('#bgremove').hidden, tool: bm.tool };
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true })); await wait(60); o.keyW = bm.tool;
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); await wait(60); o.ctrlZ = bm.edits.length;
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(60);
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(60);
      o.esc2 = !q('#bgremove').hidden;
      return o;
    })()`);
    check('Remove background: opens from Tools in image mode, loads an image, keeps its own half-transparent pixel, save is off until there is an image', r.image.open && r.image.menuClosed && r.image.mode === 'image' && r.image.title === 'Remove image background' && r.image.button === 'Save and open as image' && r.image.saveOff && r.start.alphaCorner === 255 && r.start.alphaKept === 128 && r.start.sameAsOriginal && r.start.saveOn, J({ image: r.image, start: r.start }));
    check('Remove background: a wand edit clears the background but not the disc or the half-transparent pixel, and gives exactly the main window\'s maths (buildEditedMask + applyRemovalMask)', r.wand.corner === 0 && r.wand.disc === 255 && r.wand.kept === 128 && r.wand.edits === 1 && r.sameMaths === 0, J({ wand: r.wand, diff: r.sameMaths }));
    check('Remove background: undo and redo, rectangle erase, brush restore', r.undone.corner === 255 && r.undone.edits === 0 && r.undone.redo === 1 && r.redone.corner === 0 && r.redone.edits === 1 && r.rect.centre === 0 && r.rect.edits === 2 && r.restore.centre > 0, J({ undone: r.undone, redone: r.redone, rect: r.rect, restore: r.restore }));
    check('Remove background: a real brush stroke (pointer events) erases where it was drawn and records a brush edit', r.brush.tool === 'brush' && r.brush.hit === 0 && r.brush.far === 255 && r.brush.last === 'brush', J(r.brush));
    check('Remove background: Esc puts the tool down first (the screen stays), W picks the wand, Ctrl+Z undoes, a second Esc closes the screen', r.esc1.open && r.esc1.tool === null && r.keyW === 'wand' && r.ctrlZ === 3 && r.esc2 === false, J({ esc1: r.esc1, keyW: r.keyW, ctrlZ: r.ctrlZ, esc2: r.esc2 }));
    const mid = await app.ev(`JSON.stringify(__tf.items.map((i) => i.override))`);
    check('Remove background: the main window per-image edits were not touched by the screen edits', mid === before, J({ before: before.slice(0, 80), mid: mid.slice(0, 80) }));
    // save: a full-size PNG, then open it as the art image (image mode) or use it as the frame (frame mode)
    await app.ev(`(async () => { __tf.bgremove.open('image'); await new Promise((res) => setTimeout(res, 100)); })()`);
    const saved = await app.ev(`__tf.bgremove.saveAndUse(${J(outP)})`);
    const magic = fs.existsSync(outP) ? fs.readFileSync(outP).subarray(0, 4).toString('hex') : '';
    const after = await app.ev(`(async () => { const bm = await createImageBitmap(new Blob([await window.api.readFile(${J(outP)})])); const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height; const x = c.getContext('2d'); x.drawImage(bm, 0, 0);
      const a = (px, py) => x.getImageData(px, py, 1, 1).data[3]; return { w: bm.width, h: bm.height, corner: a(3, 3), items: __tf.items.length, path: __tf.items[0]?.path, closed: document.querySelector('#bgremove').hidden }; })()`);
    check('Remove background: Save and open as image writes the full-size PNG with transparency and opens it as the art image', magic === '89504e47' && saved.w === 200 && after.w === 200 && after.h === 160 && after.corner === 0 && after.items === 1 && after.path === outP && after.closed, J({ magic, saved: saved.w, after }));
    const cleanedP = path.join(work, 'Cutout frame (cleaned).png');
    fs.rmSync(cleanedP, { force: true });
    const fr = await app.ev(`(async () => { const wait = (ms) => new Promise((res) => setTimeout(res, ms)); const q = (x) => document.querySelector(x);
      q('#btnTools').click(); await wait(80); q('#btnRemoveFrame').click(); await wait(200);
      const bm = __tf.bgremove; const o = { title: q('#brTitle').textContent, button: q('#brSaveUse').textContent, mode: bm.mode, kept: !!bm.result };
      // frame cleaning is on by default in frame mode: the cutout is trimmed, refined and resized when saving; the Cleaned view shows the trimmed frame
      o.cleanOn = bm.params.cleanEnabled; o.cleanRows = [...document.querySelectorAll('#brControls .row')].filter((r) => r.style.display !== 'none').map((r) => r.querySelector('label')?.textContent || r.textContent).filter((t) => /Refine radius|Crop threshold|Clean the frame|^Size/.test(t));
      for (let i = 0; i < 80 && !bm.cleaned; i++) await wait(100);
      o.trimmed = bm.cleaned ? [bm.cleaned.width, bm.cleaned.height] : null; o.viewOpt = !q('#brView option[value=cleaned]').disabled;
      q('#brView').value = 'cleaned'; q('#brView').onchange({ target: q('#brView') }); await wait(100); o.badge = q('#brBadge').textContent;
      const cl = await bm.saveTo(${J(cleanedP)}); o.cleanSaved = [cl.w, cl.h];
      // switched off: the plain cutout is saved at its own size, the cleaned view and the Clean frame controls go away
      bm.setParams({ cleanEnabled: false }); await wait(100);
      o.off = { view: q('#brView').value, opt: q('#brView option[value=cleaned]').disabled, rows: [...document.querySelectorAll('#brControls .row')].filter((r) => r.style.display !== 'none' && /Refine radius|Crop threshold|Size \(px\)/.test(r.textContent)).length, cleaned: !!bm.cleaned };
      const r = await bm.saveAndUse(${J(frameOutP)}); o.w = r.w; o.frame = __tf.frame.path; o.closed = q('#bgremove').hidden; return o; })()`);
    check('Remove background: the frame entry reopens the same image with a frame title and Save and use as frame, which loads the PNG as the frame', fr.title === 'Remove frame background' && fr.button === 'Save and use as frame' && fr.mode === 'frame' && fr.kept && fr.w === 200 && fr.frame === frameOutP && fr.closed, J(fr));
    check('Remove background: frame cleaning is on by default (Clean frame controls shown, trimmed Cleaned view, saved trimmed and resized to the output size) and can be switched off entirely', fr.cleanOn === true && fr.cleanRows.length >= 4 && fr.trimmed && fr.trimmed[0] < 200 && fr.viewOpt && fr.badge.startsWith('Cleaned frame') && J(fr.cleanSaved) === J([1000, 1000]) && fr.off.view === 'cutout' && fr.off.opt && fr.off.rows === 0 && fr.off.cleaned === false, J(fr));
    // the pixel pen: a brush under 3 px paints exactly the pixels under the pointer (no half-pixel offset, no disc rounding), joined by a gapless line
    const pen = await app.ev(`(async () => {
      const cr = await import('./lib/colorremoval.js'); const o = {};
      o.size = [cr.penSize(1), cr.penSize(2), cr.penSize(2.9), cr.penSize(3), cr.penSize(3.4), cr.penSize(4), cr.penSize(40)];
      o.anchor = [cr.penAnchor(10.7, 5.2, 1), cr.penAnchor(10.4, 5.6, 2), cr.penAnchor(10.7, 5.2, 3)];
      const W = 24, H = 16, m = new Uint8Array(W * H); cr.stampPixelStroke(m, W, H, [[2, 2], [10, 5]], 1, 1);
      const on = []; for (let i = 0; i < m.length; i++) if (m[i]) on.push([i % W, (i / W) | 0]);
      o.line = { n: on.length, ends: m[2 * W + 2] === 1 && m[5 * W + 10] === 1, connected: on.every(([x, y]) => on.some(([a, b]) => (a !== x || b !== y) && Math.abs(a - x) <= 1 && Math.abs(b - y) <= 1)) };
      const b = new Uint8Array(W * H); cr.stampPixelStroke(b, W, H, [[3, 3]], 2, 1); o.block = [...b].reduce((n, v) => n + v, 0) === 4 && b[3 * W + 3] && b[4 * W + 4] && !b[5 * W + 5];
      const b3 = new Uint8Array(W * H); cr.stampPixelStroke(b3, W, H, [[3, 3]], 3, 1); o.block3 = [...b3].reduce((n, v) => n + v, 0) === 9 && b3[3 * W + 3] && b3[5 * W + 5] && b3[3 * W + 5] && b3[5 * W + 3] && !b3[6 * W + 6] && !b3[2 * W + 2];
      const c = new Uint8Array(W * H); cr.stampPixelStroke(c, W, H, [[-1, -1], [W - 1, H - 1]], 2, 1); o.clipped = true;
      // on the screen: a size 1 stroke from the centre of pixel (50,40) to the centre of pixel (54,40) paints exactly those five pixels
      const bm = __tf.bgremove; const q = (x) => document.querySelector(x); const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      bm.open('image'); await wait(100); await bm.loadPath(${J(path.join(work, 'Cutout me.png'))}); await wait(200);
      const px = (xx, y) => bm.result.getContext('2d').getImageData(xx, y, 1, 1).data[3];
      bm.setTool('brush'); bm.setParams({ brushSize: 1, brushMode: 'erase' });
      const cv = q('#brPreview'), ev = (type, p) => cv.dispatchEvent(new PointerEvent(type, { clientX: p.x, clientY: p.y, button: 0, pointerId: 9, bubbles: true }));
      const a = bm.clientOf(50.5, 40.5), z = bm.clientOf(54.5, 40.5);
      ev('pointermove', a); o.ringPen = q('.brRing').classList.contains('pen'); ev('pointerdown', a); ev('pointermove', z); ev('pointerup', z);
      const e1 = bm.edits[bm.edits.length - 1];
      o.size1 = { edit: { px: e1.px, pts: e1.pts.length, first: e1.pts[0], last: e1.pts[e1.pts.length - 1] }, hit: [50, 51, 52, 53, 54].map((xx) => px(xx, 40)), around: [px(49, 40), px(55, 40), px(52, 39), px(52, 41)] };
      // size 2 at a pixel corner: the 2x2 block around it
      bm.setParams({ brushSize: 2 }); const k = bm.clientOf(100, 80); ev('pointerdown', k); ev('pointerup', k);
      o.size2 = { px: bm.edits[bm.edits.length - 1].px, hit: [[99, 79], [100, 79], [99, 80], [100, 80]].map(([xx, y]) => px(xx, y)), around: [px(98, 79), px(101, 80), px(99, 78), px(100, 81)] };
      // restore with size 1 brings back just that pixel
      bm.setParams({ brushSize: 1, brushMode: 'restore' }); const r1 = bm.clientOf(52.5, 40.5); ev('pointerdown', r1); ev('pointerup', r1);
      o.restore = [px(51, 40), px(52, 40), px(53, 40)];
      // the same bytes as the main window's maths
      const oc = bm.original, id = oc.getContext('2d').getImageData(0, 0, oc.width, oc.height);
      const { mask, color, fixed } = cr.buildEditedMask(id, bm.params, bm.edits, null); cr.applyRemovalMask(id, mask, color, bm.params.crFeather, bm.params.crGrow, bm.params.crDefringe, fixed);
      const t = document.createElement('canvas'); t.width = oc.width; t.height = oc.height; t.getContext('2d').putImageData(id, 0, 0);
      const want = t.getContext('2d').getImageData(0, 0, t.width, t.height).data, got = bm.result.getContext('2d').getImageData(0, 0, t.width, t.height).data;
      o.diff = 0; for (let i = 0; i < want.length; i++) if (want[i] !== got[i]) o.diff++;
      bm.setTool('brush'); bm.close();
      return o;
    })()`);
    check('Pixel pen: sizes 1 to 3 switch to pixel mode, the anchor is the pixel under the pointer (3 is centred on it), strokes are gapless Bresenham lines, 2 and 3 px pens are exact blocks', J(pen.size) === J([1, 2, 3, 3, 3, 0, 0]) && J(pen.anchor) === J([[10, 5], [9, 5], [9, 4]]) && pen.line.n === 9 && pen.line.ends && pen.line.connected && pen.block && pen.block3, J({ size: pen.size, anchor: pen.anchor, line: pen.line, block: pen.block }));
    check('Pixel pen on the screen: a size-1 stroke paints exactly the pixels under the pointer (nothing around them), the ring is a pixel square, size 2 paints a 2x2 block, restore brings back one pixel, same bytes as the shared maths', pen.ringPen && pen.size1.edit.px === 1 && pen.size1.edit.pts === 5 && J(pen.size1.edit.first) === J([50, 40]) && J(pen.size1.edit.last) === J([54, 40]) && J(pen.size1.hit) === J([0, 0, 0, 0, 0]) && J(pen.size1.around) === J([255, 255, 255, 255]) && pen.size2.px === 2 && J(pen.size2.hit) === J([0, 0, 0, 0]) && J(pen.size2.around) === J([255, 255, 255, 255]) && J(pen.restore) === J([0, 255, 0]) && pen.diff === 0, J(pen));
    // the main window's brush has the same pixel pen
    const mainPen = await app.ev(`(async () => {
      const T = __tf, wait = (ms) => new Promise((res) => setTimeout(res, ms)); const v = document.querySelector('#view'); const o = {};
      T.shared.brushSize = 1; T.shared.brushMode = 'erase'; T.setTool('brush');
      const ev = (type, p) => v.dispatchEvent(new PointerEvent(type, { clientX: p.x, clientY: p.y, button: 0, pointerId: 11, bubbles: true }));
      const a = T.clientOfSrc(100.5, 100.5), z = T.clientOfSrc(104.5, 100.5);
      ev('pointermove', a); o.ring = document.querySelector('#brushRing').classList.contains('pen'); ev('pointerdown', a); ev('pointermove', z); ev('pointerup', z); await wait(300);
      const e = T.items[T.cur].override.popEdits.at(-1); o.edit = { px: e.px, first: e.pts[0], last: e.pts[e.pts.length - 1] };
      const cut = T.buildCut(T.base.bitmap, T.eff()); const al = (x, y) => cut.canvas.getContext('2d').getImageData(x, y, 1, 1).data[3];
      o.hit = [100, 101, 102, 103, 104].map((x) => al(x, 100)); o.around = [al(99, 100), al(105, 100), al(102, 99), al(102, 101)];
      T.undo(); T.setTool('brush'); T.shared.brushSize = 40; await wait(100);
      return o;
    })()`);
    check('Pixel pen in the main window: a size-1 brush stroke paints exactly the pixels under the pointer and the ring is a pixel square', mainPen.ring && mainPen.edit.px === 1 && J(mainPen.edit.first) === J([100, 100]) && J(mainPen.edit.last) === J([104, 100]) && J(mainPen.hit) === J([0, 0, 0, 0, 0]) && J(mainPen.around) === J([255, 255, 255, 255]), J(mainPen));
    // REAL mouse input (DevTools Input events, not synthetic DOM events), against an image with one magenta marker pixel: at every zoom level the click must land on exactly that
    // pixel, size 2 and 3 pens must erase exact 2x2 / 3x3 blocks, and what is DRAWN must match (the canvas is sized to the device pixels, so nothing is resampled)
    {
      const MW = 1200, MH = 900, MX = 600, MY = 450, markP = path.join(work, 'Marker.png');
      await app.ev(`(async () => { const c = document.createElement('canvas'); c.width = ${MW}; c.height = ${MH}; const x = c.getContext('2d'); const d = x.createImageData(${MW}, ${MH});
        for (let i = 0; i < ${MW} * ${MH}; i++) { d.data[i * 4] = 90 + (i % 13) * 4; d.data[i * 4 + 1] = 160; d.data[i * 4 + 2] = 90; d.data[i * 4 + 3] = 255; }
        const m = (${MY} * ${MW} + ${MX}) * 4; d.data[m] = 255; d.data[m + 1] = 0; d.data[m + 2] = 255; x.putImageData(d, 0, 0);
        await window.api.writeFile(${J(markP)}, new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer()));
        document.querySelector('#btnTools').click(); await new Promise((r) => setTimeout(r, 100)); document.querySelector('#btnRemoveImage').click(); await new Promise((r) => setTimeout(r, 300));
        await __tf.bgremove.loadPath(${J(markP)}); await new Promise((r) => setTimeout(r, 300)); })()`);
      const mouse = (type, x, y, extra = {}) => app.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
      const readGeo = () => app.ev(`(() => { const c = document.querySelector('#brPreview'), r = c.getBoundingClientRect(); return { l: r.left + c.clientLeft, t: r.top + c.clientTop, w: r.width - 2 * c.clientLeft, backing: c.width, dpr: devicePixelRatio }; })()`);
      let geo = await readGeo();
      for (let i = 0; i < 40 && geo.backing !== Math.round(geo.w * geo.dpr); i++) { await sleep(100); geo = await readGeo(); }   // the canvas is sized after layout settles; a busy machine can take a moment
      const rows = [];
      for (const size of [1, 2, 3]) {
        await app.ev(`(__tf.bgremove.setParams({ brushSize: ${size}, brushMode: 'erase' }), __tf.bgremove.tool || __tf.bgremove.setTool('brush'), document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true })), 1)`);
        await sleep(100);
        for (let step = 0; step <= 12; step++) {
          if (step > 0) { await app.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: geo.l + geo.w / 2, y: geo.t + geo.w / 2, deltaX: 0, deltaY: -100 }); await sleep(40); }
          await app.ev(`__tf.bgremove.resetEdits(false)`);
          const find = await app.ev(`(() => {
            const c = document.querySelector('#brPreview'), g = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
            for (let i = 0; i < g.length; i += 4) if (g[i] > 240 && g[i + 1] < 20 && g[i + 2] > 240 && g[i + 3] > 200) { const p = i / 4; x0 = Math.min(x0, p % c.width); x1 = Math.max(x1, p % c.width); y0 = Math.min(y0, (p / c.width) | 0); y1 = Math.max(y1, (p / c.width) | 0); }
            const r = c.getBoundingClientRect(), k = (r.width - 2 * c.clientLeft) / c.width;
            return x1 < 0 ? null : { w: x1 - x0 + 1, cx: r.left + c.clientLeft + (x0 + (x1 - x0 + 1) / 2) * k, cy: r.top + c.clientTop + (y0 + (y1 - y0 + 1) / 2) * k };
          })()`);
          if (!find || find.w < 2) continue;                    // not enlarged enough yet to see the pixel as a block
          await mouse('mouseMoved', find.cx, find.cy, { buttons: 0 }); await mouse('mousePressed', find.cx, find.cy); await mouse('mouseReleased', find.cx, find.cy); await sleep(100);
          const r = await app.ev(`(() => {
            const bm = __tf.bgremove, res = bm.result, g = res.getContext('2d').getImageData(0, 0, res.width, res.height).data; const hits = [];
            for (let y = ${MY} - 3; y <= ${MY} + 3; y++) for (let x = ${MX} - 3; x <= ${MX} + 3; x++) if (g[(y * res.width + x) * 4 + 3] === 0) hits.push([x - ${MX}, y - ${MY}]);
            const c = document.querySelector('#brPreview'), cg = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, br = c.getBoundingClientRect(), k = c.width / (br.width - 2 * c.clientLeft), bl = br.left + c.clientLeft, bt = br.top + c.clientTop;
            const drawn = hits.map(([dx, dy]) => { const lt = bm.clientOf(${MX} + dx, ${MY} + dy), rb = bm.clientOf(${MX} + dx + 1, ${MY} + dy + 1); let clear = 0, total = 0;
              for (let yy = Math.round((lt.y - bt) * k); yy < Math.round((rb.y - bt) * k); yy++) for (let xx = Math.round((lt.x - bl) * k); xx < Math.round((rb.x - bl) * k); xx++) { total++; if (cg[(yy * c.width + xx) * 4 + 3] === 0) clear++; } return clear === total && total > 0; });
            return { px: bm.edits.at(-1)?.px, hits, drawn: drawn.every(Boolean) };
          })()`);
          const exact = size === 1 ? r.hits.length === 1 && r.hits[0][0] === 0 && r.hits[0][1] === 0
            : size === 2 ? r.hits.length === 4 && r.hits.some(([a, b]) => a === 0 && b === 0)       // dead centre of a pixel ties between two corners: any 2x2 block covering it is right
            : r.hits.length === 9 && r.hits.every(([a, b]) => Math.abs(a) <= 1 && Math.abs(b) <= 1);
          rows.push({ size, step, ok: exact && r.px === size && r.drawn });
        }
      }
      const bad = rows.filter((r) => !r.ok);
      check('Pixel pen with real mouse input: at every zoom level a click erases exactly the pixel under the pointer (1 px), a 2x2 or a centred 3x3 block, and the canvas shows exactly that', rows.length >= 18 && bad.length === 0 && geo.backing === Math.round(geo.w * geo.dpr), J({ clicks: rows.length, bad: bad.slice(0, 4), backing: geo.backing, shown: +(geo.w * geo.dpr).toFixed(2) }));
      await app.ev(`__tf.bgremove.close()`);
    }
    // the main window renders its preview larger when zoomed, so a zoomed-in source pixel is real detail, and goes back to 800 px at 1x
    {
      const zoomed = await app.ev(`(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); const v = document.querySelector('#view'); const o = { start: __tf.prevBuf.width };
        for (let i = 0; i < 10; i++) v.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: v.getBoundingClientRect().left + 300, clientY: v.getBoundingClientRect().top + 300, bubbles: true, cancelable: true })); await wait(700);
        o.zoom = +__tf.view.z.toFixed(2); o.zoomed = __tf.prevBuf.width;
        v.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await wait(700); o.back = __tf.prevBuf.width; return o; })()`);
      check('Main window: the preview is rendered larger while zoomed in (up to 4096 px) and back at 800 px at 1x', zoomed.start === 800 && zoomed.zoom > 2 && zoomed.zoomed > 800 && zoomed.zoomed <= 4096 && zoomed.back === 800, J(zoomed));
    }
    // the main window with REAL mouse input: zoom goes to 20x, and at high zoom with a 1 px pen the pixel SHOWN under the pointer is the pixel erased, right up to
    // its drawn edges (just outside erases the neighbour); a slightly shaky click stays one pixel; the square frames exactly the drawn pixel
    {
      const MW = 1200, MY = 450, MX = 600, markP = path.join(work, 'Marker.png');
      await app.ev(`(async () => { await __tf.openImages([${J(markP)}]); await new Promise((r) => setTimeout(r, 1200)); __tf.ui.showCutout = true; __tf.shared.brushSize = 1; __tf.shared.brushMode = 'erase'; if (__tf.tool !== 'brush') __tf.setTool('brush'); return 1; })()`);   // the art alone, so the frame cannot cover the marker
      const vr = await app.ev(`__tf.clientOfSrc(${MX} + 0.5, ${MY} + 0.5)`);   // zoom in on the marker itself
      const mouse = (type, x, y, extra = {}) => app.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
      const undoAll = () => app.ev(`(() => { while (__tf.items[__tf.cur].override.popEdits?.length) __tf.undo(); return 1; })()`);
      const last = () => app.ev(`(() => { const e = __tf.items[__tf.cur].override.popEdits?.at(-1); return e ? e.pts : null; })()`);
      await mouse('mouseMoved', vr.x, vr.y, { buttons: 0 });
      const rows = [];
      for (let step = 1; step <= 26; step++) {
        await app.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vr.x, y: vr.y, deltaX: 0, deltaY: -100 }); await sleep(250);
        if (step !== 16 && step !== 26) continue;
        await undoAll(); await sleep(350);
        const blk = await app.ev(`(() => {
          const c = document.querySelector('#preview'), g = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
          for (let i = 0; i < g.length; i += 4) if (g[i] > 240 && g[i + 1] < 20 && g[i + 2] > 240) { const p = i / 4; x0 = Math.min(x0, p % c.width); x1 = Math.max(x1, p % c.width); y0 = Math.min(y0, (p / c.width) | 0); y1 = Math.max(y1, (p / c.width) | 0); }
          const r = c.getBoundingClientRect(), k = r.width / c.width;
          return x1 < 0 ? null : { z: __tf.view.z, l: r.left + x0 * k, t: r.top + y0 * k, w: (x1 - x0 + 1) * k, h: (y1 - y0 + 1) * k };
        })()`);
        if (!blk) { rows.push({ step, found: false }); continue; }
        await mouse('mouseMoved', blk.l + blk.w / 2, blk.t + blk.h / 2, { buttons: 0 }); await sleep(40);
        const ring = await app.ev(`(() => { const r = document.querySelector('#brushRing').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
        const probes = [[blk.l + 0.6, blk.t + 0.6, [MX, MY]], [blk.l + blk.w - 0.6, blk.t + blk.h - 0.6, [MX, MY]], [blk.l - 0.6, blk.t + blk.h / 2, [MX - 1, MY]], [blk.l + blk.w + 0.6, blk.t + blk.h / 2, [MX + 1, MY]], [blk.l + blk.w / 2, blk.t - 0.6, [MX, MY - 1]]];
        const got = [];
        for (const [x, y] of probes) { await mouse('mouseMoved', x, y, { buttons: 0 }); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(50); got.push(await last()); await undoAll(); }
        const mx = blk.l + blk.w / 2, my = blk.t + blk.h / 2;
        await mouse('mouseMoved', mx, my, { buttons: 0 }); await mouse('mousePressed', mx, my); await mouse('mouseMoved', mx + 2, my + 1.5); await mouse('mouseMoved', mx - 1.5, my + 2); await mouse('mouseReleased', mx - 1.5, my + 2); await sleep(60);
        const shaky = await last(); await undoAll();
        rows.push({ step, z: +blk.z.toFixed(2), probes: probes.every(([, , want], i) => got[i] && got[i].length === 1 && got[i][0][0] === want[0] && got[i][0][1] === want[1]), got, shaky, ring: Math.abs(ring.l - blk.l) < 1.01 && Math.abs(ring.t - blk.t) < 1.01 && Math.abs(ring.w - blk.w) < 1.51 });
      }
      // still at 20x: a staircase drag (right, down, right, down...) erases a clean 1 px diagonal here too (pixel-perfect)
      {
        const at = (x, y) => app.ev(`__tf.clientOfSrc(${x}, ${y})`);
        const p0 = await at(MX - 4 + 0.5, MY - 4 + 0.5);
        await mouse('mouseMoved', p0.x, p0.y, { buttons: 0 }); await mouse('mousePressed', p0.x, p0.y);
        for (let i = 0; i < 6; i++) { const a = await at(MX - 3 + i + 0.5, MY - 4 + i + 0.5), b = await at(MX - 3 + i + 0.5, MY - 3 + i + 0.5); await mouse('mouseMoved', a.x, a.y); await mouse('mouseMoved', b.x, b.y); }
        const e = await at(MX + 2.5, MY + 2.5); await mouse('mouseReleased', e.x, e.y); await sleep(200);
        const pts = await last(); await undoAll();
        rows.push({ diagonal: J(pts) === J(Array.from({ length: 7 }, (_, i) => [MX - 4 + i, MY - 4 + i])), pts });
      }
      await app.ev(`(() => { document.querySelector('#view').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); __tf.setTool('brush'); __tf.shared.brushSize = 40; __tf.ui.showCutout = false; return 1; })()`);
      const ok = rows.length === 3 && rows.slice(0, 2).every((r) => r.probes && r.ring && r.shaky && r.shaky.length === 1 && r.shaky[0][0] === MX && r.shaky[0][1] === MY) && rows[1].z > 15 && rows[2].diagonal;   // the top zoom step is snapped to whole device pixels per source pixel with the pen in hand (just under 20x)
      check('Main window pen with real mouse input: zoom reaches 20x; at high zoom the pixel shown under the pointer is the one erased up to its edges (just outside takes the neighbour), a shaky click is one pixel, the square frames the drawn pixel, a staircase drag is a clean diagonal', ok, J(rows));
    }
    // pixel-perfect 1 px pen: a hand-drawn diagonal passes through side neighbours at every corner (an L, which reads as a 2 px thick line); those corner pixels are dropped
    {
      const pp = await app.ev(`(async () => {
        const cr = await import('./lib/colorremoval.js'); const o = {};
        const run = (pts) => { const path = []; for (const t of pts) cr.penPathAdd(path, t); return path; };
        o.stairs = run([[0, 0], [1, 0], [1, 1], [2, 1], [2, 2], [3, 2], [3, 3]]);
        o.straight = run([[0, 0], [6, 0]]);
        o.shallow = run([[0, 0], [3, 1]]);
        const W = 12, m = new Uint8Array(W * W); cr.stampPixelStroke(m, W, W, o.stairs, 1, 1); o.replay = [...m].reduce((n, v) => n + v, 0);
        return o; })()`);
      check('Pixel-perfect pen: an L-stepped diagonal becomes a clean 1 px diagonal, straight and shallow lines keep every pixel, and replaying the path draws exactly it', J(pp.stairs) === J([[0, 0], [1, 1], [2, 2], [3, 3]]) && pp.straight.length === 7 && J(pp.shallow) === J([[0, 0], [1, 0], [2, 1], [3, 1]]) && pp.replay === 4, J(pp));
      // with a REAL mouse on the Remove background screen: a diagonal drag that goes round every pixel corner erases a clean diagonal, nothing beside it
      await app.ev(`(async () => { __tf.bgremove.open('image'); await new Promise((r) => setTimeout(r, 200)); await __tf.bgremove.loadPath(${J(path.join(work, 'Marker.png'))}); await new Promise((r) => setTimeout(r, 300));
        __tf.bgremove.setParams({ brushSize: 1, brushMode: 'erase' }); if (__tf.bgremove.tool !== 'brush') __tf.bgremove.setTool('brush'); return 1; })()`);
      const mouse = (type, x, y, extra = {}) => app.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
      const c0 = await app.ev(`__tf.bgremove.clientOf(300.5, 300.5)`);
      for (let i = 0; i < 10; i++) { await app.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c0.x, y: c0.y, deltaX: 0, deltaY: -100 }); await sleep(40); }
      const at = (x, y) => app.ev(`__tf.bgremove.clientOf(${x}, ${y})`);
      let p0 = await at(300.5, 300.5);
      await mouse('mouseMoved', p0.x, p0.y, { buttons: 0 }); await mouse('mousePressed', p0.x, p0.y);
      for (let i = 0; i < 8; i++) { const a = await at(301.5 + i, 300.5 + i), b = await at(301.5 + i, 301.5 + i); await mouse('mouseMoved', a.x, a.y); await mouse('mouseMoved', b.x, b.y); }   // right, then down: an L at every step
      const end = await at(308.5, 308.5); await mouse('mouseReleased', end.x, end.y); await sleep(150);
      const got = await app.ev(`(() => { const res = __tf.bgremove.result, g = res.getContext('2d').getImageData(295, 295, 20, 20).data, out = [];
        for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) if (g[(y * 20 + x) * 4 + 3] === 0) out.push([295 + x, 295 + y]); return out; })()`);
      const diag = Array.from({ length: 9 }, (_, i) => [300 + i, 300 + i]);
      check('Pixel-perfect pen with real mouse input: a diagonal drawn as a staircase of right/down moves erases exactly the 1 px diagonal', J(got) === J(diag), J(got));
      await app.ev(`(__tf.bgremove.setTool('brush'), __tf.bgremove.close(), 1)`);
    }
    // pen feedback and strokes with REAL mouse input: the square is drawn at its TRUE size and the native cursor is hidden over it, a zoomed-out pen says why it cannot hit each pixel,
    // the square stays on the pixel that will be painted while a click is still inside its dead zone, and a stroke ends where the button was let go (main window and Remove background screen)
    {
      const MX = 600, MY = 450, markP = path.join(work, 'Marker.png');
      const mouse = (type, x, y, extra = {}) => app.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
      const last = () => app.ev(`(() => { const e = __tf.items[__tf.cur].override.popEdits?.at(-1); return e ? e.pts : null; })()`);
      const undoAll = () => app.ev(`(() => { while (__tf.items[__tf.cur].override.popEdits?.length) __tf.undo(); return 1; })()`);
      const ringState = (sel, cur) => app.ev(`(() => { const r = document.querySelector('${sel}'), b = r.getBoundingClientRect(); return { w: parseFloat(r.style.width), left: b.left, pen: r.classList.contains('pen'), hidden: r.hidden, cursor: getComputedStyle(document.querySelector('${cur}')).cursor }; })()`);
      // ---- main window
      await app.ev(`(async () => { await __tf.openImages([${J(markP)}]); await new Promise((r) => setTimeout(r, 1200)); __tf.shared.brushSize = 1; __tf.shared.brushMode = 'erase'; if (__tf.tool !== 'brush') __tf.setTool('brush'); document.querySelector('#status').textContent = ''; return 1; })()`);
      const vr = await app.ev(`(() => { const r = document.querySelector('#view').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await mouse('mouseMoved', vr.x, vr.y, { buttons: 0 }); await sleep(100);
      const fit = { ...(await ringState('#brushRing', '#view')), status: await app.ev(`document.querySelector('#status').textContent`) };
      for (let i = 0; i < 24; i++) { await app.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vr.x, y: vr.y, deltaX: 0, deltaY: -100 }); await sleep(120); }
      await sleep(500);
      const at = (x, y) => app.ev(`__tf.clientOfSrc(${x}, ${y})`);
      const c0 = await at(MX, MY + 0.5), c1 = await at(MX + 1, MY + 0.5), pxCss = c1.x - c0.x;
      await mouse('mouseMoved', c0.x + pxCss / 2, c0.y, { buttons: 0 }); await sleep(100);
      const zoomed = await ringState('#brushRing', '#view');
      await app.ev(`(() => { __tf.setTool('wand'); return 1; })()`); await sleep(60);   // switching tool hides the square: the native cursor must be back at once
      const afterTool = await ringState('#brushRing', '#view');
      await app.ev(`(() => { __tf.setTool('brush'); return 1; })()`); await mouse('mouseMoved', c0.x + pxCss / 2 + 1, c0.y, { buttons: 0 }); await sleep(60);
      // dead zone: press just left of a pixel boundary, move 3 CSS px across it (under the 4 px dead zone): the square and the stroke both stay on the first pixel
      await undoAll(); await sleep(200);
      await mouse('mouseMoved', c1.x - 1, c1.y, { buttons: 0 }); await mouse('mousePressed', c1.x - 1, c1.y);
      await mouse('mouseMoved', c1.x + 2, c1.y); await sleep(100);
      const stuck = await ringState('#brushRing', '#view');
      await mouse('mouseReleased', c1.x + 2, c1.y); await sleep(100);
      const clickPts = await last(); await undoAll(); await sleep(200);
      // release endpoint: press on a pixel, drag past the dead zone, let go on a farther pixel WITHOUT a move event there
      const a = await at(MX + 0.5, MY + 0.5), m = await at(MX + 5.5, MY + 0.5), z = await at(MX + 9.5, MY + 0.5);
      await mouse('mouseMoved', a.x, a.y, { buttons: 0 }); await mouse('mousePressed', a.x, a.y);
      await mouse('mouseMoved', m.x, m.y); await mouse('mouseReleased', z.x, z.y); await sleep(150);
      const dragPts = await last(); await undoAll();
      await app.ev(`(() => { document.querySelector('#view').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); __tf.setTool('brush'); __tf.shared.brushSize = 40; return 1; })()`);
      const mainOk = afterTool.cursor !== 'none' && fit.pen && fit.w < 1.2 && fit.cursor === 'none' && /Zoomed out/.test(fit.status) && pxCss >= 6 && zoomed.pen && Math.abs(zoomed.w - pxCss) < 1.2 && zoomed.cursor === 'none'
        && Math.abs(stuck.left - c0.x) < 1.2 && clickPts && clickPts.length === 1 && clickPts[0][0] === MX && clickPts[0][1] === MY
        && dragPts && dragPts.length === 10 && dragPts[0][0] === MX && dragPts.at(-1)[0] === MX + 9 && dragPts.at(-1)[1] === MY;
      check('Pen feedback in the main window: the square is drawn at its true size, the native cursor is hidden over it, zooming out is called out, the square stays on the painted pixel during a click, and a stroke ends where the button was let go', mainOk, J({ fit, pxCss, zoomed, afterTool: afterTool.cursor, stuck: stuck.left - c0.x, clickPts, dragPts: dragPts && [dragPts.length, dragPts[0], dragPts.at(-1)] }));
      // ---- Remove background screen
      await app.ev(`(async () => { document.querySelector('#btnTools').click(); await new Promise((r) => setTimeout(r, 100)); document.querySelector('#btnRemoveImage').click(); await new Promise((r) => setTimeout(r, 300));
        await __tf.bgremove.loadPath(${J(markP)}); await new Promise((r) => setTimeout(r, 300)); __tf.bgremove.setParams({ brushSize: 1, brushMode: 'erase' }); if (__tf.bgremove.tool !== 'brush') __tf.bgremove.setTool('brush'); document.querySelector('#brMsg').textContent = ''; return 1; })()`);
      const bc = await app.ev(`(() => { const r = document.querySelector('#brPreview').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await mouse('mouseMoved', bc.x, bc.y, { buttons: 0 }); await sleep(100);
      const bfit = { ...(await ringState('.brRing', '#brPreview')), msg: await app.ev(`document.querySelector('#brMsg').textContent`) };
      for (let i = 0; i < 14; i++) { await app.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: bc.x, y: bc.y, deltaX: 0, deltaY: -100 }); await sleep(100); }
      await sleep(400);
      const bat = (x, y) => app.ev(`__tf.bgremove.clientOf(${x}, ${y})`);
      const b0 = await bat(MX + 0.5, MY + 0.5), bm = await bat(MX + 5.5, MY + 0.5), bz = await bat(MX + 9.5, MY + 0.5), bpx = (await bat(MX + 1, MY + 0.5)).x - (await bat(MX, MY + 0.5)).x;
      await mouse('mouseMoved', b0.x, b0.y, { buttons: 0 }); await mouse('mousePressed', b0.x, b0.y);
      await mouse('mouseMoved', bm.x, bm.y); await mouse('mouseReleased', bz.x, bz.y); await sleep(200);
      const row = await app.ev(`(() => { const g = __tf.bgremove.result.getContext('2d').getImageData(${MX - 2}, ${MY}, 16, 1).data, o = []; for (let i = 0; i < 16; i++) o.push(g[i * 4 + 3] === 0 ? 1 : 0); return o.join(''); })()`);
      await app.ev(`(__tf.bgremove.setTool('brush'), __tf.bgremove.close(), 1)`);
      check('Pen feedback in the Remove background screen: true-size square, native cursor hidden, zoomed-out message, and the stroke ends where the button was let go', bfit.pen && bfit.w < 1.2 && bfit.cursor === 'none' && /Zoomed out/.test(bfit.msg) && bpx >= 3 && row === '0011111111110000', J({ bfit, bpx, row }));
    }

    // the exact pen view's compositing: rendering only a window of the composite (every layer canvas window-sized and shifted) gives the same pixels as cropping
    // the full composite, with every layer kind on (custom mask, hole mask, tint, overlay, pop-out with its highlight, background colour), windows inside and across the edge
    {
      const cp = await app.ev(`(async () => {
        const C = await import('./lib/composite.js');
        const mk = (w, h, f) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); const d = x.createImageData(w, h);
          for (let y = 0; y < h; y++) for (let i = 0; i < w; i++) { const p = (y * w + i) * 4, v = f(i, y); d.data[p] = v[0]; d.data[p + 1] = v[1]; d.data[p + 2] = v[2]; d.data[p + 3] = v[3]; } x.putImageData(d, 0, 0); return c; };
        const R = (x, y) => Math.hypot(x - 128, y - 128);
        const base = mk(300, 200, (x, y) => [(x * 7) & 255, (y * 5) & 255, (x * y) & 255, 255]);
        const frame = mk(256, 256, (x, y) => [200, 150, 60, R(x, y) > 100 && R(x, y) < 124 ? 255 : 0]);
        const overlay = mk(256, 256, (x, y) => [x, y, 128, (x + y) % 64 < 32 ? 180 : 0]);
        const mask = mk(256, 256, (x, y) => { const v = R(x, y) < 100 ? 255 : R(x, y) < 120 ? 128 : 0; return [v, v, v, 255]; });
        const hole = mk(256, 256, (x, y) => [255, 255, 255, R(x, y) < 105 ? 255 : 0]);
        const cfg = { baseScale: 0.8, baseOffsetX: 13.3, baseOffsetY: -7.7, maskShape: 'circle', maskRadius: 0.95, frameScale: 1, frameOffsetX: 3, frameOffsetY: -2, frameTintColor: '#88aaff', overlayTintColor: '#ff8800',
          overlayOpacity: 0.7, frameOpacity: 0.9, bgEnabled: true, bgColor: '#203040', popOutEnabled: true, popOutDegrees: 120, popOutRotation: 10 };
        // 'plain' has no antialiased path (no shape clip, no wedge): it must match exactly; the others may differ by a few levels on the anti-aliased edge of a clip path
        const variants = { plain: [{}, { ...cfg, maskShape: 'none', popOutEnabled: false }], mask: [{ mask }, cfg], hole: [{ holeMask: hole }, { ...cfg, maskShape: 'hole' }], circle: [{}, cfg] };
        const out = [];
        for (const size of [1000, 999.37]) for (const [name, [extra, c]] of Object.entries(variants)) {
          const src = { base, popBase: base, frame, overlay, ...extra };
          const opts = { crisp: true, snapArt: true, highlightPopOut: true };
          const full = C.compositeImage(src, c, size, opts), fx = full.getContext('2d');
          for (const win of [{ x: 130, y: 270, w: 300, h: 300 }, { x: 850, y: -40, w: 300, h: 260 }]) {
            const a = fx.getImageData(win.x, win.y, win.w, win.h).data, b = C.compositeImage(src, c, size, { ...opts, view: win }).getContext('2d').getImageData(0, 0, win.w, win.h).data;
            let max = 0, over1 = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > max) max = d; if (d > 1) over1++; }
            out.push({ size, name, x: win.x, max, over1, n: a.length });
          }
        }
        return out;
      })()`);
      check('Exact pen view compositing: a window of the composite equals the same crop of the full composite (mask, hole, tint, overlay, pop-out, background; whole and fractional sizes; a window across the edge)', cp.length === 16 && cp.every((r) => (r.name === 'plain' ? r.max <= 2 && r.over1 <= 2 : r.max <= 8 && r.over1 <= r.n * 0.001)), J(cp));
    }

    // the exact pen view in the main window: with the pen in hand the zoom steps through whole numbers of device pixels per source pixel, and EVERY source pixel is then
    // drawn as an identical k x k block (measured as runs of equal colour in #preview's own pixels), at several zoom steps and pan offsets
    {
      const markP = path.join(work, 'Marker.png');
      // (the default frame, open in the middle: a frame an earlier check left loaded may cover the art there)
      const prevFrame = await app.ev(`__tf.frame.path`);
      await app.ev(`(async () => { await __tf.loadFrame(await window.api.defaultFramePath()); await __tf.openImages([${J(markP)}]); await new Promise((r) => setTimeout(r, 1200)); __tf.shared.brushSize = 1; __tf.shared.brushMode = 'erase'; if (__tf.tool !== 'brush') __tf.setTool('brush'); return 1; })()`);
      const vr = await app.ev(`(() => { const r = document.querySelector('#view').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vr.x, y: vr.y, buttons: 0 });
      const measure = () => app.ev(`(() => { const c = document.querySelector('#preview'), W = c.width, H = c.height, g = c.getContext('2d').getImageData(0, 0, W, H).data;
        const px = (x, y) => { const i = (y * W + x) * 4; return (g[i] << 16) | (g[i + 1] << 8) | g[i + 2]; };
        const runs = (get, n) => { const o = []; let len = 1; for (let i = 1; i < n; i++) { if (get(i) === get(i - 1)) len++; else { o.push(len); len = 1; } } o.push(len); return o.slice(1, -1); };
        const set = (a) => [...new Set(a)].sort((p, q) => p - q);
        const rows = [], cols = [];
        for (const f of [0.3, 0.5, 0.7]) { rows.push(...runs((x) => px(x, Math.floor(H * f)), W)); cols.push(...runs((y) => px(Math.floor(W * f), y), H)); }
        return { k: __tf.penK(), z: +__tf.view.z.toFixed(3), W, dpr: devicePixelRatio, rows: set(rows), cols: set(cols), exact: __tf.exact, tool: __tf.tool, bs: __tf.eff().brushSize, cut: __tf.ui.showCutout, pv: __tf.ui.pixelView, over: Object.keys(__tf.items[__tf.cur].override) };
      })()`);
      const pan = async (dx, dy) => {
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vr.x, y: vr.y, button: 'middle', buttons: 4, clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vr.x + dx / 2, y: vr.y + dy / 2, button: 'middle', buttons: 4 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vr.x + dx, y: vr.y + dy, button: 'middle', buttons: 4 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vr.x + dx, y: vr.y + dy, button: 'middle', buttons: 0, clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vr.x, y: vr.y, buttons: 0 });
      };
      // no flash of empty edges: after a zoom-out notch (and a pan) the new window is already rendered by the next animation frame, i.e. before anything is painted
      const flash = await app.ev(`(async () => { const v = document.querySelector('#view'), r = v.getBoundingClientRect(), o = [];
        const fits = () => { const f = __tf.prevFor, z = __tf.view; return !!f && f.x === z.x && f.y === z.y && f.z === z.z; };
        for (const dy of [-100, -100, -100, 100, -100]) {
          v.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
          o.push(await new Promise((res) => requestAnimationFrame(() => res({ k: __tf.penK(), fits: fits() }))));
        }
        return o; })()`);
      const got = [];
      for (const notches of [3, 4, 5]) {
        for (let i = 0; i < notches; i++) { await app.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vr.x, y: vr.y, deltaX: 0, deltaY: -100 }); await sleep(150); }
        await sleep(500);
        got.push(await measure());
        await pan(-37.3, -23.6); await sleep(500); got.push(await measure());
        await pan(51.1, 19.4); await sleep(500); got.push(await measure());
      }
      await app.ev(`(async () => { document.querySelector('#view').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); __tf.setTool('brush'); __tf.shared.brushSize = 40; await __tf.loadFrame(${J(prevFrame)}); return 1; })()`);
      const ks = [...new Set(got.map((m) => m.k))];
      check('Exact pen view: zooming in or out renders the new window before the next frame is painted (no flash of empty edges)', flash.every((f) => f.fits) && flash.some((f) => f.k > 0), J(flash));
      await app.ev(`(() => { document.querySelector('#view').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return 1; })()`); await sleep(400);
      check('Exact pen view: with the pen in hand every source pixel is an identical k x k block of screen pixels, at three zoom steps and several pan offsets', got.every((m) => m.k >= 1 && J(m.rows) === J([m.k]) && J(m.cols) === J([m.k])) && ks.length === 3, J(got));
    }

    const aiReady = await app.ev(`window.api.getAiStatus().then((s) => s.ready)`);
    if (!aiReady) console.log('SKIP  Remove background AI: the RMBG-2.0 model is not downloaded in the test profile');
    await app.ev(`__tf.loadFrame(${J(path.join(root, 'assets', 'default.webp'))}, { keepOrder: true })`);
    await app.ev(`__tf.openImages([${J(art)}])`); await sleep(600); // put the shared test art and frame back for the checks that follow
  }

  {
    // "Send to tool": the Image and Frame sections open each tool with the current file loaded
    const send = await app.ev(`(async () => {
      const q = (x) => document.querySelector(x); const wait = (ms) => new Promise((res) => setTimeout(res, ms)); const o = {};
      await __tf.openImages([${J(art)}]); await wait(800);
      const grid = (title) => [...document.querySelectorAll('#panel details')].find((d) => d.dataset.title === title);
      const btn = (title, text) => [...grid(title).querySelectorAll('button')].find((b) => b.textContent === text);
      o.image = [...grid('Image').querySelectorAll('.toolgrid button')].map((b) => b.textContent + (b.disabled ? '!' : ''));
      o.frame = [...grid('Frame').querySelectorAll('.toolgrid button')].map((b) => b.textContent + (b.disabled ? '!' : ''));
      const closeAll = () => { for (const id of ['#imgclean', '#extend', '#bgremove', '#cleaner']) q(id).hidden = true; };
      const art = ${J(path.basename(art))};
      const cases = [['Image', 'Upscale image', '#imgclean', '#icName', '#icTitle'], ['Image', 'Extend edges', '#extend', '#exName', null], ['Image', 'Clean image', '#imgclean', '#icName', '#icTitle']];
      o.sent = [];
      for (const [sec, text, screen, nameEl, titleEl] of cases) {
        closeAll(); btn(sec, text).click();
        for (let i = 0; i < 60 && !(q(nameEl).textContent === art); i++) await wait(100);
        o.sent.push({ text, open: !q(screen).hidden, name: q(nameEl).textContent, title: titleEl ? q(titleEl).textContent : null });
      }
      closeAll();
      // a frame goes to the frame tools
      const frameName = __tf.frame.name;
      o.frameSent = [];
      for (const [text, screen, nameEl] of [['Clean frame', '#cleaner', '#cfName']]) {
        closeAll(); btn('Frame', text).click();
        for (let i = 0; i < 60 && !(q(nameEl).textContent === frameName); i++) await wait(100);
        o.frameSent.push({ text, open: !q(screen).hidden, name: q(nameEl).textContent, expect: frameName });
      }
      closeAll(); o.art = art;
      return o;
    })()`);
    check('Send to tool: the Image section offers Upscale, Extend edges and Clean image, the Frame section Clean frame (no Solve, no Remove background: the main window has those); each opens its tool with the current file loaded', J(send.image) === J(['Upscale image', 'Extend edges', 'Clean image']) && J(send.frame) === J(['Clean frame']) && send.sent.every((s) => s.open && s.name === send.art) && /pscale/.test(send.sent[0].title) && /lean/.test(send.sent[2].title) && send.frameSent.every((s) => s.open && s.name.startsWith(s.expect)), J(send));

  }

  // -- Auto center anchors: top keeps the art's top edge fixed while Scale x changes, bottom keeps the bottom edge, centre the middle
  const anc = await app.ev(`(() => { const T = window.__tf; const base = { width: 300, height: 600 }; const cfg = T.eff();
    const edge = (a, m) => { const r = T.resolveCfg({ ...cfg, fitEnabled: true, fitAnchor: a, fitScale: m, fitOffsetX: 0, fitOffsetY: 0 }, base); const w = 512 * r.baseScale, h = w * 2; const y = 256 - w / 2 + r.baseOffsetY; return { top: y, bottom: y + h, mid: y + h / 2 }; };
    return { t1: edge('top', 1), t2: edge('top', 1.5), b1: edge('bottom', 1), b2: edge('bottom', 1.5), c1: edge('center', 1), c2: edge('center', 1.5) }; })()`);
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  check('anchor Top/Center/Bottom: the chosen edge stays fixed when Scale x changes, bottom anchor sits higher than top anchor, centre halfway',
    near(anc.t1.top, anc.t2.top) && near(anc.b1.bottom, anc.b2.bottom) && near(anc.c1.mid, anc.c2.mid) && anc.b1.bottom < anc.t1.bottom && near(anc.c1.mid, (anc.t1.mid + anc.b1.mid) / 2), J(anc));

  // -- PNG output: the Format select re-points the item, the saved file is a real PNG, switching back restores webp
  const fmtSet = (v) => app.ev(`(async () => { const sel = [...document.querySelectorAll('#panel select')].find((x) => [...x.options].some((o) => o.value === 'png')); sel.value = ${J(v)}; sel.dispatchEvent(new Event('change')); await new Promise((r) => setTimeout(r, 300)); return { out: __tf.items[__tf.cur].outPath, exists: __tf.items[__tf.cur].exists }; })()`);
  const dq = await app.ev('({ format: __tf.out.format, quality: __tf.out.quality, status: getComputedStyle(document.querySelector("#status"), "::before").content })');
  check('defaults: WebP format, quality 100%', dq.format === 'webp' && dq.quality === 1, J(dq));
  const sizes = await app.ev(`(async () => { const it = __tf.items[__tf.cur]; const q = __tf.out.quality; __tf.out.quality = 1; __tf.out.lossless = false;
    const lossy = (await __tf.renderItemBlob(it)).size; __tf.out.lossless = true; const lossless = (await __tf.renderItemBlob(it)).size; __tf.out.lossless = false; return { q, lossy, lossless }; })()`);
  check('quality 100% is lossy (99%), Lossless box gives the larger lossless file', sizes.q === 1 && sizes.lossy > 0 && sizes.lossless > sizes.lossy * 1.2, J(sizes));
  const toPng = await fmtSet('png');
  check('format PNG: output name switches to .png and existence is re-checked', toPng.out.endsWith('Test Knight Token.png') && toPng.exists === false, J(toPng));
  await app.ev('__tf.saveCurrent(false)');
  const pngPath = path.join(work, 'Test Knight Token.png');
  const magic = fs.existsSync(pngPath) ? fs.readFileSync(pngPath).subarray(0, 4).toString('hex') : '';
  check('Save token wrote a real PNG', magic === '89504e47', magic);
  const toWebp = await fmtSet('webp');
  check('format back to WebP: .webp name, existing token detected', toWebp.out.endsWith('Test Knight Token.webp') && toWebp.exists === true, J(toWebp));
  fs.rmSync(pngPath, { force: true });

  // -- cutout behaviour (pocket at the donut's centre)
  const wandC = await H(`(() => { const c = h.cut({ crEnabled: false, popEdits: [{ type: 'wand', x: 5, y: 5, tol: 20, contiguous: true }] }); return [h.alphaAt(c, 5, 5), h.alphaAt(c, 200, 150), h.alphaAt(c, 200, 70)]; })()`);
  check('wand (contiguous) removes the outside and keeps the enclosed pocket', wandC[0] === 0 && wandC[1] === 255 && wandC[2] === 255, J(wandC));
  const wandG = await H(`(() => { const c = h.cut({ crEnabled: false, popEdits: [{ type: 'wand', x: 5, y: 5, tol: 20, contiguous: false }] }); return [h.alphaAt(c, 5, 5), h.alphaAt(c, 200, 150), h.alphaAt(c, 200, 70)]; })()`);
  check('wand (global) also removes the pocket', wandG[0] === 0 && wandG[1] === 0 && wandG[2] === 255, J(wandG));
  const px1 = await H(`(() => { const c = h.cut({ crEnabled: false, popEdits: [{ type: 'brush', mode: 'erase', r: 0.5, pts: [[120, 90]] }] }); return h.alphaCount(c, 100, 70, 140, 110); })()`);
  check('1px brush erases exactly one pixel', px1 === 1, `${px1} px`);
  const rest = await H(`(() => { const c = h.cut({ crEnabled: false, popEdits: [{ type: 'rect', x0: 100, y0: 100, x1: 110, y1: 110 }, { type: 'brush', mode: 'restore', r: 0.5, pts: [[105, 105]] }] }); return [h.alphaAt(c, 105, 105), h.alphaAt(c, 106, 105)]; })()`);
  check('brush restore brings back a single erased pixel', rest[0] === 255 && rest[1] === 0, J(rest));

  // -- undo / redo
  const ur = await app.ev(`(() => { const T = __tf; T.pushEdit({ type: 'rect', x0: 1, y0: 1, x1: 9, y1: 9 }); T.pushEdit({ type: 'rect', x0: 20, y0: 20, x1: 29, y1: 29 });
    const n2 = T.items[0].override.popEdits.length; T.undo(); const n1 = T.items[0].override.popEdits.length; T.redo(); const n2b = T.items[0].override.popEdits.length;
    T.undo(); T.undo(); const none = T.items[0].override.popEdits === undefined; return [n2, n1, n2b, none]; })()`);
  check('undo / redo / undo-to-empty', J(ur) === J([2, 1, 2, true]), J(ur));

  // -- per-image edits persist across a restart
  await app.ev(`(__tf.pushEdit({ type: 'wand', x: 5, y: 5, tol: 20, contiguous: true }), __tf.items[0].override.fitScale = 1.1, 1)`);
  await app.ev('__tf.flushEdits()');
  app.close();
  await sleep(800);
  await app.launch();
  await app.ev(`__tf.openImages([${J(art)}])`);
  await app.ev(WAIT_BASE);
  const back = await app.ev('({ edits: __tf.items[0].override.popEdits, fit: __tf.items[0].override.fitScale })');
  check('manual edits and overrides survive a restart', back.edits?.length === 1 && back.edits[0].type === 'wand' && back.fit === 1.1, J(back));

  // -- edits are dropped when the file's size changed (pixel coordinates no longer line up)
  await app.ev('__tf.flushEdits()');
  app.close();
  await sleep(800);
  const editsFile = path.join(userData, 'edits.json');
  const edits = JSON.parse(fs.readFileSync(editsFile, 'utf8'));
  edits[Object.keys(edits)[0]].w = 123; // pretend it was saved for a different-size image
  fs.writeFileSync(editsFile, J(edits));
  await app.launch();
  await app.ev(`__tf.openImages([${J(art)}])`);
  await app.ev(WAIT_BASE);
  const dropped = await app.ev('({ edits: __tf.items[0].override.popEdits, fit: __tf.items[0].override.fitScale })');
  check('popEdits dropped on image size change, other overrides kept', dropped.edits === undefined && dropped.fit === 1.1, J(dropped));

  // -- folder mode: frame pick and skip rules
  const folder = path.join(scratch, 'Folder & Frames ’x’');
  fs.mkdirSync(folder);
  for (const n of ['Framed Knight.png', 'Frame gold.webp', 'Goblin.png', 'Old Token.png', 'frame-alt.png']) {
    fs.copyFileSync(n.endsWith('webp') ? frameFile : artFile, path.join(folder, n));
  }
  await app.ev(`__tf.openFolder(${J(folder)})`);
  const fo = await app.ev('({ frame: __tf.frame.name, items: __tf.items.map((i) => i.name) })');
  check('folder frame pick ignores "Framed Knight"', fo.frame === 'Frame gold', J(fo));
  check('folder items skip names containing token/frame', J(fo.items) === J(['Goblin.png']), J(fo.items));

  // -- default frame is pinned at the top of the frames sidebar
  await app.ev(`(__tf.ui.framesOpen = false, document.querySelector('#btnFrames').click())`);
  await sleep(500);
  const pin = await app.ev(`(() => { const t = document.querySelector('#frameList .ftile'); const r = { pinned: t.classList.contains('pinned'), nm: t.querySelector('.nm').textContent, x: !!t.querySelector('.x') }; t.click(); return r; })()`);
  await sleep(500);
  check('default frame is pinned first, has no remove button, and loads on click', pin.pinned && pin.nm === 'Default' && !pin.x && (await app.ev('__tf.frame.name')) === 'default', J(pin));
  const bar = await app.ev(`[...document.querySelectorAll('#toolbar > *')].map((e) => (e.textContent || e.className).trim()).filter(Boolean).join('|')`);
  check('toolbar: labels and buttons in the requested order', bar.startsWith('Image|Open Images…|Open Folder…|sep|Frame|Open Frame…|Recent Frames|sep|Tools|Open Tools'), bar);
  const tm = await app.ev(`(async () => { const q = (x) => document.querySelector(x); const w = () => new Promise((r) => setTimeout(r, 80));
    const out = { noName: !q('#frameName'), start: q('#toolsMenu').hidden }; q('#btnTools').click(); await w(); out.open = !q('#toolsMenu').hidden;
    q('#view').click(); await w(); out.clickOutside = q('#toolsMenu').hidden; q('#btnTools').click(); await w(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await w(); out.esc = q('#toolsMenu').hidden; return out; })()`);
  check('Tools menu: frame name gone, opens from Open Tools, closes on outside click and Esc', tm.noName && tm.start && tm.open && tm.clickOutside && tm.esc, J(tm));
  const seedBtn = await app.ev(`(() => { const kids = [...document.querySelectorAll('#panel .row')[0].querySelectorAll('.ctl > *')].map((e) => e.textContent.trim()); return { first: kids[0], second: kids[1], inToolbar: !!document.querySelector('#toolbar #btnSeed, #toolbar #btnDefaultFrame') }; })()`);
  check('Pick center point sits right of Auto center in the panel; no Default button in the toolbar', seedBtn.first === 'Auto center' && seedBtn.second === 'Pick center point' && !seedBtn.inToolbar, J(seedBtn));

  // -- colour controls: no extra eyedropper button, hex field drives the colour
  const hexT = await app.ev(`(() => {
    const row = [...document.querySelectorAll('#panel .row')].find((r) => r.querySelector('label')?.textContent === 'Remove color');
    const hex = row.querySelector('input[type=text]');
    hex.value = 'FF8800'; hex.dispatchEvent(new Event('input', { bubbles: true }));
    return { buttons: row.querySelectorAll('button').length, color: __tf.shared.crColor, swatch: row.querySelector('input[type=color]').value };
  })()`);
  check('Remove color has no eyedropper button; hex field sets the colour', hexT.buttons === 0 && hexT.color === '#ff8800' && hexT.swatch === '#ff8800', J(hexT));

  // -- paste: raw clipboard pixels become an unsaved item with no path
  const pasted = await app.ev(`(async () => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(${J(fs.readFileSync(artFile).toString('base64'))}), (c) => c.charCodeAt(0))], 'image.png', { type: 'image/png' }));
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => { const t = setInterval(() => { if (__tf.base && __tf.items[0]?.bytes) { clearInterval(t); r(); } }, 50); });
    return { n: __tf.items.length, path: __tf.items[0].path, w: __tf.base.bitmap.width };
  })()`);
  check('pasted image opens as an unsaved item', pasted.n === 1 && pasted.path === '' && pasted.w === 400, J(pasted));

  // -- ZIP writer: structure and checksums read back independently with node's zlib
  const zb64 = await app.ev(`(async () => { const { makeZip } = await import('./lib/zip.js'); const enc = new TextEncoder();
    const z = makeZip([{ name: 'Knight Token.webp', data: enc.encode('hello world') }, { name: 'Ñandú ’x’ Token.webp', data: new Uint8Array(70000).map((_, i) => i % 251) }]);
    let s = ''; for (let i = 0; i < z.length; i += 8192) s += String.fromCharCode(...z.subarray(i, i + 8192)); return btoa(s); })()`);
  const z = Buffer.from(zb64, 'base64');
  const eocd = z.length - 22;
  const count = z.readUInt16LE(eocd + 10);
  let p = z.readUInt32LE(eocd + 16);
  const zipped = [];
  for (let i = 0; i < count; i++) {
    const crc = z.readUInt32LE(p + 16), size = z.readUInt32LE(p + 24), nl = z.readUInt16LE(p + 28), off = z.readUInt32LE(p + 42);
    const name = z.toString('utf8', p + 46, p + 46 + nl);
    const lh = off + 30 + z.readUInt16LE(off + 26) + z.readUInt16LE(off + 28);
    zipped.push({ name, ok: zlib.crc32(z.subarray(lh, lh + size)) === crc && z.readUInt32LE(off) === 0x04034b50 });
    p += 46 + nl;
  }
  check('ZIP writer: entries, names and CRCs read back correctly', z.readUInt32LE(eocd) === 0x06054b50 && count === 2 && zipped.every((e) => e.ok) && zipped[1].name === 'Ñandú ’x’ Token.webp', J(zipped));
  // cross-check with the OS tools when available
  if (process.platform === 'win32') {
    const zf = path.join(os.tmpdir(), `tf-check-${process.pid}.zip`); // plain name: PowerShell treats a smart quote as a quote
    fs.writeFileSync(zf, z);
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; ([IO.Compression.ZipFile]::OpenRead('${zf.replace(/'/g, "''")}')).Entries | ForEach-Object { $_.FullName + ':' + $_.Length }`], { encoding: 'utf8' });
      check('ZIP opens in .NET ZipFile', out.includes('Knight Token.webp:11') && out.includes(':70000'), out.trim().split(/\r?\n/).join(' | '));
    } catch (e) { check('ZIP opens in .NET ZipFile', false, String(e.message).slice(0, 120)); }
    fs.rmSync(zf, { force: true });
  }

  // -- Clean frame maths (port of the ComfyUI Token Cleaner): hand-computed cases, a naive reference, and the cleaner pipeline
  const cf = await app.ev(`(async () => {
    const m = await import('./lib/cleanframe.js');
    const out = {};
    const arr = (x) => Array.from(x);
    // box mean, clipped windows
    out.box1 = arr(m.boxMean(Float32Array.from([1, 2, 3, 4, 5]), 5, 1, 1));
    out.box2 = arr(m.boxMean(Float32Array.from([1, 2, 3, 4, 5]), 5, 1, 2));
    { // 2-D box against a naive double loop, odd sizes, radius larger than the image
      const w = 17, h = 13, src = new Float32Array(w * h).map((_, i) => ((i * 7919) % 97) / 97);
      let worst = 0;
      for (const r of [1, 2, 5, 40]) {
        const b = m.boxMean(src, w, h, r);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          let s = 0, n = 0;
          for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) { s += src[yy * w + xx]; n++; }
          worst = Math.max(worst, Math.abs(b[y * w + x] - s / n));
        }
      }
      out.boxNaive = worst;
    }
    // shape: solidify sequence, strict floor and ceiling (compare against the float32 values the plane stores)
    out.solid = [1, 2, 3].map((s) => m.shapeAlpha(Float32Array.from([0.5]), { floor: 0, solidify: s, ceiling: 1 })[0]);
    { const q = Float32Array.from([0.01, 0.0099, 0.98, 0.9801]); const r = m.shapeAlpha(q, { floor: 0.01, solidify: 0, ceiling: 0.98 });
      out.strict = { keepFloor: r[0] === q[0], dropBelow: r[1] === 0, keepCeil: r[2] === q[2], snapAbove: r[3] === 1 }; }
    // crop box: 6x6, alpha above the threshold at x 2..3, y 1..4
    { const w = 6, h = 6, a = new Float32Array(36); for (let y = 1; y <= 4; y++) for (let x = 2; x <= 3; x++) a[y * w + x] = 1;
      out.crop = m.cropBox(a, w, h, 0.05, 1); out.cropNone = m.cropBox(new Float32Array(36), w, h, 0.05, 0).found; }
    // Lanczos: grey 10,21 -> 16; red opaque + transparent blue -> no blue bleed; constant (200,200,200,128) -> (199,199,199,128)
    out.lz1 = Array.from(m.resizeLanczos(Uint8ClampedArray.from([10, 10, 10, 255, 21, 21, 21, 255]), 2, 1, 1, 1).subarray(0, 4));
    out.lz2 = Array.from(m.resizeLanczos(Uint8ClampedArray.from([255, 0, 0, 255, 0, 0, 255, 0]), 2, 1, 1, 1));
    out.lz3 = Array.from(m.resizeLanczos(new Uint8ClampedArray(16 * 4).map((_, i) => [200, 200, 200, 128][i % 4]), 4, 4, 2, 2).subarray(0, 4));
    out.fit = m.fitRect(300, 600, 1000);
    // guided filter: banded == whole-image, and the maths against a naive per-pixel reference; constant alpha stays constant
    { const w = 30, h = 23, rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) { const x = i % w, y = (i / w) | 0; const inside = (x - 15) ** 2 + (y - 11) ** 2 < 70; rgba[i*4] = 40 + (i * 13) % 200; rgba[i*4+1] = 90; rgba[i*4+2] = (i * 29) % 255; rgba[i*4+3] = inside ? 255 : ((x + y) % 5 === 0 ? 90 : 0); }
      const full = m.refineAlpha(rgba, w, h, { radius: 3, smoothing: 0.001, band: 1000 });
      const banded = m.refineAlpha(rgba, w, h, { radius: 3, smoothing: 0.001, band: 5 });
      let bd = 0; for (let i = 0; i < full.length; i++) bd = Math.max(bd, Math.abs(full[i] - banded[i]));
      out.band = bd;
      const a0 = new Float64Array(w * h).map((_, i) => rgba[i*4+3] / 255);
      let num = 0, den = 0; for (let i = 0; i < w * h; i++) { num += a0[i] * (rgba[i*4] + rgba[i*4+1] + rgba[i*4+2]) / 765; den += a0[i]; }
      const fill = num / Math.max(den, 1e-5) < 0.5 ? 1 : 0;
      const I = [0, 1, 2].map((c) => new Float64Array(w * h).map((_, i) => a0[i] * rgba[i*4+c] / 255 + (1 - a0[i]) * fill));
      const r = 3, eps = 0.001;
      const win = (f) => { const o = new Float64Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, n = 0; for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) { s += f(yy * w + xx); n++; } o[y * w + x] = s / n; } return o; };
      const mI = I.map((p) => win((i) => p[i])), mp = win((i) => a0[i]);
      const aC = [new Float64Array(w * h), new Float64Array(w * h), new Float64Array(w * h)], bC = new Float64Array(w * h);
      const det3 = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
      const cov = []; for (let c = 0; c < 3; c++) { cov[c] = []; for (let d = 0; d < 3; d++) cov[c][d] = win((i) => I[c][i] * I[d][i]); }
      const cIp = [0, 1, 2].map((c) => win((i) => I[c][i] * a0[i]));
      for (let i = 0; i < w * h; i++) {
        const S = [0, 1, 2].map((c) => [0, 1, 2].map((d) => cov[c][d][i] - mI[c][i] * mI[d][i] + (c === d ? eps : 0)));
        const rhs = [0, 1, 2].map((c) => cIp[c][i] - mI[c][i] * mp[i]);
        const D = det3(S);
        for (let c = 0; c < 3; c++) { const M = S.map((row, ri) => row.map((v, ci) => (ci === c ? rhs[ri] : v))); aC[c][i] = det3(M) / D; }
        bC[i] = mp[i] - aC[0][i] * mI[0][i] - aC[1][i] * mI[1][i] - aC[2][i] * mI[2][i];
      }
      const mA = aC.map((p) => win((i) => p[i])), mB = win((i) => bC[i]);
      let nd = 0; for (let i = 0; i < w * h; i++) { const q = Math.min(1, Math.max(0, mA[0][i] * I[0][i] + mA[1][i] * I[1][i] + mA[2][i] * I[2][i] + mB[i])); nd = Math.max(nd, Math.abs(q - full[i])); }
      out.naive = nd;
      const solid = new Uint8ClampedArray(w * h * 4).fill(255); out.constQ = Math.min(...m.refineAlpha(solid, w, h, { radius: 3 }));
    }
    // the whole pipeline on a synthetic soft-edged ring frame inside a larger transparent canvas
    { const W = 200, H = 160, rgba = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const d = Math.hypot(x - 100, y - 80), a = d > 40 && d < 60 ? 255 : d > 36 && d <= 40 ? 255 * (d - 36) / 4 : 0; const i = (y * W + x) * 4; rgba[i] = 200; rgba[i+1] = 150; rgba[i+2] = 40; rgba[i+3] = a; }
      const c = m.createCleaner(); c.setImage(rgba, W, H);
      const pv = c.preview({}); const ex = c.exportImage({ size: 128 }); const st = c.exportImage({ size: 64, resize: 'stretch' });
      const mid = (ex.h / 2 | 0) * ex.w * 4 + (ex.w / 2 | 0) * 4 + 3;
      out.pipe = { hasAlpha: c.hasAlpha, pw: pv.w, ph: pv.h, ew: ex.w, eh: ex.h, sw: st.w, centreAlpha: ex.rgba[mid] };
      const flat = m.createCleaner(); flat.setImage(new Uint8ClampedArray(40 * 30 * 4).fill(255), 40, 30);
      const fp = flat.preview({});
      out.opaque = { has: flat.hasAlpha, w: fp.w, h: fp.h };
    }
    return out;
  })()`);
  check('clean frame: box mean hand cases, and the 2-D box matches a naive loop', J(cf.box1) === J([1.5, 2, 3, 4, 4.5]) && J(cf.box2) === J([2, 2.5, 3, 3.5, 4]) && cf.boxNaive < 1e-6, J({ b1: cf.box1, b2: cf.box2, n: cf.boxNaive }));
  check('clean frame: solidify 0.5 -> 0.75 / 0.9375 / 0.99609375; floor and ceiling are strict', J(cf.solid) === J([0.75, 0.9375, 0.99609375]) && cf.strict.keepFloor && cf.strict.dropBelow && cf.strict.keepCeil && cf.strict.snapAbove, J({ s: cf.solid, t: cf.strict }));
  check('clean frame: crop box with padding is clamped; nothing above the threshold returns the whole image', cf.crop.x0 === 1 && cf.crop.x1 === 5 && cf.crop.y0 === 0 && cf.crop.y1 === 6 && cf.cropNone === false, J(cf.crop));
  check('clean frame: Lanczos matches the Pillow cases (grey 16, no blue bleed, constant colour 199)', cf.lz1[0] === 16 && J(cf.lz2) === J([255, 0, 0, 128]) && J(cf.lz3) === J([199, 199, 199, 128]), J({ a: cf.lz1, b: cf.lz2, c: cf.lz3 }));
  check('clean frame: fit rect keeps aspect and centres', J(cf.fit) === J({ w: 500, h: 1000, x: 250, y: 0 }), J(cf.fit));
  check('clean frame: guided filter matches a naive double-precision reference, bands are exact, constant alpha stays 1', cf.naive < 2e-4 && cf.band < 1e-6 && cf.constQ > 0.9999, J({ naive: cf.naive, band: cf.band, constQ: cf.constQ }));
  check('clean frame: pipeline crops to the ring, exports a square with a transparent hole; opaque images are left uncropped', cf.pipe.hasAlpha && cf.pipe.pw < 200 && cf.pipe.ph < 160 && cf.pipe.ew === 128 && cf.pipe.eh === 128 && cf.pipe.sw === 64 && cf.pipe.centreAlpha === 0 && !cf.opaque.has && cf.opaque.w === 40 && cf.opaque.h === 30, J({ p: cf.pipe, o: cf.opaque }));

  // -- Solve frame background (port of the ComfyUI Token Background Solver V2): hand cases, a synthetic white/black round trip, and the mask
  const sv = await app.ev(`(async () => {
    const m = await import('./lib/solveframe.js');
    const out = {};
    const px = (r, g, b) => [r, g, b, 255];
    const one = (W, B, p) => { const s = m.solveMatte(Uint8ClampedArray.from(W), Uint8ClampedArray.from(B), 1, 1, p); return { a: s.alpha[0], c: s.color.map((x) => x[0]) }; };
    out.opaqueBg = one(px(255, 255, 255), px(0, 0, 0), {});                                  // background only: fully transparent
    out.solid = one(px(128, 128, 128), px(128, 128, 128), {});                                // same on both: opaque, colour kept
    out.semi = one(px(153, 153, 153), px(51, 51, 51), { colorSource: 'white' });              // Cw 0.6, Cb 0.2: alpha 0.6, colour (0.6 - 0.4) / 0.6
    out.semiBlack = one(px(153, 153, 153), px(51, 51, 51), { colorSource: 'black' });         // colour from black: 0.2 / 0.6
    out.levels = one(px(230, 230, 230), px(26, 26, 26), { whiteLevel: 0.9, blackLevel: 0.1 }).a; // 0.902 and 0.102 against levels 0.9 / 0.1: about transparent
    const modes = {}; for (const mode of ['min', 'max', 'mean']) modes[mode] = one(px(255, 200, 255), px(0, 0, 0), { channelMode: mode, floor: 0 }).a; out.modes = modes;
    out.notSnapped = one(px(8, 8, 8), px(0, 0, 0), { ceiling: 0.98, floor: 0 }).a;           // alpha 0.9686 stays below the ceiling
    out.solid1 = Array.from(m.solidifyAlpha(Float32Array.from([0.5, 0.9686]), 1));
    // size mismatch and swapped inputs
    const s1 = m.createSolver(); s1.setImage('white', new Uint8ClampedArray(2 * 2 * 4).fill(255), 2, 2); s1.setImage('black', new Uint8ClampedArray(3 * 2 * 4).fill(0), 3, 2);
    try { s1.preview({}); out.mismatch = 'no error'; } catch (e) { out.mismatch = e.message; }
    const s2 = m.createSolver(); s2.setImage('white', new Uint8ClampedArray(4 * 4 * 4).fill(0), 4, 4); s2.setImage('black', new Uint8ClampedArray(4 * 4 * 4).fill(255), 4, 4);
    out.swapped = (() => { const r = s2.preview({}).report; return r.blackBg > r.whiteBg; })();
    // clear the middle: float32 subtraction on the alpha, mask scaled when sizes differ
    { const rgba = Uint8ClampedArray.from([10, 20, 30, 255, 10, 20, 30, 0, 10, 20, 30, 255, 10, 20, 30, 200]);
      const r = m.clearMiddle(rgba, 4, 1, Uint8Array.from([0, 0, 255, 100]), 4, 1);
      out.punch = [r[3], r[7], r[11], r[15]]; // 255 stays, 0 stays, masked -> 0, 200 with mask 100 -> about 100
      const wide = m.clearMiddle(new Uint8ClampedArray(8 * 8 * 4).fill(255), 8, 8, new Uint8Array(4 * 4).fill(255), 4, 4);
      out.punchScaled = wide[3] === 0 && wide[(8 * 8 - 1) * 4 + 3] === 0; }
    // round trip: a soft ring of known colour and alpha, rendered over white and over black, then solved
    { const N = 96, W = new Uint8ClampedArray(N * N * 4), B = new Uint8ClampedArray(N * N * 4), A = new Float32Array(N * N);
      const F = [200, 90, 40];
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const d = Math.hypot(x - 47.5, y - 47.5); const a = d > 30 && d < 44 ? 1 : d > 26 && d <= 30 ? (d - 26) / 4 : d >= 44 && d < 46 ? (46 - d) / 2 : 0; const i = y * N + x; A[i] = a;
        for (let c = 0; c < 3; c++) { W[i*4+c] = Math.round(F[c] * a + 255 * (1 - a)); B[i*4+c] = Math.round(F[c] * a); } W[i*4+3] = B[i*4+3] = 255; }
      const sol = m.solveMatte(W, B, N, N, { channelMode: 'mean', floor: 0, ceiling: 1 });
      let worst = 0, cw = 0; for (let i = 0; i < N * N; i++) { worst = Math.max(worst, Math.abs(sol.alpha[i] - A[i])); if (A[i] > 0.5) cw = Math.max(cw, Math.abs(sol.color[0][i] * 255 - F[0])); }
      out.round = { alphaErr: worst, colourErr: cw, report: sol.report };
      const sv = m.createSolver(); sv.setImage('white', W, N, N); sv.setImage('black', B, N, N);
      const mask = new Uint8Array(N * N); for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (Math.hypot(x - 47.5, y - 47.5) < 20) mask[y * N + x] = 255; sv.setMask(mask, N, N);
      const ex = sv.exportImage({ resize: 'stretch', size: 64, clearMiddle: true, channelMode: 'mean', floor: 0, ceiling: 1, solidify: 0 });
      const centre = (32 * 64 + 32) * 4 + 3, onRing = (32 * 64 + 6) * 4 + 3;
      out.pipe = { w: ex.w, h: ex.h, centreAlpha: ex.rgba[centre], ringAlpha: ex.rgba[onRing] };
      const keep = sv.exportImage({ resize: 'stretch', size: 64, clearMiddle: false, solidify: 2, channelMode: 'mean', floor: 0, ceiling: 1 });
      out.keepMiddle = keep.rgba[centre] === 0; }
    return out;
  })()`);
  const nearTo = (a, b, e = 1e-3) => Math.abs(a - b) <= e;
  check('solve frame: opaque/transparent/semi-transparent hand cases, colour source and background levels', nearTo(sv.opaqueBg.a, 0) && nearTo(sv.solid.a, 1) && nearTo(sv.solid.c[0], 128 / 255) && nearTo(sv.semi.a, 0.6) && nearTo(sv.semi.c[0], 1 / 3) && nearTo(sv.semiBlack.c[0], 1 / 3) && sv.levels < 0.01, J(sv));
  check('solve frame: channel modes min / max / mean differ as expected; floor and ceiling do not snap in between', nearTo(sv.modes.min, 0) && nearTo(sv.modes.max, 0.2157, 2e-3) && nearTo(sv.modes.mean, 0.0719, 2e-3) && nearTo(sv.notSnapped, 0.9686, 2e-3) && nearTo(sv.solid1[0], 0.75, 1e-6) && nearTo(sv.solid1[1], 1 - (1 - 0.9686) ** 2, 1e-4), J({ m: sv.modes, n: sv.notSnapped, s: sv.solid1 }));
  check('solve frame: size mismatch is an error, swapped inputs are detected', /same size/.test(sv.mismatch) && sv.swapped === true, J({ mm: sv.mismatch, sw: sv.swapped }));
  check('solve frame: clear-the-middle subtracts the mask from alpha (and scales it to other sizes)', sv.punch[0] === 255 && sv.punch[1] === 0 && sv.punch[2] === 0 && Math.abs(sv.punch[3] - 100) <= 1 && sv.punchScaled === true, J({ p: sv.punch, s: sv.punchScaled }));
  check('solve frame: a known soft ring is recovered from its white and black renders; the middle is cleared only when asked', sv.round.alphaErr < 0.01 && sv.round.colourErr < 6 && sv.pipe.w === 64 && sv.pipe.centreAlpha === 0 && sv.pipe.ringAlpha > 200 && sv.keepMiddle, J(sv.round) + ' ' + J(sv.pipe));

  // -- Tiled model engine (modelrun.cjs): spandrel-style padding and ComfyUI-style tiling, checked with fake models so no GPU or model file is needed
  {
    const { createRequire } = await import('node:module');
    const mr = createRequire(import.meta.url)(path.join(root, 'modelrun.cjs'));
    const row = (arr, w, h) => Array.from(mr.padTile(Float32Array.from(arr), w, h, 1).data);
    const padOk = J(row([1, 2, 3], 3, 1).slice(0, 4)) === J([1, 2, 3, 2]) && J(row([1, 2], 2, 1).slice(0, 4)) === J([1, 2, 1, 1]) && row([7], 1, 1).every((v) => v === 7);
    const tilesOk = J(mr.axisTiles(1000)) === J([{ pos: 0, len: 512 }, { pos: 480, len: 512 }, { pos: 960, len: 40 }]) && J(mr.axisTiles(513)) === J([{ pos: 0, len: 512 }, { pos: 480, len: 33 }]) && mr.countTiles(1000, 777) === 6 && mr.countTiles(512, 512) === 1;
    check('model engine: padding mirrors spandrel (reflect, then replicate) and tile positions match comfy tiled_scale', padOk && tilesOk, J({ padOk, tilesOk }));
    const sizes = [[512, 512], [513, 300], [1000, 777], [1001, 40], [3, 3], [1, 1], [700, 1]];
    let worst = 0, badCalls = 0, maxCall = 0, calls = 0;
    for (const [w, h] of sizes) {
      const rgba = new Uint8Array(w * h * 4).map((_, i) => ((i * 7919 + w) % 251));
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = (i * 13) % 256; // alpha must come back untouched
      const identity = async (data, tw, th) => { calls++; if (tw % 4 || th % 4 || tw < 4 || th < 4) badCalls++; maxCall = Math.max(maxCall, tw, th); return data; };
      const out = await mr.cleanRgba(identity, rgba, w, h);
      for (let i = 0; i < rgba.length; i++) worst = Math.max(worst, Math.abs(out[i] - rgba[i]));
      // a pointwise model (+0.1, clamped by the wrapper) must be reproduced exactly however the image is tiled
      const lift = async (data) => data.map((v) => v + 0.1);
      const o2 = await mr.cleanRgba(lift, rgba, w, h);
      for (let i = 0; i < rgba.length; i += 4) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(o2[i + c] - Math.min(255, Math.round((rgba[i + c] / 255 + 0.1) * 255))));
    }
    check('model engine: identity and +0.1 models are reproduced exactly at 512, 513, 1000x777, 1001x40, 3x3, 1x1 and 700x1; every call is a multiple of 4; alpha is untouched', worst <= 1 && badCalls === 0 && maxCall <= 516, J({ worst, badCalls, maxCall, calls }));
  }

  // -- Solver pre-clean selection (pure): cleaned copies are used only when both exist and the option is on
  const pc = await app.ev(`(async () => {
    const m = await import('./lib/solveframe.js');
    const mkPair = (wv, bv) => [new Uint8ClampedArray(2 * 2 * 4).fill(wv), new Uint8ClampedArray(2 * 2 * 4).fill(bv)].map((a) => { for (let i = 3; i < a.length; i += 4) a[i] = 255; return a; });
    const [w, b] = mkPair(153, 51);          // raw pair: Cw 0.6, Cb 0.2 -> alpha 0.6
    const [cw, cb] = mkPair(255, 0);         // "cleaned" pair: alpha 0
    const s = m.createSolver(); s.setImage('white', w, 2, 2); s.setImage('black', b, 2, 2);
    const a = (p) => s.preview({ ...p, solidify: 0, floor: 0, ceiling: 1, threshold: 2 }).rgba[3];   // threshold 2: nothing found, whole image kept
    const out = { raw: a({ preClean: true }) };                                                      // no cleaned copies yet: raw
    s.setCleaned('white', cw); out.onlyOne = a({ preClean: true });                                  // only one cleaned copy: still raw
    s.setCleaned('black', cb); out.both = a({ preClean: true }); out.optionOff = a({ preClean: false });
    s.setImage('white', w, 2, 2); out.newRenderDropsClean = a({ preClean: true }); out.ready = s.cleanedReady;
    return out;
  })()`);
  check('solve frame: cleaned copies are used only when both exist and pre-clean is on; a new render drops its cleaned copy', pc.raw === 153 && pc.onlyOne === 153 && pc.both === 0 && pc.optionOff === 153 && pc.newRenderDropsClean === 153 && pc.ready.white === false && pc.ready.black === true, J(pc));

  // -- Tiled engine with an output scale: a fake nearest-neighbour upscaler must be reproduced exactly however the image is tiled, padded and blended
  {
    const { createRequire } = await import('node:module');
    const mr = createRequire(import.meta.url)(path.join(root, 'modelrun.cjs'));
    const cases = [[130, 70, 96], [300, 200, 96], [97, 5, 512], [1, 1, 512], [520, 40, 512], [64, 200, 64]];
    let worst = 0, badSize = 0, dimsOk = true, calls = 0;
    for (const scale of [2, 4]) {
      for (const [w, h, tile] of cases) {
        const rgba = new Uint8Array(w * h * 4).map((_, i) => ((i * 7919 + w * scale) % 251)); for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
        const nearest = async (data, tw, th) => { calls++; if (tw < 16 || th < 16 || tw % 8 || th % 8) badSize++; const out = new Float32Array(3 * tw * scale * th * scale);
          for (let c = 0; c < 3; c++) for (let y = 0; y < th * scale; y++) for (let x = 0; x < tw * scale; x++) out[(c * th * scale + y) * tw * scale + x] = data[(c * th + (y / scale | 0)) * tw + (x / scale | 0)]; return out; };
        const r = await mr.processRgba(nearest, rgba, w, h, { scale, multiple: 8, minimum: 16, tile });
        if (r.w !== w * scale || r.h !== h * scale || r.rgba.length !== w * scale * h * scale * 4) dimsOk = false;
        for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(r.rgba[(y * r.w + x) * 4 + c] - rgba[((y / scale | 0) * w + (x / scale | 0)) * 4 + c]));
      }
    }
    let refused = '';
    try { await mr.processRgba(async (d) => d, Uint8Array.from([1, 2, 3, 100]), 1, 1, { scale: 4, multiple: 1, minimum: 2 }); } catch (e) { refused = e.message; }
    check('model engine (scale): a nearest-neighbour 2x and 4x upscaler is reproduced exactly with tiling, padding to multiples of 8 (min 16) and feathering; transparent input is refused for upscalers', worst <= 1 && badSize === 0 && dimsOk && /opaque/.test(refused), J({ worst, badSize, dimsOk, calls, refused }));
  }

  // -- A model whose description is wrong (say a 4x model without its .json, taken as 1x) must error clearly instead of producing a scrambled picture
  {
    const { createRequire } = await import('node:module');
    const mr = createRequire(import.meta.url)(path.join(root, 'modelrun.cjs'));
    const fourX = async (data, tw, th) => new Float32Array(3 * tw * 4 * th * 4).fill(0.5);   // really a 4x model
    let msg = '';
    try { await mr.processRgba(fourX, new Uint8Array(8 * 8 * 4).fill(255), 8, 8, { scale: 1, multiple: 4, minimum: 4 }); } catch (e) { msg = e.message; }
    const fine = await mr.processRgba(fourX, new Uint8Array(8 * 8 * 4).fill(255), 8, 8, { scale: 4, multiple: 1, minimum: 2 });
    check('model engine: a model whose description does not match its output size errors with a hint (no scrambled picture); the right description works', /\.json description file/.test(msg) && fine.w === 32 && fine.h === 32, J({ msg: msg.slice(0, 90), w: fine.w }));
  }

  // -- RMBG matte post-processing (same maths as the ComfyUI RMBG node), on synthetic mattes
  const mt = await app.ev(`(async () => {
    const { matteToAlpha, MATTE_RES: R } = await import('./lib/matte.js');
    const sq = new Uint8Array(R * R); for (let y = 256; y < 768; y++) for (let x = 256; x < 768; x++) sq[y * R + x] = 255;
    const count = (a) => a.reduce((n, v) => n + (v === 255 ? 1 : 0), 0);
    const id = matteToAlpha(sq, R, R, R, R, {});
    const shrink = matteToAlpha(sq, R, R, R, R, { offset: -1 });
    const grow = matteToAlpha(sq, R, R, R, R, { offset: 1 });
    const sens = matteToAlpha(new Uint8Array(R * R).fill(100), R, R, R, R, { sensitivity: 0.5 });
    const blur = matteToAlpha(sq, R, R, R, R, { blur: 3 });
    const half = new Uint8Array(R * R); for (let y = 0; y < R; y++) for (let x = 0; x < R / 2; x++) half[y * R + x] = 255;
    const ns = matteToAlpha(half, R, R, 400, 300, {});
    return { same: id.every((v, i) => v === sq[i]), n0: count(id), nShrink: count(shrink), nGrow: count(grow), sens: sens[5000],
      edge: blur[256 * R + 256], inner: blur[512 * R + 512], nsL: ns[150 * 400 + 20], nsR: ns[150 * 400 + 380], nsSize: ns.length };
  })()`);
  check('matte: sensitivity 1 / offset 0 / blur 0 leave the matte untouched', mt.same && mt.n0 === 512 * 512, J(mt));
  check('matte: offset -1 shrinks a square 1 px per side, +1 grows it', mt.nShrink === 510 * 510 && mt.nGrow === 514 * 514, `${mt.nShrink} / ${mt.nGrow}`);
  check('matte: sensitivity 0.5 gives gain 1.5 (100 -> 150)', mt.sens === 150, String(mt.sens));
  check('matte: blur softens the edge but not the interior', mt.edge > 0 && mt.edge < 255 && mt.inner === 255, `${mt.edge} / ${mt.inner}`);
  check('matte: resize to a non-square image keeps orientation', mt.nsL === 255 && mt.nsR === 0 && mt.nsSize === 400 * 300, `${mt.nsL} / ${mt.nsR} / ${mt.nsSize}`);

  // -- the 'ai' edit turns a matte into the removal mask (matte square covers the middle half of the image)
  const ai = await app.ev(`(async () => {
    const { MATTE_RES: R } = await import('./lib/matte.js');
    const m = new Uint8Array(R * R); for (let y = 256; y < 768; y++) for (let x = 256; x < 768; x++) m[y * R + x] = 255;
    const c = __tf.buildCut(__tf.base.bitmap, { ...__tf.eff(), crEnabled: false, aiOffset: 0, popEdits: [{ type: 'ai' }] }, m);
    const a = (x, y) => c.ctx.getImageData(x, y, 1, 1).data[3];
    const none = __tf.buildCut(__tf.base.bitmap, { ...__tf.eff(), crEnabled: false, popEdits: [{ type: 'ai' }] }, null);
    return { corners: [a(2, 2), a(397, 297)], centre: a(200, 150), noMatte: none.ctx.getImageData(2, 2, 1, 1).data[3] };
  })()`);
  check('ai edit removes outside the matte and keeps the subject', ai.corners[0] === 0 && ai.corners[1] === 0 && ai.centre === 255, J(ai));
  check('ai edit without a matte is a no-op (model not run yet)', ai.noMatte === 255, J(ai.noMatte));

  // -- recent frames sidebar
  const fA = path.join(work, 'Frame A.webp'), fB = path.join(work, 'Frame B ’b’.webp'), fC = path.join(work, 'Frame C.webp');
  for (const f of [fA, fB, fC]) fs.copyFileSync(frameFile, f);
  await app.ev(`(__tf.recentFrames = [], 1)`);
  for (const f of [fA, fB, fA, fA.toUpperCase()]) await app.ev(`__tf.loadFrame(${J(f)})`);
  const rec = await app.ev('__tf.recentFrames');
  check('recent frames: most recent first, no duplicates (case-insensitive)', rec.length === 2 && rec[0].toLowerCase() === fA.toLowerCase() && rec[1] === fB, J(rec));

  await app.ev(`(__tf.ui.framesOpen || document.querySelector('#btnFrames').click(), __tf.renderFrameList(), 1)`);
  await sleep(600);
  const ui1 = await app.ev(`(() => { const t = [...document.querySelectorAll('#frameList .ftile')];
    const painted = t.map((x) => { const c = x.querySelector('canvas'); const d = c.getContext('2d').getImageData(0, 0, 192, 192).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; });
    return { shown: !document.querySelector('#frames').hidden, tiles: t.length, painted, cur: t.filter((x) => x.classList.contains('cur')).length }; })()`);
  check('sidebar opens with one painted tile per recent frame, current one highlighted', ui1.shown && ui1.tiles === 3 && ui1.painted.every(Boolean) && ui1.cur === 1, J(ui1));

  const before = await app.ev('JSON.stringify(__tf.shared)');
  await app.ev(`document.querySelectorAll('#frameList .ftile')[2].click()`);
  await sleep(500);
  const click = await app.ev('({ name: __tf.frame.name, order: __tf.recentFrames, shared: JSON.stringify(__tf.shared) })');
  check('clicking a tile loads that frame, keeps list order, leaves settings alone', click.name === 'Frame B ’b’' && click.order[1] === fB && click.shared === before, J({ name: click.name, order: click.order }));

  const gone = path.join(work, 'Gone.webp');
  await app.ev(`(__tf.recentFrames.push(${J(gone)}), __tf.renderFrameList(), 1)`);
  await sleep(500);
  const miss = await app.ev(`(() => { const t = [...document.querySelectorAll('#frameList .ftile')].find((x) => x.classList.contains('missing')); const had = !!t; t?.click(); return { had, left: __tf.recentFrames.length }; })()`);
  check('a missing frame file shows as missing and is dropped on click', miss.had && miss.left === 2, J(miss));

  await app.ev(`(() => { for (let i = 0; i < 30; i++) __tf.rememberFrame('C:/nowhere/f' + i + '.webp'); return 1; })()`);
  check('recent list is capped at 24', (await app.ev('__tf.recentFrames.length')) === 24);

  // the preview stays square when the window is narrowed (it used to squash sideways) and when it is made short
  const sq = await app.ev(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms)); const r = () => { const b = document.querySelector('#view').getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; };
    const w0 = window.outerWidth, h0 = window.outerHeight; const o = {};
    window.resizeTo(900, h0); await wait(400); o.narrow = r();
    window.resizeTo(w0, Math.max(500, h0 - 150)); await wait(400); o.short = r();
    window.resizeTo(w0, h0); await wait(400); return o;
  })()`);
  check('preview stays square when the window is narrowed or shortened', sq.narrow[0] === sq.narrow[1] && sq.short[0] === sq.short[1] && sq.narrow[0] > 100, J(sq));

  // persists across a restart: put two real frames back on top, then relaunch
  await app.ev(`(__tf.recentFrames = [${J(fC)}, ${J(fB)}, ${J(fA)}], 1)`);
  await app.ev(`__tf.loadFrame(${J(fB)}, { keepOrder: true })`);
  const wantH = await app.ev(`(() => { const d = (t) => document.querySelector('#panel > details[data-title="' + t + '"]'); d('Image').open = false; d('Frame').open = true; window.resizeTo(1111, Math.min(777, screen.availHeight - 40)); return Math.min(777, screen.availHeight - 40); })()`);
  await sleep(1300);
  app.close();
  await sleep(800);
  await app.launch();
  const sect = await app.ev(`(() => { const d = (t) => document.querySelector('#panel > details[data-title="' + t + '"]').open; return { image: d('Image'), mask: d('Mask'), frame: d('Frame'), w: window.outerWidth, h: window.outerHeight }; })()`);
  check('panel sections remember open/closed, window remembers its size', !sect.image && sect.mask && sect.frame && sect.w === 1111 && sect.h === wantH, J(sect));
  const again = await app.ev(`({ rec: __tf.recentFrames, open: !document.querySelector('#frames').hidden, frame: __tf.frame.name })`);
  check('recent frames and sidebar state survive a restart', J(again.rec) === J([fC, fB, fA]) && again.open && again.frame === 'Frame B ’b’', J(again));

  // -- pop-out is per image: turning it on never becomes a shared default, and an old saved shared value is ignored
  await app.ev(`__tf.openImages([${J(art)}])`);
  await sleep(600);
  const po = await app.ev(`(async () => { const cb = document.querySelector('#panel > details[data-title="Pop-out"] input[type=checkbox]'); cb.click(); await new Promise((r) => setTimeout(r, 900));
    return { shared: __tf.shared.popOutEnabled, own: __tf.items[__tf.cur].override.popOutEnabled }; })()`);
  const savedShared = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).shared || {};
  check('pop-out on a lone image stays on that image and is not saved as a shared default', po.shared === false && po.own === true && savedShared.popOutEnabled !== true, J({ ...po, saved: savedShared.popOutEnabled }));
  app.close();
  await sleep(800);
  const sf = path.join(userData, 'settings.json');
  const old = JSON.parse(fs.readFileSync(sf, 'utf8'));
  old.shared = { ...old.shared, popOutEnabled: true };
  fs.writeFileSync(sf, JSON.stringify(old));
  await app.launch();
  check('an old saved shared pop-out-on is ignored at startup', (await app.ev('__tf.shared.popOutEnabled')) === false);

  app.close();
}

try {
  await main();
} catch (e) {
  failed++;
  console.error('ERROR', e);
} finally {
  await sleep(300);
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
