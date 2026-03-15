(function () {
  'use strict';

  // Ensure Utils is always in scope inside this IIFE regardless of load order.
  // utils.js assigns to window.Utils; referencing it explicitly here avoids any
  // potential scoping ambiguity (e.g. "Utils.cleanPath is not a function" errors).
  // Full fallback implementation — used when utils.js hasn't loaded at all.
  const _utilsFallback = {
    sanitizeName: (n) => (n ? String(n).replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/  +/g, ' ').trim().slice(0, 200) : '') || 'Unknown',
    escapeHtml: (s) => String(s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])),
    normalizeDisplayPath: (p) => String(p || ''),
    pathEndsWithSceSys: (p) => { if (!p) return false; const lp = p.toLowerCase(); return lp.endsWith('/sce_sys') || lp.endsWith('\\sce_sys'); },
    cleanPath: (p) => {
      if (!p) return '';
      if (p.startsWith('ftp://')) {
        const parts = p.split('://');
        if (parts.length === 2) {
          const proto = parts[0] + '://';
          let rest = parts[1].replace(/\/+/g, '/');
          try { rest = decodeURIComponent(rest); } catch (_) {}
          return _utilsFallback.escapeHtml(proto + rest);
        }
      }
      let cleaned = p.replace(/\/+/g, '/');
      try { cleaned = decodeURIComponent(cleaned); } catch (_) {}
      return _utilsFallback.escapeHtml(cleaned);
    },
  };

  // If window.Utils exists but is an older version missing some methods (e.g. cleanPath
  // was added in a later release), polyfill the missing methods in place so every call
  // site always has a complete Utils object regardless of which app version is installed.
  if (window.Utils) {
    for (const [key, fn] of Object.entries(_utilsFallback)) {
      if (typeof window.Utils[key] !== 'function') {
        window.Utils[key] = fn;
        console.warn('[renderer] Polyfilled missing Utils.' + key + ' — update utils.js to resolve');
      }
    }
  }

  const Utils = window.Utils || _utilsFallback;

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

  /**
   * Strips the password from an FTP URL before storing it in history.
   * e.g. ftp://user:PASS@host:port/path → ftp://user@host:port/path
   * Non-FTP strings are returned unchanged.
   * @param {string} url
   * @returns {string}
   */
  function sanitizeFtpUrl(url) {
    if (!url || !url.startsWith('ftp://')) return url;
    try {
      const u = new URL(url);
      if (u.password) {
        u.password = '';
      }
      // URL.toString() leaves a trailing colon when password is cleared (ftp://user:@host).
      // Remove it so the result is ftp://user@host:port/path.
      return u.toString().replace(/:@/, '@');
    } catch (_) {
      // Malformed URL — strip credentials with a simple regex fallback
      return url.replace(/^(ftp:\/\/[^:@]*):([^@]*)@/, '$1@');
    }
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
  let lastScannedSource = null;
  let lastScannedFtpConfig = null;
  let maxSpeed = 0;
  let lastFile = '';
  let totalTransferred = 0;
  // Monotonically increasing grand-total copied bytes — prevents the progress bar
  // from dipping when doEnsureAndPopulate starts a new item and emits totalBytesCopied:0.
  let lastGrandCopied = 0;

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
      const selected = getSelectedItemsAny();
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
    path = sanitizeFtpUrl(path); // strip password from ftp:// URLs
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
    path = sanitizeFtpUrl(path); // strip password from ftp:// URLs
    const recents = getRecentDests();
    const filtered = recents.filter(p => p !== path);
    filtered.unshift(path);
    const limited = filtered.slice(0, 10);
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
    const limited = filtered.slice(0, 10);
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
    const modal      = document.querySelector('.result-modal-wide');
    const closeX     = $('resultClose');
    const closeRow   = $('resultModalActions');
    if (!modal) return;
    if (busy) {
      modal.classList.add('busy');
      if (closeX)   closeX.style.display   = 'none';
      if (closeRow) closeRow.style.display = 'none';
    } else {
      modal.classList.remove('busy');
      if (closeX)   closeX.style.display   = 'block';
      if (closeRow) closeRow.style.display = 'flex';
    }
  }

  function showScanUI(show) {
    const sd        = $('scanDisplay');
    const primary   = document.querySelector('.controls-left .primary');
    const label     = $('currentScanLabel');
    const cancelBtn = $('btnCancelScan');
    // Scan overlay: show scan bar (absolute, on top of primary row)
    // Hide the primary row's content so the overlay doesn't stack weirdly.
    // The primary row keeps its height via min-height so layout doesn't shift.
    if (sd) sd.style.display = show ? 'flex' : 'none';
    if (primary) primary.style.visibility = show ? 'hidden' : 'visible';
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

  function openConflictModal(conflicts, onChoice, onCancelCb) {
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
      // Call dedicated cancel callback (does NOT start the transfer).
      // Fall back to closing silently if no cancel handler supplied.
      onCancelCb ? onCancelCb() : undefined;
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
        'copy': 'Copy (verified)', 'copy-fast': 'Copy (fast)', 'move': 'Move', 'folder-only': 'Create folder'
      };
      const layoutLabels = {
        'game-ppsa': 'Game / PPSA', 'game-only': 'Game only', 'ppsa-only': 'PPSA only',
        'etahen': 'etaHEN', 'itemzflow': 'itemZFlow', 'dump_runner': 'Dump Runner',
        'custom': 'Custom', 'porkfolio': 'Porkfolio'
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
      document.removeEventListener('keydown', onKeydown);
      backdrop.removeEventListener('click', onBackdropClick);
    };
    const onGo = () => { cleanup(); onProceedCb && onProceedCb(); };
    const onCancel = () => { cleanup(); onCancelCb && onCancelCb(); };
    const onKeydown = (e) => { if (e.key === 'Escape') onCancel(); };
    const onBackdropClick = (e) => { if (e.target === backdrop) onCancel(); };

    btnGo.addEventListener('click', onGo);
    btnCancel.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKeydown, { once: true });
    backdrop.addEventListener('click', onBackdropClick);
    backdrop.style.display = 'flex';
    backdrop.setAttribute('aria-hidden', 'false');
  }

  function openRenameModal(itemOrName) {
    // itemOrName: either a game item object (rename mode) or a string/null (custom layout mode).
    // In rename mode we show 4 format presets based on the item's metadata.
    // In custom-layout mode (called from goClickHandler) we just show a plain text input.
    return new Promise((resolve) => {
      const backdrop    = $('renameModalBackdrop');
      const input       = $('renameNameInput');
      const proceedBtn  = $('renameProceed');
      const cancelBtn   = $('renameCancel');
      const cancelXBtn  = $('renameCancelX');
      const titleEl     = $('renameTitle');
      const currentInfo = $('renameCurrentInfo');
      const currentFld  = $('renameCurrentFolder');
      const presetGrid  = $('renamePresetGrid');

      if (!backdrop || !input || !proceedBtn || !cancelBtn) { resolve(null); return; }

      // ── Determine mode ────────────────────────────────────────────────────
      const isItemMode = itemOrName && typeof itemOrName === 'object';
      const item = isItemMode ? itemOrName : null;

      // ── Compute preset values from item metadata ──────────────────────────
      const rawVer   = item?.contentVersion || item?.version || item?.paramParsed?.contentVersion || '';
      const verSuffix = rawVer ? ` (${rawVer.trim()})` : '';
      const titleStr  = (item?.displayTitle || item?.folderName || '').trim();
      const ppsa      = item?.ppsa || '';
      // The standard etaHEN folder name: "Game Name (01.000.000)"
      const defaultName = titleStr ? titleStr + verSuffix : (ppsa || 'Game');
      const nameOnly    = titleStr || ppsa || 'Game';
      const ppsaName    = ppsa || titleStr || 'PPSA00000';

      // Current folder name (for display only — NOT used as input)
      const folderName = (item?.ppsaFolderPath || item?.folderPath || '').split(/[/\\]/).pop() || '';

      // Preset map: preset id → computed value
      const presetValues = {
        default:  defaultName,
        nameonly: nameOnly,
        ppsa:     ppsaName,
        custom:   '',
      };
      let activePreset = 'default';

      // ── Show current folder name ──────────────────────────────────────────
      if (currentInfo && currentFld) {
        if (isItemMode && folderName) {
          currentFld.textContent = folderName;
          currentInfo.style.display = 'block';
        } else {
          currentInfo.style.display = 'none';
        }
      }

      // ── Modal title ───────────────────────────────────────────────────────
      if (titleEl) titleEl.textContent = isItemMode ? 'Rename Game Folder' : 'Custom Layout Name';

      // ── Preset buttons ────────────────────────────────────────────────────
      if (presetGrid) {
        presetGrid.style.display = isItemMode ? 'grid' : 'none';
        const btns = presetGrid.querySelectorAll('.rename-preset-btn');
        const activatePreset = (id) => {
          activePreset = id;
          btns.forEach(b => {
            const active = b.dataset.preset === id;
            b.style.borderColor = active ? 'var(--accent)' : 'var(--card-border)';
            b.style.background  = active ? 'rgba(59,130,246,.1)' : 'var(--surface-2)';
            const label = b.querySelector('div:first-child');
            if (label) label.style.color = active ? 'var(--accent)' : 'var(--muted)';
          });
          if (id === 'custom') {
            input.disabled = false;
            input.value = '';
            input.focus();
          } else {
            input.disabled = false; // always editable so user can tweak
            input.value = presetValues[id] || '';
          }
        };
        btns.forEach(b => b.addEventListener('click', () => activatePreset(b.dataset.preset)));
        activatePreset('default');
      } else if (!isItemMode) {
        // Custom layout mode: just clear the input
        input.disabled = false;
        input.value = typeof itemOrName === 'string' ? itemOrName : '';
      }

      // ── Input focus and select-all ────────────────────────────────────────
      backdrop.style.display = 'flex';
      backdrop.setAttribute('aria-hidden', 'false');
      requestAnimationFrame(() => { input.focus(); input.select(); });

      // ── Cleanup & handlers ────────────────────────────────────────────────
      const cleanup = () => {
        backdrop.style.display = 'none';
        backdrop.setAttribute('aria-hidden', 'true');
        if (presetGrid) presetGrid.querySelectorAll('.rename-preset-btn').forEach(b => b.replaceWith(b.cloneNode(true)));
        proceedBtn.removeEventListener('click', onProceed);
        cancelBtn.removeEventListener('click', onCancel);
        if (cancelXBtn) cancelXBtn.removeEventListener('click', onCancel);
        input.removeEventListener('keydown', onKeydown);
      };
      const onProceed = () => { const v = input.value.trim(); cleanup(); resolve(v || null); };
      const onCancel  = () => { cleanup(); resolve(null); };
      const onKeydown = (e) => { if (e.key === 'Enter') onProceed(); else if (e.key === 'Escape') onCancel(); };

      proceedBtn.addEventListener('click', onProceed);
      cancelBtn.addEventListener('click', onCancel);
      if (cancelXBtn) cancelXBtn.addEventListener('click', onCancel);
      input.addEventListener('keydown', onKeydown);
      backdrop.addEventListener('click', e => { if (e.target === backdrop) onCancel(); }, { once: true });
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

      if (typeof window.makeShowAllDropdown === 'function') {
        window.makeShowAllDropdown(patternInput, [
          '{name} - Backup',
          '{name} (copy)',
          '{name} - Archive',
          '{name} v2',
        ]);
      }
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
    if (layout === 'porkfolio') {
      const baseOnly = Utils.sanitizeName(it.displayTitle || it.dbTitle || it.folderName || it.ppsa || 'Unknown Game');
      const porkVer  = it.contentVersion || it.version || '';
      const porkName = porkVer ? `${baseOnly} (${porkVer}) ${finalPpsaName}` : `${baseOnly} ${finalPpsaName}`;
      return pathJoin(dest, porkName);
    }
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
    if (!window.__ps5_lastRenderedItems) return;
    const filter     = searchFilter.toLowerCase();
    const szFilter   = ($('sizeFilter') && $('sizeFilter').value) || '';

    function itemVisible(item) {
      if (!item) return false;
      const name = (item.displayTitle || item.folderName || '').toLowerCase();
      if (filter && !name.includes(filter)) return false;
      if (szFilter && item.totalSize > 0) {
        const gb = item.totalSize / (1024 ** 3);
        if      (szFilter === 'xs')  return gb < 1;
        else if (szFilter === 'sm')  return gb >= 1  && gb < 10;
        else if (szFilter === 'md')  return gb >= 10 && gb < 30;
        else if (szFilter === 'lg')  return gb >= 30;
      }
      return true;
    }

    if (viewMode === 'card') {
      const cards = Array.from(document.querySelectorAll('#cardGrid .card-item'));
      cards.forEach((card, idx) => {
        const item = window.__ps5_lastRenderedItems[parseInt(card.dataset.index ?? idx, 10)];
        card.style.display = itemVisible(item) ? '' : 'none';
      });
    } else {
      const tbody = $('resultsBody');
      if (!tbody) return;
      Array.from(tbody.querySelectorAll('tr')).forEach((tr, idx) => {
        const item = window.__ps5_lastRenderedItems[idx];
        tr.style.display = itemVisible(item) ? '' : 'none';
      });
    }
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
    const selected = getSelectedItemsAny();
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
    const src = lastScannedSource || ($('sourcePath') && $('sourcePath').value ? $('sourcePath').value.trim() : '');
    if (!src) return;
    const cfg = lastScannedFtpConfig;
    try {
      showPersistentToast('Refreshing results...');
      const res = await window.ppsaApi.scanSource(src, cfg ? { ftpConfig: cfg } : undefined);
      const arr = Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
      renderResults(arr);
      // Restore FTP scan state so subsequent delete/rename correctly uses ftpDeleteItem/ftpRenameItem
      if (cfg) {
        isFtpScan = true;
        ftpConfig = cfg;
      } else if (src.startsWith('ftp://') || /^\d+\.\d+\.\d+\.\d+/.test(src)) {
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
    if (appBusy) { toast('Please wait for the current operation to finish.'); return; }
    const rawSelected = getSelectedItemsAny();
    if (!rawSelected.length) {
      toast('No items selected');
      return;
    }
    setAppBusy(true);
    try {
      // Shallow-clone each item and apply path corrections (strips trailing /sce_sys).
      // Use getSelectedItemsAny() as the authoritative source so both table and card/grid views work.
      let selected = rawSelected.map(orig => {
        const item = { ...orig };
        const correctPath = computeSourceFolder(item);
        if (correctPath) {
          item.folderPath = correctPath;
          item.contentFolderPath = correctPath;
          item.ppsaFolderPath = correctPath;
        }
        return item;
      });

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
            toast('Custom layout requires exactly one game to be selected.');
            return;
          }
        } else {
          customName = await openRenameModal();
          if (!customName || !customName.trim()) {
            toast('Custom name cannot be empty — using default layout name.');
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
            lastFile = '';
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
          if (typeof updateDestCapacityBadge === 'function') updateDestCapacityBadge();

        };

        if (conflicts.length) {
          openConflictModal(
            conflicts,
            async (choice) => {
              overwriteMode = choice || 'rename';
              try {
                await runOperation();
              } catch (e) {
                err('runOperation (conflict path) error:', e);
                setResultModalBusy(false);
                toast('Operation failed: ' + (e.message || String(e)));
              }
            },
            () => {
              // User cancelled the conflict modal — unlock UI.
              setAppBusy(false);
            }
          );
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


      openConfirmModal(preview, { action, layout }, proceedAfterConfirm, () => {
        // User cancelled the confirm modal — unlock UI immediately.
        // setAppBusy(true) fired at the top of goClickHandler; without this
        // the app stays locked until the user refreshes.
        setAppBusy(false);
      });
    } catch (e) {
      err('ensureAndPopulate error', e);
      toast('Operation failed: ' + (e.message || String(e)));
      setResultModalBusy(false); // only clear busy on error — success path is handled by go-complete
      setAppBusy(false);
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
      lastFile = '';
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
    setAppBusy(true);

    // Force overwrite on resume: cancelled transfers leave a partial target folder.
    // Using 'rename' (default) would copy alongside the partial as "(1)" — wrong.
    // Using 'overwrite' removes the partial and starts fresh for each item.
    const resumeOpts = Object.assign({}, state, { overwriteMode: 'overwrite' });

    window.ppsaApi.resumeTransfer(resumeOpts).then(res => {
      localStorage.removeItem(TRANSFER_STATE_KEY);
      resumeState = null;
      if (res && Array.isArray(res.results)) {
        updateListSummary(res);
        if (typeof updateDestCapacityBadge === 'function') updateDestCapacityBadge();
      }
    }).catch(e => {
      toast('Resume failed: ' + (e.message || String(e)));
      setResultModalBusy(false);
      setAppBusy(false);
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    });
  }

  /**
   * Populates the transfer result list panel with a summary of completed operations.
   * Tallies moved/copied/uploaded/created/skipped/error counts and renders per-game rows.
   * @param {{results: Array<object>}} res - Result object from the ensure-and-populate IPC handler.
   */
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
        badgeClass = 'result-badge--ok'; badgeText = r.fast ? 'Copied (fast)' : 'Copied';
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

  async function updateDestCapacityBadge() {
    try {
      const destEl = $('destPath');
      if (!destEl) return;
      const dest = destEl.value.trim();
      if (!dest || /^(\d+\.\d+\.\d+\.\d+(:\d+)?|ftp:\/\/)/.test(dest)) return;
      const freeBytes = await window.ppsaApi.getLocalFreeSpace(dest);
      if (!freeBytes || freeBytes <= 0) return;
      const items = window.__ps5_lastRenderedItems || [];
      const sized = items.filter(it => (it.totalSize || 0) > 0);
      const avgGameSize = sized.length > 0 ? sized.reduce((s, it) => s + it.totalSize, 0) / sized.length : 0;
      const freeGB = (freeBytes / (1024 ** 3)).toFixed(1);
      const fitsCount = avgGameSize > 0 ? Math.floor(freeBytes / avgGameSize) : '?';
      const fitsLabel = typeof fitsCount === 'number' ? `~${fitsCount} more game${fitsCount !== 1 ? 's' : ''}` : '~? more games';
      toast(`Destination: ${freeGB} GB free — fits ${fitsLabel}`);
    } catch (_) {}
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
    updateButtonStates();
    if (!header) return;
    let total = 0, checked = 0;
    if (viewMode === 'card') {
      const cards = document.querySelectorAll('#cardGrid .card-item');
      total = cards.length;
      checked = Array.from(cards).filter(c => c.querySelector('.card-chk')?.checked).length;
    } else {
      const visible = Array.from(document.querySelectorAll('#resultsBody tr')).filter(tr => tr.offsetParent !== null && tr.style.display !== 'none');
      total = visible.length;
      checked = visible.filter(tr => { const cb = tr.querySelector('input[type="checkbox"]'); return cb && cb.checked; }).length;
    }
    if (total === 0) { header.checked = false; header.indeterminate = false; return; }
    if (checked === 0) { header.checked = false; header.indeterminate = false; }
    else if (checked === total) { header.checked = true; header.indeterminate = false; }
    else { header.checked = false; header.indeterminate = true; }
  }

  function toggleHeaderSelect() {
    if (viewMode === 'card') {
      const cards = Array.from(document.querySelectorAll('#cardGrid .card-item'));
      if (!cards.length) return;
      const allChecked = cards.every(c => c.querySelector('.card-chk')?.checked);
      cards.forEach(c => {
        const chk = c.querySelector('.card-chk');
        if (chk) { chk.checked = !allChecked; updateCardSelected(c, chk.checked); }
      });
      updateHeaderCheckboxState();
      return;
    }
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
    if (!t) { console.warn('[toast]', msg); return; }
    t.textContent = msg;
    t.style.display = 'block';
    setTimeout(() => { t.style.display = 'none'; }, 3000);
  }

  // Expose toast globally so ftp.js and other modules can call it
  window.toast = toast;

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

  /**
   * Handles all progress and completion messages from the main process IPC channel.
   * Routes scan progress, game-found events, file progress, and transfer completion
   * to the appropriate UI update handlers.
   * @param {object} d - Progress message object with a `type` discriminator field.
   */
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
    if (d.type === 'ftp-manifest-progress') {
      const lbl = $('resultItemLabel');
      const cf  = $('currentFileInfo');
      if (lbl) lbl.textContent = 'Counting files on PS5…';
      if (cf)  cf.textContent  = d.filesFound ? `${d.filesFound} files found` : '';
      return;
    }

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
        lastFile = '';
        lastGrandCopied = 0;
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
      // Clamp grandCopied to at least lastGrandCopied so it never dips when a
      // new item starts with totalBytesCopied:0 (which sets grandTotalCopied back
      // to totalTransferred alone, briefly losing the in-flight bytes).
      const isMulti       = d.totalItems > 1;
      const grandTotal    = d.grandTotalBytes  || 0;
      const grandCopied   = Math.max(lastGrandCopied, d.grandTotalCopied || d.totalBytesCopied || 0);
      lastGrandCopied     = grandCopied;
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
        if (hasGrand || hasItem) {
          bar.style.width = `${barPct.toFixed(2)}%`;
        } else if (grandCopied > 0 || (d.totalBytesCopied || 0) > 0) {
          // Size unknown but transfer is active — show minimum width so user sees activity
          bar.style.width = '2%';
        } else {
          bar.style.width = '0%';
        }
      }

      // ── Stat chips ───────────────────────────────────────────────────────
      const statSpeed = $('statSpeed');
      const statEta   = $('statEta');
      const statXfer  = $('statTransferred');

      // Speed: only show once we have at least 2 valid window samples
      if (statSpeed) statSpeed.textContent = stats.speedBps > 1024 ? bytesToHuman(stats.speedBps) + '/s' : '—';
      // Update sparkline
      if (typeof Sparkline !== 'undefined') Sparkline.push(stats.speedBps);

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
      lastGrandCopied = 0;
      setResultModalBusy(false);
      showScanUI(false);
      showNotification('Transfer complete', 'PS5 Vault operation finished.');
      localStorage.removeItem(TRANSFER_STATE_KEY);
      // Persist source and destination to recent history on every successful transfer
      // so paths used programmatically (resume, FTP scan) are always saved.
      try {
        const srcEl = $('sourcePath');
        const dstEl = $('destPath');
        if (srcEl && srcEl.value.trim()) addRecentSource(srcEl.value.trim());
        if (dstEl && dstEl.value.trim()) addRecentDest(dstEl.value.trim());
      } catch (_) {}
      // Log per-game transfer history
      try {
        if (window.GameHistory && window.GameHistory.record) {
          const dst = $('destPath') ? $('destPath').value.trim() : '';
          const actionVal = $('action') ? $('action').value : '';
          const items = window.__ps5_lastRenderedItems || [];
          items.filter(it => {
            const cb = document.querySelector(`#resultsBody tr input[type="checkbox"]`);
            return true; // record all — last-transferred games are what the user just moved
          });
          // Record for any item that was in the last transfer (resultsCount from event)
          // Use transferState which was saved before the operation
          if (typeof transferState === 'object' && Array.isArray(transferState.items)) {
            for (const item of transferState.items) {
              window.GameHistory.record(item, dst, actionVal);
            }
          }
        }
      } catch (_) {}

      // Log to transfer history
      try {
        const src = $('sourcePath') ? $('sourcePath').value.trim() : '';
        const dst = $('destPath') ? $('destPath').value.trim() : '';
        const actionEl = $('action');
        const actionVal = actionEl ? actionEl.value : '';
        // Use resultsCount from the go-complete event for accurate item count.
        // Counting checked DOM checkboxes is unreliable — after a resume the DOM
        // may have been refreshed and no rows are checked.
        const itemCount = d.resultsCount != null ? d.resultsCount : 0;
        const histDurationMs = transferStartTime ? Date.now() - transferStartTime : 0;
        addTransferHistoryEntry({
          date: new Date().toISOString(),
          source: sanitizeFtpUrl(src),
          dest: sanitizeFtpUrl(dst),
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
      setAppBusy(false);

      // ── Post-move parent-folder cleanup ─────────────────────────────────
      // Only for local moves (not FTP). Collect unique parent dirs of all
      // transferred items and offer to delete any that are now empty.
      try {
        const isLocalMove = transferState?.action === 'move' && !transferState?.ftpConfig && !transferState?.ftpDestConfig;
        if (isLocalMove && Array.isArray(transferState?.items) && transferState.items.length > 0) {
          // Compute unique parent dirs — game is at item.ppsaFolderPath, parent is dirname
          const seenParents = new Set();
          const parentDirs  = [];
          for (const item of transferState.items) {
            const gamePath = item.ppsaFolderPath || item.folderPath || '';
            if (!gamePath) continue;
            // Normalise separators so path.dirname works on both / and \ paths
            const norm   = gamePath.replace(/\//g, '\\');
            const parent = norm.includes('\\') ? norm.replace(/\\[^\\]+$/, '') : '';
            if (!parent || seenParents.has(parent.toLowerCase())) continue;
            // Don't suggest deleting drive roots or top-level dirs
            const segments = parent.split('\\').filter(Boolean);
            if (segments.length < 2) continue;
            seenParents.add(parent.toLowerCase());
            parentDirs.push(parent);
          }

          if (parentDirs.length > 0) {
            // Render the cleanup section below the result list
            const listWrap = $('resultListWrap');
            if (listWrap) {
              const cleanupSection = document.createElement('div');
              cleanupSection.id = 'parentFolderCleanup';
              cleanupSection.style.cssText = 'margin-top:14px;border-top:1px solid rgba(255,255,255,0.07);padding-top:12px;';

              const heading = document.createElement('div');
              heading.style.cssText = 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:10px;';
              heading.textContent = 'Source folder cleanup';
              cleanupSection.appendChild(heading);

              for (const parentPath of parentDirs) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:flex-start;gap:12px;padding:9px 12px;background:rgba(255,255,255,0.02);border:1px solid var(--card-border);border-radius:7px;margin-bottom:7px;';

                const info = document.createElement('div');
                info.style.cssText = 'flex:1;min-width:0;';

                const label = document.createElement('div');
                label.style.cssText = 'font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:3px;';
                label.textContent = 'Parent folder';
                info.appendChild(label);

                const pathEl = document.createElement('div');
                pathEl.style.cssText = 'font-size:12px;color:var(--title);font-family:ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                pathEl.textContent = parentPath;
                pathEl.title = parentPath;
                info.appendChild(pathEl);

                const gameLabel = document.createElement('div');
                gameLabel.style.cssText = 'font-size:11px;color:var(--muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                // Show which game was inside it
                const gameInParent = (transferState.items || []).find(it => {
                  const gp = (it.ppsaFolderPath || it.folderPath || '').replace(/\//g,'\\');
                  return gp.replace(/\\[^\\]+$/, '').toLowerCase() === parentPath.toLowerCase();
                });
                if (gameInParent) {
                  const gameName = gameInParent.displayTitle || gameInParent.folderName || '';
                  const gamePath = (gameInParent.ppsaFolderPath || gameInParent.folderPath || '').replace(/\//g,'\\');
                  gameLabel.textContent = 'contained: ' + (gamePath || gameName);
                  gameLabel.title = gamePath || gameName;
                }
                info.appendChild(gameLabel);
                row.appendChild(info);

                const btn = document.createElement('button');
                btn.className = 'btn';
                btn.style.cssText = 'flex-shrink:0;white-space:nowrap;font-size:12px;padding:5px 12px;color:#f87171;border-color:rgba(248,113,113,0.25);background:rgba(248,113,113,0.05);align-self:center;';
                btn.textContent = 'Delete folder';
                btn.title = 'Delete if empty: ' + parentPath;

                btn.addEventListener('click', async () => {
                  btn.disabled = true;
                  btn.textContent = 'Checking…';
                  try {
                    const result = await window.ppsaApi.deleteParentFolder(parentPath);

                    if (result?.error) {
                      btn.textContent = 'Error';
                      toast('Delete failed: ' + result.error);
                      return;
                    }

                    if (result?.status === 'deleted' && result.deleted?.length > 0) {
                      // Show all deleted paths stacked in the row
                      btn.style.display = 'none';
                      const doneWrap = document.createElement('div');
                      doneWrap.style.cssText = 'display:flex;flex-direction:column;gap:3px;align-self:center;';
                      for (const dp of result.deleted) {
                        const tag = document.createElement('div');
                        tag.style.cssText = 'font-size:11px;color:#4ade80;font-weight:600;white-space:nowrap;';
                        tag.textContent = '✓ ' + dp;
                        doneWrap.appendChild(tag);
                      }
                      row.appendChild(doneWrap);
                      row.style.opacity = '0.45';
                      // Update path display to show what stopped us (if anything)
                      if (result.blocker) {
                        const stopNote = document.createElement('div');
                        stopNote.style.cssText = 'font-size:10.5px;color:var(--muted);margin-top:4px;';
                        if (result.blocker.reason === 'contains_game') {
                          stopNote.textContent = 'Stopped — another game detected in: ' + result.blocker.path;
                        } else {
                          const s = result.blocker.sample?.join(', ') || '';
                          stopNote.textContent = `Stopped — ${result.blocker.count} item${result.blocker.count !== 1 ? 's' : ''} in: ${result.blocker.path}${s ? ' (' + s + (result.blocker.count > 3 ? '…' : '') + ')' : ''}`;
                        }
                        info.appendChild(stopNote);
                      }

                    } else if (result?.status === 'not_empty') {
                      // Nothing deleted — show why
                      const b = result.blocker;
                      if (b?.reason === 'contains_game') {
                        btn.textContent = 'Contains another game';
                        btn.title = 'Another PS5 game detected in: ' + b.path;
                      } else {
                        const count = b?.count || '?';
                        const sample = b?.sample?.join(', ') || '';
                        btn.textContent = `Not empty (${count} item${count !== 1 ? 's' : ''})`;
                        btn.title = sample ? `Blocked by: ${sample}` : 'Folder not empty';
                      }
                      btn.style.color = '#fbbf24';
                      btn.style.borderColor = 'rgba(251,191,36,0.25)';
                      btn.style.background  = 'rgba(251,191,36,0.05)';

                    } else if (result?.status === 'not_found') {
                      btn.textContent = 'Already gone';
                      btn.style.color = 'var(--muted)';
                      row.style.opacity = '0.45';

                    } else {
                      btn.textContent = 'Error';
                      toast('Delete failed: ' + (result?.error || 'Unknown error'));
                    }
                  } catch (e) {
                    btn.textContent = 'Error';
                    toast('Delete failed: ' + (e.message || String(e)));
                  }
                });

                row.appendChild(btn);
                cleanupSection.appendChild(row);
              }
              listWrap.appendChild(cleanupSection);
            }
          }
        }
      } catch (_) {}
      // ── End post-move cleanup ────────────────────────────────────────────

      return;
    }

    if (d.type === 'go-item') {
      const label = $('currentScanLabel');
      const raw = d.folder || d.path || '';
      if (label) label.textContent = Utils.pathEndsWithSceSys(raw) ? '' : (Utils.normalizeDisplayPath(raw) || '');
      return;
    }

    if (d.type === 'go-error') {
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
      setResultModalBusy(false);
      setAppBusy(false);
      const progressPanel = $('resultProgressPanel');
      const summaryPanel  = $('resultSummaryPanel');
      const titleEl       = $('resultTitleText');
      if (progressPanel) progressPanel.style.display = 'none';
      if (summaryPanel)  summaryPanel.style.display  = 'flex';
      if (titleEl)       titleEl.textContent         = 'Transfer failed';
      toast(d.message || 'Transfer error');
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

  // ── Developer API settings modal ──────────────────────────────────────────────
  async function openApiSettingsModal() {
    const backdrop  = $('apiSettingsBackdrop');
    if (!backdrop) return;

    // Fetch live status from main process
    let status = { port: 3731, keyPreview: '…' };
    try {
      if (window.ppsaApi && window.ppsaApi.getApiStatus) {
        status = await window.ppsaApi.getApiStatus();
      }
    } catch (_) {}

    const portEl     = $('apiSettingsPort');
    const keyPreview = $('apiSettingsKeyPreview');
    const copyBtn    = $('apiSettingsCopy');
    const regenBtn   = $('apiSettingsRegen');
    const closeBtn   = $('apiSettingsClose');

    if (portEl)     portEl.textContent     = String(status.port || 3731);
    if (keyPreview) keyPreview.textContent = status.keyPreview || '—';

    const close = () => {
      backdrop.style.display = 'none';
      backdrop.setAttribute('aria-hidden', 'true');
    };

    if (copyBtn) {
      copyBtn.onclick = async () => {
        try {
          const res = await window.ppsaApi.getApiKey();
          if (res && res.key) {
            await window.ppsaApi.copyToClipboard(res.key);
            toast('API key copied to clipboard');
          }
        } catch (e) { toast('Copy failed: ' + e.message); }
      };
    }

    if (regenBtn) {
      regenBtn.onclick = async () => {
        if (!confirm('Regenerate the API key?\n\nAll apps using the current key will stop working until updated.')) return;
        try {
          const res = await window.ppsaApi.regenerateApiKey();
          if (keyPreview) keyPreview.textContent = res.keyPreview || '—';
          toast('New API key generated — copy it now');
        } catch (e) { toast('Regen failed: ' + e.message); }
      };
    }

    if (closeBtn) closeBtn.onclick = close;
    const doneBtn = $('apiSettingsDone');
    if (doneBtn)  doneBtn.onclick  = close;
    backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
    backdrop.style.display = 'flex';
    backdrop.setAttribute('aria-hidden', 'false');
  }

  // ── Export transfer history as CSV ────────────────────────────────────────────
  function exportHistoryCsv() {
    const history = getTransferHistory();
    if (!history.length) { toast('No transfer history to export'); return; }
    const header = ['Date', 'Action', 'Source', 'Destination', 'Games', 'SizeBytes', 'DurationMs'];
    const rows   = history.map(h => [
      h.date || '',
      h.action || '',
      (h.source || '').replace(/"/g, '""'),
      (h.dest   || '').replace(/"/g, '""'),
      h.items   || 0,
      h.totalBytes || 0,
      h.durationMs || 0,
    ].map(v => `"${v}"`).join(','));
    const csv  = [header.join(','), ...rows].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'ps5vault-history.csv';
    a.click();
    URL.revokeObjectURL(url);
    toast('Transfer history exported as CSV');
  }

  // ── FTP Connection Profiles ───────────────────────────────────────────────
  const FTP_PROFILES_KEY = 'ps5vault.ftpProfiles';
  function getFtpProfiles() {
    try { return JSON.parse(localStorage.getItem(FTP_PROFILES_KEY) || '[]'); } catch (_) { return []; }
  }
  function saveFtpProfiles(profiles) {
    try { localStorage.setItem(FTP_PROFILES_KEY, JSON.stringify(profiles)); } catch (_) {}
  }
  window.FtpProfiles = { get: getFtpProfiles, save: saveFtpProfiles };

  // ── Per-game transfer history ─────────────────────────────────────────────
  // Key: ppsa or folderName → array of { date, dest, action, bytes }
  const GAME_HISTORY_KEY = 'ps5vault.gameHistory';
  function getGameHistory() {
    try { return JSON.parse(localStorage.getItem(GAME_HISTORY_KEY) || '{}'); } catch (_) { return {}; }
  }
  function recordGameTransfer(item, dest, action) {
    try {
      const key = item.ppsa || item.contentId || item.folderName || '';
      if (!key) return;
      const db = getGameHistory();
      if (!db[key]) db[key] = [];
      db[key].unshift({ date: new Date().toISOString(), dest, action });
      db[key] = db[key].slice(0, 10); // keep 10 per game
      localStorage.setItem(GAME_HISTORY_KEY, JSON.stringify(db));
    } catch (_) {}
  }
  function getGameTransferHistory(item) {
    const key = item.ppsa || item.contentId || item.folderName || '';
    if (!key) return [];
    const db = getGameHistory();
    return db[key] || [];
  }
  window.GameHistory = { record: recordGameTransfer, get: getGameTransferHistory };

  // ── Persistent column widths ──────────────────────────────────────────────
  const COL_WIDTHS_KEY = 'ps5vault.columnWidths';
  function saveColumnWidths() {
    try {
      const heads = document.querySelectorAll('thead th');
      const widths = {};
      heads.forEach(th => { if (th.className) widths[th.className] = th.offsetWidth; });
      localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(widths));
    } catch (_) {}
  }
  function restoreColumnWidths() {
    try {
      const widths = JSON.parse(localStorage.getItem(COL_WIDTHS_KEY) || '{}');
      const heads = document.querySelectorAll('thead th');
      heads.forEach(th => {
        if (th.className && widths[th.className]) {
          th.style.width = widths[th.className] + 'px';
        }
      });
    } catch (_) {}
  }
  function initColumnResize() {
    const heads = document.querySelectorAll('thead th');
    heads.forEach(th => {
      const handle = document.createElement('div');
      handle.style.cssText = 'position:absolute;right:0;top:0;width:6px;height:100%;cursor:col-resize;user-select:none;';
      th.style.position = 'relative';
      th.appendChild(handle);
      let startX, startW;
      handle.addEventListener('mousedown', e => {
        startX = e.clientX; startW = th.offsetWidth; e.preventDefault();
        const onMove = ev => { th.style.width = Math.max(50, startW + ev.clientX - startX) + 'px'; };
        const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); saveColumnWidths(); };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
    restoreColumnWidths();
  }

  // ── Speed Sparkline ───────────────────────────────────────────────────────
  const Sparkline = {
    data: [],        // [speedBps, ...]
    maxPoints: 60,
    reset() { this.data = []; this.render(); },
    push(speedBps) {
      this.data.push(Math.max(0, speedBps));
      if (this.data.length > this.maxPoints) this.data.shift();
      this.render();
    },
    render() {
      const svg = $('speedSparkline');
      if (!svg) return;
      const w = svg.clientWidth || 400, h = svg.clientHeight || 32;
      if (!this.data.length) { svg.innerHTML = ''; return; }
      const max = Math.max(...this.data, 1);
      const pts = this.data.map((v, i) => {
        const x = (i / (this.maxPoints - 1)) * w;
        const y = h - (v / max) * (h - 2) - 1;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      svg.innerHTML = `<polyline points="${pts}" fill="none" stroke="rgba(59,130,246,0.6)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
  };

  // ── Card / Grid view ──────────────────────────────────────────────────────
  let viewMode = 'table'; // 'table' | 'card'

  function buildCardItem(r, index) {
    const card = document.createElement('div');
    card.className = 'card-item';
    card.dataset.index = String(index);

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'card-chk chk';
    chk.addEventListener('click', e => { e.stopPropagation(); updateCardSelected(card, chk.checked); updateHeaderCheckboxState(); });
    card.appendChild(chk);

    if (r.iconPath) {
      const img = document.createElement('img');
      img.className = 'card-cover';
      img.src = r.iconPath;
      img.alt = r.displayTitle || '';
      img.loading = 'lazy';
      img.addEventListener('error', () => img.style.display = 'none');
      card.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'card-placeholder';
      card.appendChild(ph);
    }

    const info = document.createElement('div');
    info.className = 'card-info';
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = r.displayTitle || r.folderName || '';
    info.appendChild(title);
    const size = document.createElement('div');
    size.className = 'card-size';
    size.textContent = r.totalSize > 0 ? bytesToHuman(r.totalSize) : '⟳';
    info.appendChild(size);
    card.appendChild(info);

    card.addEventListener('click', () => {
      chk.checked = !chk.checked;
      updateCardSelected(card, chk.checked);
      updateHeaderCheckboxState();
    });
    return card;
  }

  function updateCardSelected(card, sel) {
    if (sel) card.classList.add('card-selected'); else card.classList.remove('card-selected');
  }

  function renderCardView(list) {
    const gridDiv = $('cardGrid');
    if (!gridDiv) return;
    gridDiv.innerHTML = '';
    list.forEach((r, i) => gridDiv.appendChild(buildCardItem(r, i)));
  }

  function toggleViewMode() {
    viewMode = viewMode === 'table' ? 'card' : 'table';
    const btn = $('btnToggleView');
    const tableWrap = $('tableWrap');
    const gridDiv = $('cardGrid');
    if (btn) btn.textContent = viewMode === 'card' ? '☰ Table' : '⊞ Grid';
    if (!window.__ps5_lastRenderedItems) return;
    if (viewMode === 'card') {
      if (tableWrap) tableWrap.style.display = 'none';
      if (gridDiv) gridDiv.style.display = 'grid';
      renderCardView(window.__ps5_lastRenderedItems);
    } else {
      if (gridDiv) { gridDiv.style.display = 'none'; gridDiv.innerHTML = ''; }
      if (tableWrap) tableWrap.style.display = '';
      renderResults(window.__ps5_lastRenderedItems);
    }
  }

  // Override getSelectedItems to work in both view modes
  const _origGetSelectedItems = getSelectedItems;
  function getSelectedItemsAny() {
    if (viewMode === 'card') {
      const cards = document.querySelectorAll('#cardGrid .card-item');
      return Array.from(cards).filter(c => c.querySelector('.card-chk')?.checked)
        .map(c => window.__ps5_lastRenderedItems[parseInt(c.dataset.index || '-1', 10)])
        .filter(Boolean);
    }
    return _origGetSelectedItems();
  }

  // ── Library Stats ─────────────────────────────────────────────────────────
  function openStatsModal() {
    const items = window.__ps5_lastRenderedItems || [];
    const backdrop = $('statsModalBackdrop');
    const body = $('statsBody');
    if (!backdrop || !body) return;

    const total = items.length;
    const totalSize = items.reduce((s, i) => s + (i.totalSize || 0), 0);
    const sized = items.filter(i => i.totalSize > 0);
    const avgSize = sized.length ? totalSize / sized.length : 0;
    const largest = items.reduce((m, i) => (i.totalSize || 0) > (m.totalSize || 0) ? i : m, items[0] || {});
    const smallest = sized.reduce((m, i) => (i.totalSize || 0) < (m.totalSize || 0) ? i : m, sized[0] || {});

    // Region breakdown
    const regionCounts = {};
    for (const i of items) {
      const r = i.region || 'Unknown';
      regionCounts[r] = (regionCounts[r] || 0) + 1;
    }
    const topRegions = Object.entries(regionCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

    // Version breakdown
    const versionCounts = {};
    for (const i of items) {
      const v = i.contentVersion || '(none)';
      versionCounts[v] = (versionCounts[v] || 0) + 1;
    }

    // Transfer history stats
    const history = getTransferHistory();
    const histTotal = history.reduce((s, h) => s + (h.totalBytes || 0), 0);

    body.innerHTML = `
      <div class="stats-grid" style="margin-bottom:14px;">
        <div class="stats-chip"><div class="stats-chip-label">Total Games</div><div class="stats-chip-value">${total}</div></div>
        <div class="stats-chip"><div class="stats-chip-label">Total Size</div><div class="stats-chip-value">${totalSize > 0 ? bytesToHuman(totalSize) : '—'}</div></div>
        <div class="stats-chip"><div class="stats-chip-label">Avg Game Size</div><div class="stats-chip-value">${avgSize > 0 ? bytesToHuman(avgSize) : '—'}</div></div>
        <div class="stats-chip"><div class="stats-chip-label">Largest Game</div><div class="stats-chip-value" title="${Utils.escapeHtml(largest.displayTitle || '')}" style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${largest.displayTitle ? Utils.escapeHtml(largest.displayTitle) : '—'}</div></div>
        <div class="stats-chip"><div class="stats-chip-label">Smallest Game</div><div class="stats-chip-value" title="${Utils.escapeHtml(smallest?.displayTitle || '')}" style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${smallest?.displayTitle ? Utils.escapeHtml(smallest.displayTitle) : '—'}</div></div>
        <div class="stats-chip"><div class="stats-chip-label">Total Transferred</div><div class="stats-chip-value">${histTotal > 0 ? bytesToHuman(histTotal) : '—'}</div></div>
      </div>
      <div style="margin-bottom:10px;">
        <div style="color:var(--muted);font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">By Region</div>
        ${topRegions.map(([r, n]) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:12.5px;"><span style="color:var(--title);">${Utils.escapeHtml(r)}</span><span style="color:var(--muted);font-weight:600;">${n}</span></div>`).join('')}
      </div>
      <div>
        <div style="color:var(--muted);font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">Transfer History</div>
        <div style="font-size:12.5px;color:var(--muted);">${history.length} operation${history.length !== 1 ? 's' : ''} recorded &nbsp;·&nbsp; ${histTotal > 0 ? bytesToHuman(histTotal) + ' total' : 'no data'}</div>
      </div>
    `;

    const close = () => { backdrop.style.display = 'none'; backdrop.setAttribute('aria-hidden', 'true'); };
    const statsClose = $('statsClose'); if (statsClose) statsClose.onclick = close;
    const statsCloseX = $('statsCloseX'); if (statsCloseX) statsCloseX.onclick = close;
    backdrop.onclick = e => { if (e.target === backdrop) close(); };
    backdrop.style.display = 'flex';
    backdrop.setAttribute('aria-hidden', 'false');
  }

  // ── Verify Library ────────────────────────────────────────────────────────
  async function openVerifyModal() {
    const items = getSelectedItemsAny();
    const allItems = items.length > 0 ? items : (window.__ps5_lastRenderedItems || []);
    if (!allItems.length) { toast('No games to verify'); return; }

    const backdrop = $('verifyModalBackdrop');
    const body = $('verifyBody');
    const statusText = $('verifyStatusText');
    const badges = $('verifyBadges');
    if (!backdrop || !body) return;

    backdrop.style.display = 'flex';
    backdrop.setAttribute('aria-hidden', 'false');
    body.innerHTML = '<div style="color:var(--muted);padding:12px;">Verifying…</div>';
    if (statusText) statusText.textContent = `Checking ${allItems.length} games…`;
    if (badges) badges.innerHTML = '';

    const ftpCfg = isFtpScan ? ftpConfig : null;
    let results;
    try {
      results = await window.ppsaApi.verifyLibrary(allItems, ftpCfg);
    } catch (e) {
      body.innerHTML = `<div style="color:#f87171;padding:12px;">Verify failed: ${Utils.escapeHtml(e.message)}</div>`;
      return;
    }

    const ok = results.filter(r => r.status === 'ok').length;
    const warn = results.filter(r => r.status === 'warn').length;
    const errored = results.filter(r => r.status === 'error').length;

    if (statusText) statusText.textContent = `${results.length} games checked`;
    if (badges) {
      badges.innerHTML = '';
      if (ok)      badges.innerHTML += `<span class="verify-badge verify-badge-ok">✓ ${ok} OK</span>`;
      if (warn)    badges.innerHTML += `<span class="verify-badge verify-badge-warn">⚠ ${warn} Warning</span>`;
      if (errored) badges.innerHTML += `<span class="verify-badge verify-badge-error">✗ ${errored} Error</span>`;
    }

    body.innerHTML = '';
    // Sort: errors first, then warnings, then ok
    const sorted = [...results].sort((a, b) => {
      const ord = { error: 0, warn: 1, ok: 2 };
      return (ord[a.status] ?? 3) - (ord[b.status] ?? 3);
    });
    for (const r of sorted) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:flex-start;gap:10px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:12.5px;';
      const icon = r.status === 'ok' ? '✓' : r.status === 'warn' ? '⚠' : '✗';
      const cls  = r.status === 'ok' ? 'verify-ok' : r.status === 'warn' ? 'verify-warn' : 'verify-error';
      row.innerHTML = `<span class="${cls}" style="flex:0 0 16px;font-weight:700;">${icon}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;color:var(--title);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${Utils.escapeHtml(r.title || r.ppsa || '')}</div>
          ${r.detail ? `<div style="font-size:11px;color:var(--muted);margin-top:2px;">${Utils.escapeHtml(r.detail)}</div>` : ''}
        </div>`;
      body.appendChild(row);
    }

    const close = () => { backdrop.style.display = 'none'; backdrop.setAttribute('aria-hidden', 'true'); };
    $('verifyClose').onclick = close;
    $('verifyCloseX').onclick = close;
    backdrop.onclick = e => { if (e.target === backdrop) close(); };
  }

  // ── Diff / Compare ────────────────────────────────────────────────────────
  let diffMissingItems = []; // games in A not in B

  async function openDiffModal() {
    const backdrop = $('diffModalBackdrop');
    if (!backdrop) return;
    const labelA = $('diffLabelA');
    const srcA = $('sourcePath')?.value?.trim() || '';
    if (labelA) labelA.textContent = srcA || 'No source scanned';
    const statusEl = $('diffStatusText');
    const body = $('diffBody');
    const transferBtn = $('diffTransferMissing');
    diffMissingItems = [];
    if (transferBtn) transferBtn.style.display = 'none';
    if (body) body.innerHTML = '';
    if (statusEl) statusEl.textContent = 'Enter a second location and click Compare.';

    const close = () => { backdrop.style.display = 'none'; backdrop.setAttribute('aria-hidden', 'true'); };
    $('diffClose').onclick = close;
    $('diffCloseX').onclick = close;
    backdrop.onclick = e => { if (e.target === backdrop) close(); };

    if (transferBtn) {
      transferBtn.onclick = async () => {
        if (!diffMissingItems.length) return;
        const destB = $('diffSourceB')?.value?.trim();
        if (!destB) { toast('Enter destination B first'); return; }
        close();
        // Pre-select the missing items — set them as selected in main table
        const tbody = $('resultsBody');
        if (!tbody || !window.__ps5_lastRenderedItems) return;
        // Uncheck all first
        document.querySelectorAll('#resultsBody input[type="checkbox"]').forEach(cb => { cb.checked = false; cb.closest('tr')?.classList.remove('row-selected'); });
        // Check matching
        diffMissingItems.forEach(item => {
          const idx = window.__ps5_lastRenderedItems.indexOf(item);
          if (idx >= 0) {
            const tr = tbody.querySelector(`tr[data-index="${idx}"]`);
            if (tr) { const cb = tr.querySelector('input[type="checkbox"]'); if (cb) { cb.checked = true; tr.classList.add('row-selected'); } }
          }
        });
        $('destPath').value = destB;
        updateHeaderCheckboxState();
        toast(`${diffMissingItems.length} games selected — click GO to transfer`);
      };
    }

    const scanBtn = $('diffScanBtn');
    if (scanBtn) {
      scanBtn.onclick = async () => {
        const srcAItems = window.__ps5_lastRenderedItems || [];
        const srcB = $('diffSourceB')?.value?.trim();
        if (!srcA || !srcAItems.length) { toast('Scan source A first'); return; }
        if (!srcB) { toast('Enter source B path'); return; }
        if (statusEl) statusEl.textContent = 'Scanning B…';
        scanBtn.disabled = true;
        try {
          let itemsB = [];
          if (/^(\d+\.\d+\.\d+\.\d+|ftp:\/\/)/.test(srcB)) {
            const cfgB = await window.FtpApi.openFtpModal(srcB.startsWith('ftp://') ? srcB : 'ftp://' + srcB);
            if (!cfgB) { scanBtn.disabled = false; return; }
            itemsB = await window.ppsaApi.scanSource('ftp://' + cfgB.host + ':' + cfgB.port + cfgB.path);
            itemsB = Array.isArray(itemsB) ? itemsB : (itemsB?.items || []);
          } else {
            itemsB = await window.ppsaApi.scanSource(srcB);
            itemsB = Array.isArray(itemsB) ? itemsB : (itemsB?.items || []);
          }

          const setPpsaB = new Set(itemsB.map(i => i.ppsa || i.contentId || i.folderName).filter(Boolean));
          const setFolderB = new Set(itemsB.map(i => (i.folderName || '').toLowerCase()).filter(Boolean));

          const onlyInA = srcAItems.filter(i => {
            const key = i.ppsa || i.contentId;
            if (key && setPpsaB.has(key)) return false;
            const fn = (i.folderName || '').toLowerCase();
            if (fn && setFolderB.has(fn)) return false;
            return true;
          });
          const _setAKeys = new Set(srcAItems.map(x => x.ppsa || x.contentId).filter(Boolean));
          const onlyInB = itemsB.filter(i => {
            const key = i.ppsa || i.contentId;
            if (key && _setAKeys.has(key)) return false;
            return true;
          });
          const inBoth = srcAItems.filter(i => !onlyInA.includes(i));

          diffMissingItems = onlyInA;
          if (transferBtn) transferBtn.style.display = onlyInA.length ? 'inline-flex' : 'none';

          if (statusEl) statusEl.textContent = `A: ${srcAItems.length} games · B: ${itemsB.length} games`;

          if (body) {
            body.innerHTML = '';
            const renderSection = (title, items, cls, icon) => {
              if (!items.length) return;
              const sec = document.createElement('div');
              sec.className = `diff-section ${cls}`;
              const titleEl = document.createElement('div');
              titleEl.className = 'diff-section-title';
              titleEl.textContent = `${title} (${items.length})`;
              sec.appendChild(titleEl);
              for (const item of items.slice(0, 100)) {
                const row = document.createElement('div');
                row.className = 'diff-item';
                row.innerHTML = `<span class="diff-icon">${icon}</span><span style="color:var(--title);font-size:12.5px;">${Utils.escapeHtml(item.displayTitle || item.folderName || '')}</span>`;
                sec.appendChild(row);
              }
              if (items.length > 100) {
                const more = document.createElement('div');
                more.style.cssText = 'font-size:11px;color:var(--muted);padding:4px 0;';
                more.textContent = `… and ${items.length - 100} more`;
                sec.appendChild(more);
              }
              body.appendChild(sec);
            };
            renderSection('Only in A — not on B yet', onlyInA, 'diff-only-a', '📦');
            renderSection('Only in B — not in A', onlyInB, 'diff-only-b', '🎮');
            renderSection('In both locations', inBoth, 'diff-both', '✓');
          }
        } catch (e) {
          if (statusEl) statusEl.textContent = 'Error: ' + e.message;
          toast('Diff failed: ' + e.message);
        } finally {
          scanBtn.disabled = false;
        }
      };
    }

    backdrop.style.display = 'flex';
    backdrop.setAttribute('aria-hidden', 'false');

    const diffSourceBEl = $('diffSourceB');
    if (diffSourceBEl && typeof window.makeShowAllDropdown === 'function') {
      window.makeShowAllDropdown(diffSourceBEl, () => {
        const combined = [...getRecentSources(), ...getRecentDests()];
        return [...new Set(combined)];
      });
    }
  }

  // ── Sub-folder selective transfer ─────────────────────────────────────────
  async function openSubfolderPicker(item) {
    const backdrop = $('subfolderModalBackdrop');
    const body = $('subfolderBody');
    const titleEl = $('subfolderModalTitle');
    if (!backdrop || !body) return null;
    if (titleEl) titleEl.textContent = `Sub-folders: ${item.displayTitle || item.folderName || ''}`;

    body.innerHTML = '<div style="color:var(--muted);padding:12px;">Loading sub-folders…</div>';
    backdrop.style.display = 'flex';
    backdrop.setAttribute('aria-hidden', 'false');

    const gamePath = item.ppsaFolderPath || item.folderPath;
    const ftpCfg = isFtpScan ? ftpConfig : null;
    let entries = [];
    try {
      entries = await window.ppsaApi.listGameSubfolders(gamePath, ftpCfg);
    } catch (e) {
      body.innerHTML = `<div style="color:#f87171;padding:12px;">Error: ${Utils.escapeHtml(e.message)}</div>`;
    }

    if (!entries.length) {
      body.innerHTML = '<div style="color:var(--muted);padding:12px;">No sub-folders found.</div>';
    } else {
      body.innerHTML = '';
      for (const ent of entries) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 2px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:12.5px;cursor:pointer;';
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = true; // default: select all
        chk.value = ent.name;
        const icon = ent.isDirectory ? '📁' : '📄';
        const size = ent.size > 0 ? ` (${bytesToHuman(ent.size)})` : '';
        row.innerHTML = ''; row.appendChild(chk);
        const lbl = document.createElement('label');
        lbl.style.cssText = 'flex:1;cursor:pointer;';
        lbl.textContent = `${icon} ${ent.name}${size}`;
        row.appendChild(lbl);
        row.addEventListener('click', e => { if (e.target !== chk) chk.checked = !chk.checked; });
        body.appendChild(row);
      }
    }

    return new Promise(resolve => {
      const close = (result) => {
        backdrop.style.display = 'none';
        backdrop.setAttribute('aria-hidden', 'true');
        $('subfolderProceed').onclick = null;
        $('subfolderCancel').onclick = null;
        $('subfolderCloseX').onclick = null;
        resolve(result);
      };
      $('subfolderProceed').onclick = () => {
        const checked = Array.from(body.querySelectorAll('input[type="checkbox"]:checked')).map(c => c.value);
        close(checked);
      };
      $('subfolderCancel').onclick = () => close(null);
      $('subfolderCloseX').onclick = () => close(null);
    });
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

      // Attach show-all custom dropdowns to source and destination path inputs.
      // Pass getter functions so options are always fresh when the dropdown opens.
      // Retry once after a short delay in case dropdown-helper.js loads after renderer.js.
      function attachDropdowns() {
        if (typeof window.makeShowAllDropdown === 'function') {
          const sourceInput = $('sourcePath');
          const destInput   = $('destPath');
          if (sourceInput) window.makeShowAllDropdown(sourceInput, getRecentSources);
          if (destInput)   window.makeShowAllDropdown(destInput,   getRecentDests);
          return true;
        }
        return false;
      }
      if (!attachDropdowns()) {
        // dropdown-helper.js may not yet have executed — retry after a tick
        setTimeout(attachDropdowns, 200);
      }

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
              if ($('sourcePath')) $('sourcePath').value = '';
              if ($('destPath')) $('destPath').value = '';
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

      // Handle operation-complete with success:false (IPC errors, network drops,
      // crashes) so the modal and UI are never permanently locked after a failure.
      if (window.ppsaApi && typeof window.ppsaApi.onOperationComplete === 'function') {
        window.ppsaApi.onOperationComplete((d) => {
          if (d && !d.success) {
            if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
            setResultModalBusy(false);
            setAppBusy(false);
            toast('Operation failed: ' + (d.error || 'Unknown error'));
          }
        });
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
          if (viewMode === 'card') {
            document.querySelectorAll('#cardGrid .card-item').forEach(c => {
              const chk = c.querySelector('.card-chk');
              if (chk) { chk.checked = true; updateCardSelected(c, true); }
            });
          } else {
            Array.from($('resultsBody').querySelectorAll('input[type="checkbox"]'))
              .filter(cb => cb.closest('tr').style.display !== 'none')
              .forEach(cb => {
                cb.checked = true;
                cb.closest('tr')?.classList.add('row-selected');
              });
          }
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
            toast('Error picking source folder: ' + e.message);
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
            toast('Error picking destination folder: ' + e.message);
          }
        });
      }
      const btnSourceDropdown = $('btnSourceDropdown');
      if (btnSourceDropdown) {
        btnSourceDropdown.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const inp = $('sourcePath');
          if (inp) inp.focus();
        });
      }
      const btnDestDropdown = $('btnDestDropdown');
      if (btnDestDropdown) {
        btnDestDropdown.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const inp = $('destPath');
          if (inp) inp.focus();
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
                // Update source field to full FTP URL so it's readable and re-scannable
                const srcEl = $('sourcePath');
                if (srcEl) srcEl.value = 'ftp://' + config.host + ':' + config.port + config.path;
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
            const res = await window.ppsaApi.scanSource(actualSrc, isFtpScan && ftpConfig ? { ftpConfig } : undefined);
            const arr = Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
            lastScannedSource = actualSrc;
            lastScannedFtpConfig = isFtpScan ? ftpConfig : null;
            if (arr.length > 0) {
              const duration = Math.round((Date.now() - scanStartTime) / 1000);
              renderResults(arr, duration);
            } else {
              // Scan returned 0 games — clear any rows that were streamed via game-found
              // events during the scan (those came from stale in-memory cache entries for
              // games that were already moved/deleted). The authoritative answer is arr=[].
              window.__ps5_lastRenderedItems = [];
              $('resultsBody').innerHTML = `<tr><td colspan="5" style="color:var(--muted);padding:12px">No games found.</td></tr>`;
              $('scanCount').textContent = '';
              // Always dismiss the scan bar — without this it stays up forever when
              // game-found events fired but the final result is empty, because the
              // size-update path (which normally calls showScanUI(false)) never runs.
              showScanUI(false);
            }
            currentSortBy = 'name';
          } catch (e) {
            console.error(e);
            toast('Scan failed: Check connection or path. Try again.');
            showScanUI(false);
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
            lastScannedSource = src;
            lastScannedFtpConfig = null;
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
            showScanUI(false);
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
            toast('Error cancelling scan: ' + e.message);
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
          const selected = getSelectedItemsAny();
          if (!selected.length) { toast('No items selected'); return; }
          const confirmed = await confirm(
            `Permanently delete ${selected.length} selected game${selected.length !== 1 ? 's' : ''}?\n\n` +
            `This will remove the files from disk and cannot be undone.`
          );
          if (!confirmed) return;
          try {
            setAppBusy(true, `Deleting ${selected.length} game${selected.length !== 1 ? 's' : ''}…`);
            showPersistentToast(`Deleting ${selected.length} game${selected.length !== 1 ? 's' : ''}…`);
            for (const item of selected) {
              if (isFtpScan && ftpConfig) {
                const pathToDelete = item.ppsaFolderPath || item.folderPath;
                await window.ppsaApi.ftpDeleteItem(ftpConfig, pathToDelete);
              } else {
                await window.ppsaApi.deleteItem(item);
              }
            }
            hidePersistentToast();
            toast(`Deleted ${selected.length} game${selected.length !== 1 ? 's' : ''} permanently`);
            await refreshResultsAfterOperation();
          } catch (e) {
            hidePersistentToast();
            toast('Delete failed: ' + (e.message || 'Unknown error'));
          } finally {
            setAppBusy(false);
          }
        });
      }

      // ── New feature buttons ──────────────────────────────────────────────
      const btnToggleView = $('btnToggleView');
      if (btnToggleView) btnToggleView.addEventListener('click', toggleViewMode);

      const btnVerifyLibrary = $('btnVerifyLibrary');
      if (btnVerifyLibrary) btnVerifyLibrary.addEventListener('click', () => openVerifyModal());

      const btnDiffSources = $('btnDiffSources');
      if (btnDiffSources) btnDiffSources.addEventListener('click', () => openDiffModal());

      const btnStatsPanel = $('btnStatsPanel');
      if (btnStatsPanel) btnStatsPanel.addEventListener('click', () => openStatsModal());

      // ── PS5 Discover button in FTP modal ─────────────────────────────────
      const ftpDiscoverBtn = $('ftpDiscoverBtn');
      if (ftpDiscoverBtn) {
        ftpDiscoverBtn.addEventListener('click', async () => {
          ftpDiscoverBtn.disabled = true;
          ftpDiscoverBtn.textContent = '🔍 Scanning…';
          try {
            const results = await window.ppsaApi.ps5Discover(6000);
            if (!results || !results.length) {
              toast('No PS5 found — make sure your FTP payload is running and PS5 is on the same network');
            } else {
              const first = results[0];
              const hostEl = $('ftpHost');
              const portEl = $('ftpPort');
              if (hostEl) hostEl.value = first.ip;
              if (portEl) portEl.value = String(first.port);
              toast(`Found PS5 at ${first.ip}:${first.port}`);
            }
          } catch (e) {
            toast('PS5 discovery failed: ' + e.message);
          } finally {
            ftpDiscoverBtn.disabled = false;
            ftpDiscoverBtn.textContent = '🔍 Find PS5';
          }
        });
      }

      // ── FTP Storage info button ───────────────────────────────────────────
      const ftpStorageBtn = $('ftpStorageBtn');
      if (ftpStorageBtn) {
        ftpStorageBtn.addEventListener('click', async () => {
          const hostVal = $('ftpHost')?.value?.trim();
          const portVal = parseInt($('ftpPort')?.value?.trim() || '2121', 10);
          if (!hostVal) { toast('Enter FTP host first'); return; }
          const cfg = {
            host: hostVal, port: portVal,
            user: $('ftpUser')?.value?.trim() || 'anonymous',
            password: $('ftpPass')?.value?.trim() || '',
            secure: false
          };
          // Pass already-scanned game items so the backend can sum sizes per mount
          const scannedItems = (window.__ps5_lastRenderedItems || []).filter(i => i.totalSize > 0);
          ftpStorageBtn.disabled = true;
          ftpStorageBtn.textContent = '💾 Loading…';
          try {
            const info = await window.ppsaApi.ftpStorageInfo(cfg, scannedItems);
            const backdrop = $('ftpStorageModalBackdrop');
            const body = $('ftpStorageBody');
            if (backdrop && body) {
              if (!info || info.error) {
                body.innerHTML = `<div style="color:#f87171;padding:12px;">Connection failed: ${Utils.escapeHtml(info?.error || 'Could not connect')}</div>`;
              } else if (!info.length) {
                body.innerHTML = '<div style="color:var(--muted);padding:12px;">No accessible mount points found. Make sure your PS5 FTP payload is running.</div>';
              } else {
                body.innerHTML = info.map(s => {
                  const hasAvail = s.available > 0;
                  const hasTotal = s.total > 0;
                  const hasGames = s.usedByGames > 0;
                  const hasItems = s.itemCount > 0;
                  const hasAnyData = hasAvail || hasTotal || hasGames;

                  let spaceStr = '', spaceNote = '', bar = '';

                  if (hasAvail && hasTotal) {
                    // Full picture: free + total → show bar + label
                    const usedBytes = s.total - s.available;
                    const pct = Math.min(100, Math.round((usedBytes / s.total) * 100));
                    const col = pct > 85 ? '#f87171' : pct > 65 ? '#fbbf24' : '#3b82f6';
                    if (s.isHardwareFallback) {
                      spaceStr = `${bytesToHuman(usedBytes)} used of ~${bytesToHuman(s.total)}`;
                      spaceNote = `<div style="font-size:10.5px;color:rgba(148,163,184,0.45);margin-top:3px;">~${bytesToHuman(s.total)} usable · estimate based on PS5 internal SSD spec</div>`;
                    } else {
                      spaceStr = `${bytesToHuman(s.available)} free of ${bytesToHuman(s.total)}`;
                    }
                    bar = `<div style="background:rgba(255,255,255,0.07);border-radius:4px;height:5px;margin-top:7px;overflow:hidden;" title="${pct}% used"><div style="background:${col};width:${pct}%;height:100%;border-radius:4px;transition:width .3s;"></div></div>`;

                  } else if (hasAvail && !hasTotal) {
                    // Only free space known (e.g. AVBL returned bytes but no total)
                    spaceStr = `${bytesToHuman(s.available)} free`;
                    if (hasGames) {
                      spaceNote = `<div style="font-size:10.5px;color:rgba(148,163,184,0.5);margin-top:3px;">${bytesToHuman(s.usedByGames)} in ${s.gameCount} scanned game${s.gameCount !== 1 ? 's' : ''}</div>`;
                    }

                  } else if (!hasAvail && hasTotal) {
                    // Only total known (hardware fallback with no free data)
                    spaceStr = `${bytesToHuman(s.total)} total`;
                    if (hasGames) {
                      const pct = Math.min(100, Math.round((s.usedByGames / s.total) * 100));
                      const col = pct > 85 ? '#f87171' : pct > 65 ? '#fbbf24' : '#3b82f6';
                      spaceNote = `<div style="font-size:10.5px;color:rgba(148,163,184,0.5);margin-top:3px;">${bytesToHuman(s.usedByGames)} in ${s.gameCount} scanned game${s.gameCount !== 1 ? 's' : ''}</div>`;
                      bar = `<div style="background:rgba(255,255,255,0.07);border-radius:4px;height:5px;margin-top:7px;overflow:hidden;" title="${pct}% used by games"><div style="background:${col};width:${pct}%;height:100%;border-radius:4px;transition:width .3s;"></div></div>`;
                    }

                  } else if (hasGames) {
                    // No disk space data at all, but we know game sizes from the scan
                    spaceStr = `${bytesToHuman(s.usedByGames)} in ${s.gameCount} game${s.gameCount !== 1 ? 's' : ''}`;
                    spaceNote = `<div style="font-size:10.5px;color:rgba(148,163,184,0.45);margin-top:3px;">Drive capacity unavailable · this PS5 payload does not report free space</div>`;

                  } else {
                    spaceStr = 'Accessible · no game data';
                  }

                  // Show which FTP command succeeded (dev aid, subtle)
                  const methodTag = s.spaceMethod
                    ? `<span style="font-size:9.5px;color:rgba(148,163,184,0.3);margin-left:5px;" title="Space reported via ${Utils.escapeHtml(s.spaceMethod)}">${Utils.escapeHtml(s.spaceMethod)}</span>`
                    : '';

                  const itemLabel = hasItems
                    ? `<div style="font-size:11px;color:var(--muted);margin-top:2px;">${s.itemCount} folder${s.itemCount !== 1 ? 's' : ''}${s.subPath ? ` · ${Utils.escapeHtml(s.subPath)}` : ''}</div>`
                    : '';

                  const dimmed = !hasAnyData && !hasItems;
                  return `<div style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);${dimmed ? 'opacity:0.35;' : ''}">
                    <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:13px;gap:12px;">
                      <span style="font-weight:600;color:var(--title);flex-shrink:0;">${Utils.escapeHtml(s.path)}${methodTag}</span>
                      <span style="color:${hasAnyData ? 'var(--title)' : 'var(--muted)'};font-size:12px;font-weight:${hasAnyData ? '500' : '400'};text-align:right;white-space:nowrap;">${spaceStr}</span>
                    </div>${itemLabel}${spaceNote}${bar}</div>`;
                }).join('');
              }
              const close = () => { backdrop.style.display = 'none'; backdrop.setAttribute('aria-hidden', 'true'); };
              $('ftpStorageClose').onclick = close;
              $('ftpStorageCloseX').onclick = close;
              backdrop.onclick = e => { if (e.target === backdrop) close(); };
              backdrop.style.display = 'flex';
              backdrop.setAttribute('aria-hidden', 'false');
            }
          } catch (e) {
            toast('Storage info failed: ' + e.message);
          } finally {
            ftpStorageBtn.disabled = false;
            ftpStorageBtn.textContent = '💾 Storage';
          }
        });
      }

      // ── Init column resize after table renders ────────────────────────────
      initColumnResize();

      // ── PS5 Auto-Discover (main UI) ───────────────────────────────────────
      // Scans the local network for PS5 consoles running an FTP payload.
      // Shows results as clickable chips in the source row.
      // Clicking a chip pre-fills the FTP modal and starts a scan immediately.
      (function initPs5Discover() {
        const btn       = $('btnFindPs5');
        const icon      = $('btnFindPs5Icon');
        const results   = $('ps5DiscoverResults');
        if (!btn || !results) return;

        let discovered  = []; // [{ip, port}]
        let scanning    = false;
        let activeChip  = null; // currently connected ps5

        function setScanning(on) {
          scanning = on;
          btn.disabled = on;
          icon.classList.toggle('ps5-scanning', on);
          icon.textContent = on ? '🔍' : '🎮';
          btn.querySelector('span:last-child').textContent = on ? 'Scanning…' : 'Find PS5';
        }

        function renderChips() {
          // Keep status text if present
          const statusEl = results.querySelector('.ps5-discover-status');
          results.innerHTML = '';
          if (statusEl) results.appendChild(statusEl);

          for (const ps5 of discovered) {
            const chip = document.createElement('div');
            chip.className = 'ps5-chip' + (activeChip && activeChip.ip === ps5.ip ? ' ps5-chip--active' : '');
            chip.title = `Click to connect to PS5 at ${ps5.ip}:${ps5.port}`;
            const isActive = activeChip && activeChip.ip === ps5.ip;
            chip.innerHTML =
              `<span class="ps5-chip-dot${isActive ? ' ps5-chip-dot--green' : ''}"></span>` +
              `<span>${ps5.ip}<span style="opacity:.6;font-weight:400;">:${ps5.port}</span></span>` +
              `<span class="ps5-chip-dismiss" title="Dismiss" data-ip="${ps5.ip}">✕</span>`;

            // Dismiss button
            chip.querySelector('.ps5-chip-dismiss').addEventListener('click', e => {
              e.stopPropagation();
              discovered = discovered.filter(p => p.ip !== ps5.ip);
              if (activeChip && activeChip.ip === ps5.ip) activeChip = null;
              renderChips();
            });

            // Click to connect
            chip.addEventListener('click', async () => {
              if (appBusy) { toast('Wait for current operation to finish'); return; }

              // Auto-connect using default FTP settings — no modal
              try {
                const config = {
                  host: ps5.ip,
                  port: ps5.port,
                  path: '/',
                  user: 'anonymous',
                  pass: '',
                  passive: true,
                  bufferSize: 65536, // 64 KB
                  parallel: 1,
                  speedLimitKbps: 0
                };

                toast('Connecting to PS5 at ' + ps5.ip + ':' + ps5.port + '…');

                ftpConfig = config;
                isFtpScan = true;

                // Update chip with confirmed port + path so it shows full FTP URL
                ps5.port = config.port;
                ps5.path = config.path;
                activeChip = { ip: config.host, port: config.port };
                renderChips();

                const actualSrc = 'ftp://' + config.host + ':' + config.port + config.path;
                // Update source field to full FTP URL so re-scan / refresh works
                const srcEl = $('sourcePath');
                if (srcEl) srcEl.value = actualSrc;

                addRecentFtp(config);
                try { localStorage.setItem(LAST_SRC_KEY, actualSrc); } catch (_) {}

                setAppBusy(true, 'Scanning…');
                showScanUI(true);
                $('currentScanLabel').textContent = 'Scanning PS5 — discovering games…';
                scanStartTime = Date.now();
                window.__ps5_lastRenderedItems = [];
                $('resultsBody').innerHTML = '';
                const res = await window.ppsaApi.scanSource(actualSrc, { ftpConfig: config });
                const arr = Array.isArray(res) ? res : (Array.isArray(res?.results) ? res.results : (Array.isArray(res?.items) ? res.items : []));
                // 5xx FTP errors (e.g., 550 No such file) mean the path doesn't exist on this server.
                // Treat as "0 games found" rather than a fatal error so the UI degrades gracefully.
                if (res && res.error && !arr.length) {
                if (/^5\d\d(?:\s|$)/.test(String(res.error))) {
                    toast('No games found on this PS5 — ensure your FTP payload is running and games are installed');
                    renderResults([], Math.round((Date.now() - scanStartTime) / 1000));
                    return;
                  }
                  throw new Error(res.error);
                }
                lastScannedSource = actualSrc;
                lastScannedFtpConfig = config;
                const duration = Math.round((Date.now() - scanStartTime) / 1000);
                renderResults(arr, duration);
              } catch (e) {
                err('PS5 connect scan error:', e);
                toast('Scan failed: ' + e.message);
              } finally {
                setAppBusy(false);
                showScanUI(false);
              }
            });

            results.appendChild(chip);
          }
        }

        function setStatus(msg, isErr) {
          let el = results.querySelector('.ps5-discover-status');
          if (!el) { el = document.createElement('span'); el.className = 'ps5-discover-status'; results.appendChild(el); }
          el.textContent = msg;
          el.style.color = isErr ? '#f87171' : 'var(--muted)';
          if (!msg) el.remove();
        }

        async function runScan() {
          if (scanning) return;
          setScanning(true);
          results.innerHTML = '';
          setStatus('Scanning network…');
          try {
            const found = await window.ppsaApi.ps5Discover(6000);
            results.innerHTML = '';
            if (!found || !found.length) {
              setStatus('No PS5 found — make sure your FTP payload is running');
            } else {
              // Merge with existing, dedupe by IP
              for (const f of found) {
                if (!discovered.find(d => d.ip === f.ip)) discovered.push(f);
              }
              renderChips();
              setStatus('');
            }
          } catch (e) {
            results.innerHTML = '';
            setStatus('Scan failed: ' + e.message, true);
          } finally {
            setScanning(false);
          }
        }

        btn.addEventListener('click', runScan);
      })();


      const btnRenameSelected = $('btnRenameSelected');
      if (btnRenameSelected) {
        btnRenameSelected.addEventListener('click', async () => {
          if (appBusy) { toast('Please wait for the current operation to finish.'); return; }
          const selected = getSelectedItemsAny();
          if (!selected.length) { toast('No items selected'); return; }
          const item = selected[0];
          const newName = await openRenameModal(item); // pass full item for version-aware presets
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
            await refreshResultsAfterOperation();
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

      // Bottom Close button — same behaviour as the ✕
      const resultCloseBtn = $('resultCloseBtn');
      if (resultCloseBtn) {
        resultCloseBtn.addEventListener('click', () => {
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

      const sizeFilter = $('sizeFilter');
      if (sizeFilter) {
        sizeFilter.addEventListener('change', () => applySearchFilter());
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

      // Right-click on a game row for context actions
      $('resultsBody').addEventListener('contextmenu', async (e) => {
        const tr = e.target.closest('tr');
        if (!tr || !tr.dataset.index) return;
        e.preventDefault();
        const idx = parseInt(tr.dataset.index, 10);
        const item = window.__ps5_lastRenderedItems && window.__ps5_lastRenderedItems[idx];
        if (!item) return;
        // Simple context menu
        const existing = document.getElementById('rowContextMenu');
        if (existing) existing.remove();
        const menu = document.createElement('div');
        menu.id = 'rowContextMenu';
        menu.style.cssText = [
          'position:fixed', `left:${e.clientX}px`, `top:${e.clientY}px`,
          'background:var(--surface-2)', 'border:1px solid var(--card-border-hover)',
          'border-radius:var(--radius)', 'padding:4px 0', 'z-index:99999',
          'box-shadow:0 8px 24px rgba(0,0,0,0.5)', 'min-width:180px', 'font-size:12.5px'
        ].join(';');
        const menuItems = [
          ['📋 View details', () => openGameDetailModal(item)],
          ['📁 Pick sub-folders…', async () => {
            const subs = await openSubfolderPicker(item);
            if (subs && subs.length) {
              toast(`${subs.length} sub-folder(s) selected — adjust destination then click GO`);
            }
          }],
        ];
        for (const [label, fn] of menuItems) {
          const mi = document.createElement('div');
          mi.style.cssText = 'padding:7px 14px;cursor:pointer;color:var(--title);transition:background 0.1s;';
          mi.textContent = label;
          mi.addEventListener('mouseenter', () => { mi.style.background = 'rgba(59,130,246,0.15)'; });
          mi.addEventListener('mouseleave', () => { mi.style.background = ''; });
          mi.addEventListener('click', () => { menu.remove(); fn(); });
          menu.appendChild(mi);
        }
        document.body.appendChild(menu);
        const dismiss = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', dismiss); } };
        setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
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
            if (viewMode === 'card') {
              document.querySelectorAll('#cardGrid .card-item').forEach(c => { const chk = c.querySelector('.card-chk'); if (chk) { chk.checked = true; updateCardSelected(c, true); } });
            } else {
              Array.from(document.querySelectorAll('#resultsBody input[type="checkbox"]')).filter(cb => cb.closest('tr').style.display !== 'none').forEach(cb => { cb.checked = true; cb.closest('tr')?.classList.add('row-selected'); });
            }
            updateHeaderCheckboxState();
          } else if (value === 'unselectAll') {
            if (viewMode === 'card') {
              document.querySelectorAll('#cardGrid .card-item').forEach(c => { const chk = c.querySelector('.card-chk'); if (chk) { chk.checked = false; updateCardSelected(c, false); } });
            } else {
              Array.from(document.querySelectorAll('#resultsBody input[type="checkbox"]')).filter(cb => cb.closest('tr').style.display !== 'none').forEach(cb => { cb.checked = false; cb.closest('tr')?.classList.remove('row-selected'); });
            }
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
          } else if (value === 'apiSettings') {
            openApiSettingsModal();
          } else if (value === 'exportCsv') {
            exportHistoryCsv();
          } else if (value === 'stats') {
            openStatsModal();
          } else if (value === 'verify') {
            openVerifyModal();
          } else if (value === 'diff') {
            openDiffModal();
          }
          e.target.value = '';
        });
      }

      // Save settings on change
      if ($('layout')) $('layout').addEventListener('change', () => localStorage.setItem(LAST_LAYOUT_KEY, $('layout').value));
      if ($('action')) $('action').addEventListener('change', () => localStorage.setItem(LAST_ACTION_KEY, $('action').value));

    } catch (e) {
      console.error('[renderer] DOMContentLoaded error', e);
      console.error('[renderer] init error:', e);
    }
    log('renderer initialized');
  });
})();