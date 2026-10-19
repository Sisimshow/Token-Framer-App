const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
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
ipcMain.handle('dlg:save', async (_e, defaultPath) => {
  const r = await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: 'WebP', extensions: ['webp'] }] });
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

// Per-image overrides and manual cutout edits, keyed by source path; kept apart from settings.json because they can get large.
ipcMain.handle('edits:get', async () => {
  try { return JSON.parse(fs.readFileSync(editsFile(), 'utf8')); } catch { return {}; }
});
ipcMain.handle('edits:set', async (_e, data) => {
  fs.mkdirSync(path.dirname(editsFile()), { recursive: true });
  fs.writeFileSync(editsFile(), JSON.stringify(data));
  return true;
});
