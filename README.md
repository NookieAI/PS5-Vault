# PS5 Vault — Native Windows version (C# WinForms)

This is a native Windows rewrite of the original Electron-based PS5 Vault. It scans a source folder for param.json / PPSA folders and allows creating/copying/moving content into a destination with SHA256-verified copy.

Requirements
- .NET 7 SDK (or change TargetFramework in csproj to net6.0 if you prefer .NET 6)
- Windows (WinForms GUI)

Build a single native exe
1. Open a command prompt in the project folder (where Ps5VaultNative.csproj is).
2. Run (example for x64 self-contained single file):

dotnet publish -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true -o publish

This will produce an executable in `publish\` (e.g. `publish\Ps5VaultNative.exe`) that runs standalone.

Notes / limitations
- The UI is simplified, but the scanning, content extraction, icon detection and verified copy/move logic are implemented.
- Error handling attempts to be resilient but please test on your dataset.
- You can expand the UI, add localization, add a database, or more advanced options as needed.

If you want, I can:
- Add a proper installer (MSI)
- Create a lightweight service for unattended scans
- Convert the UI to WPF for richer visuals
- Add multi-threaded copy progress for every file (per-file progress)

Tell me which of the above you'd like next or any additional behavior to preserve from the Electron app.
