'use strict';
/**
 * Engine adapters: per-family logic for building server command lines,
 * probing versions, listing models and checking readiness.
 *
 * The registry supplies declarative JSON descriptors; adapters supply the
 * imperative glue. New families can be added by dropping a descriptor + an
 * adapter hook — no other code changes required.
 *
 * INVARIANT: user-configured values (especially context length) are passed
 * to the engine exactly as configured. Adapters must never silently reduce
 * or alter them.
 */
const { findExecutable, findInstalledBinary } = require('../core/util');

/**
 * Parameter schema shared by all engines (used to build the Settings UI).
 * Each field: id, label, type, min, max, step, default, engineKey.
 */
const PARAM_SCHEMA = [
  { id: 'contextLength', label: 'Context length', type: 'int', min: 512, max: 1048576, step: 512, default: 8192 },
  { id: 'threads', label: 'CPU threads', type: 'int', min: 1, max: 64, step: 1, default: 6 },
  { id: 'threadsBatch', label: 'Batch/prompt threads', type: 'int', min: 1, max: 64, step: 1, default: 6 },
  { id: 'gpuLayers', label: 'GPU layers (-ngl)', type: 'int', min: 0, max: 999, step: 1, default: 0 },
  { id: 'batchSize', label: 'Batch size', type: 'int', min: 32, max: 8192, step: 32, default: 512 },
  { id: 'parallelSlots', label: 'Parallel slots', type: 'int', min: 1, max: 16, step: 1, default: 1 },
  { id: 'temperature', label: 'Temperature', type: 'float', min: 0, max: 2, step: 0.05, default: 0.8 },
  { id: 'topP', label: 'Top P', type: 'float', min: 0, max: 1, step: 0.01, default: 0.95 },
  { id: 'topK', label: 'Top K', type: 'int', min: 0, max: 200, step: 1, default: 40 },
  { id: 'repeatPenalty', label: 'Repeat penalty', type: 'float', min: 1, max: 2, step: 0.01, default: 1.1 },
  { id: 'maxTokens', label: 'Max output tokens', type: 'int', min: 16, max: 131072, step: 16, default: 2048 },
  { id: 'kvCacheType', label: 'KV cache type', type: 'enum', options: ['f16', 'q8_0', 'q4_0'], default: 'f16' },
  { id: 'useMmap', label: 'Memory-map model file', type: 'bool', default: true },
  { id: 'flashAttention', label: 'Flash attention', type: 'bool', default: false },
  { id: 'thinkingMode', label: 'Thinking mode', type: 'enum', options: ['auto', 'on', 'off'], default: 'auto' },
  { id: 'cpuMoeLayers', label: 'CPU expert offload (MoE layers, 0=off)', type: 'int', min: 0, max: 999, step: 1, default: 0 },
  { id: 'mainGpu', label: 'Main GPU index (--main-gpu, -1 = engine default)', type: 'int', min: -1, max: 16, step: 1, default: -1 },
  { id: 'tensorSplit', label: 'Tensor split (comma ratios, e.g. 3,1)', type: 'string', default: '' },
  { id: 'splitMode', label: 'Multi-GPU split mode', type: 'enum', options: ['none', 'layer', 'row'], default: 'none' },
  { id: 'gpuDevices', label: 'GPU devices (--device, engine-specific names)', type: 'string', default: '' },
  { id: 'mmprojPath', label: 'Multimodal projector (mmproj file)', type: 'path', default: null },
  { id: 'extraArgs', label: 'Extra launch arguments (advanced, space-separated)', type: 'string', default: '' }
];

class EngineError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'EngineError';
    this.code = code || 'engine';
  }
}

/** Family: llama.cpp — llama-server with CLI flags. */
class LlamaCppAdapter {
  /**
   * @param {object} descriptor declarative engine descriptor
   * @param {object} installed install state { customPath, activeVersionDir }
   * @param {object} [capabilities] capabilities.probe() result — gates flag
   *   emission so flags unknown to the installed build are never sent.
   */
  constructor(descriptor, installed, capabilities) {
    this.d = descriptor;
    this.installed = installed || {};
    this.caps = capabilities || null;
    this._supported = capabilities
      ? require('./capabilities').supportedServerFlags(capabilities)
      : null;
  }

