// main.js — Electron main process (safe conflict handling + faster same-device merges for move)
// Minor, safe adjustments:
// - When moving into parent (merge into parent) we do not remove the destination parent.
// - When requested (options.removeSourceIfEmpty) we remove the source folder with rmdir (only if empty) after moving entries.
// - All other behavior preserved from your reference version.

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const log = require('electron-log');

const BETA_EXPIRES = process.env.BETA_EXPIRES || '2026-01-01T00:00:00Z';

/* ---------- startup helpers ---------- */

function checkBetaExpiry() {
  try {
    const now = new Date();
    const expiry = new Date(BETA_EXPIRES);
    if (now > expiry) {
      try {
        dialog.showMessageBoxSync({
          type: 'error',
          title: 'Beta expired',
          message: 'This beta release has expired.',
          detail: 'The application will now exit. Please download a newer build or contact the developer.',
          buttons: ['OK']
        });
      } catch (e) { log.warn('Failed to show expiry dialog', e); }
      try { app.quit(); } catch (e) {}
      return false;
    }
    return true;
  } catch (e) {
    log.warn('expiry check failed, allowing run', e);
    return true;
  }
}

/* ---------------- scanning helpers ---------- */

const MAX_SCAN_DEPTH = 6;
const SCAN_CONCURRENCY = 16;
const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', 'snapshots', 'system volume information',
  '$recycle.bin', 'recycle.bin', 'recycle', 'trash', 'tmp', 'temp',
  'windows', 'program files', 'program files (x86)'
]);

function isSkippableDir(dirName) {
  if (!dirName) return false;
  const n = String(dirName).toLowerCase();
  if (n.startsWith('.')) return true;
  return SKIP_DIR_NAMES.has(n);
}

function extractPpsaKey(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/PPSA\d{4,6}/i);
  if (m) return m[0].toUpperCase();
  const m2 = s.match(/\b(\d{5})\b/);
  if (m2) return 'PPSA' + m2[1];
  return null;
}

function normalizeSku(s) {
  if (!s) return null;
  return String(s).replace(/[^A-Za-z0-9]/g, '').toUpperCase().trim();
}

async function readJsonSafe(fp) {
  try {
    const txt = await fs.promises.readFile(fp, 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

async function findAllParamJsons(startDir, maxDepth = MAX_SCAN_DEPTH) {
  const out = [];
  const queue = [{ dir: startDir, depth: 0 }];
  while (queue.length) {
    const batch = queue.splice(0, SCAN_CONCURRENCY);
    await Promise.all(batch.map(async ({ dir, depth }) => {
      if (depth > maxDepth) return;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const ent of entries) {
        if (ent.isFile() && /^param\.json$/i.test(ent.name)) out.push(path.join(dir, ent.name));
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        if (isSkippableDir(ent.name)) continue;
        queue.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
      }
    }));
  }
  return out;
}

async function findAllPpsaDirs(startDir, maxDepth = MAX_SCAN_DEPTH) {
  const out = [];
  const ppsaRegex = /^PPSA\d{4,6}(?:[-_].+)?$/i;
  const queue = [{ dir: startDir, depth: 0 }];
  while (queue.length) {
    const batch = queue.splice(0, SCAN_CONCURRENCY);
    await Promise.all(batch.map(async ({ dir, depth }) => {
      if (depth > maxDepth) return;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const ent of entries) {
        if (ent.isDirectory() && ppsaRegex.test(ent.name)) out.push(path.join(dir, ent.name));
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        if (isSkippableDir(ent.name)) continue;
        if (ppsaRegex.test(ent.name)) continue;
        queue.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
      }
    }));
  }
  return out;
}

async function findParamJsonInPpsa(ppsaDir, maxDepth = 3) {
  const direct = path.join(ppsaDir, 'sce_sys', 'param.json');
  if (await fs.promises.stat(direct).catch(() => null)) return direct;
  try {
    const entries = await fs.promises.readdir(ppsaDir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory() && /^sce_sys$/i.test(e.name)) {
        const candidate = path.join(ppsaDir, e.name, 'param.json');
        if (await fs.promises.stat(candidate).catch(() => null)) return candidate;
      }
    }
  } catch (e) {}
  const queue = [{ dir: ppsaDir, depth: 0 }];
  while (queue.length) {
    const batch = queue.splice(0, SCAN_CONCURRENCY);
    for (const { dir, depth } of batch) {
      if (depth > maxDepth) continue;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { continue; }
      for (const ent of entries) {
        if (ent.isFile() && /^param\.json$/i.test(ent.name)) return path.join(dir, ent.name);
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        if (isSkippableDir(ent.name)) continue;
        queue.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
      }
    }
  }
  return null;
}

