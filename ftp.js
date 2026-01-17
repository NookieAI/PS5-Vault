(function () {
  'use strict';

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
    paths.add('/mnt/usb0');
    paths.add('/mnt/usb1');
    paths.add('/mnt/ext1');

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
      portHistory.innerHTML = '';
      for (const p of ports) {
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

  async function openFtpModal(initialUrl) {
    populateFtpDatalists();
    const backdrop = document.getElementById('ftpModalBackdrop');
    const hostInput = document.getElementById('ftpHost');
    const portInput = document.getElementById('ftpPort');
    const pathInput = document.getElementById('ftpPath');
    const userInput = document.getElementById('ftpUser');
    const passInput = document.getElementById('ftpPass');
    const proceedBtn = document.getElementById('ftpProceed');
    const cancelBtn = document.getElementById('ftpCancel');

    if (!backdrop || !hostInput || !portInput || !pathInput || !userInput || !passInput || !proceedBtn || !cancelBtn) {
      return Promise.resolve(null);
    }

    // Parse initialUrl if provided
    if (initialUrl) {
      try {
        const url = new URL(initialUrl.startsWith('ftp://') ? initialUrl : 'ftp://' + initialUrl);
        hostInput.value = url.hostname;
        portInput.value = (url.port && /^\d+$/.test(url.port)) ? url.port : '1337';
        pathInput.value = url.pathname || '/';
        userInput.value = url.username || 'anonymous';
        passInput.value = url.password || '';
      } catch (e) {
        hostInput.value = initialUrl.replace('ftp://', '').split(':')[0] || '';
        portInput.value = '1337';
        pathInput.value = '/';
        userInput.value = 'anonymous';
        passInput.value = '';
      }
    } else {
      // Load last config if available
      const lastConfig = getLastFtpConfig();
      if (lastConfig) {
        hostInput.value = lastConfig.host || '';
        portInput.value = lastConfig.port || '1337';
        pathInput.value = lastConfig.path || '/mnt/ext1/etaHEN/games';
        userInput.value = lastConfig.user || 'anonymous';
        passInput.value = lastConfig.pass || '';
      } else {
        hostInput.value = '';
        portInput.value = '1337';
        pathInput.value = '/mnt/ext1/etaHEN/games';
        userInput.value = 'anonymous';
        passInput.value = '';
      }
    }

    backdrop.style.display = 'flex';
    backdrop.setAttribute('aria-hidden', 'false');
    hostInput.focus();

    return new Promise((resolve) => {
      const cleanup = () => {
        backdrop.style.display = 'none';
        backdrop.setAttribute('aria-hidden', 'true');
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

  function handleProgress(data) {
    // Handle FTP-specific progress (e.g., transfer updates)
    if (data.type === 'go-file-progress' || data.type === 'go-file-complete') {
      // Update TransferStats or UI as needed
      console.log('[FTP Progress]', data);
    }
  }
})();