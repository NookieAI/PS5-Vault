# PS5 Vault — Dev README

Concise instructions and npm scripts for developing and packaging the app (source files only).
This README describes the four core files in the repo and the npm scripts you can use on GitHub Actions or locally. This is *not* an executable release — only scripts for building/packaging.

## Files
- `main.js` — Electron main process: IPC handlers, scanning, copy/move/verify logic and (optional) auto-update/expiry hooks.
- `preload.js` — Preload script that exposes a minimal safe API (`ppsaApi`) to the renderer via `contextBridge`.
- `index.html` — Single-page UI: layout, modals, and styling.
- `renderer.js` — Renderer logic: UI wiring, scan results rendering, confirm/results modals, and IPC calls to `ppsaApi`.

## Prerequisites
- Node.js LTS (16/18+ recommended)
- npm
- (Optional) electron-builder when you want to package locally or in CI

## Install
1. Clone the repository
2. Install dependencies:
   npm ci

## Useful npm scripts
Add or adapt the scripts below to your `package.json` (examples used in this project):

- `npm start`  
  Launches the app in development using the installed Electron binary.

- `npm run pack`  
  Produces an unpacked application directory (electron-builder `--dir`). Good for local verification before creating installers.

- `npm run dist:local`  
  Builds distributables locally without automatic publishing (electron-builder). Useful for test installers.

- `npm run dist`  
  Builds and publishes artifacts (uses electron-builder publish). Requires `GH_TOKEN` or other publish provider credentials in environment/CI secrets.

Example scripts section:
```json
"scripts": {
  "start": "electron .",
  "pack": "electron-builder --dir",
  "dist:local": "electron-builder",
  "dist": "electron-builder --publish=always"
}
```

## Local development checklist
1. Ensure Node and npm are installed.
2. Run `npm ci`.
3. Start the app: `npm start`.
4. In the running app:
   - Browse → Scan a folder
   - Select one or more entries
   - Pick a Destination and click GO
   - Confirm the Operation Results modal shows the expected From / To output

## Packaging notes (CI-friendly)
- Use `npm run pack` to verify packaged app folder contents.
- Use `npm run dist:local` to build platform-specific artifacts locally.
- For CI publishing via GitHub Actions, set `GH_TOKEN` as a repository secret and use `npm run dist` in the workflow.
- Code signing is recommended for production releases (configure electron-builder with your PFX or signing keys).

## Minimal GitHub Actions snippet (build-only)
Use this in `.github/workflows/build.yml` to run the pack step on push:
```yaml
on: [push]
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '18' }
      - run: npm ci
      - run: npm run pack
```

## Notes & best practices
- Keep `preload.js` surface minimal and avoid exposing Node directly to the renderer.
- Test copy/move flows with small sample folders before moving large datasets.
- For beta/time-limited builds, implement expiry checks at startup (non-destructive) and document how to override at build time.

If you want, I can:
- Add a complete `package.json` with the example scripts wired and a minimal CI workflow file placed in `.github/workflows/`.
- Produce a short contributor guide with testing commands.

Which would you like next?  