  /** Emit a flag only when the probed binary supports it (null = omit). */
  _flag(id, flag, ...values) {
    if (this._supported && !this._supported.has(id)) return null;
    return values.length ? [flag, ...values.map(String)] : [flag];
  }

  executablePath() {
    const bin = this.d.serverBinary;
    const exe = process.platform === 'win32' ? bin + '.exe' : bin;
    // 1) explicit custom path from user settings
    if (this.installed.customPath) {
      const p = findExecutable(this.installed.customPath);
      if (p) return p;
      throw new EngineError(`Configured executable not found: ${this.installed.customPath}`, 'binary-missing');
    }
    // 2) active installed version dir (root, bin/, build/bin/, or one wrapper folder)
    const active = this.installed.activeVersionDir;
    if (active) {
      const p = findInstalledBinary(active, exe);
      if (p) return p;
    }
    // 3) PATH
    const onPath = findExecutable(exe);
    if (onPath) return onPath;
    throw new EngineError(
      `llama-server not found for engine "${this.d.id}". Install it in Inference Engines, or set a custom executable path.`,
      'binary-missing');
  }

  /**
   * Map Black Mirror params → llama-server CLI args.
   * Every user value is passed through verbatim; undefined values are omitted.
   * Context length is passed EXACTLY as configured. No silent reduction.
   */
  buildServerArgs(modelPath, params, network) {
    const p = params || {};
    const num = (v, dflt) => (typeof v === 'number' && !isNaN(v) ? v : dflt);
    const args = ['-m', modelPath, '--host', network.bind, '--port', String(network.port)];
    const jinja = this._flag('jinja', '--jinja');
    if (jinja) args.push(...jinja);

    args.push('--ctx-size', String(num(p.contextLength, 8192)));
    if (p.threads !== undefined && p.threads !== null) args.push('--threads', String(p.threads));
    if (p.threadsBatch !== undefined && p.threadsBatch !== null) args.push('--threads-batch', String(p.threadsBatch));
    if (p.gpuLayers !== undefined && p.gpuLayers !== null) args.push('--n-gpu-layers', String(p.gpuLayers));
    if (p.batchSize !== undefined && p.batchSize !== null) args.push('--batch-size', String(p.batchSize));
    if (p.parallelSlots !== undefined && p.parallelSlots !== null && p.parallelSlots > 1) {
      const par = this._flag('parallelSlots', '--parallel', p.parallelSlots);
      if (par) args.push(...par);
    }
    if (p.kvCacheType && p.kvCacheType !== 'f16') {
      const k = this._flag('kvCacheK', '--cache-type-k', p.kvCacheType);
      if (k) args.push(...k);
      const v = this._flag('kvCacheV', '--cache-type-v', p.kvCacheType);
      if (v) args.push(...v);
    }
    if (p.useMmap === false) args.push('--no-mmap');
    if (p.flashAttention) {
      const fa = this._flag('flashAttention', '--flash-attn');
      if (fa) args.push(...fa);
    }
    // Thinking mode (llama.cpp b12359+):
    //   on   → structured reasoning extraction + reasoning switch on
    //   off  → --reasoning off and --reasoning-budget 0 (forces end-of-think)
    //   auto → leave server defaults; per-request kwargs still apply
    if (p.thinkingMode === 'on') {
      const rf = this._flag('thinking', '--reasoning-format', 'deepseek');
      if (rf) args.push(...rf);
      const rs = this._flag('reasoningSwitch', '--reasoning', 'on');
      if (rs) args.push(...rs);
    } else if (p.thinkingMode === 'off') {
      const rs = this._flag('reasoningSwitch', '--reasoning', 'off');
      if (rs) args.push(...rs);
      const rb = this._flag('reasoningBudget', '--reasoning-budget', 0);
      if (rb) args.push(...rb);
      // Always keep jinja so chat_template_kwargs / budget interact with templates.
      if (!args.includes('--jinja')) {
        const jinjaOff = this._flag('jinja', '--jinja');
        if (jinjaOff) args.push(...jinjaOff);
      }
    }
    if (p.cpuMoeLayers) {
      const moe = this._flag('cpuMoeLayers', '--n-cpu-moe', p.cpuMoeLayers);
      if (moe) args.push(...moe);
    }
    if (p.mainGpu !== undefined && p.mainGpu !== null && p.mainGpu !== '' && Number(p.mainGpu) >= 0) {
      const mg = this._flag('mainGpu', '--main-gpu', p.mainGpu);
      if (mg) args.push(...mg);
    }
    if (p.tensorSplit && String(p.tensorSplit).trim()) {
      const ts = this._flag('tensorSplit', '--tensor-split', String(p.tensorSplit).trim());
      if (ts) args.push(...ts);
    }
    if (p.splitMode && p.splitMode !== 'none') {
      const sm = this._flag('splitMode', '--split-mode', p.splitMode);
      if (sm) args.push(...sm);
    }
    if (p.gpuDevices && String(p.gpuDevices).trim()) {
      const dv = this._flag('gpuDevices', '--device', String(p.gpuDevices).trim());
      if (dv) args.push(...dv);
    }
    if (p.mmprojPath) {
      const mm = this._flag('mmproj', '--mmproj', p.mmprojPath);
      if (mm) args.push(...mm);
    }
    if (p.extraArgs) {
      for (const a of String(p.extraArgs).split(/\s+/).filter(Boolean)) args.push(a);
    }
    return args;
  }

