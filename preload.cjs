const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickFolder: (defaultPath) => ipcRenderer.invoke('dlg:folder', defaultPath),
  pickImages: (opts) => ipcRenderer.invoke('dlg:images', opts),
  pickSave: (defaultPath) => ipcRenderer.invoke('dlg:save', defaultPath),
  listImages: (dir) => ipcRenderer.invoke('fs:list', dir),
  readFile: (p) => ipcRenderer.invoke('fs:read', p),
  writeFile: (p, bytes) => ipcRenderer.invoke('fs:write', p, bytes),
  defaultFramePath: () => ipcRenderer.invoke('app:defaultFrame'),
  exists: (p) => ipcRenderer.invoke('fs:exists', p),
  isDirectory: (p) => ipcRenderer.invoke('fs:isDir', p),
  showInFolder: (p) => ipcRenderer.invoke('shell:show', p),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (data) => ipcRenderer.invoke('settings:set', data),
  getEdits: () => ipcRenderer.invoke('edits:get'),
  setEdits: (data) => ipcRenderer.invoke('edits:set', data),
  pathForFile: (file) => webUtils.getPathForFile(file)
});
