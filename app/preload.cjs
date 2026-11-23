const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sonat', {
  info: () => ipcRenderer.invoke('info'),
  setShortcut: value => ipcRenderer.invoke('set-shortcut', value),
  onShortcutError: fn => ipcRenderer.on('shortcut-error', (_, message) => fn(message)),
  onSettings: fn => ipcRenderer.on('settings', () => fn()),
  folder: () => ipcRenderer.invoke('folder'),
  showFolder: () => ipcRenderer.invoke('show-folder'),
  start: mode => ipcRenderer.invoke('start', mode),
  samples: (id, samples) => ipcRenderer.invoke('samples', id, samples),
  stop: id => ipcRenderer.invoke('stop', id),
  shortcutCapture: active => ipcRenderer.invoke('shortcut-capture', active),
  updateApp: () => ipcRenderer.invoke('update-app'),
  onUpdate: fn => ipcRenderer.on('update-progress', (_, text) => fn(text)),
  apiKey: value => ipcRenderer.invoke('api-key', value),
  transcribe: id => ipcRenderer.invoke('transcribe', id),
  onProgress: fn => ipcRenderer.on('progress', (_, i, n) => fn(i, n)),
  nextPart: id => ipcRenderer.invoke('next-part', id),
  savePart: (id, name, text) => ipcRenderer.invoke('save-part', id, name, text),
  revealPart: id => ipcRenderer.invoke('reveal-part', id),
  openChat: () => ipcRenderer.invoke('open-chat'),
  copyPrompt: () => ipcRenderer.invoke('copy-prompt')
});