  /**
   * Chat-time sampling params (sent per request, OpenAI body).
   * thinkingMode: 'off' explicitly disables thinking via chat_template_kwargs
   * (llama.cpp + --jinja); 'auto' leaves the model's default untouched.
   */
  buildRequestOverrides(params) {
    const p = params || {};
    const out = {};
    if (p.temperature !== undefined) out.temperature = p.temperature;
    if (p.topP !== undefined) out.top_p = p.topP;
    if (p.topK !== undefined) out.top_k = p.topK;           // llama.cpp extension
    if (p.repeatPenalty !== undefined) out.repeat_penalty = p.repeatPenalty; // llama.cpp extension
    if (p.maxTokens !== undefined) out.max_tokens = p.maxTokens;
    if (p.thinkingMode === 'off') {
      // Explicit disable — never merely omit the parameter.
      // chat_template_kwargs covers Qwen3/Qwen3.5 jinja templates;
      // reasoning_budget 0 covers models that open a think tag by default.
      out.chat_template_kwargs = { enable_thinking: false };
      out.reasoning_budget = 0;
      out.think = false;
    } else if (p.thinkingMode === 'on') {
      out.chat_template_kwargs = { enable_thinking: true };
      out.think = true;
    }
    return out;
  }

  static parseVersionOutput(text, regexStr) {
    const re = new RegExp(regexStr);
    const m = String(text || '').match(re);
    if (m) return { build: m[1], commit: m[2] || null, label: `b${m[1]}${m[2] ? ' (' + m[2] + ')' : ''}` };
    // llama.cpp b12678+: "version: 1.0.0-dev (build 12678, commit c74c71a6f)"
    const modern = String(text || '').match(/version:\s*\S+\s*\(build\s+(\d+),\s*commit\s+([0-9a-f]+)\)/i);
    if (modern) return { build: modern[1], commit: modern[2], label: `b${modern[1]} (${modern[2]})` };
    return null;
  }

  async listModels() {
    return null; // llama.cpp loads explicit GGUF paths; library-driven
  }
}

/** Family: Ollama — externally managed service, models from its registry. */
class OllamaAdapter {
  constructor(descriptor, installed) {
    this.d = descriptor;
    this.installed = installed || {};
  }