async function findIconInPpsaSce(ppsaDir) {
  const sce = path.join(ppsaDir, 'sce_sys');
  const candidates = ['icon0.png','icon0.jpg','icon0.jpeg','icon.png','cover.png','cover.jpg','tile0.png'];
  for (const c of candidates) {
    const p = path.join(sce, c);
    if (await fs.promises.stat(p).catch(() => null)) return p;
  }
  try {
    const entries = await fs.promises.readdir(ppsaDir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isFile() && /^(icon0|icon|cover|tile0)\.(png|jpg|jpeg)$/i.test(e.name)) return path.join(ppsaDir, e.name);
    }
  } catch (e) {}
  const queue = [{ dir: ppsaDir, depth: 0 }];
  while (queue.length) {
    const batch = queue.splice(0, SCAN_CONCURRENCY);
    for (const { dir, depth } of batch) {
      if (depth > 2) continue;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { continue; }
      for (const ent of entries) {
        if (ent.isFile() && /^(icon0|icon|cover|tile0)\.(png|jpg|jpeg)$/i.test(ent.name)) return path.join(dir, ent.name);
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        if (isSkippableDir(ent.name)) continue;
        queue.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
      }
    }
  }
  return null;
}

function getTitleFromParam(parsed, preferredRegion) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.titleName && typeof parsed.titleName === 'string') return parsed.titleName;
  const lp = parsed.localizedParameters;
  if (!lp || typeof lp !== 'object') return null;
  let regionKey = preferredRegion || lp.defaultLanguage || lp['defaultLanguage'] || 'en-US';
  if (regionKey && typeof regionKey === 'string') regionKey = regionKey.trim();
  if (regionKey && lp[regionKey] && lp[regionKey].titleName) return lp[regionKey].titleName;
  if (regionKey && /^[A-Za-z]{2}$/.test(regionKey)) {
    const up = regionKey.toUpperCase();
    if (lp[up] && lp[up].titleName) return lp[up].titleName;
    for (const k of Object.keys(lp)) {
      if (k.toUpperCase().endsWith('-' + up) && lp[k] && lp[k].titleName) return lp[k].titleName;
    }
  }
  const langOnly = regionKey && regionKey.indexOf('-') > -1 ? regionKey.split('-')[0] : (regionKey && regionKey.length === 2 ? regionKey : null);
  if (langOnly) {
    for (const k of Object.keys(lp)) {
      if (k.toLowerCase().startsWith(langOnly.toLowerCase()) && lp[k] && lp[k].titleName) return lp[k].titleName;
    }
  }
  if (lp['en-US'] && lp['en-US'].titleName) return lp['en-US'].titleName;
  if (lp['en-GB'] && lp['en-GB'].titleName) return lp['en-GB'].titleName;
  for (const k of Object.keys(lp)) {
    if (lp[k] && lp[k].titleName) return lp[k].titleName;
  }
  return null;
}

