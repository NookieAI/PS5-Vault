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
  clearFtpSizeCache: () => ipcRenderer.invoke('clear-ftp-size-cache'),
  ftpCacheStats: () => ipcRenderer.invoke('ftp-cache-stats'),
  moveToLayout: (item, dest, layout) => ipcRenderer.invoke('move-to-layout', item, dest, layout),
  resumeTransfer: (state) => ipcRenderer.invoke('resume-transfer', state),
  getAllDrives: () => ipcRenderer.invoke('get-all-drives'),

  // Listener for progress updates
  onScanProgress: (callback) => {
    ipcRenderer.on('scan-progress', (event, data) => callback(data));
  },
  offScanProgress: () => {
    ipcRenderer.removeAllListeners('scan-progress');
  },

  // Auto-updater
  onUpdateAvailable: (callback) => {
    ipcRenderer.on('update-available', (event, info) => callback(info));
  },
  onAppVersion: (callback) => {
    ipcRenderer.on('app-version', (event, ver) => callback(ver));
  },
  onUpdateDownloadProgress: (callback) => {
    ipcRenderer.on('update-download-progress', (event, data) => callback(data));
  },
  downloadAndInstallUpdate: (downloadUrl) => ipcRenderer.invoke('download-and-install-update', downloadUrl),
  checkForUpdatesManual:    ()             => ipcRenderer.invoke('check-for-updates-manual'),

  // Developer API management
  getApiStatus:      ()       => ipcRenderer.invoke('get-api-status'),
  getApiKey:         ()       => ipcRenderer.invoke('get-api-key'),
  regenerateApiKey:  ()       => ipcRenderer.invoke('regenerate-api-key'),

  // FTP utilities
  ftpTestConnection: (config) => ipcRenderer.invoke('ftp-test-connection', config),
});