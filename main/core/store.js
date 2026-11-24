'use strict';
/**
 * Simple persistent JSON store with atomic writes.
 * Plain Node module (no Electron imports) so it is fully unit-testable.
 */
const fs = require('fs');
const path = require('path');

class JsonStore {
  /**
   * @param {string} filePath absolute path of the JSON file
   * @param {object} defaults defaults merged over empty/invalid files
   */
  constructor(filePath, defaults = {}) {
    this.filePath = filePath;
    this.defaults = defaults;
    this._data = null;
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        this._data = { ...structuredClone(this.defaults), ...parsed };
        return this._data;
      }
    } catch (e) {
      // Corrupt store: keep a backup and fall back to defaults so the app
      // never fails to start because of a broken config file.
      try {
        const backup = this.filePath + '.corrupt.' + Date.now();
        fs.copyFileSync(this.filePath, backup);
      } catch (_) { /* ignore */ }
    }
    this._data = structuredClone(this.defaults);
    this.save();
    return this._data;
  }

  get data() {
    if (this._data === null) this.load();
    return this._data;
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
    return value;
  }

  get(key, fallback) {
    const v = this.data[key];
    return v === undefined ? fallback : v;
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: temp file in the same directory, then rename.
    const tmp = path.join(dir, '.' + path.basename(this.filePath) + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
    return true;
  }
}

module.exports = { JsonStore };
