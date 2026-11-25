'use strict';
/**
 * Bridge: the single seam between the UI and the backend.
 * In Electron, window.blackMirror comes from preload.cjs.
 * In a plain browser (interface preview / screenshots), MockBridge provides
 * simulated data with a local in-browser fake inference stream, so the UI
 * can be previewed and screenshotted without Electron.
 */
class MockBridge {
  constructor() {
    this.preview = true;
    this._convs = JSON.parse(localStorage.getItem('bm-mock-convs') || 'null') || [];
    this._servers = [];
    this._remotes = [];
    this._config = {
      firstRunDone: true,
      defaultEngineId: 'llamacpp-vulkan',
      network: { bind: '127.0.0.1', defaultPort: 8081 },
      params: { contextLength: 8192, threads: 6, gpuLayers: 8, batchSize: 512, parallelSlots: 1, temperature: 0.8, topP: 0.95, topK: 40, repeatPenalty: 1.1, maxTokens: 2048, kvCacheType: 'f16', useMmap: true, flashAttention: false, thinkingMode: 'on' },
      chat: { stream: true, showThinking: true },
      monitor: { intervalMs: 2000 },
      logging: { level: 'info' }
    };
    this._models = [
      { path: 'C:\\models\\qwen3-30b-a3b-instruct-q4_k_m.gguf', fileName: 'qwen3-30b-a3b-instruct-q4_k_m.gguf', name: 'Qwen3 30B A3B Instruct', architecture: 'qwen3moe', quant: 'Q4_K_M', sizeBytes: 18.6e9, sizeMB: 17738, nLayers: 48, ctxTrain: 40960, isMoE: true, expertCount: 128, expertUsed: 8, favorite: true, hasProfile: false, categories: ['coding'], error: null, invalid: false },
      { path: 'C:\\models\\qwen3-8b-q6_k.gguf', fileName: 'qwen3-8b-q6_k.gguf', name: 'Qwen3 8B', architecture: 'qwen3', quant: 'Q6_K', sizeBytes: 6.7e9, sizeMB: 6387, nLayers: 36, ctxTrain: 40960, isMoE: false, favorite: true, hasProfile: true, categories: ['general'], error: null, invalid: false },
      { path: 'C:\\models\\llama-3.1-8b-instruct-q8_0.gguf', fileName: 'llama-3.1-8b-instruct-q8_0.gguf', name: 'Llama 3.1 8B Instruct', architecture: 'llama', quant: 'Q8_0', sizeBytes: 8.5e9, sizeMB: 8105, nLayers: 32, ctxTrain: 131072, isMoE: false, favorite: false, hasProfile: false, categories: ['general'], error: null, invalid: false },
      { path: 'C:\\models\\deepseek-r1-distill-qwen-14b-q4_k_m.gguf', fileName: 'deepseek-r1-distill-qwen-14b-q4_k_m.gguf', name: 'DeepSeek R1 Distill 14B', architecture: 'qwen2', quant: 'Q4_K_M', sizeBytes: 9.0e9, sizeMB: 8580, nLayers: 48, ctxTrain: 131072, isMoE: false, favorite: false, hasProfile: false, categories: ['reasoning'], error: null, invalid: false },
      { path: 'C:\\models\\mistral-nemo-12b-q5_k_m.gguf', fileName: 'mistral-nemo-12b-q5_k_m.gguf', name: 'Mistral Nemo 12B', architecture: 'mistral', quant: 'Q5_K_M', sizeBytes: 8.7e9, sizeMB: 8298, nLayers: 40, ctxTrain: 131072, isMoE: false, favorite: false, hasProfile: false, categories: [], error: null, invalid: false },
      { path: 'C:\\models\\incomplete-dl.gguf', fileName: 'incomplete-dl.gguf', name: 'incomplete-dl.gguf', sizeBytes: 1.2e9, sizeMB: 1144, invalid: true, error: 'File appears truncated or still downloading', favorite: false, hasProfile: false, categories: [] }
    ];
    this._engines = [
      { id: 'llamacpp-cpu', displayName: 'llama.cpp (CPU)', acceleration: 'cpu', defaultPort: 8081, status: 'available', installed: true, activeTag: 'b12359', versions: [{ tag: 'b12359', label: 'b12359', active: true, installedAt: 1764000000000 }], version: { label: 'b12359 (8f3c21d)' }, error: null, capabilities: { thinking: 'reasoning-format', images: false }, hardware: { notes: 'Pure CPU inference — the safe default on Intel UHD 770 systems.' }, probedCapabilities: { probed: true, thinking: 'reasoning-format', chatTemplate: 'jinja', images: false, kvCacheTypes: ['f16','q8_0','q4_0'], flashAttention: true, cpuMoeOffload: true, devices: [], note: null } },
      { id: 'llamacpp-vulkan', displayName: 'llama.cpp (Vulkan)', acceleration: 'gpu-vulkan', defaultPort: 8082, status: 'available', installed: true, activeTag: 'b12359', versions: [{ tag: 'b12359', label: 'b12359', active: true, installedAt: 1764000000000 }], version: { label: 'b12359 (8f3c21d)' }, error: null, capabilities: { thinking: 'reasoning-format', images: false }, hardware: { notes: 'UHD 770 exposes Vulkan via the Intel driver; partial offload works best.' }, probedCapabilities: { probed: true, thinking: 'reasoning-format', chatTemplate: 'jinja', images: false, kvCacheTypes: ['f16','q8_0','q4_0'], flashAttention: true, cpuMoeOffload: true, devices: [{ backend: 'ggml_vulkan', description: 'Intel(R) UHD Graphics 770' }], note: 'detected devices: Intel(R) UHD Graphics 770' } },
      { id: 'llamacpp-sycl', displayName: 'llama.cpp (SYCL)', acceleration: 'gpu-sycl', defaultPort: 8083, status: 'not-installed', installed: false, versions: [], error: null, capabilities: {}, hardware: { notes: 'Requires Intel compute runtime (Level Zero). Reported honestly when the device is missing.' } },
      { id: 'ollama', displayName: 'Ollama', acceleration: 'engine-managed', defaultPort: 11434, status: 'not-installed', installed: false, versions: [], error: null, capabilities: { thinking: 'request-flag', images: true }, hardware: { notes: 'Externally managed service; Black Mirror controls only processes it started.' } },
      { id: 'lemonade', displayName: 'Lemonade Server', acceleration: 'engine-managed', defaultPort: 8000, status: 'not-installed', installed: false, versions: [], error: null, capabilities: {}, hardware: { notes: 'AMD Lemonade — embeddable, portable, OpenAI-compatible.' } }
    ];
  }

