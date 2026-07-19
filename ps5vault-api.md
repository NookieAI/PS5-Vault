# PS5 Vault — Developer API Reference

**Version:** 2.0 · **API Version:** v1  
**Base URL:** `http://127.0.0.1:3731/api/v1`  
**Protocol:** HTTP REST + Server-Sent Events  
**Auth:** None — binds to `127.0.0.1` only

---

## Overview

PS5 Vault exposes a local HTTP API that lets external tools trigger scans, run transfers, rename games, delete games, and stream live progress events. The server binds exclusively to `127.0.0.1` — it is never reachable from outside the machine.

**No authentication required.** The API is completely open on localhost. The API starts automatically whenever PS5 Vault launches, in both normal and embedded modes. No configuration needed.

> **Embedded mode:** Launch with `PS5Vault.exe --embedded` to run as a headless background service (no UI window). A system-tray icon is shown so you can see the process is running and quit it. The API behaves identically in both modes.

---

## Authentication

**None required.** Make requests directly with no headers or tokens.

```bash
curl http://127.0.0.1:3731/api/v1/status
```

Since the server only binds to `127.0.0.1`, only code on the same machine can reach it. CORS is fully open so browser-based tools work without a proxy.

---

## Conventions

| Property | Value |
|----------|-------|
| Base URL | `http://127.0.0.1:3731/api/v1` |
| Port | `3731` (fixed, not configurable) |
| Content-Type | `application/json` for all request bodies and responses |
| Max request body | 512 KB |
| CORS | `Origin: *` — all methods, all headers |

All responses include a JSON body. Errors always include `{ "error": "..." }`. Successful mutations return `{ "ok": true, ... }`.

---

## Endpoints

### GET /api/v1/status

Returns app version, library size, and current scan/transfer states. Good for a health check or polling loop.

**Response**

```json
{
  "ok": true,
  "version": "2.4.2",
  "port": 3731,
  "library": { "count": 30 },
  "scan": {
    "active": false,
    "source": null,
    "progress": { "found": 0, "sized": 0, "total": 0 }
  },
  "transfer": { "active": false, "progress": {} }
}
```

---

### GET /api/v1/library

Returns every game in the current in-memory library. The library is populated by the most recent scan. Returns an empty array if no scan has run this session.

**Response**

```json
{
  "count": 2,
  "games": [
    {
      "ppsa": "PPSA21564_00",
      "contentId": "UP9000-PPSA21564_00-00000000000000000",
      "title": "ASTRO BOT",
      "version": "01.007.000",
      "sdkVersion": "09000000",
      "region": "en-US",
      "sizeBytes": 26843545600,
      "sizeMb": 25600,
      "folderPath": "T:\\Folder Games\\ASTRO BOT (01.007.000)",
      "hasIcon": true,
      "fwRequired": "09.00.00.00",
      "titleId": "PPSA21564"
    }
  ]
}
```

**Game object fields**

| Field | Type | Notes |
|-------|------|-------|
| `ppsa` | string \| null | PPSA ID (e.g. `PPSA21564_00`) |
| `contentId` | string \| null | Full content ID from param.json |
| `title` | string \| null | Display title |
| `version` | string \| null | Content version (e.g. `01.007.000`) |
| `sdkVersion` | string \| null | SDK version hex |
| `region` | string \| null | Default language/region |
| `sizeBytes` | number \| null | Total folder size in bytes. `null` while sizing is in progress |
| `sizeMb` | number \| null | Size rounded to nearest MB |
| `folderPath` | string \| null | Absolute path to game folder on disk |
| `hasIcon` | boolean | Whether cover art is available via `/icon` endpoint |
| `fwRequired` | string \| null | Minimum firmware version |
| `titleId` | string \| null | Title ID from param.json |
| `folderName` | string \| null | Raw folder name on disk |
| `localizedTitles` | object | All localised titles `{ "en-US": "...", "ja": "..." }` |
| `defaultLanguage` | string \| null | Default language code |
| `sizeGb` | number \| null | Size in GB (2 decimal places) |
| `paramPath` | string \| null | Absolute path to `param.json` |
| `iconUrl` | string \| null | Direct URL to cover art (use this in `<img>` tags) |
| `contentCategory` | string \| null | Content type from param.json |

