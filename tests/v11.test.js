'use strict';
/**
 * v1.1.0 regression tests: capability discovery, help-gated flags,
 * split GGUF groups, mmproj, release-asset fallback, remote endpoints,
 * benchmark TTFT, commit-charge assessment.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { buildGguf } = require('./helpers/ggufbuilder');
const capabilities = require('../main/engines/capabilities');
const { LlamaCppAdapter } = require('../main/engines/adapters');
const { EngineInstaller } = require('../main/engines/installer');
const { EngineRegistry } = require('../main/engines/registry');
const { ServerController, DuplicateProcessError } = require('../main/server/controller');
const { Logger } = require('../main/core/log');
const { parseDevices } = capabilities;
const { detectSplit, isMmprojFile } = require('../main/models/gguf');
const { ModelLibrary } = require('../main/models/library');
const { estimateMemory, assess } = require('../main/models/estimate');

describe('Capability discovery', () => {
  test('parseDevices reads --list-devices style output and ignores "(none)"', () => {
    const out = 'Available devices:\n  (none)\n';
    assert.deepEqual(parseDevices(out), []);
    const out2 = 'Available devices:\n  ggml_vulkan: Device 0: Intel(R) UHD Graphics 770\n';
    const d = parseDevices(out2);
    assert.equal(d.length, 1);
    assert.equal(d[0].backend, 'ggml_vulkan');
    assert.match(d[0].description, /UHD/);
  });

  test('supportedServerFlags maps probed help to a flag set', () => {
    const caps = { probed: true, helpFlags: { thinking: true, jinja: true, kvCacheK: true, flashAttention: false, cpuMoeLayers: false } };
    const set = capabilities.supportedServerFlags(caps);
    assert.equal(set.has('thinking'), true);
    assert.equal(set.has('flashAttention'), false);
    assert.equal(set.has('parallelSlots'), false); // not probed → absent
  });

  test('help-gated adapter OMITS flags the binary does not support', () => {
    const d = { id: 'x', family: 'llama.cpp', serverBinary: 'llama-server' };
    const caps = { probed: true, helpFlags: { thinking: false, jinja: true, kvCacheK: true, kvCacheV: false, flashAttention: false, cpuMoeLayers: false, parallelSlots: true, mmproj: false } };
    const a = new LlamaCppAdapter(d, {}, caps);
    const args = a.buildServerArgs('/m/x.gguf', {
      contextLength: 4096, kvCacheType: 'q8_0', flashAttention: true,
      thinkingMode: 'on', cpuMoeLayers: 4, parallelSlots: 2
    }, { port: 1, bind: '127.0.0.1' });
    assert.ok(!args.includes('--reasoning-format'), 'unsupported thinking flag omitted');
    assert.ok(!args.includes('--cache-type-v'), 'unsupported cache-v omitted');
    assert.ok(!args.includes('--flash-attn'), 'unsupported flash-attn omitted');
    assert.ok(!args.includes('--n-cpu-moe'), 'unsupported cpu-moe omitted');
    assert.ok(args.includes('--cache-type-k'), 'supported cache-k still emitted');
    assert.ok(args.includes('--parallel'), 'supported parallel emitted');
    // request-level explicit disable still applies (harness-independent)
    const ov = a.buildRequestOverrides({ thinkingMode: 'off' });
    assert.deepEqual(ov.chat_template_kwargs, { enable_thinking: false });
  });

  test('no capabilities → legacy full emission (unknown binary)', () => {
    const d = { id: 'x', family: 'llama.cpp', serverBinary: 'llama-server' };
    const a = new LlamaCppAdapter(d, {}, null);
    const args = a.buildServerArgs('/m/x.gguf', { contextLength: 4096, flashAttention: true, thinkingMode: 'on', kvCacheType: 'q8_0' }, { port: 1, bind: '127.0.0.1' });
    assert.ok(args.includes('--flash-attn'));
    assert.ok(args.includes('--reasoning-format'));
  });

  test('capabilities.summarize maps probes to UI capability report', () => {
    const caps = { probed: true, helpFlags: { thinking: true, jinja: true, kvCacheK: true, kvCacheV: true, mmproj: true }, devices: [{ backend: 'ggml_vulkan', description: 'Intel(R) UHD 770' }] };
    const s = capabilities.summarize({ family: 'llama.cpp' }, caps);
    assert.equal(s.thinking, 'reasoning-format');
    assert.equal(s.images, 'mmproj-supported');
    assert.equal(s.flashAttention, false);
    assert.match(s.note, /UHD 770/);
    assert.equal(capabilities.summarize({ family: 'ollama' }, null).thinking, 'request-flag');
    assert.equal(capabilities.summarize({ family: 'llama.cpp' }, { probed: false }).probed, false);
  });
});

describe('Split GGUF + mmproj', () => {
  test('detectSplit parses shard naming and rejects non-splits', () => {
    assert.deepEqual(detectSplit('model-00001-of-00003.gguf'), { base: 'model', index: 1, total: 3 });
    assert.equal(detectSplit('model.gguf'), null);
    assert.equal(detectSplit('model-9-of-3.gguf'), null);
    assert.equal(isMmprojFile('mmproj-model-f16.gguf'), true);
    assert.equal(isMmprojFile('qwen3-8b.gguf'), false);
  });

  test('library groups shard sizes and marks incomplete splits', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-split-'));
    const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-spldir-'));
    const mk = (name, padBytes) => fs.writeFileSync(path.join(modelsDir, name), Buffer.concat([buildGguf(), Buffer.alloc(padBytes || 0)]));
    mk('bigmodel-00001-of-00003.gguf', 1000);
    mk('bigmodel-00002-of-00003.gguf', 2000);
    mk('other-mmproj-model-f16.gguf', 100); // projector file
    const lib = new ModelLibrary(dataDir, console);
    lib.addScanDir(modelsDir);
    await lib.refresh();
    const first = lib.get(path.join(modelsDir, 'bigmodel-00001-of-00003.gguf'));
    const second = lib.get(path.join(modelsDir, 'bigmodel-00002-of-00003.gguf'));
    assert.equal(first.split.total, 3);
    assert.equal(first.splitTotalBytes, first.sizeBytes + second.sizeBytes, 'group size = sum of present shards');
    assert.equal(first.splitComplete, false);
    assert.deepEqual(first.splitMissingShards, [3]);
    // estimate uses the WHOLE group as weights
    const est = lib.estimate(first.path, { contextLength: 4096 });
    assert.equal(est.weightsBytes, first.sizeBytes + second.sizeBytes);
    const mm = lib.listMmproj();
    assert.equal(mm.length, 1);
    assert.equal(mm[0].kind, 'mmproj');
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(modelsDir, { recursive: true, force: true });
  });
});

describe('Release asset resolution fallback', () => {
  function makeRegistry(dir) {
    return new EngineRegistry(dir, console, { osFilter: false });
  }

  test('resolveAsset walks recent tags when the primary asset 404s', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-asset-'));
    const reg = makeRegistry(dir);
    const descriptor = {
      id: 'llamacpp-cpu', family: 'llama.cpp', os: [process.platform], install: {
        type: 'github-release-zip', repo: 'ggml-org/llama.cpp',
        assetTemplate: 'llama-{tag}-bin-win-cpu-x64.zip'
      }
    };
    let heads = 0;
    const fetchImpl = async (url) => {
      if (url.includes('b99999')) { heads++; return { ok: false, status: 404 }; }
      heads++;
      return { ok: true, status: 200 };
    };
    const installer = new EngineInstaller(reg, console, { fetchImpl });
    const res = await installer.resolveAsset(descriptor, 'b99999', ['b99998', 'b12359']);
    assert.equal(res.tag, 'b99998', 'falls back to the next recent tag');
    assert.match(res.via, /asset-verify/);
    assert.ok(heads >= 2, 'HEAD requests performed');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('resolveTag releases-page fallback finds highest b-tag', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-tagfb-'));
    const reg = makeRegistry(dir);
    const descriptor = { id: 'llamacpp-cpu', family: 'llama.cpp', os: [process.platform], install: { type: 'github-release-zip', repo: 'ggml-org/llama.cpp', assetTemplate: 'llama-{tag}-bin-win-cpu-x64.zip' } };
    const fetchImpl = async () => ({
      ok: true, text: async () => '<a href="/ggml-org/llama.cpp/releases/tag/b12670">..</a><a href="/ggml-org/llama.cpp/releases/tag/b12651">..</a>'
    });
    const installer = new EngineInstaller(reg, console, { fetchImpl });
    const res = await installer.resolveTag(descriptor, null);
    assert.equal(res.tag, 'b12670');
    assert.deepEqual(res.recentTags.slice(0, 2), ['b12670', 'b12651']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Remote endpoints (connect-only, never owned)', () => {
  function makeCtl(dir, handler) {
    const logger = new Logger(path.join(dir, 'logs'));
    return new ServerController({ descriptor: () => { throw new Error('unused'); } }, logger, { dataDir: dir, fetchImpl: handler ? handler : undefined });
  }

  test('add, test, list, forget; remotes render as mode remote', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-remote-'));
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'llama3.2:1b' }, { id: 'qwen3:8b' }] }));
    });
    await new Promise(r => srv.listen(19880, '127.0.0.1', r));
    try {
      const ctl = makeCtl(dir, (...a) => fetch(...a));
      const rec = ctl.addRemote({ label: 'Basement box', baseUrl: 'http://127.0.0.1:19880' });
      const test = await ctl.testRemote(rec.id);
      assert.equal(test.ok, true);
      assert.deepEqual(test.models, ['llama3.2:1b', 'qwen3:8b']);
      const listed = ctl.list().filter(x => x.mode === 'remote');
      assert.equal(listed.length, 1);
      assert.equal(listed[0].status, 'running');
      // stop must NEVER touch a remote — refuse before the managed-process lookup
      await assert.rejects(() => ctl.stop(rec.id), /never stopped|not-owned|Remote/);
      // persistence across controller instances
      const ctl2 = makeCtl(dir, (...a) => fetch(...a));
      assert.equal(ctl2.listRemotes().length, 1, 'remote registry persisted');
      assert.equal(ctl2.removeRemote(rec.id), true);
      assert.equal(ctl2.listRemotes().length, 0);
    } finally {
      await new Promise(r => {
        srv.close(() => r());
        if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
      });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('unreachable endpoint reports an honest error state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-remote2-'));
    const ctl = makeCtl(dir, (...a) => fetch(...a));
    const rec = ctl.addRemote({ baseUrl: 'http://127.0.0.1:1' }); // closed port
    const test = await ctl.testRemote(rec.id);
    assert.equal(test.ok, false);
    assert.ok(test.error);
    assert.equal(ctl.list().find(x => x.id === rec.id).status, 'crashed');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('bad URL is rejected up front', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-remote3-'));
    const ctl = makeCtl(dir);
    assert.throws(() => ctl.addRemote({ baseUrl: 'ftp://nope' }), /http/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Benchmark TTFT + total response', () => {
  test('measurements include ttftMs and totalMs (mock engine, pipeline check)', async () => {
    const { BenchRunner } = require('../main/benchmark/bench');
    const { JsonStore } = require('../main/core/store');
    const { findFreePort } = require('../main/server/ports');
    const MOCK_ENGINE = path.join(__dirname, 'helpers', 'mockengine.js');
    const stubRegistry = () => ({
      descriptor: () => ({ id: 'x', family: 'llama.cpp', api: 'openai', readyProbe: { type: 'http', path: '/health' } }),
      adapter: () => ({
        executablePath: () => process.execPath,
        buildServerArgs: (m, p, netw) => [MOCK_ENGINE, '--port', String(netw.port), '--speed', '80']
      })
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-ttft-'));
    const logger = new Logger(path.join(dir, 'logs'));
    const ctl = new ServerController(stubRegistry(), logger, { dataDir: dir, readyTimeoutMs: 20000 });
    const store = new JsonStore(path.join(dir, 'benchmarks.json'), { results: [] });
    store.load();
    const runner = new BenchRunner(ctl, stubRegistry(), logger, {
      store,
      memorySampler: async () => ({ memoryBytes: 1e9 })
    });
    const port = await findFreePort(19300, '127.0.0.1');
    const run = await runner.run({
      engineId: 'x', modelPath: '/m/t.gguf', port, params: { contextLength: 4096 },
      promptTokens: 32, genTokens: 24, reps: 1, label: 'ttft regression'
    }, n => 'lorem ipsum dolor sit amet '.repeat(4));
    const m = run.measurements[0];
    assert.ok(m.ttftMs > 0, 'TTFT captured');
    assert.ok(m.totalMs >= m.genWallMs, 'total response time includes generation');
    assert.ok(run.summary.ttftMs > 0);
    assert.ok(run.summary.totalMs > 0);
    await ctl.stopAll('test');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Commit-charge assessment', () => {
  test('needs beyond commit headroom warn even when physical RAM looks fine', () => {
    const model = { sizeBytes: 20e9, quant: 'Q4_K_M', nLayers: 32, nEmbd: 4096, nHead: 32, nHeadKv: 8, keyLength: 128, valueLength: 128, ctxTrain: 131072, isMoE: false, expertCount: 0 };
    const est = estimateMemory(model, { contextLength: 8192 });
    // plenty of physical RAM free, tiny commit headroom (edge case: pagefile nearly full)
    const a = assess(model, est, { freeBytes: 24e9, totalBytes: 44e9, commitFreeBytes: 1e9 }, 8192);
    assert.notEqual(a.level, 'ok');
    assert.ok(a.notes.some(n => /commit charge/i.test(n)));
    assert.equal(typeof a.estimateBasis, 'string');
  });

  test('comfortable commit headroom keeps ok', () => {
    const model = { sizeBytes: 2e9, quant: 'Q8_0', nLayers: 22, nEmbd: 2048, nHead: 16, nHeadKv: 16, keyLength: 128, valueLength: 128, ctxTrain: 8192, isMoE: false, expertCount: 0 };
    const est = estimateMemory(model, { contextLength: 4096 });
    const a = assess(model, est, { freeBytes: 20e9, totalBytes: 44e9, commitFreeBytes: 30e9 }, 4096);
    assert.equal(a.level, 'ok');
  });
});
