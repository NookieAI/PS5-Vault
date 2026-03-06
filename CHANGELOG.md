# What's New in PS5 Vault

---

## Version 2.1.0

### New features

**Transfer speed throttle**
A slider in the FTP settings lets you cap how fast the app uploads files. Useful if you want to keep playing on your PS5 while a transfer runs in the background — just dial it back so the network doesn't get swamped.

**Backup integrity checker**
A new "Check Integrity" mode scans a destination folder and verifies every file against the source using a hash check — without copying or moving anything. Answers the question: "Is my backup actually complete and uncorrupted?"

**Free space warning**
Before a transfer starts, the app now shows how much space is free at the destination and flags if there isn't enough room for the games you've selected. No more transfers failing halfway through because the drive was full.

**Library comparison (diff)**
Point the app at two locations — for example your PS5 and a USB drive — and it will show you exactly what's different: what's missing from one side, what exists on both, and what has a different version. Makes it easy to keep your drives in sync.

**Game details panel**
Click any game in the list to see its full details: title, version, content ID, region, required firmware, and more. No need to dig through folders in a file manager.

**Send to multiple destinations at once**
Select games and copy them to two places simultaneously — for example, your PS5 and a backup drive — in one go.

**Scheduled transfers**
Set a time for a transfer to run automatically. Kick it off before you go to bed and it'll be done by morning.

**Transfer history**
A persistent log of every copy and move you've done, with dates and results. Lives in the Menu and is saved between sessions so you always have a record of what went where.

---

## Version 2.0.0

### Much faster scanning

Scanning large libraries is significantly faster than before, and re-scanning a library you've already scanned before is near-instant thanks to caching.

- Games that were already measured load immediately from cache; only new or changed games are re-measured
- The app now scans up to 12 games at the same time during cache checks, and uses 4 parallel connections per game during a full scan (previously 2)
- Results start appearing in the list as soon as the first game is found — you don't have to wait for the whole scan to finish
- The app no longer wastes time building information it doesn't need until a transfer actually starts

### Bug fixes

- Fixed a crash that happened the second time you launched the app
- Fixed FTP size calculation ignoring the "Calculate Size" checkbox — it was always running even when unchecked
- Fixed rename not working correctly on Windows (mixed slash characters in paths)
- Fixed rename allowing names with slashes in them, which could cause files to end up in the wrong place
- Fixed FTP delete and rename errors being silently ignored — failures now show a proper error message
- Fixed conflict detection producing wrong results when a custom folder name was used
- Fixed "Add to recent FTP" saving garbage data instead of the actual connection details
- Fixed source folder being calculated incorrectly on Windows when paths used backslashes

---

## Version 1.1.3

- Scanning results now appear in real time as games are found
- FTP folder sizes are cached to disk so repeat scans are fast
- Transfers now work correctly when moving games across different drives
- Various speed and reliability improvements

---

## Version 1.0.0

First release.

- Scan local drives and USB devices for PS5 games
- Copy and move games with your choice of folder layout
- Transfer games directly from your PS5 over FTP
- Conflict detection before transfers
- Resume interrupted transfers
- Dark and light theme
