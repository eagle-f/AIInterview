const { contextBridge, ipcRenderer } = require('electron');

function cacheCall(operation, value) {
  const result = ipcRenderer.sendSync('interview-cache', operation, value);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

contextBridge.exposeInMainWorld('desktopSession', {
  read: () => cacheCall('read'),
  write: (value) => cacheCall('write', value),
  clear: () => cacheCall('clear'),
});
