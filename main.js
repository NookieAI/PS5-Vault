const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Add FTP support
const ftp = require('basic-ftp');

const MAX_SCAN_DEPTH = 12;
const SCAN_CONCURRENCY = 24; // Reduced to 24 for better system stability
const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024 * 1024; // 200GB limit for sanity
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 100;

console.log('[main] Starting PS5 Vault');

// Extra guard to avoid silent crashes
process.on('uncaughtException', (err) => {
  console.error('[main] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[main] Unhandled rejection:', err);
  process.exit(1);
});

// State
const activeCancelFlags = new Map();

/**
 * Checks if a directory name should be skipped during scanning.
 * @param {string} name - Directory name.
 * @returns {boolean} Whether to skip.
 */
function isSkippableDir(name) {
  if (!name) return false;
  const n = String(name).toLowerCase();
  if (n.startsWith('.')) return true;
  return ['node_modules', '.git', 'snapshots', 'system volume information',
          '$recycle.bin', 'recycle.bin', 'recycle', 'trash', 'tmp', 'temp',
          'windows', 'program files', 'program files (x86)', 'programdata'].includes(n);
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
 * Finds all param.json files in a directory.
 * @param {string} startDir - Starting directory.
 * @param {number} maxDepth - Maximum depth.
 * @param {AbortSignal} [signal] - Abort signal.
 * @returns {Promise<string[]>} Array of param.json paths.
 */
async function findAllParamJsons(startDir, maxDepth = MAX_SCAN_DEPTH, signal) {
  const out = [];
  const queue = [{ dir: startDir, depth: 0 }];
  while (queue.length && !signal?.aborted) {
    const batch = queue.splice(0, SCAN_CONCURRENCY);
    const promises = batch.map(async ({ dir, depth }) => {
      if (signal?.aborted) return;
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const ent of entries) {
          if (ent.isFile() && /^param\.json$/i.test(ent.name)) {
            out.push(path.join(dir, ent.name));
          } else if (ent.isDirectory() && !isSkippableDir(ent.name) && depth < maxDepth) {
            queue.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
          }
        }
      } catch (_) {}
    });
    await Promise.allSettled(promises);
  }
  return out;
}

/**
 * Finds param.json in a PPSA directory.
 * @param {string} ppsaDir - PPSA directory.
 * @param {number} maxDepth - Maximum levels.
 * @returns {Promise<string|null>} Path to param.json or null.
 */
async function findParamJsonInPpsa(ppsaDir, maxDepth = 2) {
  const direct = path.join(ppsaDir, 'sce_sys', 'param.json');
  try { await fs.promises.access(direct); return direct; } catch (_) {}
  async function search(dir, depth) {
    if (depth > maxDepth) return null;
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isFile() && /^param\.json$/i.test(ent.name)) return path.join(dir, ent.name);
        if (ent.isDirectory() && !isSkippableDir(ent.name)) {
          const found = await search(path.join(dir, ent.name), depth + 1);
          if (found) return found;
        }
      }
    } catch (_) {}
    return null;
  }
  return await search(ppsaDir, 0);
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

/**
 * Gets canonical PPSA directory.
 * @param {string} candidatePath - Candidate path.
 * @param {number} maxLevels - Maximum levels.
 * @returns {string|null} Canonical PPSA path or null.
 */
function getCanonicalPpsaDir(candidatePath, maxLevels = 8) {
  if (!candidatePath) return null;
  let cur = path.resolve(candidatePath);
  try {
    const st = fs.statSync(cur);
    if (st.isFile()) cur = path.dirname(cur);
  } catch (_) {}
  let levels = 0;
  const ppsaRegex = /^PPSA\d{4,6}(?:[-_].+)?$/i;
  while (cur && levels <= maxLevels) {
    const base = path.basename(cur);
    if (ppsaRegex.test(base)) return cur;
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
    levels++;
  }
  return null;
}

