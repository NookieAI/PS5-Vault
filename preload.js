// preload.js — exposes the minimal safe API the renderer expects
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ppsaApi', {
  // Open folder picker and return selected path or null
  pickDirectory: async () => {
    try {
      const res = await ipcRenderer.invoke('open-directory');
      if (!res) return null;
      return (!res.canceled && res.path) ? res.path : null;
    } catch (e) { return null; }
  },

  // Scan a source path for PPSA/content folders
  scanSourceForPpsa: async (source) => {
    try {
      return await ipcRenderer.invoke('scan-source', source);
    } catch (e) { return { error: String(e && e.message ? e.message : e) }; }
  },

  // Ensure and populate (copy/move/create)
  ensureAndPopulate: async (opts) => {
    try {
      return await ipcRenderer.invoke('ensure-and-populate', opts);
    } catch (e) { return { error: String(e && e.message ? e.message : e) }; }
  },

  // Show a path in explorer
  showInFolder: async (p) => {
    try {
      return await ipcRenderer.invoke('show-in-folder', p);
    } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  },

  // Subscribe to scan-progress events. cb receives a single argument (data).
  // Returns an unsubscribe function.
  onScanProgress: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (event, data) => {
      try { cb(data); } catch (e) { /* swallow errors from renderer cb */ }
    };
    ipcRenderer.on('scan-progress', listener);
    return () => {
      try { ipcRenderer.removeListener('scan-progress', listener); } catch (e) {}
    };
  },

  // Subscribe to operation-complete events (sent after ensure-and-populate finishes).
  // cb receives one argument: { success: boolean, resultsCount?: number }
  // Returns an unsubscribe function.
  onOperationComplete: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (event, data) => {
      try { cb(data); } catch (e) {}
    };
    ipcRenderer.on('operation-complete', listener);
    return () => {
      try { ipcRenderer.removeListener('operation-complete', listener); } catch (e) {}
    };
  },

  // Expose a checkPathsExist ipc for conflict detection
  checkPathsExist: async (paths) => {
    try {
      return await ipcRenderer.invoke('check-paths-exist', paths);
    } catch (e) { return (paths || []).map(p => ({ path: p, exists: false, error: String(e) })); }
  },

  // Open devtools (renderer can request)
  openDevtools: () => {
    ipcRenderer.send('open-devtools');
  },

  // Beta expiry helper
  getBetaExpires: () => {
    try { return process.env.BETA_EXPIRES || null; } catch (e) { return null; }
  },

  continueToApp: () => ipcRenderer.send('splash-continue'),
  quitApp: () => ipcRenderer.send('splash-quit')
});