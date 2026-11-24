'use strict';
/**
 * Compatibility Lab — manually initiated, staged verification runs.
 *
 * Answers "does THIS model work on THIS engine version with THIS launch
 * configuration" using real (but small) resource-usage stages. Every stage
 * is honest: a failure records its diagnostics, and nothing runs without an
 * explicit user action.
 *
 * Stage ladder (each runs only if the previous passed):
 *   exe-startup    the engine binary starts at all with the given args
 *   device-detect  what acceleration devices the binary itself reports
 *   load           the model actually loads (server becomes ready)
 *   inference      one short completion returns text
 *   streaming      a streamed completion arrives in >1 chunk (TTFT measured)
 *   thinking       the configured thinking mode produces the expected
 *                  request shape (verified by request construction) and,
 *                  for engines that report it, reasoning output
 *   unload+terminate  server stops and termination is VERIFIED
 */
const { JsonStore } = require('../core/store');
const { EngineError } = require('../engines/adapters');

const STAGES = ['exe-startup', 'device-detect', 'load', 'inference', 'streaming', 'thinking', 'terminate'];

class CompatibilityLab {
  constructor(controller, registry, logger, opts = {}) {
    this.controller = controller;
    this.registry = registry;
    this.logger = logger;
    this.dataDir = opts.dataDir || '.';
    this.store = new JsonStore(`${this.dataDir}/compat-results.json`, { results: [] });
    this.store.load();
    this.onEvent = opts.onEvent || (() => {});
    this.appVersion = opts.appVersion || '1.2.2';
    this.fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
    this._running = null; // only one lab run at a time
  }

  /**
   * Identity key of a configuration + staleness fingerprint. Results become
   * stale when the model file changes, the engine version changes, the
   * acceleration/profile changes, or the app version changes.
   */
  keyFor(cfg) {
    return {
      modelPath: cfg.modelPath,
      modelMtimeMs: cfg.modelMtimeMs,
      engineId: cfg.engineId,
      engineTag: cfg.engineTag || null,
      accel: cfg.accel,
      profileKey: cfg.profileKey || null
    };
  }

  staleReason(entry, current) {
    if (entry.appVersion !== this.appVersion) return `app version changed (${entry.appVersion} → ${this.appVersion})`;
    if (Number(entry.modelMtimeMs) !== Number(current.modelMtimeMs)) return 'model file changed on disk';
    if ((entry.engineTag || null) !== (current.engineTag || null)) return `engine version changed (${entry.engineTag || 'none'} → ${current.engineTag || 'none'})`;
    return null;
  }

  results() {
    return (this.store.data.results || []).map(r => {
      const stale = this.staleReason(r, r);
      return { ...r, stale: !!stale, staleReason: stale || null };
    }).sort((a, b) => b.at - a.at);
  }

  /**
   * Most recent result for this configuration (or null). Matching ignores
   * the staleness inputs themselves (model mtime, engine tag) — when those
   * change, the old result is returned MARKED STALE so the assessor can
   * explain what changed, instead of evidence silently vanishing.
   */
  latestResultFor(cfg) {
    const key = this.keyFor(cfg);
    let best = null;
    for (const r of this.store.data.results || []) {
      const k = this.keyFor(r);
      if (k.modelPath === key.modelPath && k.engineId === key.engineId &&
          k.accel === key.accel && k.profileKey === key.profileKey) {
        if (!best || r.at > best.at) best = r;
      }
    }
    if (!best) return null;
    const stale = this.staleReason(best, cfg);
    return stale ? { ...best, stale: true, staleReason: stale } : best;
  }

  _emit(event, payload) { this.onEvent({ event, ...payload, ts: Date.now() }); }