  _persistConvs() { localStorage.setItem('bm-mock-convs', JSON.stringify(this._convs)); }

  getConfig() { return Promise.resolve(structuredClone(this._config)); }
  setConfig(path, v) { return Promise.resolve(v); }
  setParams(patch) { Object.assign(this._config.params, patch); return Promise.resolve(this._config.params); }

  library = {
    refresh: () => Promise.resolve({ total: this._models.length, added: 0, invalid: 1, models: this._models }),
    list: () => Promise.resolve(this._models),
    get: (p) => Promise.resolve(this._models.find(m => m.path === p) || null),
    addScanDir: () => Promise.resolve('C:\\models'),
    removeScanDir: () => Promise.resolve(true),
    listScanDirs: () => Promise.resolve(['C:\\models', 'D:\\llm\\gguf']),
    mmprojFor: () => Promise.resolve([]),
    importFile: () => Promise.resolve(this._models[0]),
    toggleFavorite: (p) => {
      const m = this._models.find(x => x.path === p);
      if (m) m.favorite = !m.favorite;
      return Promise.resolve(!!m && m.favorite);
    },
    setCategories: () => Promise.resolve(true),
    categories: () => Promise.resolve([{ name: 'general', count: 2 }, { name: 'coding', count: 1 }, { name: 'reasoning', count: 1 }]),
    getProfile: () => Promise.resolve(null),
    saveProfile: () => Promise.resolve({ savedAt: Date.now() }),
    deleteProfile: () => Promise.resolve(true),
    assess: (p, contextLength) => {
      const m = this._models.find(x => x.path === p) || this._models[0];
      const total = 44e9, free = 21.4e9;
      const kv = Math.round((m.nLayers || 32) * 512 * (contextLength || 8192));
      const need = m.sizeBytes + kv + 1.2e9;
      const ratio = need / total;
      return Promise.resolve({
        estimate: { weightsBytes: m.sizeBytes, kvBytes: kv, overheadBytes: 1.2e9, totalBytes: need, kvPerTokenBytes: 512 },
        verdict: { level: ratio > 0.85 ? 'warning' : ratio > 0.7 ? 'caution' : 'ok', need, free, notes: m.isMoE ? ['MoE model: all expert weights stay resident.'] : [] }
      });
    }
  };