> **Note:** `sizeBytes` may be `null` on large libraries while background sizing is still in progress. Subscribe to the SSE stream for `size-update` events to receive sizes as they complete.

---

### GET /api/v1/library/:ppsa

Retrieve a single game by PPSA ID. Lookup is case-insensitive. Returns the same object shape as a single entry from `/library`.

**Example**

```
GET /api/v1/library/PPSA21564_00
GET /api/v1/library/ppsa21564_00   ← same result
```

**Errors**

| Code | Body |
|------|------|
| `404` | `Game not found: PPSA21564_00` |

---

### GET /api/v1/library/:ppsa/icon

Returns the game's cover art as a `image/png` binary response. For locally scanned games this streams the file from disk. For FTP-scanned games it decodes the stored base64 blob.

**Example — fetching with auth in JavaScript**

```js
const res = await fetch(
  'http://127.0.0.1:3731/api/v1/library/PPSA21564_00/icon',
  { headers: { 'X-API-Key': key } }
);
const blob = await res.blob();
const url  = URL.createObjectURL(blob);
document.querySelector('img').src = url;
```

> **Note:** `EventSource` and plain `<img src="...">` tags do not support custom headers. Use `fetch` with `createObjectURL` as shown above.

**Errors**

| Code | Body |
|------|------|
| `404` | `Icon not found` (game not found, or no cover art available) |
| `500` | `Icon read error: [message]` |

---

### POST /api/v1/scan

Starts a game scan asynchronously. Returns immediately — subscribe to `/events` for real-time progress or poll `/scan/status`.

**Request body**

| Field | Required | Notes |
|-------|----------|-------|
| `source` | optional | Local path (`D:\Games`), FTP address (`192.168.1.100:2121` or `ftp://192.168.1.100`), or `"all-drives"` to scan every local drive. Defaults to `"all-drives"` if omitted. |

**Examples**

```json
{ "source": "T:\\Folder Games" }
{ "source": "192.168.1.100:2121" }
{ "source": "all-drives" }
```

**Response**

```json
{ "ok": true, "message": "Scan started", "source": "T:\\Folder Games" }
```

**Errors**

| Code | Body |
|------|------|
| `409` | `A scan is already running` |
| `400` | `Invalid JSON` |

---

### GET /api/v1/scan/status

Returns the current scan state including progress counters.

**Response**

```json
{
  "active": true,
  "source": "T:\\Folder Games",
  "progress": {
    "found": 18,
    "sized": 6,
    "total": 18
  }
}
```

`active` is `false` once both scanning and sizing are complete.

---

### POST /api/v1/transfer

Starts a transfer asynchronously. Returns immediately.

**Important:** `items` must be full game objects returned from `/library` — not just PPSA IDs. Pass them back as-is.

**Request body**

| Field | Required | Notes |
|-------|----------|-------|
| `items` | **required** | Array of game objects from `/library`. Must be non-empty. |
| `dest` | **required** | Destination path. Local: `E:\PS5`. FTP: `192.168.1.100:2121`. |
| `action` | optional | `copy` (verified, default), `copy-fast` (no checksum), `move`, `folder-only` |
| `layout` | optional | Folder structure preset (see table below). Default: `etahen` |
| `overwriteMode` | optional | `rename` (default — adds suffix), `overwrite`, `skip` |
| `customName` | optional | Custom folder name. Only used when `layout` is `custom`. |
| `ftpConfig` | optional | FTP config object for the *source*. Omit for a local source. |
| `ftpDestConfig` | optional | FTP config object for the *destination*. Omit for a local destination. |

**Layout presets**