// Icon helpers
async function findIconInPpsaSce(ppsaDir) {
  if (!ppsaDir) return null;
  const sce = path.join(ppsaDir, 'sce_sys');
  const candidates = ['icon0.png','icon0.jpg','icon0.jpeg','icon.png','cover.png','cover.jpg','tile0.png'];
  for (const c of candidates) {
    const p = path.join(sce, c);
    try { await fs.promises.access(p); return p; } catch (_) {}
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

// Cleanup empty PPSA subfolders
async function removeEmptyPpsaSubfolders(dir) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const rx = /^PPSA\d{4,6}.*$/i;
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (!rx.test(ent.name)) continue;
      const full = path.join(dir, ent.name);
      const sub = await fs.promises.readdir(full, { withFileTypes: true }).catch(()=>[]);
      if (sub.length === 0) {
        await fs.promises.rmdir(full).catch(()=>null);
      }
    }
  } catch (_) {}
}

// Scan
async function findContentFoldersByTopLevelWithProgress(startDir, sender) {
  const controller = new AbortController();
  activeCancelFlags.set(sender.id, () => controller.abort());

  const results = [];
  const seen = new Set();
  const paramFiles = await findAllParamJsons(startDir, MAX_SCAN_DEPTH, controller.signal);

  let progressCounter = 0;
  const totalItems = paramFiles.length;

  for (let i = 0; i < paramFiles.length; i++) {
    if (controller.signal.aborted) break;
    const paramPath = paramFiles[i];
    const paramDir = path.dirname(paramPath);
    const parsed = await readJsonSafe(paramPath);
    if (!parsed) continue;

    // Determine game folder: if param.json is in sce_sys, use parent of sce_sys
    let folderPath;
    if (path.basename(paramDir).toLowerCase() === 'sce_sys') {
      folderPath = path.dirname(paramDir);
    } else {
      // Fallback: walk up to find sce_sys ancestor
      let cur = paramDir;
      let found = false;
      for (let lvl = 0; lvl < 5 && cur !== path.dirname(cur); lvl++) {  // Limit to 5 levels up
        if (path.basename(cur).toLowerCase() === 'sce_sys') {
          folderPath = path.dirname(cur);
          found = true;
          break;
        }
        cur = path.dirname(cur);
      }
      if (!found) continue;  // Skip if no sce_sys found
    }

    const normalizedFolder = path.resolve(folderPath);
    const ppsaFromCid = extractPpsaKey(parsed.contentId) || extractPpsaKey(JSON.stringify(parsed));
    const seenKey = `${ppsaFromCid || ''}|${normalizedFolder}|${parsed?.contentVersion || ''}`;
    if (seen.has(seenKey)) continue;

    let iconPath = null;
    try {
      const inSce = path.join(folderPath, 'sce_sys', 'icon0.png');
      await fs.promises.access(inSce);
      iconPath = inSce;
    } catch (_) {
      iconPath = await findAnyIconNearby(folderPath, 2);
    }

    // Calculate total size
    let totalSize = 0;
    try {
      const srcFiles = await listAllFilesWithStats(folderPath);
      totalSize = srcFiles.reduce((sum, f) => sum + f.size, 0);
    } catch (e) {
      console.error('[Local] Error calculating size for:', folderPath, e);
      totalSize = 0;
    }

    const rec = {
      ppsa: ppsaFromCid || null,
      ppsaFolderPath: folderPath,
      contentFolderPath: paramDir,
      folderPath: folderPath,
      folderName: path.basename(folderPath),
      paramPath,
      contentId: parsed.contentId || null,
      skuFromParam: (() => { try { const m = JSON.stringify(parsed).match(/[A-Za-z0-9\-]{6,}/); return m ? normalizeSku(m[0]) : null; } catch (_) { return null; } })(),
      iconPath,
      dbPresent: false,
      dbTitle: null,
      displayTitle: parsed.localizedParameters?.[parsed.localizedParameters?.defaultLanguage]?.titleName || parsed.titleName,
      region: parsed.defaultLanguage || (parsed.localizedParameters?.defaultLanguage) || '',
      verified: false,
      contentVersion: parsed.contentVersion || null,
      sdkVersion: parsed.sdkVersion || null,
      totalSize,
      titleId: parsed.titleId,
      version: parsed.masterVersion,
      fwSku: parsed.requiredSystemSoftwareVersion
    };
    results.push(rec);
    seen.add(seenKey);

    progressCounter++;
    if (progressCounter % 10 === 0 || i === paramFiles.length - 1) {
      try { sender?.send('scan-progress', { type: 'scan', index: progressCounter, total: totalItems, folder: folderPath, ppsa: rec.ppsa }); } catch (_) {}
    }
  }

  activeCancelFlags.delete(sender.id);
  return results;
}