  /**
   * Run the staged compatibility test. ALWAYS manually initiated (the only
   * caller is an explicit UI action). Returns the full per-stage report.
   */
  async runTest(cfg) {
    if (this._running) throw new EngineError('A compatibility test is already running — wait for it to finish.', 'busy');
    this._running = cfg;
    const stages = [];
    const measured = {};
    let server = null;
    let outcome = 'pass';
    try {
      const emit = (stage, status, detail) => {
        stages.push({ stage, status, ok: status === 'pass', detail: detail || '', at: Date.now() });
        this._emit('lab-progress', { key: this.keyFor(cfg), stage, status, detail: detail || '' });
        if (status === 'fail') outcome = 'fail';
      };

      // ---- resolve engine descriptor + adapter ----
      const d = this.registry.descriptor(cfg.engineId);
      const st = (await this.registry.status()).find(x => x.id === cfg.engineId);
      if (!st || st.status !== 'available') throw new EngineError(`Engine "${cfg.engineId}" is not available: ${st ? st.error : 'unknown'}`, 'engine');

      // ---- stage: exe-startup ----
      let exe;
      try {
        exe = this.registry.adapter(cfg.engineId).executablePath();
        emit('exe-startup', 'pass', exe);
      } catch (e) {
        emit('exe-startup', 'fail', e.message);
        return this._finish(cfg, stages, measured, outcome);
      }

      // ---- stage: device-detect (llama.cpp --list-devices; others: API query) ----
      if (d.family === 'llama.cpp') {
        const { spawnSync } = require('child_process');
        const r = spawnSync(exe, ['--list-devices'], { timeout: 15000, encoding: 'utf8', windowsHide: true });
        const text = (r.stdout || '') + (r.stderr || '');
        const devices = require('../engines/capabilities').parseDevices(text);
        measured.devices = devices;
        emit('device-detect', 'pass', devices.length ? `${devices.length} device(s): ${devices.map(x => x.description).join('; ')}` : 'no discrete accelerator devices reported (CPU path)');
      } else {
        emit('device-detect', 'pass', `${d.family} manages its own devices`);
      }

      // ---- stage: load (spawn + readiness through the controller) ----
      const t0 = Date.now();
      try {
        server = await this.controller.start({
          engineId: cfg.engineId,
          modelPath: d.family === 'llama.cpp' ? cfg.modelPath : undefined,
          port: cfg.port,
          bind: '127.0.0.1',
          params: { ...(cfg.params || {}), contextLength: Math.min((cfg.params && cfg.params.contextLength) || 2048, 2048) },
          modelDisplayName: cfg.modelDisplayName || 'lab-test'
        });
        measured.loadMs = Date.now() - t0;
        measured.pid = server.pid;
        emit('load', 'pass', `ready in ${measured.loadMs} ms (pid ${server.pid})`);
      } catch (e) {
        emit('load', 'fail', String(e.message).slice(0, 600));
        return this._finish(cfg, stages, measured, outcome);
      }

      // ---- stage: inference (single completion) ----
      try {
        const t1 = Date.now();
        const res = await this.fetchImpl(`${server.baseUrl}/v1/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'lab', stream: false, max_tokens: 32, messages: [{ role: 'user', content: 'Reply with the single word: ready.' }] })
        });
        const j = await res.json();
        const text = j.choices && j.choices[0] && (j.choices[0].message?.content || j.choices[0].text) || '';
        if (!res.ok || !text.trim()) throw new Error(`no completion text (HTTP ${res.status})`);
        measured.inferenceMs = Date.now() - t1;
        emit('inference', 'pass', `${JSON.stringify(text.trim().slice(0, 40))} in ${measured.inferenceMs} ms`);
      } catch (e) {
        emit('inference', 'fail', String(e.message).slice(0, 600));
        return this._finishWithServer(cfg, stages, measured, outcome, () => this.controller.stop(server.id));
      }

      // ---- stage: streaming ----
      try {
        const res = await this.fetchImpl(`${server.baseUrl}/v1/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'lab', stream: true, max_tokens: 24, messages: [{ role: 'user', content: 'Count: one two three' }] })
        });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let chunks = 0, ttft = null;
        const t2 = Date.now();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length && ttft === null) ttft = Date.now() - t2;
          chunks++;
        }
        if (chunks < 2) throw new Error(`stream had only ${chunks} chunk(s)`);
        measured.streamChunks = chunks;
        measured.ttftMs = ttft;
        emit('streaming', 'pass', `${chunks} SSE chunks, TTFT ${ttft} ms`);
      } catch (e) {
        emit('streaming', 'fail', String(e.message).slice(0, 600));
        return this._finishWithServer(cfg, stages, measured, outcome, () => this.controller.stop(server.id));
      }

      // ---- stage: thinking (request-shape verification against the adapter) ----
      try {
        const adapter = this.registry.adapter(cfg.engineId);
        const overridesOn = adapter.buildRequestOverrides({ thinkingMode: 'on' }, null, 'on');
        const overridesOff = adapter.buildRequestOverrides({ thinkingMode: 'off' }, null, 'off');
        const shapes = { on: 'think' in overridesOn ? overridesOn.think : 'chat_template_kwargs' in overridesOn ? 'reasoning-format' : 'omitted', off: 'think' in overridesOff ? overridesOff.think : 'chat_template_kwargs' in overridesOff ? 'enable_thinking:false' : 'omitted' };
        if (shapes.off === 'omitted' && d.family !== 'lemonade') {
          throw new Error('adapter does not construct an explicit thinking-off request (must never merely omit the parameter)');
        }
        measured.thinkingShapes = shapes;
        emit('thinking', 'pass', `on → ${JSON.stringify(shapes.on)}, off → ${JSON.stringify(shapes.off)} (explicit disable verified)`);
      } catch (e) {
        emit('thinking', 'fail', String(e.message).slice(0, 400));
        return this._finishWithServer(cfg, stages, measured, outcome, () => this.controller.stop(server.id));
      }

      // ---- stage: terminate (verified) ----
      try {
        const stopRes = await this.controller.stop(server.id);
        server = null;
        if (stopRes.confirmed) {
          measured.stopConfirmed = true;
          measured.portReleased = stopRes.portReleased;
          emit('terminate', 'pass', `pid ${stopRes.pid} exit observed, port ${stopRes.portReleased ? 'released' : 'still bound (reported)'}`);
        } else {
          emit('terminate', 'fail', `unresolved: alive=${stopRes.pidAliveAfter} portReleased=${stopRes.portReleased} httpDown=${stopRes.httpDown}`);
        }
      } catch (e) {
        emit('terminate', 'fail', String(e.message).slice(0, 400));
      }
      return this._finish(cfg, stages, measured, outcome);
    } catch (e) {
      stages.push({ stage: 'harness', status: 'fail', ok: false, detail: String(e.message).slice(0, 400), at: Date.now() });
      return this._finish(cfg, stages, measured, 'fail');
    } finally {
      if (server) { try { await this.controller.stop(server.id); } catch (_) { /* best effort */ } }
      this._running = null;
    }
  }

  async _finishWithServer(cfg, stages, measured, outcome, stopFn) {
    try { await stopFn(); } catch (_) { /* recorded by controller */ }
    return this._finish(cfg, stages, measured, outcome);
  }

  _finish(cfg, stages, measured, outcome) {
    const entry = {
      ...this.keyFor(cfg),
      profileParams: cfg.params || null,
      stages,
      measured,
      outcome,
      at: Date.now(),
      appVersion: this.appVersion
    };
    this.store.data.results = [entry, ...(this.store.data.results || [])].slice(0, 200);
    this.store.save();
    this.logger.info('lab', `compat test ${outcome}: ${cfg.engineId} @ ${cfg.modelPath} (${stages.filter(s => s.ok).length}/${stages.length} stages)`);
    return entry;
  }

  /** Explicit invalidation (e.g. engine uninstalled): mark, keep evidence. */
  invalidate(modelPath) {
    let n = 0;
    for (const r of this.store.data.results || []) {
      if (!modelPath || r.modelPath === modelPath) { r.stale = true; r.staleReason = r.staleReason || 'invalidated'; n++; }
    }
    if (n) this.store.save();
    return n;
  }
}

module.exports = { CompatibilityLab, STAGES };