function getCanonicalPpsaDir(candidatePath, maxLevels = 8) {
  if (!candidatePath) return null;
  let cur = path.resolve(candidatePath);
  try {
    const st = fs.statSync(cur);
    if (st.isFile()) cur = path.dirname(cur);
  } catch (e) {}
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

// findContentFoldersByTopLevelWithProgress (robust scan)
async function findContentFoldersByTopLevelWithProgress(startDir, sender) {
  const results = [];
  const seen = new Set();
  const paramFiles = await findAllParamJsons(startDir, MAX_SCAN_DEPTH);

  for (let i = 0; i < paramFiles.length; i++) {
    const paramPath = paramFiles[i];
    const paramDir = path.dirname(paramPath);
    const parent = path.basename(paramDir);
    if (isSkippableDir(parent)) continue;
    const parsed = await readJsonSafe(paramPath);
    if (!parsed || typeof parsed !== 'object') continue;

    let ppsaFromCid = null;
    if (parsed.contentId && typeof parsed.contentId === 'string') ppsaFromCid = extractPpsaKey(parsed.contentId);
    if (!ppsaFromCid) ppsaFromCid = extractPpsaKey(JSON.stringify(parsed));

    const contentIdFull = parsed.contentId && typeof parsed.contentId === 'string' ? parsed.contentId : null;

    let sku = null;
    try { sku = scanForSku(parsed); } catch(e){}

    const regionFromParam = parsed.defaultLanguage || (parsed.localizedParameters && parsed.localizedParameters.defaultLanguage) || '';

    let iconPath = null;
    const sce = path.join(paramDir, 'sce_sys');
    for (const c of ['icon0.png','icon0.jpg','icon0.jpeg','icon.png','cover.png','cover.jpg','tile0.png']) {
      const p = path.join(sce, c);
      if (await fs.promises.stat(p).catch(()=>null)) { iconPath = p; break; }
    }
    if (!iconPath) {
      iconPath = await findIconInPpsaSce(paramDir).catch(()=>null);
    }

    const paramTitle = getTitleFromParam(parsed, null);
    const displayTitle = paramTitle || null;
    let folderPath = path.dirname(paramDir);
    const canonical = getCanonicalPpsaDir(paramDir, 8);
    if (canonical) folderPath = canonical;

    const normalizedFolder = path.resolve(folderPath);
    const seenKey = `${ppsaFromCid || ''}|${normalizedFolder}`;
    if (seen.has(seenKey)) continue;

    const rec = {
      ppsa: ppsaFromCid || null,
      ppsaFolderPath: folderPath,
      contentFolderPath: paramDir,
      folderPath: folderPath,
      folderName: path.basename(folderPath),
      paramPath,
      contentId: contentIdFull,
      skuFromParam: sku || null,
      iconPath,
      dbPresent: false,
      dbTitle: null,
      displayTitle,
      region: regionFromParam || '',
      verified: false
    };
    results.push(rec);
    seen.add(seenKey);
    try { sender && sender.send && sender.send('scan-progress', { type: 'scan', index: i+1, total: paramFiles.length, folder: paramDir, ppsa: rec.ppsa }); } catch(e){}
  }

  const ppsaDirs = await findAllPpsaDirs(startDir, MAX_SCAN_DEPTH);
  for (let i = 0; i < ppsaDirs.length; i++) {
    const ppsaDir = ppsaDirs[i];
    const ppsaNameRaw = path.basename(ppsaDir);
    const normalizedPpsaName = extractPpsaKey(ppsaNameRaw) || ppsaNameRaw.toUpperCase();
    const parent = path.basename(path.dirname(ppsaDir));
    if (isSkippableDir(parent)) continue;
    const normalizedFolder = path.resolve(ppsaDir);
    const seenKey = `${normalizedPpsaName || ''}|${normalizedFolder}`;
    if (seen.has(seenKey)) continue;
    const paramPath = await findParamJsonInPpsa(ppsaDir);
    if (!paramPath) continue;
    const parsed = await readJsonSafe(paramPath);
    if (!parsed || typeof parsed !== 'object') continue;

    let ppsaFromCid = null;
    if (parsed.contentId && typeof parsed.contentId === 'string') ppsaFromCid = extractPpsaKey(parsed.contentId);
    const contentIdFull = parsed.contentId && typeof parsed.contentId === 'string' ? parsed.contentId : null;

    let sku = null;
    try { sku = scanForSku(parsed); } catch(e){}

    const regionFromParam = parsed.defaultLanguage || (parsed.localizedParameters && parsed.localizedParameters.defaultLanguage) || '';
    const authoritativePpsa = ppsaFromCid || normalizedPpsaName;
    const iconPath = await findIconInPpsaSce(ppsaDir).catch(()=>null);
    const paramTitle = getTitleFromParam(parsed, null);
    const displayTitle = paramTitle || null;

    const seenKey2 = `${authoritativePpsa || ''}|${normalizedFolder}`;
    if (seen.has(seenKey2)) continue;

    const rec = {
      ppsa: authoritativePpsa,
      ppsaFolderPath: ppsaDir,
      contentFolderPath: ppsaDir,
      folderPath: ppsaDir,
      folderName: path.basename(ppsaDir),
      paramPath,
      contentId: contentIdFull,
      skuFromParam: sku || null,
      iconPath,
      dbPresent: false,
      dbTitle: null,
      displayTitle,
      region: regionFromParam || '',
      verified: false
    };
    results.push(rec);
    seen.add(seenKey2);
    try { sender && sender.send && sender.send('scan-progress', { type: 'scan', index: i+1, total: ppsaDirs.length, folder: ppsaDir, ppsa: rec.ppsa }); } catch(e){}
  }

  return results;
}

/* ---------------- file listing & copy/move helpers ---------------- */

async function listAllFilesWithStats(rootDir) {
  const files = [];
  async function walk(dir, rel = '') {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const r = path.join(rel, ent.name);
      if (ent.isFile()) {
        try {
          const st = await fs.promises.stat(full);
          files.push({ fullPath: full, relPath: r, size: st.size });
        } catch (e) {}
      } else if (ent.isDirectory()) {
        if (isSkippableDir(ent.name)) continue;
        await walk(full, r);
      }
    }
  }
  await walk(rootDir, '');
  return files;
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(filePath);
    rs.on('error', err => reject(err));
    rs.on('data', chunk => hash.update(chunk));
    rs.on('end', () => resolve(hash.digest('hex')));
  });
}

