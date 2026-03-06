(function () {
  'use strict';

  const LAST_SRC_KEY = 'ps5vault.lastSource';
  const LAST_DST_KEY = 'ps5vault.lastDest';
  const LAST_RESULTS_KEY = 'ps5vault.lastResults';
  const SETTINGS_KEY = 'ps5vault.settings';
  const TRANSFER_STATE_KEY = 'ps5vault.transferState';
  const RECENT_SOURCES_KEY = 'ps5vault.recentSources';
  const RECENT_DESTS_KEY = 'ps5vault.recentDests';
  const LAST_LAYOUT_KEY = 'ps5vault.lastLayout';
  const LAST_ACTION_KEY = 'ps5vault.lastAction';
  const TRANSFER_HISTORY_KEY = 'ps5vault.transferHistory';

  function getTransferHistory() {
    try { return JSON.parse(localStorage.getItem(TRANSFER_HISTORY_KEY) || '[]'); } catch (_) { return []; }
  }

  function addTransferHistoryEntry(entry) {
    try {
      const history = getTransferHistory();
      history.unshift(entry);
      localStorage.setItem(TRANSFER_HISTORY_KEY, JSON.stringify(history.slice(0, 100)));
    } catch (_) {}
  }

  const $ = id => document.getElementById(id);
  const log = (...a) => console.log('[renderer]', ...a);
  const err = (...a) => console.error('[renderer]', ...a);

  let cancelOperation = false;
  let transferState = JSON.parse(localStorage.getItem(TRANSFER_STATE_KEY) || '{}');
  let settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  let scanStartTime = 0;
  let transferStartTime = 0;
  let currentSortBy = 'name';
  let resumeState = null;
  let searchFilter = '';

  let isFtpScan = false;
  let ftpConfig = null;
  let maxSpeed = 0;
  let lastFile = '';
  let completedFiles = [];
  let totalTransferred = 0;

  // ── Global operation lock ─────────────────────────────────────────────────
  // Any destructive or long-running operation sets appBusy=true, which disables
  // all action buttons so users can't trigger parallel conflicting operations.
  let appBusy = false;
  function setAppBusy(busy, statusMsg = '') {
    appBusy = busy;
    const ids = ['btnScan', 'btnScanAllDrives', 'btnGoBig', 'btnDeleteSelected', 'btnRenameSelected'];
    for (const id of ids) {
      const el = $(id);
      if (el) el.disabled = busy || shouldDisableByState(id);
    }
    if (statusMsg) {
      const lbl = $('currentScanLabel');
      if (lbl) lbl.textContent = statusMsg;
    }
  }
  function shouldDisableByState(id) {
    // Re-check real DOM checkbox state so setAppBusy(false) restores correct enabled/disabled
    if (id === 'btnGoBig' || id === 'btnDeleteSelected' || id === 'btnRenameSelected') {
      const selected = getSelectedItems();
      if (id === 'btnRenameSelected') return selected.length !== 1;
      return selected.length === 0;
    }
    return false;
  }

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

  function getRecentFtp() {
    try {
      const stored = localStorage.getItem('ps5vault.recentFtp');
      return stored ? JSON.parse(stored) : [];
    } catch (_) {
      return [];
    }
  }

  function addRecentSource(path) {
    if (!path) return;
    const recents = getRecentSources();
    const filtered = recents.filter(p => p !== path);
    filtered.unshift(path);
    const limited = filtered.slice(0, 5);
    try {
      localStorage.setItem(RECENT_SOURCES_KEY, JSON.stringify(limited));
    } catch (_) {}
    updateSourceHistoryDatalist();
  }

  function addRecentDest(path) {
    if (!path) return;
    const recents = getRecentDests();
    const filtered = recents.filter(p => p !== path);
    filtered.unshift(path);
    const limited = filtered.slice(0, 5);
    try {
      localStorage.setItem(RECENT_DESTS_KEY, JSON.stringify(limited));
    } catch (_) {}
    updateDestHistoryDatalist();
  }

  function addRecentFtp(config) {
    if (!config) return;
    const recents = getRecentFtp();
    const key = `${config.host}:${config.port}:${config.path}:${config.user}`;
    const filtered = recents.filter(c => `${c.host}:${c.port}:${c.path}:${c.user}` !== key);
    filtered.unshift(config);
    const limited = filtered.slice(0, 5);
    try {
      localStorage.setItem('ps5vault.recentFtp', JSON.stringify(limited));
    } catch (_) {}
  }

  // Expose history helpers for scan.js and ftp.js
  window.getRecentFtp    = getRecentFtp;
  window.addRecentSource = addRecentSource;
  window.addRecentDest   = addRecentDest;
  window.addRecentFtp    = addRecentFtp;

  function fillDatalist(datalistId, items) {
    const dl = $(datalistId);
    if (!dl) return;
    dl.innerHTML = '';
    for (const val of items) {
      const opt = document.createElement('option');
      opt.value = val;
      dl.appendChild(opt);
    }
  }

  function updateSourceHistoryDatalist() {
    fillDatalist('sourceHistory', getRecentSources());
  }

  function updateDestHistoryDatalist() {
    fillDatalist('destHistory', getRecentDests());
  }

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

  function showScanUI(show) {
    const sd = $('scanDisplay');
    const label = $('currentScanLabel');
    const cancelBtn = $('btnCancelScan');
    if (sd) sd.style.display = show ? 'block' : 'none';
    if (!show && label) label.textContent = '';
    if (cancelBtn) cancelBtn.style.display = show ? 'inline-block' : 'none';
  }

  // ── Sliding-window speed calculator ────────────────────────────────────────
  // Uses a 4-second window of (time, bytes) samples for accurate real-time speed.
  // Old EMA (α=0.25) had infinite memory — a single stale sample from the
  // "Counting files..." pause would drag the displayed speed for minutes.
  // Sliding window reacts instantly: speed = Δbytes / Δtime over last 4s only.
  const TransferStats = {
    window: [],       // [{time, bytes}]
    WINDOW_MS: 4000,  // 4-second measurement window
    peakSpeed: 0,

    reset() {
      this.window = [];
      this.peakSpeed = 0;
    },

    update(totalBytesCopied, totalBytes) {
      const now = Date.now();

      // Add current sample
      this.window.push({ time: now, bytes: totalBytesCopied });

      // Evict samples older than WINDOW_MS, but keep at least 2 points
      while (this.window.length > 2 && now - this.window[0].time > this.WINDOW_MS) {
        this.window.shift();
      }

      // Speed = rise/run over the window
      let speedBps = 0;
      if (this.window.length >= 2) {
        const oldest  = this.window[0];
        const elapsed = (now - oldest.time) / 1000;
        const gained  = totalBytesCopied - oldest.bytes;
        if (elapsed >= 0.05 && gained >= 0) {
          speedBps = gained / elapsed;
        }
      }

      speedBps = Math.max(0, speedBps);
      if (speedBps > this.peakSpeed) this.peakSpeed = speedBps;

      const remaining = Math.max(0, totalBytes - totalBytesCopied);
      // ETA: use current window speed for responsiveness
      const etaSec = speedBps > 1024 ? remaining / speedBps : 0;

      return {
        speedBps,
        etaSec: Number.isFinite(etaSec) ? etaSec : 0,
      };
    },
  };

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

  function secToHMS(s) {
    const sec = Math.round(Number.isFinite(s) ? s : 0);
    if (sec < 1) return sec >= 0 ? '0:00' : '--:--';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const r = sec % 60;
    return h > 0 ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }

  function formatSdkVersionHexToDisplay(hex) {
    if (!hex || typeof hex !== 'string') return '';
    const m = hex.trim().match(/^0x([0-9A-Fa-f]{2})/);
    if (!m) return '';
    const majorHex = m[1];
    const major = parseInt(majorHex, 16);
    if (Number.isNaN(major)) return '';
    return `${major}.xx`;
  }

  function primaryPathOf(item) {
    return item.ppsaFolderPath || item.folderPath || item.contentFolderPath || '';
  }

  function isNestedPath(child, parent) {
    if (!child || !parent) return false;
    const c = String(child).replace(/\//g, '\\');
    const p = String(parent).replace(/\//g, '\\');
    if (c.toLowerCase() === p.toLowerCase()) return true;
    return c.toLowerCase().startsWith(p.toLowerCase() + '\\');
  }

  function dedupeItems(list) {
    if (!list || !list.length) return [];

    // Step 1 — deduplicate by exact path only.
    // Two games with the same PPSA in different directories are BOTH kept.
    // The user wants to see every copy of a game regardless of identity match.
    const seenPaths = new Set();
    const unique = [];
    for (const r of list) {
      const p = String(primaryPathOf(r)).toLowerCase();
      if (!p || seenPaths.has(p)) continue;
      seenPaths.add(p);
      unique.push(r);
    }

    // Step 2 — remove entries whose path is strictly nested inside another.
    // Collapses sce_sys sub-results when the parent game folder also appears.
    const out = [];
    for (let i = 0; i < unique.length; i++) {
      const aPath = primaryPathOf(unique[i]);
      let nested = false;
      for (let j = 0; j < unique.length; j++) {
        if (i === j) continue;
        if (isNestedPath(aPath, primaryPathOf(unique[j]))) { nested = true; break; }
      }
      if (!nested) out.push(unique[i]);
    }
    return out;
  }

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
    backdrop.setAttribute('aria-hidden', 'false');
  }

  function openConfirmModal(previewItems, meta, onProceedCb, onCancelCb) {
    const backdrop = $('confirmModalBackdrop');
    const listEl = $('confirmList');
    const metaEl = $('confirmMeta');
    const btnGo = $('confirmProceed');
    const btnCancel = $('confirmCancel');
    if (!backdrop || !listEl || !btnGo || !btnCancel) {
      onProceedCb && onProceedCb();
      return;
    }

    // Build meta tag strip
    if (metaEl) {
      metaEl.innerHTML = '';
      const actionLabels = {
        'copy': 'Copy (verified)', 'move': 'Move', 'folder-only': 'Create folder'
      };
      const layoutLabels = {
        'game-ppsa': 'Game / PPSA', 'game-only': 'Game only', 'ppsa-only': 'PPSA only',
        'etahen': 'etaHEN', 'itemzflow': 'itemZFlow', 'dump_runner': 'Dump Runner', 'custom': 'Custom'
      };
      const chips = [
        ['Items', String(previewItems.length)],
        ['Action', actionLabels[meta.action] || meta.action || '—'],
        ['Layout', layoutLabels[meta.layout] || meta.layout || '—'],
      ];
      for (const [label, val] of chips) {
        const chip = document.createElement('span');
        chip.className = 'meta-tag';
        chip.innerHTML = `<span class="meta-tag-label">${label}</span>${Utils.escapeHtml(val)}`;
        metaEl.appendChild(chip);
      }
    }

    listEl.innerHTML = '';
    for (const p of previewItems) {
      const row = document.createElement('div');
      Object.assign(row.style, { padding: '9px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' });

      const title = document.createElement('div');
      title.style.cssText = 'font-weight:600;font-size:13px;color:var(--title);margin-bottom:5px;';
      title.textContent = p.item || 'Unknown Game';
      row.appendChild(title);

      for (const [label, val] of [['From', p.source || ''], ['To', p.target || '']]) {
        const line = document.createElement('div');
        line.style.cssText = 'font-size:11.5px;color:var(--muted);overflow-wrap:anywhere;line-height:1.4;margin-top:2px;';
        line.innerHTML = `<span style="font-weight:600;text-transform:uppercase;font-size:10.5px;letter-spacing:.04em;margin-right:6px;">${label}</span>${Utils.cleanPath(val)}`;
        row.appendChild(line);
      }

      listEl.appendChild(row);
    }

    const cleanup = () => {
      backdrop.style.display = 'none';
      backdrop.setAttribute('aria-hidden', 'true');
      btnGo.removeEventListener('click', onGo);
      btnCancel.removeEventListener('click', onCancel);
    };
    const onGo = () => { cleanup(); onProceedCb && onProceedCb(); };
    const onCancel = () => { cleanup(); onCancelCb && onCancelCb(); };

    btnGo.addEventListener('click', onGo);
    btnCancel.addEventListener('click', onCancel);
    backdrop.style.display = 'flex';
    backdrop.setAttribute('aria-hidden', 'false');
  }

  function openRenameModal(currentName) {
    return new Promise((resolve) => {
      const backdrop = $('renameModalBackdrop');
      const presetSelect = $('renamePreset');
      const input = $('renameNameInput');
      const proceedBtn = $('renameProceed');
      const cancelBtn = $('renameCancel');

      if (!backdrop || !presetSelect || !input || !proceedBtn || !cancelBtn) {
        resolve(null);
        return;
      }

      function cleanGameName(name) {
        return name.replace(/^games/, '').trim();
      }

      currentName = cleanGameName(currentName || '');

      input.value = currentName;
      presetSelect.value = 'default';
      input.disabled = true;

      backdrop.style.display = 'flex';
      backdrop.setAttribute('aria-hidden', 'false');
      input.focus();

      const updateInput = () => {
        const preset = presetSelect.value;
        if (preset === 'default') {
          input.disabled = true;
          input.value = currentName;
        } else {
          input.disabled = false;
          input.value = '';
        }
      };

      presetSelect.addEventListener('change', updateInput);

      const cleanup = () => {
        backdrop.style.display = 'none';
        backdrop.setAttribute('aria-hidden', 'true');
        presetSelect.removeEventListener('change', updateInput);
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

  function openBatchRenameModal(selected) {
    return new Promise((resolve) => {
      const backdrop = $('batchRenameBackdrop');
      if (!backdrop) {
        const newBackdrop = document.createElement('div');
        newBackdrop.id = 'batchRenameBackdrop';
        newBackdrop.className = 'modal-backdrop';
        newBackdrop.innerHTML = `
          <div class="modal" role="dialog" aria-modal="true" aria-labelledby="batchRenameTitle">
            <div class="modal-header"><h4 id="batchRenameTitle">Batch Rename</h4></div>
            <div class="modal-body">
              <div style="margin-bottom:8px;">
                <label style="color:var(--muted);font-size:12px;font-weight:600;margin-bottom:4px;display:block;">Pattern (use {name} for original)</label>
                <input id="batchRenamePattern" type="text" placeholder="{name} - Backup" style="width:100%;padding:8px;border:1px solid var(--card-border);background:var(--select-bg);color:var(--title);border-radius:4px;" />
              </div>
              <div id="batchRenamePreview"></div>
            </div>
            <div class="modal-actions">
              <button id="batchRenameCancel" class="btn">Cancel</button>
              <button id="batchRenameProceed" class="btn-go">Apply</button>
            </div>
          </div>
        `;
        document.body.appendChild(newBackdrop);
      }
      const backdropEl = $('batchRenameBackdrop');
      const patternInput = $('batchRenamePattern');
      const previewEl = $('batchRenamePreview');
      const proceedBtn = $('batchRenameProceed');
      const cancelBtn = $('batchRenameCancel');

      function updatePreview() {
        const pattern = patternInput.value;
        previewEl.innerHTML = selected.map(item => {
          const newName = pattern.replace('{name}', item.displayTitle);
          return `<div>${Utils.escapeHtml(item.displayTitle)} → ${Utils.escapeHtml(newName)}</div>`;
        }).join('');
      }

      // FIX B8: remove any previous listener before attaching to avoid stacking on re-open
      if (patternInput._ps5BatchListener) {
        patternInput.removeEventListener('input', patternInput._ps5BatchListener);
      }
      patternInput._ps5BatchListener = updatePreview;
      patternInput.addEventListener('input', updatePreview);
      patternInput.value = '';
      updatePreview();

      const cleanup = () => {
        backdropEl.style.display = 'none';
        proceedBtn.removeEventListener('click', onProceed);
        cancelBtn.removeEventListener('click', onCancel);
      };

      const onProceed = () => {
        const pattern = patternInput.value.trim();
        if (!pattern) return;
        const renamed = selected.map(item => ({
          ...item,
          displayTitle: pattern.replace('{name}', item.displayTitle)
        }));
        cleanup();
        resolve(renamed);
      };

      const onCancel = () => {
        cleanup();
        resolve(null);
      };

      proceedBtn.addEventListener('click', onProceed);
      cancelBtn.addEventListener('click', onCancel);
      backdropEl.style.display = 'flex';
    });
  }
  function setupDragDrop() {
    const sourceInput = $('sourcePath');
    const destInput = $('destPath');
    [sourceInput, destInput].forEach(input => {
      if (!input) return;
      input.addEventListener('dragover', (e) => {
        e.preventDefault();
      });
      input.addEventListener('drop', (e) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files);
        if (files.length && files[0].type === '') {
          input.value = files[0].path;
        }
      });
    });
  }

  function toggleTheme() {
    const body = document.body;
    const current = body.getAttribute('data-theme') || 'dark';
    const newTheme = current === 'dark' ? 'light' : 'dark';
    body.setAttribute('data-theme', newTheme);
    settings.theme = newTheme;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    toast(`Theme switched to ${newTheme}`);
  }

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
            try {
              const forStorage = data.results.map(item => {
                if (!item.iconPath || !item.iconPath.startsWith('data:')) return item;
                const { iconPath: _i, ...rest } = item; return rest;
              });
              localStorage.setItem(LAST_RESULTS_KEY, JSON.stringify(forStorage));
            } catch (_) {}
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

  function computeFinalTargetForItem(it, dest, layout, customName) {
    const baseName = customName && layout === 'custom'
      ? Utils.sanitizeName(customName)
      : Utils.sanitizeName(it.displayTitle || it.dbTitle || it.folderName || it.ppsa || 'Unknown Game');
    const rawVer = it.contentVersion || it.version || '';
    const verSuffix = rawVer ? ' (' + rawVer + ')' : '';
    const safeGame = layout === 'ppsa-only' ? baseName : (baseName + verSuffix);
    let finalPpsaName = it.ppsa || (it.contentId && (String(it.contentId).match(/PPSA\d{4,6}/i) || [])[0]?.toUpperCase()) || null;
    if (!finalPpsaName) {
      const src = it.contentFolderPath || it.ppsaFolderPath || it.folderPath || '';
      const base = (src + '').split(/[\\/]/).pop() || '';
      finalPpsaName = base.replace(/[-_]*app\d*.*$/i, '').replace(/[-_]+$/,'') || base;
    }
    // Platform-aware path join for preview display:
    // FTP destinations use '/', local/UNC paths detect separator from the base.
    const pathJoin = (base, ...rest) => {
      const all = [base, ...rest].filter(Boolean);
      if (base && base.startsWith('ftp://')) return all.join('/');
      const sep = (base && base.includes('\\')) ? '\\' : '/';
      return all.join(sep);
    };
    if (layout === 'ppsa-only') return pathJoin(dest, finalPpsaName);
    if (layout === 'game-only') return pathJoin(dest, safeGame);
    if (layout === 'etahen') return pathJoin(dest, 'etaHEN', 'games', safeGame);
    if (layout === 'itemzflow') return pathJoin(dest, 'games', safeGame);
    if (layout === 'dump_runner') return pathJoin(dest, 'homebrew', safeGame);
    if (layout === 'custom') return pathJoin(dest, safeGame);
    if (layout === 'game-ppsa') return pathJoin(dest, safeGame, finalPpsaName);
    return pathJoin(dest, safeGame);
  }

  function computeSourceFolder(it) {
    let path = it.ppsaFolderPath || it.folderPath || it.contentFolderPath || '';
    if (!path) return '';
    path = path.replace(/[\/\\]sce_sys$/i, '');
    return path;
  }

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

  function applySearchFilter() {
    const tbody = $('resultsBody');
    if (!tbody || !window.__ps5_lastRenderedItems) return;
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const filter = searchFilter.toLowerCase();
    rows.forEach((tr, idx) => {
      const item = window.__ps5_lastRenderedItems[idx];
      if (!item) return;
      const name = (item.displayTitle || item.folderName || '').toLowerCase();
      const visible = !filter || name.includes(filter);
      tr.style.display = visible ? '' : 'none';
    });
    updateHeaderCheckboxState();
  }

  function showPersistentToast(msg) {
    const pt = $('persistentToast');
    if (pt) {
      pt.textContent = msg;
      pt.style.display = 'block';
    }
  }

  function hidePersistentToast() {
    const pt = $('persistentToast');
    if (pt) {
      pt.style.display = 'none';
    }
  }

  function updateButtonStates() {
    const selected = getSelectedItems();
    const hasSelected = selected.length > 0;
    const hasExactlyOne = selected.length === 1;

    const btnGoBig = $('btnGoBig');
    if (btnGoBig) {
      btnGoBig.disabled = !hasSelected;
      btnGoBig.style.opacity = hasSelected ? '1' : '0.5';
    }

    const btnDeleteSelected = $('btnDeleteSelected');
    if (btnDeleteSelected) {
      btnDeleteSelected.disabled = !hasSelected;
      btnDeleteSelected.style.opacity = hasSelected ? '1' : '0.6';
    }

    const btnRenameSelected = $('btnRenameSelected');
    if (btnRenameSelected) {
      btnRenameSelected.disabled = !hasExactlyOne;
      btnRenameSelected.style.opacity = hasExactlyOne ? '1' : '0.6';
    }
  }

  async function refreshResultsAfterOperation() {
    const src = $('sourcePath') && $('sourcePath').value ? $('sourcePath').value.trim() : '';
    if (!src) return;
    try {
      showPersistentToast('Refreshing results...');
      const res = await window.ppsaApi.scanSource(src);
      const arr = Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
      renderResults(arr);
      // Restore FTP scan state so subsequent delete/rename correctly uses ftpDeleteItem/ftpRenameItem
      if (src.startsWith('ftp://') || /^\d+\.\d+\.\d+\.\d+/.test(src)) {
        isFtpScan = true;
      }
      hidePersistentToast();
    } catch (scanErr) {
      err('Refresh error:', scanErr);
      hidePersistentToast();
      toast('Refresh failed: ' + (scanErr.message || 'Unknown error'));
    }
  }

  async function goClickHandler() {
    let selected = getSelectedItems();
    if (!selected.length) {
      toast('No items selected');
      return;
    }
    try {
      // FIX B5: Rebuild `selected` as shallow-cloned items with corrected paths.
      // The old code created local `item` objects with path corrections but threw them away,
      // and then mutated the originals' displayTitle permanently (B6).
      const correctedItems = [];
      const tbody = $('resultsBody');
      const trs = Array.from(tbody.querySelectorAll('tr'));
      trs.forEach((tr, idx) => {
        if (tr.style.display === 'none') return;
        const cb = tr.querySelector('input[type="checkbox"]');
        if (cb && cb.checked) {
          const orig = window.__ps5_lastRenderedItems[idx];
          if (!orig) return;
          // Shallow-clone so mutations below don't affect the displayed table items
          const item = { ...orig };
          // Apply correct source folder (strips trailing /sce_sys if present)
          const correctPath = computeSourceFolder(item);
          if (correctPath) {
            item.folderPath = correctPath;
            item.contentFolderPath = correctPath;
            item.ppsaFolderPath = correctPath;
          }
          correctedItems.push(item);
        }
      });
      selected = correctedItems;
      if (!selected.length) {
        toast('No items selected');
        return;
      }

      // NOTE: displayTitle version-appending loop removed — it permanently mutated shared items
      // causing double-appended versions on repeated transfers.

      let dest = $('destPath') && $('destPath').value ? $('destPath').value.trim() : '';
      if (!dest) {
        toast('Select destination');
        return;
      }

      // Check if destination is FTP
      let ftpDestConfig = null;
      if (/^(\d+\.\d+\.\d+\.\d+(:\d+)?|ftp:\/\/)/.test(dest)) {
        ftpDestConfig = await window.FtpApi.openFtpModal(dest.startsWith('ftp://') ? dest : 'ftp://' + dest);
        if (!ftpDestConfig) {
          toast('FTP destination config required');
          return;
        }
        addRecentFtp(ftpDestConfig);
        // For FTP dest, set actual dest to FTP URL
        dest = 'ftp://' + ftpDestConfig.host + ':' + ftpDestConfig.port + ftpDestConfig.path;
      } else {
        // No longer call addRecentDest here
      }

      // Always add to recent dests (now includes FTP URLs)
      addRecentDest(dest);

      const src = $('sourcePath').value.trim();

      const action = $('action') ? $('action').value : 'copy';
      const layout = $('layout') ? $('layout').value : 'etahen';

      let customName = null;
      if (layout === 'custom') {
        if (selected.length > 1) {
          const batchRenamed = await openBatchRenameModal(selected);
          if (batchRenamed) {
            selected = batchRenamed;
            customName = null;
          } else {
            alert('Custom layout is only allowed for single game selection. Please select only one game.');
            return;
          }
        } else {
          customName = await openRenameModal();
          if (!customName || !customName.trim()) {
            alert('Custom name cannot be empty. Using default.');
            customName = null;
          } else {
            customName = customName.trim();
          }
        }
      }

      const preview = selected.map(it => ({
        item: computeFinalTargetForItem(it, dest, layout, customName).split(/[\\/]/).pop() || 'Unknown Game',
        source: it.source || computeSourceFolder(it),
        target: computeFinalTargetForItem(it, dest, layout, customName)
      }));


      const proceedAfterConfirm = async () => {
        const conflicts = await window.ppsaApi.checkConflicts(selected, dest, layout, customName);
        let overwriteMode = 'rename';

        const runOperation = async () => {
          const rb = $('resultModalBackdrop');
          const closeBtn = $('resultClose');
          const actionsRow = $('resultActionsRow');

          if (rb) {
            // Reset list
            const rl = $('resultList');
            if (rl) rl.innerHTML = '';
            TransferStats.reset();
            maxSpeed = 0;  // also reset via TransferStats.peakSpeed
            transferStartTime = Date.now();
            cancelOperation = false;

            // Show progress panel, hide others
            rb.style.display = 'flex';
            rb.setAttribute('aria-hidden', 'false');
            const pp = $('resultProgressPanel');
            const sp = $('resultSummaryPanel');
            const lw = $('resultListWrap');
            const te = $('resultTitleText');
            if (pp) pp.style.display = 'flex';
            if (sp) sp.style.display = 'none';
            if (lw) lw.style.display = 'none';
            if (te) te.textContent = 'Transferring…';
            if (closeBtn) closeBtn.style.display = 'none';

            // Reset stat chips
            for (const id of ['statSpeed','statEta','statElapsed','statTransferred']) {
              const el = $(id); if (el) el.textContent = '—';
            }
            const bar = $('resultProgressBar'); if (bar) bar.style.width = '0%';
            const cf = $('currentFileInfo'); if (cf) cf.textContent = '';
            const counter = $('resultItemCounter'); if (counter) counter.textContent = '';
            const lbl = $('resultItemLabel'); if (lbl) { lbl.textContent = ''; lbl.title = ''; }

            // Start elapsed ticker immediately (don't wait for go-start IPC round-trip)
            if (elapsedTimer) clearInterval(elapsedTimer);
            elapsedTimer = setInterval(() => {
              const el = $('statElapsed');
              if (el && transferStartTime) el.textContent = secToHMS((Date.now() - transferStartTime) / 1000);
            }, 1000);

            // Cancel button
            if (actionsRow) {
              actionsRow.innerHTML = '';
              const operationCancelBtn = document.createElement('button');
              operationCancelBtn.id = 'resultCancel';
              operationCancelBtn.className = 'btn-danger';
              operationCancelBtn.textContent = 'Cancel';
              operationCancelBtn.addEventListener('click', async () => {
                try {
                  operationCancelBtn.disabled = true;
                  operationCancelBtn.textContent = 'Cancelling...';
                  cancelOperation = true;
                  if (window.ppsaApi && typeof window.ppsaApi.cancelOperation === 'function') {
                    await window.ppsaApi.cancelOperation();
                  }
                } catch (_) {}
              });
              actionsRow.appendChild(operationCancelBtn);
              actionsRow.style.display = 'flex';
            }

            // Remove any stale dynamically-injected close button (old code put this on backdrop)
            const staleX = rb.querySelector('.close-x');
            if (staleX) staleX.remove();
          }
          setResultModalBusy(true);

          saveTransferState({ items: selected, dest, action, layout, customName, overwriteMode, ftpConfig: isFtpScan ? ftpConfig : null, ftpDestConfig });
          const res = await window.ppsaApi.ensureAndPopulate({ items: selected, dest, action, layout, customName, overwriteMode, ftpConfig: isFtpScan ? ftpConfig : null, ftpDestConfig });
          if (!res) throw new Error('No response');
          if (res.error) throw new Error(res.error);
          updateListSummary(res);

        };

        if (conflicts.length) {
          openConflictModal(conflicts, async (choice) => {
            overwriteMode = choice || 'rename';
            try {
              await runOperation();
            } catch (e) {
              err('runOperation (conflict path) error:', e);
              setResultModalBusy(false);
              toast('Operation failed: ' + (e.message || String(e)));
            }
          });
        } else {
          try {
            await runOperation();
          } catch (e) {
            err('runOperation error:', e);
            setResultModalBusy(false);
            toast('Operation failed: ' + (e.message || String(e)));
          }
        }
      };


      openConfirmModal(preview, { action, layout }, proceedAfterConfirm, () => {});
    } catch (e) {
      err('ensureAndPopulate error', e);
      toast('Operation failed: ' + (e.message || String(e)));
      setResultModalBusy(false); // only clear busy on error — success path is handled by go-complete
    }
  }

  function saveTransferState(state) {
    transferState = state;
    try {
      const stateForStorage = Object.assign({}, state, {
        items: (state.items || []).map(item => {
          if (!item.iconPath || !item.iconPath.startsWith('data:')) return item;
          const { iconPath: _i, ...rest } = item; return rest;
        })
      });
      localStorage.setItem(TRANSFER_STATE_KEY, JSON.stringify(stateForStorage));
    } catch (_) {}
  }

  function resumeTransfer() {
    if (!resumeState) return;
    const state = resumeState;

    // Open the progress modal just like runOperation does
    const rb = $('resultModalBackdrop');
    if (rb) {
      const rl = $('resultList');
      if (rl) rl.innerHTML = '';
      TransferStats.reset();
      maxSpeed = 0;
      transferStartTime = Date.now();
      cancelOperation = false;

      rb.style.display = 'flex';
      rb.setAttribute('aria-hidden', 'false');
      const pp = $('resultProgressPanel');
      const sp = $('resultSummaryPanel');
      const lw = $('resultListWrap');
      const te = $('resultTitleText');
      const closeBtn = $('resultClose');
      if (pp) pp.style.display = 'flex';
      if (sp) sp.style.display = 'none';
      if (lw) lw.style.display = 'none';
      if (te) te.textContent = 'Resuming transfer…';
      if (closeBtn) closeBtn.style.display = 'none';

      for (const id of ['statSpeed','statEta','statElapsed','statTransferred']) {
        const el = $(id); if (el) el.textContent = '—';
      }
      const bar = $('resultProgressBar'); if (bar) bar.style.width = '0%';
      const cf = $('currentFileInfo'); if (cf) cf.textContent = '';
      const counter = $('resultItemCounter'); if (counter) counter.textContent = '';
      const lbl = $('resultItemLabel'); if (lbl) { lbl.textContent = ''; lbl.title = ''; }

      if (elapsedTimer) clearInterval(elapsedTimer);
      elapsedTimer = setInterval(() => {
        const el = $('statElapsed');
        if (el && transferStartTime) el.textContent = secToHMS((Date.now() - transferStartTime) / 1000);
      }, 1000);

      // Cancel button
      const actionsRow = $('resultActionsRow');
      if (actionsRow) {
        actionsRow.innerHTML = '';
        const cancelBtn = document.createElement('button');
        cancelBtn.id = 'resultCancel';
        cancelBtn.className = 'btn-danger';
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
      }
    }
    setResultModalBusy(true);

    // Force overwrite on resume: cancelled transfers leave a partial target folder.
    // Using 'rename' (default) would copy alongside the partial as "(1)" — wrong.
    // Using 'overwrite' removes the partial and starts fresh for each item.
    const resumeOpts = Object.assign({}, state, { overwriteMode: 'overwrite' });

    window.ppsaApi.resumeTransfer(resumeOpts).then(res => {
      localStorage.removeItem(TRANSFER_STATE_KEY);
      resumeState = null;
      if (res && Array.isArray(res.results)) updateListSummary(res);
    }).catch(e => {
      toast('Resume failed: ' + (e.message || String(e)));
      setResultModalBusy(false);
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    });
  }

  function updateListSummary(res) {
    const rl = $('resultList');
    if (!rl || !res || !Array.isArray(res.results)) return;
    rl.innerHTML = '';

    let moved = 0, copied = 0, uploaded = 0, created = 0, skipped = 0, errors = 0, totalBytes = 0;

    for (const r of res.results) {
      // Tally
      if      (r.error)    errors++;
      else if (r.skipped)  skipped++;
      else if (r.created)  created++;
      else if (r.moved)    { moved++;    totalBytes += r.totalSize || 0; }
      else if (r.copied)   { copied++;   totalBytes += r.totalSize || 0; }
      else if (r.uploaded) { uploaded++; totalBytes += r.totalSize || 0; }

      // Determine badge
      let badgeClass = 'result-badge--skip';
      let badgeText = 'Skipped';
      if (r.error) {
        badgeClass = 'result-badge--err'; badgeText = 'Error';
      } else if (r.moved) {
        badgeClass = 'result-badge--ok'; badgeText = 'Moved';
      } else if (r.copied) {
        badgeClass = 'result-badge--ok'; badgeText = 'Copied';
      } else if (r.uploaded) {
        badgeClass = 'result-badge--ok'; badgeText = 'Uploaded';
      } else if (r.created) {
        badgeClass = 'result-badge--ok'; badgeText = 'Created';
      }

      const entry = document.createElement('div');
      Object.assign(entry.style, {
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
        gap: '12px', padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.04)'
      });

      // Left: name + paths
      const left = document.createElement('div');
      left.style.cssText = 'flex:1;min-width:0;';

      const nameEl = document.createElement('div');
      nameEl.style.cssText = 'font-weight:600;font-size:13px;color:var(--title);margin-bottom:4px;';
      nameEl.textContent = r.error ? `Error: ${r.error}` : (r.safeGameName || r.item || 'Unknown Game');
      left.appendChild(nameEl);

      if (!r.error) {
        for (const [label, val] of [['From', r.source || ''], ['To', r.target || '']]) {
          const line = document.createElement('div');
          line.style.cssText = 'font-size:11.5px;color:var(--muted);overflow-wrap:anywhere;line-height:1.5;';
          line.innerHTML = `<span style="font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:.05em;margin-right:5px;">${label}</span>${Utils.cleanPath(val)}`;
          left.appendChild(line);
        }
        if (r.totalSize > 0) {
          const sizeEl = document.createElement('div');
          sizeEl.style.cssText = 'font-size:11px;color:var(--muted);margin-top:3px;';
          sizeEl.textContent = bytesToHuman(r.totalSize);
          left.appendChild(sizeEl);
        }
      }

      // Right: badge
      const right = document.createElement('div');
      right.style.cssText = 'flex:0 0 auto;padding-top:2px;';
      const badge = document.createElement('span');
      badge.className = `result-badge ${badgeClass}`;
      badge.textContent = badgeText;
      right.appendChild(badge);

      entry.appendChild(left);
      entry.appendChild(right);
      rl.appendChild(entry);
    }

    totalTransferred = totalBytes;

    // Populate final summary badges
    const badgesEl = $('finalBadges');
    if (badgesEl) {
      badgesEl.innerHTML = '';
      const counts = [
        [copied + moved + uploaded + created, 'summary-badge--ok',  copied && moved ? `${copied} copied, ${moved} moved` : copied ? `${copied} copied` : moved ? `${moved} moved` : uploaded ? `${uploaded} uploaded` : `${created} created`],
        [skipped, 'summary-badge--skip', `${skipped} skipped`],
        [errors,  'summary-badge--err',  `${errors} error${errors !== 1 ? 's' : ''}`],
      ];
      for (const [n, cls, label] of counts) {
        if (!n) continue;
        const b = document.createElement('span');
        b.className = `summary-badge ${cls}`;
        b.textContent = label;
        badgesEl.appendChild(b);
      }
    }
  }


  // ── buildRow(r, index) ────────────────────────────────────────────────────
  // Builds one <tr> for a game record. Used by renderResults and appendGameRow.
  function buildRow(r, index) {
    const tr = document.createElement('tr');
    tr.dataset.selectable = '1';
    tr.dataset.index = String(index);

    // Checkbox cell
    const tdChk = document.createElement('td');
    tdChk.style.verticalAlign = 'top';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'chk';
    tdChk.appendChild(chk);
    tr.appendChild(tdChk);

    // Cover/thumbnail cell
    const tdCover = document.createElement('td');
    tdCover.className = 'cover';
    tdCover.style.verticalAlign = 'top';
    const coverWrap = document.createElement('div');
    coverWrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:var(--thumb-gap);';
    if (r.iconPath) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.alt = r.displayTitle || 'cover';
      img.decoding = 'async';
      img.loading = 'lazy';
      img.src = r.iconPath;
      img.addEventListener('error', () => { img.style.display = 'none'; });
      coverWrap.appendChild(img);
      if (typeof attachPreviewHandlers === 'function') attachPreviewHandlers(img, r.iconPath);
    } else {
      const ph = document.createElement('div');
      ph.style.cssText = 'width:var(--thumb-size);height:var(--thumb-size);background:rgba(255,255,255,0.02);border-radius:var(--thumb-radius);border:1px solid rgba(255,255,255,0.04);';
      coverWrap.appendChild(ph);
    }
    tdCover.appendChild(coverWrap);
    tr.appendChild(tdCover);

    // Title cell
    const tdGame = document.createElement('td');
    tdGame.className = 'game';
    tdGame.style.verticalAlign = 'top';
    const titleEl = document.createElement('div');
    titleEl.className = 'title-main';
    titleEl.style.cursor = 'pointer';
    titleEl.title = 'Click to view details';
    titleEl.textContent = r.displayTitle || r.folderName || r.ppsa || '';
    const subEl = document.createElement('div');
    subEl.className = 'title-sub';
    subEl.textContent = r.contentId || r.ppsa || '';
    tdGame.appendChild(titleEl);
    tdGame.appendChild(subEl);
    tr.appendChild(tdGame);

    // Size cell — spinner until size-update fires
    const tdSize = document.createElement('td');
    tdSize.className = 'size';
    tdSize.style.verticalAlign = 'top';
    if (r.totalSize > 0) {
      tdSize.textContent = bytesToHuman(r.totalSize);
    } else {
      tdSize.innerHTML = '<span class="size-calculating" title="Calculating…">⟳</span>';
    }
    tr.appendChild(tdSize);

    // Folder/info cell
    const tdFolder = document.createElement('td');
    tdFolder.className = 'folder';
    tdFolder.style.verticalAlign = 'top';
    const fpPath = r.ppsaFolderPath || r.folderPath || r.contentFolderPath || '';
    const fpDiv = document.createElement('div');
    fpDiv.title = fpPath;
    fpDiv.style.cssText = 'color:var(--muted);font-weight:700;cursor:pointer;';
    fpDiv.textContent = fpPath;
    fpDiv.addEventListener('click', () => { if (fpPath) window.ppsaApi.showInFolder(fpPath); });
    tdFolder.appendChild(fpDiv);
    const verShort = r.contentVersion || '';
    const sdkDisp  = typeof formatSdkVersionHexToDisplay === 'function' ? formatSdkVersionHexToDisplay(r.sdkVersion) : '';
    const infoText = [verShort ? `v${verShort}` : '', sdkDisp ? `FW ${sdkDisp}` : ''].filter(Boolean).join(' - ');
    if (infoText) {
      const infoDiv = document.createElement('div');
      infoDiv.className = 'title-sub';
      infoDiv.style.cssText = 'margin-top:4px;font-weight:normal;';
      infoDiv.textContent = infoText;
      tdFolder.appendChild(infoDiv);
    }
    tr.appendChild(tdFolder);

    // Row click selects checkbox
    tr.addEventListener('click', (ev) => {
      if (ev.target && ev.target.tagName === 'INPUT') return;
      chk.checked = !chk.checked;
      if (chk.checked) tr.classList.add('row-selected'); else tr.classList.remove('row-selected');
      updateHeaderCheckboxState();
    });
    chk.addEventListener('change', () => {
      if (chk.checked) tr.classList.add('row-selected'); else tr.classList.remove('row-selected');
      updateHeaderCheckboxState();
    });

    return tr;
  }

  // ── appendGameRow(item) ───────────────────────────────────────────────────
  // Called by onProgressMessage('game-found') to stream one row into the table
  // immediately as Phase 2 discovers each game, before any sizes are known.
  function appendGameRow(item) {
    if (!item) return;
    const tbody = $('resultsBody');
    if (!tbody) return;

    // Init list on first game
    if (!window.__ps5_lastRenderedItems) window.__ps5_lastRenderedItems = [];

    // Dedupe by exact path only — same game in different directories = different row.
    // NEVER block on PPSA/contentId match: the user wants all copies from all locations.
    const itemPath = String(item.folderPath || item.ppsaFolderPath || '').toLowerCase();
    if (itemPath && window.__ps5_lastRenderedItems.some(
      x => String(x.folderPath || x.ppsaFolderPath || '').toLowerCase() === itemPath
    )) return;

    // Clear placeholder on first real game
    const placeholder = tbody.querySelector('td[colspan]');
    if (placeholder) tbody.innerHTML = '';

    const index = window.__ps5_lastRenderedItems.length;
    window.__ps5_lastRenderedItems.push(item);
    tbody.appendChild(buildRow(item, index));

    const n = window.__ps5_lastRenderedItems.length;
    const sc = $('scanCount');
    if (sc) sc.textContent = `${n} game${n !== 1 ? 's' : ''} found — sizing…`;

    applySearchFilter();
    updateHeaderCheckboxState();
  }

  function renderResults(arr, scanDuration) {
    const tbody = $('resultsBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const raw = Array.isArray(arr) ? arr : [];
    const list = dedupeItems(raw);
    window.__ps5_lastRenderedItems = list;

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
      tbody.appendChild(buildRow(list[i], i));
    }

    const durationText = scanDuration ? ` (scanned in ${scanDuration}s)` : '';
    $('scanCount') && ($('scanCount').textContent = `${list.length} games found${durationText}`);
    updateHeaderCheckboxState();
    // Only hide scan UI if all items already have sizes (no pending size-update events).
    // If any spinner remains, the size-update handler will hide it when done >= total.
    const hasPendingSpinners = list.some(item => !item.totalSize || item.totalSize <= 0);
    if (!hasPendingSpinners) showScanUI(false);
    try {
      const listForStorage = list.map(item => {
        if (!item.iconPath || !item.iconPath.startsWith('data:')) return item;
        const { iconPath: _i, ...rest } = item; return rest;
      });
      localStorage.setItem(LAST_RESULTS_KEY, JSON.stringify(listForStorage));
    } catch (_) {}
    applySearchFilter();
  }

  // Expose renderResults for modular use
  window.RendererApi = { renderResults };

  function updateHeaderCheckboxState() {
    const header = $('chkHeader');
    if (!header) return;
    const visible = Array.from(document.querySelectorAll('#resultsBody tr')).filter(tr => tr.offsetParent !== null && tr.style.display !== 'none');
    if (!visible.length) {
      header.checked = false;
      header.indeterminate = false;
      updateButtonStates();
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
    updateButtonStates();
  }

  function toggleHeaderSelect() {
    const visible = Array.from(document.querySelectorAll('#resultsBody tr')).filter(tr => tr.offsetParent !== null && tr.style.display !== 'none');
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
    currentSortBy = by;
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

  // Elapsed timer for the in-progress display
  let elapsedTimer = null;

  function onProgressMessage(d) {
    if (!d || !d.type) return;

    if (d.type === 'scan') {
      const label = $('currentScanLabel');
      if (label) {
        const text = d.progressText || Utils.normalizeDisplayPath(d.folder || d.path || '') || 'Scanning...';
        label.textContent = text;
      }
      return;
    }

    // Live game streaming — append a row immediately as each game is discovered (Phase 2)
    if (d.type === 'game-found') {
      if (d.item) appendGameRow(d.item);
      const label = $('currentScanLabel');
      if (label) {
        const n = window.__ps5_lastRenderedItems ? window.__ps5_lastRenderedItems.length : 0;
        label.textContent = `Found ${n} game${n !== 1 ? 's' : ''}…`;
      }
      return;
    }

    // Main process is counting files before copy (size was unknown at scan time)
    if (d.type === 'go-counting') {
      // 'resultItemLabel' is the correct ID (same as go-file-progress handler uses)
      const itemLabel = $('resultItemLabel');
      const cf        = $('currentFileInfo');
      const bar       = $('resultProgressBar');
      if (itemLabel) { itemLabel.textContent = `Counting files…`; itemLabel.title = ''; }
      if (cf) cf.textContent = `Calculating size for game ${d.itemIndex} of ${d.totalItems}…`;
      if (bar) { bar.style.width = '2%'; bar.style.transition = 'none'; }
      return;
    }

    // Local + FTP size streaming: replace ⟳ spinner with real size as each game is sized
    if (d.type === 'size-update') {
      if (window.__ps5_lastRenderedItems) {
        const tbody = $('resultsBody');
        window.__ps5_lastRenderedItems.forEach((item, idx) => {
          if (
            (d.folderPath && (item.folderPath === d.folderPath || item.ppsaFolderPath === d.folderPath)) ||
            (d.contentId  && item.contentId === d.contentId)
          ) {
            item.totalSize = d.totalSize;
            if (tbody && d.totalSize > 0) {
              const row = tbody.querySelector(`tr[data-index="${idx}"]`);
              if (row) {
                const sizeCell = row.querySelector('td.size');
                if (sizeCell) {
                  sizeCell.textContent = bytesToHuman(d.totalSize);
                  sizeCell.style.transition = 'opacity 0.3s';
                  sizeCell.style.opacity = '0.4';
                  requestAnimationFrame(() => { sizeCell.style.opacity = '1'; });
                }
              }
            }
          }
        });
      }
      const label = $('currentScanLabel');
      const pct = d.total > 0 ? Math.round((d.done / d.total) * 100) : 0;
      if (label && d.done < d.total) {
        label.textContent = `Calculating sizes… ${d.done}/${d.total} (${pct}%) — large games may take a minute`;
      }
      const bar = $('actionTotalProgressBar');
      if (bar && d.total > 0) { bar.style.width = pct + '%'; bar.style.transition = 'width 0.3s'; }
      if (d.done >= d.total) {
        setTimeout(() => { const lbl = $('currentScanLabel'); if (lbl) lbl.textContent = ''; showScanUI(false); }, 600);
        const n = window.__ps5_lastRenderedItems ? window.__ps5_lastRenderedItems.length : 0;
        const sc = $('scanCount');
        if (sc) sc.textContent = `${n} game${n !== 1 ? 's' : ''} found`;
        try {
          const forStorage = (window.__ps5_lastRenderedItems || []).map(item => {
            if (!item.iconPath || !item.iconPath.startsWith('data:')) return item;
            const { iconPath: _i, ...rest } = item; return rest;
          });
          localStorage.setItem(LAST_RESULTS_KEY, JSON.stringify(forStorage));
        } catch (_) {}
        setAppBusy(false);
      }
      return;
    }

    if (d.type === 'go-start') {
      // If runOperation already started the timer, don't reset it — just update item count
      if (!transferStartTime) {
        setResultModalBusy(true);
        TransferStats.reset();
        maxSpeed = 0;
        completedFiles = [];
        transferStartTime = Date.now();
        cancelOperation = false;

        const progressPanel = $('resultProgressPanel');
        const summaryPanel  = $('resultSummaryPanel');
        const listWrap      = $('resultListWrap');
        const titleEl       = $('resultTitleText');
        const closeBtn      = $('resultClose');
        const rb            = $('resultModalBackdrop');

        if (progressPanel) progressPanel.style.display = 'flex';
        if (summaryPanel)  summaryPanel.style.display  = 'none';
        if (listWrap)      listWrap.style.display      = 'none';
        if (titleEl)       titleEl.textContent         = 'Transferring…';
        if (closeBtn)      closeBtn.style.display      = 'none';
        if (rb) { rb.style.display = 'flex'; rb.setAttribute('aria-hidden', 'false'); }

        for (const id of ['statSpeed','statEta','statElapsed','statTransferred']) {
          const el = $(id); if (el) el.textContent = '—';
        }
        const bar = $('resultProgressBar'); if (bar) bar.style.width = '0%';
        const cf = $('currentFileInfo'); if (cf) cf.textContent = '';
        const counter = $('resultItemCounter'); if (counter) counter.textContent = '';
        // Clear the default "Preparing…" label that's baked into the HTML
        const lbl = $('resultItemLabel'); if (lbl) { lbl.textContent = ''; lbl.title = ''; }

        if (elapsedTimer) clearInterval(elapsedTimer);
        elapsedTimer = setInterval(() => {
          const el = $('statElapsed');
          if (el && transferStartTime) el.textContent = secToHMS((Date.now() - transferStartTime) / 1000);
        }, 1000);
      }
      return;
    }

    if (d.type === 'go-file-progress' || d.type === 'go-file-complete') {
      if (!transferStartTime) transferStartTime = Date.now();
      if (!elapsedTimer) {
        elapsedTimer = setInterval(() => {
          const el = $('statElapsed');
          if (el && transferStartTime) el.textContent = secToHMS((Date.now() - transferStartTime) / 1000);
        }, 1000);
      }
      if (cancelOperation) return;
      if (d.fileRel) lastFile = d.fileRel;

      // ── Determine the "global" bytes for speed + bar ────────────────────
      // For multi-game transfers, d.grandTotalCopied is monotonically increasing
      // across item boundaries — unlike d.totalBytesCopied which resets to 0
      // at the start of each game and causes the sliding window to show 0 MB/s
      // for several seconds at every item boundary.
      const isMulti       = d.totalItems > 1;
      const grandTotal    = d.grandTotalBytes  || 0;
      const grandCopied   = d.grandTotalCopied || d.totalBytesCopied || 0;
      const speedInput    = isMulti && grandCopied > 0 ? grandCopied : (d.totalBytesCopied || 0);
      const etaTotal      = isMulti && grandTotal > 0  ? grandTotal  : (d.totalBytes || 0);

      const stats   = TransferStats.update(speedInput, etaTotal);
      maxSpeed      = TransferStats.peakSpeed;

      // ── Progress bar — overall % for multi-item, per-item for single ────
      const hasGrand   = grandTotal > 0 && grandCopied >= 0;
      const hasItem    = (d.totalBytes || 0) > 0;
      const barPct     = isMulti && hasGrand
        ? Math.min(100, (grandCopied / grandTotal) * 100)
        : hasItem ? Math.min(100, ((d.totalBytesCopied || 0) / d.totalBytes) * 100)
        : 0;

      const bar = $('resultProgressBar');
      if (bar) {
        bar.style.transition = 'width 0.15s linear';
        bar.style.width = (hasGrand || hasItem) ? `${barPct.toFixed(2)}%` : '0%';
      }

      // ── Stat chips ───────────────────────────────────────────────────────
      const statSpeed = $('statSpeed');
      const statEta   = $('statEta');
      const statXfer  = $('statTransferred');

      // Speed: only show once we have at least 2 valid window samples
      if (statSpeed) statSpeed.textContent = stats.speedBps > 1024 ? bytesToHuman(stats.speedBps) + '/s' : '—';

      // ETA: based on overall remaining
      if (statEta) {
        const etaRemaining = Math.max(0, etaTotal - speedInput);
        const etaSec = stats.speedBps > 1024 ? etaRemaining / stats.speedBps : 0;
        statEta.textContent = etaSec > 0 ? secToHMS(etaSec) : '—';
      }

      // Transferred: "X of Y" for multi-item, "X / Y" for single with known size
      if (statXfer) {
        if (isMulti && hasGrand) {
          statXfer.textContent = `${bytesToHuman(grandCopied)} / ${bytesToHuman(grandTotal)}`;
        } else if (hasItem) {
          statXfer.textContent = `${bytesToHuman(d.totalBytesCopied || 0)} / ${bytesToHuman(d.totalBytes)}`;
        } else {
          statXfer.textContent = bytesToHuman(d.totalBytesCopied || 0);
        }
      }

      // ── File label + item counter ────────────────────────────────────────
      const itemLabel   = $('resultItemLabel');
      const itemCounter = $('resultItemCounter');

      if (itemLabel) {
        if (lastFile) {
          itemLabel.textContent = lastFile;
          itemLabel.title = lastFile;
        } else {
          itemLabel.textContent = 'Transferring…';
          itemLabel.title = '';
        }
      }
      if (itemCounter && d.totalItems > 0) {
        itemCounter.textContent = `Game ${d.itemIndex || 1} of ${d.totalItems}`;
      }

      // ── Detail line — per-item progress ─────────────────────────────────
      const cf = $('currentFileInfo');
      if (cf) {
        if (hasItem) {
          const pct = Math.min(100, ((d.totalBytesCopied || 0) / d.totalBytes) * 100);
          const prefix = isMulti ? `Game ${d.itemIndex}: ` : '';
          cf.textContent = `${prefix}${pct.toFixed(0)}% — ${bytesToHuman(d.totalBytesCopied || 0)} of ${bytesToHuman(d.totalBytes)}`;
        } else {
          cf.textContent = grandCopied > 0 ? `${bytesToHuman(grandCopied)} copied` : '';
        }
      }
      return;
    }

    if (d.type === 'go-complete') {
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
      setResultModalBusy(false);
      showScanUI(false);
      showNotification('Transfer complete', 'PS5 Vault operation finished.');
      localStorage.removeItem(TRANSFER_STATE_KEY);
      // Log to transfer history
      try {
        const src = $('sourcePath') ? $('sourcePath').value.trim() : '';
        const dst = $('destPath') ? $('destPath').value.trim() : '';
        const actionEl = $('action');
        const actionVal = actionEl ? actionEl.value : '';
        // Count checked rows
        const checkedRows = document.querySelectorAll('#resultsBody tr input[type="checkbox"]:checked');
        const itemCount = checkedRows ? checkedRows.length : 0;
        const histDurationMs = transferStartTime ? Date.now() - transferStartTime : 0;
        addTransferHistoryEntry({
          date: new Date().toISOString(),
          source: src,
          dest: dst,
          action: actionVal,
          items: itemCount,
          totalBytes: d.grandTotalBytes || d.totalBytesCopied || totalTransferred || 0,
          durationMs: histDurationMs,
        });
      } catch (_) {}

      const durationMs  = transferStartTime ? Date.now() - transferStartTime : 0;
      // Use grandTotalBytes from last progress event if available, else fallback
      const totalBytes  = d.grandTotalBytes || d.totalBytesCopied || totalTransferred || 0;
      const totalCopied = d.grandTotalCopied || d.totalBytesCopied || totalTransferred || 0;
      const durationSec = durationMs / 1000;
      // Average speed over ENTIRE transfer (not just the window) for the summary card
      const avgSpeedBps = durationSec > 1 ? (totalCopied / durationSec) : 0;

      // Populate final summary panel
      const fd = $('finalDuration');
      const ft = $('finalTransferred');
      const fa = $('finalAvgSpeed');
      const fp = $('finalPeakSpeed');
      if (fd) fd.textContent = durationMs >= 100 ? secToHMS(durationMs / 1000) : durationMs > 0 ? `${durationMs}ms` : '—';
      if (ft) ft.textContent = totalCopied > 0 ? bytesToHuman(totalCopied) : '—';
      if (fa) fa.textContent = avgSpeedBps > 0 ? bytesToHuman(avgSpeedBps) + '/s' : '—';
      if (fp) fp.textContent = TransferStats.peakSpeed > 0 ? bytesToHuman(TransferStats.peakSpeed) + '/s' : (maxSpeed > 0 ? bytesToHuman(maxSpeed) + '/s' : '—');

      // Show panels
      const progressPanel = $('resultProgressPanel');
      const summaryPanel  = $('resultSummaryPanel');
      const listWrap      = $('resultListWrap');
      const titleEl       = $('resultTitleText');
      const closeBtn      = $('resultClose');
      const actionsRow    = $('resultActionsRow');
      if (progressPanel) progressPanel.style.display = 'none';
      if (summaryPanel)  summaryPanel.style.display  = 'flex';
      if (listWrap)      listWrap.style.display      = 'block';
      if (titleEl)       titleEl.textContent         = 'Transfer complete';
      if (closeBtn)      closeBtn.style.display      = 'flex';
      if (actionsRow)    actionsRow.style.display    = 'none';
      if ($('currentScanLabel')) $('currentScanLabel').textContent = '';
      transferStartTime = 0;
      return;
    }

    if (d.type === 'go-item') {
      const label = $('currentScanLabel');
      const raw = d.folder || d.path || '';
      if (label) label.textContent = Utils.pathEndsWithSceSys(raw) ? '' : (Utils.normalizeDisplayPath(raw) || '');
      return;
    }
  }

  // ── Game metadata panel ──────────────────────────────────────────────────────
  function openGameDetailModal(item) {
    const backdrop = $('gameDetailBackdrop');
    if (!backdrop) return;
    const nameEl = $('gameDetailName');
    const bodyEl = $('gameDetailBody');
    const closeBtn = $('gameDetailClose');
    const closeX = $('gameDetailCloseX');
    if (nameEl) nameEl.textContent = item.displayTitle || item.folderName || 'Game Details';
    if (bodyEl) {
      const parsed = item.paramParsed || {};
      const fields = [
        ['Title', item.displayTitle || item.folderName || ''],
        ['Content ID', item.contentId || ''],
        ['Title ID', item.titleId || parsed.titleId || ''],
        ['PPSA ID', item.ppsa || ''],
        ['Version', item.contentVersion || parsed.contentVersion || parsed.masterVersion || ''],
        ['SDK Version', item.sdkVersion || parsed.sdkVersion || ''],
        ['Required FW', item.fwSku || parsed.requiredSystemSoftwareVersion || ''],
        ['Region', item.region || parsed.defaultLanguage || ''],
        ['Folder', item.folderPath || item.ppsaFolderPath || ''],
        ['Size', item.totalSize > 0 ? bytesToHuman(item.totalSize) : 'Calculating…'],
      ];
      bodyEl.innerHTML = fields.filter(([,v]) => v).map(([k,v]) =>
        '<div style="display:flex;gap:12px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.04);">' +
        '<span style="flex:0 0 130px;color:var(--muted);font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;">' + Utils.escapeHtml(k) + '</span>' +
        '<span style="flex:1;color:var(--title);font-size:12.5px;word-break:break-all;">' + Utils.escapeHtml(String(v)) + '</span>' +
        '</div>'
      ).join('');
    }
    const close = () => {
      backdrop.style.display = 'none';
      backdrop.setAttribute('aria-hidden', 'true');
    };
    if (closeBtn) { closeBtn.onclick = close; }
    if (closeX) { closeX.onclick = close; }
    backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
    backdrop.style.display = 'flex';
    backdrop.setAttribute('aria-hidden', 'false');
  }

  // ── Transfer history modal ────────────────────────────────────────────────────
  function openHistoryModal() {
    const backdrop = $('historyModalBackdrop');
    if (!backdrop) return;
    const bodyEl = $('historyModalBody');
    const closeBtn = $('historyClose');
    const closeX = $('historyCloseX');
    const history = getTransferHistory();
    if (bodyEl) {
      if (!history.length) {
        bodyEl.innerHTML = '<p style="color:var(--muted);font-size:13px;">No transfers recorded yet.</p>';
      } else {
        const ACTION_LABELS = { copy: 'Copy', move: 'Move', 'folder-only': 'Folder', verify: 'Verify' };
        bodyEl.innerHTML = history.map((h, idx) => {
          const d = new Date(h.date);
          const dateStr = d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' })
                        + ' ' + d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
          const sizeStr = h.totalBytes > 0 ? bytesToHuman(h.totalBytes) : '';
          const durStr  = h.durationMs > 0 ? secToHMS(h.durationMs / 1000) : (h.duration > 0 ? secToHMS(h.duration / 1000) : '');
          const actionLabel = ACTION_LABELS[h.action] || (h.action ? h.action : '');
          const itemsStr = h.items > 0 ? h.items + ' game' + (h.items !== 1 ? 's' : '') : '';
          // Chips row
          const chips = [actionLabel, itemsStr, sizeStr, durStr].filter(Boolean);
          const srcName = (h.source || '').replace(/\\/g, '/').split('/').pop() || h.source || '';
          const dstName = (h.dest || '').replace(/\\/g, '/').split('/').pop() || h.dest || '';
          return '<div style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);">' +
            '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:5px;">' +
            '<span style="font-size:11px;color:var(--muted);white-space:nowrap;">' + Utils.escapeHtml(dateStr) + '</span>' +
            '<div style="display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end;">' +
            chips.map(c => '<span style="font-size:10.5px;background:rgba(255,255,255,0.07);border-radius:4px;padding:1px 6px;color:var(--muted-2);">' + Utils.escapeHtml(c) + '</span>').join('') +
            '</div></div>' +
            '<div style="font-size:12px;display:flex;gap:4px;align-items:baseline;margin-bottom:2px;">' +
            '<span style="color:var(--muted);min-width:36px;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;">From</span>' +
            '<span style="color:var(--title);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + Utils.escapeHtml(h.source || '') + '">' + Utils.escapeHtml(srcName) + '</span>' +
            '</div>' +
            '<div style="font-size:12px;display:flex;gap:4px;align-items:baseline;">' +
            '<span style="color:var(--muted);min-width:36px;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;">To</span>' +
            '<span style="color:var(--title);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + Utils.escapeHtml(h.dest || '') + '">' + Utils.escapeHtml(dstName) + '</span>' +
            '</div>' +
            '</div>';
        }).join('');
      }
    }
    const close = () => {
      backdrop.style.display = 'none';
      backdrop.setAttribute('aria-hidden', 'true');
    };
    if (closeBtn) closeBtn.onclick = close;
    if (closeX) closeX.onclick = close;
    backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
    // Wire "Clear All" button that lives in the modal footer
    const clearBtn = $('historyClearAll');
    if (clearBtn) {
      clearBtn.onclick = () => {
        if (!confirm('Clear all transfer history?')) return;
        try { localStorage.removeItem(TRANSFER_HISTORY_KEY); } catch (_) {}
        if (bodyEl) bodyEl.innerHTML = '<p style="color:var(--muted);font-size:13px;">No transfers recorded yet.</p>';
        toast('Transfer history cleared');
      };
    }
    backdrop.style.display = 'flex';
    backdrop.setAttribute('aria-hidden', 'false');
  }

  document.addEventListener('DOMContentLoaded', () => {
    try {
      // Ensure inputs are always editable
      const ensureInputsEditable = () => {
        const sourceInput = $('sourcePath');
        const destInput = $('destPath');
        if (sourceInput) {
          sourceInput.disabled = false;
          sourceInput.readOnly = false;
          sourceInput.style.pointerEvents = 'auto';
          sourceInput.setAttribute('autocomplete', 'off');
        }
        if (destInput) {
          destInput.disabled = false;
          destInput.readOnly = false;
          destInput.style.pointerEvents = 'auto';
          destInput.setAttribute('autocomplete', 'off');
        }
      };

      ensureInputsEditable(); // Ensure inputs are editable on load

      // Attach to source and dest inputs
      const sourceInput = $('sourcePath');
      const destInput = $('destPath');

      // Save & add to recent on blur — captures manually typed paths
      if (sourceInput) {
        sourceInput.addEventListener('blur', () => {
          const v = sourceInput.value.trim();
          if (v) { addRecentSource(v); try { localStorage.setItem(LAST_SRC_KEY, v); } catch(_) {} }
        });
        sourceInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') sourceInput.blur();
        });
      }
      if (destInput) {
        destInput.addEventListener('blur', () => {
          const v = destInput.value.trim();
          if (v) { addRecentDest(v); try { localStorage.setItem(LAST_DST_KEY, v); } catch(_) {} }
        });
        destInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') destInput.blur();
        });
      }

      Preview.init();
      applySettings();

      const lastSrc = localStorage.getItem(LAST_SRC_KEY);
      if (lastSrc && $('sourcePath')) $('sourcePath').value = lastSrc;

      const lastDst = localStorage.getItem(LAST_DST_KEY);
      if (lastDst && $('destPath')) $('destPath').value = lastDst;

      const lastLayout = localStorage.getItem(LAST_LAYOUT_KEY) || 'etahen';
      const lastAction = localStorage.getItem(LAST_ACTION_KEY) || 'copy';
      if ($('layout')) $('layout').value = lastLayout;
      if ($('action')) $('action').value = lastAction;

      updateSourceHistoryDatalist();
      updateDestHistoryDatalist();

      const brandLogo = $('brandLogo');
      if (brandLogo) {
        brandLogo.addEventListener('click', () => {
          if (confirm('Clear all recent sources, destinations, and FTP?')) {
            try {
              localStorage.removeItem(RECENT_SOURCES_KEY);
              localStorage.removeItem(RECENT_DESTS_KEY);
              localStorage.removeItem('ps5vault.recentFtp');
              localStorage.removeItem(LAST_SRC_KEY);
              localStorage.removeItem(LAST_DST_KEY);
              $('sourcePath').value = '';
              $('destPath').value = '';
              updateSourceHistoryDatalist();
              updateDestHistoryDatalist();
                    toast('Recent paths and fields cleared');
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

      // CRITICAL: register the progress handler FIRST so we don't miss any
      // IPC events that fire during the async resumeTransfer() call below.
      if (window.ppsaApi && typeof window.ppsaApi.onScanProgress === 'function') {
        window.ppsaApi.onScanProgress(onProgressMessage);
      }

      resumeState = JSON.parse(localStorage.getItem(TRANSFER_STATE_KEY) || 'null');
      if (resumeState) {
        const itemCount = (resumeState.items || []).length;
        const destLabel = resumeState.dest || 'unknown destination';
        const shouldResume = confirm('A previous transfer was interrupted. Resume it?\n\n' + itemCount + ' game(s) to ' + destLabel);
        if (shouldResume) {
          resumeTransfer();
        } else {
          // User declined — clear state so we don't keep prompting on every reload
          localStorage.removeItem(TRANSFER_STATE_KEY);
          resumeState = null;
        }
      }

      const madeBy = $('madeBy');
      if (madeBy) {
        madeBy.addEventListener('click', toggleTheme);
      }

      // Receive app version from main process and update subtitle
      if (window.ppsaApi && typeof window.ppsaApi.onAppVersion === 'function') {
        window.ppsaApi.onAppVersion((ver) => {
          const sub = document.querySelector('.app-sub');
          if (sub) sub.textContent = `Organize PPSA folders v${ver}`;
        });
      }

      // ── Auto-updater UI ────────────────────────────────────────────────────
      let pendingUpdateUrl = null;

      function showUpdateBanner(info) {
        const banner = $('updateBanner');
        const text   = $('updateBannerText');
        if (!banner || !text) return;
        pendingUpdateUrl = info.downloadUrl;
        text.textContent = `🆕 PS5 Vault ${info.latestVersion} is available (you have ${info.currentVersion})`;
        banner.style.display = 'flex';
      }

      function hideUpdateBanner() {
        const banner = $('updateBanner');
        if (banner) banner.style.display = 'none';
      }

      if (window.ppsaApi && typeof window.ppsaApi.onUpdateAvailable === 'function') {
        window.ppsaApi.onUpdateAvailable(showUpdateBanner);
      }

      if (window.ppsaApi && typeof window.ppsaApi.onUpdateDownloadProgress === 'function') {
        window.ppsaApi.onUpdateDownloadProgress(({ pct, received, total }) => {
          const bar  = $('updateProgressBar');
          const fill = $('updateProgressFill');
          const text = $('updateBannerText');
          if (bar)  bar.style.display  = 'block';
          if (fill) fill.style.width   = pct + '%';
          if (text) text.textContent   = `Downloading update… ${pct}% (${(received/1024/1024).toFixed(1)} / ${(total/1024/1024).toFixed(1)} MB)`;
        });
      }

      const updateNowBtn = $('updateNowBtn');
      if (updateNowBtn) {
        updateNowBtn.addEventListener('click', async () => {
          if (!pendingUpdateUrl) return;
          updateNowBtn.disabled    = true;
          updateNowBtn.textContent = 'Downloading…';
          const laterBtn = $('updateLaterBtn');
          if (laterBtn) laterBtn.disabled = true;
          try {
            await window.ppsaApi.downloadAndInstallUpdate(pendingUpdateUrl);
            const text = $('updateBannerText');
            if (text) text.textContent = 'Update downloaded — restarting…';
          } catch (e) {
            toast('Update failed: ' + (e.message || String(e)));
            updateNowBtn.disabled    = false;
            updateNowBtn.textContent = 'Update Now';
            if (laterBtn) laterBtn.disabled = false;
            const bar = $('updateProgressBar');
            if (bar) bar.style.display = 'none';
          }
        });
      }

      const updateLaterBtn = $('updateLaterBtn');
      if (updateLaterBtn) {
        updateLaterBtn.addEventListener('click', hideUpdateBanner);
      }
      // ── End auto-updater UI ────────────────────────────────────────────────




      document.addEventListener('click', (e) => {
        const link = e.target.closest('a');
        if (link && link.href && link.href !== '#') {
          e.preventDefault();
          if (window.ppsaApi && typeof window.ppsaApi.openExternal === 'function') {
            window.ppsaApi.openExternal(link.href);
          } else {
            window.open(link.href, '_blank');
          }
        }
      });

      document.addEventListener('auxclick', (e) => {
        if (e.target.closest('a')) {
          e.preventDefault();
        }
      });

      document.addEventListener('keydown', e => {
        if (e.ctrlKey && e.key === 'a') {
          e.preventDefault();
          // FIX B7: was selecting ALL rows including hidden (search-filtered) ones
          Array.from($('resultsBody').querySelectorAll('input[type="checkbox"]'))
            .filter(cb => cb.closest('tr').style.display !== 'none')
            .forEach(cb => {
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
          if (window.HelpApi && window.HelpApi.openHelp) window.HelpApi.openHelp(e);
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          const rows = Array.from($('resultsBody').querySelectorAll('tr')).filter(tr => tr.style.display !== 'none');
          const activeRow = document.activeElement.closest('tr');
          const idx = rows.indexOf(activeRow);
          const nextIdx = e.key === 'ArrowDown' ? Math.min(idx + 1, rows.length - 1) : Math.max(idx - 1, 0);
          rows[nextIdx]?.focus();
        }
      });

      const btnPickSource = $('btnPickSource');
      if (btnPickSource) {
        btnPickSource.addEventListener('click', async () => {
          try {
            const result = await window.ppsaApi.openDirectory();
            if (!result.canceled && result.filePaths && result.filePaths[0]) {
              $('sourcePath').value = result.filePaths[0];
              addRecentSource(result.filePaths[0]);
              try { localStorage.setItem(LAST_SRC_KEY, result.filePaths[0]); } catch (_) {}
            }
          } catch (e) {
            console.error(e);
            alert('Error picking source: ' + e.message);
          }
        });
      }
      const btnPickDest = $('btnPickDest');
      if (btnPickDest) {
        btnPickDest.addEventListener('click', async () => {
          try {
            const result = await window.ppsaApi.openDirectory();
            if (!result.canceled && result.filePaths && result.filePaths[0]) {
              $('destPath').value = result.filePaths[0];
              addRecentDest(result.filePaths[0]);
              try { localStorage.setItem(LAST_DST_KEY, result.filePaths[0]); } catch (_) {}
            }
          } catch (e) {
            console.error(e);
            alert('Error picking dest: ' + e.message);
          }
        });
      }
      const btnScan = $('btnScan');
      if (btnScan) {
        btnScan.addEventListener('click', async () => {
          if (appBusy) { toast('Please wait for the current operation to finish.'); return; }
          try {
            const src = $('sourcePath') && $('sourcePath').value ? $('sourcePath').value.trim() : '';
            if (!src) { toast('Select source first'); return; }
            let actualSrc = src;
            isFtpScan = false;
            ftpConfig = null;
            if (src === 'browse') {
              const result = await window.ppsaApi.openDirectory();
              if (!result.canceled && result.filePaths && result.filePaths[0]) {
                actualSrc = result.filePaths[0];
                addRecentSource(result.filePaths[0]);
              } else { return; }
            } else if (src === 'ftp') {
              const ftpUrl = prompt('Enter FTP URL (e.g., ftp://192.168.1.100 or 192.168.1.100/mnt/ext1/etaHEN/games):');
              if (ftpUrl) {
                actualSrc = ftpUrl.startsWith('ftp://') ? ftpUrl : 'ftp://' + ftpUrl;
                addRecentSource(ftpUrl);
              } else { return; }
            } else if (/^(\d+\.\d+\.\d+\.\d+(:\d+)?|ftp:\/\/)/.test(src)) {
              const config = await window.FtpApi.openFtpModal(src.startsWith('ftp://') ? src : 'ftp://' + src);
              if (config) {
                ftpConfig = config;
                isFtpScan = true;
                actualSrc = 'ftp://' + config.host + ':' + config.port + config.path;
                addRecentFtp(config);
              } else { return; }
            } else {
              addRecentSource(src);
            }
            try { localStorage.setItem(LAST_SRC_KEY, actualSrc); } catch (_) {}
            setAppBusy(true, 'Scanning…');
            showScanUI(true);
            $('currentScanLabel').textContent = isFtpScan
              ? 'Scanning FTP — discovering games…'
              : 'Scanning…';
            scanStartTime = Date.now();
            window.__ps5_lastRenderedItems = [];
            $('resultsBody').innerHTML = '';
            const res = await window.ppsaApi.scanSource(actualSrc);
            const arr = Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
            if (arr.length > 0) {
              const duration = Math.round((Date.now() - scanStartTime) / 1000);
              renderResults(arr, duration);
            } else if (!window.__ps5_lastRenderedItems || window.__ps5_lastRenderedItems.length === 0) {
              $('resultsBody').innerHTML = `<tr><td colspan="5" style="color:var(--muted);padding:12px">No games found.</td></tr>`;
              $('scanCount').textContent = '';
            }
            currentSortBy = 'name';
          } catch (e) {
            console.error(e);
            toast('Scan failed: Check connection or path. Try again.');
          } finally {
            setAppBusy(false);
          }
        });
      }

      const btnScanAllDrives = $('btnScanAllDrives');
      if (btnScanAllDrives) {
        btnScanAllDrives.addEventListener('click', async () => {
          if (appBusy) { toast('Please wait for the current operation to finish.'); return; }
          try {
            const src = 'all-drives';
            isFtpScan = false;
            ftpConfig = null;
            addRecentSource(src);
            try { localStorage.setItem(LAST_SRC_KEY, src); } catch (_) {}
            setAppBusy(true, 'Scanning all drives…');
            showScanUI(true);
            $('currentScanLabel').textContent = 'Scanning all drives...';
            scanStartTime = Date.now();
            window.__ps5_lastRenderedItems = [];
            $('resultsBody').innerHTML = '';
            const res = await window.ppsaApi.scanSource(src);
            const arr = Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
            if (arr.length > 0) {
              const duration = Math.round((Date.now() - scanStartTime) / 1000);
              renderResults(arr, duration);
            } else if (!window.__ps5_lastRenderedItems || window.__ps5_lastRenderedItems.length === 0) {
              $('resultsBody').innerHTML = `<tr><td colspan="5" style="color:var(--muted);padding:12px">No games found.</td></tr>`;
              $('scanCount').textContent = '';
            }
            currentSortBy = 'name';
          } catch (e) {
            console.error(e);
            toast('Scan failed: ' + e.message);
          } finally {
            setAppBusy(false);
          }
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
          } catch (e) {
            console.error(e);
            alert('Error cancelling scan: ' + e.message);
          }
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
          if (appBusy) { toast('Please wait for the current operation to finish.'); return; }
          const selected = getSelectedItems();
          if (!selected.length) { toast('No items selected'); return; }
          if (!confirm(`Delete ${selected.length} selected item(s)? This cannot be undone and will remove files from disk.`)) return;
          try {
            setAppBusy(true, `Deleting ${selected.length} item(s)…`);
            showPersistentToast('Deleting selected items...');
            for (const item of selected) {
              if (isFtpScan && ftpConfig) {
                const pathToDelete = item.ppsaFolderPath || item.folderPath;
                const delRes = await window.ppsaApi.ftpDeleteItem(ftpConfig, pathToDelete);
                if (delRes && delRes.error) throw new Error(delRes.error);
              } else {
                await window.ppsaApi.deleteItem(item);
              }
            }
            hidePersistentToast();
            toast(`Deleted ${selected.length} item(s)`);
            const src = $('sourcePath').value.trim();
            if (src) {
              showPersistentToast('Refreshing results...');
              const res = await window.ppsaApi.scanSource(src);
              const arr = Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
              renderResults(arr);
              if (src.startsWith('ftp://') || /^\d+\.\d+\.\d+\.\d+/.test(src)) isFtpScan = true;
              hidePersistentToast();
              toast('Results refreshed');
            }
          } catch (e) {
            hidePersistentToast();
            toast('Delete failed: ' + (e.message || 'Unknown error'));
          } finally {
            setAppBusy(false);
          }
        });
      }

      const btnRenameSelected = $('btnRenameSelected');
      if (btnRenameSelected) {
        btnRenameSelected.addEventListener('click', async () => {
          if (appBusy) { toast('Please wait for the current operation to finish.'); return; }
          const selected = getSelectedItems();
          if (!selected.length) { toast('No items selected'); return; }
          const item = selected[0];
          const currentName = item.displayTitle || '';
          const newName = await openRenameModal(currentName);
          if (!newName || !newName.trim()) return;
          const sanitizedName = Utils.sanitizeName(newName.trim());
          const oldPath = item.ppsaFolderPath;
          const sep = oldPath.includes('\\') ? '\\' : '/';
          const newPath = oldPath.replace(/[/\\][^/\\]*$/, sep + sanitizedName);
          try {
            setAppBusy(true, 'Renaming…');
            showPersistentToast('Renaming selected item...');
            if (isFtpScan && ftpConfig) {
              await window.ppsaApi.ftpRenameItem(ftpConfig, oldPath, newPath);
            } else {
              const renRes = await window.ppsaApi.renameItem(item, newName.trim());
              if (renRes && renRes.error) throw new Error(renRes.error);
            }
            hidePersistentToast();
            toast('Renamed successfully');
            const src = $('sourcePath').value.trim();
            if (src) {
              showPersistentToast('Refreshing results...');
              const res = await window.ppsaApi.scanSource(src);
              const arr = Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
              renderResults(arr);
              if (src.startsWith('ftp://') || /^\d+\.\d+\.\d+\.\d+/.test(src)) isFtpScan = true;
              hidePersistentToast();
              toast('Results refreshed');
            }
          } catch (e) {
            hidePersistentToast();
            toast('Rename failed: ' + (e.message || 'Unknown error'));
          } finally {
            setAppBusy(false);
          }
        });
      }

      const resultClose = $('resultClose');
      if (resultClose) {
        resultClose.addEventListener('click', () => {
          const src = $('sourcePath').value.trim();
          if (src) refreshResultsAfterOperation();
          const rb = $('resultModalBackdrop');
          if (rb) { rb.style.display = 'none'; rb.setAttribute('aria-hidden', 'true'); }
        });
      }

      const thName = document.querySelector('th.game');
      const thSize = document.querySelector('th.size');
      const thFolder = document.querySelector('th.folder');
      if (thName) thName.addEventListener('click', () => sortResults('name'));
      if (thSize) thSize.addEventListener('click', () => sortResults('size'));
      if (thFolder) thFolder.addEventListener('click', () => sortResults('folder'));

      const searchInput = $('searchInput');
      if (searchInput) {
        searchInput.addEventListener('input', (e) => {
          searchFilter = e.target.value;
          applySearchFilter();
        });
      }

      setupDragDrop();

      $('resultsBody').addEventListener('click', (e) => {
        const titleEl = e.target.closest('.title-main');
        if (!titleEl) return;
        const tr = titleEl.closest('tr');
        if (!tr) return;
        const idx = parseInt(tr.dataset.index || '-1', 10);
        const item = window.__ps5_lastRenderedItems && window.__ps5_lastRenderedItems[idx];
        if (item) openGameDetailModal(item);
      });

      const topMenu = $('topMenu');
      if (topMenu) {
        topMenu.addEventListener('change', async (e) => {
          const value = e.target.value;
          if (value === 'export') {
            exportData();
          } else if (value === 'import') {
            importData();
          } else if (value === 'help') {
            if (window.HelpApi && window.HelpApi.openHelp) window.HelpApi.openHelp(e);
          } else if (value === 'checkForUpdates') {
            try {
              toast('Checking for updates…');
              const res = await window.ppsaApi.checkForUpdatesManual();
              if (!res) { toast('Could not reach update server'); return; }
              if (res.upToDate) {
                toast(`You're on the latest version (v${res.version})`);
              } else {
                showUpdateBanner(res);
                toast(`Update available: v${res.latestVersion}`);
              }
            } catch (e) {
              toast('Update check failed: ' + (e.message || String(e)));
            }
          } else if (value === 'selectAll') {
            Array.from(document.querySelectorAll('#resultsBody input[type="checkbox"]')).filter(cb => cb.closest('tr').style.display !== 'none').forEach(cb => {
              cb.checked = true;
              cb.closest('tr')?.classList.add('row-selected');
            });
            updateHeaderCheckboxState();
          } else if (value === 'unselectAll') {
            Array.from(document.querySelectorAll('#resultsBody input[type="checkbox"]')).filter(cb => cb.closest('tr').style.display !== 'none').forEach(cb => {
              cb.checked = false;
              cb.closest('tr')?.classList.remove('row-selected');
            });
            updateHeaderCheckboxState();
          } else if (value === 'clear') {
            if (!confirm('Clear all scan results?')) return;
            const tb = $('resultsBody');
            if (tb) tb.innerHTML = `<tr><td colspan="5" style="color:var(--muted);padding:12px">No scan performed yet.</td></tr>`;
            $('scanCount').textContent = '';
            updateHeaderCheckboxState();
            try { localStorage.removeItem(LAST_RESULTS_KEY); } catch (_) {}
          } else if (value === 'history') {
            openHistoryModal();
          } else if (value === 'clearHistory') {
            if (confirm('Clear all transfer history?')) {
              localStorage.removeItem(TRANSFER_HISTORY_KEY);
              toast('Transfer history cleared');
            }
          } else if (value === 'clearFtpCache') {
            if (!confirm('Clear the FTP size cache?\n\nNext scan will re-calculate all sizes from the PS5.')) {
              e.target.value = '';
              return;
            }
            try {
              if (window.ppsaApi && window.ppsaApi.clearFtpSizeCache) {
                await window.ppsaApi.clearFtpSizeCache();
                toast('FTP size cache cleared — next scan will recalculate all sizes');
              }
            } catch (err) {
              toast('Error clearing cache: ' + err.message);
            }
          }
          e.target.value = '';
        });
      }

      // Save settings on change
      if ($('layout')) $('layout').addEventListener('change', () => localStorage.setItem(LAST_LAYOUT_KEY, $('layout').value));
      if ($('action')) $('action').addEventListener('change', () => localStorage.setItem(LAST_ACTION_KEY, $('action').value));

    } catch (e) {
      console.error('[renderer] DOMContentLoaded error', e);
      alert('DOMContentLoaded error: ' + e.message);
    }
    log('renderer initialized');
  });
})();