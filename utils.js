// PS5 Vault Utilities
// Shared utility functions for sanitization, escaping, and normalization.

/**
 * Sanitizes a filename or folder name to remove invalid characters.
 * @param {string} name - The name to sanitize.
 * @returns {string} Sanitized name, or 'Unknown' if invalid.
 */
window.Utils = {
  sanitizeName: function(name) {
    if (!name) return 'Unknown';
    return String(name).replace(/[<>:"/\\|?*\x00-\x1F!'™@#$%^&[\]{}=+;,`~]/g, '').trim().slice(0, 200) || 'Unknown';
  },

  /**
   * Escapes HTML special characters for safe rendering.
   * @param {string} text - The text to escape.
   * @returns {string} Escaped HTML string.
   */
  escapeHtml: function(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, function(m) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[m];
    });
  },

  /**
   * Normalizes display paths, e.g., replaces PS5 paths with friendly names.
   * @param {string} path - The path to normalize.
   * @returns {string} Normalized path string.
   */
  normalizeDisplayPath: function(p) {
    if (!p) return '';
    const path = String(p);
    if (path.startsWith('/mnt/ext1/')) return path.replace('/mnt/ext1/', 'PS5:/');
    if (path.startsWith('/mnt/usb0/')) return path.replace('/mnt/usb0/', 'USB0:/');
    if (path.startsWith('/mnt/usb1/')) return path.replace('/mnt/usb1/', 'USB1:/');
    if (path.startsWith('ftp://')) {
      try {
        const url = new URL(path);
        const decodedPath = decodeURIComponent(url.pathname);
        return `FTP://${url.hostname}:${url.port}${decodedPath}`;
      } catch (e) {
        return path.replace(/\\/g, '/');
      }
    }
    return path.replace(/\\/g, '/');
  },

  /**
   * Checks if a path ends with '/sce_sys'.
   * @param {string} p - The path to check.
   * @returns {boolean} True if ends with sce_sys.
   */
  pathEndsWithSceSys: function(p) {
    return p && p.toLowerCase().endsWith('/sce_sys');
  }
};