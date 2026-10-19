const { app, BrowserWindow, ipcMain, dialog, shell, Menu, net } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IMG_EXT = /\.(webp|png|jpe?g|bmp|gif|tiff?|avif)$/i;
const EXT_RANK = { '.webp': 0, '.png': 1, '.jpg': 2, '.jpeg': 2 };
const IMG_FILTER = [{ name: 'Images', extensions: ['webp', 'png', 'jpg', 'jpeg', 'bmp', 'gif', 'tif', 'tiff', 'avif'] }];

let win = null;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const editsFile = () => path.join(app.getPath('userData'), 'edits.json');

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
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

ipcMain.handle('dlg:folder', async (_e, defaultPath) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dlg:images', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, {
    properties: opts.multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: IMG_FILTER,
    defaultPath: opts.defaultPath
  });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('dlg:save', async (_e, defaultPath, ext = 'webp') => {
  const r = await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  return r.canceled ? null : r.filePath;
});

// Non-recursive scan. Same base name in several formats: webp wins, then png, then jpg (as art_batch_tokenize.py does).
ipcMain.handle('fs:list', async (_e, dir) => {
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
ipcMain.handle('fs:read', async (_e, p) => fs.readFileSync(p));
ipcMain.handle('fs:write', async (_e, p, bytes) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.from(bytes));
  return true;
});
ipcMain.handle('app:defaultFrame', async () => path.join(__dirname, 'assets', 'default.webp'));
ipcMain.handle('fs:exists', async (_e, p) => fs.existsSync(p));
ipcMain.handle('fs:isDir', async (_e, p) => {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
});
ipcMain.handle('shell:show', async (_e, p) => { shell.showItemInFolder(p); });

ipcMain.handle('settings:get', async () => {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
});
ipcMain.handle('settings:set', async (_e, data) => {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(data, null, 2));
  return true;
});

// ---------------------------------------------------------------- AI background removal (RMBG-2.0, FP16 ONNX)
// Community ONNX export of briaai/RMBG-2.0 (CC BY-NC 4.0, personal use). Fixed 1024x1024 input; output is already a 0..1 alpha.
// Mattes are cached by a hash of the model input, so a restart or Save all never re-runs the model for an image it has seen.
const MODEL_URL = 'https://huggingface.co/yamura4/RMBG-2.0-ONNX/resolve/main/onnx/model_fp16.onnx';
const MODEL_SIZE = 512588696;
const MATTE_RES = 1024;
const modelFile = () => path.join(app.getPath('userData'), 'models', 'RMBG-2.0-fp16.onnx');
const matteDir = () => path.join(app.getPath('userData'), 'mattes');
let ortSession = null;
let ortProvider = '';
let aiQueue = Promise.resolve();

const modelReady = () => {
  try { return fs.statSync(modelFile()).size === MODEL_SIZE; } catch { return false; }
};

ipcMain.handle('ai:status', async () => ({ ready: modelReady(), sizeMB: Math.round(MODEL_SIZE / 1e6), provider: ortProvider }));

ipcMain.handle('ai:download', async (e) => {
  const dest = modelFile();
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await net.fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || MODEL_SIZE;
  const out = fs.createWriteStream(part);
  let got = 0;
  let last = 0;
  try {
    for await (const chunk of res.body) {
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      got += chunk.length;
      if (Date.now() - last > 200) { last = Date.now(); e.sender.send('ai:progress', { got, total }); }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (fs.statSync(part).size !== MODEL_SIZE) throw new Error('The downloaded model file has the wrong size.');
  } catch (err) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw err;
  }
  fs.renameSync(part, dest);
  return true;
});

// Fallback when the download is blocked: copy a model_fp16.onnx the user already has into place.
ipcMain.handle('ai:chooseModel', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'ONNX model', extensions: ['onnx'] }] });
  if (r.canceled) return false;
  if (fs.statSync(r.filePaths[0]).size !== MODEL_SIZE) throw new Error('That is not the RMBG-2.0 FP16 model (unexpected file size).');
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
ipcMain.handle('ai:matte', (_e, rgb) => {
  const job = aiQueue.then(() => runMatte(rgb));
  aiQueue = job.catch(() => {});
  return job;
});

// Per-image overrides and manual cutout edits, keyed by source path; kept apart from settings.json because they can get large.
ipcMain.handle('edits:get', async () => {
  try { return JSON.parse(fs.readFileSync(editsFile(), 'utf8')); } catch { return {}; }
});
ipcMain.handle('edits:set', async (_e, data) => {
  fs.mkdirSync(path.dirname(editsFile()), { recursive: true });
  fs.writeFileSync(editsFile(), JSON.stringify(data));
  return true;
});
