'use strict';
/**
 * Native Linux hardware probe.
 *
 * Reads /proc and /sys first. Optional tools (lscpu, nvidia-smi, vulkaninfo,
 * rocminfo, sycl-ls) are used only when they exist on PATH. Missing tools
 * produce honest "unknown" / "not probed" results — never invented devices,
 * VRAM figures or "acceleration works" claims.
 *
 * A GPU showing up in sysfs does NOT mean CUDA, ROCm, Vulkan or SYCL
 * inference will succeed. Those runtimes are reported separately, and only
 * when a probe actually responded.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { findExecutable } = require('../core/util');

const VENDOR = {
  '0x10de': 'nvidia',
  '0x1002': 'amd',
  '0x8086': 'intel'
};

function defaultRun(cmd, args, timeout = 4000) {
  try {
    const r = spawnSync(cmd, args, { timeout, encoding: 'utf8', windowsHide: true });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? r.error.message : null };
  } catch (e) {
    return { status: null, stdout: '', stderr: '', error: e.message };
  }
}

function parseCpuInfo(text) {
  const blocks = String(text || '').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  let model = 'unknown';
  let flags = [];
  const phys = new Set();
  let threads = 0;
  for (const block of blocks) {
    if (!/^processor\s*:/m.test(block)) continue;
    threads++;
    const modelLine = block.match(/^model name\s*:\s*(.+)$/m);
    if (modelLine) model = modelLine[1].trim();
    const flagLine = block.match(/^flags\s*:\s*(.+)$/m);
    if (flagLine && !flags.length) flags = flagLine[1].trim().split(/\s+/);
    const physId = (block.match(/^physical id\s*:\s*(\d+)/m) || [])[1];
    const coreId = (block.match(/^core id\s*:\s*(\d+)/m) || [])[1];
    if (physId != null && coreId != null) phys.add(`${physId}:${coreId}`);
  }
  return {
    model,
    logicalThreads: threads || null,
    physicalCores: phys.size || null,
    flags
  };
}

function parseMemInfo(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)\s+kB/);
    if (m) out[m[1]] = parseInt(m[2], 10) * 1024;
  }
  const total = out.MemTotal || null;
  const available = out.MemAvailable != null ? out.MemAvailable : (out.MemFree || null);
  const swapTotal = out.SwapTotal != null ? out.SwapTotal : null;
  const swapFree = out.SwapFree != null ? out.SwapFree : null;
  return {
    totalBytes: total,
    availableBytes: available,
    freeBytes: out.MemFree || null,
    swapTotalBytes: swapTotal,
    swapFreeBytes: swapFree,
    swapUsedBytes: swapTotal != null && swapFree != null ? Math.max(0, swapTotal - swapFree) : null,
    commitLimitBytes: out.CommitLimit != null ? out.CommitLimit : null,
    committedBytes: out.Committed_AS != null ? out.Committed_AS : null
  };
}

function readSysGpus(opts) {
  const exists = opts.existsSync;
  const read = opts.readFileSync;
  const readdir = opts.readdirSync;
  const root = opts.sysRoot || '/sys/class/drm';
  const gpus = [];
  let names = [];
  try { names = readdir(root); } catch (_) { return gpus; }
  for (const name of names) {
    if (!/^card\d+$/.test(name)) continue;
    const dev = path.join(root, name, 'device');
    if (!exists(dev)) continue;
    const vendorRaw = safeRead(read, path.join(dev, 'vendor'));
    const deviceRaw = safeRead(read, path.join(dev, 'device'));
    if (!vendorRaw) continue;
    const vendorId = vendorRaw.trim().toLowerCase();
    const vendor = VENDOR[vendorId] || 'other';
    // Skip render-only duplicates: cardN is the primary node.
    let vramBytes = null;
    let shared = false;
    const vramTotal = safeRead(read, path.join(dev, 'mem_info_vram_total'));
    if (vramTotal && /^\d+$/.test(vramTotal.trim())) vramBytes = parseInt(vramTotal.trim(), 10);
    const gtt = safeRead(read, path.join(dev, 'mem_info_gtt_total'));
    let sharedBytes = null;
    if (gtt && /^\d+$/.test(gtt.trim())) sharedBytes = parseInt(gtt.trim(), 10);
    if (vendor === 'intel' && vramBytes == null) shared = true;
    let driver = null;
    try {
      const link = opts.readlinkSync ? opts.readlinkSync(path.join(dev, 'driver')) : fs.readlinkSync(path.join(dev, 'driver'));
      driver = path.basename(link);
    } catch (_) { /* no driver bound */ }
    const product = safeRead(read, path.join(dev, 'product_name'))
      || safeRead(read, path.join(root, name, 'device', 'product_name'));
    gpus.push({
      id: name,
      vendor,
      vendorId,
      deviceId: deviceRaw ? deviceRaw.trim().toLowerCase() : null,
      name: product ? product.trim() : null,
      driver,
      vramBytes,
      sharedMemoryBytes: sharedBytes,
      shared,
      source: 'sysfs',
      telemetry: null
    });
  }
  return gpus;
}

