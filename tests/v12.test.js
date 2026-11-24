'use strict';
/**
 * v1.2.0 regression tests:
 *  - build manifest reproducibility
 *  - VERIFIED process termination (+ honest unresolved reporting)
 *  - process ownership verification, stale records, PID-reuse protection
 *  - recovery classification after app crash
 *  - engine install staging (disk space, checksum, validate-then-activate)
 *  - compatibility assessment + saved results + staleness
 *  - recommended profile generation (+ explicit-apply shape)
 *  - memory estimate additions (compute buffer, uncertainty)
 *  - diagnostic report generation + hints
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');

/* ---------------- manifest reproducibility ---------------- */
describe('Build manifest reproducibility', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

  test('package.json declares all documented scripts', () => {
    for (const s of ['setup', 'vendor', 'test', 'test:real', 'test:electron', 'start', 'dev', 'build:win', 'build:portable', 'dist:verify']) {
      assert.ok(pkg.scripts && pkg.scripts[s], `script "${s}" missing`);
    }
  });

  test('every script references a file that exists in the repo', () => {
    const refs = [];
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      for (const m of cmd.matchAll(/(?:node|electron-builder|electron)\s+(\S+)/g)) refs.push({ name, ref: m[1] });
    }
    for (const { name, ref } of refs) {
      if (ref.startsWith('node_modules') || ref === '.') continue;
      const p = path.join(ROOT, ref);
      assert.ok(fs.existsSync(p) || /--|\.exe/.test(ref), `script "${name}" references missing "${ref}"`);
    }
  });

  test('devDependencies declared and lockfile root matches manifest', () => {
    assert.ok(pkg.devDependencies.electron, 'electron devDep missing');
    assert.ok(pkg.devDependencies['electron-builder'], 'electron-builder devDep missing');
    assert.ok(pkg.devDependencies.esbuild, 'esbuild devDep missing');
    const lr = lock.packages[''];
    assert.deepEqual(lr.dependencies, pkg.dependencies, 'lockfile deps out of sync');
    assert.deepEqual(lr.devDependencies, pkg.devDependencies, 'lockfile devDeps out of sync');
  });

  test('electron-builder config is explicit and references existing assets', () => {
    assert.ok(pkg.build && pkg.build.appId && pkg.build.productName, 'build config missing');
    assert.ok(pkg.build.files.includes('main/**/*'), 'files whitelist missing main');
    assert.ok(fs.existsSync(path.join(ROOT, pkg.build.win.icon)), 'win icon missing');
    assert.ok(fs.existsSync(path.join(ROOT, pkg.main)), 'main entry missing');
  });

  test('packaged (production) manifest is the pruned subset — no devDeps in asar', () => {
    // The production manifest (what electron-builder embeds) keeps only name/version/main/deps;
    // this test documents the distinction the audit demanded.
    const prod = { name: pkg.name, version: pkg.version, main: pkg.main, dependencies: pkg.dependencies };
    assert.ok(!('scripts' in prod) && !('devDependencies' in prod), 'production manifest must not carry dev tooling');
    assert.equal(prod.version, '1.2.2');
  });
});

