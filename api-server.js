'use strict';
// ── PS5 Vault Developer API Server ────────────────────────────────────────────
// Local HTTP REST + Server-Sent Events (SSE) server.
// No extra npm dependencies — uses Node.js built-in `http` module only.
//
// Binds to 127.0.0.1 ONLY — never reachable outside the local machine.
// No authentication required (localhost-only is the security boundary).
//
// Base URL:  http://127.0.0.1:3731/api/v1
//
// ── Library ──────────────────────────────────────────────────────────────────
//   GET    /api/v1/library                  list all scanned games
//   GET    /api/v1/library/:id              single game (PPSA ID or folderName)
//   GET    /api/v1/library/:id/icon         cover art PNG (Cache-Control: 1h)
//   GET    /api/v1/library/:id/param        full raw param.json fields
//   POST   /api/v1/library/:id/rename       rename folder  { name: "New Name" }
//   DELETE /api/v1/library/:id             permanently delete game folder
//
// ── Scan ─────────────────────────────────────────────────────────────────────
//   POST /api/v1/scan                       start scan  { source: "..." }
//   GET  /api/v1/scan/status                current scan state
//
// ── Transfer ─────────────────────────────────────────────────────────────────
//   POST /api/v1/transfer                   copy / move games
//   GET  /api/v1/transfer/status            current transfer state
//
// ── App ──────────────────────────────────────────────────────────────────────
//   GET  /api/v1/status                     health + counts
//   GET  /api/v1/events                     SSE live event stream
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');
const fs   = require('fs');

const API_PORT    = 3731;
const API_VERSION = 'v1';
const BASE        = `/api/${API_VERSION}`;

let _state    = null;
let _server   = null;
const _sseClients = new Set();

// ── Helpers ───────────────────────────────────────────────────────────────────
function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extra,
  };
}

function jsonOk(res, data) {
  const body = JSON.stringify(data);
  res.writeHead(200, corsHeaders({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }));
  res.end(body);
}

function jsonErr(res, status, msg) {
  const body = JSON.stringify({ error: msg });
  res.writeHead(status, corsHeaders({ 'Content-Type': 'application/json' }));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 512 * 1024) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ── Serialisers ───────────────────────────────────────────────────────────────

function serializeGame(item) {
  if (!item) return null;
  const p = item.paramParsed || {};

  // Collect all localised titles from param.json localizedParameters
  const localizedTitles = {};
  try {
    const lp = p.localizedParameters || {};
    for (const [lang, vals] of Object.entries(lp)) {
      if (vals && vals.titleName) localizedTitles[lang] = vals.titleName;
    }
  } catch (_) {}

  return {
    // ── Identity
    ppsa:            item.ppsa        || null,
    contentId:       item.contentId   || null,
    titleId:         item.titleId     || p.titleId || null,

    // ── Display
    title:           item.displayTitle || item.folderName || null,
    folderName:      item.folderName   || null,
    localizedTitles,
    defaultLanguage: item.region || p.defaultLanguage || null,

    // ── Version / firmware
    version:         item.contentVersion || item.version || p.contentVersion || p.masterVersion || null,
    sdkVersion:      item.sdkVersion  || p.sdkVersion  || null,
    fwRequired:      item.fwSku       || p.requiredSystemSoftwareVersion || null,

    // ── Size
    sizeBytes:       item.totalSize || null,
    sizeMb:          item.totalSize ? Math.round(item.totalSize / 1024 / 1024) : null,
    sizeGb:          item.totalSize ? Math.round((item.totalSize / 1024 / 1024 / 1024) * 100) / 100 : null,

    // ── Location
    folderPath:      item.folderPath || item.ppsaFolderPath || null,
    paramPath:       item.paramPath  || null,

    // ── Cover art  (fetch via /icon endpoint)
    hasIcon:         !!(item.iconPath),
    iconUrl:         item.ppsa
      ? `http://127.0.0.1:${API_PORT}${BASE}/library/${item.ppsa}/icon`
      : null,

    // ── Extra param.json fields
    contentCategory:         p.contentType    || p.contentCategory    || null,
    applicationCategoryType: p.applicationCategoryType               || null,
  };
}

