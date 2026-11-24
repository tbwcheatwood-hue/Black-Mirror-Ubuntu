'use strict';
/**
 * Benchmark laboratory: real, reproducible measurements against a live
 * inference server. Nothing is fabricated — every number comes from either
 * wall-clock timing of real HTTP requests or server-reported timings/usage.
 *
 * One benchmark run = n repetitions of:
 *   1. fresh engine start (model load time = spawn → readiness)
 *   2. prompt-processing measurement: N-token prompt, max_tokens=1
 *   3. generation measurement: max_tokens=M, streaming
 *   4. memory sample of the managed server process during generation
 */
const { sleep } = require('../core/util');

class BenchRunner {
  constructor(controller, registry, logger, opts = {}) {
    this.controller = controller;
    this.registry = registry;
    this.logger = logger;
    this.store = opts.store; // JsonStore for results
    this.fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
    this.memorySampler = opts.memorySampler || (async () => null);
    this.onProgress = opts.onProgress || (() => {});
  }

  results() {
    return this.store.data.results || [];
  }

  /**
   * @param {object} cfg { engineId, engineTag, modelPath, params, port, bind,
   *   promptTokens, genTokens, reps, label }
   * @param {function} buildPrompt fn(nTokens) -> string producing ~n tokens
   */
  async run(cfg, buildPrompt) {
    const reps = Math.max(1, Math.min(10, cfg.reps || 2));
    const run = {
      id: 'bench-' + Date.now(),
      ts: Date.now(),
      label: cfg.label || `${cfg.engineId}${cfg.engineTag ? '@' + cfg.engineTag : ''}`,
      engineId: cfg.engineId,
      engineTag: cfg.engineTag || null,
      modelPath: cfg.modelPath,
      params: { ...cfg.params },
      port: cfg.port,
      promptTokens: cfg.promptTokens,
      genTokens: cfg.genTokens,
      reps,
      environment: this._env(),
      measurements: []
    };
    this.onProgress({ stage: 'start', runId: run.id });

    for (let i = 0; i < reps; i++) {
      this.onProgress({ stage: 'rep', runId: run.id, rep: i + 1, of: reps });
      const m = await this._oneRep(cfg, buildPrompt, i + 1);
      run.measurements.push(m);
    }

    run.summary = this._summarize(run.measurements);
    const results = this.store.data.results || (this.store.data.results = []);
    results.push(run);
    this.store.save();
    this.onProgress({ stage: 'done', runId: run.id });
    return run;
  }

  _env() {
    const os = require('os');
    return {
      platform: process.platform,
      cpuModel: os.cpus()[0] ? os.cpus()[0].model.trim() : 'unknown',
      cores: os.cpus().length,
      totalMemGB: Number((os.totalmem() / 1024 ** 3).toFixed(1))
    };
  }

  async _oneRep(cfg, buildPrompt, repIndex = 1) {
    const started = Date.now();
    let server;
    let loadMs = null;
    let promptTps = null, promptWallMs = null;
    let genTps = null, genServerTps = null, genWallMs = null;
    let ttftMs = null, genDoneMs = null;
    let peakRss = null;
    let ok = false;
    try {
      server = await this.controller.start({
        engineId: cfg.engineId,
        modelPath: cfg.modelPath,
        port: cfg.port,
        bind: cfg.bind || '127.0.0.1',
        params: cfg.params
      });
      loadMs = Date.now() - started; // spawn → readiness (health 200)
      const base = server.baseUrl;

      // ---- prompt processing: big prompt, 1 output token ----
      const prompt = buildPrompt(cfg.promptTokens || 512);
      const t0 = Date.now();
      const res1 = await this.fetchImpl(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'benchmark', stream: false, max_tokens: 1,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      promptWallMs = Date.now() - t0;
      if (res1.ok) {
        const j1 = await res1.json();
        if (j1.timings && j1.timings.prompt_n) {
          promptTps = j1.timings.prompt_n / (j1.timings.prompt_ms / 1000);
        } else if (j1.usage && j1.usage.prompt_tokens) {
          promptTps = j1.usage.prompt_tokens / (promptWallMs / 1000);
        }
      }

      // ---- generation: stream tokens, track wall time + memory ----
      const memTimer = setInterval(async () => {
        const s = await this.memorySampler();
        if (s && s.memoryBytes && (peakRss === null || s.memoryBytes > peakRss)) peakRss = s.memoryBytes;
      }, 300);
      const t1 = Date.now();
      let completionTokens = 0;
      try {
        const res2 = await this.fetchImpl(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'benchmark', stream: true, max_tokens: cfg.genTokens || 128,
            messages: [{ role: 'user', content: 'Write a detailed story about a mirror.' }]
          })
        });
        // Consume the SSE stream incrementally: first-chunk latency (TTFT),
        // token count from final usage, server-reported gen speed.
        const reader = res2.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (ttftMs === null && value && value.length) ttftMs = Date.now() - t1;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6);
            if (payload === '[DONE]') continue;
            try {
              const j = JSON.parse(payload);
              if (j.usage && j.usage.completion_tokens) completionTokens = j.usage.completion_tokens;
              if (j.timings && j.timings.predicted_n) {
                genServerTps = j.timings.predicted_n / (j.timings.predicted_ms / 1000);
              }
            } catch (_) { /* partial line */ }
          }
        }
        genDoneMs = Date.now() - t1;
        genWallMs = genDoneMs;
        if (completionTokens && genWallMs) genTps = completionTokens / (genWallMs / 1000);
      } finally {
        clearInterval(memTimer);
      }
    } finally {
      if (server) {
        try { await this.controller.stop(server.id); } catch (_) { /* ignore */ }
        await sleep(300);
      }
    }

    ok = loadMs !== null && (genTps !== null || genServerTps !== null);
    return {
      rep: repIndex, loadMs,
      promptTps: round(promptTps), promptWallMs,
      genTps: round(genTps), genServerTps: round(genServerTps), genWallMs,
      ttftMs, totalMs: genDoneMs !== null ? (genDoneMs + (promptWallMs || 0)) : null,
      peakRss, ok
    };
  }

  _summarize(measurements) {
    const ok = measurements.filter(m => m.ok);
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    return {
      reps: measurements.length,
      okReps: ok.length,
      loadMs: round(avg(ok.map(m => m.loadMs))),
      promptTps: round(avg(ok.map(m => m.promptTps))),
      genTps: round(avg(ok.map(m => m.genTps ?? m.genServerTps))),
      ttftMs: round(avg(ok.map(m => m.ttftMs))),
      totalMs: round(avg(ok.map(m => m.totalMs))),
      peakRss: ok.length ? Math.max(...ok.map(m => m.peakRss || 0)) || null : null
    };
  }

  remove(id) {
    this.store.data.results = (this.store.data.results || []).filter(r => r.id !== id);
    this.store.save();
    return true;
  }
}

function round(v) { return v === null || v === undefined || isNaN(v) ? null : Number(v.toFixed(2)); }

module.exports = { BenchRunner, round };
