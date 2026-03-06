# Building PS5 Vault

This guide produces a single portable `.exe` that runs from any folder with no installation.

---

## Prerequisites

Install these once. If you already have them, skip ahead.

### 1. Node.js (v18 or later)
Download the LTS installer from https://nodejs.org and run it.  
Verify: open a new terminal and type `node -v` — you should see `v18.x.x` or higher.

### 2. Git (optional — only needed if cloning)
Download from https://git-scm.com if you don't have it.

---

## Project Setup

### Step 1 — Place your files

Make sure your project folder contains all of these files:

```
ps5-vault/
├── main.js
├── preload.js
├── renderer.js
├── scan.js
├── ftp.js
├── utils.js
├── ui-renderers.js
├── datalist-init.js
├── help.js
├── index.html
├── package.json          ← provided in this release
├── README.md
├── CHANGELOG.md
└── assets/
    └── icon.ico          ← required for the exe icon
```

> **Icon file:** The build requires `assets/icon.ico`. If you don't have one, create an `assets/` folder and either add your icon file or temporarily remove the `"icon"` lines from `package.json` under `"win"` and `"nsis"`.

### Step 2 — Install dependencies

Open a terminal in the project folder and run:

```bash
npm install
```

This installs Electron, electron-builder, basic-ftp, and readdirp into `node_modules/`. It will take a minute or two on first run.

---

## Building

### Portable .exe (recommended)

A single self-contained `.exe` — no installer, runs from any folder including a USB drive.

```bash
npm run build
```

Output: **`dist/PS5 Vault-2.0.0-portable.exe`**

The portable exe stores its data in `%APPDATA%\ps5vault` on the user's machine (not next to the exe), so it can be placed anywhere.

---

### Installer .exe (optional)

A standard Windows installer with Start Menu entries and an uninstaller.

```bash
npm run build:installer
```

Output: **`dist/PS5 Vault-2.0.0-setup.exe`**

---

### Both at once

```bash
npm run build:all
```

---

## Running without building (development)

To run the app directly from source without packaging:

```bash
npm start
```

---

## Troubleshooting

**`npm install` fails with permission errors**
Run the terminal as Administrator, or switch to a folder you own (e.g. `C:\Users\YourName\ps5-vault`).

**`Cannot find module 'electron'`**
Run `npm install` again. If it still fails, delete `node_modules/` and `package-lock.json` and try once more.

**Build fails: `icon.ico not found`**
Create the `assets/` folder and add an `icon.ico` file, or remove the `"icon"` references from `package.json`.

**`dist/` folder is empty after build**
Check the terminal output for errors. The most common cause is a missing icon file or a syntax error in `package.json`.

**App opens but shows a blank window**
Run `npm start` and check the terminal for errors. The most common causes are a missing `index.html` or a broken `preload.js`.

**Antivirus flags the portable exe**
This is a false positive — all Electron portable executables trigger some heuristic scanners because they self-extract to a temp folder on first run. Add an exception for the file or use the installer build instead (NSIS installers are less frequently flagged).

---

## File sizes

| Build type | Approximate size |
|---|---|
| Portable .exe | ~85–95 MB |
| Installer .exe | ~80–90 MB |
| Installed footprint | ~250–300 MB |

Electron bundles a full Chromium runtime, which accounts for most of the size. This is expected and normal.

---

## Why not Tauri?

Tauri produces smaller executables (~5–15 MB) by using the OS's built-in WebView instead of bundling Chromium. However, Tauri requires all backend logic to be written in Rust. PS5 Vault's backend (`main.js`) is ~2,000 lines of Node.js including a custom FTP engine, parallel file-walking, disk-cache management, and cross-drive transfer logic. Porting that to Rust would be a complete rewrite with no functional benefit for end users. electron-builder with portable mode is the correct tool for this project.
