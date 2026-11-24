'use strict';
/**
 * Diagnostic logging with rotating files and an in-memory ring buffer.
 * Levels: debug < info < warn < error.
 */
const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_RING = 2000;
const MAX_FILES = 10;

class Logger {
  constructor(logDir, level = 'info') {
    this.logDir = logDir;
    this.level = level in LEVELS ? level : 'info';
    this.ring = [];
    this._fd = null;
    this._dateStamp = null;
    if (logDir) fs.mkdirSync(logDir, { recursive: true });
  }

  setLevel(level) {
    if (level in LEVELS) this.level = level;
  }

  _stamp() {
    return new Date().toISOString();
  }

  _date() {
    return new Date().toISOString().slice(0, 10);
  }

  _write(line) {
    this.ring.push(line);
    if (this.ring.length > MAX_RING) this.ring.shift();
    if (!this.logDir) return;
    try {
      const d = this._date();
      if (d !== this._dateStamp || !this._fd) {
        this._rotate(d);
      }
      if (this._fd) fs.writeSync(this._fd, line + '\n');
    } catch (_) { /* logging must never crash the app */ }
  }

  _rotate(d) {
    try {
      if (this._fd) { fs.closeSync(this._fd); this._fd = null; }
      // prune old files
      const files = fs.readdirSync(this.logDir)
        .filter(f => f.startsWith('blackmirror-') && f.endsWith('.log'))
        .sort();
      while (files.length >= MAX_FILES) {
        fs.unlinkSync(path.join(this.logDir, files.shift()));
      }
      this._fd = fs.openSync(path.join(this.logDir, `blackmirror-${d}.log`), 'a');
      this._dateStamp = d;
    } catch (_) { /* ignore */ }
  }

  log(level, module, message, extra) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    let line = `${this._stamp()} [${level.toUpperCase()}] [${module}] ${message}`;
    if (extra !== undefined) {
      try {
        line += ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra));
      } catch (_) { /* ignore */ }
    }
    this._write(line);
  }

  debug(module, message, extra) { this.log('debug', module, message, extra); }
  info(module, message, extra) { this.log('info', module, message, extra); }
  warn(module, message, extra) { this.log('warn', module, message, extra); }
  error(module, message, extra) { this.log('error', module, message, extra); }

  recent(n = 200) {
    return this.ring.slice(-n);
  }

  close() {
    try { if (this._fd) { fs.closeSync(this._fd); this._fd = null; } } catch (_) { /* ignore */ }
  }
}

module.exports = { Logger, LEVELS };
