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
    this.proc = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], { cwd: root, env, stdio: 'ignore' });
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
    await this.ev('new Promise((r) => { const t = setInterval(() => { if (window.__tf && __tf.frame) { clearInterval(t); r(); } }, 50); })');
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
  popout_color: { popOutEnabled: true, crEnabled: true, crColor: '#20a040', popOutDegrees: 200 },
  popout_edits: {
    popOutEnabled: true, popOutDegrees: 200,
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
      o.saveOn = !q('#svSave').disabled;
      return o;
    })()`);
    check('Solve frame: opens from Tools, solves a white/black pair in the worker, Esc closes it, shortcuts are ignored while open', ui.open && ui.menuClosed && ui.rows >= 12 && ui.saveOff && ui.solved && ui.report?.w === 1 && ui.report?.b === 0 && ui.keysIgnored && ui.escCloses && ui.saveOn, J(ui));
    const saved = await app.ev(`__tf.solver.saveAndLoad(${J(outP)})`);
    const magic = fs.existsSync(outP) ? fs.readFileSync(outP).subarray(0, 4).toString('hex') : '';
    const px = await app.ev(`(async () => { const bm = await createImageBitmap(new Blob([await window.api.readFile(${J(outP)})])); const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height; const x = c.getContext('2d'); x.drawImage(bm, 0, 0);
      const a = (px, py) => x.getImageData(px, py, 1, 1).data[3]; return { w: bm.width, centre: a(128, 128), ring: a(128 + 100, 128), corner: a(2, 2), frame: __tf.frame.path, closed: document.querySelector('#solver').hidden }; })()`);
    check('Solve frame: Save and use as frame writes a PNG with the middle cleared, ring kept and corners transparent, and loads it as the frame', magic === '89504e47' && saved.w === 256 && px.w === 256 && px.centre === 0 && px.ring > 200 && px.corner === 0 && px.frame === outP && px.closed, J({ magic, saved: saved.w, px }));
    await app.ev(`__tf.loadFrame(${J(path.join(root, 'assets', 'default.webp'))}, { keepOrder: true })`);
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
