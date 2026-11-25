'use strict';
/**
 * Black Mirror — Electron main process.
 *
 * Wires the core modules (all plain Node, unit-tested without Electron)
 * to the renderer over a typed IPC surface. Only this file and ipc.js know
 * about Electron.
 */
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const { defaultAppDataDir, isWindows } = require('./core/util');
const { Logger } = require('./core/log');
const { Emitter } = require('./core/events');
const { Config } = require('./core/config');
const { Conversations } = require('./core/conversations');
const { ModelLibrary } = require('./models/library');
const { EngineRegistry } = require('./engines/registry');
const { EngineInstaller } = require('./engines/installer');
const { ServerController } = require('./server/controller');
const { Monitor } = require('./monitor/monitor');
const { BenchRunner } = require('./benchmark/bench');
const { CompatibilityLab } = require('./compatlab/lab');
const { assessCompatibility } = require('./compatlab/assessor');
const { recommendAll, GOALS } = require('./profiles');
const { Diagnostics } = require('./diagnostics');
const { JsonStore } = require('./core/store');
const { PARAM_SCHEMA } = require('./engines/adapters');
const { estimateMemory, assess } = require('./models/estimate');

// Prevent a second app instance (duplicate managed inference processes).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let win = null;
let logger, bus, config, conversations, library, registry, installer, controller, monitor, benchStore, bench, lab, diagnostics;
let lastMonitorSample = null;

function dataDir() {
  // %APPDATA%/BlackMirror on Windows; env override honored for dev.
  return process.env.BLACK_MIRROR_DATA_DIR || defaultAppDataDir();
}

function initCore() {
  const dd = dataDir();
  fs.mkdirSync(dd, { recursive: true });
  logger = new Logger(path.join(dd, 'logs'), process.env.BLACK_MIRROR_LOG_LEVEL || 'info');
  logger.info('app', `Black Mirror starting; data dir ${dd}`);
  bus = new Emitter();
  config = new Config(dd);
  conversations = new Conversations(dd, logger);
  library = new ModelLibrary(dd, logger);
  registry = new EngineRegistry(dd, logger);
  installer = new EngineInstaller(registry, logger, {
    onProgress: p => send('engine-install-progress', p)
  });
  controller = new ServerController(registry, logger, {
    dataDir: dd,
    onEvent: e => {
      send('server-event', e);
      // Live log stream uses its own channel (Servers view subscribes to it).
      if (e.event === 'server-log') send('server-log', e);
      if (e.event === 'server-ready') send('server-state', controller.list());
      if (e.event === 'server-exit') setTimeout(() => send('server-state', controller.list()), 100);
    }
  });
  monitor = new Monitor(logger, {
    intervalMs: config.get('monitor.intervalMs', 2000),
    getManagedPids: () => controller.list().filter(p => p.pid).map(p => p.pid),
    serverStartTimes: () => Object.fromEntries(controller.list().filter(p => p.startedAt).map(p => [p.id, p.startedAt])),
    onSample: s => { lastMonitorSample = s; send('monitor-sample', s); }
  });
  benchStore = new JsonStore(path.join(dd, 'benchmarks.json'), { results: [] });
  benchStore.load();
  lab = new CompatibilityLab(controller, registry, logger, {
    dataDir: dd,
    appVersion: app.getVersion ? app.getVersion() : '1.2.2',
    onEvent: e => send('lab-progress', e)
  });
  diagnostics = new Diagnostics({ appVersion: lab.appVersion, logger, registry, installer, library, controller, lab, monitor });
  bench = new BenchRunner(controller, registry, logger, {
    store: benchStore,
    onProgress: p => send('bench-progress', p),
    memorySampler: async () => {
      const pid = lastBenchPid();
      if (!pid) return null;
      if (isWindows()) {
        const w = monitor.win && await monitor.win.sample();
        return w ? { memoryBytes: w.pidWorkingSet(pid) } : null;
      }
      try {
        const txt = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        const m = txt.match(/VmRSS:\s+(\d+)\s+kB/);
        return m ? { memoryBytes: parseInt(m[1], 10) * 1024 } : null;
      } catch (_) { return null; }
    }
  });
  let lastBenchPidValue = null;
  function lastBenchPid() { return lastBenchPidValue; }
  bus.on('bench:pid', p => { lastBenchPidValue = p; });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#08070c',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url); // links open in the default browser
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}

