'use strict';
/** Small shared helpers. Plain Node, no Electron imports. */
const path = require('path');
const os = require('os');

const isWindows = () => process.platform === 'win32';
const isLinux = () => process.platform === 'linux';

/** Home directory for user data: %APPDATA%/BlackMirror on Windows. */
function defaultAppDataDir() {
  if (isWindows()) {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'BlackMirror');
  }
  if (process.platform === 'linux') {
    const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    const modern = path.join(xdg, 'black-mirror');
    const legacy = path.join(os.homedir(), '.black-mirror');
    try {
      const fs = require('fs');
      if (!fs.existsSync(modern) && fs.existsSync(legacy)) return legacy;
    } catch (_) { /* fall through */ }
    return modern;
  }
  return process.env.BLACK_MIRROR_DATA_DIR || path.join(os.homedir(), '.black-mirror');
}

function formatBytes(bytes) {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

/** Best-effort executable existence check that works for both absolute paths and PATH lookup. */
function findExecutable(filePath, isWin = isWindows()) {
  const fs = require('fs');
  if (!filePath) return null;
  if (path.isAbsolute(filePath) || filePath.includes(isWin ? '\\' : '/')) {
    return fs.existsSync(filePath) ? filePath : null;
  }
  const exts = isWin ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const cand = path.join(dir, filePath + ext);
      try { fs.accessSync(cand, fs.constants.X_OK); return cand; } catch (_) { /* keep looking */ }
    }
  }
  return null;
}

/** Locate a server binary inside an extracted engine tree (depth-capped). */
function findInstalledBinary(dir, exeName, depth = 3) {
  const fs = require('fs');
  if (!dir || !exeName || depth < 0) return null;
  const candidates = [
    path.join(dir, exeName),
    path.join(dir, 'bin', exeName),
    path.join(dir, 'build', 'bin', exeName)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const found = findInstalledBinary(path.join(dir, ent.name), exeName, depth - 1);
    if (found) return found;
  }
  return null;
}

module.exports = { isWindows, isLinux, defaultAppDataDir, formatBytes, sleep, withTimeout, findExecutable, findInstalledBinary };
