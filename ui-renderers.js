// UI rendering functions
console.log('ui-renderers.js loaded');
(function () {
  'use strict';

  const LAST_RESULTS_KEY = 'ps5vault.lastResults';

  let currentSortBy = 'name';
  let scanStartTime = 0;
  let transferStartTime = 0;
  let maxSpeed = 0;
  let lastFile = '';
  let completedFiles = [];
  let totalTransferred = 0;
  let completedGames = new Set();
  let elapsedInterval = null;

  // Virtual scrolling variables
  let visibleRows = [];
  let rowHeight = 50; // Approximate height per row
  let containerHeight = 400; // Height of results container
  let scrollTop = 0;

  // TransferStats object
  window.TransferStats = {
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

  function attachPreviewHandlers(imgEl, srcUrl) {
    if (!imgEl || !srcUrl) return;
    const onEnter = (ev) => {
      window.UiUtils.Preview.lastX = ev.clientX;
      window.UiUtils.Preview.lastY = ev.clientY;
      window.UiUtils.Preview.scheduleShow(srcUrl);
    };
    const onMove = (ev) => {
      window.UiUtils.Preview.move(ev.clientX, ev.clientY);
    };
    const onLeave = () => {
      window.UiUtils.Preview.hide();
    };
    imgEl.addEventListener('mouseenter', onEnter);
    imgEl.addEventListener('mousemove', onMove);
    imgEl.addEventListener('mouseleave', onLeave);
    imgEl.addEventListener('click', onLeave);
  }

  function renderResults(arr, scanDuration) {
    console.log('renderResults called with', arr.length, 'items');
    const tbody = document.getElementById('resultsBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const raw = Array.isArray(arr) ? arr : [];
    const list = raw; // Temporarily disable dedupe: window.DataUtils ? window.DataUtils.dedupeItems(raw) : raw;
    // Sort alphabetically by game name always
    console.log('Sorting list');
    list.sort((a, b) => {
      const aName = (a.displayTitle || a.dbTitle || a.folderName || '').toLowerCase();
      const bName = (b.displayTitle || b.dbTitle || b.folderName || '').toLowerCase();
      return aName.localeCompare(bName);
    });
    console.log('Sorted list first 5:', list.slice(0,5).map(r => r.displayTitle));
    window.__ps5_lastRenderedItems = list;

    // Disable virtual scrolling to show all rows
    visibleRows = list; // list.slice(startIndex, endIndex);

    for (let i = 0; i < visibleRows.length; i++) {
      const r = visibleRows[i];
      const actualIndex = i; // startIndex + i;
      const tr = document.createElement('tr');
      tr.dataset.selectable = '1';
      tr.dataset.index = String(actualIndex);

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
      if (r.totalSize === 0) {
        tdSize.textContent = '';
      } else {
        tdSize.textContent = bytesToHuman(r.totalSize || 0);
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
    // Set tbody height to simulate full list
    tbody.style.height = `${list.length * rowHeight}px`;
    tbody.style.overflow = 'hidden';

    const durationText = scanDuration ? ` (scanned in ${scanDuration}s)` : '';
    const scanCountEl = document.getElementById('scanCount');
    if (scanCountEl) scanCountEl.textContent = `${list.length} games found${durationText}`;
    updateHeaderCheckboxState();
    if (window.UiUtils && window.UiUtils.showScanUI) window.UiUtils.showScanUI(false);
    try { localStorage.setItem(LAST_RESULTS_KEY, JSON.stringify(list)); } catch (_) {}
  }

  function updateHeaderCheckboxState() {
    const header = document.getElementById('chkHeader');
    if (!header) return;
    const visible = Array.from(document.querySelectorAll('#resultsBody tr')).filter(tr => tr.offsetParent !== null);
    if (!visible.length) {
      header.checked = false;
      header.indeterminate = false;
      return;
    }
    const checkedCount = visible.filter(tr => {
      const cb = tr.querySelector('input[type="checkbox"]');
      return cb && cb.checked;
    }).length;
    if (checkedCount === 0) {
      header.checked = false;
      header.indeterminate = false;
    } else if (checkedCount === visible.length) {
      header.checked = true;
      header.indeterminate = false;
    } else {
      header.checked = false;
      header.indeterminate = true;
    }
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

  function showNotification(title, body) {
    if (Notification.permission === 'granted') {
      new Notification(title, { body });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(perm => {
        if (perm === 'granted') new Notification(title, { body });
      });
    }
  }

  function updateListSummary(res) {
    const rl = document.getElementById('resultList');
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
      from.innerHTML = '<span class="label-bold">From:</span> ' + (window.UiUtils ? window.UiUtils.escapeHtml(window.UiUtils.normalizeDisplayPath(r.source || '')) : '');
      const to = document.createElement('div');
      to.className = 'path-inline';
      to.innerHTML = '<span class="label-bold">To:</span> ' + (window.UiUtils ? window.UiUtils.escapeHtml(r.target || '') : '');
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
    const rs = document.getElementById('resultSubText');
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
      if (maxSpeed > 0) parts.push(`Max speed: ${bytesToHuman(maxSpeed)}/s`);
      rs.textContent = parts.length ? parts.join(' • ') : 'Operation complete';
    }
    const rcEl = document.getElementById('resultCount');
    if (rcEl) rcEl.textContent = String(total);
    totalTransferred = totalBytes;  // Set global for completion message
  }

  function onProgressMessage(d) {
    console.log('Progress received:', d);
    try {
      if (!d || !d.type) return;

      if (d.type === 'scan') {
        const label = document.getElementById('currentScanLabel');
        if (label) {
          const pathText = d.progressText || d.folder || d.path || '';
          label.textContent = pathText || 'Scanning...';
        }
        return;
      }

      if (d.type === 'go-start') {
        if (window.UiUtils) window.UiUtils.setResultModalBusy(true);
        TransferStats.reset();
        maxSpeed = 0;
        completedFiles = [];
        completedGames = new Set(); // Reset completed games
        transferStartTime = Date.now(); // Use Date.now()
        const rb = document.getElementById('resultModalBackdrop');
        const rp = document.getElementById('resultProgress');
        const rl = document.getElementById('resultList');
        const rc = document.getElementById('resultCount');
        const rs = document.getElementById('resultSubText');
        const cf = document.getElementById('currentFileInfo');
        const comp = document.getElementById('completedFiles');
        const title = document.getElementById('resultTitleText');
        if (rb && rp && rl && rc && rs && cf && comp && title) {
          rp.style.display = 'block';
          rl.style.display = 'none';
          rc.textContent = '0 / 0';
          rs.textContent = 'Transferring...';
          cf.textContent = '';
          comp.innerHTML = '';
          rb.style.display = 'flex';
          rb.setAttribute('aria-hidden', 'false');
          title.textContent = 'Transferring...';
        }
        cancelOperation = false;
        const ts = document.getElementById('transferStats');
        if (ts) ts.textContent = 'Elapsed: 00:00 • Transferred: 0 B • Speed: --';
        // Clear any existing interval
        if (elapsedInterval) {
          clearInterval(elapsedInterval);
          elapsedInterval = null;
        }
        // Start elapsed time counter
        elapsedInterval = setInterval(() => {
          const elapsed = Math.round((Date.now() - transferStartTime) / 1000); // Use Date.now()
          const ts2 = document.getElementById('transferStats');
          if (ts2) {
            const currentText = ts2.textContent;
            const parts = currentText.split(' • ');
            const newParts = parts.map(p => p.startsWith('Elapsed:') ? `Elapsed: ${secToHMS(elapsed)}` : p);
            ts2.textContent = newParts.join(' • ');
          }
        }, 1000);
        return;
      }

      if (d.type === 'go-file-progress' || d.type === 'go-file-complete') {
        if (!transferStartTime) transferStartTime = Date.now();
        if (cancelOperation) return;
        if (d.fileRel) lastFile = d.fileRel;
        TransferStats.update(d.totalBytesCopied || 0, d.totalBytes || 0);
        if (TransferStats.emaSpeed > maxSpeed) maxSpeed = TransferStats.emaSpeed;
        const rs = document.getElementById('resultSubText');
        const cf = document.getElementById('currentFileInfo');
        const rc = document.getElementById('resultCount');
        console.log('Updating rc to', `${d.itemIndex || 0} / ${d.totalItems || 0}`, 'rc:', rc);
        if (rs && cf && rc) {
          rc.textContent = `${d.itemIndex || 0} / ${d.totalItems || 0}`;
          const speedHuman = bytesToHuman(TransferStats.emaSpeed || 0) + '/s';
          const hasTotal = d.totalBytes && Number.isFinite(d.totalBytes) && d.totalBytes > 0;
          if (hasTotal) {
            const percent = Math.round((d.totalBytesCopied / d.totalBytes) * 100);
            const eta = TransferStats.etaSec > 0 ? ` • ETA: ${secToHMS(TransferStats.etaSec)}` : '';
            const baseText = `Progress: ${percent}% • ${speedHuman}${lastFile ? ' • ' + lastFile : ''}${eta}`;
            rs.textContent = baseText;
            cf.textContent = lastFile ? `Current: ${lastFile} (${percent}%)` : 'Preparing...';
          } else {
            const baseText = `Transferring... ${speedHuman}${lastFile ? ' • ' + lastFile : ''}`;
            rs.textContent = baseText;
            cf.textContent = lastFile ? `Current: ${lastFile}` : 'Preparing...';
          }
        }

        const progressFill = document.getElementById('resultProgress')?.querySelector('.progress-fill');
        if (progressFill) {
          const hasTotal = d.totalBytes && Number.isFinite(d.totalBytes) && d.totalBytes > 0;
          progressFill.style.width = hasTotal ? `${Math.round((d.totalBytesCopied / d.totalBytes) * 100)}%` : '0%';
        }

        const ts = document.getElementById('transferStats');
        if (ts) {
          const currentText = ts.textContent;
          const parts = currentText.split(' • ');
          const newParts = parts.map(p => {
            if (p.startsWith('Transferred:')) return `Transferred: ${bytesToHuman(d.totalBytesCopied || 0)}`;
            if (p.startsWith('Speed:')) return `Speed: ${bytesToHuman(TransferStats.emaSpeed || 0)}/s`;
            return p;
          });
          ts.textContent = newParts.join(' • ');
        }

        if (d.type === 'go-file-complete') {
          if (d.gameName && !completedGames.has(d.gameName)) {
            completedGames.add(d.gameName);
            const comp = document.getElementById('completedFiles');
            if (comp) {
              const div = document.createElement('div');
              div.className = 'completed-file';
              div.textContent = d.gameName;
              comp.insertBefore(div, comp.firstChild);
            }
          }
        }
        return;
      }

      if (d.type === 'go-complete') {
        if (window.UiUtils) window.UiUtils.setResultModalBusy(false);
        // Clear elapsed interval
        if (elapsedInterval) {
          clearInterval(elapsedInterval);
          elapsedInterval = null;
        }
        const rp = document.getElementById('resultProgress');
        const rl = document.getElementById('resultList');
        const rs = document.getElementById('resultSubText');
        const closeBtn = document.getElementById('resultClose');
        const label = document.getElementById('currentScanLabel');
        const title = document.getElementById('resultTitleText');
        if (rp) rp.style.display = 'none';
        if (rl) rl.style.display = 'block';
        if (closeBtn) closeBtn.style.display = 'block';
        if (rs) rs.textContent = 'Operation complete';
        if (label) label.textContent = '';
        if (title) title.textContent = 'Operation results';
        if (window.UiUtils && window.UiUtils.showScanUI) window.UiUtils.showScanUI(false);
        showNotification('Transfer Complete', 'PS5 Vault operation finished successfully.');
        localStorage.removeItem('ps5vault.transferState');
        const transferDurationMs = transferStartTime ? (Date.now() - transferStartTime) : 0; // Use Date.now()
        const durationText = transferDurationMs < 1000 ? `${transferDurationMs.toFixed(0)}ms` : secToHMS(transferDurationMs / 1000);
        const totalTransferred = d.totalBytesCopied || 0;
        const ts = document.getElementById('transferStats');
        if (ts) ts.textContent = `Completed in ${durationText} • Total transferred: ${bytesToHuman(totalTransferred)} • Max speed: ${bytesToHuman(maxSpeed)}/s`;
        const actionsRow = document.getElementById('resultActionsRow');
        if (actionsRow) actionsRow.style.display = 'none';
        return;
      }

      if (d.type === 'go-item') {
        const label = document.getElementById('currentScanLabel');
        const raw = d.folder || d.path || '';
        if (label) label.textContent = (window.UiUtils ? window.UiUtils.normalizeDisplayPath(raw) : '') || '';
        return;
      }
    } catch (e) {
      console.error('Error in onProgressMessage:', e);
    }
  }

  // Define window.UiRenderers after all functions
  window.UiRenderers = {
    renderResults: renderResults,
    updateListSummary: updateListSummary,
    updateHeaderCheckboxState: updateHeaderCheckboxState,
    sortResults: sortResults,
    showNotification: showNotification,
    onProgressMessage: onProgressMessage,
    attachPreviewHandlers: attachPreviewHandlers,
    formatContentVersionShort: formatContentVersionShort,
    formatSdkVersionHexToDisplay: formatSdkVersionHexToDisplay,
    shouldAddPlus: shouldAddPlus,
    bytesToHuman: bytesToHuman,
    secToHMS: secToHMS
  };
})();