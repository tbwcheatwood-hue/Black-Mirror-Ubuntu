'use strict';
/** Minimal synchronous event bus for cross-module notifications (main process). */
class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  on(event, handler) {
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event).push(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const list = this._handlers.get(event);
    if (!list) return;
    const i = list.indexOf(handler);
    if (i >= 0) list.splice(i, 1);
  }

  emit(event, payload) {
    const list = this._handlers.get(event) || [];
    for (const h of [...list]) {
      try {
        h(payload);
      } catch (e) {
        // A broken listener must not break the emitter.
        try { console.error(`[events] handler error for "${event}":`, e.message); } catch (_) { /* ignore */ }
      }
    }
  }
}

module.exports = { Emitter };
