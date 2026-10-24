const { app, BrowserWindow, ipcMain, dialog, Menu, net, screen } = require('electron');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const modelrun = require('./modelrun.cjs');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');

const IMG_EXT = /\.(webp|png|jpe?g|bmp|gif|tiff?|avif)$/i;
const EXT_RANK = { '.webp': 0, '.png': 1, '.jpg': 2, '.jpeg': 2 };
const IMG_FILTER = [{ name: 'Images', extensions: ['webp', 'png', 'jpg', 'jpeg', 'bmp', 'gif', 'tif', 'tiff', 'avif'] }];

let win = null;

/** Only the app's own window may use the IPC below. */
const fromApp = (e) => !!win && !win.isDestroyed() && e.sender === win.webContents;
/** ipcMain.handle, refusing any sender but the app's window. */
const handle = (channel, fn) => ipcMain.handle(channel, (e, ...args) => {
  if (!fromApp(e)) throw new Error('Not allowed.');
  return fn(e, ...args);
});
/** What the window may write: images and ZIPs. Not scripts, shortcuts or the app's own code, whatever a compromised page might try. */
const WRITE_EXT = /\.(png|webp|jpe?g|zip)$/i;

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/**
 * Writes a file so that a crash mid-write can never leave it half written: a temporary file next to it, flushed to disk, then renamed over it. Windows can
 * briefly refuse the rename while Defender, the indexer or OneDrive holds the file: retried a few times, then written directly.
 */
function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (err) {
      if (i < 5 && /EPERM|EBUSY|EACCES/.test(err.code)) { sleepSync(40); continue; }
      try { fs.writeFileSync(file, data); } finally { fs.rmSync(tmp, { force: true }); }
      return;
    }
  }
}
/** A JSON file, or {} when it is missing. A file that does not parse is kept aside as <name>.corrupt-<time> (so the next save cannot destroy what is left of it). */
function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  try { return JSON.parse(text); } catch {
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* leave it */ }
    return {};
  }
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const editsFile = () => path.join(app.getPath('userData'), 'edits.json');
const windowFile = () => path.join(app.getPath('userData'), 'window.json'); // apart from settings.json, which the renderer rewrites whole

/** Last window bounds, or {} if none saved or they no longer fit on any screen (e.g. a monitor was unplugged). */
function loadWindowState() {
  try {
    const w = JSON.parse(fs.readFileSync(windowFile(), 'utf8'));
    const ok = [w.x, w.y, w.width, w.height].every(Number.isFinite);
    const visible = ok && screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return w.x < a.x + a.width - 100 && w.x + w.width > a.x + 100 && w.y < a.y + a.height - 50 && w.y + 50 > a.y;
    });
    return visible ? w : {};
  } catch { return {}; }
}
function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds(); // the restored size, even while maximized
    writeFileAtomic(windowFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch { /* not worth interrupting the user */ }
}

function createWindow() {
  const saved = loadWindowState();
  win = new BrowserWindow({
    width: saved.width || 1360,
    height: saved.height || 880,
    ...(saved.x !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 980,
    minHeight: 640,
    title: 'Token Framer',
    backgroundColor: '#1b1d22',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (saved.maximized) win.maximize();
  let saveTimer = 0;
  const later = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveWindowState, 500); };
  win.on('resize', later);
  win.on('move', later);
  win.on('close', saveWindowState);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      win.webContents.toggleDevTools();
    }
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
});
app.on('window-all-closed', () => app.quit());

handle('dlg:folder', async (_e, defaultPath) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath });
  return r.canceled ? null : r.filePaths[0];
});
handle('dlg:images', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, {
    properties: opts.multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: IMG_FILTER,
    defaultPath: opts.defaultPath
  });
  return r.canceled ? [] : r.filePaths;
});
handle('dlg:save', async (_e, defaultPath, ext = 'webp') => {
  const r = await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  return r.canceled ? null : r.filePath;
});