  engines = {
    status: () => Promise.resolve(structuredClone(this._engines)),
    hardware: () => Promise.resolve({
      cpuModel: '12th Gen Intel(R) Core(TM) i5-12500', cpuCores: 12,
      totalMemBytes: 44e9, platform: 'win32', arch: 'x64',
      vulkan: 'likely', sycl: 'runtime-present', nvidia: null
    }),
    install: () => Promise.resolve({}),
    uninstall: () => Promise.resolve(true),
    setActive: () => Promise.resolve(true),
    setCustomPath: () => Promise.resolve(true),
    updateSettings: () => Promise.resolve(true),
    paramSchema: () => Promise.resolve([
      { id: 'contextLength', label: 'Context length', type: 'int', min: 512, max: 131072, step: 512, default: 8192 },
      { id: 'threads', label: 'CPU threads', type: 'int', min: 1, max: 64, default: 6 },
      { id: 'gpuLayers', label: 'GPU layers (-ngl)', type: 'int', min: 0, max: 999, default: 0 },
      { id: 'batchSize', label: 'Batch size', type: 'int', min: 32, max: 8192, default: 512 },
      { id: 'parallelSlots', label: 'Parallel slots', type: 'int', min: 1, max: 16, default: 1 },
      { id: 'temperature', label: 'Temperature', type: 'float', min: 0, max: 2, step: 0.05, default: 0.8 },
      { id: 'topP', label: 'Top P', type: 'float', min: 0, max: 1, step: 0.01, default: 0.95 },
      { id: 'topK', label: 'Top K', type: 'int', min: 0, max: 200, default: 40 },
      { id: 'repeatPenalty', label: 'Repeat penalty', type: 'float', min: 1, max: 2, step: 0.01, default: 1.1 },
      { id: 'maxTokens', label: 'Max output tokens', type: 'int', min: 16, max: 131072, default: 2048 },
      { id: 'kvCacheType', label: 'KV cache type', type: 'enum', options: ['f16', 'q8_0', 'q4_0'], default: 'f16' },
      { id: 'useMmap', label: 'Memory-map model file', type: 'bool', default: true },
      { id: 'flashAttention', label: 'Flash attention', type: 'bool', default: false },
      { id: 'thinkingMode', label: 'Thinking mode', type: 'bool', default: false }
    ])
  };

