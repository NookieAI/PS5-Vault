# PS5 Vault

PS5 Vault — quickly find, organize and move PS5 PPSA/game folders. Portable, verified copy/move, and conflict-safe operations — designed for fast library management.


<iframe src="https://streamable.com/e/6257gm" width="100%" height="100%" frameborder="0" allowfullscreen style="width:100%;height:100%;position:absolute;left:0px;top:0px;overflow:hidden;"></iframe></div>


Why you'll like it
- Fast scanning for PPSA and param.json metadata with cover previews.
- Safe copy (SHA‑256 verified) and intelligent move (fast rename when possible).
- Flexible target layouts: Game/PPSA, Game-only, etaHEN, itemZFlow.
- Conflict handling: Overwrite / Skip / Rename with safety checks to prevent accidental deletions.
- Portable single-file EXE support and a large splash screen for polished distribution.

Quick start
1. Download and run the portable EXE (no installer required).
2. Click Browse → choose your Source (drive/folder) and press SCAN.
3. Select entries, pick Destination, choose Action and Layout.
4. Review the Confirm dialog (authoritative From → To paths computed by the app), then click GO.
5. Monitor progress; results show copied/moved items and any errors.

Important notes
- etaHEN layout: games are placed under <Destination>\etaHEN\games\<GameName> unless your Destination already points inside an etaHEN/games folder. No PPSA subfolder is created for etaHEN.
- Overwrite is guarded: the app will refuse to delete paths outside the Destination you selected.
- Always back up important data before bulk operations.

Builds & customization
- The portable EXE is produced with electron-builder. Add your splash icon at ./assets/splash.ico before building to include a custom splash.
- CI builds can be added to automatically produce artifacts.

Support / Contact
- Developer: Nookie — Discord: nookie_65120
- Report problems with steps to reproduce and any console output for faster help.

License
- Use at your own risk. Please back up your files before large operations.

Short promo line
"PS5 Vault — fast, safe, portable PPSA management for your PS5 library."
