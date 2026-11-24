'use strict';
/**
 * Model memory estimation and pre-load assessment.
 *
 * Estimates are labeled as estimates everywhere in the UI. They follow the
 * standard llama.cpp-community approximation:
 *   weights  ≈ file size (the GGUF already contains quantized weights)
 *   KV cache ≈ n_ctx × n_layers × (K + V dims) × bytes_per_element
 *   overhead ≈ compute buffers + graph reserve (arch-aware constant)
 *
 * Never used to block the user — only to warn.
 */
const BPW = {
  F32: 32, F16: 16, BF16: 16,
  Q8_0: 8.5, Q8_1: 9.5,
  Q6_K: 6.59, Q5_K_M: 5.69, Q5_K_S: 5.54, Q5_0: 5.54, Q5_1: 6.0,
  Q4_K_M: 4.85, Q4_K_S: 4.58, Q4_0: 4.55, Q4_1: 5.0, IQ4_XS: 4.25, IQ4_NL: 4.5,
  Q3_K_L: 3.5, Q3_K_M: 3.91, Q3_K_S: 3.5, IQ3_XS: 3.3, IQ3_S: 3.44, IQ3_M: 3.66, IQ3_XXS: 3.06,
  Q2_K: 2.62, Q2_K_S: 2.56, IQ2_XS: 2.31, IQ2_S: 2.5, IQ2_M: 2.7, IQ2_XXS: 2.06,
  IQ1_S: 1.56, IQ1_M: 1.75,
  TQ1_0: 1.69, TQ2_0: 2.06, MXFP4: 4.25
};

const KV_BYTES = { f16: 2, bf16: 2, q8_0: 1, q4_0: 0.5 };

function bitsPerWeight(quant) {
  if (!quant) return null;
  // Normalize "mostly q4_K_M", "Q4_K_M", "q4-k-m" → "Q4_K_M"
  const q = String(quant).replace(/[\s-]+/g, '_').replace(/^MOSTLY_/i, '').toUpperCase();
  if (BPW[q] !== undefined) return BPW[q];
  const m = q.match(/^Q(\d)_/);
  if (m) return Number(m[1]) + 0.5;
  return null;
}

/** Bytes per token per layer for the KV cache (K and V combined). */
function kvBytesPerTokenPerLayer(model, kvCacheType) {
  const nEmbd = model.nEmbd || 0;
  const nHead = model.nHead || 0;
  const nHeadKv = model.nHeadKv || nHead || 0;
  const kDim = model.keyLength ?? (nHead ? Math.round(nEmbd * nHeadKv / nHead) : nEmbd);
  const vDim = model.valueLength ?? kDim;
  const bytes = KV_BYTES[kvCacheType] ?? KV_BYTES.f16;
  return (kDim + vDim) * bytes;
}

/**
 * @param {object} model summary from gguf.summarize()
 * @param {object} opts { contextLength, kvCacheType }
 * @returns {{weightsBytes, kvBytes, overheadBytes, totalBytes, totalBytesMax, paramCountEstimate}}
 */
function estimateMemory(model, opts = {}) {
  const ctx = opts.contextLength || model.ctxTrain || 4096;
  const weights = model.sizeBytes || 0;
  const layers = model.nLayers || 0;
  const kvPerTokenPerLayer = kvBytesPerTokenPerLayer(model, opts.kvCacheType);
  const kvTotalPerToken = layers * kvPerTokenPerLayer;
  const kv = kvTotalPerToken * ctx;
  // Compute buffers: llama.cpp graph reserves scale with context and arch;
  // a pragmatic constant of 0.75–2 GB covers most modern models.
  const isMoE = model.isMoE;
  const overhead = Math.max(512 * 1024 * 1024, Math.min(2 * 1024 * 1024 * 1024, ctx * layers * 320));
  const paramCountEstimate = weights && bitsPerWeight(model.quant)
    ? Math.round(weights / (bitsPerWeight(model.quant) / 8))
    : null;
  const mmproj = opts.mmprojBytes || 0;
  return {
    weightsBytes: weights + mmproj,
    kvBytes: kv,
    computeBufBytes: overhead,
    overheadBytes: overhead, // legacy field name
    mmprojBytes: mmproj,
    totalBytes: weights + mmproj + kv + overhead,
    totalBytesMax: weights + mmproj + kv * (isMoE ? 1.05 : 1.0) + overhead * 1.1,
    uncertainty: 'weights from file size (±2%), KV from architecture math (±5%), compute buffer from a 0.5–2 GB documented allowance (±30%) — ESTIMATES, not measurements',
    paramCountEstimate,
    kvPerTokenBytes: kvPerTokenPerLayer,
    kvTotalPerTokenBytes: kvTotalPerToken,
    isMoE,
    moeActiveVsTotal: isMoE ? `speed follows ${model.expertUsed} active experts/token; memory follows all ${model.expertCount} resident` : null
  };
}