| Value | Output path structure |
|-------|-----------------------|
| `etahen` | `dest/etaHEN/games/Game Name (01.000.000)/` |
| `game-only` | `dest/Game Name (01.000.000)/` |
| `ppsa-only` | `dest/PPSA00000_00 (01.000.000)/` |
| `itemzflow` | `dest/games/Game Name (01.000.000)/` |
| `dump_runner` | `dest/homebrew/Game Name (01.000.000)/` |
| `porkfolio` | `dest/Game Name (01.000.000) PPSA00000_00/` |
| `game-ppsa` | `dest/Game Name (01.000.000)/PPSA00000_00/` |
| `custom` | `dest/<customName>/` |

**FTP config object**

```json
{
  "host": "192.168.1.100",
  "port": 2121,
  "user": "anonymous",
  "pass": "",
  "passive": true
}
```

**Full example — copy one game to a PS5 over FTP**

```json
{
  "items": [{ ...game object from /library... }],
  "dest": "192.168.1.100:2121",
  "action": "copy",
  "layout": "etahen",
  "overwriteMode": "rename",
  "ftpDestConfig": {
    "host": "192.168.1.100",
    "port": 2121,
    "user": "anonymous",
    "pass": "",
    "passive": true
  }
}
```

**Response**

```json
{ "ok": true, "message": "Transfer started", "itemCount": 1 }
```

**Errors**

| Code | Body |
|------|------|
| `400` | `items array is required` / `dest string is required` / `Invalid JSON` |
| `409` | `A transfer is already running` |

---

### GET /api/v1/transfer/status

Returns the current transfer state including per-file and grand-total byte counters.

**Response**

```json
{
  "active": true,
  "progress": {
    "type": "go-file-progress",
    "itemIndex": 1,
    "totalItems": 3,
    "totalBytesCopied": 1073741824,
    "totalBytes": 26843545600,
    "grandTotalCopied": 1073741824,
    "grandTotalBytes": 75161927680
  }
}
```

---

### GET /api/v1/events

Server-Sent Events stream. Connect once and receive all scan and transfer events in real time. The connection is kept alive with a `: ping` comment every 25 seconds.

> **Important:** `EventSource` does not support custom headers. Use `fetch` with a streaming reader as shown in the example below.

**Connecting**

```js
const res = await fetch('http://127.0.0.1:3731/api/v1/events', {
  headers: { 'X-API-Key': key }
});

const reader = res.body
  .pipeThrough(new TextDecoderStream())
  .getReader();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  for (const line of value.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const ev = JSON.parse(line.slice(5).trim());
    console.log(ev.type, ev.data);
  }
}
```

**Event envelope**

Every event is a JSON-encoded SSE `data:` line:

```
data: { "type": "scan-start", "data": { ... }, "ts": 1741234567890 }
```

**Event types**

| Type | Fired when | Key fields in `data` |
|------|------------|----------------------|
| `connected` | On connect | `version`, `library` (count) |
| `scan-start` | Scan begins | `source` |
| `scan-progress` | Each game found or sized | `type` (`game-found` \| `size-update`), `item`, `done`, `total` |
| `size-update` | Game size calculated | `folderPath`, `totalSize` |
| `scan-complete` | Scan + sizing done | `count` (total games) |
| `scan-error` | Scan threw an error | `error` (message string) |
| `transfer-start` | Transfer begins | `itemCount` |
| `transfer-progress` | Per-file progress update | `type`, `itemIndex`, `totalItems`, `totalBytesCopied`, `grandTotalBytes` |
| `transfer-complete` | Transfer finished | `success: true` |
| `transfer-error` | Transfer threw an error | `error` (message string) |

---

## Code Examples

### curl

```bash
# Status check
curl \
  http://127.0.0.1:3731/api/v1/status

# Trigger scan on a specific folder
curl -X POST \
  \
  -H "Content-Type: application/json" \
  -d '{"source":"T:\\Folder Games"}' \
  http://127.0.0.1:3731/api/v1/scan

# List all game titles (requires jq)
curl -s \
  http://127.0.0.1:3731/api/v1/library | jq '.games[].title'

# Copy a game to PS5 over FTP
curl -X POST \
  \
  -H "Content-Type: application/json" \
  -d '{
    "items": [PASTE_GAME_OBJECT_HERE],
    "dest": "192.168.1.100:2121",
    "action": "copy",
    "layout": "etahen",
    "ftpDestConfig": {
      "host": "192.168.1.100", "port": 2121,
      "user": "anonymous", "pass": "", "passive": true
    }
  }' \
  http://127.0.0.1:3731/api/v1/transfer
```

