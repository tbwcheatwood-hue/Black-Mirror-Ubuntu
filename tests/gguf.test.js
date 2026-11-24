'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildGguf } = require('./helpers/ggufbuilder');
const { parseGguf, summarize, GgufParseError } = require('../main/models/gguf');
const { estimateMemory, assess, bitsPerWeight } = require('../main/models/estimate');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bm-gguf-'));
}

describe('GGUF parser', () => {
  test('parses valid v3 file with all KV types', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'model.gguf');
    fs.writeFileSync(file, buildGguf({
      kv: {
        'general.custom_string': ['string', 'hello'],
        'general.array_test': ['array_str', ['a', 'b', 'c']],
        'general.array_f32_test': ['array_f32', [1.5, 2.5]],
        'general.b_test': ['bool', true],
        'general.u64_test': ['u64', '17179869184']
      }
    }));
    const r = parseGguf(file);
    assert.equal(r.version, 3);
    assert.equal(r.kvCount, Object.keys(r.metadata).length);
    assert.equal(r.metadata['general.architecture'], 'llama');
    assert.equal(r.metadata['general.custom_string'], 'hello');
    assert.deepEqual([...r.metadata['general.array_test']], ['a', 'b', 'c']);
    assert.equal(r.metadata['general.array_test'].__count, 3);
    assert.deepEqual([...r.metadata['general.array_f32_test']], [1.5, 2.5]);
    assert.equal(r.metadata['general.b_test'], true);
    assert.equal(String(r.metadata['general.u64_test']), '17179869184');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('rejects non-GGUF file (bad magic)', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'not-gguf.gguf');
    fs.writeFileSync(file, Buffer.from('This is definitely not a GGUF file. '.repeat(20)));
    assert.throws(() => parseGguf(file), e => e instanceof GgufParseError && e.code === 'bad-magic');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('rejects truncated file with clear error', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'trunc.gguf');
    const full = buildGguf();
    fs.writeFileSync(file, full.subarray(0, 40)); // header + half of first KV
    assert.throws(() => parseGguf(file), e => e instanceof GgufParseError && e.code === 'truncated');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('rejects unsupported GGUF version', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'v9.gguf');
    fs.writeFileSync(file, buildGguf({ version: 9 }));
    assert.throws(() => parseGguf(file), e => e.code === 'version');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('still parses GGUF v2', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'v2.gguf');
    fs.writeFileSync(file, buildGguf({ version: 2 }));
    const r = parseGguf(file);
    assert.equal(r.version, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('GGUF summarize', () => {
  test('extracts architecture, quant, MoE and context for llama arch', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'model.gguf');
    fs.writeFileSync(file, buildGguf({
      kv: {
        'general.name': ['string', 'Mistral Small'],
        'llama.expert_count': ['u32', 8],
        'llama.expert_used_count': ['u32', 2]
      }
    }));
    const stat = fs.statSync(file);
    const s = summarize(file, stat);
    assert.equal(s.architecture, 'llama');
    assert.equal(s.name, 'Mistral Small');
    assert.equal(s.quant, 'Q4_K_M');
    assert.equal(s.nLayers, 32);
    assert.equal(s.ctxTrain, 131072);
    assert.equal(s.nHeadKv, 8);
    assert.equal(s.isMoE, true);
    assert.equal(s.expertCount, 8);
    assert.equal(s.expertUsed, 2);
    assert.equal(s.hasTokenizer, true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('non-MoE model and fallback name/quant', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'fallback-model.gguf');
    fs.writeFileSync(file, buildGguf({ kv: { 'general.file_type': ['u32', 7], 'general.name': null } }));
    const s = summarize(file, fs.statSync(file));
    assert.equal(s.isMoE, false);
    assert.equal(s.quant, 'Q8_0');
    assert.equal(s.name, 'fallback-model'); // from filename
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('unknown file_type falls back to type_N label', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'x.gguf');
    fs.writeFileSync(file, buildGguf({ kv: { 'general.file_type': ['u32', 123] } }));
    assert.equal(summarize(file, fs.statSync(file)).quant, 'type_123');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Memory estimation', () => {
  const model = {
    sizeBytes: 8 * 1024 ** 3, // 8 GB file
    quant: 'Q4_K_M',
    nLayers: 32,
    nEmbd: 4096,
    nHead: 32,
    nHeadKv: 8,
    keyLength: 128,
    valueLength: 128,
    ctxTrain: 131072,
    isMoE: false,
    expertCount: 0
  };

  test('bitsPerWeight lookup', () => {
    assert.equal(bitsPerWeight('Q4_K_M'), 4.85);
    assert.equal(bitsPerWeight('mostly q4_K_M'), 4.85);
    assert.equal(bitsPerWeight('Q8_0'), 8.5);
    assert.equal(bitsPerWeight('xyz'), null);
  });

  test('KV cache math is exact', () => {
    const est = estimateMemory(model, { contextLength: 4096, kvCacheType: 'f16' });
    // (128+128)*2 = 512 B/token/layer; 32 layers * 4096 tokens = 67.1 MB
    assert.equal(est.kvPerTokenBytes, 512);
    assert.equal(est.kvBytes, 32 * 4096 * 512);
    assert.equal(est.weightsBytes, 8 * 1024 ** 3);
    assert.equal(est.totalBytes, 8 * 1024 ** 3 + 32 * 4096 * 512 + est.overheadBytes);
  });

  test('q8_0 cache halves to one byte per element', () => {
    const est = estimateMemory(model, { contextLength: 4096, kvCacheType: 'q8_0' });
    assert.equal(est.kvPerTokenBytes, 256);
  });

  test('param count estimate from bpw', () => {
    const est = estimateMemory(model, {});
    assert.equal(est.paramCountEstimate, Math.round((8 * 1024 ** 3) / (4.85 / 8)));
  });

  test('assess: small model on big RAM is ok', () => {
    const est = estimateMemory({ ...model, sizeBytes: 2 * 1024 ** 3 }, { contextLength: 4096 });
    const a = assess(model, est, { freeBytes: 24 * 1024 ** 3, totalBytes: 44 * 1024 ** 3 }, 4096);
    assert.equal(a.level, 'ok');
    assert.equal(a.fitsProbably, true);
  });

  test('assess: model bigger than free RAM is danger, not a block', () => {
    const est = estimateMemory({ ...model, sizeBytes: 40 * 1024 ** 3 }, { contextLength: 8192 });
    const a = assess(model, est, { freeBytes: 4 * 1024 ** 3, totalBytes: 44 * 1024 ** 3 }, 8192);
    assert.equal(a.level, 'danger');
    assert.ok(a.notes.some(n => n.includes('fail or push')));
    // informs rather than restricts:
    assert.equal(typeof a.fitsProbably, 'boolean');
  });

  test('assess: >85% of total RAM warns', () => {
    const est = estimateMemory({ ...model, sizeBytes: 39 * 1024 ** 3 }, { contextLength: 8192 });
    const a = assess(model, est, { freeBytes: 2 * 1024 ** 3, totalBytes: 44 * 1024 ** 3 }, 8192);
    assert.ok(['warning', 'danger'].includes(a.level));
  });

  test('assess: MoE note and big-context note appear', () => {
    const moe = { ...model, isMoE: true, expertCount: 16, expertUsed: 4 };
    const est = estimateMemory(moe, { contextLength: 131072 });
    const a = assess(moe, est, { freeBytes: 44 * 1024 ** 3, totalBytes: 44 * 1024 ** 3 }, 131072);
    assert.ok(a.notes.some(n => n.includes('MoE')));
    assert.ok(a.notes.some(n => n.includes('131,072')));
  });
});
