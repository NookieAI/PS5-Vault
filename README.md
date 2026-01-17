<div align="center">
  <img width="1919" height="1003" alt="PS5 Vault Screenshot" src="https://github.com/user-attachments/assets/44ea0d82-54c3-4451-a9e7-5a301184426a" />
</div>

# PS5 Vault

PS5 Vault is a desktop application for organizing PS5 PPSA game folders safely. It enables scanning, transferring, managing, and customizing your PS5 game library locally or over FTP, with a focus on ease of use and data integrity.

## Features

### **Source Scanning & Discovery**
   - **Local Directory Scanning**: Browse and select local folders (e.g., on your PC) to scan for PS5 game folders (containing `param.json`).
   - **FTP Scanning**: Connect directly to your PS5 via FTP to scan for games without downloading them first. Supports IP addresses or FTP URLs (e.g., `ftp://192.168.1.100:2121`).
   - **Automatic Game Detection**: Scans for PPSA folders, extracts metadata like title, content ID, version, size, and cover art from `param.json`.
   - **Deep Scanning**: Recursively scans subdirectories up to a configurable depth (default: 12 levels) for comprehensive library discovery.
   - **Progress Feedback**: Real-time scan progress with item count, ETA, and current folder being scanned.
   - **Deduplication**: Automatically removes duplicate entries based on PPSA key, content ID, and version.

### **FTP Integration & Remote Operations**
   - **FTP Connection**: Enter PS5 IP, port (2121 preferred, 1337 alt), path (e.g., `/mnt/ext1/etaHEN/games`), and credentials (anonymous login supported).
   - **FTP Transfer**: Upload games directly to PS5 (e.g., from PC to PS5) or download from PS5 (from PS5 to PC).
   - **FTP Management**: Delete, rename, and manage game folders on PS5 over FTP.
   - **FTP Retry & Error Handling**: Automatic retries (up to 2 attempts) for network failures with user notifications.
   - **FTP Path Support**: Handles encoded paths (e.g., spaces as `%20`) and POSIX-style paths for cross-platform compatibility.
   - **Secure FTP Note**: Warns about unencrypted FTP; recommends secure networks.

### **Transfer & Organization**
   - **Action Types**: Choose between "Create folder" (dry-run), "Copy" (verified with hash checking), or "Move" (relocate files).
   - **Destination Layouts**: Organize games in various structures:
     - Game / PPSA (e.g., `GameName/PPSAName`)
     - Game only (flattens PPSA into `GameName`)
     - PPSA only (e.g., `PPSAName`)
     - etaHEN default (e.g., `etaHEN/games/GameName`)
     - itemZFlow default (e.g., `games/GameName`)
     - Dump Runner default (e.g., `homebrew/GameName`)
     - Custom (prompt for custom folder name, single game only)
   - **Batch Transfers**: Select multiple games and transfer them all at once.
   - **Conflict Resolution**: Automatically handle existing files by skipping or renaming (e.g., add `(1)` suffix).
   - **Progress Tracking**: Live progress bar, file count, speed (MB/s), ETA, current file, and total transferred size.
   - **Transfer Stats**: Post-transfer summary with moved/copied/uploaded counts, total size, and max speed.
   - **Resume Transfers**: Save and resume interrupted transfers across sessions.
   - **Verified Transfers**: Uses hash verification for copies to ensure data integrity.

### **Game Management & Editing**
   - **Select & Deselect**: Checkboxes for individual games; header checkbox for all visible; "Select All" and "Unselect All" buttons.
   - **Delete Selected**: Permanently delete selected games (local or FTP) with confirmation prompt.
   - **Rename Selected**: Rename individual games (local or FTP) with sanitization (removes invalid characters).
   - **Batch Rename**: Rename multiple games at once using patterns (e.g., `{name} - Backup`).
   - **Show in Folder**: Click folder paths to open the directory in your system's file explorer.
   - **Refresh Results**: Automatically refresh scan results after operations (e.g., delete or transfer).

### **Search, Sort, & Filtering**
   - **Search Games**: Real-time filter by game name using the search bar (case-insensitive).
   - **Sorting**: Click table headers to sort by Name (default), Size, or Folder path.
   - **Persistent Results**: Saves last scan results locally and restores on app restart.

### **User Interface & Customization**
   - **Theme Toggle**: Switch between dark and light themes by clicking "Made by Nookie".
   - **Image Previews**: Hover over game covers for enlarged previews (with mouse-following).
   - **Modals**: Clean modal dialogs for confirmations, conflicts, FTP config, renaming, and help.
   - **Toasts & Notifications**: Brief on-screen messages for actions, errors, and progress (5-second timeout).
   - **Desktop Notifications**: System tray notifications for transfer completion.
   - **Keyboard Shortcuts**:
     - Ctrl+A: Select all visible games
     - Ctrl+R: Rescan source
     - F1: Open help
     - Arrow keys: Navigate table rows
     - Enter/Escape: Confirm/cancel in modals

### **Data Management & Persistence**
   - **Recent Paths**: Stores and autocompletes recent source/destination paths and FTP configs (up to 10 sources, 10 dests, 5 FTP).
   - **Export/Import**: Export settings and scan results to JSON; import to restore.
   - **Clear Data**: Logo click to clear all recent paths and fields (with confirmation).
   - **Local Storage**: Saves last source/destination, scan results, settings, and transfer state.

### **Help & Support**
   - **Built-in Help**: Comprehensive help modal with setup guides, layout examples, FTP tips, and troubleshooting.
   - **External Links**: Quick access to GitHub, Ko-fi (support), and Discord.
   - **Version Display**: Shows current app version (e.g., v1.1.0) in the UI.

### **Advanced & Technical Features**
   - **File Size Calculation**: Estimates total size for transfers (skipped for FTP to improve speed).
   - **Path Sanitization**: Automatically cleans folder names (removes special characters, limits length).
   - **Cancel Operations**: Cancel scans or transfers at any time with progress saving.
   - **Error Logging**: Console logs for debugging (e.g., FTP errors, transfer failures).
   - **Cross-Platform**: Works on Windows (primary), with path handling for POSIX (FTP).
   - **Performance Optimizations**: Concurrency limits (24 threads), caching for FTP sizes, lazy loading for images.

### **Safety & Validation**
   - **Path Validation**: Checks for absolute paths, prevents self-overlaps (e.g., moving to subfolder).
   - **Confirmation Prompts**: Warnings for destructive actions (delete, clear data).
   - **Hash Verification**: Ensures copied files match originals.
   - **Network Safety**: Timeout handling for FTP (15s), retry logic.

## Installation

1. Download the latest release from [GitHub](https://github.com/nookie/ps5vault).
2. Run the portable executable for Windows.
3. Launch PS5 Vault.

## Usage

1. **Scan Source**: Enter a local path or FTP URL in the Source field and click SCAN.
2. **Select Games**: Use checkboxes to select games from the results table.
3. **Configure Transfer**: Choose Action (Move/Copy), Layout, and Destination.
4. **Transfer**: Click GO to start the operation.
5. **Monitor Progress**: Watch real-time progress, ETA, and stats in the modal.

For detailed guides, press F1 for built-in help.

## Support & Links

- [GitHub Repository](https://github.com/NookieAI/PS5-Vault)
- [Support on Ko-fi](https://ko-fi.com/nookie_65120)
- [Join Discord](https://discord.gg/nj45kDSBEd)

Made with ❤️ by Nookie. Version 1.1.0.
