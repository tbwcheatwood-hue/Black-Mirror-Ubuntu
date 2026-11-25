'use strict';
/**
 * Hardware & performance monitor.
 *
 * CPU/RAM come from os.* deltas (works everywhere). Windows commit charge,
 * per-process working sets and the external inference process list come from
 * the WinProbe PowerShell loop; on Linux dev machines a /proc fallback is
 * used so the UI can be exercised end-to-end.
 *
 * Honesty rules:
 *  - GPU metrics are reported ONLY when a working probe exists (nvidia-smi).
 *    Intel iGPU utilization is reported as null/“not available” — we never
 *    display invented numbers.
 *  - tok/s values come from engine logs or API usage — never synthesized.
 */
const os = require('os');
const fs = require('fs');
const { isWindows } = require('../core/util');
const { WinProbe } = require('./winprobe');

class Monitor {
  constructor(logger, opts = {}) {
    this.logger = logger;
    this.win = isWindows() ? new WinProbe(logger) : null;
    this.procFs = !isWindows();
    this.nvidia = null; // { name, vramMB } when nvidia-smi works (Windows path only)
    this._prevCpu = null;
    // Only the Windows branch of gpuSnapshot reads this.nvidia; on Linux the
    // identity comes from linuxprobe, so do not block startup with a sync call.
    if (isWindows()) this._detectNvidia();
    this.intervalMs = opts.intervalMs || 2000;
    this._timer = null;
    this.onSample = opts.onSample || (() => {});
    this.getManagedPids = opts.getManagedPids || (() => []);
    this.serverStartTimes = opts.serverStartTimes || (() => ({}));
  }

  _detectNvidia() {
    try {
      const { spawnSync } = require('child_process');
      const r = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total,utilization.gpu,memory.used', '--format=csv,noheader,nounits'], { timeout: 5000, encoding: 'utf8', windowsHide: true });
      if (r.status === 0 && r.stdout.trim()) {
        const parts = r.stdout.trim().split(',').map(s => s.trim());
        this.nvidia = { name: parts[0], vramMB: parseInt(parts[1], 10) || null };
      }
    } catch (_) { /* not available */ }
  }

  _cpuSnapshot() {
    return os.cpus().map(c => {
      const t = c.times;
      return t.user + t.nice + t.sys + t.idle + t.irq;
    });
  }

