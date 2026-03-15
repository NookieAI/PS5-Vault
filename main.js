// CRITICAL: set libuv thread pool BEFORE any I/O — must be the very first line.
// Node.js file I/O (readdir, stat, open) runs on libuv's thread pool.
// Default = 4 threads. Even with 128 async workers only 4 OS threads do real
// work at once. Raising to 64 gives ~16x more I/O parallelism — the single
// biggest scan speed win on any drive type.
process.env.UV_THREADPOOL_SIZE = '128';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Writable, Transform } = require('stream');
const { execFile } = require('child_process');

// Add FTP support
const ftp = require('basic-ftp');
const os = require('os');

const MAX_SCAN_DEPTH = 12;
// Maximum concurrent dlClient connections during FTP scan.
// PS5 FTP daemons (etaHEN/ftpsrv) support 3–4 simultaneous connections total.
// The scan client occupies 1 slot, leaving at most 2–3 for downloads.
// Setting this to 1 means at most 2 total (scan + 1 download) — safest for
// PS5 stability. Increasing to 2 speeds things up slightly but risks crashes
// on daemons that hard-limit at 3 connections.
const MAX_FTP_SCAN_DL_CONNECTIONS = 1;
// Delay in ms between sequential dlClient connection attempts during scan.
// Gives the PS5's FTP daemon time to fully release a socket before we connect again.
const FTP_SCAN_INTER_OP_DELAY_MS = 200;
const SCAN_CONCURRENCY        = 64;    // Reduced from 128 — less aggressive on secondary drives
const DIR_READDIR_TIMEOUT_MS  = 8000;  // Network paths: 8s per readdir
const LOCAL_READDIR_TIMEOUT_MS = 10000; // Local drives: 10s — secondary NVMe can stall mid-walk
const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024 * 1024; // 200GB limit for sanity
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 100;
// 512 MB safety buffer for free-space pre-check: accounts for filesystem overhead,
// metadata, and in-progress writes so we don't fill the drive completely.
const DISK_SPACE_SAFETY_BUFFER_BYTES = 512 * 1024 * 1024;
// Max files to inspect when checking for zero-byte corruption — balances thoroughness
// against scan time on large game directories (some PS5 games have thousands of files).
const MAX_FILES_TO_CHECK_FOR_CORRUPTION = 500;

const VERSION   = require('./package.json').version;
const apiServer = require('./api-server');

// ── API server state ──────────────────────────────────────────────────────────
// Keeps the last scanned library available to the REST API without re-scanning.
let apiLibrary        = [];
let apiScanActive     = false;
let apiScanSource     = '';
let apiScanProgress   = { found: 0, sized: 0, total: 0 };
let apiTransferActive = false;
let apiTransferProg   = {};

// ── Core helpers ─────────────────────────────────────────────────────────────
function sanitize(name) {
  if (!name) return 'Unknown';
  // Only strip characters that are truly invalid on common filesystems (FAT32/NTFS/ext4):
  // < > : " / \ | ? * and control characters 0x00–0x1F.
  // Preserve: ! ' ™ and other characters that legitimately appear in game titles.
  return String(name).replace(/[<>:"/\|?*\x00-\x1F]/g, '').trim().slice(0, 200) || 'Unknown';
}

function deriveSafeGameName(item, parsed) {
  if (item?.displayTitle) return item.displayTitle;
  if (item?.dbTitle) return item.dbTitle;
  if (item?.folderName) return item.folderName;
  if (parsed?.titleName) return parsed.titleName;
  const p = item && (item.contentFolderPath || item.folderPath) || '';
  const seg = (p + '').replace(/[\/\\]+$/, '').split(/[\/\\]/).pop() || '';
  if (seg) return seg;
  if (item?.ppsa) return item.ppsa;
  return 'Unknown Game';
}

// Platform-aware path joining:
// - FTP destinations (ftp://...) always use POSIX forward slashes
// - Local/UNC/network destinations use OS-native path.join (backslash on Windows, slash on Linux/Mac)
// On Windows, paths > 260 chars fail unless prefixed with \\?\
// (Win32 extended-length path). Common with OneDrive ("OneDrive - Company Name")
// and Dropbox where sync folders add many path segments.
function toExtendedPath(p) {
  if (process.platform !== 'win32') return p;
  if (!p || typeof p !== 'string') return p;
  if (p.startsWith('\\\\?\\') || p.startsWith('//?/')) return p; // already prefixed
  if (p.startsWith('ftp://')) return p; // FTP paths are not filesystem paths
  if (p.length <= 248) return p; // short enough — no prefix needed
  const norm = p.replace(/\//g, '\\');
  if (/^[A-Za-z]:\\/.test(norm)) return '\\\\?\\' + norm;
  if (norm.startsWith('\\\\')) return '\\\\?\\UNC\\' + norm.slice(2);
  return p;
}

function pathJoin(base, ...rest) {
  const allParts = [base, ...rest].filter(Boolean);
  if (base && base.startsWith('ftp://')) {
    const cleanBase = base.replace(/\/+$/, '');
    const segments  = rest.filter(Boolean);
    const joined    = [cleanBase, ...segments].join('/');
    return joined.replace(/([^:])\/\/+/g, '$1/');
  }
  return toExtendedPath(path.join(...allParts));
}


console.log('[main] Starting PS5 Vault v' + VERSION);

// Log crashes without force-exiting — calling process.exit(1) on any
// unhandledRejection is too aggressive for an Electron app: background
// Phase 3 size-calc errors or FTP timeouts would kill the whole UI.
process.on('uncaughtException', (err) => {
  console.error('[main] Uncaught exception:', err);
  // Don't exit — let Electron's crash reporter handle it
});
process.on('unhandledRejection', (err) => {
  console.error('[main] Unhandled rejection:', err);
});

// State
const activeCancelFlags = new Map();
let currentScanId = 0; // incremented on every scan-source call; prevents stale sizing timers
let sizeCache = new Map(); // In-memory cache (survives repeat scans within a session)
// Tracks any currently-running background size calculation so a new scan
// can abort the old one before it starts, preventing I/O thread saturation.
let activeSizingController = null;
// Local folder size cache: folderPath → bytes.
// Keyed by folderPath so repeat scans (or new scans after an abort) skip
// the expensive re-walk for games that were already measured this session.
const localSizeCache = new Map();

// ── Persistent FTP size cache ─────────────────────────────────────────────────
// Survives app restarts. Validated with a single LIST before trusting,
// so repeat scans of unchanged games are instant regardless of file count.
const DISK_CACHE_VERSION = 2;
const DISK_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days TTL
let diskSizeCache = {};      // { [cacheKey]: { totalSize, fileCount, topLevelCount, cachedAt } }
let diskCacheSaveTimer = null;

function getFtpSizeCachePath() {
  try { return path.join(app.getPath('userData'), 'ftp-size-cache.json'); }
  catch (_) { return path.join(os.homedir(), '.ps5vault-ftp-size-cache.json'); }
}

function loadFtpSizeCacheFromDisk() {
  try {
    const raw = fs.readFileSync(getFtpSizeCachePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === DISK_CACHE_VERSION && typeof parsed.entries === 'object') {
      diskSizeCache = parsed.entries;
      console.log('[FTP Cache] Loaded', Object.keys(diskSizeCache).length, 'cached entries from disk');
    }
  } catch (_) {
    diskSizeCache = {};
  }
}

function scheduleDiskCacheSave() {
  if (diskCacheSaveTimer) return; // already queued
  diskCacheSaveTimer = setTimeout(() => {
    diskCacheSaveTimer = null;
    try {
      // Prune stale entries before writing
      const now = Date.now();
      for (const key of Object.keys(diskSizeCache)) {
        if (now - (diskSizeCache[key].cachedAt || 0) > DISK_CACHE_MAX_AGE_MS) {
          delete diskSizeCache[key];
        }
      }
      fs.writeFileSync(getFtpSizeCachePath(), JSON.stringify({ version: DISK_CACHE_VERSION, entries: diskSizeCache }, null, 2), 'utf8');
      console.log('[FTP Cache] Saved', Object.keys(diskSizeCache).length, 'entries to disk');
    } catch (e) {
      console.warn('[FTP Cache] Save failed:', e.message);
    }
  }, 2000); // Debounce: write 2s after last update
}

// ── Persistent local size cache ───────────────────────────────────────────────
// Stores local folder sizes across app restarts so large games (ASTRO BOT,
// Baldur's Gate 3) are only ever walked once.  Each entry is { size, cachedAt }.
let localSizeSaveTimer = null;
const LOCAL_SIZE_CACHE_VERSION = 1;
const LOCAL_SIZE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (reduced — stale values cause wrong sizes)

function getLocalSizeCachePath() {
  try { return path.join(app.getPath('userData'), 'local-size-cache.json'); }
  catch (_) { return path.join(os.homedir(), '.ps5vault-local-size-cache.json'); }
}

function loadLocalSizeCacheFromDisk() {
  try {
    const raw = fs.readFileSync(getLocalSizeCachePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === LOCAL_SIZE_CACHE_VERSION && typeof parsed.entries === 'object') {
      const now = Date.now();
      let loaded = 0;
      for (const [k, v] of Object.entries(parsed.entries)) {
        if (!(v && typeof v.size === 'number' && v.size > 0)) continue;
        if (now - (v.cachedAt || 0) >= LOCAL_SIZE_CACHE_MAX_AGE_MS) continue;
        // Validate against folder mtime: if folder was modified after caching,
        // discard the entry so the game is re-sized with fresh data.
        if (v.mtimeMs && v.mtimeMs > 0) {
          try {
            const st = fs.statSync(k);
            if (st.mtimeMs > v.mtimeMs + 5000) { // 5s grace for clock skew
              console.log('[Local Cache] Invalidated (folder modified):', k);
              continue;
            }
          } catch (_) { /* folder gone or inaccessible — skip */ continue; }
        }
        localSizeCache.set(k, v.size);
        loaded++;
      }
      console.log('[Local Cache] Loaded', loaded, 'local size entries from disk');
    }
  } catch (_) { /* fresh start */ }
}

function scheduleLocalSizeCacheSave() {
  if (localSizeSaveTimer) return;
  localSizeSaveTimer = setTimeout(() => {
    localSizeSaveTimer = null;
    try {
      const entries = {};
      const now = Date.now();
      for (const [k, val] of localSizeCache.entries()) {
        // val is either a raw number (legacy) or { size, mtimeMs, cachedAt }
        const size = typeof val === 'number' ? val : val?.size;
        const mtimeMs = typeof val === 'object' ? val?.mtimeMs : undefined;
        if (size > 0) entries[k] = { size, mtimeMs: mtimeMs || 0, cachedAt: now };
      }
      fs.writeFileSync(getLocalSizeCachePath(),
        JSON.stringify({ version: LOCAL_SIZE_CACHE_VERSION, entries }, null, 2), 'utf8');
      console.log('[Local Cache] Saved', Object.keys(entries).length, 'local size entries');
    } catch (e) {
      console.warn('[Local Cache] Save failed:', e.message);
    }
  }, 2000);
}

// Async drive discovery — never hangs on slow/unresponsive drives.
// Windows: uses `wmic logicaldisk` for reliable, instant results including
//          network shares, USB sticks, secondary M.2 drives, etc.
// Unix:    checks mountpoints with per-directory timeouts.
// ── Drive discovery ───────────────────────────────────────────────────────────
// Returns every accessible root path the OS exposes: local NVMe, USB, network,
// mapped shares — whatever has a drive letter on Windows or a mountpoint on Unix.
// Never hangs: each probe has its own timeout so a dead network share can't block.
async function getAllDrives() {
  if (process.platform === 'win32') {
    // Pure Node.js drive detection — no child_process, no wmic, no PowerShell.
    // wmic.exe and powershell.exe are flagged by ESET HIPS and similar AV products
    // as living-off-the-land binaries commonly used by malware. We avoid them entirely.
    //
    // Instead: probe all 26 drive letters with fs.promises.access() in parallel.
    // Each probe races against a 2-second timeout so a dead/ejected drive letter
    // (e.g. a stale network mapping) doesn't slow discovery down.
    // This is AV-safe — pure file system access, zero process spawning.
    const checks = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async letter => {
      const root = letter + ':\\';
      try {
        await Promise.race([
          fs.promises.access(root, fs.constants.R_OK),
          // 5s instead of 2s: size calculations (up to 32 stat() workers per game)
          // can saturate the 64 libuv I/O threads and cause access() to queue for
          // longer than 2s, making getAllDrives() return [] on repeat scans.
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ]);
        return root;
      } catch { return null; }
    });
    const found = (await Promise.all(checks)).filter(Boolean);

    // C:\ always first, then alphabetically
    found.sort((a, b) => {
      const ac = a.toUpperCase(), bc = b.toUpperCase();
      if (ac.startsWith('C:')) return -1;
      if (bc.startsWith('C:')) return 1;
      return ac.localeCompare(bc);
    });
    console.log('[getAllDrives] Windows drives found:', found);
    return found;
  }
  // ── Unix / macOS ──────────────────────────────────────────────────────────
  const candidates = [];
  if (process.platform === 'darwin') {
    // /Volumes is the canonical mount point root on macOS
    try {
      const vols = await fs.promises.readdir('/Volumes', { withFileTypes: true });
      for (const v of vols) {
        if (v.isDirectory() || v.isSymbolicLink()) candidates.push('/Volumes/' + v.name);
      }
    } catch (_) {}
  } else {
    // Linux: /media/<user>/*, /mnt/*, and root /
    candidates.push('/');
    for (const base of ['/media', '/mnt', '/run/media']) {
      try {
        const ents = await fs.promises.readdir(base, { withFileTypes: true });
        for (const e of ents) {
          if (e.isDirectory()) {
            const sub = base + '/' + e.name;
            // Check if it looks like a user dir (/media/username/*) or direct mount
            try {
              const subs = await fs.promises.readdir(sub, { withFileTypes: true });
              const hasMounts = subs.some(s => s.isDirectory());
              if (hasMounts) {
                // Could be /media/username — add children
                for (const s of subs) {
                  if (s.isDirectory()) candidates.push(sub + '/' + s.name);
                }
              } else {
                candidates.push(sub);
              }
            } catch (_) { candidates.push(sub); }
          }
        }
      } catch (_) {}
    }
  }

  // Filter to accessible directories
  const accessible = await Promise.all(candidates.map(async p => {
    try {
      await Promise.race([
        fs.promises.access(p, fs.constants.R_OK),
        new Promise((_, rej) => setTimeout(() => rej(), 2000)),
      ]);
      return p;
    } catch (_) { return null; }
  }));
  return accessible.filter(Boolean);
}

function isSkippableDir(name) {
  if (!name) return false;
  const n = String(name).toLowerCase();
  if (n.startsWith('.')) return true;
  // Only skip directories that DEFINITELY cannot contain PS5 game data.
  // Keep this list CONSERVATIVE — a false positive silently hides all games
  // under that path. Things like 'users', 'local', 'build', 'cache', 'dist'
  // are intentionally NOT in this list because real game libraries live there.
  const SKIP = new Set([
    // Windows OS core — guaranteed to never contain game files
    'windows', 'windows.old', 'winnt',
    'system volume information',
    '$recycle.bin', 'recycle.bin',
    '$windows.~bt', '$windows.~ws',
    'recovery', 'perflogs', 'msocache',
    // macOS system
    '.trashes', '.spotlight-v100', '.fseventsd',
    // Dev noise (exact folder names only)
    'node_modules', '__pycache__',
    // NOTE: 'tmp', 'temp', 'snapshots', 'trash' intentionally NOT here —
    // users may store games in C:\TEMP or similarly named folders.
  ]);
  return SKIP.has(n);
}

/**
 * Extracts PPSA key from a string.
 * @param {string} value - Input string.
 * @returns {string|null} PPSA key or null.
 */
function extractPpsaKey(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/PPSA\d{4,6}/i);
  if (m) return m[0].toUpperCase();
  const m2 = s.match(/\b(\d{5})\b/);
  if (m2) return 'PPSA' + m2[1];
  return null;
}

/**
 * Parses a PS5 param.sfo binary file and returns a param.json-compatible object.
 * Used as a fallback when param.json is absent (e.g., some ftpsrv game dumps).
 * @param {Buffer} buf - Raw binary content of param.sfo.
 * @returns {object|null} Parsed fields or null if the buffer is not a valid SFO.
 */
function parseSfo(buf) {
  // Minimum valid SFO: 4 magic + 4 version + 4 key_table_offset + 4 data_table_offset + 4 num_entries = 20 bytes
  if (!Buffer.isBuffer(buf) || buf.length < 20) return null;
  // Magic: \x00PSF
  if (buf[0] !== 0x00 || buf[1] !== 0x50 || buf[2] !== 0x53 || buf[3] !== 0x46) return null;
  try {
    const keyTableStart  = buf.readUInt32LE(8);
    const dataTableStart = buf.readUInt32LE(12);
    const numEntries     = buf.readUInt32LE(16);
    const result = {};
    for (let i = 0; i < numEntries; i++) {
      const base       = 20 + i * 16;
      if (base + 16 > buf.length) break;
      const keyOff     = buf.readUInt16LE(base);
      const dataLen    = buf.readUInt32LE(base + 8);
      const dataOff    = buf.readUInt32LE(base + 12);
      // Read null-terminated key string
      let keyEnd = keyTableStart + keyOff;
      while (keyEnd < buf.length && buf[keyEnd] !== 0) keyEnd++;
      const key = buf.slice(keyTableStart + keyOff, keyEnd).toString('ascii');
      // Read value (strip trailing null bytes for strings)
      const valStart = dataTableStart + dataOff;
      const val = buf.slice(valStart, Math.min(valStart + dataLen, buf.length));
      result[key] = val.toString('utf8').replace(/\0+$/, '');
    }
    if (!result.TITLE && !result.TITLE_ID && !result.CONTENT_ID) return null;
    // Map SFO keys to param.json-compatible fields
    return {
      contentId:      result.CONTENT_ID || result.TITLE_ID || null,
      titleId:        result.TITLE_ID   || null,
      contentVersion: result.APP_VER    || result.VERSION || null,
      localizedParameters: result.TITLE ? { en: { titleName: result.TITLE } } : undefined,
    };
  } catch (_) {
    return null;
  }
}


/**
 * Normalizes SKU string.
 * @param {string} s - SKU string.
 * @returns {string|null} Normalized SKU.
 */
function normalizeSku(s) {
  if (!s) return null;
  return String(s).replace(/[^A-Za-z0-9]/g, '').toUpperCase().trim();
}

/**
 * Safely reads and parses JSON from a file.
 * @param {string} fp - File path.
 * @returns {object|null} Parsed JSON or null.
 */
async function readJsonSafe(fp) {
  try {
    let txt = await fs.promises.readFile(fp, 'utf8');
    txt = txt.replace(/^\uFEFF/, ''); // Remove BOM
    return JSON.parse(txt);
  } catch (_) {
    return null;
  }
}

/**
 * Gets title from param.json.
 * @param {object} parsed - Parsed JSON.
 * @param {string} preferredRegion - Preferred region.
 * @returns {string|null} Title or null.
 */
function getTitleFromParam(parsed, preferredRegion) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.titleName && typeof parsed.titleName === 'string') return parsed.titleName;
  const lp = parsed.localizedParameters;
  if (!lp || typeof lp !== 'object') return null;
  let regionKey = preferredRegion || lp.defaultLanguage || lp['defaultLanguage'] || 'en-US';
  if (regionKey && typeof regionKey === 'string') regionKey = regionKey.trim();
  if (regionKey && lp[regionKey]?.titleName) return lp[regionKey].titleName;
  if (regionKey && /^[A-Za-z]{2}$/.test(regionKey)) {
    const up = regionKey.toUpperCase();
    if (lp[up]?.titleName) return lp[up].titleName;
    for (const k of Object.keys(lp)) {
      if (k.toUpperCase().endsWith('-' + up) && lp[k]?.titleName) return lp[k].titleName;
    }
  }
  const langOnly = regionKey && regionKey.includes('-') ? regionKey.split('-')[0] : (regionKey && regionKey.length === 2 ? regionKey : null);
  if (langOnly) {
    for (const k of Object.keys(lp)) {
      if (k.toLowerCase().startsWith(langOnly.toLowerCase()) && lp[k]?.titleName) return lp[k].titleName;
    }
  }
  if (lp['en-US']?.titleName) return lp['en-US'].titleName;
  if (lp['en-GB']?.titleName) return lp['en-GB'].titleName;
  for (const k of Object.keys(lp)) {
    if (lp[k]?.titleName) return lp[k].titleName;
  }
  return null;
}

async function findAnyIconNearby(startDir, maxDepth = 2) {
  if (!startDir) return null;
  const rx = [/^icon0\.(png|jpg|jpeg)$/i, /^icon\.(png|jpg|jpeg)$/i, /^cover\.(png|jpg|jpeg)$/i, /^tile0\.(png|jpg|jpeg)$/i];
  async function walk(dir, depth) {
    if (depth > maxDepth) return null;
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isFile()) {
          if (rx.some(r => r.test(ent.name))) return full;
        } else if (ent.isDirectory() && !isSkippableDir(ent.name)) {
          const found = await walk(full, depth + 1);
          if (found) return found;
        }
      }
    } catch (_) {}
    return null;
  }
  return await walk(startDir, 0);
}

/**
 * Finds all param.json files in a directory.
 * @param {string} startDir - Starting directory.
 * @param {number} maxDepth - Maximum depth.
 * @param {AbortSignal} [signal] - Abort signal.
 * @returns {Promise<string[]>} Array of param.json paths.
 */
/**
 * Reads a directory with a per-call timeout so a hung network share
 * or slow drive can't stall the whole scan indefinitely.
 */
// On Windows, NTFS junctions and symlinks show as ent.isSymbolicLink() = true
// but ent.isDirectory() = false with readdir({ withFileTypes: true }).
// isDirEntry() returns true for both real directories AND junctions/symlinks that
// point to directories, enabling the scanner to follow them.
// A visited-paths Set (passed in from the walk) prevents infinite loops on circular links.
async function isDirEntry(ent, fullPath, visited) {
  if (ent.isDirectory()) return true;
  if (!ent.isSymbolicLink()) return false;
  // Symlink/junction: resolve the real path and check it's a directory
  try {
    const real = await fs.promises.realpath(fullPath);
    if (visited && visited.has(real)) return false; // circular — skip
    if (visited) visited.add(real);
    const st = await fs.promises.stat(fullPath); // stat follows the link
    return st.isDirectory();
  } catch (_) { return false; }
}


// Local drives (C:\, D:\, /home/…) are always fast — no overhead.
// Network/UNC paths (\\server\share, smb://, etc.) need the guard.
function isNetworkPath(p) {
  if (!p) return false;
  const s = String(p);
  return s.startsWith('\\\\') || s.startsWith('//') ||
         s.startsWith('ftp://') || s.startsWith('smb://') ||
         s.startsWith('nfs://');
}

async function readdirSafe(dir, isNet) {
  // ALL drives get a timeout — secondary NVMe drives can stall mid-walk just
  // like network shares, hanging a worker indefinitely without one.
  // Local drives get a longer timeout (10s) than network (8s).
  const timeoutMs = isNet ? DIR_READDIR_TIMEOUT_MS : LOCAL_READDIR_TIMEOUT_MS;
  return Promise.race([
    fs.promises.readdir(dir, { withFileTypes: true }),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`readdir timeout (${timeoutMs}ms): ${dir}`)), timeoutMs)
    ),
  ]);
}

