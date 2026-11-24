'use strict';
/**
 * Compatibility assessment — pure logic, no I/O.
 *
 * Combines model metadata (CONFIRMED by GGUF parsing), engine capabilities
 * (CONFIRMED by binary probing), machine hardware (MEASURED where possible)
 * and the launch configuration into an honest verdict:
 *
 *   verified-compatible   a saved lab test PASSED for exactly this
 *                         model+engine version+acceleration+profile and its
 *                         inputs have not changed since (staleness checked
 *                         by the caller)
 *   likely-compatible     static analysis found no blockers on this machine
 *   experimental          plausible but unverified acceleration/runtime
 *   insufficient-information  missing inputs (e.g. engine not probed)
 *   unsupported           concrete contradiction found
 *   previously-failed     a saved lab test FAILED for this exact configuration
 *
 * A CLI flag's existence does NOT prove a model architecture is supported —
 * the assessor treats capability evidence as necessary, not sufficient, and
 * says so in its reasons.
 */

const STATUS = {
  VERIFIED: 'verified-compatible',
  LIKELY: 'likely-compatible',
  EXPERIMENTAL: 'experimental',
  INFO: 'insufficient-information',
  UNSUPPORTED: 'unsupported',
  FAILED: 'previously-failed'
};

/**
 * @param {object} input
 *   model          library model entry (metadata confirmed by GGUF parse)
 *   engine         descriptor-level status entry from registry.status()
 *   hardware       registry.hardwareInfo() result
 *   memory         { totalBytes, freeBytes, commitFreeBytes? }
 *   savedResult    most recent saved lab result for this key or null
 *   requested      { engineTag?, accel?, params? } launch configuration
 */
