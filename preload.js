const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('ppsaApi', {
  openDirectory: () => ipcRenderer.invoke('open-directory'),
  cancelOperation: () => ipcRenderer.invoke('cancel-operation'),
  scanSource: (sourceDir, opts) => ipcRenderer.invoke('scan-source', sourceDir, opts),
  ensureAndPopulate: (opts) => ipcRenderer.invoke('ensure-and-populate', opts),
  checkConflicts: (items, dest, layout, customName) => ipcRenderer.invoke('check-conflicts', items, dest, layout, customName),
  showInFolder: (targetPath) => ipcRenderer.invoke('show-in-folder', targetPath),
  openExternal: (url) => ipcRenderer.invoke('open-external-link', url),
  copyToClipboard: (text) => ipcRenderer.invoke('clipboard-write', text),
  deleteItem: (item) => ipcRenderer.invoke('delete-item', item),
  renameItem: (item, newName) => ipcRenderer.invoke('rename-item', item, newName),
  ftpRenameItem: (config, oldPath, newPath) => ipcRenderer.invoke('ftp-rename-item', config, oldPath, newPath),
  ftpDeleteItem: (config, path) => ipcRenderer.invoke('ftp-delete-item', config, path),
  moveToLayout: (item, dest, layout) => ipcRenderer.invoke('move-to-layout', item, dest, layout),
  resumeTransfer: (state) => ipcRenderer.invoke('resume-transfer', state),
  getAllDrives: () => ipcRenderer.invoke('get-all-drives'),
  clearFtpSizeCache: () => ipcRenderer.invoke('clear-ftp-size-cache'),
  ftpCacheStats: () => ipcRenderer.invoke('ftp-cache-stats'),
  checkForUpdatesManual: () => ipcRenderer.invoke('check-for-updates-manual'),
  downloadAndInstallUpdate: (url) => ipcRenderer.invoke('download-and-install-update', url),

  // Listener for scan/transfer progress updates
  onScanProgress: (callback) => {
    ipcRenderer.on('scan-progress', (_event, data) => callback(data));
  },
  offScanProgress: () => {
    ipcRenderer.removeAllListeners('scan-progress');
  },

  // App version — sent by main process after did-finish-load
  onAppVersion: (callback) => {
    ipcRenderer.on('app-version', (_event, ver) => callback(ver));
  },

  // Auto-updater events
  onUpdateAvailable: (callback) => {
    ipcRenderer.on('update-available', (_event, info) => callback(info));
  },
  onUpdateDownloadProgress: (callback) => {
    ipcRenderer.on('update-download-progress', (_event, info) => callback(info));
  },
});