async function copyFileStream(src, dst, progressCallback) {
  await fs.promises.mkdir(path.dirname(dst), { recursive: true });
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dst, { flags: 'w' });
    let copied = 0;
    rs.on('data', (chunk) => {
      copied += chunk.length;
      try { if (typeof progressCallback === 'function') progressCallback(copied); } catch (e) {}
    });
    rs.on('error', err => { try { ws.destroy(); } catch (e) {} ; reject(err); });
    ws.on('error', err => { try { rs.destroy(); } catch (e) {} ; reject(err); });
    ws.on('finish', () => resolve());
    rs.pipe(ws);
  });
}

async function copyAndVerifyFile(srcPath, dstPath, progressCallback, maxAttempts = 2) {
  let attempt = 0;
  let lastErr = null;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      await copyFileStream(srcPath, dstPath, progressCallback);
    } catch (e) {
      lastErr = e;
      continue;
    }
    try {
      const [hSrc, hDst] = await Promise.all([hashFile(srcPath), hashFile(dstPath)]);
      if (hSrc === hDst) {
        try { const fd = await fs.promises.open(dstPath, 'r+'); await fd.sync(); await fd.close(); } catch (e) {}
        return true;
      } else {
        lastErr = new Error(`hash-mismatch attempt ${attempt} for ${srcPath}`);
        await fs.promises.unlink(dstPath).catch(()=>null);
        continue;
      }
    } catch (e) {
      lastErr = e;
      await fs.promises.unlink(dstPath).catch(()=>null);
      continue;
    }
  }
  throw lastErr || new Error(`copyAndVerifyFile failed for ${srcPath}`);
}

async function copyFolderContentsSafely(srcDir, finalTarget, options = {}) {
  const merge = !!options.merge;
  const progress = typeof options.progress === 'function' ? options.progress : null;
  const itemIndex = typeof options.itemIndex === 'number' ? options.itemIndex : null;
  const totalItems = typeof options.totalItems === 'number' ? options.totalItems : null;

  const fileList = await listAllFilesWithStats(srcDir);
  const totalFiles = fileList.length;
  const totalBytes = fileList.reduce((s,f) => s + (f.size || 0), 0);
  let totalBytesCopied = 0;

  try { if (progress) progress({ type: 'go-start', itemIndex, totalItems, totalFiles, totalBytes }); } catch (e) {}

  const tmpSuffix = `.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random()*10000)}`;
  const tempTarget = finalTarget + tmpSuffix;
  await fs.promises.mkdir(tempTarget, { recursive: true });

  for (let i = 0; i < fileList.length; i++) {
    const f = fileList[i];
    const rel = f.relPath;
    const srcPath = f.fullPath;
    const dstPath = path.join(tempTarget, rel);
    const fileSize = f.size || 0;
    try {
      try { if (progress) progress({ type: 'go-file-start', fileIndex: i+1, totalFiles, itemIndex, totalItems, fileRel: rel, fileSize }); } catch(e) {}

      let lastFileCopied = 0;
      const perFileCb = (bytesCopiedForFile) => {
        const tentativeTotal = totalBytesCopied + bytesCopiedForFile;
        try {
          if (progress) progress({
            type: 'go-file-progress',
            fileIndex: i+1, totalFiles,
            fileRel: rel, fileSize,
            fileCopied: bytesCopiedForFile,
            totalBytesCopied: tentativeTotal,
            totalBytes
          });
        } catch (e) {}
      };

      await copyAndVerifyFile(srcPath, dstPath, perFileCb);
      totalBytesCopied += fileSize;
      try { if (progress) progress({ type: 'go-file-complete', fileIndex: i+1, totalFiles, fileRel: rel, fileSize, totalBytesCopied, totalBytes }); } catch(e) {}
    } catch (e) {
      await removePathRecursive(tempTarget).catch(()=>null);
      throw e;
    }
  }

  try {
    if (!merge) {
      await fs.promises.mkdir(path.dirname(finalTarget), { recursive: true });
      await fs.promises.rename(tempTarget, finalTarget);
    } else {
      await copyFolderContentsSafely__moveTempToFinal(tempTarget, finalTarget, progress);
      await removePathRecursive(tempTarget);
    }
  } catch (e) {
    if (merge) {
      try { await copyFolderContentsSafely__moveTempToFinal(tempTarget, finalTarget, progress); await removePathRecursive(tempTarget); }
      catch (ex) { await removePathRecursive(tempTarget).catch(()=>null); throw ex; }
    } else {
      try { await copyFolderContentsSafely__moveTempToFinal(tempTarget, finalTarget, progress); await removePathRecursive(tempTarget); }
      catch (ex) { await removePathRecursive(tempTarget).catch(()=>null); throw ex; }
    }
  }
}

