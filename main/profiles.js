'use strict';
/**
 * Hardware-aware recommended launch profiles.
 *
 * Recommendations are generated from DETECTED hardware, model metadata and
 * probed engine capabilities — never from benchmark results (none exist
 * unless the user runs the Benchmark Lab, and those are never used to claim
 * a profile is "faster").
 *
 * Rules:
 *  - Only parameters the probed binary supports are recommended; unknown
 *    capabilities → parameter omitted with a note.
 *  - contextLength never exceeds the model's training context.
 *  - Output is advisory. Applying a profile is an explicit user action and
 *    only fills EMPTY/unapplied form fields — it never silently overwrites
 *    an existing profile or user-selected values.
 */

const GOALS = [
  'cpu-performance', 'cpu-memory-efficient', 'igpu-experimental',
  'discrete-gpu',
  'large-context', 'moe', 'low-memory', 'max-throughput', 'custom'
];

const LABELS = {
  'cpu-performance': 'CPU Performance',
  'cpu-memory-efficient': 'CPU Memory Efficient',
  'igpu-experimental': 'Integrated GPU (experimental)',
  'discrete-gpu': 'Discrete GPU (advisory)',
  'large-context': 'Large Context',
  'moe': 'Mixture-of-Experts',
  'low-memory': 'Low Memory',
  'max-throughput': 'Maximum Throughput',
  'custom': 'Custom'
};

/**
 * @param {string} goal one of GOALS
 * @param {object} ctx { model, hardware, capabilities, engine, physicalCores }
 * @returns {id,label,description,params,notes[],assumptions[],requiresExplicitApply}
 */
