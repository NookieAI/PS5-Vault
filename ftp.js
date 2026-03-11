(function () {
  'use strict';

  const toast = (msg) => { if (typeof window.toast === 'function') window.toast(msg); else console.warn('[FTP]', msg); };

  // Global API for FTP
  window.FtpApi = {
    openFtpModal: openFtpModal
  };

  // Build option arrays for the FTP dropdowns from recent connection history.
  function buildFtpOptions() {
    const recents = window.getRecentFtp ? window.getRecentFtp() : [];
    const hosts = new Set();
    const ports = new Set(['1337', '2121', '1338', '21']);
    const paths = new Set([
      '/data/etaHEN/games',
      '/data/games',
      '/mnt/ext1/etaHEN/games',
      '/mnt/usb0/etaHEN/games',
      '/mnt/usb1/etaHEN/games',
      '/mnt/usb0',
      '/mnt/usb1',
      '/mnt/ext1',
      '/data',
    ]);
    const users = new Set();
    for (const c of recents) {
      if (c.host) hosts.add(c.host);
      if (c.port) ports.add(String(c.port));
      if (c.path) paths.add(c.path);
      if (c.user) users.add(c.user);
    }
    return {
      hosts: Array.from(hosts),
      ports: Array.from(ports),
      paths: Array.from(paths),
      users: Array.from(users),
    };
  }

  function getLastFtpConfig() {
    const recents = window.getRecentFtp ? window.getRecentFtp() : [];
    return recents.length > 0 ? recents[0] : null;
  }

  /**
   * Opens the FTP configuration modal and returns the user-confirmed config object.
   * If initialUrl is provided, pre-fills the form fields from the parsed URL.
   * Resolves with the FTP config object on confirm, or null if cancelled.
   * @param {string} [initialUrl] - Optional FTP URL to pre-fill (e.g. from PS5 auto-detect).
   * @returns {Promise<object|null>}
   */
  async function openFtpModal(initialUrl) {
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

    // Default path by port — returns root so users can browse themselves
    function defaultPathForPort(port) {
      return '/';
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
      const suggestedPaths = ['/'];
      if (!currentPath || suggestedPaths.includes(currentPath)) {
        pathInput.value = defaultPathForPort(portInput.value.trim());
      }
    });

    backdrop.style.display = 'flex';
    backdrop.setAttribute('aria-hidden', 'false');

    // Attach show-all custom dropdowns now that the modal is visible.
    // Build option arrays fresh from the latest recent-FTP history.
    if (typeof window.makeShowAllDropdown === 'function') {
      const opts = buildFtpOptions();
      window.makeShowAllDropdown(hostInput, opts.hosts);
      window.makeShowAllDropdown(portInput, opts.ports);
      window.makeShowAllDropdown(pathInput, opts.paths);
      window.makeShowAllDropdown(userInput, opts.users);
    }

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
})();