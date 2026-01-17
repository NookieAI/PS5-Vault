<div align="center">
  <img width="1919" height="1003" alt="PS5 Vault Screenshot" src="https://github.com/user-attachments/assets/44ea0d82-54c3-4451-a9e7-5a301184426a" />
</div>

# PS5 Vault

**PS5 Vault** is a powerful, user-friendly desktop application for organizing and managing PlayStation 5 (PS5) game backups (PPSA folders). It supports local and FTP-based scanning, bulk transfers (move/copy), renaming, and more—all designed for PS5 enthusiasts and homebrew users.

## Features

- **Local Scanning**: Scan local folders for validated PS5 game entries (requires param.json).
- **FTP Support**: Directly scan and transfer games from your PS5 via FTP (using ftpsrv or etaHEN). Copy or move files from FTP source to local destination. Redesigned modal in v1.0.8 for better usability, with port-based path auto-detection (e.g., port 1337 defaults to `/mnt/ext1/etaHEN/games` for etaHEN; port 2121 to `/mnt/usb0/games` for ftpsrv).
- **Multiple Layouts**: Choose from various destination folder structures (Game/PPSA, Game only, PPSA only, etaHEN default, etc.).
- **Batch Operations**: Select, rename, delete, or move multiple games at once.
- **Rename Modal**: Use genuine game names from `param.json` for default renaming, or enter custom names for single items.
- **Conflict Resolution**: Automatically handle existing files with skip or rename options.
- **Progress Tracking**: Real-time progress bars, ETA, and transfer statistics.
- **Recent Lists & Autocomplete**: Synced dropdowns for sources (including full FTP URLs), destinations, and FTP configs. Easily re-use IPs, paths, and URLs.
- **Help System**: Comprehensive in-app help with step-by-step instructions.
- **Dark/Light Theme**: Toggle between themes for comfortable viewing.
- **Keyboard Shortcuts**: Ctrl+A (select all), Ctrl+R (rescan), F1 (help), Arrow keys (navigate).
- **Cross-Platform**: Built with Electron for Windows, macOS, and Linux.

## Usage

1. **Set Source**: Enter a local path (C:\) or FTP IP/URL (e.g., `192.168.1.100` for PS5). Full FTP URLs are saved in recent sources for autocomplete.
2. **Scan**: Click SCAN to locate games (works from root for local or FTP sources).
3. **Select Items**: Use checkboxes to pick games. Sort by name, size, or folder by clicking headers.
4. **Set Destination**: Choose a local folder where organized folders will be created.
5. **Choose Action & Layout**: Select move/copy and folder structure. For custom layout, rename modal allows default (from param.json) or custom names.
6. **Transfer**: Click GO, confirm, and monitor progress. Files are transferred from source (local or FTP) to local destination.

For FTP: Ensure your PS5 has ftpsrv running (port 2121) or use etaHEN default (port 1337). You can copy or move games directly from your PS5 to your PC without intermediate steps. The FTP modal has been significantly improved in v1.0.8+ for easier setup, including fixed port assignment and path suggestions.

## FTP Scanning Tips

- IP Address: Find your PS5's IP in Settings > Network.
- Ports & Paths: Port 1337 (etaHEN) auto-sets to `/mnt/ext1/etaHEN/games`; port 2121 (ftpsrv) to `/mnt/ps5/games`. Custom ports default to `/`.
- Note: Sizes will not load over FTP for performance.
- **Recent History**: Full FTP URLs (e.g., `ftp://192.168.1.100:1337/...`) are added to source autocomplete for quick re-use.
- **v1.0.8+ Improvements**: Redesigned FTP configuration modal with better field alignment, consistent styling, and port-based path auto-detection.

## Layout Options

- **Game / PPSA**: `Destination/GameName/PPSAName`
- **Game only**: `Destination/GameName`
- **PPSA only**: `Destination/PPSAName`
- **etaHEN default**: `Destination/etaHEN/games/GameName`
- **itemZFlow default**: `Destination/games/GameName`
- **Dump Runner default**: `Destination/homebrew/GameName`
- **Custom**: Specify your own folder name (opens rename modal for single-item selection).

## Changelog

### [1.0.9] - 2026-01-17
- **Fixed**: FTP modal port assignment bug (was incorrectly using host for port).
- **Improved**: Rename modal now uses genuine names from `param.json` for default preset.
- **Added**: Port-based path auto-detection in FTP modal (1337: etaHEN path; 2121: ftpsrv path).
- **Enhanced**: Synced recent lists and autocomplete dropdowns, including full FTP URLs in source history.
- **Updated**: Better error handling and user guidance for FTP connections.

## Support & Links

- [GitHub Repository](https://github.com/NookieAI/PS5-Vault)
- [Support on Ko-fi](https://ko-fi.com/nookie_65120)
- [Join Discord](https://discord.gg/nj45kDSBEd)