  servers = {
    list: () => Promise.resolve([...(this._remotes || []), ...this._servers]),
    external: () => Promise.resolve([]),
    start: (opts) => {
      const s = { id: 'srv-' + (this._servers.length + 1), pid: 40000 + Math.floor(Math.random() * 9000), engineId: opts.engineId, model: opts.modelPath, displayName: opts.modelDisplayName || (opts.modelPath || '').split('\\').pop(), port: opts.port, bind: opts.bind || '127.0.0.1', status: 'running', mode: 'managed', startedAt: Date.now(), baseUrl: `http://127.0.0.1:${opts.port}`, logLines: 3 };
      this._servers.push(s);
      this._emit('server-state', this._servers);
      return Promise.resolve(s);
    },
    stop: (id) => {
      this._servers = this._servers.filter(s => s.id !== id);
      this._emit('server-state', this._servers);
      return Promise.resolve(true);
    },
    restart: (id) => Promise.resolve(this._servers[0] || null),
    engineModels: (engineId) => Promise.resolve(engineId === 'ollama' ? [{ id: 'qwen3:8b', displayName: 'qwen3:8b', quant: 'Q4_K_M', parameterSize: '8.2B' }] : [{ id: 'Llama-3.2-1B-Instruct-Hybrid', displayName: 'Llama 3.2 1B Instruct (Hybrid)' }]),
    addRemote: (opts) => { const r = { id: 'remote-' + Date.now(), label: opts.label || opts.baseUrl, baseUrl: opts.baseUrl, model: null, status: 'unknown', mode: 'remote' }; this._remotes.push(r); this._emit('server-state', this._remotes); return Promise.resolve(r); },
    removeRemote: (id) => { this._remotes = this._remotes.filter(r => r.id !== id); this._emit('server-state', this._remotes); return Promise.resolve(true); },
    testRemote: () => Promise.resolve({ ok: true, latencyMs: 12, models: ['llama3.2:1b'] }),
    logs: () => Promise.resolve([
      '[out] build: 1234 (8f3c21d)',
      '[out] system info: n_threads = 6 | AVX = 1 | AVX2 = 1',
      '[out] llama_model_load: model size  18.6 GiB',
      '[out] server is listening on http://127.0.0.1:8081 - starting the main loop',
      '[out] prompt eval time     =   1210.84 ms /   512 tokens (  422.86 tokens per second)',
      '[out] eval time            =  19874.23 ms /   389 tokens (   19.57 tokens per second)'
    ])
  };

  chat = {
    list: () => Promise.resolve(this._convs.map(c => ({ ...c, messageCount: (c.messages || []).length }))),
    get: (id) => Promise.resolve(this._convs.find(c => c.id === id) || null),
    create: (opts = {}) => {
      const c = { id: String(Date.now()), title: opts.title || 'New conversation', messages: [], createdAt: Date.now(), updatedAt: Date.now(), model: opts.model || null, systemPrompt: opts.systemPrompt || '', stats: { promptTokens: 0, completionTokens: 0 } };
      this._convs.unshift(c);
      this._persistConvs();
      return Promise.resolve(c);
    },
    append: (id, msg) => {
      const c = this._convs.find(x => x.id === id);
      if (!c) return Promise.reject(new Error('no conv'));
      const m = { id: 'm' + Math.random().toString(36).slice(2), role: msg.role, content: msg.content, reasoning: msg.reasoning || null, usage: msg.usage || null, tps: msg.tps || null, ts: Date.now() };
      c.messages.push(m);
      c.updatedAt = Date.now();
      if (!c.titleSet && m.role === 'user') { c.title = m.content.slice(0, 60); c.titleSet = true; }
      this._persistConvs();
      return Promise.resolve(m);
    },
    updateMessage: () => Promise.resolve(true),
    truncateFrom: () => Promise.resolve(true),
    setMeta: (id, patch) => {
      const c = this._convs.find(x => x.id === id);
      if (!c) return Promise.resolve(null);
      Object.assign(c, patch || {});
      return Promise.resolve(c);
    },
    remove: (id) => { this._convs = this._convs.filter(c => c.id !== id); this._persistConvs(); return Promise.resolve(true); },
    search: (q) => Promise.resolve(this._convs.filter(c => JSON.stringify(c).toLowerCase().includes(q.toLowerCase())).map(c => ({ conversationId: c.id, title: c.title, excerpt: '' })))
  };

  bench = {
    results: () => Promise.resolve([]),
    run: () => Promise.reject(new Error('Benchmarks need a real engine — not available in preview')),
    remove: () => Promise.resolve(true)
  };

