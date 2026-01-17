(function () {
  'use strict';

  // Global API for Help Modal
  window.HelpApi = {
    openHelp: openHelp,
    closeHelp: closeHelp
  };

  let helpEscHandler = null;

  function openHelp(ev) {
    if (ev) ev.preventDefault();
    const helpBackdrop = document.getElementById('helpModalBackdrop');
    const helpModalBody = document.getElementById('helpModalBody');
    if (!helpBackdrop || !helpModalBody) return;
    helpBackdrop.style.display = 'flex';
    helpBackdrop.setAttribute('aria-hidden', 'false');
    helpEscHandler = (e) => { if (e.key === 'Escape') closeHelp(); };
    document.addEventListener('keydown', helpEscHandler);
    if (helpModalBody) {
      helpModalBody.innerHTML = `
        <div style="font-size: 14px; line-height: 1.6; color: var(--title);">
          <ol style="margin-left: 20px; margin-bottom: 20px;">
            <li style="margin-bottom: 10px;"><strong>Set Source:</strong> Click "Browse" next to Source to select a local folder/drive, or enter an FTP URL/IP (e.g., 192.168.1.100 or ftp://192.168.1.100:2121) to scan games directly from your PS5.</li>
            <li style="margin-bottom: 10px;"><strong>Scan:</strong> Click SCAN. The app will locate validated game folders (with param.json) and list them with thumbnails.</li>
            <li style="margin-bottom: 10px;"><strong>Select Items:</strong> Use checkboxes to pick games (Ctrl+A to select all, or use Select All/Unselect All buttons).</li>
            <li style="margin-bottom: 10px;"><strong>Set Destination:</strong> Click "Browse" to choose where organized folders go.</li>
            <li style="margin-bottom: 10px;"><strong>Choose Action & Layout:</strong> Action = folder creation, copy, or move. Layout = destination folder structure (see below).</li>
            <li style="margin-bottom: 10px;"><strong>Transfer:</strong> Click GO. Confirm dialog shows paths; handle conflicts (skip/rename).</li>
            <li style="margin-bottom: 10px;"><strong>Monitor Progress:</strong> Progress bar, ETA, file details. Cancel anytime. Results show after completion.</li>
          </ol>

          <h2 style="margin-top: 30px; margin-bottom: 15px; font-size: 16px;">FTP Scanning and Transferring (Direct from/to PS5)</h2>
          <p style="margin-bottom: 15px;">Use FTP to scan and transfer games without copying them to your PC first. This is ideal for large libraries or slow networks. Supports both downloading from PS5 and uploading to PS5.</p>
          <ul style="margin-left: 20px; margin-bottom: 20px;">
            <li style="margin-bottom: 10px;"><strong>Setup on PS5:</strong> Install ftpsrv and use port 2121 (default) or 1337. Note IP (e.g., 192.168.1.100). Ports: 2121 (recommended), 1337 (alt). Anonymous login OK.</li>
            <li style="margin-bottom: 10px;"><strong>Enter Source:</strong> Type FTP URL or IP:port in Source: 192.168.1.100 or 192.168.1.100:2121 (app auto-detects and defaults to port 2121). Click SCAN to download and scan games from PS5.</li>
            <li style="margin-bottom: 10px;"><strong>Enter Destination:</strong> For FTP destination, enter IP or URL in Destination. Config modal opens to set host, port, path, user, pass. Transfers upload games directly to PS5.</li>
            <li style="margin-bottom: 10px;"><strong>Tips:</strong> Same network/firewall check. Slower than local; use for scanning/transferring without local storage. Covers/size skipped for speed; param.json for info. Supports copy/move actions.</li>
            <li style="margin-bottom: 10px;"><strong>Supported Paths:</strong> Scans/transfers USB/game dirs automatically (e.g., /mnt/usb0/etaHEN/games). If custom, specify full path.</li>
          </ul>

          <h2 style="margin-top: 30px; margin-bottom: 15px; font-size: 16px;">Layout Directory Structures</h2>
          <ul style="margin-left: 20px; margin-bottom: 20px;">
            <li style="margin-bottom: 8px;"><strong>Game / PPSA</strong> — Destination/GameName/PPSAName (keeps PPSA separate)</li>
            <li style="margin-bottom: 8px;"><strong>Game only</strong> — Destination/GameName (flattens PPSA in)</li>
            <li style="margin-bottom: 8px;"><strong>PPSA only</strong> — Destination/PPSAName (PPSA only)</li>
            <li style="margin-bottom: 8px;"><strong>etaHEN default</strong> — Destination/etaHEN/games/GameName</li>
            <li style="margin-bottom: 8px;"><strong>itemZFlow default</strong> — Destination/games/GameName</li>
            <li style="margin-bottom: 8px;"><strong>Dump Runner default</strong> — Destination/homebrew/GameName</li>
            <li style="margin-bottom: 8px;"><strong>Custom</strong> — Destination/CustomName (prompt for name, single game)</li>
          </ul>

          <h2 style="margin-top: 30px; margin-bottom: 15px; font-size: 16px;">Batch Operations & Features</h2>
          <ul style="margin-left: 20px; margin-bottom: 20px;">
            <li style="margin-bottom: 8px;"><strong>Rename Selected:</strong> Select 1 game, click to open rename modal. Enter new name, confirm. Works local/FTP. Refreshes list.</li>
            <li style="margin-bottom: 8px;"><strong>Delete Selected:</strong> Select games, click to delete (with confirmation). Works local/FTP. Refreshes list.</li>
            <li style="margin-bottom: 8px;"><strong>Select All/Unselect All:</strong> Bulk select/deselect visible items.</li>
            <li style="margin-bottom: 8px;"><strong>Clear:</strong> Clear scan results (confirmation required).</li>
            <li style="margin-bottom: 8px;"><strong>Theme Toggle:</strong> Click "Made by Nookie" to switch dark/light theme.</li>
            <li style="margin-bottom: 8px;"><strong>Clear Recents:</strong> Click PS5 logo to clear all recent sources/dests/FTP (confirmation).</li>
            <li style="margin-bottom: 8px;"><strong>Conflict Resolution:</strong> Existing targets prompt skip/rename (default rename).</li>
            <li style="margin-bottom: 8px;"><strong>Sorting:</strong> Click table headers to sort by name/size/folder.</li>
            <li style="margin-bottom: 8px;"><strong>Keyboard Shortcuts:</strong> Ctrl+A (select all), Ctrl+R (rescan), F1 (help), Arrow keys (navigate).</li>
          </ul>

          <h2 style="margin-top: 30px; margin-bottom: 15px; font-size: 16px;">Support & Links</h2>
          <ul style="margin-left: 20px; margin-bottom: 20px;">
            <li style="margin-bottom: 8px;"><a href="https://github.com/NookieAI/PS5-Vault" target="_blank" rel="noopener" style="color: #60baff;">GitHub Repository</a></li>
            <li style="margin-bottom: 8px;"><a href="https://ko-fi.com/nookie_65120" target="_blank" rel="noopener" style="color: #60baff;">Support on Ko-fi</a></li>
            <li style="margin-bottom: 8px;"><a href="https://discord.gg/nj45kDSBEd" target="_blank" rel="noopener" style="color: #60baff;">Join Discord</a></li>
          </ul>

          <h2 style="margin-top: 30px; margin-bottom: 15px; font-size: 16px;">Notes</h2>
          <ul style="margin-left: 20px;">
            <li style="margin-bottom: 8px;">Conflicts handled via skip/rename. Fastest: Move on same drive; Copy verifies across drives.</li>
            <li style="margin-bottom: 8px;">PPSA removed; sce_sys preserved.</li>
            <li style="margin-bottom: 8px;">FTP: Covers/size skipped for speed; param.json for info. Supports full transfer operations.</li>
            <li>Test with 1 game first. Back up originals.</li>
          </ul>
        </div>
      `;
      const helpCloseBtn = document.getElementById('helpClose');
      if (helpCloseBtn) {
        helpCloseBtn.addEventListener('click', closeHelp);
      }
    }
  }

  function closeHelp() {
    const helpBackdrop = document.getElementById('helpModalBackdrop');
    if (!helpBackdrop) return;
    helpBackdrop.style.display = 'none';
    helpBackdrop.setAttribute('aria-hidden', 'true');
    if (helpEscHandler) {
      document.removeEventListener('keydown', helpEscHandler);
      helpEscHandler = null;
    }
  }
})();