/**
 * Pre-load assessment. Returns a structured warning, never a block.
 * @param {object} model  gguf summary
 * @param {object} memory estimateMemory() result
 * @param {object} avail  { freeBytes, totalBytes } currently available RAM
 * @param {number} contextLength chosen context
 * @param {number} parallelSlots n_parallel value (scales KV cache)
 */
function assess(model, memory, avail, contextLength, parallelSlots = 1) {
  const notes = [];
  let level = 'ok';
  const need = memory.totalBytes * Math.max(1, parallelSlots * 0.92 + 0.08); // KV shared but not fully
  const free = avail.freeBytes ?? avail.totalBytes ?? 0;
  const ratio = avail.totalBytes ? need / avail.totalBytes : null;

  if (free && need > free * 0.95) {
    level = 'danger';
    notes.push(`Estimated ${fmtGB(need)} needed but only ${fmtGB(free)} is free. Loading will very likely fail or push the system into heavy paging.`);
  } else if (ratio !== null && ratio > 0.85) {
    level = 'warning';
    notes.push(`Estimated ${fmtGB(need)} is above 85% of total RAM (${fmtGB(avail.totalBytes)}). The system may become unresponsive under load.`);
  } else if (ratio !== null && ratio > 0.7) {
    level = 'caution';
    notes.push(`Estimated ${fmtGB(need)} is a large share of your ${fmtGB(avail.totalBytes)} RAM. Close other heavy applications before loading.`);
  }

  if (avail.totalBytes && avail.totalBytes < 8 * 1024 ** 3) {
    notes.push('System has less than 8 GB of RAM; models above ~4 GB will not fit comfortably.');
  }
  // Windows commit headroom: a load that fits physical RAM can still fail or
  // force pagefile growth when the commit charge is near its limit.
  if (avail.commitFreeBytes != null) {
    if (need > avail.commitFreeBytes) {
      if (level === 'ok') level = 'warning';
      notes.push(`Estimated ${fmtGB(need)} exceeds the remaining Windows commit charge headroom (${fmtGB(avail.commitFreeBytes)} of commit limit free). The load may fail or grow the pagefile.`);
    } else if (need > avail.commitFreeBytes * 0.9 && level === 'ok') {
      level = 'caution';
      notes.push(`Loading will consume most of the remaining commit charge headroom (${fmtGB(avail.commitFreeBytes)} free of the commit limit).`);
    }
  }
  if (model.isMoE) {
    notes.push(`MoE model: ${model.expertCount} experts (${model.expertUsed} active per token). All expert weights stay resident in memory.`);
  }
  if (contextLength > 32768) {
    notes.push(`Context of ${contextLength.toLocaleString()} tokens multiplies KV cache memory — reduce it if memory pressure appears.`);
  }
  return {
    level, need, free, notes,
    fitsProbably: level !== 'danger',
    estimateBasis: 'file size (quantized weights) + KV cache model + graph overhead allowance — an estimate, not a measurement'
  };
}

function fmtGB(b) {
  return (b / (1024 ** 3)).toFixed(1) + ' GB';
}

module.exports = { BPW, KV_BYTES, bitsPerWeight, estimateMemory, assess, kvBytesPerTokenPerLayer };
