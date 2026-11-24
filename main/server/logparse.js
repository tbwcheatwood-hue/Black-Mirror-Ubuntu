'use strict';
/**
 * Parses inference-engine log output for performance data.
 * llama.cpp llama-server prints lines like:
 *   prompt eval time     =     482.31 ms /   128 tokens (    3.77 tokens per second)
 *   eval time            =   12403.55 ms /   256 tokens (   20.64 tokens per second)
 *   load time            =   ...
 * We extract tokens/second so the dashboard shows server-reported numbers
 * (never fabricated).
 */
const PROMPT_RE = /prompt eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens\s*\(\s*([\d.]+)\s*tokens per second\)/i;
const EVAL_RE = /eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens\s*\(\s*([\d.]+)\s*tokens per second\)/i;
const LOAD_RE = /load time\s*=\s*([\d.]+)\s*ms/i;
const MODEL_LOADED_RE = /model loaded|load_tensors:.*loaded|service start|server is listening/i;

/**
 * Feed a raw log line; returns one of:
 *  { kind: 'prompt_eval', ms, tokens, tps }
 *  { kind: 'eval',        ms, tokens, tps }
 *  { kind: 'load',        ms }
 *  { kind: 'ready' }
 *  null
 */
function parseLine(line) {
  let m = line.match(PROMPT_RE);
  if (m) return { kind: 'prompt_eval', ms: parseFloat(m[1]), tokens: parseInt(m[2], 10), tps: parseFloat(m[3]) };
  m = line.match(EVAL_RE);
  if (m) return { kind: 'eval', ms: parseFloat(m[1]), tokens: parseInt(m[2], 10), tps: parseFloat(m[3]) };
  m = line.match(LOAD_RE);
  if (m) return { kind: 'load', ms: parseFloat(m[1]) };
  if (MODEL_LOADED_RE.test(line) && !/eval/i.test(line)) return { kind: 'ready' };
  return null;
}

/** Aggregate parsed stats over a stream of lines. */
function aggregate(lines) {
  const stats = {
    promptTps: null, genTps: null, lastPromptMs: null, lastGenMs: null,
    loadMs: null, readySeen: false
  };
  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.kind === 'prompt_eval') { stats.promptTps = p.tps; stats.lastPromptMs = p.ms; }
    else if (p.kind === 'eval') { stats.genTps = p.tps; stats.lastGenMs = p.ms; }
    else if (p.kind === 'load') stats.loadMs = p.ms;
    else if (p.kind === 'ready') stats.readySeen = true;
  }
  return stats;
}

module.exports = { parseLine, aggregate, PROMPT_RE, EVAL_RE };