/** RPC surface exposed to the renderer. */
function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      logger.warn('ipc', `${channel} failed: ${e.message}`);
      return { ok: false, error: e.message, code: e.code || null };
    }
  });

  // ---- config ----
  handle('config:get', () => config.data);
  handle('config:set', (path, value) => config.set(path, value));
  handle('config:setParams', patch => config.setParams(patch));
  handle('dialog:directory', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a model directory', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });
  handle('dialog:file', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a GGUF file',
      properties: ['openFile'],
      filters: [{ name: 'GGUF models', extensions: ['gguf'] }, { name: 'All files', extensions: ['*'] }]
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });
  handle('shell:dataDir', async () => {
    const dd = dataDir();
    try { await shell.openPath(dd); } catch (_) { /* still return the path */ }
    return dd;
  });

  // ---- library ----
  handle('library:refresh', () => library.refresh());
  handle('library:list', filter => library.list(filter || {}));
  handle('library:get', p => library.get(p));
  handle('library:addScanDir', dir => library.addScanDir(dir));
  handle('library:removeScanDir', dir => library.removeScanDir(dir));
  handle('library:listScanDirs', () => library.listScanDirs());
  handle('library:importFile', p => library.importFile(p));
  handle('library:toggleFavorite', p => library.toggleFavorite(p));
  handle('library:setCategories', (p, cats) => library.setCategories(p, cats));
  handle('library:categories', () => library.listCategories());
  handle('library:mmprojFor', p => library.mmprojForModel(p));
  handle('library:getProfile', p => library.getProfile(p));
  handle('library:saveProfile', (p, prof) => library.saveProfile(p, prof));
  handle('library:deleteProfile', p => library.deleteProfile(p));
  handle('library:assess', (p, contextLength, slots) => {
    const model = library.get(p);
    if (!model || model.invalid) throw new Error('Model not indexed or invalid');
    const est = library.estimate(p, { contextLength, kvCacheType: 'f16' });
    const os = require('os');
    const verdict = assess(model, est, {
      freeBytes: os.freemem(),
      totalBytes: os.totalmem(),
      commitFreeBytes: lastMonitorSample ? lastMonitorSample.memory.committedFreeBytes : null
    }, contextLength, slots);
    return { estimate: est, verdict };
  });

  // ---- engines ----
  handle('engines:status', () => registry.status());
  handle('engines:hardware', () => registry.hardwareInfo());
  handle('engines:capabilities', async engineId => {
    const st = (await registry.status()).find(s => s.id === engineId);
    return st ? (st.probedCapabilities || { probed: false, note: st.error || 'not probeable' }) : null;
  });
  handle('engines:install', engineId => installer.install(engineId));
  handle('engines:uninstall', (engineId, tag) => installer.uninstall(engineId, tag));
  handle('engines:setActive', (engineId, tag) => registry.setActiveVersion(engineId, tag));
  handle('engines:setCustomPath', (engineId, p) => registry.setCustomPath(engineId, p));
  handle('engines:updateSettings', (engineId, s) => registry.updateSettings(engineId, s));
  handle('engines:paramSchema', () => PARAM_SCHEMA);

  // ---- servers ----
  handle('servers:list', () => controller.list());
  handle('servers:external', () => controller.listExternal());
  handle('servers:start', async opts => {
    bus.emit('bench:pid', null);
    const p = await controller.start(opts);
    bus.emit('bench:pid', p.pid);
    return p;
  });
  handle('servers:stop', id => controller.stop(id));
  handle('servers:restart', id => controller.restart(id));
  handle('servers:logs', id => {
    const p = controller._resolve(id);
    return p ? p.logs.slice(-400) : [];
  });
  // Remote / external endpoints: connect-only, never owned or stopped.
  handle('servers:addRemote', opts => controller.addRemote(opts));
  handle('servers:removeRemote', id => controller.removeRemote(id));
  handle('servers:testRemote', idOrUrl => controller.testRemote(idOrUrl));
  // Engine-registry model listing (Ollama / Lemonade manage their own models).
  handle('servers:engineModels', async (engineId, override) => {
    const d = registry.descriptor(engineId);
    const st = (await registry.status()).find(s => s.id === engineId);
    if (!st || st.status !== 'available') throw new Error(`Engine ${engineId} is not available: ${st ? st.error : 'unknown'}`);
    const a = registry.adapter(engineId);
    if (!a.listModels) throw new Error(`Engine ${engineId} does not expose a model registry`);
    const port = (override && override.port) || (st.settings && st.settings.port) || d.defaultPort;
    const bind = (st.settings && st.settings.bind) || d.defaultBind || '127.0.0.1';
    return a.listModels(`http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${port}`, fetch);
  });

  // ---- conversations ----
  handle('chat:list', () => conversations.list());
  handle('chat:get', id => conversations.get(id));
  handle('chat:create', opts => conversations.create(opts || {}));
  handle('chat:append', (id, msg) => conversations.appendMessage(id, msg));
  handle('chat:updateMessage', (id, msgId, patch) => conversations.updateMessage(id, msgId, patch));
  handle('chat:truncateFrom', (id, msgId, opts) => conversations.truncateFrom(id, msgId, opts));
  handle('chat:setMeta', (id, patch) => conversations.setMeta(id, patch));
  handle('chat:remove', id => conversations.remove(id));
  handle('chat:search', q => conversations.search(q));

  // ---- benchmark ----
  handle('bench:results', () => bench.results());
  handle('bench:run', async cfg => {
    bus.emit('bench:pid', null);
    const result = await bench.run(cfg, (n) => `the quick brown fox jumps over the lazy dog `.repeat(Math.ceil(n / 9)).slice(0, n * 5));
    return result;
  });
  handle('bench:remove', id => bench.remove(id));
  ipcMain.on('bench:track-pid', (_e, pid) => bus.emit('bench:pid', pid));

  // ---- compatibility lab ----
  handle('lab:assess', async ({ modelPath, engineId, accel, profileKey, params }) => {
    const model = library.get(modelPath);
    const st = (await registry.status()).find(x => x.id === engineId) || null;
    const hardware = registry.hardwareInfo();
    const memory = {
      totalBytes: require('os').totalmem(),
      freeBytes: require('os').freemem(),
      commitFreeBytes: lastMonitorSample ? lastMonitorSample.memory.committedFreeBytes : null
    };
    const cfg = { modelPath, engineId, accel: accel || (st && st.acceleration), profileKey, params, modelMtimeMs: model ? model.mtimeMs : null, engineTag: st ? st.activeTag : null };
    const saved = lab ? lab.latestResultFor(cfg) : null;
    const verdict = assessCompatibility({ model, engine: st, hardware, memory, savedResult: saved, requested: { accel: cfg.accel, params } });
    return { ...verdict, savedResult: saved, key: cfg, goals: GOALS };
  });
  handle('lab:runTest', cfg => lab.runTest(cfg));
  handle('lab:results', () => lab.results());
  handle('lab:invalidate', modelPath => lab.invalidate(modelPath));

  // ---- recommended profiles ----
  handle('profiles:list', async ({ modelPath, engineId }) => {
    const model = library.get(modelPath);
    const st = (await registry.status()).find(x => x.id === engineId);
    const hardware = registry.hardwareInfo();
    return recommendAll({ model, hardware, capabilities: st ? { helpFlags: st.probedHelpFlags || null } : null, engine: st, logicalCores: require('os').cpus().length });
  });
  handle('profiles:goals', () => GOALS);

  // ---- diagnostics ----
  handle('diag:snapshot', () => diagnostics.collect());
  handle('diag:export', () => diagnostics.exportReport(config.get('dataDir') || app.getPath('userData')));

  // ---- engine update check ----
  handle('engines:checkUpdate', async engineId => {
    const d = registry.descriptor(engineId);
    const st = (await registry.status()).find(x => x.id === engineId);
    if (!st || !st.installed) return { updateAvailable: false, reason: 'not installed' };
    try {
      const resolved = await installer.resolveTag(d, null);
      return { updateAvailable: resolved.tag !== st.activeTag, latestTag: resolved.tag, installedTag: st.activeTag, via: resolved.via };
    } catch (e) {
      return { updateAvailable: false, reason: `release discovery failed: ${e.message}` };
    }
  });

  // ---- monitoring ----
  handle('monitor:sample', () => lastMonitorSample || monitor.sample());
}