function safeRead(read, p) {
  try { return read(p, 'utf8'); } catch (_) { return null; }
}

function parseNvidiaSmi(text) {
  const gpus = [];
  // csv: name, memory.total, driver_version, compute_cap  OR multi-query
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /^name,/i.test(trimmed)) continue;
    const parts = trimmed.split(',').map(s => s.trim());
    if (parts.length < 2) continue;
    const vram = parseInt(String(parts[1]).replace(/[^\d]/g, ''), 10);
    const cc = parts[3] ? parts[3] : null;
    gpus.push({
      vendor: 'nvidia',
      name: parts[0] || null,
      vramMB: Number.isFinite(vram) ? vram : null,
      vramBytes: Number.isFinite(vram) ? vram * 1024 * 1024 : null,
      driver: parts[2] || null,
      computeCapability: cc,
      computeMajor: cc && cc.includes('.') ? parseInt(cc.split('.')[0], 10) : null,
      source: 'nvidia-smi',
      telemetry: 'nvidia-smi'
    });
  }
  return gpus;
}

function parseCudaVersion(text) {
  const m = String(text || '').match(/CUDA Version:\s*([0-9.]+)/i);
  return m ? m[1] : null;
}

// Older nvidia-smi builds reject the compute_cap field and exit non-zero for
// the whole query. Retry without it and report the capability as unknown.
// Each call is synchronous, and on some hosts takes several seconds, so a
// slow round of calls is remembered and reused instead of repeated.
const NVIDIA_SLOW_MS = 1000;
// The cached round holds GPU identity, driver and CUDA version. None of
// those change while the app is open, so the reuse window is long.
const NVIDIA_SLOW_CACHE_MS = 30 * 60 * 1000;
const nvidiaCache = { at: 0, slow: false, elapsedMs: null, capRejected: false, result: null };

function probeNvidia(smi, run) {
  if (nvidiaCache.slow && nvidiaCache.result && Date.now() - nvidiaCache.at < NVIDIA_SLOW_CACHE_MS) {
    return nvidiaCache.result;
  }
  let elapsed = 0;
  const timed = (args) => {
    const startedAt = Date.now();
    const r = run(smi, args, 5000);
    elapsed += Date.now() - startedAt;
    return r;
  };
  const ok = r => !!r && r.status === 0 && r.stdout.trim();
  const FULL = ['--query-gpu=name,memory.total,driver_version,compute_cap', '--format=csv,noheader'];
  const PLAIN = ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'];
  let query = nvidiaCache.capRejected ? null : timed(FULL);
  let capMissing = false;
  if (!ok(query)) {
    const plain = timed(PLAIN);
    if (ok(plain)) {
      query = plain;
      capMissing = true;
      nvidiaCache.capRejected = true;
    }
  }
  // The header is only read for the CUDA version, so skip it when no device answered.
  const header = ok(query) ? timed([]) : { stdout: '', stderr: '' };
  const result = { query, ok: ok(query), header: header.stdout + header.stderr, capMissing };
  if (elapsed > NVIDIA_SLOW_MS) {
    Object.assign(nvidiaCache, { at: Date.now(), slow: true, elapsedMs: elapsed, result });
  }
  return result;
}

