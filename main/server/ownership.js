'use strict';
/**
 * Process identity & ownership verification.
 *
 * A managed inference process must be re-identifiable after an application
 * restart (crash recovery, stale records, PID reuse). A PID alone is never
 * sufficient — PIDs get recycled. Ownership evidence is the recorded
 * executable path + the recorded model path appearing in the live command
 * line + the process start time recorded at launch.
 *
 * If ownership cannot be verified, the process is classified EXTERNAL and
 * Black Mirror will never terminate it.
 */
const fs = require('fs');
const { execFile } = require('child_process');

function _readProc(pid, file) {
  try { return fs.readFileSync(`/proc/${pid}/${file}`, 'utf8'); } catch (_) { return null; }
}

/** Linux process start time (field 22 of /proc/<pid>/stat, in clock ticks). */
function _procStartTime(pid) {
  const stat = _readProc(pid, 'stat');
  if (!stat) return null;
  const close = stat.lastIndexOf(')');
  const fields = stat.slice(close + 2).split(' ');
  return fields[20] || null; // field 22 overall → index 20 after comm
}

/** Snapshot a live process's identity. Returns null when it does not exist. */
function snapshotProcess(pid, opts = {}) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') {
    if (opts.psInfo) return opts.psInfo; // injectable for tests
    return snapshotProcessWindowsSync(pid);
  }
  const exe = (() => { try { return fs.readlinkSync(`/proc/${pid}/exe`); } catch (_) { return null; } })();
  const cmdlineRaw = _readProc(pid, 'cmdline');
  if (!cmdlineRaw && !exe) return null;
  return {
    pid,
    exe: exe || null,
    cmdline: cmdlineRaw ? cmdlineRaw.split('\0').filter(Boolean) : [],
    startTime: _procStartTime(pid)
  };
}

/**
 * Synchronous Win32_Process identity probe used by spawn recording and
 * recoverAtStartup (both are sync call sites). Returns null when the PID
 * is gone or PowerShell/CIM is unavailable.
 */
function snapshotProcessWindowsSync(pid) {
  const { spawnSync } = require('child_process');
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object ProcessId,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress`
  ], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout || !String(r.stdout).trim()) return null;
  try {
    const j = JSON.parse(r.stdout);
    if (!j || !j.ProcessId) return null;
    return {
      pid: j.ProcessId,
      exe: j.ExecutablePath || null,
      cmdline: j.CommandLine ? _splitWinCmdline(j.CommandLine) : [],
      startTime: j.CreationDate || null
    };
  } catch (_) {
    return null;
  }
}

/** Split a Windows command line while preserving quoted segments. */
function _splitWinCmdline(cmd) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(cmd))) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

/** Quick liveness probe. */
function isAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Verify a persisted ownership record against a live process snapshot.
 * Evidence required (ALL of):
 *   1. the process is alive,
 *   2. its executable path matches the recorded engine binary,
 *   3. its command line contains the recorded model path (or no model was
 *      recorded and the command line matches the fingerprint),
 *   4. its start time matches the recorded start time (PID-reuse guard).
 */
function verifyOwnership(record, snapshot) {
  if (!record) return { owned: false, reason: 'no ownership record' };
  if (!snapshot) return { owned: false, reason: `pid ${record.pid} not running` };
  if (record.startTime && snapshot.startTime && String(record.startTime) !== String(snapshot.startTime)) {
    return { owned: false, reason: 'start time mismatch — PID was likely reused by another process' };
  }
  if (record.exePath && snapshot.exe) {
    const a = String(record.exePath).toLowerCase();
    const b = String(snapshot.exe).toLowerCase();
    if (a !== b && !b.endsWith(a.split(/[\\/]/).pop())) {
      return { owned: false, reason: `executable mismatch: expected ${record.exePath}, found ${snapshot.exe}` };
    }
  } else if (record.exePath && !snapshot.exe) {
    return { owned: false, reason: 'executable path unreadable — cannot verify identity' };
  }
  if (record.modelPath) {
    const inCmd = snapshot.cmdline.some(c => c.includes(record.modelPath));
    if (!inCmd) return { owned: false, reason: 'recorded model path not present in command line' };
  }
  return { owned: true, reason: 'executable, command line and start time match the ownership record' };
}

/** Async Windows helper: snapshot via Win32_Process (used when callers can await). */
function snapshotProcessWindows(pid) {
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object ProcessId,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress`],
      { windowsHide: true, timeout: 15000 }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        try {
          const j = JSON.parse(stdout);
          if (!j || !j.ProcessId) return resolve(null);
          resolve({
            pid: j.ProcessId,
            exe: j.ExecutablePath || null,
            cmdline: j.CommandLine ? _splitWinCmdline(j.CommandLine) : [],
            startTime: j.CreationDate || null
          });
        } catch (_) { resolve(null); }
      });
  });
}

module.exports = { snapshotProcess, snapshotProcessWindows, snapshotProcessWindowsSync, isAlive, verifyOwnership };
