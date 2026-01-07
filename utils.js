window.Utils = {
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
  normalizeDisplayPath: function(p) {
    if (!p) return '';
    return String(p).replace(/\\/g, '/');
  },
  pathEndsWithSceSys: function(p) {
    return p && p.toLowerCase().endsWith('/sce_sys');
  },
  sanitizeName: function(name) {
    if (!name) return 'Unknown';
    return String(name).replace(/[<>:"/\\|?*\x00-\x1F!'™@#$%^&[\]{}=+;,`~]/g, '').trim().slice(0, 200) || 'Unknown';
  }
};