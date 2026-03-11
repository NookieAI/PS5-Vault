<div align="center">
  <img width="1919" height="1003" alt="PS5 Vault Screenshot" src="https://github.com/user-attachments/assets/44ea0d82-54c3-4451-a9e7-5a301184426a" />
</div>

# PS5 Vault

Organize, transfer, and manage your PS5 game backups — on your PC or straight over FTP to your PS5.

[Download latest release](https://github.com/NookieAI/PS5-Vault/releases) · [Discord](https://discord.gg/nj45kDSBEd) · [Support on Ko-fi](https://ko-fi.com/nookie_65120)

---

## What it does

PS5 Vault scans folders for PS5 game backups (PPSA folders), shows you your full library with cover art, sizes, and metadata, then lets you copy or move games wherever you need them — to a USB drive, a different folder layout, or directly to your PS5 over FTP.

---

## Getting started

1. Download the portable `.exe` from [Releases](https://github.com/NookieAI/PS5-Vault/releases) and run it — no installation needed
2. Point the **Source** field at the folder containing your games (or enter your PS5's FTP address)
3. Click **SCAN**
4. Tick the games you want, choose a destination and layout, click **GO**

Press **F1** at any time to open the built-in help.

---

## Features

### Scanning
- Scan any local folder, USB drive, or network path
- Connect directly to your PS5 over FTP — no need to copy files to your PC first
- **Scan All Drives** finds games across every connected drive in one click
- Results appear in real time as games are found; you don't wait for the whole scan to finish
- Game sizes, cover art, version, region, and firmware requirement are pulled automatically
- Filter your results by name or by size (under 1 GB, 1–10 GB, 10–30 GB, over 30 GB)

### Transfers
- **Copy** (with hash verification), **Copy (fast)** (no hash verification — faster for same-drive transfers), **Move**, or **Create folder only** (dry run)
- **File-level Resume**: skips files already fully present at the destination, so interrupted transfers pick up where they left off
- **Free-Space Pre-check**: destination free space is verified (512 MB buffer) before any local copy starts
- Choose from **eight** destination layouts:

  | Layout | Example result |
  |--------|---------------|
  | etaHEN default | `dest/etaHEN/games/GameName/` |
  | itemZFlow default | `dest/games/GameName/` |
  | Dump Runner default | `dest/homebrew/GameName/` |
  | Game / PPSA | `dest/GameName/PPSA12345/` |
  | Game only | `dest/GameName/` |
  | PPSA only | `dest/PPSA12345/` |
  | Porkfolio | `dest/GameName (ver) PPSA12345/` |
  | Custom | `dest/YourName/` |

- Transfer directly from PC to PS5 over FTP, or from PS5 back to PC
- Live progress bar, speed, ETA, and per-file status during transfers
- **Conflict resolution** — choose to skip, rename, or overwrite when a game already exists at the destination

### Game management
- Delete or rename games (local or on your PS5 over FTP)
- Batch rename using a pattern like `{name} - Backup`
- Click any game to see full metadata: content ID, version, SDK version, region, required firmware, folder path
- Click a folder path to open it in Windows Explorer
- **Soft Delete / Trash Bin**: deleted games move to `_ps5vault_trash` inside the source directory and are auto-purged after 30 days

### History and export
- **Transfer History** (Menu) — persistent log of every copy and move with dates, sizes, and results
- **Export History CSV** (Menu) — save your history as a spreadsheet
- **Export / Import JSON** — back up or restore your full scan results and settings

### FTP extras
- **Test Connection** button in the FTP config — confirms your PS5 is reachable and shows latency before you start
- Speed limit option — cap upload speed so your PS5 stays usable while a transfer runs
- Passive mode toggle for networks with strict firewalls
- Recent FTP connections saved and autocompleted
- **Show-All Dropdown**: click any path or host field to instantly see all recent paths and FTP configs — no typing required

### Library features
- **Card / Grid View**: toggle between the table and a cover-art grid with ⊞ Grid; persists across sessions
- **Library Diff / Compare**: compare two game libraries side-by-side; one-click "Transfer Missing →" pre-selects games absent from the second library
- **Verify Library**: integrity check — folder accessible, valid `param.json`, cover icon present; results sorted errors-first with colour-coded badges
- **Checksum Database**: persistent SHA-256 store (`userData/checksum-db.json`); files already matching the destination are skipped; records expire after 90 days
- **Selective Sub-folder Transfer**: expand a game row before transferring to choose exactly which sub-folders are copied
- **Persistent Column Widths**: drag column headers to resize; widths saved to localStorage
- **Per-game Transfer History**: audit log per title ID for every copy, move, or upload
- **FTP Connection Profiles**: save and switch between named FTP configurations
- **Speed Sparkline**: live polyline graph of the last ~60 speed samples in the transfer progress panel

### Developer API
PS5 Vault runs a local REST API so other apps on your PC can read your library or trigger scans and transfers programmatically.

Find your API key and the full endpoint reference under **Menu → ⚙ Developer API**.

```
Base URL:  http://127.0.0.1:3731/api/v1
Auth:      X-API-Key: <your key>

GET  /library              — your full game list
GET  /library/:ppsa        — single game by ID
GET  /library/:ppsa/icon   — cover art (PNG)
POST /scan                 — trigger a scan
GET  /scan/status          — scan progress
POST /transfer             — trigger a transfer
GET  /transfer/status      — transfer progress
GET  /events               — live SSE stream
GET  /status               — app status
```

The server only listens on `127.0.0.1` — it is not reachable from other devices on your network.

### Other
- Dark and light theme (click **Made by Nookie** to toggle)
- Hover over any cover art for a large preview
- Keyboard shortcuts: **Ctrl+A** select all · **Ctrl+R** rescan · **F1** help · **Esc** close modal
- Auto-update check on launch with one-click install

---

## Building from source

Requires Node.js 18+ and npm.

```bash
git clone https://github.com/NookieAI/PS5-Vault.git
cd PS5-Vault
npm install

# Run in development
npm start

# Build portable .exe
npm run build

# Build installer
npm run build:installer

# Build all platforms
npm run build:all
```

---

## Support

- **Discord** — [discord.gg/nj45kDSBEd](https://discord.gg/nj45kDSBEd) — fastest way to get help
- **Issues** — [GitHub Issues](https://github.com/NookieAI/PS5-Vault/issues)
- **Ko-fi** — [ko-fi.com/nookie_65120](https://ko-fi.com/nookie_65120)

---

Made with ❤️ by Nookie · v2.4.0