  // ---- v1.2.0 mock surface (compatlab-mock) ----
  lab = {
    assess: (opts) => Promise.resolve({
      status: 'likely-compatible',
      reasons: ['Vulkan runtime detected on this machine (likely) — GPU offload is plausible but only a lab test proves model+driver cooperation for THIS model size.', 'MoE models keep ALL experts resident; only 2 of 128 are active per token.'],
      checks: [{ id: 'model', ok: true, detail: 'qwen3 · Q6_K · MoE 128e (8 active) — from GGUF metadata (confirmed)' }, { id: 'capabilities', ok: true, detail: 'probed from the installed binary' }, { id: 'accel', ok: true, detail: 'vulkan likely' }, { id: 'memory', ok: true, detail: 'estimated 8.9 GB vs 24.1 GB free (estimate ±15%)' }],
      savedResult: null, goals: ['cpu-performance', 'cpu-memory-efficient', 'igpu-experimental', 'large-context', 'moe', 'low-memory', 'max-throughput']
    }),
    runTest: () => Promise.resolve({ outcome: 'pass', stages: [
      { stage: 'exe-startup', ok: true, status: 'pass', detail: 'C:\\engines\\llamacpp-vulkan\\b12359\\llama-server.exe' },
      { stage: 'device-detect', ok: true, status: 'pass', detail: '1 device(s): Intel(R) UHD Graphics 770' },
      { stage: 'load', ok: true, status: 'pass', detail: 'ready in 18432 ms (pid 41248)' },
      { stage: 'inference', ok: true, status: 'pass', detail: '"ready" in 210 ms' },
      { stage: 'streaming', ok: true, status: 'pass', detail: '14 SSE chunks, TTFT 312 ms' },
      { stage: 'thinking', ok: true, status: 'pass', detail: 'on → "reasoning-format", off → "enable_thinking:false" (explicit disable verified)' },
      { stage: 'terminate', ok: true, status: 'pass', detail: 'pid 41248 exit observed, port released' }
    ], measured: { loadMs: 18432, ttftMs: 312 }, at: Date.now(), appVersion: '1.2.2' }),
    results: () => Promise.resolve([{ modelPath: 'C:\\models\\qwen3-8b-q6_k.gguf', engineId: 'llamacpp-vulkan', engineTag: 'b12359', accel: 'gpu-vulkan', profileKey: 'manual', outcome: 'pass', stale: false, staleReason: null, at: Date.now() - 86400000, appVersion: '1.2.2' }]),
    invalidate: () => Promise.resolve(0)
  };
  profiles = {
    list: () => Promise.resolve([
      { id: 'cpu-performance', label: 'CPU Performance', description: 'Threads set to 6 (detected 12 logical cores minus system reserve).', params: { contextLength: 8192, threads: 6, threadsBatch: 6, batchSize: 1024, parallelSlots: 1, kvCacheType: 'f16', useMmap: true, flashAttention: true }, notes: ['Threads set to 6 (detected 12 logical cores minus system reserve; tune ±2 and compare in the Benchmark Lab).'], assumptions: ['Assumes CPU-only execution; generation speed follows memory bandwidth.'], requiresExplicitApply: true },
      { id: 'moe', label: 'Mixture-of-Experts', description: 'Expert offload starts at 12 layers on CPU.', params: { contextLength: 8192, threads: 6, threadsBatch: 6, batchSize: 512, parallelSlots: 1, kvCacheType: 'f16', useMmap: true, cpuMoeLayers: 12, flashAttention: true }, notes: ['Expert offload starts at 12 layers on CPU (tune 0..N): ALL experts stay resident either way — offload changes compute placement, not total memory.'], assumptions: [], requiresExplicitApply: true },
      { id: 'large-context', label: 'Large Context', description: 'Context 32,768 with q8_0 KV cache.', params: { contextLength: 32768, threads: 6, threadsBatch: 6, batchSize: 512, parallelSlots: 1, kvCacheType: 'q8_0', useMmap: true, flashAttention: true }, notes: ['Context 32,768 (model trains up to 40,960); exact value passed to the engine — never silently reduced.', 'Long context multiplies KV memory — check the pre-load assessment before launching.'], assumptions: [], requiresExplicitApply: true }
    ]),
    goals: () => Promise.resolve(['cpu-performance', 'cpu-memory-efficient', 'igpu-experimental', 'large-context', 'moe', 'low-memory', 'max-throughput', 'custom'])
  };
  diagnostics = {
    snapshot: () => Promise.resolve({
      generatedAt: new Date().toISOString(),
      app: { version: '1.2.2', platform: 'win32', arch: 'x64', node: '24.22.3', electron: '(preview)', uptimeSec: 120 },
      os: { release: '10.0.26200', hostname: 'DESKTOP-EX', totalMem: 47.2e9, freeMem: 24.1e9 },
      hardware: { vulkan: 'likely', sycl: 'unknown', cpuModel: '12th Gen Intel(R) Core(TM) i5-12500' },
      memorySample: { memory: { committedFreeBytes: 30.1e9 } },
      engines: [
        { id: 'llamacpp-cpu', displayName: 'llama.cpp (CPU)', installed: true, version: 'b12359 (8f3c21d)', statusCategory: 'compatible', probedCapabilities: { probed: true }, error: null },
        { id: 'llamacpp-vulkan', displayName: 'llama.cpp (Vulkan)', installed: true, version: 'b12359 (8f3c21d)', statusCategory: 'compatible', probedCapabilities: { probed: true, devices: [{ description: 'Intel(R) UHD Graphics 770' }] }, error: null },
        { id: 'llamacpp-sycl', displayName: 'llama.cpp (SYCL)', installed: false, version: null, statusCategory: 'not-installed', probedCapabilities: { probed: false, note: 'not probeable' }, error: null }
      ],
      models: { total: 5, invalid: 0, incompleteSplits: 0, mmproj: 1 },
      managedProcesses: [], remotes: [], unverifiedRecovered: [],
      portConflicts: [{ engineId: 'llamacpp-cpu', port: 8081, occupied: false }],
      recentErrors: ['2026-11-24T08:12:03Z [warn] [controller] stop confirmed pid=41248 (port 8082 released, endpoint silent)'],
      compatResults: [{ key: 'llamacpp-vulkan @ qwen3-8b-q6_k.gguf', outcome: 'pass', stale: false }],
      hints: ['No anomalies detected in this snapshot.']
    }),
    exportReport: () => Promise.resolve('C:\\Users\\you\\AppData\\Roaming\\BlackMirror\\black-mirror-diagnostics-preview.json')
  };
  enginesExtra = { checkUpdate: () => Promise.resolve({ updateAvailable: false, latestTag: 'b12359', installedTag: 'b12359', via: 'stable-pointer' }) };