// FTP scan (new addition, does not affect local)
async function scanFtpSource(ftpUrl) {
  let url;
  try {
    url = new URL(ftpUrl);
  } catch (e) {
    throw new Error('Invalid FTP URL: ' + ftpUrl);
  }
  const host = url.hostname;
  const port = url.port || 1337;
  const user = url.username || 'anonymous';
  const pass = url.password || '';
  let remotePath = url.pathname || '/';

  // Auto-detect USB games path if root is scanned
  if (remotePath === '/' || remotePath === '') {
    console.log('[FTP] Scanning root, looking for USB games path...');
    const client = new ftp.Client();
    try {
      await client.access({ host, port: parseInt(port), user, password: pass, secure: false });
      remotePath = await findUsbGamesPath(client);
    } finally {
      client.close();
    }
  }

  console.log('[FTP] Connecting to:', { host, port, user, pass: pass ? '***' : 'none' });
  const client = new ftp.Client();
  try {
    await client.access({ host, port: parseInt(port), user, password: pass, secure: false });
    console.log('[FTP] Connected successfully');
    const items = [];
    console.log('[FTP] Starting recursive scan from:', remotePath);
    await scanFtpRecursive(client, remotePath, items, 0);
    console.log('[FTP] Scan complete, found items:', items.length);
    return items;
  } catch (e) {
    console.error('[FTP] Connection or scan error:', e);
    throw e;
  } finally {
    try {
      client.close();
      console.log('[FTP] Connection closed');
    } catch (_) {}
  }
}

async function findUsbGamesPath(client) {
  // Check common USB paths
  const candidates = ['/mnt/usb0/etaHEN/games', '/mnt/usb1/etaHEN/games', '/mnt/ps5/etaHEN/games'];
  for (const cand of candidates) {
    try {
      const list = await client.list(cand);
      if (list.some(item => item.isDirectory)) {
        console.log('[FTP] Found games path:', cand);
        return cand;
      }
    } catch (_) {}
  }
  return '/'; // Fallback
}

async function scanFtpRecursive(client, remotePath, items, depth) {
  if (depth > MAX_SCAN_DEPTH) return;
  if (remotePath.includes('/sce_sys/')) return;
  try {
    console.log('[FTP] Listing directory:', remotePath);
    const list = await client.list(remotePath);
    console.log('[FTP] Found', list.length, 'items in', remotePath);

    // Check for param.json
    if (!remotePath.includes('/sce_sys/')) {
      const paramPath = path.posix.join(remotePath, 'sce_sys', 'param.json');
      const tempFile = path.join(require('os').tmpdir(), 'param_' + Date.now() + '_' + Math.random() + '.json');
      let cover = '';
      try {
        console.log('[FTP] Checking for param.json in:', remotePath);
        await client.downloadTo(tempFile, paramPath);
        const paramStr = await fs.promises.readFile(tempFile, 'utf8');
        const data = JSON.parse(paramStr);
        console.log('[FTP] Parsed param.json data:', data);
        const ppsaKey = extractPpsaKey(data.titleId || data.contentId || '');
        const sku = normalizeSku(data.localizedParameters?.en?.['@SKU'] || '');
        const title = getTitleFromParam(data, null);
        const folder = path.posix.basename(remotePath);
        const size = 0; // No size calc for FTP
        // Fetch cover
        const coverPath = path.posix.join(remotePath, 'sce_sys', 'icon0.png');
        const coverTempFile = path.join(require('os').tmpdir(), 'cover_' + Date.now() + '_' + Math.random() + '.png');
        try {
          await client.downloadTo(coverTempFile, coverPath);
          const coverBuffer = await fs.promises.readFile(coverTempFile);
          cover = 'data:image/png;base64,' + coverBuffer.toString('base64');
          console.log('[FTP] Fetched cover for:', title);
        } catch (e) {
          console.log('[FTP] No cover for:', title, e.message);
        } finally {
          try { fs.unlinkSync(coverTempFile); } catch (_) {}
        }
        items.push({
          ppsa: ppsaKey,
          ppsaFolderPath: remotePath,
          contentFolderPath: path.posix.join(remotePath, 'sce_sys'),
          folderPath: remotePath,
          folderName: folder,
          contentId: data.contentId,
          skuFromParam: sku,
          displayTitle: title,
          region: data.defaultLanguage || (data.localizedParameters?.defaultLanguage) || '',
          contentVersion: data.masterVersion,
          sdkVersion: data.sdkVersion,
          totalSize: size,
          iconPath: cover // Base64
        });
        console.log('[FTP] Found game:', title, 'in', folder);
      } catch (e) {
        console.log('[FTP] No param.json in', remotePath, e.message);
      } finally {
        try { fs.unlinkSync(tempFile); } catch (_) {}
      }
    }

    // Check if this is a game dir (has sce_sys), if so, don't recurse
    const hasSceSys = list.some(item => item.isDirectory && item.name === 'sce_sys');
    if (hasSceSys) {
      console.log('[FTP] Skipping recursion for game dir:', remotePath);
      return;
    }

    // Recurse into subdirs only if not a game dir
    for (const item of list) {
      if (item.isDirectory) {
        const subPath = path.posix.join(remotePath, item.name);
        try {
          await scanFtpRecursive(client, subPath, items, depth + 1);
        } catch (e) {
          console.error('[FTP] Error recursing into:', subPath, e);
        }
      }
    }
  } catch (e) {
    console.error('[FTP] Error listing or recursing:', remotePath, e);
  }
}