// Pipelined param.json discovery + optional live callback.
// Walk the filesystem with SCAN_CONCURRENCY workers (DFS / LIFO queue).
// Each param.json found is pushed to `onFound(path)` immediately so
// the caller can start parsing in parallel with the ongoing walk.
// UV_THREADPOOL_SIZE=64 at the top of the file gives 16x more OS-level
// I/O parallelism than the Node.js default of 4 threads.
async function findAllParamJsons(startDir, maxDepth, signal, onFound) {
  if (maxDepth == null) maxDepth = MAX_SCAN_DEPTH;
  const isNet   = isNetworkPath(startDir);
  const out     = [];
  const queue   = [{ dir: startDir, depth: 0 }];
  const visited = new Set(); // guard against circular symlinks/junctions
  let   active  = 0;

  await new Promise(resolve => {
    function tryFinish() { if (active === 0 && queue.length === 0) resolve(); }

    function spawnWorker() {
      while (!signal?.aborted && queue.length > 0 && active < SCAN_CONCURRENCY) {
        const { dir, depth } = queue.pop(); // LIFO = DFS: reaches sce_sys fast
        active++;

        // async IIFE so we can await isDirEntry inside
        (async () => {
          try {
            const entries = await readdirSafe(dir, isNet);
            for (const ent of entries) {
              if (signal?.aborted) break;
              if (ent.isFile() && /^param\.json$/i.test(ent.name)) {
                const fp = path.join(dir, ent.name);
                out.push(fp);
                try { onFound?.(fp); } catch (_) {}
              } else if (!ent.isFile() && !isSkippableDir(ent.name) && depth < maxDepth) {
                const full = path.join(dir, ent.name);
                // Follows both real dirs AND Windows junctions/symlinks
                if (await isDirEntry(ent, full, visited).catch(() => false)) {
                  queue.push({ dir: full, depth: depth + 1 });
                  spawnWorker();
                }
              }
            }
          } catch (_) {}
        })().finally(() => {
          active--;
          spawnWorker();
          tryFinish();
        });
      }
      tryFinish();
    }

    spawnWorker();
  });

  return out;
}



// FS + transfer helpers (optimized)
// Parallel 32-worker file enumeration with sizes.
// Replaces the old serial BFS — 10-30x faster on NVMe for large game trees.
// Used by FTP upload (needs full file list) and size pre-calculation fallback.
async function listAllFilesWithStats(rootDir, signal, maxFiles = Infinity) {
  const LIST_WORKERS = 32;
  const files = [];
  const dirQueue = [{ dir: rootDir, rel: '' }];
  let active = 0;

  await new Promise(resolve => {
    function tryFinish() { if (active === 0 && dirQueue.length === 0) resolve(); }

    function spawnWorker() {
      while (!signal?.aborted && dirQueue.length > 0 && active < LIST_WORKERS && files.length < maxFiles) {
        const { dir, rel } = dirQueue.pop();
        active++;
        (async () => {
          try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            const statPs = [];
            for (const ent of entries) {
              if (signal?.aborted || files.length >= maxFiles) break;
              const full = path.join(dir, ent.name);
              const r    = rel ? path.join(rel, ent.name) : ent.name;
              if (ent.isFile()) {
                statPs.push(
                  fs.promises.stat(full)
                    .then(st => { if (st.size <= MAX_FILE_SIZE_BYTES) files.push({ fullPath: full, relPath: r, size: st.size }); })
                    .catch(() => {})
                );
              } else if (!isSkippableDir(ent.name)) {
                if (ent.isDirectory()) {
                  dirQueue.push({ dir: full, rel: r }); spawnWorker();
                } else if (ent.isSymbolicLink()) {
                  statPs.push(
                    fs.promises.stat(full).then(st => {
                      if (st.isDirectory()) { dirQueue.push({ dir: full, rel: r }); spawnWorker(); }
                      else if (st.size <= MAX_FILE_SIZE_BYTES) files.push({ fullPath: full, relPath: r, size: st.size });
                    }).catch(() => {})
                  );
                }
              }
            }
            await Promise.all(statPs);
          } catch (_) {}
        })().finally(() => { active--; spawnWorker(); tryFinish(); });
      }
      tryFinish();
    }
    spawnWorker();
  });
  return files;
}

async function hashFile(filePath, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(toExtendedPath(filePath), { highWaterMark: 4 * 1024 * 1024 });
    rs.on('error', reject);
    rs.on('data', chunk => { if (signal?.aborted) { rs.destroy(); reject(new Error('Aborted')); } else hash.update(chunk); });
    rs.on('end', () => resolve(hash.digest('hex')));
  });
}

async function copyFileStream(src, dst, progressCallback, cancelCheck) {
  const srcE = toExtendedPath(src);
  const dstE = toExtendedPath(dst);
  await fs.promises.mkdir(toExtendedPath(path.dirname(dst)), { recursive: true });
  return new Promise((resolve, reject) => {
    let bytesCopied = 0;
    const rs = fs.createReadStream(srcE,  { highWaterMark: 4 * 1024 * 1024 });
    const ws = fs.createWriteStream(dstE, { highWaterMark: 4 * 1024 * 1024 });
    rs.on('data', (chunk) => {
      if (cancelCheck()) {
        rs.destroy();
        ws.destroy();
        reject(new Error('Cancelled'));
      } else {
        bytesCopied += chunk.length;
        progressCallback?.({ type: 'go-file-progress', totalBytesCopied: bytesCopied });
        const ok = ws.write(chunk);
        if (!ok) rs.pause(); // backpressure: pause reads until the write buffer drains
      }
    });
    ws.on('drain', () => rs.resume()); // resume reading once the buffer has drained
    rs.on('end', () => ws.end());
    rs.on('error', (err) => { ws.destroy(); reject(err); });
    ws.on('error', (err) => { rs.destroy(); reject(err); });
    ws.on('finish', () => {
      // Emit go-file-complete so the caller's progressFn can accumulate
      // totalBytesCopiedSoFar correctly (it only increments on this event type).
      progressCallback?.({ type: 'go-file-complete', totalBytesCopied: bytesCopied });
      resolve();
    });
  });
}

/**
 * Copies a single file from srcPath to dstPath with SHA-256 hash verification.
 * Retries up to maxAttempts times on hash mismatch or I/O error.
 * @param {string} srcPath - Absolute path to the source file.
 * @param {string} dstPath - Absolute path to the destination file.
 * @param {Function} progressCallback - Called with byte-progress updates.
 * @param {Function} cancelCheck - Returns true if the operation should be cancelled.
 * @param {number} [maxAttempts] - Maximum retry attempts (default: RETRY_ATTEMPTS).
 * @returns {Promise<void>}
 */
// Errors from OneDrive/Dropbox when a file is locked while syncing or downloading:
// EPERM  — file locked during cloud download (OneDrive Files-on-Demand)
// EACCES — access denied (cloud client holding exclusive lock)
// EBUSY  — file in use (Dropbox mid-sync)
// EIO    — I/O error (partial download / network interruption)
const CLOUD_SYNC_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY', 'EIO']);

