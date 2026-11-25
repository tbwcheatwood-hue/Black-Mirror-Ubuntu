'use strict';
/**
 * Engine registry: discovery, installation state, versioning, selection.
 *
 * Installed layout (under <dataDir>/engines):
 *   <dataDir>/engines/<engineId>/<tag>/...      extracted engine binaries
 *   <dataDir>/engines.json                      installed registry + settings
 *
 * engines.json shape:
 * {
 *   "llamacpp-vulkan": {
 *      "customPath": null,                       // user override, highest priority
 *      "versions": [ { "tag":"b12359", "dir": "...", "installedAt": 1, "label":"b12359" } ],
 *      "activeTag": "b12359",
 *      "settings": { "port": 8082, "bind": "127.0.0.1" }
 *   }
 * }
 *
 * Descriptors: builtin JSON files in main/engines/builtin + any *.json the
 * user drops into <dataDir>/engines.d/ (extensibility without code changes).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { JsonStore } = require('../core/store');
const { EngineError, createAdapter } = require('./adapters');

const DEFAULT_ENGINE_STORE = {};

class EngineRegistry {
  constructor(dataDir, logger, opts = {}) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.enginesDir = path.join(dataDir, 'engines');
    fs.mkdirSync(this.enginesDir, { recursive: true });
    this.store = new JsonStore(path.join(dataDir, 'engines.json'), DEFAULT_ENGINE_STORE);
    this.store.load();
    this.builtinDir = opts.builtinDir || path.join(__dirname, 'builtin');
    this.userDir = path.join(dataDir, 'engines.d');
    this.fetchImpl = opts.fetchImpl || fetch;
    // Production: only load descriptors for the running OS. Tests may relax.
    this.osFilter = opts.osFilter !== undefined ? opts.osFilter : process.platform;
    this._descriptors = null;
  }

  /** All descriptors (builtin + user). */
  descriptors() {
    if (this._descriptors) return this._descriptors;
    const list = [];
    const read = (dir) => {
      try {
        for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
          try { list.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); }
          catch (e) { if (this.logger) this.logger.warn('registry', `bad descriptor ${f}: ${e.message}`); }
        }
      } catch (_) { /* dir missing */ }
    };
    read(this.builtinDir);
    read(this.userDir);
    const seen = new Set();
    this._descriptors = list.filter(d => {
      if (!d.id || seen.has(d.id)) return false;
      if (this.osFilter && (!Array.isArray(d.os) || !d.os.includes(this.osFilter))) return false;
      seen.add(d.id);
      return true;
    });
    return this._descriptors;
  }

  descriptor(engineId) {
    const d = this.descriptors().find(x => x.id === engineId);
    if (!d) throw new EngineError(`Unknown engine "${engineId}"`, 'unknown-engine');
    return d;
  }

  /** Installed-state record for an engine (creates lazily). */
  state(engineId) {
    if (!this.store.data[engineId]) {
      this.store.data[engineId] = { customPath: null, versions: [], activeTag: null, settings: {} };
      this.store.save();
    }
    return this.store.data[engineId];
  }

  activeVersionDir(engineId) {
    const st = this.store.data[engineId];
    if (!st || !st.activeTag) return null;
    const v = (st.versions || []).find(v => v.tag === st.activeTag);
    return v ? v.dir : null;
  }

  /** Register an installed version and optionally make it active. */
  registerVersion(engineId, tag, dir, { activate = true, label } = {}) {
    const st = this.state(engineId);
    const existing = st.versions.find(v => v.tag === tag);
    if (existing) {
      existing.dir = dir;
      existing.installedAt = existing.installedAt || Date.now();
    } else {
      st.versions.push({ tag, dir, installedAt: Date.now(), label: label || tag });
    }
    if (activate || !st.activeTag) st.activeTag = tag;
    this.store.save();
    return this.state(engineId);
  }

  removeVersion(engineId, tag) {
    const st = this.state(engineId);
    st.versions = st.versions.filter(v => v.tag !== tag);
    if (st.activeTag === tag) {
      st.activeTag = st.versions.length ? st.versions[st.versions.length - 1].tag : null;
    }
    this.store.save();
    return st;
  }

  /** Rollback = activate an older installed version. */
  setActiveVersion(engineId, tag) {
    const st = this.state(engineId);
    if (!st.versions.find(v => v.tag === tag)) {
      throw new EngineError(`Version ${tag} of ${engineId} is not installed`, 'not-installed');
    }
    st.activeTag = tag;
    this.store.save();
    return st;
  }

  setCustomPath(engineId, customPath) {
    const st = this.state(engineId);
    st.customPath = customPath || null;
    this.store.save();
    return st;
  }

  updateSettings(engineId, settings) {
    const st = this.state(engineId);
    st.settings = { ...st.settings, ...settings };
    this.store.save();
    return st;
  }

  /** Create the right adapter bound to current install state (capability-probed). */
  adapter(engineId, capabilities) {
    const d = this.descriptor(engineId);
    const installed = {
      customPath: this.store.data[engineId]?.customPath || null,
      activeVersionDir: this.activeVersionDir(engineId)
    };
    return createAdapter(d, installed, capabilities);
  }

  /** Probe the engine version via its CLI. Returns null when unavailable. */
  probeVersion(engineId) {
    const d = this.descriptor(engineId);
    const installed = {
      customPath: this.store.data[engineId]?.customPath || null,
      activeVersionDir: this.activeVersionDir(engineId)
    };
    const adapter = createAdapter(d, installed);
    return this._probe(d, adapter);
  }

  /**
   * Full status snapshot for the UI: one entry per engine with install
   * state, versions, version probe, hardware compatibility, executable.
   *
   * statusCategory taxonomy (mutually exclusive):
   *  - 'not-installed'  no binary known to Black Mirror
   *  - 'error'          binary exists but probing failed unexpectedly
   *  - 'available'      binary works; safe on any hardware
   *  - 'compatible'     works + acceleration runtime confirmed present
   *  - 'experimental'   binary works but the acceleration runtime is
   *                     unverified on this machine — serve may fail with a
   *                     clear error (reported honestly, never hidden)
   */
  async status(opts = {}) {
    const hardware = this.hardwareInfo();
    const out = [];
    for (const d of this.descriptors()) {
      const st = this.store.data[d.id] || {};
      const versions = st.versions || [];
      const installed = {
        customPath: st.customPath || null,
        activeVersionDir: this.activeVersionDir(d.id)
      };
      let adapter = null;
      let executable = null;
      let version = null;
      let error = null;
      let caps = null;
      try {
        adapter = createAdapter(d, installed);
        executable = adapter.executablePath();
        version = this._probe(d, adapter);
        if (d.family === 'llama.cpp') {
          const { probe: probeCaps, summarize } = require('./capabilities');
          caps = probeCaps(executable, opts);
          adapter.caps = caps;
          adapter._supported = require('./capabilities').supportedServerFlags(caps);
        }
      } catch (e) {
        error = e.message;
      }
      const hwCategory = this._hardwareCategory(d, hardware, caps);
      let statusCategory;
      if (error && !versions.length && !st.customPath) statusCategory = 'not-installed';
      else if (error) statusCategory = 'error';
      else if (hwCategory === 'experimental') statusCategory = 'experimental';
      else if (hwCategory === 'compatible') statusCategory = 'compatible';
      else statusCategory = 'available';
      out.push({
        id: d.id,
        family: d.family,
        displayName: d.displayName,
        acceleration: d.acceleration,
        modernCudaMinCC: d.modernCudaMinCC || null,
        capabilities: d.capabilities,
        probedCapabilities: d.family === 'llama.cpp' ? require('./capabilities').summarize(d, caps) : null,
        probedHelpFlags: caps ? caps.helpFlags : null,
        hardware: d.hardware,
        install: d.install,
        defaultPort: d.defaultPort,
        defaultBind: d.defaultBind,
        installed: versions.length > 0 || !!st.customPath,
        versions: versions.map(v => ({ tag: v.tag, label: v.label || v.tag, installedAt: v.installedAt, active: v.tag === st.activeTag })),
        activeTag: st.activeTag || null,
        customPath: st.customPath || null,
        executable,
        version,
        error,
        settings: st.settings || {},
        status: error ? (versions.length ? 'error' : 'not-installed') : 'available',
        statusCategory,
        statusReason: this._statusReason(d, hwCategory, hardware)
      });
    }
    return out;
  }

  /**
   * Classify acceleration fit for this machine. Never guesses a working
   * state that was not probed.
   */
  _hardwareCategory(d, hardware, caps) {
    if (d.acceleration === 'cpu') return 'compatible';
    if (d.acceleration === 'gpu-vulkan') {
      if (hardware.vulkan === 'available' || hardware.vulkan === 'likely') return 'compatible';
      return 'experimental';
    }
    if (d.acceleration === 'gpu-sycl') {
      if (hardware.sycl === 'runtime-present' || (caps && caps.devices && caps.devices.length)) return 'compatible';
      return 'experimental';
    }
    if (d.acceleration === 'gpu-cuda') {
      if (hardware.legacyNvidia && d.modernCudaMinCC) return 'experimental';
      if (hardware.nvidia && hardware.nvidia.gpus.some(g => g.computeMajor == null)) return 'experimental'; // capability unknown
      if (hardware.cuda === 'runtime-present') return 'compatible';
      return 'experimental';
    }
    if (d.acceleration === 'gpu-rocm') {
      if (hardware.rocm === 'runtime-present') return 'compatible';
      return 'experimental';
    }
    return 'available';
  }

  /** Run the version probe CLI and parse with the family's static parser. */
  _probe(d, adapter) {
    let exe;
    try { exe = adapter.executablePath(); } catch (_) { return null; }
    try {
      const res = spawnSync(exe, d.versionProbe.args, { timeout: 8000, encoding: 'utf8', windowsHide: true });
      const out = (res.stdout || '') + (res.stderr || '');
      const Cls = require('./adapters').FAMILY_CLASSES[d.family];
      return Cls.parseVersionOutput(out, d.versionProbe.regex);
    } catch (_) {
      return null;
    }
  }

  _statusReason(d, hwCategory, hardware) {
    if (d.acceleration === 'gpu-cuda' && hardware && hardware.legacyNvidia && d.modernCudaMinCC) {
      const devs = (hardware.legacyNvidiaDevices || []).map(g => `${g.name || 'NVIDIA GPU'} (cc ${g.computeCapability})`).join(', ');
      return `Modern CUDA ${d.modernCudaMinCC}+ builds do not support this GPU (${devs || 'compute capability below 5.0'}). Kepler-class cards such as Tesla K80 need an older CUDA 11-era llama.cpp binary registered as a custom executable path. Presence of the card is not a working acceleration claim.`;
    }
    if (hwCategory === 'experimental' && d.acceleration === 'gpu-cuda' && hardware && hardware.nvidia && hardware.nvidia.gpus.some(g => g.computeMajor == null)) {
      return `The NVIDIA driver responded but does not report compute capability, so this app cannot tell whether these GPUs (${hardware.nvidia.gpus.map(g => g.name || 'NVIDIA GPU').join(', ')}) meet the CUDA ${d.modernCudaMinCC}+ requirement of this build. Check the card's capability before installing.`;
    }
    if (hwCategory === 'experimental') {
      return 'Acceleration runtime not confirmed on this machine — serve attempts may fail with a clear error. This is not a claim that GPU inference works.';
    }
    if (hwCategory === 'compatible' && d.acceleration && d.acceleration !== 'cpu') {
      return 'A runtime probe responded. That only means the toolchain is present — run Compatibility Lab before treating a model as verified on this GPU.';
    }
    return null;
  }

  /** Hardware compatibility detection (best effort, honest about unknowns). */
  hardwareInfo() {
    const now = Date.now();
    if (this._hwCache && now - this._hwCache.at < 15000) return this._hwCache.info;
    const info = this._hardwareInfoUncached();
    this._hwCache = { at: now, info };
    return info;
  }

  _hardwareInfoUncached() {
    const os = require('os');
    if (process.platform === 'linux') {
      const { probeHardware } = require('../monitor/linuxprobe');
      const hw = probeHardware({ deep: true });
      const threads = hw.cpu.logicalThreads || os.cpus().length;
      return {
        platform: 'linux',
        arch: hw.arch,
        cpuModel: hw.cpu.model || (os.cpus()[0] ? os.cpus()[0].model.trim() : 'unknown'),
        cpuCores: threads,
        logicalCores: threads,
        physicalCores: hw.cpu.physicalCores,
        cpuFlags: hw.cpu.isa,
        totalMemBytes: hw.memory.totalBytes || os.totalmem(),
        availableMemBytes: hw.memory.availableBytes,
        swapTotalBytes: hw.memory.swapTotalBytes,
        swapUsedBytes: hw.memory.swapUsedBytes,
        vulkan: hw.vulkan,
        sycl: hw.sycl,
        cuda: hw.cuda,
        rocm: hw.rocm,
        cudaVersion: hw.cudaVersion,
        nvidiaDriver: hw.nvidiaDriver,
        nvidia: hw.nvidia,
        gpus: hw.gpus,
        legacyNvidia: !!hw.legacyNvidia,
        legacyNvidiaDevices: hw.legacyNvidiaDevices || [],
        mixedVendors: !!hw.mixedVendors,
        notes: hw.notes
      };
    }
    const info = {
      platform: process.platform,
      arch: os.arch(),
      cpuModel: os.cpus()[0] ? os.cpus()[0].model.trim() : 'unknown',
      cpuCores: os.cpus().length,
      logicalCores: os.cpus().length,
      physicalCores: null,
      totalMemBytes: os.totalmem(),
      vulkan: 'unknown',
      sycl: 'unknown',
      cuda: 'unknown',
      rocm: 'unknown',
      nvidia: null,
      gpus: [],
      legacyNvidia: false,
      notes: []
    };
    if (process.platform === 'win32') {
      try {
        const r = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total,driver_version,compute_cap', '--format=csv,noheader'], { timeout: 5000, encoding: 'utf8', windowsHide: true });
        if (r.status === 0 && r.stdout.trim()) {
          const { parseNvidiaSmi, parseCudaVersion } = require('../monitor/linuxprobe');
          const parsed = parseNvidiaSmi(r.stdout);
          const head = spawnSync('nvidia-smi', [], { timeout: 5000, encoding: 'utf8', windowsHide: true });
          info.nvidia = parsed[0] ? { name: parsed[0].name, vramMB: parsed[0].vramMB, driver: parsed[0].driver, cudaVersion: parseCudaVersion((head.stdout || '') + (head.stderr || '')), gpus: parsed } : null;
          info.gpus = parsed;
          info.cuda = parsed.length ? 'runtime-present' : 'unknown';
          info.cudaVersion = info.nvidia && info.nvidia.cudaVersion;
          info.legacyNvidia = parsed.length > 0 && parsed.every(g => g.computeMajor != null && g.computeMajor < 5);
          info.legacyNvidiaDevices = parsed.filter(g => g.computeMajor != null && g.computeMajor < 5).map(g => ({ name: g.name, computeCapability: g.computeCapability }));
          info.vulkan = 'likely';
        }
      } catch (_) { /* not present */ }
      try {
        const r = spawnSync('vulkaninfo', ['--summary'], { timeout: 5000, encoding: 'utf8', windowsHide: true });
        if (r.status === 0 && /deviceName|GPU/i.test(r.stdout || '')) info.vulkan = 'available';
        else if (r.status !== 0 && /ERROR|not found|Vulkandk/i.test((r.stdout || '') + (r.stderr || ''))) info.vulkan = 'missing';
      } catch (_) { /* vulkaninfo not installed — stays 'unknown' */ }
      const fs2 = require('fs');
      let zeLoader = false;
      try {
        const sysdir = (process.env.SystemRoot || 'C:\\Windows') + '\\System32';
        if (fs2.existsSync(path.join(sysdir, 'ze_loader.dll'))) zeLoader = true;
      } catch (_) { /* ignore */ }
      info.sycl = zeLoader ? 'runtime-present' : 'unknown';
    }
    return info;
  }
}

module.exports = { EngineRegistry, EngineError };
