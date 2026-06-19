# Changelog

All notable changes to PS5 Vault are documented here.

---

## [2.4.10] — 2026

A final deep audit of the remaining subsystems (delete/rename, diff, import, settings,
the local API, and the updater) fixed 22 issues. Highlights:

### Critical — data loss / security

- **Rename no longer silently overwrites** an existing same-named game (local and over
  FTP). It now refuses and tells you the name is taken.
- **FTP delete/rename work on titles containing `%`** (e.g. "100% Orange Juice"). The
  path was being URL-decoded, which could fail outright or target the wrong folder.
- **Diff → "Transfer Missing" now selects the right games in card/grid view** (it only
  worked in table view before, so GO could copy the wrong set).
- **Local API hardening:** the transfer endpoint now refuses sources that aren't part of
  the scanned library (could otherwise move/delete arbitrary folders); delete/rename
  require an exact, unambiguous id and are blocked during an active scan/transfer; error
  responses no longer leak filesystem paths.
- **Auto-update security:** the updater now refuses to follow a download redirect down to
  plain HTTP (prevents a man-in-the-middle from swapping the update), and writes to a
  fresh private temp folder (prevents a local symlink/TOCTOU attack).

### Other fixes

- "Clear recent … and FTP" now also wipes the saved FTP password from transfer state.
- Imported data is treated as display-only — a crafted import can't drive a delete/move
  or corrupt your settings.
- Diff comparison no longer false-matches two different games that share a folder name.
- Stats total size ignores the "size unavailable" marker; history CSV export is
  hardened against spreadsheet formula injection.
- Fixed a per-game listener/Worker leak during sizing; the window/tray/API server are now
  torn down cleanly on quit; launching the app while the headless service runs now opens
  the window; the "sub-folders" context item no longer implies a selective transfer.

---

## [2.4.9] — 2026

### Critical — Transfer safety (prevents data loss on Move)

A deep audit of the transfer pipeline found several cases where a **Move** could report
success after an *incomplete* transfer and then delete the source. All are now closed:

- **Incomplete FTP download no longer deletes the source.** If any folder failed to list
  during the manifest walk (common under PS5 FTP load), the download silently skipped those
  files yet reported success — and a Move then deleted the source. The walk now retries
  failed directories and, if any still can't be read, fails the whole transfer so the source
  is preserved.
- **Incomplete FTP upload no longer deletes the source.** Directories stored as NTFS
  junctions/symlinks were silently skipped during upload. They are now followed and uploaded.
- **FTP uploads are size-verified.** After each file uploads, its size on the PS5 is checked
  against the local file; a short/truncated write is retried instead of being accepted.
- **Same-place FTP Move is a no-op.** Moving/restoring a game to the exact path it already
  occupies (with Overwrite) no longer risks deleting the just-written folder.
- **Overwrite that can't clear the old folder now aborts** instead of merging the new files
  on top of the old version.

### Bug Fixes

- Cross-drive local **Move** now runs the free-space pre-check (previously only Copy did).
- FTP **download** uses extended-length paths, so very long PS5 game paths work on Windows.
- FTP **download resumes**: files already fully present (matching size) are skipped.
- PPSA-only layout **preview** now shows the version suffix, matching the folder actually created.
- Free-space estimate ignores the "size unavailable" marker.
- Speed-limited uploads no longer leak a file handle on a failed retry.
- Cancelling a verified copy now aborts mid-hash promptly.
- A failed transfer no longer shows the previous transfer's summary numbers.

---

## [2.4.8] — 2026

### Bug Fixes — FTP scan UI (information loss)

**SIZE column stuck on a spinner and "sizing…" never finishing**
When an FTP game's size walk failed all retries (broken/missing sce_sys, daemon
connection-limit timeouts) or a game had no resolvable path, the sizing loop advanced
its internal counter but sent no size-update event. If that happened on the last game,
the renderer never saw done ≥ total, so the "Calculating sizes…" overlay, the progress
bar, and the per-row ⟳ spinners stayed up forever. Every sizing outcome now emits a
terminal size-update (with a "size unavailable" marker), plus a final completion event
as a backstop, so the scan always finishes and unsized games show "—" instead of a
permanent spinner.