  _cpuPct(prevIdle, prevTotal) {
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const c of cpus) { idle += c.times.idle; total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq; }
    const dIdle = idle - prevIdle, dTotal = total - prevTotal;
    this._prevCpu = { idle, total };
    if (dTotal <= 0) return null;
    return Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
  }

  /** One monitoring sample. */
  async sample() {
    if (!this._prevCpu) {
      const cpus = os.cpus();
      this._prevCpu = { idle: cpus.reduce((a, c) => a + c.times.idle, 0), total: cpus.reduce((a, c) => a + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq, 0) };
      await new Promise(r => setTimeout(r, 250));
    }
    const cpuPct = this._cpuPct(this._prevCpu.idle, this._prevCpu.total);
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    let committedTotal = null, committedFree = null;
    let pagefileAllocated = null, pagefileUsed = null;
    let topProcesses = [];
    const managedPids = this.getManagedPids();
    const managed = [];

    if (this.win) {
      const w = await this.win.sample();
      if (w) {
        committedTotal = w.committedLimitBytes ?? w.committedTotalBytes ?? null; // Windows commit limit (RAM + pagefile)
        committedFree = w.committedFreeBytes;
        pagefileAllocated = w.pagefileAllocatedBytes ?? null;
        pagefileUsed = w.pagefileUsedBytes ?? null;
        topProcesses = w.processes || [];
        for (const pid of managedPids) {
          const ws = this.win.pidWorkingSet(pid);
          if (ws) managed.push({ pid, memoryBytes: ws });
        }
      }
    } else {
      const mi = readMemInfo();
      if (mi) {
        // Linux dev approximation: Committed_AS ≈ commit charge; CommitLimit
        // exists on modern kernels when swap accounting is enabled.
        committedTotal = mi.CommitLimit !== undefined ? mi.CommitLimit : mi.Committed_AS;
        committedFree = mi.CommitLimit !== undefined && mi.Committed_AS !== undefined
          ? mi.CommitLimit - mi.Committed_AS
          : mi.MemAvailable;
        pagefileAllocated = mi.SwapTotal !== undefined ? mi.SwapTotal : null;
        pagefileUsed = mi.SwapTotal !== undefined && mi.SwapFree !== undefined ? mi.SwapTotal - mi.SwapFree : null;
      }
      for (const pid of managedPids) {
        const rss = readPidRss(pid);
        if (rss) managed.push({ pid, memoryBytes: rss });
      }
      topProcesses = readTopProcesses();
    }

    const sample = {
      ts: Date.now(),
      cpu: {
        percent: cpuPct !== null ? Number(cpuPct.toFixed(1)) : null,
        model: os.cpus()[0] ? os.cpus()[0].model.trim() : 'unknown',
        cores: os.cpus().length
      },
      memory: {
        totalBytes: totalMem,
        freeBytes: freeMem,
        usedPct: Number((100 * (1 - freeMem / totalMem)).toFixed(1)),
        committedTotalBytes: committedTotal,
        committedFreeBytes: committedFree,
        committedUsedBytes: committedTotal && committedFree ? Math.max(0, committedTotal - committedFree) : null,
        pagefileAllocatedBytes: pagefileAllocated,
        pagefileUsedBytes: pagefileUsed
      },
      gpu: this.gpuSnapshot(),
      managedProcesses: managed,
      externalProcesses: null, // filled on demand (heavier probe)
      topProcesses,
      uptimeSec: Math.floor(os.uptime()),
      servers: Object.entries(this.serverStartTimes()).map(([id, t]) => ({ id, uptimeSec: Math.floor((Date.now() - t) / 1000) }))
    };
    return sample;
  }

  gpuSnapshot() {
    if (!isWindows()) {
      try {
        const { probeHardware, nvidiaProbeInfo: probeNvidiaInfo } = require('./linuxprobe');
        if (!this._linuxHw || Date.now() - (this._linuxHwAt || 0) > 8000) {
          this._linuxHw = probeHardware({ deep: false });
          this._linuxHwAt = Date.now();
        }
        const hw = this._linuxHw;
        const devices = hw.gpus || [];
        const telemetry = nvidiaTelemetryState();
        // The identity probe above already timed nvidia-smi; a slow tool is not polled again.
        if (probeNvidiaInfo().slow && !telemetry.disabled) {
          nvidiaTelemetryState().disabled = true;
          nvidiaTelemetryState().callMs = probeNvidiaInfo().elapsedMs;
        }
        if (hw.nvidia && !telemetry.disabled && findNvidiaSmi()) {
          const live = queryNvidiaLive();
          if (live) {
            return {
              available: true,
              name: hw.nvidia.name,
              utilizationPercent: live.utilizationPercent,
              memoryUsedBytes: live.memoryUsedBytes,
              memoryTotalBytes: hw.nvidia.vramMB ? hw.nvidia.vramMB * 1024 * 1024 : null,
              sharedMemoryBytes: null,
              devices,
              note: devices.length > 1 ? `${devices.length} GPUs reported. Figures are from nvidia-smi for the queried device only.` : null
            };
          }
        }
        const named = devices.map(g => g.name || `${g.vendor || 'gpu'}${g.deviceId ? ' ' + g.deviceId : ''}`).filter(Boolean);
        const note = telemetry.disabled
          ? `nvidia-smi answers too slowly on this host (about ${(telemetry.callMs / 1000).toFixed(1)} s), so live GPU utilization is not polled. Static GPU details are still reported.`
          : named.length
          ? `GPU hardware is visible (${named.join('; ')}) but no telemetry probe returned numbers. Seeing a device is not the same as working acceleration.`
          : 'No GPU telemetry probe available on this system (nvidia-smi absent or it returned no device). Vulkan, ROCm and SYCL are not assumed.';
        return {
          available: false,
          name: named[0] || null,
          utilizationPercent: null,
          memoryUsedBytes: null,
          memoryTotalBytes: null,
          sharedMemoryBytes: null,
          devices,
          note
        };
      } catch (e) {
        return { available: false, name: null, utilizationPercent: null, memoryUsedBytes: null, memoryTotalBytes: null, sharedMemoryBytes: null, devices: [], note: `GPU probe failed: ${e.message}` };
      }
    }
    if (!this.nvidia) {
      return {
        available: false,
        name: null,
        utilizationPercent: null,
        memoryUsedBytes: null,
        memoryTotalBytes: null,
        sharedMemoryBytes: null,
        note: 'No GPU telemetry probe available on this system (nvidia-smi absent). Intel iGPU utilization has no standard user-space API here; GPU acceleration may still work through Vulkan/SYCL but is not claimed.'
      };
    }
    try {
      const live = queryNvidiaLive();
      if (live) {
        return {
          available: true, name: this.nvidia.name,
          utilizationPercent: live.utilizationPercent,
          memoryUsedBytes: live.memoryUsedBytes,
          memoryTotalBytes: this.nvidia.vramMB ? this.nvidia.vramMB * 1024 * 1024 : null,
          sharedMemoryBytes: null,
          note: null
        };
      }
    } catch (_) { /* fall through */ }
    return { available: false, name: this.nvidia.name, utilizationPercent: null, memoryUsedBytes: null, memoryTotalBytes: null, sharedMemoryBytes: null, note: 'nvidia-smi probe failed' };
  }

  /** Heavier external process listing (llama-server/ollama/lemonade). */
  async externalProcesses(controller) {
    if (controller && typeof controller.listExternal === 'function') {
      try { return await controller.listExternal(); } catch (_) { return []; }
    }
    return [];
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(async () => {
      try {
        const s = await this.sample();
        this.onSample(s);
      } catch (_) { /* never crash the loop */ }
    }, this.intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.win) this.win.stop();
  }
}

