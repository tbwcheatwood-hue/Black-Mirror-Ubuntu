'use strict';
/**
 * Windows-specific hardware probes via a persistent PowerShell process.
 *
 * Design: one PowerShell child process runs a sampling loop and emits one
 * JSON line per sample. This avoids paying PowerShell's ~300-500ms startup
 * on every sample. All probes are read-only; nothing on the user's system
 * is modified.
 *
 * Output JSON keys:
 *   committedTotalBytes, committedFreeBytes   (Windows commit charge)
 *   processes: [{ pid, name, wsBytes }]       (top working sets)
 *   pidWs: { "<pid>": bytes }                 (working set of tracked pids)
 */
const { spawn } = require('child_process');

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $os = Get-CimInstance Win32_OperatingSystem
  $procs = Get-Process | Where-Object { $_.WorkingSet64 -gt 0 } | Sort-Object WorkingSet64 -Descending
  $top = @($procs | Select-Object -First 10 | ForEach-Object { @{ pid = $_.Id; name = $_.ProcessName; wsBytes = $_.WorkingSet64 } })
  $tracked = @{}
  foreach ($p in $procs) { $tracked[[string]$p.Id] = $p.WorkingSet64 }
  $pf = @(Get-CimInstance Win32_PageFileUsage)
  $pfAlloc = ($pf | Measure-Object -Property AllocatedBaseSize -Sum).Sum
  $pfUsed  = ($pf | Measure-Object -Property CurrentUsage -Sum).Sum
  @{ committedLimitBytes = [uint64]$os.TotalVirtualMemorySize * 1KB;
     committedFreeBytes  = [uint64]$os.FreeVirtualMemory * 1KB;
     pagefileAllocatedBytes = [uint64]$pfAlloc * 1MB;
     pagefileUsedBytes  = [uint64]$pfUsed * 1MB;
     processes = $top;
     pidWs = $tracked } | ConvertTo-Json -Compress -Depth 4
  Start-Sleep -Seconds 2
}
`;

class WinProbe {
  constructor(logger) {
    this.logger = logger;
    this.child = null;
    this.last = null;
    this._buf = '';
    this._waiters = [];
  }

  _start() {
    if (this.child || this._dead) return;
    try {
      this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      });
      this.child.stdout.on('data', chunk => {
        this._buf += String(chunk);
        let idx;
        while ((idx = this._buf.indexOf('\n')) >= 0) {
          const line = this._buf.slice(0, idx).trim();
          this._buf = this._buf.slice(idx + 1);
          if (!line) continue;
          try {
            this.last = JSON.parse(line);
            const ws = this._waiters.splice(0);
            ws.forEach(w => w(this.last));
          } catch (_) { /* partial line */ }
        }
      });
      this.child.stderr.on('data', () => { /* PS noise */ });
      this.child.on('exit', () => { this.child = null; });
      this.child.on('error', () => { this.child = null; this._dead = true; });
    } catch (e) {
      this.logger && this.logger.warn('winprobe', `cannot start PowerShell probe: ${e.message}`);
      this._dead = true;
    }
  }

  /** Latest sample (starts probe on first use; resolves current or next sample). */
  sample(timeoutMs = 4000) {
    if (!this.child && !this._dead) this._start();
    if (this.last) return Promise.resolve(this.last);
    if (!this.child) return Promise.resolve(null);
    return new Promise(resolve => {
      const to = setTimeout(() => {
        const i = this._waiters.indexOf(w);
        if (i >= 0) this._waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      const w = data => { clearTimeout(to); resolve(data); };
      this._waiters.push(w);
    });
  }

  /** Working set of a specific pid from the latest sample. */
  pidWorkingSet(pid) {
    return this.last && this.last.pidWs ? this.last.pidWs[String(pid)] || null : null;
  }

  stop() {
    if (this.child) { try { this.child.kill(); } catch (_) { /* ignore */ } this.child = null; }
  }
}

module.exports = { WinProbe };
