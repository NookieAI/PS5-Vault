# PS5 Vault

[https://github.com/user-attachments/assets/6f510e79-e5f1-4250-afe1-95d240e75050
](https://github-production-user-asset-6210df.s3.amazonaws.com/188130079/526289581-6f510e79-e5f1-4250-afe1-95d240e75050.png)
PS5 Vault is an Electron app for discovering and organizing PlayStation 5 PPSA folders. It scans a source directory, validates game metadata, and creates clean target layouts compatible with tools like etaHEN and itemZFlow. Transfers are safety‑first with hash verification, overlap protection, and clear confirmations.

---

## Highlights

- Fast scan with validated PPSA results
- Thumbnails with hover preview
- Clear confirmations with per‑item From → To before transfer
- Conflict window (Overwrite / Skip / Rename)
- Single progress bar with speed and ETA
- “Select All / Unselect All” and per‑row selection
- Small touches: “Scanning…” label, ESC to close Help, tri‑state header checkbox
- Destination layouts for common PS5 homebrew setups

---

## Getting started

1. Pick a Source folder (drive or root path containing game folders).
2. Click SCAN. Valid entries appear with thumbnails.
3. Select the items to process.
4. Pick a Destination, then choose Action and Layout.
5. Click GO. Review the confirmation window and start the transfer.
6. Follow progress in the modal. Results list shows moved/copied/errors per item.

---

## UI at a glance

- Top bar: Help, Select All, Unselect All, Clear, Discord
- Left controls: Source + Browse, SCAN, “Scanning…” label and scan progress bar
- Right controls: GO, Destination + Browse, Action + Layout (right‑aligned)
- Results table: checkbox, cover, game title/ID, folder path (trailing `sce_sys` hidden for clarity)
- Modals: Confirmation (pre‑transfer), Conflict (if needed), Operation Results

---

## Actions and layouts

Actions
- Create folder: only creates destination folders
- Copy (verified): copies with checksum verification
- Move: fast same‑disk rename or safe copy+remove across disks

Layouts
- Game / PPSA → Destination/GameName/PPSAXXXXX
- Game only → Destination/GameName
- PPSA only → Destination/PPSAXXXXX
- etaHEN default → Destination/etaHEN/games/GameName
- itemZFlow default → Destination/games/GameName

Names are sanitized automatically. PPSA and GameName are derived from metadata or folder names.

---

## How transfers work

- Confirmation: shows each item’s From → To with the selected Action and Layout.
- Conflicts: if a target exists, choose Overwrite / Skip / Rename. Overwrite avoids “(1)” suffixes.
- Overlap safety: moving into the same target (etaHEN/itemZFlow) safely no‑ops and only removes empty PPSA subfolders.

---

## Troubleshooting

- Nothing happens after GO: ensure Destination is set and items are selected.
- “Picker not available”: preload didn’t expose the folder picker.
- “Backend missing”: preload/main must expose the required `ppsaApi` functions.
- Errors per item: check the Operation Results modal for the exact cause.

---

## Shortcuts & accessibility

- ESC closes Help / Confirmation / Conflict / Results
- Thumbnails include alt text; interactive elements have labels
- Hover preview opens after ~1s and follows the cursor

---

## Integration (preload API)

The renderer expects a `ppsaApi` with:

- `pickDirectory(): Promise<{canceled:boolean, path?:string}>`
- `scanSourceForPpsa(source: string): Promise<Array|{items:Array}>`
- `ensureAndPopulate({ items, dest, action, layout, overwriteMode }): Promise<{results:Array, error?:string}>`
- `checkConflicts(items, dest, layout): Promise<Array<{item:string, target:string}>>`
- `onScanProgress(handler: (payload) => void): () => void`
- `cancelOperation(): Promise<{ok:boolean}>`
- `openExternal(url: string): Promise<{ok:boolean}>`
- `copyToClipboard(text: string): Promise<{ok:boolean}>`

If these are missing, the UI will show a toast and disable the affected action.

---

## Notes

- Last Source/Destination are remembered locally
- Paths are normalized for display (hides trailing `sce_sys`)
- The Discord button copies `nookie_65120` and attempts to open the Discord app or falls back to the browser

---
