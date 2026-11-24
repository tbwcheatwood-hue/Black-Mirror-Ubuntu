'use strict';
/**
 * Model library: indexes existing GGUF files in place.
 *
 * Core invariants:
 *  - NEVER copy, move, rename or delete model files. The library stores path
 *    references and a metadata cache only.
 *  - User-added directories are scanned recursively (bounded depth).
 *  - Imports without copying: any .gguf path can be registered directly.
 *
 * Persistence: models.json in the app data dir.
 */
const fs = require('fs');
const path = require('path');
const { JsonStore } = require('../core/store');
const gguf = require('./gguf');
const { estimateMemory } = require('./estimate');

const DEFAULTS = {
  scanDirs: [],          // user-chosen directories
  importedFiles: [],     // individually imported .gguf paths (no copy)
  models: {},            // path -> cached metadata summary
  favorites: [],         // paths
  categories: {},        // category name -> [paths]
  profiles: {}           // path -> per-model config overrides
};

class ModelLibrary {
  constructor(dataDir, logger, opts = {}) {
    this.logger = logger;
    this.maxDepth = opts.maxDepth ?? 6;
    this.store = new JsonStore(path.join(dataDir, 'models.json'), DEFAULTS);
    this.store.load();
    this._onIndex = opts.onIndex; // callback after refresh
  }

  get data() { return this.store.data; }

  listScanDirs() { return [...this.data.scanDirs]; }

  addScanDir(dir) {
    const norm = path.resolve(dir);
    if (!fs.existsSync(norm) || !fs.statSync(norm).isDirectory()) {
      throw new Error(`Not a directory: ${norm}`);
    }
    if (!this.data.scanDirs.includes(norm)) this.data.scanDirs.push(norm);
    this.store.save();
    return norm;
  }

  removeScanDir(dir) {
    const norm = path.resolve(dir);
    this.data.scanDirs = this.data.scanDirs.filter(d => d !== norm);
    this.store.save();
    return true;
  }

  /** Import an existing GGUF file without copying it. */
  importFile(filePath) {
    const norm = path.resolve(filePath);
    if (!fs.existsSync(norm)) throw new Error(`File not found: ${norm}`);
    if (!norm.toLowerCase().endsWith('.gguf')) throw new Error(`Not a GGUF file: ${norm}`);
    if (!this.data.importedFiles.includes(norm)) this.data.importedFiles.push(norm);
    this.store.save();
    return this.indexFile(norm);
  }

  /**
   * Index one file: parse GGUF metadata (cached by path+mtime+size).
   * Invalid files are reported in the result, not thrown.
   */
  indexFile(filePath, opts = {}) {
    let stat;
    try { stat = fs.statSync(filePath); } catch (_) { return null; }
    if (!stat.isFile()) return null;
    if (!filePath.toLowerCase().endsWith('.gguf')) return null;
    const cached = this.data.models[filePath];
    if (!opts.force && cached && cached.sizeBytes === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached;
    }
    try {
      const summary = gguf.summarize(filePath, stat);
      const fileName = path.basename(filePath);
      const model = {
        ...summary,
        fileName,
        kind: gguf.isMmprojFile(fileName) ? 'mmproj' : 'model',
        split: gguf.detectSplit(fileName), // null for single-file models
        mtimeMs: stat.mtimeMs,
        indexedAt: Date.now(),
        error: null
      };
      this.data.models[filePath] = model;
      return model;
    } catch (e) {
      const model = {
        path: filePath,
        fileName: path.basename(filePath),
        sizeBytes: stat.size,
        sizeMB: Math.round(stat.size / (1024 * 1024)),
        mtimeMs: stat.mtimeMs,
        indexedAt: Date.now(),
        error: e.code === 'bad-magic' ? 'Not a GGUF file'
          : e.code === 'truncated' ? 'File appears truncated or still downloading'
          : `Failed to parse: ${e.message}`,
        invalid: true
      };
      this.data.models[filePath] = model;
      return model;
    }
  }