**Zero-byte FTP games kept spinning**
A game that sized successfully to 0 bytes (only shader/save dirs, or beyond the depth
cutoff) never had its spinner replaced because the update only painted sizes > 0. Sizes
of 0 now render as "0 B".

**Duplicate copies of a game showed each other's size**
The same game present on two mounts shares a content ID. A size-update for one copy was
also being applied to the other (matched by content ID), showing a wrong/early size. The
content-ID match is now used only when no folder path is supplied, so each copy resolves
to its own size.

**FTP cover art did not appear until the scan finished**
The app fetched FTP covers in a background pass and broadcast "cover-ready" events, but
the renderer had no handler for them, so covers only appeared at the very end. Covers now
pop in live as each one downloads.

### Reliability

**Large FTP libraries silently failed to persist**
Saved scan results included the entire parsed param.json per game (≈30 localized titles),
which could exceed the browser storage quota on big FTP libraries and silently drop the
saved results. The heavy param data is now stripped from the saved copy (kept in memory),
and a storage-full condition is surfaced instead of being ignored.

---

## [2.4.7] — 2026

### Improvements

**Find PS5 now scans all known payload FTP ports**
Discovery previously probed only 2121/1337/1338. It now scans every port PS5 homebrew
FTP payloads are known to use — **1337 and 2121 first**, then 1338, 21 and 9090 — and
verifies the FTP banner on each. Consoles whose FTP server runs on a less common port
are detected, and a port that merely accepts TCP without being FTP (e.g. a 2121 or 9090
service that sends no banner) no longer masks the real server. The preferred-port order
when more than one is a valid FTP server is 1337 → 2121 → 1338 → 21 → 9090.

---

## [2.4.6] — 2026

### Bug Fixes

**Find PS5 missed consoles with a non-FTP service on port 2121**
Auto-discovery collected every open port per device, then deduplicated to the
highest-priority port (2121 → 1337 → 1338) *before* checking for an FTP banner — and
verified only that one port. If a console had something on 2121 that accepts a TCP
connection but isn't an FTP server (no `220` banner) while its real FTP server ran on
1337, discovery picked 2121, failed verification, and discarded the working 1337 hit.
The console showed as "No PS5 found" even though it was reachable. Now the FTP banner
is verified on **every** open port first, and only verified ports are deduplicated —
so the console resolves to its real FTP port (e.g. 1337).

### Reliability

**Discovery no longer floods the network stack**
On machines with several network interfaces (Ethernet + Wi-Fi + Hyper-V/WSL switches),
the scan opened thousands of sockets simultaneously, which the OS throttles — sometimes
starving the one probe that mattered. Probe concurrency is now capped so every host
gets a fair connection attempt.

---

## [2.4.5] — 2026

### Bug Fixes

**PS5 auto-connect crash on error**
When an FTP auto-connect scan failed, the error handler called an undefined `err()` function, which threw a second error and left the UI stuck. It now logs correctly and resets the connection chip.

**Scan-progress listener removal too broad**
The renderer's "stop listening" call removed *all* scan-progress handlers instead of just its own. It now removes only the handler it registered.

**PPSA-only layout conflict detection**
The pre-transfer conflict check computed the PPSA-only target folder without the version suffix, so it checked a different path than the transfer actually wrote to. The two now match.

### Security

**Local API CORS hardening**
The Developer API previously sent `Access-Control-Allow-Origin: *`, allowing any web page to call it. It now reflects only `http://127.0.0.1` / `http://localhost` origins.

**Request-body size limit enforced**
Oversized API request bodies were rejected but kept buffering in memory until the request ended. The connection is now destroyed immediately and the buffer freed.

### Reliability

**Auto-update retry loop bounded**
The Windows self-replace step retried `copy` forever if the file stayed locked. It now gives up after ~30 seconds and relaunches the existing build instead of spinning.

### UI / UX

- Every modal now closes with **Esc** and a backdrop click (conflict, batch-rename, help, sub-folder picker, and all detail dialogs).
- Keyboard shortcuts (Ctrl+A, Ctrl+R, arrows) no longer fire while typing in a text field.
- Toasts no longer cut each other short when shown in quick succession.
- Light-theme table row hover and zebra striping are now visible (were using dark-only colors).
- `@font-face` import moved to the top of the stylesheet; removed a duplicate CSS rule.

### Accessibility

