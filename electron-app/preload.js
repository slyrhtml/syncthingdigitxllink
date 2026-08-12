const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('syncthingDesktop', {
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder')
});
