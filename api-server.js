'use strict';
// ── PS5 Vault Developer API Server ────────────────────────────────────────────
// Local HTTP REST + Server-Sent Events (SSE) server.
// No extra npm dependencies — uses Node.js built-in `http` module only.
//
// Base URL:  http://127.0.0.1:3731/api/v1
// Auth:      X-API-Key: <key>  (header on every request)
//
// REST endpoints:
//   GET  /api/v1/status              — app status, version, library count
//   GET  /api/v1/library             — list all scanned games
//   GET  /api/v1/library/:ppsa       — single game by PPSA ID
//   GET  /api/v1/library/:ppsa/icon  — game cover art (PNG)
//   POST /api/v1/scan                — trigger scan { source: "..." }
//   GET  /api/v1/scan/status         — current scan state
//   POST /api/v1/transfer            — trigger transfer (same opts as ensure-and-populate)
//   GET  /api/v1/transfer/status     — current transfer state
//   GET  /api/v1/events              — SSE stream (live scan/transfer events)
// ─────────────────────────────────────────────────────────────────────────────

const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');

const API_PORT    = 3731;
const API_VERSION = 'v1';
const BASE        = `/api/${API_VERSION}`;

let _state      = null;
let _keyPath    = null;
let _apiKey     = null;
let _server     = null;
const _sseClients = new Set();

// ── Key management ────────────────────────────────────────────────────────────
function loadOrCreateKey(keyPath) {
  try {
    const data = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    if (data && typeof data.key === 'string' && data.key.length === 64) return data.key;
  } catch (_) {}
  return _writeNewKey(keyPath);
}

function _writeNewKey(keyPath) {
  const key = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(keyPath, JSON.stringify({ key, createdAt: new Date().toISOString() }), 'utf8'); } catch (_) {}
  return key;
}

function regenerateKey() {
  if (!_keyPath) return null;
  _apiKey = _writeNewKey(_keyPath);
  console.log('[API] API key regenerated');
  return _apiKey;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function authMiddleware(req, res) {
  const provided = req.headers['x-api-key'];
  if (!provided || provided !== _apiKey) {
    res.writeHead(401, corsHeaders({ 'Content-Type': 'application/json' }));
    res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid X-API-Key header' }));
    return false;
  }
  return true;
}

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
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

// Sanitise a game item for external consumers.
// Strips binary iconPath blobs; exposes only serialisable fields.
function serializeGame(item) {
  if (!item) return null;
  return {
    ppsa:        item.ppsa        || null,
    contentId:   item.contentId   || null,
    title:       item.displayTitle || item.folderName || null,
    version:     item.contentVersion || item.version   || null,
    sdkVersion:  item.sdkVersion  || null,
    region:      item.region      || null,
    sizeBytes:   item.totalSize   || null,
    sizeMb:      item.totalSize   ? Math.round(item.totalSize / 1024 / 1024) : null,
    folderPath:  item.folderPath  || item.ppsaFolderPath || null,
    hasIcon:     !!(item.iconPath),
    fwRequired:  item.fwSku       || null,
    titleId:     item.titleId     || null,
  };
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

  // CORS pre-flight
  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // ── SSE stream — auth then persist ──────────────────────────────────────
  if (pathname === `${BASE}/events` && method === 'GET') {
    if (!authMiddleware(req, res)) return;
    res.writeHead(200, corsHeaders({
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    }));
    // Connected welcome event
    res.write(`data: ${JSON.stringify({ type: 'connected', data: { version: _state.getVersion(), library: _state.getLibrary().length }, ts: Date.now() })}\n\n`);
    _sseClients.add(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); _sseClients.delete(res); }
    }, 25000);
    req.on('close', () => { clearInterval(ping); _sseClients.delete(res); });
    return;
  }

  // All remaining routes require auth
  if (!authMiddleware(req, res)) return;

  // ── GET /api/v1/status ───────────────────────────────────────────────────
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

  // ── GET /api/v1/library ──────────────────────────────────────────────────
  if (pathname === `${BASE}/library` && method === 'GET') {
    const games = _state.getLibrary().map(serializeGame);
    jsonOk(res, { count: games.length, games });
    return;
  }

  // ── GET /api/v1/library/:ppsa ────────────────────────────────────────────
  const ppsaMatch = pathname.match(new RegExp(`^${BASE}/library/([^/]+)$`));
  if (ppsaMatch && method === 'GET') {
    const ppsa = ppsaMatch[1].toUpperCase();
    const item = _state.getLibrary().find(g => (g.ppsa || '').toUpperCase() === ppsa);
    if (!item) { jsonErr(res, 404, `Game not found: ${ppsa}`); return; }
    jsonOk(res, serializeGame(item));
    return;
  }

  // ── GET /api/v1/library/:ppsa/icon ───────────────────────────────────────
  const iconMatch = pathname.match(new RegExp(`^${BASE}/library/([^/]+)/icon$`));
  if (iconMatch && method === 'GET') {
    const ppsa = iconMatch[1].toUpperCase();
    const item = _state.getLibrary().find(g => (g.ppsa || '').toUpperCase() === ppsa);
    if (!item || !item.iconPath) { jsonErr(res, 404, 'Icon not found'); return; }
    try {
      if (item.iconPath.startsWith('data:')) {
        // FTP inline base64 — decode and serve
        const b64  = item.iconPath.split(',')[1] || '';
        const buf  = Buffer.from(b64, 'base64');
        res.writeHead(200, corsHeaders({ 'Content-Type': 'image/png', 'Content-Length': String(buf.length) }));
        res.end(buf);
      } else {
        // Local file path — stream it
        const stat = fs.statSync(item.iconPath);
        res.writeHead(200, corsHeaders({ 'Content-Type': 'image/png', 'Content-Length': String(stat.size) }));
        fs.createReadStream(item.iconPath).pipe(res);
      }
    } catch (e) {
      jsonErr(res, 500, `Icon read error: ${e.message}`);
    }
    return;
  }

  // ── POST /api/v1/scan ─────────────────────────────────────────────────────
  if (pathname === `${BASE}/scan` && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { jsonErr(res, 400, 'Invalid JSON'); return; }
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
    try { body = await readBody(req); } catch (e) { jsonErr(res, 400, 'Invalid JSON'); return; }
    if (!body.items || !Array.isArray(body.items) || !body.items.length) {
      jsonErr(res, 400, 'items array is required'); return;
    }
    if (!body.dest || typeof body.dest !== 'string') {
      jsonErr(res, 400, 'dest string is required'); return;
    }
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
  _state   = opts.state;
  _keyPath = opts.keyPath;
  _apiKey  = loadOrCreateKey(_keyPath);

  _server  = http.createServer((req, res) => {
    handleRequest(req, res).catch(e => {
      console.error('[API] Request error:', e.message);
      try { jsonErr(res, 500, e.message); } catch (_) {}
    });
  });

  _server.on('error', e => console.error('[API] Server error:', e.message));

  _server.listen(API_PORT, '127.0.0.1', () => {
    console.log(`[API] Listening → http://127.0.0.1:${API_PORT}${BASE}`);
  });
}

function stop() {
  for (const c of _sseClients) { try { c.end(); } catch (_) {} }
  _sseClients.clear();
  if (_server) { _server.close(); _server = null; }
}

function getKey()  { return _apiKey; }
function getPort() { return API_PORT; }

module.exports = { start, stop, broadcast, regenerateKey, getKey, getPort };