  monitorSample() {
    return Promise.resolve({
      ts: Date.now(),
      cpu: { percent: 21.3, cores: 12, model: '12th Gen Intel(R) Core(TM) i5-12500' },
      memory: { totalBytes: 47.2e9, freeBytes: 24.1e9, usedPct: 48.9, committedTotalBytes: 52.3e9, committedFreeBytes: 30.1e9, committedUsedBytes: 22.2e9, pagefileAllocatedBytes: 9.2e9, pagefileUsedBytes: 2.1e9 },
      gpu: { available: false, utilizationPercent: null, note: 'No GPU telemetry probe available (preview mode).' },
      managedProcesses: [], topProcesses: [], uptimeSec: 98234, servers: []
    });
  }

  _listeners = {};
  on(channel, handler) {
    (this._listeners[channel] = this._listeners[channel] || []).push(handler);
    return () => { this._listeners[channel] = this._listeners[channel].filter(h => h !== handler); };
  }
  _emit(channel, payload) {
    for (const h of (this._listeners[channel] || [])) {
      try { h(payload); } catch (_) { /* ignore */ }
    }
  }
  platform = 'preview';
  versions = { app: '1.2.2', electron: '(preview)' };

  /** Fake streaming chat for the preview: emits a canned answer. */
  async fakeChatStream(onDelta, onReasoning, signal, thinkingMode = 'auto') {
    const reasoningText = thinkingMode === 'off' ? '' : 'The user is asking about the mirror. I should answer directly and warmly, showing what this local setup can do.';
    const words = 'Hello from the other side of the mirror — this response was streamed through the Black Mirror preview bridge so you can evaluate the chat experience: markdown, code blocks, token stats and thinking display. No cloud service is involved; in the real app the tokens come from a locally running llama.cpp, Ollama or Lemonade server on this machine.'.split(' ');
    for (const r of reasoningText.match(/.{1,28}/g) || []) {
      if (signal && signal.aborted) return;
      onReasoning(r); await new Promise(r2 => setTimeout(r2, 24));
    }
    for (const w of words) {
      if (signal && signal.aborted) return;
      onDelta((onDelta.called ? ' ' : '') + w); onDelta.called = true;
      await new Promise(r2 => setTimeout(r2, 46));
    }
    return { usage: { prompt_tokens: 42, completion_tokens: words.length, total_tokens: 42 + words.length }, tps: words.length / (words.length * 0.046) };
  }
}