async function copyAndVerifyFile(srcPath, dstPath, progressCallback, cancelCheck, maxAttempts = 5) {
  const srcE = toExtendedPath(srcPath);
  const dstE = toExtendedPath(dstPath);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (cancelCheck()) throw new Error('Cancelled');
    try {
      // ── Checksum-DB skip: if dst exists and src hash is cached & matches dst size, skip copy ──
      const srcStat = await fs.promises.stat(srcE).catch(() => null);
      if (srcStat) {
        const cacheKey = crypto.createHash('sha1').update(srcPath + ':' + srcStat.size + ':' + srcStat.mtimeMs).digest('hex');
        const cached = checksumDb[cacheKey];
        if (cached) {
          const dstStat = await fs.promises.stat(dstPath).catch(() => null);
          if (dstStat && dstStat.size === srcStat.size) {
            // Destination exists with the same size and we have a verified hash — skip re-copy
            progressCallback?.({ type: 'go-file-complete', totalBytesCopied: srcStat.size });
            return;
          }
        }
      }

      await copyFileStream(srcE, dstE, progressCallback, cancelCheck);
      const ac = new AbortController();
      if (cancelCheck()) ac.abort();
      const [hSrc, hDst] = await Promise.all([
        hashFile(srcE, ac.signal),
        hashFile(dstE, ac.signal),
      ]);
      if (hSrc === hDst) {
        try { const fd = await fs.promises.open(dstE, 'r+'); await fd.sync(); await fd.close(); } catch (_) {}
        if (srcStat) {
          const cacheKey = crypto.createHash('sha1').update(srcPath + ':' + srcStat.size + ':' + srcStat.mtimeMs).digest('hex');
          checksumDb[cacheKey] = { hash: hSrc, size: srcStat.size, cachedAt: Date.now() };
          scheduleChecksumSave();
        }
        return;
      }
      await fs.promises.unlink(dstE).catch(_ => {});
      if (attempt === maxAttempts) throw new Error('Hash mismatch after retries');
    } catch (e) {
      if (attempt === maxAttempts) throw e;
      // OneDrive/Dropbox: file locked while cloud client downloads or syncs it.
      // Back off for up to 10s to give the cloud client time to release the lock.
      const delay = CLOUD_SYNC_ERRORS.has(e.code)
        ? Math.min(10000, 2000 * attempt)
        : RETRY_DELAY_MS;
      if (CLOUD_SYNC_ERRORS.has(e.code)) {
        console.warn('[Transfer] Cloud lock on', srcPath, `(${e.code}) — retrying in ${delay}ms (attempt ${attempt})`);
      }
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

async function removePathRecursive(p) {
  if (!p || typeof p !== 'string') return;

  // Normalise to absolute so relative paths can't bypass checks.
  const abs = path.resolve(p);

  // Refuse paths that are too shallow (need at least 2 segments deep).
  const segments = abs.split(path.sep).filter(Boolean);
  if (segments.length < 2) {
    console.error('[removePathRecursive] REFUSED — path too shallow:', abs);
    throw new Error('Refusing to delete shallow path: ' + abs);
  }

  // Deny known dangerous roots.
  const dangerous = ['/', '/data', '/mnt', '/system', '/usr', '/etc',
    '/bin', '/sbin', '/lib', '/proc', '/dev', '/tmp'].map(d => path.resolve(d));
  if (dangerous.includes(abs)) {
    console.error('[removePathRecursive] REFUSED — protected path:', abs);
    throw new Error('Refusing to delete protected path: ' + abs);
  }

  // On Windows deny drive roots (C:\ etc.)
  if (process.platform === 'win32' && /^[A-Z]:\\?$/i.test(abs)) {
    console.error('[removePathRecursive] REFUSED — drive root:', abs);
    throw new Error('Refusing to delete drive root: ' + abs);
  }

  await fs.promises.rm(toExtendedPath(abs), { recursive: true, force: true });
}

async function ensureUniqueTarget(basePath) {
  let counter = 1;
  let candidate = basePath;
  while (true) {
    try {
      await fs.promises.stat(candidate);
      // Path exists — try next numbered suffix
      candidate = `${basePath} (${counter})`;
      counter++;
      if (counter > 100) throw new Error('Too many conflicts');
    } catch (e) {
      if (e.code === 'ENOENT') return candidate; // doesn't exist — use this name
      throw e; // permission denied, network error, etc. — propagate
    }
  }
}

async function isSameDevice(srcPath, destParentPath) {
  try {
    const [sStat, dStat] = await Promise.all([
      fs.promises.stat(srcPath),
      fs.promises.stat(destParentPath).catch(() => null)
    ]);
    if (!sStat || !dStat) return false;
    return sStat.dev === dStat.dev;
  } catch (_) {
    return false;
  }
}

// ── Free space helper ──────────────────────────────────────────────────────────
// Returns available bytes on the drive containing dirPath.
// Uses fs.promises.statfs (Node 19+) with fallbacks for older runtimes.
async function getLocalFreeSpace(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') throw new Error('Invalid path');
  // Validate path is absolute and not an FTP URL
  if (dirPath.startsWith('ftp://')) throw new Error('FTP paths not supported');
  try {
    // Node 19+ native statfs — fastest path. Use extended path so OneDrive/Dropbox
    // long paths (> 260 chars) don't throw ENOENT on Windows.
    const stats = await fs.promises.statfs(toExtendedPath(dirPath));
    return stats.bavail * stats.bsize;
  } catch (_) {
    // Fallback: platform-specific CLI tools
    return new Promise((resolve, reject) => {
      if (process.platform === 'win32') {
        // Extract drive letter (e.g. "C:") from path
        const drive = path.parse(dirPath).root.replace(/[\/\\]$/, '') || 'C:';
        execFile('wmic', ['logicaldisk', 'where', `DeviceID="${drive}"`, 'get', 'FreeSpace', '/value'], { timeout: 10000 }, (err, stdout) => {
          if (err) return reject(err);
          const m = stdout.match(/FreeSpace=(\d+)/);
          if (m) resolve(parseInt(m[1], 10));
          else reject(new Error('Could not parse wmic output'));
        });
      } else {
        execFile('df', ['-k', dirPath], { timeout: 10000 }, (err, stdout) => {
          if (err) return reject(err);
          const lines = stdout.trim().split('\n');
          if (lines.length < 2) return reject(new Error('Could not parse df output'));
          const parts = lines[1].trim().split(/\s+/);
          // df -k: columns are Filesystem, 1K-blocks, Used, Available, ...
          const availKb = parseInt(parts[3], 10);
          if (isNaN(availKb)) return reject(new Error('Could not parse df available'));
          resolve(availKb * 1024);
        });
      }
    });
  }
}

async function renameFileSameDevice(srcPath, dstPath, overwriteMode) {
  const srcE = toExtendedPath(srcPath);
  const dstE = toExtendedPath(dstPath);
  const exists = await fs.promises.stat(dstE).catch(() => false);
  let finalDst = dstPath;
  if (exists) {
    if (overwriteMode === 'skip') return { skipped: true, target: dstPath };
    if (overwriteMode === 'overwrite') await removePathRecursive(dstPath);
    else finalDst = await ensureUniqueTarget(dstPath);
  }
  const finalDstE = toExtendedPath(finalDst);
  await fs.promises.mkdir(toExtendedPath(path.dirname(finalDst)), { recursive: true });
  await fs.promises.rename(srcE, finalDstE);
  return { moved: true, target: finalDst };
}

async function copyFolderContentsSafely(srcDir, finalTarget, options = {}) {
  const progress = options.progress;
  const cancelCheck = options.cancelCheck || (() => false);
  const totalBytes = options.totalBytes || 0;
  const skipVerify = options.skipVerify === true;

  // Copy src directly to finalTarget — no temp dir, no double-copy.
  // progress events use proper objects so the UI bar updates correctly.
  async function copyDirRecursive(src, dst) {
    const srcE = toExtendedPath(src);
    const dstE = toExtendedPath(dst);
    await fs.promises.mkdir(dstE, { recursive: true });
    const entries = await fs.promises.readdir(srcE, { withFileTypes: true });
    for (const ent of entries) {
      if (cancelCheck()) throw new Error('Cancelled');
      const srcPath = path.join(src, ent.name);
      const dstPath = path.join(dst, ent.name);
      const srcPathE = toExtendedPath(srcPath);
      const dstPathE = toExtendedPath(dstPath);
      if (ent.isFile()) {
        const srcStat = await fs.promises.stat(srcPathE).catch(() => ({ size: 0 }));
        const size = srcStat.size || 0;
        // File-level resume: skip if destination already exists with the same size
        const dstStat = await fs.promises.stat(dstPathE).catch(() => null);
        if (dstStat && dstStat.size === size) {
          // Check checksum DB — if we have a verified entry for this src, trust it
          let skipConfirmed = true; // size match is good enough for skipVerify mode
          if (!skipVerify && typeof srcStat.mtimeMs === 'number') {
            const ck = crypto.createHash('sha1').update(srcPath + ':' + srcStat.size + ':' + srcStat.mtimeMs).digest('hex');
            // Only skip if checksum DB confirms this file (or fall back to size-only)
            skipConfirmed = !!checksumDb[ck];
          }
          if (skipConfirmed) {
            // Already fully copied — emit complete with 0 new bytes so the accumulator
            // doesn't double-count bytes that were written in a previous run.
            progress?.({ type: 'go-file-complete', fileRel: ent.name, totalBytesCopied: 0, totalBytes });
            continue;
          }
        }
        if (skipVerify) {
          await copyFileStream(
            srcPathE, dstPathE,
            (info) => progress?.({ type: 'go-file-progress', fileRel: ent.name, totalBytesCopied: info?.totalBytesCopied || 0, totalBytes }),
            cancelCheck
          );
        } else {
          await copyAndVerifyFile(
            srcPathE, dstPathE,
            (info) => progress?.({ type: 'go-file-progress', fileRel: ent.name, totalBytesCopied: info?.totalBytesCopied || 0, totalBytes }),
            cancelCheck
          );
        }
        progress?.({ type: 'go-file-complete', fileRel: ent.name, totalBytesCopied: size, totalBytes });
      } else if (!ent.isFile() && !isSkippableDir(ent.name)) {
        const fallbackIsDir = ent.isDirectory();
        const isDir = typeof isDirEntry === 'function'
          ? await isDirEntry(ent, srcPath, null).catch(() => fallbackIsDir)
          : fallbackIsDir;
        if (isDir) {
          try {
            await copyDirRecursive(srcPath, dstPath);
          } catch (e) {
            // Re-throw Cancelled so the outer handler can mark the transfer as cancelled.
            // For other errors (e.g. EPERM on system subdirs), log and re-throw so the
            // game-level result is marked as an error rather than falsely reporting success.
            if (e?.message === 'Cancelled') throw e;
            console.warn('[Transfer] copyDirRecursive failed for', srcPath, ':', e?.message || String(e));
            throw e;
          }
        }
      }
    }
  }

  await fs.promises.mkdir(toExtendedPath(path.dirname(finalTarget)), { recursive: true });
  await copyDirRecursive(srcDir, finalTarget);
}

async function moveFolderContentsSafely(srcDir, finalTarget, options = {}) {
  const progress = options.progress;
  const cancelCheck = options.cancelCheck || (() => false);
  const overwriteMode = options.overwriteMode || 'rename';
  const totalBytes = options.totalBytes || 0;

  await fs.promises.mkdir(toExtendedPath(path.dirname(finalTarget)), { recursive: true });
  const sameDevice = await isSameDevice(toExtendedPath(srcDir), toExtendedPath(path.dirname(finalTarget)));

  if (sameDevice) {
    // Same filesystem: try atomic rename (instant, no byte copying needed).
    // Guard with EXDEV catch: on Windows, stat.dev=0 for ALL network drives so
    // isSameDevice can return true for two different SMB shares. If rename throws
    // EXDEV (cross-device), fall through to copy+delete gracefully.
    try {
      const res = await renameFileSameDevice(srcDir, finalTarget, overwriteMode);
      if (res.moved) {
        progress?.({ type: 'go-file-complete', fileRel: path.basename(res.target), totalBytesCopied: totalBytes, totalBytes });
      } else if (res.skipped) {
        progress?.({ type: 'go-file-complete', fileRel: path.basename(finalTarget), totalBytesCopied: 0, totalBytes: 0 });
      }
      // do NOT fire go-complete here — doEnsureAndPopulate owns that
      return;
    } catch (e) {
      if (e.code !== 'EXDEV') throw e; // Re-throw anything that isn't a cross-device error
      console.warn('[Move] EXDEV on rename (network drive false-positive) — falling back to copy+delete');
      // Fall through to cross-device copy path below
    }
  }

  // Different device (or EXDEV fallback): copy then delete source
  await copyFolderContentsSafely(srcDir, finalTarget, { progress, cancelCheck, totalBytes });
  await removePathRecursive(srcDir);
}

// FTP scan (added back for compatibility)
let ftpClientBusy = false;

async function withFtpLock(fn) {
  while (ftpClientBusy) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  ftpClientBusy = true;
  try {
    return await fn();
  } finally {
    ftpClientBusy = false;
  }
}

// ── FTP connection concurrency budget ────────────────────────────────────────
// Sizing uses a two-phase approach to avoid slow uncached walks blocking fast
// cached validations:
//
// PS5 FTP supports ≤4 simultaneous connections. All sizing uses a single
// shared connection — reliable and fast on a local network (<5 ms per LIST).
// Legacy constants — used by downloadFtpFolder (ftpConfig.parallel) and fallbacks
const GAME_CONCURRENCY  = 3;
const WORKERS_PER_GAME  = 2;
// Parallel connections per game during sizing. PS5 FTP supports ~5 simultaneous
// connections; 3 workers leaves headroom so no slot is ever refused.
const SIZE_WALK_WORKERS = 3;
// Cache entries younger than FTP_CACHE_FRESH_MS are trusted with zero network calls
const FTP_CACHE_FRESH_MS = 60 * 60 * 1000; // 1 hour

// Minimal p-limit style concurrency limiter (no npm dependency)
function makeConcurrencyLimiter(maxConcurrent) {
  let active = 0;
  const waitQueue = [];
  return function limit(asyncFn) {
    return new Promise((resolve, reject) => {
      const attempt = async () => {
        active++;
        try { resolve(await asyncFn()); }
        catch (e) { reject(e); }
        finally {
          active--;
          if (waitQueue.length > 0) waitQueue.shift()();
        }
      };
      if (active < maxConcurrent) attempt();
      else waitQueue.push(attempt);
    });
  };
}


// ── Reusable FTP connection pool ─────────────────────────────────────────────
// Connections are created lazily on first demand and reused across callers.
// A caller calls pool.acquire() → gets a client, calls pool.release(client).
// If a connection breaks, it is discarded; the next acquire() creates a fresh one.
class FtpConnectionPool {
  constructor(accessOpts, maxSize = 4) {
    this._opts    = accessOpts;
    this._maxSize = maxSize;
    this._idle    = [];   // connected, ready to use
    this._active  = 0;    // total checked out + idle
    this._waiters = [];   // resolve fns waiting for a free slot
  }

  async acquire() {
    // Return an idle connection if one is available and alive
    while (this._idle.length > 0) {
      const c = this._idle.pop();
      try { c.ftp.socket.writable; return c; } catch (_) { this._active--; /* discard dead */ }
    }
    // Create a new connection if under limit
    if (this._active < this._maxSize) {
      this._active++;
      const c = new ftp.Client();
      c.ftp.verbose = false;
      if (this._opts._passive === false) c.ftp.passive = false;
      try {
        await c.access(this._opts);
        return c;
      } catch (e) {
        this._active--;
        throw e;
      }
    }
    // Pool exhausted — wait for a release
    return new Promise((resolve, reject) => {
      this._waiters.push({ resolve, reject });
    });
  }

  release(client) {
    if (this._waiters.length > 0) {
      // Hand directly to next waiter without going idle
      const { resolve } = this._waiters.shift();
      resolve(client);
    } else {
      this._idle.push(client);
    }
  }

  closeAll() {
    for (const c of this._idle) { try { c.close(); } catch (_) {} }
    this._idle = [];
    this._active = 0;
  }
}

// ── Cache helpers ─────────────────────────────────────────────────────────────
// checkFtpCacheEntrySync — zero network. Returns result if in-memory or fresh
//   disk cache (<FTP_CACHE_FRESH_MS), otherwise null.
// checkFtpCacheEntry — async. Validates older disk entries with one LIST via
//   the supplied sharedClient. Pass null to treat older entries as cache misses.
function checkFtpCacheEntrySync(ftpConfig, rootPath) {
  const cacheKey = `${ftpConfig.host}:${ftpConfig.port}:${rootPath}`;
  if (sizeCache.has(cacheKey)) return sizeCache.get(cacheKey);
  const d = diskSizeCache[cacheKey];
  if (!d || typeof d.totalSize !== 'number') return null;
  const age = Date.now() - (d.cachedAt || 0);
  if (age > DISK_CACHE_MAX_AGE_MS) return null;
  if (age < FTP_CACHE_FRESH_MS) {
    const r = { files: [], totalSize: d.totalSize, fileCount: d.fileCount, dirCount: 0, fromCache: true };
    sizeCache.set(cacheKey, r);
    return r;
  }
  return null; // needs async validation
}

async function checkFtpCacheEntry(ftpConfig, rootPath, sharedClient = null) {
  // Memory + fresh disk cache — zero network, no client needed
  const quick = checkFtpCacheEntrySync(ftpConfig, rootPath);
  if (quick) return quick;

  const cacheKey = `${ftpConfig.host}:${ftpConfig.port}:${rootPath}`;
  const d = diskSizeCache[cacheKey];
  if (!d || typeof d.totalSize !== 'number') return null;
  const age = Date.now() - (d.cachedAt || 0);
  if (age > DISK_CACHE_MAX_AGE_MS) return null;

  // If no client supplied, serve the disk entry as-is (stale-but-present is
  // far better than a full re-walk on every scan restart).
  if (!sharedClient) {
    console.log(`[FTP Cache] HIT (no-validate) ${rootPath} → ${d.totalSize} bytes`);
    const r = { files: [], totalSize: d.totalSize, fileCount: d.fileCount || 0, dirCount: 0, fromCache: true };
    sizeCache.set(cacheKey, r);
    return r;
  }

  // Client supplied — validate with a single cd+LIST of the root
  try {
    let list;
    try { await sharedClient.cd(rootPath); }
    catch (_) { await sharedClient.cd('"' + rootPath.replace(/"/g, '\\"') + '"'); }
    list = await Promise.race([
      sharedClient.list(),
      new Promise((_, r) => setTimeout(() => r(new Error('val-timeout')), 5000))
    ]);
    if (list.length !== d.topLevelCount) {
      console.log(`[FTP Cache] STALE ${rootPath} (${d.topLevelCount}→${list.length})`);
      return null;
    }
    console.log(`[FTP Cache] HIT (validated) ${rootPath} → ${d.totalSize} bytes`);
  } catch (_) {
    console.warn(`[FTP Cache] Validation failed, serving stale for ${rootPath}`);
  }
  const r = { files: [], totalSize: d.totalSize, fileCount: d.fileCount || 0, dirCount: 0, fromCache: true };
  sizeCache.set(cacheKey, r);
  return r;
}

// Fast path:  checkFtpCacheEntry() — in-memory or validated disk cache.
// Slow path:  probe the root directory, spin up a worker pool, share a queue.
//
// Worker wake-up is event-based (no polling): a worker parks by awaiting a
// Promise that is resolved the instant any other worker pushes a new directory
// or the last in-flight worker finishes.
// Returns { files, totalSize, fileCount, dirCount, fromCache }.
async function buildFtpManifest(ftpConfig, rootPath, progressCallback, cancelCheck, workerCount = WORKERS_PER_GAME, sizeOnly = false) {
  // Only use cache for sizeOnly=true (scan/sizing phase).
  // sizeOnly walks never fill files[], so a cached {files:[]} handed to a download
  // would copy nothing. Downloads always walk fresh to populate files[].
  if (sizeOnly) {
    const cached = await checkFtpCacheEntry(ftpConfig, rootPath);
    if (cached) return cached;
  }

  // 3. Full parallel walk ─────────────────────────────────────────────────────
  const cacheKey = `${ftpConfig.host}:${ftpConfig.port}:${rootPath}`;
  const files    = [];
  let totalSize  = 0;
  let dirCount   = 0;
  let topLevelCount = 0;
  let inFlight   = 0; // workers currently inside an await client.list()

  const queue   = [];  // seeded by probe below
  const visited = new Set([rootPath]);

  // Event-based wake-up: replaces 5ms polling with zero-latency notification.
  // Each time a new dir is pushed (or the last in-flight worker finishes),
  // all parked workers are immediately resolved.
  const workerWaiters = [];
  function wakeWorkers() {
    while (workerWaiters.length > 0) workerWaiters.shift()();
  }
  function enqueueDir(dir) {
    if (!visited.has(dir)) {
      visited.add(dir);
      queue.push(dir);
      wakeWorkers(); // wake one parked worker immediately
    }
  }

  // PS5 FTP daemon rejects "LIST /path/with spaces" — it truncates at the first space.
  // The only reliable approach is CWD first, then LIST with no argument.
  // Each worker has its own dedicated connection so cd() is safe per-connection.
  async function ftpCdList(client, dirPath) {
    try {
      await client.cd(dirPath);
    } catch (_) {
      // Retry with explicit double-quotes (some PS5 firmware variants need this)
      await client.cd('"' + dirPath.replace(/"/g, '\\"') + '"');
    }
    return client.list();
  }

  async function worker(client) {
    while (true) {
      if (cancelCheck?.()) break;
      if (queue.length > 0) {
        const dir = queue.shift();
        inFlight++;
        dirCount++;
        try {
          let list = [];
          try {
            list = await Promise.race([
              ftpCdList(client, dir),
              new Promise((_, rej) => setTimeout(() => rej(new Error('list timeout')), 20000))
            ]);
          } catch (e) {
            console.warn('[FTP Manifest] list failed for', dir, e.message);
            // fall through to finally (inFlight--, wakeWorkers)
          }
          if (dir === rootPath) topLevelCount = list.length;
          for (const item of list) {
            if (!item?.name) continue;
            const itemPath = path.posix.join(dir, item.name);
            if (item.isFile) {
              // Always coerce to Number — some FTP servers return size as string
              const sz = Number(item.size) || 0;
              if (!sizeOnly) files.push({ remotePath: itemPath, relPath: path.posix.relative(rootPath, itemPath), size: sz });
              totalSize += sz;
              progressCallback?.({ type: 'ftp-manifest-progress', filesFound: files.length, bytesFound: totalSize, dirsWalked: dirCount });
            } else {
              // Directories AND symlinks are queued — symlinks on PS5 may point to dirs with files
              enqueueDir(itemPath);
            }
          }
        } finally {
          inFlight--;
          // If this was the last in-flight worker and queue is empty, wake all
          // parked workers so they can check the exit condition and break.
          if (inFlight === 0) wakeWorkers();
        }
      } else if (inFlight === 0) {
        break; // queue truly empty, nothing in flight — done
      } else {
        // Park until enqueueDir() or the last in-flight worker wakes us
        await new Promise(r => workerWaiters.push(r));
      }
    }
  }

  // ── Probe: list root, seed queue, keep connection as worker[0] ─────────────
  let adaptiveWorkers = workerCount;
  let probeClient = null;

  try {
    probeClient = new ftp.Client();
    probeClient.ftp.verbose = false;
    applyFtpPassive(probeClient, ftpConfig);
    await probeClient.access({
      host: ftpConfig.host, port: parseInt(ftpConfig.port, 10),
      user: ftpConfig.user || 'anonymous', password: ftpConfig.pass || '', secure: false
    });
    const probe = await Promise.race([
      ftpCdList(probeClient, rootPath),
      new Promise((_, r) => setTimeout(() => r(new Error('probe timeout')), 15000))
    ]);
    topLevelCount = probe.length;
    dirCount++; // rootPath itself
    for (const item of probe) {
      if (!item?.name) continue;
      const itemPath = path.posix.join(rootPath, item.name);
      if (item.isFile) {
        const sz = Number(item.size) || 0;
        if (!sizeOnly) files.push({ remotePath: itemPath, relPath: item.name, size: sz });
        totalSize += sz;
      } else {
        // Directories AND symlinks
        enqueueDir(itemPath);
      }
    }
    // Adaptive scaling: more subdirs → more workers, hard cap at 8 for PS5 stability
    const subDirCount = queue.length;
    if      (subDirCount > 50) adaptiveWorkers = Math.min(8, workerCount + 4);
    else if (subDirCount > 20) adaptiveWorkers = Math.min(6, workerCount + 2);
    adaptiveWorkers = Math.min(adaptiveWorkers, 8);
    // sizeOnly calls come one-game-at-a-time from the sizing loop; cap workers
    // so the total connections never exceed what the PS5 FTP daemon can serve.
    if (sizeOnly) adaptiveWorkers = Math.min(adaptiveWorkers, SIZE_WALK_WORKERS);
  } catch (e) {
    console.warn('[FTP Manifest] Probe failed, falling back to standard walk:', e.message);
    if (probeClient) { try { probeClient.close(); } catch (_) {} probeClient = null; }
    queue.push(rootPath); // standard walk starts from rootPath
  }

  // ── Spin up remaining worker connections in parallel ─────────────────────
  const accessOpts = {
    host: ftpConfig.host, port: parseInt(ftpConfig.port, 10),
    user: ftpConfig.user || 'anonymous', password: ftpConfig.pass || '', secure: false
  };
  const remainingCount = probeClient ? (adaptiveWorkers - 1) : adaptiveWorkers;
  const extraClients = (await Promise.all(
    Array.from({ length: remainingCount }, async () => {
      const c = new ftp.Client();
      c.ftp.verbose = false;
      applyFtpPassive(c, ftpConfig);
      try { await c.access(accessOpts); return c; }
      catch (e) { console.warn('[FTP Manifest] Worker connection failed:', e.message); return null; }
    })
  )).filter(Boolean);

  const clients = probeClient ? [probeClient, ...extraClients] : extraClients;
  if (clients.length === 0) throw new Error('All FTP worker connections failed');

  try {
    await Promise.all(clients.map(c => worker(c)));
  } finally {
    clients.forEach(c => { try { c.close(); } catch (_) {} });
  }

  const result = { files, totalSize, fileCount: files.length, dirCount, fromCache: false };
  sizeCache.set(cacheKey, result);
  diskSizeCache[cacheKey] = { totalSize, fileCount: files.length, topLevelCount, cachedAt: Date.now() };
  scheduleDiskCacheSave();
  return result;
}


async function scanFtpRecursive(client, remotePath, items, depth, onGameFound, accessOpts = null, _seenPaths = null, _dlSemaphore = null) {
  // _seenPaths: shared dedup Set across all candidate scans.
  // _dlSemaphore: shared concurrency limiter for all dlClient connections in this scan tree.
  //   Caps concurrent connections to MAX_FTP_SCAN_DL_CONNECTIONS (1) so the PS5 FTP daemon
  //   (which supports only 3-4 simultaneous connections) is never overwhelmed during scanning.
  if (!_seenPaths) _seenPaths = new Set();
  if (!_dlSemaphore) _dlSemaphore = makeConcurrencyLimiter(MAX_FTP_SCAN_DL_CONNECTIONS);
  if (depth > MAX_SCAN_DEPTH) return;
  // Never recurse into sce_sys — it only contains metadata, not games
  if (remotePath.includes('/sce_sys/') || remotePath.endsWith('/sce_sys')) return;

  try {
    try {
      await client.cd(remotePath);
    } catch (e) {
      await client.cd('"' + remotePath + '"');
    }
    // 10s timeout on list() — a corrupted/hung folder or frozen PS5 daemon can hang indefinitely
    const list = await Promise.race([
      client.list(),
      new Promise((_, r) => setTimeout(() => r(new Error('list timeout (10s): ' + remotePath)), 10000))
    ]);

    // ── Dedicated download connection ─────────────────────────────────────────
    // NEVER use the scan client for downloadTo. basic-ftp is single-threaded per
    // client: any cd/list call while a downloadTo is running on the same client
    // causes "User launched a task while another one is still running".
    //
    // Solution: each download creates a fresh FTP connection, uses it, then
    // closes it. PS5 FTP daemons support 3-5 simultaneous connections so a
    // transient second connection during param/cover download is fine.
    // Falls back to scan client only when no accessOpts are available (shouldn't
    // happen in practice — scanFtpSource always passes them).
    // ── downloadToBuffer: semaphore-guarded to cap concurrent PS5 FTP connections ──
    // Each call acquires the per-scan semaphore before opening a dlClient, releases
    // after closing it, and waits FTP_SCAN_INTER_OP_DELAY_MS before releasing so
    // the PS5's FTP daemon has time to fully close the socket. This ensures at most
    // MAX_FTP_SCAN_DL_CONNECTIONS (1) dedicated connections are open simultaneously,
    // preventing the daemon from being overwhelmed and crashing.
    const downloadToBuffer = async (p) => {
      if (!accessOpts) {
        // Fallback: legacy path using scan client with global lock (no semaphore needed)
        return new Promise((resolve, reject) => {
          const chunks = [];
          const writable = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
          writable.on('finish', () => resolve(Buffer.concat(chunks)));
          writable.on('error', reject);
          withFtpLock(() => client.downloadTo(writable, p)).catch(reject);
        });
      }
      // Semaphore-guarded dedicated connection
      return _dlSemaphore(async () => {
        const dlClient = new ftp.Client(8000); // 8s timeout — faster fail on dead paths
        dlClient.ftp.verbose = false;
        if (accessOpts.passive === false) dlClient.ftp.passive = false;
        try {
          await dlClient.access(accessOpts);
          const chunks = [];
          const writable = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
          const done = new Promise((res, rej) => {
            writable.on('finish', () => res(Buffer.concat(chunks)));
            writable.on('error', rej);
          });
          await dlClient.downloadTo(writable, p);
          return await done;
        } finally {
          try { dlClient.close(); } catch (_) {}
          // Inter-op delay: let PS5 FTP daemon fully release the socket before next connection
          await new Promise(r => setTimeout(r, FTP_SCAN_INTER_OP_DELAY_MS));
        }
      });
    };

    // ── Build a game record once param.json has been parsed ──────────────
    const buildAndEmit = async (data, gameFolderPath, outerFolderPath, folderName) => {
      const ppsaKey = extractPpsaKey(data.titleId || data.contentId || '');
      const sku     = normalizeSku(data.localizedParameters?.en?.['@SKU'] || '');
      const title   = getTitleFromParam(data, null);

      // Fetch cover from sce_sys inside gameFolderPath.
      // Limit to 3 most common PS5 cover locations to minimise connection count.
      // Skip entirely when this is a PPSA-only fallback (no real param.json found) —
      // there will be no cover, and probing would waste 3 connection cycles per game.
      let cover = '';
      const isMetadataFallback = !data.titleId && !data.localizedParameters;
      if (!isMetadataFallback) {
        const coverCandidates = [
          'sce_sys/icon0.png',  // Standard PS5 cover — present on 99% of games
          'sce_sys/icon0.jpg',  // JPEG fallback
          'icon0.png',          // Some non-standard dumps
        ];
        for (const cand of coverCandidates) {
          try {
            const buf = await downloadToBuffer(path.posix.join(gameFolderPath, cand));
            if (buf && buf.length > 100) {
              cover = 'data:image/png;base64,' + buf.toString('base64');
              console.log('[FTP] Fetched cover for:', title, 'using', cand);
              break;
            }
          } catch (_) {}
        }
        if (!cover) console.log('[FTP] No cover for:', title);
      }

      const record = {
        ppsa:             ppsaKey,
        ppsaFolderPath:   gameFolderPath,
        contentFolderPath: path.posix.join(gameFolderPath, 'sce_sys'),
        folderPath:       gameFolderPath,
        outerFolderPath:  outerFolderPath || null,
        folderName:       folderName || path.posix.basename(gameFolderPath),
        contentId:        data.contentId,
        skuFromParam:     sku,
        displayTitle:     title,
        region:           data.defaultLanguage || data.localizedParameters?.defaultLanguage || '',
        contentVersion:   data.contentVersion || data.masterVersion || data.version,
        sdkVersion:       data.sdkVersion,
        totalSize:        null,
        iconPath:         cover,
        paramParsed:      data,
      };
      console.log('[FTP] Found game:', title, 'at', gameFolderPath);
      // Deduplicate by folder path — prevents double-emit if multiple
      // candidate roots both lead to the same game folder.
      const emitPath = gameFolderPath.toLowerCase();
      if (_seenPaths.has(emitPath)) {
        console.log('[FTP] Skipping duplicate:', gameFolderPath);
        return null;
      }
      _seenPaths.add(emitPath);
      items.push(record);
      try { onGameFound?.(record); } catch (_) {}
      return record;
    };

    // ── Try fast direct-download of param.json ────────────────────────────
    // Attempt to grab param.json without listing subdirectories — much faster
    // than recursing into every folder. Works for the standard layout:
    //   games/PPSA12345/sce_sys/param.json   (depth 0: remotePath = games/)
    //   games/Title/PPSA12345/sce_sys/param.json  (depth 0: outer=Title, inner=PPSA*)
    // Falls through to full recursion if not found here.
    const ftpSkippable = new Set(['sandbox', '$recycle.bin', 'recycle.bin', 'windows',
      'program files', 'program files (x86)', 'programdata', 'system volume information',
      'sce_sys', 'sce_module', 'sce_discmap', 'media']);

    const dirsHere = list.filter(e => e.isDirectory && !ftpSkippable.has(e.name.toLowerCase()));

    // Track which subfolders we successfully handled as games so we don't recurse into them
    const handledPaths = new Set();

    for (const entry of dirsHere) {
      const entryPath = path.posix.join(remotePath, entry.name);

      // ── Attempt 1: entry itself is a game root (PPSA* or custom-named) ──
      let data = null;
      for (const paramLoc of ['sce_sys/param.json', 'param.json']) {
        try {
          const buf = await downloadToBuffer(path.posix.join(entryPath, paramLoc));
          data = JSON.parse(buf.toString('utf8'));
          break;
        } catch (_) {}
      }
      // Fallback: try param.sfo (binary format used when param.json is absent)
      if (!data) {
        for (const sfoLoc of ['sce_sys/param.sfo', 'param.sfo']) {
          try {
            const buf = await downloadToBuffer(path.posix.join(entryPath, sfoLoc));
            data = parseSfo(buf);
            if (data) break;
          } catch (_) {}
        }
      }
      // Last-resort fallback: if the folder name starts with PPSA and no metadata
      // could be downloaded (e.g. drakmor/ftpsrv blocks file access), include the
      // folder as a game using the PPSA ID as the content identifier so it still
      // appears in the library and can be transferred.
      // Range {4,6} matches the same width as extractPpsaKey() for consistency.
      if (!data && /^PPSA\d{4,6}/i.test(entry.name)) {
        data = { contentId: entry.name.toUpperCase() };
      }
      if (data) {
        await buildAndEmit(data, entryPath, null, entry.name);
        handledPaths.add(entryPath);
        continue;
      }

      // ── Attempt 2: entry is a wrapper folder (Title/PPSA*/sce_sys/param.json) ──
      // List one level down to find PPSA-style subfolders
      let subList = null;
      try {
        await Promise.race([client.cd(entryPath), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 4000))]);
        subList = await Promise.race([
          client.list(),
          new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 4000))
        ]);
      } catch (_) {}

      if (subList) {
        let foundInner = false;
        for (const sub of subList.filter(e => e.isDirectory)) {
          const subPath = path.posix.join(entryPath, sub.name);
          let innerData = null;
          for (const paramLoc of ['sce_sys/param.json', 'param.json']) {
            try {
              const buf = await downloadToBuffer(path.posix.join(subPath, paramLoc));
              innerData = JSON.parse(buf.toString('utf8'));
              break;
            } catch (_) {}
          }
          // Fallback: try param.sfo one level deeper
          if (!innerData) {
            for (const sfoLoc of ['sce_sys/param.sfo', 'param.sfo']) {
              try {
                const buf = await downloadToBuffer(path.posix.join(subPath, sfoLoc));
                innerData = parseSfo(buf);
                if (innerData) break;
              } catch (_) {}
            }
          }
          if (innerData) {
            await buildAndEmit(innerData, subPath, entryPath, entry.name);
            foundInner = true;
          }
        }
        if (foundInner) {
          handledPaths.add(entryPath);
          continue;
        }
      }

      // ── Attempt 3: not found by fast path — fall back to full recursion ──
      // This handles arbitrarily deep nesting (e.g. Title/Disc1/PPSA*/sce_sys/param.json)
      if (!handledPaths.has(entryPath)) {
        try {
          await scanFtpRecursive(client, entryPath, items, depth + 1, onGameFound, accessOpts, _seenPaths, _dlSemaphore);
        } catch (e) {
          console.error('[FTP] Error recursing into:', entryPath, e);
        }
      }
    }

  } catch (e) {
    // 550 = mount point doesn't exist on this PS5 — completely normal, log silently.
    // Connection/timeout = transient, show message only (no stack trace noise).
    // Other errors = scan content issue, show message only.
    const ftpCode = (e?.message || '').match(/^(\d{3})/)?.[1] || String(e?.code || '');
    if (ftpCode === '550' || (e?.message || '').includes('550')) {
      console.log('[FTP] Not present (550):', remotePath);
    } else if (/connect|timeout|closed|reset|ECONNRESET|ETIMEDOUT/i.test(e?.message || '')) {
      console.warn('[FTP] Connection error at', remotePath + ':', (e?.message || String(e)).slice(0, 100));
    } else {
      console.warn('[FTP] Scan error at', remotePath + ':', (e?.message || String(e)).slice(0, 120));
    }
  }
}

async function scanFtpSource(ftpUrl, scanOpts = {}) {
  const { sender = null, calcSize = true, ftpConfig: callerFtpCfg = null } = scanOpts;
  let url;
  try {
    url = new URL(ftpUrl);
    if (url.port && !/^\d+$/.test(url.port)) {
      throw new Error('Invalid port');
    }
  } catch (e) {
    // Attempt to fix by setting default port
    const colonIndex = ftpUrl.lastIndexOf(':');
    const slashIndex = ftpUrl.indexOf('/', 6);
    if (colonIndex > 6 && (slashIndex === -1 || colonIndex < slashIndex)) {
      const beforeColon = ftpUrl.substring(0, colonIndex);
      const afterColon = ftpUrl.substring(colonIndex + 1);
      const slashInAfter = afterColon.indexOf('/');
      const portPart = slashInAfter >= 0 ? afterColon.substring(0, slashInAfter) : afterColon;
      const pathPart = slashInAfter >= 0 ? afterColon.substring(slashInAfter) : '';
      if (!/^\d+$/.test(portPart)) {
        ftpUrl = beforeColon + ':2121' + pathPart;
        url = new URL(ftpUrl);
      } else {
        throw new Error('Invalid FTP URL: ' + ftpUrl);
      }
    } else {
      throw new Error('Invalid FTP URL: ' + ftpUrl);
    }
  }
  const host = url.hostname;
  const port = url.port || '2121';
  const user = url.username || 'anonymous';
  const pass = url.password || '';
  let remotePath = url.pathname || '/';

  // Ensure remotePath ends with / for consistency
  if (!remotePath.endsWith('/')) remotePath += '/';

  // ftpConfig object reused by buildFtpManifest — merge caller settings for passive/buffer/parallel
  const ftpConfig = { host, port, user, pass,
    passive: callerFtpCfg?.passive,
    bufferSize: callerFtpCfg?.bufferSize,
    parallel: callerFtpCfg?.parallel,
    speedLimitKbps: callerFtpCfg?.speedLimitKbps,
  };

  console.log('ftpUrl:', ftpUrl, 'url.port:', url.port, 'final port:', port);
  console.log('[FTP] Connecting to:', { host, port, user, pass: pass ? '***' : 'none' });
  const client = new ftp.Client();
  client.ftp.verbose = false;
  applyFtpPassive(client, ftpConfig);
  try {
    await client.access({ host, port: parseInt(port), user, password: pass, secure: false });
    console.log('[FTP] Connected successfully');
    // sizeCache intentionally NOT cleared — in-memory cache survives repeat scans within a session.
    // Disk cache is validated per-game with a single LIST, so stale data can't persist silently.
    const items = [];
    console.log('[FTP] Starting recursive scan from:', remotePath);

    // accessOpts is passed to scanFtpRecursive so downloadToBuffer can open
    // its own dedicated connection rather than sharing the scan client.
    const accessOpts = {
      host, port: parseInt(port), user, password: pass, secure: false,
      passive: callerFtpCfg?.passive,
    };

    // onGameFound: fires for each game the instant it's discovered.
    // Sends a game-found IPC event so the table row appears immediately
    // — the user sees games appearing one by one, not all at once after sizing.
    const onGameFound = (item) => {
      try {
        sender?.send('scan-progress', {
          type: 'game-found',
          item,
          index: items.length,
          total: items.length,
        });
      } catch (_) {}
    };

    // Only auto-scan predefined candidates when the user gave no specific path.
    // A path like /mnt/usb0/etaHEN/games/ should be scanned directly, not replaced by the
    // candidate list (which would scan extra paths and create duplicates).
    if (remotePath === '/' || remotePath === '//' || remotePath === '') {
      // Scan root-level PS5 mount points only.
      // scanFtpRecursive will recursively descend into etaHEN/games, games/, etc.
      // DO NOT include both a root AND its subdirectory (e.g. /mnt/usb0 AND
      // /mnt/usb0/etaHEN/games) — that causes the same folders to be scanned twice,
      // flooding the PS5's FTP connection limit and producing duplicate results.
      //
      // We scan:
      //   USB mounts  — /mnt/usb0 … /mnt/usb7
      //   Ext storage — /mnt/ext0, /mnt/ext1
      //   Internal    — /mnt/int0 (some firmwares), /data (ftpsrv/etaHEN root)
      //   Data subdirs — /data/games, /data/etaHEN/games (many payloads put games here)
      const candidates = [
        // USB drives (PS5 supports up to 8 USB ports including hubs)
        '/mnt/usb0',
        '/mnt/usb1',
        '/mnt/usb2',
        '/mnt/usb3',
        '/mnt/usb4',
        '/mnt/usb5',
        '/mnt/usb6',
        '/mnt/usb7',
        // Extended / external storage (M.2 SSD or USB-C SSD)
        '/mnt/ext0',
        '/mnt/ext1',
        // Internal storage (some payload versions expose this as int0)
        '/mnt/int0',
        // /data — ftpsrv and etaHEN root; also contains etaHEN/games on many setups.
        // Scan the root so recursive descent finds games at any layout depth.
        '/data',
      ];
      console.log('[FTP] Scanning', candidates.length, 'PS5 mount points');
      const seenFtpPaths = new Set(); // shared across all candidate scans to prevent duplicates
      // Shared semaphore limits all dlClient connections across ALL candidate scans to
      // MAX_FTP_SCAN_DL_CONNECTIONS at a time — prevents PS5 FTP daemon overload.
      const scanSemaphore = makeConcurrencyLimiter(MAX_FTP_SCAN_DL_CONNECTIONS);
      for (const cand of candidates) {
        try {
          console.log('[FTP] Checking:', cand);
          await scanFtpRecursive(client, cand, items, 0, onGameFound, accessOpts, seenFtpPaths, scanSemaphore);
          await new Promise(r => setTimeout(r, 120)); // let PS5 daemon release state between mounts
        } catch (e) {
          // 550 = path doesn't exist on this PS5 — completely normal to skip
          const code = (e?.message || '').match(/^(\d{3})/)?.[1];
          if (code === '550') {
            console.log('[FTP] Not present:', cand);
          } else {
            console.log('[FTP] Skipping:', cand, '-', e.message);
          }
        }
      }
    } else {
      // Specific path requested — cd into it before scanning.
      // Wrap both cd attempts so a 550 "No such file" doesn't propagate to the
      // outer catch and abort the entire scan.
      let cdOk = false;
      try {
        await client.cd(remotePath);
        cdOk = true;
      } catch (_) {
        try {
          await client.cd('"' + remotePath + '"');
          cdOk = true;
        } catch (e) {
          console.warn('[FTP] Cannot cd to:', remotePath, e.message);
        }
      }
      if (cdOk) {
        const specificSemaphore = makeConcurrencyLimiter(MAX_FTP_SCAN_DL_CONNECTIONS);
        await scanFtpRecursive(client, remotePath, items, 0, onGameFound, accessOpts, null, specificSemaphore);
      }
    }

    console.log('[FTP] Scan complete, found items:', items.length);

    // ── Close scan connection BEFORE sizing ───────────────────────────────────
    // The scan client must be closed now — PS5's FTP daemon allows very few
    // simultaneous connections (typically 2–4). Keeping it open while sizing
    // means ftpGetFolderSize() is competing for a slot that's already taken,
    // causing its connect() to hang or get refused.
    try { client.close(); } catch (_) {}

    // ── FTP size calculation ───────────────────────────────────────────────────
    // Uses buildFtpManifest(sizeOnly=true) per game — same parallel worker pool
    // as downloads. Each game gets SIZE_WALK_WORKERS (3) connections that share
    // a dir queue. Games are processed sequentially so total open connections =
    // SIZE_WALK_WORKERS at a time — well within PS5 FTP daemon's limit.
    // Cache hits return instantly. On failure we retry once before giving up.
    if (calcSize && items.length > 0) {
      console.log('[FTP] Sizing', items.length, 'games (parallel workers per game)');
      let doneCount = 0;
      for (const item of items) {
        const gamePath = item.ppsaFolderPath || item.folderPath;
        if (!gamePath) { ++doneCount; continue; }
        let sized = false;
        for (let attempt = 1; attempt <= 3 && !sized; attempt++) {
          try {
            const result = await buildFtpManifest(ftpConfig, gamePath, null, null, SIZE_WALK_WORKERS, true);
            if (typeof result.totalSize === 'number' && result.totalSize >= 0) {
              item.totalSize = result.totalSize;
              sized = true;
            }
          } catch (e) {
            console.warn(`[FTP Size] attempt ${attempt}/3 failed for ${gamePath}:`, e.message);
            if (attempt < 3) await new Promise(r => setTimeout(r, 500 * attempt));
          }
        }
        if (!sized) {
          console.error('[FTP Size] all attempts failed for', gamePath, '— will not emit size-update so spinner persists');
          // Do NOT emit size-update — keeps the spinner so the user knows it's unresolved
          ++doneCount;
          continue;
        }
        sender?.send('scan-progress', {
          type: 'size-update', contentId: item.contentId, folderPath: gamePath,
          totalSize: item.totalSize, done: ++doneCount, total: items.length
        });
      }
      console.log('[FTP] Sizing complete for', doneCount, 'games');
    }

    return items;
  } catch (e) {
    console.error('[FTP] Connection or scan error:', e);
    throw e;
  } finally {
    // Already closed above before sizing; this is a safety net if we threw early
    try { client.close(); } catch (_) {}
  }
}


// ── Single-game size calculator ───────────────────────────────────────────────
// Uses a Worker thread to do the entire directory walk synchronously.
// Sync I/O in a worker thread bypasses the AV per-file async hook that causes
// 100k-file games to hang for 20+ minutes when using fs.promises.stat().
// The worker does readdirSync + statSync in a tight loop — pure CPU/disk,
// no async queue, no libuv, no AV intercept delay.

const { Worker } = require('worker_threads');

const PER_GAME_WORKERS = 32;

// Worker code — accepts { dirs: [...] } (parallel chunk) or { folderPath } (fallback).
const SIZE_WORKER_CODE = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

// Extended-length path for Windows to handle paths > 260 chars (OneDrive, Dropbox)
function ext(p) {
  if (process.platform !== 'win32' || !p || p.length <= 248) return p;
  const n = p.replace(/\//g, '\\\\');
  if (/^[A-Za-z]:\\\\/.test(n)) return '\\\\\\\\?\\\\' + n;
  if (n.startsWith('\\\\\\\\')) return '\\\\\\\\?\\\\UNC\\\\' + n.slice(2);
  return p;
}

function sizeDirs(roots) {
  let total = 0;
  const stack = Array.isArray(roots) ? [...roots] : [roots];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(ext(dir), { withFileTypes: true }); }
    catch (_) { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isFile()) {
        try { total += Number(fs.statSync(ext(full)).size) || 0; } catch (_) {}
      } else if ((ent.isDirectory() || ent.isSymbolicLink()) && !ent.name.startsWith('.')) {
        stack.push(full);
      }
    }
  }
  return total;
}

try {
  const { folderPath, dirs } = workerData;
  parentPort.postMessage({ size: sizeDirs(dirs || folderPath) });
} catch (e) {
  parentPort.postMessage({ size: 0, error: e.message });
}
`;

// Split a game's subdirs across up to 8 worker threads for ~8x speed on large games.
const MAX_SPLIT_WORKERS = 8;

function spawnSizeWorker(workerData, sig) {
  return new Promise(resolve => {
    const w = new Worker(SIZE_WORKER_CODE, { eval: true, workerData });
    let done = false;
    const finish = sz => { if (!done) { done = true; resolve(typeof sz === 'number' ? sz : 0); } };
    w.on('message', ({ size, error }) => {
      if (error) console.warn('[SizeWorker] error in worker:', error);
      finish(size);
    });
    w.on('error', e => { console.warn('[SizeWorker] worker error:', e.message); finish(0); });
    w.on('exit',  c => { if (c !== 0) console.warn('[SizeWorker] worker exited with code', c); finish(0); });
    if (sig) sig.addEventListener('abort', () => { if (!done) { w.terminate(); finish(0); } }, { once: true });
  });
}

async function calcSingleGameSize(item, sig) {
  const folderPath = item.folderPath;
  if (!folderPath) return 0;
  if (sig?.aborted) return 0;

  let rootEntries;
  try { rootEntries = fs.readdirSync(folderPath, { withFileTypes: true }); }
  catch (e) {
    console.warn('[SizeCalc] Cannot read folder:', folderPath, e.message);
    return 0;
  }

  let rootFileSize = 0;
  const subdirs = [];
  for (const ent of rootEntries) {
    if (sig?.aborted) return 0;
    if (ent.isFile()) {
      try { rootFileSize += fs.statSync(path.join(folderPath, ent.name)).size; } catch (_) {}
    } else if ((ent.isDirectory() || ent.isSymbolicLink()) && !ent.name.startsWith('.')) {
      subdirs.push(path.join(folderPath, ent.name));
    }
  }

  if (sig?.aborted) return 0;
  if (!subdirs.length) return rootFileSize;

  // Distribute subdirs across workers round-robin
  const nWorkers = Math.min(subdirs.length, MAX_SPLIT_WORKERS);
  const chunks   = Array.from({ length: nWorkers }, () => []);
  subdirs.forEach((d, i) => chunks[i % nWorkers].push(d));

  const sizes = await Promise.all(chunks.map(dirs => spawnSizeWorker({ dirs }, sig)));

  // If aborted, workers may have returned 0 — don't use this result
  if (sig?.aborted) return 0;

  const total = rootFileSize + sizes.reduce((a, b) => a + b, 0);

  // Sanity: if total is unreasonably small for a folder with subdirs, log a warning
  // (helps surface issues in the console without crashing)
  if (total < 1024 * 1024 && subdirs.length > 0 && !sig?.aborted) {
    console.warn('[SizeCalc] Suspiciously small size for', folderPath,
      '(' + total + ' bytes, ' + subdirs.length + ' subdirs) — retrying with single worker');
    const retry = await spawnSizeWorker({ dirs: [folderPath] }, sig);
    if (!sig?.aborted && retry > total) {
      console.log('[SizeCalc] Retry got', retry, 'for', folderPath);
      return retry;
    }
  } else if (total === 0 && !sig?.aborted) {
    console.warn('[SizeCalc] Got 0 for', folderPath, '— retrying with single worker');
    const retry = await spawnSizeWorker({ dirs: [folderPath] }, sig);
    if (!sig?.aborted) return retry;
  }

  return total;
}


// ── Game size calculator ──────────────────────────────────────────────────────
// On Windows: PowerShell handles all games — no timeout/fast/slow split needed
// because a single shell call completes in seconds regardless of file count.
// On non-Windows: fast/slow pass with 5s timeout for large games.
const FAST_TIMEOUT_MS  = 90000; // 90s: large PS5 games (60GB+) on slow USB HDDs need time
const FAST_CONCURRENCY = 8;    // 8 games × 8 workers = 64 threads, within UV_THREADPOOL_SIZE=128

async function calcAllGameSizes(gameItems, sig, onGameDone) {
  if (!gameItems.length) return;

  // ── Cache pass — instant results for already-measured games ──────────────
  const uncached = [];
  for (const item of gameItems) {
    const raw = item.folderPath ? localSizeCache.get(item.folderPath) : undefined;
    // Cache entries may be plain numbers (legacy) or { size, mtimeMs } objects
    const cached = typeof raw === 'number' ? raw : (raw?.size ?? undefined);
    if (cached !== undefined && cached > 0) {
      item.totalSize = cached;
      try { onGameDone(item); } catch (_) {}
    } else {
      uncached.push(item);
    }
  }
  if (!uncached.length) return;

  // Worker thread sizing: fast/slow pass so small games appear immediately
  const deferred = [];
  const fastLimit = makeConcurrencyLimiter(FAST_CONCURRENCY);

  await Promise.all(uncached.map(item =>
    fastLimit(async () => {
      if (sig?.aborted) return;
      const fastCtrl = new AbortController();
      const fastSig  = sig ? combineAbortSignals(sig, fastCtrl.signal) : fastCtrl.signal;
      let timedOut   = false;

      const sizePromise = calcSingleGameSize(item, fastSig).then(sz => {
        // Guard 1: timed out — result came from aborted workers (partial/0), don't cache.
        // Guard 2: outer signal aborted (new scan started) — combineAbortSignals fired,
        //   workers terminated early, result is partial. Caching it would poison all
        //   subsequent scans with tiny (e.g. sce_sys-only) values for up to 30 days.
        const outerAborted = sig?.aborted;
        if (!timedOut && !outerAborted) {
          item.totalSize = sz;
          if (item.folderPath && sz > 0) {
            // Store size with current folder mtime so future scans can detect changes
            try {
              const st = fs.statSync(item.folderPath);
              localSizeCache.set(item.folderPath, { size: sz, mtimeMs: st.mtimeMs });
            } catch (_) {
              localSizeCache.set(item.folderPath, sz); // fallback: store plain number
            }
          }
          try { onGameDone(item); } catch (_) {}
        }
        return sz;
      });

      const result = await Promise.race([
        sizePromise,
        new Promise(r => setTimeout(() => { timedOut = true; fastCtrl.abort(); r('timeout'); }, FAST_TIMEOUT_MS))
      ]);

      if (result === 'timeout') {
        deferred.push(item);
      }
    })
  ));

  if (!deferred.length) return;

  // Slow pass — no timeout, always completes. Workers use null signal so they run fully.
  // Still guard outer sig before caching: if a new scan started while slow pass was
  // waiting in fastLimit queue, the result is valid but no one is listening anymore.
  await Promise.all(deferred.map(item =>
    fastLimit(async () => {
      if (sig?.aborted) return; // new scan started — skip entirely, don't cache
      const sz = await calcSingleGameSize(item, null); // null = no worker abort
      if (sig?.aborted) return; // aborted while worker was running — don't cache partial
      item.totalSize = sz;
      if (item.folderPath && sz > 0) {
        try {
          const st = fs.statSync(item.folderPath);
          localSizeCache.set(item.folderPath, { size: sz, mtimeMs: st.mtimeMs });
        } catch (_) {
          localSizeCache.set(item.folderPath, sz);
        }
        scheduleLocalSizeCacheSave();
      }
      try { onGameDone(item); } catch (_) {}
    })
  ));
}


function combineAbortSignals(a, b) {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctrl = new AbortController();
  const done = () => ctrl.abort();
  a.addEventListener('abort', done, { once: true });
  b.addEventListener('abort', done, { once: true });
  return ctrl.signal;
}
// ── Main local scan ──────────────────────────────────────────────────────────
// Three-phase pipeline:
//
//   Phase 1 — DIR WALK   (128-worker DFS pool)
//     Discovers all param.json files across the entire source tree.
//
//   Phase 2 — PARAM PARSE   (48-worker pool, streams game-found events)
//     Reads & parses each param.json concurrently.  Results stream to the UI
//     table as each worker completes.
//
//   Phase 3 — SIZE CALC   (8 games × 8 workers = 64 threads)
//     Starts AFTER scan-source returns all items to the renderer.  A 300ms
//     delay lets renderResults build the fully-sorted, deduplicated table
//     before any size-update events arrive — no race with spinner rows.
//
// Timeline:  [--- walk ---]
//                [--- parse (streams game-found) ---]
//                                                    [return to renderer → renderResults]
//                                                         [300ms] [--- size calc ---]
//
async function findContentFoldersByTopLevelWithProgress(startDir, sender, externalSig = null) {
  let sig, controller = null;
  if (externalSig) {
    // Caller (e.g. all-drives) manages the AbortController — don't overwrite the cancel flag
    sig = externalSig;
  } else {
    controller = new AbortController();
    activeCancelFlags.set(sender.id, () => controller.abort());
    sig = controller.signal;
  }

  const PARSE_CONCURRENCY = 48;
  const seen       = new Set();
  const seenLock   = new Set();
  const rawResults = [];
  let   doneCount  = 0;

  // ── parse queue shared between Phase 1 (producer) and Phase 2 (consumers) ─
  const parseQueue    = [];          // param.json paths waiting to be processed
  let   walkDone      = false;       // Phase 1 finished
  let   parseWaiters  = [];          // resolve() calls for workers blocked on empty queue
  let   totalFound    = 0;           // total param.json found (for progress %)

  function enqueueParam(fp) {
    totalFound++;
    parseQueue.push(fp);
    if (parseWaiters.length) { const r = parseWaiters.shift(); r(); }
  }

  async function nextParam() {
    while (true) {
      if (sig.aborted) return null;
      if (parseQueue.length) return parseQueue.shift();
      if (walkDone) return null; // walk finished and queue empty — done
      await new Promise(r => parseWaiters.push(r));
    }
  }

  async function processOne(paramPath) {
    if (sig.aborted) return;
    const paramDir = path.dirname(paramPath);
    const parsed   = await readJsonSafe(paramPath);
    if (!parsed) return;

    // Resolve game folder by walking UP from paramDir looking for sce_sys ancestor.
    // Standard layout:  PPSA12345/sce_sys/param.json  → game = PPSA12345
    // Non-standard:     PPSA12345/param.json           → game = PPSA12345
    //                   PPSA12345/sub/param.json        → game = PPSA12345
    // We NEVER silently drop a param.json — at worst we use the immediate parent
    // of the file as the game folder so everything with a valid contentId gets listed.
    let folderPath;
    if (path.basename(paramDir).toLowerCase() === 'sce_sys') {
      folderPath = path.dirname(paramDir);
    } else {
      let cur = paramDir, found = false;
      for (let lvl = 0; lvl < 8 && cur !== path.dirname(cur); lvl++) {
        if (path.basename(cur).toLowerCase() === 'sce_sys') {
          folderPath = path.dirname(cur); found = true; break;
        }
        cur = path.dirname(cur);
      }
      if (!found) {
        // Fallback: use the directory containing param.json as the game folder.
        // Covers non-standard layouts while still giving us a valid folder to size/copy.
        console.warn(`[Scan] param.json not inside sce_sys — using parent dir as game root: ${paramPath}`);
        folderPath = paramDir;
      }
    }

    const normalizedFolder = path.resolve(folderPath);
    // seenKey is purely path-based: every unique folder path is a unique game entry.
    // We intentionally do NOT deduplicate by PPSA/contentId here — the renderer will
    // collapse true duplicates (same exact path) while showing the same game at
    // multiple locations (e.g. D:\ and C:\Users\Downloads) as separate entries.
    const seenKey = normalizedFolder;
    if (seen.has(seenKey) || seenLock.has(seenKey)) return;
    seenLock.add(seenKey);

    try {
    const ppsaFromCid = extractPpsaKey(parsed.contentId) || extractPpsaKey(JSON.stringify(parsed));

    // Fast icon check — one stat, no deep search if found immediately
    let iconPath = null;
    const primaryIcon = path.join(folderPath, 'sce_sys', 'icon0.png');
    try {
      await fs.promises.access(primaryIcon, fs.constants.F_OK);
      iconPath = primaryIcon;
    } catch (_) {
      iconPath = await findAnyIconNearby(folderPath, 2).catch(() => null);
    }

    const rec = {
      ppsa:              ppsaFromCid || null,
      ppsaFolderPath:    folderPath,
      contentFolderPath: paramDir,
      folderPath,
      folderName:        path.basename(folderPath),
      paramPath,
      contentId:         parsed.contentId || null,
      skuFromParam:      null,
      iconPath,
      dbPresent:         false,
      dbTitle:           null,
      displayTitle:      getTitleFromParam(parsed, null) || parsed.titleName || null,
      region:            parsed.defaultLanguage || parsed.localizedParameters?.defaultLanguage || '',
      verified:          false,
      contentVersion:    parsed.contentVersion || null,
      sdkVersion:        parsed.sdkVersion     || null,
      totalSize:         null,
      titleId:           parsed.titleId,
      version:           parsed.masterVersion,
      fwSku:             parsed.requiredSystemSoftwareVersion,
    };

    seen.add(seenKey);
    rawResults.push(rec);
    doneCount++;

    // Stream the full game record immediately — renderer appends a row without waiting
    try {
      sender?.send('scan-progress', {
        type: 'game-found',
        item: rec,
        index: doneCount,
        total: Math.max(totalFound, doneCount),
      });
    } catch (_) {}

    } catch (e) {
      // On any error, remove from seenLock so a re-scan can retry this game.
      // Leave seenKey absent from `seen` so it's not treated as successfully processed.
      seenLock.delete(seenKey);
      throw e; // re-throw so parseWorker can log it
    }
  }

  // ── Phase 2 workers — start immediately, block on empty queue ────────────
  async function parseWorker() {
    while (true) {
      const fp = await nextParam();
      if (fp === null) break;
      await processOne(fp).catch(e => {
        console.warn('[Scan] processOne error:', e?.message || e);
      });
    }
  }
  const parseWorkerPromises = Array.from({ length: PARSE_CONCURRENCY }, parseWorker);

  // ── Phase 1: walk (runs concurrently with Phase 2) ────────────────────────
  sender?.send('scan-progress', { type: 'scan', folder: startDir, index: 0, total: 0 });
  await findAllParamJsons(startDir, MAX_SCAN_DEPTH, sig, enqueueParam);
  walkDone = true;
  // Wake any workers still waiting on an empty queue
  parseWaiters.forEach(r => r());

  // ── Wait for Phase 2 to drain ─────────────────────────────────────────────
  await Promise.all(parseWorkerPromises);
  console.log(`[Scan] Walk+Parse complete: ${rawResults.length} games from ${totalFound} param.json files`);

  if (controller) activeCancelFlags.delete(sender.id);
  return rawResults; // scan-source handler starts Phase 3 via startLocalSizingPhase
}

// Add FTP download function — uses parallel manifest for accurate size & fast walk
function applyFtpPassive(client, ftpConfig) {
  // basic-ftp defaults to passive=true. Only override if explicitly disabled.
  if (ftpConfig && ftpConfig.passive === false) {
    client.ftp.passive = false;
  }
}

/**
 * Downloads an entire remote FTP folder to a local directory.
 * Builds a file manifest in parallel, then downloads files sequentially
 * with live progress reporting.
 * @param {object} ftpConfig - FTP connection config (host, port, user, pass, etc.).
 * @param {string} remotePath - Remote FTP path to download.
 * @param {string} localPath - Local directory to download files into.
 * @param {Function} progressCallback - Called with progress update objects.
 * @param {Function} cancelCheck - Returns true if the operation should be cancelled.
 * @returns {Promise<void>}
 */
async function downloadFtpFolder(ftpConfig, remotePath, localPath, progressCallback, cancelCheck) {
  // Build the manifest in parallel first — this replaces the serial getFtpFolderSize walk
  // AND the recursive walk during actual download (two traversals → one).
  progressCallback?.({ type: 'go-file-progress', totalBytesCopied: 0, totalBytes: 0 }); // Show activity immediately

  let manifest;
  try {
    manifest = await buildFtpManifest(ftpConfig, remotePath, (info) => {
      // Forward manifest progress so UI shows "counting files..." state
      progressCallback?.({ type: 'ftp-manifest-progress', ...info });
    }, cancelCheck, ftpConfig.parallel || 4);
  } catch (e) {
    console.error('[FTP] Manifest build failed, falling back to serial download:', e.message);
    // Graceful fallback: open a new client and do it the old serial way
    const fallbackClient = new ftp.Client();
    try {
      applyFtpPassive(fallbackClient, ftpConfig);
      await fallbackClient.access({ host: ftpConfig.host, port: parseInt(ftpConfig.port, 10), user: ftpConfig.user || 'anonymous', password: ftpConfig.pass || '', secure: false });
      // downloadFtpRecursive is not available — surface the original error
      console.error('[FTP] Manifest failed and no serial fallback available:', e.message);
      throw e;
    } finally {
      fallbackClient.close();
    }
    return;
  }

  const { files, totalSize } = manifest;
  console.log(`[FTP] Manifest ready: ${files.length} files, ${totalSize} bytes across ${manifest.dirCount} dirs`);

  if (cancelCheck?.()) throw new Error('Cancelled');

  // Download using a single connection sequentially — PS5 doesn't handle parallel uploads/downloads well
  const client = new ftp.Client();
  applyFtpPassive(client, ftpConfig);
  try {
    await client.access({ host: ftpConfig.host, port: parseInt(ftpConfig.port, 10), user: ftpConfig.user || 'anonymous', password: ftpConfig.pass || '', secure: false });
    let bytesCopied = 0;

    // Hook real-time per-file progress from basic-ftp's transfer tracker.
    // Fires every ~500ms with bytes transferred so far for the current file.
    client.trackProgress(info => {
      if (cancelCheck?.()) return;
      const fileCumulative = bytesCopied + (info.bytes || 0);
      progressCallback?.({ type: 'go-file-progress', fileRel: info.name || '', totalBytesCopied: Math.min(fileCumulative, totalSize), totalBytes: totalSize });
    });

    for (const fileEntry of files) {
      if (cancelCheck?.()) throw new Error('Cancelled');
      const localDest = path.join(localPath, ...fileEntry.relPath.split('/'));
      await fs.promises.mkdir(toExtendedPath(path.dirname(localDest)), { recursive: true });

      // Retry up to 3 times on transient FTP errors — also auto-reconnects on disconnect
      let downloaded = false;
      for (let attempt = 1; attempt <= 5 && !downloaded; attempt++) {
        try {
          await client.downloadTo(localDest, fileEntry.remotePath);
          downloaded = true;
        } catch (e) {
          if (cancelCheck?.()) throw new Error('Cancelled');
          const isDisconnect = /connection|closed|reset|ECONNRESET|ENOTCONN|FIN/i.test(e.message || '');
          if (attempt >= 5) {
            console.warn('[FTP] Download failed after 5 attempts for', fileEntry.remotePath, ':', e.message);
          } else {
            const delay = isDisconnect ? 1500 : 500;
            console.warn(`[FTP] Download attempt ${attempt} failed for`, fileEntry.remotePath, '— retrying in', delay + 'ms:', e.message);
            await new Promise(r => setTimeout(r, delay));
            // On disconnect, re-establish the connection transparently
            if (isDisconnect) {
              try { client.close(); } catch (_) {}
              await client.access({ host: ftpConfig.host, port: parseInt(ftpConfig.port, 10), user: ftpConfig.user || 'anonymous', password: ftpConfig.pass || '', secure: false });
              client.trackProgress(info => {
                if (cancelCheck?.()) return;
                const fileCumulative = bytesCopied + (info.bytes || 0);
                progressCallback?.({ type: 'go-file-progress', fileRel: info.name || '', totalBytesCopied: Math.min(fileCumulative, totalSize), totalBytes: totalSize });
              });
            }
          }
        }
      }
      if (!downloaded) {
        throw new Error(`FTP download failed for file: ${path.basename(fileEntry.remotePath)} after 3 attempts`);
      }
      bytesCopied += fileEntry.size;
      progressCallback?.({ type: 'go-file-progress', fileRel: path.basename(fileEntry.remotePath), totalBytesCopied: bytesCopied, totalBytes: totalSize });
    }

    client.trackProgress(); // Stop tracking
    // Final complete event
    progressCallback?.({ type: 'go-file-complete', fileRel: path.basename(remotePath), totalBytesCopied: bytesCopied, totalBytes: totalSize });
  } finally {
    client.close();
  }
}

// ── Throttled stream for speed-limited FTP uploads ───────────────────────────
class ThrottledStream extends Transform {
  constructor(speedBytesPerSec) {
    super();
    this._limit = speedBytesPerSec;
    this._startTime = Date.now();
    this._bytesSent = 0;
    this._pendingTimer = null;
  }
  _transform(chunk, encoding, callback) {
    this._bytesSent += chunk.length;
    const elapsedMs = Date.now() - this._startTime;
    const expectedMs = (this._bytesSent / this._limit) * 1000;
    const delayMs = Math.max(0, expectedMs - elapsedMs);
    if (delayMs > 0) {
      this._pendingTimer = setTimeout(() => {
        this._pendingTimer = null;
        this.push(chunk);
        callback();
      }, delayMs);
    } else {
      this.push(chunk);
      callback();
    }
  }
  _flush(callback) { callback(); }
  _destroy(err, callback) {
    if (this._pendingTimer) { clearTimeout(this._pendingTimer); this._pendingTimer = null; }
    callback(err);
  }
}

// Add FTP upload function
/**
 * Uploads a local directory tree to a remote FTP path.
 * Enumerates all files with stats, then uploads them with optional speed limiting
 * and parallel connection support.
 * @param {object} ftpConfig - FTP connection config (host, port, user, pass, etc.).
 * @param {string} localPath - Local directory to upload.
 * @param {string} remotePath - Destination remote FTP path.
 * @param {Function} progressCallback - Called with progress update objects.
 * @param {Function} cancelCheck - Returns true if the operation should be cancelled.
 * @returns {Promise<void>}
 */
async function uploadFtpFolder(ftpConfig, localPath, remotePath, progressCallback, cancelCheck) {
  const client = new ftp.Client(120000); // 2 min idle timeout — PS5 FTP can be slow on large files
  client.ftp.verbose = false;
  // Apply passive mode
  if (ftpConfig.passive === false) client.ftp.passive = false;
  // Increase socket send/receive buffers for throughput (basic-ftp exposes socket after connect)
  const bufBytes = ftpConfig.bufferSize || (ftpConfig.bufferSizeKb || 64) * 1024;
  try {
    await client.access({ host: ftpConfig.host, port: parseInt(ftpConfig.port), user: ftpConfig.user || 'anonymous', password: ftpConfig.pass || '', secure: false });
    // Set socket buffer sizes immediately after connect for maximum throughput
    if (client.ftp.socket) {
      client.ftp.socket.setNoDelay(true);
      try { client.ftp.socket.setRecvBufferSize?.(bufBytes * 4); } catch (_) {}
      try { client.ftp.socket.setSendBufferSize?.(bufBytes * 4); } catch (_) {}
    }
    let totalSize = 0;
    try {
      const files = await listAllFilesWithStats(localPath);
      totalSize = files.reduce((sum, f) => sum + f.size, 0);
    } catch (e) {
      console.error('[FTP] Size calc failed:', e);
    }

    // Send raw info.bytes — progressFn accumulates totals via go-file-complete.
    // A local accumulator here would double-count every file (progress bar jumps/stalls).
    client.trackProgress(info => {
      if (cancelCheck()) return;
      progressCallback?.({ type: 'go-file-progress', fileRel: info.name || '', totalBytesCopied: info.bytes || 0, totalBytes: totalSize });
    });

    const speedLimitBps = ftpConfig.speedLimitKbps > 0 ? ftpConfig.speedLimitKbps * 1024 : 0;
    // Build access config once so uploadFtpRecursive can reconnect on disconnect
    const _accessConfig = {
      host: ftpConfig.host,
      port: parseInt(ftpConfig.port),
      user: ftpConfig.user || 'anonymous',
      password: ftpConfig.pass || '',
      secure: false,
    };
    await uploadFtpRecursive(client, localPath, remotePath, (info) => {
      progressCallback?.(info);
    }, cancelCheck, totalSize, speedLimitBps, bufBytes, _accessConfig);

    client.trackProgress();
  } finally {
    client.close();
  }
}

// PS5-compatible directory creation.
// basic-ftp's client.ensureDir() uses MKD + CWD in a way that PS5's etaHEN/goldhen FTP
// server rejects — it returns 550 even when the directory already exists, causing ensureDir
// to throw and abort the upload. This function creates each segment individually, tolerating
// 550/521 "already exists" errors, and never clobbers an existing directory.
async function ftpEnsureDir(client, remotePath) {
  // Normalize: must start with /
  const normalised = ('/' + remotePath.replace(/^\/+/, '')).replace(/\/\/+/g, '/');
  const segments   = normalised.split('/').filter(Boolean); // ['etaHEN', 'games', 'Among Us']

  let current = '';
  for (const seg of segments) {
    current = current + '/' + seg;
    try {
      await client.send('MKD ' + current);
    } catch (e) {
      // 550 = already exists (or permission denied on an existing dir) — both are fine to ignore.
      // 521 = directory already exists (some servers).
      const code = e?.code || (e?.message?.match(/^(\d{3})/)?.[1] | 0);
      if (code !== 550 && code !== 521) {
        // Non-550 error — verify the dir is reachable via LIST.
        // We don't use CWD because it changes the connection's working directory
        // which can affect subsequent uploadFrom calls on the same connection.
        try { await client.list(current); }
        catch (_) {
          throw new Error(`FTP upload failed: cannot create or access ${current} — check PS5 FTP write permissions.`);
        }
      }
    }
  }
  // Leave the client's working directory unchanged (don't CWD into the target)
}

async function uploadFtpRecursive(client, localPath, remotePath, progressCallback, cancelCheck, totalSize = 0, speedLimitBps = 0, bufBytes = 65536, accessConfig = null) {
  if (cancelCheck()) throw new Error('Cancelled');
  await ftpEnsureDir(client, remotePath);
  const entries = await fs.promises.readdir(localPath, { withFileTypes: true });
  for (const ent of entries) {
    if (cancelCheck()) throw new Error('Cancelled');
    const localItem  = path.join(localPath, ent.name);
    const remoteItem = path.posix.join(remotePath, ent.name);
    if (ent.isFile()) {
      let uploaded = false;
      let lastErr = null;
      for (let attempt = 1; attempt <= 5 && !uploaded; attempt++) {
        try {
          if (speedLimitBps > 0) {
            const rs = fs.createReadStream(localItem, { highWaterMark: bufBytes });
            const throttle = new ThrottledStream(speedLimitBps);
            // Forward stream errors so the transfer fails cleanly rather than hanging
            rs.on('error', (e) => throttle.destroy(e));
            rs.pipe(throttle);
            await client.uploadFrom(throttle, remoteItem);
          } else {
            await client.uploadFrom(localItem, remoteItem);
          }
          uploaded = true;
        } catch (e) {
          lastErr = e;
          if (cancelCheck()) throw new Error('Cancelled');
          const isDisconnect = /connection|closed|reset|ECONNRESET|ENOTCONN|FIN/i.test(e.message || '');
          if (attempt >= 5) {
            console.warn(`[FTP Upload] Failed after 5 attempts: ${ent.name}:`, e.message);
          } else {
            const delay = isDisconnect ? 1500 : 500 * attempt;
            console.warn(`[FTP Upload] Attempt ${attempt} failed for ${ent.name} — retrying in ${delay}ms:`, e.message);
            await new Promise(r => setTimeout(r, delay));
            // Auto-reconnect on disconnect using original access credentials
            if (isDisconnect && accessConfig) {
              try { client.close(); } catch (_) {}
              try {
                await client.access(accessConfig);
                // Re-track progress after reconnect
                client.trackProgress(info => {
                  if (cancelCheck()) return;
                  progressCallback?.({ type: 'go-file-progress', fileRel: info.name || '', totalBytesCopied: info.bytes || 0, totalBytes: totalSize });
                });
              } catch (reconnErr) {
                console.warn('[FTP Upload] Reconnect failed:', reconnErr.message);
              }
            }
          }
        }
      }
      if (!uploaded) throw new Error(`FTP upload failed for file: ${ent.name} — ${lastErr?.message || 'unknown error'}`);
      const size = (await fs.promises.stat(localItem).catch(() => ({ size: 0 }))).size || 0;
      progressCallback?.({ type: 'go-file-complete', fileRel: ent.name, totalBytesCopied: size, totalBytes: totalSize });
    } else if (ent.isDirectory()) {
      await uploadFtpRecursive(client, localItem, remoteItem, progressCallback, cancelCheck, totalSize, speedLimitBps, bufBytes, accessConfig);
    }
  }
}

// Add FTP delete recursive function
async function ftpDeleteRecursive(client, remotePath) {
  if (!remotePath || typeof remotePath !== 'string') return;

  // Normalise: always starts with '/', no trailing slash except root.
  const norm = ('/' + remotePath.replace(/^\/+/, '')).replace(/\/\/+/g, '/').replace(/\/$/, '') || '/';

  // Refuse to delete the root or anything fewer than 3 segments deep.
  // e.g. /data/etaHEN/games/GameTitle is fine; /data or / is not.
  const segments = norm.split('/').filter(Boolean);
  if (segments.length < 3) {
    console.error('[ftpDeleteRecursive] REFUSED — path too shallow:', norm);
    throw new Error('Refusing to delete shallow FTP path: ' + norm);
  }

  // Deny well-known PS5 system roots.
  const dangerousFtp = ['/', '/data', '/mnt', '/system', '/system_data',
    '/preinst', '/preinst2', '/update', '/dev', '/proc'];
  if (dangerousFtp.includes(norm)) {
    console.error('[ftpDeleteRecursive] REFUSED — protected FTP path:', norm);
    throw new Error('Refusing to delete protected FTP path: ' + norm);
  }

  try {
    await client.cd(norm);
  } catch (e) {
    return; // Already deleted or not exists
  }
  const list = await client.list();
  for (const item of list) {
    const itemPath = path.posix.join(norm, item.name);
    if (item.isDirectory) {
      await ftpDeleteRecursive(client, itemPath);
    } else {
      await client.remove(itemPath);
    }
  }
  await client.removeDir(norm);
}

// IPC (same as before, with minor improvements)
ipcMain.handle('open-directory', async () => {
  try {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (res.canceled) return { canceled: true, filePaths: [] };
    return { canceled: false, filePaths: res.filePaths };
  } catch (e) {
    return { canceled: true, filePaths: [], error: e.message };
  }
});

ipcMain.handle('cancel-operation', async (event) => {
  const cancel = activeCancelFlags.get(event.sender.id);
  if (cancel) cancel();
  activeCancelFlags.delete(event.sender.id);
  return { ok: true };
});

ipcMain.handle('scan-source', async (event, sourceDir, opts = {}) => {
  if (!sourceDir || typeof sourceDir !== 'string') return { error: 'Invalid source directory' };

  // ── Bump generation so any pending 300ms sizing timer from a prior scan exits early ──
  const scanId = ++currentScanId;

  // ── Helper: start Phase 3 (size calc) for local games ─────────────────────
  // Called via setTimeout(300) so the renderer has time to call renderResults
  // and build the full sorted table before size-update events start arriving.
  function startLocalSizingPhase(items, sender) {
    if (currentScanId !== scanId) return;   // superseded by a newer scan
    if (!items.length || sender.isDestroyed()) return;
    const sizingCtrl = new AbortController();
    activeSizingController = sizingCtrl;
    let sizeDone = 0;
    calcAllGameSizes(items, sizingCtrl.signal, (item) => {
      sizeDone++;
      try {
        if (!sender.isDestroyed()) {
          sender.send('scan-progress', {
            type: 'size-update',
            ppsa: item.ppsa, folderPath: item.folderPath, contentId: item.contentId,
            totalSize: item.totalSize,
            done: sizeDone, total: items.length,
          });
        }
      } catch (_) {}
    }).then(() => {
      console.log(`[Scan] Size calc complete: ${items.length} games`);
    }).catch(e => {
      console.warn('[Scan] Size calc error:', e?.message);
    }).finally(() => {
      if (activeSizingController === sizingCtrl) activeSizingController = null;
    });
  }

  try {
    // ── Always kill any in-flight size calculation first ──────────────────
    // sizing workers (up to 64 stat() calls/game) saturate the libuv I/O
    // thread pool.  If they're still running when getAllDrives() probes drive
    // letters, the access() calls time out and returns [].
    if (activeSizingController) {
      activeSizingController.abort();
      activeSizingController = null;
    }

    if (sourceDir === 'all-drives') {
      const drives = await getAllDrives();
      console.log('[Scan All Drives] Drives detected:', drives);

      // ── CRITICAL: Phase 2 across ALL drives before ANY Phase 3 sizing ────
      //
      // The problem with starting Phase 3 per-drive as each one finishes:
      //   D:\ Phase 2 finishes → D:\ Phase 3 starts (Astro Bot 100k files)
      //   → 256 workers flood all 64 libuv I/O threads with stat() calls
      //   → C:\ Phase 1 walk starves — NO I/O threads available
      //   → C:\ game-found events never fire until Astro Bot sizing completes
      //   → User sees only D:\ games for the entire duration of Astro Bot sizing
      //
      // Fix: pass calcSize=false to every per-drive scan so they only run
      // Phase 1 (walk) + Phase 2 (parse + stream game-found events).
      // ALL game-found events fire across ALL drives before a single stat() runs.
      // Then ONE shared Phase 3 fires across all games simultaneously.
      //
      // Strategy: C:\ scans first (sequential) so its games stream to the UI
      // before anything else.  All remaining drives then scan IN PARALLEL so a
      // slow secondary NVMe or USB drive cannot block faster drives from
      // completing.  No drive is ever aborted — every drive scans to completion
      // so no games are missed.  The per-directory 10s readdir timeout (in
      // readdirSafe) handles individual hung folders without killing the drive.
      const allItems = [];

      // Step 1: C:\ first — always, sequentially
      const cDrive = drives.find(d => d.toUpperCase().startsWith('C:'));
      const otherDrives = drives.filter(d => !d.toUpperCase().startsWith('C:'));

      // ── Cancel support for all-drives ──────────────────────────────────────
      // Each drive creates its own AbortController inside
      // findContentFoldersByTopLevelWithProgress when no externalSig is provided.
      // Without a fix, each call overwrites the same activeCancelFlags[sender.id]
      // entry, so Cancel only aborts the last-registered drive.
      //
      // Fix: create ONE composite controller here, register IT as the cancel target,
      // and pass its signal as externalSig to every drive scan.  A single Cancel click
      // then aborts ALL drives simultaneously.
      const compositeController = new AbortController();
      activeCancelFlags.set(event.sender.id, () => compositeController.abort());
      const compositeSig = compositeController.signal;

      if (cDrive) {
        try {
          const items = await findContentFoldersByTopLevelWithProgress(cDrive, event.sender, compositeSig);
          allItems.push(...items);
          console.log(`[Scan All Drives] ${cDrive} done: ${items.length} game(s)`);
        } catch (e) {
          console.warn(`[Scan All Drives] C: error:`, e.message);
        }
      }

      // Step 2: all remaining drives in parallel — fast drives complete quickly,
      // slow drives keep going in the background without blocking each other.
      if (otherDrives.length > 0 && !compositeSig.aborted) {
        const otherResults = await Promise.allSettled(
          otherDrives.map(drive =>
            findContentFoldersByTopLevelWithProgress(drive, event.sender, compositeSig)
              .then(items => {
                console.log(`[Scan All Drives] ${drive} done: ${items.length} game(s)`);
                return items;
              })
              .catch(e => {
                console.warn(`[Scan All Drives] ${drive} error:`, e.message);
                return [];
              })
          )
        );
        for (const r of otherResults) {
          if (r.status === 'fulfilled') allItems.push(...r.value);
        }
      }

      // ── ONE shared Phase 3: all games found — delay 300ms so renderResults
      // completes in the renderer before size-update events start arriving ──────
      if (opts.calcSize !== false && allItems.length > 0) {
        setTimeout(() => startLocalSizingPhase(allItems, event.sender), 300);
      }

      // Keep API library in sync
      apiLibrary = allItems;

      // ── CRITICAL: clean up activeCancelFlags after Phase 2 completes ──────
      // Leaving the composite controller registered means a Cancel click queued
      // during the FTP scan (or any stale IPC message) can arrive just as the
      // NEXT scan registers its new controller and accidentally abort IT —
      // causing the walk to see sig.aborted=true from the very first check
      // and return 0 games.  Phase 3 runs with its own sizingCtrl so no
      // cleanup of activeCancelFlags needed there.
      activeCancelFlags.delete(event.sender.id);

      return allItems;
    } else if (sourceDir.startsWith('ftp://')) {
      // Register a no-op cancel for FTP scans so clicking Cancel doesn't leave
      // activeCancelFlags empty, which would prevent it from being re-populated by
      // the next scan and cause a stale-cancel race on that scan instead.
      // FTP scans run to natural completion (basic-ftp has no abort API) — the
      // no-op simply lets Cancel be acknowledged without side effects.
      activeCancelFlags.set(event.sender.id, () => { /* FTP: no abort, runs to completion */ });
      let items;
      try {
        items = await scanFtpSource(sourceDir, {
          sender: event.sender,
          calcSize: opts.calcSize,
          ftpConfig: opts.ftpConfig || null,
        });
      } finally {
        activeCancelFlags.delete(event.sender.id);
      }
      if (Array.isArray(items)) apiLibrary = items;
      return items || [];
    } else if (/^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(sourceDir)) {
      activeCancelFlags.set(event.sender.id, () => { /* FTP: no abort, runs to completion */ });
      let items;
      try {
        items = await scanFtpSource('ftp://' + sourceDir, {
          sender: event.sender,
          calcSize: opts.calcSize,
          ftpConfig: opts.ftpConfig || null,
        });
      } finally {
        activeCancelFlags.delete(event.sender.id);
      }
      return items || [];
    } else {
      if (!path.isAbsolute(sourceDir)) return { error: 'Invalid source directory' };
      const stat = await fs.promises.stat(sourceDir);
      if (!stat.isDirectory()) return { error: 'Source is not a directory' };
      // Phase 1+2 only — all game-found events stream to renderer; sizing starts
      // 300ms later so renderResults builds the complete sorted table first.
      const items = await findContentFoldersByTopLevelWithProgress(sourceDir, event.sender);
      if (Array.isArray(items)) apiLibrary = items;
      if (items?.length) setTimeout(() => startLocalSizingPhase(items, event.sender), 300);
      return items || [];
    }
  } catch (e) {
    console.error('[main] scan-source error', e);
    return { error: String(e?.message || e) };
  }
});

async function doEnsureAndPopulate(event, opts) {
  if (!opts || typeof opts !== 'object') throw new Error('Invalid options');
  const items = Array.isArray(opts.items) ? opts.items : [];
  const dest = typeof opts.dest === 'string' ? opts.dest.trim() : null;
  const ftpConfig = opts.ftpConfig || null; // FTP config for source (download)
  const ftpDestConfig = opts.ftpDestConfig || null; // FTP config for dest (upload)
  if (!dest || (!path.isAbsolute(dest) && !dest.startsWith('ftp://'))) throw new Error('Invalid destination');

  const action = opts.action || 'copy';
  const layout = opts.layout || 'etahen';
  const customName = opts.customName || null;
  const overwriteMode = opts.overwriteMode || 'rename';

  const controller = new AbortController();
  activeCancelFlags.set(event.sender.id, () => controller.abort());

  let transferStartTime = Date.now();
  let totalTransferred = 0;

  // Fire go-start so the renderer can prime its elapsed timer and progress panel
  event.sender?.send('scan-progress', { type: 'go-start', totalItems: items.length });

  const results = [];
  // Pre-compute once so progressFn doesn't call .reduce() on every IPC event
  const _grandTotalBytes = items.reduce((s, x) => s + (x.totalSize || 0), 0);
  try {
    // ── Free-space pre-check (local-to-local only) ──────────────────────────
    if (!ftpConfig && !ftpDestConfig && (action === 'copy' || action === 'copy-fast') && _grandTotalBytes > 0) {
      try {
        await fs.promises.mkdir(toExtendedPath(dest), { recursive: true });
        const freeBytes = await getLocalFreeSpace(toExtendedPath(dest));
        if (freeBytes < _grandTotalBytes + DISK_SPACE_SAFETY_BUFFER_BYTES) {
          const needGB = ((_grandTotalBytes + DISK_SPACE_SAFETY_BUFFER_BYTES) / (1024 ** 3)).toFixed(2);
          const freeGB = (freeBytes / (1024 ** 3)).toFixed(2);
          const msg = `Not enough disk space: need ${needGB} GB, only ${freeGB} GB free`;
          event.sender?.send('scan-progress', { type: 'go-error', message: msg });
          throw new Error(msg);
        }
      } catch (e) {
        if (e.message.includes('Not enough disk space')) throw e;
        console.warn('[Transfer] Free-space check failed (non-fatal):', e.message);
      }
    }
    for (let idx = 0; idx < items.length; idx++) {
      if (controller.signal.aborted) break;
      const cancelCheck = () => controller.signal.aborted;
      let finalTarget = null;
      try {
        const it = items[idx];
        let parsed = null;
        if (it.paramParsed) parsed = it.paramParsed;
        else if (it.paramPath) parsed = await readJsonSafe(it.paramPath);
        // FIX B2: was `!it.ppsaFolderPath.startsWith('/')` which skipped every Linux/Mac local path.
        // Guard should only exclude FTP remote paths (ftp://) not local absolute paths.
        if (!parsed && it.ppsaFolderPath && !it.ppsaFolderPath.startsWith('ftp://')) {
          parsed = await readJsonSafe(path.join(it.ppsaFolderPath, 'sce_sys', 'param.json'));
        }
        // FIX B3: same wrong guard for contentFolderPath
        if (!parsed && it.contentFolderPath && !it.contentFolderPath.startsWith('ftp://')) {
          let cand = path.join(it.contentFolderPath, 'sce_sys', 'param.json');
          parsed = await readJsonSafe(cand);
          if (!parsed) {
            cand = path.join(path.dirname(it.contentFolderPath), 'sce_sys', 'param.json');
            parsed = await readJsonSafe(cand);
          }
        }

        const safeGameName = deriveSafeGameName(it, parsed);
        const safeGame = customName && layout === 'custom' ? sanitize(customName) : sanitize(safeGameName);

        // ── Version suffix for folder name ────────────────────────────────────
        // Append game version in parentheses so the same game at different versions
        // can coexist in the same destination: "Among Us (01.000.000)"
        // Source of version: param.json contentVersion > masterVersion > item.contentVersion > item.version
        const rawVer = parsed?.contentVersion || parsed?.masterVersion || it?.contentVersion || it?.version || '';
        const verSuffix = rawVer ? ` (${sanitize(rawVer)})` : '';
        // safeGameWithVer is used for all game-name-based layouts.
        // ppsa-only uses the PPSA ID directly so no version suffix there.
        const safeGameWithVer = safeGame + verSuffix;

        let srcFolder = it.ppsaFolderPath || it.folderPath || null;
        if (!srcFolder && it.contentFolderPath) {
          if (path.basename(it.contentFolderPath).toLowerCase() === 'sce_sys') srcFolder = path.dirname(it.contentFolderPath);
          else srcFolder = it.contentFolderPath;
        }
        if (srcFolder && path.basename(srcFolder).match(/^PPSA\d{4,6}/)) {
          const appSub = path.join(srcFolder, path.basename(srcFolder) + '-app');
          try {
            const st = await fs.promises.stat(appSub);
            if (st.isDirectory()) srcFolder = appSub;
          } catch (_) {}
        }
        if (!srcFolder) {
          results.push({ item: it.folderName, error: 'no source folder', target: null, source: null, safeGameName });
          continue;
        }

        event.sender?.send('scan-progress', { type: 'go-item', path: srcFolder, itemIndex: idx + 1, totalItems: items.length });

        let finalPpsaName = null;
        if (parsed?.contentId) finalPpsaName = extractPpsaKey(parsed.contentId);
        if (!finalPpsaName && it.ppsa) finalPpsaName = it.ppsa;
        if (!finalPpsaName) {
          const srcBase = path.basename(srcFolder);
          finalPpsaName = srcBase.replace(/[-_]*app\d*.*$/i, '').replace(/[-_]+$/,'') || srcBase;
        }

        if (layout === 'ppsa-only') finalTarget = pathJoin(dest, finalPpsaName);
        else if (layout === 'game-only') finalTarget = pathJoin(dest, safeGameWithVer);
        else if (layout === 'etahen') finalTarget = pathJoin(dest, 'etaHEN', 'games', safeGameWithVer);
        else if (layout === 'itemzflow') finalTarget = pathJoin(dest, 'games', safeGameWithVer);
        else if (layout === 'dump_runner') finalTarget = pathJoin(dest, 'homebrew', safeGameWithVer);
        else if (layout === 'porkfolio') finalTarget = pathJoin(dest, `${safeGameWithVer} ${finalPpsaName}`);
        else if (layout === 'custom') finalTarget = pathJoin(dest, safeGameWithVer);  // Just the custom folder name
        else finalTarget = pathJoin(dest, safeGameWithVer, finalPpsaName);  // game-ppsa creates GameName (ver)/PPSAName
        // Overlap check: skip entirely when either end is FTP (path.resolve corrupts ftp:// URLs)
        if (!srcFolder.startsWith('ftp://') && !finalTarget.startsWith('ftp://')) {
          const normalizedSrc    = path.resolve(srcFolder);
          const normalizedTarget = path.resolve(finalTarget);
          const srcSep    = normalizedSrc    + path.sep;
          const targetSep = normalizedTarget + path.sep;
          const srcInsideTarget  = normalizedSrc.startsWith(targetSep);
          const targetInsideSrc  = normalizedTarget.startsWith(srcSep);
          if (targetInsideSrc || (srcInsideTarget && action !== 'move')) {
            throw new Error(`Path overlap: ${finalTarget} conflicts with ${srcFolder}`);
          }
        }

        // ── Pre-transfer size ────────────────────────────────────────────────
        // Priority 1: use size already calculated during the scan (Phase 3).
        //   This avoids a 30-60s re-enumeration that blocks all progress events
        //   and leaves the modal stuck at "Preparing..." the entire time.
        // Priority 2: FTP manifest already provides size — skip local stat.
        // Priority 3: if genuinely unknown, run a fast parallel stat walk and
        //   notify the UI so it shows "Counting files..." instead of nothing.
        let itemTotalBytes = 0;
        if (!ftpConfig) {
          if (it.totalSize > 0) {
            // ✓ Fast path: scan already sized this game
            itemTotalBytes = it.totalSize;
          } else {
            // Slow path: size unknown — run parallel stat walk.
            // Send a counting event so the UI shows activity rather than freezing.
            event.sender?.send('scan-progress', {
              type: 'go-counting',
              itemIndex: idx + 1,
              totalItems: items.length,
            });
            try {
              itemTotalBytes = await calcSingleGameSize({ folderPath: srcFolder }, controller.signal);
            } catch (e) {
              console.warn('[Transfer] Size pre-calc failed:', e.message);
              itemTotalBytes = 0;
            }
          }
        }

        let totalBytesCopiedSoFar = 0;
        let lastProgressSentAt = 0;

        const progressFn = (info) => {
          if (!event.sender || event.sender.isDestroyed()) return;
          if (info.type === 'go-file-complete') {
            // File finished — accumulate completed bytes
            const fileBytes = info.totalBytesCopied || 0;
            totalBytesCopiedSoFar += fileBytes;
            totalTransferred      += fileBytes;
          }
          // Throttle intermediate progress events to ≤ 8 Hz.
          // copyFileStream fires on EVERY 64KB chunk — for a fast NVMe-to-NVMe
          // transfer that's ~8000 events/second, which floods the IPC channel
          // and paradoxically slows the copy.  Terminal events (file-complete,
          // ftp-manifest-progress) always go through immediately.
          const now = Date.now();
          const isTerminal = (info.type !== 'go-file-progress' && info.type !== 'ftp-manifest-progress');
          if (!isTerminal && now - lastProgressSentAt < 125) return; // 8 Hz cap
          lastProgressSentAt = now;

          const cumulativeCopied = info.type === 'go-file-progress'
            ? totalBytesCopiedSoFar + (info.totalBytesCopied || 0)
            : totalBytesCopiedSoFar;

          event.sender.send('scan-progress', {
            ...info,
            totalBytes:      itemTotalBytes || info.totalBytes || 0,
            totalBytesCopied: cumulativeCopied,
            itemIndex:       idx + 1,
            totalItems:      items.length,
            grandTotalBytes: _grandTotalBytes,
            grandTotalCopied: totalTransferred + (
              info.type === 'go-file-progress' ? (info.totalBytesCopied || 0) : 0
            ),
            totalElapsed: Math.round((Date.now() - transferStartTime) / 1000),
          });
        };

        // For FTP destinations fs.stat('ftp://...') always throws → always "not found".
        // Use FTP LIST to actually check whether the target folder exists on the server.
        let ftpDestRemotePath = null;
        if (ftpDestConfig) {
          ftpDestRemotePath = finalTarget.replace(/^ftp:\/\/[^/]+/, '') || '/';
          ftpDestRemotePath = ('/' + ftpDestRemotePath.replace(/^\/+/, '')).replace(/\/\/+/g, '/');
        }
        let exists = false;
        if (ftpDestConfig && ftpDestRemotePath) {
          const ec = new ftp.Client(8000);
          applyFtpPassive(ec, ftpDestConfig);
          try {
            await ec.access({ host: ftpDestConfig.host, port: parseInt(ftpDestConfig.port), user: ftpDestConfig.user || 'anonymous', password: ftpDestConfig.pass || '', secure: false });
            await ec.cd(ftpDestRemotePath); await ec.list();
            exists = true;
          } catch (_) { exists = false; }
          finally { ec.close(); }
        } else {
          exists = !!(await fs.promises.stat(finalTarget).catch(() => false));
        }
        if (exists) {
          if (overwriteMode === 'skip') {
            results.push({ item: it.folderName, skipped: true, reason: 'target exists', target: finalTarget, source: srcFolder, safeGameName });
            continue;
          } else if (overwriteMode === 'overwrite') {
            // Safety: never delete the source folder (would destroy the game we're about to copy).
            if (ftpDestConfig && ftpDestRemotePath) {
              const isSamePath = srcFolder && ftpDestRemotePath &&
                srcFolder.replace(/\/+$/, '') === ftpDestRemotePath.replace(/\/+$/, '');
              if (isSamePath) {
                console.warn('[overwrite] source === target on FTP — skipping pre-delete');
              } else {
                const dc = new ftp.Client(30000);
                applyFtpPassive(dc, ftpDestConfig);
                try {
                  await dc.access({ host: ftpDestConfig.host, port: parseInt(ftpDestConfig.port), user: ftpDestConfig.user || 'anonymous', password: ftpDestConfig.pass || '', secure: false });
                  await ftpDeleteRecursive(dc, ftpDestRemotePath);
                } catch (e) { console.warn('[FTP] Pre-overwrite delete failed:', e.message); }
                finally { dc.close(); }
              }
            } else {
              const normSrc = path.resolve(srcFolder || '');
              const normTgt = path.resolve(finalTarget);
              if (normSrc === normTgt || normTgt.startsWith(normSrc + path.sep) || normSrc.startsWith(normTgt + path.sep)) {
                console.warn('[overwrite] source overlaps target — skipping pre-delete:', normTgt);
              } else {
                await removePathRecursive(finalTarget);
              }
            }
          } else {
            // rename: find an unused (1), (2)… suffix
            if (ftpDestConfig && ftpDestRemotePath) {
              const rc = new ftp.Client(8000);
              applyFtpPassive(rc, ftpDestConfig);
              try {
                await rc.access({ host: ftpDestConfig.host, port: parseInt(ftpDestConfig.port), user: ftpDestConfig.user || 'anonymous', password: ftpDestConfig.pass || '', secure: false });
                for (let n = 1; n <= 100; n++) {
                  const tryR = ftpDestRemotePath + ` (${n})`;
                  try { await rc.cd(tryR); await rc.list(); }
                  catch (_) { ftpDestRemotePath = tryR; finalTarget = finalTarget + ` (${n})`; break; }
                }
              } catch (e) {
                const ts = Date.now(); ftpDestRemotePath += ` (${ts})`; finalTarget += ` (${ts})`;
              } finally { rc.close(); }
            } else {
              finalTarget = await ensureUniqueTarget(finalTarget);
            }
          }
        }

        if (action === 'folder-only') {
          event.sender?.send('scan-progress', { type: 'go-item', path: finalTarget, itemIndex: idx + 1, totalItems: items.length });
          await fs.promises.mkdir(toExtendedPath(finalTarget), { recursive: true });
          event.sender?.send('scan-progress', { type: 'go-file-complete', fileRel: 'Folder created', totalBytesCopied: 0, totalBytes: 0 });
          results.push({ item: safeGameName, target: finalTarget, created: true, source: srcFolder, safeGameName, totalSize: itemTotalBytes });
        } else if (action === 'copy' || action === 'copy-fast' || action === 'move') {
          const originalSrcFolder = srcFolder; // Store original for FTP delete
          let tempDir = null;

          if (ftpDestConfig) {
            // FTP upload path (local → FTP, or FTP → FTP)
            //
            // remotePath: the destination path on the FTP server.
            // When dest is a full ftp:// URL we strip the URL prefix so we get the
            // server-side path that basic-ftp actually needs (no protocol/host).
            // Use the pre-computed (and possibly rename-updated) server-side path.
            let remotePath = ftpDestRemotePath || (() => {
              const p = finalTarget.replace(/^ftp:\/\/[^/]+/, '') || '/';
              return ('/' + p.replace(/^\/+/, '')).replace(/\/\/+/g, '/');
            })();

            // Always clean up the temp dir, even if download or upload throws.
            try {
              // If source is FTP on the same server and this is a move, prefer a
              // server-side rename (instant, no data transfer).
              if (ftpConfig && action === 'move' &&
                  ftpConfig.host === ftpDestConfig.host &&
                  String(ftpConfig.port) === String(ftpDestConfig.port)) {
                const client = new ftp.Client();
                applyFtpPassive(client, ftpConfig);
                let renameOk = false;
                try {
                  await client.access({ host: ftpConfig.host, port: parseInt(ftpConfig.port), user: ftpConfig.user, password: ftpConfig.pass || '', secure: false });
                  const remoteSrc = srcFolder;
                  const remoteDst = remotePath;
                  await client.rename(remoteSrc, remoteDst);
                  renameOk = true;
                  results.push({ item: safeGameName, target: finalTarget, moved: true, source: srcFolder, safeGameName, totalSize: itemTotalBytes });
                } catch (e) {
                  console.warn('[FTP] Same-server rename failed, falling back to download+upload:', e.message);
                } finally {
                  client.close();
                }

                if (!renameOk) {
                  // Fallback: download to a temp dir, upload from there, then delete original.
                  tempDir = path.join(os.tmpdir(), 'ps5vault_temp_' + Date.now() + '_' + idx);
                  await fs.promises.mkdir(tempDir, { recursive: true });
                  await downloadFtpFolder(ftpConfig, srcFolder, tempDir, (info) => {
                    if (info.totalBytes && !itemTotalBytes) itemTotalBytes = info.totalBytes;
                    progressFn(info);
                  }, cancelCheck);
                  srcFolder = tempDir;
                  progressFn({ type: 'go-file-progress', totalBytesCopied: 0, totalBytes: itemTotalBytes });
                  await uploadFtpFolder(ftpDestConfig, srcFolder, remotePath, (info) => {
                    if (info.totalBytes && !itemTotalBytes) itemTotalBytes = info.totalBytes;
                    progressFn(info);
                  }, cancelCheck);
                  results.push({ item: safeGameName, target: finalTarget, moved: true, source: originalSrcFolder, safeGameName, totalSize: itemTotalBytes });
                  // Delete original from FTP source
                  const delClient = new ftp.Client();
                  applyFtpPassive(delClient, ftpConfig);
                  try {
                    await delClient.access({ host: ftpConfig.host, port: parseInt(ftpConfig.port), user: ftpConfig.user, password: ftpConfig.pass || '', secure: false });
                    await ftpDeleteRecursive(delClient, originalSrcFolder);
                  } finally {
                    delClient.close();
                  }
                }
              } else {
                // Normal upload: if source is also FTP, download to temp dir first.
                if (ftpConfig) {
                  tempDir = path.join(os.tmpdir(), 'ps5vault_temp_' + Date.now() + '_' + idx);
                  await fs.promises.mkdir(tempDir, { recursive: true });
                  await downloadFtpFolder(ftpConfig, srcFolder, tempDir, (info) => {
                    if (info.totalBytes && !itemTotalBytes) itemTotalBytes = info.totalBytes;
                    progressFn(info);
                  }, cancelCheck);
                  srcFolder = tempDir;
                }
                progressFn({ type: 'go-file-progress', totalBytesCopied: 0, totalBytes: itemTotalBytes });
                await uploadFtpFolder(ftpDestConfig, srcFolder, remotePath, (info) => {
                  if (info.totalBytes && !itemTotalBytes) itemTotalBytes = info.totalBytes;
                  progressFn(info);
                }, cancelCheck);
                results.push({ item: safeGameName, target: finalTarget, moved: action === 'move', uploaded: action !== 'move', source: originalSrcFolder, safeGameName, totalSize: itemTotalBytes });
                if (action === 'move' && !ftpConfig) {
                  // Source was local — delete it now that upload succeeded.
                  await removePathRecursive(originalSrcFolder);
                }
              }
            } finally {
              // Always clean up temp dir regardless of success or error.
              if (tempDir) {
                removePathRecursive(tempDir).catch(e => console.warn('[FTP] temp dir cleanup failed:', e.message));
              }
            }
          } else if (ftpConfig) { // FTP source → local destination
            // Download first — throws on any file failure so source is never deleted
            // unless every byte is confirmed safely on local disk.
            progressFn({ type: 'go-file-progress', totalBytesCopied: 0, totalBytes: itemTotalBytes });
            await downloadFtpFolder(ftpConfig, srcFolder, finalTarget, (info) => {
              if (info.totalBytes && !itemTotalBytes) itemTotalBytes = info.totalBytes;
              progressFn(info);
            }, cancelCheck);
            // For move: delete FTP source only after download fully completes without error.
            if (action === 'move') {
              const delClient = new ftp.Client();
              applyFtpPassive(delClient, ftpConfig);
              try {
                await delClient.access({ host: ftpConfig.host, port: parseInt(ftpConfig.port), user: ftpConfig.user || 'anonymous', password: ftpConfig.pass || '', secure: false });
                await ftpDeleteRecursive(delClient, srcFolder);
              } catch (delErr) {
                // Delete failed — game is safely on local disk. User has two copies, not zero.
                console.warn('[FTP→local move] Source delete failed (game safe locally):', delErr.message);
              } finally {
                delClient.close();
              }
              results.push({ item: safeGameName, target: finalTarget, moved: true, source: srcFolder, safeGameName, totalSize: itemTotalBytes });
            } else {
              results.push({ item: safeGameName, target: finalTarget, copied: true, source: srcFolder, safeGameName, totalSize: itemTotalBytes });
            }
          } else {
            // Local copy/move
            progressFn({ type: 'go-file-progress', totalBytesCopied: 0, totalBytes: itemTotalBytes });
            if (action === 'copy' || action === 'copy-fast') {
              await copyFolderContentsSafely(srcFolder, finalTarget, { progress: progressFn, cancelCheck, totalBytes: itemTotalBytes, skipVerify: action === 'copy-fast' });
              results.push({ item: safeGameName, target: finalTarget, copied: true, fast: action === 'copy-fast', source: srcFolder, safeGameName, totalSize: itemTotalBytes });
            } else {
              await moveFolderContentsSafely(srcFolder, finalTarget, { progress: progressFn, cancelCheck, overwriteMode, totalBytes: itemTotalBytes });
              results.push({ item: safeGameName, target: finalTarget, moved: true, source: srcFolder, safeGameName, totalSize: itemTotalBytes });
            }
          }
        } else {
          results.push({ item: safeGameName, error: `unknown action ${action}`, source: srcFolder, target: finalTarget, safeGameName });
        }
      } catch (e) {
        const msg = String(e?.message || e);
        results.push({
          item: deriveSafeGameName(items[idx], null),
          error: msg,
          source: items[idx]?.contentFolderPath || items[idx]?.folderPath || null,
          target: finalTarget || null,
          safeGameName: deriveSafeGameName(items[idx], null)
        });
      }
    }

    event.sender?.send('scan-progress', { type: 'go-complete', totalBytesCopied: totalTransferred, grandTotalBytes: _grandTotalBytes, grandTotalCopied: totalTransferred, resultsCount: results.length });
    event.sender?.send('operation-complete', { success: true, resultsCount: results.length });
  } catch (e) {
    event.sender?.send('operation-complete', { success: false, error: String(e?.message || e) });
  } finally {
    activeCancelFlags.delete(event.sender.id);
  }
  return { success: true, results };
}

ipcMain.handle('ensure-and-populate', async (event, opts) => {
  return doEnsureAndPopulate(event, opts);
});

ipcMain.handle('check-conflicts', async (event, items, dest, layout, customName) => {
  const conflicts = [];
  const isFtpDest = typeof dest === 'string' && dest.startsWith('ftp://');
  let ccClient = null;
  if (isFtpDest) {
    try {
      const u = new URL(dest);
      ccClient = new ftp.Client(8000);
      ccClient.ftp.verbose = false;
      await ccClient.access({ host: u.hostname, port: parseInt(u.port || '2121'), user: u.username || 'anonymous', password: u.password || '', secure: false });
    } catch (e) {
      console.warn('[check-conflicts] FTP connect failed:', e.message);
      if (ccClient) { try { ccClient.close(); } catch (_) {} ccClient = null; }
    }
  }
  try {
    for (const it of items) {
      const safeGame = customName && layout === 'custom' ? sanitize(customName) : sanitize(deriveSafeGameName(it, null));
      const rawVer = it?.contentVersion || it?.version || '';
      const verSuffix = rawVer ? ` (${sanitize(rawVer)})` : '';
      const safeGameWithVer = safeGame + verSuffix;
      let finalPpsaName = it.ppsa || (it.contentId && (String(it.contentId).match(/PPSA\d{4,6}/i) || [])[0]?.toUpperCase()) || null;
      if (!finalPpsaName) {
        const src = it.contentFolderPath || it.ppsaFolderPath || it.folderPath || '';
        const base = (src + '').split(/[\\/]/).pop() || '';
        finalPpsaName = base.replace(/[-_]*app\d*.*$/i, '').replace(/[-_]+$/,'') || base;
      }
      let finalTarget;
      if (layout === 'ppsa-only') finalTarget = pathJoin(dest, finalPpsaName);
      else if (layout === 'game-only') finalTarget = pathJoin(dest, safeGameWithVer);
      else if (layout === 'etahen') finalTarget = pathJoin(dest, 'etaHEN', 'games', safeGameWithVer);
      else if (layout === 'itemzflow') finalTarget = pathJoin(dest, 'games', safeGameWithVer);
      else if (layout === 'dump_runner') finalTarget = pathJoin(dest, 'homebrew', safeGameWithVer);
      else if (layout === 'porkfolio') finalTarget = pathJoin(dest, `${safeGameWithVer} ${finalPpsaName}`);
      else if (layout === 'custom') finalTarget = pathJoin(dest, safeGameWithVer);
      else finalTarget = pathJoin(dest, safeGameWithVer, finalPpsaName);

      // Skip exists check when target path overlaps source — the transfer itself will
      // handle this (either it's a no-op rename or doEnsureAndPopulate throws "path overlap").
      // Showing a conflict modal for this case is misleading: skip/rename/overwrite are
      // all wrong choices when the issue is that src IS the target.
      const srcForCheck = it.ppsaFolderPath || it.folderPath || '';
      if (srcForCheck && !srcForCheck.startsWith('ftp://') && !finalTarget.startsWith('ftp://')) {
        const normSrc = path.resolve(srcForCheck);
        const normTgt = path.resolve(finalTarget);
        if (normSrc === normTgt || normTgt.startsWith(normSrc + path.sep) || normSrc.startsWith(normTgt + path.sep)) {
          continue; // path overlap — not a conflict, doEnsureAndPopulate handles it
        }
      }

      let exists = false;
      if (isFtpDest && ccClient) {
        const sp = ('/' + finalTarget.replace(/^ftp:\/\/[^/]+/, '').replace(/^\/+/, '')).replace(/\/\/+/g, '/');
        try {
            await ccClient.cd(sp);
            await ccClient.list();
            exists = true;
          } catch (_) { exists = false; }
      } else if (!isFtpDest) {
        exists = !!(await fs.promises.stat(finalTarget).catch(() => false));
      }
      if (exists) conflicts.push({ item: it.displayTitle || it.folderName || '', target: finalTarget });
    }
  } finally {
    if (ccClient) { try { ccClient.close(); } catch (_) {} }
  }
  return conflicts;
});

ipcMain.handle('show-in-folder', async (_event, targetPath) => {
  try {
    if (!targetPath || typeof targetPath !== 'string') throw new Error('Invalid path');
    shell.showItemInFolder(targetPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('open-external-link', async (_event, url) => {
  try {
    if (!url || typeof url !== 'string') throw new Error('Invalid URL');
    await shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('clipboard-write', async (_event, text) => {
  try {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

// New IPC for batch operations
ipcMain.handle('delete-item', async (event, item) => {
  const pathToDelete = item.ppsaFolderPath || item.folderPath;
  if (!pathToDelete || !path.isAbsolute(pathToDelete)) {
    throw new Error('Invalid path for local delete');
  }
  await removePathRecursive(pathToDelete);
  return { success: true };
});

ipcMain.handle('rename-item', async (event, item, newName) => {
  try {
    const oldPath = item.ppsaFolderPath || item.folderPath;
    if (!oldPath || !path.isAbsolute(oldPath)) throw new Error('Invalid source path');
    const safeName = sanitize(newName);
    if (!safeName || safeName === 'Unknown') throw new Error('Invalid new name');
    // Prevent path traversal: sanitize strips separators, but double-check
    if (safeName.includes('/') || safeName.includes('\\')) throw new Error('Name cannot contain path separators');
    const newPath = path.join(path.dirname(oldPath), safeName);
    // Ensure dest stays within same parent directory
    if (path.dirname(newPath) !== path.dirname(oldPath)) throw new Error('Path traversal not allowed');
    await fs.promises.rename(oldPath, newPath);
    return { success: true };
  } catch (e) {
    return { error: String(e.message) };
  }
});

// FTP operations
ipcMain.handle('ftp-delete-item', async (event, config, remoteFtpPath) => {
  const decodedPath = decodeURIComponent(remoteFtpPath);
  const client = new ftp.Client();
  applyFtpPassive(client, config);
  try {
    await client.access({ host: config.host, port: parseInt(config.port), user: config.user, password: config.pass, secure: false });
    await ftpDeleteRecursive(client, decodedPath);
    return { success: true };
  } catch (e) {
    throw new Error(e.message);
  } finally {
    client.close();
  }
});

ipcMain.handle('ftp-rename-item', async (event, config, oldPath, newPath) => {
  const decodedOld = decodeURIComponent(oldPath);
  const decodedNew = decodeURIComponent(newPath);
  const client = new ftp.Client();
  applyFtpPassive(client, config);
  try {
    await client.access({ host: config.host, port: parseInt(config.port), user: config.user, password: config.pass, secure: false });
    await client.rename(decodedOld, decodedNew);
    // Invalidate cache for moved path
    for (const key of Object.keys(diskSizeCache)) {
      if (key.includes(':' + decodedOld) || key.includes(':' + decodedNew)) {
        delete diskSizeCache[key];
        scheduleDiskCacheSave();
      }
    }
    return { success: true };
  } catch (e) {
    throw new Error(e.message);
  } finally {
    client.close();
  }
});

// Clear FTP size cache (called from renderer Settings/logo click)
ipcMain.handle('clear-ftp-size-cache', async () => {
  sizeCache.clear();
  localSizeCache.clear();
  diskSizeCache = {};
  scheduleDiskCacheSave();
  try { fs.unlinkSync(getLocalSizeCachePath()); } catch (_) {}
  return { cleared: true };
});

// Return cache stats for UI display
ipcMain.handle('ftp-cache-stats', async () => {
  const entries = Object.keys(diskSizeCache).length;
  const memEntries = sizeCache.size;
  return { diskEntries: entries, memEntries };
});

// Expose drive list to renderer — used by scan-source 'all-drives' mode
ipcMain.handle('get-all-drives', async () => {
  return getAllDrives();
});

ipcMain.handle('move-to-layout', async (event, item, dest, layout) => {
  return await doEnsureAndPopulate(event, { items: [item], dest, action: 'move', layout });
});




// Resume IPC
ipcMain.handle('resume-transfer', async (event, state) => {
  return await doEnsureAndPopulate(event, state);
});

// ── Developer API management IPC ─────────────────────────────────────────────
ipcMain.handle('get-api-status', async () => {
  return {
    port:       apiServer.getPort(),
    keyPreview: (() => {
      const k = apiServer.getKey() || '';
      return k.length >= 12 ? k.slice(0, 8) + '…' + k.slice(-4) : k;
    })(),
  };
});

ipcMain.handle('get-api-key', async () => {
  return { key: apiServer.getKey() };
});

ipcMain.handle('regenerate-api-key', async () => {
  const newKey = apiServer.regenerateKey();
  return {
    key:        newKey,
    keyPreview: newKey ? newKey.slice(0, 8) + '…' + newKey.slice(-4) : '',
  };
});

// ── FTP test connection ───────────────────────────────────────────────────────
ipcMain.handle('ftp-test-connection', async (_event, config) => {
  const start = Date.now();
  const client = new ftp.Client(8000); // 8s timeout
  client.ftp.verbose = false;
  try {
    await client.access({
      host:     config.host,
      port:     parseInt(config.port, 10) || 2121,
      user:     config.user     || 'anonymous',
      password: config.pass     || '',
      secure:   false,
    });
    const latencyMs = Date.now() - start;
    // Try to list root to confirm read access
    let listing = 0;
    try { const list = await client.list('/'); listing = list.length; } catch (_) {}
    return { ok: true, latencyMs, listing };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, error: e.message };
  } finally {
    try { client.close(); } catch (_) {}
  }
});

// ── PS5 Auto-Discover ─────────────────────────────────────────────────────────
// Scans the local subnet(s) for open PS5 FTP ports (2121, 1337, 1338).
// TCP-probes all hosts in parallel, then does a lightweight FTP banner check
// on each hit to rule out routers/NAS boxes that happen to have those ports open.
ipcMain.handle('ps5-discover', async (_event, timeoutMs = 3000) => {
  const net = require('net');
  const ifaces = os.networkInterfaces();
  const subnets = new Set();

  for (const ifaceList of Object.values(ifaces)) {
    for (const addr of (ifaceList || [])) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const base = addr.address.split('.').slice(0, 3).join('.');
        subnets.add(base);
      }
    }
  }

  const PS5_PORTS = [2121, 1337, 1338];
  const tcpHits = [];  // [{ip, port}] — raw TCP open
  // Use a generous per-probe timeout so PS5s on Wi-Fi or busy networks respond in time.
  // Dividing by 6 gives ~1000 ms with the 6000 ms call from the renderer.
  const perProbeTimeout = Math.max(500, Math.floor(timeoutMs / 6));

  for (const subnet of Array.from(subnets)) {
    const probes = [];
    for (let n = 1; n <= 254; n++) {
      const ip = `${subnet}.${n}`;
      // Don't skip any host IPs — a PS5 could theoretically have any address in the subnet.
      for (const port of PS5_PORTS) {
        probes.push(new Promise(resolve => {
          const sock = new net.Socket();
          let done = false;
          const finish = (hit) => {
            if (done) return; done = true;
            sock.destroy();
            if (hit) tcpHits.push({ ip, port });
            resolve();
          };
          sock.setTimeout(perProbeTimeout);
          sock.connect(port, ip, () => finish(true));
          sock.on('error', () => finish(false));
          sock.on('timeout', () => finish(false));
        }));
      }
    }
    await Promise.all(probes);
  }

  if (!tcpHits.length) return [];

  // Deduplicate TCP hits by IP using port priority (2121 > 1337 > 1338) before
  // FTP verification so only the preferred port per PS5 is verified — not
  // whichever TCP probe happened to resolve first.
  const portPriority = { 2121: 0, 1337: 1, 1338: 2 };
  const byIpTcp = {};
  for (const h of tcpHits) {
    if (!byIpTcp[h.ip] || (portPriority[h.port] ?? 9) < (portPriority[byIpTcp[h.ip].port] ?? 9)) {
      byIpTcp[h.ip] = h;
    }
  }
  const dedupedHits = Object.values(byIpTcp);

  // ── FTP banner verification ───────────────────────────────────────────────
  // For each deduplicated hit, open a raw socket and read the 220 banner to
  // confirm it's actually an FTP server (not a router service).
  // PS5 payloads (ftpsrv, etaHEN, ftpsrc) always send a 220 greeting.
  async function verifyFtp(ip, port) {
    return new Promise(resolve => {
      const sock = new net.Socket();
      let buf = '';
      let done = false;
      const finish = (ok) => {
        if (done) return; done = true;
        sock.destroy();
        resolve(ok);
      };
      sock.setTimeout(3000);
      sock.connect(port, ip, () => { /* wait for banner */ });
      sock.on('data', chunk => {
        buf += chunk.toString('ascii');
        // FTP servers always start with "220" or "220-"
        if (/^220[\s-]/m.test(buf)) { finish(true); return; }
        // Reject anything that clearly isn't FTP
        if (buf.length > 512) finish(false);
      });
      sock.on('error', () => finish(false));
      sock.on('timeout', () => finish(false));
    });
  }

  // Verify deduplicated hits in parallel (one preferred port per IP)
  const verified = await Promise.all(
    dedupedHits.map(async h => ({ ...h, ok: await verifyFtp(h.ip, h.port) }))
  );

  return verified.filter(h => h.ok).map(({ ip, port }) => ({ ip, port }));
});

// ── FTP Storage Info ──────────────────────────────────────────────────────────
// Probes known PS5 mount points and returns which ones are accessible.
// Can't read /proc/mounts via FTP, so we just check known paths.
ipcMain.handle('ftp-storage-info', async (_event, config, scannedItems = []) => {
  const client = new ftp.Client(12000);
  client.ftp.verbose = false;
  applyFtpPassive(client, config);

  // All known PS5 mount points — inaccessible ones are skipped automatically.
  const mounts = [
    '/data',      // internal SSD (primary games location on most payloads)
    '/mnt/ext0',  // extended storage slot 1 (M.2 SSD or USB-C SSD)
    '/mnt/ext1',  // extended storage slot 2
    '/mnt/usb0',  // USB port 0
    '/mnt/usb1',  // USB port 1
    '/mnt/usb2',  // USB port 2
    '/mnt/usb3',  // USB port 3
    '/mnt/usb4',  // USB port 4 (via hub)
    '/mnt/usb5',  // USB port 5 (via hub)
    '/mnt/usb6',  // USB port 6 (via hub)
    '/mnt/usb7',  // USB port 7 (via hub)
    '/mnt/int0',  // internal storage alt mount (some payload versions)
  ];

  // ── Pre-compute used-by-games per mount from already-scanned items ──────
  const gamesByMount = {};
  for (const item of (scannedItems || [])) {
    const p = item.ppsaFolderPath || item.folderPath || '';
    if (!p || !(item.totalSize > 0)) continue;
    const mount = mounts.find(m => p.startsWith(m + '/') || p === m) || null;
    if (!mount) continue;
    if (!gamesByMount[mount]) gamesByMount[mount] = { totalSize: 0, count: 0 };
    gamesByMount[mount].totalSize += item.totalSize;
    gamesByMount[mount].count++;
  }

  // ── PS5 hardware constants ───────────────────────────────────────────────
  const PS5_INTERNAL_TOTAL = 667 * 1024 * 1024 * 1024; // ~667 GB usable on standard PS5

  // ── Helpers ──────────────────────────────────────────────────────────────

  // Send a raw FTP command with a timeout. Returns the full response message string.
  async function ftpSend(cmd, ms = 3000) {
    try {
      const raw = await Promise.race([
        client.send(cmd),
        new Promise((_, r) => setTimeout(() => r(new Error('cmd-timeout')), ms))
      ]);
      return (raw && raw.message) ? raw.message : (typeof raw === 'string' ? raw : '');
    } catch (_) { return ''; }
  }

  // Download a small remote file into a string buffer via FTP RETR.
  async function ftpRetr(remotePath, maxBytes = 16384, ms = 3000) {
    return new Promise(resolve => {
      let buf = '', done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(''); } }, ms);
      const w = new Writable({
        write(chunk, _enc, cb) {
          buf += chunk.toString('utf8');
          if (buf.length >= maxBytes) { done = true; clearTimeout(timer); resolve(buf); }
          cb();
        }
      });
      client.downloadTo(w, remotePath)
        .then(() => { if (!done) { done = true; clearTimeout(timer); resolve(buf); } })
        .catch(() => { if (!done) { done = true; clearTimeout(timer); resolve(''); } });
    });
  }

  // ── Universal space-response parser ──────────────────────────────────────
  // Handles all known PS5 FTP daemon response formats in one place.
  function parseSpaceMsg(msg) {
    if (!msg || typeof msg !== 'string') return { available: 0, total: 0 };
    let available = 0, total = 0;

    // ── Format 1: plain large integer (213 reply from AVBL/XAVBL/XDISKFREE)
    // e.g. "213 1073741824"  or  "213-1073741824"
    const singleInt = msg.match(/^2\d\d[- ](\d{6,})/m);
    if (singleInt) return { available: parseInt(singleInt[1], 10), total: 0 };

    // ── Format 2: key=value pairs (some SITE DF implementations)
    // e.g. "Available=1073741824 Total=2147483648"
    const kv = {};
    for (const [, k, v] of msg.matchAll(/(\w+)=(\d+)/gi)) kv[k.toLowerCase()] = parseInt(v, 10);
    if (kv.available || kv.avail || kv.free) {
      available = kv.available || kv.avail || kv.free || 0;
      total     = kv.total || kv.size || kv.capacity || 0;
      if (available > 0 || total > 0) return { available, total };
    }

    // ── Format 3: "X bytes free" / "X bytes available" (plain English)
    const byteFree = msg.match(/(\d{6,})\s*bytes?\s*(?:free|available)/i);
    if (byteFree) available = parseInt(byteFree[1], 10);
    const byteTotal = msg.match(/(\d{6,})\s*bytes?\s*(?:total|capacity)/i);
    if (byteTotal) total = parseInt(byteTotal[1], 10);
    if (available > 0 || total > 0) return { available, total };

    // ── Format 4: labeled multi-line (SITE DF BSD-style)
    // e.g. "Filesystem  1K-blocks  Used  Available  Use%\n/dev/da0  976762584  123456  925384128  0%"
    // Look for a line that looks like df output with 4+ numbers
    for (const line of msg.split('\n')) {
      const cols = line.trim().split(/\s+/);
      // Typical df: filesystem, total_blocks, used_blocks, avail_blocks, pct
      if (cols.length >= 4) {
        const nums = cols.map(c => parseInt(c.replace('%',''), 10)).filter(n => !isNaN(n) && n > 0);
        if (nums.length >= 3) {
          // Heuristic: largest non-percentage number is total, second-largest is avail
          const big = nums.filter(n => n > 1000).sort((a,b) => b-a);
          if (big.length >= 2) {
            // Assume 1K blocks if numbers are in the range 100k–10B (typical for GB drives in 1K-blocks)
            const blockMultiplier = (big[0] > 1e8 && big[0] < 1e13) ? 1024 : 1;
            total     = big[0] * blockMultiplier;
            available = big[1] * blockMultiplier;
            if (total > available && total > 1024 * 1024) return { available, total };
          }
        }
      }
    }

    // ── Format 5: "X of Y" / "X/Y" pattern
    const ofPattern = msg.match(/(\d{6,})\s*(?:bytes?\s*)?(?:free\s*of|of|\/)\s*(\d{6,})/i);
    if (ofPattern) {
      return { available: parseInt(ofPattern[1], 10), total: parseInt(ofPattern[2], 10) };
    }

    // ── Format 6: any two large integers (last resort — total then avail or avail then total)
    const largeInts = [...msg.matchAll(/(\d{7,})/g)].map(m => parseInt(m[1], 10)).filter(n => n > 0);
    if (largeInts.length >= 2) {
      const sorted = largeInts.sort((a, b) => b - a);
      total     = sorted[0];
      available = sorted[1];
      // Sanity: available must be ≤ total, and total must be > 10MB
      if (available <= total && total > 10 * 1024 * 1024) return { available, total };
    }

    return { available: 0, total: 0 };
  }

  // ── Per-mount disk space probe ────────────────────────────────────────────
  // CRITICAL FIX: PS5 FTP daemons require CWD to be set FIRST. Sending
  // "SITE DF /mnt/usb0" doesn't work — you must `cd /mnt/usb0` then `SITE DF`.
  // All commands are sent bare (no path argument) after cd-ing to the mount.
  async function probeMountSpace(mountPath) {
    // Step 1: cd to the mount point
    try {
      await Promise.race([
        client.cd(mountPath),
        new Promise((_, r) => setTimeout(() => r(new Error('cd-timeout')), 3000))
      ]);
    } catch (_) {
      return { available: 0, total: 0, method: null };
    }

    // Step 2: try commands in order of reliability, all for CWD (no path arg)
    const candidates = [
      'AVBL',           // "Available bytes" — supported by some etaHEN/ftpsrv builds
      'XAVBL',          // Extended AVBL (older servers)
      'SITE DF',        // df-style output for CWD — most widely supported on PS5
      'SITE FREESPACE', // Some BSD ftpd variants
      'SITE DISKFREE',  // Alternative name
      'SITE STATVFS',   // statvfs(2) output — block-based
      'SITE FREE',      // Generic free space
      'SITE DISKINFO',  // Some custom implementations
      'XDISKFREE',      // Rare but present in some builds
      'STAT .',         // CWD status — some daemons embed fs info here
    ];

    for (const cmd of candidates) {
      const msg = await ftpSend(cmd, 2500);
      if (!msg) continue;
      const result = parseSpaceMsg(msg);
      if (result.available > 0 || result.total > 0) {
        return { ...result, method: cmd };
      }
    }

    // Step 3: Try MLST . (RFC 3659 MLST for current dir) — some servers include size facts
    try {
      const mlstMsg = await ftpSend('MLST .', 3000);
      if (mlstMsg) {
        const totalM = mlstMsg.match(/[Tt]otal-[Ss]ize=(\d+)/);
        const availM = mlstMsg.match(/[Aa]vail(?:able)?(?:-[Ss]ize)?=(\d+)/);
        if (totalM || availM) {
          return {
            available: availM ? parseInt(availM[1], 10) : 0,
            total:     totalM ? parseInt(totalM[1], 10) : 0,
            method: 'MLST',
          };
        }
      }
    } catch (_) {}

    return { available: 0, total: 0, method: null };
  }

  // ── Main ──────────────────────────────────────────────────────────────────
  try {
    await client.access({
      host:     config.host,
      port:     parseInt(config.port) || 2121,
      user:     config.user || 'anonymous',
      password: config.password || config.pass || '',
      secure:   false,
    });

    // ── Step 1: Try to read /proc/mounts for real filesystem device names ──
    // Some PS5 payloads expose /proc over FTP — if so, we get accurate mount info.
    let procMountsText = '';
    try { procMountsText = await ftpRetr('/proc/mounts', 32768, 3000); } catch (_) {}

    // Parse /proc/mounts: "device mountpoint fstype options 0 0"
    const mountDeviceMap = {}; // mountpoint → device
    if (procMountsText) {
      for (const line of procMountsText.split('\n')) {
        const [dev, mp] = line.trim().split(/\s+/);
        if (dev && mp && mp.startsWith('/')) mountDeviceMap[mp] = dev;
      }
    }

    // ── Step 2: Scan each mount point ─────────────────────────────────────
    const results = [];

    for (const mp of mounts) {
      // Check accessibility + count items
      let accessible = false;
      let itemCount  = 0;
      let subPath    = null;

      try {
        await Promise.race([
          client.cd(mp),
          new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 3000))
        ]);
        const rootList = await Promise.race([
          client.list(),
          new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 3000))
        ]);
        accessible = true;

        // Find game subfolder for display
        for (const sub of ['etaHEN/games', 'games', 'PS5', 'PS4']) {
          try {
            await Promise.race([
              client.cd(mp + '/' + sub),
              new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 2000))
            ]);
            const subList = await Promise.race([
              client.list(),
              new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 2000))
            ]);
            if (subList && subList.length) {
              itemCount = subList.length;
              subPath   = mp + '/' + sub;
              break;
            }
          } catch (_) {}
        }
        if (!itemCount && rootList) itemCount = rootList.length;
      } catch (_) {
        continue; // not accessible — skip silently
      }

      // ── Probe disk space ──────────────────────────────────────────────────
      // probeMountSpace cds to the mount first, then tries all known commands.
      const space = await probeMountSpace(mp);

      const gamesOnMount = gamesByMount[mp] || { totalSize: 0, count: 0 };

      // ── Hardware-spec fallback for /data (internal SSD) ───────────────────
      let isHardwareFallback = false;
      let hardwareTotal = 0, hardwareAvail = 0;
      if (!space.total && mp === '/data') {
        hardwareTotal    = PS5_INTERNAL_TOTAL;
        hardwareAvail    = gamesOnMount.totalSize > 0
          ? Math.max(0, PS5_INTERNAL_TOTAL - gamesOnMount.totalSize)
          : 0;
        isHardwareFallback = true;
      }

      results.push({
        path:              mp,
        device:            mountDeviceMap[mp] || null,
        subPath,
        itemCount,
        available:         space.available || hardwareAvail,
        total:             space.total     || hardwareTotal,
        usedByGames:       gamesOnMount.totalSize,
        gameCount:         gamesOnMount.count,
        isHardwareFallback,
        spaceMethod:       space.method,   // which command worked (for debugging)
        spaceKnown:        !!(space.available || space.total || hardwareTotal),
      });
    }

    return results;

  } catch (e) {
    return { error: e.message };
  } finally {
    try { client.close(); } catch (_) {}
  }
});


// ── Delete parent folder (post-move cleanup) ──────────────────────────────
// Called from the completion screen when a move finishes and the user wants
// to clean up the now-empty parent folder (e.g. C:\Games\Tekken 8 after
// moving C:\Games\Tekken 8\Tekken 8 to the PS5 drive).
// Returns: { status:'deleted' } | { status:'not_empty', count:N } | { status:'not_found' } | { error: str }
ipcMain.handle('delete-parent-folder', async (_event, folderPath) => {
  if (!folderPath || typeof folderPath !== 'string') return { error: 'Invalid path' };
  if (!path.isAbsolute(folderPath)) return { error: 'Path must be absolute' };

  // Returns true if a directory entry counts as real content (not system noise)
  function isSignificant(name) {
    if (!name) return false;
    if (name.startsWith('.')) return false;
    const low = name.toLowerCase();
    return low !== 'desktop.ini' && low !== 'thumbs.db' && low !== '$recycle.bin' && low !== '.ds_store';
  }

  // Check if a directory is functionally empty (only system files / hidden files)
  async function isFolderEmpty(dir) {
    try {
      const entries = await fs.promises.readdir(dir);
      return !entries.some(isSignificant);
    } catch (_) {
      return false; // can't read = not empty (safe)
    }
  }

  // Check if a directory contains a PS5 game (has sce_sys/param.json anywhere shallow)
  // This is a fast 2-level check — enough to detect games we haven't moved yet.
  async function containsGame(dir) {
    try {
      const topEntries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const ent of topEntries) {
        if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
        const sub = path.join(dir, ent.name);
        // Check for sce_sys at depth 1
        try {
          await fs.promises.access(path.join(sub, 'sce_sys', 'param.json'));
          return true; // found a game
        } catch (_) {}
        // Check for sce_sys at depth 2 (wrapper layout: Title/PPSA*/sce_sys)
        try {
          const inner = await fs.promises.readdir(sub, { withFileTypes: true });
          for (const ie of inner) {
            if (!ie.isDirectory()) continue;
            try {
              await fs.promises.access(path.join(sub, ie.name, 'sce_sys', 'param.json'));
              return true;
            } catch (_) {}
          }
        } catch (_) {}
      }
    } catch (_) {}
    return false;
  }

  // Walk UP from folderPath, deleting each level while it is empty.
  // Stops when:
  //   • a level has other content (files or non-empty subdirs)
  //   • a level contains another PS5 game (sce_sys check)
  //   • fewer than 2 path segments remain (never touch drive root or top-level)
  const startAbs = path.resolve(folderPath);
  const deleted  = [];   // paths we successfully removed
  let   blocker  = null; // first path that stopped us (and why)

  let cur = startAbs;
  while (true) {
    const segments = cur.split(path.sep).filter(Boolean);
    if (segments.length < 2) {
      // Reached drive root or top-level — stop here, don't delete
      break;
    }

    // Check existence
    try {
      await fs.promises.access(cur);
    } catch (_) {
      // Already gone — treat as deleted and move up
      deleted.push(cur);
      cur = path.dirname(cur);
      continue;
    }

    // Safety: never delete a folder that contains another PS5 game
    const hasGame = await containsGame(cur);
    if (hasGame) {
      blocker = { path: cur, reason: 'contains_game' };
      break;
    }

    // Check emptiness (ignoring system noise)
    const empty = await isFolderEmpty(cur);
    if (!empty) {
      // Get the blocking items for display
      try {
        const entries = await fs.promises.readdir(cur);
        const sig = entries.filter(isSignificant);
        blocker = { path: cur, reason: 'not_empty', count: sig.length, sample: sig.slice(0, 3) };
      } catch (_) {
        blocker = { path: cur, reason: 'not_empty', count: 1, sample: [] };
      }
      break;
    }

    // Empty — delete it and walk up
    try {
      await fs.promises.rm(toExtendedPath(cur), { recursive: true, force: true });
      console.log('[Cleanup] Deleted empty folder:', cur);
      deleted.push(cur);
    } catch (e) {
      return { error: e.message, deleted };
    }

    cur = path.dirname(cur);
  }

  if (deleted.length === 0 && !blocker) {
    return { status: 'not_found' };
  }

  return {
    status: deleted.length > 0 ? 'deleted' : 'not_empty',
    deleted,
    blocker: blocker || null,
  };
});

// ── Trash bin (soft delete) ───────────────────────────────────────────────────
// Moves a game folder to <parent>/_ps5vault_trash/<name>_<timestamp>
// instead of permanently deleting. Trash is auto-purged on next trash call
// for entries older than 30 days.
ipcMain.handle('trash-item', async (_event, item) => {
  const p = item.ppsaFolderPath || item.folderPath;
  if (!p || !path.isAbsolute(p)) throw new Error('Invalid path for trash');
  const trashDir = path.join(path.dirname(p), '_ps5vault_trash');
  await fs.promises.mkdir(trashDir, { recursive: true });
  const dest = path.join(trashDir, path.basename(p) + '_' + Date.now());
  await fs.promises.rename(p, dest);
  // Auto-purge entries older than 30 days
  try {
    const entries = await fs.promises.readdir(trashDir, { withFileTypes: true });
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const ent of entries) {
      const ts = parseInt((ent.name.match(/_(\d{13})$/) || [])[1] || '0', 10);
      if (ts > 0 && ts < cutoff) {
        await fs.promises.rm(path.join(trashDir, ent.name), { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch (_) {}
  return { success: true, trashPath: dest };
});

// ── Verify Library ────────────────────────────────────────────────────────────
// Checks each game in items for:
//   ok     — folder accessible + param.json present + icon present
//   warn   — folder accessible, param.json present, no icon
//   error  — folder not accessible or param.json missing
ipcMain.handle('verify-library', async (event, items, ftpConfig) => {
  const results = [];
  if (ftpConfig) {
    // FTP verify — connect once, check each game path
    const client = new ftp.Client(10000);
    client.ftp.verbose = false;
    applyFtpPassive(client, ftpConfig);
    try {
      await client.access({ host: ftpConfig.host, port: parseInt(ftpConfig.port) || 2121, user: ftpConfig.user || 'anonymous', password: ftpConfig.pass || '', secure: false });
      for (const item of items) {
        const gamePath = item.ppsaFolderPath || item.folderPath;
        let status = 'ok', detail = '';
        try {
          // PS5 FTP payloads (etaHEN/ftpsrv) don't support LIST with a path argument —
          // always cd first, then list with no args (same pattern as the scanner).
          await Promise.race([client.cd(gamePath), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000))]);
          const list = await Promise.race([client.list(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000))]);
          const hasSceSys = (list || []).some(e => e.name === 'sce_sys' && !e.isFile);
          if (!hasSceSys) { status = 'warn'; detail = 'No sce_sys folder'; }
        } catch (e) { status = 'error'; detail = e.message; }
        results.push({ ppsa: item.ppsa, title: item.displayTitle || item.folderName, path: gamePath, status, detail });
      }
    } catch (e) {
      return items.map(item => ({ ppsa: item.ppsa, title: item.displayTitle || item.folderName, path: item.ppsaFolderPath || item.folderPath, status: 'error', detail: 'FTP connect failed: ' + e.message }));
    } finally {
      try { client.close(); } catch (_) {}
    }
  } else {
    for (const item of items) {
      const gamePath = item.ppsaFolderPath || item.folderPath;
      let status = 'ok', detail = '';
      try {
        await fs.promises.access(gamePath, fs.constants.R_OK);
        const paramPath = path.join(gamePath, 'sce_sys', 'param.json');
        try {
          await fs.promises.access(paramPath, fs.constants.F_OK);
        } catch (_) {
          // Try direct param.json fallback
          try {
            await fs.promises.access(path.join(gamePath, 'param.json'), fs.constants.F_OK);
          } catch (_) {
            status = 'warn'; detail = 'param.json not found';
          }
        }
        // Check icon
        if (status === 'ok') {
          const iconPath = path.join(gamePath, 'sce_sys', 'icon0.png');
          try { await fs.promises.access(iconPath, fs.constants.F_OK); }
          catch (_) { status = 'warn'; detail = 'icon0.png not found'; }
        }
        // Quick size sanity check
        if (item.totalSize > 0) {
          try {
            const st = await fs.promises.stat(gamePath);
            if (!st.isDirectory()) { status = 'error'; detail = 'Not a directory'; }
          } catch (e) { status = 'error'; detail = e.message; }
        }
        // Check for empty folder
        if (status === 'ok' || status === 'warn') {
          try {
            const topEntries = await fs.promises.readdir(gamePath);
            if (topEntries.length === 0) {
              status = 'error'; detail = 'Empty game folder';
            } else {
              // Check for zero-byte files (recursive, up to MAX_FILES_TO_CHECK_FOR_CORRUPTION)
              let fileCount = 0;
              let hasZeroByte = false;
              async function scanForZeroBytesRecursively(dir) {
                if (fileCount >= MAX_FILES_TO_CHECK_FOR_CORRUPTION || hasZeroByte) return;
                const ents = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
                for (const ent of ents) {
                  if (fileCount >= MAX_FILES_TO_CHECK_FOR_CORRUPTION || hasZeroByte) break;
                  const full = path.join(dir, ent.name);
                  if (ent.isFile()) {
                    fileCount++;
                    const st = await fs.promises.stat(full).catch(() => null);
                    if (st && st.size === 0) { hasZeroByte = true; }
                  } else if (ent.isDirectory()) {
                    await scanForZeroBytesRecursively(full);
                  }
                }
              }
              await scanForZeroBytesRecursively(gamePath);
              if (hasZeroByte) {
                status = 'warn'; detail = 'Contains zero-byte file(s) - possible corrupt/partial copy';
              }
            }
          } catch (_) {}
        }
      } catch (e) { status = 'error'; detail = e.message; }
      results.push({ ppsa: item.ppsa, title: item.displayTitle || item.folderName, path: gamePath, status, detail });
    }
  }
  return results;
});

// ── Local free space ──────────────────────────────────────────────────────────
ipcMain.handle('get-local-free-space', async (_event, dirPath) => {
  if (!dirPath || typeof dirPath !== 'string' || dirPath.startsWith('ftp://')) {
    throw new Error('Invalid path');
  }
  return getLocalFreeSpace(dirPath);
});

// ── List Game Sub-folders ─────────────────────────────────────────────────────
// Returns top-level children of a game folder so the user can pick
// which sub-folders to include in a selective transfer.
ipcMain.handle('list-game-subfolders', async (_event, gamePath, ftpCfg) => {
  if (ftpCfg) {
    const client = new ftp.Client(8000);
    client.ftp.verbose = false;
    applyFtpPassive(client, ftpCfg);
    try {
      await client.access({ host: ftpCfg.host, port: parseInt(ftpCfg.port)  || 2121, user: ftpCfg.user || 'anonymous', password: ftpCfg.pass || '', secure: false });
      await client.cd(gamePath);
      const list = await client.list();
      return (list || []).map(e => ({ name: e.name, isDirectory: !e.isFile, size: Number(e.size) || 0 }));
    } catch (e) {
      return [];
    } finally {
      try { client.close(); } catch (_) {}
    }
  } else {
    try {
      const entries = await fs.promises.readdir(gamePath, { withFileTypes: true });
      const out = [];
      for (const ent of entries) {
        const full = path.join(gamePath, ent.name);
        let size = 0;
        const isDir = ent.isDirectory() || ent.isSymbolicLink();
        if (!isDir) {
          try { size = (await fs.promises.stat(full)).size; } catch (_) {}
        } else {
          // Use cached size if available
          size = localSizeCache.get(full) || 0;
        }
        out.push({ name: ent.name, isDirectory: isDir, size });
      }
      return out;
    } catch (e) {
      return [];
    }
  }
});

// ── Checksum database ─────────────────────────────────────────────────────────
// Persists SHA-256 hashes of transferred files so repeat transfers can skip
// files that are already identical at the destination.
const CHECKSUM_DB_VERSION = 1;
let checksumDb = {}; // { [filePath_hash]: { hash, size, cachedAt } }
let checksumSaveTimer = null;

function getChecksumDbPath() {
  try { return path.join(app.getPath('userData'), 'checksum-db.json'); }
  catch (_) { return path.join(os.homedir(), '.ps5vault-checksums.json'); }
}

function loadChecksumDb() {
  try {
    const raw = fs.readFileSync(getChecksumDbPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version === CHECKSUM_DB_VERSION && typeof parsed.entries === 'object') {
      checksumDb = parsed.entries || {};
      console.log('[Checksum DB] Loaded', Object.keys(checksumDb).length, 'entries');
    }
  } catch (_) { checksumDb = {}; }
}

function scheduleChecksumSave() {
  if (checksumSaveTimer) return;
  checksumSaveTimer = setTimeout(() => {
    checksumSaveTimer = null;
    try {
      // Prune entries older than 90 days
      const now = Date.now(); const cutoff = 90 * 24 * 60 * 60 * 1000;
      for (const k of Object.keys(checksumDb)) {
        if (now - (checksumDb[k].cachedAt || 0) > cutoff) delete checksumDb[k];
      }
      fs.writeFileSync(getChecksumDbPath(), JSON.stringify({ version: CHECKSUM_DB_VERSION, entries: checksumDb }, null, 2), 'utf8');
    } catch (e) { console.warn('[Checksum DB] Save failed:', e.message); }
  }, 3000);
}

ipcMain.handle('get-checksum-db', async () => {
  return { entries: checksumDb, count: Object.keys(checksumDb).length };
});

ipcMain.handle('record-transfer-checksums', async (_event, entries) => {
  if (!Array.isArray(entries)) return { ok: false };
  const now = Date.now();
  for (const { key, hash, size } of entries) {
    if (key && hash) checksumDb[key] = { hash, size: size || 0, cachedAt: now };
  }
  scheduleChecksumSave();
  return { ok: true, total: Object.keys(checksumDb).length };
});

// App bootstrap (unchanged)
let mainWindow;
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
  loadFtpSizeCacheFromDisk(); loadLocalSizeCacheFromDisk(); loadChecksumDb(); createWindow();
  // Silently check for updates 5 s after launch — delay avoids blocking startup I/O
  setTimeout(() => { if (mainWindow) checkForUpdates(mainWindow); }, 5000);

  // ── Start local developer API server ──────────────────────────────────────
  // Creates http://127.0.0.1:3731/api/v1 with API key auth.
  // The API key is auto-generated on first run and saved to userData.
  try {
    const apiKeyPath = path.join(app.getPath('userData'), 'ps5vault-api-key.json');

    // Fake sender used when API-triggered scans need IPC-like progress events
    const apiSender = {
      id:          -9999,
      isDestroyed: () => false,
      send:        (channel, data) => {
        if (channel === 'scan-progress') {
          apiServer.broadcast('scan-progress', data);
          // Mirror library updates back into apiLibrary
          if (data && data.type === 'game-found' && data.item) {
            if (!apiLibrary.some(g =>
              (g.folderPath || g.ppsaFolderPath) === (data.item.folderPath || data.item.ppsaFolderPath)
            )) {
              apiLibrary.push(data.item);
              apiScanProgress.found = apiLibrary.length;
            }
          }
          if (data && data.type === 'size-update') {
            const g = apiLibrary.find(x =>
              (x.folderPath === data.folderPath || x.ppsaFolderPath === data.folderPath) ||
              (data.contentId && x.contentId === data.contentId)
            );
            if (g) g.totalSize = data.totalSize;
            apiScanProgress.sized = (apiScanProgress.sized || 0) + 1;
            apiServer.broadcast('size-update', data);
          }
        }
      },
    };

    apiServer.start({
      keyPath: apiKeyPath,
      state: {
        getVersion:      () => VERSION,
        getLibrary:      () => apiLibrary,
        getScanStatus:   () => ({ active: apiScanActive, source: apiScanSource, progress: { ...apiScanProgress } }),
        getTransferStatus: () => ({ active: apiTransferActive, progress: { ...apiTransferProg } }),
        triggerScan: async (source) => {
          if (apiScanActive) throw new Error('Scan already running');
          apiScanActive   = true;
          apiScanSource   = source;
          apiLibrary      = [];
          apiScanProgress = { found: 0, sized: 0, total: 0 };
          apiServer.broadcast('scan-start', { source });
          try {
            let items;
            if (source.startsWith('ftp://') || /^\d+\.\d+\.\d+\.\d+/.test(source)) {
              const ftpSrc = source.startsWith('ftp://') ? source : 'ftp://' + source;
              items = await scanFtpSource(ftpSrc, { sender: apiSender, calcSize: true });
              apiLibrary = Array.isArray(items) ? items : [];
            } else {
              items = await findContentFoldersByTopLevelWithProgress(source === 'all-drives' ? 'C:\\' : source, apiSender);
              apiLibrary = Array.isArray(items) ? items : [];
            }
            apiServer.broadcast('scan-complete', { count: apiLibrary.length });
            return apiLibrary;
          } finally {
            apiScanActive = false;
          }
        },
        triggerTransfer: async (opts) => {
          if (apiTransferActive) throw new Error('Transfer already running');
          apiTransferActive = true;
          apiTransferProg   = {};
          apiServer.broadcast('transfer-start', { itemCount: opts.items?.length || 0 });
          // Create a minimal fake event for doEnsureAndPopulate
          const fakeSender = {
            id:          -9998,
            isDestroyed: () => false,
            send:        (channel, data) => {
              if (channel === 'scan-progress') {
                apiServer.broadcast('transfer-progress', data);
                apiTransferProg = data;
              }
            },
          };
          const fakeEvent = { sender: fakeSender };
          try {
            const result = await doEnsureAndPopulate(fakeEvent, opts);
            apiServer.broadcast('transfer-complete', { success: true });
            return result;
          } finally {
            apiTransferActive = false;
            apiTransferProg   = {};
          }
        },
      },
    });
  } catch (e) {
    console.error('[API] Failed to start API server:', e.message);
  }
  });
}
app.on('window-all-closed', () => { app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

function createWindow() {
  try {
    // Use the right icon format per platform
    const iconExt  = process.platform === 'darwin' ? 'icon.icns'
                   : process.platform === 'linux'   ? 'icon.png'
                   :                                  'icon.ico';

    mainWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      resizable: true,
      autoHideMenuBar: true,
      show: false,  // hidden until ready-to-show prevents white-flash on maximize
      icon: path.join(__dirname, 'assets', iconExt),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    // Maximize before show so the window is already full-size when it appears
    mainWindow.maximize();
    mainWindow.once('ready-to-show', () => mainWindow.show());

    mainWindow.webContents.on('did-finish-load', () => {
      console.log('[main] UI loaded');
      mainWindow.webContents.send('app-version', VERSION);
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error('[main] did-fail-load', code, desc, url);
    });

    mainWindow.loadFile('index.html').catch((e) => {
      console.error('[main] loadFile error:', e);
    });
  } catch (e) {
    console.error('[main] createWindow error', e);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTO-UPDATER
// ═══════════════════════════════════════════════════════════════════════════
// Uses GitHub Releases as the update server — no extra packages, no signing
// requirements, works with portable .exe builds.
//
// SETUP (one-time):
//   1. Push your code to a GitHub repo
//   2. Create a release tagged v2.0.1 (or whatever the new version is)
//   3. Attach the built PS5-Vault-x.x.x-portable.exe as a release asset
//   4. Change GITHUB_REPO below to your "owner/repo" value
//
// HOW IT WORKS:
//   • On startup, quietly calls the GitHub releases API
//   • If a newer version exists, sends 'update-available' to the renderer
//   • Renderer shows a small banner; user clicks "Update Now"
//   • Renderer calls 'download-and-install-update'
//   • main.js downloads the new .exe to %TEMP%, writes a tiny .bat that
//     waits 2 s then overwrites the running .exe and relaunches it
//   • App calls app.quit() — the batch script takes over
// ═══════════════════════════════════════════════════════════════════════════

const GITHUB_REPO = 'NookieAI/PS5-Vault'; // ← change to your repo

async function checkForUpdates(win) {
  try {
    const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    const data   = await httpsGetJson(apiUrl);
    if (!data || !data.tag_name) return;

    const latest  = data.tag_name.replace(/^v/i, '');
    const current = VERSION;

    if (!isNewerVersion(latest, current)) {
      console.log(`[updater] Up to date (v${current})`);
      return;
    }

    // Find the correct asset for the current platform
    const assets = data.assets || [];
    let platformAsset;
    if (process.platform === 'darwin') {
      platformAsset = assets.find(a => /\.dmg$/i.test(a.name));
    } else if (process.platform === 'linux') {
      platformAsset = assets.find(a => /\.AppImage$/i.test(a.name));
    } else {
      // Windows — prefer portable build, fall back to any exe
      platformAsset = assets.find(a => /portable.*\.exe$/i.test(a.name))
                   || assets.find(a => /\.exe$/i.test(a.name));
    }

    if (!platformAsset) {
      console.warn(`[updater] No asset found for platform "${process.platform}" in release v${latest}`);
      return;
    }

    console.log(`[updater] Update available: v${current} → v${latest}`);
    win.webContents.send('update-available', {
      currentVersion: current,
      latestVersion:  latest,
      downloadUrl:    platformAsset.browser_download_url,
      releaseNotes:   data.body || '',
      releaseName:    data.name  || `v${latest}`
    });
  } catch (e) {
    // Silent — update check should never crash the app
    console.warn('[updater] Check failed:', e.message);
  }
}

function httpsGetJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? require('https') : require('http');
    mod.get(url, {
      headers: {
        'User-Agent': `PS5-Vault/${VERSION}`,
        'Accept':     'application/vnd.github+json'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGetJson(res.headers.location, redirects + 1));
      }
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

function httpsDownloadFile(url, destPath, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? require('https') : require('http');
    mod.get(url, { headers: { 'User-Agent': `PS5-Vault/${VERSION}` } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsDownloadFile(res.headers.location, destPath, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const total   = parseInt(res.headers['content-length'] || '0', 10);
      let received  = 0;
      const ws      = require('fs').createWriteStream(destPath);
      res.on('data', chunk => {
        received += chunk.length;
        ws.write(chunk);
        if (total > 0) onProgress?.(received, total);
      });
      res.on('end', () => ws.end());
      ws.on('finish', resolve);
      ws.on('error',  reject);
      res.on('error', (e) => { ws.destroy(); reject(e); });
    }).on('error', reject);
  });
}

function isNewerVersion(latest, current) {
  const parse = v => String(v).replace(/^v/i,'').split('.').map(n => parseInt(n,10) || 0);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

ipcMain.handle('download-and-install-update', async (event, downloadUrl) => {
  const os   = require('os');
  const fsMod = require('fs');
  const { spawn } = require('child_process');

  const isWin   = process.platform === 'win32';
  const isMac   = process.platform === 'darwin';
  const fileExt = isWin ? '.exe' : isMac ? '.dmg' : '.AppImage';
  const tmpFile = path.join(os.tmpdir(), `ps5vault-update${fileExt}`);

  // Windows portable: PORTABLE_EXECUTABLE_FILE is the original .exe the user ran.
  // process.execPath points to the unpacked copy inside %LOCALAPPDATA%.
  const currentExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;

  try {
    // Download the release asset with progress reporting
    await httpsDownloadFile(downloadUrl, tmpFile, (received, total) => {
      const pct = Math.round((received / total) * 100);
      event.sender.send('update-download-progress', { pct, received, total });
    });

    if (isWin) {
      // Batch script: waits for the app to exit, overwrites the exe, relaunches
      const tmpBat = path.join(os.tmpdir(), 'ps5vault-updater.bat');
      const bat = [
        '@echo off',
        'timeout /t 2 /nobreak >nul',
        ':retry',
        `copy /y "${tmpFile}" "${currentExe}" >nul 2>&1`,
        'if errorlevel 1 (',
        '  timeout /t 1 /nobreak >nul',
        '  goto retry',
        ')',
        `start "" "${currentExe}"`,
        `del "${tmpFile}"`,
        'del "%~f0"',
      ].join('\r\n');
      fsMod.writeFileSync(tmpBat, bat, 'utf8');
      const child = spawn('cmd.exe', ['/c', tmpBat], {
        detached: true, stdio: 'ignore', windowsHide: true
      });
      child.unref();

    } else if (isMac) {
      // Open the .dmg so the user can drag-install (can't replace a running app)
      spawn('open', [tmpFile], { detached: true, stdio: 'ignore' }).unref();

    } else {
      // Linux: make AppImage executable and open its folder for the user
      fsMod.chmodSync(tmpFile, 0o755);
      spawn('xdg-open', [path.dirname(tmpFile)], { detached: true, stdio: 'ignore' }).unref();
    }

    // Brief delay so the IPC reply can reach the renderer before we quit
    setTimeout(() => app.quit(), 600);
    return { ok: true };

  } catch (e) {
    console.error('[updater] Download/install failed:', e.message);
    try { fsMod.unlinkSync(tmpFile); } catch (_) {}
    throw new Error('Update failed: ' + e.message);
  }
});

ipcMain.handle('check-for-updates-manual', async (event) => {
  // Manual check (from menu) — returns the update info or null
  try {
    const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    const data   = await httpsGetJson(apiUrl);
    if (!data || !data.tag_name) return null;
    const latest = data.tag_name.replace(/^v/i, '');
    if (!isNewerVersion(latest, VERSION)) return { upToDate: true, version: VERSION };
    const assets = data.assets || [];
    let platformAsset;
    if (process.platform === 'darwin') {
      platformAsset = assets.find(a => /\.dmg$/i.test(a.name));
    } else if (process.platform === 'linux') {
      platformAsset = assets.find(a => /\.AppImage$/i.test(a.name));
    } else {
      platformAsset = assets.find(a => /portable.*\.exe$/i.test(a.name))
                   || assets.find(a => /\.exe$/i.test(a.name));
    }
    return {
      upToDate:       false,
      currentVersion: VERSION,
      latestVersion:  latest,
      downloadUrl:    platformAsset?.browser_download_url || null,
      releaseName:    data.name || `v${latest}`,
      releaseNotes:   data.body || ''
    };
  } catch (e) {
    throw new Error('Update check failed: ' + e.message);
  }
});
