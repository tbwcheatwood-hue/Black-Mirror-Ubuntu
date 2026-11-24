'use strict';
/**
 * Engine capability discovery.
 *
 * Learns what an engine binary ACTUALLY supports by probing its own
 * metadata (`--help`, `--list-devices`, version output) instead of assuming.
 * The result gates flag emission (an argument the binary does not know can
 * never be sent) and populates the capability report in the UI.
 *
 * Results are cached per executable path + mtime.
 */
const fs = require('fs');
const { spawnSync } = require('child_process');

const cache = new Map();

/** Flags llama.cpp may or may not support depending on build/version. */
const LLAMA_HELP_FLAGS = [
  { flag: '--reasoning-format', id: 'thinking', affects: 'server' },
  { flag: '--reasoning', alt: '-rea', id: 'reasoningSwitch', affects: 'server' },
  { flag: '--reasoning-budget', id: 'reasoningBudget', affects: 'server' },
  { flag: '--chat-template-kwargs', id: 'chatTemplateKwargs', affects: 'server' },
  { flag: '--n-cpu-moe', id: 'cpuMoeLayers', affects: 'server' },
  { flag: '--cache-type-v', id: 'kvCacheV', affects: 'server' },
  { flag: '--cache-type-k', id: 'kvCacheK', affects: 'server' },
  { flag: '--flash-attn', alt: '-fa', id: 'flashAttention', affects: 'server' },
  { flag: '--mmproj', id: 'mmproj', affects: 'server' },
  { flag: '--jinja', id: 'jinja', affects: 'server' },
  { flag: '--parallel', alt: '-np', id: 'parallelSlots', affects: 'server' },
  { flag: '--no-mmap', id: 'useMmapToggle', affects: 'server' },
  { flag: '--ctx-size', alt: '-c', id: 'contextLength', affects: 'server' },
  { flag: '--mlock', id: 'mlock', affects: 'server' },
  { flag: '--host', id: 'hostBind', affects: 'server' },
  { flag: '--main-gpu', id: 'mainGpu', affects: 'server' },
  { flag: '--tensor-split', id: 'tensorSplit', affects: 'server' },
  { flag: '--split-mode', id: 'splitMode', affects: 'server' },
  { flag: '--device', id: 'gpuDevices', affects: 'server' }
];

function probe(exe, opts = {}) {
  const stats = fs.existsSync(exe) ? fs.statSync(exe) : null;
  const key = `${exe}:${stats ? stats.mtimeMs : 'missing'}`;
  if (cache.has(key)) return cache.get(key);
  const result = _probeUncached(exe, opts);
  cache.set(key, result);
  return result;
}

function _probeUncached(exe, opts = {}) {
  const caps = {
    probed: false,
    probeError: null,
    helpFlags: {},          // flag id -> true when seen in --help
    devices: [],            // [{ id, description }] from --list-devices
    rawVersion: null
  };
  try {
    const help = spawnSync(exe, ['--help'], { timeout: opts.timeout || 15000, encoding: 'utf8', windowsHide: true });
    const text = (help.stdout || '') + (help.stderr || '');
    caps.probed = help.status === 0 || text.length > 0;
    caps.probeError = caps.probed ? null : `exit ${help.status}`;
    for (const f of LLAMA_HELP_FLAGS) {
      const needle = (f.alt ? f.flag + '|' + f.alt : f.flag);
      const re = new RegExp(`(?:${needle.replace(/[-]/g, '\\$&')})[\\s,)]`);
      caps.helpFlags[f.id] = re.test(text);
    }
  } catch (e) {
    caps.probeError = e.message;
  }
  // Device listing (llama-server --list-devices, Vulkan/SYCL/CUDA builds)
  try {
    const dev = spawnSync(exe, ['--list-devices'], { timeout: 15000, encoding: 'utf8', windowsHide: true });
    const out = (dev.stdout || '') + (dev.stderr || '');
    caps.devices = parseDevices(out);
  } catch (_) { /* optional */ }
  return caps;
}

/** Parse `--list-devices` output: lines like `ggml_vulkan: Device 0: Intel(R)...` */
function parseDevices(text) {
  const devices = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/(ggml_\w+|vulkan|sycl|cuda|opencl|openvino)\s*:\s*(?:Device\s*\d+\s*:\s*)?(.{4,})$/i);
    if (m) devices.push({ backend: m[1].toLowerCase(), description: m[2].trim() });
  }
  return devices;
}

/**
 * Map probed capabilities + descriptor hints into a UI-facing capability set.
 * Unknown probe → conservative nulls so the UI can show "undetermined".
 */
function summarize(descriptor, caps) {
  const fam = descriptor.family;
  if (fam === 'ollama') {
    return { probed: true, thinking: 'request-flag', images: true, reasoningSeparation: 'delta.reasoning', note: 'Capabilities from Ollama API (fixed surface).' };
  }
  if (fam === 'lemonade') {
    return { probed: true, thinking: 'model-dependent', images: false, reasoningSeparation: null, note: 'Capabilities depend on the selected Lemonade model/backend.' };
  }
  if (!caps || !caps.probed) {
    return { probed: false, thinking: null, images: null, note: caps && caps.probeError ? `binary probe failed: ${caps.probeError}` : 'binary not probeable' };
  }
  return {
    probed: true,
    thinking: (caps.helpFlags.thinking || caps.helpFlags.reasoningSwitch || caps.helpFlags.reasoningBudget)
      ? (caps.helpFlags.reasoningSwitch ? 'reasoning-switch' : 'reasoning-format')
      : 'unknown',
    chatTemplate: caps.helpFlags.jinja ? 'jinja' : 'builtin',
    reasoningBudget: !!caps.helpFlags.reasoningBudget,
    reasoningSwitch: !!caps.helpFlags.reasoningSwitch,
    images: caps.helpFlags.mmproj ? 'mmproj-supported' : false,
    kvCacheTypes: caps.helpFlags.kvCacheV ? ['f16', 'q8_0', 'q4_0'] : (caps.helpFlags.kvCacheK ? ['f16', 'q8_0'] : ['f16']),
    flashAttention: !!caps.helpFlags.flashAttention,
    cpuMoeOffload: !!caps.helpFlags.cpuMoeLayers,
    parallelSlots: !!caps.helpFlags.parallelSlots,
    devices: caps.devices,
    note: caps.devices.length ? `detected devices: ${caps.devices.map(d => d.description).join('; ')}` : null
  };
}

/** The set of server flags the binary supports (for gated arg emission). */
function supportedServerFlags(caps) {
  if (!caps || !caps.helpFlags) return null; // unknown → adapter emits everything (legacy behavior)
  return new Set(Object.entries(caps.helpFlags).filter(([, v]) => v).map(([k]) => k));
}

function clearCache() { cache.clear(); }

module.exports = { probe, parseDevices, summarize, supportedServerFlags, LLAMA_HELP_FLAGS, clearCache };
