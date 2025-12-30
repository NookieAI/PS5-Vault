const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('ppsaApi', {
  pickDirectory: () => ipcRenderer.invoke('open-directory'),
  cancelOperation: () => ipcRenderer.invoke('cancel-operation'),
  scanSourceForPpsa: (sourceDir) => ipcRenderer.invoke('scan-source', sourceDir),
  ensureAndPopulate: (opts) => ipcRenderer.invoke('ensure-and-populate', opts),
  checkConflicts: (items, dest, layout) => ipcRenderer.invoke('check-conflicts', items, dest, layout),
  showInFolder: (targetPath) => ipcRenderer.invoke('show-in-folder', targetPath),
  openExternal: (url) => ipcRenderer.invoke('open-external-link', url),
  copyToClipboard: (text) => ipcRenderer.invoke('clipboard-write', text),
  deleteItem: (item) => ipcRenderer.invoke('delete-item', item),
  renameItem: (item, newName) => ipcRenderer.invoke('rename-item', item, newName),
  moveToLayout: (item, dest, layout) => ipcRenderer.invoke('move-to-layout', item, dest, layout),

  // Listener for progress updates
  onScanProgress: (callback) => {
    ipcRenderer.on('scan-progress', (event, data) => callback(data));
  },
  offScanProgress: () => {
    ipcRenderer.removeAllListeners('scan-progress');
  },
});