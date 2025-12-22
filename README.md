# PS5 Vault

<img width="1920" height="1002" alt="image" src="https://github.com/user-attachments/assets/46350dec-7be5-4777-a60e-96a26b20c332" />

PS5 Vault is an Electron app for discovering and organizing PlayStation 5 PPSA folders. It scans a source directory, validates game metadata, and creates clean target layouts compatible with tools like etaHEN and itemZFlow. Transfers are safety‑first with hash verification, overlap protection, and clear confirmations.

## Highlights

- Fast scan with validated PPSA results (now detects any folder with `sce_sys/param.json`, no strict naming required)
- Thumbnails with hover preview
- Clear confirmations with per‑item From → To before transfer
- Conflict window (Overwrite / Skip / Rename)
- Single progress bar with speed and ETA
- “Select All / Unselect All” and per‑row selection
- Small touches: “Scanning…” label, ESC to close Help, tri‑state header checkbox
- Destination layouts for common PS5 homebrew setups
- Preserved folder structure: Internal game folders (e.g., `sce_sys`, `trophies`) are maintained without flattening

## Getting started

1. Pick a Source folder (drive or root path containing game folders).
2. Click SCAN. Valid entries appear with thumbnails.
3. Select the items to process.
4. Pick a Destination, then choose Action and Layout.
5. Click GO. Review the confirmation window and start the transfer.
6. Follow progress in the modal. Results list shows moved/copied/errors per item.

## UI at a glance

- **Top bar**: Help, Select All, Unselect All, Clear, Discord
- **Left controls**: Source + Browse, SCAN, “Scanning…” label and scan progress bar
- **Right controls**: GO, Destination + Browse, Action + Layout (right‑aligned)
- **Results table**: checkbox, cover, game title/ID, folder path (full paths shown; sce_sys hidden for clarity in some views)
- **Modals**: Confirmation (pre‑transfer), Conflict (if needed), Operation Results

## Actions and layouts

### Actions

- **Create folder**: only creates destination folders
- **Copy (verified)**: copies with checksum verification and preserved structure
- **Move**: fast same‑disk rename or safe copy+remove across disks, preserving structure

### Layouts

- **Game / PPSA** → Destination/GameName (PPSA wrapper removed, contents flattened into GameName)
- **Game only** → Destination/GameName
- **PPSA only** → Destination/PPSAXXXXX
- **etaHEN default** → Destination/etaHEN/games/GameName
- **itemZFlow default** → Destination/games/GameName

Names are sanitized automatically. PPSA and GameName are derived from metadata or folder names. All layouts preserve internal folder structures (e.g., sce_sys remains a subfolder).

## How transfers work

- **Confirmation**: shows each item’s From → To with the selected Action and Layout.
- **Conflicts**: if a target exists, choose Overwrite / Skip / Rename. Overwrite avoids “(1)” suffixes.
- **Overlap safety**: prevents invalid moves; temporary files are cleaned on errors/cancellations.
- **Structure preservation**: PPSA wrappers are removed, but all game data folders (e.g., sce_sys, trophies) are kept intact.

## Troubleshooting

- **Nothing happens after GO**: ensure Destination is set and items are selected.
- **“Picker not available”**: preload didn’t expose the folder picker.
- **“Backend missing”**: preload/main must expose the required ppsaApi functions.
- **Errors per item**: check the Operation Results modal for the exact cause.
- **Scan finds nothing**: Ensure `param.json` exists in `sce_sys` subfolder and is valid JSON.

## Shortcuts & accessibility

- ESC closes Help / Confirmation / Conflict / Results
- Thumbnails include alt text; interactive elements have labels
- Hover preview opens after ~1s and follows the cursor

## Integration (preload API)

The renderer expects a `ppsaApi` with:

- `pickDirectory()`: Promise<{canceled:boolean, path?:string}>
- `scanSourceForPpsa(source: string)`: Promise<Array|{items:Array}>
- `ensureAndPopulate({ items, dest, action, layout, overwriteMode })`: Promise<{results:Array, error?:string}>
- `checkConflicts(items, dest, layout)`: Promise<Array<{item:string, target:string}>>
- `onScanProgress(handler: (payload) => void)`: () => void
- `cancelOperation()`: Promise<{ok:boolean}>
- `openExternal(url: string)`: Promise<{ok:boolean}>
- `copyToClipboard(text: string)`: Promise<{ok:boolean}>

If these are missing, the UI will show a toast and disable the affected action.

## Changelog

### [1.0.3] - 2024-12-22
- **Added**: Flexible scan detects any folder with `sce_sys/param.json`, ignoring strict PPSA naming.
- **Added**: Preserved folder structure in moves/copies; internal subfolders (e.g., `sce_sys`) no longer flattened.
- **Added**: Improved temp file cleanup on errors/cancellations.
- **Changed**: Layouts now universally flatten PPSA contents into game folders without PPSA subfolders.
- **Changed**: Full paths displayed in UI (no truncation in table).
- **Fixed**: Path overlap detection and conflict resolution.

## Notes

- Last Source/Destination are remembered locally
- Paths are normalized for display (hides trailing sce_sys)
- The Discord button copies `nookie_65120` and attempts to open the Discord app or falls back to the browser
- Requires Electron 22+ for best performance