// FS + transfer helpers (optimized)
async function listAllFilesWithStats(rootDir, signal) {
  const files = [];
  const queue = [{ dir: rootDir, rel: '' }];
  while (queue.length && !signal?.aborted) {
    const { dir, rel } = queue.shift();
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        const r = path.join(rel, ent.name);
        if (ent.isFile()) {
          try {
            const st = await fs.promises.stat(full);
            if (st.size <= MAX_FILE_SIZE_BYTES) files.push({ fullPath: full, relPath: r, size: st.size });
          } catch (_) {}
        } else if (ent.isDirectory() && !isSkippableDir(ent.name)) {
          queue.push({ dir: full, rel: r });
        }
      }
    } catch (_) {}
  }
  return files;
}

async function hashFile(filePath, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(filePath);
    rs.on('error', reject);
    rs.on('data', chunk => { if (signal?.aborted) { rs.destroy(); reject(new Error('Aborted')); } else hash.update(chunk); });
    rs.on('end', () => resolve(hash.digest('hex')));
  });
}

async function copyFileStream(src, dst, progressCallback, cancelCheck) {
  await fs.promises.mkdir(path.dirname(dst), { recursive: true });
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dst);
    rs.on('data', (chunk) => { if (cancelCheck()) { rs.destroy(); ws.destroy(); reject(new Error('Cancelled')); } else progressCallback?.(chunk.length); });
    rs.on('error', (err) => { ws.destroy(); reject(err); });
    ws.on('error', (err) => { rs.destroy(); reject(err); });
    ws.on('finish', () => resolve());
    rs.pipe(ws);
  });
}

async function copyAndVerifyFile(srcPath, dstPath, progressCallback, cancelCheck, maxAttempts = RETRY_ATTEMPTS) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (cancelCheck()) throw new Error('Cancelled');
    try {
      await copyFileStream(srcPath, dstPath, progressCallback, cancelCheck);
      const [hSrc, hDst] = await Promise.all([hashFile(srcPath), hashFile(dstPath)]);
      if (hSrc === hDst) {
        try { const fd = await fs.promises.open(dstPath, 'r+'); await fd.sync(); await fd.close(); } catch (_) {}
        return;
      }
      await fs.promises.unlink(dstPath).catch(_ => {});
      if (attempt === maxAttempts) throw new Error('Hash mismatch after retries');
    } catch (e) {
      if (attempt === maxAttempts) throw e;
      await new Promise(res => setTimeout(res, RETRY_DELAY_MS));
    }
  }
}