function serializeParam(item) {
  if (!item) return null;
  const p = item.paramParsed || {};
  return {
    ppsa:       item.ppsa      || null,
    contentId:  item.contentId || null,
    titleId:    item.titleId   || p.titleId || null,
    folderPath: item.folderPath || item.ppsaFolderPath || null,
    paramPath:  item.paramPath  || null,
    raw: {
      titleName:                     p.titleName                     || null,
      localizedParameters:           p.localizedParameters           || null,
      contentId:                     p.contentId                     || null,
      titleId:                       p.titleId                       || null,
      contentVersion:                p.contentVersion                || null,
      masterVersion:                 p.masterVersion                 || null,
      sdkVersion:                    p.sdkVersion                    || null,
      requiredSystemSoftwareVersion: p.requiredSystemSoftwareVersion || null,
      defaultLanguage:               p.defaultLanguage               || null,
      contentType:                   p.contentType                   || null,
      applicationCategoryType:       p.applicationCategoryType       || null,
    },
  };
}

// Lookup by PPSA ID, folderName, or partial contentId — case-insensitive
function findGame(id) {
  const upper = id.toUpperCase();
  const lib   = _state.getLibrary();
  return (
    lib.find(g => (g.ppsa        || '').toUpperCase() === upper) ||
    lib.find(g => (g.folderName  || '').toUpperCase() === upper) ||
    lib.find(g => (g.contentId   || '').toUpperCase().includes(upper)) ||
    null
  );
}

// ── SSE broadcast ─────────────────────────────────────────────────────────────
function broadcast(eventType, data) {
  if (_sseClients.size === 0) return;
  const msg = `data: ${JSON.stringify({ type: eventType, data, ts: Date.now() })}\n\n`;
  for (const client of _sseClients) {
    try { client.write(msg); }
    catch (_) { _sseClients.delete(client); }
  }
}

