:heart: Support my project! https://ko-fi.com/nookie_65120 :heart:

<img width="1919" height="1003" alt="image" src="https://github.com/user-attachments/assets/44ea0d82-54c3-4451-a9e7-5a301184426a" />

PS5 Vault is an Electron-based application for organizing and managing PS5 game folders (PPSA packages). It provides safe, verified transfers with progress tracking, conflict resolution, and support for both local and FTP sources. Ideal for PS5 homebrew users managing games on external storage or network shares.

## Features

- **Scan & Organize**: Automatically detect validated game folders (containing `param.json`) with thumbnails.
- **Flexible Transfers**: Copy, move, or create folders with various layout options (e.g., etaHEN, itemZFlow, dump_runner, Custom).
- **FTP Support**: Scan games directly from PS5 (experimental, for smaller libraries, avoid Astro Bot with ftp).
- **Conflict Resolution**: Handle existing files safely with skip or rename options only.
- **Progress Monitoring**: Real-time progress bars and detailed results.
- **Themes**: Dark/light mode toggle.
- **Keyboard Shortcuts**: Ctrl+A (select all), Ctrl+R (rescan), F1 (help).

## Usage

1. **Set Source**: Browse local folder or (`C:\, Z:\`) or ftp (`ftp://192.168.1.100/mnt/usb0/games, 192.168.1.100/mnt/usb0/games `).
2. **Scan**: Click SCAN to list games.
3. **Select & Configure**: Choose games, set destination, action (copy/move), and layout.
4. **Transfer**: Click GO, confirm, and monitor progress.

## Layout Options
Organize games into various directory structures:
- **Game / PPSA**: `Destination/GameName/PPSAName`
- **Game Only**: `Destination/GameName`
- **PPSA Only**: `Destination/PPSAName`
- **etaHEN Default**: `Destination/etaHEN/games/GameName`
- **itemZFlow Default**: `Destination/games/GameName`

## FTP Support
- Scan FTP servers (e.g., PS5 with etaHEN) directly. (192.168.137.100/mnt/usb0/etaHEN)
- Not working for root scans, must know folder path. 
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

1. Download the latest release from [GitHub Releases](https://github.com/NookieAI/PS5-Vault/releases). (no installation required)
2. For FTP scanning, ensure your PS5 and PC are on the same network. Check Help button in app for more help.

## Tips
- Test with one game first.
- Use Move for fastest transfers on the same drive.
- Back up originals before transferring.
- For large libraries, prefer local scanning over FTP.

## Support

- **Discord**: @Nookie_65120
- **Donate**: [Ko-fi](https://ko-fi.com/nookie_65120)

Made with ❤️ by NookieSupport my project!