### JavaScript

```js
const BASE = 'http://127.0.0.1:3731/api/v1';
const h    = { 'Content-Type': 'application/json' };

const api = (path, opts = {}) =>
  fetch(BASE + path, { headers: h, ...opts }).then(r => r.json());

// 1. Trigger a scan
await api('/scan', {
  method: 'POST',
  body: JSON.stringify({ source: 'T:\\Folder Games' })
});

// 2. Poll until complete
while (true) {
  const s = await api('/scan/status');
  if (!s.active) break;
  await new Promise(r => setTimeout(r, 1000));
}

// 3. Find a game and copy it to PS5
const { games } = await api('/library');
const tekken = games.find(g => g.title?.includes('Tekken 8'));

await api('/transfer', {
  method: 'POST',
  body: JSON.stringify({
    items: [tekken],
    dest: '192.168.1.100:2121',
    action: 'copy',
    layout: 'etahen',
    ftpDestConfig: {
      host: '192.168.1.100', port: 2121,
      user: 'anonymous', pass: '', passive: true
    }
  })
});
```

### Python

```python
import requests, time, json

BASE = 'http://127.0.0.1:3731/api/v1'
KEY  = 'YOUR_KEY'
H    = { 'Content-Type': 'application/json' }

# Status check
print(requests.get(f'{BASE}/status', headers=H).json())

# Scan a folder
requests.post(f'{BASE}/scan', headers=H,
    json={ 'source': r'T:\Folder Games' })

# Poll until done
while True:
    s = requests.get(f'{BASE}/scan/status', headers=H).json()
    if not s['active']:
        break
    time.sleep(1)

# Find a game and copy it
games = requests.get(f'{BASE}/library', headers=H).json()['games']
game  = next(g for g in games if 'Tekken 8' in (g['title'] or ''))

requests.post(f'{BASE}/transfer', headers=H, json={
    'items': [game],
    'dest':  r'E:\PS5Games',
    'action': 'copy',
    'layout': 'etahen',
})

# Stream SSE events
r = requests.get(f'{BASE}/events', headers=H, stream=True)
for line in r.iter_lines():
    if line and line.startswith(b'data:'):
        ev = json.loads(line[5:])
        print(ev['type'], ev.get('data', {}))
```

---

## Error Reference

| Status | Meaning |
|--------|---------|
| `400` | Bad request — missing required field, invalid JSON, or body too large (>512 KB) |
| `401` | Missing or invalid `X-API-Key` header |
| `404` | Unknown route, or game/icon not found |
| `409` | Conflict — a scan or transfer is already running |
| `500` | Internal server error — check the `error` field for the message |

---

## Embedded Mode

Start PS5 Vault with `--embedded` to run it as a background service with no UI window:

```
PS5Vault.exe --embedded
```

The API server starts identically to normal mode. A system-tray icon shows the app is running — right-click it to open the full UI window or quit the process.

This is the recommended mode for integration into game launchers, companion apps, or automation scripts.

---

## Notes & Limitations

- **In-memory library.** The game library is held in memory and resets when PS5 Vault exits. Always trigger a scan before querying the library.
- **One operation at a time.** Only one scan and one transfer can run concurrently. Starting a second returns `409 Conflict`.
- **Full game objects required for transfers.** Pass complete objects from `/library` — not just PPSA IDs or partial data.
- **`sizeBytes` may be null.** On large libraries, background sizing continues after the scan completes. Subscribe to `size-update` SSE events for real-time updates.
- **Use `fetch` for SSE, not `EventSource`.** `EventSource` does not support custom headers. Use `fetch` with a streaming reader — no auth needed, just the URL.
- **No auth + open CORS by design.** The API only binds to `127.0.0.1` — no external access possible. CORS is fully open so web UIs can call the API without a proxy.

---

*PS5 Vault Developer API · Built by Nookie*
