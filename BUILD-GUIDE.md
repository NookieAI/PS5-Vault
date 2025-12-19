# PS5 Vault — Portable EXE Build Guide (v1.0.2)

A dependable, repeatable checklist for building the Windows portable executable with your icon and minimal size.

---

## 0) Prerequisites

- Windows 10/11 with PowerShell
- Node.js LTS (v18+ recommended)
- Project files present:
  - main.js, preload.js, renderer.js, utils.js, index.html, ui-overrides.css
  - assets/logo.png, assets/icon.ico (multi-size: 16/32/48/64/128/256)

---

## 1) Ensure package.json is complete

Add description and author (electron-builder requires them). Keep the build section as configured.

Quick checklist:
- name: ps5vault
- version: 1.0.2
- description: short sentence about the app
- author: Nookie
- scripts: start, dist
- build.win.icon: assets/icon.ico
- build.win.target: portable
- asar: true
- compression: maximum
- electron devDependency: 22.3.27 (smaller runtime) or 24.x (if you prefer newer)
- electron-builder devDependency: ^24.13.3

---

## 2) Clean caches (prevents corrupt Electron downloads)

Run in PowerShell from the project root:

```powershell
# Close any terminals running the build first

# Clear electron-builder cache
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\electron-builder\Cache" -ErrorAction SilentlyContinue

# Remove app-builder-bin and electron (optional but helps if cache keeps corrupting)
Remove-Item -Recurse -Force ".\node_modules\app-builder-bin" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force ".\node_modules\electron" -ErrorAction SilentlyContinue
```

If downloads frequently fail in your region, set a reliable mirror:

```powershell
# Use a reliable Electron mirror for artifacts
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
```

---

## 3) Install dependencies

```powershell
npm install
```

This installs Electron and electron-builder per package.json.

---

## 4) Build the portable EXE

```powershell
# Build a portable x64 exe (no installer)
npm run dist
```

Output appears under:

- dist\PS5Vault-1.0.2-portable-x64.exe

electron-builder also writes an effective config at:

- dist\builder-effective-config.yaml (handy for verifying build settings)

---

## 5) Verify the icon and size

- The exe icon is embedded from assets/icon.ico (configured in build.win.icon).
- Right-click the exe → Properties to confirm the icon.
- Typical size:
  - Electron 22.x: ~70–85 MB
  - Electron 24.x+: ~85–100 MB
  - If you require ~65–75 MB, see the optional compression step below.

---

## 6) Test the build

Double‑click the exe:
- Confirm the app launches and displays your UI.
- Run a quick scan and a mock operation (with a small sample) to ensure the transfer modal and progress work.

---

## 7) Optional: shrink size with UPX (trade‑offs)

UPX can reduce the exe by ~15–25%. It may trigger antivirus false positives, so use only if you accept the trade‑offs.

```powershell
# Install UPX (use a trusted binary) then:
upx --best --lzma "dist\PS5Vault-1.0.2-portable-x64.exe"
```

Re‑verify size and run the exe to ensure it still launches correctly.

---

## 8) Common issues and quick fixes

- “description is missed” / “author is missed”
  - Add those fields to package.json (see Step 1).

- “zip: not a valid zip file” during Electron download
  - Clear cache (Step 2).
  - Try the Electron mirror (Step 2).
  - As a last resort, bump Electron to 24.x in package.json and re‑install.

- Icon not showing
  - Confirm assets/icon.ico exists and is referenced by build.win.icon.
  - Multi-resolution ICO gives crisp icons at all scales.

---

## 9) Updating the version later

- Change version in package.json (e.g., 1.0.3).
- Optionally set extraMetadata.version to match (electron-builder will use package.json version).
- Rebuild:
  ```powershell
  npm install
  npm run dist
  ```

---

## 10) Quick reference (one‑shot)

```powershell
# (Optional) Faster artifact mirror
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"

# Clean caches if you saw corrupt downloads
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\electron-builder\Cache" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force ".\node_modules\app-builder-bin" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force ".\node_modules\electron" -ErrorAction SilentlyContinue

# Install and build
npm install
npm run dist

# (Optional) UPX compress
# upx --best --lzma "dist\PS5Vault-1.0.2-portable-x64.exe"
```

---

## 11) You want it bullet‑simple?

- Ensure package.json has description + author set
- assets/icon.ico exists
- npm install
- npm run dist
- Grab your exe from dist\PS5Vault-1.0.2-portable-x64.exe
- Test launch
- Optional: run UPX if you need smaller size

---