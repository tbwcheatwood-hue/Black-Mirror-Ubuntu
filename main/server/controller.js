'use strict';
/**
 * Inference server controller: the only module allowed to start or stop
 * inference processes.
 *
 * Safety invariants:
 *  1. Black Mirror only ever terminates processes recorded in its own
 *     registry (PIDs it spawned). External / externally-managed servers are
 *     never killed.
 *  2. Duplicate launch prevention: a managed process keyed by
 *     engineId+modelPath must not be started twice; port conflicts fail fast
 *     with a clear error.
 *  3. Every spawn is logged, tracked and cleaned up on app shutdown.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { isWindows, sleep } = require('../core/util');
const { checkPort } = require('./ports');
const { JsonStore } = require('../core/store');
const { EngineError } = require('../engines/adapters');
const ownership = require('./ownership');
const proctree = require('./proctree');

const MAX_LOG_LINES = 800; // in-memory ring per process

class DuplicateProcessError extends Error {
  constructor(key, existing) {
    super(`This model is already served by Black Mirror (process ${existing.pid}, port ${existing.port}). Stop it first or use a different port.`);
    this.name = 'DuplicateProcessError';
    this.code = 'duplicate';
    this.key = key;
    this.existing = existing;
  }
}

class ServerController {
  constructor(registry, logger, opts = {}) {
    this.registry = registry;
    this.logger = logger;
    this.dataDir = opts.dataDir;
    this.logDir = path.join(opts.dataDir || '.', 'server-logs');
    fs.mkdirSync(this.logDir, { recursive: true });
    /** key -> {pid, proc, engineId, model, port, bind, startedAt, logs, status, logFile} */
    this.processes = new Map();
    this.onEvent = opts.onEvent || (() => {});
    this.readyTimeoutMs = opts.readyTimeoutMs || 180000;
    this.fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
    this._nextId = 1;
    // Ownership records: identity evidence for every process we spawn, so a
    // crashed/restarted app can re-verify ownership instead of trusting PIDs.
    this._ownershipStore = new JsonStore(path.join(opts.dataDir || '.', 'managed-processes.json'), { records: [] });
    this._ownershipStore.load();
    this.recoveredExternal = []; // alive processes that failed ownership verification
    this.remotes = new Map();
    this._nextRemoteId = 1;
    // Persisted endpoint registry (connect-only, never owned).
    try {
      this._remoteStore = new JsonStore(path.join(opts.dataDir || '.', 'remotes.json'), { nextId: 1, remotes: [] });
      this._remoteStore.load();
      this._nextRemoteId = this._remoteStore.data.nextId || 1;
      for (const r of this._remoteStore.data.remotes || []) this.remotes.set(r.id, r);
    } catch (_) { /* non-fatal */ }
  }

  _saveOwnership() {
    try {
      this._ownershipStore.data.records = [...this.processes.values()]
        .filter(p => p.pid && p.status !== 'stopped')
        .map(p => ({
          id: p.id, pid: p.pid, engineId: p.engineId, model: p.model,
          modelPath: p.modelPath || null, port: p.port, bind: p.bind,
          startedAt: p.startedAt, exePath: p.exePath || null,
          startTime: p.startTime || null
        }));
      this._ownershipStore.save();
    } catch (_) { /* non-fatal */ }
  }

  /**
   * Startup recovery: classify persisted ownership records.
   *  - process gone            → record cleared (clean outcome)
   *  - identity VERIFIED       → adopted as owned & stoppable (status 'recovered')
   *  - identity CANNOT verify  → classified external, never stopped, reported
   * Never trusts a PID alone: executable + command line + start time must match.
   */
  recoverAtStartup() {
    const records = (this._ownershipStore.data.records || []).slice();
    const adopted = [];
    const external = [];
    const cleared = [];
    for (const rec of records) {
      const snap = ownership.snapshotProcess(rec.pid);
      if (!snap) { cleared.push(rec); continue; }
      const verdict = ownership.verifyOwnership(rec, snap);
      if (verdict.owned) {
        adopted.push({ ...rec, recoveredStatus: 'running' });
        const p = {
          id: rec.id, pid: rec.pid, engineId: rec.engineId, model: rec.model,
          family: null, displayName: rec.model ? path.basename(String(rec.model)) : rec.engineId,
          port: rec.port, bind: rec.bind, params: {}, startedAt: rec.startedAt,
          pidRecovered: true, exePath: rec.exePath, startTime: rec.startTime,
          proc: null, logs: [], status: 'running', logFile: null,
          readyUrl: rec.port ? `http://127.0.0.1:${rec.port}/health` : null, adapter: 'openai'
        };
        this.processes.set(rec.id, p);
      } else {
        external.push({ ...rec, snapshot: { exe: snap.exe, cmdline: snap.cmdline.slice(0, 8) }, reason: verdict.reason });
      }
    }
    this.recoveredExternal = external;
    this._saveOwnership();
    if (adopted.length || external.length) {
      this.logger.info('controller', `recovery: ${adopted.length} adopted, ${external.length} external-unverified, ${cleared.length} gone`);
    }
    return { adopted, external, cleared };
  }

  /** TCP liveness of the API port (true when something accepts connections). */
  async _portResponding(port, host = '127.0.0.1', timeoutMs = 1500) {
    return new Promise(resolve => {
      const sock = net.connect({ port: Number(port), host, timeout: timeoutMs });
      const done = v => { try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
    });
  }

  /** HTTP liveness: true when the endpoint still answers. */
  async _httpResponding(url, timeoutMs = 1500) {
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      return true; // any HTTP answer means something still serves
    } catch (_) { return false; }
  }

  _saveRemotes() {
    try {
      this._remoteStore.data.nextId = this._nextRemoteId;
      this._remoteStore.data.remotes = [...this.remotes.values()];
      this._remoteStore.save();
    } catch (_) { /* non-fatal */ }
  }

  /** Remote / external OpenAI-compatible endpoints — CONNECT ONLY, never owned. */
  listRemotes() { return [...this.remotes.values()]; }

  addRemote({ label, baseUrl, model }) {
    const url = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) throw new EngineError('Endpoint URL must start with http:// or https://', 'bad-url');
    const id = 'remote-' + (this._nextRemoteId++);
    const rec = { id, label: label || url, baseUrl: url, model: model || null, addedAt: Date.now(), status: 'unknown', mode: 'remote' };
    this.remotes.set(id, rec);
    this._saveRemotes();
    this._emit('remote-added', rec);
    return rec;
  }

  removeRemote(id) {
    const had = this.remotes.delete(id);
    if (had) { this._saveRemotes(); this._emit('remote-removed', { id }); }
    return had;
  }

  /**
   * Connection test for a remote endpoint: GET /v1/models with timeout.
   * Read-only; nothing is owned, launched or stopped.
   */
  async testRemote(idOrUrl) {
    const rec = this.remotes.get(idOrUrl) || { baseUrl: idOrUrl, id: null, label: idOrUrl };
    const started = Date.now();
    try {
      const res = await this.fetchImpl(`${rec.baseUrl}/v1/models`, { signal: AbortSignal.timeout(8000) });
      const ms = Date.now() - started;
      if (!res.ok) {
        if (rec.id) { rec.status = 'unreachable'; rec.lastError = `HTTP ${res.status}`; }
        return { ok: false, latencyMs: ms, error: `HTTP ${res.status}`, models: [] };
      }
      const data = await res.json();
      const models = (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean);
      if (rec.id) { rec.status = 'connected'; rec.lastError = null; rec.models = models; }
      return { ok: true, latencyMs: ms, models };
    } catch (e) {
      if (rec.id) { rec.status = 'unreachable'; rec.lastError = e.message; }
      return { ok: false, latencyMs: Date.now() - started, error: e.message, models: [] };
    }
  }

  list() {
    const managed = [...this.processes.values()].map(p => this._public(p));
    const remote = [...this.remotes.values()].map(r => ({
      id: r.id, engineId: 'remote', model: r.model, displayName: r.label,
      status: r.status === 'connected' ? 'running' : r.status === 'unreachable' ? 'crashed' : 'unknown',
      mode: 'remote', pid: null, port: null, bind: null, startedAt: r.addedAt,
      baseUrl: r.baseUrl, logLines: 0, models: r.models || null
    }));
    return [...remote, ...managed]; // remote first: they are connect-only
  }

  _public(p) {
    const modelPath = p.model || null;
    const displayName = p.displayName
      || (modelPath ? baseNameAny(modelPath).replace(/\.gguf$/i, '') : null)
      || null;
    return {
      id: p.id, pid: p.pid, engineId: p.engineId, model: modelPath,
      displayName,
      params: p.params || {},
      port: p.port, bind: p.bind, startedAt: p.startedAt,
      status: p.status, mode: 'managed',
      family: p.family || null,
      pidRecovered: !!p.pidRecovered,
      exePath: p.exePath || null,
      baseUrl: `http://${p.bind === '0.0.0.0' ? '127.0.0.1' : p.bind}:${p.port}`,
      logLines: p.logs.length
    };
  }

  /** Find a managed process by engineId+model. */
  findFor(engineId, model) {
    for (const p of this.processes.values()) {
      if (p.engineId === engineId && p.model === model) return p;
    }
    return null;
  }

  _emit(event, payload) { this.onEvent({ event, ...payload, ts: Date.now() }); }

  _appendLog(p, stream, line) {
    if (!line) return;
    const entry = `[${new Date().toISOString()}][${stream}] ${line}`;
    p.logs.push(entry);
    if (p.logs.length > MAX_LOG_LINES) p.logs.shift();
    try { fs.appendFileSync(p.logFile, entry + '\n'); } catch (_) { /* ignore */ }
    this._emit('server-log', { id: p.id, line: entry });
  }

  /**
   * Start an inference server for a model.
   * opts: { engineId, modelPath|modelName, port, bind, params, modelDisplayName }
   * Resolves when the engine reports readiness (or 'detached' for engines
   * without a readiness probe).
   */
  async start(opts) {
    const d = this.registry.descriptor(opts.engineId);
    const adapter = this.registry.adapter(opts.engineId);
    const model = opts.modelPath || opts.modelName;
    const key = `${opts.engineId}:${model}`;

    // ---- duplicate launch prevention ----
    const existing = this.findFor(opts.engineId, model);
    if (existing && ['starting', 'running', 'degraded'].includes(existing.status)) {
      throw new DuplicateProcessError(key, this._public(existing));
    }
    // Another managed server may already use the same port with a different model.
    for (const p of this.processes.values()) {
      if (p.port === opts.port && ['starting', 'running', 'degraded'].includes(p.status)) {
        throw new EngineError(`Port ${opts.port} is already used by a Black Mirror server (${p.model}). Pick another port.`, 'port-busy');
      }
    }
    // External port occupant?
    const portState = await checkPort(opts.port, opts.bind || '127.0.0.1');
    if (!portState.free) {
      throw new EngineError(`Port ${opts.port} is already in use by another application (${portState.reason}). Choose a different API port.`, 'port-busy');
    }

    // ---- executable + args ----
    let exe;
    try { exe = adapter.executablePath(); }
    catch (e) { throw e; }
    const args = adapter.buildServerArgs(model, opts.params, { port: opts.port, bind: opts.bind || '127.0.0.1' });

    const id = 'srv-' + (this._nextId++);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(this.logLogDirSafe(), `${id}-${d.id}-${stamp}.log`);

    const p = {
      id, engineId: opts.engineId, model,
      family: d.family,
      displayName: opts.modelDisplayName || opts.modelName || path.basename(String(model)),
      port: opts.port, bind: opts.bind || '127.0.0.1',
      params: opts.params || {}, startedAt: null, pid: null,
      proc: null, logs: [], status: 'starting', logFile,
      readyUrl: null, adapter: d.api
    };
    this.processes.set(id, p);
    this._emit('server-starting', { id, engineId: opts.engineId, model, port: opts.port });

    let proc;
    const spawnEnv = {
      ...process.env,
      ...(typeof adapter.buildServerEnv === 'function'
        ? adapter.buildServerEnv({ port: opts.port, bind: opts.bind || '127.0.0.1' }, this.dataDir)
        : {}),
      ...(opts.env || {})
    };
    const spawnOpts = {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnEnv
    };
    // New process group on Linux so we can signal the tree we spawned
    // without touching any other session. Recorded so stop() knows.
    if (!isWindows()) spawnOpts.detached = true;
    try {
      proc = spawn(exe, args, spawnOpts);
    } catch (e) {
      this.processes.delete(id);
      throw new EngineError(`Failed to spawn ${exe}: ${e.message}`, 'spawn');
    }
    p.proc = proc;
    p.pid = proc.pid;
    p.processGroup = !isWindows();
    p.startedAt = Date.now();
    p.modelPath = model;
    p.exePath = exe;
    p.startTime = ownership.snapshotProcess(proc.pid)?.startTime || null; // PID-reuse guard
    this._saveOwnership();
    this.logger.info('controller', `started pid=${proc.pid} engine=${d.id} model=${model} port=${opts.port}`, { args });

    proc.stdout.on('data', chunk => String(chunk).split(/\r?\n/).forEach(l => this._appendLog(p, 'out', l)));
    proc.stderr.on('data', chunk => String(chunk).split(/\r?\n/).forEach(l => this._appendLog(p, 'err', l)));
    // Piped stdio keeps the parent event loop alive. Drop those refs once the
    // child is gone so a finished test run (and app shutdown) is not pinned
    // by a closed pipe. The child itself stays referenced until exit so a
    // still-running server is visible to the process owner.
    const releaseStdio = () => {
      try { proc.stdout.destroy(); } catch (_) { /* already closed */ }
      try { proc.stderr.destroy(); } catch (_) { /* already closed */ }
    };
    proc.on('exit', (code, signal) => {
      const wasIntentional = p.status === 'stopping';
      p.status = wasIntentional ? 'stopped' : (code === 0 ? 'stopped' : 'crashed');
      p.exitCode = code;
      p.endedAt = Date.now();
      this._appendLog(p, 'sys', `process exited code=${code} signal=${signal}`);
      this._emit('server-exit', { id, pid: p.pid, code, signal, status: p.status });
      this._saveOwnership();
      releaseStdio();
      // Keep record for a short while for UI final state, then drop.
      // unref: never keep the app (or the test runner) alive for cleanup.
      const t = setTimeout(() => { if (['stopped', 'crashed'].includes(p.status)) this.processes.delete(id); }, 30000);
      if (t.unref) t.unref();
    });
    proc.on('error', err => {
      this._appendLog(p, 'sys', `spawn error: ${err.message}`);
      p.status = 'crashed';
    });

    // ---- readiness ----
    if (d.readyProbe && d.readyProbe.type === 'http') {
      const base = `http://127.0.0.1:${opts.port}`;
      p.readyUrl = base + d.readyProbe.path;
      await this._waitReady(p);
    } else {
      p.status = 'running'; // externally managed services without probes
    }
    return this._public(p);
  }

  async _waitReady(p) {
    const deadline = Date.now() + this.readyTimeoutMs;
    let lastErr = null;
    while (Date.now() < deadline) {
      if (p.status === 'crashed' || !p.proc || p.proc.exitCode !== null) {
        throw new EngineError(
          `Server exited during startup. Last log lines:\n${p.logs.slice(-8).join('\n')}`,
          'startup-failed');
      }
      try {
        const res = await this.fetchImpl(p.readyUrl, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          p.status = 'running';
          this._emit('server-ready', { id: p.id, pid: p.pid, port: p.port });
          this.logger.info('controller', `server ${p.id} ready on port ${p.port}`);
          return this._public(p);
        }
        lastErr = `HTTP ${res.status}`;
      } catch (e) {
        lastErr = e.message;
      }
      await sleep(500);
    }
    throw new EngineError(`Server did not become ready within ${Math.round(this.readyTimeoutMs / 1000)}s (${lastErr}). It is still running — check the live log; stop it if needed.`, 'ready-timeout');
  }

  /**
   * Stop a MANAGED process. Refuses to kill anything not in the registry —
   * this is the guard against touching externally managed inference servers.
   */
  /**
   * Stop a MANAGED process with VERIFIED termination. A truthy result means
   * the process exit was actually observed (not merely requested). The port
   * and HTTP liveness are checked afterwards; if any check cannot be
   * confirmed, the result says so — never a silent fake success.
   */
  async stop(idOrKey) {
    if (this.remotes && this.remotes.has(idOrKey)) {
      throw new EngineError('Remote endpoints are never stopped by Black Mirror', 'not-owned');
    }
    const p = this._resolve(idOrKey);
    if (!p) throw new EngineError(`No managed server "${idOrKey}"`, 'not-found');
    if (p.mode === 'remote') throw new EngineError('Remote endpoints are never stopped by Black Mirror', 'not-owned');

    p.status = 'stopping';
    const pid = p.pid;
    const result = { id: p.id, pid, killed: false, exitObserved: false, pidAliveAfter: null, portReleased: null, httpDown: null, confirmed: false };

    if (p.proc && p.proc.exitCode !== null) {
      // already exited on its own
      result.exitObserved = true;
      result.killed = true;
    } else {
      this.logger.info('controller', `stopping managed pid=${pid} (${p.id})`);
      if (isWindows()) {
        // Kill the whole child tree (llama-server may spawn workers).
        await new Promise(resolve => {
          const t = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
          t.on('exit', c => { result.taskkillExit = c; resolve(); });
          t.on('error', resolve);
          setTimeout(resolve, 10000);
        });
        result.killed = result.taskkillExit === 0;
      } else {
        const tree = await proctree.killOwnedTree(pid, { processGroup: p.processGroup !== false });
        result.tree = { descendants: tree.descendants, aliveAfter: tree.aliveAfter, refused: tree.refused };
        result.killed = tree.signaled || tree.confirmedDead;
        if (tree.refused) this.logger.warn('controller', `stop refused: ${tree.refused}`);
      }
    }

    // ---- verification: observe the exit, then probe port + HTTP ----
    const deadline = Date.now() + (isWindows() ? 8000 : 5000);
    while (Date.now() < deadline) {
      const exited = p.proc ? (p.proc.exitCode !== null || p.proc.signalCode !== null) : !ownership.isAlive(pid);
      if (exited) { result.exitObserved = true; break; }
      await sleep(120);
    }
    result.pidAliveAfter = p.proc ? (p.proc.exitCode === null && p.proc.signalCode === null) : ownership.isAlive(pid);
    if (result.pidAliveAfter && isWindows() && result.taskkillExit !== 0) {
      this.logger.warn('controller', `taskkill exit ${result.taskkillExit} for pid=${pid}`);
    }

    await sleep(150); // allow OS socket teardown
    result.portReleased = !(await this._portResponding(p.port, p.bind === '0.0.0.0' ? '127.0.0.1' : (p.bind || '127.0.0.1')));
    if (p.readyUrl) result.httpDown = !(await this._httpResponding(p.readyUrl));
    else result.httpDown = result.portReleased;

    result.confirmed = result.exitObserved && !result.pidAliveAfter && result.portReleased;
    if (result.confirmed) {
      p.status = 'stopped';
      p.endedAt = Date.now();
      this.processes.delete(p.id);
      this._saveOwnership();
      this.logger.info('controller', `stop confirmed pid=${pid} (port ${p.port} released, endpoint silent)`);
    } else {
      p.status = result.pidAliveAfter ? 'running' : 'stopped';
      this.logger.warn('controller', `stop UNRESOLVED for pid=${pid}: exit=${result.exitObserved} alive=${result.pidAliveAfter} portReleased=${result.portReleased} httpDown=${result.httpDown}`);
    }
    return result;
  }

  /**
   * Restart a managed server with the exact same configuration.
   * Requires a confirmed stop (exit observed + port released) before any
   * replacement process is spawned — otherwise a duplicate inference server
   * could be left running when termination remains unresolved.
   */
  async restart(idOrKey) {
    const p = this._resolve(idOrKey);
    if (!p) throw new EngineError(`No managed server "${idOrKey}"`, 'not-found');
    if (p.mode === 'remote') throw new EngineError('Remote endpoints are never restarted by Black Mirror', 'not-owned');
    const opts = {
      engineId: p.engineId,
      modelPath: p.model,
      port: p.port,
      bind: p.bind,
      params: p.params,
      modelDisplayName: p.displayName
    };
    const stopResult = await this.stop(idOrKey);
    if (!stopResult || stopResult.confirmed !== true) {
      const detail = stopResult
        ? `exitObserved=${stopResult.exitObserved} alive=${stopResult.pidAliveAfter} portReleased=${stopResult.portReleased} httpDown=${stopResult.httpDown}`
        : 'no stop result';
      this.logger.warn('controller', `restart aborted: stop unresolved for ${idOrKey} (${detail})`);
      const err = new EngineError(
        `Restart blocked: previous process termination was not confirmed (${detail}). A replacement was not started to avoid duplicate inference processes.`,
        'stop-unresolved'
      );
      err.stopResult = stopResult || null;
      throw err;
    }
    await sleep(300);
    return this.start(opts);
  }

  /**
   * Graceful shutdown of everything WE started (app quit). Returns per-process
   * outcomes; unresolved terminations stay recorded and are reported.
   */
  async stopAll(reason = 'app-shutdown') {
    const ids = [...this.processes.keys()];
    this.logger.info('controller', `stopping ${ids.length} managed server(s): ${reason}`);
    const outcomes = {};
    await Promise.allSettled(ids.map(async id => {
      try { outcomes[id] = await this.stop(id); }
      catch (e) { outcomes[id] = { id, confirmed: false, error: e.message }; }
    }));
    // Only confirmed stops were removed by stop(); unresolved entries stay
    // persisted (ownership store) for next-start recovery.
    const unresolved = Object.values(outcomes).filter(o => o && o.confirmed === false);
    if (unresolved.length) this.logger.warn('controller', `${unresolved.length} server(s) NOT confirmed stopped: ${unresolved.map(u => u.id).join(', ')}`);
    return { reason, outcomes, unresolved: unresolved.map(u => u.id) };
  }

  _resolve(idOrKey) {
    if (this.processes.has(idOrKey)) return this.processes.get(idOrKey);
    for (const p of this.processes.values()) if (`${p.engineId}:${p.model}` === idOrKey) return p;
    return null;
  }

  logLogDirSafe() { return this.logDir; }

  /** Externally running inference processes (read-only listing, never killed). */
  async listExternal() {
    const names = ['llama-server', 'ollama', 'lemonade-server'];
    const found = [];
    if (isWindows()) {
      const { spawnSync } = require('child_process');
      const filter = names.map(n => n + '.exe').join(',');
      const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
        `Get-Process -Name ${names.map(n => `'${n}'`).join(',')} -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64 | ConvertTo-Json -Compress`],
        { timeout: 10000, encoding: 'utf8', windowsHide: true });
      try {
        let j = JSON.parse(r.stdout || '[]');
        if (!Array.isArray(j)) j = [j];
        for (const item of j) {
          found.push({
            pid: item.Id, name: item.ProcessName,
            memoryBytes: item.WorkingSet64 || 0,
            managed: [...this.processes.values()].some(p => p.pid === item.Id)
          });
        }
      } catch (_) { /* PowerShell unavailable */ }
    } else {
      const names = new Set(['llama-server', 'ollama', 'lemonade-server']);
      try {
        for (const ent of fs.readdirSync('/proc')) {
          if (!/^\d+$/.test(ent)) continue;
          const pid = parseInt(ent, 10);
          if (pid === process.pid) continue;
          let comm = '';
          try { comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch (_) { continue; }
          if (!names.has(comm)) continue;
          let rss = 0;
          try {
            const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
            const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
            if (m) rss = parseInt(m[1], 10) * 1024;
          } catch (_) { /* unreadable */ }
          found.push({
            pid, name: comm, memoryBytes: rss,
            managed: [...this.processes.values()].some(p => p.pid === pid)
          });
        }
      } catch (_) { /* /proc unavailable */ }
    }
    return found;
  }
}

function baseNameAny(p) {
  const s = String(p);
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

module.exports = { ServerController, DuplicateProcessError };
