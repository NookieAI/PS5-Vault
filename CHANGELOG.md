# Changelog

All notable changes to PS5 Vault are documented here.

---

## [2.3.0] — 2026

### New Features

**Library Diff / Compare**
Compare two game libraries side-by-side. Pick any second source — a local path, USB drive, or FTP target — and PS5 Vault shows which games exist only in source A, only in source B, or in both. A one-click "Transfer Missing →" button pre-selects all games absent from B and readies them for transfer without any manual picking.

**Verify Library**
Scan your entire library (or a selection) for integrity issues. Each game is checked for folder accessibility, a valid `param.json`, and a cover icon. Results are sorted with errors first and colour-coded: ✓ OK, ⚠ Warning, ✗ Error, with a badge summary at the top.

**PS5 Auto-Detect**
Click **🔍 Find PS5** inside the FTP modal to scan your local network automatically. PS5 Vault probes all live hosts on your subnet across the three common FTP ports used by etaHEN and compatible payloads. The first result auto-fills the host and port fields — no manual IP hunting required.

**FTP Storage Info**
Click **💾 Storage** inside the FTP modal (connection details filled in) to query all known PS5 mount points — internal storage, extended storage, and USB drives — and display available / total space with a usage bar per mount.

**Card / Grid View**
Toggle between the classic table view and a cover-art grid with **⊞ Grid**. Each card shows the game's icon, title, and size. Selection, batch operations, and all transfer features work identically in both views. The active view persists across sessions.

**Speed Sparkline**
A live polyline graph appears in the transfer progress panel, plotting the last ~60 speed samples as a rolling window. Gives an at-a-glance view of transfer consistency and throttling without having to watch the numbers.

**Selective Sub-folder Transfer**
Expand any game row before transferring to choose exactly which sub-folders get copied. Useful for transferring just updates or DLC without re-sending the base game data.

**Soft Delete / Trash Bin**
The delete action now moves items to a `_ps5vault_trash` folder inside the source directory instead of permanently removing files. Trash entries older than 30 days are auto-purged. Items can be recovered manually from the trash folder at any time.

**Persistent Column Widths**
Drag any column header divider to resize. Widths are saved to local storage and restored on next launch.

**Per-game Transfer History**
Transfer history now records which game was involved in each operation (by title ID). View per-game history to see exactly when and where a title was last transferred.

**FTP Connection Profiles**
Save named FTP connection configurations (host, port, path, credentials, passive mode, buffer size, parallelism, speed limit) and switch between them from a dropdown in the FTP modal.

**Checksum Database**
A persistent checksum store (saved to `userData/checksum-db.json`) records file hashes after each transfer. On subsequent transfers, files whose checksums already match the destination are skipped, reducing redundant data movement. Records expire after 90 days.

### Improvements

**FTP Transfer Reliability**
Retry count increased from 3 to 5 for both downloads and uploads. Both directions now detect mid-transfer disconnects (ECONNRESET, FIN, connection closed) and automatically re-establish the FTP session before retrying, rather than failing the entire operation.

**API Modal Layout**
Fixed the API modal overflowing the viewport on smaller screens. The modal body now scrolls independently within a constrained height, and action buttons remain anchored at the bottom.

### Bug Fixes

- Fixed FTP transfers failing silently on connection drop mid-file
- Fixed delete button permanently removing files with no recovery path
- Fixed transfer progress panel overflowing on narrow windows

---

## [2.0.0] — 2025

### Performance — FTP Size Calculation

The FTP sizing system was rewritten from the ground up. Repeat scans of a cached library are now near-instant, and first-time scans of large libraries are significantly faster.

**Two-phase sizing pipeline**
Cached and uncached games no longer compete for the same concurrency slot. Phase 1 validates all cached games at up to 12 concurrent connections (one LIST per game). Phase 2 walks only the cache misses, with 4 workers per game instead of 2. Cache hits begin streaming to the UI immediately without waiting for Phase 1 to complete.

