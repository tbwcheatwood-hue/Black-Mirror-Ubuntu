'use strict';
/**
 * GGUF metadata parser.
 *
 * Reads only the header + key/value metadata of a .gguf file (never tensor
 * weights) so the model library can index thousands of files quickly without
 * copying or modifying anything.
 *
 * Supports GGUF versions 2 and 3 (identical layout since v2 uses 64-bit
 * counts already; v3 merely makes the float default explicit).
 *
 * Plain Node module — no Electron, no dependencies. Fully unit-testable.
 */
const fs = require('fs');

const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian

const T = {
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5,
  FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12
};

class GgufParseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GgufParseError';
    this.code = code || 'parse';
  }
}

// general.file_type enum → human label (llama.cpp gguf common enum values).
const FILE_TYPE_MAP = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1',
  10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M',
  16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS', 20: 'IQ2_XS', 21: 'Q2_K_S',
  22: 'IQ3_XS', 23: 'IQ3_XXS', 24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ3_M',
  28: 'IQ2_S', 29: 'IQ2_M', 30: 'IQ4_XS', 31: 'IQ1_M', 32: 'BF16',
  36: 'TQ1_0', 37: 'TQ2_0', 38: 'MXFP4'
};

const ARITY = { [T.UINT8]: 1, [T.INT8]: 1, [T.UINT16]: 2, [T.INT16]: 2, [T.UINT32]: 4, [T.INT32]: 4, [T.FLOAT32]: 4, [T.BOOL]: 1, [T.UINT64]: 8, [T.INT64]: 8, [T.FLOAT64]: 8 };

class GgufReader {
  constructor(buffer) {
    this.buf = buffer;
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.pos = 0;
    this.strings = 0; // safety counters against malformed files
    this.values = 0;
  }

  _need(n) {
    if (this.pos + n > this.buf.byteLength) {
      throw new GgufParseError(`unexpected end of file at byte ${this.pos} (needed ${n} more)`, 'truncated');
    }
  }