async function copyFolderContentsSafely__moveTempToFinal(tempTarget, finalTarget, progress) {
  async function walk(s, rel = '') {
    const entries = await fs.promises.readdir(s, { withFileTypes: true });
    const files = [];
    for (const ent of entries) {
      const name = ent.name;
      const full = path.join(s, name);
      const r = path.join(rel, name);
      if (ent.isDirectory()) {
        await fs.promises.mkdir(path.join(finalTarget, r), { recursive: true });
        const sub = await walk(full, r);
        files.push(...sub);
      } else if (ent.isFile()) {
        files.push({ src: full, rel: r });
      }
    }
    return files;
  }
  const allFiles = await walk(tempTarget, '');
  let fileIndex = 0;
  let totalBytesCopied = 0;
  const totalBytes = allFiles.reduce((s,f) => {
    try {
      const st = fs.statSync(f.src);
      return s + (st.size || 0);
    } catch (e) { return s; }
  }, 0);
  for (const f of allFiles) {
    fileIndex++;
    const srcPath = f.src;
    const dstPath = path.join(finalTarget, f.rel);
    const fileSize = (await fs.promises.stat(srcPath).catch(()=>({size:0}))).size || 0;
    let lastFileCopied = 0;
    const perFileCb = (bytesCopiedForFile) => {
      const tentativeTotal = totalBytesCopied + bytesCopiedForFile;
      try {
        if (progress) progress({
          type: 'go-file-progress',
          fileIndex, totalFiles: allFiles.length,
          fileRel: f.rel, fileSize,
          fileCopied: bytesCopiedForFile,
          totalBytesCopied: tentativeTotal,
          totalBytes
        });
      } catch (e) {}
    };
    await copyAndVerifyFile(srcPath, dstPath, perFileCb);
    totalBytesCopied += fileSize;
    try { if (progress) progress({ type: 'go-file-complete', fileIndex, totalFiles: allFiles.length, fileRel: f.rel, fileSize, totalBytesCopied, totalBytes }); } catch(e) {}
  }
}

async function removePathRecursive(p) {
  if (!p) return;
  if (fs.promises.rm) {
    await fs.promises.rm(p, { recursive: true, force: true }).catch(()=>null);
    return;
  }
  const rimraf = async (r) => {
    const entries = await fs.promises.readdir(r, { withFileTypes: true }).catch(()=>[]);
    for (const ent of entries) {
      const full = path.join(r, ent.name);
      if (ent.isDirectory()) await rimraf(full);
      else await fs.promises.unlink(full).catch(()=>null);
    }
    await fs.promises.rmdir(r).catch(()=>null);
  };
  await rimraf(p).catch(()=>null);
}

async function isSameDevice(srcPath, destParentPath) {
  try {
    const sStat = await fs.promises.stat(srcPath);
    const dStat = await fs.promises.stat(destParentPath).catch(async () => {
      let p = destParentPath;
      while (p && p !== path.dirname(p)) {
        p = path.dirname(p);
        try {
          const st = await fs.promises.stat(p);
          if (st) return st;
        } catch(e) { continue; }
      }
      return null;
    });
    if (!sStat || !dStat) return false;
    return sStat.dev === dStat.dev;
  } catch (e) {
    return false;
  }
}

