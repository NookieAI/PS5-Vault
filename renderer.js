// renderer.js — renderer UI logic (updated)
// Change: result modal shows per-item status buttons aligned to each entry (right column).
// Restore per-row status buttons (moved/copied/error) and remove the separate stacked actions row.
// Replace your existing renderer.js with this file (backup first).

(function () {
  const LAST_SRC_KEY = 'ps5vault.lastSource';
  const LAST_DST_KEY = 'ps5vault.lastDest';

  const $ = id => document.getElementById(id);
  const log = (...a) => console.log('[renderer]', ...a);
  const err = (...a) => console.error('[renderer]', ...a);

  function escapeHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function fileUrl(p) {
    if (!p) return '';
    const s = String(p);
    if (/^file:\/\//i.test(s)) return s;
    if (/^[A-Za-z]:[\\/]/.test(s)) {
      const win = s.replace(/\\/g, '/');
      return 'file:///' + encodeURI(win).replace(/#/g, '%23');
    }
    if (s.startsWith('/')) return 'file://' + encodeURI(s).replace(/#/g, '%23');
    return s.replace(/^[\\/]+/, '');
  }

  function normalizeDisplayPath(p) {
    if (!p) return '';
    try {
      let s = String(p).trim();
      if (!s) return s;
      const hasBack = s.indexOf('\\') !== -1;
      const parts = s.split(/[\\/]+/);
      if (parts.length > 0 && parts[parts.length - 1].toLowerCase() === 'sce_sys') {
        parts.pop();
        const sep = hasBack ? '\\' : '/';
        const out = parts.join(sep);
        return out || (hasBack ? parts[0] + '\\' : '/');
      }
      return s;
    } catch (e) { return p; }
  }

  function pathEndsWithSceSys(rawPath) {
    if (!rawPath) return false;
    try {
      const s = String(rawPath).trim();
      return /(?:[\\/]|^)(sce_sys)$/i.test(s);
    } catch (e) { return false; }
  }

  window.__ps5_lastRenderedItems = [];

  // UI overlay helpers (full UI lock)
  let uiOverlay = null;
  function createOverlayIfMissing() {
    if (uiOverlay) return;
    uiOverlay = document.createElement('div');
    uiOverlay.style.position = 'fixed';
    uiOverlay.style.inset = '0';
    uiOverlay.style.background = 'rgba(0,0,0,0.35)';
    uiOverlay.style.zIndex = '11000';
    uiOverlay.style.display = 'none';
    uiOverlay.style.pointerEvents = 'none';
    uiOverlay.id = '__ps5_ui_overlay';
    document.body.appendChild(uiOverlay);
  }
  function disableUI() {
    createOverlayIfMissing();
    uiOverlay.style.display = 'block';
    uiOverlay.style.pointerEvents = 'auto';
    Array.from(document.querySelectorAll('button, input, select, a')).forEach(el => {
      el._prevDisabled = el.disabled || false;
      try { el.disabled = true; } catch (e) {}
      try { el.setAttribute && el.setAttribute('aria-disabled', 'true'); } catch (e) {}
      if (el.tagName === 'A') el.style.pointerEvents = 'none';
    });
  }
  function enableUI() {
    if (!uiOverlay) return;
    uiOverlay.style.display = 'none';
    uiOverlay.style.pointerEvents = 'none';
    Array.from(document.querySelectorAll('button, input, select, a')).forEach(el => {
      try { el.disabled = !!el._prevDisabled; } catch (e) {}
      try { el.removeAttribute && el.removeAttribute('aria-disabled'); } catch (e) {}
      try { delete el._prevDisabled; } catch (e) {}
      if (el.tagName === 'A') el.style.pointerEvents = '';
    });
  }

  // Preview popup
  const preview = {
    container: null,
    img: null,
    visible: false,
    offsetX: 18,
    offsetY: 18,
    init() {
      this.container = $('imgPreview');
      this.img = $('imgPreviewImg');
      if (!this.container || !this.img) return;
      this.container.style.display = 'none';
      this.container.style.pointerEvents = 'none';
    },
    show(src, clientX = 0, clientY = 0) {
      if (!this.container || !this.img) return;
      this.img.src = src;
      this.container.style.display = 'block';
      this.container.setAttribute('aria-hidden', 'false');
      this.visible = true;
      this.move(clientX, clientY);
    },
    move(clientX = 0, clientY = 0) {
      if (!this.container || !this.visible) return;
      const cw = this.container.offsetWidth;
      const ch = this.container.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = clientX + this.offsetX;
      let top = clientY + this.offsetY;
      if (left + cw > vw - 8) left = Math.max(8, clientX - cw - this.offsetX);
      if (top + ch > vh - 8) top = Math.max(8, clientY - ch - this.offsetY);
      this.container.style.left = `${left}px`;
      this.container.style.top = `${top}px`;
    },
    hide() {
      if (!this.container) return;
      this.container.style.display = 'none';
      this.container.setAttribute('aria-hidden', 'true');
      this.visible = false;
      this.img.src = '';
    }
  };

  function showToast(msg, ms = 2500) {
    const t = $('toast'); if (!t) { console.log(msg); return; }
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(t._t); t._t = setTimeout(()=> t.style.display = 'none', ms);
  }

  // Progress/ETA state
  const progressState = {
    totalBytes: 0,
    totalBytesCopied: 0,
    totalFiles: 0,
    startTime: null,
    bytesHistory: [],
    avgSpeed: null,
    _lastSpeedSample: null,
    _lastEtaUpdate: 0
  };

  function resetProgressState() {
    progressState.totalBytes = 0;
    progressState.totalBytesCopied = 0;
    progressState.totalFiles = 0;
    progressState.startTime = null;
    progressState.bytesHistory = [];
    progressState.avgSpeed = null;
    progressState._lastSpeedSample = null;
    progressState._lastEtaUpdate = 0;
  }

  function updateBytesHistory(now, bytes) {
    progressState.bytesHistory.push({t: now, bytes});
    if (progressState.bytesHistory.length > 12) progressState.bytesHistory.shift();

    try {
      const sampleIntervalMs = 700;
      const last = progressState._lastSpeedSample;
      if (!last || (now - last.t) >= sampleIntervalMs) {
        if (last && now > last.t && typeof last.bytes === 'number') {
          const deltaBytes = bytes - last.bytes;
          const deltaTimeSec = (now - last.t) / 1000;
          if (deltaTimeSec > 0 && deltaBytes >= 0) {
            const instSpeed = deltaBytes / deltaTimeSec;
            const alpha = 0.25;
            if (!progressState.avgSpeed || !isFinite(progressState.avgSpeed) || progressState.avgSpeed <= 0) {
              progressState.avgSpeed = instSpeed;
            } else {
              progressState.avgSpeed = (alpha * instSpeed) + ((1 - alpha) * progressState.avgSpeed);
            }
          }
        }
        progressState._lastSpeedSample = { t: now, bytes };
      }
    } catch (e) { console.warn('updateBytesHistory smoothing failed', e); }
  }

  function formatSeconds(seconds) {
    if (!isFinite(seconds) || seconds < 0) return null;
    if (seconds >= 3600) {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      return (h > 0) ? `${h}h ${m}m` : `${m}m 0s`;
    }
    const mm = Math.floor(seconds / 60);
    const ss = seconds % 60;
    return `${mm}m ${ss}s`;
  }

  function estimateETA() {
    try {
      const speed = progressState.avgSpeed;
      if (speed && isFinite(speed) && speed > 16) {
        const remaining = Math.max(0, (progressState.totalBytes || 0) - (progressState.totalBytesCopied || 0));
        if (remaining <= 0) return '0m 0s';
        const seconds = Math.ceil(remaining / speed);
        return formatSeconds(seconds);
      }

      const h = progressState.bytesHistory;
      if (h.length >= 2) {
        const first = h[0], last = h[h.length - 1];
        const deltaBytes = last.bytes - first.bytes;
        const deltaTime = (last.t - first.t) / 1000.0;
        if (deltaTime >= 2 && deltaBytes > 0) {
          const instSpeed = deltaBytes / deltaTime;
          const remaining = Math.max(0, (progressState.totalBytes || 0) - (progressState.totalBytesCopied || 0));
          const seconds = Math.ceil(remaining / instSpeed);
          return formatSeconds(seconds);
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  // Single total progress helpers
  function setTotalProgressPercent(pct) {
    const totalBar = $('actionTotalProgressBar');
    const totalPercent = $('totalPercent');
    if (totalBar) totalBar.style.width = `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
    if (totalPercent) totalPercent.textContent = `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
  }

  function showOnlyTotalProgressUI() {
    const fileLabel = $('fileProgressLabel'); const fileBar = $('actionFileProgressBar');
    if (fileLabel) fileLabel.style.display = 'none';
    if (fileBar) fileBar.style.display = 'none';
    const actionScanProgress = $('actionScanProgress');
    if (actionScanProgress) actionScanProgress.style.display = 'flex';
  }
  function restoreFileProgressUI() {
    const fileLabel = $('fileProgressLabel'); const fileBar = $('actionFileProgressBar');
    if (fileLabel) fileLabel.style.display = '';
    if (fileBar) fileBar.style.display = '';
  }

  // Handle progress events (only total)
  function onProgressMessage(d) {
    if (!d || !d.type) return;
    const etaLabel = $('etaLabel');
    if (d.type === 'go-start') {
      resetProgressState();
      progressState.totalFiles = d.totalFiles || 0;
      progressState.totalBytes = d.totalBytes || 0;
      progressState.totalBytesCopied = 0;
      progressState.startTime = Date.now();
      progressState.bytesHistory = [{t: progressState.startTime, bytes: 0}];
      showOnlyTotalProgressUI();
      disableUI();
      setTotalProgressPercent(0);
      if (etaLabel) etaLabel.textContent = 'ETA: —';
      return;
    }

    if (d.type === 'go-file-progress' || d.type === 'go-file-complete') {
      progressState.totalBytesCopied = d.totalBytesCopied || progressState.totalBytesCopied;
      const now = Date.now();
      updateBytesHistory(now, progressState.totalBytesCopied);
      const totalPct = progressState.totalBytes > 0 ? (progressState.totalBytesCopied / progressState.totalBytes) * 100 : 0;
      setTotalProgressPercent(totalPct);
      const eta = estimateETA();
      const nowMs = Date.now();
      const minUpdateInterval = 800;
      if ((nowMs - (progressState._lastEtaUpdate || 0)) >= minUpdateInterval) {
        if (etaLabel) etaLabel.textContent = `ETA: ${eta || '—'}`;
        progressState._lastEtaUpdate = nowMs;
      }
      return;
    }

    if (d.type === 'go-complete') {
      setTotalProgressPercent(100);
      if (etaLabel) etaLabel.textContent = 'ETA: 0m 0s';
      setTimeout(() => { enableUI(); hideProgress(); }, 800);
      return;
    }

    if (d.type === 'scan' || d.type === 'go-item') {
      const label = $('currentScanLabel');
      const raw = d.folder || d.path || '';
      if (label) {
        if (pathEndsWithSceSys(raw)) label.textContent = ''; else label.textContent = normalizeDisplayPath(raw) || '';
      }
    }
  }

  function hideProgress() {
    const p = $('actionScanProgress'); if (p) p.style.display = 'none';
    setTotalProgressPercent(0);
    const etaLabel = $('etaLabel'); if (etaLabel) etaLabel.textContent = 'ETA: —';
    resetProgressState();
    restoreFileProgressUI();
  }

  function attachPreviewHandlers(imgEl, srcFallback) {
    if (!imgEl) return;
    let currentSrc = imgEl.src || srcFallback || '';
    const onEnter = (ev) => {
      currentSrc = imgEl.getAttribute('data-fullsrc') || imgEl.src || srcFallback || '';
      if (!currentSrc) return;
      preview.show(currentSrc, ev.clientX, ev.clientY);
    };
    const onMove = (ev) => { if (!preview.visible) return; preview.move(ev.clientX, ev.clientY); };
    const onLeave = () => preview.hide();

    imgEl.addEventListener('mouseenter', onEnter);
    imgEl.addEventListener('mousemove', onMove);
    imgEl.addEventListener('mouseleave', onLeave);
    imgEl.addEventListener('click', onLeave);
  }

  function renderResults(arr) {
    const tbody = $('resultsBody'); if (!tbody) return;
    tbody.innerHTML = '';
    const list = Array.isArray(arr) ? arr.slice() : [];
    window.__ps5_lastRenderedItems = list;

    list.sort((a,b) => {
      const sa = String((a && (a.displayTitle||a.dbTitle||a.folderName))||'').toLowerCase();
      const sb = String((b && (b.displayTitle||b.dbTitle||b.folderName))||'').toLowerCase();
      return sa.localeCompare(sb);
    });
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="4" style="color:var(--muted);padding:12px">No validated entries found.</td></tr>`;
      $('scanCount') && ($('scanCount').textContent = '');
      return;
    }
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const tr = document.createElement('tr');
      tr.dataset.selectable = '1';
      tr.dataset.index = String(i);

      const tdChk = document.createElement('td'); tdChk.style.verticalAlign = 'middle';
      const chk = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'chk';
      tdChk.appendChild(chk); tr.appendChild(tdChk);

      const tdCover = document.createElement('td'); tdCover.className = 'cover';
      const wrap = document.createElement('div'); wrap.style.display='flex'; wrap.style.flexDirection='column'; wrap.style.alignItems='center';
      const img = document.createElement('img');
      img.className = 'thumb';
      img.alt = r.displayTitle || 'cover';

      if (r.iconPath) {
        const src = fileUrl(r.iconPath);
        img.src = src;
        img.setAttribute('data-fullsrc', src);
        img.addEventListener('error', () => { img.style.display = 'none'; });
        wrap.appendChild(img);
        attachPreviewHandlers(img, src);
      } else {
        const brand = $('brandLogo');
        if (brand && brand.src) {
          img.src = brand.src;
          img.setAttribute('data-fullsrc', brand.src);
          wrap.appendChild(img);
          attachPreviewHandlers(img, brand.src);
        } else {
          const ph = document.createElement('div');
          ph.style.width = 'var(--thumb-size)';
          ph.style.height = 'var(--thumb-size)';
          ph.style.background = 'rgba(255,255,255,0.02)';
          ph.style.borderRadius = 'var(--thumb-radius)';
          wrap.appendChild(ph);
        }
      }
      tdCover.appendChild(wrap); tr.appendChild(tdCover);

      const tdGame = document.createElement('td'); tdGame.className = 'game';
      const title = document.createElement('div'); title.className = 'title-main'; title.textContent = r.displayTitle || r.dbTitle || r.folderName || '';
      const sub = document.createElement('div'); sub.className = 'title-sub'; sub.textContent = r.contentId || r.skuFromParam || '';
      tdGame.appendChild(title); tdGame.appendChild(sub); tr.appendChild(tdGame);

      const tdFolder = document.createElement('td'); tdFolder.className = 'folder';
      const fp = r.ppsaFolderPath || r.folderPath || r.contentFolderPath || '';
      const displayFp = normalizeDisplayPath(fp);
      const fpDiv = document.createElement('div'); fpDiv.title = displayFp; fpDiv.style.color = 'var(--muted)'; fpDiv.textContent = displayFp;
      tdFolder.appendChild(fpDiv); tr.appendChild(tdFolder);

      tr.addEventListener('click', (ev) => {
        if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'LABEL' || ev.target.classList.contains('thumb'))) return;
        chk.checked = !chk.checked;
        if (chk.checked) tr.classList.add('row-selected'); else tr.classList.remove('row-selected');
        updateHeaderCheckboxState();
      });
      chk.addEventListener('change', (ev) => {
        if (ev.target.checked) tr.classList.add('row-selected'); else tr.classList.remove('row-selected');
        updateHeaderCheckboxState();
      });

      tbody.appendChild(tr);
    }
    $('scanCount') && ($('scanCount').textContent = `${list.length} games found`);
    updateHeaderCheckboxState();
  }

  function updateHeaderCheckboxState() {
    const header = $('chkHeader'); if (!header) return;
    const visible = Array.from(document.querySelectorAll('#resultsBody tr')).filter(tr => tr.offsetParent !== null);
    if (!visible.length) { header.checked = false; header.indeterminate = false; return; }
    const checked = visible.filter(tr => tr.querySelector('input[type="checkbox"]').checked).length;
    if (checked === 0) { header.checked = false; header.indeterminate = false; }
    else if (checked === visible.length) { header.checked = true; header.indeterminate = false; }
    else { header.checked = false; header.indeterminate = true; }
  }

  function toggleHeaderSelect(checked) {
    const visible = Array.from(document.querySelectorAll('#resultsBody tr')).filter(tr => tr.offsetParent !== null);
    for (const tr of visible) {
      const cb = tr.querySelector('input[type="checkbox"]');
      if (!cb) continue;
      cb.checked = !!checked;
      if (cb.checked) tr.classList.add('row-selected'); else tr.classList.remove('row-selected');
    }
    updateHeaderCheckboxState();
  }

  function findSelectedRows() {
    const tbody = $('resultsBody'); if (!tbody) return [];
    const trs = Array.from(tbody.querySelectorAll('tr'));
    const selected = [];
    for (const tr of trs) {
      const cb = tr.querySelector('input[type="checkbox"]'); if (!cb || !cb.checked) continue;
      const idx = tr.dataset.index ? parseInt(tr.dataset.index,10) : NaN;
      let item = null;
      if (!Number.isNaN(idx) && window.__ps5_lastRenderedItems && window.__ps5_lastRenderedItems[idx]) {
        const orig = window.__ps5_lastRenderedItems[idx];
        item = {
          displayTitle: orig.displayTitle || orig.dbTitle || orig.folderName || '',
          contentFolderPath: orig.contentFolderPath || orig.folderPath || '',
          folderPath: orig.folderPath || orig.contentFolderPath || '',
          folderName: orig.folderName || '',
          ppsa: orig.ppsa || null,
          paramPath: orig.paramPath || null,
          contentId: orig.contentId || null,
          iconPath: orig.iconPath || null,
          dbTitle: orig.dbTitle || null,
          skuFromParam: orig.skuFromParam || null
        };
      } else {
        const title = (tr.querySelector('.title-main') && tr.querySelector('.title-main').textContent) || '';
        const folderNode = tr.querySelector('td.folder'); const folder = folderNode ? (folderNode.textContent || folderNode.innerText || '') : '';
        let p = (folder || '') + ''; p = p.replace(/[\/\\]+$/,''); if (p.toLowerCase().endsWith('/sce_sys')||p.toLowerCase().endsWith('\\sce_sys')||p.toLowerCase().endsWith('sce_sys')) p = p.replace(/[/\\]sce_sys$/i,'');
        item = { displayTitle: title, contentFolderPath: p, folderPath: p, ppsa: null, paramPath: null, contentId: null, folderName: title || (p.split(/[\\/]/).pop() || '') };
      }
      selected.push(item);
    }
    return selected;
  }

  function sanitizeName(n) { return String(n || '').replace(/[<>:"/\\|?*\x00-\x1F]/g,'').trim().slice(0,200) || 'Unknown'; }

  function computeFinalTargetForItem(it, dest, layout) {
    const safeGame = sanitizeName(it.displayTitle || it.dbTitle || it.folderName || it.ppsa || 'Unknown Game');
    let finalPpsaName = null;
    if (it.ppsa) finalPpsaName = it.ppsa;
    if (!finalPpsaName && it.contentId) {
      const m = String(it.contentId).match(/PPSA\d{4,6}/i);
      if (m) finalPpsaName = m[0].toUpperCase();
    }
    if (!finalPpsaName) {
      const src = it.contentFolderPath || it.ppsaFolderPath || it.folderPath || '';
      const base = (src + '').split(/[\\/]/).pop() || '';
      finalPpsaName = (base || '').replace(/[-_]?app\d*$/i, '').replace(/[-_]+$/,'') || base || 'PPSA';
    }

    if (layout === 'ppsa-only') return pathJoin(dest, finalPpsaName);
    if (layout === 'game-only') return pathJoin(dest, safeGame);
    if (layout === 'etahen') return pathJoin(dest, 'etaHEN', 'games', safeGame);
    if (layout === 'itemzflow') return pathJoin(dest, 'games', safeGame);
    return pathJoin(dest, safeGame, finalPpsaName);
  }

  function pathJoin(...parts){ 
    const sep = (parts.join('/').indexOf('\\') !== -1) ? '\\' : '/';
    return parts.filter(Boolean).map((p,i)=> {
      if (i===0) return String(p).replace(/[\/\\]+$/,'');
      return String(p).replace(/^[\/\\]+|[\/\\]+$/g,'');
    }).join(sep);
  }

  // Confirm modal: use existing or create fallback
  async function showConfirm(items, dest, action, layout) {
    let backdrop = $('confirmModalBackdrop');
    let list = $('confirmList');
    let yes = $('confirmYes');
    let no = $('confirmNo');

    if (!backdrop || !list || !yes || !no) {
      backdrop = document.createElement('div'); backdrop.id = 'confirmModalBackdrop'; backdrop.className = 'modal-backdrop'; backdrop.setAttribute('aria-hidden','true'); backdrop.style.display = 'none';
      const modal = document.createElement('div'); modal.className = 'modal'; modal.setAttribute('role','dialog'); modal.setAttribute('aria-modal','true');
      const header = document.createElement('div'); header.className = 'modal-header';
      const h4 = document.createElement('h4'); h4.id = 'confirmTitle'; h4.textContent = 'Confirm transfer';
      header.appendChild(h4);
      const body = document.createElement('div'); body.className = 'modal-body';
      list = document.createElement('div'); list.id = 'confirmList';
      body.appendChild(list);
      const actions = document.createElement('div'); actions.className = 'modal-actions';
      no = document.createElement('button'); no.className = 'btn'; no.id = 'confirmNo'; no.textContent = 'Cancel';
      yes = document.createElement('button'); yes.className = 'btn-go'; yes.id = 'confirmYes'; yes.textContent = 'Yes — proceed';
      actions.appendChild(no); actions.appendChild(yes);
      modal.appendChild(header); modal.appendChild(body); modal.appendChild(actions);
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);
      backdrop = $('confirmModalBackdrop'); list = $('confirmList'); yes = $('confirmYes'); no = $('confirmNo');
    }

    list.innerHTML = '';
    const summary = document.createElement('div');
    summary.style.color = 'var(--muted)'; summary.style.fontSize = '13px'; summary.style.marginBottom = '8px';
    summary.textContent = `Action: ${action} • Layout: ${layout} • Destination: ${dest}`;
    list.parentNode.insertBefore(summary, list);

    for (const it of items) {
      const fromRaw = it.contentFolderPath || it.folderPath || '';
      const from = normalizeDisplayPath(fromRaw);
      const to = computeFinalTargetForItem(it, dest || '', layout || 'game-ppsa');

      const entry = document.createElement('div'); entry.className = 'modal-content-entry';
      const left = document.createElement('div'); left.className = 'entry-left';
      const title = document.createElement('div'); title.className = 'entry-title'; title.textContent = it.displayTitle || it.folderName || '';

      const fromDiv = document.createElement('div'); fromDiv.className = 'path-box';
      fromDiv.innerHTML = '<span class="label-bold">From:</span> ' + escapeHtml(from);

      const toDiv = document.createElement('div'); toDiv.className = 'path-box';
      toDiv.innerHTML = '<span class="label-bold">To:</span> ' + escapeHtml(to);

      left.appendChild(title); left.appendChild(fromDiv); left.appendChild(toDiv);
      entry.appendChild(left);
      list.appendChild(entry);
    }

    backdrop.style.display = 'flex';
    backdrop.setAttribute('aria-hidden', 'false');

    return await new Promise((resolve) => {
      function cleanup(){ try { summary.remove(); } catch(e){} backdrop.style.display = 'none'; backdrop.setAttribute('aria-hidden', 'true'); yes.removeEventListener('click', onYes); no.removeEventListener('click', onNo); document.removeEventListener('keydown', onKey); }
      function onYes(){ cleanup(); resolve(true); }
      function onNo(){ cleanup(); resolve(false); }
      function onKey(e) { if (e.key === 'Escape') { cleanup(); resolve(false); } }
      yes.addEventListener('click', onYes); no.addEventListener('click', onNo);
      document.addEventListener('keydown', onKey);
    });
  }

  // Conflict modal: fallback creation if missing
  async function checkTargetsAndAsk(items, dest, layout) {
    const targets = items.map(it => computeFinalTargetForItem(it, dest, layout));
    let existsInfo = [];
    try {
      if (window.ppsaApi && typeof window.ppsaApi.checkPathsExist === 'function') {
        existsInfo = await window.ppsaApi.checkPathsExist(targets);
      }
    } catch (e) {
      err('checkPathsExist failed', e);
      existsInfo = targets.map(t => ({ path: t, exists: false, error: String(e) }));
    }
    const conflicts = (existsInfo || []).filter(i => i && i.exists).map(i => i.path);
    if (!conflicts.length) return { proceed: true, overwriteMode: 'rename' };

    let modal = $('conflictModalBackdrop');
    let listEl = $('conflictList');
    let cancelBtn = $('conflictCancel');
    let proceedBtn = $('conflictProceed');

    if (!modal || !listEl || !cancelBtn || !proceedBtn) {
      modal = document.createElement('div'); modal.id = 'conflictModalBackdrop'; modal.className = 'modal-backdrop'; modal.style.display = 'none';
      const m = document.createElement('div'); m.className = 'modal'; m.setAttribute('role','dialog'); m.setAttribute('aria-modal','true');
      const header = document.createElement('div'); header.className = 'modal-header'; const h = document.createElement('h4'); h.id = 'conflictTitle'; h.textContent = 'Conflicting targets detected';
      header.appendChild(h);
      const body = document.createElement('div'); body.className = 'modal-body'; body.style.color = 'var(--muted)';
      listEl = document.createElement('div'); listEl.id = 'conflictList'; listEl.style.marginBottom = '12px';
      body.appendChild(listEl);
      const opts = document.createElement('div'); opts.style.marginTop = '8px'; opts.style.display='flex'; opts.style.gap='12px'; opts.style.flexDirection='column';
      const overwrite = document.createElement('label'); overwrite.innerHTML = `<input type="radio" name="conflictAction" value="overwrite"> Overwrite existing targets`;
      const skip = document.createElement('label'); skip.innerHTML = `<input type="radio" name="conflictAction" value="skip"> Skip items with existing targets`;
      const rename = document.createElement('label'); rename.innerHTML = `<input type="radio" name="conflictAction" value="rename" checked> Rename conflicting targets (keep originals)`;
      opts.appendChild(overwrite); opts.appendChild(skip); opts.appendChild(rename);
      body.appendChild(opts);
      const actions = document.createElement('div'); actions.className = 'modal-actions';
      cancelBtn = document.createElement('button'); cancelBtn.id = 'conflictCancel'; cancelBtn.className = 'btn'; cancelBtn.textContent = 'Cancel';
      proceedBtn = document.createElement('button'); proceedBtn.id = 'conflictProceed'; proceedBtn.className = 'btn-go'; proceedBtn.textContent = 'Proceed';
      actions.appendChild(cancelBtn); actions.appendChild(proceedBtn);
      m.appendChild(header); m.appendChild(body); m.appendChild(actions);
      modal.appendChild(m); document.body.appendChild(modal);
      modal = $('conflictModalBackdrop'); listEl = $('conflictList'); cancelBtn = $('conflictCancel'); proceedBtn = $('conflictProceed');
    }

    listEl.innerHTML = '';
    for (const p of conflicts) {
      const d = document.createElement('div'); d.style.fontFamily = 'ui-monospace, Menlo, Monaco, monospace'; d.style.marginBottom = '6px'; d.textContent = p;
      listEl.appendChild(d);
    }
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');

    return await new Promise((resolve) => {
      function cleanup() {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
        cancelBtn.removeEventListener('click', onCancel);
        proceedBtn.removeEventListener('click', onProceed);
        document.removeEventListener('keydown', onKey);
      }
      function onCancel() { cleanup(); resolve({ proceed: false, overwriteMode: 'cancel' }); }
      function onProceed() {
        const radios = document.querySelectorAll('input[name="conflictAction"]');
        let selected = 'rename';
        for (const r of radios) if (r.checked) { selected = r.value; break; }
        cleanup();
        resolve({ proceed: true, overwriteMode: selected });
      }
      function onKey(e) { if (e.key === 'Escape') { cleanup(); resolve({ proceed: false, overwriteMode: 'cancel' }); } }
      cancelBtn.addEventListener('click', onCancel);
      proceedBtn.addEventListener('click', onProceed);
      document.addEventListener('keydown', onKey);
    });
  }

  // Main GO handler
  async function goClickHandler() {
    const items = findSelectedRows();
    if (!items.length) { showToast('No items selected'); return; }
    const dest = $('destPath') && $('destPath').value ? $('destPath').value.trim() : '';
    if (!dest) { showToast('Select destination'); return; }
    try { localStorage.setItem(LAST_DST_KEY, dest); } catch (e) {}
    const action = $('action') ? $('action').value : 'move';
    const layout = $('layout') ? $('layout').value : 'etahen';

    let ok;
    try { ok = await showConfirm(items, dest, action, layout); } catch (e) { log('confirm err', e); showOverlayError('Confirm error', 'Could not show confirm dialog. Operation cancelled.'); return; }
    if (!ok) { showToast('Cancelled'); return; }

    let conflictDecision = { proceed: true, overwriteMode: 'rename' };
    try { conflictDecision = await checkTargetsAndAsk(items, dest, layout); } catch (e) { err('checkTargets error', e); showToast('Could not verify targets. Aborting.'); return; }
    if (!conflictDecision.proceed) { showToast('Cancelled by user'); return; }
    const overwriteMode = conflictDecision.overwriteMode || 'rename';

    if (!window.ppsaApi || typeof window.ppsaApi.ensureAndPopulate !== 'function') { showOverlayError('Backend missing', 'ensureAndPopulate API not available (preload).'); return; }

    disableUI();
    showOnlyTotalProgressUI();
    resetProgressState();

    const goBtn = $('btnGoBig'); const orig = goBtn ? goBtn.textContent : '';
    try {
      if (goBtn) { goBtn.disabled = true; goBtn.textContent = 'Working...'; }
      const res = await window.ppsaApi.ensureAndPopulate({ items, dest, action, layout, overwriteMode });
      if (!res) { showOverlayError('Operation failed', 'No response from backend'); return; }
      if (res.error) { showOverlayError('Operation error', res.error, JSON.stringify(res, null, 2)); return; }

      const rb = $('resultModalBackdrop'); const rl = $('resultList'); const rs = $('resultSubText'); const rc = $('resultCount');

      if (rb && rl && rs && rc) {
        rl.innerHTML = ''; let moved=0,copied=0,errors=0, total = 0;

        for (const r of res.results || []) {
          total++;
          let badgeText = '';
          if (r.moved) { badgeText = 'moved'; }
          else if (r.copied) { badgeText = 'copied'; }
          else if (r.error) { badgeText = 'error'; }

          const entry = document.createElement('div');
          entry.className = 'modal-content-entry';
          Object.assign(entry.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', paddingTop: '8px', paddingBottom: '8px', borderBottom: '1px solid rgba(255,255,255,0.02)' });

          const left = document.createElement('div');
          left.style.flex = '1';
          const title = document.createElement('div'); title.className = 'entry-title'; title.textContent = r.item || '';
          left.appendChild(title);

          const fromRaw = r.source || r.from || '';
          const from = normalizeDisplayPath(fromRaw);
          const to = r.target || computeFinalTargetForItem({ displayTitle: r.item }, dest, layout);

          const row = document.createElement('div'); row.className = 'path-row';
          row.style.marginTop = '6px';
          const fromInline = document.createElement('div'); fromInline.className = 'path-inline';
          fromInline.innerHTML = '<span class="label-bold">From:</span> ' + escapeHtml(from || '');
          const toInline = document.createElement('div'); toInline.className = 'path-inline';
          toInline.innerHTML = '<span class="label-bold">To:</span> ' + escapeHtml(to || '');
          row.appendChild(fromInline);
          row.appendChild(toInline);
          left.appendChild(row);

          // Right side: per-row status button
          const right = document.createElement('div');
          right.style.flex = '0 0 auto';
          right.style.display = 'flex';
          right.style.alignItems = 'center';
          right.style.justifyContent = 'flex-end';

          if (badgeText) {
            const statusBtn = document.createElement('button');
            if (badgeText === 'moved' || badgeText === 'copied') statusBtn.className = 'btn-go';
            else statusBtn.className = 'btn';
            statusBtn.textContent = badgeText;
            statusBtn.disabled = true;
            statusBtn.style.pointerEvents = 'none';
            statusBtn.style.fontSize = '12px';
            statusBtn.style.padding = '6px 10px';
            right.appendChild(statusBtn);
          }

          entry.appendChild(left);
          entry.appendChild(right);
          rl.appendChild(entry);

          if (r.moved) moved++; if (r.copied) copied++; if (r.error) errors++;
        }

        const summaryParts = [];
        if (copied) summaryParts.push(`${copied} copied`);
        if (moved) summaryParts.push(`${moved} moved`);
        if (errors) summaryParts.push(`${errors} errors`);
        rs.textContent = summaryParts.length ? summaryParts.join(' • ') : 'Operation complete';
        rc.textContent = String(total);
        rb.style.display = 'flex'; rb.setAttribute('aria-hidden', 'false');
      } else {
        showToast('Operation complete');
      }
    } catch (e) {
      err('ensureAndPopulate error', e);
      showOverlayError('Operation exception', 'ensureAndPopulate threw', e && e.stack ? e.stack : String(e));
    } finally {
      if (goBtn) { goBtn.disabled = false; goBtn.textContent = orig; }
      setTimeout(() => { enableUI(); hideProgress(); }, 800);
    }
  }

  function showOverlayError(title, message, details = '') {
    try {
      const existing = $('__ps5_error_modal_backdrop');
      if (existing) existing.remove();

      const backdrop = document.createElement('div'); backdrop.id = '__ps5_error_modal_backdrop'; backdrop.className = 'modal-backdrop'; backdrop.style.display = 'flex'; backdrop.setAttribute('aria-hidden','false');

      const modal = document.createElement('div'); modal.className = 'modal'; modal.setAttribute('role','dialog'); modal.setAttribute('aria-modal','true');
      const header = document.createElement('div'); header.className = 'modal-header';
      const h = document.createElement('h4'); h.textContent = title || 'Error'; header.appendChild(h);

      const body = document.createElement('div'); body.className = 'modal-body';
      const p = document.createElement('div'); p.textContent = message || ''; p.style.color = 'var(--muted)';
      body.appendChild(p);
      if (details) {
        const pre = document.createElement('pre'); pre.textContent = details; Object.assign(pre.style, { maxHeight:'320px', overflow:'auto', background:'rgba(255,255,255,0.02)', padding:'8px', borderRadius:'6px', marginTop:'8px', color:'#cfe7ff' });
        body.appendChild(pre);
      }

      const actions = document.createElement('div'); actions.className = 'modal-actions';
      const btnClose = document.createElement('button'); btnClose.className = 'btn'; btnClose.textContent = 'Close'; btnClose.addEventListener('click', ()=> backdrop.remove());
      actions.appendChild(btnClose);

      modal.appendChild(header); modal.appendChild(body); modal.appendChild(actions);
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);

      function onKey(e) { if (e.key === 'Escape') backdrop.remove(); }
      function onBackdropClick(e) { if (e.target === backdrop) backdrop.remove(); }
      document.addEventListener('keydown', onKey);
      backdrop.addEventListener('click', onBackdropClick);

      const obs = new MutationObserver(() => {
        if (!document.body.contains(backdrop)) {
          document.removeEventListener('keydown', onKey);
          backdrop.removeEventListener('click', onBackdropClick);
          obs.disconnect();
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    } catch (e) {
      try { console.error(title, message, details); } catch {}
    }
  }

  // DOM wiring
  document.addEventListener('DOMContentLoaded', () => {
    try {
      preview.init();
      createOverlayIfMissing();

      const brandImg = $('brandLogo');
      const brandFallback = $('brandLogoFallback');
      if (brandImg) {
        brandImg.addEventListener('error', () => { try { brandImg.style.display = 'none'; if (brandFallback) brandFallback.style.display = 'block'; } catch(e){} });
        brandImg.addEventListener('load', () => { try { if (brandFallback) brandFallback.style.display = 'none'; brandImg.style.display = 'block'; } catch(e){} });
      }

      const ls = localStorage.getItem(LAST_SRC_KEY); if (ls && $('sourcePath') && !$('sourcePath').value) $('sourcePath').value = ls;
      const ld = localStorage.getItem(LAST_DST_KEY); if (ld && $('destPath') && !$('destPath').value) $('destPath').value = ld;

      // defaults
      try {
        const actionSel = $('action'); if (actionSel) actionSel.value = 'move';
        const layoutSel = $('layout'); if (layoutSel) layoutSel.value = 'etahen';
      } catch (e) {}

    } catch(e){ console.error(e) }

    // Discord
    const discordEl = $('discordLink');
    if (discordEl) {
      discordEl.addEventListener('click', (ev) => {
        ev.preventDefault();
        const username = 'nookie_65120';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(username).then(() => { showToast(`Discord username copied: ${username}`); }).catch(() => { showToast(`Discord: ${username}`); });
        } else {
          try { const ta = document.createElement('textarea'); ta.value = username; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); showToast(`Discord username copied: ${username}`); } catch (e) { showToast(`Discord: ${username}`); }
        }
        try { window.open(`https://discord.com/users/${username}`, '_blank'); } catch(e){}
      });
    }

    // Pickers
    $('btnPickSource')?.addEventListener('click', async () => {
      if (!window.ppsaApi || typeof window.ppsaApi.pickDirectory !== 'function') { showToast('Picker not available'); return; }
      const p = await window.ppsaApi.pickDirectory(); if (p) { $('sourcePath').value = p; try { localStorage.setItem(LAST_SRC_KEY, p); } catch(e) {} }
    });
    $('btnPickDest')?.addEventListener('click', async () => {
      if (!window.ppsaApi || typeof window.ppsaApi.pickDirectory !== 'function') { showToast('Picker not available'); return; }
      const p = await window.ppsaApi.pickDirectory(); if (p) { $('destPath').value = p; try { localStorage.setItem(LAST_DST_KEY, p); } catch(e) {} }
    });

    // Scan
    $('btnScan')?.addEventListener('click', async () => {
      const src = $('sourcePath') && $('sourcePath').value ? $('sourcePath').value.trim() : '';
      if (!src) { showToast('Select source first'); return; }
      try { localStorage.setItem(LAST_SRC_KEY, src); } catch(e){}
      try {
        if (!window.ppsaApi || typeof window.ppsaApi.scanSourceForPpsa !== 'function') { showOverlayError('Backend missing','scanSourceForPpsa not available'); hideProgress(); return; }
        if (window.ppsaApi && typeof window.ppsaApi.onScanProgress === 'function') window.ppsaApi.onScanProgress(onProgressMessage);
        const res = await window.ppsaApi.scanSourceForPpsa(src);
        if (!res) { showToast('Scan returned no results'); hideProgress(); return; }
        if (res.error) { showOverlayError('Scan error', res.error); hideProgress(); return; }
        const arr = Array.isArray(res) ? res : (Array.isArray(res.items) ? res.items : []);
        renderResults(arr);
      } catch (e) {
        err('scan exception', e);
        showOverlayError('Scan exception', 'An error occurred during scan', e && e.stack ? e.stack : String(e));
      } finally { hideProgress(); }
    });

    // GO
    const goBtn = $('btnGoBig');
    if (goBtn) {
      try { const clone = goBtn.cloneNode(true); goBtn.parentNode.replaceChild(clone, goBtn); clone.addEventListener('click', goClickHandler); }
      catch (e) { goBtn.addEventListener('click', goClickHandler); }
    }

    // selection helpers
    $('btnSelectAll')?.addEventListener('click', () => {
      const inputs = Array.from(document.querySelectorAll('#resultsBody input[type="checkbox"]'));
      inputs.forEach(i=>{ i.checked=true; i.closest('tr')?.classList.add('row-selected'); });
      updateHeaderCheckboxState();
    });
    $('btnUnselectAll')?.addEventListener('click', () => {
      const inputs = Array.from(document.querySelectorAll('#resultsBody input[type="checkbox"]'));
      inputs.forEach(i=>{ i.checked=false; i.closest('tr')?.classList.remove('row-selected'); });
      updateHeaderCheckboxState();
    });
    $('btnClear')?.addEventListener('click', () => {
      const tb = $('resultsBody'); if (tb) tb.innerHTML = `<tr><td colspan="4" style="color:var(--muted);padding:12px">No scan performed yet.</td></tr>`; $('scanCount') && ($('scanCount').textContent=''); hideProgress(); showToast('Results cleared'); });

    // Help modal: reliable open/close with Escape
    const helpOpenBtn = $('btnHelp');
    const helpCloseBtn = $('helpClose');
    const helpBackdrop = $('helpModalBackdrop');
    if (helpOpenBtn && helpBackdrop) {
      helpOpenBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        helpBackdrop.style.display = 'flex';
        helpBackdrop.setAttribute('aria-hidden','false');
        const esc = (e) => { if (e.key === 'Escape') { helpBackdrop.style.display = 'none'; helpBackdrop.setAttribute('aria-hidden','true'); document.removeEventListener('keydown', esc); } };
        document.addEventListener('keydown', esc);
        helpBackdrop._escHandler = esc;
      });
    }
    if (helpCloseBtn && helpBackdrop) {
      helpCloseBtn.addEventListener('click', () => {
        helpBackdrop.style.display = 'none';
        helpBackdrop.setAttribute('aria-hidden','true');
        if (helpBackdrop._escHandler) { document.removeEventListener('keydown', helpBackdrop._escHandler); delete helpBackdrop._escHandler; }
      });
    }

    $('resultClose')?.addEventListener('click', ()=>{ const rb = $('resultModalBackdrop'); if (rb) { rb.style.display = 'none'; rb.setAttribute('aria-hidden','true'); }});
    const headerChk = $('chkHeader'); if (headerChk) headerChk.addEventListener('change', (e) => { toggleHeaderSelect(e.target.checked); });

    if (window.ppsaApi && typeof window.ppsaApi.onScanProgress === 'function') window.ppsaApi.onScanProgress(onProgressMessage);
    if (window.ppsaApi && typeof window.ppsaApi.onOperationComplete === 'function') {
      window.ppsaApi.onOperationComplete(async (data) => {
        try {
          if (data && data.success) {
            const src = $('sourcePath') && $('sourcePath').value ? $('sourcePath').value.trim() : '';
            if (src) {
              showToast('Operation complete — refreshing list...');
              setTimeout(async () => {
                const res = await window.ppsaApi.scanSourceForPpsa(src);
                if (res && !res.error) {
                  const arr = Array.isArray(res) ? res : (Array.isArray(res.items) ? res.items : []);
                  renderResults(arr);
                }
              }, 700);
            }
          } else {
            if (data && data.error) showToast('Operation finished with errors');
          }
        } catch (e) { console.error('onOperationComplete handler error', e); }
      });
    }

    log('renderer initialized');
  });

  // debug helpers
  window.__ps5_renderResults = renderResults;
  window.__ps5_computeFinalTargetForItem = computeFinalTargetForItem;
  window.__ps5_deriveSafeGameName = function(item) {
    if (!item) return 'Unknown Game';
    if (item.displayTitle) return item.displayTitle;
    if (item.dbTitle) return item.dbTitle;
    if (item.folderName) return item.folderName;
    const p = item.contentFolderPath || item.folderPath || '';
    const seg = (p + '').replace(/[\/\\]+$/,'').split(/[\/\\]/).pop() || '';
    if (seg) return seg;
    if (item.ppsa) return item.ppsa;
    return 'Unknown Game';
  };

})();