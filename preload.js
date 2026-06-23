const { contextBridge, ipcRenderer } = require('electron');

let _scanProgressHandler = null;

contextBridge.exposeInMainWorld('ppsaApi', {
  // ── Directory / file ops ────────────────────────────────────────────────
  openDirectory:    ()            => ipcRenderer.invoke('open-directory'),
  showInFolder:     (p)           => ipcRenderer.invoke('show-in-folder', p),
  openExternal:     (url)         => ipcRenderer.invoke('open-external-link', url),
  copyToClipboard:  (text)        => ipcRenderer.invoke('clipboard-write', text),

  // ── Secrets (FTP password encryption at rest, via OS safeStorage) ─────────
  encryptSecret:    (s)           => ipcRenderer.invoke('secret-encrypt', s),
  decryptSecret:    (s)           => ipcRenderer.invoke('secret-decrypt', s),

  // ── Scan ────────────────────────────────────────────────────────────────
  scanSource:       (src, opts)   => ipcRenderer.invoke('scan-source', src, opts),
  getAllDrives:      ()            => ipcRenderer.invoke('get-all-drives'),
  cancelOperation:  ()            => ipcRenderer.invoke('cancel-operation'),
  getCachedCovers:  (keys)        => ipcRenderer.invoke('get-cached-covers', keys),

  // ── Transfer / layout ───────────────────────────────────────────────────
  ensureAndPopulate:(opts)        => ipcRenderer.invoke('ensure-and-populate', opts),
  checkConflicts:   (items, dest, layout, customName) => ipcRenderer.invoke('check-conflicts', items, dest, layout, customName),
  moveToLayout:     (item, dest, layout) => ipcRenderer.invoke('move-to-layout', item, dest, layout),
  resumeTransfer:   (state)       => ipcRenderer.invoke('resume-transfer', state),

  // ── Local item ops ──────────────────────────────────────────────────────
  deleteItem:         (item)        => ipcRenderer.invoke('delete-item', item),
  trashItem:          (item)        => ipcRenderer.invoke('trash-item', item),
  renameItem:         (item, name)  => ipcRenderer.invoke('rename-item', item, name),
  deleteParentFolder: (folderPath)  => ipcRenderer.invoke('delete-parent-folder', folderPath),

  // ── FTP ─────────────────────────────────────────────────────────────────
  ps5Discover:            (timeout)        => ipcRenderer.invoke('ps5-discover', timeout),
  ftpTestConnection:      (cfg)            => ipcRenderer.invoke('ftp-test-connection', cfg),
  ftpStorageInfo:         (cfg, items)     => ipcRenderer.invoke('ftp-storage-info', cfg, items),
  ftpRenameItem:          (cfg, old, nw)   => ipcRenderer.invoke('ftp-rename-item', cfg, old, nw),
  ftpDeleteItem:          (cfg, path)      => ipcRenderer.invoke('ftp-delete-item', cfg, path),
  clearFtpSizeCache:      ()               => ipcRenderer.invoke('clear-ftp-size-cache'),
  ftpCacheStats:          ()               => ipcRenderer.invoke('ftp-cache-stats'),

  // ── Verify / checksums ──────────────────────────────────────────────────
  verifyLibrary:          (items, ftpCfg)  => ipcRenderer.invoke('verify-library', items, ftpCfg),
  listGameSubfolders:     (p, cfg)         => ipcRenderer.invoke('list-game-subfolders', p, cfg),
  getChecksumDb:          ()               => ipcRenderer.invoke('get-checksum-db'),
  recordTransferChecksums:(data)           => ipcRenderer.invoke('record-transfer-checksums', data),

  // ── API server ──────────────────────────────────────────────────────────
  getApiKey:        ()            => ipcRenderer.invoke('get-api-key'),
  getApiStatus:     ()            => ipcRenderer.invoke('get-api-status'),
  regenerateApiKey: ()            => ipcRenderer.invoke('regenerate-api-key'),

  // ── Local disk ──────────────────────────────────────────────────────────
  getLocalFreeSpace: (p)          => ipcRenderer.invoke('get-local-free-space', p),

  // ── Auto-updater ────────────────────────────────────────────────────────
  checkForUpdatesManual:      ()           => ipcRenderer.invoke('check-for-updates-manual'),
  downloadAndInstallUpdate:   (url)        => ipcRenderer.invoke('download-and-install-update', url),

  // ── IPC event listeners ─────────────────────────────────────────────────
  onScanProgress: (cb) => {
    if (_scanProgressHandler) ipcRenderer.removeListener('scan-progress', _scanProgressHandler);
    _scanProgressHandler = (_, d) => cb(d);
    ipcRenderer.on('scan-progress', _scanProgressHandler);
  },
  offScanProgress: () => {
    if (_scanProgressHandler) {
      ipcRenderer.removeListener('scan-progress', _scanProgressHandler);
      _scanProgressHandler = null;
    }
  },
  onOperationComplete:      (cb) => ipcRenderer.on('operation-complete',      (_, d) => cb(d)),
  onUpdateAvailable:        (cb) => ipcRenderer.on('update-available',        (_, d) => cb(d)),
  onUpdateDownloadProgress: (cb) => ipcRenderer.on('update-download-progress',(_, d) => cb(d)),
  onAppVersion:             (cb) => ipcRenderer.on('app-version',             (_, v) => cb(v)),
});
