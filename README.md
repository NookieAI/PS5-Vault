<img width="1919" height="1003" alt="image" src="https://github.com/user-attachments/assets/44ea0d82-54c3-4451-a9e7-5a301184426a" />

PS5 Vault is an Electron-based application for organizing and managing PS5 game folders (PPSA packages). It provides safe, verified transfers with progress tracking, conflict resolution, and support for both local and FTP sources. Ideal for PS5 homebrew users managing games on external storage or network shares.

## Features

### Core Functionality
- **Game Scanning**: Recursively scan local directories or FTP servers for PS5 game folders containing `param.json` files.
- **Verified Transfers**: Copy or move games with hash verification to ensure data integrity.
- **Progress Tracking**: Real-time progress bars, ETA calculations, and speed metrics during transfers.
- **Conflict Resolution**: Handle existing files with options to skip, rename, or overwrite.
- **Batch Operations**: Select multiple games for bulk operations, including batch delete.

### Layout Options
Organize games into various directory structures:
- **Game / PPSA**: `Destination/GameName/PPSAName`
- **Game Only**: `Destination/GameName`
- **PPSA Only**: `Destination/PPSAName`
- **etaHEN Default**: `Destination/etaHEN/games/GameName`
- **itemZFlow Default**: `Destination/games/GameName`

### FTP Support
- Scan FTP servers (e.g., PS5 with etaHEN) directly.
- Auto-detects common paths like `/mnt/ext1/etaHEN/games`.
- Supports anonymous or authenticated access.
- Default port 1337 for PS5 FTP.

### User Interface
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

### Additional Features
- **Version-Based Naming**: Appends game version in brackets (e.g., `GameName (01.000.002)`) to folder names.
- **Size Calculation**: Displays total size for each game, including FTP size caching.
- **Batch Delete**: Permanently delete selected games with confirmation.
- **Export/Import Settings**: Save and load app settings and game lists (hidden buttons).
- **Notifications**: Desktop notifications on transfer completion.
- **Cancellation**: Abort scans or transfers at any time.

## Installation

1. Ensure [Node.js](https://nodejs.org/) is installed (v16+ recommended).
2. Clone or download the repository.
3. Install dependencies:
