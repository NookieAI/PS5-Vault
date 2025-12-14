# PS5 Vault

PS5 Vault is a desktop utility that helps organize PS5 PPSA game folders into consistent destination layouts. It scans a source folder for validated game folders (PPSA/app packages), shows thumbnails and metadata, and can create/copy/move the selected entries into structured destinations such as "Game / PPSA", etaHEN or itemZFlow formats.

<img width="960" height="501" alt="ps5 vault 016" src="https://github.com/user-attachments/assets/6f510e79-e5f1-4250-afe1-95d240e75050" />

This README covers features, how the UI works, available actions & layouts, integration points, and troubleshooting.

---

## Key features

- Fast, validated scan of a Source folder for PPSA / game folders
- Thumbnail previews with hover preview popup
- Selectable scan results with "Select All", "Unselect All", and per-row checkbox selection
- Destination selection (browse)
- Action options:
  - Create folder (only create target folders)
  - Copy (verified)
  - Move
- Layout options:
  - Game / PPSA (Destination/GameName/PPSAXXXXX)
  - Game only (Destination/GameName)
  - PPSA only (Destination/PPSAXXXXX)
  - etaHEN default (Destination/etaHEN/games/GameName)
  - itemZFlow default (Destination/games/GameName)
- Confirm dialog with per-item From → To preview before operations
- Conflict resolution modal (Overwrite / Skip / Rename)
- Single total progress bar with ETA while operations run (UI locked during run)
- Per-item operation result indicators (moved / copied / error) shown in the results modal
- Local storage for last used Source and Destination paths
- Small path labels hide trailing `sce_sys` to reduce clutter
- Simple built-in "Help" popup with usage steps and layout directory examples
- Quick Discord copy/link button for support/contact
- Accessible keyboard behavior — Escape to close modals

---

## UI overview

Top bar
- App title and small brand area
- Utility buttons: Help, Select All, Unselect All, Clear, Discord

Controls row (left)
- Source field + Browse button + SCAN button
- Progress/scan label and total progress bar area (appears under Source)

Controls row (right)
- GO button
- Destination field + Browse button
- Action and Layout selects (right-aligned under Destination Browse)

Results area
- Table showing checkboxes, cover (thumbnail), GAME (title + ID), and FOLDER (path)
- Click row or checkbox to select items
- Hover thumbnails show a larger preview popup

Result / Operation modal
- After operation, a modal shows per-item summary entries with "From" and "To"
- Each entry has a right-aligned status indicator (button-styled) showing `moved`, `copied`, or `error`
- Close button dismisses

---

## Layout directory structures

- Game / PPSA
  - Destination/GameName/PPSAXXXXX
  - Creates both a human-friendly GameName folder and the corresponding PPSA folder inside it.

- Game only
  - Destination/GameName

- PPSA only
  - Destination/PPSAXXXXX

- etaHEN default
  - Destination/etaHEN/games/GameName

- itemZFlow default
  - Destination/games/GameName

The app tries to derive safe GameName and PPSA names automatically (sanitizes illegal characters).

---

## How to use

1. Click "Browse" next to Source and choose the folder or drive that contains your game directories.
2. Click "SCAN" — the app will locate validated game folders and list them with thumbnails.
3. Select the entries you want to process using the checkboxes (use Select All / Unselect All).
4. Pick a Destination using the Destination Browse button.
5. Under Destination, choose Action (Create folder / Copy / Move) and Layout.
6. Click "GO". A confirmation dialog will show exact From → To mappings — review and confirm.
7. While the operation runs the UI will lock and a single total progress bar with ETA will appear under the Source field. Wait until it finishes.
8. View results in the Operation Results modal (per-item moved/copy/error indicators).

---

## Integration / Preload API (hooks)

PS5 Vault expects a platform/preload integration that exposes a `ppsaApi` object to the renderer with these functions/callback hooks (these names are used by the renderer):

- pickDirectory() : Promise<string|null>
  - Opens a folder picker and returns the selected path.

- scanSourceForPpsa(sourcePath) : Promise<Array|{items:Array}>
  - Scans the provided source path and returns an array of validated entries.
  - Each entry object may contain:
    - displayTitle, dbTitle, folderName
    - ppsaFolderPath, folderPath, contentFolderPath
    - contentId, skuFromParam
    - iconPath (file path to thumbnail)

- ensureAndPopulate({ items, dest, action, layout, overwriteMode }) : Promise<{ results: Array, error?: string }>
  - Performs the actual create/copy/move operations.
  - Returns results for each item with fields like `item`, `from`/`source`, `target`, `moved`/`copied`, `error`.

- checkPathsExist(paths: string[]) : Promise<Array<{path:string, exists:boolean}>>
  - Optional: verifies whether target paths already exist (used to show conflict modal).

- onScanProgress(callback)
  - Optional: register a callback for scan progress updates (used to update small scan label).

- onOperationComplete(callback)
  - Optional: register for notifications when operations complete.

Note: If the renderer cannot find these APIs it will show helpful error modals/toasts.

---

## Accessibility & keyboard

- Escape key closes Help / Confirm / Conflict / Result modals when they are open.
- Buttons and inputs have accessible labels and roles where applicable.
- Thumbnails include alt text where available.

---

## Troubleshooting

- "Picker not available" — the platform integration did not expose `pickDirectory`.
- "Backend missing" — ensure your preload/main process exposes the expected `ppsaApi` functions.
- If operations fail unexpectedly, the results modal will include per-item errors; use the "Operation exception" error dialogs for stack/details when available.

---

## Developer notes

- UI stores last used Source and Destination in localStorage keys:
  - `ps5vault.lastSource`
  - `ps5vault.lastDest`
- Small-path normalization removes trailing `sce_sys` for display.
- Thumbnails are displayed using file:// URLs when local icon paths are provided.

---

## Contributing

- Fork the repo, make changes, open a PR with clear description.
- Keep UI/UX accessible and avoid breaking existing preload contract.

---
