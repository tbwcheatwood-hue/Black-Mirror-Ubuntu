'use strict';
/**
 * Diagnostics & Troubleshooting Center.
 *
 * Collects a complete local snapshot (version, OS, hardware, engines and
 * their probed capabilities, model library health, managed processes,
 * external endpoints, port conflicts, recent log lines, compatibility
 * results, memory state) and derives plain-language troubleshooting hints.
 * Export writes a JSON report to the data directory — nothing is ever sent
 * anywhere automatically.
 */
const fs = require('fs');
const path = require('path');

class Diagnostics {
  constructor(ctx) {
    // ctx: { appVersion, logger, registry, installer, library, controller, lab, monitor, compatAssessor }
    this.ctx = ctx;
  }

  async collect() {
    const c = this.ctx;
    const os = require('os');
    const out = {
      generatedAt: new Date().toISOString(),
      app: { version: c.appVersion, platform: process.platform, arch: process.arch, node: process.versions.node, electron: process.versions.electron || 'n/a (test harness)', uptimeSec: Math.floor(process.uptime()) },
      os: { release: os.release(), hostname: os.hostname(), totalMem: os.totalmem(), freeMem: os.freemem() },
      hardware: null,
      memorySample: null,
      engines: [],
      models: null,
      managedProcesses: [],
      unverifiedRecovered: [],
      remotes: [],
      portConflicts: [],
      recentErrors: [],
      compatResults: [],
      hints: []
    };
    try { out.hardware = c.registry.hardwareInfo(); } catch (e) { out.hardware = { error: e.message }; }
    try { out.memorySample = c.monitor ? c.monitor.sample() : null; } catch (_) { /* optional */ }
    try {
      out.engines = (await c.registry.status()).map(s => ({
        id: s.id, displayName: s.displayName, acceleration: s.acceleration,
        installed: s.installed, activeTag: s.activeTag, version: s.version && s.version.label,
        executable: s.executable, error: s.error, statusCategory: s.statusCategory,
        probedCapabilities: s.probedCapabilities
      }));
    } catch (e) { out.engines = [{ error: e.message }]; }
    try {
      const models = c.library.list({});
      out.models = {
        total: models.length,
        invalid: models.filter(m => m.invalid).length,
        incompleteSplits: models.filter(m => m.split && m.splitComplete === false).length,
        mmproj: models.filter(m => m.kind === 'mmproj').length
      };
    } catch (_) { /* optional */ }
    try {
      out.managedProcesses = c.controller.list().filter(p => p.mode === 'managed').map(p => ({ id: p.id, pid: p.pid, model: p.model, port: p.port, status: p.status, recovered: !!p.pidRecovered }));
      out.remotes = c.controller.list().filter(p => p.mode === 'remote').map(p => ({ id: p.id, baseUrl: p.baseUrl, status: p.status }));
      out.unverifiedRecovered = (c.controller.recoveredExternal || []).map(r => ({ pid: r.pid, engineId: r.engineId, reason: r.reason, exe: r.snapshot && r.snapshot.exe }));
    } catch (_) { /* optional */ }
    // Port conflicts on the default ports of installed engines
    try {
      const { checkPort } = require('./server/ports');
      for (const s of out.engines) {
        if (s.installed && s.id !== 'ollama' && s.id !== 'lemonade') {
          // check a fixed probe set around the app default
          const port = ({ 'llamacpp-cpu': 8081, 'llamacpp-vulkan': 8082, 'llamacpp-sycl': 8083 })[s.id];
          if (port) out.portConflicts.push({ engineId: s.id, port, occupied: await checkPort(port, '127.0.0.1') });
        }
      }
    } catch (_) { /* optional */ }
    try {
      out.recentErrors = (c.logger.ring || []).filter(l => /\[warn\]|\[error\]/.test(l)).slice(-40);
    } catch (_) { /* optional */ }
    try { out.compatResults = c.lab ? c.lab.results().slice(0, 20).map(r => ({ key: `${r.engineId} @ ${path.basename(r.modelPath)}`, outcome: r.outcome, stale: r.stale, at: r.at })) : []; } catch (_) { /* optional */ }
    out.hints = this.hints(out);
    return out;
  }

  /** Symptom → likely-cause mapping for the troubleshooting panel. */
  hints(d) {
    const hints = [];
    for (const e of d.engines || []) {
      if (e.installed && !e.version && e.error) hints.push(`Engine "${e.displayName}": binary present but version probe failed (${e.error}) — possibly a corrupted install or a wrong custom path. Reinstall or fix the custom executable path.`);
      if (e.installed && e.activeTag) {
        // outdated-engine hint handled by the update check in the UI; here only probe mismatches
        const pc = e.probedCapabilities;
        if (pc && !pc.probed) hints.push(`Engine "${e.displayName}": capability probe failed (${pc.note}) — the binary may be damaged or incompatible with this OS/arch.`);
      }
      if (e.statusCategory === 'experimental') hints.push(`Engine "${e.displayName}" is experimental on this machine: acceleration runtime unverified. CPU engines remain usable.`);
    }
    if (d.models && d.models.invalid > 0) hints.push(`${d.models.invalid} model file(s) failed GGUF parsing — likely truncated downloads or non-GGUF files; check the Model Library detail view.`);
    if (d.models && d.models.incompleteSplits > 0) hints.push(`${d.models.incompleteSplits} split model(s) are missing shards — downloads interrupted. Re-download the missing shard(s); loading will fail until complete.`);
    for (const pc of d.portConflicts || []) if (pc.occupied) hints.push(`Default port ${pc.port} is already occupied — another process (possibly an external inference server) owns it. Change the port or stop the other service YOURSELF; Black Mirror will not kill it.`);
    for (const u of d.unverifiedRecovered || []) hints.push(`A process (pid ${u.pid}) matching an old managed record could NOT be verified as ours (${u.reason}). It is classified external and will never be terminated automatically.`);
    const mem = d.memorySample && d.memorySample.memory;
    if (mem && mem.committedFreeBytes != null && mem.committedFreeBytes < 2 * 1024 ** 3) {
      hints.push('Windows commit charge headroom is below 2 GB — model loads may fail even with physical RAM free. Close applications or extend the pagefile (Windows settings, not Black Mirror).');
    }
    const failedStages = [];
    for (const r of d.compatResults || []) if (r.outcome === 'fail' && !r.stale) failedStages.push(r.key);
    if (failedStages.length) hints.push(`Recent compatibility tests FAILED for: ${failedStages.join('; ')}. Open Compatibility Lab for the failing stage diagnostics.`);
    if (!hints.length) hints.push('No anomalies detected in this snapshot.');
    return hints;
  }

  /** Export to the local data dir; returns the absolute path (no network). */
  async exportReport(dataDir) {
    const snapshot = await this.collect();
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, `black-mirror-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
    return file;
  }
}

module.exports = { Diagnostics };