- Added `aria-label`s to the menu, action, layout, and size-filter dropdowns.
- Associated all FTP configuration labels with their inputs via `for`.

### Housekeeping

- Removed dead code (unused FTP connection pool) and a duplicated skip-list.
- Hoisted the FTP scan skip-list to a module constant (was rebuilt on every recursion).
- `.gitignore` now excludes the runtime `_logs/` directory and archive files.
- Consolidated CI into a single cross-platform build workflow (Windows + macOS + Linux).

---

## [2.4.4] — 2026

### Bug Fixes

**Source folder cleanup buttons showed "Error" after a Move**
After moving games the completion screen shows a "Source folder cleanup" section with a Delete button for each parent folder. Clicking it always showed "Error" — the underlying delete function existed but was never wired up to the UI. Now works correctly: clicking Delete removes the empty parent folder and shows the confirmation inline.

**Scanning an empty folder caused the app to freeze**
If you moved all games out of a folder and then scanned it again, the scan bar would spin forever and the UI would appear locked. This happened because the previous scan had cached the game entries in memory — those stale entries appeared in the table briefly, then the scan returned zero results, and the code that dismisses the scan bar only ran when it saw a clean empty state. The scan bar is now always dismissed when the scan returns no games, and any stale rows from the cache are cleared at the same time.

### Improvements

**FTP connection handling**
The internal FTP lock used a busy-wait loop that polled every 10ms while waiting for a connection slot. It now uses a proper queue — no CPU spin, and concurrent callers are woken immediately when a slot becomes free.

Dead connections in the FTP pool are now detected correctly before being handed to a caller. Previously the liveness check was a no-op (property access that never throws), so closed sockets could be returned and fail silently on first use.

**API — all-drives scan**
Triggering a scan via the Developer API with `"source": "all-drives"` previously only scanned the C: drive. It now scans every connected drive, the same as the UI button does.

**API — browser clients no longer blocked by CORS**
The API's CORS preflight was missing `X-API-Key` from the allowed headers list, which caused browser-based API clients to be rejected before the request was even sent. The allowed headers now include it.

**Game title sanitization**
Backslash characters in game titles were not being stripped when building folder names, which could cause unexpected path behaviour on some transfers. Fixed.

---

## [2.4.0] — 2026

### New Features

**Copy (fast)**
New transfer action that skips SHA-256 hash verification entirely. Ideal for same-drive transfers where re-reading every byte is unnecessary and speed matters more than checksum confirmation.

**File-level Resume**
Interrupted transfers now skip files already fully present at the destination (matching size). Only missing or partial files are re-copied, so a crashed mid-transfer can be restarted without re-sending everything.

**Free-Space Pre-check**
Before starting any local copy, PS5 Vault verifies the destination has sufficient free space (with a 512 MB safety buffer). An error is shown immediately if there is not enough room — no more discovering halfway through a transfer that the drive is full.

**Show-All Dropdown**
All recent paths and FTP configs appear instantly when clicking any path input field — no typing required. Items are filtered by substring as you type. Full keyboard navigation: Arrow keys move the selection, Enter commits, Escape dismisses, Tab moves focus. The dropdown is positioned relative to `document.body` so it is never clipped inside a scroll container.

**Porkfolio Layout**
New destination layout that produces `{dest}/{Game Name} ({version}) {PPSAID}/` — the folder naming format expected by the Porkfolio backporting workflow.

### Improvements

- Dropdown items now use `text-overflow: ellipsis` and `white-space: nowrap` so very long paths do not break the dropdown layout
- `maxWidth` is capped to the associated input element's width to prevent dropdowns from overflowing the viewport on narrow windows
- `selectItem` commits the selected value immediately without a `blur()` timeout — focus remains with the input and the value is available instantly
- `positionDropdown` sets both `width` and `maxWidth` from `getBoundingClientRect` so the dropdown always matches the input precisely

### Bug Fixes

- Fixed dropdown appearing wider than its associated input on narrow windows
- Fixed `getFocusedItem` helper being declared but never called — dead code removed
- Fixed transfer progress stuck at 0% in some local-to-local copy scenarios when `totalSize` was 0 at transfer start; now falls back to a parallel stat walk with a `go-counting` progress event
- Fixed `addRecentFtp` being called with a raw URL string instead of a config object in some code paths

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
