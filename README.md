# PS5 Vault

<div align="center">
  <img width="1919" height="1003" alt="PS5 Vault Screenshot" src="https://github.com/user-attachments/assets/44ea0d82-54c3-4451-a9e7-5a301184426a" />
</div>

PS5 Vault is an Electron-based application for organizing and managing PS5 game folders (PPSA packages). It provides safe, verified transfers with progress tracking, conflict resolution, and support for both local and FTP sources. Ideal for PS5 homebrew users managing games on external storage or network shares.

<div align="center">
  :heart: Support my project! <a href="https://ko-fi.com/nookie_65120">https://ko-fi.com/nookie_65120</a> :heart:
</div>

## Features

- **Local Scanning**: Scan local folders for validated PS5 game entries (requires param.json).
- **FTP Support**: Directly scan and transfer games from your PS5 via FTP (using ftpsrv or etaHEN). Copy or move files from FTP source to local destination. Redesigned modal in v1.0.8 for better usability.
- **Multiple Layouts**: Choose from various destination folder structures (Game/PPSA, Game only, PPSA only, etaHEN default, etc.).
- **Batch Operations**: Select, rename, delete, or move multiple games at once.
- **Conflict Resolution**: Automatically handle existing files with skip or rename options.
- **Progress Tracking**: Real-time progress bars, ETA, and transfer statistics.
- **Help System**: Comprehensive in-app help with step-by-step instructions.
- **Dark/Light Theme**: Toggle between themes for comfortable viewing.
- **Keyboard Shortcuts**: Ctrl+A (select all), Ctrl+R (rescan), F1 (help), Arrow keys (navigate).
- **Cross-Platform**: Built with Electron for Windows, macOS, and Linux.

## Layout Options

Organize games into various directory structures:

- **Game / PPSA**: `Destination/GameName/PPSAName`
- **Game Only**: `Destination/GameName`
- **PPSA Only**: `Destination/PPSAName`
- **etaHEN Default**: `Destination/etaHEN/games/GameName`
- **itemZFlow Default**: `Destination/games/GameName`
- **Dump Runner Default**: `Destination/homebrew/GameName`

## FTP Support

- Limited to read-only for FTP scanning.
- Displays games found in FTP servers (PS5 with etaHEN) using standard FTP format (e.g., `192.168.137.100/mnt/usb0/etaHEN`).
- Not working for root scans; must know the folder path.
- Auto-detects common paths like `/mnt/ext1/etaHEN/games`.
- Supports anonymous access.
- Default port 1337 for PS5 FTP.

## User Interface

- **Dark/Light Theme Toggle**: Click "Made by Nookie" to switch themes.
- **Recent Paths**: Dropdowns for last 10 source and destination paths.
- **Image Previews**: Hover over game covers for enlarged previews.
- **Keyboard Shortcuts**:
  - `Ctrl+A`: Select all visible games.
  - `Ctrl+R`: Rescan source.
  - `F1`: Open help modal.
  - Arrow keys: Navigate table rows.
- **Modals**:
  - Confirmation modal before transfers with source/target preview.
  - Conflict resolution modal.
  - Detailed transfer results modal with success/error badges.

## Additional Features

- **Version-Based Naming**: Appends game version in brackets (e.g., `GameName (01.000.002)`) to folder names.
- **Size Calculation**: Displays total size for each game, including FTP size caching.
- **Batch Delete**: Permanently delete selected games with confirmation.
- **Export/Import Settings**: Save and load app settings and game lists (hidden buttons).
- **Notifications**: Desktop notifications on transfer completion.
- **Cancellation**: Abort scans or transfers at any time.

## Installation

1. Download the latest release from [GitHub Releases](https://github.com/NookieAI/PS5-Vault/releases). (No installation required)
2. For FTP scanning, ensure your PS5 and PC are on the same network. Check the Help button in the app for more details.

## Tips

- Test with one game first.
- Use Move for fastest transfers on the same drive.
- Back up originals before transferring.
- For large libraries, prefer local scanning over FTP.

## Support

- **Discord**: @Nookie_65120
- **Donate**: [Nookie](https://ko-fi.com/nookie_65120)

Made with ❤️ by Nookie