  executablePath() {
    const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
    if (this.installed.customPath) {
      const p = findExecutable(this.installed.customPath);
      if (p) return p;
      throw new EngineError(`Configured ollama executable not found: ${this.installed.customPath}`, 'binary-missing');
    }
    const active = this.installed.activeVersionDir;
    if (active) {
      const p = findInstalledBinary(active, exe);
      if (p) return p;
    }
    const onPath = findExecutable(exe);
    if (onPath) return onPath;
    throw new EngineError('Ollama not found. Install it (Inference Engines → Install) or set a custom path.', 'binary-missing');
  }

  buildServerArgs() { return ['serve']; }

  /**
   * Isolate a Black Mirror-managed Ollama from any system install.
   * Models land under the app data directory, not ~/.ollama.
   */
  buildServerEnv(network, dataDir) {
    const path = require('path');
    const host = `${network && network.bind ? network.bind : '127.0.0.1'}:${network && network.port ? network.port : 11434}`;
    const env = { OLLAMA_HOST: host };
    if (dataDir) env.OLLAMA_MODELS = path.join(dataDir, 'ollama-models');
    return env;
  }

  /**
   * thinkingMode tri-state: 'on' → think:true, 'off' → think:false (explicit
   * disable — Ollama models with thinking enabled by default REQUIRE the
   * explicit false, omission would leave them thinking), 'auto'/undefined →
   * engine default.
   */
  buildRequestOverrides(params, model, thinkingMode) {
    const p = params || {};
    const opts = {};
    if (p.temperature !== undefined) opts.temperature = p.temperature;
    if (p.topP !== undefined) opts.top_p = p.topP;
    if (p.topK !== undefined) opts.top_k = p.topK;
    if (p.repeatPenalty !== undefined) opts.repeat_penalty = p.repeatPenalty;
    if (p.maxTokens !== undefined) opts.num_predict = p.maxTokens;
    if (p.contextLength !== undefined) opts.num_ctx = p.contextLength; // exact, never reduced
    const out = { options: opts };
    if (thinkingMode === 'on') out.think = true;
    else if (thinkingMode === 'off') out.think = false;
    return out;
  }

  static parseVersionOutput(text, regexStr) {
    const m = text.match(new RegExp(regexStr));
    return m ? { build: m[1], commit: null, label: m[1] } : null;
  }

  async listModels(baseUrl, fetchImpl) {
    const res = await (fetchImpl || fetch)(`${baseUrl}/api/tags`);
    if (!res.ok) throw new EngineError(`Ollama API error ${res.status}`, 'api');
    const data = await res.json();
    return (data.models || []).map(m => ({
      id: m.name,
      displayName: m.name,
      sizeBytes: m.size,
      quant: (m.details && m.details.quantization_level) || null,
      architecture: (m.details && m.details.family) || null,
      parameterSize: (m.details && m.details.parameter_size) || null
    }));
  }
}

/** Family: Lemonade — portable server, OpenAI-compatible on its own port. */
class LemonadeAdapter {
  constructor(descriptor, installed) {
    this.d = descriptor;
    this.installed = installed || {};
  }

  executablePath() {
    const exe = process.platform === 'win32' ? 'lemonade-server.exe' : 'lemonade-server';
    if (this.installed.customPath) {
      const p = findExecutable(this.installed.customPath);
      if (p) return p;
      throw new EngineError(`Configured lemonade executable not found: ${this.installed.customPath}`, 'binary-missing');
    }
    const active = this.installed.activeVersionDir;
    if (active) {
      const p = findInstalledBinary(active, exe);
      if (p) return p;
    }
    const onPath = findExecutable(exe);
    if (onPath) return onPath;
    throw new EngineError('Lemonade Server not found. Install it from Inference Engines.', 'binary-missing');
  }

  buildServerArgs(modelName, params, network) {
    const args = ['serve'];
    if (network && network.port) args.push('--port', String(network.port));
    if (network && network.bind && network.bind !== '127.0.0.1') args.push('--host', network.bind);
    if (params && params.extraArgs) {
      for (const a of String(params.extraArgs).split(/\s+/).filter(Boolean)) args.push(a);
    }
    return args;
  }

  buildRequestOverrides(params) {
    const p = params || {};
    const out = {};
    if (p.temperature !== undefined) out.temperature = p.temperature;
    if (p.topP !== undefined) out.top_p = p.topP;
    if (p.maxTokens !== undefined) out.max_tokens = p.maxTokens;
    return out;
  }