function wantLive() {
  try { return new URLSearchParams(location.search).has('live'); } catch (_) { return false; }
}
function apiUrl() {
  const path = String(location.pathname || '').replace(/\/mirror\/.*$/, '').replace(/\/$/, '');
  return (path || '') + '/api/bm';
}

/**
 * Browser session against the real Node backend (same methods as preload).
 * Used by the Ubuntu live preview. Push channels are polled; nothing here
 * kills a process the backend does not own.
 */
class HttpBridge {
  constructor(url) {
    this.url = url;
    this.preview = false;
    this._listeners = {};
    this._timer = setInterval(() => this._poll().catch(() => {}), 1500);
    this.platform = 'linux';
    this.versions = { app: '1.2.2', electron: null, node: null };
    this._poll().catch(() => {});
  }
  async _rpc(method, args) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, args: args || [] })
    });
    const j = await res.json();
    if (!j || j.ok !== true) {
      const err = new Error(j && j.error ? j.error : 'request failed');
      err.code = j && j.code;
      throw err;
    }
    return j.data;
  }
  async _poll() {
    const batch = await this._rpc('events:poll', []);
    if (batch && batch.platform) this.platform = batch.platform;
    if (batch && batch.versions) this.versions = batch.versions;
    for (const ev of (batch && batch.events) || []) {
      for (const h of (this._listeners[ev.channel] || [])) {
        try { h(ev.payload); } catch (_) { /* ignore */ }
      }
    }
  }
  on(channel, handler) {
    (this._listeners[channel] = this._listeners[channel] || []).push(handler);
    return () => { this._listeners[channel] = (this._listeners[channel] || []).filter(h => h !== handler); };
  }
  getConfig() { return this._rpc('config:get'); }
  setConfig(path, value) { return this._rpc('config:set', [path, value]); }
  setParams(patch) { return this._rpc('config:setParams', [patch]); }
  library = {
    refresh: () => this._rpc('library:refresh'),
    list: (filter) => this._rpc('library:list', [filter]),
    get: (p) => this._rpc('library:get', [p]),
    addScanDir: (dir) => this._rpc('library:addScanDir', [dir]),
    removeScanDir: (dir) => this._rpc('library:removeScanDir', [dir]),
    listScanDirs: () => this._rpc('library:listScanDirs'),
    importFile: (p) => this._rpc('library:importFile', [p]),
    toggleFavorite: (p) => this._rpc('library:toggleFavorite', [p]),
    setCategories: (p, cats) => this._rpc('library:setCategories', [p, cats]),
    categories: () => this._rpc('library:categories'),
    mmprojFor: (p) => this._rpc('library:mmprojFor', [p]),
    getProfile: (p) => this._rpc('library:getProfile', [p]),
    saveProfile: (p, prof) => this._rpc('library:saveProfile', [p, prof]),
    deleteProfile: (p) => this._rpc('library:deleteProfile', [p]),
    assess: (p, contextLength, slots) => this._rpc('library:assess', [p, contextLength, slots])
  };
  engines = {
    status: () => this._rpc('engines:status'),
    hardware: () => this._rpc('engines:hardware'),
    capabilities: (id) => this._rpc('engines:capabilities', [id]),
    install: (id) => this._rpc('engines:install', [id]),
    uninstall: (id, tag) => this._rpc('engines:uninstall', [id, tag]),
    setActive: (id, tag) => this._rpc('engines:setActive', [id, tag]),
    setCustomPath: (id, p) => this._rpc('engines:setCustomPath', [id, p]),
    updateSettings: (id, s) => this._rpc('engines:updateSettings', [id, s]),
    paramSchema: () => this._rpc('engines:paramSchema')
  };
  enginesExtra = { checkUpdate: (id) => this._rpc('engines:checkUpdate', [id]) };
  servers = {
    list: () => this._rpc('servers:list'),
    external: () => this._rpc('servers:external'),
    start: (opts) => this._rpc('servers:start', [opts]),
    stop: (id) => this._rpc('servers:stop', [id]),
    restart: (id) => this._rpc('servers:restart', [id]),
    logs: (id) => this._rpc('servers:logs', [id]),
    engineModels: (engineId, override) => this._rpc('servers:engineModels', [engineId, override]),
    addRemote: (opts) => this._rpc('servers:addRemote', [opts]),
    removeRemote: (id) => this._rpc('servers:removeRemote', [id]),
    testRemote: (idOrUrl) => this._rpc('servers:testRemote', [idOrUrl])
  };
  monitorSample() { return this._rpc('monitor:sample'); }
  lab = {
    assess: (opts) => this._rpc('lab:assess', [opts]),
    runTest: (cfg) => this._rpc('lab:runTest', [cfg]),
    results: () => this._rpc('lab:results'),
    invalidate: (p) => this._rpc('lab:invalidate', [p])
  };
  profiles = {
    list: (opts) => this._rpc('profiles:list', [opts]),
    goals: () => this._rpc('profiles:goals')
  };
  diagnostics = {
    snapshot: () => this._rpc('diag:snapshot'),
    exportReport: () => this._rpc('diag:export')
  };
  openDataDir() { return this._rpc('shell:dataDir'); }
  chat = {
    list: () => this._rpc('chat:list'),
    get: (id) => this._rpc('chat:get', [id]),
    create: (opts) => this._rpc('chat:create', [opts]),
    append: (id, msg) => this._rpc('chat:append', [id, msg]),
    updateMessage: (id, msgId, patch) => this._rpc('chat:updateMessage', [id, msgId, patch]),
    truncateFrom: (id, msgId, opts) => this._rpc('chat:truncateFrom', [id, msgId, opts]),
    setMeta: (id, patch) => this._rpc('chat:setMeta', [id, patch]),
    remove: (id) => this._rpc('chat:remove', [id]),
    search: (q) => this._rpc('chat:search', [q])
  };
  bench = {
    results: () => this._rpc('bench:results'),
    run: (cfg) => this._rpc('bench:run', [cfg]),
    remove: (id) => this._rpc('bench:remove', [id]),
    trackPid: (pid) => this._rpc('bench:trackPid', [pid])
  };
}

window.Bridge = window.blackMirror || (wantLive() ? new HttpBridge(apiUrl()) : new MockBridge());
window.PreviewMode = !window.blackMirror && !(window.Bridge instanceof HttpBridge);
window.LiveWeb = window.Bridge instanceof HttpBridge;