function findNvidiaSmi() {
  const { findExecutable } = require('../core/util');
  return findExecutable('nvidia-smi');
}

// nvidia-smi is called synchronously from the sample loop. On some hosts
// (older Kepler-era drivers) a call takes several seconds, which would block
// the main process for longer than the sample interval. After one call slower
// than NVIDIA_LIVE_SLOW_MS, live telemetry is dropped and reported as absent.
const NVIDIA_LIVE_SLOW_MS = 1000;
const nvidiaTelemetry = { disabled: false, callMs: null };

function nvidiaTelemetryState() {
  return nvidiaTelemetry;
}

function resetNvidiaTelemetry() {
  nvidiaTelemetry.disabled = false;
  nvidiaTelemetry.callMs = null;
}

function queryNvidiaLive() {
  const { spawnSync } = require('child_process');
  if (nvidiaTelemetry.disabled) return null;
  const startedAt = Date.now();
  const r = spawnSync('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits'], { timeout: 4000, encoding: 'utf8', windowsHide: true });
  const callMs = Date.now() - startedAt;
  if (callMs > NVIDIA_LIVE_SLOW_MS || r.error) {
    nvidiaTelemetry.disabled = true;
    nvidiaTelemetry.callMs = callMs;
    return null;
  }
  if (r.status !== 0 || !r.stdout) return null;
  const line = r.stdout.trim().split('\n')[0];
  const [util, used] = line.split(',').map(s => parseInt(s.trim(), 10));
  return {
    utilizationPercent: Number.isNaN(util) ? null : util,
    memoryUsedBytes: Number.isNaN(used) ? null : used * 1024 * 1024
  };
}

/** Linux helpers (dev environment). */
function readMemInfo() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const out = {};
    for (const line of txt.split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
      if (m) out[m[1]] = parseInt(m[2], 10) * 1024;
    }
    return out;
  } catch (_) { return null; }
}

function readPidRss(pid) {
  try {
    const txt = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = txt.match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? parseInt(m[1], 10) * 1024 : null;
  } catch (_) { return null; }
}

function readTopProcesses() {
  try {
    const { execSync } = require('child_process');
    const out = execSync('ps -eo pid,comm,pcpu,rss --sort=-rss --no-headers 2>/dev/null | head -10 || true', { timeout: 3000 }).toString();
    return out.split('\n').filter(Boolean).map(line => {
      const [pid, comm, pcpu, rss] = line.trim().split(/\s+/);
      return { pid: parseInt(pid, 10), name: comm, wsBytes: (parseInt(rss, 10) || 0) * 1024, cpuPercent: parseFloat(pcpu) };
    });
  } catch (_) { return []; }
}

module.exports = { Monitor, readMemInfo, readPidRss, readTopProcesses, queryNvidiaLive, nvidiaTelemetryState, resetNvidiaTelemetry };