  static parseVersionOutput(text, regexStr) {
    const m = text.match(new RegExp(regexStr));
    return m ? { build: m[1], commit: null, label: m[1] } : null;
  }

  async listModels(baseUrl, fetchImpl) {
    const res = await (fetchImpl || fetch)(`${baseUrl}/api/v1/models`);
    if (!res.ok) throw new EngineError(`Lemonade API error ${res.status}`, 'api');
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.models || data.data || []);
    return list.map(m => ({
      id: m.id || m.model || m.name,
      displayName: m.name || m.id || m.model,
      sizeBytes: m.size || null,
      quant: null, architecture: null, parameterSize: null
    }));
  }
}

/**
 * Family: LM Studio — the server runs inside LM Studio's own daemon, so its
 * descriptor is lifecycle "attach" (see ServerController): Black Mirror
 * connects to it and never spawns, loads or stops anything. Chat requests
 * address models by the key LM Studio lists.
 */
class LmStudioAdapter {
  constructor(descriptor, installed) {
    this.d = descriptor;
    this.installed = installed || {};
  }

  executablePath() {
    const exe = this.d.serverBinary || 'lms';
    if (this.installed.customPath) {
      const p = findExecutable(this.installed.customPath);
      if (p) return p;
      throw new EngineError(`Configured executable not found: ${this.installed.customPath}`, 'binary-missing');
    }
    const onPath = findExecutable(exe);
    if (onPath) return onPath;
    throw new EngineError(`${this.d.displayName || 'LM Studio'} CLI ("${exe}") not found. Install it or set a custom executable path.`, 'binary-missing');
  }

  buildRequestOverrides(params) {
    const p = params || {};
    const out = {};
    if (p.temperature !== undefined) out.temperature = p.temperature;
    if (p.topP !== undefined) out.top_p = p.topP;
    if (p.maxTokens !== undefined) out.max_tokens = p.maxTokens;
    return out;
  }

  static parseVersionOutput(text, regexStr) {
    const m = String(text || '').match(new RegExp(regexStr));
    return m ? { build: m[1], commit: null, label: m[1] } : null;
  }

  /**
   * Models in the engine's library that can answer chat requests, with their
   * current load state (embedding models are left out). Also the reachability
   * check: an unreachable server fails with guidance on how to start it.
   */
  async listModels(baseUrl, fetchImpl) {
    let res;
    try {
      res = await (fetchImpl || fetch)(`${baseUrl}/api/v0/models`, { signal: AbortSignal.timeout(8000) });
    } catch (e) {
      throw new EngineError(
        `LM Studio's local server is not reachable at ${baseUrl} (${e.message}). Start it in LM Studio (Developer → Start Server) or run "lms server start".`,
        'unreachable');
    }
    if (!res.ok) throw new EngineError(`LM Studio API error ${res.status} at ${baseUrl}`, 'api');
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.models || data.data || []);
    return list
      .filter(m => (m.type || 'llm') !== 'embeddings')
      .map(m => ({
        id: m.id || m.model || m.name,
        displayName: m.id || m.model || m.name,
        state: m.state || null,
        quant: m.quantization || null,
        architecture: m.arch || null,
        parameterSize: null
      }));
  }
}

const FAMILY_CLASSES = {
  'llama.cpp': LlamaCppAdapter,
  'ollama': OllamaAdapter,
  'lemonade': LemonadeAdapter,
  'lmstudio': LmStudioAdapter
};

function createAdapter(descriptor, installed, capabilities) {
  const Cls = FAMILY_CLASSES[descriptor.family];
  if (!Cls) throw new EngineError(`Unknown engine family "${descriptor.family}"`, 'family');
  return new Cls(descriptor, installed, capabilities);
}

module.exports = { PARAM_SCHEMA, EngineError, LlamaCppAdapter, OllamaAdapter, LemonadeAdapter, LmStudioAdapter, createAdapter, FAMILY_CLASSES };