/** True once a round of nvidia-smi calls on this host exceeded NVIDIA_SLOW_MS. */
function nvidiaProbeInfo() {
  return { slow: nvidiaCache.slow, elapsedMs: nvidiaCache.elapsedMs };
}

/**
 * @param {object} [opts] injectable readers for tests
 * @param {boolean} [opts.deep] when true, run vulkaninfo/rocminfo/sycl-ls if present
 */
function probeHardware(opts = {}) {
  const read = opts.readFileSync || ((p, enc) => fs.readFileSync(p, enc || 'utf8'));
  const exists = opts.existsSync || fs.existsSync;
  const readdir = opts.readdirSync || fs.readdirSync;
  const run = opts.run || defaultRun;
  const io = { readFileSync: read, existsSync: exists, readdirSync: readdir, readlinkSync: opts.readlinkSync, sysRoot: opts.sysRoot, run };

  const cpuTxt = opts.cpuinfo != null ? opts.cpuinfo : safeRead(read, '/proc/cpuinfo');
  const memTxt = opts.meminfo != null ? opts.meminfo : safeRead(read, '/proc/meminfo');
  const cpu = parseCpuInfo(cpuTxt || '');
  const memory = parseMemInfo(memTxt || '');

  if (cpu.physicalCores == null && !opts.noLscpu) {
    const lscpu = findExecutable('lscpu');
    if (lscpu) {
      const r = run(lscpu, ['-p=CPU,Core,Socket'], 3000);
      if (r.status === 0) {
        const cores = new Set();
        let threads = 0;
        for (const line of r.stdout.split('\n')) {
          if (!line || line.startsWith('#')) continue;
          const [cpuId, core, socket] = line.split(',');
          if (cpuId == null || cpuId === '') continue;
          threads++;
          if (core != null && socket != null) cores.add(`${socket}:${core}`);
        }
        if (threads) cpu.logicalThreads = cpu.logicalThreads || threads;
        if (cores.size) cpu.physicalCores = cores.size;
      }
    }
  }

  const interesting = ['sse4_1', 'sse4_2', 'avx', 'avx2', 'avx512f', 'fma', 'f16c', 'neon', 'asimd', 'sve'];
  const isa = {};
  for (const f of interesting) isa[f] = cpu.flags.includes(f);

  let sysGpus = [];
  try { sysGpus = readSysGpus(io); } catch (_) { sysGpus = []; }

  const notes = [];
  let nvidiaRuntime = null;
  let cudaVersion = null;
  let nvidiaDriver = null;
  const smi = findExecutable('nvidia-smi');
  if (smi && !opts.skipNvidia) {
    const nv = probeNvidia(smi, run);
    if (nv.ok) {
      const parsed = parseNvidiaSmi(nv.query.stdout);
      cudaVersion = parseCudaVersion(nv.header);
      nvidiaDriver = parsed[0] && parsed[0].driver;
      nvidiaRuntime = parsed;
      // Prefer nvidia-smi identity over a bare sysfs card when both exist.
      for (const g of parsed) {
        const existing = sysGpus.find(s => s.vendor === 'nvidia' && !s.name);
        if (existing && !existing._filled) {
          Object.assign(existing, g, { id: existing.id, _filled: true });
        } else if (!sysGpus.some(s => s.vendor === 'nvidia' && s.name === g.name && s.vramMB === g.vramMB)) {
          sysGpus.push(g);
        }
      }
      if (nv.capMissing) {
        notes.push('This nvidia-smi does not report compute capability, so Kepler-class detection is unavailable. The CUDA builds here need compute capability 5.0 or newer; check the card against that before installing one.');
      }
    } else {
      notes.push('nvidia-smi is installed but did not return a device query. A GPU may be present without a working driver.');
    }
  } else if (!smi) {
    notes.push('nvidia-smi is not installed — NVIDIA telemetry and CUDA version were not queried.');
  }

  const legacy = (nvidiaRuntime || []).filter(g => g.computeMajor != null && g.computeMajor < 5);
  const modern = (nvidiaRuntime || []).filter(g => g.computeMajor != null && g.computeMajor >= 5);

  let vulkan = 'unknown';
  let rocm = 'unknown';
  let sycl = 'unknown';
  let cuda = 'unknown';

  if (nvidiaRuntime && nvidiaRuntime.length) cuda = 'runtime-present';
  else if (sysGpus.some(g => g.vendor === 'nvidia')) cuda = 'driver-present';
  else if (!smi) cuda = 'unknown';
  else cuda = 'missing';

  if (opts.deep) {
    const vulkanBin = findExecutable('vulkaninfo');
    if (!vulkanBin) {
      vulkan = 'unknown';
      notes.push('vulkaninfo is not installed — Vulkan support was not probed.');
    } else {
      const r = run(vulkanBin, ['--summary'], 8000);
      const blob = (r.stdout || '') + (r.stderr || '');
      if (r.status === 0 && /deviceName|GPU|deviceName\s*=/i.test(blob) && /deviceType/i.test(blob)) vulkan = 'available';
      else if (/cannot|ERROR|failed to/i.test(blob)) vulkan = 'missing';
      else vulkan = 'unknown';
    }
    const rocmBin = findExecutable('rocminfo');
    if (!rocmBin) {
      rocm = sysGpus.some(g => g.vendor === 'amd') ? 'unknown' : 'unknown';
      notes.push('rocminfo is not installed — ROCm/HIP was not probed.');
    } else {
      const r = run(rocmBin, [], 8000);
      const blob = (r.stdout || '') + (r.stderr || '');
      if (r.status === 0 && /Name:\s+.+/i.test(blob) && /Marketing Name|Device Type:\s+GPU/i.test(blob)) rocm = 'runtime-present';
      else rocm = 'missing';
    }
    const syclBin = findExecutable('sycl-ls') || findExecutable('sycl-ls.exe');
    if (!syclBin) {
      sycl = 'unknown';
      notes.push('sycl-ls is not installed — SYCL/Level Zero devices were not probed.');
    } else {
      const r = run(syclBin, [], 8000);
      const blob = (r.stdout || '') + (r.stderr || '');
      if (r.status === 0 && /\[(opencl|level_zero|cuda|hip):/i.test(blob)) sycl = 'runtime-present';
      else sycl = 'missing';
    }
  }

  const vendors = new Set(sysGpus.map(g => g.vendor).filter(v => v && v !== 'other'));
  const ccs = (nvidiaRuntime || []).map(g => g.computeCapability).filter(Boolean);

  return {
    platform: 'linux',
    arch: opts.arch || process.arch,
    cpu: {
      model: cpu.model,
      architecture: opts.arch || process.arch,
      physicalCores: cpu.physicalCores,
      logicalThreads: cpu.logicalThreads,
      flags: cpu.flags,
      isa
    },
    memory,
    gpus: sysGpus.map(g => {
      const copy = { ...g };
      delete copy._filled;
      return copy;
    }),
    vulkan,
    cuda,
    rocm,
    sycl,
    cudaVersion,
    nvidiaDriver,
    nvidia: nvidiaRuntime && nvidiaRuntime.length ? {
      name: nvidiaRuntime[0].name,
      vramMB: nvidiaRuntime[0].vramMB,
      driver: nvidiaDriver,
      cudaVersion,
      gpus: nvidiaRuntime
    } : null,
    legacyNvidia: legacy.length > 0 && modern.length === 0,
    legacyNvidiaDevices: legacy.map(g => ({ name: g.name, computeCapability: g.computeCapability })),
    mixedVendors: vendors.size > 1,
    mixedComputeCapabilities: new Set(ccs).size > 1,
    notes
  };
}

module.exports = {
  probeHardware,
  parseCpuInfo,
  parseMemInfo,
  parseNvidiaSmi,
  parseCudaVersion,
  readSysGpus,
  nvidiaProbeInfo
};
