// Safe bridge between the main process and the renderer windows.
// Expose one narrow function per capability — never the whole ipcRenderer.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('friday', {
  preflight: () => ipcRenderer.invoke('friday:preflight'),
  openSettings: (pane) => ipcRenderer.invoke('friday:open-settings', pane),
});
