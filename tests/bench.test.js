'use strict';
/**
 * Benchmark runner tests — run against the mock engine, so the numbers are
 * explicitly NOT real-inference numbers. They verify the measurement
 * pipeline: load timing, prompt/generation speed capture, memory sampling,
 * result persistence and aggregation.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ServerController } = require('../main/server/controller');
const { Logger } = require('../main/core/log');
const { JsonStore } = require('../main/core/store');
const { BenchRunner } = require('../main/benchmark/bench');
const { findFreePort } = require('../main/server/ports');

const MOCK_ENGINE = path.join(__dirname, 'helpers', 'mockengine.js');

function stubRegistry() {
  return {
    descriptor: () => ({ id: 'llamacpp-cpu', family: 'llama.cpp', api: 'openai', readyProbe: { type: 'http', path: '/health' } }),
    adapter: () => ({
      executablePath: () => process.execPath,
      buildServerArgs: (model, params, netw) => [MOCK_ENGINE, '--port', String(netw.port), '--speed', '60']
    })
  };
}

describe('Benchmark runner (mock engine — pipeline verification)', () => {
  test('full benchmark run: load, prompt, generation, memory, persistence', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-bench-'));
    const logger = new Logger(path.join(dir, 'logs'));
    const ctl = new ServerController(stubRegistry(), logger, { dataDir: dir, readyTimeoutMs: 20000 });
    const store = new JsonStore(path.join(dir, 'benchmarks.json'), { results: [] });
    store.load();
    const memSamples = [];
    const runner = new BenchRunner(ctl, stubRegistry(), logger, {
      store,
      memorySampler: async () => { memSamples.push(1); return { memoryBytes: 512 * 1024 * 1024 }; }
    });
    const port = await findFreePort(19150, '127.0.0.1'); // suite-disjoint range
    const progress = [];
    const run = await runner.run({
      engineId: 'llamacpp-cpu',
      modelPath: '/models/bench.gguf',
      port,
      params: { contextLength: 4096 },
      promptTokens: 64,
      genTokens: 48,
      reps: 2,
      label: 'mock pipeline test'
    }, (n) => `word${Math.floor(Math.random() * 1000)} `.repeat(Math.ceil(n / 2)));

    assert.equal(run.measurements.length, 2);
    assert.ok(run.measurements[0].loadMs > 0, 'load time measured (spawn→ready)');
    assert.ok(run.measurements[0].promptTps > 0, 'prompt speed captured from server timings');
    assert.ok((run.measurements[0].genTps > 0) || (run.measurements[0].genServerTps > 0), 'generation speed captured');
    assert.ok(run.measurements[0].peakRss > 0, 'memory sampled during generation');
    assert.equal(run.summary.okReps, 2);
    assert.ok(run.summary.genTps > 0);
    assert.equal(run.environment.platform, process.platform);
    // persisted
    assert.equal(runner.results().length, 1);
    assert.equal(runner.results()[0].id, run.id);
    // remove
    runner.remove(run.id);
    assert.equal(runner.results().length, 0);
    await ctl.stopAll('test');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
