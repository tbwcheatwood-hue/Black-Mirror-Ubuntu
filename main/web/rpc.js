'use strict';
/**
 * HTTP RPC for the Ubuntu live preview. Same operations as Electron IPC.
 * This module never imports Electron. It is not used by the unit tests.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { defaultAppDataDir } = require('../core/util');
const { Logger } = require('../core/log');
const { Config } = require('../core/config');
const { Conversations } = require('../core/conversations');
const { ModelLibrary } = require('../models/library');
const { EngineRegistry } = require('../engines/registry');
const { EngineInstaller } = require('../engines/installer');
const { ServerController } = require('../server/controller');
const { Monitor } = require('../monitor/monitor');
const { BenchRunner } = require('../benchmark/bench');
const { CompatibilityLab } = require('../compatlab/lab');
const { assessCompatibility } = require('../compatlab/assessor');
const { recommendAll, GOALS } = require('../profiles');
const { Diagnostics } = require('../diagnostics');
const { JsonStore } = require('../core/store');
const { PARAM_SCHEMA } = require('../engines/adapters');

let core = null;
const events = [];

function push(channel, payload) {
  events.push({ channel, payload });
  if (events.length > 300) events.shift();
}

function dataDir() {
  return process.env.BLACK_MIRROR_DATA_DIR || defaultAppDataDir();
}

function getCore() {
  if (core) return core;
  const dd = dataDir();
  fs.mkdirSync(dd, { recursive: true });
  const logger = new Logger(path.join(dd, 'logs'), process.env.BLACK_MIRROR_LOG_LEVEL || 'info');
  logger.info('web', `Black Mirror web runtime; data dir ${dd}`);
  const config = new Config(dd);
  const conversations = new Conversations(dd, logger);
  const library = new ModelLibrary(dd, logger);
  const registry = new EngineRegistry(dd, logger);
  const installer = new EngineInstaller(registry, logger, {
    onProgress: p => push('engine-install-progress', p)
  });
  const controller = new ServerController(registry, logger, {
    dataDir: dd,
    onEvent: e => {
      push('server-event', e);
      if (e.event === 'server-log') push('server-log', e);
      if (e.event === 'server-ready' || e.event === 'server-exit') push('server-state', controller.list());
    }
  });
  let lastMonitorSample = null;
  const monitor = new Monitor(logger, {
    intervalMs: config.get('monitor.intervalMs', 2000),
    getManagedPids: () => controller.list().filter(p => p.pid).map(p => p.pid),
    serverStartTimes: () => Object.fromEntries(controller.list().filter(p => p.startedAt).map(p => [p.id, p.startedAt])),
    onSample: s => { lastMonitorSample = s; push('monitor-sample', s); }
  });
  const benchStore = new JsonStore(path.join(dd, 'benchmarks.json'), { results: [] });
  benchStore.load();
  const lab = new CompatibilityLab(controller, registry, logger, {
    dataDir: dd,
    appVersion: '1.2.2',
    onEvent: e => push('lab-progress', e)
  });
  const diagnostics = new Diagnostics({ appVersion: '1.2.2', logger, registry, installer, library, controller, lab, monitor });
  const bench = new BenchRunner(controller, registry, logger, {
    store: benchStore,
    onProgress: p => push('bench-progress', p)
  });
  let recovery = { adopted: [], external: [], cleared: [] };
  try { recovery = controller.recoverAtStartup(); } catch (e) { logger.warn('web', e.message); }
  push('recovery-report', recovery);
  monitor.start();
  library.refresh().then(r => push('library-updated', r)).catch(e => logger.warn('web', e.message));
  core = { dd, logger, config, conversations, library, registry, installer, controller, monitor, lab, diagnostics, bench, benchStore, get lastMonitorSample() { return lastMonitorSample; }, setSample(s) { lastMonitorSample = s; } };
  return core;
}

async function dispatch(c, method, args) {
  switch (method) {
    case 'events:poll': {
      const drained = events.splice(0, events.length);
      return {
        events: drained,
        platform: process.platform,
        versions: { app: '1.2.2', electron: null, node: process.versions.node }
      };
    }
    case 'config:get': return c.config.data;
    case 'config:set': return c.config.set(args[0], args[1]);
    case 'config:setParams': return c.config.setParams(args[0]);
    case 'library:refresh': return c.library.refresh();
    case 'library:list': return c.library.list(args[0] || {});
    case 'library:get': return c.library.get(args[0]);
    case 'library:addScanDir': return c.library.addScanDir(args[0]);
    case 'library:removeScanDir': return c.library.removeScanDir(args[0]);
    case 'library:listScanDirs': return c.library.listScanDirs();
    case 'library:importFile': return c.library.importFile(args[0]);
    case 'library:toggleFavorite': return c.library.toggleFavorite(args[0]);
    case 'library:setCategories': return c.library.setCategories(args[0], args[1]);
    case 'library:categories': return c.library.listCategories();
    case 'library:mmprojFor': return c.library.mmprojForModel(args[0]);
    case 'library:getProfile': return c.library.getProfile(args[0]);
    case 'library:saveProfile': return c.library.saveProfile(args[0], args[1]);
    case 'library:deleteProfile': return c.library.deleteProfile(args[0]);
    case 'library:assess': {
      const model = c.library.get(args[0]);
      if (!model || model.invalid) throw new Error('Model not indexed or invalid');
      const est = c.library.estimate(args[0], { contextLength: args[1], kvCacheType: 'f16' });
      const { assess } = require('../models/estimate');
      const sample = c.lastMonitorSample;
      const verdict = assess(model, est, {
        freeBytes: os.freemem(),
        totalBytes: os.totalmem(),
        commitFreeBytes: sample ? sample.memory.committedFreeBytes : null
      }, args[1], args[2]);
      return { estimate: est, verdict };
    }
    case 'engines:status': return c.registry.status();
    case 'engines:hardware': return c.registry.hardwareInfo();
    case 'engines:capabilities': {
      const st = (await c.registry.status()).find(s => s.id === args[0]);
      return st ? (st.probedCapabilities || { probed: false, note: st.error || 'not probeable' }) : null;
    }
    case 'engines:install': return c.installer.install(args[0]);
    case 'engines:uninstall': return c.installer.uninstall(args[0], args[1]);
    case 'engines:setActive': return c.registry.setActiveVersion(args[0], args[1]);
    case 'engines:setCustomPath': return c.registry.setCustomPath(args[0], args[1]);
    case 'engines:updateSettings': return c.registry.updateSettings(args[0], args[1]);
    case 'engines:paramSchema': return PARAM_SCHEMA;
    case 'engines:checkUpdate': {
      const d = c.registry.descriptor(args[0]);
      const st = (await c.registry.status()).find(x => x.id === args[0]);
      if (!st || !st.installed) return { updateAvailable: false, reason: 'not installed' };
      try {
        const resolved = await c.installer.resolveTag(c.installer._platformDescriptor(d), null);
        return { updateAvailable: resolved.tag !== st.activeTag, latestTag: resolved.tag, installedTag: st.activeTag, via: resolved.via };
      } catch (e) {
        return { updateAvailable: false, reason: `release discovery failed: ${e.message}` };
      }
    }
    case 'servers:list': return c.controller.list();
    case 'servers:external': return c.controller.listExternal();
    case 'servers:start': return c.controller.start(args[0]);
    case 'servers:stop': return c.controller.stop(args[0]);
    case 'servers:restart': return c.controller.restart(args[0]);
    case 'servers:logs': {
      const p = c.controller._resolve(args[0]);
      return p ? p.logs.slice(-400) : [];
    }
    case 'servers:addRemote': return c.controller.addRemote(args[0]);
    case 'servers:removeRemote': return c.controller.removeRemote(args[0]);
    case 'servers:testRemote': return c.controller.testRemote(args[0]);
    case 'servers:engineModels': {
      const engineId = args[0];
      const d = c.registry.descriptor(engineId);
      const st = (await c.registry.status()).find(s => s.id === engineId);
      if (!st || st.status !== 'available') throw new Error(`Engine ${engineId} is not available: ${st ? st.error : 'unknown'}`);
      const a = c.registry.adapter(engineId);
      const port = (st.settings && st.settings.port) || d.defaultPort;
      const bind = (st.settings && st.settings.bind) || d.defaultBind || '127.0.0.1';
      return a.listModels(`http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${port}`, fetch);
    }
    case 'monitor:sample': return c.lastMonitorSample || c.monitor.sample();
    case 'lab:assess': {
      const opts = args[0] || {};
      const model = c.library.get(opts.modelPath);
      const st = (await c.registry.status()).find(x => x.id === opts.engineId) || null;
      const hardware = c.registry.hardwareInfo();
      const memory = {
        totalBytes: os.totalmem(),
        freeBytes: os.freemem(),
        commitFreeBytes: c.lastMonitorSample ? c.lastMonitorSample.memory.committedFreeBytes : null
      };
      const cfg = { modelPath: opts.modelPath, engineId: opts.engineId, accel: opts.accel || (st && st.acceleration), profileKey: opts.profileKey, params: opts.params, modelMtimeMs: model ? model.mtimeMs : null, engineTag: st ? st.activeTag : null };
      const saved = c.lab.latestResultFor(cfg);
      const verdict = assessCompatibility({ model, engine: st, hardware, memory, savedResult: saved, requested: { accel: cfg.accel, params: opts.params } });
      return { ...verdict, savedResult: saved, key: cfg, goals: GOALS };
    }
    case 'lab:runTest': return c.lab.runTest(args[0]);
    case 'lab:results': return c.lab.results();
    case 'lab:invalidate': return c.lab.invalidate(args[0]);
    case 'profiles:list': {
      const opts = args[0] || {};
      const model = c.library.get(opts.modelPath);
      const st = (await c.registry.status()).find(x => x.id === opts.engineId);
      const hardware = c.registry.hardwareInfo();
      return recommendAll({ model, hardware, capabilities: st ? { helpFlags: st.probedHelpFlags || null } : null, engine: st, logicalCores: os.cpus().length });
    }
    case 'profiles:goals': return GOALS;
    case 'diag:snapshot': return c.diagnostics.collect();
    case 'diag:export': return c.diagnostics.exportReport(c.dd);
    case 'shell:dataDir': return c.dd;
    case 'chat:list': return c.conversations.list();
    case 'chat:get': return c.conversations.get(args[0]);
    case 'chat:create': return c.conversations.create(args[0] || {});
    case 'chat:append': return c.conversations.appendMessage(args[0], args[1]);
    case 'chat:updateMessage': return c.conversations.updateMessage(args[0], args[1], args[2]);
    case 'chat:truncateFrom': return c.conversations.truncateFrom(args[0], args[1], args[2]);
    case 'chat:setMeta': return c.conversations.setMeta(args[0], args[1]);
    case 'chat:remove': return c.conversations.remove(args[0]);
    case 'chat:search': return c.conversations.search(args[0]);
    case 'bench:results': return c.bench.results();
    case 'bench:run': return c.bench.run(args[0], (n) => `the quick brown fox jumps over the lazy dog `.repeat(Math.ceil(n / 9)).slice(0, n * 5));
    case 'bench:remove': return c.bench.remove(args[0]);
    case 'bench:trackPid': return true;
    default: throw new Error(`Unknown method ${method}`);
  }
}

async function handleRpc(body) {
  const method = body && body.method;
  const args = (body && body.args) || [];
  try {
    const c = getCore();
    const data = await dispatch(c, method, args);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code || null };
  }
}

module.exports = { handleRpc, getCore };
