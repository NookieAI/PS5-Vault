(function () {
  'use strict';

  // Global API for Scanning
  window.ScanApi = {
    scanSource: scanSource,
    onProgressMessage: onProgressMessage
  };

  function onProgressMessage(data) {
    // Handle scan progress updates (e.g., update UI labels)
    if (data.type === 'scan') {
      const label = document.getElementById('currentScanLabel');
      if (label) {
        const pathText = data.folder || data.path || '';
        label.textContent = Utils.normalizeDisplayPath(pathText) || 'Scanning...';
      }
    }
  }

  async function scanSource(src, showScanUI, toast) {
    try {
      if (!src) {
        toast('Select source first');
        return;
      }
      let actualSrc = src;
      window.isFtpScan = false;
      window.ftpConfig = null;
      if (src === 'browse') {
        const result = await window.ppsaApi.pickDirectory();
        if (!result.canceled && result.path) {
          actualSrc = result.path;
          addRecentSource(result.path);
        } else {
          return;
        }
      } else if (src === 'ftp') {
        const ftpUrl = prompt('Enter FTP URL (e.g., ftp://192.168.1.100 or 192.168.1.100/mnt/ext1/etaHEN/games):');
        if (ftpUrl) {
          actualSrc = ftpUrl.startsWith('ftp://') ? ftpUrl : 'ftp://' + ftpUrl;
          addRecentSource(ftpUrl);
        } else {
          return;
        }
      } else if (src.startsWith('ftp://') || /^\d+\.\d+\.\d+\.\d+/.test(src)) {
        // Open FTP modal for configuration
        const config = await window.FtpApi.openFtpModal(src);
        if (config) {
          window.ftpConfig = config;
          window.isFtpScan = true;
          actualSrc = 'ftp://' + config.host + ':' + config.port + config.path;
          addRecentFtp(actualSrc);
        } else {
          return;
        }
      } else {
        addRecentSource(src);
      }
      localStorage.setItem('ps5vault.lastSource', actualSrc);
      showScanUI(true);
      document.getElementById('btnGoBig').disabled = true;
      document.getElementById('currentScanLabel').textContent = 'Scanning...';
      const startTime = Date.now();
      const res = await window.ppsaApi.scanSourceForPpsa(actualSrc);
      const arr = Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
      const duration = Math.round((Date.now() - startTime) / 1000);
      window.RendererApi.renderResults(arr, duration);
      document.getElementById('btnGoBig').disabled = false;
      window.currentSortBy = 'name';
    } catch (e) {
      console.error(e);
      alert('Error scanning: ' + e.message);
    }
  }

  // Helper functions (extracted from renderer.js for modularity)
  function addRecentSource(path) {
    if (!path) return;
    const recents = getRecentSources();
    const filtered = recents.filter(p => p !== path);
    filtered.unshift(path);
    const limited = filtered.slice(0, 10);
    localStorage.setItem('ps5vault.recentSources', JSON.stringify(limited));
    updateSourceHistoryDatalist();
  }

  function addRecentFtp(url) {
    if (!url) return;
    const recents = getRecentFtp();
    const filtered = recents.filter(p => p !== url);
    filtered.unshift(url);
    const limited = filtered.slice(0, 5);
    localStorage.setItem('ps5vault.recentFtp', JSON.stringify(limited));
  }

  function getRecentSources() {
    try {
      const stored = localStorage.getItem('ps5vault.recentSources');
      return stored ? JSON.parse(stored) : [];
    } catch (_) {
      return [];
    }
  }

  function getRecentFtp() {
    try {
      const stored = localStorage.getItem('ps5vault.recentFtp');
      return stored ? JSON.parse(stored) : [];
    } catch (_) {
      return [];
    }
  }

  function updateSourceHistoryDatalist() {
    const datalist = document.getElementById('sourceHistory');
    if (!datalist) return;
    datalist.innerHTML = '';
    const recents = getRecentSources();
    for (const path of recents) {
      const option = document.createElement('option');
      option.value = path;
      datalist.appendChild(option);
    }
  }
})();