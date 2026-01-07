(function () {
  'use strict';

  const LAST_SRC_KEY = 'ps5vault.lastSource';
  const LAST_DST_KEY = 'ps5vault.lastDest';
  const LAST_RESULTS_KEY = 'ps5vault.lastResults';
  const SETTINGS_KEY = 'ps5vault.settings';
  const TRANSFER_STATE_KEY = 'ps5vault.transferState';
  const RECENT_SOURCES_KEY = 'ps5vault.recentSources';
  const RECENT_DESTS_KEY = 'ps5vault.recentDests';

  const $ = id => document.getElementById(id);
  const log = (...a) => console.log('[renderer]', ...a);
  const err = (...a) => console.error('[renderer]', ...a);

  let cancelOperation = false;
  let transferState = JSON.parse(localStorage.getItem(TRANSFER_STATE_KEY) || '{}');
  let settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  let scanStartTime = 0;
  let transferStartTime = 0;
  let currentSortBy = 'name';  // Track current sort column ('name', 'size', 'folder')
  let resumeState = null;

  function getRecentSources() {
    try {
      const stored = localStorage.getItem(RECENT_SOURCES_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch (_) {
      return [];
    }
  }

  function getRecentDests() {
    try {
      const stored = localStorage.getItem(RECENT_DESTS_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch (_) {
      return [];
    }
  }

  function addRecentSource(path) {
    if (!path) return;
    console.log('Adding recent source:', path);
    const recents = getRecentSources();
    const filtered = recents.filter(p => p !== path);
    filtered.unshift(path);
    const limited = filtered.slice(0, 10);
    try {
      localStorage.setItem(RECENT_SOURCES_KEY, JSON.stringify(limited));
    } catch (_) {}
    updateSourceHistoryDatalist();
  }

  function addRecentDest(path) {
    if (!path) return;
    console.log('Adding recent dest:', path);
    const recents = getRecentDests();
    const filtered = recents.filter(p => p !== path);
    filtered.unshift(path);
    const limited = filtered.slice(0, 10);
    try {
      localStorage.setItem(RECENT_DESTS_KEY, JSON.stringify(limited));
    } catch (_) {}
    updateDestHistoryDatalist();
  }

  function updateSourceHistoryDatalist() {
    const datalist = $('sourceHistory');
    if (!datalist) return;
    datalist.innerHTML = '';
    const recents = getRecentSources();
    for (const path of recents) {
      const option = document.createElement('option');
      option.value = path;
      datalist.appendChild(option);
    }
  }

  function updateDestHistoryDatalist() {
    const datalist = $('destHistory');
    if (!datalist) return;
    datalist.innerHTML = '';
    const recents = getRecentDests();
    for (const path of recents) {
      const option = document.createElement('option');
      option.value = path;
      datalist.appendChild(option);
    }
  }

  /**
   * Sets the result modal to busy state.
   * @param {boolean} busy - Whether the modal is busy.
   */
  function setResultModalBusy(busy) {
    const modal = document.querySelector('.result-modal-wide');
    const closeBtn = $('resultClose');
    if (!modal) return;
    if (busy) {
      modal.classList.add('busy');
      if (closeBtn) closeBtn.style.display = 'none';
    } else {
      modal.classList.remove('busy');
      if (closeBtn) closeBtn.style.display = 'block';
    }
  }

  /**
   * Shows or hides the scan UI.
   * @param {boolean} show - Whether to show the UI.
   */
  function showScanUI(show) {
    const sd = $('scanDisplay');
    const label = $('currentScanLabel');
    const cancelBtn = $('btnCancelScan');
    if (sd) sd.style.display = show ? 'block' : 'none';
    if (!show && label) label.textContent = '';
    if (cancelBtn) cancelBtn.style.display = show ? 'inline-block' : 'none';
    if (show) {
    }
  }

  const TransferStats = {
    startTime: 0,
    lastTime: 0,
    lastBytes: 0,
    emaSpeed: 0,
    reset() {
      this.startTime = Date.now();
      this.lastTime = this.startTime;
      this.lastBytes = 0;
      this.emaSpeed = 0;
    },
    update(totalBytesCopied, totalBytes) {
      const now = Date.now();
      const dt = Math.max(1, (now - this.lastTime) / 1000);
      const delta = Math.max(0, totalBytesCopied - this.lastBytes);
      const instSpeed = delta / dt;
      const alpha = 0.25;
      this.emaSpeed = this.emaSpeed ? (alpha * instSpeed + (1 - alpha) * this.emaSpeed) : instSpeed;
      this.lastTime = now;
      this.lastBytes = totalBytesCopied;
      const remaining = Math.max(0, totalBytes - totalBytesCopied);
      const etaSec = this.emaSpeed > 0 ? (remaining / this.emaSpeed) : 0;
      return {
        speedBps: Number.isFinite(this.emaSpeed) ? this.emaSpeed : 0,
        etaSec: Number.isFinite(etaSec) ? etaSec : 0
      };
    }
  };

  /**
   * Converts bytes to human-readable format.
   * @param {number} b - Bytes.
   * @returns {string} Formatted string.
   */
  function bytesToHuman(b) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = b;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(1)} ${units[i]}`;
  }

  /**
   * Converts seconds to H:MM:SS format.
   * @param {number} s - Seconds.
   * @returns {string} Formatted time.
   */
  function secToHMS(s) {
    const sec = Math.round(Number.isFinite(s) ? s : 0);
    if (sec < 1) return sec >= 0 ? '0:00' : '--:--';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const r = sec % 60;
    return h > 0 ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }

  let lastFile = '';
  let completedFiles = [];

  /**
   * Handles progress messages from the main process.
   * @param {object} d - Progress data.
   */
  function onProgressMessage(d) {
    if (!d || !d.type) return;

    if (d.type === 'scan') {
      const label = $('currentScanLabel');
      if (label) {
        const pathText = d.folder || d.path || '';
        label.textContent = Utils.normalizeDisplayPath(pathText) || 'Scanning...';
      }
      return;
    }

    if (d.type === 'go-start') {
      setResultModalBusy(true);
      TransferStats.reset();
      completedFiles = [];
      transferStartTime = Date.now();
      const rb = $('resultModalBackdrop');
      const rp = $('resultProgress');
      const rl = $('resultList');
      const rc = $('resultCount');
      const rs = $('resultSubText');
      const cf = $('currentFileInfo');
      const comp = $('completedFiles');
      if (rb && rp && rl && rc && rs && cf && comp) {
        rp.style.display = 'block';
        rl.style.display = 'none';
        rc.textContent = '0';
        rs.textContent = 'Transferring...';
        cf.textContent = 'Preparing...';
        comp.innerHTML = '';
        rb.style.display = 'flex';
        rb.setAttribute('aria-hidden', 'false');
      }
      cancelOperation = false;
      return;
    }

    if (d.type === 'go-file-progress' || d.type === 'go-file-complete') {
      if (cancelOperation) return;
      if (d.fileRel) lastFile = d.fileRel;
      // Use d.totalBytesCopied directly (now cumulative from main)
      const stats = TransferStats.update(d.totalBytesCopied || 0, d.totalBytes || 0);
      const rs = $('resultSubText');
      const re = $('resultEta');
      const cf = $('currentFileInfo');
      if (rs && re && cf) {
        const speedHuman = bytesToHuman(stats.speedBps || 0) + '/s';
        const etaText = secToHMS(stats.etaSec);
        const baseText = `Progress: ${Math.round((d.totalBytesCopied / d.totalBytes) * 100)}% • ${speedHuman}${lastFile ? ' • ' + lastFile : ''}`;
        rs.textContent = baseText;
        re.textContent = etaText;
        cf.textContent = lastFile ? `Current: ${lastFile} (${Math.round((d.totalBytesCopied / d.totalBytes) * 100)}%)` : 'Preparing...';
      }
      if (d.type === 'go-file-complete') {
        completedFiles.push(d.fileRel);
        const comp = $('completedFiles');
        if (comp) {
          const div = document.createElement('div');
          div.className = 'completed-file';
          div.textContent = d.fileRel;
          comp.insertBefore(div, comp.firstChild);
        }
      }
      return;
    }

    if (d.type === 'go-complete') {
      setResultModalBusy(false);
      const rp = $('resultProgress');
      const rl = $('resultList');
      const rs = $('resultSubText');
      const closeBtn = $('resultClose');
      const label = $('currentScanLabel');
      if (rp) rp.style.display = 'none';
      if (rl) rl.style.display = 'block';
      if (closeBtn) closeBtn.style.display = 'block';
      if (rs) rs.textContent = 'Operation complete';
      if (label) label.textContent = '';
      showScanUI(false);
      showNotification('Transfer Complete', 'PS5 Vault operation finished successfully.');
      localStorage.removeItem(TRANSFER_STATE_KEY);
      return;
    }

    if (d.type === 'go-item') {
      const label = $('currentScanLabel');
      const raw = d.folder || d.path || '';
      if (label) label.textContent = Utils.pathEndsWithSceSys(raw) ? '' : (Utils.normalizeDisplayPath(raw) || '');
      return;
    }
  }

  /**
   * Formats content version (keeps original, cleans leading zeros).
   * @param {string} cv - Content version.
   * @returns {string} Cleaned version.
   */
  function formatContentVersionShort(cv) {
    if (!cv) return '';
    return cv;
  }

  /**
   * Formats SDK version.
   * @param {string} hex - SDK version hex.
   * @returns {string} Formatted SDK.
   */
  function formatSdkVersionHexToDisplay(hex) {
    if (!hex || typeof hex !== 'string') return '';
    const m = hex.trim().match(/^0x([0-9A-Fa-f]{2})/);
    if (!m) return '';
    const majorHex = m[1];
    const major = parseInt(majorHex, 16);
    if (Number.isNaN(major)) return '';
    return `${major}.xx`;
  }

  /**
   * Checks if SDK version should add plus.
   * @param {string|Array} sdkValue - SDK value.
   * @returns {boolean} Whether to add plus.
   */
  function shouldAddPlus(sdkValue) {
    return false;
  }

  /**
   * Gets identity key for deduplication.
   * @param {object} item - Item object.
   * @returns {string} Key.
   */
  function identityKey(item) {
    const key = item.ppsa || item.contentId || item.displayTitle || item.dbTitle || item.folderName || '';
    return String(key).toLowerCase();
  }

  /**
   * Gets primary path of item.
   * @param {string} item - Item object.
   * @returns {string} Path.
   */
  function primaryPathOf(item) {
    return item.ppsaFolderPath || item.folderPath || item.contentFolderPath || '';
  }

  /**
   * Checks if one path is nested in another.
   * @param {string} child - Child path.
   * @param {string} parent - Parent path.
   * @returns {boolean} Is nested.
   */
  function isNestedPath(child, parent) {
    if (!child || !parent) return false;
    const c = String(child).replace(/\//g, '\\');
    const p = String(parent).replace(/\//g, '\\');
    if (c.toLowerCase() === p.toLowerCase()) return true;
    return c.toLowerCase().startsWith(p.toLowerCase() + '\\');
  }

  /**
   * Deduplicates items list.
   * @param {Array} list - Items list.
   * @returns {Array} Deduplicated list.
   */
  function dedupeItems(list) {
    const groups = new Map();
    for (const r of list) {
      const key = identityKey(r);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const out = [];
    for (const [, arr] of groups) {
      if (arr.length === 1) {
        out.push(arr[0]);
        continue;
      }
      const keep = [];
      for (let i = 0; i < arr.length; i++) {
        const a = arr[i];
        const aPath = primaryPathOf(a);
        let nested = false;
        for (let j = 0; j < arr.length; j++) {
          if (i === j) continue;
          const b = arr[j];
          const bPath = primaryPathOf(b);
          if (isNestedPath(aPath, bPath)) {
            nested = true;
            break;
          }
        }
        if (!nested) keep.push(a);
      }
      const seenPaths = new Set();
      for (const k of keep) {
        const p = String(primaryPathOf(k)).toLowerCase();
        if (!seenPaths.has(p)) {
          out.push(k);
          seenPaths.add(p);
        }
      }
    }
    return out;
  }

  // Hover preview (1s delay)
  const Preview = {
    container: null,
    img: null,
    visible: false,
    timer: null,
    lastX: 0,
    lastY: 0,
    delayMs: 1000,
    init() {
      this.container = $('imgPreview');
      this.img = $('imgPreviewImg');
      if (!this.container || !this.img) return;
      this.container.style.display = 'none';
      this.container.setAttribute('aria-hidden', 'true');
    },
    scheduleShow(src) {
      this.cancel();
      this.timer = setTimeout(() => {
        this.show(src, this.lastX, this.lastY);
      }, this.delayMs);
    },
    show(src, x, y) {
      if (!this.container || !this.img) return;
      this.img.src = src || '';
      this.container.style.display = 'block';
      this.container.setAttribute('aria-hidden', 'false');
      this.visible = true;
      this.move(x, y);
    },
    move(x, y) {
      if (!this.container || !this.visible) {
        this.lastX = x;
        this.lastY = y;
        return;
      }
      this.lastX = x;
      this.lastY = y;
      const cw = this.container.offsetWidth;
      const ch = this.container.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = x + 18;
      let top = y + 18;
      if (left + cw > vw - 8) left = Math.max(8, x - cw - 18);
      if (top + ch > vh - 8) top = Math.max(8, y - ch - 18);
      this.container.style.left = `${left}px`;
      this.container.style.top = `${top}px`;
    },
    hide() {
      if (!this.container) return;
      this.container.style.display = 'none';
      this.container.setAttribute('aria-hidden', 'true');
      this.visible = false;
      if (this.img) this.img.src = '';
      this.cancel();
    },
    cancel() {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }
  };

  /**
   * Attaches preview handlers to image element.
   * @param {HTMLElement} imgEl - Image element.
   * @param {string} srcUrl - Source URL.
   */
  function attachPreviewHandlers(imgEl, srcUrl) {
    if (!imgEl || !srcUrl) return;
    const onEnter = (ev) => {
      Preview.lastX = ev.clientX;
      Preview.lastY = ev.clientY;
      Preview.scheduleShow(srcUrl);
    };
    const onMove = (ev) => {
      Preview.move(ev.clientX, ev.clientY);
    };
    const onLeave = () => {
      Preview.hide();
    };
    imgEl.addEventListener('mouseenter', onEnter);
    imgEl.addEventListener('mousemove', onMove);
    imgEl.addEventListener('mouseleave', onLeave);
    imgEl.addEventListener('click', onLeave);
  }

  // Conflict modal (existing)
  function openConflictModal(conflicts, onChoice) {
    const backdrop = $('conflictModalBackdrop');
    const listEl = $('conflictList');
    const proceedBtn = $('conflictProceed');
    const cancelBtn = $('conflictCancel');
    if (!backdrop || !listEl || !proceedBtn || !cancelBtn) {
      onChoice && onChoice('rename');
      return;
    }
    listEl.innerHTML = '';
    const ul = document.createElement('ul');
    ul.style.margin = '0';
    ul.style.paddingLeft = '18px';
    for (const c of conflicts) {
      const li = document.createElement('li');
      li.innerHTML = `<strong>${Utils.escapeHtml(c.item || '')}</strong><br><span style="color:var(--muted)">${Utils.escapeHtml(c.target || '')}</span>`;
      ul.appendChild(li);
    }
    listEl.appendChild(ul);

    const getSelected = () => {
      const radios = Array.from(document.querySelectorAll('input[name="conflictAction"]'));
      const r = radios.find(x => x.checked);
      return r ? r.value : 'rename';
    };

    const cleanup = () => {
      backdrop.style.display = 'none';
      backdrop.setAttribute('aria-hidden', 'true');
      proceedBtn.removeEventListener('click', onProceed);
      cancelBtn.removeEventListener('click', onCancel);
    };
    const onProceed = () => {
      const val = getSelected();
      cleanup();
      onChoice && onChoice(val);
    };
    const onCancel = () => {
      cleanup();
      onChoice && onChoice('skip');
    };

    proceedBtn.addEventListener('click', onProceed);
    cancelBtn.addEventListener('click', onCancel);

    backdrop.style.display = 'flex';
    backdrop.setAttribute('aria-hidden', 'true');
  }

  // NEW: Confirmation modal (before transfer)
  function openConfirmModal(previewItems, meta, onProceedCb, onCancelCb) {
    const backdrop = $('confirmModalBackdrop');
    const listEl = $('confirmList');
    const summaryEl = $('confirmSummary');
    const btnGo = $('confirmProceed');
    const btnCancel = $('confirmCancel');
    if (!backdrop || !listEl || !btnGo || !btnCancel) {
      onProceedCb && onProceedCb();
      return;
    }

    const count = previewItems.length;
    const act = String(meta.action || '').toUpperCase();
    const layoutLabel = {
      'game-ppsa': 'Game / PPSA',
      'game-only': 'Game only',
      'ppsa-only': 'PPSA only',
      'etahen': 'etaHEN default',
      'itemzflow': 'itemZFlow default',
      'dump_runner': 'Dump Runner default',
      'custom': 'Custom'
    }[meta.layout] || meta.layout;
    if (summaryEl) summaryEl.textContent = `${count} item(s) • Action: ${act} • Layout: ${layoutLabel}`;

    listEl.innerHTML = '';
    for (const p of previewItems) {
      const row = document.createElement('div');
      row.className = 'modal-content-entry';
      Object.assign(row.style, { display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' });

      const title = document.createElement('div');
      title.className = 'entry-title';
      title.textContent = p.item || 'Unknown Game';
      row.appendChild(title);

      const pathRow = document.createElement('div');
      pathRow.className = 'path-row';
      const from = document.createElement('div');
      from.className = 'path-inline';
      from.innerHTML = '<span class="label-bold">From:</span> ' + Utils.escapeHtml(Utils.normalizeDisplayPath(p.source || ''));
      const to = document.createElement('div');
      to.className = 'path-inline';
      to.innerHTML = '<span class="label-bold">To:</span> ' + Utils.escapeHtml(p.target || '');
      Object.assign(pathRow.style, { display: 'flex', flexDirection: 'column', gap: '4px' });
      pathRow.appendChild(from);
      pathRow.appendChild(to);
      row.appendChild(pathRow);

      listEl.appendChild(row);
    }

    const cleanup = () => {
      backdrop.style.display = 'none';
      backdrop.setAttribute('aria-hidden', 'true');
      btnGo.removeEventListener('click', onGo);
      btnCancel.removeEventListener('click', onCancel);
    };
    const onGo = () => {
      cleanup();
      onProceedCb && onProceedCb();
    };
    const onCancel = () => {
      cleanup();
      onCancelCb && onCancelCb();
    };

    btnGo.addEventListener('click', onGo);
    btnCancel.addEventListener('click', onCancel);

    backdrop.style.display = 'flex';
    backdrop.setAttribute('aria-hidden', 'true');
  }

  // Theme toggle
  function toggleTheme() {
    const body = document.body;
    const current = body.getAttribute('data-theme') || 'dark';
    const newTheme = current === 'dark' ? 'light' : 'dark';
    body.setAttribute('data-theme', newTheme);
    settings.theme = newTheme;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    toast(`Theme switched to ${newTheme}`);
  }

  // Export/Import (hidden for now)
  function exportData() {
    const data = {
      results: window.__ps5_lastRenderedItems || [],
      settings: settings
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ps5vault-export.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('Data exported');
  }

  function importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (data.results) {
            renderResults(data.results);
            localStorage.setItem(LAST_RESULTS_KEY, JSON.stringify(data.results));
          }
          if (data.settings) {
            settings = data.settings;
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
            applySettings();
          }
          toast('Data imported');
        } catch (err) {
          toast('Import failed: Invalid file');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  function applySettings() {
    const body = document.body;
    body.setAttribute('data-theme', settings.theme || 'dark');
  }

  // Helpers for mapping
  function computeFinalTargetForItem(it, dest, layout, customName) {
    const safeGame = customName && layout === 'custom' ? Utils.sanitizeName(customName) : Utils.sanitizeName(it.displayTitle || it.dbTitle || it.folderName || it.ppsa || 'Unknown Game');
    let finalPpsaName = it.ppsa || (it.contentId && (String(it.contentId).match(/PPSA\d{4,6}/i) || [])[0]?.toUpperCase()) || null;
    if (!finalPpsaName) {
      const src = it.contentFolderPath || it.ppsaFolderPath || it.folderPath || '';
      const base = (src + '').split(/[\\/]/).pop() || '';
      finalPpsaName = base.replace(/[-_]*app\d*.*$/i, '').replace(/[-_]+$/,'') || base;
    }
    if (layout === 'ppsa-only') return pathJoin(dest, finalPpsaName);
    if (layout === 'game-only') return pathJoin(dest, safeGame);
    if (layout === 'etahen') return pathJoin(dest, 'etaHEN', 'games', safeGame);
    if (layout === 'itemzflow') return pathJoin(dest, 'games', safeGame);
    if (layout === 'dump_runner') return pathJoin(dest, 'homebrew', safeGame);
    if (layout === 'custom') return pathJoin(dest, safeGame);  // Just the custom folder name
    if (layout === 'game-ppsa') return pathJoin(dest, safeGame, finalPpsaName);
    return pathJoin(dest, safeGame);
  }

  function pathJoin(...parts) {
    const sep = navigator.platform.includes('Win') ? '\\' : '/';
    return parts.filter(Boolean).map((p, i) => {
      if (i === 0) return String(p).replace(/[\/\\]+$/,'');
      return String(p).replace(/^[\/\\]+|[\/\\]+$/g,'');
    }).join(sep);
  }

  function computeSourceFolder(it) {
    if (it.ppsaFolderPath) return it.ppsaFolderPath;
    if (it.folderPath) return it.folderPath;
    if (it.contentFolderPath) {
      const base = String(it.contentFolderPath).split(/[\\/]/).pop()?.toLowerCase() || '';
      if (base === 'sce_sys') return it.contentFolderPath.replace(/[\\/]+sce_sys$/i, '');
      return it.contentFolderPath;
    }
    return '';
  }

  // Helper to get selected items
  function getSelectedItems() {
    const tbody = $('resultsBody');
    const trs = Array.from(tbody.querySelectorAll('tr'));
    return trs.filter(tr => {
      const cb = tr.querySelector('input[type="checkbox"]');
      return cb && cb.checked;
    }).map(tr => {
      const idx = parseInt(tr.dataset.index || '-1', 10);
      return window.__ps5_lastRenderedItems[idx];
    }).filter(Boolean);
  }

  // GO click with confirmation + conflict modal
  async function goClickHandler() {
    try {
      const tbody = $('resultsBody');
      const trs = Array.from(tbody.querySelectorAll('tr'));
      const selected = [];
      const selectedIndices = [];
      trs.forEach((tr, idx) => {
        const cb = tr.querySelector('input[type="checkbox"]');
        if (cb && cb.checked) {
          selectedIndices.push(idx);
          const orig = window.__ps5_lastRenderedItems[idx];
          selected.push({
            displayTitle: orig.displayTitle || orig.dbTitle || orig.folderName || '',
            contentFolderPath: orig.contentFolderPath || orig.folderPath || '',
            folderPath: orig.folderPath || orig.contentFolderPath || '',
            folderName: orig.folderName || '',
            ppsa: orig.ppsa || null,
            paramPath: orig.paramPath || null,
            contentId: orig.contentId || null,
            iconPath: orig.iconPath || null,
            dbTitle: orig.dbTitle || null,
            skuFromParam: orig.skuFromParam || null,
            contentVersion: orig.contentVersion || null
          });
        }
      });
      if (!selected.length) {
        toast('No items selected');
        return;
      }

      // Append version to displayTitle for ALL versions to include version in folder name
      for (const item of selected) {
        if (item.contentVersion) {
          item.displayTitle += ` (${item.contentVersion})`;
        }
      }

      const dest = $('destPath') && $('destPath').value ? $('destPath').value.trim() : '';
      if (!dest) {
        toast('Select destination');
        return;
      }
      addRecentDest(dest);

      const action = $('action') ? $('action').value : 'move';
      const layout = $('layout') ? $('layout').value : 'game-ppsa';  // Changed default to match HTML first option

      let customName = null;
      if (layout === 'custom') {
        if (selected.length > 1) {
          alert('Custom layout is only allowed for single game selection. Please select only one game.');
          return;
        }
        customName = await openCustomModal();
        if (!customName || !customName.trim()) {
          alert('Custom name cannot be empty. Using default.');
          customName = null;
        } else {
          customName = customName.trim();
        }
      }

      const preview = selected.map(it => ({
        item: computeFinalTargetForItem(it, dest, layout, customName).split(/[\\/]/).pop() || 'Unknown Game',
        source: computeSourceFolder(it),
        target: computeFinalTargetForItem(it, dest, layout, customName)
      }));

      const proceedAfterConfirm = async () => {
        const conflicts = await window.ppsaApi.checkConflicts(selected, dest, layout, customName);
        let overwriteMode = 'rename';

        const runOperation = async () => {
          const rb = $('resultModalBackdrop');
          const rl = $('resultList');
          const rp = $('resultProgress');
          const rs = $('resultSubText');
          const rc = $('resultCount');
          const closeBtn = $('resultClose');
          const actionsRow = $('resultActionsRow');

          if (rb && rl && rp && rs && rc) {
            rl.innerHTML = '';
            TransferStats.reset();
            rs.textContent = 'Transferring...';
            rc.textContent = String(selected.length);
            rp.style.display = 'block';
            rl.style.display = 'none';
            rb.style.display = 'flex';
            rb.setAttribute('aria-hidden', 'false');
            if (closeBtn) closeBtn.style.display = 'none';
            if (actionsRow) {
              actionsRow.innerHTML = '';
              const cancelBtn = document.createElement('button');
              cancelBtn.id = 'resultCancel';
              cancelBtn.className = 'btn-danger modal-close';
              cancelBtn.textContent = 'Cancel';
              cancelBtn.addEventListener('click', async () => {
                try {
                  cancelBtn.disabled = true;
                  cancelBtn.textContent = 'Cancelling...';
                  cancelOperation = true;
                  if (window.ppsaApi && typeof window.ppsaApi.cancelOperation === 'function') {
                    await window.ppsaApi.cancelOperation();
                  }
                } catch (_) {}
              });
              actionsRow.appendChild(cancelBtn);
              actionsRow.style.display = 'flex';
              actionsRow.setAttribute('aria-hidden', 'false');
            }
          }
          setResultModalBusy(true);

          saveTransferState({ items: selected, dest, action, layout, customName, overwriteMode });
          const res = await window.ppsaApi.ensureAndPopulate({ items: selected, dest, action, layout, customName, overwriteMode });
          if (!res) throw new Error('No response');
          if (res.error) throw new Error(res.error);

          const rp2 = $('resultProgress');
          const rl2 = $('resultList');
          const close2 = $('resultClose');
          const actions2 = $('resultActionsRow');
          if (rp2) rp2.style.display = 'none';
          if (rl2) rl2.style.display = 'block';
          if (actions2) {
            actions2.display = 'none';
            actions2.setAttribute('aria-hidden', 'true');
          }
          if (close2) closeBtn.style.display = 'block';

          updateListSummary(res);

          // Show the results list immediately after operation completes
          const rp3 = $('resultProgress');
          const rl3 = $('resultList');
          const close3 = $('resultClose');
          const rs3 = $('resultSubText');
          const label3 = $('currentScanLabel');
          if (rp3) rp3.style.display = 'none';
          if (rl3) rl3.style.display = 'block';
          if (close3) closeBtn.style.display = 'block';
          if (rs3) rs3.textContent = 'Operation complete';
          if (label3) label3.textContent = '';
          showScanUI(false);

          refreshResultsAfterOperation(); // Refresh the game results list after operation

          // Modal stays open until user clicks close
        };

        if (conflicts.length) {
          openConflictModal(conflicts, async (choice) => {
            overwriteMode = choice || 'rename';
            await runOperation();
          });
        } else {
          await runOperation();
        }
      };

      const cancelAfterConfirm = () => {};

      openConfirmModal(preview, { action, layout }, proceedAfterConfirm, cancelAfterConfirm);
    } catch (e) {
      err('ensureAndPopulate error', e);
      const rp2 = $('resultProgress');
      const rl2 = $('resultList');
      const closeBtn = $('resultClose');
      if (rp2) rp2.style.display = 'none';
      if (rl2) rl2.style.display = 'block';
      if (closeBtn) closeBtn.style.display = 'block';
      toast('Operation failed: ' + (e.message || String(e)));
    } finally {
      setResultModalBusy(false);
    }
  }

  // Function to open custom name modal
  function openCustomModal() {
    return new Promise((resolve) => {
      const backdrop = $('customModalBackdrop');
      const input = $('customNameInput');
      const proceedBtn = $('customProceed');
      const cancelBtn = $('customCancel');

      if (!backdrop || !input || !proceedBtn || !cancelBtn) {
        resolve(null);
        return;
      }

      input.value = '';
      backdrop.style.display = 'flex';
      backdrop.setAttribute('aria-hidden', 'false');
      input.focus();

      const cleanup = () => {
        backdrop.style.display = 'none';
        backdrop.setAttribute('aria-hidden', 'true');
        proceedBtn.removeEventListener('click', onProceed);
        cancelBtn.removeEventListener('click', onCancel);
        input.removeEventListener('keydown', onKeydown);
      };

      const onProceed = () => {
        const value = input.value.trim();
        cleanup();
        resolve(value);
      };

      const onCancel = () => {
        cleanup();
        resolve(null);
      };

      const onKeydown = (e) => {
        if (e.key === 'Enter') onProceed();
        else if (e.key === 'Escape') onCancel();
      };

      proceedBtn.addEventListener('click', onProceed);
      cancelBtn.addEventListener('click', onCancel);
      input.addEventListener('keydown', onKeydown);
    });
  }

  function saveTransferState(state) {
    transferState = state;
    localStorage.setItem(TRANSFER_STATE_KEY, JSON.stringify(state));
  }

  function resumeTransfer() {
    if (!resumeState) return;
    // Restore UI state (e.g., select items, set dest/action/layout)
    // For simplicity, re-run goClickHandler with resumeState, but skip confirmation
    // (Implement based on your needs; this is a stub)
    toast('Resuming transfer...');
    // Call main IPC to resume
    window.ppsaApi.resumeTransfer(resumeState).then(() => {
      localStorage.removeItem(TRANSFER_STATE_KEY);
      resumeState = null;
    }).catch(err => toast('Resume failed: ' + err));
  }

  function updateListSummary(res) {
    const rl = $('resultList');
    if (!rl || !res || !Array.isArray(res.results)) return;
    rl.innerHTML = '';
    let moved = 0, copied = 0, errors = 0, total = 0, totalBytes = 0, created = 0;
    for (const r of res.results) {
      total++;
      let badge = '';
      if (r.created) {
        badge = 'created';
        created++;
      } else if (r.moved) {
        badge = 'moved';
        moved++;
        totalBytes += r.totalSize || 0;
      } else if (r.copied) {
        badge = 'copied';
        copied++;
        totalBytes += r.totalSize || 0;
      } else if (r.error) {
        badge = 'error';
        errors++;
      } else if (r.skipped) {
        badge = 'skipped';
      }

      const entry = document.createElement('div');
      entry.className = 'modal-content-entry';
      Object.assign(entry.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', paddingTop: '8px', paddingBottom: '8px', borderBottom: '1px solid rgba(255,255,255,0.02)' });

      const left = document.createElement('div');
      left.style.flex = '1';
      const title = document.createElement('div');
      title.className = 'entry-title';
      if (r.error) {
        title.textContent = `Error: ${r.error}`;
      } else {
        title.textContent = r.safeGameName || r.item || 'Unknown Game';
      }
      left.appendChild(title);
      const row = document.createElement('div');
      row.className = 'path-row';
      row.style.marginTop = '6px';
      const from = document.createElement('div');
      from.className = 'path-inline';
      from.innerHTML = '<span class="label-bold">From:</span> ' + Utils.escapeHtml(Utils.normalizeDisplayPath(r.source || ''));
      const to = document.createElement('div');
      to.className = 'path-inline';
      to.innerHTML = '<span class="label-bold">To:</span> ' + Utils.escapeHtml(r.target || '');
      row.appendChild(from);
      row.appendChild(to);
      left.appendChild(row);

      const right = document.createElement('div');
      right.style.flex = '0 0 auto';
      if (badge) {
        const b = document.createElement('button');
        b.className = (badge === 'moved' || badge === 'copied' || badge === 'created') ? 'btn-go' : 'btn';
        b.textContent = { moved: 'Moved', copied: 'Copied', created: 'Created', error: 'Error', skipped: 'Skipped' }[badge] || badge;
        b.disabled = true;
        b.style.pointerEvents = 'none';
        b.style.fontSize = '12px';
        b.style.padding = '6px 10px';
        right.appendChild(b);
      }

      entry.appendChild(left);
      entry.appendChild(right);
      rl.appendChild(entry);
    }
    const rs = $('resultSubText');
    if (rs) {
      const parts = [];
      if (copied) parts.push(`${copied} copied`);
      if (moved) parts.push(`${moved} moved`);
      if (created) parts.push(`${created} created`);
      if (errors) parts.push(`${errors} errors`);
      const scanDuration = scanStartTime ? Math.round((Date.now() - scanStartTime) / 1000) : 0;
      const transferDuration = transferStartTime ? Math.round((Date.now() - transferStartTime) / 1000) : 0;
      parts.push(`Scan time: ${scanDuration}s`);
      parts.push(`Transfer time: ${transferDuration}s`);
      if (totalBytes > 0) parts.push(`Total transferred: ${bytesToHuman(totalBytes)}`);
      rs.textContent = parts.length ? parts.join(' • ') : 'Operation complete';
    }
    const rcEl = $('resultCount');
    if (rcEl) rcEl.textContent = String(total);
  }

  async function refreshResultsAfterOperation() {
    const src = $('sourcePath') && $('sourcePath').value ? $('sourcePath').value.trim() : '';
    if (!src) return;
    try {
      if (!window.ppsaApi || typeof window.ppsaApi.scanSourceForPpsa !== 'function') return;
      const res = await window.ppsaApi.scanSourceForPpsa(src);
      const arr = Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
      renderResults(arr);
    } catch (scanErr) {
      err('Refresh error:', scanErr);
    }
  }

  function renderResults(arr, scanDuration) {
    const tbody = $('resultsBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const raw = Array.isArray(arr) ? arr : [];
    const list = dedupeItems(raw);
    window.__ps5_lastRenderedItems = list;

    // Sort only if currentSortBy is 'name', else rely on manual sort
    if (currentSortBy === 'name') {
      list.sort((a, b) => {
        const sa = String((a && (a.displayTitle || a.dbTitle || a.folderName)) || '').toLowerCase();
        const sb = String((b && (b.displayTitle || b.dbTitle || b.folderName)) || '').toLowerCase();
        return sa.localeCompare(sb);
      });
    }

    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="5" style="color:var(--muted);padding:12px">No validated entries found.</td></tr>`;
      $('scanCount') && ($('scanCount').textContent = '');
      updateHeaderCheckboxState();
      showScanUI(false);
      return;
    }

    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const tr = document.createElement('tr');
      tr.dataset.selectable = '1';
      tr.dataset.index = String(i);

      const tdChk = document.createElement('td');
      tdChk.style.verticalAlign = 'top';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'chk';
      tdChk.appendChild(chk);
      tr.appendChild(tdChk);

      const tdCover = document.createElement('td');
      tdCover.className = 'cover';
      tdCover.style.verticalAlign = 'top';
      const coverWrap = document.createElement('div');
      coverWrap.style.display = 'flex';
      coverWrap.style.flexDirection = 'column';
      coverWrap.style.alignItems = 'center';
      coverWrap.style.gap = 'var(--thumb-gap)';
      coverWrap.style.paddingTop = '0px';
      coverWrap.style.paddingBottom = '0px';
      if (r.iconPath) {
        const src = r.iconPath;
        const img = document.createElement('img');
        img.className = 'thumb';
        img.alt = r.displayTitle || 'cover';
        img.decoding = 'async';
        img.loading = 'lazy';
        img.src = src;
        img.addEventListener('error', () => { img.style.display = 'none'; });
        coverWrap.appendChild(img);
        attachPreviewHandlers(img, src);
      } else {
        const ph = document.createElement('div');
        ph.style.width = 'var(--thumb-size)';
        ph.style.height = 'var(--thumb-size)';
        ph.style.background = 'rgba(255,255,255,0.02)';
        ph.style.borderRadius = 'var(--thumb-radius)';
        ph.style.border = '1px solid rgba(255,255,255,0.04)';
        coverWrap.appendChild(ph);
      }
      tdCover.appendChild(coverWrap);
      tr.appendChild(tdCover);

      const tdGame = document.createElement('td');
      tdGame.className = 'game';
      tdGame.style.verticalAlign = 'top';
      const title = document.createElement('div');
      title.className = 'title-main';
      title.textContent = r.displayTitle || '';
      const sub = document.createElement('div');
      sub.className = 'title-sub';
      sub.textContent = r.contentId || '';
      tdGame.appendChild(title);
      tdGame.appendChild(sub);
      tr.appendChild(tdGame);

      const tdSize = document.createElement('td');
      tdSize.className = 'size';
      tdSize.style.verticalAlign = 'top';
      tdSize.textContent = bytesToHuman(r.totalSize || 0);
      tr.appendChild(tdSize);

      const tdFolder = document.createElement('td');
      tdFolder.className = 'folder';
      tdFolder.style.verticalAlign = 'top';
      const fp = document.createElement('div');
      fp.title = r.ppsaFolderPath || r.folderPath || r.contentFolderPath || '';
      fp.style.color = 'var(--muted)';
      fp.style.fontWeight = '700';
      fp.textContent = fp.title;
      fp.style.cursor = 'pointer';
      fp.addEventListener('click', () => {
        if (fp.title) {
          window.ppsaApi.showInFolder(fp.title);
        }
      });
      tdFolder.appendChild(fp);

      const verShort = formatContentVersionShort(r.contentVersion);
      const sdkDisp = formatSdkVersionHexToDisplay(r.sdkVersion);
      const verLabel = verShort ? `v${verShort}` : '';
      const fwLabel = sdkDisp ? `FW ${sdkDisp}${shouldAddPlus(r.sdkVersion) ? ' +' : ''}` : '';
      const infoText = verLabel && fwLabel ? `${verLabel} - ${fwLabel}` : (verLabel || fwLabel);
      if (infoText) {
        const infoDiv = document.createElement('div');
        infoDiv.className = 'title-sub';
        infoDiv.style.marginTop = '4px';
        infoDiv.style.fontWeight = 'normal';
        infoDiv.textContent = infoText;
        tdFolder.appendChild(infoDiv);
      }

      tr.addEventListener('click', (ev) => {
        if (ev.target && ev.target.tagName === 'INPUT') return;
        chk.checked = !chk.checked;
        if (chk.checked) tr.classList.add('row-selected');
        else tr.classList.remove('row-selected');
        updateHeaderCheckboxState();
      });
      chk.addEventListener('change', () => {
        if (chk.checked) tr.classList.add('row-selected');
        else tr.classList.remove('row-selected');
        updateHeaderCheckboxState();
      });

      tr.appendChild(tdFolder);
      tbody.appendChild(tr);
    }
    const durationText = scanDuration ? ` (scanned in ${scanDuration}s)` : '';
    $('scanCount') && ($('scanCount').textContent = `${list.length} games found${durationText}`);
    updateHeaderCheckboxState();
    showScanUI(false);
    try { localStorage.setItem(LAST_RESULTS_KEY, JSON.stringify(list)); } catch (_) {}
  }

  function updateHeaderCheckboxState() {
    const header = $('chkHeader');
    if (!header) return;
    const visible = Array.from(document.querySelectorAll('#resultsBody tr')).filter(tr => tr.offsetParent !== null);
    if (!visible.length) {
      header.checked = false;
      header.indeterminate = false;
      return;
    }
    const checked = visible.filter(tr => {
      const cb = tr.querySelector('input[type="checkbox"]');
      return cb && cb.checked;
    }).length;
    if (checked === 0) {
      header.checked = false;
      header.indeterminate = false;
    } else if (checked === visible.length) {
      header.checked = true;
      header.indeterminate = false;
    } else {
      header.checked = false;
      header.indeterminate = true;
    }
  }

  function toggleHeaderSelect() {
    const visible = Array.from(document.querySelectorAll('#resultsBody tr')).filter(tr => tr.offsetParent !== null);
    if (!visible.length) return;
    const checkedCount = visible.filter(tr => {
      const cb = tr.querySelector('input[type="checkbox"]');
      return cb && cb.checked;
    }).length;
    const allSelected = checkedCount === visible.length;
    for (const tr of visible) {
      const cb = tr.querySelector('input[type="checkbox"]');
      if (!cb) continue;
      cb.checked = !allSelected;
      if (cb.checked) tr.classList.add('row-selected');
      else tr.classList.remove('row-selected');
    }
    updateHeaderCheckboxState();
  }

  function sortResults(by) {
    currentSortBy = by;  // Set the global sort tracker
    if (!window.__ps5_lastRenderedItems) return;
    window.__ps5_lastRenderedItems.sort((a, b) => {
      let aVal, bVal;
      if (by === 'name') {
        aVal = (a.displayTitle || a.dbTitle || a.folderName || '').toLowerCase();
        bVal = (b.displayTitle || b.dbTitle || b.folderName || '').toLowerCase();
      } else if (by === 'size') {
        aVal = a.totalSize || 0;
        bVal = b.totalSize || 0;
      } else if (by === 'folder') {
        aVal = (a.ppsaFolderPath || a.folderPath || '').toLowerCase();
        bVal = (b.ppsaFolderPath || b.folderPath || '').toLowerCase();
      }
      if (aVal < bVal) return -1;
      if (aVal > bVal) return 1;
      return 0;
    });
    renderResults(window.__ps5_lastRenderedItems);
  }

  function toast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.style.display = 'block';
    setTimeout(() => { t.style.display = 'none'; }, 3000);
  }

  function showNotification(title, body) {
    if (Notification.permission === 'granted') {
      new Notification(title, { body });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(perm => {
        if (perm === 'granted') new Notification(title, { body });
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    try {
      Preview.init();
      applySettings();

      // Load last used paths into inputs
      const lastSrc = localStorage.getItem(LAST_SRC_KEY);
      if (lastSrc && $('sourcePath')) $('sourcePath').value = lastSrc;

      const lastDst = localStorage.getItem(LAST_DST_KEY);
      if (lastDst && $('destPath')) $('destPath').value = lastDst;

      updateSourceHistoryDatalist();
      updateDestHistoryDatalist();

      // Click logo to clear recent paths
      const brandLogo = $('brandLogo');
      if (brandLogo) {
        brandLogo.addEventListener('click', () => {
          if (confirm('Clear all recent sources and destinations?')) {
            try {
              localStorage.removeItem('ps5vault.recentSources');
              localStorage.removeItem('ps5vault.recentDests');
              updateSourceHistoryDatalist();
              updateDestHistoryDatalist();
              toast('Recent paths cleared');
            } catch (_) {}
          }
        });
      }

      try {
        const lastResults = localStorage.getItem(LAST_RESULTS_KEY);
        if (lastResults) {
          const arr = JSON.parse(lastResults);
          if (Array.isArray(arr) && arr.length) {
            renderResults(arr);
          }
        }
      } catch (_) {}

      resumeState = JSON.parse(localStorage.getItem(TRANSFER_STATE_KEY) || 'null');
      if (resumeState && confirm('Resume previous transfer?')) {
        resumeTransfer();
      }

      if (window.ppsaApi && typeof window.ppsaApi.onScanProgress === 'function') {
        window.ppsaApi.onScanProgress(onProgressMessage);
      }

      const madeBy = $('madeBy');
      if (madeBy) {
        madeBy.addEventListener('click', toggleTheme);
      }

      const btnExport = $('btnExport');
      if (btnExport) {
        btnExport.addEventListener('click', exportData);
      }

      const btnImport = $('btnImport');
      if (btnImport) {
        btnImport.addEventListener('click', importData);
      }

      document.addEventListener('keydown', e => {
        if (e.ctrlKey && e.key === 'a') {
          e.preventDefault();
          Array.from($('resultsBody').querySelectorAll('input[type="checkbox"]')).forEach(cb => {
            cb.checked = true;
            cb.closest('tr')?.classList.add('row-selected');
          });
          updateHeaderCheckboxState();
        } else if (e.ctrlKey && e.key === 'r') {
          e.preventDefault();
          const btnScan = $('btnScan');
          if (btnScan) btnScan.click();
        } else if (e.key === 'F1') {
          e.preventDefault();
          const btnHelp = $('btnHelp');
          if (btnHelp) btnHelp.click();
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          const rows = Array.from($('resultsBody').querySelectorAll('tr'));
          const activeRow = document.activeElement.closest('tr');
          const idx = rows.indexOf(activeRow);
          const nextIdx = e.key === 'ArrowDown' ? Math.min(idx + 1, rows.length - 1) : Math.max(idx - 1, 0);
          rows[nextIdx]?.focus();
        }
      });

      const btnPickSource = $('btnPickSource');
      if (btnPickSource) {
        btnPickSource.addEventListener('click', async () => {
          const result = await window.ppsaApi.pickDirectory();
          if (!result.canceled && result.path) {
            $('sourcePath').value = result.path;
            addRecentSource(result.path);
            try { localStorage.setItem(LAST_SRC_KEY, result.path); } catch (_) {}
          }
        });
      }
      const btnPickDest = $('btnPickDest');
      if (btnPickDest) {
        btnPickDest.addEventListener('click', async () => {
          const result = await window.ppsaApi.pickDirectory();
          if (!result.canceled && result.path) {
            $('destPath').value = result.path;
            addRecentDest(result.path);
            try { localStorage.setItem(LAST_DST_KEY, result.path); } catch (_) {}
          }
        });
      }
      const btnScan = $('btnScan');
      if (btnScan) {
        btnScan.addEventListener('click', async () => {
          const src = $('sourcePath') && $('sourcePath').value ? $('sourcePath').value.trim() : '';
          if (!src) { toast('Select source first'); return; }
          let actualSrc = src;
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
            // Auto-detect FTP if entered as IP/path
            actualSrc = src.startsWith('ftp://') ? src : 'ftp://' + src;
            addRecentSource(src);
          } else {
            addRecentSource(src);
          }
          try { localStorage.setItem(LAST_SRC_KEY, actualSrc); } catch (_) {}
          showScanUI(true);
          $('btnGoBig').disabled = true;
          $('currentScanLabel') && ($('currentScanLabel').textContent = 'Scanning...');
          scanStartTime = Date.now();
          const res = await window.ppsaApi.scanSourceForPpsa(actualSrc);
          const arr = Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
          const duration = Math.round((Date.now() - scanStartTime) / 1000);
          renderResults(arr, duration);
          $('btnGoBig').disabled = false;
          currentSortBy = 'name';  // Reset to default on new scan
        });
      }

      const btnCancelScan = $('btnCancelScan');
      if (btnCancelScan) {
        btnCancelScan.addEventListener('click', async () => {
          try {
            if (window.ppsaApi && typeof window.ppsaApi.cancelOperation === 'function') {
              await window.ppsaApi.cancelOperation();
            }
            toast('Scan cancelled');
            showScanUI(false);
            $('btnGoBig').disabled = false;
          } catch (_) {}
        });
      }

      // Help modal handlers
      const helpBackdrop = $('helpModalBackdrop');
      const helpOpenBtn = $('btnHelp');
      const helpCloseBtn = $('helpClose');
      let helpEscHandler = null;

      async function openHelp(ev) {
        if (ev) ev.preventDefault();
        if (!helpBackdrop) return;
        helpBackdrop.style.display = 'flex';
        helpBackdrop.setAttribute('aria-hidden', 'false');
        helpEscHandler = (e) => { if (e.key === 'Escape') closeHelp(); };
        document.addEventListener('keydown', helpEscHandler);
      }

      function closeHelp() {
        if (!helpBackdrop) return;
        helpBackdrop.style.display = 'none';
        helpBackdrop.setAttribute('aria-hidden', 'true');
        if (helpEscHandler) {
          document.removeEventListener('keydown', helpEscHandler);
          helpEscHandler = null;
        }
      }

      if (helpOpenBtn) helpOpenBtn.addEventListener('click', openHelp);
      if (helpCloseBtn) helpCloseBtn.addEventListener('click', closeHelp);

      const btnSelectAll = $('btnSelectAll');
      if (btnSelectAll) {
        btnSelectAll.addEventListener('click', () => {
          Array.from(document.querySelectorAll('#resultsBody input[type="checkbox"]')).forEach(cb => {
            cb.checked = true;
            cb.closest('tr')?.classList.add('row-selected');
          });
          updateHeaderCheckboxState();
        });
      }
      const btnUnselectAll = $('btnUnselectAll');
      if (btnUnselectAll) {
        btnUnselectAll.addEventListener('click', () => {
          Array.from(document.querySelectorAll('#resultsBody input[type="checkbox"]')).forEach(cb => {
            cb.checked = false;
            cb.closest('tr')?.classList.remove('row-selected');
          });
          updateHeaderCheckboxState();
        });
      }
      const btnClear = $('btnClear');
      if (btnClear) {
        btnClear.addEventListener('click', () => {
          if (!confirm('Clear all scan results? This cannot be undone.')) return;
          Array.from(document.querySelectorAll('#resultsBody input[type="checkbox"]')).forEach(cb => {
            cb.checked = false;
            cb.closest('tr')?.classList.remove('row-selected');
          });
          const tb = $('resultsBody');
          if (tb) tb.innerHTML = `<tr><td colspan="5" style="color:var(--muted);padding:12px">No scan performed yet.</td></tr>`;
          $('scanCount') && ($('scanCount').textContent='');
          updateHeaderCheckboxState();
          try { localStorage.removeItem(LAST_RESULTS_KEY); } catch (_) {}
        });
      }

      const headerChk = $('chkHeader');
      if (headerChk) {
        headerChk.addEventListener('click', (e) => {
          e.preventDefault();
          toggleHeaderSelect();
        });
      }

      const btnGoBig = $('btnGoBig');
      if (btnGoBig) {
        btnGoBig.addEventListener('click', goClickHandler);
      }

      const btnDeleteSelected = $('btnDeleteSelected');
      if (btnDeleteSelected) {
        btnDeleteSelected.addEventListener('click', async () => {
          const selected = getSelectedItems();
          if (!selected.length) {
            toast('No items selected');
            return;
          }
          if (!confirm(`Delete ${selected.length} selected item(s)? This cannot be undone and will remove files from disk.`)) return;
          try {
            btnDeleteSelected.disabled = true;
            btnDeleteSelected.textContent = 'Deleting...';
            for (const item of selected) {
              await window.ppsaApi.deleteItem(item);
            }
            toast(`Deleted ${selected.length} item(s)`);
            // Refresh the scan results
            const src = $('sourcePath').value.trim();
            if (src) {
              const res = await window.ppsaApi.scanSourceForPpsa(src);
              const arr = Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
              renderResults(arr);
            }
          } catch (e) {
            toast('Delete failed: ' + (e.message || 'Unknown error'));
          } finally {
            btnDeleteSelected.disabled = false;
            btnDeleteSelected.textContent = 'Delete Selected';
          }
        });
      }

      const discordLink = $('discordLink');
      if (discordLink) {
        const DISCORD_USERNAME = 'nookie_65120';
        const DISCORD_PROFILE_URLS = [
          `https://discord.com/users/${DISCORD_USERNAME}`,
          `https://discordapp.com/users/${DISCORD_USERNAME}`,
          'https://discord.com/app'
        ];
        discordLink.addEventListener('click', async (e) => {
          e.preventDefault();
          try {
            await window.ppsaApi.copyToClipboard(DISCORD_USERNAME);
            toast(`Discord username copied: ${DISCORD_USERNAME}`);
          } catch (_) {}
          try { await window.ppsaApi.openExternal('discord://discord'); } catch (_) {}
          for (const url of DISCORD_PROFILE_URLS) {
            try { await window.ppsaApi.openExternal(url); break; } catch (_) {}
          }
        });
      }

      const resultClose = $('resultClose');
      if (resultClose) {
        resultClose.addEventListener('click', () => {
          refreshResultsAfterOperation(); // Refresh when user clicks close
          const rb = $('resultModalBackdrop');
          if (rb) { rb.style.display = 'none'; rb.setAttribute('aria-hidden', 'true'); }
        });
      }

      // Add sorting functionality
      const thName = document.querySelector('th.game');
      const thSize = document.querySelector('th.size');
      const thFolder = document.querySelector('th.folder');
      if (thName) thName.addEventListener('click', () => sortResults('name'));
      if (thSize) thSize.addEventListener('click', () => sortResults('size'));
      if (thFolder) thFolder.addEventListener('click', () => sortResults('folder'));

    } catch (e) {
      console.error('[renderer] DOMContentLoaded error', e);
    }
    log('renderer initialized');
  });
})();