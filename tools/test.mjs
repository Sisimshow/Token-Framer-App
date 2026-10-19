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

  // -- default frame button
  await app.ev(`document.querySelector('#btnDefaultFrame').click()`);
  await sleep(500);
  check('Default button restores assets/default.webp', (await app.ev('__tf.frame.name')) === 'default');

  // -- colour controls: no extra eyedropper button, hex field drives the colour
  const hexT = await app.ev(`(() => {
    const row = [...document.querySelectorAll('#panel .row')].find((r) => r.querySelector('label').textContent === 'Remove color');
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