function recommendProfile(goal, ctx = {}) {
  const { model, hardware, capabilities } = ctx;
  const notes = [];
  const assumptions = [];
  const caps = capabilities || null;
  const supports = (id) => !caps || !caps.helpFlags ? null : !!caps.helpFlags[id];

  // Detected CPU topology (never invented): os.cpus() count is logical cores.
  const logicalCores = ctx.logicalCores || (hardware && hardware.logicalCores) || 4;
  const threads = Math.max(2, Math.min(logicalCores - 2, 8));
  if (ctx.logicalCores == null && !(hardware && hardware.logicalCores)) {
    assumptions.push('CPU core count unknown in this context — thread suggestion defaulted to 6.');
  }
  const ctxTrain = model && model.ctxTrain ? model.ctxTrain : 8192;
  const kvOk = supports('kvCacheV');
  const faOk = supports('flashAttention');
  const moeOk = supports('cpuMoeLayers');
  const isMoE = !!(model && model.isMoE);

  const base = {
    contextLength: Math.min(8192, ctxTrain),
    threads,
    threadsBatch: threads,
    batchSize: 512,
    parallelSlots: 1,
    kvCacheType: 'f16',
    useMmap: true
  };

  switch (goal) {
    case 'cpu-performance':
      notes.push(`Threads set to ${threads} (detected ${logicalCores} logical cores minus system reserve; tune ±2 and compare in the Benchmark Lab).`);
      if (faOk) base.flashAttention = true;
      base.batchSize = 1024;
      assumptions.push('Assumes CPU-only execution; generation speed follows memory bandwidth.');
      break;
    case 'cpu-memory-efficient':
      if (kvOk) { base.kvCacheType = 'q8_0'; notes.push('KV cache quantized to q8_0 (supported by this binary) — roughly halves context memory with minimal quality impact.'); }
      else notes.push('KV cache quantization not advertised by this binary — kept f16.');
      base.batchSize = 512;
      notes.push('Memory-mapped model kept on (useMmap) so the OS can page weights under pressure.');
      break;
    case 'igpu-experimental': {
      const v = hardware && hardware.vulkan;
      if (v !== 'available' && v !== 'likely') {
        notes.push('No confirmed Vulkan runtime on this machine — this profile would likely fail to initialize. Shown as experimental; nothing is applied until you choose to.');
      }
      base.gpuLayers = 8; // conservative starting point, user-tunable
      if (faOk) base.flashAttention = true;
      notes.push('Conservative start: 8 layers offloaded. Integrated GPU shares system RAM — offload moves compute, it does not add memory. Increase gradually and watch the Performance view.');
      assumptions.push('GPU offload amount is a starting guess; the optimal value depends on model size and driver behavior — measure, do not assume.');
      break;
    }
    case 'discrete-gpu': {
      const cudaOk = hardware && hardware.cuda === 'runtime-present' && !hardware.legacyNvidia;
      const rocmOk = hardware && hardware.rocm === 'runtime-present';
      const vulkanOk = hardware && (hardware.vulkan === 'available' || hardware.vulkan === 'likely');
      if (hardware && hardware.legacyNvidia) {
        notes.push('Legacy NVIDIA compute capability (< 5.0, including Tesla K80) was reported. Do not apply a modern CUDA 12/13 offload profile. Register an older engine binary instead.');
        base.gpuLayers = 0;
      } else if (cudaOk || rocmOk) {
        base.gpuLayers = 999;
        notes.push('Runtime probe responded, so full GPU offload (-ngl 999) is a starting point only. It is not a measured result. If the GPU runs out of VRAM, lower this and re-test in Compatibility Lab.');
        if (hardware.mixedVendors) notes.push('Multiple GPU vendors are present. Do not tensor-split across vendors; pick one engine backend.');
      } else if (vulkanOk) {
        base.gpuLayers = 999;
        notes.push('Vulkan runtime looks present. Full offload is advisory — shared-memory iGPUs are often slower than CPU for large models.');
      } else {
        base.gpuLayers = 0;
        notes.push('No confirmed CUDA, ROCm or Vulkan runtime. GPU layers left at 0 so this profile cannot pretend acceleration exists.');
      }
      if (faOk && base.gpuLayers > 0) base.flashAttention = true;
      assumptions.push('Offload depth was not benchmarked. Apply explicitly, then measure.');
      break;
    }
    case 'large-context': {
      const target = Math.min(ctxTrain, 65536);
      base.contextLength = Math.max(16384, Math.min(target, 65536));
      if (kvOk) base.kvCacheType = 'q8_0';
      else notes.push('KV quantization not advertised by this binary — context memory stays at f16.');
      if (faOk) base.flashAttention = true;
      notes.push(`Context ${base.contextLength.toLocaleString()} (model trains up to ${ctxTrain.toLocaleString()}); exact value passed to the engine — never silently reduced.`);
      notes.push('Long context multiplies KV memory — check the pre-load assessment before launching.');
      break;
    }
    case 'moe': {
      if (!isMoE) notes.push('This model is not a mixture-of-experts model — the profile still applies, but expert-offload settings are irrelevant for it.');
      base.contextLength = Math.min(8192, ctxTrain);
      if (moeOk && isMoE) {
        base.cpuMoeLayers = 12;
        notes.push('Expert offload starts at 12 layers on CPU (tune 0..N): ALL experts stay resident either way — offload changes compute placement, not total memory.');
      } else if (!moeOk) {
        notes.push('CPU expert offload not advertised by this binary — parameter omitted.');
      }
      if (faOk) base.flashAttention = true;
      break;
    }
    case 'low-memory':
      base.contextLength = Math.min(2048, ctxTrain);
      if (kvOk) base.kvCacheType = 'q4_0';
      base.batchSize = 256;
      notes.push('Minimal context and batch; KV q4_0 where supported. Use when the model barely fits or other workloads need RAM.');
      assumptions.push('q4_0 KV degrades long-context quality more than q8_0 — trade-off documented, not hidden.');
      break;
    case 'max-throughput':
      base.batchSize = 2048;
      base.parallelSlots = Math.min(4, Math.max(1, Math.floor((logicalCores - 2) / 2)));
      if (faOk) base.flashAttention = true;
      notes.push(`${base.parallelSlots} parallel slots — splits context between requests; each slot gets context/${base.parallelSlots}.`);
      break;
    case 'custom':
      notes.push('Custom profile: start from your current values.');
      break;
    default:
      throw new Error(`Unknown profile goal: ${goal}`);
  }

  return {
    id: goal,
    label: LABELS[goal] || goal,
    description: notes.join(' '),
    params: base,
    notes,
    assumptions,
    requiresExplicitApply: true
  };
}

/** All goals with recommendations for a context (for the UI list). */
function recommendAll(ctx) {
  return GOALS.filter(g => g !== 'custom').map(g => recommendProfile(g, ctx));
}

module.exports = { GOALS, LABELS, recommendProfile, recommendAll };
