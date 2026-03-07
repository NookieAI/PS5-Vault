# What's New in PS5 Vault

---

## Version 2.2.0

### Developer API
PS5 Vault now runs a small local API server in the background, so other apps on your PC can read your game library and trigger scans or transfers automatically.

If you have a friend building a portfolio site, a dashboard, or any tool that should show your PS5 games — give them your API key from **Menu → ⚙ Developer API** and they're good to go.

- **Read your library** — any app can pull the full list of your scanned games, including cover art
- **Trigger scans** — kick off a scan without touching the PS5 Vault window
- **Monitor transfers** — subscribe to a live event stream that fires as files move
- **Secure by default** — only works on your own PC (not reachable from outside), protected by an API key you control
- Find the key, the base URL, and the full endpoint reference in **Menu → ⚙ Developer API**

### FTP improvements
- **Test Connection button** in the FTP config window — click it to check if PS5 Vault can reach your PS5 before starting a scan or transfer. Shows connection time and confirms read access.

### Library filtering
- **Filter by size** — new dropdown next to the search bar lets you narrow results to games under 1 GB, 1–10 GB, 10–30 GB, or over 30 GB

### Export
- **Export History CSV** in the Menu — saves your full transfer history as a spreadsheet you can open in Excel or Google Sheets

### UI fixes
- Every modal now has a proper **Close / Done button** at the bottom — no more hunting for the tiny ✕ in the corner after a transfer finishes
- The **Developer API modal** has a clean endpoint reference, Copy and Regen buttons for your key, and a Done button that actually works
- Fixed the **Help modal** — both the ✕ and the Close button were silently broken; both now work correctly
- Fixed the **FTP Test button** — it was present but not connected to anything; it now runs a live connection check
- Modal headers no longer overlap the close button on narrow text

---

## Version 2.1.0

### Transfer speed throttle
A speed limit field in the FTP settings lets you cap how fast the app uploads. Useful if you want to keep using your PS5 while a transfer runs in the background.

### Backup integrity checker
A new "Check Integrity" mode verifies every file at the destination against the source — no copying, just checking. Answers: is my backup actually complete?

### Free space warning
Before a transfer starts, the app shows how much space is free at the destination and warns you if there isn't enough room. No more transfers failing halfway through a 50 GB game.

### Library comparison
Point the app at two locations and it shows exactly what's different — what's missing from one side, what exists on both, what has a different version. Great for keeping a USB drive in sync with your main library.

### Game details panel
Click any game in the list to see full metadata: title, version, content ID, region, required firmware, folder path, and size.

### Transfer history
A persistent log of every copy and move you've run, with dates, sizes, and results. Saves between sessions. Find it under Menu → Transfer History.

---

## Version 2.0.0

### Much faster scanning
- Games already in the cache load instantly — only new or changed games are re-measured
- Scans up to 12 games simultaneously; full scans use 4 parallel connections per game
- Results appear as soon as the first game is found, not after the full scan completes

### Bug fixes
- Fixed a crash on the second launch
- Fixed FTP size calculation ignoring the "Calculate Size" checkbox
- Fixed rename not working correctly on Windows
- Fixed rename allowing slashes in names (files ending up in the wrong place)
- Fixed FTP delete/rename errors being silently swallowed
- Fixed conflict detection giving wrong results with custom folder names
- Fixed recent FTP list saving blank entries instead of actual connection details

---

## Version 1.1.3

- Scan results appear in real time as games are found
- FTP folder sizes are cached so repeat scans are fast
- Transfers now work correctly when moving games across different drives

---

## Version 1.0.0

First release.

- Scan local drives and USB devices for PS5 games
- Copy and move games with your choice of folder layout
- Transfer games directly from your PS5 over FTP
- Conflict detection before transfers
- Resume interrupted transfers
- Dark and light theme