// Modified moveFolderContentsSafely:
// - If sameDevice && !merge: rename whole folder (fast) [unchanged].
// - If sameDevice && merge: attempt per-entry rename into finalTarget (fast) and only copy conflicting entries.
// - Otherwise fallback to copyFolderContentsSafely + remove.
async function moveFolderContentsSafely(srcDir, finalTarget, options = {}) {
  const merge = !!options.merge;
  const progress = typeof options.progress === 'function' ? options.progress : null;
  const itemIndex = typeof options.itemIndex === 'number' ? options.itemIndex : null;
  const totalItems = typeof options.totalItems === 'number' ? options.totalItems : null;
  const overwriteMode = options.overwriteMode || 'rename';
  const removeSourceIfEmpty = !!options.removeSourceIfEmpty;

  const fileList = await listAllFilesWithStats(srcDir);
  const totalFiles = fileList.length;
  const totalBytes = fileList.reduce((s,f) => s + (f.size || 0), 0);

  try { if (progress) progress({ type: 'go-start', itemIndex, totalItems, totalFiles, totalBytes }); } catch (e) {}

  const parent = path.dirname(finalTarget);
  try { await fs.promises.mkdir(parent, { recursive: true }); } catch (e) {}

  let sameDevice = await isSameDevice(srcDir, parent).catch(() => false);

  // Fast path: same device and no merge -> rename whole folder
  if (sameDevice && !merge) {
    try {
      await fs.promises.rename(srcDir, finalTarget);
      let accumulated = 0;
      for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i];
        accumulated += f.size || 0;
        try { if (progress) progress({ type: 'go-file-complete', fileIndex: i+1, totalFiles, fileRel: f.relPath, fileSize: f.size || 0, totalBytesCopied: accumulated, totalBytes }); } catch (e) {}
      }
      try { if (progress) progress({ type: 'go-complete' }); } catch (e) {}
      return;
    } catch (e) {
      log.warn('rename failed, falling back to other move strategy', e && e.message ? e.message : e);
      // fall through to fallback behavior
    }
  }

  // New optimized merge-on-same-device path:
  if (sameDevice && merge) {
    try {
      // ensure finalTarget exists
      await fs.promises.mkdir(finalTarget, { recursive: true });

      const entries = await fs.promises.readdir(srcDir, { withFileTypes: true });
      for (const ent of entries) {
        const name = ent.name;
        const srcPath = path.join(srcDir, name);
        const dstPath = path.join(finalTarget, name);

        try {
          const dstStat = await fs.promises.stat(dstPath).catch(()=>null);
          if (!dstStat) {
            // no conflict: fast rename
            await fs.promises.rename(srcPath, dstPath);
          } else {
            // Conflict: dst exists. Handle carefully.
            if (ent.isDirectory()) {
              // merge directory content: copy srcPath into dstPath (merge), then remove srcPath
              await copyFolderContentsSafely(srcPath, dstPath, { merge: true, progress, itemIndex, totalItems, overwriteMode });
              await fs.promises.rmdir(srcPath).catch(()=>null);
            } else {
              // file exists at destination — perform copy+verify (overwrite behavior should have removed dst earlier if user chose overwrite)
              // We'll attempt to copy (which will overwrite), then unlink source.
              if (overwriteMode === 'overwrite') {
                await fs.promises.unlink(dstPath).catch(()=>null);
                try {
                  await fs.promises.rename(srcPath, dstPath);
                } catch (e) {
                  // fallback to copy+verify
                  await copyAndVerifyFile(srcPath, dstPath, null);
                  await fs.promises.unlink(srcPath).catch(()=>null);
                }
              } else if (overwriteMode === 'rename') {
                const parentDir = path.dirname(dstPath);
                const base = path.basename(dstPath);
                let candidate = dstPath;
                let i = 1;
                while (await fs.promises.stat(candidate).catch(()=>null)) {
                  const ext = path.extname(base);
                  const nameNoExt = path.basename(base, ext);
                  candidate = path.join(parentDir, `${nameNoExt} (${i})${ext}`);
                  i++;
                  if (i > 10000) break;
                }
                try { await fs.promises.rename(srcPath, candidate); } catch (e) {
                  await copyAndVerifyFile(srcPath, candidate, null);
                  await fs.promises.unlink(srcPath).catch(()=>null);
                }
              } else {
                // skip: leave source file in place
              }
            }
          }
        } catch (e) {
          log.warn('per-entry move error, falling back to full copy for this item or entire folder', e && e.message ? e.message : e);
          // If any unexpected errors, fallback to copying the whole folder safely and removing source
          await copyFolderContentsSafely(srcDir, finalTarget, { merge, progress, itemIndex, totalItems, overwriteMode });
          // remove source depending on flag
          if (removeSourceIfEmpty) {
            await fs.promises.rmdir(srcDir).catch(()=>null);
          } else {
            await removePathRecursive(srcDir);
          }
          try { if (progress) progress({ type: 'go-complete' }); } catch (e2) {}
          return;
        }
      }

      // After moving entries, attempt to remove the now-empty srcDir
      try {
        if (removeSourceIfEmpty) await fs.promises.rmdir(srcDir).catch(()=>null);
        else await fs.promises.rmdir(srcDir).catch(()=>null);
      } catch (e) { /* ignore */ }

      // Completed fast-merge move
      try { if (progress) progress({ type: 'go-complete' }); } catch (e) {}
      return;
    } catch (e) {
      log.warn('optimized same-device merge failed, falling back to copy+remove', e && e.message ? e.message : e);
      // fall through to fallback to copy+remove
    }
  }

  // General fallback: copy contents safely then remove source
  const opts = { merge, progress, itemIndex, totalItems };
  await copyFolderContentsSafely(srcDir, finalTarget, opts);
  if (removeSourceIfEmpty) await fs.promises.rmdir(srcDir).catch(()=>null); else await removePathRecursive(srcDir);
}

/* ----------------- IPC handlers ----------------- */

ipcMain.handle('open-directory', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (res.canceled) return { canceled: true, path: null };
  return { canceled: false, path: res.filePaths[0] || null };
});

// check-paths-exist: returns array of { path, exists, error? }
ipcMain.handle('check-paths-exist', async (event, paths) => {
  if (!Array.isArray(paths)) return [];
  const out = [];
  for (const p of paths) {
    try {
      const st = await fs.promises.stat(p).catch(()=>null);
      out.push({ path: p, exists: !!st });
    } catch (e) {
      out.push({ path: p, exists: false, error: String(e && e.message ? e.message : e) });
    }
  }
  return out;
});