function registerAppLifecycle() {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    initCore();
    registerIpc();
    // Recovery: re-verify ownership records from a previous run. Adopted
    // processes become managed again; unverifiable ones are classified
    // external and NEVER terminated.
    let recovery = { adopted: [], external: [], cleared: [] };
    try { recovery = controller.recoverAtStartup(); } catch (e) { logger.warn('app', `recovery failed: ${e.message}`); }
    createWindow();
    setTimeout(() => { try { send('recovery-report', recovery); } catch (_) { /* window not ready */ } }, 1200);
    // Warm the library cache if dirs configured; non-blocking.
    library.refresh().then(r => {
      logger.info('app', `library refreshed: ${r.total} models (${r.invalid} invalid)`);
      send('library-updated', r);
    }).catch(e => logger.warn('app', `library refresh failed: ${e.message}`));
    monitor.start();
  });

  // Clean shutdown: stop every process WE started, save everything, exit.
  let shuttingDown = false;
  app.on('before-quit', async (event) => {
    if (shuttingDown) return;
    shuttingDown = true;
    event.preventDefault();
    try {
      logger.info('app', 'shutdown: stopping managed servers');
      await controller.stopAll('app-shutdown');
      monitor.stop();
      logger.close();
    } catch (e) {
      logger.error('app', `shutdown error: ${e.message}`);
    }
    app.exit(0);
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

registerAppLifecycle();