**FTP connection pool**
Cache validation previously opened a fresh TCP connection per game, waited for the handshake, did one LIST, then closed it — repeated for every game in the library. A shared `FtpConnectionPool` now maintains up to 12 persistent connections that are borrowed and returned between games. On WiFi (≈20ms RTT) this saves roughly 800ms for a 50-game library.

**Event-based worker wake-up**
Worker coroutines previously polled every 5ms when the queue was temporarily empty while another worker was mid-LIST. Workers now park on a Promise that is resolved the instant a new directory is pushed to the queue, eliminating the polling delay entirely.

**Size-only manifest mode**
When calculating sizes during a scan, `buildFtpManifest` now accepts a `sizeOnly` flag that skips building the full file-path array. Only `totalSize` is needed at scan time — the full manifest is only constructed when a transfer actually starts. This removes ~25,000 object allocations (and associated GC pressure) for a typical 50-game library.

**Workers per game increased: 2 → 4**
Each uncached game now uses 4 parallel FTP connections to walk its directory tree instead of 2. For a game with 200 directories at 5ms RTT this halves the walk time from ~500ms to ~250ms.

### Bug Fixes

**Duplicate `get-all-drives` handler** — The `get-all-drives` IPC handler was registered twice, crashing the app on the second launch. Duplicate removed.

**`diskCacheDirty` ghost variable** — A variable that was set in multiple places but never read was fully removed. It had been left behind from a previous refactor.

**`rename-item` missing try/catch** — Filesystem errors during rename (permissions, file in use) were throwing unhandled exceptions through IPC instead of returning a structured `{ error }` response.

**`rename-item` path-traversal guard** — If the new name contained `/` or `\`, `path.join` could silently escape the parent directory. Names containing path separators are now explicitly rejected, and the resolved new path must share the same parent as the old path.

**`ftp-delete-item` and `ftp-rename-item` error handling** — These handlers previously returned `{ error: "..." }` objects on failure, which `await` resolves successfully — making the error invisible to the caller. Both now `throw` on failure, consistent with how local delete/rename errors are surfaced.

**`scanFtpSource` ignored `calcSize` option** — The IPC handler correctly forwarded `opts.calcSize`, but the function only destructured `sender` from its options object. Size calculation ran unconditionally regardless of the checkbox state. Now properly gated on `calcSize`.

**`computeSourceFolder` Windows path** — The regex stripping `\sce_sys` from source paths only matched the forward-slash variant (`/sce_sys`). On Windows, paths ending in `\sce_sys` were not stripped, causing the wrong source folder to be used in transfers.

**`addRecentFtp` received URL string instead of config object** — The function expects `{ host, port, path, user }` to generate a deduplication key and pre-fill the FTP modal on next use. It was being called with a raw URL string, which stored garbage in the recents list and broke the remembered-FTP-configs feature.

**Rename path separator on Windows** — Building a new path with a hardcoded `'/'` separator produced mixed-separator paths (`D:\games/New Name`) on Windows, breaking filesystem operations. The separator is now detected from the source path.

**`ftpDeleteItem` error silently swallowed in renderer** — The renderer awaited `ftpDeleteItem` without checking the return value. Added a belt-and-suspenders error check so FTP delete failures surface to the user.

**`renameItem` error silently swallowed in renderer** — `renameItem` returns `{ error }` on failure. The renderer never checked this, so rename failures were invisible. Error is now surfaced.

**`checkConflicts` dropped `customName` parameter** — The preload wrapper forwarded only 3 of 4 arguments. With a custom layout, conflict detection computed the wrong target path, missing real conflicts or flagging false ones.

---

## [1.1.3] — 2024

- Persistent disk cache for FTP folder sizes with single-LIST validation
- Progressive UI streaming — table rows appear as games are found
- Adaptive parallelism — worker count scales with directory density
- Cross-drive move via copy-then-delete (fixes EXDEV errors)
- Correct source folder calculation forwarded through `calcSize`
- FTP overlap detection and dead code removal

## [1.0.0] — 2024

Initial release.

- Scan local drives and USB devices for PS5 games
- Copy and move games with flat, nested, or custom layout
- FTP scan and transfer from PS5 (etaHEN)
- Conflict detection
- Resume interrupted transfers
- Dark / light theme
