const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('callPrompt', { choose: (id, record) => ipcRenderer.send('call-popup-choice', id, record) });
