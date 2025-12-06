# PS5 Vault

Lightweight Electron app to scan, verify and copy/move PS5 PPSA folders.

Quick start
- Install: npm ci
- Run (dev): npm start
- Scan → Select → Choose Action & Layout → Pick Destination → GO

Build & release
- Local build (no publish): npm run dist:local
- Build & publish to GitHub Releases: npm run dist
- Windows installer (NSIS): npm run build-win

Beta & expiry
- The app supports a build-time beta expiry (BETA_EXPIRES). If expiry is reached the app will show a message and exit.
- For stronger control use the optional token server (server issues signed trial tokens).

Auto-update
- Uses electron-updater. When published to GitHub Releases the app can auto-check and install updates.

CI / GitHub Actions
- A workflow is included (.github/workflows/release.yml) to build & publish on tag pushes (v*).
- Required repo secrets for publishing:
  - GH_TOKEN (GitHub PAT with repo access)
  - Optional: BETA_EXPIRES, CSC_LINK, CSC_KEY_PASSWORD (for code signing)

Optional token server
- token-server/ contains a simple HMAC token issuer to create signed trial tokens.
- Use tokens if you want server-issued, revocable timed access.

Files of interest
- main.js — app logic + beta expiry + autoUpdater init
- preload.js — secure renderer API
- renderer.js / index.html — UI
- package.json — scripts & electron-builder config
- .github/workflows/release.yml — CI build/publish example
- token-server/ — optional trial token issuer

Security notes
- Prefer graceful expiry over self‑destruct. Use signed tokens for stronger control.
- Code-sign Windows installers (PFX) to avoid SmartScreen warnings.

Need help wiring CI, signing, or adding server‑verified tokens? Tell me which and I’ll generate the exact artifacts or PR.  
```
