const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('modLogsApi', {
  state: () => ipcRenderer.invoke('mod-logs-window:state'),
  clear: () => ipcRenderer.invoke('mod-logs-window:clear'),
  requestRemove: (logId) => ipcRenderer.invoke('mod-logs-window:remove-request', logId),
  close: () => ipcRenderer.send('mod-logs-window:close'),
  onChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('mod-logs-window:changed', listener);
    return () => ipcRenderer.removeListener('mod-logs-window:changed', listener);
  }
});
