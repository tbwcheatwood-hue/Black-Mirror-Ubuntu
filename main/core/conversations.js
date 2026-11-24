'use strict';
/**
 * Conversation persistence: one JSON file per conversation under
 * <dataDir>/conversations/. Supports search, rename, deletion, message
 * editing (rewrites the file) and per-conversation model/system prompt.
 */
const fs = require('fs');
const path = require('path');
const { JsonStore } = require('../core/store');

const INDEX_DEFAULTS = { order: [], nextId: 1 };

class Conversations {
  constructor(dataDir, logger) {
    this.dir = path.join(dataDir, 'conversations');
    this.logger = logger;
    fs.mkdirSync(this.dir, { recursive: true });
    this.index = new JsonStore(path.join(this.dir, 'index.json'), INDEX_DEFAULTS);
    this.index.load();
  }

  _file(id) {
    // ids are numeric strings we generate — sanitize anyway
    const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.dir, `conv-${safe}.json`);
  }

  list() {
    const order = this.index.data.order || [];
    return order
      .map(id => this._load(id))
      .filter(Boolean)
      .map(c => ({
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        model: this._resolveModel(c),
        engineId: c.engineId || null,
        messageCount: (c.messages || []).length,
        lastMessage: c.messages && c.messages.length ? c.messages[c.messages.length - 1].content.slice(0, 120) : ''
      }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /**
   * Prefer conversation-level model; otherwise use the most recent message
   * that recorded one. Never invent identities when none were stored.
   */
  _resolveModel(c) {
    const clean = (v) => {
      if (v == null) return null;
      const s = String(v).trim();
      if (!s || s === 'undefined' || s === 'null') return null;
      return s;
    };
    const top = clean(c.model);
    if (top) return top;
    const msgs = c.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = clean(msgs[i] && msgs[i].model);
      if (m) return m;
    }
    return null;
  }

  _load(id) {
    try {
      return JSON.parse(fs.readFileSync(this._file(id), 'utf8'));
    } catch (_) {
      return null;
    }
  }

  get(id) { return this._load(id); }

  create({ title = 'New conversation', model = null, engineId = null, systemPrompt = '' } = {}) {
    const id = String(this.index.data.nextId++);
    const now = Date.now();
    const conv = {
      id, title, model, engineId, systemPrompt,
      createdAt: now, updatedAt: now,
      messages: [],
      stats: { promptTokens: 0, completionTokens: 0 }
    };
    this._save(conv);
    this.index.data.order = [id, ...(this.index.data.order || [])];
    this.index.save();
    return conv;
  }

  _save(conv) {
    conv.updatedAt = Date.now();
    const tmp = this._file(conv.id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(conv, null, 2));
    fs.renameSync(tmp, this._file(conv.id));
  }

  appendMessage(id, msg) {
    const conv = this._load(id);
    if (!conv) throw new Error(`Conversation ${id} not found`);
    const m = {
      id: 'msg-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
      role: msg.role,
      content: msg.content || '',
      reasoning: msg.reasoning || null,
      attachments: msg.attachments || null,
      model: msg.model || conv.model || null,
      engineId: msg.engineId || conv.engineId || null,
      usage: msg.usage || null,
      tps: msg.tps || null,
      stopped: !!msg.stopped,
      ts: Date.now()
    };
    conv.messages.push(m);
    // Backfill conversation model/engine from the first message that knows them.
    if (!this._resolveModel({ model: conv.model, messages: [] }) && m.model) {
      conv.model = m.model;
    }
    if (!conv.engineId && m.engineId) conv.engineId = m.engineId;
    if (msg.usage) {
      if (msg.usage.prompt_tokens != null) conv.stats.promptTokens += msg.usage.prompt_tokens || 0;
      if (msg.usage.completion_tokens != null) conv.stats.completionTokens += msg.usage.completion_tokens || 0;
    }
    // auto-title from first user message
    if (!conv.titleSet && m.role === 'user' && m.content) {
      conv.title = m.content.slice(0, 60).replace(/\s+/g, ' ').trim() || conv.title;
      conv.titleSet = true;
    }
    this._save(conv);
    return m;
  }

  /** Update a message's content (edit & resend rewrites history). */
  updateMessage(id, msgId, patch) {
    const conv = this._load(id);
    if (!conv) throw new Error(`Conversation ${id} not found`);
    const i = conv.messages.findIndex(m => m.id === msgId);
    if (i < 0) throw new Error(`Message ${msgId} not found`);
    Object.assign(conv.messages[i], patch);
    this._save(conv);
    return conv.messages[i];
  }

  /** Truncate history after (and including) a message — regenerate/edit. */
  truncateFrom(id, msgId, { inclusive = true } = {}) {
    const conv = this._load(id);
    if (!conv) throw new Error(`Conversation ${id} not found`);
    const i = conv.messages.findIndex(m => m.id === msgId);
    if (i < 0) throw new Error(`Message ${msgId} not found`);
    conv.messages = conv.messages.slice(0, inclusive ? i : i + 1);
    this._save(conv);
    return conv;
  }

  setMeta(id, patch) {
    const conv = this._load(id);
    if (!conv) throw new Error(`Conversation ${id} not found`);
    for (const k of ['title', 'model', 'engineId', 'systemPrompt']) {
      if (patch[k] !== undefined) conv[k] = patch[k];
      if (k === 'title') conv.titleSet = true;
    }
    this._save(conv);
    return conv;
  }

  remove(id) {
    const conv = this._load(id);
    if (!conv) return false;
    fs.rmSync(this._file(id), { force: true });
    this.index.data.order = this.index.data.order.filter(x => x !== id);
    this.index.save();
    return true;
  }

  /** Full-text search over titles + message content. */
  search(query) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return [];
    const hits = [];
    for (const item of this.list()) {
      const conv = this._load(item.id);
      if (!conv) continue;
      if (conv.title && conv.title.toLowerCase().includes(q)) {
        hits.push({ conversationId: conv.id, title: conv.title, messageId: null, excerpt: conv.title });
        continue;
      }
      for (const m of conv.messages || []) {
        if (m.content && m.content.toLowerCase().includes(q)) {
          const idx = m.content.toLowerCase().indexOf(q);
          const excerpt = m.content.slice(Math.max(0, idx - 60), idx + q.length + 60).replace(/\s+/g, ' ');
          hits.push({ conversationId: conv.id, title: conv.title, messageId: m.id, excerpt });
          if (hits.length > 50) return hits;
        }
      }
    }
    return hits;
  }

  totalMessages() {
    return this.list().reduce((a, c) => a + c.messageCount, 0);
  }
}

module.exports = { Conversations };
