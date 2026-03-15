(function () {
  'use strict';

  // Help modal content for PS5 Vault
  const helpContent = `
<h3>Getting Started</h3>
<ul>
  <li>Download the portable <code>.exe</code> from Releases — no installation needed.</li>
  <li>Enter a Source path (local folder, drive letter, or PS5 IP/FTP URL) → click <strong>SCAN</strong>.</li>
  <li>Tick games → pick a Destination and Layout → click <strong>GO</strong>.</li>
  <li><kbd>F1</kbd> opens this help at any time.</li>
</ul>

<h3>What's New (v2.4.4)</h3>
<ul>
  <li><strong>Copy (fast)</strong>: Skips SHA-256 hash verification — ideal for same-drive transfers where re-reading every byte is unnecessary.</li>
  <li><strong>File-level Resume</strong>: Interrupted transfers now skip files already fully present at the destination (matching size), so only missing or partial files are re-copied.</li>
  <li><strong>Free-Space Pre-check</strong>: Before starting a local copy, PS5 Vault verifies the destination has enough free space (with a 512 MB buffer) and shows an error if not.</li>
  <li><strong>Show-All Dropdown</strong>: All recent paths and FTP configs appear instantly when clicking any path field — no typing required. Items are filtered by substring as you type, with full keyboard navigation (Arrow keys, Enter, Escape, Tab).</li>
  <li><strong>Porkfolio Layout</strong>: New folder naming format <code>Game Name (version) PPSAID</code> for Porkfolio backporting.</li>
</ul>

<h3>Scanning Games</h3>
<ul>
  <li><strong>Local Scan</strong>: Enter a folder path (e.g., <code>D:\Games</code>) or click Browse, then click <strong>SCAN</strong>.</li>
  <li><strong>FTP Scan</strong>: Enter an IP address (e.g., <code>192.168.1.100</code>) — the FTP config modal opens automatically.</li>
  <li><strong>Scan All Drives</strong>: Scans every connected drive simultaneously.</li>
  <li><strong>Calculate Size</strong>: Enable for accurate sizes; disable for faster scans on large libraries.</li>
  <li><strong>Verify Library</strong>: Re-scans and compares each game's files against the stored checksum database.</li>
</ul>

<h3>Transferring Games</h3>
<ul>
  <li><strong>Selecting Games</strong>: Per-row checkboxes, header checkbox to select all, <kbd>Ctrl+A</kbd>.</li>
  <li><strong>Destination Types</strong>: Local folder path or FTP URL/IP for your PS5.</li>
  <li><strong>Layout Options</strong>:
    <ul>
      <li><strong>etaHEN default</strong> — <code>{dest}/etaHEN/games/{game}/</code></li>
      <li><strong>itemZFlow default</strong> — <code>{dest}/games/{game}/</code></li>
      <li><strong>Dump Runner default</strong> — <code>{dest}/homebrew/{game}/</code></li>
      <li><strong>Game / PPSA</strong> — <code>{dest}/{game}/{PPSA}/</code></li>
      <li><strong>Game only</strong> — <code>{dest}/{game}/</code></li>
      <li><strong>PPSA only</strong> — <code>{dest}/{PPSA}/</code></li>
      <li><strong>Porkfolio</strong> — <code>{dest}/{game} ({version}) {PPSAID}/</code></li>
      <li><strong>Custom</strong> — enter a custom folder name in the rename modal</li>
    </ul>
  </li>
  <li><strong>Actions</strong>: Copy (verified), Copy (fast), Move, Create folder only.</li>
  <li><strong>Conflict Resolution</strong>: Skip, Overwrite, or Rename (auto-numbered) when target exists.</li>
  <li><strong>Progress Panel</strong>: Live speed (sliding-window average), ETA, elapsed time, transferred bytes, per-file name, sparkline speed graph.</li>
</ul>

<h3>FTP Configuration</h3>
<ul>
  <li><strong>Host</strong>: IP address of your PS5 (e.g., <code>192.168.1.100</code>).</li>
  <li><strong>Port</strong>: <code>2121</code> (ftpsrv), <code>1337</code> (etaHEN built-in), <code>1338</code>.</li>
  <li><strong>Path</strong>: Remote path (e.g., <code>/data/etaHEN/games</code>).</li>
  <li><strong>User / Pass</strong>: Leave blank or use <code>anonymous</code> for most PS5 FTP servers.</li>
  <li><strong>Passive Mode</strong>: Enable when behind NAT/firewall (recommended).</li>
  <li><strong>Buffer Size</strong>: Chunk size for FTP reads/writes in KB; higher = faster on good networks.</li>
  <li><strong>Parallel</strong>: Number of simultaneous FTP file transfers (1–10).</li>
  <li><strong>Speed Limit</strong>: Cap transfer speed in KB/s (0 = unlimited).</li>
  <li><strong>Test</strong>: Verify connection before proceeding.</li>
  <li><strong>FTP Storage Info</strong>: Shows free/used space on the remote server.</li>
  <li><strong>Auto-Detect (Find PS5)</strong>: Scans the local network for a PS5 FTP server automatically.</li>
</ul>

<h3>Library Features</h3>
<ul>
  <li><strong>Card / Grid View</strong>: Toggle between table and cover-art grid with ⊞ Grid button; persists across sessions.</li>
  <li><strong>Library Diff / Compare</strong>: Compare two game libraries side-by-side — one-click "Transfer Missing →" pre-selects absent games.</li>
  <li><strong>Verify Library</strong>: Integrity check — folder accessible, valid <code>param.json</code>, cover icon present; results sorted errors-first with colour-coded badges.</li>
  <li><strong>Per-game Transfer History</strong>: Audit log per title ID for every operation.</li>
  <li><strong>Transfer History</strong> (Menu): Persistent log of every copy/move with dates, sizes, results.</li>
  <li><strong>Export History CSV</strong> (Menu): Save history as a spreadsheet.</li>
  <li><strong>Export / Import JSON</strong> (Menu): Back up or restore full scan results and settings.</li>
  <li><strong>Persistent Column Widths</strong>: Drag column headers to resize; saved to localStorage.</li>
  <li><strong>Checksum Database</strong>: Persistent store (<code>userData/checksum-db.json</code>); files whose checksums already match destination are skipped; records expire after 90 days.</li>
  <li><strong>Selective Sub-folder Transfer</strong>: Expand a game row before transferring to choose exactly which sub-folders get copied.</li>
</ul>

<h3>Game Management</h3>
<ul>
  <li>Delete or rename games (local or on PS5 over FTP).</li>
  <li>Batch rename using a pattern like <code>{name} - Backup</code>.</li>
  <li>Click any game to see full metadata: content ID, version, SDK version, region, required firmware, folder path.</li>
  <li>Click a folder path to open it in Windows Explorer.</li>
  <li><strong>Soft Delete / Trash Bin</strong>: Delete moves items to <code>_ps5vault_trash</code> inside the source directory; auto-purged after 30 days.</li>
</ul>

<h3>Developer API</h3>
<ul>
  <li>Runs on <code>http://127.0.0.1:3731/api/v1</code> (localhost only — not reachable from other devices).</li>
  <li>No authentication required — localhost binding is the security boundary.</li>
  <li>View the full endpoint reference under <strong>Menu → ⚙ Developer API</strong>.</li>
  <li>Endpoints: <code>GET /library</code>, <code>GET /library/:ppsa</code>, <code>GET /library/:ppsa/icon</code>, <code>POST /scan</code>, <code>GET /scan/status</code>, <code>POST /transfer</code>, <code>GET /transfer/status</code>, <code>GET /events</code> (SSE), <code>GET /status</code>.</li>
</ul>

<h3>Keyboard Shortcuts</h3>
<ul>
  <li><kbd>Ctrl+A</kbd> — Select all</li>
  <li><kbd>Ctrl+R</kbd> — Rescan</li>
  <li><kbd>F1</kbd> — Open help</li>
  <li><kbd>Esc</kbd> — Close modal</li>
</ul>

<h3>Troubleshooting</h3>
<ul>
  <li><strong>No games found</strong>: Ensure source contains valid PPSA folders each with a <code>param.sfo</code> file.</li>
  <li><strong>Transfer errors</strong>: Check disk space and write permissions on destination.</li>
  <li><strong>Progress stuck at Preparing…</strong>: Game size is being calculated; may take up to a minute for large titles.</li>
  <li><strong>FTP scan returns 0 games</strong>: Verify FTP payload is running and path points to a folder containing PPSA directories.</li>
  <li><strong>0% progress on copy</strong>: If using Copy (verified) across drives ensure destination is writable; try Copy (fast) to rule out hash-check hang.</li>
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