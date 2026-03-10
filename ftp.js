(function () {
  'use strict';

  const toast = (msg) => { if (typeof window.toast === 'function') window.toast(msg); else console.warn('[FTP]', msg); };

  // Global API for FTP
  window.FtpApi = {
    openFtpModal: openFtpModal,
    handleProgress: handleProgress
  };

  function populateFtpDatalists() {
    const recents = window.getRecentFtp ? window.getRecentFtp() : [];
    const hosts = new Set();
    const ports = new Set();
    const paths = new Set();
    const users = new Set();
    for (const c of recents) {
      if (c.host) hosts.add(c.host);
      if (c.port) ports.add(c.port);
      if (c.path) paths.add(c.path);
      if (c.user) users.add(c.user);
    }
    // Add preset paths
    paths.add('/data/etaHEN/games');
    paths.add('/data/games');
    paths.add('/mnt/ext1/etaHEN/games');
    paths.add('/mnt/usb0/etaHEN/games');
    paths.add('/mnt/usb1/etaHEN/games');
    paths.add('/mnt/usb0');
    paths.add('/mnt/usb1');
    paths.add('/mnt/ext1');
    paths.add('/data');

    const hostHistory = document.getElementById('hostHistory');
    if (hostHistory) {
      hostHistory.innerHTML = '';
      for (const h of hosts) {
        const opt = document.createElement('option');
        opt.value = h;
        hostHistory.appendChild(opt);
      }
    }
    const portHistory = document.getElementById('portHistory');
    if (portHistory) {
      // Merge recent ports with the seeded common PS5 ports
      const allPorts = new Set(['1337', '2121', '1338', '21']);
      for (const p of ports) allPorts.add(String(p));
      portHistory.innerHTML = '';
      for (const p of allPorts) {
        const opt = document.createElement('option');
        opt.value = p;
        portHistory.appendChild(opt);
      }
    }
    const pathHistory = document.getElementById('pathHistory');
    if (pathHistory) {
      pathHistory.innerHTML = '';
      for (const p of paths) {
        const opt = document.createElement('option');
        opt.value = p;
        pathHistory.appendChild(opt);
      }
    }
    const userHistory = document.getElementById('userHistory');
    if (userHistory) {
      userHistory.innerHTML = '';
      for (const u of users) {
        const opt = document.createElement('option');
        opt.value = u;
        userHistory.appendChild(opt);
      }
    }
  }

  function getLastFtpConfig() {
    const recents = window.getRecentFtp ? window.getRecentFtp() : [];
    return recents.length > 0 ? recents[0] : null;
  }

  // Delay (ms) before closing dropdown on blur, so mousedown on an option fires first.
  const DROPDOWN_BLUR_DELAY_MS = 150;

  // Custom show-all dropdown: shows ALL datalist options on focus/click,
  // filters by substring as the user types, closes on blur or Escape.
  function makeShowAllDropdown(inputEl, datalistId) {
    let dropdownEl = null;

    function getOptions() {
      const dl = document.getElementById(datalistId);
      if (!dl) return [];
      return Array.from(dl.options).map(o => o.value).filter(Boolean);
    }

    function showDropdown() {
      closeDropdown();
      const options = getOptions();
      const query = inputEl.value.toLowerCase();
      const filtered = query
        ? options.filter(o => o.toLowerCase().includes(query))
        : options;
      if (filtered.length === 0) return;

      dropdownEl = document.createElement('ul');
      dropdownEl.style.cssText = [
        'position:absolute',
        'left:0',
        'right:0',
        'top:100%',
        'margin:2px 0 0',
        'padding:0',
        'list-style:none',
        'background:var(--surface-2,#1a1e24)',
        'border:1px solid rgba(255,255,255,0.1)',
        'border-radius:6px',
        'box-shadow:0 8px 24px rgba(0,0,0,0.5)',
        'color:var(--title,#f1f5f9)',
        'font-size:12.5px',
        'z-index:99999',
        'max-height:200px',
        'overflow-y:auto',
      ].join(';');

      for (const val of filtered) {
        const li = document.createElement('li');
        li.textContent = val;
        li.setAttribute('tabindex', '-1');
        li.style.cssText = 'padding:7px 12px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.04);';
        li.addEventListener('mouseenter', () => {
          li.style.background = 'rgba(59,130,246,0.15)';
          li.style.color = '#60a5fa';
        });
        li.addEventListener('mouseleave', () => {
          li.style.background = '';
          li.style.color = '';
        });
        li.addEventListener('mousedown', (e) => {
          e.preventDefault(); // Keep input focused so blur fires after
          inputEl.value = val;
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          closeDropdown();
        });
        dropdownEl.appendChild(li);
      }

      // Position relative to input
      const wrapper = inputEl.parentElement;
      if (wrapper) {
        wrapper.style.position = 'relative';
        wrapper.appendChild(dropdownEl);
      }
    }

    function closeDropdown() {
      if (dropdownEl) {
        dropdownEl.remove();
        dropdownEl = null;
      }
    }

    inputEl.addEventListener('focus', () => showDropdown());
    inputEl.addEventListener('input', () => showDropdown());
    inputEl.addEventListener('blur', () => {
      // Delay so mousedown on an option fires before blur closes the list
      setTimeout(() => closeDropdown(), DROPDOWN_BLUR_DELAY_MS);
    });
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDropdown();
      if (e.key === 'ArrowDown' && dropdownEl) {
        e.preventDefault();
        const first = dropdownEl.querySelector('li');
        if (first) first.focus();
      }
    });
  }

  async function openFtpModal(initialUrl) {
    populateFtpDatalists();
    const backdrop = document.getElementById('ftpModalBackdrop');
    const hostInput = document.getElementById('ftpHost');
    const portInput = document.getElementById('ftpPort');
    const pathInput = document.getElementById('ftpPath');
    const userInput = document.getElementById('ftpUser');
    const passInput = document.getElementById('ftpPass');
    const passiveCheckbox = document.getElementById('ftpPassive'); // Passive mode checkbox
    const bufferInput     = document.getElementById('ftpBufferSize');
    const parallelInput   = document.getElementById('ftpParallel');
    const speedLimitInput = document.getElementById('ftpSpeedLimit');
    const testBtn         = document.getElementById('ftpTestBtn');
    const testResult      = document.getElementById('ftpTestResult');
    const proceedBtn = document.getElementById('ftpProceed');
    const cancelBtn  = document.getElementById('ftpCancel');

    if (!backdrop || !hostInput || !portInput || !pathInput || !userInput || !passInput || !passiveCheckbox || !bufferInput || !parallelInput || !proceedBtn || !cancelBtn) {
      return Promise.resolve(null);
    }

    // Default path by port — 1337 = etaHEN internal, 2121 = ftpsrv (serves /data root)
    function defaultPathForPort(port) {
      const p = String(port);
      if (p === '1337') return '/data/etaHEN/games';
      if (p === '2121') return '/data/etaHEN/games';
      return '/data/etaHEN/games';
    }

    // Parse initialUrl if provided
    if (initialUrl) {
      try {
        const url = new URL(initialUrl.startsWith('ftp://') ? initialUrl : 'ftp://' + initialUrl);
        const detectedPort = (url.port && /^\d+$/.test(url.port)) ? url.port : '';
        hostInput.value = url.hostname;
        portInput.value = detectedPort;
        // Only use URL pathname if it's something other than root '/'
        pathInput.value = (url.pathname && url.pathname !== '/') ? url.pathname : defaultPathForPort(detectedPort);
        userInput.value = url.username || 'anonymous';
        passInput.value = url.password || '';
      } catch (e) {
        hostInput.value = initialUrl.replace('ftp://', '').split(':')[0] || '';
        portInput.value = '';
        pathInput.value = defaultPathForPort('');
        userInput.value = 'anonymous';
        passInput.value = '';
      }
    } else {
      // Load last config if available
      const lastConfig = getLastFtpConfig();
      if (lastConfig) {
        hostInput.value = lastConfig.host || '';
        portInput.value = lastConfig.port || '';
        pathInput.value = lastConfig.path || defaultPathForPort(lastConfig.port);
        userInput.value = lastConfig.user || 'anonymous';
        passInput.value = lastConfig.pass || '';
        passiveCheckbox.checked = lastConfig.passive !== false; // Default to true
        bufferInput.value = lastConfig.bufferSize ? Math.round(lastConfig.bufferSize / 1024) : 64;
        parallelInput.value = lastConfig.parallel || '1';
        if (speedLimitInput) speedLimitInput.value = lastConfig.speedLimitKbps || '0';
      } else {
        hostInput.value = '';
        portInput.value = '';
        pathInput.value = defaultPathForPort('');
        userInput.value = 'anonymous';
        passInput.value = '';
        passiveCheckbox.checked = true; // Default passive mode
        bufferInput.value = '64';
        parallelInput.value = '1';
        if (speedLimitInput) speedLimitInput.value = '0';
      }
    }

    // When port changes and path is still a default, update path suggestion to match port
    portInput.addEventListener('change', () => {
      const currentPath = pathInput.value.trim();
      const suggestedPaths = ['/data/etaHEN/games', '/mnt/ext1/etaHEN/games', '/'];
      if (!currentPath || suggestedPaths.includes(currentPath)) {
        pathInput.value = defaultPathForPort(portInput.value.trim());
      }
    });

    backdrop.style.display = 'flex';
    backdrop.setAttribute('aria-hidden', 'false');

    // Attach show-all custom dropdowns now that the modal is visible
    makeShowAllDropdown(hostInput, 'hostHistory');
    makeShowAllDropdown(portInput, 'portHistory');
    makeShowAllDropdown(pathInput, 'pathHistory');
    makeShowAllDropdown(userInput, 'userHistory');

    hostInput.focus();

    return new Promise((resolve) => {
      const cleanup = () => {
        backdrop.style.display = 'none';
        backdrop.setAttribute('aria-hidden', 'true');
        proceedBtn.removeEventListener('click', onProceed);
        cancelBtn.removeEventListener('click', onCancel);
        backdrop.removeEventListener('click', onBackdropClick);
        document.removeEventListener('keydown', onKeydown);
        if (testBtn) testBtn.removeEventListener('click', onTest);
      };

      // ── Test connection ──────────────────────────────────────────────────
      const onTest = async () => {
        const host = hostInput.value.trim();
        const port = portInput.value.trim();
        const user = userInput.value.trim() || 'anonymous';
        const pass = passInput.value.trim() || '';
        if (!host) { toast('Enter a host address first'); return; }
        if (testBtn)   { testBtn.disabled = true; testBtn.textContent = 'Testing…'; }
        if (testResult) { testResult.style.display = 'block'; testResult.textContent = 'Connecting…'; testResult.className = 'ftp-test-result'; }
        try {
          const res = await window.ppsaApi.ftpTestConnection({ host, port, user, pass });
          if (testResult) {
            if (res.ok) {
              testResult.textContent = `✓ Connected in ${res.latencyMs}ms — ${res.listing} items at root`;
              testResult.classList.add('ftp-test-ok');
            } else {
              testResult.textContent = `✗ Failed: ${res.error || 'Unknown error'}`;
              testResult.classList.add('ftp-test-err');
            }
          }
        } catch (e) {
          if (testResult) { testResult.textContent = `✗ ${e.message}`; testResult.classList.add('ftp-test-err'); }
        } finally {
          if (testBtn) { testBtn.disabled = false; testBtn.textContent = 'Test'; }
        }
      };

      const onProceed = () => {
        const config = {
          host: hostInput.value.trim(),
          port: portInput.value.trim(),
          path: pathInput.value.trim(),
          user: userInput.value.trim(),
          pass: passInput.value.trim(),
          passive: passiveCheckbox.checked, // Passive mode
          bufferSize: (parseInt(bufferInput.value.trim()) || 64) * 1024,  // field is KB → store bytes
          parallel: parseInt(parallelInput.value.trim()) || 1,
          speedLimitKbps: parseInt(speedLimitInput?.value?.trim()) || 0
        };

        // Validate host
        if (!config.host) { toast('Please enter a host address.'); return; }
        // Validate port — blank → default 2121
        const portNum = parseInt(config.port) || 2121;
        if (portNum < 1 || portNum > 65535) {
          toast('Invalid port — must be between 1 and 65535.');
          return;
        }
        config.port = String(portNum);
        // Save as last config immediately so port persists
        if (window.addRecentFtp) window.addRecentFtp(config);

        // Validate buffer size
        if (config.bufferSize < 1024 || config.bufferSize > 1048576) {
          toast('Buffer size must be between 1 and 1024 KB.');
          return;
        }

        // Validate parallel
        if (config.parallel < 1 || config.parallel > 10) { // 1 to 10
          toast('Parallel transfers must be between 1 and 10.');
          return;
        }

        cleanup();
        resolve(config);
      };

      const onCancel = () => {
        cleanup();
        resolve(null);
      };

      const onBackdropClick = (e) => { if (e.target === backdrop) onCancel(); };
      const onKeydown = (e) => { if (e.key === 'Escape') onCancel(); };
      proceedBtn.addEventListener('click', onProceed);
      cancelBtn.addEventListener('click', onCancel);
      backdrop.addEventListener('click', onBackdropClick);
      document.addEventListener('keydown', onKeydown);
      if (testBtn) testBtn.addEventListener('click', onTest);
    });
  }

  function handleProgress(data) {
    // Handle FTP-specific progress (e.g., transfer updates)
    if (data.type === 'go-file-progress' || data.type === 'go-file-complete') {
      // Update TransferStats or UI as needed
      console.log('[FTP Progress]', data);
    }
  }
})();