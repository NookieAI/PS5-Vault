(function () {
  'use strict';

  const Utils = {
    // Sanitize filename: remove invalid chars, limit length
    sanitizeName: function (name) {
      if (!name) return 'Unknown';
      return String(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim().slice(0, 200) || 'Unknown';
    },

    // Escape HTML for safe display
    escapeHtml: function (text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    },

    // Normalize path for display (replace backslashes)
    normalizeDisplayPath: function (path) {
      if (!path) return '';
      return String(path).replace(/\\/g, '/');
    },

    // Check if path ends with 'sce_sys'
    pathEndsWithSceSys: function (path) {
      if (!path) return false;
      const parts = String(path).split(/[\\/]/);
      return parts.length >= 2 && parts[parts.length - 1].toLowerCase() === 'sce_sys';
    },

    // Convert file:// URL to path
    fileUrl: function (filePath) {
      if (!filePath) return '';
      return `file://${encodeURIComponent(filePath).replace(/%3A/g, ':').replace(/%5C/g, '/')}`;
    }
  };

  // Expose to global scope
  if (typeof window !== 'undefined') {
    window.Utils = Utils;
  }
})();