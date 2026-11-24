'use strict';
/**
 * Global application configuration (persistent, user-editable via Settings).
 */
const { JsonStore } = require('./store');
const { PARAM_SCHEMA } = require('../engines/adapters');

function defaultParams() {
  const p = {};
  for (const f of PARAM_SCHEMA) p[f.id] = f.default;
  return p;
}

const DEFAULTS = {
  version: 1,
  firstRunDone: false,
  defaultEngineId: 'llamacpp-cpu',
  defaultModelPath: null,
  network: {
    bind: '127.0.0.1',       // localhost only by default; 0.0.0.0 enables LAN
    defaultPort: 8081
  },
  params: defaultParams(),
  chat: {
    stream: true,
    showThinking: true,
    theme: 'dark'
  },
  benchmark: { promptTokens: 512, genTokens: 128, reps: 2 },
  monitor: { intervalMs: 2000 },
  logging: { level: 'info' }
};

class Config {
  constructor(dataDir) {
    this.store = new JsonStore(`${dataDir}/config.json`, DEFAULTS);
    this.store.load();
    this._migrate();
  }

  /** v1.0.0 → v1.1.0: thinkingMode bool → 'auto'|'on'|'off' enum. */
  _migrate() {
    const p = this.store.data.params;
    if (p && typeof p.thinkingMode === 'boolean') {
      p.thinkingMode = p.thinkingMode ? 'on' : 'auto';
      this.store.save();
    }
  }

  get data() { return this.store.data; }

  get(path, fallback) {
    const parts = path.split('.');
    let cur = this.store.data;
    for (const p of parts) {
      if (cur === undefined || cur === null) return fallback;
      cur = cur[p];
    }
    return cur === undefined ? fallback : cur;
  }

  set(path, value) {
    const parts = path.split('.');
    let cur = this.store.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    this.store.save();
    return value;
  }

  params() { return { ...defaultParams(), ...(this.store.data.params || {}) }; }

  setParams(patch) {
    this.store.data.params = { ...defaultParams(), ...(this.store.data.params || {}), ...patch };
    this.store.save();
    return this.store.data.params;
  }

  /** Merge a per-model profile over global defaults. */
  effectiveParams(modelProfile) {
    return { ...this.params(), ...(modelProfile || {}) };
  }

  network() { return { ...DEFAULTS.network, ...(this.store.data.network || {}) }; }

  markFirstRunDone() {
    this.store.data.firstRunDone = true;
    this.store.save();
  }
}

module.exports = { Config, DEFAULTS, defaultParams };
