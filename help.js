(function () {
  'use strict';

  // Help modal content for PS5 Vault
  const helpContent = `
<h2>PS5 Vault Help</h2>

<h3>Getting Started</h3>
<p>PS5 Vault helps you organize and transfer PS5 game backups. Scan directories or FTP servers, select games, and move/copy them with customizable layouts for homebrew plugins like etaHEN or itemZFlow.</p>

<h3>New Features</h3>
<ul>
  <li><strong>Scan All Drives</strong>: Click the "Scan All Drives" button to automatically scan all local and network drives for games in one operation. Ideal for systems with multiple storage devices.</li>
  <li><strong>FTP to FTP Transfers</strong>: Transfer games directly between two FTP servers without local downloads. Set FTP URLs for both source and destination.</li>
  <li><strong>FTP Move Operations</strong>: Use "Move" action with FTP sources to transfer and auto-delete source files after success, freeing up remote server space.</li>
  <li><strong>Calculate Size Checkbox</strong>: Toggle "Calculate game sizes" to skip size computation for faster scans on large libraries (sizes will show as blank or partial estimates).</li>
  <li><strong>Auto-Refresh</strong>: Scan results refresh automatically after transfers or closing modals, keeping your list up-to-date.</li>
</ul>

<h3>Scanning Games</h3>
<p>
  <strong>Source Input</strong>: Enter a local path, FTP URL (e.g., <code>ftp://192.168.1.100:2121/mnt/ext1/etaHEN/games</code>), or use "Browse" for local directories.<br>
  <strong>FTP Scanning</strong>: For IP/FTP inputs, a modal will prompt for credentials (host, port, path, user, pass). Recent FTP configs are saved.<br>
  <strong>Scan All Drives</strong>: Scans all connected drives—useful for multi-drive setups.<br>
  <strong>Progress</strong>: Watch the progress bar and current path during scans.
</p>

<h3>Transfer Settings</h3>
<p>
  <strong>Destination</strong>: Supports local paths or FTP (with modal for config). Recent destinations include FTP URLs.<br>
  <strong>Layout Options</strong>:
  <ul>
    <li><strong>etaHEN default</strong>: <code>{dest}/etaHEN/games/{game}/</code></li>
    <li><strong>itemZFlow default</strong>: <code>{dest}/games/{game}/</code></li>
    <li><strong>Dump Runner default</strong>: <code>{dest}/homebrew/{game}/</code></li>
    <li><strong>Game / PPSA</strong>: <code>{dest}/{game}/{PPSA}/</code></li>
    <li><strong>Game only</strong>: <code>{dest}/{game}/</code></li>
    <li><strong>PPSA only</strong>: <code>{dest}/{PPSA}/</code></li>
    <li><strong>Custom</strong>: Rename via modal, path is <code>{dest}/{customName}/</code></li>
  </ul>
  <strong>Action</strong>: Copy (keeps source) or Move (deletes source).<br>
  <strong>Calculate Size</strong>: Enable for accurate sizes; disable for speed.
</p>

<h3>FTP Transfers</h3>
<p>
  <strong>Setup</strong>: Enter host (IP), port (default 2121), path, username, and password. Use passive mode for firewalls.<br>
  <strong>FTP to FTP</strong>: Source and destination can both be FTP for server-to-server transfers.<br>
  <strong>Security</strong>: Passwords stored locally in plaintext—clear via logo click.<br>
  <strong>Troubleshooting</strong>: Check port/firewall; use "Test" if available.
</p>

<h3>Game Selection and Operations</h3>
<p>
  <strong>Selecting</strong>: Checkboxes for individual games; header checkbox for all visible. Use search to filter.<br>
  <strong>Transfer</strong>: Click "GO" after selecting. Confirm modal shows preview.<br>
  <strong>Conflicts</strong>: Choose to skip, overwrite, or rename duplicates.<br>
  <strong>Results</strong>: Modal shows transfer status; auto-refreshes scans on close.<br>
  <strong>Delete/Rename</strong>: Right-click or use buttons for bulk operations (refreshes automatically).
</p>

<h3>Settings and Persistence</h3>
<p>Layout, action, and calculate size settings save automatically. Theme toggles via logo click. Export/import data via menu.</p>

<h3>Keyboard Shortcuts</h3>
<ul>
  <li><strong>Ctrl+A</strong>: Select all visible games</li>
  <li><strong>Ctrl+R</strong>: Refresh current scan</li>
  <li><strong>F1</strong>: Open this help</li>
  <li><strong>Arrow Keys</strong>: Navigate game list</li>
</ul>

<h3>Troubleshooting</h3>
<ul>
  <li><strong>Scan Fails</strong>: Check paths/permissions; FTP needs valid creds and connection.</li>
  <li><strong>FTP Errors</strong>: ECONNREFUSED means wrong port/host; use passive mode.</li>
  <li><strong>Slow Scans</strong>: Disable "Calculate Size" for large libraries.</li>
  <li><strong>Version Duplicates</strong>: Fixed—won't append extra versions.</li>
  <li><strong>No Games Found</strong>: Ensure valid PPSA folders with param.sfo.</li>
</ul>

<h3>About</h3>
<p>PS5 Vault by NookieAI. For support, join <a href="https://discord.gg/nj45kDSBEd" target="_blank">Discord</a> or check the repo.</p>
`;

  // Function to open help modal
  function openHelp() {
    const existingModal = document.getElementById('helpModalBackdrop');
    if (existingModal) {
      existingModal.style.display = 'flex';
      existingModal.setAttribute('aria-hidden', 'false');
      return;
    }

    const backdrop = document.createElement('div');
    backdrop.id = 'helpModalBackdrop';
    backdrop.className = 'modal-backdrop';
    backdrop.setAttribute('aria-hidden', 'false');
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="helpTitle" style="max-width: 800px; max-height: 80vh; overflow-y: auto;">
        <div class="modal-header">
          <h4 id="helpTitle">PS5 Vault Help</h4>
          <button id="helpClose" class="close-btn" title="Close">✕</button>
        </div>
        <div class="modal-body" id="helpModalBody">${helpContent}</div>
        <div class="modal-actions">
          <button id="helpCloseBtn" class="btn">Close</button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);

    // Event listeners
    const closeBtn = document.getElementById('helpClose');
    const closeBtn2 = document.getElementById('helpCloseBtn');
    const closeHandler = () => {
      backdrop.style.display = 'none';
      backdrop.setAttribute('aria-hidden', 'true');
    };
    closeBtn.addEventListener('click', closeHandler);
    closeBtn2.addEventListener('click', closeHandler);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeHandler();
    });
  }

  // Expose to global
  window.HelpApi = { openHelp };

})();