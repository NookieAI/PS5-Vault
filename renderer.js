(function () {
  'use strict';

  const Utils = {
    sanitizeName(name) {
      if (!name) return 'Unknown';
      return String(name).replace(/[<>:"/\\|?*\x00-\x1F!'™@#$%^&[\]{}=+;,`~]/g, '').trim().slice(0, 200) || 'Unknown';
    },
    escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    },
    normalizeDisplayPath(path) {
      if (!path) return '';
      const p = String(path);
      if (p.startsWith('/mnt/ext1/')) return p.replace('/mnt/ext1/', 'PS5:/');
      if (p.startsWith('/mnt/usb0/')) return p.replace('/mnt/usb0/', 'USB0:/');
      if (p.startsWith('/mnt/usb1/')) return p.replace('/mnt/usb1/', 'USB1:/');
      if (p.startsWith('ftp://')) {
        const u = new URL(p);
        return `FTP://${u.hostname}:${u.port}${u.pathname}`;
      }
      return p;
    },
    pathEndsWithSceSys(path) {
      if (!path) return false;
      return String(path).toLowerCase().endsWith('/sce_sys');
    },
    cleanPath(p) {
      if (!p) return '';
      if (p.startsWith('ftp://')) {
        const parts = p.split('://');
        if (parts.length === 2) {
          const proto = parts[0] + '://';
          let rest = parts[1].replace(/\/+/g, '/');
          rest = decodeURIComponent(rest);
          return Utils.escapeHtml(proto + rest);
        }
      }
      let cleanedP = p.replace(/\/+/g, '/');
      cleanedP = decodeURIComponent(cleanedP);
      return Utils.escapeHtml(cleanedP);
    }
  };

  const LAST_SRC_KEY = 'ps5vault.lastSource';
  const LAST_DST_KEY = 'ps5vault.lastDest';
  const LAST_RESULTS_KEY = 'ps5vault.lastResults';
  const SETTINGS_KEY = 'ps5vault.settings';
  const TRANSFER_STATE_KEY = 'ps5vault.transferState';
  const RECENT_SOURCES_KEY = 'ps5vault.recentSources';
  const RECENT_DESTS_KEY = 'ps5vault.recentDests';
  const LAST_LAYOUT_KEY = 'ps5vault.lastLayout';
  const LAST_ACTION_KEY = 'ps5vault.lastAction';
  const LAST_CALC_SIZE_KEY = 'ps5vault.lastCalcSize';

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
  let shouldRefreshAfterClose = false;
  let totalTransferred = 0;

  function sanitize(name) {
    if (!name) return 'Unknown';
    return String(name).replace(/[<>:"/\\|?*\x00-\x1F!'™@#$%^&[\]{}=+;,`~]/g, '').trim().slice(0, 200) || 'Unknown';
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
    const limited = filtered.slice(0, 10);
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
    const limited = filtered.slice(0, 5);
    try {
      localStorage.setItem('ps5vault.recentFtp', JSON.stringify(limited));
    } catch (_) {}
    updateFtpHistoryDatalist();
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

  function updateFtpHistoryDatalist() {
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
    if (show) {}
  }

  const TransferStats = {
    startTime: 0,
    lastTime: 0,
    lastBytes: 0,
    emaSpeed: 0,
    totalElapsed: 0,
    reset() {
      this.startTime = Date.now();
      this.lastTime = this.startTime;
      this.lastBytes = 0;
      this.emaSpeed = 0;
      this.totalElapsed = 0;
    },
    update(totalBytesCopied, totalBytes) {
      const now = Date.now();
      const dt = Math.max(1, (now - this.lastTime) / 1000);
      this.totalElapsed += dt;
      const delta = Math.max(0, totalBytesCopied - this.lastBytes);
      const instSpeed = delta / dt;
      const alpha = 0.25;
      this.emaSpeed = this.emaSpeed ? (alpha * instSpeed + (1 - alpha) * this.emaSpeed) : instSpeed;
      this.lastTime = now;
      this.lastBytes = totalBytesCopied;
      const remaining = Math.max(0, totalBytes - totalBytesCopied);
      const overallSpeed = this.totalElapsed > 0 ? (totalBytesCopied / this.totalElapsed) : 0;
      const etaSec = overallSpeed > 0 ? (remaining / overallSpeed) : 0;
      return {
        speedBps: Number.isFinite(this.emaSpeed) ? this.emaSpeed : 0,
        etaSec: Number.isFinite(etaSec) ? etaSec : 0
      };
    }
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

  function formatContentVersionShort(cv) {
    if (!cv) return '';
    return cv;
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

  function shouldAddPlus(sdkValue) {
    return false;
  }

  function identityKey(item) {
    const key = item.ppsa || item.contentId || item.displayTitle || item.dbTitle || item.folderName || '';
    return String(key).toLowerCase();
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
    backdrop.setAttribute('aria-hidden', 'true');
  }

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

      const row2 = document.createElement('div');
      row2.className = 'path-row';
      row2.style.marginTop = '6px';
      const from = document.createElement('div');
      from.className = 'path-inline';
      from.innerHTML = '<span class="label-bold">From:</span> ' + Utils.cleanPath(p.source || '');
      const to = document.createElement('div');
      to.className = 'path-inline';
      to.innerHTML = '<span class="label-bold">To:</span> ' + Utils.cleanPath(p.target || '');
      row2.appendChild(from);
      row2.appendChild(to);
      row.appendChild(row2);

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
          return `<div>${item.displayTitle} → ${newName}</div>`;
        }).join('');
      }

      patternInput.addEventListener('input', updatePreview);
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

  function openFtpModal(initialUrl) {
    return new Promise((resolve) => {
      const backdrop = $('ftpModalBackdrop');
      const hostInput = $('ftpHost');
      const portInput = $('ftpPort');
      const pathInput = $('ftpPath');
      const userInput = $('ftpUser');
      const passInput = $('ftpPass');
      const proceedBtn = $('ftpProceed');
      const cancelBtn = $('ftpCancel');

      if (!backdrop || !hostInput || !portInput || !pathInput || !userInput || !passInput || !proceedBtn || !cancelBtn) {
        return Promise.resolve(null);
      }

      if (initialUrl) {
        try {
          const url = new URL(initialUrl.startsWith('ftp://') ? initialUrl : 'ftp://' + initialUrl);
          hostInput.value = url.hostname;
          portInput.value = (url.port && /^\d+$/.test(url.port)) ? url.port : '2121';
          pathInput.value = url.pathname || '/';
          userInput.value = url.username || 'anonymous';
          passInput.value = url.password || '';
        } catch (e) {
          hostInput.value = initialUrl.replace('ftp://', '').split(':')[0] || '';
          portInput.value = '2121';
          pathInput.value = '/';
          userInput.value = 'anonymous';
          passInput.value = '';
        }
      } else {
        const lastConfig = getRecentFtp().length > 0 ? getRecentFtp()[0] : null;
        if (lastConfig) {
          hostInput.value = lastConfig.host || '';
          portInput.value = lastConfig.port || '2121';
          pathInput.value = lastConfig.path || '/mnt/ext1/etaHEN/games';
          userInput.value = lastConfig.user || 'anonymous';
          passInput.value = lastConfig.pass || '';
        } else {
          hostInput.value = '';
          portInput.value = '2121';
          pathInput.value = '/mnt/ext1/etaHEN/games';
          userInput.value = 'anonymous';
          passInput.value = '';
        }
      }

      const setDefaultPath = () => {
        pathInput.value = '/';
      };

      setDefaultPath();

      backdrop.style.display = 'flex';
      backdrop.setAttribute('aria-hidden', 'false');
      hostInput.focus();

      const cleanup = () => {
        backdrop.style.display = 'none';
        backdrop.setAttribute('aria-hidden', 'true');
        portInput.removeEventListener('change', setDefaultPath);
        proceedBtn.removeEventListener('click', onProceed);
        cancelBtn.removeEventListener('click', onCancel);
      };

      const onProceed = () => {
        const config = {
          host: hostInput.value.trim(),
          port: portInput.value.trim(),
          path: pathInput.value.trim(),
          user: userInput.value.trim(),
          pass: passInput.value.trim()
        };

        // Validate port
        const portNum = parseInt(config.port);
        if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
          alert('Invalid port number. Must be between 1 and 65535.');
          return;
        }
        config.port = String(portNum);

        cleanup();
        resolve(config);
      };

      const onCancel = () => {
        cleanup();
        resolve(null);
      };

      proceedBtn.addEventListener('click', onProceed);
      cancelBtn.addEventListener('click', onCancel);
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

  function computeFinalTargetForItem(it, dest, layout, customName) {
    const safeGame = customName && layout === 'custom' ? Utils.sanitizeName(customName) : Utils.sanitizeName(it.displayTitle || it.dbTitle || it.folderName || it.ppsa || 'Unknown Game');
    let finalPpsaName = it.ppsa || (it.contentId && (String(it.contentId).match(/PPSA\d{4,6}/i) || [])[0]?.toUpperCase()) || null;
    if (!finalPpsaName) {
      const src = it.contentFolderPath || it.ppsaFolderPath || it.folderPath || '';
      const base = (src + '').split(/[\\/]/).pop() || '';
      finalPpsaName = base.replace(/[-_]*app\d*.*$/i, '').replace(/[-_]+$/,'') || base;
    }
    const pathJoin = (...parts) => parts.filter(Boolean).join('/');
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
    path = path.replace(/\/sce_sys$/i, '');
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
      hidePersistentToast();
      toast('Results refreshed');
    } catch (scanErr) {
      err('Refresh error:', scanErr);
      hidePersistentToast();
      toast('Refresh failed: ' + (scanErr.message || 'Unknown error'));
    }
  }

  async function goClickHandler() {
    const selected = getSelectedItems();
    if (!selected.length) {
      toast('No items selected');
      return;
    }
    try {
      const tbody = $('resultsBody');
      const trs = Array.from(tbody.querySelectorAll('tr'));
      const selectedIndices = [];
      trs.forEach((tr, idx) => {
        if (tr.style.display === 'none') return;
        const cb = tr.querySelector('input[type="checkbox"]');
        if (cb && cb.checked) {
          selectedIndices.push(idx);
          const orig = window.__ps5_lastRenderedItems[idx];
          const item = {
            displayTitle: orig.displayTitle || orig.dbTitle || orig.folderName || '',
            contentFolderPath: orig.contentFolderPath || orig.folderPath || '',
            folderPath: orig.folderPath || orig.contentFolderPath || '',
            folderName: orig.folderName || '',
            ppsa: orig.ppsa || null,
            paramPath: orig.paramPath || null,
            contentId: orig.contentId || null,
            iconPath: orig.iconPath || null,
            dbPresent: false,
            dbTitle: null,
            skuFromParam: orig.skuFromParam || null,
            contentVersion: orig.contentVersion || null
          };
          const correctPath = computeSourceFolder(item);
          item.folderPath = correctPath;
          item.contentFolderPath = correctPath;
          item.ppsaFolderPath = correctPath;
          if (isFtpScan && ftpConfig) {
            const encodedFolderPath = encodeURIComponent(item.folderPath).replace(/%2F/g, '/');
            if (ftpConfig.path === '/') {
              item.source = 'ftp://' + ftpConfig.host + ':' + ftpConfig.port + '/' + encodedFolderPath;
            } else {
              item.source = 'ftp://' + ftpConfig.host + ':' + ftpConfig.port + ftpConfig.path + '/' + encodedFolderPath;
            }
          }
        }
      });
      if (!selected.length) {
        toast('No items selected');
        return;
      }

      for (const item of selected) {
        if (item.contentVersion && !item.displayTitle.includes(`(${item.contentVersion})`)) {
          item.displayTitle += ` (${item.contentVersion})`;
        }
      }

      let dest = $('destPath') && $('destPath').value ? $('destPath').value.trim() : '';
      if (!dest) {
        toast('Select destination');
        return;
      }

      // Check if destination is FTP
      let ftpDestConfig = null;
      if (/^(\d+\.\d+\.\d+\.\d+(:\d+)?|ftp:\/\/)/.test(dest)) {
        ftpDestConfig = await openFtpModal(dest.startsWith('ftp://') ? dest : 'ftp://' + dest);
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
      if (dest === src) shouldRefreshAfterClose = true;

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
          const rl = $('resultList');
          const rp = $('resultProgress');
          const rs = $('resultSubText');
          const rc = $('resultCount');
          const closeBtn = $('resultClose');
          const actionsRow = $('resultActionsRow');

          if (rb && rl && rp && rc && rs) {
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
              const operationCancelBtn = document.createElement('button');
              operationCancelBtn.id = 'resultCancel';
              operationCancelBtn.className = 'btn-danger modal-close';
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
              actionsRow.setAttribute('aria-hidden', 'false');
            }

            let closeX = rb.querySelector('.close-x');
            if (!closeX) {
              closeX = document.createElement('button');
              closeX.className = 'close-x';
              closeX.textContent = '×';
              closeX.style.position = 'absolute';
              closeX.style.top = '10px';
              closeX.style.right = '10px';
              closeX.style.fontSize = '24px';
              closeX.style.background = 'none';
              closeX.style.border = 'none';
              closeX.style.color = 'var(--text)';
              closeX.style.cursor = 'pointer';
              closeX.style.width = '30px';
              closeX.style.height = '30px';
              closeX.style.display = 'flex';
              closeX.style.alignItems = 'center';
              closeX.style.justifyContent = 'center';
              closeX.style.zIndex = '1001';
              closeX.addEventListener('click', () => {
                rb.style.display = 'none';
                rb.setAttribute('aria-hidden', 'true');
                refreshResultsAfterOperation();
              });
              rb.appendChild(closeX);
            }
            closeX.style.display = 'none';
          }
          setResultModalBusy(true);

          saveTransferState({ items: selected, dest, action, layout, customName, overwriteMode, ftpConfig: isFtpScan ? ftpConfig : null, ftpDestConfig });
          const res = await window.ppsaApi.ensureAndPopulate({ items: selected, dest, action, layout, customName, overwriteMode, ftpConfig: isFtpScan ? ftpConfig : null, ftpDestConfig });
          if (!res) throw new Error('No response');
          if (res.error) throw new Error(res.error);

          const rp2 = $('resultProgress');
          const rl2 = $('resultList');
          const close2 = $('resultClose');
          const actions2 = $('resultActionsRow');
          if (rp2) rp2.style.display = 'none';
          if (rl2) rl2.style.display = 'block';
          if (actions2) actions2.display = 'none';
          if (close2) closeBtn.style.display = 'block';

          const closeX = rb.querySelector('.close-x');
          if (closeX) closeX.style.display = 'block';

          updateListSummary(res);

          shouldRefreshAfterClose = true;

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
      toast('Operation failed: ' + (e.message || String(e)));
    } finally {
      setResultModalBusy(false);
    }
  }

  function saveTransferState(state) {
    transferState = state;
    localStorage.setItem(TRANSFER_STATE_KEY, JSON.stringify(state));
  }

  function resumeTransfer() {
    if (!resumeState) return;
    toast('Resuming transfer...');
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
      } else if (r.uploaded) {
        badge = 'uploaded';
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
      const cleanPath = (p) => {
        if (!p) return '';
        if (p.startsWith('ftp://')) {
          const parts = p.split('://');
          if (parts.length === 2) {
            const proto = parts[0] + '://';
            let rest = parts[1].replace(/\/+/g, '/');
            rest = decodeURIComponent(rest);
            return Utils.escapeHtml(proto + rest);
          }
        }
        let cleanedP = p.replace(/\/+/g, '/');
        cleanedP = decodeURIComponent(cleanedP);
        return Utils.escapeHtml(cleanedP);
      };
      const from = document.createElement('div');
      from.className = 'path-inline';
      from.innerHTML = '<span class="label-bold">From:</span> ' + cleanPath(r.source || '');
      const to = document.createElement('div');
      to.className = 'path-inline';
      to.innerHTML = '<span class="label-bold">To:</span> ' + cleanPath(r.target || '');
      row.appendChild(from);
      row.appendChild(to);
      left.appendChild(row);

      const right = document.createElement('div');
      right.style.flex = '0 0 auto';
      if (badge) {
        const b = document.createElement('button');
        b.className = (badge === 'moved' || badge === 'copied' || badge === 'created' || badge === 'uploaded') ? 'btn-go' : 'btn';
        b.textContent = { moved: 'Moved', copied: 'Copied', created: 'Created', uploaded: 'Uploaded', error: 'Error', skipped: 'Skipped' }[badge] || badge;
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
      if (totalBytes > 0) parts.push(`Total transferred: ${bytesToHuman(totalBytes)}`);
      if (maxSpeed > 0) parts.push(`Max speed: ${bytesToHuman(maxSpeed)}/s`);
      rs.textContent = parts.length ? parts.join(' • ') : 'Operation complete';
    }
    const rcEl = $('resultCount');
    if (rcEl) rcEl.textContent = String(total);
    totalTransferred = totalBytes;
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

    // If calculate size is unchecked, blank out sizes
    const calcSizeChecked = $('calcSize') && $('calcSize').checked;
    if (!calcSizeChecked) {
      list.forEach(r => r.totalSize = null);
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
      const sizeVal = r.totalSize;
      if (sizeVal === null) {
        tdSize.textContent = ''; // Leave blank for FTP or when unchecked
      } else if (sizeVal === 0) {
        tdSize.textContent = '--';
      } else if (sizeVal < 0) {
        // Partial estimate for large local games
        const partialBytes = -sizeVal;
        tdSize.textContent = `> ${bytesToHuman(partialBytes)}`;
      } else {
        tdSize.textContent = bytesToHuman(sizeVal);
      }
      tr.appendChild(tdSize);

      const tdFolder = document.createElement('td');
      tdFolder.className = 'folder';
      tdFolder.style.verticalAlign = 'top';
      const fp = document.createElement('div');
      fp.title = r.ppsaFolderPath || r.folderPath || r.contentFolderPath || '';
      fp.style.color = 'var(--muted)';
      fp.style.fontWeight = '700';
      fp.style.cursor = 'pointer';
      fp.textContent = fp.title;
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
      maxSpeed = 0;
      completedFiles = [];
      transferStartTime = Date.now(); // Always set at start for accurate duration
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
        cf.textContent = '';
        comp.innerHTML = '';
        rb.style.display = 'flex';
        rb.setAttribute('aria-hidden', 'false');
      }
      cancelOperation = false;
      const ts = $('transferStats');
      if (ts) ts.textContent = 'Speed: --';
      const etaEl = $('transferETA');
      if (etaEl) etaEl.textContent = 'ETA: --';
      return;
    }

    if (d.type === 'go-file-progress' || d.type === 'go-file-complete') {
      if (!transferStartTime) transferStartTime = Date.now(); // Fallback: set timer on first progress if not set in go-start
      if (cancelOperation) return;
      if (d.fileRel) lastFile = d.fileRel;
      const stats = TransferStats.update(d.totalBytesCopied || 0, d.totalBytes || 0);
      if (stats.speedBps > maxSpeed) maxSpeed = stats.speedBps;
      const rs = $('resultSubText');
      const cf = $('currentFileInfo');
      if (rs && cf) {
        const speedHuman = bytesToHuman(stats.speedBps || 0) + '/s';
        const hasTotal = d.totalBytes && Number.isFinite(d.totalBytes) && d.totalBytes > 0;
        if (hasTotal) {
          const percent = Math.min(100, Math.round((d.totalBytesCopied / d.totalBytes) * 100));
          const baseText = `Progress: ${percent}% • ${speedHuman}`; // Removed lastFile here
          rs.textContent = baseText;
          cf.textContent = lastFile ? `Current: ${lastFile} (${percent}%)` : 'Preparing...';
        } else {
          const baseText = `Transferring... ${speedHuman}`; // Removed lastFile here
          rs.textContent = baseText;
          cf.textContent = lastFile ? `Current: ${lastFile}` : 'Preparing...';
        }
      }

      const progressFill = $('resultProgress')?.querySelector('.progress-fill');
      if (progressFill) {
        const hasTotal = d.totalBytes && Number.isFinite(d.totalBytes) && d.totalBytes > 0;
        progressFill.style.width = hasTotal ? `${Math.min(100, Math.round((d.totalBytesCopied / d.totalBytes) * 100))}%` : '0%';
      }

      const ts = $('transferStats');
      if (ts) ts.textContent = `Speed: ${bytesToHuman(stats.speedBps || 0)}/s`;
      const etaEl = $('transferETA');
      if (etaEl) etaEl.textContent = `ETA: ${secToHMS(stats.etaSec || 0)}`;
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
      const transferDurationMs = transferStartTime ? (Date.now() - transferStartTime) : 0;
      let durationText;
      if (transferDurationMs < 100) {
        durationText = '--'; // Avoid showing inaccurate small times
      } else if (transferDurationMs < 1000) {
        durationText = `${transferDurationMs}ms`;
      } else {
        durationText = secToHMS(transferDurationMs / 1000);
      }
      const totalTransferred = d.totalBytesCopied || 0;
      const ts = $('transferStats');
      if (ts) ts.textContent = `Completed in ${durationText} • Total transferred: ${bytesToHuman(totalTransferred)}`;
      transferStartTime = 0; // Reset timer for next transfer
      const actionsRow = $('resultActionsRow');
      if (actionsRow) actionsRow.style.display = 'none';
      return;
    }

    if (d.type === 'go-item') {
      const label = $('currentScanLabel');
      const raw = d.folder || d.path || '';
      if (label) label.textContent = Utils.pathEndsWithSceSys(raw) ? '' : (Utils.normalizeDisplayPath(raw) || '');
      return;
    }
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

      // Force input acceptance on keydown
      const forceInputAcceptance = (e) => {
        // Allow all keystrokes and prevent any interference
        e.stopPropagation();
      };

      ensureInputsEditable(); // Initial setup
      setInterval(ensureInputsEditable, 500); // More frequent check (every 0.5s) for robustness

      // Attach to source and dest inputs
      const sourceInput = $('sourcePath');
      const destInput = $('destPath');
      if (sourceInput) {
        sourceInput.addEventListener('keydown', forceInputAcceptance);
        sourceInput.addEventListener('input', () => {
          // Ensure value is accepted
          sourceInput.value = sourceInput.value;
        });
      }
      if (destInput) {
        destInput.addEventListener('keydown', forceInputAcceptance);
        destInput.addEventListener('input', () => {
          // Ensure value is accepted
          destInput.value = destInput.value;
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
      const lastCalcSize = localStorage.getItem(LAST_CALC_SIZE_KEY) === 'true';
      if ($('layout')) $('layout').value = lastLayout;
      if ($('action')) $('action').value = lastAction;
      if ($('calcSize')) $('calcSize').checked = lastCalcSize;

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
              updateFtpHistoryDatalist();
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

      const btnHelp = $('btnHelp');
      if (btnHelp) {
        btnHelp.addEventListener('click', () => {
          try {
            if (window.HelpApi && window.HelpApi.openHelp) window.HelpApi.openHelp(e);
          } catch (e) {
            console.error('Help open error:', e);
          }
        });
      }

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
          try {
            if (window.HelpApi && window.HelpApi.openHelp) window.HelpApi.openHelp(e);
          } catch (e) {
            console.error('F1 help error:', e);
          }
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
            } else if (/^(\d+\.\d+\.\d+\.\d+(:\d+)?|ftp:\/\/)/.test(src)) {
              // Open FTP modal for configuration
              const config = await window.FtpApi.openFtpModal(src.startsWith('ftp://') ? src : 'ftp://' + src);
              if (config) {
                ftpConfig = config;
                isFtpScan = true;
                actualSrc = 'ftp://' + config.host + ':' + config.port + config.path;
                addRecentFtp(actualSrc);
              } else {
                return;
              }
            } else {
              addRecentSource(src);
            }
            try { localStorage.setItem(LAST_SRC_KEY, actualSrc); } catch (_) {}
            showScanUI(true);
            $('btnGoBig').disabled = true;
            $('currentScanLabel').textContent = 'Scanning...';
            scanStartTime = Date.now();
            const res = await window.ppsaApi.scanSource(actualSrc);
            const arr = Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
            const duration = Math.round((Date.now() - scanStartTime) / 1000);
            renderResults(arr, duration);
            $('btnGoBig').disabled = false;
            currentSortBy = 'name';
          } catch (e) {
            console.error(e);
            toast('Scan failed: Check connection or path. Try again.');
          }
        });
      }

      const btnScanAllDrives = $('btnScanAllDrives');
      if (btnScanAllDrives) {
        btnScanAllDrives.addEventListener('click', async () => {
          try {
            const src = 'all-drives';
            if (!src) { toast('Select source first'); return; }
            let actualSrc = src;
            isFtpScan = false;
            ftpConfig = null;
            addRecentSource(src);
            try { localStorage.setItem(LAST_SRC_KEY, actualSrc); } catch (_) {}
            showScanUI(true);
            $('btnGoBig').disabled = true;
            $('currentScanLabel').textContent = 'Scanning all drives...';
            scanStartTime = Date.now();
            const res = await window.ppsaApi.scanSource(actualSrc);
            const arr = Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
            const duration = Math.round((Date.now() - scanStartTime) / 1000);
            renderResults(arr, duration);
            $('btnGoBig').disabled = false;
            currentSortBy = 'name';
          } catch (e) {
            console.error(e);
            toast('Scan failed: ' + e.message);
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

      const btnSelectAll = $('btnSelectAll');
      if (btnSelectAll) {
        btnSelectAll.addEventListener('click', () => {
          Array.from(document.querySelectorAll('#resultsBody input[type="checkbox"]')).filter(cb => cb.closest('tr').style.display !== 'none').forEach(cb => {
            cb.checked = true;
            cb.closest('tr')?.classList.add('row-selected');
          });
          updateHeaderCheckboxState();
        });
      }
      const btnUnselectAll = $('btnUnselectAll');
      if (btnUnselectAll) {
        btnUnselectAll.addEventListener('click', () => {
          Array.from(document.querySelectorAll('#resultsBody input[type="checkbox"]')).filter(cb => cb.closest('tr').style.display !== 'none').forEach(cb => {
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
          $('scanCount').textContent = '';
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
            showPersistentToast('Deleting selected items...');
            for (const item of selected) {
              if (isFtpScan && ftpConfig) {
                const pathToDelete = item.ppsaFolderPath || item.folderPath;
                await window.ppsaApi.ftpDeleteItem(ftpConfig, pathToDelete);
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
              hidePersistentToast();
              toast('Results refreshed');
            }
          } catch (e) {
            hidePersistentToast();
            toast('Delete failed: ' + (e.message || 'Unknown error'));
          } finally {
            btnDeleteSelected.disabled = false;
            btnDeleteSelected.textContent = 'Delete Selected';
          }
        });
      }

      const btnRenameSelected = $('btnRenameSelected');
      if (btnRenameSelected) {
        btnRenameSelected.addEventListener('click', async () => {
          const selected = getSelectedItems();
          if (!selected.length) {
            toast('No items selected');
            return;
          }
          // Since button is disabled for >1, no need to check length
          const item = selected[0];
          const currentName = item.displayTitle || '';
          const newName = await openRenameModal(currentName);
          if (!newName || !newName.trim()) return;
          const sanitizedName = sanitize(newName.trim());
          const oldPath = item.ppsaFolderPath;
          const newPath = oldPath.replace(/\/[^\/]*$/, '/' + sanitizedName);
          try {
            btnRenameSelected.disabled = true;
            btnRenameSelected.textContent = 'Renaming...';
            showPersistentToast('Renaming selected item...');
            if (isFtpScan && ftpConfig) {
              await window.ppsaApi.ftpRenameItem(ftpConfig, oldPath, newPath);
            } else {
              await window.ppsaApi.renameItem(item, newName.trim());
            }
            hidePersistentToast();
            toast('Renamed successfully');
            const src = $('sourcePath').value.trim();
            if (src) {
              showPersistentToast('Refreshing results...');
              const res = await window.ppsaApi.scanSource(src);
              const arr = Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
              renderResults(arr);
              hidePersistentToast();
              toast('Results refreshed');
            }
          } catch (e) {
            hidePersistentToast();
            toast('Rename failed: ' + (e.message || 'Unknown error'));
          } finally {
            btnRenameSelected.disabled = false;
            btnRenameSelected.textContent = 'Rename Selected';
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

      const topMenu = $('topMenu');
      if (topMenu) {
        topMenu.addEventListener('change', (e) => {
          const value = e.target.value;
          if (value === 'export') {
            exportData();
          } else if (value === 'import') {
            importData();
          } else if (value === 'help') {
            try {
              if (window.HelpApi && window.HelpApi.openHelp) window.HelpApi.openHelp(e);
            } catch (e) {
              console.error('Help open error:', e);
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
            if (!confirm('Clear all scan results? This cannot be undone.')) return;
            Array.from(document.querySelectorAll('#resultsBody input[type="checkbox"]')).forEach(cb => {
              cb.checked = false;
              cb.closest('tr')?.classList.remove('row-selected');
            });
            const tb = $('resultsBody');
            if (tb) tb.innerHTML = `<tr><td colspan="5" style="color:var(--muted);padding:12px">No scan performed yet.</td></tr>`;
            $('scanCount').textContent = '';
            updateHeaderCheckboxState();
            try { localStorage.removeItem(LAST_RESULTS_KEY); } catch (_) {}
          }
          e.target.value = ''; // Reset to default
        });
      }

      // Save settings on change
      if ($('layout')) $('layout').addEventListener('change', () => localStorage.setItem(LAST_LAYOUT_KEY, $('layout').value));
      if ($('action')) $('action').addEventListener('change', () => localStorage.setItem(LAST_ACTION_KEY, $('action').value));
      if ($('calcSize')) $('calcSize').addEventListener('change', () => localStorage.setItem(LAST_CALC_SIZE_KEY, $('calcSize').checked));

    } catch (e) {
      console.error('[renderer] DOMContentLoaded error', e);
      alert('DOMContentLoaded error: ' + e.message);
    }
    log('renderer initialized');
  });
})();