function assessCompatibility(input) {
  const { model, engine, hardware, memory, savedResult, requested } = input;
  const reasons = [];
  const checks = [];
  const params = (requested && requested.params) || {};

  if (!model || model.invalid) {
    return { status: STATUS.UNSUPPORTED, reasons: ['Model file is missing, unreadable or not a valid GGUF.'], checks: [{ id: 'model', ok: false, detail: 'model metadata unavailable' }] };
  }
  if (model.split && model.splitComplete === false) {
    return {
      status: STATUS.UNSUPPORTED,
      reasons: [`Split model is incomplete: missing shard(s) ${model.splitMissingShards.join(', ')} of ${model.split.total}. Load would fail.`],
      checks: [{ id: 'split-complete', ok: false, detail: `${model.split.total - model.splitMissingShards.length}/${model.split.total} shards present` }]
    };
  }
  checks.push({ id: 'model', ok: true, detail: `${model.architecture || 'unknown arch'} · ${model.quant || '?'} · ${model.isMoE ? `MoE ${model.expertCount}e (${model.expertUsed} active)` : 'dense'}${model.split ? ` · split ${model.split.total} shards` : ''} — from GGUF metadata (confirmed)` });
  if (model.kind === 'mmproj') {
    return { status: STATUS.UNSUPPORTED, reasons: ['Multimodal projector files are not loadable models — pair them with a model in the launch form.'], checks };
  }

  if (!engine) {
    return { status: STATUS.INFO, reasons: ['Engine unknown — pick an installed inference engine.'], checks };
  }
  const accel = (requested && requested.accel) || engine.acceleration;
  if (!engine.installed) {
    return { status: STATUS.INFO, reasons: [`Engine "${engine.displayName}" is not installed, so compatibility cannot be evaluated. Install it or pick another engine.`], checks: [...checks, { id: 'engine-installed', ok: null, detail: 'not installed' }] };
  }
  if (engine.status !== 'available' && engine.statusCategory !== 'experimental') {
    return { status: STATUS.INFO, reasons: [`Engine probe failed: ${engine.error || 'unknown error'}.`], checks };
  }

  // Saved-result evidence (highest evidentiary value, staleness pre-checked)
  if (savedResult && !savedResult.stale) {
    checks.push({ id: 'saved-test', ok: savedResult.outcome === 'pass', detail: `lab test ${savedResult.outcome} at ${new Date(savedResult.at).toISOString()} (model mtime, engine version and app version unchanged)` });
    if (savedResult.outcome === 'fail') {
      const failedStages = (savedResult.stages || []).filter(s => s.ok === false).map(s => s.stage);
      return { status: STATUS.FAILED, reasons: [`The manual compatibility test FAILED for exactly this configuration (failed stage(s): ${failedStages.join(', ') || 'unknown'}). See the saved diagnostics. Re-run the test after changing the configuration.`], checks, measured: savedResult.measured || null };
    }
    if (savedResult.outcome === 'pass' && (savedResult.stages || []).some(s => s.stage === 'inference')) {
      return { status: STATUS.VERIFIED, reasons: ['A manual compatibility test passed for exactly this model, engine version, acceleration and profile — including real model load and inference. Evidence saved in this lab.'], checks, measured: savedResult.measured || null };
    }
  }

  // Static analysis on probed capabilities
  const caps = engine.probedCapabilities || null;
  if (!caps || !caps.probed) {
    reasons.push(`Engine binary could not be probed (${caps && caps.note ? caps.note : 'no capability report'}) — assessment is based on metadata only.`);
    checks.push({ id: 'capabilities', ok: null, detail: 'not probed' });
  } else {
    checks.push({ id: 'capabilities', ok: true, detail: 'probed from the installed binary' });
    if (params.kvCacheType && params.kvCacheType !== 'f16' && Array.isArray(caps.kvCacheTypes) && !caps.kvCacheTypes.includes(params.kvCacheType)) {
      reasons.push(`KV cache type "${params.kvCacheType}" was not among the formats the binary advertises (${caps.kvCacheTypes.join('/')}).`);
      checks.push({ id: 'kv-cache', ok: false, detail: `${params.kvCacheType} not in ${caps.kvCacheTypes.join('/')}` });
    }
    if (params.mmprojPath && caps.images !== 'mmproj-supported' && engine.family === 'llama.cpp') {
      reasons.push('A multimodal projector was selected but this binary did not advertise --mmproj support; images will not work.');
      checks.push({ id: 'mmproj', ok: false, detail: 'flag not advertised by binary' });
    }
  }

  // Acceleration vs hardware (never claims working without evidence)
  if (accel === 'gpu-vulkan') {
    const v = hardware && hardware.vulkan;
    if (v === 'available' || v === 'likely') {
      reasons.push(`Vulkan runtime detected on this machine (${v}) — GPU offload is plausible but only a lab test proves model+driver cooperation for THIS model size.`);
      checks.push({ id: 'accel', ok: true, detail: `vulkan ${v}` });
      if (!savedResult) return { status: STATUS.EXPERIMENTAL, reasons, checks };
    } else {
      reasons.push('No confirmed Vulkan runtime on this machine — treat GPU offload as experimental at best; the serve attempt may fail with a clear driver error.');
      checks.push({ id: 'accel', ok: null, detail: `vulkan ${v || 'unknown'}` });
      if (!savedResult) return { status: STATUS.EXPERIMENTAL, reasons, checks };
    }
  } else if (accel === 'gpu-sycl') {
    const sz = hardware && hardware.sycl;
    if (sz !== 'runtime-present') {
      reasons.push('Intel Level Zero / SYCL runtime not detected — SYCL acceleration will likely fail to initialize. CPU engines remain unaffected.');
      checks.push({ id: 'accel', ok: false, detail: `sycl ${sz || 'missing'}` });
      if (!savedResult) return { status: STATUS.EXPERIMENTAL, reasons, checks };
    } else {
      reasons.push('sycl-ls (or an equivalent probe) reported a device. That is not a completed inference test.');
      checks.push({ id: 'accel', ok: true, detail: 'sycl runtime-present' });
      if (!savedResult) return { status: STATUS.EXPERIMENTAL, reasons, checks };
    }
  } else if (accel === 'gpu-cuda') {
    if (hardware && hardware.legacyNvidia && engine.modernCudaMinCC) {
      const devs = (hardware.legacyNvidiaDevices || []).map(g => `${g.name || 'GPU'} cc ${g.computeCapability}`).join(', ');
      reasons.push(`This engine requires NVIDIA compute capability >= ${engine.modernCudaMinCC}. Detected legacy device(s): ${devs || 'cc < 5.0'}. CUDA 12/13 llama.cpp builds do not support Kepler (Tesla K80 is cc 3.7). Use a custom executable path to an older CUDA 11 build compiled for that card. No inference was claimed.`);
      checks.push({ id: 'accel', ok: false, detail: 'legacy NVIDIA vs modern CUDA build' });
      return { status: STATUS.UNSUPPORTED, reasons, checks };
    }
    if (hardware && hardware.mixedVendors && params.tensorSplit) {
      reasons.push('Tensor split was requested but this machine reports GPUs from more than one vendor. A single llama.cpp process cannot mix CUDA and ROCm/Vulkan devices. Pick one backend and one vendor.');
      checks.push({ id: 'accel', ok: false, detail: 'mixed vendors with tensor split' });
      return { status: STATUS.UNSUPPORTED, reasons, checks };
    }
    if (hardware && hardware.cuda === 'runtime-present') {
      reasons.push('nvidia-smi returned a device. CUDA runtime presence is not proof this model loads on this GPU — run Compatibility Lab.');
      checks.push({ id: 'accel', ok: true, detail: 'cuda runtime-present' });
      if (!savedResult) return { status: STATUS.EXPERIMENTAL, reasons, checks };
    } else {
      reasons.push('CUDA runtime was not confirmed (nvidia-smi did not report a usable device). Do not treat this engine as functional.');
      checks.push({ id: 'accel', ok: null, detail: `cuda ${(hardware && hardware.cuda) || 'unknown'}` });
      if (!savedResult) return { status: STATUS.EXPERIMENTAL, reasons, checks };
    }
  } else if (accel === 'gpu-rocm') {
    if (hardware && hardware.mixedVendors && params.tensorSplit) {
      reasons.push('Tensor split across different GPU vendors is not supported in one process.');
      checks.push({ id: 'accel', ok: false, detail: 'mixed vendors' });
      return { status: STATUS.UNSUPPORTED, reasons, checks };
    }
    if (hardware && hardware.rocm === 'runtime-present') {
      reasons.push('rocminfo responded. That does not prove HIP/ROCm inference for this model. Run Compatibility Lab.');
      checks.push({ id: 'accel', ok: true, detail: 'rocm runtime-present' });
      if (!savedResult) return { status: STATUS.EXPERIMENTAL, reasons, checks };
    } else {
      reasons.push('ROCm runtime was not confirmed (rocminfo missing or did not list a GPU). AMD GPU sysfs entries, if any, are not a working ROCm stack.');
      checks.push({ id: 'accel', ok: null, detail: `rocm ${(hardware && hardware.rocm) || 'unknown'}` });
      if (!savedResult) return { status: STATUS.EXPERIMENTAL, reasons, checks };
    }
  } else {
    checks.push({ id: 'accel', ok: true, detail: 'cpu — no special runtime required' });
  }

  // Memory feasibility (estimate, clearly labeled)
  const needBytes = estimateNeed(input);
  if (needBytes && memory && memory.totalBytes) {
    const ratio = needBytes / Math.max(1, memory.freeBytes);
    checks.push({ id: 'memory', ok: ratio < 0.9, detail: `estimated ${fmt(needBytes)} vs ${fmt(memory.freeBytes)} free (estimate = weights + KV + compute allowance, uncertainty ±15%)` });
    if (ratio > 1.1) {
      reasons.push(`Estimated memory need (${fmt(needBytes)}) exceeds currently free RAM (${fmt(memory.freeBytes)}). Loading will very likely fail or thrash.`);
      return { status: STATUS.UNSUPPORTED, reasons, checks };
    }
    if (ratio > 0.85) reasons.push(`Estimated need (${fmt(needBytes)}) is close to or above 85% of free RAM (${fmt(memory.freeBytes)}) — feasible but tight; close other applications.`);
    if (memory.commitFreeBytes != null && needBytes > memory.commitFreeBytes) {
      const headroom = hardware && hardware.platform === 'linux'
        ? 'remaining Linux commit/swap headroom'
        : 'remaining Windows commit charge headroom';
      reasons.push(`Estimated need exceeds the ${headroom} (${fmt(memory.commitFreeBytes)}) — the load may fail even though physical RAM appears sufficient.`);
    }
    // iGPU shares system memory: offload does not add a memory pool
    if (/gpu/i.test(accel) && (hardware && hardware.gpuShared !== false)) {
      reasons.push('Integrated GPU offload shares the same physical RAM — offloading moves compute, it does not add memory capacity.');
    }
  }

  // MoE-specific guidance
  if (model.isMoE) {
    reasons.push(`MoE model: all ${model.expertCount} experts stay resident (total weights), while only ${model.expertUsed} are active per token (compute). Memory estimates must use TOTAL weights, speed follows ACTIVE parameters.`);
    if (engine.family === 'llama.cpp' && caps && caps.cpuMoeOffload && params.cpuMoeLayers > 0) {
      reasons.push(`CPU expert offload requested for ${params.cpuMoeLayers} layer(s) — supported by this binary per its --help probe; behavior for this model is lab-testable.`);
    }
  }

  if (!reasons.length) {
    reasons.push('Static analysis found no blockers: the model metadata parses, the engine binary is installed and probeable, the requested acceleration needs no unverified runtime, and the estimated memory fits comfortably.');
  }
  return { status: STATUS.LIKELY, reasons, checks };
}

/** Total estimated need = weights (+mmproj) + KV + documented compute allowance. */
function estimateNeed({ model }) {
  if (!model) return null;
  const weights = model.splitTotalBytes || model.sizeBytes || 0;
  const proj = model.mmprojSizeBytes || 0;
  const kv = model.kvCacheBytes || 0;
  const compute = model.computeBufBytes || 0;
  if (!weights) return null;
  return weights + proj + kv + compute;
}

function fmt(b) { return (b / (1024 ** 3)).toFixed(1) + ' GB'; }

module.exports = { assessCompatibility, STATUS, estimateNeed };