  u8() { this._need(1); return this.view.getUint8(this.pos++); }
  i8() { this._need(1); const v = this.view.getInt8(this.pos); this.pos += 1; return v; }
  u16() { this._need(2); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { this._need(2); const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { this._need(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  i32() { this._need(4); const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  f32() { this._need(4); const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
  f64() { this._need(8); const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }
  u64() { this._need(8); const v = this.view.getBigUint64(this.pos, true); this.pos += 8; return v; }
  i64() { this._need(8); const v = this.view.getBigInt64(this.pos, true); this.pos += 8; return v; }
  bool() { return this.u8() !== 0; }

  string() {
    const len = Number(this.u64());
    if (len > 16 * 1024 * 1024) throw new GgufParseError(`string too long (${len} bytes)`, 'malformed');
    this._need(len);
    const s = Buffer.from(this.buf.subarray(this.pos, this.pos + len)).toString('utf8');
    this.pos += len;
    this.strings++;
    return s;
  }

  value(type) {
    if (++this.values > 2_000_000) throw new GgufParseError('value count sanity limit exceeded', 'malformed');
    switch (type) {
      case T.UINT8: return this.u8();
      case T.INT8: return this.i8();
      case T.UINT16: return this.u16();
      case T.INT16: return this.i16();
      case T.UINT32: return this.u32();
      case T.INT32: return this.i32();
      case T.FLOAT32: return this.f32();
      case T.BOOL: return this.bool();
      case T.STRING: return this.string();
      case T.ARRAY: {
        const elemType = this.u32();
        const count = Number(this.u64());
        if (count > 10_000_000) throw new GgufParseError(`array too long (${count})`, 'malformed');
        const arr = new Array(Math.min(count, 64)); // materialize at most 64 entries
        const limit = Math.min(count, 64);
        // Still must walk past every element to keep offsets correct.
        for (let i = 0; i < count; i++) {
          const v = this.value(elemType);
          if (i < limit) arr[i] = v;
        }
        arr.__count = count;
        return arr;
      }
      case T.UINT64: return this.u64();
      case T.INT64: return this.i64();
      case T.FLOAT64: return this.f64();
      default:
        throw new GgufParseError(`unknown value type ${type}`, 'malformed');
    }
  }

  parse() {
    this._need(8);
    const magic = this.view.getUint32(this.pos, true); this.pos += 4;
    if (magic !== GGUF_MAGIC) throw new GgufParseError('not a GGUF file (bad magic)', 'bad-magic');
    const version = this.u32();
    if (version < 1 || version > 3) throw new GgufParseError(`unsupported GGUF version ${version}`, 'version');
    const tensorCount = Number(this.u64());
    const kvCount = Number(this.u64());
    if (kvCount > 100_000) throw new GgufParseError(`implausible kv count ${kvCount}`, 'malformed');

    const metadata = {};
    for (let i = 0; i < kvCount; i++) {
      const key = this.string();
      const type = this.u32();
      metadata[key] = this.value(type);
    }
    // We intentionally do NOT walk the tensor section: metadata was the goal.
    return { version, tensorCount, kvCount, metadata, headerBytes: this.pos };
  }
}

/** Parse a GGUF file from disk (reads header bytes only, in chunks). */
function parseGguf(filePath, opts = {}) {
  const fd = fs.openSync(filePath, 'r');
  try {
    // Header is 24 bytes; metadata can be large (vocab!). Read generously.
    const initial = 24;
    const buf = Buffer.allocUnsafe(initial);
    const got = fs.readSync(fd, buf, 0, initial, 0);
    if (got < 8) throw new GgufParseError('file too small to be GGUF', 'truncated');
    let reader = new GgufReader(buf.subarray(0, got));
    let magic = reader.view.getUint32(0, true);
    if (magic !== GGUF_MAGIC) throw new GgufParseError('not a GGUF file (bad magic)', 'bad-magic');
    // Read the full header region: version+counts then KV stream. Grow as needed.
    const fsize = fs.fstatSync(fd).size;
    let size = Math.min(Math.max(fsize, initial), opts.maxBytes || 96 * 1024 * 1024);
    let full = Buffer.allocUnsafe(size);
    let have = fs.readSync(fd, full, 0, size, 0);
    let result;
    for (;;) {
      const r = new GgufReader(full.subarray(0, have));
      try {
        result = r.parse();
        break;
      } catch (e) {
        if (e.code === 'truncated' && have < fsize && have < (opts.maxBytes || 96 * 1024 * 1024)) {
          size = Math.min(have * 2, fsize, opts.maxBytes || 96 * 1024 * 1024);
          full = Buffer.allocUnsafe(size);
          have = fs.readSync(fd, full, 0, size, 0);
          continue;
        }
        throw e;
      }
    }
    return result;
  } finally {
    fs.closeSync(fd);
  }
}

/** Build a friendly, UI-ready summary from raw GGUF metadata. */
function summarize(filePath, stat) {
  const { version, metadata: md } = parseGguf(filePath);
  const arch = md['general.architecture'] || 'unknown';
  const A = k => md[`${arch}.${k}`];
  const fileType = md['general.file_type'];
  const quant = typeof fileType === 'number'
    ? (FILE_TYPE_MAP[fileType] || `type_${fileType}`)
    : (typeof fileType === 'string' ? fileType.replace(/^MOSTLY_/, '').toUpperCase() : null);

  const nLayers = A('block_count');
  const nEmbd = A('embedding_length');
  const nHead = A('attention.head_count');
  const nHeadKv = A('attention.head_count_kv') ?? nHead;
  const ctxTrain = A('context_length');
  const nFf = A('feed_forward_length');
  const expertCount = A('expert_count') ?? 0;
  const expertUsed = A('expert_used_count') ?? 0;
  const keyLength = A('attention.key_length');
  const valueLength = A('attention.value_length');

  const name = md['general.name'] || require('path').basename(filePath, '.gguf');
  const sizeBytes = stat ? stat.size : require('fs').statSync(filePath).size;

  return {
    path: filePath,
    fileName: require('path').basename(filePath),
    ggufVersion: version,
    architecture: arch,
    name,
    quant,
    fileType,
    isMoE: expertCount > 0,
    expertCount,
    expertUsed,
    nLayers,
    nEmbd,
    nHead,
    nHeadKv,
    keyLength,
    valueLength,
    ctxTrain,
    nFf,
    sizeBytes,
    sizeMB: Math.round(sizeBytes / (1024 * 1024)),
    hasTokenizer: !!(md['tokenizer.ggml.model'] || md['tokenizer.ggml.tokens']),
    tokenizerModel: md['tokenizer.ggml.model'] || null,
    license: md['general.license'] || null,
    fineTune: md['general.fine_tune'] || null,
    parameters: md['general.size_label'] || null
  };
}

/**
 * Detect split GGUF shards: `model-00001-of-00003.gguf` → base, index, total.
 * Returns null for non-split files. llama.cpp reads sibling shards
 * automatically when given the first shard, so the library only needs the
 * group facts (all shards share metadata; the first shard is the entry).
 */
function detectSplit(fileName) {
  const m = String(fileName).match(/^(.*?)-(\d{5})-of-(\d{5})\.gguf$/i);
  if (!m) return null;
  const index = parseInt(m[2], 10);
  const total = parseInt(m[3], 10);
  if (!(index >= 1 && total >= 1 && index <= total)) return null;
  return { base: m[1], index, total };
}

/** Is this file a multimodal projector (mmproj) rather than a loadable model? */
function isMmprojFile(fileName) {
  return /mmproj/i.test(String(fileName));
}

module.exports = { GgufParseError, GgufReader, parseGguf, summarize, FILE_TYPE_MAP, T, detectSplit, isMmprojFile };