// Non-recursive scan. Same base name in several formats: webp wins, then png, then jpg (as art_batch_tokenize.py does).
handle('fs:list', async (_e, dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && IMG_EXT.test(d.name));
  const best = new Map();
  for (const d of entries) {
    const ext = path.extname(d.name).toLowerCase();
    const base = path.basename(d.name, path.extname(d.name));
    const key = base.toLowerCase();
    const rank = EXT_RANK[ext] ?? 3;
    const cur = best.get(key);
    if (!cur || rank < cur.rank) best.set(key, { name: d.name, base, rank, path: path.join(dir, d.name) });
  }
  const files = [...best.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { dir, files: files.map(({ name, base, path: p }) => ({ name, base, path: p })), names: entries.map((d) => d.name.toLowerCase()) };
});
handle('fs:read', async (_e, p) => {
  if (typeof p !== 'string' || !IMG_EXT.test(p)) throw new Error('Only image files can be opened.');
  return fs.readFileSync(p);
});
handle('fs:write', async (_e, p, bytes) => {
  if (typeof p !== 'string' || !WRITE_EXT.test(p)) throw new Error('Only images (PNG, WebP, JPEG) and ZIP files can be saved.');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.from(bytes));
  return true;
});
// ---------------------------------------------------------------- image cleanup models (1x ESRGAN-type, converted with tools/convert-model.py)
const modelDir = () => path.join(__dirname, 'models');
const cleanSessions = new Map(); // model name -> Promise of { session, ort, provider } (the promise, so two screens asking at once share one load)
let cleanQueue = Promise.resolve(); // model runs one at a time: each holds full-size buffers
const MAX_OUTPUT_PIXELS = 100e6;  // the hard stop (about 10000 x 10000); the renderer asks for confirmation well before this (HEAVY_PIXELS in ui-kit.js)

/** Models in the models folder with what the converter wrote next to each (scale and size rules); an .onnx without that file is taken to be a 1x model needing multiples of 4. */
function listCleanModels() {
  try {
    return fs.readdirSync(modelDir()).filter((f) => /\.onnx$/i.test(f)).map((f) => {
      const name = f.replace(/\.onnx$/i, '');
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(modelDir(), `${name}.json`), 'utf8')); } catch { /* no description file */ }
      return { name, file: f, scale: Number(meta.scale) || 1, multiple: Number(meta.multiple) || 4, minimum: Number(meta.minimum) || 4, architecture: meta.architecture || '' };
    });
  } catch { return []; }
}
function getCleanSession(name) {
  if (cleanSessions.has(name)) return cleanSessions.get(name);
  const job = (async () => {
    const model = listCleanModels().find((m) => m.name === name); // only files that are really in the models folder
    if (!model) throw new Error(`The model "${name}" is not in the models folder.`);
    const ort = require('onnxruntime-node');
    for (const ep of ['dml', 'cpu']) {
      try {
        const session = await ort.InferenceSession.create(path.join(modelDir(), model.file), { executionProviders: [ep] });
        return { session, ort, provider: ep === 'dml' ? 'GPU (DirectML)' : 'CPU' };
      } catch (err) {
        console.warn(`onnxruntime provider ${ep} failed for ${name}:`, err.message);
      }
    }
    throw new Error(`Could not load the model "${name}".`);
  })();
  cleanSessions.set(name, job);
  job.catch(() => cleanSessions.delete(name)); // a failed load can be tried again
  return job;
}