// ── Request router ────────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const url      = new URL(req.url, `http://127.0.0.1:${API_PORT}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method   = req.method.toUpperCase();

  if (method === 'OPTIONS') { res.writeHead(204, corsHeaders()); res.end(); return; }

  // ── GET /api/v1/status ────────────────────────────────────────────────────
  if (pathname === `${BASE}/status` && method === 'GET') {
    jsonOk(res, {
      ok:       true,
      version:  _state.getVersion(),
      port:     API_PORT,
      library:  { count: _state.getLibrary().length },
      scan:     _state.getScanStatus(),
      transfer: _state.getTransferStatus(),
    });
    return;
  }

  // ── GET /api/v1/events  (SSE) ─────────────────────────────────────────────
  if (pathname === `${BASE}/events` && method === 'GET') {
    res.writeHead(200, corsHeaders({
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    }));
    res.write(`data: ${JSON.stringify({ type: 'connected', data: { version: _state.getVersion(), library: _state.getLibrary().length }, ts: Date.now() })}\n\n`);
    _sseClients.add(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); _sseClients.delete(res); }
    }, 25000);
    req.on('close', () => { clearInterval(ping); _sseClients.delete(res); });
    return;
  }

  // ── GET /api/v1/library ───────────────────────────────────────────────────
  if (pathname === `${BASE}/library` && method === 'GET') {
    jsonOk(res, { count: _state.getLibrary().length, games: _state.getLibrary().map(serializeGame) });
    return;
  }

  // ── Routes with :id ───────────────────────────────────────────────────────
  const mBase  = pathname.match(new RegExp(`^${BASE}/library/([^/]+)$`));
  const mIcon  = pathname.match(new RegExp(`^${BASE}/library/([^/]+)/icon$`));
  const mParam = pathname.match(new RegExp(`^${BASE}/library/([^/]+)/param$`));
  const mRen   = pathname.match(new RegExp(`^${BASE}/library/([^/]+)/rename$`));

  // GET /api/v1/library/:id
  if (mBase && method === 'GET') {
    const item = findGame(mBase[1]);
    if (!item) { jsonErr(res, 404, `Game not found: ${mBase[1]}`); return; }
    jsonOk(res, serializeGame(item));
    return;
  }

  // DELETE /api/v1/library/:id
  if (mBase && method === 'DELETE') {
    const item = findGame(mBase[1]);
    if (!item) { jsonErr(res, 404, `Game not found: ${mBase[1]}`); return; }
    try {
      const result = await _state.triggerDelete(item);
      jsonOk(res, { ok: true, deleted: result.deleted });
    } catch (e) { jsonErr(res, 500, e.message); }
    return;
  }

  // GET /api/v1/library/:id/icon
  if (mIcon && method === 'GET') {
    const item = findGame(mIcon[1]);
    if (!item || !item.iconPath) { jsonErr(res, 404, 'Icon not found'); return; }
    try {
      if (item.iconPath.startsWith('data:')) {
        const buf = Buffer.from(item.iconPath.split(',')[1] || '', 'base64');
        res.writeHead(200, corsHeaders({ 'Content-Type': 'image/png', 'Content-Length': String(buf.length), 'Cache-Control': 'public, max-age=3600' }));
        res.end(buf);
      } else {
        const stat = fs.statSync(item.iconPath);
        res.writeHead(200, corsHeaders({ 'Content-Type': 'image/png', 'Content-Length': String(stat.size), 'Cache-Control': 'public, max-age=3600' }));
        fs.createReadStream(item.iconPath).pipe(res);
      }
    } catch (e) { jsonErr(res, 500, `Icon read error: ${e.message}`); }
    return;
  }

  // GET /api/v1/library/:id/param
  if (mParam && method === 'GET') {
    const item = findGame(mParam[1]);
    if (!item) { jsonErr(res, 404, `Game not found: ${mParam[1]}`); return; }
    jsonOk(res, serializeParam(item));
    return;
  }

  // POST /api/v1/library/:id/rename
  if (mRen && method === 'POST') {
    const item = findGame(mRen[1]);
    if (!item) { jsonErr(res, 404, `Game not found: ${mRen[1]}`); return; }
    let body;
    try { body = await readBody(req); } catch (_) { jsonErr(res, 400, 'Invalid JSON'); return; }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) { jsonErr(res, 400, '"name" is required'); return; }
    try {
      const result = await _state.triggerRename(item, name);
      jsonOk(res, { ok: true, newPath: result.newPath });
    } catch (e) { jsonErr(res, 500, e.message); }
    return;
  }

  // ── POST /api/v1/scan ─────────────────────────────────────────────────────
  if (pathname === `${BASE}/scan` && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (_) { jsonErr(res, 400, 'Invalid JSON'); return; }
    if (_state.getScanStatus().active) { jsonErr(res, 409, 'A scan is already running'); return; }
    const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim() : 'all-drives';
    jsonOk(res, { ok: true, message: 'Scan started', source });
    _state.triggerScan(source).catch(e => broadcast('scan-error', { error: e.message }));
    return;
  }

  // ── GET /api/v1/scan/status ───────────────────────────────────────────────
  if (pathname === `${BASE}/scan/status` && method === 'GET') {
    jsonOk(res, _state.getScanStatus());
    return;
  }

  // ── POST /api/v1/transfer ─────────────────────────────────────────────────
  if (pathname === `${BASE}/transfer` && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (_) { jsonErr(res, 400, 'Invalid JSON'); return; }
    if (!body.items || !Array.isArray(body.items) || !body.items.length) { jsonErr(res, 400, 'items array is required'); return; }
    if (!body.dest || typeof body.dest !== 'string') { jsonErr(res, 400, 'dest string is required'); return; }
    if (_state.getTransferStatus().active) { jsonErr(res, 409, 'A transfer is already running'); return; }
    jsonOk(res, { ok: true, message: 'Transfer started', itemCount: body.items.length });
    _state.triggerTransfer(body).catch(e => broadcast('transfer-error', { error: e.message }));
    return;
  }

  // ── GET /api/v1/transfer/status ───────────────────────────────────────────
  if (pathname === `${BASE}/transfer/status` && method === 'GET') {
    jsonOk(res, _state.getTransferStatus());
    return;
  }

  jsonErr(res, 404, `No route: ${method} ${pathname}`);
}

// ── Public interface ──────────────────────────────────────────────────────────
function start(opts) {
  _state  = opts.state;

  _server = http.createServer((req, res) => {
    handleRequest(req, res).catch(e => {
      console.error('[API] Request error:', e.message);
      try { jsonErr(res, 500, e.message); } catch (_) {}
    });
  });

  _server.on('error', e => console.error('[API] Server error:', e.message));
  _server.listen(API_PORT, '127.0.0.1', () => {
    console.log(`[API] Listening → http://127.0.0.1:${API_PORT}${BASE} (no auth required)`);
  });
}

function stop() {
  for (const c of _sseClients) { try { c.end(); } catch (_) {} }
  _sseClients.clear();
  if (_server) { _server.close(); _server = null; }
}

function getPort() { return API_PORT; }

module.exports = { start, stop, broadcast, getPort };
