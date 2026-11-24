'use strict';
/**
 * Preload: exposes a narrow, promise-based API to the renderer via
 * contextBridge. No Node primitives leak into the web context.
 */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = async (channel, ...args) => {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || res.ok !== true) {
    const err = new Error(res && res.error ? res.error : 'IPC call failed');
    err.code = res && res.code;
    throw err;
  }
  return res.data;
};

contextBridge.exposeInMainWorld('blackMirror', {
  // config
  getConfig: () => invoke('config:get'),
  setConfig: (path, value) => invoke('config:set', path, value),
  setParams: (patch) => invoke('config:setParams', patch),
  pickDirectory: () => invoke('dialog:directory'),
  pickFile: () => invoke('dialog:file'),
  openDataDir: () => invoke('shell:dataDir'),

  // model library
  library: {
    refresh: () => invoke('library:refresh'),
    list: (filter) => invoke('library:list', filter),
    get: (p) => invoke('library:get', p),
    addScanDir: (dir) => invoke('library:addScanDir', dir),
    removeScanDir: (dir) => invoke('library:removeScanDir', dir),
    listScanDirs: () => invoke('library:listScanDirs'),
    importFile: (p) => invoke('library:importFile', p),
    toggleFavorite: (p) => invoke('library:toggleFavorite', p),
    setCategories: (p, cats) => invoke('library:setCategories', p, cats),
    categories: () => invoke('library:categories'),
    mmprojFor: (p) => invoke('library:mmprojFor', p),
    getProfile: (p) => invoke('library:getProfile', p),
    saveProfile: (p, prof) => invoke('library:saveProfile', p, prof),
    deleteProfile: (p) => invoke('library:deleteProfile', p),
    assess: (p, contextLength, slots) => invoke('library:assess', p, contextLength, slots)
  },

  // engines
  engines: {
    status: () => invoke('engines:status'),
    hardware: () => invoke('engines:hardware'),
    capabilities: (id) => invoke('engines:capabilities', id),
    install: (id) => invoke('engines:install', id),
    uninstall: (id, tag) => invoke('engines:uninstall', id, tag),
    setActive: (id, tag) => invoke('engines:setActive', id, tag),
    setCustomPath: (id, p) => invoke('engines:setCustomPath', id, p),
    updateSettings: (id, s) => invoke('engines:updateSettings', id, s),
    paramSchema: () => invoke('engines:paramSchema')
  },

  // servers
  servers: {
    list: () => invoke('servers:list'),
    external: () => invoke('servers:external'),
    start: (opts) => invoke('servers:start', opts),
    stop: (id) => invoke('servers:stop', id),
    restart: (id) => invoke('servers:restart', id),
    logs: (id) => invoke('servers:logs', id),
    engineModels: (engineId) => invoke('servers:engineModels', engineId),
    addRemote: (opts) => invoke('servers:addRemote', opts),
    removeRemote: (id) => invoke('servers:removeRemote', id),
    testRemote: (idOrUrl) => invoke('servers:testRemote', idOrUrl)
  },

  // monitoring
  monitorSample: () => invoke('monitor:sample'),

  // compatibility lab
  lab: {
    assess: (opts) => invoke('lab:assess', opts),
    runTest: (cfg) => invoke('lab:runTest', cfg),
    results: () => invoke('lab:results'),
    invalidate: (p) => invoke('lab:invalidate', p)
  },

  // recommended profiles
  profiles: {
    list: (opts) => invoke('profiles:list', opts),
    goals: () => invoke('profiles:goals')
  },

  // diagnostics
  diagnostics: {
    snapshot: () => invoke('diag:snapshot'),
    exportReport: () => invoke('diag:export')
  },

  enginesExtra: {
    checkUpdate: (id) => invoke('engines:checkUpdate', id)
  },

  // conversations
  chat: {
    list: () => invoke('chat:list'),
    get: (id) => invoke('chat:get', id),
    create: (opts) => invoke('chat:create', opts),
    append: (id, msg) => invoke('chat:append', id, msg),
    updateMessage: (id, msgId, patch) => invoke('chat:updateMessage', id, msgId, patch),
    truncateFrom: (id, msgId, opts) => invoke('chat:truncateFrom', id, msgId, opts),
    setMeta: (id, patch) => invoke('chat:setMeta', id, patch),
    remove: (id) => invoke('chat:remove', id),
    search: (q) => invoke('chat:search', q)
  },

  // benchmark
  bench: {
    results: () => invoke('bench:results'),
    run: (cfg) => invoke('bench:run', cfg),
    remove: (id) => invoke('bench:remove', id),
    trackPid: (pid) => ipcRenderer.send('bench:track-pid', pid)
  },

  // push events from main
  on: (channel, handler) => {
    const allowed = ['server-event', 'server-state', 'server-log', 'monitor-sample', 'engine-install-progress', 'library-updated', 'bench-progress', 'recovery-report', 'lab-progress'];
    if (!allowed.includes(channel)) throw new Error(`channel not allowed: ${channel}`);
    const wrapped = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },

  platform: process.platform,
  versions: {
    app: '1.2.1',
    electron: process.versions.electron || null,
    node: process.versions.node || null
  }
});