ipcMain.handle('scan-source', async (event, sourceDir) => {
  if (!sourceDir) return [];
  try {
    const stat = await fs.promises.stat(sourceDir).catch(()=>null);
    if (!stat || !stat.isDirectory()) return [];
    const items = await findContentFoldersByTopLevelWithProgress(sourceDir, event.sender);
    return items || [];
  } catch (e) {
    console.error('scan-source error', e);
    return { error: String(e && e.message ? e.message : e) };
  }
});

/* deriveSafeGameName (keeps consistent fallback with renderer) */
function sanitize(name) { return String(name || '').replace(/[<>:"/\\|?*\x00-\x1F]/g,'').trim().slice(0, 200); }
function deriveSafeGameName(item, parsed) {
  try {
    let name = null;
    if (item && item.displayTitle && String(item.displayTitle).trim()) name = String(item.displayTitle).trim();
    if (!name && parsed) {
      const parsedTitle = (typeof parsed === 'object' && parsed.titleName) ? parsed.titleName : null;
      if (!parsedTitle && parsed && parsed.localizedParameters && parsed.localizedParameters['en-US'] && parsed.localizedParameters['en-US'].titleName) {
        name = parsed.localizedParameters['en-US'].titleName;
      } else if (parsedTitle) {
        name = parsedTitle;
      }
    }
    if (!name && item && item.dbTitle && String(item.dbTitle).trim()) name = String(item.dbTitle).trim();
    if (!name && item && item.folderName && String(item.folderName).trim()) name = String(item.folderName).trim();
    if (!name && item && item.contentFolderPath) {
      try {
        const p = String(item.contentFolderPath).replace(/[\/\\]+$/,'');
        const parts = p.split(/[\/\\]/);
        const last = parts[parts.length-1] || '';
        if (last && last.trim()) name = last.trim();
      } catch(e){}
    }
    if (!name && item && item.ppsa && String(item.ppsa).trim()) name = String(item.ppsa).trim();
    if (!name) name = 'Unknown Game';
    return sanitize(name);
  } catch (e) {
    return 'Unknown Game';
  }
}

ipcMain.handle('ensure-and-populate', async (event, opts) => {
  try {
    const items = (opts && Array.isArray(opts.items)) ? opts.items : [];
    const dest = opts && opts.dest ? String(opts.dest) : null;
    const action = opts && opts.action ? String(opts.action) : 'folder-only';
    const layout = opts && opts.layout ? String(opts.layout) : 'game-ppsa';
    const overwriteMode = opts && typeof opts.overwriteMode === 'string' ? opts.overwriteMode : 'rename';
    if (!dest) return { error: 'No destination' };

    const results = [];
    let cancelAll = false;

    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      if (cancelAll) { results.push({ item: it.folderName, skipped: true, source: it.contentFolderPath || it.folderPath || null }); continue; }
      try {
        let parsed = null;
        if (it.paramPath) parsed = await readJsonSafe(it.paramPath);
        if (!parsed && it.ppsaFolderPath) {
          const candidate = path.join(it.ppsaFolderPath, 'sce_sys', 'param.json');
          parsed = await readJsonSafe(candidate);
        }
        if (!parsed && it.contentFolderPath) {
          let candidate = path.join(it.contentFolderPath, 'sce_sys', 'param.json');
          parsed = await readJsonSafe(candidate);
          if (!parsed) {
            candidate = path.join(path.dirname(it.contentFolderPath), 'sce_sys', 'param.json');
            parsed = await readJsonSafe(candidate);
          }
        }

        // derive safe game name
        const safeGameName = deriveSafeGameName(it, parsed);

        let srcFolder = it.ppsaFolderPath || it.folderPath || null;
        if (!srcFolder && it.contentFolderPath) {
          if (path.basename(it.contentFolderPath).toLowerCase() === 'sce_sys') srcFolder = path.dirname(it.contentFolderPath);
          else srcFolder = it.contentFolderPath;
        }
        if (!srcFolder) { results.push({ item: it.folderName, error: 'no source folder', source: it.contentFolderPath || it.folderPath || null }); continue; }

        try { event.sender && event.sender.send && event.sender.send('scan-progress', { type: 'go-item', path: srcFolder, itemIndex: idx+1, totalItems: items.length }); } catch(e){}

        let finalPpsaName = null;
        if (parsed && parsed.contentId) {
          const fromParsed = extractPpsaKey(parsed.contentId);
          if (fromParsed) finalPpsaName = fromParsed;
        }
        if (!finalPpsaName && it.ppsa) finalPpsaName = it.ppsa;
        if (!finalPpsaName) {
          const srcBase = path.basename(srcFolder);
          finalPpsaName = srcBase.replace(/[-_]?app\d*$/i, '').replace(/[-_]+$/,'') || srcBase;
        }

        let finalTarget;
        if (layout === 'ppsa-only') finalTarget = path.join(dest, finalPpsaName);
        else if (layout === 'game-only') finalTarget = path.join(dest, safeGameName);
        else if (layout === 'etahen') finalTarget = path.join(dest, 'etaHEN', 'games', safeGameName);
        else if (layout === 'itemzflow') finalTarget = path.join(dest, 'games', safeGameName);
        else finalTarget = path.join(dest, safeGameName, finalPpsaName);

        // Handle conflict according to overwriteMode
        const exists = !!(await fs.promises.stat(finalTarget).catch(()=>null));

        // Detect if user is moving the PPSA folder into its parent (we should merge contents)
        const resolvedFinalTarget = path.resolve(finalTarget);
        const resolvedSrcParent = path.resolve(path.dirname(srcFolder));
        const isMovingIntoParent = (action === 'move') && (resolvedFinalTarget === resolvedSrcParent);

        if (exists) {
          if (isMovingIntoParent) {
            // do not remove finalTarget in this case
          } else {
            if (overwriteMode === 'skip') {
              results.push({ item: it.folderName, skipped: true, reason: 'target exists', target: finalTarget, source: srcFolder });
              continue;
            } else if (overwriteMode === 'overwrite') {
              try { await removePathRecursive(finalTarget); } catch(e) { /* continue */ }
            } else {
              // 'rename' or other -> choose unique name
              finalTarget = await ensureUniqueTarget(finalTarget);
            }
          }
        }

        const progressFn = (info) => {
          try {
            event.sender && event.sender.send && event.sender.send('scan-progress', Object.assign({}, info, { type: info.type || 'go', itemIndex: idx+1, totalItems: items.length }));
          } catch (e) {}
        };

        if (action === 'folder-only') {
          await fs.promises.mkdir(finalTarget, { recursive: true });
          results.push({ item: it.folderName, target: finalTarget, created: true, source: srcFolder });
        } else if (action === 'copy') {
          const opts2 = (layout === 'itemzflow') ? { merge: true } : {};
          opts2.progress = progressFn; opts2.itemIndex = idx+1; opts2.totalItems = items.length;
          await copyFolderContentsSafely(srcFolder, finalTarget, opts2);
          results.push({ item: it.folderName, target: finalTarget, copied: true, source: srcFolder });
        } else if (action === 'move') {
          const opts2 = (layout === 'itemzflow') ? { merge: true } : {};
          // If moving into parent, ensure merge and only rmdir source if empty
          if (isMovingIntoParent) { opts2.merge = true; opts2.removeSourceIfEmpty = true; }
          opts2.progress = progressFn; opts2.itemIndex = idx+1; opts2.totalItems = items.length;
          await moveFolderContentsSafely(srcFolder, finalTarget, opts2);
          results.push({ item: it.folderName, target: finalTarget, moved: true, source: srcFolder });
        } else {
          results.push({ item: it.folderName, error: `unknown action ${action}`, source: srcFolder });
        }

      } catch (e) {
        results.push({ item: it && it.folderName, error: String(e && e.message ? e.message : e), source: it && (it.contentFolderPath || it.folderPath) || null });
      }
    }

    try { event.sender && event.sender.send && event.sender.send('scan-progress', { type: 'go-complete' }); } catch(e){}
    // Notify renderer that operation completed successfully so it can refresh the scan list
    try {
      event.sender && event.sender.send && event.sender.send('operation-complete', { success: true, resultsCount: results.length });
    } catch (e) {}

    return { success: true, results };
  } catch (e) {
    try {
      event.sender && event.sender.send && event.sender.send('operation-complete', { success: false, error: String(e && e.message ? e.message : e) });
    } catch (ex) {}
    return { error: String(e && e.message ? e.message : e) };
  }
});

/* ----------------- window & utilities ----------------- */

ipcMain.handle('show-in-folder', async (event, targetPath) => {
  try {
    if (!targetPath) return { ok: false, error: 'no path' };
    shell.showItemInFolder(targetPath);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.on('open-devtools', () => {
  try { if (mainWindow && mainWindow.webContents) mainWindow.webContents.openDevTools({ mode: 'detach' }); } catch (e) {}
});

let mainWindow;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    resizable: true,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'app.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  if (!checkBetaExpiry()) return;
  createWindow();
});

app.on('window-all-closed', () => { app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

function scanForSku(parsed) {
  try {
    const txt = JSON.stringify(parsed);
    const m = txt.match(/[A-Za-z0-9\-]{6,}/);
    if (m) return normalizeSku(m[0]);
  } catch (e) {}
  return null;
}