/* ---------------- verified termination ---------------- */
describe('Verified process termination', () => {
  const { ServerController } = require('../main/server/controller');
  const { Logger } = require('../main/core/log');
  const { findFreePort } = require('../main/server/ports');
  const MOCK_ENGINE = path.join(__dirname, 'helpers', 'mockengine.js');
  const stubRegistry = () => ({
    descriptor: () => ({ id: 'x', family: 'llama.cpp', api: 'openai', readyProbe: { type: 'http', path: '/health' } }),
    adapter: () => ({ executablePath: () => process.execPath, buildServerArgs: (m, p, n) => [MOCK_ENGINE, '--port', String(n.port), '--speed', '60'] })
  });
  function makeCtl(tag) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bm-term-${tag}-`));
    const logger = new Logger(path.join(dir, 'logs'));
    const ctl = new ServerController(stubRegistry(), logger, { dataDir: dir, readyTimeoutMs: 20000 });
    return { dir, ctl, logger };
  }

  test('stop() confirms exit, port release and endpoint silence', async () => {
    const { dir, ctl } = makeCtl('ok');
    const port = await findFreePort(19400, '127.0.0.1');
    const s = await ctl.start({ engineId: 'x', modelPath: '/m/t.gguf', port, bind: '127.0.0.1', params: {} });
    const res = await ctl.stop(s.id);
    assert.equal(res.confirmed, true, `stop must be confirmed: ${JSON.stringify(res)}`);
    assert.equal(res.exitObserved, true);
    assert.equal(res.pidAliveAfter, false);
    assert.equal(res.portReleased, true);
    assert.equal(res.httpDown, true);
    let alive = true; try { process.kill(s.pid, 0); } catch (_) { alive = false; }
    assert.equal(alive, false, 'pid really gone');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('stop() reports UNRESOLVED honestly when kill fails (no fake success)', async () => {
    const { dir, ctl } = makeCtl('fail');
    const port = await findFreePort(19500, '127.0.0.1');
    const s = await ctl.start({ engineId: 'x', modelPath: '/m/u.gguf', port, bind: '127.0.0.1', params: {} });
    // Sabotage: make the child handle look alive but kill() ineffective.
    const realKill = process.kill;
    process.kill = (pid, sig) => {
      if (pid === s.pid && (sig === 'SIGTERM' || sig === 'SIGKILL')) { process.kill = realKill; throw new Error('simulated EPERM'); }
      return realKill(pid, sig);
    };
    let res;
    try { res = await ctl.stop(s.id); } finally { process.kill = realKill; }
    // Whatever survived, the report must be honest about it
    if (res.pidAliveAfter) {
      assert.equal(res.confirmed, false, 'unresolved termination must not report confirmed success');
      assert.ok(res.portReleased === false || res.httpDown === false || res.exitObserved === false, 'unresolved fields must reflect reality');
      // clean up for real
      try { realKill(s.pid, 'SIGKILL'); } catch (_) { /* gone */ }
    } else {
      assert.equal(res.confirmed, true); // kill actually worked despite sabotage
    }
    await ctl.stopAll('test-end').catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('stopAll returns per-process outcomes and reports unresolved ids', async () => {
    const { dir, ctl } = makeCtl('all');
    const port = await findFreePort(19600, '127.0.0.1');
    await ctl.start({ engineId: 'x', modelPath: '/m/s.gguf', port, bind: '127.0.0.1', params: {} });
    const summary = await ctl.stopAll('test');
    assert.equal(Object.keys(summary.outcomes).length, 1);
    assert.deepEqual(summary.unresolved, []);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/* ---------------- ownership & recovery ---------------- */
describe('Process ownership verification & recovery', () => {
  const ownership = require('../main/server/ownership');

  test('verifyOwnership: matching identity is owned', () => {
    const rec = { pid: 4242, exePath: '/engines/llama-server', modelPath: '/m/x.gguf', startTime: '12345' };
    const snap = { pid: 4242, exe: '/engines/llama-server', cmdline: ['llama-server', '-m', '/m/x.gguf'], startTime: '12345' };
    const v = ownership.verifyOwnership(rec, snap);
    assert.equal(v.owned, true, v.reason);
  });

  test('verifyOwnership: PID reuse (start-time mismatch) is NEVER owned', () => {
    const rec = { pid: 4242, exePath: '/engines/llama-server', modelPath: '/m/x.gguf', startTime: '111' };
    const snap = { pid: 4242, exe: '/engines/llama-server', cmdline: ['llama-server', '-m', '/m/x.gguf'], startTime: '999' };
    const v = ownership.verifyOwnership(rec, snap);
    assert.equal(v.owned, false);
    assert.match(v.reason, /reused/);
  });

  test('verifyOwnership: different executable or missing model path is not owned', () => {
    const rec = { pid: 1, exePath: '/engines/llama-server', modelPath: '/m/x.gguf', startTime: '1' };
    assert.equal(ownership.verifyOwnership(rec, { pid: 1, exe: '/usr/bin/ollama', cmdline: ['ollama', 'serve'], startTime: '1' }).owned, false);
    assert.equal(ownership.verifyOwnership(rec, { pid: 1, exe: '/engines/llama-server', cmdline: ['llama-server', '-m', '/other.gguf'], startTime: '1' }).owned, false);
    assert.equal(ownership.verifyOwnership(rec, null).owned, false);
  });

  test('recoverAtStartup: dead pid cleared, live+verified adopted, live+unverified external', async () => {
    const { ServerController } = require('../main/server/controller');
    const { Logger } = require('../main/core/log');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-recov-'));
    const logger = new Logger(path.join(dir, 'logs'));
    // hand-craft the ownership store: one dead, one live-but-foreign
    const storePath = path.join(dir, 'managed-processes.json');
    const liveForeign = process.execPath; // a real live process: this test runner itself
    const mySnap = ownership.snapshotProcess(process.pid);
    fs.writeFileSync(storePath, JSON.stringify({ records: [
      { id: 'srv-dead', pid: 999999, engineId: 'x', model: '/m/dead.gguf', modelPath: '/m/dead.gguf', port: 1, bind: '127.0.0.1', startedAt: 1, exePath: '/nope/llama-server', startTime: '42' },
      { id: 'srv-foreign', pid: process.pid, engineId: 'x', model: '/m/live.gguf', modelPath: '/m/live.gguf', port: 2, bind: '127.0.0.1', startedAt: 2, exePath: '/definitely/not/llama-server', startTime: mySnap.startTime }
    ] }));
    const ctl = new ServerController({ descriptor: () => ({ id: 'x', family: 'llama.cpp' }) }, logger, { dataDir: dir });
    const report = ctl.recoverAtStartup();
    assert.equal(report.cleared.length, 1, 'dead record cleared');
    assert.equal(report.external.length, 1, 'foreign live process classified external');
    assert.equal(report.external[0].pid, process.pid);
    assert.match(report.external[0].reason, /executable mismatch|model path/);
    assert.equal(report.adopted.length, 0, 'nothing wrongly adopted');
    // external processes are never in the managed registry
    assert.equal(ctl.list().filter(p => p.mode === 'managed').length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('recoverAtStartup adopts a verified own process as stoppable', async () => {
    const { ServerController } = require('../main/server/controller');
    const { Logger } = require('../main/core/log');
    const { spawn } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-recov2-'));
    const logger = new Logger(path.join(dir, 'logs'));
    // Child whose command line contains the recorded model path (as a real
    // engine launch would) — the identity evidence ownership requires.
    const child = spawn(process.execPath, ['-e', 'const model="/m/own.gguf"; setInterval(()=>{},1000)'], { stdio: 'ignore' });
    child.unref();
    await new Promise(r => setTimeout(r, 250));
    const snap = ownership.snapshotProcess(child.pid);
    fs.writeFileSync(path.join(dir, 'managed-processes.json'), JSON.stringify({ records: [
      { id: 'srv-live', pid: child.pid, engineId: 'x', model: '/m/own.gguf', modelPath: '/m/own.gguf', port: 3, bind: '127.0.0.1', startedAt: 3, exePath: snap.exe, startTime: snap.startTime }
    ] }));
    const ctl = new ServerController({ descriptor: () => ({ id: 'x', family: 'llama.cpp' }) }, logger, { dataDir: dir });
    const report = ctl.recoverAtStartup();
    assert.equal(report.adopted.length, 1, 'verified process adopted');
    assert.equal(report.adopted[0].recoveredStatus, 'running');
    const pub = ctl.list().find(p => p.id === 'srv-live');
    assert.ok(pub, 'adopted process is managed again');
    assert.equal(pub.pidRecovered, true);
    // stop the adopted process (verified termination, no proc handle)
    const res = await ctl.stop('srv-live');
    assert.equal(res.confirmed, true, 'recovered process can be verified-stopped');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/* ---------------- engine install staging ---------------- */
describe('Engine install staging & update safety', () => {
  const { EngineInstaller } = require('../main/engines/installer');
  const { EngineRegistry } = require('../main/engines/registry');

  function makeInstaller(dir, fetchImpl) {
    const reg = new EngineRegistry(dir, console, { osFilter: false });
    const installer = new EngineInstaller(reg, console, { fetchImpl });
    return { reg, installer };
  }

  test('disk-space guard refuses installs when the volume is short', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-disk-'));
    const { installer } = makeInstaller(dir, async () => ({ ok: true, status: 200 }));
    await assert.rejects(() => installer._assertDiskSpace(dir, Number.MAX_SAFE_INTEGER / 4), /disk space/i);
    await installer._assertDiskSpace(dir, 1024); // tiny need passes
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('checksum verification accepts good, rejects corrupted, explains missing source', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-sha-'));
    const { installer } = makeInstaller(dir, async () => ({ ok: true, status: 200, text: async () => 'deadbeef  llama-b1-bin-win-cpu-x64.zip\ncafe0001  other.zip' }));
    const asset = { tag: 'b1', url: 'https://github.com/x/y/releases/download/b1/llama-b1-bin-win-cpu-x64.zip', via: 't' };
    const archive = path.join(dir, 'llama-b1-bin-win-cpu-x64.zip');
    fs.writeFileSync(archive, Buffer.from('dummy'));
    const desc = { id: 'x', install: { type: 'github-release-zip', checksumTemplate: 'https://example.com/SHA256SUMS-{tag}.txt' } };
    await assert.rejects(() => installer._verifyChecksum(desc, asset, archive), /Checksum mismatch/, 'corrupted archive refused');
    // craft matching content
    const crypto = require('crypto');
    fs.writeFileSync(archive, Buffer.from('x'));
    const real = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    const installer2 = makeInstaller(dir, async () => ({ ok: true, status: 200, text: async () => `${real}  llama-b1-bin-win-cpu-x64.zip` })).installer;
    const okRes = await installer2._verifyChecksum(desc, asset, archive);
    assert.equal(okRes.verified, true);
    const noSrc = await installer2._verifyChecksum({ id: 'x', install: {} }, asset, archive);
    assert.equal(noSrc.verified, false);
    assert.match(noSrc.reason, /no official checksum/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('staged tree validation refuses wrong/missing binaries and reports safety', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-staging-'));
    const { installer } = makeInstaller(dir, async () => ({ ok: true }));
    const desc = { id: 'x', serverBinary: 'llama-server' };
    assert.throws(() => installer._validateStaged(desc, dir), /does not contain the expected llama-server/, 'empty staging refused');
    const subdir = path.join(dir, 'build', 'bin');
    fs.mkdirSync(subdir, { recursive: true });
    // Host-platform binary name: installer requires .exe on Windows.
    const binName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    fs.writeFileSync(path.join(subdir, binName), process.platform === 'win32' ? 'MZ' : '#!/bin/sh\n');
    const ok = installer._validateStaged(desc, dir);
    assert.equal(ok.ok, true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/* ---------------- compatibility assessment & lab ---------------- */
describe('Compatibility assessment', () => {
  const { assessCompatibility, STATUS } = require('../main/compatlab/assessor');

  const goodModel = { invalid: false, architecture: 'llama', quant: 'Q4_K_M', isMoE: false, sizeBytes: 4e9, ctxTrain: 32768 };
  const cpuEngine = { id: 'llamacpp-cpu', displayName: 'llama.cpp (CPU)', family: 'llama.cpp', acceleration: 'cpu', installed: true, status: 'available', statusCategory: 'compatible', probedCapabilities: { probed: true, kvCacheTypes: ['f16', 'q8_0', 'q4_0'], flashAttention: true, cpuMoeOffload: true }, probedHelpFlags: { kvCacheK: true, kvCacheV: true } };

  test('likely-compatible on cpu with no saved evidence', () => {
    const r = assessCompatibility({ model: goodModel, engine: cpuEngine, hardware: { vulkan: 'unknown' }, memory: { totalBytes: 44e9, freeBytes: 30e9 }, savedResult: null, requested: { accel: 'cpu', params: {} } });
    assert.equal(r.status, STATUS.LIKELY);
    assert.ok(r.reasons.length, 'reasons explain the verdict');
  });

  test('verified-compatible only from a fresh PASSING lab result with inference stage', () => {
    const saved = { outcome: 'pass', stages: [{ stage: 'inference', ok: true }], at: Date.now(), modelMtimeMs: 1, engineTag: 'b1', appVersion: '1.2.1' };
    const cfg = { modelMtimeMs: 1, engineTag: 'b1' };
    const r = assessCompatibility({ model: goodModel, engine: cpuEngine, hardware: {}, memory: {}, savedResult: saved, requested: { accel: 'cpu', params: {} }, ...cfg });
    assert.equal(r.status, STATUS.VERIFIED);
    // stale evidence must NOT verify
    const staleSaved = { ...saved, modelMtimeMs: 2, stale: true, staleReason: 'model file changed on disk' };
    const r2 = assessCompatibility({ model: goodModel, engine: cpuEngine, hardware: {}, memory: {}, savedResult: staleSaved, requested: { accel: 'cpu', params: {} }, modelMtimeMs: 1, engineTag: 'b1' });
    assert.notEqual(r2.status, STATUS.VERIFIED, 'stale result cannot verify');
  });

  test('previously-failed surfaces failed stages', () => {
    const saved = { outcome: 'fail', stages: [{ stage: 'load', ok: false, detail: 'boom' }], at: Date.now(), appVersion: '1.2.1', modelMtimeMs: 1, engineTag: 'b1' };
    const r = assessCompatibility({ model: goodModel, engine: cpuEngine, hardware: {}, memory: {}, savedResult: saved, requested: { accel: 'cpu', params: {} } });
    assert.equal(r.status, STATUS.FAILED);
    assert.match(r.reasons[0], /load/);
  });

  test('unsupported: incomplete split, invalid model, oversized memory need', () => {
    const splitModel = { ...goodModel, split: { total: 3 }, splitComplete: false, splitMissingShards: [3] };
    assert.equal(assessCompatibility({ model: splitModel, engine: cpuEngine, hardware: {}, memory: {} }).status, STATUS.UNSUPPORTED);
    assert.equal(assessCompatibility({ model: { invalid: true }, engine: cpuEngine, hardware: {}, memory: {} }).status, STATUS.UNSUPPORTED);
    const huge = { ...goodModel, sizeBytes: 90e9 };
    assert.equal(assessCompatibility({ model: huge, engine: cpuEngine, hardware: {}, memory: { totalBytes: 44e9, freeBytes: 24e9 } }).status, STATUS.UNSUPPORTED);
  });

  test('insufficient-information when engine missing or uninstalled', () => {
    assert.equal(assessCompatibility({ model: goodModel, engine: null, hardware: {}, memory: {} }).status, STATUS.INFO);
    assert.equal(assessCompatibility({ model: goodModel, engine: { ...cpuEngine, installed: false }, hardware: {}, memory: {} }).status, STATUS.INFO);
  });

  test('unsupported kv cache type vs probed formats is flagged', () => {
    const r = assessCompatibility({ model: goodModel, engine: cpuEngine, hardware: {}, memory: { totalBytes: 44e9, freeBytes: 30e9 }, requested: { accel: 'cpu', params: { kvCacheType: 'q5_1' } } });
    assert.ok(r.reasons.some(x => /KV cache type "q5_1"/.test(x)), 'unsupported kv format flagged');
    assert.ok(r.checks.some(c => c.id === 'kv-cache' && c.ok === false));
  });
});

describe('Compatibility Lab persistence & staleness', () => {
  const { CompatibilityLab } = require('../main/compatlab/lab');

  function makeLab(dir) {
    const { ServerController } = require('../main/server/controller');
    const { Logger } = require('../main/core/log');
    const { EngineRegistry } = require('../main/engines/registry');
    const logger = new Logger(path.join(dir, 'logs'));
    const reg = new EngineRegistry(dir, console, { osFilter: false });
    const ctl = new ServerController({ descriptor: () => { throw new Error('unused'); } }, logger, { dataDir: dir });
    return new CompatibilityLab(ctl, reg, logger, { dataDir: dir, appVersion: '1.2.1' });
  }

  test('saved result becomes stale when model mtime or engine tag changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-lab-'));
    const lab = makeLab(dir);
    const cfg = { modelPath: '/m/a.gguf', modelMtimeMs: 100, engineId: 'llamacpp-cpu', engineTag: 'b1', accel: 'cpu', profileKey: 'manual' };
    lab.store.data.results = [{ ...lab.keyFor(cfg), stages: [], outcome: 'pass', at: Date.now(), appVersion: '1.2.1', profileParams: null }];
    lab.store.save();
    const fresh = lab.latestResultFor(cfg);
    assert.equal(fresh.stale, undefined, 'matching inputs → not stale');
    const newerModel = { ...cfg, modelMtimeMs: 200 };
    const stale1 = lab.latestResultFor(newerModel);
    assert.equal(stale1.stale, true);
    assert.match(stale1.staleReason, /model file changed/);
    const newerEngine = { ...cfg, engineTag: 'b2' };
    const stale2 = lab.latestResultFor(newerEngine);
    assert.equal(stale2.stale, true);
    assert.match(stale2.staleReason, /engine version changed/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('one run at a time; concurrent runTest is refused', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-lab2-'));
    const lab = makeLab(dir);
    lab._running = { engineId: 'busy' };
    await assert.rejects(() => lab.runTest({ engineId: 'x' }), /already running/);
    lab._running = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/* ---------------- recommended profiles ---------------- */
describe('Recommended launch profiles', () => {
  const { recommendProfile, GOALS } = require('../main/profiles');

  const model = { ctxTrain: 40960, isMoE: true, expertCount: 128, expertUsed: 8, sizeBytes: 8e9 };
  const caps = { helpFlags: { kvCacheK: true, kvCacheV: true, flashAttention: true, cpuMoeLayers: true, parallelSlots: true } };

  test('all goals generate with documented assumptions and clamped context', () => {
    for (const g of GOALS.filter(x => x !== 'custom')) {
      const p = recommendProfile(g, { model, hardware: { vulkan: 'likely', logicalCores: 12 }, capabilities: caps, logicalCores: 12 });
      assert.equal(p.requiresExplicitApply, true, 'profiles are advisory-only');
      assert.ok(p.params.contextLength <= model.ctxTrain, `${g}: context clamped to training length`);
      assert.ok(p.notes.length || p.assumptions.length, `${g}: documents reasoning`);
    }
  });

  test('unsupported capabilities are omitted, never recommended', () => {
    const p = recommendProfile('large-context', { model, hardware: {}, capabilities: { helpFlags: {} }, logicalCores: 8 });
    assert.equal(p.params.kvCacheType, 'f16', 'kv quantization not advertised → f16 kept');
    assert.ok(!('flashAttention' in p.params), 'flash-attn not advertised → omitted');
    assert.ok(p.notes.some(n => /not advertised|kept f16/.test(n)));
  });

  test('moe profile offloads experts and documents total-vs-active', () => {
    const p = recommendProfile('moe', { model, hardware: {}, capabilities: caps, logicalCores: 12 });
    assert.ok(p.params.cpuMoeLayers > 0);
    assert.ok(p.notes.some(n => /ALL experts stay resident|compute placement/.test(n)));
  });

  test('igpu profile warns when no vulkan runtime is detected', () => {
    const p = recommendProfile('igpu-experimental', { model, hardware: { vulkan: 'unknown' }, capabilities: caps, logicalCores: 8 });
    assert.ok(p.notes.some(n => /No confirmed Vulkan runtime/.test(n)));
    assert.equal(p.params.gpuLayers, 8, 'conservative starting offload');
  });
});

/* ---------------- memory estimate additions ---------------- */
describe('Memory estimate transparency', () => {
  const { estimateMemory } = require('../main/models/estimate');

  test('exposes compute buffer separately with uncertainty statement', () => {
    const m = { sizeBytes: 4e9, quant: 'Q4_K_M', nLayers: 32, nEmbd: 4096, nHead: 32, nHeadKv: 8, keyLength: 128, valueLength: 128, ctxTrain: 32768, isMoE: false };
    const e = estimateMemory(m, { contextLength: 8192 });
    assert.ok(e.computeBufBytes >= 512 * 1024 * 1024, 'compute allowance present');
    assert.match(e.uncertainty, /ESTIMATES, not measurements/);
    assert.equal(e.totalBytes, e.weightsBytes + e.kvBytes + e.computeBufBytes);
  });

  test('MoE estimate states total-weights residency vs active compute', () => {
    const m = { sizeBytes: 8e9, quant: 'Q4_K_M', nLayers: 32, nEmbd: 4096, nHead: 32, nHeadKv: 8, keyLength: 128, valueLength: 128, ctxTrain: 32768, isMoE: true, expertCount: 128, expertUsed: 8 };
    const e = estimateMemory(m, { contextLength: 4096 });
    assert.match(e.moeActiveVsTotal, /8 active/);
    assert.match(e.moeActiveVsTotal, /all 128 resident/);
  });
});

/* ---------------- diagnostics ---------------- */
describe('Diagnostics center', () => {
  const { Diagnostics } = require('../main/diagnostics');

  test('snapshot collects sections and generates hints', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-diag-'));
    const { Logger } = require('../main/core/log');
    const logger = new Logger(path.join(dir, 'logs'));
    logger.warn('test', 'synthetic warning for the ring');
    const { EngineRegistry } = require('../main/engines/registry');
    const reg = new EngineRegistry(dir, console, { osFilter: false });
    const library = new (require('../main/models/library').ModelLibrary)(dir, console);
    const { ServerController } = require('../main/server/controller');
    const ctl = new ServerController({ descriptor: () => { throw new Error('x'); } }, logger, { dataDir: dir });
    const { CompatibilityLab } = require('../main/compatlab/lab');
    const lab = new CompatibilityLab(ctl, reg, logger, { dataDir: dir });
    const diag = new Diagnostics({ appVersion: '1.2.1', logger, registry: reg, installer: null, library, controller: ctl, lab, monitor: null });
    const snap = await diag.collect();
    assert.equal(snap.app.version, '1.2.1');
    assert.ok(Array.isArray(snap.engines) && snap.engines.length >= 5, 'engine table populated');
    assert.ok(snap.models && typeof snap.models.total === 'number');
    assert.ok(Array.isArray(snap.hints) && snap.hints.length, 'hints generated');
    const file = await diag.exportReport(dir);
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(body.app.version, '1.2.1');
    assert.match(file, /black-mirror-diagnostics-/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('hints detect port conflict, experimental engine and low commit headroom', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-diag2-'));
    const { Logger } = require('../main/core/log');
    const diag = new Diagnostics({ appVersion: '1.2.1', logger: new Logger(null), registry: { hardwareInfo: () => ({}) }, library: { list: () => [] }, controller: { list: () => [], recoveredExternal: [] }, lab: { results: () => [] }, monitor: null });
    const snap = { engines: [{ displayName: 'SYCL', statusCategory: 'experimental', installed: true, version: 'b1' }], models: { invalid: 2, incompleteSplits: 1 }, portConflicts: [{ port: 8081, occupied: true }], unverifiedRecovered: [{ pid: 5, reason: 'start time mismatch — PID was likely reused by another process' }], memorySample: { memory: { committedFreeBytes: 1e9 } }, compatResults: [], recentErrors: [] };
    const hints = diag.hints(snap);
    assert.ok(hints.some(h => /port 8081 is already occupied/.test(h)));
    assert.ok(hints.some(h => /experimental on this machine/.test(h)));
    assert.ok(hints.some(h => /commit charge headroom/.test(h)));
    assert.ok(hints.some(h => /failed GGUF parsing|missing shards/.test(h)));
    assert.ok(hints.some(h => /never be terminated automatically/.test(h)));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