handle('models:list', async () => listCleanModels());
/** rgba: straight RGBA bytes. The model sees RGB only; the alpha channel is returned unchanged. */
handle('models:clean', (e, ...args) => { // queued: two screens running models at once would hold two sets of full-size buffers
  const job = cleanQueue.then(() => runClean(e, ...args));
  cleanQueue = job.catch(() => {});
  return job;
});
async function runClean(e, name, rgba, w, h, reqId) { // reqId comes back on every progress event so each screen can tell its own job apart
  if (!(rgba instanceof Uint8Array) || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || rgba.length !== w * h * 4) throw new Error('Unexpected image data.');
  const { session, ort, provider } = await getCleanSession(name);
  const meta = listCleanModels().find((m) => m.name === name);
  if (w * meta.scale * h * meta.scale > MAX_OUTPUT_PIXELS) throw new Error(`The result would be ${w * meta.scale}×${h * meta.scale} pixels, more than the ${Math.round(MAX_OUTPUT_PIXELS / 1e6)} megapixel limit. Use a smaller image.`);
  // The tiled engine keeps full-size working buffers (input planes, output accumulation and weights, the RGBA result): about 12 bytes per input pixel and 20 per
  // output pixel. Refused when that is more than half the computer's memory, instead of exhausting it. (Tiling those buffers too would lift this; not done.)
  const need = 12 * w * h + 20 * w * h * meta.scale * meta.scale;
  if (need > os.totalmem() / 2) throw new Error(`That needs about ${(need / 1e9).toFixed(1)} GB of memory, more than half of this computer's ${(os.totalmem() / 1e9).toFixed(0)} GB. Use a smaller image or a smaller factor.`);
  const runModel = async (data, tw, th) => {
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, th, tw]) });
    return out[session.outputNames[0]].data;
  };
  const t = Date.now();
  let last = 0;
  const onProgress = (done, total) => { if (!e.sender.isDestroyed() && (Date.now() - last > 100 || done === total)) { last = Date.now(); e.sender.send('models:progress', { done, total, id: reqId }); } };
  // like ComfyUI, retry with smaller tiles if the GPU runs out of memory
  let result = null;
  for (const tile of [512, 256, 128]) {
    try {
      result = await modelrun.processRgba(runModel, rgba, w, h, { scale: meta.scale, multiple: meta.multiple, minimum: meta.minimum, tile, onProgress });
      break;
    } catch (err) {
      if (tile === 128 || !/memory|alloc|out of|bad_alloc/i.test(String(err.message))) throw err;
      console.warn(`model run failed at tile ${tile} (${err.message}); retrying smaller`);
    }
  }
  return { rgba: result.rgba, w: result.w, h: result.h, scale: meta.scale, ms: Date.now() - t, provider };
}

handle('app:defaultFrame', async () => path.join(__dirname, 'assets', 'default.webp'));
handle('fs:exists', async (_e, p) => fs.existsSync(p));
handle('fs:isDir', async (_e, p) => {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
});

handle('settings:get', async () => readJson(settingsFile()));
handle('settings:set', async (_e, data) => {
  writeFileAtomic(settingsFile(), JSON.stringify(data, null, 2));
  return true;
});
// The window is closing: the renderer hands over what it had not saved yet (its saves wait 500 ms), synchronously, so nothing is lost on a quick close.
ipcMain.on('app:flushSync', (e, settings, edits) => {
  try {
    if (fromApp(e)) {
      if (settings) writeFileAtomic(settingsFile(), JSON.stringify(settings, null, 2));
      if (edits) writeFileAtomic(editsFile(), JSON.stringify(edits));
    }
    e.returnValue = true;
  } catch { e.returnValue = false; }
});

