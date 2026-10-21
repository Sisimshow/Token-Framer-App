const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickFolder: (defaultPath) => ipcRenderer.invoke('dlg:folder', defaultPath),
  pickImages: (opts) => ipcRenderer.invoke('dlg:images', opts),
  pickSave: (defaultPath, ext) => ipcRenderer.invoke('dlg:save', defaultPath, ext),
  listImages: (dir) => ipcRenderer.invoke('fs:list', dir),
  readFile: (p) => ipcRenderer.invoke('fs:read', p),
  writeFile: (p, bytes) => ipcRenderer.invoke('fs:write', p, bytes),
  defaultFramePath: () => ipcRenderer.invoke('app:defaultFrame'),
  exists: (p) => ipcRenderer.invoke('fs:exists', p),
  isDirectory: (p) => ipcRenderer.invoke('fs:isDir', p),
  showInFolder: (p) => ipcRenderer.invoke('shell:show', p),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (data) => ipcRenderer.invoke('settings:set', data),
  getAiStatus: () => ipcRenderer.invoke('ai:status'),
  downloadAiModel: () => ipcRenderer.invoke('ai:download'),
  chooseAiModel: () => ipcRenderer.invoke('ai:chooseModel'),
  aiMatte: (rgb) => ipcRenderer.invoke('ai:matte', rgb),
  onAiProgress: (fn) => ipcRenderer.on('ai:progress', (_e, p) => fn(p)),
  listModels: () => ipcRenderer.invoke('models:list'),
  cleanImage: (name, rgba, w, h) => ipcRenderer.invoke('models:clean', name, rgba, w, h),
  onModelProgress: (fn) => ipcRenderer.on('models:progress', (_e, p) => fn(p)),
  getEdits: () => ipcRenderer.invoke('edits:get'),
  setEdits: (data) => ipcRenderer.invoke('edits:set', data),
  pathForFile: (file) => webUtils.getPathForFile(file)
});