async function removePathRecursive(p) {
  if (!p) return;
  try {
    await fs.promises.rm(p, { recursive: true, force: true });
  } catch (_) {
    // Fallback for older Node
    const rimraf = async (r) => {
      try {
        const entries = await fs.promises.readdir(r, { withFileTypes: true });
        await Promise.all(entries.map(async (ent) => {
          const full = path.join(r, ent.name);
          if (ent.isDirectory()) await rimraf(full);
          else await fs.promises.unlink(full).catch(_ => {});
        }));
        await fs.promises.rmdir(r);
      } catch (_) {}
    };
    await rimraf(p);
  }
}

async function ensureUniqueTarget(basePath) {
  let counter = 1;
  let candidate = basePath;
  while (await fs.promises.stat(candidate).catch(() => false)) {
    candidate = `${basePath} (${counter})`;
    counter++;
    if (counter > 100) throw new Error('Too many conflicts');
  }
  return candidate;
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

async function renameFileSameDevice(srcPath, dstPath, overwriteMode) {
  const exists = await fs.promises.stat(dstPath).catch(() => false);
  let finalDst = dstPath;
  if (exists) {
    if (overwriteMode === 'skip') return { skipped: true, target: dstPath };
    if (overwriteMode === 'overwrite') await removePathRecursive(dstPath);
    else finalDst = await ensureUniqueTarget(dstPath);
  }
  await fs.promises.mkdir(path.dirname(finalDst), { recursive: true });
  await fs.promises.rename(srcPath, finalDst);
  return { moved: true, target: finalDst };
}

async function copyFolderContentsSafely(srcDir, finalTarget, options = {}) {
  const merge = !!options.merge;
  const progress = options.progress;
  const cancelCheck = options.cancelCheck || (() => false);

  const copyDirContentsPreserving = async (src, dst, progressCb, cancelCheck) => {
    const entries = await fs.promises.readdir(src, { withFileTypes: true });
    for (const ent of entries) {
      if (cancelCheck()) throw new Error('Cancelled');
      const srcPath = path.join(src, ent.name);
      const dstPath = path.join(dst, ent.name);
      if (ent.isFile()) {
        const size = (await fs.promises.stat(srcPath).catch(() => ({ size: 0 }))).size || 0;
        progressCb?.({ type: 'go-file-progress', fileRel: ent.name, totalBytesCopied: 0, totalBytes: size });
        await copyAndVerifyFile(srcPath, dstPath, (bytes) => progressCb?.(bytes), cancelCheck);
        progressCb?.({ type: 'go-file-complete', fileRel: ent.name, totalBytesCopied: size, totalBytes: size });
      } else if (ent.isDirectory()) {
        await fs.promises.mkdir(dstPath, { recursive: true });
        await copyDirContentsPreserving(srcPath, dstPath, progressCb, cancelCheck);
      }
    }
  };

  progress?.({ type: 'go-start', totalFiles: 1, totalBytes: 0 }); // Placeholder

  const tmpSuffix = `.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const tempTarget = finalTarget + tmpSuffix;
  let tempCreated = false;
  try {
    await fs.promises.mkdir(tempTarget, { recursive: true });
    tempCreated = true;

    await copyDirContentsPreserving(srcDir, tempTarget, progress, cancelCheck);

    if (!merge) {
      await fs.promises.mkdir(path.dirname(finalTarget), { recursive: true });
      await fs.promises.rename(tempTarget, finalTarget);
    } else {
      await copyDirContentsPreserving(tempTarget, finalTarget, null, cancelCheck);
    }
  } finally {
    if (tempCreated) await removePathRecursive(tempTarget).catch(_ => {});
  }
}

async function moveFolderContentsSafely(srcDir, finalTarget, options = {}) {
  const merge = !!options.merge;
  const progress = options.progress;
  const cancelCheck = options.cancelCheck || (() => false);
  const overwriteMode = options.overwriteMode || 'rename';

  progress?.({ type: 'go-start', totalFiles: 1, totalBytes: 0 }); // Placeholder

  await fs.promises.mkdir(path.dirname(finalTarget), { recursive: true });
  const sameDevice = await isSameDevice(srcDir, path.dirname(finalTarget));

  if (sameDevice && merge) {
    await fs.promises.mkdir(finalTarget, { recursive: true });
    const entries = await fs.promises.readdir(srcDir, { withFileTypes: true });
    for (const ent of entries) {
      if (cancelCheck()) throw new Error('Cancelled');
      const srcPath = path.join(srcDir, ent.name);
      const dstPath = path.join(finalTarget, ent.name);
      if (ent.isDirectory()) {
        const res = await renameFileSameDevice(srcPath, dstPath, overwriteMode);
        if (res.moved) {
          const stats = await listAllFilesWithStats(res.target);
          const size = stats.reduce((s, f) => s + (f.size || 0), 0);
          progress?.({ type: 'go-file-complete', fileRel: path.basename(res.target), fileSize: size, totalBytesCopied: size, totalBytes: size });
        }
      } else {
        const size = (await fs.promises.stat(srcPath).catch(() => ({ size: 0 }))).size || 0;
        const res = await renameFileSameDevice(srcPath, dstPath, overwriteMode);
        if (res.moved) {
          progress?.({ type: 'go-file-complete', fileRel: path.basename(res.target), fileSize: size, totalBytesCopied: size, totalBytes: size });
        }
      }
    }
    await fs.promises.rmdir(srcDir).catch(_ => {});
    progress?.({ type: 'go-complete' });
    return;
  }

  await copyFolderContentsSafely(srcDir, finalTarget, { merge, progress, cancelCheck });
  await removePathRecursive(srcDir);
}

// IPC (same as before, with minor improvements)
ipcMain.handle('open-directory', async () => {
  try {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (res.canceled) return { canceled: true, path: null };
    return { canceled: false, path: res.filePaths[0] || null };
  } catch (e) {
    return { canceled: true, path: null, error: e.message };
  }
});

ipcMain.handle('cancel-operation', async (event) => {
  const cancel = activeCancelFlags.get(event.sender.id);
  if (cancel) cancel();
  activeCancelFlags.delete(event.sender.id);
  return { ok: true };
});

ipcMain.handle('scan-source', async (event, sourceDir) => {
  if (!sourceDir || typeof sourceDir !== 'string' || !path.isAbsolute(sourceDir) && !sourceDir.startsWith('ftp://') && !/^\d+\.\d+\.\d+\.\d+/.test(sourceDir)) return { error: 'Invalid source directory' };
  try {
    if (sourceDir.startsWith('ftp://')) {
      const items = await scanFtpSource(sourceDir);
      return items || [];
    } else if (/^\d+\.\d+\.\d+\.\d+/.test(sourceDir)) {
      const items = await scanFtpSource('ftp://' + sourceDir);
      return items || [];
    } else {
      const stat = await fs.promises.stat(sourceDir);
      if (!stat.isDirectory()) return { error: 'Source is not a directory' };
      const items = await findContentFoldersByTopLevelWithProgress(sourceDir, event.sender);
      return items || [];
    }
  } catch (e) {
    console.error('[main] scan-source error', e);
    return { error: String(e?.message || e) };
  }
});

ipcMain.handle('ensure-and-populate', async (event, opts) => {
  if (!opts || typeof opts !== 'object') throw new Error('Invalid options');
  const items = Array.isArray(opts.items) ? opts.items : [];
  const dest = typeof opts.dest === 'string' ? opts.dest.trim() : null;
  if (!dest || !path.isAbsolute(dest)) throw new Error('Invalid destination');

  const action = opts.action || 'folder-only';
  const layout = opts.layout || 'game-ppsa';
  const overwriteMode = opts.overwriteMode || 'rename';

  const controller = new AbortController();
  activeCancelFlags.set(event.sender.id, () => controller.abort());

  const results = [];
  try {
    for (let idx = 0; idx < items.length; idx++) {
      if (controller.signal.aborted) break;
      const cancelCheck = () => controller.signal.aborted;
      let finalTarget = null;
      try {
        const it = items[idx];
        let parsed = null;
        if (it.paramPath) parsed = await readJsonSafe(it.paramPath);
        if (!parsed && it.ppsaFolderPath) {
          parsed = await readJsonSafe(path.join(it.ppsaFolderPath, 'sce_sys', 'param.json'));
        }
        if (!parsed && it.contentFolderPath) {
          let cand = path.join(it.contentFolderPath, 'sce_sys', 'param.json');
          parsed = await readJsonSafe(cand);
          if (!parsed) {
            cand = path.join(path.dirname(it.contentFolderPath), 'sce_sys', 'param.json');
            parsed = await readJsonSafe(cand);
          }
        }

        const safeGameName = deriveSafeGameName(it, parsed);
        const safeGame = sanitize(safeGameName);

        let srcFolder = it.ppsaFolderPath || it.folderPath || null;
        if (!srcFolder && it.contentFolderPath) {
          if (path.basename(it.contentFolderPath).toLowerCase() === 'sce_sys') srcFolder = path.dirname(it.contentFolderPath);
          else srcFolder = it.contentFolderPath;
        }
        // Fix for flattening: check for -app subfolder
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

        if (layout === 'ppsa-only') finalTarget = path.join(dest, finalPpsaName);
        else if (layout === 'game-only') finalTarget = path.join(dest, safeGame);
        else if (layout === 'etahen') finalTarget = path.join(dest, 'etaHEN', 'games', safeGame);
        else if (layout === 'itemzflow') finalTarget = path.join(dest, 'games', safeGame);
        else finalTarget = path.join(dest, safeGame, finalPpsaName);  // game-ppsa creates GameName/PPSAName

        const normalizedSrc = path.resolve(srcFolder);
        const normalizedTarget = path.resolve(finalTarget);
        const srcInsideTarget = normalizedSrc.startsWith(normalizedTarget + path.sep);
        const targetInsideSrc = normalizedTarget.startsWith(normalizedSrc + path.sep);
        if (targetInsideSrc || (srcInsideTarget && action !== 'move')) {
          throw new Error(`Path overlap: ${finalTarget} conflicts with ${srcFolder}`);
        }

        // Calculate total bytes for the source folder
        const srcFiles = await listAllFilesWithStats(srcFolder);
        const itemTotalBytes = srcFiles.reduce((sum, f) => sum + f.size, 0);

        let totalBytesCopiedSoFar = 0;
        const progressFn = (info) => {
          if (event.sender && !event.sender.isDestroyed()) {
            if (info.type === 'go-file-complete' || info.type === 'go-file-progress') {
              totalBytesCopiedSoFar += info.totalBytesCopied || 0;
            }
            event.sender?.send('scan-progress', { ...info, totalBytes: itemTotalBytes, totalBytesCopied: totalBytesCopiedSoFar, itemIndex: idx + 1, totalItems: items.length });
          }
        };

        const exists = await fs.promises.stat(finalTarget).catch(() => false);
        if (exists) {
          if (overwriteMode === 'skip') {
            results.push({ item: it.folderName, skipped: true, reason: 'target exists', target: finalTarget, source: srcFolder, safeGameName });
            continue;
          } else {
            // No overwrite, always rename for conflicts
            finalTarget = await ensureUniqueTarget(finalTarget);
          }
        }

        if (action === 'folder-only') {
          await fs.promises.mkdir(finalTarget, { recursive: true });
          results.push({ item: safeGameName, target: finalTarget, created: true, source: srcFolder, safeGameName });
        } else if (action === 'copy') {
          progressFn({ type: 'go-file-progress', totalBytesCopied: 0, totalBytes: itemTotalBytes });
          await copyFolderContentsSafely(srcFolder, finalTarget, { merge: true, progress: progressFn, cancelCheck });
          results.push({ item: safeGameName, target: finalTarget, copied: true, source: srcFolder, safeGameName });
        } else if (action === 'move') {
          progressFn({ type: 'go-file-progress', totalBytesCopied: 0, totalBytes: itemTotalBytes });
          await moveFolderContentsSafely(srcFolder, finalTarget, { merge: true, progress: progressFn, cancelCheck, overwriteMode });
          results.push({ item: safeGameName, target: finalTarget, moved: true, source: srcFolder, safeGameName });
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

    event.sender?.send('scan-progress', { type: 'go-complete' });
    event.sender?.send('operation-complete', { success: true, resultsCount: results.length });
  } catch (e) {
    event.sender?.send('operation-complete', { success: false, error: String(e?.message || e) });
  } finally {
    activeCancelFlags.delete(event.sender.id);
  }
  return { success: true, results };
});

ipcMain.handle('check-conflicts', async (event, items, dest, layout) => {
  const conflicts = [];
  for (const it of items) {
    const safeGame = sanitize(deriveSafeGameName(it, null));
    let finalPpsaName = it.ppsa || (it.contentId && (String(it.contentId).match(/PPSA\d{4,6}/i) || [])[0]?.toUpperCase()) || null;
    if (!finalPpsaName) {
      const src = it.contentFolderPath || it.ppsaFolderPath || it.folderPath || '';
      const base = (src + '').split(/[\\/]/).pop() || '';
      finalPpsaName = base.replace(/[-_]*app\d*.*$/i, '').replace(/[-_]+$/,'') || base;
    }
    let finalTarget;
    if (layout === 'ppsa-only') finalTarget = path.join(dest, finalPpsaName);
    else if (layout === 'game-only') finalTarget = path.join(dest, safeGame);
    else if (layout === 'etahen') finalTarget = path.join(dest, 'etaHEN', 'games', safeGame);
    else if (layout === 'itemzflow') finalTarget = path.join(dest, 'games', safeGame);
    else finalTarget = path.join(dest, safeGame, finalPpsaName);  // game-ppsa creates GameName/PPSAName
    const exists = await fs.promises.stat(finalTarget).catch(() => false);
    if (exists) conflicts.push({ item: it.displayTitle || it.folderName || '', target: finalTarget });
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
  await removePathRecursive(pathToDelete);
  return { success: true };
});

ipcMain.handle('rename-item', async (event, item, newName) => {
  const oldPath = item.ppsaFolderPath || item.folderPath;
  const newPath = path.join(path.dirname(oldPath), sanitize(newName));
  await fs.promises.rename(oldPath, newPath);
  return { success: true };
});

ipcMain.handle('move-to-layout', async (event, item, dest, layout) => {
  await ipcMain.handle('ensure-and-populate', event, { items: [item], dest, action: 'move', layout });
  return { success: true };
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
  app.whenReady().then(() => { createWindow(); });
}
app.on('window-all-closed', () => { app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

function createWindow() {
  try {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      resizable: true,
      autoHideMenuBar: true,
      icon: path.join(__dirname, 'assets', 'icon.ico'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true
      }
    });
    mainWindow.maximize();
    mainWindow.webContents.on('did-finish-load', () => console.log('[main] UI loaded'));
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => console.error('[main] did-fail-load', code, desc, url));
    const indexPath = path.join(__dirname, 'index.html');
    fs.access(indexPath, fs.constants.F_OK, (err) => {
      if (err) {
        console.error('[main] index.html not found:', indexPath);
      }
      mainWindow.loadFile('index.html').catch((e) => {
        console.error('[main] loadFile error:', e);
      });
    });
  } catch (e) {
    console.error('[main] createWindow error', e);
  }
}

// Naming helpers (updated to include version suffix consistently)
function sanitize(name) {
  if (!name) return 'Unknown';
  return String(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim().slice(0, 200) || 'Unknown';
}
function deriveSafeGameName(item, parsed) {
  let baseName = item?.displayTitle || item?.dbTitle || item?.folderName;
  if (parsed?.titleName && !baseName) baseName = parsed.titleName;
  if (!baseName) {
    const p = item && (item.contentFolderPath || item.folderPath) || '';
    const seg = (p + '').replace(/[\/\\]+$/,'').split(/[\/\\]/).pop() || '';
    if (seg) baseName = seg;
  }
  if (!baseName && item?.ppsa) baseName = item.ppsa;
  if (!baseName) baseName = 'Unknown Game';

  // Add version suffix if applicable, consistent with renderer
  let versionSuffix = '';
  const cv = item?.contentVersion || parsed?.contentVersion;
  if (cv && cv !== '01.000.000') {
    const cleanedVersion = cv.replace(/^0/, ''); // Clean leading zero
    versionSuffix = ` (${cleanedVersion})`;
  }
  return baseName + versionSuffix;
}