// ---------------------------------------------------------------- AI background removal (RMBG-2.0, FP16 ONNX)
// Community ONNX export of briaai/RMBG-2.0 (CC BY-NC 4.0, personal use). Fixed 1024x1024 input; output is already a 0..1 alpha.
// Mattes are cached by a hash of the model input, so a restart or Save all never re-runs the model for an image it has seen.
// Pinned to one revision and checked by SHA-256 (the LFS hash HF publishes; it matched an installed copy), so a changed or tampered upstream file is refused
// instead of being handed to the native ONNX parser.
const MODEL_REV = 'fcd7830ebd0cc92c5e6262da225a7cc41f2a9afd';
const MODEL_URL = `https://huggingface.co/yamura4/RMBG-2.0-ONNX/resolve/${MODEL_REV}/onnx/model_fp16.onnx`;
const MODEL_SIZE = 512588696;
const MODEL_SHA256 = '40da1311f8e212c6e878cb126d5ace796c40a648b0e58d05999108f6a5448baa';
/** SHA-256 of a file, read in chunks. */
async function sha256File(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
const MATTE_RES = 1024;
const modelFile = () => path.join(app.getPath('userData'), 'models', 'RMBG-2.0-fp16.onnx');
const matteDir = () => path.join(app.getPath('userData'), 'mattes');
let ortSession = null;
let ortProvider = '';
let aiQueue = Promise.resolve();

const modelReady = () => {
  try { return fs.statSync(modelFile()).size === MODEL_SIZE; } catch { return false; }
};

handle('ai:status', async () => ({ ready: modelReady(), sizeMB: Math.round(MODEL_SIZE / 1e6), provider: ortProvider }));

let downloading = null; // the download in progress: a second request (another screen) shares it instead of writing the same .part file
handle('ai:download', (e) => {
  if (!downloading) downloading = downloadModel(e.sender).finally(() => { downloading = null; });
  return downloading;
});
async function downloadModel(sender) {
  const dest = modelFile();
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await net.fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || MODEL_SIZE;
  let got = 0, last = 0;
  const hash = crypto.createHash('sha256');
  const progress = new Transform({
    transform(chunk, _enc, cb) {
      got += chunk.length;
      hash.update(chunk);
      if (Date.now() - last > 200 && !sender.isDestroyed()) { last = Date.now(); sender.send('ai:progress', { got, total }); }
      cb(null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(res.body), progress, fs.createWriteStream(part)); // a disk-full or permission error rejects here instead of crashing the app
    if (fs.statSync(part).size !== MODEL_SIZE) throw new Error('The downloaded model file has the wrong size.');
    if (hash.digest('hex') !== MODEL_SHA256) throw new Error('The downloaded model file is not the expected one (checksum mismatch).');
  } catch (err) {
    fs.rmSync(part, { force: true });
    throw err;
  }
  fs.renameSync(part, dest);
  return true;
}

// Fallback when the download is blocked: copy a model_fp16.onnx the user already has into place.
handle('ai:chooseModel', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'ONNX model', extensions: ['onnx'] }] });
  if (r.canceled) return false;
  if (fs.statSync(r.filePaths[0]).size !== MODEL_SIZE) throw new Error('That is not the RMBG-2.0 FP16 model (unexpected file size).');
  if (await sha256File(r.filePaths[0]) !== MODEL_SHA256) throw new Error('That is not the RMBG-2.0 FP16 model this app expects (checksum mismatch).');
  fs.mkdirSync(path.dirname(modelFile()), { recursive: true });
  fs.copyFileSync(r.filePaths[0], modelFile());
  return true;
});

async function getSession() {
  if (ortSession) return ortSession;
  const ort = require('onnxruntime-node');
  for (const ep of ['dml', 'cpu']) {
    try {
      ortSession = await ort.InferenceSession.create(modelFile(), { executionProviders: [ep] });
      ortProvider = ep === 'dml' ? 'GPU (DirectML)' : 'CPU';
      return ortSession;
    } catch (err) {
      console.warn(`onnxruntime provider ${ep} failed:`, err.message);
    }
  }
  throw new Error('Could not load the RMBG-2.0 model.');
}

/** rgb: interleaved RGB bytes of the image resized to 1024x1024. Returns the 1024x1024 matte as 8-bit (255 = subject). */
async function runMatte(rgb) {
  const n = MATTE_RES * MATTE_RES;
  if (!rgb || rgb.length !== n * 3) throw new Error('Unexpected AI input size.');
  const buf = Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length);
  const cached = path.join(matteDir(), `${crypto.createHash('sha1').update(buf).digest('hex')}.bin`);
  try {
    const b = fs.readFileSync(cached);
    if (b.length === n) return new Uint8Array(b);
  } catch { /* not cached yet */ }
  if (!modelReady()) throw new Error('The RMBG-2.0 model is not downloaded yet.');
  const ort = require('onnxruntime-node');
  const session = await getSession();
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const data = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) data[c * n + i] = (buf[i * 3 + c] / 255 - mean[c]) / std[c];
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, MATTE_RES, MATTE_RES]) });
  const o = out[session.outputNames[session.outputNames.length - 1]].data;
  const matte = new Uint8Array(n);
  for (let i = 0; i < n; i++) matte[i] = Math.round(Math.min(1, Math.max(0, o[i])) * 255);
  fs.mkdirSync(matteDir(), { recursive: true });
  fs.writeFileSync(cached, matte);
  return matte;
}

// One inference at a time: the model is big and a second concurrent run would double the memory use.
handle('ai:matte', (_e, rgb) => {
  const job = aiQueue.then(() => runMatte(rgb));
  aiQueue = job.catch(() => {});
  return job;
});

// Per-image overrides and manual cutout edits, keyed by source path; kept apart from settings.json because they can get large.
handle('edits:get', async () => readJson(editsFile()));
handle('edits:set', async (_e, data) => {
  writeFileAtomic(editsFile(), JSON.stringify(data));
  return true;
});
