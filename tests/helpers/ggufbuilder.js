'use strict';
/**
 * Builds synthetic GGUF files for tests — a minimal writer of the GGUF v3
 * binary format (header + KV metadata only; no tensor section needed since
 * Black Mirror only parses metadata).
 */
class Buf {
  constructor() { this.chunks = []; this.len = 0; }

  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); this._push(b); return this; }
  u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v), 0); this._push(b); return this; }
  str(s) { const raw = Buffer.from(s, 'utf8'); this.u64(raw.length); this._push(raw); return this; }
  f32(v) { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); this._push(b); return this; }
  u8(v) { this._push(Buffer.from([v])); return this; }

  _push(b) { this.chunks.push(b); this.len += b.length; return this; }
  buffer() { return Buffer.concat(this.chunks); }
}

const T = { UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5, FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12 };

function kvString(b, key, value) { b.str(key); b.u32(T.STRING); b.str(value); }
function kvU32(b, key, value) { b.str(key); b.u32(T.UINT32); b.u32(value); }
function kvF32(b, key, value) { b.str(key); b.u32(T.FLOAT32); b.f32(value); }
function kvBool(b, key, value) { b.str(key); b.u32(T.BOOL); b.u8(value ? 1 : 0); }
function kvU64(b, key, value) { b.str(key); b.u32(T.UINT64); b.u64(value); }
function kvArrayStr(b, key, values) {
  b.str(key); b.u32(T.ARRAY); b.u32(T.STRING); b.u64(values.length);
  for (const v of values) b.str(v);
}
function kvArrayF32(b, key, values) {
  b.str(key); b.u32(T.ARRAY); b.u32(T.FLOAT32); b.u64(values.length);
  for (const v of values) b.f32(v);
}

/**
 * @param {object} opts { version=3, kv={}, arch='llama', padBytes=0, kvCountOverride }
 */
function buildGguf(opts = {}) {
  const version = opts.version ?? 3;
  const arch = opts.arch || 'llama';
  const kvs = { ...defaultKv(arch), ...(opts.kv || {}) };
  // Encode KV section first so we know the count.
  const b = new Buf();
  let count = 0;
  const NUM_TO_NAME = { 0: 'u8', 1: 'i8', 2: 'u16', 3: 'i16', 4: 'u32', 5: 'i32', 6: 'f32', 7: 'bool', 8: 'string', 10: 'u64', 11: 'i64', 12: 'f64' };
  for (const [key, def] of Object.entries(kvs)) {
    if (!def) continue; // null drops a default entry
    const [type, val] = def;
    if (val === null || val === undefined) continue;
    const tname = typeof type === 'number' ? (NUM_TO_NAME[type] || 'u32') : type;
    if (tname === 'string') { kvString(b, key, val); count++; }
    else if (tname === 'u32') { kvU32(b, key, val); count++; }
    else if (tname === 'f32') { kvF32(b, key, val); count++; }
    else if (tname === 'bool') { kvBool(b, key, val); count++; }
    else if (tname === 'u64') { kvU64(b, key, val); count++; }
    else if (tname === 'array_str') { kvArrayStr(b, key, val); count++; }
    else if (tname === 'array_f32') { kvArrayF32(b, key, val); count++; }
  }
  const header = new Buf();
  header._push(Buffer.from('GGUF', 'ascii')); // raw 4-byte magic, not a string
  header.u32(version);
  header.u64(opts.tensorCount ?? 405);   // fake plausible tensor count
  header.u64(count);
  const out = Buffer.concat([header.buffer(), b.buffer()]);
  const pad = opts.padBytes ? Buffer.alloc(opts.padBytes, 0) : Buffer.alloc(0);
  return Buffer.concat([out, pad]);
}

function defaultKv(arch) {
  const k = `${arch}.`;
  const kv = {
    'general.architecture': [T.STRING, arch],
    'general.name': [T.STRING, 'TestModel'],
    'general.file_type': [T.UINT32, 15], // Q4_K_M
    [`${k}block_count`]: [T.UINT32, 32],
    [`${k}embedding_length`]: [T.UINT32, 4096],
    [`${k}attention.head_count`]: [T.UINT32, 32],
    [`${k}attention.head_count_kv`]: [T.UINT32, 8],
    [`${k}attention.key_length`]: [T.UINT32, 128],
    [`${k}attention.value_length`]: [T.UINT32, 128],
    [`${k}feed_forward_length`]: [T.UINT32, 11008],
    [`${k}context_length`]: [T.UINT32, 131072],
    'tokenizer.ggml.model': [T.STRING, 'gpt2']
  };
  return kv;
}

/** Standard "7B-ish" test model metadata for estimator tests. */
function llamaTestKv() {
  return defaultKv('llama');
}

module.exports = { Buf, T, buildGguf, defaultKv, llamaTestKv };
