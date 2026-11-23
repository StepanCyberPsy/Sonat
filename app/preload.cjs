const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sonat', {
  info: () => ipcRenderer.invoke('info'),
  folder: () => ipcRenderer.invoke('folder'),
  showFolder: () => ipcRenderer.invoke('show-folder'),
  start: mode => ipcRenderer.invoke('start', mode),
  samples: (id, samples) => ipcRenderer.invoke('samples', id, samples),
  stop: id => ipcRenderer.invoke('stop', id),
  apiKey: value => ipcRenderer.invoke('api-key', value),
  transcribe: id => ipcRenderer.invoke('transcribe', id),
  onProgress: fn => ipcRenderer.on('progress', (_, i, n) => fn(i, n)),
  nextPart: id => ipcRenderer.invoke('next-part', id),
  savePart: (id, name, text) => ipcRenderer.invoke('save-part', id, name, text),
  revealPart: id => ipcRenderer.invoke('reveal-part', id),
  openChat: () => ipcRenderer.invoke('open-chat'),
  copyPrompt: () => ipcRenderer.invoke('copy-prompt')
});
