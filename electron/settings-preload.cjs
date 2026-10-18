const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apiSettings', {
  read: () => ipcRenderer.invoke('api-settings-read'),
  save: (value) => ipcRenderer.invoke('api-settings-save', value),
});
