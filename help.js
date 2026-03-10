(function () {
  'use strict';

  // Help modal content for PS5 Vault
  const helpContent = `
<h3>Getting Started</h3>
<p>PS5 Vault helps you organize and transfer PS5 game backups between local drives and FTP servers (e.g., your PS5 running etaHEN or ftpsrv). Scan a source folder or FTP path, select games, choose a destination and layout, then hit <strong>GO</strong>.</p>

<h3>What's New in v2.3</h3>
<ul>
  <li><strong>Show-All Dropdown</strong>: All recent paths and FTP configs appear instantly when you click any path field — no typing required.</li>
  <li><strong>Porkfolio Layout</strong>: New folder naming format <code>Game Name (version) PPSAID</code> for Porkfolio backporting.</li>
  <li><strong>Scan All Drives</strong>: Scan every connected local drive in one click.</li>
  <li><strong>FTP ↔ FTP Transfers</strong>: Transfer directly between two FTP servers.</li>
  <li><strong>Auto-Detect PS5</strong>: Finds your PS5 on the local network automatically.</li>
  <li><strong>Verify Library</strong>: Integrity check using stored checksums.</li>
  <li><strong>Per-game Transfer History</strong>: Full audit log of every operation.</li>
  <li><strong>Resume Interrupted Transfers</strong>: Crashed mid-copy? PS5 Vault can resume.</li>
</ul>

<h3>Scanning Games</h3>
<ul>
  <li><strong>Local Scan</strong>: Enter a folder path (e.g., <code>D:\\Games</code>) or click <strong>Browse</strong>, then click <strong>SCAN</strong>.</li>
  <li><strong>FTP Scan</strong>: Enter an IP address (e.g., <code>192.168.1.100</code>) — the FTP config modal opens automatically.</li>
  <li><strong>Scan All Drives</strong>: Scans every connected drive simultaneously. Useful for multi-drive setups.</li>
  <li><strong>Calculate Size</strong>: Enable for accurate sizes; disable for faster scans on large libraries.</li>
  <li><strong>Verify Library</strong>: Re-scans and compares each game's files against the stored checksum database to find corrupted copies.</li>
</ul>

<h3>Transferring Games</h3>
<ul>
  <li><strong>Selecting Games</strong>: Use checkboxes per row, or the header checkbox to select all visible. <kbd>Ctrl+A</kbd> also selects all.</li>
  <li><strong>Destination Types</strong>: Local folder path, or FTP URL / IP for your PS5.</li>
  <li><strong>Layout Options</strong>:
    <ul>
      <li><strong>etaHEN default</strong> — <code>{dest}/etaHEN/games/{game}/</code></li>
      <li><strong>itemZFlow default</strong> — <code>{dest}/games/{game}/</code></li>
      <li><strong>Dump Runner default</strong> — <code>{dest}/homebrew/{game}/</code></li>
      <li><strong>Game / PPSA</strong> — <code>{dest}/{game}/{PPSA}/</code></li>
      <li><strong>Game only</strong> — <code>{dest}/{game}/</code></li>
      <li><strong>PPSA only</strong> — <code>{dest}/{PPSA}/</code></li>
      <li><strong>Porkfolio</strong> — <code>{dest}/{game} ({version}) {PPSAID}/</code> — for Porkfolio backporting</li>
      <li><strong>Custom</strong> — enter a custom folder name in the rename modal</li>
    </ul>
  </li>
  <li><strong>Actions</strong>: <em>Copy</em> (keeps source), <em>Move</em> (deletes source after verified copy), <em>Create Folder</em> (structure only).</li>
  <li><strong>Conflict Resolution</strong>: When a target already exists, choose <em>Skip</em>, <em>Overwrite</em>, or <em>Rename</em> (auto-numbered).</li>
  <li><strong>Progress Panel</strong>: Live speed (sliding-window), ETA, elapsed time, transferred bytes, per-file name, and a sparkline speed graph.</li>
</ul>

<h3>FTP Configuration</h3>
<ul>
  <li><strong>Host</strong>: IP address of your PS5 (e.g., <code>192.168.1.100</code>).</li>
  <li><strong>Port</strong>: Common PS5 ports — <code>1337</code> (etaHEN built-in FTP), <code>2121</code> (ftpsrv). Default: 2121.</li>
  <li><strong>Path</strong>: Remote path to scan or transfer to (e.g., <code>/data/etaHEN/games</code>).</li>
  <li><strong>User / Pass</strong>: Leave blank or use <code>anonymous</code> for most PS5 FTP servers.</li>
  <li><strong>Passive Mode</strong>: Enable when behind a NAT/firewall (recommended).</li>
  <li><strong>Buffer Size</strong>: Chunk size for FTP reads/writes (KB). Higher = faster on good networks.</li>
  <li><strong>Parallel</strong>: Number of simultaneous FTP file transfers (1–10).</li>
  <li><strong>Speed Limit</strong>: Cap transfer speed in KB/s (0 = unlimited).</li>
  <li><strong>Test</strong>: Verify the connection before proceeding.</li>
  <li><strong>FTP Storage Info</strong>: Shows free/used space on the remote server.</li>
  <li><strong>Auto-Detect (Find PS5)</strong>: Scans the local network for a PS5 FTP server automatically.</li>
</ul>

<h3>Library Features</h3>
<ul>
  <li><strong>Library Diff / Compare</strong>: Compare two libraries to find games present in one but not the other.</li>
  <li><strong>Verify Library</strong>: Integrity check — re-hashes files against the checksum database.</li>
  <li><strong>Card / Grid View</strong>: Toggle between table and card view with cover art.</li>
  <li><strong>Per-game Transfer History</strong>: See every copy, move, or upload ever performed per game.</li>
  <li><strong>Checksum Database</strong>: PS5 Vault stores SHA-256 hashes of every file it copies for later verification.</li>
</ul>

<h3>Game Management</h3>
<ul>
  <li><strong>Rename (Single)</strong>: Select one game and click <strong>Rename</strong>, or right-click → Rename.</li>
  <li><strong>Batch Rename</strong>: Select multiple games and click <strong>Rename</strong> to rename them all at once.</li>
  <li><strong>Soft Delete / Trash</strong>: Deleted games go to the built-in trash bin and can be restored.</li>
  <li><strong>Right-click Context Menu</strong>: Quick access to Rename, Delete, Transfer History, and more.</li>
</ul>

<h3>Settings &amp; Persistence</h3>
<ul>
  <li><strong>Theme</strong>: Click the logo to toggle dark/light mode.</li>
  <li><strong>Column Widths</strong>: Drag column headers to resize; saved automatically.</li>
  <li><strong>Export / Import</strong>: Export your library list and settings to JSON; import to restore.</li>
  <li><strong>FTP Connection Profiles</strong>: Up to 5 recent FTP configs are remembered and shown in the dropdown.</li>
  <li><strong>API Server</strong>: Enable the local REST API for automation and third-party integrations.</li>
</ul>

<h3>Keyboard Shortcuts</h3>
<ul>
  <li><kbd>Ctrl+A</kbd> — Select all visible games</li>
  <li><kbd>Ctrl+R</kbd> — Re-scan (same source as last scan)</li>
  <li><kbd>F1</kbd> — Open this help</li>
  <li><kbd>↑</kbd> / <kbd>↓</kbd> — Navigate the game list</li>
  <li><kbd>Escape</kbd> — Close any open modal or dropdown</li>
</ul>

<h3>Troubleshooting</h3>
<ul>
  <li><strong>Scan Fails</strong>: Check the path exists and you have read permissions. For FTP, verify host/port/credentials.</li>
  <li><strong>FTP ECONNREFUSED</strong>: Wrong port or PS5 FTP server not running. Try port 1337 (etaHEN) or 2121 (ftpsrv).</li>
  <li><strong>FTP Passive Mode</strong>: Enable passive mode if active mode times out behind NAT.</li>
  <li><strong>Slow Scans</strong>: Uncheck <em>Calculate Size</em> — size calculation can take minutes on large libraries.</li>
  <li><strong>No Games Found</strong>: Ensure the source contains valid PPSA folders each with a <code>param.sfo</code> file.</li>
  <li><strong>Transfer Errors</strong>: Check disk space on the destination and write permissions on the target folder.</li>
  <li><strong>Progress Stuck at Preparing…</strong>: Game size is being calculated. This may take up to a minute for large titles.</li>
</ul>

<h3 style="margin-top:20px;letter-spacing:0.02em;">✦ Credits</h3>
<div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">

  <div style="display:flex;align-items:center;gap:14px;padding:11px 16px;background:var(--surface-2,#1a1e24);border:1px solid rgba(59,130,246,0.25);border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,0.3);">
    <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#1d4ed8,#3b82f6);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🛠️</div>
    <div style="flex:1;">
      <div style="font-weight:700;font-size:13.5px;color:var(--title,#f1f5f9);letter-spacing:0.01em;">NookieAI</div>
      <div style="font-size:11px;color:var(--muted,#6b7280);margin-top:2px;font-weight:500;">Developer &amp; Creator</div>
    </div>
    <div style="font-size:10px;color:var(--accent,#3b82f6);font-weight:700;text-transform:uppercase;letter-spacing:0.08em;background:rgba(59,130,246,0.12);padding:3px 8px;border-radius:4px;flex-shrink:0;">DEV</div>
  </div>

  <div style="display:flex;align-items:center;gap:14px;padding:11px 16px;background:var(--surface-2,#1a1e24);border:1px solid rgba(251,191,36,0.3);border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,0.3);">
    <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#92400e,#fbbf24);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">⚡</div>
    <div style="flex:1;">
      <div style="font-weight:700;font-size:13.5px;color:var(--title,#f1f5f9);letter-spacing:0.01em;">M///Class</div>
      <div style="font-size:11px;color:var(--muted,#6b7280);margin-top:2px;font-weight:500;">Testing God — relentless QA &amp; bug hunting</div>
    </div>
    <div style="font-size:10px;color:#fbbf24;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;background:rgba(251,191,36,0.12);padding:3px 8px;border-radius:4px;flex-shrink:0;">QA</div>
  </div>

</div>

<h3 style="margin-top:16px;">About</h3>
<p>PS5 Vault by <strong>NookieAI</strong>. For support, join the <a href="https://discord.gg/nj45kDSBEd" target="_blank" style="color:var(--accent,#3b82f6);">Discord server</a> or check the GitHub repo.</p>
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
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="helpTitle" style="max-width:800px;max-height:85vh;overflow-y:auto;display:flex;flex-direction:column;">
        <div class="modal-header">
          <h4 id="helpTitle">PS5 Vault Help</h4>
          <button id="helpClose" class="close-btn" title="Close">✕</button>
        </div>
        <div class="modal-body" id="helpModalBody" style="overflow-y:auto;flex:1;">${helpContent}</div>
        <div class="modal-actions">
          <button id="helpCloseBtn" class="btn">Close</button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);
    // Show immediately — .modal-backdrop defaults to display:none in CSS so we
    // must explicitly flip it here on first creation (same as the re-open path).
    backdrop.style.display = 'flex';

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