  /** Recursive bounded scan of a directory. */
  _walk(dir, files, depth = 0) {
    if (depth > this.maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // skip hidden dirs (pip/temp noise)
      const p = path.join(dir, e.name);
      if (e.isDirectory()) this._walk(p, files, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.gguf')) files.add(p);
    }
  }

  /**
   * Refresh the whole library: scan all configured dirs + imported files.
   * Existing cached metadata for unchanged files is kept (fast refresh).
   */
  async refresh(opts = {}) {
    const paths = new Set();
    for (const dir of this.data.scanDirs) this._walk(dir, paths);
    for (const f of this.data.importedFiles) {
      if (fs.existsSync(f)) paths.add(f);
    }
    let added = 0, updated = 0, invalid = 0;
    for (const p of paths) {
      const before = this.data.models[p];
      const after = this.indexFile(p, { force: !!opts.force });
      if (after) {
        if (!before) added++;
        else if (before.error !== after.error) updated++;
        if (after.invalid) invalid++;
      }
    }
    // Group split-GGUF shards: total group size drives estimates and the UI
    // (llama.cpp loads the first shard and finds its siblings automatically).
    this._annotateSplits();
    // Drop cache entries for files that vanished (we never delete the files,
    // only the index reference).
    for (const p of Object.keys(this.data.models)) {
      if (!paths.has(p)) delete this.data.models[p];
    }
    // Prune dangling favorites / categories / profiles.
    this.data.favorites = this.data.favorites.filter(p => paths.has(p));
    for (const cat of Object.keys(this.data.categories)) {
      this.data.categories[cat] = this.data.categories[cat].filter(p => paths.has(p));
    }
    for (const p of Object.keys(this.data.profiles)) {
      if (!paths.has(p)) delete this.data.profiles[p];
    }
    this.store.save();
    const result = {
      total: Object.keys(this.data.models).length,
      added, updated, invalid,
      models: this.list()
    };
    if (this._onIndex) this._onIndex(result);
    return result;
  }

  /** Sum sizes per split group; write splitTotalBytes + missing-shard info. */
  _annotateSplits() {
    const groups = new Map(); // `${dir}::${base}` -> [models]
    for (const m of Object.values(this.data.models)) {
      if (m.invalid || !m.split) continue;
      const key = `${path.dirname(m.path)}::${m.split.base}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    // reset annotations on single files first
    for (const m of Object.values(this.data.models)) {
      if (m.split) continue;
      delete m.splitTotalBytes;
      delete m.splitMissingShards;
    }
    for (const [key, shards] of groups) {
      const total = shards[0].split.total;
      const byIndex = new Map(shards.map(s => [s.split.index, s]));
      const groupBytes = shards.reduce((a, s) => a + (s.sizeBytes || 0), 0);
      const missing = [];
      for (let i = 1; i <= total; i++) if (!byIndex.has(i)) missing.push(i);
      for (const s of shards) {
        s.splitTotalBytes = groupBytes;
        s.splitMissingShards = missing;
        s.splitComplete = missing.length === 0;
        // Weight memory of a split model = whole group (KV/overhead unchanged).
        s.sizeBytes = s.sizeBytes; // per-file size stays truthful
      }
      void key;
    }
  }

  /** Multimodal projector files found in the library. */
  listMmproj() {
    return Object.values(this.data.models).filter(m => m.kind === 'mmproj' && !m.invalid);
  }

  /**
   * Projector candidates for a model: mmproj files in the same directory,
   * or sharing the model's base name prefix. Nearest match first.
   */
  mmprojForModel(modelPath) {
    const model = this.data.models[path.resolve(modelPath)];
    if (!model) return [];
    const dir = path.dirname(model.path);
    const base = (model.split ? model.split.base : model.fileName.replace(/\.gguf$/i, '')).toLowerCase();
    return this.listMmproj()
      .map(m => {
        const name = m.fileName.toLowerCase();
        let score = path.dirname(m.path) === dir ? 2 : 0;
        if (name.startsWith('mmproj') && base && base.split('-')[0] && name.includes(base.split('-')[0])) score += 1;
        return { model: m, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(x => x.model);
  }

  list(filter = {}) {
    let models = Object.values(this.data.models);
    if (filter.search) {
      const s = filter.search.toLowerCase();
      models = models.filter(m =>
        (m.name || '').toLowerCase().includes(s) ||
        (m.fileName || '').toLowerCase().includes(s) ||
        (m.architecture || '').toLowerCase().includes(s));
    }
    if (filter.arch) models = models.filter(m => m.architecture === filter.arch);
    if (filter.quant) models = models.filter(m => m.quant === filter.quant);
    if (filter.category) models = models.filter(m => (this.data.categories[filter.category] || []).includes(m.path));
    if (filter.onlyValid) models = models.filter(m => !m.invalid);
    // decorate with favorite flag + profile existence
    models = models.map(m => ({
      ...m,
      favorite: this.data.favorites.includes(m.path),
      hasProfile: !!this.data.profiles[m.path],
      categories: Object.keys(this.data.categories).filter(c => this.data.categories[c].includes(m.path))
    }));
    models.sort((a, b) => (a.fileName || '').localeCompare(b.fileName || ''));
    return models;
  }

  get(filePath) {
    return this.data.models[path.resolve(filePath)] || null;
  }

  /** Memory estimate for a model at a given context/cache config.
   *  Split models estimate against the whole shard group. */
  estimate(filePath, opts) {
    const m = this.get(filePath);
    if (!m || m.invalid) throw new Error('Model not indexed or invalid');
    const effective = m.splitTotalBytes ? { ...m, sizeBytes: m.splitTotalBytes } : m;
    return estimateMemory(effective, opts);
  }

  toggleFavorite(filePath) {
    const p = path.resolve(filePath);
    const i = this.data.favorites.indexOf(p);
    if (i >= 0) this.data.favorites.splice(i, 1); else this.data.favorites.push(p);
    this.store.save();
    return i < 0;
  }

  setCategories(filePath, categories) {
    const p = path.resolve(filePath);
    for (const cat of Object.keys(this.data.categories)) {
      this.data.categories[cat] = this.data.categories[cat].filter(x => x !== p);
      if (!this.data.categories[cat].length) delete this.data.categories[cat];
    }
    for (const cat of categories || []) {
      if (!this.data.categories[cat]) this.data.categories[cat] = [];
      this.data.categories[cat].push(p);
    }
    this.store.save();
    return true;
  }

  listCategories() {
    return Object.entries(this.data.categories).map(([name, models]) => ({ name, count: models.length }));
  }

  /** Per-model configuration profile (overrides global defaults). */
  getProfile(filePath) {
    return this.data.profiles[path.resolve(filePath)] || null;
  }

  saveProfile(filePath, profile) {
    this.data.profiles[path.resolve(filePath)] = { ...profile, savedAt: Date.now() };
    this.store.save();
    return this.data.profiles[path.resolve(filePath)];
  }

  deleteProfile(filePath) {
    delete this.data.profiles[path.resolve(filePath)];
    this.store.save();
    return true;
  }
}

module.exports = { ModelLibrary, DEFAULTS };
